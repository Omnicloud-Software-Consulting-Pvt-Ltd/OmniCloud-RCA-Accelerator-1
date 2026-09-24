/**
 * §Live-org forensic diagnostics (Org B) — reproduces the EXACT reported live-org shape
 * (Rev_Mgmt_Default_Pricing_Procedure2_V1: 1 PricingSettings, 2 ListPrice, 2 AttributeDiscount; both
 * AttributeDiscount occurrences have InputUnitPrice=NetUnitPrice, parentStep names a "ListContainer" step,
 * "ListPrice connection: none", "PricingSettings connection: sequence-order") to prove the new forensic
 * diagnostics (raw XML, full unfiltered bindings, sequenceNumber presence/absence, the immediate
 * <parentStep> target's own actionType) actually surface the ground truth needed to identify the real
 * mechanism — WITHOUT changing any selection/scoring behavior. This file adds NO new connectivity
 * mechanism and asserts NO change to `connectedToListPrice`/`connectedToPricingSettings` — only that the
 * new diagnostic fields correctly explain WHY.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectDonorCandidate, buildNoCoherentDonorDiagnostic } from "./donorInspection";

// Reproduces the reported live-org shape: ListPrice publishes an output literally named/valued
// "UnitPrice" (never "NetUnitPrice") and has NO <sequenceNumber> at all; AttributeDiscount's InputUnitPrice
// is "NetUnitPrice" (a genuinely different string — the variable-binding mechanism correctly finds zero
// matches) and its <parentStep> names a plain "ListContainer" step (no actionType relationship to pricing
// at all, and no further parentStep of its own to continue the chain) with its own <sequenceNumber> set
// higher than PricingSettings's — hence PricingSettings resolves via the weak sequence-order signal while
// ListPrice resolves via NOTHING (no chain, no nesting, no matching binding, and no ListPrice occurrence
// has any <sequenceNumber> to be found via sequence-order either).
const ORG_B_SHAPED_DONOR = `<ExpressionSetDefinition>
  <fullName>Rev_Mgmt_Default_Pricing_Procedure2_V1</fullName>
  <versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType><sequenceNumber>1</sequenceNumber></steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType><parameters><input>false</input><name>UnitPrice</name><output>true</output><type>Parameter</type><value>UnitPrice</value></parameters></steps>
    <steps><name>LP2</name><actionType>ListPrice</actionType><parameters><input>false</input><name>UnitPrice</name><output>true</output><type>Parameter</type><value>UnitPrice</value></parameters></steps>
    <steps><name>ListContainer24</name><actionType>ListContainer</actionType></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parentStep>ListContainer24</parentStep><sequenceNumber>5</sequenceNumber><parameters><input>true</input><name>InputUnitPrice</name><type>Parameter</type><value>NetUnitPrice</value></parameters></steps>
    <steps><name>ListContainer27</name><actionType>ListContainer</actionType></steps>
    <steps><name>AD2</name><actionType>AttributeDiscount</actionType><parentStep>ListContainer27</parentStep><sequenceNumber>6</sequenceNumber><parameters><input>true</input><name>InputUnitPrice</name><type>Parameter</type><value>NetUnitPrice</value></parameters></steps>
  </versions>
</ExpressionSetDefinition>`;

test("Org B live-org shape: reproduces 'ListPrice connection: none' / 'PricingSettings connection: sequence-order' exactly as reported, without any behavior change", () => {
  const candidate = inspectDonorCandidate("Rev_Mgmt_Default_Pricing_Procedure2_V1.xml", ORG_B_SHAPED_DONOR);
  assert.equal(candidate.pricingSettingsOccurrences, 1);
  assert.equal(candidate.listPriceOccurrences, 2);
  assert.equal(candidate.attributeDiscountOccurrences, 2);

  for (const b of candidate.attributeDiscountBranches) {
    assert.equal(b.listPriceConnection, "none", "reproduces the exact reported gap — no mechanism currently resolves this");
    assert.equal(b.pricingSettingsConnection, "sequence-order");
    assert.equal(b.bindings.inputUnitPrice, "NetUnitPrice");
    assert.equal(b.connectedToListPrice, false);
  }
});

test("forensic diagnostics: sequenceNumber PRESENCE is distinguished from its VALUE — both ListPrice occurrences report 'NOT SET', explaining why sequence-order can never resolve them regardless of AttributeDiscount's own sequenceNumber", () => {
  const candidate = inspectDonorCandidate("donor.xml", ORG_B_SHAPED_DONOR);
  assert.equal(candidate.listPriceOccurrenceDetails.length, 2);
  for (const lp of candidate.listPriceOccurrenceDetails) {
    assert.equal(lp.sequenceNumber, null, "this org's ListPrice occurrences genuinely have no <sequenceNumber> tag — this is why sequence-order silently excludes them");
  }
  assert.equal(candidate.attributeDiscountBranches[0].sequenceNumber, "5");
});

test("forensic diagnostics: the immediate <parentStep> target is resolved and explicitly classified as a non-pricing element (actionType=ListContainer), never assumed to be a data-flow parent merely because it resolves", () => {
  const candidate = inspectDonorCandidate("donor.xml", ORG_B_SHAPED_DONOR);
  const branch1 = candidate.attributeDiscountBranches.find(b => b.parentStep === "ListContainer24")!;
  assert.ok(branch1.parentStepTarget);
  assert.equal(branch1.parentStepTarget!.found, true);
  assert.equal(branch1.parentStepTarget!.actionType, "ListContainer");
  assert.equal(branch1.parentStepTarget!.parentStep, null, "ListContainer24 itself has no further <parentStep> — the chain genuinely dead-ends here, not a resolver bug");

  const branch2 = candidate.attributeDiscountBranches.find(b => b.parentStep === "ListContainer27")!;
  assert.equal(branch2.parentStepTarget!.actionType, "ListContainer");
});

test("forensic diagnostics: every raw <parameters> binding is captured unfiltered — proves ListPrice publishes 'UnitPrice' (never 'NetUnitPrice'), so the variable-binding mechanism's 'no match' is a genuine fact about this org's data, not a resolver gap", () => {
  const candidate = inspectDonorCandidate("donor.xml", ORG_B_SHAPED_DONOR);
  for (const lp of candidate.listPriceOccurrenceDetails) {
    assert.equal(lp.allBindings.length, 1);
    assert.equal(lp.allBindings[0].value, "UnitPrice");
    assert.equal(lp.allBindings[0].output, true);
  }
  const ad1 = candidate.attributeDiscountBranches[0];
  assert.equal(ad1.allBindings.length, 1);
  assert.equal(ad1.allBindings[0].name, "InputUnitPrice");
  assert.equal(ad1.allBindings[0].value, "NetUnitPrice");
  assert.equal(ad1.allBindings[0].input, true);
});

test("buildNoCoherentDonorDiagnostic prints the complete forensic trace: raw XML, full bindings, sequenceNumber presence, and the classified <parentStep> target — everything needed to identify a real mechanism without a live Salesforce session", () => {
  const candidate = inspectDonorCandidate("Rev_Mgmt_Default_Pricing_Procedure2_V1.xml", ORG_B_SHAPED_DONOR);
  const diagnostic = buildNoCoherentDonorDiagnostic([candidate]);

  assert.match(diagnostic, /ListContainer24/);
  assert.match(diagnostic, /NOT itself a pricing calculation step/);
  assert.match(diagnostic, /NOT SET/);
  assert.match(diagnostic, /name=InputUnitPrice \| value=NetUnitPrice \| input=true \| output=false/);
  assert.match(diagnostic, /name=UnitPrice \| value=UnitPrice \| input=false \| output=true/);
  assert.match(diagnostic, /Raw XML:/);
  assert.match(diagnostic, /<actionType>ListContainer<\/actionType>/);
});
