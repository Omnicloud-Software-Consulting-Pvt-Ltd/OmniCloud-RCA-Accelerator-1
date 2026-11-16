/**
 * Asset Lifecycle — prompt extraction, Salesforce record resolution, preview validation and one-click execution (executor) against the
 * in-memory org (fakeOrg — MOCKED; nothing here talks to Salesforce or an AI provider).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeExtraction, parseDatePhrase, ruleExtract } from "./ai";
import { executeLifecycle, type ExecutionTarget } from "./executor";
import { resolvePrompt } from "./server/ai";
import { fakeLifecycleOrg, type FakeOptions } from "./server/fakeOrg";
import { LifecycleStore } from "./server/store";
import { executeStep, saveTransaction, type LifecycleCtx } from "./server/service";
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
  const ctx: LifecycleCtx = { api: org.api, orgId: ORG, userId: "005A00000000001AAA", store: new LifecycleStore(mkdtempSync(join(tmpdir(), "lifecycle-ai-"))) };
  const deps: LifecycleDeps = { now: () => new Date().toISOString(), sleep: async () => {}, waitMs: 0, today: () => TODAY, activate: org.activate, billing: org.billing };
  return { org, ctx, deps };
}
const resolve = (org: ReturnType<typeof fakeLifecycleOrg>, prompt: string, kindHint: LifecycleKind | null = null) =>
  resolvePrompt(org.api, normalizeExtraction(ruleExtract(prompt, TODAY)), { prompt, kindHint, today: TODAY, engine: "rules" });

/* ───────────── extraction ───────────── */

test("rules extraction: the three documented prompt shapes", () => {
  const a = ruleExtract("Create an amendment for ABC Corporation named Laptop Upgrade Amendment. Increase Laptop quantity from 2 to 5 and apply a 10% discount effective today.", TODAY);
  assert.equal(a.kind, "amend");
  assert.equal(a.name, "Laptop Upgrade Amendment");
  assert.equal(a.accountName, "ABC Corporation");
  assert.equal(a.discount, 10);
  assert.equal(a.effectiveDate, TODAY);
  const item = (a.items as Record<string, unknown>[])[0];
  assert.deepEqual([item.fromQuantity, item.toQuantity, item.swap], [2, 5, null], "a NAME containing 'Upgrade' is not an upgrade");
  // Names that end in (or contain) a verb stay whole; a verb that starts a clause still ends the name.
  assert.equal(ruleExtract("Create an amendment for Any Partner Inc named Printer Increase. Increase Printer quantity from 1 to 3 effective today.", TODAY).name, "Printer Increase");
  assert.equal(ruleExtract("Create an amendment named Q4 deal increase Printer by 2 for Acme effective today.", TODAY).name, "Q4 deal");
  assert.equal(ruleExtract("Amend Acme's Printer, named \"Renew, then cancel\". Increase Printer by 1.", TODAY).name, "Renew, then cancel");
  const r = ruleExtract("Renew API Access Premium for ABC Corporation for another 12 months starting December 1, 2026.", TODAY);
  assert.equal(r.kind, "renew");
  assert.equal(r.accountName, "ABC Corporation");
  assert.deepEqual(r.renewal, { startDate: "2026-12-01", termMonths: 12, endDate: null });
  const c = ruleExtract("Cancel the Headset asset for ABC Corporation effective today.", TODAY);
  assert.deepEqual([c.kind, c.accountName, c.effectiveDate], ["cancel", "ABC Corporation", TODAY]);
  const u = ruleExtract("Upgrade Support to Support Premium for ABC Corporation effective 2026-12-01.", TODAY);
  assert.deepEqual((u.items as Record<string, unknown>[])[0].swap, { kind: "upgrade", productName: "Support Premium", quantity: null });
  assert.equal((ruleExtract("Renew Backup for ABC for 2 years", TODAY).renewal as { termMonths: number }).termMonths, 24);
});

test("date phrases and validation: Ids are never accepted from a prompt; out-of-range values are rejected, not guessed", () => {
  assert.equal(parseDatePhrase("tomorrow", TODAY), "2026-11-12");
  assert.equal(parseDatePhrase("1 Dec 2026", TODAY), "2026-12-01");
  assert.equal(parseDatePhrase("12/01/2026", TODAY), "2026-12-01");
  assert.equal(parseDatePhrase("February 30, 2026", TODAY), null);
  const x = normalizeExtraction({ kind: "amend", accountName: "001A00000000001AAA", items: [{ name: "Laptop", discount: 150, toQuantity: 2.5, endDate: "next year" }], effectiveDate: "2026-13-01" });
  assert.equal(x.accountName, null);
  assert.ok(x.rejected.some(r => /looks like a record Id/.test(r)));
  assert.ok(x.rejected.some(r => /150% is outside/.test(r)));
  assert.ok(x.rejected.some(r => /isn't a valid whole quantity/.test(r)));
  assert.ok(x.rejected.some(r => /isn't a valid date/.test(r)));
  assert.equal(x.effectiveDate, null);
  assert.equal(normalizeExtraction({ kind: "transfer" }).kind, null, "only the three lifecycles");
});

/* ───────────── resolution against Salesforce ───────────── */

test("amendment prompt resolves account + asset from Salesforce; the change is computed from Salesforce's quantity, mismatches flagged", async () => {
  const { org } = setup();
  const r = await resolve(org, "Create an amendment for Test Account named Laptop Bump. Increase Laptop quantity from 2 to 8 and apply a 10% discount effective today.", "amend");
  assert.equal(r.kind, "amend");
  assert.deepEqual(r.prefill.account, { id: org.ids.acct, name: "Test Account" });
  assert.equal(r.prefill.name, "Laptop Bump");
  assert.deepEqual(r.prefill.assets.map(a => a.id), [org.ids.laptop]);
  assert.deepEqual(r.prefill.changes, [{ assetId: org.ids.laptop, quantityChange: 2, discount: 10 }], "Salesforce has 6 → 8 is +2");
  assert.ok(r.issues.some(i => i.status === "invalid" && /prompt says Laptop is at 2, but Salesforce shows 6/.test(i.message)));
  assert.ok(r.fields.some(f => f.source === "salesforce" && f.label === "Account") && r.fields.some(f => f.source === "derived"));
  assert.equal(r.prefill.effectiveDate, TODAY);
});

test("renewal + cancellation prompts; multiple assets; lifecycle rules surface as unsupported; kind mismatch is reported", async () => {
  const { org } = setup();
  const rn = await resolve(org, "Renew Backup for Test Account for another 12 months starting December 16, 2026.", "renew");
  assert.deepEqual([rn.prefill.assets[0]?.name, rn.prefill.effectiveDate, rn.prefill.renewal?.termMonths], ["Backup", "2026-12-16", 12]);
  assert.equal(rn.issues.filter(i => i.status !== "warning").length, 0, JSON.stringify(rn.issues));
  const one = await resolve(org, "Renew Laptop for Test Account for 12 months starting today.", "renew");
  assert.ok(one.issues.some(i => i.status === "unsupported" && /One-Time/.test(i.message)), "One-Time can't be renewed — reported, not hidden");
  const cn = await resolve(org, "Cancel the Hosting asset for Test Account effective today.", "cancel");
  assert.deepEqual([cn.kind, cn.prefill.assets[0]?.name, cn.prefill.effectiveDate, cn.prefill.changes.length], ["cancel", "Hosting", TODAY, 0]);
  const multi = await resolve(org, "Increase Laptop and Support by 1 for Test Account effective today.", "amend");
  assert.deepEqual(multi.prefill.assets.map(a => a.name).sort(), ["Laptop", "Support"]);
  assert.ok(multi.prefill.changes.every(c => c.quantityChange === 1));
  const mismatch = await resolve(org, "Cancel the Hosting asset for Test Account effective today.", "renew");
  assert.equal(mismatch.kindMismatch, true);
  assert.equal(mismatch.kind, "cancel");
  const partial = await resolve(org, "Reduce Laptop by 2 and cancel it for Test Account effective today.", "cancel");
  assert.ok(partial.issues.some(i => i.status === "unsupported" && /partial reduction/.test(i.message)));
});

test("unknown / ambiguous / missing records are reported with real candidates — never invented", async () => {
  const { org } = setup();
  const nf = await resolve(org, "Cancel the Headset asset for Nobody Corp effective today.", "cancel");
  assert.equal(nf.prefill.account, null);
  assert.ok(nf.issues.some(i => i.field === "Account" && i.status === "not-found"));
  org.db.Account.push({ Id: "001A00000000003AAA", Name: "Test Accounting Ltd" });
  const partial = await resolve(org, "Cancel the Hosting asset for Test Acc effective today.", "cancel");
  assert.equal(partial.prefill.account?.id, org.ids.acct, "two partial matches → the one that owns lifecycle assets");
  org.db.Account.push({ Id: "001A00000000004AAA", Name: "Acme" }, { Id: "001A00000000005AAA", Name: "Acme Labs" });
  const amb = await resolve(org, "Cancel the Hosting asset for Acm effective today.", "cancel");
  assert.ok(amb.issues.some(i => i.field === "Account" && i.status === "ambiguous" && i.candidates?.length === 2), "no lifecycle assets to break the tie → the user chooses");
  org.db.Account.push({ Id: "001A00000000002AAA", Name: "Test Account" });
  const twoExact = await resolve(org, "Cancel the Hosting asset for Test Account effective today.", "cancel");
  assert.equal(twoExact.prefill.account?.id, org.ids.acct, "two exact matches → the one that owns lifecycle assets");
  const noAsset = await resolve(org, "Cancel the Spaceship for Test Account effective today.", "cancel");
  assert.ok(noAsset.issues.some(i => i.field === "Assets" && i.status === "missing" && (i.candidates?.length ?? 0) > 0));
  const noDate = await resolve(org, "Cancel the Hosting asset for Test Account.", "cancel");
  assert.ok(noDate.issues.some(i => i.field === "Effective date" && i.status === "missing"));
  const ai = await resolvePrompt(org.api, normalizeExtraction({ kind: "amend", accountName: "Test Account", items: [{ name: "Laptop", toQuantity: 0 }], effectiveDate: TODAY }), { prompt: "", kindHint: "amend", today: TODAY, engine: "ai" });
  assert.ok(ai.issues.some(i => i.status === "invalid" && /use Cancellations/.test(i.message)), "preview validation uses the module's own plan rules");
});

/* ───────────── one-click execution ───────────── */

async function draft(ctx: LifecycleCtx, kind: LifecycleKind, body: Record<string, unknown>) {
  const { transaction, errors } = await saveTransaction(ctx, { kind, accountId: "001A00000000001AAA", billing: await defaultBilling(ctx), ...body }, TODAY);
  assert.deepEqual(errors, []);
  return transaction;
}
function run(ctx: LifecycleCtx, deps: LifecycleDeps, tx: LifecycleTransaction, target: ExecutionTarget, opts: { activate?: boolean; trace?: StepId[]; maxPolls?: number; flaky?: number } = {}) {
  let flaky = opts.flaky ?? 0;
  return executeLifecycle(tx, {
    target, sleep: async () => {}, pollMs: 0, maxPolls: opts.maxPolls ?? 5,
    confirmActivation: async () => opts.activate ?? false,
    runStep: async (step, o) => {
      if (flaky-- > 0) throw new TypeError("fetch failed");
      opts.trace?.push(step);
      return executeStep(ctx, tx.id, step, o.confirmed, deps, { activationConfirmed: o.activationConfirmed });
    },
  });
}

test("one click per lifecycle: the right Salesforce operation and step order; stops where asked; activation needs its own confirmation", async () => {
  const cases: { kind: LifecycleKind; body: (ids: ReturnType<typeof fakeLifecycleOrg>["ids"]) => Record<string, unknown>; endpoint: string; skipped: StepId[] }[] = [
    { kind: "amend", body: ids => ({ assetIds: [ids.laptop], effectiveDate: TODAY, changes: [{ assetId: ids.laptop, quantityChange: 1 }] }), endpoint: "/actions/standard/initiateAmendment", skipped: ["apply-changes"] },
    { kind: "amend", body: ids => ({ assetIds: [ids.support], effectiveDate: TODAY, changes: [{ assetId: ids.support, quantityChange: 0, swap: { kind: "upgrade", productId: ids.pPremium, productName: "Support Premium", pricebookEntryId: ids.pbePremium, quantity: 2 } }] }), endpoint: "/assets/actions/upgrade", skipped: ["apply-changes"] },
    { kind: "renew", body: ids => ({ assetIds: [ids.support], renewal: {}, changes: [{ assetId: ids.support, quantityChange: 0, discount: 5 }] }), endpoint: "/actions/standard/initiateRenewal", skipped: [] },
    { kind: "cancel", body: ids => ({ assetIds: [ids.laptop], effectiveDate: TODAY }), endpoint: "/actions/standard/initiateCancellation", skipped: ["apply-changes"] },
  ];
  for (const c of cases) {
    const { org, ctx, deps } = setup();
    const tx = await draft(ctx, c.kind, c.body(org.ids));
    const trace: StepId[] = [];
    const toOrder = await run(ctx, deps, tx, "order", { trace });
    assert.equal(toOrder.status, "stopped", `${c.kind}: ${toOrder.message}`);
    assert.equal(toOrder.step, "activate");
    assert.deepEqual(trace, (["initiate", "await-quote", "apply-changes", "price", "validate", "create-order", "prepare-billing"] as StepId[]).filter(s => !c.skipped.includes(s)), c.kind);
    assert.equal(org.calls.filter(x => x.method === "POST" && x.path.endsWith(c.endpoint)).length, 1, `${c.kind}: ${c.endpoint}`);
    assert.equal(org.db.Order.find(o => o.Id === toOrder.tx.sf.orderId)!.Status, "Draft", "nothing activated");
    const declined = await run(ctx, deps, toOrder.tx, "activate", { activate: false });
    assert.equal(declined.status, "awaiting-activation");
    assert.equal(org.db.Order.find(o => o.Id === toOrder.tx.sf.orderId)!.Status, "Draft");
    const done = await run(ctx, deps, declined.tx, "activate", { activate: true });
    assert.equal(done.status, "completed", `${c.kind}: ${done.message}`);
    assert.equal(org.db.Order.find(o => o.Id === done.tx.sf.orderId)!.Status, "Activated");
  }
});

test("the server refuses activation without its own confirmation, even with the write confirmation", async () => {
  const { org, ctx, deps } = setup();
  const tx = await draft(ctx, "cancel", { assetIds: [org.ids.laptop], effectiveDate: TODAY });
  const r = await run(ctx, deps, tx, "order");
  await assert.rejects(executeStep(ctx, tx.id, "activate", true, deps), /needs its own confirmation/);
  assert.equal(org.db.Order.find(o => o.Id === r.tx.sf.orderId)!.Status, "Draft");
});

test("failure stops dependent steps with the exact Salesforce error; resume retries that step without duplicating the quote or order", async () => {
  const opts: FakeOptions = { rejectOrder: "Required fields are missing: [BillToContactId]" };
  const { org, ctx, deps } = setup(opts);
  const tx = await draft(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }] });
  const trace: StepId[] = [];
  const failed = await run(ctx, deps, tx, "activate", { trace, activate: true });
  assert.equal(failed.status, "failed");
  assert.equal(failed.step, "create-order");
  assert.match(failed.message, /Required fields are missing: \[BillToContactId\]/);
  assert.ok(!trace.includes("activate"), "nothing after the failed step ran");
  delete opts.rejectOrder;   // the cause is fixed in Salesforce
  const resumed = await run(ctx, deps, failed.tx, "activate", { activate: true });
  assert.equal(resumed.status, "completed", resumed.message);
  assert.equal(org.calls.filter(c => c.method === "POST" && c.path.endsWith("/initiateAmendment")).length, 1, "the quote is reused");
  assert.equal(org.db.Order.filter(o => o.QuoteId === resumed.tx.sf.quoteId).length, 1, "exactly one order");
  const again = await run(ctx, deps, resumed.tx, "activate", { activate: true });
  assert.equal(again.status, "completed");
  assert.equal(org.db.Order.filter(o => o.QuoteId === resumed.tx.sf.quoteId).length, 1, "re-executing a completed transaction sends nothing");
});

test("polling: a step Salesforce hasn't finished is re-checked, never reported as success; transient network errors are retried", async () => {
  const { org, ctx, deps } = setup({ noAssetization: true });
  const tx = await draft(ctx, "cancel", { assetIds: [org.ids.laptop], effectiveDate: TODAY });
  const r = await run(ctx, deps, tx, "activate", { activate: true, maxPolls: 3 });
  assert.equal(r.status, "stopped");
  assert.equal(r.step, "verify");
  assert.notEqual(r.tx.status, "completed");
  const other = setup();
  const t2 = await draft(other.ctx, "cancel", { assetIds: [other.org.ids.laptop], effectiveDate: TODAY });
  const flaky = await run(other.ctx, other.deps, t2, "quote", { flaky: 2 });
  assert.equal(flaky.status, "stopped", flaky.message);
  assert.equal(other.org.calls.filter(c => c.method === "POST" && c.path.endsWith("/initiateCancellation")).length, 1);
});

test("an amendment whose order stayed Draft (activation refused) still holds the asset — observed live; never treated as finished", async () => {
  const { org, ctx, deps } = setup();
  const tx = await draft(ctx, "amend", { assetIds: [org.ids.laptop], effectiveDate: TODAY, changes: [{ assetId: org.ids.laptop, quantityChange: 1 }] });
  const r = await run(ctx, deps, tx, "order");
  assert.equal(org.db.Order.find(o => o.Id === r.tx.sf.orderId)!.Status, "Draft");
  // A different user / session (fresh app store) tries the same asset: Salesforce's Draft order blocks it.
  const other: LifecycleCtx = { ...ctx, store: new LifecycleStore(mkdtempSync(join(tmpdir(), "lifecycle-ai-other-"))) };
  const blocked = await saveTransaction(other, { kind: "cancel", accountId: org.ids.acct, assetIds: [org.ids.laptop], effectiveDate: TODAY }, TODAY);
  assert.ok(blocked.errors.some(e => /open Amend quote .*order \d+ Draft, not activated/.test(e)), blocked.errors.join(" | "));
  await run(ctx, deps, r.tx, "activate", { activate: true });
  const freed = await saveTransaction(other, { kind: "cancel", accountId: org.ids.acct, assetIds: [org.ids.laptop], effectiveDate: TODAY }, TODAY);
  assert.ok(!freed.errors.some(e => /open Amend quote/.test(e)), "once activated, the asset is free");
});
