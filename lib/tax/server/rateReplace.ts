import { createHash } from "node:crypto";
import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { compositeAt, queryAt, SalesforceCallError } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata, field, objectMeta, selectable } from "@/lib/tax/server/metadata";
import { errorField, recommendationFor } from "@/lib/tax/server/errors";
import type { PlanIssue } from "@/lib/tax/types";
import { evaluateTaxRateRules } from "@/lib/tax/server/rateRules";

/**
 * TAX RATE REPLACEMENT. TaxRate.TaxCode, GeoCountryId and GeoStateId are create-only (verified by describe), so changing them can't
 * be an edit: a NEW rate is created with the changed values (other values copied from the old rate), effective from a chosen date,
 * and the old rate is end-dated the day before — in ONE all-or-nothing Composite request, previewed and confirmed first, then both
 * records re-read and verified. Updateable fields (Rate, Priority, dates…) are edited in place through the normal edit form instead.
 */

const COPY = ["TaxCode", "ProductCode", "GeoCountryId", "GeoStateId", "Rate", "Priority", "RateUsageType", "City", "ZipCode", "ApplicationBasis", "FlatTaxAmount", "LegalEntityId", "EndDate"];
const CHANGEABLE = new Set(["TaxCode", "GeoCountryId", "GeoStateId", "Rate", "Priority", "ProductCode", "City", "ZipCode", "ApplicationBasis", "FlatTaxAmount", "LegalEntityId", "RateUsageType", "EndDate"]);
const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export interface RateReplacementInput { rateId: string; effectiveDate: string; changes: Record<string, unknown> }
export interface RateReplacementPreview {
  success: true; ok: boolean;
  oldRate: Record<string, unknown>;
  oldRatePatch: { EndDate: string };
  newRate: Record<string, unknown>;
  changed: string[];
  issues: PlanIssue[];
  token: string;
}

export async function previewRateReplacement(client: SalesforceClient, input: RateReplacementInput): Promise<RateReplacementPreview> {
  if (!SFID.test(input.rateId)) throw new SalesforceCallError("Invalid Tax Rate Id.", 400, [{ message: "Invalid Tax Rate Id.", errorCode: "INVALID_ID" }], null);
  const meta = await discoverTaxMetadata(client);
  const issues: PlanIssue[] = [];
  const err = (code: string, message: string, f?: string) => issues.push({ severity: "error", code, message, object: "TaxRate", field: f });
  if (!objectMeta(meta, "TaxRate")?.createable) err("NOT_CREATEABLE", "The current user can't create Tax Rates.");
  const cols = selectable(meta, "TaxRate", ["Id", "Name", "StartDate", ...COPY]);
  const [old] = await queryAt(client, meta.apiVersion, `SELECT ${cols.join(", ")} FROM TaxRate WHERE Id = '${soqlEscape(input.rateId)}' LIMIT 1`);
  if (!old) throw new SalesforceCallError("Tax Rate not found in the connected org.", 404, [{ message: "Tax Rate not found.", errorCode: "NOT_FOUND" }], null);
  delete (old as Record<string, unknown>).attributes;
  const eff = input.effectiveDate;
  if (!DATE.test(eff ?? "")) err("INVALID_DATE", "Give the date the replacement rate takes effect (YYYY-MM-DD).", "StartDate");
  const oldStart = (old.StartDate as string | null) ?? null;
  if (oldStart && eff && eff <= oldStart) err("INVALID_DATE", `The replacement must start after the current rate's start date (${oldStart}).`, "StartDate");
  if (!field(meta, "TaxRate", "EndDate")?.updateable) err("FIELD_NOT_WRITABLE", "TaxRate.EndDate can't be updated by the current user, so the current rate can't be end-dated.", "EndDate");

  const newRate: Record<string, unknown> = {};
  for (const f of COPY) if (cols.includes(f) && old[f] !== null && old[f] !== undefined) newRate[f] = old[f];
  const changed: string[] = [];
  for (const [k, v] of Object.entries(input.changes ?? {})) {
    if (!CHANGEABLE.has(k)) { err("INVALID_FIELD", `${k} can't be set on a replacement rate here.`, k); continue; }
    const fm = field(meta, "TaxRate", k);
    if (!fm || !fm.createable) { err("INVALID_FIELD", `TaxRate.${k} isn't createable in this org.`, k); continue; }
    const value = v === "" ? null : v;
    if (fm.type === "picklist" && value !== null && !fm.picklist.some(p => p.value === value)) { err("INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", `"${value}" isn't a valid ${fm.label} (valid: ${fm.picklist.map(p => p.value).join(", ")}).`, k); continue; }
    if (fm.type === "reference" && value !== null && !(typeof value === "string" && SFID.test(value))) { err("INVALID_CROSS_REFERENCE_KEY", `Pick the ${fm.label} from Salesforce.`, k); continue; }
    if (["double", "int", "percent", "currency"].includes(fm.type) && value !== null && !Number.isFinite(Number(value))) { err("INVALID_NUMBER", `${fm.label} must be a number.`, k); continue; }
    const norm = value !== null && ["double", "int", "percent", "currency"].includes(fm.type) ? Number(value) : value;
    if (norm !== (old[k] ?? null)) changed.push(k);
    if (norm === null) delete newRate[k]; else newRate[k] = norm;
  }
  newRate.StartDate = eff;
  if (typeof newRate.Rate === "number" && (newRate.Rate < 0 || newRate.Rate > 100)) err("INVALID_RATE", "A tax rate must be between 0 and 100%.", "Rate");
  if (newRate.EndDate && eff && String(newRate.EndDate) < eff) err("INVALID_DATE", `End date ${newRate.EndDate} is before the start date ${eff}.`, "EndDate");
  // The replacement is a NEW rate: it must satisfy the same rules as any created rate. Values copied from a legacy rate (e.g.
  // Commerce / Gross, no legal entity) are NOT carried over silently — the user must change them in this replacement.
  for (const r of evaluateTaxRateRules({ mode: "create", values: newRate, availableFields: Object.keys(objectMeta(meta, "TaxRate")?.fields ?? {}), today: new Date().toISOString().slice(0, 10) })) {
    if (r.code === "RATE_EXPIRED") continue; // the replacement's own end date is validated above
    issues.push({ severity: r.severity, code: r.code, message: `Replacement rate: ${r.message}`, object: "TaxRate", field: r.field ?? undefined });
  }
  if (!changed.length) issues.push({ severity: "warning", code: "NO_CHANGE", message: "Nothing differs from the current rate except the dates — editing Rate/Priority/dates in place may be enough." });
  // A replacement must not collide with another rate for the same code + geography + legal entity on the new dates.
  if (newRate.TaxCode && newRate.GeoCountryId) {
    const clash = await queryAt(client, meta.apiVersion, `SELECT Id, Name, StartDate, EndDate FROM TaxRate WHERE Id != '${soqlEscape(input.rateId)}' AND TaxCode = '${soqlEscape(String(newRate.TaxCode))}' AND GeoCountryId = '${soqlEscape(String(newRate.GeoCountryId))}'${newRate.GeoStateId ? ` AND GeoStateId = '${soqlEscape(String(newRate.GeoStateId))}'` : " AND GeoStateId = null"}${newRate.LegalEntityId ? ` AND LegalEntityId = '${soqlEscape(String(newRate.LegalEntityId))}'` : ""} AND (EndDate = null OR EndDate >= ${eff})`).catch(e => { err("TAX_RECORDS_UNREADABLE", `Existing rates couldn't be checked for a clash (${e instanceof Error ? e.message : String(e)}) — nothing is replaced until they can be read.`); return []; });
    if (clash.length) err("DUPLICATE_VALUE", `Tax rate ${clash[0].Name} already covers tax code ${newRate.TaxCode} for this geography from ${clash[0].StartDate ?? "—"} — end-date it first or choose another code.`, "TaxCode");
  }
  const oldRatePatch = { EndDate: eff && DATE.test(eff) ? dayBefore(eff) : "" };
  const token = createHash("sha256").update(JSON.stringify([input.rateId, old, newRate, oldRatePatch])).digest("hex").slice(0, 24);
  return { success: true, ok: !issues.some(i => i.severity === "error"), oldRate: old, oldRatePatch, newRate, changed, issues, token };
}

export interface RateReplacementResult {
  success: boolean; message: string; newRateId: string | null; oldRateId: string;
  failure: { code: string | null; field: string | null; message: string; recommendation: string } | null;
  verification: { label: string; passed: boolean; detail: string }[];
  preview: RateReplacementPreview;
}

export async function executeRateReplacement(client: SalesforceClient, input: RateReplacementInput, token: string | null): Promise<RateReplacementResult> {
  const preview = await previewRateReplacement(client, input);
  const base = { oldRateId: input.rateId, preview, verification: [] as RateReplacementResult["verification"] };
  if (!preview.ok) { const e = preview.issues.find(i => i.severity === "error")!; return { ...base, success: false, newRateId: null, message: `Nothing was changed: ${e.message}`, failure: { code: e.code, field: e.field ?? null, message: e.message, recommendation: recommendationFor(e.code, e.field, e.message) } }; }
  if (!token || token !== preview.token) return { ...base, success: false, newRateId: null, message: "The rate changed in Salesforce since the preview — review the refreshed preview and confirm again.", failure: { code: "STALE", field: null, message: "Preview is out of date.", recommendation: "Review the refreshed preview." } };
  const meta = await discoverTaxMetadata(client);
  const res = await compositeAt(client, meta.apiVersion, [
    { method: "POST", url: "/sobjects/TaxRate", referenceId: "newRate", body: preview.newRate },
    { method: "PATCH", url: `/sobjects/TaxRate/${input.rateId}`, referenceId: "oldRate", body: preview.oldRatePatch },
  ]);
  if (!res.ok) {
    const e = res.errors[0];
    const f = errorField(e);
    return { ...base, success: false, newRateId: null, message: `Salesforce rejected the replacement (${e?.errorCode ?? "error"}): ${e?.message ?? "unknown"} — nothing was changed (all-or-nothing).`, failure: { code: e?.errorCode ?? null, field: f, message: e?.message ?? "", recommendation: recommendationFor(e?.errorCode, f, e?.message) } };
  }
  const newRateId = (res.results.find(r => r.referenceId === "newRate")?.body as { id?: string } | null)?.id ?? null;
  const cols = selectable(meta, "TaxRate", ["Id", "StartDate", "EndDate", "TaxCode", "Rate", "GeoCountryId", "GeoStateId"]);
  const rows = await queryAt(client, meta.apiVersion, `SELECT ${cols.join(", ")} FROM TaxRate WHERE Id IN ('${soqlEscape(input.rateId)}'${newRateId ? `,'${soqlEscape(newRateId)}'` : ""})`);
  const oldRow = rows.find(r => r.Id === input.rateId), newRow = rows.find(r => r.Id === newRateId);
  const verification = [
    { label: "Replacement rate exists", passed: !!newRow, detail: newRow ? `${newRateId} · ${newRow.TaxCode} ${newRow.Rate}% from ${newRow.StartDate}` : "not found" },
    ...Object.entries(preview.newRate).filter(([k]) => cols.includes(k)).map(([k, v]) => ({ label: `New rate ${k}`, passed: !!newRow && (typeof v === "number" ? Math.abs(Number(newRow[k]) - v) < 0.0001 : newRow[k] === v || String(newRow[k] ?? "").slice(0, 15) === String(v).slice(0, 15)), detail: `expected ${v}, Salesforce has ${newRow?.[k] ?? "blank"}` })),
    { label: "Previous rate end-dated", passed: oldRow?.EndDate === preview.oldRatePatch.EndDate, detail: `EndDate ${oldRow?.EndDate ?? "blank"} (expected ${preview.oldRatePatch.EndDate})` },
  ];
  const passed = verification.every(v => v.passed);
  return { ...base, success: passed, newRateId, verification, failure: null, message: passed ? `Replacement rate ${newRateId} created from ${input.effectiveDate}; the previous rate ends ${preview.oldRatePatch.EndDate}. Refresh the tax engine's decision table in Salesforce so the change is used.` : "Salesforce accepted the replacement but the re-read values differ — see verification." };
}
