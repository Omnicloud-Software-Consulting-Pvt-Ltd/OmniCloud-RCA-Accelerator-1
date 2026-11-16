import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata, objectMeta } from "@/lib/tax/server/metadata";
import { loadSnapshot, str, type TaxSnapshot } from "@/lib/tax/server/records";
import { readStandardTax } from "@/lib/tax/server/engine";
import { getTaxAdminStatus } from "@/lib/tax/server/admin";
import { resolveTaxRate, type RRRate } from "@/lib/tax/server/resolution";
import { REVENUE_CLOUD_RATE_USAGE } from "@/lib/tax/server/rateRules";
import type { AssistantOperation } from "@/lib/tax/types";
import { planVersion, rankDiagnostics, type ProposedRecord, type RemediationStep, type ResolutionInput, type ResolutionKind, type ResolutionOption, type TaxDiagnosticItem } from "@/lib/tax/server/remediation";

/**
 * TAX CALCULATION PLAN — what a "calculate tax for <product>" request needs before Salesforce can tax a real invoice, read from the
 * connected org and expressed as separately approvable steps that REUSE what exists:
 *
 *   existing records to reuse · records to create · Draft records to update · activations · the decision-table refresh ·
 *   the billing transaction (order → activation → billing schedule → Draft invoice → InvoiceLineTax) · the expected (reference)
 *   tax · possible duplicates · blockers · questions for details that must not be invented (jurisdiction, rate, tax code, basis,
 *   customer account, which treatment/engine when several fit).
 *
 * Pure (`buildCalculationPlan`) over facts read once (`loadCalculationPlan`, SOQL only). Nothing here writes: every configuration
 * step is an Assistant operation the user previews and approves on its own (/api/taxes/assistant/preview → execute), the refresh
 * is its own approval (/api/taxes/decision-table/refresh) and the billing steps are confirmed one by one by the calculation service.
 * Verified org rules it follows: OrderItem.TaxTreatmentId comes from the policy's DEFAULT treatment (Manual selection isn't stamped);
 * a taxable treatment needs a Legal Entity (DOC-16 vs DOC-17) which is locked once it leaves Draft; the rate's ProductCode is
 * matched against Product2.ProductCode (E1-B/E1c); RevCloud rates only; treatments are activated before their policy.
 */

export type PlanQuestionField = "product" | "country" | "state" | "taxCode" | "rate" | "basis" | "account" | "treatment" | "engine" | "legalEntity" | "policy";
export interface PlanQuestion { field: PlanQuestionField; question: string; options?: { value: string; label: string }[] }
export interface PlanRecord { object: string; id: string; name: string; detail: string }
export interface PlanAction {
  id: string;
  group: "create" | "update" | "activate" | "refresh";
  title: string; detail: string;
  object: string; recordId: string | null;
  /** The Tax Assistant operation that performs it (previewed and approved on its own). null for the refresh (its own route). */
  operation: AssistantOperation | null;
  /** The refresh step: the engine whose decision table is refreshed. */
  refresh?: { engineId: string; decisionTableId: string | null } | null;
  dependsOn: string[];
}
export interface CalculationPlan {
  status: "READY_TO_CALCULATE" | "NEEDS_INPUT" | "NEEDS_CONFIGURATION" | "BLOCKED";
  summary: string;
  product: { id: string; name: string; code: string | null } | null;
  jurisdiction: { countryIso: string | null; countryName: string | null; stateIso: string | null; stateName: string | null };
  reuse: PlanRecord[];
  actions: PlanAction[];
  transaction: { step: string; label: string; detail: string }[];
  expected: { rate: number; taxCode: string | null; taxableAmount: number | null; taxAmount: number | null; basis: string | null; note: string } | null;
  duplicates: string[];
  notes: string[];
  questions: PlanQuestion[];
  blocked: string[];
  /** Structured, ranked diagnostics with their resolution options (the source of the Calculation page's resolution cards). */
  diagnostics: TaxDiagnosticItem[];
  /** Digest of the diagnostics and their steps — approvals are bound to it. */
  version: string;
}

export interface PlanRequest {
  country?: string | null; state?: string | null;
  taxCode?: string | null; rate?: number | null; basis?: string | null;
  account?: { id: string; name: string; country: string | null; state: string | null } | null;
  /** The user named an account that doesn't exist. */
  accountNotFound?: string | null;
  quantity?: number | null; unitPrice?: number | null;
  effectiveDate?: string | null;
  /** The treatment / engine / legal entity the user chose when several fit. */
  treatmentId?: string | null; engineId?: string | null; legalEntityId?: string | null;
  /** The product selling model to price when several are offered. */
  sellingModelId?: string | null;
}
export interface PlanFacts {
  product: { id: string; name: string; code: string | null; active: boolean; taxPolicyId: string | null } | null;
  productMessage: string | null;
  /** Several products match the name/code: the user picks one (never guessed). */
  productCandidates?: { id: string; name: string; code: string | null }[];
  snapshot: Pick<TaxSnapshot, "policies" | "treatments" | "items" | "engines" | "rates" | "legalEntities" | "geoCountries">;
  geoStates: { id: string; name: string; iso: string; countryIso: string | null }[];
  /** Decision tables by Id (as TaxEngine.DecisionTableId holds them): inputs and freshness. */
  tables: Record<string, { id: string; name: string; inputs: string[]; stale: boolean }>;
  /** Accounts with a billing address in the requested country (candidates when no account was named). */
  accounts: { id: string; name: string; country: string | null; state: string | null }[];
  listPrice: number | null;
  /** Billing prerequisites of the product (null = not read in this context; `unreadable` = the read failed — reported, never "none"). */
  billing?: {
    unreadable?: string | null;
    productBillingPolicyId: string | null;
    billingPolicies: { id: string; name: string; status: string | null }[];
    standardPricebookId: string | null;
    priceEntries: { id: string; unitPrice: number | null; active: boolean; standard: boolean; sellingModelId: string | null; sellingModelName: string | null }[];
    sellingModels: { id: string; name: string; type: string | null }[];
  } | null;
  /** The current user's Tax Admin permission (Revenue Cloud tax records need it). */
  taxAdmin?: { status: "enabled" | "missing" | "not-available"; canAssign: boolean; message: string; adminInstruction: string | null } | null;
  /** Describe-based access for the objects remediation may write (absent = not read; the assistant preview re-checks anyway). */
  access?: Record<string, { createable: boolean; updateable: boolean; fields: Record<string, { createable: boolean; updateable: boolean }> }>;
}

/** ISO 3166-2 subdivision codes for Canadian provinces/territories (the GeoState IsoCode the decision table compares). */
export const CA_PROVINCES: Record<string, string> = {
  "ontario": "ON", "quebec": "QC", "québec": "QC", "british columbia": "BC", "alberta": "AB", "manitoba": "MB", "saskatchewan": "SK", "nova scotia": "NS",
  "new brunswick": "NB", "newfoundland and labrador": "NL", "newfoundland": "NL", "prince edward island": "PE", "northwest territories": "NT", "nunavut": "NU", "yukon": "YT",
};

const id15 = (s: string | null | undefined) => (s ?? "").slice(0, 15);
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && id15(a) === id15(b);
const round2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

export function buildCalculationPlan(f: PlanFacts, req: PlanRequest): CalculationPlan {
  const reuse: PlanRecord[] = [], actions: PlanAction[] = [], duplicates: string[] = [], notes: string[] = [], questions: PlanQuestion[] = [], blocked: string[] = [];
  const dx: TaxDiagnosticItem[] = [];
  const s = f.snapshot;
  const effectiveDate = req.effectiveDate && /^\d{4}-\d{2}-\d{2}$/.test(req.effectiveDate) ? req.effectiveDate : today();
  const can = capabilityChecks(f.access);

  /** A structured diagnostic (stable id = code + record/key, so it survives re-evaluation and binds approvals). */
  const diagnose = (x: { code: string; severity: TaxDiagnosticItem["severity"]; stage: TaxDiagnosticItem["stage"]; title: string; cause: string; object?: string | null; record?: { id: string; name: string } | null; key?: string; evidence?: string[]; options?: ResolutionOption[]; recommendedOptionId?: string | null; dependsOn?: string[]; expected?: string; blocks?: boolean }) => {
    const id = `${x.code}:${x.record?.id ?? x.key ?? ""}`;
    if (dx.some(d => d.id === id)) return id;
    const options = x.options ?? [];
    const rec = x.recommendedOptionId !== undefined ? x.recommendedOptionId : options.find(o => o.supported)?.id ?? null;
    const r = options.find(o => o.id === rec);
    dx.push({ id, code: x.code, severity: x.severity, stage: x.stage, title: x.title, object: x.object ?? null, record: x.record ?? null, cause: x.cause, evidence: x.evidence ?? [],
      blocksCalculation: x.blocks ?? (x.severity === "blocker" || x.severity === "error"), options, recommendedOptionId: rec,
      recommendation: r ? `${r.label} — ${r.rationale}` : options.some(o => o.supported) ? "Several valid options — choose one (a business decision the application doesn't make for you)." : options.length ? "No option can be applied automatically — see the explanation." : "Informational.", dependsOn: x.dependsOn ?? [], expected: x.expected ?? "The issue no longer appears when the plan is re-checked." });
    return id;
  };
  const STAGE: Record<PlanQuestionField, TaxDiagnosticItem["stage"]> = { product: 1, account: 2, country: 2, state: 2, legalEntity: 2, policy: 3, treatment: 3, taxCode: 4, rate: 5, basis: 5, engine: 6 };
  const ask = (field: PlanQuestionField, question: string, options?: PlanQuestion["options"]) => {
    if (questions.some(q => q.field === field)) return;
    questions.push({ field, question, ...(options?.length ? { options } : {}) });
    diagnose({ code: `INPUT_${field.toUpperCase()}`, severity: "blocker", stage: STAGE[field], title: `Needed: ${field === "legalEntity" ? "legal entity" : field === "taxCode" ? "tax code" : field}`, cause: question, key: field,
      options: [{ id: "answer", kind: "ask", label: options?.length ? "Choose" : "Answer", rationale: "A business fact the application must not guess.", supported: true, steps: [], inputs: [{ field, question, ...(options?.length ? { options } : {}) }], records: [], reversible: true }] });
  };
  const block = (code: string, stage: TaxDiagnosticItem["stage"], title: string, text: string, extra: { record?: { id: string; name: string } | null; object?: string; evidence?: string[]; options?: ResolutionOption[]; key?: string } = {}) => {
    blocked.push(text);
    return diagnose({ code, severity: "blocker", stage, title, cause: text, key: extra.key, record: extra.record, object: extra.object, evidence: extra.evidence,
      options: extra.options?.length ? extra.options : [unsupported("explain", "No automatic fix", text)] });
  };
  const act = (a: Omit<PlanAction, "dependsOn"> & { dependsOn?: string[] }) => { actions.push({ dependsOn: actions.map(x => x.id), ...a }); return a.id; };

  /* jurisdiction — from the account, else the request (never assumed) */
  const rawCountry = req.account?.country ?? req.country ?? null;
  const rawState = req.account ? req.account.state : req.state ?? null;
  const country = rawCountry ? s.geoCountries.find(c => c.iso === rawCountry.trim().toUpperCase() || c.name.toLowerCase() === rawCountry.trim().toLowerCase()) ?? null : null;
  let stateIso: string | null = null, stateName: string | null = null, geoStateId: string | null = null;
  const accountAddressFix = (field: string) => unsupported("fix-account", "Correct the account address", `The tax workflow doesn't edit customer accounts: set the account's ${field} to the ISO code in Accounts, then re-check — the plan keeps this product and account.`);
  if (rawState) {
    const raw = rawState.trim();
    const iso = raw.length <= 3 ? raw.toUpperCase() : country?.iso === "CA" ? CA_PROVINCES[raw.toLowerCase()] ?? null : null;
    const gs = f.geoStates.find(g => (!country || g.countryIso === country.iso) && (g.iso === (iso ?? raw.toUpperCase()) || g.name.toLowerCase() === raw.toLowerCase()));
    stateIso = gs?.iso ?? iso; stateName = gs?.name ?? (raw.length > 3 ? raw : null); geoStateId = gs?.id ?? null;
    if (req.account && raw.length > 3) block("ACCOUNT_STATE_NOT_ISO", 2, "Account billing state is a name, not an ISO code", `Account "${req.account.name}" has the billing state "${raw}" as a name — the decision table compares ISO codes${stateIso ? ` ("${stateIso}")` : ""}. Correct the account's address first.`, { record: { id: req.account.id, name: req.account.name }, object: "Account", options: [accountAddressFix("Billing State")] });
  }
  if (req.account && rawCountry && rawCountry.trim().length > 2) block("ACCOUNT_COUNTRY_NOT_ISO", 2, "Account billing country is a name, not an ISO code", `Account "${req.account.name}" has the billing country "${rawCountry}" as a name — the decision table compares ISO codes${country ? ` ("${country.iso}")` : ""}. Correct the account's address first.`, { record: { id: req.account.id, name: req.account.name }, object: "Account", options: [accountAddressFix("Billing Country")] });
  const jurisdiction = { countryIso: country?.iso ?? null, countryName: country?.name ?? rawCountry, stateIso, stateName };

  /* product */
  const p = f.product;
  if (!p) ask("product", f.productMessage ?? "Which product? Give its exact name, ProductCode or Product2 Id.", (f.productCandidates ?? []).map(c => ({ value: c.id, label: `${c.name} · ${c.code ?? "no code"} · ${c.id}` })));
  else if (!p.active) block("PRODUCT_INACTIVE", 1, "Product is inactive", `Product "${p.name}" is inactive in Salesforce.`, { record: { id: p.id, name: p.name }, object: "Product2" });
  else reuse.push({ object: "Product2", id: p.id, name: p.name, detail: `ProductCode ${p.code ?? "— (none: only rates without a product code can match)"}` });
  const done = (summary: string): CalculationPlan => finish({ access: f.access, product: p, jurisdiction, reuse, actions, duplicates, notes, questions, blocked, dx, expected: null, summary, req, listPrice: f.listPrice });
  if (!p || !p.active) return done(p ? `${p.name} is inactive.` : "The product couldn't be resolved.");

  /* permissions — Revenue Cloud tax records need Tax Admin; it is only ever self-assigned, and only when the user may assign permission sets */
  if (f.taxAdmin && f.taxAdmin.status !== "enabled") {
    const ta = f.taxAdmin;
    diagnose({ code: ta.status === "missing" ? "TAX_ADMIN_MISSING" : "TAX_ADMIN_NOT_AVAILABLE", severity: ta.status === "missing" ? "blocker" : "warning", stage: 1, title: ta.status === "missing" ? "Your user lacks the Tax Admin permission set" : "Tax Admin isn't available in this org", object: "PermissionSet", key: "tax-admin",
      cause: ta.message, blocks: ta.status === "missing",
      options: ta.status === "missing" && ta.canAssign
        ? [{ id: "assign-tax-admin", kind: "update", label: "Assign Tax Admin to yourself", rationale: "Your user may assign permission sets; the assignment is to the CURRENT user only and is verified by re-reading it.", supported: true,
            steps: [{ id: "assign-tax-admin", group: "permission", title: "Assign the Tax Admin permission set to the current user", object: "PermissionSetAssignment", recordId: null, operation: null, action: { kind: "tax-admin" }, changes: [{ field: "PermissionSet", value: "Tax Admin" }] }],
            records: [{ role: "create", object: "PermissionSetAssignment", id: null, name: "Tax Admin → current user" }], consequences: ["Grants the current user Revenue Cloud tax administration in this org."], reversible: true }]
        : [unsupported("admin", "Ask a Salesforce administrator", ta.adminInstruction ?? ta.message)] });
  }

  /* billing prerequisites — the order needs a billing policy and a price with a selling model (only what's missing is proposed) */
  const b = f.billing;
  if (b?.unreadable) diagnose({ code: "BILLING_CONFIG_UNREADABLE", severity: "warning", stage: 2, title: "The product's billing configuration couldn't be read", cause: b.unreadable, key: p.id, blocks: false, options: [unsupported("explain", "Check access", "The billing objects couldn't be read with your user — nothing is concluded about them.")] });
  else if (b) {
    if (!b.productBillingPolicyId) {
      const active = b.billingPolicies.filter(x => x.status === "Active");
      const ok = can.update("Product2", "BillingPolicyId");
      diagnose({ code: "BILLING_POLICY_MISSING", severity: "blocker", stage: 2, title: `${p.name} has no billing policy`, record: { id: p.id, name: p.name }, object: "Product2",
        cause: `Product2.BillingPolicyId is empty — Salesforce can't create billing schedules for ${p.name} without a billing policy.`, evidence: active.map(x => `Active billing policy: ${x.name} (${x.id})`),
        options: [
          ...active.slice(0, 6).map((x): ResolutionOption => ({ id: `link-billing-policy:${x.id}`, kind: "link", label: `Use the existing billing policy "${x.name}"`, rationale: "An existing Active billing policy — linked, nothing is created.", supported: ok, unsupportedReason: ok ? null : "Your user can't edit Product2.BillingPolicyId.",
            steps: [{ id: "link-billing-policy", group: "link", title: `Set ${p.name}'s Billing Policy → "${x.name}"`, object: "Product2", recordId: p.id, operation: null, action: { kind: "record", object: "Product2", op: "update", recordId: p.id, fields: { BillingPolicyId: x.id } }, changes: [{ field: "BillingPolicyId", value: `${x.name} (${x.id})` }] }],
            records: [{ role: "reuse", object: "BillingPolicy", id: x.id, name: x.name }, { role: "update", object: "Product2", id: p.id, name: p.name }], consequences: [`Every future order of ${p.name} is billed under "${x.name}".`], reversible: true })),
          unsupported("create-billing-policy", "Create a billing policy", active.length ? "Not created here — an existing Active policy fits the need; choose one above." : "No Active billing policy exists. Creating one needs a billing treatment and its items (Billing → Billing Policies); this calculation workflow doesn't create billing chains."),
        ], recommendedOptionId: active.length === 1 && ok ? `link-billing-policy:${active[0].id}` : null });
    }
    const std = b.priceEntries.filter(x => x.standard && x.active);
    const withModel = std.filter(x => x.sellingModelId);
    const model = req.sellingModelId ? b.sellingModels.find(m => same(m.id, req.sellingModelId)) ?? null : b.sellingModels.length === 1 ? b.sellingModels[0] : null;
    if (!withModel.length) {
      const price = req.unitPrice ?? std.find(x => x.unitPrice !== null)?.unitPrice ?? null;
      const inputs: ResolutionInput[] = [];
      if (!model && b.sellingModels.length) inputs.push({ field: "sellingModel", question: `Which selling model is ${p.name} sold with?`, options: b.sellingModels.map(m => ({ value: m.id, label: `${m.name}${m.type ? ` · ${m.type}` : ""}` })) });
      if (price === null) inputs.push({ field: "unitPrice", question: `What is ${p.name}'s list price?` });
      const canCreate = can.create("PricebookEntry") && !!b.standardPricebookId && b.sellingModels.length > 0;
      const why = !b.sellingModels.length ? `${p.name} offers no selling model (ProductSellingModelOption) — add one to the product in Products first; a price without a selling model can't be ordered.` : !b.standardPricebookId ? "No Standard Price Book is visible." : "Your user can't create price book entries.";
      diagnose({ code: std.length ? "PRICE_SELLING_MODEL_MISSING" : "PRICE_MISSING", severity: "blocker", stage: 2, title: std.length ? `${p.name}'s price has no selling model` : `${p.name} has no active standard price`, record: { id: p.id, name: p.name }, object: "PricebookEntry",
        cause: std.length ? `${p.name}'s active Standard Price Book entr${std.length > 1 ? "ies have" : "y has"} no ProductSellingModelId (set only at creation) — the order product can't take a selling model.` : `${p.name} has no active Standard Price Book entry.`,
        evidence: b.priceEntries.map(x => `PricebookEntry ${x.id}: ${x.unitPrice ?? "—"} · ${x.active ? "active" : "inactive"} · ${x.standard ? "standard" : "custom"} · selling model ${x.sellingModelName ?? "none"}`),
        options: [canCreate
          ? { id: "create-price", kind: "create", label: `Create a standard price for ${p.name}${model ? ` (${model.name})` : ""}`, rationale: std.length ? "A new entry with the selling model (the existing one stays, unchanged — ProductSellingModelId can't be added to it)." : "The order needs an active standard price with the product's selling model.",
              supported: true, inputs: inputs.length ? inputs : undefined,
              steps: inputs.length ? [] : [{ id: "create-price", group: "config", title: `Create PricebookEntry ${p.name} · ${price} · ${model!.name}`, object: "PricebookEntry", recordId: null, operation: null,
                action: { kind: "record", object: "PricebookEntry", op: "create", fields: { Pricebook2Id: b.standardPricebookId!, Product2Id: p.id, UnitPrice: price!, IsActive: true, ProductSellingModelId: model!.id } }, changes: [{ field: "UnitPrice", value: String(price) }, { field: "ProductSellingModelId", value: model!.name }, { field: "Pricebook2Id", value: "Standard Price Book" }] }],
              records: [{ role: "create", object: "PricebookEntry", id: null, name: `${p.name} · ${model?.name ?? "selling model"}` }], reversible: true }
          : unsupported("create-price", "Create a price", why)] });
    }
  }

  /* policy */
  const policy = p.taxPolicyId ? s.policies.find(x => same(x.id, p.taxPolicyId)) ?? null : null;
  if (!policy) {
    // Existing policies are offered only with their APPLICABILITY checked: an Active, Default-selection policy whose default treatment
    // is complete (taxable, Legal Entity, usable engine) and whose tax code has a rate matching THIS product and jurisdiction.
    const allRates: RRRate[] = s.rates.map(r => ({ id: r.id, name: r.name, taxCode: r.taxCode, rate: r.rate, countryIso: r.country, stateIso: r.state ?? null, city: r.city ?? null, zipCode: r.zipCode ?? null, productCode: r.productCode, legalEntityId: r.legalEntityId, usage: r.usage, basis: r.basis ?? null, start: r.start, end: r.end, priority: r.priority ?? null }));
    const usableEngineIds = new Set(s.engines.filter(e => e.status === "Active" && e.native && e.decisionTableId && f.tables[e.decisionTableId]?.inputs.includes("TaxCode")).map(e => e.id.slice(0, 15)));
    const candidates = s.policies.filter(x => x.status === "Active" && x.selection === "Default" && x.defaultTreatmentId).map(x => {
      const t = s.treatments.find(y => same(y.id, x.defaultTreatmentId)) ?? null;
      if (!t || t.status !== "Active") return null;
      const complete = !t.taxable || (!!t.legalEntityId && !!t.engineId && usableEngineIds.has(t.engineId.slice(0, 15)) && !t.useItems);
      const engine = t.engineId ? s.engines.find(e => same(e.id, t.engineId)) : null;
      const r = t.taxable && t.taxCode && country ? resolveTaxRate(allRates, { taxCode: t.taxCode, countryIso: country.iso, stateIso, city: null, zipCode: null, productCode: p.code, legalEntityId: t.legalEntityId, effectiveDate, rateUsageType: REVENUE_CLOUD_RATE_USAGE, applicationBasis: null }, engine?.decisionTableId ? f.tables[engine.decisionTableId]?.inputs ?? null : null) : null;
      return { policy: x, treatment: t, complete, verified: !!t.taxable && complete && r?.outcome === "single", rate: r?.selected ?? null };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    const where = country ? [stateIso, country.iso].filter(Boolean).join("/") : null;
    const linkOptions = candidates.sort((x, y) => Number(y.verified) - Number(x.verified)).slice(0, 6).map(c => linkPolicyOption(p, c.policy, can,
      !c.treatment.taxable ? `Existing Active policy "${c.policy.name}" — its default treatment "${c.treatment.name}" is NOT taxable: no tax will apply.`
      : c.verified ? `VERIFIED APPLICABLE: "${c.policy.name}" → "${c.treatment.name}" (tax code ${c.treatment.taxCode}) has rate ${c.rate!.name} (${c.rate!.rate}% ${c.rate!.basis ?? ""}) matching ${p.name} in ${where}.`
      : `Applicability NOT verified: "${c.policy.name}" → "${c.treatment.name}"${c.complete ? ` (tax code ${c.treatment.taxCode ?? "per item"})` : " is incomplete (Legal Entity / engine / items)"}${where ? ` has no rate matching ${p.name} in ${where}` : ""} — further steps would follow.`));
    const verified = candidates.filter(c => c.verified);
    const create = newConfigurationOption({ product: p, req, snapshot: s, tables: f.tables, can, effectiveDate, rates: allRates,
      jurisdiction: country ? { iso: country.iso, name: country.name, geoCountryId: s.geoCountries.find(c => c.iso === country.iso)!.id, stateIso, stateName, geoStateId, stateGiven: !!rawState } : null });
    questions.push({ field: "policy", question: `${p.name} has no Tax Policy. Choose an existing policy or create a configuration in "Issues & fixes".` });
    diagnose({ code: "TAX_POLICY_MISSING", severity: "blocker", stage: 3, title: `No applicable tax policy for ${p.name}`, record: { id: p.id, name: p.name }, object: "Product2",
      cause: `${p.name} (${p.code ?? "no ProductCode"}) has no Tax Policy${p.taxPolicyId ? ` visible to your user (${p.taxPolicyId})` : ""}, so no Tax Treatment can be resolved — Salesforce would bill it with the legal entity's fallback treatment and calculate no tax.`,
      evidence: [`Product2 ${p.id}: TaxPolicyId ${p.taxPolicyId ?? "null"}`, ...candidates.map(c => `Active policy "${c.policy.name}" → "${c.treatment.name}": ${!c.treatment.taxable ? "not taxable" : c.verified ? `rate ${c.rate!.name} matches` : "no matching rate / incomplete"}`)],
      options: [...linkOptions, create], recommendedOptionId: verified.length === 1 ? `link-policy:${verified[0].policy.id}` : verified.length > 1 ? null : create.supported ? "create-tax-configuration" : null });
    return done(`No applicable tax policy for ${p.name} — a configuration proposal is prepared below.`);
  }

  /* treatment: the policy's default, else its only non-inactive treatment, else the user's choice */
  const underPolicy = s.treatments.filter(t => same(t.policyId, policy.id) && t.status !== "Inactive");
  const chosen = req.treatmentId ? s.treatments.find(t => same(t.id, req.treatmentId)) ?? null : null;
  const treatment = chosen ?? (policy.defaultTreatmentId ? s.treatments.find(t => same(t.id, policy.defaultTreatmentId)) ?? null : underPolicy.length === 1 ? underPolicy[0] : null);
  for (const it of s.items.filter(i => same(i.productId, p.id))) {
    const t = s.treatments.find(x => same(x.id, it.treatmentId));
    if (t && !same(t.policyId, policy.id)) {
      const text = `Tax Treatment "${t.name}" (${t.id}, ${t.status ?? "—"}) under policy "${s.policies.find(x => same(x.id, t.policyId))?.name ?? t.policyId ?? "—"}" has Tax Treatment Item "${it.name}" (${it.id}) for ${p.name}, but ${p.name} uses policy "${policy.name}" — it is left unchanged.`;
      duplicates.push(text);
      diagnose({ code: "POSSIBLE_DUPLICATE_CONFIGURATION", severity: "warning", stage: 3, title: "Another configuration also covers this product", cause: text, record: { id: t.id, name: t.name }, object: "TaxTreatment", blocks: false, options: [] });
    }
  }
  const activeLes = s.legalEntities.filter(l => !l.status || l.status === "Active");
  const usable = (eId: string | null | undefined) => {
    const e = eId ? s.engines.find(x => same(x.id, eId)) ?? null : null;
    const t = e?.decisionTableId ? f.tables[e.decisionTableId] ?? null : null;
    return { e, t, ok: !!e && e.status === "Active" && e.native && !!t && t.inputs.includes("TaxCode") };
  };
  const usableEngines = s.engines.filter(e => usable(e.id).ok);
  const rankedEngines = usableEngines.map(e => ({ e, n: s.treatments.filter(t => same(t.engineId, e.id) && t.status === "Active" && t.taxable).length })).sort((a, b) => b.n - a.n);
  const bestEngine = (preferred: string | null | undefined) => (preferred && usable(preferred).ok ? s.engines.find(e => same(e.id, preferred))! : rankedEngines.length === 1 || (rankedEngines.length > 1 && rankedEngines[0].n > rankedEngines[1].n) ? rankedEngines[0].e : null);

  if (!treatment) {
    if (!underPolicy.length) {
      const opt = newTreatmentOption({ id: "create-treatment", policy, product: p, replacing: null, item: null, taxCode: req.taxCode ?? null, legalEntity: activeLes.length === 1 ? activeLes[0] : null, engine: bestEngine(req.engineId), snapshot: s, can, effectiveDate });
      block("POLICY_HAS_NO_TREATMENT", 3, "Tax policy has no treatment", `Tax Policy "${policy.name}" has no treatment — one is needed before tax can be calculated.`, { record: { id: policy.id, name: policy.name }, object: "TaxPolicy", options: [opt] });
    } else ask("treatment", `Tax Policy "${policy.name}" has ${underPolicy.length} treatments and no default — which one applies to ${p.name}?`, underPolicy.map(t => ({ value: t.id, label: `${t.name} · ${t.status ?? "—"} · ${t.taxable ? "taxable" : "not taxable"}` })));
    return done(`${policy.name} has no usable treatment yet.`);
  }
  if (!treatment.taxable) {
    reuse.push({ object: "TaxPolicy", id: policy.id, name: policy.name, detail: `${policy.status ?? "—"} · ${policy.selection ?? "—"}` });
    reuse.push({ object: "TaxTreatment", id: treatment.id, name: treatment.name, detail: "NOT taxable" });
    const text = `Tax Treatment "${treatment.name}" isn't taxable — Salesforce applies no tax to ${p.name}; nothing is changed.`;
    notes.push(text);
    diagnose({ code: "TREATMENT_NOT_TAXABLE", severity: "info", stage: 3, title: "The product's treatment is not taxable", cause: text, record: { id: treatment.id, name: treatment.name }, object: "TaxTreatment", blocks: false });
    return done(`${p.name} resolves to a non-taxable treatment.`);
  }
  const draft = treatment.status === "Draft";
  const tUpdate: Record<string, unknown> = {};
  /** Defects of a treatment that has left Draft: its Legal Entity (and these fields) can't be changed — a replacement is needed. */
  const lockedDefects: string[] = [];

  /* legal entity (required in practice; locked once the treatment leaves Draft) */
  let legalEntityId = treatment.legalEntityId;
  const chosenLe = req.legalEntityId ? activeLes.find(l => same(l.id, req.legalEntityId)) ?? null : null;
  if (!legalEntityId && draft && chosenLe) { legalEntityId = chosenLe.id; tUpdate.LegalEntityId = { id: chosenLe.id }; }
  if (!legalEntityId) {
    if (!draft) lockedDefects.push("has no Legal Entity (Salesforce locks LegalEntityId once a treatment leaves Draft; in this org taxable treatments without one produced no InvoiceLineTax)");
    else if (activeLes.length === 1) { legalEntityId = activeLes[0].id; tUpdate.LegalEntityId = { id: legalEntityId }; notes.push(`Legal Entity: "${activeLes[0].name}" is the org's only active legal entity.`); }
    else if (!activeLes.length) block("NO_ACTIVE_LEGAL_ENTITY", 2, "No active legal entity", "This org has no active Legal Entity.", { object: "LegalEntity", key: "org" });
    else ask("legalEntity", `Which legal entity sells ${p.name}? (Tax Treatment "${treatment.name}" has none.)`, activeLes.map(l => ({ value: l.id, label: l.name })));
  }
  const leForRates = legalEntityId ?? (activeLes.length === 1 ? activeLes[0].id : null);

  /* tax code — the item's for item treatments, else the treatment's */
  const item = treatment.useItems ? s.items.find(i => same(i.treatmentId, treatment.id) && same(i.productId, p.id)) ?? null : null;
  let taxCode = (treatment.useItems ? item?.taxCode : null) ?? treatment.taxCode ?? null;
  if (taxCode && req.taxCode && req.taxCode !== taxCode) notes.push(`The configuration already uses tax code "${taxCode}"; the request's "${req.taxCode}" isn't applied (change the treatment explicitly if intended).`);
  if (!taxCode) {
    if (!req.taxCode) ask("taxCode", `Which tax code applies to ${p.name}${jurisdiction.countryName ? ` in ${[jurisdiction.stateName, jurisdiction.countryName].filter(Boolean).join(", ")}` : ""}? (Tax Treatment "${treatment.name}" has none.)`, [...new Set(s.rates.filter(r => !country || r.country === country.iso).map(r => r.taxCode).filter((c): c is string => !!c))].slice(0, 12).map(c => ({ value: c, label: `${c} (existing code${country ? ` with ${country.iso} rates` : ""})` })));
    else if (treatment.useItems || draft) taxCode = req.taxCode;
    else lockedDefects.push("has no tax code");
    if (taxCode && !treatment.useItems && draft) tUpdate.TaxCode = taxCode;
  }

  /* engine — the treatment's, else an existing Active Revenue Standard Tax engine with a TaxCode decision table (reuse) */
  let eng = usable(treatment.engineId);
  if (!eng.ok) {
    const cur = eng.e;
    const why = !cur ? "has no tax engine" : cur.status !== "Active" ? `uses "${cur.name}", which is ${cur.status}` : !cur.decisionTableId ? `uses "${cur.name}", which has no decision table` : `uses "${cur.name}", whose decision table has no TaxCode input`;
    const best = bestEngine(req.engineId);
    if (!draft) lockedDefects.push(why);
    else if (best) {
      tUpdate.TaxEngineId = { id: best.id };
      eng = usable(best.id);
      notes.push(`Tax engine: Tax Treatment "${treatment.name}" ${why}. Proposed: reuse the Active engine "${best.name}" (${best.id})${rankedEngines.length > 1 ? ` — used by the most active taxable treatments; alternatives: ${rankedEngines.filter(r => r.e.id !== best.id).map(r => r.e.name).join(", ")}` : ""}. Activating ${cur ? `"${cur.name}"` : "a new engine"} and assigning it a decision table instead is an administrator change that is not proposed here.`);
    } else if (usableEngines.length) ask("engine", `Tax Treatment "${treatment.name}" ${why}. Which Active tax engine (with a TaxCode decision table) should it use?`, usableEngines.map(e => ({ value: e.id, label: `${e.name} · ${f.tables[e.decisionTableId!]?.name ?? e.decisionTableId}` })));
    else block("NO_USABLE_TAX_ENGINE", 6, "No usable tax engine", `Tax Treatment "${treatment.name}" ${why}, and no Active Revenue Standard Tax engine with a TaxCode decision table exists — an administrator must set one up (the app never creates or clones decision tables).`, { record: { id: treatment.id, name: treatment.name }, object: "TaxEngine" });
  }

  /* rates seen with the CURRENT (or proposed) code — used for jurisdiction coverage and the rate step */
  const rates: RRRate[] = s.rates.map(r => ({ id: r.id, name: r.name, taxCode: r.taxCode, rate: r.rate, countryIso: r.country, stateIso: r.state ?? null, city: r.city ?? null, zipCode: r.zipCode ?? null, productCode: r.productCode, legalEntityId: r.legalEntityId, usage: r.usage, basis: r.basis ?? null, start: r.start, end: r.end, priority: r.priority ?? null }));
  const tableInputs = (eng.t ?? usable(bestEngine(req.engineId)?.id).t)?.inputs ?? null;
  const resolveFor = (code: string | null, productCode: string | null) => code && country ? resolveTaxRate(rates, { taxCode: code, countryIso: country.iso, stateIso, city: null, zipCode: null, productCode, legalEntityId: leForRates, effectiveDate, rateUsageType: REVENUE_CLOUD_RATE_USAGE, applicationBasis: null }, tableInputs) : null;
  const rateRes = resolveFor(taxCode, p.code);

  /* jurisdiction coverage: the tax code has rates, but only for OTHER countries — a business decision (never patched over) */
  let jurisdictionDiag: string | null = null;
  if (country && taxCode && rateRes?.outcome === "none") {
    const sameCode = rates.filter(r => r.taxCode === taxCode && (r.usage ?? "").toLowerCase() === REVENUE_CLOUD_RATE_USAGE.toLowerCase());
    const elsewhere = [...new Set(sameCode.map(r => r.countryIso).filter((c): c is string => !!c && c !== country.iso))];
    if (sameCode.length && elsewhere.length && !sameCode.some(r => r.countryIso === country.iso)) {
      const alt = s.policies.filter(x => !same(x.id, policy.id) && x.status === "Active" && x.selection === "Default" && x.defaultTreatmentId).map(x => {
        const t = s.treatments.find(y => same(y.id, x.defaultTreatmentId));
        if (!t || t.status !== "Active" || !t.taxable || !t.legalEntityId || !usable(t.engineId).ok) return null;
        const code = (t.useItems ? s.items.find(i => same(i.treatmentId, t.id) && same(i.productId, p.id))?.taxCode : null) ?? t.taxCode;
        if (t.useItems && !s.items.some(i => same(i.treatmentId, t.id) && same(i.productId, p.id))) return null;
        const r = resolveFor(code ?? null, p.code);
        const inCountry = rates.some(z => z.taxCode === code && z.countryIso === country.iso);
        return inCountry ? { policy: x, treatment: t, code, full: r?.outcome === "single", rate: r?.selected ?? null } : null;
      }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => Number(b.full) - Number(a.full)).slice(0, 4);
      const where = [stateIso, country.iso].filter(Boolean).join("/");
      const options: ResolutionOption[] = [
        ...alt.map(a => linkPolicyOption(p, a.policy, can, a.full ? `Policy "${a.policy.name}" → "${a.treatment.name}" (tax code ${a.code}) already has rate ${a.rate!.name} (${a.rate!.rate}%) matching ${p.name} in ${where}.` : `Policy "${a.policy.name}" → "${a.treatment.name}" (tax code ${a.code}) has ${country.iso} rates, but none matches ${p.name} in ${where} yet — a rate step follows after linking.`)),
        { id: "confirm-jurisdiction", kind: "ask", label: "Check the customer / jurisdiction", rationale: `If ${p.name} should be sold under ${elsewhere.join(", ")} tax, the customer account is wrong — choose the right account and re-check.`, supported: true, steps: [], inputs: [{ field: "account", question: "Which customer account is the sale for?" }], records: [], reversible: true },
        { id: "create-rate-same-code", kind: "create", label: `Create a ${where} rate for tax code ${taxCode}`, rationale: `Only if ${taxCode} is genuinely the right tax for ${country.name} (its existing rates are for ${elsewhere.join(", ")}). Give the rate and basis below; the plan then lists the rate step.`, supported: can.create("TaxRate"), unsupportedReason: can.create("TaxRate") ? null : "Your user can't create Tax Rate records.", steps: [], inputs: [{ field: "rate", question: `Rate (%) for ${taxCode} in ${where}` }, { field: "basis", question: "Application basis", options: [{ value: "Net", label: "Net" }, { value: "Gross", label: "Gross" }] }], records: [], reversible: true },
      ];
      if (req.rate === null || req.rate === undefined) {
        blocked.push(`${p.name}'s tax code ${taxCode} has rates only for ${elsewhere.join(", ")}; the sale is to ${where}.`);
        jurisdictionDiag = diagnose({ code: "JURISDICTION_NOT_COVERED", severity: "blocker", stage: 2, title: `${p.name}'s tax configuration doesn't cover ${country.name}`, object: "TaxRate", key: `${taxCode}:${country.iso}`,
          cause: `${p.name} uses tax code ${taxCode} (Tax Treatment "${treatment.name}" of policy "${policy.name}"), whose ${REVENUE_CLOUD_RATE_USAGE} rates exist only for ${elsewhere.join(", ")}; the sale is to ${where}. Salesforce would find no rate and calculate no tax.`,
          evidence: sameCode.map(r => `${r.name}: ${r.taxCode} ${r.rate ?? "?"}% · ${r.countryIso ?? "—"}${r.stateIso ? `/${r.stateIso}` : ""} · ProductCode ${r.productCode ?? "any"}`),
          options, recommendedOptionId: alt.find(a => a.full) ? options[0].id : "confirm-jurisdiction" });
      }
    }
  }

  /* a treatment that left Draft with locked defects → reuse a compatible treatment, or create a replacement (never edited, never deactivated) */
  let replacementDiag: string | null = null;
  if (lockedDefects.length) {
    const compatible = s.treatments.filter(t => !same(t.id, treatment.id) && same(t.policyId, policy.id) && t.status === "Active" && t.taxable && t.legalEntityId && usable(t.engineId).ok
      && ((t.useItems ? s.items.find(i => same(i.treatmentId, t.id) && same(i.productId, p.id))?.taxCode : t.taxCode) ?? null) === taxCode && (!t.useItems || s.items.some(i => same(i.treatmentId, t.id) && same(i.productId, p.id))));
    const policyLink = (t: (typeof compatible)[number]): ResolutionOption => ({ id: `use-treatment:${t.id}`, kind: "link", label: `Make "${t.name}" the policy's default`, rationale: `An existing Active, taxable treatment of "${policy.name}" with a Legal Entity, a usable engine and tax code ${taxCode ?? "—"} — reused, nothing is created.`,
      supported: can.update("TaxPolicy", "DefaultTaxTreatmentId"), unsupportedReason: can.update("TaxPolicy", "DefaultTaxTreatmentId") ? null : "Your user can't edit TaxPolicy.DefaultTaxTreatmentId.",
      steps: [{ id: "set-default", group: "link", title: `Set "${policy.name}" default treatment → "${t.name}"`, object: "TaxPolicy", recordId: policy.id, operation: { key: "set-default", op: "update", object: "TaxPolicy", target: { id: policy.id }, fields: { DefaultTaxTreatmentId: { id: t.id } } }, changes: [{ field: "DefaultTaxTreatmentId", value: `${t.name} (${t.id})` }] }],
      records: [{ role: "reuse", object: "TaxTreatment", id: t.id, name: t.name }, { role: "update", object: "TaxPolicy", id: policy.id, name: policy.name }],
      consequences: [`Every product on "${policy.name}" (${policy.products}) is taxed with "${t.name}" from then on.`, `"${treatment.name}" stays Active and unchanged; pointing the default back reverses this.`], reversible: true });
    // The ONLY defect is an inactive engine whose decision table is usable → activating the engine fixes it in place (no replacement).
    const ce = treatment.engineId ? s.engines.find(e => same(e.id, treatment.engineId)) ?? null : null;
    const engineActivation: ResolutionOption | null = lockedDefects.length === 1 && treatment.legalEntityId && ce && ce.status !== "Active" && ce.native && ce.decisionTableId && f.tables[ce.decisionTableId]?.inputs.includes("TaxCode")
      ? { id: `activate-engine:${ce.id}`, kind: "activate", label: `Activate tax engine "${ce.name}"`, rationale: `Its decision table ${f.tables[ce.decisionTableId].name} has the TaxCode input and the treatment is otherwise complete — activation fixes it without a replacement.`,
          supported: can.update("TaxEngine", "Status"), unsupportedReason: can.update("TaxEngine", "Status") ? null : "Your user can't change TaxEngine.Status.",
          steps: [{ id: "activate-engine", group: "activation", title: `Activate "${ce.name}"`, object: "TaxEngine", recordId: ce.id, operation: { key: "activate-engine", op: "activate", object: "TaxEngine", target: { id: ce.id } }, changes: [{ field: "Status", value: "Active" }] }],
          records: [{ role: "activate", object: "TaxEngine", id: ce.id, name: ce.name }], consequences: [`Every treatment that uses "${ce.name}" starts calculating tax through it.`], reversible: true }
      : null;
    const replacement = newTreatmentOption({ id: "create-replacement", policy, product: p, replacing: treatment, item, taxCode, legalEntity: legalEntityId ? s.legalEntities.find(l => same(l.id, legalEntityId)) ?? null : chosenLe ?? (activeLes.length === 1 ? activeLes[0] : null), engine: eng.ok ? eng.e : bestEngine(req.engineId), snapshot: s, can, effectiveDate });
    replacementDiag = diagnose({ code: "TREATMENT_LOCKED_NEEDS_REPLACEMENT", severity: "blocker", stage: 3, title: `Active treatment "${treatment.name}" can't be repaired in place`, record: { id: treatment.id, name: treatment.name }, object: "TaxTreatment",
      cause: `Tax Treatment "${treatment.name}" (${treatment.status}) ${lockedDefects.join("; ")}. Salesforce doesn't allow these fields to change after the treatment leaves Draft, so it isn't edited.`,
      evidence: [`TaxTreatment ${treatment.id}: Status ${treatment.status}, LegalEntityId ${treatment.legalEntityId ?? "null"}, TaxEngineId ${treatment.engineId ?? "null"}, TaxCode ${treatment.taxCode ?? "null"}, uses items ${treatment.useItems}`, `Policy "${policy.name}" (${policy.selection}) default → this treatment`],
      options: [...(engineActivation ? [engineActivation] : []), ...compatible.map(policyLink), replacement], dependsOn: jurisdictionDiag ? [jurisdictionDiag] : [] });
    blocked.push(`Tax Treatment "${treatment.name}" is ${treatment.status} and ${lockedDefects.join("; ")} — it can't be edited; reuse a compatible treatment or create a replacement.`);
  }

  /* 1 · update the Draft treatment (one approval) */
  const writable = draft && Object.keys(tUpdate).length > 0;
  if (writable) act({ id: "update-treatment", group: "update", object: "TaxTreatment", recordId: treatment.id, title: `Update Draft Tax Treatment "${treatment.name}"`,
    detail: Object.entries(tUpdate).map(([k, v]) => `${k} → ${typeof v === "object" && v ? (s.legalEntities.find(l => same(l.id, (v as { id: string }).id))?.name ?? s.engines.find(e => same(e.id, (v as { id: string }).id))?.name ?? (v as { id: string }).id) : String(v)}`).join(" · "),
    operation: { key: "update-treatment", op: "update", object: "TaxTreatment", target: { id: treatment.id }, fields: tUpdate } });
  else if (!lockedDefects.length) reuse.push({ object: "TaxTreatment", id: treatment.id, name: treatment.name, detail: `${treatment.status ?? "—"} · taxable · tax code ${taxCode ?? "—"} · legal entity ${legalEntityId ?? "—"}${treatment.useItems ? " · uses items" : ""}` });

  /* 2 · treatment item (item treatments) */
  if (treatment.useItems && !lockedDefects.length) {
    if (!item) {
      if (taxCode) act({ id: "create-item", group: "create", object: "TaxTreatmentItem", recordId: null, title: `Create Tax Treatment Item for ${p.name}`, detail: `under "${treatment.name}" · TaxCode ${taxCode} · ProductCode ${p.code ?? "—"}`,
        operation: { key: "create-item", op: "create", object: "TaxTreatmentItem", fields: { Name: `${p.name} ${taxCode}`.slice(0, 80), TaxTreatmentId: { id: treatment.id }, ProductId: { id: p.id }, TaxCode: taxCode, ...(p.code ? { ProductCode: p.code } : {}) } } });
    } else if (!item.taxCode && taxCode) {
      act({ id: "update-item", group: "update", object: "TaxTreatmentItem", recordId: item.id, title: `Update Tax Treatment Item "${item.name}"`, detail: `TaxCode → ${taxCode}`, operation: { key: "update-item", op: "update", object: "TaxTreatmentItem", target: { id: item.id }, fields: { TaxCode: taxCode } } });
    } else reuse.push({ object: "TaxTreatmentItem", id: item.id, name: item.name, detail: `TaxCode ${item.taxCode ?? "—"} · ProductCode ${item.productCode ?? "—"}` });
  }
  if (item?.productCode && p.code && item.productCode !== p.code) notes.push(`Tax Treatment Item "${item.name}" has ProductCode "${item.productCode}" ≠ the product's "${p.code}". Salesforce matches the product's code (proven for treatments without items); for item treatments this is unverified.`);

  /* 3 · activate the treatment (before the policy — Salesforce refuses a policy whose default isn't Active) */
  const blockedConfig = blocked.length > 0 || questions.some(q => ["legalEntity", "taxCode", "engine"].includes(q.field));
  if (treatment.status !== "Active" && !blockedConfig) act({ id: "activate-treatment", group: "activate", object: "TaxTreatment", recordId: treatment.id, title: `Activate Tax Treatment "${treatment.name}"`, detail: `${treatment.status ?? "—"} → Active`, operation: { key: "activate-treatment", op: "activate", object: "TaxTreatment", target: { id: treatment.id } } });
  if (treatment.status === "Inactive") notes.push(`Tax Treatment "${treatment.name}" is Inactive — Salesforce allows Inactive → Active.`);

  /* 4 · policy: Default selection with this default treatment, then Active */
  const pUpdate: Record<string, unknown> = {};
  if (policy.selection !== "Default") pUpdate.TreatmentSelection = "Default";
  if (!same(policy.defaultTreatmentId, treatment.id)) pUpdate.DefaultTaxTreatmentId = { id: treatment.id };
  if (Object.keys(pUpdate).length) {
    if (policy.status === "Active" && "TreatmentSelection" in pUpdate) block("POLICY_SELECTION_LOCKED", 3, "Active policy doesn't use Default selection", `Tax Policy "${policy.name}" is Active with ${policy.selection} selection — changing it to Default isn't proposed automatically (the order product's treatment is stamped from the policy's default treatment).`, { record: { id: policy.id, name: policy.name }, object: "TaxPolicy" });
    else act({ id: "update-policy", group: "update", object: "TaxPolicy", recordId: policy.id, title: `Update Tax Policy "${policy.name}"`,
      detail: [pUpdate.TreatmentSelection ? `Treatment Selection ${policy.selection ?? "—"} → Default (the order product's Tax Treatment is stamped from the policy's default treatment)` : null, pUpdate.DefaultTaxTreatmentId ? `Default Tax Treatment → "${treatment.name}"` : null].filter(Boolean).join(" · "),
      operation: { key: "update-policy", op: "update", object: "TaxPolicy", target: { id: policy.id }, fields: pUpdate } });
  } else reuse.push({ object: "TaxPolicy", id: policy.id, name: policy.name, detail: `${policy.status ?? "—"} · Default selection · default "${treatment.name}"` });
  if (policy.status !== "Active" && !blocked.length && !blockedConfig) act({ id: "activate-policy", group: "activate", object: "TaxPolicy", recordId: policy.id, title: `Activate Tax Policy "${policy.name}"`, detail: `${policy.status ?? "—"} → Active (after its default treatment is Active)`, operation: { key: "activate-policy", op: "activate", object: "TaxPolicy", target: { id: policy.id } } });

  /* engine / decision table reuse */
  if (eng.e && eng.t) reuse.push({ object: "TaxEngine", id: eng.e.id, name: eng.e.name, detail: `${eng.e.status ?? "—"} · decision table ${eng.t.name}` });
  if (eng.t && !eng.t.inputs.includes("TaxCode")) block("DECISION_TABLE_NO_TAXCODE", 6, "Decision table has no TaxCode input", `Decision table ${eng.t.name} has no TaxCode input, so rates can't be matched by tax code. Adding a column is a Salesforce Setup change (Lookup Tables) — the app doesn't modify decision-table definitions.`, { record: { id: eng.t.id, name: eng.t.name }, object: "DecisionTable" });

  /* 5 · geography */
  if (!rawCountry) ask("country", `Which country (and province/state) is the sale to? Give the customer account, or the country${country ? "" : " (e.g. \"in Ontario, Canada\")"}.`);
  else if (!country) {
    const isoGuess = /^[A-Za-z]{2}$/.test(rawCountry.trim()) ? rawCountry.trim().toUpperCase() : null;
    block("GEOCOUNTRY_MISSING", 2, "Country isn't configured for tax", `No GeoCountry for "${rawCountry}" exists in this org — rates are keyed by GeoCountry.`, { object: "GeoCountry", key: rawCountry,
      options: isoGuess && can.create("GeoCountry") ? [{ id: "create-geocountry", kind: "create", label: `Create GeoCountry ${isoGuess}`, rationale: "No GeoCountry with this ISO code exists (duplicates are re-checked before the write).", supported: true,
        steps: [{ id: "create-geocountry", group: "config", title: `Create GeoCountry ${isoGuess}`, object: "GeoCountry", recordId: null, operation: { key: "create-geocountry", op: "create", object: "GeoCountry", fields: { Name: isoGuess, IsoCode: isoGuess } }, changes: [{ field: "IsoCode", value: isoGuess }] }],
        records: [{ role: "create", object: "GeoCountry", id: null, name: isoGuess }], reversible: false }] : [unsupported("explain", "Give the ISO code", `Re-run the request with the country's 2-letter ISO code${can.create("GeoCountry") ? " — the GeoCountry can then be created here" : "; your user can't create GeoCountry records"}.`)] });
  } else reuse.push({ object: "GeoCountry", id: s.geoCountries.find(c => c.iso === country.iso)!.id, name: country.name, detail: `ISO ${country.iso}` });
  let stateStep: string | null = null;
  if (rawState && country) {
    if (geoStateId) reuse.push({ object: "GeoState", id: geoStateId, name: stateName ?? stateIso ?? rawState, detail: `ISO ${stateIso}` });
    else if (stateIso && !req.account) stateStep = act({ id: "create-geostate", group: "create", object: "GeoState", recordId: null, title: `Create GeoState ${stateName ?? stateIso} (${stateIso})`, detail: `under ${country.name} · ISO ${stateIso}`,
      operation: { key: "create-geostate", op: "create", object: "GeoState", fields: { Name: stateName ?? stateIso, IsoCode: stateIso, GeoCountryId: { id: s.geoCountries.find(c => c.iso === country.iso)!.id } } } });
    // (A state taken from the account is the account's to fix — reported above; asking here couldn't change it.)
    else if (!stateIso && !req.account) ask("state", `"${rawState}" isn't a known state/province of ${country.name} — give its ISO code.`);
  }

  /* 6 · rate — exactly one RevCloud rate must match; none → create (with the user's rate, code, basis); several → choose */
  let expectedRate: { rate: number; taxCode: string | null; basis: string | null } | null = null;
  let rateStep: string | null = null;
  if (country && taxCode && legalEntityId && rateRes && !jurisdictionDiag) {
    const r = rateRes;
    if (r.outcome === "single" && r.selected) {
      const x = r.selected;
      reuse.push({ object: "TaxRate", id: x.id, name: x.name, detail: `${x.taxCode} ${x.rate ?? "?"}% · ${x.basis ?? "—"} · ${x.countryIso ?? "—"}${x.stateIso ? `/${x.stateIso}` : ""} · ProductCode ${x.productCode ?? "any"}` });
      if (x.rate !== null) expectedRate = { rate: x.rate, taxCode: x.taxCode, basis: x.basis };
      if (req.rate !== null && req.rate !== undefined && x.rate !== null && req.rate !== x.rate) notes.push(`The existing matching rate ${x.name} is ${x.rate}%, not the requested ${req.rate}% — it isn't changed (replace it explicitly if intended).`);
      if (x.basis && x.basis !== "Net") {
        notes.push(`Rate ${x.name} uses Application Basis "${x.basis}" — only Net has been verified to produce InvoiceLineTax in this org.`);
        diagnose({ code: "RATE_BASIS_UNVERIFIED", severity: "warning", stage: 5, title: "Rate uses an unverified application basis", cause: `Rate ${x.name} uses ${x.basis}; only Net has produced InvoiceLineTax in this org. The calculation can proceed — the result is verified from Salesforce.`, record: { id: x.id, name: x.name }, object: "TaxRate", blocks: false });
      }
    } else if (r.outcome === "multiple") {
      const yesterday = new Date(Date.parse(effectiveDate) - 86_400_000).toISOString().slice(0, 10);
      block("RATE_AMBIGUOUS", 5, "Several tax rates match", `${r.candidates.length} ${REVENUE_CLOUD_RATE_USAGE} rates match (${r.candidates.map(c => `${c.rate.name} ${c.rate.rate ?? "?"}%`).join(", ")}) — Salesforce reports Multiple Matches and applies no tax. Choose which one to end-date; none is picked automatically.`, { object: "TaxRate", key: `${taxCode}:${country.iso}`,
        evidence: r.candidates.map(c => `${c.rate.name}: ${c.rate.taxCode} ${c.rate.rate ?? "?"}% · ${c.rate.countryIso ?? "—"}${c.rate.stateIso ? `/${c.rate.stateIso}` : ""} · ProductCode ${c.rate.productCode ?? "any"} · ${c.rate.start ?? "…"} → ${c.rate.end ?? "open"}`),
        options: r.candidates.map(c => ({ id: `end-date:${c.rate.id}`, kind: "end-date" as const, label: `End-date ${c.rate.name} (${c.rate.rate ?? "?"}%) on ${yesterday}`, rationale: `Keeps the other matching rate; ${c.rate.name} stops matching from ${effectiveDate}. Choose only if ${c.rate.name} is the wrong one.`,
          supported: can.update("TaxRate", "EndDate"), unsupportedReason: can.update("TaxRate", "EndDate") ? null : "Your user can't edit TaxRate.EndDate.",
          steps: [{ id: `end-date:${c.rate.id}`, group: "config" as const, title: `End-date ${c.rate.name}`, object: "TaxRate", recordId: c.rate.id, operation: { key: `end-date-${c.rate.id}`, op: "end-date" as const, object: "TaxRate", target: { id: c.rate.id }, date: yesterday }, changes: [{ field: "EndDate", value: yesterday }] },
            ...(usable(treatment.engineId).t ? [{ id: "refresh", group: "refresh" as const, title: "Refresh the decision table", object: "DecisionTable", recordId: usable(treatment.engineId).t!.id, operation: null, refresh: { engineId: treatment.engineId!, decisionTableId: usable(treatment.engineId).t!.id }, changes: [] }] : [])],
          records: [{ role: "end-date" as const, object: "TaxRate", id: c.rate.id, name: c.rate.name }], consequences: [`${c.rate.name} no longer applies to any transaction dated after ${yesterday}.`], reversible: true })) });
    } else {
      if (req.rate === null || req.rate === undefined) ask("rate", `No ${REVENUE_CLOUD_RATE_USAGE} tax rate for ${taxCode} matches ${[stateIso, country.iso].filter(Boolean).join(", ")}${p.code ? ` / ${p.code}` : ""}. What is the rate (%)?`);
      if (!req.basis) ask("basis", "Which application basis should the new rate use — Net (the basis verified in this org) or Gross?", [{ value: "Net", label: "Net" }, { value: "Gross", label: "Gross" }]);
      if ((!rawState || stateIso) && req.rate !== null && req.rate !== undefined && req.basis) {
        const geoCountryId = s.geoCountries.find(c => c.iso === country.iso)!.id;
        rateStep = act({ id: "create-rate", group: "create", object: "TaxRate", recordId: null,
          title: `Create Tax Rate ${taxCode} ${req.rate}% for ${[stateIso, country.iso].filter(Boolean).join("/")}`,
          detail: `${REVENUE_CLOUD_RATE_USAGE} · ${req.basis} · ProductCode ${p.code ?? "(blank — matches every product with this tax code)"} · legal entity ${s.legalEntities.find(l => same(l.id, legalEntityId))?.name ?? legalEntityId} · from ${effectiveDate}`,
          operation: { key: "create-rate", op: "create", object: "TaxRate", fields: {
            TaxCode: taxCode, Rate: req.rate, GeoCountryId: { id: geoCountryId }, ...(stateIso ? { GeoStateId: stateStep ? { name: stateName ?? stateIso } : { id: geoStateId } } : {}),
            ...(p.code ? { ProductCode: p.code } : {}), LegalEntityId: { id: legalEntityId }, RateUsageType: REVENUE_CLOUD_RATE_USAGE, ApplicationBasis: req.basis, StartDate: effectiveDate,
          } } });
        expectedRate = { rate: req.rate, taxCode, basis: req.basis };
        const nm = r.nearMisses.find(n => n.rate.taxCode === taxCode && n.rate.countryIso && n.rate.countryIso !== country.iso);
        if (nm) notes.push(`Tax code ${taxCode} is also used by ${nm.rate.name} (${nm.rate.countryIso}) — that rate is never reused for ${country.name}.`);
      }
    }
  }

  /* 7 · decision-table refresh — after a rate change, or when it is already stale (its own approval) */
  if (eng.e && eng.t && (rateStep || eng.t.stale)) act({ id: "refresh", group: "refresh", object: "DecisionTable", recordId: eng.t.id, title: `Refresh decision table ${eng.t.name}`,
    detail: rateStep ? "Salesforce matches rates only after the table is refreshed. Separately approved; it affects every engine that shares the table." : "The table is older than the newest Tax Rate change. Separately approved; it affects every engine that shares the table.",
    operation: null, refresh: { engineId: eng.e.id, decisionTableId: eng.t.id } });

  /* 8 · customer account */
  if (req.accountNotFound) ask("account", `Account "${req.accountNotFound}" doesn't exist in the connected org. Which customer account is the sale for?`, f.accounts.map(a => ({ value: a.name, label: `${a.name} · ${[a.state, a.country].filter(Boolean).join(", ")}` })));
  else if (!req.account) {
    if (f.accounts.length) ask("account", `Which customer account is the sale for? Salesforce bills the order to an account with a Bill To contact${country ? ` (accounts with a ${country.iso} billing address are listed)` : ""}.`, f.accounts.map(a => ({ value: a.name, label: `${a.name} · ${[a.state, a.country].filter(Boolean).join(", ")}` })));
    else if (country) block("NO_ACCOUNT_IN_JURISDICTION", 1, "No customer account in this jurisdiction", `No Account with a ${[stateIso, country.iso].filter(Boolean).join("/")} billing address exists. Create one with a Contact (Accounts) using ISO codes (country "${country.iso}"${stateIso ? `, state "${stateIso}"` : ""}) — the tax workflow doesn't create customers.`, { object: "Account", key: `${country.iso}:${stateIso ?? ""}` });
    else ask("account", "Which customer account is the sale for?");
  } else reuse.push({ object: "Account", id: req.account.id, name: req.account.name, detail: [req.account.state, req.account.country].filter(Boolean).join(", ") });

  void replacementDiag;
  return finish({ access: f.access, product: p, jurisdiction, reuse, actions, duplicates, notes, questions, blocked, dx, expected: expectedRate, summary: "", req, listPrice: f.listPrice });
}

/* ───────────── Option builders (reused by several diagnostics) ───────────── */

type Snap = PlanFacts["snapshot"];
type Can = ReturnType<typeof capabilityChecks>;
function unsupported(id: string, label: string, reason: string): ResolutionOption {
  return { id, kind: "unsupported", label, rationale: reason, supported: false, unsupportedReason: reason, steps: [], records: [], reversible: true };
}

/** Describe-based capability checks (true when the access map wasn't read — the assistant preview re-checks before any write). */
export function capabilityChecks(access: PlanFacts["access"]) {
  return {
    create: (o: string) => !access || !!access[o]?.createable,
    update: (o: string, field: string) => !access || (!!access[o]?.updateable && access[o].fields[field]?.updateable !== false),
  };
}

/** Link the product to an existing policy (Product2.TaxPolicyId) — reuse, nothing created. */
function linkPolicyOption(p: NonNullable<PlanFacts["product"]>, policy: Snap["policies"][number], can: Can, rationale: string): ResolutionOption {
  const ok = can.update("Product2", "TaxPolicyId");
  return { id: `link-policy:${policy.id}`, kind: "link", label: `Use the existing policy "${policy.name}" for ${p.name}`, rationale, supported: ok, unsupportedReason: ok ? null : "Your user can't edit Product2.TaxPolicyId.",
    steps: [{ id: "link-policy", group: "link", title: `Set ${p.name}'s Tax Policy → "${policy.name}"`, object: "Product2", recordId: p.id, operation: { key: "link-policy", op: "update", object: "Product2", target: { id: p.id }, fields: { TaxPolicyId: { id: policy.id } } }, changes: [{ field: "TaxPolicyId", value: `${policy.name} (${policy.id})` }] }],
    records: [{ role: "reuse", object: "TaxPolicy", id: policy.id, name: policy.name }, { role: "update", object: "Product2", id: p.id, name: p.name }],
    consequences: [`${p.name} is taxed under "${policy.name}" for every future order (existing orders keep their stamped treatment).`, "Reversible by setting the product's previous Tax Policy back."], reversible: true };
}

/**
 * A NEW treatment under the policy (replacement for a locked one, or the policy's first) — Draft with the Legal Entity, engine and tax
 * code, its product item when the treatment uses items, then activation, then (replacement) the policy default. State-aware: when the
 * Draft replacement already exists (an earlier approved step), it is reused and only the remaining steps are listed.
 */
function newTreatmentOption(a: { id: string; policy: Snap["policies"][number]; product: NonNullable<PlanFacts["product"]>; replacing: Snap["treatments"][number] | null; item: Snap["items"][number] | null; taxCode: string | null; legalEntity: Snap["legalEntities"][number] | null; engine: Snap["engines"][number] | null; snapshot: Snap; can: Can; effectiveDate: string }): ResolutionOption {
  const { policy, product: p, replacing: old, snapshot: s } = a;
  const useItems = old?.useItems ?? false;
  const inputs: ResolutionInput[] = [];
  if (!a.legalEntity) inputs.push({ field: "legalEntity", question: "Which legal entity should the new treatment use?", options: s.legalEntities.filter(l => !l.status || l.status === "Active").map(l => ({ value: l.id, label: l.name })) });
  if (!a.engine) inputs.push({ field: "engine", question: "Which Active tax engine (with a TaxCode decision table) should it use?" });
  if (!a.taxCode) inputs.push({ field: "taxCode", question: "Which tax code should the new treatment apply?" });
  const name = `${old ? old.name : `${p.name} Tax Treatment`}${a.legalEntity ? ` · ${a.legalEntity.name}` : ""}`.slice(0, 80);
  const existing = s.treatments.find(t => same(t.policyId, policy.id) && t.name.toLowerCase() === name.toLowerCase());
  const canCreate = a.can.create("TaxTreatment") && (!useItems || a.can.create("TaxTreatmentItem"));
  const label = old ? `Create a replacement treatment "${name}"` : `Create treatment "${name}"`;
  if (inputs.length) return { id: a.id, kind: "create", label, rationale: "Needs the details below first (never assumed).", supported: canCreate, unsupportedReason: canCreate ? null : "Your user can't create Tax Treatment records.", steps: [], inputs, records: [], reversible: true };
  if (existing && existing.status === "Active" && !old) return unsupported(a.id, label, `A treatment named "${name}" already exists under "${policy.name}" — reuse it instead of creating a duplicate.`);
  const sel = existing ? { id: existing.id } : { name, policyName: policy.name };
  const steps: RemediationStep[] = [];
  if (!existing) {
    steps.push({ id: "create-treatment", group: "config", title: `Create Draft Tax Treatment "${name}"`, object: "TaxTreatment", recordId: null,
      operation: { key: "create-treatment", op: "create", object: "TaxTreatment", fields: { Name: name, TaxPolicyId: { id: policy.id }, IsTaxable: true, TaxEngineId: { id: a.engine!.id }, LegalEntityId: { id: a.legalEntity!.id }, ShouldUseTaxTreatmentItems: useItems, ...(useItems ? {} : { TaxCode: a.taxCode }) } },
      changes: [{ field: "Name", value: name }, { field: "TaxPolicyId", value: policy.name }, { field: "LegalEntityId", value: a.legalEntity!.name }, { field: "TaxEngineId", value: a.engine!.name }, ...(useItems ? [{ field: "ShouldUseTaxTreatmentItems", value: "true" }] : [{ field: "TaxCode", value: a.taxCode! }])] });
  }
  const hasItem = existing && s.items.some(i => same(i.treatmentId, existing.id) && same(i.productId, p.id));
  if (useItems && !hasItem) steps.push({ id: "create-item", group: "config", title: `Create Tax Treatment Item for ${p.name}`, object: "TaxTreatmentItem", recordId: null,
    operation: { key: "create-item", op: "create", object: "TaxTreatmentItem", fields: { Name: `${p.name} ${a.taxCode}`.slice(0, 80), TaxTreatmentId: existing ? { id: existing.id } : { name, policyName: policy.name }, ProductId: { id: p.id }, TaxCode: a.taxCode, ...((a.item?.productCode ?? p.code) ? { ProductCode: a.item?.productCode ?? p.code } : {}) } },
    changes: [{ field: "TaxCode", value: a.taxCode ?? "—" }, { field: "ProductCode", value: a.item?.productCode ?? p.code ?? "—" }] });
  if (!existing || existing.status !== "Active") steps.push({ id: "activate-treatment", group: "activation", title: `Activate "${name}"`, object: "TaxTreatment", recordId: existing?.id ?? null, operation: { key: "activate-treatment", op: "activate", object: "TaxTreatment", target: sel }, changes: [{ field: "Status", value: "Active" }] });
  if (old || !same(policy.defaultTreatmentId, existing?.id)) steps.push({ id: "set-default", group: "link", title: `Set "${policy.name}" default treatment → "${name}"`, object: "TaxPolicy", recordId: policy.id, operation: { key: "set-default", op: "update", object: "TaxPolicy", target: { id: policy.id }, fields: { DefaultTaxTreatmentId: sel } }, changes: [{ field: "DefaultTaxTreatmentId", value: name }] });
  return { id: a.id, kind: "create", label, rationale: old ? `"${old.name}" can't be edited after leaving Draft. The replacement copies its policy and tax code with the Legal Entity "${a.legalEntity!.name}" and engine "${a.engine!.name}"; it is created as Draft, activated after its dependencies, then made the policy's default.` : `Creates the policy's treatment with the Legal Entity, engine and tax code.`,
    supported: canCreate, unsupportedReason: canCreate ? null : "Your user can't create Tax Treatment (or Tax Treatment Item) records.", steps,
    records: [{ role: "create", object: "TaxTreatment", id: existing?.id ?? null, name }, ...(useItems ? [{ role: "create" as const, object: "TaxTreatmentItem", id: null, name: `${p.name} ${a.taxCode}` }] : []), { role: "update", object: "TaxPolicy", id: policy.id, name: policy.name }],
    consequences: [old ? `"${old.name}" is NOT deactivated, deleted or changed — it simply stops being the policy's default.` : "", `Every product on "${policy.name}" (${policy.products}) uses the new treatment once it is the default.`].filter(Boolean), reversible: true };
}

/**
 * A NEW, COMPLETE tax configuration for a product without a policy — previewed record by record BEFORE any approval, with every
 * value's source; values that can't be resolved unambiguously from the org (tax code, rate, basis, a choice between legal entities or
 * engines) are marked REQUIRED and asked for, never invented. Steps exist only once nothing is missing:
 *   [config]  Draft policy (Default selection) + Draft treatment (Legal Entity, an existing usable engine, the tax code) + the rate
 *             (reused when one already matches this product and jurisdiction)
 *   [link]    the policy's default treatment + the product's Tax Policy
 *   next      activation of treatment and policy and the decision-table refresh — the regular plan's own, separately approved steps.
 * State-aware: records created by an earlier approved step are reused, never duplicated.
 */
function newConfigurationOption(a: { product: NonNullable<PlanFacts["product"]>; req: PlanRequest; snapshot: Snap; tables: PlanFacts["tables"]; can: Can; effectiveDate: string; rates: RRRate[];
  jurisdiction: { iso: string; name: string; geoCountryId: string; stateIso: string | null; stateName: string | null; geoStateId: string | null; stateGiven: boolean } | null }): ResolutionOption {
  const { product: p, req, snapshot: s, can, jurisdiction: j } = a;
  const les = s.legalEntities.filter(l => !l.status || l.status === "Active");
  const le = req.legalEntityId ? les.find(l => same(l.id, req.legalEntityId)) ?? null : les.length === 1 ? les[0] : null;
  const usableEngines = s.engines.filter(e => e.status === "Active" && e.native && e.decisionTableId && a.tables[e.decisionTableId]?.inputs.includes("TaxCode"));
  const ranked = usableEngines.map(e => ({ e, n: s.treatments.filter(t => same(t.engineId, e.id) && t.status === "Active" && t.taxable).length })).sort((x, y) => y.n - x.n);
  const engine = req.engineId ? usableEngines.find(e => same(e.id, req.engineId)) ?? null : ranked.length === 1 || (ranked.length > 1 && ranked[0].n > ranked[1].n) ? ranked[0].e : null;
  const taxCode = req.taxCode ?? null;
  const rate = req.rate ?? null, basis = req.basis ?? null;
  const tableInputs = engine?.decisionTableId ? a.tables[engine.decisionTableId]?.inputs ?? null : null;
  const match = taxCode && j && le ? resolveTaxRate(a.rates, { taxCode, countryIso: j.iso, stateIso: j.stateIso, city: null, zipCode: null, productCode: p.code, legalEntityId: le.id, effectiveDate: a.effectiveDate, rateUsageType: REVENUE_CLOUD_RATE_USAGE, applicationBasis: null }, tableInputs) : null;
  const existingRate = match?.outcome === "single" ? match.selected : null;
  const ambiguousRates = match?.outcome === "multiple" ? match.candidates.map(c => c.rate.name) : [];
  const stateMissing = !!j?.stateGiven && !j.geoStateId;
  const codesHere = [...new Set(s.rates.filter(r => !j || r.country === j.iso).map(r => r.taxCode).filter((c): c is string => !!c))].slice(0, 12);

  const inputs: ResolutionInput[] = [];
  if (!j) inputs.push({ field: "country", question: "Country (and state/province) of the sale — REQUIRED for the tax rate" });
  if (!taxCode) inputs.push({ field: "taxCode", question: `Tax code for ${p.name}${j ? ` in ${j.name}` : ""} — REQUIRED (an existing code, or a new one)`, options: codesHere.map(c => ({ value: c, label: `${c} (existing code)` })) });
  if (!le) inputs.push({ field: "legalEntity", question: "Legal entity that sells it — REQUIRED", options: les.map(l => ({ value: l.id, label: l.name })) });
  if (!engine) inputs.push({ field: "engine", question: "Tax engine (Active, with a TaxCode decision table) — REQUIRED", options: usableEngines.map(e => ({ value: e.id, label: e.name })) });
  if (!existingRate && rate === null) inputs.push({ field: "rate", question: "Tax rate (%) — REQUIRED (never assumed)" });
  if (!existingRate && !basis) inputs.push({ field: "basis", question: "Application basis — REQUIRED", options: [{ value: "Net", label: "Net (verified in this org)" }, { value: "Gross", label: "Gross" }] });

  const polName = `${p.name} Tax Policy${taxCode ? ` (${taxCode})` : ""}`.slice(0, 80), trName = `${p.name} ${taxCode ?? "<tax code>"} Taxable${le ? ` · ${le.name}` : ""}`.slice(0, 80);
  const pol = taxCode ? s.policies.find(x => x.name.toLowerCase() === polName.toLowerCase()) ?? null : null;
  const tr = pol ? s.treatments.find(t => same(t.policyId, pol.id) && t.name.toLowerCase() === trName.toLowerCase()) ?? null : null;
  const v = (value: string | null | undefined, source?: string) => ({ value: value ?? null, required: !value, source: value ? source ?? null : "REQUIRED — not supplied" });
  const where = j ? [j.stateIso, j.iso].filter(Boolean).join("/") : "<jurisdiction>";
  const proposal: ProposedRecord[] = [
    { object: "TaxPolicy", action: pol ? "reuse" : "create", name: taxCode ? polName : `${p.name} Tax Policy (<tax code>)`, recordId: pol?.id ?? null, when: "this approval", fields: [
      { field: "Name", value: taxCode ? polName : `${p.name} Tax Policy (<tax code>)`, required: false, source: taxCode ? "derived from the product and tax code" : "derived — completed by the tax code below" },
      { field: "TreatmentSelection", ...v("Default", "the order product's treatment is stamped from the policy's default treatment") },
      { field: "Status", ...v("Draft", "Salesforce's initial status — activated in a separate approval") }] },
    { object: "TaxTreatment", action: tr ? "reuse" : "create", name: trName, recordId: tr?.id ?? null, when: "this approval", fields: [
      { field: "IsTaxable", ...v("true", "a taxable treatment") },
      { field: "TaxCode", ...v(taxCode) },
      { field: "LegalEntityId", ...v(le?.name, req.legalEntityId ? "your choice" : "the org's only active legal entity") },
      { field: "TaxEngineId", ...v(engine?.name, req.engineId ? "your choice" : "the existing Active engine with a TaxCode decision table") },
      { field: "ShouldUseTaxTreatmentItems", ...v("false", "the treatment carries the tax code — no Tax Treatment Item is needed") },
      { field: "Status", ...v("Draft", "activated in a separate approval") }] },
    existingRate
      ? { object: "TaxRate", action: "reuse", name: existingRate.name, recordId: existingRate.id, when: "this approval", fields: [{ field: "Rate", value: `${existingRate.rate ?? "?"}% ${existingRate.basis ?? ""}`, required: false, source: "already matches this product and jurisdiction" }] }
      : { object: "TaxRate", action: "create", name: `${taxCode ?? "<tax code>"} ${rate ?? "?"}% · ${where}`, when: "this approval", fields: [
          { field: "TaxCode", ...v(taxCode) }, { field: "Rate", ...v(rate === null ? null : `${rate}%`) }, { field: "ApplicationBasis", ...v(basis) },
          { field: "GeoCountryId", ...v(j ? `${j.name} (${j.iso})` : null, "the customer's billing country") },
          ...(j?.stateGiven ? [{ field: "GeoStateId", ...v(j.geoStateId ? `${j.stateName ?? j.stateIso} (${j.stateIso})` : null, "the customer's billing state") }] : []),
          { field: "ProductCode", ...v(p.code, "the product's ProductCode — what Salesforce matches") },
          { field: "LegalEntityId", ...v(le?.name) }, { field: "RateUsageType", ...v("RevCloud", "the usage type Revenue Cloud Billing invoices are matched with") },
          { field: "StartDate", ...v(a.effectiveDate, "the calculation date (today)") }] },
    { object: "TaxPolicy", action: "link", name: `${polName} → default "${trName}"`, recordId: pol?.id ?? null, when: "this approval", fields: [{ field: "DefaultTaxTreatmentId", ...v(trName, "the new treatment") }] },
    { object: "Product2", action: "link", name: `${p.name} → "${polName}"`, recordId: p.id, when: "this approval", fields: [{ field: "TaxPolicyId", ...v(polName, "the new policy") }] },
    { object: "TaxTreatment", action: "activate", name: trName, when: "next approval", fields: [{ field: "Status", value: "Active", required: false, source: "separate approval after creation" }] },
    { object: "TaxPolicy", action: "activate", name: polName, when: "next approval", fields: [{ field: "Status", value: "Active", required: false, source: "separate approval, after its treatment is Active" }] },
    { object: "DecisionTable", action: "refresh", name: engine?.decisionTableId ? a.tables[engine.decisionTableId]?.name ?? "the engine's decision table" : "the engine's decision table", when: "next approval", fields: [{ field: "Refresh", value: existingRate ? "only if stale" : "after the new rate", required: false, source: "separate approval" }] },
  ];
  const supported = can.create("TaxPolicy") && can.create("TaxTreatment") && can.update("Product2", "TaxPolicyId") && (existingRate !== null || can.create("TaxRate")) && usableEngines.length > 0 && les.length > 0;
  const why = !usableEngines.length ? "No Active Revenue Standard Tax engine with a TaxCode decision table exists — an administrator must set one up first." : !les.length ? "This org has no active Legal Entity." : "Your user can't create tax policies, treatments or rates, or edit Product2.TaxPolicyId.";
  const label = `Create a tax configuration for ${p.name}`;
  const base = { id: "create-tax-configuration", kind: "create" as const, label, proposal, reversible: true,
    records: proposal.filter(r => r.when === "this approval").map(r => ({ role: (r.action === "link" ? "update" : r.action) as ResolutionOption["records"][number]["role"], object: r.object, id: r.recordId ?? null, name: r.name })),
    consequences: [`${p.name} points at a Draft policy until it is activated — its orders are blocked by the tax readiness gate until then.`, "Nothing existing is changed or deactivated."] };
  if (!supported) return { ...base, rationale: why, supported: false, unsupportedReason: why, steps: [] };
  if (stateMissing) return { ...base, rationale: `The customer's state "${j!.stateName ?? j!.stateIso}" has no GeoState — resolve the geography first.`, supported: false, unsupportedReason: "The jurisdiction's GeoState is missing.", steps: [] };
  if (ambiguousRates.length) return { ...base, rationale: `Rates ${ambiguousRates.join(", ")} already match ${taxCode} in ${where} — Salesforce would report Multiple Matches. Resolve that conflict first (no further rate is created).`, supported: false, unsupportedReason: "Existing rates conflict for this tax code and jurisdiction.", steps: [] };
  if (inputs.length) return { ...base, rationale: "Every proposed record is shown below. Values marked REQUIRED must be supplied first (never assumed); then the steps can be approved.", supported: true, steps: [], inputs };
  const polSel = pol ? { id: pol.id } : { name: polName };
  const trSel = tr ? { id: tr.id } : { name: trName, policyName: polName };
  const steps: RemediationStep[] = [];
  if (!pol) steps.push({ id: "create-policy", group: "config", title: `Create Draft Tax Policy "${polName}"`, object: "TaxPolicy", recordId: null, operation: { key: "create-policy", op: "create", object: "TaxPolicy", fields: { Name: polName, TreatmentSelection: "Default" } }, changes: [{ field: "Name", value: polName }, { field: "TreatmentSelection", value: "Default" }] });
  if (!tr) steps.push({ id: "create-treatment", group: "config", title: `Create Draft Tax Treatment "${trName}"`, object: "TaxTreatment", recordId: null,
    operation: { key: "create-treatment", op: "create", object: "TaxTreatment", fields: { Name: trName, TaxPolicyId: polSel, IsTaxable: true, TaxEngineId: { id: engine!.id }, LegalEntityId: { id: le!.id }, TaxCode: taxCode, ShouldUseTaxTreatmentItems: false } },
    changes: [{ field: "Name", value: trName }, { field: "TaxCode", value: taxCode! }, { field: "LegalEntityId", value: le!.name }, { field: "TaxEngineId", value: engine!.name }] });
  if (!existingRate) steps.push({ id: "create-rate", group: "config", title: `Create Tax Rate ${taxCode} ${rate}% for ${where}`, object: "TaxRate", recordId: null,
    operation: { key: "create-rate", op: "create", object: "TaxRate", fields: { TaxCode: taxCode, Rate: rate, GeoCountryId: { id: j!.geoCountryId }, ...(j!.geoStateId ? { GeoStateId: { id: j!.geoStateId } } : {}), ...(p.code ? { ProductCode: p.code } : {}), LegalEntityId: { id: le!.id }, RateUsageType: REVENUE_CLOUD_RATE_USAGE, ApplicationBasis: basis, StartDate: a.effectiveDate } },
    changes: [{ field: "Rate", value: `${rate}%` }, { field: "ApplicationBasis", value: basis! }, { field: "Jurisdiction", value: where }, { field: "StartDate", value: a.effectiveDate }] });
  if (!pol || !same(pol.defaultTreatmentId, tr?.id)) steps.push({ id: "set-default", group: "link", title: `Set "${polName}" default treatment → "${trName}"`, object: "TaxPolicy", recordId: pol?.id ?? null, operation: { key: "set-default", op: "update", object: "TaxPolicy", target: polSel, fields: { DefaultTaxTreatmentId: trSel } }, changes: [{ field: "DefaultTaxTreatmentId", value: trName }] });
  steps.push({ id: "link-policy", group: "link", title: `Set ${p.name}'s Tax Policy → "${polName}"`, object: "Product2", recordId: p.id, operation: { key: "link-policy", op: "update", object: "Product2", target: { id: p.id }, fields: { TaxPolicyId: polSel } }, changes: [{ field: "TaxPolicyId", value: polName }] });
  return { ...base, rationale: `Creates only what's missing (policy, treatment${existingRate ? `; reuses rate ${existingRate.name}` : ", rate"}) with the values shown, then links them to ${p.name}. Activation and the decision-table refresh follow as separate approvals.`, supported: true, steps };
}

/** Plan actions → structured diagnostics (each action is one issue with one recommended, approvable option). */
const ACTION_DIAG: Record<string, { code: string; stage: TaxDiagnosticItem["stage"]; title: string; kind: ResolutionKind; group: RemediationStep["group"] }> = {
  "update-treatment": { code: "TREATMENT_DRAFT_INCOMPLETE", stage: 3, title: "Draft treatment is missing required values", kind: "update", group: "config" },
  "create-item": { code: "TREATMENT_ITEM_MISSING", stage: 4, title: "No Tax Treatment Item for the product", kind: "create", group: "config" },
  "update-item": { code: "TREATMENT_ITEM_TAX_CODE_MISSING", stage: 4, title: "Tax Treatment Item has no tax code", kind: "update", group: "config" },
  "activate-treatment": { code: "TREATMENT_NOT_ACTIVE", stage: 3, title: "Tax treatment isn't Active", kind: "activate", group: "activation" },
  "update-policy": { code: "POLICY_DEFAULT_NOT_SET", stage: 3, title: "Tax policy doesn't point to the treatment", kind: "update", group: "link" },
  "activate-policy": { code: "POLICY_NOT_ACTIVE", stage: 3, title: "Tax policy isn't Active", kind: "activate", group: "activation" },
  "create-geostate": { code: "GEOSTATE_MISSING", stage: 2, title: "State/province isn't configured for tax", kind: "create", group: "config" },
  "create-rate": { code: "RATE_MISSING", stage: 5, title: "No tax rate matches the transaction", kind: "create", group: "config" },
  "refresh": { code: "DECISION_TABLE_REFRESH_REQUIRED", stage: 6, title: "Decision table must be refreshed", kind: "refresh", group: "refresh" },
};
function actionDiagnostics(actions: PlanAction[], can: Can): TaxDiagnosticItem[] {
  // Describe-based: an operation your user can't perform is shown as unsupported (no button), never attempted.
  const denied = (a: PlanAction): string | null => {
    const op = a.operation;
    if (!op) return null;
    if (op.op === "create") return can.create(op.object) ? null : `Your user can't create ${op.object} records.`;
    if (op.op === "activate") return can.update(op.object, "Status") ? null : `Your user can't change ${op.object}.Status.`;
    const bad = Object.keys(op.fields ?? {}).filter(k => !can.update(op.object, k));
    return bad.length ? `Your user can't edit ${bad.map(k => `${op.object}.${k}`).join(", ")}.` : null;
  };
  const idOf = (a: PlanAction) => `${ACTION_DIAG[a.id]?.code ?? a.id}:${a.recordId ?? a.id}`;
  return actions.map(a => {
    const m = ACTION_DIAG[a.id] ?? { code: a.id.toUpperCase(), stage: 3 as const, title: a.title, kind: "update" as const, group: "config" as const };
    const step: RemediationStep = { id: a.id, group: m.group, title: a.title, object: a.object, recordId: a.recordId, operation: a.operation, refresh: a.refresh ?? null, changes: [{ field: "Proposed change", value: a.detail }] };
    const no = denied(a);
    const option: ResolutionOption = { id: a.id, kind: m.kind, label: a.title, rationale: a.detail, supported: !no, unsupportedReason: no, steps: no ? [] : [step], records: [{ role: m.kind === "create" ? "create" : m.kind === "activate" ? "activate" : "update", object: a.object, id: a.recordId, name: a.title }], reversible: m.kind !== "refresh" };
    return { id: idOf(a), code: m.code, severity: "blocker" as const, stage: m.stage, title: m.title, object: a.object, record: a.recordId ? { id: a.recordId, name: a.title } : null, cause: a.detail, evidence: [],
      blocksCalculation: true, options: [option], recommendedOptionId: option.id, recommendation: `${a.title} — ${a.detail}`, dependsOn: a.dependsOn.map(d => { const x = actions.find(y => y.id === d); return x ? idOf(x) : d; }), expected: "Re-reading Salesforce shows the record in the required state." };
  });
}

function finish(x: { access?: PlanFacts["access"]; product: PlanFacts["product"]; jurisdiction: CalculationPlan["jurisdiction"]; reuse: PlanRecord[]; actions: PlanAction[]; duplicates: string[]; notes: string[]; questions: PlanQuestion[]; blocked: string[]; dx: TaxDiagnosticItem[]; expected: { rate: number; taxCode: string | null; basis: string | null } | null; summary: string; req: PlanRequest; listPrice: number | null }): CalculationPlan {
  const qty = x.req.quantity ?? 1;
  const price = x.req.unitPrice ?? x.listPrice ?? null;
  const taxable = price !== null ? round2(qty * price) : null;
  const expected = x.expected ? { ...x.expected, taxableAmount: taxable, taxAmount: taxable !== null ? round2(taxable * x.expected.rate / 100) : null, note: "Expected/reference amount — NOT a Salesforce calculation. Only Salesforce's InvoiceLineTax is the tax." } : null;
  // Activations lock fields (LegalEntityId, ProductCode…) and a refresh is only useful once the rate exists: while details are still
  // open, only the Draft updates are offered — the activation and refresh steps appear once every question is answered.
  // (The customer account doesn't change the configuration, so that question alone holds nothing back.)
  if (x.questions.some(q => q.field !== "account") && x.actions.some(a => a.group === "activate" || a.group === "refresh")) {
    x.actions = x.actions.filter(a => a.group !== "activate" && a.group !== "refresh").map(a => ({ ...a, dependsOn: a.dependsOn.filter(d => x.actions.some(y => y.id === d && y.group !== "activate" && y.group !== "refresh")) }));
    x.notes.push("Activation and decision-table refresh steps are listed once the details above are answered (activating locks fields such as the Legal Entity).");
  }
  const diagnostics = rankDiagnostics([...x.dx, ...actionDiagnostics(x.actions, capabilityChecks(x.access))]);
  const status: CalculationPlan["status"] = x.blocked.length ? "BLOCKED" : x.questions.length ? "NEEDS_INPUT" : x.actions.length ? "NEEDS_CONFIGURATION" : "READY_TO_CALCULATE";
  const summary = x.summary || (status === "READY_TO_CALCULATE" ? `${x.product?.name ?? "The product"}'s tax configuration is complete — Salesforce can calculate its tax on a Draft invoice (each billing step is confirmed separately).`
    : status === "NEEDS_CONFIGURATION" ? `${x.actions.length} configuration step(s) reuse the existing records; approve each one separately, then calculate.`
    : status === "NEEDS_INPUT" ? `${x.questions.length} detail(s) are needed before the plan can be completed — nothing is assumed.`
    : (() => { const top = diagnostics.filter(d => d.blocksCalculation && !d.code.startsWith("INPUT_")); return `Blocked: ${top[0]?.title ?? x.blocked[0]}${top.length > 1 ? ` (+${top.length - 1} more issue${top.length > 2 ? "s" : ""} below)` : ""}.`; })());
  return {
    status, summary, product: x.product ? { id: x.product.id, name: x.product.name, code: x.product.code } : null, jurisdiction: x.jurisdiction,
    reuse: x.reuse, actions: x.actions,
    transaction: [
      { step: "create-order", label: "Create the Draft order", detail: "Order + Order Product with the policy's default Tax Treatment stamped (confirmed separately)." },
      { step: "activate", label: "Activate the order", detail: "After the tax readiness gate passes (confirmed separately)." },
      { step: "schedules", label: "Create the billing schedule", detail: "Salesforce copies the Tax Treatment to the schedule (confirmed separately)." },
      { step: "generate-invoice", label: "Generate the Draft invoice", detail: "Salesforce's tax engine runs at invoice time (confirmed separately; the invoice stays Draft — it is never posted here)." },
      { step: "verify", label: "Verify InvoiceLineTax", detail: "Read the invoice, its lines and InvoiceLineTax from Salesforce (read-only)." },
    ],
    expected, duplicates: x.duplicates, notes: x.notes, questions: x.questions, blocked: x.blocked,
    diagnostics, version: planVersion(diagnostics),
  };
}

/** Read-only: the facts for a product's calculation plan. */
export async function loadCalculationPlan(client: SalesforceClient, product: { id?: string | null; name?: string | null }, req: PlanRequest): Promise<CalculationPlan> {
  const meta = await discoverTaxMetadata(client);
  const v = meta.apiVersion;
  const q = (soql: string) => queryAt(client, v, soql);
  const snap = await loadSnapshot(client, meta);
  const cols = ["Id", "Name", "ProductCode", "IsActive", ...(objectMeta(meta, "Product2")?.fields.TaxPolicyId ? ["TaxPolicyId"] : [])].join(", ");
  const term = (product.name ?? "").trim();
  const rows = product.id ? await q(`SELECT ${cols} FROM Product2 WHERE Id = '${soqlEscape(product.id)}'`) : term ? await q(`SELECT ${cols} FROM Product2 WHERE Name = '${soqlEscape(term)}' OR ProductCode = '${soqlEscape(term)}' ORDER BY IsActive DESC LIMIT 5`) : [];
  const active = rows.filter(r => r.IsActive === true);
  const pr = active.length === 1 ? active[0] : rows.length === 1 ? rows[0] : null;
  const productMessage = pr ? null : !rows.length ? `No Salesforce product ${product.id ? `has Id ${product.id}` : `is named or coded "${term}"`} — give the exact product name, ProductCode or Product2 Id.` : `"${term}" matches ${active.length} active products (${active.map(r => `${r.Name} [${r.ProductCode ?? "—"}]`).join(", ")}) — give the ProductCode or Id.`;
  const geoStates = objectMeta(meta, "GeoState") ? (await q("SELECT Id, Name, IsoCode, GeoCountry.IsoCode FROM GeoState ORDER BY Name LIMIT 2000")).map(r => ({ id: String(r.Id), name: String(r.Name ?? r.IsoCode), iso: String(r.IsoCode ?? "").toUpperCase(), countryIso: str((r.GeoCountry as Record<string, unknown> | null)?.IsoCode)?.toUpperCase() ?? null })) : [];
  const tables: PlanFacts["tables"] = {};
  for (const e of snap.engines.filter(x => x.decisionTableId)) {
    if (tables[e.decisionTableId!]) continue;
    const dt = await readStandardTax(client, v, snap, e.id);
    if (dt) tables[e.decisionTableId!] = { id: dt.id, name: dt.name, inputs: dt.inputs.map(i => i.field), stale: dt.stale };
  }
  const iso = (req.account?.country ?? req.country ?? "").trim();
  const c = iso ? snap.geoCountries.find(g => g.iso === iso.toUpperCase() || g.name.toLowerCase() === iso.toLowerCase()) : null;
  const accounts = c && !req.account ? (await q(`SELECT Id, Name, BillingCountry, BillingState FROM Account WHERE BillingCountry IN ('${soqlEscape(c.iso)}', '${soqlEscape(c.name)}') ORDER BY LastModifiedDate DESC LIMIT 10`)).map(a => ({ id: String(a.Id), name: String(a.Name), country: str(a.BillingCountry), state: str(a.BillingState) })) : [];
  const [price] = pr ? await q(`SELECT UnitPrice FROM PricebookEntry WHERE Product2Id = '${soqlEscape(String(pr.Id))}' AND Pricebook2.IsStandard = true AND IsActive = true LIMIT 1`).catch(() => []) : [];
  // Describe-based access for the objects a remediation may write (createable / updateable per object and field).
  const access: NonNullable<PlanFacts["access"]> = {};
  for (const o of ["TaxTreatment", "TaxTreatmentItem", "TaxPolicy", "TaxRate", "GeoCountry", "GeoState", "Product2", "TaxEngine"]) {
    const m = objectMeta(meta, o);
    if (m) access[o] = { createable: m.createable, updateable: m.updateable, fields: Object.fromEntries(Object.values(m.fields).map(x => [x.name, { createable: x.createable, updateable: x.updateable }])) };
  }
  // Billing prerequisites of the resolved product (a failed read is reported as unreadable — never as "nothing configured").
  let billing: PlanFacts["billing"] = null;
  if (pr) {
    const pid = soqlEscape(String(pr.Id));
    try {
      const [bp] = await q(`SELECT BillingPolicyId FROM Product2 WHERE Id = '${pid}'`);
      const policies = await q("SELECT Id, Name, Status FROM BillingPolicy ORDER BY Name LIMIT 50");
      const [stdPb] = await q("SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1");
      const pbes = await q(`SELECT Id, UnitPrice, IsActive, Pricebook2.IsStandard, ProductSellingModelId, ProductSellingModel.Name FROM PricebookEntry WHERE Product2Id = '${pid}'`);
      const psmo = await q(`SELECT ProductSellingModelId, ProductSellingModel.Name, ProductSellingModel.SellingModelType FROM ProductSellingModelOption WHERE Product2Id = '${pid}'`);
      const rel = (r: Record<string, unknown>, k: string, f: string) => str((r[k] as Record<string, unknown> | null)?.[f]);
      billing = {
        productBillingPolicyId: str(bp?.BillingPolicyId),
        billingPolicies: policies.map(r => ({ id: String(r.Id), name: String(r.Name), status: str(r.Status) })),
        standardPricebookId: str(stdPb?.Id),
        priceEntries: pbes.map(r => ({ id: String(r.Id), unitPrice: typeof r.UnitPrice === "number" ? r.UnitPrice : null, active: r.IsActive === true, standard: (r.Pricebook2 as Record<string, unknown> | null)?.IsStandard === true, sellingModelId: str(r.ProductSellingModelId), sellingModelName: rel(r, "ProductSellingModel", "Name") })),
        sellingModels: psmo.map(r => ({ id: String(r.ProductSellingModelId), name: rel(r, "ProductSellingModel", "Name") ?? String(r.ProductSellingModelId), type: rel(r, "ProductSellingModel", "SellingModelType") })),
      };
    } catch (e) { billing = { unreadable: `The product's billing configuration couldn't be read: ${e instanceof Error ? e.message : String(e)}`, productBillingPolicyId: null, billingPolicies: [], standardPricebookId: null, priceEntries: [], sellingModels: [] }; }
  }
  let taxAdmin: PlanFacts["taxAdmin"] = null;
  try { const t = await getTaxAdminStatus(client); taxAdmin = { status: t.status, canAssign: t.canAssign, message: t.message, adminInstruction: t.adminInstruction }; } catch { taxAdmin = null; }
  return buildCalculationPlan({
    billing, taxAdmin,
    access,
    productCandidates: pr ? [] : (active.length > 1 ? active : rows.length ? rows : term ? await q(`SELECT Id, Name, ProductCode FROM Product2 WHERE IsActive = true AND (Name LIKE '%${soqlEscape(term)}%' OR ProductCode LIKE '%${soqlEscape(term)}%') ORDER BY Name LIMIT 8`) : []).map(r => ({ id: String(r.Id), name: String(r.Name), code: str(r.ProductCode) })),
    product: pr ? { id: String(pr.Id), name: String(pr.Name), code: str(pr.ProductCode), active: pr.IsActive === true, taxPolicyId: str(pr.TaxPolicyId) } : null,
    productMessage, snapshot: snap, geoStates, tables, accounts, listPrice: typeof price?.UnitPrice === "number" ? price.UnitPrice : null,
  }, req);
}
