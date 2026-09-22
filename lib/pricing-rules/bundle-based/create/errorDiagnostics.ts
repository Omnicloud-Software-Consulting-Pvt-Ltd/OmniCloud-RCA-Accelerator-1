/**
 * Turns a caught error into the structured `CreateFailure` shape the frontend renders — mirrors
 * lib/pricing-rules/attribute-based/create/errorDiagnostics.ts exactly (same SalesforceError message
 * extraction, same never-leak-the-stack-to-the-client discipline), with bundle-specific resolution hints.
 */
import { SalesforceError } from "@/lib/salesforce/client";
import type { CreateFailure } from "./types";

const RESOLUTION_HINTS: Record<string, string> = {
  "create-schedule": "Confirm the connected user has create access to PriceAdjustmentSchedule.",
  "create-rule": "Confirm the connected user has create access to BundleBasedAdjRule and that this bundle's Product2 record is accessible.",
  "create-condition": "Confirm the connected user has create access to BundleAdjustmentCondition and that every requested component is a real Product2 record.",
  "create-adjustment": "Confirm the connected user has create access to BundleBasedAdjustment.",
  "build-expression-set": "Review the canvas build warnings below — a required template step or binding may be missing from the donor Expression Set.",
  "validate-expression-set": "Review the validation errors below — the cloned canvas failed a structural check before deploy.",
  "deploy-pricing-procedure": "Check the Salesforce Metadata API error details below; the connected user may need additional deploy permissions, or the generated XML may need adjustment.",
  "activate-version": "The metadata already deployed successfully — you can activate the Expression Set Version manually in Setup.",
  "verify-salesforce": "Some created records could not be confirmed via read-back — check the details below and re-verify in Setup before trusting this procedure.",
};

function genericHint(step: string): string {
  return RESOLUTION_HINTS[step] ?? "Check the details below and retry. If this keeps happening, check the server logs for the full stack trace.";
}

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
  console.error(`[pricing-rules/bundle-based/create] "${step}" failed:`, err);

  if (err instanceof SalesforceError) {
    const salesforceErrorMessage = extractSalesforceMessage(err);
    return {
      step, endpoint, httpStatus: err.status, salesforceErrorCode: err.errorCode, salesforceErrorMessage,
      reason: `${step} failed (HTTP ${err.status}${err.errorCode ? `, ${err.errorCode}` : ""}): ${salesforceErrorMessage}`,
      resolutionHint: genericHint(step),
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return { step, endpoint, reason: `${step} failed: ${message}`, resolutionHint: genericHint(step) };
}

export function buildLogicalFailure(step: string, reason: string, endpoint?: string, extra?: Partial<CreateFailure>): CreateFailure {
  return { step, endpoint, reason, resolutionHint: genericHint(step), ...extra };
}
