/**
 * Tax CALCULATION layer — readiness, rate & treatment resolution, calculation request/response, order / billing schedule /
 * invoice / InvoiceLineTax verification, end-to-end pipeline, diagnostics and natural-language routing. Everything runs against
 * an in-memory runtime (no Salesforce); the Salesforce behaviours encoded here were observed in p10.
 *
 * Run: `npx tsx --test lib/tax/server/calculation.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTaxRate, resolveTaxTreatment, resolveTaxConfiguration, resolveGeography, type ResolutionData, type RRRate, type RateContext } from "./resolution";
import { buildCommerceTaxRequest, calculateTax, normalizeCommerceTaxResponse, salesforceError, validateCalculationRequest } from "./calculation";
import { ensureDecisionTableFresh, evaluateBillingSchedules, evaluateInvoiceLineTax, evaluateOrderTaxReadiness, evaluateProductReadiness, evaluateEngineReadiness, generateTaxInvoice, getProductTaxReadiness, latestInvoiceForProduct, pipelineFromReadiness, pipelineFromRun, PIPELINE_LABELS, validateOrderTaxReadiness, verifyBillingScheduleForTax, verifyInvoiceLineTax, type LineExpectation } from "./pipeline";
import { BILLABLE_ACTIONS, confirmationFor } from "./verification";
import { DIAGNOSTIC_CODES, diag, isPermissionError } from "./diagnostics";
import { BadInputError } from "@/lib/billing/server/payments";
import { parseTaxQuery } from "./taxQuery";
import type { TaxRuntimeApi, LoadedData } from "./runtime";
import type { DecisionTableState } from "./engine";
import type { TaxRunState } from "./verification";
import type { OrderBillingState } from "@/lib/billing/server/orderBilling";

/* ───────────── in-memory org ───────────── */

const LE = "0fw000000000LE1", ENGINE = "4wA000000000EN1", POLICY = "1Tp000000000PO1", TREAT = "1tt000000000TR1", PRODUCT = "01t000000000DS1";
const rate = (o: Partial<RRRate>): RRRate => ({ id: "0xq" + Math.random().toString(36).slice(2, 14).padEnd(12, "0"), name: "TR-x", taxCode: null, rate: 19, countryIso: null, stateIso: null, city: null, zipCode: null, productCode: null, legalEntityId: null, usage: "RevCloud", basis: "Gross", start: "2026-01-01", end: null, priority: null, ...o });
const P10_INPUTS = ["RateUsageType", "ProductCode", "ZipCode", "City", "EndDate", "StartDate", "State", "LegalEntityId", "Country"];

function data(o: Partial<ResolutionData> = {}): ResolutionData {
  return {
    product: { id: PRODUCT, name: "Desktop", code: "DS001", active: true, taxPolicyId: POLICY },
    policies: [{ id: POLICY, name: "Desktop Germany Tax Policy", status: "Active", selection: "Default", defaultTreatmentId: TREAT }],
    treatments: [{ id: TREAT, name: "Desktop Germany Tax Treatment", status: "Active", taxable: true, taxCode: null, productCode: null, policyId: POLICY, engineId: ENGINE, legalEntityId: LE, useItems: true }],
    items: [{ id: "1tu000000000IT1", name: "Desktop Germany Item", treatmentId: TREAT, productId: PRODUCT, taxCode: "DE_VAT_19", productCode: "DS001" }],
    engines: [{ id: ENGINE, name: "Revenue Standard Tax Engine", type: "RevenueStandardTax", status: "Active", native: true, decisionTableId: null, providerId: null }],
    rates: [rate({ id: "0xq000000000DE1", name: "TR-DE", taxCode: "DE_VAT_19", countryIso: "DE", productCode: "DS001", legalEntityId: LE }), rate({ id: "0xq000000000IN1", name: "TR-IN", taxCode: "GST18", rate: 18, countryIso: "IN", productCode: "GST18" })],
    geo: { countries: [{ id: "0vf000000000DE1", name: "Germany", iso: "DE" }, { id: "0vf000000000IN1", name: "India", iso: "IN" }, { id: "0vf000000000US1", name: "United States", iso: "US" }], states: [{ id: "0yx000000000BY1", name: "Bavaria", iso: "BY", countryIso: "DE" }] },
    legalEntities: [{ id: LE, name: "Default Legal Entity - US", status: "Active", country: null }],
    tableInputs: P10_INPUTS,
    ...o,
  };
}
const table = (o: Partial<DecisionTableState> = {}): DecisionTableState => ({ id: "0lD000000000DT1", name: "StandardTax", setupName: "Revenue Standard Tax Entries", status: "Active", refreshStatus: "Completed", refreshFailure: null, lastSync: "2026-10-06T06:12:10Z", createdDate: null, inputs: P10_INPUTS.map(f => ({ field: f, required: f === "Country" })), hasTaxCode: false, outdated: false, stale: false, source: "system", engineName: null, outputs: ["FlatTaxAmount", "ApplicationBasis", "Priority", "Rate"], sourceObject: "TaxRate", datasetLinks: [{ id: "0lX000000000DL1", name: "StandardTax_Default", sourceObject: "TaxRate" }], ...o });

interface FakeOpts { d?: ResolutionData; dt?: DecisionTableState | null; dtSeq?: (DecisionTableState | null)[]; calc?: { status: number; json: unknown }; refresh?: { ok: boolean; status: number; message: string | null }; billing?: Partial<OrderBillingState>[]; generate?: { ok: boolean } }
function fakeApi(o: FakeOpts = {}) {
  const calls = { calculate: [] as Record<string, unknown>[], refresh: [] as string[], generate: 0, dtReads: 0 };
  let billingIdx = 0;
  const dtSeq = o.dtSeq ? [...o.dtSeq] : null;
  const api: TaxRuntimeApi = {
    apiVersion: "v68.0",
    loadData: async (): Promise<LoadedData> => ({ data: o.d ?? data(), productLookup: { status: (o.d ?? data()).product ? "found" : "not-found", message: (o.d ?? data()).product ? null : "No Salesforce product is named \"Nope\".", candidates: [] }, listPrice: 1000, dt: o.dt === undefined ? table() : o.dt }),
    decisionTable: async () => { calls.dtReads++; return dtSeq ? (dtSeq.length > 1 ? dtSeq.shift()! : dtSeq[0]) : o.dt === undefined ? table() : o.dt; },
    refreshDecisionTable: async name => { calls.refresh.push(name); return o.refresh ?? { ok: true, status: 200, message: null }; },
    commerceCalculate: async body => { calls.calculate.push(body); return o.calc ?? { status: 404, json: [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }] }; },
    currencyIsoCode: async () => "INR",
    query: async () => [],
    connection: async () => ({ orgId: "00D", orgName: "Test", orgType: null, isSandbox: true, instanceUrl: "https://x", userId: "005", username: "u", displayName: "U" }),
    orderBilling: async () => { const b = o.billing?.[Math.min(billingIdx++, (o.billing?.length ?? 1) - 1)] ?? {}; return billingState(b); },
    generateInvoices: async () => { calls.generate++; return o.generate?.ok === false ? { ok: false, status: 422, code: "INVALID_INPUT", error: "Salesforce: Billing schedule is not ready." } : { ok: true, state: billingState({}), message: "ok" }; },
    invoice: async id => ({ id, number: "DOC-1", status: "Draft", subtotal: 1000, tax: 190, totalWithTax: 1190, balance: 1190, date: "2026-10-08", lines: [{ id: "3tl000000000LN1", name: "L1", product: "Desktop", productId: PRODUCT, quantity: 1, unitPrice: 1000, charge: 1000, taxAmount: 190, chargeAmountWithTax: 1190, taxRate: 19, taxCode: "DE_VAT_19", taxStatus: "Calculated", treatment: { id: TREAT, name: "Desktop Germany Tax Treatment" }, taxes: [{ id: "ILT1", name: "VAT", amount: 190, rate: 19, code: "DE_VAT_19", status: "Calculated", effectiveDate: "2026-10-08", treatment: { id: TREAT, name: "x" } }] }] }),
    scheduleTreatments: async ids => ids.map(id => ({ id, treatmentId: TREAT, treatmentName: "Desktop Germany Tax Treatment" })),
    errorLog: async () => null,
  };
  return { api, calls };
}
function billingState(b: Partial<OrderBillingState>): OrderBillingState {
  return { success: true, order: { id: "801000000000OR1", number: "00000101", name: "x", status: "Activated", activated: true, account: null, effectiveDate: null, currency: null, totalAmount: 1000, salesforceUrl: "", lastModifiedDate: null, billToContact: null, billToSupported: true, billingAddress: null, shippingAddress: null },
    accountContacts: [], addressSuggestions: [], items: [], orderActions: [], schedules: [], scheduleGroups: [], invoices: [], jobs: [], scheduleCreation: { available: true, reason: "" }, readiness: { ready: true, checks: [], blockers: [] }, lifecycle: [], fields: {}, stateToken: "t", ...b } as OrderBillingState;
}
const ctxDE = (o: Partial<RateContext> = {}): RateContext => ({ taxCode: "DE_VAT_19", countryIso: "DE", stateIso: null, city: null, zipCode: null, productCode: "DS001", legalEntityId: LE, effectiveDate: "2026-10-08", rateUsageType: "RevCloud", applicationBasis: null, ...o });
const noSleep = async () => {};

/* ───────────── Tax Rate resolution ───────────── */

test("rate: matches only on the decision table's inputs; a set value must equal the sale's; outcome single", () => {
  const rates = [rate({ id: "b", countryIso: "DE", productCode: "DS001" }), rate({ id: "c", countryIso: "DE", productCode: "OTHER" })];
  const r = resolveTaxRate(rates, ctxDE(), P10_INPUTS);
  assert.deepEqual([r.status, r.outcome, r.selected?.id], ["resolved", "single", "b"]);
  assert.ok(r.why.some(w => /Product Code = DS001/.test(w)) && r.why.some(w => /no TaxCode input/.test(w)));
  assert.ok(r.nearMisses.some(n => n.rate.id === "c" && /Product Code OTHER/.test(n.reason)));
});

test("rate: a blank (wildcard) rate PLUS a specific rate that both match → MULTIPLE, never 'most specific wins' (p10 E2: Salesforce returned Multiple Matches)", () => {
  const rates = [rate({ id: "a", name: "TR-blank", countryIso: "DE" }), rate({ id: "b", name: "TR-DS001", countryIso: "DE", productCode: "DS001" })];
  const r = resolveTaxRate(rates, ctxDE(), P10_INPUTS);
  assert.deepEqual([r.status, r.outcome, r.selected], ["ambiguous", "multiple", null]);
  assert.equal(r.candidates.length, 2);
  assert.match(r.diagnostics[0].explanation, /TR-blank[\s\S]*blank = any: [\s\S]*Product Code[\s\S]*TR-DS001[\s\S]*Multiple Matches/);
  assert.equal(resolveTaxRate([], ctxDE(), P10_INPUTS).outcome, "none");
});

test("resolution: the ProductCode input is the PRODUCT's own code (Product2.ProductCode), not the item's / treatment's (p10 E1-B / E1c)", () => {
  // The item says ProductCode "ITEM-CODE"; the product's own code is DS001. A rate keyed to DS001 matches, one keyed to the item's code doesn't.
  const d = data({ items: [{ ...data().items[0], productCode: "ITEM-CODE" }], rates: [rate({ id: "0xq000000000DS1", name: "TR-DS001", taxCode: "DE_VAT_19", countryIso: "DE", productCode: "DS001", legalEntityId: LE }), rate({ id: "0xq000000000IT9", name: "TR-ITEM", taxCode: "DE_VAT_19", countryIso: "DE", productCode: "ITEM-CODE", legalEntityId: LE })] });
  const res = resolveTaxConfiguration(d, { country: "DE" });
  assert.equal(res.context?.productCode, "DS001");
  assert.equal(res.treatment.productCode, "ITEM-CODE", "the item's code is still reported (display only)");
  assert.deepEqual([res.rate?.outcome, res.rate?.selected?.name], ["single", "TR-DS001"]);
});

test("rate: TaxCode is a dimension only when the decision table has a TaxCode input", () => {
  const rates = [rate({ id: "x", countryIso: "DE", taxCode: "OTHER_CODE" })];
  assert.equal(resolveTaxRate(rates, ctxDE(), P10_INPUTS).status, "resolved", "p10 StandardTax: no TaxCode input");
  assert.equal(resolveTaxRate(rates, ctxDE(), [...P10_INPUTS, "TaxCode"]).status, "none", "a table with a TaxCode input");
});

test("rate: effective dates, usage type and application basis exclude rates; equal matches are ambiguous (never guessed)", () => {
  const r1 = resolveTaxRate([rate({ countryIso: "DE", end: "2026-09-30" }), rate({ countryIso: "DE", usage: "Commerce" })], ctxDE(), P10_INPUTS);
  assert.equal(r1.status, "none");
  assert.deepEqual(r1.diagnostics.map(d => d.code), ["MISSING_TAX_RATE"]);
  assert.equal(resolveTaxRate([rate({ countryIso: "DE", basis: "Net" })], ctxDE({ applicationBasis: "Gross" }), P10_INPUTS).status, "none");
  const amb = resolveTaxRate([rate({ id: "p1", countryIso: "DE", priority: 1 }), rate({ id: "p2", countryIso: "DE", priority: 2 })], ctxDE(), P10_INPUTS);
  assert.equal(amb.status, "ambiguous");
  assert.equal(amb.selected, null);
  assert.match(amb.diagnostics[0].explanation, /priority 1.*priority 2/);
  assert.equal(resolveTaxRate([rate({ countryIso: "DE", stateIso: "BY" })], ctxDE({ stateIso: "BE" }), P10_INPUTS).status, "none", "a different state doesn't match");
});

/* ───────────── Tax Treatment resolution ───────────── */

test("treatment: Default selection → default treatment; item supplies the tax/product code; engine validated", () => {
  const t = resolveTaxTreatment(data());
  assert.equal(t.status, "resolved");
  assert.deepEqual([t.treatment?.id, t.item?.id, t.taxCode, t.productCode, t.engine?.id], [TREAT, "1tu000000000IT1", "DE_VAT_19", "DS001", ENGINE]);
});

test("treatment: diagnostics for missing policy, inactive treatment, non-taxable, missing item, inactive engine, Manual, Legal Entity ambiguity", () => {
  const codes = (d: ResolutionData, ctx = {}) => resolveTaxTreatment(d, ctx).diagnostics.map(x => x.code);
  const base = data();
  assert.deepEqual(codes({ ...base, product: { ...base.product!, taxPolicyId: null } }), ["MISSING_TAX_POLICY"]);
  assert.ok(codes({ ...base, treatments: [{ ...base.treatments[0], status: "Draft" }] }).includes("INACTIVE_TAX_TREATMENT"));
  assert.deepEqual(codes({ ...base, treatments: [{ ...base.treatments[0], taxable: false }] }), ["NON_TAXABLE_TREATMENT"]);
  assert.ok(codes({ ...base, items: [] }).includes("MISSING_TAX_TREATMENT_ITEM"));
  assert.ok(codes({ ...base, engines: [{ ...base.engines[0], status: "Inactive" }] }).includes("INACTIVE_TAX_ENGINE"));
  assert.ok(codes({ ...base, treatments: [{ ...base.treatments[0], engineId: null }] }).includes("MISSING_TAX_ENGINE"));
  assert.deepEqual(codes({ ...base, policies: [{ ...base.policies[0], selection: "Manual" }] }), ["MANUAL_TREATMENT_SELECTION"]);
  const le2 = { ...base.treatments[0], id: "1tt000000000TR2", name: "Second", legalEntityId: "0fw000000000LE2" };
  const byLe = { ...base, policies: [{ ...base.policies[0], selection: "LegalEntity" }], treatments: [base.treatments[0], le2] };
  assert.deepEqual(codes(byLe), ["AMBIGUOUS_TAX_TREATMENT"]);
  assert.equal(resolveTaxTreatment(byLe, { legalEntityId: "0fw000000000LE2" }).treatment?.id, "1tt000000000TR2");
});

test("geography: ISO / name / alias ('USA'); missing country is a warning; an unknown state is a warning, matched by code", () => {
  const g = data().geo;
  assert.equal(resolveGeography(g, "Germany", "Bavaria").stateIso, "BY");
  assert.equal(resolveGeography(g, "USA", null).countryIso, "US");
  assert.equal(resolveGeography(g, null, null).diagnostics[0].severity, "warning");
  const tx = resolveGeography(g, "US", "TX");
  assert.deepEqual([tx.stateIso, tx.diagnostics[0].severity], ["TX", "warning"]);
  assert.equal(resolveGeography(g, "Atlantis", null).diagnostics[0].severity, "error");
});

/* ───────────── Readiness ───────────── */

test("readiness: configured & table ready → READY; outdated table (no TaxCode, p10) → calculation BLOCKED with the admin action", () => {
  const res = resolveTaxConfiguration(data(), { country: "DE" });
  assert.equal(evaluateProductReadiness(res, table({ hasTaxCode: true, inputs: [...table().inputs, { field: "TaxCode", required: false }] }), 1, { listPrice: 1000 }).status, "READY");
  const p10 = evaluateProductReadiness(res, table({ outdated: true }), 1, { listPrice: 1000 });
  const area = (id: string) => p10.areas.find(a => a.id === id)!;
  assert.deepEqual([area("configuration").status, area("decision-table").status, area("calculation").status], ["READY", "BLOCKED", "BLOCKED"]);
  assert.match(area("decision-table").detail, /TaxCode/);
  assert.equal(p10.decisionTable.state, "Not Ready");
});

test("readiness: a stale table BLOCKS (an explicit, approved refresh is required — never automatic); non-taxable → WARNING; no price → billing BLOCKED", () => {
  const res = resolveTaxConfiguration(data(), { country: "DE" });
  const stale = evaluateProductReadiness(res, table({ hasTaxCode: true, stale: true }), 1, { listPrice: 1000 });
  assert.equal(stale.areas.find(a => a.id === "decision-table")!.status, "BLOCKED");
  assert.match(stale.areas.find(a => a.id === "decision-table")!.detail, /explicit, approved step/);
  assert.doesNotMatch(stale.areas.find(a => a.id === "decision-table")!.detail, /automatically/);
  assert.equal(stale.areas.find(a => a.id === "calculation")!.status, "BLOCKED");
  const nt = resolveTaxConfiguration(data({ treatments: [{ ...data().treatments[0], taxable: false }] }), { country: "DE" });
  const ev = evaluateProductReadiness(nt, table(), 1, { listPrice: null });
  assert.deepEqual([ev.areas.find(a => a.id === "treatment")!.status, ev.areas.find(a => a.id === "calculation")!.status, ev.areas.find(a => a.id === "billing")!.status], ["WARNING", "WARNING", "BLOCKED"]);
});

test("decision table refresh: 'never' inspects only — a stale table blocks with the manual Refresh-button step, no API refresh", async () => {
  const stale = fakeApi({ dt: table({ hasTaxCode: true, stale: true }) });
  const r = await ensureDecisionTableFresh(stale.api, { sleep: noSleep, refresh: "never" });
  assert.equal(r.state, "Not Ready");
  assert.match(r.reason, /Lookup Tables → .* → Refresh/);
  assert.equal(stale.calls.refresh.length, 0);
  const fresh = fakeApi({ dt: table({ hasTaxCode: true }) });
  assert.equal((await ensureDecisionTableFresh(fresh.api, { sleep: noSleep, refresh: "never" })).state, "Ready");
  assert.equal(fresh.calls.refresh.length, 0);
});

test("decision table refresh: WITHOUT approval a stale table is never refreshed (default) — it blocks with the explicit step", async () => {
  const stale = fakeApi({ dt: table({ hasTaxCode: true, stale: true }) });
  const r = await ensureDecisionTableFresh(stale.api, { sleep: noSleep });
  assert.deepEqual([r.state, r.refreshed, stale.calls.refresh.length], ["Not Ready", false, 0]);
  assert.match(r.reason, /isn't refreshed automatically/);
});

test("decision table refresh: APPROVED stale → Salesforce refreshDecisionTable + poll until Completed; outdated → never refreshed; refusal → Failed", async () => {
  const f = fakeApi({ dtSeq: [table({ hasTaxCode: true, stale: true }), table({ hasTaxCode: true, refreshStatus: "InProgress" }), table({ hasTaxCode: true })] });
  const r = await ensureDecisionTableFresh(f.api, { sleep: noSleep, intervalMs: 1, maxWaitMs: 10, refresh: "approved" });
  assert.deepEqual([r.state, r.refreshed, f.calls.refresh], ["Ready", true, ["StandardTax"]]);
  const outdated = fakeApi({ dt: table({ outdated: true }) });
  assert.equal((await ensureDecisionTableFresh(outdated.api, { sleep: noSleep, refresh: "approved" })).state, "Not Ready");
  assert.equal(outdated.calls.refresh.length, 0, "a missing TaxCode input can't be fixed by a refresh");
  const refused = fakeApi({ dt: table({ hasTaxCode: true, stale: true }), refresh: { ok: false, status: 400, message: "INSUFFICIENT_ACCESS" } });
  const rr = await ensureDecisionTableFresh(refused.api, { sleep: noSleep, refresh: "approved" });
  assert.equal(rr.state, "Failed");
  assert.match(rr.reason, /INSUFFICIENT_ACCESS/);
});

/* ───────────── Calculation request / response ───────────── */

test("calculation request validation", () => {
  assert.equal(validateCalculationRequest({ product: {} }).ok, false);
  assert.equal(validateCalculationRequest({ product: { name: "Desktop" }, quantity: -1 }).ok, false);
  assert.equal(validateCalculationRequest({ product: { name: "Desktop" }, effectiveDate: "08/10/2026" }).ok, false);
  assert.equal(validateCalculationRequest({ product: { name: "Desktop" }, accountId: "not-an-id" }).ok, false);
  const ok = validateCalculationRequest({ product: { name: "Desktop" }, quantity: "2", unitPrice: "₹1,000", country: "Germany" });
  assert.ok(ok.ok && ok.request.quantity === 2 && ok.request.unitPrice === 1000);
});

test("Salesforce request uses only the fields the org's Tax Calculation API accepts", () => {
  const v = validateCalculationRequest({ product: { name: "Desktop" }, quantity: 2, unitPrice: 500, country: "DE", state: "BY", city: "Munich", zipCode: "80331" });
  assert.ok(v.ok);
  const body = buildCommerceTaxRequest(v.request, resolveTaxConfiguration(data(), { country: "DE", state: "BY" }), ENGINE, "INR");
  assert.deepEqual(Object.keys(body).sort(), ["currencyIsoCode", "lineItems", "taxEngineId", "taxType", "transactionDate"]);
  const line = (body.lineItems as Record<string, unknown>[])[0];
  assert.deepEqual(Object.keys(line).sort(), ["addresses", "amount", "lineNumber", "productCode", "quantity", "taxCode"]);
  assert.deepEqual(line.addresses, { shipTo: { country: "DE", state: "BY", city: "Munich", postalCode: "80331" } });
  assert.equal(line.amount, 1000);
});

test("response normalisation: documented shapes; no tax amount → null (never invented); nested Salesforce error descriptions", () => {
  assert.deepEqual(normalizeCommerceTaxResponse({ lineItems: [{ lineNumber: "1", taxes: [{ tax: 190, rate: 19, taxCode: "DE_VAT_19", taxName: "VAT" }] }] }), { totalTax: 190, lines: [{ lineNumber: "1", taxAmount: 190, rate: 19, taxCode: "DE_VAT_19", taxName: "VAT" }] });
  assert.equal(normalizeCommerceTaxResponse({ totalTax: 12.5, lineItems: [] }).totalTax, 12.5);
  assert.equal(normalizeCommerceTaxResponse({ status: "ok" }).totalTax, null);
  assert.deepEqual(salesforceError([{ errorCode: "REQUIRED_FIELD_MISSING", message: "{\"description\":\"Required fields are missing: taxEngineId\"}" }]), { code: "REQUIRED_FIELD_MISSING", message: "Required fields are missing: taxEngineId" });
});

test("calculateTax: Salesforce NOT_FOUND (p10 Revenue Standard Tax) → CONFIGURATION_READY with the exact message, never CALCULATED", async () => {
  const f = fakeApi();
  const r = await calculateTax(f.api, { product: { name: "Desktop" }, quantity: 1, country: "DE" }, "calculate");
  assert.equal(r.status, "CONFIGURATION_READY");
  assert.equal(f.calls.calculate.length, 1);
  assert.ok(r.diagnostics.some(d => d.code === "CALCULATION_ENDPOINT_UNAVAILABLE" && d.salesforceMessage === "The requested resource does not exist"));
  assert.equal(r.salesforce?.totalTax, null);
  assert.equal(r.expected?.taxAmount, 190);
  assert.match(r.expected!.note, /not a Salesforce calculation/);
});

test("calculateTax: CALCULATED only on Salesforce's tax; rejection → CALCULATION_FAILED; permission → PERMISSION_OR_LICENSE", async () => {
  const ok = await calculateTax(fakeApi({ calc: { status: 200, json: { lineItems: [{ lineNumber: "1", taxes: [{ tax: 190, rate: 19 }] }] } } }).api, { product: { name: "Desktop" }, country: "DE" });
  assert.deepEqual([ok.status, ok.salesforce?.totalTax], ["CALCULATED", 190]);
  const empty = await calculateTax(fakeApi({ calc: { status: 200, json: {} } }).api, { product: { name: "Desktop" }, country: "DE" });
  assert.equal(empty.status, "CALCULATION_FAILED");
  const bad = await calculateTax(fakeApi({ calc: { status: 400, json: [{ errorCode: "INVALID_INPUT", message: "bad" }] } }).api, { product: { name: "Desktop" }, country: "DE" });
  assert.deepEqual([bad.status, bad.diagnostics.at(-1)?.code], ["CALCULATION_FAILED", "CALCULATION_REJECTED"]);
  const perm = await calculateTax(fakeApi({ calc: { status: 403, json: [{ errorCode: "INSUFFICIENT_ACCESS", message: "no" }] } }).api, { product: { name: "Desktop" }, country: "DE" });
  assert.equal(perm.diagnostics.at(-1)?.code, "PERMISSION_OR_LICENSE");
});

test("calculateTax: blocked configuration → NOT_READY and non-taxable → NO_TAX_EXPECTED, both without calling Salesforce; validate/preview never call it", async () => {
  const blocked = fakeApi({ d: data({ items: [] }) });
  assert.equal((await calculateTax(blocked.api, { product: { name: "Desktop" }, country: "DE" })).status, "NOT_READY");
  const nt = fakeApi({ d: data({ treatments: [{ ...data().treatments[0], taxable: false }] }) });
  const r = await calculateTax(nt.api, { product: { name: "Desktop" }, country: "DE" });
  assert.deepEqual([r.status, r.expected, r.salesforce], ["NO_TAX_EXPECTED", null, null], "no tax expected is neither a calculation nor configuration readiness");
  assert.match(r.message, /not a tax calculation result/);
  const pv = fakeApi();
  const preview = await calculateTax(pv.api, { product: { name: "Desktop" }, country: "DE" }, "preview");
  assert.equal(preview.salesforce?.httpStatus, null);
  assert.equal(pv.calls.calculate.length + blocked.calls.calculate.length + nt.calls.calculate.length, 0);
  assert.equal((await calculateTax(fakeApi({ d: data({ product: null }) }).api, { product: { name: "Nope" } })).diagnostics[0].code, "MISSING_PRODUCT");
});

/* ───────────── Order / billing schedule / invoice / InvoiceLineTax ───────────── */

test("order tax readiness: account, address, items, selling model and the tax chain per order product", () => {
  const res = resolveTaxConfiguration(data(), { country: "DE" });
  const order = { Id: "801", OrderNumber: "101", Status: "Draft", AccountId: "001", Account: { Name: "Acme" }, BillingCountry: "DE" };
  const ok = evaluateOrderTaxReadiness(order, [{ row: { Id: "802", Product2Id: PRODUCT, Product2: { Name: "Desktop" }, Quantity: 1, UnitPrice: 1000, ProductSellingModelId: "0jP", ProductSellingModel: { Name: "One Time" } }, resolution: res }]);
  assert.equal(ok.status, "READY", ok.message);
  const bad = evaluateOrderTaxReadiness({ ...order, BillingCountry: null }, [{ row: { Id: "802", Product2Id: PRODUCT, Quantity: 0, UnitPrice: 1000 }, resolution: resolveTaxConfiguration(data({ items: [] }), { country: "DE" }) }]);
  assert.equal(bad.status, "BLOCKED");
  assert.match(bad.message, /billing country/);
  assert.equal(evaluateOrderTaxReadiness(null, []).status, "BLOCKED");
});

test("billing schedule detection: found (with tax treatment), processing job, not activated, failed job", () => {
  const sched = { id: "BS1", number: "BS-1", status: "ReadyForInvoicing", start: null, end: null, term: null, amount: 1000, nextBillingDate: null, groupId: null, product: "Desktop", treatmentItem: null, invoiced: false };
  const b = billingState({ schedules: [sched] });
  assert.equal(evaluateBillingSchedules(b, [{ id: "BS1", treatmentName: "T" }], null).status, "FOUND");
  assert.equal(evaluateBillingSchedules(b, [], null).diagnostics[0].code, "BILLING_SCHEDULE_MISSING", "a schedule without a tax treatment is flagged");
  assert.equal(evaluateBillingSchedules(billingState({ jobs: [{ id: "j", number: "J-1", status: "InProgress", jobType: null, createdDate: null, finishedAt: null, failedItems: 0, response: null }] }), [], null).status, "PROCESSING");
  const notActive = evaluateBillingSchedules(billingState({ order: { ...billingState({}).order, activated: false, status: "Draft" } }), [], null);
  assert.match(notActive.message, /isn't activated/);
  const failed = evaluateBillingSchedules(billingState({ jobs: [{ id: "j", number: "J-2", status: "Failed", jobType: null, createdDate: null, finishedAt: null, failedItems: 1, response: "Required fields are missing: billToContact" }] }), [], null);
  assert.equal(failed.diagnostics[0].salesforceMessage, "Required fields are missing: billToContact");
});

const inv = (lines: Partial<NonNullable<TaxRunState["invoice"]>["lines"][number]>[], status = "Draft"): NonNullable<TaxRunState["invoice"]> => ({ id: "INV", number: "DOC-1", status, subtotal: 1000, tax: 190, totalWithTax: 1190, balance: 0, date: "2026-10-08",
  lines: lines.map((l, i) => ({ id: `L${i}`, name: `L${i}`, product: "Desktop", productId: PRODUCT, quantity: 1, unitPrice: 1000, charge: 1000, taxAmount: 190, chargeAmountWithTax: 1190, taxRate: 19, taxCode: null, taxStatus: "Calculated", treatment: { id: TREAT, name: "T" }, taxes: [], ...l })) });
const ilt = (amount: number, rate: number) => ({ id: "ILT" + amount, name: "VAT", amount, rate, code: "DE_VAT_19", status: "Calculated", effectiveDate: null, treatment: null });

test("InvoiceLineTax verification: VERIFIED / MISMATCH / PENDING / MISSING / ERROR / NO_TAX_EXPECTED", () => {
  const exp = new Map<string, LineExpectation>([["L0", { rateId: "r", rate: 19, taxCode: "DE_VAT_19" }]]);
  assert.equal(evaluateInvoiceLineTax(inv([{ taxes: [ilt(190, 19)] }]), exp, null).status, "SUCCESS");
  assert.equal(evaluateInvoiceLineTax(inv([{ taxes: [ilt(180, 18)] }]), exp, null).lines[0].status, "MISMATCH");
  assert.equal(evaluateInvoiceLineTax(inv([{ taxStatus: "Pending" }]), exp, null).status, "PENDING");
  const missing = evaluateInvoiceLineTax(inv([{ taxStatus: "Calculated" }]), exp, null);
  assert.deepEqual([missing.status, missing.lines[0].status, missing.diagnostics[0].code], ["FAILED", "MISSING", "INVOICE_LINE_TAX_MISSING"]);
  const err = evaluateInvoiceLineTax(inv([{ taxStatus: "Error" }], "Error"), exp, { code: "TAX_INTERNAL_ERROR", message: "Decision Table lookup failed", number: "EL-1" });
  assert.deepEqual([err.lines[0].status, err.diagnostics[0].salesforceMessage], ["ERROR", "Decision Table lookup failed"]);
  const nt = evaluateInvoiceLineTax(inv([{ taxStatus: "Posted", taxAmount: 0 }], "Posted"), new Map([["L0", { notTaxable: true, treatment: "Tax Treatment for US LE" }]]), null);
  assert.equal(nt.status, "NO_TAX_EXPECTED", "p10 DOC-000000010: non-taxable lines without InvoiceLineTax are correct — and not a calculation");
  assert.equal(evaluateInvoiceLineTax(inv([]), exp, null).diagnostics[0].code, "INVOICE_LINE_MISSING");
  assert.equal(evaluateInvoiceLineTax(null, exp, null).diagnostics[0].code, "INVOICE_MISSING");
});

test("invoice generation: preview needs no Salesforce call; table not ready → BLOCKED before generating; success → invoice found and InvoiceLineTax verified", async () => {
  const sched = { id: "BS1", number: "BS-1", status: "ReadyForInvoicing", start: null, end: null, term: null, amount: 1000, nextBillingDate: null, groupId: null, product: "Desktop", treatmentItem: null, invoiced: false };
  const preview = fakeApi({ billing: [{ schedules: [sched] }] });
  assert.equal((await generateTaxInvoice(preview.api, "801000000000OR1", { sleep: noSleep })).status, "PREVIEW");
  assert.equal(preview.calls.generate, 0);
  const blocked = fakeApi({ dt: table({ outdated: true }), billing: [{ schedules: [sched] }] });
  const b = await generateTaxInvoice(blocked.api, "801000000000OR1", { confirm: true, sleep: noSleep });
  assert.deepEqual([b.status, blocked.calls.generate], ["BLOCKED", 0]);
  const inv1 = { id: "3tt000000000IV1", number: "DOC-1", status: "Draft", amount: 1000, balance: 1000, invoiceDate: "2026-10-08", scheduleIds: ["BS1"], salesforceUrl: "" };
  const ok = fakeApi({ dt: table({ hasTaxCode: true }), billing: [{ schedules: [sched] }, { schedules: [sched] }, { schedules: [sched] }, { schedules: [{ ...sched, invoiced: true }], invoices: [inv1] }] });
  const g = await generateTaxInvoice(ok.api, "801000000000OR1", { confirm: true, sleep: noSleep, intervalMs: 1, maxWaitMs: 10 });
  assert.equal(g.status, "GENERATED", g.message);
  assert.deepEqual([ok.calls.generate, g.invoice?.number], [1, "DOC-1"]);
  assert.ok(g.lineTax);
  const failed = fakeApi({ dt: table({ hasTaxCode: true }), billing: [{ schedules: [sched] }], generate: { ok: false } });
  const f = await generateTaxInvoice(failed.api, "801000000000OR1", { confirm: true, sleep: noSleep });
  assert.deepEqual([f.status, f.diagnostics[0].code, f.diagnostics[0].salesforceMessage], ["FAILED", "INVOICE_GENERATION_FAILED", "Salesforce: Billing schedule is not ready."]);
});

/* ───────────── End-to-end pipeline ───────────── */

test("pipeline before an order: CONFIGURATION / READY evaluated, the rest NOT_STARTED", () => {
  const res = resolveTaxConfiguration(data(), { country: "DE" });
  const ev = evaluateProductReadiness(res, table({ outdated: true }), 1, { listPrice: 1000 });
  const stages = pipelineFromReadiness({ success: true, status: ev.status, product: null, areas: ev.areas, decisionTable: ev.decisionTable, resolution: res, diagnostics: res.diagnostics, message: "" });
  assert.deepEqual(stages.map(s => s.label), PIPELINE_LABELS.map(([, l]) => l));
  assert.deepEqual(stages.slice(0, 3).map(s => s.status), ["DONE", "BLOCKED", "NOT_STARTED"]);
});

test("pipeline of a run: stages map from Salesforce's records; TAX VERIFIED only when the run is complete", () => {
  const run = (o: Partial<TaxRunState>): TaxRunState => ({ success: true, orderId: "801", connection: {} as TaxRunState["connection"], order: { id: "801", number: "101", status: "Activated", account: null, total: 1000, activated: true, legalEntity: null }, items: [], schedules: [{ id: "BS1", number: "BS-1", status: "CompletelyBilled", amount: 1000, invoiced: true, treatment: { id: TREAT, name: "T" }, product: "Desktop" }],
    invoice: inv([{ taxes: [ilt(190, 19)] }], "Posted"), readiness: { ready: true, reason: null },
    steps: ["config", "order", "setup", "activate", "schedules", "readiness", "invoice", "tax", "post", "verify"].map(id => ({ id, label: id, state: "done" as const, detail: "" })), next: null, confirmation: null, failure: null,
    checks: [{ id: "line-tax-records", label: "ILT", passed: true, detail: "ok" }, { id: "totals", label: "totals", passed: true, detail: "ok" }], complete: true, taxCalculation: "SUCCESS", endToEnd: "SUCCESS", currency: "₹", message: "done", ...o });
  const done = pipelineFromRun(run({}));
  assert.ok(done.every(s => s.status === "DONE"), JSON.stringify(done.map(s => [s.label, s.status])));
  assert.equal(done.find(s => s.id === "line-tax")!.recordId, "ILT190");
  const err = pipelineFromRun(run({ complete: false, endToEnd: "FAILED", taxCalculation: "FAILED", invoice: inv([{ taxStatus: "Error" }], "Error"), checks: [{ id: "line-tax-records", label: "ILT", passed: false, detail: "none" }], failure: { step: "tax", reason: "Salesforce TAX_INTERNAL_ERROR: Decision Table lookup failed", code: "TAX_INTERNAL_ERROR" } }));
  assert.deepEqual([err.find(s => s.id === "line-tax")!.status, err.find(s => s.id === "verified")!.status], ["FAILED", "FAILED"]);
  assert.match(err.find(s => s.id === "line-tax")!.error!, /Decision Table lookup failed/);
});

/* ───────────── Diagnostics ───────────── */

test("diagnostics: every code has a stage and title; Salesforce messages are carried verbatim; permission errors recognised", () => {
  for (const code of DIAGNOSTIC_CODES) { const d = diag(code, "x"); assert.ok(d.stage && d.title, code); }
  for (const c of ["MISSING_TAX_POLICY", "MISSING_TAX_TREATMENT", "INACTIVE_TAX_TREATMENT", "MISSING_TAX_RATE", "AMBIGUOUS_TAX_RATE", "MISSING_GEOGRAPHY", "MISSING_TAX_ENGINE", "INACTIVE_TAX_ENGINE", "MISSING_DECISION_TABLE_RELATIONSHIP", "DECISION_TABLE_NOT_READY", "CALCULATION_ENDPOINT_UNAVAILABLE", "CALCULATION_REJECTED", "ORDER_ACTIVATION_FAILED", "BILLING_SCHEDULE_MISSING", "INVOICE_GENERATION_FAILED", "INVOICE_LINE_MISSING", "INVOICE_LINE_TAX_MISSING", "PERMISSION_OR_LICENSE"]) assert.ok(DIAGNOSTIC_CODES.includes(c as never), c);
  assert.equal(diag("CALCULATION_REJECTED", "x", { salesforceMessage: "exact" }).salesforceMessage, "exact");
  assert.ok(isPermissionError(403, null, null) && isPermissionError(400, "INSUFFICIENT_ACCESS", null) && !isPermissionError(400, "INVALID_INPUT", "bad"));
});

/* ───────────── Natural-language routing ───────────── */

test("NL: calculation / readiness / verification commands are recognised — and never configuration", () => {
  const q = (p: string) => parseTaxQuery(p);
  assert.deepEqual({ ...q("Calculate tax for Desktop for quantity 2 in Bavaria, Germany.")!, noMutation: false }, { kind: "salesforce-calculate", product: "Desktop", productCode: null, productId: null, orderNumber: null, orderId: null, taxCode: null, rate: null, basis: null, intent: "calculate", test: null, quantity: 2, unitPrice: null, country: "Germany", state: "Bavaria", account: null, invoiceNumber: null, noMutation: false });
  assert.equal(q("Check whether Desktop is ready for tax calculation.")?.kind, "readiness");
  assert.equal(q("Check whether Desktop is ready for tax calculation.")?.product, "Desktop");
  assert.deepEqual([q("Run the complete tax validation for Desktop.")?.kind, q("Run the complete tax validation for Desktop.")?.product], ["e2e", "Desktop"]);
  assert.equal(q("Show me why tax is not being calculated for Desktop.")?.kind, "explain");
  assert.deepEqual([q("Show me the tax configuration used for the latest Desktop invoice.")?.kind, q("Show me the tax configuration used for the latest Desktop invoice.")?.product], ["latest-invoice-config", "Desktop"]);
  assert.deepEqual([q("Verify the InvoiceLineTax generated for Desktop.")?.kind, q("Verify the InvoiceLineTax generated for Desktop.")?.product], ["verify-invoice-tax", "Desktop"]);
  assert.equal(q("Check whether Desktop is ready for tax calculation. Do not modify anything.")?.noMutation, true);
  assert.equal(q("Calculate tax for Desktop for quantity 1 using the applicable tax configuration. Do not create an order.")?.product, "Desktop");
  // Configuration commands stay with the configuration assistant (even when they mention calculation).
  assert.equal(q("Create an 18% GST tax rate for Desktop in Bavaria."), null);
  assert.equal(q("Apply 18% GST to Laptop Basic and calculate the tax when it is sold at ₹10,000 to Acme."), null);
  assert.equal(q("Assign 'Cloud Storage India GST Policy' to the 'Cloud Storage Pro' product."), null);
  assert.equal(q("Show me the complete configuration of 'Cloud Storage India GST Policy'."), null);
});

/* ───────────── Hardening review (2026-10-08): regressions for gaps the review found ───────────── */

test("hardening: a refresh result counts only after Salesforce acts on the request (a previous 'Failed' isn't this refresh's result)", async () => {
  const failedBefore = table({ hasTaxCode: true, refreshStatus: "Failed", refreshFailure: "old failure", lastSync: "2026-10-01T00:00:00Z" });
  const f = fakeApi({ dtSeq: [failedBefore, failedBefore, table({ hasTaxCode: true, refreshStatus: "InProgress", lastSync: "2026-10-01T00:00:00Z" }), table({ hasTaxCode: true, lastSync: "2026-10-08T09:00:00Z" })] });
  const r = await ensureDecisionTableFresh(f.api, { sleep: noSleep, intervalMs: 1, maxWaitMs: 10, refresh: "approved" });
  assert.deepEqual([r.state, f.calls.refresh.length], ["Ready", 1]);
  const never = fakeApi({ dtSeq: [failedBefore] });
  const n = await ensureDecisionTableFresh(never.api, { sleep: noSleep, intervalMs: 1, maxWaitMs: 5, refresh: "approved" });
  assert.equal(n.state, "Refreshing", "unchanged state after the request is NOT reported as success or failure");
  assert.match(n.reason, /isn't confirmed by Salesforce/);
});

test("hardening: every BLOCKED readiness area has a diagnostic with a stable code and a recommended action", async () => {
  const f = fakeApi({ dt: table({ outdated: true }) });
  const r = await getProductTaxReadiness(f.api, { name: "Desktop" }, { country: "DE" });
  const blocked = r.areas.filter(a => a.status === "BLOCKED");
  assert.ok(blocked.some(a => a.id === "decision-table"));
  assert.ok(r.diagnostics.some(d => d.code === "DECISION_TABLE_NOT_READY" && d.action && /administrator/.test(d.action)));
  for (const code of DIAGNOSTIC_CODES) assert.ok(diag(code, "x").action, `${code} has no recommended action`);
});

test("hardening: Legal Entity selection never picks a treatment without the sale's legal entity", () => {
  const base = data();
  const byLe = { ...base, policies: [{ ...base.policies[0], selection: "LegalEntity" }], legalEntities: [...base.legalEntities, { id: "0fw000000000LE2", name: "Second LE", status: "Active" }] };
  const unknown = resolveTaxConfiguration(byLe, { country: "DE" });
  assert.equal(unknown.treatment.treatment, null, "two active legal entities and none given → no treatment");
  assert.ok(unknown.diagnostics.some(d => d.code === "AMBIGUOUS_TAX_TREATMENT"));
  const single = resolveTaxConfiguration({ ...byLe, legalEntities: base.legalEntities }, { country: "DE" });
  assert.equal(single.treatment.treatment?.id, TREAT, "the org's only active legal entity is the sale's legal entity");
});

test("hardening: TaxCode is required only when the decision table matches on it — and never invented", () => {
  const noCode = data({ items: [{ ...data().items[0], taxCode: null }] });
  const withTaxCodeInput = resolveTaxConfiguration({ ...noCode, tableInputs: [...P10_INPUTS, "TaxCode"] }, { country: "DE" });
  assert.equal(withTaxCodeInput.status, "blocked");
  assert.ok(withTaxCodeInput.diagnostics.some(d => d.code === "MISSING_TAX_CODE" && d.severity === "error"));
  assert.equal(resolveTaxConfiguration(noCode, { country: "DE" }).diagnostics.some(d => d.code === "MISSING_TAX_CODE" && d.severity === "error"), false, "p10's table has no TaxCode input");
  const v = validateCalculationRequest({ product: { name: "Desktop" }, country: "DE" });
  assert.ok(v.ok);
  const res = resolveTaxConfiguration(data({ items: [{ ...data().items[0], taxCode: null, productCode: null }] }), { country: "DE" });
  const line = (buildCommerceTaxRequest(v.request, res, ENGINE, "INR").lineItems as Record<string, unknown>[])[0];
  assert.equal(line.productCode, undefined, "the product's SKU (DS001) is never sent as a stand-in product code");
  assert.equal(line.taxCode, undefined);
});

test("hardening: readiness warnings are WARNING in the pipeline, never 'in progress'", () => {
  const nt = resolveTaxConfiguration(data({ treatments: [{ ...data().treatments[0], taxable: false }] }), { country: "DE" });
  const ev = evaluateProductReadiness(nt, table({ hasTaxCode: true }), 1, { listPrice: 1000 });
  const stages = pipelineFromReadiness({ success: true, status: ev.status, product: null, areas: ev.areas, decisionTable: ev.decisionTable, resolution: nt, diagnostics: nt.diagnostics, message: "" });
  assert.equal(stages.find(s => s.id === "ready")!.status, "WARNING");
  assert.ok(!stages.some(s => s.status === "IN_PROGRESS"));
});

test("hardening: CALCULATION_ENDPOINT_UNAVAILABLE carries HTTP status, operation and the supported fallback path", async () => {
  const r = await calculateTax(fakeApi().api, { product: { name: "Desktop" }, country: "DE" });
  const d = r.diagnostics.find(x => x.code === "CALCULATION_ENDPOINT_UNAVAILABLE")!;
  assert.deepEqual([d.httpStatus, /calculate/.test(d.operation ?? ""), r.fallback?.path], [404, true, "billing-lifecycle"]);
  const blockedTable = await calculateTax(fakeApi({ dt: table({ outdated: true }) }).api, { product: { name: "Desktop" }, country: "DE" });
  assert.equal(blockedTable.status, "CONFIGURATION_READY");
  assert.match(blockedTable.message, /can't calculate this tax yet either way/);
});

test("hardening: billable run steps need an explicit confirmation of that exact step", () => {
  assert.deepEqual([...BILLABLE_ACTIONS].sort(), ["activate", "generate-invoice", "post-invoice", "schedules"]);
  for (const a of ["assign-treatment", "setup", "calculate-tax", "wait"] as const) assert.equal(confirmationFor(a, { orderNumber: "101", invoiceNumber: null }), null);
  assert.match(confirmationFor("post-invoice", { orderNumber: "101", invoiceNumber: "DOC-9" })!.detail, /DOC-9.*final/);
});

test("hardening: Salesforce errors propagate (never turned into 'not found'); malformed Ids are rejected before any call", async () => {
  const f = fakeApi();
  const boom = Object.assign(new Error("INSUFFICIENT_ACCESS: no access to Order"), { status: 403 });
  f.api.query = async () => { throw boom; };
  await assert.rejects(validateOrderTaxReadiness(f.api, "801000000000OR1"), /INSUFFICIENT_ACCESS/);
  await assert.rejects(latestInvoiceForProduct(f.api, PRODUCT), /INSUFFICIENT_ACCESS/);
  f.api.orderBilling = async () => { throw boom; };
  await assert.rejects(verifyBillingScheduleForTax(f.api, "801000000000OR1"), /INSUFFICIENT_ACCESS/);
  await assert.rejects(verifyInvoiceLineTax(f.api, "bad id"), BadInputError);
  await assert.rejects(validateOrderTaxReadiness(f.api, "801"), BadInputError);
});

test("hardening: the review's NL phrasings route to calculation/verification — never to configuration", () => {
  const cases: [string, string, string | null][] = [
    ["Is Desktop ready for tax?", "readiness", "Desktop"],
    ["Calculate tax for Desktop", "salesforce-calculate", "Desktop"],
    ["Run the end-to-end tax flow for Desktop", "e2e", "Desktop"],
    ["Explain why Desktop has no tax", "explain", "Desktop"],
    ["Show the latest invoice tax", "latest-invoice-config", null],
    ["Verify InvoiceLineTax", "verify-invoice-tax", null],
    ["Show me why tax is not being calculated for Desktop.", "explain", "Desktop"],
    ["Is the Desktop ready for tax calculation?", "readiness", "Desktop"],
  ];
  for (const [p, kind, product] of cases) {
    const q = parseTaxQuery(p);
    assert.ok(q, `${p} wasn't recognised`);
    assert.deepEqual([q!.kind, q!.product], [kind, product], p);
  }
});

test("engine-specific decision table: Salesforce uses the TREATMENT's engine table (another engine's corrected table doesn't make this product ready)", async () => {
  const corrected = table({ id: "0lD000000000DT2", name: "RevenueStandardTaxWithTaxCode", hasTaxCode: true, inputs: [...table().inputs, { field: "TaxCode", required: false }], source: "engine" });
  // The corrected table is assigned to ANOTHER engine; the product's engine still uses the system table (no TaxCode) → BLOCKED.
  const other = fakeApi({ dt: table({ outdated: true }) });
  const loadOther = other.api.loadData;
  other.api.loadData = async p => ({ ...(await loadOther(p)), engineTables: { "4wA000000000OTH": corrected } });
  const r1 = await getProductTaxReadiness(other.api, { name: "Desktop" }, { country: "DE" });
  assert.equal(r1.areas.find(a => a.id === "decision-table")!.status, "BLOCKED");
  // Assigned to the treatment's own engine → that table decides (READY), and its TaxCode input becomes a matching dimension.
  const own = fakeApi({ dt: table({ outdated: true }) });
  const loadOwn = own.api.loadData;
  own.api.loadData = async p => { const l = await loadOwn(p); return { ...l, engineTables: { [ENGINE]: corrected }, data: { ...l.data, engineTableInputs: { [ENGINE]: corrected.inputs.map(i => i.field) } } }; };
  const r2 = await getProductTaxReadiness(own.api, { name: "Desktop" }, { country: "DE" });
  assert.equal(r2.areas.find(a => a.id === "decision-table")!.status, "READY");
  assert.ok(r2.resolution?.rate?.dimensions.includes("TaxCode"));
  assert.equal(r2.status, "READY");
});

test("engine readiness: p10 today (system StandardTax, no TaxCode input, no engine table) → BLOCKED with codes, objects and remediation", () => {
  const eng = { id: ENGINE, name: "Desktop Germany Tax Engine", type: "RevenueStandardTax", status: "Active", native: true, decisionTableId: null };
  const r = evaluateEngineReadiness(eng, table({ outdated: true }));
  assert.equal(r.status, "BLOCKED");
  const failed = r.checks.filter(c => !c.passed).map(c => c.code).sort();
  assert.deepEqual(failed, ["ENGINE_TABLE_ASSIGNED", "TABLE_TAXCODE_INPUT"]);
  const tc = r.checks.find(c => c.code === "TABLE_TAXCODE_INPUT")!;
  assert.equal(tc.object, "DecisionTableParameter");
  assert.match(tc.remediation!, /Clone.*Tax Code.*INPUT.*Activate, Refresh.*Decision Table on the tax engine/);
});

test("engine readiness: the administrator's corrected, assigned, active, refreshed table → READY; each structural gap → BLOCKED", () => {
  const eng = { id: ENGINE, name: "Desktop Germany Tax Engine", type: "RevenueStandardTax", status: "Active", native: true, decisionTableId: "0lD000000000DT2" };
  const fixed = table({ id: "0lD000000000DT2", name: "RevenueStandardTaxWithTaxCode", source: "engine", hasTaxCode: true, inputs: [...table().inputs, { field: "TaxCode", required: false }] });
  const ok = evaluateEngineReadiness(eng, fixed);
  assert.equal(ok.status, "READY", JSON.stringify(ok.checks.filter(c => !c.passed)));
  const fail = (dt: DecisionTableState, e = eng) => evaluateEngineReadiness(e, dt).checks.filter(c => !c.passed).map(c => c.code);
  assert.deepEqual(fail({ ...fixed, status: "Draft" }), ["TABLE_ACTIVE"]);
  assert.deepEqual(fail({ ...fixed, stale: true }), ["TABLE_REFRESHED"]);
  assert.deepEqual(fail({ ...fixed, refreshStatus: "Failed", refreshFailure: "Row limit exceeded" }), ["TABLE_REFRESHED"]);
  assert.equal(evaluateEngineReadiness(eng, { ...fixed, refreshStatus: "Failed", refreshFailure: "Row limit exceeded" }).checks.find(c => c.code === "TABLE_REFRESHED")!.salesforceMessage, "Row limit exceeded");
  assert.deepEqual(fail({ ...fixed, datasetLinks: [] }), ["TABLE_TAXRATE_SOURCE"]);
  assert.deepEqual(fail({ ...fixed, outputs: ["Priority"] }), ["TABLE_RATE_OUTPUT"]);
  assert.deepEqual(fail({ ...fixed, inputs: fixed.inputs.filter(i => i.field !== "Country") }), ["TABLE_REQUIRED_INPUTS"]);
  assert.deepEqual(fail(fixed, { ...eng, status: "Inactive" }), ["ENGINE_ACTIVE"]);
  assert.equal(evaluateEngineReadiness(null, fixed).checks[0].code, "ENGINE_MISSING");
});

test("decision table freshness counts a successful INCREMENTAL refresh (p10: Refresh button / API action set LastIncrementalSyncDate, not LastSyncDate)", async () => {
  const { effectiveRefresh } = await import("./engine");
  assert.equal(effectiveRefresh("2026-10-08T05:51:49.000+0000", "2026-10-08T10:26:45.000+0000", false), "2026-10-08T10:26:45.000+0000");
  assert.equal(effectiveRefresh("2026-10-08T05:51:49.000+0000", "2026-10-08T10:26:45.000+0000", true), "2026-10-08T05:51:49.000+0000", "a failed incremental refresh doesn't count");
  assert.equal(effectiveRefresh(null, null, false), null);
  assert.equal(effectiveRefresh("2026-10-08T12:00:00.000+0000", "2026-10-08T10:00:00.000+0000", false), "2026-10-08T12:00:00.000+0000");
});

test("freshness: an APPROVED refresh that Salesforce runs INCREMENTALLY (only LastIncrementalSyncDate moves, status Completed → Completed) is confirmed (p10 E2)", async () => {
  // E2 (2026-10-12): the same refreshDecisionTable request ran incremental — LastSyncDate stayed 06:36:11Z, LastIncrementalSyncDate → 09:10:44Z.
  const before = table({ hasTaxCode: true, stale: true, lastSync: "2026-10-12T06:36:11.000+0000", lastIncrementalSync: "2026-10-09T11:58:56.000+0000" });
  const after = table({ hasTaxCode: true, stale: false, lastSync: "2026-10-12T06:36:11.000+0000", lastIncrementalSync: "2026-10-12T09:10:44.000+0000" });
  const f = fakeApi({ dtSeq: [before, after] });
  const r = await ensureDecisionTableFresh(f.api, { sleep: noSleep, intervalMs: 1, maxWaitMs: 10, refresh: "approved" });
  assert.deepEqual([r.state, r.refreshed, f.calls.refresh.length], ["Ready", true, 1]);
  // A failed incremental refresh is never success.
  const g = fakeApi({ dtSeq: [before, { ...after, stale: true, incrementalFailed: true }] });
  assert.equal((await ensureDecisionTableFresh(g.api, { sleep: noSleep, intervalMs: 1, maxWaitMs: 10, refresh: "approved" })).state, "Failed");
});

test("freshness: the decision table checked is the one of the given (treatment's) engine — never 'the first engine'", async () => {
  const f = fakeApi({ dt: table({ hasTaxCode: true }) });
  const seen: (string | null | undefined)[] = [];
  const api: TaxRuntimeApi = { ...f.api, decisionTable: async engineId => { seen.push(engineId); return table({ hasTaxCode: true }); } };
  await ensureDecisionTableFresh(api, { sleep: noSleep, engineId: "4wAg80000002mBpEAI" });
  assert.deepEqual(seen, ["4wAg80000002mBpEAI"]);
});
