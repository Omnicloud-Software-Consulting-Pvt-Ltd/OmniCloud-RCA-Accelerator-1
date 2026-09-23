/**
 * §Combination-expansion architecture fix (Phase 8) — `checkAttributeBasedPricingCapacityPreflight` no
 * longer discovers every historical single-attribute option for a product and computes the full Cartesian
 * product of them to estimate cost (that WAS the source of an inflated, storage-exhausting-looking estimate
 * even when the actual run would create almost nothing). It now estimates the cost of exactly the
 * `requestedCombinations` passed in — the SAME explicit set `expandAttributeCombinationRules` will
 * materialize. These tests prove the WIRING (not just the pure `estimateCombinatorialWriteCost` math,
 * already covered in capacityPreflight.test.ts): no combination requested -> zero combinatorial discovery
 * queries and zero estimated combination cost; an explicit combination requested -> only that one is priced.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import { checkAttributeBasedPricingCapacityPreflight } from "./capacityPreflight";
import type { AttributeBasedPricingSchema, AttributeContext } from "./nativeRecords";
import type { CombinationRulePlanRow } from "../types";

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

function buildSchema(): AttributeBasedPricingSchema {
  const ruleDescribe = { name: "AttributeBasedAdjRule", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("Name", "string"), field("Product2Id", "reference"), field("IsActive", "boolean")] } as unknown as DescribeResult;
  const conditionDescribe = { name: "AttributeAdjustmentCondition", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("AttributeBasedAdjRuleId", "reference"), field("ProductAttributeDefinitionId", "reference"), field("Product2Id", "reference"), field("StringValue", "string")] } as unknown as DescribeResult;
  const abaDescribe = { name: "AttributeBasedAdjustment", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("Product2Id", "reference"), field("ProductSellingModelId", "reference"), field("PriceAdjustmentScheduleId", "reference"), field("AttributeBasedAdjRuleId", "reference"), field("EffectiveFrom", "date"), field("EffectiveTo", "date"), field("AdjustmentType", "picklist"), field("AdjustmentValue", "double")] } as unknown as DescribeResult;
  const refField = (f: DescribeField) => ({ field: f, candidates: [{ field: f, score: 1 }] });
  return {
    ruleDescribe, conditionDescribe, abaDescribe,
    ruleProductField: refField(ruleDescribe.fields[2]), ruleScheduleField: { field: null, candidates: [] }, ruleActiveField: ruleDescribe.fields[3], ruleEffFromField: null, ruleEffToField: null,
    conditionRuleField: refField(conditionDescribe.fields[1]), conditionPadField: refField(conditionDescribe.fields[2]), conditionAttrDefField: { field: null, candidates: [] },
    conditionProductField: refField(conditionDescribe.fields[3]), conditionOperatorField: null,
    abaProductField: refField(abaDescribe.fields[1]), abaSellingModelField: refField(abaDescribe.fields[2]), abaRuleField: refField(abaDescribe.fields[4]),
    abaScheduleField: refField(abaDescribe.fields[3]), abaConditionField: null, abaTypeField: abaDescribe.fields[7], abaValueField: abaDescribe.fields[8],
    abaEffFromField: abaDescribe.fields[5], abaEffToField: abaDescribe.fields[6],
  } as unknown as AttributeBasedPricingSchema;
}

function buildContexts(): Map<string, AttributeContext> {
  const ctx = (padId: string): AttributeContext => ({
    attributeDefinitionId: `ad-${padId}`, dataType: "Picklist", dataTypeSource: "AttributeDefinition.DataType",
    productAttributeDefinitionId: padId, isPriceImpacting: true, productClassificationAttrId: null, source: "DIRECT",
  });
  return new Map([["RAM", ctx("pad-ram")], ["Storage", ctx("pad-storage")]]);
}

function combo(): CombinationRulePlanRow {
  return {
    members: [{ attributeName: "RAM", attributeLabel: "RAM", value: "32GB", valueLabel: "32GB" }, { attributeName: "Storage", attributeLabel: "Storage", value: "1TB", valueLabel: "1TB" }],
    adjustmentType: "fixed", adjustment: 5000, rawText: "test",
  };
}

function buildClient(queryLog: string[]): SalesforceClient {
  return {
    async describeObject() {
      return { name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("DefaultValue", "string"), field("ProductClassificationAttributeId", "reference")] } as unknown as DescribeResult;
    },
    async query(soql: string) {
      queryLog.push(soql);
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id IN")) return { records: [{ Id: "pad-ram", DefaultValue: "8GB" }, { Id: "pad-storage", DefaultValue: "256GB" }] };
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE Product2Id =")) return { records: [] }; // no existing Rules at all
      return { records: [] };
    },
    async validate() {
      return { DataStorageMB: { Max: 5, Remaining: 5 }, FileStorageMB: { Max: 20, Remaining: 20 }, DailyApiRequests: { Max: 15000, Remaining: 15000 } };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}

test("A — no explicit combination requested: zero combinatorial cost, zero Cartesian discovery", async () => {
  const queryLog: string[] = [];
  const client = buildClient(queryLog);
  const result = await checkAttributeBasedPricingCapacityPreflight(
    client, buildSchema(), { product: { id: "prod-1", name: "Laptop" }, sellingModelId: "psm-1", scheduleId: "sched-1" }, buildContexts(), [],
  );
  assert.equal(result.combinationCount, 0);
  assert.equal(result.missingCombinations, 0);
  assert.equal(result.estimatedTotalRecords, 0);
  assert.equal(result.status, "SAFE");
  assert.ok(!queryLog.some(q => q.includes("AttributeBasedAdjRule WHERE Product2Id")), "must never run the old single-attribute-option discovery query when nothing was requested");
});

test("B — one explicit combination requested: estimate reflects exactly that one combination, never a discovered/cross-produced set", async () => {
  const queryLog: string[] = [];
  const client = buildClient(queryLog);
  const result = await checkAttributeBasedPricingCapacityPreflight(
    client, buildSchema(), { product: { id: "prod-1", name: "Laptop" }, sellingModelId: "psm-1", scheduleId: "sched-1" }, buildContexts(), [combo()],
  );
  assert.equal(result.combinationCount, 1);
  assert.equal(result.missingCombinations, 1, "the one requested combination doesn't exist yet, so it's a CREATE");
  assert.equal(result.estimatedRules, 1);
  assert.equal(result.estimatedConditions, 2, "one condition per price-impacting attribute (RAM + Storage)");
  assert.equal(result.estimatedAdjustments, 1);
});
