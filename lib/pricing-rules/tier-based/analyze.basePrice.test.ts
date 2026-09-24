/**
 * §Rollback — restores the pre-"Current List Price" Base Price architecture: the user supplies Base Price
 * in the prompt (or the UI edits it), and it flows straight through `analyzeTierBasedPrompt` with NO
 * Standard Price Book Entry resolution gating the analysis/review stage at all (that gate, and the
 * `CurrentListPrice`/`list-price-unresolved` stage it introduced, have been removed). Product2's own
 * `basePrice` — resolved non-fatally, best-effort, by `productLookup.ts`'s `enrichProduct` (untouched by
 * this rollback) — is only a fallback used when neither the prompt nor the UI supplied one.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { analyzeTierBasedPrompt } from "./analyze";
import type { ExtractedTierPricingRequirement } from "./types";

const PRODUCT_ID = "01t000000000001";

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
        return { records: [{ Id: PRODUCT_ID, Name: "Printer", ProductCode: "PR-1", IsActive: true }] as unknown as T[], totalSize: 1, done: true };
      }
      return { records: [] as unknown as T[], totalSize: 0, done: true };
    },
  } as unknown as SalesforceClient;
}

function extractedWithBasePrice(basePrice: number | null): ExtractedTierPricingRequirement {
  return {
    pricingType: "tier-based", productName: "Printer", basePrice,
    volumeTiers: [
      { lowerBound: 1, upperBound: 10, tierType: "Amount", tierValue: 50 },
      { lowerBound: 11, upperBound: null, tierType: "Amount", tierValue: 100 },
    ],
    currency: null, effectiveFrom: null, effectiveTo: null, otherNotes: [],
  };
}

test("Test 1 — prompt with 'Base Price: 2000' -> analyze extracts and carries basePrice = 2000", async () => {
  const client = buildMockClient();
  const result = await analyzeTierBasedPrompt(client, "fake-key", { extracted: extractedWithBasePrice(2000), selectedProductId: PRODUCT_ID });
  assert.equal(result.stage, "ready-for-review");
  if (result.stage !== "ready-for-review") return;
  assert.equal(result.basePrice, 2000, "the prompt-supplied Base Price must win over any Salesforce-derived price");
});

test("Test 3 (payload propagation, analyze half) — a basePriceOverride from the UI takes priority over both the extracted and product-derived price", async () => {
  const client = buildMockClient();
  const result = await analyzeTierBasedPrompt(client, "fake-key", {
    extracted: extractedWithBasePrice(2000), selectedProductId: PRODUCT_ID, basePriceOverride: 2500,
  });
  assert.equal(result.stage, "ready-for-review");
  if (result.stage !== "ready-for-review") return;
  assert.equal(result.basePrice, 2500, "an explicit user edit in the UI must override the originally-extracted value");
});

test("Test 4 — no Standard Price Book Entry at all -> analysis/review does NOT fail solely because of that", async () => {
  const client = buildMockClient({ pricebookEntryFails: true });
  const result = await analyzeTierBasedPrompt(client, "fake-key", { extracted: extractedWithBasePrice(2000), selectedProductId: PRODUCT_ID });
  assert.equal(result.stage, "ready-for-review", "a missing/unresolvable Standard Price Book Entry must never block tier-based analysis — there is no such prerequisite any more");
  if (result.stage !== "ready-for-review") return;
  assert.equal(result.basePrice, 2000, "the prompt's Base Price still wins even when Salesforce has no Price Book Entry to fall back to");
});

test("Test 5 — no Base Price anywhere (prompt, override, or Price Book) -> falls back to 0, exactly like the previous implementation, never blocks", async () => {
  const client = buildMockClient({ pricebookEntryFails: true });
  const result = await analyzeTierBasedPrompt(client, "fake-key", { extracted: extractedWithBasePrice(null), selectedProductId: PRODUCT_ID });
  assert.equal(result.stage, "ready-for-review");
  if (result.stage !== "ready-for-review") return;
  assert.equal(result.basePrice, 0);
});

test("no 'list-price-unresolved' stage exists any more — the type union only has the pre-rollback stages", async () => {
  const client = buildMockClient({ pricebookEntryFails: true });
  const result = await analyzeTierBasedPrompt(client, "fake-key", { extracted: extractedWithBasePrice(2000), selectedProductId: PRODUCT_ID });
  assert.notEqual((result as { stage: string }).stage, "list-price-unresolved");
});

test("needs-tiers stage carries no currentListPrice/CurrentListPrice field (rolled back)", async () => {
  const client = buildMockClient();
  const noTiers = { ...extractedWithBasePrice(2000), volumeTiers: [] };
  const result = await analyzeTierBasedPrompt(client, "fake-key", { extracted: noTiers, selectedProductId: PRODUCT_ID });
  assert.equal(result.stage, "needs-tiers");
  assert.ok(!("currentListPrice" in result));
});
