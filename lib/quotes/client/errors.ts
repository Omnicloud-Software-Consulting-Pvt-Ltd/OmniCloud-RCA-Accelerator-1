import type { StructuredError } from "@/lib/quotes/types";

const ERROR_CODE_CAUSES: Record<string, string> = {
  UNAUTHENTICATED: "Your Salesforce session has expired or was never established. Sign in again.",
  TOKEN_EXPIRED: "Your Salesforce session token expired. Sign in again.",
  // §REQUEST_LIMIT_EXCEEDED remediation — a distinct, friendly cause so this
  // reads as an org-wide capacity issue, not a bug in whichever dashboard
  // happened to hit it. sfErrorResponse (lib/salesforce/serverSession.ts)
  // already rewrites the top-level message to this same wording; this
  // entry covers callers that only pass the raw code through.
  SALESFORCE_API_LIMIT_EXCEEDED: "Salesforce API request capacity has been temporarily exhausted. Please wait before retrying.",
  NETWORK_ERROR: "This request never reached the server — check your network connection.",
  REQUIRED_FIELD_MISSING: "A field Salesforce requires for this object was left blank in the request.",
  FIELD_CUSTOM_VALIDATION_EXCEPTION: "A validation rule configured in this Salesforce org rejected the request.",
  DUPLICATE_VALUE: "Salesforce rejected this because a duplicate rule matched an existing record.",
  INSUFFICIENT_ACCESS_OR_READONLY: "The connected Salesforce user doesn't have permission to perform this action.",
  MALFORMED_ID: "One of the record Ids sent to Salesforce was not a valid Id.",
  ENTITY_IS_DELETED: "The record this action targeted has already been deleted in Salesforce.",
  STORAGE_LIMIT_EXCEEDED: "This Salesforce org has run out of data storage.",
  INVALID_CROSS_REFERENCE_KEY: "A reference field pointed at a record that doesn't exist or isn't visible to this user.",
};

function isBillingTreatmentShaped(message: string): boolean {
  return /billing\s?(treatment|policy)/i.test(message) || /cannot change billing frequency/i.test(message);
}

/**
 * Derive a structured, human-readable error from a Salesforce/API failure
 * (§3.8, §6.5). Billing-Treatment-shaped errors are specifically recognized
 * as a Revenue Cloud configuration issue in the connected org, not a defect
 * in this app.
 */
export function deriveStructuredError(message: string, code?: string | null): StructuredError {
  const isConfigurationIssue = isBillingTreatmentShaped(message);
  const possibleCause = (code && ERROR_CODE_CAUSES[code]) ?? (isConfigurationIssue
    ? "This looks like a Billing Treatment/Policy configuration gap in the connected Salesforce org, not a problem with this app."
    : null);

  return {
    message,
    possibleCause,
    isConfigurationIssue,
    code: code ?? null,
  };
}
