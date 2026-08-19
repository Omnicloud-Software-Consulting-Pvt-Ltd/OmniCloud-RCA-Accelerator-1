/**
 * Parts G-Q orchestration — the Salesforce-write pipeline for
 * Attribute-Based Pricing, run strictly sequentially (Part R: a prerequisite
 * failure stops immediately, never continuing to create dependent records).
 * Real steps, in order:
 *   0. configure-price-impacting — §Price-Impacting prerequisite: every attribute actually referenced
 *                                by `rules` must be IsPriceImpacting=true on this product before
 *                                anything else is created; a false value is corrected and read-back
 *                                verified here, never left for Salesforce to reject downstream.
 *   1. create-values          — Part G: create genuinely-missing attribute values
 *   2. create-schema          — §Schema discovery (Parts 1-5/13): resolve every real
 *                                AttributeBasedAdjRule/AttributeAdjustmentCondition/AttributeBasedAdjustment
 *                                relationship via Describe and log the discovered graph — never assumed
 *                                from object names.
 *   3. create-schedule        — Parts 9-14: PriceAdjustmentSchedule discovery/compatibility/unique-name
 *   4. create-rule            — AttributeBasedAdjRule (its Schedule lookup is set only if this org's
 *                                schema actually has one — the Schedule/Rule connection is always also
 *                                established via AttributeBasedAdjustment, which is the org-agnostic path)
 *   5. create-condition       — AttributeAdjustmentCondition
 *   6. create-adjustment      — AttributeBasedAdjustment (the real Schedule+Rule+Condition junction)
 *   7. verify-adjustment-records — Part 9 step 9: read-back re-query of every Id just created
 *   8. refresh-attribute-discount-entries — Parts 6-8: refresh Salesforce's standard "Attribute
 *                                Discount Entries" decision table if present; never creates one
 *   9. build-expression-set   — Parts J/K/M: clone+patch the donor Expression Set XML
 *                                (Pricing Element + input bindings are part of this same XML)
 *  10. validate-expression-set — local structural validation (already run inside the build)
 *  11. deploy-pricing-procedure — Parts K/L/O: org-uniqueness pre-flight + Metadata API deploy
 *                                 (this single deploy creates the ExpressionSet + Version + steps)
 *  12. activate-version       — Part P
 *  13. verify-salesforce      — Part Q: read-back verification of every component
 *
 * Never deletes an existing Salesforce record. Never creates a duplicate —
 * every create call reuses an existing record by its deterministic name
 * wherever this org's schema makes that possible.
 */
import { createHash } from "node:crypto";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import {
  createMissingValues, ensurePriceImpactingAttributes, prepareAttributeBasedAdjustmentSchema,
  resolveOrCreatePriceAdjustmentSchedule, createOrReuseAttributeBasedAdjRules,
  createAttributeAdjustmentConditions, createAttributeBasedAdjustments, verifyAdjustmentRecordsReadBack,
  verifyAttributeBasedAdjustmentConfigurations, resolveAttributeContexts, resolveAllPriceImpactingAttributeNames,
  MissingAttributeConfigurationError,
  type NativeCreationResult, type AdjustmentDecision,
} from "./nativeRecords";
import { buildAttributeCanvas } from "./canvasBuilder";
import { deployExpressionSetDefinition } from "./deploy";
import { validateExpressionSetUniquenessAgainstOrg, diagnosePostDeployFailure, resolveNextAvailableExpressionSetVersion, type OrgUniquenessResult } from "./orgUniquenessValidation";
import { activateExpressionSetVersion } from "./activation";
import { refreshListPriceDecisionTable, refreshAttributeDiscountEntries } from "./decisionTableRefresh";
import { verifySalesforceState, resolveExpressionSetId, resolveExpressionSetVersionId, buildConnectExpressionSetPath } from "./verifySalesforceState";
import { EXPRESSION_SET_METADATA_TYPE } from "./soapEnvelope";
import { inspectAllExpressionSetDefinitionDonors, resolveAttributeBasedPricingDonor, buildNoCoherentDonorDiagnostic } from "./donorInspection";
import { buildFailureDiagnostics, buildLogicalFailure } from "./errorDiagnostics";
import { buildSanitizedAuditLog } from "@/lib/salesforce/auditLog";
import type { DiscoveredAttribute, DiscoveredProduct, PricingRulePlanRow, ProcedureStepLite } from "../types";
import type {
  CreateAttributePricingResult, GeneratedProcedureSnapshot, SalesforceVerificationSummary,
  AttributePricingLifecycleStatus, ExpressionSetVersionResolutionAudit, AttributePricingActivationAudit,
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

/** `${ProcedureName}` -> a deterministic API Name — sanitized, collapsed, truncated to Salesforce's 40-char DeveloperName limit. */
function deriveApiName(procedureName: string): string {
  const sanitized = procedureName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const withLeadingLetter = /^[a-zA-Z]/.test(sanitized) ? sanitized : `Proc_${sanitized}`;
  return withLeadingLetter.slice(0, 40) || "Attribute_Based_Pricing_Procedure";
}

/** §Part 21 — a unique Id per creation attempt, e.g. "ABP-20260817-093201-7F42", threaded through
 * server logs, the returned result, and every UI surface so one Id correlates all three. */
export function generateExecutionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(16).slice(2, 6).toUpperCase().padEnd(4, "0");
  return `ABP-${datePart}-${timePart}-${suffix}`;
}

/** §Part 14/15 — builds the "Generated Pricing Procedure JSON" from whatever the pipeline actually
 * knows at the moment it's called (success or failure) — every `salesforce.*` Id is `null`/empty until
 * that stage genuinely completes, never fabricated ahead of time. */
function buildProcedureSnapshot(input: {
  executionId: string;
  product: { id: string; name: string };
  discoveredAttributes: DiscoveredAttribute[];
  rules: PricingRulePlanRow[];
  priceAdjustmentScheduleId?: string;
  ruleIds?: string[];
  conditionIds?: string[];
  adjustmentIds?: string[];
  expressionSetId?: string;
  expressionSetVersionId?: string;
  expressionSetApiName?: string;
  verification?: SalesforceVerificationSummary;
}): GeneratedProcedureSnapshot {
  return {
    executionId: input.executionId,
    pricingType: "attribute-based",
    product: { name: input.product.name, id: input.product.id },
    attributes: input.discoveredAttributes.map(a => ({ name: a.name, label: a.label, values: a.values.map(v => v.label) })),
    pricingRules: input.rules.map(r => ({ attribute: r.attributeName, value: r.value, adjustmentType: r.adjustmentType, adjustmentValue: r.adjustment })),
    salesforce: {
      priceAdjustmentScheduleId: input.priceAdjustmentScheduleId ?? null,
      attributeBasedAdjustmentRuleIds: input.ruleIds ?? [],
      attributeAdjustmentConditionIds: input.conditionIds ?? [],
      attributeBasedAdjustmentIds: input.adjustmentIds ?? [],
      expressionSetId: input.expressionSetId ?? null,
      expressionSetVersionId: input.expressionSetVersionId ?? null,
      pricingProcedureApiName: input.expressionSetApiName ?? null,
    },
    verificationStatus: input.verification ? deriveVerificationStatus(input.verification) : "pending",
  };
}

/** §Three-state model — `expressionSet`/`expressionSetVersion`/`pricingProcedure` are rich
 * `ComponentVerificationResult` objects (deploy vs. read-back are independent claims for those); the
 * other five components remain plain booleans. "verified_with_warning" only ever applies when every
 * plain-boolean component is true AND every metadata-backed component's own deploy succeeded — i.e. the
 * only thing still incomplete is direct read-back confirmation, never a real failure. */
function deriveVerificationStatus(v: SalesforceVerificationSummary): "verified" | "verified_with_warning" | "failed" {
  const coreOk = v.product && v.attributesValues && v.pricingRules && v.lookupTable && v.pricingElement;
  const esLayer = [v.expressionSet, v.expressionSetVersion, v.pricingProcedure];
  const esLayerDeployed = esLayer.every(c => c.deployed);
  // §Final Fix — `expressionSet.verified` (a raw direct-Id SOQL read-back) is deliberately NOT required
  // on its own: ExpressionSetVersion's independent resolution (deploy component Id or Connect REST) plus
  // the derived Pricing Procedure are sufficient evidence the whole Expression Set genuinely exists (a
  // Version cannot exist without its parent — see verifySalesforceState.ts's matching `pricingProcedure`
  // OR-derivation). Requiring `expressionSet.verified` too would permanently block "verified" on any org
  // where that Id isn't independently queryable as a plain ExpressionSet SObject Id, even when the
  // Version and Pricing Procedure are both genuinely confirmed.
  const esLayerVerified = v.expressionSetVersion.verified && v.pricingProcedure.verified;
  if (coreOk && esLayerVerified) return "verified";
  if (coreOk && esLayerDeployed) return "verified_with_warning";
  return "failed";
}

export interface CreatePipelineInput {
  client: SalesforceClient;
  product: DiscoveredProduct;
  discoveredAttributes: DiscoveredAttribute[];
  rules: PricingRulePlanRow[];
  excludedAttributes: string[];
  procedureName: string;
  description?: string;
  activate: boolean;
}

export async function runCreateAttributePricingPipeline(
  input: CreatePipelineInput,
  onStep?: (event: { step: string; status: "running" | "done" | "failed" | "warning"; detail?: string }) => void,
): Promise<CreateAttributePricingResult> {
  const { client } = input;
  const steps: ProcedureStepLite[] = [];
  const warnings: string[] = [];

  const executionId = generateExecutionId();
  client.logDebug("execution-trace", `Execution ID: ${executionId} — Attribute-Based Pricing creation started for product "${input.product.name}" (${input.product.id}).`);

  const emit = (name: string, status: "running" | "done" | "failed" | "warning", detail?: string) => onStep?.({ step: name, status, detail });

  function fail(result: Partial<CreateAttributePricingResult> & { failure: CreateAttributePricingResult["failure"] }): CreateAttributePricingResult {
    emit(result.failure!.step, "failed", result.failure!.reason);
    const procedureSnapshot = buildProcedureSnapshot({
      executionId,
      product: { id: input.product.id, name: input.product.name },
      discoveredAttributes: input.discoveredAttributes,
      rules: input.rules,
      priceAdjustmentScheduleId: result.priceAdjustmentScheduleId,
      ruleIds: result.ruleIds,
      conditionIds: result.conditionIds,
      adjustmentIds: result.adjustmentIds,
      expressionSetId: result.expressionSetId,
      expressionSetVersionId: result.expressionSetVersionId,
      expressionSetApiName: result.expressionSetApiName,
      verification: result.verification,
    });
    return {
      success: false, status: "failed", error: `[${executionId}] ${result.failure!.reason}`, warnings, steps,
      executionId, auditLog: buildSanitizedAuditLog(client.debugLog), procedureSnapshot,
      ...result,
    };
  }

  if (input.rules.length === 0) {
    const failure = buildLogicalFailure("create-values", "No pricing rules to create — nothing was approved for creation.");
    return fail({ failure });
  }

  const sellingModelId = await resolveSellingModelId(client, input.product.id);
  if (!sellingModelId) warnings.push("No Selling Model was found for this product — some Salesforce orgs require one for attribute-based adjustments; proceeding without it.");

  /* ── PRE-FLIGHT — every check in this block is 100% read-only (Describe + SOQL + Metadata API
   * retrieval only; never createRecord/updateRecord). If ANY check here fails, the function returns
   * immediately having mutated NOTHING in Salesforce — no Attribute Value, Schedule, Rule, Condition, or
   * Adjustment is ever created on a run that can't reach a genuinely deployable Expression Set. This
   * directly fixes the "partial creation" failure mode: schema/donor resolution used to run interleaved
   * with (and in the donor's case, far AFTER) real mutating steps, so a broken donor in the org was only
   * discovered after 20+ real Rule/Condition/Adjustment records already existed. Both checks below are
   * the same functions the rest of the pipeline already trusts (`prepareAttributeBasedAdjustmentSchema`,
   * `resolveAttributeBasedPricingDonor`) — never a separate/duplicated implementation that could disagree
   * with what actually runs later. ── */
  emit("preflight", "running");
  step(steps, "preflight", "start", "Running pre-flight validation — no Salesforce record will be created or modified until every check below passes.");

  let schema;
  try {
    step(steps, "preflight", "info", "→ Resolving Attribute-Based Pricing schema relationships.");
    schema = await prepareAttributeBasedAdjustmentSchema(client, input.product.id);
    step(steps, "preflight", "success", "✓ Attribute-Based Pricing relationship graph resolved — see server logs for the full discovered schema.");
  } catch (err) {
    const failure = buildFailureDiagnostics("preflight", err);
    step(steps, "preflight", "error", failure.reason);
    emit("preflight", "failed", failure.reason);
    return fail({ failure });
  }

  step(steps, "preflight", "info", "→ Resolving Attribute-Based Pricing Expression Set donor.");
  let preflightDonorResolution: Awaited<ReturnType<typeof resolveAttributeBasedPricingDonor>>;
  try {
    preflightDonorResolution = await resolveAttributeBasedPricingDonor(client);
  } catch (err) {
    const failure = buildFailureDiagnostics("preflight", err);
    step(steps, "preflight", "error", failure.reason);
    emit("preflight", "failed", failure.reason);
    return fail({ failure });
  }
  if (!preflightDonorResolution.selection) {
    const noDonorDiagnostic = buildNoCoherentDonorDiagnostic(preflightDonorResolution.candidatesWithAttributeDiscount);
    const lowConfidenceNote = preflightDonorResolution.lowConfidenceCandidates
      ? "\n\nNote: every eligible candidate below DID prove an AttributeDiscount->ListPrice connection, but each one's overall confidence score was still negative (dominated by unrelated shared-pricing-branch penalties), so none was trusted:\n"
        + preflightDonorResolution.lowConfidenceCandidates.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n")
      : "";
    const failure = buildLogicalFailure(
      "preflight",
      "No ExpressionSetDefinition in this org has PricingSettings, ListPrice, AND an AttributeDiscount branch proven connected to that SAME ListPrice via any recognized mechanism (<parentStep> chain, physical nesting, a matching InputUnitPrice/published-output variable binding, or declared sequence order) with sufficient confidence. " +
      "AttributeDiscount cannot be authored from a blank canvas (its legal values are org-configured), and this codebase never merges AttributeDiscount from one donor with PricingSettings/ListPrice from another, or invents a <parentStep> link, to fake a connection. Stopping BEFORE creating any Rule, Condition, or Adjustment.\n\n"
      + noDonorDiagnostic + lowConfidenceNote,
    );
    step(steps, "preflight", "error", failure.reason);
    emit("preflight", "failed", failure.reason);
    return fail({ failure });
  }
  step(steps, "preflight", "success", `✓ Expression Set donor validated: ${preflightDonorResolution.selection.fullName} (AttributeDiscount → ListPrice connection proven).`);
  step(steps, "preflight", "success", "PRE-FLIGHT PASSED — no Salesforce record has been created or modified yet; proceeding to create/reuse Attribute-Based Pricing records.");
  emit("preflight", "done", "Pre-flight validation passed.");

  // §UI continuity — the schema graph was already resolved (and logged) during PRE-FLIGHT above; this
  // is NOT a second resolution, just the pre-existing "Resolve Attribute-Based Pricing Schema" progress
  // row reporting the same already-computed `schema`, so downstream UI wired to the "create-schema" step
  // name keeps working unchanged.
  step(steps, "create-schema", "success", "Attribute-Based Pricing relationship graph resolved during pre-flight — see above.");

  /* ── Step 0: Configure Price-Impacting Attributes — must run before Create Attribute Values and
   * Create/Reuse Lookup Table (Part 7's sequencing fix); only the attributes actually referenced by
   * `rules` are checked/corrected, never every discovered attribute on the product. ── */
  const requestedAttributeNames = [...new Set(input.rules.map(r => r.attributeName))];
  emit("configure-price-impacting", "running");
  try {
    await ensurePriceImpactingAttributes(client, input.product.id, requestedAttributeNames, steps, message => emit("configure-price-impacting", "running", message));
    emit("configure-price-impacting", "done", `${requestedAttributeNames.length} attribute(s) confirmed price impacting.`);
  } catch (err) {
    const failure = buildFailureDiagnostics("configure-price-impacting", err);
    step(steps, "configure-price-impacting", "error", failure.reason);
    return fail({ failure });
  }

  /* ── Step 1: Create Attribute Values (Part G) ── */
  emit("create-values", "running");
  let createdValues, reusedValues;
  try {
    const result = await createMissingValues(client, input.product.id, input.rules, steps);
    createdValues = result.created;
    reusedValues = result.reused;
    emit("create-values", "done", `${createdValues.length} created, ${reusedValues.length} reused.`);
  } catch (err) {
    const failure = buildFailureDiagnostics("create-values", err);
    step(steps, "create-values", "error", failure.reason);
    return fail({ failure });
  }

  /* ── Step 3: Create/Reuse Price Adjustment Schedule (Parts 9-14) ── */
  emit("create-schedule", "running");
  let scheduleId: string;
  try {
    scheduleId = await resolveOrCreatePriceAdjustmentSchedule(
      client, { product: { id: input.product.id, name: input.product.name }, sellingModelId, procedureName: input.procedureName }, steps,
      message => emit("create-schedule", "running", message),
    );
    emit("create-schedule", "done", `Schedule ${scheduleId}.`);
  } catch (err) {
    const failure = buildFailureDiagnostics("create-schedule", err);
    step(steps, "create-schedule", "error", failure.reason);
    return fail({ failure, createdValues, existingValuesReused: reusedValues });
  }

  // §Root-cause fix — Salesforce's own FIELD_INTEGRITY_EXCEPTION ("Associate all price impacting
  // attributes with the relevant Attribute Adjustment Condition") requires a condition for EVERY
  // price-impacting attribute configured on the Product, not merely the ones this run's rules vary.
  // `resolveAllPriceImpactingAttributeNames` queries Salesforce directly for that complete set (never
  // inferred from the prompt); the union with the requested names is what `contexts` — and therefore
  // every downstream Rule/Condition/Adjustment/verification stage that reads it — is built from.
  const requestedAttrNames = [...new Set(input.rules.map(r => r.attributeName))];
  const allPriceImpactingAttrNames = await resolveAllPriceImpactingAttributeNames(client, input.product.id);
  const attrNames = [...new Set([...requestedAttrNames, ...allPriceImpactingAttrNames])];
  if (allPriceImpactingAttrNames.length > 0) {
    const extra = allPriceImpactingAttrNames.filter(n => !requestedAttrNames.includes(n));
    step(
      steps, "create-condition", "info",
      extra.length > 0
        ? `This product has ${allPriceImpactingAttrNames.length} price-impacting attribute(s) total; ${extra.length} beyond this request's own (${extra.join(", ")}) will also get a baseline condition on every rule, per Salesforce's own requirement.`
        : `This request's ${requestedAttrNames.length} attribute(s) already cover all ${allPriceImpactingAttrNames.length} price-impacting attribute(s) configured on this product.`,
    );
  }
  const contexts = await resolveAttributeContexts(client, input.product.id, attrNames);

  /* ── Step 4: Create/Reuse AttributeBasedAdjRule ── */
  emit("create-rule", "running");
  let rulePlans;
  try {
    const result = await createOrReuseAttributeBasedAdjRules(
      client, schema, { product: { id: input.product.id, name: input.product.name }, sellingModelId, rules: input.rules }, contexts, scheduleId, steps,
      message => emit("create-rule", "running", message),
    );
    rulePlans = result.plans;
    emit("create-rule", "done", `${result.ruleIds.length} rule(s).`);
  } catch (err) {
    const failure = buildFailureDiagnostics("create-rule", err);
    step(steps, "create-rule", "error", failure.reason);
    return fail({ failure, createdValues, existingValuesReused: reusedValues, priceAdjustmentScheduleId: scheduleId });
  }

  /* ── Step 5: Create/Reuse AttributeAdjustmentCondition — idempotent (Part 6/7): every create is
   * preceded by a preflight against the org's real (Product+AttributeDefinition+Rule) uniqueness key.
   * Only the attribute each rule's own pricing definition is about gets a condition — never every
   * discovered/price-impacting attribute on the product (Parts 1-5/9). ── */
  emit("create-condition", "running");
  let conditionCreated = 0;
  let conditionReused = 0;
  try {
    const result = await createAttributeAdjustmentConditions(
      client, schema, { product: { id: input.product.id, name: input.product.name } }, contexts, rulePlans, steps,
      message => emit("create-condition", "running", message),
    );
    conditionCreated = result.conditionIds.length;
    conditionReused = result.reusedConditionIds.length;
    emit("create-condition", "done", `${conditionCreated} condition(s) created, ${conditionReused} reused.`);
  } catch (err) {
    // §Follow-on 42 — the specific "missing base attribute configuration" failure gets a structured
    // diagnostic (real candidate values + the full resolved/unresolved checklist) instead of the
    // generic exception-message path, so the UI can offer an actual remediation flow.
    const failure = err instanceof MissingAttributeConfigurationError
      ? buildLogicalFailure("create-condition", err.message, undefined, {
          missingAttributeConfig: err.missingAttributes, resolvedAttributeConfig: err.resolvedAttributes,
        })
      : buildFailureDiagnostics("create-condition", err);
    step(steps, "create-condition", "error", failure.reason);
    return fail({
      failure, createdValues, existingValuesReused: reusedValues,
      priceAdjustmentScheduleId: scheduleId, ruleIds: rulePlans.map(p => p.ruleId),
      conditionIds: rulePlans.flatMap(p => p.conditionIds),
    });
  }

  /* ── Step 6: Create/Reuse AttributeBasedAdjustment (the real Schedule+Rule+Condition junction) —
   * idempotent (Issue 3): every create is preceded by a preflight match against the org's actual
   * uniqueness key, so a retry after a partial failure reuses whatever already exists instead of
   * duplicating it. ── */
  emit("create-adjustment", "running");
  let adjustmentIds: string[];
  let reusedAdjustmentIds: string[];
  let adjustmentDecisions: AdjustmentDecision[];
  try {
    const result = await createAttributeBasedAdjustments(
      client, schema, { product: { id: input.product.id, name: input.product.name }, sellingModelId }, contexts, scheduleId, rulePlans, steps,
      message => emit("create-adjustment", "running", message),
    );
    adjustmentIds = result.adjustmentIds;
    reusedAdjustmentIds = result.reusedAdjustmentIds;
    adjustmentDecisions = result.decisions;
    const detail = adjustmentIds.length > 0 && reusedAdjustmentIds.length > 0
      ? `${adjustmentIds.length} adjustment(s) created, ${reusedAdjustmentIds.length} existing adjustment(s) reused.`
      : adjustmentIds.length > 0
        ? `${adjustmentIds.length} adjustment(s) created.`
        : `${reusedAdjustmentIds.length} existing adjustment(s) reused.`;
    emit("create-adjustment", "done", detail);
  } catch (err) {
    const failure = buildFailureDiagnostics("create-adjustment", err);
    step(steps, "create-adjustment", "error", failure.reason);
    return fail({
      failure, createdValues, existingValuesReused: reusedValues,
      priceAdjustmentScheduleId: scheduleId, ruleIds: rulePlans.map(p => p.ruleId),
      conditionIds: rulePlans.flatMap(p => p.conditionIds),
    });
  }

  const native: NativeCreationResult = {
    scheduleId,
    ruleIds: rulePlans.map(p => p.ruleId),
    conditionIds: rulePlans.flatMap(p => p.conditionIds),
    adjustmentIds: [...adjustmentIds, ...reusedAdjustmentIds],
  };

  /* ── Step 7: Verify Adjustment Records (Part 9 step 9 + Parts 12/13/19) — read-back re-query before
   * anything downstream (the Expression Set) depends on these Ids. A unique-Id COUNT is not sufficient
   * on its own (that's exactly what let 5 unrelated configurations silently share one Adjustment Id) —
   * every requested configuration is independently re-verified: its own expected condition signature,
   * its actual Adjustment's Product/SellingModel/Schedule, and its actual reconstructed condition
   * signature must all agree before that ONE configuration counts as verified. ── */
  emit("verify-adjustment-records", "running");
  const adjustmentVerification = await verifyAdjustmentRecordsReadBack(client, native);
  const adjustmentIdByRuleId = new Map(adjustmentDecisions.map(d => [d.ruleId, d.adjustmentId]));
  const configVerification = await verifyAttributeBasedAdjustmentConfigurations(
    client, schema, contexts, { productId: input.product.id, sellingModelId, scheduleId }, rulePlans, adjustmentIdByRuleId,
  );
  for (const entry of configVerification.entries) {
    step(
      steps, "verify-adjustment-records", entry.verified ? "success" : "error",
      entry.verified
        ? `✓ ${entry.attributeLabel} = ${entry.valueLabel} → verified (Adjustment ${entry.adjustmentId}).`
        : `✕ ${entry.attributeLabel} = ${entry.valueLabel} — ${entry.reason ?? "verification failed"}.`,
    );
  }
  const verifiedCount = configVerification.entries.filter(e => e.verified).length;
  client.logDebug("execution-trace", [
    "Attribute-Based Adjustment Verification",
    ...configVerification.entries.map(e => `${e.verified ? "✓" : "✕"} ${e.attributeLabel} = ${e.valueLabel} → ${e.verified ? "verified" : `FAILED (${e.reason})`}`),
    `${verifiedCount}/${configVerification.entries.length} configurations logically verified.`,
  ].join("\n"));

  const adjustmentVerified = adjustmentVerification.scheduleVerified
    && adjustmentVerification.ruleCount === native.ruleIds.length
    && adjustmentVerification.conditionCount === native.conditionIds.length
    && configVerification.allVerified;
  if (!adjustmentVerified) {
    const failure = buildLogicalFailure(
      "verify-adjustment-records",
      `Salesforce read-back could not confirm every Attribute-Based Pricing configuration: schedule verified=${adjustmentVerification.scheduleVerified}, ` +
      `rules ${adjustmentVerification.ruleCount}/${native.ruleIds.length}, conditions ${adjustmentVerification.conditionCount}/${native.conditionIds.length}, ` +
      `adjustment configurations ${verifiedCount}/${configVerification.entries.length} logically verified. ` +
      `Failed: ${configVerification.entries.filter(e => !e.verified).map(e => `${e.attributeLabel}=${e.valueLabel} (${e.reason})`).join("; ") || "none"}.`,
    );
    step(steps, "verify-adjustment-records", "error", failure.reason);
    return fail({
      failure, createdValues, existingValuesReused: reusedValues,
      priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds,
      adjustmentDecisions,
    });
  }
  step(steps, "verify-adjustment-records", "success", "All Attribute-Based Pricing records and configurations confirmed via Salesforce read-back.");
  emit("verify-adjustment-records", "done", `Schedule + ${native.ruleIds.length} rule(s) + ${native.conditionIds.length} condition(s) + ${verifiedCount}/${configVerification.entries.length} adjustment configuration(s) verified.`);

  /* ── Step 8: Refresh/resolve Attribute Discount Entries (Parts 6-8) — never creates one; a missing
   * standard table is a warning, never a reason to fail the run. ── */
  emit("refresh-attribute-discount-entries", "running");
  const discountEntries = await refreshAttributeDiscountEntries(client);
  if (discountEntries.warning) warnings.push(discountEntries.warning);
  step(
    steps, "refresh-attribute-discount-entries", discountEntries.refreshed ? "success" : "info",
    discountEntries.refreshed ? `Refreshed "${discountEntries.masterLabel ?? discountEntries.developerName}".` : (discountEntries.warning ?? "Not refreshed."),
  );
  emit(
    "refresh-attribute-discount-entries", discountEntries.refreshed ? "done" : "warning",
    discountEntries.refreshed ? `Refreshed "${discountEntries.masterLabel ?? discountEntries.developerName}".` : discountEntries.warning,
  );

  const apiName = deriveApiName(input.procedureName);

  /* ── §Section 3 — ONE authoritative ExpressionSetVersion inventory query, re-fetched and
   * recalculated (never blindly incremented) whenever a computed candidate turns out to already exist —
   * the exact live bug this replaces: an earlier read that appeared to contain only V1 turned out to be
   * stale/incomplete the moment a SEPARATE query (the post-build collision check) looked again and found
   * V2. Resolving the version BEFORE canvas build so the generated identity (fullName suffix /
   * <versionNumber>) targets a candidate already proven, moments earlier, to be unused. Read-only. ── */
  step(steps, "build-expression-set", "info", "→ Resolving existing Expression Set versions.");
  let nextVersionResolution: Awaited<ReturnType<typeof resolveNextAvailableExpressionSetVersion>> | null = null;
  try {
    step(steps, "build-expression-set", "info", "→ Querying authoritative ExpressionSetVersion inventory.");
    nextVersionResolution = await resolveNextAvailableExpressionSetVersion(client, apiName);
    for (const a of nextVersionResolution.attempts) {
      if (a.inventory.existingExpressionSetId) {
        step(steps, "build-expression-set", "success", `✓ Existing ExpressionSet found: ${a.inventory.existingExpressionSetIdentity ?? apiName} (${a.inventory.existingExpressionSetId}).`);
        step(
          steps, "build-expression-set", "success",
          a.inventory.versions.length > 0
            ? `→ Existing versions discovered: ${a.inventory.versions.map(v => `V${v.versionNumber ?? "?"} (Id=${v.id}${v.isActive === true ? ", Active" : v.isActive === false ? ", Draft" : ""})`).join(", ")}.`
            : "→ Existing versions discovered: (none under this ExpressionSet).",
        );
      } else {
        step(steps, "build-expression-set", "success", `✓ No existing ExpressionSet found for "${apiName}".`);
      }
      const highest = a.inventory.versions.map(v => v.versionNumber).filter((n): n is number => n !== null);
      step(steps, "build-expression-set", "success", `→ Highest existing version: ${highest.length > 0 ? Math.max(...highest) : "(none)"}.`);
      step(steps, "build-expression-set", "success", `→ Candidate next version: ${a.candidateVersionNumber}.`);
      step(steps, "build-expression-set", "info", `→ Candidate identity: ${a.candidateIdentity}.`);
      /* ── Part 1/12 — Rank inventory + resolution, logged in the exact requested sequence. Rank is a
       * SEPARATE Salesforce uniqueness constraint from version identity (fullName/ApiName) — a version
       * can have a perfectly unused identity and still be rejected at deploy time if its Rank collides
       * with an existing version's own Rank ("Assign a unique rank to expression set version ... and try
       * again."), which is the exact failure this resolves BEFORE deployment, from real org data. ── */
      step(steps, "build-expression-set", "info", "→ Resolving ExpressionSetVersion Rank.");
      if (!a.inventory.rankFieldExists) {
        step(steps, "build-expression-set", "info", "ℹ This org's ExpressionSetVersion schema has no Rank field — skipping Rank resolution (never invented).");
      } else {
        step(
          steps, "build-expression-set", "success",
          `✓ Existing ranks for this ExpressionSet: [${a.inventory.versions.map(v => v.rank).filter((n): n is number => n !== null).join(", ") || "(none)"}].`,
        );
        // §Part 1 — org-wide, independently-verified rank collisions found THIS attempt (never scoped
        // to just this ExpressionSet) — direct, logged evidence for whether Salesforce enforces Rank
        // uniqueness per-ExpressionSet only or across the whole org, instead of assuming either.
        if (a.orgWideRankCollisions.length > 0) {
          for (const c of a.orgWideRankCollisions) {
            step(
              steps, "build-expression-set", "info",
              `⚠ Rank ${c.rank} is already used by an existing ExpressionSetVersion ${c.existingRecordId} (ExpressionSetId=${c.existingExpressionSetId ?? "(unknown)"}) — this proves Rank uniqueness is NOT scoped to only this ExpressionSet on this org. Excluding it and recalculating.`,
            );
          }
        } else {
          step(steps, "build-expression-set", "success", "✓ No other ExpressionSetVersion anywhere in the org already uses the initial candidate rank (independently verified, not just checked within this ExpressionSet).");
        }
        step(steps, "build-expression-set", "success", `✓ Candidate Rank: ${a.candidateRank ?? "(none)"}.`);
        step(steps, "build-expression-set", "success", "✓ Candidate Rank is unused (verified both within this ExpressionSet and org-wide).");
      }
      step(steps, "build-expression-set", "info", "→ Validating candidate against authoritative inventory.");
      if (!a.collidesWith) {
        step(steps, "build-expression-set", "success", "✓ Candidate identity is unused.");
      } else {
        step(
          steps, "build-expression-set", "info",
          `⚠ Candidate identity already exists — ExpressionSetVersion ${a.collidesWith.id} (ApiName=${a.collidesWith.apiName ?? "(n/a)"}, VersionNumber=${a.collidesWith.versionNumber ?? "(n/a)"}, IsActive=${a.collidesWith.isActive ?? "(n/a)"}). This is exactly Case E — the inventory just queried did not yet reflect this record when the candidate was first computed. Refusing to reuse/update/deactivate it.`,
        );
        step(steps, "build-expression-set", "info", "→ Refreshing ExpressionSetVersion inventory.");
        step(steps, "build-expression-set", "info", "→ Recalculating next version.");
      }
    }
    step(steps, "build-expression-set", "success", `✓ Final candidate identity (proven unused as of the last inventory read): ${nextVersionResolution.identity} (Version ${nextVersionResolution.versionNumber}).`);
    if (nextVersionResolution.rankFieldExists) {
      step(steps, "build-expression-set", "success", `✓ Final resolved Rank: ${nextVersionResolution.rank ?? "(none)"}.`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`Could not resolve an unused Expression Set version identity: ${message} — proceeding without a version override; a repeated build may target the same version as before.`);
    step(steps, "build-expression-set", "info", `ℹ Version lifecycle resolution failed (${message}) — proceeding without a version override.`);
  }

  /* ── §Phase 2 — evidence-only ExpressionSetDefinition donor inventory. Purely diagnostic: never
   * selects a different donor, never deploys, never affects `canvas` below in any way —
   * `buildAttributeCanvas()` runs its own, separately-evidenced donor selection
   * (`resolveAttributeBasedPricingDonor()`) independently of whatever this inspection reports. Wrapped so a
   * failure here can never block or fail the real pipeline — it only ever downgrades to a warning. ── */
  let expressionSetDonorInspection: Awaited<ReturnType<typeof inspectAllExpressionSetDefinitionDonors>> | undefined;
  try {
    step(steps, "inspect-expression-set-donors", "info", "→ Discovering all ExpressionSetDefinition donors.");
    expressionSetDonorInspection = await inspectAllExpressionSetDefinitionDonors(client, "AttributeDiscount");
    for (const c of expressionSetDonorInspection.candidates) {
      step(
        steps, "inspect-expression-set-donors", "success",
        `✓ ExpressionSetDefinition found\n` +
        `  fullName: ${c.fullName}\n` +
        `  label: ${c.label}\n` +
        `  type: ${c.type}\n` +
        `  template: ${c.template}\n` +
        `  processType: ${c.processType}\n` +
        `  usageSubType: ${c.usageSubType}\n` +
        `  physicalSteps: ${c.physicalStepCount}\n` +
        `  AttributeDiscountOccurrences: ${c.attributeDiscountOccurrences}\n` +
        `  PricingSettingsOccurrences: ${c.pricingSettingsOccurrences}\n` +
        `  ListPriceOccurrences: ${c.listPriceOccurrences}\n` +
        `  actionTypes: [${c.uniqueActionTypes.join(", ")}]\n` +
        `  rootBranches: [${c.rootBranches.map(r => r.name ?? r.actionType ?? "(unnamed)").join(", ")}]\n` +
        `  classification: ${c.classification} (${c.classificationReasons.join(" ")})`,
      );
      for (const b of c.attributeDiscountBranches) {
        step(
          steps, "inspect-expression-set-donors", "info",
          `→ AttributeDiscount occurrence [${b.occurrenceIndex}] in "${c.fullName}"\n` +
          `  parentStep: ${b.parentStep ?? "(none)"}\n` +
          `  path: ${b.pathLabel}\n` +
          `  parentStepChainAncestors: ${b.parentStepChainAncestors.join(" -> ") || "(none)"} (${b.parentStepChainNote})\n` +
          `  physicalContainerAncestors: ${b.physicalContainerAncestors.join(" -> ") || "(none)"}\n` +
          `  InputUnitPrice: ${b.bindings.inputUnitPrice ?? "(none)"}\n` +
          `  PAS binding: ${b.bindings.priceAdjustmentScheduleBinding ?? "(none)"}\n` +
          `  AttributeName: ${b.bindings.attributeName ?? "(none)"}\n` +
          `  AttributeValue: ${b.bindings.attributeValue ?? "(none)"}\n` +
          `  IsPriceImpacting: ${b.bindings.isPriceImpacting ?? "(none)"}\n` +
          `  publishedOutputs: [${b.bindings.publishedOutputs.join(", ")}]\n` +
          `  connectedToListPrice: ${b.connectedToListPrice}\n` +
          `  connectedToPricingSettings: ${b.connectedToPricingSettings}`,
        );
      }
    }
    step(
      steps, "inspect-expression-set-donors", "success",
      `→ ExpressionSetDefinition donor inventory complete\n` +
      `Total donors: ${expressionSetDonorInspection.totalCandidates}\n` +
      `First file containing this action type (diagnostic inventory only — NOT the real build's selection; see "Selected donor" under build-expression-set below for what was actually used): ${expressionSetDonorInspection.firstFileContainingActionType ?? "(none found)"}\n` +
      `Candidate ranking:\n${expressionSetDonorInspection.ranking.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n") || "(no candidates with an AttributeDiscount occurrence)"}`,
    );
    if (expressionSetDonorInspection.retrievalWarning) {
      warnings.push(`Donor inventory retrieval warning: ${expressionSetDonorInspection.retrievalWarning}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    step(steps, "inspect-expression-set-donors", "error", `✕ Donor inventory could not be completed: ${message}`);
    warnings.push(`Donor inventory (diagnostic-only) failed: ${message} — this does not affect the actual build below.`);
  }

  /* ── Step 9/10: Build + locally validate the Expression Set (Parts J/K/M) — donor-first: clone a
   * real, already-deployed Expression Set and patch only what Attribute-Based Pricing requires, never
   * author steps from scratch. The structural validator (compareStepStructure) independently confirms
   * the generated ListPrice/AttributeDiscount steps still have the donor's exact child-element set and
   * order — never weakened or bypassed, per the explicit instruction that produced this stage's fix. ── */
  step(steps, "build-expression-set", "info", "→ Retrieving donor Expression Set.");
  emit("build-expression-set", "running");
  let canvas;
  try {
    canvas = await buildAttributeCanvas(client, {
      procedureName: input.procedureName,
      apiName,
      description: input.description,
      versionNumber: nextVersionResolution?.versionNumber,
      rank: nextVersionResolution?.rank,
      onProgress: phase => {
        if (phase === "template-retrieved") {
          step(steps, "build-expression-set", "success", "✓ Donor Expression Set found.");
          step(steps, "build-expression-set", "info", "→ Cloning donor Expression Set and applying Attribute-Based Pricing modifications.");
          emit("build-expression-set", "running", "Template retrieved — building canvas.");
        }
      },
    });
  } catch (err) {
    const failure = buildFailureDiagnostics("build-expression-set", err);
    step(steps, "build-expression-set", "error", failure.reason);
    return fail({ failure, createdValues, existingValuesReused: reusedValues, priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds, expressionSetDonorInspection });
  }

  // §JSON audit — the structured per-step structural comparison (Step/Missing/Unexpected/Order/Result),
  // built regardless of success/failure so a failed run's audit still shows exactly what diverged.
  const expressionSetValidation: Record<string, { status: "PASS" | "FAIL"; missing: string[]; unexpected: string[]; orderMatch: boolean }> = {};
  for (const report of canvas.stepStructureReports ?? []) {
    expressionSetValidation[report.actionType] = {
      status: report.structurallyValid ? "PASS" : "FAIL",
      missing: report.missingNodes,
      unexpected: report.extraNodes,
      orderMatch: report.orderMatches,
    };
  }

  // §Root-cause fix — a SINGLE coherent donor now supplies PricingSettings, ListPrice, AND
  // AttributeDiscount together (never two unrelated donors stitched together with an invented
  // <parentStep> link). `canvas.canvasComposition` names that one donor and how many of its OTHER root
  // pricing branches (FormulaBasedPricing/ManualDiscount/etc.) were pruned away to reach the final canvas;
  // `canvas.attributeDiscountBranchSelection` describes discovery WITHIN that SAME donor's graph.
  const composition = canvas.canvasComposition;
  step(steps, "build-expression-set", "info", "→ Resolving Attribute-Based Pricing Expression Set donor.");
  if (composition) {
    step(steps, "build-expression-set", "success", `✓ Selected donor: ${composition.donorFullName}.`);
    step(steps, "build-expression-set", "success", `✓ Donor steps: PricingSettings, ListPrice, AttributeDiscount (${composition.donorPhysicalStepCount} physical step(s) originally; ${composition.prunedRootBranchCount} unrelated root branch(es) pruned away).`);
  }
  step(steps, "build-expression-set", "info", "→ Selecting AttributeDiscount branch.");
  if (canvas.attributeDiscountBranchSelection) {
    const a = canvas.attributeDiscountBranchSelection;
    step(steps, "build-expression-set", "success", `✓ AttributeDiscount source: ${composition?.donorFileName ?? "(selected donor)"} — the SAME donor PricingSettings/ListPrice were sourced from.`);
    step(steps, "build-expression-set", "success", `✓ ${a.candidates.length} ListPrice-connected AttributeDiscount branch(es) discovered in that donor (occurrence indexes below are physical positions within the selected donor's own graph).`);
    if (a.candidates.length > 1) {
      for (const c of a.candidates) {
        step(
          steps, "build-expression-set", "info",
          `→ Inspecting branch [${c.occurrenceIndex}]\n  Parent: ${c.parentStepName ?? "(none)"}\n  Contract Enabled: ${c.isContractEnabled === null ? "(not present)" : c.isContractEnabled}\n  PAS Binding: ${c.priceAdjustmentScheduleBinding ?? "(none)"}\n  Effective Date Binding: ${c.effectiveFromBinding ?? "(none)"}\n  Branch Type: ${c.branchType}\n  Score: ${c.score} — ${c.reasons.join("; ") || "(no signals)"}`,
        );
      }
    }
    if (a.selectedOccurrenceIndex !== null) {
      const selected = a.candidates.find(c => c.occurrenceIndex === a.selectedOccurrenceIndex);
      step(steps, "build-expression-set", "success", `✓ Selected branch: occurrence [${a.selectedOccurrenceIndex}].`);
      step(steps, "build-expression-set", "success", `✓ Branch type: ${selected?.branchType ?? "(unknown)"} (parentStep in the shared donor = ${selected?.parentStepName ?? "(none)"}; ${a.selectionReason}).`);
    } else {
      step(steps, "build-expression-set", "error", `✕ ${a.selectionReason}`);
    }
  }

  if (!canvas.success || !canvas.finalFileXml) {
    const reason = canvas.fatalErrors.join(" ") || "Expression Set canvas build failed for an unspecified reason.";
    const failure = buildLogicalFailure("validate-expression-set", reason, undefined, { schemaReport: canvas.schemaReport });
    step(steps, "build-expression-set", "error", "✕ Expression Set composition/validation failed.");
    if (canvas.listPriceOutputValidation) {
      step(steps, "build-expression-set", "error", `✕ ListPrice outputs: [${canvas.listPriceOutputValidation.donorOutputs.join(", ") || "none"}].`);
    }
    if (canvas.attributeDiscountInputBinding) {
      step(steps, "build-expression-set", "error", `✕ AttributeDiscount.InputUnitPrice: ${canvas.attributeDiscountInputBinding.inputUnitPriceValue ?? canvas.attributeDiscountInputBinding.originalInputUnitPriceValue ?? "(none)"} — ${canvas.attributeDiscountInputBinding.valid ? "valid" : "does not resolve to a real ListPrice output"}.`);
    }
    for (const report of canvas.stepStructureReports ?? []) {
      if (!report.structurallyValid) {
        step(
          steps, "build-expression-set", "error",
          `Step: ${report.actionType} — Missing: ${report.missingNodes.join(", ") || "none"}. Expected: [${report.expectedChildOrder.join(", ")}]. Generated: [${report.generatedChildOrder.join(", ")}].`,
        );
      }
    }
    const invalidParentStepEntries = (canvas.parentStepValidation ?? []).filter(e => !e.valid);
    if (invalidParentStepEntries.length > 0) {
      step(
        steps, "build-expression-set", "error",
        `✕ ${invalidParentStepEntries.length} of ${canvas.parentStepValidation?.length ?? 0} parentStep reference(s) in the FINAL composed graph do not resolve.`,
      );
      for (const entry of invalidParentStepEntries) {
        step(
          steps, "build-expression-set", "error",
          `Step: [${entry.occurrenceIndex}] ${entry.actionType} (name="${entry.stepName ?? "(none)"}") | parentStep: "${entry.parentStep ?? "(none)"}" — does not resolve to any step in the final composed XML.`,
        );
      }
    }
    warnings.push(...canvas.warnings);
    return fail({
      failure, warnings,
      createdValues, existingValuesReused: reusedValues,
      priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds,
      expressionSetValidation, parentStepValidation: canvas.parentStepValidation, duplicateStepNames: canvas.duplicateStepNames,
      listPriceOutputValidation: canvas.listPriceOutputValidation, attributeDiscountInputBinding: canvas.attributeDiscountInputBinding,
      hierarchyComparison: canvas.hierarchyComparison, donorExtractionDeterministic: canvas.donorExtractionDeterministic,
      attributeDiscountBranchSelection: canvas.attributeDiscountBranchSelection, expressionSetDonorInspection,
    });
  }
  warnings.push(...canvas.warnings);
  // §Root-cause fix — a warning explaining WHY <rank> was never embedded (this org's deploy API version
  // predates v62.0) previously only ever reached the pipeline's side-channel `warnings` array, never a
  // visible Execution Log line — meaning every prior run silently hit this exact gate without it ever
  // being surfaced anywhere the user was actually looking. Promoted to a loud, explicit step so this
  // class of misconfiguration can never again go unnoticed this way.
  for (const w of canvas.warnings) {
    if (/predates Rank's introduction/i.test(w)) {
      step(steps, "build-expression-set", "error", `✕ ${w}`);
    }
  }

  // §Composition + final-graph semantic validation — all already ran and passed inside
  // `buildAttributeCanvas()` (canvas.success being true here means every check below is genuinely true,
  // never assumed); this narrates the SAME composition report in the exact sequence requested, parsed
  // independently from the FINAL composed XML, never compared against either source donor's own layout.
  step(steps, "build-expression-set", "info", "→ Composing Attribute-Based Pricing Expression Set.");
  step(steps, "build-expression-set", "success", "✓ PricingSettings added.");
  step(steps, "build-expression-set", "success", "✓ ListPrice added.");
  step(steps, "build-expression-set", "success", "✓ AttributeDiscount added.");

  step(steps, "build-expression-set", "info", "→ Resolving AttributeDiscount price input.");
  if (canvas.listPriceOutputValidation) {
    step(steps, "build-expression-set", "success", `✓ ListPrice outputs: [${canvas.listPriceOutputValidation.donorOutputs.join(", ")}].`);
  }
  if (canvas.attributeDiscountInputBinding) {
    step(steps, "build-expression-set", "success", `✓ Selected price output: ${canvas.attributeDiscountInputBinding.inputUnitPriceValue}.`);
    step(steps, "build-expression-set", "success", `✓ AttributeDiscount.InputUnitPrice: ${canvas.attributeDiscountInputBinding.inputUnitPriceValue}.`);
  }

  step(steps, "build-expression-set", "info", "→ Validating final Expression Set.");
  for (const report of canvas.stepStructureReports ?? []) {
    step(
      steps, "build-expression-set", report.structurallyValid ? "success" : "error",
      `${report.structurallyValid ? "✓" : "✕"} Exactly one ${report.actionType}, structurally valid.`,
    );
  }
  const composedInvalidEntries = (canvas.parentStepValidation ?? []).filter(e => !e.valid);
  step(
    steps, "build-expression-set", composedInvalidEntries.length === 0 ? "success" : "error",
    composedInvalidEntries.length === 0
      ? `✓ All parentStep references resolve (${canvas.parentStepValidation?.length ?? 0} physical step(s) checked in the final composed graph).`
      : `✕ ${composedInvalidEntries.length} parentStep reference(s) do not resolve.`,
  );
  const attributeDiscountEntry = (canvas.parentStepValidation ?? []).find(e => e.actionType === "AttributeDiscount");
  if (attributeDiscountEntry) {
    step(
      steps, "build-expression-set", attributeDiscountEntry.valid ? "success" : "error",
      `${attributeDiscountEntry.valid ? "✓" : "✕"} AttributeDiscount parentStep ("${attributeDiscountEntry.parentStep ?? "(none)"}") resolves to the final ListPrice step.`,
    );
  }
  if (canvas.attributeDiscountInputBinding) {
    step(
      steps, "build-expression-set", canvas.attributeDiscountInputBinding.valid ? "success" : "error",
      `${canvas.attributeDiscountInputBinding.valid ? "✓" : "✕"} InputUnitPrice resolves to ListPrice.${canvas.attributeDiscountInputBinding.inputUnitPriceValue ?? "(none)"}.`,
    );
  }
  step(steps, "build-expression-set", "success", "✓ No unrelated pricing action types.");
  step(steps, "build-expression-set", "success", "✓ Final XML round-trip successful.");
  step(steps, "build-expression-set", "success", `✓ Duplicate step names (informational only${(canvas.duplicateStepNames?.length ?? 0) > 0 ? `: ${canvas.duplicateStepNames!.join(", ")}` : ": none"}).`);
  step(steps, "validate-expression-set", "success", "Structural validation passed against the composed final canvas.");

  // §Gate C (Part 18/14) — final payload reparse already ran inside canvasBuilder.ts against the exact
  // COMPOSED `canvas.finalFileXml` bytes, locating AttributeDiscount by actionType in the FINAL reparsed
  // graph — never by comparing occurrence index against the source shared donor's own numbering (that
  // was the confirmed bug: the final composed canvas has its own, unrelated occurrence identity).
  // canvas.success being true here means every line below is genuinely true, never assumed.
  step(steps, "build-expression-set", "info", "→ Re-parsing final serialized Expression Set.");
  step(steps, "build-expression-set", "success", `✓ Final canvas contains exactly ${canvas.canvasComposition?.finalPhysicalStepCount ?? "?"} pricing step(s).`);
  step(steps, "build-expression-set", "success", "✓ Final PricingSettings found.");
  step(steps, "build-expression-set", "success", "✓ Final ListPrice found.");
  step(steps, "build-expression-set", "success", "✓ Final AttributeDiscount found.");
  step(steps, "build-expression-set", "success", `✓ Final AttributeDiscount.InputUnitPrice = ${canvas.attributeDiscountInputBinding?.inputUnitPriceValue ?? "(none)"}.`);
  step(steps, "build-expression-set", "success", "✓ Final AttributeDiscount parentStep resolves.");
  step(steps, "build-expression-set", "success", "✓ No unrelated pricing branches remain.");
  step(steps, "build-expression-set", "success", "✓ Final serialized Expression Set passed composition validation.");
  step(steps, "build-expression-set", "info", "→ Serializing final Expression Set XML.");
  const deployPayloadFingerprint = createHash("sha256").update(canvas.finalFileXml).digest("hex");
  step(steps, "build-expression-set", "success", `✓ XML serialized (sha256 ${deployPayloadFingerprint}, ${canvas.finalFileXml.length} bytes).`);
  step(steps, "build-expression-set", "info", "→ Validating FINAL deployment payload.");
  step(steps, "build-expression-set", "success", "✓ Deployment payload matches validated XML.");
  step(steps, "build-expression-set", "success", "→ Expression Set ready for deployment.");
  emit("build-expression-set", "done");
  emit("validate-expression-set", "done");

  /* ── Pre-flight org-uniqueness check (guards Step 5) ── */
  // §Root cause of the false V1/V2 collision — `expressionSetDefinition` is the VERSION's reference back
  // to its PARENT ExpressionSetDefinition (regenerated as plain `ctx.apiName`, deliberately WITHOUT any
  // version suffix — it must stay the SAME across every version, by design). It is NOT a per-version
  // identity. Including it here meant the collision search always ALSO searched for the bare,
  // unsuffixed apiName — and V1 (created before the fullName-suffix fix) genuinely has that exact bare
  // apiName as its own real identity, so it "matched" every single time regardless of which version was
  // actually being generated, reporting a collision with V1 even while generating V2. Only `fullName`
  // (the actual, version-suffixed per-version identity) is a valid signal for THIS check.
  const generatedFullNames = (canvas.generatedIdentifiers ?? [])
    .filter(g => g.tag === "fullName")
    .map(g => g.value);
  const generatedLabel = (canvas.generatedIdentifiers ?? []).find(g => g.tag === "label")?.value ?? null;
  const targetIdentity = (canvas.generatedIdentifiers ?? []).find(g => g.tag === "fullName")?.value ?? apiName;
  step(steps, "build-expression-set", "info", "→ Generating new Expression Set identity.");
  step(steps, "build-expression-set", "success", `✓ Target identity: ${targetIdentity}.`);
  step(steps, "build-expression-set", "info", "→ Validating deployment identity.");
  let uniqueness: OrgUniquenessResult | null = null;
  try {
    uniqueness = await validateExpressionSetUniquenessAgainstOrg(client, { apiName, generatedFullNames, generatedLabel });
    const activeCollision = uniqueness.conflicts.some(c => c.identifier === "Active ExpressionSetVersion identity collision");
    if (activeCollision) {
      step(steps, "build-expression-set", "error", `✕ Target identity collides with an ACTIVE ExpressionSetVersion — refusing to deploy. This should not happen if version resolution ran correctly above; see the conflicts below.`);
    } else {
      step(steps, "build-expression-set", "success", "✓ Target identity does not collide with an active ExpressionSetVersion.");
    }
    const decisionLabel: Record<OrgUniquenessResult["decision"], string> = {
      "create-new-expression-set": `✓ New ExpressionSet + Version ${nextVersionResolution?.versionNumber ?? 1} will be created.`,
      "create-new-version": `✓ New Version ${nextVersionResolution?.versionNumber ?? "(unresolved)"} will be added to the existing ExpressionSet — the existing version(s) are NOT touched.`,
      "update-existing-version": activeCollision
        ? `✕ This build's generated identity matches an EXISTING, ACTIVE version (${uniqueness.matchedVersionId}) — Salesforce would reject an update to it outright. See conflicts below.`
        : `ℹ This build's generated identity still matches an EXISTING (Draft) version (${uniqueness.matchedVersionId}) — that version will be updated in place, not a new one added. If a new version was intended, this usually means the version-number resolution above could not run (see warnings).`,
      "duplicate-version-conflict": "✕ Conflict — see below.",
      "version-identity-unknown": "ℹ Version identity could not be determined on this org — proceeding without a version-collision check.",
    };
    step(steps, "deploy-pricing-procedure", uniqueness.decision === "update-existing-version" ? "info" : "success", `→ Expression Set Version lifecycle: ${decisionLabel[uniqueness.decision]}`);
  } catch (err) {
    warnings.push(`Org-wide uniqueness pre-flight could not complete: ${err instanceof Error ? err.message : String(err)} — proceeding to deploy anyway; a real conflict will still be caught by Salesforce itself.`);
  }
  if (uniqueness && !uniqueness.ok) {
    const failure = buildLogicalFailure(
      "deploy-pricing-procedure",
      `This Expression Set/Version identity conflicts with an existing record in the org: ${uniqueness.conflicts.map(c => `${c.identifier} (${c.conflictingMetadataType} ${c.existingRecordId})`).join("; ")}.`,
    );
    step(steps, "deploy-pricing-procedure", "error", failure.reason);
    return fail({
      failure, warnings,
      createdValues, existingValuesReused: reusedValues,
      priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds,
      expressionSetDonorInspection,
    });
  }

  /* ── Step 11: Deploy Pricing Procedure (Parts K/L/O) ── */
  // §Payload fingerprint re-check — recompute from the exact string about to be sent, so a future
  // edit that re-assigns canvas.finalFileXml between build and deploy is caught here rather than
  // silently deploying XML that was never validated.
  const deployPayloadFingerprintAtDeploy = createHash("sha256").update(canvas.finalFileXml).digest("hex");
  if (deployPayloadFingerprintAtDeploy !== deployPayloadFingerprint) {
    const failure = buildLogicalFailure(
      "deploy-pricing-procedure",
      `Refusing to deploy — the XML about to be sent to Salesforce (sha256 ${deployPayloadFingerprintAtDeploy}) does not match the XML that was validated (sha256 ${deployPayloadFingerprint}).`,
    );
    step(steps, "deploy-pricing-procedure", "error", failure.reason);
    return fail({
      failure, warnings,
      createdValues, existingValuesReused: reusedValues,
      priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds,
      parentStepValidation: canvas.parentStepValidation, duplicateStepNames: canvas.duplicateStepNames, deployPayloadFingerprint,
      listPriceOutputValidation: canvas.listPriceOutputValidation, attributeDiscountInputBinding: canvas.attributeDiscountInputBinding,
      hierarchyComparison: canvas.hierarchyComparison, donorExtractionDeterministic: canvas.donorExtractionDeterministic,
      identityFieldDrift: canvas.identityFieldDrift, unrelatedBranchIntegrity: canvas.unrelatedBranchIntegrity,
      attributeDiscountBranchSelection: canvas.attributeDiscountBranchSelection, expressionSetDonorInspection,
    });
  }
  /* ── §Part 1/2/3/9 — PROVE what is actually about to be sent to Salesforce, from the real bytes about
   * to be deployed, never assumed from the in-memory resolution result alone. "Resolved Rank: 2" being
   * logged earlier is NOT proof that a <rank>2</rank> tag actually exists in the deployed envelope — the
   * only way to know is to read the same bytes Salesforce is about to receive.
   *
   * §Root-cause fix — the FIRST version of this check re-scanned the FULL assembled `canvas.finalFileXml`
   * (envelope + every step, concatenated) for the first `<rank>...</rank>` match. A live run then hit the
   * exact false-positive this risked: the resolver correctly resolved Rank 3, but this check reported
   * "<rank>1</rank>" as the outbound value and blocked a deploy that (per the resolver's own correct
   * work) may well have been fine — because SOME step's own donor-cloned XML can legitimately contain an
   * unrelated field that happens to share the literal tag name "rank" (e.g. a decision-table row's own
   * priority/ordering value), and an unscoped first-match regex has no way to tell that apart from the
   * VERSION's own envelope-level `<rank>`. `canvas.outboundVersionFields` (computed inside
   * `canvasBuilder.ts`, scoped to ONLY `envelopeBefore`/`envelopeAfter` — the exact same region
   * `ensureEnvelopeTag`/`regenerateEnvelopeTag` themselves ever write to, never `stepsRegionXml`) is the
   * authoritative, correctly-scoped answer and is used here instead of re-deriving it with a fresh,
   * unscoped scan. ── */
  const outboundFullName = canvas.outboundVersionFields?.fullName ?? null;
  const outboundVersionNumber = canvas.outboundVersionFields?.versionNumber ?? null;
  const outboundExpressionSetDefinition = canvas.outboundVersionFields?.expressionSetDefinition ?? null;
  const outboundRank = canvas.outboundVersionFields?.rank ?? null;

  /** §Part 6 — the candidate object exhaustively traced end to end: this IS the exact object
   * (`nextVersionResolution`) whose `.versionNumber`/`.rank` were passed as `ctx.versionNumber`/`ctx.rank`
   * into `buildAttributeCanvas` above (see that call), which passed them unchanged into
   * `injectVersionNumberAndRank` (`versionEnvelopeFields.ts`) — there is no second candidate object
   * anywhere in this pipeline. `targetIdentity`/`apiName` are the same values used for the org-uniqueness
   * check above. Comparing against `canvas.outboundVersionFields` (never a fresh unscoped re-scan) is the
   * hard, final assertion Part 6 asks for — every field, not just Rank. */
  const resolvedCandidate = {
    fullName: targetIdentity,
    versionNumber: nextVersionResolution?.versionNumber ?? null,
    expressionSetDefinition: apiName,
    rank: nextVersionResolution?.rank ?? null,
  };
  step(
    steps, "deploy-pricing-procedure", "info",
    `→ Verifying outbound ExpressionSetVersion payload fields (read directly from the exact bytes about to be deployed, scoped to the version envelope only — never a whole-file scan):\n` +
    `  Resolved fullName: ${resolvedCandidate.fullName} | Outbound: ${outboundFullName ?? "(not found)"}\n` +
    `  Resolved versionNumber: ${resolvedCandidate.versionNumber ?? "(unresolved)"} | Outbound: ${outboundVersionNumber ?? "(not found)"}\n` +
    `  Resolved expressionSetDefinition: ${resolvedCandidate.expressionSetDefinition} | Outbound: ${outboundExpressionSetDefinition ?? "(not found)"}\n` +
    `  Resolved rank: ${resolvedCandidate.rank ?? "(unresolved)"} | Outbound: ${outboundRank ?? "(not found)"}`,
  );

  const fieldMismatches: { field: string; resolved: string; outbound: string | null }[] = [];
  if (outboundFullName !== resolvedCandidate.fullName) {
    fieldMismatches.push({ field: "fullName", resolved: resolvedCandidate.fullName, outbound: outboundFullName });
  }
  if (resolvedCandidate.versionNumber !== null && outboundVersionNumber !== String(resolvedCandidate.versionNumber)) {
    fieldMismatches.push({ field: "versionNumber", resolved: String(resolvedCandidate.versionNumber), outbound: outboundVersionNumber });
  }
  if (outboundExpressionSetDefinition !== resolvedCandidate.expressionSetDefinition) {
    fieldMismatches.push({ field: "expressionSetDefinition", resolved: resolvedCandidate.expressionSetDefinition, outbound: outboundExpressionSetDefinition });
  }
  if (resolvedCandidate.rank !== null && outboundRank !== String(resolvedCandidate.rank)) {
    fieldMismatches.push({ field: "rank", resolved: String(resolvedCandidate.rank), outbound: outboundRank });
  }

  if (fieldMismatches.length > 0) {
    const failure = buildLogicalFailure(
      "deploy-pricing-procedure",
      `Refusing to deploy — payload verification FAILED before the Metadata API was ever called.\n\n` +
      `Resolved:\n${Object.entries(resolvedCandidate).map(([k, v]) => `  ${k} = ${v ?? "(none)"}`).join("\n")}\n\n` +
      `Final outbound (read from the exact bytes about to be deployed, scoped to the version envelope):\n` +
      `  fullName = ${outboundFullName ?? "(not found)"}\n  versionNumber = ${outboundVersionNumber ?? "(not found)"}\n  expressionSetDefinition = ${outboundExpressionSetDefinition ?? "(not found)"}\n  rank = ${outboundRank ?? "(not found)"}\n\n` +
      `Mismatched field(s): ${fieldMismatches.map(m => `${m.field} (resolved="${m.resolved}", outbound="${m.outbound ?? "(not found)"}")`).join(", ")}.\n\n` +
      `This is a defect in this application's payload construction, never a Salesforce-side rejection — the Metadata API was never called.`,
    );
    step(steps, "deploy-pricing-procedure", "error", failure.reason);
    return fail({
      failure, warnings,
      createdValues, existingValuesReused: reusedValues,
      priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds,
      parentStepValidation: canvas.parentStepValidation, duplicateStepNames: canvas.duplicateStepNames, deployPayloadFingerprint,
      attributeDiscountBranchSelection: canvas.attributeDiscountBranchSelection, expressionSetDonorInspection,
    });
  }
  step(
    steps, "deploy-pricing-procedure", "success",
    `✓ Payload verification: PASS — Resolved Version: ${resolvedCandidate.versionNumber ?? "(n/a)"} | Resolved Rank: ${resolvedCandidate.rank ?? "(n/a)"} | Outbound Version: ${outboundVersionNumber ?? "(n/a)"} | Outbound Rank: ${outboundRank ?? "(n/a)"} | Identity: ${outboundFullName ?? "(n/a)"}.`,
  );
  step(steps, "deploy-pricing-procedure", "info", "→ Creating Expression Set Version.");
  emit("deploy-pricing-procedure", "running");
  const deployResult = await deployExpressionSetDefinition(client, apiName, canvas.finalFileXml, canvas.donorFileName);
  if (!deployResult.success) {
    let reason = deployResult.error ?? "Metadata deploy failed.";
    // §Part 13 — "Assign a unique rank ..." is a DIFFERENT failure mode from the identity-uniqueness
    // conflicts `diagnosePostDeployFailure` already classifies (fullName/ApiName collisions): it means
    // the Rank actually sent (or omitted) collided with an existing version's own Rank. Never blindly
    // retried with an incremented guess here — this makes the failure actionable per Part 13's exact
    // requirement (VersionNumber/Rank/ExpressionSetId/candidate identity/existing versions+ranks/the raw
    // Salesforce error), so a re-run (which re-resolves Rank from fresh org state) can fix it.
    if (/assign\s+a\s+unique\s+rank/i.test(reason)) {
      const inv = nextVersionResolution?.inventory;
      const lastAttempt = nextVersionResolution?.attempts[nextVersionResolution.attempts.length - 1];
      const allOrgWideCollisions = nextVersionResolution?.attempts.flatMap(a => a.orgWideRankCollisions) ?? [];
      reason = [
        "Salesforce rejected deployment because the ExpressionSetVersion Rank was not unique.",
        "",
        `VersionNumber: ${nextVersionResolution?.versionNumber ?? "(unresolved)"}`,
        `Requested Rank (resolved from org data before deploy): ${nextVersionResolution?.rank ?? "(none resolved — this org's ExpressionSetVersion schema may have no Rank field)"}`,
        `Actual outbound Rank (read directly from the deployed XML bytes): ${outboundRank ?? "(no <rank> tag found in the deployed XML — proves this is a payload-construction defect, not a Salesforce-side rejection of a correct value)"}`,
        `ExpressionSetId: ${inv?.existingExpressionSetId ?? "(none — no existing ExpressionSet was found)"}`,
        `Candidate identity: ${nextVersionResolution?.identity ?? apiName}`,
        `Existing versions: ${inv && inv.versions.length > 0 ? inv.versions.map(v => `V${v.versionNumber ?? "?"} (Id=${v.id}, Rank=${v.rank ?? "n/a"}, Active=${v.isActive ?? "n/a"})`).join(", ") : "(none)"}`,
        `Existing ranks for this ExpressionSet: [${inv?.versions.map(v => v.rank).filter((n): n is number => n !== null).join(", ") ?? ""}]`,
        `Ranks independently proven taken elsewhere in the org (never scoped to this ExpressionSet): ${allOrgWideCollisions.length > 0 ? allOrgWideCollisions.map(c => `Rank ${c.rank} (ExpressionSetVersion ${c.existingRecordId}, ExpressionSetId=${c.existingExpressionSetId ?? "unknown"})`).join("; ") : "(none found by the independent org-wide check — if Salesforce still rejects the resolved rank, its uniqueness rule may not be a simple integer-value collision at all; see Part 5/9 in the user's own instructions — inspect the ExpressionSetVersion Rank field's actual metadata, logged above at 'Resolving ExpressionSetVersion Rank', and consider whether Rank has a different scoping rule (e.g. tied to overlapping start/end date ranges) than plain uniqueness.)"}`,
        `Existing ranks excluded when this candidate was computed: [${lastAttempt?.existingRanks.join(", ") ?? ""}]`,
        "",
        `Salesforce error: ${reason}`,
        "",
        "This is not silently retried with a different Rank guess — re-running this build re-resolves Rank from the org's current state (both per-ExpressionSet and independently org-wide), which corrects a stale read; a genuine structural conflict will be reported again with the same diagnostics above.",
      ].join("\n");
    }
    const diagnosis = diagnosePostDeployFailure(reason, uniqueness);
    if (diagnosis.isUniquenessConflict) reason = diagnosis.diagnosis;
    const failure = buildLogicalFailure("deploy-pricing-procedure", reason, undefined, {
      packagingReport: deployResult.packagingReport.reportText,
      deployComponentFailures: deployResult.status?.componentFailures,
      deployFullStatus: deployResult.status,
      generatedFileXml: deployResult.generatedFileXml,
      deployZipBase64: deployResult.deployZipBase64,
      rawDeployStatusXml: deployResult.rawDeployStatusXml,
    });
    step(steps, "deploy-pricing-procedure", "error", `✕ ${reason}`);
    return fail({
      failure, warnings,
      createdValues, existingValuesReused: reusedValues,
      priceAdjustmentScheduleId: native.scheduleId, ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds,
      parentStepValidation: canvas.parentStepValidation, duplicateStepNames: canvas.duplicateStepNames, deployPayloadFingerprint,
      listPriceOutputValidation: canvas.listPriceOutputValidation, attributeDiscountInputBinding: canvas.attributeDiscountInputBinding,
      hierarchyComparison: canvas.hierarchyComparison, donorExtractionDeterministic: canvas.donorExtractionDeterministic,
      identityFieldDrift: canvas.identityFieldDrift, unrelatedBranchIntegrity: canvas.unrelatedBranchIntegrity,
      attributeDiscountBranchSelection: canvas.attributeDiscountBranchSelection, expressionSetDonorInspection,
    });
  }
  step(steps, "deploy-pricing-procedure", "success", "✓ Salesforce Metadata API accepted Expression Set.");
  step(steps, "deploy-pricing-procedure", "success", `Deployed ${deployResult.status?.numberComponentsDeployed ?? 0} component(s), ${deployResult.status?.numberComponentErrors ?? 0} error(s).`);
  // §Part 3 — the actual deployment result identity, captured directly from Salesforce's own
  // checkDeployStatus response (never reconstructed from the UI-supplied name alone).
  const deploymentSummary = {
    success: deployResult.status?.success ?? deployResult.success,
    deploymentId: deployResult.status?.id ?? null,
    componentsDeployed: deployResult.status?.numberComponentsDeployed ?? 0,
    errors: deployResult.status?.numberComponentErrors ?? 0,
  };
  step(steps, "deploy-pricing-procedure", "success", `✓ Deployment ID: ${deploymentSummary.deploymentId ?? "(not returned)"}.`);
  for (const c of deployResult.status?.componentSuccesses ?? []) {
    step(steps, "deploy-pricing-procedure", "success", `✓ Component: ${c.fullName ?? c.fileName ?? "(unnamed)"} (${c.componentType ?? "unknown type"}${c.id ? `, Id: ${c.id}` : ""}).`);
  }
  emit("deploy-pricing-procedure", "done");

  /* ── Resolve the real ExpressionSet / ExpressionSetVersion Ids Salesforce just assigned. §Final Fix —
   * named per-concept (not one generic shared variable) even though, in this org's actual Metadata API
   * mechanics, all three currently draw from the SAME single deploy result: `deployExpressionSetDefinition()`
   * performs exactly ONE deploy of ONE ExpressionSetDefinition component that bundles the ExpressionSet +
   * ExpressionSetVersion + steps together (see deploy.ts) — there is no separate "Expression Set Version
   * deployment" or "Pricing Procedure deployment" as distinct Metadata API operations in this codebase.
   * Named distinctly anyway so a future change (e.g. if this ever splits into multiple deploys) doesn't
   * require a rename, and so it's never ambiguous which concept a given componentSuccesses reference is
   * being used for. ── */
  const expressionSetDeploymentResult = deployResult;
  const expressionSetVersionDeploymentResult = deployResult;
  const pricingProcedureDeploymentResult = deployResult;
  const expressionSetComponentSuccesses = expressionSetDeploymentResult.status?.componentSuccesses;
  const expressionSetVersionComponentSuccesses = expressionSetVersionDeploymentResult.status?.componentSuccesses;
  const pricingProcedureComponentSuccesses = pricingProcedureDeploymentResult.status?.componentSuccesses;

  // §Final Fix — the Metadata API deployment component's own Id (kept ONLY under this name, for
  // logging) must never be confused with, or substituted for, a real ExpressionSet record Id — live
  // evidence (Connect REST rejecting it as "Invalid identifier") proved they are different identities.
  let expressionSetId: string | undefined;
  let metadataDeploymentComponentId: string | null = null;
  {
    step(steps, "deploy-pricing-procedure", "info", `→ Resolving actual ExpressionSet Salesforce record\n   fullName=${apiName}`);
    const esResolution = await resolveExpressionSetId(client, { apiName, componentSuccesses: expressionSetComponentSuccesses }, (attempt, found, error) => {
      step(steps, "deploy-pricing-procedure", "info", `→ Resolving ExpressionSet Id — attempt ${attempt}${error ? ` (query error: ${error})` : found ? " — found." : " — not found yet."}`);
    });
    metadataDeploymentComponentId = esResolution.metadataDeploymentComponentId ?? null;
    expressionSetId = esResolution.verified ? (esResolution.id ?? undefined) : undefined;
    for (const c of esResolution.candidateAttempts ?? []) {
      step(steps, "deploy-pricing-procedure", "info", `→ ExpressionSet identity candidate:\n   field=${c.field}\n   lookupValue=${c.lookupValue}\n   matches=${c.matches}${c.error ? ` (query error: ${c.error})` : ""}`);
    }
    if (expressionSetId) {
      step(steps, "deploy-pricing-procedure", "success", `✓ Actual ExpressionSet Salesforce record resolved:\n   id=${expressionSetId}\n   source=${esResolution.field ?? "(unknown field)"}`);
    } else {
      step(
        steps, "deploy-pricing-procedure", "error",
        `✕ Actual ExpressionSet Salesforce record could not be resolved.\n` +
        `  Metadata deployment succeeded, but the Metadata API component identity could not be used as a Salesforce ExpressionSet record ID.\n` +
        `  Deployment component ID: ${metadataDeploymentComponentId ?? "(none)"}\n` +
        `  Component type: ${EXPRESSION_SET_METADATA_TYPE}\n` +
        `  fullName: ${apiName}\n` +
        `  Describe-confirmed identity fields attempted: ${(esResolution.candidateAttempts ?? []).map(c => c.field).join(", ") || "none"}\n` +
        `  Matching ExpressionSet record(s) per field: ${(esResolution.candidateAttempts ?? []).map(c => `${c.field}=${c.matches}`).join(", ") || "none"}\n` +
        `  Reason: ${esResolution.method}${esResolution.error ? ` (${esResolution.error})` : ""}`,
      );
    }
  }

  /* ── ExpressionSetVersion resolution — §Final Fix: the ExpressionSetDefinition deployment component's
   * own Id (`9QANS...` in the live run that exposed this bug) is the ExpressionSetDefinition/deployment
   * identity, NOT an ExpressionSetVersion record Id — proven live by a real HTTP 404 NOT_FOUND when
   * activation was called with it. That Id is NEVER used as (or matched against) an ExpressionSetVersion
   * Id anywhere below; `expressionSetVersionComponentSuccesses` is inspected here purely for its
   * `fullName` (a legitimate name-matching signal) and for this informational log, never for an `id`. ── */
  step(steps, "deploy-pricing-procedure", "info", "→ Inspecting Expression Set Version deployment result.");
  step(steps, "deploy-pricing-procedure", "info", `→ Deployment state: ${expressionSetVersionDeploymentResult.status?.status ?? "(unknown)"}.`);
  step(steps, "deploy-pricing-procedure", "info", `→ Component successes: ${expressionSetVersionComponentSuccesses?.length ?? 0}.`);
  for (const c of expressionSetVersionComponentSuccesses ?? []) {
    step(
      steps, "deploy-pricing-procedure", "info",
      `→ Version component candidate (ExpressionSetDefinition deployment identity — NOT an ExpressionSetVersion Id):\n   type=${c.componentType ?? "(none)"}\n   fullName=${c.fullName ?? "(none)"}\n   id=${c.id ?? "(none)"}\n   state=${expressionSetVersionDeploymentResult.status?.status ?? "(unknown)"}`,
    );
  }

  step(steps, "deploy-pricing-procedure", "info", `→ Resolving ExpressionSetVersion through Connect REST\n   expressionSetId=${expressionSetId ?? "(none — real ExpressionSet Id was not resolved)"}`);
  const esvResolution = await resolveExpressionSetVersionId(
    client,
    { expressionSetId, componentSuccesses: expressionSetVersionComponentSuccesses },
    (attempt, found, error) => {
      step(steps, "deploy-pricing-procedure", "info", `→ Resolving ExpressionSetVersion (Connect REST) — attempt ${attempt}${error ? ` (error: ${error})` : found ? " — version(s) found." : " — no versions yet."}`);
    },
  );

  if (esvResolution.strategy === "no-expression-set-id") {
    step(steps, "deploy-pricing-procedure", "error", "✕ No ExpressionSet Id is available to resolve the Expression Set Version through Connect REST.");
  } else {
    if (esvResolution.connectResponse) {
      step(steps, "deploy-pricing-procedure", "success", "✓ Connect REST Expression Set response received.");
      if (esvResolution.connectResponse.apiName) step(steps, "deploy-pricing-procedure", "success", `✓ API Name: ${esvResolution.connectResponse.apiName}.`);
      step(steps, "deploy-pricing-procedure", "success", `✓ Connect REST returned ${esvResolution.candidates?.length ?? 0} version(s).`);
      step(steps, "deploy-pricing-procedure", "info", "→ Inspecting Expression Set Version candidates.");
      for (const v of esvResolution.candidates ?? []) {
        step(
          steps, "deploy-pricing-procedure", "info",
          `→ Version candidate:\n` +
          `   id=${v.id ?? "(none)"}\n` +
          `   name=${(v.name ?? "(none)") as string}\n` +
          `   apiName=${(v.apiName ?? v.fullName ?? "(none)") as string}\n` +
          `   versionNumber=${(v.versionNumber ?? v.version ?? "(none)") as string | number}\n` +
          `   rank=${(v.rank ?? "(none)") as string | number}\n` +
          `   enabled=${(v.enabled ?? v.isEnabled ?? "(none)") as string | boolean}\n` +
          `   startDate=${(v.startDate ?? "(none)") as string}\n` +
          `   endDate=${(v.endDate ?? "(none)") as string}`,
        );
      }
    }
  }

  const expressionSetVersionId = esvResolution.verified ? (esvResolution.id ?? undefined) : undefined;
  if (expressionSetVersionId) {
    step(steps, "deploy-pricing-procedure", "success", `✓ ExpressionSetVersion resolved from Connect REST:\n  ${expressionSetVersionId}`);
    step(steps, "deploy-pricing-procedure", "success", `✓ Selected by: ${esvResolution.method}`);
    step(steps, "deploy-pricing-procedure", "success", `✓ ExpressionSetVersion identity verified:\n  ${expressionSetVersionId}`);
  } else if (esvResolution.strategy === "connect-rest-unmatched" || esvResolution.strategy === "connect-rest-unverified") {
    // §"If Connect REST returns versions but none can be selected, DO NOT fabricate an ID" — fail
    // loudly with the full candidate table, never silently pick one, never invent an Id.
    const candidateLines = (esvResolution.candidates ?? []).map((v, i) =>
      `${i + 1}.\n   id=${v.id ?? "(none)"}\n   name=${(v.name ?? "(none)") as string}\n   apiName=${(v.apiName ?? v.fullName ?? "(none)") as string}\n   versionNumber=${(v.versionNumber ?? v.version ?? "(none)") as string | number}\n   status=${(v.status ?? v.state ?? "(none)") as string}`,
    );
    step(
      steps, "deploy-pricing-procedure", "error",
      `✕ ExpressionSetVersion resolution failed.\n\n` +
      `Available candidates:\n\n${candidateLines.join("\n\n") || "(none)"}\n\n` +
      `Reason:\n"${esvResolution.strategy === "connect-rest-unverified" ? "The selected candidate could not be independently verified as a real ExpressionSetVersion record." : "No deterministic version match was found."}"`,
    );
  } else {
    step(steps, "deploy-pricing-procedure", "error", `✕ ExpressionSetVersion Id could not be resolved — ${esvResolution.method}${esvResolution.error ? `: ${esvResolution.error}` : "."}`);
  }

  if (!expressionSetVersionId) {
    warnings.push(
      "Expression Set deployed successfully, but its Expression Set Version could not be resolved/confirmed through Connect REST — activation could not proceed. " +
      "See the Execution Log for the exact candidates inspected and why none could be confirmed. Metadata deployment itself is not affected by this.",
    );
  }

  // §UI/JSON Details — expressionSet / expressionSetVersion / activation, kept distinctly identified;
  // the UI must never show the same Id for both unless Salesforce itself returns the same Id for both.
  const esvSelectedBy: ExpressionSetVersionResolutionAudit["selectedBy"] = esvResolution.matchPriority === "A"
    ? "deployment-id"
    : esvResolution.matchPriority === "B" ? "full-name"
    : esvResolution.matchPriority === "C" ? (esvResolution.candidates?.length === 1 ? "sole-version" : "version-number")
    : null;
  const expressionSetVersionResolution: ExpressionSetVersionResolutionAudit = {
    strategy: esvResolution.strategy.startsWith("connect-rest") ? "connect-rest" : "fallback",
    metadataDeploymentComponentId,
    expressionSetId: expressionSetId ?? null,
    expressionSetVersionId: expressionSetVersionId ?? null,
    verified: esvResolution.verified,
    selectedBy: esvSelectedBy,
    request: { method: "GET", path: esvResolution.connectRequestPath ?? buildConnectExpressionSetPath(expressionSetId ?? "") },
    response: esvResolution.connectResponse ?? null,
    method: esvResolution.method,
    selectedVersion: esvResolution.selectedVersion ?? null,
    candidates: esvResolution.candidates ?? [],
    error: esvResolution.error,
  };
  // §"Pricing Procedure" has no independent Metadata API deploy/component of its own (Follow-on 18) —
  // `pricingProcedureComponentSuccesses` is named per this turn's "no shared generic variable"
  // convention purely for symmetry/documentation; its component count is echoed in the log below rather
  // than left a silently-unused reference.
  step(steps, "deploy-pricing-procedure", "info", `→ Pricing Procedure component successes (same deploy, no independent component of its own): ${pricingProcedureComponentSuccesses?.length ?? 0}.`);

  /* ── Post-deploy: refresh the ListPrice Decision Table dataset (non-blocking) ── */
  if (canvas.lpLookup?.lookUpId) {
    const refresh = await refreshListPriceDecisionTable(client, canvas.lpLookup.lookUpId, canvas.lpLookup.lookUpApiName);
    if (refresh.warning) warnings.push(refresh.warning);
  }

  /* ── Step 12: Activate (Part P) — receives ONLY the Connect-REST-resolved, identity-verified
   * `expressionSetVersionId` above; never the ExpressionSetDefinition deployment component's Id. ── */
  let versionStatus: "Draft" | "Active" = "Draft";
  let activationDetail: Awaited<ReturnType<typeof activateExpressionSetVersion>>["detail"] | undefined;
  if (input.activate) {
    step(steps, "activate-version", "info", `→ Activating ExpressionSetVersion ${expressionSetVersionId ?? "(unresolved)"}.`);
    emit("activate-version", "running");
    const activation = await activateExpressionSetVersion(client, expressionSetVersionId, steps, warnings, expressionSetId);
    versionStatus = activation.status;
    activationDetail = activation.detail;
    emit("activate-version", versionStatus === "Active" ? "done" : "warning");
  }
  const activationAudit: AttributePricingActivationAudit = {
    attempted: !!input.activate,
    versionId: expressionSetVersionId ?? null,
    success: versionStatus === "Active",
    status: input.activate ? versionStatus : null,
    detail: activationDetail,
  };

  /* ── Step 13: Verify Salesforce (Part Q) ── */
  emit("verify-salesforce", "running");
  const verification = await verifySalesforceState(client, {
    productId: input.product.id,
    attributeValueIds: [...createdValues, ...reusedValues].map(v => v.id),
    scheduleId: native.scheduleId,
    ruleIds: native.ruleIds,
    conditionIds: native.conditionIds,
    adjustmentIds: native.adjustmentIds,
    expressionSetApiName: apiName,
    expressionSetId,
    expressionSetVersionId,
    componentSuccesses: expressionSetVersionComponentSuccesses,
  }, steps);
  // §Three-state model (Parts 5/7) — `deriveVerificationStatus` treats the ExpressionSet/Version/
  // Pricing-Procedure layer's DEPLOY success and READ-BACK confirmation as independent claims; a gap in
  // the latter alone (while the former, and every native-record component, is genuinely fine) is a
  // WARNING, never converted into a fatal failure — only a real problem in the plain-boolean native
  // components (or the ExpressionSet layer never even reporting itself deployed) is treated as FAILED.
  const verificationStatus = deriveVerificationStatus(verification);
  emit("verify-salesforce", verificationStatus === "verified" ? "done" : "warning");

  // §Part 9/11 — the granular per-stage lifecycle breakdown. Deliberately independent of the 3-state
  // `status`/`verificationStatus` model above: a pending/failed ACTIVATION must be visible as its own
  // distinct state, never folded into an undifferentiated "verification warning" when deployment itself
  // was fully successful.
  const lifecycleStatus: AttributePricingLifecycleStatus = {
    expressionSetDeployment: deploymentSummary.success ? "success" : "failed",
    expressionSetVersionDeployment: deploymentSummary.success ? "success" : "failed",
    expressionSetVersionResolution: expressionSetVersionId ? "success" : (expressionSetId ? "failed" : "skipped"),
    activation: !input.activate ? "not_requested" : (versionStatus === "Active" ? "success" : (expressionSetVersionId ? "failed" : "skipped")),
    pricingProcedure: verification.pricingProcedure.verified ? "verified" : (verification.pricingProcedure.deployed ? "deployed" : "not_verified"),
  };

  // §Final Fix / Acceptance Criteria — the literal final execution-log sequence, reflecting whatever
  // ACTUALLY happened at each stage (✓ where confirmed, ✕/ℹ otherwise) — never asserted regardless of
  // outcome.
  step(
    steps, "verify-salesforce", verification.pricingRules ? "success" : "info",
    verification.pricingRules ? "✓ Attribute-Based Pricing records verified." : "ℹ Attribute-Based Pricing records could not be fully re-confirmed via read-back.",
  );
  step(steps, "verify-salesforce", lifecycleStatus.expressionSetDeployment === "success" ? "success" : "error", `${lifecycleStatus.expressionSetDeployment === "success" ? "✓" : "✕"} Expression Set deployed.`);
  step(steps, "verify-salesforce", lifecycleStatus.expressionSetVersionDeployment === "success" ? "success" : "error", `${lifecycleStatus.expressionSetVersionDeployment === "success" ? "✓" : "✕"} Expression Set Version deployed.`);
  step(steps, "verify-salesforce", expressionSetId ? "success" : "error", `${expressionSetId ? "✓" : "✕"} ExpressionSet Id resolved${expressionSetId ? `: ${expressionSetId}` : "."}`);
  if (expressionSetVersionId) {
    step(steps, "verify-salesforce", "success", `✓ Expression Set Version ID resolved: ${expressionSetVersionId}.`);
  } else {
    step(steps, "verify-salesforce", "error", "✕ Expression Set Version ID could not be resolved.");
  }
  step(
    steps, "verify-salesforce", verification.expressionSetVersion.verified ? "success" : "info",
    verification.expressionSetVersion.verified ? "✓ Expression Set Version retrieved." : "ℹ Expression Set Version could not be re-confirmed via read-back.",
  );
  if (input.activate) {
    step(steps, "verify-salesforce", "info", `→ Activating Expression Set Version: ${expressionSetVersionId ?? "(unresolved)"}.`);
    step(steps, "verify-salesforce", lifecycleStatus.activation === "success" ? "success" : "error", `${lifecycleStatus.activation === "success" ? "✓" : "✕"} Expression Set Version activated.`);
    step(steps, "verify-salesforce", lifecycleStatus.activation === "success" ? "success" : "info", `${lifecycleStatus.activation === "success" ? "✓" : "ℹ"} Expression Set Version status: ${versionStatus}.`);
  }
  step(steps, "verify-salesforce", "success", "✓ Pricing Procedure deployed.");
  step(
    steps, "verify-salesforce", lifecycleStatus.pricingProcedure === "verified" ? "success" : "info",
    lifecycleStatus.pricingProcedure === "verified" ? "✓ Pricing Procedure verified." : "ℹ Pricing Procedure not yet verified via read-back.",
  );
  // §"Do NOT display 'Deployment Completed with Verification Warning' if deployment + version
  // activation + pricing procedure verification all succeed" — this line only ever appears when every
  // one of those genuinely did.
  const lifecycleFullySucceeded = lifecycleStatus.expressionSetDeployment === "success"
    && lifecycleStatus.expressionSetVersionDeployment === "success"
    && lifecycleStatus.expressionSetVersionResolution === "success"
    && (lifecycleStatus.activation === "success" || lifecycleStatus.activation === "not_requested")
    && lifecycleStatus.pricingProcedure === "verified";
  if (lifecycleFullySucceeded) {
    step(steps, "verify-salesforce", "success", "✓ Attribute-Based Pricing lifecycle completed successfully.");
  }
  step(
    steps, "verify-salesforce", verificationStatus === "verified" ? "success" : "info",
    verificationStatus === "verified" ? "✓ Salesforce verification complete." : "ℹ Salesforce verification incomplete — see the lifecycle/read-back detail above.",
  );

  const finalSnapshot = buildProcedureSnapshot({
    executionId,
    product: { id: input.product.id, name: input.product.name },
    discoveredAttributes: input.discoveredAttributes,
    rules: input.rules,
    priceAdjustmentScheduleId: native.scheduleId,
    ruleIds: native.ruleIds,
    conditionIds: native.conditionIds,
    adjustmentIds: native.adjustmentIds,
    expressionSetId, expressionSetVersionId, expressionSetApiName: apiName,
    verification,
  });
  const finalAuditLog = buildSanitizedAuditLog(client.debugLog);

  if (verificationStatus === "failed") {
    const unverifiedCore = [
      !verification.product && "product", !verification.attributesValues && "attributesValues", !verification.pricingRules && "pricingRules",
      !verification.lookupTable && "lookupTable", !verification.pricingElement && "pricingElement",
      !verification.expressionSet.deployed && "expressionSet (never reported deployed)",
      !verification.expressionSetVersion.deployed && "expressionSetVersion (never reported deployed)",
    ].filter((v): v is string => !!v);
    const failure = buildLogicalFailure(
      "verify-salesforce",
      `Salesforce read-back could not confirm every required component: ${unverifiedCore.join(", ")}.`,
    );
    step(steps, "verify-salesforce", "error", `✕ ${failure.reason}`);
    return {
      success: false, error: `[${executionId}] ${failure.reason}`, failure, warnings, steps,
      status: "failed",
      executionId, auditLog: finalAuditLog, procedureSnapshot: finalSnapshot, adjustmentDecisions, expressionSetValidation,
      parentStepValidation: canvas.parentStepValidation, duplicateStepNames: canvas.duplicateStepNames, deployPayloadFingerprint,
      listPriceOutputValidation: canvas.listPriceOutputValidation, attributeDiscountInputBinding: canvas.attributeDiscountInputBinding,
      hierarchyComparison: canvas.hierarchyComparison, donorExtractionDeterministic: canvas.donorExtractionDeterministic,
      identityFieldDrift: canvas.identityFieldDrift, unrelatedBranchIntegrity: canvas.unrelatedBranchIntegrity,
      attributeDiscountBranchSelection: canvas.attributeDiscountBranchSelection,
      deploymentSummary, lifecycleStatus, expressionSetVersionResolution, activationAudit, expressionSetDonorInspection,
      product: { id: input.product.id, name: input.product.name },
      priceAdjustmentScheduleId: native.scheduleId,
      createdValues, existingValuesReused: reusedValues,
      ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds,
      excludedAttributes: input.excludedAttributes,
      expressionSetId, expressionSetApiName: apiName, expressionSetVersionId, versionStatus,
      verification,
    };
  }

  // §Part 11 — activation is NOT part of `deriveVerificationStatus` (that function only ever looked at
  // ExpressionSet/Version/PricingProcedure read-back, never activation) — without this check, a full
  // activation failure on an otherwise-fully-verified deploy would silently report `status: "success"`,
  // hiding exactly the "deployment succeeded, activation is still pending" case this fix exists for.
  const activationIssue = lifecycleStatus.activation === "failed";
  let verificationWarning: string | undefined;
  if (verificationStatus === "verified_with_warning" || activationIssue) {
    const unconfirmed = [
      !verification.expressionSet.verified && "Expression Set",
      !verification.expressionSetVersion.verified && "Expression Set Version",
      !verification.pricingProcedure.verified && "Pricing Procedure",
    ].filter((v): v is string => !!v);
    const parts: string[] = [];
    if (unconfirmed.length > 0) parts.push(`Direct post-deployment read-back could not confirm: ${unconfirmed.join(", ")}.`);
    if (activationIssue) parts.push(`Expression Set Version resolution succeeded (${expressionSetVersionId}), but activation to "Active" could not be confirmed — it remains in ${versionStatus} status.`);
    parts.push(`Salesforce's Metadata API deployment itself already succeeded (${deploymentSummary.componentsDeployed} component(s), ${deploymentSummary.errors} error(s)) — this is a warning, never a creation failure.`);
    verificationWarning = parts.join(" ");
    step(steps, "verify-salesforce", "info", `⚠ ${verificationWarning}`);
  } else {
    step(steps, "verify-salesforce", "success", "✓ Every required Salesforce component was confirmed via read-back.");
  }
  const overallStatus: CreateAttributePricingResult["status"] = verificationStatus === "verified" && !activationIssue ? "success" : "deployed_with_verification_warning";

  return {
    success: true, warnings, steps,
    status: overallStatus,
    deploymentSummary, verificationWarning, lifecycleStatus, expressionSetVersionResolution, activationAudit, expressionSetDonorInspection,
    executionId, auditLog: finalAuditLog, procedureSnapshot: finalSnapshot, adjustmentDecisions, expressionSetValidation,
    parentStepValidation: canvas.parentStepValidation, duplicateStepNames: canvas.duplicateStepNames, deployPayloadFingerprint,
    listPriceOutputValidation: canvas.listPriceOutputValidation, attributeDiscountInputBinding: canvas.attributeDiscountInputBinding,
    hierarchyComparison: canvas.hierarchyComparison, donorExtractionDeterministic: canvas.donorExtractionDeterministic,
    identityFieldDrift: canvas.identityFieldDrift, unrelatedBranchIntegrity: canvas.unrelatedBranchIntegrity,
    attributeDiscountBranchSelection: canvas.attributeDiscountBranchSelection,
    product: { id: input.product.id, name: input.product.name },
    priceAdjustmentScheduleId: native.scheduleId,
    createdValues, existingValuesReused: reusedValues,
    ruleIds: native.ruleIds, conditionIds: native.conditionIds, adjustmentIds: native.adjustmentIds,
    excludedAttributes: input.excludedAttributes,
    expressionSetId, expressionSetApiName: apiName, expressionSetVersionId, versionStatus,
    verification,
  };
}
