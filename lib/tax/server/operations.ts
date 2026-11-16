import { createHash } from "node:crypto";
import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { apiUrl, describeAt, queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata, objectMeta, picklistValue, selectable } from "@/lib/tax/server/metadata";
import { getTaxConnection, idList, readGeoCountries, resolveProductRef, type ProductResolution } from "@/lib/tax/server/records";
import { resolveCountry } from "@/lib/tax/server/country";
import { errorField, recommendationFor } from "@/lib/tax/server/errors";
import { executeRateReplacement, previewRateReplacement, type RateReplacementInput, type RateReplacementPreview, type RateReplacementResult } from "@/lib/tax/server/rateReplace";
import { getBillingModule } from "@/lib/billing/registry";
import { evaluateTaxRateRules, overlappingRates } from "@/lib/tax/server/rateRules";
import { TAX_MODULES } from "@/lib/taxes/modules";
import type {
  AssistantOperation, AssistantPreview, AssistantRequest, AssistantResult, AuditEntry, FieldMeta, GeoCountryRow, OpChange, OpPreview, OpStep, PlanIssue, RecordSelector, TaxConnection, TaxMetadata,
} from "@/lib/tax/types";

/**
 * TAX CONFIGURATION ASSISTANT — operations on existing and new tax records: CREATE, UPDATE, ASSIGN (relate), lifecycle
 * (activate / deactivate / draft / end-date / replace), DELETE and SHOW. Extends the tax metadata, record and rate-replacement
 * services; whole multi-record configurations still go through the planner/executor (plan.ts / execute.ts).
 *
 *  · Every lookup goes natural-language name → Salesforce record → Salesforce Id. Exact matches only; several matches become a
 *    choice for the user; none is "record not found" with suggestions. A name is never sent where an Id is required.
 *  · Before CREATE, existing records are compared on the object's identifying dimensions (DUPLICATE_RULES, plus describe
 *    `unique` fields; for Tax Rates every geography/product/entity/usage dimension and effective-date overlap). Only a real
 *    conflict is reported as "already exists" — with the existing record and follow-up actions.
 *  · ASSIGN and UPDATE resolve the existing records and change only the requested fields; they never validate a create payload.
 *    The relationship field comes from describe `referenceTo` — never a hard-coded field — and ambiguous ones are refused.
 *  · Create-only TaxRate fields (TaxCode, GeoCountryId, GeoStateId) become a previewed replacement rate; other create-only fields
 *    are refused with the reason. Lifecycle (verified): TaxTreatment Draft → Active; TaxPolicy Draft → default treatment (Active)
 *    → Active, as SEPARATE requests. Nothing runs without the user's confirmation of the exact preview (token), and every change
 *    is re-read afterwards.
 *  · Never touched: InvoiceLineTax, decision tables, lookup tables, Tax Engine Providers, Billing settings.
 */

/** Objects the assistant may change, and how. Product2 only through its tax relationship; Legal Entities are only looked up. */
const SUPPORTED: Record<string, { create: boolean; update: boolean; delete: boolean; onlyFields?: string[] }> = {
  TaxPolicy: { create: true, update: true, delete: true },
  TaxTreatment: { create: true, update: true, delete: true },
  TaxTreatmentItem: { create: true, update: true, delete: true },
  TaxRate: { create: true, update: true, delete: true },
  GeoCountry: { create: true, update: true, delete: true },
  GeoState: { create: true, update: true, delete: true },
  TaxEngine: { create: true, update: true, delete: true },
  Product2: { create: false, update: true, delete: false, onlyFields: ["TaxPolicyId"] },
  LegalEntity: { create: false, update: false, delete: false },
};

/**
 * Duplicate prevention — which existing record IS the record being created. Salesforce doesn't mark these fields `unique`, so
 * these are the identifying dimensions (fields describe marks `unique` are checked in addition). A field missing from the org's
 * metadata is skipped. Values compare null-equal (an empty dimension only matches an empty one).
 *  · TaxRate: two rates conflict only when EVERY dimension is the same AND their effective dates overlap — a different state,
 *    city, zip, product code, legal entity, usage type, application basis or a non-overlapping period is a distinct rate.
 *  · TaxTreatmentItem: Salesforce itself allows one item per product in a treatment (verified: DUPLICATE_VALUE "A tax treatment
 *    item already exists for this product"). Sharing only the treatment, or only the product, is not a duplicate.
 *  · TaxTreatment: the same name within a policy, or — Salesforce's own rule (verified: DUPLICATE_VALUE "Tax Treatment with
 *    TaxCode …, TaxPolicyId …, TaxEngineId …, LegalEntity …, ProductCode … already exists") — the same tax code + policy + engine
 *    + legal entity + product code, whatever the name.
 * An object can have several rules; matching any one is a conflict.
 */
export interface DuplicateRule { keys: string[]; effectiveDates?: boolean; reason?: string }
export const DUPLICATE_RULES: Record<string, DuplicateRule[]> = {
  TaxPolicy: [{ keys: ["Name"] }],
  TaxEngine: [{ keys: ["TaxEngineName"] }],
  TaxTreatment: [
    { keys: ["Name", "TaxPolicyId"] },
    { keys: ["TaxCode", "TaxPolicyId", "TaxEngineId", "LegalEntityId", "ProductCode"], reason: "Salesforce allows only one Tax Treatment per tax code + policy + tax engine + legal entity + product code (DUPLICATE_VALUE), whatever its name." },
  ],
  TaxTreatmentItem: [{ keys: ["TaxTreatmentId", "ProductId"], reason: "Salesforce allows only one Tax Treatment Item per product in a treatment (\"A tax treatment item already exists for this product\")." }],
  TaxRate: [{ keys: ["TaxCode", "GeoCountryId", "GeoStateId", "City", "ZipCode", "ProductCode", "LegalEntityId", "RateUsageType", "ApplicationBasis"], effectiveDates: true }],
  GeoCountry: [{ keys: ["IsoCode"] }],
  GeoState: [{ keys: ["GeoCountryId", "IsoCode"] }],
};

/**
 * Status lifecycle rules Salesforce enforces (verified in p10, 2026-10-07). The planner works from the record's CURRENT status and
 * never adds a status change that isn't needed or wasn't asked for.
 *  · TaxTreatment: Active → Draft and Inactive → Draft are refused ("Can't change status from Active to Draft"); Active ⇄ Inactive
 *    and Draft → Active are allowed. While Active, Use Tax Treatment Items and Product Code can't be edited ("Can't edit Use Tax
 *    Treatment Items while status is Active"); while Draft or Inactive they can.
 */
export const STATUS_RULES: Record<string, { forbidden: [string, string][]; lockedWhileActive: string[] }> = {
  TaxTreatment: { forbidden: [["Active", "Draft"], ["Inactive", "Draft"]], lockedWhileActive: ["ShouldUseTaxTreatmentItems", "ProductCode"] },
};

const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const isRef = (v: unknown): v is string => typeof v === "string" && v.startsWith("@{");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const moduleOf = (object: string) => TAX_MODULES.find(m => m.candidates[0] === object) ?? null;

/* ───────────────────────────── Salesforce access (injectable for tests) ───────────────────────────── */

/** Everything the assistant needs from the connected org. `orgApiFor` binds it to the session's client at the org's API version. */
export interface TaxOrgApi {
  meta: TaxMetadata;
  query(soql: string): Promise<Record<string, unknown>[]>;
  describe(object: string): Promise<Record<string, unknown> | null>;
  connection(): Promise<TaxConnection>;
  resolveProduct(name: string): Promise<ProductResolution>;
  geoCountries(): Promise<GeoCountryRow[]>;
  write(method: "POST" | "PATCH" | "DELETE", object: string, id: string | null, body: Record<string, unknown> | null): Promise<{ status: number; statusText?: string; json: unknown }>;
  previewRateReplacement(input: RateReplacementInput): Promise<RateReplacementPreview>;
  executeRateReplacement(input: RateReplacementInput, token: string | null): Promise<RateReplacementResult>;
}

export async function orgApiFor(client: SalesforceClient): Promise<TaxOrgApi> {
  const meta = await discoverTaxMetadata(client);
  const v = meta.apiVersion;
  return {
    meta,
    query: soql => queryAt(client, v, soql),
    describe: object => describeAt(client, v, object).then(d => d as unknown as Record<string, unknown>).catch(() => null),
    connection: () => getTaxConnection(client),
    resolveProduct: name => resolveProductRef(client, meta, { name }),
    geoCountries: () => readGeoCountries(client, meta),
    write: async (method, object, id, body) => {
      const res = await client.requestWithDiagnostics(apiUrl(client, v, id ? `/sobjects/${object}/${id}` : `/sobjects/${object}`), { method, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, statusText: res.statusText, json: res.json };
    },
    previewRateReplacement: input => previewRateReplacement(client, input),
    executeRateReplacement: (input, token) => executeRateReplacement(client, input, token),
  };
}

/* ───────────────────────────── Pure helpers (unit-tested) ───────────────────────────── */

export type RelationshipChoice =
  | { status: "ok"; field: string; label: string; on: "source" | "target" }
  | { status: "ambiguous"; options: { field: string; label: string; on: "source" | "target" }[] }
  | { status: "none"; message: string };

/**
 * Which field relates `source` to `target`, from describe referenceTo only. A field on the source pointing at the target wins
 * ("assign the treatment TO the policy" → TaxTreatment.TaxPolicyId); otherwise a field on the target pointing at the source
 * ("assign the engine to the treatment" → TaxTreatment.TaxEngineId). The hint ("default") narrows by name/label; an explicit
 * field must be one of the candidates. More than one candidate is never guessed.
 */
export function chooseRelationship(meta: TaxMetadata, source: string, target: string, hint?: string | null, explicit?: string | null): RelationshipChoice {
  const refs = (from: string, to: string, on: "source" | "target") => Object.values(objectMeta(meta, from)?.fields ?? {})
    .filter(f => f.type === "reference" && f.referenceTo.includes(to) && f.name !== "OwnerId")
    .map(f => ({ field: f.name, label: f.label, on }));
  let options = [...refs(source, target, "source"), ...refs(target, source, "target")];
  if (!options.length) return { status: "none", message: `No ${source} field references ${target} (and no ${target} field references ${source}) in this org's metadata, so they can't be related directly.` };
  if (explicit) {
    const hit = options.find(o => o.field === explicit);
    return hit ? { status: "ok", ...hit } : { status: "none", message: `${explicit} isn't a relationship between ${source} and ${target}.` };
  }
  if (hint && /default/i.test(hint)) {
    const d = options.filter(o => /default/i.test(o.field) || /default/i.test(o.label));
    if (d.length) options = d;
  } else {
    const nonDefault = options.filter(o => !/default/i.test(o.field));
    if (nonDefault.length) options = nonDefault;
  }
  const onSource = options.filter(o => o.on === "source");
  const pick = onSource.length ? onSource : options;
  return pick.length === 1 ? { status: "ok", ...pick[0] } : { status: "ambiguous", options: pick };
}

/** Map AI/user field keys (API name or label) onto the object's describe fields. Unknown keys are reported, never invented. */
export function mapFieldKeys(meta: TaxMetadata, object: string, fields: Record<string, unknown>): { mapped: Record<string, unknown>; unknown: string[] } {
  const o = objectMeta(meta, object);
  const mapped: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(fields ?? {})) {
    const f = o?.fields[k] ?? Object.values(o?.fields ?? {}).find(x => norm(x.name) === norm(k) || norm(x.label) === norm(k) || norm(x.label.replace(/\bID\b/i, "")) === norm(k));
    if (f) mapped[f.name] = v; else unknown.push(k);
  }
  return { mapped, unknown };
}

/** Coerce a value to the field's type (picklist value or label, boolean, number, date); null on invalid with a message. */
export function coerceValue(f: FieldMeta, v: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  if (f.type === "picklist") {
    const s = String(v);
    const hit = f.picklist.find(p => p.value === s) ?? f.picklist.find(p => norm(p.value) === norm(s) || norm(p.label) === norm(s));
    return hit ? { ok: true, value: hit.value } : { ok: false, message: `"${s}" isn't a valid ${f.label} (valid: ${f.picklist.map(p => p.value).join(", ")}).` };
  }
  if (f.type === "boolean") return typeof v === "boolean" ? { ok: true, value: v } : /^(true|yes|1|on)$/i.test(String(v)) ? { ok: true, value: true } : /^(false|no|0|off)$/i.test(String(v)) ? { ok: true, value: false } : { ok: false, message: `${f.label} must be true or false.` };
  if (["double", "int", "percent", "currency"].includes(f.type)) { const n = typeof v === "number" ? v : Number(String(v).replace(/[%,\s]/g, "")); return Number.isFinite(n) ? { ok: true, value: f.type === "int" ? Math.round(n) : n } : { ok: false, message: `${f.label} must be a number.` }; }
  if (f.type === "date") return typeof v === "string" && DATE.test(v) ? { ok: true, value: v } : { ok: false, message: `${f.label} must be a date (YYYY-MM-DD).` };
  return { ok: true, value: typeof v === "string" ? v : String(v) };
}

/** Same configuration value? Empty = null; Salesforce Ids compare on their 15-character form; text ignores case and outer spaces. */
export function sameValue(a: unknown, b: unknown): boolean {
  const n = (v: unknown) => (v === undefined || v === null || (typeof v === "string" && !v.trim()) ? null : v);
  const x = n(a), y = n(b);
  if (x === null || y === null) return x === y;
  if (typeof x === "number" || typeof y === "number") return Math.abs(Number(x) - Number(y)) < 1e-9;
  const sx = String(x).trim(), sy = String(y).trim();
  if (SFID.test(sx) && SFID.test(sy) && /\d/.test(sx) && /\d/.test(sy)) return sx.slice(0, 15) === sy.slice(0, 15);
  return sx.toLowerCase() === sy.toLowerCase();
}

/** Do two effective periods overlap? A missing start is open to the past, a missing end open to the future. */
export function datesOverlap(aStart: unknown, aEnd: unknown, bStart: unknown, bEnd: unknown): boolean {
  const lo = (v: unknown) => (typeof v === "string" && DATE.test(v) ? v : "0000-01-01");
  const hi = (v: unknown) => (typeof v === "string" && DATE.test(v) ? v : "9999-12-31");
  return lo(aStart) <= hi(bEnd) && lo(bStart) <= hi(aEnd);
}

/**
 * The duplicate rules that apply to `object` in this org: its rules (fields this org doesn't have are dropped; an auto-number
 * name is never a key) plus one rule per describe-`unique` field the request sets. Rules left with no key are skipped.
 */
export function duplicateRules(meta: TaxMetadata, object: string, values: Record<string, unknown>): DuplicateRule[] {
  const o = objectMeta(meta, object);
  if (!o) return [];
  const nf = Object.values(o.fields).find(f => f.nameField)?.name ?? "Name";
  const usable = (k: string) => !!o.fields[k] && !(o.fields[k].nameField && !o.fields[k].createable);
  const rules = (DUPLICATE_RULES[object] ?? [{ keys: [nf] }]).map(r => ({ ...r, keys: r.keys.filter(usable) })).filter(r => r.keys.length);
  for (const f of Object.values(o.fields)) if (f.unique && usable(f.name) && values[f.name] !== undefined && values[f.name] !== null && !rules.some(r => r.keys.length === 1 && r.keys[0] === f.name)) rules.push({ keys: [f.name] });
  return rules;
}

/** Does an existing/planned record conflict with `values` under `rule`? Every key equal and, when dated, overlapping periods. */
export function conflicts(meta: TaxMetadata, object: string, rule: DuplicateRule, values: Record<string, unknown>, row: Record<string, unknown>): boolean {
  const o = objectMeta(meta, object);
  const dated = !!(rule.effectiveDates && o?.fields.StartDate && o?.fields.EndDate);
  return rule.keys.every(k => sameValue(values[k], row[k])) && (!dated || datesOverlap(values.StartDate, values.EndDate, row.StartDate, row.EndDate));
}

/**
 * Existing records that conflict with the record being created, under any of the object's rules (first matching rule kept).
 * Pure: `rows` are candidates already read from Salesforce.
 */
export function findDuplicates(meta: TaxMetadata, object: string, values: Record<string, unknown>, rows: Record<string, unknown>[]): { row: Record<string, unknown>; rule: DuplicateRule }[] {
  const rules = duplicateRules(meta, object, values);
  const out: { row: Record<string, unknown>; rule: DuplicateRule }[] = [];
  for (const row of rows) { const rule = rules.find(r => conflicts(meta, object, r, values, row)); if (rule && !out.some(x => x.row.Id === row.Id)) out.push({ row, rule }); }
  return out;
}

/* ───────────────────────────── Context ───────────────────────────── */

interface Ctx {
  api: TaxOrgApi; meta: TaxMetadata;
  selections: Record<string, string>;
  /** Records this request creates (so later operations can refer to them by name). */
  planned: { stepId: string; object: string; name: string; fields: Record<string, unknown> }[];
  /** Field values this request will set on existing records (later operations see them). */
  overlay: Map<string, Record<string, unknown>>;
  names: Map<string, string>;
  describes: Map<string, Record<string, unknown> | null>;
  /** Records whose deactivate/draft in this request was unnecessary (already not Active) — a later "re-activate" restores nothing. */
  lifecycleNoop: Set<string>;
}

const nameFieldOf = (meta: TaxMetadata, object: string) => Object.values(objectMeta(meta, object)?.fields ?? {}).find(f => f.nameField)?.name ?? "Name";
const q = (ctx: Ctx, soql: string) => ctx.api.query(soql).catch(() => [] as Record<string, unknown>[]);

async function rawDescribe(ctx: Ctx, object: string) {
  if (!ctx.describes.has(object)) ctx.describes.set(object, await ctx.api.describe(object).catch(() => null));
  return ctx.describes.get(object) ?? null;
}

/** Display name of a record (cached; from Salesforce). */
async function nameOf(ctx: Ctx, object: string | null, id: string | null): Promise<string | null> {
  if (!id) return null;
  if (isRef(id)) return ctx.planned.find(p => `@{${p.stepId}}` === id)?.name ?? "(new record)";
  if (ctx.names.has(id)) return ctx.names.get(id)!;
  if (!object || !objectMeta(ctx.meta, object)) return id;
  const nf = nameFieldOf(ctx.meta, object);
  const [r] = await q(ctx, `SELECT ${nf} FROM ${object} WHERE Id = '${soqlEscape(id)}'`);
  const n = r ? String(r[nf] ?? id) : id;
  ctx.names.set(id, n);
  return n;
}

const COLS: Record<string, string[]> = {
  TaxPolicy: ["Status", "TreatmentSelection", "DefaultTaxTreatmentId", "Description"],
  TaxTreatment: ["Status", "IsTaxable", "TaxCode", "ProductCode", "TaxPolicyId", "TaxPolicy.Name", "TaxEngineId", "LegalEntityId", "ShouldUseTaxTreatmentItems", "Description"],
  TaxTreatmentItem: ["TaxTreatmentId", "TaxTreatment.Name", "ProductId", "Product.Name", "TaxCode", "ProductCode", "Description"],
  TaxRate: ["TaxCode", "Rate", "Priority", "RateUsageType", "GeoCountryId", "GeoCountry.IsoCode", "GeoStateId", "City", "ZipCode", "LegalEntityId", "StartDate", "EndDate", "ProductCode", "ApplicationBasis"],
  GeoCountry: ["IsoCode", "Description"], GeoState: ["IsoCode", "GeoCountryId", "GeoCountry.Name"],
  TaxEngine: ["Status", "Type", "DecisionTableId", "TaxEngineProviderId"],
  Product2: ["ProductCode", "IsActive", "TaxPolicyId", "TaxPolicy.Name"], LegalEntity: ["Status"],
};
const detailOf = (object: string, r: Record<string, unknown>) => {
  const rel = (k: string) => String(((r[k] as Record<string, unknown> | null)?.Name ?? (r[k] as Record<string, unknown> | null)?.IsoCode) ?? "");
  switch (object) {
    case "TaxRate": return `${r.TaxCode ?? "—"} ${r.Rate ?? "?"}% · ${rel("GeoCountry") || "no country"}${r.GeoStateId ? " · state" : ""}${r.City ? ` · ${r.City}` : ""}${r.ProductCode ? ` · product code ${r.ProductCode}` : ""} · ${r.StartDate ?? "—"} → ${r.EndDate ?? "open"}`;
    case "TaxTreatment": return `${r.Status ?? "—"} · ${r.IsTaxable ? "taxable" : "not taxable"}${r.TaxCode ? ` · ${r.TaxCode}` : ""} · policy ${rel("TaxPolicy") || "—"}`;
    case "TaxTreatmentItem": return `${rel("Product") || "—"} → ${rel("TaxTreatment") || "—"}${r.TaxCode ? ` · ${r.TaxCode}` : ""}`;
    case "Product2": return `${r.ProductCode ?? "—"} · ${r.IsActive ? "active" : "inactive"} · policy ${rel("TaxPolicy") || "none"}`;
    case "GeoState": return `${r.IsoCode ?? ""} · ${rel("GeoCountry")}`;
    default: return [r.Status, r.IsoCode, r.Type, r.TreatmentSelection].filter(Boolean).join(" · ") || "";
  }
};

type Found = { status: "found"; id: string; name: string; row: Record<string, unknown> };
type Resolved = Found | { status: "multiple"; options: { id: string; name: string; detail: string }[] } | { status: "none"; message: string; options: { id: string; name: string; detail: string }[] };

/** The selector's natural-language name for `object` (name, or the object-specific alias the AI may use). */
const selectorName = (object: string, s: RecordSelector) => (s.name ?? (object === "TaxTreatment" ? s.treatmentName : object === "TaxPolicy" ? s.policyName : object === "Product2" ? s.productName : null))?.trim() || null;

/** Find ONE existing record by the selector — exact matches only; the user's selection (by key) always wins. */
async function resolveRecord(ctx: Ctx, object: string, sel: RecordSelector | null | undefined, selKey: string): Promise<Resolved> {
  const o = objectMeta(ctx.meta, object);
  if (!o) return { status: "none", message: `${object} isn't available in this org.`, options: [] };
  const nf = nameFieldOf(ctx.meta, object);
  const cols = selectable(ctx.meta, object, ["Id", nf, ...(COLS[object] ?? [])]);
  const byId = async (id: string): Promise<Resolved> => {
    const [r] = await q(ctx, `SELECT ${cols.join(", ")} FROM ${object} WHERE Id = '${soqlEscape(id)}'`);
    return r ? { status: "found", id: r.Id as string, name: String(r[nf] ?? r.Id), row: r } : { status: "none", message: `${o.label} ${id} doesn't exist (or isn't visible) in this org.`, options: [] };
  };
  const chosen = ctx.selections[selKey];
  if (chosen && SFID.test(chosen)) return byId(chosen);
  const s = sel ?? {};
  const name = selectorName(object, s);
  if (s.id && SFID.test(s.id)) {
    const r = await byId(s.id);
    if (r.status === "found" || !name || name === s.id) return r; // a 15/18-character NAME falls through to the name search
  }
  const planned = name ? ctx.planned.find(p => p.object === object && p.name.toLowerCase() === name.toLowerCase()) : null;
  if (planned) return { status: "found", id: `@{${planned.stepId}}`, name: planned.name, row: planned.fields };
  if (object === "Product2" && name) {
    const r = await ctx.api.resolveProduct(name);
    const opts = (r.status === "found" ? [] : r.candidates).map(p => ({ id: p.id, name: p.name, detail: `${p.code ?? "no code"}${p.active ? "" : " · inactive"}` }));
    if (r.status === "found") return byId(r.product.id);
    return r.status === "ambiguous" ? { status: "multiple", options: opts } : { status: "none", message: r.message, options: opts };
  }
  const where: string[] = [];
  const eq = (f: string, v: string) => where.push(`${f} = '${soqlEscape(v)}'`);
  const country = async (raw: string) => resolveCountry(raw, await ctx.api.geoCountries());
  if (object === "TaxRate") {
    const code = s.taxCode ?? name;
    if (code) eq("TaxCode", code);
    if (s.rate !== null && s.rate !== undefined && Number.isFinite(Number(s.rate))) where.push(`Rate = ${Number(s.rate)}`);
    if (s.country) { const c = await country(s.country); if (c) eq("GeoCountry.IsoCode", c.iso); }
  } else if (object === "GeoCountry") {
    const c = s.isoCode ?? (name && /^[A-Za-z]{2}$/.test(name) ? name : null);
    if (c) eq("IsoCode", c.toUpperCase()); else if (name) eq("Name", name);
  } else if (object === "GeoState") {
    if (s.isoCode) eq("IsoCode", s.isoCode.toUpperCase()); else if (name) eq("Name", name);
    if (s.country) { const c = await country(s.country); if (c) eq("GeoCountry.IsoCode", c.iso); }
  } else if (object === "TaxTreatmentItem" && !name && s.productName) {
    eq("Product.Name", s.productName);
    if (s.treatmentName) eq("TaxTreatment.Name", s.treatmentName);
  } else {
    if (name) eq(nf, name);
    if (object === "TaxTreatment" && s.policyName && s.name) eq("TaxPolicy.Name", s.policyName);
  }
  if (!where.length) return { status: "none", message: `Which ${o.label}? Give its name${object === "TaxRate" ? " or tax code" : ""}.`, options: [] };
  const rows = await q(ctx, `SELECT ${cols.join(", ")} FROM ${object} WHERE ${where.join(" AND ")} ORDER BY CreatedDate LIMIT 11`);
  const opt = (r: Record<string, unknown>) => ({ id: r.Id as string, name: String(r[nf] ?? r.Id), detail: detailOf(object, r) });
  if (rows.length === 1) return { status: "found", id: rows[0].Id as string, name: String(rows[0][nf] ?? rows[0].Id), row: rows[0] };
  if (rows.length > 1) return { status: "multiple", options: rows.slice(0, 10).map(opt) };
  const like = name ?? s.taxCode ?? s.productName;
  const likeField = object === "TaxRate" ? "TaxCode" : nf;
  const similar = like && ["string", "textarea"].includes(o.fields[likeField]?.type ?? "") ? await q(ctx, `SELECT ${cols.join(", ")} FROM ${object} WHERE ${likeField} LIKE '%${soqlEscape(like)}%' ORDER BY CreatedDate LIMIT 5`) : [];
  const described = Object.entries(s).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k} "${v}"`).join(", ");
  return { status: "none", message: `Record not found: no ${o.label} matches ${described}${similar.length ? ` (similar: ${similar.map(r => String(r[likeField])).join(", ")})` : ""}.`, options: similar.map(opt) };
}

/**
 * ONE lookup value (a name, an Id or a selector) → the matching existing record, with the same exact-match rules as the preview:
 * by Id, else by exact name. Several matches → "multiple" (the user chooses); none → "none" with similar records as options.
 * Nothing is ever auto-selected and nothing is written.
 */
export type LookupResolution = Resolved;
export async function resolveLookupValue(api: TaxOrgApi, targetObject: string, value: unknown): Promise<LookupResolution> {
  const ctx: Ctx = { api, meta: api.meta, selections: {}, planned: [], overlay: new Map(), names: new Map(), describes: new Map(), lifecycleNoop: new Set() };
  const sel: RecordSelector = typeof value === "string" ? { name: value.trim(), id: SFID.test(value.trim()) ? value.trim() : null } : ((value ?? {}) as RecordSelector);
  return resolveRecord(ctx, targetObject, sel, "form:lookup");
}

/* ───────────────────────────── Preview ───────────────────────────── */

const OP_LABEL: Record<string, string> = { create: "CREATE", update: "UPDATE", assign: "ASSIGN", activate: "ACTIVATE", deactivate: "DEACTIVATE", draft: "SET TO DRAFT", "end-date": "END-DATE", replace: "REPLACE", delete: "DELETE", show: "SHOW", configure: "CONFIGURE" };
export const opLabel = (op: string) => OP_LABEL[op] ?? op.toUpperCase();

export async function previewOperations(client: SalesforceClient, req: AssistantRequest): Promise<AssistantPreview> {
  return previewWith(await orgApiFor(client), req);
}

export async function previewWith(api: TaxOrgApi, req: AssistantRequest): Promise<AssistantPreview> {
  const ctx: Ctx = { api, meta: api.meta, selections: req.selections ?? {}, planned: [], overlay: new Map(), names: new Map(), describes: new Map(), lifecycleNoop: new Set() };
  const previews: OpPreview[] = [];
  for (const [i, op] of (req.operations ?? []).slice(0, 15).entries()) previews.push(await previewOne(ctx, { ...op, key: op.key || `op${i + 1}` }));
  // Lifecycle summary for records with a Status: the status before this request and every status change the steps make.
  for (const p of previews) {
    if (!objectMeta(ctx.meta, p.object)?.fields.Status || !p.record || p.op === "show") continue;
    const changes = p.steps.filter(s => "Status" in s.fields).map(s => `${s.recordName}: ${s.changes.find(c => c.field === "Status")?.currentDisplay ?? "—"} → ${s.fields.Status}`);
    p.lifecycle = { current: p.record.status, changes };
  }
  const connection = await api.connection();
  const ok = previews.length > 0 && previews.every(p => p.status !== "blocked" && p.status !== "needs-selection") && previews.some(p => p.steps.length > 0);
  const token = createHash("sha256").update(JSON.stringify([connection.orgId, connection.userId, previews.map(p => [p.key, p.status, p.steps.map(s => [s.id, s.kind, s.recordId, s.fields, s.changes.map(c => c.current)])])])).digest("hex").slice(0, 32);
  return { success: true, ok, connection, operations: previews, needsSelection: previews.some(p => p.status === "needs-selection"), token };
}

async function previewOne(ctx: Ctx, op: AssistantOperation): Promise<OpPreview> {
  const o = objectMeta(ctx.meta, op.object);
  const base: OpPreview = { key: op.key, op: op.op, object: op.object, objectLabel: o?.label ?? op.object, status: "ready", record: null, dependencies: [], steps: [], issues: [] };
  const block = (code: string, message: string, extra: Partial<PlanIssue> = {}): OpPreview => ({ ...base, status: "blocked", issues: [...base.issues, { severity: "error", code, message, object: op.object, ...extra }] });
  if (op.op === "configure") return { ...base, status: "info", issues: [{ severity: "info", code: "CONFIGURE", message: "A whole tax configuration is previewed by the configuration planner." }] };
  if (!o) return block("MISSING_OBJECT", `${op.object} isn't a Salesforce object this assistant can work with in this org.`);
  const sup = SUPPORTED[op.object];
  if (!sup) return block("UNSUPPORTED_OBJECT", `${op.object} isn't managed here. Supported: ${Object.keys(SUPPORTED).join(", ")}. (Decision tables, lookup tables, Tax Engine Providers and InvoiceLineTax are never changed by the app.)`);
  switch (op.op) {
    case "create": return previewCreate(ctx, op, base, block);
    case "update": return previewUpdate(ctx, op, base, block);
    case "assign": return previewAssign(ctx, op, base, block);
    case "activate": case "deactivate": case "draft": case "end-date": return previewLifecycle(ctx, op, base, block);
    case "replace": return previewReplace(ctx, op, base, block);
    case "delete": return previewDelete(ctx, op, base, block);
    case "show": return previewShow(ctx, op, base, block);
    default: return block("UNKNOWN_OPERATION", `Unknown operation "${op.op}".`);
  }
}

type Block = (code: string, message: string, extra?: Partial<PlanIssue>) => OpPreview;
type Choices = NonNullable<OpPreview["choices"]>;

/**
 * CREATE: lookups the request expresses outside `fields` — a relation ("…under treatment X") or a selector alias ("for product
 * Y") — become the object's own reference fields, chosen from metadata. Values already given in `fields` win.
 */
export function foldCreateReferences(meta: TaxMetadata, op: AssistantOperation): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...(op.fields ?? {}) };
  const has = (field: string) => field in mapFieldKeys(meta, op.object, fields).mapped;
  const sourceField = (target: string, hint?: string | null) => { const c = chooseRelationship(meta, op.object, target, hint); return c.status === "ok" && c.on === "source" ? c.field : null; };
  if (op.relation?.object && op.relation.target) {
    const f = op.relation.field ?? sourceField(op.relation.object, op.relation.kind);
    if (f && !has(f)) fields[f] = op.relation.target;
  }
  const t = op.target;
  if (t) for (const [alias, target] of [["productName", "Product2"], ["treatmentName", "TaxTreatment"], ["policyName", "TaxPolicy"]] as const) {
    const v = t[alias];
    if (!v) continue;
    const f = sourceField(target);
    if (f && !has(f)) fields[f] = { name: v };
  }
  return fields;
}

/** Validate & resolve field values (lookups resolved in Salesforce to Ids); returns values ready for Salesforce plus choices/issues. */
async function resolveFields(ctx: Ctx, object: string, opKey: string, raw: Record<string, unknown>, issues: PlanIssue[], choices: Choices) {
  const { mapped, unknown } = mapFieldKeys(ctx.meta, object, raw);
  for (const k of unknown) issues.push({ severity: "error", code: "INVALID_FIELD", object, field: k, message: `${object} has no field "${k}" in this org's metadata.` });
  const o = objectMeta(ctx.meta, object)!;
  const values: Record<string, unknown> = {};
  const display: Record<string, string> = {};
  const resolved: Record<string, Found> = {};
  for (const [name, v] of Object.entries(mapped)) {
    const f = o.fields[name];
    if (f.type === "reference") {
      if (v === null || v === "") { values[name] = null; continue; }
      // Name → record → Id. A string is a name (an Id only if it resolves as one); objects are selectors.
      const sel: RecordSelector = typeof v === "string" ? { name: v, id: SFID.test(v.trim()) ? v.trim() : null } : (v as RecordSelector);
      const targetObj = f.referenceTo.find(t => SUPPORTED[t] || objectMeta(ctx.meta, t)) ?? f.referenceTo[0];
      const r = await resolveRecord(ctx, targetObj, sel, `${opKey}:field:${name}`);
      if (r.status === "found") { values[name] = r.id; display[name] = r.name; resolved[name] = r; }
      else if (r.status === "multiple") choices.push({ selectionKey: `${opKey}:field:${name}`, prompt: `Several ${objectMeta(ctx.meta, targetObj)?.label ?? targetObj} records match for ${f.label} — choose one.`, options: r.options });
      else issues.push({ severity: "error", code: "RECORD_NOT_FOUND", object, field: name, message: `${f.label}: ${r.message}`, action: r.options.length ? "Pick one of the similar records, or correct the name." : undefined });
      if (r.status === "none" && r.options.length) choices.push({ selectionKey: `${opKey}:field:${name}`, prompt: `No exact ${objectMeta(ctx.meta, targetObj)?.label ?? targetObj} match for ${f.label} — select the correct one`, options: r.options });
      continue;
    }
    const c = coerceValue(f, v);
    if (!c.ok) { issues.push({ severity: "error", code: f.type === "picklist" ? "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST" : "INVALID_VALUE", object, field: name, message: c.message }); continue; }
    values[name] = c.value;
    if (c.value !== null) display[name] = String(c.value);
  }
  if (SUPPORTED[object]?.onlyFields) for (const k of Object.keys(values)) if (!SUPPORTED[object].onlyFields!.includes(k)) { issues.push({ severity: "error", code: "NOT_ALLOWED", object, field: k, message: `Only ${SUPPORTED[object].onlyFields!.join(", ")} can be changed on ${object} here.` }); delete values[k]; }
  return { values, display, resolved };
}

/** A reference shown as "Name (Id)" so the preview and audit show both the user's name and the Salesforce Id. */
const refDisplay = (f: FieldMeta, id: unknown, name: string | null) => {
  if (id === null || id === undefined || id === "") return null;
  if (f.type !== "reference") return name ?? String(id);
  return isRef(id) ? `${name ?? "new record"} (created in this request)` : name && name !== id ? `${name} (${id})` : String(id);
};
const change = (f: FieldMeta, current: unknown, currentName: string | null, next: unknown, nextName: string | null): OpChange => ({
  field: f.name, label: f.label, type: f.type, referenceTo: f.referenceTo, current, currentDisplay: refDisplay(f, current, currentName), next, nextDisplay: refDisplay(f, next, nextName), updateable: f.updateable, createable: f.createable,
});

async function previewCreate(ctx: Ctx, op: AssistantOperation, base: OpPreview, block: Block): Promise<OpPreview> {
  const o = objectMeta(ctx.meta, op.object)!;
  if (!SUPPORTED[op.object].create || !o.createable) return block("NOT_CREATEABLE", `${o.label} records can't be created here${o.createable ? "" : " by the current user"}.`);
  const issues: PlanIssue[] = []; const choices: Choices = [];
  const { values, display, resolved } = await resolveFields(ctx, op.object, op.key, foldCreateReferences(ctx.meta, op), issues, choices);
  // Registry defaults (e.g. new policies/treatments start as Draft; rates use Revenue Cloud), only for fields not given.
  for (const [k, v] of Object.entries(moduleOf(op.object)?.defaults ?? {})) if (!(k in values) && o.fields[k]?.createable && (o.fields[k].type !== "picklist" || o.fields[k].picklist.some(p => p.value === v))) values[k] = v;
  // Lifecycle: a policy/treatment is created as Draft and activated in a separate, ordered step.
  const wantsActive = (op.object === "TaxPolicy" || op.object === "TaxTreatment") && values.Status === picklistValue(ctx.meta, op.object, "Status", "Active");
  if (wantsActive) values.Status = picklistValue(ctx.meta, op.object, "Status", "Draft") ?? values.Status;
  // A lookup that couldn't be resolved: nothing is created — the user picks the right record first.
  if (choices.length || issues.some(i => i.code === "RECORD_NOT_FOUND")) return { ...base, status: issues.some(i => i.code === "RECORD_NOT_FOUND") ? "blocked" : "needs-selection", choices, issues };
  const nf = nameFieldOf(ctx.meta, op.object);
  const name = String(values[nf] ?? values.TaxCode ?? values.IsoCode ?? o.label);

  // Object-specific prerequisites (verified Salesforce rules) and defaults.
  if (op.object === "TaxTreatmentItem") {
    const trField = chooseRelationship(ctx.meta, "TaxTreatmentItem", "TaxTreatment");
    const prField = chooseRelationship(ctx.meta, "TaxTreatmentItem", "Product2");
    const trId = trField.status === "ok" ? values[trField.field] : null;
    const tr = trField.status === "ok" ? resolved[trField.field] : undefined;
    const trRow = typeof trId === "string" ? (isRef(trId) ? ctx.planned.find(p => `@{${p.stepId}}` === trId)?.fields : { ...(tr?.row ?? {}), ...(ctx.overlay.get(trId) ?? {}) }) : undefined;
    if (trRow && objectMeta(ctx.meta, "TaxTreatment")?.fields.ShouldUseTaxTreatmentItems && trRow.ShouldUseTaxTreatmentItems !== true) {
      const trName = tr?.name ?? display[trField.status === "ok" ? trField.field : ""] ?? "the treatment";
      // The resolved payload (names → Salesforce Ids) is still shown; a blocked preview can't be executed.
      const payload: OpStep = { id: `${op.key}:create`, opKey: op.key, kind: "create", object: op.object, recordId: null, recordName: name, fields: { ...values }, changes: Object.entries(values).filter(([k]) => o.fields[k]).map(([k, v]) => change(o.fields[k], null, null, v, display[k] ?? null)), detail: `New ${o.label} "${name}" — not created until the treatment allows items.` };
      return { ...base, status: "blocked", record: { id: null, name, status: null }, steps: [payload],
        issues: [{ severity: "error", code: "ITEMS_NOT_ENABLED", object: "TaxTreatment", field: "ShouldUseTaxTreatmentItems", message: `Tax Treatment "${trName}" doesn't have "Use Tax Treatment Items" selected — Salesforce only accepts items for such treatments ("Specify a tax treatment that has Use Tax Treatment Items selected"). Nothing will be created.` }],
        offers: tr && !isRef(tr.id) ? [{ label: `Turn on "Use Tax Treatment Items" for "${trName}"`, operation: { key: `${op.key}i`, op: "update", object: "TaxTreatment", target: { id: tr.id }, fields: { ShouldUseTaxTreatmentItems: true } } }] : [] };
    }
    // Product Code: when not given, use the product's own Product Code (never invented); Tax Code stays as given.
    const prId = prField.status === "ok" ? values[prField.field] : null;
    if (o.fields.ProductCode?.createable && values.ProductCode === undefined && typeof prId === "string" && !isRef(prId)) {
      const code = (prField.status === "ok" ? resolved[prField.field]?.row.ProductCode : null) as string | null | undefined;
      if (code) { values.ProductCode = code; display.ProductCode = code; issues.push({ severity: "info", code: "PRODUCT_CODE_FROM_PRODUCT", object: op.object, field: "ProductCode", message: `Product Code "${code}" is taken from the product. Give a Product Code to use a different one.` }); }
    }
  }

  // Tax Rate: the dimensions Revenue Cloud invoicing matches on. A single active legal entity and today's date are filled in
  // (stated as info); RevCloud usage, an explicit basis, tax code, country, legal entity and dates are then validated by the
  // shared tax-rate rules — Salesforce's Commerce / Gross defaults are never taken silently.
  if (op.object === "TaxRate") {
    if ((values.LegalEntityId === undefined || values.LegalEntityId === null) && o.fields.LegalEntityId?.createable) {
      const les = await q(ctx, "SELECT Id, Name FROM LegalEntity WHERE Status = 'Active' LIMIT 2");
      if (les.length === 1) { values.LegalEntityId = les[0].Id; display.LegalEntityId = String(les[0].Name); issues.push({ severity: "info", code: "LEGAL_ENTITY_DEFAULTED", object: "TaxRate", field: "LegalEntityId", message: `Legal Entity "${les[0].Name}" — the org's only active legal entity.` }); }
    }
    if ((values.StartDate === undefined || values.StartDate === null) && o.fields.StartDate?.createable) { values.StartDate = today(); display.StartDate = today(); issues.push({ severity: "info", code: "START_DATE_DEFAULTED", object: "TaxRate", field: "StartDate", message: `Start Date ${today()} (today) — give a date to start it on another day.` }); }
    for (const r of evaluateTaxRateRules({ mode: "create", values, availableFields: Object.keys(o.fields), today: today() })) issues.push({ severity: r.severity, code: r.code, object: "TaxRate", field: r.field ?? undefined, message: r.message });
    if (typeof values.TaxCode === "string" && values.TaxCode) {
      const cols = selectable(ctx.meta, "TaxRate", ["Id", "Name", "Rate", "TaxCode", "GeoCountryId", "GeoStateId", "City", "ZipCode", "ProductCode", "LegalEntityId", "RateUsageType", "StartDate", "EndDate"]);
      for (const x of overlappingRates(values, await q(ctx, `SELECT ${cols.join(", ")} FROM TaxRate WHERE TaxCode = '${soqlEscape(values.TaxCode)}' LIMIT 200`))) issues.push({ severity: x.severity, code: x.code, object: "TaxRate", message: x.message });
    }
  }

  // Duplicate prevention BEFORE required-field validation: an existing record is shown (with what can be done to it) rather
  // than asking for create fields the user never meant to supply.
  const why = (rule: DuplicateRule) => `${rule.keys.map(k => o.fields[k].label).join(" + ")}${rule.effectiveDates ? " and overlapping effective dates" : ""}`;
  const rules = duplicateRules(ctx.meta, op.object, values);
  // A record created earlier in this same request counts too (Salesforce would reject the second one).
  for (const p of ctx.planned.filter(x => x.object === op.object)) {
    const rule = rules.find(r => r.keys.every(k => !isRef(values[k]) || values[k] === p.fields[k]) && conflicts(ctx.meta, op.object, r, values, p.fields));
    if (rule) return { ...base, status: "blocked", record: { id: null, name, status: null }, issues: [{ severity: "error", code: "DUPLICATE_IN_REQUEST", message: `"${name}" has the same ${why(rule)} as "${p.name}", which this request also creates — Salesforce would reject it.${rule.reason ? ` ${rule.reason}` : ""} Change one of them (e.g. a different tax code or product code).` }] };
  }
  const candidates: Record<string, unknown>[] = [];
  for (const rule of rules) {
    if (!rule.keys.some(k => values[k] !== undefined && values[k] !== null) || rule.keys.some(k => isRef(values[k]))) continue;
    const cols = selectable(ctx.meta, op.object, [...new Set(["Id", nf, ...rule.keys, ...(rule.effectiveDates ? ["StartDate", "EndDate"] : []), ...(COLS[op.object] ?? [])])]);
    const narrow = rule.keys.filter(k => values[k] !== undefined && values[k] !== null && ["string", "reference", "picklist", "textarea"].includes(o.fields[k].type));
    if (!narrow.length) continue;
    candidates.push(...await q(ctx, `SELECT ${cols.join(", ")} FROM ${op.object} WHERE ${narrow.map(k => `${k} = '${soqlEscape(String(values[k]))}'`).join(" AND ")} ORDER BY CreatedDate LIMIT 200`));
  }
  {
    const hits = findDuplicates(ctx.meta, op.object, values, candidates);
    const rows = hits.map(h => h.row);
    const sel = ctx.selections[`${op.key}:existing`];
    const hit = sel ? hits.find(h => h.row.Id === sel) : hits.length === 1 ? hits[0] : null;
    if (hits.length > 1 && !hit) return { ...base, status: "needs-selection", issues: [{ severity: "warning", code: "MULTIPLE_EXISTING", message: `${hits.length} existing ${o.label} records conflict with this one (${[...new Set(hits.map(h => why(h.rule)))].join("; ")}) — nothing will be created; choose the one you mean.` }], choices: [{ selectionKey: `${op.key}:existing`, prompt: `Existing ${o.label} records that match`, options: rows.map(r => ({ id: r.Id as string, name: String(r[nf] ?? r.Id), detail: detailOf(op.object, r) })) }] };
    if (hit) {
      const pick = hit.row, keys = hit.rule.keys;
      const offers: NonNullable<OpPreview["offers"]> = [];
      const diff = Object.entries(values).filter(([k, v]) => !keys.includes(k) && k !== "Status" && o.fields[k]?.updateable && pick[k] !== undefined && !sameValue(pick[k], v));
      if (diff.length) offers.push({ label: `Update ${diff.map(([k]) => o.fields[k].label).join(", ")} on the existing record`, operation: { key: `${op.key}u`, op: "update", object: op.object, target: { id: pick.Id as string }, fields: Object.fromEntries(diff) } });
      if (o.fields.Status && pick.Status !== picklistValue(ctx.meta, op.object, "Status", "Active")) offers.push({ label: `Activate the existing ${o.label}`, operation: { key: `${op.key}a`, op: "activate", object: op.object, target: { id: pick.Id as string } } });
      const pickName = String(pick[nf] ?? pick.Id);
      return { ...base, status: "exists", record: { id: pick.Id as string, name: pickName, status: (pick.Status as string) ?? null }, offers,
        issues: [{ severity: "info", code: "ALREADY_EXISTS", message: `${o.label} "${pickName}" (${pick.Id}) already exists with the same ${why(hit.rule)} — it won't be created again.${hit.rule.reason ? ` ${hit.rule.reason}` : ""}` }] };
    }
  }

  for (const f of Object.values(o.fields)) if (f.required && (values[f.name] === null || values[f.name] === undefined) && f.name !== "OwnerId" && !issues.some(i => i.field === f.name)) issues.push({ severity: "error", code: "REQUIRED_FIELD_MISSING", object: op.object, field: f.name, message: `${f.label} (${f.name}) is required by Salesforce.` });
  for (const k of Object.keys(values)) if (!o.fields[k].createable) { issues.push({ severity: "error", code: "FIELD_NOT_WRITABLE", object: op.object, field: k, message: `${o.fields[k].label} can't be set on create.` }); delete values[k]; }
  const stepId = `${op.key}:create`;
  const step: OpStep = { id: stepId, opKey: op.key, kind: "create", object: op.object, recordId: null, recordName: name, fields: values, changes: Object.entries(values).map(([k, v]) => change(o.fields[k], null, null, v, display[k] ?? null)), detail: `New ${o.label} "${name}".` };
  ctx.planned.push({ stepId, object: op.object, name, fields: values });
  const steps = [step];
  if (wantsActive) {
    const lc = await previewLifecycle(ctx, { key: `${op.key}:activate`, op: "activate", object: op.object, target: { id: `@{${stepId}}` } }, { ...base, steps: [] }, block, { status: "found", id: `@{${stepId}}`, name, row: values });
    steps.push(...lc.steps); issues.push(...lc.issues);
    if (lc.status === "blocked") return { ...base, status: "blocked", steps, issues };
  }
  return { ...base, status: issues.some(i => i.severity === "error") ? "blocked" : "ready", record: { id: null, name, status: (values.Status as string) ?? null }, steps, issues };
}

/**
 * Rules for changing a relationship field on an existing record (ASSIGN, or UPDATE of a lookup): a policy's default treatment
 * must be one of its own treatments and, on an Active policy, Active (activated first, separately); moving a product to another
 * policy changes its future tax. Returns extra steps (to run first), issues, offers, and whether the change is blocked.
 */
async function relationshipRules(ctx: Ctx, base: OpPreview, block: Block, opKey: string, updatedObj: string, updated: Found, field: FieldMeta, otherObj: string, other: Found) {
  const steps: OpStep[] = []; const issues: PlanIssue[] = []; const offers: NonNullable<OpPreview["offers"]> = [];
  const current = { ...updated.row, ...(ctx.overlay.get(updated.id) ?? {}) };
  if (updatedObj === "TaxPolicy" && /default/i.test(field.name) && otherObj === "TaxTreatment") {
    const tr = { ...other.row, ...(ctx.overlay.get(other.id) ?? {}) };
    if (tr.TaxPolicyId && !sameValue(tr.TaxPolicyId, updated.id)) {
      issues.push({ severity: "error", code: "TREATMENT_OTHER_POLICY", object: "TaxTreatment", field: "TaxPolicyId", message: `Tax Treatment "${other.name}" belongs to another Tax Policy (${await nameOf(ctx, "TaxPolicy", String(tr.TaxPolicyId))}) — a policy's default treatment must be one of its own treatments.` });
      offers.push({ label: `Assign "${other.name}" to "${updated.name}" first`, operation: { key: `${opKey}p`, op: "assign", object: "TaxTreatment", target: { id: other.id }, relation: { object: "TaxPolicy", target: { id: updated.id } } } });
      return { steps, issues, offers, blocked: true };
    }
    const policyActive = (current.Status ?? null) === picklistValue(ctx.meta, "TaxPolicy", "Status", "Active");
    if (policyActive && tr.Status !== picklistValue(ctx.meta, "TaxTreatment", "Status", "Active")) {
      const lc = await previewLifecycle(ctx, { key: `${opKey}:pre`, op: "activate", object: "TaxTreatment", target: { id: other.id } }, { ...base, steps: [] }, block, other);
      steps.push(...lc.steps); issues.push(...lc.issues, { severity: "info", code: "LIFECYCLE_ORDER", message: `"${updated.name}" is Active, so "${other.name}" is activated first (separate request).` });
      if (lc.status === "blocked") return { steps, issues, offers, blocked: true };
    }
  }
  if (updatedObj === "Product2" && current[field.name] && !sameValue(current[field.name], other.id)) issues.push({ severity: "warning", code: "PRODUCT_POLICY_CHANGES", object: "Product2", field: field.name, message: `Product "${updated.name}" moves from ${await nameOf(ctx, field.referenceTo[0] ?? null, String(current[field.name]))} to "${other.name}" — this changes tax on its future orders and invoices.` });
  return { steps, issues, offers, blocked: false };
}

async function previewUpdate(ctx: Ctx, op: AssistantOperation, base: OpPreview, block: Block): Promise<OpPreview> {
  const o = objectMeta(ctx.meta, op.object)!;
  if (!SUPPORTED[op.object].update) return block("NOT_UPDATEABLE", `${o.label} records can't be changed here.`);
  const r = await resolveRecord(ctx, op.object, op.target, `${op.key}:target`);
  if (r.status === "multiple") return { ...base, status: "needs-selection", choices: [{ selectionKey: `${op.key}:target`, prompt: `Several ${o.label} records match — which one do you mean?`, options: r.options }] };
  if (r.status === "none") return { ...block("RECORD_NOT_FOUND", `${r.message} Nothing will be changed.`), choices: r.options.length ? [{ selectionKey: `${op.key}:target`, prompt: `Select the correct ${o.label}`, options: r.options }] : undefined };
  const issues: PlanIssue[] = []; const choices: Choices = [];
  // Only the requested changes — the record's other fields (name, selection, status, …) are kept as they are in Salesforce.
  const { values, display, resolved } = await resolveFields(ctx, op.object, op.key, op.fields ?? {}, issues, choices);
  const record = { id: r.id, name: r.name, status: (r.row.Status as string) ?? null };
  if (choices.length || issues.some(i => i.code === "RECORD_NOT_FOUND")) return { ...base, status: choices.length ? "needs-selection" : "blocked", choices, issues, record };
  const steps: OpStep[] = [];
  const offers: NonNullable<OpPreview["offers"]> = [];
  // Status is a lifecycle transition (dependency order), not a plain field edit.
  if ("Status" in values && o.fields.Status) {
    const target = String(values.Status);
    delete values.Status;
    const action = target === picklistValue(ctx.meta, op.object, "Status", "Active") ? "activate" : target === picklistValue(ctx.meta, op.object, "Status", "Draft") ? "draft" : "deactivate";
    const lc = await previewLifecycle(ctx, { ...op, op: action, key: `${op.key}:status` }, { ...base, steps: [] }, block, r);
    steps.push(...lc.steps); issues.push(...lc.issues);
  }
  const current = { ...r.row, ...(ctx.overlay.get(r.id) ?? {}) };
  const createOnly = Object.keys(values).filter(k => !o.fields[k].updateable && o.fields[k].createable);
  const notWritable = Object.keys(values).filter(k => !o.fields[k].updateable && !o.fields[k].createable);
  for (const k of notWritable) issues.push({ severity: "error", code: "FIELD_NOT_WRITABLE", object: op.object, field: k, message: `${o.fields[k].label} is read-only in Salesforce.` });
  if (createOnly.length && op.object === "TaxRate") {
    // Create-only rate fields → replacement rate from an effective date; the old rate is end-dated the day before.
    const effectiveDate = op.date && DATE.test(op.date) ? op.date : today();
    const changes = Object.fromEntries(Object.entries(values).filter(([k]) => !notWritable.includes(k)));
    const prev = await ctx.api.previewRateReplacement({ rateId: r.id, effectiveDate, changes });
    issues.push({ severity: "info", code: "CREATE_ONLY_REPLACEMENT", message: `${createOnly.map(k => o.fields[k].label).join(", ")} can't be changed on an existing Tax Rate (create-only), so a replacement rate is created from ${effectiveDate} and this one ends ${prev.oldRatePatch.EndDate}.` }, ...prev.issues);
    steps.push({ id: `${op.key}:replace`, opKey: op.key, kind: "replace-rate", object: "TaxRate", recordId: r.id, recordName: r.name, fields: prev.newRate, replacement: { effectiveDate, changes },
      changes: [...Object.keys(prev.newRate).filter(k => o.fields[k] && !sameValue(prev.oldRate[k], prev.newRate[k])).map(k => change(o.fields[k], prev.oldRate[k] ?? null, null, prev.newRate[k], display[k] ?? null)), change(o.fields.EndDate, prev.oldRate.EndDate ?? null, null, prev.oldRatePatch.EndDate, `${prev.oldRatePatch.EndDate} (current rate)`)],
      detail: `Replacement Tax Rate from ${effectiveDate}; the current rate is end-dated ${prev.oldRatePatch.EndDate}.` });
    return { ...base, status: issues.some(i => i.severity === "error") ? "blocked" : "ready", record, steps, issues };
  }
  if (op.object === "TaxRate") {
    // In-place edits: a changed field must satisfy the tax-rate rules; problems on unchanged legacy values are warnings (so a
    // legacy Commerce rate can still be end-dated / retired).
    for (const x of evaluateTaxRateRules({ mode: "update", values: { ...current, ...values }, changed: Object.keys(values), availableFields: Object.keys(o.fields), today: today() })) issues.push({ severity: x.severity, code: x.code, object: "TaxRate", field: x.field ?? undefined, message: x.message });
  }
  for (const k of createOnly) issues.push({ severity: "error", code: "CREATE_ONLY_FIELD", object: op.object, field: k, message: `${o.fields[k].label} can only be set when a ${o.label} is created — Salesforce doesn't allow changing it. Create a new ${o.label} instead (and delete or deactivate this one).` });
  const fields = Object.fromEntries(Object.entries(values).filter(([k, v]) => o.fields[k].updateable && !sameValue(current[k], v)));
  // A lookup change is a relationship change: the same rules as ASSIGN apply (e.g. a policy's default treatment).
  for (const k of Object.keys(fields)) {
    const f = o.fields[k];
    if (f.type !== "reference" || !resolved[k]) continue;
    const rules = await relationshipRules(ctx, base, block, `${op.key}:${k}`, op.object, r, f, f.referenceTo.find(t => objectMeta(ctx.meta, t)) ?? f.referenceTo[0], resolved[k]);
    if (rules.blocked) return { ...base, status: "blocked", record, steps: [], issues: [...issues, ...rules.issues], offers: rules.offers };
    steps.push(...rules.steps); issues.push(...rules.issues); offers.push(...rules.offers);
  }
  // State-aware lifecycle: only an Active record with a field Salesforce locks while Active needs a status change — and that is
  // explained and offered, never done automatically. Draft/Inactive records are edited directly, with no status change.
  const rules = STATUS_RULES[op.object];
  const active = picklistValue(ctx.meta, op.object, "Status", "Active");
  if (rules && current.Status === active) {
    const locked = Object.keys(fields).filter(k => rules.lockedWhileActive.includes(k));
    if (locked.length) {
      const labels = locked.map(k => o.fields[k].label).join(", ");
      const inactive = picklistValue(ctx.meta, op.object, "Status", "Inactive");
      const forbiddenDraft = rules.forbidden.some(([a, b]) => a === "Active" && b === "Draft");
      return { ...base, status: "blocked", record, steps: [], lifecycle: { current: String(current.Status), changes: [] },
        issues: [...issues, { severity: "error", code: "LOCKED_WHILE_ACTIVE", object: op.object, field: locked[0], message: `Salesforce doesn't allow changing ${labels} while a ${o.label} is Active ("Can't edit ${o.fields[locked[0]].label} while status is Active"). Nothing will be changed. Required lifecycle: 1) Deactivate "${r.name}" (Active → Inactive${forbiddenDraft ? "; Salesforce doesn't allow Active → Draft" : ""}); 2) change ${labels}; 3) it stays Inactive unless you also ask to activate it again. While it is Inactive, products using it get no tax treatment from it.` }],
        offers: inactive ? [{ label: `Deactivate "${r.name}", then change ${labels} (stays Inactive)`, operation: { key: `${op.key}l`, op: "update", object: op.object, target: { id: r.id }, fields: { Status: inactive, ...Object.fromEntries(locked.map(k => [k, fields[k]])) } } }] : [] };
    }
    if (op.object === "TaxTreatment" && Object.keys(fields).length) issues.push({ severity: "warning", code: "ACTIVE_TREATMENT", message: "Salesforce doesn't allow editing most fields of an Active Tax Treatment — if it refuses, deactivate it first (Active → Inactive) or create a new treatment." });
  }
  if (Object.keys(fields).length) {
    const changes = await Promise.all(Object.entries(fields).map(async ([k, v]) => change(o.fields[k], current[k] ?? null, o.fields[k].type === "reference" ? await nameOf(ctx, o.fields[k].referenceTo[0] ?? null, (current[k] as string) ?? null) : null, v, display[k] ?? null)));
    steps.push({ id: `${op.key}:update`, opKey: op.key, kind: "update", object: op.object, recordId: r.id, recordName: r.name, fields, changes, detail: `Update ${changes.map(c => c.label).join(", ")} on ${o.label} "${r.name}".` });
    ctx.overlay.set(r.id, { ...(ctx.overlay.get(r.id) ?? {}), ...fields });
  }
  if (!steps.length && !issues.some(i => i.severity === "error")) return { ...base, status: "no-change", record, issues: [...issues, { severity: "info", code: "NO_CHANGE", message: `${o.label} "${r.name}" already has these values.` }] };
  return { ...base, status: issues.some(i => i.severity === "error") ? "blocked" : "ready", record, steps, issues, offers: offers.length ? offers : undefined };
}

async function previewAssign(ctx: Ctx, op: AssistantOperation, base: OpPreview, block: Block): Promise<OpPreview> {
  if (!op.relation?.object) return block("MISSING_TARGET", "What should it be assigned to?");
  // Resolve BOTH existing records first; an assignment never validates a create payload.
  const src = await resolveRecord(ctx, op.object, op.target, `${op.key}:target`);
  const tgt = await resolveRecord(ctx, op.relation.object, op.relation.target, `${op.key}:relation`);
  const label = (obj: string) => objectMeta(ctx.meta, obj)?.label ?? obj;
  const choices: Choices = [];
  if (src.status === "multiple") choices.push({ selectionKey: `${op.key}:target`, prompt: `Several ${label(op.object)} records match — choose one.`, options: src.options });
  if (tgt.status === "multiple") choices.push({ selectionKey: `${op.key}:relation`, prompt: `Several ${label(op.relation.object)} records match — choose one.`, options: tgt.options });
  const notFound = [src.status === "none" ? { obj: op.object, r: src, key: "target" } : null, tgt.status === "none" ? { obj: op.relation.object, r: tgt, key: "relation" } : null].filter(Boolean) as { obj: string; r: Extract<Resolved, { status: "none" }>; key: string }[];
  if (notFound.length) return { ...base, status: "blocked", choices: [...choices, ...notFound.filter(n => n.r.options.length).map(n => ({ selectionKey: `${op.key}:${n.key}`, prompt: `Select the correct ${label(n.obj)}`, options: n.r.options }))],
    issues: notFound.map(n => ({ severity: "error" as const, code: "RECORD_NOT_FOUND", object: n.obj, message: `${n.r.message} Nothing will be changed.` })) };
  if (choices.length || src.status !== "found" || tgt.status !== "found") return { ...base, status: "needs-selection", choices };
  const rel = chooseRelationship(ctx.meta, op.object, op.relation.object, op.relation.kind, ctx.selections[`${op.key}:relfield`] ?? op.relation.field);
  if (rel.status === "none") return block("NO_RELATIONSHIP", rel.message);
  if (rel.status === "ambiguous") return { ...base, status: "needs-selection", choices: [{ selectionKey: `${op.key}:relfield`, prompt: `${op.object} and ${op.relation.object} are related by more than one field — which one?`, options: rel.options.map(x => ({ id: x.field, name: `${x.on === "source" ? op.object : op.relation!.object}.${x.field}`, detail: x.label })) }] };
  const updated = rel.on === "source" ? src : tgt, other = rel.on === "source" ? tgt : src;
  const updatedObj = rel.on === "source" ? op.object : op.relation.object, otherObj = rel.on === "source" ? op.relation.object : op.object;
  const f = objectMeta(ctx.meta, updatedObj)!.fields[rel.field];
  const relationship = { sourceObject: op.object, sourceRecord: src.name, field: rel.field, fieldLabel: f.label, targetObject: op.relation.object, targetRecord: tgt.name, updatedObject: updatedObj };
  const record = { id: updated.id, name: updated.name, status: (updated.row.Status as string) ?? null };
  if (!SUPPORTED[updatedObj]?.update || (SUPPORTED[updatedObj].onlyFields && !SUPPORTED[updatedObj].onlyFields!.includes(rel.field))) return { ...block("NOT_ALLOWED", `${updatedObj}.${rel.field} can't be changed here.`), relationship };
  if (!f.updateable) {
    const offers: NonNullable<OpPreview["offers"]> = [];
    if (updatedObj === "TaxTreatmentItem") offers.push({ label: `Create a new Tax Treatment Item for the same product under "${other.name}"`, operation: { key: `${op.key}n`, op: "create", object: "TaxTreatmentItem", fields: { Name: updated.name, TaxTreatmentId: { id: other.id }, ProductId: { id: String(updated.row.ProductId ?? "") }, TaxCode: updated.row.TaxCode ?? null, ProductCode: updated.row.ProductCode ?? null } } });
    return { ...base, status: "blocked", record, relationship, offers, issues: [{ severity: "error", code: "CREATE_ONLY_FIELD", object: updatedObj, field: rel.field, message: `${updatedObj}.${rel.field} (${f.label}) can only be set when the record is created — Salesforce doesn't allow re-assigning it.${offers.length ? " Create a new record under the new parent instead (and delete the old one separately)." : ""}` }] };
  }
  const current = { ...updated.row, ...(ctx.overlay.get(updated.id) ?? {}) };
  if (sameValue(current[rel.field], other.id)) return { ...base, status: "no-change", record, relationship, issues: [{ severity: "info", code: "NO_CHANGE", message: `${updated.name} already has ${f.label} = ${other.name} (${other.id}).` }] };
  const rules = await relationshipRules(ctx, base, block, op.key, updatedObj, updated, f, otherObj, other);
  if (rules.blocked) return { ...base, status: "blocked", record, relationship, steps: [], issues: rules.issues, offers: rules.offers };
  const steps = [...rules.steps, { id: `${op.key}:assign`, opKey: op.key, kind: "update" as const, object: updatedObj, recordId: updated.id, recordName: updated.name, fields: { [rel.field]: other.id },
    changes: [change(f, current[rel.field] ?? null, await nameOf(ctx, f.referenceTo[0] ?? null, (current[rel.field] as string) ?? null), other.id, other.name)], detail: `Set ${updatedObj}.${rel.field} on "${updated.name}" → "${other.name}" (${other.id}).` }];
  ctx.overlay.set(updated.id, { ...(ctx.overlay.get(updated.id) ?? {}), [rel.field]: other.id });
  return { ...base, status: rules.issues.some(i => i.severity === "error") ? "blocked" : "ready", record, relationship, steps, issues: rules.issues, offers: rules.offers.length ? rules.offers : undefined };
}

async function previewLifecycle(ctx: Ctx, op: AssistantOperation, base: OpPreview, block: Block, known?: Found): Promise<OpPreview> {
  const o = objectMeta(ctx.meta, op.object)!;
  let r = known ?? null;
  if (!r) {
    const res = await resolveRecord(ctx, op.object, op.target, `${op.key}:target`);
    if (res.status === "multiple") return { ...base, status: "needs-selection", choices: [{ selectionKey: `${op.key}:target`, prompt: `Several ${o.label} records match — which one?`, options: res.options }] };
    if (res.status === "none") return block("RECORD_NOT_FOUND", `${res.message} Nothing will be changed.`);
    r = res;
  }
  const current = { ...r.row, ...(ctx.overlay.get(r.id) ?? {}) };
  const record = { id: r.id, name: r.name, status: (current.Status as string) ?? null };
  const issues: PlanIssue[] = [];
  const steps: OpStep[] = [];
  if (op.op === "end-date") {
    const f = o.fields.EndDate;
    if (!f?.updateable) return block("NOT_SUPPORTED", `${o.label} has no updateable End Date.`);
    const date = op.date && DATE.test(op.date) ? op.date : today();
    if (current.StartDate && String(current.StartDate) > date) issues.push({ severity: "error", code: "INVALID_DATE", object: op.object, field: "EndDate", message: `End date ${date} is before the start date ${current.StartDate}.` });
    steps.push({ id: `${op.key}:enddate`, opKey: op.key, kind: "update", object: op.object, recordId: r.id, recordName: r.name, fields: { EndDate: date }, changes: [change(f, current.EndDate ?? null, null, date, null)], detail: `End-date ${o.label} "${r.name}" on ${date}.` });
    if (op.object === "TaxRate") issues.push({ severity: "info", code: "REFRESH_DECISION_TABLE", message: "After rates change, a Salesforce admin refreshes the tax engine's decision table so the change is used." });
    ctx.overlay.set(r.id, { ...(ctx.overlay.get(r.id) ?? {}), EndDate: date });
    return { ...base, status: issues.some(i => i.severity === "error") ? "blocked" : "ready", record, steps, issues };
  }
  const f = o.fields.Status;
  const wanted = picklistValue(ctx.meta, op.object, "Status", op.op === "activate" ? "Active" : op.op === "draft" ? "Draft" : "Inactive");
  if (!f || !wanted) return block("NOT_SUPPORTED", `${o.label} has no "${op.op === "activate" ? "Active" : op.op === "draft" ? "Draft" : "Inactive"}" status in this org (values: ${f?.picklist.map(p => p.value).join(", ") ?? "none"}).`);
  if (!f.updateable && !isRef(r.id)) return block("FIELD_NOT_WRITABLE", `${o.label} Status can't be changed by the current user.`);
  const draft = picklistValue(ctx.meta, op.object, "Status", "Draft");
  if (current.Status === wanted) {
    if (op.op !== "activate") ctx.lifecycleNoop.add(r.id);
    return { ...base, status: "no-change", record, issues: [{ severity: "info", code: "NO_CHANGE", message: `${o.label} "${r.name}" is already ${wanted} — no status change.` }] };
  }
  // Deactivating a Draft record is never needed (it isn't active) — and it would make a later "re-activate" activate it.
  if (op.op === "deactivate" && draft && current.Status === draft) {
    ctx.lifecycleNoop.add(r.id);
    return { ...base, status: "no-change", record, issues: [{ severity: "info", code: "NO_CHANGE", message: `${o.label} "${r.name}" is Draft — it isn't active, so there is nothing to deactivate. Draft records can be edited directly.` }] };
  }
  // Re-activation only restores a status the record had: if the deactivate in this request was unnecessary, there is nothing to restore.
  if (op.op === "activate" && ctx.lifecycleNoop.has(r.id)) return { ...base, status: "no-change", record, issues: [{ severity: "info", code: "NOT_REACTIVATED", message: `Not activated: "${r.name}" was ${current.Status ?? "not Active"} before this request and no deactivation was needed, so there is no status to restore. Ask explicitly to activate it if you want it Active.` }] };
  const forbidden = STATUS_RULES[op.object]?.forbidden.find(([a, b]) => a === current.Status && b === wanted);
  if (forbidden) return block("INVALID_STATUS", `Salesforce doesn't allow changing a ${o.label}'s status from ${forbidden[0]} to ${forbidden[1]} ("Can't change status from ${forbidden[0]} to ${forbidden[1]}"). Nothing will be changed.`);
  if (op.op === "activate" && op.object === "TaxPolicy") {
    const sel = current.TreatmentSelection;
    const defId = (current.DefaultTaxTreatmentId as string) ?? null;
    if (!defId && sel === picklistValue(ctx.meta, "TaxPolicy", "TreatmentSelection", "Default")) {
      return { ...base, status: "blocked", record, issues: [{ severity: "error", code: "DEFAULT_TREATMENT_REQUIRED", object: "TaxPolicy", field: "DefaultTaxTreatmentId", message: `Tax Policy "${r.name}" uses Default selection but has no default Tax Treatment — assign one first (e.g. "Set <treatment> as the default treatment for ${r.name}").` }] };
    }
    if (defId) {
      const tr = isRef(defId) ? null : await resolveRecord(ctx, "TaxTreatment", { id: defId }, "__none");
      const found = tr?.status === "found" ? tr : null;
      const trRow = found ? { ...found.row, ...(ctx.overlay.get(found.id) ?? {}) } : ctx.planned.find(p => `@{${p.stepId}}` === defId)?.fields ?? {};
      const trActive = picklistValue(ctx.meta, "TaxTreatment", "Status", "Active");
      if (trRow.Status === picklistValue(ctx.meta, "TaxTreatment", "Status", "Inactive")) return { ...base, status: "blocked", record, issues: [{ severity: "error", code: "DEFAULT_TREATMENT_INACTIVE", object: "TaxTreatment", message: `The default treatment "${found?.name ?? defId}" is Inactive — reactivate it or assign another default first.` }] };
      if (trRow.Status !== trActive) {
        const trName = found?.name ?? ctx.planned.find(p => `@{${p.stepId}}` === defId)?.name ?? "the default treatment";
        const lc = await previewLifecycle(ctx, { key: `${op.key}:pre`, op: "activate", object: "TaxTreatment", target: { id: isRef(defId) ? null : defId } }, { ...base, steps: [] }, block, found ?? { status: "found", id: defId, name: trName, row: trRow });
        steps.push(...lc.steps); issues.push(...lc.issues, { severity: "info", code: "LIFECYCLE_ORDER", message: `Default treatment "${trName}" is ${trRow.Status ?? "not Active"} — it is activated first, then the policy (separate requests).` });
      }
    }
  }
  if (op.op === "activate" && op.object === "TaxTreatment" && current.IsTaxable && !current.TaxEngineId) issues.push({ severity: "warning", code: "NO_TAX_ENGINE", object: "TaxTreatment", field: "TaxEngineId", message: `Taxable treatment "${r.name}" has no Tax Engine — Salesforce can't calculate tax with it.` });
  if (op.op !== "activate" && op.object === "TaxPolicy" && !isRef(r.id)) {
    const [c] = await q(ctx, `SELECT COUNT(Id) n FROM Product2 WHERE TaxPolicyId = '${soqlEscape(r.id)}'`);
    if (Number(c?.n) > 0) issues.push({ severity: "warning", code: "PRODUCTS_AFFECTED", message: `${c.n} product(s) use this policy — while it isn't Active they get no tax treatment from it.` });
  }
  if (op.op !== "activate" && op.object === "TaxTreatment" && !isRef(r.id)) {
    const pols = await q(ctx, `SELECT Name FROM TaxPolicy WHERE DefaultTaxTreatmentId = '${soqlEscape(r.id)}' AND Status = 'Active'`);
    if (pols.length) issues.push({ severity: "warning", code: "DEFAULT_OF_ACTIVE_POLICY", message: `It is the default treatment of Active policy ${pols.map(p => `"${p.Name}"`).join(", ")} — Salesforce may refuse, or those products lose their treatment.` });
  }
  steps.push({ id: `${op.key}:status`, opKey: op.key, kind: "update", object: op.object, recordId: r.id, recordName: r.name, fields: { Status: wanted }, changes: [change(f, current.Status ?? null, null, wanted, null)], detail: `${opLabel(op.op)} ${o.label} "${r.name}" (${current.Status ?? "—"} → ${wanted}).` });
  ctx.overlay.set(r.id, { ...(ctx.overlay.get(r.id) ?? {}), Status: wanted });
  return { ...base, status: issues.some(i => i.severity === "error") ? "blocked" : "ready", record, steps, issues };
}

async function previewReplace(ctx: Ctx, op: AssistantOperation, base: OpPreview, block: Block): Promise<OpPreview> {
  if (op.object !== "TaxRate") return block("NOT_SUPPORTED", "Replace applies to Tax Rates (their tax code and geography are create-only).");
  return previewUpdate(ctx, { ...op, op: "update", fields: { ...(op.fields ?? {}) } }, { ...base, op: "replace" }, block).then(p => (p.steps.some(s => s.kind === "replace-rate") || p.status !== "ready" ? p : { ...p, issues: [...p.issues, { severity: "info", code: "IN_PLACE", message: "These fields can be changed in place — no replacement rate is needed." }] }));
}

async function previewDelete(ctx: Ctx, op: AssistantOperation, base: OpPreview, block: Block): Promise<OpPreview> {
  const o = objectMeta(ctx.meta, op.object)!;
  if (!SUPPORTED[op.object].delete) return block("NOT_DELETABLE", `${o.label} records can't be deleted here.`);
  if (o.deletable === false) return block("NOT_DELETABLE", `The current user can't delete ${o.label} records.`);
  const r = await resolveRecord(ctx, op.object, op.target, `${op.key}:target`);
  if (r.status === "multiple") return { ...base, status: "needs-selection", choices: [{ selectionKey: `${op.key}:target`, prompt: `Several ${o.label} records match — choose the exact one to delete (nothing is deleted on an ambiguous name).`, options: r.options }] };
  if (r.status === "none") return block("RECORD_NOT_FOUND", `${r.message} Nothing will be deleted.`);
  if (isRef(r.id)) return block("NOT_DELETABLE", "A record being created in this same request can't be deleted.");
  // Verified Salesforce rule: items of an Active treatment can't be deleted (DELETE_NOT_ALLOWED).
  if (op.object === "TaxTreatmentItem" && r.row.TaxTreatmentId) {
    const [tr] = await q(ctx, `SELECT Id, Name, Status FROM TaxTreatment WHERE Id = '${soqlEscape(String(r.row.TaxTreatmentId))}'`);
    if (tr && tr.Status === picklistValue(ctx.meta, "TaxTreatment", "Status", "Active")) return { ...block("DELETE_NOT_ALLOWED", `Salesforce doesn't allow deleting items of an Active Tax Treatment ("Tax Treatment Items cannot be deleted for an active tax treatment") — "${tr.Name}" is Active. Deactivate the treatment first.`), record: { id: r.id, name: r.name, status: null } };
  }
  // Dependencies: every child relationship describe reports, counted in Salesforce (cascade deletes flagged).
  const d = await rawDescribe(ctx, op.object);
  const rels = ((d?.childRelationships ?? []) as { childSObject: string; field: string; relationshipName: string | null; cascadeDelete: boolean }[])
    .filter(c => c.relationshipName && !/(History|Share|Feed|ChangeEvent|Approval|FlowOrchestration|ProcessInstance|Attachment|Note|Activity|Task|Event|Email|ContentDocument|TopicAssignment|EntitySubscription|DuplicateRecord|RecordAction|CollaborationGroup|AttachedContent|CombinedAttachment|NetworkActivity|DocumentEnvelope|GeneratedDocument|Interaction)/.test(c.childSObject));
  const dependencies: OpPreview["dependencies"] = [];
  for (const c of rels.slice(0, 25)) {
    const [row] = await q(ctx, `SELECT COUNT(Id) n FROM ${c.childSObject} WHERE ${c.field} = '${soqlEscape(r.id)}'`);
    const n = Number(row?.n ?? 0);
    if (n > 0) dependencies.push({ label: `${c.childSObject}.${c.field}`, count: n, cascade: c.cascadeDelete, detail: c.cascadeDelete ? `${n} ${c.childSObject} record(s) would be DELETED with it (cascade)` : `${n} ${c.childSObject} record(s) reference it — Salesforce may refuse the delete or clear the reference` });
  }
  const issues: PlanIssue[] = [];
  if (dependencies.some(x => x.cascade)) issues.push({ severity: "warning", code: "CASCADE_DELETE", message: `Deleting "${r.name}" also deletes ${dependencies.filter(x => x.cascade).map(x => `${x.count} ${x.label.split(".")[0]}`).join(", ")}.` });
  if (r.row.Status === "Active") issues.push({ severity: "warning", code: "ACTIVE_RECORD", message: `"${r.name}" is Active — Salesforce may refuse to delete active tax records; deactivate it first if it does.` });
  return { ...base, status: "ready", record: { id: r.id, name: r.name, status: (r.row.Status as string) ?? null }, dependencies, issues,
    steps: [{ id: `${op.key}:delete`, opKey: op.key, kind: "delete", object: op.object, recordId: r.id, recordName: r.name, fields: {}, changes: [], detail: `Delete ${o.label} "${r.name}" (${r.id}).` }] };
}

async function previewShow(ctx: Ctx, op: AssistantOperation, base: OpPreview, block: Block): Promise<OpPreview> {
  const o = objectMeta(ctx.meta, op.object)!;
  const r = await resolveRecord(ctx, op.object, op.target, `${op.key}:target`);
  if (r.status === "multiple") return { ...base, status: "needs-selection", choices: [{ selectionKey: `${op.key}:target`, prompt: `Several ${o.label} records match — which one?`, options: r.options }] };
  if (r.status === "none") return block("RECORD_NOT_FOUND", r.message);
  const all = selectable(ctx.meta, op.object, Object.keys(o.fields).filter(k => !["IsDeleted", "SystemModstamp", "LastViewedDate", "LastReferencedDate"].includes(k)));
  const [row] = await q(ctx, `SELECT ${all.join(", ")} FROM ${op.object} WHERE Id = '${soqlEscape(r.id)}'`);
  const fields = await Promise.all(Object.entries(row ?? {}).filter(([k, v]) => k !== "attributes" && v !== null && o.fields[k]).map(async ([k, v]) => ({ label: o.fields[k].label, value: o.fields[k].type === "reference" ? `${await nameOf(ctx, o.fields[k].referenceTo[0] ?? null, String(v))} (${v})` : String(v) })));
  const related: { label: string; rows: string[] }[] = [];
  const rel = (s: string) => q(ctx, s);
  if (op.object === "TaxPolicy") {
    const tr = await rel(`SELECT Id, Name, Status, IsTaxable, TaxCode, ShouldUseTaxTreatmentItems FROM TaxTreatment WHERE TaxPolicyId = '${soqlEscape(r.id)}'`);
    related.push({ label: "Tax Treatments", rows: tr.map(t => `${t.Name} · ${t.Status} · ${t.IsTaxable ? "taxable" : "not taxable"}${t.TaxCode ? ` · ${t.TaxCode}` : ""}${t.Id === row?.DefaultTaxTreatmentId ? " · DEFAULT" : ""} (${t.Id})`) });
    if (tr.length) { const items = await rel(`SELECT Name, Product.Name, TaxCode, TaxTreatment.Name FROM TaxTreatmentItem WHERE TaxTreatmentId IN (${idList(tr.map(t => t.Id as string))})`); related.push({ label: "Tax Treatment Items", rows: items.map(i => `${(i.Product as Record<string, unknown> | null)?.Name ?? "—"} → ${(i.TaxTreatment as Record<string, unknown> | null)?.Name ?? "—"} · ${i.TaxCode ?? "—"}`) }); }
    const pr = await rel(`SELECT Name, ProductCode FROM Product2 WHERE TaxPolicyId = '${soqlEscape(r.id)}' ORDER BY Name LIMIT 25`);
    related.push({ label: "Products", rows: pr.map(p => `${p.Name}${p.ProductCode ? ` (${p.ProductCode})` : ""}`) });
  } else if (op.object === "TaxTreatment") {
    const items = await rel(`SELECT Name, Product.Name, TaxCode FROM TaxTreatmentItem WHERE TaxTreatmentId = '${soqlEscape(r.id)}'`);
    related.push({ label: "Tax Treatment Items", rows: items.map(i => `${(i.Product as Record<string, unknown> | null)?.Name ?? "—"} · ${i.TaxCode ?? "—"}`) });
    const pols = await rel(`SELECT Name, Status FROM TaxPolicy WHERE DefaultTaxTreatmentId = '${soqlEscape(r.id)}'`);
    related.push({ label: "Default treatment of", rows: pols.map(p => `${p.Name} · ${p.Status}`) });
  } else if (op.object === "TaxEngine") {
    const tr = await rel(`SELECT Name, Status FROM TaxTreatment WHERE TaxEngineId = '${soqlEscape(r.id)}'`);
    related.push({ label: "Tax Treatments using it", rows: tr.map(t => `${t.Name} · ${t.Status}`) });
  } else if (op.object === "GeoCountry") {
    const rates = await rel(`SELECT TaxCode, Rate, StartDate, EndDate FROM TaxRate WHERE GeoCountryId = '${soqlEscape(r.id)}'`);
    related.push({ label: "Tax Rates", rows: rates.map(x => `${x.TaxCode} ${x.Rate}% · ${x.StartDate ?? "—"} → ${x.EndDate ?? "open"}`) });
  }
  return { ...base, status: "info", record: { id: r.id, name: r.name, status: (row?.Status as string) ?? null }, view: { fields, related } };
}

/* ───────────────────────────── Execute ───────────────────────────── */

export async function executeOperations(client: SalesforceClient, req: AssistantRequest, token: string | null): Promise<AssistantResult> {
  return executeWith(await orgApiFor(client), req, token);
}

export async function executeWith(api: TaxOrgApi, req: AssistantRequest, token: string | null): Promise<AssistantResult> {
  const preview = await previewWith(api, req);
  const fail = (message: string, code: string): AssistantResult => ({ success: false, message, audit: [], failure: { step: "preview", object: "", code, field: null, message, recommendation: "Review the refreshed preview." }, preview });
  if (!preview.ok) return fail("Nothing was changed: the preview has blocked items or needs a selection.", "NOT_READY");
  if (!token || token !== preview.token) return fail("Salesforce changed since the preview (or the preview wasn't confirmed). Review the refreshed preview and confirm again.", "STALE");
  const meta = api.meta;
  const ids = new Map<string, string>();
  const resolve = (val: unknown) => (isRef(val) ? ids.get(val.slice(2, -1)) ?? val : val);
  const audit: AuditEntry[] = [];
  let failure: AssistantResult["failure"] = null;
  const steps = preview.operations.flatMap(p => p.steps.map(s => ({ s, p })));
  for (const { s, p } of steps) {
    const now = new Date().toISOString();
    const entry: AuditEntry = { operation: opLabel(p.op), object: s.object, recordName: s.recordName, recordId: s.recordId && !isRef(s.recordId) ? s.recordId : null, fields: s.changes.map(c => ({ field: c.field, label: c.label, before: c.currentDisplay, after: c.nextDisplay })), timestamp: now, result: "not-run", message: s.detail };
    if (failure) { audit.push(entry); continue; }
    const body = Object.fromEntries(Object.entries(s.fields).map(([k, val]) => [k, resolve(val)]));
    if (JSON.stringify(body).includes("@{")) { failure = { step: s.id, object: s.object, code: "UNRESOLVED_REFERENCE", field: null, message: `${s.detail} depends on a record that wasn't created.`, recommendation: "Preview again." }; entry.result = "failed"; audit.push(entry); continue; }
    try {
      if (s.kind === "replace-rate") {
        const input = { rateId: s.recordId!, effectiveDate: s.replacement!.effectiveDate, changes: s.replacement!.changes };
        const pr = await api.previewRateReplacement(input);
        const out = await api.executeRateReplacement(input, pr.token);
        if (!out.success) throw Object.assign(new Error(out.failure?.message ?? out.message), { code: out.failure?.code ?? null, field: out.failure?.field ?? null });
        ids.set(s.id, out.newRateId!);
        entry.recordId = out.newRateId; entry.result = "success"; entry.message = out.message;
        audit.push(entry); continue;
      }
      const recordId = s.recordId ? String(resolve(s.recordId)) : null;
      const res = await api.write(s.kind === "create" ? "POST" : s.kind === "delete" ? "DELETE" : "PATCH", s.object, s.kind === "create" ? null : recordId, s.kind === "delete" ? null : body);
      if (res.status >= 400) { const e = (Array.isArray(res.json) ? res.json[0] : null) as { message?: string; errorCode?: string; fields?: string[] } | null; throw Object.assign(new Error(e?.message ?? res.statusText ?? `HTTP ${res.status}`), { code: e?.errorCode ?? `HTTP_${res.status}`, field: errorField(e) }); }
      if (s.kind === "create") { const id = (res.json as { id?: string } | null)?.id ?? null; if (id) ids.set(s.id, id); entry.recordId = id; }
      else if (recordId) { ids.set(s.id, recordId); entry.recordId = recordId; }
      entry.result = "success";
    } catch (e) {
      const err = e as Error & { code?: string | null; field?: string | null };
      failure = { step: s.id, object: s.object, code: err.code ?? null, field: err.field ?? null, message: err.message, recommendation: recommendationFor(err.code, err.field, err.message) };
      entry.result = "failed"; entry.message = `Salesforce rejected it (${err.code ?? "error"}): ${err.message}`;
    }
    audit.push(entry);
  }
  // Re-read every changed record from Salesforce (deleted ones must be gone) — success is only what Salesforce now holds.
  for (const [i, { s }] of steps.entries()) {
    const entry = audit[i];
    if (entry.result !== "success" || !entry.recordId) continue;
    if (s.kind === "replace-rate") continue; // verified by the rate replacement service itself
    if (s.kind === "delete") { const [row] = await api.query(`SELECT Id FROM ${s.object} WHERE Id = '${soqlEscape(entry.recordId)}'`).catch(() => []); if (row) { entry.result = "verification-failed"; entry.message = "Salesforce reported success but the record still exists."; } else entry.message = `Deleted — no longer in Salesforce.`; continue; }
    const fields = Object.keys(s.fields).filter(k => objectMeta(meta, s.object)?.fields[k]);
    const [row] = await api.query(`SELECT Id${fields.length ? `, ${fields.join(", ")}` : ""} FROM ${s.object} WHERE Id = '${soqlEscape(entry.recordId)}'`).catch(() => []);
    const bad = fields.filter(k => !sameValue(row?.[k], resolve(s.fields[k])));
    if (!row || bad.length) { entry.result = "verification-failed"; entry.message = row ? `Salesforce holds different values for ${bad.join(", ")}.` : "Record not found after the change."; }
    else entry.message = `Verified in Salesforce: ${fields.map(k => `${k} = ${row[k]}`).join(", ") || "record exists"}.`;
  }
  const okAll = !failure && audit.every(a => a.result === "success");
  return { success: okAll, audit, failure, preview, message: failure ? `Stopped at "${steps.find(x => x.s.id === failure!.step)?.s.detail}": ${failure.message}${audit.some(a => a.result === "success") ? " Earlier steps were applied (see the audit trail)." : " Nothing was changed."}` : okAll ? `${audit.length} change(s) applied and verified in Salesforce.` : "Applied, but some values differ when re-read from Salesforce — see the audit trail." };
}

/** The module key a record of `object` opens in (for links from the UI). */
export const moduleKeyFor = (object: string) => moduleOf(object)?.key ?? (getBillingModule("legal-entities")?.candidates[0] === object ? "legal-entities" : null);
