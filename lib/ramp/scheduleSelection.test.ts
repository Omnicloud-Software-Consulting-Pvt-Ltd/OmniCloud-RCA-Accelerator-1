/**
 * Group Ramp schedule selection + uplift / discount — regression for 2026-11-10: a saved schedule with 5% showed 0% on every Group Ramp
 * segment, and 0% was what execution sent. Root cause: the uplift was derived through a price (target ÷ base − 1) and a group ramp's
 * base price is 0 (a group has no single line price) → every uplift 0. Shapes below are the real saved records in this org's RAMP store
 * ("Ramp trail": Yearly × 3, percent, default 5, Standard; group deals with basePrice 0). MOCKED Salesforce for the execution parts.
 * Run: `npx tsx --test lib/ramp/scheduleSelection.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applySavedSchedule, blankSchedule, generateSchedule, scheduleBodyOf } from "./schedule";
import type { RampDealDraft, RampSchedule } from "./types";
import { fakeOrg } from "./server/fakeOrg";
import { RampStore } from "./server/store";
import { saveDeal, startExecution, stepExecution } from "./server/service";
import { dealPreview, groupChecks, type RunDeps } from "./server/runner";

const saved = (o: Partial<RampSchedule>): RampSchedule => ({ ...blankSchedule("2026-11-09T00:00:00Z"), id: "sch_x", name: "Ramp trail", period: "Yearly", segments: 3, trialMonths: null, priceChange: "percent", defaultChange: 5, upliftMethod: "Standard", basePriceMultiplier: 1, overrides: [], version: 1, ...o });
const GROUP0 = { contractStart: "2026-11-10", contractEnd: "2029-11-09", basePrice: 0, baseQuantity: 1 }; // the real group deals
const seg = (s: RampSchedule, input = GROUP0, group = true) => generateSchedule(scheduleBodyOf(s), { ...input, ignoreQuantityOverrides: group });

test("5% default uplift on a group ramp (base price 0): 0 / 5 / 5 — not 0 / 0 / 0", () => {
  const p = seg(saved({}));
  assert.deepEqual(p.segments.map(x => x.upliftPercent), [0, 5, 5]);
  assert.deepEqual(p.segments.map(x => x.upliftSource), ["first", "default", "default"]);
  assert.ok(!p.issues.some(i => i.severity === "error"));
  // same result with a real base price — the uplift never depends on the price for percent schedules
  assert.deepEqual(seg(saved({}), { ...GROUP0, basePrice: 70 }).segments.map(x => x.upliftPercent), [0, 5, 5]);
});

test("different uplift per segment (overrides) — the real 'ramp deal test 4' overrides 0 / 5 / 5, and 2 / 7 / 12", () => {
  assert.deepEqual(seg(saved({ overrides: [{ segment: 1, value: 0 }, { segment: 2, value: 5 }, { segment: 3, value: 5 }] })).segments.map(x => x.upliftPercent), [0, 5, 5]);
  const p = seg(saved({ defaultChange: null, overrides: [{ segment: 1, value: 2 }, { segment: 2, value: 7 }, { segment: 3, value: 12 }] }));
  assert.deepEqual(p.segments.map(x => [x.upliftPercent, x.upliftSource]), [[2, "override"], [7, "override"], [12, "override"]]);
});

test("Compound uplift: each segment's own % goes to Salesforce (method kept), base price irrelevant", () => {
  const s = saved({ upliftMethod: "Compound", defaultChange: 10 });
  assert.deepEqual(seg(s).segments.map(x => x.upliftPercent), [0, 10, 10]);
  assert.equal(scheduleBodyOf(s).upliftMethod, "Compound");
  assert.deepEqual(seg(s, { ...GROUP0, basePrice: 100 }).segments.map(x => x.previewUnitPrice), [100, 110, 121]);
});

test("price overrides need a base price to become an uplift %: refused at base 0, converted at base 100", () => {
  const s = saved({ priceChange: "price", defaultChange: null, overrides: [{ segment: 2, value: 110 }, { segment: 3, value: 125 }] });
  const zero = seg(s);
  assert.ok(zero.issues.some(i => i.severity === "error" && /set a base unit price above 0/.test(i.message)));
  assert.deepEqual(seg(s, { ...GROUP0, basePrice: 100 }).segments.map(x => [x.upliftPercent, x.upliftSource]), [[0, "first"], [10, "price"], [25, "price"]]);
  const fixed = saved({ priceChange: "fixed", defaultChange: 10 });
  assert.ok(seg(fixed).issues.some(i => i.severity === "error"));
  assert.deepEqual(seg(fixed, { ...GROUP0, basePrice: 100 }).segments.map(x => x.upliftPercent), [0, 10, 10]);
});

test("missing uplift vs explicitly configured 0%: unset is flagged (0 sent, warned), an explicit 0 override isn't", () => {
  const unset = seg(saved({ defaultChange: null }));
  assert.deepEqual(unset.segments.map(x => [x.upliftPercent, x.upliftSource]), [[0, "first"], [0, "unset"], [0, "unset"]]);
  assert.equal(unset.issues.filter(i => /no uplift configured/.test(i.message)).length, 2);
  const explicit = seg(saved({ defaultChange: null, overrides: [{ segment: 2, value: 0 }, { segment: 3, value: 0 }] }));
  assert.deepEqual(explicit.segments.map(x => x.upliftSource), ["first", "override", "override"]);
  assert.ok(!explicit.issues.some(i => /no uplift configured/.test(i.message)));
});

test("selecting a schedule loads ALL of it; changing the selection replaces it completely (no stale overrides / defaults)", () => {
  const deal = { kind: "group" as const, contractStart: "2026-11-10", contractEnd: "2027-11-09" };
  const a = saved({ id: "sch_a", name: "A", defaultChange: 5, overrides: [{ segment: 3, value: 9, discount: 10 }] });
  const b = saved({ id: "sch_b", name: "B", period: "Quarterly", segments: 4, defaultChange: 2, upliftMethod: "Compound", overrides: [] });
  const pa = applySavedSchedule(deal, a);
  assert.equal(pa.scheduleId, "sch_a");
  assert.deepEqual([pa.schedule!.defaultChange, pa.schedule!.overrides], [5, [{ segment: 3, value: 9, discount: 10 }]]);
  assert.equal(pa.contractEnd, "2029-11-09", "group end date follows the schedule");
  const pb = applySavedSchedule({ ...deal, contractEnd: pa.contractEnd }, b);
  assert.deepEqual([pb.schedule!.period, pb.schedule!.segments, pb.schedule!.defaultChange, pb.schedule!.upliftMethod, pb.schedule!.overrides], ["Quarterly", 4, 2, "Compound", []]);
  assert.equal(pb.contractEnd, "2027-11-09");
  pa.schedule!.overrides[0].value = 99;
  assert.equal(a.overrides[0].value, 9, "the deal gets a copy — editing it never changes the saved template");
  assert.deepEqual(applySavedSchedule(deal, null), { scheduleId: null }, "clearing keeps the deal's own schedule and dates");
  assert.equal(applySavedSchedule({ ...deal, kind: "line" }, a).contractEnd, undefined, "a line ramp keeps its line's dates");
});

test("group ramp: quantity overrides are flagged (not applied); discount overrides are kept as the segment group discount", () => {
  const p = seg(saved({ overrides: [{ segment: 2, value: 5, quantity: 9, discount: 10 }] }));
  assert.deepEqual(p.segments.map(x => [x.quantity, x.discount]), [[1, 0], [1, 10], [1, 0]]);
  assert.ok(p.issues.some(i => /quantity overrides aren't applied/.test(i.message)));
  assert.deepEqual(seg(saved({ overrides: [{ segment: 2, value: 5, quantity: 9 }] }), GROUP0, false).segments.map(x => x.quantity), [1, 9, 1], "line ramps still apply quantity");
});

/* ── execution: the edited schedule is what Salesforce receives, and what is read back ── */

const Q = "0Q0A00000000001AAA", G = "1C9A00000000001AAA", P = "01tA00000000001AAA", YR = "0jPA00000000001AAA";
let clock = Date.parse("2026-11-10T10:00:00Z");
const deps: RunDeps = { now: () => new Date((clock += 1000)).toISOString(), sleep: async () => undefined, waitMs: 0 };
const orgSeed = () => ({
  Account: [{ Id: "001A00000000001AAA", Name: "Any Partner Inc" }],
  Quote: [{ Id: Q, Name: "Q", QuoteNumber: "00000080", Status: "Draft", QuoteAccountId: "001A00000000001AAA", Pricebook2Id: "01sA00000000001AAA", CalculationStatus: "NotStarted", LastPricedDate: null }],
  Product2: [{ Id: P, Name: "API Access Premium", IsActive: true, ProductCode: "API", CanRamp: true, UsageModelType: null, Type: null }],
  ProductSellingModel: [{ Id: YR, Name: "Term Based - Yearly", SellingModelType: "TermDefined", Status: "Active", PricingTerm: 1, PricingTermUnit: "Annual" }],
  ProductSellingModelOption: [{ Id: "0iO1", Product2Id: P, ProductSellingModelId: YR }],
  ProductRampSegment: [{ Id: "1FTA00000000001AAA", Name: "S", ProductId: P, ProductSellingModelId: YR, SegmentType: "Yearly", CreatedDate: "2026-11-01" }],
  QuoteLineGroup: [{ Id: G, Name: "G", QuoteId: Q, SortOrder: 1, IsRamped: false, SegmentType: null, StartDate: null, EndDate: null, UnitPriceUplift: null, RampUpliftType: null, Discount: null, ParentQuoteLineGroupId: null }],
  QuoteLineItem: [{ Id: "0QLA00000000001AAA", QuoteId: Q, QuoteLineGroupId: G, Product2Id: P, ProductSellingModelId: YR, SellingModelType: "TermDefined", Quantity: 1, UnitPrice: 70, Discount: 0, StartDate: "2026-11-10", EndDate: "2029-11-09", PeriodBoundary: "Anniversary", BillingFrequency: "Annual", RampIdentifier: null, CreatedDate: "2026-11-10" }],
});
function groupDealFrom(s: RampSchedule): Partial<RampDealDraft> {
  return { kind: "group", name: "Selected schedule", quoteId: Q, quoteName: "Q", groupId: G, groupName: "G", scheduleId: s.id, schedule: scheduleBodyOf(s), contractStart: "2026-11-10", contractEnd: "2029-11-09", basePrice: 0, baseQuantity: 1, periodBoundary: "Anniversary" };
}
async function execute(d: Partial<RampDealDraft>, opts: Parameters<typeof fakeOrg>[1] = {}) {
  const o = fakeOrg(orgSeed(), { now: deps.now, ...opts });
  const ctx = { store: new RampStore(fs.mkdtempSync(path.join(os.tmpdir(), "rampsel-"))), orgId: "00Dg500000KSpiPEAT", userId: null };
  const dealRow = await saveDeal(ctx, d);
  let ex = await startExecution(ctx, dealRow.id, true);
  for (let i = 0; i < 40 && ex.status !== "completed" && ex.status !== "failed"; i++) ex = await stepExecution(ctx, o.api, ex.id, deps);
  return { o, ex, dealRow };
}
type Rec = { attributes: { type: string; id: string } } & Record<string, unknown>;
const ersRecords = (o: ReturnType<typeof fakeOrg>) => ((o.calls.find(c => (c.body as { groupRampAction?: string })?.groupRampAction === "EditRampSchedule" && ((c.body as { graph: { records: { record: Rec }[] } }).graph.records.some(r => "UnitPriceUplift" in r.record)))?.body as { graph: { records: { record: Rec }[] } } | undefined)?.graph.records.map(r => r.record).filter(r => r.attributes.type === "QuoteLineGroup") ?? []);

test("EXACT EditRampSchedule payload for the saved 5% schedule on a base-price-0 group deal; Salesforce read-back verified", async () => {
  const { o, ex, dealRow } = await execute(groupDealFrom(saved({})));
  assert.equal(ex.status, "completed", JSON.stringify(ex.steps.map(s => [s.id, s.status, s.message])));
  assert.deepEqual(dealPreview(dealRow).map(x => x.upliftPercent), [0, 5, 5], "the execution configuration itself");
  const segs = o.store.QuoteLineGroup.filter(g => g.IsRamped).sort((a, b) => String(a.StartDate).localeCompare(String(b.StartDate)));
  assert.deepEqual(ersRecords(o).map(r => ({ id: r.attributes.id, ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "attributes")) })), [
    { id: segs[0].Id, StartDate: "2026-11-10", EndDate: "2027-11-09", UnitPriceUplift: 0, RampUpliftType: "Standard" },
    { id: segs[1].Id, StartDate: "2027-11-10", EndDate: "2028-11-09", UnitPriceUplift: 5, RampUpliftType: "Standard" },
    { id: segs[2].Id, StartDate: "2028-11-10", EndDate: "2029-11-09", UnitPriceUplift: 5, RampUpliftType: "Standard" },
  ], "no Discount key: neither the plan nor Salesforce has a discount");
  assert.deepEqual(segs.map(g => [g.UnitPriceUplift, g.RampUpliftType]), [[0, "Standard"], [5, "Standard"], [5, "Standard"]]);
  const groupLevel = ex.verification.filter(c => c.id.startsWith("group-"));
  assert.deepEqual(groupLevel.map(c => [c.label.split(": ")[1], c.expected, c.actual, c.passed]), [
    ["segment uplift (QuoteLineGroup.UnitPriceUplift)", "0%", "0%", true], ["uplift method (RampUpliftType)", "Standard", "Standard", true],
    ["segment uplift (QuoteLineGroup.UnitPriceUplift)", "5%", "5%", true], ["uplift method (RampUpliftType)", "Standard", "Standard", true],
    ["segment uplift (QuoteLineGroup.UnitPriceUplift)", "5%", "5%", true], ["uplift method (RampUpliftType)", "Standard", "Standard", true],
  ]);
});

test("editing uplift + group discount after selecting the schedule changes what Salesforce receives (not just the preview)", async () => {
  const s = saved({ upliftMethod: "Compound" });
  const d = groupDealFrom(s);
  d.schedule = { ...d.schedule!, overrides: [{ segment: 2, value: 8, discount: 10 }, { segment: 3, value: 12 }] }; // edited in the form
  const { o, ex } = await execute(d);
  assert.equal(ex.status, "completed", JSON.stringify(ex.steps.map(x => [x.id, x.status, x.message])));
  const recs = ersRecords(o);
  assert.deepEqual(recs.map(r => [r.UnitPriceUplift, r.RampUpliftType, r.Discount]), [[0, "Compound", 0], [8, "Compound", 10], [12, "Compound", 0]]);
  const segs = o.store.QuoteLineGroup.filter(g => g.IsRamped).sort((a, b) => String(a.StartDate).localeCompare(String(b.StartDate)));
  assert.deepEqual(segs.map(g => [g.UnitPriceUplift, g.RampUpliftType, g.Discount]), [[0, "Compound", 0], [8, "Compound", 10], [12, "Compound", 0]], "persisted in Salesforce (mock)");
  assert.ok(ex.verification.some(c => c.id.startsWith("group-discount-") && c.expected === "10%" && c.passed));
});

test("Salesforce not keeping the group discount → verification fails (never reported as saved)", async () => {
  const d = groupDealFrom(saved({ overrides: [{ segment: 2, value: 5, discount: 10 }] }));
  const { ex } = await execute(d, { editRampScheduleIgnores: ["Discount"] });
  assert.equal(ex.status, "failed");
  assert.match(ex.steps.find(s => s.status === "failed")!.message!, /accepted EditRampSchedule but didn't keep/);
});

test("group-level read-back checks: uplift, method and discount compared with the plan", () => {
  const preview = generateSchedule(scheduleBodyOf(saved({ overrides: [{ segment: 2, value: 5, discount: 10 }] })), { ...GROUP0, ignoreQuantityOverrides: true }).segments;
  const caps = { fields: { UnitPriceUplift: { updateable: true }, RampUpliftType: { updateable: true }, Discount: { updateable: true } } };
  const ok = groupChecks([{ id: "a", name: "Y1", unitPriceUplift: 0, rampUpliftType: "Standard", discount: null }, { id: "b", name: "Y2", unitPriceUplift: 5, rampUpliftType: "Standard", discount: 10 }, { id: "c", name: "Y3", unitPriceUplift: 5, rampUpliftType: "Standard", discount: 0 }], preview, "Standard", caps);
  assert.ok(ok.every(c => c.passed));
  const bad = groupChecks([{ id: "a", name: "Y1", unitPriceUplift: 0, rampUpliftType: "Compound", discount: null }, { id: "b", name: "Y2", unitPriceUplift: 0, rampUpliftType: "Compound", discount: 0 }, { id: "c", name: "Y3", unitPriceUplift: 5, rampUpliftType: "Standard", discount: 0 }], preview, "Standard", caps);
  assert.deepEqual(bad.filter(c => !c.passed).map(c => c.id), ["group-method-a", "group-uplift-b", "group-method-b", "group-discount-b"]);
});
