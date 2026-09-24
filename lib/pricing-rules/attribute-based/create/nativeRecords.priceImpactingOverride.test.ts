/**
 * §Live-org fix (Desktop, "configure-price-impacting failed") — regression coverage for
 * `ensurePriceImpactingAttributes`'s new source-aware behavior. Before this fix, the function ONLY ever
 * knew how to UPDATE an existing ProductAttributeDefinition — for a purely classification-INHERITED
 * attribute (no product-level record at all, e.g. Desktop's "Display"), it threw "no Product Attribute
 * Definition record found for this product" instead of resolving the real Salesforce-supported path: a
 * NEW, product-SCOPED ProductAttributeDefinition override (never a write to the shared
 * ProductClassificationAttr, which every other product using that classification also reads).
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import { ensurePriceImpactingAttributes } from "./nativeRecords";

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

const AD_DESCRIBE: DescribeResult = {
  name: "AttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [field("Id", "id"), field("Name", "string"), field("DataType", "picklist")],
} as unknown as DescribeResult;

/** A PAD schema that DOES expose the override-link field — the "safe to auto-create an override" shape. */
const PAD_DESCRIBE_WITH_OVERRIDE_LINK: DescribeResult = {
  name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [
    field("Id", "id"), field("Product2Id", "reference", { referenceTo: ["Product2"] }),
    field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }),
    field("IsPriceImpacting", "boolean"), field("DataType", "picklist"),
    field("ProductClassificationAttributeId", "reference", { referenceTo: ["ProductClassificationAttr"] }),
  ],
} as unknown as DescribeResult;

/** A PAD schema WITHOUT the override-link field — proves the code refuses to guess/create when it can't
 * prove which classification-level record it would be overriding. */
const PAD_DESCRIBE_NO_OVERRIDE_LINK: DescribeResult = {
  name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [
    field("Id", "id"), field("Product2Id", "reference", { referenceTo: ["Product2"] }),
    field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }),
    field("IsPriceImpacting", "boolean"),
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
    field("ProductClassificationId", "reference", { referenceTo: ["ProductClassification"] }), field("IsPriceImpacting", "boolean"),
  ],
} as unknown as DescribeResult;

let instanceUrlCounter = 0;
function uniqueInstanceUrl(): string {
  instanceUrlCounter += 1;
  return `https://test-org-pio-${instanceUrlCounter}.my.salesforce.com`;
}

interface Scenario {
  productId: string;
  classificationId?: string;
  attributeDefId: string;
  attributeName: string;
  padDescribe: DescribeResult;
  /** Existing direct/overridden PAD row on the product, if any. */
  existingPadRecord?: { Id: string; IsPriceImpacting: boolean; ProductClassificationAttributeId?: string };
  classificationRow?: { Id: string; IsPriceImpacting: boolean };
  /** Set to observe every createRecord/updateRecord call this scenario makes. */
  mutationLog: { op: "create" | "update"; object: string; payload: Record<string, unknown>; id?: string }[];
  /** If true, ProductClassification/ProductClassificationAttr are NOT queryable on this org at all. */
  noClassificationSupport?: boolean;
  /** If true, the product has no ProductClassificationId set. */
  noClassificationOnProduct?: boolean;
}

function buildClient(s: Scenario): SalesforceClient {
  const createdIds = new Set<string>();
  return {
    instanceUrl: uniqueInstanceUrl(),
    async describeSObjects() {
      if (s.noClassificationSupport) return { sobjects: [] };
      return { sobjects: [
        { name: "ProductClassification", label: "", labelPlural: "", createable: false, queryable: true },
        { name: "ProductClassificationAttr", label: "", labelPlural: "", createable: false, queryable: true },
      ] };
    },
    async describeObject(name: string) {
      if (name === "AttributeDefinition") return AD_DESCRIBE;
      if (name === "ProductAttributeDefinition") return s.padDescribe;
      if (name === "Product2") return PRODUCT2_DESCRIBE;
      if (name === "ProductClassificationAttr") return PCA_DESCRIBE;
      throw new Error(`unexpected describeObject(${name})`);
    },
    async query(soql: string) {
      if (soql.includes("FROM AttributeDefinition WHERE Name IN")) {
        return { totalSize: 1, done: true, records: [{ Id: s.attributeDefId, Name: s.attributeName, DataType: "Picklist" }] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Product2Id")) {
        return s.existingPadRecord
          ? { totalSize: 1, done: true, records: [{ Id: s.existingPadRecord.Id, AttributeDefinitionId: s.attributeDefId, IsPriceImpacting: s.existingPadRecord.IsPriceImpacting, ProductClassificationAttributeId: s.existingPadRecord.ProductClassificationAttributeId }] }
          : { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM Product2 WHERE")) {
        return { totalSize: 1, done: true, records: [{ ProductClassificationId: s.noClassificationOnProduct ? null : (s.classificationId ?? null) }] };
      }
      if (soql.includes("FROM ProductClassificationAttr WHERE ProductClassificationId")) {
        return s.classificationRow
          ? { totalSize: 1, done: true, records: [{ Id: s.classificationRow.Id, AttributeDefinitionId: s.attributeDefId, IsPriceImpacting: s.classificationRow.IsPriceImpacting }] }
          : { totalSize: 0, done: true, records: [] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id = '")) {
        const m = soql.match(/WHERE Id = '([^']+)'/);
        const id = m?.[1];
        if (s.existingPadRecord && id === s.existingPadRecord.Id) {
          return { totalSize: 1, done: true, records: [{ Id: id, IsPriceImpacting: true }] };
        }
        if (id && createdIds.has(id)) {
          return { totalSize: 1, done: true, records: [{ Id: id, IsPriceImpacting: true }] };
        }
        return { totalSize: 0, done: true, records: [] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    async updateRecord(objectName: string, id: string, payload: Record<string, unknown>) {
      s.mutationLog.push({ op: "update", object: objectName, payload, id });
      if (objectName === "ProductClassificationAttr") {
        throw new Error("TEST FAILURE: must never write to the shared ProductClassificationAttr record");
      }
      return { success: true };
    },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      s.mutationLog.push({ op: "create", object: objectName, payload });
      if (objectName !== "ProductAttributeDefinition") throw new Error(`unexpected createRecord: ${objectName}`);
      const newId = `new-override-${createdIds.size + 1}`;
      createdIds.add(newId);
      return { id: newId };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}

test("TEST 1 (Laptop-style) — DIRECT attribute already price-impacting: no mutation at all", async () => {
  const s: Scenario = {
    productId: "01tLAPTOP0000001", attributeDefId: "ad-color", attributeName: "Color",
    padDescribe: PAD_DESCRIBE_WITH_OVERRIDE_LINK,
    existingPadRecord: { Id: "pad-laptop-color", IsPriceImpacting: true },
    mutationLog: [],
  };
  const contexts = await ensurePriceImpactingAttributes(buildClient(s), s.productId, ["Color"], []);
  assert.equal(s.mutationLog.length, 0, "already-true attributes must never be mutated");
  assert.equal(contexts.get("Color")?.source, "DIRECT");
});

test("TEST 2 (Monitor-style) — DIRECT attribute currently false: updated in place (existing behavior, unchanged)", async () => {
  const s: Scenario = {
    productId: "01tMONITOR0000001", attributeDefId: "ad-resolution", attributeName: "Resolution",
    padDescribe: PAD_DESCRIBE_WITH_OVERRIDE_LINK,
    existingPadRecord: { Id: "pad-monitor-resolution", IsPriceImpacting: false },
    mutationLog: [],
  };
  const contexts = await ensurePriceImpactingAttributes(buildClient(s), s.productId, ["Resolution"], []);
  assert.equal(s.mutationLog.length, 1);
  assert.equal(s.mutationLog[0].op, "update");
  assert.equal(s.mutationLog[0].id, "pad-monitor-resolution");
  assert.equal(contexts.get("Resolution")?.isPriceImpacting, true);
});

test("TEST 3/4 (Desktop repro) — INHERITED attribute, no PAD record, classification says NOT price-impacting: a NEW product-scoped override is created; the shared classification record is never touched", async () => {
  const s: Scenario = {
    productId: "01tDESKTOP0000001", classificationId: "0Z6DESKTOPCLASS01", attributeDefId: "ad-display", attributeName: "Display",
    padDescribe: PAD_DESCRIBE_WITH_OVERRIDE_LINK,
    classificationRow: { Id: "pca-display", IsPriceImpacting: false },
    mutationLog: [],
  };
  const contexts = await ensurePriceImpactingAttributes(buildClient(s), s.productId, ["Display"], []);

  assert.equal(s.mutationLog.length, 1, "exactly one mutation: the new override create");
  assert.equal(s.mutationLog[0].op, "create");
  assert.equal(s.mutationLog[0].object, "ProductAttributeDefinition");
  assert.equal(s.mutationLog[0].payload.Product2Id, s.productId);
  assert.equal(s.mutationLog[0].payload.AttributeDefinitionId, "ad-display");
  assert.equal(s.mutationLog[0].payload.ProductClassificationAttributeId, "pca-display");
  assert.equal(s.mutationLog[0].payload.IsPriceImpacting, true);
  assert.ok(!s.mutationLog.some(m => m.object === "ProductClassificationAttr"), "the shared classification record must never be written to");

  const ctx = contexts.get("Display")!;
  assert.equal(ctx.isPriceImpacting, true);
  assert.equal(ctx.source, "OVERRIDE");
  assert.equal(ctx.productAttributeDefinitionId, "new-override-1");
});

test("TEST — INHERITED attribute already price-impacting at the classification level: no mutation, proceeds directly", async () => {
  const s: Scenario = {
    productId: "01tDESKTOP0000002", classificationId: "0Z6DESKTOPCLASS02", attributeDefId: "ad-graphics", attributeName: "Graphics",
    padDescribe: PAD_DESCRIBE_WITH_OVERRIDE_LINK,
    classificationRow: { Id: "pca-graphics", IsPriceImpacting: true },
    mutationLog: [],
  };
  const contexts = await ensurePriceImpactingAttributes(buildClient(s), s.productId, ["Graphics"], []);
  assert.equal(s.mutationLog.length, 0);
  assert.equal(contexts.get("Graphics")?.source, "INHERITED");
  assert.equal(contexts.get("Graphics")?.isPriceImpacting, true);
});

test("TEST 5 — an existing, valid OVERRIDE (already price-impacting) is recognized and left untouched", async () => {
  const s: Scenario = {
    productId: "01tDESKTOP0000003", attributeDefId: "ad-memory", attributeName: "Memory",
    padDescribe: PAD_DESCRIBE_WITH_OVERRIDE_LINK,
    existingPadRecord: { Id: "pad-memory-override", IsPriceImpacting: true, ProductClassificationAttributeId: "pca-memory" },
    mutationLog: [],
  };
  const contexts = await ensurePriceImpactingAttributes(buildClient(s), s.productId, ["Memory"], []);
  assert.equal(s.mutationLog.length, 0);
  assert.equal(contexts.get("Memory")?.source, "OVERRIDE");
});

test("TEST 6 — mixed request: one DIRECT (already true) + one INHERITED needing a new override, both resolved correctly in the same run", async () => {
  const productId = "01tMIXED0000001";
  const classificationId = "0Z6MIXEDCLASS01";
  const createdIds = new Set<string>();
  const mutationLog: { op: string; object: string; payload: Record<string, unknown> }[] = [];
  const client = {
    instanceUrl: uniqueInstanceUrl(),
    async describeSObjects() {
      return { sobjects: [{ name: "ProductClassification", label: "", labelPlural: "", createable: false, queryable: true }, { name: "ProductClassificationAttr", label: "", labelPlural: "", createable: false, queryable: true }] };
    },
    async describeObject(name: string) {
      if (name === "AttributeDefinition") return AD_DESCRIBE;
      if (name === "ProductAttributeDefinition") return PAD_DESCRIBE_WITH_OVERRIDE_LINK;
      if (name === "Product2") return PRODUCT2_DESCRIBE;
      if (name === "ProductClassificationAttr") return PCA_DESCRIBE;
      throw new Error(`unexpected describeObject(${name})`);
    },
    async query(soql: string) {
      if (soql.includes("FROM AttributeDefinition WHERE Name IN")) {
        return { totalSize: 2, done: true, records: [{ Id: "ad-color", Name: "Color", DataType: "Picklist" }, { Id: "ad-storage", Name: "Storage", DataType: "Picklist" }] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Product2Id")) {
        return { totalSize: 1, done: true, records: [{ Id: "pad-color", AttributeDefinitionId: "ad-color", IsPriceImpacting: true }] };
      }
      if (soql.includes("FROM Product2 WHERE")) return { totalSize: 1, done: true, records: [{ ProductClassificationId: classificationId }] };
      if (soql.includes("FROM ProductClassificationAttr WHERE ProductClassificationId")) {
        return { totalSize: 1, done: true, records: [{ Id: "pca-storage", AttributeDefinitionId: "ad-storage", IsPriceImpacting: false }] };
      }
      if (soql.includes("FROM ProductAttributeDefinition WHERE Id = '")) {
        const id = soql.match(/WHERE Id = '([^']+)'/)?.[1];
        if (id && createdIds.has(id)) return { totalSize: 1, done: true, records: [{ Id: id, IsPriceImpacting: true }] };
        return { totalSize: 0, done: true, records: [] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    async createRecord(objectName: string, payload: Record<string, unknown>) {
      mutationLog.push({ op: "create", object: objectName, payload });
      const id = "new-override-storage";
      createdIds.add(id);
      return { id };
    },
    async updateRecord() { throw new Error("must never update anything in this scenario"); },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const contexts = await ensurePriceImpactingAttributes(client, productId, ["Color", "Storage"], []);
  assert.equal(mutationLog.length, 1, "only Storage needed a mutation");
  assert.equal(contexts.get("Color")?.source, "DIRECT");
  assert.equal(contexts.get("Storage")?.source, "OVERRIDE");
  assert.equal(contexts.get("Storage")?.isPriceImpacting, true);
});

test("TEST 7 — no PAD record AND no resolvable Product Classification source at all: status is genuinely UNDETERMINABLE (not 'false') — proceeds without changing anything, zero mutations, never throws", async () => {
  const s: Scenario = {
    productId: "01tUNKNOWN0000001", attributeDefId: "ad-mystery", attributeName: "Mystery",
    padDescribe: PAD_DESCRIBE_WITH_OVERRIDE_LINK,
    noClassificationSupport: true,
    mutationLog: [],
  };
  const contexts = await ensurePriceImpactingAttributes(buildClient(s), s.productId, ["Mystery"], []);
  assert.equal(s.mutationLog.length, 0, "nothing to safely correct — must never guess");
  assert.equal(contexts.get("Mystery")?.isPriceImpacting, null);
  assert.equal(contexts.get("Mystery")?.source, "UNKNOWN");
});

test("TEST 8 — INHERITED and not price-impacting, but this org's PAD schema has no override-link field: stops with a precise message rather than creating an ambiguous record", async () => {
  const s: Scenario = {
    productId: "01tNOOVERRIDE0001", classificationId: "0Z6NOOVERRIDE01", attributeDefId: "ad-weight", attributeName: "Weight",
    padDescribe: PAD_DESCRIBE_NO_OVERRIDE_LINK,
    classificationRow: { Id: "pca-weight", IsPriceImpacting: false },
    mutationLog: [],
  };
  await assert.rejects(
    () => ensurePriceImpactingAttributes(buildClient(s), s.productId, ["Weight"], []),
    (err: Error) => {
      assert.match(err.message, /ProductClassificationAttr override-link reference field/);
      assert.match(err.message, /cannot be safely created/);
      return true;
    },
  );
  assert.equal(s.mutationLog.length, 0, "must never guess/create a malformed override");
});

test("TEST 9 — shared Product Classification used by TWO different products: creating Product A's override never affects Product B's own resolution", async () => {
  const classificationId = "0Z6SHAREDCLASS001";
  const sA: Scenario = {
    productId: "01tPRODUCTA000001", classificationId, attributeDefId: "ad-shared", attributeName: "SharedAttr",
    padDescribe: PAD_DESCRIBE_WITH_OVERRIDE_LINK,
    classificationRow: { Id: "pca-shared", IsPriceImpacting: false },
    mutationLog: [],
  };
  const contextsA = await ensurePriceImpactingAttributes(buildClient(sA), sA.productId, ["SharedAttr"], []);
  assert.equal(sA.mutationLog.length, 1);
  assert.equal(sA.mutationLog[0].payload.Product2Id, "01tPRODUCTA000001");
  assert.equal(contextsA.get("SharedAttr")?.source, "OVERRIDE");

  // Product B, same classification, queried independently — its own (fresh) resolution still sees the
  // classification's own IsPriceImpacting=false (Product A's override never touched the shared record),
  // and correctly creates its OWN separate, independently-scoped override.
  const sB: Scenario = {
    productId: "01tPRODUCTB000002", classificationId, attributeDefId: "ad-shared", attributeName: "SharedAttr",
    padDescribe: PAD_DESCRIBE_WITH_OVERRIDE_LINK,
    classificationRow: { Id: "pca-shared", IsPriceImpacting: false },
    mutationLog: [],
  };
  const contextsB = await ensurePriceImpactingAttributes(buildClient(sB), sB.productId, ["SharedAttr"], []);
  assert.equal(sB.mutationLog.length, 1);
  assert.equal(sB.mutationLog[0].payload.Product2Id, "01tPRODUCTB000002");
  assert.equal(contextsB.get("SharedAttr")?.source, "OVERRIDE");
});

test("TEST 10 — arbitrary, unusually-shaped Salesforce Ids throughout prove nothing is hardcoded", async () => {
  const s: Scenario = {
    productId: "###weird-product-id###", classificationId: "zzz-weird-classification-999", attributeDefId: "weird-attrdef-id", attributeName: "WeirdAttr",
    padDescribe: PAD_DESCRIBE_WITH_OVERRIDE_LINK,
    classificationRow: { Id: "weird-pca-id", IsPriceImpacting: false },
    mutationLog: [],
  };
  const contexts = await ensurePriceImpactingAttributes(buildClient(s), s.productId, ["WeirdAttr"], []);
  assert.equal(s.mutationLog[0].payload.Product2Id, "###weird-product-id###");
  assert.equal(s.mutationLog[0].payload.ProductClassificationAttributeId, "weird-pca-id");
  assert.equal(contexts.get("WeirdAttr")?.isPriceImpacting, true);
});
