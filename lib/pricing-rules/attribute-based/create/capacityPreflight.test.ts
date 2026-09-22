/**
 * §Root-cause fix (generic, org/product-agnostic Salesforce capacity preflight) — a real live failure
 * ("storage limit exceeded" at Create Expression Set Version / Create Pricing Procedure) proved this
 * pipeline had zero awareness of Salesforce's own Data Storage limit before the combinatorial phase, whose
 * write volume is driven entirely by the CONNECTED PRODUCT's own attribute/value complexity — unbounded,
 * and unrelated to which product it is. A separate product in the SAME org had already deployed
 * successfully earlier, proving this is an org-capacity problem this pipeline never checked for, not a
 * product-specific defect.
 *
 * `estimateCombinatorialWriteCost` is pure and tested directly here with arbitrary, non-Laptop/Monitor
 * shapes (per the multi-org/multi-product requirement — nothing here assumes any specific product).
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCombinatorialWriteCost, SALESFORCE_STORAGE_PER_RECORD_KB } from "./capacityPreflight";
import type { ExistingRuleContentIdentity, CombinationRuleMatch } from "./nativeRecords";

function matchesFrom(entries: { status: CombinationRuleMatch["status"]; ruleId?: string | null }[]): Map<number, CombinationRuleMatch> {
  const m = new Map<number, CombinationRuleMatch>();
  entries.forEach((e, i) => m.set(i, { status: e.status, ruleId: e.ruleId ?? null, reason: "test" }));
  return m;
}

test("A — 1 attribute x 2 values: zero combinations possible (need 2+ attributes), zero estimated writes", () => {
  const combinations: unknown[][] = [];
  const matches = matchesFrom([]);
  const est = estimateCombinatorialWriteCost(combinations, matches, new Map(), 1);
  assert.equal(est.totalCombinations, 0);
  assert.equal(est.estimatedTotalNewRecords, 0);
});

test("B — 2 attributes x 2 values, all CREATE (nothing exists yet): exact write count, no naive multiply", () => {
  const combinations: unknown[][] = [[{}], [{}]]; // 2 planned combinations, content irrelevant to this pure function
  const matches = matchesFrom([{ status: "CREATE" }, { status: "CREATE" }]);
  const priceImpactingAttrCount = 2;
  const est = estimateCombinatorialWriteCost(combinations, matches, new Map(), priceImpactingAttrCount);
  assert.equal(est.createCount, 2);
  assert.equal(est.estimatedNewRules, 2, "each CREATE combo needs exactly one new Rule");
  assert.equal(est.estimatedNewConditions, 4, "each new Rule needs one Condition per price-impacting attribute (2 x 2)");
  assert.equal(est.estimatedNewAdjustments, 2, "each CREATE combo needs exactly one new Adjustment");
  assert.equal(est.estimatedTotalNewRecords, 2 + 4 + 2);
});

test("C — 3 attributes x 3 values, mixed KEEP/CREATE: KEEP contributes ZERO records (reuse-aware, never a flat multiply)", () => {
  const combinations: unknown[][] = [[{}], [{}], [{}]];
  const matches = matchesFrom([{ status: "KEEP", ruleId: "existing-1" }, { status: "CREATE" }, { status: "CREATE" }]);
  const est = estimateCombinatorialWriteCost(combinations, matches, new Map(), 3);
  assert.equal(est.keepCount, 1);
  assert.equal(est.createCount, 2);
  assert.equal(est.estimatedNewRules, 2, "the KEEP combo must not add a Rule");
  assert.equal(est.estimatedNewConditions, 6, "only the 2 CREATE combos' conditions count (2 x 3), never the KEEP one's");
});

test("D — 4 attributes with UNEVEN value counts: COMPLETE combinations only need the MISSING conditions on an existing partial Rule, never a full fresh set", () => {
  const combinations: unknown[][] = [[{}]];
  const partialRule: ExistingRuleContentIdentity = {
    ruleId: "partial-rule", name: "Partial_Rule", presentNonBaselineMembers: [{ attributeName: "A", value: "v1" }],
    isComplete: false, signature: null, conditionCount: 1, // only 1 of 4 price-impacting attributes has a condition so far
  };
  const existingRulesById = new Map([["partial-rule", partialRule]]);
  const matches = matchesFrom([{ status: "COMPLETE", ruleId: "partial-rule" }]);
  const est = estimateCombinatorialWriteCost(combinations, matches, existingRulesById, 4);
  assert.equal(est.completeCount, 1);
  assert.equal(est.estimatedNewRules, 0, "COMPLETE never needs a new Rule — an existing one is being finished");
  assert.equal(est.estimatedNewConditions, 3, "4 needed - 1 already present = 3 missing, never all 4 again");
  assert.equal(est.estimatedNewAdjustments, 1);
});

test("E — product with NO price-impacting attributes: zero combinations, zero estimated writes, no divide-by-zero/NaN", () => {
  const est = estimateCombinatorialWriteCost([], new Map(), new Map(), 0);
  assert.equal(est.totalCombinations, 0);
  assert.equal(est.estimatedTotalNewRecords, 0);
  assert.ok(Number.isFinite(est.estimatedTotalNewRecords));
});

test("F — product with existing PARTIAL combinations (mix of KEEP/COMPLETE/CREATE/AMBIGUOUS) is fully accounted for, nothing double-counted", () => {
  const combinations: unknown[][] = [[{}], [{}], [{}], [{}]];
  const partialRule: ExistingRuleContentIdentity = {
    ruleId: "p1", name: "p1", presentNonBaselineMembers: [], isComplete: false, signature: null, conditionCount: 1,
  };
  const matches = matchesFrom([
    { status: "KEEP", ruleId: "k1" },
    { status: "COMPLETE", ruleId: "p1" },
    { status: "CREATE" },
    { status: "AMBIGUOUS" },
  ]);
  const est = estimateCombinatorialWriteCost(combinations, matches, new Map([["p1", partialRule]]), 5);
  assert.equal(est.keepCount, 1);
  assert.equal(est.completeCount, 1);
  assert.equal(est.createCount, 1);
  assert.equal(est.ambiguousCount, 1);
  assert.equal(est.estimatedNewRules, 1, "only the CREATE combo adds a Rule");
  assert.equal(est.estimatedNewConditions, 5 /* CREATE: 5 attrs */ + 4 /* COMPLETE: 5-1 missing */, "AMBIGUOUS and KEEP never contribute conditions");
  assert.equal(est.estimatedNewAdjustments, 2, "COMPLETE + CREATE each need one; KEEP and AMBIGUOUS need zero");
});

test("G — product where ALL combinations already exist (all KEEP): zero estimated writes regardless of combination count", () => {
  const combinations: unknown[][] = Array.from({ length: 50 }, () => [{}]);
  const matches = matchesFrom(combinations.map((_c, i) => ({ status: "KEEP" as const, ruleId: `existing-${i}` })));
  const est = estimateCombinatorialWriteCost(combinations, matches, new Map(), 6);
  assert.equal(est.keepCount, 50);
  assert.equal(est.estimatedTotalNewRecords, 0, "an org where every combination is already correctly represented needs zero new storage, no matter how large the combination space is");
});

test("H — large combination space (thousands), all CREATE: estimate scales linearly with real combination count, never a fixed/capped guess", () => {
  const n = 2000;
  const combinations: unknown[][] = Array.from({ length: n }, () => [{}]);
  const matches = matchesFrom(combinations.map(() => ({ status: "CREATE" as const })));
  const priceImpactingAttrCount = 8;
  const est = estimateCombinatorialWriteCost(combinations, matches, new Map(), priceImpactingAttrCount);
  assert.equal(est.estimatedNewRules, n);
  assert.equal(est.estimatedNewConditions, n * priceImpactingAttrCount);
  assert.equal(est.estimatedNewAdjustments, n);
  const expectedMB = (est.estimatedTotalNewRecords * SALESFORCE_STORAGE_PER_RECORD_KB) / 1024;
  assert.ok(expectedMB > 0 && Number.isFinite(expectedMB));
});

test("SALESFORCE_STORAGE_PER_RECORD_KB is Salesforce's own documented flat-2KB-per-record rule, not a per-product tuning value", () => {
  assert.equal(SALESFORCE_STORAGE_PER_RECORD_KB, 2);
});
