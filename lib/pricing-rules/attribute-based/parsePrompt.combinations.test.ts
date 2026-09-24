/**
 * §Combination-expansion architecture fix — `toExtractedCombinations` is the pure mapping/filtering layer
 * between the AI's raw JSON and the structured `ExtractedCombination[]` the rest of the pipeline consumes.
 * Tested directly (no Anthropic call, no network) — the SYSTEM_PROMPT instructs the AI on WHEN to populate
 * "combinations" (explicit "when A and B" language only, never merely because multiple attributes are
 * mentioned), but this function is what actually enforces the structural invariants no matter what shape
 * the AI happens to return: at least 2 members, real strings only, never a guessed/default rawText.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toExtractedCombinations } from "./parsePrompt";

test("A — a well-formed 2-member combination maps through cleanly", () => {
  const out = toExtractedCombinations([
    { members: [{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }], adjustmentType: "fixed", adjustment: 5000, rawText: "When RAM is 32GB AND Storage is 1TB, give an additional 5000" },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].members, [{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }]);
  assert.equal(out[0].adjustmentType, "fixed");
  assert.equal(out[0].adjustment, 5000);
  assert.match(out[0].rawText, /RAM is 32GB/);
});

test("B — a 1-member 'combination' is dropped (that's just an independent attribute/value, not a combination)", () => {
  const out = toExtractedCombinations([{ members: [{ attribute: "RAM", value: "32GB" }], adjustmentType: "fixed", adjustment: 12000, rawText: "RAM 32GB adds 12000" }]);
  assert.deepEqual(out, []);
});

test("C — an empty or absent 'combinations' array (the common case: independent attributes only) produces zero entries — never fabricated", () => {
  assert.deepEqual(toExtractedCombinations([]), []);
  assert.deepEqual(toExtractedCombinations(undefined), []);
  assert.deepEqual(toExtractedCombinations(null), []);
});

test("D — a combination with no stated adjustment is still included (with adjustmentType/adjustment null) — never silently dropped, never guessed", () => {
  const out = toExtractedCombinations([
    { members: [{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }], adjustmentType: null, adjustment: null, rawText: "when RAM is 32GB and Storage is 1TB" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].adjustmentType, null);
  assert.equal(out[0].adjustment, null);
});

test("E — a 3-member combination is preserved in full (not truncated to 2)", () => {
  const out = toExtractedCombinations([
    { members: [{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }, { attribute: "Processor", value: "i9" }], adjustmentType: "fixed", adjustment: 15000, rawText: "..." },
  ]);
  assert.equal(out[0].members.length, 3);
});

test("F — malformed members (missing attribute or value, non-string) are filtered out before the 2-member check", () => {
  const out = toExtractedCombinations([
    { members: [{ attribute: "RAM", value: "32GB" }, { attribute: "", value: "1TB" }, { attribute: "Processor" }], adjustmentType: "fixed", adjustment: 100, rawText: "x" },
  ]);
  // Only the first member is well-formed -> 1 member -> dropped as not-a-combination.
  assert.deepEqual(out, []);
});

test("G — rawText falls back to a deterministic reconstruction from members when the AI omits it", () => {
  const out = toExtractedCombinations([{ members: [{ attribute: "RAM", value: "32GB" }, { attribute: "Storage", value: "1TB" }], adjustmentType: "fixed", adjustment: 5000 }]);
  assert.equal(out[0].rawText, "RAM=32GB AND Storage=1TB");
});

test("H — multiple independent combinations in one prompt all map through, arbitrary product/attribute names, nothing hardcoded", () => {
  const out = toExtractedCombinations([
    { members: [{ attribute: "###weird-attr-1###", value: "###v1###" }, { attribute: "###weird-attr-2###", value: "###v2###" }], adjustmentType: "percentage", adjustment: 10, rawText: "a" },
    { members: [{ attribute: "###weird-attr-1###", value: "###v3###" }, { attribute: "###weird-attr-2###", value: "###v4###" }], adjustmentType: "override", adjustment: 999, rawText: "b" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1].adjustmentType, "override");
});
