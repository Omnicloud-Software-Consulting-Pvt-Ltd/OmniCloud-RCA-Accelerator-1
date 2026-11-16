/**
 * Tax-aware invoice posting: a missing InvoiceLineTax is a failure only when tax actually applies.
 *
 * Reproduces the debit-memo lifecycle block (DOC-000000004, INR 500 Process Now): the invoice line carried a taxable treatment,
 * Salesforce finished (Estimated) with TaxAmount 0 and no InvoiceLineTax, and posting was refused as INVOICE_TIME_TAX_NOT_APPLIED
 * without checking whether any tax rate applies to the line.
 *
 * Run: `npx tsx --test lib/tax/server/taxApplicability.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyTaxApplicability, deriveSalesforceTax, invoicePostingGate, invoiceTaxOutcome, type InvoiceTaxVerification, type TaxInvoice } from "./invoiceTax";
import { invoiceTaxFlowState, type DecisionTablePreview, PREVIEW_LABEL } from "./calculationResult";
import { assessInvoiceApplicability, type ApplicabilityApi, type StaleTable } from "./taxApplicability";
import type { InvoiceTaxTrace } from "./invoiceTaxTrace";
import { taxPostingFailure, withTaxCheck, type LifecycleState } from "@/lib/billing/server/debitMemoLifecycle";

const INV = "3ttg8000000DM04AAA", LINE = "5TVg8000000DM04AAA", LINE2 = "5TVg8000000DM05AAA";
const TREAT = { id: "1ttg8000000LEtrAAS", name: "India LE Treatment", taxable: true };
const ENG = "1teg8000000ENGAAA", DT = "0lDg8000000STDAAA", LE = "0fwg8000000FFefAAG";

type Line = TaxInvoice["lines"][number];
const ilt = (amount: number, rate = 18) => ({ id: `2GIg80000${amount}AAA`, name: "GST", amount, rate, code: "GST18", status: "Estimated", effectiveDate: "2026-11-16", treatment: { id: TREAT.id, name: TREAT.name }, legalEntityId: LE, exemptAmount: 0 });
const line = (o: Partial<Line> = {}): Line => ({ id: LINE, name: "Debit charge", product: null, productId: null, quantity: 1, unitPrice: 500, charge: 500, taxAmount: 0, chargeAmountWithTax: 500, taxRate: null, taxCode: null, taxStatus: "Estimated", treatment: { id: TREAT.id, name: TREAT.name }, legalEntityId: LE, adjustmentAmount: 0, adjustmentTaxAmount: 0, taxes: [], ...o });
const invoice = (lines = [line()], o: Partial<TaxInvoice> = {}): TaxInvoice => ({ id: INV, number: "DOC-000000004", status: "Draft", subtotal: 500, tax: 0, totalWithTax: 500, balance: 500, date: "2026-11-16", lines, ...o });

/** A relationship trace as traceInvoiceLineTax returns it (only the fields the assessment reads). */
function trace(o: { lineId?: string; taxable?: boolean; engineStatus?: string | null; dtStatus?: string; refresh?: string; inputs?: Record<string, string | null>; rows?: { name: string; rate: number | null }[]; unreadable?: string[] } = {}): InvoiceTaxTrace {
  return {
    success: true, readOnly: true, classification: "MISSING_RELATIONSHIP", summary: "",
    records: {
      invoiceLine: { Id: o.lineId ?? LINE },
      taxTreatment: { Id: TREAT.id, Name: TREAT.name, Status: "Active", IsTaxable: o.taxable ?? true },
      taxEngine: o.engineStatus === null ? null : { Id: ENG, TaxEngineName: "Revenue Standard Tax", Status: o.engineStatus ?? "Active" },
      // The invoice address the address inputs come from — absent when the line has none.
      address: (o.inputs ?? { Country: "IN" }).Country ? { Id: "IAG", Country: (o.inputs ?? { Country: "IN" }).Country } : null,
    },
    links: [], chain: [], checks: [],
    decisionTable: { id: DT, name: "StandardTax", status: o.dtStatus ?? "Active", type: null, usage: null, sourceObject: "TaxRate", refreshStatus: o.refresh ?? "Completed", lastSync: null,
      inputs: [{ field: "Country", operator: "Equals", required: true }, { field: "RateUsageType", operator: "Equals", required: true }, { field: "TaxCode", operator: "Equals", required: false }], outputs: ["Rate"] },
    evaluation: { method: "SOURCE_ROW_COMPARISON", inputs: o.inputs ?? { Country: "IN", RateUsageType: "RevCloud", TaxCode: "GST18" }, rows: [], matched: (o.rows ?? []).map((r, i) => ({ id: `0TRg${i}`, name: r.name, outputs: { Rate: r.rate } })) },
    invoiceTime: { invoiceTaxAmount: 0, lineTaxAmount: 0, lineTaxStatus: "Estimated", invoiceLineTaxCount: 0, errorLogCount: 0 },
    reference: null, proven: [], unproven: [], nextStep: "", unreadable: (o.unreadable ?? []).map(error => ({ soql: "SELECT …", error })),
  };
}
/** Salesforce's decision-table evaluation result. */
function preview(o: { rates?: number[]; noMatch?: boolean; error?: string } = {}): DecisionTablePreview {
  const outcomes = (o.rates ?? []).map(Rate => ({ Rate, ApplicationBasis: "Net" }));
  return { label: PREVIEW_LABEL, decisionTableId: DT, decisionTableName: "StandardTax", endpoint: "", conditions: [], httpStatus: o.error ? 500 : 200,
    outcomeType: o.error ? null : outcomes.length ? "Single Match" : "No Match", matched: outcomes.length > 0, outcomes, rate: outcomes[0]?.Rate ?? null, applicationBasis: null, priority: null, taxRate: null, consistent: null,
    error: o.error ? { status: 500, code: "UNKNOWN_EXCEPTION", message: o.error } : null };
}
const STALE: StaleTable = { engineId: ENG, engine: "Revenue Standard Tax", table: "StandardTax", tableId: DT, refreshedAt: "2026-11-01T00:00:00Z", ratesChangedAfter: ["TR-00000031"] };
function api(o: { trace?: InvoiceTaxTrace | ((lineId: string) => InvoiceTaxTrace); preview?: DecisionTablePreview; stale?: StaleTable[]; traceThrows?: string; staleThrows?: string; rates?: Record<string, unknown>[]; ratesTruncated?: boolean; ratesThrow?: string } = {}): ApplicabilityApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    trace: async (_inv, lineId) => { calls.push(`trace:${lineId}`); if (o.traceThrows) throw new Error(o.traceThrows); return typeof o.trace === "function" ? o.trace(lineId) : o.trace ?? trace({ lineId }); },
    preview: async () => { calls.push("preview"); return o.preview ?? preview({ noMatch: true }); },
    staleTables: async () => { calls.push("stale"); if (o.staleThrows) throw new Error(o.staleThrows); return o.stale ?? []; },
    rates: async () => { calls.push("rates"); if (o.ratesThrow) throw new Error(o.ratesThrow); return { rows: o.rates ?? [], truncated: o.ratesTruncated === true }; },
  };
}

/** The verifier's pipeline over Salesforce records (deriveSalesforceTax → applicability), as verifyInvoiceTax runs it. */
async function verify(inv: TaxInvoice, a: ApplicabilityApi, o: { errorLogReadable?: boolean } = {}): Promise<InvoiceTaxVerification> {
  let d = deriveSalesforceTax(inv, [TREAT], o.errorLogReadable === false ? { number: null, code: null, message: null, unavailable: "no access" } : null);
  if (d.reason === "INVOICE_TIME_TAX_NOT_APPLIED") d = applyTaxApplicability(inv, d, await assessInvoiceApplicability(a, inv.id, inv.lines.filter(l => !l.taxes.length)), { errorLogReadable: o.errorLogReadable !== false });
  return { invoice: inv, derivation: d, state: invoiceTaxFlowState(d.status, d.reason) };
}
const allowed = (v: InvoiceTaxVerification) => invoicePostingGate(v).allowed;

/* ───────────── The four required scenarios ───────────── */

test("SCENARIO 1 — INR 500 debit memo, no applicable tax (Salesforce: No Match, table up to date) → verified zero tax, Invoice postable", async () => {
  const before = deriveSalesforceTax(invoice(), [TREAT], null);
  assert.equal(before.reason, "INVOICE_TIME_TAX_NOT_APPLIED", "the original verdict that blocked DOC-000000004");
  const v = await verify(invoice(), api());
  assert.deepEqual([v.derivation.status, v.state], ["NO_TAX_EXPECTED", "VERIFIED_ZERO_TAX"]);
  assert.equal(v.derivation.applicability?.verdict, "NOT_APPLICABLE");
  assert.equal(invoiceTaxOutcome(v), "TAX_NOT_APPLICABLE");
  assert.equal(allowed(v), true);
  assert.deepEqual(v.derivation.actual, [], "no InvoiceLineTax or amount is fabricated");
  assert.match(v.derivation.message, /Tax not applicable on DOC-000000004/);
  assert.match(v.derivation.message, /No Match/);
  assert.ok(!v.derivation.diagnostics.some(d => d.code === "INVOICE_LINE_TAX_MISSING"), "the missing-InvoiceLineTax error no longer applies");
});

test("SCENARIO 2 — INR 500 debit memo with 18% tax: InvoiceLineTax 90 validated → postable; the applicability check isn't even consulted", async () => {
  const a = api();
  const inv = invoice([line({ taxAmount: 90, taxes: [ilt(90)] })], { tax: 90, totalWithTax: 590, balance: 590 });
  const v = await verify(inv, a);
  assert.deepEqual([v.derivation.status, v.state], ["CALCULATED", "VERIFIED_TAX_APPLIED"]);
  assert.equal(invoiceTaxOutcome(v), "TAX_APPLIED");
  assert.equal(allowed(v), true);
  assert.deepEqual(v.derivation.actual.map(x => x.taxAmount), [90]);
  assert.deepEqual(a.calls, [], "applicability is only evaluated for lines without InvoiceLineTax");
});

test("SCENARIO 2b — existing validation preserved: 18% InvoiceLineTax with the wrong amount (100 ≠ 500 × 18%) is still blocked", async () => {
  const v = await verify(invoice([line({ taxAmount: 100, taxes: [ilt(100)] })], { tax: 100 }), api());
  assert.equal(v.state, "TAX_INTEGRITY_MISMATCH");
  assert.equal(allowed(v), false);
});

test("SCENARIO 3 — taxable debit memo (Salesforce's table matches 18%) but no InvoiceLineTax → genuine calculation failure, posting blocked", async () => {
  const v = await verify(invoice(), api({ preview: preview({ rates: [18] }), trace: trace({ rows: [{ name: "TR-GST18", rate: 18 }] }) }));
  assert.deepEqual([v.derivation.status, v.derivation.reason, v.state], ["CALCULATION_FAILED", "INVOICE_TIME_TAX_NOT_APPLIED", "TAX_VERIFICATION_FAILED"]);
  assert.equal(v.derivation.applicability?.verdict, "APPLICABLE_NOT_CALCULATED");
  assert.equal(invoiceTaxOutcome(v), "TAX_CALCULATION_FAILED");
  assert.equal(allowed(v), false);
  assert.match(v.derivation.message, /Tax calculation failed on DOC-000000004 — tax applies/);
  assert.match(v.derivation.message, /18% rate/);
  assert.match(v.derivation.message, /reference 90 on 500, NOT a Salesforce amount/);
  assert.deepEqual(v.derivation.actual, [], "the reference amount is never reported as tax");
  assert.ok(v.derivation.diagnostics.some(d => d.code === "TAX_APPLICABLE_NOT_CALCULATED"));
  const g = invoicePostingGate(v);
  assert.ok(!g.allowed);
  const f = taxPostingFailure(v, g as { code: string; error: string; findings: unknown });
  assert.equal(f.code, "TAX_CALCULATION_FAILED");
  assert.match(f.reason, /^Tax applicable — calculation failed\. Posting blocked —/);
});

test("SCENARIO 4 — zero-tax invoice: Salesforce finished, its table matches a 0% rate → zero tax, postable", async () => {
  const v = await verify(invoice(), api({ preview: preview({ rates: [0] }), trace: trace({ rows: [{ name: "TR-EXPORT-0", rate: 0 }] }) }));
  assert.deepEqual([v.derivation.status, v.state], ["NO_TAX_EXPECTED", "VERIFIED_ZERO_TAX"]);
  assert.equal(v.derivation.applicability?.verdict, "ZERO_TAX");
  assert.equal(invoiceTaxOutcome(v), "ZERO_TAX");
  assert.equal(allowed(v), true);
  assert.match(v.derivation.message, /^Zero tax on DOC-000000004/);
});

/* ───────────── Applicability not proven → stays blocked (no weakening) ───────────── */

const blockedUndetermined = async (inv: TaxInvoice, a: ApplicabilityApi, pattern: RegExp, o: { errorLogReadable?: boolean } = {}) => {
  const v = await verify(inv, a, o);
  assert.equal(v.state, "TAX_VERIFICATION_FAILED");
  assert.equal(v.derivation.applicability?.verdict, "UNDETERMINED");
  assert.equal(invoiceTaxOutcome(v), "TAX_APPLICABILITY_UNDETERMINED");
  assert.equal(allowed(v), false);
  assert.match(v.derivation.message, pattern);
  assert.match(v.derivation.message, /never treated as zero tax without proof/);
  return v;
};

test("stale decision table (a Tax Rate changed after the last refresh) — its No Match proves nothing → blocked", async () => {
  await blockedUndetermined(invoice(), api({ stale: [STALE] }), /last refreshed .* before Tax Rate change\(s\) TR-00000031/);
});
test("decision table not refreshed / not Active → blocked", async () => {
  await blockedUndetermined(invoice(), api({ trace: trace({ refresh: "InProgress" }) }), /refresh InProgress/);
  await blockedUndetermined(invoice(), api({ trace: trace({ dtStatus: "Draft" }) }), /is Draft/);
});
test("Salesforce's evaluation says No Match, but a TaxRate row with 18% matches → the evaluations disagree → blocked", async () => {
  await blockedUndetermined(invoice(), api({ trace: trace({ rows: [{ name: "TR-GST18", rate: 18 }] }) }), /evaluations disagree/);
});
test("0% evaluation contradicted by an 18% source row → blocked", async () => {
  await blockedUndetermined(invoice(), api({ preview: preview({ rates: [0] }), trace: trace({ rows: [{ name: "TR-GST18", rate: 18 }] }) }), /evaluations disagree/);
});
/* ── No invoice address (blank Country) — the p13 DOC-000000005 case ── */

// p13: Laptop's treatment "OmniCloud Mexico Tax Treatment" uses Tax Treatment Items, none for Laptop → no tax code. The org's only
// rate is TR-00000001 (MX / JA / MX-JAL-TAX, 16%). The invoice has no InvoiceAddressGroup, so Country is blank.
const NO_ADDRESS = { Country: null, State: null, RateUsageType: "RevCloud", TaxCode: null, ProductCode: "LP001", LegalEntityId: LE, StartDate: "2026-11-16", EndDate: "2026-11-16" };
const TR1 = { Id: "0TR1", Name: "TR-00000001", Country: "MX", State: "JA", TaxCode: "MX-JAL-TAX", ProductCode: null, Rate: 16, RateUsageType: "RevCloud", StartDate: "2026-11-11", EndDate: null, LegalEntityId: LE };
const laptop = () => invoice([line({ product: "Laptop", productId: "01thg000002rBHPAA2", charge: 100 })], { number: "DOC-000000005", subtotal: 100 });

test("p13 DOC-000000005 — no address, product has no tax code, the only rate needs MX-JAL-TAX → tax NOT applicable → postable (no evaluation call)", async () => {
  const a = api({ trace: trace({ inputs: NO_ADDRESS }), rates: [TR1] });
  const v = await verify(laptop(), a);
  assert.deepEqual([v.derivation.status, v.state], ["NO_TAX_EXPECTED", "VERIFIED_ZERO_TAX"]);
  assert.equal(invoiceTaxOutcome(v), "TAX_NOT_APPLICABLE");
  assert.equal(allowed(v), true);
  assert.match(v.derivation.message, /Laptop: no tax applies — no Tax Rate can match the line \(the product has no tax code under treatment "India LE Treatment"\)/);
  assert.match(v.derivation.message, /TR-00000001: TaxCode MX-JAL-TAX ≠ \(blank\)/);
  assert.ok(!a.calls.includes("preview"), "Salesforce's evaluation isn't called without a required input");
  assert.deepEqual(v.derivation.actual, []);
});

test("no address, but a 16% rate could match depending on the missing Country → tax may apply → blocked with 'add the address'", async () => {
  const anyCode = { ...TR1, TaxCode: null, State: null };
  const v = await blockedUndetermined(laptop(), api({ trace: trace({ inputs: NO_ADDRESS }), rates: [anyCode] }), /tax may apply — Tax Rate TR-00000001 \(16%, needs Country\) can match the line/);
  assert.match(v.derivation.message, /Add the billing\/shipping address/);
});

test("no address: a rate excluded only by an UNKNOWN input (Country/State) is never used as proof", async () => {
  // The rate matches the known inputs (tax code present on the line) — Country/State are unknown, so tax may apply.
  await blockedUndetermined(laptop(), api({ trace: trace({ inputs: { ...NO_ADDRESS, TaxCode: "MX-JAL-TAX" } }), rates: [TR1] }), /tax may apply/);
});

test("no address, only 0% rates can match → zero tax, postable", async () => {
  const v = await verify(laptop(), api({ trace: trace({ inputs: NO_ADDRESS }), rates: [{ ...TR1, TaxCode: null, Rate: 0 }] }));
  assert.equal(invoiceTaxOutcome(v), "ZERO_TAX");
  assert.equal(allowed(v), true);
});

test("no address and the rates can't all be read (error / truncated) → blocked", async () => {
  await blockedUndetermined(laptop(), api({ trace: trace({ inputs: NO_ADDRESS }), ratesThrow: "INVALID_FIELD" }), /Tax Rates couldn't be read \(INVALID_FIELD\)/);
  await blockedUndetermined(laptop(), api({ trace: trace({ inputs: NO_ADDRESS }), rates: [TR1], ratesTruncated: true }), /more than 2000 Tax Rates/);
});

test("no address: the rates are read once for the whole invoice", async () => {
  const a = api({ trace: id => trace({ lineId: id, inputs: NO_ADDRESS }), rates: [TR1] });
  const v = await verify(invoice([line({ product: "Laptop" }), line({ id: LINE2, product: "Mouse" })]), a);
  assert.equal(allowed(v), true);
  assert.equal(a.calls.filter(c => c === "rates").length, 1);
});
test("evaluation error, inactive/missing engine, unreadable records, trace failure → blocked", async () => {
  await blockedUndetermined(invoice(), api({ preview: preview({ error: "boom" }) }), /evaluation returned an error/);
  await blockedUndetermined(invoice(), api({ trace: trace({ engineStatus: "Inactive" }) }), /tax engine "Revenue Standard Tax" is Inactive/);
  await blockedUndetermined(invoice(), api({ trace: trace({ engineStatus: null }) }), /has no tax engine/);
  await blockedUndetermined(invoice(), api({ trace: trace({ unreadable: ["INSUFFICIENT_ACCESS"] }) }), /couldn't be read: INSUFFICIENT_ACCESS/);
  await blockedUndetermined(invoice(), api({ traceThrows: "socket hang up" }), /tax chain couldn't be read \(socket hang up\)/);
  await blockedUndetermined(invoice(), api({ staleThrows: "no access" }), /freshness couldn't be checked/);
});
test("error log unreadable, or TotalTaxAmount non-zero without InvoiceLineTax → blocked even when no rate applies", async () => {
  await blockedUndetermined(invoice(), api(), /error log for DOC-000000004 couldn't be read/, { errorLogReadable: false });
  await blockedUndetermined(invoice(undefined, { tax: 90 }), api(), /TotalTaxAmount 90 ≠ its InvoiceLineTax total 0/);
});

/* ───────────── Mixed invoices, other verdicts, normal (order) invoices ───────────── */

test("mixed invoice: one line taxed 18% (verified) + one line with no applicable tax → CALCULATED, postable", async () => {
  const taxed = line({ taxAmount: 90, taxes: [ilt(90)] });
  const untaxed = line({ id: LINE2, name: "Admin fee" });
  const v = await verify(invoice([taxed, untaxed], { subtotal: 1000, tax: 90 }), api({ trace: id => trace({ lineId: id }) }));
  assert.deepEqual([v.derivation.status, v.state], ["CALCULATED", "VERIFIED_TAX_APPLIED"]);
  assert.equal(v.derivation.applicability?.verdict, "TAX_APPLIED");
  assert.match(v.derivation.message, /No tax applies to the other line\(s\): Admin fee/);
  assert.equal(allowed(v), true);
});
test("mixed invoice whose taxed line is inconsistent stays blocked by the integrity check", async () => {
  const v = await verify(invoice([line({ taxAmount: 100, taxes: [ilt(100)] }), line({ id: LINE2 })], { tax: 100 }), api({ trace: id => trace({ lineId: id }) }));
  assert.equal(v.state, "TAX_INTEGRITY_MISMATCH");
  assert.equal(allowed(v), false);
});
test("mixed invoice: the untaxed line has an 18% rate → calculation failure, blocked", async () => {
  const v = await verify(invoice([line({ taxAmount: 90, taxes: [ilt(90)] }), line({ id: LINE2 })], { tax: 90 }), api({ trace: id => trace({ lineId: id }), preview: preview({ rates: [18] }) }));
  assert.equal(v.derivation.applicability?.verdict, "APPLICABLE_NOT_CALCULATED");
  assert.equal(allowed(v), false);
});
test("applyTaxApplicability changes nothing but INVOICE_TIME_TAX_NOT_APPLIED (pending, unreadable, treatment mismatch, processing error)", () => {
  const pending = deriveSalesforceTax(invoice([line({ taxStatus: "Pending" })]), [TREAT], null);
  const unreadable = deriveSalesforceTax(invoice(undefined, { taxRecordsError: "no access" }), [TREAT], null);
  const errored = deriveSalesforceTax(invoice(undefined, { status: "Error" }), [TREAT], null);
  const fallback = deriveSalesforceTax(invoice([line({ productId: "01tg8000000PRODAAA", treatment: { id: "1ttNONTAX", name: "Non-taxable" } })]), [TREAT, { id: "1ttNONTAX", name: "Non-taxable", taxable: false }], null, { "01tg8000000PROD": { id: TREAT.id, name: TREAT.name, taxable: true } });
  for (const d of [pending, unreadable, errored, fallback]) assert.equal(applyTaxApplicability(invoice(), d, [], { errorLogReadable: true }), d, d.reason ?? d.status);
  assert.equal(fallback.reason, "TREATMENT_MISMATCH");
});
test("a non-taxable treatment is still verified zero tax without any applicability lookup (existing path)", async () => {
  const a = api();
  const NON = { id: "1ttNONTAX", name: "Exempt", taxable: false };
  const d = deriveSalesforceTax(invoice([line({ treatment: { id: NON.id, name: NON.name } })]), [NON], null);
  assert.deepEqual([d.status, invoiceTaxFlowState(d.status, d.reason)], ["NO_TAX_EXPECTED", "VERIFIED_ZERO_TAX"]);
  assert.deepEqual(a.calls, []);
});

/* ───────────── Billing Lifecycle wiring ───────────── */

const lifecycle = (): LifecycleState => ({
  success: true, debitMemoId: "DM", target: "settled", failure: null, complete: false, tax: null, message: "",
  steps: [{ id: "invoice-posted", label: "Invoice Posted", state: "current", detail: "DOC-000000004 · Draft" }],
  next: { action: "post-invoice", label: "Post invoice DOC-000000004", needsConfirmation: false, irreversible: true },
  billing: {} as LifecycleState["billing"], summary: {} as LifecycleState["summary"],
});

test("lifecycle: the Invoice Posted step shows which tax case applies", async () => {
  const ok = withTaxCheck(lifecycle(), await verify(invoice(), api()));
  assert.equal(ok.tax?.outcome, "TAX_NOT_APPLICABLE");
  assert.equal(ok.tax?.postable, true);
  assert.equal(ok.steps[0].detail, "DOC-000000004 · Draft · Tax check: Tax not applicable");
  const bad = withTaxCheck(lifecycle(), await verify(invoice(), api({ preview: preview({ rates: [18] }) })));
  assert.equal(bad.tax?.outcome, "TAX_CALCULATION_FAILED");
  assert.equal(bad.steps[0].detail, "DOC-000000004 · Draft · Tax check: Tax applicable — calculation failed — posting blocked");
  const taxed = withTaxCheck(lifecycle(), await verify(invoice([line({ taxAmount: 90, taxes: [ilt(90)] })], { tax: 90 }), api()));
  assert.equal(taxed.tax?.label, "Tax applicable and calculated");
});

test("lifecycle source: posting re-verifies tax on every attempt and re-uses the existing invoice; Retry re-reads, then resumes", () => {
  const src = readFileSync("lib/billing/server/debitMemoLifecycle.ts", "utf8");
  const block = src.slice(src.indexOf('next.action === "post-invoice"'), src.indexOf('next.action === "create-payment"'));
  assert.ok(block.indexOf("verifyInvoiceTax(client, s.invoice.id)") < block.indexOf("invoicePostingGate(tax)"));
  assert.ok(block.indexOf("invoicePostingGate(tax)") < block.indexOf("/commerce/invoicing/invoices/collection/actions/post"));
  assert.doesNotMatch(block, /actions\/ingest|sobjects\/DebitMemo/, "the posting step never regenerates the invoice or touches the debit memo");
  assert.match(src, /getLifecycle\(client, id, target, mode, \{ checkTax: false, snap: s \}\)/, "advance verifies tax once, right before posting, and reads Salesforce once");
  // Invoice generation only happens while no invoice exists for the memo's lines (found again on every read).
  assert.match(src, /else if \(needInvoice && posted && !inv\)/);
  const ui = readFileSync("components/data/billing/BillingDebitMemosWorkspace.tsx", "utf8");
  assert.match(ui, /label="Retry from this step" icon="refresh" isDark=\{isDark\} onClick=\{\(\) => void retry\(\)\}/);
  const retry = ui.slice(ui.indexOf("async function retry()"), ui.indexOf("// Auto-start once"));
  assert.match(retry, /quoteApiGet<LifecycleState>\("Read lifecycle", url\)/);
  assert.match(retry, /await run\(null, fresh\)/);
  assert.match(retry, /!fresh\.next\.needsConfirmation/, "a payment still needs the user's confirmation on retry");
});

test("order invoices and debit-memo invoices share the one verifier + gate", () => {
  const order = readFileSync("lib/billing/server/orderBilling.ts", "utf8");
  const fn = order.slice(order.indexOf("export async function postOrderInvoice"));
  assert.ok(fn.indexOf("verifyInvoiceTax(client, inv.id)") > 0 && fn.indexOf("invoicePostingGate(tax") > fn.indexOf("verifyInvoiceTax(client, inv.id)"));
  const tax = readFileSync("lib/tax/server/invoiceTax.ts", "utf8");
  const verifyFn = tax.slice(tax.indexOf("export async function verifyInvoiceTax"), tax.indexOf("export async function readScheduleTreatments"));
  assert.match(verifyFn, /derivation\.reason === "INVOICE_TIME_TAX_NOT_APPLIED"/);
  assert.match(verifyFn, /applyTaxApplicability\(inv, derivation, assessed/);
});
