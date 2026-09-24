/**
 * §Combination-expansion architecture fix (Step 8.5) — `resolveExplicitCombinations` resolves every
 * explicit combination requirement from the prompt against REAL Salesforce attribute/value data (here,
 * fixture `DiscoveredAttribute[]` standing in for a real discovery result), using the same
 * case/whitespace-insensitive normalization the rest of this module already uses. Pure — no Salesforce/AI
 * dependency, so these tests run directly.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveExplicitCombinations } from "./analyze";
import type { DiscoveredAttribute, ExtractedCombination } from "./types";

function attr(name: string, values: string[]): DiscoveredAttribute {
  return { name, label: name, dataType: "Picklist", isPriceImpacting: true, values: values.map(v => ({ value: v, label: v })) };
}

const LAPTOP_ATTRS: DiscoveredAttribute[] = [
  attr("RAM", ["8GB", "16GB", "32GB", "64GB"]),
  attr("Storage", ["256GB", "512GB", "1TB", "2TB"]),
  attr("Processor", ["i5", "i7", "i9"]),
];

function combo(members: { attribute: string; value: string }[], adjustmentType: "fixed" | "percentage" | "override" | null = "fixed", adjustment: number | null = 5000, rawText = "test combo"): ExtractedCombination {
  return { members, adjustmentType, adjustment, rawText };
}

test("A — one explicit combination resolves to exactly one CombinationRulePlanRow with real attribute/value labels", () => {
  const { resolved, problems } = resolveExplicitCombinations([combo([{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }])], LAPTOP_ATTRS);
  assert.deepEqual(problems, []);
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0].members, [
    { attributeName: "RAM", attributeLabel: "RAM", value: "32GB", valueLabel: "32GB" },
    { attributeName: "Storage", attributeLabel: "Storage", value: "1TB", valueLabel: "1TB" },
  ]);
  assert.equal(resolved[0].adjustmentType, "fixed");
  assert.equal(resolved[0].adjustment, 5000);
});

test("B — two independent explicit combinations resolve to exactly two rows", () => {
  const { resolved, problems } = resolveExplicitCombinations([
    combo([{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }], "fixed", 5000, "combo 1"),
    combo([{ attribute: "RAM", value: "64GB" }, { attribute: "Processor", value: "i9" }], "fixed", 9000, "combo 2"),
  ], LAPTOP_ATTRS);
  assert.deepEqual(problems, []);
  assert.equal(resolved.length, 2);
});

test("C — three explicit combinations resolve to exactly three rows, never more", () => {
  const { resolved, problems } = resolveExplicitCombinations([
    combo([{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }], "fixed", 5000, "c1"),
    combo([{ attribute: "RAM", value: "64GB" }, { attribute: "Storage", value: "2TB" }], "fixed", 9000, "c2"),
    combo([{ attribute: "RAM", value: "16GB" }, { attribute: "Processor", value: "i5" }], "percentage", 10, "c3"),
  ], LAPTOP_ATTRS);
  assert.deepEqual(problems, []);
  assert.equal(resolved.length, 3);
});

test("D — a 3-attribute explicit combination resolves with all 3 members intact", () => {
  const { resolved, problems } = resolveExplicitCombinations([combo([{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }, { attribute: "Processor", value: "i9" }])], LAPTOP_ATTRS);
  assert.deepEqual(problems, []);
  assert.equal(resolved[0].members.length, 3);
});

test("E — an unknown attribute FAILS CLOSED with a specific, non-guessed problem — never substitutes a similar-sounding attribute", () => {
  const { resolved, problems } = resolveExplicitCombinations([combo([{ attribute: "Graphics Card", value: "RTX" }, { attribute: "Storage", value: "1TB" }])], LAPTOP_ATTRS);
  assert.equal(resolved.length, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /Graphics Card.*does not exist/);
});

test("F — an unknown value for a real attribute FAILS CLOSED — never substitutes the nearest real value", () => {
  const { resolved, problems } = resolveExplicitCombinations([combo([{ attribute: "RAM", value: "128GB" }, { attribute: "Storage", value: "1TB" }])], LAPTOP_ATTRS);
  assert.equal(resolved.length, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /128GB.*does not exist for attribute "RAM"/);
});

test("G — the same attribute referenced twice within one combination FAILS CLOSED (a product can only have one value per attribute at a time)", () => {
  const { resolved, problems } = resolveExplicitCombinations([combo([{ attribute: "RAM", value: "32GB" }, { attribute: "RAM", value: "64GB" }])], LAPTOP_ATTRS);
  assert.equal(resolved.length, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /more than once/);
});

test("H — case/whitespace-insensitive matching (same normalization as the rest of this module) still resolves correctly", () => {
  const { resolved, problems } = resolveExplicitCombinations([combo([{ attribute: "  ram ", value: "32gb" }, { attribute: "STORAGE", value: "1tb" }])], LAPTOP_ATTRS);
  assert.deepEqual(problems, []);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].members[0].attributeName, "RAM");
});

test("I — an identical duplicate combination (same resolved members, same adjustment) is deduplicated safely, never double-created", () => {
  const { resolved, problems } = resolveExplicitCombinations([
    combo([{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }], "fixed", 5000, "first mention"),
    combo([{ attribute: "Storage", value: "1TB" }, { attribute: "RAM", value: "32GB" }], "fixed", 5000, "second mention, different order"),
  ], LAPTOP_ATTRS);
  assert.deepEqual(problems, []);
  assert.equal(resolved.length, 1, "must deduplicate to exactly one rule, not create two for the same combination");
});

test("J — a duplicate combination with a CONFLICTING adjustment FAILS CLOSED — never guesses which one is correct", () => {
  // `resolved`'s exact partial content here is moot: the caller (`analyze.ts`) fails closed and never
  // consults `resolved` at all whenever `problems` is non-empty — only `problems` matters.
  const { problems } = resolveExplicitCombinations([
    combo([{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }], "fixed", 5000, "first mention"),
    combo([{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }], "fixed", 7000, "second, conflicting mention"),
  ], LAPTOP_ATTRS);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /DIFFERENT adjustment/);
});

test("K — a combination with no stated adjustment FAILS CLOSED rather than defaulting to 0", () => {
  const { resolved, problems } = resolveExplicitCombinations([combo([{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }], null, null)], LAPTOP_ATTRS);
  assert.equal(resolved.length, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /No price adjustment was stated/);
});

test("L — no explicit combinations at all (the common case) resolves to zero rows and zero problems — never invents one", () => {
  const { resolved, problems } = resolveExplicitCombinations([], LAPTOP_ATTRS);
  assert.deepEqual(resolved, []);
  assert.deepEqual(problems, []);
});
