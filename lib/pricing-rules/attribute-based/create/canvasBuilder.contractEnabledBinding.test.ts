/**
 * §Live-org fix — real donor XML evidence, captured via the donor-xml-diagnostic tool from
 * `Rev_Mgmt_Default_Pricing_Procedure2_V1`, proved the donor explicitly declares `IsContractEnabled` as a
 * literal boolean parameter on BOTH AttributeDiscount branches AND both ListPrice occurrences:
 *
 *   AttributeDiscount [13]: IsContractEnabled=true  -> ListPrice [60]: IsContractEnabled=true
 *     (parentStep=ListContainer24 vs parentStep=ListContainer11 — DIFFERENT, proving parentStep is not
 *     required; LookUpApiName=Contract_Pricing_Entries_Decision_Table)
 *   AttributeDiscount [14]: IsContractEnabled=false -> ListPrice [63]: IsContractEnabled=false
 *     (parentStep=ListContainer27 vs parentStep=none — DIFFERENT, same point; LookUpApiName=
 *     Price_Book_Entry_Decision_Table_v2)
 *
 * This is a direct, literal parameter binding the donor itself declares — not a name/label/parentStep/
 * sequence/array-position signal. `resolveListPriceByContractEnabledBinding` is Priority 1 in
 * `resolvePricingFlowAncestors`, and a `conflict` outcome (ambiguous, zero-match, or missing/non-literal
 * IsContractEnabled on any ListPrice candidate) stops the whole resolution — it never falls through to a
 * weaker signal once real evidence problems are found.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractStepGraph } from "./xmlBlocks";
import { resolveListPriceByContractEnabledBinding, resolvePricingFlowAncestors } from "./canvasBuilder";

/** The REAL donor shape, reconstructed field-for-field from the captured XML evidence (occurrence indexes
 * renumbered by fixture construction — `extractStepGraph` assigns them fresh per document — but every
 * field value is exactly as reported: parentStep, IsContractEnabled, LookUp*, output names). */
const REAL_DONOR = `<ExpressionSetDefinition>
  <fullName>Rev_Mgmt_Default_Pricing_Procedure2_V1</fullName>
  <versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType>
      <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </steps>
    <steps><name>ListContainer24</name><actionType>ListGroup</actionType></steps>
    <steps><name>LP60</name><actionType>ListPrice</actionType><parentStep>ListContainer11</parentStep>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
      <parameters><input>false</input><name>ListPriceField</name><output>true</output><type>Parameter</type><value>ItemContractPrice</value></parameters>
      <parameters><input>false</input><name>DiscountType</name><output>true</output><type>Parameter</type><value>ItemContractDiscountType</value></parameters>
      <parameters><input>false</input><name>DiscountValue</name><output>true</output><type>Parameter</type><value>ItemContractDiscountValue</value></parameters>
      <parameters><input>false</input><name>IsContracted</name><output>true</output><type>Parameter</type><value>IsContracted</value></parameters>
      <parameters><input>true</input><name>ListPriceFieldConstant</name><output>false</output><type>Parameter</type><value>Constant_UnitPrice_Contract_Pricing_Entries_Decision_Table_LP</value></parameters>
      <parameters><input>true</input><name>LookUpName</name><output>false</output><type>Parameter</type><value>Contract Pricing Entries</value></parameters>
      <parameters><input>true</input><name>LookUpApiName</name><output>false</output><type>Parameter</type><value>Contract_Pricing_Entries_Decision_Table</value></parameters>
    </steps>
    <steps><name>AD13</name><actionType>AttributeDiscount</actionType><parentStep>ListContainer24</parentStep>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
      <parameters><input>true</input><name>PriceAdjustmentScheduleId</name><output>false</output><type>Parameter</type><value>ItemContractAttributePasId</value></parameters>
      <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>false</input><name>ItemNetTotalPrice</name><output>true</output><type>Parameter</type><value>ItemNetTotalPrice</value></parameters>
      <parameters><input>false</input><name>IsContracted</name><output>true</output><type>Parameter</type><value>IsContracted</value></parameters>
    </steps>
    <steps><name>LP63</name><actionType>ListPrice</actionType>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
      <parameters><input>false</input><name>ListPriceField</name><output>true</output><type>Parameter</type><value>ListPrice</value></parameters>
      <parameters><input>true</input><name>Product2Id</name><output>false</output><type>Parameter</type><value>Product</value></parameters>
      <parameters><input>true</input><name>Pricebook2Id</name><output>false</output><type>Parameter</type><value>PriceBooks</value></parameters>
      <parameters><input>true</input><name>ProductSellingModelId</name><output>false</output><type>Parameter</type><value>ProductSellingModel</value></parameters>
      <parameters><input>true</input><name>Quantity</name><output>false</output><type>Parameter</type><value>LineItemQuantity</value></parameters>
      <parameters><input>true</input><name>ListPriceFieldConstant</name><output>false</output><type>Parameter</type><value>Constant_UnitPrice_Price_Book_Entry_Decision_Table_v2_LP</value></parameters>
      <parameters><input>true</input><name>LookUpName</name><output>false</output><type>Parameter</type><value>Price Book Entries V2</value></parameters>
      <parameters><input>true</input><name>LookUpApiName</name><output>false</output><type>Parameter</type><value>Price_Book_Entry_Decision_Table_v2</value></parameters>
    </steps>
    <steps><name>ListContainer27</name><actionType>ListGroup</actionType></steps>
    <steps><name>AD14</name><actionType>AttributeDiscount</actionType><parentStep>ListContainer27</parentStep>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
      <parameters><input>true</input><name>PriceAdjustmentScheduleId</name><output>false</output><type>Parameter</type><value>AttributePASIdConstant</value></parameters>
      <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>false</input><name>ItemNetTotalPrice</name><output>true</output><type>Parameter</type><value>ItemNetTotalPrice</value></parameters>
    </steps>
    <variables><name>AttributePASIdConstant</name><type>Constant</type><value>84Xg7000000FQQPEA4</value></variables>
  </versions>
</ExpressionSetDefinition>`;

test("§FINAL CHECK — AD[13] (IsContractEnabled=true) resolves to LP60 (IsContractEnabled=true), proven from the real donor's own explicit binding, not parentStep/sequence/name", () => {
  const graph = extractStepGraph(REAL_DONOR);
  const ad13 = graph.find(n => n.name === "AD13")!;
  const lp60 = graph.find(n => n.name === "LP60")!;

  const outcome = resolveListPriceByContractEnabledBinding(graph, ad13);
  assert.equal(outcome.status, "resolved");
  assert.equal((outcome as { status: "resolved"; node: typeof lp60 }).node.occurrenceIndex, lp60.occurrenceIndex);
});

test("§FINAL CHECK — AD[14] (IsContractEnabled=false) resolves to LP63 (IsContractEnabled=false), proven from the real donor's own explicit binding, not parentStep/sequence/name", () => {
  const graph = extractStepGraph(REAL_DONOR);
  const ad14 = graph.find(n => n.name === "AD14")!;
  const lp63 = graph.find(n => n.name === "LP63")!;

  const outcome = resolveListPriceByContractEnabledBinding(graph, ad14);
  assert.equal(outcome.status, "resolved");
  assert.equal((outcome as { status: "resolved"; node: typeof lp63 }).node.occurrenceIndex, lp63.occurrenceIndex);
});

test("§Test 6 — parentStep equality is NOT required: AD14 (parentStep=ListContainer27) still resolves to LP63 (parentStep=none)", () => {
  const graph = extractStepGraph(REAL_DONOR);
  const ad14 = graph.find(n => n.name === "AD14")!;
  const lp63 = graph.find(n => n.name === "LP63")!;
  assert.notEqual(ad14.parentStep, lp63.parentStep, "sanity check on the fixture itself — they must genuinely differ");

  const outcome = resolveListPriceByContractEnabledBinding(graph, ad14);
  assert.equal(outcome.status, "resolved");
  assert.equal((outcome as { status: "resolved"; node: typeof lp63 }).node.occurrenceIndex, lp63.occurrenceIndex);
});

test("§Test 7 — sequence/array position is NOT used: even though document order interleaves the branches (LP60, AD13, LP63, AD14 — AD13 sits BETWEEN the two ListPrice occurrences), resolution follows IsContractEnabled exactly, never occurrence order", () => {
  const graph = extractStepGraph(REAL_DONOR);
  const lp60 = graph.find(n => n.name === "LP60")!;
  const lp63 = graph.find(n => n.name === "LP63")!;
  const ad13 = graph.find(n => n.name === "AD13")!;
  const ad14 = graph.find(n => n.name === "AD14")!;
  // Fixture sanity — confirms this genuinely isn't a "nearest preceding ListPrice" shape either: AD13
  // sits BETWEEN LP60 and LP63 in document order, so a positional/nearest-neighbor heuristic would have
  // no consistent rule to apply here beyond what IsContractEnabled itself already decides.
  assert.ok(lp60.occurrenceIndex < ad13.occurrenceIndex, "fixture sanity: LP60 precedes AD13");
  assert.ok(ad13.occurrenceIndex < lp63.occurrenceIndex, "fixture sanity: AD13 precedes LP63");
  assert.ok(lp63.occurrenceIndex < ad14.occurrenceIndex, "fixture sanity: LP63 precedes AD14");

  const outcome13 = resolveListPriceByContractEnabledBinding(graph, ad13);
  const outcome14 = resolveListPriceByContractEnabledBinding(graph, ad14);
  assert.equal(outcome13.status, "resolved");
  assert.equal((outcome13 as { status: "resolved"; node: typeof lp60 }).node.name, "LP60");
  assert.equal(outcome14.status, "resolved");
  assert.equal((outcome14 as { status: "resolved"; node: typeof lp63 }).node.name, "LP63");
});

test("§Test 1 — AD IsContractEnabled=true with LP candidates {true, false}: the true candidate is selected", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><name>LP_True</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters></steps>
    <steps><name>LP_False</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD1")!;
  const outcome = resolveListPriceByContractEnabledBinding(graph, ad);
  assert.equal(outcome.status, "resolved");
  assert.equal((outcome as { status: "resolved"; node: { name: string | null } }).node.name, "LP_True");
});

test("§Test 2 — AD IsContractEnabled=false with LP candidates {true, false}: the false candidate is selected", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><name>LP_True</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters></steps>
    <steps><name>LP_False</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD1")!;
  const outcome = resolveListPriceByContractEnabledBinding(graph, ad);
  assert.equal(outcome.status, "resolved");
  assert.equal((outcome as { status: "resolved"; node: { name: string | null } }).node.name, "LP_False");
});

test("§Test 3 — AD=true with LP candidates {true, true}: ambiguity failure, never guesses", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><name>LP_A</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters></steps>
    <steps><name>LP_B</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD1")!;
  const outcome = resolveListPriceByContractEnabledBinding(graph, ad);
  assert.equal(outcome.status, "conflict");
  assert.match(outcome.reason, /ambiguous: 2 ListPrice occurrences share IsContractEnabled=true/);
});

test("§Test 4 — AD=false with LP candidates {true, true}: zero-match failure, never guesses", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><name>LP_A</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters></steps>
    <steps><name>LP_B</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD1")!;
  const outcome = resolveListPriceByContractEnabledBinding(graph, ad);
  assert.equal(outcome.status, "conflict");
  assert.match(outcome.reason, /0 of 2 ListPrice occurrence\(s\) declare IsContractEnabled=false/);
});

test("§Test 5 — a ListPrice occurrence missing IsContractEnabled: insufficient-evidence failure for the WHOLE mechanism, never silently excluded and resolved from the remaining candidate", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><name>LP_Missing</name><actionType>ListPrice</actionType></steps>
    <steps><name>LP_False</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD1")!;
  const outcome = resolveListPriceByContractEnabledBinding(graph, ad);
  assert.equal(outcome.status, "conflict");
  assert.match(outcome.reason, /missing or non-literal IsContractEnabled/);
});

test("mechanism does not apply (falls through) when AttributeDiscount itself has no IsContractEnabled at all", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><name>LP_A</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD1")!;
  const outcome = resolveListPriceByContractEnabledBinding(graph, ad);
  assert.equal(outcome.status, "not-applicable");
});

test("resolvePricingFlowAncestors end to end — AD13 resolves to LP60 with mechanism label 'explicit-contract-enabled-binding', and PricingSettings resolves too", () => {
  const graph = extractStepGraph(REAL_DONOR);
  const ad13 = graph.find(n => n.name === "AD13")!;
  const result = resolvePricingFlowAncestors(graph, ad13, "Rev_Mgmt_Default_Pricing_Procedure2_V1");
  assert.equal(result.success, true, `expected success; got: ${JSON.stringify(result.fatalErrors)}`);
  assert.equal(result.lpMatch?.name, "LP60");
  assert.equal(result.lpMechanism, "explicit-contract-enabled-binding");
  assert.equal(result.psMatch?.name, "PS1");
});

test("resolvePricingFlowAncestors end to end — AD14 resolves to LP63 with mechanism label 'explicit-contract-enabled-binding'", () => {
  const graph = extractStepGraph(REAL_DONOR);
  const ad14 = graph.find(n => n.name === "AD14")!;
  const result = resolvePricingFlowAncestors(graph, ad14, "Rev_Mgmt_Default_Pricing_Procedure2_V1");
  assert.equal(result.success, true, `expected success; got: ${JSON.stringify(result.fatalErrors)}`);
  assert.equal(result.lpMatch?.name, "LP63");
  assert.equal(result.lpMechanism, "explicit-contract-enabled-binding");
});

test("resolvePricingFlowAncestors stops with a conflict error (never falls through) when IsContractEnabled is ambiguous — the mechanism's own conflict propagates as a fatal error", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType><parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters></steps>
    <steps><name>LP_A</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters></steps>
    <steps><name>LP_B</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
    </steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD1")!;
  const result = resolvePricingFlowAncestors(graph, ad, "Ambiguous_Donor");
  assert.equal(result.success, false);
  assert.match(result.fatalErrors[0], /ambiguous: 2 ListPrice occurrences share IsContractEnabled=true/);
});
