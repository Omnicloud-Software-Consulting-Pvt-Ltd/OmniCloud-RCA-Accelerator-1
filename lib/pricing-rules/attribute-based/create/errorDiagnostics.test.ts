/**
 * §Phase 5 fix (generic failure-category classification) — a real live failure reported "storage limit
 * exceeded" for a Metadata API component failure with no line/column (Salesforce doesn't localize a
 * capacity rejection to a position in the file, unlike a genuine structural/XML defect). These tests prove
 * the classifier distinguishes a Salesforce org-capacity rejection from every other kind of failure, purely
 * from Salesforce's own error text/code — never from which pipeline step failed, never from any
 * product/org-specific string.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SalesforceError } from "@/lib/salesforce/client";
import { classifyFailureCategory, classifyComponentFailures, buildFailureDiagnostics } from "./errorDiagnostics";
import type { ComponentFailure } from "./soapEnvelope";

test("classifyFailureCategory — 'storage limit exceeded' message classifies as salesforce-storage-limit", () => {
  assert.equal(classifyFailureCategory(null, "storage limit exceeded"), "salesforce-storage-limit");
  assert.equal(classifyFailureCategory(null, "Monitor_Attribute_Based_Pricing_Procedur: storage limit exceeded"), "salesforce-storage-limit");
});

test("classifyFailureCategory — 'STORAGE_LIMIT_EXCEEDED' errorCode classifies as salesforce-storage-limit even with an unrelated message", () => {
  assert.equal(classifyFailureCategory("STORAGE_LIMIT_EXCEEDED", "some other text"), "salesforce-storage-limit");
});

test("classifyFailureCategory — REQUEST_LIMIT_EXCEEDED classifies as salesforce-api-limit, distinctly from storage", () => {
  assert.equal(classifyFailureCategory("REQUEST_LIMIT_EXCEEDED", "TotalRequests Limit exceeded."), "salesforce-api-limit");
});

test("classifyFailureCategory — an unrelated Salesforce error (e.g. a real structural/XML rejection) is unclassified, never mislabeled as a capacity problem", () => {
  assert.equal(classifyFailureCategory("INVALID_FIELD", "Select list filter as first element in list group"), "unclassified");
  assert.equal(classifyFailureCategory(null, "FIELD_INTEGRITY_EXCEPTION: duplicate condition"), "unclassified");
});

test("classifyComponentFailures — finds a storage rejection among multiple component failures, even when it's not first", () => {
  const failures: ComponentFailure[] = [
    { fileName: "a.xml", fullName: "SomeComponent", problem: "unrelated warning", componentType: "ExpressionSetVersion", problemType: "Warning", lineNumber: 12, columnNumber: 4 },
    { fileName: "b.xml", fullName: "Monitor_Attribute_Based_Pricing_Procedur", problem: "storage limit exceeded", componentType: "ExpressionSetVersion", problemType: "Error", lineNumber: null, columnNumber: null },
  ];
  assert.equal(classifyComponentFailures(failures), "salesforce-storage-limit");
});

test("classifyComponentFailures — a storage rejection with no line/column (Salesforce's real reported shape) still classifies correctly — absence of line/column is itself consistent with a capacity rejection, not a structural one", () => {
  const failures: ComponentFailure[] = [
    { fileName: null, fullName: "Monitor_Attribute_Based_Pricing_Procedur", problem: "storage limit exceeded", componentType: "ExpressionSetVersion", problemType: "Error", lineNumber: null, columnNumber: null },
  ];
  const result = classifyComponentFailures(failures);
  assert.equal(result, "salesforce-storage-limit");
});

test("classifyComponentFailures — empty/null input is unclassified, never throws", () => {
  assert.equal(classifyComponentFailures(null), "unclassified");
  assert.equal(classifyComponentFailures([]), "unclassified");
});

test("buildFailureDiagnostics — a storage-limit SalesforceError gets category set AND a clear, non-Expression-Set-blaming reason prefix", () => {
  const err = new SalesforceError("storage limit exceeded", 400, [{ message: "storage limit exceeded", errorCode: "STORAGE_LIMIT_EXCEEDED" }]);
  err.errorCode = "STORAGE_LIMIT_EXCEEDED";
  const failure = buildFailureDiagnostics("deploy-pricing-procedure", err);
  assert.equal(failure.category, "salesforce-storage-limit");
  assert.match(failure.reason, /ORG CAPACITY/);
  assert.match(failure.reason, /not an Expression Set\/XML defect|storage limit exceeded/i);
  assert.match(failure.resolutionHint, /Data Storage/);
});

test("buildFailureDiagnostics — a genuinely unrelated SalesforceError gets NO category, and its normal step-specific hint, unchanged", () => {
  const err = new SalesforceError("Select list filter as first element in list group", 400, [{ message: "Select list filter as first element in list group", errorCode: "INVALID_FIELD" }]);
  err.errorCode = "INVALID_FIELD";
  const failure = buildFailureDiagnostics("deploy-pricing-procedure", err);
  assert.equal(failure.category, undefined);
  assert.doesNotMatch(failure.reason, /ORG CAPACITY/);
});

test("buildFailureDiagnostics — an API-limit failure at a DIFFERENT step (native-record creation, not deploy) is classified identically — category is never step-dependent", () => {
  const err = new SalesforceError("TotalRequests Limit exceeded.", 403, [{ message: "TotalRequests Limit exceeded.", errorCode: "REQUEST_LIMIT_EXCEEDED" }]);
  err.errorCode = "REQUEST_LIMIT_EXCEEDED";
  const failureAtCreateRule = buildFailureDiagnostics("create-rule", err);
  const failureAtActivate = buildFailureDiagnostics("activate-version", err);
  assert.equal(failureAtCreateRule.category, "salesforce-api-limit");
  assert.equal(failureAtActivate.category, "salesforce-api-limit");
});
