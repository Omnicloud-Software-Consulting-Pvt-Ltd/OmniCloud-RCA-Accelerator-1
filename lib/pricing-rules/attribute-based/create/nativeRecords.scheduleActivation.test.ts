/**
 * §Root-cause fix (live evidence — "adjustments=[]" on a Laptop Attribute-Based Pricing simulation despite
 * fully valid, correctly-linked Rule/Condition/Adjustment data) — the application-side diagnostic resolver
 * (`resolveRuntimeAttributeAdjustment`) found a valid, unambiguous AttributeBasedAdjustment for two
 * different attributes (Display=100, Memory=200), proving the DATA was correct. Yet the actual Salesforce
 * AttributeDiscount step returned `adjustments: []` at runtime. Querying the real, stored
 * PriceAdjustmentSchedule directly (the schedule governing both adjustments) found `IsActive: false` — a
 * schedule this pipeline never created (its `CreatedById` differs from every record this pipeline's own
 * session creates) but discovered and REUSED via `findCompatiblePriceAdjustmentSchedule`. An inactive
 * schedule makes every adjustment attached to it invisible to Salesforce's real pricing engine, regardless
 * of how correct the underlying Rule/Condition/Adjustment data is — `findCompatiblePriceAdjustmentSchedule`
 * never considered `IsActive` as part of its compatibility check at all (only Product/SellingModel/
 * ScheduleType/AdjustmentMethod), so an inactive schedule was silently reused with zero diagnostic.
 *
 * Fixed by making schedule resolution IsActive-aware: when a compatible existing schedule is reused and
 * found inactive, `resolveOrCreatePriceAdjustmentSchedule` now attempts to activate it (a REUSED schedule,
 * unlike a freshly-created empty one, was only found because it already has real content linked to this
 * exact Product — Salesforce's "no price adjustment tier" activation-validation concern, which is why
 * `IsActive` is deliberately never set on CREATE, does not apply here). The attempt is defensive — a
 * genuinely empty reused schedule is structurally possible (e.g. an admin pre-created it with no rows yet),
 * so a failed activation is logged and reported, never thrown as a fatal pipeline error.
 *
 * Verified live against the real org: `resolveOrCreatePriceAdjustmentSchedule` correctly activated the real
 * inactive schedule (confirmed by a fresh, independent re-query showing `IsActive: true` afterward — not
 * just the function's own claim).
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import { resolveOrCreatePriceAdjustmentSchedule } from "./nativeRecords";
import type { ProcedureStepLite } from "../types";

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

const PAS_DESCRIBE: DescribeResult = {
  name: "PriceAdjustmentSchedule", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [
    field("Id", "id"), field("Name", "string"),
    field("Product2Id", "reference", { referenceTo: ["Product2"] }),
    field("ProductSellingModelId", "reference", { referenceTo: ["ProductSellingModel"] }),
    field("Pricebook2Id", "reference", { referenceTo: ["Pricebook2"] }),
    field("ScheduleType", "picklist", { picklistValues: [{ value: "Attribute", label: "Attribute", active: true }] }),
    field("AdjustmentMethod", "picklist", { picklistValues: [{ value: "Range", label: "Range", active: true }] }),
    field("EffectiveFrom", "date"), field("EffectiveTo", "date"),
    field("IsActive", "boolean"),
  ],
} as unknown as DescribeResult;

const PAS_DESCRIBE_NO_ISACTIVE: DescribeResult = {
  ...PAS_DESCRIBE,
  fields: PAS_DESCRIBE.fields.filter(f => f.name !== "IsActive"),
} as unknown as DescribeResult;

let instanceUrlCounter = 0;
function uniqueInstanceUrl(): string {
  instanceUrlCounter += 1;
  return `https://test-org-schedule-${instanceUrlCounter}.my.salesforce.com`;
}

function baseArgs() {
  return { product: { id: "01tPRODUCT000000A", name: "Test Product" }, sellingModelId: "0jPMODEL0000000A", procedureName: "Test Attribute Based Pricing Procedure" };
}

test("TEST 1 — the exact live bug: a compatible existing schedule with IsActive=false is activated (not just silently reused)", async () => {
  const updateLog: { object: string; id: string; payload: Record<string, unknown> }[] = [];
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAS_DESCRIBE; },
    async query(soql: string) {
      if (soql.includes("FROM Pricebook2")) return { records: [{ Id: "01sPRICEBOOK0000A" }] };
      if (soql.startsWith("SELECT Id, Name, Product2Id")) {
        return { records: [{ Id: "84XSCHEDULE00000A", Name: "Standard Attribute Based Adjustment", Product2Id: "01tPRODUCT000000A", ProductSellingModelId: "0jPMODEL0000000A", ScheduleType: "Attribute", AdjustmentMethod: "Range", IsActive: false }] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    async updateRecord(objectName: string, id: string, payload: Record<string, unknown>) {
      updateLog.push({ object: objectName, id, payload });
      return { success: true };
    },
    async createRecord() { throw new Error("must never create — a compatible schedule already exists"); },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const steps: ProcedureStepLite[] = [];
  const scheduleId = await resolveOrCreatePriceAdjustmentSchedule(client, baseArgs(), steps);

  assert.equal(scheduleId, "84XSCHEDULE00000A", "reuses the existing schedule, never creates a duplicate");
  assert.equal(updateLog.length, 1, "exactly one activation update");
  assert.equal(updateLog[0].object, "PriceAdjustmentSchedule");
  assert.equal(updateLog[0].id, "84XSCHEDULE00000A");
  assert.equal(updateLog[0].payload.IsActive, true);
  assert.ok(steps.some(s => s.status === "success" && /[Aa]ctivated/.test(s.message)), `expected an activation success step; got: ${JSON.stringify(steps)}`);
});

test("TEST 2 — a compatible existing schedule that is ALREADY active is reused with zero extra writes (no spurious update)", async () => {
  const updateLog: unknown[] = [];
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAS_DESCRIBE; },
    async query(soql: string) {
      if (soql.includes("FROM Pricebook2")) return { records: [{ Id: "01sPRICEBOOK0000A" }] };
      return { records: [{ Id: "84XSCHEDULE00000B", Name: "Already Active Schedule", Product2Id: "01tPRODUCT000000A", ProductSellingModelId: "0jPMODEL0000000A", ScheduleType: "Attribute", AdjustmentMethod: "Range", IsActive: true }] };
    },
    async updateRecord() { updateLog.push(1); throw new Error("must never update an already-active schedule"); },
    async createRecord() { throw new Error("must never create — a compatible schedule already exists"); },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const steps: ProcedureStepLite[] = [];
  const scheduleId = await resolveOrCreatePriceAdjustmentSchedule(client, baseArgs(), steps);

  assert.equal(scheduleId, "84XSCHEDULE00000B");
  assert.equal(updateLog.length, 0, "an already-active schedule must never be written to");
});

test("TEST 3 — activation attempt fails (e.g. a genuinely empty reused schedule Salesforce still refuses to activate): non-fatal, schedule Id is still returned, failure is reported not thrown", async () => {
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAS_DESCRIBE; },
    async query(soql: string) {
      if (soql.includes("FROM Pricebook2")) return { records: [{ Id: "01sPRICEBOOK0000A" }] };
      return { records: [{ Id: "84XSCHEDULE00000C", Name: "Empty Reused Schedule", Product2Id: "01tPRODUCT000000A", ProductSellingModelId: "0jPMODEL0000000A", ScheduleType: "Attribute", AdjustmentMethod: "Range", IsActive: false }] };
    },
    async updateRecord() { throw new Error("INVALID_FIELD_FOR_INSERT_UPDATE: no price adjustment tier"); },
    async createRecord() { throw new Error("must never create — a compatible schedule already exists"); },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const steps: ProcedureStepLite[] = [];
  const scheduleId = await resolveOrCreatePriceAdjustmentSchedule(client, baseArgs(), steps);

  assert.equal(scheduleId, "84XSCHEDULE00000C", "a failed activation attempt must never abort schedule resolution itself");
  assert.ok(steps.some(s => s.status === "info" && /still inactive/.test(s.message)), `expected a non-fatal 'still inactive' info step; got: ${JSON.stringify(steps)}`);
});

test("TEST 4 — no compatible existing schedule: creates a new one (existing, unchanged behavior) — never activated on create, per the org's own spurious-validation constraint", async () => {
  const createLog: { object: string; payload: Record<string, unknown> }[] = [];
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAS_DESCRIBE; },
    async query(soql: string) {
      if (soql.includes("FROM Pricebook2")) return { records: [{ Id: "01sPRICEBOOK0000A" }] };
      if (soql.includes("WHERE Id = '84XSCHEDULENEW000'")) return { records: [{ Id: "84XSCHEDULENEW000" }] }; // guardedCreate's own read-back verification
      return { records: [] }; // the "find compatible existing schedule" query: none exist yet
    },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      createLog.push({ object: objectName, payload });
      return { id: "84XSCHEDULENEW000" };
    },
    async updateRecord() { throw new Error("must never update — nothing was reused"); },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const steps: ProcedureStepLite[] = [];
  const scheduleId = await resolveOrCreatePriceAdjustmentSchedule(client, baseArgs(), steps);

  assert.equal(scheduleId, "84XSCHEDULENEW000");
  assert.equal(createLog.length, 1);
  assert.equal(createLog[0].payload.IsActive, undefined, "IsActive must never be set on create — this org's own validation rejects it");
});

test("TEST 5 — this org's PriceAdjustmentSchedule schema has no IsActive field at all: activation check is skipped entirely, never crashes", async () => {
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAS_DESCRIBE_NO_ISACTIVE; },
    async query(soql: string) {
      if (soql.includes("FROM Pricebook2")) return { records: [{ Id: "01sPRICEBOOK0000A" }] };
      return { records: [{ Id: "84XSCHEDULE00000D", Name: "No IsActive Field Schedule", Product2Id: "01tPRODUCT000000A", ProductSellingModelId: "0jPMODEL0000000A", ScheduleType: "Attribute", AdjustmentMethod: "Range" }] };
    },
    async updateRecord() { throw new Error("must never update — this org's schema has no IsActive field to update"); },
    async createRecord() { throw new Error("must never create — a compatible schedule already exists"); },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const steps: ProcedureStepLite[] = [];
  const scheduleId = await resolveOrCreatePriceAdjustmentSchedule(client, baseArgs(), steps);
  assert.equal(scheduleId, "84XSCHEDULE00000D");
});

test("TEST 6 — arbitrary, unusually-shaped Salesforce Ids throughout prove nothing is hardcoded (Laptop/Monitor/any future product)", async () => {
  const updateLog: { id: string }[] = [];
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAS_DESCRIBE; },
    async query(soql: string) {
      if (soql.includes("FROM Pricebook2")) return { records: [{ Id: "###weird-pricebook###" }] };
      assert.ok(soql.includes("###weird-product###"));
      return { records: [{ Id: "###weird-schedule###", Name: "Weird Schedule", Product2Id: "###weird-product###", ProductSellingModelId: "###weird-model###", ScheduleType: "Attribute", AdjustmentMethod: "Range", IsActive: false }] };
    },
    async updateRecord(_objectName: string, id: string) { updateLog.push({ id }); return { success: true }; },
    async createRecord() { throw new Error("must never create — a compatible schedule already exists"); },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const steps: ProcedureStepLite[] = [];
  const scheduleId = await resolveOrCreatePriceAdjustmentSchedule(
    client,
    { product: { id: "###weird-product###", name: "Weird Product" }, sellingModelId: "###weird-model###", procedureName: "Weird Attribute Based Pricing Procedure" },
    steps,
  );
  assert.equal(scheduleId, "###weird-schedule###");
  assert.equal(updateLog.length, 1);
  assert.equal(updateLog[0].id, "###weird-schedule###");
});
