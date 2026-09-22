/**
 * §Root-cause fix (Rule-level identity decoupled from generated Name) — the deterministic-naming fix
 * (`computeAttributeCombinations` sorting attributes/values alphabetically) correctly stopped Rule names
 * from depending on incidental Salesforce query order — but exposed that `resolveProductConsistentRuleCandidate`,
 * the combinatorial engine's ONLY way to recognize an already-existing Rule, looked it up by exact Name.
 * Any naming-convention change (this fix, or simply a different org's attribute ordering) made every
 * pre-existing combination Rule "unrecognized," risking redundant orphaned Rule creation on resume.
 *
 * Fixed by introducing `computeIntendedCombinationSignature`/`discoverExistingRuleContentIdentities`/
 * `matchExistingRulesToCombinations` — Rule identity now comes from the SAME canonical, order-independent
 * content signature `computeRuleConditionSignature` already uses for Adjustment-level reuse, never from a
 * generated display Name. These tests cover the pure logic (`computeIntendedCombinationSignature`,
 * `matchExistingRulesToCombinations`) directly — no Salesforce client needed.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeIntendedCombinationSignature, matchExistingRulesToCombinations,
  type AttributePricedOption, type ExistingRuleContentIdentity,
} from "./nativeRecords";

function opt(attributeName: string, value: string, adjustmentValue = 10): AttributePricedOption {
  return { attributeName, attributeLabel: attributeName, value, valueLabel: value, ruleId: `rule-${attributeName}-${value}`, adjustmentId: `adj-${attributeName}-${value}`, adjustmentType: "Amount", adjustmentValue };
}

/** Builds a COMPLETE existing rule's content identity: `allMembers` is the rule's own real, full condition
 * set (baseline + non-baseline values for EVERY price-impacting attribute) — its signature is computed via
 * the SAME `computeIntendedCombinationSignature` function under test, applied to real data instead of a
 * plan, exactly mirroring what `discoverExistingRuleContentIdentities` does against live Salesforce rows. */
function existingCompleteRule(
  ruleId: string, name: string, productId: string, allMembers: { attributeName: string; value: string }[],
  priceImpactingAttrNames: string[], nonBaselineMembers: { attributeName: string; value: string }[],
): ExistingRuleContentIdentity {
  const signature = computeIntendedCombinationSignature(productId, allMembers, priceImpactingAttrNames, new Map());
  return { ruleId, name, presentNonBaselineMembers: nonBaselineMembers, isComplete: true, signature, conditionCount: allMembers.length };
}

function existingIncompleteRule(ruleId: string, name: string, presentNonBaselineMembers: { attributeName: string; value: string }[]): ExistingRuleContentIdentity {
  return { ruleId, name, presentNonBaselineMembers, isComplete: false, signature: null, conditionCount: presentNonBaselineMembers.length };
}

const ATTRS = ["Alpha", "Beta", "Gamma"];
const DEFAULTS = new Map<string, string | null>([["Alpha", "default-a"], ["Beta", "default-b"], ["Gamma", "default-g"]]);

test("TEST 1 — same logical combination, same attribute order in the members array → identical signature", () => {
  const members = [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }];
  const sig1 = computeIntendedCombinationSignature("prod-1", members, ATTRS, DEFAULTS);
  const sig2 = computeIntendedCombinationSignature("prod-1", members, ATTRS, DEFAULTS);
  assert.equal(sig1, sig2);
  assert.ok(sig1);
});

test("TEST 2 — same logical combination, REVERSED member array order → identical signature", () => {
  const forward = [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }];
  const reversed = [{ attributeName: "Beta", value: "vb" }, { attributeName: "Alpha", value: "va" }];
  assert.equal(
    computeIntendedCombinationSignature("prod-1", forward, ATTRS, DEFAULTS),
    computeIntendedCombinationSignature("prod-1", reversed, ATTRS, DEFAULTS),
  );
});

test("TEST 3 — same logical combination, reversed price-impacting attribute ITERATION order (simulating Salesforce query order changing) → identical signature", () => {
  const members = [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }];
  const sigNormalOrder = computeIntendedCombinationSignature("prod-1", members, ["Alpha", "Beta", "Gamma"], DEFAULTS);
  const sigReversedOrder = computeIntendedCombinationSignature("prod-1", members, ["Gamma", "Beta", "Alpha"], DEFAULTS);
  assert.equal(sigNormalOrder, sigReversedOrder);
});

test("TEST 4 — same logical combination, completely DIFFERENT generated Rule Name → same identity (Name is never part of the signature)", () => {
  const members = [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }];
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  const existingRules = [existingCompleteRule("rule-1", "Completely_Unrelated_Display_Name_Rule", "prod-1", [
    { attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }, { attributeName: "Gamma", value: "default-g" },
  ], ATTRS, members)];
  const matches = matchExistingRulesToCombinations(combinations, existingRules, "prod-1", ATTRS, DEFAULTS);
  assert.equal(matches.get(0)!.status, "KEEP");
  assert.equal(matches.get(0)!.ruleId, "rule-1");
});

test("TEST 5 — old naming scheme (attribute-order-dependent name) + the new deterministic naming scheme both resolve to the SAME existing Rule, by content", () => {
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  // "Beta_Alpha_..." simulates a Rule created under the OLD, non-deterministic naming (Beta encountered
  // first in some prior query order) — its NAME reflects that, but its real CONTENT is identical.
  const existingRules = [existingCompleteRule("legacy-rule", "Beta_Alpha_vb_va_Rule", "prod-1", [
    { attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }, { attributeName: "Gamma", value: "default-g" },
  ], ATTRS, [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }])];
  const matches = matchExistingRulesToCombinations(combinations, existingRules, "prod-1", ATTRS, DEFAULTS);
  assert.equal(matches.get(0)!.status, "KEEP", `expected the legacy-named Rule to be recognized by content; got: ${JSON.stringify(matches.get(0))}`);
  assert.equal(matches.get(0)!.ruleId, "legacy-rule");
});

test("TEST 6 — genuinely DIFFERENT combinations produce DIFFERENT signatures", () => {
  const sigA = computeIntendedCombinationSignature("prod-1", [{ attributeName: "Alpha", value: "va1" }, { attributeName: "Beta", value: "vb" }], ATTRS, DEFAULTS);
  const sigB = computeIntendedCombinationSignature("prod-1", [{ attributeName: "Alpha", value: "va2" }, { attributeName: "Beta", value: "vb" }], ATTRS, DEFAULTS);
  assert.notEqual(sigA, sigB);
});

test("TEST 7 — the SAME attribute/value combination under DIFFERENT products produces DIFFERENT signatures", () => {
  const members = [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }];
  const sigProductA = computeIntendedCombinationSignature("prod-A", members, ATTRS, DEFAULTS);
  const sigProductB = computeIntendedCombinationSignature("prod-B", members, ATTRS, DEFAULTS);
  assert.notEqual(sigProductA, sigProductB);
});

test("TEST 8 — attributes ADDED: new combination identities appear, unrelated to any existing Rule's content", () => {
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Delta", "vd")]];
  const existingRules: ExistingRuleContentIdentity[] = []; // nothing pre-existing involves the newly-added "Delta" attribute
  const attrsWithNew = [...ATTRS, "Delta"];
  const defaultsWithNew = new Map(DEFAULTS); defaultsWithNew.set("Delta", "default-d");
  const matches = matchExistingRulesToCombinations(combinations, existingRules, "prod-1", attrsWithNew, defaultsWithNew);
  assert.equal(matches.get(0)!.status, "CREATE");
});

test("TEST 9 — attributes REMOVED: an existing Rule that included the now-removed attribute is never falsely matched to a combination that no longer has it", () => {
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]]; // Gamma removed from the price-impacting set entirely
  const reducedAttrs = ["Alpha", "Beta"];
  // This existing Rule's real signature was computed back when Gamma still existed — different token set,
  // so it must NOT match the new (Gamma-less) intended signature merely by coincidence.
  const existingRules = [existingCompleteRule("old-rule-with-gamma", "Old_Rule", "prod-1", [
    { attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }, { attributeName: "Gamma", value: "default-g" },
  ], ATTRS, [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }])];
  const matches = matchExistingRulesToCombinations(combinations, existingRules, "prod-1", reducedAttrs, DEFAULTS);
  assert.equal(matches.get(0)!.status, "CREATE", "an obsolete Rule signed against a since-removed attribute must not be falsely reused");
});

test("TEST 10 — completely different, org-agnostic attribute/value/product shapes (no vocabulary shared with any real org data) work identically", () => {
  const weirdAttrs = ["###weird-attr-Q1###", "###weird-attr-Z9###"];
  const weirdDefaults = new Map<string, string | null>([["###weird-attr-Q1###", "###base1###"], ["###weird-attr-Z9###", "###base2###"]]);
  const members = [{ attributeName: "###weird-attr-Q1###", value: "###val-A###" }, { attributeName: "###weird-attr-Z9###", value: "###val-B###" }];
  const combinations: AttributePricedOption[][] = [[opt("###weird-attr-Q1###", "###val-A###"), opt("###weird-attr-Z9###", "###val-B###")]];
  const existingRules = [existingCompleteRule("weird-rule-Id-77", "###weird-generated-name###", "###weird-product-Id###", members, weirdAttrs, members)];
  const matches = matchExistingRulesToCombinations(combinations, existingRules, "###weird-product-Id###", weirdAttrs, weirdDefaults);
  assert.equal(matches.get(0)!.status, "KEEP");
});

test("TEST 11 — an incomplete existing Rule is identified by its actual (partial) condition content and classified COMPLETE, uniquely", () => {
  const combinations: AttributePricedOption[][] = [
    [opt("Alpha", "va"), opt("Beta", "vb")],
    [opt("Alpha", "va2"), opt("Beta", "vb")],
  ];
  // This incomplete Rule has ONLY an Alpha=va condition so far (its Beta and Gamma conditions were never
  // created — a genuinely partial run) — Alpha=va is a subset of combination 0's members but NOT of
  // combination 1's (which has Alpha=va2, a different value) — so it must uniquely resolve to combo 0.
  const existingRules = [existingIncompleteRule("incomplete-rule", "Partial_Rule", [{ attributeName: "Alpha", value: "va" }])];
  const matches = matchExistingRulesToCombinations(combinations, existingRules, "prod-1", ATTRS, DEFAULTS);
  assert.equal(matches.get(0)!.status, "COMPLETE", `expected combo 0 to be uniquely completed by the incomplete rule; got ${JSON.stringify(matches.get(0))}`);
  assert.equal(matches.get(0)!.ruleId, "incomplete-rule");
  assert.equal(matches.get(1)!.status, "CREATE", "combo 1 has a DIFFERENT Alpha value — the incomplete rule's content must not match it");
});

test("TEST 12 — a Rule-NAME collision between two DIFFERENT logical combinations does not cause them to be treated as the same combination", () => {
  // Two genuinely different combinations that (hypothetically) happen to sanitize to the same display Name
  // — content identity must still tell them apart, since it never reads Name at all.
  const combinations: AttributePricedOption[][] = [
    [opt("Alpha", "va1"), opt("Beta", "vb")],
    [opt("Alpha", "va2"), opt("Beta", "vb")],
  ];
  const existingRules = [
    existingCompleteRule("rule-for-va1", "Colliding_Name_Rule", "prod-1", [{ attributeName: "Alpha", value: "va1" }, { attributeName: "Beta", value: "vb" }, { attributeName: "Gamma", value: "default-g" }], ATTRS, [{ attributeName: "Alpha", value: "va1" }, { attributeName: "Beta", value: "vb" }]),
    existingCompleteRule("rule-for-va2", "Colliding_Name_Rule", "prod-1", [{ attributeName: "Alpha", value: "va2" }, { attributeName: "Beta", value: "vb" }, { attributeName: "Gamma", value: "default-g" }], ATTRS, [{ attributeName: "Alpha", value: "va2" }, { attributeName: "Beta", value: "vb" }]),
  ];
  const matches = matchExistingRulesToCombinations(combinations, existingRules, "prod-1", ATTRS, DEFAULTS);
  assert.equal(matches.get(0)!.status, "KEEP");
  assert.equal(matches.get(0)!.ruleId, "rule-for-va1", "combo 0 (Alpha=va1) must resolve to ITS OWN rule, never the same-named other one");
  assert.equal(matches.get(1)!.status, "KEEP");
  assert.equal(matches.get(1)!.ruleId, "rule-for-va2", "combo 1 (Alpha=va2) must resolve to ITS OWN rule, never the same-named other one");
});

test("TEST 13 — identity is independent of display-name length/truncation: a Rule whose real Name was hash-suffixed (post-truncation) is still matched purely by content", () => {
  const members = [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }];
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  const truncatedHashedName = "Alpha_Beta_va_vb_Rule_a1b2c3d4e5"; // shape of a real hash-suffixed name — irrelevant to matching
  const existingRules = [existingCompleteRule("rule-1", truncatedHashedName, "prod-1", [
    { attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }, { attributeName: "Gamma", value: "default-g" },
  ], ATTRS, members)];
  const matches = matchExistingRulesToCombinations(combinations, existingRules, "prod-1", ATTRS, DEFAULTS);
  assert.equal(matches.get(0)!.status, "KEEP");
});

test("TEST 14 — Salesforce query ORDER changes (the members array arrives in a different order across two independent calls) never change the match outcome", () => {
  const existingRules = [existingCompleteRule("rule-1", "Some_Name_Rule", "prod-1", [
    { attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }, { attributeName: "Gamma", value: "default-g" },
  ], ATTRS, [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }])];

  const comboForward: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  const comboReversed: AttributePricedOption[][] = [[opt("Beta", "vb"), opt("Alpha", "va")]];

  const matchesForward = matchExistingRulesToCombinations(comboForward, existingRules, "prod-1", ATTRS, DEFAULTS);
  const matchesReversed = matchExistingRulesToCombinations(comboReversed, existingRules, "prod-1", ATTRS, DEFAULTS);

  assert.equal(matchesForward.get(0)!.status, "KEEP");
  assert.equal(matchesReversed.get(0)!.status, "KEEP");
  assert.equal(matchesForward.get(0)!.ruleId, matchesReversed.get(0)!.ruleId);
});

test("BONUS — genuine cross-combination ambiguity (an incomplete Rule's present content is consistent with 2+ different planned combinations) fails closed, never guesses", () => {
  const combinations: AttributePricedOption[][] = [
    [opt("Alpha", "va"), opt("Beta", "vb1")],
    [opt("Alpha", "va"), opt("Beta", "vb2")],
  ];
  // Only Alpha=va is present so far — consistent with BOTH combinations (their Beta values differ, but
  // neither has been written to this Rule's conditions yet) — genuinely ambiguous, must not guess.
  const existingRules = [existingIncompleteRule("ambiguous-rule", "Partial_Rule", [{ attributeName: "Alpha", value: "va" }])];
  const matches = matchExistingRulesToCombinations(combinations, existingRules, "prod-1", ATTRS, DEFAULTS);
  assert.equal(matches.get(0)!.status, "AMBIGUOUS");
  assert.equal(matches.get(1)!.status, "AMBIGUOUS");
});

test("BONUS — 2+ COMPLETE existing Rules sharing the identical signature (a real data anomaly) fails closed rather than picking one arbitrarily", () => {
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  const fullMembers = [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }, { attributeName: "Gamma", value: "default-g" }];
  const existingRules = [
    existingCompleteRule("dup-rule-1", "Name_A", "prod-1", fullMembers, ATTRS, [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }]),
    existingCompleteRule("dup-rule-2", "Name_B", "prod-1", fullMembers, ATTRS, [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }]),
  ];
  const matches = matchExistingRulesToCombinations(combinations, existingRules, "prod-1", ATTRS, DEFAULTS);
  assert.equal(matches.get(0)!.status, "AMBIGUOUS");
});
