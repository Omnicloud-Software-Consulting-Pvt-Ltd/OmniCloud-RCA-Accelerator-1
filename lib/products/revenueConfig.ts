/**
 * PRODUCT REVENUE CLOUD CONFIGURATION — shared (client + server) model and the deterministic prompt parser.
 *
 * Salesforce stores only two of these on Product2 itself:
 *   Tax Policy      → Product2.TaxPolicyId
 *   Billing Policy  → Product2.BillingPolicyId
 * Everything else is a RELATED record, resolved through the policy (never a Product2 field):
 *   Tax Treatment        → TaxPolicy.DefaultTaxTreatmentId (Default selection) / TaxTreatment.TaxPolicyId
 *   Tax Treatment Item   → TaxTreatmentItem (TaxTreatmentId + ProductId — product-specific)
 *   Tax Engine           → TaxTreatment.TaxEngineId
 *   Tax Code / Taxable   → TaxTreatmentItem.TaxCode (treatment uses items) else TaxTreatment.TaxCode · TaxTreatment.IsTaxable
 *   Billing Treatment    → BillingPolicy.DefaultBillingTreatmentId / BillingTreatment.BillingPolicyId
 *   Billing Treatment Item → BillingTreatmentItem.BillingTreatmentId
 *
 * The parser extracts every relationship a prompt names ("Assign the India Tax Policy and Tax Treatment", "Billing Policy =
 * X", "Tax Policy: Y") so nothing requested silently disappears; names are resolved to real records server-side.
 */

export type RelationKey = "taxPolicy" | "taxTreatment" | "taxTreatmentItem" | "taxEngine" | "billingPolicy" | "billingTreatment" | "billingTreatmentItem";
export const RELATION_KEYS: RelationKey[] = ["taxPolicy", "taxTreatment", "taxTreatmentItem", "taxEngine", "billingPolicy", "billingTreatment", "billingTreatmentItem"];

export const RELATION_META: Record<RelationKey, { label: string; object: string; storage: string; direct: boolean; keyword: string; nameField: string }> = {
  taxPolicy: { label: "Tax Policy", object: "TaxPolicy", storage: "Product2.TaxPolicyId", direct: true, keyword: "tax policy", nameField: "Name" },
  taxTreatment: { label: "Tax Treatment", object: "TaxTreatment", storage: "related: TaxPolicy.DefaultTaxTreatmentId / TaxTreatment.TaxPolicyId", direct: false, keyword: "tax treatment", nameField: "Name" },
  taxTreatmentItem: { label: "Tax Treatment Item", object: "TaxTreatmentItem", storage: "related: TaxTreatmentItem (TaxTreatmentId + ProductId)", direct: false, keyword: "tax treatment item", nameField: "Name" },
  taxEngine: { label: "Tax Engine", object: "TaxEngine", storage: "related: TaxTreatment.TaxEngineId", direct: false, keyword: "tax engine", nameField: "TaxEngineName" },
  billingPolicy: { label: "Billing Policy", object: "BillingPolicy", storage: "Product2.BillingPolicyId", direct: true, keyword: "billing policy", nameField: "Name" },
  billingTreatment: { label: "Billing Treatment", object: "BillingTreatment", storage: "related: BillingPolicy.DefaultBillingTreatmentId / BillingTreatment.BillingPolicyId", direct: false, keyword: "billing treatment", nameField: "Name" },
  billingTreatmentItem: { label: "Billing Treatment Item", object: "BillingTreatmentItem", storage: "related: BillingTreatmentItem.BillingTreatmentId", direct: false, keyword: "billing treatment item", nameField: "Name" },
};

/** Relationship names requested for a product (null = not requested). */
export type RelationRequest = Partial<Record<RelationKey, string | null>>;

export interface ParsedRevenueConfig {
  relations: RelationRequest;
  taxCode: string | null;
  priceBook: string | null;
  /** Configuration the prompt mentions without a value we could extract (reported, never dropped silently). */
  unnamed: string[];
}

// Longest keywords first so "tax treatment item" never matches as "tax treatment".
const ORDERED: RelationKey[] = ["taxTreatmentItem", "billingTreatmentItem", "taxTreatment", "billingTreatment", "taxPolicy", "billingPolicy", "taxEngine"];
const KEYWORD_RE = new RegExp(`\\b(${ORDERED.map(k => RELATION_META[k].keyword.replace(/ /g, "\\s+")).join("|")})\\b`, "gi");
const keyOf = (kw: string): RelationKey => ORDERED.find(k => new RegExp(`^${RELATION_META[k].keyword.replace(/ /g, "\\s+")}$`, "i").test(kw))!;
const VERB = /\b(?:assign|assigning|use|using|apply|applying|attach|link|set|with|add|to|under|on)\b/gi;
const clean = (s: string) => s.replace(/^[\s=:,"'“”‘’-]+|[\s"'“”‘’,]+$/g, "").replace(/^(?:named|called|is|as)\s+/i, "").replace(/\s+/g, " ").trim();
const stripLead = (s: string) => s.replace(/^\s*(?:and|also|then|please|plus)\b\s*/i, "").replace(/^\s*(?:the|a|an|its|this|that)\b\s*/i, "").trim();

/** Split into clauses on sentence ends, semicolons, new lines and commas (a period inside a code/decimal is kept). */
function clauses(p: string): string[] {
  return p.split(/(?:\.(?=\s|$))|[;\n]|,/).map(s => s.trim()).filter(Boolean);
}

export function parseRevenueConfigPrompt(prompt: string): ParsedRevenueConfig {
  const relations: RelationRequest = {};
  const unnamed: string[] = [];
  for (const clause of clauses(prompt)) {
    const occ = [...clause.matchAll(KEYWORD_RE)].map(m => ({ key: keyOf(m[1]), start: m.index!, end: m.index! + m[0].length, text: m[0] }));
    let qualifier: string | null = null;
    for (let i = 0; i < occ.length; i++) {
      const o = occ[i], next = occ[i + 1];
      const label = RELATION_META[o.key].label;
      const afterRaw = clause.slice(o.end, next ? next.start : clause.length);
      const after = clean(stripLead(afterRaw.replace(/^\s*(?:=|:)/, "")));
      // "Billing Policy OmniCloud Prompt E2E Billing Policy" — the name runs into the next occurrence of the same keyword.
      if (next && next.key === o.key && after) { relations[o.key] ??= `${after} ${label}`; i++; continue; }
      const explicitAfter = /^\s*(?:=|:|named|called)/i.test(afterRaw) || (!!after && !next && !/^and\b/i.test(after));
      if (explicitAfter && after) { relations[o.key] ??= clean(after); continue; }
      // Name before the keyword: text after the last verb in the segment ("…and assign the OmniCloud India" → "OmniCloud India").
      const segment = clause.slice(i ? occ[i - 1].end : 0, o.start);
      const lastVerb = [...segment.matchAll(VERB)].pop();
      const before = clean(stripLead(lastVerb ? segment.slice(lastVerb.index! + lastVerb[0].length) : segment));
      if (before && !/^(and|or)$/i.test(before)) { qualifier = before; relations[o.key] ??= `${before} ${label}`; continue; }
      if (qualifier) { relations[o.key] ??= `${qualifier} ${label}`; continue; }
      unnamed.push(label);
    }
  }
  const taxCode = /\btax\s*code\s*(?:=|:|is)?\s*([A-Za-z0-9_\-]{2,80})/i.exec(prompt)?.[1] ?? null;
  const pbAfter = /\bprice\s*book\s*(?:=|:|named|called)\s*["'“]?([^"'”.,;\n]+)/i.exec(prompt)?.[1];
  const pbBefore = /\b(?:the\s+)?([A-Z][\w&'\-]*(?:\s+[A-Z][\w&'\-]*){0,4}?)\s+[Pp]rice\s*[Bb]ook\b/.exec(prompt)?.[1];
  const priceBook = pbAfter ? clean(pbAfter) : pbBefore && !/^(The|A|An|In|Use|With|To|On)$/i.test(pbBefore) ? `${clean(pbBefore.replace(/^(?:in|use|with|to|on)\s+(?:the\s+)?/i, ""))} Price Book` : null;
  return { relations, taxCode, priceBook, unnamed: [...new Set(unnamed)] };
}

/** Configuration areas a prompt mentions — used to report anything mentioned but not extracted. */
export function mentionedConfiguration(prompt: string): string[] {
  const p = prompt.toLowerCase();
  const out: string[] = [];
  const has = (re: RegExp, label: string) => { if (re.test(p)) out.push(label); };
  has(/\bcatalog\b/, "Catalog");
  has(/\bcategor(y|ies)\b/, "Category");
  has(/\bselling model\b|\bone[- ]time\b|\bevergreen\b|\bterm[- ]based\b|\bsubscription\b/, "Product Selling Model");
  has(/\bunit of measure\b|\buom\b|\bper (unit|user|seat|license|hour|gb)\b|(^|[,.;]\s*)each\s*([,.;]|$)/, "Unit of Measure");
  has(/\bprice\s*book\b/, "Pricebook");
  has(/\bprice\b|\bpriced\b|[₹$€£]\s?\d/, "Unit Price");
  for (const k of RELATION_KEYS) if (new RegExp(`\\b${RELATION_META[k].keyword.replace(/ /g, "\\s+")}\\b`).test(p)) out.push(RELATION_META[k].label);
  if (/\btax\s*code\b/.test(p)) out.push("Tax Code");
  return [...new Set(out)];
}

/* ───────────── Configuration view model (returned by the server, rendered by the UI) ───────────── */

export interface RecordRef { id: string; name: string; status?: string | null }
export interface ConfigValue<T = string> { value: T | null; source: string; direct: boolean; record?: RecordRef | null; note?: string | null }

export interface ProductConfiguration {
  product: { id: string; name: string; code: string | null; family: string | null; description: string | null; isActive: boolean; unitOfMeasure: ConfigValue };
  revenue: {
    sellingModels: (RecordRef & { type: string | null })[];
    catalogs: RecordRef[];
    categories: (RecordRef & { catalog: string | null })[];
    pricebookEntries: { id: string; pricebook: RecordRef & { isStandard: boolean }; unitPrice: number | null; isActive: boolean; sellingModel: string | null }[];
  };
  tax: {
    policy: ConfigValue & { selection?: string | null };
    treatment: ConfigValue & { taxable?: boolean | null; usesItems?: boolean | null; engineId?: string | null };
    treatmentItem: ConfigValue;
    engine: ConfigValue & { type?: string | null; decisionTableId?: string | null };
    taxCode: ConfigValue;
    taxable: ConfigValue<boolean>;
  };
  billing: {
    policy: ConfigValue & { selection?: string | null };
    treatment: ConfigValue;
    treatmentItems: (RecordRef & { billingType?: string | null; type?: string | null })[];
  };
  readiness: { ready: boolean; checks: { id: string; label: string; passed: boolean; detail: string }[]; missing: string[] };
}

export type RelationStatus = "resolved" | "not_found" | "ambiguous" | "invalid" | "mismatch" | "derived";
export interface RelationResolution {
  key: RelationKey; label: string; object: string; storage: string; direct: boolean;
  requested: string;
  status: RelationStatus;
  matchedBy: "id" | "exact" | "partial" | "derived" | null;
  record: (RecordRef & Record<string, unknown>) | null;
  candidates: RecordRef[];
  message: string;
  /** A pending dependency, not a blocker (e.g. a Tax Treatment Item, which can only exist once the product exists). */
  dependency?: boolean;
}
export interface RevenueConfigResolution {
  resolutions: RelationResolution[];
  /** Product2 fields this configuration writes (only TaxPolicyId / BillingPolicyId). */
  product2: { TaxPolicyId?: string; BillingPolicyId?: string };
  blockers: string[];
  warnings: string[];
}

export const isBlocking = (s: RelationStatus) => s === "not_found" || s === "ambiguous" || s === "invalid" || s === "mismatch";

/* ───────────── Merge the AI extraction with the deterministic parser; report anything not applied ───────────── */

export type PromptConfigKey = RelationKey | "taxCode" | "priceBook" | "unitOfMeasure" | "catalog" | "category" | "sellingModel" | "basePrice";
const AREA_KEY: Record<string, PromptConfigKey> = {
  "Catalog": "catalog", "Category": "category", "Product Selling Model": "sellingModel", "Unit of Measure": "unitOfMeasure",
  "Pricebook": "priceBook", "Unit Price": "basePrice", "Tax Code": "taxCode",
  ...Object.fromEntries(RELATION_KEYS.map(k => [RELATION_META[k].label, k])),
};

/**
 * AI values win; the deterministic parser fills tax/billing relationships, tax code and price book the AI left empty. Every
 * configuration area the prompt mentions but that ended up without a value — and anything the AI flagged as unsupported — is
 * returned as a note, so nothing requested silently disappears.
 */
export function mergePromptConfiguration(prompt: string, ai: Partial<Record<PromptConfigKey, string | null | undefined>>, aiUnsupported: unknown): { values: Partial<Record<PromptConfigKey, string | null>>; notes: string[] } {
  const det = parseRevenueConfigPrompt(prompt);
  const values: Partial<Record<PromptConfigKey, string | null>> = {};
  const v = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
  for (const k of Object.keys(ai) as PromptConfigKey[]) values[k] = v(ai[k]);
  for (const k of RELATION_KEYS) values[k] = v(ai[k]) ?? det.relations[k] ?? null;
  values.taxCode = v(ai.taxCode) ?? det.taxCode;
  values.priceBook = v(ai.priceBook) ?? det.priceBook;
  const notes: string[] = [];
  for (const u of det.unnamed) notes.push(`${u} was mentioned without a name — say which ${u} to assign; nothing was assigned.`);
  for (const area of mentionedConfiguration(prompt)) {
    const key = AREA_KEY[area];
    if (key && !values[key] && !det.unnamed.includes(area)) notes.push(`${area} was mentioned, but no value could be extracted — it was not applied. Name it explicitly (e.g. "${area} <name>").`);
  }
  if (Array.isArray(aiUnsupported)) for (const u of aiUnsupported) if (typeof u === "string" && u.trim()) notes.push(`Not a supported product configuration: "${u.trim()}" — it was not applied.`);
  return { values, notes: [...new Set(notes)] };
}
