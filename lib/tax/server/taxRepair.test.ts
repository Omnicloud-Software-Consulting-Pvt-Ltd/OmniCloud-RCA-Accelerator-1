/**
 * END-TO-END TAX REPAIR — deterministic tests of the rules that decide whether an order may be activated, an invoice generated or
 * posted, and what an invoice's tax verdict is.
 *
 * MOCKED: every test runs against fixtures (the real p10 Smart LED Bulb / Aetherion records and Salesforce responses recorded on
 * 2026-10-09…12) or an in-memory fake client. They prove the APPLICATION's decisions — NOT that Salesforce calculates tax at
 * invoice time. Only a real invoice with a retrieved InvoiceLineTax proves that.
 *
 * Run: `npx tsx --test lib/tax/server/taxRepair.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateOrderItemTax, evaluateTaxGeography, loadOrderItemTaxFacts, taxAddress, taxIssueCategory, type OrderItemTaxFacts, type OrderTaxContext, type TaxGeoFacts } from "./orderItemTax";
import { evaluateTaxRateRules, overlappingRates, rateOverlap, type RateKey } from "./rateRules";
import { deriveSalesforceTax, invoiceTotalWithTax, lineTotalWithTax, postingDecision, readInvoice, type TaxInvoice } from "./invoiceTax";
import { invoiceTaxFlowState } from "./calculationResult";
import type { RRRate } from "./resolution";
import { activateOrderWithReadiness, scheduleTreatmentBlockers, type OrderBillingItem } from "@/lib/billing/server/orderBilling";
import type { SalesforceClient } from "@/lib/salesforce/client";

/* ───────────── p10 Smart LED Bulb records ───────────── */

const LE = "0fwg8000000FFefAAG";
const PRODUCT = "01tg8000007BzybAAC", PRODUCT_CODE = "SLB-E2E-20261009";
const POLICY = "1Tpg8000000Hu7RCAS", TREATMENT = "1ttg8000000PiDxAAK", ENGINE = "4wAg80000002mBpEAI", TABLE = "0lDg8000000HC3BEAW", SYSTEM_TABLE = "0lDg8000000FR09EAG";
const TAX_CODE = "IN-SLB-E2E-GST18-20261009";
const LE_FALLBACK = "1ttg8000000Ne4nAAC";
const TODAY = "2026-10-12";
const INPUTS = ["Country", "State", "City", "ZipCode", "ProductCode", "StartDate", "EndDate", "RateUsageType", "LegalEntityId", "TaxCode"];

const treatment = { id: TREATMENT, name: "Smart LED Bulb E2E Tax Treatment", status: "Active", taxable: true, legalEntityId: LE as string | null, engineId: ENGINE, taxCode: TAX_CODE, productCode: PRODUCT_CODE, useItems: true, policyId: POLICY };
/** TR-00000020 as it is in p10 today: Commerce / Gross, no state, LE, product code or start date. */
const TR20: RRRate = { id: "0xqg800000002EjAAI", name: "TR-00000020", taxCode: TAX_CODE, rate: 18, countryIso: "IN", stateIso: null, city: null, zipCode: null, productCode: null, legalEntityId: null, usage: "Commerce", basis: "Gross", start: null, end: null, priority: 1 };
/** The repaired rate the data-repair list proposes: RevCloud / Net, IN/AP, LE, start date. */
const FIXED: RRRate = { ...TR20, id: "0xqNEW", name: "TR-NEW", stateIso: "AP", legalEntityId: LE, usage: "RevCloud", basis: "Net", start: "2026-10-12" };

function facts(o: Partial<OrderItemTaxFacts> = {}): OrderItemTaxFacts {
  return {
    productName: "Smart LED Bulb", taxPolicyId: POLICY,
    policy: { id: POLICY, name: "Smart LED Bulb E2E Tax Policy", status: "Active", selection: "Default", defaultTreatmentId: TREATMENT },
    expected: treatment, currentId: TREATMENT, current: treatment,
    engines: { [ENGINE]: { id: ENGINE, name: "Revenue Standard Tax Engine", status: "Active", type: "RevenueStandardTax", decisionTableId: TABLE } },
    itemTaxCodes: { [TREATMENT]: TAX_CODE }, itemProductCodes: { [TREATMENT]: PRODUCT_CODE },
    tables: { [TABLE]: { id: TABLE, name: "RevenueStandardTaxWithTaxCode", hasTaxCode: true, engines: ["Revenue Standard Tax Engine"] } },
    systemTable: { id: SYSTEM_TABLE, name: "StandardTax", hasTaxCode: false, engines: [] },
    productCode: PRODUCT_CODE, rates: [FIXED], tableInputs: { [TABLE]: INPUTS, [SYSTEM_TABLE]: INPUTS.filter(i => i !== "TaxCode") },
    ...o,
  };
}
const ctx = (o: Partial<OrderTaxContext> = {}): OrderTaxContext => ({ addresses: [{ label: "Billing Address", countryIso: "IN", stateIso: "AP", city: null, zipCode: null }], orderLegalEntityId: null, orderItemLegalEntityId: null, dates: [TODAY], ...o });
const codes = (ev: ReturnType<typeof evaluateOrderItemTax>, sev = "error") => ev.issues.filter(i => i.severity === sev).map(i => i.code);

/* ───────────── 1. valid configuration ───────────── */

test("1. MOCKED — valid taxable product with a matching RevCloud/Net rate: no blocker, the selected rate is reported", () => {
  const ev = evaluateOrderItemTax(facts(), ctx());
  assert.deepEqual(codes(ev), []);
  assert.deepEqual(codes(ev, "warning"), []);
  assert.equal(ev.effective?.rate?.id, FIXED.id);
  assert.equal(ev.effective?.rate?.usage, "RevCloud");
  assert.equal(ev.effective?.decisionTable?.id, TABLE);
});

/* ───────────── 2. Commerce / Gross ───────────── */

test("2. MOCKED — p10 Smart LED Bulb TR-00000020 (Commerce/Gross) blocks activation with RATE_USAGE_INCOMPATIBLE; creating such a rate is refused", () => {
  const ev = evaluateOrderItemTax(facts({ rates: [TR20] }), ctx());
  assert.deepEqual(codes(ev), ["RATE_USAGE_INCOMPATIBLE"]);
  assert.match(ev.issues[0].message, /TR-00000020 has the tax code but Rate Usage Type "Commerce"/);
  assert.equal(taxIssueCategory("RATE_USAGE_INCOMPATIBLE"), "MISSING_TAX_RATE");
  const base = { TaxCode: TAX_CODE, GeoCountryId: "0vfg80000001P9FAAU", LegalEntityId: LE, Rate: 18, StartDate: TODAY, ProductCode: PRODUCT_CODE };
  const fields = ["RateUsageType", "ApplicationBasis", "LegalEntityId", "StartDate", "TaxCode", "GeoCountryId", "EndDate", "Rate"];
  const rule = (v: Record<string, unknown>) => evaluateTaxRateRules({ mode: "create", values: { ...base, ...v }, availableFields: fields, today: TODAY });
  assert.deepEqual(rule({ RateUsageType: "Commerce", ApplicationBasis: "Net" }).filter(i => i.severity === "error").map(i => i.code), ["RATE_USAGE_INCOMPATIBLE"]);
  assert.deepEqual(rule({ ApplicationBasis: "Net" }).filter(i => i.severity === "error").map(i => i.code), ["RATE_USAGE_REQUIRED"], "a blank usage type would become Salesforce's Commerce default");
  assert.deepEqual(rule({ RateUsageType: "RevCloud" }).filter(i => i.severity === "error").map(i => i.code), ["RATE_BASIS_REQUIRED"], "a blank basis would become Salesforce's Gross default");
  assert.deepEqual(rule({ RateUsageType: "RevCloud", ApplicationBasis: "Gross" }).map(i => [i.severity, i.code]), [["warning", "RATE_BASIS_UNVERIFIED"]], "Gross is allowed but flagged (only Net verified)");
  assert.deepEqual(rule({ RateUsageType: "RevCloud", ApplicationBasis: "Net" }), []);
  // Legacy rate: end-dating it (the retirement path) is not blocked by its old Commerce value.
  const retire = evaluateTaxRateRules({ mode: "update", values: { ...base, StartDate: null, RateUsageType: "Commerce", ApplicationBasis: "Gross", EndDate: "2026-10-11" }, changed: ["EndDate"], availableFields: fields, today: TODAY });
  assert.ok(retire.every(i => i.severity !== "error"), JSON.stringify(retire));
});

/* ───────────── 3. TaxTreatmentId ───────────── */

test("3. MOCKED — blank TaxTreatmentId → will-set (stamped before activation); the LE fallback (non-taxable / other policy) is an ERROR, a same-policy taxable alternative a warning", () => {
  assert.equal(evaluateOrderItemTax(facts({ currentId: null, current: null }), ctx()).state, "will-set");
  const fallback = evaluateOrderItemTax(facts({ currentId: LE_FALLBACK, current: { ...treatment, id: LE_FALLBACK, name: "Tax Treatment for US LE", taxable: false, engineId: null, policyId: "1Tpg8000000GJMrCAO" } }), ctx());
  assert.ok(codes(fallback).includes("TAX_TREATMENT_CONFLICT"));
  assert.equal(taxIssueCategory("TAX_TREATMENT_CONFLICT"), "TREATMENT_MISMATCH");
  const alt = evaluateOrderItemTax(facts({ currentId: "1ttALT000000001", current: { ...treatment, id: "1ttALT000000001", name: "Alt" } }), ctx());
  assert.ok(codes(alt, "warning").includes("TAX_TREATMENT_CONFLICT"));
  assert.ok(!codes(alt).includes("TAX_TREATMENT_CONFLICT"));
});

/* ───────────── 4. legal entity ───────────── */

test("4. MOCKED — taxable treatment without LegalEntityId blocks; an order legal entity that differs blocks", () => {
  assert.ok(codes(evaluateOrderItemTax(facts({ current: { ...treatment, legalEntityId: null }, expected: { ...treatment, legalEntityId: null } }), ctx())).includes("TAX_TREATMENT_LEGAL_ENTITY_MISSING"));
  assert.deepEqual(codes(evaluateOrderItemTax(facts(), ctx({ orderLegalEntityId: "0fwOTHER0000001" }))), ["TAX_LEGAL_ENTITY_MISMATCH"]);
  assert.deepEqual(codes(evaluateOrderItemTax(facts(), ctx({ orderLegalEntityId: LE, orderItemLegalEntityId: LE }))), []);
});

/* ───────────── 5. geography ───────────── */

const GEO: TaxGeoFacts = { countries: [{ name: "India", iso: "IN" }], states: [{ name: "Andhra Pradesh", iso: "AP", countryIso: "IN" }, { name: "Karnataka", iso: "KA", countryIso: "IN" }] };

test("5. MOCKED — p10 order 00000136 state \"Andhra Pradesh\": INVALID_GEOGRAPHY with the exact code; the rate is still checked through the GeoState code", () => {
  const g = evaluateTaxGeography("Billing Address", { country: "IN", state: "Andhra Pradesh" }, GEO);
  assert.deepEqual(g.map(x => x.code), ["TAX_GEOGRAPHY_NOT_CODE"]);
  assert.equal(taxIssueCategory(g[0].code), "INVALID_GEOGRAPHY");
  assert.deepEqual(taxAddress("Billing Address", { country: "India", state: "Andhra Pradesh" }, GEO), { label: "Billing Address", countryIso: "IN", stateIso: "AP", city: null, zipCode: null });
  // Another state never matches the AP rate.
  assert.deepEqual(codes(evaluateOrderItemTax(facts(), ctx({ addresses: [{ label: "Billing Address", countryIso: "IN", stateIso: "KA", city: null, zipCode: null }] }))), ["MISSING_TAX_RATE"]);
});

/* ───────────── 6. missing / ambiguous ───────────── */

test("6. MOCKED — no rate → MISSING_TAX_RATE; two equally specific rates → AMBIGUOUS_TAX_RATE; billing/shipping selecting different rates → AMBIGUOUS_TAX_RATE", () => {
  assert.deepEqual(codes(evaluateOrderItemTax(facts({ rates: [] }), ctx())), ["MISSING_TAX_RATE"]);
  assert.deepEqual(codes(evaluateOrderItemTax(facts({ rates: [FIXED, { ...FIXED, id: "0xqDUP", name: "TR-DUP" }] }), ctx())), ["AMBIGUOUS_TAX_RATE"]);
  const ka = { ...FIXED, id: "0xqKA", name: "TR-KA", stateIso: "KA" };
  const twoAddr = ctx({ addresses: [{ label: "Billing Address", countryIso: "IN", stateIso: "AP", city: null, zipCode: null }, { label: "Shipping Address", countryIso: "IN", stateIso: "KA", city: null, zipCode: null }] });
  assert.deepEqual(codes(evaluateOrderItemTax(facts({ rates: [FIXED, ka] }), twoAddr)), ["AMBIGUOUS_TAX_RATE"]);
  // Pure overlap explanation for a new rate that one lookup would match together with an existing one.
  const o = overlappingRates({ TaxCode: TAX_CODE, GeoCountryId: "IN", RateUsageType: "RevCloud", LegalEntityId: LE, StartDate: TODAY }, [{ Id: "r1", Name: "TR-AP", TaxCode: TAX_CODE, GeoCountryId: "IN", GeoStateId: "AP", RateUsageType: "RevCloud", LegalEntityId: LE, StartDate: "2026-01-01" }]);
  // The new rate (no state) covers the AP rate entirely: every AP sale would match both → an ERROR (rateRules.rateOverlap "always").
  assert.equal(o[0]?.code, "RATE_ALWAYS_AMBIGUOUS");
  assert.equal(o[0].severity, "error");
  assert.match(o[0].message, /GeoStateId \(blank on this rate\)/);
  // p10 E2 shape: a product-specific rate (no state) vs a blank-ProductCode KA rate collide only for that product in KA → warning.
  const c = overlappingRates({ TaxCode: TAX_CODE, GeoCountryId: "IN", ProductCode: PRODUCT_CODE, RateUsageType: "RevCloud", LegalEntityId: LE, StartDate: TODAY }, [{ Id: "r2", Name: "TR-KA", TaxCode: TAX_CODE, GeoCountryId: "IN", GeoStateId: "KA", ProductCode: null, RateUsageType: "RevCloud", LegalEntityId: LE, StartDate: "2026-01-01" }]);
  assert.deepEqual(c.map(i => [i.severity, i.code]), [["warning", "AMBIGUOUS_RATE_OVERLAP"]]);
});

/* ───────────── 7. dates ───────────── */

test("7. MOCKED — expired and future-effective rates: RATE_NOT_EFFECTIVE at activation; creation refuses an expired rate and flags a future one", () => {
  assert.deepEqual(codes(evaluateOrderItemTax(facts({ rates: [{ ...FIXED, end: "2026-10-01" }] }), ctx())), ["RATE_NOT_EFFECTIVE"]);
  assert.deepEqual(codes(evaluateOrderItemTax(facts({ rates: [{ ...FIXED, start: "2026-11-01" }] }), ctx())), ["RATE_NOT_EFFECTIVE"]);
  // The rate must be effective on BOTH the invoice date and the service date.
  assert.deepEqual(codes(evaluateOrderItemTax(facts(), ctx({ dates: [TODAY, "2026-10-01"] }))), ["RATE_NOT_EFFECTIVE"]);
  const fields = ["RateUsageType", "ApplicationBasis", "LegalEntityId", "StartDate", "TaxCode", "GeoCountryId", "EndDate", "Rate"];
  const v = { TaxCode: TAX_CODE, GeoCountryId: "IN", LegalEntityId: LE, Rate: 18, RateUsageType: "RevCloud", ApplicationBasis: "Net", ProductCode: PRODUCT_CODE };
  assert.deepEqual(evaluateTaxRateRules({ mode: "create", values: { ...v, StartDate: "2026-01-01", EndDate: "2026-06-30" }, availableFields: fields, today: TODAY }).map(i => i.code), ["RATE_EXPIRED"]);
  assert.deepEqual(evaluateTaxRateRules({ mode: "create", values: { ...v, StartDate: "2026-12-01" }, availableFields: fields, today: TODAY }).map(i => [i.severity, i.code]), [["warning", "RATE_FUTURE_EFFECTIVE"]]);
  assert.deepEqual(evaluateTaxRateRules({ mode: "create", values: { ...v }, availableFields: fields, today: TODAY }).map(i => i.code), ["RATE_START_REQUIRED"]);
});

/* ───────────── 8. decision table ───────────── */

test("8. MOCKED — engine without DecisionTableId (system StandardTax has no TaxCode) blocks; a table without TaxCode blocks", () => {
  const noTable = facts({ engines: { [ENGINE]: { id: ENGINE, name: "Revenue Standard Tax Engine", status: "Active", type: "RevenueStandardTax", decisionTableId: null } }, tables: {} });
  assert.ok(codes(evaluateOrderItemTax(noTable, ctx())).includes("TAX_ENGINE_DECISION_TABLE_MISSING"));
  const noCode = facts({ tables: { [TABLE]: { id: TABLE, name: "Clone", hasTaxCode: false, engines: [] } } });
  assert.ok(codes(evaluateOrderItemTax(noCode, ctx())).includes("TAX_DECISION_TABLE_NO_TAXCODE"));
  // A missing table means no rate resolution is claimed — the rate is never reported as matched.
  assert.equal(evaluateOrderItemTax(noTable, ctx()).effective?.rate ?? null, null);
});

/* ───────────── 9. selling model ───────────── */

test("9. MOCKED — a PricebookEntry without the selling model is its own blocker category (MISSING_SELLING_MODEL)", () => {
  assert.equal(taxIssueCategory("MISSING_SELLING_MODEL"), "MISSING_SELLING_MODEL");
});

/* ───────────── 10. Orders activation bypass ───────────── */

/** A fake Salesforce client. `query` decides each SOQL answer; every PATCH/POST is recorded. */
function fakeClient(scope: string, query: (soql: string) => { status: number; json: unknown }, describe = true) {
  const writes: { url: string; method: string }[] = [];
  const res = (status: number, json: unknown) => ({ status, statusText: status < 400 ? "OK" : "ERROR", json, rawText: JSON.stringify(json), headers: {} });
  const client = {
    instanceUrl: `https://${scope}.example.com`, apiVersion: "v64.0", cacheScope: scope,
    requestWithDiagnostics: async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") { writes.push({ url, method }); return res(200, {}); }
      if (/\/services\/data\/$/.test(url)) return res(200, [{ version: "68.0" }]);
      if (/oauth2\/userinfo/.test(url)) return res(200, { user_id: "005", organization_id: "00D" });
      const d = url.match(/\/sobjects\/(\w+)\/describe/);
      if (d) return describe ? res(200, { name: d[1], label: d[1], createable: true, fields: [{ name: "Id", type: "id" }, { name: "Name", type: "string" }] }) : res(403, [{ errorCode: "INSUFFICIENT_ACCESS", message: "no access" }]);
      const q = url.match(/\/query\?q=(.*)$/);
      if (q) return query(decodeURIComponent(q[1]));
      return res(404, [{ errorCode: "NOT_FOUND", message: url }]);
    },
    updateRecord: async (o: string, id: string) => { writes.push({ url: `${o}/${id}`, method: "PATCH" }); },
    request: async () => { throw new Error("request not expected"); },
    queryAll: async () => { throw new Error("INSUFFICIENT_ACCESS: no access to OrderItem"); },
    describeObject: async () => { throw new Error("INSUFFICIENT_ACCESS: describe refused"); },
    describeGlobal: async () => { throw new Error("INSUFFICIENT_ACCESS: describe refused"); },
    getRecord: async () => { throw new Error("INSUFFICIENT_ACCESS"); },
  };
  return { client: client as unknown as SalesforceClient, writes };
}

test("10. MOCKED — the Orders activation endpoint can't bypass readiness: when readiness can't be read, NOTHING is activated", async () => {
  const { client, writes } = fakeClient("bypass-test", () => ({ status: 500, json: [{ errorCode: "UNKNOWN", message: "x" }] }));
  const r = await activateOrderWithReadiness(client, "801g800000zhcy9AAA");
  assert.equal(r.success, false);
  assert.equal(r.code, "READINESS_UNREADABLE");
  assert.equal(writes.length, 0, "no Order.Status update was sent");
  // The route sends "activate" through the shared readiness service (source check: one activation path, no plain transition).
  const src = await import("node:fs").then(fs => fs.readFileSync(new URL("../../../app/api/orders/[id]/activate/route.ts", import.meta.url), "utf8"));
  assert.match(src, /action === "activate" \? requireBillingClient\(req\) : null/);
  assert.match(src, /activateOrderWithReadiness\(billing\.client, id\)/);
});

/* ───────────── 11. Salesforce errors while loading tax configuration ───────────── */

test("11. MOCKED — a Salesforce error while loading tax records REJECTS (the billing readiness turns it into TAX_RECORDS_UNREADABLE) — never 'no tax'", async () => {
  const { client } = fakeClient("load-error-test", () => ({ status: 403, json: [{ errorCode: "INSUFFICIENT_ACCESS", message: "You don't have access to TaxPolicy" }] }));
  await assert.rejects(loadOrderItemTaxFacts(client, [{ key: "802", productId: PRODUCT, productName: "Smart LED Bulb", taxPolicyId: POLICY, currentTreatmentId: null }]), /access to TaxPolicy/);
  assert.equal(taxIssueCategory("TAX_RECORDS_UNREADABLE"), "TAX_RECORDS_UNREADABLE");
});

/* ───────────── 12–16. invoice verification ───────────── */

const line = (o: Partial<TaxInvoice["lines"][number]> = {}): TaxInvoice["lines"][number] => ({ id: "5TV000000000001", name: "Smart LED Bulb", product: "Smart LED Bulb", productId: PRODUCT, quantity: 1, unitPrice: 1000, charge: 1000, taxAmount: 0, chargeAmountWithTax: 1000, taxRate: null, taxCode: null, taxStatus: "Estimated", treatment: { id: TREATMENT, name: treatment.name }, legalEntityId: LE, adjustmentAmount: 0, adjustmentTaxAmount: 0, taxes: [], ...o });
const invoice = (lines: TaxInvoice["lines"], o: Partial<TaxInvoice> = {}): TaxInvoice => ({ id: "3tt000000000001", number: "DOC-TEST", status: "Draft", subtotal: 1000, tax: 0, totalWithTax: 1000, balance: 1000, date: TODAY, lines, ...o });
const taxable = [{ id: TREATMENT, name: treatment.name, taxable: true }];
const expected = { [PRODUCT.slice(0, 15)]: { id: TREATMENT, name: treatment.name, taxable: true } };

test("12. MOCKED — invoice generated, taxable line, no InvoiceLineTax → CALCULATION_FAILED · INVOICE_TIME_TAX_NOT_APPLIED → TAX_VERIFICATION_FAILED", () => {
  const d = deriveSalesforceTax(invoice([line()]), taxable, null, expected);
  assert.deepEqual([d.status, d.reason, invoiceTaxFlowState(d.status, d.reason)], ["CALCULATION_FAILED", "INVOICE_TIME_TAX_NOT_APPLIED", "TAX_VERIFICATION_FAILED"]);
  assert.deepEqual(d.actual, []);
});

test("13. MOCKED — an unreadable InvoiceLineTax query is TAX_RECORDS_UNREADABLE, never zero tax (readInvoice keeps the error)", async () => {
  const { client } = fakeClient("ilt-error-test", soql => /FROM InvoiceLineTax/.test(soql) ? { status: 400, json: [{ errorCode: "INVALID_TYPE", message: "sObject type 'InvoiceLineTax' is not supported" }] }
    : /FROM InvoiceLine /.test(soql) ? { status: 200, json: { done: true, records: [{ Id: "5TV000000000001", Product2Id: PRODUCT, ChargeAmount: 1000, TaxAmount: 0, TaxProcessingStatus: "Estimated", TaxTreatmentId: TREATMENT, TaxTreatment: { Name: treatment.name } }] } }
    : { status: 200, json: { done: true, records: [{ Id: "3tt000000000001", DocumentNumber: "DOC-TEST", Status: "Draft" }] } });
  const inv = await readInvoice(client, "v68.0", "3tt000000000001");
  assert.match(inv.taxRecordsError ?? "", /not supported/);
  const d = deriveSalesforceTax(inv, taxable, null, expected);
  assert.deepEqual([d.status, d.reason, invoiceTaxFlowState(d.status, d.reason)], ["CALCULATION_FAILED", "TAX_RECORDS_UNREADABLE", "TAX_RECORDS_UNREADABLE"]);
  // Even with non-taxable lines, an unreadable query never becomes "verified zero tax".
  assert.notEqual(deriveSalesforceTax(inv, [{ id: TREATMENT, name: "x", taxable: false }], null, {}).status, "NO_TAX_EXPECTED");
});

test("14. MOCKED — VERIFIED_ZERO_TAX only when configuration says no tax; p10 DOC-000000014's fallback treatment is TREATMENT_MISMATCH", () => {
  // Genuinely non-taxable: the line's treatment isn't taxable and the product's policy selects nothing taxable.
  const ok = deriveSalesforceTax(invoice([line({ treatment: { id: "1ttEXEMPT000001", name: "Tax Exempt" } })]), [{ id: "1ttEXEMPT000001", name: "Tax Exempt", taxable: false }], null, { [PRODUCT.slice(0, 15)]: { id: "1ttEXEMPT000001", name: "Tax Exempt", taxable: false } });
  assert.deepEqual([ok.status, invoiceTaxFlowState(ok.status, ok.reason)], ["NO_TAX_EXPECTED", "VERIFIED_ZERO_TAX"]);
  // A product without any tax policy, line without treatment → verified no tax.
  const none = deriveSalesforceTax(invoice([line({ treatment: null })]), [], null, { [PRODUCT.slice(0, 15)]: null });
  assert.equal(none.status, "NO_TAX_EXPECTED");
  // DOC-000000014: blank OrderItem.TaxTreatmentId → billed with "Tax Treatment for US LE" while the policy selects a taxable one.
  const fb = deriveSalesforceTax(invoice([line({ treatment: { id: LE_FALLBACK, name: "Tax Treatment for US LE" } })]), [{ id: LE_FALLBACK, name: "Tax Treatment for US LE", taxable: false }], null, expected);
  assert.deepEqual([fb.status, fb.reason, invoiceTaxFlowState(fb.status, fb.reason)], ["CALCULATION_FAILED", "TREATMENT_MISMATCH", "TREATMENT_MISMATCH"]);
  // The billing schedule check catches the same thing BEFORE the invoice exists.
  const item = { id: "802g800000DvMynAAF", product: { id: PRODUCT, name: "Smart LED Bulb", code: PRODUCT_CODE }, tax: { current: null, expected: { id: TREATMENT, name: treatment.name }, state: "will-set", effective: { treatmentId: TREATMENT, taxable: true, engineId: ENGINE, decisionTable: null, taxCode: TAX_CODE }, issues: [] } } as unknown as OrderBillingItem;
  const b = scheduleTreatmentBlockers([item], [{ id: "44b", number: "BS-1", orderItemId: "802g800000DvMynAAF", treatment: { id: LE_FALLBACK, name: "Tax Treatment for US LE" }, taxable: false }]);
  assert.deepEqual(b.map(x => [x.code, x.category]), [["TAX_TREATMENT_NOT_APPLIED", "TREATMENT_MISMATCH"]]);
});

test("15. MOCKED — posting is blocked unless Salesforce's tax is verified (no unaudited override)", () => {
  for (const s of ["TAX_VERIFICATION_FAILED", "TAX_RECORDS_UNREADABLE", "TREATMENT_MISMATCH", "TAX_PENDING", "TAX_CALCULATION_FAILED"] as const) {
    assert.deepEqual(postingDecision(s), { allowed: false, code: s });
    assert.equal(postingDecision(s, true).allowed, false, "an override no longer bypasses the gate (no audit store — fail closed)");
  }
  assert.equal(postingDecision("VERIFIED_TAX_APPLIED").allowed, true);
  assert.equal(postingDecision("VERIFIED_ZERO_TAX").allowed, true);
});

test("16. MOCKED — fully successful taxable invoice: ₹1,000 × 18% → InvoiceLineTax 180 → VERIFIED_TAX_APPLIED (amount from InvoiceLineTax only)", () => {
  const ilt = { id: "2GI000000000001", name: null, amount: 180, rate: 18, code: TAX_CODE, status: null, effectiveDate: TODAY, treatment: { id: TREATMENT, name: treatment.name }, legalEntityId: LE, exemptAmount: 0 };
  const d = deriveSalesforceTax(invoice([line({ taxAmount: 180, chargeAmountWithTax: 1000, taxes: [ilt] })], { tax: 180, totalWithTax: 1180 }), taxable, null, expected);
  assert.deepEqual([d.status, invoiceTaxFlowState(d.status, d.reason)], ["CALCULATED", "VERIFIED_TAX_APPLIED"]);
  assert.deepEqual(d.actual.map(a => [a.source, a.taxAmount, a.taxRate, a.taxCode]), [["SALESFORCE_INVOICELINETAX", 180, 18, TAX_CODE]]);
  // And the order that produced it passed the activation gate.
  assert.deepEqual(codes(evaluateOrderItemTax(facts(), ctx({ orderLegalEntityId: LE }))), []);
});

/* ───────────── product code ambiguity + API version ───────────── */

test("MOCKED — the rate lookup uses Product2.ProductCode (proven E1-B/E1c); an item code that differs is a warning (E5 unverified), never a block", () => {
  const keyed = { ...FIXED, productCode: PRODUCT_CODE };
  const ev = evaluateOrderItemTax(facts({ rates: [keyed], itemProductCodes: { [TREATMENT]: TAX_CODE } }), ctx());
  assert.deepEqual(codes(ev), [], "the product-keyed rate matches even though the item's code differs");
  assert.equal(ev.effective?.rate?.id, keyed.id);
  assert.deepEqual(codes(ev, "warning"), ["TAX_ITEM_PRODUCT_CODE_UNVERIFIED"]);
  // A rate keyed to the ITEM's code doesn't match the product's code — it's not the lookup value (no PRODUCT_CODE_UNVERIFIED anymore).
  const both = evaluateOrderItemTax(facts({ rates: [keyed, { ...keyed, id: "0xqTC", name: "TR-TC", productCode: TAX_CODE }], itemProductCodes: { [TREATMENT]: TAX_CODE } }), ctx());
  assert.deepEqual(codes(both), []);
  assert.equal(both.effective?.rate?.id, keyed.id);
  assert.deepEqual(codes(evaluateOrderItemTax(facts({ itemProductCodes: { [TREATMENT]: TAX_CODE } }), ctx())), [], "a blank rate Product Code matches the product");
});

/* ───────────── E1-B / E1c / E2 regressions (real p10 records; the invoice results are PROVEN in Salesforce, these tests prove the
   application predicts them) ───────────── */

const GST18_TREATMENT = { id: "1ttg8000000OjtdAAC", name: "GST18 Taxable", status: "Active", taxable: true, legalEntityId: LE as string | null, engineId: ENGINE, taxCode: "GST18", productCode: "GST18", useItems: false, policyId: "1Tpg8000000HJ9VCAW" };
const gstFacts = (productCode: string, rates: RRRate[]) => facts({
  productName: productCode === "LP001" ? "Laptop" : "Laptop Basic", taxPolicyId: "1Tpg8000000HJ9VCAW",
  policy: { id: "1Tpg8000000HJ9VCAW", name: "GST18 Tax Policy", status: "Active", selection: "Default", defaultTreatmentId: GST18_TREATMENT.id },
  expected: GST18_TREATMENT, currentId: GST18_TREATMENT.id, current: GST18_TREATMENT, itemTaxCodes: {}, itemProductCodes: {}, productCode, rates,
});
const RATE = (o: Partial<RRRate>): RRRate => ({ id: "0xq", name: "TR", taxCode: "GST18", rate: 18, countryIso: "IN", stateIso: null, city: null, zipCode: null, productCode: null, legalEntityId: LE, usage: "RevCloud", basis: "Net", start: "2026-01-01", end: null, priority: 1, ...o });
const TR2 = RATE({ id: "0xqg800000001lhAAA", name: "TR-00000002", productCode: "GST18" });
const TR21 = RATE({ id: "0xqg800000002GLAAY", name: "TR-00000021", productCode: "LPB-001" });
const TR22 = RATE({ id: "0xqg800000002HxAAI", name: "TR-00000022", productCode: null, stateIso: "KA" });
const AP = ctx({ addresses: [{ label: "Billing Address", countryIso: "IN", stateIso: "AP", city: "Vijayawada", zipCode: "520002" }] });
const KA = ctx({ addresses: [{ label: "Billing Address", countryIso: "IN", stateIso: "KA", city: "Bengaluru", zipCode: "560001" }] });

test("E1-B baseline — only TR-00000002 (ProductCode GST18): LPB-001 has NO matching rate → activation blocked (Salesforce produced ₹0, DOC-000000018)", () => {
  const ev = evaluateOrderItemTax(gstFacts("LPB-001", [TR2]), AP);
  assert.deepEqual(codes(ev), ["MISSING_TAX_RATE"]);
  assert.equal(ev.effective?.rate ?? null, null);
});

test("E1c baseline — TR-00000021 (ProductCode LPB-001) added: single match 18% → activation passes (Salesforce: InvoiceLineTax ₹1,800 on ₹10,000, DOC-000000019)", () => {
  const ev = evaluateOrderItemTax(gstFacts("LPB-001", [TR2, TR21]), AP);
  assert.deepEqual(codes(ev), []);
  assert.equal(ev.effective?.rate?.id, TR21.id, "matched by the product's own code, not the treatment's GST18");
});

test("E2 baseline — TR-00000022 (blank ProductCode, KA): LP001 in KA single match (Salesforce: ₹188.82 on ₹1,049, DOC-000000020); LP001 in AP no match", () => {
  const rates = [TR2, TR21, TR22];
  const ka = evaluateOrderItemTax(gstFacts("LP001", rates), KA);
  assert.deepEqual(codes(ka), []);
  assert.equal(ka.effective?.rate?.id, TR22.id);
  assert.deepEqual(codes(evaluateOrderItemTax(gstFacts("LP001", rates), AP)), ["MISSING_TAX_RATE"]);
  assert.equal(evaluateOrderItemTax(gstFacts("LPB-001", rates), AP).effective?.rate?.id, TR21.id, "the E1c baseline is unaffected by the KA rate");
});

test("E2 ambiguity — LPB-001 in KA matches TR-00000021 AND blank-code TR-00000022 → MULTIPLE → activation blocked (Salesforce evaluation: Multiple Matches)", () => {
  const ev = evaluateOrderItemTax(gstFacts("LPB-001", [TR2, TR21, TR22]), KA);
  assert.deepEqual(codes(ev), ["AMBIGUOUS_TAX_RATE"]);
  assert.match(ev.issues.find(i => i.code === "AMBIGUOUS_TAX_RATE")!.message, /TR-00000021[\s\S]*TR-00000022 18% — blank = any: [^;)]*Product Code/);
  assert.equal(ev.effective?.rate ?? null, null);
});

test("MOCKED — tax-rate writes are refused when the API version doesn't expose the v68 fields (they would be dropped silently)", () => {
  const r = evaluateTaxRateRules({ mode: "create", values: { RateUsageType: "RevCloud" }, availableFields: ["TaxCode", "GeoCountryId", "RateUsageType", "StartDate"], today: TODAY });
  assert.deepEqual(r.map(i => i.code), ["TAX_API_VERSION_UNSUPPORTED"]);
  assert.match(r[0].message, /ApplicationBasis, TaxRate\.LegalEntityId/);
});

/* ───────────── Invoice verification with the real E1-B / E1c / E2 record shapes ───────────── */

const GST_T = [{ id: "1ttg8000000OjtdAAC", name: "GST18 Taxable", taxable: true }];
const gstLine = (o: Partial<TaxInvoice["lines"][number]>): TaxInvoice["lines"][number] => line({ name: "Laptop Basic", product: "Laptop Basic", productId: "01tg80000072GsfAAE", unitPrice: 10000, charge: 10000, chargeAmountWithTax: 10000, treatment: { id: GST_T[0].id, name: GST_T[0].name }, ...o });
const gstExpected = { "01tg80000072Gsf": { id: GST_T[0].id, name: GST_T[0].name, taxable: true } };

test("E1c regression — DOC-000000019: line Estimated, InvoiceLineTax 1800 @ 18 GST18 with a BLANK InvoiceLineTax.TaxProcessingStatus → CALCULATED (status read from InvoiceLine)", () => {
  const ilt = { id: "2GIg8000001eqybGAA", name: null, amount: 1800, rate: 18, code: "GST18", status: null, effectiveDate: "2026-10-12", treatment: { id: GST_T[0].id, name: GST_T[0].name }, legalEntityId: LE, exemptAmount: 0 };
  const inv = invoice([gstLine({ taxAmount: 1800, chargeAmountWithTax: 10000, taxes: [ilt] })], { number: "DOC-000000019", subtotal: 10000, tax: 1800, totalWithTax: 11800 });
  const d = deriveSalesforceTax(inv, GST_T, null, gstExpected);
  assert.deepEqual([d.status, invoiceTaxFlowState(d.status, d.reason)], ["CALCULATED", "VERIFIED_TAX_APPLIED"]);
  assert.deepEqual(d.actual.map(a => [a.invoiceLineTaxId, a.taxAmount, a.taxRate, a.taxCode, a.taxProcessingStatus]), [["2GIg8000001eqybGAA", 1800, 18, "GST18", null]]);
  assert.equal(inv.subtotal! + d.actual.reduce((s, a) => s + a.taxAmount, 0), inv.totalWithTax, "₹10,000 + ₹1,800 = ₹11,800 (Salesforce's own totals)");
  assert.deepEqual(postingDecision(invoiceTaxFlowState(d.status, d.reason)), { allowed: true, code: null }, "verified — posting is still a separate step outside tax tests");
});

test("E1-B regression — DOC-000000018: finished (Estimated), TaxAmount 0, no InvoiceLineTax, no error log → CALCULATION_FAILED · INVOICE_TIME_TAX_NOT_APPLIED; posting blocked", () => {
  const inv = invoice([gstLine({ taxAmount: 0, taxes: [] })], { number: "DOC-000000018", subtotal: 10000, tax: 0, totalWithTax: 10000 });
  const d = deriveSalesforceTax(inv, GST_T, null, gstExpected);
  assert.deepEqual([d.status, d.reason], ["CALCULATION_FAILED", "INVOICE_TIME_TAX_NOT_APPLIED"]);
  assert.deepEqual(d.actual, [], "no amount is ever reported without InvoiceLineTax");
  assert.equal(postingDecision(invoiceTaxFlowState(d.status, d.reason)).allowed, false);
});

test("E2 regression — DOC-000000020: ₹1,049 → InvoiceLineTax 188.82 (non-integer, persisted as-is) → CALCULATED; a line TaxAmount without InvoiceLineTax is NOT tax", () => {
  const ilt = { id: "2GIg8000001etBhGAI", name: null, amount: 188.82, rate: 18, code: "GST18", status: null, effectiveDate: "2026-10-12", treatment: { id: GST_T[0].id, name: GST_T[0].name }, legalEntityId: LE, exemptAmount: 0 };
  const lp = (o: Partial<TaxInvoice["lines"][number]>) => gstLine({ name: "Laptop", product: "Laptop", productId: "01tg8000006f8uVAAQ", unitPrice: 1049, charge: 1049, ...o });
  const exp = { "01tg8000006f8uV": gstExpected["01tg80000072Gsf"] };
  const d = deriveSalesforceTax(invoice([lp({ taxAmount: 188.82, chargeAmountWithTax: 1049, taxes: [ilt] })], { subtotal: 1049, tax: 188.82, totalWithTax: 1237.82 }), GST_T, null, exp);
  assert.deepEqual([d.status, d.actual[0]?.taxAmount], ["CALCULATED", 188.82]);
  // Only Salesforce's InvoiceLineTax is evidence: a line TaxAmount with no InvoiceLineTax record is never "calculated".
  const noIlt = deriveSalesforceTax(invoice([lp({ taxAmount: 188.82, taxes: [] })]), GST_T, null, exp);
  assert.notEqual(noIlt.status, "CALCULATED");
  assert.deepEqual(noIlt.actual, []);
});

test("error logging — a TAX_* RevenueTransactionErrorLog on the run's records → CALCULATION_FAILED · TAX_PROCESSING_ERROR with the log, never ₹0 'no tax'", () => {
  const d = deriveSalesforceTax(invoice([gstLine({ taxStatus: "Estimated" })]), GST_T, { number: "RTEL-1", code: "TAX_INTERNAL_ERROR", message: "Decision Table lookup failed for request at index 0" }, gstExpected);
  assert.deepEqual([d.status, d.reason], ["CALCULATION_FAILED", "TAX_PROCESSING_ERROR"]);
  assert.match(d.message, /TAX_INTERNAL_ERROR: Decision Table lookup failed/);
  assert.equal(postingDecision(invoiceTaxFlowState(d.status, d.reason)).allowed, false);
});

test("rateOverlap (pure) — p10 shapes: TR-00000021 vs TR-00000022 conditional; blank/no-state vs TR-00000021 always; other legal entity or dates none", () => {
  const k = (o: Partial<RateKey>): RateKey => ({ taxCode: "GST18", country: "IN", state: null, city: null, zipCode: null, productCode: null, legalEntityId: LE, usage: "RevCloud", start: "2026-01-01", end: null, ...o });
  const tr21 = k({ productCode: "LPB-001" }), tr22 = k({ state: "KA" }), tr2 = k({ productCode: "GST18" });
  assert.equal(rateOverlap(tr21, tr22), "conditional", "LPB-001 in KA only (Salesforce: Multiple Matches there)");
  assert.equal(rateOverlap(k({}), tr21), "always", "a blank-code, state-less rate covers every LPB-001 sale");
  assert.equal(rateOverlap(tr21, tr2), "none", "different product codes never co-match");
  assert.equal(rateOverlap(tr21, k({ productCode: "LPB-001", legalEntityId: "0fwOTHER0000001" })), "none");
  assert.equal(rateOverlap(tr21, k({ productCode: "LPB-001", start: "2025-01-01", end: "2025-12-31" })), "none", "non-overlapping dates");
  assert.equal(rateOverlap(tr21, k({ productCode: "LPB-001", usage: "Commerce" })), "none", "different usage type");
});

test("rate rules — a blank Product Code on create is an explicit WARNING (never an error, never silent)", () => {
  const fields = ["RateUsageType", "ApplicationBasis", "LegalEntityId", "StartDate", "TaxCode", "GeoCountryId", "EndDate", "Rate", "ProductCode"];
  const v = { TaxCode: TAX_CODE, GeoCountryId: "IN", LegalEntityId: LE, Rate: 18, RateUsageType: "RevCloud", ApplicationBasis: "Net", StartDate: "2026-01-01" };
  assert.deepEqual(evaluateTaxRateRules({ mode: "create", values: v, availableFields: fields, today: TODAY }).map(i => [i.severity, i.code]), [["warning", "RATE_PRODUCT_CODE_BLANK"]]);
  assert.deepEqual(evaluateTaxRateRules({ mode: "create", values: { ...v, ProductCode: "LPB-001" }, availableFields: fields, today: TODAY }), []);
});

/* ───────────── Line "amount with tax" (p10 DOC-000000021: InvoiceLine.ChargeAmountWithTax excludes the tax) ───────────── */

const DOC21_ILT = { id: "2GIg8000001eufdGAA", name: null, amount: 1800, rate: 18, code: "GST18", status: null, effectiveDate: "2026-10-12", treatment: { id: "1ttg8000000OjtdAAC", name: "GST18 Taxable" }, legalEntityId: LE, exemptAmount: 0 };

test("line total — DOC-000000021 (charge 10000, TaxAmount 1800, InvoiceLineTax 1800, raw ChargeAmountWithTax 10000) → DERIVED 11800; the raw 10000 is never the inclusive total", () => {
  const r = lineTotalWithTax({ charge: 10000, taxAmount: 1800, chargeAmountWithTax: 10000, taxes: [DOC21_ILT] });
  assert.deepEqual([r.basis, r.value], ["derived", 11800]);
  assert.match(r.detail, /ChargeAmount 10000 \+ InvoiceLineTax 1800/);
  assert.match(r.detail, /ChargeAmountWithTax is 10000 \(not used/);
  // E2 DOC-000000020: 1049 + 188.82 = 1237.82 (non-integer tax, kept to the cent).
  assert.deepEqual(lineTotalWithTax({ charge: 1049, taxAmount: 188.82, chargeAmountWithTax: 1049, taxes: [{ ...DOC21_ILT, amount: 188.82 }] }).value, 1237.82);
});

test("line total — UNAVAILABLE (never guessed) without verified tax: no InvoiceLineTax, unreadable InvoiceLineTax, TaxAmount ≠ InvoiceLineTax, no charge", () => {
  const e1b = lineTotalWithTax({ charge: 10000, taxAmount: 0, chargeAmountWithTax: 10000, taxes: [] }); // DOC-000000018
  assert.deepEqual([e1b.basis, e1b.value], ["unavailable", null]);
  assert.equal(lineTotalWithTax({ charge: 10000, taxAmount: 1800, chargeAmountWithTax: 10000, taxes: [DOC21_ILT] }, "sObject type 'InvoiceLineTax' is not supported").basis, "unavailable");
  const mismatch = lineTotalWithTax({ charge: 10000, taxAmount: 900, chargeAmountWithTax: 10000, taxes: [DOC21_ILT] });
  assert.deepEqual([mismatch.basis, mismatch.value], ["unavailable", null]);
  assert.match(mismatch.detail, /TaxAmount 900 differs from its InvoiceLineTax total 1800/);
  assert.equal(lineTotalWithTax({ charge: null, taxAmount: 1800, chargeAmountWithTax: null, taxes: [DOC21_ILT] }).basis, "unavailable");
  assert.equal(lineTotalWithTax({ charge: 10000, taxAmount: 1800, chargeAmountWithTax: 10000, taxes: [{ ...DOC21_ILT, amount: null }] }).basis, "unavailable");
});

test("readInvoice — DOC-000000021 response shape: invoice summary = TotalChargeAmount / TotalTaxAmount / TotalAmountWithTax (10000 / 1800 / 11800); line keeps the raw ChargeAmountWithTax only as chargeAmountWithTax", async () => {
  const { client } = fakeClient("doc21-test", soql => /FROM InvoiceLineTax/.test(soql)
    ? { status: 200, json: { done: true, records: [{ Id: DOC21_ILT.id, InvoiceLineId: "5TVg8000000CD37GAG", TaxName: null, TaxAmount: 1800, TaxRate: 18, TaxCode: "GST18", TaxProcessingStatus: null, TaxEffectiveDate: "2026-10-12", TaxTreatmentId: "1ttg8000000OjtdAAC", TaxTreatment: { Name: "GST18 Taxable" }, LegalEntityId: "0fwg8000000FFefAAG", TaxExemptAmount: 0 }] } }
    : /FROM InvoiceLine /.test(soql)
      ? { status: 200, json: { done: true, records: [{ Id: "5TVg8000000CD37GAG", Name: "Laptop Basic", Product2Id: "01tg80000072GsfAAE", Product2: { Name: "Laptop Basic" }, Quantity: 1, UnitPrice: 10000, ChargeAmount: 10000, TaxAmount: 1800, ChargeAmountWithTax: 10000, TaxProcessingStatus: "Estimated", TaxTreatmentId: "1ttg8000000OjtdAAC", TaxTreatment: { Name: "GST18 Taxable" }, LegalEntityId: "0fwg8000000FFefAAG", AdjustmentAmount: 0, AdjustmentTaxAmount: 0 }] } }
      : { status: 200, json: { done: true, records: [{ Id: "3ttg8000000QZwbAAG", DocumentNumber: "DOC-000000021", Status: "Draft", TotalChargeAmount: 10000, TotalTaxAmount: 1800, TotalAmountWithTax: 11800, Balance: 11800, InvoiceDate: "2026-10-12" }] } });
  const inv = await readInvoice(client, "v68.0", "3ttg8000000QZwbAAG");
  assert.deepEqual([inv.number, inv.status, inv.subtotal, inv.tax, inv.totalWithTax], ["DOC-000000021", "Draft", 10000, 1800, 11800]);
  const l = inv.lines[0];
  assert.deepEqual([l.charge, l.taxAmount, l.taxStatus, l.chargeAmountWithTax], [10000, 1800, "Estimated", 10000]);
  assert.equal("amountWithTax" in l, false, "the misleading 'amount with tax' field no longer exists");
  assert.deepEqual([l.totalWithTax?.basis, l.totalWithTax?.value], ["derived", 11800]);
  assert.equal(inv.subtotal! + inv.tax!, inv.totalWithTax, "Salesforce's own invoice totals are consistent");
  assert.deepEqual(deriveSalesforceTax(inv, GST_T, null, gstExpected).status, "CALCULATED");
});

test("readInvoice — the invoice subtotal is TotalChargeAmount only: when it's absent the subtotal is unavailable (null), never another field", async () => {
  const { client } = fakeClient("subtotal-test", soql => /FROM InvoiceLine/.test(soql) ? { status: 200, json: { done: true, records: [] } }
    : { status: 200, json: { done: true, records: [{ Id: "3tt000000000002", DocumentNumber: "DOC-X", Status: "Draft", TotalAmount: 11800, TotalTaxAmount: 1800, TotalAmountWithTax: 11800 }] } });
  const inv = await readInvoice(client, "v68.0", "3tt000000000002");
  assert.equal(inv.subtotal, null);
});

/* ───────────── F1: strict line-total validation · F2: no TotalAmount fallback for invoice totals ───────────── */

test("F1 — derived only with a usable InvoiceLine.TaxAmount that agrees with InvoiceLineTax: missing / NaN TaxAmount → unavailable; zero tax without InvoiceLineTax → unavailable", () => {
  const base = { charge: 10000, chargeAmountWithTax: 10000, taxes: [DOC21_ILT] };
  const missing = lineTotalWithTax({ ...base, taxAmount: null });
  assert.deepEqual([missing.basis, missing.value], ["unavailable", null], "a blank TaxAmount can't be checked against InvoiceLineTax");
  assert.match(missing.detail, /no usable InvoiceLine\.TaxAmount/);
  assert.equal(lineTotalWithTax({ ...base, taxAmount: Number.NaN }).basis, "unavailable");
  const zero = lineTotalWithTax({ charge: 10000, taxAmount: 0, chargeAmountWithTax: 10000, taxes: [] });
  assert.deepEqual([zero.basis, zero.value], ["unavailable", null], "zero tax with no InvoiceLineTax stays unavailable (conservative policy)");
  assert.match(zero.detail, /No InvoiceLineTax/);
  // Unchanged: the positive DOC-000000021 case and the mismatch case.
  assert.deepEqual([lineTotalWithTax({ ...base, taxAmount: 1800 }).basis, lineTotalWithTax({ ...base, taxAmount: 1800 }).value], ["derived", 11800]);
  assert.equal(lineTotalWithTax({ ...base, taxAmount: 900 }).basis, "unavailable");
});

test("F2 — invoice total with tax = Invoice.TotalAmountWithTax only; a missing value is null, never the pre-tax TotalAmount (p10 DOC-000000019: 10000 vs 11800)", () => {
  assert.equal(invoiceTotalWithTax({ TotalAmount: 10000, TotalAmountWithTax: 11800 }), 11800);
  assert.equal(invoiceTotalWithTax({ TotalAmount: 10000 }), null, "never falls back to the pre-tax TotalAmount");
  assert.equal(invoiceTotalWithTax({ TotalAmount: 10000, TotalAmountWithTax: null }), null);
  assert.equal(invoiceTotalWithTax({ TotalAmountWithTax: "11800" }), null, "only a real number is a total");
  assert.equal(invoiceTotalWithTax(null), null);
  assert.equal(invoiceTotalWithTax({ TotalAmountWithTax: 0 }), 0, "a genuine 0 total stays 0");
});

test("F2 — order-billing and payment invoice readers use invoiceTotalWithTax and keep no TotalAmount fallback", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["lib/billing/server/orderBilling.ts", "lib/billing/server/payments.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /invoiceTotalWithTax\((i|row)\)/, `${f} uses the shared helper`);
    assert.doesNotMatch(src, /TotalAmountWithTax\)?\s*\?\?\s*(num\()?\s*\w+\.TotalAmount\b/, `${f} has no TotalAmountWithTax → TotalAmount fallback`);
  }
});
