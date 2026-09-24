/**
 * §Live-org fix (Desktop) regression coverage — "Inherited Attributes (6), Overridden Inherited
 * Attributes (0)" in Salesforce's own UI must resolve to 6 effective attributes here, never 0. Exercises
 * the REAL exported `discoverProductAttributes` end to end against synthetic-but-realistic
 * describe/query mocks — never a hand-rolled reimplementation of the resolution logic. Every relationship
 * FIELD name used below is deliberately non-standard-looking (e.g. `ProductRef__c`, `ClassLink__c`) to
 * prove nothing assumes a literal field name; only the object names (Product2, AttributeDefinition,
 * ProductAttributeDefinition, ProductCategoryProduct/Attribute, ProductClassification[Attr]) are
 * Salesforce's own fixed, standard API names.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeResult, DescribeField } from "@/lib/salesforce/client";
import { discoverProductAttributes } from "./discoverAttributes";

let instanceUrlCounter = 0;
/** Every test gets its OWN instanceUrl so the module-level Describe TTL cache never leaks results across tests. */
function uniqueInstanceUrl(): string {
  instanceUrlCounter += 1;
  return `https://test-org-${instanceUrlCounter}.my.salesforce.com`;
}

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

function describeResult(name: string, fields: DescribeField[], childRelationships?: { childSObject: string; field: string; relationshipName: string | null }[]): DescribeResult {
  return { name, label: "", labelPlural: "", recordTypeInfos: [], urls: {}, fields, childRelationships } as unknown as DescribeResult;
}

/** AttributeDefinition has no reference fields in every fixture below — `discoverAttributeValues` then
 * correctly short-circuits to an empty value list without needing any further query mocking, since these
 * tests are about EFFECTIVE ATTRIBUTE discovery, not value discovery (covered elsewhere). */
const ATTRIBUTE_DEFINITION_DESCRIBE = describeResult("AttributeDefinition", [field("Id", "id"), field("Name", "string"), field("Label", "string"), field("DataType", "string")]);

interface ClientConfig {
  productId: string;
  globalObjects: string[];
  product2Fields?: DescribeField[];
  product2ChildRelationships?: { childSObject: string; field: string; relationshipName: string | null }[];
  padFields?: DescribeField[];
  padQueryMatch?: string;
  padRecords?: Record<string, unknown>[];
  categoryProductRecords?: Record<string, unknown>[];
  categoryAttrRecords?: Record<string, unknown>[];
  classificationField?: DescribeField;
  classificationId?: string | null;
  pcaFields?: DescribeField[];
  pcaRecords?: Record<string, unknown>[];
  attributeDefinitionRecords: Record<string, unknown>[];
}

function buildClient(cfg: ClientConfig): SalesforceClient {
  const product2Describe = describeResult("Product2", cfg.product2Fields ?? [field("Id", "id")], cfg.product2ChildRelationships);
  const padDescribe = describeResult("ProductAttributeDefinition", cfg.padFields ?? []);
  const pcaDescribe = describeResult("ProductClassificationAttr", cfg.pcaFields ?? []);

  return {
    instanceUrl: uniqueInstanceUrl(),
    async describeSObjects() {
      return { sobjects: cfg.globalObjects.map(name => ({ name, label: name, labelPlural: name, createable: false, queryable: true })) };
    },
    async describeObject(name: string) {
      if (name === "Product2") return product2Describe;
      if (name === "ProductAttributeDefinition") return padDescribe;
      if (name === "AttributeDefinition") return ATTRIBUTE_DEFINITION_DESCRIBE;
      if (name === "ProductClassificationAttr") return pcaDescribe;
      throw new Error(`unexpected describeObject(${name})`);
    },
    async query(soql: string) {
      if (cfg.padFields && (cfg.padQueryMatch ? soql.includes(cfg.padQueryMatch) : soql.includes("FROM ProductAttributeDefinition WHERE"))) {
        return { totalSize: (cfg.padRecords ?? []).length, done: true, records: cfg.padRecords ?? [] };
      }
      if (soql.includes("FROM ProductCategoryProduct WHERE")) {
        return { totalSize: (cfg.categoryProductRecords ?? []).length, done: true, records: cfg.categoryProductRecords ?? [] };
      }
      if (soql.includes("FROM ProductCategoryAttribute WHERE")) {
        return { totalSize: (cfg.categoryAttrRecords ?? []).length, done: true, records: cfg.categoryAttrRecords ?? [] };
      }
      if (soql.includes("FROM Product2 WHERE") && cfg.classificationField) {
        return { totalSize: 1, done: true, records: [{ [cfg.classificationField.name]: cfg.classificationId ?? null }] };
      }
      if (soql.includes("FROM ProductClassificationAttr WHERE")) {
        return { totalSize: (cfg.pcaRecords ?? []).length, done: true, records: cfg.pcaRecords ?? [] };
      }
      if (soql.includes("FROM AttributeDefinition WHERE Id IN")) {
        return { totalSize: cfg.attributeDefinitionRecords.length, done: true, records: cfg.attributeDefinitionRecords };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}

const NO_PAD_FIELDS: DescribeField[] = [
  field("Id", "id"), field("ProductRef__c", "reference", { referenceTo: ["Product2"] }),
  field("AttrRef__c", "reference", { referenceTo: ["AttributeDefinition"] }), field("PriceImpactFlag__c", "boolean"),
];

test("TEST 1 — product with only DIRECT attributes (no category, no classification): existing Laptop/Monitor-style behavior unchanged", async () => {
  const productId = "01tDIRECT000000001";
  const client = buildClient({
    productId,
    globalObjects: ["ProductAttributeDefinition"],
    product2ChildRelationships: [{ childSObject: "ProductAttributeDefinition", field: "ProductRef__c", relationshipName: "PADs" }],
    padFields: NO_PAD_FIELDS,
    padRecords: [
      { Id: "pad-1", ProductRef__c: productId, AttrRef__c: "attrdef-A", PriceImpactFlag__c: true },
      { Id: "pad-2", ProductRef__c: productId, AttrRef__c: "attrdef-B", PriceImpactFlag__c: false },
    ],
    attributeDefinitionRecords: [
      { Id: "attrdef-A", Name: "Graphics", Label: "Graphics", DataType: "Picklist" },
      { Id: "attrdef-B", Name: "Memory", Label: "Memory", DataType: "Picklist" },
    ],
  });

  const { attributes, warnings } = await discoverProductAttributes(client, productId);
  assert.deepEqual(warnings, []);
  assert.equal(attributes.length, 2);
  assert.ok(attributes.every(a => a.source === "DIRECT"));
  assert.equal(attributes.find(a => a.name === "Graphics")?.isPriceImpacting, true);
  assert.equal(attributes.find(a => a.name === "Memory")?.isPriceImpacting, false);
});

test("TEST 2/3 — Desktop repro: product with ONLY classification-inherited attributes, ZERO direct/overridden records and ZERO overrides — must return 6 effective attributes, never 0", async () => {
  const productId = "01tDESKTOP000000001";
  const classificationId = "0Z6DESKTOPCLASS0001";
  const attrDefIds = ["ad-graphics", "ad-memory", "ad-processor", "ad-display", "ad-screensize", "ad-storage"];
  const client = buildClient({
    productId,
    globalObjects: ["ProductAttributeDefinition", "ProductClassification", "ProductClassificationAttr"],
    product2Fields: [field("Id", "id"), field("ClassLink__c", "reference", { referenceTo: ["ProductClassification"] })],
    product2ChildRelationships: [{ childSObject: "ProductAttributeDefinition", field: "ProductRef__c", relationshipName: "PADs" }],
    padFields: NO_PAD_FIELDS,
    padRecords: [], // ZERO direct/overridden records — exactly Salesforce's "Overridden Inherited Attributes (0)"
    classificationField: field("ClassLink__c", "reference", { referenceTo: ["ProductClassification"] }),
    classificationId,
    pcaFields: [
      field("Id", "id"), field("AttrDefLink__c", "reference", { referenceTo: ["AttributeDefinition"] }),
      field("ClassLink2__c", "reference", { referenceTo: ["ProductClassification"] }), field("PriceImpactFlag__c", "boolean"),
    ],
    pcaRecords: attrDefIds.map((id, i) => ({ Id: `pca-${i}`, AttrDefLink__c: id, PriceImpactFlag__c: true })),
    attributeDefinitionRecords: [
      { Id: "ad-graphics", Name: "Graphics", Label: "Graphics", DataType: "Picklist" },
      { Id: "ad-memory", Name: "Memory", Label: "Memory", DataType: "Picklist" },
      { Id: "ad-processor", Name: "Processor", Label: "Processor", DataType: "Picklist" },
      { Id: "ad-display", Name: "Display", Label: "Display", DataType: "Picklist" },
      { Id: "ad-screensize", Name: "Screen Size", Label: "Screen Size", DataType: "Picklist" },
      { Id: "ad-storage", Name: "Storage", Label: "Storage", DataType: "Picklist" },
    ],
  });

  const { attributes, warnings } = await discoverProductAttributes(client, productId);
  assert.deepEqual(warnings, []);
  assert.equal(attributes.length, 6, "must return all 6 inherited attributes, NOT 0, even though there are zero direct/overridden records");
  assert.ok(attributes.every(a => a.source === "INHERITED"));
  assert.ok(attributes.every(a => a.isPriceImpacting === true));
  assert.deepEqual(new Set(attributes.map(a => a.name)), new Set(["Graphics", "Memory", "Processor", "Display", "Screen Size", "Storage"]));
});

test("TEST 4 — product with inherited attributes AND one override: the override's own price-impacting flag wins over the classification's", async () => {
  const productId = "01tOVERRIDE00000001";
  const classificationId = "0Z6CLASS0000000001";
  const client = buildClient({
    productId,
    globalObjects: ["ProductAttributeDefinition", "ProductClassification", "ProductClassificationAttr"],
    product2Fields: [field("Id", "id"), field("ClassLink__c", "reference", { referenceTo: ["ProductClassification"] })],
    product2ChildRelationships: [{ childSObject: "ProductAttributeDefinition", field: "ProductRef__c", relationshipName: "PADs" }],
    padFields: [
      field("Id", "id"), field("ProductRef__c", "reference", { referenceTo: ["Product2"] }),
      field("AttrRef__c", "reference", { referenceTo: ["AttributeDefinition"] }), field("PriceImpactFlag__c", "boolean"),
      field("OverrideOf__c", "reference", { referenceTo: ["ProductClassificationAttr"] }),
    ],
    // Overrides "ad-memory" (marked false here) — the classification below says memory IS price impacting (true);
    // the override must win.
    padRecords: [{ Id: "pad-1", ProductRef__c: productId, AttrRef__c: "ad-memory", PriceImpactFlag__c: false, OverrideOf__c: "pca-memory" }],
    classificationField: field("ClassLink__c", "reference", { referenceTo: ["ProductClassification"] }),
    classificationId,
    pcaFields: [
      field("Id", "id"), field("AttrDefLink__c", "reference", { referenceTo: ["AttributeDefinition"] }),
      field("ClassLink2__c", "reference", { referenceTo: ["ProductClassification"] }), field("PriceImpactFlag__c", "boolean"),
    ],
    pcaRecords: [
      { Id: "pca-memory", AttrDefLink__c: "ad-memory", PriceImpactFlag__c: true },
      { Id: "pca-graphics", AttrDefLink__c: "ad-graphics", PriceImpactFlag__c: true },
    ],
    attributeDefinitionRecords: [
      { Id: "ad-memory", Name: "Memory", Label: "Memory", DataType: "Picklist" },
      { Id: "ad-graphics", Name: "Graphics", Label: "Graphics", DataType: "Picklist" },
    ],
  });

  const { attributes } = await discoverProductAttributes(client, productId);
  assert.equal(attributes.length, 2, "Memory (overridden) + Graphics (still purely inherited) — never duplicated");
  const memory = attributes.find(a => a.name === "Memory")!;
  assert.equal(memory.source, "OVERRIDE");
  assert.equal(memory.isPriceImpacting, false, "the product-level OVERRIDE's own flag must win over the classification's");
  const graphics = attributes.find(a => a.name === "Graphics")!;
  assert.equal(graphics.source, "INHERITED");
  assert.equal(graphics.isPriceImpacting, true);
});

test("TEST 5 — product with BOTH a direct attribute and a purely inherited attribute", async () => {
  const productId = "01tMIXED0000000001";
  const classificationId = "0Z6CLASSMIXED00001";
  const client = buildClient({
    productId,
    globalObjects: ["ProductAttributeDefinition", "ProductClassification", "ProductClassificationAttr"],
    product2Fields: [field("Id", "id"), field("ClassLink__c", "reference", { referenceTo: ["ProductClassification"] })],
    product2ChildRelationships: [{ childSObject: "ProductAttributeDefinition", field: "ProductRef__c", relationshipName: "PADs" }],
    padFields: NO_PAD_FIELDS,
    // A DIRECT attribute ("Color") with no classification link at all, plus this product's classification
    // separately grants "Memory" purely by inheritance.
    padRecords: [{ Id: "pad-1", ProductRef__c: productId, AttrRef__c: "ad-color", PriceImpactFlag__c: false }],
    classificationField: field("ClassLink__c", "reference", { referenceTo: ["ProductClassification"] }),
    classificationId,
    pcaFields: [field("Id", "id"), field("AttrDefLink__c", "reference", { referenceTo: ["AttributeDefinition"] }), field("ClassLink2__c", "reference", { referenceTo: ["ProductClassification"] })],
    pcaRecords: [{ Id: "pca-memory", AttrDefLink__c: "ad-memory" }],
    attributeDefinitionRecords: [
      { Id: "ad-color", Name: "Color", Label: "Color", DataType: "Picklist" },
      { Id: "ad-memory", Name: "Memory", Label: "Memory", DataType: "Picklist" },
    ],
  });

  const { attributes } = await discoverProductAttributes(client, productId);
  assert.equal(attributes.length, 2);
  assert.equal(attributes.find(a => a.name === "Color")?.source, "DIRECT");
  assert.equal(attributes.find(a => a.name === "Memory")?.source, "INHERITED");
});

test("TEST 6 — two DIFFERENT AttributeDefinition records with the SAME Name are never merged/misattributed (dedup is by Id, never by display name)", async () => {
  const productId = "01tDUPNAME000000001";
  const client = buildClient({
    productId,
    globalObjects: ["ProductAttributeDefinition"],
    product2ChildRelationships: [{ childSObject: "ProductAttributeDefinition", field: "ProductRef__c", relationshipName: "PADs" }],
    padFields: NO_PAD_FIELDS,
    padRecords: [
      { Id: "pad-1", ProductRef__c: productId, AttrRef__c: "ad-duplicate-1", PriceImpactFlag__c: true },
      { Id: "pad-2", ProductRef__c: productId, AttrRef__c: "ad-duplicate-2", PriceImpactFlag__c: false },
    ],
    // Two DISTINCT Salesforce records that happen to share the literal Name "Color" — a prior version of
    // this resolver matched attributes back to their values by NAME, which would have silently merged or
    // misattributed these.
    attributeDefinitionRecords: [
      { Id: "ad-duplicate-1", Name: "Color", Label: "Color (Exterior)", DataType: "Picklist" },
      { Id: "ad-duplicate-2", Name: "Color", Label: "Color (Interior)", DataType: "Picklist" },
    ],
  });

  const { attributes } = await discoverProductAttributes(client, productId);
  assert.equal(attributes.length, 2, "both distinct records must survive — never collapsed into one because their Name matches");
  const byLabel = new Map(attributes.map(a => [a.label, a]));
  assert.equal(byLabel.get("Color (Exterior)")?.isPriceImpacting, true);
  assert.equal(byLabel.get("Color (Interior)")?.isPriceImpacting, false);
  assert.equal(byLabel.get("Color (Exterior)")?.attributeDefinitionId, "ad-duplicate-1");
  assert.equal(byLabel.get("Color (Interior)")?.attributeDefinitionId, "ad-duplicate-2");
});

test("TEST 7 — product with no attributes at all via ANY path returns an empty array, never throws", async () => {
  const productId = "01tEMPTY0000000001";
  const client = buildClient({
    productId,
    globalObjects: ["ProductAttributeDefinition"],
    product2ChildRelationships: [{ childSObject: "ProductAttributeDefinition", field: "ProductRef__c", relationshipName: "PADs" }],
    padFields: NO_PAD_FIELDS,
    padRecords: [],
    attributeDefinitionRecords: [],
  });

  const { attributes, warnings } = await discoverProductAttributes(client, productId);
  assert.deepEqual(attributes, []);
  assert.deepEqual(warnings, []);
});

test("TEST 8/9 — two products with completely different, arbitrarily-shaped Salesforce Ids both resolve correctly and independently (no hardcoded Id anywhere)", async () => {
  const productA = "zzz-weird-id-format-AAA";
  const productB = "###another-weird-id-BBB###";

  const clientFor = (productId: string, attrDefId: string, name: string) => buildClient({
    productId,
    globalObjects: ["ProductAttributeDefinition"],
    product2ChildRelationships: [{ childSObject: "ProductAttributeDefinition", field: "WeirdProductRef", relationshipName: "PADs" }],
    padFields: [
      field("Id", "id"), field("WeirdProductRef", "reference", { referenceTo: ["Product2"] }),
      field("WeirdAttrRef", "reference", { referenceTo: ["AttributeDefinition"] }), field("WeirdPriceFlag", "boolean"),
    ],
    padQueryMatch: "FROM ProductAttributeDefinition WHERE WeirdProductRef",
    padRecords: [{ Id: "pad-x", WeirdProductRef: productId, WeirdAttrRef: attrDefId, WeirdPriceFlag: true }],
    attributeDefinitionRecords: [{ Id: attrDefId, Name: name, Label: name, DataType: "Picklist" }],
  });

  const resultA = await discoverProductAttributes(clientFor(productA, "weird-attrdef-A", "Alpha"), productA);
  const resultB = await discoverProductAttributes(clientFor(productB, "weird-attrdef-B", "Beta"), productB);

  assert.equal(resultA.attributes.length, 1);
  assert.equal(resultA.attributes[0].name, "Alpha");
  assert.equal(resultB.attributes.length, 1);
  assert.equal(resultB.attributes[0].name, "Beta");
});
