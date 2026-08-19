/**
 * §Live-org fix (Desktop) — proves the CREATE-time pipeline (resolveAttributeContexts,
 * resolveAllPriceImpactingAttributeNames, resolveBaseProductConfiguration — everything feeding
 * AttributeBasedAdjRule/Condition/Adjustment creation) sees the SAME effective attribute set as the
 * analyze-time `discoverAttributes.ts`, via the shared `resolveProductClassificationInheritance`
 * resolver. Before this fix, these three functions ONLY ever queried `ProductAttributeDefinition`
 * directly by Product2Id — for a product with zero direct/overridden records (Salesforce's own
 * "Overridden Inherited Attributes = 0"), they would have silently resolved `isPriceImpacting: null`,
 * an empty price-impacting attribute set, and no baseline default value, for an attribute that is
 * genuinely applicable (and price-impacting) purely through Product Classification.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import { resolveAttributeContexts, resolveAllPriceImpactingAttributeNames, resolveBaseProductConfiguration } from "./nativeRecords";

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

const AD_DESCRIBE: DescribeResult = {
  name: "AttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [field("Id", "id"), field("Name", "string"), field("DataType", "picklist")],
} as unknown as DescribeResult;

const PAD_DESCRIBE_NO_CLASSIFICATION_LINK: DescribeResult = {
  name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [
    field("Id", "id"), field("Product2Id", "reference", { referenceTo: ["Product2"] }),
    field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }),
    field("IsPriceImpacting", "boolean"), field("DataType", "picklist"), field("DefaultValue", "string"),
  ],
} as unknown as DescribeResult;

const PRODUCT2_DESCRIBE: DescribeResult = {
  name: "Product2", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [field("Id", "id"), field("ProductClassificationId", "reference", { referenceTo: ["ProductClassification"] })],
} as unknown as DescribeResult;

const PCA_DESCRIBE: DescribeResult = {
  name: "ProductClassificationAttr", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [
    field("Id", "id"), field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }),
    field("ProductClassificationId", "reference", { referenceTo: ["ProductClassification"] }),
    field("IsPriceImpacting", "boolean"), field("DefaultValue", "string"),
  ],
} as unknown as DescribeResult;

let instanceUrlCounter = 0;
function uniqueInstanceUrl(): string {
  instanceUrlCounter += 1;
  return `https://test-org-native-${instanceUrlCounter}.my.salesforce.com`;
}

/** Desktop-shaped org: "Memory" is applicable to this product PURELY via Product Classification — zero
 * ProductAttributeDefinition rows exist for it at all. */
function buildDesktopClient(): SalesforceClient {
  const classificationId = "0Z6DESKTOPNATIVE001";
  return {
    instanceUrl: uniqueInstanceUrl(),
    async describeSObjects() {
      return { sobjects: [
        { name: "ProductClassification", label: "", labelPlural: "", createable: false, queryable: true },
        { name: "ProductClassificationAttr", label: "", labelPlural: "", createable: false, queryable: true },
      ] };
    },
    async describeObject(name: string) {
      if (name === "AttributeDefinition") return AD_DESCRIBE;
      if (name === "ProductAttributeDefinition") return PAD_DESCRIBE_NO_CLASSIFICATION_LINK;
      if (name === "Product2") return PRODUCT2_DESCRIBE;
      if (name === "ProductClassificationAttr") return PCA_DESCRIBE;
      throw new Error(`unexpected describeObject(${name})`);
    },
    async query(soql: string) {
      if (soql.includes("FROM AttributeDefinition WHERE Name IN")) {
        return { totalSize: 1, done: true, records: [{ Id: "ad-memory", Name: "Memory", DataType: "Picklist" }] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Product2Id")) {
        return { totalSize: 0, done: true, records: [] }; // zero direct/overridden records — the Desktop shape
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE") && soql.includes("IsPriceImpacting = true")) {
        return { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM Product2 WHERE")) {
        return { totalSize: 1, done: true, records: [{ ProductClassificationId: classificationId }] };
      }
      if (soql.includes("FROM ProductClassificationAttr WHERE ProductClassificationId")) {
        return { totalSize: 1, done: true, records: [{ Id: "pca-memory", AttributeDefinitionId: "ad-memory", IsPriceImpacting: true, DefaultValue: "16GB" }] };
      }
      if (soql.includes("FROM ProductClassificationAttr WHERE Id IN")) {
        return { totalSize: 1, done: true, records: [{ Id: "pca-memory", DefaultValue: "16GB" }] };
      }
      if (soql.includes("SELECT Id, Name FROM AttributeDefinition WHERE Id IN")) {
        return { totalSize: 1, done: true, records: [{ Id: "ad-memory", Name: "Memory" }] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}

test("resolveAttributeContexts resolves isPriceImpacting + productClassificationAttrId for a PURELY inherited attribute (no ProductAttributeDefinition record at all)", async () => {
  const client = buildDesktopClient();
  const contexts = await resolveAttributeContexts(client, "01tDESKTOPNATIVE001", ["Memory"]);
  const ctx = contexts.get("Memory")!;
  assert.equal(ctx.attributeDefinitionId, "ad-memory", "AttributeDefinitionId is always resolvable via the global object, regardless of inheritance");
  assert.equal(ctx.productAttributeDefinitionId, null, "no product-level record exists for this attribute");
  assert.equal(ctx.isPriceImpacting, true, "must fall back to the classification-level flag instead of staying null");
  assert.equal(ctx.productClassificationAttrId, "pca-memory");
});

test("resolveAllPriceImpactingAttributeNames includes a classification-inherited price-impacting attribute even when the direct ProductAttributeDefinition query returns zero rows", async () => {
  const client = buildDesktopClient();
  const names = await resolveAllPriceImpactingAttributeNames(client, "01tDESKTOPNATIVE001");
  assert.deepEqual(names, ["Memory"]);
});

test("resolveBaseProductConfiguration resolves a real baseline DefaultValue for a purely inherited attribute directly from ProductClassificationAttr (no ProductAttributeDefinition-mediated link needed)", async () => {
  const client = buildDesktopClient();
  const contexts = await resolveAttributeContexts(client, "01tDESKTOPNATIVE001", ["Memory"]);
  const config = await resolveBaseProductConfiguration(client, "01tDESKTOPNATIVE001", [...contexts.entries()]);
  const memory = config.attributes.Memory;
  assert.equal(memory.value, "16GB");
  assert.equal(memory.source, "CLASSIFICATION_DEFAULT");
});

test("regression: a Laptop/Monitor-style product with ONLY direct ProductAttributeDefinition records (no classification at all) behaves exactly as before", async () => {
  const productId = "01tLAPTOPNATIVE0001";
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeSObjects() {
      return { sobjects: [] }; // no ProductClassification/ProductClassificationAttr on this org at all
    },
    async describeObject(name: string) {
      if (name === "AttributeDefinition") return AD_DESCRIBE;
      if (name === "ProductAttributeDefinition") return PAD_DESCRIBE_NO_CLASSIFICATION_LINK;
      throw new Error(`unexpected describeObject(${name})`);
    },
    async query(soql: string) {
      if (soql.includes("FROM AttributeDefinition WHERE Name IN")) {
        return { totalSize: 1, done: true, records: [{ Id: "ad-color", Name: "Color", DataType: "Picklist" }] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Product2Id")) {
        return { totalSize: 1, done: true, records: [{ Id: "pad-1", AttributeDefinitionId: "ad-color", IsPriceImpacting: true, DefaultValue: "Black" }] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE") && soql.includes("IsPriceImpacting = true")) {
        return { totalSize: 1, done: true, records: [{ AttributeDefinitionId: "ad-color" }] };
      }
      if (soql.includes("SELECT Id, Name FROM AttributeDefinition WHERE Id IN")) {
        return { totalSize: 1, done: true, records: [{ Id: "ad-color", Name: "Color" }] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id IN")) {
        return { totalSize: 1, done: true, records: [{ Id: "pad-1", DefaultValue: "Black" }] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const contexts = await resolveAttributeContexts(client, productId, ["Color"]);
  const ctx = contexts.get("Color")!;
  assert.equal(ctx.productAttributeDefinitionId, "pad-1");
  assert.equal(ctx.isPriceImpacting, true);
  assert.equal(ctx.productClassificationAttrId, null);

  const names = await resolveAllPriceImpactingAttributeNames(client, productId);
  assert.deepEqual(names, ["Color"]);

  const config = await resolveBaseProductConfiguration(client, productId, [...contexts.entries()]);
  assert.equal(config.attributes.Color.value, "Black");
  assert.equal(config.attributes.Color.source, "PRODUCT_DEFAULT");
});
