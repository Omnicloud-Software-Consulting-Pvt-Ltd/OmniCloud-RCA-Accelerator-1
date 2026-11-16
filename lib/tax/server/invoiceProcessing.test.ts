/**
 * Asynchronous invoice processing. Salesforce recalculates a Draft invoice's tax in the background: p10 DOC-000000035 went
 * Draft (10:50:09) → Draft In Progress → Draft (11:53:11), its line "Estimated" the whole time, InvoiceLineTax 2GIg8000001pfyDGAQ
 * (GST18 18% ₹1,800) created at the end. The recalculation used to read "Draft In Progress + Estimated + no InvoiceLineTax" as a
 * finished, untaxed invoice and report "not verified" too early.
 *
 * Run: `npx tsx --test lib/tax/server/invoiceProcessing.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSalesforceTax, isInvoiceProcessing, postingDecision, type InvoiceTaxVerification, type TaxInvoice } from "./invoiceTax";
import { invoiceTaxFlowState } from "./calculationResult";
import { recalcToken, recalculateInvoiceTax, type RecalcApi } from "./invoiceRecalc";
import { evaluateInvoiceLineTax, type LineExpectation } from "./pipeline";
import { invoiceTaxSettled } from "./verification";
import { recalcNotice, STILL_PROCESSING_TEXT } from "@/lib/tax/recalcDisplay";

const INV = "3ttg8000000TlMvAAK", LINE = "5TVg8000000EJKXGA4";
const TREAT = { id: "1ttg8000000TkkDAAS", name: "India GST Desktop Test Treatment", taxable: true };
const BEFORE = "2026-11-02T10:50:09.000+0000", DURING = "2026-11-02T11:52:58.000+0000", AFTER = "2026-11-02T11:53:11.000+0000";
const TRANSIENT = ["Draft In Progress", "Pending", "Posting In Progress", "Void In Progress", "Split In Progress", "Split Posting In Progress", "Split Void In Progress", "Processing"];
const TERMINAL = ["Draft", "Posted", "Canceled", "Error", "Voided", "Split", "Split Draft", "Split Posted", "Split Canceled", "Split Error", "Split Voided"];

const ilt = (amount = 1800) => ({ id: "2GIg8000001pfyDGAQ", name: null, amount, rate: 18, code: "GST18", status: "Estimated", effectiveDate: "2026-11-02", treatment: { id: TREAT.id, name: TREAT.name }, legalEntityId: "0fwg8000000FFefAAG", exemptAmount: 0 });
const line = (o: Partial<TaxInvoice["lines"][number]> = {}): TaxInvoice["lines"][number] => ({ id: LINE, name: "India GST Test Desktop", product: "India GST Test Desktop", productId: "01tg8000008HLLBAA4", quantity: 1, unitPrice: 10000, charge: 10000, taxAmount: 0, chargeAmountWithTax: 10000, taxRate: null, taxCode: null, taxStatus: "Estimated", treatment: { id: TREAT.id, name: TREAT.name }, legalEntityId: "0fwg8000000FFefAAG", adjustmentAmount: 0, adjustmentTaxAmount: 0, taxes: [], ...o });
const invoice = (o: Partial<TaxInvoice> = {}, lines = [line()]): TaxInvoice => ({ id: INV, number: "DOC-000000035", status: "Draft", subtotal: 10000, tax: 0, totalWithTax: 10000, balance: 10000, date: "2026-11-02", modifiedAt: BEFORE, lines, ...o });
// The three DOC-000000035 states.
const before = () => invoice();
const processing = (o: Partial<TaxInvoice> = {}) => invoice({ status: "Draft In Progress", modifiedAt: DURING, ...o });
const completed = () => invoice({ tax: 1800, totalWithTax: 11800, balance: 11800, modifiedAt: AFTER }, [line({ taxAmount: 1800, taxes: [ilt()] })]);
const verify = (inv: TaxInvoice, log: { number: string | null; code: string | null; message: string | null } | null = null): InvoiceTaxVerification => { const d = deriveSalesforceTax(inv, [TREAT], log); return { invoice: inv, derivation: d, state: invoiceTaxFlowState(d.status, d.reason) }; };

/* ───────────── C1: the invoice's processing status ───────────── */

test("1. Draft In Progress + Estimated line + no InvoiceLineTax → CALCULATION_PENDING (not 'tax not applied')", () => {
  const d = deriveSalesforceTax(processing(), [TREAT], null);
  assert.equal(d.status, "CALCULATION_PENDING");
  assert.equal(d.reason, null);
  assert.match(d.message, /still processing invoice DOC-000000035 \(status Draft In Progress\)/);
  assert.equal(invoiceTaxFlowState(d.status, d.reason), "TAX_PENDING");
});

test("2. each of the eight transient invoice statuses is processing → pending", () => {
  for (const status of TRANSIENT) {
    assert.equal(isInvoiceProcessing(status), true, status);
    assert.equal(isInvoiceProcessing(status.toUpperCase()), true, `${status} (case)`);
    assert.equal(deriveSalesforceTax(invoice({ status }), [TREAT], null).status, "CALCULATION_PENDING", status);
  }
});

test("3. terminal statuses are never processing; Draft / Posted / Error keep their verdicts", () => {
  for (const status of [...TERMINAL, "", null, undefined, "Draft  "]) assert.equal(isInvoiceProcessing(status as string | null), false, String(status));
  assert.equal(deriveSalesforceTax(invoice({ status: "Draft" }), [TREAT], null).reason, "INVOICE_TIME_TAX_NOT_APPLIED", "finished Draft, no InvoiceLineTax = a real failure");
  assert.equal(deriveSalesforceTax(invoice({ status: "Posted", tax: 1800 }, [line({ taxStatus: "Posted", taxAmount: 1800, taxes: [ilt()] })]), [TREAT], null).status, "CALCULATED");
  const err = deriveSalesforceTax(invoice({ status: "Error" }), [TREAT], { number: "EL-1", code: "TAX_INTERNAL_ERROR", message: "Decision Table lookup failed" });
  assert.deepEqual([err.status, err.reason], ["CALCULATION_FAILED", "TAX_PROCESSING_ERROR"]);
});

test("4. a processing invoice that already has InvoiceLineTax and totals stays pending — not CALCULATED, not postable", () => {
  const withTax = verify(invoice({ status: "Draft In Progress", tax: 1800, totalWithTax: 11800, modifiedAt: DURING }, [line({ taxAmount: 1800, taxes: [ilt()] })]));
  assert.equal(withTax.state, "TAX_PENDING");
  assert.deepEqual(withTax.derivation.actual, [], "no amount is reported while Salesforce is processing");
  assert.equal(postingDecision(withTax.state).allowed, false);
});

/* ───────────── C2: the recalculation's polling ───────────── */

function fakeRecalc(reads: TaxInvoice[], o: { reject?: boolean; log?: { number: string | null; code: string | null; message: string | null } } = {}) {
  const calls: string[] = [];
  let sleeps = 0, i = 0;
  const seq = [before(), ...reads];
  const api: RecalcApi = {
    verify: async () => { const inv = seq[Math.min(i++, seq.length - 1)]; return verify(inv, inv.status === "Error" ? o.log ?? null : null); },
    calculate: async id => { calls.push(id); return o.reject ? { ok: false, status: 400, code: "INVALID_STATUS", error: "bad" } : { ok: true }; },
    staleTables: async () => [],
    sleep: async () => { sleeps++; },
  };
  return { api, calls, sleeps: () => sleeps };
}
const run = (f: ReturnType<typeof fakeRecalc>, maxWaitMs = 30) => recalculateInvoiceTax(f.api, { invoiceId: INV, confirm: recalcToken(INV) }, { pollMs: 1, maxWaitMs });
const outcome = (r: Awaited<ReturnType<typeof run>>) => (r.mode === "recalculate" ? r.outcome : `preview:${r.mode}`);

test("5 & 6. DOC-000000035 sequence before → processing → completed: VERIFIED_TAX_APPLIED, calculate requested exactly once", async () => {
  const f = fakeRecalc([processing(), processing(), completed()]);
  const r = await run(f);
  assert.equal(outcome(r), "VERIFIED_TAX_APPLIED");
  assert.deepEqual(f.calls, [INV], "calculate-estimated-tax is called once and never repeated");
  assert.equal(r.verification.invoice?.status, "Draft");
  assert.equal(r.verification.invoice?.tax, 1800);
  assert.equal(r.verification.derivation.actual[0].taxAmount, 1800);
  assert.ok(f.sleeps() >= 2, "it waited through the processing reads");
});

test("7. first read after the request still equals the baseline (Salesforce hasn't started) → keeps polling, no premature verdict", async () => {
  const f = fakeRecalc([before(), before(), processing(), completed()]);
  assert.equal(outcome(await run(f)), "VERIFIED_TAX_APPLIED");
  assert.deepEqual(f.calls, [INV]);
});

test("8. LastModifiedDate changed but the invoice is still processing → keeps polling (a timestamp change isn't completion)", async () => {
  const f = fakeRecalc([processing({ modifiedAt: DURING }), processing({ modifiedAt: "2026-11-02T11:53:05.000+0000" }), completed()]);
  assert.equal(outcome(await run(f)), "VERIFIED_TAX_APPLIED");
});

test("9. nothing changes before the timeout → STILL_PENDING; also when still processing at the timeout; calculate once", async () => {
  const unchanged = fakeRecalc([before()]);
  const r = await run(unchanged, 5);
  assert.equal(outcome(r), "STILL_PENDING");
  assert.match(r.mode === "recalculate" ? r.message : "", /still processing DOC-000000035 \(status Draft\); check again shortly/);
  assert.deepEqual(unchanged.calls, [INV]);
  const stuck = fakeRecalc([processing()]);
  const s = await run(stuck, 5);
  assert.equal(outcome(s), "STILL_PENDING");
  assert.match(s.mode === "recalculate" ? s.message : "", /Draft In Progress/);
  assert.deepEqual(stuck.calls, [INV]);
});

test("10. completed back to Draft but the taxable line has no InvoiceLineTax → TAX_NOT_VERIFIED (a real failure is still reported)", async () => {
  const f = fakeRecalc([processing(), invoice({ modifiedAt: AFTER })]);
  const r = await run(f);
  assert.equal(outcome(r), "TAX_NOT_VERIFIED");
  assert.match(r.mode === "recalculate" ? r.message : "", /no InvoiceLineTax/i);
});

test("11. processing ends in Error → TAX_NOT_VERIFIED with the status and Salesforce's error detail; no retry", async () => {
  const f = fakeRecalc([processing(), invoice({ status: "Error", modifiedAt: AFTER })], { log: { number: "EL-9", code: "TAX_INTERNAL_ERROR", message: "Decision Table lookup failed" } });
  const r = await run(f);
  assert.equal(outcome(r), "TAX_NOT_VERIFIED");
  const msg = r.mode === "recalculate" ? r.message : "";
  assert.match(msg, /status Error \(expected Draft\)/);
  assert.match(msg, /TAX_INTERNAL_ERROR: Decision Table lookup failed/);
  assert.deepEqual(f.calls, [INV]);
});

test("12. completed with TotalTaxAmount ≠ the InvoiceLineTax sum → not verified", async () => {
  const f = fakeRecalc([processing(), invoice({ tax: 1700, modifiedAt: AFTER }, [line({ taxAmount: 1800, taxes: [ilt()] })])]);
  const r = await run(f);
  assert.equal(outcome(r), "TAX_NOT_VERIFIED");
  assert.ok(r.verification.derivation.diagnostics.some(d => d.code === "INVOICE_TAX_TOTAL_MISMATCH"));
});

/* ───────────── C3 / C4: the other readers ───────────── */

test("13. invoice-line evaluation: processing invoice + no InvoiceLineTax → PENDING (not MISSING); settled Draft → MISSING", () => {
  const exp = new Map<string, LineExpectation>([[LINE, { rateId: "0xqg800000005R7AAI", rate: 18, taxCode: "GST18" }]]);
  const p = evaluateInvoiceLineTax(processing(), exp, null);
  assert.equal(p.lines[0].status, "PENDING");
  assert.equal(p.status, "PENDING");
  const settled = evaluateInvoiceLineTax(invoice({ modifiedAt: AFTER }), exp, null);
  assert.equal(settled.lines[0].status, "MISSING");
  assert.equal(settled.status, "FAILED");
  assert.equal(evaluateInvoiceLineTax(completed(), exp, null).status, "SUCCESS", "expected-rate comparison unchanged");
});

test("14. verification run: a processing invoice is not settled (no premature FAILED / taxStop); terminal states unchanged", () => {
  assert.equal(invoiceTaxSettled(processing()), false);
  for (const status of TRANSIENT) assert.equal(invoiceTaxSettled(invoice({ status })), false, status);
  assert.equal(invoiceTaxSettled(completed()), true);
  assert.equal(invoiceTaxSettled(before()), true, "a settled Draft with an Estimated line is settled, as before");
  assert.equal(invoiceTaxSettled(invoice({}, [line({ taxStatus: "Pending" })])), false);
  assert.equal(invoiceTaxSettled(invoice({ status: "Error" })), false);
  assert.equal(invoiceTaxSettled(null), false);
});

/* ───────────── C5: how it is shown ───────────── */

test("15. UI: STILL_PENDING renders as a warning with the 'still processing' text; failures stay red, success green", () => {
  const pending = recalcNotice({ mode: "recalculate", outcome: "STILL_PENDING", message: "x", verification: verify(processing()) });
  assert.equal(pending.tone, "warn");
  assert.ok(pending.text.startsWith(STILL_PROCESSING_TEXT));
  assert.match(pending.text, /Current status: Draft In Progress/);
  assert.equal(recalcNotice({ mode: "recalculate", outcome: "TAX_NOT_VERIFIED", message: "no InvoiceLineTax", verification: verify(invoice()) }).tone, "error");
  assert.equal(recalcNotice({ mode: "recalculate", outcome: "REJECTED", message: "HTTP 400", verification: verify(invoice()) }).tone, "error");
  assert.equal(recalcNotice({ mode: "recalculate", outcome: "VERIFIED_TAX_APPLIED", message: "ok", verification: verify(completed()) }).tone, "ok");
});
