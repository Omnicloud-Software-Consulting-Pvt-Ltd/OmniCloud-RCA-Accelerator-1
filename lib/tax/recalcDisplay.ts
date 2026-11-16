import type { RecalcResult } from "@/lib/tax/server/invoiceRecalc";

/**
 * How a recalculation result is shown (pure — no server imports, so the client bundles only this). Still processing is a warning,
 * never a red failure: Salesforce works asynchronously and the result simply isn't in yet.
 */
export type RecalcTone = "ok" | "warn" | "error";
export const STILL_PROCESSING_TEXT = "Salesforce is still processing this invoice; check again shortly.";

export function recalcNotice(r: RecalcResult): { tone: RecalcTone; text: string } {
  if (r.mode === "preview") return { tone: r.eligible ? "warn" : "error", text: r.reason };
  if (r.outcome === "VERIFIED_TAX_APPLIED" || r.outcome === "VERIFIED_ZERO_TAX") return { tone: "ok", text: r.message };
  if (r.outcome === "STILL_PENDING") {
    const status = r.verification.invoice?.status;
    return { tone: "warn", text: `${STILL_PROCESSING_TEXT}${status ? ` Current status: ${status}.` : ""} The recalculation was requested once and isn't repeated.` };
  }
  return { tone: "error", text: r.message };
}
