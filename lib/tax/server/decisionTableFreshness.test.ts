/**
 * Invoice tax with a decision table that wasn't refreshed after the rate was created. Fixtures are p10's records (2026-11-02):
 *  · India GST — DOC-000000035 (order 00000162): TR-00000028 IN/AP/IN-GST-DESK-001/GST18 created 10:22:32, RevenueStandardTaxWithTaxCode
 *    last refreshed 09:53:01 → Salesforce's evaluation: No Match → line Estimated, TotalTaxAmount 0, no InvoiceLineTax.
 *  · Canada HST — DOC-000000034 (order 00000160): TR-00000027 CA/ON/CA-TAX-MON-001/CA_HST_ONT created 07:00:09, table refreshed 05:25:04
 *    → No Match; after the 09:53:01 refresh the same inputs returned Single Match 13% Net.
 *
 * Run: `npx tsx --test lib/tax/server/decisionTableFreshness.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionTableFreshnessIssues, evaluateOrderItemTax, type DecisionTableFact, type OrderItemTaxFacts, type OrderTaxContext } from "./orderItemTax";
import type { RRRate } from "./resolution";
import { parsePreview } from "./calculationDiagnostics";
import { deriveSalesforceTax, postingDecision, type InvoiceTaxVerification, type TaxInvoice } from "./invoiceTax";
import { invoiceTaxFlowState } from "./calculationResult";
import { recalcEligibility, recalcToken, recalculateInvoiceTax, type RecalcApi, type StaleTable } from "./invoiceRecalc";

const LE = "0fwg8000000FFefAAG", TABLE = "0lDg8000000HC3BEAW", SYSTEM = "0lDg8000000FR09EAG";
const INPUTS = ["Country", "State", "City", "ZipCode", "ProductCode", "StartDate", "EndDate", "RateUsageType", "LegalEntityId", "TaxCode"];
const REFRESH_0525 = "2026-11-02T05:25:04.000+0000", REFRESH_0953 = "2026-11-02T09:53:01.000+0000", REFRESH_1100 = "2026-11-02T11:00:00.000+0000";

const rate = (o: Partial<RRRate> & Pick<RRRate, "id" | "name">): RRRate => ({ taxCode: null, rate: null, countryIso: null, stateIso: null, city: null, zipCode: null, productCode: null, legalEntityId: LE, usage: "RevCloud", basis: "Net", start: null, end: null, priority: 1, ...o });

const CASES = {
  india: {
    product: "India GST Test Desktop", productCode: "IN-GST-DESK-001", taxCode: "GST18", country: "IN", state: "AP",
    treatment: "1ttg8000000TkkDAAS", engine: "4wAg800000047EDEAY", engineName: "India GST Desktop Standard Tax Engine",
    rate: rate({ id: "0xqg800000005R7AAI", name: "TR-00000028", taxCode: "GST18", rate: 18, countryIso: "IN", stateIso: "AP", productCode: "IN-GST-DESK-001", start: "2026-11-02", changedAt: "2026-11-02T10:22:32.000+0000" }),
    // Same code and state, other product — must never be the match.
    other: rate({ id: "0xqg800000002JZAAY", name: "TR-00000023", taxCode: "GST18", rate: 18, countryIso: "IN", stateIso: "AP", productCode: "DS001", start: "2026-10-13", changedAt: "2026-10-13T06:35:32.000+0000" }),
    staleRefresh: REFRESH_0953, freshRefresh: REFRESH_1100,
  },
  canada: {
    product: "Canada Tax Test Monitor", productCode: "CA-TAX-MON-001", taxCode: "CA_HST_ONT", country: "CA", state: "ON",
    treatment: "1ttg8000000Tk2fAAC", engine: "4wAg8000000477lEAA", engineName: "Canada Monitor Standard Tax Engine",
    rate: rate({ id: "0xqg800000005PVAAY", name: "TR-00000027", taxCode: "CA_HST_ONT", rate: 13, countryIso: "CA", stateIso: "ON", productCode: "CA-TAX-MON-001", start: "2026-11-02", changedAt: "2026-11-02T07:00:09.000+0000" }),
    // TR-00000025: CA/ON 13% with another tax code — not a match for CA_HST_ONT.
    other: rate({ id: "0xqg800000005MHAAY", name: "TR-00000025", taxCode: "OCA_DE_BY_VAT_19", rate: 13, countryIso: "CA", stateIso: "ON", basis: "Gross", start: "2026-11-01", changedAt: "2026-11-02T05:01:15.000+0000" }),
    staleRefresh: REFRESH_0525, freshRefresh: REFRESH_0953,
  },
};
type Case = (typeof CASES)[keyof typeof CASES];

const table = (refreshedAt: string | null, o: Partial<DecisionTableFact> = {}): DecisionTableFact => ({ id: TABLE, name: "RevenueStandardTaxWithTaxCode", hasTaxCode: true, engines: [], status: "Active", refreshStatus: "Completed", refreshedAt, ...o });
function facts(c: Case, refreshedAt: string | null, engineTable: string | null = TABLE): OrderItemTaxFacts {
  const treatment = { id: c.treatment, name: `${c.product} Treatment`, status: "Active", taxable: true, legalEntityId: LE, engineId: c.engine, taxCode: c.taxCode, productCode: null, useItems: true };
  return {
    productName: c.product, taxPolicyId: "1Tp000000000001", policy: { id: "1Tp000000000001", name: "Policy", status: "Active", selection: "Default", defaultTreatmentId: c.treatment },
    expected: treatment, currentId: c.treatment, current: treatment,
    engines: { [c.engine]: { id: c.engine, name: c.engineName, status: "Active", type: "RevenueStandardTax", decisionTableId: engineTable } },
    itemTaxCodes: { [c.treatment]: c.taxCode }, itemProductCodes: { [c.treatment]: c.productCode }, productCode: c.productCode,
    tables: { [TABLE]: table(refreshedAt) }, systemTable: { id: SYSTEM, name: "StandardTax", hasTaxCode: false, engines: [] },
    rates: [c.other, c.rate], tableInputs: { [TABLE]: INPUTS, [SYSTEM]: INPUTS.filter(x => x !== "TaxCode") },
  };
}
const ctx = (c: Case): OrderTaxContext => ({ addresses: [{ label: "Billing Address", countryIso: c.country, stateIso: c.state, city: null, zipCode: null }], orderLegalEntityId: LE, orderItemLegalEntityId: null, dates: ["2026-11-02"] });
const codes = (ev: ReturnType<typeof evaluateOrderItemTax>) => ev.issues.filter(i => i.severity === "error").map(i => i.code);

for (const [name, c] of Object.entries(CASES)) {
  test(`${name}: the rate matches every dimension — country, state, product code, tax code, legal entity, RevCloud, Net, effective date`, () => {
    const ev = evaluateOrderItemTax(facts(c, c.freshRefresh), ctx(c));
    assert.deepEqual(codes(ev), []);
    const r = ev.effective!.rate!;
    assert.equal(r.id, c.rate.id);
    assert.deepEqual([r.countryIso, r.stateIso, r.productCode, r.taxCode, r.legalEntityId, r.usage, r.basis, r.start], [c.country, c.state, c.productCode, c.taxCode, LE, "RevCloud", "Net", "2026-11-02"]);
    assert.equal(ev.effective!.decisionTable?.name, "RevenueStandardTaxWithTaxCode");
  });

  test(`${name}: rate created after the decision table's last refresh → TAX_DECISION_TABLE_STALE blocks activation, naming the rate and table`, () => {
    const ev = evaluateOrderItemTax(facts(c, c.staleRefresh), ctx(c));
    assert.deepEqual(codes(ev), ["TAX_DECISION_TABLE_STALE"]);
    const msg = ev.issues.find(i => i.code === "TAX_DECISION_TABLE_STALE")!.message;
    assert.match(msg, new RegExp(`Tax Rate ${c.rate.name} \\(${c.rate.id}\\)`));
    assert.match(msg, new RegExp(`RevenueStandardTaxWithTaxCode \\(${TABLE}\\) was last refreshed \\(${c.staleRefresh.replace(/[.+]/g, "\\$&")}\\)`));
    assert.match(msg, /No Match/);
  });
}

test("a table never refreshed, inactive, or with an unfinished refresh blocks too", () => {
  const r = CASES.india.rate;
  assert.equal(decisionTableFreshnessIssues(table(null), r, [r])[0].code, "TAX_DECISION_TABLE_STALE");
  assert.equal(decisionTableFreshnessIssues(table(REFRESH_1100, { status: "Draft" }), r, [r])[0].code, "TAX_DECISION_TABLE_INACTIVE");
  assert.equal(decisionTableFreshnessIssues(table(REFRESH_1100, { refreshStatus: "InProgress" }), r, [r])[0].code, "TAX_DECISION_TABLE_NOT_REFRESHED");
  // Other rates changed since the refresh are listed with the selected one.
  const other = { id: "0xq000000000OTH", name: "TR-00000099", changedAt: "2026-11-02T10:30:00.000+0000" };
  assert.match(decisionTableFreshnessIssues(table(REFRESH_0953), r, [r, other])[0].message, /1 other rate\(s\) also changed since then: TR-00000099/);
  // Facts without refresh data (older callers) aren't judged.
  assert.deepEqual(decisionTableFreshnessIssues({ id: TABLE, name: "T", hasTaxCode: true, engines: [] }, r, [r]), []);
});

test("missing TaxEngine.DecisionTableId → StandardTax fallback without TaxCode is an error naming the expected table and its Id", () => {
  const c = CASES.india;
  const f = facts(c, c.freshRefresh, null);
  // The expected table is known because another engine already uses it.
  f.engines["4wAg80000002mBpEAI"] = { id: "4wAg80000002mBpEAI", name: "Revenue Standard Tax Engine", status: "Active", type: "RevenueStandardTax", decisionTableId: TABLE };
  f.tables[TABLE].engines = ["Revenue Standard Tax Engine"];
  const ev = evaluateOrderItemTax(f, ctx(c));
  const issue = ev.issues.find(i => i.code === "TAX_ENGINE_DECISION_TABLE_MISSING")!;
  assert.equal(issue.severity, "error");
  assert.match(issue.message, /Expected decision table: RevenueStandardTaxWithTaxCode \(0lDg8000000HC3BEAW\)/);
  assert.match(issue.message, /already used by Revenue Standard Tax Engine/, "the shared engine is named — its association is never changed");
  assert.equal(ev.effective!.rate, null, "no rate is reported as selected when the lookup itself can't work");
});

test("Salesforce's decision-table evaluation: No Match vs Single Match (p10 responses)", () => {
  const base = { decisionTableId: TABLE, decisionTableName: "RevenueStandardTaxWithTaxCode", conditions: [], taxRate: null };
  const none = parsePreview({ status: 201, json: { errorCode: null, errorMessage: null, outcomeList: [], outcomeType: "No Match", successStatus: true } }, base);
  assert.equal(none.matched, false);
  assert.equal(none.outcomeType, "No Match");
  const single = parsePreview({ status: 201, json: { outcomeList: [{ values: { ApplicationBasis: "Net", Rate: 13, Priority: 1, FlatTaxAmount: null } }], outcomeType: "Single Match", successStatus: true } }, base);
  assert.equal(single.matched, true);
  assert.deepEqual([single.rate, single.applicationBasis], [13, "Net"]);
});

/* ───────────── invoice verification ───────────── */

const TREAT = { id: CASES.india.treatment, name: "India GST Desktop Test Treatment", taxable: true };
const line = (o: Partial<TaxInvoice["lines"][number]> = {}): TaxInvoice["lines"][number] => ({ id: "5TVg8000000EJKXGA4", name: "India GST Test Desktop", product: "India GST Test Desktop", productId: "01tg8000008HLLBAA4", quantity: 1, unitPrice: 10000, charge: 10000, taxAmount: 0, chargeAmountWithTax: 10000, taxRate: null, taxCode: null, taxStatus: "Estimated", treatment: { id: TREAT.id, name: TREAT.name }, legalEntityId: LE, adjustmentAmount: 0, adjustmentTaxAmount: 0, taxes: [], ...o });
const invoice = (o: Partial<TaxInvoice> = {}, lines = [line()]): TaxInvoice => ({ id: "3ttg8000000TlMvAAK", number: "DOC-000000035", status: "Draft", subtotal: 10000, tax: 0, totalWithTax: 10000, balance: 10000, date: "2026-11-02", lines, ...o });
const ilt = (amount: number) => ({ id: "2GI000000000001", name: null, amount, rate: 18, code: "GST18", status: null, effectiveDate: null, treatment: { id: TREAT.id, name: TREAT.name }, legalEntityId: LE, exemptAmount: 0 });
const verification = (inv: TaxInvoice): InvoiceTaxVerification => { const d = deriveSalesforceTax(inv, [TREAT], null); return { invoice: inv, derivation: d, state: invoiceTaxFlowState(d.status, d.reason) }; };

test("zero InvoiceLineTax on a taxable Estimated line (DOC-000000035) → verification failed; posting is blocked", () => {
  const v = verification(invoice());
  assert.equal(v.derivation.status, "CALCULATION_FAILED");
  assert.equal(v.derivation.reason, "INVOICE_TIME_TAX_NOT_APPLIED");
  assert.equal(v.state, "TAX_VERIFICATION_FAILED");
  assert.deepEqual(postingDecision(v.state), { allowed: false, code: "TAX_VERIFICATION_FAILED" });
});

test("InvoiceLineTax present and TotalTaxAmount equal to their sum → verified; posting allowed", () => {
  const v = verification(invoice({ tax: 1800, totalWithTax: 11800 }, [line({ taxAmount: 1800, taxes: [ilt(1800)] })]));
  assert.equal(v.state, "VERIFIED_TAX_APPLIED");
  assert.equal(v.derivation.actual[0].taxAmount, 1800);
  assert.deepEqual(postingDecision(v.state), { allowed: true, code: null });
});

test("TotalTaxAmount ≠ the InvoiceLineTax sum → not verified; posting blocked", () => {
  for (const tax of [0, 1700, null]) {
    const v = verification(invoice({ tax }, [line({ taxAmount: 1800, taxes: [ilt(1800)] })]));
    assert.equal(v.derivation.status, "CALCULATION_FAILED", String(tax));
    assert.ok(v.derivation.diagnostics.some(d => d.code === "INVOICE_TAX_TOTAL_MISMATCH"));
    assert.equal(postingDecision(v.state).allowed, false);
  }
});

/* ───────────── recalculation (explicit, approved) ───────────── */

const STALE: StaleTable = { engineId: CASES.india.engine, engine: CASES.india.engineName, table: "RevenueStandardTaxWithTaxCode", tableId: TABLE, refreshedAt: REFRESH_0953, ratesChangedAfter: ["TR-00000028"] };
function fakeRecalc(o: { stale?: StaleTable[]; after?: TaxInvoice[]; reject?: boolean; before?: TaxInvoice } = {}) {
  const calls: string[] = [];
  const reads = [o.before ?? invoice(), ...(o.after ?? [])];
  let i = 0;
  const api: RecalcApi = {
    verify: async () => verification(reads[Math.min(i++, reads.length - 1)]),
    calculate: async id => { calls.push(id); return o.reject ? { ok: false, status: 400, code: "INVALID_STATUS", error: "bad" } : { ok: true }; },
    staleTables: async () => o.stale ?? [],
    sleep: async () => {},
  };
  return { api, calls };
}

test("recalculation: Draft + Estimated without InvoiceLineTax is eligible; Posted, verified or stale-table invoices are not", () => {
  assert.equal(recalcEligibility(verification(invoice()), []).eligible, true);
  assert.match(recalcEligibility(verification(invoice({ status: "Posted" })), []).reason, /Draft invoices only/);
  assert.match(recalcEligibility(verification(invoice({ tax: 1800 }, [line({ taxAmount: 1800, taxes: [ilt(1800)] })])), []).reason, /already verified/);
  const stale = recalcEligibility(verification(invoice()), [STALE]);
  assert.equal(stale.eligible, false);
  assert.match(stale.reason, /Refresh first: decision table RevenueStandardTaxWithTaxCode \(0lDg8000000HC3BEAW.*TR-00000028/);
});

test("recalculation: preview never calls Salesforce; a stale table blocks it even with a token", async () => {
  const p = fakeRecalc();
  const preview = await recalculateInvoiceTax(p.api, { invoiceId: "3ttg8000000TlMvAAK" });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.mode === "preview" && preview.confirmation, recalcToken("3ttg8000000TlMvAAK"));
  assert.deepEqual(p.calls, []);
  const s = fakeRecalc({ stale: [STALE] });
  const blocked = await recalculateInvoiceTax(s.api, { invoiceId: "3ttg8000000TlMvAAK", confirm: recalcToken("3ttg8000000TlMvAAK") });
  assert.equal(blocked.mode, "preview");
  assert.deepEqual(s.calls, [], "nothing is sent while the table is stale");
  await assert.rejects(recalculateInvoiceTax(fakeRecalc().api, { invoiceId: "3ttg8000000TlMvAAK", confirm: "recalculate-invoice-tax:3ttg8000000XXXX" }), /doesn't match/);
});

test("recalculation: success only when Salesforce's InvoiceLineTax appears and matches TotalTaxAmount", async () => {
  const token = recalcToken("3ttg8000000TlMvAAK");
  // Salesforce touches the invoice when it runs the request (LastModifiedDate moves; DOC-000000035: 10:50:09 → 11:53:11).
  const RAN = "2026-11-02T11:53:11.000+0000";
  const ok = fakeRecalc({ after: [invoice({ modifiedAt: RAN }, [line({ taxStatus: "Pending" })]), invoice({ tax: 1800, modifiedAt: RAN }, [line({ taxAmount: 1800, taxes: [ilt(1800)] })])] });
  const r = await recalculateInvoiceTax(ok.api, { invoiceId: "3ttg8000000TlMvAAK", confirm: token }, { pollMs: 1, maxWaitMs: 10 });
  assert.equal(r.mode === "recalculate" && r.outcome, "VERIFIED_TAX_APPLIED");
  assert.deepEqual(ok.calls, ["3ttg8000000TlMvAAK"]);
  // Salesforce ran it but still no InvoiceLineTax → not claimed as success.
  const still = await recalculateInvoiceTax(fakeRecalc({ after: [invoice({ modifiedAt: RAN })] }).api, { invoiceId: "3ttg8000000TlMvAAK", confirm: token }, { pollMs: 1, maxWaitMs: 10 });
  assert.equal(still.mode === "recalculate" && still.outcome, "TAX_NOT_VERIFIED");
  const rejected = await recalculateInvoiceTax(fakeRecalc({ reject: true }).api, { invoiceId: "3ttg8000000TlMvAAK", confirm: token });
  assert.equal(rejected.mode === "recalculate" && rejected.outcome, "REJECTED");
});
