/**
 * TAX CALCULATION service — the authoritative tax is Salesforce's InvoiceLineTax. In-memory Salesforce: a run advances only
 * through the service's confirmed steps; invoices/InvoiceLineTax appear as Salesforce would produce them; readiness is a realistic
 * Desktop Germany configuration (variants model each missing/invalid link).
 *
 * Run: `npx tsx --test lib/tax/server/salesforceTaxCalculation.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateSalesforceTax, deriveSalesforceTax, DIRECT_TAX_API, readSalesforceTax, type SfTaxApi } from "./salesforceTaxCalculation";
import { BILLABLE_ACTIONS, type RunAction, type TaxRunState } from "./verification";
import { parseTaxQuery } from "./taxQuery";
import type { ProductTaxReadiness } from "./pipeline";
import { evaluateCalculationValidation } from "./calculationValidation";
import { parsePreview, previewConditions, previewDecisionTable } from "./calculationDiagnostics";
import { NO_INVOICE_LINE_TAX, PREVIEW_LABEL, REFERENCE_LABEL, type DecisionTablePreview, type InvoiceTaxEvidence, type TaxInputs } from "./calculationResult";

const ORDER = "801000000000SF1", INV = "3tt000000000SF1", LINE = "3tl000000000SF1", ILT = "3lt000000000SF1", TREAT = "1tt000000000DE1", ACC = "001000000000DE1", CON = "003000000000DE1";
const POL = "1Tp000000000DE1", ENG = "4wA000000000DE1", DT = "0lD000000000DE1", RATE = "0xq000000000DE1", ITEM = "1tu000000000DE1", LE = "0fw000000000DE1", PROD = "01t000000000DS1";
type Inv = NonNullable<TaxRunState["invoice"]>;
const line = (o: Partial<Inv["lines"][number]> = {}): Inv["lines"][number] => ({ id: LINE, name: "L1", product: "Desktop", productId: PROD, quantity: 1, unitPrice: 1149, charge: 1149, taxAmount: null, chargeAmountWithTax: null, taxRate: null, taxCode: null, taxStatus: "Pending", treatment: { id: TREAT, name: "Desktop Germany Tax Treatment" }, legalEntityId: "0fwg8000000FFefAAG", adjustmentAmount: 0, adjustmentTaxAmount: 0, taxes: [], ...o });
// Salesforce's Invoice.TotalTaxAmount = the sum of its InvoiceLineTax.
const invoice = (o: Partial<Inv> = {}, lines = [line()]): Inv => ({ id: INV, number: "DOC-000000020", status: "Draft", subtotal: 1149, tax: lines.flatMap(l => l.taxes).reduce((n, t) => n + (t.amount ?? 0), 0), totalWithTax: null, balance: 1149, date: "2026-10-08", lines, ...o });
const ilt = (amount: number, o: Partial<Inv["lines"][number]["taxes"][number]> = {}) => ({ id: ILT, name: "DE VAT", amount, rate: 19, code: "DE_VAT_19", status: "Estimated", effectiveDate: "2026-10-08", treatment: { id: TREAT, name: "Desktop Germany Tax Treatment" }, legalEntityId: "0fwg8000000FFefAAG", exemptAmount: 0, ...o });
const zeroTaxInvoice = () => invoice({ tax: 0 }, [line({ taxStatus: "Estimated", taxAmount: 0 })]);
const SEQ: RunAction[] = ["activate", "schedules", "generate-invoice", "calculate-tax", "post-invoice"];
const ALL_INPUTS = ["Country", "State", "City", "ZipCode", "ProductCode", "StartDate", "EndDate", "RateUsageType", "LegalEntityId", "TaxCode"];

/* ── Desktop Germany readiness (as getProductTaxReadiness returns it), with variants ── */
type RdOpts = { stale?: boolean; noTreatment?: boolean; ambiguous?: boolean; noEngine?: boolean; noTable?: boolean; noRate?: boolean; notTaxable?: boolean; inactiveTable?: boolean; noItem?: boolean; geoWarning?: boolean; noTreatmentLe?: boolean };
function readinessFixture(o: RdOpts = {}): ProductTaxReadiness {
  const diagnostics: ProductTaxReadiness["diagnostics"] = [];
  if (o.stale) diagnostics.push({ code: "DECISION_TABLE_NOT_READY", stage: "readiness", severity: "error", title: "x", explanation: "Decision table not ready" });
  if (o.ambiguous) diagnostics.push({ code: "AMBIGUOUS_TAX_TREATMENT", stage: "configuration", severity: "error", title: "x", explanation: 'Tax Policy "Desktop Germany Tax Policy" has 2 active treatments for that legal entity (A, B).' });
  if (o.noTreatment) diagnostics.push({ code: "MISSING_TAX_TREATMENT", stage: "configuration", severity: "error", title: "x", explanation: 'Tax Policy "Desktop Germany Tax Policy" has no default Tax Treatment.' });
  if (o.noRate) diagnostics.push({ code: "MISSING_TAX_RATE", stage: "configuration", severity: "error", title: "x", explanation: "No effective RevCloud tax rate matches country DE." });
  const treatment = o.noTreatment || o.ambiguous ? null : { id: TREAT, name: "Desktop Germany Tax Treatment", status: "Active", taxable: !o.notTaxable, taxCode: null, productCode: null, policyId: POL, engineId: o.noEngine ? null : ENG, legalEntityId: o.noTreatmentLe ? null : LE, useItems: true };
  const engine = treatment && !o.noEngine ? { id: ENG, name: "Desktop Germany Tax Engine", type: "RevenueStandardTax", status: "Active", native: true, decisionTableId: o.noTable ? null : DT, providerId: null } : null;
  const rate = { id: RATE, name: "TR-00000014", taxCode: "DE_VAT_19", rate: 19, countryIso: "DE", stateIso: null, city: null, zipCode: null, productCode: "DS001", legalEntityId: LE, usage: "RevCloud", basis: "Net", start: "2026-10-08", end: null, priority: 1 };
  const resolution = {
    status: "resolved", product: { id: PROD, name: "Desktop", code: "DS001", active: true, taxPolicyId: POL },
    treatment: { status: treatment ? "resolved" : "blocked", policy: { id: POL, name: "Desktop Germany Tax Policy", status: "Active", selection: "Default", defaultTreatmentId: TREAT }, treatment, item: o.noItem ? null : { id: ITEM, name: "Desktop Germany Tax Treatment Item", treatmentId: TREAT, productId: PROD, taxCode: "DE_VAT_19", productCode: "DS001" }, engine, taxCode: o.noItem ? null : "DE_VAT_19", productCode: "DS001", diagnostics },
    geography: { countryIso: "DE", country: { id: "geo", name: "Germany", iso: "DE" }, stateIso: null, state: null, diagnostics: o.geoWarning ? [{ code: "MISSING_GEOGRAPHY", stage: "configuration", severity: "warning", title: "x", explanation: 'State "Bavaria" in Germany has no GeoState record in this org — only rates without a state can apply.' }] : [] },
    rate: treatment?.taxable ? (o.noRate ? { status: "none", selected: null, why: [], candidates: [], nearMisses: [], dimensions: [], diagnostics: diagnostics.filter(d => d.code === "MISSING_TAX_RATE") } : { status: "resolved", selected: rate, why: ["matched Tax Code = DE_VAT_19", "matched Country = DE"], candidates: [], nearMisses: [], dimensions: [], diagnostics: [] }) : null,
    context: null, legalEntity: { id: LE, name: "Default Legal Entity - US" }, diagnostics,
  };
  const engineReadiness = treatment?.taxable ? {
    status: o.stale || o.noTable || o.noEngine ? "BLOCKED" : "READY",
    engine: engine ? { id: ENG, name: engine.name, type: engine.type, status: engine.status, decisionTableId: engine.decisionTableId } : null,
    decisionTable: engine && !o.noTable ? { id: DT, name: "RevenueStandardTaxWithTaxCode", setupName: "Revenue Standard Tax Entries with Tax Code", source: "engine", status: o.inactiveTable ? "Draft" : "Active", usageType: "RevenueStandardTax", refreshStatus: "Completed", lastSync: "2026-10-08T05:51:49.000+0000", inputs: ALL_INPUTS, outputs: ["ApplicationBasis", "Rate", "Priority", "FlatTaxAmount"], sourceObject: "TaxRate" } : null,
    checks: [{ code: "TABLE_REFRESHED", label: "", object: "DecisionTable", recordId: DT, passed: !o.stale, detail: "", salesforceMessage: null, remediation: null }, { code: "TABLE_REQUIRED_INPUTS", label: "", object: "DecisionTableParameter", recordId: DT, passed: true, detail: "", salesforceMessage: null, remediation: null }],
  } : null;
  return { success: true, status: o.stale || o.noTreatment || o.noRate ? "BLOCKED" : o.geoWarning ? "WARNING" : "READY", product: { id: PROD, name: "Desktop", code: "DS001" }, listPrice: 1149, areas: [], decisionTable: { state: "Ready", reason: "" }, resolution, engineReadiness, diagnostics, message: o.stale ? "Desktop is NOT ready: Decision Table BLOCKED" : "Desktop is ready." } as unknown as ProductTaxReadiness;
}

function runState(stage: number, inv: Inv | null): TaxRunState {
  const next = SEQ[stage] ?? null;
  return {
    success: true, orderId: ORDER, connection: {} as TaxRunState["connection"],
    order: { id: ORDER, number: "00000130", status: stage >= 1 ? "Activated" : "Draft", account: { id: ACC, name: "OmniCloud Tax Test DE GmbH" }, total: 1149, activated: stage >= 1, legalEntity: null },
    items: [{ id: "802000000000SF1", product: { id: PROD, name: "Desktop", code: "DS001" }, quantity: 1, unitPrice: 1149, total: 1149, taxPolicy: null, treatment: { id: TREAT, name: "Desktop Germany Tax Treatment" }, expectedTreatment: null, expectedCode: "DE_VAT_19", expectedRate: { id: RATE, name: "TR-00000014", taxCode: "DE_VAT_19", productCode: "DS001", rate: 19, usage: "RevCloud", country: "DE", geoCountryId: null, legalEntityId: null, start: null, end: null, effective: true, lastModified: null }, rateCandidates: [] }],
    schedules: stage >= 2 ? [{ id: "BS0000000000SF1", number: "BS-000000020", status: "ReadyForInvoicing", amount: 1149, invoiced: stage >= 3, treatment: { id: TREAT, name: "Desktop Germany Tax Treatment" }, product: "Desktop" }] : [],
    invoice: inv, readiness: { ready: true, reason: null },
    steps: ["config", "order", "setup", "activate", "schedules", "readiness", "invoice", "tax", "post", "verify"].map(id => ({ id, label: id, state: "pending" as const, detail: "" })),
    next: next ? { action: next, label: next } : null,
    confirmation: next && BILLABLE_ACTIONS.has(next) ? { action: next, detail: `confirm ${next}` } : null,
    failure: null, checks: [], complete: false, taxCalculation: "PENDING", endToEnd: "IN PROGRESS", currency: "₹", message: "",
  };
}

const PREVIEW_MATCH_JSON = { errorCode: null, errorMessage: null, outcomeList: [{ values: { ApplicationBasis: "Net", Rate: 19.0, Priority: 1.0, FlatTaxAmount: null } }], outcomeType: "Single Match", successStatus: true };
const PREVIEW_NOMATCH_JSON = { errorCode: null, errorMessage: null, outcomeList: [], outcomeType: "No Match", successStatus: true };

interface FakeOpts { rd?: RdOpts; ready?: boolean | "warn"; invoiceAfterGen?: Inv; invoiceSeq?: Inv[]; taxable?: boolean; errorLog?: { number: string; code: string; message: string } | null; startStage?: number; failure?: TaxRunState["failure"]; failStage?: number; staleTable?: boolean; genFailed?: boolean; preview?: "match" | "nomatch" | "error"; noContact?: boolean; evidenceError?: boolean }
function fake(o: FakeOpts = {}) {
  let stage = o.startStage ?? -1; // -1 = no order yet
  let inv: Inv | null = null;
  const invSeq = o.invoiceSeq ? [...o.invoiceSeq] : null;
  const calls: string[] = [];
  let cleared = false;
  const rd: RdOpts = { ...(o.ready === false ? { stale: true } : o.ready === "warn" ? { geoWarning: true } : {}), ...(o.rd ?? {}) };
  const previewRes = (dtId: string, conditions: DecisionTablePreview["conditions"], taxRate: DecisionTablePreview["taxRate"]) =>
    parsePreview(o.preview === "error" ? { status: 500, json: [{ errorCode: "UNKNOWN_EXCEPTION", message: "An unexpected error occurred. ErrorId 123" }] } : { status: 201, json: o.preview === "nomatch" ? PREVIEW_NOMATCH_JSON : PREVIEW_MATCH_JSON }, { decisionTableId: dtId, decisionTableName: "RevenueStandardTaxWithTaxCode", conditions, taxRate });
  const api: SfTaxApi = {
    readiness: async () => { calls.push("readiness"); return readinessFixture(rd); },
    account: async () => ({ id: ACC, name: "OmniCloud Tax Test DE GmbH", street: "Marienplatz 1", city: "München", state: "Bavaria", postalCode: "80331", country: "Germany" }),
    contactOf: async () => (o.noContact ? null : { id: CON, name: "Tax Tester" }),
    startRun: async () => { calls.push("startRun"); stage = 0; return { orderId: ORDER }; },
    runState: async () => { const s = runState(stage, inv); return o.failure && !cleared && stage >= (o.failStage ?? 3) ? { ...s, failure: o.failure, next: null, confirmation: null } : s; },
    advance: async (_id, confirm, opts) => {
      if (opts?.retry) { cleared = true; calls.push("retry"); }
      const next = SEQ[stage];
      calls.push(`advance:${confirm ?? "-"}:${next}`);
      if (BILLABLE_ACTIONS.has(next) && confirm !== next) return runState(stage, inv); // the real advanceTaxRun refuses unconfirmed billable steps
      if (next === "generate-invoice") inv = o.invoiceAfterGen ?? invoice();
      stage++;
      return runState(stage, inv);
    },
    generateInvoice: async () => {
      calls.push("generateInvoice");
      if (o.staleTable) return { status: "BLOCKED", message: "Invoice not generated — the tax decision table is Not Ready: refresh it in Salesforce: App Launcher → Lookup Tables → X → Refresh", diagnostics: [{ code: "DECISION_TABLE_NOT_READY", stage: "readiness", severity: "error", title: "x", explanation: "stale" }], decisionTable: { state: "Not Ready", reason: "stale", refreshed: false }, invoice: null };
      if (o.genFailed) return { status: "FAILED", message: "Invoice generation failed: INVALID_INPUT: Billing schedule is not ready", diagnostics: [{ code: "INVOICE_GENERATION_FAILED", stage: "invoice", severity: "error", title: "x", explanation: "Salesforce didn't generate the invoice (INVALID_INPUT): Billing schedule is not ready", httpStatus: 400, salesforceCode: "INVALID_INPUT", salesforceMessage: "Billing schedule is not ready" }], decisionTable: { state: "Ready", reason: "", refreshed: false }, invoice: null };
      inv = o.invoiceAfterGen ?? invoice(); stage = SEQ.indexOf("generate-invoice") + 1;
      return { status: "GENERATED", message: "", diagnostics: [], decisionTable: null, invoice: { id: inv.id, number: inv.number, status: inv.status } };
    },
    invoice: async () => { calls.push("invoice"); if (invSeq?.length) inv = invSeq.length > 1 ? invSeq.shift()! : invSeq[0]; return inv ?? invoice(); },
    findInvoice: async n => { calls.push(`findInvoice:${n}`); return n === "DOC-000000020" ? INV : null; },
    calculateInvoiceTax: async () => { calls.push("calculateInvoiceTax"); return { ok: true }; },
    treatments: async ids => ids.map(id => ({ id, name: "Desktop Germany Tax Treatment", taxable: o.taxable !== false })),
    errorLog: async () => o.errorLog ?? null,
    preview: async input => { calls.push("preview"); return previewRes(input.decisionTableId, previewConditions(input.inputs, ALL_INPUTS.map(field => ({ field, operator: null }))), input.taxRate); },
    evidence: async (invoiceId, lineId): Promise<InvoiceTaxEvidence> => {
      calls.push("evidence");
      if (o.evidenceError) throw new Error("INSUFFICIENT_ACCESS: InvoiceAddressGroup");
      const cur = inv ?? invoice();
      const l = cur.lines.find(x => x.id === lineId) ?? cur.lines[0];
      return { invoiceId, invoiceNumber: cur.number, invoiceLineId: l?.id ?? null, taxTreatmentId: TREAT, taxEngineId: ENG, decisionTableId: DT, invoiceTaxAmount: cur.tax, invoiceLineTaxAmount: l?.taxAmount ?? null, taxProcessingStatus: l?.taxStatus ?? null, invoiceLineTaxCount: l?.taxes.length ?? 0, errorLogCount: o.errorLog ? 1 : 0, traceClassification: l?.taxes.length ? "CONFIGURATION_MATCH" : "INVOICE_TIME_TAX_NOT_APPLIED", matchedTaxRate: { id: RATE, name: "TR-00000014", outputs: { Rate: 19, ApplicationBasis: "Net", Priority: 1 } }, preview: previewRes(DT, [], { id: RATE, name: "TR-00000014", taxCode: "DE_VAT_19", rate: 19 }), errors: [] };
    },
    sleep: async () => {},
  };
  return { api, calls, setStage: (s: number) => { stage = s; } };
}
const prepare = { mode: "billing" as const, product: { name: "Desktop" }, accountName: "OmniCloud Tax Test DE GmbH", quantity: 1, unitPrice: 1149 };
const WRITES = /startRun|advance:(activate|schedules|generate-invoice|post-invoice):|generateInvoice|calculateInvoiceTax/;

/* ═════════════ Existing guarantees ═════════════ */

test("1. the direct Tax Calculation API (404 for Revenue Standard Tax in p10) is never the calculation mechanism — recorded as a known fact", async () => {
  const f = fake();
  const r = await calculateSalesforceTax(f.api, prepare);
  assert.deepEqual([r.directTaxApi.observedStatus, r.directTaxApi.observedCode], [404, "NOT_FOUND"]);
  assert.equal(DIRECT_TAX_API.endpoint, "POST /commerce/taxes/actions/calculate");
  assert.ok(!("commerceCalculate" in f.api), "the service has no access to the direct API");
  // Executable code only (comments document the limitation; the DIRECT_TAX_API constant records it).
  const code = readFileSync("lib/tax/server/salesforceTaxCalculation.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/DIRECT_TAX_API = \{[^}]*\}/, "");
  assert.doesNotMatch(code, /commerceCalculate|\/commerce\/taxes\/actions\/calculate/);
});

test("2. configuration not ready (stale decision table) → NOT_READY · DECISION_TABLE_STALE with diagnostics; no order created", async () => {
  const f = fake({ ready: false });
  const r = await calculateSalesforceTax(f.api, { ...prepare, confirm: "create-order" });
  assert.deepEqual([r.status, r.reason], ["NOT_READY", "DECISION_TABLE_STALE"]);
  assert.equal(r.diagnostics[0].code, "DECISION_TABLE_NOT_READY");
  assert.match(r.message, /Lookup Tables → .* → Refresh/);
  assert.ok(!f.calls.includes("startRun"));
});

test("2b. readiness WARNING (non-blocking, e.g. no GeoState for Bavaria) still allows a confirmed run", async () => {
  const f = fake({ ready: "warn" });
  const r = await calculateSalesforceTax(f.api, prepare);
  assert.deepEqual([r.status, r.awaiting?.step], ["AWAITING_CONFIRMATION", "create-order"]);
  assert.ok(!f.calls.includes("startRun"));
});

test("3. order creation requires confirmation", async () => {
  const f = fake();
  const r = await calculateSalesforceTax(f.api, prepare);
  assert.deepEqual([r.status, r.awaiting?.step], ["AWAITING_CONFIRMATION", "create-order"]);
  assert.ok(!f.calls.includes("startRun"));
  const c = await calculateSalesforceTax(f.api, { ...prepare, confirm: "create-order" });
  assert.equal(f.calls.filter(x => x === "startRun").length, 1);
  assert.deepEqual([c.status, c.awaiting?.step, c.orderId], ["AWAITING_CONFIRMATION", "activate", ORDER], "stops before the next billable step");
  assert.ok(c.createdRecords.some(x => x.object === "Order" && x.id === ORDER));
});

test("4. activation requires its own confirmation — and doesn't chain into billing schedules", async () => {
  const f = fake({ startStage: 0 });
  const noConfirm = await calculateSalesforceTax(f.api, { orderId: ORDER });
  assert.equal(noConfirm.awaiting?.step, "activate");
  assert.ok(!f.calls.some(c => c.startsWith("advance:activate")));
  const wrong = await calculateSalesforceTax(f.api, { orderId: ORDER, confirm: "generate-invoice" });
  assert.ok(!f.calls.some(c => /advance:(activate|generate-invoice)/.test(c)), "confirming a different step does nothing");
  assert.match(wrong.diagnostics[0].explanation, /isn't the next step/);
  const ok = await calculateSalesforceTax(f.api, { orderId: ORDER, confirm: "activate" });
  assert.deepEqual(f.calls.filter(c => c.startsWith("advance:activate")), ["advance:activate:activate"]);
  assert.equal(ok.awaiting?.step, "schedules");
});

test("5. invoice generation requires its own confirmation", async () => {
  const f = fake({ startStage: 2 });
  const r = await calculateSalesforceTax(f.api, { orderId: ORDER });
  assert.equal(r.awaiting?.step, "generate-invoice");
  assert.ok(!f.calls.includes("generateInvoice"));
  assert.equal(r.invoiceId, null);
});

test("6. InvoiceLineTax absent is never CALCULATED (finished processing → FAILED; still processing → PENDING)", () => {
  const done = deriveSalesforceTax(invoice({ status: "Draft" }, [line({ taxStatus: "Estimated", taxAmount: 218.31 })]), [{ id: TREAT, name: "T", taxable: true }], null);
  assert.equal(done.status, "CALCULATION_FAILED");
  assert.equal(done.actual.length, 0);
  assert.equal(deriveSalesforceTax(invoice({}, [line({ taxStatus: "Pending" })]), [{ id: TREAT, name: "T", taxable: true }], null).status, "CALCULATION_PENDING");
});

test("7 & 15. InvoiceLineTax present → CALCULATED; the amount comes only from InvoiceLineTax (not the line or the expectation)", async () => {
  const withIlt = invoice({}, [line({ taxStatus: "Estimated", taxAmount: 218.31, taxes: [ilt(218.31)] })]);
  const f = fake({ startStage: 2, invoiceAfterGen: withIlt });
  const r = await calculateSalesforceTax(f.api, { orderId: ORDER, confirm: "generate-invoice", waitMs: 0 });
  assert.equal(r.status, "CALCULATED");
  assert.equal(r.source, "SALESFORCE_INVOICELINETAX");
  assert.deepEqual(r.actual.map(a => [a.invoiceLineTaxId, a.invoiceLineId, a.taxAmount, a.taxRate, a.taxCode, a.taxTreatmentId, a.source]), [[ILT, LINE, 218.31, 19, "DE_VAT_19", TREAT, "SALESFORCE_INVOICELINETAX"]]);
  assert.ok(r.verification.find(v => v.label === "InvoiceLineTax.TaxCode = DE_VAT_19")?.passed);
  // A line whose TaxAmount contradicts its InvoiceLineTax is no longer "calculated": the records are inconsistent.
  const contradicting = fake({ startStage: 2, invoiceAfterGen: invoice({}, [line({ taxStatus: "Estimated", taxAmount: 999, taxes: [ilt(218.31)] })]) });
  const bad = await calculateSalesforceTax(contradicting.api, { orderId: ORDER, confirm: "generate-invoice", waitMs: 0 });
  assert.deepEqual([bad.status, bad.reason], ["CALCULATION_FAILED", "TAX_INTEGRITY_MISMATCH"]);
});

test("8. a Salesforce tax error → CALCULATION_FAILED · TAX_PROCESSING_ERROR with Salesforce's code and message (never zero tax)", () => {
  const r = deriveSalesforceTax(invoice({ status: "Error" }, [line({ taxStatus: "Pending" })]), [{ id: TREAT, name: "T", taxable: true }], { number: "RTE-000000020", code: "TAX_INTERNAL_ERROR", message: "Decision Table lookup failed" });
  assert.deepEqual([r.status, r.reason], ["CALCULATION_FAILED", "TAX_PROCESSING_ERROR"]);
  assert.equal(r.actual.length, 0);
  assert.deepEqual([r.diagnostics[0].salesforceCode, r.diagnostics[0].salesforceMessage], ["TAX_INTERNAL_ERROR", "Decision Table lookup failed"]);
});

test("9. pending invoice → CALCULATION_PENDING (no waiting requested / read-only state)", async () => {
  const f = fake({ startStage: 3, invoiceAfterGen: invoice() });
  f.setStage(3);
  const pending = await calculateSalesforceTax(f.api, { mode: "invoice", invoiceId: INV, waitMs: 0 });
  assert.equal(pending.status, "CALCULATION_PENDING");
  const read = await readSalesforceTax(f.api, ORDER);
  assert.notEqual(read.status, "CALCULATION_TIMEOUT");
});

test("10. timeout: bounded wait without InvoiceLineTax → CALCULATION_TIMEOUT with the invoice Id and Salesforce state", async () => {
  const f = fake({ invoiceSeq: [invoice()] });
  const r = await calculateSalesforceTax(f.api, { mode: "invoice", invoiceId: INV, waitMs: 15_000 });
  assert.equal(r.status, "CALCULATION_TIMEOUT");
  assert.equal(r.invoiceId, INV);
  assert.match(r.message, /DOC-000000020.*Draft.*Pending/);
  assert.ok(f.calls.filter(c => c === "invoice").length >= 3, "re-read Salesforce while waiting");
  // …and when Salesforce produces it during the wait → CALCULATED
  const g = fake({ invoiceSeq: [invoice(), invoice({}, [line({ taxStatus: "Estimated", taxAmount: 218.31, taxes: [ilt(218.31)] })])] });
  assert.equal((await calculateSalesforceTax(g.api, { mode: "invoice", invoiceId: INV, waitMs: 30_000 })).status, "CALCULATED");
});

test("11. the expected amount never becomes the actual amount", async () => {
  const f = fake();
  const prep = await calculateSalesforceTax(f.api, prepare);
  assert.deepEqual([prep.expected?.source, prep.expected?.label, prep.expected?.taxAmount, prep.actual.length, prep.source, prep.result], ["EXPECTED_ONLY", REFERENCE_LABEL, 218.31, 0, null, null]);
  // Salesforce's own (self-consistent) record differs from the configured expectation: 10% of 1149 = 114.9 vs the expected 218.31.
  const g = fake({ startStage: 2, invoiceAfterGen: invoice({}, [line({ taxStatus: "Estimated", taxAmount: 114.9, taxes: [ilt(114.9, { rate: 10, code: "DE_VAT_10" })] })]) });
  const r = await calculateSalesforceTax(g.api, { orderId: ORDER, confirm: "generate-invoice", waitMs: 0 });
  assert.deepEqual([r.actual[0].taxAmount, r.result?.taxAmount, r.expected?.taxAmount], [114.9, 114.9, 218.31], "Salesforce's 114.9 is reported, not the expected 218.31");
});

test("12 & 13. InvoiceLineTax is never written and existing tax configuration is never (re)created", () => {
  for (const f of ["lib/tax/server/salesforceTaxCalculation.ts", "lib/tax/server/calculationValidation.ts", "lib/tax/server/calculationDiagnostics.ts", "lib/tax/server/calculationResult.ts", "lib/tax/server/verification.ts", "lib/billing/server/orderBilling.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /sobjects\/InvoiceLineTax|sobjects\/InvoiceLine\b|"InvoiceLineTax",\s*(null|\{)/, `${f} writes InvoiceLine/InvoiceLineTax`);
    assert.doesNotMatch(src, /refreshDecisionTable\(/, `${f} must not call the decision-table refresh API`);
  }
  for (const f of ["lib/tax/server/salesforceTaxCalculation.ts", "lib/tax/server/calculationValidation.ts", "lib/tax/server/calculationDiagnostics.ts"]) {
    const svc = readFileSync(f, "utf8");
    assert.doesNotMatch(svc, /sobjects\/(TaxRate|TaxTreatment|TaxTreatmentItem|TaxPolicy|TaxEngine|DecisionTable|GeoCountry|GeoState)/);
    assert.doesNotMatch(svc, /configureTaxCodeDecisionTable|executeOperations|executeTaxConfiguration/);
  }
});

test("NO_TAX_EXPECTED only when Salesforce finished processing non-taxable lines — never from an empty query, pending invoice or error", () => {
  const nt = [{ id: TREAT, name: "US LE", taxable: false }];
  assert.equal(deriveSalesforceTax(invoice({ status: "Posted" }, [line({ taxStatus: "Posted" })]), nt, null).status, "NO_TAX_EXPECTED");
  assert.equal(deriveSalesforceTax(invoice({}, [line({ taxStatus: "Pending" })]), nt, null).status, "CALCULATION_PENDING");
  assert.equal(deriveSalesforceTax(invoice({ status: "Error" }, [line({ taxStatus: "Posted" })]), nt, null).status, "CALCULATION_FAILED");
  assert.equal(deriveSalesforceTax(invoice({ status: "Posted" }, [line({ taxStatus: "Posted" })]), [], null).status, "CALCULATION_FAILED", "unknown taxability is not 'no tax'");
});

test("Salesforce error: a failure in the run (e.g. invoicing) is surfaced with its message", async () => {
  const f = fake({ startStage: 3, failure: { step: "tax", reason: "Salesforce Error RTE-21: TAX_INTERNAL_ERROR Decision Table lookup failed", code: "TAX_INTERNAL_ERROR" } });
  const r = await calculateSalesforceTax(f.api, { orderId: ORDER, waitMs: 0 });
  assert.equal(r.reason, "TAX_PROCESSING_ERROR");
  assert.equal(r.diagnostics.at(-1)?.salesforceCode, "TAX_INTERNAL_ERROR");
  assert.match(r.message, /Decision Table lookup failed/);
  assert.equal(r.actual.length, 0);
});

test("Salesforce error: a billing stop before the invoice (e.g. Draft billing policy at activation) → CALCULATION_FAILED · ORDER_ACTIVATION_FAILED with operation/object/record", async () => {
  const f = fake({ startStage: 0, failStage: 0, failure: { step: "activate", reason: 'Desktop: Billing Policy "Desktop Standard Billing Policy" is Draft — activate it before billing this order.', code: null } });
  const r = await calculateSalesforceTax(f.api, { orderId: ORDER, confirm: "activate", waitMs: 0 });
  assert.deepEqual([r.status, r.reason], ["CALCULATION_FAILED", "ORDER_ACTIVATION_FAILED"]);
  const d = r.diagnostics.at(-1)!;
  assert.deepEqual([d.code, d.operation, d.recordId], ["ORDER_ACTIVATION_FAILED", "activate (Order)", ORDER]);
  assert.match(r.message, /Billing Policy/);
  assert.equal(r.actual.length, 0);
});

test("Salesforce error: billing schedule failure → BILLING_SCHEDULE_FAILED; invoice generation failure keeps Salesforce's code/message", async () => {
  const f = fake({ startStage: 1, failStage: 1, failure: { step: "schedules", reason: "Required fields are missing: billToContact", code: "REQUIRED_FIELD_MISSING" } });
  const r = await calculateSalesforceTax(f.api, { orderId: ORDER, waitMs: 0 });
  assert.deepEqual([r.status, r.reason], ["CALCULATION_FAILED", "BILLING_SCHEDULE_FAILED"]);
  assert.equal(r.diagnostics.at(-1)?.salesforceCode, "REQUIRED_FIELD_MISSING");
  const g = fake({ startStage: SEQ.indexOf("generate-invoice"), genFailed: true });
  const gr = await calculateSalesforceTax(g.api, { orderId: ORDER, confirm: "generate-invoice", waitMs: 0 });
  assert.deepEqual([gr.status, gr.reason], ["CALCULATION_FAILED", "INVOICE_GENERATION_FAILED"]);
  const d = gr.diagnostics.find(x => x.code === "INVOICE_GENERATION_FAILED")!;
  assert.deepEqual([d.httpStatus, d.salesforceCode, d.salesforceMessage], [400, "INVALID_INPUT", "Billing schedule is not ready"]);
});

test("retry clears a recorded failure (after the admin fixed it) without performing the billable step", async () => {
  const f = fake({ startStage: 0, failStage: 0, failure: { step: "activate", reason: "Billing Policy is Draft", code: null } });
  const before = await calculateSalesforceTax(f.api, { orderId: ORDER, waitMs: 0 });
  assert.equal(before.status, "CALCULATION_FAILED");
  const r = await calculateSalesforceTax(f.api, { orderId: ORDER, retry: true, waitMs: 0 });
  assert.deepEqual([r.status, r.awaiting?.step], ["AWAITING_CONFIRMATION", "activate"]);
  assert.ok(f.calls.includes("retry"));
  assert.ok(!f.calls.some(c => c.startsWith("advance:activate")), "activation still needs its own confirmation");
});

test("stale decision table at invoice time: generateTaxInvoice (refresh never) blocks → NOT_READY · DECISION_TABLE_STALE, no invoice", async () => {
  const f = fake({ startStage: SEQ.indexOf("generate-invoice"), staleTable: true });
  const r = await calculateSalesforceTax(f.api, { orderId: ORDER, confirm: "generate-invoice", waitMs: 0 });
  assert.deepEqual([r.status, r.reason], ["NOT_READY", "DECISION_TABLE_STALE"]);
  assert.match(r.message, /Lookup Tables/);
  assert.ok(f.calls.includes("generateInvoice"));
  assert.ok(!f.calls.some(c => c.startsWith("advance:generate-invoice")), "the old direct path isn't used");
  assert.equal(r.invoiceId, null);
});

/* ═════════════ Validation (stages 1–6) ═════════════ */

const V = (o: RdOpts = {}, extra: Partial<Parameters<typeof evaluateCalculationValidation>[1]> = {}) => evaluateCalculationValidation(readinessFixture(o), { account: { id: ACC, name: "OmniCloud Tax Test DE GmbH", street: "Marienplatz 1", city: "München", state: "Bavaria", postalCode: "80331", country: "Germany" }, contact: { id: CON, name: "Tax Tester" }, quantity: 1, unitPrice: null, effectiveDate: "2026-10-08", ...extra });
const check = (v: ReturnType<typeof V>, id: string) => v.checks.find(c => c.id === id)?.status;

test("tax treatment resolution: the actual treatment with policy, engine, tax code and flags", () => {
  const v = V();
  assert.equal(v.status, "READY");
  assert.deepEqual(v.treatment, { treatmentId: TREAT, treatmentName: "Desktop Germany Tax Treatment", policyId: POL, policySelection: "Default", engineId: ENG, taxCode: "DE_VAT_19", isTaxable: true, shouldUseTaxTreatmentItems: true, legalEntityId: LE, itemId: ITEM });
  assert.deepEqual([v.unitPrice, v.unitPriceSource], [1149, "standard price"], "unit price from the Standard Price Book, stated");
  assert.deepEqual(v.inputs, { Country: "DE", State: "Bavaria", City: "München", ZipCode: "80331", ProductCode: "DS001", StartDate: "2026-10-08", EndDate: "2026-10-08", RateUsageType: "RevCloud", LegalEntityId: LE, TaxCode: "DE_VAT_19" } satisfies TaxInputs);
  assert.deepEqual([v.expected?.taxAmount, v.expected?.label], [218.31, REFERENCE_LABEL]);
});

test("missing TaxTreatment → NOT_READY (CONFIGURATION_NOT_READY)", () => {
  const v = V({ noTreatment: true });
  assert.deepEqual([v.status, v.reason, check(v, "tax-treatment")], ["NOT_READY", "CONFIGURATION_NOT_READY", "FAIL"]);
});

test("ambiguous treatment → NOT_READY · AMBIGUOUS_TAX_TREATMENT (stop and ask); no order; a selection isn't accepted for Calculate", async () => {
  const v = V({ ambiguous: true });
  assert.deepEqual([v.status, v.reason], ["NOT_READY", "AMBIGUOUS_TAX_TREATMENT"]);
  assert.match(v.checks.find(c => c.id === "tax-treatment")!.detail, /Select the treatment/);
  const f = fake({ rd: { ambiguous: true } });
  const r = await calculateSalesforceTax(f.api, { ...prepare, confirm: "create-order" });
  assert.deepEqual([r.status, r.reason], ["NOT_READY", "AMBIGUOUS_TAX_TREATMENT"]);
  assert.ok(!f.calls.includes("startRun"));
  await assert.rejects(calculateSalesforceTax(fake().api, { ...prepare, treatmentId: TREAT }), /Validate and Preview only/);
});

test("engine resolution: Active · RevenueStandardTax · DecisionTableId read from Salesforce; missing engine / DecisionTableId → NOT_READY", () => {
  const v = V();
  assert.deepEqual(v.engine, { id: ENG, name: "Desktop Germany Tax Engine", status: "Active", type: "RevenueStandardTax", decisionTableId: DT });
  assert.deepEqual([check(v, "tax-engine"), check(v, "tax-engine-type"), check(v, "tax-engine-table")], ["PASS", "PASS", "PASS"]);
  const noEngine = V({ noEngine: true });
  assert.deepEqual([noEngine.status, check(noEngine, "tax-engine")], ["NOT_READY", "FAIL"]);
  const noTable = V({ noTable: true });
  assert.deepEqual([noTable.status, check(noTable, "tax-engine-table")], ["NOT_READY", "FAIL"]);
  assert.match(noTable.checks.find(c => c.id === "tax-engine-table")!.detail, /no DecisionTableId/);
});

test("decision table validation: Active, UsageType, SourceObject, refresh, inputs, outputs; missing / inactive table → NOT_READY", () => {
  const v = V();
  for (const id of ["decision-table", "decision-table-usage", "decision-table-source", "decision-table-inputs", "decision-table-outputs", "decision-table-refresh"]) assert.equal(check(v, id), "PASS", id);
  assert.deepEqual(v.decisionTable?.inputs, ALL_INPUTS);
  const inactive = V({ inactiveTable: true });
  assert.deepEqual([inactive.status, check(inactive, "decision-table")], ["NOT_READY", "FAIL"]);
  const missing = V({ noTable: true });
  assert.equal(missing.decisionTable, null);
  assert.equal(missing.status, "NOT_READY");
});

test("stale decision table → NOT_READY · DECISION_TABLE_STALE with the manual Lookup Tables refresh (no API refresh)", () => {
  const v = V({ stale: true });
  assert.deepEqual([v.status, v.reason, check(v, "decision-table-refresh")], ["NOT_READY", "DECISION_TABLE_STALE", "FAIL"]);
  assert.match(v.message, /App Launcher → Lookup Tables → Revenue Standard Tax Entries with Tax Code → Refresh/);
});

test("rate resolution: the matching TaxRate; missing TaxRate → NOT_READY", () => {
  const v = V();
  assert.deepEqual(v.rate, { id: RATE, name: "TR-00000014", taxCode: "DE_VAT_19", rate: 19, applicationBasis: "Net", usage: "RevCloud", start: "2026-10-08", end: null });
  const none = V({ noRate: true });
  assert.deepEqual([none.status, check(none, "tax-rate")], ["NOT_READY", "FAIL"]);
  assert.equal(none.expected, null, "no reference amount without a rate");
});

test("validation never silently assumes: no account → ACCOUNT_REQUIRED (config ready); missing contact, price, quantity → FAIL", () => {
  const noAcc = V({}, { account: null, contact: null, geography: { country: "Germany", state: null, city: null, postalCode: null } });
  assert.deepEqual([noAcc.status, noAcc.reason, noAcc.configurationReady], ["NOT_READY", "ACCOUNT_REQUIRED", true]);
  assert.equal(check(noAcc, "state"), "WARN", "a missing state is stated, not assumed");
  assert.equal(check(V({}, { contact: null }), "billing-account"), "FAIL");
  assert.equal(check(V({}, { quantity: 0 }), "quantity"), "FAIL");
  const r = readinessFixture(); (r as { listPrice: number | null }).listPrice = null;
  assert.equal(evaluateCalculationValidation(r, { account: null, contact: null, quantity: 1, unitPrice: null, effectiveDate: "2026-10-08" }).checks.find(c => c.id === "unit-price")?.status, "FAIL");
  assert.match(V().checks.find(c => c.id === "rate-usage-type")!.detail, /stated, not read/);
});

/* ═════════════ Preview (Salesforce decision-table evaluation) ═════════════ */

test("preview: conditions use the table's inputs with ISO dates and operators; blank inputs are omitted", () => {
  const c = previewConditions({ Country: "DE", State: null, City: "München", ZipCode: null, ProductCode: "DS001", StartDate: "2026-10-08", EndDate: "2026-10-08", RateUsageType: "RevCloud", LegalEntityId: LE, TaxCode: "DE_VAT_19" }, ALL_INPUTS.map(field => ({ field, operator: null })));
  assert.deepEqual(c.find(x => x.fieldName === "StartDate"), { fieldName: "StartDate", value: "2026-10-08T00:00:00.000Z", operator: "GreaterOrEqual" });
  assert.deepEqual(c.find(x => x.fieldName === "EndDate")?.operator, "LessOrEqual");
  assert.ok(!c.some(x => x.fieldName === "State" || x.fieldName === "ZipCode"));
});

test("preview: Salesforce's p10 response → matched 19% Net priority 1, labelled as a preview; errors kept verbatim", async () => {
  const m = parsePreview({ status: 201, json: PREVIEW_MATCH_JSON }, { decisionTableId: DT, decisionTableName: "RevenueStandardTaxWithTaxCode", conditions: [], taxRate: { id: RATE, name: "TR-00000014", taxCode: "DE_VAT_19", rate: 19 } });
  assert.deepEqual([m.label, m.matched, m.outcomeType, m.rate, m.applicationBasis, m.priority, m.consistent], [PREVIEW_LABEL, true, "Single Match", 19, "Net", 1, true]);
  const nm = parsePreview({ status: 201, json: PREVIEW_NOMATCH_JSON }, { decisionTableId: DT, decisionTableName: null, conditions: [], taxRate: null });
  assert.deepEqual([nm.matched, nm.outcomeType], [false, "No Match"]);
  const err = parsePreview({ status: 500, json: [{ errorCode: "UNKNOWN_EXCEPTION", message: "An unexpected error occurred. ErrorId 1" }] }, { decisionTableId: DT, decisionTableName: null, conditions: [], taxRate: null });
  assert.deepEqual(err.error, { status: 500, code: "UNKNOWN_EXCEPTION", message: "An unexpected error occurred. ErrorId 1" });
  const none = await previewDecisionTable({ params: async () => ALL_INPUTS.map(field => ({ field, operator: null })), evaluate: async () => { throw new Error("must not be called"); } }, { decisionTableId: DT, decisionTableName: null, inputs: { Country: null, State: null, City: null, ZipCode: null, ProductCode: null, StartDate: null, EndDate: null, RateUsageType: null, LegalEntityId: null, TaxCode: null } });
  assert.equal(none.error?.code, "NO_INPUTS");
});

test("preview action → PREVIEW_MATCH (read-only, never tax); no match → DECISION_TABLE_NO_MATCH; Salesforce error → SALESFORCE_ERROR", async () => {
  const f = fake();
  const r = await calculateSalesforceTax(f.api, { ...prepare, action: "preview" });
  assert.deepEqual([r.status, r.preview?.rate, r.preview?.applicationBasis, r.preview?.taxRate?.name, r.actual.length, r.result, r.source], ["PREVIEW_MATCH", 19, "Net", "TR-00000014", 0, null, null]);
  assert.match(r.message, /not yet an invoice-time Salesforce tax result/);
  assert.ok(!f.calls.some(c => WRITES.test(c)), "a preview writes nothing");
  const nm = await calculateSalesforceTax(fake({ preview: "nomatch" }).api, { ...prepare, action: "preview" });
  assert.deepEqual([nm.status, nm.reason], ["NOT_READY", "DECISION_TABLE_NO_MATCH"]);
  const er = await calculateSalesforceTax(fake({ preview: "error" }).api, { ...prepare, action: "preview" });
  assert.deepEqual([er.status, er.reason, er.diagnostics[0].salesforceCode, er.diagnostics[0].httpStatus], ["NOT_READY", "SALESFORCE_ERROR", "UNKNOWN_EXCEPTION", 500]);
  // without an account: preview still runs on the given country; validate is read-only too
  const g = fake();
  const noAcc = await calculateSalesforceTax(g.api, { mode: "billing", action: "preview", product: { name: "Desktop" }, country: "Germany", quantity: 1 });
  assert.equal(noAcc.status, "PREVIEW_MATCH");
  const val = await calculateSalesforceTax(g.api, { ...prepare, action: "validate" });
  assert.equal(val.status, "READY");
  assert.ok(!g.calls.some(c => WRITES.test(c)));
});

/* ═════════════ Authoritative results ═════════════ */

test("successful InvoiceLineTax → CALCULATED · source SALESFORCE with the InvoiceLineTax values (basis from the matched TaxRate)", async () => {
  const f = fake({ startStage: 2, invoiceAfterGen: invoice({}, [line({ taxStatus: "Estimated", taxAmount: 218.31, taxes: [ilt(218.31)] })]) });
  const r = await calculateSalesforceTax(f.api, { orderId: ORDER, confirm: "generate-invoice", waitMs: 0 });
  assert.deepEqual(r.result, { status: "CALCULATED", source: "SALESFORCE", invoiceId: INV, invoiceNumber: "DOC-000000020", invoiceLineId: LINE, invoiceLineTaxId: ILT, taxAmount: 218.31, taxRate: 19, taxCode: "DE_VAT_19", applicationBasis: "Net", applicationBasisSource: "TaxRate" });
});

test("REGRESSION (p10 DOC-000000011 / DOC-000000012): invoice generated + line TaxAmount 0 + InvoiceLineTax 0 → CALCULATION_FAILED · INVOICE_TIME_TAX_NOT_APPLIED", async () => {
  const f = fake({ startStage: 2, invoiceAfterGen: zeroTaxInvoice() });
  const r = await calculateSalesforceTax(f.api, { orderId: ORDER, confirm: "generate-invoice", waitMs: 0 });
  assert.equal(r.status, "CALCULATION_FAILED");
  assert.equal(r.reason, "INVOICE_TIME_TAX_NOT_APPLIED");
  assert.notEqual(r.status, "CALCULATED");
  assert.deepEqual([r.result, r.actual.length, r.source], [null, 0, null], "no actual tax — the expected amount is not substituted");
  assert.equal(r.expected?.taxAmount, 218.31, "the reference stays a reference");
  assert.ok(r.message.startsWith(NO_INVOICE_LINE_TAX));
  const e = r.evidence!;
  assert.deepEqual([e.invoiceId, e.invoiceLineId, e.taxTreatmentId, e.taxEngineId, e.decisionTableId, e.invoiceTaxAmount, e.invoiceLineTaxAmount, e.invoiceLineTaxCount, e.errorLogCount], [INV, LINE, TREAT, ENG, DT, 0, 0, 0, 0]);
  assert.deepEqual([e.preview?.matched, e.preview?.rate, e.preview?.label], [true, 19, PREVIEW_LABEL], "decision-table match ≠ Salesforce invoice tax");
  // the same invoice read later (read-only) → the same classification, and Salesforce is never asked to calculate
  const g = fake({ invoiceSeq: [zeroTaxInvoice()] });
  const read = await calculateSalesforceTax(g.api, { mode: "invoice", invoiceNumber: "DOC-000000020", readOnly: true });
  assert.deepEqual([read.status, read.reason], ["CALCULATION_FAILED", "INVOICE_TIME_TAX_NOT_APPLIED"]);
  assert.ok(!g.calls.includes("calculateInvoiceTax"));
});

test("evidence that can't be read is reported (never swallowed) and the failure classification stands", async () => {
  const f = fake({ startStage: 2, invoiceAfterGen: zeroTaxInvoice(), evidenceError: true });
  const r = await calculateSalesforceTax(f.api, { orderId: ORDER, confirm: "generate-invoice", waitMs: 0 });
  assert.deepEqual([r.status, r.reason, r.evidence], ["CALCULATION_FAILED", "INVOICE_TIME_TAX_NOT_APPLIED", null]);
  assert.ok(r.diagnostics.some(d => /INSUFFICIENT_ACCESS: InvoiceAddressGroup/.test(d.explanation)));
});

test("invoice by document number: read-only lookup; unknown number → clear error", async () => {
  const f = fake({ invoiceSeq: [invoice({}, [line({ taxStatus: "Pending" })])] });
  const r = await calculateSalesforceTax(f.api, { mode: "invoice", invoiceNumber: "DOC-000000020", readOnly: true, waitMs: 0 });
  assert.ok(f.calls.includes("findInvoice:DOC-000000020"));
  assert.ok(!f.calls.includes("calculateInvoiceTax"), "read-only never asks Salesforce to calculate");
  assert.equal(r.invoiceId, INV);
  await assert.rejects(calculateSalesforceTax(f.api, { mode: "invoice", invoiceNumber: "DOC-404" }), /doesn't exist/);
});

test("explicit confirmation: validate/preview/prepare never write; each billable step needs its own confirmation", async () => {
  const f = fake();
  for (const action of ["validate", "preview"] as const) await calculateSalesforceTax(f.api, { ...prepare, action });
  await calculateSalesforceTax(f.api, prepare);
  assert.ok(!f.calls.some(c => WRITES.test(c)), `no write: ${f.calls.join(",")}`);
  await calculateSalesforceTax(f.api, { ...prepare, confirm: "create-order" });
  for (const step of ["activate", "schedules"] as const) await calculateSalesforceTax(f.api, { orderId: ORDER, confirm: step });
  assert.deepEqual(f.calls.filter(c => WRITES.test(c)), ["startRun", "advance:activate:activate", "advance:schedules:schedules"], "exactly one billable step per confirmation");
  assert.ok(!f.calls.includes("generateInvoice"));
});

/* ═════════════ Natural language ═════════════ */

test("14. natural-language calculation commands route to the deterministic Tax Calculation service (never CREATE)", () => {
  const cases: [string, Partial<ReturnType<typeof parseTaxQuery> & object>][] = [
    ["Calculate tax for Desktop for OmniCloud Tax Test DE GmbH.", { kind: "salesforce-calculate", product: "Desktop", account: "OmniCloud Tax Test DE GmbH" }],
    ["Preview tax for Desktop DS001 at 1149 for Germany.", { kind: "salesforce-preview", product: "Desktop", productCode: "DS001", unitPrice: 1149, country: "Germany", account: null }],
    ["Calculate German VAT for Desktop quantity 1.", { kind: "salesforce-calculate", product: "Desktop", quantity: 1, country: "Germany", account: null }],
    ["Show me the Salesforce tax result for invoice DOC-000000012.", { kind: "invoice-result", invoiceNumber: "DOC-000000012" }],
    ["Explain why tax was not calculated for invoice DOC-000000012.", { kind: "invoice-explain", invoiceNumber: "DOC-000000012" }],
    ["Calculate the actual Salesforce tax for Desktop for Account XYZ.", { kind: "salesforce-calculate", product: "Desktop", account: "XYZ" }],
    ["Run a real Salesforce tax calculation for Desktop.", { kind: "salesforce-calculate", product: "Desktop", account: null }],
    ["Calculate tax for Desktop for quantity 2 in Bavaria, Germany.", { kind: "salesforce-calculate", product: "Desktop", quantity: 2, country: "Germany", state: "Bavaria", account: null }],
  ];
  for (const [p, want] of cases) {
    const q = parseTaxQuery(p)!;
    for (const [k, v] of Object.entries(want)) assert.deepEqual(q[k as keyof typeof q], v, `${p} → ${k}`);
  }
  assert.equal(parseTaxQuery("Create a GST18 tax rate for Desktop."), null, "never CREATE");
});

test("validation: a taxable treatment without a Legal Entity FAILS (same rule as the activation gate; p10 DOC-11/12/15/16 vs DOC-13/17)", () => {
  const v = evaluateCalculationValidation(readinessFixture({ noTreatmentLe: true }), { account: null, contact: null, quantity: 1, unitPrice: 1149, effectiveDate: "2026-10-08", geography: { country: "DE", state: "Bavaria", city: null, postalCode: null } });
  const c = v.checks.find(x => x.id === "tax-treatment-legal-entity");
  assert.equal(c?.status, "FAIL");
  assert.equal(v.configurationReady, false);
});
