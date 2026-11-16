/**
 * RAMP integration (MOCKED Salesforce — lib/ramp/server/fakeOrg.ts): Product Ramp Segment creation, line ramp and group ramp runs end to
 * end through the real service + runner + file store, resume/idempotency, failure handling, persistence and the AI resolution step.
 * Passing here is NOT live Salesforce verification (see docs/RAMP_LIVE_TEST_PLAN.md).
 * Run: `npx tsx --test lib/ramp/server/integration.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeOrg } from "./fakeOrg";
import { RampStore } from "./store";
import { createProductRampSegment } from "./productSegments";
import { saveDeal, saveSchedule, startExecution, stepExecution, retryExecution, filterHistory, RampServiceError } from "./service";
import { repriceQuote, type RunDeps } from "./runner";
import { resolveExtraction } from "./ai";
import { capabilities } from "./reads";
import { blankSchedule } from "@/lib/ramp/schedule";
import type { RampDealDraft } from "@/lib/ramp/types";

const ORG = "00Dg500000KSpiPEAT";
const tmpStore = () => new RampStore(fs.mkdtempSync(path.join(os.tmpdir(), "ramp-")));
let clock = Date.parse("2026-11-09T10:00:00Z");
const deps: RunDeps = { now: () => new Date((clock += 1000)).toISOString(), sleep: async () => undefined, waitMs: 0 };

function seed() {
  return {
    Account: [{ Id: "001A00000000001AAA", Name: "Acme" }],
    Quote: [
      { Id: "0Q0A00000000001AAA", Name: "Acme Ramp", Status: "Draft", QuoteAccountId: "001A00000000001AAA", Pricebook2Id: "01sA00000000001AAA", CalculationStatus: "NotStarted", LastPricedDate: null },
      { Id: "0Q0A00000000002AAA", Name: "Acme Group Ramp", Status: "Draft", QuoteAccountId: "001A00000000001AAA", Pricebook2Id: "01sA00000000001AAA", CalculationStatus: "NotStarted", LastPricedDate: null },
    ],
    Product2: [
      { Id: "01tA00000000001AAA", Name: "Activation Service", IsActive: true, ProductCode: "ACT", CanRamp: false, UsageModelType: null, Type: null },
      { Id: "01tA00000000002AAA", Name: "Premium Support", IsActive: true, ProductCode: "SUP", CanRamp: true, UsageModelType: null, Type: null },
      { Id: "01tA00000000003AAA", Name: "API Access", IsActive: true, ProductCode: "API", CanRamp: true, UsageModelType: "Anchor", Type: null },
    ],
    ProductSellingModel: [{ Id: "0jPA00000000001AAA", Name: "Term Based - Yearly", SellingModelType: "TermDefined", Status: "Active" }, { Id: "0jPA00000000002AAA", Name: "One Time", SellingModelType: "OneTime", Status: "Active" }],
    ProductSellingModelOption: [
      { Id: "0iOA1", Product2Id: "01tA00000000001AAA", ProductSellingModelId: "0jPA00000000001AAA" }, { Id: "0iOA2", Product2Id: "01tA00000000002AAA", ProductSellingModelId: "0jPA00000000001AAA" },
      { Id: "0iOA3", Product2Id: "01tA00000000001AAA", ProductSellingModelId: "0jPA00000000002AAA" }, { Id: "0iOA4", Product2Id: "01tA00000000003AAA", ProductSellingModelId: "0jPA00000000001AAA" },
    ],
    ProductRampSegment: [{ Id: "1FTA00000000001AAA", Name: "PPRS-1", ProductId: "01tA00000000002AAA", ProductSellingModelId: "0jPA00000000001AAA", SegmentType: "Yearly", CreatedDate: "2026-11-01" }],
    QuoteLineGroup: [{ Id: "1C9A00000000001AAA", Name: "Year 1", QuoteId: "0Q0A00000000002AAA", SortOrder: 1, IsRamped: false, SegmentType: null, StartDate: null, EndDate: null, UnitPriceUplift: null, RampUpliftType: null }],
    QuoteLineItem: [
      { Id: "0QLA00000000001AAA", QuoteId: "0Q0A00000000001AAA", Product2Id: "01tA00000000001AAA", ProductSellingModelId: "0jPA00000000001AAA", SellingModelType: "TermDefined", Quantity: 1, UnitPrice: 1000, Discount: 0, StartDate: "2026-11-09", EndDate: "2029-11-08", SubscriptionTerm: 3, PeriodBoundary: null, RampIdentifier: null, QuoteLineGroupId: null, CreatedDate: "2026-11-09" },
      { Id: "0QLA00000000002AAA", QuoteId: "0Q0A00000000002AAA", Product2Id: "01tA00000000002AAA", ProductSellingModelId: "0jPA00000000001AAA", SellingModelType: "TermDefined", Quantity: 5, UnitPrice: 100, Discount: 0, StartDate: "2027-01-01", EndDate: "2027-12-31", PeriodBoundary: "Anniversary", RampIdentifier: null, QuoteLineGroupId: "1C9A00000000001AAA", CreatedDate: "2026-11-09" },
    ],
  };
}

const sched = (o: Partial<ReturnType<typeof blankSchedule>> = {}) => { const { id: _i, createdAt: _c, updatedAt: _u, createdBy: _b, version: _v, ...rest } = { ...blankSchedule(), name: "3y", ...o }; void _i; void _c; void _u; void _b; void _v; return rest; };
const lineDeal = (o: Partial<RampDealDraft> = {}): Partial<RampDealDraft> => ({ kind: "line", name: "Acme 3-year", quoteId: "0Q0A00000000001AAA", quoteName: "Acme Ramp", lineId: "0QLA00000000001AAA", productId: "01tA00000000001AAA", contractStart: "2026-11-09", contractEnd: "2029-11-08", basePrice: 1000, baseQuantity: 1, schedule: sched({ period: "Yearly", segments: 3, defaultChange: 10 }), periodBoundary: "Anniversary", ...o });
const groupDeal = (o: Partial<RampDealDraft> = {}): Partial<RampDealDraft> => ({ kind: "group", name: "Acme group", quoteId: "0Q0A00000000002AAA", groupId: "1C9A00000000001AAA", groupName: "Year 1", contractStart: "2027-01-01", contractEnd: "2029-12-31", basePrice: 100, baseQuantity: 5, schedule: sched({ period: "Yearly", segments: 3, defaultChange: 10, upliftMethod: "Compound" }), periodBoundary: "Anniversary", ...o });

async function runToEnd(ctx: { store: RampStore; orgId: string; userId: string | null }, api: ReturnType<typeof fakeOrg>["api"], dealId: string, max = 40) {
  let ex = await startExecution(ctx, dealId, true);
  for (let i = 0; i < max && ex.status !== "completed" && ex.status !== "failed"; i++) ex = await stepExecution(ctx, api, ex.id, deps);
  return ex;
}

/* ── Product Ramp Segment ── */

test("Product Ramp Segment: validates, creates, reads back, CanRamp flips; duplicate reused; usage-based / non-term refused; Salesforce error verbatim", async () => {
  const org = fakeOrg(seed(), { now: deps.now });
  const r = await createProductRampSegment(org.api, { productId: "01tA00000000001AAA", sellingModelId: "0jPA00000000001AAA", segmentType: "Yearly" });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.canRamp, true, "Salesforce derived CanRamp from the new segment");
  assert.deepEqual(org.calls.filter(c => c.method === "POST").map(c => c.body), [{ ProductId: "01tA00000000001AAA", ProductSellingModelId: "0jPA00000000001AAA", SegmentType: "Yearly" }]);
  const again = await createProductRampSegment(org.api, { productId: "01tA00000000001AAA", sellingModelId: "0jPA00000000001AAA", segmentType: "Yearly" });
  assert.deepEqual([again.ok, again.reused, again.segmentId], [true, true, r.segmentId]);
  assert.equal(org.calls.filter(c => c.method === "POST").length, 1, "no duplicate insert");
  assert.match((await createProductRampSegment(org.api, { productId: "01tA00000000003AAA", sellingModelId: "0jPA00000000001AAA", segmentType: "Yearly" })).message, /usage-based/);
  assert.match((await createProductRampSegment(org.api, { productId: "01tA00000000001AAA", sellingModelId: "0jPA00000000002AAA", segmentType: "Yearly" })).message, /isn't one of this product's active term-based/);
  assert.match((await createProductRampSegment(org.api, { productId: "01tA00000000001AAA", sellingModelId: "0jPA00000000001AAA", segmentType: "FreeTrial" })).message, /Trial Duration/);
  const rej = fakeOrg(seed(), { rejectPrs: "This product isn't a simple product." , now: deps.now });
  assert.match((await createProductRampSegment(rej.api, { productId: "01tA00000000001AAA", sellingModelId: "0jPA00000000001AAA", segmentType: "Custom" })).message, /FIELD_INTEGRITY_EXCEPTION: This product isn't a simple product/);
});

/* ── line ramp ── */

test("line ramp end to end: stage → commit → read back → segment values → Force pricing → verified; exact Salesforce calls", async () => {
  const s = seed(); s.Product2[0].CanRamp = true; s.ProductRampSegment.push({ Id: "1FTA00000000009AAA", Name: "PPRS-9", ProductId: "01tA00000000001AAA", ProductSellingModelId: "0jPA00000000001AAA", SegmentType: "Yearly", CreatedDate: "2026-11-01" });
  const org = fakeOrg(s, { now: deps.now });
  const ctx = { store: tmpStore(), orgId: ORG, userId: "005A00000000001AAA" };
  const deal = await saveDeal(ctx, lineDeal());
  const ex = await runToEnd(ctx, org.api, deal.id);
  assert.equal(ex.status, "completed", JSON.stringify(ex.steps.map(x => [x.id, x.status, x.message])));
  const writes = org.calls.filter(c => c.method !== "GET").map(c => `${c.method} ${c.path.replace(/\/\w+$/, "/:id")}${(c.body as { pricingPref?: string })?.pricingPref ? ` ${(c.body as { pricingPref: string }).pricingPref}` : ""}`);
  assert.deepEqual(writes, ["POST /connect/revenue-management/sales-transaction-contexts/0QLA00000000001AAA/actions/ramp-deal-create", "POST /connect/rev/sales-transaction/actions/:id Skip", "PATCH /sobjects/QuoteLineItem/:id", "PATCH /sobjects/QuoteLineItem/:id", "PATCH /sobjects/QuoteLineItem/:id", "POST /connect/rev/sales-transaction/actions/:id Force"]);
  assert.deepEqual(org.calls[0].body, { transactionId: "0Q0A00000000001AAA", transactionLineId: "0QLA00000000001AAA", subscriptionTerm: 36, subscriptionTermUnit: "Months", segmentType: "Yearly" });
  assert.deepEqual(ex.segments.map(x => [x.startDate, x.unitPriceUplift ?? 0, x.netUnitPrice]), [["2026-11-09", 0, 1000], ["2027-11-09", 10, 1100], ["2028-11-09", 10, 1100]]);
  assert.ok(ex.verification.every(c => c.passed || c.severity === "info"));
  assert.ok(org.store.QuoteLineItem.filter(l => l.RampIdentifier).every(l => l.PeriodBoundary === "Anniversary"), "Period Boundary set before pricing");
  const h = filterHistory((await ctx.store.load(ORG)).history, { dealId: deal.id });
  assert.ok(h.rows.some(e => e.action === "completed" && e.status === "success"));
});

test("line ramp: prices calculated but NOT saved → verification fails, never 'completed'", async () => {
  const s = seed(); s.Product2[0].CanRamp = true; s.ProductRampSegment.push({ Id: "1FTA00000000009AAA", Name: "P", ProductId: "01tA00000000001AAA", ProductSellingModelId: "0jPA00000000001AAA", SegmentType: "Yearly", CreatedDate: "x" });
  const org = fakeOrg(s, { pricingPersists: false , now: deps.now });
  const ctx = { store: tmpStore(), orgId: ORG, userId: null };
  const deal = await saveDeal(ctx, lineDeal());
  let ex = await startExecution(ctx, deal.id, true);
  for (let i = 0; i < 12 && ex.status !== "completed" && ex.status !== "failed"; i++) { clock += 11 * 60_000; ex = await stepExecution(ctx, org.api, ex.id, deps); }
  assert.notEqual(ex.status, "completed");
  assert.equal(ex.steps.find(x => x.id === "price")!.status === "completed", false, "no LastPricedDate after the request → price step never completes");
});

test("line ramp resume: an interruption after staging never stages twice; a commit already done isn't re-sent; Salesforce errors stop the run", async () => {
  const s = seed(); s.Product2[0].CanRamp = true; s.ProductRampSegment.push({ Id: "1FTA00000000009AAA", Name: "P", ProductId: "01tA00000000001AAA", ProductSellingModelId: "0jPA00000000001AAA", SegmentType: "Yearly", CreatedDate: "x" });
  const org = fakeOrg(s, { now: deps.now });
  const ctx = { store: tmpStore(), orgId: ORG, userId: null };
  const deal = await saveDeal(ctx, lineDeal());
  let ex = await startExecution(ctx, deal.id, true);
  ex = await stepExecution(ctx, org.api, ex.id, deps); // validate
  ex = await stepExecution(ctx, org.api, ex.id, deps); // stage
  // Simulate a crash: the next step was marked running and never reported back.
  await ctx.store.update(ORG, d => { d.executions = d.executions.map(x => (x.id === ex.id ? { ...x, steps: x.steps.map(st => (st.id === "commit" ? { ...st, status: "running" as const, startedAt: "2026-01-01T00:00:00Z" } : st)) } : x)); });
  ex = await retryExecution(ctx, ex.id);
  for (let i = 0; i < 20 && ex.status !== "completed" && ex.status !== "failed"; i++) ex = await stepExecution(ctx, org.api, ex.id, deps);
  assert.equal(ex.status, "completed");
  assert.equal(org.calls.filter(c => c.path.endsWith("ramp-deal-create")).length, 1, "staged once");
  assert.equal(org.calls.filter(c => c.path.endsWith("/place") && (c.body as { contextDetails?: unknown }).contextDetails).length, 1, "committed once");
  // A second "start" on the same deal returns the same execution — never a second run.
  assert.equal((await startExecution(ctx, deal.id, true)).id, ex.id);

  const bad = fakeOrg(seed(), { rejectCommit: "Something went wrong while validating the configured bundle. We couldn't retrieve the product and price information." , now: deps.now });
  bad.store.Product2[0].CanRamp = true; bad.store.ProductRampSegment.push({ Id: "1FTX", Name: "P", ProductId: "01tA00000000001AAA", ProductSellingModelId: "0jPA00000000001AAA", SegmentType: "Yearly" });
  const ctx2 = { store: tmpStore(), orgId: ORG, userId: null };
  const d2 = await saveDeal(ctx2, lineDeal());
  const failed = await runToEnd(ctx2, bad.api, d2.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.steps.find(x => x.id === "commit")!.message!, /UNKNOWN_EXCEPTION: Something went wrong while validating the configured bundle/);
  await assert.rejects(stepExecution(ctx2, bad.api, failed.id, deps), /use Retry/);
});

test("line ramp validation: non-Yearly schedule → group ramp advice; compound on a line where RampUpliftType is read-only → refused; not rampable → refused", async () => {
  const s = seed(); s.Product2[0].CanRamp = true; s.ProductRampSegment.push({ Id: "1FT9", Name: "P", ProductId: "01tA00000000001AAA", ProductSellingModelId: "0jPA00000000001AAA", SegmentType: "Yearly", CreatedDate: "2026-01-01T00:00:00.000Z" });
  const ctx = { store: tmpStore(), orgId: ORG, userId: null };
  const q = await runToEnd(ctx, fakeOrg(s, { now: deps.now }).api, (await saveDeal(ctx, lineDeal({ name: "Q", schedule: sched({ period: "Quarterly", segments: 12 }) }))).id);
  assert.match(q.steps[0].message!, /need a Group Ramp/);
  const c = await runToEnd(ctx, fakeOrg(s, { now: deps.now }).api, (await saveDeal(ctx, lineDeal({ name: "C", schedule: sched({ period: "Yearly", segments: 3, upliftMethod: "Compound" }) }))).id);
  assert.match(c.steps[0].message!, /Compound uplift can't be requested on a line ramp/);
  const n = await runToEnd({ ...ctx, store: tmpStore() }, fakeOrg(seed(), { now: deps.now }).api, (await saveDeal({ ...ctx, store: tmpStore() }, lineDeal())).id).catch(() => null);
  void n;
  const ctx3 = { store: tmpStore(), orgId: ORG, userId: null };
  const n2 = await runToEnd(ctx3, fakeOrg(seed(), { now: deps.now }).api, (await saveDeal(ctx3, lineDeal())).id);
  assert.match(n2.steps[0].message!, /no Product Ramp Segment/);
});

/* ── group ramp ── */

test("group ramp end to end (p12-like): EditGroup → clone ×2 (only the last) → EditRampSchedule → uplift/compound → Force → verified", async () => {
  const org = fakeOrg(seed(), { groupRamp: true , now: deps.now });
  const ctx = { store: tmpStore(), orgId: ORG, userId: null };
  const deal = await saveDeal(ctx, groupDeal());
  const ex = await runToEnd(ctx, org.api, deal.id);
  assert.equal(ex.status, "completed", JSON.stringify(ex.steps.map(x => [x.id, x.status, x.message])));
  const ramped = org.store.QuoteLineGroup.filter(g => g.IsRamped).sort((a, b) => String(a.StartDate).localeCompare(String(b.StartDate)));
  assert.deepEqual(ramped.map(g => [g.StartDate, g.EndDate, g.UnitPriceUplift ?? 0, g.RampUpliftType]), [["2027-01-01", "2027-12-31", 0, "Compound"], ["2028-01-01", "2028-12-31", 10, "Compound"], ["2029-01-01", "2029-12-31", 10, "Compound"]]);
  assert.equal(org.calls.filter(c => c.path.endsWith("/clone")).length, 2, "two clones for three segments");
  assert.ok(org.calls.filter(c => c.path.endsWith("/clone")).every((c, i) => (c.body as { recordIds: string[] }).recordIds[0] === ramped[i].Id), "each clone of the then-LAST segment");
  const actions = org.calls.filter(c => (c.body as { groupRampAction?: string })?.groupRampAction).map(c => (c.body as { groupRampAction: string }).groupRampAction);
  // EditGroup ONLY converts the group into segment 1; segment uplift + method go through ONE EditRampSchedule (dates already right,
  // so the date-only EditRampSchedule is skipped).
  assert.deepEqual(actions, ["EditGroup", "EditRampSchedule"]);
  assert.deepEqual(ex.segments.map(x => x.netUnitPrice), [100, 110, 121], "compound: 100 → 110 → 121 (Salesforce pricing in the mock)");
});

test("group ramp on a p10-like org: blocked at validation with the exact Salesforce setting to enable", async () => {
  const org = fakeOrg(seed(), { groupRamp: false , now: deps.now });
  const caps = await capabilities(org.api);
  assert.equal(caps.groupRamp.available, false);
  const ctx = { store: tmpStore(), orgId: ORG, userId: null };
  const ex = await runToEnd(ctx, org.api, (await saveDeal(ctx, groupDeal({ schedule: sched({ period: "Yearly", segments: 3 }) }))).id);
  assert.equal(ex.status, "failed");
  assert.match(ex.steps[0].message!, /Ramp Deals for Groups/);
  assert.equal(org.calls.filter(c => c.method !== "GET").length, 0, "nothing written");
});

/* ── pricing page ── */

test("re-pricing a quote: saved only when LastPricedDate moves; otherwise reported as NOT saved", async () => {
  const org = fakeOrg(seed(), { now: deps.now });
  const okR = await repriceQuote(org.api, "0Q0A00000000001AAA", deps);
  assert.equal(okR.ok, true, okR.message);
  const no = await repriceQuote(fakeOrg(seed(), { pricingPersists: false , now: deps.now }).api, "0Q0A00000000001AAA", deps);
  assert.equal(no.ok, false);
  assert.match(no.message, /NOT confirmed as saved/);
});

/* ── store / schedules / deals ── */

test("persistence: schedules + deals survive a new store instance (app restart); duplicate names refused; concurrent writes serialized", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ramp-"));
  const ctx = { store: new RampStore(dir), orgId: ORG, userId: "005" };
  const sc = await saveSchedule(ctx, { ...blankSchedule(), name: "Standard 3y" });
  await assert.rejects(saveSchedule(ctx, { ...blankSchedule(), name: "standard 3Y" }), RampServiceError);
  await Promise.all(Array.from({ length: 10 }, (_, i) => saveSchedule(ctx, { ...blankSchedule(), name: `S${i}` })));
  const reopened = new RampStore(dir);
  const d = await reopened.load(ORG);
  assert.equal(d.schedules.length, 11, "all concurrent writes kept");
  assert.ok(d.schedules.some(x => x.id === sc.id));
  assert.ok(d.history.filter(h => h.kind === "schedule").length >= 11);
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith(".tmp")).length, 0, "atomic writes leave no temp files");
  assert.equal(new RampStore(dir).durability().backend, "file");
  await assert.rejects(saveDeal(ctx, lineDeal({ name: "" })), /Name the ramp deal/);
  await assert.rejects(startExecution(ctx, (await saveDeal(ctx, lineDeal())).id, false), /confirm it first/);
});

/* ── AI resolution ── */

test("AI builder: names resolved through Salesforce reads, never AI Ids; missing / ambiguous reported; nothing written", async () => {
  const org = fakeOrg(seed(), { now: deps.now });
  const r = await resolveExtraction(org.api, { intent: "line", dealName: "Acme 3y", accountName: "Acme", quoteName: "Acme Ramp", productName: "Activation", period: "Yearly", segments: 3, upliftMethod: "Standard", upliftPercent: 7, contractStart: null, contractEnd: null, notes: [] }, "2026-11-09");
  assert.equal(r.draft.quoteId, "0Q0A00000000001AAA");
  assert.equal(r.draft.lineId, "0QLA00000000001AAA");
  assert.deepEqual([r.draft.contractStart, r.draft.contractEnd], ["2026-11-09", "2029-11-08"], "line dates used");
  assert.equal(r.draft.schedule!.defaultChange, 7);
  assert.deepEqual(r.missing, []);
  const g = await resolveExtraction(org.api, { intent: "group", quoteName: "Nope", notes: [] }, "2026-11-09");
  assert.ok(g.resolved.some(x => x.field === "Quote" && x.status === "not-found"));
  assert.ok(g.missing.includes("quote"));
  assert.equal(org.calls.length, 0, "read-only");
});
