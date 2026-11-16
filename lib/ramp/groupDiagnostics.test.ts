/**
 * Group ramp diagnostics on p12-shaped data (read-only snapshot 2026-11-10): the parent shape ("RAMP GROUP" + ramped children), the
 * chain shape ("New Group 1" + clones sharing RampIdentifiers), several ramps on one quote, and line-level eligibility.
 * Run: `npx tsx --test lib/ramp/groupDiagnostics.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existingRamps, groupRampDiagnostics, groupState, type GroupFacts } from "./groupDiagnostics";
import type { LineFacts, ProductFacts, QuoteFacts } from "./eligibility";

const Q = "0Q0g5000001xyzAAA";
const quote: QuoteFacts = { id: Q, name: "RAMP TEST 06", status: "Draft", accountId: "001X", pricebookId: "01sX" };
const g = (id: string, o: Partial<GroupFacts> = {}): GroupFacts => ({ id, name: id, quoteId: Q, isRamped: false, parentId: null, sortOrder: 1, segmentType: null, startDate: null, endDate: null, unitPriceUplift: null, rampUpliftType: null, ...o });
const l = (id: string, groupId: string, o: Partial<LineFacts> = {}): LineFacts => ({ id, quoteId: Q, productId: "01tAPI", sellingModelId: "0jPY", sellingModelType: "TermDefined", rampIdentifier: null, groupId, startDate: "2026-10-27", endDate: "2029-10-26", quantity: 1, unitPrice: 70, periodBoundary: "Anniversary", subscriptionTerm: 1, ...o });
const product = (o: Partial<ProductFacts> = {}): ProductFacts => ({ id: "01tAPI", name: "API Access Premium", isActive: true, canRamp: true, usageModelType: null, type: null, productCode: "API", ...o });
const products = new Map([["01tAPI", product()]]);

// p12 quote #46 (parent shape) + a chain ramp ("New Group 1" style) + a fresh empty group + a fresh group with one line
const groups: GroupFacts[] = [
  g("PARENT", { name: "RAMP GROUP", sortOrder: 1, startDate: "2026-10-27", endDate: "2029-10-26" }),
  g("Y1", { name: "YEAR 1", isRamped: true, parentId: "PARENT", sortOrder: 2, segmentType: "Yearly", startDate: "2026-10-27", endDate: "2027-10-26" }),
  g("Y2", { name: "YEAR 1 - Year 2", isRamped: true, parentId: "PARENT", sortOrder: 3, segmentType: "Yearly", startDate: "2027-10-27", endDate: "2028-10-26" }),
  g("NG1", { name: "New Group 1", isRamped: true, sortOrder: 1, segmentType: "Yearly", startDate: "2026-10-26", endDate: "2027-10-25" }),
  g("NG2", { name: "New Group 1 - Year 2", isRamped: true, sortOrder: 2, segmentType: "Yearly", startDate: "2027-10-26", endDate: "2028-10-25" }),
  g("FRESH", { name: "Platform", sortOrder: 9 }),
  g("EMPTY", { name: "Empty", sortOrder: 10 }),
];
const lines: LineFacts[] = [
  l("L1", "Y1", { rampIdentifier: "RDI0bbe4b989d714b7" }), l("L2", "Y2", { rampIdentifier: "RDI0bbe4b989d714b7" }),
  l("L3", "NG1", { rampIdentifier: "RDIchain" }), l("L4", "NG2", { rampIdentifier: "RDIchain" }),
  l("L5", "FRESH"),
];
const diag = (groupId: string, ls = lines, ps = products) => groupRampDiagnostics({ quote, groupId, groups, lines: ls, products: ps, segmentsByProduct: new Map() });

test("existing ramps: parent shape (children under an un-ramped parent) and chain shape (shared RampIdentifier)", () => {
  const ramps = existingRamps(groups, lines);
  assert.equal(ramps.length, 2);
  const parent = ramps.find(r => r.shape === "parent")!;
  assert.equal(parent.parent?.name, "RAMP GROUP");
  assert.deepEqual(parent.segments.map(s => s.id), ["Y1", "Y2"]);
  assert.deepEqual(parent.rampIdentifiers, ["RDI0bbe4b989d714b7"]);
  const chain = ramps.find(r => r.shape === "chain")!;
  assert.deepEqual(chain.segments.map(s => s.id), ["NG1", "NG2"]);
  assert.deepEqual(chain.rampIdentifiers, ["RDIchain"]);
});

test("segments without lines are linked by Salesforce's clone naming ('<name> - Year N'), as on p12 quote #40", () => {
  const gs = [g("A1", { name: "New Group 1", isRamped: true, startDate: "2026-10-26" }), g("A2", { name: "New Group 1 - Year 2", isRamped: true, startDate: "2027-10-26" }), g("B1", { name: "Other", isRamped: true, startDate: "2026-01-01" })];
  const r = existingRamps(gs, []);
  assert.deepEqual(r.map(c => c.segments.map(s => s.id)).sort(), [["A1", "A2"], ["B1"]]);
});

test("group state: IsRamped=false is NOT enough — a parent holding ramped children is a ramp container", () => {
  assert.equal(groupState(groups[0], groups), "ramp-container");
  assert.equal(groupState(groups[1], groups), "ramp-segment");
  assert.equal(groupState(groups[5], groups), "unramped");
});

test("an un-ramped group is eligible even though the quote already has other ramps (warning only)", () => {
  const d = diag("FRESH");
  assert.equal(d.eligible, true);
  assert.equal(d.groupState, "unramped");
  assert.equal(d.otherRamps.length, 2);
  assert.ok(d.reasons.some(r => r.code === "quote-has-other-ramps" && r.severity === "warning"));
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].eligible, true);
});

test("already-ramped diagnostics: segment and container are blocked, with their existing ramp structure and identifiers", () => {
  const seg = diag("NG2");
  assert.equal(seg.eligible, false);
  assert.equal(seg.groupState, "ramp-segment");
  assert.deepEqual(seg.chain?.segments.map(s => s.name), ["New Group 1", "New Group 1 - Year 2"]);
  assert.match(seg.reasons.find(r => r.code === "group-ramped")!.message, /already a ramp segment \(IsRamped = true, SegmentType Yearly, 2027-10-26 → 2028-10-25\) of an existing ramp with 2 segment/);
  const parent = diag("PARENT");
  assert.equal(parent.groupState, "ramp-container");
  assert.ok(parent.reasons.some(r => r.code === "group-has-ramp" && /2 ramped child group/.test(r.message)));
  assert.deepEqual(parent.chain?.rampIdentifiers, ["RDI0bbe4b989d714b7"]);
  assert.equal(parent.otherRamps.length, 1);
});

test("empty group, non-Draft quote, unsupported products and missing selling model are reported", () => {
  assert.ok(diag("EMPTY").reasons.some(r => r.code === "group-empty" && r.severity === "error"));
  const approved = groupRampDiagnostics({ quote: { ...quote, status: "Approved" }, groupId: "FRESH", groups, lines, products, segmentsByProduct: new Map() });
  assert.ok(approved.quoteReasons.some(r => r.code === "quote-not-draft"));
  const bad = [l("U1", "FRESH", { productId: "01tUSE" }), l("U2", "FRESH", { sellingModelId: null, sellingModelType: null }), l("U3", "FRESH", { sellingModelType: "OneTime" }), l("U4", "FRESH", { productId: "01tNOR" })];
  const ps = new Map([["01tAPI", product()], ["01tUSE", product({ id: "01tUSE", name: "Usage", usageModelType: "Anchor" })], ["01tNOR", product({ id: "01tNOR", name: "Not rampable", canRamp: false })]]);
  const d = diag("FRESH", bad, ps);
  const codes = d.lines.flatMap(x => x.reasons.map(r => r.code));
  for (const c of ["usage-based", "no-selling-model", "line-not-term", "no-segments"]) assert.ok(codes.includes(c), c);
  assert.equal(d.eligible, false);
  assert.deepEqual(d.lines.filter(x => x.eligible).map(x => x.line.id), ["U1"], "usage (Anchor) is a warning for group ramps; the others are errors");
  assert.equal(d.lines[0].reasons.find(r => r.code === "usage-based")?.severity, "warning");
});

test("missing / foreign group is reported, never assumed", () => {
  assert.ok(diag("NOPE").reasons.some(r => r.code === "group-missing"));
  const foreign = groupRampDiagnostics({ quote, groupId: "F", groups: [g("F", { quoteId: "0Q0OTHER" })], lines: [], products, segmentsByProduct: new Map() });
  assert.ok(foreign.reasons.some(r => r.code === "group-other-quote"));
});
