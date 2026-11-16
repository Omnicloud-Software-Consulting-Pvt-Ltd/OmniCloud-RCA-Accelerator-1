/**
 * Bundle-Based Pricing — read-back verification. Mirrors
 * lib/pricing-rules/attribute-based/create/verifySalesforceState.ts's deploy-then-verify-independently
 * discipline, reusing its generic Expression Set Id/Version Id resolvers unchanged.
 *
 * Everything is verified against what Salesforce returns now, never against what this app sent: the
 * adjustment rows are re-queried by Id, and the procedure is re-RETRIEVED through the Metadata API so the
 * lookup-table and schedule bindings checked are the ones actually deployed.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { verifyRecordExists } from "@/lib/pricing-rules/attribute-based/create/workflowRunner";
import { retrieveNamedExpressionSetDefinition } from "@/lib/pricing-rules/attribute-based/create/templateExpressionSet";
import { resolveExpressionSetId, resolveExpressionSetVersionId, describeExpressionSetVersionSchema, fetchExpressionSetViaConnectRest } from "@/lib/pricing-rules/attribute-based/create/verifySalesforceState";
import { extractStepGraph, getTagValue, getNestedCustomElementParameterBlocks, getTopLevelParameterBlocks, getParamName, getParamValue, extractElementSpans } from "@/lib/pricing-rules/attribute-based/create/xmlBlocks";
import type { ComponentSuccess } from "@/lib/pricing-rules/attribute-based/create/soapEnvelope";
import type { ProcedureStepLite } from "../types";
import type { BundleSalesforceVerificationSummary, ComponentVerificationResult } from "./types";
import type { ResolvedBundleLookupTable } from "./lookupTableResolver";
import { bundleLog } from "./bundleLog";

// Re-exported for callers that wire activation up through this module.
export { describeExpressionSetVersionSchema, fetchExpressionSetViaConnectRest, resolveExpressionSetId, resolveExpressionSetVersionId };

function step(steps: ProcedureStepLite[], name: string, status: ProcedureStepLite["status"], message: string) {
  steps.push({ step: name, status, message, timestamp: Date.now() });
}

export interface VerifyBundleStateArgs {
  bundleProductId: string;
  componentProductIds: string[];
  scheduleId: string;
  adjustmentIds: string[];
  lookupTable: ResolvedBundleLookupTable;
  expressionSetApiName: string;
  expressionSetId?: string;
  expressionSetVersionId?: string;
  componentSuccesses?: ComponentSuccess[];
}

/** Reads the lookup reference and schedule constant off a deployed procedure's BundleDiscount step. Pure — exported for tests. */
export function inspectDeployedBundleBinding(xml: string): { lookUpId: string | null; lookUpApiName: string | null; scheduleConstantValue: string | null; bundleDiscountSteps: number } {
  const bdNodes = extractStepGraph(xml).filter(n => n.actionType === "BundleDiscount");
  const bd = bdNodes[0];
  if (!bd) return { lookUpId: null, lookUpApiName: null, scheduleConstantValue: null, bundleDiscountSteps: 0 };
  const blocks = [...getTopLevelParameterBlocks(bd.full), ...getNestedCustomElementParameterBlocks(bd.full)];
  const value = (n: string) => { const b = blocks.find(x => getParamName(x.block) === n); return b ? getParamValue(b.block) : null; };
  const scheduleVar = value("PriceAdjustmentScheduleId");
  const variable = scheduleVar
    ? extractElementSpans(xml, "variables").map(s => xml.slice(s.start, s.end)).find(v => getTagValue(v, "name") === scheduleVar)
    : undefined;
  return {
    lookUpId: value("LookUpId"), lookUpApiName: value("LookUpApiName"),
    scheduleConstantValue: variable ? getTagValue(variable, "value") : null,
    bundleDiscountSteps: bdNodes.length,
  };
}

/**
 * The deployed XML of ONE specific version: a retrieved Definition file accumulates every version ever
 * deployed, so reading "the first BundleDiscount in the file" could inspect an obsolete version.
 */
export async function retrieveDeployedVersionXml(client: SalesforceClient, apiName: string, versionApiName: string | null): Promise<string | null> {
  const xml = await retrieveNamedExpressionSetDefinition(client, apiName);
  if (!xml) return null;
  const blocks = xml.match(/<versions>[\s\S]*?<\/versions>/g) ?? [];
  if (blocks.length <= 1) return xml;
  const match = versionApiName ? blocks.find(b => getTagValue(b, "fullName") === versionApiName) : undefined;
  return match ?? null;
}

async function activeVersionOf(client: SalesforceClient, expressionSetId: string): Promise<{ id: string; apiName: string }[]> {
  return (await client.query<{ Id: string; ApiName: string }>(
    `SELECT Id, ApiName FROM ExpressionSetVersion WHERE ExpressionSetId = '${soqlEscape(expressionSetId)}' AND IsActive = true`,
  )).records.map(r => ({ id: r.Id, apiName: r.ApiName }));
}

export type ReusableProcedureCheck =
  | { reusable: true; expressionSetId: string; expressionSetVersionId: string; versionApiName: string; reason: string }
  | { reusable: false; exists: boolean; reason: string };

/**
 * Idempotency for the procedure itself. The pricing procedure only carries BINDINGS (lookup table +
 * schedule); every price lives in the lookup-table entries. So when this API name already has exactly one
 * ACTIVE version whose deployed BundleDiscount step executes the same table with the same schedule, a
 * re-run has nothing to deploy — new/updated entries are already live through the refreshed table.
 */
export async function findReusableBundleProcedure(
  client: SalesforceClient, apiName: string, table: ResolvedBundleLookupTable, scheduleId: string,
): Promise<ReusableProcedureCheck> {
  const es = (await client.query<{ Id: string }>(`SELECT Id FROM ExpressionSet WHERE ApiName = '${soqlEscape(apiName)}'`)).records[0];
  if (!es) return { reusable: false, exists: false, reason: `No pricing procedure named ${apiName} exists yet.` };
  const active = await activeVersionOf(client, es.Id);
  if (active.length !== 1) return { reusable: false, exists: true, reason: `${apiName} has ${active.length} active version(s) — a new version will be deployed and activated.` };
  const xml = await retrieveDeployedVersionXml(client, apiName, active[0].apiName);
  const deployed = xml ? inspectDeployedBundleBinding(xml) : null;
  const same = !!deployed && deployed.bundleDiscountSteps === 1
    && deployed.lookUpId?.slice(0, 15) === table.id.slice(0, 15) && deployed.lookUpApiName === table.developerName
    && deployed.scheduleConstantValue?.slice(0, 15) === scheduleId.slice(0, 15);
  if (!same) {
    return { reusable: false, exists: true, reason: `Active version ${active[0].apiName} is bound to lookup ${deployed?.lookUpApiName ?? "(none)"} / schedule ${deployed?.scheduleConstantValue ?? "(none)"} — a new version bound to ${table.developerName} / ${scheduleId} will be deployed.` };
  }
  return {
    reusable: true, expressionSetId: es.Id, expressionSetVersionId: active[0].id, versionApiName: active[0].apiName,
    reason: `Active version ${active[0].apiName} already executes ${table.developerName} with schedule ${scheduleId} — reused; no new version deployed.`,
  };
}

export async function verifyBundleSalesforceState(
  client: SalesforceClient,
  args: VerifyBundleStateArgs,
  steps: ProcedureStepLite[],
): Promise<BundleSalesforceVerificationSummary> {
  step(steps, "verify-salesforce", "start", "Reading every created/reused record back from Salesforce to confirm it's real.");

  const bundle = await client.query<{ Id: string }>(`SELECT Id FROM Product2 WHERE Id = '${soqlEscape(args.bundleProductId)}' LIMIT 1`)
    .then(r => r.records.length > 0).catch(() => false);

  let componentsResolved = false;
  try {
    const idList = args.componentProductIds.map(id => `'${soqlEscape(id)}'`).join(",");
    const rows = args.componentProductIds.length === 0 ? [] : (await client.query<{ ChildProductId: string }>(
      `SELECT ChildProductId FROM ProductRelatedComponent WHERE ParentProductId = '${soqlEscape(args.bundleProductId)}' AND ChildProductId IN (${idList})`,
    )).records;
    componentsResolved = args.componentProductIds.every(id => rows.some(r => r.ChildProductId === id));
  } catch {
    componentsResolved = false;
  }

  const scheduleExists = await verifyRecordExists(client, "PriceAdjustmentSchedule", args.scheduleId);
  let rowsOk = false;
  if (args.adjustmentIds.length > 0) {
    try {
      const idList = args.adjustmentIds.map(id => `'${soqlEscape(id)}'`).join(",");
      const rows = (await client.query<{ Id: string; PriceAdjustmentScheduleId: string; ParentProductId: string }>(
        `SELECT Id, PriceAdjustmentScheduleId, ParentProductId FROM BundleBasedAdjustment WHERE Id IN (${idList})`,
      )).records;
      rowsOk = rows.length === args.adjustmentIds.length
        && rows.every(r => r.PriceAdjustmentScheduleId === args.scheduleId && r.ParentProductId === args.bundleProductId);
    } catch {
      rowsOk = false;
    }
  }
  const pricingRules = scheduleExists && rowsOk;

  let tableActive = false;
  try {
    const t = (await client.query<{ Status: string }>(`SELECT Status FROM DecisionTable WHERE Id = '${soqlEscape(args.lookupTable.id)}'`)).records[0];
    tableActive = t?.Status === "Active";
  } catch { tableActive = false; }

  let deployed: BundleSalesforceVerificationSummary["deployed"];
  try {
    const versionApiName = args.expressionSetVersionId
      ? (await client.query<{ ApiName: string }>(`SELECT ApiName FROM ExpressionSetVersion WHERE Id = '${soqlEscape(args.expressionSetVersionId)}'`)).records[0]?.ApiName ?? null
      : null;
    const deployedXml = await retrieveDeployedVersionXml(client, args.expressionSetApiName, versionApiName);
    deployed = deployedXml ? inspectDeployedBundleBinding(deployedXml) : undefined;
  } catch {
    deployed = undefined;
  }
  const pricingElement = (deployed?.bundleDiscountSteps ?? 0) === 1;
  const lookupTable = tableActive && !!deployed
    && (deployed.lookUpId?.slice(0, 15) === args.lookupTable.id.slice(0, 15)) && deployed.lookUpApiName === args.lookupTable.developerName;
  const scheduleBinding = !!deployed && deployed.scheduleConstantValue?.slice(0, 15) === args.scheduleId.slice(0, 15);
  step(steps, "verify-salesforce", lookupTable ? "success" : "error", lookupTable
    ? `✓ Deployed BundleDiscount step executes lookup table ${args.lookupTable.developerName} (${args.lookupTable.id}).`
    : `✕ Deployed procedure is not bound to lookup table ${args.lookupTable.developerName}: found LookUpId=${deployed?.lookUpId ?? "(none)"}, LookUpApiName=${deployed?.lookUpApiName ?? "(none)"}, table Active=${tableActive}.`);
  step(steps, "verify-salesforce", scheduleBinding ? "success" : "error", scheduleBinding
    ? `✓ Deployed schedule constant = ${args.scheduleId}.`
    : `✕ Deployed schedule constant is ${deployed?.scheduleConstantValue ?? "(unreadable)"}, expected ${args.scheduleId}.`);

  step(steps, "verify-salesforce", "info", "→ Verifying Expression Set.");
  let expressionSet: ComponentVerificationResult;
  if (args.expressionSetId) {
    const found = await verifyRecordExists(client, "ExpressionSet", args.expressionSetId);
    expressionSet = { deployed: true, verified: found, verificationMethod: `Direct Id read-back of ${args.expressionSetId}.`, id: found ? args.expressionSetId : null };
  } else {
    const esResolution = await resolveExpressionSetId(client, { apiName: args.expressionSetApiName, componentSuccesses: args.componentSuccesses }, () => {});
    expressionSet = { deployed: true, verified: !!esResolution.id, verificationMethod: esResolution.method, id: esResolution.id, error: esResolution.error };
  }
  step(steps, "verify-salesforce", expressionSet.verified ? "success" : "error", expressionSet.verified ? "✓ Expression Set verified." : `✕ Expression Set could not be confirmed via read-back${expressionSet.error ? `: ${expressionSet.error}` : "."}`);

  step(steps, "verify-salesforce", "info", "→ Verifying Expression Set Version.");
  let expressionSetVersion: ComponentVerificationResult;
  if (args.expressionSetVersionId) {
    const found = await verifyRecordExists(client, "ExpressionSetVersion", args.expressionSetVersionId);
    expressionSetVersion = { deployed: true, verified: found, verificationMethod: `Direct Id read-back of ${args.expressionSetVersionId}.`, id: found ? args.expressionSetVersionId : null };
  } else {
    const evResolution = await resolveExpressionSetVersionId(client, { expressionSetId: args.expressionSetId ?? expressionSet.id ?? undefined, componentSuccesses: args.componentSuccesses }, () => {});
    expressionSetVersion = { deployed: true, verified: !!evResolution.id, verificationMethod: evResolution.method, id: evResolution.id, error: evResolution.error };
  }
  step(steps, "verify-salesforce", expressionSetVersion.verified ? "success" : "error", expressionSetVersion.verified ? "✓ Expression Set Version verified." : `✕ Expression Set Version could not be confirmed via read-back${expressionSetVersion.error ? `: ${expressionSetVersion.error}` : "."}`);

  // A Pricing Procedure IS an ExpressionSet with InterfaceSourceType = PricingProcedure — confirm that
  // classification directly rather than inferring it from the Expression Set's existence alone.
  let isPricingProcedure = false;
  if (expressionSet.id) {
    try {
      const es = (await client.query<{ InterfaceSourceType: string | null; UsageType: string | null }>(
        `SELECT InterfaceSourceType, UsageType FROM ExpressionSet WHERE Id = '${soqlEscape(expressionSet.id)}'`,
      )).records[0];
      isPricingProcedure = es?.InterfaceSourceType === "PricingProcedure";
    } catch { isPricingProcedure = false; }
  }
  const pricingProcedure: ComponentVerificationResult = {
    deployed: true, verified: isPricingProcedure && expressionSetVersion.verified,
    verificationMethod: "ExpressionSet.InterfaceSourceType = PricingProcedure, with a verified Expression Set Version.",
    id: expressionSet.id,
  };
  step(steps, "verify-salesforce", pricingProcedure.verified ? "success" : "info", pricingProcedure.verified ? "✓ Pricing Procedure verified (InterfaceSourceType = PricingProcedure)." : "⚠ Pricing Procedure classification could not be confirmed via read-back.");

  const summary: BundleSalesforceVerificationSummary = {
    bundle, componentsResolved, pricingRules, lookupTable, pricingElement, scheduleBinding, expressionSet, expressionSetVersion, pricingProcedure, deployed,
  };
  bundleLog(client, "verify-salesforce", {
    bundle, componentsResolved, pricingRules, lookupTable, pricingElement, scheduleBinding,
    expressionSetId: expressionSet.id, expressionSetVersionId: expressionSetVersion.id, pricingProcedure: pricingProcedure.verified, deployed,
  });
  return summary;
}
