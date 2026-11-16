/**
 * Bundle-Based Pricing native-record coverage — the real exported functions against an in-memory fake
 * Salesforce store (never a re-implementation of the logic under test):
 *   - row planning (no-adjustment components skipped, one entry per selling-model combination)
 *   - AdjustmentType mapping onto the org's real picklist
 *   - idempotent upsert: CREATE → REUSE on an identical re-run, UPDATE only when the value changes,
 *     and a hard failure (never a third row) when two rows already share one lookup key
 *   - the runtime lookup replay's operator semantics
 *   - no hardcoded Salesforce record Id in the module source
 *
 * Run with a TypeScript-aware runner: `npx tsx --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SalesforceClient, DescribeResult } from "@/lib/salesforce/client";
import {
  buildRowPlans, mapAdjustmentType, upsertBundleBasedAdjustments, resolveRuntimeBundleAdjustment,
  type BundleBasedPricingSchema, type BundleSellingModels,
} from "./nativeRecords";
import type { ResolvedBundleLookupTable } from "./lookupTableResolver";
import type { BundleComponentPlanRow, ProcedureStepLite } from "../types";

const BBA_DESCRIBE = {
  name: "BundleBasedAdjustment",
  fields: [
    { name: "Id", type: "id", nillable: false, createable: false },
    { name: "PriceAdjustmentScheduleId", type: "reference", referenceTo: ["PriceAdjustmentSchedule"], nillable: false, createable: true },
    { name: "ProductId", type: "reference", referenceTo: ["Product2"], nillable: false, createable: true },
    { name: "ParentProductId", type: "reference", referenceTo: ["Product2"], nillable: false, createable: true },
    { name: "RootBundleId", type: "reference", referenceTo: ["Product2"], nillable: false, createable: true },
    { name: "ProductSellingModelId", type: "reference", referenceTo: ["ProductSellingModel"], nillable: true, createable: true },
    { name: "ParentProductSellingModelId", type: "reference", referenceTo: ["ProductSellingModel"], nillable: true, createable: true },
    { name: "RootProductSellingModelId", type: "reference", referenceTo: ["ProductSellingModel"], nillable: true, createable: true },
    { name: "AdjustmentType", type: "picklist", nillable: false, createable: true, picklistValues: ["Percentage", "Amount", "Override"].map(v => ({ value: v, label: v, active: true, defaultValue: false })) },
    { name: "AdjustmentValue", type: "double", nillable: false, createable: true },
    { name: "EffectiveFrom", type: "datetime", nillable: false, createable: true },
  ],
} as unknown as DescribeResult;

const SCHEMA: BundleBasedPricingSchema = {
  bbaDescribe: BBA_DESCRIBE,
  keyFields: ["PriceAdjustmentScheduleId", "ProductSellingModelId", "ProductId", "ParentProductId", "ParentProductSellingModelId", "RootBundleId", "RootProductSellingModelId"],
  adjustmentTypeValues: ["Percentage", "Amount", "Override"],
  hasScheduleTypeField: false,
};

const TABLE: ResolvedBundleLookupTable = {
  id: "0lDTEST00000000001", developerName: "Test_Bundle_Table", label: "Test Bundle Table", sourceObject: "BundleBasedAdjustment",
  status: "Active", usageType: "DefaultPricing", refreshStatus: "Completed", lastSyncDate: null,
  selectedBy: "pricing-recipe-mapping", reason: "test", recipe: null,
  inputs: [
    { fieldName: "PriceAdjustmentScheduleId", operator: "Equals", sequence: 1, required: true },
    { fieldName: "ProductSellingModelId", operator: "Equals", sequence: 2, required: true },
    { fieldName: "EffectiveFrom", operator: "GreaterOrEqual", sequence: 3, required: true },
    { fieldName: "EffectiveTo", operator: "LessThan", sequence: 4, required: false },
    { fieldName: "ProductId", operator: "Equals", sequence: 5, required: true },
    { fieldName: "ParentProductId", operator: "Equals", sequence: 6, required: true },
  ],
  outputs: ["AdjustmentValue", "AdjustmentType"],
  existingEntryCount: 0,
};

function row(name: string, id: string, type: BundleComponentPlanRow["adjustmentType"], adjustment: number, stated = true): BundleComponentPlanRow {
  return { componentProductId: id, componentName: name, quantity: 1, adjustmentType: type, adjustment, stated };
}

const SELLING_MODELS: BundleSellingModels = {
  parentSellingModelIds: ["PSM-PARENT-A"],
  componentSellingModelIds: new Map([["P-CHILD-1", ["PSM-CHILD-1"]], ["P-CHILD-2", ["PSM-CHILD-2"]], ["P-CHILD-3", ["PSM-CHILD-3"]]]),
  source: {},
};

/** In-memory BundleBasedAdjustment store answering the exact SOQL shapes nativeRecords issues. */
function fakeClient(seed: Record<string, unknown>[] = []) {
  const rows: Record<string, unknown>[] = seed.map(r => ({ ...r }));
  const queries: string[] = [];
  let seq = 0;
  const matchesWhere = (rec: Record<string, unknown>, where: string) =>
    [...where.matchAll(/(\w+) = '([^']*)'/g)].every(([, f, v]) => String(rec[f] ?? "") === v);
  const client = {
    logDebug() { /* no-op */ },
    debugLog: [],
    async query(soql: string) {
      queries.push(soql);
      const where = soql.split(" WHERE ")[1] ?? "";
      if (/FROM BundleBasedAdjustment/.test(soql)) {
        const idMatch = where.match(/^Id = '([^']+)'/);
        const found = idMatch ? rows.filter(r => r.Id === idMatch[1]) : rows.filter(r => matchesWhere(r, where));
        return { totalSize: found.length, done: true, records: found };
      }
      return { totalSize: 0, done: true, records: [] };
    },
    async createRecord(_o: string, payload: Record<string, unknown>) {
      const id = `a0BBA${String(++seq).padStart(3, "0")}`;
      rows.push({ Id: id, ...payload });
      return { id, success: true };
    },
    async updateRecord(_o: string, id: string, fields: Record<string, unknown>) {
      Object.assign(rows.find(r => r.Id === id)!, fields);
    },
  } as unknown as SalesforceClient;
  return { client, rows, queries };
}

test("buildRowPlans skips a component with no configured adjustment (never writes a $0 entry)", () => {
  const { plans, skipped } = buildRowPlans(SCHEMA, {
    bundleId: "P-BUNDLE", scheduleId: "PAS-1", sellingModels: SELLING_MODELS,
    rows: [row("Kept", "P-CHILD-1", "fixed", 50), row("Unpriced", "P-CHILD-2", "fixed", 0, false)],
  });
  assert.deepEqual(plans.map(p => p.row.componentName), ["Kept"]);
  assert.deepEqual(skipped.map(s => s.componentName), ["Unpriced"]);
  assert.deepEqual(plans[0].key, {
    PriceAdjustmentScheduleId: "PAS-1", ProductId: "P-CHILD-1", ParentProductId: "P-BUNDLE", RootBundleId: "P-BUNDLE",
    ProductSellingModelId: "PSM-CHILD-1", ParentProductSellingModelId: "PSM-PARENT-A", RootProductSellingModelId: "PSM-PARENT-A",
  });
});

test("buildRowPlans writes one entry per (bundle selling model × component selling model) combination", () => {
  const { plans } = buildRowPlans(SCHEMA, {
    bundleId: "P-BUNDLE", scheduleId: "PAS-1",
    sellingModels: { parentSellingModelIds: ["PSM-ONETIME", "PSM-TERM"], componentSellingModelIds: new Map([["P-CHILD-1", ["PSM-C-TERM"]]]), source: {} },
    rows: [row("Child", "P-CHILD-1", "percentage", 10)],
  });
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map(p => p.key.ParentProductSellingModelId).sort(), ["PSM-ONETIME", "PSM-TERM"]);
  assert.ok(plans.every(p => p.key.RootProductSellingModelId === p.key.ParentProductSellingModelId), "the root is the bundle itself");
  assert.equal(new Set(plans.map(p => JSON.stringify(p.key))).size, 2, "every entry has a distinct lookup key — runtime can match only one");
});

test("mapAdjustmentType maps the app vocabulary onto the org's real AdjustmentType picklist", () => {
  assert.equal(mapAdjustmentType("fixed", SCHEMA.adjustmentTypeValues), "Amount");
  assert.equal(mapAdjustmentType("percentage", SCHEMA.adjustmentTypeValues), "Percentage");
  assert.equal(mapAdjustmentType("override", SCHEMA.adjustmentTypeValues), "Override");
  assert.throws(() => mapAdjustmentType("override", ["Percentage", "Amount"]), /no active "Override"/);
});

test("upsert is idempotent: identical re-run REUSEs every entry and creates nothing", async () => {
  const { client, rows } = fakeClient();
  const steps: ProcedureStepLite[] = [];
  const input = buildRowPlans(SCHEMA, { bundleId: "P-BUNDLE", scheduleId: "PAS-1", sellingModels: SELLING_MODELS, rows: [row("A", "P-CHILD-1", "percentage", 10), row("B", "P-CHILD-2", "fixed", 500)] }).plans;

  const first = await upsertBundleBasedAdjustments(client, SCHEMA, input, steps);
  assert.deepEqual(first.decisions.map(d => d.decision), ["CREATE", "CREATE"]);
  assert.equal(rows.length, 2);

  const second = await upsertBundleBasedAdjustments(client, SCHEMA, input, steps);
  assert.deepEqual(second.decisions.map(d => d.decision), ["REUSE", "REUSE"]);
  assert.deepEqual(second.adjustmentIds, first.adjustmentIds);
  assert.equal(rows.length, 2, "no duplicate entry on re-run");
});

test("upsert UPDATEs the existing entry in place when only the adjustment value changes", async () => {
  const { client, rows } = fakeClient();
  const plans = (v: number) => buildRowPlans(SCHEMA, { bundleId: "P-BUNDLE", scheduleId: "PAS-1", sellingModels: SELLING_MODELS, rows: [row("A", "P-CHILD-1", "percentage", v)] }).plans;
  const created = await upsertBundleBasedAdjustments(client, SCHEMA, plans(10), []);
  const updated = await upsertBundleBasedAdjustments(client, SCHEMA, plans(15), []);
  assert.equal(updated.decisions[0].decision, "UPDATE");
  assert.equal(updated.decisions[0].adjustmentId, created.decisions[0].adjustmentId);
  assert.deepEqual(updated.decisions[0].previous, { adjustmentType: "Percentage", adjustmentValue: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].AdjustmentValue, 15);
});

test("upsert refuses to add a third row when two entries already share one lookup key", async () => {
  const plan = buildRowPlans(SCHEMA, { bundleId: "P-BUNDLE", scheduleId: "PAS-1", sellingModels: SELLING_MODELS, rows: [row("A", "P-CHILD-1", "fixed", 5)] }).plans;
  const dup = { ...plan[0].key, AdjustmentType: "Amount", AdjustmentValue: 5 };
  const { client, rows } = fakeClient([{ Id: "a0BBAX01", ...dup }, { Id: "a0BBAX02", ...dup }]);
  await assert.rejects(upsertBundleBasedAdjustments(client, SCHEMA, plan, []), /already has 2 Bundle-Based Adjustment rows/);
  assert.equal(rows.length, 2);
});

test("runtime replay turns the table's own operators into the right comparisons and reports the match", async () => {
  const plan = buildRowPlans(SCHEMA, { bundleId: "P-BUNDLE", scheduleId: "PAS-1", sellingModels: SELLING_MODELS, rows: [row("A", "P-CHILD-1", "fixed", 5)] }).plans[0];
  const { client, queries } = fakeClient([{ Id: "a0BBAX01", ...plan.key, AdjustmentType: "Amount", AdjustmentValue: 5 }]);
  const trace = await resolveRuntimeBundleAdjustment(client, TABLE, plan, new Date("2030-01-15T12:00:00Z"));
  const soql = queries.at(-1)!;
  assert.match(soql, /EffectiveFrom <= 2030-01-15T12:00:00Z/, "GreaterOrEqual means pricingDate >= row.EffectiveFrom");
  assert.match(soql, /\(EffectiveTo = null OR EffectiveTo > 2030-01-15T12:00:00Z\)/, "LessThan with an open-ended row");
  assert.match(soql, /ParentProductId = 'P-BUNDLE'/);
  assert.equal(trace.resolved, true);
  assert.equal(trace.adjustmentId, "a0BBAX01");
  assert.deepEqual(trace.inputs.map(i => i.fieldName), TABLE.inputs.map(i => i.fieldName));
});

test("runtime replay reports 'no adjustment applies' (not an error) when no entry matches", async () => {
  const plan = buildRowPlans(SCHEMA, { bundleId: "P-BUNDLE", scheduleId: "PAS-1", sellingModels: SELLING_MODELS, rows: [row("A", "P-CHILD-3", "fixed", 5)] }).plans[0];
  const { client } = fakeClient();
  const trace = await resolveRuntimeBundleAdjustment(client, TABLE, plan);
  assert.equal(trace.resolved, false);
  assert.match(trace.reason, /no Bundle-Based Adjustment applies/i);
});

test("no literal 15/18-character Salesforce record Id is hardcoded in the bundle create modules", () => {
  for (const file of ["nativeRecords.ts", "lookupTableResolver.ts", "canvasBuilder.ts", "createPipeline.ts", "quotePricingTest.ts", "verifySalesforceState.ts"]) {
    const src = readFileSync(join(__dirname, file), "utf8");
    const suspicious = (src.match(/['"`](0lD|84X|15T|01t|0jP|9QL|9QM|9QA|0Q0|0QL|11O|11j)[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?['"`]/g) ?? []);
    assert.deepEqual(suspicious, [], `${file} hardcodes Salesforce Id(s): ${suspicious.join(", ")}`);
  }
});
