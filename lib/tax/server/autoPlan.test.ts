/**
 * "A blocker prepares its own resolution" — MOCKED / PURE. A calculation that hits a recoverable configuration blocker (missing tax
 * policy, NOT READY result, HTTP 4xx) leads straight to the diagnostics and a record-by-record proposal; nothing is written before the
 * user approves. No Salesforce org is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCalculationPlan, type PlanFacts, type PlanRequest } from "@/lib/tax/server/calculationPlan";
import { approvalToken, planVersion, remediate, stepsFor, type RemediationApi, type TaxDiagnosticItem } from "@/lib/tax/server/remediation";
import { answerNeedsPlan, type TaxQueryAnswer } from "@/lib/tax/server/taxQuery";
import { isRecoverableCalculationError, resultNeedsPlan } from "@/lib/tax/calcRecovery";
import type { AssistantOperation, AssistantPreview, AssistantResult } from "@/lib/tax/types";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const LE = "0fw000000000LE1", DT = "0lD000000000DT1", ENG = "4wA000000000EN1", IN = "0vf000000000IN1", AP = "0yx000000000AP1";
const WM = { id: "01t000000000WM1", name: "Wireless Mouse", code: "WM-01", active: true, taxPolicyId: null as string | null };
const IN_AP: PlanRequest = { account: { id: "001000000000AC1", name: "Acme India", country: "IN", state: "AP" } };
const rate = (o: Partial<PlanFacts["snapshot"]["rates"][number]>) => ({ id: "0xq000000000R01", name: "TR-1", taxCode: "GST18", productCode: null, rate: 18, usage: "RevCloud", country: "IN", geoCountryId: IN, legalEntityId: LE, start: "2026-01-01", end: null, effective: true, lastModified: null, state: "AP", city: null, zipCode: null, basis: "Net", priority: 1, ...o });

function facts(o: { product?: Partial<typeof WM>; rates?: PlanFacts["snapshot"]["rates"]; policies?: PlanFacts["snapshot"]["policies"]; treatments?: PlanFacts["snapshot"]["treatments"] } = {}): PlanFacts {
  return {
    product: { ...WM, ...o.product }, productMessage: null, listPrice: 25, billing: null, taxAdmin: null,
    snapshot: {
      policies: o.policies ?? [{ id: "1Tp000000000GST", name: "GST18 Tax Policy", status: "Active", selection: "Default", defaultTreatmentId: "1tt000000000GST", description: null, products: 2 }],
      treatments: o.treatments ?? [{ id: "1tt000000000GST", name: "GST18 Taxable", status: "Active", taxable: true, taxCode: "GST18", productCode: null, policyId: "1Tp000000000GST", engineId: ENG, legalEntityId: LE, useItems: false }],
      items: [],
      engines: [{ id: ENG, name: "Revenue Standard Tax Engine", type: "RevenueStandardTax", status: "Active", provider: null, sellerCode: null, native: true, decisionTableId: DT }],
      rates: o.rates ?? [rate({ productCode: "LPB-001" })],
      legalEntities: [{ id: LE, name: "Default Legal Entity - US", status: "Active", country: null }],
      geoCountries: [{ id: IN, name: "India", iso: "IN" }],
    },
    geoStates: [{ id: AP, name: "Andhra Pradesh", iso: "AP", countryIso: "IN" }],
    tables: { [DT]: { id: DT, name: "RevenueStandardTaxWithTaxCode", inputs: ["Country", "State", "ProductCode", "RateUsageType", "LegalEntityId", "TaxCode"], stale: false } },
    accounts: [],
  };
}
const policyDiag = (ds: TaxDiagnosticItem[]) => ds.find(d => d.code === "TAX_POLICY_MISSING")!;
const create = (ds: TaxDiagnosticItem[]) => policyDiag(ds).options.find(o => o.id === "create-tax-configuration")!;

test("1·3·5 missing policy → a blocker card with a full proposal immediately; unknown tax code / rate / basis are REQUIRED, never invented", () => {
  const p = buildCalculationPlan(facts(), IN_AP);
  const d = policyDiag(p.diagnostics);
  assert.deepEqual([d.title, d.severity, d.blocksCalculation], ["No applicable tax policy for Wireless Mouse", "blocker", true]);
  const c = create(p.diagnostics);
  assert.deepEqual(c.proposal!.map(r => [r.object, r.action, r.when]), [
    ["TaxPolicy", "create", "this approval"], ["TaxTreatment", "create", "this approval"], ["TaxRate", "create", "this approval"],
    ["TaxPolicy", "link", "this approval"], ["Product2", "link", "this approval"],
    ["TaxTreatment", "activate", "next approval"], ["TaxPolicy", "activate", "next approval"], ["DecisionTable", "refresh", "next approval"]]);
  const required = c.proposal!.flatMap(r => r.fields.filter(f => f.required).map(f => `${r.object}.${f.field}`));
  assert.ok(["TaxTreatment.TaxCode", "TaxRate.Rate", "TaxRate.ApplicationBasis"].every(x => required.includes(x)), required.join(", "));
  assert.ok(!required.includes("TaxPolicy.Name"), "the policy name is derived from the tax code, not asked separately");
  assert.deepEqual(c.steps, [], "no executable step while required values are missing");
  assert.deepEqual(c.inputs!.map(i => i.field), ["taxCode", "rate", "basis"]);
  const le = c.proposal![1].fields.find(f => f.field === "LegalEntityId")!;
  assert.deepEqual([le.value, le.source], ["Default Legal Entity - US", "the org's only active legal entity"], "a value resolved unambiguously shows its source");
  assert.equal(p.status, "NEEDS_INPUT");
});

test("6 an existing policy is recommended only when its applicability is VERIFIED (a rate matches this product and jurisdiction) — reused, nothing created", () => {
  const p = buildCalculationPlan(facts({ rates: [rate({ productCode: null })] }), IN_AP);
  const d = policyDiag(p.diagnostics);
  assert.equal(d.recommendedOptionId, "link-policy:1Tp000000000GST");
  assert.match(d.options[0].rationale, /^VERIFIED APPLICABLE/);
  const unverified = policyDiag(buildCalculationPlan(facts(), IN_AP).diagnostics);
  assert.match(unverified.options[0].rationale, /Applicability NOT verified/);
  assert.equal(unverified.recommendedOptionId, "create-tax-configuration");
});

test("supplied values complete the proposal; an existing matching rate is reused, not duplicated", () => {
  const c = create(buildCalculationPlan(facts(), { ...IN_AP, taxCode: "GST12", rate: 12, basis: "Net" }).diagnostics);
  assert.deepEqual(c.steps.map(s => [s.id, s.group]), [["create-policy", "config"], ["create-treatment", "config"], ["create-rate", "config"], ["set-default", "link"], ["link-policy", "link"]]);
  assert.deepEqual(c.steps[2].operation!.fields, { TaxCode: "GST12", Rate: 12, GeoCountryId: { id: IN }, GeoStateId: { id: AP }, ProductCode: "WM-01", LegalEntityId: { id: LE }, RateUsageType: "RevCloud", ApplicationBasis: "Net", StartDate: c.steps[2].operation!.fields!.StartDate });
  const reuse = create(buildCalculationPlan(facts({ rates: [rate({ productCode: null })] }), { ...IN_AP, taxCode: "GST18" }).diagnostics);
  assert.equal(reuse.proposal![2].action, "reuse");
  assert.ok(!reuse.steps.some(s => s.id === "create-rate"));
});

/* ───────────── approval-gated execution ───────────── */

const PREVIEW = { success: true, ok: true, connection: {}, operations: [], needsSelection: false, token: "t" } as unknown as AssistantPreview;
function fake(before: TaxDiagnosticItem[], after: TaxDiagnosticItem[]) {
  const calls = { preview: [] as AssistantOperation[][], execute: [] as AssistantOperation[][] };
  let n = 0;
  const api: RemediationApi = {
    diagnose: async () => (n++ === 0 ? before : after),
    preview: async ops => { calls.preview.push(ops); return PREVIEW; },
    execute: async ops => { calls.execute.push(ops); return { success: true, message: "ok", audit: [], failure: null } as unknown as AssistantResult; },
    refresh: async () => ({ ok: true, message: "" }),
  };
  return { api, calls };
}

test("4·7 preparing the proposal writes nothing; approving the config group runs exactly its 3 creations — not the link, activation or refresh", async () => {
  const ds = buildCalculationPlan(facts(), { ...IN_AP, taxCode: "GST12", rate: 12, basis: "Net" }).diagnostics;
  const d = policyDiag(ds);
  const pv = fake(ds, ds);
  const r = await remediate(pv.api, { diagnosticId: d.id, optionId: "create-tax-configuration" });
  assert.equal(pv.calls.execute.length, 0, "preview never writes");
  assert.ok(r.mode === "preview" && r.approvalToken);
  if (r.mode !== "preview") return;
  const ex = fake(ds, ds);
  await remediate(ex.api, { diagnosticId: d.id, optionId: "create-tax-configuration", group: r.group, approvalToken: r.approvalToken! });
  assert.deepEqual(ex.calls.execute.map(ops => ops.map(o => o.key)), [["create-policy", "create-treatment", "create-rate"]]);
});

test("10 a forged / stale approval for the proposal is refused without writing", async () => {
  const ds = buildCalculationPlan(facts(), { ...IN_AP, taxCode: "GST12", rate: 12, basis: "Net" }).diagnostics;
  const d = policyDiag(ds), o = create(ds);
  const changed = buildCalculationPlan(facts(), { ...IN_AP, taxCode: "GST12", rate: 15, basis: "Net" }).diagnostics;
  const token = approvalToken(planVersion(ds), d.id, o.id, "config", stepsFor(o, "config"));
  const f = fake(changed, changed);
  const r = await remediate(f.api, { diagnosticId: d.id, optionId: o.id, group: "config", approvalToken: token });
  assert.equal(r.mode, "stale", "the rate changed (12 → 15) after the approval — the old approval doesn't cover it");
  assert.equal(f.calls.execute.length, 0);
});

test("8·11 after the link is verified the re-check keeps the context and surfaces the next blockers (activation, refresh) — no need to restart", () => {
  const pol = { id: "1Tp000000000NEW", name: "Wireless Mouse Tax Policy (GST12)", status: "Draft", selection: "Default", defaultTreatmentId: "1tt000000000NEW", description: null, products: 1 };
  const tr = { id: "1tt000000000NEW", name: "Wireless Mouse GST12 Taxable · Default Legal Entity - US", status: "Draft", taxable: true, taxCode: "GST12", productCode: null, policyId: pol.id, engineId: ENG, legalEntityId: LE, useItems: false };
  const base = facts();
  const after = buildCalculationPlan({ ...facts({ product: { taxPolicyId: pol.id }, policies: [...base.snapshot.policies, pol], treatments: [...base.snapshot.treatments, tr], rates: [rate({ productCode: "LPB-001" }), rate({ id: "0xq00000000NEW1", name: "TR-NEW", taxCode: "GST12", rate: 12, productCode: "WM-01", lastModified: "2026-10-13T10:00:00Z" })] }), tables: { [DT]: { ...base.tables[DT], stale: true } } }, IN_AP);
  assert.ok(!after.diagnostics.some(x => x.code === "TAX_POLICY_MISSING"), "the policy blocker is gone once Salesforce shows the link");
  assert.deepEqual(after.diagnostics.map(x => x.code), ["TREATMENT_NOT_ACTIVE", "POLICY_NOT_ACTIVE", "DECISION_TABLE_REFRESH_REQUIRED"]);
  assert.equal(after.product?.id, WM.id);
});

/* ───────────── automatic engagement (no "build a plan" click) and 4xx handling ───────────── */

const q = { kind: "readiness", product: "Wireless Mouse", productCode: null, quantity: null, unitPrice: null, country: null, state: null, account: null, invoiceNumber: null, noMutation: false } as const;
test("2 every product answer that is blocked gets the plan automatically; ready answers and product-less answers don't", () => {
  assert.equal(answerNeedsPlan({ kind: "readiness", query: q, readiness: { status: "BLOCKED" }, invoiceTax: null, message: "" } as unknown as TaxQueryAnswer), true);
  assert.equal(answerNeedsPlan({ kind: "readiness", query: q, readiness: { status: "READY" }, invoiceTax: null, message: "" } as unknown as TaxQueryAnswer), false);
  assert.equal(answerNeedsPlan({ kind: "salesforce-preview", query: { ...q, kind: "salesforce-preview" }, salesforce: { status: "NOT_READY" }, message: "" } as unknown as TaxQueryAnswer), true);
  assert.equal(answerNeedsPlan({ kind: "readiness", query: { ...q, product: null }, readiness: { status: "BLOCKED" }, invoiceTax: null, message: "" } as unknown as TaxQueryAnswer), false);
  assert.match(read("lib/tax/server/taxQuery.ts"), /if \(!answerNeedsPlan\(a\)\) return a;[\s\S]*planTaxCalculation\(client,/);
});

test("9 HTTP 422/400/404/409 configuration errors are recoverable (→ the plan); 401/403/permission/5xx/AI-key errors stay fatal", () => {
  for (const s of [400, 404, 409, 422]) assert.equal(isRecoverableCalculationError(s, "INVALID_REQUEST"), true, String(s));
  for (const [s, c] of [[401, "TOKEN_EXPIRED"], [403, "FORBIDDEN"], [422, "INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY"], [500, null], [503, "NO_AI_KEY"], [429, "REQUEST_LIMIT_EXCEEDED"]] as const) assert.equal(isRecoverableCalculationError(s, c), false, `${s} ${c}`);
  assert.equal(resultNeedsPlan({ status: "NOT_READY" }), true);
  assert.equal(resultNeedsPlan({ status: "CALCULATION_FAILED", invoiceId: "3tt000000000001" }), false, "an invoice result is diagnosed by the order/invoice view, not re-planned");
  const panel = read("components/data/taxes/SalesforceTaxPanel.tsx");
  assert.match(panel, /err instanceof QuoteApiError && isRecoverableCalculationError\(err\.status, err\.code\)/);
  assert.match(panel, /if \(recover\) await preparePlan\(recover\);/);
  assert.match(panel, /"\/api\/taxes\/calculation\/plan"/, "the plan is read-only (the plan route) — no write is triggered by a failure");
  assert.match(read("components/data/taxes/RemediationPanel.tsx"), /REQUIRED — not supplied/);
});
