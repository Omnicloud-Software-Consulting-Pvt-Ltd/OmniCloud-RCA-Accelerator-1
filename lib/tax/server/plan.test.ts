/**
 * Tax configuration planner — pure tests against an in-memory org (metadata + records), covering the required scenarios:
 * standard taxable product, tax exempt, multiple products with item-level codes, idempotency (second run reuses everything),
 * invalid product, invalid tax code, missing object, immutable active treatment, and AI ↔ manual parity.
 *
 * Run: `npx tsx --test lib/tax/server/plan.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, productKey, allProductRefs, type PlanContext } from "./plan";
import { specFromAi, transactionFromAi } from "./ai";
import { normalizeSpec } from "./spec";
import type { TaxSnapshot, ProductResolution } from "./records";
import type { FieldMeta, ObjectMeta, ProductRow, TaxConfigSpec, TaxMetadata } from "@/lib/tax/types";

const f = (name: string, type = "string", o: Partial<FieldMeta> = {}): FieldMeta => ({ name, label: name, type, required: false, createable: true, updateable: true, nillable: true, picklist: [], referenceTo: [], ...o });
const pick = (name: string, values: string[], required = false) => f(name, "picklist", { picklist: values.map(v => ({ value: v, label: v })), required, nillable: !required });
const refF = (name: string, to: string, o: Partial<FieldMeta> = {}) => f(name, "reference", { referenceTo: [to], ...o });
const obj = (name: string, fields: FieldMeta[]): ObjectMeta => ({ name, label: name, exists: true, createable: true, updateable: true, queryable: true, fields: Object.fromEntries(fields.map(x => [x.name, x])) });

function metadata(drop: string[] = []): TaxMetadata {
  const objects: TaxMetadata["objects"] = {
    TaxEngineProvider: obj("TaxEngineProvider", [f("MasterLabel")]),
    TaxEngine: obj("TaxEngine", [f("TaxEngineName", "string", { required: true, nillable: false }), pick("Type", ["StripeNative", "StandardTaxEngine", "RevenueStandardTax"]), pick("Status", ["Active", "Inactive"], true), refF("TaxEngineProviderId", "TaxEngineProvider"), refF("MerchantCredentialId", "NamedCredential"), f("SellerCode"), f("Description")]),
    TaxPolicy: obj("TaxPolicy", [f("Name", "string", { required: true, nillable: false }), pick("Status", ["Draft", "Active", "Inactive"], true), pick("TreatmentSelection", ["LegalEntity", "Manual", "Default"], true), f("Description"), refF("DefaultTaxTreatmentId", "TaxTreatment")]),
    TaxTreatment: obj("TaxTreatment", [f("Name", "string", { required: true, nillable: false }), refF("TaxPolicyId", "TaxPolicy"), refF("LegalEntityId", "LegalEntity"), refF("TaxEngineId", "TaxEngine"), f("TaxCode"), f("ProductCode"), f("IsTaxable", "boolean"), pick("Status", ["Draft", "Active", "Inactive"], true), f("ShouldUseTaxTreatmentItems", "boolean"), f("Description")]),
    TaxTreatmentItem: obj("TaxTreatmentItem", [f("Name", "string", { required: true, nillable: false }), refF("TaxTreatmentId", "TaxTreatment", { required: true, nillable: false, updateable: false }), refF("ProductId", "Product2", { required: true, nillable: false }), f("TaxCode"), f("ProductCode")]),
    TaxRate: obj("TaxRate", [f("TaxCode", "string", { updateable: false }), refF("GeoCountryId", "GeoCountry", { updateable: false }), f("Rate", "double"), f("Priority", "int"), pick("RateUsageType", ["Commerce", "RevCloud"]), f("ProductCode"), f("StartDate", "date"), f("EndDate", "date"), pick("ApplicationBasis", ["Gross", "Net"]), refF("LegalEntityId", "LegalEntity")]),
    LegalEntity: obj("LegalEntity", [f("Name", "string", { required: true, nillable: false }), pick("Status", ["Active", "Inactive"])]),
    GeoCountry: obj("GeoCountry", [f("Name"), f("IsoCode", "string", { required: true, nillable: false, updateable: false })]),
    Product2: obj("Product2", [f("Name"), refF("TaxPolicyId", "TaxPolicy"), f("IsActive", "boolean")]),
    InvoiceLineTax: obj("InvoiceLineTax", [refF("TaxTreatmentId", "TaxTreatment")]),
  };
  for (const d of drop) objects[d] = { name: d, exists: false, reason: `${d} isn't available` };
  const rel = (from: string, to: string) => { const o = objects[from]; return o.exists ? Object.values(o.fields).find(x => x.referenceTo.includes(to))?.name ?? null : null; };
  const relationships: TaxMetadata["relationships"] = {};
  for (const [a, b] of [["TaxEngine", "TaxEngineProvider"], ["TaxEngine", "NamedCredential"], ["TaxPolicy", "TaxTreatment"], ["TaxTreatment", "TaxPolicy"], ["TaxTreatment", "TaxEngine"], ["TaxTreatment", "LegalEntity"], ["TaxTreatmentItem", "TaxTreatment"], ["TaxTreatmentItem", "Product2"], ["TaxRate", "GeoCountry"], ["TaxRate", "LegalEntity"], ["Product2", "TaxPolicy"]]) relationships[`${a}→${b}`] = rel(a, b);
  const problems = ["TaxPolicy", "TaxTreatment", "Product2"].filter(n => !objects[n].exists).map(n => `Required object ${n} is missing.`);
  return { apiVersion: "v68.0", objects, availableTaxObjects: Object.keys(objects).filter(k => objects[k].exists), relationships, problems };
}

const LE = { id: "0fwLE0000000001", name: "Default Legal Entity - US", status: "Active", country: null };
function emptySnapshot(meta = metadata()): TaxSnapshot {
  return { meta, engines: [], providers: [], policies: [], treatments: [], items: [], rates: [], legalEntities: [LE], geoCountries: [] };
}
const PRODUCTS: ProductRow[] = [
  { id: "01tLAPTOP000001", name: "Laptop", code: "LP001", active: true, taxPolicyId: "1TpOLD00000001", family: null },
  { id: "01tSOFTWARE0001", name: "Software", code: "SW001", active: true, taxPolicyId: null, family: null },
  { id: "01tBOOK00000001", name: "Book", code: "BK001", active: true, taxPolicyId: null, family: null },
];
function ctx(spec: TaxConfigSpec, snapshot = emptySnapshot()): PlanContext {
  const products = new Map<string, ProductResolution>();
  for (const r of allProductRefs(spec)) {
    const p = PRODUCTS.find(x => x.id === r.id || x.name.toLowerCase() === (r.name ?? "").toLowerCase());
    products.set(productKey(r), p ? { status: "found", product: p } : { status: "not-found", message: `No Salesforce product matches "${r.name}".`, candidates: [] });
  }
  return { snapshot, spec, products, connection: { orgId: "00DTEST", orgName: "Test", orgType: null, isSandbox: false, instanceUrl: "https://test.my.salesforce.com", userId: "005TEST", username: "u@test", displayName: "U" }, today: "2026-10-06", taxAdminMissing: false };
}
const errors = (p: ReturnType<typeof buildPlan>) => p.issues.filter(i => i.severity === "error");

/** Apply a plan's creates to the in-memory org, as Salesforce would (to test the second run). */
function apply(snap: TaxSnapshot, plan: ReturnType<typeof buildPlan>): TaxSnapshot {
  const ids = new Map<string, string>();
  let n = 0;
  const idOf = (v: unknown) => (typeof v === "string" && v.startsWith("@{") ? ids.get(v.slice(2, -1)) ?? v : v) as string;
  const s: TaxSnapshot = JSON.parse(JSON.stringify(snap));
  for (const st of plan.steps) {
    if (st.action === "reuse" && st.recordId) ids.set(st.id, st.recordId);
    if (st.action !== "create" && st.action !== "update") continue;
    const v = st.fields as Record<string, unknown>;
    if (st.action === "create") {
      const id = `${st.object.slice(0, 3)}NEW${String(++n).padStart(9, "0")}`;
      ids.set(st.id, id);
      if (st.object === "TaxEngine") s.engines.push({ id, name: String(v.TaxEngineName), type: String(v.Type), status: String(v.Status), provider: null, sellerCode: null, native: v.Type === "RevenueStandardTax", decisionTableId: null });
      if (st.object === "GeoCountry") s.geoCountries.push({ id, name: String(v.Name), iso: String(v.IsoCode) });
      if (st.object === "TaxRate") s.rates.push({ id, name: id, taxCode: String(v.TaxCode), productCode: (v.ProductCode as string) ?? null, rate: Number(v.Rate), usage: String(v.RateUsageType), country: s.geoCountries.find(g => g.id === idOf(v.GeoCountryId))?.iso ?? null, geoCountryId: idOf(v.GeoCountryId), legalEntityId: (v.LegalEntityId as string) ?? null, start: (v.StartDate as string) ?? null, end: (v.EndDate as string) ?? null, effective: true, lastModified: null });
      if (st.object === "TaxPolicy") s.policies.push({ id, name: String(v.Name), status: String(v.Status), selection: String(v.TreatmentSelection), defaultTreatmentId: null, description: null, products: 0 });
      if (st.object === "TaxTreatment") s.treatments.push({ id, name: String(v.Name), status: String(v.Status), taxable: v.IsTaxable === true, taxCode: (v.TaxCode as string) ?? null, productCode: (v.ProductCode as string) ?? null, policyId: idOf(v.TaxPolicyId), engineId: v.TaxEngineId ? idOf(v.TaxEngineId) : null, legalEntityId: (v.LegalEntityId as string) ?? null, useItems: v.ShouldUseTaxTreatmentItems === true });
      if (st.object === "TaxTreatmentItem") s.items.push({ id, name: String(v.Name), treatmentId: idOf(v.TaxTreatmentId), productId: String(v.ProductId), productName: null, taxCode: (v.TaxCode as string) ?? null, productCode: null });
    } else {
      const target = idOf(st.recordId);
      if (st.object === "TaxTreatment") Object.assign(s.treatments.find(t => t.id === target)!, v.Status ? { status: v.Status } : {});
      if (st.object === "TaxPolicy") Object.assign(s.policies.find(p => p.id === target)!, { ...(v.Status ? { status: v.Status } : {}), ...(v.DefaultTaxTreatmentId ? { defaultTreatmentId: idOf(v.DefaultTaxTreatmentId) } : {}) });
      if (st.object === "Product2") { const p = PRODUCTS.find(x => x.id === target)!; p.taxPolicyId = idOf(v.TaxPolicyId); }
    }
  }
  return s;
}

const INDIA_GST = (): TaxConfigSpec => normalizeSpec({ engine: { type: "RevenueStandardTax" }, country: "India", policy: { suggestedName: "India GST Policy" }, treatments: [{ key: "t1", suggestedName: "India GST Standard", taxable: true, taxName: "GST", rate: 18 }], products: [{ product: { name: "Laptop" } }] });

test("Test 1 — standard taxable product: engine → geo → rate → policy → treatment → activation → product, in dependency order", () => {
  const plan = buildPlan(ctx(INDIA_GST()));
  assert.equal(errors(plan).length, 0, JSON.stringify(errors(plan)));
  const ids = plan.steps.map(s => s.id);
  for (const id of ["engine", "geo:IN", "rate:GST18|IN|0fwLE0000000001|LP001", "policy", "treatment:t1", "activate:treatment:t1", "activate:policy", "product:01tLAPTOP000001"]) assert.ok(ids.includes(id), `missing step ${id}`);
  assert.ok(ids.indexOf("geo:IN") < ids.indexOf("rate:GST18|IN|0fwLE0000000001|LP001"));
  assert.ok(ids.indexOf("policy") < ids.indexOf("treatment:t1"));
  assert.ok(ids.indexOf("activate:treatment:t1") < ids.indexOf("activate:policy"));
  assert.ok(ids.indexOf("activate:policy") < ids.indexOf("product:01tLAPTOP000001"));
  const t = plan.steps.find(s => s.id === "treatment:t1")!;
  assert.equal(t.fields.IsTaxable, true);
  assert.equal(t.fields.TaxCode, "GST18");
  assert.equal(t.fields.TaxEngineId, "@{engine}");
  assert.equal(t.fields.TaxPolicyId, "@{policy}");
  assert.equal(t.fields.Status, "Draft");
  assert.equal(plan.steps.find(s => s.id === "engine")!.fields.Type, "RevenueStandardTax");
  const rate = plan.steps.find(s => s.object === "TaxRate")!;
  assert.deepEqual([rate.fields.Rate, rate.fields.RateUsageType, rate.fields.GeoCountryId, rate.fields.LegalEntityId, rate.fields.ProductCode], [18, "RevCloud", "@{geo:IN}", LE.id, "LP001"], "keyed to the product's own code (E1c)");
  assert.equal(plan.refreshRequired, true);
  assert.ok(plan.issues.some(i => i.code === "DECISION_TABLE_REFRESH_REQUIRED"));
  assert.equal(plan.steps.find(s => s.id === "activate:policy")!.fields.DefaultTaxTreatmentId, "@{treatment:t1}");
  assert.ok(plan.issues.some(i => i.code === "PRODUCT_POLICY_CHANGES"), "moving Laptop off its current policy is warned");
});

test("Test 4 — the same request twice: the second run reuses everything and creates nothing", () => {
  const first = buildPlan(ctx(INDIA_GST()));
  const org = apply(emptySnapshot(), first);
  const second = buildPlan(ctx(INDIA_GST(), org));
  assert.equal(errors(second).length, 0, JSON.stringify(errors(second)));
  assert.equal(second.counts.create, 0, JSON.stringify(second.steps.filter(s => s.action === "create").map(s => s.id)));
  assert.equal(second.counts.update, 0, JSON.stringify(second.steps.filter(s => s.action === "update").map(s => s.id)));
  assert.ok(second.steps.every(s => s.action === "reuse"));
  // A differently-worded request for the same configuration also reuses it (equivalence, not name).
  const reworded = buildPlan(ctx(normalizeSpec({ country: "IN", policy: {}, treatments: [{ taxable: true, taxName: "GST", rate: 18 }], products: [{ product: { name: "Laptop" } }] }), org));
  assert.equal(reworded.counts.create, 0);
});

test("Test 2 — tax exempt treatment: not taxable, no engine or rate needed, product mapped", () => {
  const plan = buildPlan(ctx(normalizeSpec({ policy: {}, treatments: [{ taxable: false, suggestedName: "Exempt" }], products: [{ product: { name: "Book" } }] })));
  assert.equal(errors(plan).length, 0, JSON.stringify(errors(plan)));
  const t = plan.steps.find(s => s.object === "TaxTreatment" && s.action === "create")!;
  assert.equal(t.fields.IsTaxable, false);
  assert.equal(t.fields.TaxEngineId, undefined);
  assert.ok(!plan.steps.some(s => s.object === "TaxRate" || s.object === "TaxEngine"));
  assert.equal(plan.steps.find(s => s.id === "product:01tBOOK00000001")!.fields.TaxPolicyId, "@{policy}");
});

test("Test 3 — multiple products: one treatment with items, a code per rate, no treatment per product", () => {
  const spec = normalizeSpec({ country: "IN", policy: {}, treatments: [{ key: "t1", taxable: true, taxName: "GST", useItems: true }], items: [{ treatmentKey: "t1", product: { name: "Laptop" }, taxName: "GST", rate: 18 }, { treatmentKey: "t1", product: { name: "Software" }, taxName: "GST", rate: 18 }, { treatmentKey: "t1", product: { name: "Book" }, taxName: "GST", rate: 5 }] });
  const plan = buildPlan(ctx(spec));
  assert.equal(errors(plan).length, 0, JSON.stringify(errors(plan)));
  assert.equal(plan.steps.filter(s => s.object === "TaxTreatment" && s.action === "create").length, 1);
  assert.equal(plan.steps.find(s => s.object === "TaxTreatment" && s.action === "create")!.fields.ShouldUseTaxTreatmentItems, true);
  const items = plan.steps.filter(s => s.object === "TaxTreatmentItem");
  assert.deepEqual(items.map(i => i.fields.TaxCode), ["GST18", "GST18", "GST5"]);
  assert.deepEqual(plan.steps.filter(s => s.object === "TaxRate").map(s => [s.fields.TaxCode, s.fields.Rate, s.fields.ProductCode]), [["GST18", 18, "LP001"], ["GST18", 18, "SW001"], ["GST5", 5, "BK001"]]);
  assert.deepEqual(items.map(i => i.fields.ProductCode), ["LP001", "SW001", "BK001"], "items carry Product2.ProductCode (as in DOC-13/17)");
  assert.equal(plan.steps.filter(s => s.object === "Product2").length, 3);
});

test("Test 5 — invalid product: blocked, nothing created", () => {
  const plan = buildPlan(ctx(normalizeSpec({ country: "IN", policy: {}, treatments: [{ taxable: true, taxName: "GST", rate: 18 }], products: [{ product: { name: "Product That Does Not Exist" } }] })));
  assert.equal(plan.ok, false);
  assert.ok(errors(plan).some(e => e.code === "PRODUCT_NOT_FOUND" && /Product That Does Not Exist/.test(e.message)));
});

test("Test 6 — invalid tax code without a rate: blocked with the existing codes listed; with a rate it is created", () => {
  const snap = emptySnapshot();
  snap.rates.push({ id: "0xqEXIST0000001", name: "R1", taxCode: "GST18", productCode: "LP001", rate: 18, usage: "RevCloud", country: "US", geoCountryId: "0vfUS", legalEntityId: LE.id, start: null, end: null, effective: true, lastModified: null });
  const bad = buildPlan(ctx(normalizeSpec({ country: "US", policy: {}, treatments: [{ taxable: true, taxCode: "XYZ99" }] }), snap));
  assert.equal(bad.ok, false);
  const e = errors(bad).find(x => x.code === "INVALID_TAX_CODE")!;
  assert.ok(e && /XYZ99/.test(e.message) && /GST18/.test(e.message), JSON.stringify(errors(bad)));
  assert.ok(!bad.steps.some(s => s.object === "TaxTreatment" && s.fields.TaxCode === "XYZ99" && bad.ok));
  const good = buildPlan(ctx(normalizeSpec({ country: "US", policy: {}, treatments: [{ taxable: true, taxCode: "XYZ99", rate: 7 }], products: [{ product: { name: "Book" } }] }), snap));
  assert.equal(errors(good).length, 0, JSON.stringify(errors(good)));
  assert.ok(good.steps.some(s => s.object === "TaxRate" && s.action === "create" && s.fields.TaxCode === "XYZ99" && s.fields.ProductCode === "BK001"));
  // An existing code is reused, not duplicated.
  const reuse = buildPlan(ctx(normalizeSpec({ country: "US", policy: {}, treatments: [{ taxable: true, taxCode: "gst18" }], products: [{ product: { name: "Laptop" } }] }), snap));
  assert.ok(reuse.steps.some(s => s.object === "TaxRate" && s.action === "reuse" && s.recordId === "0xqEXIST0000001"));
});

test("a missing object is diagnosed, never fabricated", () => {
  const plan = buildPlan(ctx(INDIA_GST(), emptySnapshot(metadata(["TaxTreatment"]))));
  assert.equal(plan.ok, false);
  assert.ok(errors(plan).some(e => e.code === "MISSING_OBJECT" && /TaxTreatment/.test(e.message)));
  assert.ok(!plan.steps.some(s => s.object === "TaxTreatment" && s.action === "create"));
});

test("an Active treatment that differs is never edited", () => {
  const snap = emptySnapshot();
  snap.engines.push({ id: "4wAENG000000001", name: "Revenue Standard Tax Engine", type: "RevenueStandardTax", status: "Active", provider: null, sellerCode: null, native: true, decisionTableId: null });
  snap.policies.push({ id: "1TpPOL000000001", name: "GST Policy", status: "Active", selection: "Default", defaultTreatmentId: "1ttTRT000000001", description: null, products: 0 });
  snap.treatments.push({ id: "1ttTRT000000001", name: "GST Standard", status: "Active", taxable: true, taxCode: "GST12", productCode: "GST12", policyId: "1TpPOL000000001", engineId: "4wAENG000000001", legalEntityId: LE.id, useItems: false });
  const plan = buildPlan(ctx(normalizeSpec({ country: "US", policy: { name: "GST Policy" }, treatments: [{ name: "GST Standard", taxable: true, taxName: "GST", rate: 18 }] }), snap));
  assert.ok(errors(plan).some(e => e.code === "TREATMENT_IMMUTABLE"));
});

test("an external engine type needs a provider; the native one doesn't", () => {
  const ext = buildPlan(ctx(normalizeSpec({ engine: { type: "StandardTaxEngine" }, country: "US", policy: {}, treatments: [{ taxable: true, taxName: "VAT", rate: 20 }] })));
  assert.ok(errors(ext).some(e => e.code === "PROVIDER_REQUIRED"));
  const bad = buildPlan(ctx(normalizeSpec({ engine: { type: "Avalara" }, country: "US", policy: {}, treatments: [{ taxable: true, taxName: "VAT", rate: 20 }] })));
  assert.ok(errors(bad).some(e => e.code === "INVALID_ENGINE_TYPE" && /RevenueStandardTax/.test(e.message)));
});

test("Test 7 — AI and manual specs for the same configuration produce the same plan", () => {
  const ai = specFromAi({ isTaxConfiguration: true, engine: { type: "RevenueStandardTax" }, country: "India", policy: { name: null, suggestedName: "India GST Policy", treatmentSelection: "Default" }, treatments: [{ key: "t1", name: null, suggestedName: "India GST Standard", taxable: true, taxCode: null, taxName: "GST", rate: 18, useItems: false, isDefault: true }], items: [], products: [{ productName: "Laptop" }], notes: [] }).spec;
  const manual = normalizeSpec({ engine: { type: "RevenueStandardTax" }, country: "India", policy: { suggestedName: "India GST Policy", treatmentSelection: "Default" }, treatments: [{ key: "t1", suggestedName: "India GST Standard", taxable: true, taxName: "GST", rate: 18, isDefault: true }], products: [{ product: { name: "Laptop" } }] });
  const a = buildPlan(ctx(ai)), m = buildPlan(ctx(manual));
  assert.deepEqual(a.steps.map(s => [s.id, s.action, s.fields]), m.steps.map(s => [s.id, s.action, s.fields]));
});

test("AI output: Salesforce Ids are dropped", () => {
  const { spec, warnings } = specFromAi({ isTaxConfiguration: true, policy: { existingId: "1Tp000000000001AAA" }, treatments: [{ taxable: true, rate: 5, existingId: "1tt000000000001AAA" }], products: [] });
  assert.equal(spec.policy.existingId, null);
  assert.equal(spec.treatments[0].existingId, null);
  assert.ok(warnings.some(w => /Ignored Salesforce Ids/.test(w)));
});

test("AI test sale: names copied, numbers validated, nothing invented", () => {
  assert.deepEqual(transactionFromAi({ testTransaction: { productName: "Laptop Basic", quantity: 1, unitPrice: "₹10,000", accountName: "Burlington Textiles Corp of America" } }), { productName: "Laptop Basic", quantity: 1, unitPrice: 10000, accountName: "Burlington Textiles Corp of America" });
  assert.equal(transactionFromAi({ testTransaction: null }), null);
  assert.deepEqual(transactionFromAi({ testTransaction: { productName: "Laptop", quantity: -2, unitPrice: "abc", accountName: null } }), { productName: "Laptop", quantity: null, unitPrice: null, accountName: null });
});

/* ───────────── Rate Product Code (E1-B / E1c / E2 evidence) ───────────── */

const rateRow = (o: Partial<TaxSnapshot["rates"][number]>): TaxSnapshot["rates"][number] => ({ id: "0xqROW00000000X", name: "TR-X", taxCode: "GST18", productCode: null, rate: 18, usage: "RevCloud", country: "IN", geoCountryId: "0vfIN0000000001", legalEntityId: LE.id, start: "2026-01-01", end: null, effective: true, lastModified: null, state: null, city: null, zipCode: null, basis: "Net", priority: 1, ...o });
const withIN = () => { const s = emptySnapshot(); s.geoCountries.push({ id: "0vfIN0000000001", name: "India", iso: "IN" }); return s; };
const gstSpec = (o: Record<string, unknown> = {}) => normalizeSpec({ country: "IN", policy: {}, treatments: [{ taxable: true, taxCode: "GST18", rate: 18 }], products: [{ product: { name: "Laptop" } }], ...o });

test("rates: product-specific by default — ProductCode = Product2.ProductCode, never the tax code; no product → RATE_PRODUCT_REQUIRED (not a silent blank rate)", () => {
  const plan = buildPlan(ctx(gstSpec()));
  assert.equal(errors(plan).length, 0, JSON.stringify(errors(plan)));
  const rates = plan.steps.filter(s => s.object === "TaxRate" && s.action === "create");
  assert.deepEqual(rates.map(r => r.fields.ProductCode), ["LP001"]);
  assert.ok(!plan.issues.some(i => i.code === "BLANK_PRODUCT_CODE"));
  const none = buildPlan(ctx(normalizeSpec({ country: "IN", policy: {}, treatments: [{ taxable: true, taxCode: "GST18", rate: 18 }] })));
  assert.ok(errors(none).some(e => e.code === "RATE_PRODUCT_REQUIRED"));
  assert.ok(!none.steps.some(s => s.object === "TaxRate" && s.action === "create"), "no blank rate is invented");
});

test("rates: a product without a Product Code can't get a product-specific rate (PRODUCT_CODE_MISSING)", () => {
  const noCode = { id: "01tNOCODE000001", name: "No Code Product", code: null, active: true, taxPolicyId: null, family: null };
  PRODUCTS.push(noCode);
  try {
    const plan = buildPlan(ctx(normalizeSpec({ country: "IN", policy: {}, treatments: [{ taxable: true, taxCode: "GST18", rate: 18 }], products: [{ product: { name: "No Code Product" } }] })));
    assert.ok(errors(plan).some(e => e.code === "PRODUCT_CODE_MISSING"));
  } finally { PRODUCTS.pop(); }
});

test("rates: blank ProductCode only when explicitly requested — one rate, warned with the products it reaches; refresh required", () => {
  const plan = buildPlan({ ...ctx(gstSpec({ rateDefaults: { productCodeMode: "blank" } })), productsByTaxCode: { GST18: [{ name: "Laptop Basic", code: "LPB-001", viaItems: false }] } });
  assert.equal(errors(plan).length, 0, JSON.stringify(errors(plan)));
  const rates = plan.steps.filter(s => s.object === "TaxRate" && s.action === "create");
  assert.equal(rates.length, 1);
  assert.equal(rates[0].fields.ProductCode, undefined, "blank → the field isn't sent");
  const w = plan.issues.find(i => i.code === "BLANK_PRODUCT_CODE")!;
  assert.match(w.message, /EVERY product[\s\S]*Laptop Basic \[LPB-001\]/);
  assert.equal(plan.refreshRequired, true);
  // AI: only an explicit request becomes "blank".
  assert.equal(specFromAi({ isTaxConfiguration: true, country: "India", treatments: [{ taxable: true, rate: 18 }], rateProductCode: "blank" }).spec.rateDefaults?.productCodeMode, "blank");
  assert.equal(specFromAi({ isTaxConfiguration: true, country: "India", treatments: [{ taxable: true, rate: 18 }] }).spec.rateDefaults?.productCodeMode ?? null, null);
});

test("rates: a blank-code rate that would ALWAYS collide with an existing product-specific rate is BLOCKED (Multiple Matches)", () => {
  const snap = withIN();
  snap.rates.push(rateRow({ id: "0xqTR21000000001", name: "TR-00000021", productCode: "LPB-001" }));
  const plan = buildPlan(ctx(gstSpec({ rateDefaults: { productCodeMode: "blank" } }), snap));
  const e = errors(plan).find(x => x.code === "RATE_WOULD_BE_AMBIGUOUS")!;
  assert.ok(e, JSON.stringify(plan.issues));
  assert.match(e.message, /TR-00000021/);
  assert.equal(plan.ok, false);
});

test("rates: a product-specific rate that collides only conditionally (p10 E2 shape: an existing KA blank-code rate) is created with a WARNING", () => {
  const snap = withIN();
  snap.rates.push(rateRow({ id: "0xqTR22000000001", name: "TR-00000022", productCode: null, state: "KA" }));
  const plan = buildPlan(ctx(gstSpec(), snap));
  assert.equal(errors(plan).length, 0, JSON.stringify(errors(plan)));
  assert.ok(plan.issues.some(i => i.severity === "warning" && i.code === "AMBIGUOUS_RATE_OVERLAP" && /TR-00000022/.test(i.message)));
  assert.ok(plan.steps.some(s => s.object === "TaxRate" && s.action === "create" && s.fields.ProductCode === "LP001"));
});

test("rates: an existing rate is reused only for the SAME product code (E1-B's GST18-keyed rate is not reused for LP001)", () => {
  const snap = withIN();
  snap.rates.push(rateRow({ id: "0xqTR02000000001", name: "TR-00000002", productCode: "GST18" }));
  const plan = buildPlan(ctx(gstSpec(), snap));
  assert.ok(plan.steps.some(s => s.object === "TaxRate" && s.action === "create" && s.fields.ProductCode === "LP001"));
  assert.ok(!plan.steps.some(s => s.object === "TaxRate" && s.action === "reuse"));
  snap.rates.push(rateRow({ id: "0xqLP001000000001", name: "TR-LP", productCode: "LP001" }));
  const again = buildPlan(ctx(gstSpec(), snap));
  assert.ok(again.steps.some(s => s.object === "TaxRate" && s.action === "reuse" && s.recordId === "0xqLP001000000001"));
  assert.notEqual(again.refreshRequired, true, "nothing new → no refresh needed");
});

test("engine reuse prefers an engine that has its own decision table; one without is warned", () => {
  const snap = emptySnapshot();
  snap.engines.push({ id: "4wAOLD000000001", name: "Old Engine", type: "RevenueStandardTax", status: "Active", provider: null, sellerCode: null, native: true, decisionTableId: null });
  snap.engines.push({ id: "4wADT0000000001", name: "Engine With Table", type: "RevenueStandardTax", status: "Active", provider: null, sellerCode: null, native: true, decisionTableId: "0lDTABLE0000001" });
  const plan = buildPlan(ctx(gstSpec(), snap));
  assert.equal(plan.steps.find(s => s.id === "engine")?.recordId, "4wADT0000000001");
  const only = emptySnapshot();
  only.engines.push(snap.engines[0]);
  assert.ok(buildPlan(ctx(gstSpec(), only)).issues.some(i => i.code === "ENGINE_NO_DECISION_TABLE"));
});
