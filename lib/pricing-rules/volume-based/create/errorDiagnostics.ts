/**
 * Turns a caught error into the structured `CreateFailure` shape the frontend renders — mirrors
 * lib/pricing-rules/bundle-based/create/errorDiagnostics.ts exactly, with volume-specific resolution hints.
 */
import { SalesforceError } from "@/lib/salesforce/client";
import type { CreateFailure } from "./types";

const RESOLUTION_HINTS: Record<string, string> = {
  "preflight": "Review the donor-resolution diagnostics below — no valid schedule-based VolumeDiscount Expression Set donor was found in this org.",
  "resolve-product": "Confirm the product name resolves to exactly one real Product2 record.",
  "create-schedule": "Confirm the connected user has create access to PriceAdjustmentSchedule.",
  "create-tiers": "Confirm the connected user has create access to PriceAdjustmentTier and that every tier row has a valid TierType/TierValue.",
  "build-expression-set": "Review the canvas build warnings below — a required template step or binding may be missing from the donor Expression Set, or the Decision Table resolution may have failed.",
  "validate-expression-set": "Review the validation errors below — the cloned canvas failed a structural check before deploy.",
  "deploy-pricing-procedure": "Check the Salesforce Metadata API error details below; the connected user may need additional deploy permissions, or the generated XML may need adjustment.",
  "activate-version": "The metadata already deployed successfully — you can activate the Expression Set Version manually in Setup.",
  "activate-schedule": "The metadata and native records already deployed successfully — you can activate the PriceAdjustmentSchedule manually in Setup.",
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
  console.error(`[pricing-rules/volume-based/create] "${step}" failed:`, err);

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
