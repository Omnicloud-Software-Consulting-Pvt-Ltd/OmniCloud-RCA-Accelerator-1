import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata, objectMeta } from "@/lib/tax/server/metadata";
import { idList, num, str } from "@/lib/tax/server/records";
import { diag, type TaxDiagnostic } from "@/lib/tax/server/diagnostics";
import { invoiceTaxFlowState, NO_INVOICE_LINE_TAX, type TaxCalcReason, type TaxFlowState } from "@/lib/tax/server/calculationResult";
import type { Named } from "@/lib/tax/types";
import { applicabilityApiFor, assessInvoiceApplicability, type ApplicabilityApi, type LineApplicability } from "@/lib/tax/server/taxApplicability";

/**
 * INVOICE TAX — reading a Salesforce invoice with its InvoiceLineTax records and deciding, from those records only, whether
 * Salesforce applied tax. Shared by the Tax Calculation service, the verification run and the Revenue Cloud Billing posting gate
 * (pure module + SELECT-only loaders, so billing can use it without importing the tax orchestration).
 *
 *  · An InvoiceLineTax query that fails is NEVER an empty result: the invoice carries `taxRecordsError` and the verdict is
 *    CALCULATION_FAILED · TAX_RECORDS_UNREADABLE.
 *  · A line billed with a non-taxable treatment while its product's tax policy selects a taxable one is the fallback Salesforce
 *    applies to a blank OrderItem.TaxTreatmentId (p10 DOC-000000014: "Tax Treatment for US LE") — CALCULATION_FAILED ·
 *    TREATMENT_MISMATCH, never NO_TAX_EXPECTED.
 */

/**
 * A line's tax-inclusive total, DERIVED from verified records only: ChargeAmount + Σ InvoiceLineTax.TaxAmount, when the line has a
 * usable TaxAmount that agrees with its InvoiceLineTax. Anything else (no charge, no/blank TaxAmount, no or unreadable InvoiceLineTax
 * — including a zero-tax line, under the current conservative policy — or a mismatch) is "unavailable" with the reason.
 */
export interface LineTotalWithTax { value: number | null; basis: "derived" | "unavailable"; detail: string }

export interface InvoiceTaxLine {
  id: string; name: string | null; product: string | null; productId: string | null; quantity: number | null; unitPrice: number | null; charge: number | null; taxAmount: number | null;
  /**
   * Salesforce's raw InvoiceLine.ChargeAmountWithTax — NOT a verified tax-inclusive line total. On every taxed Draft/Estimated
   * line observed in p10 (DOC-000000013/17/19/20/21) it equals ChargeAmount although TaxAmount > 0 and the invoice's
   * TotalAmountWithTax includes the tax (DOC-000000021: line 10000 / 1800 / ChargeAmountWithTax 10000; invoice 10000 / 1800 /
   * 11800). Whether posting changes it is untested. Kept for transparency only; use `totalWithTax` (derived) instead.
   */
  chargeAmountWithTax: number | null;
  /** Derived tax-inclusive line total (see lineTotalWithTax). Set by readInvoice; absent → treat as unavailable. */
  totalWithTax?: LineTotalWithTax;
  taxRate: number | null; taxCode: string | null; taxStatus: string | null; treatment: Named | null;
  /** InvoiceLine.LegalEntityId / AdjustmentAmount / AdjustmentTaxAmount — absent (not read) is treated as unknown, never as 0. */
  legalEntityId?: string | null; adjustmentAmount?: number | null; adjustmentTaxAmount?: number | null;
  taxes: { id: string; name: string | null; amount: number | null; rate: number | null; code: string | null; status: string | null; effectiveDate: string | null; treatment: Named | null;
    /** InvoiceLineTax.LegalEntityId / TaxExemptAmount — absent (not read) is treated as unknown. */
    legalEntityId?: string | null; exemptAmount?: number | null }[];
}
export interface TaxInvoice {
  /** subtotal / tax / totalWithTax are Salesforce's invoice-level TotalChargeAmount / TotalTaxAmount / TotalAmountWithTax. */
  id: string; number: string | null; status: string | null; subtotal: number | null; tax: number | null; totalWithTax: number | null; balance: number | null; date: string | null; lines: InvoiceTaxLine[];
  /** Set when the InvoiceLineTax query failed — the lines' `taxes` are then unknown, not empty. */
  taxRecordsError?: string | null;
  /** Invoice.LastModifiedDate — tells whether Salesforce has touched the invoice since an earlier read. */
  modifiedAt?: string | null;
}

/**
 * Salesforce's transient Invoice.Status values (p10 describe, API v68): the invoice is being processed, so its lines, totals and
 * InvoiceLineTax are not final. InvoiceLine.TaxProcessingStatus has no such value (only Pending / Estimated / Posted) — a line
 * stays "Estimated" while a recalculation runs (DOC-000000035: Draft In Progress → Draft, InvoiceLineTax created at the end).
 */
const PROCESSING_STATUSES = new Set(["draft in progress", "pending", "posting in progress", "void in progress", "split in progress", "split posting in progress", "split void in progress", "processing"]);
export const isInvoiceProcessing = (status: string | null | undefined) => PROCESSING_STATUSES.has((status ?? "").trim().toLowerCase());

const named = (id: unknown, rel: unknown, field = "Name"): Named | null => (typeof id === "string" ? { id, name: String((rel as Record<string, unknown> | null)?.[field] ?? id) } : null);
const id15 = (s: string | null | undefined) => (s ?? "").slice(0, 15);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pure: an Invoice row's total with tax — Salesforce's Invoice.TotalAmountWithTax only. Invoice.TotalAmount is the PRE-tax amount on
 * taxed invoices (p10 DOC-000000019/21: TotalAmount 10000, TotalAmountWithTax 11800), so it is never a fallback. Missing → null.
 */
export function invoiceTotalWithTax(row: Record<string, unknown> | null | undefined): number | null {
  const v = row?.TotalAmountWithTax;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Pure: the line's tax-inclusive total from verified records (ChargeAmount + Σ InvoiceLineTax), or "unavailable" with why. */
export function lineTotalWithTax(l: Pick<InvoiceTaxLine, "charge" | "taxAmount" | "taxes" | "chargeAmountWithTax">, taxRecordsError?: string | null): LineTotalWithTax {
  const unavailable = (detail: string): LineTotalWithTax => ({ value: null, basis: "unavailable", detail });
  if (taxRecordsError) return unavailable("InvoiceLineTax couldn't be read — no verified tax amount.");
  if (typeof l.charge !== "number" || !Number.isFinite(l.charge)) return unavailable("The line has no ChargeAmount.");
  // The InvoiceLineTax total must be checked against the line's own TaxAmount — without a usable TaxAmount it can't be.
  if (typeof l.taxAmount !== "number" || !Number.isFinite(l.taxAmount)) return unavailable("The line has no usable InvoiceLine.TaxAmount, so its InvoiceLineTax total can't be checked.");
  if (!l.taxes.length) return unavailable("No InvoiceLineTax on the line — no verified tax amount to add.");
  if (l.taxes.some(t => typeof t.amount !== "number" || !Number.isFinite(t.amount))) return unavailable("An InvoiceLineTax record has no TaxAmount.");
  const tax = round2(l.taxes.reduce((s, t) => s + (t.amount as number), 0));
  if (Math.abs(l.taxAmount - tax) > 0.005) return unavailable(`InvoiceLine.TaxAmount ${l.taxAmount} differs from its InvoiceLineTax total ${tax}.`);
  const value = round2(l.charge + tax);
  const raw = l.chargeAmountWithTax === null ? "" : Math.abs(l.chargeAmountWithTax - value) > 0.005 ? ` Salesforce's InvoiceLine.ChargeAmountWithTax is ${l.chargeAmountWithTax} (not used — it doesn't include the tax).` : "";
  return { value, basis: "derived", detail: `Derived: ChargeAmount ${l.charge} + InvoiceLineTax ${tax}.${raw}` };
}

export async function readInvoice(client: SalesforceClient, v: string, invoiceId: string): Promise<TaxInvoice> {
  const [inv] = await queryAt(client, v, `SELECT Id, DocumentNumber, Status, TotalChargeAmount, TotalTaxAmount, TotalAmountWithTax, Balance, InvoiceDate, LastModifiedDate FROM Invoice WHERE Id = '${soqlEscape(invoiceId)}'`);
  const lines = await queryAt(client, v, `SELECT Id, Name, Product2Id, Product2.Name, Quantity, UnitPrice, ChargeAmount, TaxAmount, ChargeAmountWithTax, TaxRate, TaxCode, TaxProcessingStatus, TaxTreatmentId, TaxTreatment.Name, LegalEntityId, AdjustmentAmount, AdjustmentTaxAmount FROM InvoiceLine WHERE InvoiceId = '${soqlEscape(invoiceId)}' ORDER BY CreatedDate, Id`);
  let taxes: Record<string, unknown>[] = [];
  let taxRecordsError: string | null = null;
  if (lines.length) {
    try { taxes = await queryAt(client, v, `SELECT Id, InvoiceLineId, TaxName, TaxAmount, TaxRate, TaxCode, TaxProcessingStatus, TaxEffectiveDate, TaxTreatmentId, TaxTreatment.Name, LegalEntityId, TaxExemptAmount FROM InvoiceLineTax WHERE InvoiceLineId IN (${idList(lines.map(l => l.Id as string))}) ORDER BY CreatedDate`); }
    catch (e) { taxRecordsError = e instanceof Error ? e.message : String(e); }
  }
  return {
    // Invoice summary = Salesforce's invoice-level totals only (no fallback to another field whose meaning isn't verified).
    id: invoiceId, number: str(inv?.DocumentNumber), status: str(inv?.Status), subtotal: num(inv?.TotalChargeAmount), tax: num(inv?.TotalTaxAmount), totalWithTax: invoiceTotalWithTax(inv), balance: num(inv?.Balance), date: str(inv?.InvoiceDate),
    lines: lines.map(l => {
      const line: InvoiceTaxLine = {
        id: l.Id as string, name: str(l.Name), product: str((l.Product2 as Record<string, unknown> | null)?.Name), productId: str(l.Product2Id), quantity: num(l.Quantity), unitPrice: num(l.UnitPrice), charge: num(l.ChargeAmount), taxAmount: num(l.TaxAmount), chargeAmountWithTax: num(l.ChargeAmountWithTax),
        taxRate: num(l.TaxRate), taxCode: str(l.TaxCode), taxStatus: str(l.TaxProcessingStatus), treatment: named(l.TaxTreatmentId, l.TaxTreatment),
        legalEntityId: str(l.LegalEntityId), adjustmentAmount: num(l.AdjustmentAmount), adjustmentTaxAmount: num(l.AdjustmentTaxAmount),
        taxes: taxes.filter(t => t.InvoiceLineId === l.Id).map(t => ({ id: t.Id as string, name: str(t.TaxName), amount: num(t.TaxAmount), rate: num(t.TaxRate), code: str(t.TaxCode), status: str(t.TaxProcessingStatus), effectiveDate: str(t.TaxEffectiveDate), treatment: named(t.TaxTreatmentId, t.TaxTreatment), legalEntityId: str(t.LegalEntityId), exemptAmount: num(t.TaxExemptAmount) })),
      };
      return { ...line, totalWithTax: lineTotalWithTax(line, taxRecordsError) };
    }),
    taxRecordsError,
    modifiedAt: str(inv?.LastModifiedDate),
  };
}

/**
 * A RevenueTransactionErrorLog read. `unavailable` is set when the log couldn't be read (permission, API) — that is reported as
 * "unavailable", never treated as "no error".
 */
export interface ErrorLogRead { number: string | null; code: string | null; message: string | null; category?: string | null; at?: string | null; unavailable?: string | null }
export const errorLogUnavailable = (e: unknown): ErrorLogRead => ({ number: null, code: null, message: null, category: null, at: null, unavailable: `RevenueTransactionErrorLog couldn't be read: ${e instanceof Error ? e.message : String(e)}` });

export interface ActualTax { source: "SALESFORCE_INVOICELINETAX"; invoiceId: string; invoiceNumber: string | null; invoiceLineId: string; product: string | null; invoiceLineTaxId: string; taxAmount: number; taxRate: number | null; taxCode: string | null; taxName: string | null; taxTreatmentId: string | null; taxProcessingStatus: string | null; taxEffectiveDate: string | null }
export interface TaxDerivation {
  status: "CALCULATED" | "NO_TAX_EXPECTED" | "CALCULATION_PENDING" | "CALCULATION_FAILED"; reason: TaxCalcReason | null; actual: ActualTax[]; diagnostics: TaxDiagnostic[]; message: string;
  /** Set when lines without InvoiceLineTax were assessed for tax applicability (see taxApplicability.ts). */
  applicability?: InvoiceTaxApplicability;
}
/**
 * Whether tax applies to the invoice's untaxed lines:
 *  TAX_APPLIED (the other lines' InvoiceLineTax verified, the untaxed ones need none) · NOT_APPLICABLE · ZERO_TAX (0% rate) →
 *  posting allowed; APPLICABLE_NOT_CALCULATED (a rate applies, no InvoiceLineTax — a real calculation failure) · UNDETERMINED → blocked.
 */
export interface InvoiceTaxApplicability { verdict: "TAX_APPLIED" | "NOT_APPLICABLE" | "ZERO_TAX" | "APPLICABLE_NOT_CALCULATED" | "UNDETERMINED"; lines: LineApplicability[] }
/**
 * The treatment each product's tax policy selects, keyed by the 15-character Product2 Id:
 *   object = the policy's Default treatment · null = the product has NO tax policy (verified: no tax configured) ·
 *   key absent = not asserted (Manual / Legal Entity selection, or not read).
 */
/** One finding of the record-consistency check: `mismatch` = Salesforce's records contradict each other; `unverifiable` = they can't be checked. */
export interface TaxIntegrityFinding { kind: "mismatch" | "unverifiable"; check: string; recordId: string | null; message: string }

/**
 * Pure: do the invoice's own tax records agree with each other? Salesforce's records only — never an expected rate or tax code
 * from configuration. For every line that has InvoiceLineTax:
 *  · no zero-amount / zero-rate tax record (on a taxable line), no two records with the same tax code (a duplicate);
 *  · InvoiceLine.TaxAmount = the sum of its InvoiceLineTax;
 *  · each InvoiceLineTax's TaxTreatmentId and LegalEntityId = the line's;
 *  · each InvoiceLineTax's amount = the line's taxable base × that record's own rate. The base is established ONLY for a line with
 *    AdjustmentAmount 0, AdjustmentTaxAmount 0 and no exempt amount — then it is ChargeAmount (p10 DOC-000000021/24/32/33/35/36:
 *    every InvoiceLineTax amount = ChargeAmount × rate exactly, all with those fields 0). Anything else is unverifiable;
 *  · where Salesforce filled the line's own TaxCode / TaxRate (blank on every p10 line), they agree with a single tax record;
 *  · invoice level: TotalTaxAmount = the sum of the lines' TaxAmount.
 * Several records with different codes on one line (e.g. two component taxes) are each checked the same way and are allowed.
 * A value that wasn't read (undefined) or is blank is unknown → unverifiable, never assumed.
 */
export function checkTaxRecordIntegrity(inv: TaxInvoice): TaxIntegrityFinding[] {
  const out: TaxIntegrityFinding[] = [];
  const add = (kind: TaxIntegrityFinding["kind"], check: string, recordId: string | null, message: string) => out.push({ kind, check, recordId, message });
  const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol;
  let linesTotal = 0, linesKnown = true;
  for (const l of inv.lines.filter(x => x.taxes.length)) {
    const name = l.product ?? l.name ?? l.id;
    const sum = round2(l.taxes.reduce((n, t) => n + (t.amount ?? 0), 0));
    if (l.taxes.some(t => typeof t.amount !== "number")) add("unverifiable", "AMOUNT_UNKNOWN", l.id, `${name}: an InvoiceLineTax record has no amount.`);
    for (const t of l.taxes) if (t.amount === 0 || t.rate === 0) add("mismatch", "ZERO_TAX", t.id, `${name}: InvoiceLineTax ${t.id} has ${t.amount === 0 ? "amount 0" : "rate 0%"} on a taxable line.`);
    const byCode = new Map<string, string>();
    for (const t of l.taxes) {
      const k = (t.code ?? "").trim().toLowerCase();
      if (byCode.has(k)) add("mismatch", "DUPLICATE_TAX", t.id, `${name}: InvoiceLineTax ${byCode.get(k)} and ${t.id} have the same tax code ${t.code ?? "(blank)"} — a duplicate.`);
      else byCode.set(k, t.id);
    }
    if (l.taxAmount === null) { linesKnown = false; add("unverifiable", "LINE_TAX_UNKNOWN", l.id, `${name}: the line's TaxAmount is blank.`); }
    else { linesTotal += l.taxAmount; if (!near(l.taxAmount, sum)) add("mismatch", "LINE_TAX_AMOUNT", l.id, `${name}: line TaxAmount ${l.taxAmount} ≠ its InvoiceLineTax total ${sum}.`); }
    for (const t of l.taxes) {
      if (!t.treatment?.id || !l.treatment?.id) add("unverifiable", "TREATMENT_UNKNOWN", t.id, `${name}: the tax treatment of InvoiceLineTax ${t.id} or of its line is blank.`);
      else if (id15(t.treatment.id) !== id15(l.treatment.id)) add("mismatch", "TREATMENT", t.id, `${name}: InvoiceLineTax ${t.id} has tax treatment ${t.treatment.id}, its line ${l.treatment.id}.`);
      if (!t.legalEntityId || !l.legalEntityId) add("unverifiable", "LEGAL_ENTITY_UNKNOWN", t.id, `${name}: the legal entity of InvoiceLineTax ${t.id} or of its line is blank.`);
      else if (id15(t.legalEntityId) !== id15(l.legalEntityId)) add("mismatch", "LEGAL_ENTITY", t.id, `${name}: InvoiceLineTax ${t.id} has legal entity ${t.legalEntityId}, its line ${l.legalEntityId}.`);
    }
    if (l.taxes.length === 1) {
      const t = l.taxes[0];
      if (l.taxCode && t.code && l.taxCode.trim().toLowerCase() !== t.code.trim().toLowerCase()) add("mismatch", "TAX_CODE", t.id, `${name}: the line's TaxCode ${l.taxCode} ≠ its InvoiceLineTax's ${t.code}.`);
      if (l.taxRate !== null && t.rate !== null && !near(l.taxRate, t.rate, 0.0001)) add("mismatch", "TAX_RATE", t.id, `${name}: the line's TaxRate ${l.taxRate}% ≠ its InvoiceLineTax's ${t.rate}%.`);
    }
    // Taxable base: only established without adjustments or exemptions (see above); otherwise unverifiable, never assumed.
    const plain = l.adjustmentAmount === 0 && l.adjustmentTaxAmount === 0 && l.taxes.every(t => t.exemptAmount === 0 || t.exemptAmount === null) && l.taxes.every(t => t.exemptAmount !== undefined);
    if (!plain || l.charge === null) add("unverifiable", "BASE_UNKNOWN", l.id, `${name}: the taxable base can't be established (adjustment ${l.adjustmentAmount ?? "unknown"}, adjustment tax ${l.adjustmentTaxAmount ?? "unknown"}, exempt ${l.taxes.map(t => t.exemptAmount ?? "unknown").join("/")}).`);
    else for (const t of l.taxes) {
      if (t.amount === null || t.rate === null || t.amount === 0 || t.rate === 0) continue;
      const expected = round2(l.charge * t.rate / 100);
      if (!near(t.amount, expected, 0.01)) add("mismatch", "AMOUNT_VS_BASE", t.id, `${name}: InvoiceLineTax ${t.id} is ${t.amount}, but ${t.rate}% of the line's ${l.charge} is ${expected}.`);
    }
  }
  // Lines without tax records count 0 toward the line total only when their TaxAmount says so.
  for (const l of inv.lines.filter(x => !x.taxes.length)) if (l.taxAmount) { linesTotal += l.taxAmount; add("mismatch", "LINE_TAX_WITHOUT_RECORDS", l.id, `${l.product ?? l.name ?? l.id}: line TaxAmount ${l.taxAmount} but no InvoiceLineTax.`); }
  if (inv.tax === null) add("unverifiable", "INVOICE_TAX_UNKNOWN", inv.id, `Invoice ${inv.number ?? inv.id}'s TotalTaxAmount is blank.`);
  else if (linesKnown && !near(inv.tax, round2(linesTotal))) add("mismatch", "INVOICE_VS_LINES", inv.id, `Invoice ${inv.number ?? inv.id}'s TotalTaxAmount ${inv.tax} ≠ the sum of its lines' TaxAmount ${round2(linesTotal)}.`);
  return out;
}

export type ExpectedTreatments =Record<string, { id: string; name: string; taxable: boolean } | null>;

/**
 * Decide the tax status from Salesforce's invoice, its lines' InvoiceLineTax and treatments — the ONLY source of an actual amount.
 *  · CALCULATED: every taxable line has InvoiceLineTax with a numeric TaxAmount.
 *  · NO_TAX_EXPECTED: no taxable lines, Salesforce finished processing, and no line's product expects a taxable treatment.
 *  · CALCULATION_FAILED: InvoiceLineTax unreadable → TAX_RECORDS_UNREADABLE; a line billed with a fallback/non-taxable treatment
 *    while its product's policy selects a taxable one → TREATMENT_MISMATCH; Salesforce error → TAX_PROCESSING_ERROR; finished,
 *    taxable, zero tax, no InvoiceLineTax → INVOICE_TIME_TAX_NOT_APPLIED.
 *  · CALCULATION_PENDING: a taxable line is still being processed.
 */
export function deriveSalesforceTax(inv: TaxInvoice, treatments: { id: string; name: string; taxable: boolean }[], errorLogRead: ErrorLogRead | null, expected: ExpectedTreatments | null = null): TaxDerivation {
  const diagnostics: TaxDiagnostic[] = [];
  // An unreadable error log is stated (a Salesforce processing error can't be ruled out), never read as "no error".
  const logUnavailable = errorLogRead?.unavailable ?? null;
  const errorLog = logUnavailable ? null : errorLogRead;
  if (logUnavailable) diagnostics.push(diag("TAX_RECORDS_UNREADABLE", `${logUnavailable}. A Salesforce tax processing error on ${inv.number ?? inv.id} can't be ruled out.`, { severity: "warning", recordId: inv.id, operation: "RevenueTransactionErrorLog query", salesforceMessage: logUnavailable }));
  const treatmentTaxable = (id: string | null | undefined) => (id ? treatments.find(t => id15(t.id) === id15(id))?.taxable ?? null : null);
  // A line without a treatment whose product has no tax policy at all is verified non-taxable configuration.
  const lineTaxable = (l: InvoiceTaxLine) => { const x = treatmentTaxable(l.treatment?.id); if (x !== null) return x; return !l.treatment && expected && l.productId && id15(l.productId) in expected && expected[id15(l.productId)] === null ? false : null; };
  const doc = inv.number ?? inv.id;
  if (!inv.lines.length) return { status: "CALCULATION_PENDING", reason: null, actual: [], diagnostics: [diag("INVOICE_LINE_MISSING", `Invoice ${doc} has no lines yet.`, { severity: "warning", recordId: inv.id })], message: `Invoice ${doc} has no lines yet.` };
  if (inv.taxRecordsError) {
    diagnostics.push(diag("TAX_RECORDS_UNREADABLE", `The InvoiceLineTax records of ${doc} couldn't be read: ${inv.taxRecordsError}`, { recordId: inv.id, operation: "InvoiceLineTax query", salesforceMessage: inv.taxRecordsError }));
    return { status: "CALCULATION_FAILED", reason: "TAX_RECORDS_UNREADABLE", actual: [], diagnostics, message: `Invoice ${doc}'s InvoiceLineTax records couldn't be read (${inv.taxRecordsError}). Nothing is concluded about its tax — this is not zero tax.` };
  }
  // Salesforce is still processing the invoice: an "Estimated" line, a total or existing InvoiceLineTax aren't final yet.
  if (isInvoiceProcessing(inv.status)) {
    const message = `Salesforce is still processing invoice ${doc} (status ${inv.status}) — its tax isn't final until the invoice leaves that status.`;
    return { status: "CALCULATION_PENDING", reason: null, actual: [], diagnostics: [diag("INVOICE_LINE_TAX_PENDING", message, { severity: "warning", recordId: inv.id })], message };
  }
  const actual: ActualTax[] = inv.lines.flatMap(l => l.taxes.filter(t => typeof t.amount === "number").map(t => ({
    source: "SALESFORCE_INVOICELINETAX" as const, invoiceId: inv.id, invoiceNumber: inv.number, invoiceLineId: l.id, product: l.product, invoiceLineTaxId: t.id, taxAmount: t.amount as number,
    taxRate: t.rate, taxCode: t.code, taxName: t.name, taxTreatmentId: t.treatment?.id ?? l.treatment?.id ?? null, taxProcessingStatus: t.status, taxEffectiveDate: t.effectiveDate,
  })));
  const errored = /error/i.test(inv.status ?? "") || inv.lines.some(l => /error/i.test(l.taxStatus ?? "")) || (!!errorLog && /TAX/i.test(`${errorLog.code ?? ""}`));
  if (errored) {
    diagnostics.push(diag("INVOICE_LINE_TAX_MISSING", `Salesforce reported a tax calculation error on ${doc} (invoice ${inv.status ?? "—"}).`, { salesforceCode: errorLog?.code ?? null, salesforceMessage: errorLog?.message ?? null, recordId: inv.id, operation: "Salesforce invoice tax calculation" }));
    return { status: "CALCULATION_FAILED", reason: "TAX_PROCESSING_ERROR", actual, diagnostics, message: `Salesforce failed to calculate tax on ${doc}${errorLog ? ` — ${errorLog.number ?? ""} ${errorLog.code}: ${errorLog.message}` : ` (invoice ${inv.status})`}. No tax amount is reported.` };
  }
  // Fallback treatment: the line isn't taxable (or has no treatment) although its product's tax policy selects a taxable one.
  const fallback = expected ? inv.lines.filter(l => { const e = l.productId ? expected[id15(l.productId)] : null; return !!e && e.taxable && lineTaxable(l) !== true; }) : [];
  if (fallback.length) {
    for (const l of fallback) {
      const e = expected![id15(l.productId)]!;
      diagnostics.push(diag("TAX_TREATMENT_MISMATCH", `${l.product ?? l.name} on ${doc} was billed with ${l.treatment ? `tax treatment "${l.treatment.name}" (not taxable)` : "no tax treatment"}, but its product's tax policy selects the taxable treatment "${e.name}" — the order product's TaxTreatmentId was blank or different, so Salesforce applied a fallback.`, { recordId: l.id, operation: "OrderItem.TaxTreatmentId → BillingSchedule → InvoiceLine.TaxTreatmentId" }));
    }
    return { status: "CALCULATION_FAILED", reason: "TREATMENT_MISMATCH", actual, diagnostics, message: `Invoice ${doc} was billed with a fallback tax treatment for ${fallback.map(l => l.product ?? l.name).join(", ")} — tax was expected from the product's tax policy. This is not a verified zero-tax invoice.` };
  }
  const taxableLines = inv.lines.filter(l => lineTaxable(l) === true);
  const unknownLines = inv.lines.filter(l => lineTaxable(l) === null);
  // Still processing = Salesforce hasn't set a tax status yet or it is Pending (a Draft invoice estimated as "Estimated" is finished).
  const pendingStatus = (l: InvoiceTaxLine) => !l.taxStatus || /pending/i.test(l.taxStatus);
  const missing = taxableLines.filter(l => !l.taxes.some(t => typeof t.amount === "number"));
  if (taxableLines.length && !missing.length && !unknownLines.length) {
    // Invoice.TotalTaxAmount must equal the InvoiceLineTax it is made of — otherwise the line taxes aren't the whole story.
    const sum = Math.round(actual.reduce((n, a) => n + a.taxAmount, 0) * 100) / 100;
    if (inv.tax === null || Math.abs(inv.tax - sum) > 0.005) {
      diagnostics.push(diag("INVOICE_TAX_TOTAL_MISMATCH", `Invoice ${doc}'s TotalTaxAmount is ${inv.tax ?? "unreadable"}, but its InvoiceLineTax records add up to ${sum}.`, { recordId: inv.id, operation: "Invoice.TotalTaxAmount vs SUM(InvoiceLineTax.TaxAmount)" }));
      return { status: "CALCULATION_FAILED", reason: "TAX_PROCESSING_ERROR", actual, diagnostics, message: `Invoice ${doc}'s tax isn't verified: TotalTaxAmount ${inv.tax ?? "unreadable"} ≠ InvoiceLineTax total ${sum}.` };
    }
    // The records must also agree with each other line by line. This checks Salesforce's records against each other only — not
    // whether the rate or tax code is the right one for the sale (that is configuration validation, not done here).
    const findings = checkTaxRecordIntegrity(inv);
    const mismatches = findings.filter(f => f.kind === "mismatch"), unverifiable = findings.filter(f => f.kind === "unverifiable");
    if (mismatches.length) {
      for (const f of mismatches) diagnostics.push(diag("INVOICE_TAX_INTEGRITY_MISMATCH", f.message, { recordId: f.recordId ?? inv.id, operation: "InvoiceLineTax / InvoiceLine / Invoice consistency" }));
      return { status: "CALCULATION_FAILED", reason: "TAX_INTEGRITY_MISMATCH", actual, diagnostics, message: `Invoice ${doc}'s tax records are inconsistent — not verified: ${mismatches.map(f => f.message).join(" · ")}` };
    }
    if (unverifiable.length) {
      for (const f of unverifiable) diagnostics.push(diag("INVOICE_TAX_UNVERIFIABLE", f.message, { severity: "warning", recordId: f.recordId ?? inv.id, operation: "InvoiceLineTax / InvoiceLine / Invoice consistency" }));
      return { status: "CALCULATION_FAILED", reason: "TAX_UNVERIFIABLE", actual, diagnostics, message: `Invoice ${doc}'s tax can't be verified: ${unverifiable.map(f => f.message).join(" · ")}` };
    }
  }
  if (taxableLines.length && !missing.length && !unknownLines.length) return { status: "CALCULATED", reason: null, actual, diagnostics, message: `Salesforce calculated tax on ${doc}: ${actual.map(a => `${a.product ?? "line"} ${a.taxCode ?? a.taxName ?? ""} ${a.taxRate ?? "?"}% = ${a.taxAmount}`).join(" · ")} (source: InvoiceLineTax).` };
  if (!taxableLines.length && !unknownLines.length) {
    if (inv.lines.some(pendingStatus)) return { status: "CALCULATION_PENDING", reason: null, actual, diagnostics, message: `Salesforce hasn't finished tax processing on ${doc}.` };
    return { status: "NO_TAX_EXPECTED", reason: null, actual, diagnostics, message: `Salesforce finished tax processing on ${doc}; every line's tax treatment is non-taxable (${[...new Set(inv.lines.map(l => l.treatment?.name ?? "—"))].join(", ")})${expected ? " and no line's product policy selects a taxable treatment" : ""}, so no InvoiceLineTax is expected.` };
  }
  const stillWorking = [...missing, ...unknownLines].filter(pendingStatus);
  if (stillWorking.length) return { status: "CALCULATION_PENDING", reason: null, actual, diagnostics, message: `Waiting for Salesforce's InvoiceLineTax on ${doc} (${stillWorking.map(l => `${l.product ?? l.name}: ${l.taxStatus ?? "no tax status yet"}`).join(", ")}).` };
  for (const l of [...missing, ...unknownLines]) diagnostics.push(diag("INVOICE_LINE_TAX_MISSING", `${l.product ?? l.name} on ${doc}: Salesforce finished tax processing (${l.taxStatus}) with TaxAmount ${l.taxAmount ?? 0} but produced no InvoiceLineTax${l.treatment ? ` for treatment "${l.treatment.name}"` : " — the line has no tax treatment"}.`, { recordId: l.id, operation: "Salesforce invoice tax calculation" }));
  // Finished, taxable, zero tax, no InvoiceLineTax, no error → Salesforce didn't apply tax at invoice time.
  const notApplied = !unknownLines.length && missing.every(l => !l.taxAmount);
  return { status: "CALCULATION_FAILED", reason: notApplied ? "INVOICE_TIME_TAX_NOT_APPLIED" : "TAX_PROCESSING_ERROR", actual, diagnostics, message: `${NO_INVOICE_LINE_TAX} Invoice ${doc} was generated and Salesforce finished its tax processing (${[...missing, ...unknownLines].map(l => l.taxStatus).join(", ")}), but no InvoiceLineTax exists for the taxable line(s). No tax amount is reported.${logUnavailable ? " The error log couldn't be read, so a Salesforce processing error isn't ruled out." : ""}` };
}

/** Lines that carry no InvoiceLineTax with an amount — the ones whose tax applicability must be established. */
export const untaxedLines = (inv: TaxInvoice) => inv.lines.filter(l => !l.taxes.some(t => typeof t.amount === "number"));

/**
 * Pure: refine an INVOICE_TIME_TAX_NOT_APPLIED verdict (finished, taxable treatment, TaxAmount 0, no InvoiceLineTax, no error) with
 * the lines' tax applicability. A taxable treatment doesn't by itself mean tax applies — a rate must match the line's inputs:
 *  · a non-zero rate applies to any untaxed line → stays CALCULATION_FAILED (a genuine calculation failure, existing error kept);
 *  · applicability can't be proven for every untaxed line, the error log is unreadable or the invoice total doesn't agree → stays
 *    CALCULATION_FAILED (blocked) with the reason;
 *  · every untaxed line is proven NOT_APPLICABLE / ZERO_RATE → NO_TAX_EXPECTED (verified zero tax), or CALCULATED when other lines
 *    carry InvoiceLineTax that passes the same integrity checks as any taxed invoice.
 * Nothing is fabricated: no InvoiceLineTax and no amount is created; `actual` stays Salesforce's records only.
 */
export function applyTaxApplicability(inv: TaxInvoice, d: TaxDerivation, assessed: LineApplicability[], opts: { errorLogReadable: boolean }): TaxDerivation {
  if (d.status !== "CALCULATION_FAILED" || d.reason !== "INVOICE_TIME_TAX_NOT_APPLIED") return d;
  const doc = inv.number ?? inv.id;
  const byLine = new Map(assessed.map(a => [id15(a.invoiceLineId), a]));
  const lines: LineApplicability[] = untaxedLines(inv).map(l => byLine.get(id15(l.id)) ?? {
    invoiceLineId: l.id, line: l.product ?? l.name ?? l.id, verdict: "UNDETERMINED", reason: `${l.product ?? l.name ?? l.id}: tax applicability wasn't assessed.`,
    treatment: l.treatment ? { id: l.treatment.id, name: l.treatment.name, taxable: null } : null, decisionTable: null, matchedRate: null, referenceAmount: null, preview: null,
  });
  const applicable = lines.filter(a => a.verdict === "APPLICABLE");
  if (applicable.length) {
    const diagnostics = [...d.diagnostics, ...applicable.map(a => diag("TAX_APPLICABLE_NOT_CALCULATED", a.reason, { recordId: a.invoiceLineId, operation: "Decision-table evaluation vs InvoiceLineTax" }))];
    return { ...d, diagnostics, applicability: { verdict: "APPLICABLE_NOT_CALCULATED", lines }, message: `Tax calculation failed on ${doc} — tax applies, but ${NO_INVOICE_LINE_TAX.charAt(0).toLowerCase()}${NO_INVOICE_LINE_TAX.slice(1)} ${applicable.map(a => a.reason).join(" · ")} Salesforce finished processing with no tax, so the invoice must not be posted. No tax amount is reported.` };
  }
  const blockers = lines.filter(a => a.verdict === "UNDETERMINED").map(a => a.reason);
  if (!opts.errorLogReadable) blockers.push(`Salesforce's tax error log for ${doc} couldn't be read, so a processing error can't be ruled out.`);
  const recorded = round2(d.actual.reduce((n, a) => n + a.taxAmount, 0));
  if (inv.tax === null) blockers.push(`Invoice ${doc}'s TotalTaxAmount is blank.`);
  else if (Math.abs(inv.tax - recorded) > 0.005) blockers.push(`Invoice ${doc}'s TotalTaxAmount ${inv.tax} ≠ its InvoiceLineTax total ${recorded}.`);
  if (blockers.length) {
    const diagnostics = [...d.diagnostics, ...blockers.map(b => diag("TAX_APPLICABILITY_UNDETERMINED", b, { severity: "error", recordId: inv.id, operation: "Tax applicability" }))];
    return { ...d, diagnostics, applicability: { verdict: "UNDETERMINED", lines }, message: `${d.message} Whether tax applies couldn't be established: ${blockers.join(" · ")} Posting stays blocked — a missing InvoiceLineTax is never treated as zero tax without proof.` };
  }
  // Every untaxed line is proven to need no tax: the missing-InvoiceLineTax errors no longer apply.
  const kept = d.diagnostics.filter(x => x.code !== "INVOICE_LINE_TAX_MISSING");
  const info = lines.map(a => diag("TAX_NOT_APPLICABLE", a.reason, { severity: "info", recordId: a.invoiceLineId, operation: "Decision-table evaluation" }));
  const why = lines.map(a => a.reason).join(" · ");
  if (d.actual.length) {
    // Other lines were taxed: they pass the same record-consistency checks as any taxed invoice.
    const findings = checkTaxRecordIntegrity(inv);
    const mismatches = findings.filter(f => f.kind === "mismatch"), unverifiable = findings.filter(f => f.kind === "unverifiable");
    if (mismatches.length) return { ...d, reason: "TAX_INTEGRITY_MISMATCH", diagnostics: [...kept, ...mismatches.map(f => diag("INVOICE_TAX_INTEGRITY_MISMATCH", f.message, { recordId: f.recordId ?? inv.id, operation: "InvoiceLineTax / InvoiceLine / Invoice consistency" }))], applicability: { verdict: "TAX_APPLIED", lines }, message: `Invoice ${doc}'s tax records are inconsistent — not verified: ${mismatches.map(f => f.message).join(" · ")}` };
    if (unverifiable.length) return { ...d, reason: "TAX_UNVERIFIABLE", diagnostics: [...kept, ...unverifiable.map(f => diag("INVOICE_TAX_UNVERIFIABLE", f.message, { severity: "warning", recordId: f.recordId ?? inv.id, operation: "InvoiceLineTax / InvoiceLine / Invoice consistency" }))], applicability: { verdict: "TAX_APPLIED", lines }, message: `Invoice ${doc}'s tax can't be verified: ${unverifiable.map(f => f.message).join(" · ")}` };
    return { status: "CALCULATED", reason: null, actual: d.actual, diagnostics: [...kept, ...info], applicability: { verdict: "TAX_APPLIED", lines }, message: `Salesforce calculated tax on ${doc}: ${d.actual.map(a => `${a.product ?? "line"} ${a.taxCode ?? a.taxName ?? ""} ${a.taxRate ?? "?"}% = ${a.taxAmount}`).join(" · ")} (source: InvoiceLineTax). No tax applies to the other line(s): ${why}` };
  }
  const zero = lines.some(a => a.verdict === "ZERO_RATE");
  return { status: "NO_TAX_EXPECTED", reason: null, actual: [], diagnostics: [...kept, ...info], applicability: { verdict: zero ? "ZERO_TAX" : "NOT_APPLICABLE", lines }, message: `${zero ? "Zero tax" : "Tax not applicable"} on ${doc}: ${why} Salesforce finished tax processing with TotalTaxAmount 0 and no error, so no InvoiceLineTax is expected.` };
}

/** The tax outcome the billing lifecycles show — one of the three cases (plus pending / undetermined), from the shared verifier. */
export type InvoiceTaxOutcome = "TAX_APPLIED" | "TAX_NOT_APPLICABLE" | "ZERO_TAX" | "TAX_CALCULATION_FAILED" | "TAX_APPLICABILITY_UNDETERMINED" | "TAX_PENDING";
export function invoiceTaxOutcome(v: Pick<InvoiceTaxVerification, "state" | "derivation">): InvoiceTaxOutcome {
  const a = v.derivation.applicability?.verdict;
  if (v.state === "VERIFIED_TAX_APPLIED") return "TAX_APPLIED";
  if (v.state === "VERIFIED_ZERO_TAX") return a === "ZERO_TAX" ? "ZERO_TAX" : "TAX_NOT_APPLICABLE";
  if (v.state === "TAX_PENDING") return "TAX_PENDING";
  if (a === "UNDETERMINED" || v.state === "TAX_RECORDS_UNREADABLE" || v.state === "TAX_UNVERIFIABLE") return "TAX_APPLICABILITY_UNDETERMINED";
  return "TAX_CALCULATION_FAILED";
}
export const TAX_OUTCOME_LABEL: Record<InvoiceTaxOutcome, string> = {
  TAX_APPLIED: "Tax applicable and calculated",
  TAX_NOT_APPLICABLE: "Tax not applicable",
  ZERO_TAX: "Zero tax (0% rate)",
  TAX_CALCULATION_FAILED: "Tax applicable — calculation failed",
  TAX_APPLICABILITY_UNDETERMINED: "Tax applicability not established",
  TAX_PENDING: "Tax processing in progress",
};

/** SELECT only: the treatment each product's tax policy selects (Default selection; other selections → null = not asserted). */
export async function expectedTreatmentsForProducts(client: SalesforceClient, v: string, productIds: string[]): Promise<ExpectedTreatments> {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return {};
  const products = await queryAt(client, v, `SELECT Id, TaxPolicyId FROM Product2 WHERE Id IN (${idList(ids)})`);
  const policyIds = [...new Set(products.map(p => str(p.TaxPolicyId)).filter((x): x is string => !!x))];
  const policies = policyIds.length ? await queryAt(client, v, `SELECT Id, TreatmentSelection, DefaultTaxTreatmentId FROM TaxPolicy WHERE Id IN (${idList(policyIds)})`) : [];
  const tIds = [...new Set(policies.map(p => str(p.DefaultTaxTreatmentId)).filter((x): x is string => !!x))];
  const treatments = tIds.length ? await queryAt(client, v, `SELECT Id, Name, IsTaxable FROM TaxTreatment WHERE Id IN (${idList(tIds)})`) : [];
  const out: ExpectedTreatments = {};
  for (const p of products) {
    const pol = policies.find(x => id15(x.Id as string) === id15(str(p.TaxPolicyId)));
    if (!str(p.TaxPolicyId)) { out[id15(p.Id as string)] = null; continue; }
    const t = pol && (str(pol.TreatmentSelection) ?? "Default") === "Default" ? treatments.find(x => id15(x.Id as string) === id15(str(pol.DefaultTaxTreatmentId))) : null;
    if (t) out[id15(p.Id as string)] = { id: t.Id as string, name: String(t.Name), taxable: t.IsTaxable === true };
  }
  return out;
}

export interface InvoiceTaxVerification { invoice: TaxInvoice | null; derivation: TaxDerivation; state: TaxFlowState }

/**
 * Read-only verification of one invoice from Salesforce's records (invoice, lines, InvoiceLineTax, treatments, the products'
 * expected treatments). Any Salesforce read failure → TAX_RECORDS_UNREADABLE (never zero tax).
 */
export async function verifyInvoiceTax(client: SalesforceClient, invoiceId: string, opts: { applicability?: ApplicabilityApi | false } = {}): Promise<InvoiceTaxVerification> {
  try {
    const meta = await discoverTaxMetadata(client);
    const v = meta.apiVersion;
    const inv = await readInvoice(client, v, invoiceId);
    if (!objectMeta(meta, "TaxTreatment")) {
      // Lines that carry a treatment while the object isn't describable = a permission/version problem, never "no tax".
      if (inv.lines.some(l => l.treatment)) throw new Error("the Tax Treatment object isn't visible to this user (describe failed), but the invoice lines carry tax treatments");
      const derivation: TaxDerivation = { status: "NO_TAX_EXPECTED", reason: null, actual: [], diagnostics: [], message: "This org has no Revenue Cloud tax objects — no tax is configured for its invoices." };
      return { invoice: inv, derivation, state: "VERIFIED_ZERO_TAX" };
    }
    const tIds = [...new Set(inv.lines.map(l => l.treatment?.id).filter((x): x is string => !!x))];
    const treatments = tIds.length ? (await queryAt(client, v, `SELECT Id, Name, IsTaxable FROM TaxTreatment WHERE Id IN (${idList(tIds)})`)).map(t => ({ id: String(t.Id), name: String(t.Name), taxable: t.IsTaxable === true })) : [];
    const expected = objectMeta(meta, "TaxPolicy") ? await expectedTreatmentsForProducts(client, v, inv.lines.map(l => l.productId).filter((x): x is string => !!x)) : null;
    const refs = [inv.id, ...inv.lines.map(l => l.id)];
    // The error log enriches the verdict; a failed read is passed on as "unavailable" (reported), never as "no error".
    let errorLog: ErrorLogRead | null = null;
    try {
      const [log] = await queryAt(client, v, `SELECT ErrorLogNumber, ErrorCode, ErrorMessage FROM RevenueTransactionErrorLog WHERE PrimaryRecordId IN (${idList(refs)}) OR RelatedRecordId IN (${idList(refs)}) ORDER BY CreatedDate DESC LIMIT 1`);
      errorLog = log ? { number: str(log.ErrorLogNumber), code: str(log.ErrorCode), message: str(log.ErrorMessage) } : null;
    } catch (e) { errorLog = errorLogUnavailable(e); }
    let derivation = deriveSalesforceTax(inv, treatments, errorLog, expected);
    // No InvoiceLineTax on a finished taxable line: establish whether tax actually applies before calling it a failure (or zero tax).
    if (derivation.reason === "INVOICE_TIME_TAX_NOT_APPLIED" && opts.applicability !== false) {
      const untaxed = untaxedLines(inv);
      let assessed: LineApplicability[];
      try { assessed = await assessInvoiceApplicability(opts.applicability ?? await applicabilityApiFor(client), inv.id, untaxed); }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        assessed = untaxed.map(l => ({ invoiceLineId: l.id, line: l.product ?? l.name ?? l.id, verdict: "UNDETERMINED" as const, reason: `${l.product ?? l.name ?? l.id}: tax applicability couldn't be checked (${msg}).`, treatment: null, decisionTable: null, matchedRate: null, referenceAmount: null, preview: null }));
      }
      derivation = applyTaxApplicability(inv, derivation, assessed, { errorLogReadable: !errorLog?.unavailable });
    }
    return { invoice: inv, derivation, state: invoiceTaxFlowState(derivation.status, derivation.reason) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const derivation: TaxDerivation = { status: "CALCULATION_FAILED", reason: "TAX_RECORDS_UNREADABLE", actual: [], diagnostics: [diag("TAX_RECORDS_UNREADABLE", `Invoice ${invoiceId}'s tax records couldn't be read: ${msg}`, { recordId: invoiceId, salesforceMessage: msg })], message: `Invoice ${invoiceId}'s tax records couldn't be read (${msg}). Nothing is concluded about its tax.` };
    return { invoice: null, derivation, state: "TAX_RECORDS_UNREADABLE" };
  }
}

/** SELECT only: each billing schedule's tax treatment and order product (OrderItem.TaxTreatmentId → BillingSchedule.TaxTreatmentId). */
export async function readScheduleTreatments(client: SalesforceClient, scheduleIds: string[]): Promise<{ id: string; number: string | null; orderItemId: string | null; treatment: Named | null; taxable: boolean | null }[]> {
  if (!scheduleIds.length) return [];
  const v = (await discoverTaxMetadata(client)).apiVersion;
  const rows = await queryAt(client, v, `SELECT Id, BillingScheduleNumber, ReferenceEntityItemId, TaxTreatmentId, TaxTreatment.Name, TaxTreatment.IsTaxable FROM BillingSchedule WHERE Id IN (${idList(scheduleIds)})`);
  return rows.map(r => ({ id: r.Id as string, number: str(r.BillingScheduleNumber), orderItemId: str(r.ReferenceEntityItemId), treatment: named(r.TaxTreatmentId, r.TaxTreatment), taxable: typeof (r.TaxTreatment as Record<string, unknown> | null)?.IsTaxable === "boolean" ? (r.TaxTreatment as Record<string, unknown>).IsTaxable as boolean : null }));
}

/**
 * Pure: may a Draft invoice be posted? Only when Salesforce's tax is verified — applied (InvoiceLineTax on every taxable line, the
 * records consistent with each other) or verifiably not due (non-taxable configuration). Everything else blocks posting.
 *
 * `allowUnverifiedTax` no longer bypasses anything: an override must be audited (who, when, why, the verifier's findings) and this
 * application has no persistent audit store, so it fails closed until an audited override is approved. Posting code reports the
 * refused override with TAX_OVERRIDE_UNAVAILABLE (see invoicePostingGate).
 */
export function postingDecision(state: TaxFlowState, allowUnverifiedTax = false): { allowed: boolean; code: TaxFlowState | null } {
  void allowUnverifiedTax;
  if (state === "VERIFIED_TAX_APPLIED" || state === "VERIFIED_ZERO_TAX") return { allowed: true, code: null };
  return { allowed: false, code: state };
}

export const TAX_OVERRIDE_UNAVAILABLE = "TAX_OVERRIDE_UNAVAILABLE" as const;

/**
 * The one posting gate every invoice-posting path uses (order billing and the debit-memo lifecycle). Pure over the shared verifier's
 * result. A requested override is refused (fail closed — no audit store exists) and reported as such, with the verifier's findings.
 */
export function invoicePostingGate(v: InvoiceTaxVerification, opts: { allowUnverifiedTax?: boolean } = {}): { allowed: true } | { allowed: false; code: TaxFlowState | typeof TAX_OVERRIDE_UNAVAILABLE; error: string; findings: TaxDiagnostic[] } {
  const d = postingDecision(v.state);
  if (d.allowed) return { allowed: true };
  const doc = v.invoice?.number ?? v.invoice?.id ?? "the invoice";
  if (opts.allowUnverifiedTax) return { allowed: false, code: TAX_OVERRIDE_UNAVAILABLE, error: `Posting blocked — ${doc}'s tax isn't verified (${v.state}): ${v.derivation.message} An override (allowUnverifiedTax) can't be accepted: overrides must be audited and no audit store is configured. Nothing was posted.`, findings: v.derivation.diagnostics };
  return { allowed: false, code: v.state, error: `Posting blocked — ${v.derivation.message}`, findings: v.derivation.diagnostics };
}
