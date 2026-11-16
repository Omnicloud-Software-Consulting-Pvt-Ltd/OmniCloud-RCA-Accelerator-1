/**
 * Bundle commercials (Product Selling Model + PricebookEntry for every bundle component) against an in-memory Salesforce org —
 * MOCKED; nothing here contacts Salesforce. The fake enforces PricebookEntry uniqueness per Product2 + Pricebook2 +
 * ProductSellingModel like Salesforce, so duplicate handling and races are exercised for real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SalesforceError, type SalesforceClient } from "@/lib/salesforce/client";
import { persistProductPrice } from "@/lib/products/server/pricebookEntry";
import { linkSellingModelToProduct } from "@/lib/products/server/sellingModel";
import { planBundleCommercials, priceAndVerify, resolveAndLinkSellingModels, explainSalesforceError, type CommercialItem } from "./commercials";

type Rec = Record<string, unknown> & { Id: string };

const STD = "01s000000000STDAAA";
const PARTNER = "01s000000000PRTAAA";
const ONE_TIME = "0jP000000000001AAA";
const TERM = "0jP000000000002AAA";
const DRAFT = "0jP000000000003AAA";
const RETIRED = "0jP000000000004AAA";
const X = "01t000000000XXXAAA";

function fakeOrg(seed: { entries?: Rec[]; options?: Rec[] } = {}) {
  let n = 0;
  const id = (p: string) => `${p}${String(++n).padStart(15 - p.length, "0")}AAA`;
  const db = {
    Pricebook2: [{ Id: STD, Name: "Standard Price Book", IsStandard: true, IsActive: true }, { Id: PARTNER, Name: "Partner Price Book", IsStandard: false, IsActive: true }] as Rec[],
    ProductSellingModel: [
      { Id: ONE_TIME, Name: "One Time", SellingModelType: "OneTime", Status: "Active" },
      { Id: TERM, Name: "Term Monthly", SellingModelType: "TermDefined", Status: "Active" },
      { Id: DRAFT, Name: "Evergreen Monthly", SellingModelType: "Evergreen", Status: "Draft" },
      { Id: RETIRED, Name: "Term Annual", SellingModelType: "TermDefined", Status: "Inactive" },
    ] as Rec[],
    PricebookEntry: [...(seed.entries ?? [])] as Rec[],
    ProductSellingModelOption: [...(seed.options ?? [])] as Rec[],
  };
  const writes: { op: "create" | "update"; sobject: string; id: string; fields: Record<string, unknown> }[] = [];
  const hooks: { beforeCreate?: (sobject: string, fields: Record<string, unknown>) => void; ignorePsmOnCreate?: boolean; failCreate?: (sobject: string, fields: Record<string, unknown>) => SalesforceError | null } = {};
  const eq = (soql: string, field: string) => new RegExp(`${field} = '([^']+)'`).exec(soql)?.[1];
  const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.slice(0, 15) === b.slice(0, 15);

  const client = {
    describeObject: async (name: string) => ({ name, fields: name === "PricebookEntry" ? [{ name: "ProductSellingModelId" }, { name: "UnitPrice" }] : [] }),
    query: async (soql: string) => {
      if (/FROM Pricebook2 WHERE IsStandard = true/.test(soql)) return { records: db.Pricebook2.filter(p => p.IsStandard) };
      if (/FROM Pricebook2 WHERE Name/.test(soql)) return { records: db.Pricebook2.filter(p => p.Name === eq(soql, "Name")) };
      if (/FROM ProductSellingModel WHERE Id/.test(soql)) return { records: db.ProductSellingModel.filter(m => same(m.Id, eq(soql, "Id"))) };
      if (/FROM ProductSellingModel\b/.test(soql)) return { records: db.ProductSellingModel };
      if (/FROM ProductSellingModelOption/.test(soql)) {
        const p = eq(soql, "Product2Id"), m = eq(soql, "ProductSellingModelId");
        return { records: db.ProductSellingModelOption.filter(o => same(o.Product2Id, p) && (!m || same(o.ProductSellingModelId, m)))
          .map(o => ({ ...o, ProductSellingModel: { Name: db.ProductSellingModel.find(x => same(x.Id, o.ProductSellingModelId))?.Name } })) };
      }
      if (/FROM PricebookEntry WHERE Id IN/.test(soql)) {
        const ids = [...soql.matchAll(/'([^']+)'/g)].map(m => m[1]);
        return { records: db.PricebookEntry.filter(e => ids.some(i => same(i, e.Id))).map(e => ({ ...e, Pricebook2: db.Pricebook2.find(b => same(b.Id, e.Pricebook2Id)) })) };
      }
      if (/FROM PricebookEntry WHERE Product2Id/.test(soql)) {
        const p = eq(soql, "Product2Id"), b = eq(soql, "Pricebook2Id"), m = eq(soql, "ProductSellingModelId");
        return { records: db.PricebookEntry.filter(e => same(e.Product2Id, p) && same(e.Pricebook2Id, b) && (!m || same(e.ProductSellingModelId, m))) };
      }
      throw new Error(`fake org: unexpected query ${soql}`);
    },
    createRecord: async (sobject: string, fields: Record<string, unknown>) => {
      hooks.beforeCreate?.(sobject, fields);
      const forced = hooks.failCreate?.(sobject, fields);
      if (forced) throw forced;
      if (sobject === "PricebookEntry") {
        const dup = db.PricebookEntry.find(e => same(e.Product2Id, fields.Product2Id) && same(e.Pricebook2Id, fields.Pricebook2Id) && (e.ProductSellingModelId ?? null) === (fields.ProductSellingModelId ?? null));
        if (dup) throw new SalesforceError("This price definition already exists in this price book", 400, [{ errorCode: "DUPLICATE_VALUE", message: "This price definition already exists in this price book" }]);
        const rec = { Id: id("01u"), ...fields, ...(hooks.ignorePsmOnCreate ? { ProductSellingModelId: null } : {}) };
        db.PricebookEntry.push(rec);
        writes.push({ op: "create", sobject, id: rec.Id, fields });
        return { id: rec.Id, success: true, errors: [] };
      }
      if (sobject === "ProductSellingModelOption") {
        const rec = { Id: id("0iO"), ...fields };
        db.ProductSellingModelOption.push(rec);
        writes.push({ op: "create", sobject, id: rec.Id, fields });
        return { id: rec.Id, success: true, errors: [] };
      }
      throw new Error(`fake org: unexpected create ${sobject}`);
    },
    updateRecord: async (sobject: string, recId: string, fields: Record<string, unknown>) => {
      const table = (db as unknown as Record<string, Rec[]>)[sobject];
      const rec = table?.find(r => same(r.Id, recId));
      if (!rec) throw new Error(`fake org: unknown ${sobject} ${recId}`);
      Object.assign(rec, fields);
      writes.push({ op: "update", sobject, id: recId, fields });
    },
  } as unknown as SalesforceClient;
  return { client, db, writes, hooks };
}

const existingOneTimeX = (): Rec => ({ Id: "01u000000000OLDAAA", Product2Id: X, Pricebook2Id: STD, ProductSellingModelId: ONE_TIME, UnitPrice: 150, IsActive: true });
const linkedOneTime = (): Rec => ({ Id: "0iO000000000OLDAAA", Product2Id: X, ProductSellingModelId: ONE_TIME });
const item = (o: Partial<CommercialItem> = {}): CommercialItem => ({ name: "Product X", productId: X, kind: "product", unitPrice: 200, sellingModel: "One Time", ...o });

async function run(org: ReturnType<typeof fakeOrg>, items: CommercialItem[]) {
  const p1 = await resolveAndLinkSellingModels(org.client, items);
  const p2 = await priceAndVerify(org.client, p1.linked);
  return { p1, p2, failures: [...p1.failures, ...p2.failures] };
}

test("A. same product + same Price Book + same selling model: existing entry reused, ₹150 kept, never updated", async () => {
  const org = fakeOrg({ entries: [existingOneTimeX()], options: [linkedOneTime()] });
  const { p2, failures } = await run(org, [item({ unitPrice: 200, sellingModel: "One Time" })]);
  assert.deepEqual(failures, []);
  const e = p2.priced[0].entry;
  assert.equal(e.reused, true);
  assert.equal(e.id, "01u000000000OLDAAA");
  assert.equal(e.unitPrice, 150);
  assert.deepEqual(e.retainedPrice, { existing: 150, requested: 200 });
  assert.equal(org.db.PricebookEntry.length, 1, "no second entry");
  assert.equal(org.writes.filter(w => w.sobject === "PricebookEntry").length, 0, "the existing entry was not written at all");
  assert.equal(org.db.PricebookEntry[0].UnitPrice, 150);
  assert.ok(p2.priced[0].warnings.some(w => /price was kept/.test(w)), "the retained price is reported");
});

test("B. same product + same Price Book + DIFFERENT selling model: a separate entry is created for that model", async () => {
  const org = fakeOrg({ entries: [existingOneTimeX()], options: [linkedOneTime()] });
  const { p1, p2, failures } = await run(org, [item({ unitPrice: 200, sellingModel: "Term Monthly" })]);
  assert.deepEqual(failures, []);
  assert.equal(p1.linked[0].model.id, TERM);
  assert.deepEqual(p1.linked[0].existingModels, ["One Time"], "the existing product's real associations were read first");
  assert.equal(p1.linked[0].alreadyLinked, false, "a ProductSellingModelOption was created for the new model");
  const e = p2.priced[0].entry;
  assert.equal(e.reused, undefined);
  assert.equal(e.unitPrice, 200);
  assert.equal(org.db.PricebookEntry.length, 2);
  assert.deepEqual(org.db.PricebookEntry.map(r => [r.ProductSellingModelId, r.UnitPrice]), [[ONE_TIME, 150], [TERM, 200]], "the One-Time entry is untouched");
});

test("C. same product + DIFFERENT Price Book + same selling model: separate Partner entry; the Standard entry is reused at ₹150", async () => {
  const org = fakeOrg({ entries: [existingOneTimeX()], options: [linkedOneTime()] });
  const { p2, failures } = await run(org, [item({ unitPrice: 200, priceBook: "Partner Price Book" })]);
  assert.deepEqual(failures, []);
  const e = p2.priced[0].entry;
  assert.equal(e.pricebookId, PARTNER);
  assert.equal(e.unitPrice, 200);
  assert.deepEqual(e.standardEntry, { id: "01u000000000OLDAAA", productSellingModelId: ONE_TIME, created: false });
  assert.deepEqual(org.db.PricebookEntry.map(r => [r.Pricebook2Id, r.UnitPrice]), [[STD, 150], [PARTNER, 200]]);
});

test("standalone product edits keep their behavior: the default existingPrice 'update' still writes the new price", async () => {
  const org = fakeOrg({ entries: [existingOneTimeX()] });
  const out = await persistProductPrice(org.client, { productId: X, unitPrice: 175, isActive: true, productSellingModelId: ONE_TIME });
  assert.equal(out.entry?.updated, true);
  assert.equal(org.db.PricebookEntry[0].UnitPrice, 175);
});

test("concurrent creation: a duplicate created between check and create is reused, not duplicated, and its price isn't overwritten", async () => {
  const org = fakeOrg({ options: [linkedOneTime()] });
  org.hooks.beforeCreate = (sobject, fields) => {
    if (sobject !== "PricebookEntry" || org.db.PricebookEntry.length) return;
    org.db.PricebookEntry.push({ Id: "01u000000000RACEAA", Product2Id: fields.Product2Id, Pricebook2Id: fields.Pricebook2Id, ProductSellingModelId: fields.ProductSellingModelId, UnitPrice: 99, IsActive: true });
  };
  const { p2, failures } = await run(org, [item({ unitPrice: 200 })]);
  assert.deepEqual(failures, []);
  assert.equal(p2.priced[0].entry.id, "01u000000000RACEAA");
  assert.equal(p2.priced[0].entry.unitPrice, 99);
  assert.equal(org.db.PricebookEntry.length, 1);
});

test("concurrent ProductSellingModelOption creation is reused instead of failing", async () => {
  const org = fakeOrg();
  org.hooks.failCreate = (sobject, fields) => {
    if (sobject !== "ProductSellingModelOption") return null;
    org.db.ProductSellingModelOption.push({ Id: "0iO00000000RACEAAA", ...fields });
    return new SalesforceError("duplicate", 400, [{ errorCode: "DUPLICATE_VALUE", message: "duplicate value found" }]);
  };
  const link = await linkSellingModelToProduct(org.client, X, { Id: ONE_TIME, Name: "One Time", SellingModelType: "OneTime", Status: "Active" });
  assert.deepEqual([link.optionId, link.alreadyLinked], ["0iO00000000RACEAAA", true]);
});

test("new product: ProductSellingModelOption + Standard entry created and verified with the requested selling model", async () => {
  const org = fakeOrg();
  const { p1, p2, failures } = await run(org, [item({ sellingModel: "Term Monthly", unitPrice: 49 })]);
  assert.deepEqual(failures, []);
  assert.deepEqual([p1.linked[0].alreadyLinked, p1.linked[0].existingModels], [false, []]);
  assert.equal(org.db.ProductSellingModelOption[0].ProductSellingModelId, TERM);
  assert.equal(org.db.PricebookEntry[0].ProductSellingModelId, TERM);
  assert.ok(p2.priced[0].checks.every(c => c.passed) && p2.priced[0].checks.length >= 3, "model Active + option + entry verified in Salesforce");
});

test("selling model resolution: no silent substitution — unknown or Inactive models fail; missing request defaults to One Time (flagged); Draft is activated", async () => {
  const org = fakeOrg();
  const { p1 } = await run(org, [
    item({ name: "Unknown", productId: "01t0000000000U1AAA", sellingModel: "Lifetime Platinum" }),
    item({ name: "Retired", productId: "01t0000000000R1AAA", sellingModel: "Term Annual" }),
    item({ name: "Unspecified", productId: "01t0000000000N1AAA", sellingModel: undefined }),
    item({ name: "Draft", productId: "01t0000000000D1AAA", sellingModel: "Evergreen Monthly" }),
  ]);
  assert.match(p1.failures.find(f => f.name === "Unknown")!.error, /No Product Selling Model in this org matches "Lifetime Platinum"/);
  assert.match(p1.failures.find(f => f.name === "Retired")!.error, /Inactive/);
  const unspecified = p1.linked.find(l => l.name === "Unspecified")!;
  assert.deepEqual([unspecified.model.name, unspecified.model.defaulted], ["One Time", true]);
  const draft = p1.linked.find(l => l.name === "Draft")!;
  assert.equal(draft.activated, true);
  assert.equal(org.db.ProductSellingModel.find(m => m.Id === DRAFT)!.Status, "Active");
});

test("verification: if Salesforce doesn't store the selling model on the entry, the component is NOT reported as done", async () => {
  const org = fakeOrg();
  org.hooks.ignorePsmOnCreate = true;
  const { p2, failures } = await run(org, [item()]);
  assert.equal(p2.priced.length, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /ProductSellingModelId/);
});

test("Salesforce errors are returned with their code and a meaningful explanation; other components still complete (partial failure)", async () => {
  const org = fakeOrg();
  org.hooks.failCreate = (sobject, fields) => sobject === "PricebookEntry" && fields.Product2Id === "01t0000000000BADAA"
    ? new SalesforceError("field integrity exception: unknown (Product Selling Model)", 400, [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: "field integrity exception" }]) : null;
  const { p2, failures } = await run(org, [item({ name: "Bad", productId: "01t0000000000BADAA" }), item({ name: "Good", productId: "01t0000000000GOODA" })]);
  assert.deepEqual(p2.priced.map(p => p.name), ["Good"]);
  assert.equal(failures[0].name, "Bad");
  assert.match(failures[0].error, /^FIELD_INTEGRITY_EXCEPTION: .* — Salesforce rejected how the records reference each other/);
  assert.match(explainSalesforceError(new SalesforceError("x", 400, [{ errorCode: "STANDARD_PRICE_NOT_DEFINED", message: "x" }])), /Standard Price Book entry/);
});

test("planner: every component inherits selling model and Price Book from its NEAREST bundle (parent, child, nested, dependency)", () => {
  const plan = planBundleCommercials({
    bundleName: "Root", sellingModel: "Term Monthly", priceBook: "Partner Price Book",
    products: [{ name: "Root Child" }, { name: "Root Hardware", sellingModel: "One Time" }],
    nestedBundles: [{
      bundleName: "Nested", sellingModel: "Evergreen Monthly",
      products: [{ name: "Nested Child" }, { name: "Nested Std", priceBook: "Standard Price Book" }],
      nestedBundles: [{ bundleName: "Deep", products: [{ name: "Deep Child" }] }],
    }],
  }, [{ name: "Dep Of Deep", ownerBundleName: "Deep" }]);
  const get = (n: string) => { const p = plan.get(n.toLowerCase())!; return [p.kind, p.depth, p.sellingModel, p.priceBook]; };
  assert.deepEqual(get("Root"), ["root", 0, "Term Monthly", "Partner Price Book"]);
  assert.deepEqual(get("Root Child"), ["product", 1, "Term Monthly", "Partner Price Book"]);
  assert.deepEqual(get("Root Hardware"), ["product", 1, "One Time", "Partner Price Book"]);
  assert.deepEqual(get("Nested"), ["bundle", 1, "Evergreen Monthly", "Partner Price Book"]);
  assert.deepEqual(get("Nested Child"), ["product", 2, "Evergreen Monthly", "Partner Price Book"], "nested inherits its own bundle, not the root");
  assert.deepEqual(get("Nested Std"), ["product", 2, "Evergreen Monthly", "Standard Price Book"]);
  assert.deepEqual(get("Deep"), ["bundle", 2, "Evergreen Monthly", "Partner Price Book"]);
  assert.deepEqual(get("Deep Child"), ["product", 3, "Evergreen Monthly", "Partner Price Book"]);
  assert.deepEqual(get("Dep Of Deep"), ["dependency", 3, "Evergreen Monthly", "Partner Price Book"]);
});

for (const bundleType of ["Basic", "Standard"]) {
  test(`${bundleType} bundle with a nested bundle: parent, nested bundle, children and existing products all mapped and verified`, async () => {
    const org = fakeOrg({ entries: [existingOneTimeX()], options: [linkedOneTime()] });
    const bundle = { bundleName: `${bundleType} Root`, bundleType, sellingModel: "Term Monthly", products: [{ name: "Product X", sellingModel: "One Time" }, { name: "Service A" }], nestedBundles: [{ bundleName: "Add-on Pack", products: [{ name: "Add-on 1" }] }] };
    const plan = planBundleCommercials(bundle);
    const ids: Record<string, string> = { [`${bundleType} Root`]: "01t00000000ROOTAAA", "Product X": X, "Service A": "01t00000000SVCAAAA", "Add-on Pack": "01t00000000PACKAAA", "Add-on 1": "01t00000000ADD1AAA" };
    const prices: Record<string, number> = { [`${bundleType} Root`]: 500, "Product X": 200, "Service A": 100, "Add-on Pack": 50, "Add-on 1": 50 };
    const items = Object.entries(ids).map(([name, productId]) => { const p = plan.get(name.toLowerCase())!; return { name, productId, kind: p.kind, unitPrice: prices[name], sellingModel: p.sellingModel, priceBook: p.priceBook }; });
    const { p2, failures } = await run(org, items);
    assert.deepEqual(failures, []);
    const byName = Object.fromEntries(p2.priced.map(p => [p.name, p]));
    assert.equal(byName[`${bundleType} Root`].model.id, TERM, "parent bundle entry carries the bundle's selling model");
    assert.equal(byName["Add-on Pack"].model.id, TERM, "nested bundle inherits");
    assert.equal(byName["Add-on 1"].model.id, TERM, "nested child inherits");
    assert.deepEqual([byName["Product X"].entry.reused, byName["Product X"].entry.unitPrice], [true, 150], "existing product's matching entry reused at its own price");
    for (const p of p2.priced) {
      const stored = org.db.PricebookEntry.find(e => e.Id === p.entry.id)!;
      assert.ok(stored.Product2Id === p.productId && stored.ProductSellingModelId === p.model.id, `${p.name}: entry is for this product and selling model`);
      assert.ok(org.db.ProductSellingModelOption.some(o => o.Product2Id === p.productId && o.ProductSellingModelId === p.model.id), `${p.name}: product ↔ selling model link exists`);
    }
    assert.equal(org.db.ProductSellingModelOption.filter(o => o.Product2Id === X && o.ProductSellingModelId === ONE_TIME).length, 1, "no duplicate option for the existing product");
  });
}

test("bundle route uses the shared logic: no local selling-model matcher, no PricebookEntry lookup that ignores the selling model", () => {
  const src = readFileSync(join(process.cwd(), "app", "api", "bundles", "execute", "route.ts"), "utf8");
  assert.ok(src.includes("resolveAndLinkSellingModels(") && src.includes("priceAndVerify(") && src.includes("planBundleCommercials("));
  assert.ok(!/function matchSellingModel/.test(src), "the old fallback-to-any-model matcher is gone");
  assert.ok(!/FROM PricebookEntry WHERE Product2Id = [^`]*Pricebook2Id = [^`]*LIMIT 1/.test(src), "no Product+PriceBook-only duplicate check");
  assert.ok(!/createRecord\("PricebookEntry"/.test(src), "price entries are only written through persistProductPrice");
});

test("Product Creation chooser: cards centered in the content area, side by side on desktop, stacking via auto-fit", () => {
  const src = readFileSync(join(process.cwd(), "components", "data", "products", "ProductCreationChooser.tsx"), "utf8");
  const grid = /<div style=\{\{ display: "grid"[^}]*\}\}>/.exec(src)?.[0] ?? "";
  assert.match(grid, /repeat\(auto-fit, minmax\(260px, 1fr\)\)/);
  assert.match(grid, /maxWidth: 800/);
  assert.match(grid, /marginLeft: "auto", marginRight: "auto"/);
  assert.match(src, /title="Single Product"[\s\S]*title="Multiple Products"/, "both cards unchanged and in order");
});
