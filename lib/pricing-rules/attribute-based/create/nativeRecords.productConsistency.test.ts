/**
 * §Root-cause fix regression coverage — two live Salesforce FIELD_INTEGRITY_EXCEPTIONs, both ultimately
 * caused by the Rule → Condition → Adjustment chain losing track of WHICH product it was building for:
 *
 *   LAPTOP: "For the given Attribute Based Adjustment Rule, select the same product record for all
 *   Attribute Adjustment Conditions." — `createOrReuseAttributeBasedAdjRules` looked up an existing Rule
 *   by NAME ALONE (Salesforce does not enforce Name uniqueness on AttributeBasedAdjRule, so two different
 *   products sharing an attribute/value combination can produce byte-identical rule names), and
 *   `findExistingAttributeAdjustmentCondition` reused an existing condition by Rule+identity alone, never
 *   verifying Product2Id — so a condition belonging to a DIFFERENT product than the current run's could be
 *   silently attached to the current rule.
 *
 *   MONITOR: "Associate the same product with both the attribute based adjustment and Attribute Adjustment
 *   Condition records." — `computeRuleConditionSignature` built its dedup/reuse signature purely from
 *   `attribute=value` tokens, never Product2Id, so two DIFFERENT products' rules with coincidentally
 *   identical attribute/value sets produced identical signatures and could be falsely treated as "the same
 *   configuration."
 *
 * Fixed by scoping every Rule/Condition lookup by Product2Id (never derived from the current
 * attribute/value/array position — always the Rule's own resolved product, read directly from
 * Salesforce), folding Product2Id into the condition signature, and adding a dedicated pre-POST
 * `validateAttributePricingProductConsistency` gate that never lets an inconsistent configuration reach
 * Salesforce's `createRecord()` at all.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import {
  createOrReuseAttributeBasedAdjRules, createAttributeAdjustmentConditions, createAttributeBasedAdjustments,
  validateAttributePricingProductConsistency,
  type AttributeContext, type AttributeBasedPricingSchema, type AttributeBasedRulePlan,
} from "./nativeRecords";
import type { PricingRulePlanRow } from "../types";

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}
function oneYearFromTodayISODate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
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
      field("Product2Id", "reference", { referenceTo: ["Product2"] }),
      field("Operator", "picklist", { picklistValues: [{ value: "Equal", label: "Equal", active: true }] }),
      field("StringValue", "string"),
    ],
  } as unknown as DescribeResult;
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
    ruleDescribe, conditionDescribe, abaDescribe,
    ruleProductField: { field: ruleDescribe.fields.find(f => f.name === "Product2Id")!, candidates: [] },
    ruleScheduleField: { field: ruleDescribe.fields.find(f => f.name === "PriceAdjustmentScheduleId")!, candidates: [] },
    ruleActiveField: null, ruleEffFromField: null, ruleEffToField: null,
    conditionRuleField: { field: conditionDescribe.fields.find(f => f.name === "AttributeBasedAdjRuleId")!, candidates: [] },
    conditionPadField: { field: conditionDescribe.fields.find(f => f.name === "ProductAttributeDefinitionId")!, candidates: [] },
    conditionAttrDefField: { field: null, candidates: [] },
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

function buildContexts(attrs: { name: string; padId: string }[]): Map<string, AttributeContext> {
  const contexts = new Map<string, AttributeContext>();
  for (const a of attrs) {
    contexts.set(a.name, { attributeDefinitionId: null, dataType: "Text", dataTypeSource: null, productAttributeDefinitionId: a.padId, isPriceImpacting: true, productClassificationAttrId: null, source: "DIRECT" });
  }
  return contexts;
}

function buildRow(attributeName: string, value: string): PricingRulePlanRow {
  return { attributeName, attributeLabel: attributeName, value, valueLabel: value, isNewValue: false, adjustmentType: "fixed", adjustment: -10 } as unknown as PricingRulePlanRow;
}

/* ── TEST D fixtures — deliberately unlike any other test file's IDs, to prove nothing about the logic
 * assumes a specific ID shape/value. ── */
const PRODUCT_A = "01tXYZ000000AAAAAA";
const PRODUCT_B = "01tXYZ000000BBBBBB";

/* ── TEST A — Laptop-style: an existing condition matches Rule+identity but belongs to a DIFFERENT
 * product. Must never be reused; a correct, product-specific condition must be created instead, and no
 * invalid Salesforce POST (i.e. no create attempt that would collide with the wrong-product condition's
 * rule) occurs first. ── */
test("TEST A (Laptop) — an existing condition matching Rule+identity but belonging to a DIFFERENT product is never reused; a new, correctly product-scoped condition is created instead", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }]);
  const createCalls: Record<string, unknown>[] = [];
  const createdIds = new Set<string>();
  const client = {
    async describeObject(sobject: string) {
      if (sobject === "ProductAttributeDefinition") {
        return { name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("DefaultValue", "string")] };
      }
      throw new Error(`unexpected describeObject(${sobject})`);
    },
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE Id = ")) {
        const m = soql.match(/WHERE Id = '([^']+)'/);
        return m && createdIds.has(m[1]) ? { totalSize: 1, done: true, records: [{ Id: m[1] }] } : { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        // The ONLY existing condition for this Rule+identity belongs to PRODUCT_B, not the PRODUCT_A this
        // run is processing — never returned when the query is correctly scoped to PRODUCT_A.
        if (soql.includes(`Product2Id = '${PRODUCT_A}'`)) return { totalSize: 0, done: true, records: [] };
        return { totalSize: 1, done: true, records: [{ Id: "cond-wrong-product", ProductAttributeDefinitionId: "pad-memory", StringValue: "RAM 8GB", Product2Id: PRODUCT_B }] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id IN")) return { totalSize: 1, done: true, records: [{ Id: "pad-memory", DefaultValue: "RAM 8GB" }] };
      if (soql.includes("FROM ProductAttributeDefinition WHERE") && soql.includes("IsPriceImpacting = true")) return { totalSize: 0, done: true, records: [] };
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      createCalls.push(payload);
      createdIds.add("cond-new-correct-product");
      return { id: "cond-new-correct-product" };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: [], ruleProductId: PRODUCT_A },
  ];
  const result = await createAttributeAdjustmentConditions(client, schema, { product: { id: PRODUCT_A, name: "Laptop" } }, contexts, plans, []);

  assert.equal(result.conditionIds.length, 1, "a brand-new, correctly-scoped condition must be created — the wrong-product one is never reused");
  assert.equal(result.reusedConditionIds.length, 0);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].Product2Id, PRODUCT_A, "the newly created condition must carry THIS run's product, never the wrong-product one that was found and rejected");
});

/* ── TEST B — Monitor-style: conditions genuinely belong to Product A, but the Adjustment attempt is for
 * Product B. Pre-POST validation must fail; createRecord() must NEVER be called; the diagnostic must
 * explicitly name the Product mismatch. ── */
test("TEST B (Monitor) — pre-POST validation fails when a Rule's conditions belong to a different Product than the Adjustment attempt; createRecord() is never called", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([{ name: "Display", padId: "pad-display" }, { name: "ScreenSize", padId: "pad-screensize" }]);
  let createCalls = 0;
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE") && !soql.includes("WHERE Id = ")) {
        // Both real conditions exist, but they belong to PRODUCT_A — the Adjustment attempt below is for PRODUCT_B.
        return {
          totalSize: 2, done: true,
          records: [
            { Id: "cond-display", ProductAttributeDefinitionId: "pad-display", StringValue: "1080p Built-in Display", Product2Id: PRODUCT_A },
            { Id: "cond-screensize", ProductAttributeDefinitionId: "pad-screensize", StringValue: "13 Inch", Product2Id: PRODUCT_A },
          ],
        };
      }
      if (soql.includes("SELECT Product2Id FROM AttributeBasedAdjRule")) return { totalSize: 1, done: true, records: [{ Product2Id: PRODUCT_A }] };
      if (soql.includes("FROM AttributeBasedAdjustment")) return { totalSize: 0, done: true, records: [] };
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord() {
      createCalls++;
      throw new Error("createRecord() must never be called once pre-POST validation has already failed");
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Display", "1080p Built-in Display"), ctx: contexts.get("Display")!, ruleId: "rule-monitor", reusedExisting: false, conditionIds: ["cond-display", "cond-screensize"], ruleProductId: PRODUCT_A },
  ];

  await assert.rejects(
    () => createAttributeBasedAdjustments(client, schema, { product: { id: PRODUCT_B, name: "Monitor" }, sellingModelId: null }, contexts, "schedule-1", plans, []),
    (err: Error) => {
      assert.match(err.message, /[Pp]roduct consistency/);
      assert.ok(err.message.includes(PRODUCT_A) && err.message.includes(PRODUCT_B), "diagnostic must explicitly name both the expected and actual Product Ids");
      return true;
    },
  );
  assert.equal(createCalls, 0, "Salesforce createRecord() must NEVER be called once the pre-POST product-consistency gate has failed");
});

/* ── TEST C — valid case: Rule, every condition, and the Adjustment all agree on the SAME product. ── */
test("TEST C (valid) — validation passes and the Adjustment is created when Rule/conditions/Adjustment all agree on the same Product", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }]);
  let createCalls = 0;
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE") && !soql.includes("WHERE Id = ")) {
        return { totalSize: 1, done: true, records: [{ Id: "cond-1", ProductAttributeDefinitionId: "pad-memory", StringValue: "RAM 8GB", Product2Id: PRODUCT_A }] };
      }
      if (soql.includes("SELECT Product2Id FROM AttributeBasedAdjRule")) return { totalSize: 1, done: true, records: [{ Product2Id: PRODUCT_A }] };
      if (soql.includes("FROM AttributeBasedAdjustment WHERE Id = ")) {
        const m = soql.match(/WHERE Id = '([^']+)'/);
        return m?.[1] === "adj-1"
          ? { totalSize: 1, done: true, records: [{ Id: "adj-1", Product2Id: PRODUCT_A, PriceAdjustmentScheduleId: "schedule-1", AttributeBasedAdjRuleId: "rule-1", ProductSellingModelId: null, EffectiveFrom: todayISODate(), EffectiveTo: oneYearFromTodayISODate() }] }
          : { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeBasedAdjustment")) return { totalSize: 0, done: true, records: [] };
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord(objectName: string) {
      createCalls++;
      if (objectName !== "AttributeBasedAdjustment") throw new Error(`unexpected createRecord: ${objectName}`);
      return { id: "adj-1" };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: ["cond-1"], ruleProductId: PRODUCT_A },
  ];
  const result = await createAttributeBasedAdjustments(client, schema, { product: { id: PRODUCT_A, name: "Laptop" }, sellingModelId: null }, contexts, "schedule-1", plans, []);

  assert.equal(createCalls, 1, "a fully-consistent configuration must reach createRecord() exactly once");
  assert.equal(result.adjustmentIds.length, 1);
  assert.equal(result.adjustmentIds[0], "adj-1");
});

/* ── TEST D — cross-org IDs: PRODUCT_A/PRODUCT_B above are already deliberately unlike every other test
 * file's fake IDs in this directory; this test additionally proves `createOrReuseAttributeBasedAdjRule`'s
 * NEW product-scoped rule lookup works with arbitrary, non-standard-looking Ids — nothing about the logic
 * assumes any particular ID shape or a specific org's actual values. ── */
test("TEST D (cross-org IDs) — a same-named Rule candidate belonging to a DIFFERENT, arbitrarily-shaped Product Id is scanned, rejected, and never reused; a brand-new Rule is created for the current product instead", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }]);
  const queriesSeen: string[] = [];
  const createdIds = new Set<string>();
  const client = {
    async query(soql: string) {
      queriesSeen.push(soql);
      if (soql.includes("FROM AttributeBasedAdjRule WHERE Id = ")) {
        const m = soql.match(/WHERE Id = '([^']+)'/);
        return m && createdIds.has(m[1]) ? { totalSize: 1, done: true, records: [{ Id: m[1] }] } : { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeBasedAdjRule WHERE Name")) {
        // §Live-org fix (Org A) — Name is scanned WITHOUT a product-scoped WHERE clause (every same-named
        // row must be evaluated, never just whichever the SQL WHERE happens to filter to first); the ONLY
        // existing row happens to belong to a completely different, arbitrarily-shaped Product Id
        // (PRODUCT_B) — proving nothing about the rejection logic assumes any particular ID prefix/format.
        return { totalSize: 1, done: true, records: [{ Id: "rule-wrong-product", Product2Id: PRODUCT_B }] };
      }
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE") && soql.includes(" IN (")) {
        // The wrong-product candidate has no existing conditions attached yet — irrelevant either way,
        // since its own Product2 already disqualifies it.
        return { totalSize: 0, done: true, records: [] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      if (objectName !== "AttributeBasedAdjRule") throw new Error(`unexpected createRecord: ${objectName}`);
      assert.equal(payload.Product2Id, PRODUCT_A, "the new Rule must be created for THIS run's product, never copied from the rejected candidate");
      createdIds.add("rule-new");
      return { id: "rule-new" };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const { plans } = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: PRODUCT_A, name: "Cross-Org Product" }, sellingModelId: null, rules: [buildRow("Memory", "RAM 8GB")] },
    contexts, "schedule-1", [],
  );
  assert.equal(plans[0].ruleId, "rule-new", "the wrong-product candidate must never be reused, regardless of its ID's shape");
  assert.equal(plans[0].ruleProductId, PRODUCT_A);
  assert.ok(queriesSeen.some(q => q.includes("FROM AttributeBasedAdjRule WHERE Name")), "every same-named row must be scanned (never scoped away by a product-filtered WHERE clause, which would hide contaminated candidates from evaluation)");
});

test("TEST F (Org A recovery) — a contaminated same-named Rule candidate is skipped WITHOUT a fatal throw, and a separate, product-consistent existing Rule with the SAME name is found and reused instead", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }]);
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeBasedAdjRule WHERE Name")) {
        // Two rows share this exact Name — one contaminated (belongs to PRODUCT_B), one genuinely valid
        // for PRODUCT_A. The prior implementation's `LIMIT 1` lookup could only ever see whichever record
        // Salesforce happened to return first; this scans BOTH and must not stop at (or fatally throw on)
        // the first, wrong-product one.
        return { totalSize: 2, done: true, records: [{ Id: "rule-b", Product2Id: PRODUCT_B }, { Id: "rule-a", Product2Id: PRODUCT_A }] };
      }
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE") && soql.includes(" IN (")) {
        // Both candidate rules' own conditions are internally consistent with their own products — the
        // only reason rule-b is rejected is its OWN Product2, not its conditions.
        return {
          totalSize: 2, done: true,
          records: [
            { AttributeBasedAdjRuleId: "rule-b", Product2Id: PRODUCT_B },
            { AttributeBasedAdjRuleId: "rule-a", Product2Id: PRODUCT_A },
          ],
        };
      }
      if (soql.includes("FROM AttributeBasedAdjustment WHERE")) return { totalSize: 0, done: true, records: [] };
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord() {
      throw new Error("createRecord() must never be called — a valid existing Rule (rule-a) should have been found and reused");
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const { plans } = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: PRODUCT_A, name: "Recovery Product" }, sellingModelId: null, rules: [buildRow("Memory", "RAM 8GB")] },
    contexts, "schedule-1", [],
  );
  assert.equal(plans[0].ruleId, "rule-a", "must recover by finding the OTHER, product-consistent same-named Rule rather than fatally failing on the first contaminated one");
  assert.equal(plans[0].ruleProductId, PRODUCT_A);
});

test("TEST G (Org A, condition-level contamination) — a Rule whose OWN Product2 matches the request, but one of its EXISTING conditions belongs to a different product, is rejected as a candidate entirely; a brand-new Rule is created instead of reusing or repairing it", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }]);
  const createdIds = new Set<string>();
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeBasedAdjRule WHERE Id = ")) {
        const m = soql.match(/WHERE Id = '([^']+)'/);
        return m && createdIds.has(m[1]) ? { totalSize: 1, done: true, records: [{ Id: m[1] }] } : { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeBasedAdjRule WHERE Name")) {
        // The Rule's OWN Product2 looks perfectly fine (PRODUCT_A) — a naive check that only compares the
        // Rule's own field (and never inspects its conditions) would wrongly treat this as reusable.
        return { totalSize: 1, done: true, records: [{ Id: "rule-poisoned", Product2Id: PRODUCT_A }] };
      }
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE") && soql.includes(" IN (")) {
        // But one of its existing conditions actually belongs to PRODUCT_B — a prior run's contamination
        // that never mutated the Rule's own Product2 field. Must reject the whole candidate.
        return { totalSize: 1, done: true, records: [{ AttributeBasedAdjRuleId: "rule-poisoned", Product2Id: PRODUCT_B }] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      if (objectName !== "AttributeBasedAdjRule") throw new Error(`unexpected createRecord: ${objectName}`);
      assert.equal(payload.Product2Id, PRODUCT_A);
      createdIds.add("rule-new-clean");
      return { id: "rule-new-clean" };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const { plans } = await createOrReuseAttributeBasedAdjRules(
    client, schema, { product: { id: PRODUCT_A, name: "Poisoned Product" }, sellingModelId: null, rules: [buildRow("Memory", "RAM 8GB")] },
    contexts, "schedule-1", [],
  );
  assert.equal(plans[0].ruleId, "rule-new-clean", "a Rule with an internally product-inconsistent condition set must never be reused, even if the Rule's own Product2 field matches");
  assert.equal(plans[0].ruleProductId, PRODUCT_A);
});

/* ── TEST E — partial existing data: one compatible condition already exists (same product), one
 * required condition doesn't exist at all yet. Expected: the compatible one is reused, the missing one is
 * created, final set is complete and product-consistent. ── */
test("TEST E (partial existing data) — an existing compatible condition is reused, a missing one is created, final condition set is complete and product-consistent", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }, { name: "Graphics", padId: "pad-graphics" }]);
  const created: Record<string, unknown>[] = [];
  const createdIds = new Set<string>();
  const client = {
    async describeObject(sobject: string) {
      if (sobject === "ProductAttributeDefinition") {
        return { name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("DefaultValue", "string")] };
      }
      throw new Error(`unexpected describeObject(${sobject})`);
    },
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE Id = ")) {
        const m = soql.match(/WHERE Id = '([^']+)'/);
        return m && createdIds.has(m[1]) ? { totalSize: 1, done: true, records: [{ Id: m[1] }] } : { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        if (soql.includes("pad-memory")) {
          return { totalSize: 1, done: true, records: [{ Id: "cond-memory-existing", ProductAttributeDefinitionId: "pad-memory", StringValue: "RAM 8GB", Product2Id: PRODUCT_A }] };
        }
        return { totalSize: 0, done: true, records: [] }; // Graphics condition does not exist yet
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id IN")) {
        return { totalSize: 2, done: true, records: [{ Id: "pad-memory", DefaultValue: "RAM 8GB" }, { Id: "pad-graphics", DefaultValue: "Integrated Graphics" }] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE") && soql.includes("IsPriceImpacting = true")) return { totalSize: 0, done: true, records: [] };
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      created.push(payload);
      createdIds.add("cond-graphics-new");
      return { id: "cond-graphics-new" };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: [], ruleProductId: PRODUCT_A },
  ];
  const result = await createAttributeAdjustmentConditions(client, schema, { product: { id: PRODUCT_A, name: "Laptop" } }, contexts, plans, []);

  // Memory (varying, reused) + Graphics (baseline-default, created) = complete 2-attribute set.
  assert.equal(result.reusedConditionIds.length, 1);
  assert.equal(result.reusedConditionIds[0], "cond-memory-existing");
  assert.equal(result.conditionIds.length, 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].Product2Id, PRODUCT_A, "the newly created condition must carry the same product as the reused one");
  assert.equal(plans[0].conditionIds.length, 2, "final condition set for this rule must be complete: 1 reused + 1 created");
});

/* ── Direct unit coverage for the new validator itself. ── */
test("validateAttributePricingProductConsistency reports valid=true when Rule/conditions all agree with the expected product", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }]);
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        return { totalSize: 1, done: true, records: [{ Id: "cond-1", ProductAttributeDefinitionId: "pad-memory", StringValue: "RAM 8GB", Product2Id: PRODUCT_A }] };
      }
      if (soql.includes("SELECT Product2Id FROM AttributeBasedAdjRule")) return { totalSize: 1, done: true, records: [{ Product2Id: PRODUCT_A }] };
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result = await validateAttributePricingProductConsistency(client, schema, contexts, "rule-1", PRODUCT_A, ["Memory"]);
  assert.equal(result.valid, true);
  assert.equal(result.mismatches.length, 0);
});

test("validateAttributePricingProductConsistency reports the exact mismatching condition(s), never just a boolean", async () => {
  const schema = buildFullSchema();
  const contexts = buildContexts([{ name: "Memory", padId: "pad-memory" }]);
  const client = {
    async query(soql: string) {
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        return { totalSize: 1, done: true, records: [{ Id: "cond-wrong", ProductAttributeDefinitionId: "pad-memory", StringValue: "RAM 8GB", Product2Id: PRODUCT_B }] };
      }
      if (soql.includes("SELECT Product2Id FROM AttributeBasedAdjRule")) return { totalSize: 1, done: true, records: [{ Product2Id: PRODUCT_A }] };
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result = await validateAttributePricingProductConsistency(client, schema, contexts, "rule-1", PRODUCT_A, ["Memory"]);
  assert.equal(result.valid, false);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].conditionId, "cond-wrong");
  assert.equal(result.mismatches[0].actualProductId, PRODUCT_B);
  assert.equal(result.mismatches[0].expectedProductId, PRODUCT_A);
  assert.equal(result.mismatches[0].attribute, "Memory");
});
