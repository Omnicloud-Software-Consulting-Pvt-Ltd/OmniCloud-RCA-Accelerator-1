/**
 * §Genericity audit (multi-org, multi-product architecture requirement) — every test in
 * `nativeRecords.combinationExpansion.test.ts` so far exercises the combinatorial-closure planner
 * (`computeAttributeCombinations`, `combineAdjustmentValues`, `planAttributeCombinationExpansion`,
 * `detectCombinationNameCollisions`, `estimateCombinationApiCost`) against attribute/value shapes that
 * happen to resemble names seen in real orgs this session investigated (RAM/Storage/Display, etc.). That
 * resemblance is COINCIDENTAL, not structural: a source-level audit of `nativeRecords.ts` (grep for every
 * attribute/value/product-shaped literal) found such names appearing ONLY inside doc comments explaining
 * past live findings — never in an `if`/`===`/lookup-table inside actual executable logic. This file is
 * the proof-by-construction companion to that audit: every test below uses attribute/value shapes that
 * deliberately share NO vocabulary with any prior session's org data (colors/sizes, geographic/plan
 * dimensions, single-letter names, purely numeric names) to demonstrate the planner is a pure function of
 * whatever `AttributePricedOption[]` it's handed — never of what that data happens to be named.
 *
 * Pure, local, in-memory data only — no Salesforce client, no network call, nothing written anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAttributeCombinations, combineAdjustmentValues, planAttributeCombinationExpansion,
  detectCombinationNameCollisions, estimateCombinationApiCost,
  type AttributePricedOption,
} from "./nativeRecords";

function opt(attributeName: string, value: string, adjustmentValue = 10, ruleId?: string): AttributePricedOption {
  return { attributeName, attributeLabel: attributeName, value, valueLabel: value, ruleId: ruleId ?? `rule-${attributeName}-${value}`, adjustmentId: `adj-${attributeName}-${value}`, adjustmentType: "Amount", adjustmentValue };
}

/** ∏(Vi+1) - 1 - ΣVi — the same closed-form the planner itself implements via recursion; used here only to
 * independently VERIFY the planner's output count, never to seed it. */
function expectedTotal(valueCounts: number[]): number {
  const product = valueCounts.reduce((p, v) => p * (v + 1), 1);
  const sum = valueCounts.reduce((s, v) => s + v, 0);
  return product - 1 - sum;
}

test("SHAPE 1 — a completely different product domain (Color x Size, the user's own worked example A) produces the correct count and unique names", () => {
  const options = [
    opt("Color", "Red"), opt("Color", "Blue"),
    opt("Size", "S"), opt("Size", "M"), opt("Size", "L"),
  ];
  const plan = planAttributeCombinationExpansion(options, 2);
  assert.equal(plan.totalCombinations, expectedTotal([2, 3]));
  assert.equal(plan.collisions.length, 0);
  assert.equal(new Set(plan.ruleNames).size, plan.ruleNames.length);
});

test("SHAPE 2 — a THIRD, unrelated product domain (Region x Plan x Contract Type, the user's own worked example C) with 3 attributes of different sizes", () => {
  const options = [
    opt("Region", "India"), opt("Region", "US"),
    opt("Plan", "Basic"), opt("Plan", "Premium"), opt("Plan", "Enterprise"),
    opt("Contract Type", "Monthly"), opt("Contract Type", "Annual"),
  ];
  const plan = planAttributeCombinationExpansion(options, 3);
  assert.equal(plan.totalCombinations, expectedTotal([2, 3, 2]));
  assert.equal(plan.collisions.length, 0);
});

test("SHAPE 3 — single attribute, 2 values: correctly produces ZERO combinations (need 2+ simultaneously-varying attributes) regardless of domain", () => {
  const options = [opt("Q", "v1"), opt("Q", "v2")];
  const plan = planAttributeCombinationExpansion(options, 1);
  assert.equal(plan.totalCombinations, 0);
});

test("SHAPE 4 — two attributes with wildly different value counts (1 value vs 9 values) — the formula, not a fixed shape, drives the count", () => {
  const options = [
    opt("Z", "only"),
    ...Array.from({ length: 9 }, (_, i) => opt("W", `w${i}`)),
  ];
  const plan = planAttributeCombinationExpansion(options, 2);
  assert.equal(plan.totalCombinations, expectedTotal([1, 9]));
});

test("SHAPE 5 — an attribute is ADDED after a prior planning pass: previously-planned combination names are BYTE-IDENTICAL, and the count grows exactly per the formula", () => {
  const before = [opt("Alpha", "a1"), opt("Alpha", "a2"), opt("Beta", "b1")];
  const planBefore = planAttributeCombinationExpansion(before, 2);

  const after = [...before, opt("Gamma", "g1"), opt("Gamma", "g2")];
  const planAfter = planAttributeCombinationExpansion(after, 3);

  assert.equal(planAfter.totalCombinations, expectedTotal([2, 1, 2]));
  assert.ok(planAfter.totalCombinations > planBefore.totalCombinations, "adding an attribute must grow the space");
  // Every name the planner produced BEFORE the new attribute existed must still appear, unchanged, after —
  // stability under expansion, never a renumbering/reshuffling side effect of adding new data.
  for (const name of planBefore.ruleNames) {
    assert.ok(planAfter.ruleNames.includes(name), `combination name "${name}" must survive unchanged when a new attribute is added elsewhere`);
  }
});

test("SHAPE 6 — an attribute is REMOVED after a prior planning pass: the remaining combination names are unaffected, count shrinks exactly per the formula", () => {
  const before = [opt("Alpha", "a1"), opt("Alpha", "a2"), opt("Beta", "b1"), opt("Gamma", "g1"), opt("Gamma", "g2")];
  const planBefore = planAttributeCombinationExpansion(before, 3);

  const after = before.filter(o => o.attributeName !== "Gamma"); // Gamma removed entirely
  const planAfter = planAttributeCombinationExpansion(after, 2);

  assert.equal(planAfter.totalCombinations, expectedTotal([2, 1]));
  assert.ok(planAfter.totalCombinations < planBefore.totalCombinations, "removing an attribute must shrink the space");
  for (const name of planAfter.ruleNames) {
    assert.ok(planBefore.ruleNames.includes(name), `every remaining combination "${name}" must have already existed in the larger, pre-removal plan`);
  }
});

test("SHAPE 7 — a VALUE is added to an existing attribute: prior combination names for the OTHER values are untouched", () => {
  const before = [opt("Tier", "Low"), opt("Tier", "High"), opt("Kind", "K1")];
  const planBefore = planAttributeCombinationExpansion(before, 2);

  const after = [...before, opt("Tier", "Medium")];
  const planAfter = planAttributeCombinationExpansion(after, 2);

  assert.equal(planAfter.totalCombinations, expectedTotal([3, 1]));
  for (const name of planBefore.ruleNames) assert.ok(planAfter.ruleNames.includes(name));
});

test("SHAPE 8 — a VALUE is removed from an existing attribute: remaining names still valid, count shrinks per formula", () => {
  const before = [opt("Tier", "Low"), opt("Tier", "Medium"), opt("Tier", "High"), opt("Kind", "K1")];
  const planBefore = planAttributeCombinationExpansion(before, 2);

  const after = before.filter(o => !(o.attributeName === "Tier" && o.value === "Medium"));
  const planAfter = planAttributeCombinationExpansion(after, 2);

  assert.equal(planAfter.totalCombinations, expectedTotal([2, 1]));
  for (const name of planAfter.ruleNames) assert.ok(planBefore.ruleNames.includes(name));
});

test("SHAPE 9 — attribute ORDERING in the input array does not change the resulting names AT ALL (not just the set) — required for stable reuse-by-name across runs, since Salesforce query row order is never guaranteed stable", () => {
  const forward = [opt("First", "f1"), opt("First", "f2"), opt("Second", "s1"), opt("Second", "s2")];
  const reversed = [opt("Second", "s1"), opt("Second", "s2"), opt("First", "f1"), opt("First", "f2")];

  const planForward = planAttributeCombinationExpansion(forward, 2);
  const planReversed = planAttributeCombinationExpansion(reversed, 2);

  assert.equal(planForward.totalCombinations, planReversed.totalCombinations);
  assert.deepEqual(planForward.ruleNames, planReversed.ruleNames, "generated names (not just the set) must be BYTE-IDENTICAL regardless of input array order — the exact same logical combination must always resolve to the exact same Rule name, or reuse-by-name silently breaks");
});

test("SHAPE 10 — value ORDERING within an attribute does not change the resulting names AT ALL", () => {
  const ascending = [opt("N", "1"), opt("N", "2"), opt("N", "3"), opt("M", "x")];
  const shuffled = [opt("N", "3"), opt("N", "1"), opt("N", "2"), opt("M", "x")];

  const planA = planAttributeCombinationExpansion(ascending, 2);
  const planB = planAttributeCombinationExpansion(shuffled, 2);

  assert.deepEqual(planA.ruleNames, planB.ruleNames, "byte-identical regardless of value arrival order — same reuse-by-name requirement as attribute ordering");
});

test("SHAPE 11 — the SAME product with a DIFFERENT attribute configuration on a second call behaves as an entirely independent planning pass (no cross-call state, no memory of the prior shape)", () => {
  const configOne = [opt("Config1Attr", "va"), opt("Config1Attr", "vb"), opt("Other", "o1")];
  const configTwo = [opt("TotallyDifferentAttr", "x"), opt("TotallyDifferentAttr", "y"), opt("TotallyDifferentAttr", "z"), opt("AnotherOne", "n1"), opt("AnotherOne", "n2")];

  const planOne = planAttributeCombinationExpansion(configOne, 2);
  const planTwo = planAttributeCombinationExpansion(configTwo, 2);

  assert.equal(planOne.totalCombinations, expectedTotal([2, 1]));
  assert.equal(planTwo.totalCombinations, expectedTotal([3, 2]));
  // No name from one configuration should ever leak into the other's plan — proves no shared/cached state.
  for (const n of planOne.ruleNames) assert.ok(!planTwo.ruleNames.includes(n));
});

test("SHAPE 12 — single-character and purely numeric attribute/value names (no semantic resemblance to any prior org's data) still combine and sum correctly", () => {
  const options = [opt("A", "1", 5), opt("B", "2", 15), opt("C", "3", -20)];
  const combos = computeAttributeCombinations(options, 100);
  const threeWay = combos.find(c => c.length === 3);
  assert.ok(threeWay, "expected the single 3-way combination to be generated");
  const combined = combineAdjustmentValues(threeWay!, "Override");
  assert.equal(combined.value, 0, "5 + 15 + (-20) = 0");
});

test("SHAPE 13 — collision-safety holds across arbitrary long names in an unrelated domain (mirrors, but does not reuse, the earlier real-org truncation proof)", () => {
  const options: AttributePricedOption[] = [];
  const longAttrNames = ["FirstDimensionWithAVeryLongDescriptiveNameThatEatsIntoTheBudget", "SecondDimensionAlsoQuiteLongInItsOwnRight", "ThirdDimensionEvenLongerStillForGoodMeasure"];
  for (const attr of longAttrNames) {
    for (let i = 0; i < 4; i++) options.push(opt(attr, `SomeFairlyLongValueLabelNumber${i}ThatAlsoTakesUpSpace`));
  }
  const plan = planAttributeCombinationExpansion(options, longAttrNames.length);
  assert.ok(plan.totalCombinations > 20);
  assert.equal(plan.collisions.length, 0, "no domain-specific assumption should be required for collision-free naming at scale");
  assert.equal(new Set(plan.ruleNames).size, plan.ruleNames.length);
});

test("SHAPE 14 — API cost estimate scales with the DISCOVERED attribute count, not a fixed constant", () => {
  const est2Attrs = estimateCombinationApiCost(10, 2);
  const est8Attrs = estimateCombinationApiCost(10, 8);
  assert.ok(est8Attrs.estimatedApiCallsHighBound > est2Attrs.estimatedApiCallsHighBound, "more price-impacting attributes per rule must cost more API calls per combination, whatever the domain");
});

test("SHAPE 15 — detectCombinationNameCollisions operates purely on the combinations array handed to it — zero dependency on any global/module-level state between calls", () => {
  const setA = [opt("Dim1", "va"), opt("Dim1", "vb"), opt("Dim2", "vc")];
  const setB = [opt("Dim1", "va"), opt("Dim1", "vb"), opt("Dim2", "vc")]; // structurally identical, freshly re-derived
  const combosA = computeAttributeCombinations(setA, 100);
  const combosB = computeAttributeCombinations(setB, 100);
  const collisionsA = detectCombinationNameCollisions(combosA);
  const collisionsB = detectCombinationNameCollisions(combosB);
  assert.deepEqual(collisionsA, collisionsB, "two independently-built, structurally-identical inputs must produce byte-identical results — no caching artifact between calls");
});
