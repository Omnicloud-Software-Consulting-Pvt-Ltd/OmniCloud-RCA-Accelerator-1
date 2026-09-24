/**
 * §Root-cause fix (live evidence, execution ABP-20260918-181657-4611) — the live pipeline got past every
 * prior fix (rules/conditions/adjustments/runtime resolution/Decision Table refresh/AttributeValue
 * self-reference) and reached "Create Expression Set Version," where Salesforce rejected the generated XML:
 * "Select list filter as the first element in list group. Please remove Attribute Discount Entries."
 *
 * A standalone script (no dev-server involvement — same technique used for the AttributeValue investigation)
 * called the real `buildAttributeCanvas` directly against the live org and captured the exact generated
 * final XML. Comparing it against a hash-verified re-capture of the donor's own raw XML proved
 * `shouldStripAttributeDiscountParam` (Patch A) was unconditionally removing `ProductId`,
 * `ProductSellingModelId`, `LookUpName`, `LookUpId`, `LookUpApiName`, `IsContractEnabled`, `HideWaterfall`,
 * `sectionCount`, `selectedFunction` and `IsRealTime` from AttributeDiscount's `<customElement>` — because
 * none of those names were in `RECOGNIZED_PARAM_NAMES` (Patch A strips any input name it doesn't recognize,
 * a deliberate design for stripping per-attribute/org-specific literals like a hardcoded "Memory"="RAM
 * 64GB" parameter). But these 10 names are NOT per-attribute literals: the same real donor capture shows
 * them present, identically, across EVERY Decision-Table-lookup pricing step (AttributeDiscount,
 * BundleDiscount, VolumeDiscount, VolumeTierDiscount, the Contract-Pricing ListPrice lookup) — i.e. this is
 * the standard, universal shape of an RCA "Select"/Get Decision-Table lookup (Salesforce's own "list
 * group"/"list filter" concept). Stripping them produced an AttributeDiscount step with no lookup
 * configuration at all, exactly the malformed shape Salesforce rejected.
 *
 * Fixed by (1) adding these names to `RECOGNIZED_PARAM_NAMES`, and (2) restricting the "is this value a
 * recognized context variable" check to genuine type=Parameter (variable-reference) inputs — applying it to
 * type=Literal inputs (LookUpId's raw Salesforce Id, LookUpApiName's Decision Table API name, etc.) was a
 * category error that would have stripped them right back out even after (1). Also closed the validation
 * gap that let this reach Salesforce undetected: `buildFinalCanvasStructuralAudit`'s `missingRequiredBindings`
 * previously checked ONLY for PriceAdjustmentScheduleId — it now also verifies the lookup-configuration
 * fields survive into the FINAL, post-strip canvas.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { patchA_stripProductLiterals, buildFinalCanvasStructuralAudit } from "./canvasBuilder";
import { buildParameterBlock, getNestedCustomElementParameterBlocks, getParamName } from "./xmlBlocks";

function wrapCustomElement(paramBlocks: string[]): string {
  return `<customElement>${paramBlocks.join("")}</customElement>`;
}

/** The real donor's exact AttributeDiscount [14] (IsContractEnabled=false) shape, field-for-field, from the
 * hash-verified live capture — used across this file so every test is anchored to real evidence. */
const REAL_AD_OWN_PART = `<actionType>AttributeDiscount</actionType>` + wrapCustomElement([
  buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "AttributePASIdConstant" }),
  buildParameterBlock({ input: true, name: "ProductId", output: false, type: "Parameter", value: "Product" }),
  buildParameterBlock({ input: true, name: "ProductSellingModelId", output: false, type: "Parameter", value: "ProductSellingModel" }),
  buildParameterBlock({ input: true, name: "EffectiveFrom", output: false, type: "Parameter", value: "EffectiveDate" }),
  buildParameterBlock({ input: true, name: "EffectiveTo", output: false, type: "Parameter", value: "EffectiveDate" }),
  buildParameterBlock({ input: true, name: "AttributeName", output: false, type: "Parameter", value: "Attribute" }),
  buildParameterBlock({ input: true, name: "AttributeValue", output: false, type: "Parameter", value: "AttributeValue" }),
  buildParameterBlock({ input: true, name: "Quantity", output: false, type: "Parameter", value: "LineItemQuantity" }),
  buildParameterBlock({ input: true, name: "IsPriceImpacting", output: false, type: "Parameter", value: "PriceImpactingAttribute" }),
  buildParameterBlock({ input: true, name: "InputUnitPrice", output: false, type: "Parameter", value: "NetUnitPrice" }),
  buildParameterBlock({ input: true, name: "LookUpName", output: false, type: "Literal", value: "Attribute Discount Entries" }),
  buildParameterBlock({ input: true, name: "LookUpId", output: false, type: "Literal", value: "0lDNS000000BelO2AS" }),
  buildParameterBlock({ input: true, name: "LookUpApiName", output: false, type: "Literal", value: "Attribute_Based_Adjustment_Decision_Table" }),
  buildParameterBlock({ input: true, name: "IsContractEnabled", output: false, type: "Literal", value: "false" }),
  buildParameterBlock({ input: true, name: "HideWaterfall", output: false, type: "Literal", value: "false" }),
  buildParameterBlock({ input: true, name: "sectionCount", output: false, type: "Literal", value: "0" }),
  buildParameterBlock({ input: true, name: "selectedFunction", output: false, type: "Literal", value: "Get" }),
  buildParameterBlock({ input: true, name: "IsRealTime", output: false, type: "Literal", value: "false" }),
  buildParameterBlock({ input: false, name: "NetUnitPrice", output: true, type: "Parameter", value: "NetUnitPrice" }),
  buildParameterBlock({ input: false, name: "Subtotal", output: true, type: "Parameter", value: "ItemNetTotalPrice" }),
]);

test("TEST 1 — patchA_stripProductLiterals PRESERVES every real Decision-Table lookup/config parameter (ProductId, ProductSellingModelId, LookUpName, LookUpId, LookUpApiName, IsContractEnabled, HideWaterfall, sectionCount, selectedFunction, IsRealTime) from the real donor's exact shape — this is the exact bug that produced Salesforce's 'Select list filter as the first element in list group' rejection", () => {
  const result = patchA_stripProductLiterals(REAL_AD_OWN_PART);
  const survivingNames = getNestedCustomElementParameterBlocks(result).map(b => getParamName(b.block));
  for (const required of ["ProductId", "ProductSellingModelId", "LookUpName", "LookUpId", "LookUpApiName", "IsContractEnabled", "HideWaterfall", "sectionCount", "selectedFunction", "IsRealTime", "AttributeName", "AttributeValue", "PriceAdjustmentScheduleId"]) {
    assert.ok(survivingNames.includes(required), `expected "${required}" to survive Patch A — real donor evidence proves it's a standard, universal lookup field, not a stripped literal; survivors: ${JSON.stringify(survivingNames)}`);
  }
});

test("TEST 2 — Attribute Discount Entries lookup remains present (LookUpId/LookUpApiName/LookUpName all survive together) — the Decision-Table reference itself is never lost", () => {
  const result = patchA_stripProductLiterals(REAL_AD_OWN_PART);
  const blocks = getNestedCustomElementParameterBlocks(result);
  const byName = new Map(blocks.map(b => [getParamName(b.block), b.block]));
  assert.match(byName.get("LookUpName") ?? "", /Attribute Discount Entries/);
  assert.match(byName.get("LookUpId") ?? "", /0lDNS000000BelO2AS/);
  assert.match(byName.get("LookUpApiName") ?? "", /Attribute_Based_Adjustment_Decision_Table/);
});

test("TEST 3 — a genuinely unrecognized, org/attribute-specific literal (e.g. a hardcoded 'Memory'='RAM 64GB' parameter) is STILL stripped — the fix is narrowly scoped to the 10 proven-universal lookup fields, not a blanket stop-stripping", () => {
  const ownPart = `<actionType>AttributeDiscount</actionType>` + wrapCustomElement([
    buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "PriceAdjustmentScheduleId" }),
    buildParameterBlock({ input: true, name: "Memory", output: false, type: "Parameter", value: "RAM 64GB" }),
    buildParameterBlock({ input: true, name: "LookUpId", output: false, type: "Literal", value: "0lDNS000000BelO2AS" }),
  ]);
  const result = patchA_stripProductLiterals(ownPart);
  const survivingNames = getNestedCustomElementParameterBlocks(result).map(b => getParamName(b.block));
  assert.ok(!survivingNames.includes("Memory"), "an unrecognized, per-attribute literal must still be stripped");
  assert.ok(survivingNames.includes("LookUpId"), "LookUpId must survive alongside the correctly-stripped literal");
});

test("TEST 4 — a type=Parameter input bound to a genuinely unrecognized context variable (not one of the Literal lookup-config fields) is STILL stripped — narrowing the value-check to type=Parameter-only did not weaken detection for actual variable-reference bindings", () => {
  const ownPart = `<actionType>AttributeDiscount</actionType>` + wrapCustomElement([
    buildParameterBlock({ input: true, name: "AttributeName", output: false, type: "Parameter", value: "SomeUnrecognizedContextVar" }),
  ]);
  const result = patchA_stripProductLiterals(ownPart);
  const survivingNames = getNestedCustomElementParameterBlocks(result).map(b => getParamName(b.block));
  assert.ok(!survivingNames.includes("AttributeName"), "AttributeName bound to a genuinely unrecognized context variable must still be stripped");
});

test("TEST 5 — a Literal-typed LookUpId is preserved verbatim regardless of its value shape (never second-guessed against a context-variable allowlist, matching the treatment PriceAdjustmentScheduleId's own verbatim-clone already gets) — proves the exemption is keyed on type=Literal, not on the value happening to look safe", () => {
  const ownPart = `<actionType>AttributeDiscount</actionType>` + wrapCustomElement([
    buildParameterBlock({ input: true, name: "LookUpId", output: false, type: "Literal", value: "0lDNS000000DifferentOrgId" }),
  ]);
  const result = patchA_stripProductLiterals(ownPart);
  const survivingNames = getNestedCustomElementParameterBlocks(result).map(b => getParamName(b.block));
  assert.ok(survivingNames.includes("LookUpId"), "a Literal-typed LookUpId must never be stripped based on its value shape");
});

test("TEST 6 — buildFinalCanvasStructuralAudit reports FAILED and names the exact missing lookup parameter when the final canvas is missing LookUpId/LookUpApiName (reproducing the pre-fix bug at the audit layer) — this is the validation gap that let the bug reach Salesforce undetected", () => {
  const badFinalXml = `<ExpressionSetDefinition>
    <versions>
      <steps><name>PS1</name><actionType>PricingSettings</actionType>${buildParameterBlock({ input: false, name: "NetUnitPrice", output: true, type: "Parameter", value: "NetUnitPrice" })}</steps>
      <steps><name>LP1</name><actionType>ListPrice</actionType>${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "SomeDeclaredVar" })}</steps>
      <steps><name>AD1</name><actionType>AttributeDiscount</actionType>
        <customElement>
          ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "SomeDeclaredVar" })}
          ${buildParameterBlock({ input: true, name: "AttributeName", output: false, type: "Parameter", value: "Attribute" })}
          ${buildParameterBlock({ input: true, name: "AttributeValue", output: false, type: "Parameter", value: "AttributeValue" })}
        </customElement>
      </steps>
      <variables><name>SomeDeclaredVar</name></variables>
    </versions>
  </ExpressionSetDefinition>`;
  const audit = buildFinalCanvasStructuralAudit(badFinalXml);
  assert.equal(audit.passed, false);
  assert.ok(audit.missingRequiredBindings.some(m => m.includes("LookUpId")), `expected a missing-LookUpId binding; got: ${JSON.stringify(audit.missingRequiredBindings)}`);
  assert.ok(audit.missingRequiredBindings.some(m => m.includes("ProductId")), `expected a missing-ProductId binding; got: ${JSON.stringify(audit.missingRequiredBindings)}`);
});

test("TEST 7 — buildFinalCanvasStructuralAudit reports PASSED when the real donor's exact AttributeDiscount shape (all lookup/config fields present) makes up the final canvas — the direct regression test for the fix, using the same real evidence as TEST 1", () => {
  const goodFinalXml = `<ExpressionSetDefinition>
    <versions>
      <steps><name>PS1</name><actionType>PricingSettings</actionType>${buildParameterBlock({ input: false, name: "NetUnitPrice", output: true, type: "Parameter", value: "NetUnitPrice" })}</steps>
      <steps><name>LP63</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Literal</type><value>false</value></parameters>
        ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "AttributePASIdConstant" })}
      </steps>
      <steps><name>AD14</name>${REAL_AD_OWN_PART}<parentStep>ListContainer27</parentStep></steps>
    </versions>
  </ExpressionSetDefinition>`;
  const audit = buildFinalCanvasStructuralAudit(goodFinalXml);
  assert.equal(audit.passed, true, `expected PASSED; got missingRequiredBindings=${JSON.stringify(audit.missingRequiredBindings)}, selfReferentialInputs=${JSON.stringify(audit.selfReferentialInputs)}`);
  assert.equal(audit.missingRequiredBindings.length, 0);
  assert.equal(audit.selfReferentialInputs.length, 0, "AttributeValue must still resolve as valid (RCA_NATIVE_SELF_REFERENTIAL_CTX unaffected by this fix)");
});

test("TEST 8 — AttributeValue RCA-native self-reference handling remains valid after this fix (no regression on the prior root-cause fix) — patchA_stripProductLiterals must never touch AttributeValue at all, since its name is already recognized", () => {
  const result = patchA_stripProductLiterals(REAL_AD_OWN_PART);
  const survivingNames = getNestedCustomElementParameterBlocks(result).map(b => getParamName(b.block));
  assert.ok(survivingNames.includes("AttributeValue"), "AttributeValue must survive Patch A unchanged");
});

/* ── §FINAL fix (execution referencing "Select list filter as the first element in list group") — the
 * lookup-parameter fix above was necessary but insufficient: Salesforce kept rejecting the SAME error
 * afterward. Real evidence (see pricingCanvasPruning.listGroupCompleteness.test.ts for the root-cause
 * pruning fix itself) proved the AttributeDiscount step's `<parentStep>` container is a
 * `<stepType>ListGroup</stepType>` step whose REQUIRED sibling — an `AdvancedListFilter` step at
 * sequenceNumber 1 — was being pruned away, leaving AttributeDiscount as the ListGroup's only (and thus
 * first) child. These tests cover the companion structural-audit visibility this class of defect needed:
 * `buildFinalCanvasStructuralAudit`'s new `listGroups` field. ── */

function containerStep(opts: { name: string; stepType: string; parentStep?: string; seq: number }): string {
  return `<steps><name>${opts.name}</name>${opts.parentStep ? `<parentStep>${opts.parentStep}</parentStep>` : ""}<sequenceNumber>${opts.seq}</sequenceNumber><stepType>${opts.stepType}</stepType></steps>`;
}

const MINIMAL_LP_XML = `<steps><name>LP63</name><actionType>ListPrice</actionType><parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Literal</type><value>false</value></parameters>${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "AttributePASIdConstant" })}</steps>`;
const MINIMAL_PS_XML = `<steps><name>PS1</name><actionType>PricingSettings</actionType>${buildParameterBlock({ input: false, name: "NetUnitPrice", output: true, type: "Parameter", value: "NetUnitPrice" })}</steps>`;

test("TEST 9 — buildFinalCanvasStructuralAudit reports a ListGroup issue and FAILS when its first child is NOT an AdvancedListFilter — the exact shape that produced the live Salesforce rejection (isolated from the lookup-parameter fix: AttributeDiscount's OWN fields are otherwise fully valid, using the real donor's exact shape)", () => {
  const badXml = `<ExpressionSetDefinition><versions>
    ${MINIMAL_PS_XML}
    ${MINIMAL_LP_XML}
    ${containerStep({ name: "ListContainer27", stepType: "ListGroup", seq: 12 })}
    <steps><name>AD14</name>${REAL_AD_OWN_PART}<parentStep>ListContainer27</parentStep><sequenceNumber>2</sequenceNumber></steps>
  </versions></ExpressionSetDefinition>`;
  const audit = buildFinalCanvasStructuralAudit(badXml);
  assert.equal(audit.passed, false);
  assert.equal(audit.listGroups.length, 1);
  assert.equal(audit.listGroups[0].firstChildIsAdvancedListFilter, false);
  assert.ok(audit.listGroups[0].issue?.includes("AD14"), `expected the issue to name the wrongly-first child; got: ${audit.listGroups[0].issue}`);
  assert.match(audit.summary, /FAILED/);
});

test("TEST 9b — buildFinalCanvasStructuralAudit reports PASSED when the ListGroup's first child IS an AdvancedListFilter, matching the real donor's proven shape (this is the fix's own regression test, using the same real AttributeDiscount shape as TEST 9 so ONLY the ListGroup ordering differs)", () => {
  const goodXml = `<ExpressionSetDefinition><versions>
    ${MINIMAL_PS_XML}
    ${MINIMAL_LP_XML}
    ${containerStep({ name: "ListContainer27", stepType: "ListGroup", seq: 12 })}
    ${containerStep({ name: "ListOperation28", stepType: "AdvancedListFilter", parentStep: "ListContainer27", seq: 1 })}
    <steps><name>AD14</name>${REAL_AD_OWN_PART}<parentStep>ListContainer27</parentStep><sequenceNumber>2</sequenceNumber></steps>
  </versions></ExpressionSetDefinition>`;
  const audit = buildFinalCanvasStructuralAudit(goodXml);
  assert.equal(audit.listGroups.length, 1);
  assert.equal(audit.listGroups[0].firstChildIsAdvancedListFilter, true);
  assert.equal(audit.listGroups[0].issue, null);
  assert.equal(audit.passed, true, `expected PASSED; got listGroups=${JSON.stringify(audit.listGroups)}, missingRequiredBindings=${JSON.stringify(audit.missingRequiredBindings)}, selfReferentialInputs=${JSON.stringify(audit.selfReferentialInputs)}`);
});

test("TEST — a ListGroup with zero children in the final canvas is reported as an issue (the sibling was pruned away entirely, an even more severe version of the live bug)", () => {
  const emptyGroupXml = `<ExpressionSetDefinition><versions>
    ${MINIMAL_PS_XML}
    ${MINIMAL_LP_XML}
    <steps><name>AD1</name>${REAL_AD_OWN_PART}</steps>
    ${containerStep({ name: "ListContainer27", stepType: "ListGroup", seq: 12 })}
  </versions></ExpressionSetDefinition>`;
  const audit = buildFinalCanvasStructuralAudit(emptyGroupXml);
  assert.equal(audit.listGroups.length, 1);
  assert.equal(audit.passed, false);
  assert.ok(audit.listGroups[0].issue?.includes("no children"), `expected a no-children issue; got: ${audit.listGroups[0].issue}`);
});

test("TEST — both real AttributeDiscount branches (true/false ListGroups) pass together with zero false positives when both are structurally correct", () => {
  const xml = `<ExpressionSetDefinition><versions>
    ${MINIMAL_PS_XML}
    ${MINIMAL_LP_XML}
    ${containerStep({ name: "ListContainer24", stepType: "ListGroup", seq: 11 })}
    ${containerStep({ name: "ListOperation25", stepType: "AdvancedListFilter", parentStep: "ListContainer24", seq: 1 })}
    <steps><name>AD13</name>${REAL_AD_OWN_PART}<parentStep>ListContainer24</parentStep><sequenceNumber>2</sequenceNumber></steps>
    ${containerStep({ name: "ListContainer27", stepType: "ListGroup", seq: 12 })}
    ${containerStep({ name: "ListOperation28", stepType: "AdvancedListFilter", parentStep: "ListContainer27", seq: 1 })}
    <steps><name>AD14</name>${REAL_AD_OWN_PART}<parentStep>ListContainer27</parentStep><sequenceNumber>2</sequenceNumber></steps>
  </versions></ExpressionSetDefinition>`;
  const audit = buildFinalCanvasStructuralAudit(xml);
  assert.equal(audit.listGroups.length, 2);
  assert.ok(audit.listGroups.every(g => g.issue === null), `expected zero issues across both correct ListGroups; got: ${JSON.stringify(audit.listGroups.map(g => g.issue))}`);
});

test("TEST 9 — PriceAdjustmentScheduleId validation remains unweakened: a genuinely fabricated self-referential PriceAdjustmentScheduleId is still caught fatal by buildFinalCanvasStructuralAudit even with the expanded RECOGNIZED_PARAM_NAMES allowlist", () => {
  const badXml = `<ExpressionSetDefinition>
    <versions>
      <steps><name>PS1</name><actionType>PricingSettings</actionType>${buildParameterBlock({ input: false, name: "NetUnitPrice", output: true, type: "Parameter", value: "NetUnitPrice" })}</steps>
      <steps><name>LP1</name><actionType>ListPrice</actionType>${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "SomeDeclaredVar" })}</steps>
      <steps><name>AD1</name><actionType>AttributeDiscount</actionType>
        <customElement>
          ${buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "PriceAdjustmentScheduleId" })}
          ${buildParameterBlock({ input: true, name: "ProductId", output: false, type: "Parameter", value: "Product" })}
          ${buildParameterBlock({ input: true, name: "ProductSellingModelId", output: false, type: "Parameter", value: "ProductSellingModel" })}
          ${buildParameterBlock({ input: true, name: "LookUpName", output: false, type: "Literal", value: "Attribute Discount Entries" })}
          ${buildParameterBlock({ input: true, name: "LookUpId", output: false, type: "Literal", value: "0lDNS000000BelO2AS" })}
          ${buildParameterBlock({ input: true, name: "LookUpApiName", output: false, type: "Literal", value: "Attribute_Based_Adjustment_Decision_Table" })}
          ${buildParameterBlock({ input: true, name: "selectedFunction", output: false, type: "Literal", value: "Get" })}
          ${buildParameterBlock({ input: true, name: "sectionCount", output: false, type: "Literal", value: "0" })}
        </customElement>
      </steps>
      <variables><name>SomeDeclaredVar</name></variables>
    </versions>
  </ExpressionSetDefinition>`;
  const audit = buildFinalCanvasStructuralAudit(badXml);
  assert.equal(audit.passed, false);
  assert.equal(audit.selfReferentialInputs.length, 1);
  assert.equal(audit.selfReferentialInputs[0].name, "PriceAdjustmentScheduleId");
});

test("TEST 10 — the generated structure matches the proven donor structure for the AttributeDiscount lookup: patchA_stripProductLiterals's output, once re-parsed, has exactly the same set of nested parameter names as the real donor's own branch (no extras invented, none of the required ones dropped)", () => {
  const result = patchA_stripProductLiterals(REAL_AD_OWN_PART);
  const survivingNames = new Set(getNestedCustomElementParameterBlocks(result).map(b => getParamName(b.block)));
  const expectedNames = new Set([
    "PriceAdjustmentScheduleId", "ProductId", "ProductSellingModelId", "EffectiveFrom", "EffectiveTo",
    "AttributeName", "AttributeValue", "Quantity", "IsPriceImpacting", "InputUnitPrice",
    "LookUpName", "LookUpId", "LookUpApiName", "IsContractEnabled", "HideWaterfall",
    "sectionCount", "selectedFunction", "IsRealTime", "NetUnitPrice", "Subtotal",
  ]);
  assert.deepEqual(survivingNames, expectedNames, `expected exact parity with the real donor's field set; got: ${JSON.stringify([...survivingNames])}`);
});
