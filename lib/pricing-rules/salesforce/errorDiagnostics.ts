/**
 * §3 — turns a caught error into the structured `CreateProcedureFailure`
 * shape the frontend renders as a diagnostic panel, and always logs the
 * full error (including stack trace, for a plain Error) to the server
 * console first — the stack never leaves the server; the client only
 * gets the structured, user-facing fields below.
 */
import { SalesforceError } from "@/lib/salesforce/client";
import type { CreateProcedureFailure } from "@/lib/pricing-rules/types";

const RESOLUTION_HINTS: Record<string, string> = {
  "Product Lookup": "Confirm the product name/Id is correct and the connected user has read access to Product2.",
  "Fetch Selling Model": "Confirm this product has a ProductSellingModelOption configured in Revenue Cloud.",
  "Retrieve Template Expression Set": "Deploy at least one working Pricing Procedure with an AttributeDiscount step in this org to clone from — this action type can't be authored from a blank canvas.",
  "Build Expression Set XML": "Review the canvas build warnings below — a required template step or binding may be missing from the donor Expression Set.",
  "Validate XML": "Review the validation errors below — the cloned canvas failed a structural check before deploy.",
  "Deploy Metadata": "Check the Salesforce Metadata API error details below; the connected user may need additional deploy permissions, or the generated XML may need adjustment.",
  "Create Price Adjustment Schedule": "Confirm the connected user has create access to PriceAdjustmentSchedule.",
  "Create Attribute Rules": "Confirm the connected user has create access to AttributeBasedAdjRule.",
  "Create Attribute Conditions": "Confirm the connected user has create access to AttributeAdjustmentCondition and that ProductAttributeDefinition rows exist for this product.",
  "Create Attribute Adjustments": "Confirm the connected user has create access to AttributeBasedAdjustment.",
  "Verify Runtime Execution": "Check the execution report's blocker details for the specific pricing-engine failure.",
};

function genericHint(step: string): string {
  return RESOLUTION_HINTS[step] ?? "Check the details below and retry. If this keeps happening, check the server logs for the full stack trace.";
}

/** Extracts a readable Salesforce error message off a SalesforceError's body, which may be a REST error array, a single object, or unparsed raw text. */
function extractSalesforceMessage(err: SalesforceError): string {
  if (Array.isArray(err.body)) {
    const messages = err.body.map((b: { message?: string }) => b?.message).filter(Boolean);
    if (messages.length > 0) return messages.join("; ");
  }
  if (err.body && typeof err.body === "object" && "message" in err.body && typeof (err.body as { message?: unknown }).message === "string") {
    return (err.body as { message: string }).message;
  }
  if (err.rawText) return err.rawText.slice(0, 500);
  return err.message;
}

export function buildFailureDiagnostics(step: string, err: unknown, endpoint?: string): CreateProcedureFailure {
  // The stack trace (and the raw error object) only ever goes to the server console — never the JSON response.
  console.error(`[create-procedure] "${step}" failed:`, err);

  if (err instanceof SalesforceError) {
    const salesforceErrorMessage = extractSalesforceMessage(err);
    return {
      step,
      endpoint,
      httpStatus: err.status,
      salesforceErrorCode: err.errorCode,
      salesforceErrorMessage,
      reason: `${step} failed (HTTP ${err.status}${err.errorCode ? `, ${err.errorCode}` : ""}): ${salesforceErrorMessage}`,
      resolutionHint: genericHint(step),
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    step,
    endpoint,
    reason: `${step} failed: ${message}`,
    resolutionHint: genericHint(step),
  };
}

/** §3 — classifies buildAttributeCanvas's structured fatalErrors (not exceptions) into the required step vocabulary, since that function reports failures as strings rather than throwing per-stage. Shared by create-procedure and auto-create — both build/validate the same canvas the same way. */
export function classifyCanvasFailureStep(fatalErrors: string[]): string {
  const joined = fatalErrors.join(" ");
  if (/template Expression Set|template step|No PricingSettings step|No ListPrice step|No AttributeDiscount step/i.test(joined)) return "Retrieve Template Expression Set";
  if (/customElement|PriceAdjustmentScheduleId|leaked|actionType|NetUnitPrice|LookUpId|LookUpName|LookUpApiName|ListPriceField|structurally|schema|child element ORDER|invalid at this location|no top-level <steps>/i.test(joined)) return "Validate XML";
  return "Build Expression Set XML";
}

/** For a logical (non-exception) failure — e.g. "product not found" — where there's no caught error object, just a known reason. */
export function buildLogicalFailure(step: string, reason: string, endpoint?: string, extra?: Partial<CreateProcedureFailure>): CreateProcedureFailure {
  return { step, endpoint, reason, resolutionHint: genericHint(step), ...extra };
}

