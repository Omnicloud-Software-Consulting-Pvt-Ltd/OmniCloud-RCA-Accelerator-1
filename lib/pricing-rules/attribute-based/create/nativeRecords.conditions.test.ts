/**
 * §Follow-on 39 — regression coverage for the live FIELD_INTEGRITY_EXCEPTION root cause: Salesforce's
 * own documented Attribute-Based Adjustment behavior requires EVERY price-impacting attribute on the
 * product to be represented by a condition on a Rule before that Rule's Adjustment can be created
 * ("Associate all price impacting attributes with the relevant Attribute Adjustment Condition and try
 * again" / "you need to define values for all price-impacting attributes in every adjustment record —
 * even if only one attribute drives the price"). `createAttributeAdjustmentConditions` now builds one
 * condition for the rule's own varying attribute PLUS one baseline-default condition (from the real,
 * documented `ProductAttributeDefinition.DefaultValue` field) for every OTHER price-impacting attribute.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import {
  createAttributeAdjustmentConditions, resolveBaseProductConfiguration, setProductAttributeDefinitionDefaultValue,
  MissingAttributeConfigurationError, type AttributeContext, type AttributeBasedPricingSchema, type AttributeBasedRulePlan,
} from "./nativeRecords";
import type { PricingRulePlanRow } from "../types";

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

  const ruleField = conditionDescribe.fields.find(f => f.name === "AttributeBasedAdjRuleId")!;
  const padField = conditionDescribe.fields.find(f => f.name === "ProductAttributeDefinitionId")!;
  const attrDefField = conditionDescribe.fields.find(f => f.name === "AttributeDefinitionId")!;
  const productField = conditionDescribe.fields.find(f => f.name === "Product2Id")!;
  const operatorField = conditionDescribe.fields.find(f => f.name === "Operator")!;

  return {
    ruleDescribe: { name: "AttributeBasedAdjRule", label: "", labelPlural: "", fields: [], recordTypeInfos: [], urls: {} } as unknown as DescribeResult,
    conditionDescribe,
    abaDescribe: { name: "AttributeBasedAdjustment", label: "", labelPlural: "", fields: [], recordTypeInfos: [], urls: {} } as unknown as DescribeResult,
    ruleProductField: { field: null, candidates: [] },
    ruleScheduleField: { field: null, candidates: [] },
    ruleActiveField: null, ruleEffFromField: null, ruleEffToField: null,
    conditionRuleField: { field: ruleField, candidates: [] },
    conditionPadField: { field: padField, candidates: [] },
    conditionAttrDefField: { field: attrDefField, candidates: [] },
    conditionProductField: { field: productField, candidates: [] },
    conditionOperatorField: operatorField,
    abaProductField: { field: null, candidates: [] },
    abaSellingModelField: { field: null, candidates: [] },
    abaRuleField: { field: null, candidates: [] },
    abaScheduleField: { field: null, candidates: [] },
    abaConditionField: null, abaTypeField: null, abaValueField: null, abaEffFromField: null, abaEffToField: null,
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

interface MockClientOptions {
  padDefaultValues: Record<string, string | null>;
  /** padId -> ProductClassificationAttr Id it references (Priority 2). */
  padClassificationAttrIds?: Record<string, string>;
  /** ProductClassificationAttr Id -> its own DefaultValue (Priority 2). */
  classificationDefaultValues?: Record<string, string | null>;
  /** padId -> the AttributePicklist Id it uses (enables Priority 4). */
  padPicklistIds?: Record<string, string>;
  /** picklistId -> every AttributePicklistValue row's raw value (Priority 4 requires exactly one). */
  picklistValues?: Record<string, string[]>;
  existingConditionKeys?: Set<string>;
  onCreate?: (payload: Record<string, unknown>) => void;
}

function buildMockClient(opts: MockClientOptions): SalesforceClient {
  let createCounter = 0;
  const existing = opts.existingConditionKeys ?? new Set<string>();
  const createdIds = new Set<string>();
  const hasClassification = !!opts.padClassificationAttrIds;
  const hasPicklist = !!opts.padPicklistIds;
  const client = {
    async describeObject(sobject: string) {
      if (sobject === "ProductAttributeDefinition") {
        return {
          name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
          fields: [
            field("Id", "id"),
            field("Product2Id", "reference", { referenceTo: ["Product2"] }),
            field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }),
            field("IsPriceImpacting", "boolean"),
            field("DefaultValue", "string"),
            ...(hasClassification ? [field("ProductClassificationAttributeId", "reference", { referenceTo: ["ProductClassificationAttr"] })] : []),
            ...(hasPicklist ? [field("AttributePicklistId", "reference", { referenceTo: ["AttributePicklist"] })] : []),
          ],
        };
      }
      if (sobject === "ProductClassificationAttr" && hasClassification) {
        return {
          name: "ProductClassificationAttr", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
          fields: [field("Id", "id"), field("DefaultValue", "string")],
        };
      }
      if (sobject === "AttributeDefinition") {
        return { name: "AttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id")] };
      }
      throw new Error(`unexpected describeObject(${sobject})`);
    },
    async query(soql: string) {
      if (soql.includes("FROM ProductAttributeDefinition WHERE") && soql.includes("IsPriceImpacting = true") && !soql.includes(" IN (")) {
        // Sanity-check "all price-impacting attributes for the product" query.
        return { totalSize: Object.keys(opts.padDefaultValues).length, done: true, records: Object.keys(opts.padDefaultValues).map(id => ({ Id: id })) };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id =")) {
        // resolveAttributePicklistId's own per-Id lookup.
        const idMatch = soql.match(/WHERE Id = '([^']+)'/);
        const padId = idMatch?.[1];
        const picklistId = padId ? opts.padPicklistIds?.[padId] : undefined;
        return { totalSize: picklistId ? 1 : 0, done: true, records: picklistId ? [{ AttributePicklistId: picklistId }] : [] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id IN")) {
        return {
          totalSize: 0, done: true,
          records: Object.entries(opts.padDefaultValues).map(([id, dv]) => ({
            Id: id, DefaultValue: dv, ProductClassificationAttributeId: opts.padClassificationAttrIds?.[id] ?? null,
          })),
        };
      }
      if (soql.includes("FROM ProductClassificationAttr WHERE Id IN")) {
        const ids = [...new Set(Object.values(opts.padClassificationAttrIds ?? {}))];
        return { totalSize: ids.length, done: true, records: ids.map(id => ({ Id: id, DefaultValue: opts.classificationDefaultValues?.[id] ?? null })) };
      }
      if (soql.includes("FROM AttributePicklistValue WHERE PicklistId")) {
        const idMatch = soql.match(/PicklistId = '([^']+)'/);
        const picklistId = idMatch?.[1];
        const values = (picklistId ? opts.picklistValues?.[picklistId] : undefined) ?? [];
        return { totalSize: values.length, done: true, records: values.map((v, i) => ({ Id: `apv-${picklistId}-${i}`, Value: v })) };
      }
      if (soql.includes("FROM AttributeAdjustmentCondition WHERE")) {
        // Read-back verification after a create (guardedCreate -> verifyRecordExists).
        const idMatch = soql.match(/WHERE Id = '([^']+)'/);
        if (idMatch && createdIds.has(idMatch[1])) {
          return { totalSize: 1, done: true, records: [{ Id: idMatch[1] }] };
        }
        // The real preflight existence check (findExistingAttributeAdjustmentCondition).
        const match = [...existing].find(key => soql.includes(key));
        return { totalSize: match ? 1 : 0, done: true, records: match ? [{ Id: `existing-${match}`, StringValue: "x", Product2Id: "prod-1" }] : [] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      opts.onCreate?.(payload);
      createCounter++;
      const id = `cond-${createCounter}`;
      createdIds.add(id);
      return { id };
    },
    logDebug() { /* no-op */ },
  };
  return client as unknown as SalesforceClient;
}

test("TEST — every OTHER price-impacting attribute gets its own baseline-default condition, using the real ProductAttributeDefinition.DefaultValue", async () => {
  const schema = buildSchema();
  const contexts = buildContexts([
    { name: "Memory", padId: "pad-memory", attrDefId: "ad-memory" },
    { name: "Graphics", padId: "pad-graphics", attrDefId: "ad-graphics" },
    { name: "Storage", padId: "pad-storage", attrDefId: "ad-storage" },
  ]);
  const client = buildMockClient({
    padDefaultValues: { "pad-memory": "RAM 8GB", "pad-graphics": "Intel Iris Xe Graphics", "pad-storage": "SSD Hard Drive 256GB" },
  });
  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: [], ruleProductId: null },
  ];
  const result = await createAttributeAdjustmentConditions(client, schema, { product: { id: "prod-1", name: "Laptop" } }, contexts, plans, []);
  assert.equal(result.conditionIds.length, 3, "1 varying (Memory) + 2 baseline-default (Graphics, Storage) = 3 new conditions");
  assert.equal(plans[0].conditionIds.length, 3);
});

test("TEST — an attribute with NO DefaultValue set is a hard failure naming that attribute, never a guessed value", async () => {
  const schema = buildSchema();
  const contexts = buildContexts([
    { name: "Memory", padId: "pad-memory", attrDefId: "ad-memory" },
    { name: "Storage", padId: "pad-storage", attrDefId: "ad-storage" },
  ]);
  let createCalls = 0;
  const client = buildMockClient({
    padDefaultValues: { "pad-memory": "RAM 8GB", "pad-storage": null }, // Storage has no Default Value
    onCreate: () => { createCalls++; },
  });
  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: [], ruleProductId: null },
  ];
  await assert.rejects(
    () => createAttributeAdjustmentConditions(client, schema, { product: { id: "prod-1", name: "Laptop" } }, contexts, plans, []),
    (err: Error) => {
      assert.ok(err.message.includes("Storage"));
      assert.ok(err.message.includes("effective value"));
      assert.equal(createCalls, 0, "no Salesforce write may happen at all when any price-impacting attribute is unresolved — no partial creation");
      return true;
    },
  );
});

// §Priority 2 — Graphics has no product-level DefaultValue, but its ProductAttributeDefinition
// references a ProductClassificationAttr that DOES have one — the exact live "Graphics" scenario.
test("TEST — Priority 2: no product-specific Default Value, but a real classification-inherited Default Value exists -> used, never a hard failure", async () => {
  const schema = buildSchema();
  const contexts = buildContexts([
    { name: "Memory", padId: "pad-memory", attrDefId: "ad-memory" },
    { name: "Graphics", padId: "pad-graphics", attrDefId: "ad-graphics" },
  ]);
  const client = buildMockClient({
    padDefaultValues: { "pad-memory": "RAM 8GB", "pad-graphics": null },
    padClassificationAttrIds: { "pad-graphics": "pca-graphics" },
    classificationDefaultValues: { "pca-graphics": "Intel Iris Xe Graphics" },
  });
  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: [], ruleProductId: null },
  ];
  const result = await createAttributeAdjustmentConditions(client, schema, { product: { id: "prod-1", name: "Laptop" } }, contexts, plans, []);
  assert.equal(result.conditionIds.length, 2, "Memory (varying) + Graphics (classification-default baseline)");
});

// §Priority 4 — Processor has neither a product-level nor classification-level default, but this
// product's Processor picklist genuinely has exactly one configured value — Salesforce's own data
// proves there is no ambiguity, so it's safe to use (never a "pick the first of several" guess).
test("TEST — Priority 4: no Default Value anywhere, but exactly one configured picklist value exists -> used", async () => {
  const schema = buildSchema();
  const contexts = buildContexts([
    { name: "Memory", padId: "pad-memory", attrDefId: "ad-memory" },
    { name: "Processor", padId: "pad-processor", attrDefId: "ad-processor" },
  ]);
  const client = buildMockClient({
    padDefaultValues: { "pad-memory": "RAM 8GB", "pad-processor": null },
    padPicklistIds: { "pad-processor": "picklist-processor" },
    picklistValues: { "picklist-processor": ["i7-CPU 4.7GHz"] },
  });
  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: [], ruleProductId: null },
  ];
  const result = await createAttributeAdjustmentConditions(client, schema, { product: { id: "prod-1", name: "Laptop" } }, contexts, plans, []);
  assert.equal(result.conditionIds.length, 2, "Memory (varying) + Processor (single-configured-value baseline)");
});

// §Priority 4 must NEVER fire when there is genuine ambiguity (more than one configured value) —
// this is the exact "never choose the first picklist value arbitrarily" case.
test("TEST — Priority 4 does NOT apply when multiple picklist values exist -> still a hard failure, never picks the first one", async () => {
  const schema = buildSchema();
  const contexts = buildContexts([
    { name: "Memory", padId: "pad-memory", attrDefId: "ad-memory" },
    { name: "Graphics", padId: "pad-graphics", attrDefId: "ad-graphics" },
  ]);
  let createCalls = 0;
  const client = buildMockClient({
    padDefaultValues: { "pad-memory": "RAM 8GB", "pad-graphics": null },
    padPicklistIds: { "pad-graphics": "picklist-graphics" },
    picklistValues: { "picklist-graphics": ["Intel Iris Xe Graphics", "MSI Gaming GeForce RTX 3060"] },
    onCreate: () => { createCalls++; },
  });
  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: [], ruleProductId: null },
  ];
  await assert.rejects(
    () => createAttributeAdjustmentConditions(client, schema, { product: { id: "prod-1", name: "Laptop" } }, contexts, plans, []),
    (err: Error) => {
      assert.ok(err.message.includes("Graphics"));
      assert.equal(createCalls, 0);
      return true;
    },
  );
});

test("TEST — an existing baseline-default condition on this Rule is reused, never duplicated", async () => {
  const schema = buildSchema();
  const contexts = buildContexts([
    { name: "Memory", padId: "pad-memory", attrDefId: "ad-memory" },
    { name: "Graphics", padId: "pad-graphics", attrDefId: "ad-graphics" },
  ]);
  let createCalls = 0;
  const client = buildMockClient({
    padDefaultValues: { "pad-memory": "RAM 8GB", "pad-graphics": "Intel Iris Xe Graphics" },
    existingConditionKeys: new Set(["rule-1' AND ProductAttributeDefinitionId = 'pad-graphics"]),
    onCreate: () => { createCalls++; },
  });
  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: [], ruleProductId: null },
  ];
  const result = await createAttributeAdjustmentConditions(client, schema, { product: { id: "prod-1", name: "Laptop" } }, contexts, plans, []);
  assert.equal(result.reusedConditionIds.length, 1, "the Graphics baseline-default condition already existed and must be reused");
  assert.equal(createCalls, 1, "only Memory's own condition should be created — Graphics was reused");
});

// §Follow-on 41 — `resolveBaseProductConfiguration` is now the single, exported, canonically-named
// resolver (per the user's exact requested shape: `{ productId, attributes: { name: { ... } } }`) that
// every condition-building path reads from. Tested directly, not just indirectly through
// `createAttributeAdjustmentConditions`.
test("TEST — resolveBaseProductConfiguration returns the exact requested shape, one entry per price-impacting attribute, each carrying its resolution source", async () => {
  const contexts = buildContexts([
    { name: "Memory", padId: "pad-memory", attrDefId: "ad-memory" },
    { name: "Graphics", padId: "pad-graphics", attrDefId: "ad-graphics" },
  ]);
  const client = buildMockClient({
    padDefaultValues: { "pad-memory": "RAM 8GB", "pad-graphics": null },
    padClassificationAttrIds: { "pad-graphics": "pca-graphics" },
    classificationDefaultValues: { "pca-graphics": "Intel Iris Xe Graphics" },
  });
  const config = await resolveBaseProductConfiguration(client, "prod-1", [...contexts.entries()]);
  assert.equal(config.productId, "prod-1");
  assert.equal(config.attributes.Memory.value, "RAM 8GB");
  assert.equal(config.attributes.Memory.source, "PRODUCT_DEFAULT");
  assert.equal(config.attributes.Memory.attributeDefinitionId, "ad-memory");
  assert.equal(config.attributes.Graphics.value, "Intel Iris Xe Graphics");
  assert.equal(config.attributes.Graphics.source, "CLASSIFICATION_DEFAULT");
});

// §Follow-on 42 — the structured failure path: createAttributeAdjustmentConditions must throw
// MissingAttributeConfigurationError (never a plain Error) when unresolved, carrying the REAL
// candidate Salesforce values for the missing attribute (never invented) plus the full resolved list
// so a UI can render the complete ✓/⚠ checklist.
test("TEST — Follow-on 42: unresolved attribute throws MissingAttributeConfigurationError with real candidateValues and the resolved checklist", async () => {
  const schema = buildSchema();
  const contexts = buildContexts([
    { name: "Memory", padId: "pad-memory", attrDefId: "ad-memory" },
    { name: "Graphics", padId: "pad-graphics", attrDefId: "ad-graphics" },
  ]);
  const client = buildMockClient({
    padDefaultValues: { "pad-memory": "RAM 8GB", "pad-graphics": null },
    padPicklistIds: { "pad-graphics": "picklist-graphics" },
    picklistValues: { "picklist-graphics": ["Intel Iris Xe Graphics", "MSI Gaming GeForce RTX 3060"] },
  });
  const plans: AttributeBasedRulePlan[] = [
    { row: buildRow("Memory", "RAM 8GB"), ctx: contexts.get("Memory")!, ruleId: "rule-1", reusedExisting: false, conditionIds: [], ruleProductId: null },
  ];
  let caught: unknown;
  try {
    await createAttributeAdjustmentConditions(client, schema, { product: { id: "prod-1", name: "Laptop" } }, contexts, plans, []);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof MissingAttributeConfigurationError, "must throw the structured error type, never a plain Error");
  const err = caught as MissingAttributeConfigurationError;
  assert.equal(err.missingAttributes.length, 1);
  assert.equal(err.missingAttributes[0].attributeName, "Graphics");
  assert.equal(err.missingAttributes[0].productId, "prod-1");
  assert.deepEqual(
    err.missingAttributes[0].candidateValues.map(c => c.value).sort(),
    ["Intel Iris Xe Graphics", "MSI Gaming GeForce RTX 3060"],
    "candidateValues must be the REAL Salesforce rows found, never invented or omitted",
  );
  assert.equal(err.resolvedAttributes.length, 1);
  assert.equal(err.resolvedAttributes[0].attributeName, "Memory");
  assert.equal(err.resolvedAttributes[0].value, "RAM 8GB");
  assert.equal(err.resolvedAttributes[0].source, "PRODUCT_DEFAULT");
});

// §Follow-on 42 — setProductAttributeDefinitionDefaultValue: the remediation write path. Must read
// back and verify before ever reporting success; must report failure (never a false success) if the
// read-back doesn't confirm the exact value that was sent.
function buildMockUpdateClient(opts: { updatedValue?: string | null; updateShouldFail?: boolean }): SalesforceClient & { updateCalls: { id: string; fields: Record<string, unknown> }[] } {
  const updateCalls: { id: string; fields: Record<string, unknown> }[] = [];
  let persistedValue: string | null = null;
  const client = {
    updateCalls,
    async describeObject(sobject: string) {
      if (sobject !== "ProductAttributeDefinition") throw new Error(`unexpected describeObject(${sobject})`);
      return { name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields: [field("Id", "id"), field("DefaultValue", "string")] };
    },
    async updateRecord(sobject: string, id: string, fields: Record<string, unknown>) {
      updateCalls.push({ id, fields });
      if (opts.updateShouldFail) throw new Error("Salesforce rejected the update.");
      persistedValue = "updatedValue" in opts ? (opts.updatedValue ?? null) : (fields.DefaultValue as string);
    },
    async query(soql: string) {
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id =")) {
        return { totalSize: 1, done: true, records: [{ Id: "pad-graphics", DefaultValue: persistedValue }] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  };
  return client as unknown as SalesforceClient & { updateCalls: { id: string; fields: Record<string, unknown> }[] };
}

test("TEST — Follow-on 42: setProductAttributeDefinitionDefaultValue succeeds only when the read-back confirms the exact value written", async () => {
  const client = buildMockUpdateClient({});
  const result = await setProductAttributeDefinitionDefaultValue(client, "pad-graphics", "Integrated Graphics");
  assert.equal(result.success, true);
  assert.equal(result.verifiedValue, "Integrated Graphics");
  assert.equal(client.updateCalls.length, 1);
  assert.equal(client.updateCalls[0].id, "pad-graphics");
  assert.equal(client.updateCalls[0].fields.DefaultValue, "Integrated Graphics");
});

test("TEST — Follow-on 42: setProductAttributeDefinitionDefaultValue reports failure (never a false success) when the read-back does not confirm the write", async () => {
  const client = buildMockUpdateClient({ updatedValue: "SomethingElse" });
  const result = await setProductAttributeDefinitionDefaultValue(client, "pad-graphics", "Integrated Graphics");
  assert.equal(result.success, false);
  assert.ok(result.error?.includes("Integrated Graphics"));
});

test("TEST — Follow-on 42: setProductAttributeDefinitionDefaultValue reports failure when the update call itself throws", async () => {
  const client = buildMockUpdateClient({ updateShouldFail: true });
  const result = await setProductAttributeDefinitionDefaultValue(client, "pad-graphics", "Integrated Graphics");
  assert.equal(result.success, false);
  assert.ok(result.error);
});
