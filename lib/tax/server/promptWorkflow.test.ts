/**
 * Prompt-driven tax calculation workflow (2026-10-13). MOCKED / PURE — no test here touches a Salesforce org: plans are built from
 * in-memory snapshots shaped like p10's records (Laptop Basic / LPB-001 / GST18, Mouse / MO001 / the two Draft Canada
 * configurations), Salesforce access is a fake. The real-org evidence lives in the E1-B / E1c / E2 / E1R runs, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { parseTaxQuery } from "@/lib/tax/server/taxQuery";
import { buildCalculationPlan, type PlanFacts } from "@/lib/tax/server/calculationPlan";
import { isFresh } from "@/lib/tax/server/decisionTable";
import { exactDuplicateRates } from "@/lib/billing/server/rules";
import { evaluateOrderItemTax, type OrderItemTaxFacts, type TaxTreatmentFact } from "@/lib/tax/server/orderItemTax";
import { invoiceTaxBlockers, scheduleTreatmentBlockers } from "@/lib/billing/server/orderBilling";
import { deriveSalesforceTax, errorLogUnavailable, type TaxInvoice } from "@/lib/tax/server/invoiceTax";
import { decisionTableRefresh, refreshToken } from "@/lib/tax/server/refreshApproval";
import { AiServiceError, noAiKeyResponse } from "@/lib/tax/server/route";
import { BadInputError } from "@/lib/billing/server/payments";
import { POST as directCalculationRoute } from "@/app/api/taxes/calculation/route";
import type { TaxRuntimeApi } from "@/lib/tax/server/runtime";
import type { DecisionTableState } from "@/lib/tax/server/engine";
import type { FieldMeta, ObjectMeta, TaxMetadata } from "@/lib/tax/types";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/* ───────────── p10-shaped fixtures ───────────── */

const LE = "0fwg8000000FFefAAG", ENG = "4wAg80000002mBpEAI", DT = "0lDg8000000HC3BEAW";
const IN = { id: "0vfg80000001P9FAAU", name: "India", iso: "IN" }, CA = { id: "0vfg80000001SYXAA2", name: "Canada", iso: "CA" };
const MOUSE = { id: "01tg8000006f8uQAAQ", name: "Mouse", code: "MO001", active: true, taxPolicyId: "1Tpg8000000HTlZCAW" };
const LPB = { id: "01tg80000072GsfAAE", name: "Laptop Basic", code: "LPB-001", active: true, taxPolicyId: "1Tpg8000000HJ9VCAW" };
const rate = (o: Partial<PlanFacts["snapshot"]["rates"][number]>) => ({ id: "0xq000000000001", name: "TR-X", taxCode: "GST18", productCode: null, rate: 18, usage: "RevCloud", country: "IN", geoCountryId: IN.id, legalEntityId: LE, start: "2026-01-01", end: null, effective: true, lastModified: null, state: null, city: null, zipCode: null, basis: "Net", priority: 1, ...o });

function facts(o: { product?: PlanFacts["product"]; accounts?: PlanFacts["accounts"]; extraRates?: PlanFacts["snapshot"]["rates"]; extraEngines?: PlanFacts["snapshot"]["engines"]; les?: PlanFacts["snapshot"]["legalEntities"]; mouseTreatment?: Partial<PlanFacts["snapshot"]["treatments"][number]>; stale?: boolean } = {}): PlanFacts {
  return {
    product: o.product === undefined ? MOUSE : o.product, productMessage: o.product === null ? "No Salesforce product is named \"Mous\"." : null, listPrice: 7.99,
    snapshot: {
      policies: [
        { id: LPB.taxPolicyId, name: "GST18 Tax Policy", status: "Active", selection: "Default", defaultTreatmentId: "1ttg8000000OjtdAAC", description: null, products: 2 },
        { id: MOUSE.taxPolicyId, name: "Mouse Canada Sales Tax Policy", status: "Draft", selection: "Manual", defaultTreatmentId: null, description: null, products: 1 },
        { id: "1Tpg8000000HU89CAG", name: "Mouse Canada Tax Policy", status: "Draft", selection: "Manual", defaultTreatmentId: null, description: null, products: 0 },
      ],
      treatments: [
        { id: "1ttg8000000OjtdAAC", name: "GST18 Taxable", status: "Active", taxable: true, taxCode: "GST18", productCode: "GST18", policyId: LPB.taxPolicyId, engineId: ENG, legalEntityId: LE, useItems: false },
        { id: "1ttg8000000P1ddAAC", name: "Mouse Canada Sales Tax Treatment", status: "Draft", taxable: true, taxCode: null, productCode: null, policyId: MOUSE.taxPolicyId, engineId: "4wAg80000002nSrEAI", legalEntityId: null, useItems: false, ...o.mouseTreatment },
        { id: "1ttg8000000P2BVAA0", name: "Mouse Canada Tax Treatment", status: "Draft", taxable: true, taxCode: null, productCode: null, policyId: "1Tpg8000000HU89CAG", engineId: "4wAg80000002nUTEAY", legalEntityId: null, useItems: true },
      ],
      items: [{ id: "1tug8000000AQpFAAW", name: "Mouse Canada Tax Treatment Item", treatmentId: "1ttg8000000P2BVAA0", productId: MOUSE.id, productName: "Mouse", taxCode: null, productCode: "MO001" }],
      engines: [
        { id: ENG, name: "Revenue Standard Tax Engine", type: "RevenueStandardTax", status: "Active", provider: null, sellerCode: null, native: true, decisionTableId: DT },
        { id: "4wAg80000002nSrEAI", name: "Canada Standard Sales Tax Engine", type: "RevenueStandardTax", status: "Inactive", provider: null, sellerCode: null, native: true, decisionTableId: null },
        { id: "4wAg80000002nUTEAY", name: "Mouse Canada Revenue Tax Engine", type: "RevenueStandardTax", status: "Inactive", provider: null, sellerCode: null, native: true, decisionTableId: null },
        ...(o.extraEngines ?? []),
      ],
      rates: [rate({ id: "0xqg800000002GLAAY", name: "TR-00000021", productCode: "LPB-001" }), rate({ id: "0xqg800000002HxAAI", name: "TR-00000022", state: "KA" }), rate({ id: "0xqg800000001lhAAA", name: "TR-00000002", productCode: "GST18" }), ...(o.extraRates ?? [])],
      legalEntities: o.les ?? [{ id: LE, name: "Default Legal Entity - US", status: "Active", country: null }],
      geoCountries: [IN, CA],
    },
    geoStates: [{ id: "0yxg80000000XIXAA2", name: "Ontario", iso: "ON", countryIso: "CA" }, { id: "0yxAP", name: "Andhra Pradesh", iso: "AP", countryIso: "IN" }, { id: "0yxg80000000XC5AAM", name: "Karnataka", iso: "KA", countryIso: "IN" }],
    tables: { [DT]: { id: DT, name: "RevenueStandardTaxWithTaxCode", inputs: ["Country", "State", "City", "ZipCode", "ProductCode", "StartDate", "EndDate", "RateUsageType", "LegalEntityId", "TaxCode"], stale: !!o.stale } },
    accounts: o.accounts ?? [],
  };
}

/* ───────────── 1. Natural-language parsing ───────────── */

test("parse: the Mouse prompt → a Salesforce calculation for product Mouse (not 'existing Mouse product'), configuration + calculation, nothing invented", () => {
  const q = parseTaxQuery("Calculate tax for the existing Mouse product using the applicable tax configuration. Inspect the existing product, tax policy, treatment, treatment items, tax rate, tax engine, decision table, and geography. Reuse compatible records, identify missing configuration, calculate tax through the Salesforce billing workflow, generate a draft invoice, and show the actual tax calculated by Salesforce.")!;
  assert.equal(q.kind, "salesforce-calculate");
  assert.equal(q.product, "Mouse");
  assert.equal(q.intent, "both");
  assert.deepEqual([q.account, q.country, q.state, q.taxCode, q.rate, q.basis, q.unitPrice], [null, null, null, null, null, null, null], "jurisdiction, account, code, rate and basis are never invented");
});

test("parse: province → Canada; rate %, tax code and basis are read; '13%' is not a price; product code / Id forms", () => {
  const q = parseTaxQuery("Calculate tax for Mouse in Ontario at 13% tax code HST13 net basis for account Maple Test Ltd")!;
  assert.deepEqual([q.country, q.state, q.rate, q.taxCode, q.basis, q.unitPrice, q.account], ["Canada", "Ontario", 13, "HST13", "Net", null, "Maple Test Ltd"]);
  assert.equal(parseTaxQuery("Calculate tax for Desktop at 1149 in Bavaria, Germany")!.unitPrice, 1149);
  const c = parseTaxQuery("Configure and calculate tax for product code MO001 in Ontario, Canada through the Salesforce billing workflow")!;
  assert.deepEqual([c.kind, c.productCode, c.intent, c.country, c.state], ["salesforce-calculate", "MO001", "both", "Canada", "Ontario"]);
  const i = parseTaxQuery("Calculate tax for 01tg8000006f8uQAAQ for quantity 2")!;
  assert.deepEqual([i.productId, i.product, i.account, i.quantity], ["01tg8000006f8uQAAQ", null, null, 2]);
});

test("parse: configuration-only commands still go to the configuration assistant", () => {
  assert.equal(parseTaxQuery("Create an 18% GST tax rate for Desktop in Bavaria."), null);
  assert.equal(parseTaxQuery("Apply 18% GST to Laptop Basic and calculate the tax when it is sold at ₹10,000 to Acme."), null);
  assert.equal(parseTaxQuery("Activate 'Cloud Storage Standard GST Treatment'."), null);
});

/* ───────────── 2. Plan: missing information, reuse, duplicates, ambiguity ───────────── */

test("plan: missing jurisdiction / account / rate details become QUESTIONS — never assumed", () => {
  const p = buildCalculationPlan(facts(), {});
  assert.equal(p.status, "NEEDS_INPUT");
  assert.ok(p.questions.some(q => q.field === "country"));
  assert.ok(p.questions.some(q => q.field === "taxCode"), "Mouse's treatment has no tax code and none was given");
  assert.ok(!p.actions.some(a => a.id === "create-rate"), "no rate is created without the user's rate, code and basis");
  const noProduct = buildCalculationPlan(facts({ product: null }), {});
  assert.deepEqual([noProduct.status, noProduct.questions[0].field], ["NEEDS_INPUT", "product"]);
});

test("plan (Mouse): reuses configuration A, proposes the minimum Draft updates + activations + one CA rate + refresh, in dependency order; config B is reported, never touched; no IN rate is reused", () => {
  const p = buildCalculationPlan(facts({ accounts: [{ id: "001CA", name: "Maple Test Ltd", country: "CA", state: "ON" }] }), { country: "Canada", state: "Ontario", taxCode: "HST13", rate: 13, basis: "Net" });
  assert.deepEqual(p.actions.map(a => a.id), ["update-treatment", "activate-treatment", "update-policy", "activate-policy", "create-rate", "refresh"]);
  const upd = p.actions[0].operation!;
  assert.deepEqual([upd.op, upd.object, upd.target?.id], ["update", "TaxTreatment", "1ttg8000000P1ddAAC"]);
  assert.deepEqual(upd.fields, { LegalEntityId: { id: LE }, TaxCode: "HST13", TaxEngineId: { id: ENG } }, "the org's only legal entity, the requested code, and the existing Active engine (reuse — no engine is activated)");
  assert.deepEqual(p.actions[2].operation!.fields, { TreatmentSelection: "Default", DefaultTaxTreatmentId: { id: "1ttg8000000P1ddAAC" } });
  const r = p.actions.find(a => a.id === "create-rate")!.operation!.fields!;
  assert.deepEqual(r, { TaxCode: "HST13", Rate: 13, GeoCountryId: { id: CA.id }, GeoStateId: { id: "0yxg80000000XIXAA2" }, ProductCode: "MO001", LegalEntityId: { id: LE }, RateUsageType: "RevCloud", ApplicationBasis: "Net", StartDate: p.actions.find(a => a.id === "create-rate")!.operation!.fields!.StartDate });
  assert.equal(p.actions.find(a => a.id === "refresh")!.refresh!.engineId, ENG);
  for (const a of p.actions) assert.ok(a.dependsOn.every(d => p.actions.findIndex(x => x.id === d) < p.actions.indexOf(a)), "each step depends only on earlier steps");
  assert.ok(p.duplicates.some(d => /Mouse Canada Tax Treatment/.test(d) && /left unchanged/.test(d)), "configuration B is reported as a possible duplicate");
  assert.ok(!p.actions.some(a => a.object === "TaxPolicy" && a.recordId === "1Tpg8000000HU89CAG"), "configuration B is never changed");
  assert.ok(!p.reuse.some(x => x.object === "TaxRate"), "no Indian GST rate is reused for Canada");
  assert.ok(p.reuse.some(x => x.object === "GeoState" && x.name === "Ontario"), "the existing Ontario GeoState is reused, not recreated");
  assert.equal(p.expected?.taxAmount, 1.04, "reference only: 7.99 × 13% = 1.0387 → 1.04 (Salesforce's InvoiceLineTax is the result)");
  assert.equal(p.status, "NEEDS_INPUT", "the customer account still has to be chosen");
  assert.ok(p.questions.find(q => q.field === "account")!.options!.some(o => o.value === "Maple Test Ltd"));
});

test("plan: while a configuration detail is open (here the jurisdiction), only Draft updates are offered — no activation or refresh yet", () => {
  const p = buildCalculationPlan(facts(), { taxCode: "HST13" });
  assert.ok(p.questions.some(q => q.field === "country"));
  assert.deepEqual(p.actions.map(a => a.group), ["update", "update"]);
  assert.ok(p.notes.some(n => /Activation and decision-table refresh steps are listed once/.test(n)));
});

test("plan (Laptop Basic): the verified configuration is READY — everything reused, nothing to create, exactly TR-00000021 matches", () => {
  const p = buildCalculationPlan(facts({ product: LPB }), { account: { id: "001g800000zTEywAAG", name: "Aetherion", country: "IN", state: "AP" } });
  assert.equal(p.status, "READY_TO_CALCULATE");
  assert.deepEqual(p.actions, []);
  assert.equal(p.reuse.find(x => x.object === "TaxRate")?.name, "TR-00000021");
  assert.equal(p.expected?.taxAmount, 1.44, "reference: 7.99 × 18% (the fixture's list price)");
});

test("plan: duplicate prevention — an existing matching rate is reused, never re-created (re-submitting the prompt changes nothing)", () => {
  const existing = rate({ id: "0xqCA", name: "TR-00000099", taxCode: "HST13", rate: 13, country: "CA", geoCountryId: CA.id, state: "ON", productCode: "MO001" });
  const p = buildCalculationPlan(facts({ extraRates: [existing], mouseTreatment: { status: "Active", legalEntityId: LE, taxCode: "HST13", engineId: ENG } }), { country: "CA", state: "ON", taxCode: "HST13", rate: 13, basis: "Net" });
  assert.ok(!p.actions.some(a => a.group === "create"));
  assert.equal(p.reuse.find(x => x.object === "TaxRate")?.id, "0xqCA");
});

test("plan: two matching rates → BLOCKED (Salesforce reports Multiple Matches); none is picked", () => {
  const a = rate({ id: "0xqA", name: "TR-A", taxCode: "HST13", rate: 13, country: "CA", state: "ON", productCode: "MO001" });
  const b = rate({ id: "0xqB", name: "TR-B", taxCode: "HST13", rate: 13, country: "CA", state: null, productCode: null });
  const p = buildCalculationPlan(facts({ extraRates: [a, b], mouseTreatment: { status: "Active", legalEntityId: LE, taxCode: "HST13", engineId: ENG } }), { country: "CA", state: "ON" });
  assert.equal(p.status, "BLOCKED");
  assert.match(p.blocked.join(" "), /Multiple Matches.*none is picked/);
  assert.ok(!p.reuse.some(x => x.object === "TaxRate"));
});

test("plan: engines tied → the user chooses (no arbitrary pick); a non-Draft treatment without a legal entity is BLOCKED (no new treatment is created)", () => {
  const twin = { id: "4wAg80000002nW5EAI", name: "Desktop Germany Tax Engine", type: "RevenueStandardTax", status: "Active", provider: null, sellerCode: null, native: true, decisionTableId: DT };
  const f = facts({ extraEngines: [twin] });
  f.snapshot.treatments = f.snapshot.treatments.filter(t => t.id !== "1ttg8000000OjtdAAC"); // no engine is "used more"
  const p = buildCalculationPlan(f, { country: "CA", state: "ON", taxCode: "HST13", rate: 13, basis: "Net" });
  assert.equal(p.questions.find(q => q.field === "engine")?.options?.length, 2);
  assert.ok(!p.actions.some(a => a.id === "activate-treatment"), "nothing is activated while the engine is undecided");
  const locked = buildCalculationPlan(facts({ mouseTreatment: { status: "Active" } }), { country: "CA", state: "ON", taxCode: "HST13" });
  assert.equal(locked.status, "BLOCKED");
  assert.match(locked.blocked.join(" "), /locks LegalEntityId/);
  assert.ok(!locked.actions.some(a => a.group === "create" && a.object === "TaxTreatment"));
});

test("plan: account problems — a named account that doesn't exist is a question; an account address with names (not ISO codes) is blocked", () => {
  const missing = buildCalculationPlan(facts(), { country: "CA", state: "ON", taxCode: "HST13", rate: 13, basis: "Net", accountNotFound: "Nope Ltd" });
  assert.match(missing.questions.find(q => q.field === "account")!.question, /"Nope Ltd" doesn't exist/);
  const names = buildCalculationPlan(facts({ product: LPB }), { account: { id: "001x", name: "Old Account", country: "India", state: "Andhra Pradesh" } });
  assert.equal(names.status, "BLOCKED");
  assert.match(names.blocked.join(" "), /ISO codes/);
  const none = buildCalculationPlan(facts(), { country: "CA", state: "ON", taxCode: "HST13", rate: 13, basis: "Net" });
  assert.match(none.blocked.join(" "), /No Account with a ON\/CA billing address exists/, "customers are never created by the tax workflow");
});

/* ───────────── 3. Generic record pages: exact duplicate Tax Rates ───────────── */

const fm = (name: string, type = "string", o: Partial<FieldMeta> = {}): FieldMeta => ({ name, label: name, type, required: false, createable: true, updateable: true, nillable: true, picklist: [], referenceTo: [], ...o } as FieldMeta);
const rateMeta: TaxMetadata = { apiVersion: "v68.0", availableTaxObjects: [], relationships: {}, problems: [], objects: { TaxRate: { name: "TaxRate", label: "Tax Rate", exists: true, createable: true, updateable: true, queryable: true, deletable: true,
  fields: Object.fromEntries(["TaxCode", "GeoCountryId", "GeoStateId", "City", "ZipCode", "ProductCode", "LegalEntityId", "RateUsageType", "ApplicationBasis", "StartDate", "EndDate"].map(n => [n, fm(n, /Date$/.test(n) ? "date" : "string")]).concat([["Name", fm("Name", "string", { nameField: true, createable: false })]])) } as ObjectMeta } } as TaxMetadata;

test("generic Tax Rate page: an exact duplicate (all dimensions + overlapping dates) is an error; another state or a non-overlapping period isn't; editing the record itself isn't", () => {
  const v = { TaxCode: "HST13", GeoCountryId: CA.id, GeoStateId: "0yxON", ProductCode: "MO001", LegalEntityId: LE, RateUsageType: "RevCloud", ApplicationBasis: "Net", StartDate: "2026-10-13", EndDate: null };
  const row = { Id: "0xqDUP000000001", Name: "TR-00000099", ...v, StartDate: "2026-01-01" };
  assert.equal(exactDuplicateRates(rateMeta, v, [row], null).length, 1);
  assert.match(exactDuplicateRates(rateMeta, v, [row], null)[0].message, /identical Tax Rate already exists: TR-00000099/);
  assert.equal(exactDuplicateRates(rateMeta, { ...v, GeoStateId: "0yxQC" }, [row], null).length, 0);
  assert.equal(exactDuplicateRates(rateMeta, v, [{ ...row, EndDate: "2026-06-30" }], null).length, 0);
  assert.equal(exactDuplicateRates(rateMeta, v, [row], "0xqDUP000000001").length, 0);
});

/* ───────────── 4. Incremental decision-table freshness (one rule everywhere) ───────────── */

test("freshness: an incremental refresh after the newest rate change makes the table current in decisionTable.isFresh too (E2: incremental 09:10:44Z > TR-00000022 09:07:49Z)", () => {
  const t = { RefreshStatus: "Completed", LastSyncDate: "2026-10-12T06:36:11Z", LastIncrementalSyncDate: "2026-10-12T09:10:44Z", HasIncrementalSyncFailed: false };
  assert.equal(isFresh(t, "2026-10-12T09:07:49Z"), true);
  assert.equal(isFresh({ ...t, HasIncrementalSyncFailed: true }, "2026-10-12T09:07:49Z"), false, "a failed incremental refresh doesn't count");
  assert.equal(isFresh({ ...t, LastIncrementalSyncDate: null }, "2026-10-12T09:07:49Z"), false, "the full refresh alone is older than the rate change");
  assert.equal(isFresh({ ...t, RefreshStatus: "InProgress" }, null), false);
});

/* ───────────── 5. Refresh approval (separate, token-bound, never automatic) ───────────── */

function dtState(o: Partial<DecisionTableState> = {}): DecisionTableState {
  return { id: DT, name: "RevenueStandardTaxWithTaxCode", setupName: null, status: "Active", refreshStatus: "Completed", refreshFailure: null, lastSync: "2026-10-12T06:36:11Z", createdDate: null, inputs: [{ field: "Country", required: true }, { field: "RateUsageType", required: true }, { field: "TaxCode", required: false }], hasTaxCode: true, outdated: false, stale: true, outputs: ["Rate"], sourceObject: "TaxRate", usageType: "RevenueStandardTax", lastIncrementalSync: null, incrementalFailed: false, datasetLinks: [{ id: "0lL000000000001", name: "RSTWTC_TaxRate", sourceObject: "TaxRate" }], source: "engine", engineName: "Revenue Standard Tax Engine", ...o };
}
function fakeRuntime(seq: DecisionTableState[]) {
  const calls: string[] = [];
  let i = 0;
  const api = {
    decisionTable: async () => seq[Math.min(i++, seq.length - 1)],
    refreshDecisionTable: async (n: string) => { calls.push(n); return { ok: true, status: 200, message: null }; },
    query: async (soql: string) => /FROM TaxEngine WHERE Id/.test(soql) ? [{ Id: ENG, TaxEngineName: "Revenue Standard Tax Engine" }] : /FROM TaxEngine WHERE DecisionTableId/.test(soql) ? [{ Id: ENG, TaxEngineName: "Revenue Standard Tax Engine" }, { Id: "4wAg80000002nW5EAI", TaxEngineName: "Desktop Germany Tax Engine" }] : /FROM TaxRate/.test(soql) ? [{ LastModifiedDate: "2026-10-13T08:00:00Z" }] : [],
  } as unknown as TaxRuntimeApi;
  return { api, calls };
}

test("refresh: preview returns the token and the shared engines; a wrong token refreshes nothing; a current table is never refreshed; the approved one is refreshed once", async () => {
  const pv = await decisionTableRefresh(fakeRuntime([dtState()]).api, { engineId: ENG });
  assert.equal(pv.mode, "preview");
  if (pv.mode !== "preview") return;
  assert.deepEqual([pv.needsRefresh, pv.confirmation], [true, refreshToken(DT)]);
  assert.deepEqual(pv.table.sharedWith.map(s => s.name), ["Desktop Germany Tax Engine"]);
  const wrong = fakeRuntime([dtState()]);
  await assert.rejects(decisionTableRefresh(wrong.api, { engineId: ENG, confirm: "refresh-decision-table:0lD000000000XXX" }), BadInputError);
  assert.equal(wrong.calls.length, 0);
  const current = fakeRuntime([dtState({ stale: false })]);
  const c = await decisionTableRefresh(current.api, { engineId: ENG, confirm: refreshToken(DT) });
  assert.deepEqual([c.mode, current.calls.length], ["refresh", 0]);
  const ok = fakeRuntime([dtState(), dtState(), dtState({ stale: false, lastIncrementalSync: "2026-10-13T08:05:00Z" })]);
  const r = await decisionTableRefresh(ok.api, { engineId: ENG, confirm: refreshToken(DT) }, { sleep: async () => {}, maxWaitMs: 50 });
  assert.equal(ok.calls.length, 1);
  assert.equal(r.mode === "refresh" && r.state, "Ready");
});

/* ───────────── 6. Order Product treatment (LegalEntity selection) ───────────── */

const tf = (o: Partial<TaxTreatmentFact>): TaxTreatmentFact => ({ id: "1tt000000000001", name: "T", status: "Active", taxable: true, legalEntityId: LE, engineId: ENG, taxCode: "GST18", productCode: null, useItems: false, policyId: "1Tp000000000LE1", ...o });
function leFacts(o: { treatments: TaxTreatmentFact[]; orderLe?: string | null; current?: string | null }): OrderItemTaxFacts {
  return { productName: "Widget", taxPolicyId: "1Tp000000000LE1", policy: { id: "1Tp000000000LE1", name: "LE Policy", status: "Active", selection: "LegalEntity", defaultTreatmentId: null },
    expected: null, currentId: o.current ?? null, current: null, engines: { [ENG]: { id: ENG, name: "E", status: "Active", type: "RevenueStandardTax", decisionTableId: DT } }, itemTaxCodes: {},
    tables: { [DT]: { id: DT, name: "RevenueStandardTaxWithTaxCode", hasTaxCode: true, engines: ["E"] } }, systemTable: null, policyTreatments: o.treatments, orderLegalEntityId: o.orderLe ?? null };
}

test("LegalEntity selection: the treatment for the order's legal entity is resolved and stamped; unresolvable + taxable → blocked; all non-taxable → warning only", () => {
  const one = evaluateOrderItemTax(leFacts({ treatments: [tf({ id: "1ttLE0000000001" }), tf({ id: "1ttLE0000000002", legalEntityId: "0fw000000000OTH" })], orderLe: LE }));
  assert.deepEqual([one.state, one.expected?.id], ["will-set", "1ttLE0000000001"]);
  const noLe = evaluateOrderItemTax(leFacts({ treatments: [tf({})], orderLe: null }));
  assert.ok(noLe.issues.some(i => i.severity === "error" && i.code === "TAX_TREATMENT_BY_LEGAL_ENTITY_UNRESOLVED" && /order has no Legal Entity/.test(i.message)));
  const two = evaluateOrderItemTax(leFacts({ treatments: [tf({ id: "1ttLE0000000001" }), tf({ id: "1ttLE0000000002" })], orderLe: LE }));
  assert.ok(two.issues.some(i => i.code === "TAX_TREATMENT_BY_LEGAL_ENTITY_UNRESOLVED" && /2 active treatments/.test(i.message)));
  const exempt = evaluateOrderItemTax(leFacts({ treatments: [tf({ taxable: false })], orderLe: null }));
  assert.ok(exempt.issues.every(i => i.severity !== "error"));
  assert.ok(exempt.issues.some(i => i.code === "TAX_TREATMENT_BY_LEGAL_ENTITY"));
});

test("stamping: the Order Product treatment is written at the tax API version through one all-or-nothing composite (source guard)", () => {
  const src = read("lib/tax/server/orderItemTax.ts");
  const fn = src.slice(src.indexOf("export async function stampOrderItemTaxTreatments"), src.indexOf("/* ───────────── Transaction geography"));
  assert.match(fn, /discoverTaxMetadata\(client\)\)\.apiVersion/);
  assert.match(fn, /compositeAt\(client, v,/);
  assert.doesNotMatch(fn, /client\.apiVersion|client\.request\(/, "never the caller's (v62) client version");
  assert.match(fn, /Order\.LegalEntityId/, "the order's legal entity is read for LegalEntity selection");
});

/* ───────────── 7. Invoice progression gate ───────────── */

const item = (o: { errors?: string[]; unavailable?: boolean }) => ({
  id: "802000000000001", product: { id: MOUSE.id, name: "Mouse", code: "MO001" },
  tax: { state: o.unavailable ? "unavailable" as const : "set" as const, current: null, expected: null, effective: null, issues: (o.errors ?? []).map(c => ({ severity: "error" as const, code: c, message: `${c} detail` })) },
  issues: o.unavailable ? [{ severity: "error" as const, code: "TAX_RECORDS_UNREADABLE", message: "Tax: couldn't be read (403)" }] : [],
});

test("invoice gate: unresolved tax errors (missing / multiple rate, LE-unresolved treatment) and unreadable tax records block invoice generation; a clean order doesn't", () => {
  assert.deepEqual(invoiceTaxBlockers([item({ errors: ["MISSING_TAX_RATE"] })]).map(b => [b.code, b.category]), [["MISSING_TAX_RATE", "MISSING_TAX_RATE"]]);
  assert.deepEqual(invoiceTaxBlockers([item({ errors: ["AMBIGUOUS_TAX_RATE", "TAX_TREATMENT_BY_LEGAL_ENTITY_UNRESOLVED"] })]).map(b => b.code), ["AMBIGUOUS_TAX_RATE", "TAX_TREATMENT_BY_LEGAL_ENTITY_UNRESOLVED"]);
  assert.deepEqual(invoiceTaxBlockers([item({ unavailable: true })]).map(b => b.code), ["TAX_RECORDS_UNREADABLE"]);
  assert.deepEqual(invoiceTaxBlockers([item({})]), []);
  assert.match(read("lib/billing/server/orderBilling.ts"), /const taxBlockers = invoiceTaxBlockers\(state\.items\);\s*if \(taxBlockers\.length\) return \{ ok: false, status: 422, code: "TAX_NOT_READY"/);
});

test("billing schedule inheritance: a schedule without the order product's taxable treatment blocks invoicing (BS-000000018 → DOC-000000014 pattern)", () => {
  const items = [{ id: "802000000000001", product: { id: LPB.id, name: "Laptop Basic", code: "LPB-001" }, tax: { current: null, effective: { treatmentId: "1ttg8000000OjtdAAC", taxable: true } } }] as unknown as Parameters<typeof scheduleTreatmentBlockers>[0];
  const b = scheduleTreatmentBlockers(items, [{ id: "44b000000000001", number: "BS-1", orderItemId: "802000000000001", treatment: { id: "1ttg8000000Ne4nAAC", name: "Tax Treatment for US LE" }, taxable: false }]);
  assert.deepEqual(b.map(x => x.code), ["TAX_TREATMENT_NOT_APPLIED"]);
});

/* ───────────── 8. InvoiceLineTax verification: missing, zero, rounded, error log unavailable ───────────── */

const TREAT = { id: "1ttg8000000OjtdAAC", name: "GST18 Taxable", taxable: true };
const iltTotal = (lines: Partial<TaxInvoice["lines"][number]>[]) => lines.flatMap(l => l.taxes ?? []).reduce((n, t) => n + (t.amount ?? 0), 0);
const inv = (lines: Partial<TaxInvoice["lines"][number]>[]): TaxInvoice => ({ id: "3tt000000000001", number: "DOC-T", status: "Draft", subtotal: 1049, tax: iltTotal(lines), totalWithTax: null, balance: null, date: null,
  lines: lines.map((l, i) => ({ id: `5TV00000000000${i}`, name: "Laptop", product: "Laptop", productId: "01t000000000LP1", quantity: 1, unitPrice: 1049, charge: 1049, taxAmount: 0, chargeAmountWithTax: 1049, taxRate: null, taxCode: null, taxStatus: "Estimated", treatment: { id: TREAT.id, name: TREAT.name }, legalEntityId: "0fwg8000000FFefAAG", adjustmentAmount: 0, adjustmentTaxAmount: 0, taxes: [], ...l })) });
const ilt = (amount: number | null) => ({ id: "2GI000000000001", name: null, amount, rate: 18, code: "GST18", status: null, effectiveDate: null, treatment: { id: TREAT.id, name: TREAT.name }, legalEntityId: "0fwg8000000FFefAAG", exemptAmount: 0 });

test("verification: a rounded Salesforce amount (188.82, E2) is reported exactly; zero / missing InvoiceLineTax is a failure, never 'tax applied'", () => {
  const ok = deriveSalesforceTax(inv([{ taxAmount: 188.82, taxes: [ilt(188.82)] }]), [TREAT], null);
  assert.deepEqual([ok.status, ok.actual[0].taxAmount], ["CALCULATED", 188.82]);
  const none = deriveSalesforceTax(inv([{ taxAmount: 0, taxes: [] }]), [TREAT], null);
  assert.deepEqual([none.status, none.reason], ["CALCULATION_FAILED", "INVOICE_TIME_TAX_NOT_APPLIED"]);
  const nullAmount = deriveSalesforceTax(inv([{ taxAmount: 0, taxes: [ilt(null)] }]), [TREAT], null);
  assert.notEqual(nullAmount.status, "CALCULATED", "an InvoiceLineTax without a numeric amount isn't a calculated tax");
});

test("verification: an unreadable RevenueTransactionErrorLog is reported (warning) and never treated as 'no error'", () => {
  const unavailable = errorLogUnavailable(new Error("INSUFFICIENT_ACCESS"));
  assert.match(unavailable.unavailable!, /couldn't be read: INSUFFICIENT_ACCESS/);
  const calc = deriveSalesforceTax(inv([{ taxAmount: 1800, charge: 10000, taxes: [ilt(1800)] }]), [TREAT], unavailable);
  assert.equal(calc.status, "CALCULATED", "the InvoiceLineTax still proves the tax");
  assert.ok(calc.diagnostics.some(d => d.code === "TAX_RECORDS_UNREADABLE" && d.severity === "warning"));
  const none = deriveSalesforceTax(inv([{ taxAmount: 0, taxes: [] }]), [TREAT], unavailable);
  assert.match(none.message, /error log couldn't be read, so a Salesforce processing error isn't ruled out/);
  for (const f of ["lib/tax/server/runtime.ts", "lib/tax/server/invoiceTax.ts", "lib/tax/server/verification.ts", "lib/tax/server/engine.ts"])
    assert.doesNotMatch(read(f), /FROM RevenueTransactionErrorLog[^`]*`\)\.catch\(\(\) => \[\]\)|FROM RevenueTransactionErrorLog[^"]*"\)\.catch\(\(\) => \[\]\)/, `${f}: no silent empty error log`);
});

/* ───────────── 9. AI key, unsupported path, UI default (browser-facing behaviour) ───────────── */

test("AI key: missing → 503 NO_AI_KEY; rejected → 503 AI_KEY_REJECTED (an HTTP error, not a 200); the key is never echoed", async () => {
  const r = noAiKeyResponse();
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { success: false, code: "NO_AI_KEY", error: "Anthropic API key not configured. Complete Setup to add your key." });
  const e = new AiServiceError(503, "AI_KEY_REJECTED", "The Anthropic API key was rejected (invalid or expired). Update it in Setup.");
  assert.deepEqual([e.status, e.code], [503, "AI_KEY_REJECTED"]);
  assert.match(read("app/api/billing/tax/interpret/route.ts"), /if \(!apiKey\) return noAiKeyResponse\(\);/);
  assert.match(read("app/api/taxes/assistant/interpret/route.ts"), /if \(!anthropic\) throw new AiServiceError\(503, "NO_AI_KEY"/, "a configuration request without a key is a 503 NO_AI_KEY");
  for (const f of ["app/api/taxes/assistant/interpret/route.ts", "app/api/billing/tax/interpret/route.ts"]) {
    const src = read(f);
    assert.match(src, /throw new AiServiceError\(status === 503 \? 503 : 502, status === 503 \? "AI_KEY_REJECTED" : "AI_ERROR"/);
    assert.doesNotMatch(src, /return \{ success: false, requiresInput: false, message, code: status === 503/);
  }
  assert.match(read("lib/tax/server/route.ts"), /if \(err instanceof AiServiceError\) return NextResponse\.json\(\{ success: false, code: err\.code, error: err\.message \}, \{ status: err\.status \}\);/);
});

test("route: POST /api/taxes/calculation refuses the unsupported direct Tax Calculation API (410) and points to the billing workflow", async () => {
  const res = await directCalculationRoute(new NextRequest("http://localhost/api/taxes/calculation", { method: "POST", body: JSON.stringify({ action: "calculate", product: { name: "Laptop Basic" } }) }));
  assert.equal(res.status, 410);
  const body = await res.json();
  assert.deepEqual([body.code, body.supported], ["UNSUPPORTED_CALCULATION_PATH", "/api/taxes/calculation/salesforce"]);
});

test("UI: no default product ('Desktop') in the calculation panel; the prompt answer renders the plan; each plan step has its own preview + approval", () => {
  const panel = read("components/data/taxes/SalesforceTaxPanel.tsx");
  assert.doesNotMatch(panel, /\?\? "Desktop"/);
  // The product starts empty; only a prefilled reference (assistant answer / plan) is resolved — to its one exact Salesforce match.
  assert.match(panel, /const \[product, setProduct\] = useState<LookupOption \| null>\(null\);/);
  assert.match(panel, /object="Product2"[^>]*resolveText=\{initial\?\.product\}/);
  const create = read("components/data/billing/tax/TaxCreate.tsx");
  assert.match(create, /answer\.plan\s*\? <CalculationPlanView/);
  const view = read("components/data/taxes/CalculationPlanView.tsx");
  assert.match(view, /<RemediationPanel isDark=\{isDark\} diagnostics=\{plan\.diagnostics\} version=\{plan\.version\} context=\{\{ plan: planBody\(\) \}\}/, "every plan issue is resolved from its own card on the page");
  assert.match(view, /\/api\/taxes\/decision-table\/refresh/);
  const cards = read("components/data/taxes/RemediationPanel.tsx");
  assert.match(cards, /disabled=\{!!busy \|\| \(blocked && o\.kind !== "ask"\)\}/, "a fix waits for the issues it depends on");
  assert.match(cards, /\{ group: review\.group, approvalToken: review\.approvalToken \}/, "each group runs only with the approval of its exact proposal");
});
