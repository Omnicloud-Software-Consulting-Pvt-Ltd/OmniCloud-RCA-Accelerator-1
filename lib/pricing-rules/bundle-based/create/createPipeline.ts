/**
 * Bundle-Based Pricing — the Salesforce-write pipeline, run strictly sequentially. Mirrors
 * lib/pricing-rules/attribute-based/create/createPipeline.ts's exact architecture:
 *   PRE-FLIGHT       — 100% read-only (schema + donor resolution); nothing is created/modified until this passes
 *   create-rule      — BundleBasedAdjRule (create/reuse per component)
 *   create-condition — BundleAdjustmentCondition
 *   create-adjustment — BundleBasedAdjustment (the real Schedule+Rule+Condition junction)
 *   verify-adjustment-records — read-back + runtime-lookup replica of every configuration just created
 *   refresh-bundle-discount-entries — non-blocking
 *   build-expression-set / validate-expression-set — clone+patch the donor Expression Set XML
 *   deploy-pricing-procedure — org-uniqueness pre-flight + Metadata API deploy
 *   activate-version
 *   verify-salesforce — read-back verification of every component
 *
 * Never deletes an existing Salesforce record. Never creates a duplicate — every create call reuses an
 * existing record by its deterministic identity wherever this org's schema makes that possible.
 */
import { createHash } from "node:crypto";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import {
  prepareBundleBasedAdjustmentSchema, resolveOrCreateBundlePriceAdjustmentSchedule,
  createOrReuseBundleBasedAdjRules, createBundleAdjustmentConditions, createBundleBasedAdjustments,
  verifyAdjustmentRecordsReadBack, resolveRuntimeBundleAdjustment,
  type NativeCreationResult,
} from "./nativeRecords";
import { buildBundleCanvas } from "./canvasBuilder";
import { deployExpressionSetDefinition } from "@/lib/pricing-rules/attribute-based/create/deploy";
import { validateExpressionSetUniquenessAgainstOrg, diagnosePostDeployFailure, resolveNextAvailableExpressionSetVersion, type OrgUniquenessResult } from "@/lib/pricing-rules/attribute-based/create/orgUniquenessValidation";
import { activateExpressionSetVersion } from "@/lib/pricing-rules/attribute-based/create/activation";
import { refreshListPriceDecisionTable } from "@/lib/pricing-rules/attribute-based/create/decisionTableRefresh";
import { refreshBundleDiscountEntries } from "./decisionTableRefresh";
import { resolveExpressionSetId, resolveExpressionSetVersionId, verifyBundleSalesforceState } from "./verifySalesforceState";
import { resolveBundleBasedPricingDonor, buildNoCoherentDonorDiagnostic, inspectAllExpressionSetDefinitionDonors } from "./donorInspection";
import { buildFailureDiagnostics, buildLogicalFailure } from "./errorDiagnostics";
import { buildSanitizedAuditLog } from "@/lib/salesforce/auditLog";
import type { DiscoveredBundle, BundleComponentPlanRow, ProcedureStepLite } from "../types";
import type {
  CreateBundlePricingResult, BundleGeneratedProcedureSnapshot, BundleSalesforceVerificationSummary,
  BundlePricingLifecycleStatus, ExpressionSetVersionResolutionAudit, BundlePricingActivationAudit,
} from "./types";

function step(steps: ProcedureStepLite[], name: string, status: ProcedureStepLite["status"], message: string) {
  steps.push({ step: name, status, message, timestamp: Date.now() });
}

async function resolveSellingModelId(client: SalesforceClient, productId: string): Promise<string | null> {
  try {
    const res = await client.query<{ ProductSellingModelId: string }>(
      `SELECT ProductSellingModelId FROM ProductSellingModelOption WHERE Product2Id = '${soqlEscape(productId)}' LIMIT 1`,
    );
    return res.records[0]?.ProductSellingModelId ?? null;
  } catch {
    return null;
  }
}

function deriveApiName(procedureName: string): string {
  const sanitized = procedureName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const withLeadingLetter = /^[a-zA-Z]/.test(sanitized) ? sanitized : `Proc_${sanitized}`;
  return withLeadingLetter.slice(0, 40) || "Bundle_Based_Pricing_Procedure";
}

export function generateExecutionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(16).slice(2, 6).toUpperCase().padEnd(4, "0");
  return `BBP-${datePart}-${timePart}-${suffix}`;
}

function buildProcedureSnapshot(input: {
  executionId: string;
  bundle: { id: string; name: string };
  rules: BundleComponentPlanRow[];
  priceAdjustmentScheduleId?: string;
  ruleIds?: string[];
  conditionIds?: string[];
  adjustmentIds?: string[];
  expressionSetId?: string;
  expressionSetVersionId?: string;
  expressionSetApiName?: string;
  verification?: BundleSalesforceVerificationSummary;
}): BundleGeneratedProcedureSnapshot {
  return {
    executionId: input.executionId,
    pricingType: "bundle-based",
    bundle: { name: input.bundle.name, id: input.bundle.id },
    components: input.rules.map(r => ({ name: r.componentName, adjustmentType: r.adjustmentType, adjustmentValue: r.adjustment })),
    salesforce: {
      priceAdjustmentScheduleId: input.priceAdjustmentScheduleId ?? null,
      bundleBasedAdjRuleIds: input.ruleIds ?? [],
      bundleAdjustmentConditionIds: input.conditionIds ?? [],
      bundleBasedAdjustmentIds: input.adjustmentIds ?? [],
      expressionSetId: input.expressionSetId ?? null,
      expressionSetVersionId: input.expressionSetVersionId ?? null,
      pricingProcedureApiName: input.expressionSetApiName ?? null,
    },
    verificationStatus: input.verification ? deriveVerificationStatus(input.verification) : "pending",
  };
}

function deriveVerificationStatus(v: BundleSalesforceVerificationSummary): "verified" | "verified_with_warning" | "failed" {
  const coreOk = v.bundle && v.componentsResolved && v.pricingRules && v.lookupTable && v.pricingElement;
  const esLayerDeployed = [v.expressionSet, v.expressionSetVersion, v.pricingProcedure].every(c => c.deployed);
  const esLayerVerified = v.expressionSetVersion.verified && v.pricingProcedure.verified;
  if (coreOk && esLayerVerified) return "verified";
  if (coreOk && esLayerDeployed) return "verified_with_warning";
  return "failed";
}

export interface CreateBundlePipelineInput {
  client: SalesforceClient;
  bundle: DiscoveredBundle;
  rules: BundleComponentPlanRow[];
  ignoredComponents: string[];
  procedureName: string;
  description?: string;
  activate: boolean;
}

export async function runCreateBundlePricingPipeline(
  input: CreateBundlePipelineInput,
  onStep?: (event: { step: string; status: "running" | "done" | "failed" | "warning"; detail?: string }) => void,
): Promise<CreateBundlePricingResult> {
  const { client } = input;
  const steps: ProcedureStepLite[] = [];
  const warnings: string[] = [];

  const executionId = generateExecutionId();
  client.logDebug("execution-trace", `Execution ID: ${executionId} — Bundle-Based Pricing creation started for bundle "${input.bundle.name}" (${input.bundle.id}).`);

  const emit = (name: string, status: "running" | "done" | "failed" | "warning", detail?: string) => onStep?.({ step: name, status, detail });

  function fail(result: Partial<CreateBundlePricingResult> & { failure: CreateBundlePricingResult["failure"] }): CreateBundlePricingResult {
    emit(result.failure!.step, "failed", result.failure!.reason);
    const procedureSnapshot = buildProcedureSnapshot({
      executionId, bundle: { id: input.bundle.id, name: input.bundle.name }, rules: input.rules,
      priceAdjustmentScheduleId: result.priceAdjustmentScheduleId, ruleIds: result.ruleIds, conditionIds: result.conditionIds,
      adjustmentIds: result.adjustmentIds, expressionSetId: result.expressionSetId, expressionSetVersionId: result.expressionSetVersionId,
      expressionSetApiName: result.expressionSetApiName, verification: result.verification,
    });
    return {
      success: false, status: "failed", error: `[${executionId}] ${result.failure!.reason}`, warnings, steps,
      executionId, auditLog: buildSanitizedAuditLog(client.debugLog), procedureSnapshot,
      ...result,
    };
  }

  if (input.rules.length === 0) {
    return fail({ failure: buildLogicalFailure("create-rule", "No component pricing rules to create — nothing was approved for creation.") });
  }

  const sellingModelId = await resolveSellingModelId(client, input.bundle.id);
  if (!sellingModelId) warnings.push("No Selling Model was found for this bundle product — some orgs require one for bundle-based adjustments; proceeding without it.");

  /* ── PRE-FLIGHT — 100% read-only. If ANY check here fails, nothing was created/modified. ── */
  emit("preflight", "running");
  step(steps, "preflight", "start", "Running pre-flight validation — no Salesforce record will be created or modified until every check below passes.");

  let schema;
  try {
    step(steps, "preflight", "info", "→ Resolving Bundle-Based Pricing schema relationships.");
    schema = await prepareBundleBasedAdjustmentSchema(client);
    step(steps, "preflight", "success", "✓ Bundle-Based Pricing relationship graph resolved.");
  } catch (err) {
    const failure = buildFailureDiagnostics("preflight", err);
    step(steps, "preflight", "error", failure.reason);
    emit("preflight", "failed", failure.reason);
    return fail({ failure });
  }

  step(steps, "preflight", "info", "→ Resolving Bundle-Based Pricing Expression Set donor.");
  let preflightDonorResolution: Awaited<ReturnType<typeof resolveBundleBasedPricingDonor>>;
  try {
    preflightDonorResolution = await resolveBundleBasedPricingDonor(client);
  } catch (err) {
    const failure = buildFailureDiagnostics("preflight", err);
    step(steps, "preflight", "error", failure.reason);
    emit("preflight", "failed", failure.reason);
    return fail({ failure });
  }
  if (!preflightDonorResolution.selection) {
    const noDonorDiagnostic = buildNoCoherentDonorDiagnostic(preflightDonorResolution.candidatesWithBundleDiscount);
    const lowConfidenceNote = preflightDonorResolution.lowConfidenceCandidates
      ? "\n\nNote: some candidates DID prove a BundleDiscount->ListPrice connection but scored below the trust floor:\n"
        + preflightDonorResolution.lowConfidenceCandidates.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n")
      : "";
    const failure = buildLogicalFailure(
      "preflight",
      "No ExpressionSetDefinition in this org has PricingSettings, ListPrice, AND a BundleDiscount branch proven connected to that SAME ListPrice with sufficient confidence. " +
      "BundleDiscount cannot be authored from a blank canvas. Stopping BEFORE creating any Rule, Condition, or Adjustment.\n\n" + noDonorDiagnostic + lowConfidenceNote,
    );
    step(steps, "preflight", "error", failure.reason);
    emit("preflight", "failed", failure.reason);
    return fail({ failure });
  }
  step(steps, "preflight", "success", `✓ Expression Set donor validated: ${preflightDonorResolution.selection.fullName} (BundleDiscount → ListPrice connection proven).`);
  step(steps, "preflight", "success", "PRE-FLIGHT PASSED — no Salesforce record has been created or modified yet.");
  emit("preflight", "done", "Pre-flight validation passed.");

  /* ── create-schedule ── */
  emit("create-schedule", "running");
  let scheduleId: string;
  try {
    scheduleId = await resolveOrCreateBundlePriceAdjustmentSchedule(
      client, { bundle: { id: input.bundle.id, name: input.bundle.name }, sellingModelId, procedureName: input.procedureName }, steps,
      message => emit("create-schedule", "running", message),
    );
    emit("create-schedule", "done", `Schedule ${scheduleId}.`);
  } catch (err) {
    const failure = buildFailureDiagnostics("create-schedule", err);
    step(steps, "create-schedule", "error", failure.reason);
    return fail({ failure });
  }

  /* ── create-rule ── */
  emit("create-rule", "running");
  let rulePlans;
  try {
    const result = await createOrReuseBundleBasedAdjRules(
      client, schema, { bundle: { id: input.bundle.id, name: input.bundle.name }, sellingModelId, components: input.rules }, scheduleId, steps,
      message => emit("create-rule", "running", message),
    );
    rulePlans = result.plans;
    emit("create-rule", "done", `${result.ruleIds.length} rule(s).`);
  } catch (err) {
    const failure = buildFailureDiagnostics("create-rule", err);
    step(steps, "create-rule", "error", failure.reason);
    return fail({ failure, priceAdjustmentScheduleId: scheduleId });
  }

  /* ── create-condition ── */
  emit("create-condition", "running");
  try {
    const result = await createBundleAdjustmentConditions(client, schema, { bundle: { id: input.bundle.id, name: input.bundle.name } }, rulePlans, steps,
      message => emit("create-condition", "running", message));
    emit("create-condition", "done", `${result.conditionIds.length} condition(s) created, ${result.reusedConditionIds.length} reused.`);
  } catch (err) {
    const failure = buildFailureDiagnostics("create-condition", err);
    step(steps, "create-condition", "error", failure.reason);
    return fail({ failure, priceAdjustmentScheduleId: scheduleId, ruleIds: rulePlans.map(p => p.ruleId), conditionIds: rulePlans.flatMap(p => p.conditionIds) });
  }

  /* ── create-adjustment ── */
  emit("create-adjustment", "running");
  let adjustmentIds: string[], reusedAdjustmentIds: string[], adjustmentDecisions;
  try {
    const result = await createBundleBasedAdjustments(
      client, schema, { bundle: { id: input.bundle.id, name: input.bundle.name }, sellingModelId }, scheduleId, rulePlans, steps,
      message => emit("create-adjustment", "running", message),
    );
    adjustmentIds = result.adjustmentIds;
    reusedAdjustmentIds = result.reusedAdjustmentIds;
    adjustmentDecisions = result.decisions;
    emit("create-adjustment", "done", `${adjustmentIds.length} created, ${reusedAdjustmentIds.length} reused.`);
  } catch (err) {
    const failure = buildFailureDiagnostics("create-adjustment", err);
    step(steps, "create-adjustment", "error", failure.reason);
    return fail({ failure, priceAdjustmentScheduleId: scheduleId, ruleIds: rulePlans.map(p => p.ruleId), conditionIds: rulePlans.flatMap(p => p.conditionIds) });
  }

  const native: NativeCreationResult = {
    scheduleId, ruleIds: rulePlans.map(p => p.ruleId), conditionIds: rulePlans.flatMap(p => p.conditionIds),
    adjustmentIds: [...adjustmentIds, ...reusedAdjustmentIds],
  };

  /* ── verify-adjustment-records — read-back + runtime lookup replica ── */
  emit("verify-adjustment-records", "running");
  const adjustmentVerification = await verifyAdjustmentRecordsReadBack(client, native);
  const runtimeTraces = await Promise.all(rulePlans.map(async plan => ({
    plan,
    trace: await resolveRuntimeBundleAdjustment(client, schema, {
      bundleProductId: input.bundle.id, sellingModelId, scheduleId, componentProductId: plan.row.componentProductId, componentName: plan.row.componentName,
    }),
  })));
  for (const { plan, trace } of runtimeTraces) {
    step(steps, "verify-adjustment-records", trace.resolved ? "success" : "error",
      trace.resolved
        ? `✓ Runtime lookup: ${plan.row.componentName} → resolves to Adjustment ${trace.adjustmentId} (${trace.adjustmentType ?? "type unknown"} ${String(trace.adjustmentValue ?? "")}).`
        : `✕ Runtime lookup: ${plan.row.componentName} — ${trace.reason}`);
  }
  const runtimeVerifiedCount = runtimeTraces.filter(({ trace }) => trace.resolved).length;
  const runtimeVerified = runtimeTraces.length > 0 && runtimeVerifiedCount === runtimeTraces.length;
  const adjustmentVerified = adjustmentVerification.scheduleVerified
    && adjustmentVerification.ruleCount === native.ruleIds.length
    && adjustmentVerification.conditionCount === native.conditionIds.length
    && runtimeVerified;
  if (!adjustmentVerified) {
    const failure = buildLogicalFailure(
      "verify-adjustment-records",
      `Salesforce read-back could not confirm every Bundle-Based Pricing configuration: schedule verified=${adjustmentVerification.scheduleVerified}, ` +
      `rules ${adjustmentVerification.ruleCount}/${native.ruleIds.length}, conditions ${adjustmentVerification.conditionCount}/${native.conditionIds.length}, ` +
      `runtime lookups ${runtimeVerifiedCount}/${runtimeTraces.length} resolved. ` +
      `Failed: ${runtimeTraces.filter(({ trace }) => !trace.resolved).map(({ plan, trace }) => `${plan.row.componentName} (${trace.reason})`).join("; ") || "none"}.`,
    );
    step(steps, "verify-adjustment-records", "error", failure.reason);
    return fail({ failure, priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds, adjustmentDecisions });
  }
  step(steps, "verify-adjustment-records", "success", "All Bundle-Based Pricing records and configurations confirmed via Salesforce read-back.");
  emit("verify-adjustment-records", "done", `Schedule + ${native.ruleIds.length} rule(s) + ${native.conditionIds.length} condition(s) + ${runtimeVerifiedCount}/${runtimeTraces.length} runtime lookup(s) verified.`);

  /* ── refresh-bundle-discount-entries — non-blocking ── */
  emit("refresh-bundle-discount-entries", "running");
  const discountEntries = await refreshBundleDiscountEntries(client);
  if (discountEntries.warning) warnings.push(discountEntries.warning);
  step(steps, "refresh-bundle-discount-entries", discountEntries.refreshed ? "success" : "info", discountEntries.refreshed ? `Refreshed "${discountEntries.masterLabel ?? discountEntries.developerName}".` : (discountEntries.warning ?? "Not refreshed."));
  emit("refresh-bundle-discount-entries", discountEntries.refreshed ? "done" : "warning", discountEntries.refreshed ? `Refreshed "${discountEntries.masterLabel ?? discountEntries.developerName}".` : discountEntries.warning);

  const apiName = deriveApiName(input.procedureName);

  /* ── Resolve the next available Expression Set Version BEFORE canvas build (Section 3/6) ── */
  step(steps, "build-expression-set", "info", "→ Resolving existing Expression Set versions.");
  let nextVersionResolution: Awaited<ReturnType<typeof resolveNextAvailableExpressionSetVersion>> | null = null;
  try {
    nextVersionResolution = await resolveNextAvailableExpressionSetVersion(client, apiName);
    step(steps, "build-expression-set", "success", `✓ Final candidate identity: ${nextVersionResolution.identity} (Version ${nextVersionResolution.versionNumber}${nextVersionResolution.rankFieldExists ? `, Rank ${nextVersionResolution.rank ?? "(none)"}` : ""}).`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`Could not resolve an unused Expression Set version identity: ${message} — proceeding without a version override.`);
    step(steps, "build-expression-set", "info", `ℹ Version lifecycle resolution failed (${message}) — proceeding without a version override.`);
  }

  /* ── Diagnostic-only donor inventory — never affects the real build ── */
  let expressionSetDonorInspection: Awaited<ReturnType<typeof inspectAllExpressionSetDefinitionDonors>> | undefined;
  try {
    expressionSetDonorInspection = await inspectAllExpressionSetDefinitionDonors(client, "BundleDiscount");
  } catch (err) {
    warnings.push(`Donor inventory (diagnostic-only) failed: ${err instanceof Error ? err.message : String(err)} — this does not affect the actual build.`);
  }

  /* ── build-expression-set / validate-expression-set ── */
  emit("build-expression-set", "running");
  let canvas;
  try {
    canvas = await buildBundleCanvas(client, {
      procedureName: input.procedureName, apiName, description: input.description,
      versionNumber: nextVersionResolution?.versionNumber, rank: nextVersionResolution?.rank,
      onProgress: phase => {
        if (phase === "template-retrieved") emit("build-expression-set", "running", "Template retrieved — building canvas.");
      },
    });
  } catch (err) {
    const failure = buildFailureDiagnostics("build-expression-set", err);
    step(steps, "build-expression-set", "error", failure.reason);
    return fail({ failure, priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds, expressionSetDonorInspection });
  }

  const expressionSetValidation: Record<string, { status: "PASS" | "FAIL"; missing: string[]; unexpected: string[]; orderMatch: boolean }> = {};
  for (const report of canvas.stepStructureReports ?? []) {
    expressionSetValidation[report.actionType] = { status: report.structurallyValid ? "PASS" : "FAIL", missing: report.missingNodes, unexpected: report.extraNodes, orderMatch: report.orderMatches };
  }

  if (!canvas.success || !canvas.finalFileXml) {
    const reason = canvas.fatalErrors.join(" ") || "Expression Set canvas build failed for an unspecified reason.";
    const failure = buildLogicalFailure("validate-expression-set", reason, undefined, { schemaReport: canvas.schemaReport?.reportText });
    step(steps, "build-expression-set", "error", "✕ Expression Set composition/validation failed.");
    warnings.push(...canvas.warnings);
    return fail({
      failure, warnings, priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds,
      expressionSetValidation, bundleDiscountInputBinding: canvas.bundleDiscountInputBinding,
      bundleDiscountBranchSelection: canvas.bundleDiscountBranchSelection, expressionSetDonorInspection,
    });
  }
  warnings.push(...canvas.warnings);
  step(steps, "build-expression-set", "success", `✓ Selected donor: ${canvas.canvasComposition?.donorFullName} (${canvas.canvasComposition?.donorPhysicalStepCount} physical step(s) originally; ${canvas.canvasComposition?.prunedRootBranchCount} unrelated root branch(es) pruned away).`);
  step(steps, "build-expression-set", "success", "✓ PricingSettings, ListPrice, BundleDiscount composed and structurally validated.");
  step(steps, "validate-expression-set", "success", "Structural validation passed against the composed final canvas.");
  const deployPayloadFingerprint = createHash("sha256").update(canvas.finalFileXml).digest("hex");
  emit("build-expression-set", "done");
  emit("validate-expression-set", "done");

  /* ── Org-uniqueness pre-flight ── */
  const generatedFullNames = (canvas.generatedIdentifiers ?? []).filter(g => g.tag === "fullName").map(g => g.value);
  const generatedLabel = (canvas.generatedIdentifiers ?? []).find(g => g.tag === "label")?.value ?? null;
  let uniqueness: OrgUniquenessResult | null = null;
  try {
    uniqueness = await validateExpressionSetUniquenessAgainstOrg(client, { apiName, generatedFullNames, generatedLabel });
    step(steps, "deploy-pricing-procedure", "info", `→ Expression Set Version lifecycle decision: ${uniqueness.decision}.`);
  } catch (err) {
    warnings.push(`Org-wide uniqueness pre-flight could not complete: ${err instanceof Error ? err.message : String(err)} — proceeding to deploy anyway.`);
  }
  if (uniqueness && !uniqueness.ok) {
    const failure = buildLogicalFailure("deploy-pricing-procedure", `This Expression Set/Version identity conflicts with an existing record in the org: ${uniqueness.conflicts.map(c => `${c.identifier} (${c.conflictingMetadataType} ${c.existingRecordId})`).join("; ")}.`);
    step(steps, "deploy-pricing-procedure", "error", failure.reason);
    return fail({ failure, warnings, priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds, expressionSetDonorInspection });
  }

  /* ── Payload fingerprint + outbound-field verification (never deploy XML that wasn't validated) ── */
  const targetIdentity = generatedFullNames[0] ?? apiName;
  const resolvedCandidate = { fullName: targetIdentity, versionNumber: nextVersionResolution?.versionNumber ?? null, expressionSetDefinition: apiName, rank: nextVersionResolution?.rank ?? null };
  const fieldMismatches: string[] = [];
  if (canvas.outboundVersionFields?.fullName !== resolvedCandidate.fullName) fieldMismatches.push(`fullName (resolved="${resolvedCandidate.fullName}", outbound="${canvas.outboundVersionFields?.fullName ?? "(not found)"}")`);
  if (resolvedCandidate.versionNumber !== null && canvas.outboundVersionFields?.versionNumber !== String(resolvedCandidate.versionNumber)) fieldMismatches.push(`versionNumber (resolved="${resolvedCandidate.versionNumber}", outbound="${canvas.outboundVersionFields?.versionNumber ?? "(not found)"}")`);
  if (canvas.outboundVersionFields?.expressionSetDefinition !== resolvedCandidate.expressionSetDefinition) fieldMismatches.push(`expressionSetDefinition (resolved="${resolvedCandidate.expressionSetDefinition}", outbound="${canvas.outboundVersionFields?.expressionSetDefinition ?? "(not found)"}")`);
  if (resolvedCandidate.rank !== null && canvas.outboundVersionFields?.rank !== String(resolvedCandidate.rank)) fieldMismatches.push(`rank (resolved="${resolvedCandidate.rank}", outbound="${canvas.outboundVersionFields?.rank ?? "(not found)"}")`);
  if (fieldMismatches.length > 0) {
    const failure = buildLogicalFailure("deploy-pricing-procedure", `Refusing to deploy — payload verification FAILED before the Metadata API was ever called. Mismatched field(s): ${fieldMismatches.join(", ")}.`);
    step(steps, "deploy-pricing-procedure", "error", failure.reason);
    return fail({ failure, warnings, priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds, deployPayloadFingerprint, expressionSetDonorInspection });
  }
  const deployPayloadFingerprintAtDeploy = createHash("sha256").update(canvas.finalFileXml).digest("hex");
  if (deployPayloadFingerprintAtDeploy !== deployPayloadFingerprint) {
    const failure = buildLogicalFailure("deploy-pricing-procedure", `Refusing to deploy — the XML about to be sent (sha256 ${deployPayloadFingerprintAtDeploy}) does not match the XML that was validated (sha256 ${deployPayloadFingerprint}).`);
    step(steps, "deploy-pricing-procedure", "error", failure.reason);
    return fail({ failure, warnings, priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds, deployPayloadFingerprint, expressionSetDonorInspection });
  }
  step(steps, "deploy-pricing-procedure", "success", "✓ Payload verification passed.");

  /* ── deploy-pricing-procedure ── */
  emit("deploy-pricing-procedure", "running");
  const deployResult = await deployExpressionSetDefinition(client, apiName, canvas.finalFileXml, canvas.donorFileName, "BundleDiscount");
  if (!deployResult.success) {
    let reason = deployResult.error ?? "Metadata deploy failed.";
    const diagnosis = diagnosePostDeployFailure(reason, uniqueness);
    if (diagnosis.isUniquenessConflict) reason = diagnosis.diagnosis;
    const failure = buildLogicalFailure("deploy-pricing-procedure", reason, undefined, {
      packagingReport: deployResult.packagingReport.reportText,
      deployComponentFailures: deployResult.status?.componentFailures, deployFullStatus: deployResult.status,
      generatedFileXml: deployResult.generatedFileXml, deployZipBase64: deployResult.deployZipBase64, rawDeployStatusXml: deployResult.rawDeployStatusXml,
    });
    step(steps, "deploy-pricing-procedure", "error", `✕ ${reason}`);
    return fail({ failure, warnings, priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds, deployPayloadFingerprint, expressionSetDonorInspection });
  }
  step(steps, "deploy-pricing-procedure", "success", `✓ Deployed ${deployResult.status?.numberComponentsDeployed ?? 0} component(s), ${deployResult.status?.numberComponentErrors ?? 0} error(s).`);
  const deploymentSummary = {
    success: deployResult.status?.success ?? deployResult.success,
    deploymentId: deployResult.status?.id ?? null,
    componentsDeployed: deployResult.status?.numberComponentsDeployed ?? 0,
    errors: deployResult.status?.numberComponentErrors ?? 0,
  };
  emit("deploy-pricing-procedure", "done");

  const componentSuccesses = deployResult.status?.componentSuccesses;

  /* ── Resolve the real ExpressionSet / ExpressionSetVersion Ids ── */
  step(steps, "deploy-pricing-procedure", "info", `→ Resolving actual ExpressionSet Salesforce record (fullName=${apiName}).`);
  const esResolution = await resolveExpressionSetId(client, { apiName, componentSuccesses }, (attempt, found, error) => {
    step(steps, "deploy-pricing-procedure", "info", `→ Resolving ExpressionSet Id — attempt ${attempt}${error ? ` (query error: ${error})` : found ? " — found." : " — not found yet."}`);
  });
  const expressionSetId = esResolution.verified ? (esResolution.id ?? undefined) : undefined;
  step(steps, "deploy-pricing-procedure", expressionSetId ? "success" : "error", expressionSetId ? `✓ ExpressionSet resolved: ${expressionSetId}.` : `✕ ExpressionSet could not be resolved: ${esResolution.method}.`);

  const esvResolution = await resolveExpressionSetVersionId(client, { expressionSetId, componentSuccesses }, (attempt, found, error) => {
    step(steps, "deploy-pricing-procedure", "info", `→ Resolving ExpressionSetVersion (Connect REST) — attempt ${attempt}${error ? ` (error: ${error})` : found ? " — version(s) found." : " — no versions yet."}`);
  });
  const expressionSetVersionId = esvResolution.verified ? (esvResolution.id ?? undefined) : undefined;
  step(steps, "deploy-pricing-procedure", expressionSetVersionId ? "success" : "error", expressionSetVersionId ? `✓ ExpressionSetVersion resolved: ${expressionSetVersionId}.` : `✕ ExpressionSetVersion could not be resolved: ${esvResolution.method}.`);
  if (!expressionSetVersionId) warnings.push("Expression Set deployed successfully, but its Expression Set Version could not be resolved/confirmed through Connect REST — activation could not proceed.");

  const esvSelectedBy: ExpressionSetVersionResolutionAudit["selectedBy"] = esvResolution.matchPriority === "A" ? "deployment-id"
    : esvResolution.matchPriority === "B" ? "full-name"
    : esvResolution.matchPriority === "C" ? (esvResolution.candidates?.length === 1 ? "sole-version" : "version-number") : null;
  const expressionSetVersionResolution: ExpressionSetVersionResolutionAudit = {
    strategy: esvResolution.strategy.startsWith("connect-rest") ? "connect-rest" : "fallback",
    metadataDeploymentComponentId: esResolution.metadataDeploymentComponentId ?? null,
    expressionSetId: expressionSetId ?? null, expressionSetVersionId: expressionSetVersionId ?? null,
    verified: esvResolution.verified, selectedBy: esvSelectedBy,
    request: { method: "GET", path: esvResolution.connectRequestPath ?? "" },
    response: esvResolution.connectResponse ?? null, method: esvResolution.method,
    selectedVersion: esvResolution.selectedVersion ?? null, candidates: esvResolution.candidates ?? [], error: esvResolution.error,
  };

  if (canvas.lpLookup?.lookUpId) {
    const refresh = await refreshListPriceDecisionTable(client, canvas.lpLookup.lookUpId, canvas.lpLookup.lookUpApiName);
    if (refresh.warning) warnings.push(refresh.warning);
  }

  /* ── activate-version ── */
  let versionStatus: "Draft" | "Active" = "Draft";
  let activationDetail: Awaited<ReturnType<typeof activateExpressionSetVersion>>["detail"] | undefined;
  if (input.activate) {
    emit("activate-version", "running");
    const activation = await activateExpressionSetVersion(client, expressionSetVersionId, steps, warnings, expressionSetId);
    versionStatus = activation.status;
    activationDetail = activation.detail;
    emit("activate-version", versionStatus === "Active" ? "done" : "warning");
  }
  const activationAudit: BundlePricingActivationAudit = {
    attempted: !!input.activate, versionId: expressionSetVersionId ?? null, success: versionStatus === "Active",
    status: input.activate ? versionStatus : null, detail: activationDetail,
  };

  /* ── verify-salesforce ── */
  emit("verify-salesforce", "running");
  const verification = await verifyBundleSalesforceState(client, {
    bundleProductId: input.bundle.id, scheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds,
    adjustmentIds: native.adjustmentIds, expressionSetApiName: apiName, expressionSetId, expressionSetVersionId, componentSuccesses,
  }, steps);
  const verificationStatus = deriveVerificationStatus(verification);
  emit("verify-salesforce", verificationStatus === "verified" ? "done" : "warning");

  const lifecycleStatus: BundlePricingLifecycleStatus = {
    expressionSetDeployment: deploymentSummary.success ? "success" : "failed",
    expressionSetVersionDeployment: deploymentSummary.success ? "success" : "failed",
    expressionSetVersionResolution: expressionSetVersionId ? "success" : (expressionSetId ? "failed" : "skipped"),
    activation: !input.activate ? "not_requested" : (versionStatus === "Active" ? "success" : (expressionSetVersionId ? "failed" : "skipped")),
    pricingProcedure: verification.pricingProcedure.verified ? "verified" : (verification.pricingProcedure.deployed ? "deployed" : "not_verified"),
  };

  const finalSnapshot = buildProcedureSnapshot({
    executionId, bundle: { id: input.bundle.id, name: input.bundle.name }, rules: input.rules,
    priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds,
    expressionSetId, expressionSetVersionId, expressionSetApiName: apiName, verification,
  });
  const finalAuditLog = buildSanitizedAuditLog(client.debugLog);

  if (verificationStatus === "failed") {
    const unverifiedCore = [
      !verification.bundle && "bundle", !verification.componentsResolved && "componentsResolved", !verification.pricingRules && "pricingRules",
      !verification.lookupTable && "lookupTable", !verification.pricingElement && "pricingElement",
      !verification.expressionSet.deployed && "expressionSet (never reported deployed)",
      !verification.expressionSetVersion.deployed && "expressionSetVersion (never reported deployed)",
    ].filter((v): v is string => !!v);
    const failure = buildLogicalFailure("verify-salesforce", `Salesforce read-back could not confirm every required component: ${unverifiedCore.join(", ")}.`);
    step(steps, "verify-salesforce", "error", `✕ ${failure.reason}`);
    return {
      success: false, error: `[${executionId}] ${failure.reason}`, failure, warnings, steps, status: "failed",
      executionId, auditLog: finalAuditLog, procedureSnapshot: finalSnapshot, adjustmentDecisions, expressionSetValidation,
      deployPayloadFingerprint, bundleDiscountInputBinding: canvas.bundleDiscountInputBinding, bundleDiscountBranchSelection: canvas.bundleDiscountBranchSelection,
      deploymentSummary, lifecycleStatus, expressionSetVersionResolution, activationAudit, expressionSetDonorInspection,
      bundle: { id: input.bundle.id, name: input.bundle.name }, priceAdjustmentScheduleId: native.scheduleId,
      ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds, ignoredComponents: input.ignoredComponents,
      expressionSetId, expressionSetApiName: apiName, expressionSetVersionId, versionStatus, verification,
    };
  }

  const activationIssue = lifecycleStatus.activation === "failed";
  let verificationWarning: string | undefined;
  if (verificationStatus === "verified_with_warning" || activationIssue) {
    const unconfirmed = [!verification.expressionSet.verified && "Expression Set", !verification.expressionSetVersion.verified && "Expression Set Version", !verification.pricingProcedure.verified && "Pricing Procedure"].filter((v): v is string => !!v);
    const parts: string[] = [];
    if (unconfirmed.length > 0) parts.push(`Direct post-deployment read-back could not confirm: ${unconfirmed.join(", ")}.`);
    if (activationIssue) parts.push(`Expression Set Version resolution succeeded (${expressionSetVersionId}), but activation to "Active" could not be confirmed — it remains in ${versionStatus} status.`);
    parts.push(`Salesforce's Metadata API deployment itself already succeeded (${deploymentSummary.componentsDeployed} component(s), ${deploymentSummary.errors} error(s)) — this is a warning, never a creation failure.`);
    verificationWarning = parts.join(" ");
    step(steps, "verify-salesforce", "info", `⚠ ${verificationWarning}`);
  } else {
    step(steps, "verify-salesforce", "success", "✓ Every required Salesforce component was confirmed via read-back.");
  }
  const overallStatus: CreateBundlePricingResult["status"] = verificationStatus === "verified" && !activationIssue ? "success" : "deployed_with_verification_warning";

  return {
    success: true, warnings, steps, status: overallStatus,
    deploymentSummary, verificationWarning, lifecycleStatus, expressionSetVersionResolution, activationAudit, expressionSetDonorInspection,
    executionId, auditLog: finalAuditLog, procedureSnapshot: finalSnapshot, adjustmentDecisions, expressionSetValidation,
    deployPayloadFingerprint, bundleDiscountInputBinding: canvas.bundleDiscountInputBinding, bundleDiscountBranchSelection: canvas.bundleDiscountBranchSelection,
    bundle: { id: input.bundle.id, name: input.bundle.name }, priceAdjustmentScheduleId: native.scheduleId,
    ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds, ignoredComponents: input.ignoredComponents,
    expressionSetId, expressionSetApiName: apiName, expressionSetVersionId, versionStatus, verification,
  };
}
