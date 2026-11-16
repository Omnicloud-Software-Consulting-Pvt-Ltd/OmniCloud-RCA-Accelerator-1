import { getCountry, getSubdivision, resolveCountryCode, resolveSubdivisionCode } from "@/lib/taxLibrary/jurisdictions";
import {
  identityKey, periodsOverlap, statusOf, todayIso,
  type AuditEntry, type EffectiveStatus, type RateCalculation, type TaxRateInput, type TaxRateReference, type VerificationStatus,
} from "@/lib/taxLibrary/types";

/**
 * Global Tax Rate Library — pure operations over the reference records (no storage, no Salesforce). The store
 * (lib/taxLibrary/store.ts) persists their results; the UI and tests call these directly.
 *
 * Integrity rules:
 *  · Many rates per jurisdiction are normal. Only the SAME rate identity (identityKey: jurisdiction + tax type + tax code +
 *    component + classification + transaction type) may not have two non-draft records with overlapping effective periods.
 *  · A published record's rate or start date is never edited in place: `newVersion` closes it (Effective To = day before) and
 *    adds version n+1 in the same lineage. Records are archived, never deleted.
 */

export interface Issue { field: string; severity: "error" | "warning"; message: string }
export type Result<T> = { ok: true; value: T; warnings: Issue[] } | { ok: false; errors: Issue[]; warnings: Issue[] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string | null | undefined) => !!s && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const CALCS: RateCalculation[] = ["percentage", "fixed-amount", "percentage-plus-fixed", "tiered"];
const VERIFICATIONS: VerificationStatus[] = ["verified", "unverified", "needs-review"];

export function newId(prefix = "rate"): string {
  const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${rnd}`;
}

export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Normalize names/codes from the jurisdiction reference (the input's codes win; names are re-derived so they can't drift). */
export function normalizeInput(input: TaxRateInput): TaxRateInput {
  const cc = resolveCountryCode(input.jurisdiction.countryCode) ?? input.jurisdiction.countryCode.trim().toUpperCase();
  const country = getCountry(cc);
  const subCode = input.jurisdiction.subdivisionCode ? resolveSubdivisionCode(input.jurisdiction.subdivisionCode, cc) ?? input.jurisdiction.subdivisionCode.trim().toUpperCase() : null;
  const sub = getSubdivision(subCode);
  const t = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    ...input,
    jurisdiction: {
      countryCode: cc, countryName: country?.name ?? input.jurisdiction.countryName,
      subdivisionCode: subCode, subdivisionName: sub?.name ?? (subCode ? input.jurisdiction.subdivisionName : null),
      level: input.jurisdiction.locality ? "locality" : subCode ? "subdivision" : "country",
      locality: t(input.jurisdiction.locality),
    },
    tax: { ...input.tax, taxCode: input.tax.taxCode.trim(), taxName: input.tax.taxName.trim(), taxType: input.tax.taxType.trim(), taxStructure: input.tax.taxStructure.trim(), taxComponent: t(input.tax.taxComponent), taxAuthority: t(input.tax.taxAuthority), taxCategory: t(input.tax.taxCategory), ...(t(input.tax.officialTaxCode) ? { officialTaxCode: t(input.tax.officialTaxCode) } : {}), ...(input.tax.taxCodeGenerated ? { taxCodeGenerated: true } : {}) },
    classification: Object.fromEntries(Object.entries(input.classification).map(([k, v]) => [k, t(v as string | null)])) as unknown as TaxRateInput["classification"],
    effective: { effectiveFrom: input.effective.effectiveFrom.trim(), effectiveTo: t(input.effective.effectiveTo) },
    source: { ...input.source, sourceName: t(input.source.sourceName), ...(t(input.source.sourceOrganization) ? { sourceOrganization: t(input.source.sourceOrganization) } : {}), sourceUrl: t(input.source.sourceUrl), sourceReference: t(input.source.sourceReference), notes: t(input.source.notes), lastVerifiedAt: t(input.source.lastVerifiedAt) },
  };
}

/** Field validation + duplicate/overlap checks against the existing records (`selfIds` are excluded, e.g. the record being edited). */
export function validateInput(input: TaxRateInput, existing: TaxRateReference[], selfIds: string[] = []): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const e = (field: string, message: string) => errors.push({ field, severity: "error", message });
  const w = (field: string, message: string) => warnings.push({ field, severity: "warning", message });
  const j = input.jurisdiction;
  if (!getCountry(j.countryCode)) e("countryCode", `"${j.countryCode}" isn't an ISO 3166-1 country code.`);
  if (j.subdivisionCode) {
    const s = getSubdivision(j.subdivisionCode);
    if (!s) e("subdivisionCode", `"${j.subdivisionCode}" isn't an ISO 3166-2 subdivision code.`);
    else if (s.countryCode !== j.countryCode.toUpperCase()) e("subdivisionCode", `${s.code} (${s.name}) belongs to ${s.countryCode}, not ${j.countryCode}.`);
  }
  if (!input.tax.taxCode) e("taxCode", "Tax Code is required.");
  else if (input.tax.taxCode.length > 255) e("taxCode", "Tax Code is longer than Salesforce's 255 characters.");
  if (!input.tax.taxName) e("taxName", "Tax Name is required.");
  if (!input.tax.taxType) e("taxType", "Tax Type is required (e.g. GST, VAT, Sales Tax).");
  if (!input.tax.taxStructure) e("taxStructure", "Tax Structure is required (e.g. \"GST + PST\").");
  const r = input.rate;
  if (!CALCS.includes(r.calculation)) e("calculation", `Unknown calculation type "${r.calculation}".`);
  const needsPct = r.calculation === "percentage" || r.calculation === "percentage-plus-fixed" || r.calculation === "tiered";
  const needsFixed = r.calculation === "fixed-amount" || r.calculation === "percentage-plus-fixed";
  if (needsPct && (r.ratePercent === null || !Number.isFinite(r.ratePercent))) e("ratePercent", "Rate % is required for this calculation type.");
  if (r.ratePercent !== null && (r.ratePercent < 0 || r.ratePercent > 100)) e("ratePercent", "Rate % must be between 0 and 100.");
  if (needsFixed && (r.fixedAmount === null || !Number.isFinite(r.fixedAmount))) e("fixedAmount", "A fixed amount is required for this calculation type.");
  if (r.fixedAmount !== null && r.fixedAmount < 0) e("fixedAmount", "Fixed amount can't be negative.");
  if (r.fixedAmount !== null && !r.fixedAmountCurrency) w("fixedAmountCurrency", "Give the currency of the fixed amount.");
  if (r.minRatePercent !== null && r.maxRatePercent !== null && r.minRatePercent > r.maxRatePercent) e("minRatePercent", "Minimum rate is above the maximum rate.");
  if (!isDate(input.effective.effectiveFrom)) e("effectiveFrom", "Effective From must be a date (YYYY-MM-DD).");
  if (input.effective.effectiveTo && !isDate(input.effective.effectiveTo)) e("effectiveTo", "Effective To must be a date (YYYY-MM-DD).");
  if (isDate(input.effective.effectiveFrom) && input.effective.effectiveTo && isDate(input.effective.effectiveTo) && input.effective.effectiveTo < input.effective.effectiveFrom) e("effectiveTo", "Effective To is before Effective From.");
  if (input.source.sourceUrl && !/^https?:\/\/\S+$/i.test(input.source.sourceUrl)) e("sourceUrl", "Source URL must start with http:// or https://.");
  if (!VERIFICATIONS.includes(input.source.verification)) e("verification", "Unknown verification status.");
  if (input.source.verification === "verified" && !input.source.sourceName && !input.source.sourceUrl) e("verification", "A verified rate needs its source (name or URL).");
  if (input.source.verification === "verified" && !input.source.lastVerifiedAt) w("lastVerifiedAt", "Record when it was verified (Last Verified At).");

  if (errors.length === 0 && input.lifecycle !== "draft") {
    const key = identityKey(input);
    const clash = existing.find(x => !selfIds.includes(x.id) && x.lifecycle === "published" && identityKey(x) === key && periodsOverlap(x.effective, input.effective));
    if (clash) e("effectiveFrom", `Overlaps "${clash.tax.taxName}" (${clash.effective.effectiveFrom} → ${clash.effective.effectiveTo ?? "open"}) — the same tax code, type, component and classification in ${clash.jurisdiction.subdivisionName ?? clash.jurisdiction.countryName}. Close that one first (New Version) or change the period.`);
  }
  return { errors, warnings };
}

const audit = (action: AuditEntry["action"], detail: string, now: string): AuditEntry => ({ at: now, action, detail });

function changedFields(a: TaxRateInput, b: TaxRateInput): string[] {
  const out: string[] = [];
  for (const group of ["jurisdiction", "tax", "rate", "classification", "effective", "source"] as const) {
    const ag = a[group] as unknown as Record<string, unknown>, bg = b[group] as unknown as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ag), ...Object.keys(bg)])) if (JSON.stringify(ag[k] ?? null) !== JSON.stringify(bg[k] ?? null)) out.push(k);
  }
  if (a.lifecycle !== b.lifecycle) out.push("lifecycle");
  return out;
}

export function createRecord(records: TaxRateReference[], input: TaxRateInput, opts: { now?: string; origin?: string; id?: string } = {}): Result<TaxRateReference> {
  const now = opts.now ?? new Date().toISOString();
  const n = normalizeInput(input);
  const { errors, warnings } = validateInput(n, records);
  if (errors.length) return { ok: false, errors, warnings };
  const id = opts.id ?? newId();
  const rec: TaxRateReference = { ...n, id, lineageId: id, version: 1, supersedesId: null, origin: opts.origin ?? "user", createdAt: now, updatedAt: now, history: [audit(opts.origin?.startsWith("import") ? "imported" : "created", `Created (${n.lifecycle}).`, now)] };
  return { ok: true, value: rec, warnings };
}

const RATE_FIELDS = ["ratePercent", "fixedAmount", "calculation", "effectiveFrom"];

/**
 * Edit a record's fields. Corrections to a published record's rate or start date are refused — use `newVersion` so the
 * previous rate is kept as history. Drafts can be edited freely. Never touches Salesforce.
 */
export function updateRecord(records: TaxRateReference[], id: string, input: TaxRateInput, opts: { now?: string } = {}): Result<TaxRateReference> {
  const now = opts.now ?? new Date().toISOString();
  const cur = records.find(r => r.id === id);
  if (!cur) return { ok: false, errors: [{ field: "id", severity: "error", message: "Record not found." }], warnings: [] };
  if (cur.lifecycle === "archived") return { ok: false, errors: [{ field: "lifecycle", severity: "error", message: "Archived records are read-only — restore it first." }], warnings: [] };
  const n = normalizeInput(input);
  const changed = changedFields(cur, n);
  if (cur.lifecycle === "published" && changed.some(f => RATE_FIELDS.includes(f))) {
    return { ok: false, errors: [{ field: "ratePercent", severity: "error", message: "A published rate's value or start date can't be overwritten — use New Version to close this one and add the new rate, keeping history." }], warnings: [] };
  }
  if (!changed.length) return { ok: true, value: cur, warnings: [] };
  const { errors, warnings } = validateInput(n, records, [id]);
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, value: { ...cur, ...n, updatedAt: now, history: [...cur.history, audit("updated", `Changed: ${changed.join(", ")}.`, now)] }, warnings };
}

/**
 * Rate change: closes `id` the day before `effectiveFrom` and adds the next version (same lineage). The old record stays
 * (history); returns both. `changes` overrides any part of the record for the new version (usually rate + dates).
 */
export function newVersion(records: TaxRateReference[], id: string, changes: Omit<Partial<TaxRateInput>, "effective"> & { effective: { effectiveFrom: string; effectiveTo?: string | null } }, opts: { now?: string } = {}): Result<{ closed: TaxRateReference; created: TaxRateReference }> {
  const now = opts.now ?? new Date().toISOString();
  const cur = records.find(r => r.id === id);
  const fail = (message: string, field = "effectiveFrom"): Result<never> => ({ ok: false, errors: [{ field, severity: "error", message }], warnings: [] });
  if (!cur) return fail("Record not found.", "id");
  if (cur.lifecycle !== "published") return fail("Only a published rate can be versioned — edit the draft instead.", "lifecycle");
  if (records.some(r => r.supersedesId === cur.id && r.lifecycle !== "archived")) return fail("This version already has a newer version — version the latest one.", "id");
  const from = changes.effective.effectiveFrom;
  if (!isDate(from)) return fail("The new version needs an Effective From date.");
  if (from <= cur.effective.effectiveFrom) return fail(`The new version must start after the current one (${cur.effective.effectiveFrom}).`);
  // The current version ends the day before the new one (or keeps an earlier end date — a gap between versions is allowed).
  const closed: TaxRateReference = { ...cur, effective: { ...cur.effective, effectiveTo: cur.effective.effectiveTo && cur.effective.effectiveTo < dayBefore(from) ? cur.effective.effectiveTo : dayBefore(from) }, updatedAt: now,
    history: [...cur.history, audit("superseded", `Closed on ${dayBefore(from)} — superseded by version ${cur.version + 1}.`, now)] };
  const input = normalizeInput({
    jurisdiction: changes.jurisdiction ?? cur.jurisdiction, tax: changes.tax ?? cur.tax, rate: changes.rate ?? cur.rate, classification: changes.classification ?? cur.classification,
    effective: { effectiveFrom: from, effectiveTo: changes.effective.effectiveTo ?? null }, source: changes.source ?? cur.source, lifecycle: "published",
  });
  if (identityKey(input) !== identityKey(cur)) return fail("A new version must keep the same jurisdiction, tax code, type, component and classification — create a separate rate instead.", "taxCode");
  const others = records.map(r => (r.id === cur.id ? closed : r));
  const { errors, warnings } = validateInput(input, others);
  if (errors.length) return { ok: false, errors, warnings };
  const created: TaxRateReference = { ...input, id: newId(), lineageId: cur.lineageId, version: cur.version + 1, supersedesId: cur.id, origin: "user", createdAt: now, updatedAt: now,
    history: [audit("versioned", `Version ${cur.version + 1} — replaces ${cur.tax.taxName} from ${from}.`, now)] };
  return { ok: true, value: { closed, created }, warnings };
}

export function duplicateRecord(records: TaxRateReference[], id: string, opts: { now?: string } = {}): Result<TaxRateReference> {
  const now = opts.now ?? new Date().toISOString();
  const cur = records.find(r => r.id === id);
  if (!cur) return { ok: false, errors: [{ field: "id", severity: "error", message: "Record not found." }], warnings: [] };
  const nid = newId();
  return { ok: true, warnings: [], value: { ...cur, id: nid, lineageId: nid, version: 1, supersedesId: null, lifecycle: "draft", origin: "user", tax: { ...cur.tax, taxName: `${cur.tax.taxName} (copy)` },
    source: { ...cur.source, verification: "unverified", lastVerifiedAt: null }, createdAt: now, updatedAt: now, history: [audit("duplicated", `Duplicated from ${cur.id} as a draft.`, now)] } };
}

export function setArchived(records: TaxRateReference[], id: string, archived: boolean, opts: { now?: string } = {}): Result<TaxRateReference> {
  const now = opts.now ?? new Date().toISOString();
  const cur = records.find(r => r.id === id);
  if (!cur) return { ok: false, errors: [{ field: "id", severity: "error", message: "Record not found." }], warnings: [] };
  if (!archived) {
    const restored: TaxRateReference = { ...cur, lifecycle: "published" };
    const { errors } = validateInput(restored, records, [id]);
    if (errors.length) return { ok: false, errors, warnings: [] };
  }
  return { ok: true, warnings: [], value: { ...cur, lifecycle: archived ? "archived" : "published", updatedAt: now, history: [...cur.history, audit(archived ? "archived" : "restored", archived ? "Archived (kept as history, hidden from active use)." : "Restored.", now)] } };
}

/** Replace/insert records by id (store helper). */
export function upsertAll(records: TaxRateReference[], changed: TaxRateReference[]): TaxRateReference[] {
  const byId = new Map(changed.map(r => [r.id, r]));
  const out = records.map(r => byId.get(r.id) ?? r);
  for (const r of changed) if (!records.some(x => x.id === r.id)) out.push(r);
  return out;
}

/** All versions of a record's lineage, newest first. */
export function lineageOf(records: TaxRateReference[], id: string): TaxRateReference[] {
  const r = records.find(x => x.id === id);
  return r ? records.filter(x => x.lineageId === r.lineageId).sort((a, b) => b.version - a.version) : [];
}

/* ───────────────────────────── Search / filter / sort / paginate ───────────────────────────── */

export interface LibraryQuery {
  q?: string;
  countryCode?: string | null;
  /**
   * ISO 3166-2 code (e.g. "AU-VIC") — matched by CODE, never by display name. Explicit rule: a subdivision shows its own rates PLUS
   * the country's national (country-level) rates, which apply in every subdivision — unless includeCountryLevel is false.
   * Region-specific national records (e.g. "Canary Islands" from TEDB, no ISO subdivision) are not shown under a subdivision.
   * "__country__" = national rates only; "__region__" = region-specific rates without an ISO subdivision.
   */
  subdivisionCode?: string | null;
  /** With a subdivision selected: also show national rates that apply there (default true). */
  includeCountryLevel?: boolean;
  taxStructure?: string | null;
  taxType?: string | null;
  taxCode?: string | null;
  /** "__none__" = records that are not a component of a combined structure. */
  taxComponent?: string | null;
  classification?: string | null;
  /** Only rates in effect on this date (YYYY-MM-DD). */
  asOf?: string | null;
  statuses?: EffectiveStatus[];
  verification?: VerificationStatus[];
  sort?: { by: "country" | "subdivision" | "taxCode" | "taxName" | "taxType" | "rate" | "effectiveFrom" | "effectiveTo" | "status"; dir: "asc" | "desc" };
  page?: number;
  pageSize?: number;
  today?: string;
}
export const COUNTRY_LEVEL = "__country__";
export const REGION_SPECIFIC = "__region__";

/** Lower-case and strip diacritics, so "karnataka" finds ISO's "Karnātaka" and "quebec" finds "Québec". */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** National (applies country-wide): no subdivision and not tied to a named region. */
export const isNational = (r: TaxRateReference) => !r.jurisdiction.subdivisionCode && !r.jurisdiction.locality;
export const NO_COMPONENT = "__none__";

export const classificationLabel = (r: TaxRateReference) => {
  const c = r.classification;
  const code = [c.system, c.code].filter(Boolean).join(" ");
  return code || c.productCategory || c.serviceCategory || null;
};

export function matchesQuery(r: TaxRateReference, q: LibraryQuery, today = q.today ?? todayIso()): boolean {
  if (q.countryCode && r.jurisdiction.countryCode !== q.countryCode) return false;
  if (q.subdivisionCode === COUNTRY_LEVEL) { if (!isNational(r)) return false; }
  else if (q.subdivisionCode === REGION_SPECIFIC) { if (r.jurisdiction.subdivisionCode || !r.jurisdiction.locality) return false; }
  else if (q.subdivisionCode) {
    const subCountry = q.subdivisionCode.split("-")[0];
    if (q.countryCode && subCountry !== q.countryCode) return false; // invalid country/state combination → nothing, never leakage
    const own = r.jurisdiction.subdivisionCode === q.subdivisionCode;
    const national = q.includeCountryLevel !== false && r.jurisdiction.countryCode === subCountry && isNational(r);
    if (!own && !national) return false;
  }
  if (q.taxStructure && r.tax.taxStructure !== q.taxStructure) return false;
  if (q.taxType && r.tax.taxType !== q.taxType) return false;
  if (q.taxCode && r.tax.taxCode !== q.taxCode) return false;
  if (q.taxComponent === NO_COMPONENT) { if (r.tax.taxComponent) return false; }
  else if (q.taxComponent && r.tax.taxComponent !== q.taxComponent) return false;
  if (q.asOf && (r.effective.effectiveFrom > q.asOf || (r.effective.effectiveTo !== null && r.effective.effectiveTo < q.asOf))) return false;
  if (q.classification && classificationLabel(r) !== q.classification) return false;
  if (q.statuses?.length && !q.statuses.includes(statusOf(r, today))) return false;
  if (q.verification?.length && !q.verification.includes(r.source.verification)) return false;
  const term = q.q?.trim().toLowerCase();
  if (term) {
    const hay = foldText([r.jurisdiction.countryName, r.jurisdiction.countryCode, r.jurisdiction.subdivisionName, r.jurisdiction.subdivisionCode, r.jurisdiction.locality,
      r.tax.taxCode, r.tax.taxName, r.tax.taxType, r.tax.taxStructure, r.tax.taxComponent, r.tax.taxCategory, r.tax.taxAuthority, r.tax.officialTaxCode,
      r.classification.code, r.classification.system, r.classification.productCategory, r.classification.serviceCategory, r.classification.description,
      r.classification.conditions, r.classification.transactionType, r.source.sourceName, r.source.sourceOrganization, r.source.sourceReference].filter(Boolean).join(" "));
    if (!foldText(term).split(/\s+/).every(t => hay.includes(t))) return false;
  }
  return true;
}

export const PAGE_SIZES = [10, 15, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 15;

/** Filter → sort (stable: ties broken by record id) → paginate. `from`/`to` are 1-based positions (0/0 when empty). */
export function queryLibrary(records: TaxRateReference[], q: LibraryQuery): { rows: TaxRateReference[]; total: number; page: number; pageCount: number; from: number; to: number } {
  const today = q.today ?? todayIso();
  const filtered = records.filter(r => matchesQuery(r, q, today));
  const by = q.sort?.by ?? "country";
  const dir = q.sort?.dir === "desc" ? -1 : 1;
  const key = (r: TaxRateReference): string | number => {
    switch (by) {
      case "country": return `${r.jurisdiction.countryName}|${r.jurisdiction.subdivisionName ?? ""}|${r.tax.taxCode}|${r.effective.effectiveFrom}`;
      case "subdivision": return `${r.jurisdiction.subdivisionName ?? ""}|${r.tax.taxCode}`;
      case "taxCode": return r.tax.taxCode.toLowerCase();
      case "taxName": return r.tax.taxName.toLowerCase();
      case "taxType": return r.tax.taxType.toLowerCase();
      case "rate": return r.rate.ratePercent ?? -1;
      case "effectiveFrom": return r.effective.effectiveFrom;
      case "effectiveTo": return r.effective.effectiveTo ?? "9999-12-31";
      case "status": return statusOf(r, today);
    }
  };
  const sorted = filtered.slice().sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : a.id.localeCompare(b.id)) * dir; });
  const pageSize = Math.max(1, Math.min(q.pageSize ?? DEFAULT_PAGE_SIZE, 200));
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(Math.max(1, q.page ?? 1), pageCount);
  const rows = sorted.slice((page - 1) * pageSize, page * pageSize);
  return { rows, total: sorted.length, page, pageCount, from: rows.length ? (page - 1) * pageSize + 1 : 0, to: (page - 1) * pageSize + rows.length };
}

/** Distinct values for filter dropdowns (from the records themselves — open vocabularies). */
export function facets(records: TaxRateReference[]) {
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));
  return {
    countries: uniq(records.map(r => r.jurisdiction.countryCode)),
    taxStructures: uniq(records.map(r => r.tax.taxStructure)),
    taxTypes: uniq(records.map(r => r.tax.taxType)),
    taxCodes: uniq(records.map(r => r.tax.taxCode)),
    taxComponents: uniq(records.map(r => r.tax.taxComponent)),
    classifications: uniq(records.map(classificationLabel)),
  };
}

/* ───────────────────────────── Product context ───────────────────────────── */

/**
 * Splits candidate rates by a product's classification metadata. Matching uses ONLY explicit classification codes/names (e.g. a
 * Revenue Cloud Product Classification) — never ProductCode or product name. Unclassified reference rates are "general".
 * Nothing is auto-selected: the user always chooses.
 */
export function splitByClassification(rates: TaxRateReference[], product: { classificationCode: string | null; classificationName: string | null } | null) {
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  const keys = product ? [norm(product.classificationCode), norm(product.classificationName)].filter(Boolean) : [];
  const classified = (r: TaxRateReference) => !!(r.classification.code || r.classification.productCategory || r.classification.serviceCategory);
  if (!keys.length) return { matching: [] as TaxRateReference[], general: rates.filter(r => !classified(r)), other: rates.filter(classified), hasProductClassification: false };
  const isMatch = (r: TaxRateReference) => [r.classification.code, r.classification.productCategory, r.classification.serviceCategory, classificationLabel(r)].some(v => keys.includes(norm(v)));
  return { matching: rates.filter(isMatch), general: rates.filter(r => !classified(r)), other: rates.filter(r => classified(r) && !isMatch(r)), hasProductClassification: true };
}
