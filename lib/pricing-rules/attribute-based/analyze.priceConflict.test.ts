/**
 * §Phase 6 fix (MASTER FIX turn) — `analyzeAttributeBasedPrompt` previously extracted `basePrice` from
 * the AI prompt but never compared it against anything; a prompt-stated base price disagreeing with
 * Salesforce's real Standard Pricebook price was silently ignored. Now surfaced as a `price-conflict`
 * stage requiring an explicit `USE_EXISTING`/`USE_NEW` decision (Step 6 of the fix spec) before the
 * pipeline proceeds any further — never resolved either way without the user's say-so, and this
 * read-only analysis module never writes to Salesforce regardless of which is chosen.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { analyzeAttributeBasedPrompt } from "./analyze";
import type { ExtractedPricingRequirement } from "./types";

function buildExtracted(basePrice: number | null): ExtractedPricingRequirement {
  return {
    pricingType: "attribute-based", product: "Laptop Pro", attributes: [], conditions: [], combinations: [],
    currency: "USD", basePrice, effectiveFrom: null, effectiveTo: null, otherNotes: [],
  };
}

/** Mocks exactly Product2 name resolution + its price/currency enrichment (`productLookup.ts`'s
 * `enrichProduct`) — every OTHER query (attribute discovery and its many internal fallback queries, all
 * individually try/catch-wrapped in `discoverAttributes.ts`) is left to fail as "unexpected query",
 * which that module already treats as a non-fatal warning, naturally landing on `no-attributes-found`
 * (proving the pipeline proceeded PAST the price check) without needing to hand-mock its full internals.
 */
function buildClient(unitPrice: number | null): SalesforceClient {
  return {
    async query(soql: string) {
      if (soql.includes("FROM Product2 WHERE Name = ")) {
        return { totalSize: 1, done: true, records: [{ Id: "prod-1", Name: "Laptop Pro", ProductCode: "LP-1", IsActive: true }] };
      }
      if (soql.includes("SELECT CurrencyIsoCode")) return { totalSize: 1, done: true, records: [{ CurrencyIsoCode: "USD" }] };
      if (soql.includes("FROM PricebookEntry")) {
        return { totalSize: unitPrice !== null ? 1 : 0, done: true, records: unitPrice !== null ? [{ UnitPrice: unitPrice }] : [] };
      }
      throw new Error(`unexpected query (attribute discovery — expected to be caught internally as a warning): ${soql}`);
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}

test("TEST — Phase 6: a prompt-stated base price disagreeing with Salesforce's real price returns price-conflict, never silently resolved", async () => {
  const client = buildClient(50000);
  const result = await analyzeAttributeBasedPrompt(client, "unused-api-key", { extracted: buildExtracted(55000) });

  assert.equal(result.stage, "price-conflict");
  if (result.stage === "price-conflict") {
    assert.equal(result.existingBasePrice, 50000);
    assert.equal(result.requestedBasePrice, 55000);
    assert.equal(result.product.id, "prod-1");
  }
});

test("TEST — Phase 6: a prompt-stated base price that MATCHES Salesforce's real price never triggers a conflict", async () => {
  const client = buildClient(50000);
  const result = await analyzeAttributeBasedPrompt(client, "unused-api-key", { extracted: buildExtracted(50000) });

  assert.notEqual(result.stage, "price-conflict");
  assert.equal(result.stage, "no-attributes-found", "must proceed past the price check to attribute discovery");
});

test("TEST — Phase 6: a prompt that never states a base price never triggers a conflict (nothing to compare)", async () => {
  const client = buildClient(50000);
  const result = await analyzeAttributeBasedPrompt(client, "unused-api-key", { extracted: buildExtracted(null) });

  assert.notEqual(result.stage, "price-conflict");
  assert.equal(result.stage, "no-attributes-found");
});

test("TEST — Phase 6: USE_EXISTING decision proceeds past the conflict without re-triggering it", async () => {
  const client = buildClient(50000);
  const result = await analyzeAttributeBasedPrompt(client, "unused-api-key", {
    extracted: buildExtracted(55000), overrides: { basePriceDecision: "USE_EXISTING" },
  });

  assert.notEqual(result.stage, "price-conflict");
  assert.equal(result.stage, "no-attributes-found");
});

test("TEST — Phase 6: USE_NEW decision proceeds past the conflict without re-triggering it", async () => {
  const client = buildClient(50000);
  const result = await analyzeAttributeBasedPrompt(client, "unused-api-key", {
    extracted: buildExtracted(55000), overrides: { basePriceDecision: "USE_NEW" },
  });

  assert.notEqual(result.stage, "price-conflict");
  assert.equal(result.stage, "no-attributes-found");
});

test("TEST — Phase 6: no Standard Pricebook entry (existing price unknown) never triggers a conflict — nothing safe to compare against", async () => {
  const client = buildClient(null);
  const result = await analyzeAttributeBasedPrompt(client, "unused-api-key", { extracted: buildExtracted(55000) });

  assert.notEqual(result.stage, "price-conflict");
  assert.equal(result.stage, "no-attributes-found");
});
