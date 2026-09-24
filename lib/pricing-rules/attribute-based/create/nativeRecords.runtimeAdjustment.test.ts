/**
 * §Live-org fix (runtime evaluation) — regression coverage for `resolveRuntimeAttributeAdjustment`, the
 * read-only replica of Salesforce's OWN AttributeDiscount runtime lookup: given an arbitrary Product +
 * arbitrary selected Attribute/AttributeValue (exactly the shape a real SalesTransactionItemAttribute row
 * carries), dynamically resolve Product2 -> AttributeAdjustmentCondition -> AttributeBasedAdjRule ->
 * AttributeBasedAdjustment -> AdjustmentType/AdjustmentValue, using ONLY live Salesforce data (never a
 * prompt-supplied "expected" value) and matching against the SAME Product/ProductSellingModel/
 * PriceAdjustmentSchedule identity the create pipeline itself uses.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import { resolveRuntimeAttributeAdjustment, type AttributeBasedPricingSchema } from "./nativeRecords";

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

function buildSchema(): AttributeBasedPricingSchema {
  const conditionDescribe: DescribeResult = {
    name: "AttributeAdjustmentCondition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
    fields: [
      field("Id", "id"),
      field("AttributeBasedAdjRuleId", "reference", { referenceTo: ["AttributeBasedAdjRule"] }),
      field("ProductAttributeDefinitionId", "reference", { referenceTo: ["ProductAttributeDefinition"] }),
      field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }),
      field("Product2Id", "reference", { referenceTo: ["Product2"] }),
      field("Operator", "picklist", { picklistValues: [{ value: "Equal", label: "Equal", active: true }] }),
      field("StringValue", "string"),
    ],
  } as unknown as DescribeResult;

  const abaDescribe: DescribeResult = {
    name: "AttributeBasedAdjustment", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
    fields: [
      field("Id", "id"),
      field("Product2Id", "reference", { referenceTo: ["Product2"] }),
      field("ProductSellingModelId", "reference", { referenceTo: ["ProductSellingModel"] }),
      field("AttributeBasedAdjRuleId", "reference", { referenceTo: ["AttributeBasedAdjRule"] }),
      field("PriceAdjustmentScheduleId", "reference", { referenceTo: ["PriceAdjustmentSchedule"] }),
      field("AdjustmentType", "picklist", { picklistValues: [{ value: "Discount - Amount", label: "Discount - Amount", active: true }] }),
      field("AdjustmentValue", "currency"),
    ],
  } as unknown as DescribeResult;

  const ruleField = conditionDescribe.fields.find(f => f.name === "AttributeBasedAdjRuleId")!;
  const padField = conditionDescribe.fields.find(f => f.name === "ProductAttributeDefinitionId")!;
  const attrDefField = conditionDescribe.fields.find(f => f.name === "AttributeDefinitionId")!;
  const productField = conditionDescribe.fields.find(f => f.name === "Product2Id")!;
  const operatorField = conditionDescribe.fields.find(f => f.name === "Operator")!;

  const abaProductField = abaDescribe.fields.find(f => f.name === "Product2Id")!;
  const abaSellingModelField = abaDescribe.fields.find(f => f.name === "ProductSellingModelId")!;
  const abaRuleField = abaDescribe.fields.find(f => f.name === "AttributeBasedAdjRuleId")!;
  const abaScheduleField = abaDescribe.fields.find(f => f.name === "PriceAdjustmentScheduleId")!;
  const abaTypeField = abaDescribe.fields.find(f => f.name === "AdjustmentType")!;
  const abaValueField = abaDescribe.fields.find(f => f.name === "AdjustmentValue")!;

  return {
    ruleDescribe: { name: "AttributeBasedAdjRule", label: "", labelPlural: "", fields: [], recordTypeInfos: [], urls: {} } as unknown as DescribeResult,
    conditionDescribe,
    abaDescribe,
    ruleProductField: { field: null, candidates: [] },
    ruleScheduleField: { field: null, candidates: [] },
    ruleActiveField: null, ruleEffFromField: null, ruleEffToField: null,
    conditionRuleField: { field: ruleField, candidates: [] },
    conditionPadField: { field: padField, candidates: [] },
    conditionAttrDefField: { field: attrDefField, candidates: [] },
    conditionProductField: { field: productField, candidates: [] },
    conditionOperatorField: operatorField,
    abaProductField: { field: abaProductField, candidates: [] },
    abaSellingModelField: { field: abaSellingModelField, candidates: [] },
    abaRuleField: { field: abaRuleField, candidates: [] },
    abaScheduleField: { field: abaScheduleField, candidates: [] },
    abaConditionField: null, abaTypeField, abaValueField, abaEffFromField: null, abaEffToField: null,
  };
}

interface AttrDef { attrDefId: string; padId: string; dataType?: string }
interface ConditionRow { id: string; ruleId: string; padId: string; value: string; productId: string }
interface AdjustmentRow { id: string; ruleId: string; productId?: string | null; sellingModelId?: string | null; scheduleId?: string | null; type?: string | null; value?: unknown }

let instanceUrlCounter = 0;
function uniqueInstanceUrl(): string {
  instanceUrlCounter += 1;
  return `https://test-org-runtime-adj-${instanceUrlCounter}.my.salesforce.com`;
}

function buildRuntimeMockClient(opts: { attrs: Record<string, AttrDef>; conditions: ConditionRow[]; adjustments: AdjustmentRow[] }): SalesforceClient {
  return {
    instanceUrl: uniqueInstanceUrl(),
    // No ProductClassification/ProductClassificationAttr support on this org — the classification
    // inheritance path short-circuits to UNSUPPORTED, matching the plain Laptop/Monitor-style org shape.
    async describeSObjects() {
      return { sobjects: [] };
    },
    async describeObject(name: string) {
      if (name === "AttributeDefinition") {
        return { name: "AttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("Name", "string"), field("DataType", "picklist")] };
      }
      if (name === "ProductAttributeDefinition") {
        return {
          name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
          fields: [field("Id", "id"), field("Product2Id", "reference", { referenceTo: ["Product2"] }), field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }), field("IsPriceImpacting", "boolean"), field("DataType", "picklist"), field("DefaultValue", "string")],
        };
      }
      throw new Error(`unexpected describeObject(${name})`);
    },
    async query(soql: string) {
      if (soql.includes("FROM AttributeDefinition WHERE Name IN")) {
        const names = [...soql.matchAll(/'([^']+)'/g)].map(m => m[1]);
        const records = names.filter(n => opts.attrs[n]).map(n => ({ Id: opts.attrs[n].attrDefId, Name: n, DataType: opts.attrs[n].dataType ?? "Text" }));
        return { totalSize: records.length, done: true, records };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE")) {
        const records = Object.values(opts.attrs).map(a => ({ Id: a.padId, AttributeDefinitionId: a.attrDefId, IsPriceImpacting: true, DataType: a.dataType ?? "Text" }));
        return { totalSize: records.length, done: true, records };
      }
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        const records = opts.conditions
          .filter(c => soql.includes(`ProductAttributeDefinitionId = '${c.padId}'`) && soql.includes(`StringValue = '${c.value}'`) && soql.includes(`Product2Id = '${c.productId}'`))
          .map(c => ({ Id: c.id, AttributeBasedAdjRuleId: c.ruleId }));
        return { totalSize: records.length, done: true, records };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE")) {
        const m = soql.match(/AttributeBasedAdjRuleId = '([^']+)'/);
        const ruleId = m?.[1];
        const records = opts.adjustments.filter(a => a.ruleId === ruleId).map(a => ({
          Id: a.id, Product2Id: a.productId ?? null, ProductSellingModelId: a.sellingModelId ?? null,
          PriceAdjustmentScheduleId: a.scheduleId ?? null, AdjustmentType: a.type ?? null, AdjustmentValue: a.value ?? null,
        }));
        return { totalSize: records.length, done: true, records };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}

const PRODUCT_ID = "01tArbitraryProduct001";
const SELLING_MODEL_ID = "1PSArbitrarySellingM01";
const SCHEDULE_ID = "0Z6ArbitrarySchedule01";

test("1) Memory = RAM 64GB resolves the configured adjustment (Rule/Condition/Adjustment all resolved, exact AdjustmentValue from Salesforce)", async () => {
  const schema = buildSchema();
  const client = buildRuntimeMockClient({
    attrs: { Memory: { attrDefId: "ad-memory", padId: "pad-memory" } },
    conditions: [{ id: "cond-64", ruleId: "rule-64", padId: "pad-memory", value: "RAM 64GB", productId: PRODUCT_ID }],
    adjustments: [{ id: "adj-64", ruleId: "rule-64", productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, type: "Discount - Amount", value: -50 }],
  });
  const trace = await resolveRuntimeAttributeAdjustment(client, schema, {
    productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, attributeName: "Memory", attributeValue: "RAM 64GB",
  });
  assert.equal(trace.resolved, true);
  assert.equal(trace.ruleId, "rule-64");
  assert.equal(trace.conditionId, "cond-64");
  assert.equal(trace.adjustmentId, "adj-64");
  assert.equal(trace.adjustmentType, "Discount - Amount");
  assert.equal(trace.adjustmentValue, -50);
});

test("2) changing to another Memory value resolves a DIFFERENT adjustment (different price outcome), never the same one reused across values", async () => {
  const schema = buildSchema();
  const client = buildRuntimeMockClient({
    attrs: { Memory: { attrDefId: "ad-memory", padId: "pad-memory" } },
    conditions: [
      { id: "cond-64", ruleId: "rule-64", padId: "pad-memory", value: "RAM 64GB", productId: PRODUCT_ID },
      { id: "cond-32", ruleId: "rule-32", padId: "pad-memory", value: "RAM 32GB", productId: PRODUCT_ID },
    ],
    adjustments: [
      { id: "adj-64", ruleId: "rule-64", productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, type: "Discount - Amount", value: -50 },
      { id: "adj-32", ruleId: "rule-32", productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, type: "Discount - Amount", value: -20 },
    ],
  });
  const traceA = await resolveRuntimeAttributeAdjustment(client, schema, { productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, attributeName: "Memory", attributeValue: "RAM 64GB" });
  const traceB = await resolveRuntimeAttributeAdjustment(client, schema, { productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, attributeName: "Memory", attributeValue: "RAM 32GB" });
  assert.equal(traceA.resolved, true);
  assert.equal(traceB.resolved, true);
  assert.notEqual(traceA.adjustmentId, traceB.adjustmentId);
  assert.notEqual(traceA.adjustmentValue, traceB.adjustmentValue, "a different selected value must change the resulting adjustment/price");
});

test("3) a second, independent attribute resolves simultaneously alongside the first — no hardcoded single combination rule", async () => {
  const schema = buildSchema();
  const client = buildRuntimeMockClient({
    attrs: {
      Memory: { attrDefId: "ad-memory", padId: "pad-memory" },
      Graphics: { attrDefId: "ad-graphics", padId: "pad-graphics" },
    },
    conditions: [
      { id: "cond-mem", ruleId: "rule-mem", padId: "pad-memory", value: "RAM 64GB", productId: PRODUCT_ID },
      { id: "cond-gfx", ruleId: "rule-gfx", padId: "pad-graphics", value: "RTX 3060", productId: PRODUCT_ID },
    ],
    adjustments: [
      { id: "adj-mem", ruleId: "rule-mem", productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, type: "Discount - Amount", value: -50 },
      { id: "adj-gfx", ruleId: "rule-gfx", productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, type: "Discount - Amount", value: -30 },
    ],
  });
  const memTrace = await resolveRuntimeAttributeAdjustment(client, schema, { productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, attributeName: "Memory", attributeValue: "RAM 64GB" });
  const gfxTrace = await resolveRuntimeAttributeAdjustment(client, schema, { productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, attributeName: "Graphics", attributeValue: "RTX 3060" });
  assert.equal(memTrace.resolved, true);
  assert.equal(gfxTrace.resolved, true);
  assert.notEqual(memTrace.adjustmentId, gfxTrace.adjustmentId);
  const cumulative = (memTrace.adjustmentValue as number) + (gfxTrace.adjustmentValue as number);
  assert.equal(cumulative, -80, "both adjustments resolve independently and can be summed cumulatively against the base price");
});

test("4) no adjustment is applied when the selected value has no matching rule — resolved:false, a valid outcome, never an error/throw", async () => {
  const schema = buildSchema();
  const client = buildRuntimeMockClient({
    attrs: { Memory: { attrDefId: "ad-memory", padId: "pad-memory" } },
    conditions: [{ id: "cond-64", ruleId: "rule-64", padId: "pad-memory", value: "RAM 64GB", productId: PRODUCT_ID }],
    adjustments: [{ id: "adj-64", ruleId: "rule-64", productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, type: "Discount - Amount", value: -50 }],
  });
  const trace = await resolveRuntimeAttributeAdjustment(client, schema, {
    productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, attributeName: "Memory", attributeValue: "RAM 16GB",
  });
  assert.equal(trace.resolved, false);
  assert.equal(trace.adjustmentId, null);
  assert.ok(trace.reason.includes("no configured pricing rule") || trace.reason.toLowerCase().includes("no adjustment applies"));
});

test("5) the runtime resolver never uses a prompt-supplied adjustment value — it returns the ACTUAL Salesforce AdjustmentValue even when that differs from a hypothetical prompt expectation", async () => {
  const schema = buildSchema();
  const PROMPT_SUGGESTED_VALUE = -999; // what a prompt might have said — must be irrelevant to the resolver
  const REAL_SALESFORCE_VALUE = -50; // what is actually stored on the AttributeBasedAdjustment record
  const client = buildRuntimeMockClient({
    attrs: { Memory: { attrDefId: "ad-memory", padId: "pad-memory" } },
    conditions: [{ id: "cond-64", ruleId: "rule-64", padId: "pad-memory", value: "RAM 64GB", productId: PRODUCT_ID }],
    adjustments: [{ id: "adj-64", ruleId: "rule-64", productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, type: "Discount - Amount", value: REAL_SALESFORCE_VALUE }],
  });
  // Note: resolveRuntimeAttributeAdjustment's args have no field for a prompt/expected value at all —
  // the only inputs are Product/SellingModel/Schedule/Attribute/Value, exactly what a real
  // SalesTransactionItemAttribute selection carries.
  const trace = await resolveRuntimeAttributeAdjustment(client, schema, {
    productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, attributeName: "Memory", attributeValue: "RAM 64GB",
  });
  assert.equal(trace.adjustmentValue, REAL_SALESFORCE_VALUE);
  assert.notEqual(trace.adjustmentValue, PROMPT_SUGGESTED_VALUE);
});

test("6) no Salesforce IDs are hardcoded — arbitrary, unconventional Id shapes resolve exactly the same way as realistic-looking ones", async () => {
  const schema = buildSchema();
  const weirdProductId = "zzz-not-a-real-sfid-shape-999";
  const weirdScheduleId = "!!!weird-schedule-id###";
  const weirdSellingModelId = "psm/with/slashes";
  const client = buildRuntimeMockClient({
    attrs: { Storage: { attrDefId: "ad-storage", padId: "pad-storage" } },
    conditions: [{ id: "cond-2tb", ruleId: "rule-2tb", padId: "pad-storage", value: "2TB", productId: weirdProductId }],
    adjustments: [{ id: "adj-2tb", ruleId: "rule-2tb", productId: weirdProductId, sellingModelId: weirdSellingModelId, scheduleId: weirdScheduleId, type: "Discount - Amount", value: -75 }],
  });
  const trace = await resolveRuntimeAttributeAdjustment(client, schema, {
    productId: weirdProductId, sellingModelId: weirdSellingModelId, scheduleId: weirdScheduleId, attributeName: "Storage", attributeValue: "2TB",
  });
  assert.equal(trace.resolved, true);
  assert.equal(trace.adjustmentId, "adj-2tb");
  assert.equal(trace.adjustmentValue, -75);
});

test("7) the resolver never trusts a stale/mismatched schedule Id — a schedule that doesn't match the Adjustment's actual schedule fails to resolve rather than silently applying the wrong adjustment", async () => {
  const schema = buildSchema();
  const staleScheduleId = "0Z6STALEFROMCREATE001";
  const currentScheduleId = "0Z6CURRENTLYDEPLOYED9";
  const client = buildRuntimeMockClient({
    attrs: { Memory: { attrDefId: "ad-memory", padId: "pad-memory" } },
    conditions: [{ id: "cond-64", ruleId: "rule-64", padId: "pad-memory", value: "RAM 64GB", productId: PRODUCT_ID }],
    // The Adjustment actually stored in Salesforce is scoped to the CURRENT schedule, not the stale one.
    adjustments: [{ id: "adj-64", ruleId: "rule-64", productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: currentScheduleId, type: "Discount - Amount", value: -50 }],
  });
  const traceWithStaleSchedule = await resolveRuntimeAttributeAdjustment(client, schema, {
    productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: staleScheduleId, attributeName: "Memory", attributeValue: "RAM 64GB",
  });
  assert.equal(traceWithStaleSchedule.resolved, false, "a stale schedule Id must never silently match a differently-scheduled Adjustment");

  const traceWithCurrentSchedule = await resolveRuntimeAttributeAdjustment(client, schema, {
    productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: currentScheduleId, attributeName: "Memory", attributeValue: "RAM 64GB",
  });
  assert.equal(traceWithCurrentSchedule.resolved, true, "resolving with the CURRENT (dynamically-obtained) schedule Id must succeed");
  assert.equal(traceWithCurrentSchedule.adjustmentId, "adj-64");
});

test("ambiguous match across two different Adjustments for the same Product+Schedule is refused, never guessed", async () => {
  const schema = buildSchema();
  const client = buildRuntimeMockClient({
    attrs: { Memory: { attrDefId: "ad-memory", padId: "pad-memory" } },
    conditions: [{ id: "cond-64", ruleId: "rule-64", padId: "pad-memory", value: "RAM 64GB", productId: PRODUCT_ID }],
    adjustments: [
      { id: "adj-a", ruleId: "rule-64", productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, type: "Discount - Amount", value: -50 },
      { id: "adj-b", ruleId: "rule-64", productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, type: "Discount - Percent", value: -10 },
    ],
  });
  const trace = await resolveRuntimeAttributeAdjustment(client, schema, {
    productId: PRODUCT_ID, sellingModelId: SELLING_MODEL_ID, scheduleId: SCHEDULE_ID, attributeName: "Memory", attributeValue: "RAM 64GB",
  });
  assert.equal(trace.resolved, false);
  assert.ok(trace.reason.includes("Ambiguous"));
});
