/**
 * Bundle-Based Pricing — native Salesforce record CRUD + idempotency.
 *
 * §Live-org correction — an earlier version of this module modeled Bundle-Based Adjustments as a
 * `BundleBasedAdjRule` + `BundleAdjustmentCondition` + `BundleBasedAdjustment` junction (a guess mirrored
 * from Attribute-Based Pricing's Rule/Condition objects). Neither `BundleBasedAdjRule` nor
 * `BundleAdjustmentCondition` exists in Revenue Cloud: Describe returns NOT_FOUND for both, so the pipeline
 * failed its pre-flight on every org. The real model is ONE `BundleBasedAdjustment` row per (schedule,
 * parent bundle, child component, root bundle, three selling models), carrying `AdjustmentType` /
 * `AdjustmentValue` directly. Those rows ARE the entries of the Bundle-Based Adjustment Decision Table
 * (its SourceObject), so "create lookup-table entries" and "create adjustments" are the same write.
 *
 * Idempotency: a row's identity is exactly the set of Equals-matched INPUT columns of the resolved lookup
 * table — the same key Salesforce matches at runtime. Re-running with identical input REUSES the row; a
 * changed type/value UPDATES that row in place; two rows with the same key are reported as ambiguous
 * (runtime would not know which to apply) instead of adding a third. Never deletes a record.
 */
import { SalesforceError, type SalesforceClient, type DescribeResult, soqlEscape } from "@/lib/salesforce/client";
import {
  SchemaCache, fillRequiredPicklistDefaults, extractSalesforceFields, diagnoseCreateRejection,
  formatCreateRejectionDiagnosis, buildSchemaDiagnosis, logSchemaDiagnosis, logObjectCreation,
  type ResolvedLookup,
} from "@/lib/pricing-rules/attribute-based/create/nativeSchemaResolver";
import type { ProcedureStepLite, BundleComponentPlanRow, ExtractedAdjustmentType } from "../types";
import type { BundleAdjustmentDecision } from "./types";
import type { ResolvedBundleLookupTable } from "./lookupTableResolver";
import { bundleLog } from "./bundleLog";

function step(steps: ProcedureStepLite[], name: string, status: ProcedureStepLite["status"], message: string) {
  steps.push({ step: name, status, message, timestamp: Date.now() });
}

async function verifyRecordExists(client: SalesforceClient, sobject: string, id: string): Promise<boolean> {
  try {
    const res = await client.query<{ Id: string }>(`SELECT Id FROM ${sobject} WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
    return res.records.length > 0;
  } catch {
    return false;
  }
}

/** Never trust a create response's Id alone — same discipline as attribute-based's own guardedCreate. */
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

/* ── Schema ── */

/** BundleBasedAdjustment fields this pipeline knows how to populate from a (bundle, component) pair. */
export const POPULATABLE_KEY_FIELDS = [
  "PriceAdjustmentScheduleId", "ProductId", "ParentProductId", "RootBundleId",
  "ProductSellingModelId", "ParentProductSellingModelId", "RootProductSellingModelId",
] as const;
export type BundleAdjustmentKeyField = typeof POPULATABLE_KEY_FIELDS[number];
const DATE_RANGE_FIELDS = new Set(["EffectiveFrom", "EffectiveTo"]);
const REQUIRED_BBA_FIELDS = ["PriceAdjustmentScheduleId", "ProductId", "ParentProductId", "RootBundleId", "AdjustmentType", "AdjustmentValue", "EffectiveFrom"];

export interface BundleBasedPricingSchema {
  bbaDescribe: DescribeResult;
  /** Equals-matched INPUT columns of the lookup table — the row identity key, in table order. */
  keyFields: BundleAdjustmentKeyField[];
  adjustmentTypeValues: string[];
  hasScheduleTypeField: boolean;
}

export async function prepareBundleBasedAdjustmentSchema(client: SalesforceClient, table: ResolvedBundleLookupTable): Promise<BundleBasedPricingSchema> {
  const bbaDescribe = await new SchemaCache(client).get("BundleBasedAdjustment");
  const fieldNames = new Set(bbaDescribe.fields.map(f => f.name));
  const missing = REQUIRED_BBA_FIELDS.filter(f => !fieldNames.has(f));
  if (missing.length > 0) {
    throw new Error(`BundleBasedAdjustment on this org is missing expected field(s): ${missing.join(", ")}. Actual fields: ${[...fieldNames].sort().join(", ")}.`);
  }

  const keyFields: BundleAdjustmentKeyField[] = [];
  const unsupported: string[] = [];
  for (const input of table.inputs) {
    if (DATE_RANGE_FIELDS.has(input.fieldName)) continue;
    if ((POPULATABLE_KEY_FIELDS as readonly string[]).includes(input.fieldName)) keyFields.push(input.fieldName as BundleAdjustmentKeyField);
    else unsupported.push(input.fieldName);
  }
  if (unsupported.length > 0) {
    throw new Error(
      `Lookup table "${table.developerName}" matches on INPUT column(s) [${unsupported.join(", ")}] that this pipeline cannot populate on a BundleBasedAdjustment row. ` +
      `Supported key columns: ${POPULATABLE_KEY_FIELDS.join(", ")} (+ EffectiveFrom/EffectiveTo).`,
    );
  }

  const typeField = bbaDescribe.fields.find(f => f.name === "AdjustmentType");
  const adjustmentTypeValues = (typeField?.picklistValues ?? []).filter(v => v.active).map(v => v.value);
  return { bbaDescribe, keyFields, adjustmentTypeValues, hasScheduleTypeField: bbaDescribe.fields.some(f => f.name === "ScheduleType" && f.createable) };
}

/** The app's adjustment vocabulary → BundleBasedAdjustment.AdjustmentType picklist value. */
export function mapAdjustmentType(type: ExtractedAdjustmentType, activeValues: string[]): string {
  const wanted = type === "fixed" ? "Amount" : type === "percentage" ? "Percentage" : "Override";
  const match = activeValues.find(v => v.toLowerCase() === wanted.toLowerCase());
  if (!match) throw new Error(`BundleBasedAdjustment.AdjustmentType has no active "${wanted}" value (needed for a "${type}" adjustment). Active values: ${activeValues.join(", ") || "none"}.`);
  return match;
}

/* ── Selling models ── */

export interface BundleSellingModels {
  /** Every selling model the bundle can be quoted with (one lookup key per option). */
  parentSellingModelIds: string[];
  /** componentProductId → every selling model that component can be quoted with inside this bundle. */
  componentSellingModelIds: Map<string, string[]>;
  source: Record<string, "ProductRelatedComponent" | "ProductSellingModelOption">;
}

/**
 * The lookup table matches on the child's, the parent's and the root bundle's Product Selling Model, so a
 * row without them can never match. Resolved fresh from Salesforce: the ProductRelatedComponent's own
 * Child/ParentSellingModelId when set (the relationship pins exactly one), otherwise every
 * ProductSellingModelOption the product has. A quote line carries exactly one selling model, so one entry
 * per option is still exactly one match at runtime — never an ambiguity. A product with NO option fails.
 */
export async function resolveBundleSellingModels(client: SalesforceClient, bundleId: string, componentIds: string[]): Promise<BundleSellingModels> {
  const ids = [...new Set([bundleId, ...componentIds])];
  const idList = ids.map(id => `'${soqlEscape(id)}'`).join(",");
  const psmo = (await client.query<{ Product2Id: string; ProductSellingModelId: string }>(
    `SELECT Product2Id, ProductSellingModelId FROM ProductSellingModelOption WHERE Product2Id IN (${idList})`,
  )).records;
  const optionsByProduct = new Map<string, string[]>();
  for (const r of psmo) optionsByProduct.set(r.Product2Id, [...new Set([...(optionsByProduct.get(r.Product2Id) ?? []), r.ProductSellingModelId])]);

  let prc: { ChildProductId: string; ParentSellingModelId: string | null; ChildSellingModelId: string | null }[] = [];
  try {
    prc = (await client.query<{ ChildProductId: string; ParentSellingModelId: string | null; ChildSellingModelId: string | null }>(
      `SELECT ChildProductId, ParentSellingModelId, ChildSellingModelId FROM ProductRelatedComponent WHERE ParentProductId = '${soqlEscape(bundleId)}'`,
    )).records;
  } catch { /* relationship-level selling models are optional; PSMO is the fallback */ }

  const source: BundleSellingModels["source"] = {};
  const options = (productId: string, label: string): string[] => {
    const opts = optionsByProduct.get(productId) ?? [];
    if (opts.length === 0) {
      throw new Error(`${label} ${productId} has no Product Selling Model Option — the Bundle-Based Adjustment lookup table matches on selling model, so no row for it could ever apply.`);
    }
    return opts;
  };

  const prcParentPsm = [...new Set(prc.map(r => r.ParentSellingModelId).filter((v): v is string => !!v))];
  let parentSellingModelIds: string[];
  if (prcParentPsm.length > 0) { parentSellingModelIds = prcParentPsm; source[bundleId] = "ProductRelatedComponent"; }
  else { parentSellingModelIds = options(bundleId, "Bundle"); source[bundleId] = "ProductSellingModelOption"; }

  const componentSellingModelIds = new Map<string, string[]>();
  for (const cid of componentIds) {
    const pinned = [...new Set(prc.filter(r => r.ChildProductId === cid && r.ChildSellingModelId).map(r => r.ChildSellingModelId!))];
    if (pinned.length > 0) { componentSellingModelIds.set(cid, pinned); source[cid] = "ProductRelatedComponent"; }
    else { componentSellingModelIds.set(cid, options(cid, "Component")); source[cid] = "ProductSellingModelOption"; }
  }
  bundleLog(client, "selling-models-resolved", {
    bundleId, parentSellingModelIds, components: Object.fromEntries(componentSellingModelIds), source,
  });
  return { parentSellingModelIds, componentSellingModelIds, source };
}

/* ── Price Adjustment Schedule ── */

/**
 * One dedicated Bundle schedule per pricing procedure, identified deterministically by (Name, ScheduleType
 * = Bundle). The generated procedure's BundleDiscount step is bound to exactly this schedule (see
 * canvasBuilder's schedule-constant rebinding), which keeps this procedure's rows isolated from every other
 * procedure's rows inside the shared lookup table.
 */
export async function resolveOrCreateBundlePriceAdjustmentSchedule(
  client: SalesforceClient,
  args: { procedureName: string },
  steps: ProcedureStepLite[],
  onProgress?: (message: string) => void,
): Promise<{ scheduleId: string; scheduleName: string; reused: boolean }> {
  step(steps, "create-schedule", "start", "Resolving or creating this procedure's Bundle Price Adjustment Schedule.");
  const pasDescribe = await new SchemaCache(client).get("PriceAdjustmentSchedule");
  const scheduleName = `${args.procedureName} Bundle Schedule`.slice(0, 80);
  const scheduleTypeField = pasDescribe.fields.find(f => f.name === "ScheduleType");
  const bundleType = (scheduleTypeField?.picklistValues ?? []).find(v => v.active && v.value === "Bundle")?.value;
  if (scheduleTypeField && !bundleType) throw new Error(`PriceAdjustmentSchedule.ScheduleType has no active "Bundle" value on this org.`);

  const existing = (await client.query<{ Id: string; IsActive?: boolean }>(
    `SELECT Id${pasDescribe.fields.some(f => f.name === "IsActive") ? ", IsActive" : ""} FROM PriceAdjustmentSchedule WHERE Name = '${soqlEscape(scheduleName)}'${bundleType ? ` AND ScheduleType = '${bundleType}'` : ""}`,
  )).records;
  if (existing.length > 1) {
    throw new Error(`${existing.length} Bundle Price Adjustment Schedules are named "${scheduleName}" (${existing.map(e => e.Id).join(", ")}) — refusing to guess which one this procedure owns.`);
  }
  if (existing.length === 1) {
    step(steps, "create-schedule", "success", `Reusing Price Adjustment Schedule "${scheduleName}" (${existing[0].Id}).`);
    onProgress?.("Reusing existing Price Adjustment Schedule.");
    bundleLog(client, "schedule-reused", { scheduleId: existing[0].Id, scheduleName });
    return { scheduleId: existing[0].Id, scheduleName, reused: true };
  }

  const payload: Record<string, unknown> = { Name: scheduleName };
  if (bundleType) payload.ScheduleType = bundleType;
  if (pasDescribe.fields.some(f => f.name === "IsActive")) payload.IsActive = true;
  const methodField = pasDescribe.fields.find(f => f.name === "AdjustmentMethod");
  if (methodField) {
    const range = (methodField.picklistValues ?? []).find(v => v.active && v.value === "Range")?.value;
    if (range) payload.AdjustmentMethod = range;
  }
  if (pasDescribe.fields.some(f => f.name === "EffectiveFrom")) payload.EffectiveFrom = effectiveFromIso();
  const scheduleId = await guardedCreate(client, "PriceAdjustmentSchedule", pasDescribe, payload, [], "create-schedule");
  step(steps, "create-schedule", "success", `Created Price Adjustment Schedule "${scheduleName}" (${scheduleId}).`);
  onProgress?.("Created Price Adjustment Schedule.");
  bundleLog(client, "schedule-created", { scheduleId, scheduleName });
  return { scheduleId, scheduleName, reused: false };
}

/** Rows become effective from the start of yesterday (UTC) so a quote priced today in any timezone matches. */
function effectiveFromIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1)).toISOString();
}

/* ── BundleBasedAdjustment rows (= lookup-table entries) ── */

export type BundleAdjustmentKey = Record<BundleAdjustmentKeyField, string>;

export interface BundleAdjustmentRowPlan {
  row: BundleComponentPlanRow;
  key: BundleAdjustmentKey;
  adjustmentType: string;
  adjustmentValue: number;
}

export function buildRowPlans(
  schema: BundleBasedPricingSchema,
  args: { bundleId: string; scheduleId: string; rows: BundleComponentPlanRow[]; sellingModels: BundleSellingModels },
): { plans: BundleAdjustmentRowPlan[]; skipped: BundleComponentPlanRow[] } {
  const plans: BundleAdjustmentRowPlan[] = [];
  const skipped: BundleComponentPlanRow[] = [];
  for (const row of args.rows) {
    // A component the user never priced defaults to a $0 fixed adjustment in analyze — that's "no
    // adjustment", so no lookup-table row is written for it (pricing then leaves it unchanged).
    if (!row.stated && row.adjustment === 0) { skipped.push(row); continue; }
    const childPsms = args.sellingModels.componentSellingModelIds.get(row.componentProductId);
    if (!childPsms || childPsms.length === 0) throw new Error(`No selling model was resolved for component "${row.componentName}" (${row.componentProductId}).`);
    const adjustmentType = mapAdjustmentType(row.adjustmentType, schema.adjustmentTypeValues);
    // One entry per (bundle selling model × component selling model) the org actually offers. The root is
    // this bundle itself, so its selling model equals the parent's.
    for (const parentPsm of args.sellingModels.parentSellingModelIds) {
      for (const childPsm of childPsms) {
        plans.push({
          row,
          key: {
            PriceAdjustmentScheduleId: args.scheduleId,
            ProductId: row.componentProductId,
            ParentProductId: args.bundleId,
            RootBundleId: args.bundleId,
            ProductSellingModelId: childPsm,
            ParentProductSellingModelId: parentPsm,
            RootProductSellingModelId: parentPsm,
          },
          adjustmentType,
          adjustmentValue: row.adjustment,
        });
      }
    }
  }
  return { plans, skipped };
}

function keyWhere(key: BundleAdjustmentKey, fields: readonly BundleAdjustmentKeyField[]): string {
  return fields.map(f => `${f} = '${soqlEscape(key[f])}'`).join(" AND ");
}

export async function upsertBundleBasedAdjustments(
  client: SalesforceClient,
  schema: BundleBasedPricingSchema,
  plans: BundleAdjustmentRowPlan[],
  steps: ProcedureStepLite[],
  onProgress?: (message: string) => void,
): Promise<{ adjustmentIds: string[]; decisions: BundleAdjustmentDecision[] }> {
  step(steps, "upsert-adjustments", "start", `Writing ${plans.length} Bundle-Based Adjustment lookup-table entr${plans.length === 1 ? "y" : "ies"}.`);
  // Identity uses every key field the table matches on plus the ones every row always carries, so a row is
  // never mistaken for another bundle's/schedule's row even if the table's own key were narrower.
  const identityFields = [...new Set<BundleAdjustmentKeyField>([...schema.keyFields, "PriceAdjustmentScheduleId", "ProductId", "ParentProductId", "RootBundleId"])];
  const adjustmentIds: string[] = [];
  const decisions: BundleAdjustmentDecision[] = [];

  for (const plan of plans) {
    const existing = (await client.query<{ Id: string; AdjustmentType: string; AdjustmentValue: number }>(
      `SELECT Id, AdjustmentType, AdjustmentValue FROM BundleBasedAdjustment WHERE ${keyWhere(plan.key, identityFields)}`,
    )).records;
    if (existing.length > 1) {
      throw new Error(
        `Component "${plan.row.componentName}" already has ${existing.length} Bundle-Based Adjustment rows with the same lookup key (${existing.map(e => e.Id).join(", ")}). ` +
        "Salesforce could not tell which one to apply at runtime — resolve the duplicates in Setup before re-running.",
      );
    }

    let decision: BundleAdjustmentDecision["decision"];
    let adjustmentId: string;
    const previous = existing[0] ? { adjustmentType: existing[0].AdjustmentType, adjustmentValue: Number(existing[0].AdjustmentValue) } : null;
    if (existing.length === 1) {
      adjustmentId = existing[0].Id;
      if (previous!.adjustmentType === plan.adjustmentType && previous!.adjustmentValue === plan.adjustmentValue) {
        decision = "REUSE";
      } else {
        await client.updateRecord("BundleBasedAdjustment", adjustmentId, { AdjustmentType: plan.adjustmentType, AdjustmentValue: plan.adjustmentValue });
        const readBack = (await client.query<{ AdjustmentType: string; AdjustmentValue: number }>(
          `SELECT AdjustmentType, AdjustmentValue FROM BundleBasedAdjustment WHERE Id = '${soqlEscape(adjustmentId)}'`,
        )).records[0];
        if (!readBack || readBack.AdjustmentType !== plan.adjustmentType || Number(readBack.AdjustmentValue) !== plan.adjustmentValue) {
          throw new Error(`BundleBasedAdjustment ${adjustmentId} was updated, but reading it back did not return ${plan.adjustmentType} ${plan.adjustmentValue}.`);
        }
        decision = "UPDATE";
      }
    } else {
      const payload: Record<string, unknown> = {
        ...plan.key,
        AdjustmentType: plan.adjustmentType,
        AdjustmentValue: plan.adjustmentValue,
        EffectiveFrom: effectiveFromIso(),
      };
      if (schema.hasScheduleTypeField) payload.ScheduleType = "Bundle";
      const lookups: ResolvedLookup[] = [];
      for (const [name, value] of Object.entries(plan.key)) {
        const field = schema.bbaDescribe.fields.find(f => f.name === name);
        if (field?.referenceTo?.[0]) lookups.push({ targetObject: field.referenceTo[0], field, value });
      }
      adjustmentId = await guardedCreate(client, "BundleBasedAdjustment", schema.bbaDescribe, payload, lookups, "upsert-adjustments");
      decision = "CREATE";
    }

    adjustmentIds.push(adjustmentId);
    decisions.push({
      step: "bundle-based-adjustment", componentName: plan.row.componentName, componentProductId: plan.row.componentProductId,
      key: plan.key, adjustmentType: plan.adjustmentType, adjustmentValue: plan.adjustmentValue, previous, decision, adjustmentId,
    });
    bundleLog(client, "adjustment-upserted", { decision, adjustmentId, component: plan.row.componentName, key: plan.key, adjustmentType: plan.adjustmentType, adjustmentValue: plan.adjustmentValue, previous });
  }

  const count = (d: string) => decisions.filter(x => x.decision === d).length;
  step(steps, "upsert-adjustments", "success", `Entries: ${count("CREATE")} created, ${count("UPDATE")} updated, ${count("REUSE")} reused unchanged.`);
  onProgress?.(`${count("CREATE")} created, ${count("UPDATE")} updated, ${count("REUSE")} reused.`);
  return { adjustmentIds, decisions };
}

/* ── Runtime lookup replica ── */

export interface RuntimeBundleAdjustmentTrace {
  componentName: string;
  lookupTableId: string;
  /** Every INPUT column the pricing engine sends to the lookup, with the value this component's line would send. */
  inputs: { fieldName: string; operator: string | null; value: string }[];
  matchedEntryIds: string[];
  adjustmentId: string | null;
  adjustmentType: string | null;
  adjustmentValue: number | null;
  resolved: boolean;
  reason: string;
}

function operatorClause(fieldName: string, operator: string | null, value: string, isDateTime: boolean): string {
  // Decision Table operators compare the INPUT value against the row's column: e.g. EffectiveFrom
  // GreaterOrEqual means pricingDate >= row.EffectiveFrom. Null row values are ignored by the table
  // (DoesConsiderNullValue=false), so an open-ended EffectiveTo always matches.
  const lit = isDateTime ? value : `'${soqlEscape(value)}'`;
  switch (operator) {
    case "GreaterOrEqual": return `${fieldName} <= ${lit}`;
    case "GreaterThan": return `${fieldName} < ${lit}`;
    case "LessOrEqual": return `(${fieldName} = null OR ${fieldName} >= ${lit})`;
    case "LessThan": return `(${fieldName} = null OR ${fieldName} > ${lit})`;
    case "NotEquals": return `${fieldName} != ${lit}`;
    default: return `${fieldName} = ${lit}`;
  }
}

/**
 * Replays the resolved lookup table's own INPUT columns and operators as a SOQL query over its source
 * object, using the values a priced child line would send. Exactly one match is the only "resolved"
 * outcome; zero means "no adjustment applies" (a valid outcome), two or more is ambiguous.
 */
export async function resolveRuntimeBundleAdjustment(
  client: SalesforceClient,
  table: ResolvedBundleLookupTable,
  plan: Pick<BundleAdjustmentRowPlan, "key" | "row">,
  pricingDate: Date = new Date(),
): Promise<RuntimeBundleAdjustmentTrace> {
  const iso = pricingDate.toISOString().replace(/\.\d{3}Z$/, "Z");
  const inputs = table.inputs.map(i => ({
    fieldName: i.fieldName, operator: i.operator,
    value: DATE_RANGE_FIELDS.has(i.fieldName) ? iso : (plan.key as Record<string, string>)[i.fieldName] ?? "",
  }));
  const base = { componentName: plan.row.componentName, lookupTableId: table.id, inputs };
  const missing = inputs.filter(i => !i.value);
  if (missing.length > 0) {
    return { ...base, matchedEntryIds: [], adjustmentId: null, adjustmentType: null, adjustmentValue: null, resolved: false, reason: `No value for lookup input(s): ${missing.map(m => m.fieldName).join(", ")}.` };
  }
  const where = inputs.map(i => operatorClause(i.fieldName, i.operator, i.value, DATE_RANGE_FIELDS.has(i.fieldName))).join(" AND ");
  let rows: { Id: string; AdjustmentType: string; AdjustmentValue: number }[];
  try {
    rows = (await client.query<{ Id: string; AdjustmentType: string; AdjustmentValue: number }>(
      `SELECT Id, ${table.outputs.join(", ")} FROM BundleBasedAdjustment WHERE ${where}`,
    )).records;
  } catch (err) {
    return { ...base, matchedEntryIds: [], adjustmentId: null, adjustmentType: null, adjustmentValue: null, resolved: false, reason: `Lookup replay query failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (rows.length === 0) {
    return { ...base, matchedEntryIds: [], adjustmentId: null, adjustmentType: null, adjustmentValue: null, resolved: false, reason: "No lookup-table entry matches — no Bundle-Based Adjustment applies to this component." };
  }
  if (rows.length > 1) {
    return { ...base, matchedEntryIds: rows.map(r => r.Id), adjustmentId: null, adjustmentType: null, adjustmentValue: null, resolved: false, reason: `Ambiguous — ${rows.length} lookup-table entries match the same inputs.` };
  }
  return {
    ...base, matchedEntryIds: [rows[0].Id], adjustmentId: rows[0].Id, adjustmentType: rows[0].AdjustmentType, adjustmentValue: Number(rows[0].AdjustmentValue),
    resolved: true, reason: "Exactly one lookup-table entry matches.",
  };
}
