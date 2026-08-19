/**
 * §Live-org fix (Desktop) — regression coverage for the shared Product Classification
 * attribute-inheritance resolver. Every relationship FIELD name used in these fixtures is deliberately
 * NON-standard-looking (e.g. `ClassRef__c`, `AttrDef__c`) to prove nothing here assumes a literal field
 * name — only the OBJECT names (Product2, ProductClassification, ProductClassificationAttr,
 * AttributeDefinition) are Salesforce's own fixed, standard API names, exactly like this codebase's
 * existing treatment of Product2/AttributeDefinition elsewhere.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeResult, DescribeField } from "@/lib/salesforce/client";
import { resolveProductClassificationInheritance } from "./productClassificationInheritance";

let instanceUrlCounter = 0;
/** Every test gets its OWN instanceUrl so the module-level Describe TTL cache never leaks results across tests. */
function uniqueInstanceUrl(): string {
  instanceUrlCounter += 1;
  return `https://test-org-${instanceUrlCounter}.my.salesforce.com`;
}

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

function buildClient(opts: {
  instanceUrl: string;
  globalObjects: { name: string; queryable: boolean }[];
  product2Fields?: DescribeField[];
  pcaFields?: DescribeField[];
  productRow?: Record<string, unknown>;
  pcaRows?: Record<string, unknown>[];
  queryOverride?: (soql: string) => Record<string, unknown>[] | undefined;
}): SalesforceClient {
  const product2Describe: DescribeResult = {
    name: "Product2", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
    fields: opts.product2Fields ?? [field("Id", "id"), field("Name", "string")],
  } as unknown as DescribeResult;
  const pcaDescribe: DescribeResult = {
    name: "ProductClassificationAttr", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
    fields: opts.pcaFields ?? [],
  } as unknown as DescribeResult;

  return {
    instanceUrl: opts.instanceUrl,
    async describeSObjects() {
      return { sobjects: opts.globalObjects.map(o => ({ name: o.name, label: o.name, labelPlural: o.name, createable: false, queryable: o.queryable })) };
    },
    async describeObject(name: string) {
      if (name === "Product2") return product2Describe;
      if (name === "ProductClassificationAttr") return pcaDescribe;
      throw new Error(`unexpected describeObject(${name})`);
    },
    async query(soql: string) {
      const overridden = opts.queryOverride?.(soql);
      if (overridden) return { totalSize: overridden.length, done: true, records: overridden };
      if (soql.includes("FROM Product2 WHERE")) return { totalSize: 1, done: true, records: [opts.productRow ?? {}] };
      if (soql.includes("FROM ProductClassificationAttr WHERE")) return { totalSize: (opts.pcaRows ?? []).length, done: true, records: opts.pcaRows ?? [] };
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}

test("resolves classification-inherited attributes end to end with non-standard field names (Desktop repro shape)", async () => {
  const productId = "01tDESKTOP00000001";
  const classificationId = "0Z6CLASSIFICATION01";
  const client = buildClient({
    instanceUrl: uniqueInstanceUrl(),
    globalObjects: [{ name: "ProductClassification", queryable: true }, { name: "ProductClassificationAttr", queryable: true }],
    product2Fields: [field("Id", "id"), field("ClassRef__c", "reference", { referenceTo: ["ProductClassification"] })],
    pcaFields: [
      field("Id", "id"), field("AttrDef__c", "reference", { referenceTo: ["AttributeDefinition"] }),
      field("ClassificationLink__c", "reference", { referenceTo: ["ProductClassification"] }),
      field("PriceImpactFlag__c", "boolean"), field("DefaultValue", "string"),
    ],
    productRow: { ClassRef__c: classificationId },
    pcaRows: [
      { Id: "pca-1", AttrDef__c: "attrdef-graphics", PriceImpactFlag__c: true, DefaultValue: "Integrated" },
      { Id: "pca-2", AttrDef__c: "attrdef-memory", PriceImpactFlag__c: true, DefaultValue: "8GB" },
      { Id: "pca-3", AttrDef__c: "attrdef-processor", PriceImpactFlag__c: false, DefaultValue: null },
    ],
  });

  const result = await resolveProductClassificationInheritance(client, productId);
  assert.equal(result.supported, true);
  assert.equal(result.classificationId, classificationId);
  assert.equal(result.rowsByAttributeDefinitionId.size, 3);
  assert.equal(result.rowsByAttributeDefinitionId.get("attrdef-graphics")?.isPriceImpacting, true);
  assert.equal(result.rowsByAttributeDefinitionId.get("attrdef-graphics")?.defaultValue, "Integrated");
  assert.equal(result.rowsByAttributeDefinitionId.get("attrdef-processor")?.isPriceImpacting, false);
});

test("degrades to supported=false when ProductClassification/ProductClassificationAttr are not queryable on this org", async () => {
  const client = buildClient({
    instanceUrl: uniqueInstanceUrl(),
    globalObjects: [{ name: "SomeUnrelatedObject", queryable: true }],
  });
  const result = await resolveProductClassificationInheritance(client, "01tANYPRODUCT00001");
  assert.equal(result.supported, false);
  assert.equal(result.rowsByAttributeDefinitionId.size, 0);
});

test("product has no classification set — supported=true, empty map, never throws", async () => {
  const client = buildClient({
    instanceUrl: uniqueInstanceUrl(),
    globalObjects: [{ name: "ProductClassification", queryable: true }, { name: "ProductClassificationAttr", queryable: true }],
    product2Fields: [field("Id", "id"), field("ClassRef__c", "reference", { referenceTo: ["ProductClassification"] })],
    productRow: { ClassRef__c: null },
  });
  const result = await resolveProductClassificationInheritance(client, "01tNOCLASSIFICATION1");
  assert.equal(result.supported, true);
  assert.equal(result.classificationId, null);
  assert.equal(result.rowsByAttributeDefinitionId.size, 0);
});

test("cross-org arbitrary IDs — completely different, unusually-shaped IDs than any other test produce correct results, proving nothing is hardcoded", async () => {
  const weirdProductId = "zzz-not-a-real-sf-id-format-999";
  const weirdClassificationId = "###classification###";
  const client = buildClient({
    instanceUrl: uniqueInstanceUrl(),
    globalObjects: [{ name: "ProductClassification", queryable: true }, { name: "ProductClassificationAttr", queryable: true }],
    product2Fields: [field("Id", "id"), field("WeirdLookupFieldName999", "reference", { referenceTo: ["ProductClassification"] })],
    pcaFields: [field("Id", "id"), field("WeirdAttrDefRef", "reference", { referenceTo: ["AttributeDefinition"] }), field("WeirdClassRef", "reference", { referenceTo: ["ProductClassification"] })],
    productRow: { WeirdLookupFieldName999: weirdClassificationId },
    pcaRows: [{ Id: "weird-pca-id", WeirdAttrDefRef: "weird-attrdef-id" }],
    queryOverride: soql => {
      if (soql.includes(`FROM ProductClassificationAttr WHERE WeirdClassRef = '${weirdClassificationId}'`)) {
        return [{ Id: "weird-pca-id", WeirdAttrDefRef: "weird-attrdef-id" }];
      }
      return undefined;
    },
  });
  const result = await resolveProductClassificationInheritance(client, weirdProductId);
  assert.equal(result.classificationId, weirdClassificationId);
  assert.equal(result.rowsByAttributeDefinitionId.get("weird-attrdef-id")?.id, "weird-pca-id");
});
