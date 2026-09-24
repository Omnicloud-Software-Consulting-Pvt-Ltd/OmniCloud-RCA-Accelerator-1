/**
 * §Root-cause fix (live evidence) — `activateExpressionSetVersion` activates every new ExpressionSetVersion
 * it deploys, but never deactivated the one it replaces. A live check via the real Business Rules Connect
 * REST resource (`GET /connect/business-rules/expression-set/{id}` — the same endpoint Salesforce's own
 * pricing engine reads) found FOUR versions of `Laptop_Attribute_Based_Pricing_Procedure` (V2, V3, V4, V5)
 * simultaneously `enabled: true` — one stale, still-enabled version per prior pipeline run. `IsActive` is a
 * per-record boolean with no server-side "only one active" constraint, so this accumulates silently.
 *
 * `deactivateOtherEnabledVersions` closes this: after activating a new version, it re-enumerates every
 * OTHER version of the same ExpressionSetDefinition via the same Connect REST resource and deactivates any
 * still showing `enabled: true`, never touching the version just activated. Verified live against the real
 * org: all 3 stale versions were deactivated, confirmed via a fresh Connect REST re-fetch afterward (not
 * just the function's own claim) showing exactly one (the highest version number) still enabled.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { deactivateOtherEnabledVersions } from "./activation";
import type { ProcedureStepLite } from "../types";

function mockClient(opts: {
  versions: { id: string; versionNumber: number; enabled: boolean }[];
  updateShouldFail?: (id: string) => boolean;
}) {
  const updateLog: { id: string; payload: Record<string, unknown> }[] = [];
  const client = {
    debugLog: [] as unknown[],
    async request() {
      return { id: "es-1", apiName: "Test_Procedure", versions: opts.versions.map(v => ({ id: v.id, versionNumber: v.versionNumber, enabled: v.enabled })) };
    },
    async updateRecord(objectName: string, id: string, payload: Record<string, unknown>) {
      if (opts.updateShouldFail?.(id)) throw new Error(`Simulated failure updating ${id}`);
      updateLog.push({ id, payload });
      return { success: true };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
  return { client, updateLog };
}

test("TEST 1 — the exact live bug: 4 enabled versions (V2-V5), keeping V5, deactivates V2/V3/V4 and never touches V5", async () => {
  const { client, updateLog } = mockClient({
    versions: [
      { id: "v1", versionNumber: 1, enabled: false },
      { id: "v2", versionNumber: 2, enabled: true },
      { id: "v3", versionNumber: 3, enabled: true },
      { id: "v4", versionNumber: 4, enabled: true },
      { id: "v5", versionNumber: 5, enabled: true },
    ],
  });
  const steps: ProcedureStepLite[] = [];
  const warnings: string[] = [];
  await deactivateOtherEnabledVersions(client, "es-1", "v5", "IsActive", "boolean", steps, warnings);

  assert.equal(updateLog.length, 3, "exactly the 3 OTHER enabled versions must be deactivated");
  const deactivatedIds = updateLog.map(u => u.id).sort();
  assert.deepEqual(deactivatedIds, ["v2", "v3", "v4"]);
  for (const u of updateLog) assert.equal(u.payload.IsActive, false);
  assert.equal(warnings.length, 0);
});

test("TEST 2 — already-inactive versions (V1) are never touched — only genuinely enabled ones get an update", async () => {
  const { client, updateLog } = mockClient({
    versions: [
      { id: "v1", versionNumber: 1, enabled: false },
      { id: "v2", versionNumber: 2, enabled: true },
    ],
  });
  const steps: ProcedureStepLite[] = [];
  await deactivateOtherEnabledVersions(client, "es-1", "v2", "IsActive", "boolean", steps, []);
  assert.equal(updateLog.length, 0, "v1 was already inactive — must never be written to");
});

test("TEST 3 — the version just activated (kept) is never deactivated, even though it's also enabled=true in the fetched list", async () => {
  const { client, updateLog } = mockClient({
    versions: [{ id: "v1", versionNumber: 1, enabled: true }],
  });
  const steps: ProcedureStepLite[] = [];
  await deactivateOtherEnabledVersions(client, "es-1", "v1", "IsActive", "boolean", steps, []);
  assert.equal(updateLog.length, 0, "the kept version must never be included in the deactivation set");
});

test("TEST 4 — a single failed deactivation is non-fatal: it's reported as a warning, and the OTHER stale versions are still deactivated", async () => {
  const { client, updateLog } = mockClient({
    versions: [
      { id: "v2", versionNumber: 2, enabled: true },
      { id: "v3", versionNumber: 3, enabled: true },
      { id: "v4", versionNumber: 4, enabled: true },
    ],
    updateShouldFail: id => id === "v3",
  });
  const steps: ProcedureStepLite[] = [];
  const warnings: string[] = [];
  await deactivateOtherEnabledVersions(client, "es-1", "v4", "IsActive", "boolean", steps, warnings);

  assert.equal(updateLog.length, 1, "only v2's update succeeds — v3's fails (non-fatal), v4 is the kept version and is never attempted at all");
  assert.equal(updateLog[0].id, "v2");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /v3/);
});

test("TEST 5 — a string-type activation field (org with no boolean IsActive) deactivates using the correct 'Draft' string value, not a boolean", async () => {
  const { client, updateLog } = mockClient({
    versions: [
      { id: "v1", versionNumber: 1, enabled: true },
      { id: "v2", versionNumber: 2, enabled: true },
    ],
  });
  const steps: ProcedureStepLite[] = [];
  await deactivateOtherEnabledVersions(client, "es-1", "v2", "Status", "string", steps, []);
  assert.equal(updateLog.length, 1);
  assert.equal(updateLog[0].id, "v1");
  assert.equal(updateLog[0].payload.Status, "Draft");
});

test("TEST 6 — no other enabled versions exist: zero writes, zero warnings (the healthy, already-correct state)", async () => {
  const { client, updateLog } = mockClient({
    versions: [
      { id: "v1", versionNumber: 1, enabled: false },
      { id: "v2", versionNumber: 2, enabled: true },
    ],
  });
  const steps: ProcedureStepLite[] = [];
  const warnings: string[] = [];
  await deactivateOtherEnabledVersions(client, "es-1", "v2", "IsActive", "boolean", steps, warnings);
  assert.equal(updateLog.length, 0);
  assert.equal(warnings.length, 0);
});

test("TEST 7 — a failure enumerating versions at all (Connect REST call itself fails) is non-fatal: reported as a warning, never thrown", async () => {
  const client = {
    debugLog: [] as unknown[],
    async request() { throw new Error("Connect REST unavailable"); },
    async updateRecord() { throw new Error("must never be called — enumeration failed first"); },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
  const steps: ProcedureStepLite[] = [];
  const warnings: string[] = [];
  await assert.doesNotReject(deactivateOtherEnabledVersions(client, "es-1", "v2", "IsActive", "boolean", steps, warnings));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Connect REST unavailable/);
});

test("TEST 8 — arbitrary, unusually-shaped Salesforce Ids throughout prove nothing is hardcoded (works for any product/procedure)", async () => {
  const { client, updateLog } = mockClient({
    versions: [
      { id: "###weird-v2###", versionNumber: 2, enabled: true },
      { id: "###weird-v3###", versionNumber: 3, enabled: true },
    ],
  });
  const steps: ProcedureStepLite[] = [];
  await deactivateOtherEnabledVersions(client, "###weird-expressionset###", "###weird-v3###", "IsActive", "boolean", steps, []);
  assert.equal(updateLog.length, 1);
  assert.equal(updateLog[0].id, "###weird-v2###");
});
