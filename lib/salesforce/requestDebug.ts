/**
 * Debug Mode diagnostics for the REQUEST_LIMIT_EXCEEDED remediation
 * (§9 of the request-limit fix). This app has no toggleable "Debug Mode" UI
 * anywhere — every existing diagnostic in this codebase is a plain,
 * always-on `console.log` line inspected via server logs (see the many
 * "§Perf instrumentation"/"§TEMP DIAGNOSTIC" comments throughout
 * lib/quotes, lib/orders, lib/pricing-rules). This follows the same
 * convention rather than inventing a new debug-toggle subsystem: one
 * structured line per cached/deduplicated Salesforce request, safe to leave
 * on permanently since it never includes tokens, secrets, or record data —
 * only the endpoint, caller, cache key, and cache outcome.
 */
export interface SfCacheDebugEvent {
  /** The internal API route or module this request serves, e.g. "/api/orders/stats". */
  endpoint: string;
  /** The function/operation actually computing the value on a cache miss, e.g. "computeOrderStats". */
  caller: string;
  /** The cache/dedup key — an instance URL (or instanceUrl:object) string, never a token. */
  cacheKey: string;
  status: "hit" | "miss-computed" | "miss-in-flight";
  durationMs?: number;
}

export function logSfCacheEvent(event: SfCacheDebugEvent): void {
  const statusLabel = event.status === "hit" ? "CACHE HIT" : event.status === "miss-in-flight" ? "IN-FLIGHT (deduplicated)" : "CACHE MISS (computing)";
  console.log(
    `[sf-debug] endpoint=${event.endpoint} caller=${event.caller} cacheKey=${event.cacheKey} status=${statusLabel}` +
    (event.durationMs != null ? ` durationMs=${event.durationMs}` : ""),
  );
}

/** Logged once from sfErrorResponse whenever a Salesforce call is rejected with REQUEST_LIMIT_EXCEEDED — never retried automatically (§4). */
export function logSfLimitExceeded(endpoint: string, salesforceMessage: string): void {
  console.warn(`[sf-debug] endpoint=${endpoint} SALESFORCE_API_LIMIT_EXCEEDED — "${salesforceMessage}" — automatic retry disabled.`);
}
