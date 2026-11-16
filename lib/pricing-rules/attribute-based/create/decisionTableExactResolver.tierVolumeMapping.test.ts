/**
 * Tier-Based / Volume-Based Decision Table mapping: the explicit pricing-type → table mapping, the column
 * signature that tells the two PriceAdjustmentTier-sourced tables apart, the LookUpName a step carries,
 * and the required failure messages. Column/identity values mirror a live org's real tables; Ids are fake.
 * Run with `npx tsx --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRICING_TYPE_DECISION_TABLE, requiredDecisionTableMessage, checkPricingDecisionTableColumns, decisionTableLookupName,
  PRICE_BOOK_DECISION_TABLE_LABEL, type ExactDecisionTableResolution,
} from "./decisionTableExactResolver";

const TIERED_INPUTS = ["PriceAdjustmentScheduleId", "Product2Id", "ProductSellingModelId", "EffectiveFrom", "EffectiveTo"];
const TIERED_OUTPUTS = ["TierType", "TierValue", "UpperBound", "LowerBound"];
const VOLUME_INPUTS = ["PriceAdjustmentScheduleId", "LowerBound", "UpperBound", "Product2Id", "ProductSellingModelId", "EffectiveFrom", "EffectiveTo"];
const VOLUME_OUTPUTS = ["TierValue", "TierType"];

test("each pricing type maps to exactly its own Decision Table", () => {
  assert.equal(PRICING_TYPE_DECISION_TABLE["tier-based"], "Tiered Adjustment Entries");
  assert.equal(PRICING_TYPE_DECISION_TABLE["volume-based"], "Volume Discount Entries");
});

test("the real tables pass their own pricing type's column check", () => {
  assert.deepEqual(checkPricingDecisionTableColumns("tier-based", TIERED_INPUTS, TIERED_OUTPUTS), []);
  assert.deepEqual(checkPricingDecisionTableColumns("volume-based", VOLUME_INPUTS, VOLUME_OUTPUTS), []);
});

test("cross-mapping is rejected by column shape: Volume Discount Entries can't serve Tier-Based, and vice versa", () => {
  assert.match(checkPricingDecisionTableColumns("tier-based", VOLUME_INPUTS, VOLUME_OUTPUTS).join(" "), /Tiered Adjustment Entries/);
  assert.match(checkPricingDecisionTableColumns("volume-based", TIERED_INPUTS, TIERED_OUTPUTS).join(" "), /Volume Discount Entries/);
});

test("LookUpName is the table's real name, never the shared 'Decision Tables' MasterLabel placeholder", () => {
  const resolved = (mechanism: "exact-setup-name" | "normalized-developer-name"): Extract<ExactDecisionTableResolution, { status: "resolved" }> => ({
    status: "resolved", mechanism,
    table: { id: "0lDFAKE0000000001", masterLabel: "Decision Tables", developerName: "Tiered_Adjustment_Tier_Decision_Table", setupName: "Tiered Adjustment Entries", sourceObject: "PriceAdjustmentTier" },
  });
  assert.equal(decisionTableLookupName(resolved("exact-setup-name"), "Tiered Adjustment Entries"), "Tiered Adjustment Entries");
  assert.equal(decisionTableLookupName(resolved("normalized-developer-name"), "Tiered Adjustment Entries"), "Tiered Adjustment Entries");
});

test("resolution failures use the required messages", () => {
  assert.equal(requiredDecisionTableMessage("tier-based"), "Tier-Based Pricing requires the Decision Table 'Tiered Adjustment Entries', but it could not be resolved in Salesforce.");
  assert.equal(requiredDecisionTableMessage("volume-based"), "Volume-Based Pricing requires the Decision Table 'Volume Discount Entries', but it could not be resolved in Salesforce.");
});

test("Price Book Entries lookup is named 'Price Book Entries V2', never 'Decision Tables'", () => {
  const pb: Extract<ExactDecisionTableResolution, { status: "resolved" }> = {
    status: "resolved", mechanism: "exact-setup-name",
    table: { id: "0lDFAKE0000000002", masterLabel: "Decision Tables", developerName: "Price_Book_Entry_Decision_Table_v2", setupName: "Price Book Entries V2", sourceObject: "PricebookEntry" },
  };
  assert.equal(decisionTableLookupName(pb, PRICE_BOOK_DECISION_TABLE_LABEL), "Price Book Entries V2");
});

test("each builder names every lookup step after its OWN table — price book on ListPrice, tier/volume on the discount step", () => {
  const expected: Record<string, [string, string][]> = {
    "../../tier-based/create/canvasBuilder.ts": [
      ["pbResolvedName", "decisionTableLookupName(pbDtResolution, PRICE_BOOK_DECISION_TABLE_LABEL)"],
      ["tierResolvedName", "decisionTableLookupName(tierDtResolution, TIERED_ADJUSTMENT_DECISION_TABLE_LABEL)"],
    ],
    "../../volume-based/create/canvasBuilder.ts": [
      ["pbResolvedName", "decisionTableLookupName(pbDtResolution, PRICE_BOOK_DECISION_TABLE_LABEL)"],
      ["vtdResolvedName", "decisionTableLookupName(vtdResolution, VOLUME_DISCOUNT_DECISION_TABLE_LABEL)"],
    ],
  };
  for (const [file, pairs] of Object.entries(expected)) {
    const src = readFileSync(join(__dirname, file), "utf8");
    for (const [variable, expression] of pairs) {
      assert.ok(src.includes(`const ${variable} = ${expression};`), `${file}: ${variable} must be ${expression}`);
    }
    assert.doesNotMatch(src, /ResolvedName = [^;]*masterLabel/, `${file}: no lookup name may be derived from MasterLabel`);
  }
});
