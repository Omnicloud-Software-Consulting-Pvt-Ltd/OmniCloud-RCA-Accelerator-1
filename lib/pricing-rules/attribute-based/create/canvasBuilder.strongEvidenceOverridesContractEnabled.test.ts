/**
 * §Root-cause fix (2nd org — `Laptop_Attribute_Pricing_Timeout_Fix_Test_V1`) — a live execution stopped
 * with "0 of 1 ListPrice occurrence(s) declare IsContractEnabled=true — refusing to guess" even though the
 * donor has exactly ONE ListPrice occurrence (nothing to disambiguate between) and its own explicit
 * InputUnitPrice/published-output binding unambiguously proves the real data-flow relationship. Read-only,
 * hash-verified donor XML was captured live from the actual org (via `donorXmlDiagnostic.ts`'s existing
 * capture tool) and confirmed byte-for-byte:
 *
 *   AttributeDiscount: IsContractEnabled=true,  InputUnitPrice=NetUnitPrice
 *   ListPrice:         IsContractEnabled=false, publishes output <name>ListPrice</name><value>NetUnitPrice</value>
 *   PricingSettings:   publishes output <name>NetUnitPrice</name><value>NetUnitPrice</value>
 *
 * `IsContractEnabled` here is classification (B)/(D) from the investigation — an independent per-step
 * property, not a reliable branch discriminator (there is no second ListPrice candidate to discriminate
 * between at all) and unrelated to the actual proven data flow. The real bug was `resolvePricingFlowAncestors`
 * trying the (conditional) IsContractEnabled signal BEFORE the (strong) structural/variable-binding signal
 * and treating a conditional-signal conflict as an absolute veto over evidence that should outrank it.
 *
 * `REAL_LAPTOP_DONOR` below is reconstructed field-for-field from the captured, hash-verified raw XML —
 * every attribute name, parameter name/value, and IsContractEnabled value is exactly as retrieved live.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractStepGraph } from "./xmlBlocks";
import { resolveListPriceByContractEnabledBinding, resolvePricingFlowAncestors } from "./canvasBuilder";

/** Field-for-field reconstruction of the REAL, hash-verified donor XML captured live from the 2nd org
 * (`Laptop_Attribute_Pricing_Timeout_Fix_Test_V1`, matched file
 * `expressionSetDefinition/Laptop_Attribute_Pricing_Timeout_Fix_Test.expressionSetDefinition`,
 * sha256=cc472d5d...aeeaed00d3). Occurrence indexes are reassigned fresh by `extractStepGraph` per
 * document, but every parameter name/value below is exactly as captured. */
const REAL_LAPTOP_DONOR = `<ExpressionSetDefinition>
  <fullName>Laptop_Attribute_Pricing_Timeout_Fix_Test_V1</fullName>
  <versions>
    <steps>
      <actionType>AttributeDiscount</actionType>
      <customElement>
        <parameters><input>true</input><name>PriceAdjustmentScheduleId</name><output>false</output><type>Parameter</type><value>ItemContractAttributePasId</value></parameters>
        <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
        <parameters><input>true</input><name>LookUpApiName</name><output>false</output><type>Literal</type><value>Attribute_Based_Adjustment_Decision_Table</value></parameters>
        <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Literal</type><value>true</value></parameters>
        <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
        <parameters><input>false</input><name>IsContracted</name><output>true</output><type>Parameter</type><value>IsContracted</value></parameters>
      </customElement>
      <label>Attribute-Based Price</label>
      <name>AttributeBasedPrice</name>
      <sequenceNumber>3</sequenceNumber>
      <stepType>BusinessKnowledgeModel</stepType>
    </steps>
    <steps>
      <actionType>ListPrice</actionType>
      <customElement>
        <parameters><input>true</input><name>Product2Id</name><output>false</output><type>Parameter</type><value>Product</value></parameters>
        <parameters><input>true</input><name>LookUpApiName</name><output>false</output><type>Literal</type><value>Price_Book_Entry_Decision_Table_v2</value></parameters>
        <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Literal</type><value>false</value></parameters>
        <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      </customElement>
      <label>Price Book Entries</label>
      <name>PriceBookEntries</name>
      <sequenceNumber>2</sequenceNumber>
      <stepType>BusinessKnowledgeModel</stepType>
    </steps>
    <steps>
      <actionType>PricingSettings</actionType>
      <customElement>
        <parameters><input>true</input><name>LineItemId</name><output>false</output><type>Parameter</type><value>LineItem</value></parameters>
        <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
        <parameters><input>false</input><name>Subtotal</name><output>true</output><type>Parameter</type><value>ItemNetTotalPrice</value></parameters>
      </customElement>
      <label>Pricing Setting</label>
      <name>PricingSetting</name>
      <sequenceNumber>1</sequenceNumber>
      <stepType>BusinessKnowledgeModel</stepType>
    </steps>
  </versions>
</ExpressionSetDefinition>`;

test("TEST 1 — reproduces the exact real failure: resolveListPriceByContractEnabledBinding alone still reports the real conflict (that mechanism itself is correct and unchanged)", () => {
  const graph = extractStepGraph(REAL_LAPTOP_DONOR);
  const ad = graph.find(n => n.actionType === "AttributeDiscount")!;
  const outcome = resolveListPriceByContractEnabledBinding(graph, ad);
  assert.equal(outcome.status, "conflict");
  assert.match(outcome.reason, /0 of 1 ListPrice occurrence\(s\) declare IsContractEnabled=true/);
});

test("TEST 2 — the fix: resolvePricingFlowAncestors on the REAL donor now SUCCEEDS via strong variable-binding evidence, despite the IsContractEnabled conflict", () => {
  const graph = extractStepGraph(REAL_LAPTOP_DONOR);
  const ad = graph.find(n => n.actionType === "AttributeDiscount")!;
  const lp = graph.find(n => n.actionType === "ListPrice")!;
  const ps = graph.find(n => n.actionType === "PricingSettings")!;

  const result = resolvePricingFlowAncestors(graph, ad, "Laptop_Attribute_Pricing_Timeout_Fix_Test_V1");
  assert.equal(result.success, true, `expected success via strong evidence; got: ${JSON.stringify(result.fatalErrors)}`);
  assert.equal(result.lpMatch?.occurrenceIndex, lp.occurrenceIndex);
  assert.equal(result.lpMechanism, "variable-binding");
  assert.equal(result.psMatch?.occurrenceIndex, ps.occurrenceIndex);
});

test("TEST 3 — the IsContractEnabled conflict is still surfaced (as a non-fatal warning), never silently discarded", () => {
  const graph = extractStepGraph(REAL_LAPTOP_DONOR);
  const ad = graph.find(n => n.actionType === "AttributeDiscount")!;
  const result = resolvePricingFlowAncestors(graph, ad, "Laptop_Attribute_Pricing_Timeout_Fix_Test_V1");
  assert.ok(result.warnings.some(w => /IsContractEnabled/.test(w)), "expected the IsContractEnabled diagnostic to still be logged as a warning");
});

test("TEST 4 — AttributeDiscount=true / ListPrice=true (agreeing, real-donor-shape sanity check): strong evidence still resolves correctly and IsContractEnabled agrees", () => {
  const donor = REAL_LAPTOP_DONOR.replace("<value>false</value></parameters>\n        <parameters><input>false</input><name>ListPrice</name>", "<value>true</value></parameters>\n        <parameters><input>false</input><name>ListPrice</name>");
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.actionType === "AttributeDiscount")!;
  const lp = graph.find(n => n.actionType === "ListPrice")!;
  assert.equal(lp.full.includes("<name>IsContractEnabled</name><output>false</output><type>Literal</type><value>true</value>"), true, "fixture sanity: ListPrice IsContractEnabled is now true");
  const result = resolvePricingFlowAncestors(graph, ad, "arbitrary-donor-1");
  assert.equal(result.success, true);
  assert.equal(result.lpMechanism, "variable-binding");
});

test("TEST 5 — AttributeDiscount=false / ListPrice=false (agreeing, both false): strong evidence resolves regardless — IsContractEnabled agreement is irrelevant to the decision", () => {
  const donor = REAL_LAPTOP_DONOR.replace("<value>true</value></parameters>\n        <parameters><input>false</input><name>NetUnitPrice</name>", "<value>false</value></parameters>\n        <parameters><input>false</input><name>NetUnitPrice</name>");
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.actionType === "AttributeDiscount")!;
  assert.equal(ad.full.includes("<name>IsContractEnabled</name><output>false</output><type>Literal</type><value>false</value>"), true, "fixture sanity: AttributeDiscount IsContractEnabled is now false, matching ListPrice's false");
  const result = resolvePricingFlowAncestors(graph, ad, "arbitrary-donor-2");
  assert.equal(result.success, true);
  assert.equal(result.lpMechanism, "variable-binding");
});

test("TEST 6 — one ListPrice candidate with strong NetUnitPrice data-flow evidence among TWO candidates: the compatible one is chosen, the incompatible one is ignored, regardless of IsContractEnabled", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><actionType>PricingSettings</actionType><name>PS</name><customElement>
      <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </customElement></steps>
    <steps><actionType>ListPrice</actionType><name>LP_Compatible</name><customElement>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
      <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </customElement></steps>
    <steps><actionType>ListPrice</actionType><name>LP_Incompatible</name><customElement>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
      <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>SomeOtherVariable</value></parameters>
    </customElement></steps>
    <steps><actionType>AttributeDiscount</actionType><name>AD</name><customElement>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
    </customElement></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD")!;
  const result = resolvePricingFlowAncestors(graph, ad, "arbitrary-donor-3");
  assert.equal(result.success, true, `expected success; got: ${JSON.stringify(result.fatalErrors)}`);
  assert.equal(result.lpMatch?.name, "LP_Compatible", "the candidate publishing the exact matching output must be chosen, not the IsContractEnabled=true one");
  assert.equal(result.lpMechanism, "variable-binding");
});

test("TEST 7 — multiple candidates with EQUAL strong evidence (both publish the same output value): variable-binding refuses to pick, falls back to IsContractEnabled; if that's ALSO ambiguous, fails closed", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><actionType>ListPrice</actionType><name>LP_A</name><customElement>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
      <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </customElement></steps>
    <steps><actionType>ListPrice</actionType><name>LP_B</name><customElement>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
      <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </customElement></steps>
    <steps><actionType>AttributeDiscount</actionType><name>AD</name><customElement>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
    </customElement></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD")!;
  const result = resolvePricingFlowAncestors(graph, ad, "arbitrary-donor-4");
  assert.equal(result.success, false, "both candidates equally publish the matching output AND both share the same (non-matching) IsContractEnabled value — must fail closed, never guess");
  assert.match(result.fatalErrors[0], /0 of 2 ListPrice occurrence\(s\) declare IsContractEnabled=false/);
});

test("TEST 8 — contradictory explicit IsContractEnabled binding is overridden ONLY when the donor structure proves the data-flow relationship (this is the real donor's own exact shape)", () => {
  const graph = extractStepGraph(REAL_LAPTOP_DONOR);
  const ad = graph.find(n => n.actionType === "AttributeDiscount")!;
  const contractEnabledAlone = resolveListPriceByContractEnabledBinding(graph, ad);
  const fullResolution = resolvePricingFlowAncestors(graph, ad, "Laptop_Attribute_Pricing_Timeout_Fix_Test_V1");
  assert.equal(contractEnabledAlone.status, "conflict", "IsContractEnabled alone still contradicts — this fact is not erased");
  assert.equal(fullResolution.success, true, "but the donor's own proven data-flow relationship (InputUnitPrice == published output) overrides it");
});

test("TEST 9 — no hardcoded Salesforce Ids: an arbitrarily-shaped, unusual donor still resolves via the same mechanism", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><actionType>PricingSettings</actionType><name>###weird-ps-id-1a1###</name><customElement>
      <parameters><input>false</input><name>###weird-shared-variable-Q1###</name><output>true</output><type>Parameter</type><value>###weird-shared-variable-Q1###</value></parameters>
    </customElement></steps>
    <steps><actionType>ListPrice</actionType><name>###weird-lp-id-9x7###</name><customElement>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
      <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>###weird-shared-variable-Q1###</value></parameters>
    </customElement></steps>
    <steps><actionType>AttributeDiscount</actionType><name>###weird-ad-id-4z2###</name><customElement>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>###weird-shared-variable-Q1###</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
    </customElement></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.actionType === "AttributeDiscount")!;
  const result = resolvePricingFlowAncestors(graph, ad, "###weird-donor-name###");
  assert.equal(result.success, true, `expected success purely from structural evidence, no hardcoded Id/name involved; got: ${JSON.stringify(result.fatalErrors)}`);
  assert.equal(result.lpMatch?.name, "###weird-lp-id-9x7###");
});

test("TEST 10 — no hardcoded donor names: the SAME fixture shape resolves identically under a completely different donorFullName argument", () => {
  const graph = extractStepGraph(REAL_LAPTOP_DONOR);
  const ad = graph.find(n => n.actionType === "AttributeDiscount")!;
  const resultA = resolvePricingFlowAncestors(graph, ad, "Totally_Different_Donor_Name_ZZZ");
  const resultB = resolvePricingFlowAncestors(graph, ad, "Another_Arbitrary_Name_123");
  assert.equal(resultA.success, true);
  assert.equal(resultB.success, true);
  assert.equal(resultA.lpMatch?.name, resultB.lpMatch?.name);
});

test("TEST 11 — no hardcoded product/attribute names: arbitrary product-shaped identifiers throughout still resolve via the same evidence", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><actionType>PricingSettings</actionType><name>SomeUnrelatedSettingsStep</name><customElement>
      <parameters><input>false</input><name>SharedRunningPriceVar99</name><output>true</output><type>Parameter</type><value>SharedRunningPriceVar99</value></parameters>
    </customElement></steps>
    <steps><actionType>ListPrice</actionType><name>SomeUnrelatedProductPriceStep</name><customElement>
      <parameters><input>true</input><name>Product2Id</name><output>false</output><type>Parameter</type><value>CompletelyArbitraryProductVariableName</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
      <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>SharedRunningPriceVar99</value></parameters>
    </customElement></steps>
    <steps><actionType>AttributeDiscount</actionType><name>SomeUnrelatedAttrStep</name><customElement>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>SharedRunningPriceVar99</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
    </customElement></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.actionType === "AttributeDiscount")!;
  const result = resolvePricingFlowAncestors(graph, ad, "arbitrary-donor-5");
  assert.equal(result.success, true);
  assert.equal(result.lpMatch?.name, "SomeUnrelatedProductPriceStep");
});

test("TEST 12 — no hardcoded sequence numbers: strong evidence resolves correctly however sequenceNumber is set, including reversed/unusual ordering", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><actionType>PricingSettings</actionType><name>PS</name><sequenceNumber>50</sequenceNumber><customElement>
      <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </customElement></steps>
    <steps><actionType>AttributeDiscount</actionType><name>AD</name><sequenceNumber>1</sequenceNumber><customElement>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
    </customElement></steps>
    <steps><actionType>ListPrice</actionType><name>LP</name><sequenceNumber>99</sequenceNumber><customElement>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
      <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </customElement></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD")!;
  const lp = graph.find(n => n.name === "LP")!;
  assert.ok(Number(ad.sequenceNumber) < Number(lp.sequenceNumber), "fixture sanity: AttributeDiscount's sequenceNumber is LOWER than ListPrice's — the opposite of what sequence-order would need to resolve this");
  const result = resolvePricingFlowAncestors(graph, ad, "arbitrary-donor-6");
  assert.equal(result.success, true, "resolution must not depend on sequenceNumber ordering at all when strong evidence exists");
  assert.equal(result.lpMechanism, "variable-binding");
});

test("TEST 13 — no positional-only resolution: interleaving an unrelated ListPrice-shaped step BEFORE the real match in document order does not change the outcome", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><actionType>PricingSettings</actionType><name>PS</name><customElement>
      <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </customElement></steps>
    <steps><actionType>ListPrice</actionType><name>LP_Decoy</name><customElement>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
      <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>UnrelatedVariable</value></parameters>
    </customElement></steps>
    <steps><actionType>AttributeDiscount</actionType><name>AD</name><customElement>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
    </customElement></steps>
    <steps><actionType>ListPrice</actionType><name>LP_Real</name><customElement>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
      <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </customElement></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD")!;
  const decoy = graph.find(n => n.name === "LP_Decoy")!;
  assert.ok(decoy.occurrenceIndex < ad.occurrenceIndex, "fixture sanity: the decoy ListPrice appears BEFORE AttributeDiscount in document order");
  const result = resolvePricingFlowAncestors(graph, ad, "arbitrary-donor-7");
  assert.equal(result.success, true);
  assert.equal(result.lpMatch?.name, "LP_Real", "must select the step whose OUTPUT actually matches, never the nearer/earlier one by position");
});
