/**
 * §Live-org fix — regression coverage for the deterministic Decision Table mapping used by both
 * Tier-Based and Volume-Based canvas generation (`resolvePriceBookEntriesV2DecisionTable`,
 * `resolveTieredAdjustmentEntriesDecisionTable`, `resolveVolumeDiscountEntriesDecisionTable`). A live run
 * (screenshot evidence) showed ListPrice mapped/displayed as "Price Book Entries" (missing "V2") and
 * VolumeTierDiscount mapped/displayed as the generic "Decision Tables" placeholder — this file proves the
 * resolver itself never conflates these, independent of whatever the canvas builder does downstream with
 * the result.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeResult } from "@/lib/salesforce/client";
import {
  resolvePriceBookEntriesV2DecisionTable, resolveTieredAdjustmentEntriesDecisionTable,
  resolveVolumeDiscountEntriesDecisionTable,
} from "./decisionTableExactResolver";

interface Row { Id: string; MasterLabel?: string; DeveloperName?: string; SourceObject?: string; SetupName?: string }

const DESCRIBE_WITH_ALL_FIELDS: DescribeResult = {
  name: "DecisionTable", label: "Decision Table", labelPlural: "Decision Tables",
  fields: [
    { name: "Id", label: "Id", type: "id" },
    { name: "MasterLabel", label: "Master Label", type: "string" },
    { name: "DeveloperName", label: "Developer Name", type: "string" },
    { name: "SourceObject", label: "Source Object", type: "string" },
    { name: "SetupName", label: "Setup Name", type: "string" },
  ],
  recordTypeInfos: [], urls: {},
};

/** Mirrors the real org's actual Decision Table list (as reported by the user across this investigation). */
const REALISTIC_ORG_ROWS: Row[] = [
  { Id: "0Dt000000000001", MasterLabel: "Price Book Entries V2", DeveloperName: "Price_Book_Entries_V2", SourceObject: "PricebookEntry" },
  { Id: "0Dt000000000002", MasterLabel: "Price Book Entries", DeveloperName: "Price_Book_Entries", SourceObject: "PricebookEntry" },
  { Id: "0Dt000000000003", MasterLabel: "Tiered Adjustment Entries", DeveloperName: "Tiered_Adjustment_Entries", SourceObject: "PriceAdjustmentTier" },
  { Id: "0Dt000000000004", MasterLabel: "Volume Discount Entries", DeveloperName: "Volume_Discount_Entries", SourceObject: "PriceAdjustmentTier" },
  { Id: "0Dt000000000005", MasterLabel: "Rate Adjustment by Volume Entries", DeveloperName: "Rate_Adjustment_by_Volume_Entries", SourceObject: "PriceAdjustmentTier" },
  { Id: "0Dt000000000006", MasterLabel: "Rate Adjustment by Tier Entries", DeveloperName: "Rate_Adjustment_by_Tier_Entries", SourceObject: "PriceAdjustmentTier" },
];

/** §Reproduces the real live symptom — every row's MasterLabel comes back as the generic Salesforce
 * placeholder "Decision Tables" (exactly what the screenshot showed for VolumeTierDiscount), so the
 * resolver must fall through to DeveloperName to find the real, correct table. */
const GENERIC_MASTERLABEL_ORG_ROWS: Row[] = REALISTIC_ORG_ROWS.map(r => ({ ...r, MasterLabel: "Decision Tables" }));

function buildMockClient(rows: Row[]): SalesforceClient {
  return {
    async describeObject() { return DESCRIBE_WITH_ALL_FIELDS; },
    async query<T>() { return { records: rows as unknown as T[], totalSize: rows.length, done: true }; },
    async toolingQuery<T>() { return { records: rows as unknown as T[], totalSize: rows.length, done: true }; },
  } as unknown as SalesforceClient;
}

test("Test 1 — ListPrice resolves to Price Book Entries V2", async () => {
  const client = buildMockClient(REALISTIC_ORG_ROWS);
  const result = await resolvePriceBookEntriesV2DecisionTable(client);
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.equal(result.table.id, "0Dt000000000001");
});

test("Test 2 — \"Price Book Entries\" (no V2) must NEVER substitute for \"Price Book Entries V2\"", async () => {
  const client = buildMockClient(REALISTIC_ORG_ROWS.filter(r => r.MasterLabel !== "Price Book Entries V2"));
  const result = await resolvePriceBookEntriesV2DecisionTable(client);
  assert.equal(result.status, "not-found", "must not silently fall back to the non-V2 table via any tier");
});

test("Test 3 — VolumeTierDiscount resolves to Tiered Adjustment Entries", async () => {
  const client = buildMockClient(REALISTIC_ORG_ROWS);
  const result = await resolveTieredAdjustmentEntriesDecisionTable(client);
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.equal(result.table.id, "0Dt000000000003");
});

test("Test 4 — VolumeDiscount resolves to Volume Discount Entries", async () => {
  const client = buildMockClient(REALISTIC_ORG_ROWS);
  const result = await resolveVolumeDiscountEntriesDecisionTable(client);
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.equal(result.table.id, "0Dt000000000004");
});

test("Test 5 — VolumeTierDiscount must NEVER resolve to Volume Discount Entries (Tiered Adjustment Entries absent)", async () => {
  const client = buildMockClient(REALISTIC_ORG_ROWS.filter(r => r.MasterLabel !== "Tiered Adjustment Entries"));
  const result = await resolveTieredAdjustmentEntriesDecisionTable(client);
  assert.equal(result.status, "not-found", "must not cross-map to Volume Discount Entries");
});

test("Test 6 — VolumeDiscount must NEVER resolve to Tiered Adjustment Entries (Volume Discount Entries absent)", async () => {
  const client = buildMockClient(REALISTIC_ORG_ROWS.filter(r => r.MasterLabel !== "Volume Discount Entries"));
  const result = await resolveVolumeDiscountEntriesDecisionTable(client);
  assert.equal(result.status, "not-found", "must not cross-map to Tiered Adjustment Entries");
});

test("Test 7 — a generic \"Decision Tables\" MasterLabel (present on EVERY row) does not cause incorrect mapping for any of the 3 targets", async () => {
  const client = buildMockClient(GENERIC_MASTERLABEL_ORG_ROWS);

  const pb = await resolvePriceBookEntriesV2DecisionTable(client);
  assert.equal(pb.status, "resolved");
  if (pb.status === "resolved") { assert.equal(pb.table.id, "0Dt000000000001"); assert.equal(pb.mechanism, "normalized-developer-name"); }

  const tier = await resolveTieredAdjustmentEntriesDecisionTable(client);
  assert.equal(tier.status, "resolved");
  if (tier.status === "resolved") { assert.equal(tier.table.id, "0Dt000000000003"); assert.equal(tier.mechanism, "normalized-developer-name"); }

  const vol = await resolveVolumeDiscountEntriesDecisionTable(client);
  assert.equal(vol.status, "resolved");
  if (vol.status === "resolved") { assert.equal(vol.table.id, "0Dt000000000004"); assert.equal(vol.mechanism, "normalized-developer-name"); }

  // Independence: none of the 3 resolved to the same record as another.
  const ids = new Set([pb, tier, vol].map(r => (r.status === "resolved" ? r.table.id : null)));
  assert.equal(ids.size, 3, "all three semantic targets must resolve to three DISTINCT DecisionTable records");
});

test("§Regression — ambiguous DeveloperName match (2 rows) once MasterLabel is generic must fail closed, never pick the first", async () => {
  const duplicated: Row[] = [
    ...GENERIC_MASTERLABEL_ORG_ROWS,
    { Id: "0Dt000000000099", MasterLabel: "Decision Tables", DeveloperName: "Price_Book_Entries_V2", SourceObject: "PricebookEntry" },
  ];
  const client = buildMockClient(duplicated);
  const result = await resolvePriceBookEntriesV2DecisionTable(client);
  assert.equal(result.status, "ambiguous");
});
