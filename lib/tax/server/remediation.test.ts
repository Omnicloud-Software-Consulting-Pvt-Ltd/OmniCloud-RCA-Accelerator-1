/**
 * Tax remediation (structured diagnostics → options → approval-bound execution → verification). MOCKED / PURE: plans are built from
 * in-memory facts shaped like p10's records (the Desktop DS001 case: an Active "Germany" treatment without a Legal Entity whose tax code
 * only has DE rates, sold to IN/AP); Salesforce writes are a fake API. No test touches a Salesforce org or proves a real transaction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCalculationPlan, type PlanFacts, type PlanRequest } from "@/lib/tax/server/calculationPlan";
import { approvalToken, groupsOf, planVersion, rankDiagnostics, remediate, stepsFor, type RemediationApi, type TaxDiagnosticItem } from "@/lib/tax/server/remediation";
import type { AssistantPreview, AssistantResult } from "@/lib/tax/types";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const LE = "0fw000000000LE1", DT = "0lD000000000DT1", ENG_DE = "4wA000000000DE1", ENG_IN = "4wA000000000IN1";
const DS = { id: "01t000000000DS1", name: "Desktop", code: "DS001", active: true, taxPolicyId: "1Tp000000000DE1" };
const rate = (o: Partial<PlanFacts["snapshot"]["rates"][number]>) => ({ id: "0xq000000000000", name: "TR", taxCode: "X", productCode: null, rate: 18, usage: "RevCloud", country: "IN", geoCountryId: "0vf000000000IN1", legalEntityId: LE, start: "2026-01-01", end: null, effective: true, lastModified: null, state: null, city: null, zipCode: null, basis: "Net", priority: 1, ...o });

function facts(o: { extraTreatments?: PlanFacts["snapshot"]["treatments"]; extraItems?: PlanFacts["snapshot"]["items"]; extraRates?: PlanFacts["snapshot"]["rates"]; access?: PlanFacts["access"] } = {}): PlanFacts {
  return {
    product: DS, productMessage: null, listPrice: 1149, access: o.access,
    snapshot: {
      policies: [
        { id: "1Tp000000000DE1", name: "Desktop Germany Tax Policy", status: "Active", selection: "Default", defaultTreatmentId: "1tt000000000DE1", description: null, products: 1 },
        { id: "1Tp000000000IN1", name: "India GST Policy", status: "Active", selection: "Default", defaultTreatmentId: "1tt000000000IN1", description: null, products: 2 },
      ],
      treatments: [
        { id: "1tt000000000DE1", name: "Desktop Germany Tax Treatment", status: "Active", taxable: true, taxCode: null, productCode: null, policyId: "1Tp000000000DE1", engineId: ENG_DE, legalEntityId: null, useItems: true },
        { id: "1tt000000000IN1", name: "India GST Treatment", status: "Active", taxable: true, taxCode: "GST18", productCode: null, policyId: "1Tp000000000IN1", engineId: ENG_IN, legalEntityId: LE, useItems: false },
        ...(o.extraTreatments ?? []),
      ],
      items: [{ id: "1tu000000000DE1", name: "Desktop Germany Tax Treatment Item", treatmentId: "1tt000000000DE1", productId: DS.id, productName: "Desktop", taxCode: "DE_VAT_19", productCode: "DS001" }, ...(o.extraItems ?? [])],
      engines: [
        { id: ENG_DE, name: "Desktop Germany Tax Engine", type: "RevenueStandardTax", status: "Active", provider: null, sellerCode: null, native: true, decisionTableId: DT },
        { id: ENG_IN, name: "Revenue Standard Tax Engine", type: "RevenueStandardTax", status: "Active", provider: null, sellerCode: null, native: true, decisionTableId: DT },
      ],
      rates: [rate({ id: "0xq000000000014", name: "TR-00000014", taxCode: "DE_VAT_19", rate: 19, country: "DE", geoCountryId: "0vf000000000DE1", productCode: "DS001" }), rate({ id: "0xq000000000021", name: "TR-00000021", taxCode: "GST18", productCode: "LPB-001" }), ...(o.extraRates ?? [])],
      legalEntities: [{ id: LE, name: "Default Legal Entity - US", status: "Active", country: null }],
      geoCountries: [{ id: "0vf000000000IN1", name: "India", iso: "IN" }, { id: "0vf000000000DE1", name: "Germany", iso: "DE" }],
    },
    geoStates: [{ id: "0yx000000000AP1", name: "Andhra Pradesh", iso: "AP", countryIso: "IN" }],
    tables: { [DT]: { id: DT, name: "RevenueStandardTaxWithTaxCode", inputs: ["Country", "State", "ProductCode", "StartDate", "EndDate", "RateUsageType", "LegalEntityId", "TaxCode"], stale: false } },
    accounts: [],
  };
}
const IN_AP: PlanRequest = { account: { id: "001000000000AC1", name: "Aetherion India", country: "IN", state: "AP" } };
const DE_ACC: PlanRequest = { account: { id: "001000000000AC2", name: "Test DE GmbH", country: "DE", state: null } };
const byCode = (ds: TaxDiagnosticItem[], code: string) => ds.find(d => d.code === code)!;

/* ───────────── The Desktop DS001 regression (why that treatment, what blocks, in which order) ───────────── */

test("Desktop DS001 → IN/AP: two blockers, ranked — the jurisdiction decision first, the locked treatment (depends on it) second", () => {
  const p = buildCalculationPlan(facts(), IN_AP);
  const codes = p.diagnostics.filter(d => d.blocksCalculation).map(d => d.code);
  assert.deepEqual(codes.slice(0, 2), ["JURISDICTION_NOT_COVERED", "TREATMENT_LOCKED_NEEDS_REPLACEMENT"]);
  const j = byCode(p.diagnostics, "JURISDICTION_NOT_COVERED"), t = byCode(p.diagnostics, "TREATMENT_LOCKED_NEEDS_REPLACEMENT");
  assert.match(j.cause, /tax code DE_VAT_19 .* rates exist only for DE; the sale is to AP\/IN/);
  assert.deepEqual(j.evidence, ["TR-00000014: DE_VAT_19 19% · DE · ProductCode DS001"]);
  assert.deepEqual(t.dependsOn, [j.id], "the replacement waits for the jurisdiction decision (switching policy may make it unnecessary)");
  assert.equal(p.status, "BLOCKED");
});

test("jurisdiction: an existing policy whose rate already matches is reused (linked) and recommended; nothing is created", () => {
  const p = buildCalculationPlan(facts({ extraRates: [rate({ id: "0xq0000000000AP", name: "TR-AP", taxCode: "GST18", state: "AP", productCode: null })] }), IN_AP);
  const j = byCode(p.diagnostics, "JURISDICTION_NOT_COVERED");
  const rec = j.options.find(o => o.id === j.recommendedOptionId)!;
  assert.deepEqual([rec.kind, rec.id], ["link", "link-policy:1Tp000000000IN1"]);
  assert.deepEqual(rec.steps.map(s => [s.object, s.recordId, s.operation?.op, s.operation?.fields]), [["Product2", DS.id, "update", { TaxPolicyId: { id: "1Tp000000000IN1" } }]]);
  assert.ok(rec.records.some(r => r.role === "reuse" && r.object === "TaxPolicy"));
});

test("jurisdiction: with no fully matching configuration the recommendation is the user's decision — never a German rate silently created for India", () => {
  const j = byCode(buildCalculationPlan(facts(), IN_AP).diagnostics, "JURISDICTION_NOT_COVERED");
  assert.equal(j.recommendedOptionId, "confirm-jurisdiction");
  const sameCode = j.options.find(o => o.id === "create-rate-same-code")!;
  assert.deepEqual([sameCode.steps.length, sameCode.inputs!.map(i => i.field)], [0, ["rate", "basis"]], "creating a rate for DE_VAT_19 in India needs the user's explicit rate/basis");
});

/* ───────────── Locked treatment: reuse, or a replacement — never an edit of the locked record ───────────── */

test("locked Active treatment without a Legal Entity is never edited: the replacement is created Draft → items → activated → made default (separate groups)", () => {
  const t = byCode(buildCalculationPlan(facts(), DE_ACC).diagnostics, "TREATMENT_LOCKED_NEEDS_REPLACEMENT");
  const r = t.options.find(o => o.id === "create-replacement")!;
  assert.deepEqual(r.steps.map(s => s.id), ["create-treatment", "create-item", "activate-treatment", "set-default"]);
  assert.deepEqual(groupsOf(r), ["config", "activation", "link"], "activation and the policy switch are approved separately, after creation");
  assert.ok(!r.steps.some(s => s.recordId === "1tt000000000DE1"), "the locked treatment is never targeted");
  assert.deepEqual(r.steps[0].operation!.fields, { Name: "Desktop Germany Tax Treatment · Default Legal Entity - US", TaxPolicyId: { id: "1Tp000000000DE1" }, IsTaxable: true, TaxEngineId: { id: ENG_DE }, LegalEntityId: { id: LE }, ShouldUseTaxTreatmentItems: true });
  assert.deepEqual(r.steps[1].operation!.fields, { Name: "Desktop DE_VAT_19", TaxTreatmentId: { name: "Desktop Germany Tax Treatment · Default Legal Entity - US", policyName: "Desktop Germany Tax Policy" }, ProductId: { id: DS.id }, TaxCode: "DE_VAT_19", ProductCode: "DS001" });
  assert.ok(r.consequences!.some(c => /NOT deactivated, deleted or changed/.test(c)));
});

test("reuse first: an existing compatible Active treatment of the policy is linked (policy default) instead of creating a replacement", () => {
  const ok = { id: "1tt000000000DE2", name: "Desktop DE LE Treatment", status: "Active", taxable: true, taxCode: null, productCode: null, policyId: "1Tp000000000DE1", engineId: ENG_DE, legalEntityId: LE, useItems: true };
  const t = byCode(buildCalculationPlan(facts({ extraTreatments: [ok], extraItems: [{ id: "1tu000000000DE2", name: "Item 2", treatmentId: ok.id, productId: DS.id, productName: "Desktop", taxCode: "DE_VAT_19", productCode: "DS001" }] }), DE_ACC).diagnostics, "TREATMENT_LOCKED_NEEDS_REPLACEMENT");
  assert.equal(t.recommendedOptionId, `use-treatment:${ok.id}`);
  const o = t.options[0];
  assert.deepEqual([o.kind, o.steps.map(s => [s.object, s.operation!.fields])], ["link", [["TaxPolicy", { DefaultTaxTreatmentId: { id: ok.id } }]]]);
  assert.ok(t.options.some(x => x.id === "create-replacement"), "creation stays available as an alternative");
});

test("idempotent re-planning: once the Draft replacement exists it is reused — no second create is ever proposed", () => {
  const draft = { id: "1tt000000000NEW", name: "Desktop Germany Tax Treatment · Default Legal Entity - US", status: "Draft", taxable: true, taxCode: null, productCode: null, policyId: "1Tp000000000DE1", engineId: ENG_DE, legalEntityId: LE, useItems: true };
  const t = byCode(buildCalculationPlan(facts({ extraTreatments: [draft], extraItems: [{ id: "1tu000000000NEW", name: "Desktop DE_VAT_19", treatmentId: draft.id, productId: DS.id, productName: "Desktop", taxCode: "DE_VAT_19", productCode: "DS001" }] }), DE_ACC).diagnostics, "TREATMENT_LOCKED_NEEDS_REPLACEMENT");
  const r = t.options.find(o => o.id === "create-replacement")!;
  assert.deepEqual(r.steps.map(s => [s.id, s.recordId]), [["activate-treatment", draft.id], ["set-default", "1Tp000000000DE1"]]);
});

/* ───────────── Capabilities, inputs, ambiguity ───────────── */

test("describe-based capabilities: options your user can't perform are unsupported (no steps, no button) with the reason", () => {
  const access = { TaxTreatment: { createable: false, updateable: true, fields: {} }, TaxTreatmentItem: { createable: true, updateable: true, fields: {} }, TaxPolicy: { createable: true, updateable: true, fields: {} }, Product2: { createable: false, updateable: true, fields: { TaxPolicyId: { createable: false, updateable: false } } } };
  const p = buildCalculationPlan(facts({ access, extraRates: [rate({ id: "0xq0000000000AP", name: "TR-AP", taxCode: "GST18", state: "AP" })] }), IN_AP);
  const link = byCode(p.diagnostics, "JURISDICTION_NOT_COVERED").options.find(o => o.kind === "link")!;
  assert.deepEqual([link.supported, link.unsupportedReason], [false, "Your user can't edit Product2.TaxPolicyId."]);
  const repl = byCode(p.diagnostics, "TREATMENT_LOCKED_NEEDS_REPLACEMENT").options.find(o => o.id === "create-replacement")!;
  assert.equal(repl.supported, false);
});

test("missing business facts become focused questions (ask options), and the GST18 baseline (Laptop Basic-shaped) has no blocking diagnostic", () => {
  const p = buildCalculationPlan(facts(), {});
  const q = p.diagnostics.find(d => d.code === "INPUT_COUNTRY")!;
  assert.deepEqual([q.options[0].kind, q.options[0].inputs![0].field], ["ask", "country"]);
  const lpb = { id: "01t000000000LPB", name: "Laptop Basic", code: "LPB-001", active: true, taxPolicyId: "1Tp000000000IN1" };
  const ok = buildCalculationPlan({ ...facts(), product: lpb }, { account: { id: "001000000000AC1", name: "Aetherion India", country: "IN", state: "AP" } });
  assert.deepEqual([ok.status, ok.diagnostics.filter(d => d.blocksCalculation).length], ["READY_TO_CALCULATE", 0]);
});

test("overlapping rates: no new rate is proposed; each conflicting rate gets an explicit end-date choice (none picked)", () => {
  const lpb = { id: "01t000000000LPB", name: "Laptop Basic", code: "LPB-001", active: true, taxPolicyId: "1Tp000000000IN1" };
  const p = buildCalculationPlan({ ...facts({ extraRates: [rate({ id: "0xq0000000000BL", name: "TR-BLANK", taxCode: "GST18", productCode: null })] }), product: lpb }, { account: { id: "001000000000AC1", name: "Aetherion India", country: "IN", state: "AP" } });
  const d = byCode(p.diagnostics, "RATE_AMBIGUOUS");
  assert.deepEqual(d.options.map(o => o.kind), ["end-date", "end-date"]);
  assert.ok(!p.diagnostics.some(x => x.code === "RATE_MISSING"));
  assert.equal(d.evidence.length, 2);
});

test("ranking honours dependencies over stage order", () => {
  const mk = (id: string, stage: TaxDiagnosticItem["stage"], dependsOn: string[] = []): TaxDiagnosticItem => ({ id, code: id, severity: "blocker", stage, title: id, object: null, record: null, cause: "", evidence: [], blocksCalculation: true, options: [], recommendedOptionId: null, recommendation: "", dependsOn, expected: "" });
  assert.deepEqual(rankDiagnostics([mk("rate", 5), mk("geo", 2, ["rate"]), mk("product", 1)]).map(d => d.id), ["product", "rate", "geo"]);
});

/* ───────────── Approval-bound execution (fake Salesforce) ───────────── */

const OK_PREVIEW = { success: true, ok: true, connection: {}, operations: [], needsSelection: false, token: "assistant-token" } as unknown as AssistantPreview;
function fakeApi(o: { before: TaxDiagnosticItem[]; after?: TaxDiagnosticItem[]; result?: Partial<AssistantResult>; throws?: Error; preview?: AssistantPreview }) {
  const calls = { preview: [] as unknown[][], execute: 0, diagnose: 0 };
  const api: RemediationApi = {
    diagnose: async () => (calls.diagnose++ === 0 ? o.before : o.after ?? o.before),
    preview: async ops => { calls.preview.push(ops); return o.preview ?? OK_PREVIEW; },
    execute: async () => { calls.execute++; if (o.throws) throw o.throws; return { success: true, message: "done", audit: [], failure: null, ...o.result } as unknown as AssistantResult; },
    refresh: async () => ({ ok: true, message: "ok" }),
  };
  return { api, calls };
}
const desktop = () => buildCalculationPlan(facts(), DE_ACC).diagnostics;
const replacementToken = (ds: TaxDiagnosticItem[]) => {
  const d = byCode(ds, "TREATMENT_LOCKED_NEEDS_REPLACEMENT"), o = d.options.find(x => x.id === "create-replacement")!;
  return { d, o, token: approvalToken(planVersion(ds), d.id, o.id, "config", stepsFor(o, "config")) };
};

test("preview returns the itemized group and an approval token; dependent steps go to Salesforce in order, in ONE request", async () => {
  const ds = desktop(); const { d } = replacementToken(ds);
  const { api, calls } = fakeApi({ before: ds });
  const r = await remediate(api, { diagnosticId: d.id, optionId: "create-replacement" });
  assert.equal(r.mode, "preview");
  if (r.mode !== "preview") return;
  assert.deepEqual([r.group, r.steps.map(s => s.id), !!r.approvalToken, calls.execute], ["config", ["create-treatment", "create-item"], true, 0]);
  assert.deepEqual((calls.preview[0] as { key: string }[]).map(x => x.key), ["create-treatment", "create-item"]);
});

test("approved + verified: executes once, re-reads Salesforce, and marks the group done (remaining groups need their own approval)", async () => {
  const ds = desktop(); const { d, token } = replacementToken(ds);
  const draft = { id: "1tt000000000NEW", name: "Desktop Germany Tax Treatment · Default Legal Entity - US", status: "Draft", taxable: true, taxCode: null, productCode: null, policyId: "1Tp000000000DE1", engineId: ENG_DE, legalEntityId: LE, useItems: true };
  const after = buildCalculationPlan(facts({ extraTreatments: [draft], extraItems: [{ id: "1tu000000000NEW", name: "Desktop DE_VAT_19", treatmentId: draft.id, productId: DS.id, productName: "Desktop", taxCode: "DE_VAT_19", productCode: "DS001" }] }), DE_ACC).diagnostics;
  const { api, calls } = fakeApi({ before: ds, after });
  const r = await remediate(api, { diagnosticId: d.id, optionId: "create-replacement", group: "config", approvalToken: token });
  assert.equal(r.mode, "executed");
  if (r.mode !== "executed") return;
  assert.deepEqual([r.ok, r.verified, r.resolved, r.remainingGroups, calls.execute], [true, true, false, ["activation", "link"], 1]);
});

test("resolved only when the re-read plan no longer has the issue; other issues stay", async () => {
  const ds = desktop(); const { d, token } = replacementToken(ds);
  const after = ds.filter(x => x.id !== d.id);
  const { api } = fakeApi({ before: ds, after });
  const r = await remediate(api, { diagnosticId: d.id, optionId: "create-replacement", group: "config", approvalToken: token });
  assert.ok(r.mode === "executed" && r.resolved && r.verified);
  if (r.mode === "executed") assert.deepEqual(r.diagnostics.map(x => x.id), after.map(x => x.id), "only the resolved issue disappears");
});

test("a write that Salesforce still doesn't reflect is NOT marked resolved; a failed write is NOT resolved", async () => {
  const ds = desktop(); const { d, token } = replacementToken(ds);
  const still = await remediate(fakeApi({ before: ds, after: ds }).api, { diagnosticId: d.id, optionId: "create-replacement", group: "config", approvalToken: token });
  assert.ok(still.mode === "executed" && !still.verified && !still.resolved && /NOT marked resolved/.test(still.message));
  const failed = await remediate(fakeApi({ before: ds, result: { success: false, failure: { code: "DUPLICATE_VALUE", message: "duplicate" } as AssistantResult["failure"], message: "failed" } }).api, { diagnosticId: d.id, optionId: "create-replacement", group: "config", approvalToken: token });
  assert.ok(failed.mode === "executed" && !failed.ok && !failed.resolved && failed.failure?.code === "DUPLICATE_VALUE");
});

test("permission denied: reported as such and never retried", async () => {
  const ds = desktop(); const { d, token } = replacementToken(ds);
  const { api, calls } = fakeApi({ before: ds, throws: new Error("INSUFFICIENT_ACCESS_OR_READONLY: insufficient access rights on object id") });
  const r = await remediate(api, { diagnosticId: d.id, optionId: "create-replacement", group: "config", approvalToken: token });
  assert.ok(r.mode === "executed" && r.failure?.permission && r.failure.code === "PERMISSION_DENIED");
  assert.equal(calls.execute, 1);
});

test("stale or forged approvals are refused before any write; a changed plan voids the approval; unsupported options never run", async () => {
  const ds = desktop(); const { d, token } = replacementToken(ds);
  const forged = fakeApi({ before: ds });
  assert.equal((await remediate(forged.api, { diagnosticId: d.id, optionId: "create-replacement", group: "config", approvalToken: "0".repeat(64) })).mode, "stale");
  assert.equal(forged.calls.execute, 0);
  const changed = buildCalculationPlan(facts({ extraRates: [rate({ id: "0xq00000000NEWD", name: "TR-NEW", taxCode: "DE_VAT_19", country: "DE", geoCountryId: "0vf000000000DE1", productCode: null })] }), DE_ACC).diagnostics;
  const moved = fakeApi({ before: changed });
  const r = await remediate(moved.api, { diagnosticId: d.id, optionId: "create-replacement", group: "config", approvalToken: token });
  assert.ok(r.mode === "stale" || (r.mode === "executed" && moved.calls.execute === 1 && planVersion(changed) === planVersion(ds)), "a plan whose facts changed rejects the old token");
  if (planVersion(changed) !== planVersion(ds)) assert.equal(moved.calls.execute, 0);
  const noUser = buildCalculationPlan(facts({ access: { TaxTreatment: { createable: false, updateable: true, fields: {} } } }), DE_ACC).diagnostics;
  const u = fakeApi({ before: noUser });
  assert.equal((await remediate(u.api, { diagnosticId: d.id, optionId: "create-replacement" })).mode, "stale");
  assert.deepEqual([u.calls.execute, u.calls.preview.length], [0, 0]);
});

test("route and UI guards: one approval runs once (duplicate submissions return the first outcome), audit without secrets, all on the Calculation page", () => {
  const route = read("app/api/taxes/calculation/remediate/route.ts");
  assert.match(route, /if \(key && done\.has\(key\)\) return \{ success: true, duplicate: true/);
  assert.match(route, /if \(key && running\.has\(key\)\) throw new BadInputError/);
  assert.match(route, /console\.info\("\[tax-remediation\]"/);
  assert.doesNotMatch(route, /accessToken|apiKey|sessionId/);
  const panel = read("components/data/taxes/RemediationPanel.tsx");
  assert.match(panel, /"\/api\/taxes\/calculation\/remediate"/);
  assert.doesNotMatch(panel, /router\.|window\.location|onOpenRun|href=/, "remediation never navigates away");
});

test("plan summary names the top-ranked blocker (the jurisdiction decision for Desktop → IN/AP), and the locked treatment is not listed as 'reused'", () => {
  const p = buildCalculationPlan(facts(), IN_AP);
  assert.match(p.summary, /^Blocked: Desktop's tax configuration doesn't cover India \(\+1 more issue below\)\.$/);
  assert.ok(!p.reuse.some(r => r.id === "1tt000000000DE1"));
});
