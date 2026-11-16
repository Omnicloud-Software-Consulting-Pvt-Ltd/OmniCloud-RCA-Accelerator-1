/**
 * Group ramp segment uplift / method — regression for the p12 failure of 2026-11-10 (quotes #72 / #73):
 *   segment-values sent { groupRampAction: "EditGroup", QuoteLineGroup segment 1: { Name: "Year 1", RampUpliftType: "Standard" } } and
 *   Salesforce answered FIELD_INTEGRITY_EXCEPTION "You can’t convert a group to a ramped segment when the <quote> has a ramp schedule.
 *   Clone the last segment in the ramp schedule to add segments."
 * Salesforce had set RampUpliftType = Compound on every new segment (p12 default), so a Standard deal ALWAYS needed a method change.
 * MOCKED Salesforce (fakeOrg mirrors the refusal and the Compound default). Not live verification.
 * Run: `npx tsx --test lib/ramp/server/groupRampSegments.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeOrg } from "./fakeOrg";
import { RampStore } from "./store";
import { retryExecution, saveDeal, startExecution, stepExecution } from "./service";
import { blankSchedule, generateSchedule } from "@/lib/ramp/schedule";
import type { RunDeps } from "./runner";
import type { RampApi } from "./api";
import type { RampDealDraft, UpliftMethod } from "@/lib/ramp/types";

const Q = "0Q0A00000000001AAA", G = "1C9A00000000001AAA", P1 = "01tA00000000001AAA", P2 = "01tA00000000002AAA", YR = "0jPA00000000001AAA";
let clock = Date.parse("2026-11-10T10:00:00Z");
const deps: RunDeps = { now: () => new Date((clock += 1000)).toISOString(), sleep: async () => undefined, waitMs: 0 };
const line = (id: string, product: string) => ({ Id: id, QuoteId: Q, QuoteLineGroupId: G, Product2Id: product, ProductSellingModelId: YR, SellingModelType: "TermDefined", Quantity: 1, UnitPrice: 100, Discount: 0, StartDate: "2027-01-01", EndDate: "2027-12-31", PeriodBoundary: "Anniversary", BillingFrequency: "Annual", RampIdentifier: null, CreatedDate: "2026-11-10" });
function seed() {
  return {
    Account: [{ Id: "001A00000000001AAA", Name: "Any Partner Inc" }],
    Quote: [{ Id: Q, Name: "Group ramp deal test 3", QuoteNumber: "00000073", Status: "Draft", QuoteAccountId: "001A00000000001AAA", Pricebook2Id: "01sA00000000001AAA", CalculationStatus: "NotStarted", LastPricedDate: null }],
    Product2: [{ Id: P1, Name: "API Access Premium", IsActive: true, ProductCode: "API", CanRamp: true, UsageModelType: null, Type: null }, { Id: P2, Name: "Warranty", IsActive: true, ProductCode: "W001", CanRamp: true, UsageModelType: null, Type: null }],
    ProductSellingModel: [{ Id: YR, Name: "Term Based - Yearly", SellingModelType: "TermDefined", Status: "Active", PricingTerm: 1, PricingTermUnit: "Annual" }],
    ProductSellingModelOption: [{ Id: "0iO1", Product2Id: P1, ProductSellingModelId: YR }, { Id: "0iO2", Product2Id: P2, ProductSellingModelId: YR }],
    ProductRampSegment: [{ Id: "1FTA00000000001AAA", Name: "S1", ProductId: P1, ProductSellingModelId: YR, SegmentType: "Yearly", CreatedDate: "2026-11-01" }, { Id: "1FTA00000000002AAA", Name: "S2", ProductId: P2, ProductSellingModelId: YR, SegmentType: "Yearly", CreatedDate: "2026-11-01" }],
    QuoteLineGroup: [{ Id: G, Name: "Group ramp deal test 3", QuoteId: Q, SortOrder: 1, IsRamped: false, SegmentType: null, StartDate: null, EndDate: null, UnitPriceUplift: null, RampUpliftType: null, ParentQuoteLineGroupId: null }],
    QuoteLineItem: [line("0QLA00000000001AAA", P1), line("0QLA00000000002AAA", P2)],
  };
}
function deal(segments: number, method: UpliftMethod, change = 5): Partial<RampDealDraft> {
  const { id: _i, createdAt: _c, updatedAt: _u, createdBy: _b, version: _v, ...schedule } = { ...blankSchedule(), name: "s", period: "Yearly" as const, segments, defaultChange: change, upliftMethod: method };
  void _i; void _c; void _u; void _b; void _v;
  return { kind: "group", name: `Group ${segments}x ${method}`, quoteId: Q, quoteName: "Group ramp deal test 3", groupId: G, groupName: "Group ramp deal test 3", contractStart: "2027-01-01", contractEnd: `${2026 + segments}-12-31`, basePrice: 100, baseQuantity: 1, schedule, periodBoundary: "Anniversary" };
}
const ctxFor = () => ({ store: new RampStore(fs.mkdtempSync(path.join(os.tmpdir(), "rampseg-"))), orgId: "00Dg500000KSpiPEAT", userId: null });
async function run(api: RampApi, d: Partial<RampDealDraft>, ctx = ctxFor()) {
  const saved = await saveDeal(ctx, d);
  let ex = await startExecution(ctx, saved.id, true);
  for (let i = 0; i < 40 && ex.status !== "completed" && ex.status !== "failed"; i++) ex = await stepExecution(ctx, api, ex.id, deps);
  return { ex, ctx };
}
type Body = { groupRampAction?: string; graph?: { records: { record: Record<string, unknown> & { attributes: { type: string; id: string } } }[] }; recordIds?: string[] };
const groupRecs = (b: Body) => (b.graph?.records ?? []).map(r => r.record).filter(r => r.attributes.type === "QuoteLineGroup");
const expectedUplifts = (segments: number, method: UpliftMethod, change = 5) => generateSchedule({ ...blankSchedule(), period: "Yearly", segments, defaultChange: change, upliftMethod: method }, { contractStart: "2027-01-01", contractEnd: `${2026 + segments}-12-31`, basePrice: 100, baseQuantity: 1 }).segments.map(s => s.upliftPercent);

test("reproduces the live failure: after conversion, EditGroup on segment 1 (Name + RampUpliftType) is refused as a conversion", async () => {
  const o = fakeOrg(seed(), { now: deps.now });
  const convert = { groupRampAction: "EditGroup", pricingPref: "Skip", graph: { graphId: "updateQuote", records: [{ referenceId: Q, record: { attributes: { type: "Quote", method: "PATCH", id: Q } } }, { referenceId: G, record: { attributes: { type: "QuoteLineGroup", method: "PATCH", id: G }, StartDate: "2027-01-01", EndDate: "2027-12-31", SortOrder: 1, IsRamped: true, SegmentType: "Yearly" } }] } };
  assert.equal((await o.api.call("POST", "/connect/rev/sales-transaction/actions/place", convert)).status, 201);
  assert.equal(o.store.QuoteLineGroup[0].RampUpliftType, "Compound", "Salesforce's default method on a new segment (p12)");
  const oldSegmentValues = { groupRampAction: "EditGroup", pricingPref: "Skip", graph: { graphId: "updateQuote", records: [{ referenceId: Q, record: { attributes: { type: "Quote", method: "PATCH", id: Q } } }, { referenceId: G, record: { attributes: { type: "QuoteLineGroup", method: "PATCH", id: G }, Name: "Year 1", RampUpliftType: "Standard" } }] } };
  const r = await o.api.call("POST", "/connect/rev/sales-transaction/actions/place", oldSegmentValues);
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.body), /FIELD_INTEGRITY_EXCEPTION.*You can’t convert a group to a ramped segment when the 0Q0A00000000001AAA has a ramp schedule\. Clone the last segment in the ramp schedule to add segments\./);
});

test("3 segments, Standard (Salesforce defaulted Compound): EditGroup once → clone last ×2 → ONE EditRampSchedule (uplift + method, dates unchanged) → Force → verified", async () => {
  const o = fakeOrg(seed(), { now: deps.now });
  const { ex } = await run(o.api, deal(3, "Standard"));
  assert.equal(ex.status, "completed", JSON.stringify(ex.steps.map(s => [s.id, s.status, s.message])));
  // request ordering
  const seq = o.calls.filter(c => c.method === "POST").map(c => { const b = c.body as Body & { pricingPref?: string }; return c.path.endsWith("/clone") ? `clone:${b.recordIds![0]}` : b.groupRampAction ?? `place:${b.pricingPref}`; });
  const segs = o.store.QuoteLineGroup.filter(g => g.IsRamped).sort((a, b) => String(a.StartDate).localeCompare(String(b.StartDate)));
  assert.deepEqual(seq, ["EditGroup", `clone:${segs[0].Id}`, `clone:${segs[1].Id}`, "EditRampSchedule", "place:Force"]);
  // EditGroup only converted — no Name / uplift / method in it
  const editGroup = o.calls.find(c => (c.body as Body).groupRampAction === "EditGroup")!.body as Body;
  assert.deepEqual(Object.keys(groupRecs(editGroup)[0]).filter(k => k !== "attributes").sort(), ["EndDate", "IsRamped", "SegmentType", "SortOrder", "StartDate"]);
  // the EditRampSchedule payload: every segment of this ramp, its current dates, uplift + method
  const ers = groupRecs(o.calls.find(c => (c.body as Body).groupRampAction === "EditRampSchedule")!.body as Body);
  const up = expectedUplifts(3, "Standard");
  assert.deepEqual(ers.map(r => ({ id: r.attributes.id, s: r.StartDate, e: r.EndDate, u: r.UnitPriceUplift, m: r.RampUpliftType })), segs.map((g, i) => ({ id: g.Id, s: `${2027 + i}-01-01`, e: `${2027 + i}-12-31`, u: up[i], m: "Standard" })));
  assert.ok(!ers.some(r => "Name" in r), "segments are never renamed (that would need EditGroup)");
  // Salesforce read-back: groups + lines carry the persisted values; dates, order and RampIdentifiers preserved
  assert.deepEqual(segs.map(g => [g.StartDate, g.EndDate, g.UnitPriceUplift, g.RampUpliftType]), up.map((u, i) => [`${2027 + i}-01-01`, `${2027 + i}-12-31`, u, "Standard"]));
  for (const p of [P1, P2]) {
    const ls = o.store.QuoteLineItem.filter(l => l.Product2Id === p).sort((a, b) => String(a.StartDate).localeCompare(String(b.StartDate)));
    assert.equal(ls.length, 3);
    assert.equal(new Set(ls.map(l => l.RampIdentifier)).size, 1, "one RampIdentifier per product across segments");
    assert.deepEqual(ls.map(l => [l.UnitPriceUplift, l.RampUpliftType]), up.map(u => [u, "Standard"]));
  }
  assert.ok(ex.verification.every(c => c.passed || c.severity === "info"));
  assert.ok(ex.verification.some(c => c.id.startsWith("uplift-")) && ex.verification.some(c => c.id.startsWith("ramp-id-")));
  assert.deepEqual(ex.segments.filter(s => s.productId === P1).map(s => s.netUnitPrice), up.map(u => Math.round(100 * (1 + u / 100) * 100) / 100), "Standard: each segment's uplift applied to the base price");
});

test("4 segments, Compound (already Salesforce's default): only the uplift changes, still one EditRampSchedule; compound prices", async () => {
  const o = fakeOrg(seed(), { now: deps.now });
  const { ex } = await run(o.api, deal(4, "Compound", 10));
  assert.equal(ex.status, "completed", JSON.stringify(ex.steps.map(s => [s.id, s.status, s.message])));
  const actions = o.calls.map(c => (c.body as Body)?.groupRampAction).filter(Boolean);
  assert.deepEqual(actions, ["EditGroup", "EditRampSchedule"]);
  assert.equal(o.calls.filter(c => c.path.endsWith("/clone")).length, 3);
  const segs = o.store.QuoteLineGroup.filter(g => g.IsRamped).sort((a, b) => String(a.StartDate).localeCompare(String(b.StartDate)));
  assert.deepEqual(segs.map(g => [g.UnitPriceUplift, g.RampUpliftType]), expectedUplifts(4, "Compound", 10).map(u => [u, "Compound"]));
  assert.deepEqual(ex.segments.filter(s => s.productId === P1).map(s => s.netUnitPrice), [100, 110, 121, 133.1]);
});

test("Salesforce accepts EditRampSchedule but doesn't keep the uplift → the run FAILS (never 'completed'), after exactly one request", async () => {
  const o = fakeOrg(seed(), { now: deps.now, editRampScheduleIgnores: ["UnitPriceUplift"] });
  const { ex } = await run(o.api, deal(3, "Standard"));
  assert.equal(ex.status, "failed");
  const failed = ex.steps.find(s => s.status === "failed")!;
  assert.equal(failed.id, "segment-values");
  assert.match(failed.message!, /accepted EditRampSchedule but didn't keep/);
  assert.equal(o.calls.filter(c => (c.body as Body)?.groupRampAction === "EditRampSchedule").length, 1, "not re-sent in a loop");
  assert.ok(!o.calls.some(c => (c.body as Body)?.groupRampAction === "EditGroup" && groupRecs(c.body as Body).some(r => !("IsRamped" in r))), "no EditGroup fallback");
  assert.ok(!o.calls.some(c => (c.body as { pricingPref?: string }).pricingPref === "Force"), "not priced / verified on wrong uplift");
});

test("Retry after an EditRampSchedule rejection (what Retry does to the runs that failed at this step) re-reads and completes without re-converting or re-cloning", async () => {
  const o = fakeOrg(seed(), { now: deps.now });
  let rejected = 0;
  const api: RampApi = { ...o.api, call: async (m, p, b) => ((b as Body)?.groupRampAction === "EditRampSchedule" && rejected++ === 0 ? { status: 400, body: { isSuccess: false, errorResponse: [{ errorCode: "UNKNOWN_EXCEPTION", message: "transient" }] } } : o.api.call(m, p, b)) };
  const { ex, ctx } = await run(api, deal(3, "Standard"));
  assert.equal(ex.status, "failed");
  assert.match(ex.steps.find(s => s.status === "failed")!.message!, /EditRampSchedule \(uplift \/ method\) failed: UNKNOWN_EXCEPTION: transient/);
  const before = o.calls.length;
  let r = await retryExecution(ctx, ex.id);
  for (let i = 0; i < 20 && r.status !== "completed" && r.status !== "failed"; i++) r = await stepExecution(ctx, api, r.id, deps);
  assert.equal(r.status, "completed", JSON.stringify(r.steps.map(s => [s.id, s.status, s.message])));
  const after = o.calls.slice(before).map(c => (c.body as Body)?.groupRampAction ?? (c.path.endsWith("/clone") ? "clone" : "place"));
  assert.deepEqual(after, ["EditRampSchedule", "place"], "retry: one EditRampSchedule, then pricing — no EditGroup, no clone");
});

test("another ramp on the quote (org allowing several schedules): its groups and lines are untouched", async () => {
  const s = seed();
  s.QuoteLineGroup.push({ Id: "1C9OTHER0000001AAA", Name: "Other ramp", QuoteId: Q, SortOrder: 9, IsRamped: true, SegmentType: "Yearly", StartDate: "2026-01-01", EndDate: "2026-12-31", UnitPriceUplift: 7, RampUpliftType: "Compound", ParentQuoteLineGroupId: null } as never);
  s.QuoteLineItem.push({ ...line("0QLOTHER000001AAA", P2), QuoteLineGroupId: "1C9OTHER0000001AAA", RampIdentifier: "RDIOTHER", StartDate: "2026-01-01", EndDate: "2026-12-31" } as never);
  const o = fakeOrg(s, { now: deps.now, multipleRampSchedules: true });
  const pick = (l: Record<string, unknown>) => [l.QuoteLineGroupId, l.StartDate, l.EndDate, l.Quantity, l.RampIdentifier, l.UnitPriceUplift ?? null];
  const groupBefore = JSON.stringify(o.store.QuoteLineGroup.find(g => g.Id === "1C9OTHER0000001AAA"));
  const lineBefore = pick(o.store.QuoteLineItem.find(l => l.Id === "0QLOTHER000001AAA")!);
  const { ex } = await run(o.api, deal(3, "Standard"));
  assert.equal(ex.status, "completed", JSON.stringify(ex.steps.map(x => [x.id, x.status, x.message])));
  const ers = groupRecs(o.calls.find(c => (c.body as Body).groupRampAction === "EditRampSchedule")!.body as Body);
  assert.ok(!ers.some(r => r.attributes.id === "1C9OTHER0000001AAA"), "EditRampSchedule only names THIS ramp's segments");
  assert.equal(JSON.stringify(o.store.QuoteLineGroup.find(g => g.Id === "1C9OTHER0000001AAA")), groupBefore, "the other ramp's segment group is unchanged");
  assert.deepEqual(pick(o.store.QuoteLineItem.find(l => l.Id === "0QLOTHER000001AAA")!), lineBefore, "its line keeps group, dates, quantity, RampIdentifier and uplift");
  assert.ok(!o.calls.some(c => JSON.stringify(c.body ?? "").includes("1C9OTHER0000001AAA")), "no request names the other ramp");
});
