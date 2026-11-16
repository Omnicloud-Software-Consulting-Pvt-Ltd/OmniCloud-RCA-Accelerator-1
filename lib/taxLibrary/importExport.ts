import Papa from "papaparse";
import { createRecord, normalizeInput, updateRecord, validateInput, type Issue } from "@/lib/taxLibrary/library";
import { identityKey, type RateCalculation, type TaxRateInput, type TaxRateReference, type VerificationStatus } from "@/lib/taxLibrary/types";

/**
 * Import / export for the Global Tax Rate Library — CSV or JSON, one flat row per rate (FLAT_COLUMNS). Import is two-phase:
 * `previewImport` validates every row and decides create / update / unchanged / conflict / error WITHOUT changing anything;
 * `applyImport` then applies only the valid create/update rows. Matching is by rate identity + Effective From (a safe upsert):
 *  · same identity + same Effective From → update that record's metadata (rate/date changes still go through New Version),
 *  · overlapping period with a different start → conflict (never silently replaces history).
 * Reference storage only — imports never touch Salesforce.
 */

export const FLAT_COLUMNS = [
  "countryCode", "subdivisionCode", "locality",
  "taxCode", "officialTaxCode", "taxCodeGenerated", "taxName", "taxType", "taxStructure", "taxComponent", "taxAuthority", "taxCategory",
  "ratePercent", "fixedAmount", "fixedAmountCurrency", "minRatePercent", "maxRatePercent", "calculation", "compound", "componentOrder",
  "classificationSystem", "classificationCode", "productCategory", "serviceCategory", "classificationDescription", "conditions", "transactionType", "placeOfSupply",
  "effectiveFrom", "effectiveTo", "lifecycle",
  "sourceName", "sourceOrganization", "sourceUrl", "sourceReference", "notes", "verification", "lastVerifiedAt",
] as const;
export type FlatRow = Partial<Record<(typeof FLAT_COLUMNS)[number], string | number | boolean | null>>;

const s = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v).trim() || null);
const num = (v: unknown): number | null => { const t = s(v); if (t === null) return null; const n = Number(t.replace(/%$/, "")); return Number.isFinite(n) ? n : NaN; };
const bool = (v: unknown) => /^(true|yes|1|y)$/i.test(String(v ?? "").trim());

export function rowToInput(row: FlatRow): TaxRateInput {
  return {
    jurisdiction: { countryCode: s(row.countryCode) ?? "", countryName: "", subdivisionCode: s(row.subdivisionCode), subdivisionName: null, level: "country", locality: s(row.locality) },
    tax: { taxCode: s(row.taxCode) ?? "", taxName: s(row.taxName) ?? "", taxType: s(row.taxType) ?? "", taxStructure: s(row.taxStructure) ?? s(row.taxType) ?? "", taxComponent: s(row.taxComponent), taxAuthority: s(row.taxAuthority), taxCategory: s(row.taxCategory), ...(s(row.officialTaxCode) ? { officialTaxCode: s(row.officialTaxCode) } : {}), ...(bool(row.taxCodeGenerated) ? { taxCodeGenerated: true } : {}) },
    rate: {
      ratePercent: num(row.ratePercent), fixedAmount: num(row.fixedAmount), fixedAmountCurrency: s(row.fixedAmountCurrency), minRatePercent: num(row.minRatePercent), maxRatePercent: num(row.maxRatePercent),
      calculation: (s(row.calculation) ?? (num(row.fixedAmount) !== null && num(row.ratePercent) === null ? "fixed-amount" : "percentage")) as RateCalculation,
      compound: bool(row.compound), componentOrder: num(row.componentOrder),
    },
    classification: { system: s(row.classificationSystem), code: s(row.classificationCode), productCategory: s(row.productCategory), serviceCategory: s(row.serviceCategory), description: s(row.classificationDescription), conditions: s(row.conditions), transactionType: s(row.transactionType), placeOfSupply: s(row.placeOfSupply) },
    effective: { effectiveFrom: s(row.effectiveFrom) ?? "", effectiveTo: s(row.effectiveTo) },
    source: { sourceName: s(row.sourceName), ...(s(row.sourceOrganization) ? { sourceOrganization: s(row.sourceOrganization) } : {}), sourceUrl: s(row.sourceUrl), sourceReference: s(row.sourceReference), notes: s(row.notes), verification: (s(row.verification) ?? "unverified") as VerificationStatus, lastVerifiedAt: s(row.lastVerifiedAt) },
    lifecycle: s(row.lifecycle) === "draft" ? "draft" : "published",
  };
}

export function recordToRow(r: TaxRateReference): FlatRow {
  return {
    countryCode: r.jurisdiction.countryCode, subdivisionCode: r.jurisdiction.subdivisionCode, locality: r.jurisdiction.locality,
    taxCode: r.tax.taxCode, officialTaxCode: r.tax.officialTaxCode ?? null, taxCodeGenerated: r.tax.taxCodeGenerated ?? false, taxName: r.tax.taxName, taxType: r.tax.taxType, taxStructure: r.tax.taxStructure, taxComponent: r.tax.taxComponent, taxAuthority: r.tax.taxAuthority, taxCategory: r.tax.taxCategory,
    ratePercent: r.rate.ratePercent, fixedAmount: r.rate.fixedAmount, fixedAmountCurrency: r.rate.fixedAmountCurrency, minRatePercent: r.rate.minRatePercent, maxRatePercent: r.rate.maxRatePercent, calculation: r.rate.calculation, compound: r.rate.compound, componentOrder: r.rate.componentOrder,
    classificationSystem: r.classification.system, classificationCode: r.classification.code, productCategory: r.classification.productCategory, serviceCategory: r.classification.serviceCategory, classificationDescription: r.classification.description, conditions: r.classification.conditions, transactionType: r.classification.transactionType, placeOfSupply: r.classification.placeOfSupply,
    effectiveFrom: r.effective.effectiveFrom, effectiveTo: r.effective.effectiveTo, lifecycle: r.lifecycle === "archived" ? "published" : r.lifecycle,
    sourceName: r.source.sourceName, sourceOrganization: r.source.sourceOrganization ?? null, sourceUrl: r.source.sourceUrl, sourceReference: r.source.sourceReference, notes: r.source.notes, verification: r.source.verification, lastVerifiedAt: r.source.lastVerifiedAt,
  };
}

export function exportRecords(records: TaxRateReference[], format: "csv" | "json"): string {
  const rows = records.map(recordToRow);
  return format === "json" ? JSON.stringify(rows, null, 2) : Papa.unparse({ fields: [...FLAT_COLUMNS], data: rows.map(r => FLAT_COLUMNS.map(c => r[c] ?? "")) });
}

export function parseImport(text: string, format: "csv" | "json"): { rows: FlatRow[]; errors: string[] } {
  if (format === "json") {
    try {
      const data = JSON.parse(text) as unknown;
      const arr = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { rates?: unknown }).rates) ? (data as { rates: unknown[] }).rates : null;
      if (!arr) return { rows: [], errors: ["JSON must be an array of rate rows (or { \"rates\": [...] })."] };
      return { rows: arr.filter((x): x is FlatRow => !!x && typeof x === "object"), errors: [] };
    } catch (e) { return { rows: [], errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] }; }
  }
  const res = Papa.parse<FlatRow>(text.trim(), { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });
  const unknown = (res.meta.fields ?? []).filter(f => !(FLAT_COLUMNS as readonly string[]).includes(f));
  return { rows: res.data, errors: [...res.errors.map(e => `Row ${(e.row ?? 0) + 2}: ${e.message}`), ...(unknown.length ? [`Unknown columns ignored: ${unknown.join(", ")}`] : [])] };
}

/** unmapped = the row's country / subdivision isn't an ISO 3166 jurisdiction (or the subdivision isn't in that country). */
export type ImportAction = "create" | "update" | "unchanged" | "conflict" | "unmapped" | "error";
export interface ImportPreviewRow { index: number; action: ImportAction; input: TaxRateInput | null; targetId: string | null; label: string; errors: Issue[]; warnings: Issue[] }

export function previewImport(records: TaxRateReference[], rows: FlatRow[]): ImportPreviewRow[] {
  const accepted: TaxRateReference[] = [];
  return rows.map((row, index) => {
    const input = normalizeInput(rowToInput(row));
    const label = `${input.jurisdiction.subdivisionCode ?? input.jurisdiction.countryCode} · ${input.tax.taxCode || "?"} · ${input.rate.ratePercent ?? input.rate.fixedAmount ?? "?"}${input.rate.ratePercent !== null ? "%" : ""} · from ${input.effective.effectiveFrom || "?"}`;
    if (Number.isNaN(input.rate.ratePercent) || Number.isNaN(input.rate.fixedAmount)) return { index, action: "error", input, targetId: null, label, errors: [{ field: "ratePercent", severity: "error", message: "Rate values must be numbers." }], warnings: [] };
    const same = records.find(r => r.lifecycle !== "archived" && identityKey(r) === identityKey(input) && r.effective.effectiveFrom === input.effective.effectiveFrom);
    if (same) {
      const res = updateRecord(records, same.id, input);
      if (!res.ok) return { index, action: res.errors[0]?.message.includes("New Version") ? "conflict" : "error", input, targetId: same.id, label, errors: res.errors, warnings: res.warnings };
      return { index, action: res.value === same ? "unchanged" : "update", input, targetId: same.id, label, errors: [], warnings: res.warnings };
    }
    const { errors, warnings } = validateInput(input, [...records, ...accepted]);
    if (errors.length) return { index, action: errors.some(e => e.field === "countryCode" || e.field === "subdivisionCode") ? "unmapped" : errors.some(e => e.message.startsWith("Overlaps")) ? "conflict" : "error", input, targetId: null, label, errors, warnings };
    const probe = createRecord([...records, ...accepted], input, { id: `preview-${index}` });
    if (probe.ok) accepted.push(probe.value); // later rows in the same file are checked against earlier ones (no in-file duplicates)
    return { index, action: "create", input, targetId: null, label, errors: [], warnings };
  });
}

/** Applies the create/update rows of a preview. Returns the new full record list and counts. */
export function applyImport(records: TaxRateReference[], preview: ImportPreviewRow[], opts: { origin: string; now?: string }): { records: TaxRateReference[]; created: number; updated: number; skipped: number } {
  let out = records.slice();
  let created = 0, updated = 0, skipped = 0;
  for (const p of preview) {
    if (p.action === "create" && p.input) {
      const r = createRecord(out, p.input, { origin: opts.origin, now: opts.now });
      if (r.ok) { out.push(r.value); created++; } else skipped++;
    } else if (p.action === "update" && p.input && p.targetId) {
      const r = updateRecord(out, p.targetId, p.input, { now: opts.now });
      if (r.ok) { out = out.map(x => (x.id === p.targetId ? { ...r.value, history: [...r.value.history.slice(0, -1), { ...r.value.history[r.value.history.length - 1], action: "imported" as const }] } : x)); updated++; } else skipped++;
    } else skipped++;
  }
  return { records: out, created, updated, skipped };
}
