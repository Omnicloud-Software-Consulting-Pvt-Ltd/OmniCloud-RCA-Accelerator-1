/**
 * Bundle-Based Pricing — native Salesforce record CRUD + idempotency.
 *
 * Mirrors lib/pricing-rules/attribute-based/create/nativeRecords.ts's exact idempotency discipline
 * (broad-scan-then-narrow reuse checks, never a Name-only lookup, product/bundle-consistency validation,
 * signature-based duplicate resolution, read-back verification of every create) but for the real
 * Salesforce object family Bundle-Based Adjustments use: `BundleBasedAdjRule` / `BundleAdjustmentCondition`
 * / `BundleBasedAdjustment` (parallel, standard Revenue Cloud Advanced objects to
 * AttributeBasedAdjRule/AttributeAdjustmentCondition/AttributeBasedAdjustment) — reusing the shared
 * `PriceAdjustmentSchedule` object exactly like attribute-based pricing does.
 *
 * §Assumption requiring live-org confirmation: BundleAdjustmentCondition's real identity is modeled here
 * as (Rule + Component Product2 [+ Bundle Product2 if the org's schema exposes one]) — a single-dimension
 * "this component is present" condition, NOT the multi-attribute-completeness model Attribute-Based
 * Pricing's own condition object requires. This is the most defensible reading of "a component either is
 * or isn't part of the priced bundle" without inventing a requirement that hasn't been confirmed against a
 * real org's own FIELD_INTEGRITY_EXCEPTION text — if Salesforce's real Bundle-Based Pricing schema turns
 * out to require additional per-condition fields, `prepareBundleBasedAdjustmentSchema`'s Describe-driven
 * resolution below is the single place that would need extending, not the create/reuse logic around it.
 */
import { SalesforceError, type SalesforceClient, type DescribeResult, type DescribeField, soqlEscape } from "@/lib/salesforce/client";
import {
  SchemaCache, resolveReferenceField, resolveDefaultPicklistValue, fillRequiredPicklistDefaults,
  extractSalesforceFields, diagnoseCreateRejection, formatCreateRejectionDiagnosis,
  buildSchemaDiagnosis, logSchemaDiagnosis, logObjectCreation,
  type ReferenceFieldResolution, type ResolvedLookup,
} from "@/lib/pricing-rules/attribute-based/create/nativeSchemaResolver";
import type { ProcedureStepLite } from "../types";
import type { BundleComponentPlanRow } from "../types";
import type { BundleAdjustmentDecision } from "./types";

function step(steps: ProcedureStepLite[], name: string, status: ProcedureStepLite["status"], message: string) {
  steps.push({ step: name, status, message, timestamp: Date.now() });
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function oneYearFromTodayISO(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}
function normalizeDateValue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v).slice(0, 10);
}

async function verifyRecordExists(client: SalesforceClient, sobject: string, id: string): Promise<boolean> {
  try {
    const res = await client.query<{ Id: string }>(`SELECT Id FROM ${sobject} WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
    return res.records.length > 0;
  } catch {
    return false;
  }
}

/** Generic "never trust a create response's Id alone" guard — same pattern as attribute-based's own
 * (unexported) `guardedCreate`. Duplicated here rather than imported since it isn't exported there. */
async function guardedCreate(
  client: SalesforceClient, objectName: string, describe: DescribeResult,
  payload: Record<string, unknown>, resolvedLookups: ResolvedLookup[], stepName: string,
): Promise<string> {
  fillRequiredPicklistDefaults(describe, payload);
  const { missingFields } = logObjectCreation(client, objectName, { describe, payload, resolvedLookups });
  if (missingFields.length > 0) {
    const diagnosis = buildSchemaDiagnosis(objectName, describe, payload, resolvedLookups);
    logSchemaDiagnosis(client, describe, diagnosis);
    throw new Error(`${objectName} is missing required field(s): ${missingFields.join(", ")}. See server logs for the full schema diagnosis (${stepName}).`);
  }
  let created: { id: string };
  try {
    created = await client.createRecord(objectName, payload);
  } catch (err) {
    if (err instanceof SalesforceError) {
      const fields = extractSalesforceFields(err.body);
      const diagnosis = diagnoseCreateRejection(objectName, describe, payload, err.errorCode ?? null, err.message, fields);
      client.logDebug("native-create-response", formatCreateRejectionDiagnosis(diagnosis));
    }
    throw err;
  }
  const verified = await verifyRecordExists(client, objectName, created.id);
  if (!verified) throw new Error(`${objectName} ${created.id} was reported as created, but querying it back found no matching record — refusing to trust this Id.`);
  client.logDebug("native-create-response", `${objectName} ${created.id} created and verified via read-back.`);
  return created.id;
}

/* ── Schema resolution ── */

export interface BundleBasedPricingSchema {
  ruleDescribe: DescribeResult;
  conditionDescribe: DescribeResult;
  bbaDescribe: DescribeResult;
  ruleBundleField: ReferenceFieldResolution;
  ruleScheduleField: ReferenceFieldResolution;
  ruleActiveField: DescribeField | null;
  ruleEffFromField: DescribeField | null;
  ruleEffToField: DescribeField | null;
  conditionRuleField: ReferenceFieldResolution;
  conditionComponentField: ReferenceFieldResolution;
  conditionBundleField: ReferenceFieldResolution;
  conditionOperatorField: DescribeField | null;
  bbaBundleField: ReferenceFieldResolution;
  bbaSellingModelField: ReferenceFieldResolution;
  bbaRuleField: ReferenceFieldResolution;
  bbaScheduleField: ReferenceFieldResolution;
  bbaConditionField: DescribeField | null;
  bbaTypeField: DescribeField | null;
  bbaValueField: DescribeField | null;
  bbaEffFromField: DescribeField | null;
  bbaEffToField: DescribeField | null;
}

export async function prepareBundleBasedAdjustmentSchema(client: SalesforceClient): Promise<BundleBasedPricingSchema> {
  const cache = new SchemaCache(client);
  const ruleDescribe = await cache.get("BundleBasedAdjRule");
  const conditionDescribe = await cache.get("BundleAdjustmentCondition");
  const bbaDescribe = await cache.get("BundleBasedAdjustment");

  const ruleBundleField = resolveReferenceField(ruleDescribe, "Product2");
  const ruleScheduleField = resolveReferenceField(ruleDescribe, "PriceAdjustmentSchedule");
  const ruleActiveField = ruleDescribe.fields.find(f => /^IsActive$/i.test(f.name)) ?? null;
  const ruleEffFromField = ruleDescribe.fields.find(f => /^(EffectiveFrom|StartDate)$/i.test(f.name)) ?? null;
  const ruleEffToField = ruleDescribe.fields.find(f => /^(EffectiveTo|EndDate)$/i.test(f.name)) ?? null;

  const conditionRuleField = resolveReferenceField(conditionDescribe, "BundleBasedAdjRule");
  const conditionComponentField = resolveReferenceField(conditionDescribe, "Product2");
  // Component/Bundle both reference Product2 — the "component" field is whichever Product2 reference
  // ISN'T what a bundle-level field would be; when the org exposes only one Product2 reference on
  // Condition, that single field IS the component identity and there is no separate bundle reference.
  const conditionBundleField: ReferenceFieldResolution = { field: null, candidates: [] };
  const conditionOperatorField = conditionDescribe.fields.find(f => /^Operator$/i.test(f.name) && f.type === "picklist") ?? null;

  const bbaBundleField = resolveReferenceField(bbaDescribe, "Product2");
  const bbaSellingModelField = resolveReferenceField(bbaDescribe, "ProductSellingModel");
  const bbaRuleField = resolveReferenceField(bbaDescribe, "BundleBasedAdjRule");
  const bbaScheduleField = resolveReferenceField(bbaDescribe, "PriceAdjustmentSchedule");
  const bbaConditionField = bbaDescribe.fields.find(f => f.type === "reference" && f.referenceTo?.includes("BundleAdjustmentCondition")) ?? null;
  const bbaTypeField = bbaDescribe.fields.find(f => /adjustmenttype/i.test(f.name) && f.type === "picklist") ?? null;
  const bbaValueField = bbaDescribe.fields.find(f => /adjustmentvalue/i.test(f.name) || (/value/i.test(f.name) && (f.type === "currency" || f.type === "double" || f.type === "percent"))) ?? null;
  const bbaEffFromField = bbaDescribe.fields.find(f => /^(EffectiveFrom|StartDate)$/i.test(f.name)) ?? null;
  const bbaEffToField = bbaDescribe.fields.find(f => /^(EffectiveTo|EndDate)$/i.test(f.name)) ?? null;

  return {
    ruleDescribe, conditionDescribe, bbaDescribe,
    ruleBundleField, ruleScheduleField, ruleActiveField, ruleEffFromField, ruleEffToField,
    conditionRuleField, conditionComponentField, conditionBundleField, conditionOperatorField,
    bbaBundleField, bbaSellingModelField, bbaRuleField, bbaScheduleField, bbaConditionField, bbaTypeField, bbaValueField, bbaEffFromField, bbaEffToField,
  };
}

/* ── Price Adjustment Schedule (shared object — bundle-branded naming, own reuse scan) ── */

async function findCompatiblePriceAdjustmentSchedule(
  client: SalesforceClient, bundleProductId: string, productFieldName: string | null,
  proposedPayload: Record<string, unknown>, compareFields: string[],
): Promise<{ compatibleId: string | null; existingNames: Set<string> }> {
  const selectFields = ["Id", "Name", ...new Set(compareFields)];
  let records: Record<string, unknown>[] = [];
  try {
    const soql = productFieldName
      ? `SELECT ${selectFields.join(", ")} FROM PriceAdjustmentSchedule WHERE ${productFieldName} = '${soqlEscape(bundleProductId)}'`
      : `SELECT ${selectFields.join(", ")} FROM PriceAdjustmentSchedule LIMIT 200`;
    const res = await client.query<Record<string, unknown>>(soql);
    records = res.records;
  } catch {
    return { compatibleId: null, existingNames: new Set() };
  }
  client.logDebug("native-create-request", `Proposed PriceAdjustmentSchedule payload:\n${JSON.stringify(proposedPayload, null, 2)}`);
  let compatibleId: string | null = null;
  for (const rec of records) {
    const allMatch = compareFields.every(f => String(rec[f] ?? "") === String(proposedPayload[f] ?? ""));
    if (allMatch && !compatibleId) compatibleId = String(rec.Id);
  }
  return { compatibleId, existingNames: new Set(records.map(r => String(r.Name))) };
}

function generateUniqueScheduleName(baseName: string, existingNames: Set<string>, maxLength = 80): string {
  if (!existingNames.has(baseName)) return baseName;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const tag = ` (${suffix})`;
    const candidate = `${baseName.slice(0, Math.max(0, maxLength - tag.length))}${tag}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  throw new Error(`Could not generate a unique Price Adjustment Schedule name from base "${baseName}".`);
}

export async function resolveOrCreateBundlePriceAdjustmentSchedule(
  client: SalesforceClient,
  args: { bundle: { id: string; name: string }; sellingModelId: string | null; procedureName: string },
  steps: ProcedureStepLite[],
  onProgress?: (message: string) => void,
): Promise<string> {
  step(steps, "create-schedule", "start", "Resolving or creating the Price Adjustment Schedule.");
  const pasDescribe = await new SchemaCache(client).get("PriceAdjustmentSchedule");

  const scheduleBaseName = `${args.procedureName} Bundle Schedule`.slice(0, 80);
  const productField = resolveReferenceField(pasDescribe, "Product2");
  const sellingModelField = resolveReferenceField(pasDescribe, "ProductSellingModel");
  const pricebookField = resolveReferenceField(pasDescribe, "Pricebook2");
  const scheduleTypeField = pasDescribe.fields.find(f => /^ScheduleType$/i.test(f.name) && f.type === "picklist");
  const adjustmentMethodField = pasDescribe.fields.find(f => /^AdjustmentMethod$/i.test(f.name) && f.type === "picklist");
  const effFromField = pasDescribe.fields.find(f => /^(EffectiveFrom|StartDate)$/i.test(f.name));
  const effToField = pasDescribe.fields.find(f => /^(EffectiveTo|EndDate)$/i.test(f.name));

  const payload: Record<string, unknown> = { Name: scheduleBaseName };
  const resolvedLookups: ResolvedLookup[] = [];
  if (productField.field) { payload[productField.field.name] = args.bundle.id; resolvedLookups.push({ targetObject: "Product2", field: productField.field, value: args.bundle.id }); }
  if (sellingModelField.field && args.sellingModelId) { payload[sellingModelField.field.name] = args.sellingModelId; resolvedLookups.push({ targetObject: "ProductSellingModel", field: sellingModelField.field, value: args.sellingModelId }); }
  if (pricebookField.field) {
    try {
      const pb = await client.query<{ Id: string }>("SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1");
      if (pb.records[0]) { payload[pricebookField.field.name] = pb.records[0].Id; resolvedLookups.push({ targetObject: "Pricebook2", field: pricebookField.field, value: pb.records[0].Id }); }
    } catch { /* non-fatal */ }
  }
  if (scheduleTypeField) {
    const active = (scheduleTypeField.picklistValues ?? []).filter(v => v.active);
    const value = active.find(v => /bundle/i.test(v.value) || /bundle/i.test(v.label))?.value ?? active[0]?.value ?? resolveDefaultPicklistValue(scheduleTypeField);
    if (value) payload[scheduleTypeField.name] = value;
  }
  if (adjustmentMethodField) {
    const active = (adjustmentMethodField.picklistValues ?? []).filter(v => v.active);
    const value = active.find(v => /bundle/i.test(v.value) || /bundle/i.test(v.label))?.value
      ?? active.find(v => !/range|slab|tier|volume|attribute/i.test(v.value) && !/range|slab|tier|volume|attribute/i.test(v.label))?.value
      ?? active[0]?.value ?? resolveDefaultPicklistValue(adjustmentMethodField);
    if (value) payload[adjustmentMethodField.name] = value;
  }
  if (effFromField) payload[effFromField.name] = todayISO();
  if (effToField) payload[effToField.name] = oneYearFromTodayISO();

  const scheduleCompareFields = [productField.field?.name, sellingModelField.field?.name, scheduleTypeField?.name, adjustmentMethodField?.name]
    .filter((n): n is string => !!n);
  const { compatibleId, existingNames } = await findCompatiblePriceAdjustmentSchedule(
    client, args.bundle.id, productField.field?.name ?? null, payload, scheduleCompareFields,
  );

  let scheduleId: string;
  if (compatibleId) {
    scheduleId = compatibleId;
    step(steps, "create-schedule", "success", `Reusing existing PriceAdjustmentSchedule ${scheduleId}.`);
    onProgress?.("Reusing existing Price Adjustment Schedule.");
  } else {
    const uniqueName = generateUniqueScheduleName(scheduleBaseName, existingNames);
    payload.Name = uniqueName;
    scheduleId = await guardedCreate(client, "PriceAdjustmentSchedule", pasDescribe, payload, resolvedLookups, "create-schedule");
    step(steps, "create-schedule", "success", `Created PriceAdjustmentSchedule ${scheduleId} ("${uniqueName}").`);
    onProgress?.("Created Price Adjustment Schedule.");
  }
  return scheduleId;
}

/* ── BundleBasedAdjRule ── */

function sanitizeBundleRuleName(bundleName: string, componentName: string): string {
  const raw = `${bundleName}_${componentName}_Rule`;
  return raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 80);
}

export interface BundleRulePlan {
  row: BundleComponentPlanRow;
  ruleId: string;
  reusedExisting: boolean;
  conditionIds: string[];
  existingAdjustmentId?: string;
  ruleBundleId: string | null;
}

async function resolveBundleConsistentRuleCandidate(
  client: SalesforceClient, schema: BundleBasedPricingSchema, ruleName: string, bundleProductId: string,
): Promise<{ ruleId: string; ruleBundleId: string | null } | null> {
  const selectFields = ["Id", ...(schema.ruleBundleField.field ? [schema.ruleBundleField.field.name] : [])];
  let candidates: Record<string, unknown>[] = [];
  try {
    const res = await client.query<Record<string, unknown>>(
      `SELECT ${selectFields.join(", ")} FROM BundleBasedAdjRule WHERE Name = '${soqlEscape(ruleName)}' LIMIT 200`,
    );
    candidates = res.records;
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;

  for (const rec of candidates) {
    const ruleBundleId = schema.ruleBundleField.field ? (rec[schema.ruleBundleField.field.name] as string | null) ?? null : null;
    const bundleMatch = !schema.ruleBundleField.field || ruleBundleId === bundleProductId;
    if (bundleMatch) {
      client.logDebug("native-create-request", `Reusing BundleBasedAdjRule candidate "${ruleName}" (${rec.Id}) — bundle match confirmed.`);
      return { ruleId: String(rec.Id), ruleBundleId: schema.ruleBundleField.field ? ruleBundleId : null };
    }
    client.logDebug("native-create-request", `Rejected BundleBasedAdjRule candidate "${ruleName}" (${rec.Id}) — bundle mismatch (expected ${bundleProductId}, found ${ruleBundleId}).`);
  }
  return null;
}

export async function createOrReuseBundleBasedAdjRules(
  client: SalesforceClient,
  schema: BundleBasedPricingSchema,
  args: { bundle: { id: string; name: string }; sellingModelId: string | null; components: BundleComponentPlanRow[] },
  scheduleId: string,
  steps: ProcedureStepLite[],
  onProgress?: (message: string) => void,
): Promise<{ plans: BundleRulePlan[]; ruleIds: string[] }> {
  step(steps, "create-rule", "start", "Creating/reusing Bundle-Based Adjustment Rules.");
  const effectiveFrom = todayISO();
  const effectiveTo = oneYearFromTodayISO();
  const plans: BundleRulePlan[] = [];
  let newlyCreated = 0, reusedWithAdjustment = 0, reusedWithoutAdjustment = 0;

  for (const row of args.components) {
    const ruleName = sanitizeBundleRuleName(args.bundle.name, row.componentName);
    const candidate = await resolveBundleConsistentRuleCandidate(client, schema, ruleName, args.bundle.id);

    let ruleId: string;
    let ruleBundleId: string | null;
    let existingAdjustmentId: string | undefined;
    let reusedExisting = false;

    if (candidate) {
      ruleId = candidate.ruleId;
      ruleBundleId = candidate.ruleBundleId;
      reusedExisting = true;
      try {
        const selectFields = ["Id",
          ...(schema.bbaBundleField.field ? [schema.bbaBundleField.field.name] : []),
          ...(schema.bbaScheduleField.field ? [schema.bbaScheduleField.field.name] : []),
          ...(schema.bbaSellingModelField.field ? [schema.bbaSellingModelField.field.name] : []),
          ...(schema.bbaEffFromField ? [schema.bbaEffFromField.name] : []),
          ...(schema.bbaEffToField ? [schema.bbaEffToField.name] : []),
        ];
        const res = await client.query<Record<string, unknown>>(
          `SELECT ${selectFields.join(", ")} FROM BundleBasedAdjustment WHERE ${schema.bbaRuleField.field!.name} = '${soqlEscape(ruleId)}' LIMIT 1`,
        );
        const existing = res.records[0];
        if (existing) {
          const bundleMatches = !schema.bbaBundleField.field || existing[schema.bbaBundleField.field.name] === args.bundle.id;
          const scheduleMatches = !schema.bbaScheduleField.field || existing[schema.bbaScheduleField.field.name] === scheduleId;
          const sellingModelMatches = !schema.bbaSellingModelField.field || (existing[schema.bbaSellingModelField.field.name] ?? null) === (args.sellingModelId ?? null);
          const effFromMatches = !schema.bbaEffFromField || normalizeDateValue(existing[schema.bbaEffFromField.name]) === normalizeDateValue(effectiveFrom);
          const effToMatches = !schema.bbaEffToField || normalizeDateValue(existing[schema.bbaEffToField.name]) === normalizeDateValue(effectiveTo);
          if (bundleMatches && scheduleMatches && sellingModelMatches && effFromMatches && effToMatches) {
            existingAdjustmentId = String(existing.Id);
            reusedWithAdjustment++;
          } else {
            reusedWithoutAdjustment++;
          }
        } else {
          reusedWithoutAdjustment++;
        }
      } catch {
        reusedWithoutAdjustment++;
      }
    } else {
      const payload: Record<string, unknown> = { Name: ruleName };
      const resolvedLookups: ResolvedLookup[] = [];
      if (schema.ruleBundleField.field) { payload[schema.ruleBundleField.field.name] = args.bundle.id; resolvedLookups.push({ targetObject: "Product2", field: schema.ruleBundleField.field, value: args.bundle.id }); }
      if (schema.ruleScheduleField.field) { payload[schema.ruleScheduleField.field.name] = scheduleId; resolvedLookups.push({ targetObject: "PriceAdjustmentSchedule", field: schema.ruleScheduleField.field, value: scheduleId }); }
      if (schema.ruleEffFromField) payload[schema.ruleEffFromField.name] = effectiveFrom;
      if (schema.ruleEffToField) payload[schema.ruleEffToField.name] = effectiveTo;
      if (schema.ruleActiveField) payload[schema.ruleActiveField.name] = true;
      ruleId = await guardedCreate(client, "BundleBasedAdjRule", schema.ruleDescribe, payload, resolvedLookups, "create-rule");
      ruleBundleId = schema.ruleBundleField.field ? args.bundle.id : null;
      newlyCreated++;
    }

    plans.push({ row, ruleId, reusedExisting, conditionIds: [], existingAdjustmentId, ruleBundleId });
  }

  step(steps, "create-rule", "success", `Rules: ${newlyCreated} created, ${reusedWithAdjustment} reused (with adjustment), ${reusedWithoutAdjustment} reused (adjustment still needed).`);
  onProgress?.(`Resolved ${plans.length} Bundle-Based Adjustment Rule(s).`);
  return { plans, ruleIds: plans.map(p => p.ruleId) };
}

/* ── BundleAdjustmentCondition ── */

async function findExistingBundleAdjustmentCondition(
  client: SalesforceClient, schema: BundleBasedPricingSchema, ruleId: string, componentProductId: string, bundleProductId: string,
): Promise<string | null> {
  const whereClauses = [`${schema.conditionRuleField.field!.name} = '${soqlEscape(ruleId)}'`, `${schema.conditionComponentField.field!.name} = '${soqlEscape(componentProductId)}'`];
  if (schema.conditionBundleField.field) whereClauses.push(`${schema.conditionBundleField.field.name} = '${soqlEscape(bundleProductId)}'`);
  try {
    const res = await client.query<{ Id: string }>(
      `SELECT Id FROM BundleAdjustmentCondition WHERE ${whereClauses.join(" AND ")} LIMIT 1`,
    );
    return res.records[0]?.Id ?? null;
  } catch {
    return null;
  }
}

export async function createBundleAdjustmentConditions(
  client: SalesforceClient,
  schema: BundleBasedPricingSchema,
  args: { bundle: { id: string; name: string } },
  plans: BundleRulePlan[],
  steps: ProcedureStepLite[],
  onProgress?: (message: string) => void,
): Promise<{ conditionIds: string[]; reusedConditionIds: string[] }> {
  step(steps, "create-condition", "start", "Creating/reusing Bundle Adjustment Conditions.");
  if (!schema.conditionRuleField.field || !schema.conditionComponentField.field) {
    throw new Error("BundleAdjustmentCondition on this org has no resolvable BundleBasedAdjRule and/or Product2 reference field — cannot create conditions.");
  }
  const conditionIds: string[] = [];
  const reusedConditionIds: string[] = [];

  const equalValue = schema.conditionOperatorField
    ? (schema.conditionOperatorField.picklistValues ?? []).filter(v => v.active).find(v => /^equal$/i.test(v.value))?.value
      ?? (schema.conditionOperatorField.picklistValues ?? []).find(v => v.active)?.value
    : undefined;

  for (const plan of plans) {
    if (plan.existingAdjustmentId) continue; // an already-verified reused adjustment already has its conditions
    const existingId = await findExistingBundleAdjustmentCondition(client, schema, plan.ruleId, plan.row.componentProductId, args.bundle.id);
    if (existingId) {
      plan.conditionIds.push(existingId);
      reusedConditionIds.push(existingId);
      continue;
    }
    const payload: Record<string, unknown> = {
      [schema.conditionRuleField.field.name]: plan.ruleId,
      [schema.conditionComponentField.field.name]: plan.row.componentProductId,
    };
    if (equalValue && schema.conditionOperatorField) payload[schema.conditionOperatorField.name] = equalValue;
    if (schema.conditionBundleField.field) payload[schema.conditionBundleField.field.name] = args.bundle.id;

    const resolvedLookups: ResolvedLookup[] = [
      { targetObject: "BundleBasedAdjRule", field: schema.conditionRuleField.field, value: plan.ruleId },
      { targetObject: "Product2", field: schema.conditionComponentField.field, value: plan.row.componentProductId },
    ];
    const conditionId = await guardedCreate(client, "BundleAdjustmentCondition", schema.conditionDescribe, payload, resolvedLookups, "create-condition");
    plan.conditionIds.push(conditionId);
    conditionIds.push(conditionId);
  }

  step(steps, "create-condition", "success", `Conditions: ${conditionIds.length} created, ${reusedConditionIds.length} reused.`);
  onProgress?.(`Resolved ${conditionIds.length + reusedConditionIds.length} Bundle Adjustment Condition(s).`);
  return { conditionIds, reusedConditionIds };
}

/* ── BundleBasedAdjustment ── */

export interface BundleBasedAdjustmentIdentity {
  bundleProductId: string;
  productSellingModelId: string | null;
  priceAdjustmentScheduleId: string;
  effectiveFrom: string;
  effectiveTo: string;
  componentSignature: string;
}

async function computeRuleComponentSignature(client: SalesforceClient, schema: BundleBasedPricingSchema, ruleId: string): Promise<{ signature: string; queryFailed: boolean }> {
  try {
    const res = await client.query<Record<string, unknown>>(
      `SELECT ${schema.conditionComponentField.field!.name} FROM BundleAdjustmentCondition WHERE ${schema.conditionRuleField.field!.name} = '${soqlEscape(ruleId)}'`,
    );
    const tokens = res.records.map(r => String(r[schema.conditionComponentField.field!.name] ?? "")).filter(Boolean).sort();
    return { signature: tokens.join("|"), queryFailed: false };
  } catch {
    return { signature: "", queryFailed: true };
  }
}

async function findExistingBundleBasedAdjustment(
  client: SalesforceClient, schema: BundleBasedPricingSchema, requested: BundleBasedAdjustmentIdentity,
): Promise<{ id: string | null; candidateCount: number }> {
  const selectFields = ["Id",
    ...(schema.bbaSellingModelField.field ? [schema.bbaSellingModelField.field.name] : []),
    ...(schema.bbaRuleField.field ? [schema.bbaRuleField.field.name] : []),
    ...(schema.bbaEffFromField ? [schema.bbaEffFromField.name] : []),
    ...(schema.bbaEffToField ? [schema.bbaEffToField.name] : []),
  ];
  const whereClauses: string[] = [];
  if (schema.bbaBundleField.field) whereClauses.push(`${schema.bbaBundleField.field.name} = '${soqlEscape(requested.bundleProductId)}'`);
  if (schema.bbaScheduleField.field) whereClauses.push(`${schema.bbaScheduleField.field.name} = '${soqlEscape(requested.priceAdjustmentScheduleId)}'`);
  let records: Record<string, unknown>[] = [];
  try {
    const res = await client.query<Record<string, unknown>>(
      `SELECT ${[...new Set(selectFields)].join(", ")} FROM BundleBasedAdjustment${whereClauses.length ? ` WHERE ${whereClauses.join(" AND ")}` : ""}`,
    );
    records = res.records;
  } catch {
    return { id: null, candidateCount: 0 };
  }

  for (const rec of records) {
    if (schema.bbaSellingModelField.field && (rec[schema.bbaSellingModelField.field.name] ?? null) !== (requested.productSellingModelId ?? null)) continue;
    if (schema.bbaEffFromField && normalizeDateValue(rec[schema.bbaEffFromField.name]) !== normalizeDateValue(requested.effectiveFrom)) continue;
    if (schema.bbaEffToField && normalizeDateValue(rec[schema.bbaEffToField.name]) !== normalizeDateValue(requested.effectiveTo)) continue;
    const candidateRuleId = schema.bbaRuleField.field ? (rec[schema.bbaRuleField.field.name] as string | null) : null;
    if (!candidateRuleId) continue;
    const { signature, queryFailed } = await computeRuleComponentSignature(client, schema, candidateRuleId);
    if (!queryFailed && signature && signature === requested.componentSignature) {
      return { id: String(rec.Id), candidateCount: records.length };
    }
  }
  return { id: null, candidateCount: records.length };
}

function isBundleAdjustmentDuplicateError(err: unknown): boolean {
  if (!(err instanceof SalesforceError)) return false;
  if (err.errorCode === "FIELD_INTEGRITY_EXCEPTION" && /bundle.?based adjustment/i.test(err.message ?? "")) return true;
  return /bundle.?based adjustment with the selected/i.test(err.message ?? "");
}
function isComponentConsistencyError(err: unknown): boolean {
  if (!(err instanceof SalesforceError)) return false;
  const msg = err.message ?? "";
  return /select the same product record/i.test(msg) || /associate the same (product|bundle)/i.test(msg);
}

export async function createBundleBasedAdjustments(
  client: SalesforceClient,
  schema: BundleBasedPricingSchema,
  args: { bundle: { id: string; name: string }; sellingModelId: string | null },
  scheduleId: string,
  plans: BundleRulePlan[],
  steps: ProcedureStepLite[],
  onProgress?: (message: string) => void,
): Promise<{ adjustmentIds: string[]; reusedAdjustmentIds: string[]; decisions: BundleAdjustmentDecision[] }> {
  step(steps, "create-adjustment", "start", "Creating/reusing Bundle-Based Adjustments.");
  const effectiveFrom = todayISO();
  const effectiveTo = oneYearFromTodayISO();
  const adjustmentIds: string[] = [];
  const reusedAdjustmentIds: string[] = [];
  const decisions: BundleAdjustmentDecision[] = [];

  for (const plan of plans) {
    if (plan.existingAdjustmentId) {
      reusedAdjustmentIds.push(plan.existingAdjustmentId);
      decisions.push({
        step: "bundle-based-adjustment", ruleId: plan.ruleId,
        requestedConfiguration: { bundleProductId: args.bundle.id, componentProductId: plan.row.componentProductId, scheduleId, effectiveFrom, effectiveTo },
        componentSignature: plan.row.componentProductId, candidateAdjustmentId: plan.existingAdjustmentId, candidateCount: 1, componentMatch: true,
        decision: "REUSE", adjustmentId: plan.existingAdjustmentId,
      });
      continue;
    }

    const { signature } = await computeRuleComponentSignature(client, schema, plan.ruleId);
    const requested: BundleBasedAdjustmentIdentity = {
      bundleProductId: args.bundle.id, productSellingModelId: args.sellingModelId, priceAdjustmentScheduleId: scheduleId,
      effectiveFrom, effectiveTo, componentSignature: signature,
    };
    const found = await findExistingBundleBasedAdjustment(client, schema, requested);
    if (found.id) {
      reusedAdjustmentIds.push(found.id);
      decisions.push({
        step: "bundle-based-adjustment", ruleId: plan.ruleId,
        requestedConfiguration: { bundleProductId: args.bundle.id, componentProductId: plan.row.componentProductId, scheduleId, effectiveFrom, effectiveTo },
        componentSignature: signature, candidateAdjustmentId: found.id, candidateCount: found.candidateCount, componentMatch: true,
        decision: "REUSE", adjustmentId: found.id,
      });
      continue;
    }

    const payload: Record<string, unknown> = {};
    const lookups: ResolvedLookup[] = [];
    if (schema.bbaBundleField.field) { payload[schema.bbaBundleField.field.name] = args.bundle.id; lookups.push({ targetObject: "Product2", field: schema.bbaBundleField.field, value: args.bundle.id }); }
    if (schema.bbaSellingModelField.field && args.sellingModelId) { payload[schema.bbaSellingModelField.field.name] = args.sellingModelId; lookups.push({ targetObject: "ProductSellingModel", field: schema.bbaSellingModelField.field, value: args.sellingModelId }); }
    if (schema.bbaRuleField.field) { payload[schema.bbaRuleField.field.name] = plan.ruleId; lookups.push({ targetObject: "BundleBasedAdjRule", field: schema.bbaRuleField.field, value: plan.ruleId }); }
    if (schema.bbaScheduleField.field) { payload[schema.bbaScheduleField.field.name] = scheduleId; lookups.push({ targetObject: "PriceAdjustmentSchedule", field: schema.bbaScheduleField.field, value: scheduleId }); }
    if (schema.bbaConditionField && plan.conditionIds[0]) { payload[schema.bbaConditionField.name] = plan.conditionIds[0]; lookups.push({ targetObject: "BundleAdjustmentCondition", field: schema.bbaConditionField, value: plan.conditionIds[0] }); }
    if (schema.bbaTypeField) {
      const active = (schema.bbaTypeField.picklistValues ?? []).filter(v => v.active);
      const value = active.find(v => new RegExp(plan.row.adjustmentType, "i").test(v.value) || new RegExp(plan.row.adjustmentType, "i").test(v.label))?.value ?? active[0]?.value;
      if (value) payload[schema.bbaTypeField.name] = value;
    }
    if (schema.bbaValueField) payload[schema.bbaValueField.name] = plan.row.adjustment;
    if (schema.bbaEffFromField) payload[schema.bbaEffFromField.name] = effectiveFrom;
    if (schema.bbaEffToField) payload[schema.bbaEffToField.name] = effectiveTo;

    let adjustmentId: string;
    try {
      adjustmentId = await guardedCreate(client, "BundleBasedAdjustment", schema.bbaDescribe, payload, lookups, "create-adjustment");
    } catch (err) {
      if (isComponentConsistencyError(err)) {
        throw new Error(`Salesforce rejected this Bundle-Based Adjustment for Rule ${plan.ruleId} because of a product/bundle consistency conflict: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (isBundleAdjustmentDuplicateError(err)) {
        const recheck = await findExistingBundleBasedAdjustment(client, schema, requested);
        if (recheck.id) {
          reusedAdjustmentIds.push(recheck.id);
          decisions.push({
            step: "bundle-based-adjustment", ruleId: plan.ruleId,
            requestedConfiguration: { bundleProductId: args.bundle.id, componentProductId: plan.row.componentProductId, scheduleId, effectiveFrom, effectiveTo },
            componentSignature: signature, candidateAdjustmentId: recheck.id, candidateCount: recheck.candidateCount, componentMatch: true,
            decision: "REUSE", adjustmentId: recheck.id,
          });
          continue;
        }
      }
      throw err;
    }
    adjustmentIds.push(adjustmentId);
    decisions.push({
      step: "bundle-based-adjustment", ruleId: plan.ruleId,
      requestedConfiguration: { bundleProductId: args.bundle.id, componentProductId: plan.row.componentProductId, scheduleId, effectiveFrom, effectiveTo },
      componentSignature: signature, candidateAdjustmentId: null, candidateCount: 0, componentMatch: true,
      decision: "CREATE", adjustmentId,
    });
  }

  step(steps, "create-adjustment", "success", `Adjustments: ${adjustmentIds.length} created, ${reusedAdjustmentIds.length} reused.`);
  onProgress?.(`Resolved ${adjustmentIds.length + reusedAdjustmentIds.length} Bundle-Based Adjustment(s).`);
  return { adjustmentIds, reusedAdjustmentIds, decisions };
}

/* ── Read-back verification ── */

export interface NativeCreationResult { scheduleId: string; ruleIds: string[]; conditionIds: string[]; adjustmentIds: string[]; }

export async function verifyAdjustmentRecordsReadBack(client: SalesforceClient, result: NativeCreationResult): Promise<{ scheduleVerified: boolean; ruleCount: number; conditionCount: number; adjustmentCount: number }> {
  const scheduleVerified = await verifyRecordExists(client, "PriceAdjustmentSchedule", result.scheduleId);
  let ruleCount = 0, conditionCount = 0, adjustmentCount = 0;
  for (const id of result.ruleIds) if (await verifyRecordExists(client, "BundleBasedAdjRule", id)) ruleCount++;
  for (const id of result.conditionIds) if (await verifyRecordExists(client, "BundleAdjustmentCondition", id)) conditionCount++;
  for (const id of result.adjustmentIds) if (await verifyRecordExists(client, "BundleBasedAdjustment", id)) adjustmentCount++;
  return { scheduleVerified, ruleCount, conditionCount, adjustmentCount };
}

/* ── Runtime lookup replica ── */

export interface RuntimeBundleAdjustmentTrace {
  bundleProductId: string;
  productSellingModelId: string | null;
  priceAdjustmentScheduleId: string;
  componentProductId: string;
  componentName: string;
  ruleId: string | null;
  conditionId: string | null;
  adjustmentId: string | null;
  adjustmentType: string | null;
  adjustmentValue: unknown;
  resolved: boolean;
  reason: string;
}

/** Mimics Salesforce's own runtime BundleDiscount evaluation: Component -> Condition -> Rule ->
 * Adjustment (matched by Bundle+SellingModel+Schedule), mirroring the exact same never-throw-for-no-match,
 * always-hard-fail-for-ambiguity discipline as attribute-based's `resolveRuntimeAttributeAdjustment`. */
export async function resolveRuntimeBundleAdjustment(
  client: SalesforceClient, schema: BundleBasedPricingSchema,
  args: { bundleProductId: string; sellingModelId: string | null; scheduleId: string; componentProductId: string; componentName: string },
): Promise<RuntimeBundleAdjustmentTrace> {
  const base = { bundleProductId: args.bundleProductId, productSellingModelId: args.sellingModelId, priceAdjustmentScheduleId: args.scheduleId, componentProductId: args.componentProductId, componentName: args.componentName };

  if (!schema.conditionRuleField.field || !schema.conditionComponentField.field) {
    return { ...base, ruleId: null, conditionId: null, adjustmentId: null, adjustmentType: null, adjustmentValue: null, resolved: false, reason: "BundleAdjustmentCondition schema could not be resolved." };
  }

  let conditionRows: Record<string, unknown>[] = [];
  try {
    const whereClauses = [`${schema.conditionComponentField.field.name} = '${soqlEscape(args.componentProductId)}'`];
    if (schema.conditionBundleField.field) whereClauses.push(`${schema.conditionBundleField.field.name} = '${soqlEscape(args.bundleProductId)}'`);
    const res = await client.query<Record<string, unknown>>(
      `SELECT Id, ${schema.conditionRuleField.field.name} FROM BundleAdjustmentCondition WHERE ${whereClauses.join(" AND ")}`,
    );
    conditionRows = res.records;
  } catch (err) {
    return { ...base, ruleId: null, conditionId: null, adjustmentId: null, adjustmentType: null, adjustmentValue: null, resolved: false, reason: `Condition lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (conditionRows.length === 0) {
    return { ...base, ruleId: null, conditionId: null, adjustmentId: null, adjustmentType: null, adjustmentValue: null, resolved: false, reason: "This component has no configured pricing rule; no adjustment applies (this is a valid outcome, not an error)." };
  }

  const distinctAdjustmentIds = new Set<string>();
  let matchedAdjustment: { id: string; ruleId: string; typeValue: unknown; value: unknown } | null = null;
  for (const cond of conditionRows) {
    const ruleId = String(cond[schema.conditionRuleField.field.name]);
    const selectFields = ["Id",
      ...(schema.bbaBundleField.field ? [schema.bbaBundleField.field.name] : []),
      ...(schema.bbaSellingModelField.field ? [schema.bbaSellingModelField.field.name] : []),
      ...(schema.bbaScheduleField.field ? [schema.bbaScheduleField.field.name] : []),
      ...(schema.bbaTypeField ? [schema.bbaTypeField.name] : []),
      ...(schema.bbaValueField ? [schema.bbaValueField.name] : []),
    ];
    try {
      const res = await client.query<Record<string, unknown>>(
        `SELECT ${selectFields.join(", ")} FROM BundleBasedAdjustment WHERE ${schema.bbaRuleField.field!.name} = '${soqlEscape(ruleId)}' LIMIT 5`,
      );
      for (const rec of res.records) {
        const bundleMatches = !schema.bbaBundleField.field || rec[schema.bbaBundleField.field.name] === args.bundleProductId;
        const sellingModelMatches = !schema.bbaSellingModelField.field || (rec[schema.bbaSellingModelField.field.name] ?? null) === (args.sellingModelId ?? null);
        const scheduleMatches = !schema.bbaScheduleField.field || rec[schema.bbaScheduleField.field.name] === args.scheduleId;
        if (bundleMatches && sellingModelMatches && scheduleMatches) {
          distinctAdjustmentIds.add(String(rec.Id));
          matchedAdjustment = {
            id: String(rec.Id), ruleId,
            typeValue: schema.bbaTypeField ? rec[schema.bbaTypeField.name] : null,
            value: schema.bbaValueField ? rec[schema.bbaValueField.name] : null,
          };
        }
      }
    } catch { /* skip this condition's rule on query failure — never fatal for the whole trace */ }
  }

  if (distinctAdjustmentIds.size === 0) {
    return { ...base, ruleId: null, conditionId: conditionRows[0] ? String(conditionRows[0].Id) : null, adjustmentId: null, adjustmentType: null, adjustmentValue: null, resolved: false, reason: "No Bundle-Based Adjustment applies at runtime with this schedule/selling model." };
  }
  if (distinctAdjustmentIds.size > 1) {
    return { ...base, ruleId: null, conditionId: null, adjustmentId: null, adjustmentType: null, adjustmentValue: null, resolved: false, reason: `Ambiguous — ${distinctAdjustmentIds.size} distinct Bundle-Based Adjustments matched. Refusing to guess which one Salesforce would apply at runtime.` };
  }

  return {
    ...base, ruleId: matchedAdjustment!.ruleId, conditionId: conditionRows.find(c => String(c[schema.conditionRuleField.field!.name]) === matchedAdjustment!.ruleId)?.Id as string ?? null,
    adjustmentId: matchedAdjustment!.id, adjustmentType: matchedAdjustment!.typeValue as string | null, adjustmentValue: matchedAdjustment!.value,
    resolved: true, reason: "Exactly one applicable Bundle-Based Adjustment resolved.",
  };
}
