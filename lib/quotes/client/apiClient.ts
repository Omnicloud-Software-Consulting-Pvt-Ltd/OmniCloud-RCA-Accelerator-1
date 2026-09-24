import { beginExecutionLogEntry, completeExecutionLogEntry } from "@/lib/quotes/client/executionLog";
import { deriveStructuredError } from "@/lib/quotes/client/errors";
import type { StructuredError } from "@/lib/quotes/types";

export class QuoteApiError extends Error {
  status: number;
  code: string | null;
  structured: StructuredError;
  /** The execution-log entry id this call was recorded under — lets the UI jump to / highlight the failing log row. */
  logEntryId: string;
  raw: unknown;
  /** The domain-specific structured failure body (e.g. LineItemFailureDetail), when the endpoint returned one. */
  failureDetail: unknown;

  constructor(message: string, status: number, code: string | null, structured: StructuredError, logEntryId: string, raw?: unknown, failureDetail?: unknown) {
    super(message);
    this.name = "QuoteApiError";
    this.status = status;
    this.code = code;
    this.structured = structured;
    this.logEntryId = logEntryId;
    this.raw = raw;
    this.failureDetail = failureDetail ?? null;
  }
}

/**
 * Extract the best available human message from a non-2xx JSON body. Many
 * endpoints return a domain-shaped result (e.g. `{success:false, issues,
 * errors, failureDetail}`) rather than a bare `{error}` — checking only
 * `.error` produces a generic "Request failed with status 422" even though
 * the body is full of specifics. Checked in order of specificity.
 */
function extractErrorMessage(json: Record<string, unknown> | null, status: number): string {
  if (!json) return `Request failed with status ${status}`;
  const failureDetail = json.failureDetail as { reason?: string; currentStep?: string } | null | undefined;
  if (failureDetail?.reason) {
    return failureDetail.currentStep ? `[${failureDetail.currentStep}] ${failureDetail.reason}` : failureDetail.reason;
  }
  // Contract/Order activation (and similar {success:false, message, salesforceError}
  // domain results) return this shape with a non-2xx status — without this, the real
  // Salesforce rejection reason (e.g. a validation rule) is discarded in favor of a
  // generic "Request failed with status 422", and the caller's own `if (!res.success)`
  // handling (written as if this response resolves rather than throws) never runs.
  if (typeof json.salesforceError === "string") return json.salesforceError;
  if (typeof json.error === "string") return json.error;
  if (Array.isArray(json.issues) && typeof json.issues[0] === "string") return json.issues[0] as string;
  const errorsArr = json.errors as { message?: string }[] | undefined;
  if (Array.isArray(errorsArr) && errorsArr[0]?.message) return errorsArr[0].message;
  if (json.success === false && typeof json.message === "string") return json.message;
  return `Request failed with status ${status}`;
}

/**
 * Shared internal-API client wrapper (§3.8, §6.5) — every client call to a
 * Quote module endpoint goes through this so every call is automatically
 * logged (begin/end, duration, redacted request/response), and every
 * failure is converted into a structured, field-aware error.
 */
export async function callQuoteApi<T>(label: string, method: string, path: string, body?: unknown): Promise<T> {
  const logId = beginExecutionLogEntry(label, method, path, body ?? null);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network request failed.";
    // §Distinguish network failure from every other error class (§8 of the
    // request-limit fix) — this request never reached the server at all,
    // unlike every other QuoteApiError below (which always has a real HTTP
    // response, even a non-2xx one).
    const structured = deriveStructuredError(message, "NETWORK_ERROR");
    completeExecutionLogEntry(logId, 0, null, structured);
    throw new QuoteApiError(message, 0, "NETWORK_ERROR", structured, logId, { message });
  }

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const message = extractErrorMessage(json, res.status);
    const structured = deriveStructuredError(message, json?.code ?? null);
    completeExecutionLogEntry(logId, res.status, json, structured);
    throw new QuoteApiError(message, res.status, json?.code ?? null, structured, logId, json, json?.failureDetail ?? null);
  }

  completeExecutionLogEntry(logId, res.status, json);
  return json as T;
}

export const quoteApiGet = <T>(label: string, path: string) => callQuoteApi<T>(label, "GET", path);
export const quoteApiPost = <T>(label: string, path: string, body?: unknown) => callQuoteApi<T>(label, "POST", path, body ?? {});
export const quoteApiPatch = <T>(label: string, path: string, body?: unknown) => callQuoteApi<T>(label, "PATCH", path, body ?? {});
export const quoteApiPut = <T>(label: string, path: string, body?: unknown) => callQuoteApi<T>(label, "PUT", path, body ?? {});
export const quoteApiDelete = <T>(label: string, path: string, body?: unknown) => callQuoteApi<T>(label, "DELETE", path, body);

export interface ErrorPanelDataLike {
  title: string;
  message: string;
  possibleCause?: string | null;
  code?: string | null;
  status?: number | null;
  raw?: unknown;
  logEntryId?: string | null;
  failureDetail?: unknown;
}

/** Convert any caught error (QuoteApiError or generic) into the ErrorPanel's shape, for consistent display everywhere. */
export function toErrorPanelData(err: unknown, title: string): ErrorPanelDataLike {
  if (err instanceof QuoteApiError) {
    return {
      title,
      message: err.message,
      possibleCause: err.structured.possibleCause,
      code: err.code,
      status: err.status,
      raw: err.raw,
      logEntryId: err.logEntryId,
      failureDetail: err.failureDetail,
    };
  }
  return { title, message: err instanceof Error ? err.message : "An unexpected error occurred.", raw: err };
}
