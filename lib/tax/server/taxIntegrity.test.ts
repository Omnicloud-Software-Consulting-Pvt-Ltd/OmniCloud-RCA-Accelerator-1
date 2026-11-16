/**
 * P0 financial-integrity safeguards: Salesforce's own invoice tax records must agree with each other before an invoice is verified
 * or posted. Values are p10 DOC-000000035 after its recalculation (₹10,000, InvoiceLineTax 2GIg8000001pfyDGAQ GST18 18% ₹1,800,
 * legal entity 0fwg8000000FFefAAG, treatment 1ttg8000000TkkDAAS, AdjustmentAmount 0, AdjustmentTaxAmount 0, TaxExemptAmount 0).
 *
 * These checks compare Salesforce's records with each other only. Whether the rate or tax code is the RIGHT one for the sale
 * (configuration / expected-rate validation) is not checked here — see the "correctly labelled 13%" case.
 *
 * Run: `npx tsx --test lib/tax/server/taxIntegrity.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkTaxRecordIntegrity, deriveSalesforceTax, invoicePostingGate, postingDecision, TAX_OVERRIDE_UNAVAILABLE, type InvoiceTaxVerification, type TaxInvoice } from "./invoiceTax";
import { invoiceTaxFlowState } from "./calculationResult";

const LE = "0fwg8000000FFefAAG", OTHER_LE = "0fwg8000000ZZZZAAA";
const TREAT = { id: "1ttg8000000TkkDAAS", name: "India GST Desktop Test Treatment", taxable: true };
type Line = TaxInvoice["lines"][number];
type Ilt = Line["taxes"][number];
const ilt = (o: Partial<Ilt> = {}): Ilt => ({ id: "2GIg8000001pfyDGAQ", name: null, amount: 1800, rate: 18, code: "GST18", status: "Estimated", effectiveDate: "2026-11-02", treatment: { id: TREAT.id, name: TREAT.name }, legalEntityId: LE, exemptAmount: 0, ...o });
const line = (o: Partial<Line> = {}): Line => ({ id: "5TVg8000000EJKXGA4", name: "India GST Test Desktop", product: "India GST Test Desktop", productId: "01tg8000008HLLBAA4", quantity: 1, unitPrice: 10000, charge: 10000, taxAmount: 1800, chargeAmountWithTax: 10000, taxRate: null, taxCode: null, taxStatus: "Estimated", treatment: { id: TREAT.id, name: TREAT.name }, legalEntityId: LE, adjustmentAmount: 0, adjustmentTaxAmount: 0, taxes: [ilt()], ...o });
const invoice = (lines: Line[] = [line()], o: Partial<TaxInvoice> = {}): TaxInvoice => ({ id: "3ttg8000000TlMvAAK", number: "DOC-000000035", status: "Draft", subtotal: lines.reduce((n, l) => n + (l.charge ?? 0), 0), tax: Math.round(lines.reduce((n, l) => n + (l.taxAmount ?? 0), 0) * 100) / 100, totalWithTax: null, balance: null, date: "2026-11-02", modifiedAt: "2026-11-02T11:53:11.000+0000", lines, ...o });
const verify = (inv: TaxInvoice): InvoiceTaxVerification => { const d = deriveSalesforceTax(inv, [TREAT], null); return { invoice: inv, derivation: d, state: invoiceTaxFlowState(d.status, d.reason) }; };

/** The four things every scenario checks: verdict, order-invoice posting, debit-memo posting (same gate), override. */
function evaluate(inv: TaxInvoice) {
  const v = verify(inv);
  const order = invoicePostingGate(v);
  const debitMemo = invoicePostingGate(v); // the debit-memo lifecycle calls the same gate (asserted on its source below)
  const override = invoicePostingGate(v, { allowUnverifiedTax: true });
  return { state: v.state, checks: checkTaxRecordIntegrity(inv).map(f => `${f.kind}:${f.check}`), order: order.allowed, debitMemo: debitMemo.allowed, override, message: v.derivation.message };
}
const blocked = (r: ReturnType<typeof evaluate>, state: string) => {
  assert.equal(r.state, state);
  assert.equal(r.order, false, "order invoice posting blocked");
  assert.equal(r.debitMemo, false, "debit-memo invoice posting blocked");
  assert.equal(r.override.allowed, false, "an override can't bypass it");
  assert.equal(!r.override.allowed && r.override.code, TAX_OVERRIDE_UNAVAILABLE);
};

test("1. correct GST18 invoice: ₹1,800 at 18% on ₹10,000 (DOC-000000035) → VERIFIED_TAX_APPLIED, postable on both paths", () => {
  const r = evaluate(invoice());
  assert.equal(r.state, "VERIFIED_TAX_APPLIED");
  assert.deepEqual(r.checks, []);
  assert.equal(r.order, true);
  assert.equal(r.debitMemo, true);
  assert.equal(r.override.allowed, true, "an override flag on a verified invoice changes nothing");
});

test("2. InvoiceLineTax amount contradicts its own rate (18% recorded, ₹1,300 charged) → MISMATCH", () => {
  const r = evaluate(invoice([line({ taxAmount: 1300, taxes: [ilt({ amount: 1300 })] })]));
  blocked(r, "TAX_INTEGRITY_MISMATCH");
  assert.ok(r.checks.includes("mismatch:AMOUNT_VS_BASE"));
  assert.match(r.message, /1300, but 18% of the line's 10000 is 1800/);
});

test("2b. LIMITATION (P1, not P0): a self-consistent wrong rate (13% recorded, ₹1,300) still verifies — no expected-rate check", () => {
  const r = evaluate(invoice([line({ taxAmount: 1300, taxes: [ilt({ amount: 1300, rate: 13 })] })]));
  assert.equal(r.state, "VERIFIED_TAX_APPLIED", "documented gap: configuration-based rate validation is P1");
});

test("3. zero-amount / zero-rate InvoiceLineTax on a taxable line → MISMATCH", () => {
  blocked(evaluate(invoice([line({ taxAmount: 0, taxes: [ilt({ amount: 0, rate: 0 })] })])), "TAX_INTEGRITY_MISMATCH");
  const zeroRate = evaluate(invoice([line({ taxAmount: 0, taxes: [ilt({ amount: 0 })] })]));
  assert.ok(zeroRate.checks.includes("mismatch:ZERO_TAX"));
});

test("4. wrong taxable base (18% recorded but ₹180 — the base of ₹1,000, not the line's ₹10,000) → MISMATCH", () => {
  const r = evaluate(invoice([line({ taxAmount: 180, taxes: [ilt({ amount: 180 })] })]));
  blocked(r, "TAX_INTEGRITY_MISMATCH");
  assert.ok(r.checks.includes("mismatch:AMOUNT_VS_BASE"));
});

test("5. TaxCode: only a contradiction between Salesforce's own records is detected (no configuration check)", () => {
  const r = evaluate(invoice([line({ taxCode: "GST5", taxes: [ilt()] })]));
  blocked(r, "TAX_INTEGRITY_MISMATCH");
  assert.ok(r.checks.includes("mismatch:TAX_CODE"));
  // Line TaxCode blank (every p10 line) → nothing to compare → no finding; and a "wrong" code alone isn't judged.
  assert.equal(evaluate(invoice([line({ taxes: [ilt({ code: "GST5" })] })])).state, "VERIFIED_TAX_APPLIED");
});

test("6. incorrect distribution across lines (right invoice total ₹3,600, wrong split ₹2,700 / ₹900) → MISMATCH", () => {
  const r = evaluate(invoice([
    line({ id: "5TV000000000001", taxAmount: 2700, taxes: [ilt({ id: "2GI000000000001", amount: 2700 })] }),
    line({ id: "5TV000000000002", taxAmount: 900, taxes: [ilt({ id: "2GI000000000002", amount: 900 })] }),
  ]));
  blocked(r, "TAX_INTEGRITY_MISMATCH");
  assert.equal(r.checks.filter(c => c === "mismatch:AMOUNT_VS_BASE").length, 2);
});

test("7. InvoiceLine.TaxAmount ≠ its InvoiceLineTax (line ₹900, record ₹1,800) → MISMATCH", () => {
  const r = evaluate(invoice([line({ taxAmount: 900 })], { tax: 1800 }));
  blocked(r, "TAX_INTEGRITY_MISMATCH");
  assert.ok(r.checks.includes("mismatch:LINE_TAX_AMOUNT"));
});

test("8. duplicate InvoiceLineTax (two GST18 records on one line) → MISMATCH", () => {
  const r = evaluate(invoice([line({ taxAmount: 3600, taxes: [ilt({ id: "2GI000000000001" }), ilt({ id: "2GI000000000002" })] })]));
  blocked(r, "TAX_INTEGRITY_MISMATCH");
  assert.ok(r.checks.includes("mismatch:DUPLICATE_TAX"));
});

test("9. missing InvoiceLineTax on a taxable line → not verified (unchanged), blocked on both paths", () => {
  const r = evaluate(invoice([line({ taxAmount: 0, taxes: [] })]));
  blocked(r, "TAX_VERIFICATION_FAILED");
});

test("10. InvoiceLineTax LegalEntityId ≠ the line's → MISMATCH; a blank one → UNVERIFIABLE", () => {
  const r = evaluate(invoice([line({ taxes: [ilt({ legalEntityId: OTHER_LE })] })]));
  blocked(r, "TAX_INTEGRITY_MISMATCH");
  assert.ok(r.checks.includes("mismatch:LEGAL_ENTITY"));
  blocked(evaluate(invoice([line({ taxes: [ilt({ legalEntityId: null })] })])), "TAX_UNVERIFIABLE");
});

test("11. InvoiceLineTax TaxTreatmentId ≠ the line's → MISMATCH; a blank one → UNVERIFIABLE", () => {
  const r = evaluate(invoice([line({ taxes: [ilt({ treatment: { id: "1ttg8000000OjtdAAC", name: "GST18 Taxable" } })] })]));
  blocked(r, "TAX_INTEGRITY_MISMATCH");
  assert.ok(r.checks.includes("mismatch:TREATMENT"));
  blocked(evaluate(invoice([line({ taxes: [ilt({ treatment: null })] })])), "TAX_UNVERIFIABLE");
});

test("12. legitimate multi-tax records (two different codes, 9% + 9%, each consistent with the base) → VERIFIED", () => {
  const r = evaluate(invoice([line({ taxes: [ilt({ id: "2GI000000000001", code: "CGST9", rate: 9, amount: 900 }), ilt({ id: "2GI000000000002", code: "SGST9", rate: 9, amount: 900 })] })]));
  assert.equal(r.state, "VERIFIED_TAX_APPLIED");
  assert.deepEqual(r.checks, []);
  assert.equal(r.order, true);
  assert.equal(r.debitMemo, true);
});

test("13. invoice still processing → TAX_PENDING (async behaviour preserved), blocked, no override", () => {
  const r = evaluate(invoice([line()], { status: "Draft In Progress" }));
  blocked(r, "TAX_PENDING");
});

test("14. debit-memo invoice with incorrect tax is refused by the same gate, before the Salesforce post call", () => {
  const r = evaluate(invoice([line({ taxAmount: 1300, taxes: [ilt({ amount: 1300 })] })]));
  assert.equal(r.debitMemo, false);
  const src = readFileSync("lib/billing/server/debitMemoLifecycle.ts", "utf8");
  const block = src.slice(src.indexOf('next.action === "post-invoice"'), src.indexOf('next.action === "create-payment"'));
  const gateAt = block.indexOf("invoicePostingGate(tax)"), verifyAt = block.indexOf("verifyInvoiceTax(client, s.invoice.id)"), postAt = block.indexOf("/commerce/invoicing/invoices/collection/actions/post");
  assert.ok(verifyAt > 0 && gateAt > verifyAt && postAt > gateAt, "debit-memo posting verifies and gates before it posts");
  assert.match(block, /if \(!gate\.allowed\) return fail\(/);
});

test("15. allowUnverifiedTax can't bypass an integrity mismatch (or anything else); the order posting path uses the shared gate", () => {
  for (const inv of [invoice([line({ taxAmount: 900 })], { tax: 1800 }), invoice([line({ taxAmount: 0, taxes: [] })]), invoice([line({ adjustmentAmount: -1000 })])]) {
    const g = invoicePostingGate(verify(inv), { allowUnverifiedTax: true });
    assert.equal(g.allowed, false);
    assert.equal(!g.allowed && g.code, TAX_OVERRIDE_UNAVAILABLE);
  }
  for (const s of ["TAX_INTEGRITY_MISMATCH", "TAX_UNVERIFIABLE", "TAX_PENDING", "TAX_VERIFICATION_FAILED"] as const) assert.equal(postingDecision(s, true).allowed, false, s);
  const src = readFileSync("lib/billing/server/orderBilling.ts", "utf8");
  assert.match(src, /const gate = invoicePostingGate\(tax, \{ allowUnverifiedTax: opts\.allowUnverifiedTax === true \}\);\s*if \(!gate\.allowed\)/);
  assert.doesNotMatch(src, /postingDecision\(/, "order posting no longer has its own (overridable) decision");
});

test("16. an override can't be accepted without an audit record — none exists, so it is refused with the findings and a clear reason", () => {
  const g = invoicePostingGate(verify(invoice([line({ adjustmentAmount: -1000 })])), { allowUnverifiedTax: true });
  assert.equal(g.allowed, false);
  if (g.allowed) return;
  assert.equal(g.code, TAX_OVERRIDE_UNAVAILABLE);
  assert.match(g.error, /overrides must be audited and no audit store is configured\. Nothing was posted\./);
  assert.ok(g.findings.some(f => f.code === "INVOICE_TAX_UNVERIFIABLE"), "the verifier's findings are returned with the refusal");
});

test("17. adjustments / discounts / exemptions or unread base fields → UNVERIFIABLE (never verified, never assumed)", () => {
  blocked(evaluate(invoice([line({ adjustmentAmount: -1000, taxAmount: 1620, taxes: [ilt({ amount: 1620 })] })])), "TAX_UNVERIFIABLE");
  blocked(evaluate(invoice([line({ adjustmentTaxAmount: -180 })])), "TAX_UNVERIFIABLE");
  blocked(evaluate(invoice([line({ taxes: [ilt({ exemptAmount: 500 })] })])), "TAX_UNVERIFIABLE");
  blocked(evaluate(invoice([line({ adjustmentAmount: undefined })])), "TAX_UNVERIFIABLE");
  blocked(evaluate(invoice([line({ adjustmentAmount: null })])), "TAX_UNVERIFIABLE");
  assert.ok(evaluate(invoice([line({ adjustmentAmount: -1000 })])).checks.includes("unverifiable:BASE_UNKNOWN"));
});

test("invoice level: TotalTaxAmount ≠ the sum of lines (lines consistent) → MISMATCH; blank → UNVERIFIABLE", () => {
  assert.ok(checkTaxRecordIntegrity(invoice([line()], { tax: 1700 })).some(f => f.check === "INVOICE_VS_LINES"));
  assert.ok(checkTaxRecordIntegrity(invoice([line()], { tax: null })).some(f => f.kind === "unverifiable" && f.check === "INVOICE_TAX_UNKNOWN"));
});
