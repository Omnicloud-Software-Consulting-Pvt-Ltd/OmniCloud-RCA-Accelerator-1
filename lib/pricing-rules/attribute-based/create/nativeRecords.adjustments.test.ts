/**
 * §This turn's fix — Salesforce itself started rejecting AttributeBasedAdjustment creation with:
 * "An attribute based adjustment with the selected Product, Product Selling Model, attribute
 * conditions, Price Adjustment Schedule, effective from date, and effective to date already exists."
 *
 * That error is authoritative: it PROVES Salesforce's real uniqueness key for AttributeBasedAdjustment
 * is Product + Product Selling Model + the COMPLETE condition set + Price Adjustment Schedule +
 * Effective From + Effective To — NOT AttributeBasedAdjRule. The prior turn's fix (matching by
 * Product+Schedule+RuleId) was built on an incorrect assumption about that uniqueness key, which is
 * exactly why the very next live run hit this native duplicate error: two different Rules whose full
 * condition sets are byte-identical (e.g. Memory-at-its-own-baseline and Graphics-at-its-own-baseline —
 * both reduce to the same complete 6-attribute tuple once every Rule carries a full condition set) MUST
 * share exactly one AttributeBasedAdjustment; Salesforce rejects a second create for the same complete
 * configuration regardless of which Rule asked for it.
 *
 * Fixed by:
 *   - `findExistingAttributeBasedAdjustment` — broad candidate scan by Product+Schedule only (never
 *     Rule-scoped), matching on the full canonical identity (Product, Selling Model, condition
 *     signature, Schedule, Effective From/To).
 *   - `createOrReuseAttributeBasedAdjRules`'s existing-Adjustment trust check extended to also compare
 *     Selling Model and Effective From/To (previously only Product+Schedule).
 *   - A specific catch for Salesforce's own duplicate-adjustment error in `createAttributeBasedAdjustments`:
 *     re-queries for the exact match and reuses it (never treated as fatal on its own); a genuine
 *     mismatch after that re-query IS still a hard failure.
 *   - A post-create identity read-back-and-verify before any new record is cached or trusted.
 *   - An in-memory identity cache, populated ONLY after a Salesforce-verified reuse/create, keyed by the
 *     full canonical identity — never by attribute name/value/Rule Id alone.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import { SalesforceError } from "@/lib/salesforce/client";
import {
  createOrReuseAttributeBasedAdjRules, createAttributeBasedAdjustments, adjustmentDecisionKey,
  type AttributeContext, type AttributeBasedPricingSchema, type AttributeBasedRulePlan, type AdjustmentDecisionOverride,
} from "./nativeRecords";
import type { PricingRulePlanRow } from "../types";

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}
function oneYearFromTodayISODate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}
function daysOffsetISODate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

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

function buildRow(attributeName: string, value: string, adjustment = -10, adjustmentType = "fixed"): PricingRulePlanRow {
  return {
    attributeName, attributeLabel: attributeName, value, valueLabel: value,
    isNewValue: false, adjustmentType, adjustment,
  } as unknown as PricingRulePlanRow;
}

/* ── Shared mock Salesforce store/client for `createAttributeBasedAdjustments`-level tests — models
 * enough of AttributeAdjustmentCondition + AttributeBasedAdjustment to exercise the real find/create/
 * verify/cache/duplicate-error code paths without touching a real org. ── */
interface MockStore {
  conditionsByRule: Map<string, { pad: string; value: string }[]>;
  createdAdjustments: Map<string, Record<string, unknown> & { Id: string }>;
  nextId: number;
}
function buildStore(): MockStore {
  return { conditionsByRule: new Map(), createdAdjustments: new Map(), nextId: 1 };
}
function seedAdjustment(store: MockStore, id: string, rec: Record<string, unknown>): void {
  store.createdAdjustments.set(id, { Id: id, ...rec });
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
    async updateRecord(objectName: string, id: string, fields: Record<string, unknown>) {
      if (objectName !== "AttributeBasedAdjustment") throw new Error(`unexpected updateRecord: ${objectName}`);
      const existing = store.createdAdjustments.get(id);
      if (!existing) throw new Error(`updateRecord on unknown AttributeBasedAdjustment ${id}`);
      store.createdAdjustments.set(id, { ...existing, ...fields });
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}
function makePlan(store: MockStore, ruleId: string, attributeName: string, value: string, conditions: { pad: string; value: string }[]): AttributeBasedRulePlan {
  store.conditionsByRule.set(ruleId, conditions);
  return { row: buildRow(attributeName, value), ctx: {} as AttributeContext, ruleId, reusedExisting: false, conditionIds: conditions.map((_, i) => `cond-${ruleId}-${i}`), ruleProductId: null };
}
function makePlanWithAdjustment(store: MockStore, ruleId: string, attributeName: string, value: string, adjustment: number, conditions: { pad: string; value: string }[]): AttributeBasedRulePlan {
  store.conditionsByRule.set(ruleId, conditions);
  return { row: buildRow(attributeName, value, adjustment), ctx: {} as AttributeContext, ruleId, reusedExisting: false, conditionIds: conditions.map((_, i) => `cond-${ruleId}-${i}`), ruleProductId: null };
}

const MEMORY_CTX = { name: "Memory", padId: "pad-memory", attrDefId: "ad-memory" };
const GRAPHICS_CTX = { name: "Graphics", padId: "pad-graphics", attrDefId: "ad-graphics" };
const BASELINE_CONDITIONS = [{ pad: "pad-memory", value: "RAM 8GB" }, { pad: "pad-graphics", value: "Intel Iris Xe Graphics" }];

// ── Bug B (prior turn, still protected) — an existing-by-name Rule's already-attached Adjustment must
// be verified against THIS run's full identity, not just Product+Schedule, before being trusted. ──
test("TEST — an existing Rule's Adjustment with a MISMATCHED Schedule is never blindly reused", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX]);
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeBasedAdjRule WHERE")) return { totalSize: 1, done: true, records: [{ Id: "rule-1", Product2Id: "prod-1" }] };
      if (soql.includes("FROM AttributeBasedAdjustment WHERE")) {
        return { totalSize: 1, done: true, records: [{ Id: "adj-old", Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-OLD" }] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const { plans } = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null, rules: [buildRow("Memory", "RAM 8GB")] },
    contexts, "schedule-NEW", [],
  );
  assert.equal(plans[0].reusedExisting, false, "a schedule-mismatched existing Adjustment must never be trusted as this run's Adjustment");
  assert.equal(plans[0].existingAdjustmentId, undefined);
});

test("TEST (control) — an existing Rule's Adjustment whose full identity (Product+Schedule+SellingModel+EffectiveFrom/To) AND requested value DOES match is correctly reused", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX]);
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeBasedAdjRule WHERE")) return { totalSize: 1, done: true, records: [{ Id: "rule-1", Product2Id: "prod-1" }] };
      if (soql.includes("FROM AttributeBasedAdjustment WHERE")) {
        return {
          totalSize: 1, done: true,
          // §Phase-A duplicate logical-state fix — an identity match alone is no longer sufficient; the
          // mock's stored AdjustmentType/AdjustmentValue must also agree with what `buildRow("Memory",
          // "RAM 8GB")` requests (adjustmentType "fixed" -> this schema's only AdjustmentType picklist
          // value "Amount"; adjustment defaults to -10) for this to be a genuine "DOES match" control case.
          records: [{ Id: "adj-1", Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-NEW", ProductSellingModelId: null, EffectiveFrom: todayISODate(), EffectiveTo: oneYearFromTodayISODate(), AdjustmentType: "Amount", AdjustmentValue: -10 }],
        };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const { plans } = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null, rules: [buildRow("Memory", "RAM 8GB")] },
    contexts, "schedule-NEW", [],
  );
  assert.equal(plans[0].reusedExisting, true);
  assert.equal(plans[0].existingAdjustmentId, "adj-1");
});

test("TEST — an existing Rule's Adjustment whose identity matches but whose VALUE differs from this row's request is NOT silently reused — falls through to the normal conflict-detection path instead", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX]);
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeBasedAdjRule WHERE")) return { totalSize: 1, done: true, records: [{ Id: "rule-1", Product2Id: "prod-1" }] };
      if (soql.includes("FROM AttributeBasedAdjustment WHERE")) {
        return {
          totalSize: 1, done: true,
          // Identity matches, but the stored value (-10) differs from what buildRow's default (-10) —
          // use a genuinely different value (-99) to prove the mismatch is caught.
          records: [{ Id: "adj-1", Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-NEW", ProductSellingModelId: null, EffectiveFrom: todayISODate(), EffectiveTo: oneYearFromTodayISODate(), AdjustmentType: "Amount", AdjustmentValue: -99 }],
        };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const { plans } = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null, rules: [buildRow("Memory", "RAM 8GB")] },
    contexts, "schedule-NEW", [],
  );
  assert.equal(plans[0].reusedExisting, false, "a value-mismatched existing Adjustment must never be silently reused — the normal conflict-detection path must run instead");
  assert.equal(plans[0].existingAdjustmentId, undefined);
});

// ── This turn's root-cause fix — Salesforce's own duplicate-adjustment error proved that two different
// Rules whose COMPLETE condition sets are identical must share exactly ONE AttributeBasedAdjustment. ──
test("TEST — two different Rules with an IDENTICAL complete condition set SHARE exactly one AttributeBasedAdjustment", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const store = buildStore();
  // rule-A varies Memory (Graphics sits at baseline); rule-B varies Graphics (which happens to equal
  // ITS OWN baseline value) — both rules' complete condition sets are byte-identical.
  const plans = [
    makePlan(store, "rule-A", "Memory", "RAM 8GB", BASELINE_CONDITIONS),
    makePlan(store, "rule-B", "Graphics", "Intel Iris Xe Graphics", BASELINE_CONDITIONS),
  ];
  const client = buildMockClient(store);

  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);

  assert.equal(result.adjustmentIds.length, 1, "only the FIRST rule should create a new record");
  assert.equal(result.reusedAdjustmentIds.length, 1, "the SECOND rule must reuse it rather than attempt a second create");
  assert.equal(new Set([...result.adjustmentIds, ...result.reusedAdjustmentIds]).size, 1, "both decisions must resolve to the SAME single Adjustment Id");
});

test("TEST — two different Rules with genuinely DIFFERENT complete condition sets never share one Adjustment", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const store = buildStore();
  const plans = [
    makePlan(store, "rule-A", "Memory", "RAM 8GB", BASELINE_CONDITIONS),
    makePlan(store, "rule-C", "Memory", "RAM 16GB", [{ pad: "pad-memory", value: "RAM 16GB" }, { pad: "pad-graphics", value: "Intel Iris Xe Graphics" }]),
  ];
  const client = buildMockClient(store);

  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);

  assert.equal(result.adjustmentIds.length, 2, "genuinely different configurations must each create their own Adjustment");
  assert.equal(result.reusedAdjustmentIds.length, 0);
  assert.equal(new Set(result.adjustmentIds).size, 2);
});

test("TEST — a legacy record for a DIFFERENT Product is never reused, even with identical conditions/schedule", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const store = buildStore();
  store.conditionsByRule.set("rule-OTHER-PRODUCT", BASELINE_CONDITIONS);
  seedAdjustment(store, "adj-other-product", {
    Product2Id: "prod-OTHER", PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-OTHER-PRODUCT",
    ProductSellingModelId: null, EffectiveFrom: todayISODate(), EffectiveTo: oneYearFromTodayISODate(),
  });
  const plans = [makePlan(store, "rule-A", "Memory", "RAM 8GB", BASELINE_CONDITIONS)];
  const client = buildMockClient(store);

  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);

  assert.equal(result.adjustmentIds.length, 1, "a different Product must never be reused — a new record must be created for prod-1");
  assert.equal(result.reusedAdjustmentIds.length, 0);
  assert.notEqual(result.decisions[0].adjustmentId, "adj-other-product");
});

test("TEST — a legacy record with a DIFFERENT Effective From/To is never reused, even with identical Product/Schedule/conditions", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const store = buildStore();
  store.conditionsByRule.set("rule-LEGACY", BASELINE_CONDITIONS);
  seedAdjustment(store, "adj-legacy", {
    Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-LEGACY",
    ProductSellingModelId: null, EffectiveFrom: "2020-01-01", EffectiveTo: "2021-01-01",
  });
  const plans = [makePlan(store, "rule-A", "Memory", "RAM 8GB", BASELINE_CONDITIONS)];
  const client = buildMockClient(store);

  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);

  assert.equal(result.adjustmentIds.length, 1, "a different Effective From/To is a genuinely different Salesforce configuration — must never be reused");
  assert.equal(result.reusedAdjustmentIds.length, 0);
  assert.notEqual(result.decisions[0].adjustmentId, "adj-legacy");
});

test("TEST — a pre-existing record matching EVERY identity field (including today's real Effective From/To) is correctly reused", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const store = buildStore();
  store.conditionsByRule.set("rule-OTHER", BASELINE_CONDITIONS);
  // §Phase 8 fix — the existing record's own AdjustmentType/AdjustmentValue must also be populated and
  // agree with what `buildRow`'s default row resolves to ("Amount"/-10), or the new value-comparison
  // layer correctly treats a value-less candidate as a genuine conflict, not a silent reuse.
  seedAdjustment(store, "adj-exists", {
    Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-OTHER",
    ProductSellingModelId: null, EffectiveFrom: todayISODate(), EffectiveTo: oneYearFromTodayISODate(),
    AdjustmentType: "Amount", AdjustmentValue: -10,
  });
  const plans = [makePlan(store, "rule-A", "Memory", "RAM 8GB", BASELINE_CONDITIONS)];
  const client = buildMockClient(store);

  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);

  assert.equal(result.adjustmentIds.length, 0, "an exact match must be reused, never re-created");
  assert.equal(result.reusedAdjustmentIds.length, 1);
  assert.equal(result.reusedAdjustmentIds[0], "adj-exists");
});

// ── §Step 5 fix (this turn) — `computeRuleConditionSignature`'s value normalization used to be
// `.toLowerCase()` alone, with no trim/whitespace-collapse. A pre-existing condition whose stored value
// differs from the requested one only by incidental whitespace must still be recognized as the exact
// same configuration at the PREFLIGHT stage — before ever attempting a create that Salesforce would then
// reject as a duplicate. ──
test("TEST — Step 5 fix: a pre-existing condition value differing only by whitespace/case is still an exact match", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const store = buildStore();
  store.conditionsByRule.set("rule-OTHER", [
    { pad: "pad-memory", value: "  RAM   8GB " },
    { pad: "pad-graphics", value: "INTEL IRIS XE GRAPHICS" },
  ]);
  seedAdjustment(store, "adj-exists", {
    Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-OTHER",
    ProductSellingModelId: null, EffectiveFrom: todayISODate(), EffectiveTo: oneYearFromTodayISODate(),
    AdjustmentType: "Amount", AdjustmentValue: -10,
  });
  const plans = [makePlan(store, "rule-A", "Memory", "RAM 8GB", BASELINE_CONDITIONS)];
  const client = buildMockClient(store);

  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);

  assert.equal(result.adjustmentIds.length, 0, "a whitespace/case-only difference must never be treated as a new configuration");
  assert.equal(result.reusedAdjustmentIds.length, 1);
  assert.equal(result.reusedAdjustmentIds[0], "adj-exists");
});

// ── §Step 6 fix (this turn) — the exact live bug: Salesforce rejects a create as a duplicate, but the
// strict name-resolved re-query (`findExistingAttributeBasedAdjustment`) fails to find it — here because
// the candidate Rule's own condition-signature query fails for a reason unrelated to whether it's a real
// duplicate (simulating the kind of narrow-query-shape-specific failure a live org can produce). The new
// `broadFindExistingAttributeBasedAdjustment` fallback (raw identity Id + normalized value, a simpler
// query shape) must still find and reuse the genuine match instead of reporting a false conflict. ──
test("TEST — Step 6 fix: when the narrow duplicate-reconciliation query fails, the broader raw-condition fallback still finds and reuses the genuine match", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  let createCalls = 0;
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        const m = soql.match(/AttributeBasedAdjRuleId = '([^']+)'/);
        const ruleId = m?.[1];
        if (ruleId === "rule-OTHER" && soql.includes("Product2Id")) {
          // Simulates the narrow signature query (which selects Product2Id) failing for this specific
          // candidate Rule for a reason unrelated to whether it's a real duplicate — e.g. a field-level
          // security/validation quirk on that exact field combination. The broader fallback's query never
          // selects Product2Id, so it is unaffected.
          throw new Error("simulated query failure — narrow signature shape only");
        }
        if (ruleId === "rule-A" || ruleId === "rule-OTHER") {
          return { totalSize: BASELINE_CONDITIONS.length, done: true, records: BASELINE_CONDITIONS.map((c, i) => ({ Id: `c-${ruleId}-${i}`, ProductAttributeDefinitionId: c.pad, StringValue: c.value })) };
        }
        return { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE Id = ")) return { totalSize: 0, done: true, records: [] };
      if (soql.includes("FROM AttributeBasedAdjustment")) {
        return {
          totalSize: 1, done: true,
          records: [{ Id: "adj-broad-match", Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-OTHER", ProductSellingModelId: null, EffectiveFrom: todayISODate(), EffectiveTo: oneYearFromTodayISODate(), AdjustmentType: "Amount", AdjustmentValue: -10 }],
        };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord() {
      createCalls++;
      throw new SalesforceError(
        "An attribute based adjustment with the selected Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date, and effective to date already exists. Select different field values and try again.",
        400,
        [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: "An attribute based adjustment with the selected Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date, and effective to date already exists. Select different field values and try again." }],
      );
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-A", reusedExisting: false, conditionIds: ["c0", "c1"], ruleProductId: null },
  ];

  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);

  assert.equal(createCalls, 1, "the create must still be attempted (and rejected) exactly once");
  assert.equal(result.adjustmentIds.length, 0, "must be reconciled via the broad fallback, never counted as a new create");
  assert.equal(result.reusedAdjustmentIds.length, 1);
  assert.equal(result.reusedAdjustmentIds[0], "adj-broad-match");
});

// ── Section 5 — Salesforce's own duplicate error is a safe reconciliation opportunity, not an
// automatic fatal failure. ──
test("TEST — Salesforce's duplicate-adjustment error triggers a re-query and reuses the exact existing match", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const existingRecord = {
    Id: "adj-exists", Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-OTHER",
    ProductSellingModelId: null, EffectiveFrom: todayISODate(), EffectiveTo: oneYearFromTodayISODate(),
    AdjustmentType: "Amount", AdjustmentValue: -10,
  };
  let broadScanCalls = 0;
  let createCalls = 0;
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        const m = soql.match(/AttributeBasedAdjRuleId = '([^']+)'/);
        if (m?.[1] === "rule-A" || m?.[1] === "rule-OTHER") {
          return { totalSize: BASELINE_CONDITIONS.length, done: true, records: BASELINE_CONDITIONS.map((c, i) => ({ Id: `c${i}`, ProductAttributeDefinitionId: c.pad, StringValue: c.value })) };
        }
        return { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE Id = ")) return { totalSize: 0, done: true, records: [] };
      if (soql.includes("FROM AttributeBasedAdjustment")) {
        broadScanCalls++;
        // First scan (before the create attempt) simulates a benign race — the record isn't visible
        // yet; the SECOND scan (during duplicate-error reconciliation) finds it, exactly like Salesforce
        // itself just did when it rejected the create.
        return broadScanCalls === 1 ? { totalSize: 0, done: true, records: [] } : { totalSize: 1, done: true, records: [existingRecord] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord() {
      createCalls++;
      throw new SalesforceError(
        "An attribute based adjustment with the selected Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date, and effective to date already exists. Select different field values and try again.",
        400,
        [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: "An attribute based adjustment with the selected Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date, and effective to date already exists. Select different field values and try again." }],
      );
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-A", reusedExisting: false, conditionIds: ["c0", "c1"], ruleProductId: null },
  ];

  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);

  assert.equal(createCalls, 1, "the create must have been attempted (and rejected) exactly once");
  assert.equal(result.adjustmentIds.length, 0, "the duplicate must be reconciled, never counted as a new create");
  assert.equal(result.reusedAdjustmentIds.length, 1);
  assert.equal(result.reusedAdjustmentIds[0], "adj-exists");
});

// ── §Root-cause investigation (this turn) — the live-reported symptom ("neither exact-identity re-query
// nor broader raw-condition re-query found a logically equivalent match") persisted even after Step 5/6's
// fixes. Hypothesis under test: this org's real Salesforce uniqueness check for effective dates may be an
// OVERLAP constraint (a record from an earlier run, still within its one-year active window, conflicts
// with today's freshly-computed EffectiveFrom/To even though the two don't match exactly) — never assumed
// as fact, only exercised as a genuinely new, clearly-logged fallback tier that fires ONLY after
// Salesforce's own duplicate rejection, never during the normal preflight. ──
test("TEST — Root-cause fix: an existing record whose date range OVERLAPS (but doesn't exactly match) today's request is reused via the overlap fallback, only after Salesforce's own duplicate rejection", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  // Created ~a month before today, one-year active window — still overlaps today's exact request window
  // even though EffectiveFrom/To don't match exactly. Same Product/Schedule/SellingModel/conditions/value.
  const existingRecord = {
    Id: "adj-overlap", Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-OTHER",
    ProductSellingModelId: null, EffectiveFrom: daysOffsetISODate(-30), EffectiveTo: daysOffsetISODate(395),
    AdjustmentType: "Amount", AdjustmentValue: -10,
  };
  let createCalls = 0;
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        const m = soql.match(/AttributeBasedAdjRuleId = '([^']+)'/);
        if (m?.[1] === "rule-A" || m?.[1] === "rule-OTHER") {
          return { totalSize: BASELINE_CONDITIONS.length, done: true, records: BASELINE_CONDITIONS.map((c, i) => ({ Id: `c${i}`, ProductAttributeDefinitionId: c.pad, StringValue: c.value })) };
        }
        return { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE Id = ")) return { totalSize: 0, done: true, records: [] };
      if (soql.includes("FROM AttributeBasedAdjustment")) return { totalSize: 1, done: true, records: [existingRecord] };
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord() {
      createCalls++;
      throw new SalesforceError(
        "An attribute based adjustment with the selected Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date, and effective to date already exists. Select different field values and try again.",
        400,
        [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: "An attribute based adjustment with the selected Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date, and effective to date already exists. Select different field values and try again." }],
      );
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-A", reusedExisting: false, conditionIds: ["c0", "c1"], ruleProductId: null },
  ];

  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);

  assert.equal(createCalls, 1, "the exact-date preflight and reconciliation must have genuinely failed to find it first — the create was still attempted");
  assert.equal(result.adjustmentIds.length, 0);
  assert.equal(result.reusedAdjustmentIds.length, 1);
  assert.equal(result.reusedAdjustmentIds[0], "adj-overlap");
});

// ── §Root-cause fix (live-bug reproduction) — the EXACT reported failure: a record found via the
// date-overlap reconciliation tier (its real EffectiveFrom/To predate today, which is WHY it needed that
// tier), then a USE_NEW decision on it, previously threw "Effective From/To does not match" because the
// post-update verification compared the record against TODAY's freshly-computed dates — even though
// USE_NEW's own update payload never touches EffectiveFrom/To at all. Must now succeed cleanly: the
// dates are correctly left untouched (never compared to today), and only AdjustmentType/AdjustmentValue
// are confirmed changed. ──
test("TEST — Root-cause fix (live-bug reproduction): USE_NEW on a date-overlap-reconciled record succeeds without a false 'Effective From/To does not match' error", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const staleEffectiveFrom = daysOffsetISODate(-30);
  const staleEffectiveTo = daysOffsetISODate(395);
  let current: Record<string, unknown> & { Id: string } = {
    Id: "adj-overlap", Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-OTHER",
    ProductSellingModelId: null, EffectiveFrom: staleEffectiveFrom, EffectiveTo: staleEffectiveTo,
    AdjustmentType: "Amount", AdjustmentValue: -10,
  };
  let updateCalls = 0;
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        const m = soql.match(/AttributeBasedAdjRuleId = '([^']+)'/);
        if (m?.[1] === "rule-A" || m?.[1] === "rule-OTHER") {
          return { totalSize: BASELINE_CONDITIONS.length, done: true, records: BASELINE_CONDITIONS.map((c, i) => ({ Id: `c${i}`, ProductAttributeDefinitionId: c.pad, StringValue: c.value })) };
        }
        return { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE Id = ")) {
        const m = soql.match(/WHERE Id = '([^']+)'/);
        return m?.[1] === current.Id ? { totalSize: 1, done: true, records: [current] } : { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment")) return { totalSize: 1, done: true, records: [current] };
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord() {
      throw new SalesforceError(
        "An attribute based adjustment with the selected Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date, and effective to date already exists. Select different field values and try again.",
        400,
        [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: "An attribute based adjustment with the selected Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date, and effective to date already exists. Select different field values and try again." }],
      );
    },
    async updateRecord(_objectName: string, id: string, fields: Record<string, unknown>) {
      updateCalls++;
      assert.equal(id, "adj-overlap");
      assert.deepEqual(Object.keys(fields).sort(), ["AdjustmentType", "AdjustmentValue"], "USE_NEW must send ONLY AdjustmentType/AdjustmentValue — never EffectiveFrom/EffectiveTo");
      current = { ...current, ...fields };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const decisionOverrides = new Map<string, AdjustmentDecisionOverride>([[adjustmentDecisionKey("Memory", "RAM 8GB"), "USE_NEW"]]);
  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB", -15), ctx: contexts.get("Memory")!, ruleId: "rule-A", reusedExisting: false, conditionIds: ["c0", "c1"], ruleProductId: null },
  ];

  const result = await createAttributeBasedAdjustments(
    client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, [], undefined, decisionOverrides,
  );

  assert.equal(updateCalls, 1);
  assert.equal(result.pendingConflicts.length, 0, "must not still be reported as a conflict once USE_NEW is decided");
  assert.equal(result.updatedAdjustmentIds.length, 1);
  assert.equal(result.updatedAdjustmentIds[0], "adj-overlap");
  assert.equal(current.AdjustmentValue, -15, "the value must actually have changed");
  assert.equal(current.EffectiveFrom, staleEffectiveFrom, "EffectiveFrom must remain exactly what it was — never compared against, or overwritten to, today's date");
  assert.equal(current.EffectiveTo, staleEffectiveTo, "EffectiveTo must remain exactly what it was — never compared against, or overwritten to, today's date");
});

test("TEST — Root-cause fix: an existing record whose date range does NOT overlap at all remains a genuine conflict, even with identical Product/Schedule/conditions", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  // Fully expired over a year ago — no possible overlap with today's request window. Must never be
  // guessed as a match just because everything else agrees.
  const existingRecord = {
    Id: "adj-expired", Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-OTHER",
    ProductSellingModelId: null, EffectiveFrom: daysOffsetISODate(-800), EffectiveTo: daysOffsetISODate(-400),
    AdjustmentType: "Amount", AdjustmentValue: -10,
  };
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        const m = soql.match(/AttributeBasedAdjRuleId = '([^']+)'/);
        if (m?.[1] === "rule-A" || m?.[1] === "rule-OTHER") {
          return { totalSize: BASELINE_CONDITIONS.length, done: true, records: BASELINE_CONDITIONS.map((c, i) => ({ Id: `c${i}`, ProductAttributeDefinitionId: c.pad, StringValue: c.value })) };
        }
        return { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE Id = ")) return { totalSize: 0, done: true, records: [] };
      if (soql.includes("FROM AttributeBasedAdjustment")) return { totalSize: 1, done: true, records: [existingRecord] };
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord() {
      throw new SalesforceError(
        "An attribute based adjustment with the selected Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date, and effective to date already exists. Select different field values and try again.",
        400,
        [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: "An attribute based adjustment with the selected Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date, and effective to date already exists. Select different field values and try again." }],
      );
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-A", reusedExisting: false, conditionIds: ["c0", "c1"], ruleProductId: null },
  ];

  await assert.rejects(
    () => createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []),
    (err: unknown) => {
      assert.match((err as Error).message, /genuine configuration conflict/i);
      // §Step 1/4-8 fix — the genuine-conflict error must carry the raw Salesforce evidence needed to
      // determine the TRUE cause on the next live run, never just a bare "no match" statement.
      assert.match((err as Error).message, /RAW SALESFORCE DIAGNOSTICS/);
      assert.match((err as Error).message, /Zero-filter sanity query/);
      assert.match((err as Error).message, /Product-ONLY re-scan/);
      assert.match((err as Error).message, /adj-expired/, "the raw candidate's own Id must appear in the dump");
      return true;
    },
  );
});

test("TEST — Salesforce's duplicate-adjustment error with a genuinely DIFFERENT existing configuration remains a hard failure", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  // The "existing" record Salesforce is complaining about actually has DIFFERENT conditions (Memory=RAM
  // 16GB, not RAM 8GB) — a genuine conflict, never safely reusable.
  const differentRecord = {
    Id: "adj-different", Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-OTHER",
    ProductSellingModelId: null, EffectiveFrom: todayISODate(), EffectiveTo: oneYearFromTodayISODate(),
  };
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        const m = soql.match(/AttributeBasedAdjRuleId = '([^']+)'/);
        if (m?.[1] === "rule-A") return { totalSize: BASELINE_CONDITIONS.length, done: true, records: BASELINE_CONDITIONS.map((c, i) => ({ Id: `c${i}`, ProductAttributeDefinitionId: c.pad, StringValue: c.value })) };
        if (m?.[1] === "rule-OTHER") {
          const differentConditions = [{ pad: "pad-memory", value: "RAM 16GB" }, { pad: "pad-graphics", value: "Intel Iris Xe Graphics" }];
          return { totalSize: differentConditions.length, done: true, records: differentConditions.map((c, i) => ({ Id: `d${i}`, ProductAttributeDefinitionId: c.pad, StringValue: c.value })) };
        }
        return { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE Id = ")) return { totalSize: 0, done: true, records: [] };
      if (soql.includes("FROM AttributeBasedAdjustment")) return { totalSize: 1, done: true, records: [differentRecord] };
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord() {
      throw new SalesforceError(
        "An attribute based adjustment with the selected Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date, and effective to date already exists. Select different field values and try again.",
        400,
        [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: "An attribute based adjustment with the selected Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date, and effective to date already exists. Select different field values and try again." }],
      );
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-A", reusedExisting: false, conditionIds: ["c0", "c1"], ruleProductId: null },
  ];

  await assert.rejects(
    () => createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []),
    /genuine configuration conflict/i,
  );
});

// ── Idempotency (Section 22's live acceptance test, exercised at the unit level) — running the same
// requested configuration through this function TWICE against the same persisted Salesforce state
// (simulated by sharing `store`/`client` across two separate calls) must never create a duplicate. ──
test("TEST — re-processing the same configuration in a second call reuses the first call's Adjustment, never duplicating it", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const store = buildStore();
  const client = buildMockClient(store);

  const firstPlans = [makePlan(store, "rule-A", "Memory", "RAM 8GB", BASELINE_CONDITIONS)];
  const firstResult = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", firstPlans, []);
  assert.equal(firstResult.adjustmentIds.length, 1);

  // A second, independent call (e.g. the user re-running the same prompt) — same exact configuration,
  // a DIFFERENT Rule Id (as would happen if the Rule itself were also re-resolved), same conditions.
  const secondPlans = [makePlan(store, "rule-A2", "Memory", "RAM 8GB", BASELINE_CONDITIONS)];
  const secondResult = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", secondPlans, []);

  assert.equal(secondResult.adjustmentIds.length, 0, "the second run must reuse, never create a duplicate");
  assert.equal(secondResult.reusedAdjustmentIds.length, 1);
  assert.equal(secondResult.reusedAdjustmentIds[0], firstResult.adjustmentIds[0]);
  assert.equal(store.createdAdjustments.size, 1, "exactly one AttributeBasedAdjustment record must exist in Salesforce after both runs");
});

// ── §Phase 8/9/10 fix (this turn) — an identity match is NOT the same thing as a value match. Case B
// of the fix spec: SAME condition identity, DIFFERENT requested adjustment value must never be silently
// reused (discards the user's real request) or silently overwritten (discards Salesforce's existing
// configuration) — it's a structured, reported conflict requiring an explicit decision. ──
test("TEST — Phase 8 Case B: same identity, different adjustment value -> reported as a conflict, never auto-reused or auto-overwritten", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const store = buildStore();
  const client = buildMockClient(store);

  const firstPlans = [makePlanWithAdjustment(store, "rule-A", "Memory", "RAM 8GB", -10, BASELINE_CONDITIONS)];
  const firstResult = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", firstPlans, []);
  assert.equal(firstResult.adjustmentIds.length, 1);
  const existingId = firstResult.adjustmentIds[0];

  // Same exact condition identity (Memory=RAM 8GB, Graphics at baseline) — a DIFFERENT requested value.
  const secondPlans = [makePlanWithAdjustment(store, "rule-A2", "Memory", "RAM 8GB", -15, BASELINE_CONDITIONS)];
  const secondResult = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", secondPlans, []);

  assert.equal(secondResult.adjustmentIds.length, 0, "never auto-created a duplicate for the same identity");
  assert.equal(secondResult.reusedAdjustmentIds.length, 0, "never silently reused the OLD value");
  assert.equal(secondResult.updatedAdjustmentIds.length, 0, "never silently overwrote with the NEW value");
  assert.equal(secondResult.pendingConflicts.length, 1);
  const conflict = secondResult.pendingConflicts[0];
  assert.equal(conflict.existingAdjustmentId, existingId);
  assert.equal(conflict.existingAdjustmentValue, -10);
  assert.equal(conflict.requestedAdjustmentValue, -15);
  assert.equal(conflict.attributeName, "Memory");
  assert.equal(conflict.value, "RAM 8GB");
  assert.equal(conflict.valueLabel, "RAM 8GB");
  assert.equal(adjustmentDecisionKey(conflict.attributeName, conflict.value), "Memory::RAM 8GB", "the conflict's own value field must match the exact key a resubmit needs to use");
  // The store must be completely untouched — no create, no update.
  assert.equal(store.createdAdjustments.get(existingId)?.AdjustmentValue, -10);
  assert.equal(store.createdAdjustments.size, 1);
});

test("TEST — Phase 9: USE_EXISTING decision keeps the old value, never writes to Salesforce", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const store = buildStore();
  const client = buildMockClient(store);

  const firstPlans = [makePlanWithAdjustment(store, "rule-A", "Memory", "RAM 8GB", -10, BASELINE_CONDITIONS)];
  const firstResult = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", firstPlans, []);
  const existingId = firstResult.adjustmentIds[0];

  const decisionOverrides = new Map<string, AdjustmentDecisionOverride>([[adjustmentDecisionKey("Memory", "RAM 8GB"), "USE_EXISTING"]]);
  const secondPlans = [makePlanWithAdjustment(store, "rule-A2", "Memory", "RAM 8GB", -15, BASELINE_CONDITIONS)];
  const secondResult = await createAttributeBasedAdjustments(
    client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", secondPlans, [], undefined, decisionOverrides,
  );

  assert.equal(secondResult.pendingConflicts.length, 0);
  assert.equal(secondResult.reusedAdjustmentIds.length, 1);
  assert.equal(secondResult.reusedAdjustmentIds[0], existingId);
  assert.equal(secondResult.updatedAdjustmentIds.length, 0);
  assert.equal(store.createdAdjustments.get(existingId)?.AdjustmentValue, -10, "USE_EXISTING must never change the stored value");
});

test("TEST — Phase 9: USE_NEW decision updates the existing Salesforce record in place, never creates a duplicate", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const store = buildStore();
  const client = buildMockClient(store);

  const firstPlans = [makePlanWithAdjustment(store, "rule-A", "Memory", "RAM 8GB", -10, BASELINE_CONDITIONS)];
  const firstResult = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", firstPlans, []);
  const existingId = firstResult.adjustmentIds[0];

  const decisionOverrides = new Map<string, AdjustmentDecisionOverride>([[adjustmentDecisionKey("Memory", "RAM 8GB"), "USE_NEW"]]);
  const secondPlans = [makePlanWithAdjustment(store, "rule-A2", "Memory", "RAM 8GB", -15, BASELINE_CONDITIONS)];
  const secondResult = await createAttributeBasedAdjustments(
    client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", secondPlans, [], undefined, decisionOverrides,
  );

  assert.equal(secondResult.pendingConflicts.length, 0);
  assert.equal(secondResult.reusedAdjustmentIds.length, 0);
  assert.equal(secondResult.adjustmentIds.length, 0, "USE_NEW must update, never create a second record");
  assert.equal(secondResult.updatedAdjustmentIds.length, 1);
  assert.equal(secondResult.updatedAdjustmentIds[0], existingId);
  assert.equal(store.createdAdjustments.size, 1, "still exactly one AttributeBasedAdjustment record — updated in place, not duplicated");
  assert.equal(store.createdAdjustments.get(existingId)?.AdjustmentValue, -15, "the existing record's value must now reflect the new decision");
});

// ── §Step 9 fix (root-cause investigation) — `createable` and `updateable` are distinct Salesforce
// Describe flags; USE_NEW must never blindly attempt an update just because the same field is
// createable — verified explicitly first. ──
test("TEST — Step 9: USE_NEW refuses to attempt an update when AdjustmentValue is Describe-reported as NOT updateable", async () => {
  const schema = buildFullSchema();
  schema.abaValueField = { ...schema.abaValueField!, updateable: false };
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const store = buildStore();
  const client = buildMockClient(store);

  const firstPlans = [makePlanWithAdjustment(store, "rule-A", "Memory", "RAM 8GB", -10, BASELINE_CONDITIONS)];
  const firstResult = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", firstPlans, []);
  const existingId = firstResult.adjustmentIds[0];

  const decisionOverrides = new Map<string, AdjustmentDecisionOverride>([[adjustmentDecisionKey("Memory", "RAM 8GB"), "USE_NEW"]]);
  const secondPlans = [makePlanWithAdjustment(store, "rule-A2", "Memory", "RAM 8GB", -15, BASELINE_CONDITIONS)];

  await assert.rejects(
    () => createAttributeBasedAdjustments(
      client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", secondPlans, [], undefined, decisionOverrides,
    ),
    /not updateable/i,
  );
  assert.equal(store.createdAdjustments.get(existingId)?.AdjustmentValue, -10, "must never have attempted the write");
});

test("TEST — Phase 8: identical requested value never triggers a conflict, even across two separate calls (idempotency preserved)", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const store = buildStore();
  const client = buildMockClient(store);

  const firstPlans = [makePlanWithAdjustment(store, "rule-A", "Memory", "RAM 8GB", -10, BASELINE_CONDITIONS)];
  await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", firstPlans, []);

  const secondPlans = [makePlanWithAdjustment(store, "rule-A2", "Memory", "RAM 8GB", -10, BASELINE_CONDITIONS)];
  const secondResult = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", secondPlans, []);

  assert.equal(secondResult.pendingConflicts.length, 0, "the SAME requested value must never be flagged as a conflict");
  assert.equal(secondResult.reusedAdjustmentIds.length, 1);
});
