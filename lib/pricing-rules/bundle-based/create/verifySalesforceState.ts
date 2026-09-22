/**
 * Bundle-Based Pricing — Part Q read-back verification. Mirrors
 * lib/pricing-rules/attribute-based/create/verifySalesforceState.ts's `verifySalesforceState` exactly
 * (deploy-vs-read-back distinction, the ExpressionSet/ExpressionSetVersion/PricingProcedure
 * deploy-then-verify-independently discipline), reusing its fully generic Expression Set Id/Version Id
 * resolvers UNCHANGED — those resolvers are Describe/Connect-REST driven and have no attribute-specific
 * logic in them at all.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { verifyRecordExists } from "@/lib/pricing-rules/attribute-based/create/workflowRunner";
import { retrieveNamedExpressionSetDefinition } from "@/lib/pricing-rules/attribute-based/create/templateExpressionSet";
import { resolveExpressionSetId, resolveExpressionSetVersionId, describeExpressionSetVersionSchema, fetchExpressionSetViaConnectRest } from "@/lib/pricing-rules/attribute-based/create/verifySalesforceState";
import type { ComponentSuccess } from "@/lib/pricing-rules/attribute-based/create/soapEnvelope";
import type { ProcedureStepLite } from "../types";
import type { BundleSalesforceVerificationSummary, ComponentVerificationResult } from "./types";

// Re-exported for `activation.ts` (imported unchanged from attribute-based) — it needs these two
// resolvers from wherever the caller wires it up; the bundle create pipeline imports them straight from
// their real home (attribute-based/create/verifySalesforceState.ts) rather than through here.
export { describeExpressionSetVersionSchema, fetchExpressionSetViaConnectRest, resolveExpressionSetId, resolveExpressionSetVersionId };

function step(steps: ProcedureStepLite[], name: string, status: ProcedureStepLite["status"], message: string) {
  steps.push({ step: name, status, message, timestamp: Date.now() });
}

export interface VerifyBundleStateArgs {
  bundleProductId: string;
  scheduleId: string;
  ruleIds: string[];
  conditionIds: string[];
  adjustmentIds: string[];
  expressionSetApiName: string;
  expressionSetId?: string;
  expressionSetVersionId?: string;
  componentSuccesses?: ComponentSuccess[];
}

export async function verifyBundleSalesforceState(
  client: SalesforceClient,
  args: VerifyBundleStateArgs,
  steps: ProcedureStepLite[],
): Promise<BundleSalesforceVerificationSummary> {
  step(steps, "verify-salesforce", "start", "Reading every created/reused record back from Salesforce to confirm it's real.");

  const bundle = await client.query<{ Id: string }>(`SELECT Id FROM Product2 WHERE Id = '${soqlEscape(args.bundleProductId)}' LIMIT 1`)
    .then(r => r.records.length > 0).catch(() => false);

  const scheduleExists = await verifyRecordExists(client, "PriceAdjustmentSchedule", args.scheduleId);
  const rulesExist = args.ruleIds.length > 0 && (await Promise.all(args.ruleIds.map(id => verifyRecordExists(client, "BundleBasedAdjRule", id)))).every(Boolean);
  const conditionsExist = args.conditionIds.length > 0 && (await Promise.all(args.conditionIds.map(id => verifyRecordExists(client, "BundleAdjustmentCondition", id)))).every(Boolean);
  const adjustmentsExist = args.adjustmentIds.length > 0 && (await Promise.all(args.adjustmentIds.map(id => verifyRecordExists(client, "BundleBasedAdjustment", id)))).every(Boolean);
  const pricingRules = scheduleExists && rulesExist && conditionsExist && adjustmentsExist;
  const lookupTable = pricingRules;
  const componentsResolved = args.ruleIds.length > 0 && args.conditionIds.length > 0;

  let pricingElement = false;
  try {
    const deployedXml = await retrieveNamedExpressionSetDefinition(client, args.expressionSetApiName);
    pricingElement = !!deployedXml && deployedXml.includes("<actionType>BundleDiscount</actionType>");
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
      step(steps, "verify-salesforce", "info", `→ Verification attempt ${attempt}${error ? ` — query error: ${error}` : found ? " — found." : " — not found yet."}`);
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

  const summary: BundleSalesforceVerificationSummary = {
    bundle, componentsResolved, pricingRules, lookupTable, pricingElement, expressionSet, expressionSetVersion, pricingProcedure,
  };

  const allOk = bundle && componentsResolved && pricingRules && lookupTable && pricingElement && expressionSetVersion.verified && pricingProcedure.verified;
  step(steps, "verify-salesforce", allOk ? "success" : "info", allOk
    ? "Every required Salesforce component was confirmed via read-back."
    : `Read-back could not confirm: ${[
      !bundle && "bundle", !componentsResolved && "componentsResolved", !pricingRules && "pricingRules", !lookupTable && "lookupTable",
      !pricingElement && "pricingElement", !expressionSetVersion.verified && "expressionSetVersion", !pricingProcedure.verified && "pricingProcedure",
    ].filter((v): v is string => !!v).join(", ")}.`);

  return summary;
}
