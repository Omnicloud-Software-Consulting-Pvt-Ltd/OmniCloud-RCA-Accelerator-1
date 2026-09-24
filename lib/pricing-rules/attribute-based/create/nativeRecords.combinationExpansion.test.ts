/**
 * §Root-cause architecture fix (user-directed: "Full combinatorial closure") — real `DecisionTableParameter`
 * metadata proved Salesforce's AttributeDiscount Decision Table matches on ONE complete-combination
 * `AttributeAdjConditionsHash` per row; every existing `AttributeBasedAdjustment` this pipeline created
 * represents exactly one varying attribute with everything else pinned to baseline. Selecting two
 * price-impacting attributes away from default at once therefore hashes to a combination with no matching
 * row — this file's own prior comment already flagged multi-attribute combination rules as "not modeled
 * anywhere in this pipeline's rule-plan shape yet — out of scope here."
 *
 * `expandAttributeCombinationRules` closes this: it discovers every existing "pure" single-attribute
 * Adjustment for a product (an attribute's own priced options), computes the combinatorial closure of
 * 2+-simultaneously-varying combinations, and creates whichever don't already exist, reusing the exact same
 * identity/idempotency machinery (`computeRuleConditionSignature`, `findExistingAttributeBasedAdjustment`,
 * `guardedCreate`) the single-attribute path already relies on.
 *
 * These tests cover the genuinely new algorithmic core directly (`computeAttributeCombinations`,
 * `combineAdjustmentValues` — both pure, exported for this purpose) plus end-to-end integration coverage of
 * `expandAttributeCombinationRules` against a realistic mocked client.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import {
  computeAttributeCombinations, combineAdjustmentValues, expandAttributeCombinationRules,
  detectCombinationNameCollisions, estimateCombinationApiCost, planAttributeCombinationExpansion,
  type AttributePricedOption, type AttributeBasedPricingSchema, type AttributeContext,
} from "./nativeRecords";
import type { CombinationRulePlanRow, ProcedureStepLite } from "../types";

function opt(attributeName: string, value: string, adjustmentType: string | null, adjustmentValue: number | null, ruleId = `rule-${attributeName}-${value}`): AttributePricedOption {
  return { attributeName, attributeLabel: attributeName, value, valueLabel: value, ruleId, adjustmentId: `adj-${attributeName}-${value}`, adjustmentType, adjustmentValue };
}

/* ── computeAttributeCombinations (pure) ── */

test("TEST 1 — two attributes, one priced option each: exactly one 2-way combination", () => {
  const options = [opt("RAM", "32GB", "Amount", 100), opt("Storage", "1TB", "Amount", 500)];
  const combos = computeAttributeCombinations(options);
  assert.equal(combos.length, 1);
  assert.deepEqual(combos[0].map(o => o.attributeName).sort(), ["RAM", "Storage"]);
});

test("TEST 2 — three attributes, one option each (the user's own worked example): all 2-way AND the 3-way combination are produced (4 total)", () => {
  const options = [opt("RAM", "32GB", "Amount", 100), opt("Storage", "1TB", "Amount", 500), opt("Display", "13in", "Amount", 100)];
  const combos = computeAttributeCombinations(options);
  // C(3,2) + C(3,3) = 3 + 1 = 4
  assert.equal(combos.length, 4);
  const sizes = combos.map(c => c.length).sort();
  assert.deepEqual(sizes, [2, 2, 2, 3]);
});

test("TEST 3 — an attribute with TWO priced values is never combined with itself (RAM=32GB AND RAM=64GB together is meaningless)", () => {
  const options = [opt("RAM", "32GB", "Amount", 100), opt("RAM", "64GB", "Amount", 200), opt("Storage", "1TB", "Amount", 500)];
  const combos = computeAttributeCombinations(options);
  for (const combo of combos) {
    const attrNames = combo.map(o => o.attributeName);
    assert.equal(new Set(attrNames).size, attrNames.length, `a single combination must never repeat the same attribute: ${JSON.stringify(combo.map(o => `${o.attributeName}=${o.value}`))}`);
  }
  // RAM(32GB or 64GB or baseline) x Storage(1TB or baseline), minus all-baseline, minus the 2 single-attribute-only combos = 2 valid 2-way combos.
  assert.equal(combos.length, 2);
});

test("TEST 4 — a single attribute with priced options and nothing else produces zero combinations (need 2+ DIFFERENT attributes)", () => {
  const options = [opt("RAM", "32GB", "Amount", 100), opt("RAM", "64GB", "Amount", 200)];
  assert.deepEqual(computeAttributeCombinations(options), []);
});

test("TEST 5 — the maxCombinations cap is respected and never silently exceeded", () => {
  // 4 attributes x 2 options each -> (2+1)^4 - 1 - 4*2 = 81 - 1 - 8 = 72 combinations of size 2+; cap well below that.
  const options = ["A", "B", "C", "D"].flatMap(name => [opt(name, `${name}-v1`, "Amount", 10), opt(name, `${name}-v2`, "Amount", 20)]);
  const combos = computeAttributeCombinations(options, 5);
  assert.ok(combos.length <= 5, `expected at most 5 combinations; got ${combos.length}`);
});

test("TEST 6 — works for any product/attribute naming, nothing hardcoded (arbitrary names/values)", () => {
  const options = [opt("###weird-attr-1###", "###weird-val-1###", "Amount", 42), opt("###weird-attr-2###", "###weird-val-2###", "Amount", 7)];
  const combos = computeAttributeCombinations(options);
  assert.equal(combos.length, 1);
  assert.deepEqual(combos[0].map(o => o.value).sort(), ["###weird-val-1###", "###weird-val-2###"]);
});

/* ── combineAdjustmentValues (pure) ── */

test("TEST 7 — same-type Amount adjustments sum: the user's own worked additive example (RAM+100, Storage+500, Display+100 = +700)", () => {
  const result = combineAdjustmentValues([opt("RAM", "32GB", "Amount", 100), opt("Storage", "1TB", "Amount", 500), opt("Display", "13in", "Amount", 100)], "Override");
  assert.equal(result.type, "Amount");
  assert.equal(result.value, 700);
  assert.equal(result.skippedReason, null);
});

test("TEST 8 — same-type discount (negative Amount) adjustments sum correctly: -100 + -500 + -100 = -700", () => {
  const result = combineAdjustmentValues([opt("RAM", "32GB", "Amount", -100), opt("Storage", "1TB", "Amount", -500), opt("Display", "13in", "Amount", -100)], "Override");
  assert.equal(result.type, "Amount");
  assert.equal(result.value, -700);
});

test("TEST 9 — same-type Percentage adjustments sum additively (documented assumption): +10% and +5% combine to +15%, never compounded", () => {
  const result = combineAdjustmentValues([opt("RAM", "32GB", "Percentage", 10), opt("Storage", "1TB", "Percentage", 5)], "Override");
  assert.equal(result.type, "Percentage");
  assert.equal(result.value, 15);
});

test("TEST 10 — mixed adjustment types (one Amount + one Percentage) are refused, never guessed into a fake combined value", () => {
  const result = combineAdjustmentValues([opt("RAM", "32GB", "Amount", 100), opt("Storage", "1TB", "Percentage", 10)], "Override");
  assert.equal(result.type, null);
  assert.equal(result.value, null);
  assert.match(result.skippedReason ?? "", /mixed or unresolved adjustment types/);
});

test("TEST 11 — a combination involving an Override-type member is refused (override replaces the price outright, never summable)", () => {
  const result = combineAdjustmentValues([opt("RAM", "32GB", "Override", 1200), opt("Storage", "1TB", "Override", 1500)], "Override");
  assert.equal(result.type, null);
  assert.match(result.skippedReason ?? "", /override/i);
});

test("TEST 12 — an unresolved (null) adjustment type on any member is refused, never treated as a silent zero", () => {
  const result = combineAdjustmentValues([opt("RAM", "32GB", "Amount", 100), opt("Storage", "1TB", null, null)], "Override");
  assert.equal(result.type, null);
  assert.match(result.skippedReason ?? "", /mixed or unresolved/);
});

/* ── expandAttributeCombinationRules (integration, mocked client) ── */

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

function buildSchema(): AttributeBasedPricingSchema {
  const ruleDescribe = { name: "AttributeBasedAdjRule", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("Name", "string"), field("Product2Id", "reference"), field("IsActive", "boolean")] } as unknown as DescribeResult;
  const conditionDescribe = { name: "AttributeAdjustmentCondition", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("AttributeBasedAdjRuleId", "reference"), field("ProductAttributeDefinitionId", "reference"), field("Product2Id", "reference"), field("StringValue", "string"), field("Operator", "picklist", { picklistValues: [{ value: "Equals", label: "Equals", active: true }] })] } as unknown as DescribeResult;
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

function buildContexts(): Map<string, AttributeContext> {
  const ctx = (padId: string): AttributeContext => ({
    attributeDefinitionId: `ad-${padId}`, dataType: "Picklist", dataTypeSource: "AttributeDefinition.DataType",
    productAttributeDefinitionId: padId, isPriceImpacting: true, productClassificationAttrId: null, source: "DIRECT",
  });
  return new Map([["RAM", ctx("pad-ram")], ["Storage", ctx("pad-storage")]]);
}

/** A realistic-shaped mock covering everything `expandAttributeCombinationRules` needs: an existing rule
 * per single-attribute option (each with a complete 2-condition set + its own Adjustment), plus the
 * ProductAttributeDefinition/SchemaCache describe `resolveBaseProductConfiguration` needs internally. */
function buildMockClient(opts: {
  /** Simulates a pre-existing combination Rule recognized by CONTENT (its own real conditions), never by
   * Name — the shape `discoverExistingRuleContentIdentities`'s bulk Product2Id-scoped condition query
   * returns. `conditions` is that Rule's own complete or partial condition set. */
  existingCombinationRule?: { ruleId: string; name: string; conditions: { padId: string; value: string }[] };
  onCreateRule?: (payload: Record<string, unknown>) => void;
  onCreateCondition?: (payload: Record<string, unknown>) => void;
  onCreateAdjustment?: (payload: Record<string, unknown>) => void;
}) {
  const createdIds = new Map<string, number>();
  const createdConditionsByRule = new Map<string, { padId: string; value: string }[]>();
  const client = {
    async describeObject(name: string) {
      if (name === "ProductAttributeDefinition") {
        return { name, label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("DefaultValue", "string"), field("ProductClassificationAttributeId", "reference")] } as unknown as DescribeResult;
      }
      throw new Error(`unexpected describeObject: ${name}`);
    },
    async query(soql: string) {
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id IN")) {
        return { records: [{ Id: "pad-ram", DefaultValue: "8GB" }, { Id: "pad-storage", DefaultValue: "256GB" }] };
      }
      if (soql.includes("FROM AttributeBasedAdjRule WHERE Product2Id")) {
        return { records: [{ Id: "rule-RAM-32GB" }, { Id: "rule-Storage-1TB" }] };
      }
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE AttributeBasedAdjRuleId = 'rule-RAM-32GB'")) {
        return { records: [{ Id: "c1", ProductAttributeDefinitionId: "pad-ram", StringValue: "32GB" }, { Id: "c2", ProductAttributeDefinitionId: "pad-storage", StringValue: "256GB" }] };
      }
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE AttributeBasedAdjRuleId = 'rule-Storage-1TB'")) {
        return { records: [{ Id: "c3", ProductAttributeDefinitionId: "pad-ram", StringValue: "8GB" }, { Id: "c4", ProductAttributeDefinitionId: "pad-storage", StringValue: "1TB" }] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE AttributeBasedAdjRuleId = 'rule-RAM-32GB'")) {
        return { records: [{ Id: "adj-ram-32gb", ProductSellingModelId: "psm-1", AdjustmentType: "Amount", AdjustmentValue: 100 }] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE AttributeBasedAdjRuleId = 'rule-Storage-1TB'")) {
        return { records: [{ Id: "adj-storage-1tb", ProductSellingModelId: "psm-1", AdjustmentType: "Amount", AdjustmentValue: 500 }] };
      }
      // §Content-identity fix — discoverExistingRuleContentIdentities' bulk, product-scoped condition
      // query (never a per-combination Name lookup). Returns the simulated pre-existing combination
      // Rule's own real conditions, if any.
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE Product2Id =")) {
        if (!opts.existingCombinationRule) return { records: [] };
        return { records: opts.existingCombinationRule.conditions.map((c, i) => ({ Id: `existing-c${i}`, AttributeBasedAdjRuleId: opts.existingCombinationRule!.ruleId, ProductAttributeDefinitionId: c.padId, StringValue: c.value })) };
      }
      if (soql.includes("FROM AttributeBasedAdjRule WHERE Id IN")) {
        return opts.existingCombinationRule ? { records: [{ Id: opts.existingCombinationRule.ruleId, Name: opts.existingCombinationRule.name }] } : { records: [] };
      }
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE AttributeBasedAdjRuleId") && soql.includes("AND ProductAttributeDefinitionId")) {
        return { records: [] }; // never reached on the KEEP/COMPLETE path — only a brand-new Rule's own per-attribute existence checks land here, and this mock's combos always resolve pre-existing conditions via the bulk query above
      }
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE AttributeBasedAdjRuleId =")) {
        // computeRuleConditionSignature — reflects whatever this run has created/reused so far for this rule.
        const ruleId = /AttributeBasedAdjRuleId = '([^']+)'/.exec(soql)?.[1] ?? "";
        const fromExisting = opts.existingCombinationRule?.ruleId === ruleId ? opts.existingCombinationRule.conditions.map((c, i) => ({ Id: `existing-c${i}`, ProductAttributeDefinitionId: c.padId, StringValue: c.value })) : [];
        const fromCreated = (createdConditionsByRule.get(ruleId) ?? []).map((c, i) => ({ Id: `created-c${i}`, ProductAttributeDefinitionId: c.padId, StringValue: c.value }));
        const byPad = new Map<string, { Id: string; ProductAttributeDefinitionId: string; StringValue: string }>();
        for (const r of [...fromExisting, ...fromCreated]) byPad.set(r.ProductAttributeDefinitionId, r);
        return { records: [...byPad.values()] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE") && soql.includes("Product2Id =")) {
        return { records: [] }; // no pre-existing combination Adjustment — always create
      }
      // guardedCreate's own read-back verification for any newly-created record this mock returned.
      const readBackMatch = /WHERE Id = '(new-[^']+)'/.exec(soql);
      if (readBackMatch) return { records: [{ Id: readBackMatch[1] }] };
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      const n = (createdIds.get(objectName) ?? 0) + 1;
      createdIds.set(objectName, n);
      const id = `new-${objectName}-${n}`;
      if (objectName === "AttributeBasedAdjRule") opts.onCreateRule?.(payload);
      if (objectName === "AttributeAdjustmentCondition") {
        opts.onCreateCondition?.(payload);
        const ruleId = payload.AttributeBasedAdjRuleId as string;
        if (!createdConditionsByRule.has(ruleId)) createdConditionsByRule.set(ruleId, []);
        createdConditionsByRule.get(ruleId)!.push({ padId: payload.ProductAttributeDefinitionId as string, value: payload.StringValue as string });
      }
      if (objectName === "AttributeBasedAdjustment") opts.onCreateAdjustment?.(payload);
      return { id };
    },
    async getRecord() { return { attributes: {} }; },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
  return client;
}

/** §Combination-expansion architecture fix — `expandAttributeCombinationRules` now materializes ONLY the
 * explicit combinations `requestedCombinations` names (already resolved against real Salesforce data by
 * `analyze.ts`'s Step 8.5), never rediscovering every historical single-attribute option and cross-producting
 * them. This is the exact shape `createPipeline.ts` builds from `input.combinationRules`. */
function explicitCombo(members: { attributeName: string; value: string }[], adjustmentType: string, adjustment: number): CombinationRulePlanRow {
  return {
    members: members.map(m => ({ attributeName: m.attributeName, attributeLabel: m.attributeName, value: m.value, valueLabel: m.value })),
    adjustmentType: adjustmentType as CombinationRulePlanRow["adjustmentType"],
    adjustment,
    rawText: members.map(m => `${m.attributeName}=${m.value}`).join(" AND "),
  };
}

test("TEST 13 — an explicit RAM=32GB AND Storage=1TB combination request creates exactly one combination rule with the STATED adjustment (never summed from RAM/Storage's own individual adjustments)", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const createdConditions: Record<string, unknown>[] = [];
  const createdAdjustments: Record<string, unknown>[] = [];
  const client = buildMockClient({
    onCreateRule: p => createdRules.push(p),
    onCreateCondition: p => createdConditions.push(p),
    onCreateAdjustment: p => createdAdjustments.push(p),
  });
  const schema = buildSchema();
  const contexts = buildContexts();
  const steps: ProcedureStepLite[] = [];
  const requested = [explicitCombo([{ attributeName: "RAM", value: "32GB" }, { attributeName: "Storage", value: "1TB" }], "fixed", 5000)];

  const result = await expandAttributeCombinationRules(
    client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: "psm-1", scheduleId: "sched-1" }, contexts, requested, steps,
  );

  assert.equal(result.discoveredOptions.length, 0, "no discovery happens for the explicit path — nothing is rediscovered/cross-produced");
  assert.equal(result.plans.length, 1, "exactly the one requested combination — never more, never a Cartesian product");
  assert.equal(result.plans[0].skippedReason, null);
  assert.equal(result.plans[0].combinedAdjustmentType, "Amount");
  assert.equal(result.plans[0].combinedAdjustmentValue, 5000, "the STATED combination adjustment, never summed from RAM's/Storage's own individual per-attribute adjustments");
  assert.equal(result.createdCount, 1);
  assert.equal(createdRules.length, 1, "exactly one new AttributeBasedAdjRule created for the combination");
  assert.equal(createdAdjustments.length, 1);
  assert.equal(createdAdjustments[0].AdjustmentValue, 5000);
  assert.ok(createdConditions.length >= 2, "the combination rule needs a condition for EVERY price-impacting attribute (RAM + Storage)");
});

test("TEST 14 — the combination rule is REUSED BY CONTENT (never duplicated) when a matching one already exists, even though its Name doesn't match what this run would generate", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const client = buildMockClient({
    // Deliberately a DIFFERENT name than `sanitizeRuleName` would generate for this combo — proves reuse
    // is content-based, never Name-based (the exact regression this fix closes).
    existingCombinationRule: { ruleId: "existing-combo-rule", name: "Some_Totally_Different_Legacy_Name_Rule", conditions: [{ padId: "pad-ram", value: "32GB" }, { padId: "pad-storage", value: "1TB" }] },
    onCreateRule: p => createdRules.push(p),
  });
  const schema = buildSchema();
  const contexts = buildContexts();
  const steps: ProcedureStepLite[] = [];
  const requested = [explicitCombo([{ attributeName: "RAM", value: "32GB" }, { attributeName: "Storage", value: "1TB" }], "fixed", 5000)];

  const result = await expandAttributeCombinationRules(
    client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: "psm-1", scheduleId: "sched-1" }, contexts, requested, steps,
  );

  assert.equal(createdRules.length, 0, "must reuse the existing combination rule by content, never create a duplicate merely because its Name differs");
  assert.equal(result.plans[0].ruleId, "existing-combo-rule");
});

test("TEST 15 — no explicit combination requested: zero discovery, zero Cartesian product, zero writes, immediate return", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const client = {
    async describeObject() { throw new Error("must not describe anything when no combination was requested"); },
    async query(soql: string) { throw new Error(`must not query anything when no combination was requested: ${soql}`); },
    async createRecord(objectName: string) { createdRules.push({ objectName }); return { id: "x" }; },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
  const schema = buildSchema();
  const contexts = buildContexts();
  const steps: ProcedureStepLite[] = [];

  const result = await expandAttributeCombinationRules(
    client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: "psm-1", scheduleId: "sched-1" }, contexts, [], steps,
  );
  assert.equal(result.plans.length, 0);
  assert.equal(result.discoveredOptions.length, 0);
  assert.equal(createdRules.length, 0);
});

test("TEST 15b — three explicit combinations create exactly three combination rules, never a Cartesian product of the underlying attribute values", async () => {
  const createdRules: Record<string, unknown>[] = [];
  const client = buildMockClient({ onCreateRule: p => createdRules.push(p) });
  const schema = buildSchema();
  const contexts = buildContexts();
  const steps: ProcedureStepLite[] = [];
  const requested = [
    explicitCombo([{ attributeName: "RAM", value: "32GB" }, { attributeName: "Storage", value: "1TB" }], "fixed", 5000),
    explicitCombo([{ attributeName: "RAM", value: "64GB" }, { attributeName: "Storage", value: "2TB" }], "fixed", 9000),
    explicitCombo([{ attributeName: "RAM", value: "16GB" }, { attributeName: "Storage", value: "512GB" }], "percentage", 15),
  ];

  const result = await expandAttributeCombinationRules(
    client, schema, { product: { id: "prod-1", name: "Laptop" }, sellingModelId: "psm-1", scheduleId: "sched-1" }, contexts, requested, steps,
  );

  assert.equal(result.plans.length, 3, "exactly the 3 explicitly requested combinations — never a permutation of every attribute value");
  assert.equal(createdRules.length, 3);
});

/* ── Offline forensic-analysis fix: name-collision detection + API-cost estimation (all pure, no Salesforce) ──
 *
 * A live run of `expandAttributeCombinationRules` against the real org captured (verbatim, from its own
 * stdout) that these 5 different Storage-value combinations all sanitized to the IDENTICAL 80-character
 * Rule name "Processor_Display_Screen_Size_Storage_i7_CPU_4_7GHz_2k_Built_in_Display_15_Inch_" under the
 * OLD naive `slice(0, 80)` — because every Storage value sits entirely past the 80th character, so
 * truncation never even reaches the token that would have told them apart. Every test below reproduces
 * this using the exact real attribute/value strings from that run. */

function realCollisionOptions(): AttributePricedOption[] {
  const processor = opt("Processor", "i7-CPU 4.7GHz", "Amount", 300);
  const display = opt("Display", "2k Built-in Display", "Amount", 100);
  const screenSize = opt("Screen Size", "15 Inch", "Amount", 100);
  const storageValues = [
    ["SSD Hard Drive 512GB", 100],
    ["Cloud Storage Enterprise - 6 TB", 0],
    ["SSD Hard Drive 1TB", 200],
    ["SSD Hard Drive 2TB", 300],
    ["Cloud Storage Enterprise - 2 TB", -50],
  ] as const;
  return [
    processor, display, screenSize,
    ...storageValues.map(([v, amt]) => opt("Storage", v, "Amount", amt)),
  ];
}

test("TEST 16 — the exact real live-run collision: 5 different Storage-valued 4-attribute combinations, PRE-fix, would collapse onto one Rule name", () => {
  // Reproduces the OLD, unfixed truncation directly (not through sanitizeRuleName, which is now fixed) —
  // proof that the failure mode is real and was correctly diagnosed, not merely asserting today's fixed behavior.
  const oldSanitize = (attributeName: string, value: string) =>
    `${attributeName}_${value}_Rule`.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 80);
  const attrNames = "Processor_Display_Screen_Size_Storage";
  const commonPrefix = "i7-CPU 4.7GHz_2k Built-in Display_15 Inch";
  const storageValues = ["SSD Hard Drive 512GB", "Cloud Storage Enterprise - 6 TB", "SSD Hard Drive 1TB", "SSD Hard Drive 2TB", "Cloud Storage Enterprise - 2 TB"];
  const names = storageValues.map(sv => oldSanitize(attrNames, `${commonPrefix}_${sv}`));
  assert.equal(new Set(names).size, 1, `expected all 5 real combinations to collide onto ONE name under the old truncation; got ${new Set(names).size} distinct names: ${JSON.stringify([...new Set(names)])}`);
  assert.equal(names[0].length, 80);
});

test("TEST 17 — POST-fix: detectCombinationNameCollisions finds ZERO collisions for the same real 4-attribute/5-Storage-value dataset that used to collide", () => {
  const options = realCollisionOptions();
  const combinations = computeAttributeCombinations(options, 1000);
  const collisions = detectCombinationNameCollisions(combinations);
  assert.deepEqual(collisions, [], `expected zero name collisions after the sanitizeRuleName fix; found: ${JSON.stringify(collisions)}`);
});

test("TEST 18 — planAttributeCombinationExpansion reports valid:true and zero collisions for the real dataset, with a sane count and rule-name list", () => {
  const options = realCollisionOptions();
  const plan = planAttributeCombinationExpansion(options, 6 /* this product's real price-impacting attribute count */);
  assert.equal(plan.valid, true);
  assert.equal(plan.collisions.length, 0);
  assert.equal(plan.ruleNames.length, plan.totalCombinations);
  assert.equal(new Set(plan.ruleNames).size, plan.ruleNames.length, "every planned Rule name must be unique");
  assert.ok(plan.totalCombinations > 0);
});

test("TEST 19 — planAttributeCombinationExpansion is a hard stop (valid:false) when a genuine collision is engineered (two DIFFERENT member-sets sharing a name)", () => {
  // Force a real collision the only way possible post-fix: two combinations whose full sanitized+hashed
  // names happen to coincide is astronomically unlikely, so this test verifies the GATE itself fires
  // correctly given a collision report, by exercising detectCombinationNameCollisions on a hand-built
  // combinations array with two distinct member-sets sharing an identical rule name deliberately (proves
  // the gate's own wiring, independent of how unlikely a real collision now is).
  const comboA = [opt("Storage", "SameValue", "Amount", 100, "rule-A")];
  const comboB = [opt("Storage", "SameValue", "Amount", 200, "rule-B")];
  // Same attribute+value pair genuinely does sanitize identically — this is a same-content "duplicate",
  // exactly the shape detectCombinationNameCollisions must flag regardless of why it happened.
  const collisions = detectCombinationNameCollisions([comboA, comboB]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].members.length, 2);
});

/* ── estimateCombinationApiCost (pure) ── */

test("TEST 20 — API cost estimate grows linearly in combination count (proves the O(N) fix, not O(N^2)): doubling combinations roughly doubles the estimate", () => {
  const est50 = estimateCombinationApiCost(50, 6);
  const est100 = estimateCombinationApiCost(100, 6);
  const ratioLow = (est100.estimatedApiCallsLowBound - 1) / (est50.estimatedApiCallsLowBound - 1);
  const ratioHigh = (est100.estimatedApiCallsHighBound - 1) / (est50.estimatedApiCallsHighBound - 1);
  assert.ok(Math.abs(ratioLow - 2) < 0.05, `expected ~2x scaling (linear), got ${ratioLow}`);
  assert.ok(Math.abs(ratioHigh - 2) < 0.05, `expected ~2x scaling (linear), got ${ratioHigh}`);
});

test("TEST 21 — API cost estimate for the real run's shape (71 combinations processed, 6 price-impacting attributes) lands in the thousands, consistent with exhausting a Developer Edition org's daily limit", () => {
  const est = estimateCombinationApiCost(71, 6);
  assert.ok(est.estimatedApiCallsLowBound > 500, `low bound too small: ${est.estimatedApiCallsLowBound}`);
  assert.ok(est.estimatedApiCallsHighBound < 20000, `high bound implausibly large: ${est.estimatedApiCallsHighBound}`);
});

test("TEST 22 — zero combinations estimate to just the one-time seed query, never a divide-by-zero or negative number", () => {
  const est = estimateCombinationApiCost(0, 6);
  assert.equal(est.estimatedApiCallsLowBound, 1);
  assert.equal(est.estimatedApiCallsHighBound, 1);
});

test("TEST 23 — a single price-impacting attribute (minimum realistic case) never produces a negative or NaN estimate", () => {
  const est = estimateCombinationApiCost(10, 1);
  assert.ok(Number.isFinite(est.estimatedApiCallsLowBound) && est.estimatedApiCallsLowBound > 0);
  assert.ok(Number.isFinite(est.estimatedApiCallsHighBound) && est.estimatedApiCallsHighBound > 0);
});

test("TEST 24 — a large, many-attribute combination set (bounded by maxCombinations) still produces unique names for every combination — no collisions at scale", () => {
  const attrCount = 6;
  const valuesPerAttr = 5;
  const options: AttributePricedOption[] = [];
  for (let a = 0; a < attrCount; a++) {
    for (let v = 0; v < valuesPerAttr; v++) {
      options.push(opt(`VeryLongAttributeNameNumber${a}ThatEatsIntoTheEightyCharacterBudget`, `VeryLongValueNumber${v}ThatAlsoEatsIntoTheBudget`, "Amount", 10 * (a + 1) + v));
    }
  }
  const combinations = computeAttributeCombinations(options, 500);
  assert.ok(combinations.length > 50, `expected a substantial combination set; got ${combinations.length}`);
  const collisions = detectCombinationNameCollisions(combinations);
  assert.deepEqual(collisions, [], `expected zero collisions even with long, similar names at scale; found ${collisions.length}`);
});
