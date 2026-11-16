import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { effectiveRefresh } from "@/lib/tax/server/engine";
import { idList } from "@/lib/tax/server/records";
import { compareInput, traceApiFor, traceInvoiceLineTax, type InvoiceTaxTrace } from "@/lib/tax/server/invoiceTaxTrace";
import { previewApiFor, previewDecisionTable } from "@/lib/tax/server/calculationDiagnostics";
import type { DecisionTablePreview, TaxInputs } from "@/lib/tax/server/calculationResult";
import type { InvoiceTaxLine } from "@/lib/tax/server/invoiceTax";

/**
 * TAX APPLICABILITY — does tax actually apply to an invoice line that Salesforce finished processing with TaxAmount 0 and no
 * InvoiceLineTax? A taxable treatment alone doesn't say so: tax applies only when a tax rate matches the line's inputs. A missing
 * InvoiceLineTax is therefore never, on its own, proof of a calculation failure — and never, on its own, proof of zero tax.
 *
 * Evidence (read-only; nothing is written, nothing is refreshed, no tax amount is computed):
 *  · the line's treatment → engine → decision table chain (SOQL, via the relationship trace);
 *  · Salesforce's OWN decision-table evaluation for the line's inputs (POST /connect/business-rules/decision-table/{id} — evaluates,
 *    stores nothing);
 *  · an independent comparison of the table's TaxRate source rows with the same inputs;
 *  · the table's freshness (a Tax Rate changed after its last refresh makes a "No Match" meaningless — p10 DOC-000000034/35).
 *
 * Verdict per line — only a positive proof lets posting continue:
 *  · NOT_APPLICABLE  table Active, refreshed and up to date, every required input present, Salesforce's evaluation says "No Match"
 *                    and no source row with a non-zero rate matches;
 *  · ZERO_RATE       the same, but Salesforce's evaluation matches only 0% rates (and no source row says otherwise);
 *  · APPLICABLE      Salesforce's evaluation matches a non-zero rate → InvoiceLineTax is required; its absence is a real failure;
 *  · UNDETERMINED    anything else (stale / unrefreshed table, inactive engine, blank required input, evaluation error, the two
 *                    evaluations disagree, an unreadable record) → posting stays blocked.
 */

export type LineTaxApplicability = "APPLICABLE" | "NOT_APPLICABLE" | "ZERO_RATE" | "UNDETERMINED";

export interface LineApplicability {
  invoiceLineId: string;
  line: string;
  verdict: LineTaxApplicability;
  /** Plain explanation, record names included. */
  reason: string;
  treatment: { id: string; name: string | null; taxable: boolean | null } | null;
  decisionTable: { id: string; name: string | null } | null;
  /** The rate Salesforce's evaluation matched (APPLICABLE / ZERO_RATE). */
  matchedRate: number | null;
  /** Reference only — the matched rate × the line's charge. NOT a Salesforce calculation, never used as a tax amount. */
  referenceAmount: number | null;
  preview: { matched: boolean; outcomeType: string | null; rates: (number | null)[]; error: string | null } | null;
}

export interface StaleTable { engineId: string; engine: string; table: string; tableId: string; refreshedAt: string | null; ratesChangedAfter: string[] }

export interface ApplicabilityApi {
  trace(invoiceId: string, invoiceLineId: string): Promise<InvoiceTaxTrace>;
  preview(input: { decisionTableId: string; decisionTableName: string | null; inputs: TaxInputs }): Promise<DecisionTablePreview>;
  /** Decision tables of the given treatments' engines that have Tax Rates changed after their last refresh. */
  staleTables(treatmentIds: string[]): Promise<StaleTable[]>;
  /** Every TaxRate row (the decision table's source) with the given fields; `truncated` when there were more than could be read. */
  rates(fields: string[]): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }>;
}

/** The most TaxRate rows read for the "can any rate apply?" check — more than this is reported as truncated, never assumed. */
export const MAX_RATE_ROWS = 2000;

/** Inputs taken from the invoice address — unknown (not "blank") when the line has no address at all. */
const ADDRESS_INPUTS = new Set(["Country", "State", "City", "ZipCode"]);
/** Inputs the trace assumes rather than reads (RateUsageType isn't stored on the line) — never used to exclude a rate. */
const ASSUMED_INPUTS = new Set(["RateUsageType"]);

/**
 * Pure: which TaxRate rows could still match the line, given only what is KNOWN about it. An input is unknown when it comes from
 * an address the line doesn't have, or is assumed; a row is excluded only by a known input it contradicts (a blank rate cell
 * matches anything). Configuration-derived blanks (no tax code for the product, …) are known: Salesforce sends them blank too.
 */
export function possibleRates(trace: InvoiceTaxTrace, rows: Record<string, unknown>[]): { possible: { name: string; rate: number | null; dependsOn: string[] }[]; excluded: { name: string; why: string }[] } {
  const inputs = trace.decisionTable?.inputs ?? [];
  const noAddress = !trace.records.address;
  const unknown = (field: string) => ASSUMED_INPUTS.has(field) || (noAddress && ADDRESS_INPUTS.has(field));
  const possible: { name: string; rate: number | null; dependsOn: string[] }[] = [], excluded: { name: string; why: string }[] = [];
  for (const r of rows) {
    const name = String(r.Name ?? r.Id);
    const dependsOn: string[] = [];
    let why: string | null = null;
    for (const i of inputs) {
      const rv = r[i.field] === undefined || r[i.field] === null || r[i.field] === "" ? null : String(r[i.field]);
      if (rv === null) continue; // blank on the rate — matches any value
      if (unknown(i.field)) { if (!ASSUMED_INPUTS.has(i.field)) dependsOn.push(i.field); continue; }
      const v = trace.evaluation.inputs[i.field] ?? null;
      if (!compareInput(i.field, i.operator, v, rv).matches) { why = `${i.field} ${rv} ≠ ${v ?? "(blank)"}`; break; }
    }
    if (why) excluded.push({ name, why }); else possible.push({ name, rate: num(r.Rate), dependsOn });
  }
  return { possible, excluded };
}

/** At most this many lines are assessed per invoice; beyond it the remaining lines are UNDETERMINED (never assumed). */
export const MAX_ASSESSED_LINES = 10;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const same15 = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.slice(0, 15) === b.slice(0, 15);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: the applicability of one finished, untaxed line from the gathered evidence. */
export function assessLineApplicability(input: {
  line: InvoiceTaxLine;
  trace: InvoiceTaxTrace | null;
  traceError?: string | null;
  preview: DecisionTablePreview | null;
  previewError?: string | null;
  stale: StaleTable[];
  /** Every TaxRate row — only needed when a required input is blank. */
  rates?: { rows: Record<string, unknown>[]; truncated: boolean } | null;
  ratesError?: string | null;
}): LineApplicability {
  const { line, trace, preview } = input;
  const name = line.product ?? line.name ?? line.id;
  const t = trace?.records.taxTreatment ?? null;
  const dt = trace?.decisionTable ?? null;
  const base: LineApplicability = {
    invoiceLineId: line.id, line: name, verdict: "UNDETERMINED", reason: "",
    treatment: t ? { id: String(t.Id), name: str(t.Name), taxable: typeof t.IsTaxable === "boolean" ? t.IsTaxable : null } : line.treatment ? { id: line.treatment.id, name: line.treatment.name, taxable: null } : null,
    decisionTable: dt?.id ? { id: dt.id, name: dt.name } : null,
    matchedRate: null, referenceAmount: null,
    preview: preview ? { matched: preview.matched, outcomeType: preview.outcomeType, rates: preview.outcomes.map(o => num(o.Rate)), error: preview.error ? `${preview.error.code ?? `HTTP ${preview.error.status}`}: ${preview.error.message}` : null } : null,
  };
  const undetermined = (reason: string): LineApplicability => ({ ...base, verdict: "UNDETERMINED", reason: `${name}: ${reason}` });

  // The line itself must say "finished, no tax": a non-zero or blank TaxAmount is a different problem.
  if (line.taxAmount !== 0) return undetermined(`the line's TaxAmount is ${line.taxAmount ?? "blank"}, not 0.`);
  if (input.traceError || !trace) return undetermined(`the tax chain couldn't be read (${input.traceError ?? "no trace"}).`);
  if (trace.unreadable.length) return undetermined(`Salesforce records couldn't be read: ${trace.unreadable.map(u => u.error).join("; ")}.`);
  if (!trace.records.invoiceLine || !same15(str(trace.records.invoiceLine.Id), line.id)) return undetermined("the invoice line couldn't be traced.");
  if (!t) return undetermined("the line's tax treatment couldn't be read.");
  if (t.IsTaxable !== true) return { ...base, verdict: "NOT_APPLICABLE", reason: `${name}: tax treatment "${str(t.Name) ?? t.Id}" is not taxable.` };
  if (str(t.Status) !== "Active") return undetermined(`taxable treatment "${str(t.Name) ?? t.Id}" is ${str(t.Status) ?? "not Active"}.`);
  const engine = trace.records.taxEngine;
  if (!engine) return undetermined(`taxable treatment "${str(t.Name) ?? t.Id}" has no tax engine — Salesforce can't evaluate a rate, which is a configuration failure, not proof that no tax applies.`);
  if (str(engine.Status) !== "Active") return undetermined(`tax engine "${str(engine.TaxEngineName) ?? engine.Id}" is ${str(engine.Status) ?? "not Active"}.`);
  if (!dt?.id) return undetermined(`tax engine "${str(engine.TaxEngineName) ?? engine.Id}" has no decision table.`);
  const tableName = dt.name ?? dt.id;
  if (dt.status !== "Active" || !/completed/i.test(dt.refreshStatus ?? "")) return undetermined(`decision table ${tableName} is ${dt.status ?? "—"} / refresh ${dt.refreshStatus ?? "—"} — its result can't be trusted until it is Active and refreshed.`);
  const stale = input.stale.find(s => same15(s.tableId, dt.id));
  if (stale) return undetermined(`decision table ${tableName} was last refreshed ${stale.refreshedAt ?? "never"}, before Tax Rate change(s) ${stale.ratesChangedAfter.join(", ")} — a "No Match" from it says nothing. Refresh the table, then recalculate the invoice's tax.`);
  const missingInputs = dt.inputs.filter(i => i.required && !trace.evaluation.inputs[i.field]);
  if (missingInputs.length) {
    // A required input is blank (typically no invoice address → no Country). Salesforce's evaluation can't be run meaningfully, but
    // every Tax Rate can be checked against what IS known: if none can match whatever the missing value is, no tax applies.
    const missing = missingInputs.map(i => i.field).join(", ");
    if (input.ratesError || !input.rates) return undetermined(`required tax input(s) ${missing} are blank and the Tax Rates couldn't be read (${input.ratesError ?? "not read"}) — not proof that no tax applies.`);
    if (input.rates.truncated) return undetermined(`required tax input(s) ${missing} are blank and there are more than ${MAX_RATE_ROWS} Tax Rates to check — not proof that no tax applies.`);
    const { possible, excluded } = possibleRates(trace, input.rates.rows);
    const taxed = possible.filter(p => p.rate === null || p.rate > 0);
    if (taxed.length) return undetermined(`tax may apply — Tax Rate ${taxed.map(p => `${p.name} (${p.rate ?? "?"}%${p.dependsOn.length ? `, needs ${p.dependsOn.join("/")}` : ""})`).join(", ")} can match the line, but its ${missing} is blank (no invoice address). Add the billing/shipping address on the account or debit memo so Salesforce can calculate the tax.`);
    const tc = trace.evaluation.inputs.TaxCode;
    const ruledOut = excluded.length ? ` Every Tax Rate is ruled out by what is known about the line (${excluded.slice(0, 5).map(e => `${e.name}: ${e.why}`).join("; ")}${excluded.length > 5 ? `; +${excluded.length - 5} more` : ""}), so the blank ${missing} can't change that.` : " No Tax Rate exists.";
    if (possible.length) return { ...base, verdict: "ZERO_RATE", matchedRate: 0, referenceAmount: 0, reason: `${name}: only 0% Tax Rates (${possible.map(p => p.name).join(", ")}) can apply to the line — zero tax.` };
    return { ...base, verdict: "NOT_APPLICABLE", reason: `${name}: no tax applies — no Tax Rate can match the line${tc ? "" : ` (the product has no tax code under treatment "${str(t.Name) ?? t.Id}")`}.${ruledOut}` };
  }
  if (input.previewError || !preview) return undetermined(`Salesforce's decision-table evaluation failed: ${input.previewError ?? "not run"}.`);
  if (preview.error) return undetermined(`Salesforce's decision-table evaluation returned an error (${base.preview!.error}).`);

  // Independent check: TaxRate source rows that match every input of the table with a non-zero rate.
  const positiveRows = trace.evaluation.matched.filter(m => { const r = num(m.outputs.Rate); return r === null || r > 0; });
  const rowText = positiveRows.map(m => `${m.name} (${num(m.outputs.Rate) ?? "?"}%)`).join(", ");
  if (preview.matched) {
    const rates = preview.outcomes.map(o => num(o.Rate));
    if (!rates.length || rates.some(r => r === null)) return undetermined(`Salesforce's decision-table evaluation matched, but without a readable Rate.`);
    const top = Math.max(...(rates as number[]));
    if (top > 0) {
      const reference = line.charge !== null ? round2(line.charge * top / 100) : null;
      return { ...base, verdict: "APPLICABLE", matchedRate: top, referenceAmount: reference, reason: `${name}: decision table ${tableName} matches a ${top}% rate for the line's inputs — tax applies${reference !== null ? ` (reference ${reference} on ${line.charge}, NOT a Salesforce amount)` : ""}.` };
    }
    if (positiveRows.length) return undetermined(`Salesforce's evaluation matches only 0% rates, but TaxRate row(s) ${rowText} with a non-zero rate also match the line's inputs — the evaluations disagree.`);
    return { ...base, verdict: "ZERO_RATE", matchedRate: 0, referenceAmount: 0, reason: `${name}: decision table ${tableName} matches a 0% rate for the line's inputs — the line is zero-rated.` };
  }
  if (!/no\s*match/i.test(preview.outcomeType ?? "")) return undetermined(`Salesforce's decision-table evaluation returned no rate without a "No Match" outcome (${preview.outcomeType ?? "no outcome type"}).`);
  if (positiveRows.length) return undetermined(`Salesforce's evaluation says "No Match", but TaxRate row(s) ${rowText} match the line's inputs — the evaluations disagree (often a table that wasn't refreshed).`);
  const inputs = Object.entries(trace.evaluation.inputs).filter(([k, v]) => v && dt.inputs.some(i => i.field === k)).map(([k, v]) => `${k}=${v}`).join(", ");
  return { ...base, verdict: "NOT_APPLICABLE", reason: `${name}: no tax rate applies — Salesforce's decision table ${tableName} (up to date) returns "No Match" for the line's inputs (${inputs}).` };
}

/** Gather the evidence for the given lines and assess each one. Never throws: a failed read makes that line UNDETERMINED. */
export async function assessInvoiceApplicability(api: ApplicabilityApi, invoiceId: string, lines: InvoiceTaxLine[]): Promise<LineApplicability[]> {
  const assessed = lines.slice(0, MAX_ASSESSED_LINES);
  const treatmentIds = [...new Set(assessed.map(l => l.treatment?.id).filter((x): x is string => !!x))];
  let stale: StaleTable[] = [];
  let staleError: string | null = null;
  if (treatmentIds.length) { try { stale = await api.staleTables(treatmentIds); } catch (e) { staleError = e instanceof Error ? e.message : String(e); } }
  // The Tax Rates are read at most once per field set for the whole invoice (only when a line lacks a required input).
  const rateReads = new Map<string, Promise<{ rows: Record<string, unknown>[]; truncated: boolean }>>();
  const readRates = (fields: string[]) => { const key = [...fields].sort().join(","); if (!rateReads.has(key)) rateReads.set(key, api.rates(fields)); return rateReads.get(key)!; };
  // Lines are independent — assessed in parallel.
  const out: LineApplicability[] = await Promise.all(assessed.map(async line => {
    let trace: InvoiceTaxTrace | null = null, traceError: string | null = null, preview: DecisionTablePreview | null = null, previewError: string | null = null;
    let rates: { rows: Record<string, unknown>[]; truncated: boolean } | null = null, ratesError: string | null = null;
    try { trace = await api.trace(invoiceId, line.id); } catch (e) { traceError = e instanceof Error ? e.message : String(e); }
    const dt = trace?.decisionTable;
    const missingRequired = !!dt && dt.inputs.some(i => i.required && !trace!.evaluation.inputs[i.field]);
    if (dt?.id && missingRequired) {
      // Salesforce's evaluation without a required input says nothing — check the rates against the known inputs instead.
      try { rates = await readRates([...new Set([...dt.inputs.map(i => i.field), "Rate"])]); } catch (e) { ratesError = e instanceof Error ? e.message : String(e); }
    } else if (dt?.id) {
      try { preview = await api.preview({ decisionTableId: dt.id, decisionTableName: dt.name, inputs: trace!.evaluation.inputs as unknown as TaxInputs }); } catch (e) { previewError = e instanceof Error ? e.message : String(e); }
    }
    const r = assessLineApplicability({ line, trace, traceError, preview, previewError, stale, rates, ratesError });
    // Freshness unknown → nothing that depends on the table's answer is trusted.
    return staleError && r.verdict !== "APPLICABLE" && !(r.verdict === "NOT_APPLICABLE" && r.treatment?.taxable === false)
      ? { ...r, verdict: "UNDETERMINED" as const, reason: `${r.line}: the decision table's freshness couldn't be checked (${staleError}).` } : r;
  }));
  for (const line of lines.slice(MAX_ASSESSED_LINES)) out.push({ invoiceLineId: line.id, line: line.product ?? line.name ?? line.id, verdict: "UNDETERMINED", reason: `${line.product ?? line.name ?? line.id}: not assessed (more than ${MAX_ASSESSED_LINES} untaxed lines).`, treatment: line.treatment ? { id: line.treatment.id, name: line.treatment.name, taxable: null } : null, decisionTable: null, matchedRate: null, referenceAmount: null, preview: null });
  return out;
}

/** SELECT only: decision tables of the treatments' engines whose Tax Rates changed after the table's last refresh. */
export async function staleDecisionTables(client: SalesforceClient, v: string, treatmentIds: string[]): Promise<StaleTable[]> {
  if (!treatmentIds.length) return [];
  const treatments = await queryAt(client, v, `SELECT TaxEngineId, TaxEngine.TaxEngineName, TaxEngine.DecisionTableId FROM TaxTreatment WHERE Id IN (${idList(treatmentIds)}) AND TaxEngine.DecisionTableId != null`);
  const out: StaleTable[] = [];
  for (const tableId of [...new Set(treatments.map(t => String((t.TaxEngine as Record<string, unknown>).DecisionTableId)))]) {
    const [dt] = await queryAt(client, v, `SELECT Id, DeveloperName, LastSyncDate, LastIncrementalSyncDate, HasIncrementalSyncFailed FROM DecisionTable WHERE Id = '${soqlEscape(tableId)}'`);
    if (!dt) continue;
    const refreshedAt = effectiveRefresh((dt.LastSyncDate as string) ?? null, (dt.LastIncrementalSyncDate as string) ?? null, dt.HasIncrementalSyncFailed === true);
    const since = refreshedAt ? new Date(refreshedAt).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
    const changed = await queryAt(client, v, `SELECT Name FROM TaxRate${since ? ` WHERE LastModifiedDate > ${since}` : ""} ORDER BY LastModifiedDate DESC LIMIT 20`);
    if (!changed.length) continue;
    const engine = treatments.find(t => String((t.TaxEngine as Record<string, unknown>).DecisionTableId) === tableId)!;
    out.push({ engineId: String(engine.TaxEngineId), engine: String((engine.TaxEngine as Record<string, unknown>).TaxEngineName ?? engine.TaxEngineId), table: String(dt.DeveloperName), tableId: String(dt.Id), refreshedAt, ratesChangedAfter: changed.map(r => String(r.Name)) });
  }
  return out;
}

/** Real adapter: SOQL SELECT + Salesforce's decision-table evaluation (stores nothing). */
export async function applicabilityApiFor(client: SalesforceClient): Promise<ApplicabilityApi> {
  const v = (await discoverTaxMetadata(client)).apiVersion;
  const traceApi = traceApiFor(client);
  const previewApi = await previewApiFor(client);
  return {
    trace: (invoiceId, invoiceLineId) => traceInvoiceLineTax(traceApi, { invoiceId, invoiceLineId }),
    preview: input => previewDecisionTable(previewApi, input),
    staleTables: ids => staleDecisionTables(client, v, ids),
    rates: async fields => {
      const safe = [...new Set(["Id", "Name", ...fields])].filter(f => /^[A-Za-z0-9_]+$/.test(f));
      const rows = await queryAt(client, v, `SELECT ${safe.join(", ")} FROM TaxRate ORDER BY Name LIMIT ${MAX_RATE_ROWS + 1}`);
      return { rows: rows.slice(0, MAX_RATE_ROWS), truncated: rows.length > MAX_RATE_ROWS };
    },
  };
}
