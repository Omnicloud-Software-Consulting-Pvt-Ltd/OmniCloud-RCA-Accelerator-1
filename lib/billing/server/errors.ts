import { NextResponse } from "next/server";
import { SalesforceError } from "@/lib/salesforce/client";
import { sfErrorResponse } from "@/lib/salesforce/serverSession";
import { BillingModuleUnavailableError } from "@/lib/billing/server/discovery";
import type { BillingFriendlyError } from "@/lib/billing/types";

export interface SalesforceErrorItem {
  message?: string;
  errorCode?: string;
  statusCode?: string;
  fields?: string[];
}

export interface BillingErrorContext {
  /** e.g. "Billing Treatment" */
  objectLabel: string;
  /** Resolves a field API name to its human label (falls back to the API name). */
  fieldLabel?: (apiName: string) => string;
}

function joinLabels(fields: string[] | undefined, ctx: BillingErrorContext): string {
  const labels = (fields ?? []).map(f => ctx.fieldLabel?.(f) ?? f);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * Turn one Salesforce error item into a sentence a billing admin can act on.
 * The raw code/message is never discarded — callers keep it in `technical`.
 */
export function describeSalesforceError(item: SalesforceErrorItem, ctx: BillingErrorContext): { message: string; possibleCause: string | null } {
  const code = item.errorCode ?? item.statusCode ?? "";
  const fields = joinLabels(item.fields, ctx);
  const raw = item.message ?? "Salesforce rejected the request.";
  const obj = ctx.objectLabel;

  switch (code) {
    case "INVALID_FIELD_FOR_INSERT_UPDATE":
      // Revenue Cloud Billing uses this code for its own business rules too, with a specific,
      // actionable message ("Specify the sequencing as Manual for non-milestone billing") — keep
      // those verbatim; only the generic field-permission form gets rewritten.
      if (item.message && !/unable to create\/update fields/i.test(item.message)) {
        return {
          message: `${obj}${fields ? ` — ${fields}` : ""}: ${item.message}`,
          possibleCause: "This is a Revenue Cloud Billing configuration rule enforced by the connected org. Change the value as described and try again.",
        };
      }
      return {
        message: `The ${obj} cannot be created because ${fields ? `the ${fields} field` : "a field"} is missing, read-only or unavailable in the connected Salesforce org.`,
        possibleCause: "The field may be system-managed, hidden by field-level security, or not part of this org's Revenue Cloud Billing API version. Remove it or ask an admin to grant edit access.",
      };
    case "REQUIRED_FIELD_MISSING":
      return {
        message: `The ${obj} is missing required information${fields ? `: ${fields}` : ""}.`,
        possibleCause: "Fill in every field marked Required and try again.",
      };
    case "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST":
      return {
        message: `${fields ? `The value for ${fields}` : "A picklist value"} isn't one of the values allowed in this org.`,
        possibleCause: "Pick a value from the list — the org restricts this picklist to its configured values.",
      };
    case "INVALID_CROSS_REFERENCE_KEY":
      return {
        message: `${fields ? `The record selected for ${fields}` : "A related record"} doesn't exist or isn't visible to your Salesforce user.`,
        possibleCause: "Re-select the related record using the lookup — it may have been deleted or you may lack access to it.",
      };
    case "FIELD_INTEGRITY_EXCEPTION":
      return {
        message: `Salesforce rejected ${fields ? `the ${fields} value` : "a value"} for this ${obj}: ${raw}`,
        possibleCause: "The related record is probably of the wrong type or in a state that can't be referenced (for example Inactive).",
      };
    case "FIELD_CUSTOM_VALIDATION_EXCEPTION":
      return {
        message: `A validation rule in the connected org blocked this ${obj}: ${raw}`,
        possibleCause: "Adjust the values to satisfy the org's validation rule, or ask the org admin about it.",
      };
    case "DUPLICATE_VALUE":
      return {
        message: `A ${obj} with the same unique value already exists${fields ? ` (${fields})` : ""}.`,
        possibleCause: "Codes and names used as unique keys must be unique — change the value and try again.",
      };
    case "STRING_TOO_LONG":
      return { message: `${fields ? `${fields} is` : "A value is"} longer than Salesforce allows.`, possibleCause: "Shorten the text and try again." };
    case "INSUFFICIENT_ACCESS_OR_READONLY":
    case "INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY":
      return {
        message: `Your Salesforce user doesn't have permission to create this ${obj} or to link one of its related records.`,
        possibleCause: "Ask an admin to assign the Revenue Cloud Billing permission sets (e.g. Billing Admin) to your user.",
      };
    case "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY":
      return {
        message: `Salesforce automation (a trigger or flow) rejected this ${obj}: ${raw}`,
        possibleCause: "Check the org's billing automation, or try creating the record as Draft first.",
      };
    case "INVALID_TYPE":
    case "NOT_FOUND":
      return {
        message: `The ${obj} object isn't available through the API for your user in this org.`,
        possibleCause: "Revenue Cloud Billing may not be enabled, or the object needs a newer API version / permission set.",
      };
    case "INVALID_FIELD":
      return { message: `A field requested for the ${obj} doesn't exist in this org: ${raw}`, possibleCause: "Refresh the metadata — the org's schema may have changed." };
    case "PROCESSING_HALTED":
      return { message: `Nothing was saved because another record in the same request failed.`, possibleCause: null };
    default:
      return { message: raw, possibleCause: null };
  }
}

/** Build a friendly error from several Salesforce error items (e.g. a Composite response), skipping PROCESSING_HALTED noise when a real cause exists. */
export function summarizeSalesforceErrors(items: SalesforceErrorItem[], ctx: BillingErrorContext): { message: string; possibleCause: string | null; code: string | null } {
  const meaningful = items.filter(i => (i.errorCode ?? i.statusCode) !== "PROCESSING_HALTED");
  const primary = meaningful[0] ?? items[0];
  if (!primary) return { message: `Salesforce rejected the ${ctx.objectLabel}.`, possibleCause: null, code: null };
  const described = describeSalesforceError(primary, ctx);
  // Several rule violations on one record are all actionable — list up to three instead of hiding them.
  const others = meaningful.slice(1, 3).map(i => describeSalesforceError(i, ctx).message);
  const more = meaningful.length > 3 ? ` (+${meaningful.length - 3} more — see technical details)` : "";
  const message = others.length ? `${described.message.replace(/\.?$/, ".")} Also: ${others.map(o => o.replace(/\.?$/, "")).join("; ")}.${more}` : described.message;
  return { message, possibleCause: described.possibleCause, code: primary.errorCode ?? primary.statusCode ?? null };
}

/**
 * Standard error response for every billing route. Session expiry and API-
 * limit exhaustion are delegated to the app-wide `sfErrorResponse` so they
 * behave exactly like every other module; everything else is translated.
 */
export function billingErrorResponse(err: unknown, fallbackMessage: string, ctx?: BillingErrorContext): NextResponse {
  if (err instanceof BillingModuleUnavailableError) {
    const body: BillingFriendlyError = {
      error: err.message,
      code: "BILLING_MODULE_UNAVAILABLE",
      possibleCause: "Revenue Cloud Billing (or this feature of it) isn't enabled in the connected org, or your user lacks access to it.",
      technical: { moduleKey: err.moduleKey, candidatesTried: err.candidatesTried },
    };
    return NextResponse.json(body, { status: 404 });
  }
  if (err instanceof SalesforceError) {
    if (err.status === 401 || err.errorCode === "REQUEST_LIMIT_EXCEEDED") return sfErrorResponse(err, fallbackMessage);
    const items: SalesforceErrorItem[] = Array.isArray(err.body) ? err.body : [{ message: err.message, errorCode: err.errorCode }];
    const summary = summarizeSalesforceErrors(items, ctx ?? { objectLabel: "record" });
    const body: BillingFriendlyError = {
      error: summary.message,
      code: summary.code,
      possibleCause: summary.possibleCause,
      technical: { httpStatus: err.status, salesforceErrors: items, rawText: err.rawText },
    };
    return NextResponse.json(body, { status: err.status >= 400 ? err.status : 500 });
  }
  const body: BillingFriendlyError = {
    error: err instanceof Error ? err.message : fallbackMessage,
    code: "BILLING_ERROR",
    possibleCause: null,
    technical: err instanceof Error ? { name: err.name, message: err.message } : err,
  };
  return NextResponse.json(body, { status: 500 });
}
