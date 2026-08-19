/**
 * §Turn I / Part 18 — coverage for the ExpressionSet/ExpressionSetVersion Id-resolution strategy that
 * replaced the invalid `ExpressionSet.DeveloperName` SOQL query. Only the pure, client-independent
 * decision functions are tested here (no SalesforceClient mocking needed) — the retry/Describe I/O
 * wrapping them is exercised live, per this session's standing "never claim live-org success without
 * the user running it" rule.
 *
 * Uses Node's built-in test runner (`node:test`) — this repo has no test framework (no jest/vitest, no
 * `npm test` script) installed yet, so this file type-checks under `tsc --noEmit` but cannot be executed
 * as-is without a TypeScript-aware runner (e.g. `tsx --test` or `ts-node --test`). Flagged to the user
 * rather than silently added as a new dependency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickDeployComponentId, pickIdentityField, pickAllIdentityFieldCandidates, pickRelationshipField, pickStatusField, pickOrderField } from "./verifySalesforceState";
import { EXPRESSION_SET_METADATA_TYPE, type ComponentSuccess } from "./soapEnvelope";

function componentSuccess(overrides: Partial<ComponentSuccess>): ComponentSuccess {
  return { id: null, fullName: null, componentType: null, fileName: null, created: false, changed: false, ...overrides };
}

// Scenario A — Metadata deployment returns a component Id -> use that Id directly.
test("pickDeployComponentId returns the matching ExpressionSetDefinition component's Id", () => {
  const successes = [componentSuccess({ id: "9QANS000000Iakz4AC", fullName: "Laptop_Attribute_Based_Pricing_Procedure", componentType: EXPRESSION_SET_METADATA_TYPE })];
  const result = pickDeployComponentId(successes);
  assert.equal(result?.id, "9QANS000000Iakz4AC");
});

test("pickDeployComponentId falls back to the sole component when componentType is missing", () => {
  const successes = [componentSuccess({ id: "9QANS000000Iakz4AC", fullName: "Laptop_Attribute_Based_Pricing_Procedure", componentType: null })];
  const result = pickDeployComponentId(successes);
  assert.equal(result?.id, "9QANS000000Iakz4AC");
});

test("pickDeployComponentId returns null when no component carries an Id", () => {
  const successes = [componentSuccess({ id: null, componentType: EXPRESSION_SET_METADATA_TYPE })];
  assert.equal(pickDeployComponentId(successes), null);
});

test("pickDeployComponentId returns null for an empty/undefined deploy result", () => {
  assert.equal(pickDeployComponentId([]), null);
  assert.equal(pickDeployComponentId(undefined), null);
});

// Scenario B — ExpressionSet has no DeveloperName field -> no DeveloperName SOQL is generated
// (pickIdentityField must never return a field name Describe didn't actually report).
test("pickIdentityField never returns DeveloperName when it's absent from describe", () => {
  const field = pickIdentityField(["Id", "MasterLabel", "Name", "CreatedDate"]);
  assert.notEqual(field, "DeveloperName");
  assert.equal(field, "MasterLabel");
});

test("pickIdentityField prefers DeveloperName when describe actually confirms it exists", () => {
  assert.equal(pickIdentityField(["Id", "DeveloperName", "MasterLabel"]), "DeveloperName");
});

// Scenario C — Metadata response has no Id -> describe ExpressionSet and use only a confirmed field.
test("pickIdentityField falls back to any name/label-like field when none of the priority fields exist", () => {
  assert.equal(pickIdentityField(["Id", "SomeCustomApiIdentifier__c"]), null); // no name/label-like field either
  assert.equal(pickIdentityField(["Id", "PricingIdentifierName"]), "PricingIdentifierName");
});

test("pickIdentityField returns null when describe reports no usable identity field at all", () => {
  assert.equal(pickIdentityField(["Id", "CreatedDate", "LastModifiedDate"]), null);
});

// §Final Fix — the ExpressionSet resolver now tries EVERY plausible identity field, not just the first
// one, per the explicit "log every candidate" requirement after live evidence proved a single-field
// guess (and the earlier Metadata-deployment-Id guess) could both be wrong.
test("pickAllIdentityFieldCandidates returns every plausible field in priority order, not just one", () => {
  const candidates = pickAllIdentityFieldCandidates(["Id", "MasterLabel", "PricingIdentifierName", "DeveloperName", "CreatedDate"]);
  assert.deepEqual(candidates, ["DeveloperName", "MasterLabel", "PricingIdentifierName"]);
});

test("pickAllIdentityFieldCandidates returns an empty array when nothing plausible exists", () => {
  assert.deepEqual(pickAllIdentityFieldCandidates(["Id", "CreatedDate", "LastModifiedDate"]), []);
});

test("pickIdentityField is consistent with pickAllIdentityFieldCandidates's own first entry", () => {
  const fields = ["Id", "ApiName", "MasterLabel"];
  assert.equal(pickIdentityField(fields), pickAllIdentityFieldCandidates(fields)[0]);
});

// ExpressionSetVersion relationship/order/status field discovery — same "never hardcode" discipline.
test("pickRelationshipField prefers ExpressionSetId when describe confirms it", () => {
  assert.equal(pickRelationshipField(["Id", "ExpressionSetId", "Status"]), "ExpressionSetId");
});

test("pickRelationshipField falls back to any ExpressionSet*Id-shaped field when ExpressionSetId is absent", () => {
  assert.equal(pickRelationshipField(["Id", "ExpressionSetDefinitionId", "Status"]), "ExpressionSetDefinitionId");
});

test("pickRelationshipField returns null when no relationship field exists on this org", () => {
  assert.equal(pickRelationshipField(["Id", "Name", "Status"]), null);
});

test("pickStatusField discovers a status-like field without assuming the literal name 'Status'", () => {
  assert.equal(pickStatusField(["Id", "VersionState"]), "VersionState");
  assert.equal(pickStatusField(["Id", "Status"]), "Status");
  assert.equal(pickStatusField(["Id", "Name"]), null);
});

test("pickOrderField only returns a confirmed ordering field, never assumed", () => {
  assert.equal(pickOrderField(["Id", "CreatedDate"]), "CreatedDate");
  assert.equal(pickOrderField(["Id", "Name"]), null);
});
