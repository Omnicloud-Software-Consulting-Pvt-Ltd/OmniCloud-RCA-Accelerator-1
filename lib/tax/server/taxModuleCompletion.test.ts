/**
 * Tax module completion (2026-10-13, round 2) — MOCKED / PURE. No test touches a Salesforce org: the AI is a fake function, Salesforce
 * results are in-memory shapes. Real-org evidence remains the E1-B / E1c / E2 / E1R runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerTaxQuery, explainOrder, parseTaxQuery, type TaxQuery } from "@/lib/tax/server/taxQuery";
import { groundValue, mergeAiInterpretation, resolveCalculationQuery } from "@/lib/tax/server/calculationAi";
import { taxPolicyIssues, taxTreatmentIssues } from "@/lib/billing/server/rules";
import { buildCalculationPlan } from "@/lib/tax/server/calculationPlan";
import { deriveSalesforceTax, lineTotalWithTax, type TaxInvoice } from "@/lib/tax/server/invoiceTax";
import type { SfTaxResult } from "@/lib/tax/server/salesforceTaxCalculation";
import type { SalesforceClient } from "@/lib/salesforce/client";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/* ───────────── 1. Order / invoice / decision-table prompts ───────────── */

test("parse: an order by number → order-result (no product, never an account); 'why … this order' → order-explain without guessing a number", () => {
  const q = parseTaxQuery("Calculate tax for the product in order 00000141 and show the tax amount and total including tax.")!;
  assert.deepEqual([q.kind, q.orderNumber, q.product, q.account], ["order-result", "00000141", null, null]);
  const w = parseTaxQuery("Why was tax not applied to this order?")!;
  assert.deepEqual([w.kind, w.orderNumber, w.orderId], ["order-explain", null, null]);
  assert.deepEqual([parseTaxQuery("Why was tax not applied to order 141?")!.kind, parseTaxQuery("Why was tax not applied to order 141?")!.orderNumber], ["order-explain", "141"]);
  const id = parseTaxQuery("Show the tax for order 801g8000011Ro2rAAC")!;
  assert.deepEqual([id.kind, id.orderId], ["order-result", "801g8000011Ro2rAAC"]);
});

test("parse: 'this invoice' → invoice-result without a number; decision-table freshness; 'what is missing' → inspect (configure intent)", () => {
  const i = parseTaxQuery("Calculate tax for this invoice and show the tax code, rate, taxable amount, tax amount and total including tax.")!;
  assert.deepEqual([i.kind, i.invoiceNumber], ["invoice-result", null]);
  assert.equal(parseTaxQuery("Check whether the configured decision table contains the latest applicable tax rate.")!.kind, "decision-table");
  const m = parseTaxQuery("Inspect the existing tax configuration for Mouse and tell me what is missing before calculating tax.")!;
  assert.deepEqual([m.kind, m.intent, m.product], ["salesforce-calculate", "configure", "Mouse"]);
  assert.equal(parseTaxQuery("Show me the complete configuration of 'Cloud Storage India GST Policy'."), null, "a 'show configuration' request stays with the configuration assistant");
});

test("answers: an order / invoice request without a reference asks which one (no Salesforce call, nothing guessed)", async () => {
  const none = {} as SalesforceClient;
  const o = await answerTaxQuery(none, parseTaxQuery("Why was tax not applied to this order?")!);
  assert.deepEqual([o.kind, o.kind === "needs-input" && o.field], ["needs-input", "order"]);
  const i = await answerTaxQuery(none, parseTaxQuery("Show the tax for this invoice")!);
  assert.deepEqual([i.kind, i.kind === "needs-input" && i.field], ["needs-input", "invoice"]);
});

test("explainOrder: a not-yet-invoiced order explains where it stands, what blocks it, and the next confirmed step", () => {
  const r = { status: "AWAITING_CONFIRMATION", message: "", orderId: "801x", awaiting: { step: "activate", detail: "Activate order 00000150." }, actual: [], evidence: null,
    run: { order: { id: "801x", number: "00000150", status: "Draft", account: null, total: 10, activated: false, legalEntity: null }, items: [{ id: "802x", product: { id: "01t", name: "Widget", code: "W1" }, quantity: 1, unitPrice: 10, total: 10, taxPolicy: null, treatment: null }],
      schedules: [], invoice: null, steps: [], checks: [{ id: "rate", label: "Tax rate", passed: false, detail: "no rate matches" }], taxCalculation: "PENDING" } } as unknown as SfTaxResult;
  const m = explainOrder(r);
  assert.match(m, /Order 00000150 is Draft and has no invoice yet/);
  assert.match(m, /Tax rate: no rate matches/);
  assert.match(m, /Widget has no Tax Treatment on the order product/);
  assert.match(m, /Next step \(needs your confirmation\): Activate order 00000150/);
});

/* ───────────── 2. AI interpretation: grounded values only ───────────── */

const PROMPT = "Calculate tax for Widget Pro sold to Acme Ltd in Ontario, Canada at 13% under tax code HST13, quantity 2 at 1,149";

test("AI grounding: values the user didn't write are dropped (no invented code, rate, Id or account); written values are kept", () => {
  const r = mergeAiInterpretation(PROMPT, { route: "calculation", intent: "calculate-product", product: "Widget Pro", account: "Acme Ltd", country: "Canada", state: "Ontario", taxCode: "HST13", rate: 13, quantity: 2, unitPrice: 1149, missing: [] }, null);
  assert.deepEqual([r.query!.product, r.query!.account, r.query!.taxCode, r.query!.rate, r.query!.quantity, r.query!.unitPrice, r.dropped.length], ["Widget Pro", "Acme Ltd", "HST13", 13, 2, 1149, 0]);
  const invented = mergeAiInterpretation("Calculate tax for Widget Pro", { route: "calculation", intent: "calculate-product", product: "Widget Pro", taxCode: "GST18", rate: 18, account: "Burlington Textiles", productId: "01tg80000072GsfAAE", basis: "Net" }, null);
  assert.deepEqual([invented.query!.taxCode, invented.query!.rate, invented.query!.account, invented.query!.productId, invented.query!.basis], [null, null, null, null, null]);
  assert.equal(invented.dropped.length, 5);
});

test("AI grounding: a product is never the account; configuration requests are routed to the assistant; a JSON string answer is accepted", () => {
  const same = mergeAiInterpretation("Calculate tax for the existing Mouse product", { route: "calculation", intent: "calculate-product", product: "Mouse", account: "Mouse" }, null);
  assert.deepEqual([same.query!.product, same.query!.account], ["Mouse", null]);
  assert.equal(mergeAiInterpretation("Create a tax policy named X", { route: "configuration" }, null).query, null);
  const s = mergeAiInterpretation("Why was tax not applied to order 00000141?", "```json\n{\"route\":\"calculation\",\"intent\":\"order-explain\",\"orderNumber\":\"00000141\"}\n```", null);
  assert.deepEqual([s.query!.kind, s.query!.orderNumber, s.query!.product], ["order-explain", "00000141", null]);
  assert.deepEqual([groundValue("at 1,149", 1149).ok, groundValue("at 1149", 1150).ok, groundValue("for ACME ltd", "Acme Ltd").ok], [true, false, true]);
});

const det = (): TaxQuery => parseTaxQuery("Calculate tax for Widget Pro for Acme Ltd")!;
const classify = (e: unknown) => ({ status: (e as { status?: number }).status ?? 500, message: String((e as Error).message) });

test("AI status: no key → built-in rules with NOT_CONFIGURED (or a 503 NO_AI_KEY when the rules can't interpret it); rejected key → REJECTED; AI failure → ERROR", async () => {
  const a = await resolveCalculationQuery({ prompt: "Calculate tax for Widget Pro for Acme Ltd", det: det(), call: null, classify });
  assert.deepEqual([a.info.by, a.info.ai.status, !!a.query, a.error], ["rules", "NOT_CONFIGURED", true, undefined]);
  const b = await resolveCalculationQuery({ prompt: "something the rules don't know", det: null, call: null, classify });
  assert.deepEqual([b.query, b.error?.status, b.error?.code], [null, 503, "NO_AI_KEY"]);
  const rejected = async () => { throw Object.assign(new Error("401 invalid x-api-key"), { status: 503 }); };
  const c = await resolveCalculationQuery({ prompt: "Calculate tax for Widget Pro for Acme Ltd", det: det(), call: rejected, classify });
  assert.deepEqual([c.info.by, c.info.ai.status, !!c.query], ["rules", "REJECTED", true]);
  const d = await resolveCalculationQuery({ prompt: "unknown request", det: null, call: rejected, classify });
  assert.deepEqual([d.error?.code], ["AI_KEY_REJECTED"]);
  const e = await resolveCalculationQuery({ prompt: "Calculate tax for Widget Pro for Acme Ltd", det: det(), call: async () => "not json", classify });
  assert.deepEqual([e.info.ai.status, !!e.query], ["ERROR", true]);
  const ok = await resolveCalculationQuery({ prompt: "Calculate tax for Widget Pro for Acme Ltd", det: det(), call: async () => ({ route: "calculation", intent: "calculate-product", product: "Widget Pro", account: "Acme Ltd" }), classify });
  assert.deepEqual([ok.info.by, ok.info.ai.status, ok.query!.account], ["ai", "OK", "Acme Ltd"]);
});

/* ───────────── 3. Configuration rules on the Tax record pages ───────────── */

test("Tax Treatment rules: no return to Draft; locked fields; a taxable treatment can't be activated without a legal entity, engine and tax code", () => {
  const draftBack = taxTreatmentIssues({ mode: "update", from: "Active", to: "Draft", effective: { Status: "Draft" }, current: { Status: "Active" }, engine: null });
  assert.ok(draftBack.some(i => i.severity === "error" && /back to Draft/.test(i.message)));
  const locked = taxTreatmentIssues({ mode: "update", from: "Inactive", to: "Inactive", effective: { LegalEntityId: "0fw000000000002" }, current: { LegalEntityId: "0fw000000000001" }, engine: null });
  assert.ok(locked.some(i => i.field === "LegalEntityId" && i.severity === "error"));
  const activate = taxTreatmentIssues({ mode: "update", from: "Draft", to: "Active", effective: { IsTaxable: true, Status: "Active" }, current: { Status: "Draft" }, engine: null });
  assert.deepEqual(activate.filter(i => i.severity === "error").map(i => i.field).sort(), ["LegalEntityId", "TaxCode", "TaxEngineId"]);
  const ok = taxTreatmentIssues({ mode: "update", from: "Draft", to: "Active", effective: { IsTaxable: true, LegalEntityId: "0fw1", TaxEngineId: "4wA1", TaxCode: "X1" }, current: { Status: "Draft" }, engine: { name: "E", status: "Inactive", decisionTableId: null } });
  assert.deepEqual(ok.map(i => i.severity), ["warning"], "an inactive engine is a warning (saves, but tax won't calculate)");
  assert.deepEqual(taxTreatmentIssues({ mode: "update", from: "Draft", to: "Active", effective: { IsTaxable: false }, current: {}, engine: null }), [], "a non-taxable treatment needs none of them");
});

test("Tax Policy rules: Default selection needs an Active default treatment before activation", () => {
  assert.match(taxPolicyIssues({ activating: true, selection: "Default", defaultTreatment: null, defaultTreatmentId: null })[0].message, /needs a Default Tax Treatment/);
  assert.match(taxPolicyIssues({ activating: true, selection: "Default", defaultTreatment: { id: "1tt1", name: "T", status: "Draft" }, defaultTreatmentId: "1tt1" })[0].message, /Activate the default Tax Treatment "T" first/);
  assert.deepEqual(taxPolicyIssues({ activating: true, selection: "Default", defaultTreatment: { id: "1tt1", name: "T", status: "Active" }, defaultTreatmentId: "1tt1" }), []);
  assert.deepEqual(taxPolicyIssues({ activating: false, selection: "Default", defaultTreatment: null, defaultTreatmentId: null }), []);
});

/* ───────────── 4. Ambiguous product, totals, multiple tax lines ───────────── */

test("plan: an ambiguous product is a choice between the real Salesforce matches (never guessed)", () => {
  const p = buildCalculationPlan({ product: null, productMessage: "\"Laptop\" matches 2 active products.", productCandidates: [{ id: "01t000000000001", name: "Laptop", code: "LP001" }, { id: "01t000000000002", name: "Laptop", code: "LP002" }],
    snapshot: { policies: [], treatments: [], items: [], engines: [], rates: [], legalEntities: [], geoCountries: [] }, geoStates: [], tables: {}, accounts: [], listPrice: null }, {});
  const q = p.questions.find(x => x.field === "product")!;
  assert.deepEqual(q.options!.map(o => o.value), ["01t000000000001", "01t000000000002"]);
  assert.equal(p.status, "NEEDS_INPUT");
});

const tline = (o: Partial<TaxInvoice["lines"][number]>): TaxInvoice["lines"][number] => ({ id: "5TV1", name: "L", product: "P", productId: "01t1", quantity: 1, unitPrice: 100, charge: 100, taxAmount: 0, chargeAmountWithTax: 100, taxRate: null, taxCode: null, taxStatus: "Estimated", treatment: { id: "1tt1", name: "T" }, legalEntityId: "0fw1", adjustmentAmount: 0, adjustmentTaxAmount: 0, taxes: [], ...o });
const tax = (id: string, amount: number | null, rate = 5) => ({ id, name: null, amount, rate, code: "C", status: null, effectiveDate: null, treatment: { id: "1tt1", name: "T" }, legalEntityId: "0fw1", exemptAmount: 0 });

test("multiple tax records: line total = charge + Σ InvoiceLineTax when it agrees with InvoiceLine.TaxAmount; disagreement → unavailable; two lines → both reported", () => {
  assert.deepEqual(lineTotalWithTax(tline({ charge: 1000, taxAmount: 130, taxes: [tax("2GI1", 50), tax("2GI2", 80, 8)] })).value, 1130);
  assert.equal(lineTotalWithTax(tline({ charge: 1000, taxAmount: 130, taxes: [tax("2GI1", 50)] })).basis, "unavailable");
  const inv: TaxInvoice = { id: "3tt1", number: "DOC-X", status: "Draft", subtotal: 300, tax: 15.13, totalWithTax: 315.13, balance: null, date: null,
    lines: [tline({ id: "5TV1", charge: 100.8, taxAmount: 5.04, taxes: [tax("2GI1", 5.04)] }), tline({ id: "5TV2", charge: 201.8, taxAmount: 10.09, taxes: [tax("2GI2", 10.09)] })] };
  const d = deriveSalesforceTax(inv, [{ id: "1tt1", name: "T", taxable: true }], null);
  assert.deepEqual([d.status, d.actual.map(a => a.taxAmount)], ["CALCULATED", [5.04, 10.09]], "fractional (rounded) amounts are Salesforce's, reported exactly");
});

/* ───────────── 5. Source guards: no silent zeros / empties, no duplicate orders, UI wiring ───────────── */

test("failed reads are never empty: tax items / countries / policy counts propagate errors; the dashboard's taxed-invoice count is 'unavailable', not 0", () => {
  const rec = read("lib/tax/server/records.ts");
  assert.doesNotMatch(rec, /"TaxTreatmentItem", \[[^\]]*\], "ORDER BY CreatedDate"\)\.catch\(\(\) => \[\]\)/);
  assert.doesNotMatch(rec, /select\(client, meta, "GeoCountry", \["Name", "IsoCode"\]\)\.catch/);
  assert.doesNotMatch(rec, /GROUP BY TaxPolicyId"\)\.catch/);
  const dash = read("lib/tax/server/dashboard.ts");
  assert.match(dash, /taxedInvoices: taxed \? Number\(taxed\[0\]\?\.c\) \|\| 0 : null/);
  assert.match(read("components/data/billing/tax/TaxDashboard.tsx"), /s\.taxedInvoices === null \? "unavailable"/);
});

test("duplicate-safe order creation: the calculation panel sends one run key per calculation with 'create-order' (the run is idempotent per key)", () => {
  const panel = read("components/data/taxes/SalesforceTaxPanel.tsx");
  assert.match(panel, /confirm: step, runKey \}/);
  assert.match(read("lib/tax/server/verification.ts"), /if \(existing\) return \{ success: true as const, orderId: existing\.Id as string, orderNumber: str\(existing\.OrderNumber\), duplicate: true \}/);
});

test("UI: the Calculation tab has the natural-language prompt; answers show how they were interpreted; the result summary reads Salesforce totals", () => {
  assert.match(read("components/data/taxes/TaxesWorkspace.tsx"), /<AiPrompt isDark=\{isDark\} assistant variant="calculation"/);
  const create = read("components/data/billing/tax/TaxCreate.tsx");
  assert.match(create, /Interpreted by the AI" : "Interpreted by the built-in rules"/);
  assert.doesNotMatch(create, /Mouse|Desktop|Laptop Basic|Burlington/, "examples are placeholders, not org records");
  const panel = read("components/data/taxes/SalesforceTaxPanel.tsx");
  assert.match(panel, /Total including tax \(Invoice\.TotalAmountWithTax\)/);
  assert.doesNotMatch(panel, /ChargeAmountWithTax|TotalAmount\b(?!WithTax)/, "never the unreliable inclusive fields");
});

test("explanations: when the rate that matches today was created after the invoice, the answer says so — not 'configuration matches, ask Salesforce Support'", async () => {
  const { explainInvoice } = await import("@/lib/tax/server/taxQuery");
  const base = { status: "CALCULATION_FAILED", reason: "INVOICE_TIME_TAX_NOT_APPLIED", message: "Salesforce did not generate an InvoiceLineTax record.", actual: [] };
  const ev = { traceClassification: "INVOICE_TIME_TAX_NOT_APPLIED", invoiceTaxAmount: 0, invoiceLineTaxAmount: 0, taxProcessingStatus: "Estimated", invoiceLineTaxCount: 0, errorLogCount: 0, preview: { matched: true, outcomeType: "Single Match", rate: 18, applicationBasis: "Net" } };
  const changed = explainInvoice({ ...base, evidence: { ...ev, configurationChangedAfterInvoice: { rate: "TR-00000021", rateChangedAt: "2026-10-12T06:33:48Z", invoiceCreatedAt: "2026-10-12T06:22:00Z" } } } as unknown as SfTaxResult);
  assert.match(changed, /TR-00000021\) was created or changed at 2026-10-12T06:33:48Z, after this invoice/);
  assert.doesNotMatch(changed, /Salesforce Support/);
  const same = explainInvoice({ ...base, evidence: { ...ev, configurationChangedAfterInvoice: null } } as unknown as SfTaxResult);
  assert.match(same, /Salesforce Support investigation/);
});
