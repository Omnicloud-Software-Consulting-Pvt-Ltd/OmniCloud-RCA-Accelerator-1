/**
 * Product Revenue Cloud configuration — prompt parsing, relationship resolution, configuration read, readiness and targeted
 * updates, against an in-memory org (a tiny SOQL evaluator over fixture records).
 *
 * Run: `npx tsx --test lib/products/revenueConfig.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { buildProductIntent } from "@/lib/products/ai/productIntent";
import { mergePromptConfiguration, mentionedConfiguration, parseRevenueConfigPrompt } from "@/lib/products/revenueConfig";
import { parseProductCommand } from "@/lib/products/productCommand";
import { executeProductUpdate, planProductUpdate, productReadiness, readProductConfiguration, relationsOf, resolveRevenueConfig, verifyRequestedConfiguration, type ConfigApi } from "@/lib/products/server/revenueConfig";

/* ── fixture org ── */
const PROD = "01t000000000QTL", PROD2 = "01t000000000OTH";
type Row = Record<string, unknown>;
function org(extra: Partial<Record<string, Row[]>> = {}) {
  const data: Record<string, Row[]> = {
    Product2: [
      { Id: PROD, Name: "OmniCloud Prompt E2E Quantum Laptop 2026", ProductCode: "OC-PROMPT-QTL-20261008", Family: "Software", Description: "Test", IsActive: true, TaxPolicyId: null, BillingPolicyId: null, QuantityUnitOfMeasure: "Each", UnitOfMeasureId: "0hE000000000EAC", UnitOfMeasure: { Name: "Each" } },
      { Id: PROD2, Name: "Other Product", ProductCode: "OTH", IsActive: true },
    ],
    TaxPolicy: [
      { Id: "1Tp000000000IND", Name: "OmniCloud India Tax Policy", Status: "Active", TreatmentSelection: "Default", DefaultTaxTreatmentId: "1tt000000000IND", CreatedDate: "1" },
      { Id: "1Tp000000000GER", Name: "Desktop Germany Tax Policy", Status: "Active", TreatmentSelection: "Default", DefaultTaxTreatmentId: "1tt000000000GER", CreatedDate: "2" },
    ],
    TaxTreatment: [
      { Id: "1tt000000000IND", Name: "OmniCloud India Tax Treatment", Status: "Active", TaxPolicyId: "1Tp000000000IND", TaxEngineId: "4wA000000000RST", IsTaxable: true, TaxCode: "OC_GST_18", ProductCode: null, ShouldUseTaxTreatmentItems: true, CreatedDate: "1" },
      { Id: "1tt000000000GER", Name: "Desktop Germany Tax Treatment", Status: "Active", TaxPolicyId: "1Tp000000000GER", TaxEngineId: "4wA000000000RST", IsTaxable: true, ShouldUseTaxTreatmentItems: true, CreatedDate: "2" },
      { Id: "1tt000000000IN2", Name: "OmniCloud India Exempt Treatment", Status: "Active", TaxPolicyId: "1Tp000000000IND", TaxEngineId: "4wA000000000RST", IsTaxable: false, CreatedDate: "3" },
    ],
    TaxTreatmentItem: [{ Id: "1tu000000000IND", Name: "OmniCloud India Tax Treatment Item", TaxTreatmentId: "1tt000000000IND", ProductId: PROD, TaxCode: "OC_GST_18", ProductCode: "OC-PROMPT-QTL-20261008", CreatedDate: "1" }],
    TaxEngine: [{ Id: "4wA000000000RST", TaxEngineName: "Revenue Standard Tax Engine", Type: "RevenueStandardTax", Status: "Active", DecisionTableId: "0lD000000000DT1", CreatedDate: "1" }],
    BillingPolicy: [
      { Id: "1BP000000000ADV", Name: "Billing Policy - Advance", Status: "Active", BillingTreatmentSelection: "Default", DefaultBillingTreatmentId: "1BT000000000ADV", CreatedDate: "1" },
      { Id: "1BP000000000E2E", Name: "OmniCloud Prompt E2E Billing Policy", Status: "Active", BillingTreatmentSelection: "Default", DefaultBillingTreatmentId: "1BT000000000E2E", CreatedDate: "2" },
    ],
    BillingTreatment: [
      { Id: "1BT000000000ADV", Name: "Billing Treatment - Advance", Status: "Active", BillingPolicyId: "1BP000000000ADV", CreatedDate: "1" },
      { Id: "1BT000000000E2E", Name: "OmniCloud Prompt E2E Billing Treatment", Status: "Active", BillingPolicyId: "1BP000000000E2E", CreatedDate: "2" },
    ],
    BillingTreatmentItem: [
      { Id: "1BD000000000ADV", Name: "Billing Treatment Item - Advance", Status: "Active", BillingTreatmentId: "1BT000000000ADV", Type: "Remainder", BillingType: "Advance", CreatedDate: "1" },
      { Id: "1BD000000000E2E", Name: "OmniCloud Prompt E2E Billing Treatment Item", Status: "Active", BillingTreatmentId: "1BT000000000E2E", Type: "Remainder", BillingType: "Advance", CreatedDate: "2" },
    ],
    ProductSellingModelOption: [{ Id: "0iO000000000001", Product2Id: PROD, ProductSellingModelId: "0jP000000000ONE", ProductSellingModel: { Name: "One Time", SellingModelType: "OneTime" } }],
    ProductCategoryProduct: [{ Id: "0ZR000000000001", ProductId: PROD, ProductCategoryId: "0ZG000000000LAP", ProductCategory: { Name: "Laptops", CatalogId: "0ZS000000000RCC", Catalog: { Name: "Revenue Cloud Catalog" } } }],
    PricebookEntry: [{ Id: "01u000000000001", Product2Id: PROD, UnitPrice: 2500, IsActive: true, Pricebook2Id: "01s000000000STD", Pricebook2: { Name: "Standard Price Book", IsStandard: true }, ProductSellingModel: { Name: "One Time" } }],
    UnitOfMeasure: [{ Id: "0hE000000000EAC", Name: "Each", UnitCode: "EACH", Status: "Active" }, { Id: "0hE000000000HRS", Name: "Hour", UnitCode: "HR", Status: "Active" }],
    ...extra,
  };
  const queries: string[] = [];
  const cond = (row: Row, c: string): boolean => {
    const m = /^\s*([\w.]+)\s*(=|LIKE)\s*'((?:[^'\\]|\\.)*)'\s*$/i.exec(c);
    if (!m) throw new Error(`fake SOQL can't evaluate: ${c}`);
    const v = m[1].split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Row)[k] : undefined), row);
    const want = m[3].replace(/\\(.)/g, "$1");
    if (m[2].toUpperCase() === "LIKE") return String(v ?? "").toLowerCase().includes(want.replace(/%/g, "").toLowerCase());
    // 15/18-character Id equivalence applies to Id fields only (never to names).
    return String(v ?? "") === want || (/Id$/.test(m[1]) && typeof v === "string" && v.slice(0, 15) === want.slice(0, 15) && want.length >= 15);
  };
  const api: ConfigApi = {
    query: async soql => {
      queries.push(soql);
      if (!/^\s*SELECT\s/i.test(soql)) throw new Error("only SELECT");
      const obj = /\bFROM\s+(\w+)/i.exec(soql)![1];
      const where = /\bWHERE\s+(.+?)(?:\s+ORDER BY|\s+LIMIT|$)/i.exec(soql)?.[1];
      const limit = Number(/\bLIMIT\s+(\d+)/i.exec(soql)?.[1] ?? 1000);
      let rows = data[obj] ?? [];
      if (where) rows = rows.filter(r => where.split(/\s+OR\s+/i).some(orPart => orPart.split(/\s+AND\s+/i).every(c => cond(r, c))));
      return structuredClone(rows.slice(0, limit));
    },
    describe: async object => {
      const names = new Set<string>(["Id", "Name", ...Object.keys(data[object]?.[0] ?? {})]);
      if (object === "Product2") ["TaxPolicyId", "BillingPolicyId", "QuantityUnitOfMeasure", "UnitOfMeasureId"].forEach(n => names.add(n));
      if (object === "PricebookEntry") ["Pricebook2Id", "ProductSellingModelId"].forEach(n => names.add(n));
      return [...names].map(name => ({ name, picklistValues: name === "QuantityUnitOfMeasure" ? [{ value: "Each", active: true }, { value: "Hour", active: true }] : undefined }));
    },
  };
  return { api, data, queries };
}

/** Fake SalesforceClient for executeProductUpdate: records writes and applies them to the fixture. */
function fakeClient(d: Record<string, Row[]>) {
  const writes: { op: string; object: string; id?: string; body: Row }[] = [];
  const client = {
    updateRecord: async (object: string, id: string, body: Row) => {
      writes.push({ op: "update", object, id, body });
      const row = d[object].find(r => r.Id === id)!;
      Object.assign(row, body);
      if (body.UnitOfMeasureId) row.UnitOfMeasure = { Name: d.UnitOfMeasure.find(u => u.Id === body.UnitOfMeasureId)?.Name };
    },
    describeObject: async () => ({ fields: [{ name: "UnitOfMeasureId", updateable: true, createable: true }, { name: "QuantityUnitOfMeasure", updateable: true, createable: true, picklistValues: [{ value: "Each", active: true }, { value: "Hour", active: true }] }] }),
    query: async (soql: string) => ({ records: /FROM UnitOfMeasure/.test(soql) ? d.UnitOfMeasure.filter(u => soql.includes(`'${u.Name}'`) || soql.includes(`'${u.UnitCode}'`)) : [] }),
  } as unknown as SalesforceClient;
  return { client, writes };
}

const E2E_PROMPT = "Create a new product called OmniCloud Prompt E2E Quantum Laptop 2026. Product code OC-PROMPT-QTL-20261008. Family Software. Unit of Measure Each. One Time Product Selling Model. Catalog Revenue Cloud Catalog. Category Laptops. Price 2500. Assign the India Tax Policy. Assign the India Tax Treatment. Assign the Advance Billing Policy. Assign the Advance Billing Treatment.";

/* ═════════ Parsing (1–4, 9) ═════════ */

test("1. product with only basic fields: no tax/billing extracted, nothing reported as dropped", () => {
  const p = "Create a laptop called ThinkPad X1, family Hardware, code TP-X1.";
  assert.deepEqual(parseRevenueConfigPrompt(p).relations, {});
  const { payload } = buildProductIntent({ productName: "ThinkPad X1", productCode: "TP-X1", family: "Hardware" });
  for (const k of ["taxPolicy", "taxTreatment", "billingPolicy", "billingTreatment"] as const) assert.equal(payload[k], undefined);
  assert.deepEqual(mergePromptConfiguration(p, { catalog: null }, []).notes, []);
});

test("2. product + Unit of Measure: carried through the intent; a mentioned-but-missing UoM is reported", () => {
  assert.equal(buildProductIntent({ productName: "X", unitOfMeasure: "Each" }).payload.unitOfMeasure, "Each");
  assert.ok(mentionedConfiguration("Software, Each, One Time").includes("Unit of Measure"));
  assert.match(mergePromptConfiguration("Create X. Unit of Measure.", { unitOfMeasure: null }, []).notes.join(), /Unit of Measure was mentioned/);
});

test("3. product + Product Selling Model: explicit value kept; mentioned without a value is reported", () => {
  const i = buildProductIntent({ productName: "X", sellingModel: "One Time" });
  assert.deepEqual([i.payload.sellingModel, i.intent.sellingModel.provenance], ["One Time", "explicit"]);
  assert.match(mergePromptConfiguration("Create X with a one-time selling model", { sellingModel: null }, []).notes.join(), /Product Selling Model was mentioned/);
});

test("4. product + Catalog + Category: values kept; 'assign catalog and category' without names is reported, not dropped", () => {
  const i = buildProductIntent({ productName: "X", catalog: "Revenue Cloud Catalog", category: "Laptops" });
  assert.deepEqual([i.payload.catalog, i.payload.category], ["Revenue Cloud Catalog", "Laptops"]);
  const notes = mergePromptConfiguration("Create X, assign catalog and category, price 2500", { catalog: null, category: null, basePrice: "2500" }, []).notes;
  assert.ok(notes.some(n => /^Catalog was mentioned/.test(n)) && notes.some(n => /^Category was mentioned/.test(n)));
});

test("9a. complete prompt: every tax/billing relationship is extracted (incl. shared qualifiers)", () => {
  assert.deepEqual(parseRevenueConfigPrompt(E2E_PROMPT).relations, { taxPolicy: "India Tax Policy", taxTreatment: "India Tax Treatment", billingPolicy: "Advance Billing Policy", billingTreatment: "Advance Billing Treatment" });
  const short = "Create a product called Q, code C, Software, Each, One Time, assign catalog and category, price 2500, assign the India Tax Policy and Tax Treatment, and assign the Advance Billing Policy and Billing Treatment.";
  assert.deepEqual(parseRevenueConfigPrompt(short).relations, { taxPolicy: "India Tax Policy", taxTreatment: "India Tax Treatment", billingPolicy: "Advance Billing Policy", billingTreatment: "Advance Billing Treatment" });
  assert.deepEqual(parseRevenueConfigPrompt("Assign Tax Policy = OmniCloud India Tax Policy").relations, { taxPolicy: "OmniCloud India Tax Policy" });
  assert.deepEqual(parseRevenueConfigPrompt("Assign Billing Policy OmniCloud Prompt E2E Billing Policy.").relations, { billingPolicy: "OmniCloud Prompt E2E Billing Policy" });
  assert.equal(parseRevenueConfigPrompt("tax code OC_GST_18, use the Standard Price Book").taxCode, "OC_GST_18");
  assert.equal(parseRevenueConfigPrompt("use the Standard Price Book").priceBook, "Standard Price Book");
  assert.deepEqual(parseRevenueConfigPrompt("Assign the tax policy").unnamed, ["Tax Policy"]);
  // AI value wins; the parser fills the gaps
  const m = mergePromptConfiguration(E2E_PROMPT, { taxPolicy: "OmniCloud India Tax Policy", catalog: "Revenue Cloud Catalog", category: "Laptops", sellingModel: "One Time", unitOfMeasure: "Each", basePrice: "2500" }, ["warranty 2 years"]);
  assert.deepEqual([m.values.taxPolicy, m.values.billingTreatment], ["OmniCloud India Tax Policy", "Advance Billing Treatment"]);
  assert.ok(m.notes.some(n => /warranty 2 years/.test(n)), "AI-flagged unsupported configuration is reported");
});

/* ═════════ Resolution (5–8, 9b, 10–13) ═════════ */

test("5. product + Tax Policy → Product2.TaxPolicyId (resolved by partial name, flagged for confirmation)", async () => {
  const { api } = org();
  const r = await resolveRevenueConfig(api, { relations: { taxPolicy: "India Tax Policy" } }, null);
  assert.equal(r.product2.TaxPolicyId, "1Tp000000000IND");
  assert.deepEqual([r.resolutions[0].status, r.resolutions[0].matchedBy], ["resolved", "partial"]);
  assert.ok(r.warnings.some(w => /partial name/.test(w)));
  const exact = await resolveRevenueConfig(api, { relations: { taxPolicy: "OmniCloud India Tax Policy" } }, null);
  assert.equal(exact.resolutions[0].matchedBy, "exact");
});

test("6. product + Tax Treatment → the policy is derived (Product2 can only reference the policy); a non-default treatment is a mismatch", async () => {
  const { api } = org();
  const r = await resolveRevenueConfig(api, { relations: { taxTreatment: "OmniCloud India Tax Treatment" } }, null);
  assert.equal(r.product2.TaxPolicyId, "1Tp000000000IND");
  assert.equal(r.resolutions.find(x => x.key === "taxPolicy")?.status, "derived");
  const bad = await resolveRevenueConfig(api, { relations: { taxPolicy: "OmniCloud India Tax Policy", taxTreatment: "OmniCloud India Exempt Treatment" } }, null);
  assert.equal(bad.resolutions.find(x => x.key === "taxTreatment")?.status, "mismatch");
  assert.ok(bad.blockers.some(b => /default treatment/.test(b)));
  const wrongPolicy = await resolveRevenueConfig(api, { relations: { taxPolicy: "Desktop Germany Tax Policy", taxTreatment: "OmniCloud India Tax Treatment" } }, null);
  assert.ok(wrongPolicy.blockers.some(b => /belongs to another Tax Policy/.test(b)));
});

test("7. product + Billing Policy → Product2.BillingPolicyId", async () => {
  const r = await resolveRevenueConfig(org().api, { relations: { billingPolicy: "Advance Billing Policy" } }, null);
  assert.equal(r.product2.BillingPolicyId, "1BP000000000ADV");
});

test("8. product + Billing Treatment → policy derived; a treatment of another policy is a mismatch", async () => {
  const { api } = org();
  const r = await resolveRevenueConfig(api, { relations: { billingTreatment: "Advance Billing Treatment" } }, null);
  assert.equal(r.product2.BillingPolicyId, "1BP000000000ADV");
  const bad = await resolveRevenueConfig(api, { relations: { billingPolicy: "Billing Policy - Advance", billingTreatment: "OmniCloud Prompt E2E Billing Treatment" } }, null);
  assert.ok(bad.blockers.some(b => /belongs to another Billing Policy/.test(b)));
});

test("9b. complete product + tax + billing: one consistent chain; a product-specific Tax Treatment Item is a pending dependency on create", async () => {
  const { api } = org();
  const r = await resolveRevenueConfig(api, { relations: { taxPolicy: "India Tax Policy", taxTreatment: "India Tax Treatment", taxTreatmentItem: "OmniCloud India Tax Treatment Item", taxEngine: "Revenue Standard Tax Engine", billingPolicy: "Advance Billing Policy", billingTreatment: "Advance Billing Treatment", billingTreatmentItem: "Billing Treatment Item - Advance" } }, null);
  assert.deepEqual(r.product2, { TaxPolicyId: "1Tp000000000IND", BillingPolicyId: "1BP000000000ADV" });
  assert.deepEqual(r.blockers, []);
  const item = r.resolutions.find(x => x.key === "taxTreatmentItem")!;
  assert.equal(item.dependency, true);
  assert.ok(r.warnings.some(w => /pending dependency/.test(w)));
  // the engine must be the treatment's engine
  const { api: a2, data } = org();
  data.TaxEngine.push({ Id: "4wA000000000OTH", TaxEngineName: "Other Engine", Type: "RevenueStandardTax", Status: "Active" });
  const e = await resolveRevenueConfig(a2, { relations: { taxPolicy: "OmniCloud India Tax Policy", taxEngine: "Other Engine" } }, null);
  assert.ok(e.blockers.some(b => /isn't the engine of Tax Treatment/.test(b)));
});

test("10. unknown Tax Policy → not found, blocks (never created)", async () => {
  const r = await resolveRevenueConfig(org().api, { relations: { taxPolicy: "Atlantis Tax Policy" } }, null);
  assert.equal(r.resolutions[0].status, "not_found");
  assert.match(r.blockers[0], /doesn't exist in this org \(not created automatically\)/);
  assert.equal(r.product2.TaxPolicyId, undefined);
});

test("11. unknown Billing Policy → not found, blocks", async () => {
  const r = await resolveRevenueConfig(org().api, { relations: { billingPolicy: "Quarterly Magic Billing Policy" } }, null);
  assert.equal(r.resolutions[0].status, "not_found");
  assert.equal(r.product2.BillingPolicyId, undefined);
});

test("12. ambiguous Tax Policy → candidates, no guess; choosing an Id resolves it", async () => {
  const { api } = org({ TaxPolicy: [
    { Id: "1Tp00000000AAA1", Name: "India Tax Policy", Status: "Active", TreatmentSelection: "Default", CreatedDate: "1" },
    { Id: "1Tp00000000AAA2", Name: "India Tax Policy", Status: "Draft", TreatmentSelection: "Default", CreatedDate: "2" },
  ] });
  const r = await resolveRevenueConfig(api, { relations: { taxPolicy: "India Tax Policy" } }, null);
  assert.equal(r.resolutions[0].status, "ambiguous");
  assert.deepEqual(r.resolutions[0].candidates.map(c => c.id), ["1Tp00000000AAA1", "1Tp00000000AAA2"]);
  assert.equal(r.product2.TaxPolicyId, undefined);
  const picked = await resolveRevenueConfig(api, { relations: { taxPolicy: "India Tax Policy" }, ids: { taxPolicy: "1Tp00000000AAA1" } }, null);
  assert.deepEqual([picked.resolutions[0].status, picked.product2.TaxPolicyId], ["resolved", "1Tp00000000AAA1"]);
});

test("13. ambiguous Billing Policy (partial name matching several) → candidates", async () => {
  const r = await resolveRevenueConfig(org().api, { relations: { billingPolicy: "Billing Policy" /* only type words */ } }, null);
  assert.equal(r.resolutions[0].status, "invalid", "a bare type name names nothing");
  const { api } = org({ BillingPolicy: [{ Id: "1BP00000000B001", Name: "Advance Monthly", Status: "Active" }, { Id: "1BP00000000B002", Name: "Advance Yearly", Status: "Active" }] });
  const amb = await resolveRevenueConfig(api, { relations: { billingPolicy: "Advance Billing Policy" } }, null);
  assert.equal(amb.resolutions[0].status, "ambiguous");
  assert.equal(amb.resolutions[0].candidates.length, 2);
});

/* ═════════ Targeted updates (14–16) ═════════ */

test("14. update only the Tax Policy: before → after preview, Product2.TaxPolicyId is the ONLY write, then verified", async () => {
  const { api, data } = org();
  const plan = await planProductUpdate(api, PROD, { relations: { taxPolicy: "OmniCloud India Tax Policy" } });
  assert.deepEqual(plan.changes.map(c => [c.field, c.from, c.to]), [["TaxPolicyId", null, "OmniCloud India Tax Policy (1Tp000000000IND)"]]);
  const { client, writes } = fakeClient(data);
  const out = await executeProductUpdate(client, api, PROD, { relations: { taxPolicy: "OmniCloud India Tax Policy" } });
  assert.deepEqual(writes, [{ op: "update", object: "Product2", id: PROD, body: { TaxPolicyId: "1Tp000000000IND" } }]);
  assert.equal(out.ok, true);
  assert.equal(out.after?.tax.treatment.record?.name, "OmniCloud India Tax Treatment", "the treatment resolves through the policy");
});

test("15. update only the Billing Policy (by a prompt): only BillingPolicyId is written", async () => {
  const cmd = parseProductCommand("Assign Billing Policy OmniCloud Prompt E2E Billing Policy.");
  assert.equal(cmd.kind, "update");
  const { api, data } = org();
  const { client, writes } = fakeClient(data);
  const out = await executeProductUpdate(client, api, PROD, { relations: cmd.kind === "update" ? cmd.change.relations : {} });
  assert.deepEqual(writes.map(w => w.body), [{ BillingPolicyId: "1BP000000000E2E" }]);
  assert.deepEqual(out.after?.billing.treatmentItems.map(i => i.name), ["OmniCloud Prompt E2E Billing Treatment Item"]);
});

test("16. update only the Unit of Measure: validated against the org's values; nothing else written; invalid value blocks", async () => {
  const { api, data } = org();
  const plan = await planProductUpdate(api, PROD, { unitOfMeasure: "Hour" });
  assert.deepEqual(plan.changes.map(c => [c.label, c.from, c.to]), [["Unit of Measure", "Each", "Hour"]]);
  const { client, writes } = fakeClient(data);
  const out = await executeProductUpdate(client, api, PROD, { unitOfMeasure: "Hour" });
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].body).sort(), ["QuantityUnitOfMeasure", "UnitOfMeasureId"]);
  assert.equal(out.after?.product.unitOfMeasure.value, "Hour");
  const bad = await planProductUpdate(org().api, PROD, { unitOfMeasure: "Parsec" });
  assert.match(bad.blockers[0], /isn't a UnitOfMeasure record or Quantity Unit Of Measure value/);
  const same = await planProductUpdate(org().api, PROD, { unitOfMeasure: "Each" });
  assert.deepEqual(same.changes, []);
});

test("update commands are parsed for the product and only the requested change", () => {
  assert.deepEqual(parseProductCommand("Update OmniCloud Prompt E2E Quantum Laptop 2026 and assign the OmniCloud India Tax Policy."), { kind: "update", product: "OmniCloud Prompt E2E Quantum Laptop 2026", change: { relations: { taxPolicy: "OmniCloud India Tax Policy" }, unitOfMeasure: null, unitPrice: null, priceBook: null }, unnamed: [] });
  assert.deepEqual(parseProductCommand("Change the Unit of Measure to Each.").kind === "update" && (parseProductCommand("Change the Unit of Measure to Each.") as { change: { unitOfMeasure: string } }).change.unitOfMeasure, "Each");
  assert.equal((parseProductCommand("Change the price to 2500.") as { change: { unitPrice: string } }).change.unitPrice, "2500");
  assert.equal(parseProductCommand("Create a product called X").kind, "create");
});

/* ═════════ Show configuration (17) + readiness + verification ═════════ */

test("17. show the complete configuration: every section resolved from Salesforce, direct vs related labelled", async () => {
  const cmd = parseProductCommand("Show me the configuration of OmniCloud Prompt E2E Quantum Laptop 2026");
  assert.deepEqual(cmd, { kind: "show", product: "OmniCloud Prompt E2E Quantum Laptop 2026" });
  const { api, data } = org();
  Object.assign(data.Product2[0], { TaxPolicyId: "1Tp000000000IND", BillingPolicyId: "1BP000000000E2E" });
  const c = await readProductConfiguration(api, PROD);
  assert.deepEqual([c.product.code, c.product.unitOfMeasure.value, c.product.unitOfMeasure.source], ["OC-PROMPT-QTL-20261008", "Each", "Product2.UnitOfMeasureId"]);
  assert.deepEqual([c.revenue.sellingModels[0].name, c.revenue.catalogs[0].name, c.revenue.categories[0].name, c.revenue.pricebookEntries[0].unitPrice], ["One Time", "Revenue Cloud Catalog", "Laptops", 2500]);
  assert.deepEqual([c.tax.policy.record?.name, c.tax.policy.direct, c.tax.treatment.record?.name, c.tax.treatment.direct], ["OmniCloud India Tax Policy", true, "OmniCloud India Tax Treatment", false]);
  assert.deepEqual([c.tax.treatmentItem.record?.name, c.tax.engine.record?.name, c.tax.taxCode.value, c.tax.taxable.value], ["OmniCloud India Tax Treatment Item", "Revenue Standard Tax Engine", "OC_GST_18", true]);
  assert.deepEqual([c.billing.policy.record?.name, c.billing.treatment.record?.name, c.billing.treatmentItems[0].name], ["OmniCloud Prompt E2E Billing Policy", "OmniCloud Prompt E2E Billing Treatment", "OmniCloud Prompt E2E Billing Treatment Item"]);
  assert.equal(c.readiness.ready, true);
});

test("readiness names every gap and never claims ready: missing Tax Policy / Billing Policy", async () => {
  const c = await readProductConfiguration(org().api, PROD);
  assert.equal(c.readiness.ready, false);
  assert.ok(c.readiness.missing.includes("Tax Policy") && c.readiness.missing.includes("Billing Policy"), c.readiness.missing.join());
  const bare = productReadiness({ ...c, revenue: { sellingModels: [], catalogs: [], categories: [], pricebookEntries: [] } });
  for (const m of ["Product Selling Model", "Catalog", "Category", "Pricebook Entry", "Unit Price"]) assert.ok(bare.missing.includes(m), m);
});

test("verification compares each request with the re-read configuration; relationsOf reads the payload", async () => {
  const { api, data } = org();
  data.Product2[0].TaxPolicyId = "1Tp000000000IND";
  const c = await readProductConfiguration(api, PROD);
  const res = await resolveRevenueConfig(api, { relations: { taxPolicy: "OmniCloud India Tax Policy", billingPolicy: "Advance Billing Policy" } }, PROD);
  const v = verifyRequestedConfiguration(c, res, "OC_GST_18");
  assert.deepEqual(v.map(x => [x.label, x.passed]), [["Tax Policy", true], ["Billing Policy", false], ["Tax Code", true]]);
  assert.deepEqual(relationsOf({ taxPolicy: " India Tax Policy ", billingPolicy: "", relationIds: { taxPolicy: "1Tp000000000IND" } }), { relations: { taxPolicy: "India Tax Policy" }, ids: { taxPolicy: "1Tp000000000IND" }, requested: true });
});

test("price update: before → after on the standard price book only", async () => {
  const plan = await planProductUpdate(org().api, PROD, { unitPrice: "2999" });
  assert.deepEqual(plan.changes.map(c => [c.field, c.from, c.to]), [["UnitPrice", "2500", "2999"]]);
  const bad = await planProductUpdate(org().api, PROD, { unitPrice: "abc" });
  assert.equal(bad.changes.length, 0);
  assert.ok(bad.blockers.length > 0);
});

test("resolution and reads are SELECT-only", async () => {
  const { api, queries } = org();
  await resolveRevenueConfig(api, { relations: { taxPolicy: "India Tax Policy", billingTreatment: "Advance Billing Treatment" } }, null);
  await readProductConfiguration(api, PROD);
  assert.ok(queries.length > 5);
  for (const q of queries) assert.match(q, /^\s*SELECT\s/i);
});
