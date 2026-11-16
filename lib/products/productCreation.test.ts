/**
 * Product Creation regressions:
 *  1. Product Selling Model ↔ PricebookEntry mapping — the selling model used to be linked to the product
 *     (ProductSellingModelOption) while the Standard/custom PricebookEntry was created WITHOUT ProductSellingModelId.
 *  2. Duplicate detection by the COMPLETE Product2.Name — "OmniCloud RCA" used to be flagged against "OmniCloud RCA Product"
 *     (LIKE '%first token%' + substring/fuzzy ranking, plus ProductCode matching).
 *
 * The fake org below enforces the Salesforce rules that matter here: SOQL `=` is a whole-value case-insensitive match,
 * PricebookEntry is unique per Price Book × Product × Selling Model, a custom entry needs a Standard entry for the SAME selling
 * model (STANDARD_PRICE_NOT_DEFINED), and ProductSellingModelId is create-only.
 *
 * Run: `npx tsx --test lib/products/productCreation.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { isSameProductName } from "@/lib/duplicateDetection";
import { checkProductDuplicate } from "@/lib/products/server/duplicateCheck";
import { persistProductPrice } from "@/lib/products/server/pricebookEntry";
import { linkSellingModelToProduct, matchSellingModel, verifySellingModelMapping, type SellingModelRecord } from "@/lib/products/server/sellingModel";
import { validateImportRows } from "@/lib/products/import/validateRows";

type Row = Record<string, unknown> & { Id: string };

const STD_BOOK = "01s000000000STDAAA", CUSTOM_BOOK = "01s000000000CUSAAA";
const ONE_TIME: SellingModelRecord = { Id: "0jP0000000000OTAAA", Name: "One Time", SellingModelType: "OneTime", Status: "Active" };
const TERM_YEARLY: SellingModelRecord = { Id: "0jP0000000000TYAAA", Name: "Term Based - Yearly", SellingModelType: "TermDefined", Status: "Active" };
const EVERGREEN_MONTHLY: SellingModelRecord = { Id: "0jP0000000000EMAAA", Name: "Evergreen - Monthly", SellingModelType: "Evergreen", Status: "Active" };

/** Minimal in-memory org: WHERE with AND/OR of `F = 'v'`, `F != 'v'`, `F = true`, `F IN (...)`; relationship Pricebook2.* on PricebookEntry. */
function fakeOrg(opts: { pricebookEntryHasSellingModel?: boolean } = {}) {
  let seq = 0;
  const db: Record<string, Row[]> = {
    Product2: [],
    Pricebook2: [
      { Id: STD_BOOK, Name: "Standard Price Book", IsStandard: true, IsActive: true },
      { Id: CUSTOM_BOOK, Name: "Partner Price Book", IsStandard: false, IsActive: true },
    ],
    PricebookEntry: [],
    ProductSellingModel: [ONE_TIME, TERM_YEARLY, EVERGREEN_MONTHLY].map(m => ({ ...m })),
    ProductSellingModelOption: [],
    ProductCatalog: [],
    ProductCategory: [],
  };
  const log: Array<{ op: "create" | "update"; sobject: string; fields: Record<string, unknown> }> = [];
  const hasPsmField = opts.pricebookEntryHasSellingModel !== false;

  const eq = (a: unknown, b: string) => (typeof a === "string" ? a.toLowerCase() === b.toLowerCase() : String(a) === b);
  const matchesClause = (r: Row, clause: string): boolean => {
    let m = /^(\w+)\s+IN\s+\((.*)\)$/i.exec(clause);
    if (m) { const vals = [...m[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(x => x[1]); return vals.some(v => eq(r[m![1]], v)); }
    m = /^(\w+)\s*(!=|=)\s*(?:'((?:[^'\\]|\\.)*)'|(true|false|null))$/i.exec(clause);
    if (!m) throw new Error(`fake SOQL: unsupported clause ${clause}`);
    const [, field, op, str, lit] = m;
    const v = r[field] ?? null;
    const hit = lit === "null" ? v === null : lit ? v === (lit === "true") : eq(v, str.replace(/\\'/g, "'"));
    return op === "=" ? hit : !hit;
  };
  const where = (r: Row, w: string) => w.split(/\s+OR\s+/i).some(or => or.split(/\s+AND\s+/i).every(c => matchesClause(r, c.trim())));

  const client = {
    instanceUrl: "https://example.my.salesforce.com",
    async query<T>(soql: string) {
      const m = /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER BY .+?)?(?:\s+LIMIT\s+(\d+))?$/i.exec(soql.trim());
      if (!m) throw new Error(`fake SOQL: unsupported ${soql}`);
      const [, fields, sobject, w, limit] = m;
      if (sobject === "PricebookEntry" && !hasPsmField && /ProductSellingModelId/.test(soql)) throw new Error("INVALID_FIELD: No such column 'ProductSellingModelId' on entity 'PricebookEntry'");
      let rows = (db[sobject] ?? []).filter(r => !w || where(r, w));
      if (limit) rows = rows.slice(0, Number(limit));
      const out = rows.map(r => {
        const o: Record<string, unknown> = { ...r };
        if (sobject === "PricebookEntry" && /Pricebook2\./.test(fields)) {
          const b = db.Pricebook2.find(p => p.Id === r.Pricebook2Id);
          o.Pricebook2 = b ? { Name: b.Name, IsStandard: b.IsStandard } : null;
        }
        return o;
      });
      return { totalSize: out.length, done: true, records: out as T[] };
    },
    async createRecord(sobject: string, fields: Record<string, unknown>) {
      log.push({ op: "create", sobject, fields });
      if (sobject === "PricebookEntry") {
        if (!hasPsmField && "ProductSellingModelId" in fields) return { id: "", success: false, errors: [{ errorCode: "INVALID_FIELD" }] };
        const psm = (fields.ProductSellingModelId as string | undefined) ?? null;
        const same = (r: Row) => r.Product2Id === fields.Product2Id && (r.ProductSellingModelId ?? null) === psm;
        if (db.PricebookEntry.some(r => same(r) && r.Pricebook2Id === fields.Pricebook2Id)) return { id: "", success: false, errors: [{ errorCode: "DUPLICATE_VALUE" }] };
        if (fields.Pricebook2Id !== STD_BOOK && !db.PricebookEntry.some(r => same(r) && r.Pricebook2Id === STD_BOOK)) {
          return { id: "", success: false, errors: [{ errorCode: "STANDARD_PRICE_NOT_DEFINED" }] };
        }
      }
      const id = `${sobject.slice(0, 3)}${String(++seq).padStart(12, "0")}AAA`; // unique within the 15-char case-sensitive prefix
      (db[sobject] ??= []).push({ ProductSellingModelId: null, ...fields, Id: id });
      return { id, success: true, errors: [] };
    },
    async updateRecord(sobject: string, id: string, fields: Record<string, unknown>) {
      log.push({ op: "update", sobject, fields });
      if (sobject === "PricebookEntry" && "ProductSellingModelId" in fields) throw new Error("INVALID_FIELD_FOR_INSERT_UPDATE: ProductSellingModelId is not updateable");
      const r = db[sobject].find(x => x.Id === id);
      if (!r) throw new Error("ENTITY_IS_DELETED");
      Object.assign(r, fields);
    },
    async describeObject(sobject: string) {
      const names = sobject === "PricebookEntry"
        ? ["Id", "Product2Id", "Pricebook2Id", "UnitPrice", "IsActive", "UseStandardPrice", ...(hasPsmField ? ["ProductSellingModelId"] : [])]
        : ["Id", "Name"];
      return { name: sobject, label: sobject, labelPlural: sobject, fields: names.map(name => ({ name })), recordTypeInfos: [], urls: {} };
    },
  };
  return { client: client as unknown as SalesforceClient, db, log };
}

async function newProduct(org: ReturnType<typeof fakeOrg>, name: string): Promise<string> {
  return (await org.client.createRecord("Product2", { Name: name, IsActive: true })).id;
}

/* ─────────────────────────── Issue 1: Product Selling Model ↔ PricebookEntry ─────────────────────────── */

test("One-Time: Standard Price Book entry is created WITH ProductSellingModelId, and the mapping reads back", async () => {
  const org = fakeOrg();
  const productId = await newProduct(org, "OmniCloud RCA Product");
  const link = await linkSellingModelToProduct(org.client, productId, ONE_TIME);
  assert.equal(link.alreadyLinked, false);

  const out = await persistProductPrice(org.client, { productId, unitPrice: 1200, isActive: true, productSellingModelId: link.modelId });
  assert.equal(out.error, undefined);
  assert.equal(out.entry?.pricebookId, STD_BOOK);
  assert.equal(out.entry?.productSellingModelId, ONE_TIME.Id);
  assert.equal(out.entry?.standardEntry?.id, out.entry?.id);

  const stored = org.db.PricebookEntry.find(r => r.Id === out.entry!.id)!;
  assert.equal(stored.ProductSellingModelId, ONE_TIME.Id, "the selling model is persisted on the Standard PricebookEntry");
  assert.equal(stored.UnitPrice, 1200);

  const checks = await verifySellingModelMapping(org.client, { productId, modelId: ONE_TIME.Id, entryIds: [out.entry!.id] });
  assert.ok(checks.every(c => c.passed), JSON.stringify(checks));
  assert.equal(checks.length, 3);
});

test("Term-Based: the entry carries the Term-Based model, not another one", async () => {
  const org = fakeOrg();
  const productId = await newProduct(org, "Analytics Suite");
  const model = matchSellingModel(org.db.ProductSellingModel as unknown as SellingModelRecord[], "term based yearly");
  assert.equal(model?.Id, TERM_YEARLY.Id);
  await linkSellingModelToProduct(org.client, productId, model!);
  const out = await persistProductPrice(org.client, { productId, unitPrice: 5000, isActive: true, productSellingModelId: model!.Id });
  assert.equal(out.entry?.productSellingModelId, TERM_YEARLY.Id);
  const checks = await verifySellingModelMapping(org.client, { productId, modelId: TERM_YEARLY.Id, entryIds: [out.entry!.id] });
  assert.ok(checks.every(c => c.passed));
});

test("Custom Price Book: the Standard entry AND the custom entry are both created for the selling model", async () => {
  const org = fakeOrg();
  const productId = await newProduct(org, "Partner Widget");
  await linkSellingModelToProduct(org.client, productId, EVERGREEN_MONTHLY);
  const out = await persistProductPrice(org.client, { productId, unitPrice: 75, priceBook: "Partner Price Book", isActive: true, productSellingModelId: EVERGREEN_MONTHLY.Id });
  assert.equal(out.error, undefined);
  assert.equal(out.entry?.pricebookId, CUSTOM_BOOK);
  assert.ok(out.entry?.standardEntryId, "standard entry auto-created first");
  assert.equal(out.entry?.standardEntry?.productSellingModelId, EVERGREEN_MONTHLY.Id);
  assert.equal(out.entry?.productSellingModelId, EVERGREEN_MONTHLY.Id);

  const entries = org.db.PricebookEntry.filter(r => r.Product2Id === productId);
  assert.equal(entries.length, 2);
  assert.ok(entries.every(e => e.ProductSellingModelId === EVERGREEN_MONTHLY.Id));
  assert.equal(entries.find(e => e.Pricebook2Id === CUSTOM_BOOK)?.UseStandardPrice, false);

  const checks = await verifySellingModelMapping(org.client, { productId, modelId: EVERGREEN_MONTHLY.Id, entryIds: [out.entry!.standardEntry!.id, out.entry!.id] });
  assert.ok(checks.every(c => c.passed), JSON.stringify(checks));
  assert.ok(checks.some(c => c.label.includes("Partner Price Book")) && checks.some(c => c.label.includes("Standard Price Book")));
});

test("a legacy standard entry without a selling model is not reused for a selling-model price (field is create-only)", async () => {
  const org = fakeOrg();
  const productId = await newProduct(org, "Legacy Product");
  org.db.PricebookEntry.push({ Id: "01u000000000LEGAAA", Product2Id: productId, Pricebook2Id: STD_BOOK, UnitPrice: 10, IsActive: true, ProductSellingModelId: null });
  await linkSellingModelToProduct(org.client, productId, ONE_TIME);
  const out = await persistProductPrice(org.client, { productId, unitPrice: 20, isActive: true, productSellingModelId: ONE_TIME.Id });
  assert.equal(out.error, undefined);
  assert.notEqual(out.entry?.id, "01u000000000LEGAAA");
  assert.equal(out.entry?.productSellingModelId, ONE_TIME.Id);
  assert.ok(!org.log.some(l => l.op === "update" && l.sobject === "PricebookEntry" && "ProductSellingModelId" in l.fields));
});

test("re-saving reuses the option and the per-model entries — no duplicate options, entries or selling models", async () => {
  const org = fakeOrg();
  const productId = await newProduct(org, "Repeat Product");
  const first = await linkSellingModelToProduct(org.client, productId, ONE_TIME);
  const again = await linkSellingModelToProduct(org.client, productId, ONE_TIME);
  assert.equal(again.alreadyLinked, true);
  assert.equal(again.optionId, first.optionId);
  assert.equal(org.db.ProductSellingModelOption.length, 1);

  const a = await persistProductPrice(org.client, { productId, unitPrice: 100, priceBook: "Partner Price Book", isActive: true, productSellingModelId: ONE_TIME.Id });
  const b = await persistProductPrice(org.client, { productId, unitPrice: 110, priceBook: "Partner Price Book", isActive: true, productSellingModelId: ONE_TIME.Id });
  assert.equal(b.entry?.id, a.entry?.id);
  assert.equal(b.entry?.updated, true);
  assert.equal(org.db.PricebookEntry.length, 2);
  assert.equal(org.db.ProductSellingModel.length, 3, "selling models are resolved, never created");
  assert.ok(!org.log.some(l => l.op === "create" && l.sobject === "ProductSellingModel"));
});

test("a Draft selling model is activated before use; an Inactive one is refused", async () => {
  const org = fakeOrg();
  const productId = await newProduct(org, "Draft Model Product");
  const draft = { Id: "0jP0000000000DRAAA", Name: "One Time Draft", SellingModelType: "OneTime", Status: "Draft" };
  org.db.ProductSellingModel.push({ ...draft });
  const link = await linkSellingModelToProduct(org.client, productId, draft);
  assert.equal(link.activated, true);
  assert.equal(org.db.ProductSellingModel.find(r => r.Id === draft.Id)?.Status, "Active");

  await assert.rejects(linkSellingModelToProduct(org.client, productId, { ...draft, Id: "0jP0000000000INAAA", Status: "Inactive" }), /Inactive/);
});

test("matching prefers an Active selling model over an Inactive one with the same name", () => {
  const records: SellingModelRecord[] = [
    { Id: "0jP0000000000X1AAA", Name: "One Time", SellingModelType: "OneTime", Status: "Inactive" },
    { Id: "0jP0000000000X2AAA", Name: "One Time", SellingModelType: "OneTime", Status: "Active" },
  ];
  assert.equal(matchSellingModel(records, "One Time")?.Id, "0jP0000000000X2AAA");
  assert.equal(matchSellingModel(records, "one-time")?.Id, "0jP0000000000X2AAA");
});

test("verification fails when an entry does not carry the selling model (the original bug)", async () => {
  const org = fakeOrg();
  const productId = await newProduct(org, "Unmapped Product");
  await linkSellingModelToProduct(org.client, productId, ONE_TIME);
  const legacy = await persistProductPrice(org.client, { productId, unitPrice: 50, isActive: true }); // old call shape — no selling model
  const checks = await verifySellingModelMapping(org.client, { productId, modelId: ONE_TIME.Id, entryIds: [legacy.entry!.id] });
  const entryCheck = checks.find(c => c.label.startsWith("PricebookEntry"));
  assert.equal(entryCheck?.passed, false);
  assert.equal(entryCheck?.actual, null);
});

test("orgs without PricebookEntry.ProductSellingModelId still save the price, with a warning", async () => {
  const org = fakeOrg({ pricebookEntryHasSellingModel: false });
  const productId = await newProduct(org, "Classic Org Product");
  const out = await persistProductPrice(org.client, { productId, unitPrice: 9, isActive: true, productSellingModelId: ONE_TIME.Id });
  assert.equal(out.error, undefined);
  assert.equal(out.entry?.unitPrice, 9);
  assert.match(out.warnings.join(" "), /no ProductSellingModelId field/);
});

/* ─────────────────────────── Issue 2: exact full-name duplicate detection ─────────────────────────── */

const NAME_CASES: Array<[existing: string, requested: string, duplicate: boolean]> = [
  ["OmniCloud RCA Product", "OmniCloud RCA", false],
  ["OmniCloud RCA", "OmniCloud RCA Product", false],
  ["OmniCloud RCA Product", "OmniCloud RCA Product", true],
  ["OmniCloud RCA Product", "omnicloud rca product", true],
  ["OmniCloud RCA Product", "  OmniCloud RCA Product  ", true],
  ["OmniCloud RCA Product", "OmniCloud RCA Product Plus", false],
  ["OmniCloud RCA Product", "OmniCloud", false],
];

for (const [existing, requested, duplicate] of NAME_CASES) {
  test(`duplicate check: existing "${existing}" vs new "${requested}" → ${duplicate ? "exact duplicate" : "no warning"}`, async () => {
    assert.equal(isSameProductName(existing, requested), duplicate);
    const org = fakeOrg();
    await newProduct(org, existing);
    const result = await checkProductDuplicate(org.client, { name: requested });
    assert.equal(result.isDuplicate, duplicate);
    assert.deepEqual(result.similarRecords, [], "partial-name resemblances are never reported");
    if (result.isDuplicate) {
      assert.equal(result.matchType, "exact-name");
      assert.equal(result.recordName, existing);
    }
  });
}

test("duplicate check never uses LIKE / partial tokens and ignores ProductCode", async () => {
  const org = fakeOrg();
  await org.client.createRecord("Product2", { Name: "OmniCloud RCA Product", ProductCode: "OMNICLOUD_RCA" });
  const queries: string[] = [];
  const spy = { ...org.client, instanceUrl: "https://example.my.salesforce.com", query: (q: string) => { queries.push(q); return org.client.query(q); } } as unknown as SalesforceClient;
  const result = await checkProductDuplicate(spy, { name: "OmniCloud RCA" });
  assert.equal(result.isDuplicate, false);
  assert.ok(queries.every(q => !/LIKE/i.test(q) && !/ProductCode\s*=/i.test(q)), queries.join("\n"));
});

test("Continue Anyway: a second product with the exact same name can be created (Salesforce permits it); the check still reports it", async () => {
  const org = fakeOrg();
  const firstId = await newProduct(org, "OmniCloud RCA Product");
  const before = await checkProductDuplicate(org.client, { name: "OmniCloud RCA Product" });
  assert.equal(before.isDuplicate, true);
  if (before.isDuplicate) assert.equal(before.recordId, firstId);
  // The save route skips ONLY its duplicate-name gate when allowDuplicateName is true; Product2.Name has no unique constraint.
  const secondId = await newProduct(org, "OmniCloud RCA Product");
  assert.notEqual(secondId, firstId);
  assert.equal(org.db.Product2.filter(p => isSameProductName(p.Name as string, "OmniCloud RCA Product")).length, 2);
  // Editing a record never flags its own name.
  assert.equal((await checkProductDuplicate(org.client, { name: "OmniCloud RCA Product", excludeId: firstId })).isDuplicate, true, "the OTHER copy still counts");
});

test("bulk import: only an exact full-name match is skipped; a shared ProductCode is just a warning", async () => {
  const org = fakeOrg();
  await org.client.createRecord("Product2", { Name: "OmniCloud RCA Product", ProductCode: "OMNICLOUD_RCA" });
  const mapping = { name: "Name", productCode: "Code", family: "Family" } as unknown as Parameters<typeof validateImportRows>[2];
  const res = await validateImportRows(org.client, [
    { Name: "OmniCloud RCA", Code: "", Family: "Software" },          // autoCode → OMNICLOUD_RCA (shared code, different name)
    { Name: "OmniCloud RCA Product", Code: "X1", Family: "Software" }, // exact name
    { Name: "OmniCloud RCA Product Plus", Code: "X2", Family: "Software" },
  ], mapping);
  assert.notEqual(res.rows[0].status, "skipped");
  assert.ok(res.rows[0].issues.some(i => i.field === "productCode" && i.level === "warning"));
  assert.equal(res.rows[1].status, "skipped");
  assert.match(res.rows[1].issues.find(i => i.field === "duplicate")!.message, /exact name "OmniCloud RCA Product"/);
  assert.notEqual(res.rows[2].status, "skipped");
});
