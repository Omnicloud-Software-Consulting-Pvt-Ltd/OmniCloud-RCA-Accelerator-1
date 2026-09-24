/**
 * §Phase-A duplicate logical-state fix — a real live failure (execution ABP-20260922-111805-40F0)
 * confirmed the exact root cause: Phase-A Rule creation happened entirely by Name, before any Condition
 * existed to content-match against, so two DIFFERENT rows that both happen to sit at every OTHER
 * price-impacting attribute's baseline (e.g. "Display=1080p" and "Screen Size=24 Inch" on a 2-attribute
 * Monitor, where 1080p and 24 Inch are each other's mutual baseline) collapse onto the IDENTICAL complete
 * condition state — yet each got its own separate Rule: one holding the real Adjustment, the other a
 * permanently Adjustment-less "shadow" Rule (verified live: `Screen_Size_24_Inch_Rule`, 2/2 conditions,
 * 0 Adjustments).
 *
 * These tests exercise `createOrReuseAttributeBasedAdjRules` directly against a mocked Salesforce client,
 * covering every scenario the forensic investigation and fix spec called for. Domain names are
 * deliberately varied across tests (Display/Screen Size for the Monitor regression shape, and two
 * entirely different domains elsewhere) to prove nothing is hardcoded.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import {
  createOrReuseAttributeBasedAdjRules, verifyAdjustmentRecordsReadBack,
  type AttributeBasedPricingSchema, type AttributeContext, type NativeCreationResult,
} from "./nativeRecords";
import type { PricingRulePlanRow } from "../types";

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

function buildSchema(): AttributeBasedPricingSchema {
  const ruleDescribe = { name: "AttributeBasedAdjRule", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("Name", "string"), field("Product2Id", "reference"), field("IsActive", "boolean")] } as unknown as DescribeResult;
  const conditionDescribe = { name: "AttributeAdjustmentCondition", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("AttributeBasedAdjRuleId", "reference"), field("ProductAttributeDefinitionId", "reference"), field("Product2Id", "reference"), field("StringValue", "string"), field("Operator", "picklist", { picklistValues: [{ value: "Equal", label: "Equal", active: true }] })] } as unknown as DescribeResult;
  const abaDescribe = { name: "AttributeBasedAdjustment", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("Product2Id", "reference"), field("ProductSellingModelId", "reference"), field("PriceAdjustmentScheduleId", "reference"), field("AttributeBasedAdjRuleId", "reference"), field("EffectiveFrom", "date"), field("EffectiveTo", "date"), field("AdjustmentType", "picklist", { picklistValues: [{ value: "Amount", label: "Amount", active: true }, { value: "Percentage", label: "Percentage", active: true }, { value: "Override", label: "Override", active: true }] }), field("AdjustmentValue", "double")] } as unknown as DescribeResult;
  const refField = (f: DescribeField) => ({ field: f, candidates: [{ field: f, score: 1 }] });
  return {
    ruleDescribe, conditionDescribe, abaDescribe,
    ruleProductField: refField(ruleDescribe.fields[2]), ruleScheduleField: { field: null, candidates: [] }, ruleActiveField: ruleDescribe.fields[3], ruleEffFromField: null, ruleEffToField: null,
    conditionRuleField: refField(conditionDescribe.fields[1]), conditionPadField: refField(conditionDescribe.fields[2]), conditionAttrDefField: { field: null, candidates: [] },
    conditionProductField: refField(conditionDescribe.fields[3]), conditionOperatorField: conditionDescribe.fields[5],
    abaProductField: refField(abaDescribe.fields[1]), abaSellingModelField: refField(abaDescribe.fields[2]), abaRuleField: refField(abaDescribe.fields[4]),
    abaScheduleField: refField(abaDescribe.fields[3]), abaConditionField: null, abaTypeField: abaDescribe.fields[7], abaValueField: abaDescribe.fields[8],
    abaEffFromField: abaDescribe.fields[5], abaEffToField: abaDescribe.fields[6],
  } as unknown as AttributeBasedPricingSchema;
}

function buildContexts(attrs: { name: string; padId: string }[]): Map<string, AttributeContext> {
  const contexts = new Map<string, AttributeContext>();
  for (const a of attrs) {
    contexts.set(a.name, {
      attributeDefinitionId: `ad-${a.padId}`, dataType: "Picklist", dataTypeSource: "AttributeDefinition.DataType",
      productAttributeDefinitionId: a.padId, isPriceImpacting: true, productClassificationAttrId: null, source: "DIRECT",
    });
  }
  return contexts;
}

function row(attributeName: string, attributeLabel: string, value: string, adjustmentType: PricingRulePlanRow["adjustmentType"], adjustment: number): PricingRulePlanRow {
  return { attributeName, attributeLabel, value, valueLabel: value, adjustmentType, adjustment, stated: true, isNewValue: false };
}

interface ExistingRule { name: string; conditions: { padId: string; value: string }[] }
interface ExistingAdjustment { id: string; type: string; value: number; scheduleId: string; sellingModelId: string | null; effectiveFrom: string; effectiveTo: string }

/** A generic mock covering every SOQL shape `createOrReuseAttributeBasedAdjRules` (plus the canonical
 * signature machinery it now calls: `resolveBaseProductConfiguration`, `discoverExistingRuleContentIdentities`)
 * needs — parametrized entirely by data, never by product/attribute name, so the SAME mock builder serves
 * every test below regardless of domain. */
function buildMockClient(opts: {
  productId: string;
  defaultValueByPad: Record<string, string>;
  existingRules?: Record<string, ExistingRule>;
  existingAdjustments?: Record<string, ExistingAdjustment>;
  onCreateRule?: (payload: Record<string, unknown>) => void;
  onCreateCondition?: (payload: Record<string, unknown>) => void;
}) {
  const existingRules = opts.existingRules ?? {};
  const existingAdjustments = opts.existingAdjustments ?? {};
  let nextRuleId = 1;
  const client = {
    async describeObject(name: string) {
      if (name === "ProductAttributeDefinition") {
        return { name, label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("DefaultValue", "string"), field("ProductClassificationAttributeId", "reference")] } as unknown as DescribeResult;
      }
      throw new Error(`unexpected describeObject: ${name}`);
    },
    async query(soql: string) {
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id IN")) {
        return { records: Object.entries(opts.defaultValueByPad).map(([id, v]) => ({ Id: id, DefaultValue: v })) };
      }
      // discoverExistingRuleContentIdentities — ONE bulk, product-scoped condition query (never per-rule).
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE Product2Id =")) {
        const recs: Record<string, unknown>[] = [];
        for (const [ruleId, r] of Object.entries(existingRules)) {
          r.conditions.forEach((c, i) => recs.push({ Id: `existing-cond-${ruleId}-${i}`, AttributeBasedAdjRuleId: ruleId, ProductAttributeDefinitionId: c.padId, StringValue: c.value }));
        }
        return { records: recs };
      }
      // discoverExistingRuleContentIdentities' own Name lookup for the Rules it found conditions for.
      if (soql.includes("FROM AttributeBasedAdjRule WHERE Id IN")) {
        const ids = [...soql.matchAll(/'([^']+)'/g)].map(m => m[1]);
        return { records: ids.filter(id => existingRules[id]).map(id => ({ Id: id, Name: existingRules[id].name })) };
      }
      // resolveProductConsistentRuleCandidate — Name-based lookup (the pre-existing fallback path).
      if (soql.includes("FROM AttributeBasedAdjRule WHERE Name =")) {
        const m = /Name = '([^']+)'/.exec(soql);
        const found = Object.entries(existingRules).find(([, r]) => r.name === m?.[1]);
        return { records: found ? [{ Id: found[0], Product2Id: opts.productId }] : [] };
      }
      // resolveProductConsistentRuleCandidate's own condition-product-consistency check for candidates.
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE AttributeBasedAdjRuleId IN")) {
        return { records: [] };
      }
      // resolveExistingAdjustmentForRule — one Rule's own Adjustment, by ruleId.
      const abaByRule = /FROM AttributeBasedAdjustment WHERE \S+ = '([^']+)' LIMIT 1/.exec(soql);
      if (abaByRule) {
        const adj = existingAdjustments[abaByRule[1]];
        return {
          records: adj ? [{ Id: adj.id, Product2Id: opts.productId, PriceAdjustmentScheduleId: adj.scheduleId, ProductSellingModelId: adj.sellingModelId, EffectiveFrom: adj.effectiveFrom, EffectiveTo: adj.effectiveTo, AdjustmentType: adj.type, AdjustmentValue: adj.value }] : [],
        };
      }
      // guardedCreate's own read-back verification for any newly-created record.
      const readBack = /WHERE Id = '(new-[^']+)'/.exec(soql);
      if (readBack) return { records: [{ Id: readBack[1] }] };
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      if (objectName === "AttributeBasedAdjRule") {
        opts.onCreateRule?.(payload);
        return { id: `new-rule-${nextRuleId++}` };
      }
      if (objectName === "AttributeAdjustmentCondition") {
        opts.onCreateCondition?.(payload);
        return { id: `new-cond-${nextRuleId++}` };
      }
      throw new Error(`unexpected createRecord: ${objectName}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
  return client;
}

const EFFECTIVE_FROM = new Date().toISOString().slice(0, 10);
const EFFECTIVE_TO = (() => { const d = new Date(); d.setFullYear(d.getFullYear() + 1); return d.toISOString().slice(0, 10); })();

test("TEST 1/2 — two Phase-A rows in the SAME run produce an identical complete signature: only ONE Rule is created, never a second 'shadow' Rule", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const client = buildMockClient({
    productId: "prod-1",
    defaultValueByPad: { "pad-display": "1080p Built-in Display", "pad-screensize": "24 Inch" },
    onCreateRule: p => createdRules.push(p),
  });
  const schema = buildSchema();
  const contexts = buildContexts([{ name: "Display", padId: "pad-display" }, { name: "Screen Size", padId: "pad-screensize" }]);
  const rules: PricingRulePlanRow[] = [
    row("Display", "Display", "1080p Built-in Display", "fixed", 0),
    row("Screen Size", "Screen Size", "24 Inch", "fixed", 0),
  ];

  const result = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-1", name: "Monitor" }, sellingModelId: "psm-1", rules }, contexts, "sched-1", [],
  );

  assert.equal(createdRules.length, 1, "only the FIRST row's identical complete state should create a new Rule");
  assert.equal(result.plans[0].ruleId, result.plans[1].ruleId, "both rows must resolve to the SAME Rule Id — never two separate Rules for one logical state");
});

test("TEST 3/4 — an EXISTING Salesforce Rule already has this row's complete signature (from a prior run), with a MATCHING requested adjustment: the existing Rule/Adjustment is reused, never duplicated", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const client = buildMockClient({
    productId: "prod-1",
    defaultValueByPad: { "pad-display": "1080p Built-in Display", "pad-screensize": "24 Inch" },
    existingRules: { "existing-rule-1": { name: "Display_1080p_Built_in_Display_Rule", conditions: [{ padId: "pad-display", value: "1080p Built-in Display" }, { padId: "pad-screensize", value: "24 Inch" }] } },
    existingAdjustments: { "existing-rule-1": { id: "existing-adj-1", type: "Amount", value: 0, scheduleId: "sched-1", sellingModelId: "psm-1", effectiveFrom: EFFECTIVE_FROM, effectiveTo: EFFECTIVE_TO } },
    onCreateRule: p => createdRules.push(p),
  });
  const schema = buildSchema();
  const contexts = buildContexts([{ name: "Display", padId: "pad-display" }, { name: "Screen Size", padId: "pad-screensize" }]);
  // "Screen Size = 24 Inch" (its own baseline) resolves to the SAME complete state as the already-existing
  // "Display_1080p_Built_in_Display_Rule" — found by CONTENT, never by the (completely different) Name.
  const rules: PricingRulePlanRow[] = [row("Screen Size", "Screen Size", "24 Inch", "fixed", 0)];

  const result = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-1", name: "Monitor" }, sellingModelId: "psm-1", rules }, contexts, "sched-1", [],
  );

  assert.equal(createdRules.length, 0, "must never create a duplicate Rule when the complete state already exists in Salesforce");
  assert.equal(result.plans[0].ruleId, "existing-rule-1");
  assert.equal(result.plans[0].reusedExisting, true, "identity AND value both match — safely reused");
  assert.equal(result.plans[0].existingAdjustmentId, "existing-adj-1");
});

test("TEST 5 — same signature as an EXISTING Rule, but a CONFLICTING requested adjustment: never silently reused — falls through to the normal conflict-detection path", async () => {
  const client = buildMockClient({
    productId: "prod-1",
    defaultValueByPad: { "pad-display": "1080p Built-in Display", "pad-screensize": "24 Inch" },
    existingRules: { "existing-rule-1": { name: "Display_1080p_Built_in_Display_Rule", conditions: [{ padId: "pad-display", value: "1080p Built-in Display" }, { padId: "pad-screensize", value: "24 Inch" }] } },
    existingAdjustments: { "existing-rule-1": { id: "existing-adj-1", type: "Amount", value: 30, scheduleId: "sched-1", sellingModelId: "psm-1", effectiveFrom: EFFECTIVE_FROM, effectiveTo: EFFECTIVE_TO } },
  });
  const schema = buildSchema();
  const contexts = buildContexts([{ name: "Display", padId: "pad-display" }, { name: "Screen Size", padId: "pad-screensize" }]);
  // Requests $10 for the SAME complete state the existing Rule already has at $30.
  const rules: PricingRulePlanRow[] = [row("Screen Size", "Screen Size", "24 Inch", "fixed", 10)];

  const result = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-1", name: "Monitor" }, sellingModelId: "psm-1", rules }, contexts, "sched-1", [],
  );

  assert.equal(result.plans[0].ruleId, "existing-rule-1", "the Rule identity itself still correctly resolves by content");
  assert.equal(result.plans[0].reusedExisting, false, "a VALUE conflict must never be silently resolved as a reuse");
  assert.equal(result.plans[0].existingAdjustmentId, undefined, "no Adjustment is trusted — the real conflict-detection machinery in createAttributeBasedAdjustments must run and report this, never guessed here");
});

test("TEST 6 — a baseline attribute value with its OWN legitimate, non-zero pricing is never automatically discarded merely because it equals the baseline", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const client = buildMockClient({
    productId: "prod-1",
    defaultValueByPad: { "pad-display": "1080p Built-in Display", "pad-screensize": "24 Inch" },
    onCreateRule: p => createdRules.push(p),
  });
  const schema = buildSchema();
  const contexts = buildContexts([{ name: "Display", padId: "pad-display" }, { name: "Screen Size", padId: "pad-screensize" }]);
  // "Screen Size = 24 Inch" (the baseline value) is explicitly priced at $30 — a real, standalone request,
  // not silently skipped just because 24 Inch happens to be the baseline.
  const rules: PricingRulePlanRow[] = [row("Screen Size", "Screen Size", "24 Inch", "fixed", 30)];

  const result = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-1", name: "Monitor" }, sellingModelId: "psm-1", rules }, contexts, "sched-1", [],
  );

  assert.equal(createdRules.length, 1, "a baseline value's own legitimate pricing request must still create its Rule — never silently dropped");
  assert.equal(result.plans.length, 1);
  assert.ok(result.plans[0].ruleId, "a real Rule Id must be resolved for this legitimate baseline pricing request");
});

test("TEST 7/8 — two DIFFERENT attribute/value pairs whose Rule NAMES differ but whose complete CONTENT signature is identical are deduplicated to ONE logical Rule (never matched by Name)", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const client = buildMockClient({
    productId: "prod-1",
    defaultValueByPad: { "pad-color": "Silver", "pad-material": "Aluminum" },
    onCreateRule: p => createdRules.push(p),
  });
  const schema = buildSchema();
  const contexts = buildContexts([{ name: "Color", padId: "pad-color" }, { name: "Material", padId: "pad-material" }]);
  // "Color=Silver" (Material implicitly pinned to its baseline "Aluminum") and "Material=Aluminum" (Color
  // implicitly pinned to its baseline "Silver") are DIFFERENT rows with DIFFERENT sanitized Rule names
  // ("Color_Silver_Rule" vs "Material_Aluminum_Rule"), yet resolve to the byte-identical complete state.
  const rules: PricingRulePlanRow[] = [
    row("Color", "Color", "Silver", "fixed", 0),
    row("Material", "Material", "Aluminum", "fixed", 0),
  ];

  const result = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-1", name: "Widget" }, sellingModelId: null, rules }, contexts, "sched-1", [],
  );

  assert.equal(createdRules.length, 1, "different Rule Names must never prevent deduplication by content");
  assert.equal(result.plans[0].ruleId, result.plans[1].ruleId);
});

test("TEST 9 — genuinely DIFFERENT complete signatures create genuinely SEPARATE Rules (the fix must not over-merge)", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const client = buildMockClient({
    productId: "prod-1",
    defaultValueByPad: { "pad-color": "Silver", "pad-material": "Aluminum" },
    onCreateRule: p => createdRules.push(p),
  });
  const schema = buildSchema();
  const contexts = buildContexts([{ name: "Color", padId: "pad-color" }, { name: "Material", padId: "pad-material" }]);
  // "Color=Silver" (Material at baseline) vs "Color=Gold" (Material at baseline) — two DIFFERENT complete
  // states, both varying the SAME attribute but to different values.
  const rules: PricingRulePlanRow[] = [
    row("Color", "Color", "Silver", "fixed", 0),
    row("Color", "Color", "Gold", "fixed", 15),
  ];

  const result = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-1", name: "Widget" }, sellingModelId: null, rules }, contexts, "sched-1", [],
  );

  assert.equal(createdRules.length, 2, "genuinely different complete states must each get their own Rule");
  assert.notEqual(result.plans[0].ruleId, result.plans[1].ruleId);
});

test("TEST 13 — Monitor regression shape: Display (3 values) + Screen Size (4 values, one of which — 24 Inch — is Screen Size's own baseline) produces exactly 6 distinct Rules, never 7", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const client = buildMockClient({
    productId: "prod-monitor",
    defaultValueByPad: { "pad-display": "1080p Built-in Display", "pad-screensize": "24 Inch" },
    onCreateRule: p => createdRules.push(p),
  });
  const schema = buildSchema();
  const contexts = buildContexts([{ name: "Display", padId: "pad-display" }, { name: "Screen Size", padId: "pad-screensize" }]);
  const rules: PricingRulePlanRow[] = [
    row("Display", "Display", "1080p Built-in Display", "fixed", 0),
    row("Display", "Display", "2k Built-in Display", "fixed", 20),
    row("Display", "Display", "4k Built-in Display", "fixed", 50),
    row("Screen Size", "Screen Size", "13 Inch", "fixed", 0),
    row("Screen Size", "Screen Size", "15 Inch", "fixed", 10),
    row("Screen Size", "Screen Size", "24 Inch", "fixed", 0),
    row("Screen Size", "Screen Size", "27 Inch", "fixed", 40),
  ];

  const result = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-monitor", name: "Monitor" }, sellingModelId: "psm-1", rules }, contexts, "sched-1", [],
  );

  // "Display=1080p" and "Screen Size=24 Inch" both resolve to the all-baseline state — exactly the
  // confirmed live bug (Screen_Size_24_Inch_Rule, 2/2 conditions, 0 Adjustments). 7 rows -> 6 distinct Rules.
  const distinctRuleIds = new Set(result.plans.map(p => p.ruleId));
  assert.equal(distinctRuleIds.size, 6, "7 rows collapse to exactly 6 distinct Rules — the 1080p/24-Inch pair must share one Rule");
  assert.equal(createdRules.length, 6, "only 6 Rules should ever be created, never 7 (never a redundant 'shadow' Rule)");
  const displayBaselineRuleId = result.plans[0].ruleId;
  const screenSizeBaselineRuleId = result.plans[5].ruleId;
  assert.equal(displayBaselineRuleId, screenSizeBaselineRuleId, "Display=1080p and ScreenSize=24Inch must resolve to the SAME Rule");
});

test("TEST 14 — Laptop-shaped regression: 4 price-impacting attributes, no baseline collisions requested, produces one Rule per row exactly as before (this fix changes nothing here)", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const client = buildMockClient({
    productId: "prod-laptop",
    defaultValueByPad: { "pad-ram": "8GB", "pad-storage": "256GB", "pad-processor": "i5", "pad-display": "FHD" },
    onCreateRule: p => createdRules.push(p),
  });
  const schema = buildSchema();
  const contexts = buildContexts([
    { name: "RAM", padId: "pad-ram" }, { name: "Storage", padId: "pad-storage" },
    { name: "Processor", padId: "pad-processor" }, { name: "Display", padId: "pad-display" },
  ]);
  // Every row varies a DIFFERENT attribute to a NON-baseline value — no two rows can ever collapse onto
  // the same complete state here (each leaves 3 OTHER attributes at baseline, but each varies a
  // different one of the 4, so their complete signatures are all distinct).
  const rules: PricingRulePlanRow[] = [
    row("RAM", "RAM", "32GB", "fixed", 12000),
    row("Storage", "Storage", "1TB", "fixed", 8000),
    row("Processor", "Processor", "i7", "fixed", 10000),
    row("Display", "Display", "4K", "fixed", 7000),
  ];

  const result = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-laptop", name: "Laptop" }, sellingModelId: "psm-1", rules }, contexts, "sched-1", [],
  );

  assert.equal(createdRules.length, 4, "no collision exists among these 4 rows — every one still gets its own Rule, exactly as before this fix");
  assert.equal(new Set(result.plans.map(p => p.ruleId)).size, 4);
});

test("TEST 15 — a completely different product/attribute domain with its OWN baseline-value collision: the fix generalizes, nothing hardcoded to Monitor/Display/Screen Size", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const client = buildMockClient({
    productId: "prod-chair",
    defaultValueByPad: { "pad-fabric": "Cotton", "pad-legs": "Wood" },
    onCreateRule: p => createdRules.push(p),
  });
  const schema = buildSchema();
  const contexts = buildContexts([{ name: "Fabric", padId: "pad-fabric" }, { name: "Leg Material", padId: "pad-legs" }]);
  const rules: PricingRulePlanRow[] = [
    row("Fabric", "Fabric", "Cotton", "fixed", 0),
    row("Fabric", "Fabric", "Leather", "fixed", 75),
    row("Leg Material", "Leg Material", "Wood", "fixed", 0),
    row("Leg Material", "Leg Material", "Steel", "fixed", 25),
  ];

  const result = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-chair", name: "Office Chair" }, sellingModelId: null, rules }, contexts, "sched-1", [],
  );

  // "Fabric=Cotton" (row 0) and "Leg Material=Wood" (row 2) are both the all-baseline state.
  assert.equal(createdRules.length, 3, "3 distinct Rules: the shared all-baseline state, Fabric=Leather, Leg Material=Steel");
  assert.equal(result.plans[0].ruleId, result.plans[2].ruleId);
  assert.notEqual(result.plans[0].ruleId, result.plans[1].ruleId);
  assert.notEqual(result.plans[0].ruleId, result.plans[3].ruleId);
});

test("TEST — a product with fewer than 2 price-impacting attributes is completely unaffected by this fix (collision is structurally impossible with only 1 attribute)", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const client = buildMockClient({
    productId: "prod-mouse",
    defaultValueByPad: { "pad-color": "Black" },
    onCreateRule: p => createdRules.push(p),
  });
  const schema = buildSchema();
  const contexts = buildContexts([{ name: "Color", padId: "pad-color" }]);
  const rules: PricingRulePlanRow[] = [
    row("Color", "Color", "Black", "fixed", 0),
    row("Color", "Color", "White", "fixed", 5),
  ];

  const result = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: "prod-mouse", name: "Mouse" }, sellingModelId: null, rules }, contexts, "sched-1", [],
  );

  assert.equal(createdRules.length, 2, "a single price-impacting attribute can never produce a baseline collision — every value still gets its own Rule");
  assert.equal(result.plans.length, 2);
});

/* ── TEST 12 — verifyAdjustmentRecordsReadBack handles duplicate Ids safely ── */

test("TEST 12 — verifyAdjustmentRecordsReadBack compares DISTINCT ids, never a raw array length, so a legitimate duplicate ruleId (2 rows correctly sharing 1 real Rule after this fix) never produces a false 'N/M' shortfall", async () => {
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM PriceAdjustmentSchedule")) return { records: [{ Id: "sched-1" }] };
      if (soql.includes("FROM AttributeBasedAdjRule")) {
        // Only 2 DISTINCT rule ids actually exist, even though the caller's raw list has 3 entries
        // (ruleA appears twice — the correct, intended shape once 2 rows share 1 real Rule).
        return { records: [{ Id: "rule-A" }, { Id: "rule-B" }] };
      }
      if (soql.includes("FROM AttributeAdjustmentCondition")) return { records: [{ Id: "cond-1" }, { Id: "cond-2" }] };
      if (soql.includes("FROM AttributeBasedAdjustment")) return { records: [{ Id: "adj-1" }] };
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result: NativeCreationResult = {
    scheduleId: "sched-1",
    ruleIds: ["rule-A", "rule-B", "rule-A"], // legitimate duplicate — rule-A resolved twice this run
    conditionIds: ["cond-1", "cond-2"],
    adjustmentIds: ["adj-1"],
  };

  const verification = await verifyAdjustmentRecordsReadBack(client, result);
  assert.equal(verification.expectedRuleCount, 2, "expected count must be DISTINCT, not the raw 3-entry array length");
  assert.equal(verification.ruleCount, 2);
  assert.equal(verification.ruleCount, verification.expectedRuleCount, "a legitimate duplicate ruleId must never produce a false verification shortfall");
});

test("TEST 12b — verifyAdjustmentRecordsReadBack still correctly reports a GENUINE shortfall (a referenced Rule that truly doesn't exist)", async () => {
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM PriceAdjustmentSchedule")) return { records: [{ Id: "sched-1" }] };
      if (soql.includes("FROM AttributeBasedAdjRule")) return { records: [{ Id: "rule-A" }] }; // rule-B genuinely missing
      if (soql.includes("FROM AttributeAdjustmentCondition")) return { records: [] };
      if (soql.includes("FROM AttributeBasedAdjustment")) return { records: [] };
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result: NativeCreationResult = { scheduleId: "sched-1", ruleIds: ["rule-A", "rule-B"], conditionIds: [], adjustmentIds: [] };
  const verification = await verifyAdjustmentRecordsReadBack(client, result);
  assert.equal(verification.expectedRuleCount, 2);
  assert.equal(verification.ruleCount, 1, "a genuinely missing Rule must still be caught, never masked by the distinct-count hardening");
  assert.notEqual(verification.ruleCount, verification.expectedRuleCount);
});
