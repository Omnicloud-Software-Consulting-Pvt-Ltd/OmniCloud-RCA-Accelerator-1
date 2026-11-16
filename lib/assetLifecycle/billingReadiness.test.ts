/**
 * Asset Lifecycle — billing readiness before activation (Bill-To + addresses, Billing Policy → product, Billing Treatment → order
 * product, automatic order re-pricing, re-validation, resume) against the in-memory org (fakeOrg — MOCKED; nothing here talks to
 * Salesforce). The fake follows what a live org showed: createOrderFromQuote leaves the order unpriced, order pricing stamps each
 * line's Billing Treatment from its product's policy, the Billing Policy is a Product2 field.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { billingPhrases, normalizeExtraction, parseAddressText, ruleExtract } from "./ai";
import { billingHash, nextBillingAction, orderPriced, validateBillingDetails, type OrderBillingSnapshot } from "./billing";
import { executeLifecycle } from "./executor";
import { STEP_ORDER, withBillingStep } from "./plan";
import { resolvePrompt } from "./server/ai";
import { fakeLifecycleOrg, type FakeOptions } from "./server/fakeOrg";
import { billingOptions } from "./server/reads";
import { LifecycleStore } from "./server/store";
import { executeStep, resolveBilling, saveTransaction, type LifecycleCtx } from "./server/service";
import type { LifecycleDeps } from "./server/lifecycle";
import type { BillingDetails, LifecycleKind, LifecycleTransaction, StepId } from "./types";

const TODAY = "2026-11-11";
const ORG = "00DA00000000002";
function setup(opts: FakeOptions = {}) {
  const org = fakeLifecycleOrg(opts, () => new Date().toISOString(), TODAY);
  const ctx: LifecycleCtx = { api: org.api, orgId: ORG, userId: "005A00000000001AAA", store: new LifecycleStore(mkdtempSync(join(tmpdir(), "lifecycle-billing-"))) };
  const deps: LifecycleDeps = { now: () => new Date().toISOString(), sleep: async () => {}, waitMs: 0, today: () => TODAY, activate: org.activate, billing: org.billing };
  return { org, ctx, deps };
}
type Org = ReturnType<typeof fakeLifecycleOrg>;
const ADDRESS = { street: "1 Main St", city: "Springfield", state: "IL", postalCode: "62701", country: "US" };
const billingFor = (org: Org, over: Partial<BillingDetails> = {}): BillingDetails => ({ billToContactId: org.ids.payer, billToContactName: "Pat Payer", billingAddress: ADDRESS, shippingAddress: { ...ADDRESS, street: "9 Dock Rd" }, source: "test", ...over });

async function draft(ctx: LifecycleCtx, kind: LifecycleKind, body: Record<string, unknown>) {
  const { transaction, errors } = await saveTransaction(ctx, { kind, accountId: "001A00000000001AAA", ...body }, TODAY);
  assert.deepEqual(errors, []);
  return transaction;
}
/** Run steps until `until` (inclusive) or the first step that isn't completed. */
async function runTo(ctx: LifecycleCtx, deps: LifecycleDeps, id: string, until: StepId): Promise<LifecycleTransaction> {
  let t = (await ctx.store.load(ORG)).transactions.find(x => x.id === id)!;
  for (const s of STEP_ORDER) {
    const cur = t.steps.find(x => x.id === s)!;
    if (cur.status === "completed" || cur.status === "skipped") { if (s === until) break; continue; }
    t = await executeStep(ctx, id, s, true, deps, { activationConfirmed: s === "activate" });
    if (t.steps.find(x => x.id === s)!.status !== "completed" || s === until) break;
  }
  return t;
}
const stepOf = (t: LifecycleTransaction, id: StepId) => t.steps.find(s => s.id === id)!;
const orderPlaces = (org: Org) => org.calls.filter(c => c.path.endsWith("/place") && (c.body as { graph?: { records?: { record?: { attributes?: { type?: string } } }[] } })?.graph?.records?.[0]?.record?.attributes?.type === "Order");

/* ───────────── contacts + addresses ───────────── */

test("contacts and addresses come from the account's real records; the default is the asset's original order (editable)", async () => {
  const { org } = setup();
  const o = await billingOptions(org.api, org.ids.acct, [org.ids.origin]);
  assert.deepEqual(o.contacts.map(c => c.name), ["Pat Payer", "Sam Signer"], "only this account's contacts");
  assert.equal(o.defaults?.billToContactId, org.ids.payer);
  assert.match(o.defaults!.source, /^Original order 00000001/);
  assert.equal(o.defaults?.shippingAddress?.street, "9 Dock Rd");
  assert.ok(o.addresses.some(a => /Original order 00000001 — billing/.test(a.source)) && o.addresses.some(a => /Contact Pat Payer — mailing/.test(a.source)) === false, "duplicate addresses are listed once (the contact's mailing = the order's billing)");
  const none = await billingOptions(org.api, "001A00000000099AAA", []);
  assert.deepEqual([none.contacts.length, none.defaults], [0, null], "an account without records → nothing invented");
});

test("billing details are required before execution; prompt phrases fill them (contact resolved to a real contact, addresses parsed)", async () => {
  assert.deepEqual(validateBillingDetails(null).length, 3);
  assert.deepEqual(validateBillingDetails({ billToContactId: "003A00000000001AAA", billToContactName: "X", billingAddress: ADDRESS, shippingAddress: { ...ADDRESS, city: null }, source: null }), ["Enter the Shipping Address (at least Street, City and Country)."]);
  const p = "Increase Laptop by 1 for Test Account effective today, bill to Pat Payer. Billing address: 5 Elm St, Springfield, IL 62704, US; ship to the same address.";
  assert.deepEqual(billingPhrases(p), { billTo: "Pat Payer", billingAddress: "5 Elm St, Springfield, IL 62704, US", shippingAddress: null, shippingSameAsBilling: true });
  assert.deepEqual(parseAddressText("1 Main St, Toronto, ON, M5V 2T6, Canada"), { street: "1 Main St", city: "Toronto", state: "ON", postalCode: "M5V 2T6", country: "Canada" });
  assert.equal(parseAddressText("Springfield"), null, "too little to be an address → the form asks");
  const { org } = setup();
  const r = await resolvePrompt(org.api, normalizeExtraction(ruleExtract(p, TODAY)), { prompt: p, kindHint: "amend", today: TODAY, engine: "rules" });
  assert.equal(r.prefill.billing?.billToContactId, org.ids.payer, "Bill-To resolved to the account's contact");
  assert.deepEqual(r.prefill.billing?.billingAddress, { street: "5 Elm St", city: "Springfield", state: "IL", postalCode: "62704", country: "US" });
  assert.deepEqual(r.prefill.billing?.shippingAddress, r.prefill.billing?.billingAddress);
  assert.ok(r.fields.some(f => f.label === "Bill-To Contact" && f.source === "salesforce"));
  const q = "Increase Laptop by 1 for Test Account effective today, bill to Nobody Here.";
  const nf = await resolvePrompt(org.api, normalizeExtraction(ruleExtract(q, TODAY)), { prompt: q, kindHint: "amend", today: TODAY, engine: "rules" });
  const issue = nf.issues.find(i => i.field === "Bill-To Contact")!;
  assert.equal(issue.status, "not-found");
  assert.deepEqual(issue.candidates?.map(c => c.name), ["Pat Payer", "Sam Signer"], "real contacts offered, none invented");
});

/* ───────────── automatic readiness ───────────── */

test("unpriced order (as createOrderFromQuote leaves it): Bill-To + addresses written, order re-priced (treatments stamped), ready — never activated", async () => {
  const { org, ctx, deps } = setup();
  const tx = await draft(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }], billing: billingFor(org) });
  const t = await runTo(ctx, deps, tx.id, "prepare-billing");
  assert.equal(stepOf(t, "prepare-billing").status, "completed", stepOf(t, "prepare-billing").message!);
  const order = org.byId("Order", t.sf.orderId)!;
  assert.deepEqual([order.BillToContactId, order.BillingCity, order.ShippingStreet], [org.ids.payer, "Springfield", "9 Dock Rd"], "read back on the order");
  assert.equal(order.CalculationStatus, "CompletedWithPricing");
  assert.equal(orderPlaces(org).length, 1, "Bill-To / addresses written first, then ONE Salesforce pricing of the order");
  assert.ok(orderPlaces(org).every(c => (c.body as { pricingPref?: string }).pricingPref === "Force"));
  assert.ok(org.db.OrderItem.filter(i => i.OrderId === order.Id).every(i => i.BillingTreatmentId === org.policies[0].defaultTreatment!.id), "Salesforce pricing stamped the policy's default treatment");
  assert.equal(order.Status, "Draft", "billing readiness never activates");
  assert.equal(stepOf(t, "activate").status, "pending");
  assert.deepEqual(org.billingWrites.map(w => w.kind), ["Order.BillToContactId", "Order.BillingAddress", "Order.ShippingAddress"], "no product or treatment write was needed");
  assert.ok((t.billingLog ?? []).some(l => l.action === "Billing ready"), "visible progress");
  await assert.rejects(executeStep(ctx, tx.id, "activate", true, deps), /its own confirmation/, "activation still needs its own confirmation");
});

test("pricing that doesn't stamp treatments → Order Setup's default treatment applied, then the order is re-priced again", async () => {
  const { org, ctx, deps } = setup({ billing: { pricingSkipsTreatment: true } });
  const tx = await draft(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }], billing: billingFor(org) });
  const t = await runTo(ctx, deps, tx.id, "prepare-billing");
  assert.equal(stepOf(t, "prepare-billing").status, "completed", stepOf(t, "prepare-billing").message!);
  assert.ok(org.billingWrites.some(w => w.kind === "OrderItem.BillingTreatmentId"));
  assert.equal(orderPlaces(org).length, 2, "re-priced again after Order Setup changed the lines — the order's prices are current at activation");
  assert.equal(t.sf.billingDirty, false);
  assert.ok(orderPriced({ calculationStatus: String(org.byId("Order", t.sf.orderId)!.CalculationStatus), lastPricedDate: String(org.byId("Order", t.sf.orderId)!.LastPricedDate) }, t.sf.billingDirty));
});

test("asynchronous pricing: the step waits (never reported ready) until Salesforce shows the order priced", async () => {
  const { org, ctx, deps } = setup({ billing: { pricingReads: 3 } });
  const tx = await draft(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }], billing: billingFor(org) });
  let t = await runTo(ctx, deps, tx.id, "prepare-billing");
  assert.equal(stepOf(t, "prepare-billing").status, "waiting");
  const places = orderPlaces(org).length;
  for (let i = 0; i < 6 && stepOf(t, "prepare-billing").status === "waiting"; i++) t = await executeStep(ctx, tx.id, "prepare-billing", true, deps);
  assert.equal(stepOf(t, "prepare-billing").status, "completed", stepOf(t, "prepare-billing").message!);
  assert.ok(orderPlaces(org).length >= places, "a pending pricing request is not re-sent while Salesforce works on it");
});

/* ───────────── decisions: policy / treatment ───────────── */

test("a product without a Billing Policy stops for the user's decision; the confirmed policy is written to the product, read back, then the order is re-priced", async () => {
  const { org, ctx, deps } = setup({ billing: { productsWithoutPolicy: ["Laptop"] } });
  const tx = await draft(ctx, "amend", { assetIds: [org.ids.laptop, org.ids.support], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }, { assetId: org.ids.support, quantityChange: 1 }], billing: billingFor(org) });
  let t = await runTo(ctx, deps, tx.id, "prepare-billing");
  assert.equal(stepOf(t, "prepare-billing").status, "needs-input");
  assert.equal(t.status, "needs-input");
  const need = t.billingNeeds!.find(n => n.kind === "billing-policy")!;
  assert.equal(need.product?.name, "Laptop");
  assert.equal(need.orderItemIds.length, 1, "the order product it concerns");
  const laptopProduct = org.db.Product2.find(p => p.Name === "Laptop")!;
  assert.equal(laptopProduct.BillingPolicyId, null, "nothing written before the decision");
  // Only questions actually open can be answered.
  await assert.rejects(resolveBilling(ctx, tx.id, { policies: [{ productId: org.db.Product2.find(p => p.Name === "Support")!.Id, productName: "Support", policyId: org.policies[0].id, policyName: "Advance", previousPolicyId: null }], treatments: [] }), /no open Billing Policy question/);
  t = await resolveBilling(ctx, tx.id, { policies: [{ productId: laptopProduct.Id, productName: "Laptop", policyId: org.policies[1].id, policyName: "Arrears", previousPolicyId: null }], treatments: [] });
  assert.ok(t.billingResolutions!.policies[0].confirmedAt && !t.billingResolutions!.policies[0].appliedAt, "stored as a confirmed decision, not yet applied");
  t = await executeStep(ctx, tx.id, "prepare-billing", true, deps);
  assert.equal(stepOf(t, "prepare-billing").status, "completed", stepOf(t, "prepare-billing").message!);
  assert.equal(laptopProduct.BillingPolicyId, org.policies[1].id, "persisted on the product");
  assert.equal(org.billingWrites.filter(w => w.kind === "Product2.BillingPolicyId").length, 1, "assigned once — no other product touched");
  assert.ok(t.billingResolutions!.policies[0].appliedAt);
  // Multiple order products, different configuration: Laptop → Arrears treatment, Support → Advance treatment.
  const items = org.db.OrderItem.filter(i => i.OrderId === t.sf.orderId);
  const treatmentOf = (name: string) => items.find(i => org.byId("Product2", i.Product2Id)?.Name === name)?.BillingTreatmentId;
  assert.deepEqual([treatmentOf("Laptop"), treatmentOf("Support")], [org.policies[1].defaultTreatment!.id, org.policies[0].defaultTreatment!.id]);
});

test("a treatment Salesforce can't resolve (policy without a default) stops for a choice among the policy's eligible treatments; a non-eligible one is refused", async () => {
  const { org, ctx, deps } = setup({ billing: { arrearsWithoutDefault: true, pricingSkipsTreatment: true } });
  org.db.Product2.find(p => p.Name === "Laptop")!.BillingPolicyId = org.policies[1].id;
  const tx = await draft(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }], billing: billingFor(org) });
  let t = await runTo(ctx, deps, tx.id, "prepare-billing");
  assert.equal(stepOf(t, "prepare-billing").status, "needs-input", stepOf(t, "prepare-billing").message!);
  const need = t.billingNeeds![0];
  assert.deepEqual([need.kind, need.policy?.name], ["billing-treatment", "Arrears"]);
  const draftTreatment = org.policies[1].treatments.find(x => x.status === "Draft")!;
  await resolveBilling(ctx, tx.id, { policies: [], treatments: [{ orderItemId: need.orderItemIds[0], productName: "Laptop", policyId: org.policies[1].id, treatmentId: draftTreatment.id, treatmentName: draftTreatment.name }] });
  t = await executeStep(ctx, tx.id, "prepare-billing", true, deps);
  assert.equal(stepOf(t, "prepare-billing").status, "failed");
  assert.match(stepOf(t, "prepare-billing").message!, /isn't an Active treatment/, "never an arbitrary / inactive treatment");
  const active = org.policies[1].treatments.find(x => x.status === "Active")!;
  await resolveBilling(ctx, tx.id, { policies: [], treatments: [{ orderItemId: need.orderItemIds[0], productName: "Laptop", policyId: org.policies[1].id, treatmentId: active.id, treatmentName: active.name }] });
  t = await executeStep(ctx, tx.id, "prepare-billing", true, deps);
  assert.equal(stepOf(t, "prepare-billing").status, "completed", stepOf(t, "prepare-billing").message!);
  assert.equal(org.byId("OrderItem", need.orderItemIds[0])!.BillingTreatmentId, active.id, "persisted on the order product");
});

/* ───────────── failures, resume, one click ───────────── */

test("a refused re-pricing stops with Salesforce's exact error; resume continues without a second order, quote or policy write", async () => {
  const opts: FakeOptions = { billing: { rejectOrderPricing: "Pricing procedure 'Default' failed: missing price for Laptop." } };
  const { org, ctx, deps } = setup(opts);
  const tx = await draft(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }], billing: billingFor(org) });
  let t = await runTo(ctx, deps, tx.id, "prepare-billing");
  assert.equal(stepOf(t, "prepare-billing").status, "failed");
  assert.match(stepOf(t, "prepare-billing").message!, /missing price for Laptop/);
  assert.equal(stepOf(t, "activate").status, "pending", "nothing after the failure ran");
  opts.billing!.rejectOrderPricing = undefined; // fixed in Salesforce
  const orders = org.db.Order.length, quotes = org.db.Quote.length;
  t = await executeStep(ctx, tx.id, "prepare-billing", true, deps);
  assert.equal(stepOf(t, "prepare-billing").status, "completed", stepOf(t, "prepare-billing").message!);
  assert.deepEqual([org.db.Order.length, org.db.Quote.length], [orders, quotes], "no duplicate order or quote");
  assert.equal(org.billingWrites.filter(w => w.kind === "Order.BillToContactId").length, 1, "Bill-To written once — not re-sent on resume");
});

test("one click: needs are answered in the popup and execution continues to the separate activation confirmation", async () => {
  const { org, ctx, deps } = setup({ billing: { productsWithoutPolicy: ["Laptop"] } });
  const tx = await draft(ctx, "amend", { assetIds: [org.ids.laptop, org.ids.support], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }, { assetId: org.ids.support, quantityChange: 1 }], billing: billingFor(org) });
  const asked: string[] = [];
  let activationAsked = 0;
  const r = await executeLifecycle(tx, {
    target: "activate", sleep: async () => {}, pollMs: 0, maxPolls: 5,
    runStep: (step, o) => executeStep(ctx, tx.id, step, o.confirmed, deps, { activationConfirmed: o.activationConfirmed }),
    resolveNeeds: async cur => {
      asked.push(...cur.billingNeeds!.map(n => n.kind));
      const n = cur.billingNeeds!.find(x => x.kind === "billing-policy")!;
      return resolveBilling(ctx, cur.id, { policies: [{ productId: n.product!.id, productName: n.product!.name, policyId: org.policies[0].id, policyName: "Advance", previousPolicyId: null }], treatments: [] });
    },
    confirmActivation: async () => { activationAsked++; return false; },
  });
  assert.deepEqual(asked, ["billing-policy"]);
  assert.equal(r.status, "awaiting-activation", r.message);
  assert.equal(activationAsked, 1, "activation asked separately, after billing readiness");
  assert.equal(org.byId("Order", r.tx.sf.orderId)!.Status, "Draft", "declined → not activated");
  const paused = await executeLifecycle(withBillingStep({ ...tx }), { target: "order", sleep: async () => {}, runStep: async () => { throw new Error("not called"); }, confirmActivation: async () => true });
  assert.notEqual(paused.status, "completed");
});

test("without a decision handler, execution pauses at the question (needs-input) — nothing guessed, nothing activated", async () => {
  const { org, ctx, deps } = setup({ billing: { productsWithoutPolicy: ["Laptop"] } });
  const tx = await draft(ctx, "amend", { assetIds: [org.ids.laptop, org.ids.support], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }, { assetId: org.ids.support, quantityChange: 1 }], billing: billingFor(org) });
  const r = await executeLifecycle(tx, { target: "activate", sleep: async () => {}, pollMs: 0, runStep: (step, o) => executeStep(ctx, tx.id, step, o.confirmed, deps, { activationConfirmed: o.activationConfirmed }), confirmActivation: async () => true });
  assert.equal(r.status, "needs-input", r.message);
  assert.equal(r.step, "prepare-billing");
  assert.equal(org.billingWrites.filter(w => w.kind === "Product2.BillingPolicyId").length, 0);
  assert.equal(org.byId("Order", r.tx.sf.orderId)!.Status, "Draft");
});

test("no product on the order has billing configuration → nothing to ask (activation has no billing gate either); only Salesforce pricing", async () => {
  const { org, ctx, deps } = setup({ billing: { productsWithoutPolicy: ["Laptop"] } });
  const tx = await draft(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }], billing: null });
  const t = await runTo(ctx, deps, tx.id, "prepare-billing");
  assert.equal(stepOf(t, "prepare-billing").status, "completed", stepOf(t, "prepare-billing").message!);
  assert.deepEqual(t.billingNeeds, []);
  assert.equal(orderPlaces(org).length, 1, "still priced — the order's prices are current at activation");
  assert.equal(org.billingWrites.length, 0, "no product, order-product or order billing field written");
});

test("billing details changed after the order exists are re-applied (step re-opened); old transactions get the step on load", async () => {
  const { org, ctx, deps } = setup();
  const tx = await draft(ctx, "cancel", { assetIds: [org.ids.laptop], effectiveDate: TODAY, billing: billingFor(org) });
  let t = await runTo(ctx, deps, tx.id, "prepare-billing");
  assert.equal(stepOf(t, "prepare-billing").status, "completed");
  const { transaction } = await saveTransaction(ctx, { kind: "cancel", id: tx.id, accountId: org.ids.acct, assetIds: [org.ids.laptop], effectiveDate: TODAY, billing: billingFor(org, { shippingAddress: { ...ADDRESS, street: "77 New Rd" } }) }, TODAY);
  assert.equal(stepOf(transaction, "prepare-billing").status, "pending", "re-opened");
  t = await executeStep(ctx, tx.id, "prepare-billing", true, deps);
  assert.equal(stepOf(t, "prepare-billing").status, "completed");
  assert.equal(org.byId("Order", t.sf.orderId)!.ShippingStreet, "77 New Rd");
  assert.notEqual(billingHash(billingFor(org)), billingHash(t.billing));
  // A transaction saved before billing readiness existed (no prepare-billing step):
  const legacy = { ...t, steps: t.steps.filter(s => s.id !== "prepare-billing").map(s => (s.id === "activate" ? { ...s, status: "pending" as const } : s)) };
  const migrated = withBillingStep(legacy);
  assert.deepEqual(migrated.steps.map(s => s.id), STEP_ORDER);
  assert.equal(stepOf(migrated, "prepare-billing").status, "pending");
  const done = withBillingStep({ ...legacy, steps: legacy.steps.map(s => (s.id === "activate" ? { ...s, status: "completed" as const } : s)) });
  assert.equal(stepOf(done, "prepare-billing").status, "skipped", "already-activated history isn't re-run");
});

test("pure decision order: details → questions → broken policy chain blocks → pricing → setup → treatment choice → ready", () => {
  const base: OrderBillingSnapshot = { orderId: "801A", orderNumber: "1", status: "Draft", activated: false, billToContact: null, billingAddress: null, shippingAddress: null, items: [], requiresBilling: true, ready: false, blockers: [], stateToken: null };
  const item = { id: "802A", product: { id: "01tA", name: "Widget" }, policy: { id: "1BPA", name: "P" }, policyErrors: [], treatment: null, expectedTreatment: { id: "1BTA", name: "T" }, pendingActions: [] as string[] };
  const priced = { calculationStatus: "CompletedWithPricing", lastPricedDate: "2026-11-11T10:00:00Z" };
  const tx = { billing: null, billingResolutions: { policies: [], treatments: [] }, sf: {} as LifecycleTransaction["sf"] };
  assert.equal(nextBillingAction({ ...base, items: [item] }, priced, tx).type, "needs", "no Bill-To / address and none chosen");
  const ready = { ...base, billToContact: { id: "003A", name: "C" }, billingAddress: ADDRESS, shippingAddress: ADDRESS };
  assert.equal(nextBillingAction({ ...ready, items: [{ ...item, policy: null }] }, priced, tx).type, "needs");
  assert.equal(nextBillingAction({ ...ready, items: [{ ...item, policyErrors: ["Treatment is Draft."] }] }, priced, tx).type, "blocked");
  assert.equal(nextBillingAction({ ...ready, items: [item] }, { calculationStatus: "CompletedWithoutPricing", lastPricedDate: null }, tx).type, "reprice");
  assert.equal(nextBillingAction({ ...ready, items: [item] }, priced, { ...tx, sf: { billingDirty: true } as LifecycleTransaction["sf"] }).type, "reprice", "changed after the last pricing");
  assert.equal(nextBillingAction({ ...ready, items: [{ ...item, pendingActions: ["billing-treatment"] }] }, priced, tx).type, "apply-setup");
  assert.equal(nextBillingAction({ ...ready, items: [{ ...item, expectedTreatment: null }] }, priced, tx).type, "needs");
  assert.equal(nextBillingAction({ ...ready, items: [{ ...item, treatment: { id: "1BTA", name: "T" } }], ready: true }, priced, tx).type, "ready");
  assert.equal(nextBillingAction({ ...ready, items: [{ ...item, product: { id: "01tB", name: "Free" }, policy: null }], requiresBilling: false, ready: true }, priced, tx).type, "ready", "no billing configuration anywhere → no policy question");
});
