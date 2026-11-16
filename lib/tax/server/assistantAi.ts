import type { SalesforceClient } from "@/lib/salesforce/client";
import { discoverTaxMetadata, objectMeta } from "@/lib/tax/server/metadata";
import { interpretTaxConfigPrompt, type Extract as ExtractFn, type Interpretation } from "@/lib/tax/server/ai";
import { mapFieldKeys, orgApiFor, previewOperations, type TaxOrgApi } from "@/lib/tax/server/operations";
import { buildFormDraft } from "@/lib/tax/server/formDraft";
import type { TaxFormDraft } from "@/lib/taxes/formDraft";
import type { AssistantOpKind, AssistantOperation, AssistantPreview, RecordSelector, TaxMetadata } from "@/lib/tax/types";

/**
 * AI PROMPT → assistant operations. The system prompt is grounded with the CONNECTED org's tax metadata (objects, writable fields,
 * picklist values, lookup targets) so the model can only name fields that exist; it returns names, never Ids. A whole new tax
 * setup ("Create an 18% GST configuration for Laptop") is delegated to the existing configuration interpreter/planner.
 * Everything the model returns is re-validated against metadata and resolved in Salesforce by previewOperations — nothing is written.
 */

const OBJECTS = ["TaxPolicy", "TaxTreatment", "TaxTreatmentItem", "TaxRate", "GeoCountry", "GeoState", "TaxEngine", "Product2", "LegalEntity"];
const OPS: AssistantOpKind[] = ["create", "update", "assign", "activate", "deactivate", "draft", "end-date", "replace", "delete", "show", "configure"];
const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/** Compact, metadata-derived description of the objects the assistant can address. */
export function metadataBrief(meta: TaxMetadata): string {
  return OBJECTS.map(name => {
    const o = objectMeta(meta, name);
    if (!o) return `${name}: (not available in this org)`;
    const fields = Object.values(o.fields).filter(f => (f.createable || f.updateable || f.nameField) && !["OwnerId"].includes(f.name)).slice(0, name === "Product2" ? 0 : 40)
      .map(f => `${f.name}${f.type === "reference" ? `→${f.referenceTo.join("/")}` : f.picklist.length ? `[${f.picklist.map(p => p.value).join("|")}]` : `:${f.type}`}${f.createable && !f.updateable ? "(create-only)" : ""}`);
    return `${name} (${o.label}): ${name === "Product2" ? "Name, ProductCode, TaxPolicyId→TaxPolicy" : fields.join(", ")}`;
  }).join("\n");
}

export function assistantSystemPrompt(meta: TaxMetadata): string {
  return `You are a Salesforce Revenue Cloud TAX CONFIGURATION assistant. Convert the user's request into JSON operations.
Return ONLY one JSON object: {"isTaxRequest": boolean, "operations": [Operation], "notes": string[]}
Operation = {"op": "${OPS.join('" | "')}", "object": ObjectApiName, "target": Selector | null, "fields": {FieldApiName: value} | null,
  "relation": {"object": ObjectApiName, "target": Selector, "kind": "default" | null, "field": FieldApiName | null} | null, "date": "YYYY-MM-DD" | null}
Selector = {"name": string | null, "taxCode": string | null, "rate": number | null, "country": string | null, "isoCode": string | null, "productName": string | null, "treatmentName": string | null, "policyName": string | null}

Objects and fields in THIS org (FieldApiName→LookupTarget, [picklist values], (create-only)):
${metadataBrief(meta)}

Rules:
- FIRST decide the operation from the user's verb: create/add/new → create; assign/map/link/relate/attach, or "set/make X (as) the default …" → assign; update/change/edit/modify/rename/set → update; delete/remove → delete; show/view/describe → show; activate; deactivate; end-date/expire; replace.
- assign and update are about EXISTING records: name them in "target"/"relation" and put ONLY the changed fields — never use create (or configure) for them, and never repeat the record's other fields (name, treatment selection, status, …).
  e.g. "Assign 'Cloud Storage GST Treatment' as the default treatment for 'Cloud Storage GST Policy'" → op assign, object TaxTreatment, target {"name":"Cloud Storage GST Treatment"}, relation {"object":"TaxPolicy","target":{"name":"Cloud Storage GST Policy"},"kind":"default"}.
- create ONE record (a tax policy, treatment, treatment item, rate, country, state or engine) → op create on that object with its values in "fields" — not configure.
  e.g. "Create a tax treatment item named 'Cloud Storage GST Item' under 'Cloud Storage GST Treatment' for product 'Cloud Storage Pro'" → op create, object TaxTreatmentItem, fields {"Name":"Cloud Storage GST Item","TaxTreatmentId":"Cloud Storage GST Treatment","ProductId":"Cloud Storage Pro"}. TaxCode/ProductCode only if the user gives them.
  A tax rate: include every dimension the user gives (country, state, city, zip code, product code, legal entity, usage type, application basis, start/end dates).
- NEVER output Salesforce Ids. Identify records by the names/codes the user wrote (copy them exactly).
- Use only the objects and field API names listed above, and only listed picklist values. Never invent a field.
- Lookup field values are names: {"TaxPolicyId": "Laptop GST Policy"} or a Selector.
- create: "fields" holds the new record's values. update/edit/change/rename/set: "target" + the changed "fields" only.
- assign/map/relate/link/attach/set-as-default: "object"+"target" is the record being assigned, "relation" the record it's assigned to; kind "default" when the user says default. Leave "relation.field" null unless the user names the field.
  e.g. "Assign Product A to Policy X" → op assign, object Product2, target {"name":"Product A"}, relation {"object":"TaxPolicy","target":{"name":"Policy X"}}.
  e.g. "Make GST 18 Taxable the default treatment of Policy X" → op assign, object TaxTreatment, relation {"object":"TaxPolicy", ..., "kind":"default"}.
- activate / deactivate / draft (set to Draft): lifecycle status changes — ONLY when the user explicitly asks for that status change. Never for conditional instructions ("if it is Active …", "explain the lifecycle steps instead"): the system plans any required lifecycle step itself from the record's current status. "Enable/disable/turn on/turn off <a field>" is an update of that field (e.g. "Enable Use Tax Treatment Items" → update fields {"ShouldUseTaxTreatmentItems": true}), not activate/deactivate.
- activate / deactivate / draft: end-date (expire/stop on a date): put the date in "date". replace: a tax rate's tax code/country/state changes from a date (fields + date).
- delete/remove: only the exact record the user names.
- show/view/describe/"what is the current configuration": op show.
- ONLY a request to set up a whole NEW tax configuration (policy + treatment + rates for products, e.g. "Create an 18% GST tax configuration for Product A") → ONE operation {"op":"configure","object":"TaxPolicy"} — it is handled by the configuration planner.
- Rates are percentages (18% → 18). Dates are YYYY-MM-DD; "today" stays null.
- Several requests in one message → several operations, in the order they must happen.
- isTaxRequest=false if it isn't about tax configuration. Anything you couldn't map goes in "notes".`;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 255) : null);

function selector(v: unknown): RecordSelector | null {
  if (typeof v === "string") return SFID.test(v.trim()) ? null : { name: str(v) };
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const s: RecordSelector = {
    name: str(o.name), taxCode: str(o.taxCode), country: str(o.country), isoCode: str(o.isoCode), productName: str(o.productName), treatmentName: str(o.treatmentName), policyName: str(o.policyName),
    rate: typeof o.rate === "number" && Number.isFinite(o.rate) ? o.rate : null,
  };
  return Object.values(s).some(x => x !== null) ? s : null;
}

/** Normalize the model's output: known ops/objects only, Ids dropped, lookup values reduced to names/selectors. */
export function operationsFromAi(out: Record<string, unknown>): { operations: AssistantOperation[]; warnings: string[] } {
  const warnings: string[] = Array.isArray(out.notes) ? out.notes.filter((n): n is string => typeof n === "string" && !!n.trim()) : [];
  const raw = Array.isArray(out.operations) ? (out.operations as Record<string, unknown>[]) : [];
  let droppedIds = false;
  const operations: AssistantOperation[] = [];
  for (const [i, r] of raw.slice(0, 15).entries()) {
    const op = String(r.op ?? "").toLowerCase().replace(/[_\s]/g, "-") as AssistantOpKind;
    const object = String(r.object ?? "");
    if (!OPS.includes(op)) { warnings.push(`Ignored an operation of unknown type "${r.op}".`); continue; }
    if (!OBJECTS.includes(object) && op !== "configure") { warnings.push(`Ignored an operation on "${object}" — not a tax object this assistant manages.`); continue; }
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((r.fields as Record<string, unknown> | null) ?? {})) {
      if (k === "Id") { droppedIds = true; continue; }
      if (typeof v === "string" && SFID.test(v.trim()) && /Id$/.test(k)) { droppedIds = true; continue; }
      fields[k] = v && typeof v === "object" ? selector(v) : v;
    }
    const target = selector(r.target);
    if (r.target && typeof r.target === "object" && (r.target as Record<string, unknown>).id) droppedIds = true;
    const rel = r.relation as Record<string, unknown> | null | undefined;
    operations.push({
      key: `op${i + 1}`, op, object: object || "TaxPolicy", target,
      fields: Object.keys(fields).length ? fields : null,
      relation: rel && typeof rel === "object" && OBJECTS.includes(String(rel.object)) ? { object: String(rel.object), target: selector(rel.target) ?? {}, kind: str(rel.kind), field: str(rel.field) } : null,
      date: typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null,
    });
  }
  if (droppedIds) warnings.push("Ignored Salesforce Ids in the AI output — records are resolved by name in Salesforce.");
  return { operations, warnings };
}

/* ───────────────────────────── Operation routing (deterministic, around the AI) ───────────────────────────── */

const QUOTE_CHARS = `"'“”‘’`;
const Q = `[${QUOTE_CHARS}]([^${QUOTE_CHARS}]{1,120})[${QUOTE_CHARS}]`;

/**
 * The operation the user asked for, from the verb that comes first. Quoted record names are ignored (a policy called "Create
 * Draft Policy" doesn't make an assignment a CREATE); "set/make X (as) the default …" is an assignment, not an update.
 */
export function classifyIntent(prompt: string): AssistantOpKind | null {
  const p = ` ${prompt.replace(new RegExp(Q, "g"), " Q ").toLowerCase()} `;
  const rules: [AssistantOpKind, RegExp][] = [
    ["assign", /\b(assign|map|link|relate|attach|associate)\b/],
    ["assign", /\b(set|make|mark|use)\b(?=[^.]*\bdefault\b)/],
    ["update", /\b(enable|disable|turn on|turn off|switch on|switch off)\b/],
    ["deactivate", /\b(deactivate|inactivate)\b/],
    ["activate", /\bactivate\b/],
    ["end-date", /\b(end[- ]?date|expire)\b/],
    ["replace", /\breplace\b/],
    ["delete", /\b(delete|remove)\b/],
    ["show", /\b(show|view|display|describe|list|what is|what's|whats)\b/],
    ["create", /\b(create|add|new|set ?up|define)\b/],
    ["update", /\b(update|change|edit|modify|rename|set)\b/],
    ["draft", /\b(back to draft|set to draft|move to draft)\b/],
  ];
  let best: { op: AssistantOpKind; at: number } | null = null;
  for (const [op, re] of rules) { const m = re.exec(p); if (m && (!best || m.index < best.at)) best = { op, at: m.index }; }
  return best?.op ?? null;
}

/** Deterministic parse of the common assignment phrasings (quoted names only) — used when the AI didn't produce an assignment. */
export function parseAssignPrompt(prompt: string): AssistantOperation | null {
  const pol = String.raw`(?:the\s+)?(?:tax\s+)?(?:policy\s+)?`;
  let m = new RegExp(String.raw`\b(?:assign|set|make|mark|map|use)\s+(?:the\s+)?(?:tax\s+)?(?:treatment\s+)?${Q}\s+(?:as\s+)?(?:the\s+)?default\s+(?:tax\s+)?treatment\s+(?:for|of|on|in|to)\s+${pol}${Q}`, "i").exec(prompt);
  if (m) return { key: "op1", op: "assign", object: "TaxTreatment", target: { name: m[1].trim() }, relation: { object: "TaxPolicy", target: { name: m[2].trim() }, kind: "default" } };
  m = new RegExp(String.raw`\b(?:set|change|update)\s+(?:the\s+)?default\s+(?:tax\s+)?treatment\s+(?:of|for|on)\s+${pol}${Q}\s+to\s+(?:the\s+)?(?:tax\s+)?(?:treatment\s+)?${Q}`, "i").exec(prompt);
  if (m) return { key: "op1", op: "assign", object: "TaxTreatment", target: { name: m[2].trim() }, relation: { object: "TaxPolicy", target: { name: m[1].trim() }, kind: "default" } };
  m = new RegExp(String.raw`\b(?:assign|map|link|attach)\s+(?:the\s+)?(product|treatment|tax\s+treatment)\s+${Q}\s+to\s+(?:the\s+)?(?:tax\s+)?policy\s+${Q}`, "i").exec(prompt);
  if (m) return { key: "op1", op: "assign", object: /product/i.test(m[1]) ? "Product2" : "TaxTreatment", target: { name: m[2].trim() }, relation: { object: "TaxPolicy", target: { name: m[3].trim() } } };
  return null;
}

/**
 * Make the AI's operations match the user's intent: an assignment/update never becomes a CREATE or a whole new configuration.
 * A "create" of a record the user only named (e.g. create TaxPolicy {Name, DefaultTaxTreatmentId}) becomes a change to that
 * existing record — for an assignment only its relationship fields are kept, so nothing else is required from the user.
 */
/**
 * The status changes the user EXPLICITLY asked for. Conditional sentences ("If the treatment is Active …", "… instead of forcing
 * the update", "explain the required lifecycle steps") describe what to do in a situation — they are not requests.
 */
export function requestedLifecycle(prompt: string): Set<"activate" | "deactivate" | "draft"> {
  const out = new Set<"activate" | "deactivate" | "draft">();
  const clauses = prompt.replace(new RegExp(Q, "g"), " Q ").split(/(?<=[.;!?])\s+|\n+/);
  for (const raw of clauses) {
    const c = raw.trim().toLowerCase();
    if (!c || /^(if|when|whenever|unless|in case|otherwise|should)\b/.test(c) || /\b(instead of|explain|lifecycle steps)\b/.test(c)) continue;
    if (/\b(re-?activate|activate)\b/.test(c)) out.add("activate");
    if (/\b(deactivate|inactivate)\b/.test(c)) out.add("deactivate");
    if (/\b(back to draft|set (it )?to draft|move (it )?to draft)\b/.test(c)) out.add("draft");
  }
  return out;
}

export function reconcileOperations(meta: TaxMetadata, intent: AssistantOpKind | null, operations: AssistantOperation[], prompt: string): { operations: AssistantOperation[]; warnings: string[] } {
  const warnings: string[] = [];
  let ops = operations;
  // Lifecycle operations the user didn't explicitly ask for are dropped — any lifecycle step Salesforce requires is planned (and
  // explained) by the operations layer from the record's current status, never guessed from conditional instructions.
  const asked = requestedLifecycle(prompt);
  const unrequested = ops.filter(o => (o.op === "activate" || o.op === "deactivate" || o.op === "draft") && !asked.has(o.op));
  if (unrequested.length && ops.some(o => !unrequested.includes(o))) {
    ops = ops.filter(o => !unrequested.includes(o));
    warnings.push(`Not changing the status (${unrequested.map(o => o.op).join(", ")}): you didn't ask for it — any lifecycle step Salesforce requires is shown in the preview.`);
  }
  if (intent && intent !== "create" && ops.some(o => o.op === "configure")) {
    ops = ops.filter(o => o.op !== "configure");
    warnings.push(`This request is ${intent === "assign" ? "an assignment" : `a ${intent}`} on existing records, not a new configuration — no configuration is created.`);
  }
  if (intent === "assign" || intent === "update") {
    ops = ops.map(o => {
      if (o.op !== "create") return o;
      const om = objectMeta(meta, o.object);
      if (!om) return o;
      const nf = Object.values(om.fields).find(f => f.nameField)?.name ?? "Name";
      const { mapped } = mapFieldKeys(meta, o.object, o.fields ?? {});
      const name = typeof mapped[nf] === "string" ? (mapped[nf] as string) : o.target?.name ?? null;
      if (!name) return o;
      const rest = Object.entries(mapped).filter(([k]) => k !== nf);
      const keep = intent === "assign" ? rest.filter(([k]) => om.fields[k]?.type === "reference") : rest;
      const dropped = rest.filter(([k]) => !keep.some(([x]) => x === k)).map(([k]) => k);
      warnings.push(`Treated "create ${om.label} ${name}" as a change to the existing record (${intent}).${dropped.length ? ` Not changed: ${dropped.join(", ")}.` : ""}`);
      return { key: o.key, op: "update" as const, object: o.object, target: { name }, fields: Object.fromEntries(keep), date: o.date ?? null };
    });
  }
  if (intent === "assign" && !ops.some(o => o.op === "assign" || (o.op === "update" && Object.keys(o.fields ?? {}).length))) {
    const parsed = parseAssignPrompt(prompt);
    if (parsed) { ops = [parsed, ...ops.filter(o => o.op !== "create" && o.op !== "update")]; warnings.push("Read the assignment directly from your request."); }
  }
  return { operations: ops.map((o, i) => ({ ...o, key: o.key || `op${i + 1}` })), warnings };
}

export type AssistantInterpretation =
  | { success: false; requiresInput: boolean; message: string; extraction: Record<string, unknown> }
  | { success: true; mode: "operations"; operations: AssistantOperation[]; warnings: string[]; extraction: Record<string, unknown>; preview: AssistantPreview }
  | { success: true; mode: "configure"; configuration: Extract<Interpretation, { success: true }> }
  | { success: true; mode: "form"; object: string; draft: TaxFormDraft; extraction: Record<string, unknown> };

/** A tax object this assistant manages (for the optional page context), else null. */
export const assistantObject = (name: unknown): string | null => (typeof name === "string" && OBJECTS.includes(name) ? name : null);

/** Page context: the request was typed on one object's create page (e.g. Taxes → Tax Treatment Items → Create). */
export function pageContextPrompt(meta: TaxMetadata, object: string): string {
  const label = objectMeta(meta, object)?.label ?? object;
  return `\n\nContext: the user typed this on the "${label}" create page. Unless the request clearly asks for another operation or object, it is ONE op create on ${object} (never configure).`;
}

/**
 * Create-page FORM mode: only the one record of the page's object is extracted, into the form the user then edits, validates and
 * creates. Other operations the model proposed are reported, never previewed or applied; the model's free-text notes are not shown
 * as warnings — only the deterministic checks of the record being created are.
 */
export async function interpretForForm(api: TaxOrgApi, object: string, out: Record<string, unknown>, prompt: string): Promise<AssistantInterpretation> {
  const label = objectMeta(api.meta, object)?.label ?? object;
  const { operations } = operationsFromAi(out);
  const createOp = operations.find(o => o.op === "create" && o.object === object) ?? null;
  const others = operations.filter(o => o !== createOp);
  const draft = await buildFormDraft(api, object, createOp, prompt);
  if (others.length) draft.notices.push(`Only the ${label} is filled in here — not applied: ${others.map(o => `${o.op} ${o.object}`).join(", ")}.`);
  if (!Object.keys(draft.fields).length && !Object.keys(draft.references).length && !Object.keys(draft.unresolved).length) {
    return { success: false, requiresInput: true, message: `No ${label} values found in the request. Give them as e.g. "Name: …", "TaxTreatment: …", "Product: …", "TaxCode: …".`, extraction: out };
  }
  return { success: true, mode: "form", object, draft, extraction: out };
}

export async function interpretAssistantPrompt(client: SalesforceClient, extract: ExtractFn, prompt: string, opts: { object?: string | null; form?: boolean } = {}): Promise<AssistantInterpretation> {
  const meta = await discoverTaxMetadata(client);
  const pageObject = assistantObject(opts.object);
  const out = await extract(assistantSystemPrompt(meta) + (pageObject ? pageContextPrompt(meta, pageObject) : ""), prompt);
  if (opts.form && pageObject) return interpretForForm(await orgApiFor(client), pageObject, out, prompt);
  if (out.isTaxRequest === false) return { success: false, requiresInput: false, message: "This doesn't look like a tax configuration request. Try e.g. \"Show me the current configuration of Laptop GST Policy\" or \"Activate GST 18 Taxable\".", extraction: out };
  const intent = classifyIntent(prompt);
  const fromAi = operationsFromAi(out);
  const routed = reconcileOperations(meta, intent, fromAi.operations, prompt);
  const warnings = [...fromAi.warnings, ...routed.warnings];
  let operations = routed.operations;
  // A whole new configuration goes to the configuration planner only when that is ALL the request is.
  if (operations.length && operations.every(o => o.op === "configure")) {
    if (pageObject) return { success: false, requiresInput: true, message: `This page creates one ${objectMeta(meta, pageObject)?.label ?? pageObject}. For a whole new tax configuration (policy, treatments and rates together) use Taxes → Configure.`, extraction: out };
    const configuration = await interpretTaxConfigPrompt(client, extract, prompt);
    if (!configuration.success) return { ...configuration };
    return { success: true, mode: "configure", configuration };
  }
  operations = operations.filter(o => o.op !== "configure");
  if (!operations.length) return { success: false, requiresInput: true, message: `Say what to do and with which record — e.g. "Change the rate of GST18 to 12%", "Assign Product A to Policy X".${warnings.length ? ` (${warnings.join(" ")})` : ""}`, extraction: out };
  const preview = await previewOperations(client, { operations });
  return { success: true, mode: "operations", operations, warnings, extraction: out, preview };
}
