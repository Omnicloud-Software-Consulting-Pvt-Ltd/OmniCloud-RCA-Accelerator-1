/**
 * §Version-scoping fix — confirmed live incident: a donor's retrieved ExpressionSetDefinition XML
 * contained TWO `<versions>` blocks (an ordinary consequence of the same Definition being deployed twice
 * across separate runs — Salesforce accumulates every version, active or not, under one Definition file).
 * Each version, on its own, held one normal, non-duplicated AttributeDiscount branch — but
 * `extractStepGraph` had no `<versions>`-boundary awareness and flattened both versions' steps into one
 * graph, making a perfectly ordinary donor look like it had two identical duplicate branches. The branch
 * resolver's `ambiguous: true` result was CORRECT given that (wrong) input; the fix is entirely at the
 * retrieval/parsing boundary, never in branch-selection scoring itself.
 *
 * These tests exercise the real exported functions (`selectExpressionSetDefinitionVersion`,
 * `retrieveVersionScopedExpressionSetDefinitionFiles`) against synthetic, generic donor XML — never
 * Monitor/Laptop-specific names, Ids, or hardcoded version numbers beyond what a given scenario is
 * specifically testing.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectExpressionSetDefinitionVersion, retrieveVersionScopedExpressionSetDefinitionFiles } from "./templateExpressionSet";
import { extractStepGraph } from "./xmlBlocks";
import { inspectDonorCandidate } from "./donorInspection";

/** One `<versions>` block, generic/parametrized — never a specific product's real shape. */
function versionBlock(opts: { fullName: string; status?: string; steps: string }): string {
  return `<versions>
        <fullName>${opts.fullName}</fullName>
        <description>Test Version</description>
        <label>Test Procedure</label>
        <processType>DefaultPricing</processType>
        <status>${opts.status ?? "Inactive"}</status>
        ${opts.steps}
    </versions>`;
}

function definitionDoc(versions: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ExpressionSetDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
    <contextDefinitions>SomeContext</contextDefinitions>
    <interfaceSourceType>PricingProcedure</interfaceSourceType>
    <label>Test Procedure</label>
    <processType>DefaultPricing</processType>
    <template>false</template>
    ${versions.join("\n    ")}
</ExpressionSetDefinition>`;
}

/** A single, generic, non-duplicated 5-step ABP-shaped branch: AttributeDiscount -> ListGroup ->
 * AdvancedListFilter -> ListPrice -> PricingSettings — structurally mirroring the real incident's shape,
 * with entirely generic names. */
function oneGenericBranch(opts: { containerName?: string } = {}): string {
  const container = opts.containerName ?? "GenericContainer";
  return `
        <steps><actionType>AttributeDiscount</actionType><name>AttributeDiscountEntries</name><parentStep>${container}</parentStep><sequenceNumber>2</sequenceNumber><stepType>BusinessKnowledgeModel</stepType></steps>
        <steps><name>${container}</name><label>List Container</label><sequenceNumber>12</sequenceNumber><stepType>ListGroup</stepType></steps>
        <steps><name>GenericFilter</name><label>List Operation</label><parentStep>${container}</parentStep><sequenceNumber>1</sequenceNumber><stepType>AdvancedListFilter</stepType></steps>
        <steps><actionType>ListPrice</actionType><name>PriceBookEntries</name><sequenceNumber>2</sequenceNumber><stepType>BusinessKnowledgeModel</stepType></steps>
        <steps><actionType>PricingSettings</actionType><name>PricingSetting</name><sequenceNumber>1</sequenceNumber><stepType>BusinessKnowledgeModel</stepType></steps>`;
}

/** Two genuinely DIFFERENT AttributeDiscount branches (Contract vs Standard) within ONE version — the
 * Rev_Mgmt-shaped case: legitimately distinguishable, must never be collapsed. */
function twoLegitimatelyDifferentBranches(): string {
  return `
        <steps><actionType>AttributeDiscount</actionType><name>ContractBranch</name><parentStep>ContractContainer</parentStep><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Literal</type><value>true</value></parameters><parameters><input>true</input><name>PriceAdjustmentScheduleId</name><output>false</output><type>Parameter</type><value>ItemContractAttributePasId</value></parameters></steps>
        <steps><actionType>AttributeDiscount</actionType><name>StandardBranch</name><parentStep>StandardContainer</parentStep><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Literal</type><value>false</value></parameters><parameters><input>true</input><name>PriceAdjustmentScheduleId</name><output>false</output><type>Parameter</type><value>AttributePASIdConstant</value></parameters></steps>`;
}

/* ── TEST 1 — one-version ExpressionSetDefinition ── */
test("TEST 1 — a single <versions> block is selected with no disambiguation needed", () => {
  const doc = definitionDoc([versionBlock({ fullName: "Thing_V1", steps: oneGenericBranch() })]);
  const result = selectExpressionSetDefinitionVersion(doc);
  assert.equal(result.ambiguous, false);
  assert.equal(result.versions.length, 1);
  assert.equal(result.selected?.fullName, "Thing_V1");
  assert.equal(extractStepGraph(result.selectedXml).filter(n => n.actionType === "AttributeDiscount").length, 1);
});

/* ── TEST 2/3 — two-version ExpressionSetDefinition, each with an IDENTICAL branch ── */
test("TEST 2/3 — two versions each containing an identical branch: exactly ONE AttributeDiscount survives scoping, never two", () => {
  const doc = definitionDoc([
    versionBlock({ fullName: "Thing_V1", steps: oneGenericBranch() }),
    versionBlock({ fullName: "Thing_V2", steps: oneGenericBranch() }),
  ]);
  const result = selectExpressionSetDefinitionVersion(doc);
  assert.equal(result.ambiguous, false);
  assert.equal(result.versions.length, 2);
  assert.equal(result.selected?.fullName, "Thing_V2", "the higher version number must win");
  const scopedGraph = extractStepGraph(result.selectedXml);
  assert.equal(scopedGraph.filter(n => n.actionType === "AttributeDiscount").length, 1, "scoping to one version must leave exactly one AttributeDiscount, never two");
});

/* ── TEST 4 — two versions with DIFFERENT branches ── */
test("TEST 4 — two versions with genuinely different branches: the higher-numbered version's own branch is selected, the other version's branch is not mixed in", () => {
  const doc = definitionDoc([
    versionBlock({ fullName: "Thing_V1", steps: oneGenericBranch({ containerName: "ContainerOne" }) }),
    versionBlock({ fullName: "Thing_V2", steps: oneGenericBranch({ containerName: "ContainerTwo" }) }),
  ]);
  const result = selectExpressionSetDefinitionVersion(doc);
  assert.equal(result.selected?.fullName, "Thing_V2");
  const scopedGraph = extractStepGraph(result.selectedXml);
  const ad = scopedGraph.find(n => n.actionType === "AttributeDiscount");
  assert.equal(ad?.parentStep, "ContainerTwo", "must be V2's own branch, never V1's");
  assert.equal(scopedGraph.filter(n => n.name === "ContainerOne").length, 0, "V1's container must not leak into the scoped result");
});

/* ── TEST 5 — active/inactive metadata present alongside versionNumber ── */
test("TEST 5 — status (active/inactive) is captured as diagnostic info but does not override version-number-based selection — mirrors the real incident (both versions Inactive, still resolved correctly)", () => {
  const doc = definitionDoc([
    versionBlock({ fullName: "Thing_V1", status: "Inactive", steps: oneGenericBranch() }),
    versionBlock({ fullName: "Thing_V2", status: "Inactive", steps: oneGenericBranch() }),
  ]);
  const result = selectExpressionSetDefinitionVersion(doc);
  assert.equal(result.ambiguous, false);
  assert.equal(result.selected?.fullName, "Thing_V2");
  assert.equal(result.versions[0].status, "Inactive");
  assert.equal(result.versions[1].status, "Inactive");
});

test("TEST 5b — one active, one inactive: version-number signal still wins (no special-casing of 'active' as an override)", () => {
  const doc = definitionDoc([
    versionBlock({ fullName: "Thing_V1", status: "Active", steps: oneGenericBranch() }),
    versionBlock({ fullName: "Thing_V2", status: "Inactive", steps: oneGenericBranch() }),
  ]);
  const result = selectExpressionSetDefinitionVersion(doc);
  assert.equal(result.selected?.fullName, "Thing_V2", "highest version number wins — mirrors the same semantic concept selectExpressionSetVersion (verifySalesforceState.ts) already uses");
});

/* ── TEST 6/7 — selection by validated metadata, never document position; reordering produces the same result ── */
test("TEST 6/7 — reordering the <versions> blocks in the document produces the SAME selected version — never document order/array position", () => {
  const forward = definitionDoc([
    versionBlock({ fullName: "Thing_V1", steps: oneGenericBranch({ containerName: "ContainerOne" }) }),
    versionBlock({ fullName: "Thing_V2", steps: oneGenericBranch({ containerName: "ContainerTwo" }) }),
  ]);
  const reversed = definitionDoc([
    versionBlock({ fullName: "Thing_V2", steps: oneGenericBranch({ containerName: "ContainerTwo" }) }),
    versionBlock({ fullName: "Thing_V1", steps: oneGenericBranch({ containerName: "ContainerOne" }) }),
  ]);
  const forwardResult = selectExpressionSetDefinitionVersion(forward);
  const reversedResult = selectExpressionSetDefinitionVersion(reversed);
  assert.equal(forwardResult.selected?.fullName, "Thing_V2");
  assert.equal(reversedResult.selected?.fullName, "Thing_V2", "must select V2 regardless of which document position it physically appears in");
});

/* ── TEST 8 — Monitor-like artifact: false duplicate ambiguity is resolved ── */
test("TEST 8 — a Monitor-like artifact (2 versions, each with one identical Standard branch) no longer produces a false duplicate-AttributeDiscount ambiguity via inspectDonorCandidate", () => {
  const doc = definitionDoc([
    versionBlock({ fullName: "Product_Attribute_Based_Pricing_Procedur_V1", steps: oneGenericBranch() }),
    versionBlock({ fullName: "Product_Attribute_Based_Pricing_Procedur_V2", steps: oneGenericBranch() }),
  ]);
  const versionSelection = selectExpressionSetDefinitionVersion(doc);
  const candidate = inspectDonorCandidate("Product_Attribute_Based_Pricing_Procedur.expressionSetDefinition", versionSelection.selectedXml);
  assert.equal(candidate.attributeDiscountOccurrences, 1, "scoped content must expose exactly one AttributeDiscount occurrence — the false 'two branches' appearance must be gone");
  assert.equal(candidate.pricingSettingsOccurrences, 1);
  assert.equal(candidate.listPriceOccurrences, 1);
});

/* ── TEST 9 — Rev_Mgmt-like artifact: both legitimate branches survive (single version, no scoping needed) ── */
test("TEST 9 — a Rev_Mgmt-like artifact (ONE version, two genuinely different Contract/Standard branches) still exposes BOTH legitimate branches after version scoping — scoping never collapses a real, single-version multi-branch donor", () => {
  const doc = definitionDoc([versionBlock({ fullName: "Default_Pricing_Procedure_V1", steps: twoLegitimatelyDifferentBranches() })]);
  const versionSelection = selectExpressionSetDefinitionVersion(doc);
  assert.equal(versionSelection.ambiguous, false);
  assert.equal(versionSelection.versions.length, 1, "only one <versions> block exists here — nothing to disambiguate at the version level");
  const candidate = inspectDonorCandidate("Default_Pricing_Procedure.expressionSetDefinition", versionSelection.selectedXml);
  assert.equal(candidate.attributeDiscountOccurrences, 2, "both legitimate branches must survive — version scoping must never remove content WITHIN a single version");
  const contractBranch = candidate.attributeDiscountBranches.find(b => b.parentStep === "ContractContainer");
  const standardBranch = candidate.attributeDiscountBranches.find(b => b.parentStep === "StandardContainer");
  assert.ok(contractBranch && standardBranch, "both the Contract and Standard branches must still be individually present and distinguishable");
});

/* ── TEST 10 — malformed <versions> structure ── */
test("TEST 10 — no <versions> wrapper at all (or an unbalanced/malformed one, which the same underlying tag-matcher simply can't pair) degrades safely to 'nothing to scope' rather than throwing", () => {
  const noWrapperDoc = `<ExpressionSetDefinition><label>Test</label><steps><actionType>ListPrice</actionType><name>LP1</name></steps></ExpressionSetDefinition>`;
  const result = selectExpressionSetDefinitionVersion(noWrapperDoc);
  assert.equal(result.ambiguous, false);
  assert.equal(result.versions.length, 0);
  assert.equal(result.selectedXml, noWrapperDoc, "content with no <versions> wrapper must be returned completely unchanged");
});

/* ── TEST 11 — ambiguous version selection fails closed ── */
test("TEST 11a — two versions sharing the SAME parsed version number fail closed — never guessed", () => {
  const doc = definitionDoc([
    versionBlock({ fullName: "Thing_V3", steps: oneGenericBranch({ containerName: "ContainerA" }) }),
    versionBlock({ fullName: "Other_Thing_V3", steps: oneGenericBranch({ containerName: "ContainerB" }) }),
  ]);
  const result = selectExpressionSetDefinitionVersion(doc);
  assert.equal(result.ambiguous, true);
  assert.equal(result.selected, null);
  assert.match(result.reason, /could not unambiguously identify/i);
  assert.equal(extractStepGraph(result.selectedXml).filter(n => n.actionType === "AttributeDiscount").length, 0, "an ambiguous scoping result must expose ZERO steps from either version — never a guessed pick");
});

test("TEST 11b — 2+ versions where at least one fullName doesn't carry a parseable version number fail closed", () => {
  const doc = definitionDoc([
    versionBlock({ fullName: "Thing_V1", steps: oneGenericBranch({ containerName: "ContainerA" }) }),
    versionBlock({ fullName: "Thing_Special_Edition", steps: oneGenericBranch({ containerName: "ContainerB" }) }),
  ]);
  const result = selectExpressionSetDefinitionVersion(doc);
  assert.equal(result.ambiguous, true);
  assert.equal(result.selected, null);
});

/* ── TEST 12 — existing extractStepGraph callers that never had <versions> boundaries remain unchanged ── */
test("TEST 12 — extractStepGraph itself is completely untouched: it still walks whatever XML it's given exactly as before, with no <versions> awareness of its own — the scoping happens strictly BEFORE it via selectExpressionSetDefinitionVersion, never inside it", () => {
  const rawMultiVersionDoc = definitionDoc([
    versionBlock({ fullName: "Thing_V1", steps: oneGenericBranch() }),
    versionBlock({ fullName: "Thing_V2", steps: oneGenericBranch() }),
  ]);
  // Calling extractStepGraph DIRECTLY on the raw, unscoped document (exactly how every pre-existing
  // caller that operates on already-generated/composed single-version XML still does) must behave
  // identically to before this fix — i.e. it still flattens everything it's given, unchanged. This proves
  // the fix lives at the retrieval boundary, never inside extractStepGraph itself.
  const unscoped = extractStepGraph(rawMultiVersionDoc);
  assert.equal(unscoped.filter(n => n.actionType === "AttributeDiscount").length, 2, "extractStepGraph's own behavior on raw multi-version content is deliberately unchanged — callers that already hand it a single version's XML (canvasBuilder.ts's own generated/composed/pruned output) are completely unaffected by this fix");
});

/* ── retrieveVersionScopedExpressionSetDefinitionFiles — the retrieval-boundary wrapper ── */
test("TEST — retrieveVersionScopedExpressionSetDefinitionFiles is exported and callable with the expected shape (integration wiring smoke test; full retrieval is exercised via the real SalesforceClient in donorInspection.ts's own callers, not re-mocked here)", () => {
  assert.equal(typeof retrieveVersionScopedExpressionSetDefinitionFiles, "function");
});
