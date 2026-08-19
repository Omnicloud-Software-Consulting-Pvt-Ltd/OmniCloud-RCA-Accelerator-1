/**
 * Turns a caught error into the structured `CreateFailure` shape the
 * frontend renders as a diagnostic panel, and always logs the full error
 * (including stack trace, for a plain Error) to the server console first —
 * the stack never leaves the server; the client only gets the structured,
 * user-facing fields below (Part R: never silently swallow a failure).
 */
import { SalesforceError } from "@/lib/salesforce/client";
import type { CreateFailure } from "./types";

const RESOLUTION_HINTS: Record<string, string> = {
  "create-values": "Confirm the connected user has create access to AttributePicklistValue, and that the attribute's values genuinely come from the standard AttributePicklistValue object on this org.",
  "create-lookup-table": "Confirm the connected user has create access to PriceAdjustmentSchedule, AttributeBasedAdjRule, AttributeAdjustmentCondition, and AttributeBasedAdjustment, and that ProductAttributeDefinition rows exist for this product.",
  "build-expression-set": "Review the canvas build warnings below — a required template step or binding may be missing from the donor Expression Set.",
  "validate-expression-set": "Review the validation errors below — the cloned canvas failed a structural check before deploy.",
  "deploy-pricing-procedure": "Check the Salesforce Metadata API error details below; the connected user may need additional deploy permissions, or the generated XML may need adjustment.",
  "activate-version": "The metadata already deployed successfully — you can activate the Expression Set Version manually in Setup.",
  "verify-salesforce": "Some created records could not be confirmed via read-back — check the details below and re-verify in Setup before trusting this procedure.",
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

export function buildFailureDiagnostics(step: string, err: unknown, endpoint?: string): CreateFailure {
  // The stack trace (and the raw error object) only ever goes to the server console — never the JSON response.
  console.error(`[pricing-rules/attribute-based/create] "${step}" failed:`, err);

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

/** For a logical (non-exception) failure — e.g. "value creation unsupported for this attribute" — where there's no caught error object, just a known reason. */
export function buildLogicalFailure(step: string, reason: string, endpoint?: string, extra?: Partial<CreateFailure>): CreateFailure {
  return { step, endpoint, reason, resolutionHint: genericHint(step), ...extra };
}
