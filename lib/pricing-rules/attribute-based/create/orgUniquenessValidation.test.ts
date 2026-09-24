/**
 * §Final Fix — coverage for the version-lifecycle root-cause fix: `ExpressionSet`/`ExpressionSetVersion`
 * do NOT have a `DeveloperName` field at all (confirmed via Salesforce's own documented SObject
 * reference — the real, unique identity field is `ApiName`). The prior code checked ONLY
 * `DeveloperName`, which Describe correctly reported absent on every real org, so the existing-
 * ExpressionSet lookup was silently skipped on every run — `resolveNextExpressionSetVersionNumber`
 * always returned `nextVersionNumber: 1` regardless of what actually existed, which is exactly the live
 * bug: a repeated build kept regenerating V1's own identity and colliding with the already-active version.
 *
 * A minimal, duck-typed mock `SalesforceClient` is used here (only `describeObject`/`query`/`logDebug`
 * are ever called by the functions under test) — no live org access, no new test framework/dependency.
 *
 * Same caveat as every other *.test.ts in this directory: no test framework/runner is installed in this
 * repo (no jest/vitest, no `npm test` script) and none is added here — this file type-checks under
 * `tsc --noEmit` but needs a TypeScript-aware runner (e.g. `tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { resolveNextExpressionSetVersionNumber, resolveNextAvailableExpressionSetVersion, validateExpressionSetUniquenessAgainstOrg } from "./orgUniquenessValidation";

interface MockVersion {
  id: string;
  versionNumber: number;
  isActive: boolean;
  apiName: string;
}

/** Builds a mock client whose ExpressionSet/ExpressionSetVersion Describe reports the REAL, documented
 * field shape (ApiName + Name on ExpressionSet; ApiName + Name + ExpressionSetId + VersionNumber +
 * IsActive on ExpressionSetVersion — no DeveloperName/MasterLabel on either, matching the confirmed real
 * schema) — never the field set the ORIGINAL buggy code assumed. */
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
          records: existingExpressionSetId ? [{ Id: existingExpressionSetId, ApiName: "Laptop_Attribute_Based_Pricing_Procedure", Name: "Laptop Attribute-Based Pricing Procedure" }] : [],
        };
      }
      if (soql.includes("FROM ExpressionSetVersion WHERE ExpressionSetId")) {
        return {
          totalSize: versions.length, done: true,
          records: versions.map(v => ({ Id: v.id, ExpressionSetId: existingExpressionSetId, ApiName: v.apiName, VersionNumber: v.versionNumber, IsActive: v.isActive })),
        };
      }
      if (soql.includes("FROM ExpressionSetVersion WHERE")) {
        // The uniqueness-check's own IN-list query, used by validateExpressionSetUniquenessAgainstOrg.
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

// TEST 1 — no existing procedure at all → generates V1.
test("TEST 1 — no existing procedure: resolveNextExpressionSetVersionNumber returns nextVersionNumber=1", async () => {
  const client = buildMockClient(null, []);
  const result = await resolveNextExpressionSetVersionNumber(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.existingExpressionSetId, null);
  assert.equal(result.nextVersionNumber, 1);
});

// TEST 2 — existing V1 Active → generates V2.
test("TEST 2 — existing V1 active: resolveNextExpressionSetVersionNumber returns nextVersionNumber=2", async () => {
  const client = buildMockClient("es-1", [{ id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" }]);
  const result = await resolveNextExpressionSetVersionNumber(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.existingExpressionSetId, "es-1");
  assert.equal(result.nextVersionNumber, 2);
});

// TEST 3 — existing V1 active + V2 draft → generates V3.
test("TEST 3 — existing V1 active + V2 draft: resolveNextExpressionSetVersionNumber returns nextVersionNumber=3", async () => {
  const client = buildMockClient("es-1", [
    { id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" },
    { id: "ev-2", versionNumber: 2, isActive: false, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V2" },
  ]);
  const result = await resolveNextExpressionSetVersionNumber(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.nextVersionNumber, 3);
});

// TEST 4 — existing V1 + V2 + V3 → generates V4.
test("TEST 4 — existing V1 + V2 + V3: resolveNextExpressionSetVersionNumber returns nextVersionNumber=4", async () => {
  const client = buildMockClient("es-1", [
    { id: "ev-1", versionNumber: 1, isActive: false, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" },
    { id: "ev-2", versionNumber: 2, isActive: false, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V2" },
    { id: "ev-3", versionNumber: 3, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V3" },
  ]);
  const result = await resolveNextExpressionSetVersionNumber(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.nextVersionNumber, 4);
});

// TEST 5 — the exact live bug: an org whose ExpressionSet/ExpressionSetVersion schema has NO
// DeveloperName field at all (only ApiName/Name — the real, documented shape) must still correctly
// discover the existing procedure via ApiName, never falling back to "no existing ExpressionSet found"
// merely because a DeveloperName-based lookup would have failed.
test("TEST 5 — no DeveloperName field on this org (only ApiName): existing procedure is still discovered, never defaults to V1", async () => {
  const client = buildMockClient("es-1", [{ id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" }]);
  const result = await resolveNextExpressionSetVersionNumber(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.notEqual(result.existingExpressionSetId, null, "must discover the existing ExpressionSet via ApiName even though DeveloperName does not exist on this org");
  assert.notEqual(result.nextVersionNumber, 1, "must NOT incorrectly conclude V1 when an existing active version was actually found");
  assert.equal(result.nextVersionNumber, 2);
});

// TEST 6 — the generated identity collides with an ACTIVE ExpressionSetVersion: the deployment safety
// gate (via `conflicts`/`ok`) must prevent the update, never silently proceed.
test("TEST 6 — generated identity matches an ACTIVE existing version: uniqueness check reports a conflict (safety gate blocks deploy)", async () => {
  const client = buildMockClient("es-1", [{ id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" }]);
  const result = await validateExpressionSetUniquenessAgainstOrg(client, {
    apiName: "Laptop_Attribute_Based_Pricing_Procedure",
    generatedFullNames: ["Laptop_Attribute_Based_Pricing_Procedure_V1"],
    generatedLabel: null,
  });
  assert.equal(result.decision, "update-existing-version");
  assert.equal(result.ok, false, "an active-version collision must make the pre-flight check fail (never a silent update)");
  assert.ok(result.conflicts.some(c => c.identifier === "Active ExpressionSetVersion identity collision"));
});

// TEST 7 (companion) — the SAME scenario but targeting the FRESH V2 identity (as a correctly-resolved
// nextVersionNumber would produce) must NOT be flagged as a conflict — this is what makes "run the same
// prompt twice" produce a genuinely new version instead of failing against the active V1.
test("TEST 7 — a freshly-resolved V2 identity does not collide with the existing active V1", async () => {
  const client = buildMockClient("es-1", [{ id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" }]);
  const result = await validateExpressionSetUniquenessAgainstOrg(client, {
    apiName: "Laptop_Attribute_Based_Pricing_Procedure",
    generatedFullNames: ["Laptop_Attribute_Based_Pricing_Procedure_V2"],
    generatedLabel: null,
  });
  assert.equal(result.decision, "create-new-version");
  assert.equal(result.ok, true);
});

// §Final Fix — the FALSE V1/V2 collision. Root cause: `createPipeline.ts` used to build
// `generatedFullNames` from BOTH the `fullName` tag (the real, version-suffixed per-version identity)
// AND the `expressionSetDefinition` tag (the version's back-reference to its PARENT
// ExpressionSetDefinition — regenerated as the bare, UNSUFFIXED apiName by design, since it must stay
// identical across every version). V1 (created before a version suffix was ever added to `fullName`)
// genuinely has that bare, unsuffixed string as its OWN real identity — so including the parent
// reference in the collision search always matched V1, regardless of which version was actually being
// generated. The fix removed `expressionSetDefinition` from that filter entirely; `validateExpressionSetUniquenessAgainstOrg`
// itself was never the bug — it correctly compares whatever it's given, so these tests exercise it
// directly with both the CORRECT input (post-fix) and the INCORRECT one (pre-fix) side by side.

// TEST — the exact live reproduction: existing V1 (the real reported Id `9QMNS000000awWv4AI`, Active),
// candidate V2, using the CORRECT (post-fix) `generatedFullNames` — must NOT collide.
test("TEST — the exact live record (Id=9QMNS000000awWv4AI, V1, Active) does not collide with candidate V2 when generatedFullNames is correctly scoped to fullName only", async () => {
  const client = buildMockClient("es-1", [{ id: "9QMNS000000awWv4AI", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" }]);
  const result = await validateExpressionSetUniquenessAgainstOrg(client, {
    apiName: "Laptop_Attribute_Based_Pricing_Procedure",
    generatedFullNames: ["Laptop_Attribute_Based_Pricing_Procedure_V2"], // fullName ONLY — never the bare expressionSetDefinition reference
    generatedLabel: null,
  });
  assert.equal(result.ok, true, "V1 being active must not block V2 from being created");
  assert.equal(result.decision, "create-new-version");
  assert.equal(result.conflicts.length, 0);
});

// TEST — demonstrates the BUG directly: if `generatedFullNames` incorrectly ALSO includes the bare,
// unsuffixed apiName (exactly what the old `expressionSetDefinition`-inclusive filter produced) — and V1
// genuinely has that bare string as its own real identity (the historically-accurate case: V1 was
// created before the fullName-suffix fix existed) — a false collision against V1 results. This is kept
// as a NEGATIVE demonstration (documenting why the old behavior was wrong), not as evidence the current
// code does this — `createPipeline.ts` no longer constructs `generatedFullNames` this way.
test("TEST — demonstrates the bug: including the bare unsuffixed apiName alongside the real candidate falsely collides with V1", async () => {
  const client = buildMockClient("es-1", [{ id: "9QMNS000000awWv4AI", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure" }]);
  const result = await validateExpressionSetUniquenessAgainstOrg(client, {
    apiName: "Laptop_Attribute_Based_Pricing_Procedure",
    generatedFullNames: ["Laptop_Attribute_Based_Pricing_Procedure_V2", "Laptop_Attribute_Based_Pricing_Procedure"], // the OLD, buggy construction
    generatedLabel: null,
  });
  assert.equal(result.ok, false, "this reproduces the exact reported false collision — proof of what the fix prevents");
  assert.equal(result.matchedVersionId, "9QMNS000000awWv4AI");
});

// TEST — Existing V1 Active + V2 Active, candidate genuinely targets V2 (e.g. version resolution did not
// run correctly this time): this IS a real collision — V2 itself is active — and must be reported as one,
// never silently overwritten.
test("TEST — existing V1 Active + V2 Active, candidate V2: real collision, must not overwrite", async () => {
  const client = buildMockClient("es-1", [
    { id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" },
    { id: "ev-2", versionNumber: 2, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V2" },
  ]);
  const result = await validateExpressionSetUniquenessAgainstOrg(client, {
    apiName: "Laptop_Attribute_Based_Pricing_Procedure",
    generatedFullNames: ["Laptop_Attribute_Based_Pricing_Procedure_V2"],
    generatedLabel: null,
  });
  assert.equal(result.ok, false, "V2 itself being active is a genuine collision, unlike V1 being active while targeting V2");
  assert.equal(result.matchedVersionId, "ev-2");
});

// TEST — Existing V1 Active + V2 Draft, candidate genuinely targets V2 (a legitimate "update this draft
// in place" scenario, distinct from an active-version hard block): decision is update-existing-version,
// but `ok` stays true since V2 itself is Draft, not Active.
test("TEST — existing V1 Active + V2 Draft, candidate V2: detected as an update-in-place, not a hard block", async () => {
  const client = buildMockClient("es-1", [
    { id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" },
    { id: "ev-2", versionNumber: 2, isActive: false, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V2" },
  ]);
  const result = await validateExpressionSetUniquenessAgainstOrg(client, {
    apiName: "Laptop_Attribute_Based_Pricing_Procedure",
    generatedFullNames: ["Laptop_Attribute_Based_Pricing_Procedure_V2"],
    generatedLabel: null,
  });
  assert.equal(result.decision, "update-existing-version");
  assert.equal(result.ok, true, "updating an existing DRAFT version is not the same failure mode as colliding with an ACTIVE one");
});

/**
 * §Part 1/14 — Rank regression tests. `Rank` is a REAL, documented field on the
 * `ExpressionSetDefinitionVersion` metadata type (Metadata API Developer Guide, v62.0+) that Salesforce
 * enforces as unique per-ExpressionSet at deploy time — omitting or reusing a value produces "Assign a
 * unique rank to expression set version ... and try again.", the exact live failure this fixes.
 * `resolveNextAvailableExpressionSetVersion` now resolves BOTH the next version number AND the lowest
 * unused positive-integer Rank from the SAME authoritative inventory read, never a separate guess.
 * A dedicated mock builder is used here (rather than extending `buildMockClient` above) so every
 * pre-existing test above — none of which mocks a `Rank` field — continues to exercise the
 * `rankFieldExists === false` path exactly as before (an org that genuinely has no Rank field must never
 * have one invented for it).
 */
interface MockVersionWithRank extends MockVersion {
  rank: number | null;
}

function buildMockClientWithRank(existingExpressionSetId: string | null, versions: MockVersionWithRank[]): SalesforceClient {
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
            { name: "Rank", type: "double" },
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
          records: existingExpressionSetId ? [{ Id: existingExpressionSetId, ApiName: "Laptop_Attribute_Based_Pricing_Procedure", Name: "Laptop Attribute-Based Pricing Procedure" }] : [],
        };
      }
      if (soql.includes("FROM ExpressionSetVersion")) {
        return {
          totalSize: versions.length, done: true,
          records: versions.map(v => ({ Id: v.id, ExpressionSetId: existingExpressionSetId, ApiName: v.apiName, VersionNumber: v.versionNumber, IsActive: v.isActive, Rank: v.rank })),
        };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  };
  return client as unknown as SalesforceClient;
}

// Part 14 TEST 1 — existing Rank {1} -> lowest unused is 2.
test("TEST — Rank: existing rank {1} resolves candidate Rank 2", async () => {
  const client = buildMockClientWithRank("es-1", [{ id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1", rank: 1 }]);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.rankFieldExists, true);
  assert.equal(result.rank, 2);
  assert.equal(result.versionNumber, 2);
});

// Part 14 TEST 2 — existing ranks {1,2,3} -> lowest unused is 4 (no gap exists below it).
test("TEST — Rank: existing ranks {1,2,3} resolve candidate Rank 4", async () => {
  const client = buildMockClientWithRank("es-1", [
    { id: "ev-1", versionNumber: 1, isActive: false, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1", rank: 1 },
    { id: "ev-2", versionNumber: 2, isActive: false, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V2", rank: 2 },
    { id: "ev-3", versionNumber: 3, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V3", rank: 3 },
  ]);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.rank, 4);
});

// Part 14 TEST 3 — existing ranks {1,3} -> lowest unused is 2, NOT max(existingRanks)+1 (=4).
test("TEST — Rank: existing ranks {1,3} resolve candidate Rank 2 (the gap, not max+1)", async () => {
  const client = buildMockClientWithRank("es-1", [
    { id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1", rank: 1 },
    { id: "ev-2", versionNumber: 2, isActive: false, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V2", rank: 3 },
  ]);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.rank, 2);
});

// Part 14 TEST 4 — existing ranks {1,2,4} -> lowest unused is 3 (the gap).
test("TEST — Rank: existing ranks {1,2,4} resolve candidate Rank 3", async () => {
  const client = buildMockClientWithRank("es-1", [
    { id: "ev-1", versionNumber: 1, isActive: false, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1", rank: 1 },
    { id: "ev-2", versionNumber: 2, isActive: false, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V2", rank: 2 },
    { id: "ev-3", versionNumber: 3, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V3", rank: 4 },
  ]);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.rank, 3);
});

// §No Rank field on this org (the exact shape every OTHER test in this file mocks) — Rank must never be
// invented; `rank` stays null and `rankFieldExists` stays false, so `canvasBuilder.ts` skips injecting
// a <rank> tag entirely rather than sending a guessed value.
test("TEST — Rank: an org with no Rank field on ExpressionSetVersion resolves rank=null, rankFieldExists=false", async () => {
  const client = buildMockClient("es-1", [{ id: "ev-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1" }]);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.rankFieldExists, false);
  assert.equal(result.rank, null);
});

/**
 * §Part 14 TEST 5/6 — "candidate has same identity as an existing version -> collision" / "candidate has
 * a different identity -> no collision" are already directly covered above, on the exact live-reported
 * record: see "TEST — existing V1 Active + V2 Active, candidate V2: real collision, must not overwrite"
 * (TEST 5 — same identity as an existing ACTIVE version IS a collision) and "TEST — the exact live
 * record (Id=9QMNS000000awWv4AI, V1, Active) does not collide with candidate V2 ..." (TEST 6 — a
 * genuinely different identity from the existing V1 is NOT a collision). Not duplicated here.
 */

/**
 * §Follow-on 35 Part 1/15 TEST 3 — the exact newly-reported live contradiction: Rank=2 was proven
 * unused among THIS ExpressionSet's own reported versions, yet Salesforce still rejected it. This
 * models that as "Rank uniqueness is NOT scoped to only this ExpressionSet" — a totally unrelated
 * ExpressionSetVersion, under a DIFFERENT ExpressionSetId, already holds the locally-unused Rank. The
 * mock distinguishes the per-ExpressionSet-scoped query (`WHERE ExpressionSetId = ...`, returns only
 * this ExpressionSet's own rows) from the org-wide independent check (`WHERE Rank = ...`, returns
 * EVERY matching row in the org regardless of parent) — exactly the same "two structurally different
 * queries can disagree" class of bug this whole session has repeatedly found, now applied to Rank
 * instead of identity.
 */
interface MockOrgWideVersion extends MockVersionWithRank {
  expressionSetId: string;
}

function buildMockClientWithOrgWideRanks(ownExpressionSetId: string, allOrgVersions: MockOrgWideVersion[]): SalesforceClient {
  const ownVersions = allOrgVersions.filter(v => v.expressionSetId === ownExpressionSetId);
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
            { name: "Rank", type: "double" },
          ],
          recordTypeInfos: [], urls: {},
        };
      }
      throw new Error(`unexpected describeObject(${sobject})`);
    },
    async query(soql: string) {
      if (soql.startsWith("SELECT") && soql.includes("FROM ExpressionSet WHERE")) {
        return { totalSize: 1, done: true, records: [{ Id: ownExpressionSetId, ApiName: "Laptop_Attribute_Based_Pricing_Procedure", Name: "Laptop Attribute-Based Pricing Procedure" }] };
      }
      if (soql.includes("FROM ExpressionSetVersion WHERE ExpressionSetId")) {
        // Per-ExpressionSet-scoped query — only THIS ExpressionSet's own rows, never the foreign ones.
        return { totalSize: ownVersions.length, done: true, records: ownVersions.map(v => ({ Id: v.id, ExpressionSetId: v.expressionSetId, ApiName: v.apiName, VersionNumber: v.versionNumber, IsActive: v.isActive, Rank: v.rank })) };
      }
      if (soql.includes("WHERE Rank =")) {
        // The genuinely independent, org-wide check — every matching row anywhere in the org.
        const m = soql.match(/WHERE Rank = (\d+)/);
        const rank = m ? Number(m[1]) : null;
        const matches = allOrgVersions.filter(v => v.rank === rank);
        return { totalSize: matches.length, done: true, records: matches.map(v => ({ Id: v.id, ExpressionSetId: v.expressionSetId, ApiName: v.apiName, VersionNumber: v.versionNumber, IsActive: v.isActive, Rank: v.rank })) };
      }
      if (soql.includes("FROM ExpressionSetVersion")) {
        // The identity OR-clause query (ApiName/DeveloperName/Name) — scoped to this ExpressionSet's own rows.
        return { totalSize: ownVersions.length, done: true, records: ownVersions.map(v => ({ Id: v.id, ExpressionSetId: v.expressionSetId, ApiName: v.apiName, VersionNumber: v.versionNumber, IsActive: v.isActive, Rank: v.rank })) };
      }
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  };
  return client as unknown as SalesforceClient;
}

test("TEST — Follow-on 35: Rank=2 is unused within THIS ExpressionSet but already taken by a completely different ExpressionSetVersion elsewhere in the org -> candidate skips to Rank 3, never guesses/repeats 2", async () => {
  const client = buildMockClientWithOrgWideRanks("es-1", [
    { id: "ev-1", expressionSetId: "es-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1", rank: 1 },
    // A totally unrelated ExpressionSetVersion, under a DIFFERENT ExpressionSet, already holds Rank 2.
    { id: "ev-foreign-1", expressionSetId: "es-999", versionNumber: 1, isActive: true, apiName: "Some_Other_Pricing_Procedure_V1", rank: 2 },
  ]);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.versionNumber, 2, "version-number resolution (identity-based) is unaffected by rank scope");
  assert.equal(result.rank, 3, "Rank 2 is proven taken elsewhere in the org by the independent check, even though it's unused within this ExpressionSet — must skip to 3, not repeat 2");
  const lastAttempt = result.attempts[result.attempts.length - 1];
  assert.ok(lastAttempt.orgWideRankCollisions.some(c => c.rank === 2 && c.existingRecordId === "ev-foreign-1"));
});

test("TEST — Follow-on 35: when no rank collides anywhere in the org, orgWideRankCollisions is empty and the per-ExpressionSet-lowest-unused value is used as-is", async () => {
  const client = buildMockClientWithOrgWideRanks("es-1", [
    { id: "ev-1", expressionSetId: "es-1", versionNumber: 1, isActive: true, apiName: "Laptop_Attribute_Based_Pricing_Procedure_V1", rank: 1 },
  ]);
  const result = await resolveNextAvailableExpressionSetVersion(client, "Laptop_Attribute_Based_Pricing_Procedure");
  assert.equal(result.rank, 2);
  const lastAttempt = result.attempts[result.attempts.length - 1];
  assert.equal(lastAttempt.orgWideRankCollisions.length, 0);
});
