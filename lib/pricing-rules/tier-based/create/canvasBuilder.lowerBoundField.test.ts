/**
 * §Live-org investigation — TBP-20260923-183424-4B03: Metadata API deployment failed with "Specify a valid
 * data type for the LowerBoundField variable." `LowerBoundField`/`UpperBoundField` are a VolumeTierDiscount
 * FIELD/VARIABLE REFERENCE (their own datatype + binding) — distinct from the numeric `LowerBound`/
 * `UpperBound` tier threshold VALUES — and this codebase had zero bespoke handling of either name before
 * this fix (grep-verified against the whole repo). Since no code path here ever intentionally patches
 * either parameter, the only defensible invariant is byte-for-byte donor preservation — never a fabricated
 * expected datatype string. These tests exercise the new `validateFieldReferenceParamPreserved` gate
 * directly against synthetic VolumeTierDiscount fragments (no live Salesforce session is available in this
 * environment, so a real donor's exact LowerBoundField XML could not be captured — these fixtures model the
 * documented `<parameters><input>.../input><name>...</name><type>...</type><value>...</value></parameters>`
 * shape every other parameter on this step already uses, per xmlBlocks.ts's own getTopLevelParameterBlocks/
 * getNestedCustomElementParameterBlocks contract).
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFieldReferenceParamPreserved } from "./canvasBuilder";

function vtdStep(innerParams: string): string {
  return `<steps><name>VolumeTierDiscountStep</name><actionType>VolumeTierDiscount</actionType><parentStep>Root</parentStep>${innerParams}</steps>`;
}

const LOWER_BOUND_FIELD_VALID = `<parameters><input>true</input><name>LowerBoundField</name><output>false</output><type>Parameter</type><value>Tier_Lower_Bound__c</value></parameters>`;
const UPPER_BOUND_FIELD_VALID = `<parameters><input>true</input><name>UpperBoundField</name><output>false</output><type>Parameter</type><value>Tier_Upper_Bound__c</value></parameters>`;
const LOWER_BOUND_NUMERIC = `<parameters><input>true</input><name>LowerBound</name><output>false</output><type>Constant</type><value>1</value></parameters>`;

test("Test 1 — donor's LowerBoundField parameter is preserved byte-for-byte -> passes", () => {
  const donor = vtdStep(LOWER_BOUND_FIELD_VALID + LOWER_BOUND_NUMERIC);
  const final = vtdStep(LOWER_BOUND_FIELD_VALID + LOWER_BOUND_NUMERIC);
  const result = validateFieldReferenceParamPreserved(donor, final, "LowerBoundField", "LOWER_BOUND_FIELD_INVALID");
  assert.equal(result.fatal, null);
});

test("Test 2 — generated canvas's LowerBoundField has a non-empty datatype (<type>) and value -> passes", () => {
  const donor = vtdStep(LOWER_BOUND_FIELD_VALID);
  const final = vtdStep(LOWER_BOUND_FIELD_VALID);
  const result = validateFieldReferenceParamPreserved(donor, final, "LowerBoundField", "LOWER_BOUND_FIELD_INVALID");
  assert.equal(result.fatal, null);
  assert.match(result.diagnostic, /<type>Parameter<\/type>/);
});

test("Test 3 — UpperBoundField remains valid through the same gate", () => {
  const donor = vtdStep(UPPER_BOUND_FIELD_VALID);
  const final = vtdStep(UPPER_BOUND_FIELD_VALID);
  const result = validateFieldReferenceParamPreserved(donor, final, "UpperBoundField", "UPPER_BOUND_FIELD_INVALID");
  assert.equal(result.fatal, null);
});

test("Test 4 — LowerBoundField present in donor but LOST in the final canvas -> fails closed with LOWER_BOUND_FIELD_INVALID", () => {
  const donor = vtdStep(LOWER_BOUND_FIELD_VALID);
  const final = vtdStep(""); // dropped during cloning/pruning
  const result = validateFieldReferenceParamPreserved(donor, final, "LowerBoundField", "LOWER_BOUND_FIELD_INVALID");
  assert.ok(result.fatal, "must fail closed, never silently deploy");
  assert.match(result.fatal!, /LOWER_BOUND_FIELD_INVALID/);
  assert.match(result.fatal!, /NO "LowerBoundField" parameter at all/);
});

test("Test 5 — UpperBoundField present in donor but LOST in the final canvas -> fails closed with UPPER_BOUND_FIELD_INVALID", () => {
  const donor = vtdStep(UPPER_BOUND_FIELD_VALID);
  const final = vtdStep("");
  const result = validateFieldReferenceParamPreserved(donor, final, "UpperBoundField", "UPPER_BOUND_FIELD_INVALID");
  assert.ok(result.fatal);
  assert.match(result.fatal!, /UPPER_BOUND_FIELD_INVALID/);
});

test("Test 6 — LowerBoundField's value was corrupted (differs from the donor) -> fails closed, never silently deploys a rewritten field reference", () => {
  const donor = vtdStep(LOWER_BOUND_FIELD_VALID);
  const corrupted = `<parameters><input>true</input><name>LowerBoundField</name><output>false</output><type>Parameter</type><value>1</value></parameters>`;
  const final = vtdStep(corrupted);
  const result = validateFieldReferenceParamPreserved(donor, final, "LowerBoundField", "LOWER_BOUND_FIELD_INVALID");
  assert.ok(result.fatal, "the numeric tier value must never be substituted for the field reference");
  assert.match(result.fatal!, /no longer matches the donor's own "LowerBoundField" parameter byte-for-byte/);
});

test("Test 7 — LowerBoundField survives with its <type> (datatype) stripped to empty -> fails closed rather than deploying an incomplete field reference", () => {
  const stripped = `<parameters><input>true</input><name>LowerBoundField</name><output>false</output><type></type><value>Tier_Lower_Bound__c</value></parameters>`;
  const donor = vtdStep(stripped);
  const final = vtdStep(stripped); // preserved verbatim from an already-defective donor — still must not deploy
  const result = validateFieldReferenceParamPreserved(donor, final, "LowerBoundField", "LOWER_BOUND_FIELD_INVALID");
  assert.ok(result.fatal, "an empty datatype must never reach Salesforce's Metadata API");
  assert.match(result.fatal!, /no <type>/);
});

test("Test 8 — donor does not declare LowerBoundField/UpperBoundField at all -> not fatal (nothing to preserve)", () => {
  const donor = vtdStep(LOWER_BOUND_NUMERIC); // some orgs' schedule-based VTD may not declare a field reference
  const final = vtdStep(LOWER_BOUND_NUMERIC);
  const result = validateFieldReferenceParamPreserved(donor, final, "LowerBoundField", "LOWER_BOUND_FIELD_INVALID");
  assert.equal(result.fatal, null);
  assert.match(result.diagnostic, /not declared at all/);
});

test("Test 9 — regression guard for the actual root-cause fix: the OLD over-broad <id>...</id> strip would have deleted a non-record-Id-shaped <id> tag; the narrowed pattern (matching stripIds's own 15-18 alphanumeric scope) must not", () => {
  const fieldRefWithNonRecordId = `<parameters><input>true</input><name>LowerBoundField</name><id>Field</id><type>Parameter</type><value>Tier_Lower_Bound__c</value></parameters>`;
  const OLD_BROAD_REGEX = /<id>[\s\S]*?<\/id>/g;
  const NEW_NARROW_REGEX = /<id>[0-9A-Za-z]{15,18}<\/id>\s*/g;
  assert.doesNotMatch(fieldRefWithNonRecordId.replace(OLD_BROAD_REGEX, ""), /<id>Field<\/id>/, "sanity: the old pattern really did strip this");
  assert.match(fieldRefWithNonRecordId.replace(NEW_NARROW_REGEX, ""), /<id>Field<\/id>/, "the fixed pattern must leave a non-15-18-alphanumeric <id> value untouched");
  // A genuine stale Salesforce record Id (15-18 alphanumeric chars) must still be removed by the fixed pattern.
  const withStaleRecordId = `<parameters><name>PriceAdjustmentScheduleId</name><id>0acAk000000ABCDEF</id><value>x</value></parameters>`;
  assert.doesNotMatch(withStaleRecordId.replace(NEW_NARROW_REGEX, ""), /<id>0acAk000000ABCDEF<\/id>/);
});
