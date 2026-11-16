import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";

/**
 * READ-ONLY diagnostic: why does an invoice line have no Salesforce InvoiceLineTax?
 *
 * Traces Invoice → InvoiceLine → OrderItem → TaxTreatment → TaxPolicy → TaxEngine → DecisionTable from the actual
 * Salesforce fields, then compares the line's tax inputs with the decision table's SOURCE rows (TaxRate) using the table's
 * own INPUT parameters and operators. It does not call the decision-table evaluation API (the application has no supported
 * direct evaluation), does not refresh anything, and never writes: the only Salesforce access is `query` (SOQL SELECT).
 * Nothing here computes a tax amount — the only actual tax is InvoiceLineTax; a matched rate is reported as reference only.
 */

export type TraceClassification = "CONFIGURATION_MATCH" | "INVOICE_TIME_TAX_NOT_APPLIED" | "MISSING_RELATIONSHIP" | "DECISION_TABLE_MISMATCH" | "INSUFFICIENT_EVIDENCE";
export interface TraceApi { query(soql: string): Promise<Record<string, unknown>[]> }

export interface TraceLink { from: string; to: string; field: string; value: string | null; expected: string | null; ok: boolean | null; note?: string }
/** One node of Invoice → Invoice Line → Billing Schedule → Order Item → Tax Treatment → Tax Policy → Tax Engine → Decision Table → TaxRate. */
export interface TraceNode { object: string; recordId: string | null; name: string | null; status: string | null; field: string; value: string | null; ok: boolean | null }
export interface InputComparison { input: string; operator: string; invoiceValue: string | null; source: string; rowValue: string | null; matches: boolean; note?: string }
export interface InvoiceTaxTrace {
  success: true;
  readOnly: true;
  classification: TraceClassification;
  summary: string;
  records: Record<string, Record<string, unknown> | null>;
  links: TraceLink[];
  /** The relationship chain top-down, each node with the field that leads to it and its resolved value. */
  chain: TraceNode[];
  checks: { id: "A" | "B" | "C" | "D" | "E"; question: string; answer: "YES" | "NO" | "UNKNOWN"; detail: string }[];
  decisionTable: { id: string | null; name: string | null; status: string | null; type: string | null; usage: string | null; sourceObject: string | null; refreshStatus: string | null; lastSync: string | null; inputs: { field: string; operator: string | null; required: boolean }[]; outputs: string[] } | null;
  evaluation: { method: "SOURCE_ROW_COMPARISON"; inputs: Record<string, string | null>; rows: { id: string; name: string; matches: boolean; comparisons: InputComparison[]; outputs: Record<string, unknown> }[]; matched: { id: string; name: string; outputs: Record<string, unknown> }[] };
  invoiceTime: { invoiceTaxAmount: number | null; lineTaxAmount: number | null; lineTaxStatus: string | null; invoiceLineTaxCount: number; errorLogCount: number };
  /** Reference only — the matched rate applied to the line's charge. NOT a Salesforce calculation. */
  reference: { rate: number | null; basis: string | null; amount: number | null; label: "Expected/reference amount — NOT a Salesforce calculation." } | null;
  proven: string[];
  unproven: string[];
  nextStep: string;
  unreadable: { soql: string; error: string }[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown) => (typeof v === "number" ? v : null);
const same15 = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.slice(0, 15) === b.slice(0, 15);
const day = (v: unknown) => (str(v) ? String(v).slice(0, 10) : null);
const rel = (r: Record<string, unknown> | null, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), r ?? undefined);
const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/** How the line's actual value for each Revenue Standard Tax input is obtained. */
const INPUT_SOURCE: Record<string, string> = {
  Country: "InvoiceAddressGroup.Country (line shipping address, else billing)",
  State: "InvoiceAddressGroup.State",
  City: "InvoiceAddressGroup.City",
  ZipCode: "InvoiceAddressGroup.PostalCode",
  ProductCode: "InvoiceLine.Product2.ProductCode",
  StartDate: "InvoiceLine.InvoiceLineStartDate (else Invoice.InvoiceDate)",
  EndDate: "InvoiceLine.InvoiceLineStartDate (else Invoice.InvoiceDate)",
  RateUsageType: "not stored on the line — Revenue Cloud invoicing uses \"RevCloud\" (assumption)",
  LegalEntityId: "InvoiceLine.LegalEntityId",
  TaxCode: "TaxTreatmentItem.TaxCode (treatment uses items) else TaxTreatment.TaxCode",
};

/** Compare one source row cell with the invoice value under the table's operator. A blank cell matches any value (observed in this org). */
export function compareInput(field: string, operator: string | null, invoiceValue: string | null, rowValue: string | null): { matches: boolean; note?: string } {
  if (rowValue === null || rowValue === "") return { matches: true, note: "blank on the rate — matches any value" };
  if (invoiceValue === null) return { matches: false, note: "no invoice value for a non-blank rate cell" };
  const op = (operator ?? "Equals").toLowerCase();
  if (op === "equals") return { matches: rowValue.toLowerCase() === invoiceValue.toLowerCase() };
  // Date ranges: StartDate GreaterOrEqual → invoice date ≥ rate start; EndDate LessOrEqual → invoice date ≤ rate end.
  if (op === "greaterorequal") return { matches: invoiceValue.slice(0, 10) >= rowValue.slice(0, 10) };
  if (op === "lessorequal") return { matches: invoiceValue.slice(0, 10) <= rowValue.slice(0, 10) };
  return { matches: false, note: `operator ${operator} not evaluated by this diagnostic` };
}

export async function traceInvoiceLineTax(api: TraceApi, input: { invoiceId: string; invoiceLineId?: string | null; expectedDecisionTableId?: string | null }): Promise<InvoiceTaxTrace> {
  if (!ID.test(input.invoiceId) || (input.invoiceLineId && !ID.test(input.invoiceLineId))) throw new Error("Invalid Salesforce Id.");
  const unreadable: InvoiceTaxTrace["unreadable"] = [];
  const q = async (soql: string) => { try { return await api.query(soql); } catch (e) { unreadable.push({ soql, error: e instanceof Error ? e.message : String(e) }); return []; } };
  const one = async (soql: string) => (await q(soql))[0] ?? null;

  const invoice = await one(`SELECT Id, DocumentNumber, Status, InvoiceDate, TotalAmount, TotalTaxAmount, TotalAmountWithTax, LegalEntityId, BillingAccountId, BillToContactId, CreatedDate FROM Invoice WHERE Id = '${soqlEscape(input.invoiceId)}' LIMIT 1`);
  const line = await one(`SELECT Id, Name, InvoiceId, ReferenceEntityItemId, BillingScheduleId, Product2Id, Product2.ProductCode, Quantity, ChargeAmount, TaxAmount, TaxProcessingStatus, TaxTreatmentId, LegalEntityId, ShippingAddressId, BillingAddressId, ShipFromAddressId, InvoiceLineStartDate, InvoiceStatus FROM InvoiceLine WHERE InvoiceId = '${soqlEscape(input.invoiceId)}'${input.invoiceLineId ? ` AND Id = '${soqlEscape(input.invoiceLineId)}'` : ""} ORDER BY CreatedDate LIMIT 1`);
  const schedule = line?.BillingScheduleId ? await one(`SELECT Id, BillingScheduleNumber, Status, ReferenceEntityId, ReferenceEntityItemId, TaxTreatmentId, BillingTreatmentItemId FROM BillingSchedule WHERE Id = '${soqlEscape(String(line.BillingScheduleId))}' LIMIT 1`) : null;
  const orderItemId = str(line?.ReferenceEntityItemId) ?? str(schedule?.ReferenceEntityItemId);
  const orderItem = orderItemId ? await one(`SELECT Id, OrderId, Product2Id, Product2.ProductCode, Quantity, TotalPrice, TaxTreatmentId, BillingTreatmentId FROM OrderItem WHERE Id = '${soqlEscape(orderItemId)}' LIMIT 1`) : null;
  const treatmentId = str(line?.TaxTreatmentId);
  const treatment = treatmentId ? await one(`SELECT Id, Name, Status, IsTaxable, TaxPolicyId, TaxEngineId, LegalEntityId, TaxCode, ProductCode, ShouldUseTaxTreatmentItems FROM TaxTreatment WHERE Id = '${soqlEscape(treatmentId)}' LIMIT 1`) : null;
  const productId = str(line?.Product2Id);
  const treatmentItem = treatment && treatment.ShouldUseTaxTreatmentItems === true ? await one(`SELECT Id, Name, TaxCode, ProductCode, ProductId FROM TaxTreatmentItem WHERE TaxTreatmentId = '${soqlEscape(String(treatment.Id))}'${productId ? ` AND ProductId = '${soqlEscape(productId)}'` : ""} LIMIT 1`) : null;
  const policy = treatment?.TaxPolicyId ? await one(`SELECT Id, Name, Status, TreatmentSelection, DefaultTaxTreatmentId FROM TaxPolicy WHERE Id = '${soqlEscape(String(treatment.TaxPolicyId))}' LIMIT 1`) : null;
  const engine = treatment?.TaxEngineId ? await one(`SELECT Id, TaxEngineName, Status, Type, DecisionTableId, TaxEngineProviderId, CustomMetadataTypeApiName FROM TaxEngine WHERE Id = '${soqlEscape(String(treatment.TaxEngineId))}' LIMIT 1`) : null;
  const dtRow = engine?.DecisionTableId ? await one(`SELECT Id, DeveloperName, MasterLabel, Status, Type, UsageType, SourceObject, RefreshStatus, LastSyncDate, ConditionCriteria, ConditionType FROM DecisionTable WHERE Id = '${soqlEscape(String(engine.DecisionTableId))}' LIMIT 1`) : null;
  const params = dtRow ? await q(`SELECT FieldName, Usage, Operator, Sequence, IsRequired FROM DecisionTableParameter WHERE DecisionTableId = '${soqlEscape(String(dtRow.Id))}' ORDER BY Sequence`) : [];
  const addressId = str(line?.ShippingAddressId) ?? str(line?.BillingAddressId);
  const address = addressId ? await one(`SELECT Id, Street, City, State, PostalCode, Country FROM InvoiceAddressGroup WHERE Id = '${soqlEscape(addressId)}' LIMIT 1`) : null;
  const ilt = line ? await q(`SELECT Id, TaxAmount, TaxRate, TaxCode, TaxTreatmentId, TaxProcessingStatus FROM InvoiceLineTax WHERE InvoiceLineId = '${soqlEscape(String(line.Id))}'`) : [];
  const logs = invoice ? await q(`SELECT Id, ErrorLogNumber, Category, ErrorCode, ErrorMessage FROM RevenueTransactionErrorLog WHERE PrimaryRecordId IN ('${soqlEscape(input.invoiceId)}'${line ? `, '${soqlEscape(String(line.Id))}'` : ""}) OR RelatedRecordId IN ('${soqlEscape(input.invoiceId)}'${line ? `, '${soqlEscape(String(line.Id))}'` : ""})`) : [];

  /* ── relationship links ── */
  const links: TraceLink[] = [];
  const link = (from: string, to: string, field: string, value: unknown, expected: unknown, note?: string) =>
    links.push({ from, to, field, value: str(value), expected: str(expected), ok: str(expected) === null && str(value) === null ? null : str(expected) === null ? !!str(value) : same15(str(value), str(expected)), note });
  link("Invoice", "InvoiceLine", "InvoiceLine.InvoiceId", line?.InvoiceId, invoice?.Id);
  link("InvoiceLine", "OrderItem", "InvoiceLine.ReferenceEntityItemId", line?.ReferenceEntityItemId, null, str(line?.ReferenceEntityItemId) ? undefined : "blank on the line — the order item is reachable only through the billing schedule");
  link("InvoiceLine", "BillingSchedule", "InvoiceLine.BillingScheduleId", line?.BillingScheduleId, schedule?.Id);
  link("BillingSchedule", "OrderItem", "BillingSchedule.ReferenceEntityItemId", schedule?.ReferenceEntityItemId, orderItem?.Id);
  link("InvoiceLine", "TaxTreatment", "InvoiceLine.TaxTreatmentId", line?.TaxTreatmentId, orderItem?.TaxTreatmentId, "must equal OrderItem.TaxTreatmentId");
  link("BillingSchedule", "TaxTreatment", "BillingSchedule.TaxTreatmentId", schedule?.TaxTreatmentId, orderItem?.TaxTreatmentId);
  link("TaxTreatment", "TaxPolicy", "TaxTreatment.TaxPolicyId", treatment?.TaxPolicyId, policy?.Id);
  link("TaxTreatment", "TaxEngine", "TaxTreatment.TaxEngineId", treatment?.TaxEngineId, engine?.Id);
  link("TaxTreatment", "LegalEntity", "TaxTreatment.LegalEntityId", treatment?.LegalEntityId, null, str(treatment?.LegalEntityId) ? undefined : "blank (optional; the policy selects treatments, the line carries its own legal entity)");
  link("TaxEngine", "DecisionTable", "TaxEngine.DecisionTableId", engine?.DecisionTableId, input.expectedDecisionTableId ?? dtRow?.Id);
  const informational = new Set(["InvoiceLine.ReferenceEntityItemId", "TaxTreatment.LegalEntityId"]);
  const broken = links.filter(l => l.ok === false && !informational.has(l.field));

  /* ── decision-table inputs vs. source rows ── */
  const inputsMeta = params.filter(p => p.Usage === "INPUT").map(p => ({ field: String(p.FieldName), operator: str(p.Operator), required: p.IsRequired === true }));
  const outputs = params.filter(p => p.Usage === "OUTPUT").map(p => String(p.FieldName));
  const lineDate = day(line?.InvoiceLineStartDate) ?? day(invoice?.InvoiceDate);
  const taxCode = str(treatmentItem?.TaxCode) ?? str(treatment?.TaxCode);
  const invoiceInputs: Record<string, string | null> = {
    Country: str(address?.Country), State: str(address?.State), City: str(address?.City), ZipCode: str(address?.PostalCode),
    ProductCode: str(rel(line, "Product2.ProductCode")), StartDate: lineDate, EndDate: lineDate, RateUsageType: "RevCloud",
    LegalEntityId: str(line?.LegalEntityId), TaxCode: taxCode,
  };
  const sourceObject = str(dtRow?.SourceObject);
  const rowFields = [...new Set([...inputsMeta.map(i => i.field), ...outputs])].filter(f => /^[A-Za-z0-9_]+$/.test(f));
  const sourceRows = sourceObject === "TaxRate" && rowFields.length
    ? await q(`SELECT Id, Name, ${rowFields.join(", ")} FROM TaxRate WHERE Country = '${soqlEscape(invoiceInputs.Country ?? "")}' OR TaxCode = '${soqlEscape(taxCode ?? "")}' ORDER BY Name LIMIT 50`)
    : [];
  const rows = sourceRows.map(r => {
    const comparisons: InputComparison[] = inputsMeta.map(i => {
      const rv = r[i.field] === undefined || r[i.field] === null ? null : String(r[i.field]);
      const c = compareInput(i.field, i.operator, invoiceInputs[i.field] ?? null, rv);
      return { input: i.field, operator: i.operator ?? "Equals", invoiceValue: invoiceInputs[i.field] ?? null, source: INPUT_SOURCE[i.field] ?? "—", rowValue: rv, ...c };
    });
    return { id: String(r.Id), name: String(r.Name), matches: comparisons.every(c => c.matches), comparisons, outputs: Object.fromEntries(outputs.map(o => [o, r[o] ?? null])) };
  });
  const matched = rows.filter(r => r.matches).map(r => ({ id: r.id, name: r.name, outputs: r.outputs }));

  /* ── invoice-time result ── */
  const invoiceTime = { invoiceTaxAmount: num(invoice?.TotalTaxAmount), lineTaxAmount: num(line?.TaxAmount), lineTaxStatus: str(line?.TaxProcessingStatus), invoiceLineTaxCount: ilt.length, errorLogCount: logs.length };
  const processed = /estimated|posted/i.test(invoiceTime.lineTaxStatus ?? "");

  /* ── A–E ── */
  const yn = (b: boolean | null): "YES" | "NO" | "UNKNOWN" => (b === null ? "UNKNOWN" : b ? "YES" : "NO");
  const lineOk = !!line && !!orderItem && same15(str(line.TaxTreatmentId), str(orderItem.TaxTreatmentId));
  const chainOk = !!treatment && !!policy && !!engine && treatment.Status === "Active" && policy.Status === "Active" && engine.Status === "Active" && treatment.IsTaxable === true;
  const tableAssigned = !!engine && !!dtRow && (!input.expectedDecisionTableId || same15(str(engine.DecisionTableId), input.expectedDecisionTableId));
  const tableUsable = !!dtRow && dtRow.Status === "Active" && /completed/i.test(str(dtRow.RefreshStatus) ?? "");
  const tableMatches = tableUsable && matched.length > 0;
  const notApplied = invoiceTime.invoiceLineTaxCount === 0 && processed;
  const checks: InvoiceTaxTrace["checks"] = [
    { id: "A", question: "Invoice line connected to the expected TaxTreatment?", answer: yn(line && orderItem ? lineOk : null), detail: `InvoiceLine.TaxTreatmentId=${str(line?.TaxTreatmentId) ?? "—"} · OrderItem.TaxTreatmentId=${str(orderItem?.TaxTreatmentId) ?? "—"}` },
    { id: "B", question: "TaxTreatment connected to an Active TaxPolicy and TaxEngine?", answer: yn(treatment ? chainOk : null), detail: `Treatment ${str(treatment?.Status) ?? "—"} (taxable ${treatment?.IsTaxable === true}) · Policy ${str(policy?.Status) ?? "—"} · Engine ${str(engine?.Status) ?? "—"} ${str(engine?.Type) ?? ""}` },
    { id: "C", question: "TaxEngine assigned to the expected decision table?", answer: yn(engine ? tableAssigned : null), detail: `TaxEngine.DecisionTableId=${str(engine?.DecisionTableId) ?? "—"} (${str(dtRow?.DeveloperName) ?? "—"})` },
    { id: "D", question: "Decision table's source rows match the invoice inputs?", answer: yn(dtRow ? tableMatches : null), detail: tableMatches ? `${matched.length} row(s) match: ${matched.map(m => `${m.name} → ${JSON.stringify(m.outputs)}`).join("; ")}` : !tableUsable ? `Table ${str(dtRow?.Status) ?? "—"}/${str(dtRow?.RefreshStatus) ?? "—"}` : "No source row satisfies every input condition." },
    { id: "E", question: "Salesforce invoice processing failed to materialize InvoiceLineTax?", answer: yn(line ? notApplied : null), detail: `Line status ${invoiceTime.lineTaxStatus ?? "—"} · line tax ${invoiceTime.lineTaxAmount ?? "—"} · InvoiceLineTax ${invoiceTime.invoiceLineTaxCount} · error logs ${invoiceTime.errorLogCount}` },
  ];

  let classification: TraceClassification;
  if (!invoice || !line) classification = "INSUFFICIENT_EVIDENCE";
  else if (invoiceTime.invoiceLineTaxCount > 0) classification = "CONFIGURATION_MATCH";
  else if (broken.length || !lineOk || !chainOk || !tableAssigned) classification = "MISSING_RELATIONSHIP";
  else if (!tableMatches) classification = dtRow ? "DECISION_TABLE_MISMATCH" : "INSUFFICIENT_EVIDENCE";
  // A count of 0 only counts as evidence when the query itself succeeded.
  else if (unreadable.some(u => /FROM (InvoiceLineTax|RevenueTransactionErrorLog|TaxRate)\b/.test(u.soql))) classification = "INSUFFICIENT_EVIDENCE";
  else if (notApplied && invoiceTime.errorLogCount === 0) classification = "INVOICE_TIME_TAX_NOT_APPLIED";
  else classification = "INSUFFICIENT_EVIDENCE";

  const m0 = matched[0];
  const rate = m0 ? num(m0.outputs.Rate) ?? (m0.outputs.Rate !== null && m0.outputs.Rate !== undefined ? Number(m0.outputs.Rate) : null) : null;
  const charge = num(line?.ChargeAmount);
  const reference = m0 ? { rate, basis: str(m0.outputs.ApplicationBasis), amount: rate !== null && charge !== null ? Math.round(charge * rate) / 100 : null, label: "Expected/reference amount — NOT a Salesforce calculation." as const } : null;

  const proven: string[] = [], unproven: string[] = [];
  // The order product had no treatment: Salesforce stamped another one (the legal entity's) on the schedule and line.
  const fallback = !!line && !!orderItem && !str(orderItem.TaxTreatmentId) && !!str(line.TaxTreatmentId);
  if (fallback) proven.push(`OrderItem.TaxTreatmentId is blank, so Salesforce applied treatment "${str(treatment?.Name) ?? str(line!.TaxTreatmentId)}"${treatment ? ` (${treatment.IsTaxable === true ? "taxable" : "NOT taxable"})` : ""} to the billing schedule and invoice line — it doesn't take the product's Tax Policy treatment.`);
  if (lineOk) proven.push("The invoice line carries the order item's tax treatment.");
  if (chainOk) proven.push("Treatment, policy and engine are Active and connected; the treatment is taxable.");
  if (tableAssigned) proven.push(`The engine is assigned to ${str(dtRow?.DeveloperName)}.`);
  if (tableMatches) proven.push(`Under the table's own input conditions, TaxRate ${m0!.name} matches every invoice input.`);
  if (notApplied) proven.push(`Salesforce processed the line (tax status ${invoiceTime.lineTaxStatus}) and created ${invoiceTime.invoiceLineTaxCount} InvoiceLineTax with no error log.`);
  if (!str(line?.ReferenceEntityItemId)) unproven.push("Whether a blank InvoiceLine.ReferenceEntityItemId affects tax determination (the order item is linked through the billing schedule).");
  unproven.push("Which inputs Salesforce actually sent to the decision table at invoice time (not exposed in any record).");
  unproven.push("Whether invoice-time tax used TaxEngine.DecisionTableId or a different table.");
  unproven.push("RateUsageType at invoice time is assumed \"RevCloud\"; it isn't stored on the line.");

  const nextStep = classification === "MISSING_RELATIONSHIP" && fallback
    ? "The order product was activated without a Tax Treatment. An activated order's products can't be changed: create a new order whose order product carries the product policy's treatment (the order flow sets it before activation), then bill and invoice it."
    : classification === "INVOICE_TIME_TAX_NOT_APPLIED"
    ? "Configuration is consistent and the decision table independently matches, yet Salesforce produced no InvoiceLineTax. Next step: open a Salesforce Support case (not another application or configuration change), citing the invoice line, engine and decision table Ids in this report."
    : classification === "MISSING_RELATIONSHIP" ? `Fix the broken link(s): ${broken.map(b => b.field).join(", ") || checks.filter(c => c.answer === "NO").map(c => c.id).join(", ")} — after review, not automatically.`
    : classification === "DECISION_TABLE_MISMATCH" ? "Compare the non-matching inputs above with the tax rate; no row satisfies the table's conditions."
    : classification === "CONFIGURATION_MATCH" ? "Salesforce produced InvoiceLineTax — nothing to diagnose."
    : "Collect the missing evidence listed above before drawing a conclusion.";

  function buildChain(): TraceNode[] {
    const n = (object: string, rec: Record<string, unknown> | null, name: unknown, status: unknown, field: string, value: unknown, ok: boolean | null): TraceNode => ({ object, recordId: str(rec?.Id), name: str(name), status: str(status), field, value: value === null || value === undefined ? null : String(value), ok });
    const rate = matched[0] ? sourceRows.find(r => r.Id === matched[0].id) ?? null : null;
    return [
      n("Invoice", invoice, invoice?.DocumentNumber, invoice?.Status, "TotalTaxAmount", invoice?.TotalTaxAmount, !!invoice),
      n("Invoice Line", line, line?.Name, line?.TaxProcessingStatus, "InvoiceLine.InvoiceId", line?.InvoiceId, !!line && same15(str(line.InvoiceId), str(invoice?.Id))),
      n("Billing Schedule", schedule, schedule?.BillingScheduleNumber, schedule?.Status, "InvoiceLine.BillingScheduleId", line?.BillingScheduleId, schedule ? true : line ? false : null),
      n("Order Item", orderItem, rel(orderItem, "Product2.ProductCode"), null, str(line?.ReferenceEntityItemId) ? "InvoiceLine.ReferenceEntityItemId" : "BillingSchedule.ReferenceEntityItemId", orderItemId, orderItem ? true : false),
      n("Tax Treatment", treatment, treatment?.Name, treatment?.Status, "InvoiceLine.TaxTreatmentId", line?.TaxTreatmentId, lineOk && treatment?.Status === "Active"),
      n("Tax Policy", policy, policy?.Name, policy?.Status, "TaxTreatment.TaxPolicyId", treatment?.TaxPolicyId, policy ? policy.Status === "Active" : treatment ? false : null),
      n("Tax Engine", engine, engine?.TaxEngineName, engine?.Status, "TaxTreatment.TaxEngineId", treatment?.TaxEngineId, engine ? engine.Status === "Active" : treatment ? false : null),
      n("Decision Table", dtRow, dtRow?.DeveloperName, dtRow?.Status, "TaxEngine.DecisionTableId", engine?.DecisionTableId, dtRow ? tableUsable && tableAssigned : engine ? false : null),
      n("TaxRate", rate, rate?.Name, rate ? `${rate.Rate ?? "?"}% ${rate.ApplicationBasis ?? ""}`.trim() : null, "matched by the decision table's inputs", rate ? `${rate.TaxCode ?? "—"} · ${rate.Country ?? "—"} · ${rate.ProductCode ?? "—"}` : null, dtRow ? !!rate : null),
    ];
  }

  const summary = {
    CONFIGURATION_MATCH: "Salesforce produced InvoiceLineTax for this line.",
    INVOICE_TIME_TAX_NOT_APPLIED: "Every relationship is correct and the decision table matches the invoice inputs, but Salesforce did not materialize InvoiceLineTax at invoice time.",
    MISSING_RELATIONSHIP: "A required relationship in the tax chain is missing or points elsewhere.",
    DECISION_TABLE_MISMATCH: "The chain is connected, but no decision-table source row matches the invoice inputs.",
    INSUFFICIENT_EVIDENCE: "The available Salesforce records don't support a conclusion.",
  }[classification];

  return {
    success: true, readOnly: true, classification, summary,
    records: { invoice, invoiceLine: line, billingSchedule: schedule, orderItem, taxTreatment: treatment, taxTreatmentItem: treatmentItem, taxPolicy: policy, taxEngine: engine, decisionTable: dtRow, address, invoiceLineTax: ilt[0] ?? null },
    links, checks, chain: buildChain(),
    decisionTable: dtRow ? { id: String(dtRow.Id), name: str(dtRow.DeveloperName), status: str(dtRow.Status), type: str(dtRow.Type), usage: str(dtRow.UsageType), sourceObject, refreshStatus: str(dtRow.RefreshStatus), lastSync: str(dtRow.LastSyncDate), inputs: inputsMeta, outputs } : null,
    evaluation: { method: "SOURCE_ROW_COMPARISON", inputs: invoiceInputs, rows, matched },
    invoiceTime, reference, proven, unproven, nextStep, unreadable,
  };
}

/**
 * Real adapter: SOQL SELECT only, at the tax API version. The client's default version (v60) lacks fields the trace reads —
 * Invoice / InvoiceLine.LegalEntityId exist only at the tax version (p10: v68); at v60 the DOC-000000034 trace failed with
 * "No such column 'LegalEntityId'" → INSUFFICIENT_EVIDENCE.
 */
export function traceApiFor(client: SalesforceClient): TraceApi {
  let version: Promise<string> | null = null;
  return {
    query: async soql => {
      if (!/^\s*SELECT\s/i.test(soql)) throw new Error("Read-only diagnostic: only SELECT queries are allowed.");
      version ??= discoverTaxMetadata(client).then(m => m.apiVersion);
      return (await queryAt(client, await version, soql)).map(r => { const { attributes, ...rest } = r; void attributes; return rest; });
    },
  };
}
