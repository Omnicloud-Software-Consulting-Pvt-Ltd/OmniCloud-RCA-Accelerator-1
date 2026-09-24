/**
 * §TBP-20260923-210132-FAD5 — Part 4/8: regression coverage for the invalid-Salesforce-reference-Id
 * scanner. Test 8 from the requested list: "U#190f.3fffffff is rejected if it appears in a Salesforce
 * reference field." Test 9: "Final metadata contains no invalid ExpressionSetDefinitionVersion reference."
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanForInvalidSalesforceReferenceIds } from "./salesforceIdValidation";

test("Test 8 — the exact live-reported invalid Id ('U#190f.3fffffff') in a Salesforce reference field (*Id) is rejected", () => {
  const xml = `<versions><expressionSetDefinitionVersionId>U#190f.3fffffff</expressionSetDefinitionVersionId></versions>`;
  const result = scanForInvalidSalesforceReferenceIds(xml);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.value === "U#190f.3fffffff" && v.field === "expressionSetDefinitionVersionId"));
});

test("Test 9 — a real, valid 18-char Salesforce Id in a reference field passes", () => {
  const xml = `<parameters><name>LookUpId</name><value>9QMak000000t9XJGAY</value></parameters><LookUpId>9QMak000000t9XJGAY</LookUpId>`;
  const result = scanForInvalidSalesforceReferenceIds(xml);
  assert.equal(result.ok, true);
  assert.equal(result.violations.length, 0);
});

test("a real 15-char Salesforce Id (no 3-char extension) also passes", () => {
  const xml = `<id>9QMak000000t9XJ</id>`;
  const result = scanForInvalidSalesforceReferenceIds(xml);
  assert.equal(result.ok, true);
});

test("the known-safe runtime binding literal 'PriceAdjustmentSchedule' in a *Id field is never flagged", () => {
  const xml = `<parameters><name>PriceAdjustmentScheduleId</name><type>Parameter</type><value>PriceAdjustmentSchedule</value></parameters><PriceAdjustmentScheduleId>PriceAdjustmentSchedule</PriceAdjustmentScheduleId>`;
  const result = scanForInvalidSalesforceReferenceIds(xml);
  assert.equal(result.ok, true, "the deliberate runtime-context binding name must not be confused with a raw Id");
});

test("field-aware, not string-blind: a bare '#' or 'U#'-shaped value in a NON-Id field (e.g. a product name/label) is never flagged", () => {
  const xml = `<label>Model U#7 Special Edition</label><name>Product Name #1</name>`;
  const result = scanForInvalidSalesforceReferenceIds(xml);
  assert.equal(result.ok, true, "only *Id/id-named tags are ever inspected — never a blind global '#' search");
});

test("an empty *Id field is not flagged (nothing to validate, not an error)", () => {
  const xml = `<expressionSetId></expressionSetId>`;
  const result = scanForInvalidSalesforceReferenceIds(xml);
  assert.equal(result.ok, true);
});

test("reports the nearby <name> so the offending parameter/step can be identified", () => {
  const xml = `<parameters><name>SomeWeirdReference</name><expressionSetDefinitionVersionId>U#190f.3fffffff</expressionSetDefinitionVersionId></parameters>`;
  const result = scanForInvalidSalesforceReferenceIds(xml);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].nearbyName, "SomeWeirdReference");
});

test("multiple violations are all reported, not just the first", () => {
  const xml = `<expressionSetVersionId>U#111.aaa</expressionSetVersionId><someOtherId>U#222.bbb</someOtherId>`;
  const result = scanForInvalidSalesforceReferenceIds(xml);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 2);
});

test("reportText clearly states PASS or FAIL", () => {
  const pass = scanForInvalidSalesforceReferenceIds(`<id>9QMak000000t9XJGAY</id>`);
  assert.match(pass.reportText, /^Salesforce Reference Validation: PASS/);
  const fail = scanForInvalidSalesforceReferenceIds(`<expressionSetDefinitionVersionId>U#190f.3fffffff</expressionSetDefinitionVersionId>`);
  assert.match(fail.reportText, /^Salesforce Reference Validation: FAIL/);
});
