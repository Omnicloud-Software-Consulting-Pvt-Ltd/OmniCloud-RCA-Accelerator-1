/**
 * §Rollback — mirrors lib/pricing-rules/tier-based/analyze.basePrice.test.ts exactly, for the Volume-Based
 * module. Restores the pre-"Current List Price" Base Price architecture: the user supplies Base Price in
 * the prompt (or the UI edits it), and it flows straight through `analyzeVolumeBasedPrompt` with NO Standard
 * Price Book Entry resolution gating the analysis/review stage at all.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { analyzeVolumeBasedPrompt } from "./analyze";
import type { ExtractedVolumePricingRequirement } from "./types";

const PRODUCT_ID = "01t000000000002";

function buildMockClient(opts: { pricebookEntryFails?: boolean } = {}): SalesforceClient {
  return {
    async query<T>(soql: string) {
      if (soql.startsWith("SELECT CurrencyIsoCode FROM Product2")) {
        return { records: [{ CurrencyIsoCode: "USD" }] as unknown as T[], totalSize: 1, done: true };
      }
      if (soql.includes("FROM PricebookEntry")) {
        if (opts.pricebookEntryFails) throw new Error("No active Standard Price Book Entry for this product.");
        return { records: [{ UnitPrice: 1200 }] as unknown as T[], totalSize: 1, done: true };
      }
      if (soql.includes("FROM Product2")) {
        return { records: [{ Id: PRODUCT_ID, Name: "Keyboard", ProductCode: "KB-1", IsActive: true }] as unknown as T[], totalSize: 1, done: true };
      }
      return { records: [] as unknown as T[], totalSize: 0, done: true };
    },
  } as unknown as SalesforceClient;
}

function extractedWithBasePrice(basePrice: number | null): ExtractedVolumePricingRequirement {
  return {
    pricingType: "volume-based", productName: "Keyboard", basePrice,
    volumeTiers: [
      { lowerBound: 1, upperBound: 10, tierType: "Override", tierValue: 1000 },
      { lowerBound: 11, upperBound: null, tierType: "Override", tierValue: 700 },
    ],
    currency: null, effectiveFrom: null, effectiveTo: null, otherNotes: [],
  };
}

test("Test 1 — prompt with 'Base Price: 2000' -> analyze extracts and carries basePrice = 2000", async () => {
  const client = buildMockClient();
  const result = await analyzeVolumeBasedPrompt(client, "fake-key", { extracted: extractedWithBasePrice(2000), selectedProductId: PRODUCT_ID });
  assert.equal(result.stage, "ready-for-review");
  if (result.stage !== "ready-for-review") return;
  assert.equal(result.basePrice, 2000);
});

test("Test 3 (payload propagation, analyze half) — a basePriceOverride from the UI takes priority", async () => {
  const client = buildMockClient();
  const result = await analyzeVolumeBasedPrompt(client, "fake-key", {
    extracted: extractedWithBasePrice(2000), selectedProductId: PRODUCT_ID, basePriceOverride: 2500,
  });
  assert.equal(result.stage, "ready-for-review");
  if (result.stage !== "ready-for-review") return;
  assert.equal(result.basePrice, 2500);
});

test("Test 4 — no Standard Price Book Entry at all -> analysis/review does NOT fail solely because of that", async () => {
  const client = buildMockClient({ pricebookEntryFails: true });
  const result = await analyzeVolumeBasedPrompt(client, "fake-key", { extracted: extractedWithBasePrice(2000), selectedProductId: PRODUCT_ID });
  assert.equal(result.stage, "ready-for-review", "a missing/unresolvable Standard Price Book Entry must never block volume-based analysis");
  if (result.stage !== "ready-for-review") return;
  assert.equal(result.basePrice, 2000);
});

test("Test 5 — no Base Price anywhere -> falls back to 0, never blocks", async () => {
  const client = buildMockClient({ pricebookEntryFails: true });
  const result = await analyzeVolumeBasedPrompt(client, "fake-key", { extracted: extractedWithBasePrice(null), selectedProductId: PRODUCT_ID });
  assert.equal(result.stage, "ready-for-review");
  if (result.stage !== "ready-for-review") return;
  assert.equal(result.basePrice, 0);
});

test("no 'list-price-unresolved' stage exists any more", async () => {
  const client = buildMockClient({ pricebookEntryFails: true });
  const result = await analyzeVolumeBasedPrompt(client, "fake-key", { extracted: extractedWithBasePrice(2000), selectedProductId: PRODUCT_ID });
  assert.notEqual((result as { stage: string }).stage, "list-price-unresolved");
});

test("needs-tiers stage carries no currentListPrice/CurrentListPrice field (rolled back)", async () => {
  const client = buildMockClient();
  const noTiers = { ...extractedWithBasePrice(2000), volumeTiers: [] };
  const result = await analyzeVolumeBasedPrompt(client, "fake-key", { extracted: noTiers, selectedProductId: PRODUCT_ID });
  assert.equal(result.stage, "needs-tiers");
  assert.ok(!("currentListPrice" in result));
});
