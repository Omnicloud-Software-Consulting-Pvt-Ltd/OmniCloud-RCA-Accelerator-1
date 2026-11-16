import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { apiUrl, queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { traceApiFor, traceInvoiceLineTax, type TraceApi } from "@/lib/tax/server/invoiceTaxTrace";
import { PREVIEW_LABEL, type DecisionTablePreview, type InvoiceTaxEvidence, type TaxInputs } from "@/lib/tax/server/calculationResult";

/**
 * TAX CALCULATION DIAGNOSTICS (read-only):
 *  · Decision-table PREVIEW — Salesforce's own evaluation endpoint (POST /connect/business-rules/decision-table/{id}) with the
 *    transaction's inputs. It evaluates the table and stores nothing; its result is labelled as a preview and never becomes tax.
 *    Verified in p10: dates must be ISO date-times ("2026-10-08T00:00:00.000Z"; other formats → HTTP 500), blank rate cells match
 *    any value, and a wrong TaxCode or an earlier date returns "No Match".
 *  · Invoice EVIDENCE — the relationship trace (SOQL SELECT only) plus the preview for the line's inputs, attached when Salesforce
 *    produced no InvoiceLineTax (and to explain an invoice's result).
 */

export const PREVIEW_ENDPOINT = "POST /services/data/v{version}/connect/business-rules/decision-table/{decisionTableId}";
const DEFAULT_OPERATOR: Record<string, string> = { StartDate: "GreaterOrEqual", EndDate: "LessOrEqual" };

export interface PreviewApi {
  /** The table's INPUT parameters with their operators (DecisionTableParameter). */
  params(decisionTableId: string): Promise<{ field: string; operator: string | null }[]>;
  /** Salesforce's evaluation call — returns the HTTP status and body as-is (never throws on a Salesforce error). */
  evaluate(decisionTableId: string, conditions: DecisionTablePreview["conditions"]): Promise<{ status: number; json: unknown }>;
}

/** Pure: the evaluation conditions for the table's inputs that have a value (dates as ISO date-times). */
export function previewConditions(inputs: TaxInputs, params: { field: string; operator: string | null }[]): DecisionTablePreview["conditions"] {
  const out: DecisionTablePreview["conditions"] = [];
  for (const p of params) {
    const v = inputs[p.field as keyof TaxInputs];
    if (v === null || v === undefined || v === "") continue;
    const isDate = p.field === "StartDate" || p.field === "EndDate";
    out.push({ fieldName: p.field, value: isDate ? `${String(v).slice(0, 10)}T00:00:00.000Z` : String(v), operator: p.operator ?? DEFAULT_OPERATOR[p.field] ?? "Equals" });
  }
  return out;
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Pure: Salesforce's evaluation response → preview (errors kept verbatim). */
export function parsePreview(res: { status: number; json: unknown }, base: Pick<DecisionTablePreview, "decisionTableId" | "decisionTableName" | "conditions" | "taxRate">): DecisionTablePreview {
  const out: DecisionTablePreview = { label: PREVIEW_LABEL, endpoint: PREVIEW_ENDPOINT, httpStatus: res.status, outcomeType: null, matched: false, outcomes: [], rate: null, applicationBasis: null, priority: null, consistent: null, error: null, ...base };
  const body = res.json as Record<string, unknown> | Record<string, unknown>[] | null;
  if (res.status >= 400 || Array.isArray(body)) {
    const e = Array.isArray(body) ? body[0] : body;
    out.error = { status: res.status, code: str(e?.errorCode), message: str(e?.message) ?? `HTTP ${res.status}` };
    return out;
  }
  if (body && str(body.errorCode)) { out.error = { status: res.status, code: str(body.errorCode), message: str(body.errorMessage) ?? "Decision table evaluation error" }; return out; }
  out.outcomeType = str(body?.outcomeType);
  out.outcomes = ((body?.outcomeList as { values?: Record<string, unknown> }[] | undefined) ?? []).map(o => o.values ?? {});
  out.matched = out.outcomes.length > 0 && body?.successStatus !== false;
  const first = out.outcomes[0];
  if (first) { out.rate = num(first.Rate); out.applicationBasis = str(first.ApplicationBasis); out.priority = num(first.Priority); }
  out.consistent = out.matched && out.taxRate?.rate !== null && out.taxRate?.rate !== undefined ? out.taxRate.rate === out.rate : null;
  return out;
}

/** Salesforce's decision-table evaluation for the inputs — a PREVIEW, never an invoice-time tax result. */
export async function previewDecisionTable(api: PreviewApi, input: { decisionTableId: string; decisionTableName: string | null; inputs: TaxInputs; taxRate?: DecisionTablePreview["taxRate"] }): Promise<DecisionTablePreview> {
  const params = await api.params(input.decisionTableId);
  const conditions = previewConditions(input.inputs, params);
  const base = { decisionTableId: input.decisionTableId, decisionTableName: input.decisionTableName, conditions, taxRate: input.taxRate ?? null };
  if (!conditions.length) return { label: PREVIEW_LABEL, endpoint: PREVIEW_ENDPOINT, httpStatus: null, outcomeType: null, matched: false, outcomes: [], rate: null, applicationBasis: null, priority: null, consistent: null, error: { status: 0, code: "NO_INPUTS", message: "No decision-table input has a value — nothing to evaluate." }, ...base };
  return parsePreview(await api.evaluate(input.decisionTableId, conditions), base);
}

export async function previewApiFor(client: SalesforceClient): Promise<PreviewApi> {
  const v = (await discoverTaxMetadata(client)).apiVersion;
  return {
    params: async id => (await queryAt(client, v, `SELECT FieldName, Operator, Usage, Sequence FROM DecisionTableParameter WHERE DecisionTableId = '${soqlEscape(id)}' ORDER BY Sequence`))
      .filter(p => p.Usage === "INPUT").map(p => ({ field: String(p.FieldName), operator: str(p.Operator) })),
    evaluate: async (id, conditions) => {
      if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id)) throw new Error("Invalid decision table Id.");
      const res = await client.requestWithDiagnostics(apiUrl(client, v, `/connect/business-rules/decision-table/${id}`), { method: "POST", body: JSON.stringify({ conditions: { conditionsList: conditions } }) });
      return { status: res.status, json: res.json ?? res.rawText };
    },
  };
}

/* ───────────── Invoice evidence ───────────── */

/** Read-only evidence for one invoice line: relationship trace + Salesforce's decision-table preview for the line's inputs. */
export async function invoiceTaxEvidence(apis: { trace: TraceApi; preview: PreviewApi }, invoiceId: string, invoiceLineId: string | null): Promise<InvoiceTaxEvidence> {
  const t = await traceInvoiceLineTax(apis.trace, { invoiceId, invoiceLineId });
  const errors = t.unreadable.map(u => `${u.error} (${u.soql.slice(0, 80)}…)`);
  const r = t.records;
  const m = t.evaluation.matched[0] ?? null;
  const row = m ? t.evaluation.rows.find(x => x.id === m.id) : null;
  const taxRate = m ? { id: m.id, name: m.name, taxCode: row?.comparisons.find(c => c.input === "TaxCode")?.rowValue ?? null, rate: num(m.outputs.Rate) } : null;
  let preview: DecisionTablePreview | null = null;
  if (t.decisionTable?.id) {
    try { preview = await previewDecisionTable(apis.preview, { decisionTableId: t.decisionTable.id, decisionTableName: t.decisionTable.name, inputs: t.evaluation.inputs as unknown as TaxInputs, taxRate }); }
    catch (e) { errors.push(`Decision-table preview failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  // Was the rate that matches today created / changed after the invoice? Then today's match isn't the invoice-time configuration.
  let configurationChangedAfterInvoice: InvoiceTaxEvidence["configurationChangedAfterInvoice"] = null;
  const invoiceCreatedAt = str(r.invoice?.CreatedDate);
  if (m && invoiceCreatedAt) {
    try {
      const [rate] = await apis.trace.query(`SELECT Id, Name, CreatedDate, LastModifiedDate FROM TaxRate WHERE Id = '${m.id.replace(/'/g, "")}' LIMIT 1`);
      const changed = [str(rate?.CreatedDate), str(rate?.LastModifiedDate)].filter((x): x is string => !!x).sort().pop() ?? null;
      if (changed && Date.parse(changed) > Date.parse(invoiceCreatedAt)) configurationChangedAfterInvoice = { rate: String(rate?.Name ?? m.name), rateChangedAt: changed, invoiceCreatedAt };
    } catch (e) { errors.push(`The matched rate's dates couldn't be read: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return {
    configurationChangedAfterInvoice,
    invoiceId, invoiceNumber: str(r.invoice?.DocumentNumber), invoiceLineId: str(r.invoiceLine?.Id),
    taxTreatmentId: str(r.invoiceLine?.TaxTreatmentId), taxEngineId: str(r.taxEngine?.Id), decisionTableId: t.decisionTable?.id ?? null,
    invoiceTaxAmount: t.invoiceTime.invoiceTaxAmount, invoiceLineTaxAmount: t.invoiceTime.lineTaxAmount, taxProcessingStatus: t.invoiceTime.lineTaxStatus,
    invoiceLineTaxCount: t.invoiceTime.invoiceLineTaxCount, errorLogCount: t.invoiceTime.errorLogCount,
    traceClassification: t.classification, matchedTaxRate: m, preview, errors,
  };
}

export async function evidenceApisFor(client: SalesforceClient): Promise<{ trace: TraceApi; preview: PreviewApi }> {
  return { trace: traceApiFor(client), preview: await previewApiFor(client) };
}
