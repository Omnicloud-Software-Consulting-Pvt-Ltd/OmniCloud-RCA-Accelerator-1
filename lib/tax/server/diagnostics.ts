/**
 * TAX CALCULATION DIAGNOSTICS — one explicit code per way the calculation pipeline can stop, each with the stage it belongs to,
 * a plain explanation and what to do. Salesforce's own message is always carried verbatim next to the explanation; nothing is
 * hidden or rephrased away.
 */

export type DiagnosticStage = "configuration" | "readiness" | "calculation" | "order" | "billing-schedule" | "invoice" | "invoice-line" | "invoice-line-tax" | "permission";
export type DiagnosticSeverity = "error" | "warning" | "info";

export interface TaxDiagnostic {
  code: DiagnosticCode;
  stage: DiagnosticStage;
  severity: DiagnosticSeverity;
  title: string;
  /** What this means, in context (record names included by the caller). */
  explanation: string;
  /** Salesforce's exact message, when Salesforce produced one. */
  salesforceMessage?: string | null;
  salesforceCode?: string | null;
  /** HTTP status of the Salesforce call, when one failed. */
  httpStatus?: number | null;
  /** The Salesforce object / operation the diagnostic is about (e.g. "TaxRate query", "Invoice generation"). */
  operation?: string | null;
  /** What to do next. */
  action?: string | null;
  recordId?: string | null;
}

const CATALOG = {
  MISSING_PRODUCT: { stage: "configuration", title: "Product not found", action: "Check the product name or product code." },
  INACTIVE_PRODUCT: { stage: "configuration", title: "Product is inactive", action: "Activate the product before ordering it." },
  MISSING_TAX_POLICY: { stage: "configuration", title: "No Tax Policy on the product", action: "Assign a Tax Policy to the product (Taxes → Configure: \"Assign <policy> to the <product> product\")." },
  INACTIVE_TAX_POLICY: { stage: "configuration", title: "Tax Policy is not Active", action: "Activate the Tax Policy (its default treatment must be Active first)." },
  MANUAL_TREATMENT_SELECTION: { stage: "configuration", title: "Tax Policy uses Manual treatment selection", action: "Salesforce applies the treatment set on the order product; choose one there, or switch the policy to Default selection." },
  MISSING_TAX_TREATMENT: { stage: "configuration", title: "No applicable Tax Treatment", action: "Give the Tax Policy a default treatment (or a treatment for the legal entity)." },
  AMBIGUOUS_TAX_TREATMENT: { stage: "configuration", title: "More than one Tax Treatment applies", action: "Specify the legal entity, or keep one active treatment per legal entity in the policy." },
  INACTIVE_TAX_TREATMENT: { stage: "configuration", title: "Tax Treatment is not Active", action: "Activate the Tax Treatment." },
  NON_TAXABLE_TREATMENT: { stage: "configuration", title: "Tax Treatment is not taxable", action: "Salesforce applies no tax with this treatment. Use a taxable treatment if tax is expected." },
  MISSING_TAX_TREATMENT_ITEM: { stage: "configuration", title: "No Tax Treatment Item for the product", action: "The treatment uses Tax Treatment Items — create one for this product." },
  MISSING_TAX_CODE: { stage: "configuration", title: "No tax code", action: "Set a Tax Code on the Tax Treatment Item (or the treatment)." },
  MISSING_TAX_RATE: { stage: "configuration", title: "No applicable Tax Rate", action: "Create an effective Revenue Cloud Tax Rate for this tax code and geography." },
  AMBIGUOUS_TAX_RATE: { stage: "configuration", title: "More than one Tax Rate applies equally", action: "Make the rates distinct (geography, product code, legal entity or effective dates) — the application doesn't guess." },
  MISSING_GEOGRAPHY: { stage: "configuration", title: "Geography missing", action: "Provide the country (and state if the rates are state-specific); create the GeoCountry / GeoState if it doesn't exist." },
  MISSING_TAX_ENGINE: { stage: "configuration", title: "No Tax Engine on the treatment", action: "Set the Revenue Standard Tax engine on the taxable treatment." },
  INACTIVE_TAX_ENGINE: { stage: "configuration", title: "Tax Engine is not Active", action: "Activate the tax engine, or use the active Revenue Standard Tax engine." },
  UNSUPPORTED_TAX_ENGINE: { stage: "configuration", title: "Tax Engine isn't Revenue Standard Tax", action: "Its tax is calculated by an external provider adapter." },
  MISSING_DECISION_TABLE_RELATIONSHIP: { stage: "readiness", title: "No decision table for the engine", action: "Salesforce's Revenue Standard Tax Entries table must exist (or be assigned on the engine)." },
  DECISION_TABLE_NOT_READY: { stage: "readiness", title: "Decision table not ready", action: "A Salesforce administrator must correct the Revenue Standard Tax decision table (Setup → Lookup Tables); the application never edits or clones it." },
  DECISION_TABLE_REFRESHING: { stage: "readiness", title: "Decision table is refreshing", action: "Wait for Salesforce to finish refreshing; the check re-reads it." },
  CALCULATION_ENDPOINT_UNAVAILABLE: { stage: "calculation", title: "Direct tax calculation isn't available for this engine", action: "Salesforce calculates Revenue Standard Tax on invoices — run the billing-lifecycle validation (order → invoice) to get Salesforce's tax." },
  CALCULATION_REJECTED: { stage: "calculation", title: "Salesforce rejected the tax calculation", action: "Correct the request or configuration named in Salesforce's message, then calculate again." },
  ORDER_NOT_READY: { stage: "order", title: "Order isn't ready for tax", action: "Fix the order data named in the explanation (account, address, product, quantity, price) before activating it." },
  ORDER_ACTIVATION_FAILED: { stage: "order", title: "Order activation failed", action: "Resolve Salesforce's activation error (shown verbatim), then retry activation." },
  BILLING_SCHEDULE_MISSING: { stage: "billing-schedule", title: "No Billing Schedule", action: "Activate the order, or request Salesforce's billing schedules; if a schedule job failed, fix the data named in its response." },
  INVOICE_GENERATION_FAILED: { stage: "invoice", title: "Invoice generation failed", action: "Resolve Salesforce's invoicing error (shown verbatim), then retry invoice generation." },
  INVOICE_MISSING: { stage: "invoice", title: "No invoice", action: "Generate the invoice from the order's billing schedules." },
  INVOICE_LINE_MISSING: { stage: "invoice-line", title: "No invoice lines", action: "Check the invoice's billing schedules in Salesforce — Salesforce creates the invoice lines; the application never does." },
  INVOICE_LINE_TAX_PENDING: { stage: "invoice-line-tax", title: "Tax not calculated yet", action: "Salesforce calculates estimated tax on Draft invoices (Calculate Tax), or when the invoice is posted." },
  INVOICE_TAX_INTEGRITY_MISMATCH: { stage: "invoice-line-tax", title: "Invoice tax records inconsistent", action: "Salesforce's own tax records on this invoice contradict each other — don't post it. Investigate the invoice in Salesforce; the application never edits invoice amounts or InvoiceLineTax." },
  INVOICE_TAX_UNVERIFIABLE: { stage: "invoice-line-tax", title: "Invoice tax can't be verified", action: "The invoice's tax records can't be checked for consistency (for example, adjustments make the taxable base unknown). It isn't treated as verified and isn't posted." },
  INVOICE_TAX_TOTAL_MISMATCH: { stage: "invoice-line-tax", title: "Invoice tax total ≠ InvoiceLineTax", action: "Re-read the invoice after Salesforce finishes processing; if the totals still differ, recalculate the Draft invoice's tax (approved action) — the application never edits invoice amounts." },
  INVOICE_LINE_TAX_MISSING: { stage: "invoice-line-tax", title: "No InvoiceLineTax", action: "Check the line's tax treatment and Salesforce's tax error log; InvoiceLineTax is generated by Salesforce only — it is never created by the application." },
  INVOICE_LINE_TAX_MISMATCH: { stage: "invoice-line-tax", title: "InvoiceLineTax doesn't match the applicable rate", action: "Check which rate Salesforce applied (and the decision table refresh) — nothing is adjusted by the application." },
  TAX_NOT_APPLICABLE: { stage: "invoice-line-tax", title: "No tax applies to the line", action: "Salesforce's own decision-table evaluation finds no tax rate (or a 0% rate) for the line's inputs and the table is up to date, so no InvoiceLineTax is expected." },
  TAX_APPLICABLE_NOT_CALCULATED: { stage: "invoice-line-tax", title: "Tax applies but Salesforce didn't calculate it", action: "A tax rate applies to the line, but Salesforce produced no InvoiceLineTax — don't post. Recalculate the Draft invoice's tax (approved action) or open a Salesforce Support case; the application never creates tax records." },
  TAX_APPLICABILITY_UNDETERMINED: { stage: "invoice-line-tax", title: "Whether tax applies can't be established", action: "Resolve the condition named in the explanation (decision table refresh, missing tax input, unreadable record), then retry — posting stays blocked until tax applicability is proven." },
  TAX_TREATMENT_MISMATCH: { stage: "invoice-line", title: "Invoice line billed with a different tax treatment", action: "The order product had no (or another) Tax Treatment, so Salesforce billed a fallback treatment. The invoice can't be fixed in place — create a new order whose order products carry the product policy's treatment." },
  TAX_RECORDS_UNREADABLE: { stage: "permission", title: "Tax records couldn't be read", action: "Salesforce refused or failed the query (permission, field or API version) — nothing is concluded about the tax until the records can be read." },
  PERMISSION_OR_LICENSE: { stage: "permission", title: "Salesforce permission or license", action: "The current user needs the Revenue Cloud Billing / tax permission sets and licenses for this operation." },
} as const satisfies Record<string, { stage: DiagnosticStage; title: string; action: string | null }>;

export type DiagnosticCode = keyof typeof CATALOG;

export function diag(code: DiagnosticCode, explanation: string, extra: Partial<Omit<TaxDiagnostic, "code" | "stage" | "title" | "explanation">> = {}): TaxDiagnostic {
  const c = CATALOG[code];
  return { code, stage: c.stage, severity: "error", title: c.title, explanation, action: c.action, ...extra };
}

/** Salesforce errors that mean "this user/org can't do it" rather than "the data is wrong". */
export function isPermissionError(status: number | null | undefined, code: string | null | undefined, message: string | null | undefined): boolean {
  return status === 401 || status === 403 || /INSUFFICIENT_ACCESS|FUNCTIONALITY_NOT_ENABLED|NOT_LICENSED|API_DISABLED|PERMISSION|LICENSE/i.test(`${code ?? ""} ${message ?? ""}`);
}

export const DIAGNOSTIC_CODES = Object.keys(CATALOG) as DiagnosticCode[];
