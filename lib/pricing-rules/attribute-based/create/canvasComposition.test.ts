/**
 * §Final Fix — coverage for the compose-from-two-donors architecture: semantic multi-output
 * InputUnitPrice selection (the live bug — a real donor publishing [PriceBookEntryId, IsDerived,
 * UnitPrice, SubTotal] must resolve to UnitPrice, never SubTotal/PriceBookEntryId/IsDerived, never a
 * stale NetUnitPrice that isn't actually published), and final-graph structural validation (exactly the
 * three pricing action types, no unrelated branches, every parentStep resolves) — all against the FINAL
 * composed XML, never a donor-vs-generated comparison.
 *
 * Same caveat as every other *.test.ts in this directory: no test framework/runner is installed in this
 * repo (no jest/vitest, no `npm test` script) and none is added here — this file type-checks under
 * `tsc --noEmit` but needs a TypeScript-aware runner (e.g. `tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTargetInputUnitPriceValue, validateFinalComposedCanvas } from "./canvasBuilder";
import { extractStepGraph } from "./xmlBlocks";
import { findDanglingParentStepReferences } from "./pricingCanvasPruning";

// §Item 5/6 — the exact live bug: multi-output ListPrice ([PriceBookEntryId, IsDerived, UnitPrice,
// SubTotal]) must resolve to UnitPrice, never a positional pick (SubTotal is last, PriceBookEntryId is
// first) and never PriceBookEntryId/IsDerived (a lookup Id and a boolean flag — never price values).
test("resolveTargetInputUnitPriceValue selects UnitPrice over SubTotal/PriceBookEntryId/IsDerived from the real live output set", () => {
  const result = resolveTargetInputUnitPriceValue("NetUnitPrice", ["PriceBookEntryId", "IsDerived", "UnitPrice", "SubTotal"]);
  assert.equal(result, "UnitPrice");
});

// §Item 7 — NetUnitPrice must never be selected/retained when ListPrice does not actually publish it.
test("resolveTargetInputUnitPriceValue rejects NetUnitPrice when it is not among the published outputs", () => {
  const result = resolveTargetInputUnitPriceValue("NetUnitPrice", ["PriceBookEntryId", "IsDerived", "UnitPrice", "SubTotal"]);
  assert.notEqual(result, "NetUnitPrice");
});

test("resolveTargetInputUnitPriceValue uses the single output when ListPrice publishes exactly one", () => {
  assert.equal(resolveTargetInputUnitPriceValue("NetUnitPrice", ["ItemContractPrice"]), "ItemContractPrice");
});

test("resolveTargetInputUnitPriceValue keeps the donor's own binding when it already matches a real published output", () => {
  assert.equal(resolveTargetInputUnitPriceValue("ListPrice", ["UnitPrice", "ListPrice", "SubTotal"]), "ListPrice");
});

test("resolveTargetInputUnitPriceValue falls back through the priority list when the donor's binding matches nothing", () => {
  assert.equal(resolveTargetInputUnitPriceValue("SomeUnrelatedValue", ["SubTotal", "NetUnitPrice"]), "NetUnitPrice");
});

test("resolveTargetInputUnitPriceValue returns null when nothing resolves — never guesses", () => {
  assert.equal(resolveTargetInputUnitPriceValue("NetUnitPrice", ["PriceBookEntryId", "IsDerived", "SubTotal"]), null);
});

// §Items 4/8/9 — a composed final canvas (base donor's PricingSettings+ListPrice + one inserted
// AttributeDiscount root) must contain EXACTLY these three action types, never any shared-donor branch.
const COMPOSED_XML = `<ExpressionSetDefinition>
  <versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType></steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parentStep>LP1</parentStep></steps>
  </versions>
</ExpressionSetDefinition>`;

test("a composed final canvas contains exactly PricingSettings, ListPrice, AttributeDiscount — no unrelated branches", () => {
  const graph = extractStepGraph(COMPOSED_XML);
  const actionTypes = graph.map(n => n.actionType).filter((v): v is string => !!v);
  assert.equal(graph.length, 3);
  assert.deepEqual([...new Set(actionTypes)].sort(), ["AttributeDiscount", "ListPrice", "PricingSettings"]);
  const unrelated = ["ManualDiscount", "BundleDiscount", "FormulaBasedPricing", "Proration", "SubscriptionPricing", "VolumeTierDiscount", "VolumeDiscount"];
  assert.equal(actionTypes.some(t => unrelated.includes(t)), false);
});

// §Item 10 — parentStep resolution against the FINAL XML only, never a donor comparison.
test("findDanglingParentStepReferences finds nothing when AttributeDiscount's parentStep resolves to the composed ListPrice", () => {
  const graph = extractStepGraph(COMPOSED_XML);
  const dangling = findDanglingParentStepReferences(graph);
  assert.deepEqual(dangling, []);
});

test("findDanglingParentStepReferences reports a dangling reference when parentStep names a step absent from the final graph", () => {
  const brokenXml = COMPOSED_XML.replace("<parentStep>LP1</parentStep>", "<parentStep>ListContainer27</parentStep>");
  const graph = extractStepGraph(brokenXml);
  const dangling = findDanglingParentStepReferences(graph);
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].parentStep, "ListContainer27");
});

// §Final Fix regression suite — `validateFinalComposedCanvas` (Gate C) locates AttributeDiscount by
// actionType in the FINAL reparsed graph, never by comparing occurrence index against the SOURCE shared
// donor's own numbering. This is the confirmed live bug: the old code did
// `finalGraph.find(n => n.occurrenceIndex === adNode.occurrenceIndex)`, where `adNode.occurrenceIndex`
// (14) was an identity from the 76-step shared donor — structurally impossible to find in a fresh 3-step
// final canvas whose occurrence numbering starts at 0.
const EXPECTED = { inputUnitPrice: "UnitPrice", parentStep: "LP1", stepCount: 3 };

// A synthetic 15-occurrence "source shared donor" — proves AttributeDiscount really is at occurrence 14
// there, entirely independent of (and never fed into) the final-canvas validator below.
function buildSourceDonorWithAttributeDiscountAtOccurrence14(): string {
  const padding = Array.from({ length: 14 }, (_, i) => `<steps><name>Filler${i}</name><actionType>FormulaBasedPricing</actionType></steps>`).join("");
  return `<ExpressionSetDefinition><versions>${padding}<steps><name>SourceAD</name><actionType>AttributeDiscount</actionType><parentStep>ListContainer27</parentStep></steps></versions></ExpressionSetDefinition>`;
}

// TEST 1 / TEST 7 — source occurrence 14 vs. final occurrence 2: validation MUST PASS, and the test
// explicitly proves the source index (14) is never compared against the final index (2) at all.
test("TEST 1/7 — source AttributeDiscount at occurrence 14, final AttributeDiscount at occurrence 2: validation PASSES", () => {
  const sourceGraph = extractStepGraph(buildSourceDonorWithAttributeDiscountAtOccurrence14());
  const sourceAdNode = sourceGraph.find(n => n.actionType === "AttributeDiscount")!;
  assert.equal(sourceAdNode.occurrenceIndex, 14, "sanity check: the source donor's AttributeDiscount really is at occurrence 14");

  const composedWithInputUnitPrice = COMPOSED_XML.replace("<actionType>AttributeDiscount</actionType>", "<actionType>AttributeDiscount</actionType><parameters><name>InputUnitPrice</name><type>Parameter</type><value>UnitPrice</value></parameters>");
  const finalGraph = extractStepGraph(composedWithInputUnitPrice);
  const finalAdNode = finalGraph.find(n => n.actionType === "AttributeDiscount")!;
  assert.equal(finalAdNode.occurrenceIndex, 2, "sanity check: the final composed canvas's AttributeDiscount is at occurrence 2, NOT 14");

  const result = validateFinalComposedCanvas(finalGraph, EXPECTED);
  assert.deepEqual(result.failures, [], "validation must pass even though the source (14) and final (2) occurrence indexes differ");
  assert.equal(result.finalTargetNode?.occurrenceIndex, 2);
});

// TEST 2 — exactly PricingSettings/ListPrice/AttributeDiscount with the correct InputUnitPrice: PASSES.
test("TEST 2 — exactly PricingSettings, ListPrice, AttributeDiscount with InputUnitPrice=UnitPrice: validation PASSES", () => {
  const finalGraph = extractStepGraph(COMPOSED_XML.replace("<actionType>AttributeDiscount</actionType>", "<actionType>AttributeDiscount</actionType><parameters><name>InputUnitPrice</name><type>Parameter</type><value>UnitPrice</value></parameters>"));
  const result = validateFinalComposedCanvas(finalGraph, EXPECTED);
  assert.deepEqual(result.failures, []);
});

// TEST 3 — InputUnitPrice mismatch (NetUnitPrice instead of the expected UnitPrice): validation MUST
// FAIL with the actual binding mismatch, naming both the found and expected value.
test("TEST 3 — AttributeDiscount.InputUnitPrice=NetUnitPrice when UnitPrice was expected: validation FAILS with the mismatch", () => {
  const finalGraph = extractStepGraph(COMPOSED_XML.replace("<actionType>AttributeDiscount</actionType>", "<actionType>AttributeDiscount</actionType><parameters><name>InputUnitPrice</name><type>Parameter</type><value>NetUnitPrice</value></parameters>"));
  const result = validateFinalComposedCanvas(finalGraph, EXPECTED);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /InputUnitPrice="NetUnitPrice", expected "UnitPrice"/);
});

// TEST 4 — zero AttributeDiscount occurrences: validation MUST FAIL.
test("TEST 4 — zero AttributeDiscount occurrences: validation FAILS", () => {
  const noAdXml = `<ExpressionSetDefinition><versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType></steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType></steps>
  </versions></ExpressionSetDefinition>`;
  const finalGraph = extractStepGraph(noAdXml);
  const result = validateFinalComposedCanvas(finalGraph, EXPECTED);
  assert.ok(result.failures.some(f => f.includes("found 0")));
  assert.equal(result.finalTargetNode, null);
});

// TEST 5 — two AttributeDiscount occurrences: validation MUST FAIL (never silently pick one).
test("TEST 5 — two AttributeDiscount occurrences: validation FAILS", () => {
  const twoAdXml = `<ExpressionSetDefinition><versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType></steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parentStep>LP1</parentStep></steps>
    <steps><name>AD2</name><actionType>AttributeDiscount</actionType><parentStep>LP1</parentStep></steps>
  </versions></ExpressionSetDefinition>`;
  const finalGraph = extractStepGraph(twoAdXml);
  const result = validateFinalComposedCanvas(finalGraph, { ...EXPECTED, stepCount: 4 });
  assert.ok(result.failures.some(f => f.includes("found 2")));
  assert.equal(result.finalTargetNode, null);
});

// TEST 6 — an unrelated pricing branch (ManualDiscount/BundleDiscount) survives into the final canvas:
// validation MUST FAIL.
test("TEST 6 — ManualDiscount/BundleDiscount surviving into the final canvas: validation FAILS", () => {
  const withUnrelatedXml = COMPOSED_XML.replace(
    "</versions>",
    `<steps><name>MD1</name><actionType>ManualDiscount</actionType></steps></versions>`,
  );
  const finalGraph = extractStepGraph(withUnrelatedXml);
  const result = validateFinalComposedCanvas(finalGraph, { ...EXPECTED, stepCount: 4 });
  assert.ok(result.failures.some(f => f.includes("ManualDiscount")));
});
