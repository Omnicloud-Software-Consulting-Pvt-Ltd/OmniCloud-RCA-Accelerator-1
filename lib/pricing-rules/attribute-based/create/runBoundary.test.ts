/**
 * §Root-cause fix (deterministic run-boundary provenance) — a live forensic investigation
 * ([[project_attribute_based_provenance_forensics]] in memory) proved content alone cannot distinguish a
 * genuinely-partial CURRENT combinatorial-expansion Rule from a complete HISTORICAL Rule left over from an
 * earlier, smaller product-attribute configuration — 85 legacy Rules in one real org were content-identical
 * in shape to a genuinely-partial current Rule. `CreatedDate` clustering resolved it as a READ-ONLY forensic
 * signal but was explicitly ruled out as the production mechanism (a heuristic gap threshold is not a real
 * boundary, and the exact threshold would itself be an unwanted hardcoded constant).
 *
 * `runBoundaryStore.ts` provides the real boundary instead: an in-memory, `globalThis`-anchored map keyed
 * by the pipeline's own `executionId` (already generated once per run, never reinvented), tracking exactly
 * which Rule Ids THAT run has created. `matchExistingRulesToCombinations`'s optional
 * `currentRunEligibleRuleIds` parameter (nativeRecords.ts) consumes this set to restrict "COMPLETE"
 * eligibility to only Rules the current run itself created — never Name, never CreatedDate, never
 * condition count alone.
 *
 * These tests cover the store directly (pure, in-memory, no Salesforce) and its integration with
 * `matchExistingRulesToCombinations`'s existing pure matching logic.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  beginRunSnapshot, recordRuleCreatedDuringRun, getRuleIdsCreatedDuringRun, getRunSnapshot,
  _clearAllRunSnapshotsForTests,
} from "./runBoundaryStore";
import {
  computeIntendedCombinationSignature, matchExistingRulesToCombinations,
  type AttributePricedOption, type ExistingRuleContentIdentity,
} from "./nativeRecords";

beforeEach(() => { _clearAllRunSnapshotsForTests(); });

function opt(attributeName: string, value: string): AttributePricedOption {
  return { attributeName, attributeLabel: attributeName, value, valueLabel: value, ruleId: `rule-${attributeName}-${value}`, adjustmentId: `adj-${attributeName}-${value}`, adjustmentType: "Amount", adjustmentValue: 10 };
}
function existingCompleteRule(ruleId: string, productId: string, allMembers: { attributeName: string; value: string }[], attrs: string[], nonBaseline: { attributeName: string; value: string }[]): ExistingRuleContentIdentity {
  return { ruleId, name: `${ruleId}_Rule`, presentNonBaselineMembers: nonBaseline, isComplete: true, signature: computeIntendedCombinationSignature(productId, allMembers, attrs, new Map()), conditionCount: allMembers.length };
}
function existingIncompleteRule(ruleId: string, nonBaseline: { attributeName: string; value: string }[]): ExistingRuleContentIdentity {
  return { ruleId, name: `${ruleId}_Rule`, presentNonBaselineMembers: nonBaseline, isComplete: false, signature: null, conditionCount: nonBaseline.length };
}

const ATTRS = ["Alpha", "Beta", "Gamma"];
const DEFAULTS = new Map<string, string | null>([["Alpha", "default-a"], ["Beta", "default-b"], ["Gamma", "default-g"]]);

test("TEST 1 — an existing Rule that predates the run is never treated as current-incomplete solely because it has fewer conditions", () => {
  const preExistingIncompleteRule = existingIncompleteRule("pre-existing-rule", [{ attributeName: "Alpha", value: "va" }]);
  beginRunSnapshot("exec-1", "prod-1", new Set(["pre-existing-rule"])); // it already existed at snapshot time
  const eligible = getRuleIdsCreatedDuringRun("exec-1"); // nothing created yet — empty
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  const matches = matchExistingRulesToCombinations(combinations, [preExistingIncompleteRule], "prod-1", ATTRS, DEFAULTS, eligible);
  assert.equal(matches.get(0)!.status, "CREATE", "a pre-existing incomplete Rule must never become COMPLETE merely because it happens to have fewer conditions");
});

test("TEST 2 — a Rule created DURING the current run is eligible for incomplete reconciliation (COMPLETE)", () => {
  beginRunSnapshot("exec-2", "prod-1", new Set()); // nothing existed before this run
  recordRuleCreatedDuringRun("exec-2", "new-rule-from-this-run");
  const eligible = getRuleIdsCreatedDuringRun("exec-2");
  const thisRunsIncompleteRule = existingIncompleteRule("new-rule-from-this-run", [{ attributeName: "Alpha", value: "va" }]);
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  const matches = matchExistingRulesToCombinations(combinations, [thisRunsIncompleteRule], "prod-1", ATTRS, DEFAULTS, eligible);
  assert.equal(matches.get(0)!.status, "COMPLETE");
  assert.equal(matches.get(0)!.ruleId, "new-rule-from-this-run");
});

test("TEST 3 — an existing COMPLETE Rule is KEEP regardless of run-eligibility (completeness never depends on run boundary)", () => {
  beginRunSnapshot("exec-3", "prod-1", new Set(["complete-rule"]));
  const eligible = getRuleIdsCreatedDuringRun("exec-3"); // empty — this run created nothing
  const fullMembers = [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }, { attributeName: "Gamma", value: "default-g" }];
  const rule = existingCompleteRule("complete-rule", "prod-1", fullMembers, ATTRS, [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }]);
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  const matches = matchExistingRulesToCombinations(combinations, [rule], "prod-1", ATTRS, DEFAULTS, eligible);
  assert.equal(matches.get(0)!.status, "KEEP");
  assert.equal(matches.get(0)!.ruleId, "complete-rule");
});

test("TEST 4 — a historical partial Rule (pre-existing, never created by this run) is never COMPLETE, even when it's the ONLY plausible content match", () => {
  beginRunSnapshot("exec-4", "prod-1", new Set(["historical-partial-rule"]));
  const eligible = getRuleIdsCreatedDuringRun("exec-4");
  const historicalRule = existingIncompleteRule("historical-partial-rule", [{ attributeName: "Alpha", value: "va" }]);
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  const matches = matchExistingRulesToCombinations(combinations, [historicalRule], "prod-1", ATTRS, DEFAULTS, eligible);
  assert.equal(matches.get(0)!.status, "CREATE", "no independent evidence this historical Rule belongs to the current run — must not guess it into COMPLETE");
});

test("TEST 5 — a current-run incomplete Rule becomes COMPLETE only when it uniquely identifies exactly one planned combination", () => {
  beginRunSnapshot("exec-5", "prod-1", new Set());
  recordRuleCreatedDuringRun("exec-5", "current-partial-rule");
  const eligible = getRuleIdsCreatedDuringRun("exec-5");
  const rule = existingIncompleteRule("current-partial-rule", [{ attributeName: "Alpha", value: "va" }]);
  const combinations: AttributePricedOption[][] = [
    [opt("Alpha", "va"), opt("Beta", "vb")],
    [opt("Alpha", "vaOTHER"), opt("Beta", "vb")],
  ];
  const matches = matchExistingRulesToCombinations(combinations, [rule], "prod-1", ATTRS, DEFAULTS, eligible);
  assert.equal(matches.get(0)!.status, "COMPLETE");
  assert.equal(matches.get(1)!.status, "CREATE", "the OTHER combination has a different Alpha value — the current-run rule's content must not match it");
});

test("TEST 6 — attribute ordering changes never change which existing Rule a combination resolves to (order-independence still holds with run-boundary eligibility applied)", () => {
  beginRunSnapshot("exec-6", "prod-1", new Set(["rule-1"]));
  recordRuleCreatedDuringRun("exec-6", "rule-1");
  const eligible = getRuleIdsCreatedDuringRun("exec-6");
  const fullMembers = [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }, { attributeName: "Gamma", value: "default-g" }];
  const rule = existingCompleteRule("rule-1", "prod-1", fullMembers, ATTRS, [{ attributeName: "Alpha", value: "va" }, { attributeName: "Beta", value: "vb" }]);
  const forward: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  const reversed: AttributePricedOption[][] = [[opt("Beta", "vb"), opt("Alpha", "va")]];
  const m1 = matchExistingRulesToCombinations(forward, [rule], "prod-1", ATTRS, DEFAULTS, eligible);
  const m2 = matchExistingRulesToCombinations(reversed, [rule], "prod-1", ATTRS, DEFAULTS, eligible);
  assert.equal(m1.get(0)!.ruleId, m2.get(0)!.ruleId);
  assert.equal(m1.get(0)!.status, "KEEP");
  assert.equal(m2.get(0)!.status, "KEEP");
});

test("TEST 7 — Rule NAME changes never change combination identity (run-boundary eligibility is keyed by ruleId content, never by generated Name)", () => {
  beginRunSnapshot("exec-7", "prod-1", new Set());
  recordRuleCreatedDuringRun("exec-7", "some-rule-id");
  const eligible = getRuleIdsCreatedDuringRun("exec-7");
  const rule: ExistingRuleContentIdentity = { ...existingIncompleteRule("some-rule-id", [{ attributeName: "Alpha", value: "va" }]), name: "Totally_Arbitrary_Display_Name_That_Changed" };
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  const matches = matchExistingRulesToCombinations(combinations, [rule], "prod-1", ATTRS, DEFAULTS, eligible);
  assert.equal(matches.get(0)!.status, "COMPLETE");
  assert.equal(matches.get(0)!.ruleId, "some-rule-id");
});

test("TEST 8 — two runs for DIFFERENT products never cross-contaminate each other's created-Rule set", () => {
  beginRunSnapshot("exec-productA", "prod-A", new Set());
  recordRuleCreatedDuringRun("exec-productA", "rule-from-A");
  beginRunSnapshot("exec-productB", "prod-B", new Set());
  recordRuleCreatedDuringRun("exec-productB", "rule-from-B");

  const eligibleA = getRuleIdsCreatedDuringRun("exec-productA");
  const eligibleB = getRuleIdsCreatedDuringRun("exec-productB");
  assert.ok(eligibleA.has("rule-from-A") && !eligibleA.has("rule-from-B"));
  assert.ok(eligibleB.has("rule-from-B") && !eligibleB.has("rule-from-A"));
  assert.equal(getRunSnapshot("exec-productA")!.productId, "prod-A");
  assert.equal(getRunSnapshot("exec-productB")!.productId, "prod-B");
});

test("TEST 9 — arbitrary, unusually-shaped executionId/productId/ruleId strings (no assumption about their shape) remain correctly isolated", () => {
  beginRunSnapshot("###weird-exec-9x@!###", "###weird-product-Z1###", new Set(["###pre-existing###"]));
  recordRuleCreatedDuringRun("###weird-exec-9x@!###", "###newly-created###");
  const eligible = getRuleIdsCreatedDuringRun("###weird-exec-9x@!###");
  assert.ok(eligible.has("###newly-created###"));
  assert.ok(!eligible.has("###pre-existing###"));
  // A completely unrelated, never-begun executionId must return an empty set, never throw or leak state.
  assert.equal(getRuleIdsCreatedDuringRun("###never-started###").size, 0);
});

test("TEST 10 — process restart: an executionId with no snapshot (store was cleared/lost) degrades safely to an empty eligible set, never a false match", () => {
  beginRunSnapshot("exec-10", "prod-1", new Set());
  recordRuleCreatedDuringRun("exec-10", "rule-created-before-restart");
  assert.equal(getRuleIdsCreatedDuringRun("exec-10").size, 1, "sanity check: the store has the record before the simulated restart");

  _clearAllRunSnapshotsForTests(); // simulates the server process restarting (the store is in-memory only)

  const eligibleAfterRestart = getRuleIdsCreatedDuringRun("exec-10");
  assert.equal(eligibleAfterRestart.size, 0, "after a restart, the same executionId must resolve to an empty (never a stale/fabricated) eligible set");

  // recordRuleCreatedDuringRun must never throw when called for an executionId with no snapshot (e.g. a
  // stray resume attempt after a restart) — it's a silent no-op, not a crash.
  assert.doesNotThrow(() => recordRuleCreatedDuringRun("exec-10", "rule-after-restart"));

  const rule = existingIncompleteRule("rule-created-before-restart", [{ attributeName: "Alpha", value: "va" }]);
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  const matches = matchExistingRulesToCombinations(combinations, [rule], "prod-1", ATTRS, DEFAULTS, eligibleAfterRestart);
  assert.equal(matches.get(0)!.status, "CREATE", "post-restart, this Rule can no longer be proven to belong to the current run — must fail safe, not guess");
});

test("TEST 11 — a genuine resume (the SAME executionId presented again, process never restarted) correctly recognizes Rules created by an EARLIER call under that id", () => {
  beginRunSnapshot("exec-11", "prod-1", new Set());
  recordRuleCreatedDuringRun("exec-11", "rule-from-first-call");
  // A second, later call presents the SAME executionId (e.g. a client retry after a dropped connection) —
  // beginRunSnapshot must be idempotent and must NOT wipe out what the first call already recorded.
  const resumedSnapshot = beginRunSnapshot("exec-11", "prod-1", new Set(["some-other-pre-existing-rule"]));
  assert.ok(resumedSnapshot.createdRuleIds.has("rule-from-first-call"), "resuming must preserve everything already recorded under this executionId");
  const eligible = getRuleIdsCreatedDuringRun("exec-11");
  assert.ok(eligible.has("rule-from-first-call"));
});

test("TEST 12 — two CONCURRENT runs for the SAME product each track only their own created Rules — no false cross-run COMPLETE, though redundant CREATE attempts for the same missing combination are an explicit, un-solved limitation", () => {
  // Both runs observe the identical pre-run state (the same live product) but have their own executionId.
  const sharedPreRunState = new Set(["already-existing-rule"]);
  beginRunSnapshot("exec-runA", "prod-shared", sharedPreRunState);
  beginRunSnapshot("exec-runB", "prod-shared", sharedPreRunState);

  recordRuleCreatedDuringRun("exec-runA", "rule-created-by-A");
  recordRuleCreatedDuringRun("exec-runB", "rule-created-by-B");

  const eligibleA = getRuleIdsCreatedDuringRun("exec-runA");
  const eligibleB = getRuleIdsCreatedDuringRun("exec-runB");
  assert.ok(eligibleA.has("rule-created-by-A") && !eligibleA.has("rule-created-by-B"), "Run A must never treat Run B's newly-created Rule as its own");
  assert.ok(eligibleB.has("rule-created-by-B") && !eligibleB.has("rule-created-by-A"), "Run B must never treat Run A's newly-created Rule as its own");

  // Neither run's eligible set include the OTHER's incomplete Rule as a COMPLETE candidate.
  const ruleFromA = existingIncompleteRule("rule-created-by-A", [{ attributeName: "Alpha", value: "va" }]);
  const combinations: AttributePricedOption[][] = [[opt("Alpha", "va"), opt("Beta", "vb")]];
  const matchesFromRunBsPerspective = matchExistingRulesToCombinations(combinations, [ruleFromA], "prod-shared", ATTRS, DEFAULTS, eligibleB);
  assert.equal(matchesFromRunBsPerspective.get(0)!.status, "CREATE", "Run B must not complete a Rule that Run A created, even though it's content-plausible");
});
