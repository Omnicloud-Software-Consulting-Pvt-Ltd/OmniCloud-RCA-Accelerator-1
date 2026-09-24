/**
 * §TBP-20260923-210132-FAD5 — Part 8 regression coverage for `resolveExpressionSetIdentityPlan`, the
 * single authoritative identity object (Part 5). Mirrors the exact live-reported scenario: an existing
 * "Keyboard_Tier_Based_Pricing_Procedure" ExpressionSet (Version 9QMak000000t9XJGAY), candidate resolution
 * correctly targeting V2.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { resolveExpressionSetIdentityPlan } from "./orgUniquenessValidation";

interface MockVersion { id: string; versionNumber: number; isActive: boolean; apiName: string }

function buildMockClient(existingExpressionSetId: string | null, versions: MockVersion[]): SalesforceClient {
  const client = {
    async describeObject(sobject: string) {
      if (sobject === "ExpressionSet") {
        return { name: "ExpressionSet", label: "", labelPlural: "", fields: [{ name: "Id", type: "id" }, { name: "ApiName", type: "string" }, { name: "Name", type: "string" }], recordTypeInfos: [], urls: {} };
      }
      if (sobject === "ExpressionSetVersion") {
        return {
          name: "ExpressionSetVersion", label: "", labelPlural: "",
          fields: [
            { name: "Id", type: "id" }, { name: "ApiName", type: "string" }, { name: "Name", type: "string" },
            { name: "ExpressionSetId", type: "reference" }, { name: "VersionNumber", type: "double" }, { name: "IsActive", type: "boolean" },
          ],
          recordTypeInfos: [], urls: {},
        };
      }
      throw new Error(`unexpected describeObject(${sobject})`);
    },
    async query(soql: string) {
      if (soql.startsWith("SELECT") && soql.includes("FROM ExpressionSet WHERE")) {
        return {
          totalSize: existingExpressionSetId ? 1 : 0, done: true,
          records: existingExpressionSetId ? [{ Id: existingExpressionSetId, ApiName: "Keyboard_Tier_Based_Pricing_Procedure", Name: "Keyboard Tier-Based Pricing Procedure" }] : [],
        };
      }
      if (soql.includes("FROM ExpressionSetVersion WHERE")) {
        return {
          totalSize: versions.length, done: true,
          records: versions.map(v => ({ Id: v.id, ExpressionSetId: existingExpressionSetId, ApiName: v.apiName, VersionNumber: v.versionNumber, IsActive: v.isActive })),
        };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  };
  return client as unknown as SalesforceClient;
}

const API_NAME = "Keyboard_Tier_Based_Pricing_Procedure";

test("Test 1 — no existing ExpressionSet -> CREATE_NEW_EXPRESSION_SET, Version 1, existingExpressionSetVersionId is null", async () => {
  const client = buildMockClient(null, []);
  const plan = await resolveExpressionSetIdentityPlan(client, API_NAME);
  assert.equal(plan.lifecycleAction, "CREATE_NEW_EXPRESSION_SET");
  assert.equal(plan.versionNumber, 1);
  assert.equal(plan.fullName, `${API_NAME}_V1`);
  assert.equal(plan.existingExpressionSetId, null);
  assert.equal(plan.existingExpressionSetVersionId, null);
});

test("Test 2/Case 3 — existing ACTIVE V1 (the exact live shape) -> CREATE_NEW_VERSION targeting V2, never touches V1", async () => {
  const client = buildMockClient("9QLak000004LSevGAG", [{ id: "9QMak000000t9XJGAY", versionNumber: 1, isActive: true, apiName: API_NAME }]);
  const plan = await resolveExpressionSetIdentityPlan(client, API_NAME);
  assert.equal(plan.lifecycleAction, "CREATE_NEW_VERSION");
  assert.equal(plan.versionNumber, 2);
  assert.equal(plan.fullName, `${API_NAME}_V2`, "the exact live-reported candidate identity");
  assert.equal(plan.existingExpressionSetId, "9QLak000004LSevGAG");
  assert.equal(plan.existingExpressionSetVersionId, null, "a Create operation never designates V1 as an update target, active or not");
});

test("Test 3/Case 4 — existing DRAFT V1 -> a Create operation still creates a new unique version, never auto-updates the draft", async () => {
  const client = buildMockClient("es-1", [{ id: "ev-1", versionNumber: 1, isActive: false, apiName: `${API_NAME}_V1` }]);
  const plan = await resolveExpressionSetIdentityPlan(client, API_NAME);
  assert.equal(plan.lifecycleAction, "CREATE_NEW_VERSION");
  assert.equal(plan.versionNumber, 2);
  assert.equal(plan.existingExpressionSetVersionId, null, "the draft is never designated as an update target for a Create operation");
});

test("Test 4/Case 5 — existing V1 + V2 -> choose V3, never colliding with either", async () => {
  const client = buildMockClient("es-1", [
    { id: "ev-1", versionNumber: 1, isActive: true, apiName: `${API_NAME}_V1` },
    { id: "ev-2", versionNumber: 2, isActive: false, apiName: `${API_NAME}_V2` },
  ]);
  const plan = await resolveExpressionSetIdentityPlan(client, API_NAME);
  assert.equal(plan.versionNumber, 3);
  assert.equal(plan.fullName, `${API_NAME}_V3`);
});

test("Test 6 — the plan never carries any existing record's Id forward as its OWN version identity — expressionSetVersionApiName/fullName are always freshly computed, never copied from an existing row", async () => {
  const client = buildMockClient("es-1", [{ id: "9QMak000000t9XJGAY", versionNumber: 1, isActive: true, apiName: API_NAME }]);
  const plan = await resolveExpressionSetIdentityPlan(client, API_NAME);
  assert.notEqual(plan.fullName, "9QMak000000t9XJGAY");
  assert.notEqual(plan.expressionSetVersionApiName, "9QMak000000t9XJGAY");
  assert.equal(plan.fullName, plan.expressionSetVersionApiName, "both names for the version's own identity must agree — one authoritative value, exposed under both keys");
});

test("expressionSetApiName is always the caller's own apiName, never a donor's or an existing record's value", async () => {
  const client = buildMockClient("es-1", [{ id: "ev-1", versionNumber: 1, isActive: true, apiName: API_NAME }]);
  const plan = await resolveExpressionSetIdentityPlan(client, API_NAME);
  assert.equal(plan.expressionSetApiName, API_NAME);
});

test("reason is human-readable and names the concrete lifecycle decision", async () => {
  const client = buildMockClient("9QLak000004LSevGAG", [{ id: "9QMak000000t9XJGAY", versionNumber: 1, isActive: true, apiName: API_NAME }]);
  const plan = await resolveExpressionSetIdentityPlan(client, API_NAME);
  assert.match(plan.reason, /Reusing existing ExpressionSet 9QLak000004LSevGAG/);
  assert.match(plan.reason, /Version 2/);
});
