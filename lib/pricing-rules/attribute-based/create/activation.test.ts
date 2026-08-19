/**
 * §Final Fix — coverage for the activation field-selection and confirmation logic that replaced the
 * hardcoded `Status` field (which a live run proved doesn't exist on `ExpressionSetVersion`: "HTTP 400
 * INVALID_FIELD: No such column 'Status'"). Only pure, client-independent decision functions are tested
 * here — the actual `updateRecord`/`query` HTTP calls in `activateExpressionSetVersion` are exercised
 * live, per this session's standing rule.
 *
 * Same caveat as every other *.test.ts in this directory: no test framework/runner is installed in this
 * repo (no jest/vitest, no `npm test` script) and none is added here — this file type-checks under
 * `tsc --noEmit` but needs a TypeScript-aware runner (e.g. `tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickActiveField } from "./verifySalesforceState";
import { isActivationConfirmed } from "./activation";

// Regression test for the exact live bug: "Status" must never be selected when the org has no such
// field, and must never be preferred over a real boolean IsActive field even if both happened to exist.
test("pickActiveField prefers the documented boolean IsActive field over any string Status field", () => {
  const fields = [
    { name: "Id", type: "id" },
    { name: "IsActive", type: "boolean" },
    { name: "Status", type: "picklist" },
  ];
  const result = pickActiveField(fields);
  assert.equal(result?.field, "IsActive");
  assert.equal(result?.fieldType, "boolean");
});

test("pickActiveField never returns Status when this org's Describe doesn't report it (the live 400 case)", () => {
  const fields = [
    { name: "Id", type: "id" },
    { name: "IsActive", type: "boolean" },
    { name: "Name", type: "string" },
  ];
  const result = pickActiveField(fields);
  assert.notEqual(result?.field, "Status");
  assert.equal(result?.field, "IsActive");
});

test("pickActiveField falls back to a string status-like field only when no boolean field exists", () => {
  const fields = [
    { name: "Id", type: "id" },
    { name: "VersionStatus", type: "picklist" },
  ];
  const result = pickActiveField(fields);
  assert.equal(result?.field, "VersionStatus");
  assert.equal(result?.fieldType, "string");
});

test("pickActiveField returns null (never a guessed field) when nothing plausible exists at all", () => {
  const fields = [{ name: "Id", type: "id" }, { name: "Name", type: "string" }, { name: "CreatedDate", type: "dateTime" }];
  assert.equal(pickActiveField(fields), null);
});

test("pickActiveField only considers writable fields — a read-only IsActive can't be used for activation", () => {
  const fields = [
    { name: "IsActive", type: "boolean", updateable: false },
    { name: "Enabled", type: "boolean", updateable: true },
  ];
  const result = pickActiveField(fields);
  assert.equal(result?.field, "Enabled");
});

// §"test successful activation" / §"test activation success without post-readback must still be
// treated as unverified" — isActivationConfirmed is the exact gate: an HTTP-successful update alone
// (no read-back value, or a read-back value that doesn't match) is never sufficient.
test("isActivationConfirmed is true only for an exact boolean true on a boolean field", () => {
  assert.equal(isActivationConfirmed("boolean", true), true);
  assert.equal(isActivationConfirmed("boolean", false), false);
  assert.equal(isActivationConfirmed("boolean", undefined), false); // no read-back value at all
  assert.equal(isActivationConfirmed("boolean", "true"), false); // wrong type — a string, not a boolean
});

test("isActivationConfirmed is true only for the exact string 'Active' on a string field", () => {
  assert.equal(isActivationConfirmed("string", "Active"), true);
  assert.equal(isActivationConfirmed("string", "Draft"), false);
  assert.equal(isActivationConfirmed("string", undefined), false);
  assert.equal(isActivationConfirmed("string", true), false); // wrong type
});
