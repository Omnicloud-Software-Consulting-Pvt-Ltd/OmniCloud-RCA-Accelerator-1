/**
 * Client-safe: is a failed tax-calculation request a RECOVERABLE configuration / input problem (→ prepare the resolution plan and keep
 * the user on the page) or a genuinely fatal one (→ report it as is)?
 *  · recoverable: 400 / 404 / 409 / 422 — invalid or unknown input, a missing record, a stale state, a Salesforce validation rejection
 *  · fatal: 401 (session), 403 / permission codes (no retry, the administrator's step), 429 / 5xx (platform), and AI-configuration errors
 */
const FATAL_CODES = /^(TOKEN_EXPIRED|UNAUTHORIZED|SESSION_EXPIRED|NO_AI_KEY|AI_KEY_REJECTED|AI_ERROR|INSUFFICIENT_ACCESS\w*|FORBIDDEN|CANNOT_ASSIGN_PERMISSION_SETS|REQUEST_LIMIT_EXCEEDED)$/;
export function isRecoverableCalculationError(status: number, code: string | null | undefined): boolean {
  if (code && FATAL_CODES.test(code)) return false;
  return status === 400 || status === 404 || status === 409 || status === 422;
}

/** A calculation result the plan can act on: not ready, or failed before any invoice exists (configuration stopped it). */
export function resultNeedsPlan(r: { status: string; invoiceId?: string | null; run?: { invoice?: unknown } | null }): boolean {
  return r.status === "NOT_READY" || (r.status === "CALCULATION_FAILED" && !r.invoiceId && !r.run?.invoice);
}
