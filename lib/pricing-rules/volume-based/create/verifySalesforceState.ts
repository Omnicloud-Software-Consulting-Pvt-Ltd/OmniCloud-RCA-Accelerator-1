/**
 * Volume-Based Pricing — read-back verification. Mirrors
 * lib/pricing-rules/bundle-based/create/verifySalesforceState.ts's `verifyBundleSalesforceState` exactly
 * (deploy-vs-read-back distinction), reusing the attribute-based module's fully generic Expression Set
 * Id/Version Id resolvers UNCHANGED — those resolvers are Describe/Connect-REST driven and have no
 * pricing-type-specific logic in them at all.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { verifyRecordExists } from "@/lib/pricing-rules/attribute-based/create/workflowRunner";
import { retrieveNamedExpressionSetDefinition } from "@/lib/pricing-rules/attribute-based/create/templateExpressionSet";
import { resolveExpressionSetId, resolveExpressionSetVersionId, describeExpressionSetVersionSchema, fetchExpressionSetViaConnectRest } from "@/lib/pricing-rules/attribute-based/create/verifySalesforceState";
import type { ComponentSuccess } from "@/lib/pricing-rules/attribute-based/create/soapEnvelope";
import type { ProcedureStepLite } from "../types";
import type { ComponentVerificationResult, VolumeSalesforceVerificationSummary } from "./types";

export { describeExpressionSetVersionSchema, fetchExpressionSetViaConnectRest, resolveExpressionSetId, resolveExpressionSetVersionId };

function step(steps: ProcedureStepLite[], name: string, status: ProcedureStepLite["status"], message: string) {
  steps.push({ step: name, status, message, timestamp: Date.now() });
}

export interface VerifyVolumeStateArgs {
  productId: string;
  scheduleId: string;
  tierIds: string[];
  expressionSetApiName: string;
  expressionSetId?: string;
  expressionSetVersionId?: string;
  componentSuccesses?: ComponentSuccess[];
}

export async function verifyVolumeSalesforceState(
  client: SalesforceClient,
  args: VerifyVolumeStateArgs,
  steps: ProcedureStepLite[],
): Promise<VolumeSalesforceVerificationSummary> {
  step(steps, "verify-salesforce", "start", "Reading every created record back from Salesforce to confirm it's real.");

  const product = await client.query<{ Id: string }>(`SELECT Id FROM Product2 WHERE Id = '${soqlEscape(args.productId)}' LIMIT 1`)
    .then(r => r.records.length > 0).catch(() => false);

  const scheduleVerified = await verifyRecordExists(client, "PriceAdjustmentSchedule", args.scheduleId);
  const tierResults = await Promise.all(args.tierIds.map(id => verifyRecordExists(client, "PriceAdjustmentTier", id)));
  const tierCount = tierResults.filter(Boolean).length;

  let pricingElement = false;
  try {
    const deployedXml = await retrieveNamedExpressionSetDefinition(client, args.expressionSetApiName);
    pricingElement = !!deployedXml && deployedXml.includes("<actionType>VolumeDiscount</actionType>");
  } catch {
    pricingElement = false;
  }

  step(steps, "verify-salesforce", "info", "→ Verifying Expression Set.");
  let expressionSet: ComponentVerificationResult;
  if (args.expressionSetId) {
    const found = await verifyRecordExists(client, "ExpressionSet", args.expressionSetId);
    expressionSet = { deployed: true, verified: found, verificationMethod: `Preserved Id from earlier deploy-stage resolution (${args.expressionSetId}) — confirmed via direct Id read-back.`, id: found ? args.expressionSetId : null };
  } else {
    const esResolution = await resolveExpressionSetId(client, { apiName: args.expressionSetApiName, componentSuccesses: args.componentSuccesses }, (attempt, found, error) => {
      step(steps, "verify-salesforce", "info", `→ Verification attempt ${attempt}${error ? ` — query error: ${error}` : found ? " — found." : " — not found yet."}`);
    });
    expressionSet = { deployed: true, verified: !!esResolution.id, verificationMethod: esResolution.method, id: esResolution.id, error: esResolution.error };
  }
  step(steps, "verify-salesforce", expressionSet.verified ? "success" : "error", expressionSet.verified ? "✓ Expression Set verified." : `✕ Expression Set could not be confirmed via read-back${expressionSet.error ? `: ${expressionSet.error}` : "."}`);

  step(steps, "verify-salesforce", "info", "→ Verifying Expression Set Version.");
  let expressionSetVersion: ComponentVerificationResult;
  if (args.expressionSetVersionId) {
    const found = await verifyRecordExists(client, "ExpressionSetVersion", args.expressionSetVersionId);
    expressionSetVersion = { deployed: true, verified: found, verificationMethod: `Preserved Id from earlier deploy-stage resolution (${args.expressionSetVersionId}) — confirmed via direct Id read-back.`, id: found ? args.expressionSetVersionId : null };
  } else {
    const evResolution = await resolveExpressionSetVersionId(client, { expressionSetId: args.expressionSetId ?? expressionSet.id ?? undefined, componentSuccesses: args.componentSuccesses }, (attempt, found, error) => {
      step(steps, "verify-salesforce", "info", `→ Verification attempt ${attempt}${error ? ` — query error: ${error}` : found ? " — version(s) found." : " — no versions yet."}`);
    });
    expressionSetVersion = { deployed: true, verified: !!evResolution.id, verificationMethod: evResolution.method, id: evResolution.id, error: evResolution.error };
  }
  step(steps, "verify-salesforce", expressionSetVersion.verified ? "success" : "error", expressionSetVersion.verified ? "✓ Expression Set Version verified." : `✕ Expression Set Version could not be confirmed via read-back${expressionSetVersion.error ? `: ${expressionSetVersion.error}` : "."}`);

  step(steps, "verify-salesforce", "info", "→ Verifying Pricing Procedure.");
  const pricingProcedure: ComponentVerificationResult = {
    deployed: true, verified: expressionSet.verified || expressionSetVersion.verified,
    verificationMethod: "Derived: Pricing Procedure IS the deployed ExpressionSet + ExpressionSetVersion — no separate Salesforce object exists for it in this org's schema.",
    id: expressionSetVersion.id ?? expressionSet.id,
  };
  step(steps, "verify-salesforce", pricingProcedure.verified ? "success" : "info", pricingProcedure.verified ? "✓ Pricing Procedure verified." : "⚠ Pricing Procedure could not be confirmed through direct read-back (deployment already succeeded — treated as a warning, not a failure).");

  const summary: VolumeSalesforceVerificationSummary = {
    product, scheduleVerified, tierCount, pricingElement, expressionSet, expressionSetVersion, pricingProcedure,
  };

  const allOk = product && scheduleVerified && tierCount === args.tierIds.length && pricingElement && expressionSetVersion.verified && pricingProcedure.verified;
  step(steps, "verify-salesforce", allOk ? "success" : "info", allOk
    ? "Every required Salesforce component was confirmed via read-back."
    : `Read-back could not confirm: ${[
      !product && "product", !scheduleVerified && "scheduleVerified", tierCount !== args.tierIds.length && "tierCount", !pricingElement && "pricingElement",
      !expressionSetVersion.verified && "expressionSetVersion", !pricingProcedure.verified && "pricingProcedure",
    ].filter((v): v is string => !!v).join(", ")}.`);

  return summary;
}
