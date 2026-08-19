/**
 * §Final Fix / Part 18 — coverage for `selectExpressionSetVersion`, the pure decision logic behind the
 * Business Rules Connect REST version resolver that replaced `SELECT Id FROM ExpressionSetVersion WHERE
 * ExpressionSetId = ...` (a relationship that doesn't resolve on this org — confirmed live: 4 retries,
 * 0 rows, even though the Metadata API deploy genuinely succeeded).
 *
 * Same caveat as idResolution.test.ts: this repo has no test framework/runner installed (no jest/vitest,
 * no `npm test` script) and none is added here per explicit instruction — this file type-checks under
 * `tsc --noEmit` but needs a TypeScript-aware runner (e.g. `tsx --test`) to actually execute.
 *
 * Scenarios A-C are pure and covered directly below. D (bounded retry on an initially-empty Connect
 * REST response), E (Connect REST unavailable -> controlled SOQL fallback), and F (the resolved Id is
 * what activation actually receives) are I/O-shaped — they involve a live SalesforceClient/HTTP call and
 * are exercised live instead, per this session's standing "never claim live-org success without the user
 * running it" rule. `resolveExpressionSetVersionId`'s own control flow (bounded retry loop, unsupported-
 * resource detection, fallback delegation) was written to the same "attempt schedule 1s/2s/2s/3s,
 * never retry indefinitely" spec these tests describe, but is not independently mocked here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectExpressionSetVersion, type ConnectExpressionSetVersion } from "./verifySalesforceState";

// Scenario A — Connect REST response contains one version.
test("selectExpressionSetVersion selects the sole version with no ambiguity", () => {
  const versions: ConnectExpressionSetVersion[] = [{ id: "0jHxx0000000001", status: "Draft" }];
  const result = selectExpressionSetVersion(versions);
  assert.equal(result.version?.id, "0jHxx0000000001");
  assert.equal(result.priority, "C");
});

// Scenario B — Connect REST response contains multiple versions.
test("selectExpressionSetVersion never picks the first version in a multi-version array without a reason", () => {
  const versions: ConnectExpressionSetVersion[] = [
    { id: "0jHxx0000000001", versionNumber: 1 },
    { id: "0jHxx0000000002", versionNumber: 2 },
  ];
  const result = selectExpressionSetVersion(versions);
  // Highest versionNumber wins (Priority C signal), not array position — proven by putting the
  // higher-numbered version FIRST in a second case and confirming the same winner is still picked.
  assert.equal(result.version?.id, "0jHxx0000000002");
  const reordered = selectExpressionSetVersion([versions[1], versions[0]]);
  assert.equal(reordered.version?.id, "0jHxx0000000002");
});

// Scenario C — the correct version is selected via each priority signal in order.
test("selectExpressionSetVersion Priority A: deployment component's own version Id wins over any other signal", () => {
  const versions: ConnectExpressionSetVersion[] = [
    { id: "0jHxx0000000001", versionNumber: 5 },
    { id: "0jHxx0000000002", versionNumber: 1 },
  ];
  const result = selectExpressionSetVersion(versions, { deployedVersionId: "0jHxx0000000002" });
  assert.equal(result.version?.id, "0jHxx0000000002");
  assert.equal(result.priority, "A");
});

test("selectExpressionSetVersion Priority B: matches deployed component's fullName/apiName/name when no Id match exists", () => {
  const versions: ConnectExpressionSetVersion[] = [
    { id: "0jHxx0000000001", fullName: "Other_Procedure" },
    { id: "0jHxx0000000002", fullName: "Laptop_Attribute_Based_Pricing_Procedure" },
  ];
  const result = selectExpressionSetVersion(versions, { deployedVersionFullName: "Laptop_Attribute_Based_Pricing_Procedure" });
  assert.equal(result.version?.id, "0jHxx0000000002");
  assert.equal(result.priority, "B");
});

test("selectExpressionSetVersion Priority C: falls back to the most recently-dated version when no version number exists", () => {
  const versions: ConnectExpressionSetVersion[] = [
    { id: "0jHxx0000000001", createdDate: "2026-01-01T00:00:00Z" },
    { id: "0jHxx0000000002", createdDate: "2026-06-01T00:00:00Z" },
  ];
  const result = selectExpressionSetVersion(versions);
  assert.equal(result.version?.id, "0jHxx0000000002");
});

test("selectExpressionSetVersion refuses to guess when nothing distinguishes multiple candidates", () => {
  const versions: ConnectExpressionSetVersion[] = [{ id: "0jHxx0000000001" }, { id: "0jHxx0000000002" }];
  const result = selectExpressionSetVersion(versions);
  assert.equal(result.version, null);
  assert.equal(result.priority, "none");
});

test("selectExpressionSetVersion returns none (not a thrown error) for an empty versions array", () => {
  const result = selectExpressionSetVersion([]);
  assert.equal(result.version, null);
  assert.equal(result.priority, "none");
});
