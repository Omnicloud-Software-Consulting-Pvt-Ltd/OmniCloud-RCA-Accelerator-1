/**
 * §Root-cause fix (this turn) — live-reported bug: "Storage = SSD Hard Drive 256GB → 12 different
 * AttributeBasedAdjustment records" during runtime verification, even though the SAME run's per-rule
 * `verifyAttributeBasedAdjustmentConfigurations` check had already independently confirmed all 12
 * adjustment configurations were correct.
 *
 * Root cause: the OLD runtime check (`resolveRuntimeAttributeAdjustment`) looked up ONE isolated
 * attribute/value pair. Because Salesforce's own validation requires every price-impacting attribute to
 * have a condition on EVERY rule (not just the one it varies), a value that happens to be one attribute's
 * BASELINE default legitimately appears as a condition on MANY different rules — the rule that varies it,
 * plus every other rule that keeps it at baseline while varying something else. A single-attribute lookup
 * is therefore mathematically guaranteed to be ambiguous for a shared baseline value — that reflects a
 * correctly-built dataset, not a broken one.
 *
 * Fix: `verifyRuntimeAdjustmentResolution` matches on the COMPLETE condition set a rule represents (the
 * same identity `findExistingAttributeBasedAdjustment` already uses at create time), which correctly
 * disambiguates a shared baseline value by construction.
 *
 * These tests build the EXACT reported shape — one attribute's baseline value shared across several
 * rules — and prove the new verifier resolves every one of them correctly, while the OLD single-attribute
 * resolver (still present, unchanged, for its own narrower purpose) would indeed report the same value as
 * ambiguous across multiple rules, confirming the bug was real and is fixed by using the right query, not
 * by suppressing the old one's honest answer.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import {
  createAttributeBasedAdjustments, verifyRuntimeAdjustmentResolution,
  type AttributeContext, type AttributeBasedPricingSchema, type AttributeBasedRulePlan,
} from "./nativeRecords";
import type { PricingRulePlanRow } from "../types";

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

function buildFullSchema(): AttributeBasedPricingSchema {
  const ruleDescribe: DescribeResult = {
    name: "AttributeBasedAdjRule", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
    fields: [field("Id", "id"), field("Name", "string"), field("Product2Id", "reference", { referenceTo: ["Product2"] }), field("PriceAdjustmentScheduleId", "reference", { referenceTo: ["PriceAdjustmentSchedule"] })],
  } as unknown as DescribeResult;
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
      field("PriceAdjustmentScheduleId", "reference", { referenceTo: ["PriceAdjustmentSchedule"] }),
      field("AttributeBasedAdjRuleId", "reference", { referenceTo: ["AttributeBasedAdjRule"] }),
      field("ProductSellingModelId", "reference", { referenceTo: ["ProductSellingModel"] }),
      field("AdjustmentType", "picklist", { picklistValues: [{ value: "Amount", label: "Amount", active: true }] }),
      field("AdjustmentValue", "double"),
      field("EffectiveFrom", "date"),
      field("EffectiveTo", "date"),
    ],
  } as unknown as DescribeResult;

  return {
    ruleDescribe, conditionDescribe, abaDescribe,
    ruleProductField: { field: ruleDescribe.fields.find(f => f.name === "Product2Id")!, candidates: [] },
    ruleScheduleField: { field: ruleDescribe.fields.find(f => f.name === "PriceAdjustmentScheduleId")!, candidates: [] },
    ruleActiveField: null, ruleEffFromField: null, ruleEffToField: null,
    conditionRuleField: { field: conditionDescribe.fields.find(f => f.name === "AttributeBasedAdjRuleId")!, candidates: [] },
    conditionPadField: { field: conditionDescribe.fields.find(f => f.name === "ProductAttributeDefinitionId")!, candidates: [] },
    conditionAttrDefField: { field: conditionDescribe.fields.find(f => f.name === "AttributeDefinitionId")!, candidates: [] },
    conditionProductField: { field: conditionDescribe.fields.find(f => f.name === "Product2Id")!, candidates: [] },
    conditionOperatorField: conditionDescribe.fields.find(f => f.name === "Operator")!,
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

function buildContexts(attrs: { name: string; padId: string; attrDefId: string }[]): Map<string, AttributeContext> {
  const contexts = new Map<string, AttributeContext>();
  for (const a of attrs) {
    contexts.set(a.name, {
      attributeDefinitionId: a.attrDefId, dataType: "Text", dataTypeSource: "AttributeDefinition.DataType",
      productAttributeDefinitionId: a.padId, isPriceImpacting: true, productClassificationAttrId: null, source: "DIRECT",
    });
  }
  return contexts;
}

function buildRow(attributeName: string, value: string, adjustment = -10): PricingRulePlanRow {
  return {
    attributeName, attributeLabel: attributeName, value, valueLabel: value,
    isNewValue: false, adjustmentType: "fixed", adjustment,
  } as unknown as PricingRulePlanRow;
}

interface MockStore {
  conditionsByRule: Map<string, { pad: string; value: string }[]>;
  createdAdjustments: Map<string, Record<string, unknown> & { Id: string }>;
  nextId: number;
}
function buildStore(): MockStore {
  return { conditionsByRule: new Map(), createdAdjustments: new Map(), nextId: 1 };
}
function buildMockClient(store: MockStore): SalesforceClient {
  return {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        const m = soql.match(/AttributeBasedAdjRuleId = '([^']+)'/);
        const conds = (m && store.conditionsByRule.get(m[1])) || [];
        return { totalSize: conds.length, done: true, records: conds.map((c, i) => ({ Id: `cond-${m?.[1]}-${i}`, ProductAttributeDefinitionId: c.pad, StringValue: c.value })) };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE Id = ")) {
        const m = soql.match(/WHERE Id = '([^']+)'/);
        const rec = m && store.createdAdjustments.get(m[1]);
        return { totalSize: rec ? 1 : 0, done: true, records: rec ? [rec] : [] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment")) {
        const productMatch = soql.match(/Product2Id = '([^']+)'/);
        const scheduleMatch = soql.match(/PriceAdjustmentScheduleId = '([^']+)'/);
        const records = [...store.createdAdjustments.values()].filter(r =>
          (!productMatch || r.Product2Id === productMatch[1]) && (!scheduleMatch || r.PriceAdjustmentScheduleId === scheduleMatch[1]));
        return { totalSize: records.length, done: true, records };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      if (objectName !== "AttributeBasedAdjustment") throw new Error(`unexpected createRecord: ${objectName}`);
      const id = `adj-${store.nextId++}`;
      store.createdAdjustments.set(id, { Id: id, ...payload } as Record<string, unknown> & { Id: string });
      return { id };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}
function makePlan(store: MockStore, ruleId: string, attributeName: string, value: string, conditions: { pad: string; value: string }[]): AttributeBasedRulePlan {
  store.conditionsByRule.set(ruleId, conditions);
  return { row: buildRow(attributeName, value), ctx: {} as AttributeContext, ruleId, reusedExisting: false, conditionIds: conditions.map((_, i) => `cond-${ruleId}-${i}`), ruleProductId: null };
}

const MEMORY_CTX = { name: "Memory", padId: "pad-memory", attrDefId: "ad-memory" };
const STORAGE_CTX = { name: "Storage", padId: "pad-storage", attrDefId: "ad-storage" };

test("TEST — live-bug reproduction: a value shared as another rule's baseline default no longer causes a false runtime ambiguity", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, STORAGE_CTX]);
  const store = buildStore();
  const client = buildMockClient(store);

  // Storage's baseline default is 256GB. Three rules: one varies Storage itself (at its own baseline
  // value — the exact live shape, per this module's own "shared signature" precedent), two vary Memory
  // while keeping Storage at its 256GB baseline — matching the live report's "12 rules share
  // Storage=256GB" exactly, just at a smaller scale.
  const plans = [
    makePlan(store, "rule-storage-256", "Storage", "256GB", [{ pad: "pad-storage", value: "256GB" }, { pad: "pad-memory", value: "RAM 8GB" }]),
    makePlan(store, "rule-memory-16", "Memory", "RAM 16GB", [{ pad: "pad-memory", value: "RAM 16GB" }, { pad: "pad-storage", value: "256GB" }]),
    makePlan(store, "rule-memory-32", "Memory", "RAM 32GB", [{ pad: "pad-memory", value: "RAM 32GB" }, { pad: "pad-storage", value: "256GB" }]),
  ];

  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);
  assert.equal(result.adjustmentIds.length, 3, "three genuinely different complete configurations must each get their own Adjustment");

  const adjustmentIdByRuleId = new Map(result.decisions.map(d => [d.ruleId, d.adjustmentId]));

  // §Confirms the reported live symptom is real and reproducible, not a fabricated premise: a
  // single-attribute lookup for Storage=256GB genuinely matches conditions on ALL THREE rules (it's the
  // rule's OWN varying value for one, and the shared baseline value for the other two) — exactly the
  // "12 different AttributeBasedAdjustment records" shape reported live, just at a smaller scale. This is
  // never "fixed" by suppressing that honest answer — `resolveRuntimeAttributeAdjustment` itself is
  // unchanged and still correctly reports this as ambiguous (see its own dedicated test file); the fix is
  // using the right query (complete configuration) as the pipeline's actual gate, not this one.
  const rulesWithStorage256 = [...store.conditionsByRule.entries()].filter(([, conds]) => conds.some(c => c.pad === "pad-storage" && c.value === "256GB"));
  assert.equal(rulesWithStorage256.length, 3, "all three rules genuinely share this baseline value as a condition — the ambiguity is a real property of the data, not a bug in the old lookup");

  // §The new complete-configuration verifier correctly disambiguates every one of the three rules,
  // because it matches on each rule's OWN complete condition set, not a single shared attribute value.
  const runtimeVerification = await verifyRuntimeAdjustmentResolution(client, schema, contexts, plans, adjustmentIdByRuleId);
  assert.equal(runtimeVerification.allResolved, true, `expected all 3 to resolve; entries: ${JSON.stringify(runtimeVerification.entries)}`);
  for (const plan of plans) {
    const entry = runtimeVerification.entries.find(e => e.ruleId === plan.ruleId)!;
    assert.equal(entry.resolved, true);
    assert.equal(entry.resolvedAdjustmentId, adjustmentIdByRuleId.get(plan.ruleId));
  }
});

test("TEST — verifyRuntimeAdjustmentResolution correctly detects genuine cross-wiring (a rule's recorded Adjustment does not match what a fresh search finds)", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, STORAGE_CTX]);
  const store = buildStore();
  const client = buildMockClient(store);

  const plans = [
    makePlan(store, "rule-storage-256", "Storage", "256GB", [{ pad: "pad-storage", value: "256GB" }, { pad: "pad-memory", value: "RAM 8GB" }]),
    makePlan(store, "rule-memory-16", "Memory", "RAM 16GB", [{ pad: "pad-memory", value: "RAM 16GB" }, { pad: "pad-storage", value: "256GB" }]),
  ];
  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);

  // Deliberately swap the recorded mapping — simulates a genuine data-integrity bug (never something
  // this pipeline itself would do, but the verifier must still catch it if it ever happened).
  const realAdjustmentIdByRuleId = new Map(result.decisions.map(d => [d.ruleId, d.adjustmentId]));
  const swapped = new Map([
    ["rule-storage-256", realAdjustmentIdByRuleId.get("rule-memory-16")!],
    ["rule-memory-16", realAdjustmentIdByRuleId.get("rule-storage-256")!],
  ]);

  const runtimeVerification = await verifyRuntimeAdjustmentResolution(client, schema, contexts, plans, swapped);
  assert.equal(runtimeVerification.allResolved, false);
  for (const entry of runtimeVerification.entries) {
    assert.equal(entry.resolved, false);
    assert.match(entry.reason, /DIFFERENT AttributeBasedAdjustment/);
  }
});
