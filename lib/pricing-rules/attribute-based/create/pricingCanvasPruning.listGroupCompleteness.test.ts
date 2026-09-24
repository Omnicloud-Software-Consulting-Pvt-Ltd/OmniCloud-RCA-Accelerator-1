/**
 * §Root-cause fix (live evidence, execution referencing "Select list filter as the first element in list
 * group. Please remove Attribute Discount Entries.") — the previous lookup-parameter-preservation fix
 * (canvasBuilder.ts's RECOGNIZED_PARAM_NAMES) was necessary but insufficient: Salesforce kept rejecting the
 * SAME error afterward, proving the problem was never the AttributeDiscount step's own parameters but the
 * surrounding canvas STRUCTURE.
 *
 * A standalone script (no dev server, no Anthropic key — same technique as prior investigations) called
 * `buildAttributeCanvas` directly against the real org and captured the exact generated XML, then a
 * hash-verified re-capture of the donor's raw XML proved: `ListGroup` is not a literal XML tag at all — it
 * is `<stepType>ListGroup</stepType>` on an otherwise-empty container step (`ListContainer27`). ALL 21 such
 * ListGroup containers in this donor share IDENTICAL structure: an `AdvancedListFilter` step (Salesforce's
 * "list filter") at `sequenceNumber` 1, declaring `<parentStep>` back to the container, followed by the
 * container's real pricing/business-logic step(s) at sequenceNumber 2+ — with zero exceptions across every
 * pricing action type (AttributeDiscount, BundleDiscount, VolumeDiscount, VolumeTierDiscount,
 * ManualDiscount, FormulaBasedPricing...).
 *
 * `computeRequiredOccurrenceIndexes` (pricingCanvasPruning.ts) only walks UPWARD from the target
 * (AttributeDiscount): its own subtree, physical ancestors, and logical `<parentStep>` NAME chain. It kept
 * `ListContainer27` (an ancestor) but had no notion that the container's OTHER child — the
 * `AdvancedListFilter` sibling, itself a separate root branch with no relationship to AttributeDiscount
 * except sharing the same `<parentStep>` — must ALSO survive. That sibling was pruned away as an "unrelated
 * root branch," leaving the ListGroup with AttributeDiscount as its ONLY (and therefore first) child —
 * exactly the malformed shape Salesforce rejected.
 *
 * Fixed by `markListGroupSiblingsRequired`: whenever a required step's `<parentStep>` resolves to a
 * ListGroup-typed container, every OTHER step declaring that same `<parentStep>` is marked required too —
 * treating a ListGroup's full child set as one atomic, never-split unit.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractStepGraph } from "./xmlBlocks";
import { computeRequiredOccurrenceIndexes, pruneXmlToRequiredOccurrences } from "./pricingCanvasPruning";

function step(opts: { name: string; actionType?: string; stepType?: string; parentStep?: string; seq: number }): string {
  return [
    "<steps>",
    opts.actionType ? `<actionType>${opts.actionType}</actionType>` : "",
    `<name>${opts.name}</name>`,
    opts.parentStep ? `<parentStep>${opts.parentStep}</parentStep>` : "",
    `<sequenceNumber>${opts.seq}</sequenceNumber>`,
    opts.stepType ? `<stepType>${opts.stepType}</stepType>` : "",
    "</steps>",
  ].join("");
}

/** Mirrors the real donor's exact shape: two ListGroups (the true/false AttributeDiscount branches), each
 * with an AdvancedListFilter (seq 1) + AttributeDiscount (seq 2) child, plus PricingSettings/ListPrice roots
 * and one genuinely unrelated branch (a BundleDiscount ListGroup) that must NOT be pulled in. */
function buildDonorXml(): string {
  return [
    step({ name: "PS1", actionType: "PricingSettings", seq: 0 }),
    step({ name: "LP60", actionType: "ListPrice", seq: 1 }),
    step({ name: "ListContainer24", stepType: "ListGroup", seq: 11 }),
    step({ name: "ListOperation25", stepType: "AdvancedListFilter", parentStep: "ListContainer24", seq: 1 }),
    step({ name: "AD13", actionType: "AttributeDiscount", stepType: "BusinessKnowledgeModel", parentStep: "ListContainer24", seq: 2 }),
    step({ name: "ListContainer27", stepType: "ListGroup", seq: 12 }),
    step({ name: "ListOperation28", stepType: "AdvancedListFilter", parentStep: "ListContainer27", seq: 1 }),
    step({ name: "AD14", actionType: "AttributeDiscount", stepType: "BusinessKnowledgeModel", parentStep: "ListContainer27", seq: 2 }),
    step({ name: "ListContainer30", stepType: "ListGroup", seq: 13 }),
    step({ name: "ListOperation31", stepType: "AdvancedListFilter", parentStep: "ListContainer30", seq: 1 }),
    step({ name: "BD15", actionType: "BundleDiscount", stepType: "BusinessKnowledgeModel", parentStep: "ListContainer30", seq: 2 }),
  ].join("");
}

test("TEST 1/2/3 — the true-branch (AD13) ListGroup's AdvancedListFilter sibling (ListOperation25) is now marked required alongside AD13 and its container", () => {
  const xml = buildDonorXml();
  const graph = extractStepGraph(xml);
  const target = graph.find(n => n.name === "AD13")!;
  const computation = computeRequiredOccurrenceIndexes(graph, target.occurrenceIndex)!;
  const requiredNames = [...computation.required].map(i => graph.find(n => n.occurrenceIndex === i)?.name);
  assert.ok(requiredNames.includes("ListOperation25"), `expected the AdvancedListFilter sibling to be required; got: ${JSON.stringify(requiredNames)}`);
  assert.ok(requiredNames.includes("ListContainer24"), "the ListGroup container itself must still be required (already worked before this fix)");
  assert.ok(requiredNames.includes("AD13"), "the target itself must be required");
});

test("TEST 6 — the false-branch (AD14) ListGroup's AdvancedListFilter sibling (ListOperation28) is ALSO marked required — both AttributeDiscount branches behave identically", () => {
  const xml = buildDonorXml();
  const graph = extractStepGraph(xml);
  const target = graph.find(n => n.name === "AD14")!;
  const computation = computeRequiredOccurrenceIndexes(graph, target.occurrenceIndex)!;
  const requiredNames = [...computation.required].map(i => graph.find(n => n.occurrenceIndex === i)?.name);
  assert.ok(requiredNames.includes("ListOperation28"), `expected the AdvancedListFilter sibling to be required; got: ${JSON.stringify(requiredNames)}`);
  assert.ok(requiredNames.includes("ListContainer27"));
  assert.ok(requiredNames.includes("AD14"));
});

test("TEST 5 — the genuinely unrelated ListGroup (BundleDiscount's ListContainer30/ListOperation31) is NOT pulled in — only the required branch's OWN ListGroup is completed, never every ListGroup in the donor", () => {
  const xml = buildDonorXml();
  const graph = extractStepGraph(xml);
  const target = graph.find(n => n.name === "AD14")!;
  const computation = computeRequiredOccurrenceIndexes(graph, target.occurrenceIndex)!;
  const requiredNames = [...computation.required].map(i => graph.find(n => n.occurrenceIndex === i)?.name);
  assert.ok(!requiredNames.includes("ListContainer30"), "an unrelated ListGroup must remain prunable");
  assert.ok(!requiredNames.includes("ListOperation31"), "an unrelated ListGroup's filter must remain prunable");
  assert.ok(!requiredNames.includes("BD15"), "an unrelated ListGroup's pricing step must remain prunable");
  const removedNames = computation.removedRootBranches.map(r => r.name);
  assert.ok(removedNames.includes("ListContainer30"), "the unrelated ListGroup must actually be REMOVED (proving completeness didn't just skip pruning it accidentally)");
});

test("TEST 1 (pruned XML) — after physically pruning to the required set, the true branch's final graph has the AdvancedListFilter as sequenceNumber 1 and AttributeDiscount as sequenceNumber 2 under the SAME parentStep — the exact shape Salesforce requires, reproduced end to end", () => {
  const xml = buildDonorXml();
  const graph = extractStepGraph(xml);
  const target = graph.find(n => n.name === "AD13")!;
  const computation = computeRequiredOccurrenceIndexes(graph, target.occurrenceIndex)!;
  const prunedXml = pruneXmlToRequiredOccurrences(xml, computation.removedRootBranches, graph);
  const prunedGraph = extractStepGraph(prunedXml);

  const listGroupChildren = prunedGraph.filter(n => n.parentStep === "ListContainer24").sort((a, b) => Number(a.sequenceNumber) - Number(b.sequenceNumber));
  assert.equal(listGroupChildren.length, 2, `expected exactly 2 children under the ListGroup; got: ${JSON.stringify(listGroupChildren.map(n => n.name))}`);
  assert.equal(listGroupChildren[0].name, "ListOperation25");
  assert.equal(listGroupChildren[0].sequenceNumber, "1");
  assert.equal(listGroupChildren[1].name, "AD13");
  assert.equal(listGroupChildren[1].sequenceNumber, "2");
});

test("TEST — no dangling <parentStep> references remain after pruning (the AdvancedListFilter's own parentStep still resolves, and the ListGroup container itself has no parentStep to dangle)", () => {
  const xml = buildDonorXml();
  const graph = extractStepGraph(xml);
  const target = graph.find(n => n.name === "AD14")!;
  const computation = computeRequiredOccurrenceIndexes(graph, target.occurrenceIndex)!;
  const prunedXml = pruneXmlToRequiredOccurrences(xml, computation.removedRootBranches, graph);
  const prunedGraph = extractStepGraph(prunedXml);
  const names = new Set(prunedGraph.map(n => n.name));
  for (const n of prunedGraph) {
    if (n.parentStep) assert.ok(names.has(n.parentStep), `dangling parentStep "${n.parentStep}" on step "${n.name}"`);
  }
});

test("TEST — a required step whose parentStep resolves to a NON-ListGroup container (e.g. a plain container with no stepType) does not trigger sibling completion — the fix is scoped specifically to stepType=ListGroup, matching the real evidence, never generalized to every container", () => {
  const xml = [
    step({ name: "PlainContainer", seq: 5 }), // no stepType at all
    step({ name: "Sibling1", parentStep: "PlainContainer", seq: 1 }),
    step({ name: "Target", actionType: "AttributeDiscount", parentStep: "PlainContainer", seq: 2 }),
  ].join("");
  const graph = extractStepGraph(xml);
  const target = graph.find(n => n.name === "Target")!;
  const computation = computeRequiredOccurrenceIndexes(graph, target.occurrenceIndex)!;
  const requiredNames = [...computation.required].map(i => graph.find(n => n.occurrenceIndex === i)?.name);
  assert.ok(!requiredNames.includes("Sibling1"), "sibling completion must only fire for a genuine stepType=ListGroup parent, not any container");
});
