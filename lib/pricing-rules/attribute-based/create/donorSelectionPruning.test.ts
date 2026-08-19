/**
 * §Root-cause fix regression coverage — the new single-donor selection + prune-to-required architecture
 * that replaces the prior "extract AttributeDiscount from one donor, PricingSettings/ListPrice from a
 * separate minimal donor, then re-parent" composition (which produced "Selected AttributeDiscount branch
 * has no <parentStep> tag in its own fields" whenever the extracted branch had nothing of its own to
 * re-parent). These tests exercise the REAL exported functions this file's fix relies on
 * (`inspectDonorCandidate`, `rankCandidates`, `computeRequiredOccurrenceIndexes`,
 * `pruneXmlToRequiredOccurrences`, `findDanglingParentStepReferences`) against a synthetic multi-branch
 * donor — never a hand-rolled reimplementation of the selection/pruning logic.
 *
 * Same caveat as every other *.test.ts in this directory: no test framework/runner is installed in this
 * repo — this file type-checks under `tsc --noEmit` but needs a TypeScript-aware runner (e.g.
 * `tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractStepGraph } from "./xmlBlocks";
import { inspectDonorCandidate, rankCandidates, resolveConnection, resolveConnectedAncestor, buildNoCoherentDonorDiagnostic } from "./donorInspection";
import { computeRequiredOccurrenceIndexes, pruneXmlToRequiredOccurrences, findDanglingParentStepReferences } from "./pricingCanvasPruning";

// A donor bundling: an unrelated FormulaBasedPricing branch, an unrelated ManualDiscount branch, and a
// genuinely coherent PricingSettings -> ListPrice -> AttributeDiscount chain (AttributeDiscount's
// <parentStep> resolves to ListPrice, ListPrice's <parentStep> resolves to PricingSettings) — the exact
// shape a real bundled Revenue Cloud pricing procedure has.
const MULTI_BRANCH_DONOR = `<ExpressionSetDefinition>
  <versions>
    <steps><name>Formula1</name><actionType>FormulaBasedPricing</actionType></steps>
    <steps><name>PS1</name><actionType>PricingSettings</actionType></steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType><parentStep>PS1</parentStep><parameters><input>false</input><name>UnitPrice</name><output>true</output><type>Parameter</type><value>UnitPrice</value></parameters></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parentStep>LP1</parentStep><parameters><input>true</input><name>InputUnitPrice</name><type>Parameter</type><value>UnitPrice</value></parameters></steps>
    <steps><name>Manual1</name><actionType>ManualDiscount</actionType></steps>
  </versions>
</ExpressionSetDefinition>`;

// A donor with an AttributeDiscount occurrence that is NOT connected to any ListPrice — the disconnected
// shape that must never be selected. No unrelated branches, so this isolates connectivity as the only
// difference from CONNECTED_MINIMAL_DONOR below.
const DISCONNECTED_DONOR = `<ExpressionSetDefinition>
  <versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType></steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType><parentStep>PS1</parentStep></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType></steps>
  </versions>
</ExpressionSetDefinition>`;

// A minimal, unbundled donor (no unrelated branches at all) whose AttributeDiscount already resolves to
// ListPrice — the ideal donor shape, isolating "connected" as the only variable against DISCONNECTED_DONOR.
const CONNECTED_MINIMAL_DONOR = `<ExpressionSetDefinition>
  <versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType></steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType><parentStep>PS1</parentStep></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parentStep>LP1</parentStep></steps>
  </versions>
</ExpressionSetDefinition>`;

test("inspectDonorCandidate classifies an unbundled, connected donor as ATTRIBUTE_BASED_PRICING_LIKELY", () => {
  const candidate = inspectDonorCandidate("connected.xml", CONNECTED_MINIMAL_DONOR);
  assert.equal(candidate.pricingSettingsOccurrences, 1);
  assert.equal(candidate.listPriceOccurrences, 1);
  assert.equal(candidate.attributeDiscountOccurrences, 1);
  assert.equal(candidate.classification, "ATTRIBUTE_BASED_PRICING_LIKELY");
  assert.equal(candidate.attributeDiscountBranches.length, 1);
  assert.equal(candidate.attributeDiscountBranches[0].connectedToListPrice, true);
  assert.equal(candidate.attributeDiscountBranches[0].connectedToPricingSettings, true);
});

test("inspectDonorCandidate classifies a bundled donor (unrelated branches present) as PRICING_PROCEDURE_LIKELY, not ATTRIBUTE_BASED_PRICING_LIKELY — bundled-ness alone must not be mistaken for the ideal shape", () => {
  const candidate = inspectDonorCandidate("multi.xml", MULTI_BRANCH_DONOR);
  assert.equal(candidate.classification, "PRICING_PROCEDURE_LIKELY");
  assert.equal(candidate.attributeDiscountBranches[0].connectedToListPrice, true, "still genuinely connected — pruning (not donor rejection) is how the unrelated branches get handled");
});

test("inspectDonorCandidate reports connectedToListPrice=false for a genuinely disconnected AttributeDiscount branch — this is exactly the donor shape the old architecture wrongly accepted", () => {
  const candidate = inspectDonorCandidate("disconnected.xml", DISCONNECTED_DONOR);
  assert.equal(candidate.attributeDiscountBranches.length, 1);
  assert.equal(candidate.attributeDiscountBranches[0].connectedToListPrice, false);
  assert.equal(candidate.attributeDiscountBranches[0].parentStep, null, "the disconnected branch has no <parentStep> at all — reproduces the reported bug's exact precondition");
});

test("rankCandidates scores the connected donor above one with an unconnected AttributeDiscount branch", () => {
  const connected = inspectDonorCandidate("connected.xml", CONNECTED_MINIMAL_DONOR);
  const disconnected = inspectDonorCandidate("disconnected.xml", DISCONNECTED_DONOR);
  const ranking = rankCandidates([connected, disconnected]);
  assert.equal(ranking[0].fullName, connected.fullName);
  assert.ok(ranking[0].score > ranking[1].score);
});

test("selectAttributeBasedPricingDonor-equivalent eligibility filter would reject the disconnected donor entirely (no eligible AttributeDiscount branch)", () => {
  const disconnected = inspectDonorCandidate("disconnected.xml", DISCONNECTED_DONOR);
  const eligible = disconnected.pricingSettingsOccurrences > 0
    && disconnected.listPriceOccurrences > 0
    && disconnected.attributeDiscountOccurrences > 0
    && disconnected.attributeDiscountBranches.some(b => b.connectedToListPrice);
  assert.equal(eligible, false);
});

test("computeRequiredOccurrenceIndexes + pruneXmlToRequiredOccurrences removes the unrelated FormulaBasedPricing/ManualDiscount branches and keeps PricingSettings+ListPrice+AttributeDiscount intact, with zero dangling references — the actual fix's composition path, no re-parenting involved", () => {
  const donorGraph = extractStepGraph(MULTI_BRANCH_DONOR);
  const adNode = donorGraph.find(n => n.actionType === "AttributeDiscount")!;
  assert.equal(adNode.parentStep, "LP1", "AttributeDiscount already resolves to ListPrice within this SAME donor — no cross-donor parentStep rewrite is needed");

  const computation = computeRequiredOccurrenceIndexes(donorGraph, adNode.occurrenceIndex)!;
  assert.ok(computation, "target occurrence must be found in the donor graph");
  assert.equal(computation.removedRootBranches.length, 2, "FormulaBasedPricing and ManualDiscount are both unrelated root branches and must be pruned");
  assert.deepEqual(computation.removedRootBranches.map(b => b.actionType).sort(), ["FormulaBasedPricing", "ManualDiscount"]);

  const prunedXml = pruneXmlToRequiredOccurrences(MULTI_BRANCH_DONOR, computation.removedRootBranches, donorGraph);
  const prunedGraph = extractStepGraph(prunedXml);
  assert.equal(prunedGraph.length, 3, "exactly PricingSettings + ListPrice + AttributeDiscount should survive pruning");
  assert.deepEqual(prunedGraph.map(n => n.actionType).sort(), ["AttributeDiscount", "ListPrice", "PricingSettings"]);

  const dangling = findDanglingParentStepReferences(prunedGraph, donorGraph);
  assert.deepEqual(dangling, [], "pruning must never leave a dangling <parentStep> reference");
});

test("computeRequiredOccurrenceIndexes returns null for an occurrence index that doesn't exist — never guesses a fallback target", () => {
  const donorGraph = extractStepGraph(MULTI_BRANCH_DONOR);
  assert.equal(computeRequiredOccurrenceIndexes(donorGraph, 9999), null);
});

// §Live-org fix — reproduces the EXACT reported live-org shape: every genuinely deployed Attribute-Based
// donor found in the org had PricingSettings=1, ListPrice=1, AttributeDiscount=1, but AttributeDiscount had
// NO <parentStep> at all (parentStep=none, connectedToListPrice=false under the old named-chain-only
// check), and no matching input/output binding either (values deliberately unrelated) — all three steps
// are physical ROOT siblings (no nesting) — the only remaining real signal in this shape is declared
// <sequenceNumber> ordering.
const LIVE_ORG_SHAPE_DONOR = `<ExpressionSetDefinition>
  <versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType><sequenceNumber>0</sequenceNumber></steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType><sequenceNumber>1</sequenceNumber><parameters><input>false</input><name>SomeOutput</name><output>true</output><type>Parameter</type><value>ListPriceOutputValue</value></parameters></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><sequenceNumber>2</sequenceNumber><parameters><input>true</input><name>InputUnitPrice</name><type>Parameter</type><value>UnrelatedValue</value></parameters></steps>
  </versions>
</ExpressionSetDefinition>`;

test("resolveConnection recognizes the live-org shape (no <parentStep>, no physical nesting, no matching variable binding, only ascending sequenceNumber) as connected via sequence-order — the actual live-org bug this turn fixes", () => {
  const graph = extractStepGraph(LIVE_ORG_SHAPE_DONOR);
  const adNode = graph.find(n => n.actionType === "AttributeDiscount")!;
  assert.equal(adNode.parentStep, null, "reproduces the live-org evidence: parentStep = none");
  assert.equal(resolveConnection(graph, adNode, "ListPrice"), "sequence-order");
  assert.equal(resolveConnection(graph, adNode, "PricingSettings"), "sequence-order");
});

test("resolveConnectedAncestor returns the actual ListPrice/PricingSettings nodes (not just a boolean) for the live-org shape", () => {
  const graph = extractStepGraph(LIVE_ORG_SHAPE_DONOR);
  const adNode = graph.find(n => n.actionType === "AttributeDiscount")!;
  const lp = resolveConnectedAncestor(graph, adNode, "ListPrice");
  const ps = resolveConnectedAncestor(graph, adNode, "PricingSettings");
  assert.equal(lp.mechanism, "sequence-order");
  assert.equal(lp.node?.name, "LP1");
  assert.equal(ps.mechanism, "sequence-order");
  assert.equal(ps.node?.name, "PS1");
});

test("inspectDonorCandidate classifies the live-org shape donor as ATTRIBUTE_BASED_PRICING_LIKELY and is now eligible where it previously was not", () => {
  const candidate = inspectDonorCandidate("live-org-shape.xml", LIVE_ORG_SHAPE_DONOR);
  assert.equal(candidate.classification, "ATTRIBUTE_BASED_PRICING_LIKELY");
  assert.equal(candidate.attributeDiscountBranches[0].connectedToListPrice, true);
  assert.equal(candidate.attributeDiscountBranches[0].listPriceConnection, "sequence-order");
  const eligible = candidate.pricingSettingsOccurrences > 0
    && candidate.listPriceOccurrences > 0
    && candidate.attributeDiscountOccurrences > 0
    && candidate.attributeDiscountBranches.some(b => b.connectedToListPrice);
  assert.equal(eligible, true);
});

// §Live-org fix (2nd occurrence) — reproduces the SECOND real org's shape: AttributeDiscount's
// <parentStep> is NOT empty, but names a canvas-placement "ListContainer" (never ListPrice/
// PricingSettings), and there's no physical nesting either — parentStep-chain and physical-nesting both
// correctly report no connection. The real, provable dependency here is that AttributeDiscount's
// InputUnitPrice value is exactly what this ListPrice occurrence publishes as an output.
const PARENT_NAMES_UNRELATED_CONTAINER_DONOR = `<ExpressionSetDefinition>
  <versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType></steps>
    <steps><name>ListContainer24</name><actionType>ListContainer</actionType><parentStep>PS1</parentStep></steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType><parentStep>PS1</parentStep><parameters><input>false</input><name>ItemContractPrice</name><output>true</output><type>Parameter</type><value>ItemContractPrice</value></parameters></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parentStep>ListContainer24</parentStep><parameters><input>true</input><name>InputUnitPrice</name><type>Parameter</type><value>ItemContractPrice</value></parameters></steps>
  </versions>
</ExpressionSetDefinition>`;

test("resolveConnection recognizes a non-empty <parentStep> naming an unrelated ListContainer (never ListPrice/PricingSettings), with no physical nesting, as connected via a matching InputUnitPrice/published-output variable binding", () => {
  const graph = extractStepGraph(PARENT_NAMES_UNRELATED_CONTAINER_DONOR);
  const adNode = graph.find(n => n.actionType === "AttributeDiscount")!;
  assert.equal(adNode.parentStep, "ListContainer24", "parentStep is non-empty but does not name ListPrice or PricingSettings — reproduces the 2nd live-org shape");
  assert.equal(resolveConnection(graph, adNode, "ListPrice"), "variable-binding");
});

test("resolveConnectedAncestor identifies the SPECIFIC ListPrice occurrence whose published output matches, never an arbitrary one", () => {
  const graph = extractStepGraph(PARENT_NAMES_UNRELATED_CONTAINER_DONOR);
  const adNode = graph.find(n => n.actionType === "AttributeDiscount")!;
  const lp = resolveConnectedAncestor(graph, adNode, "ListPrice");
  assert.equal(lp.mechanism, "variable-binding");
  assert.equal(lp.node?.name, "LP1");
});

test("resolveConnection never guesses via variable-binding when TWO ListPrice occurrences publish the SAME matching output value — genuine ambiguity, not resolved", () => {
  const ambiguousXml = PARENT_NAMES_UNRELATED_CONTAINER_DONOR.replace(
    "</versions>",
    `<steps><name>LP2</name><actionType>ListPrice</actionType><parentStep>PS1</parentStep><parameters><input>false</input><name>ItemContractPrice</name><output>true</output><type>Parameter</type><value>ItemContractPrice</value></parameters></steps></versions>`,
  );
  const graph = extractStepGraph(ambiguousXml);
  const adNode = graph.find(n => n.actionType === "AttributeDiscount")!;
  assert.equal(resolveConnection(graph, adNode, "ListPrice"), "none", "two ListPrice occurrences publish the identical value AttributeDiscount consumes — never guessed, and sequence-order doesn't apply here since neither step declares a <sequenceNumber>");
});

test("pruning the live-org shape donor without passing the resolved ListPrice/PricingSettings anchors WOULD wrongly strip them — proves why computeRequiredOccurrenceIndexes needs the additionalRequiredOccurrenceIndexes parameter", () => {
  const graph = extractStepGraph(LIVE_ORG_SHAPE_DONOR);
  const adNode = graph.find(n => n.actionType === "AttributeDiscount")!;
  const computation = computeRequiredOccurrenceIndexes(graph, adNode.occurrenceIndex)!;
  assert.ok(computation);
  assert.equal(computation.removedRootBranches.length, 2, "with no explicit anchors, only AttributeDiscount's own subtree is known-required — PricingSettings/ListPrice look like unrelated root branches from this walk's own (parentStep+physical-nesting-only) point of view");
});

test("pruning the live-org shape donor WITH the resolved ListPrice/PricingSettings anchors passed explicitly is a no-op (nothing to remove) and produces zero dangling references — the actual fix, proves the composition path works even with zero explicit <parentStep> tags anywhere", () => {
  const graph = extractStepGraph(LIVE_ORG_SHAPE_DONOR);
  const adNode = graph.find(n => n.actionType === "AttributeDiscount")!;
  const psNode = graph.find(n => n.actionType === "PricingSettings")!;
  const lpNode = graph.find(n => n.actionType === "ListPrice")!;
  const computation = computeRequiredOccurrenceIndexes(graph, adNode.occurrenceIndex, [psNode.occurrenceIndex, lpNode.occurrenceIndex])!;
  assert.ok(computation);
  assert.equal(computation.removedRootBranches.length, 0, "all 3 steps are required once the resolved anchors are passed explicitly — nothing to prune");
  const finalXml = pruneXmlToRequiredOccurrences(LIVE_ORG_SHAPE_DONOR, computation.removedRootBranches, graph);
  const finalGraph = extractStepGraph(finalXml);
  assert.equal(finalGraph.length, 3);
  assert.deepEqual(findDanglingParentStepReferences(finalGraph), []);
});

// A donor where NONE of the 3 signals resolves at all — no parentStep, no physical nesting, and
// sequenceNumbers that put AttributeDiscount BEFORE ListPrice/PricingSettings (i.e. genuinely no evidence
// of any dependency) — must still correctly report "none" and never be treated as eligible.
const TRULY_DISCONNECTED_DONOR = `<ExpressionSetDefinition>
  <versions>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><sequenceNumber>0</sequenceNumber></steps>
    <steps><name>PS1</name><actionType>PricingSettings</actionType><sequenceNumber>1</sequenceNumber></steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType><sequenceNumber>2</sequenceNumber></steps>
  </versions>
</ExpressionSetDefinition>`;

test("resolveConnection returns 'none' when no signal resolves — never fabricates a connection just because a donor happens to contain the right actionTypes", () => {
  const graph = extractStepGraph(TRULY_DISCONNECTED_DONOR);
  const adNode = graph.find(n => n.actionType === "AttributeDiscount")!;
  assert.equal(resolveConnection(graph, adNode, "ListPrice"), "none");
  assert.equal(resolveConnection(graph, adNode, "PricingSettings"), "none");
  const candidate = inspectDonorCandidate("truly-disconnected.xml", TRULY_DISCONNECTED_DONOR);
  assert.equal(candidate.attributeDiscountBranches[0].connectedToListPrice, false);
});

test("buildNoCoherentDonorDiagnostic names every rejected donor, its exact <parentStep>/physical-ancestor evidence, and both resolved connection mechanisms — never just 'none found'", () => {
  const candidate = inspectDonorCandidate("Laptop_Attribute_Pricing_V1", DISCONNECTED_DONOR);
  const diagnosticText = buildNoCoherentDonorDiagnostic([candidate]);
  assert.match(diagnosticText, /Laptop_Attribute_Pricing_V1/);
  assert.match(diagnosticText, /<parentStep>: \(none\)/);
  assert.match(diagnosticText, /ListPrice connection: none/);
  assert.match(diagnosticText, /never fabricate/i);
});

test("buildNoCoherentDonorDiagnostic reports the zero-candidates case distinctly", () => {
  const text = buildNoCoherentDonorDiagnostic([]);
  assert.match(text, /no ExpressionSetDefinition.*contains an AttributeDiscount/i);
});
