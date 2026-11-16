/**
 * Error-to-resolution across product, tax, billing and order stages — MOCKED / PURE. Facts are in-memory shapes; Salesforce writes are
 * fakes. These tests prove the decision logic and the approval/verification contract, not a real Salesforce transaction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCalculationPlan, type PlanFacts, type PlanRequest } from "@/lib/tax/server/calculationPlan";
import { groupsOf, remediate, type RemediationApi, type StepAction, type TaxDiagnosticItem } from "@/lib/tax/server/remediation";
import { allowlistIssues } from "@/lib/tax/server/recordWrites";
import { buildOrderDiagnostics, type OrderDiagnosticFacts } from "@/lib/tax/server/orderDiagnostics";
import type { AssistantPreview } from "@/lib/tax/types";
import type { SfTaxResult } from "@/lib/tax/server/salesforceTaxCalculation";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const LE = "0fw000000000LE1", DT = "0lD000000000DT1", ENG = "4wA000000000EN1", STD = "01s000000000STD", PSM = "0jP000000000PS1";
const P = { id: "01t000000000WM1", name: "Wireless Mouse", code: "WIRELESS_MOUSE", active: true, taxPolicyId: null as string | null };
const IN_AP: PlanRequest = { account: { id: "001000000000AC1", name: "Acme India", country: "IN", state: "AP" } };

function facts(o: { product?: Partial<typeof P>; billing?: Partial<NonNullable<PlanFacts["billing"]>> | null; taxAdmin?: PlanFacts["taxAdmin"]; access?: PlanFacts["access"]; engines?: PlanFacts["snapshot"]["engines"]; policies?: PlanFacts["snapshot"]["policies"]; treatments?: PlanFacts["snapshot"]["treatments"] } = {}): PlanFacts {
  return {
    product: { ...P, ...o.product }, productMessage: null, listPrice: 25, access: o.access, taxAdmin: o.taxAdmin ?? null,
    billing: o.billing === null ? null : { productBillingPolicyId: "1BP000000000BP1", billingPolicies: [{ id: "1BP000000000BP1", name: "Billing Policy - Advance", status: "Active" }], standardPricebookId: STD,
      priceEntries: [{ id: "01u000000000PB1", unitPrice: 25, active: true, standard: true, sellingModelId: PSM, sellingModelName: "One Time" }], sellingModels: [{ id: PSM, name: "One Time", type: "OneTime" }], ...o.billing },
    snapshot: {
      policies: o.policies ?? [{ id: "1Tp000000000GST", name: "GST18 Tax Policy", status: "Active", selection: "Default", defaultTreatmentId: "1tt000000000GST", description: null, products: 2 }],
      treatments: o.treatments ?? [{ id: "1tt000000000GST", name: "GST18 Taxable", status: "Active", taxable: true, taxCode: "GST18", productCode: null, policyId: "1Tp000000000GST", engineId: ENG, legalEntityId: LE, useItems: false }],
      items: [],
      engines: o.engines ?? [{ id: ENG, name: "Revenue Standard Tax Engine", type: "RevenueStandardTax", status: "Active", provider: null, sellerCode: null, native: true, decisionTableId: DT }],
      rates: [{ id: "0xq000000000R01", name: "TR-1", taxCode: "GST18", productCode: null, rate: 18, usage: "RevCloud", country: "IN", geoCountryId: "0vf000000000IN1", legalEntityId: LE, start: "2026-01-01", end: null, effective: true, lastModified: null, state: "AP", city: null, zipCode: null, basis: "Net", priority: 1 }],
      legalEntities: [{ id: LE, name: "Default Legal Entity - US", status: "Active", country: null }],
      geoCountries: [{ id: "0vf000000000IN1", name: "India", iso: "IN" }],
    },
    geoStates: [{ id: "0yx000000000AP1", name: "Andhra Pradesh", iso: "AP", countryIso: "IN" }],
    tables: { [DT]: { id: DT, name: "RevenueStandardTaxWithTaxCode", inputs: ["Country", "State", "ProductCode", "RateUsageType", "LegalEntityId", "TaxCode"], stale: false } },
    accounts: [],
  };
}
const diag = (ds: TaxDiagnosticItem[], code: string) => ds.find(d => d.code === code)!;

/* ───────────── Missing tax policy: link existing, or create only what's missing ───────────── */

test("missing tax policy → link an existing ready policy, or create a configuration (inputs first, never invented)", () => {
  const d = diag(buildCalculationPlan(facts(), IN_AP).diagnostics, "TAX_POLICY_MISSING");
  assert.ok(d.options.some(o => o.id === "link-policy:1Tp000000000GST" && o.kind === "link"));
  const create = d.options.find(o => o.id === "create-tax-configuration")!;
  assert.deepEqual([create.supported, create.steps.length, create.inputs!.map(i => i.field)], [true, 0, ["taxCode", "rate", "basis"]], "tax code, rate and basis are asked, never assumed");
});

test("create tax configuration: Draft policy + Draft treatment + rate (config), then default + product link (link); activation/refresh follow from the regular plan", () => {
  const c = diag(buildCalculationPlan(facts(), { ...IN_AP, taxCode: "GST5", rate: 5, basis: "Net" }).diagnostics, "TAX_POLICY_MISSING").options.find(o => o.id === "create-tax-configuration")!;
  assert.deepEqual(c.steps.map(s => [s.id, s.group]), [["create-policy", "config"], ["create-treatment", "config"], ["create-rate", "config"], ["set-default", "link"], ["link-policy", "link"]]);
  assert.deepEqual(groupsOf(c), ["config", "link"]);
  assert.deepEqual(c.steps[1].operation!.fields, { Name: "Wireless Mouse GST5 Taxable · Default Legal Entity - US", TaxPolicyId: { name: "Wireless Mouse Tax Policy (GST5)" }, IsTaxable: true, TaxEngineId: { id: ENG }, LegalEntityId: { id: LE }, TaxCode: "GST5", ShouldUseTaxTreatmentItems: false });
});

test("interrupted workflow resumes: once the Draft policy and treatment exist, only the link steps remain (nothing is created twice)", () => {
  const pol = { id: "1Tp000000000NEW", name: "Wireless Mouse Tax Policy (GST5)", status: "Draft", selection: "Default", defaultTreatmentId: null, description: null, products: 0 };
  const tr = { id: "1tt000000000NEW", name: "Wireless Mouse GST5 Taxable · Default Legal Entity - US", status: "Draft", taxable: true, taxCode: "GST5", productCode: null, policyId: pol.id, engineId: ENG, legalEntityId: LE, useItems: false };
  const base = facts();
  const f2 = facts({ policies: [...base.snapshot.policies, pol], treatments: [...base.snapshot.treatments, tr] });
  f2.snapshot.rates.push({ ...f2.snapshot.rates[0], id: "0xq000000000R05", name: "TR-5", taxCode: "GST5", rate: 5, productCode: "WIRELESS_MOUSE" });
  const c = diag(buildCalculationPlan(f2, { ...IN_AP, taxCode: "GST5" }).diagnostics, "TAX_POLICY_MISSING").options.find(o => o.id === "create-tax-configuration")!;
  assert.equal(c.proposal!.find(r => r.object === "TaxRate")!.action, "reuse", "the rate created by the earlier approved step is reused");
  assert.deepEqual(c.steps.map(s => [s.id, s.recordId]), [["set-default", pol.id], ["link-policy", P.id]]);
  assert.deepEqual(c.steps[0].operation!.fields, { DefaultTaxTreatmentId: { id: tr.id } });
});

test("no usable engine: creating a tax configuration is explained as unsupported (an administrator prerequisite), not offered", () => {
  const c = diag(buildCalculationPlan(facts({ engines: [{ id: ENG, name: "E", type: "RevenueStandardTax", status: "Inactive", provider: null, sellerCode: null, native: true, decisionTableId: null }] }), IN_AP).diagnostics, "TAX_POLICY_MISSING").options.find(o => o.id === "create-tax-configuration")!;
  assert.deepEqual([c.supported, /administrator/.test(c.unsupportedReason ?? "")], [false, true]);
});

/* ───────────── Billing prerequisites ───────────── */

test("missing billing policy → link an existing Active policy (record write, verified); creation is explained, not faked", () => {
  const d = diag(buildCalculationPlan(facts({ billing: { productBillingPolicyId: null } }), IN_AP).diagnostics, "BILLING_POLICY_MISSING");
  const link = d.options[0];
  assert.deepEqual(link.steps[0].action, { kind: "record", object: "Product2", op: "update", recordId: P.id, fields: { BillingPolicyId: "1BP000000000BP1" } });
  assert.equal(d.recommendedOptionId, link.id, "exactly one Active policy → recommended");
  assert.equal(d.options.find(o => o.id === "create-billing-policy")!.supported, false);
  const two = diag(buildCalculationPlan(facts({ billing: { productBillingPolicyId: null, billingPolicies: [{ id: "1BP000000000BP1", name: "A", status: "Active" }, { id: "1BP000000000BP2", name: "B", status: "Active" }] } }), IN_AP).diagnostics, "BILLING_POLICY_MISSING");
  assert.equal(two.recommendedOptionId, null, "several valid policies → the user chooses");
  const denied = diag(buildCalculationPlan(facts({ billing: { productBillingPolicyId: null }, access: { Product2: { createable: false, updateable: true, fields: { BillingPolicyId: { createable: false, updateable: false } } } } }), IN_AP).diagnostics, "BILLING_POLICY_MISSING");
  assert.equal(denied.options[0].supported, false);
});

test("missing price → a standard price with the product's selling model (price asked when unknown); no selling model → explained", () => {
  const ask = diag(buildCalculationPlan({ ...facts({ billing: { priceEntries: [] } }), listPrice: null }, IN_AP).diagnostics, "PRICE_MISSING").options[0];
  assert.deepEqual([ask.steps.length, ask.inputs!.map(i => i.field)], [0, ["unitPrice"]]);
  const go = diag(buildCalculationPlan(facts({ billing: { priceEntries: [] } }), { ...IN_AP, unitPrice: 30 }).diagnostics, "PRICE_MISSING").options[0];
  assert.deepEqual(go.steps[0].action, { kind: "record", object: "PricebookEntry", op: "create", fields: { Pricebook2Id: STD, Product2Id: P.id, UnitPrice: 30, IsActive: true, ProductSellingModelId: PSM } });
  const noModel = diag(buildCalculationPlan(facts({ billing: { priceEntries: [], sellingModels: [] } }), IN_AP).diagnostics, "PRICE_MISSING").options[0];
  assert.deepEqual([noModel.supported, /selling model/.test(noModel.unsupportedReason!)], [false, true]);
  const noPsm = diag(buildCalculationPlan(facts({ billing: { priceEntries: [{ id: "01u000000000PB2", unitPrice: 40, active: true, standard: true, sellingModelId: null, sellingModelName: null }] } }), IN_AP).diagnostics, "PRICE_SELLING_MODEL_MISSING").options[0];
  assert.equal((noPsm.steps[0].action as Extract<StepAction, { kind: "record" }>).fields.UnitPrice, 40, "the existing price is reused for the new selling-model entry");
});

test("unreadable billing configuration is a warning ('couldn't be read'), never 'missing'", () => {
  const ds = buildCalculationPlan(facts({ billing: { unreadable: "INSUFFICIENT_ACCESS on BillingPolicy" } }), IN_AP).diagnostics;
  assert.ok(diag(ds, "BILLING_CONFIG_UNREADABLE"));
  assert.ok(!ds.some(d => d.code === "BILLING_POLICY_MISSING" || d.code === "PRICE_MISSING"));
});

/* ───────────── Permissions and engines ───────────── */

test("Tax Admin missing → self-assignment (own approval group) only when allowed; otherwise the exact admin instruction", () => {
  const can = diag(buildCalculationPlan(facts({ taxAdmin: { status: "missing", canAssign: true, message: "missing", adminInstruction: null } }), IN_AP).diagnostics, "TAX_ADMIN_MISSING");
  assert.deepEqual([can.options[0].steps[0].group, can.options[0].steps[0].action], ["permission", { kind: "tax-admin" }]);
  const cannot = diag(buildCalculationPlan(facts({ taxAdmin: { status: "missing", canAssign: false, message: "missing", adminInstruction: "Ask an admin to assign Tax Admin to rr@p10.com." } }), IN_AP).diagnostics, "TAX_ADMIN_MISSING");
  assert.deepEqual([cannot.options[0].supported, cannot.options[0].unsupportedReason], [false, "Ask an admin to assign Tax Admin to rr@p10.com."]);
});

test("inactive engine on an otherwise complete Active treatment → activate the engine (recommended), no replacement needed", () => {
  const p2 = { ...P, taxPolicyId: "1Tp000000000GST" };
  const ds = buildCalculationPlan(facts({ product: p2, engines: [{ id: ENG, name: "Revenue Standard Tax Engine", type: "RevenueStandardTax", status: "Inactive", provider: null, sellerCode: null, native: true, decisionTableId: DT }] }), IN_AP).diagnostics;
  const d = diag(ds, "TREATMENT_LOCKED_NEEDS_REPLACEMENT");
  assert.equal(d.recommendedOptionId, `activate-engine:${ENG}`);
  assert.deepEqual(d.options[0].steps.map(s => [s.group, s.operation!.op, s.recordId]), [["activation", "activate", ENG]]);
});

/* ───────────── Allowlisted record writes ───────────── */

test("record writes are allowlisted: other objects/fields, malformed Ids and negative prices are refused before any call", () => {
  assert.deepEqual(allowlistIssues({ kind: "record", object: "Product2", op: "update", recordId: P.id, fields: { BillingPolicyId: "1BP000000000BP1" } }), []);
  assert.match(allowlistIssues({ kind: "record", object: "Product2", op: "update", recordId: P.id, fields: { Name: "x" } })[0], /isn't a field this workflow writes/);
  assert.match(allowlistIssues({ kind: "record", object: "Product2", op: "create", fields: {} })[0], /isn't an operation/);
  assert.match(allowlistIssues({ kind: "record", object: "PricebookEntry", op: "create", fields: { UnitPrice: -1 } })[0], /≥ 0/);
  assert.match(allowlistIssues({ kind: "record", object: "Order", op: "update", recordId: "bad", fields: { BillingCountry: "IN" } })[0], /isn't identified/);
});

/* ───────────── Existing orders ───────────── */

type Billing = OrderDiagnosticFacts["billing"];
const item = (o: Partial<Billing["items"][number]> = {}) => ({ id: "802000000000IT1", product: { id: P.id, name: "Wireless Mouse", code: "WIRELESS_MOUSE" }, pendingActions: [], issues: [], tax: { state: "set", current: { id: "1tt1", name: "T" }, expected: { id: "1tt1", name: "T" }, effective: { treatmentId: "1tt1", taxable: true, engineId: ENG, decisionTable: null, taxCode: "GST18" }, issues: [] }, ...o }) as unknown as Billing["items"][number];
const order = (o: Partial<Billing["order"]> = {}, items = [item()]): Billing => ({ order: { id: "801000000000OR1", number: "00000200", name: null, status: "Draft", activated: false, account: { id: "001000000000AC1", name: "Acme India" }, effectiveDate: null, currency: null, totalAmount: 25, salesforceUrl: "", lastModifiedDate: null, billToContact: null, billToSupported: true,
  billingAddress: { street: "1 Main", city: "Vijayawada", state: "AP", postalCode: "520002", country: "IN" }, shippingAddress: { street: "1 Main", city: "Vijayawada", state: "AP", postalCode: "520002", country: "IN" }, ...o }, items, readiness: { ready: true, checks: [], blockers: [], blockerDetails: [], taxStatus: "READY" } }) as unknown as Billing;
const geo = { countries: [{ iso: "IN", name: "India" }], states: [{ iso: "AP", name: "Andhra Pradesh", countryIso: "IN" }] };
const od = (b: Billing, extra: Partial<OrderDiagnosticFacts> = {}) => buildOrderDiagnostics({ billing: b, result: null, geo, ...extra }).diagnostics;

test("Draft order with pending billing setup → the existing setup service as one approved action", () => {
  const d = diag(od(order({}, [item({ pendingActions: ["order-action", "billing-treatment"] })])), "ORDER_BILLING_SETUP_PENDING");
  assert.deepEqual(d.options[0].steps[0].action, { kind: "order-setup", orderId: "801000000000OR1", operations: ["order-action", "billing-treatment"] });
});

test("order address: missing → asked; names → ISO update on a Draft order; an activated order → replacement transaction (no fake edit)", () => {
  const miss = diag(od(order({ billingAddress: null, shippingAddress: null })), "ORDER_ADDRESS_MISSING").options[0];
  assert.deepEqual([miss.steps.length, miss.inputs!.map(i => i.field)], [0, ["addressCountry", "addressStreet", "addressCity", "addressState", "addressPostalCode"]]);
  const names = diag(od(order({ billingAddress: { street: "1", city: "V", state: "Andhra Pradesh", postalCode: "5", country: "India" }, shippingAddress: { street: "1", city: "V", state: "Andhra Pradesh", postalCode: "5", country: "India" } })), "ORDER_ADDRESS_NOT_ISO").options[0];
  assert.deepEqual((names.steps[0].action as Extract<StepAction, { kind: "record" }>).fields, { BillingCountry: "IN", ShippingCountry: "IN", BillingState: "AP", ShippingState: "AP" });
  const active = diag(od(order({ status: "Activated", activated: true, billingAddress: null, shippingAddress: null })), "ORDER_ADDRESS_MISSING").options[0];
  assert.deepEqual([active.supported, !!active.prompt], [false, true]);
});

test("order-product tax errors → plan the product's configuration in place; activated without treatment → replacement transaction", () => {
  const err = diag(od(order({}, [item({ tax: { state: "set", current: null, expected: null, effective: null, issues: [{ severity: "error", code: "MISSING_TAX_RATE", message: "no rate" }] } as never })])), "ORDER_ITEM_MISSING_TAX_RATE");
  assert.match(err.options[0].prompt!, /^Calculate tax for Wireless Mouse for Acme India/);
  const act = diag(od(order({ status: "Activated", activated: true }, [item({ tax: { state: "will-set", current: null, expected: { id: "1tt1", name: "GST18 Taxable" }, effective: { treatmentId: "1tt1", taxable: true }, issues: [] } as never })])), "ORDER_ACTIVATED_WITHOUT_TREATMENT");
  assert.deepEqual([act.options[0].supported, !!act.options[0].prompt], [false, true]);
});

test("invoice without InvoiceLineTax: a configuration change after the invoice → replacement transaction recommended; a permission failure → admin step", () => {
  const result = { status: "CALCULATION_FAILED", reason: "INVOICE_TIME_TAX_NOT_APPLIED", message: "no ILT", diagnostics: [], evidence: { traceClassification: "X", invoiceLineTaxCount: 0, errorLogCount: 0, configurationChangedAfterInvoice: { rate: "TR-21", rateChangedAt: "b", invoiceCreatedAt: "a" } },
    run: { invoice: { id: "3tt000000000IN1", number: "DOC-1" }, items: [{ product: { name: "Laptop Basic" } }] } } as unknown as SfTaxResult;
  const d = diag(od(order({ status: "Activated", activated: true }), { result }), "INVOICE_TIME_TAX_NOT_APPLIED");
  assert.deepEqual([d.recommendedOptionId, /new order and invoice use the current configuration/.test(d.options[0].rationale)], ["replacement", true]);
  const perm = { status: "CALCULATION_FAILED", message: "INSUFFICIENT_ACCESS: not authorized", diagnostics: [], run: { invoice: null, items: [] } } as unknown as SfTaxResult;
  assert.match(diag(od(order(), { result: perm }), "RUN_FAILED").options[0].label, /administrator/);
});

/* ───────────── Approval-bound execution of non-assistant actions ───────────── */

const PREVIEW = { success: true, ok: true, connection: {}, operations: [], needsSelection: false, token: "t" } as unknown as AssistantPreview;
function api(before: TaxDiagnosticItem[], after: TaxDiagnosticItem[], o: { check?: string[]; run?: { ok: boolean; message: string; permission?: boolean } } = {}) {
  const calls = { check: 0, run: 0 };
  let n = 0;
  const a: RemediationApi = {
    diagnose: async () => (n++ === 0 ? before : after), preview: async () => PREVIEW, execute: async () => { throw new Error("no assistant ops expected"); }, refresh: async () => ({ ok: true, message: "" }),
    checkAction: async () => { calls.check++; return o.check ?? []; }, runAction: async () => { calls.run++; return o.run ?? { ok: true, message: "verified" }; },
  };
  return { a, calls };
}

test("record action: preview pre-checks (blockers → not executable); approved → runs once; verified only when the re-read context no longer has it", async () => {
  const ds = buildCalculationPlan(facts({ billing: { productBillingPolicyId: null } }), IN_AP).diagnostics;
  const d = diag(ds, "BILLING_POLICY_MISSING");
  const blocked = await remediate(api(ds, ds, { check: ["Your user can't edit Product2.BillingPolicyId."] }).a, { diagnosticId: d.id, optionId: d.options[0].id });
  assert.ok(blocked.mode === "preview" && !blocked.executable && blocked.approvalToken === null);
  const pv = await remediate(api(ds, ds).a, { diagnosticId: d.id, optionId: d.options[0].id });
  assert.ok(pv.mode === "preview" && pv.approvalToken);
  if (pv.mode !== "preview") return;
  const ok = api(ds, ds.filter(x => x.id !== d.id));
  const r = await remediate(ok.a, { diagnosticId: d.id, optionId: d.options[0].id, group: pv.group, approvalToken: pv.approvalToken });
  assert.ok(r.mode === "executed" && r.resolved && r.verified);
  assert.equal(ok.calls.run, 1);
});

test("partial failure: a failed or permission-denied action stops the group, isn't marked resolved, and isn't retried", async () => {
  const ds = buildCalculationPlan(facts({ billing: { productBillingPolicyId: null } }), IN_AP).diagnostics;
  const d = diag(ds, "BILLING_POLICY_MISSING");
  const pv = await remediate(api(ds, ds).a, { diagnosticId: d.id, optionId: d.options[0].id });
  if (pv.mode !== "preview" || !pv.approvalToken) throw new Error("no preview");
  const denied = api(ds, ds, { run: { ok: false, message: "INSUFFICIENT_ACCESS on Product2", permission: true } });
  const r = await remediate(denied.a, { diagnosticId: d.id, optionId: d.options[0].id, group: pv.group, approvalToken: pv.approvalToken });
  assert.ok(r.mode === "executed" && !r.ok && !r.resolved && r.failure?.permission);
  assert.equal(denied.calls.run, 1);
});

test("guards: order context + diagnose mode in the route; actions wired to the self-validating services; follow-ups run on the same page", () => {
  const route = read("app/api/taxes/calculation/remediate/route.ts");
  assert.match(route, /if \(body\.mode === "diagnose"\)/);
  assert.match(route, /checkAction: a => checkAction\(client, a\),\s*runAction: a => runAction\(client, a\)/);
  assert.match(route, /assignTaxAdminToCurrentUser\(client\)/);
  assert.match(route, /applyOrderBillingSetup\(client, a\.orderId/);
  const create = read("components/data/billing/tax/TaxCreate.tsx");
  assert.match(create, /<OrderRemediation key=\{answer\.salesforce\.orderId\}/);
  assert.match(create, /const runPrompt = \(p: string\) => \{ setPrompt\(p\); void interpret\(p\); \};/);
});
