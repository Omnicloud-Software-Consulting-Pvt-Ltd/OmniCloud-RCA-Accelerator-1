/**
 * Asset lifecycle — Assets discovery, Amendments, Renewals and Cancellations: eligibility, planning and every lifecycle run against the
 * in-memory org (fakeOrg — MOCKED; nothing here talks to Salesforce). Live verification is separate and needs explicit approval.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetEligibility, assetState, termEnd } from "./eligibility";
import { initiateRequest, lineChangePlan, previewRows, renewalWindow, STEP_ORDER, validateTransaction } from "./plan";
import { assetDetail, assetFactsByIds, lifecycleCapabilities, listAssets, salesforceTransactions } from "./server/reads";
import { fakeLifecycleOrg, type FakeOptions } from "./server/fakeOrg";
import { LifecycleStore } from "./server/store";
import { LifecycleInputError, executeStep, saveTransaction, type LifecycleCtx } from "./server/service";
import type { LifecycleDeps } from "./server/lifecycle";
import type { LifecycleKind, LifecycleTransaction, StepId } from "./types";

/** Who is billed and where (the seeded contact of the account) — what the form sends; billing readiness writes it to the order. */
async function defaultBilling(ctx: LifecycleCtx) {
  const [c] = await ctx.api.query<{ Id: string }>("SELECT Id FROM Contact WHERE Name = 'Pat Payer'");
  const address = { street: "1 Main St", city: "Springfield", state: "IL", postalCode: "62701", country: "US" };
  return { billToContactId: c.Id, billToContactName: "Pat Payer", billingAddress: address, shippingAddress: address, source: "test" };
}

const TODAY = "2026-11-11";
const ORG = "00DA00000000001";

function setup(opts: FakeOptions = {}) {
  const org = fakeLifecycleOrg(opts, () => new Date().toISOString(), TODAY);
  const ctx: LifecycleCtx = { api: org.api, orgId: ORG, userId: "005A00000000001AAA", store: new LifecycleStore(mkdtempSync(join(tmpdir(), "lifecycle-"))) };
  const deps: LifecycleDeps = { now: () => new Date().toISOString(), sleep: async () => {}, waitMs: 0, today: () => TODAY, activate: org.activate, billing: org.billing };
  return { org, ctx, deps };
}
type Org = ReturnType<typeof fakeLifecycleOrg>;
const facts = async (org: Org, ids: string[]) => assetFactsByIds(org.api, ids, TODAY);
const save = async (ctx: LifecycleCtx, kind: LifecycleKind, body: Record<string, unknown>) => saveTransaction(ctx, { kind, accountId: "001A00000000001AAA", billing: await defaultBilling(ctx), ...body }, TODAY);

async function runAll(ctx: LifecycleCtx, deps: LifecycleDeps, id: string, until?: StepId): Promise<LifecycleTransaction> {
  let t = (await ctx.store.load(ORG)).transactions.find(x => x.id === id)!;
  for (const s of STEP_ORDER) {
    const cur = t.steps.find(x => x.id === s)!;
    if (cur.status === "skipped" || cur.status === "completed") { if (s === until) break; continue; }
    t = await executeStep(ctx, id, s, true, deps, { activationConfirmed: true });
    const st = t.steps.find(x => x.id === s)!;
    assert.ok(st.status === "completed" || st.status === "skipped", `${s}: ${st.status} — ${st.message}`);
    if (s === until) break;
  }
  return t;
}
const postsTo = (org: Org, action: string) => org.calls.filter(c => c.method === "POST" && c.path.endsWith(`/${action}`));

/* ───────────── assets: state, eligibility, discovery ───────────── */

test("asset state + eligibility per lifecycle explain every block with the Salesforce value", async () => {
  const { org } = setup();
  const f = await facts(org, Object.values(org.ids).filter(v => /^(02i|Ass)/.test(v)));
  const ctx = { accountId: org.ids.acct, contractId: null, effectiveDate: null, today: TODAY };
  const g = (k: keyof Org["ids"]) => f.get(org.ids[k])!;
  assert.equal(assetState(g("laptop"), TODAY), "active");
  assert.equal(assetState(g("backup"), TODAY), "expiring", "ends within 90 days");
  assert.equal(assetState(g("old"), TODAY), "expired");
  assert.equal(assetState(g("plain"), TODAY), "unmanaged");
  const codes = (k: keyof Org["ids"], kind: LifecycleKind) => assetEligibility(g(k), kind, ctx).filter(r => r.severity === "error").map(r => r.code);
  assert.deepEqual(codes("laptop", "amend"), []);
  assert.deepEqual(codes("laptop", "renew"), ["ONE_TIME"], "one-time purchases have no term to renew");
  assert.deepEqual(codes("hosting", "renew"), ["EVERGREEN"], "evergreen assets continue until cancelled");
  assert.deepEqual(codes("support", "renew"), []);
  assert.deepEqual(codes("old", "renew"), [], "expired term assets ARE renewable (start today or later)");
  assert.ok(assetEligibility(g("old"), "renew", ctx).some(r => r.code === "EXPIRED" && r.severity === "warning"));
  assert.ok(assetEligibility(g("old"), "renew", { ...ctx, effectiveDate: "2026-07-01" }).some(r => r.code === "START_IN_PAST"));
  assert.deepEqual(codes("old", "amend"), ["ENDED"]);
  assert.deepEqual(codes("old", "cancel"), ["ENDED"]);
  assert.ok(codes("plain", "cancel").includes("NOT_LIFECYCLE"));
  assert.ok(codes("addon", "amend").includes("CHILD_ASSET"), "bundle components go with their root");
  assert.ok(assetEligibility(g("suite"), "amend", ctx).some(r => r.code === "BUNDLE_ROOT" && r.severity === "warning"));
  assert.ok(assetEligibility(g("api"), "amend", ctx).some(r => r.code === "USAGE_QUOTE_FIRST" && r.severity === "warning"));
  assert.ok(codes("laptop", "amend").length === 0 && assetEligibility(g("laptop"), "amend", { ...ctx, contractId: org.ids.contract }).some(r => r.code === "NOT_ON_CONTRACT"));
  assert.deepEqual(assetEligibility(g("support"), "amend", { ...ctx, contractId: org.ids.contract }).filter(r => r.severity === "error"), [], "linked by Asset Contract Relationship");
  assert.ok(assetEligibility(g("support"), "cancel", { ...ctx, effectiveDate: "2028-03-01" }).some(r => r.code === "AFTER_END"));
  assert.ok(assetEligibility({ ...g("laptop"), open: [{ quoteId: "0Q0A", quoteNumber: "Q-9", status: "Draft", type: "Renew" }] }, "cancel", ctx).some(r => r.code === "OPEN_TRANSACTION"), "an open lifecycle quote blocks a duplicate");
  assert.ok(assetEligibility({ ...g("support"), quantity: 0, lastAction: { type: "Cancel", category: "Cancellations", subtype: null, date: "2026-10-01" } }, "cancel", ctx).some(r => r.code === "ALREADY_CANCELLED"));
});

test("asset facts come from the lifecycle records: selling model, price, frequency, origin order, contract links, usage, billing", async () => {
  const { org } = setup();
  const f = await facts(org, [org.ids.support, org.ids.api, org.ids.suite]);
  const s = f.get(org.ids.support)!;
  assert.equal(s.sellingModel?.type, "TermDefined");
  assert.equal(s.unitPrice, 50);
  assert.equal(s.billingFrequency, "Annual");
  assert.equal(s.originOrder?.number, "00000001");
  assert.equal(s.pricebookId, org.ids.pb1);
  assert.deepEqual(s.contracts.map(c => [c.id, c.source, c.number]), [[org.ids.contract, "relationship", "00000100"]]);
  assert.equal(f.get(org.ids.api)!.usage.usageBased, true);
  assert.deepEqual(f.get(org.ids.suite)!.childIds, [org.ids.addon]);
  const detail = (await assetDetail(org.api, org.ids.support, TODAY))!;
  assert.equal(detail.actions.length, 1);
  assert.equal(detail.actions[0].sources[0].orderNumber, "00000001");
  assert.equal(detail.statePeriods.length, 1);
  assert.equal(detail.billing[0].number, "BSG-1");
  assert.equal(detail.billing[0].schedules, 1);
  const laptop = (await assetDetail(org.api, org.ids.laptop, TODAY))!;
  assert.deepEqual(laptop.attributes.map(a => [a.name, a.value]), [["Color", "Silver"]]);
});

test("discovery: account without contract lists its assets; contract filters to related assets; paging + totals; unmanaged hidden by default", async () => {
  const { org } = setup();
  const all = await listAssets(org.api, { accountId: org.ids.acct, pageSize: 100 }, TODAY);
  assert.equal(all.total, 8, "every lifecycle asset of the account, with no contract selected");
  assert.ok(!all.rows.some(r => r.id === org.ids.plain), "non-lifecycle assets are hidden by default");
  assert.ok((await listAssets(org.api, { accountId: org.ids.acct, lifecycleOnly: false, pageSize: 100 }, TODAY)).rows.some(r => r.id === org.ids.plain));
  const byContract = await listAssets(org.api, { accountId: org.ids.acct, contractId: org.ids.contract }, TODAY);
  assert.deepEqual(byContract.rows.map(r => r.name), ["Support"]);
  const p1 = await listAssets(org.api, { accountId: org.ids.acct, pageSize: 4, page: 1 }, TODAY);
  const p2 = await listAssets(org.api, { accountId: org.ids.acct, pageSize: 4, page: 2 }, TODAY);
  assert.equal(p1.rows.length, 4); assert.equal(p1.hasMore, true); assert.equal(p2.rows.length, 4);
  assert.equal(new Set([...p1.rows, ...p2.rows].map(r => r.id)).size, 8, "pages don't overlap");
  const row = all.rows.find(r => r.id === org.ids.hosting)!;
  assert.equal(row.state, "active");
  assert.ok(row.eligibility.renew.some(r => r.code === "EVERGREEN"));
  assert.deepEqual(row.eligibility.cancel.filter(r => r.severity === "error"), []);
});

test("capabilities come from the org: actions + inputs, permissions, ramped renewal, start-date adjustment, reason fields", async () => {
  const caps = await lifecycleCapabilities(setup({ reasonField: true }).org.api);
  assert.equal(caps.actions.amend.available && caps.actions.renew.available && caps.actions.cancel.available && caps.actions.createOrderFromQuote.available, true);
  assert.deepEqual(caps.missing.renew, []);
  assert.equal(caps.features.rampedRenewal, true);
  assert.equal(caps.features.startDateAdjustment, true);
  assert.deepEqual(caps.reasonFields.map(f => `${f.object}.${f.field}`), ["Quote.Cancellation_Reason__c"]);
  const none = await lifecycleCapabilities(setup({ missingAction: "initiateRenewal", noRampOptions: true }).org.api);
  assert.equal(none.actions.renew.available, false);
  assert.match(none.missing.renew.join(" "), /initiateRenewal isn't available/);
  assert.deepEqual(none.reasonFields, [], "no reason field → the reason stays in the app's audit only");
});

/* ───────────── amendments ───────────── */

test("amendment: quantity increase runs every step quote-first and Salesforce's asset reads back the new quantity", async () => {
  const { org, ctx, deps } = setup();
  const { transaction, errors } = await save(ctx, "amend", { assetIds: [org.ids.support], effectiveDate: "2026-11-11", contractId: org.ids.contract, changes: [{ assetId: org.ids.support, quantityChange: 3 }] });
  assert.deepEqual(errors, []);
  const t = await runAll(ctx, deps, transaction.id);
  assert.equal(t.status, "completed");
  const req = postsTo(org, "initiateAmendment")[0].body as { inputs: Record<string, unknown>[] };
  assert.deepEqual(req.inputs[0], { amendAssetIds: [org.ids.support], amendStartDate: "2026-11-11T00:00:00.000Z", quantityChange: 3, amendOutputType: "Quote", skipPricing: false, amendContractId: org.ids.contract });
  assert.equal(t.steps.find(s => s.id === "apply-changes")!.status, "skipped", "Salesforce's quote already matched — nothing sent");
  assert.equal(org.byId("Asset", org.ids.support)!.CurrentQuantity, 5);
  assert.ok(t.checks.every(c => c.ok || c.required === false));
  assert.equal(postsTo(org, "createOrderFromQuote").length, 1);
});

test("amendment: two assets with different changes — quantity down, price + discount + attribute; billing frequency + end date; an add-on", async () => {
  const { org, ctx, deps } = setup();
  const { transaction, errors } = await save(ctx, "amend", {
    assetIds: [org.ids.laptop, org.ids.support], effectiveDate: "2026-11-11",
    changes: [
      { assetId: org.ids.laptop, quantityChange: -2, unitPrice: 900, discount: 5, attributes: [{ definitionId: org.ids.attrDef, name: "Color", value: "Black" }] },
      { assetId: org.ids.support, quantityChange: 1, billingFrequency: "Quarterly", endDate: "2028-06-30" },
    ],
    adds: [{ productId: org.ids.pPremium, productName: "Support Premium", pricebookEntryId: org.ids.pbePremium, quantity: 5, endDate: "2027-12-31" }],
  });
  assert.deepEqual(errors, []);
  const t = await runAll(ctx, deps, transaction.id);
  const lines = org.db.QuoteLineItem.filter(l => l.QuoteId === t.sf.quoteId);
  const laptopLine = lines.find(l => org.byId("QuoteAction", l.QuoteActionId)?.SourceAssetId === org.ids.laptop)!;
  assert.deepEqual([laptopLine.Quantity, laptopLine.UnitPrice, laptopLine.Discount], [-2, 900, 5]);
  assert.equal(org.db.QuoteLineItemAttribute.find(a => a.QuoteLineItemId === laptopLine.Id)!.AttributeValue, "Black");
  const supportLine = lines.find(l => org.byId("QuoteAction", l.QuoteActionId)?.SourceAssetId === org.ids.support)!;
  assert.deepEqual([supportLine.Quantity, supportLine.BillingFrequency, supportLine.EndDate], [1, "Quarterly", "2028-06-30"]);
  assert.equal(lines.filter(l => l.PricebookEntryId === org.ids.pbePremium && !l.QuoteActionId).length, 1, "the add-on is added once");
  assert.equal(org.byId("Asset", org.ids.laptop)!.CurrentQuantity, 4);
  assert.equal(org.byId("Asset", org.ids.support)!.CurrentQuantity, 3);
  assert.ok(t.checks.find(c => c.id === "new-assets")?.ok);
});

test("upgrade / downgrade / swap use Salesforce's dedicated Transaction Management API — never initiateAmendment + hand-set subtypes", async () => {
  const { org, ctx, deps } = setup();
  const { transaction, errors } = await save(ctx, "amend", {
    assetIds: [org.ids.support], effectiveDate: TODAY,
    changes: [{ assetId: org.ids.support, quantityChange: 0, swap: { kind: "upgrade", productId: org.ids.pPremium, productName: "Support Premium", pricebookEntryId: org.ids.pbePremium, quantity: 2 } }],
  });
  assert.deepEqual(errors, []);
  assert.match(transaction.steps[0].label, /Upgrade API/);
  assert.equal(transaction.steps.find(s => s.id === "apply-changes")!.status, "skipped", "Salesforce builds the whole replacement quote");
  const t = await runAll(ctx, deps, transaction.id);
  assert.equal(t.status, "completed");
  assert.equal(postsTo(org, "initiateAmendment").length, 0);
  const sent = org.calls.find(c => c.method === "POST" && c.path.endsWith("/assets/actions/upgrade"))!.body as { swapStartDate: string; outputRecordType: string; swapGroups: { groups: { outGroup: { swapAssets: { assetId: string; quantity: number }[] }; inGroup: { records: { record: Record<string, unknown> }[] } }[] } };
  assert.equal(sent.swapStartDate, `${TODAY}T00:00:00.000Z`);
  assert.equal(sent.outputRecordType, "Quote");
  assert.deepEqual(sent.swapGroups.groups[0].outGroup.swapAssets, [{ assetId: org.ids.support, quantity: 2 }]);
  const inRec = sent.swapGroups.groups[0].inGroup.records[0].record;
  assert.deepEqual([inRec.Product2Id, inRec.PricebookEntryId, inRec.Quantity, inRec.UnitPrice, typeof inRec.Quantity], [org.ids.pPremium, org.ids.pbePremium, 2, 80, "number"], "numbers, never strings (documented)");
  assert.equal(org.calls.filter(c => c.path.endsWith("/place") && (c.body as { graph?: { records?: { record?: { attributes?: { type?: string } } }[] } } | undefined)?.graph?.records?.[0]?.record?.attributes?.type !== "Order").length, 0, "no quote action subtype patched by the app (the only Place request is the ORDER re-pricing)");
  assert.equal(org.byId("Asset", org.ids.support)!.CurrentQuantity, 0);
  assert.ok(t.checks.find(c => c.id === "new-assets")?.ok);
  assert.match(t.checks.find(c => c.id === "relationship")!.detail, /Support → Support Premium \(Upgrade\)/);
  // One replacement kind per request; nothing mixed in; partial quantity given up allowed.
  const mixed = await save(ctx, "amend", { assetIds: [org.ids.laptop, org.ids.backup], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }, { assetId: org.ids.backup, quantityChange: 0, swap: { kind: "downgrade", productId: org.ids.pPremium, productName: "x", pricebookEntryId: org.ids.pbePremium, quantity: 1 } }] });
  assert.ok(mixed.errors.some(e => /every selected asset must be an downgrade/.test(e)));
  const partial = await save(ctx, "amend", { assetIds: [org.ids.backup], effectiveDate: TODAY, changes: [{ assetId: org.ids.backup, quantityChange: 0, swap: { kind: "swap", productId: org.ids.pPremium, productName: "x", pricebookEntryId: org.ids.pbePremium, quantity: 1, outQuantity: 1 } }] });
  assert.deepEqual(partial.errors, []);
  assert.equal(previewRows(partial.transaction)[0].resultingQuantity, 2);
  const none = setup({ missingAction: "downgrade" });
  const dn = await save(none.ctx, "amend", { assetIds: [none.org.ids.support], effectiveDate: TODAY, changes: [{ assetId: none.org.ids.support, quantityChange: 0, swap: { kind: "downgrade", productId: none.org.ids.pPremium, productName: "x", pricebookEntryId: none.org.ids.pbePremium, quantity: 1 } }] });
  const failed = await executeStep(none.ctx, dn.transaction.id, "initiate", true, none.deps);
  assert.match(failed.steps[0].message!, /no downgrade resource/);
});

test("price-only amendment (quantityChange 0 → Salesforce's 'No Change' line, as observed live) completes; the open quote blocks duplicates", async () => {
  const { org, ctx, deps } = setup();
  const { transaction, errors } = await save(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 0, discount: 10 }] });
  assert.deepEqual(errors, []);
  let t = await executeStep(ctx, transaction.id, "initiate", true, deps);
  t = await executeStep(ctx, transaction.id, "await-quote", false, deps);
  assert.equal(t.steps[1].status, "completed", t.steps[1].message ?? "");
  const line = org.db.QuoteLineItem.find(l => l.QuoteId === t.sf.quoteId)!;
  assert.equal(org.byId("QuoteAction", line.QuoteActionId)!.Type, "No Change");
  t = await runAll(ctx, deps, transaction.id);
  assert.equal(t.status, "completed");
  assert.equal(org.db.QuoteLineItem.find(l => l.QuoteId === t.sf.quoteId)!.Discount, 10);
  // While such a quote has no order, the asset is held by it ("No Change" lines count as open).
  const other = setup();
  await other.org.api.call("POST", "/actions/standard/initiateAmendment", { inputs: [{ amendAssetIds: [other.org.ids.laptop], amendStartDate: `${TODAY}T00:00:00.000Z`, quantityChange: 0, amendOutputType: "Quote" }] });
  const blocked = await saveTransaction(other.ctx, { kind: "cancel", accountId: other.org.ids.acct, assetIds: [other.org.ids.laptop], effectiveDate: TODAY }, TODAY);
  assert.ok(blocked.errors.some(e => /open Amend quote/.test(e)), blocked.errors.join(" | "));
});

test("distinct operations: reducing an asset to 0 is a cancellation, not an amendment; cancellation shows no invented credit", async () => {
  const { org, ctx } = setup();
  const toZero = await save(ctx, "amend", { assetIds: [org.ids.support], effectiveDate: TODAY, changes: [{ assetId: org.ids.support, quantityChange: -2 }] });
  assert.ok(toZero.errors.some(e => /use Cancellations \(initiateCancellation\)/.test(e)));
  const partial = await save(ctx, "amend", { assetIds: [org.ids.support], effectiveDate: TODAY, changes: [{ assetId: org.ids.support, quantityChange: -1 }] });
  assert.deepEqual(partial.errors, [], "a partial reduction is an amendment (Downsells)");
  const cancel = await save(ctx, "cancel", { assetIds: [org.ids.laptop], effectiveDate: TODAY });
  assert.equal(previewRows(cancel.transaction)[0].estimatedChange, null, "credits come from Salesforce's priced quote only");
});

test("bundles are read from AssetRelationship (BundleComponent) too, and back-dated changes are flagged", async () => {
  const { org } = setup();
  org.db.AssetRelationship.push({ Id: "0aRA00000000001AAA", AssetId: org.ids.suite, RelatedAssetId: org.ids.backup, RelatedAssetRole: "BundleComponent", AssetRole: "Bundle", RelationshipType: null });
  const f = await facts(org, [org.ids.suite, org.ids.backup]);
  assert.ok(f.get(org.ids.suite)!.childIds.includes(org.ids.backup));
  assert.equal(f.get(org.ids.backup)!.parentId, org.ids.suite);
  assert.ok(assetEligibility(f.get(org.ids.backup)!, "cancel", { accountId: null, contractId: null, effectiveDate: null, today: TODAY }).some(r => r.code === "CHILD_ASSET"));
  const laptop = (await facts(org, [org.ids.laptop])).get(org.ids.laptop)!;
  assert.ok(assetEligibility(laptop, "amend", { accountId: null, contractId: null, effectiveDate: "2025-12-01", today: TODAY }).some(r => r.code === "BEFORE_LAST_CHANGE" && r.severity === "warning"));
});

test("amendment: usage asset goes quote-first; start-date adjustment sends actionSubtype; preview + validation guard bad plans", async () => {
  const { org, ctx, deps } = setup();
  const { transaction } = await save(ctx, "amend", { assetIds: [org.ids.api], effectiveDate: "2026-11-11", changes: [{ assetId: org.ids.api, quantityChange: 1 }] });
  await runAll(ctx, deps, transaction.id);
  assert.equal((postsTo(org, "initiateAmendment")[0].body as { inputs: Record<string, unknown>[] }).inputs[0].amendOutputType, "Quote");
  const sda = await save(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: "2026-12-01", amendSubtype: "StartDateAdjustment", changes: [] });
  assert.deepEqual(sda.errors, []);
  const r = initiateRequest(sda.transaction).inputs[0];
  assert.equal(r.actionSubtype, "StartDateAdjustment"); assert.equal(r.quantityChange, 0);
  const bad = await save(ctx, "amend", { assetIds: [org.ids.laptop, org.ids.old, org.ids.addon], effectiveDate: "2026-11-11", changes: [{ assetId: org.ids.laptop, quantityChange: -10 }, { assetId: org.ids.old, quantityChange: 1 }] });
  assert.ok(bad.errors.some(e => /would leave -4/.test(e)));
  assert.ok(bad.errors.some(e => /ended on 2026-06-30/.test(e)));
  assert.ok(bad.errors.some(e => /bundle component/.test(e)));
  const p = previewRows({ ...transaction, changes: [{ assetId: org.ids.api, quantityChange: 2, unitPrice: 12 }] })[0];
  assert.deepEqual([p.originalQuantity, p.resultingQuantity, p.estimatedChange], [1, 3, 26]);
});

test("amendment: line changes modified after the quote exists are re-applied; assets / dates are frozen", async () => {
  const { org, ctx, deps } = setup();
  const { transaction } = await save(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: "2026-11-11", changes: [{ assetId: org.ids.laptop, quantityChange: 1 }] });
  await runAll(ctx, deps, transaction.id, "validate");
  const edited = await save(ctx, "amend", { id: transaction.id, assetIds: [org.ids.laptop], effectiveDate: "2026-11-11", changes: [{ assetId: org.ids.laptop, quantityChange: 1, unitPrice: 950 }] });
  assert.equal(edited.transaction.steps.find(s => s.id === "apply-changes")!.status, "pending");
  await assert.rejects(save(ctx, "amend", { id: transaction.id, assetIds: [org.ids.laptop], effectiveDate: "2026-11-20", changes: [{ assetId: org.ids.laptop, quantityChange: 1 }] }), LifecycleInputError);
  const t = await runAll(ctx, deps, transaction.id);
  assert.equal(t.status, "completed");
  assert.equal(postsTo(org, "initiateAmendment").length, 1, "never re-initiated");
  assert.equal(org.db.QuoteLineItem.find(l => l.QuoteId === t.sf.quoteId)!.UnitPrice, 950);
});

/* ───────────── renewals ───────────── */

test("renewal: term asset renewed with dates, negotiated price + discount; the asset's lifecycle end is extended", async () => {
  const { org, ctx, deps } = setup();
  const { transaction, errors } = await save(ctx, "renew", { assetIds: [org.ids.backup], effectiveDate: "2026-12-16", renewal: { termMonths: 24 }, contractId: null, changes: [{ assetId: org.ids.backup, quantityChange: 0, unitPrice: 18, discount: 10 }] });
  assert.deepEqual(errors, []);
  assert.deepEqual(renewalWindow(transaction), { start: "2026-12-16", end: "2028-12-15" });
  const t = await runAll(ctx, deps, transaction.id);
  assert.equal(t.status, "completed");
  assert.deepEqual((postsTo(org, "initiateRenewal")[0].body as { inputs: Record<string, unknown>[] }).inputs[0], { renewAssetIds: [org.ids.backup], renewOutputType: "Quote", skipPricing: false, renewStartDate: "2026-12-16T00:00:00.000Z", renewEndDate: "2028-12-15T23:59:59.000Z" }, "end-of-day end, as Salesforce stores lifecycle ends");
  const line = org.db.QuoteLineItem.find(l => l.QuoteId === t.sf.quoteId)!;
  assert.deepEqual([line.UnitPrice, line.Discount, line.NetUnitPrice], [18, 10, 16.2]);
  assert.match(String(org.byId("Asset", org.ids.backup)!.LifecycleEndDate), /^2028-12-15/);
  assert.equal(org.byId("Order", t.sf.orderId)!.OriginalActionType, "Renew");
  assert.ok(t.checks.find(c => c.id === `end-${org.ids.backup}`)?.ok);
});

test("renewal: Salesforce default dates, no price change → edit step skipped; expired asset needs a start date ≥ today; one-time / evergreen refused", async () => {
  const { org, ctx, deps } = setup();
  const { transaction } = await save(ctx, "renew", { assetIds: [org.ids.support], renewal: {}, changes: [] });
  assert.equal(transaction.steps.find(s => s.id === "apply-changes")!.status, "skipped");
  assert.deepEqual(initiateRequest(transaction).inputs[0], { renewAssetIds: [org.ids.support], renewOutputType: "Quote", skipPricing: false });
  const t = await runAll(ctx, deps, transaction.id);
  assert.equal(t.status, "completed");
  assert.equal(org.calls.filter(c => c.path.endsWith("/place") && (c.body as { graph?: { records?: { record?: { attributes?: { type?: string } } }[] } } | undefined)?.graph?.records?.[0]?.record?.attributes?.type !== "Order").length, 0, "nothing edited and Salesforce priced the quote on creation — no QUOTE reprice sent");
  assert.ok((await save(ctx, "renew", { assetIds: [org.ids.old], renewal: {} })).errors.some(e => /expired — set a renewal start date/.test(e)));
  assert.deepEqual((await save(ctx, "renew", { assetIds: [org.ids.old], effectiveDate: TODAY, renewal: { termMonths: 12 } })).errors, []);
  const expiredDraft = (await save(ctx, "renew", { assetIds: [org.ids.old], renewal: {} })).transaction;
  assert.ok(validateTransaction(expiredDraft, null, TODAY).some(e => /has expired \(2026-06-30\)/.test(e)), "the wizard (no fresh facts) also catches it");
  const refused = await save(ctx, "renew", { assetIds: [org.ids.laptop, org.ids.hosting], renewal: {} });
  assert.ok(refused.errors.some(e => /One-Time/.test(e)) && refused.errors.some(e => /Evergreen/.test(e)));
  assert.equal(termEnd("2026-12-16", 24), "2028-12-15");
});

test("renewal: ramp options are sent as RampOptionInputRepresentation and refused where the org lacks the input", async () => {
  const { org, ctx } = setup();
  const { transaction, errors } = await save(ctx, "renew", { assetIds: [org.ids.support], effectiveDate: "2028-01-01", renewal: { termMonths: 36, ramp: { segmentType: "Custom", durationInMonths: 36, segmentCount: 3 } } });
  assert.deepEqual(errors, []);
  assert.deepEqual(initiateRequest(transaction).inputs[0].rampOptionsDetails, { segmentType: "Custom", durationInMonths: 36, segmentCount: 3 });
  const v = validateTransaction(transaction, null, TODAY, { actionInputs: ["renewAssetIds", "renewOutputType"] });
  assert.ok(v.some(e => /no rampOptionsDetails input/.test(e)));
  assert.ok(validateTransaction({ ...transaction, renewal: { endDate: null, termMonths: 12, ramp: { segmentType: "Custom", durationInMonths: 12, segmentCount: 0 } } }, null, TODAY).some(e => /segment count/.test(e)));
});

/* ───────────── cancellations ───────────── */

test("cancellation: immediate full cancellation with a reason field — asset quantity 0 and the billing schedule group shows the cancellation", async () => {
  const { org, ctx, deps } = setup({ reasonField: true });
  const { transaction, errors } = await save(ctx, "cancel", { assetIds: [org.ids.support], effectiveDate: TODAY, cancel: { reason: "Budget", reasonField: "Quote.Cancellation_Reason__c" } });
  assert.deepEqual(errors, []);
  assert.equal(transaction.steps.find(s => s.id === "apply-changes")!.status, "pending");
  const p = previewRows(transaction)[0];
  assert.deepEqual([p.resultingQuantity, p.remainingDays], [0, 416]);
  const t = await runAll(ctx, deps, transaction.id);
  assert.equal(t.status, "completed");
  assert.deepEqual((postsTo(org, "initiateCancellation")[0].body as { inputs: Record<string, unknown>[] }).inputs[0], { cancelAssetIds: [org.ids.support], cancelStartDate: `${TODAY}T00:00:00.000Z`, cancelOutputType: "Quote", skipPricing: false });
  assert.equal(org.byId("Quote", t.sf.quoteId)!.Cancellation_Reason__c, "Budget");
  assert.equal(org.byId("Asset", org.ids.support)!.CurrentQuantity, 0);
  assert.ok(t.checks.find(c => c.id === `billing-${org.ids.support}`)?.ok, "billing schedule group cancellation date read back");
  assert.ok(t.checks.find(c => c.id === `action-${org.ids.support}`)?.ok);
});

test("cancellation: future-dated keeps the quantity until the date; one price book per request; already-cancelled / non-lifecycle refused", async () => {
  const { org, ctx, deps } = setup();
  const { transaction } = await save(ctx, "cancel", { assetIds: [org.ids.support], effectiveDate: "2027-03-01" });
  assert.equal(transaction.steps.find(s => s.id === "apply-changes")!.status, "skipped", "no reason field in this org — nothing to write on the quote");
  const t = await runAll(ctx, deps, transaction.id);
  assert.equal(t.status, "completed");
  assert.equal(org.byId("Asset", org.ids.support)!.CurrentQuantity, 2, "future-dated: Salesforce keeps the quantity until the cancellation date");
  assert.ok((await save(ctx, "cancel", { assetIds: [org.ids.laptop, org.ids.hosting], effectiveDate: TODAY })).errors.some(e => /ONE price book per request/.test(e)));
  assert.ok((await save(ctx, "cancel", { assetIds: [org.ids.plain], effectiveDate: TODAY })).errors.some(e => /isn't lifecycle-managed/.test(e)));
  assert.ok(lineChangePlan({ ...transaction, cancel: { reason: "x", reasonField: null } }, []).errors.length > 0, "a quote without Cancel lines is reported");
});

/* ───────────── safety: duplicates, resume, failures, guards ───────────── */

test("never initiated twice: a lost initiate response is recovered from Salesforce; an existing order is adopted, not re-created", async () => {
  const { org, ctx, deps } = setup({ loseInitiateResponse: true });
  const { transaction } = await save(ctx, "cancel", { assetIds: [org.ids.laptop], effectiveDate: TODAY });
  const first = await executeStep(ctx, transaction.id, "initiate", true, deps);
  assert.equal(first.steps[0].status, "failed");
  assert.ok(first.sf.initiatedAt, "the send is remembered");
  const again = await executeStep(ctx, transaction.id, "initiate", true, deps);
  assert.equal(again.steps[0].status, "completed");
  assert.match(again.steps[0].message!, /Recovered/);
  assert.equal(postsTo(org, "initiateCancellation").length, 1, "the action was sent exactly once");
  // An order that already exists for the quote is adopted.
  await runAll(ctx, deps, transaction.id, "validate");
  await org.api.call("POST", "/actions/standard/createOrderFromQuote", { inputs: [{ quoteRecordId: again.sf.quoteId }] });
  const t = await executeStep(ctx, transaction.id, "create-order", true, deps);
  assert.match(t.steps.find(s => s.id === "create-order")!.message!, /adopted/);
  assert.equal(postsTo(org, "createOrderFromQuote").length, 1);
});

test("duplicates: assets in an unfinished app transaction or an open Salesforce lifecycle quote can't start another", async () => {
  const { org, ctx, deps } = setup();
  const { transaction } = await save(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }] });
  await runAll(ctx, deps, transaction.id, "await-quote");
  await assert.rejects(save(ctx, "cancel", { assetIds: [org.ids.laptop], effectiveDate: TODAY }), /already in amendment/);
  const other = setup();
  const quote = (await other.org.api.call("POST", "/actions/standard/initiateRenewal", { inputs: [{ renewAssetIds: [other.org.ids.support], renewOutputType: "Quote" }] })).body as { outputValues: Record<string, string> }[];
  assert.ok(quote[0].outputValues.renewRecordId);
  const blocked = await saveTransaction(other.ctx, { kind: "cancel", accountId: other.org.ids.acct, assetIds: [other.org.ids.support], effectiveDate: TODAY }, TODAY);
  assert.ok(blocked.errors.some(e => /open Renew quote/.test(e)), "an open renewal quote made outside the app blocks the cancellation");
});

test("writes need confirmation; steps run in order; activation refuses an order from another quote / of another type", async () => {
  const { org, ctx, deps } = setup();
  const { transaction } = await save(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }] });
  await assert.rejects(executeStep(ctx, transaction.id, "initiate", false, deps), /confirm it first/);
  await assert.rejects(executeStep(ctx, transaction.id, "price", true, deps), /Run the steps in order/);
  assert.equal(org.calls.filter(c => c.method === "POST").length, 0, "nothing sent");
  const t = await runAll(ctx, deps, transaction.id, "prepare-billing");
  // Point the transaction at an order from ANOTHER quote: activation must refuse it.
  const foreign = org.db.Order.find(o => o.OrderNumber === "00000001")!;
  await ctx.store.update(ORG, d => { d.transactions = d.transactions.map(x => (x.id === t.id ? { ...x, sf: { ...x.sf, orderId: foreign.Id } } : x)); });
  const refused = await executeStep(ctx, transaction.id, "activate", true, deps, { activationConfirmed: true });
  assert.equal(refused.steps.find(s => s.id === "activate")!.status, "failed");
  assert.match(refused.steps.find(s => s.id === "activate")!.message!, /wasn't created from this amendment quote/);
  assert.equal(foreign.Status, "Activated", "the original order is untouched");
});

test("Salesforce failures keep Salesforce's message; dropped changes fail validation; no assetization stays 'waiting' (never a false success)", async () => {
  {
    const { org, ctx, deps } = setup({ rejectInitiate: "Asset 02i… isn't eligible for renewal." });
    const { transaction } = await save(ctx, "renew", { assetIds: [org.ids.support], renewal: {} });
    const t = await executeStep(ctx, transaction.id, "initiate", true, deps);
    assert.equal(t.steps[0].status, "failed");
    assert.match(t.steps[0].message!, /isn't eligible for renewal/);
    assert.equal(t.sf.initiatedAt, null, "a rejected request can be fixed and sent again");
  }
  {
    const { org, ctx, deps } = setup({ dropLineFields: ["UnitPrice"] });
    const { transaction } = await save(ctx, "renew", { assetIds: [org.ids.support], renewal: {}, changes: [{ assetId: org.ids.support, quantityChange: 0, unitPrice: 1 }] });
    await runAll(ctx, deps, transaction.id, "await-quote");
    const t = await executeStep(ctx, transaction.id, "apply-changes", true, deps);
    assert.equal(t.steps.find(s => s.id === "apply-changes")!.status, "failed");
    assert.match(t.steps.find(s => s.id === "apply-changes")!.message!, /didn't keep every change/);
  }
  {
    const { org, ctx, deps } = setup({ noAssetization: true });
    const { transaction } = await save(ctx, "cancel", { assetIds: [org.ids.laptop], effectiveDate: TODAY });
    await runAll(ctx, deps, transaction.id, "activate");
    const t = await executeStep(ctx, transaction.id, "verify", false, deps);
    assert.equal(t.steps.find(s => s.id === "verify")!.status, "waiting");
    assert.notEqual(t.status, "completed");
  }
  {
    const { org, ctx, deps } = setup({ missingAction: "initiateCancellation" });
    const { transaction } = await save(ctx, "cancel", { assetIds: [org.ids.laptop], effectiveDate: TODAY });
    const t = await executeStep(ctx, transaction.id, "initiate", true, deps);
    assert.match(t.steps[0].message!, /initiateCancellation isn't available/);
    assert.equal(org.calls.filter(c => c.method === "POST").length, 0);
  }
});

/* ───────────── integrated ───────────── */

test("integrated: amend → renew → cancel the same asset in sequence; each transaction is listed with its Salesforce quote + order", async () => {
  const { org, ctx, deps } = setup();
  const a = await save(ctx, "amend", { assetIds: [org.ids.support], effectiveDate: TODAY, changes: [{ assetId: org.ids.support, quantityChange: 1 }] });
  assert.equal((await runAll(ctx, deps, a.transaction.id)).status, "completed");
  const r = await save(ctx, "renew", { assetIds: [org.ids.support], effectiveDate: "2028-01-01", renewal: { termMonths: 12 } });
  assert.deepEqual(r.errors, []);
  assert.equal((await runAll(ctx, deps, r.transaction.id)).status, "completed");
  assert.match(String(org.byId("Asset", org.ids.support)!.LifecycleEndDate), /^2028-12-31/);
  const c = await save(ctx, "cancel", { assetIds: [org.ids.support], effectiveDate: TODAY });
  assert.deepEqual(c.errors, []);
  assert.equal((await runAll(ctx, deps, c.transaction.id)).status, "completed");
  assert.equal(org.byId("Asset", org.ids.support)!.CurrentQuantity, 0);
  const detail = (await assetDetail(org.api, org.ids.support, TODAY))!;
  assert.deepEqual(detail.actions.map(x => x.category).sort(), ["Cancellations", "Initial Sale", "Renewals", "Upsells"]);
  assert.deepEqual(detail.transactions.filter(x => x.source === "Quote").map(x => x.type).sort(), ["Amend", "Cancel", "Renew"]);
  for (const kind of ["amend", "renew", "cancel"] as LifecycleKind[]) {
    const sf = await salesforceTransactions(org.api, kind, org.ids.acct);
    assert.equal(sf.length, 1, kind);
    assert.equal(sf[0].order?.status, "Activated");
  }
  const audit = (await ctx.store.load(ORG)).audit;
  assert.ok(audit.filter(x => x.action === "activate" && x.status === "success").length === 3, "full transaction history kept");
});
