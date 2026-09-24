/**
 * §Final Fix — coverage for the ONE authoritative ExpressionSetVersion resolver
 * (`resolveNextAvailableExpressionSetVersion`) that replaced two independent queries which could
 * disagree about what exists in the org. The exact live bug: a pre-canvas-build read (scoped by
 * `ExpressionSetId = <parent>`) reported only V1, while a SEPARATE post-build collision query (searching
 * directly by identity — ApiName/DeveloperName/Name) found an active V2 (real Id `9QMNS000000awWv4AI`)
 * under the SAME ExpressionSet.
 *
 * §Why a naive "recheck within the same query" can't work — a candidate computed as
 * `(highest version already IN a relationship-scoped query result) + 1` can, BY CONSTRUCTION, never
 * appear inside that SAME query's own results, no matter how many times it's re-run. The resolver must
 * cross-check the candidate with a GENUINELY INDEPENDENT identity search — this mock therefore models
 * TWO separate, independently-driven data sources: `relationshipScopedSnapshots` (what
 * `ExpressionSetVersion WHERE ExpressionSetId = ...` returns, consumed one snapshot per call, simulating
 * a relationship index that can lag behind reality) and `orgReality` (the full, always-current ground
 * truth, which is what the identity-based `WHERE ApiName = '<candidate>' OR ...` query searches against —
 * exactly like a direct, precise lookup would in a real org).
 *
 * Same caveat as every other *.test.ts in this directory: no test framework/runner is installed in this
 * repo (no jest/vitest, no `npm test` script) and none is added here — this file type-checks under
 * `tsc --noEmit` but needs a TypeScript-aware runner (e.g. `tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { resolveNextAvailableExpressionSetVersion } from "./orgUniquenessValidation";

interface MockVersion { id: string; versionNumber: number; isActive: boolean; apiName: string }

const ES_DESCRIBE = { name: "ExpressionSet", label: "", labelPlural: "", fields: [{ name: "Id", type: "id" }, { name: "ApiName", type: "string" }, { name: "Name", type: "string" }], recordTypeInfos: [], urls: {} };
const EV_DESCRIBE = {
  name: "ExpressionSetVersion", label: "", labelPlural: "",
  fields: [
    { name: "Id", type: "id" }, { name: "ApiName", type: "string" }, { name: "Name", type: "string" },
    { name: "ExpressionSetId", type: "reference" }, { name: "VersionNumber", type: "double" }, { name: "IsActive", type: "boolean" },
  ],
  recordTypeInfos: [], urls: {},
};

function toRecord(existingExpressionSetId: string | null, v: MockVersion) {
  return { Id: v.id, ExpressionSetId: existingExpressionSetId, ApiName: v.apiName, VersionNumber: v.versionNumber, IsActive: v.isActive };
}

/** Models TWO independent data sources — see file-level note. Deliberately has NO `updateRecord`/
 * `deleteRecord` methods at all — if the resolver ever tried to call either (violating "never
 * deactivate, never update an active version"), this mock would throw a plain "is not a function"
 * error, which the tests below treat as a hard failure by virtue of the call succeeding at all. */
function buildMockClient(
  existingExpressionSetId: string | null,
  relationshipScopedSnapshots: MockVersion[][],
  orgReality: MockVersion[],
): SalesforceClient {
  let relationshipCallIndex = 0;
  const client = {
    async describeObject(sobject: string) {
      if (sobject === "ExpressionSet") return ES_DESCRIBE;
      if (sobject === "ExpressionSetVersion") return EV_DESCRIBE;
      throw new Error(`unexpected describeObject(${sobject})`);
    },
    async query(soql: string) {
      if (soql.includes("FROM ExpressionSet WHERE")) {
        return { totalSize: existingExpressionSetId ? 1 : 0, done: true, records: existingExpressionSetId ? [{ Id: existingExpressionSetId, ApiName: "Laptop_Attribute_Based_Pricing_Procedure", Name: "Laptop Attribute-Based Pricing Procedure" }] : [] };
      }
      if (soql.includes("FROM ExpressionSetVersion WHERE ExpressionSetId")) {
        const snapshot = relationshipScopedSnapshots[Math.min(relationshipCallIndex, relationshipScopedSnapshots.length - 1)];
        relationshipCallIndex++;
        return { totalSize: snapshot.length, done: true, records: snapshot.map(v => toRecord(existingExpressionSetId, v)) };
      }
      if (soql.includes("FROM ExpressionSetVersion WHERE")) {
        // §The genuinely independent identity search — always searches the full ground truth, never the
        // (possibly-lagging) relationship-scoped snapshot queue.
        const match = orgReality.find(v => soql.includes(`'${v.apiName}'`));
        return { totalSize: match ? 1 : 0, done: true, records: match ? [toRecord(existingExpressionSetId, match)] : [] };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  };
  return client as unknown as SalesforceClient;
}

// TEST 1 — only V1 exists (both sources agree) → generates V2.
test("TEST 1 — only V1 exists: resolves to V2 in a single attempt", async () => {
  const v1 = { id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" };
  const client = buildMockClient("es-1", [[v1]], [v1]);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.versionNumber, 2);
  assert.equal(result.identity, "Laptop_Attribute_Based_Pricing_Procedure_V2");
  assert.equal(result.attempts.length, 1, "no refresh should be needed when both sources already agree");
});

// TEST 2/3/4 — V1 + V2 (any combination of active/draft, both sources agree) → generates V3.
for (const [label, v2Active] of [["active", true], ["draft", false]] as const) {
  test(`TEST — V1 + V2 (${label}) exists: resolves to V3`, async () => {
    const v1 = { id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" };
    const v2 = { id: "ev-2", versionNumber: 2, isActive: v2Active, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V2" };
    const client = buildMockClient("es-1", [[v1, v2]], [v1, v2]);
    const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
    assert.equal(result.versionNumber, 3);
  });
}

// TEST 5 — THE EXACT LIVE BUG: the relationship-scoped query reports only V1, but the org's real ground
// truth (searched via the independent identity check) already has an active V2 with the real reported Id
// `9QMNS000000awWv4AI`. The resolver must advance to V3, never stop at the already-taken V2, and never
// touch V2 at all.
test("TEST 5 — relationship-scoped query misses V2 (real Id 9QMNS000000awWv4AI) but the independent identity check finds it: resolves to V3, never touches V2", async () => {
  const v1 = { id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" };
  const v2 = { id: "9QMNS000000awWv4AI", versionNumber: 2, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V2" };
  // Relationship-scoped source NEVER catches up (models a structural, not just timing, discrepancy) —
  // every call to it still reports only V1, so the fix MUST come from the independent identity check.
  const client = buildMockClient("es-1", [[v1]], [v1, v2]);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.versionNumber, 3, "must advance past the newly-discovered V2, never stop at the already-taken V2");
  assert.equal(result.identity, "Laptop_Attribute_Based_Pricing_Procedure_V3");
  assert.equal(result.attempts.length, 2, "exactly one refresh should have been needed");
  assert.equal(result.attempts[0].candidateIdentity, "Laptop_Attribute_Based_Pricing_Procedure_V2");
  assert.ok(result.attempts[0].collidesWith, "the first attempt's candidate (V2) must be reported as colliding with the real record it turned out to already be");
  assert.equal(result.attempts[0].collidesWith?.id, "9QMNS000000awWv4AI");
});

// TEST 6 — the resolver must never call updateRecord/deleteRecord (the mock client has neither method at
// all) — reaching a successful result at all proves this never happened, since any such call would throw.
test("TEST 6 — never updates or deactivates the existing active version (mock client exposes no update/delete method)", async () => {
  const v1 = { id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" };
  const v2 = { id: "9QMNS000000awWv4AI", versionNumber: 2, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V2" };
  const client = buildMockClient("es-1", [[v1]], [v1, v2]);
  await assert.doesNotReject(() => resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure"));
});

// TEST 7 — candidate identity is unused on the first check: resolution succeeds immediately, no refresh
// attempt is wasted.
test("TEST 7 — candidate identity is unused: resolves in exactly one attempt", async () => {
  const client = buildMockClient(null, [[]], []);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.versionNumber, 1);
  assert.equal(result.attempts.length, 1);
});

// TEST 8 — candidate already exists (per the independent check): blocked until a genuinely next, unused
// version is computed — never settles for the version already proven taken.
test("TEST 8 — candidate already exists: blocked until a genuinely next, unused version is computed", async () => {
  const v1 = { id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" };
  const v2 = { id: "ev-2", versionNumber: 2, isActive: false, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V2" };
  const client = buildMockClient("es-1", [[v1]], [v1, v2]);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.notEqual(result.versionNumber, 2, "must never settle on the version that was proven to already exist");
  assert.equal(result.versionNumber, 3);
});

// TEST 9 — a gap in existing version numbers (V1, V3 — no V2), both sources agree → resolves to V4,
// never fills the gap.
test("TEST 9 — existing V1 and V3 (gap at V2): resolves to V4, never fills the gap", async () => {
  const v1 = { id: "ev-1", versionNumber: 1, isActive: false, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" };
  const v3 = { id: "ev-3", versionNumber: 3, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V3" };
  const client = buildMockClient("es-1", [[v1, v3]], [v1, v3]);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.versionNumber, 4);
});

// TEST 10 — the exact live conflicting Id must be correctly classified (Active, VersionNumber=2, the
// real ApiName) once discovered, and the attempt history explains why the relationship-scoped query
// omitted it (it simply never appears in that source in this scenario) rather than silently disappearing
// the discrepancy.
test("TEST 10 — the exact live conflicting Id 9QMNS000000awWv4AI is correctly classified once discovered", async () => {
  const v1 = { id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" };
  const v2 = { id: "9QMNS000000awWv4AI", versionNumber: 2, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V2" };
  const client = buildMockClient("es-1", [[v1]], [v1, v2]);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  const conflictingRecord = result.attempts[0].collidesWith;
  assert.ok(conflictingRecord, "the independent identity check must surface the exact live conflicting record");
  assert.equal(conflictingRecord?.id, "9QMNS000000awWv4AI");
  assert.equal(conflictingRecord?.apiName, "Laptop_Attribute_Based_Pricing_Procedure_V2");
  assert.equal(conflictingRecord?.versionNumber, 2);
  assert.equal(conflictingRecord?.isActive, true);
  // The relationship-scoped inventory attached to that same attempt is the actual explanation for "why
  // did the earlier read not return this record": it genuinely never appears in that source in this
  // scenario, full stop — the independent identity check is what reconciled the two.
  assert.equal(result.attempts[0].inventory.versions.some(v => v.id === "9QMNS000000awWv4AI"), false);
});
