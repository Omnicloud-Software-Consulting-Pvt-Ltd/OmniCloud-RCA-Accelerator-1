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
  createOrReuseAttributeBasedAdjRules, createAttributeBasedAdjustments,
  type AttributeContext, type AttributeBasedPricingSchema, type AttributeBasedRulePlan,
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

function buildRow(attributeName: string, value: string): PricingRulePlanRow {
  return {
    attributeName, attributeLabel: attributeName, value, valueLabel: value,
    isNewValue: false, adjustmentType: "fixed", adjustment: -10,
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
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}
function makePlan(store: MockStore, ruleId: string, attributeName: string, value: string, conditions: { pad: string; value: string }[]): AttributeBasedRulePlan {
  store.conditionsByRule.set(ruleId, conditions);
  return { row: buildRow(attributeName, value), ctx: {} as AttributeContext, ruleId, reusedExisting: false, conditionIds: conditions.map((_, i) => `cond-${ruleId}-${i}`), ruleProductId: null };
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

test("TEST (control) — an existing Rule's Adjustment whose full identity (Product+Schedule+SellingModel+EffectiveFrom/To) DOES match is correctly reused", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX]);
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeBasedAdjRule WHERE")) return { totalSize: 1, done: true, records: [{ Id: "rule-1", Product2Id: "prod-1" }] };
      if (soql.includes("FROM AttributeBasedAdjustment WHERE")) {
        return {
          totalSize: 1, done: true,
          records: [{ Id: "adj-1", Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-NEW", ProductSellingModelId: null, EffectiveFrom: todayISODate(), EffectiveTo: oneYearFromTodayISODate() }],
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
  seedAdjustment(store, "adj-exists", {
    Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-OTHER",
    ProductSellingModelId: null, EffectiveFrom: todayISODate(), EffectiveTo: oneYearFromTodayISODate(),
  });
  const plans = [makePlan(store, "rule-A", "Memory", "RAM 8GB", BASELINE_CONDITIONS)];
  const client = buildMockClient(store);

  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);

  assert.equal(result.adjustmentIds.length, 0, "an exact match must be reused, never re-created");
  assert.equal(result.reusedAdjustmentIds.length, 1);
  assert.equal(result.reusedAdjustmentIds[0], "adj-exists");
});

// ── Section 5 — Salesforce's own duplicate error is a safe reconciliation opportunity, not an
// automatic fatal failure. ──
test("TEST — Salesforce's duplicate-adjustment error triggers a re-query and reuses the exact existing match", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([MEMORY_CTX, GRAPHICS_CTX]);
  const existingRecord = {
    Id: "adj-exists", Product2Id: "prod-1", PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-OTHER",
    ProductSellingModelId: null, EffectiveFrom: todayISODate(), EffectiveTo: oneYearFromTodayISODate(),
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
