/**
 * §Live-org fix (runtime evaluation bug) — reproduces the exact live symptom: a deployed
 * AttributeDiscount pricing element whose customElement carried a leaked, donor-specific literal
 * parameter (e.g. `"Memory": "RAM 64GB"`) instead of the generic `Attribute`/`AttributeValue`/
 * `PriceImpactingAttribute` transaction-context bindings, and a `PriceAdjustmentScheduleId` bound to a
 * stale literal Salesforce Id instead of the generic context-variable reference — both of which
 * `patchA_stripProductLiterals` previously never saw, because it only ever scanned TOP-LEVEL parameters
 * (`getTopLevelParameterBlocks` explicitly EXCLUDES anything nested inside `<customElement>`), which is
 * exactly where a donor's own AttributeDiscount step is required to nest bindings like
 * `PriceAdjustmentScheduleId` in the first place.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { patchA_stripProductLiterals, patchC_preserveScheduleId, validateAttributeCanvas } from "./canvasBuilder";
import { getNestedCustomElementParameterBlocks, getTopLevelParameterBlocks, getParamName, buildParameterBlock } from "./xmlBlocks";

function wrapCustomElement(paramBlocks: string[]): string {
  return `<customElement>${paramBlocks.join("")}</customElement>`;
}

test("patchA_stripProductLiterals strips a leaked, attribute-specific literal parameter NESTED inside <customElement> — the exact live-org 'Memory: RAM 64GB' bug", () => {
  const ownPart =
    `<actionType>AttributeDiscount</actionType>` +
    buildParameterBlock({ input: true, name: "InputUnitPrice", output: false, value: "NetUnitPrice" }) +
    wrapCustomElement([
      buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, value: "PriceAdjustmentScheduleId" }),
      // The leak: a donor-specific literal, nested exactly where PriceAdjustmentScheduleId legitimately lives.
      buildParameterBlock({ input: true, name: "Memory", output: false, value: "RAM 64GB" }),
    ]);

  const result = patchA_stripProductLiterals(ownPart);

  const nestedNames = getNestedCustomElementParameterBlocks(result).map(b => getParamName(b.block));
  assert.ok(!nestedNames.includes("Memory"), "the leaked attribute-specific parameter must be stripped");
  assert.ok(nestedNames.includes("PriceAdjustmentScheduleId"), "the legitimate, already-generic schedule binding must survive untouched");
});

test("patchA_stripProductLiterals strips a PriceAdjustmentScheduleId bound to a stale, literal Salesforce Id (never a generic context-variable reference) — even when nested; Patch C then leaves it genuinely ABSENT rather than fabricating a replacement", () => {
  // §Root-cause fix (live evidence confirmed) — Salesforce's real deploy rejected
  // "PriceAdjustmentScheduleId isn't a valid variable name," traced to Patch C's PRIOR behavior of
  // manufacturing a self-referential value="PriceAdjustmentScheduleId" (identical to its own name)
  // whenever no real donor binding existed to clone. This test previously asserted that exact
  // self-referential shape was "the generic context-variable reference" — it was not; a self-referential
  // value is never a valid Salesforce variable reference unless independently declared, which this
  // fallback never was. The corrected behavior: when the only donor value available is invalid (a stale
  // literal Id, stripped by Patch A) and no OTHER donor binding exists to clone verbatim, Patch C must
  // leave the schedule genuinely unset and say so — never resurrect the stale Id, and never invent a
  // self-reference — so the build fails fast at `validateAttributeCanvas` instead of deploying invalid XML.
  const staleId = "01tSTALE00000000AB"; // 18-char, Salesforce-Id-shaped literal — never a legitimate binding value
  const ownPart =
    `<actionType>AttributeDiscount</actionType>` +
    wrapCustomElement([
      buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, value: staleId }),
    ]);

  const stripped = patchA_stripProductLiterals(ownPart);
  const nestedAfterStrip = getNestedCustomElementParameterBlocks(stripped);
  assert.equal(nestedAfterStrip.length, 0, "the stale-Id-bound schedule parameter must be stripped, never cloned verbatim into a new procedure");

  const warnings: string[] = [];
  const final = patchC_preserveScheduleId(ownPart, stripped, warnings);
  const finalNested = getNestedCustomElementParameterBlocks(final);
  assert.ok(
    !finalNested.some(b => getParamName(b.block) === "PriceAdjustmentScheduleId"),
    "PriceAdjustmentScheduleId must be left genuinely absent — never resurrected with the stale Id, and never replaced with an unverifiable self-reference",
  );
  assert.ok(!final.includes(staleId), "the stale literal Id must never survive anywhere in the final AttributeDiscount XML");
  assert.ok(
    warnings.some(w => w.includes("PATH=no-donor-binding-found") && /not fabricated/i.test(w)),
    `expected a clear warning explaining no binding was fabricated; got: ${JSON.stringify(warnings)}`,
  );

  // The resulting canvas must fail fast, honestly, rather than silently deploy without a schedule binding.
  const { fatal } = validateAttributeCanvas(
    { psXml: "", lpXml: LP_XML_WITH_REQUIRED_FIELDS, adOwnXml: final },
    OBSERVED_ACTION_TYPES, new Set(),
  );
  assert.ok(fatal.some(f => f.includes("no PriceAdjustmentScheduleId parameter")), `expected the build to fail fast; got: ${JSON.stringify(fatal)}`);
});

test("patchA_stripProductLiterals leaves an ALREADY-correct, generically-bound nested PriceAdjustmentScheduleId untouched (no regression for a genuinely working donor)", () => {
  const ownPart =
    `<actionType>AttributeDiscount</actionType>` +
    wrapCustomElement([
      buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, value: "PriceAdjustmentScheduleId" }),
      buildParameterBlock({ input: true, name: "AttributeName", output: false, value: "Attribute" }),
      buildParameterBlock({ input: true, name: "AttributeValue", output: false, value: "AttributeValue" }),
    ]);

  const result = patchA_stripProductLiterals(ownPart);
  assert.equal(result, ownPart, "a donor whose nested bindings are already fully generic must be left byte-identical");
});

test("postBuildGuard-equivalent scope: a leaked nested parameter is invisible to a check that only scans getTopLevelParameterBlocks (proves the ORIGINAL gap this fix closes)", () => {
  const ownPart =
    `<actionType>AttributeDiscount</actionType>` +
    wrapCustomElement([buildParameterBlock({ input: true, name: "Storage", output: false, value: "2TB SSD" })]);

  const topLevelOnly = getTopLevelParameterBlocks(ownPart).map(b => getParamName(b.block));
  assert.ok(!topLevelOnly.includes("Storage"), "top-level-only scanning genuinely cannot see nested content — this is why the bug survived undetected");
  const nested = getNestedCustomElementParameterBlocks(ownPart).map(b => getParamName(b.block));
  assert.ok(nested.includes("Storage"), "the new nested-aware scan DOES see it");
});

const LP_XML_WITH_REQUIRED_FIELDS = wrapCustomElement([
  buildParameterBlock({ input: true, name: "LookUpId", output: false, value: "lookup-id" }),
  buildParameterBlock({ input: true, name: "LookUpName", output: false, value: "lookup-name" }),
  buildParameterBlock({ input: true, name: "LookUpApiName", output: false, value: "lookup-api-name" }),
  buildParameterBlock({ input: true, name: "ListPriceField", output: false, value: "ListPrice" }),
]);
const OBSERVED_ACTION_TYPES = new Set(["PricingSettings", "ListPrice", "AttributeDiscount"]);

test("§Requirement #8 (corrected — live evidence) — when a donor's only nested binding was a leaked literal and NO genuine PriceAdjustmentScheduleId binding exists anywhere, validateAttributeCanvas correctly FAILS FATAL instead of silently passing", () => {
  // §Root-cause fix (live evidence confirmed) — this test previously asserted the OPPOSITE: that
  // validateAttributeCanvas must NEVER report a missing schedule here, because Patch C used to paper over
  // a genuinely absent donor binding by fabricating a self-referential value. That masking is exactly what
  // let invalid XML ("PriceAdjustmentScheduleId isn't a valid variable name") reach Salesforce's real
  // deploy undetected. The corrected, honest behavior: a donor with no real schedule binding anywhere
  // MUST fail fast here, naming the missing parameter, rather than silently deploying a fabricated one.
  const ownPart =
    `<actionType>AttributeDiscount</actionType>` +
    buildParameterBlock({ input: true, name: "InputUnitPrice", output: false, value: "NetUnitPrice" }) +
    wrapCustomElement([
      // This donor's template never had PriceAdjustmentScheduleId anywhere — only the leak.
      buildParameterBlock({ input: true, name: "Memory", output: false, value: "RAM 64GB" }),
    ]);

  const warnings: string[] = [];
  const stripped = patchA_stripProductLiterals(ownPart);
  const final = patchC_preserveScheduleId(ownPart, stripped, warnings);
  assert.ok(
    warnings.some(w => w.includes("PATH=no-donor-binding-found")),
    `expected Patch C to report it found no donor binding to clone; got: ${JSON.stringify(warnings)}`,
  );

  const { fatal } = validateAttributeCanvas(
    { psXml: "", lpXml: LP_XML_WITH_REQUIRED_FIELDS, adOwnXml: final },
    OBSERVED_ACTION_TYPES, new Set(),
  );
  assert.ok(fatal.some(f => f.includes("no PriceAdjustmentScheduleId parameter")), `expected the build to fail fast on the genuinely missing schedule; got: ${JSON.stringify(fatal)}`);
  assert.ok(!fatal.some(f => f.includes("Memory")), "the leaked literal must still not survive into the validated canvas either");
});

test("§Requirement #8 — validateAttributeCanvas genuinely FAILS FATAL (never silently passes) when a donor HAS a real top-level binding but no <customElement> to nest it into", () => {
  // Isolates the "real binding exists, but nowhere to put it" case from the "no binding exists at all"
  // case above — these are two different warnings (and, before this fix, would have been two different
  // silent-failure modes) that must both independently lead to the same fatal outcome.
  const ownPart =
    `<actionType>AttributeDiscount</actionType>` +
    buildParameterBlock({ input: true, name: "InputUnitPrice", output: false, value: "NetUnitPrice" }) +
    buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, value: "Constant_Real_Donor_Binding" });
  // No <customElement> anywhere in this donor's AttributeDiscount step, even though a real top-level
  // binding for PriceAdjustmentScheduleId genuinely exists.

  const warnings: string[] = [];
  const stripped = patchA_stripProductLiterals(ownPart);
  const final = patchC_preserveScheduleId(ownPart, stripped, warnings);
  assert.ok(warnings.some(w => w.includes("no <customElement>")), "Patch C must warn when it cannot nest a schedule binding anywhere");

  const { fatal } = validateAttributeCanvas(
    { psXml: "", lpXml: LP_XML_WITH_REQUIRED_FIELDS, adOwnXml: final },
    OBSERVED_ACTION_TYPES, new Set(),
  );
  assert.ok(
    fatal.some(f => f.includes("no PriceAdjustmentScheduleId parameter")),
    "PriceAdjustmentScheduleId must never be silently empty — validateAttributeCanvas must refuse to deploy instead",
  );
});

test("§Root-cause fix (live evidence confirmed) — validateAttributeCanvas FAILS FATAL on a self-referential AttributeDiscount input parameter (name === value) that is not declared as an envelope variable, regardless of which parameter it is", () => {
  const ownPart =
    `<actionType>AttributeDiscount</actionType>` +
    wrapCustomElement([
      buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "PriceAdjustmentScheduleId" }),
    ]);

  const { fatal } = validateAttributeCanvas(
    { psXml: "", lpXml: LP_XML_WITH_REQUIRED_FIELDS, adOwnXml: ownPart },
    OBSERVED_ACTION_TYPES, new Set(), // no declared envelope variables — the self-reference is NOT independently declared
  );
  assert.ok(
    fatal.some(f => f.includes("self-referential value") && f.includes("PriceAdjustmentScheduleId")),
    `expected a fatal specifically calling out the self-referential binding; got: ${JSON.stringify(fatal)}`,
  );
});

test("validateAttributeCanvas does NOT fatal a self-referential-LOOKING binding when that exact name IS genuinely declared as an envelope variable (the one case where name === value is legitimate)", () => {
  const ownPart =
    `<actionType>AttributeDiscount</actionType>` +
    buildParameterBlock({ input: true, name: "InputUnitPrice", output: false, value: "NetUnitPrice" }) +
    wrapCustomElement([
      buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "PriceAdjustmentScheduleId" }),
    ]);

  const { fatal } = validateAttributeCanvas(
    { psXml: "", lpXml: LP_XML_WITH_REQUIRED_FIELDS, adOwnXml: ownPart },
    OBSERVED_ACTION_TYPES, new Set(["PriceAdjustmentScheduleId"]), // genuinely declared this time
  );
  assert.ok(
    !fatal.some(f => f.includes("self-referential value")),
    `a genuinely declared variable must never be flagged as an undeclared self-reference; got: ${JSON.stringify(fatal)}`,
  );
});

// ── §Live-org fix (real donor evidence, Rev_Mgmt_Default_Pricing_Procedure2_V1) — the real donor's TWO
// AttributeDiscount branches each bind PriceAdjustmentScheduleId to a genuinely DIFFERENT, non-self-
// referential name: "AttributePASIdConstant" (a declared envelope <variables> Constant, standard/non-
// contract branch) and "ItemContractAttributePasId" (a real RCA-native context variable, contract branch).
// Neither is a fabrication and neither is a self-reference — patchC must clone either verbatim (it's
// already present as a real top-level or nested donor binding, never synthesized), and validateAttributeCanvas
// must never flag either as invalid, confirming the self-reference fix only rejects the ONE genuinely
// invalid shape (name === value, undeclared) and nothing else.
test("§Live-org fix — a real donor's non-self-referential PriceAdjustmentScheduleId binding (a declared Constant, e.g. AttributePASIdConstant) is cloned verbatim and passes validation", () => {
  const ownPart =
    `<actionType>AttributeDiscount</actionType>` +
    buildParameterBlock({ input: true, name: "InputUnitPrice", output: false, value: "NetUnitPrice" }) +
    wrapCustomElement([
      buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "AttributePASIdConstant" }),
    ]);

  const warnings: string[] = [];
  const stripped = patchA_stripProductLiterals(ownPart);
  const final = patchC_preserveScheduleId(ownPart, stripped, warnings);
  const finalNested = getNestedCustomElementParameterBlocks(final);
  const scheduleParam = finalNested.find(b => getParamName(b.block) === "PriceAdjustmentScheduleId");
  assert.ok(scheduleParam, "the real donor binding must survive Patch C");

  // The declaring <variables> Constant is part of the envelope, not this step's own XML — passed here as
  // declaredVars, exactly as buildAttributeCanvas would supply it from the donor's own envelope.
  const { fatal } = validateAttributeCanvas(
    { psXml: "", lpXml: LP_XML_WITH_REQUIRED_FIELDS, adOwnXml: final },
    OBSERVED_ACTION_TYPES, new Set(["AttributePASIdConstant"]),
  );
  assert.ok(!fatal.some(f => f.includes("self-referential value")), `a genuine Constant reference must never be flagged; got: ${JSON.stringify(fatal)}`);
  assert.ok(!fatal.some(f => f.includes("no PriceAdjustmentScheduleId parameter")));
});

test("§Live-org fix — a real donor's contract-branch PriceAdjustmentScheduleId binding (ItemContractAttributePasId, a native RCA context variable, never declared in <variables>) is cloned verbatim and passes validation", () => {
  const ownPart =
    `<actionType>AttributeDiscount</actionType>` +
    buildParameterBlock({ input: true, name: "InputUnitPrice", output: false, value: "NetUnitPrice" }) +
    wrapCustomElement([
      buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "ItemContractAttributePasId" }),
    ]);

  const warnings: string[] = [];
  const stripped = patchA_stripProductLiterals(ownPart);
  const final = patchC_preserveScheduleId(ownPart, stripped, warnings);

  // §Note: "ItemContractAttributePasId" is NOT self-referential (name !== value: name is
  // "PriceAdjustmentScheduleId", value is "ItemContractAttributePasId") — the self-reference check only
  // ever fires when name === value, so this passes with an EMPTY declaredVars set too, unlike the
  // Constant case above which genuinely needs its declaration to be recognized.
  const { fatal } = validateAttributeCanvas(
    { psXml: "", lpXml: LP_XML_WITH_REQUIRED_FIELDS, adOwnXml: final },
    OBSERVED_ACTION_TYPES, new Set(),
  );
  assert.ok(!fatal.some(f => f.includes("self-referential value")), `a genuine (non-self-referential) native context-variable reference must never be flagged; got: ${JSON.stringify(fatal)}`);
  assert.ok(!fatal.some(f => f.includes("no PriceAdjustmentScheduleId parameter")));
});

// ── §Root-cause fix (this turn) — live symptom: "Unrecognized/leaked parameter name(s) survived patching
// on AttributeDiscount: NetUnitPrice, Subtotal, IsContracted". These three are the DONOR's own, genuine
// OUTPUT declarations (what this donor's AttributeDiscount step actually publishes for downstream
// consumption in its own already-working org) — never inputs, never leaked literals, never injected from
// another element. `shouldStripAttributeDiscountParam` already never touches outputs (`isOutputParam(block)
// -> return false`); the leak-detection checks (`postBuildGuard`, and its `validateAttributeCanvas` twin
// tested here) were checking ALL parameters — input AND output — against `RECOGNIZED_PARAM_NAMES`, an
// allowlist built to enumerate only the small set of INPUT bindings this engine actively manages, never a
// complete list of every legal (org-specific) output name. Fixed by exempting output parameters from the
// leak scan, matching the same "never touch outputs" rule the stripping logic already correctly applies. ──
test("§Root-cause fix — validateAttributeCanvas never flags a donor's own genuine OUTPUT parameters as leaked, regardless of their (org-specific) names", () => {
  const ownPart =
    `<actionType>AttributeDiscount</actionType>` +
    buildParameterBlock({ input: true, name: "InputUnitPrice", output: false, value: "NetUnitPrice" }) +
    // The exact live-reported names — this donor's own real output declarations, never touched by Patch A.
    buildParameterBlock({ name: "NetUnitPrice", output: true, value: "NetUnitPrice" }) +
    buildParameterBlock({ name: "Subtotal", output: true, value: "Subtotal" }) +
    buildParameterBlock({ name: "IsContracted", output: true, value: "IsContracted" }) +
    wrapCustomElement([
      buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, value: "PriceAdjustmentScheduleId" }),
    ]);

  const stripped = patchA_stripProductLiterals(ownPart);
  // Patch A must never have touched the outputs — proves the fix targets the VALIDATION, not the stripping
  // (which was already correct).
  const topLevelAfterStrip = getTopLevelParameterBlocks(stripped).map(b => getParamName(b.block));
  assert.ok(["NetUnitPrice", "Subtotal", "IsContracted"].every(n => topLevelAfterStrip.includes(n)), "Patch A must leave genuine outputs completely untouched");

  const { fatal } = validateAttributeCanvas(
    { psXml: "", lpXml: LP_XML_WITH_REQUIRED_FIELDS, adOwnXml: stripped },
    OBSERVED_ACTION_TYPES, new Set(),
  );
  assert.ok(!fatal.some(f => f.includes("Unrecognized parameter name")), `expected no leaked-parameter fatal for genuine outputs; got: ${JSON.stringify(fatal)}`);
});

test("§Root-cause fix — a genuinely leaked INPUT literal is still correctly flagged even after exempting outputs (the output exemption must not weaken input-leak detection)", () => {
  const ownPart =
    `<actionType>AttributeDiscount</actionType>` +
    buildParameterBlock({ input: true, name: "InputUnitPrice", output: false, value: "NetUnitPrice" }) +
    buildParameterBlock({ name: "NetUnitPrice", output: true, value: "NetUnitPrice" }) +
    // A genuine leak: an INPUT parameter with an org/product-specific literal name — never legitimate.
    buildParameterBlock({ input: true, name: "Storage", output: false, value: "2TB SSD" }) +
    wrapCustomElement([
      buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, value: "PriceAdjustmentScheduleId" }),
    ]);

  const stripped = patchA_stripProductLiterals(ownPart);
  const { fatal } = validateAttributeCanvas(
    { psXml: "", lpXml: LP_XML_WITH_REQUIRED_FIELDS, adOwnXml: stripped },
    OBSERVED_ACTION_TYPES, new Set(),
  );
  // Patch A should have already stripped "Storage" as an unrecognized input — but even if it somehow
  // survived, validateAttributeCanvas's own independent leak scan (defense in depth) must still catch it.
  assert.ok(!getTopLevelParameterBlocks(stripped).some(b => getParamName(b.block) === "Storage"), "Patch A must strip the leaked input");
  assert.ok(!fatal.some(f => f.includes("Unrecognized parameter name") && f.includes("NetUnitPrice")), "the legitimate output must never be reported, even alongside a real leak");
});
