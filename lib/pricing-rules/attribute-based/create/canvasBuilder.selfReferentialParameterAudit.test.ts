/**
 * §Live-org fix (execution ABP-20260918-172312-C4BD), §FINAL ROOT-CAUSE FIX (execution
 * ABP-20260918-175334-D713) — the general self-reference rule proven correct for PriceAdjustmentScheduleId
 * recurred on a DIFFERENT parameter, `AttributeValue`. Initial investigation (first half of this file's
 * history) could only prove the shape was donor-latent, not that it was VALID — no replacement value was
 * fabricated, per explicit instruction, pending real evidence.
 *
 * §Root-cause resolution — a hash-verified, read-only capture of the REAL raw ExpressionSetDefinition XML for
 * `Rev_Mgmt_Default_Pricing_Procedure2_V1` (via `captureDonorXmlDiagnostic`, Metadata API retrieve only, run
 * directly against the live org) proved `<name>AttributeValue</name>...<value>AttributeValue</value>` is
 * present VERBATIM in BOTH AttributeDiscount occurrences of this donor (occurrence 13, IsContractEnabled=true;
 * occurrence 14, IsContractEnabled=false) — genuinely donor-native, not fabricated by any patch. The captured
 * variable table further proved this is not a one-off: `Product`, `Attribute`, `PriceImpactingAttribute`,
 * `LineItemQuantity`, `ProductSellingModel` and `PricingDate` are ALSO never declared by this donor's envelope
 * `<variables>` and never produced by any of its 76 steps, yet are consumed identically across ListPrice,
 * BundleDiscount, VolumeDiscount, VolumeTierDiscount and AttributeDiscount occurrences throughout this same,
 * real, currently-deployed Expression Set — proving this whole family are Salesforce RCA's own
 * implicit/runtime-injected context variables, exactly what `RCA_NATIVE_CTX` (already defined and already
 * used elsewhere in canvasBuilder.ts, e.g. the AD_MAPPINGS re-verification and the unresolved-binding check)
 * exists to represent. `AttributeValue` was only ever flagged because its context-variable name happens to be
 * spelled identically to the parameter name referencing it — `AttributeName`→`Attribute` is the exact same
 * binding shape and was never flagged, purely because the two strings differ.
 *
 * The actual bug: `findInvalidSelfReferentialInputParameters` (and an inline duplicate inside
 * `buildFinalCanvasStructuralAudit`) checked ONLY `declaredVars`, never `RCA_NATIVE_CTX` — an internal
 * inconsistency with the file's OWN already-evidence-backed check two lines away. Fixed by adding the
 * `RCA_NATIVE_CTX` exemption to both — reusing existing, already-vetted evidence, not introducing a new
 * allowlist. A self-reference that is neither declared NOR RCA-native (e.g. a fabricated one, like the
 * original ScheduleId bug this mechanism was built for) is still caught as fatal — this file's later tests
 * prove that detection is unweakened.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findInvalidSelfReferentialInputParameters, buildFinalCanvasStructuralAudit } from "./canvasBuilder";
import { buildParameterBlock } from "./xmlBlocks";

function wrapCustomElement(paramBlocks: string[]): string {
  return `<customElement>${paramBlocks.join("")}</customElement>`;
}

test("§Test 1 — a valid input parameter referencing a DECLARED envelope variable passes (no issue reported)", () => {
  const stepXml = `<actionType>AttributeDiscount</actionType>` + wrapCustomElement([
    buildParameterBlock({ input: true, name: "AttributeValue", output: false, type: "Parameter", value: "AttributeValue" }),
  ]);
  const issues = findInvalidSelfReferentialInputParameters(stepXml, new Set(["AttributeValue"]));
  assert.deepEqual(issues, [], "a genuinely declared envelope variable must never be flagged, even when name === value");
});

test("§Test 2 — an input parameter name=X value=X where X is NOT a declared envelope variable AND NOT an RCA-native context variable fails (e.g. a fabricated name with no donor/platform precedent)", () => {
  const stepXml = `<actionType>AttributeDiscount</actionType>` + wrapCustomElement([
    buildParameterBlock({ input: true, name: "TotallyInventedParam", output: false, type: "Parameter", value: "TotallyInventedParam" }),
  ]);
  const issues = findInvalidSelfReferentialInputParameters(stepXml, new Set());
  assert.equal(issues.length, 1);
  assert.equal(issues[0].name, "TotallyInventedParam");
  assert.equal(issues[0].value, "TotallyInventedParam");
});

/* ── §FINAL ROOT-CAUSE FIX (ABP-20260918-175334-D713) — evidence-based RCA_NATIVE_CTX exemption ── */

test("§Evidence Test 1 — AttributeValue's exact real-donor shape (name=AttributeValue value=AttributeValue, undeclared) is now correctly recognized as VALID — it is a Salesforce RCA implicit context variable, proven by hash-verified capture of the live donor's raw XML, not fabricated", () => {
  const stepXml = `<actionType>AttributeDiscount</actionType>` + wrapCustomElement([
    buildParameterBlock({ input: true, name: "AttributeValue", output: false, type: "Parameter", value: "AttributeValue" }),
  ]);
  const issues = findInvalidSelfReferentialInputParameters(stepXml, new Set());
  assert.deepEqual(issues, [], "AttributeValue is RCA-native — must never be flagged even with zero declared envelope variables");
});

test("§Evidence Test 2 — BOTH real AttributeDiscount branches (occurrence 13 IsContractEnabled=true, occurrence 14 IsContractEnabled=false) carry the identical AttributeValue self-reference in the real donor — both must resolve as valid, not just one", () => {
  const trueBranchXml = `<actionType>AttributeDiscount</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>` +
    wrapCustomElement([buildParameterBlock({ input: true, name: "AttributeValue", output: false, type: "Parameter", value: "AttributeValue" })]);
  const falseBranchXml = `<actionType>AttributeDiscount</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>` +
    wrapCustomElement([buildParameterBlock({ input: true, name: "AttributeValue", output: false, type: "Parameter", value: "AttributeValue" })]);
  assert.deepEqual(findInvalidSelfReferentialInputParameters(trueBranchXml, new Set()), [], "true (IsContractEnabled) branch must resolve AttributeValue as valid");
  assert.deepEqual(findInvalidSelfReferentialInputParameters(falseBranchXml, new Set()), [], "false (IsContractEnabled) branch must resolve AttributeValue as valid");
});

test("§Evidence Test 3 — a genuinely fabricated self-reference (neither declared nor RCA-native) is STILL caught as invalid — the RCA_NATIVE_CTX exemption is narrow, not a blanket weakening of the validator", () => {
  const stepXml = `<actionType>AttributeDiscount</actionType>` + wrapCustomElement([
    buildParameterBlock({ input: true, name: "SomeFabricatedFallback", output: false, type: "Parameter", value: "SomeFabricatedFallback" }),
  ]);
  const issues = findInvalidSelfReferentialInputParameters(stepXml, new Set());
  assert.equal(issues.length, 1, "a self-reference with no declared-variable or RCA-native precedent must still be rejected");
});

test("§Evidence Test 4 — the exemption is DELIBERATELY narrow: sibling RCA-native context variables (Product, Attribute, PriceImpactingAttribute, LineItemQuantity, ProductSellingModel, PricingDate) are NOT exempted from self-reference just because they're RCA-native — the same live-donor capture proved none of them ever appears self-referentially in real data (their consuming parameter is always spelled differently, e.g. ProductId≠Product), so a hypothetical self-reference on any of them is correctly still treated as invalid — this is what stops the exemption from silently becoming a blanket allowlist", () => {
  for (const nativeVar of ["Product", "Attribute", "PriceImpactingAttribute", "LineItemQuantity", "ProductSellingModel", "PricingDate"]) {
    const stepXml = `<actionType>AttributeDiscount</actionType>` + wrapCustomElement([
      buildParameterBlock({ input: true, name: nativeVar, output: false, type: "Parameter", value: nativeVar }),
    ]);
    const issues = findInvalidSelfReferentialInputParameters(stepXml, new Set());
    assert.equal(issues.length, 1, `${nativeVar} has never been proven safe to self-reference (unlike AttributeValue) — must still be flagged as invalid`);
  }
});

test("§Evidence Test 4b — PriceAdjustmentScheduleId specifically must STILL be caught as invalid when self-referential, even though it IS a member of the broader RCA_NATIVE_CTX set used elsewhere — this is the exact original bug class the validator exists to catch, and the AttributeValue fix must never silently reopen it", () => {
  const stepXml = `<actionType>AttributeDiscount</actionType>` + wrapCustomElement([
    buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "PriceAdjustmentScheduleId" }),
  ]);
  const issues = findInvalidSelfReferentialInputParameters(stepXml, new Set());
  assert.equal(issues.length, 1, "PriceAdjustmentScheduleId self-reference has no donor evidence of legitimacy (both real branches bind it to a distinct name) — must remain fatal");
});

test("§Test 3 — an OUTPUT parameter name=X output=true value=X continues to work (never flagged) — e.g. NetUnitPrice announcing its own published name", () => {
  const stepXml = `<actionType>PricingSettings</actionType>` +
    buildParameterBlock({ input: false, name: "NetUnitPrice", output: true, type: "Parameter", value: "NetUnitPrice" });
  const issues = findInvalidSelfReferentialInputParameters(stepXml, new Set());
  assert.deepEqual(issues, [], "an output parameter announcing its own name is a completely different, valid semantic — never an invalid self-reference");
});

test("§Test 6 — existing valid AttributeDiscount parameters (non-self-referential) remain unflagged", () => {
  const stepXml = `<actionType>AttributeDiscount</actionType>` + wrapCustomElement([
    buildParameterBlock({ input: true, name: "AttributeName", output: false, type: "Parameter", value: "Attribute" }),
    buildParameterBlock({ input: true, name: "EffectiveFrom", output: false, type: "Parameter", value: "PricingDate" }),
    buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "ItemContractAttributePasId" }),
  ]);
  const issues = findInvalidSelfReferentialInputParameters(stepXml, new Set());
  assert.deepEqual(issues, [], "none of these are self-referential — must never be flagged");
});

test("generalization — the same check now ALSO scans PricingSettings and ListPrice, not just AttributeDiscount (previously a real gap)", () => {
  const psXmlBad = `<actionType>PricingSettings</actionType>` +
    buildParameterBlock({ input: true, name: "ContractId", output: false, type: "Parameter", value: "ContractId" });
  const issuesPs = findInvalidSelfReferentialInputParameters(psXmlBad, new Set());
  assert.equal(issuesPs.length, 1, "PricingSettings input parameters must be checked too, not just AttributeDiscount's");

  const lpXmlBad = `<actionType>ListPrice</actionType>` +
    buildParameterBlock({ input: true, name: "Product2Id", output: false, type: "Parameter", value: "Product2Id" });
  const issuesLp = findInvalidSelfReferentialInputParameters(lpXmlBad, new Set());
  assert.equal(issuesLp.length, 1, "ListPrice input parameters must be checked too");
});

/* ── §Test 8 / Step 8 — buildFinalCanvasStructuralAudit ── */

const CLEAN_FINAL_XML = `<ExpressionSetDefinition>
  <versions>
    <variables><name>SomeDeclaredVar</name></variables>
    <steps><name>PS1</name><actionType>PricingSettings</actionType>
      ${buildParameterBlock({ input: true, name: "ContractId", output: false, type: "Parameter", value: "ItemContract" })}
      ${buildParameterBlock({ input: false, name: "NetUnitPrice", output: true, type: "Parameter", value: "NetUnitPrice" })}
    </steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
      ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "SomeDeclaredVar" })}
    </steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
      <customElement>
        ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "SomeDeclaredVar" })}
        ${buildParameterBlock({ input: true, name: "ProductId", output: false, type: "Parameter", value: "Product" })}
        ${buildParameterBlock({ input: true, name: "ProductSellingModelId", output: false, type: "Parameter", value: "ProductSellingModel" })}
        ${buildParameterBlock({ input: true, name: "LookUpName", output: false, type: "Literal", value: "Attribute Discount Entries" })}
        ${buildParameterBlock({ input: true, name: "LookUpId", output: false, type: "Literal", value: "0lDNS000000BelO2AS" })}
        ${buildParameterBlock({ input: true, name: "LookUpApiName", output: false, type: "Literal", value: "Attribute_Based_Adjustment_Decision_Table" })}
        ${buildParameterBlock({ input: true, name: "selectedFunction", output: false, type: "Literal", value: "Get" })}
        ${buildParameterBlock({ input: true, name: "sectionCount", output: false, type: "Literal", value: "0" })}
      </customElement>
    </steps>
  </versions>
</ExpressionSetDefinition>`;

test("§Test 8 / Step 8 — buildFinalCanvasStructuralAudit reports PASSED with zero self-referential inputs for a clean final canvas, and correctly identifies the selected branches + their IsContractEnabled values", () => {
  const audit = buildFinalCanvasStructuralAudit(CLEAN_FINAL_XML);
  assert.equal(audit.passed, true, `expected PASSED; got: ${JSON.stringify(audit.selfReferentialInputs)} / ${JSON.stringify(audit.missingRequiredBindings)}`);
  assert.equal(audit.selfReferentialInputs.length, 0);
  assert.equal(audit.missingRequiredBindings.length, 0);
  assert.equal(audit.envelopeVariables.length, 1);
  assert.equal(audit.envelopeVariables[0].name, "SomeDeclaredVar");
  assert.equal(audit.selectedAttributeDiscount?.isContractEnabled, "false");
  assert.equal(audit.selectedListPrice?.isContractEnabled, "false");
});

test("§Test 8 / Step 8 — buildFinalCanvasStructuralAudit reports FAILED and names the exact self-referential input when the final canvas contains a genuinely fabricated one (neither declared nor RCA-native) — the build must stop before deployment", () => {
  const badXml = `<ExpressionSetDefinition>
    <versions>
      <steps><name>PS1</name><actionType>PricingSettings</actionType>
        ${buildParameterBlock({ input: false, name: "NetUnitPrice", output: true, type: "Parameter", value: "NetUnitPrice" })}
      </steps>
      <steps><name>LP1</name><actionType>ListPrice</actionType>
        ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "SomeDeclaredVar" })}
      </steps>
      <steps><name>AD1</name><actionType>AttributeDiscount</actionType>
        <customElement>
          ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "SomeDeclaredVar" })}
          ${buildParameterBlock({ input: true, name: "SomeFabricatedFallback", output: false, type: "Parameter", value: "SomeFabricatedFallback" })}
        </customElement>
      </steps>
      <variables><name>SomeDeclaredVar</name></variables>
    </versions>
  </ExpressionSetDefinition>`;
  const audit = buildFinalCanvasStructuralAudit(badXml);
  assert.equal(audit.passed, false);
  assert.equal(audit.selfReferentialInputs.length, 1);
  assert.equal(audit.selfReferentialInputs[0].name, "SomeFabricatedFallback");
  assert.equal(audit.selfReferentialInputs[0].stepActionType, "AttributeDiscount");
  assert.match(audit.summary, /FAILED/);
});

test("§Evidence Test 5 — buildFinalCanvasStructuralAudit now reports PASSED for the real donor's exact AttributeValue shape (verbatim from the live capture) in BOTH IsContractEnabled branches — this is the actual scenario that used to fail live deployment and is the direct regression test for the root-cause fix", () => {
  const trueAdBranch = `<ExpressionSetDefinition>
    <versions>
      <steps><name>PS1</name><actionType>PricingSettings</actionType>${buildParameterBlock({ input: false, name: "NetUnitPrice", output: true, type: "Parameter", value: "NetUnitPrice" })}</steps>
      <steps><name>LP60</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
        ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "ItemContractAttributePasId" })}
      </steps>
      <steps><name>AD13</name><actionType>AttributeDiscount</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
        <customElement>
          ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "ItemContractAttributePasId" })}
          ${buildParameterBlock({ input: true, name: "AttributeName", output: false, type: "Parameter", value: "Attribute" })}
          ${buildParameterBlock({ input: true, name: "AttributeValue", output: false, type: "Parameter", value: "AttributeValue" })}
          ${buildParameterBlock({ input: true, name: "ProductId", output: false, type: "Parameter", value: "Product" })}
          ${buildParameterBlock({ input: true, name: "ProductSellingModelId", output: false, type: "Parameter", value: "ProductSellingModel" })}
          ${buildParameterBlock({ input: true, name: "LookUpName", output: false, type: "Literal", value: "Contract Pricing Entries" })}
          ${buildParameterBlock({ input: true, name: "LookUpId", output: false, type: "Literal", value: "0lDNS000000BelR2AS" })}
          ${buildParameterBlock({ input: true, name: "LookUpApiName", output: false, type: "Literal", value: "Contract_Pricing_Entries_Decision_Table" })}
          ${buildParameterBlock({ input: true, name: "selectedFunction", output: false, type: "Literal", value: "Get" })}
          ${buildParameterBlock({ input: true, name: "sectionCount", output: false, type: "Literal", value: "0" })}
        </customElement>
      </steps>
    </versions>
  </ExpressionSetDefinition>`;
  const falseAdBranch = `<ExpressionSetDefinition>
    <versions>
      <steps><name>PS1</name><actionType>PricingSettings</actionType>${buildParameterBlock({ input: false, name: "NetUnitPrice", output: true, type: "Parameter", value: "NetUnitPrice" })}</steps>
      <steps><name>LP63</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
        ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "AttributePASIdConstant" })}
      </steps>
      <steps><name>AD14</name><actionType>AttributeDiscount</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
        <customElement>
          ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "AttributePASIdConstant" })}
          ${buildParameterBlock({ input: true, name: "AttributeName", output: false, type: "Parameter", value: "Attribute" })}
          ${buildParameterBlock({ input: true, name: "AttributeValue", output: false, type: "Parameter", value: "AttributeValue" })}
          ${buildParameterBlock({ input: true, name: "ProductId", output: false, type: "Parameter", value: "Product" })}
          ${buildParameterBlock({ input: true, name: "ProductSellingModelId", output: false, type: "Parameter", value: "ProductSellingModel" })}
          ${buildParameterBlock({ input: true, name: "LookUpName", output: false, type: "Literal", value: "Attribute Discount Entries" })}
          ${buildParameterBlock({ input: true, name: "LookUpId", output: false, type: "Literal", value: "0lDNS000000BelO2AS" })}
          ${buildParameterBlock({ input: true, name: "LookUpApiName", output: false, type: "Literal", value: "Attribute_Based_Adjustment_Decision_Table" })}
          ${buildParameterBlock({ input: true, name: "selectedFunction", output: false, type: "Literal", value: "Get" })}
          ${buildParameterBlock({ input: true, name: "sectionCount", output: false, type: "Literal", value: "0" })}
        </customElement>
      </steps>
    </versions>
  </ExpressionSetDefinition>`;

  const trueAudit = buildFinalCanvasStructuralAudit(trueAdBranch);
  assert.equal(trueAudit.passed, true, `true branch expected PASSED; got selfReferentialInputs=${JSON.stringify(trueAudit.selfReferentialInputs)}`);
  assert.equal(trueAudit.selfReferentialInputs.length, 0);
  assert.equal(trueAudit.selectedAttributeDiscount?.isContractEnabled, "true");
  assert.equal(trueAudit.selectedListPrice?.isContractEnabled, "true");

  const falseAudit = buildFinalCanvasStructuralAudit(falseAdBranch);
  assert.equal(falseAudit.passed, true, `false branch expected PASSED; got selfReferentialInputs=${JSON.stringify(falseAudit.selfReferentialInputs)}`);
  assert.equal(falseAudit.selfReferentialInputs.length, 0);
});

test("§Test 7 — buildFinalCanvasStructuralAudit correctly reports IsContractEnabled=true selections too (the contract branch pairing must still be visible in the audit)", () => {
  const contractXml = `<ExpressionSetDefinition>
    <versions>
      <steps><name>PS1</name><actionType>PricingSettings</actionType>${buildParameterBlock({ input: false, name: "NetUnitPrice", output: true, type: "Parameter", value: "NetUnitPrice" })}</steps>
      <steps><name>LP60</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
        ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "ItemContractAttributePasId" })}
      </steps>
      <steps><name>AD13</name><actionType>AttributeDiscount</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>true</value></parameters>
        <customElement>
          ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "ItemContractAttributePasId" })}
          ${buildParameterBlock({ input: true, name: "ProductId", output: false, type: "Parameter", value: "Product" })}
          ${buildParameterBlock({ input: true, name: "ProductSellingModelId", output: false, type: "Parameter", value: "ProductSellingModel" })}
          ${buildParameterBlock({ input: true, name: "LookUpName", output: false, type: "Literal", value: "Contract Pricing Entries" })}
          ${buildParameterBlock({ input: true, name: "LookUpId", output: false, type: "Literal", value: "0lDNS000000BelR2AS" })}
          ${buildParameterBlock({ input: true, name: "LookUpApiName", output: false, type: "Literal", value: "Contract_Pricing_Entries_Decision_Table" })}
          ${buildParameterBlock({ input: true, name: "selectedFunction", output: false, type: "Literal", value: "Get" })}
          ${buildParameterBlock({ input: true, name: "sectionCount", output: false, type: "Literal", value: "0" })}
        </customElement>
      </steps>
    </versions>
  </ExpressionSetDefinition>`;
  const audit = buildFinalCanvasStructuralAudit(contractXml);
  assert.equal(audit.selectedListPrice?.isContractEnabled, "true");
  assert.equal(audit.selectedAttributeDiscount?.isContractEnabled, "true");
  assert.equal(audit.passed, true);
});

test("§Test 8 — missing required PriceAdjustmentScheduleId in the final canvas is reported as a missing required binding, failing the audit", () => {
  const noScheduleXml = `<ExpressionSetDefinition>
    <versions>
      <steps><name>PS1</name><actionType>PricingSettings</actionType>${buildParameterBlock({ input: false, name: "NetUnitPrice", output: true, type: "Parameter", value: "NetUnitPrice" })}</steps>
      <steps><name>LP1</name><actionType>ListPrice</actionType></steps>
      <steps><name>AD1</name><actionType>AttributeDiscount</actionType></steps>
    </versions>
  </ExpressionSetDefinition>`;
  const audit = buildFinalCanvasStructuralAudit(noScheduleXml);
  assert.equal(audit.passed, false);
  assert.ok(audit.missingRequiredBindings.some(m => m.includes("PriceAdjustmentScheduleId")));
});
