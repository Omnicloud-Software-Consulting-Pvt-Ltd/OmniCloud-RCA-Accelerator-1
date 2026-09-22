/**
 * §Request-efficiency fix (REQUEST_LIMIT_EXCEEDED remediation) — regression coverage for two distinct
 * problems found while auditing the Attribute-Based Pricing pipeline for unnecessary Salesforce API
 * usage:
 *   1. `ensurePriceImpactingAttributes` and `resolveAllPriceImpactingAttributeNames` both run
 *      unconditionally, back to back, in the SAME `createPipeline.ts` execution, and both previously
 *      re-Described "ProductAttributeDefinition" independently — twice per pipeline run for an object
 *      that never changes mid-run. `resolveProductAttributeDefinitionOverrideFields` additionally
 *      re-Described the SAME object once per attribute needing a classification override, inside
 *      `ensurePriceImpactingAttributes`'s own per-attribute loop — O(N) redundant Describes for N such
 *      attributes. All three now accept an optional pre-fetched Describe and skip their own call when
 *      one is supplied.
 *   2. `resolveExpressionSetId`/`resolveExpressionSetVersionId`'s bounded-retry loops previously treated
 *      REQUEST_LIMIT_EXCEEDED exactly like a transient "not found yet" condition — sleeping and retrying
 *      on the same schedule, which issues MORE requests against an org that is already out of capacity
 *      (worse for `resolveExpressionSetId`, whose retry loop issues one query PER candidate identity
 *      field per attempt). Both now stop immediately, with no sleep and no further attempts, the moment
 *      this specific error is seen.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import { SalesforceError } from "@/lib/salesforce/client";
import { resolveAllPriceImpactingAttributeNames, resolveProductAttributeDefinitionOverrideFields } from "./nativeRecords";
import { resolveExpressionSetId, resolveExpressionSetVersionId, isRequestLimitExceeded } from "./verifySalesforceState";

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

const PAD_DESCRIBE: DescribeResult = {
  name: "ProductAttributeDefinition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [
    field("Id", "id"),
    field("Product2Id", "reference", { referenceTo: ["Product2"] }),
    field("AttributeDefinitionId", "reference", { referenceTo: ["AttributeDefinition"] }),
    field("IsPriceImpacting", "boolean"),
    field("ProductClassificationAttributeId", "reference", { referenceTo: ["ProductClassificationAttr"] }),
  ],
} as unknown as DescribeResult;

function requestLimitExceededError(): SalesforceError {
  return new SalesforceError(
    "TotalRequests Limit exceeded.", 403,
    { errorCode: "REQUEST_LIMIT_EXCEEDED", message: "TotalRequests Limit exceeded." },
  );
}

test("isRequestLimitExceeded recognizes the exact Salesforce shape and rejects everything else", () => {
  assert.equal(isRequestLimitExceeded(requestLimitExceededError()), true);
  assert.equal(isRequestLimitExceeded(new SalesforceError("nope", 403, { errorCode: "SOME_OTHER_CODE" })), false);
  assert.equal(isRequestLimitExceeded(new Error("plain error")), false);
  assert.equal(isRequestLimitExceeded(null), false);
});

/* ── Describe-call dedup ── */

test("resolveAllPriceImpactingAttributeNames never calls describeObject when a pre-fetched Describe is supplied", async () => {
  let describeCalls = 0;
  const client = {
    async describeObject() { describeCalls++; return PAD_DESCRIBE; },
    async query(soql: string) {
      if (soql.includes("IsPriceImpacting = true")) return { totalSize: 0, done: true, records: [] };
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  const names = await resolveAllPriceImpactingAttributeNames(client, "prod-1", PAD_DESCRIBE);
  assert.deepEqual(names, []);
  assert.equal(describeCalls, 0, "must reuse the supplied Describe result, never issue its own describeObject call");
});

test("resolveAllPriceImpactingAttributeNames still describes on its own when no pre-fetched Describe is given (unchanged standalone behavior)", async () => {
  let describeCalls = 0;
  const client = {
    async describeObject() { describeCalls++; return PAD_DESCRIBE; },
    async query(soql: string) {
      if (soql.includes("IsPriceImpacting = true")) return { totalSize: 0, done: true, records: [] };
      throw new Error(`unexpected query: ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;

  await resolveAllPriceImpactingAttributeNames(client, "prod-1");
  assert.equal(describeCalls, 1);
});

test("resolveProductAttributeDefinitionOverrideFields never calls describeObject when a pre-fetched Describe is supplied", async () => {
  let describeCalls = 0;
  const client = { async describeObject() { describeCalls++; return PAD_DESCRIBE; } } as unknown as SalesforceClient;

  const result = await resolveProductAttributeDefinitionOverrideFields(client, PAD_DESCRIBE);
  assert.ok(result.fields, "expected the fields to resolve successfully from the supplied Describe");
  assert.equal(describeCalls, 0);
});

test("resolveProductAttributeDefinitionOverrideFields called N times with the SAME pre-fetched Describe issues zero additional describeObject calls (the exact live shape: one override needed per attribute in a loop)", async () => {
  let describeCalls = 0;
  const client = { async describeObject() { describeCalls++; return PAD_DESCRIBE; } } as unknown as SalesforceClient;

  for (let i = 0; i < 5; i++) {
    const result = await resolveProductAttributeDefinitionOverrideFields(client, PAD_DESCRIBE);
    assert.ok(result.fields);
  }
  assert.equal(describeCalls, 0, "5 loop iterations must not re-describe ProductAttributeDefinition even once");
});

/* ── REQUEST_LIMIT_EXCEEDED is never retried ── */

test("resolveExpressionSetId stops immediately on REQUEST_LIMIT_EXCEEDED — no sleep, no further attempts, no additional field queries", async () => {
  let describeCalls = 0;
  let queryCalls = 0;
  const client = {
    async describeObject() {
      describeCalls++;
      return {
        name: "ExpressionSet", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
        fields: [field("Id", "id"), field("ApiName", "string", { filterable: true })],
      } as unknown as DescribeResult;
    },
    async query() {
      queryCalls++;
      throw requestLimitExceededError();
    },
  } as unknown as SalesforceClient;

  const attempts: { attempt: number; found: boolean; error?: string }[] = [];
  const start = Date.now();
  const result = await resolveExpressionSetId(client, { apiName: "Some_Procedure" }, (attempt, found, error) => {
    attempts.push({ attempt, found, error });
  });
  const elapsedMs = Date.now() - start;

  assert.equal(result.strategy, "request-limit-exceeded");
  assert.equal(result.id, null);
  assert.equal(result.verified, false);
  assert.equal(describeCalls, 1, "the ExpressionSet Describe itself is unaffected — it happens once, before the retry loop");
  assert.equal(queryCalls, 1, "must stop after the FIRST query that throws REQUEST_LIMIT_EXCEEDED, never try remaining candidate fields or further attempts");
  assert.equal(attempts.length, 1, "onAttempt must be called exactly once — no retry attempts");
  assert.ok(elapsedMs < 500, `must not sleep at all before giving up (elapsed=${elapsedMs}ms) — the retry schedule's delays (1s/2s/2s) must never be entered`);
});

test("resolveExpressionSetId still retries normally (sleeping between attempts) for an ordinary transient error, unaffected by the REQUEST_LIMIT_EXCEEDED short-circuit", async () => {
  let queryCalls = 0;
  const client = {
    async describeObject() {
      return {
        name: "ExpressionSet", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
        fields: [field("Id", "id"), field("ApiName", "string", { filterable: true })],
      } as unknown as DescribeResult;
    },
    async query() {
      queryCalls++;
      if (queryCalls < 3) throw new Error("transient network blip");
      return { totalSize: 1, done: true, records: [{ Id: "es-1" }] };
    },
    async request() { throw new Error("verifyRecordExists read-back not exercised in this test"); },
  } as unknown as SalesforceClient;

  // Not asserting the final outcome (verifyRecordExists isn't mocked here) — only that ordinary errors
  // are still retried across multiple attempts, proving the REQUEST_LIMIT_EXCEEDED short-circuit above
  // didn't accidentally make EVERY error stop immediately.
  await resolveExpressionSetId(client, { apiName: "Some_Procedure" }, () => { /* no-op */ }).catch(() => { /* ignore */ });
  assert.ok(queryCalls >= 3, `expected retries to continue past transient errors (queryCalls=${queryCalls})`);
});

test("resolveExpressionSetVersionId stops immediately on REQUEST_LIMIT_EXCEEDED from Connect REST — no sleep, no further attempts", async () => {
  let requestCalls = 0;
  const client = {
    async request() {
      requestCalls++;
      throw requestLimitExceededError();
    },
  } as unknown as SalesforceClient;

  const attempts: { attempt: number; found: boolean; error?: string }[] = [];
  const start = Date.now();
  const result = await resolveExpressionSetVersionId(client, { expressionSetId: "es-1" }, (attempt, found, error) => {
    attempts.push({ attempt, found, error });
  });
  const elapsedMs = Date.now() - start;

  assert.equal(result.strategy, "request-limit-exceeded");
  assert.equal(result.id, null);
  assert.equal(result.verified, false);
  assert.equal(requestCalls, 1, "must stop after the FIRST Connect REST call that throws REQUEST_LIMIT_EXCEEDED");
  assert.equal(attempts.length, 1, "onAttempt must be called exactly once — no retry attempts");
  assert.ok(elapsedMs < 500, `must not sleep at all before giving up (elapsed=${elapsedMs}ms) — the retry schedule's delays (1s/2s/2s/3s) must never be entered`);
});
