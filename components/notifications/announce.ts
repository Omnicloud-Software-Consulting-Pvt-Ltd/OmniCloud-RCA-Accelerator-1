import type { Notifier } from "./SalesforceSuccessContext";

/**
 * Pricing-procedure creators (attribute / bundle / volume / tier) finish with a three-state result.
 * Success is announced only when Salesforce confirmed the deploy; a deploy whose read-back is
 * incomplete is a warning; a pending user decision is not a notification at all.
 */
export function announcePricingProcedure(
  notifier: Notifier,
  result: { success: boolean; status?: string; error?: string; expressionSetId?: string },
  procedureName: string,
): void {
  const moduleName = "Pricing Procedures";
  const records = result.success && result.expressionSetId
    ? [{ objectApiName: "ExpressionSet", recordId: result.expressionSetId, recordName: procedureName, salesforceUrl: "" }]
    : [];
  if (result.success && result.status === "deployed_with_verification_warning") {
    notifier.warning("Pricing Procedure Created — Verify", `${procedureName} was deployed to Salesforce, but its read-back verification is incomplete.`, { module: moduleName, records });
  } else if (result.success) {
    notifier.success("Pricing Procedure Created Successfully", `${procedureName} has been successfully created in Salesforce.`, { module: moduleName, records });
  } else if (result.status !== "pending-adjustment-confirmation") {
    notifier.error("Pricing Procedure Not Created", result.error ?? `${procedureName} could not be created in Salesforce.`, { module: moduleName });
  }
}
