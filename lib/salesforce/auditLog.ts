/**
 * §API/JSON Audit Trail — reusable, generic infrastructure (not attribute-based-pricing-specific)
 * for turning a SalesforceClient's already-collected `debugLog` into a sanitized, UI-safe record of
 * every REST operation a run performed. Never displays raw server logs/stack traces — only the
 * structured request/response JSON a caller opted to surface.
 */
import type { SalesforceDebugLogEntry } from "./client";

export interface SanitizedAuditEntry {
  timestamp: number;
  method?: string;
  url?: string;
  /** The sObject this call targeted, parsed from a `/sobjects/<Object>[/<Id>]` URL when present. */
  object?: string;
  request: unknown;
  response: unknown;
  httpStatus?: number;
  durationMs?: number;
  status: "success" | "error";
}

/** Every key (anywhere, at any nesting depth) matching one of these is redacted before the value is
 * ever displayed or returned to a client — Salesforce access/refresh tokens, Anthropic API keys,
 * Authorization headers, client secrets, cookies, session ids, and passwords. */
const SENSITIVE_KEY_PATTERN = /(authorization|access.?token|refresh.?token|api.?key|client.?secret|\bcookie\b|session.?id|password|\bsecret\b)/i;

export function sanitizeForAudit(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map(v => sanitizeForAudit(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_PATTERN.test(k) ? "[REDACTED]" : sanitizeForAudit(v, seen);
  }
  return out;
}

function extractObjectFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return url.match(/\/sobjects\/([A-Za-z0-9_]+)/)?.[1];
}

/** Filters `debugLog` down to real REST operations (skips plain diagnostic/trace entries that never
 * carried a request/response body) and sanitizes every one before returning it. */
export function buildSanitizedAuditLog(debugLog: SalesforceDebugLogEntry[]): SanitizedAuditEntry[] {
  return debugLog
    .filter(e => e.type === "rest" && e.httpStatus !== undefined)
    .map(e => ({
      timestamp: e.timestamp,
      method: e.method,
      url: e.url,
      object: extractObjectFromUrl(e.url),
      request: sanitizeForAudit(e.requestBody),
      response: sanitizeForAudit(e.responseBody),
      httpStatus: e.httpStatus,
      durationMs: e.durationMs,
      status: e.httpStatus !== undefined && e.httpStatus >= 200 && e.httpStatus < 300 ? "success" as const : "error" as const,
    }));
}
