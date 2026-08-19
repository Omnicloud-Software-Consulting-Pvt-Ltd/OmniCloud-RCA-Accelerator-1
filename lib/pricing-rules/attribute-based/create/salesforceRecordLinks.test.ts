/**
 * §"test navigation links use real record IDs" / §"test Metadata deployment ID can never be used as
 * ExpressionSet or ExpressionSetVersion ID" — coverage for `buildAttributePricingSalesforceRecords`, the
 * pure link-builder behind the "Salesforce Records" UI section.
 *
 * Same caveat as every other *.test.ts here: no test framework/runner is installed (no jest/vitest, no
 * `npm test` script); this file type-checks under `tsc --noEmit` but needs a TS-aware runner to execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAttributePricingSalesforceRecords } from "./salesforceRecordLinks";

const INSTANCE_URL = "https://example.my.salesforce.com";
const REAL_EXPRESSION_SET_ID = "9QLNS000003FXTN4A4";
const REAL_EXPRESSION_SET_VERSION_ID = "9QMNS000000awWv4AI";
const METADATA_DEPLOYMENT_COMPONENT_ID = "9QANS000000Iakz4AC"; // the Id proven live to be a DIFFERENT identity

test("navigation links are built from the real, verified ExpressionSet/ExpressionSetVersion Ids", () => {
  const records = buildAttributePricingSalesforceRecords(INSTANCE_URL, {
    expressionSetId: REAL_EXPRESSION_SET_ID,
    expressionSetApiName: "Laptop_Attribute_Based_Pricing_Procedure",
    expressionSetVersionId: REAL_EXPRESSION_SET_VERSION_ID,
    versionStatus: "Active",
  });

  const expressionSet = records.find(r => r.category === "expressionSet");
  const expressionSetVersion = records.find(r => r.category === "expressionSetVersion");
  const pricingProcedure = records.find(r => r.category === "pricingProcedure");

  assert.equal(expressionSet?.url, `${INSTANCE_URL}/lightning/r/ExpressionSet/${REAL_EXPRESSION_SET_ID}/view`);
  assert.equal(expressionSetVersion?.url, `${INSTANCE_URL}/lightning/r/ExpressionSetVersion/${REAL_EXPRESSION_SET_VERSION_ID}/view`);
  // Pricing Procedure legitimately reuses the SAME ExpressionSet Id — confirmed (not guessed) to be the
  // same underlying record via Describe in an earlier turn.
  assert.equal(pricingProcedure?.url, `${INSTANCE_URL}/lightning/r/ExpressionSet/${REAL_EXPRESSION_SET_ID}/view`);
});

test("the Metadata API deployment component's own Id can never appear in a navigation URL — there is no input field for it", () => {
  // §The input type itself has no `metadataDeploymentComponentId` property that any builder logic reads
  // — even if a caller mistakenly includes one alongside the real Ids (TS structural typing permits the
  // extra property on a pre-declared object, unlike an inline literal), it can never surface in a URL
  // since the implementation never looks at it.
  const maliciousInput = {
    expressionSetId: REAL_EXPRESSION_SET_ID,
    expressionSetVersionId: REAL_EXPRESSION_SET_VERSION_ID,
    metadataDeploymentComponentId: METADATA_DEPLOYMENT_COMPONENT_ID,
  };
  const records = buildAttributePricingSalesforceRecords(INSTANCE_URL, maliciousInput);
  for (const r of records) {
    assert.ok(!r.url || !r.url.includes(METADATA_DEPLOYMENT_COMPONENT_ID), `${r.category} URL must never contain the deployment component Id`);
    assert.ok(!r.id || r.id !== METADATA_DEPLOYMENT_COMPONENT_ID, `${r.category} id must never equal the deployment component Id`);
  }
});

test("Expression Set Version action label is 'Open & Activate' while Draft, 'Open in Salesforce' once Active", () => {
  const draft = buildAttributePricingSalesforceRecords(INSTANCE_URL, {
    expressionSetVersionId: REAL_EXPRESSION_SET_VERSION_ID, versionStatus: "Draft",
  }).find(r => r.category === "expressionSetVersion");
  assert.equal(draft?.actionLabel, "Open & Activate");
  assert.equal(draft?.status, "draft");

  const active = buildAttributePricingSalesforceRecords(INSTANCE_URL, {
    expressionSetVersionId: REAL_EXPRESSION_SET_VERSION_ID, versionStatus: "Active",
  }).find(r => r.category === "expressionSetVersion");
  assert.equal(active?.actionLabel, "Open in Salesforce");
  assert.equal(active?.status, "active");
});

test("a null instanceUrl (no connected session) produces link-less rows, never a broken/relative URL", () => {
  const records = buildAttributePricingSalesforceRecords(null, { expressionSetId: REAL_EXPRESSION_SET_ID });
  for (const r of records) assert.equal(r.url, null);
});

test("list-navigation categories (adjustments/conditions/rules) link to the object home page, not a fabricated record Id", () => {
  const records = buildAttributePricingSalesforceRecords(INSTANCE_URL, { ruleCount: 22, conditionCount: 5, adjustmentCount: 22 });
  const rules = records.find(r => r.category === "attributeBasedAdjRules");
  const conditions = records.find(r => r.category === "attributeAdjustmentConditions");
  const adjustments = records.find(r => r.category === "attributeBasedAdjustments");
  assert.equal(rules?.url, `${INSTANCE_URL}/lightning/o/AttributeBasedAdjRule/home`);
  assert.equal(conditions?.url, `${INSTANCE_URL}/lightning/o/AttributeAdjustmentCondition/home`);
  assert.equal(adjustments?.url, `${INSTANCE_URL}/lightning/o/AttributeBasedAdjustment/home`);
  assert.equal(rules?.count, 22);
  assert.equal(conditions?.count, 5);
  assert.equal(adjustments?.count, 22);
});
