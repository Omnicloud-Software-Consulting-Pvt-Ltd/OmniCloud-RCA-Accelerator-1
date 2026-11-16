/**
 * RAMP core (pure): schedule engine, uplift math, capabilities, eligibility, pricing readiness, execution state + verification.
 * Run: `npx tsx --test lib/ramp/core.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonths, applyUplifts, blankSchedule, contractEndFor, cumulativeCompound, generateSchedule, segmentBoundaries, toSalesforceUplift, validateSchedule, wholeMonths } from "./schedule";
import { deriveCapabilities, objectCapFromDescribe } from "./capabilities";
import { groupEligibility, lineEligibility, productEligibility, type LineFacts, type ProductFacts } from "./eligibility";
import { evaluateUpliftReadiness, inspectProcedureXml } from "./readiness";
import { applyOutcome, canResume, markInterrupted, newExecution, nextStep, resetForRetry, startStep, verificationPassed, verifySegments } from "./execution";
import type { GeneratedSegment, SegmentResult } from "./types";

const sched = (o: Partial<ReturnType<typeof blankSchedule>> = {}) => ({ ...blankSchedule("2026-01-01T00:00:00Z"), name: "S", ...o });

/* ── dates ── */

test("month arithmetic: month-end clamping, leap years, anchoring to the start (no drift)", () => {
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29", "leap year");
  assert.equal(addMonths("2023-01-31", 1), "2023-02-28");
  assert.equal(addMonths("2024-02-29", 12), "2025-02-28");
  assert.equal(addMonths("2024-01-31", 2), "2024-03-31", "anchored to the 31st, not drifting to the 29th");
  assert.equal(wholeMonths("2026-11-09", "2029-11-08"), 36);
  assert.equal(wholeMonths("2026-11-09", "2029-11-09"), null);
});

test("Yearly segments match Salesforce's anniversary segments; month-end start stays contiguous; remainder is prorated", () => {
  const y = segmentBoundaries(sched({ period: "Yearly", segments: 3 }), "2026-11-09", "2029-11-08");
  assert.deepEqual(y.map(b => [b.start, b.end, b.kind]), [["2026-11-09", "2027-11-08", "full"], ["2027-11-09", "2028-11-08", "full"], ["2028-11-09", "2029-11-08", "full"]], "p12 segment lines: 2026-11-09 → 2027-11-08 …");
  const m = segmentBoundaries(sched({ period: "Monthly", segments: 3 }), "2024-01-31", "2024-04-29");
  assert.deepEqual(m.map(b => [b.start, b.end]), [["2024-01-31", "2024-02-28"], ["2024-02-29", "2024-03-30"], ["2024-03-31", "2024-04-29"]]);
  const p = segmentBoundaries(sched({ period: "Yearly", segments: 4 }), "2026-11-25", "2030-03-24");
  assert.deepEqual(p.map(b => b.kind), ["full", "full", "full", "prorated"], "like p12's 'Year 4 - Pro-rated'");
  const t = segmentBoundaries(sched({ period: "Yearly", segments: 2, trialMonths: 1 }), "2026-10-26", "2028-11-25");
  assert.deepEqual(t.map(b => [b.kind, b.start, b.end]), [["trial", "2026-10-26", "2026-11-25"], ["full", "2026-11-26", "2027-11-25"], ["full", "2027-11-26", "2028-11-25"]]);
  assert.equal(contractEndFor(sched({ period: "Quarterly", segments: 4 }), "2026-01-15"), "2027-01-14");
});

/* ── pricing preview + Salesforce uplift conversion ── */

test("standard vs compound uplift: percentages Salesforce needs, and what its Price Revision computes", () => {
  const std = generateSchedule(sched({ period: "Yearly", segments: 3, priceChange: "percent", defaultChange: 10, upliftMethod: "Standard" }), { contractStart: "2026-01-01", contractEnd: "2028-12-31", basePrice: 100, baseQuantity: 2 });
  assert.deepEqual(std.segments.map(s => [s.upliftPercent, s.previewUnitPrice]), [[0, 100], [10, 110], [10, 110]], "standard: every segment +10% on the BASE");
  const cmp = generateSchedule(sched({ period: "Yearly", segments: 3, priceChange: "percent", defaultChange: 10, upliftMethod: "Compound" }), { contractStart: "2026-01-01", contractEnd: "2028-12-31", basePrice: 100, baseQuantity: 1 });
  assert.deepEqual(cmp.segments.map(s => [s.upliftPercent, s.previewUnitPrice]), [[0, 100], [10, 110], [10, 121]], "compound: +10% on the previous segment");
  assert.deepEqual(applyUplifts(100, [0, 10, 10], "Compound"), [100, 110, 121]);
  assert.deepEqual(applyUplifts(100, [0, 10, 10], "Standard"), [100, 110, 110]);
  assert.deepEqual(cumulativeCompound([0, 10, 10]), [0, 10, 21]);
  // A fixed increase / target price is converted to the percentage Salesforce takes.
  const fixed = generateSchedule(sched({ period: "Yearly", segments: 3, priceChange: "fixed", defaultChange: 20, upliftMethod: "Compound" }), { contractStart: "2026-01-01", contractEnd: "2028-12-31", basePrice: 100, baseQuantity: 1 });
  assert.deepEqual(fixed.segments.map(s => s.upliftPercent), [0, 20, 16.67]);
  assert.equal(toSalesforceUplift(100, 100, 125, "Standard"), 25);
  assert.equal(toSalesforceUplift(100, 110, 121, "Compound"), 10);
  const price = generateSchedule(sched({ period: "Yearly", segments: 2, priceChange: "price", overrides: [{ segment: 2, value: 150 }] }), { contractStart: "2026-01-01", contractEnd: "2027-12-31", basePrice: 100, baseQuantity: 1 });
  assert.deepEqual(price.segments.map(s => s.upliftPercent), [0, 50]);
  const mult = generateSchedule(sched({ period: "Yearly", segments: 2, basePriceMultiplier: 1.2, defaultChange: 0 }), { contractStart: "2026-01-01", contractEnd: "2027-12-31", basePrice: 100, baseQuantity: 1 });
  assert.equal(mult.segments[0].previewUnitPrice, 120);
});

test("per-segment overrides (quantity, discount, uplift) and validation errors", () => {
  const s = generateSchedule(sched({ period: "Yearly", segments: 3, defaultChange: 5, overrides: [{ segment: 2, value: 8, quantity: 20, discount: 10 }] }), { contractStart: "2026-01-01", contractEnd: "2028-12-31", basePrice: 100, baseQuantity: 10 });
  assert.deepEqual(s.segments.map(x => [x.quantity, x.discount, x.upliftPercent]), [[10, 0, 0], [20, 10, 8], [10, 0, 5]]);
  assert.ok(generateSchedule(sched(), { contractStart: "2026-02-30", contractEnd: "2027-01-01", basePrice: 1, baseQuantity: 1 }).issues.some(i => i.severity === "error"), "invalid date");
  assert.ok(generateSchedule(sched(), { contractStart: "2027-01-01", contractEnd: "2026-01-01", basePrice: 1, baseQuantity: 1 }).issues[0].message.includes("before"));
  assert.ok(generateSchedule(sched({ segments: 5 }), { contractStart: "2026-01-01", contractEnd: "2028-12-31", basePrice: 1, baseQuantity: 1 }).issues.some(i => /asks for 5/.test(i.message)));
  assert.deepEqual(validateSchedule({ name: "", period: "Custom", customMonths: 0, segments: 0, upliftMethod: "Standard", basePriceMultiplier: 0, overrides: [] }).length, 4);
  assert.deepEqual(validateSchedule(sched()), []);
});

/* ── capabilities from describe (p12 vs p10) ── */

const desc = (fields: [string, string, string[]?][], createable = true) => objectCapFromDescribe({ createable, updateable: true, fields: fields.map(([name, cu, pl]) => ({ name, createable: cu.includes("c"), updateable: cu.includes("u"), picklistValues: (pl ?? []).map(value => ({ value })) })) });
test("capabilities: p12 supports group + compound; p10 has no group ramp (fields not writable)", () => {
  const prs = desc([["ProductId", "c"], ["ProductSellingModelId", "c"], ["SegmentType", "cu", ["Yearly", "Custom", "FreeTrial", "Prorated"]], ["DurationType", "cu", ["Months", "Days"]]]);
  const qli = desc([["RampIdentifier", "cu"], ["SegmentType", "cu", ["Yearly", "Custom", "FreeTrial", "Prorated"]], ["UnitPriceUplift", "cu"], ["RampUpliftType", "", ["Standard", "Compound"]], ["ApplUnitPriceUpliftPct", ""]]);
  const q = desc([["LastPricedDate", ""], ["CalculationStatus", ""]]);
  const p12 = deriveCapabilities("v68.0", { ProductRampSegment: prs, QuoteLineItem: qli, Quote: q, QuoteLineGroup: desc([["IsRamped", "cu"], ["SegmentType", "cu", ["Custom", "Yearly", "Prorated"]], ["StartDate", "cu"], ["EndDate", "cu"], ["UnitPriceUplift", "cu"], ["RampUpliftType", "cu", ["Standard", "Compound"]]]) });
  assert.deepEqual([p12.productRampSegment.available, p12.lineRamp.available, p12.groupRamp.available, p12.compound.group, p12.compound.line], [true, true, true, true, false]);
  const p10 = deriveCapabilities("v68.0", { ProductRampSegment: prs, QuoteLineItem: desc([["RampIdentifier", "cu"], ["SegmentType", "cu"], ["UnitPriceUplift", "cu"]]), Quote: q, QuoteLineGroup: desc([["IsRamped", ""], ["SegmentType", ""], ["StartDate", "cu"], ["EndDate", "cu"], ["UnitPriceUplift", "cu"]]) });
  assert.equal(p10.groupRamp.available, false);
  assert.match(p10.groupRamp.reason!, /IsRamped, SegmentType can't be written[\s\S]*Ramp Deals for Groups/);
  assert.equal(p10.compound.group, false);
  assert.equal(deriveCapabilities("v68.0", {}).productRampSegment.available, false);
});

/* ── eligibility ── */

const product = (o: Partial<ProductFacts> = {}): ProductFacts => ({ id: "01tX", name: "Activation Service", isActive: true, canRamp: true, usageModelType: null, type: null, productCode: null, ...o });
const line = (o: Partial<LineFacts> = {}): LineFacts => ({ id: "0QLX", quoteId: "0Q0X", productId: "01tX", sellingModelId: "0jPY", sellingModelType: "TermDefined", rampIdentifier: null, groupId: null, startDate: "2026-11-09", endDate: "2029-11-08", quantity: 1, unitPrice: 1000, periodBoundary: "Anniversary", subscriptionTerm: 3, ...o });
const quote = { id: "0Q0X", name: "Q", status: "Draft", accountId: null, pricebookId: null };
test("eligibility: usage-based, not rampable, non-term, non-draft, already ramped — warnings only where a fact is unknown", () => {
  assert.equal(productEligibility(product({ usageModelType: "Anchor" }), [{ id: "m", name: "Y", type: "TermDefined", status: "Active" }], []).eligible, false);
  const noSeg = productEligibility(product({ canRamp: false }), [{ id: "m", name: "Y", type: "TermDefined", status: "Active" }], []);
  assert.equal(noSeg.eligible, true, "CanRamp=false with no segment yet → create one (warning), not a dead end");
  assert.match(noSeg.reasons[0].message, /Create a Product Ramp Segment first/);
  assert.equal(productEligibility(product(), [{ id: "m", name: "One Time", type: "OneTime", status: "Active" }], []).eligible, false);
  assert.equal(lineEligibility(line(), quote, product(), [{ id: "1FT", sellingModelId: "0jPY", segmentType: "Yearly", name: null }]).eligible, true);
  assert.equal(lineEligibility(line(), { ...quote, status: "Approved" }, product(), []).eligible, false);
  assert.ok(lineEligibility(line({ rampIdentifier: "RDI1" }), quote, product(), []).reasons.some(r => r.code === "already-ramped"));
  assert.ok(lineEligibility(line({ periodBoundary: null }), quote, product(), [{ id: "1FT", sellingModelId: "0jPY", segmentType: "Yearly", name: null }]).reasons.some(r => r.code === "no-period-boundary" && r.severity === "warning"));
  // Another ramp on the same quote is NOT a blocker (p12 quote #40 holds two ramp schedules) — only a warning.
  const grp = (id: string, o: Record<string, unknown> = {}) => ({ id, name: id, quoteId: "0Q0X", isRamped: false, parentId: null, sortOrder: 1, segmentType: null, startDate: null, endDate: null, unitPriceUplift: null, rampUpliftType: null, ...o });
  const g = groupEligibility({ quote, groupId: "1C9X", groups: [grp("1C9X"), grp("1C9R", { isRamped: true })], lines: [line({ groupId: "1C9X" })], products: new Map([["01tX", product()]]), segmentsByProduct: new Map() });
  assert.equal(g.eligible, true);
  assert.ok(g.reasons.some(r => r.code === "quote-has-other-ramps" && r.severity === "warning"));
});

/* ── pricing readiness (XML shaped exactly like p12's active v7) ── */

const XML = (compound: string, method = "ItemRampUpliftType__std") => `<ExpressionSetDefinition><versions><fullName>P_V6</fullName><status>Inactive</status><versionNumber>6</versionNumber></versions><versions><fullName>P_SfSupport0</fullName><steps><actionType>PriceRevision</actionType><customElement>${[["PolicyAdjustment", "Parameter", "ItemUnitPriceUplift__std"], ["RampIdentifier", "Parameter", "ItemRampIdentifier"], ["UpliftMethod", "Parameter", method], ["IsCompoundUpliftEnabled", "Literal", compound]].map(([n, t, v]) => `<parameters><input>true</input><name>${n}</name><output>false</output><type>${t}</type><value>${v}</value></parameters>`).join("")}</customElement><name>PriceRevision</name></steps><status>Active</status><versionNumber>7</versionNumber></versions></ExpressionSetDefinition>`;
test("readiness: Active version's Price Revision mappings decide standard / compound readiness, with actionable fixes", () => {
  const i = inspectProcedureXml("Rev_Mgmt", XML("true"));
  assert.equal(i.activeVersion?.versionNumber, 7);
  assert.equal(i.priceRevision?.params.UpliftMethod.value, "ItemRampUpliftType__std");
  const tags = [{ title: "ItemUnitPriceUplift__std", mappedFrom: ["UnitPriceUplift"] }, { title: "ItemRampUpliftType__std", mappedFrom: ["RampUpliftType"] }];
  const ok = evaluateUpliftReadiness(i, tags, { compoundGroup: true, compoundLine: false });
  assert.deepEqual([ok.standardReady, ok.compoundReady], [true, true]);
  const off = evaluateUpliftReadiness(inspectProcedureXml("P", XML("false")), tags, { compoundGroup: true, compoundLine: false });
  assert.deepEqual([off.standardReady, off.compoundReady], [true, false]);
  assert.match(off.checks.find(c => c.id === "compound-enabled")!.fix!, /IsCompoundUpliftEnabled parameter to true/);
  const noGroup = evaluateUpliftReadiness(i, tags, { compoundGroup: false, compoundLine: false });
  assert.equal(noGroup.compoundReady, false);
  assert.equal(evaluateUpliftReadiness(inspectProcedureXml("P", "<x/>"), null, { compoundGroup: true, compoundLine: true }).standardReady, false);
});

/* ── execution state + verification ── */

test("execution: steps in order, waiting/failed resume at the same step, interruption detected, retry re-runs only failed", () => {
  let e = newExecution({ id: "e1", dealId: "d1", kind: "line", orgId: "00D", userId: "005", quoteId: "0Q0", lineId: "0QL", groupId: null, now: "t0" });
  assert.equal(nextStep(e)!.id, "validate");
  e = applyOutcome(startStep(e, "validate", "t1"), "validate", { status: "completed", message: "ok" }, "t1");
  assert.equal(nextStep(e)!.id, "stage");
  e = applyOutcome(startStep(e, "stage", "t2"), "stage", { status: "waiting", message: "async" }, "t2");
  assert.equal(e.status, "waiting");
  assert.equal(nextStep(e)!.id, "stage", "a waiting step runs again");
  e = startStep(e, "stage", "t3");
  e = markInterrupted(e, "t4");
  assert.equal(e.status, "interrupted");
  assert.ok(canResume(e));
  e = resetForRetry(e, "t5");
  assert.equal(nextStep(e)!.id, "stage");
  assert.equal(e.steps.find(s => s.id === "stage")!.attempts, 2);
  for (const s of e.steps) if (s.status !== "completed") e = applyOutcome(e, s.id, { status: "completed", message: "" }, "t6");
  assert.equal(e.status, "completed");
  assert.equal(canResume(e), false);
  assert.deepEqual(newExecution({ id: "g", dealId: "d", kind: "group", orgId: "o", userId: null, quoteId: null, lineId: null, groupId: "1C9", now: "t" }).steps.map(s => s.id).slice(0, 4), ["validate", "convert-group", "clone-segments", "edit-schedule"]);
});

const seg = (i: number, start: string, end: string, up: number): GeneratedSegment => ({ index: i, name: `Year ${i + 1}`, kind: "full", startDate: start, endDate: end, months: 12, upliftPercent: up, quantity: 1, discount: 0, previewUnitPrice: 100, previewTotal: 100 });
const res = (id: string, start: string, end: string, up: number, appl: number, net: number | null, groupId: string | null = null): SegmentResult => ({ id, name: null, startDate: start, endDate: end, quantity: 1, discount: 0, unitPriceUplift: up, appliedUpliftPct: appl, rampUpliftType: null, unitPrice: 100, netUnitPrice: net, netTotalPrice: net, groupId, productId: "01t" });
test("verification: only completed when segments, values, applied uplift AND persisted quote pricing all check out", () => {
  const exp = [seg(0, "2026-11-09", "2027-11-08", 0), seg(1, "2027-11-09", "2028-11-08", 10)];
  const good = verifySegments({ kind: "line", expected: exp, actual: [res("a", "2026-11-09", "2027-11-08", 0, 0, 1000), res("b", "2027-11-09", "2028-11-08", 10, 10, 1100)], quote: { calculationStatus: "CompletedWithPricing", lastPricedDate: "2026-11-09T10:00:05Z" }, priceRequestedAt: "2026-11-09T10:00:00Z", appliedUpliftField: true });
  assert.equal(verificationPassed(good), true);
  // The live p12 symptom: uplift written, Instant Pricing ran, nothing saved (CompletedWithoutPricing, no LastPricedDate, Appl 0).
  const notSaved = verifySegments({ kind: "line", expected: exp, actual: [res("a", "2026-11-09", "2027-11-08", 0, 0, 1000), res("b", "2027-11-09", "2028-11-08", 10, 0, 1000)], quote: { calculationStatus: "CompletedWithoutPricing", lastPricedDate: null }, priceRequestedAt: "2026-11-09T10:00:00Z", appliedUpliftField: true });
  assert.equal(verificationPassed(notSaved), false);
  assert.deepEqual(notSaved.filter(c => !c.passed && c.severity === "error").map(c => c.id).sort(), ["applied-b", "quote-priced", "quote-priced-after"]);
  // Priced BEFORE this run's request doesn't count.
  assert.equal(verifySegments({ kind: "line", expected: exp, actual: good.length ? [res("a", "2026-11-09", "2027-11-08", 0, 0, 1000), res("b", "2027-11-09", "2028-11-08", 10, 10, 1100)] : [], quote: { calculationStatus: "CompletedWithPricing", lastPricedDate: "2026-11-01T00:00:00Z" }, priceRequestedAt: "2026-11-09T10:00:00Z", appliedUpliftField: true }).find(c => c.id === "quote-priced-after")!.passed, false);
  // Group: each segment needs every product; a gap fails.
  const g = verifySegments({ kind: "group", expected: exp, actual: [res("a", "2026-11-09", "2027-11-08", 0, 0, 1, "g1"), res("b", "2027-11-10", "2028-11-08", 10, 10, 1, "g2")], quote: { calculationStatus: "CompletedWithPricing", lastPricedDate: "2026-11-09T10:00:05Z" }, priceRequestedAt: "2026-11-09T10:00:00Z", appliedUpliftField: true, productsPerSegment: 2 });
  assert.equal(g.find(c => c.id === "lines-per-segment")!.passed, false);
  assert.equal(g.find(c => c.id === "continuity-1")!.passed, false);
});
