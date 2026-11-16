/**
 * Order Product → Tax Treatment propagation and the readiness checks around it. Fixtures are the real p10 records and Salesforce
 * responses recorded on 2026-10-09 (Aetherion XQ731: order 00000131 → BS-000000018 → DOC-000000014, no InvoiceLineTax; the
 * successful India run: order 00000129 → DOC-000000013 → InvoiceLineTax 2GIg8000001aTyzGAE, 180 at 18%).
 *
 * Run: `npx tsx --test lib/tax/server/orderItemTax.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateOrderItemTax, evaluateTaxGeography, type OrderItemTaxFacts, type TaxGeoFacts } from "./orderItemTax";
import { evaluateInvoiceLineTax, evaluateOrderTaxReadiness, evaluateEngineReadiness, type LineExpectation } from "./pipeline";
import { resolveTaxConfiguration, type ResolutionData } from "./resolution";
import { parsePreview, previewDecisionTable, type PreviewApi } from "./calculationDiagnostics";
import { sellingModelIssue } from "@/lib/billing/server/orderBilling";
import type { DecisionTableState } from "./engine";
import type { TaxRunState } from "./verification";

/* ───────────── p10 records ───────────── */

const LE = "0fwg8000000FFefAAG";
const PRODUCT = "01tg8000007BGJxAAO", POLICY = "1Tpg8000000Hq8fCAC", TREATMENT = "1ttg8000000PcenAAC", ITEM = "1tug8000000AdjFAAS";
const ENGINE = "4wAg80000002mBpEAI", WORKING_ENGINE = "4wAg80000002nW5EAI", TAXCODE_TABLE = "0lDg8000000HC3BEAW", SYSTEM_TABLE = "0lDg8000000FR09EAG";
const LE_TREATMENT = "1ttg8000000Ne4nAAC";
const TAX_CODE = "IN-ADW-XQ731-GST18-61009", PRODUCT_CODE = "ADW-XQ731-20261009";

const treatment = { id: TREATMENT, name: "Aetherion Deepwave Fiscal Treatment XQ731", status: "Active", taxable: true, legalEntityId: null as string | null, engineId: ENGINE, taxCode: TAX_CODE, productCode: PRODUCT_CODE, useItems: true };
function facts(o: Partial<OrderItemTaxFacts> = {}, engineTable: string | null = null): OrderItemTaxFacts {
  return {
    productName: "Aetherion Deepwave Compute Node XQ-731", taxPolicyId: POLICY,
    policy: { id: POLICY, name: "Aetherion Deepwave India Fiscal Policy XQ731", status: "Active", selection: "Default", defaultTreatmentId: TREATMENT },
    expected: treatment, currentId: null, current: null,
    engines: {
      [ENGINE]: { id: ENGINE, name: "Revenue Standard Tax Engine", status: "Active", type: "RevenueStandardTax", decisionTableId: engineTable },
      [WORKING_ENGINE]: { id: WORKING_ENGINE, name: "Desktop Germany Tax Engine", status: "Active", type: "RevenueStandardTax", decisionTableId: TAXCODE_TABLE },
    },
    itemTaxCodes: { [TREATMENT]: TAX_CODE },
    tables: { [TAXCODE_TABLE]: { id: TAXCODE_TABLE, name: "RevenueStandardTaxWithTaxCode", hasTaxCode: true, engines: ["Desktop Germany Tax Engine", ...(engineTable ? ["Revenue Standard Tax Engine"] : [])] } },
    systemTable: { id: SYSTEM_TABLE, name: "StandardTax", hasTaxCode: false, engines: [] },
    ...o,
  };
}
const codes = (ev: ReturnType<typeof evaluateOrderItemTax>, severity?: string) => ev.issues.filter(i => !severity || i.severity === severity).map(i => i.code);

/* ───────────── 1. treatment propagation ───────────── */

test("REGRESSION p10 order 00000131: blank OrderItem.TaxTreatmentId → the policy's treatment is resolved and must be set (Salesforce doesn't derive it)", () => {
  const ev = evaluateOrderItemTax(facts({}, TAXCODE_TABLE));
  assert.equal(ev.state, "will-set");
  assert.deepEqual(ev.expected, { id: TREATMENT, name: "Aetherion Deepwave Fiscal Treatment XQ731" });
  assert.equal(ev.current, null);
  assert.equal(ev.effective?.taxCode, TAX_CODE, "the item's tax code is what the decision table matches");
  // Already stamped → nothing to do; a different treatment is kept (never overwritten) and flagged.
  assert.equal(evaluateOrderItemTax(facts({ currentId: TREATMENT, current: treatment }, TAXCODE_TABLE)).state, "set");
  const conflict = evaluateOrderItemTax(facts({ currentId: LE_TREATMENT, current: { ...treatment, id: LE_TREATMENT, name: "Tax Treatment for US LE", taxable: false, engineId: null } }, TAXCODE_TABLE));
  assert.equal(conflict.state, "conflict");
  assert.ok(codes(conflict).includes("TAX_TREATMENT_CONFLICT"));
  assert.ok(codes(conflict).includes("TAX_TREATMENT_NOT_TAXABLE"), "the treatment Salesforce would really bill is evaluated, not the policy's");
});

test("order tax readiness: an order product without TaxTreatmentId is BLOCKED, never resolved through the policy as if Salesforce would", () => {
  const res = resolveTaxConfiguration(resolutionData(), { country: "IN", state: "AP", legalEntityId: LE, effectiveDate: "2026-10-09" });
  const order = { Id: "801g800000zU2PTAA0", OrderNumber: "00000131", Status: "Draft", AccountId: "001g800000zTEywAAG", Account: { Name: "Aetherion Deepwave India Validation Account XQ731" }, BillingCountry: "IN", BillingState: "AP" };
  const row = { Id: "802g800000DqU0wAAF", Product2Id: PRODUCT, Product2: { Name: "Aetherion Deepwave Compute Node XQ-731" }, Quantity: 1, UnitPrice: 3000, ProductSellingModelId: "0jPg8000000JE2YEAW", ProductSellingModel: { Name: "One Time" } };
  const blank = evaluateOrderTaxReadiness(order, [{ row: { ...row, TaxTreatmentId: null }, resolution: res }]);
  assert.equal(blank.status, "BLOCKED");
  assert.match(blank.items[0].checks.find(c => c.id === "stamp")!.detail, /legal entity's default treatment/);
  const stamped = evaluateOrderTaxReadiness(order, [{ row: { ...row, TaxTreatmentId: TREATMENT, TaxTreatment: { Name: "x" } }, resolution: resolveTaxConfiguration(resolutionData(), { country: "IN", state: "AP", legalEntityId: LE, effectiveDate: "2026-10-09", treatmentId: TREATMENT }) }]);
  assert.equal(stamped.items[0].checks.find(c => c.id === "stamp"), undefined);
});

/* ───────────── 2. product selling model ───────────── */

test("missing Product Selling Model: actionable — reuse an entry with the model, else the exact admin change (it can't be written on the Order Product)", () => {
  const admin = sellingModelIssue({ productName: "Aetherion Deepwave Compute Node XQ-731", pricebookEntryId: "01ug8000004WB2vAAG", optionNames: ["One Time", "One Time"], alternative: null });
  assert.match(admin, /PricebookEntry 01ug8000004WB2vAAG has none/);
  assert.match(admin, /create a PricebookEntry for Aetherion Deepwave Compute Node XQ-731 .* Product Selling Model One Time —/);
  const reuse = sellingModelIssue({ productName: "Laptop", pricebookEntryId: "01u000000000AA1", optionNames: ["One Time"], alternative: { id: "01u000000000AA2", sellingModel: "One Time" } });
  assert.match(reuse, /add Laptop again from PricebookEntry 01u000000000AA2 \(One Time\)/);
});

/* ───────────── 3. engine decision table ───────────── */

test("REGRESSION p10: engine without DecisionTableId falls back to StandardTax (no TaxCode input) → error naming the table that has one and the engines sharing it", () => {
  const ev = evaluateOrderItemTax(facts());
  const e = ev.issues.find(i => i.code === "TAX_ENGINE_DECISION_TABLE_MISSING")!;
  assert.equal(e.severity, "error");
  assert.match(e.message, /system table StandardTax, which has no TaxCode input — a lookup that includes tax code IN-ADW-XQ731-GST18-61009 fails/);
  assert.match(e.message, new RegExp(`${TAXCODE_TABLE}, already used by Desktop Germany Tax Engine`), "the shared-engine dependency is stated before anyone changes it");
  assert.match(e.message, /admin, not automatic/);
  assert.deepEqual(ev.effective?.decisionTable, { id: SYSTEM_TABLE, name: "StandardTax", source: "system" });
  // With the TaxCode table assigned, the configuration resolves.
  const fixed = evaluateOrderItemTax(facts({ expected: { ...treatment, legalEntityId: LE } }, TAXCODE_TABLE));
  assert.deepEqual(codes(fixed), []);
  assert.deepEqual(fixed.effective?.decisionTable, { id: TAXCODE_TABLE, name: "RevenueStandardTaxWithTaxCode", source: "engine" });
  // An engine table without TaxCode can't match a treatment that relies on one.
  const noCode = evaluateOrderItemTax(facts({ tables: { [TAXCODE_TABLE]: { id: TAXCODE_TABLE, name: "Clone", hasTaxCode: false, engines: [] } } }, TAXCODE_TABLE));
  assert.ok(codes(noCode, "error").includes("TAX_DECISION_TABLE_NO_TAXCODE"));
  // The structured engine readiness agrees (StandardTax without TaxCode → BLOCKED).
  const er = evaluateEngineReadiness({ id: ENGINE, name: "Revenue Standard Tax Engine", type: "RevenueStandardTax", status: "Active", native: true, decisionTableId: null }, standardTax());
  assert.equal(er.status, "BLOCKED");
  assert.equal(er.checks.find(c => c.code === "TABLE_TAXCODE_INPUT")!.passed, false);
});

test("inactive / incompatible treatment and missing item or engine are errors, a missing tax policy is a warning", () => {
  assert.ok(codes(evaluateOrderItemTax(facts({ expected: { ...treatment, status: "Inactive" } }, TAXCODE_TABLE)), "error").includes("TAX_TREATMENT_INACTIVE"));
  assert.ok(codes(evaluateOrderItemTax(facts({ itemTaxCodes: {} }, TAXCODE_TABLE)), "error").includes("TAX_TREATMENT_ITEM_MISSING"));
  assert.ok(codes(evaluateOrderItemTax(facts({ expected: { ...treatment, engineId: null } })), "error").includes("TAX_ENGINE_MISSING"));
  const inactiveEngine = facts({}, TAXCODE_TABLE);
  inactiveEngine.engines[ENGINE] = { ...inactiveEngine.engines[ENGINE], status: "Inactive" };
  assert.ok(codes(evaluateOrderItemTax(inactiveEngine), "error").includes("TAX_ENGINE_INACTIVE"));
  const manual = evaluateOrderItemTax(facts({ policy: { ...facts().policy!, selection: "Manual" } }));
  assert.ok(codes(manual, "error").includes("TAX_TREATMENT_MANUAL"));
  const none = evaluateOrderItemTax(facts({ taxPolicyId: null, policy: null, expected: null }));
  assert.deepEqual([none.state, codes(none, "warning")], ["not-applicable", ["TAX_POLICY_MISSING"]]);
});

/* ───────────── 4. treatment legal entity ───────────── */

test("missing treatment LegalEntityId BLOCKS (error) on the order product and in order tax readiness (p10: DOC-11/12/15/16 without it got no tax)", () => {
  const ev = evaluateOrderItemTax(facts({}, TAXCODE_TABLE));
  assert.deepEqual(codes(ev, "error"), ["TAX_TREATMENT_LEGAL_ENTITY_MISSING"]);
  const res = resolveTaxConfiguration(resolutionData(), { country: "IN", state: "AP", legalEntityId: LE, effectiveDate: "2026-10-09", treatmentId: TREATMENT });
  const r = evaluateOrderTaxReadiness({ Id: "801", AccountId: "001", Account: { Name: "A" }, BillingCountry: "IN", BillingState: "AP" }, [{ row: { Id: "802", Product2Id: PRODUCT, Quantity: 1, UnitPrice: 3000, TaxTreatmentId: TREATMENT }, resolution: res }]);
  assert.equal(r.items[0].checks.find(c => c.id === "treatment-legal-entity")?.status, "BLOCKED");
});

/* ───────────── 5. geography + decision-table No Match ───────────── */

const GEO: TaxGeoFacts = { countries: [{ name: "India", iso: "IN" }, { name: "United States", iso: "US" }], states: [{ name: "Andhra Pradesh", iso: "AP", countryIso: "IN" }, { name: "Karnataka", iso: "KA", countryIso: "IN" }] };

test("REGRESSION p10 DOC-000000014: address \"India\"/\"Andhra Pradesh\" is an error with the exact codes; IN/AP passes", () => {
  const bad = evaluateTaxGeography("Shipping Address", { country: "India", state: "Andhra Pradesh" }, GEO);
  assert.deepEqual(bad.map(i => i.code), ["TAX_GEOGRAPHY_NOT_CODE", "TAX_GEOGRAPHY_NOT_CODE"]);
  assert.match(bad[0].message, /set it to the ISO code "IN"/);
  assert.match(bad[1].message, /set it to the code "AP"/);
  assert.deepEqual(evaluateTaxGeography("Shipping Address", { country: "IN", state: "AP" }, GEO), []);
  assert.equal(evaluateTaxGeography("Billing Address", { country: "Atlantis", state: null }, GEO)[0].code, "TAX_GEOGRAPHY_UNKNOWN");
  assert.equal(evaluateTaxGeography("Billing Address", { country: null, state: null }, GEO)[0].code, "TAX_GEOGRAPHY_MISSING");
  const res = resolveTaxConfiguration(resolutionData(), { country: "India", state: "Andhra Pradesh", legalEntityId: LE, effectiveDate: "2026-10-09", treatmentId: TREATMENT });
  const r = evaluateOrderTaxReadiness({ Id: "801", AccountId: "001", Account: { Name: "A" }, BillingCountry: "India", BillingState: "Andhra Pradesh" }, [{ row: { Id: "802", Product2Id: PRODUCT, Quantity: 1, UnitPrice: 3000, TaxTreatmentId: TREATMENT }, resolution: res }]);
  assert.equal(r.status, "BLOCKED", "the app's name→code mapping must not hide that Salesforce compares the exact value");
  assert.match(r.items[0].checks.find(c => c.id === "geography-codes")!.detail, /"IN"/);
});

/** Salesforce's evaluation endpoint, answering with the responses recorded from p10 for these exact inputs. */
function recordedTable(): PreviewApi & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    params: async () => ["Country", "State", "City", "ZipCode", "ProductCode", "StartDate", "EndDate", "RateUsageType", "LegalEntityId", "TaxCode"].map(field => ({ field, operator: field === "StartDate" ? "GreaterOrEqual" : field === "EndDate" ? "LessOrEqual" : "Equals" })),
    evaluate: async (_id, conditions) => {
      sent.push(conditions);
      const v = Object.fromEntries(conditions.map(c => [c.fieldName, c.value]));
      // 2026-10-09 p10 (before TR-00000019): only TR-00000018 (Commerce, Gross) carried this tax code.
      if (v.TaxCode === TAX_CODE && v.RateUsageType === "Commerce" && v.Country === "IN") return { status: 201, json: { errorCode: null, errorMessage: null, outcomeList: [{ values: { ApplicationBasis: "Gross", Rate: 18.0, Priority: 1.0, FlatTaxAmount: null } }], outcomeType: "Single Match", successStatus: true } };
      if (v.TaxCode === "OC_GST_E2E_202610081015" && v.Country === "IN" && v.State === "AP" && v.RateUsageType === "RevCloud") return { status: 201, json: { errorCode: null, errorMessage: null, outcomeList: [{ values: { ApplicationBasis: "Net", Rate: 18.0, Priority: 1.0, FlatTaxAmount: null } }], outcomeType: "Single Match", successStatus: true } };
      return { status: 201, json: { errorCode: null, errorMessage: null, outcomeList: [], outcomeType: "No Match", successStatus: true } };
    },
  };
}

test("REGRESSION p10: decision-table No Match is reported as no match — exact tax code, product code, IN/AP, RevCloud and legal entity are what is sent", async () => {
  const api = recordedTable();
  const inputs = { Country: "IN", State: "AP", City: "Vijayawada", ZipCode: null, ProductCode: PRODUCT_CODE, StartDate: "2026-10-09", EndDate: "2026-10-09", RateUsageType: "RevCloud", LegalEntityId: LE, TaxCode: TAX_CODE };
  const p = await previewDecisionTable(api, { decisionTableId: TAXCODE_TABLE, decisionTableName: "RevenueStandardTaxWithTaxCode", inputs });
  assert.equal(p.matched, false);
  assert.equal(p.outcomeType, "No Match");
  assert.equal(p.rate, null, "no rate is invented for a No Match");
  const sent = Object.fromEntries((api.sent[0] as { fieldName: string; value: string }[]).map(c => [c.fieldName, c.value]));
  assert.deepEqual(sent, { Country: "IN", State: "AP", City: "Vijayawada", ProductCode: PRODUCT_CODE, StartDate: "2026-10-09T00:00:00.000Z", EndDate: "2026-10-09T00:00:00.000Z", RateUsageType: "RevCloud", LegalEntityId: LE, TaxCode: TAX_CODE });
  // The names never match either.
  assert.equal((await previewDecisionTable(api, { decisionTableId: TAXCODE_TABLE, decisionTableName: null, inputs: { ...inputs, Country: "India", State: "Andhra Pradesh" } })).matched, false);
  // A Salesforce error stays an error (never a match).
  const err = parsePreview({ status: 500, json: [{ errorCode: "UNKNOWN_EXCEPTION", message: "An unexpected error occurred." }] }, { decisionTableId: TAXCODE_TABLE, decisionTableName: null, conditions: [], taxRate: null });
  assert.deepEqual([err.matched, err.error?.code], [false, "UNKNOWN_EXCEPTION"]);
  // Control: the successful India configuration matches 18% Net.
  const ok = await previewDecisionTable(api, { decisionTableId: TAXCODE_TABLE, decisionTableName: null, inputs: { ...inputs, ProductCode: "OC-TAX-E2E-202610081015", TaxCode: "OC_GST_E2E_202610081015" } });
  assert.deepEqual([ok.matched, ok.rate, ok.applicationBasis], [true, 18, "Net"]);
});

/* ───────────── 6. InvoiceLineTax verification ───────────── */

type Invoice = NonNullable<TaxRunState["invoice"]>;
const invoice = (charge: number, taxes: Invoice["lines"][number]["taxes"], taxAmount: number): Invoice => ({
  id: "3ttg8000000PID3AAO", number: "DOC-000000013", status: "Draft", subtotal: charge, tax: taxAmount, totalWithTax: charge + taxAmount, balance: charge + taxAmount, date: "2026-10-08",
  lines: [{ id: "5TVg8000000BjwHGAS", name: "OmniCloud Tax E2E Test Product 202610081015", product: "OmniCloud Tax E2E Test Product 202610081015", productId: "01tg80000078YQHAA2", quantity: 1, unitPrice: charge, charge, taxAmount, chargeAmountWithTax: charge + taxAmount, taxRate: null, taxCode: null, taxStatus: "Estimated", treatment: { id: "1ttg8000000PI09AAG", name: "OmniCloud India Tax E2E Treatment 202610081015" }, taxes }],
});

test("successful 18% verification only from Salesforce's InvoiceLineTax (p10 DOC-000000013: 180 at 18%); none → MISSING", () => {
  const exp = new Map<string, LineExpectation>([["5TVg8000000BjwHGAS", { rateId: "0xqg8000000026fAAA", rate: 18, taxCode: "OC_GST_E2E_202610081015" }]]);
  const ilt = { id: "2GIg8000001aTyzGAE", name: null, amount: 180, rate: 18, code: "OC_GST_E2E_202610081015", status: "Estimated", effectiveDate: null, treatment: { id: "1ttg8000000PI09AAG", name: "x" } };
  const ok = evaluateInvoiceLineTax(invoice(1000, [ilt], 180), exp, null);
  assert.equal(ok.status, "SUCCESS");
  // DOC-000000014's shape: ₹3,000, tax 0, no InvoiceLineTax — never success (the ₹540 at 18% is only the reference value).
  const none = evaluateInvoiceLineTax(invoice(3000, [], 0), exp, null);
  assert.equal(none.status, "FAILED");
  assert.equal(none.lines[0].status, "MISSING");
});

/* ───────────── fixtures ───────────── */

function resolutionData(): ResolutionData {
  return {
    product: { id: PRODUCT, name: "Aetherion Deepwave Compute Node XQ-731", code: PRODUCT_CODE, active: true, taxPolicyId: POLICY },
    policies: [{ id: POLICY, name: "Aetherion Deepwave India Fiscal Policy XQ731", status: "Active", selection: "Default", defaultTreatmentId: TREATMENT }],
    treatments: [{ id: TREATMENT, name: treatment.name, status: "Active", taxable: true, taxCode: TAX_CODE, productCode: PRODUCT_CODE, policyId: POLICY, engineId: ENGINE, legalEntityId: null, useItems: true }],
    items: [{ id: ITEM, name: "Aetherion Deepwave Fiscal Item XQ731", treatmentId: TREATMENT, productId: PRODUCT, taxCode: TAX_CODE, productCode: PRODUCT_CODE }],
    engines: [{ id: ENGINE, name: "Revenue Standard Tax Engine", type: "RevenueStandardTax", status: "Active", native: true, decisionTableId: null, providerId: null }],
    rates: [{ id: "0xqg800000002D7AAI", name: "TR-00000019", taxCode: TAX_CODE, rate: 18, countryIso: "IN", stateIso: "AP", city: null, zipCode: null, productCode: PRODUCT_CODE, legalEntityId: LE, usage: "RevCloud", basis: "Net", start: "2026-10-09", end: null, priority: 1 }],
    geo: { countries: [{ id: "0vfg80000001P9FAAU", name: "India", iso: "IN" }], states: [{ id: "0yxg80000000YcnAAE", name: "Andhra Pradesh", iso: "AP", countryIso: "IN" }] },
    legalEntities: [{ id: LE, name: "Default Legal Entity - US", status: "Active", country: null }],
    tableInputs: ["Country", "State", "City", "ZipCode", "ProductCode", "StartDate", "EndDate", "RateUsageType", "LegalEntityId"],
  };
}

function standardTax(): DecisionTableState {
  return { id: SYSTEM_TABLE, name: "StandardTax", setupName: "Revenue Standard Tax Entries", status: "Active", refreshStatus: "Completed", refreshFailure: null, lastSync: "2026-10-06T06:12:10Z", createdDate: null, inputs: ["Country", "State", "City", "ZipCode", "ProductCode", "StartDate", "EndDate", "RateUsageType", "LegalEntityId"].map(f => ({ field: f, required: f === "Country" || f === "RateUsageType" })), hasTaxCode: false, outdated: false, stale: false, source: "system", engineName: null, outputs: ["FlatTaxAmount", "ApplicationBasis", "Priority", "Rate"], sourceObject: "TaxRate", datasetLinks: [{ id: "0lX000000000DL1", name: "StandardTax_Default", sourceObject: "TaxRate" }] };
}
