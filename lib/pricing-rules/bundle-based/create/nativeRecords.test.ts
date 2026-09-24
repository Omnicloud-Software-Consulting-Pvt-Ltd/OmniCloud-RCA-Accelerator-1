/**
 * Bundle-Based Pricing native-record idempotency coverage — an in-memory fake Salesforce store exercising
 * the REAL exported create/reuse functions end-to-end (never a hand-rolled reimplementation), verifying:
 *   1. A schedule/rule/condition/adjustment created once and re-requested with identical inputs is REUSED,
 *      never duplicated (idempotent rerun).
 *   2. A genuinely new component gets its own new Rule/Condition/Adjustment without disturbing existing ones.
 *   3. No literal 18-character Salesforce Id ever appears hardcoded in this module's own source.
 *
 * Same caveat as every other *.test.ts in this repo: no test framework/runner is installed — this file
 * type-checks under `tsc --noEmit` but needs a TypeScript-aware runner (e.g. `npx tsx --test`) to execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SalesforceClient, DescribeResult } from "@/lib/salesforce/client";
import {
  prepareBundleBasedAdjustmentSchema, resolveOrCreateBundlePriceAdjustmentSchedule,
  createOrReuseBundleBasedAdjRules, createBundleAdjustmentConditions, createBundleBasedAdjustments,
} from "./nativeRecords";
import type { BundleComponentPlanRow, ProcedureStepLite } from "../types";

function describeWithFields(fields: { name: string; type: string; referenceTo?: string[]; label?: string; picklistValues?: { value: string; label: string; active: boolean }[] }[]): DescribeResult {
  return { name: "x", label: "x", labelPlural: "x", fields: fields.map(f => ({ name: f.name, label: f.label ?? f.name, type: f.type, referenceTo: f.referenceTo, picklistValues: f.picklistValues, createable: true, updateable: true, nillable: true })), recordTypeInfos: [], urls: {} };
}

/** A minimal in-memory fake of the 4 native objects — enough for the real
 * resolveOrCreateBundlePriceAdjustmentSchedule/createOrReuseBundleBasedAdjRules/createBundleAdjustmentConditions/
 * createBundleBasedAdjustments functions to run their real reuse-scan-then-create logic against. */
function buildFakeStore() {
  const tables: Record<string, Record<string, unknown>[]> = {
    PriceAdjustmentSchedule: [], BundleBasedAdjRule: [], BundleAdjustmentCondition: [], BundleBasedAdjustment: [], Product2: [],
  };
  let nextId = 1;
  function newId(prefix: string) { return `${prefix}${String(nextId++).padStart(15, "0")}`; }

  const describes: Record<string, DescribeResult> = {
    PriceAdjustmentSchedule: describeWithFields([
      { name: "Name", type: "string" },
      { name: "Product2Id", type: "reference", referenceTo: ["Product2"], label: "Product" },
      { name: "ScheduleType", type: "picklist", picklistValues: [{ value: "Bundle Based", label: "Bundle Based", active: true }] },
      { name: "AdjustmentMethod", type: "picklist", picklistValues: [{ value: "Fixed Amount", label: "Fixed Amount", active: true }] },
    ]),
    BundleBasedAdjRule: describeWithFields([
      { name: "Name", type: "string" },
      { name: "Product2Id", type: "reference", referenceTo: ["Product2"], label: "Product" },
      { name: "PriceAdjustmentScheduleId", type: "reference", referenceTo: ["PriceAdjustmentSchedule"], label: "Price Adjustment Schedule" },
      { name: "IsActive", type: "boolean" },
    ]),
    BundleAdjustmentCondition: describeWithFields([
      { name: "BundleBasedAdjRuleId", type: "reference", referenceTo: ["BundleBasedAdjRule"], label: "Rule" },
      { name: "ComponentProductId", type: "reference", referenceTo: ["Product2"], label: "Component Product" },
      { name: "Operator", type: "picklist", picklistValues: [{ value: "Equal", label: "Equal", active: true }] },
    ]),
    BundleBasedAdjustment: describeWithFields([
      { name: "Product2Id", type: "reference", referenceTo: ["Product2"], label: "Product" },
      { name: "BundleBasedAdjRuleId", type: "reference", referenceTo: ["BundleBasedAdjRule"], label: "Rule" },
      { name: "PriceAdjustmentScheduleId", type: "reference", referenceTo: ["PriceAdjustmentSchedule"], label: "Price Adjustment Schedule" },
      { name: "AdjustmentType", type: "picklist", picklistValues: [{ value: "Fixed Amount", label: "Fixed Amount", active: true }] },
      { name: "AdjustmentValue", type: "currency" },
    ]),
  };

  const client = {
    async describeObject(sobject: string) {
      const d = describes[sobject];
      if (!d) throw new Error(`unexpected describeObject(${sobject})`);
      return d;
    },
    async query<T>(soql: string) {
      const objectMatch = soql.match(/FROM (\w+)/);
      const objectName = objectMatch![1];
      const rows = tables[objectName] ?? [];
      // Extremely small WHERE-clause interpreter — sufficient for the equality filters this module emits.
      const whereMatch = soql.match(/WHERE (.+?)(?: LIMIT|\s*$)/);
      let filtered = rows;
      if (whereMatch) {
        const clauses = whereMatch[1].split(/ AND /);
        filtered = rows.filter(row => clauses.every(clause => {
          const eq = clause.match(/^(\w+) = '([^']*)'$/);
          if (!eq) return true;
          return String(row[eq[1]] ?? "") === eq[2];
        }));
      }
      return { totalSize: filtered.length, done: true, records: filtered as T[] };
    },
    async createRecord(sobject: string, fields: Record<string, unknown>) {
      const id = newId(sobject === "PriceAdjustmentSchedule" ? "0pa" : sobject === "BundleBasedAdjRule" ? "0ru" : sobject === "BundleAdjustmentCondition" ? "0co" : "0ad");
      tables[sobject].push({ Id: id, ...fields });
      return { id, success: true, errors: [] };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  return { client, tables };
}

test("createOrReuseBundleBasedAdjRules + createBundleAdjustmentConditions + createBundleBasedAdjustments are idempotent across two identical runs", async () => {
  const { client } = buildFakeStore();
  const schema = await prepareBundleBasedAdjustmentSchema(client);
  const steps: ProcedureStepLite[] = [];
  const bundle = { id: "01t000000000001AAA", name: "Laptop Basic Bundle" };
  const rows: BundleComponentPlanRow[] = [{ componentProductId: "01t000000000002AAA", componentName: "Laptop", quantity: 1, adjustmentType: "fixed", adjustment: 500, stated: true }];

  const scheduleId = await resolveOrCreateBundlePriceAdjustmentSchedule(client, { bundle, sellingModelId: null, procedureName: "Laptop Bundle Pricing" }, steps);
  const run1Rules = await createOrReuseBundleBasedAdjRules(client, schema, { bundle, sellingModelId: null, components: rows }, scheduleId, steps);
  await createBundleAdjustmentConditions(client, schema, { bundle }, run1Rules.plans, steps);
  const run1Adjustments = await createBundleBasedAdjustments(client, schema, { bundle, sellingModelId: null }, scheduleId, run1Rules.plans, steps);

  assert.equal(run1Adjustments.adjustmentIds.length, 1, "first run must create exactly one new adjustment");
  assert.equal(run1Adjustments.reusedAdjustmentIds.length, 0);

  // Second, IDENTICAL run — a fresh schema/plans lookup against the SAME (now-populated) fake store.
  const scheduleId2 = await resolveOrCreateBundlePriceAdjustmentSchedule(client, { bundle, sellingModelId: null, procedureName: "Laptop Bundle Pricing" }, steps);
  assert.equal(scheduleId2, scheduleId, "the same schedule must be reused, never duplicated");

  const run2Rules = await createOrReuseBundleBasedAdjRules(client, schema, { bundle, sellingModelId: null, components: rows }, scheduleId2, steps);
  assert.equal(run2Rules.ruleIds[0], run1Rules.ruleIds[0], "the same rule must be reused, never duplicated");

  await createBundleAdjustmentConditions(client, schema, { bundle }, run2Rules.plans, steps);
  const run2Adjustments = await createBundleBasedAdjustments(client, schema, { bundle, sellingModelId: null }, scheduleId2, run2Rules.plans, steps);

  assert.equal(run2Adjustments.adjustmentIds.length, 0, "a second identical run must create NO new adjustments");
  assert.equal(run2Adjustments.reusedAdjustmentIds.length, 1, "the second run must reuse the exact adjustment created by the first run");
  assert.equal(run2Adjustments.reusedAdjustmentIds[0], run1Adjustments.adjustmentIds[0]);
});

test("a genuinely new component gets its own new rule/condition/adjustment without disturbing the existing one", async () => {
  const { client } = buildFakeStore();
  const schema = await prepareBundleBasedAdjustmentSchema(client);
  const steps: ProcedureStepLite[] = [];
  const bundle = { id: "01t000000000001AAA", name: "Laptop Basic Bundle" };
  const laptopRow: BundleComponentPlanRow = { componentProductId: "01t000000000002AAA", componentName: "Laptop", quantity: 1, adjustmentType: "fixed", adjustment: 500, stated: true };
  const mouseRow: BundleComponentPlanRow = { componentProductId: "01t000000000003AAA", componentName: "Wireless Mouse", quantity: 1, adjustmentType: "fixed", adjustment: 100, stated: true };

  const scheduleId = await resolveOrCreateBundlePriceAdjustmentSchedule(client, { bundle, sellingModelId: null, procedureName: "Laptop Bundle Pricing" }, steps);
  const run1 = await createOrReuseBundleBasedAdjRules(client, schema, { bundle, sellingModelId: null, components: [laptopRow] }, scheduleId, steps);
  await createBundleAdjustmentConditions(client, schema, { bundle }, run1.plans, steps);
  await createBundleBasedAdjustments(client, schema, { bundle, sellingModelId: null }, scheduleId, run1.plans, steps);

  // Second call adds Wireless Mouse alongside the already-configured Laptop.
  const run2 = await createOrReuseBundleBasedAdjRules(client, schema, { bundle, sellingModelId: null, components: [laptopRow, mouseRow] }, scheduleId, steps);
  assert.equal(run2.ruleIds.length, 2);
  assert.ok(run2.ruleIds.includes(run1.ruleIds[0]), "the Laptop rule from the first run must be reused untouched");

  await createBundleAdjustmentConditions(client, schema, { bundle }, run2.plans, steps);
  const run2Adjustments = await createBundleBasedAdjustments(client, schema, { bundle, sellingModelId: null }, scheduleId, run2.plans, steps);
  assert.equal(run2Adjustments.adjustmentIds.length, 1, "only the new Wireless Mouse adjustment should be newly created");
  assert.equal(run2Adjustments.reusedAdjustmentIds.length, 1, "the existing Laptop adjustment must be reused, not recreated");
});

test("no literal 18-character Salesforce record Id is hardcoded anywhere in this module's own source", () => {
  const source = readFileSync(join(__dirname, "nativeRecords.ts"), "utf8");
  // Real Salesforce Ids are exactly 15 or 18 base62 characters and, being effectively random, always mix
  // letters and digits — this module's own string literals are pure-alphabetic object/field API names
  // (e.g. "BundleBasedAdjRule"), which never trip this check. Requiring at least one digit is what
  // distinguishes a real-looking Id literal (a smoking gun) from an ordinary identifier name.
  const suspicious = (source.match(/["'][a-zA-Z0-9]{15,18}["']/g) ?? []).filter(m => /[0-9]/.test(m));
  assert.equal(suspicious.length, 0, `found suspicious fixed-length literal(s) that look like hardcoded Salesforce Ids: ${suspicious.join(", ")}`);
});
