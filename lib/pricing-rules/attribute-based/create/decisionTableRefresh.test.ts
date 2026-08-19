/**
 * §Part 4/14 TEST 7 — Attribute Discount Entries discovery. Salesforce's own documented `DecisionTable`
 * Tooling API object reference confirms the real identifying fields are `DeveloperName`, `MasterLabel`,
 * and `SetupName` (a required setup identifier the prior code never checked at all) plus a `Status`
 * picklist (Draft/Active/Inactive/ActivationInProgress — never a boolean `IsActive`, which the prior
 * code's `/^is.?active$/i` guess could never match). Whether the standard REST `/query` endpoint
 * returns real data for this object (vs. the Tooling API, which the same reference confirms it supports)
 * was never observed live, so `refreshAttributeDiscountEntries` now tries the standard endpoint first
 * and falls back to `client.toolingQuery` only if that comes back empty — these tests cover both paths,
 * the "found by SetupName, not MasterLabel" case (Part 4's "do not assume the display label is the API
 * name"), and the genuine-absence case.
 *
 * Same caveat as every other *.test.ts in this directory: needs a TypeScript-aware runner
 * (e.g. `npx tsx --test`) to actually execute — `tsc --noEmit` only type-checks it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { refreshAttributeDiscountEntries } from "./decisionTableRefresh";

interface MockDecisionTableRow {
  Id: string;
  DeveloperName?: string;
  MasterLabel?: string;
  SetupName?: string;
  Status?: string;
}

function buildMockClient(opts: {
  standardRows?: MockDecisionTableRow[];
  toolingRows?: MockDecisionTableRow[];
  refreshShouldFail?: boolean;
}): SalesforceClient & { refreshCalls: { path: string; body: string }[] } {
  const refreshCalls: { path: string; body: string }[] = [];
  const client = {
    refreshCalls,
    async describeObject(sobject: string) {
      if (sobject !== "DecisionTable") throw new Error(`unexpected describeObject(${sobject})`);
      return {
        name: "DecisionTable", label: "", labelPlural: "",
        fields: [
          { name: "Id", type: "id" }, { name: "DeveloperName", type: "string" }, { name: "MasterLabel", type: "string" },
          { name: "SetupName", type: "string" }, { name: "Status", type: "picklist" },
        ],
        recordTypeInfos: [], urls: {},
      };
    },
    async query() {
      const records = opts.standardRows ?? [];
      return { totalSize: records.length, done: true, records };
    },
    async toolingQuery() {
      const records = opts.toolingRows ?? [];
      return { totalSize: records.length, done: true, records };
    },
    async request(path: string, options: { body?: unknown } = {}) {
      refreshCalls.push({ path, body: String(options.body ?? "") });
      if (opts.refreshShouldFail) throw new Error("refreshDecisionTable action failed");
      return {};
    },
    logDebug() { /* no-op */ },
  };
  return client as unknown as SalesforceClient & { refreshCalls: { path: string; body: string }[] };
}

test("TEST — Attribute Discount Entries found via the standard REST query (MasterLabel match)", async () => {
  const client = buildMockClient({
    standardRows: [{ Id: "dt-1", DeveloperName: "Attribute_Discount_Entries", MasterLabel: "Attribute Discount Entries", Status: "Active" }],
  });
  const result = await refreshAttributeDiscountEntries(client);
  assert.equal(result.found, true);
  assert.equal(result.refreshed, true);
  assert.equal(result.developerName, "Attribute_Discount_Entries");
  assert.equal(client.refreshCalls.length, 1);
});

// §Part 4's exact ask: "The application should be able to find 'Attribute Discount Entries' even if
// Salesforce's API/developer name differs from the displayed label" — here MasterLabel does NOT contain
// "Attribute Discount" at all (a differently-labeled org variant), but SetupName does, and the standard
// REST query returns nothing (0 rows) — only the Tooling API fallback finds it.
test("TEST — Attribute Discount Entries found via the Tooling API fallback when the standard REST query returns zero rows, identified by SetupName (not MasterLabel)", async () => {
  const client = buildMockClient({
    standardRows: [],
    toolingRows: [{ Id: "dt-2", SetupName: "Attribute_Discount_Entries_Lookup", MasterLabel: "ABP Discount Lookup", Status: "Active" }],
  });
  const result = await refreshAttributeDiscountEntries(client);
  assert.equal(result.found, true, "must be found via the Tooling API fallback even though the standard REST query found nothing and MasterLabel does not literally say 'Attribute Discount'");
  assert.equal(result.refreshed, true);
});

test("TEST — genuine absence: neither the standard REST query nor the Tooling API fallback find a candidate -> not found, never fabricated", async () => {
  const client = buildMockClient({ standardRows: [], toolingRows: [] });
  const result = await refreshAttributeDiscountEntries(client);
  assert.equal(result.found, false);
  assert.equal(result.refreshed, false);
  assert.ok(result.warning?.includes("standard REST query"));
  assert.ok(result.warning?.includes("Tooling API"));
  assert.equal(client.refreshCalls.length, 0, "must never call the refresh action for a table it never found");
});

test("TEST — found but the refresh action itself fails: reported as found+not-refreshed, never as not-found", async () => {
  const client = buildMockClient({
    standardRows: [{ Id: "dt-1", DeveloperName: "Attribute_Discount_Entries", MasterLabel: "Attribute Discount Entries", Status: "Active" }],
    refreshShouldFail: true,
  });
  const result = await refreshAttributeDiscountEntries(client);
  assert.equal(result.found, true);
  assert.equal(result.refreshed, false);
  assert.ok(result.warning);
});
