/**
 * §Active ExpressionSetVersion identity collision investigation (live error: "Active ExpressionSetVersion
 * identity collision", ExpressionSetVersion 9QMak000000t6nxGAA) — two fixes covered here:
 *
 * 1. `version-identity-unknown` now fails closed (requirement 5: "fail before deployment if identity
 *    resolution is ambiguous") — previously this decision always proceeded ("never blocks on an
 *    unverifiable comparison"), silently deploying with zero ability to prove no collision exists.
 *
 * 2. End-to-end reproduction of the ROOT CAUSE with a Tier-Based-shaped fixture: an existing ACTIVE V1
 *    plus a correctly version-suffixed candidate V2 (produced by `regenerateVersionedFullName`, tested in
 *    versionEnvelopeFields.fullNameSuffix.test.ts) must NOT collide — this is what makes "run the same
 *    Tier-Based procedure creation twice" produce a genuinely new version instead of failing.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { validateExpressionSetUniquenessAgainstOrg } from "./orgUniquenessValidation";
import { regenerateVersionedFullName } from "./versionEnvelopeFields";

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
          records: existingExpressionSetId ? [{ Id: existingExpressionSetId, ApiName: "Printer_Tier_Based_Pricing_Procedure", Name: "Printer Tier-Based Pricing Procedure" }] : [],
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

/** A mock client whose ExpressionSetVersion Describe exposes NONE of ApiName/DeveloperName/Name —
 * the exact degenerate shape that used to always proceed regardless of what actually exists. */
function buildMockClientWithNoIdentityFields(existingExpressionSetId: string): SalesforceClient {
  const client = {
    async describeObject(sobject: string) {
      if (sobject === "ExpressionSet") {
        return { name: "ExpressionSet", label: "", labelPlural: "", fields: [{ name: "Id", type: "id" }, { name: "ApiName", type: "string" }], recordTypeInfos: [], urls: {} };
      }
      if (sobject === "ExpressionSetVersion") {
        return { name: "ExpressionSetVersion", label: "", labelPlural: "", fields: [{ name: "Id", type: "id" }, { name: "ExpressionSetId", type: "reference" }], recordTypeInfos: [], urls: {} };
      }
      throw new Error(`unexpected describeObject(${sobject})`);
    },
    async query(soql: string) {
      if (soql.startsWith("SELECT") && soql.includes("FROM ExpressionSet WHERE")) {
        return { totalSize: 1, done: true, records: [{ Id: existingExpressionSetId, ApiName: "Printer_Tier_Based_Pricing_Procedure" }] };
      }
      if (soql.includes("FROM ExpressionSetVersion WHERE ExpressionSetId")) {
        return { totalSize: 0, done: true, records: [] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  };
  return client as unknown as SalesforceClient;
}

test("Test A — version-identity-unknown now FAILS CLOSED: an existing ExpressionSet with no comparable ExpressionSetVersion field must never proceed", async () => {
  const client = buildMockClientWithNoIdentityFields("es-1");
  const result = await validateExpressionSetUniquenessAgainstOrg(client, {
    apiName: "Printer_Tier_Based_Pricing_Procedure",
    generatedFullNames: ["Printer_Tier_Based_Pricing_Procedure_V2"],
    generatedLabel: null,
  });
  assert.equal(result.decision, "version-identity-unknown");
  assert.equal(result.ok, false, "an unverifiable identity must never be treated as an implicit pass");
  assert.ok(result.conflicts.some(c => c.identifier === "ExpressionSetVersion identity resolution ambiguous"));
});

test("Test B — no existing ExpressionSet at all: version-identity-unknown's new fail-closed behavior does not apply (there's nothing to be ambiguous about)", async () => {
  const client = buildMockClient(null, []);
  const result = await validateExpressionSetUniquenessAgainstOrg(client, {
    apiName: "Printer_Tier_Based_Pricing_Procedure",
    generatedFullNames: ["Printer_Tier_Based_Pricing_Procedure_V1"],
    generatedLabel: null,
  });
  assert.equal(result.decision, "create-new-expression-set");
  assert.equal(result.ok, true);
});

test("Test C — end-to-end root-cause reproduction: existing ACTIVE V1 (Tier-Based shape) + a correctly version-suffixed candidate V2 does NOT collide", async () => {
  const client = buildMockClient("es-1", [{ id: "9QMak000000t6nxGAA", versionNumber: 1, isActive: true, apiName: "Printer_Tier_Based_Pricing_Procedure_V1" }]);
  const candidateFullName = regenerateVersionedFullName("Printer_Tier_Based_Pricing_Procedure_V1", "Printer_Tier_Based_Pricing_Procedure", 2);
  const result = await validateExpressionSetUniquenessAgainstOrg(client, {
    apiName: "Printer_Tier_Based_Pricing_Procedure",
    generatedFullNames: [candidateFullName],
    generatedLabel: null,
  });
  assert.equal(result.decision, "create-new-version");
  assert.equal(result.ok, true, "the ACTIVE V1 must not block a genuinely new V2 from being created");
  assert.equal(result.conflicts.length, 0);
});

test("Test D — the EXACT pre-fix bug reproduced as a negative demonstration: an un-suffixed (bare) candidate identity DOES collide with the active V1", () => {
  // This models what the buggy `regenerate()` used to produce — the bare apiName with no version suffix
  // at all, byte-identical to every version's own fullName. Demonstrates why the fix was necessary.
  const buggyCandidateFullName = "Printer_Tier_Based_Pricing_Procedure"; // no suffix — the pre-fix shape
  return validateExpressionSetUniquenessAgainstOrg(
    buildMockClient("es-1", [{ id: "9QMak000000t6nxGAA", versionNumber: 1, isActive: true, apiName: "Printer_Tier_Based_Pricing_Procedure" }]),
    { apiName: "Printer_Tier_Based_Pricing_Procedure", generatedFullNames: [buggyCandidateFullName], generatedLabel: null },
  ).then(result => {
    assert.equal(result.ok, false, "reproduces the exact reported false-positive-turned-real collision this fix prevents by ensuring candidates are always version-suffixed");
    assert.ok(result.conflicts.some(c => c.identifier === "Active ExpressionSetVersion identity collision"));
  });
});
