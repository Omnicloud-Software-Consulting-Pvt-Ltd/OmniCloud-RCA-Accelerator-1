/**
 * Turns a caught error into the structured `CreateFailure` shape the
 * frontend renders as a diagnostic panel, and always logs the full error
 * (including stack trace, for a plain Error) to the server console first —
 * the stack never leaves the server; the client only gets the structured,
 * user-facing fields below (Part R: never silently swallow a failure).
 */
import { SalesforceError } from "@/lib/salesforce/client";
import type { CreateFailure, SalesforceFailureCategory } from "./types";
import type { ComponentFailure } from "./soapEnvelope";

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

/**
 * §Phase 5 fix (generic failure-category classification) — pattern-matches on Salesforce's OWN error
 * text/code, never on which pipeline step failed, so a storage-capacity rejection is labeled correctly no
 * matter WHERE it surfaces (native-record creation, Expression Set Version deploy, Pricing Procedure
 * creation, or activation) — never collapsed into an undifferentiated "Expression Set error." Neither
 * pattern list references any product/org/step name — purely Salesforce's own, universally-documented
 * error vocabulary.
 */
const STORAGE_LIMIT_PATTERNS = [/storage limit exceeded/i, /STORAGE_LIMIT_EXCEEDED/i];
const API_LIMIT_PATTERNS = [/REQUEST_LIMIT_EXCEEDED/i, /TotalRequests Limit exceeded/i];

function textMatchesAny(text: string | null | undefined, patterns: RegExp[]): boolean {
  if (!text) return false;
  return patterns.some(p => p.test(text));
}

export function classifyFailureCategory(errorCode: string | null | undefined, messageOrProblem: string | null | undefined): SalesforceFailureCategory | "unclassified" {
  if (textMatchesAny(errorCode, STORAGE_LIMIT_PATTERNS) || textMatchesAny(messageOrProblem, STORAGE_LIMIT_PATTERNS)) return "salesforce-storage-limit";
  if (textMatchesAny(errorCode, API_LIMIT_PATTERNS) || textMatchesAny(messageOrProblem, API_LIMIT_PATTERNS)) return "salesforce-api-limit";
  return "unclassified";
}

/** Same classification applied across a whole Metadata API `componentFailures` array — a deploy can report
 * multiple component problems; this returns the category of the first one that matches a known pattern
 * (storage checked before API, since a storage rejection surfacing mid-deploy is the case this fix
 * specifically targets), or "unclassified" if none do. */
export function classifyComponentFailures(failures: ComponentFailure[] | null | undefined): SalesforceFailureCategory | "unclassified" {
  for (const f of failures ?? []) {
    const category = classifyFailureCategory(f.problemType, f.problem);
    if (category !== "unclassified") return category;
  }
  return "unclassified";
}

const CATEGORY_RESOLUTION_HINTS: Partial<Record<SalesforceFailureCategory | "unclassified", string>> = {
  "salesforce-storage-limit": "This org's Salesforce Data Storage is exhausted — this is NOT an Expression Set/XML defect, and no amount of retrying or code changes will fix it. Recover or provision additional Data Storage in Setup before retrying.",
  "salesforce-api-limit": "This org's Salesforce API request limit is exhausted for today — this is NOT an Expression Set/XML defect. Wait for the daily limit to reset, or provision additional API capacity, before retrying.",
};

export const CATEGORY_LABELS: Partial<Record<SalesforceFailureCategory | "unclassified", string>> = {
  "salesforce-storage-limit": "ORG CAPACITY — Salesforce Data Storage exhausted, not an Expression Set/XML defect",
  "salesforce-api-limit": "ORG CAPACITY — Salesforce API limit exhausted, not an Expression Set/XML defect",
};

export function buildFailureDiagnostics(step: string, err: unknown, endpoint?: string): CreateFailure {
  // The stack trace (and the raw error object) only ever goes to the server console — never the JSON response.
  console.error(`[pricing-rules/attribute-based/create] "${step}" failed:`, err);

  if (err instanceof SalesforceError) {
    const salesforceErrorMessage = extractSalesforceMessage(err);
    const category = classifyFailureCategory(err.errorCode, salesforceErrorMessage);
    const label = CATEGORY_LABELS[category];
    return {
      step,
      endpoint,
      httpStatus: err.status,
      salesforceErrorCode: err.errorCode,
      salesforceErrorMessage,
      category: category !== "unclassified" ? category : undefined,
      reason: `${label ? `[${label}] ` : ""}${step} failed (HTTP ${err.status}${err.errorCode ? `, ${err.errorCode}` : ""}): ${salesforceErrorMessage}`,
      resolutionHint: CATEGORY_RESOLUTION_HINTS[category] ?? genericHint(step),
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
