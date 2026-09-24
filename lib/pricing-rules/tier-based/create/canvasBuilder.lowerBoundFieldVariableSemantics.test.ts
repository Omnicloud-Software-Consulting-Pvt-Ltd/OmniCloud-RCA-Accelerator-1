/**
 * §TBP-20260924-064323-C4D9 — "Specify a valid data type for the LowerBoundField variable." Live run for
 * Monitor_Tier_Based_Pricing_Procedure (donor: Keyboard_Tier_Based_Pricing_Procedure), AFTER the identity/
 * lifecycle fix (which is confirmed working and untouched here). Byte-for-byte parameter preservation
 * (canvasBuilder.lowerBoundField.test.ts) proves the `<parameters>` block itself survives unchanged — it
 * does NOT prove the `<variables>` declaration that parameter's value REFERENCES BY NAME also survives
 * under the same name with a valid data type. ROOT CAUSE: the envelope-wide identity regeneration
 * (`<name>`/`<label>`/`<description>`) had no protection for `<variables>` blocks living in that same
 * envelope region — exactly the class of bug attribute-based/create/canvasBuilder.ts already discovered
 * and fixed once before, never ported to Tier-Based/Volume-Based until now. These tests exercise the two
 * new exported functions (`auditFieldReferenceVariable`, `validateFieldReferenceVariableSemantics`)
 * directly, using synthetic fixtures modeled on the documented `<variables><name>...</name>...</variables>`
 * shape (no live donor XML for Keyboard_Tier_Based_Pricing_Procedure could be captured — no Salesforce
 * session is available in this environment).
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditFieldReferenceVariable, validateFieldReferenceVariableSemantics } from "./canvasBuilder";

function vtdStep(innerParams: string): string {
  return `<steps><name>VolumeTierDiscountStep</name><actionType>VolumeTierDiscount</actionType><parentStep>Root</parentStep>${innerParams}</steps>`;
}

const LOWER_BOUND_FIELD_VARIABLE_REF = `<parameters><input>true</input><name>LowerBoundField</name><output>false</output><type>Parameter</type><value>TierLowerBoundVar</value></parameters>`;
const UPPER_BOUND_FIELD_VARIABLE_REF = `<parameters><input>true</input><name>UpperBoundField</name><output>false</output><type>Parameter</type><value>TierUpperBoundVar</value></parameters>`;
const LOWER_BOUND_FIELD_LITERAL = `<parameters><input>true</input><name>LowerBoundField</name><output>false</output><type>Constant</type><value>Some_Field__c</value></parameters>`;

function variableDecl(name: string, dataType: string | null): string {
  return `<variables><name>${name}</name><dataType>${dataType ?? ""}</dataType><isInput>true</isInput></variables>`;
}

// A. Donor LowerBoundField semantic structure is understood.
test("Test A — donor LowerBoundField parameter and its referenced variable declaration are both correctly located", () => {
  const donorVtd = vtdStep(LOWER_BOUND_FIELD_VARIABLE_REF);
  const donorFile = `<ExpressionSetDefinition>${variableDecl("TierLowerBoundVar", "Double")}${donorVtd}</ExpressionSetDefinition>`;
  const audit = auditFieldReferenceVariable("LowerBoundField", donorVtd, donorVtd, donorFile, donorFile);
  assert.ok(audit.donorParamFragment?.includes("TierLowerBoundVar"));
  assert.equal(audit.referencedVariableName, "TierLowerBoundVar");
  assert.ok(audit.donorVariableFragment?.includes("<dataType>Double</dataType>"));
});

// B/C/D. Final cloned canvas contains a valid LowerBoundField; referenced variable exists in final canvas
// with a required data type.
test("Test B/C/D — variable preserved with a valid dataType in the final canvas -> passes", () => {
  const donorVtd = vtdStep(LOWER_BOUND_FIELD_VARIABLE_REF);
  const finalVtd = vtdStep(LOWER_BOUND_FIELD_VARIABLE_REF);
  const donorFile = `<ExpressionSetDefinition>${variableDecl("TierLowerBoundVar", "Double")}${donorVtd}</ExpressionSetDefinition>`;
  const finalFile = `<ExpressionSetDefinition>${variableDecl("TierLowerBoundVar", "Double")}${finalVtd}</ExpressionSetDefinition>`;
  const audit = auditFieldReferenceVariable("LowerBoundField", donorVtd, finalVtd, donorFile, finalFile);
  const result = validateFieldReferenceVariableSemantics(audit, "LOWER_BOUND_FIELD_INVALID_DATATYPE");
  assert.equal(result.fatal, null);
});

// E. LowerBoundField does not reference a donor-only variable/id — the exact reported bug: the variable
// declaration's own <name> got overwritten during envelope regeneration (the un-fixed behavior), leaving
// the parameter's reference dangling.
test("Test E — the exact reported bug reproduced: the referenced variable's declaration is MISSING from the final canvas (renamed/dropped during regeneration) -> fails closed with LOWER_BOUND_FIELD_INVALID_DATATYPE", () => {
  const donorVtd = vtdStep(LOWER_BOUND_FIELD_VARIABLE_REF);
  const finalVtd = vtdStep(LOWER_BOUND_FIELD_VARIABLE_REF); // the parameter's OWN reference is byte-preserved...
  const donorFile = `<ExpressionSetDefinition>${variableDecl("TierLowerBoundVar", "Double")}${donorVtd}</ExpressionSetDefinition>`;
  // ...but the variable's own declaration was renamed to the apiName during envelope identity regeneration
  // (unprotected <variables> block caught by the generic <name> replace) — simulating the pre-fix bug.
  const finalFile = `<ExpressionSetDefinition>${variableDecl("Monitor_Tier_Based_Pricing_Procedure", "Double")}${finalVtd}</ExpressionSetDefinition>`;
  const audit = auditFieldReferenceVariable("LowerBoundField", donorVtd, finalVtd, donorFile, finalFile);
  const result = validateFieldReferenceVariableSemantics(audit, "LOWER_BOUND_FIELD_INVALID_DATATYPE");
  assert.ok(result.fatal, "a dangling reference (variable renamed away) must fail closed, never silently deploy");
  assert.match(result.fatal!, /LOWER_BOUND_FIELD_INVALID_DATATYPE/);
  assert.match(result.fatal!, /no longer exists in the final composed canvas/);
});

test("Test E2 — referenced variable exists in the final canvas but its type/dataType-shaped field is empty -> fails closed", () => {
  const donorVtd = vtdStep(LOWER_BOUND_FIELD_VARIABLE_REF);
  const finalVtd = vtdStep(LOWER_BOUND_FIELD_VARIABLE_REF);
  const donorFile = `<ExpressionSetDefinition>${variableDecl("TierLowerBoundVar", "Double")}${donorVtd}</ExpressionSetDefinition>`;
  const finalFile = `<ExpressionSetDefinition>${variableDecl("TierLowerBoundVar", null)}${finalVtd}</ExpressionSetDefinition>`;
  const audit = auditFieldReferenceVariable("LowerBoundField", donorVtd, finalVtd, donorFile, finalFile);
  const result = validateFieldReferenceVariableSemantics(audit, "LOWER_BOUND_FIELD_INVALID_DATATYPE");
  assert.ok(result.fatal);
  assert.match(result.fatal!, /declares no type\/dataType-shaped field at all/);
});

test("Test E3 — the referenced variable's declaration changed between donor and final (corrupted, not merely renamed) -> fails closed", () => {
  const donorVtd = vtdStep(LOWER_BOUND_FIELD_VARIABLE_REF);
  const finalVtd = vtdStep(LOWER_BOUND_FIELD_VARIABLE_REF);
  const donorFile = `<ExpressionSetDefinition>${variableDecl("TierLowerBoundVar", "Double")}${donorVtd}</ExpressionSetDefinition>`;
  const finalFile = `<ExpressionSetDefinition>${variableDecl("TierLowerBoundVar", "Currency")}${finalVtd}</ExpressionSetDefinition>`;
  const audit = auditFieldReferenceVariable("LowerBoundField", donorVtd, finalVtd, donorFile, finalFile);
  const result = validateFieldReferenceVariableSemantics(audit, "LOWER_BOUND_FIELD_INVALID_DATATYPE");
  assert.ok(result.fatal, "this pipeline never intentionally edits a <variables> declaration — any change is corruption");
});

// F. UpperBoundField remains valid (mirrors the LowerBoundField cases with its own error code).
test("Test F — UpperBoundField: valid variable reference in both donor and final -> passes", () => {
  const donorVtd = vtdStep(UPPER_BOUND_FIELD_VARIABLE_REF);
  const finalVtd = vtdStep(UPPER_BOUND_FIELD_VARIABLE_REF);
  const donorFile = `<ExpressionSetDefinition>${variableDecl("TierUpperBoundVar", "Double")}${donorVtd}</ExpressionSetDefinition>`;
  const finalFile = `<ExpressionSetDefinition>${variableDecl("TierUpperBoundVar", "Double")}${finalVtd}</ExpressionSetDefinition>`;
  const audit = auditFieldReferenceVariable("UpperBoundField", donorVtd, finalVtd, donorFile, finalFile);
  const result = validateFieldReferenceVariableSemantics(audit, "UPPER_BOUND_FIELD_INVALID_DATATYPE");
  assert.equal(result.fatal, null);
});

test("Test F2 — UpperBoundField: dangling reference after regeneration -> fails closed with UPPER_BOUND_FIELD_INVALID_DATATYPE", () => {
  const donorVtd = vtdStep(UPPER_BOUND_FIELD_VARIABLE_REF);
  const finalVtd = vtdStep(UPPER_BOUND_FIELD_VARIABLE_REF);
  const donorFile = `<ExpressionSetDefinition>${variableDecl("TierUpperBoundVar", "Double")}${donorVtd}</ExpressionSetDefinition>`;
  const finalFile = `<ExpressionSetDefinition>${donorVtd}</ExpressionSetDefinition>`; // variable declaration entirely dropped
  const audit = auditFieldReferenceVariable("UpperBoundField", donorVtd, finalVtd, donorFile, finalFile);
  const result = validateFieldReferenceVariableSemantics(audit, "UPPER_BOUND_FIELD_INVALID_DATATYPE");
  assert.ok(result.fatal);
  assert.match(result.fatal!, /UPPER_BOUND_FIELD_INVALID_DATATYPE/);
});

// Not a variable reference at all (a literal field API name) — must never be treated as a dangling
// reference just because no <variables> declaration happens to share its literal value.
test("donor value is a plain literal (not a variable reference) -> not fatal, nothing to validate semantically", () => {
  const donorVtd = vtdStep(LOWER_BOUND_FIELD_LITERAL);
  const finalVtd = vtdStep(LOWER_BOUND_FIELD_LITERAL);
  const donorFile = `<ExpressionSetDefinition>${donorVtd}</ExpressionSetDefinition>`;
  const audit = auditFieldReferenceVariable("LowerBoundField", donorVtd, finalVtd, donorFile, donorFile);
  assert.equal(audit.referencedVariableName, null);
  const result = validateFieldReferenceVariableSemantics(audit, "LOWER_BOUND_FIELD_INVALID_DATATYPE");
  assert.equal(result.fatal, null);
});
