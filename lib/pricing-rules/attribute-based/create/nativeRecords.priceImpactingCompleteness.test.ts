/**
 * §Root-cause fix regression coverage — the live FIELD_INTEGRITY_EXCEPTION ("Associate all price
 * impacting attributes with the relevant Attribute Adjustment Condition and try again") on a product
 * with MORE price-impacting attributes (6: Memory/Graphics/Processor/Display/Screen Size/Storage) than
 * the current prompt's own rules varied (3: Memory/Graphics/Processor). `createAttributeAdjustmentConditions`
 * was already proven correct (see nativeRecords.conditions.test.ts's "every OTHER price-impacting
 * attribute gets its own baseline-default condition" test) — it builds a complete condition set for
 * whatever `contexts` map it's given. The actual bug was that `createPipeline.ts` built `contexts` from
 * only the REQUESTED rules' attribute names, never the product's complete price-impacting set. This file
 * tests the two new pieces that close that gap:
 *   - `resolveAllPriceImpactingAttributeNames` — discovers the product's COMPLETE price-impacting
 *     attribute set directly from Salesforce, independent of what any prompt/rule requests.
 *   - `resolveAdjustmentConditions` / the pre-POST validation gate in `createAttributeBasedAdjustments` —
 *     refuses to send an incomplete AttributeBasedAdjustment payload, naming exactly which price-impacting
 *     attribute(s) are missing a condition, rather than letting Salesforce reject it with a generic message.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import { SalesforceError } from "@/lib/salesforce/client";
import {
  resolveAllPriceImpactingAttributeNames, resolveAdjustmentConditions, createAttributeBasedAdjustments,
  type AttributeContext, type AttributeBasedPricingSchema, type AttributeBasedRulePlan,
} from "./nativeRecords";
import type { PricingRulePlanRow } from "../types";

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

/* ── resolveAllPriceImpactingAttributeNames ── */

function buildProductAttributeDescribeClient(opts: {
  padRows: { padId: string; attrDefId: string }[];
  attributeNamesByDefId: Record<string, string>;
}): SalesforceClient {
  return {
    async describeObject(sobject: string) {
      if (sobject === "ProductAttributeDefinition") {
        return {
          name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
          fields: [
            field("Id", "id"),
            field("Product2Id", "reference", { referenceTo: ["Product2"] }),
            field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }),
            field("IsPriceImpacting", "boolean"),
          ],
        } as unknown as DescribeResult;
      }
      throw new Error(`unexpected describeObject(${sobject})`);
    },
    async query(soql: string) {
      if (soql.includes("FROM ProductAttributeDefinition WHERE") && soql.includes("IsPriceImpacting = true")) {
        return { totalSize: opts.padRows.length, done: true, records: opts.padRows.map(r => ({ AttributeDefinitionId: r.attrDefId })) };
      }
      if (soql.includes("FROM AttributeDefinition WHERE Id IN")) {
        const ids = [...new Set(opts.padRows.map(r => r.attrDefId))];
        return { totalSize: ids.length, done: true, records: ids.map(id => ({ Id: id, Name: opts.attributeNamesByDefId[id] })) };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}

test("resolveAllPriceImpactingAttributeNames returns the COMPLETE price-impacting set for the product, independent of any requested subset", async () => {
  const client = buildProductAttributeDescribeClient({
    padRows: [
      { padId: "pad-memory", attrDefId: "ad-memory" }, { padId: "pad-graphics", attrDefId: "ad-graphics" },
      { padId: "pad-processor", attrDefId: "ad-processor" }, { padId: "pad-display", attrDefId: "ad-display" },
      { padId: "pad-screensize", attrDefId: "ad-screensize" }, { padId: "pad-storage", attrDefId: "ad-storage" },
    ],
    attributeNamesByDefId: {
      "ad-memory": "Memory", "ad-graphics": "Graphics", "ad-processor": "Processor",
      "ad-display": "Display", "ad-screensize": "Screen Size", "ad-storage": "Storage",
    },
  });
  const names = await resolveAllPriceImpactingAttributeNames(client, "prod-laptop");
  assert.deepEqual(names.sort(), ["Display", "Graphics", "Memory", "Processor", "Screen Size", "Storage"]);
});

test("resolveAllPriceImpactingAttributeNames returns an empty list (never throws, never guesses) when this org's schema doesn't expose the needed fields", async () => {
  const client = {
    async describeObject() {
      return { name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id")] } as unknown as DescribeResult;
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
  const names = await resolveAllPriceImpactingAttributeNames(client, "prod-1");
  assert.deepEqual(names, []);
});

test("resolveAllPriceImpactingAttributeNames returns an empty list when the product has no price-impacting attributes at all", async () => {
  const client = buildProductAttributeDescribeClient({ padRows: [], attributeNamesByDefId: {} });
  const names = await resolveAllPriceImpactingAttributeNames(client, "prod-1");
  assert.deepEqual(names, []);
});

/* ── resolveAdjustmentConditions ── */

function buildConditionSchema(): AttributeBasedPricingSchema {
  const conditionDescribe: DescribeResult = {
    name: "AttributeAdjustmentCondition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
    fields: [
      field("Id", "id"),
      field("AttributeBasedAdjRuleId", "reference", { referenceTo: ["AttributeBasedAdjRule"] }),
      field("ProductAttributeDefinitionId", "reference", { referenceTo: ["ProductAttributeDefinition"] }),
      field("Product2Id", "reference", { referenceTo: ["Product2"] }),
      field("Operator", "picklist", { picklistValues: [{ value: "Equal", label: "Equal", active: true }] }),
      field("StringValue", "string"),
    ],
  } as unknown as DescribeResult;
  return {
    ruleDescribe: { name: "AttributeBasedAdjRule", label: "", labelPlural: "", fields: [], recordTypeInfos: [], urls: {} } as unknown as DescribeResult,
    conditionDescribe,
    abaDescribe: { name: "AttributeBasedAdjustment", label: "", labelPlural: "", fields: [], recordTypeInfos: [], urls: {} } as unknown as DescribeResult,
    ruleProductField: { field: null, candidates: [] }, ruleScheduleField: { field: null, candidates: [] },
    ruleActiveField: null, ruleEffFromField: null, ruleEffToField: null,
    conditionRuleField: { field: conditionDescribe.fields.find(f => f.name === "AttributeBasedAdjRuleId")!, candidates: [] },
    conditionPadField: { field: conditionDescribe.fields.find(f => f.name === "ProductAttributeDefinitionId")!, candidates: [] },
    conditionAttrDefField: { field: null, candidates: [] },
    conditionProductField: { field: conditionDescribe.fields.find(f => f.name === "Product2Id")!, candidates: [] },
    conditionOperatorField: conditionDescribe.fields.find(f => f.name === "Operator")!,
    abaProductField: { field: null, candidates: [] }, abaSellingModelField: { field: null, candidates: [] },
    abaRuleField: { field: null, candidates: [] }, abaScheduleField: { field: null, candidates: [] },
    abaConditionField: null, abaTypeField: null, abaValueField: null, abaEffFromField: null, abaEffToField: null,
  };
}

function buildContexts(attrs: { name: string; padId: string }[]): Map<string, AttributeContext> {
  const contexts = new Map<string, AttributeContext>();
  for (const a of attrs) {
    contexts.set(a.name, { attributeDefinitionId: null, dataType: "Text", dataTypeSource: null, productAttributeDefinitionId: a.padId, isPriceImpacting: true, productClassificationAttrId: null, source: "DIRECT" });
  }
  return contexts;
}

function buildConditionQueryClient(conditionsForRule: { pad: string; value: string }[]): SalesforceClient {
  return {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        return { totalSize: conditionsForRule.length, done: true, records: conditionsForRule.map((c, i) => ({ Id: `cond-${i}`, ProductAttributeDefinitionId: c.pad, StringValue: c.value })) };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}

test("resolveAdjustmentConditions reports valid=true with zero missing attributes when the rule has a condition for every expected price-impacting attribute", async () => {
  const schema = buildConditionSchema();
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }, { name: "Graphics", padId: "pad-graphics" }, { name: "Processor", padId: "pad-processor" }]);
  const client = buildConditionQueryClient([
    { pad: "pad-memory", value: "RAM 8GB" }, { pad: "pad-graphics", value: "Intel Iris Xe Graphics" }, { pad: "pad-processor", value: "i5-CPU 4.4GHz" },
  ]);
  const result = await resolveAdjustmentConditions(client, schema, contexts, "rule-1", ["Memory", "Graphics", "Processor"]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.missingAttributes, []);
  assert.equal(result.conditions.length, 3);
});

// §The exact live bug — a rule built when `contexts` only covered 3 of the product's 6 real
// price-impacting attributes: it has conditions for Memory/Graphics/Processor but is missing
// Display/Screen Size/Storage entirely, which is exactly what Salesforce's own FIELD_INTEGRITY_EXCEPTION
// was rejecting.
test("resolveAdjustmentConditions reports valid=false and names EVERY missing price-impacting attribute — the exact live bug shape (3 of 6 covered)", async () => {
  const schema = buildConditionSchema();
  const contexts = buildContexts([
    { name: "Memory", padId: "pad-memory" }, { name: "Graphics", padId: "pad-graphics" }, { name: "Processor", padId: "pad-processor" },
    { name: "Display", padId: "pad-display" }, { name: "Screen Size", padId: "pad-screensize" }, { name: "Storage", padId: "pad-storage" },
  ]);
  const client = buildConditionQueryClient([
    { pad: "pad-memory", value: "RAM 8GB" }, { pad: "pad-graphics", value: "Intel Iris Xe Graphics" }, { pad: "pad-processor", value: "i5-CPU 4.4GHz" },
  ]);
  const result = await resolveAdjustmentConditions(client, schema, contexts, "rule-1", ["Memory", "Graphics", "Processor", "Display", "Screen Size", "Storage"]);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingAttributes.sort(), ["Display", "Screen Size", "Storage"]);
  assert.equal(result.conditions.length, 3, "the 3 conditions that DO exist are still reported, not hidden");
});

test("resolveAdjustmentConditions flags a condition for an attribute OUTSIDE the expected set as unexpected, without treating it as a validity failure on its own", async () => {
  const schema = buildConditionSchema();
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }, { name: "Graphics", padId: "pad-graphics" }]);
  const client = buildConditionQueryClient([{ pad: "pad-memory", value: "RAM 8GB" }, { pad: "pad-graphics", value: "Intel Iris Xe Graphics" }]);
  const result = await resolveAdjustmentConditions(client, schema, contexts, "rule-1", ["Memory"]);
  assert.equal(result.valid, true, "Memory (the only expected attribute) is present — extra Graphics condition doesn't invalidate");
  assert.deepEqual(result.unexpectedAttributes, ["Graphics"]);
});

/* ── createAttributeBasedAdjustments — the actual pre-POST gate ── */

function buildFullAdjustmentSchema(): AttributeBasedPricingSchema {
  const base = buildConditionSchema();
  const abaDescribe: DescribeResult = {
    name: "AttributeBasedAdjustment", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
    fields: [
      field("Id", "id"), field("Product2Id", "reference", { referenceTo: ["Product2"] }),
      field("PriceAdjustmentScheduleId", "reference", { referenceTo: ["PriceAdjustmentSchedule"] }),
      field("AttributeBasedAdjRuleId", "reference", { referenceTo: ["AttributeBasedAdjRule"] }),
      field("ProductSellingModelId", "reference", { referenceTo: ["ProductSellingModel"] }),
      field("AdjustmentType", "picklist", { picklistValues: [{ value: "Amount", label: "Amount", active: true }] }),
      field("AdjustmentValue", "double"), field("EffectiveFrom", "date"), field("EffectiveTo", "date"),
    ],
  } as unknown as DescribeResult;
  return {
    ...base, abaDescribe,
    abaProductField: { field: abaDescribe.fields.find(f => f.name === "Product2Id")!, candidates: [] },
    abaSellingModelField: { field: abaDescribe.fields.find(f => f.name === "ProductSellingModelId")!, candidates: [] },
    abaRuleField: { field: abaDescribe.fields.find(f => f.name === "AttributeBasedAdjRuleId")!, candidates: [] },
    abaScheduleField: { field: abaDescribe.fields.find(f => f.name === "PriceAdjustmentScheduleId")!, candidates: [] },
    abaConditionField: null,
    abaTypeField: abaDescribe.fields.find(f => f.name === "AdjustmentType")!,
    abaValueField: abaDescribe.fields.find(f => f.name === "AdjustmentValue")!,
    abaEffFromField: abaDescribe.fields.find(f => f.name === "EffectiveFrom")!,
    abaEffToField: abaDescribe.fields.find(f => f.name === "EffectiveTo")!,
  };
}

function buildRow(attributeName: string, value: string): PricingRulePlanRow {
  return { attributeName, attributeLabel: attributeName, value, valueLabel: value, isNewValue: false, adjustmentType: "fixed", adjustment: -10 } as unknown as PricingRulePlanRow;
}

function buildAdjustmentMockClient(conditionsForRule: { pad: string; value: string }[], opts: { onCreate?: () => void } = {}): SalesforceClient {
  const createdAdjustments = new Map<string, Record<string, unknown> & { Id: string }>();
  let nextId = 1;
  return {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        return { totalSize: conditionsForRule.length, done: true, records: conditionsForRule.map((c, i) => ({ Id: `cond-${i}`, ProductAttributeDefinitionId: c.pad, StringValue: c.value })) };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE Id = ")) {
        const m = soql.match(/WHERE Id = '([^']+)'/);
        const rec = m && createdAdjustments.get(m[1]);
        return { totalSize: rec ? 1 : 0, done: true, records: rec ? [rec] : [] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment")) {
        return { totalSize: 0, done: true, records: [] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      opts.onCreate?.();
      if (objectName !== "AttributeBasedAdjustment") throw new Error(`unexpected createRecord: ${objectName}`);
      const id = `adj-${nextId++}`;
      createdAdjustments.set(id, { Id: id, ...payload } as Record<string, unknown> & { Id: string });
      return { id };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}

test("createAttributeBasedAdjustments REFUSES to POST when the rule's condition set is missing a required price-impacting attribute — the exact live bug, caught before any Salesforce write", async () => {
  const schema = buildFullAdjustmentSchema();
  // contexts declares 3 price-impacting attributes, but this rule's actual conditions (as Salesforce
  // would report them back) only cover 2 — exactly the "3 of 6 covered" live shape, scaled down.
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }, { name: "Graphics", padId: "pad-graphics" }, { name: "Processor", padId: "pad-processor" }]);
  let createCalls = 0;
  const client = buildAdjustmentMockClient(
    [{ pad: "pad-memory", value: "RAM 8GB" }, { pad: "pad-graphics", value: "Intel Iris Xe Graphics" }], // Processor missing
    { onCreate: () => { createCalls++; } },
  );
  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: ["cond-0", "cond-1"], ruleProductId: "prod-1" },
  ];
  await assert.rejects(
    () => createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []),
    (err: Error) => {
      assert.match(err.message, /Processor/);
      assert.match(err.message, /missing a condition/i);
      return true;
    },
  );
  assert.equal(createCalls, 0, "no Salesforce write may happen when the condition set is provably incomplete");
});

test("createAttributeBasedAdjustments proceeds normally when the rule's condition set fully covers every price-impacting attribute (positive control)", async () => {
  const schema = buildFullAdjustmentSchema();
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }, { name: "Graphics", padId: "pad-graphics" }, { name: "Processor", padId: "pad-processor" }]);
  let createCalls = 0;
  const client = buildAdjustmentMockClient(
    [{ pad: "pad-memory", value: "RAM 8GB" }, { pad: "pad-graphics", value: "Intel Iris Xe Graphics" }, { pad: "pad-processor", value: "i5-CPU 4.4GHz" }],
    { onCreate: () => { createCalls++; } },
  );
  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: ["cond-0", "cond-1", "cond-2"], ruleProductId: "prod-1" },
  ];
  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);
  assert.equal(createCalls, 1);
  assert.equal(result.adjustmentIds.length, 1);
});

/* ── isMissingPriceImpactingAssociationError — via the real Salesforce error text, exercised end to end ── */

test("createAttributeBasedAdjustments turns Salesforce's real 'Associate all price impacting attributes' rejection into a diagnostic naming the missing attribute(s), never a bare rethrow", async () => {
  const schema = buildFullAdjustmentSchema();
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }, { name: "Graphics", padId: "pad-graphics" }]);
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        // Both conditions genuinely exist (this simulates a scenario where completeness LOOKS fine to
        // this run's own re-query, e.g. a stricter org-side rule this pipeline can't see) — Salesforce's
        // own rejection is still authoritative and must never be silently swallowed.
        return { totalSize: 2, done: true, records: [{ Id: "c0", ProductAttributeDefinitionId: "pad-memory", StringValue: "RAM 8GB" }, { Id: "c1", ProductAttributeDefinitionId: "pad-graphics", StringValue: "Intel Iris Xe Graphics" }] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment")) return { totalSize: 0, done: true, records: [] };
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord() {
      throw new SalesforceError(
        "Associate all price impacting attributes with the relevant Attribute Adjustment Condition and try again.",
        400,
        [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: "Associate all price impacting attributes with the relevant Attribute Adjustment Condition and try again." }],
      );
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: ["c0", "c1"], ruleProductId: "prod-1" },
  ];
  await assert.rejects(
    () => createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []),
    (err: Error) => {
      assert.match(err.message, /Associate all price impacting attributes/i);
      assert.match(err.message, /Memory/);
      assert.match(err.message, /Graphics/);
      return true;
    },
  );
});
