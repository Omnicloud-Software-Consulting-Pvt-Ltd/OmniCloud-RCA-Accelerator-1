/**
 * §Live-org fix ("Save Default Value" button does nothing) — regression coverage for
 * `setEffectiveAttributeDefaultValue`, the remediation-endpoint entry point. Before this fix, the only
 * available function (`setProductAttributeDefinitionDefaultValue`) could only UPDATE an existing
 * ProductAttributeDefinition — for a purely Product-Classification-inherited attribute with
 * `productAttributeDefinitionId: null` (e.g. Desktop's Graphics/Storage/Screen Size), the frontend's
 * `handleSave` silently no-opped before ever reaching the network, so the button appeared clickable but
 * had zero effect. This function resolves which path is valid and either updates the existing record or
 * creates a new, product-scoped override — never a write to the shared ProductClassificationAttr.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import { setEffectiveAttributeDefaultValue } from "./nativeRecords";

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

const PAD_DESCRIBE_WITH_OVERRIDE_LINK: DescribeResult = {
  name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [
    field("Id", "id"), field("Product2Id", "reference", { referenceTo: ["Product2"] }),
    field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }),
    field("DefaultValue", "string"),
    field("ProductClassificationAttributeId", "reference", { referenceTo: ["ProductClassificationAttr"] }),
  ],
} as unknown as DescribeResult;

const PAD_DESCRIBE_NO_OVERRIDE_LINK: DescribeResult = {
  name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [
    field("Id", "id"), field("Product2Id", "reference", { referenceTo: ["Product2"] }),
    field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }),
    field("DefaultValue", "string"),
  ],
} as unknown as DescribeResult;

let instanceUrlCounter = 0;
function uniqueInstanceUrl(): string {
  instanceUrlCounter += 1;
  return `https://test-org-edv-${instanceUrlCounter}.my.salesforce.com`;
}

test("TEST 1 (Laptop/Monitor-style) — productAttributeDefinitionId present: updates the existing record (unchanged path), never creates anything", async () => {
  const mutationLog: { op: string; object: string }[] = [];
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAD_DESCRIBE_WITH_OVERRIDE_LINK; },
    async updateRecord(objectName: string) { mutationLog.push({ op: "update", object: objectName }); return { success: true }; },
    async createRecord() { throw new Error("must never create when an existing record can be updated"); },
    async query(soql: string) {
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id = '")) {
        return { totalSize: 1, done: true, records: [{ Id: "pad-color", DefaultValue: "Black" }] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result = await setEffectiveAttributeDefaultValue(client, {
    productAttributeDefinitionId: "pad-color", productId: null, attributeDefinitionId: null, productClassificationAttrId: null, value: "Black",
  });
  assert.equal(result.success, true);
  assert.equal(result.verifiedValue, "Black");
  assert.equal(result.productAttributeDefinitionId, "pad-color");
  assert.equal(mutationLog.length, 1);
  assert.equal(mutationLog[0].op, "update");
});

test("TEST 2 (Desktop repro) — no productAttributeDefinitionId, purely INHERITED attribute: creates a NEW product-scoped override with DefaultValue set; never touches ProductClassificationAttr", async () => {
  const mutationLog: { op: string; object: string; payload?: Record<string, unknown> }[] = [];
  const createdIds = new Set<string>();
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAD_DESCRIBE_WITH_OVERRIDE_LINK; },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      mutationLog.push({ op: "create", object: objectName, payload });
      const id = "new-override-graphics";
      createdIds.add(id);
      return { id };
    },
    async updateRecord(objectName: string) {
      mutationLog.push({ op: "update", object: objectName });
      if (objectName === "ProductClassificationAttr") throw new Error("TEST FAILURE: must never write to the shared ProductClassificationAttr record");
      return { success: true };
    },
    async query(soql: string) {
      if (soql.includes("FROM ProductAttributeDefinition WHERE Product2Id") && soql.includes("AttributeDefinitionId")) {
        return { totalSize: 0, done: true, records: [] }; // idempotency lookup: nothing exists yet
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id = '")) {
        const id = soql.match(/WHERE Id = '([^']+)'/)?.[1];
        if (id && createdIds.has(id)) return { totalSize: 1, done: true, records: [{ Id: id, DefaultValue: "MSI Gaming GeForce RTX 3060" }] };
        return { totalSize: 0, done: true, records: [] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result = await setEffectiveAttributeDefaultValue(client, {
    productAttributeDefinitionId: null, productId: "01tDESKTOP0000001", attributeDefinitionId: "ad-graphics", productClassificationAttrId: "pca-graphics",
    value: "MSI Gaming GeForce RTX 3060",
  });

  assert.equal(result.success, true);
  assert.equal(result.verifiedValue, "MSI Gaming GeForce RTX 3060");
  assert.equal(result.productAttributeDefinitionId, "new-override-graphics");
  assert.equal(mutationLog.length, 1, "exactly one mutation: the new override create");
  assert.equal(mutationLog[0].op, "create");
  assert.equal(mutationLog[0].object, "ProductAttributeDefinition");
  assert.equal(mutationLog[0].payload?.Product2Id, "01tDESKTOP0000001");
  assert.equal(mutationLog[0].payload?.AttributeDefinitionId, "ad-graphics");
  assert.equal(mutationLog[0].payload?.ProductClassificationAttributeId, "pca-graphics");
  assert.equal(mutationLog[0].payload?.DefaultValue, "MSI Gaming GeForce RTX 3060");
});

test("TEST 3 — read-back does not confirm the new override's DefaultValue: reports failure, never a false success", async () => {
  const createdIds = new Set<string>();
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAD_DESCRIBE_WITH_OVERRIDE_LINK; },
    async createRecord() {
      const id = "new-override-mismatch";
      createdIds.add(id);
      return { id };
    },
    async query(soql: string) {
      if (soql.includes("FROM ProductAttributeDefinition WHERE Product2Id") && soql.includes("AttributeDefinitionId")) {
        return { totalSize: 0, done: true, records: [] }; // idempotency lookup: nothing exists yet
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id = '")) {
        const id = soql.match(/WHERE Id = '([^']+)'/)?.[1];
        if (id && createdIds.has(id)) return { totalSize: 1, done: true, records: [{ Id: id, DefaultValue: "SOMETHING ELSE" }] };
        return { totalSize: 0, done: true, records: [] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result = await setEffectiveAttributeDefaultValue(client, {
    productAttributeDefinitionId: null, productId: "01tPRODUCT0000001", attributeDefinitionId: "ad-storage", productClassificationAttrId: "pca-storage", value: "1TB SSD",
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /did not confirm/);
});

test("TEST 4 — neither an existing record nor a resolvable classification source: fails immediately with a precise message, zero mutations (never a silent no-op)", async () => {
  let mutationCount = 0;
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAD_DESCRIBE_WITH_OVERRIDE_LINK; },
    async createRecord() { mutationCount++; throw new Error("must never create"); },
    async updateRecord() { mutationCount++; throw new Error("must never update"); },
    async query() { throw new Error("must never query"); },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result = await setEffectiveAttributeDefaultValue(client, {
    productAttributeDefinitionId: null, productId: null, attributeDefinitionId: null, productClassificationAttrId: null, value: "Anything",
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not resolvable as a Product Classification-inherited attribute/);
  assert.equal(mutationCount, 0);
});

test("TEST 5 — org's ProductAttributeDefinition schema has no override-link field: fails with a precise message, never creates an ambiguous record", async () => {
  let mutationCount = 0;
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAD_DESCRIBE_NO_OVERRIDE_LINK; },
    async createRecord() { mutationCount++; throw new Error("must never create"); },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result = await setEffectiveAttributeDefaultValue(client, {
    productAttributeDefinitionId: null, productId: "01tPRODUCT0000002", attributeDefinitionId: "ad-screensize", productClassificationAttrId: "pca-screensize", value: "15 Inch",
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /ProductClassificationAttr override-link reference field/);
  assert.equal(mutationCount, 0);
});

test("TEST 6 — arbitrary, unusually-shaped Salesforce Ids throughout prove nothing is hardcoded", async () => {
  const createdIds = new Set<string>();
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAD_DESCRIBE_WITH_OVERRIDE_LINK; },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      assert.equal(payload.Product2Id, "###weird-product###");
      assert.equal(payload.AttributeDefinitionId, "weird-attrdef-id");
      assert.equal(payload.ProductClassificationAttributeId, "weird-pca-id");
      const id = "weird-new-override-id";
      createdIds.add(id);
      return { id };
    },
    async query(soql: string) {
      if (soql.includes("FROM ProductAttributeDefinition WHERE Product2Id") && soql.includes("AttributeDefinitionId")) {
        assert.ok(soql.includes("###weird-product###") && soql.includes("weird-attrdef-id"));
        return { totalSize: 0, done: true, records: [] }; // idempotency lookup: nothing exists yet
      }
      const id = soql.match(/WHERE Id = '([^']+)'/)?.[1];
      if (id && createdIds.has(id)) return { totalSize: 1, done: true, records: [{ Id: id, DefaultValue: "Weird Value" }] };
      return { totalSize: 0, done: true, records: [] };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result = await setEffectiveAttributeDefaultValue(client, {
    productAttributeDefinitionId: null, productId: "###weird-product###", attributeDefinitionId: "weird-attrdef-id", productClassificationAttrId: "weird-pca-id", value: "Weird Value",
  });
  assert.equal(result.success, true);
  assert.equal(result.productAttributeDefinitionId, "weird-new-override-id");
});

test("TEST 7 (idempotency) — a product-scoped record for this exact Product2+AttributeDefinition pair already exists (e.g. a prior click, or created by ensurePriceImpactingAttributes earlier in the same run): updates it, never creates a duplicate", async () => {
  const mutationLog: { op: string; object: string }[] = [];
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return PAD_DESCRIBE_WITH_OVERRIDE_LINK; },
    async createRecord() { throw new Error("must never create — an existing record was found via the idempotent lookup"); },
    async updateRecord(objectName: string, id: string) { mutationLog.push({ op: "update", object: objectName }); assert.equal(id, "existing-pad-graphics"); return { success: true }; },
    async query(soql: string) {
      if (soql.includes("FROM ProductAttributeDefinition WHERE Product2Id") && soql.includes("AttributeDefinitionId")) {
        return { totalSize: 1, done: true, records: [{ Id: "existing-pad-graphics" }] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id = '")) {
        return { totalSize: 1, done: true, records: [{ Id: "existing-pad-graphics", DefaultValue: "MSI Gaming GeForce RTX 3060" }] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result = await setEffectiveAttributeDefaultValue(client, {
    productAttributeDefinitionId: null, productId: "01tDESKTOP0000001", attributeDefinitionId: "ad-graphics", productClassificationAttrId: "pca-graphics",
    value: "MSI Gaming GeForce RTX 3060",
  });
  assert.equal(result.success, true);
  assert.equal(result.productAttributeDefinitionId, "existing-pad-graphics");
  assert.equal(mutationLog.length, 1);
  assert.equal(mutationLog[0].op, "update");
});

test("TEST 8 — Name is resolved dynamically from AttributeDefinition's own authoritative Name (never hardcoded, never sourced from prompt/UI text) only when this org's PAD schema requires a createable Name field", async () => {
  const padDescribeWithName: DescribeResult = {
    name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
    fields: [
      field("Id", "id"), field("Name", "string", { nillable: false }),
      field("Product2Id", "reference", { referenceTo: ["Product2"] }),
      field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }),
      field("DefaultValue", "string"),
      field("ProductClassificationAttributeId", "reference", { referenceTo: ["ProductClassificationAttr"] }),
    ],
  } as unknown as DescribeResult;
  const createdIds = new Set<string>();
  let capturedPayload: Record<string, unknown> | undefined;
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return padDescribeWithName; },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      capturedPayload = payload;
      const id = "new-override-screensize";
      createdIds.add(id);
      return { id };
    },
    async query(soql: string) {
      if (soql.includes("FROM ProductAttributeDefinition WHERE Product2Id") && soql.includes("AttributeDefinitionId")) {
        return { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM AttributeDefinition WHERE Id = '")) {
        // The ONLY source of the Name value — never the prompt, never a client-supplied string.
        return { totalSize: 1, done: true, records: [{ Id: "ad-screensize", Name: "Screen Size" }] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id = '")) {
        return { totalSize: 1, done: true, records: [{ Id: "new-override-screensize", DefaultValue: "13 Inch" }] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result = await setEffectiveAttributeDefaultValue(client, {
    productAttributeDefinitionId: null, productId: "01tDESKTOP0000001", attributeDefinitionId: "ad-screensize", productClassificationAttrId: "pca-screensize", value: "13 Inch",
  });
  assert.equal(result.success, true);
  assert.equal(capturedPayload?.Name, "Screen Size", "Name must be sourced from AttributeDefinition's own real Name, resolved fresh via the verified attributeDefinitionId");
});

test("TEST 9 — the new override explicitly preserves IsPriceImpacting=true (every attribute reaching this remediation flow is already confirmed price-impacting; a brand-new record must not silently regress that)", async () => {
  const padDescribeWithPriceImpacting: DescribeResult = {
    name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
    fields: [
      field("Id", "id"), field("Product2Id", "reference", { referenceTo: ["Product2"] }),
      field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }),
      field("DefaultValue", "string"), field("IsPriceImpacting", "boolean"),
      field("ProductClassificationAttributeId", "reference", { referenceTo: ["ProductClassificationAttr"] }),
    ],
  } as unknown as DescribeResult;
  const createdIds = new Set<string>();
  let capturedPayload: Record<string, unknown> | undefined;
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeObject() { return padDescribeWithPriceImpacting; },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      capturedPayload = payload;
      const id = "new-override-storage";
      createdIds.add(id);
      return { id };
    },
    async query(soql: string) {
      if (soql.includes("FROM ProductAttributeDefinition WHERE Product2Id") && soql.includes("AttributeDefinitionId")) {
        return { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id = '")) {
        return { totalSize: 1, done: true, records: [{ Id: "new-override-storage", DefaultValue: "1TB SSD" }] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const result = await setEffectiveAttributeDefaultValue(client, {
    productAttributeDefinitionId: null, productId: "01tDESKTOP0000001", attributeDefinitionId: "ad-storage", productClassificationAttrId: "pca-storage", value: "1TB SSD",
  });
  assert.equal(result.success, true);
  assert.equal(capturedPayload?.IsPriceImpacting, true);
});
