/**
 * §1 — activates a deployed ExpressionSetVersion. Never fatal: an
 * activation failure leaves the version in Draft and is surfaced as a
 * warning, not a create-procedure failure — the metadata already deployed
 * successfully by the time this runs. Extracted out of create-procedure/
 * route.ts so /api/pricing-rules/ai/auto-create (which always activates,
 * unlike the manual flow's Draft/Active toggle) can call the identical
 * logic instead of re-implementing it.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import type { ProcedureStep } from "@/lib/pricing-rules/types";
import { buildFailureDiagnostics } from "@/lib/pricing-rules/salesforce/errorDiagnostics";

function step(steps: ProcedureStep[], name: string, status: ProcedureStep["status"], message: string, detail?: unknown) {
  steps.push({ step: name, status, message, detail, timestamp: Date.now() });
}

export async function maybeActivateVersion(
  client: SalesforceClient,
  versionId: string | undefined,
  requestedStatus: string | undefined,
  steps: ProcedureStep[],
  warnings: string[],
): Promise<"Draft" | "Active"> {
  if (requestedStatus !== "Active") return "Draft";
  if (!versionId) {
    warnings.push("Could not activate the Expression Set Version — its Id wasn't resolved after deploy. It remains in Draft status.");
    return "Draft";
  }
  step(steps, "activate-version", "start", `Activating ExpressionSetVersion ${versionId}.`);
  try {
    await client.updateRecord("ExpressionSetVersion", versionId, { Status: "Active" });
    step(steps, "activate-version", "success", "ExpressionSetVersion activated.");
    return "Active";
  } catch (err) {
    const failure = buildFailureDiagnostics("Activate Expression Set Version", err, "Salesforce REST sObject Update (ExpressionSetVersion)");
    step(steps, "activate-version", "error", failure.reason);
    warnings.push(`${failure.reason} — the procedure remains in Draft status and can still be activated manually in Setup.`);
    return "Draft";
  }
}
