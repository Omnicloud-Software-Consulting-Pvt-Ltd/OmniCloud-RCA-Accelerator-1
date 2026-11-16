/**
 * TAX CALCULATION — status model and result shapes shared by the service, the routes and the UI.
 *
 * The only actual tax is Salesforce's InvoiceLineTax. A decision-table match (configuration or Salesforce's own evaluation
 * preview) is NOT a calculation, and the configured rate × amount is a reference value only — both are labelled as such
 * everywhere they appear.
 */

export type TaxCalcStatus =
  | "NOT_READY" // validation failed — nothing was created
  | "READY" // validation passed
  | "PREVIEW_MATCH" // Salesforce's decision-table evaluation matched (preview only)
  | "AWAITING_CONFIRMATION" // the next billable step waits for the user's confirmation
  | "IN_PROGRESS" // between steps (Salesforce is working, or a non-billable step ran)
  | "CALCULATION_PENDING" // the invoice exists; Salesforce hasn't finished its tax processing
  | "CALCULATED" // Salesforce created InvoiceLineTax with a TaxAmount
  | "CALCULATION_FAILED"
  | "CALCULATION_TIMEOUT" // the bounded wait for InvoiceLineTax expired
  | "NO_TAX_EXPECTED"; // Salesforce finished, every line's treatment is non-taxable

export type TaxCalcReason =
  | "INVOICE_TIME_TAX_NOT_APPLIED" // invoice generated, Salesforce finished, TaxAmount 0 and no InvoiceLineTax, no error
  | "DECISION_TABLE_STALE"
  | "DECISION_TABLE_NO_MATCH"
  | "AMBIGUOUS_TAX_TREATMENT"
  | "ACCOUNT_REQUIRED"
  | "CONFIGURATION_NOT_READY"
  | "ORDER_ACTIVATION_FAILED"
  | "BILLING_SCHEDULE_FAILED"
  | "INVOICE_GENERATION_FAILED"
  | "TAX_PROCESSING_ERROR"
  | "SALESFORCE_ERROR"
  | "TREATMENT_MISMATCH" // the invoice line carries another (e.g. the legal entity's non-taxable) treatment than the product's policy selects
  | "TAX_RECORDS_UNREADABLE" // InvoiceLineTax / treatment records couldn't be read — nothing is concluded
  | "TAX_INTEGRITY_MISMATCH" // Salesforce's own invoice tax records contradict each other (amounts, legal entity, treatment, duplicates)
  | "TAX_UNVERIFIABLE"; // the records can't be checked for consistency (e.g. adjustments make the taxable base unknown) — never "verified"

/**
 * The end-to-end tax state names used across order readiness, invoicing and posting. They are a VIEW over the existing status
 * model (TaxCalcStatus + TaxCalcReason for invoices; the readiness categories for orders) — not a second state machine.
 */
export type TaxFlowState =
  | "READY" | "BLOCKED_CONFIGURATION" | "MISSING_TAX_RATE" | "TREATMENT_MISMATCH" | "INVALID_GEOGRAPHY" | "MISSING_SELLING_MODEL"
  | "INVOICE_GENERATION_FAILED" | "TAX_CALCULATION_FAILED" | "TAX_RECORDS_UNREADABLE" | "TAX_VERIFICATION_FAILED"
  | "VERIFIED_ZERO_TAX" | "VERIFIED_TAX_APPLIED" | "TAX_PENDING" | "TAX_INTEGRITY_MISMATCH" | "TAX_UNVERIFIABLE";

/** Invoice-side state from Salesforce's records. Unreadable / pending is never a verified state. */
export function invoiceTaxFlowState(status: TaxCalcStatus, reason: TaxCalcReason | null): TaxFlowState {
  if (status === "CALCULATED") return "VERIFIED_TAX_APPLIED";
  if (status === "NO_TAX_EXPECTED") return "VERIFIED_ZERO_TAX";
  if (status === "CALCULATION_PENDING" || status === "CALCULATION_TIMEOUT" || status === "IN_PROGRESS" || status === "AWAITING_CONFIRMATION") return "TAX_PENDING";
  if (reason === "TAX_RECORDS_UNREADABLE") return "TAX_RECORDS_UNREADABLE";
  if (reason === "TAX_INTEGRITY_MISMATCH") return "TAX_INTEGRITY_MISMATCH";
  if (reason === "TAX_UNVERIFIABLE") return "TAX_UNVERIFIABLE";
  if (reason === "TREATMENT_MISMATCH") return "TREATMENT_MISMATCH";
  if (reason === "INVOICE_GENERATION_FAILED") return "INVOICE_GENERATION_FAILED";
  if (reason === "INVOICE_TIME_TAX_NOT_APPLIED") return "TAX_VERIFICATION_FAILED";
  if (status === "CALCULATION_FAILED") return "TAX_CALCULATION_FAILED";
  return status === "READY" || status === "PREVIEW_MATCH" ? "READY" : "BLOCKED_CONFIGURATION";
}

export const PREVIEW_LABEL = "Decision-table preview — not yet an invoice-time Salesforce tax result." as const;
export const REFERENCE_LABEL = "Expected/reference amount — NOT a Salesforce calculation." as const;
export const NO_INVOICE_LINE_TAX = "Salesforce did not generate an InvoiceLineTax record." as const;

/** The inputs a Revenue Standard Tax decision table matches on (values the transaction carries). Dates are YYYY-MM-DD. */
export interface TaxInputs {
  Country: string | null; State: string | null; City: string | null; ZipCode: string | null; ProductCode: string | null;
  StartDate: string | null; EndDate: string | null; RateUsageType: string | null; LegalEntityId: string | null; TaxCode: string | null;
}

/** Salesforce's own decision-table evaluation (POST /connect/business-rules/decision-table/{id}). Preview only. */
export interface DecisionTablePreview {
  label: typeof PREVIEW_LABEL;
  decisionTableId: string;
  decisionTableName: string | null;
  endpoint: string;
  conditions: { fieldName: string; value: string; operator: string }[];
  httpStatus: number | null;
  outcomeType: string | null;
  matched: boolean;
  outcomes: Record<string, unknown>[];
  rate: number | null;
  applicationBasis: string | null;
  priority: number | null;
  /** The TaxRate row the application resolved for the same inputs (Salesforce's evaluation returns only the outputs). */
  taxRate: { id: string; name: string; taxCode: string | null; rate: number | null } | null;
  /** Salesforce's outputs agree with that TaxRate row (null when either side is missing). */
  consistent: boolean | null;
  /** Salesforce's exact error when the evaluation call failed. */
  error: { status: number; code: string | null; message: string } | null;
}

/** The authoritative success result — every value read from Salesforce's InvoiceLineTax (basis from the matched TaxRate). */
export interface AuthoritativeTax {
  status: "CALCULATED";
  source: "SALESFORCE";
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceLineId: string;
  invoiceLineTaxId: string;
  taxAmount: number;
  taxRate: number | null;
  taxCode: string | null;
  /** InvoiceLineTax has no basis field: taken from the TaxRate the decision table matched, and labelled so. */
  applicationBasis: string | null;
  applicationBasisSource: "TaxRate" | null;
}

/** Evidence attached when Salesforce produced no InvoiceLineTax (or to explain an invoice's result). Read-only. */
export interface InvoiceTaxEvidence {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceLineId: string | null;
  taxTreatmentId: string | null;
  taxEngineId: string | null;
  decisionTableId: string | null;
  invoiceTaxAmount: number | null;
  invoiceLineTaxAmount: number | null;
  taxProcessingStatus: string | null;
  invoiceLineTaxCount: number;
  errorLogCount: number;
  /** Read-only relationship trace classification (CONFIGURATION_MATCH / INVOICE_TIME_TAX_NOT_APPLIED / …). */
  traceClassification: string | null;
  matchedTaxRate: { id: string; name: string; outputs: Record<string, unknown> } | null;
  /**
   * The rate that matches TODAY was created or changed AFTER this invoice was generated — today's preview then says nothing about the
   * configuration Salesforce used at invoice time (p10 DOC-000000018: TR-00000021 was created after it; E1-B proved the old rate didn't
   * match). null when not the case or not determinable.
   */
  configurationChangedAfterInvoice?: { rate: string; rateChangedAt: string; invoiceCreatedAt: string } | null;
  preview: DecisionTablePreview | null;
  /** Salesforce errors raised while gathering the evidence (never swallowed). */
  errors: string[];
}

/** Map a run's failed step to its reason. */
export function reasonForStep(step: string | null | undefined): TaxCalcReason {
  switch (step) {
    case "activate": case "setup": case "config": return "ORDER_ACTIVATION_FAILED";
    case "schedules": return "BILLING_SCHEDULE_FAILED";
    case "invoice": return "INVOICE_GENERATION_FAILED";
    case "tax": case "readiness": return "TAX_PROCESSING_ERROR";
    default: return "SALESFORCE_ERROR";
  }
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
