/**
 * §Live-org fix (real donor `Rev_Mgmt_Default_Pricing_Procedure2_V1`, execution ABP-20260918-160150-AE3B)
 * — regression coverage for two separate, now-resolved questions about this donor:
 *
 *   1. AttributeDiscount -> PricingSettings connectivity IS proven: neither of this donor's two ListPrice
 *      branches publishes an output named `NetUnitPrice` (they publish `ListPrice`/`ItemContractPrice`),
 *      but PricingSettings genuinely does, and both AttributeDiscount occurrences consume exactly that
 *      name via `InputUnitPrice` — Revenue Cloud's documented shared "pricing waterfall" variable. This
 *      is real, present evidence and is kept (`price-waterfall-variable` signal).
 *
 *   2. AttributeDiscount -> the SPECIFIC ListPrice branch it belongs to is NOT currently provable from any
 *      evidence available to this codebase without a live Salesforce session. A `shared-container-sibling`
 *      signal ("two steps declaring the same <parentStep> belong to the same branch") was added in an
 *      earlier turn and is REMOVED here — it directly contradicted this exact donor's own already-
 *      established finding that `<parentStep>` naming a ListContainer/ListGroup governs canvas PLACEMENT,
 *      not pricing DATA dependency (the very reason `variable-binding`/`price-waterfall-variable` had to
 *      be invented in the first place, two turns ago, for this same donor). Keeping an unproven,
 *      self-contradicting mechanism just because a synthetic test passed would be worse than having none.
 *
 * §IMPORTANT — this file's fixtures do NOT assert that "shared parentStep" is a valid ListPrice-pairing
 * signal; the opposite: `PROVEN_INSUFFICIENT_DONOR` below is a dedicated regression proving shared
 * parentStep alone must NEVER resolve ListPrice, precisely because that mechanism was tried and removed.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { extractStepGraph } from "./xmlBlocks";
import { resolveAttributeBasedPricingDonor, resolveConnectedAncestor, inspectDonorCandidate } from "./donorInspection";
import { resolveListPriceByContractFlavorFallback, resolvePricingFlowAncestors } from "./canvasBuilder";

/** The real donor's reported shape, WITHOUT assuming any ListPrice<->AttributeDiscount parentStep
 * relationship (that assumption is exactly what was disproved). PricingSettings publishes NetUnitPrice;
 * neither ListPrice branch does; both AttributeDiscount branches parent to their own ListGroup container,
 * and — honestly, per the live report — so do neither, one, or both ListPrice branches; this fixture does
 * NOT encode a parentStep pairing between them either way, since that is exactly the unproven part. */
const LIVE_SHAPE_DONOR_NO_SIBLING_ASSUMPTION = `<ExpressionSetDefinition>
  <fullName>Rev_Mgmt_Default_Pricing_Procedure2_V1</fullName>
  <versions>
    <steps><name>Formula1</name><actionType>FormulaBasedPricing</actionType><sequenceNumber>1</sequenceNumber></steps>
    <steps><name>Manual1</name><actionType>ManualDiscount</actionType><sequenceNumber>2</sequenceNumber></steps>
    <steps><name>Bundle1</name><actionType>BundleDiscount</actionType><sequenceNumber>3</sequenceNumber></steps>
    <steps><name>Proration1</name><actionType>Proration</actionType><sequenceNumber>4</sequenceNumber></steps>
    <steps><name>Subscription1</name><actionType>SubscriptionPricing</actionType><sequenceNumber>5</sequenceNumber></steps>
    <steps><name>VolumeTier1</name><actionType>VolumeTierDiscount</actionType><sequenceNumber>6</sequenceNumber></steps>
    <steps><name>Volume1</name><actionType>VolumeDiscount</actionType><sequenceNumber>7</sequenceNumber></steps>
    <steps><name>PS1</name><actionType>PricingSettings</actionType>
      <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </steps>
    <steps><name>ListContainer24</name><actionType>ListGroup</actionType></steps>
    <steps><name>LP_Contract</name><actionType>ListPrice</actionType>
      <parameters><input>false</input><name>ItemContractPrice</name><output>true</output><type>Parameter</type><value>ItemContractPrice</value></parameters>
    </steps>
    <steps><name>AD_Contract</name><actionType>AttributeDiscount</actionType><parentStep>ListContainer24</parentStep>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
      <customElement>
        <parameters><input>true</input><name>PriceAdjustmentScheduleId</name><output>false</output><type>Parameter</type><value>ItemContractAttributePasId</value></parameters>
      </customElement>
    </steps>
    <steps><name>ListContainer27</name><actionType>ListGroup</actionType></steps>
    <steps><name>LP_PriceBook</name><actionType>ListPrice</actionType>
      <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>ListPrice</value></parameters>
    </steps>
    <steps><name>AD_Standard</name><actionType>AttributeDiscount</actionType><parentStep>ListContainer27</parentStep>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
      <customElement>
        <parameters><input>true</input><name>PriceAdjustmentScheduleId</name><output>false</output><type>Parameter</type><value>AttributePASIdConstant</value></parameters>
      </customElement>
    </steps>
    <variables><name>AttributePASIdConstant</name><dataType>Text</dataType><type>Constant</type><value>84Xg7000000FQQPEA4</value></variables>
  </versions>
</ExpressionSetDefinition>`;

/** §Required regression (Step 9.5) — proves shared parentStep ALONE is insufficient: AttributeDiscount
 * and a ListPrice occurrence share the identical <parentStep>, but the ListPrice is a genuinely UNRELATED
 * branch (no matching output, no matching contract-flavor). The resolver must NOT pair them just because
 * they share a container. */
const PROVEN_INSUFFICIENT_DONOR = `<ExpressionSetDefinition>
  <versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType>
      <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </steps>
    <steps><name>Group1</name><actionType>ListGroup</actionType></steps>
    <steps><name>LP_Unrelated</name><actionType>ListPrice</actionType><parentStep>Group1</parentStep>
      <parameters><input>false</input><name>SomeOtherOutput</name><output>true</output><type>Parameter</type><value>SomeOtherOutput</value></parameters>
    </steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parentStep>Group1</parentStep>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
    </steps>
  </versions>
</ExpressionSetDefinition>`;

async function buildMockClient(donorXmlByFileName: Record<string, string>): Promise<SalesforceClient> {
  const zip = new JSZip();
  for (const [fileName, xml] of Object.entries(donorXmlByFileName)) zip.file(fileName, xml);
  const zipBase64 = await zip.generateAsync({ type: "base64" });
  return {
    apiVersion: "62.0",
    logDebug() { /* no-op */ },
    async metadataSoapCall(soapAction: string) {
      if (soapAction === "retrieve") return `<result><id>proc-1</id><done>true</done></result>`;
      if (soapAction === "checkRetrieveStatus") return `<result><id>proc-1</id><done>true</done><success>true</success><zipFile>${zipBase64}</zipFile></result>`;
      throw new Error(`unexpected metadataSoapCall: ${soapAction}`);
    },
  } as unknown as SalesforceClient;
}

test("§Required regression — shared <parentStep> ALONE must NEVER resolve ListPrice connectivity (the removed shared-container-sibling hypothesis, proven insufficient)", () => {
  const graph = extractStepGraph(PROVEN_INSUFFICIENT_DONOR);
  const ad = graph.find(n => n.name === "AD1")!;

  const result = resolveConnectedAncestor(graph, ad, "ListPrice");
  assert.equal(result.mechanism, "none", "AD1 and LP_Unrelated share <parentStep>Group1</parentStep>, but that must never be treated as proof — no other signal resolves either (LP_Unrelated publishes an unrelated output, and IsContractEnabled has no ListPrice-side flavor to match)");
  assert.equal(result.node, null);
});

test("resolveConnectedAncestor still proves AttributeDiscount -> PricingSettings via the shared price-waterfall variable (the ONE relationship that IS proven for this donor) even when ListPrice pairing is not", () => {
  const graph = extractStepGraph(LIVE_SHAPE_DONOR_NO_SIBLING_ASSUMPTION);
  const adStandard = graph.find(n => n.name === "AD_Standard")!;

  const toListPrice = resolveConnectedAncestor(graph, adStandard, "ListPrice");
  assert.equal(toListPrice.mechanism, "none", "no parentStep-chain/physical-nesting/variable-binding proves a SPECIFIC ListPrice for this branch — honest, not a bug");

  const toPricingSettings = resolveConnectedAncestor(graph, adStandard, "PricingSettings");
  assert.equal(toPricingSettings.mechanism, "price-waterfall-variable");
  assert.equal(toPricingSettings.node?.name, "PS1");
});

test("§Requirement (preserved) — the prior weak-evidence-only donor (sequence-order, no parentStep at all) still resolves via sequence-order only, unaffected by removing shared-container-sibling", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType><sequenceNumber>1</sequenceNumber></steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType><sequenceNumber>2</sequenceNumber></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><sequenceNumber>3</sequenceNumber></steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD1")!;
  const result = resolveConnectedAncestor(graph, ad, "ListPrice");
  assert.equal(result.mechanism, "sequence-order");
  assert.equal(result.node?.name, "LP1");
});

test("resolveAttributeBasedPricingDonor still selects the real donor via PricingSettings-only connectivity (ListPrice pairing is a LATER, separate blocker — donor SELECTION does not require it)", async () => {
  const client = await buildMockClient({ "unpackaged/expressionSetDefinitions/Rev_Mgmt_Default_Pricing_Procedure2_V1.expressionSetDefinition-meta.xml": LIVE_SHAPE_DONOR_NO_SIBLING_ASSUMPTION });

  const resolution = await resolveAttributeBasedPricingDonor(client);

  assert.ok(resolution.selection, `expected this donor to be selected; got: ${JSON.stringify(resolution.lowConfidenceCandidates)}`);
  assert.equal(resolution.selection!.fullName, "Rev_Mgmt_Default_Pricing_Procedure2_V1");
  assert.equal(resolution.selection!.connectedAttributeDiscountOccurrenceIndexes.length, 2);
});

test("inspectDonorCandidate reports connectedToListPrice=false and connectedToPricingSettings=true (price-waterfall-variable) for both AttributeDiscount branches — honest about what is and isn't proven", () => {
  const candidate = inspectDonorCandidate("live.xml", LIVE_SHAPE_DONOR_NO_SIBLING_ASSUMPTION);
  assert.equal(candidate.attributeDiscountBranches.length, 2);
  for (const branch of candidate.attributeDiscountBranches) {
    assert.equal(branch.connectedToListPrice, false);
    assert.equal(branch.connectedToPricingSettings, true);
    assert.equal(branch.pricingSettingsConnection, "price-waterfall-variable");
  }
});

test("resolveListPriceByContractFlavorFallback resolves correctly when contract-flavor naming genuinely disambiguates (its own, independent, non-parentStep-based evidence)", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><name>LP_Standard</name><actionType>ListPrice</actionType>
      <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>ListPrice</value></parameters>
    </steps>
    <steps><name>LP_Contract</name><actionType>ListPrice</actionType>
      <parameters><input>false</input><name>ItemContractPrice</name><output>true</output><type>Parameter</type><value>ItemContractPrice</value></parameters>
    </steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
    </steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD1")!;
  const fallback = resolveListPriceByContractFlavorFallback(graph, ad);
  assert.equal(fallback.node?.name, "LP_Contract", `expected the contract-flavored ListPrice to be matched; got reason: ${fallback.reason}`);
});

// §IMPORTANT CAVEAT — this fixture's ListPrice field names ("ItemContractPrice" vs "ListPrice") happen to
// contain the literal substring "contract", which lets the fallback disambiguate. This is NOT verified
// against the real donor's actual field names (no live Salesforce session, no raw XML available) — it
// only demonstrates the fallback mechanism working correctly on a FAVORABLE naming pattern. The user's own
// live report says the real fallback attempt FAILED for this exact donor's two ListPrice branches (see the
// next test, which reproduces that outcome honestly with unfavorable/neutral field names instead).
test("resolveListPriceByContractFlavorFallback CAN disambiguate when a ListPrice's own field naming happens to be contract-flavored (mechanism check, not a claim about the real donor's actual field names)", () => {
  const graph = extractStepGraph(LIVE_SHAPE_DONOR_NO_SIBLING_ASSUMPTION);
  const adContract = graph.find(n => n.name === "AD_Contract")!;
  const fallback = resolveListPriceByContractFlavorFallback(graph, adContract);
  assert.equal(fallback.node?.name, "LP_Contract", `mechanism check only — depends on THIS fixture's field names; got reason: ${fallback.reason}`);
});

test("resolvePricingFlowAncestors FAILS with a complete evidence dump (never guesses) when the contract-flavor fallback is ALSO ambiguous — reproducing the exact reported live failure shape", () => {
  // A donor where NEITHER ListPrice's field naming is contract-flavored at all — the fallback has nothing
  // to disambiguate by, matching the user's report that both ListPrice occurrences defeated the fallback.
  const donor = `<ExpressionSetDefinition><versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType>
      <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </steps>
    <steps><name>LP_A</name><actionType>ListPrice</actionType>
      <parameters><input>false</input><name>PriceA</name><output>true</output><type>Parameter</type><value>PriceA</value></parameters>
    </steps>
    <steps><name>LP_B</name><actionType>ListPrice</actionType>
      <parameters><input>false</input><name>PriceB</name><output>true</output><type>Parameter</type><value>PriceB</value></parameters>
    </steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
    </steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD1")!;

  const result = resolvePricingFlowAncestors(graph, ad, "No_Contract_Flavor_Donor");

  assert.equal(result.success, false);
  assert.equal(result.lpMatch, null);
  assert.ok(result.fatalErrors[0].includes("refusing to guess"));
  assert.match(result.fatalErrors[0], /ListPrice \[/, "the fatal error must include the full per-candidate evidence table for a human to inspect");
});

// §Live investigation (this turn) — checks the ONE remaining real, non-heuristic data-flow path: does
// either ListPrice's own OUTPUT value get consumed as one of PricingSettings' own INPUT values (a genuine
// one-hop-removed dataflow chain: ListPrice -> PricingSettings input -> PricingSettings' NetUnitPrice
// output -> AttributeDiscount)? Uses the REAL PricingSettings/ListPrice field bindings reported across
// this investigation (PricingSettings inputs: LineItemId->LineItem, IsDerived->DerivedPricingAttribute,
// ContractId->ItemContract; outputs: NetUnitPrice->NetUnitPrice, PriceWaterfall->price_water_fall,
// Subtotal->ItemNetTotalPrice; Price Book ListPrice output: ListPrice->ListPrice; Contract ListPrice
// output: ListPrice->ItemContractPrice) — NONE of PricingSettings' own input values match either
// ListPrice's own output value, so this diagnostic must honestly report NO match, not fabricate one.
const REAL_REPORTED_BINDINGS_DONOR = `<ExpressionSetDefinition><versions>
  <steps><name>PS1</name><actionType>PricingSettings</actionType>
    <parameters><input>true</input><name>LineItemId</name><output>false</output><type>Parameter</type><value>LineItem</value></parameters>
    <parameters><input>true</input><name>IsDerived</name><output>false</output><type>Parameter</type><value>DerivedPricingAttribute</value></parameters>
    <parameters><input>true</input><name>ContractId</name><output>false</output><type>Parameter</type><value>ItemContract</value></parameters>
    <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    <parameters><input>false</input><name>PriceWaterfall</name><output>true</output><type>Parameter</type><value>price_water_fall</value></parameters>
    <parameters><input>false</input><name>Subtotal</name><output>true</output><type>Parameter</type><value>ItemNetTotalPrice</value></parameters>
  </steps>
  <steps><name>LP_PriceBook</name><actionType>ListPrice</actionType>
    <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>ListPrice</value></parameters>
  </steps>
  <steps><name>LP_Contract</name><actionType>ListPrice</actionType>
    <parameters><input>false</input><name>ListPrice</name><output>true</output><type>Parameter</type><value>ItemContractPrice</value></parameters>
  </steps>
  <steps><name>AD1</name><actionType>AttributeDiscount</actionType>
    <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
  </steps>
</versions></ExpressionSetDefinition>`;

test("§Live investigation (superseded) — evidence log correctly reports PricingSettings' own input bindings; this fixture's ListPrice occurrences have NO IsContractEnabled of their own, so the new Priority-1 mechanism correctly reports a conflict and stops rather than falling through to the (unrelated) contract-flavor fallback", () => {
  // §UPDATED — the real donor XML, captured via the donor-xml-diagnostic tool in a later turn, proved
  // BOTH AttributeDiscount AND ListPrice occurrences declare an explicit IsContractEnabled binding (see
  // `resolveListPriceByContractEnabledBinding`), which is now Priority 1 and — correctly — never falls
  // through once it detects a conflict. THIS fixture (reconstructed from earlier, imprecise paraphrasing,
  // before the real XML was captured) gives ListPrice occurrences NO IsContractEnabled at all, only AD1
  // has one — Priority 1 correctly treats "AD1 has it, but every ListPrice candidate is missing it" as a
  // conflict (not "not-applicable"), and stops rather than silently falling through to the old
  // contract-flavor fallback that happened to resolve this by coincidence in a previous turn. This is the
  // INTENDED behavior change from adding a high-confidence mechanism that never yields once it detects
  // real evidence problems.
  const graph = extractStepGraph(REAL_REPORTED_BINDINGS_DONOR);
  const ad = graph.find(n => n.name === "AD1")!;

  const result = resolvePricingFlowAncestors(graph, ad, "Rev_Mgmt_Default_Pricing_Procedure2_V1");

  assert.equal(result.success, false, "Priority 1 detects a conflict (ListPrice occurrences missing IsContractEnabled) and must stop, never fall through to the contract-flavor fallback");
  assert.match(result.fatalErrors[0], /conflict that must not be silently worked around/);
  assert.equal(result.lpMechanism, null);
  assert.match(result.evidenceLog, /PricingSettings own input bindings.*LineItemId=LineItem.*IsDerived=DerivedPricingAttribute.*ContractId=ItemContract/, "the evidence log must show PricingSettings' real input bindings for a human to verify");
  assert.ok(!result.evidenceLog.includes("consumed as one of PricingSettings' own input values"), "must NOT fabricate a one-hop match that these field values don't support — none of PricingSettings' inputs equal either ListPrice's output");
});

test("§Diagnostic mechanism check — the new one-hop 'ListPrice output feeds PricingSettings input' evidence line DOES fire correctly when a genuine match exists (positive control, not a claim about the real donor)", () => {
  const donor = `<ExpressionSetDefinition><versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType>
      <parameters><input>true</input><name>SomeInput</name><output>false</output><type>Parameter</type><value>SharedIntermediateValue</value></parameters>
      <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType>
      <parameters><input>false</input><name>Out</name><output>true</output><type>Parameter</type><value>SharedIntermediateValue</value></parameters>
    </steps>
    <steps><name>LP2</name><actionType>ListPrice</actionType>
      <parameters><input>false</input><name>Out</name><output>true</output><type>Parameter</type><value>UnrelatedValue</value></parameters>
    </steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </steps>
  </versions></ExpressionSetDefinition>`;
  const graph = extractStepGraph(donor);
  const ad = graph.find(n => n.name === "AD1")!;

  const result = resolvePricingFlowAncestors(graph, ad, "Synthetic_Mechanism_Check_Donor");

  assert.match(result.evidenceLog, /ListPrice \[\d+\].*outputs=\[SharedIntermediateValue\]\) — possible match — this ListPrice's own output value is consumed as one of PricingSettings' own input values/);
  assert.match(result.evidenceLog, /ListPrice \[\d+\].*outputs=\[UnrelatedValue\]\) — no proven match/);
  // §Still diagnostic-only — even a confirmed one-hop match does NOT auto-resolve, since this signal is
  // not yet wired into resolveConnectedAncestor's decision-making (only surfaced for human review).
  assert.equal(result.success, false, "the one-hop signal is diagnostic-only; it must not silently become a decision until deliberately promoted with real-world confirmation");
});
