/**
 * Bundle-Based Pricing — the Salesforce-write pipeline, run strictly sequentially:
 *   PRE-FLIGHT (read-only; nothing is written until every check passes)
 *     resolve-lookup-table — the Decision Table the BundleDiscount element executes (lookupTableResolver.ts)
 *     schema               — BundleBasedAdjustment fields + the table's key columns
 *     donor                — an existing, working BundleDiscount procedure to clone from
 *     selling models       — child / parent / root selling models the table matches on
 *   create-schedule         — this procedure's own Bundle Price Adjustment Schedule (create/reuse)
 *   upsert-adjustments      — BundleBasedAdjustment rows = the lookup table's entries (create/reuse/update)
 *   verify-adjustment-records — read-back + replay of the lookup table's own match against every row
 *   refresh-lookup-table    — refresh the table and WAIT until Salesforce reports it Completed
 *   build-expression-set / validate-expression-set — clone+patch the donor, bound to the table + schedule
 *   deploy-pricing-procedure — org-uniqueness pre-flight + Metadata API deploy (ES + ESV + procedure)
 *   resolve-version         — the real ExpressionSet / ExpressionSetVersion Ids; failure stops here
 *   activate-version
 *   verify-salesforce       — re-retrieves the DEPLOYED procedure and checks every binding
 *
 * Never deletes an existing Salesforce record. Every write reuses an existing record by its deterministic
 * identity, so re-running the same configuration creates nothing new.
 */
import { createHash } from "node:crypto";
import type { SalesforceClient } from "@/lib/salesforce/client";
import {
  prepareBundleBasedAdjustmentSchema, resolveOrCreateBundlePriceAdjustmentSchedule, resolveBundleSellingModels,
  buildRowPlans, upsertBundleBasedAdjustments, resolveRuntimeBundleAdjustment,
  type BundleBasedPricingSchema, type BundleSellingModels, type RuntimeBundleAdjustmentTrace,
} from "./nativeRecords";
import { resolveBundleLookupTable, refreshAndAwaitBundleLookupTable, type ResolvedBundleLookupTable } from "./lookupTableResolver";
import { buildBundleCanvas } from "./canvasBuilder";
import { deployExpressionSetDefinition } from "@/lib/pricing-rules/attribute-based/create/deploy";
import { validateExpressionSetUniquenessAgainstOrg, diagnosePostDeployFailure, resolveNextAvailableExpressionSetVersion, type OrgUniquenessResult } from "@/lib/pricing-rules/attribute-based/create/orgUniquenessValidation";
import { activateExpressionSetVersion } from "@/lib/pricing-rules/attribute-based/create/activation";
import { refreshListPriceDecisionTable } from "@/lib/pricing-rules/attribute-based/create/decisionTableRefresh";
import { resolveExpressionSetId, resolveExpressionSetVersionId, verifyBundleSalesforceState, findReusableBundleProcedure, type ReusableProcedureCheck } from "./verifySalesforceState";
import type { ComponentSuccess } from "@/lib/pricing-rules/attribute-based/create/soapEnvelope";
import { resolveBundleBasedPricingDonor, buildNoCoherentDonorDiagnostic, inspectAllExpressionSetDefinitionDonors } from "./donorInspection";
import { buildFailureDiagnostics, buildLogicalFailure } from "./errorDiagnostics";
import { buildSanitizedAuditLog } from "@/lib/salesforce/auditLog";
import { bundleLog } from "./bundleLog";
import type { DiscoveredBundle, BundleComponentPlanRow, ProcedureStepLite } from "../types";
import type {
  CreateBundlePricingResult, BundleGeneratedProcedureSnapshot, BundleSalesforceVerificationSummary,
  BundlePricingLifecycleStatus, ExpressionSetVersionResolutionAudit, BundlePricingActivationAudit,
} from "./types";

function step(steps: ProcedureStepLite[], name: string, status: ProcedureStepLite["status"], message: string) {
  steps.push({ step: name, status, message, timestamp: Date.now() });
}

export function deriveApiName(procedureName: string): string {
  const sanitized = procedureName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const withLeadingLetter = /^[a-zA-Z]/.test(sanitized) ? sanitized : `Proc_${sanitized}`;
  return withLeadingLetter.slice(0, 40).replace(/_+$/, "") || "Bundle_Based_Pricing_Procedure";
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
  lookupTable?: ResolvedBundleLookupTable;
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
      lookupTableId: input.lookupTable?.id ?? null,
      lookupTableApiName: input.lookupTable?.developerName ?? null,
      bundleBasedAdjustmentIds: input.adjustmentIds ?? [],
      expressionSetId: input.expressionSetId ?? null,
      expressionSetVersionId: input.expressionSetVersionId ?? null,
      pricingProcedureApiName: input.expressionSetApiName ?? null,
    },
    verificationStatus: input.verification ? deriveVerificationStatus(input.verification) : "pending",
  };
}

export function deriveVerificationStatus(v: BundleSalesforceVerificationSummary): "verified" | "verified_with_warning" | "failed" {
  const coreOk = v.bundle && v.componentsResolved && v.pricingRules && v.lookupTable && v.pricingElement && v.scheduleBinding;
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
  /** Optional Decision Table Id/DeveloperName the Bundle-Based Adjustment configuration names directly. */
  lookupTableReference?: string | null;
}

type StepEmitter = (event: { step: string; status: "running" | "done" | "failed" | "warning"; detail?: string }) => void;

export async function runCreateBundlePricingPipeline(input: CreateBundlePipelineInput, onStep?: StepEmitter): Promise<CreateBundlePricingResult> {
  const { client } = input;
  const steps: ProcedureStepLite[] = [];
  const warnings: string[] = [];
  const executionId = generateExecutionId();
  const bundleRef = { id: input.bundle.id, name: input.bundle.name };
  bundleLog(client, "pipeline-start", {
    executionId, pricingType: "bundle-based", bundle: bundleRef, procedureName: input.procedureName,
    components: input.rules.map(r => ({ name: r.componentName, id: r.componentProductId, type: r.adjustmentType, value: r.adjustment, stated: r.stated })),
    relationshipSource: input.bundle.relationshipSource,
  });

  const emit = (name: string, status: "running" | "done" | "failed" | "warning", detail?: string) => onStep?.({ step: name, status, detail });
  const apiName = deriveApiName(input.procedureName);

  // Accumulated state, so a failure at any step reports everything that already exists in Salesforce.
  const state: Partial<CreateBundlePricingResult> = { bundle: bundleRef, ignoredComponents: input.ignoredComponents };

  function fail(failure: NonNullable<CreateBundlePricingResult["failure"]>, extra: Partial<CreateBundlePricingResult> = {}): CreateBundlePricingResult {
    emit(failure.step, "failed", failure.reason);
    step(steps, failure.step, "error", failure.reason);
    const merged = { ...state, ...extra };
    bundleLog(client, "pipeline-failed", { executionId, step: failure.step, reason: failure.reason, salesforceErrorCode: failure.salesforceErrorCode ?? null });
    return {
      ...merged,
      success: false, status: "failed", error: `[${executionId}] ${failure.reason}`, failure, warnings, steps,
      executionId, auditLog: buildSanitizedAuditLog(client.debugLog),
      procedureSnapshot: buildProcedureSnapshot({
        executionId, bundle: bundleRef, rules: input.rules, priceAdjustmentScheduleId: merged.priceAdjustmentScheduleId,
        lookupTable: merged.lookupTable, adjustmentIds: merged.adjustmentIds, expressionSetId: merged.expressionSetId,
        expressionSetVersionId: merged.expressionSetVersionId, expressionSetApiName: merged.expressionSetApiName, verification: merged.verification,
      }),
    };
  }

  if (input.rules.length === 0) {
    return fail(buildLogicalFailure("preflight", "No component pricing rules were provided — nothing was approved for creation."));
  }
  if (input.bundle.components.length === 0) {
    return fail(buildLogicalFailure("preflight", `Bundle "${input.bundle.name}" has no child components in Salesforce — Bundle-Based Pricing needs at least one component to adjust.`));
  }
  const knownComponentIds = new Set(input.bundle.components.map(c => c.productId));
  const foreign = input.rules.filter(r => !knownComponentIds.has(r.componentProductId));
  if (foreign.length > 0) {
    return fail(buildLogicalFailure("preflight", `Component(s) ${foreign.map(f => `"${f.componentName}" (${f.componentProductId})`).join(", ")} are not components of bundle "${input.bundle.name}".`));
  }

  /* ── PRE-FLIGHT — 100% read-only ── */
  emit("preflight", "running");
  step(steps, "preflight", "start", "Running pre-flight validation — no Salesforce record will be created or modified until every check below passes.");

  let lookupTable: ResolvedBundleLookupTable;
  try {
    emit("resolve-lookup-table", "running");
    lookupTable = await resolveBundleLookupTable(client, { explicitReference: input.lookupTableReference });
    state.lookupTable = lookupTable;
    step(steps, "resolve-lookup-table", "success",
      `✓ Lookup table: ${lookupTable.developerName} (${lookupTable.id}) — ${lookupTable.reason} INPUT [${lookupTable.inputs.map(i => i.fieldName).join(", ")}] → OUTPUT [${lookupTable.outputs.join(", ")}].`);
    emit("resolve-lookup-table", "done", `${lookupTable.developerName} (${lookupTable.selectedBy}).`);
  } catch (err) {
    return fail(buildFailureDiagnostics("resolve-lookup-table", err));
  }

  let schema: BundleBasedPricingSchema;
  try {
    schema = await prepareBundleBasedAdjustmentSchema(client, lookupTable);
    step(steps, "preflight", "success", `✓ BundleBasedAdjustment schema resolved; lookup key columns: ${schema.keyFields.join(", ")}.`);
  } catch (err) {
    return fail(buildFailureDiagnostics("preflight", err));
  }

  let donorResolution: Awaited<ReturnType<typeof resolveBundleBasedPricingDonor>>;
  try {
    donorResolution = await resolveBundleBasedPricingDonor(client, { lookupTable, excludeDefinitionApiName: apiName });
  } catch (err) {
    return fail(buildFailureDiagnostics("preflight", err));
  }
  if (!donorResolution.selection) {
    const lowConfidenceNote = donorResolution.lowConfidenceCandidates
      ? "\n\nCandidates that proved a BundleDiscount → ListPrice connection but scored below the trust floor:\n"
        + donorResolution.lowConfidenceCandidates.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n")
      : "";
    return fail(buildLogicalFailure(
      "preflight",
      "No Expression Set in this org has PricingSettings, ListPrice, and a BundleDiscount step connected to that ListPrice. " +
      "BundleDiscount cannot be authored from a blank canvas. Stopped before writing anything.\n\n" +
      buildNoCoherentDonorDiagnostic(donorResolution.candidatesWithBundleDiscount) + lowConfidenceNote,
    ));
  }
  step(steps, "preflight", "success", `✓ Expression Set donor: ${donorResolution.selection.fullName} (score ${donorResolution.selection.ranking[0]?.score}).`);

  let sellingModels: BundleSellingModels;
  try {
    sellingModels = await resolveBundleSellingModels(client, input.bundle.id, input.bundle.components.map(c => c.productId));
    step(steps, "preflight", "success", `✓ Selling models: bundle [${sellingModels.parentSellingModelIds.join(", ")}], ${sellingModels.componentSellingModelIds.size} component(s).`);
  } catch (err) {
    return fail(buildFailureDiagnostics("preflight", err));
  }
  step(steps, "preflight", "success", "PRE-FLIGHT PASSED — no Salesforce record has been created or modified yet.");
  emit("preflight", "done", "Pre-flight validation passed.");

  /* ── create-schedule ── */
  emit("create-schedule", "running");
  let scheduleId: string;
  try {
    const schedule = await resolveOrCreateBundlePriceAdjustmentSchedule(client, { procedureName: input.procedureName }, steps, m => emit("create-schedule", "running", m));
    scheduleId = schedule.scheduleId;
    state.priceAdjustmentScheduleId = scheduleId;
    state.priceAdjustmentScheduleName = schedule.scheduleName;
    emit("create-schedule", "done", `${schedule.reused ? "Reused" : "Created"} "${schedule.scheduleName}".`);
  } catch (err) {
    return fail(buildFailureDiagnostics("create-schedule", err));
  }

  /* ── upsert-adjustments (= lookup-table entries) ── */
  emit("upsert-adjustments", "running");
  let rowPlans;
  try {
    const built = buildRowPlans(schema, { bundleId: input.bundle.id, scheduleId, rows: input.rules, sellingModels });
    rowPlans = built.plans;
    state.componentsWithoutAdjustment = built.skipped.map(s => s.componentName);
    if (built.skipped.length > 0) step(steps, "upsert-adjustments", "info", `No adjustment configured for: ${built.skipped.map(s => s.componentName).join(", ")} — no lookup-table entry written; pricing leaves them unchanged.`);
    if (rowPlans.length === 0) {
      return fail(buildLogicalFailure("upsert-adjustments", "Every component has a $0 adjustment that the user never set — there is no Bundle-Based Adjustment to create."));
    }
    const { adjustmentIds, decisions } = await upsertBundleBasedAdjustments(client, schema, rowPlans, steps, m => emit("upsert-adjustments", "running", m));
    state.adjustmentIds = adjustmentIds;
    state.adjustmentDecisions = decisions;
    emit("upsert-adjustments", "done", `${adjustmentIds.length} entr${adjustmentIds.length === 1 ? "y" : "ies"}.`);
  } catch (err) {
    return fail(buildFailureDiagnostics("upsert-adjustments", err));
  }

  /* ── verify-adjustment-records — replay the lookup table's own match for every component ── */
  emit("verify-adjustment-records", "running");
  const runtimeTraces: RuntimeBundleAdjustmentTrace[] = [];
  for (const [i, plan] of rowPlans.entries()) {
    const trace = await resolveRuntimeBundleAdjustment(client, lookupTable, plan);
    runtimeTraces.push(trace);
    const expected = state.adjustmentDecisions![i]?.adjustmentId; // upsert returns decisions in plan order
    const ok = trace.resolved && trace.adjustmentId === expected && trace.adjustmentType === plan.adjustmentType && trace.adjustmentValue === plan.adjustmentValue;
    step(steps, "verify-adjustment-records", ok ? "success" : "error", ok
      ? `✓ ${plan.row.componentName}: lookup matches entry ${trace.adjustmentId} → ${trace.adjustmentType} ${trace.adjustmentValue}.`
      : `✕ ${plan.row.componentName}: ${trace.resolved ? `lookup matched ${trace.adjustmentId} (${trace.adjustmentType} ${trace.adjustmentValue}), expected ${expected} (${plan.adjustmentType} ${plan.adjustmentValue})` : trace.reason}`);
  }
  state.runtimeTraces = runtimeTraces;
  const badTraces = runtimeTraces.filter(t => !t.resolved || !state.adjustmentIds!.includes(t.adjustmentId!));
  if (badTraces.length > 0) {
    return fail(buildLogicalFailure("verify-adjustment-records",
      `Replaying lookup table ${lookupTable.developerName} did not resolve exactly the expected entry for: ${badTraces.map(t => `${t.componentName} (${t.reason})`).join("; ")}.`));
  }
  emit("verify-adjustment-records", "done", `${runtimeTraces.length}/${runtimeTraces.length} component lookups resolve to the expected entry.`);

  /* ── refresh-lookup-table — make the new entries visible to pricing BEFORE the procedure exists ── */
  emit("refresh-lookup-table", "running");
  const refresh = await refreshAndAwaitBundleLookupTable(client, lookupTable);
  state.lookupTableRefresh = refresh;
  if (!refresh.refreshed) {
    return fail(buildLogicalFailure("refresh-lookup-table",
      `Lookup table ${lookupTable.developerName} did not finish refreshing (status: ${refresh.finalStatus ?? "unknown"}${refresh.error ? `, error: ${refresh.error}` : ""}). ` +
      "The new entries would not be visible to pricing, so no pricing procedure was created."));
  }
  step(steps, "refresh-lookup-table", "success", `✓ ${lookupTable.developerName} refreshed (${refresh.finalStatus}).`);
  emit("refresh-lookup-table", "done", `Refresh ${refresh.finalStatus}.`);

  state.expressionSetApiName = apiName;

  /* ── reuse-procedure — the procedure only holds bindings; if they're unchanged there's nothing to deploy ── */
  let expressionSetId: string | undefined;
  let expressionSetVersionId: string | undefined;
  let componentSuccesses: ComponentSuccess[] | undefined;
  let versionStatus: "Draft" | "Active" = "Draft";
  const reuse: ReusableProcedureCheck = await findReusableBundleProcedure(client, apiName, lookupTable, scheduleId)
    .catch(err => ({ reusable: false as const, exists: false, reason: `Reuse check failed (${err instanceof Error ? err.message : String(err)}) — deploying a new version.` }));
  state.procedureReuse = { reused: reuse.reusable, reason: reuse.reason };
  bundleLog(client, "procedure-reuse-check", { apiName, reusable: reuse.reusable, reason: reuse.reason });
  step(steps, "build-expression-set", "info", `→ ${reuse.reason}`);
  if (reuse.reusable) {
    expressionSetId = reuse.expressionSetId;
    expressionSetVersionId = reuse.expressionSetVersionId;
    versionStatus = "Active";
    Object.assign(state, { expressionSetId, expressionSetVersionId, versionStatus });
    for (const s of ["build-expression-set", "validate-expression-set", "deploy-pricing-procedure", "resolve-version", "activate-version"]) emit(s, "done", "Reused existing active version — no redeploy needed.");
  } else {

  /* ── Resolve the next available Expression Set Version identity before building ── */
  let nextVersionResolution: Awaited<ReturnType<typeof resolveNextAvailableExpressionSetVersion>> | null = null;
  try {
    nextVersionResolution = await resolveNextAvailableExpressionSetVersion(client, apiName);
    step(steps, "build-expression-set", "success", `✓ Version identity: ${nextVersionResolution.identity} (Version ${nextVersionResolution.versionNumber}${nextVersionResolution.rankFieldExists ? `, Rank ${nextVersionResolution.rank ?? "(none)"}` : ""}).`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`Could not resolve an unused Expression Set version identity: ${message} — proceeding without a version override.`);
  }

  let expressionSetDonorInspection: Awaited<ReturnType<typeof inspectAllExpressionSetDefinitionDonors>> | undefined;
  try {
    expressionSetDonorInspection = await inspectAllExpressionSetDefinitionDonors(client, "BundleDiscount");
    state.expressionSetDonorInspection = expressionSetDonorInspection;
  } catch (err) {
    warnings.push(`Donor inventory (diagnostic-only) failed: ${err instanceof Error ? err.message : String(err)}.`);
  }

  /* ── build-expression-set / validate-expression-set ── */
  emit("build-expression-set", "running");
  let canvas;
  try {
    canvas = await buildBundleCanvas(client, {
      procedureName: input.procedureName, apiName, description: input.description,
      versionNumber: nextVersionResolution?.versionNumber, rank: nextVersionResolution?.rank,
      scheduleId, lookupTable,
      onProgress: phase => { if (phase === "template-retrieved") emit("build-expression-set", "running", "Template retrieved — building canvas."); },
    });
  } catch (err) {
    return fail(buildFailureDiagnostics("build-expression-set", err));
  }
  const expressionSetValidation: Record<string, { status: "PASS" | "FAIL"; missing: string[]; unexpected: string[]; orderMatch: boolean }> = {};
  for (const report of canvas.stepStructureReports ?? []) {
    expressionSetValidation[report.actionType] = { status: report.structurallyValid ? "PASS" : "FAIL", missing: report.missingNodes, unexpected: report.extraNodes, orderMatch: report.orderMatches };
  }
  warnings.push(...canvas.warnings);
  Object.assign(state, {
    expressionSetValidation, bundleDiscountInputBinding: canvas.bundleDiscountInputBinding,
    bundleDiscountBranchSelection: canvas.bundleDiscountBranchSelection, lookupBinding: canvas.lookupBinding,
  });
  if (!canvas.success || !canvas.finalFileXml) {
    const reason = canvas.fatalErrors.join(" ") || "Expression Set canvas build failed for an unspecified reason.";
    return fail(buildLogicalFailure("validate-expression-set", reason, undefined, { schemaReport: canvas.schemaReport?.reportText }));
  }
  bundleLog(client, "expression-set-built", {
    apiName, donor: canvas.canvasComposition?.donorFullName, steps: canvas.observedActionTypes, lookupBinding: canvas.lookupBinding,
    inputUnitPrice: canvas.bundleDiscountInputBinding?.inputUnitPriceValue,
  });
  step(steps, "build-expression-set", "success", `✓ Built from donor ${canvas.canvasComposition?.donorFullName}: ${canvas.canvasComposition?.finalPhysicalStepCount} step(s) (${canvas.canvasComposition?.prunedRootBranchCount} unrelated root branch(es) pruned).`);
  step(steps, "validate-expression-set", "success",
    `✓ BundleDiscount bound to ${canvas.lookupBinding?.lookupTableApiName}; schedule constant ${canvas.lookupBinding?.scheduleVariable} = ${scheduleId}; ` +
    `inputs ${canvas.lookupBinding?.inputBindings.map(b => `${b.column}←${b.boundTo}`).join(", ")}; InputUnitPrice←${canvas.bundleDiscountInputBinding?.inputUnitPriceValue}.`);
  const deployPayloadFingerprint = createHash("sha256").update(canvas.finalFileXml).digest("hex");
  state.deployPayloadFingerprint = deployPayloadFingerprint;
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
    return fail(buildLogicalFailure("deploy-pricing-procedure", `This Expression Set/Version identity conflicts with an existing record in the org: ${uniqueness.conflicts.map(c => `${c.identifier} (${c.conflictingMetadataType} ${c.existingRecordId})`).join("; ")}.`));
  }

  /* ── Outbound-field verification (never deploy XML that wasn't validated) ── */
  const targetIdentity = generatedFullNames[0] ?? apiName;
  const resolvedCandidate = { fullName: targetIdentity, versionNumber: nextVersionResolution?.versionNumber ?? null, expressionSetDefinition: apiName, rank: nextVersionResolution?.rank ?? null };
  const fieldMismatches: string[] = [];
  if (canvas.outboundVersionFields?.fullName !== resolvedCandidate.fullName) fieldMismatches.push(`fullName (resolved="${resolvedCandidate.fullName}", outbound="${canvas.outboundVersionFields?.fullName ?? "(not found)"}")`);
  if (resolvedCandidate.versionNumber !== null && canvas.outboundVersionFields?.versionNumber !== String(resolvedCandidate.versionNumber)) fieldMismatches.push(`versionNumber (resolved="${resolvedCandidate.versionNumber}", outbound="${canvas.outboundVersionFields?.versionNumber ?? "(not found)"}")`);
  if (canvas.outboundVersionFields?.expressionSetDefinition !== resolvedCandidate.expressionSetDefinition) fieldMismatches.push(`expressionSetDefinition (resolved="${resolvedCandidate.expressionSetDefinition}", outbound="${canvas.outboundVersionFields?.expressionSetDefinition ?? "(not found)"}")`);
  if (resolvedCandidate.rank !== null && canvas.outboundVersionFields?.rank !== String(resolvedCandidate.rank)) fieldMismatches.push(`rank (resolved="${resolvedCandidate.rank}", outbound="${canvas.outboundVersionFields?.rank ?? "(not found)"}")`);
  if (fieldMismatches.length > 0) {
    return fail(buildLogicalFailure("deploy-pricing-procedure", `Refusing to deploy — payload verification failed before the Metadata API was called. Mismatched field(s): ${fieldMismatches.join(", ")}.`));
  }
  if (createHash("sha256").update(canvas.finalFileXml).digest("hex") !== deployPayloadFingerprint) {
    return fail(buildLogicalFailure("deploy-pricing-procedure", "Refusing to deploy — the XML about to be sent does not match the XML that was validated."));
  }

  /* ── deploy-pricing-procedure (Expression Set + Version + Pricing Procedure, one Metadata API deploy) ── */
  emit("deploy-pricing-procedure", "running");
  const deployResult = await deployExpressionSetDefinition(client, apiName, canvas.finalFileXml, canvas.donorFileName, "BundleDiscount");
  if (!deployResult.success) {
    let reason = deployResult.error ?? "Metadata deploy failed.";
    const diagnosis = diagnosePostDeployFailure(reason, uniqueness);
    if (diagnosis.isUniquenessConflict) reason = diagnosis.diagnosis;
    return fail(buildLogicalFailure("deploy-pricing-procedure", reason, undefined, {
      packagingReport: deployResult.packagingReport.reportText,
      deployComponentFailures: deployResult.status?.componentFailures, deployFullStatus: deployResult.status,
      generatedFileXml: deployResult.generatedFileXml, deployZipBase64: deployResult.deployZipBase64, rawDeployStatusXml: deployResult.rawDeployStatusXml,
    }));
  }
  const deploymentSummary = {
    success: deployResult.status?.success ?? deployResult.success,
    deploymentId: deployResult.status?.id ?? null,
    componentsDeployed: deployResult.status?.numberComponentsDeployed ?? 0,
    errors: deployResult.status?.numberComponentErrors ?? 0,
  };
  state.deploymentSummary = deploymentSummary;
  step(steps, "deploy-pricing-procedure", "success", `✓ Deployed ${deploymentSummary.componentsDeployed} component(s), ${deploymentSummary.errors} error(s) (deployment ${deploymentSummary.deploymentId}).`);
  bundleLog(client, "deployed", { apiName, ...deploymentSummary });
  emit("deploy-pricing-procedure", "done");

  componentSuccesses = deployResult.status?.componentSuccesses;

  /* ── resolve-version — the deploy only counts once the real records are readable ── */
  emit("resolve-version", "running");
  const esResolution = await resolveExpressionSetId(client, { apiName, componentSuccesses }, (attempt, found, error) => {
    step(steps, "resolve-version", "info", `→ Resolving ExpressionSet Id — attempt ${attempt}${error ? ` (query error: ${error})` : found ? " — found." : " — not found yet."}`);
  });
  expressionSetId = esResolution.verified ? (esResolution.id ?? undefined) : undefined;
  state.expressionSetId = expressionSetId;
  const esvResolution = await resolveExpressionSetVersionId(client, { expressionSetId, componentSuccesses }, (attempt, found, error) => {
    step(steps, "resolve-version", "info", `→ Resolving ExpressionSetVersion — attempt ${attempt}${error ? ` (error: ${error})` : found ? " — version(s) found." : " — no versions yet."}`);
  });
  expressionSetVersionId = esvResolution.verified ? (esvResolution.id ?? undefined) : undefined;
  state.expressionSetVersionId = expressionSetVersionId;
  const esvSelectedBy: ExpressionSetVersionResolutionAudit["selectedBy"] = esvResolution.matchPriority === "A" ? "deployment-id"
    : esvResolution.matchPriority === "B" ? "full-name"
    : esvResolution.matchPriority === "C" ? (esvResolution.candidates?.length === 1 ? "sole-version" : "version-number") : null;
  state.expressionSetVersionResolution = {
    strategy: esvResolution.strategy.startsWith("connect-rest") ? "connect-rest" : "fallback",
    metadataDeploymentComponentId: esResolution.metadataDeploymentComponentId ?? null,
    expressionSetId: expressionSetId ?? null, expressionSetVersionId: expressionSetVersionId ?? null,
    verified: esvResolution.verified, selectedBy: esvSelectedBy,
    request: { method: "GET", path: esvResolution.connectRequestPath ?? "" },
    response: esvResolution.connectResponse ?? null, method: esvResolution.method,
    selectedVersion: esvResolution.selectedVersion ?? null, candidates: esvResolution.candidates ?? [], error: esvResolution.error,
  };
  bundleLog(client, "version-resolved", { apiName, expressionSetId: expressionSetId ?? null, expressionSetVersionId: expressionSetVersionId ?? null, method: esvResolution.method });
  if (!expressionSetId || !expressionSetVersionId) {
    return fail(buildLogicalFailure("resolve-version",
      `The Metadata API reported the deploy succeeded, but Salesforce did not return ${!expressionSetId ? `an ExpressionSet for "${apiName}" (${esResolution.method})` : `an ExpressionSetVersion for ExpressionSet ${expressionSetId} (${esvResolution.method})`}. ` +
      "The procedure was not activated."), { deploymentSummary });
  }
  step(steps, "resolve-version", "success", `✓ ExpressionSet ${expressionSetId}, ExpressionSetVersion ${expressionSetVersionId}.`);
  emit("resolve-version", "done");

  if (canvas.lpLookup?.lookUpId) {
    const lpRefresh = await refreshListPriceDecisionTable(client, canvas.lpLookup.lookUpId, canvas.lpLookup.lookUpApiName);
    if (lpRefresh.warning) warnings.push(lpRefresh.warning);
  }

  /* ── activate-version ── */
  let activationDetail: Awaited<ReturnType<typeof activateExpressionSetVersion>>["detail"] | undefined;
  if (input.activate) {
    emit("activate-version", "running");
    const activation = await activateExpressionSetVersion(client, expressionSetVersionId, steps, warnings, expressionSetId);
    versionStatus = activation.status;
    activationDetail = activation.detail;
    emit("activate-version", versionStatus === "Active" ? "done" : "warning");
  }
  const activationAudit: BundlePricingActivationAudit = {
    attempted: !!input.activate, versionId: expressionSetVersionId, success: versionStatus === "Active",
    status: input.activate ? versionStatus : null, detail: activationDetail,
  };
  state.activationAudit = activationAudit;
  state.versionStatus = versionStatus;
  bundleLog(client, "activation", { expressionSetVersionId, attempted: !!input.activate, status: versionStatus });
  } // end: deploy a new version

  /* ── verify-salesforce ── */
  emit("verify-salesforce", "running");
  const verification = await verifyBundleSalesforceState(client, {
    bundleProductId: input.bundle.id, componentProductIds: input.rules.map(r => r.componentProductId),
    scheduleId, adjustmentIds: state.adjustmentIds!, lookupTable,
    expressionSetApiName: apiName, expressionSetId, expressionSetVersionId, componentSuccesses,
  }, steps);
  state.verification = verification;
  const verificationStatus = deriveVerificationStatus(verification);
  emit("verify-salesforce", verificationStatus === "verified" ? "done" : "warning");

  const lifecycleStatus: BundlePricingLifecycleStatus = {
    expressionSetDeployment: reuse.reusable || state.deploymentSummary?.success ? "success" : "failed",
    expressionSetVersionDeployment: reuse.reusable || state.deploymentSummary?.success ? "success" : "failed",
    expressionSetVersionResolution: "success",
    activation: reuse.reusable ? "success" : !input.activate ? "not_requested" : (versionStatus === "Active" ? "success" : "failed"),
    pricingProcedure: verification.pricingProcedure.verified ? "verified" : "deployed",
  };
  state.lifecycleStatus = lifecycleStatus;

  if (verificationStatus === "failed") {
    const unverified = [
      !verification.bundle && "bundle", !verification.componentsResolved && "componentsResolved", !verification.pricingRules && "lookup-table entries",
      !verification.lookupTable && "lookup-table binding", !verification.pricingElement && "BundleDiscount step", !verification.scheduleBinding && "schedule binding",
    ].filter((v): v is string => !!v);
    return fail(buildLogicalFailure("verify-salesforce", `Salesforce read-back could not confirm: ${unverified.join(", ")}.`));
  }

  const activationIssue = lifecycleStatus.activation === "failed";
  let verificationWarning: string | undefined;
  if (verificationStatus === "verified_with_warning" || activationIssue) {
    const parts: string[] = [];
    const unconfirmed = [!verification.expressionSetVersion.verified && "Expression Set Version", !verification.pricingProcedure.verified && "Pricing Procedure"].filter((v): v is string => !!v);
    if (unconfirmed.length > 0) parts.push(`Direct read-back could not confirm: ${unconfirmed.join(", ")}.`);
    if (activationIssue) parts.push(`Expression Set Version ${expressionSetVersionId} was created but could not be activated — it remains ${versionStatus}.`);
    verificationWarning = parts.join(" ");
    step(steps, "verify-salesforce", "info", `⚠ ${verificationWarning}`);
  } else {
    step(steps, "verify-salesforce", "success", "✓ Every required Salesforce component was confirmed via read-back.");
  }
  const overallStatus: CreateBundlePricingResult["status"] = verificationStatus === "verified" && !activationIssue ? "success" : "deployed_with_verification_warning";
  bundleLog(client, "pipeline-complete", { executionId, status: overallStatus, apiName, expressionSetId, expressionSetVersionId, versionStatus, lookupTableId: lookupTable.id, scheduleId });

  return {
    ...state,
    success: true, warnings, steps, status: overallStatus, verificationWarning,
    executionId, auditLog: buildSanitizedAuditLog(client.debugLog),
    procedureSnapshot: buildProcedureSnapshot({
      executionId, bundle: bundleRef, rules: input.rules, priceAdjustmentScheduleId: scheduleId, lookupTable,
      adjustmentIds: state.adjustmentIds, expressionSetId, expressionSetVersionId, expressionSetApiName: apiName, verification,
    }),
  };
}
