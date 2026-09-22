/**
 * Tier-Based (Slab) Pricing — the Salesforce-write pipeline, run strictly sequentially. Mirrors
 * lib/pricing-rules/volume-based/create/createPipeline.ts's exact architecture:
 *   PRE-FLIGHT              — 100% read-only (schema + donor resolution); nothing is created/modified until this passes
 *   create-schedule         — PriceAdjustmentSchedule (AdjustmentMethod=Slab, or Range for Override tiers)
 *   create-tiers            — one PriceAdjustmentTier per VolumeTier row
 *   verify-native-records   — read-back of every native record just created
 *   verify-tier-schedule    — automatic self-check tracing the BKM's own filter predicates against the
 *                             records just created (Section 9, bug #1 fix — non-fatal, warning-only)
 *   refresh-tier-entries    — non-blocking Decision Table dataset refresh
 *   build-expression-set / validate-expression-set — clone+patch the donor Expression Set XML
 *   deploy-pricing-procedure — org-uniqueness pre-flight + Metadata API deploy + FATAL post-deploy
 *                              Decision Table lookup verification (Section 9, bug #5 fix)
 *   activate-version        — Expression Set Version activation
 *   activate-schedule       — PriceAdjustmentSchedule activation (only after tiers exist)
 *   verify-salesforce       — read-back verification of every component
 *
 * Never deletes an existing Salesforce record.
 */
import { createHash } from "node:crypto";
import type { SalesforceClient } from "@/lib/salesforce/client";
import {
  resolveProductContext, prepareTierSchema, createPriceAdjustmentSchedule, patchAdjustmentMethod,
  createPriceAdjustmentTiers, validateCreatedTierFields, activateSchedule,
} from "./nativeRecords";
import { buildTierCanvas } from "./canvasBuilder";
import { refreshTierDecisionTable } from "./decisionTableRefresh";
import { verifyTierSchedule } from "./verifyTierSchedule";
import { deployExpressionSetDefinition } from "@/lib/pricing-rules/attribute-based/create/deploy";
import { validateExpressionSetUniquenessAgainstOrg, diagnosePostDeployFailure, resolveNextAvailableExpressionSetVersion, type OrgUniquenessResult } from "@/lib/pricing-rules/attribute-based/create/orgUniquenessValidation";
import { activateExpressionSetVersion } from "@/lib/pricing-rules/attribute-based/create/activation";
import { refreshListPriceDecisionTable } from "@/lib/pricing-rules/attribute-based/create/decisionTableRefresh";
import { resolveExpressionSetId, resolveExpressionSetVersionId, verifyTierSalesforceState, verifyDeployedDecisionTableLookups } from "./verifySalesforceState";
import { resolveTierBasedPricingDonor, buildNoCoherentDonorDiagnostic, inspectAllExpressionSetDefinitionDonors } from "./donorInspection";
import { buildFailureDiagnostics, buildLogicalFailure } from "./errorDiagnostics";
import { buildSanitizedAuditLog } from "@/lib/salesforce/auditLog";
import type { ProcedureStepLite, VolumeTier } from "../types";
import type {
  CreateTierPricingResult, TierGeneratedProcedureSnapshot, TierSalesforceVerificationSummary,
  TierPricingLifecycleStatus, ExpressionSetVersionResolutionAudit, TierPricingActivationAudit, CanvasStepPlan,
} from "./types";

function step(steps: ProcedureStepLite[], name: string, status: ProcedureStepLite["status"], message: string) {
  steps.push({ step: name, status, message, timestamp: Date.now() });
}

function deriveApiName(procedureName: string): string {
  const sanitized = procedureName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const withLeadingLetter = /^[a-zA-Z]/.test(sanitized) ? sanitized : `Proc_${sanitized}`;
  return withLeadingLetter.slice(0, 40) || "Tier_Based_Pricing_Procedure";
}

export function generateExecutionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(16).slice(2, 6).toUpperCase().padEnd(4, "0");
  return `TBP-${datePart}-${timePart}-${suffix}`;
}

function buildCanvasStepPlan(tiersCreated: number): CanvasStepPlan[] {
  return [
    { seq: 1, actionType: "PricingSettings", label: "Pricing Settings", description: "Initializes pricing context, validates contract and effective dates" },
    { seq: 2, actionType: "ListPrice", label: "List Price", description: "Fetches base unit price from Standard Price Book" },
    { seq: 3, actionType: "VolumeTierDiscount", label: "Tier Discount", description: `Applies tier slab discount — each quantity band priced independently (${tiersCreated > 0 ? `${tiersCreated} tier${tiersCreated !== 1 ? "s" : ""}` : "schedule-based"})` },
  ];
}

function buildProcedureSnapshot(input: {
  executionId: string;
  product: { id: string; name: string };
  tiers: VolumeTier[];
  priceAdjustmentScheduleId?: string;
  tierIds?: string[];
  expressionSetId?: string;
  expressionSetVersionId?: string;
  expressionSetApiName?: string;
  verification?: TierSalesforceVerificationSummary;
}): TierGeneratedProcedureSnapshot {
  return {
    executionId: input.executionId,
    pricingType: "tier-based",
    product: { name: input.product.name, id: input.product.id },
    tiers: input.tiers,
    salesforce: {
      priceAdjustmentScheduleId: input.priceAdjustmentScheduleId ?? null,
      priceAdjustmentTierIds: input.tierIds ?? [],
      expressionSetId: input.expressionSetId ?? null,
      expressionSetVersionId: input.expressionSetVersionId ?? null,
      pricingProcedureApiName: input.expressionSetApiName ?? null,
    },
    verificationStatus: input.verification ? deriveVerificationStatus(input.verification) : "pending",
  };
}

function deriveVerificationStatus(v: TierSalesforceVerificationSummary): "verified" | "verified_with_warning" | "failed" {
  const coreOk = v.product && v.scheduleVerified && v.tierCount > 0 && v.pricingElement;
  const esLayerDeployed = [v.expressionSet, v.expressionSetVersion, v.pricingProcedure].every(c => c.deployed);
  const esLayerVerified = v.expressionSetVersion.verified && v.pricingProcedure.verified;
  if (coreOk && esLayerVerified) return "verified";
  if (coreOk && esLayerDeployed) return "verified_with_warning";
  return "failed";
}

export interface CreateTierPipelineInput {
  client: SalesforceClient;
  product: { id: string; name: string };
  tiers: VolumeTier[];
  basePrice: number;
  procedureName: string;
  description?: string;
  activate: boolean;
}

export async function runCreateTierPricingPipeline(
  input: CreateTierPipelineInput,
  onStep?: (event: { step: string; status: "running" | "done" | "failed" | "warning"; detail?: string }) => void,
): Promise<CreateTierPricingResult> {
  const { client } = input;
  const steps: ProcedureStepLite[] = [];
  const warnings: string[] = [];

  const executionId = generateExecutionId();
  client.logDebug("execution-trace", `Execution ID: ${executionId} — Tier-Based Pricing creation started for product "${input.product.name}" (${input.product.id}).`);

  const emit = (name: string, status: "running" | "done" | "failed" | "warning", detail?: string) => onStep?.({ step: name, status, detail });

  function fail(result: Partial<CreateTierPricingResult> & { failure: CreateTierPricingResult["failure"] }): CreateTierPricingResult {
    emit(result.failure!.step, "failed", result.failure!.reason);
    const procedureSnapshot = buildProcedureSnapshot({
      executionId, product: input.product, tiers: input.tiers, priceAdjustmentScheduleId: result.priceAdjustmentScheduleId,
      tierIds: result.tierIds, expressionSetId: result.expressionSetId, expressionSetVersionId: result.expressionSetVersionId,
      expressionSetApiName: result.expressionSetApiName, verification: result.verification,
    });
    return {
      success: false, status: "failed", error: `[${executionId}] ${result.failure!.reason}`, warnings, steps,
      executionId, auditLog: buildSanitizedAuditLog(client.debugLog), procedureSnapshot, pricingType: "tier-based",
      ...result,
    };
  }

  if (input.tiers.length === 0) {
    return fail({ failure: buildLogicalFailure("create-tiers", "No tiers to create — nothing was approved for creation.") });
  }

  /* ── PRE-FLIGHT — 100% read-only. If ANY check here fails, nothing was created/modified. ── */
  emit("preflight", "running");
  step(steps, "preflight", "start", "Running pre-flight validation — no Salesforce record will be created or modified until every check below passes.");

  const productContext = await resolveProductContext(client, input.product.id);
  if (!productContext.sellingModelId) warnings.push("No Selling Model was found for this product — some orgs require one for tier-based adjustments; proceeding without it.");

  let schema;
  try {
    step(steps, "preflight", "info", "→ Resolving Tier-Based Pricing schema relationships.");
    schema = await prepareTierSchema(client);
    step(steps, "preflight", "success", "✓ PriceAdjustmentSchedule/PriceAdjustmentTier relationship graph resolved.");
  } catch (err) {
    const failure = buildFailureDiagnostics("preflight", err);
    step(steps, "preflight", "error", failure.reason);
    emit("preflight", "failed", failure.reason);
    return fail({ failure });
  }

  step(steps, "preflight", "info", "→ Resolving Tier-Based Pricing Expression Set donor.");
  let preflightDonorResolution: Awaited<ReturnType<typeof resolveTierBasedPricingDonor>>;
  try {
    preflightDonorResolution = await resolveTierBasedPricingDonor(client);
  } catch (err) {
    const failure = buildFailureDiagnostics("preflight", err);
    step(steps, "preflight", "error", failure.reason);
    emit("preflight", "failed", failure.reason);
    return fail({ failure });
  }
  if (!preflightDonorResolution.selection) {
    const noDonorDiagnostic = buildNoCoherentDonorDiagnostic(preflightDonorResolution.candidatesWithTierDiscount);
    const lowConfidenceNote = preflightDonorResolution.lowConfidenceCandidates
      ? "\n\nNote: some candidates DID prove a schedule-based VolumeTierDiscount->ListPrice connection but scored below the trust floor:\n"
        + preflightDonorResolution.lowConfidenceCandidates.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n")
      : "";
    const failure = buildLogicalFailure(
      "preflight",
      "No ExpressionSetDefinition in this org has PricingSettings, ListPrice, AND a SCHEDULE-BASED VolumeTierDiscount branch proven connected to that SAME ListPrice with sufficient confidence. " +
      "VolumeTierDiscount cannot be authored from a blank canvas. Stopping BEFORE creating any Schedule or Tier.\n\n" + noDonorDiagnostic + lowConfidenceNote,
    );
    step(steps, "preflight", "error", failure.reason);
    emit("preflight", "failed", failure.reason);
    return fail({ failure });
  }
  step(steps, "preflight", "success", `✓ Expression Set donor validated: ${preflightDonorResolution.selection.fullName} (schedule-based VolumeTierDiscount → ListPrice connection proven).`);
  step(steps, "preflight", "success", "PRE-FLIGHT PASSED — no Salesforce record has been created or modified yet.");
  emit("preflight", "done", "Pre-flight validation passed.");

  const hasOverrideTiers = input.tiers.some(t => String(t.tierType).toLowerCase().includes("override"));

  /* ── create-schedule ── */
  emit("create-schedule", "running");
  let scheduleId: string;
  let resolvedAdjustmentMethod: string;
  try {
    const result = await createPriceAdjustmentSchedule(client, schema, { procedureName: input.procedureName, product: productContext, hasOverrideTiers }, steps);
    scheduleId = result.scheduleId;
    resolvedAdjustmentMethod = result.resolvedAdjustmentMethod;
    await patchAdjustmentMethod(client, schema, scheduleId, resolvedAdjustmentMethod, steps, warnings, "pre-tier");
    emit("create-schedule", "done", `Schedule ${scheduleId}.`);
  } catch (err) {
    const failure = buildFailureDiagnostics("create-schedule", err);
    step(steps, "create-schedule", "error", failure.reason);
    return fail({ failure });
  }

  /* ── create-tiers ── */
  emit("create-tiers", "running");
  let tierIds: string[];
  const effectiveFrom = new Date().toISOString().slice(0, 10);
  const effectiveTo = "2099-12-31";
  try {
    const result = await createPriceAdjustmentTiers(client, schema, { scheduleId, tiers: input.tiers, product: productContext, effectiveFrom, effectiveTo }, steps);
    tierIds = result.tierIds;
    emit("create-tiers", "done", `${tierIds.length} tier(s).`);
  } catch (err) {
    const failure = buildFailureDiagnostics("create-tiers", err);
    step(steps, "create-tiers", "error", failure.reason);
    return fail({ failure, priceAdjustmentScheduleId: scheduleId });
  }

  await patchAdjustmentMethod(client, schema, scheduleId, resolvedAdjustmentMethod, steps, warnings, "post-tier");

  /* ── verify-native-records ── */
  emit("verify-native-records", "running");
  const tierFieldWarnings = await validateCreatedTierFields(client, scheduleId);
  warnings.push(...tierFieldWarnings);
  for (const w of tierFieldWarnings) step(steps, "verify-native-records", "info", `⚠ ${w}`);
  step(steps, "verify-native-records", "success", `Schedule + ${tierIds.length} tier(s) created.`);
  emit("verify-native-records", "done");

  /* ── verify-tier-schedule — automatic self-check (Section 9, bug #1 fix). Non-fatal: traces the BKM's
   * own filter predicates against the records just created, using the first tier's own lowerBound as a
   * quantity guaranteed in-range by construction. ── */
  emit("verify-tier-schedule", "running");
  let tierScheduleVerification;
  try {
    tierScheduleVerification = await verifyTierSchedule(client, { scheduleId, quantity: input.tiers[0].lowerBound });
    if (tierScheduleVerification.verdict !== "MATCH_FOUND") {
      warnings.push(`verify-tier-schedule: ${tierScheduleVerification.detail} ${tierScheduleVerification.recommendation}`);
      step(steps, "verify-tier-schedule", "error", `⚠ ${tierScheduleVerification.verdict}: ${tierScheduleVerification.detail}`);
      emit("verify-tier-schedule", "warning", tierScheduleVerification.detail);
    } else {
      step(steps, "verify-tier-schedule", "success", `✓ ${tierScheduleVerification.detail}`);
      emit("verify-tier-schedule", "done");
    }
  } catch (err) {
    const message = `verify-tier-schedule self-check could not run: ${err instanceof Error ? err.message : String(err)}.`;
    warnings.push(message);
    step(steps, "verify-tier-schedule", "info", `⚠ ${message}`);
    emit("verify-tier-schedule", "warning", message);
  }

  /* ── refresh-tier-entries — non-blocking ── */
  emit("refresh-tier-entries", "running");

  const apiName = deriveApiName(input.procedureName);

  /* ── Resolve the next available Expression Set Version BEFORE canvas build ── */
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

  let expressionSetDonorInspection: Awaited<ReturnType<typeof inspectAllExpressionSetDefinitionDonors>> | undefined;
  try {
    expressionSetDonorInspection = await inspectAllExpressionSetDefinitionDonors(client, "VolumeTierDiscount");
  } catch (err) {
    warnings.push(`Donor inventory (diagnostic-only) failed: ${err instanceof Error ? err.message : String(err)} — this does not affect the actual build.`);
  }

  /* ── build-expression-set / validate-expression-set ── */
  emit("build-expression-set", "running");
  let canvas;
  try {
    canvas = await buildTierCanvas(client, {
      procedureName: input.procedureName, apiName, description: input.description,
      versionNumber: nextVersionResolution?.versionNumber, rank: nextVersionResolution?.rank,
      onProgress: phase => {
        if (phase === "template-retrieved") emit("build-expression-set", "running", "Template retrieved — building canvas.");
      },
    });
  } catch (err) {
    const failure = buildFailureDiagnostics("build-expression-set", err);
    step(steps, "build-expression-set", "error", failure.reason);
    return fail({ failure, priceAdjustmentScheduleId: scheduleId, tierIds, expressionSetDonorInspection, tierScheduleVerification });
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
    return fail({ failure, warnings, priceAdjustmentScheduleId: scheduleId, tierIds, expressionSetValidation, expressionSetDonorInspection, tierScheduleVerification });
  }
  warnings.push(...canvas.warnings);
  step(steps, "build-expression-set", "success", `✓ Selected donor: ${canvas.canvasComposition?.donorFullName} (${canvas.canvasComposition?.donorPhysicalStepCount} physical step(s) originally; ${canvas.canvasComposition?.prunedRootBranchCount} unrelated root branch(es) pruned away).`);
  step(steps, "build-expression-set", "success", "✓ PricingSettings, ListPrice, VolumeTierDiscount composed and structurally validated.");
  step(steps, "validate-expression-set", "success", "Structural validation passed against the composed final canvas.");
  const deployPayloadFingerprint = createHash("sha256").update(canvas.finalFileXml).digest("hex");
  emit("build-expression-set", "done");
  emit("validate-expression-set", "done");

  const tierRefresh = await refreshTierDecisionTable(client, canvas.vtdLookup ?? { id: null, apiName: null, name: null });
  if (tierRefresh.warning) warnings.push(tierRefresh.warning);
  step(steps, "refresh-tier-entries", tierRefresh.refreshed ? "success" : "info", tierRefresh.refreshed ? `Refreshed "${canvas.vtdLookup?.name ?? canvas.vtdLookup?.apiName}".` : (tierRefresh.warning ?? "Not refreshed."));
  emit("refresh-tier-entries", tierRefresh.refreshed ? "done" : "warning", tierRefresh.refreshed ? "Refreshed." : tierRefresh.warning);

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
    return fail({ failure, warnings, priceAdjustmentScheduleId: scheduleId, tierIds, expressionSetDonorInspection, tierScheduleVerification });
  }

  /* ── Payload fingerprint check ── */
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
    return fail({ failure, warnings, priceAdjustmentScheduleId: scheduleId, tierIds, deployPayloadFingerprint, expressionSetDonorInspection, tierScheduleVerification });
  }
  const deployPayloadFingerprintAtDeploy = createHash("sha256").update(canvas.finalFileXml).digest("hex");
  if (deployPayloadFingerprintAtDeploy !== deployPayloadFingerprint) {
    const failure = buildLogicalFailure("deploy-pricing-procedure", `Refusing to deploy — the XML about to be sent (sha256 ${deployPayloadFingerprintAtDeploy}) does not match the XML that was validated (sha256 ${deployPayloadFingerprint}).`);
    step(steps, "deploy-pricing-procedure", "error", failure.reason);
    return fail({ failure, warnings, priceAdjustmentScheduleId: scheduleId, tierIds, deployPayloadFingerprint, expressionSetDonorInspection, tierScheduleVerification });
  }
  step(steps, "deploy-pricing-procedure", "success", "✓ Payload verification passed.");

  /* ── deploy-pricing-procedure ── */
  emit("deploy-pricing-procedure", "running");
  const deployResult = await deployExpressionSetDefinition(client, apiName, canvas.finalFileXml, canvas.donorFileName, "VolumeTierDiscount");
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
    return fail({ failure, warnings, priceAdjustmentScheduleId: scheduleId, tierIds, deployPayloadFingerprint, expressionSetDonorInspection, tierScheduleVerification });
  }
  step(steps, "deploy-pricing-procedure", "success", `✓ Deployed ${deployResult.status?.numberComponentsDeployed ?? 0} component(s), ${deployResult.status?.numberComponentErrors ?? 0} error(s).`);
  const deploymentSummary = {
    success: deployResult.status?.success ?? deployResult.success,
    deploymentId: deployResult.status?.id ?? null,
    componentsDeployed: deployResult.status?.numberComponentsDeployed ?? 0,
    errors: deployResult.status?.numberComponentErrors ?? 0,
  };
  emit("deploy-pricing-procedure", "done");

  /* ── §Bug #5 fix — FATAL post-deploy Decision Table lookup verification, unlike the volume-based
   * sibling (in the source app this was ported from) which only logs this mismatch. A wrong LookUpId
   * means the deployed procedure would report success while never producing a discount at runtime. ── */
  const lookupCheck = await verifyDeployedDecisionTableLookups(client, {
    expressionSetApiName: apiName,
    expectedListPriceLookUpId: canvas.lpLookup?.lookUpId ?? null,
    expectedTierAdjustmentLookUpId: canvas.vtdLookup?.id ?? null,
  });
  if (!lookupCheck.ok) {
    const failure = buildLogicalFailure("deploy-pricing-procedure", lookupCheck.detail);
    step(steps, "deploy-pricing-procedure", "error", `✕ ${lookupCheck.detail}`);
    return fail({ failure, warnings, priceAdjustmentScheduleId: scheduleId, tierIds, deployPayloadFingerprint, expressionSetDonorInspection, tierScheduleVerification });
  }
  step(steps, "deploy-pricing-procedure", "success", "✓ Deployed Decision Table lookups verified against the resolved Price Book / Tier Adjustment tables.");

  const componentSuccesses = deployResult.status?.componentSuccesses;

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
  const activationAudit: TierPricingActivationAudit = {
    attempted: !!input.activate, versionId: expressionSetVersionId ?? null, success: versionStatus === "Active",
    status: input.activate ? versionStatus : null, detail: activationDetail,
  };

  /* ── activate-schedule — only after every tier already exists ── */
  emit("activate-schedule", "running");
  const scheduleActivated = await activateSchedule(client, schema, scheduleId, steps, warnings);
  emit("activate-schedule", scheduleActivated ? "done" : "warning");

  /* ── verify-salesforce ── */
  emit("verify-salesforce", "running");
  const verification = await verifyTierSalesforceState(client, {
    productId: input.product.id, scheduleId, tierIds, expressionSetApiName: apiName, expressionSetId, expressionSetVersionId, componentSuccesses,
  }, steps);
  const verificationStatus = deriveVerificationStatus(verification);
  emit("verify-salesforce", verificationStatus === "verified" ? "done" : "warning");

  const lifecycleStatus: TierPricingLifecycleStatus = {
    expressionSetDeployment: deploymentSummary.success ? "success" : "failed",
    expressionSetVersionDeployment: deploymentSummary.success ? "success" : "failed",
    expressionSetVersionResolution: expressionSetVersionId ? "success" : (expressionSetId ? "failed" : "skipped"),
    activation: !input.activate ? "not_requested" : (versionStatus === "Active" ? "success" : (expressionSetVersionId ? "failed" : "skipped")),
    scheduleActivation: scheduleActivated ? "success" : (schema.schedActiveField ? "failed" : "skipped"),
    pricingProcedure: verification.pricingProcedure.verified ? "verified" : (verification.pricingProcedure.deployed ? "deployed" : "not_verified"),
  };

  const finalSnapshot = buildProcedureSnapshot({
    executionId, product: input.product, tiers: input.tiers, priceAdjustmentScheduleId: scheduleId, tierIds,
    expressionSetId, expressionSetVersionId, expressionSetApiName: apiName, verification,
  });
  const finalAuditLog = buildSanitizedAuditLog(client.debugLog);
  const canvasSteps = buildCanvasStepPlan(tierIds.length);

  if (verificationStatus === "failed") {
    const unverifiedCore = [
      !verification.product && "product", !verification.scheduleVerified && "scheduleVerified",
      verification.tierCount !== tierIds.length && "tierCount",
      !verification.expressionSet.deployed && "expressionSet (never reported deployed)",
      !verification.expressionSetVersion.deployed && "expressionSetVersion (never reported deployed)",
    ].filter((v): v is string => !!v);
    const failure = buildLogicalFailure("verify-salesforce", `Salesforce read-back could not confirm every required component: ${unverifiedCore.join(", ")}.`);
    step(steps, "verify-salesforce", "error", `✕ ${failure.reason}`);
    return {
      success: false, error: `[${executionId}] ${failure.reason}`, failure, warnings, steps, status: "failed",
      executionId, auditLog: finalAuditLog, procedureSnapshot: finalSnapshot, expressionSetValidation,
      deployPayloadFingerprint, tierDiscountInputBinding: canvas.tierDiscountInputBinding,
      deploymentSummary, lifecycleStatus, expressionSetVersionResolution, activationAudit, expressionSetDonorInspection,
      product: input.product, priceAdjustmentScheduleId: scheduleId, tierIds, tiersCreated: tierIds.length, resolvedAdjustmentMethod,
      expressionSetId, expressionSetApiName: apiName, expressionSetVersionId, versionStatus, scheduleActivated, verification,
      canvasSteps, canvasDeployed: deploymentSummary.success, canvasStepCount: canvasSteps.length, pricingType: "tier-based",
      tierScheduleVerification,
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
  const overallStatus: CreateTierPricingResult["status"] = verificationStatus === "verified" && !activationIssue ? "success" : "deployed_with_verification_warning";

  return {
    success: true, warnings, steps, status: overallStatus,
    deploymentSummary, verificationWarning, lifecycleStatus, expressionSetVersionResolution, activationAudit, expressionSetDonorInspection,
    executionId, auditLog: finalAuditLog, procedureSnapshot: finalSnapshot, expressionSetValidation,
    deployPayloadFingerprint, tierDiscountInputBinding: canvas.tierDiscountInputBinding,
    product: input.product, priceAdjustmentScheduleId: scheduleId, tierIds, tiersCreated: tierIds.length, resolvedAdjustmentMethod,
    expressionSetId, expressionSetApiName: apiName, expressionSetVersionId, versionStatus, scheduleActivated, verification,
    canvasSteps, canvasDeployed: deploymentSummary.success, canvasStepCount: canvasSteps.length, pricingType: "tier-based",
    tierScheduleVerification,
  };
}
