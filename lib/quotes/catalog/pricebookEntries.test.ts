/**
 * Selling-model-aware PricebookEntry choice — the root cause of a quote-line 422 ("Add a Billing Treatment to make
 * sure that you can change the Billing Frequency…"): the old re-resolution kept one entry per product and replaced the
 * Yearly entry with the Monthly one. Shapes are p12's "API Access Premium" (Yearly ₹70 / Monthly ₹75, Standard Price Book).
 *
 * Run: `npx tsx --test lib/quotes/catalog/pricebookEntries.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePricebookEntry, type ActivePricebookEntry } from "./pricebookEntries";

const PRODUCT = "01tg5000008Hxp1AAC", YEARLY = "0jPg50000006nJ3EAI", MONTHLY = "0jPg50000006nJ5EAI";
const yearly: ActivePricebookEntry = { pricebookEntryId: "01ug5000002dYPeAAM", productId: PRODUCT, listPrice: 70, sellingModelId: YEARLY };
const monthly: ActivePricebookEntry = { pricebookEntryId: "01ug5000002dYOtAAM", productId: PRODUCT, listPrice: 75, sellingModelId: MONTHLY };

test("a Yearly line keeps its Yearly entry even when the Monthly entry is returned last (the observed bug)", () => {
  const r = choosePricebookEntry([yearly, monthly], yearly.pricebookEntryId, YEARLY, { legacyFallback: monthly });
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.entry.pricebookEntryId, yearly.pricebookEntryId); assert.equal(r.entry.listPrice, 70); assert.equal(r.reason, "draft-entry-active"); }
});

test("a draft carrying the other selling model's entry is corrected to its own selling model's entry", () => {
  const r = choosePricebookEntry([yearly, monthly], monthly.pricebookEntryId, YEARLY);
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.entry.pricebookEntryId, yearly.pricebookEntryId); assert.equal(r.reason, "selling-model-match"); }
});

test("no active entry for the line's selling model fails instead of switching selling models", () => {
  const r = choosePricebookEntry([monthly], monthly.pricebookEntryId, YEARLY);
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.code, "NO_ENTRY_FOR_SELLING_MODEL"); assert.match(r.reason, /no active PricebookEntry for the selected selling model/); }
  const none = choosePricebookEntry([], yearly.pricebookEntryId, YEARLY);
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.code, "NO_ACTIVE_ENTRY");
});

test("15- and 18-character Ids compare equal", () => {
  const r = choosePricebookEntry([yearly, monthly], yearly.pricebookEntryId.slice(0, 15), YEARLY.slice(0, 15));
  assert.ok(r.ok && r.entry === yearly);
});

test("without a selling model: keep the draft's active entry; single entry; ambiguity is never silently resolved", () => {
  assert.equal(choosePricebookEntry([yearly, monthly], monthly.pricebookEntryId, null).ok && "draft", "draft");
  const only = choosePricebookEntry([yearly], "01u000000000000AAA", null);
  assert.ok(only.ok && only.reason === "only-entry");
  const amb = choosePricebookEntry([yearly, monthly], "01u000000000000AAA", null);
  assert.equal(amb.ok, false);
  if (!amb.ok) assert.equal(amb.code, "AMBIGUOUS_ENTRY");
  const legacy = choosePricebookEntry([yearly, monthly], "01u000000000000AAA", null, { legacyFallback: monthly });
  assert.ok(legacy.ok && legacy.reason === "legacy-fallback", "existing callers without a selling model keep their old behaviour");
});

test("orgs without PricebookEntry.ProductSellingModelId fall back to the draft's own entry", () => {
  const a = { ...yearly, sellingModelId: null }, b = { ...monthly, sellingModelId: null };
  const r = choosePricebookEntry([a, b], a.pricebookEntryId, YEARLY);
  assert.ok(r.ok && r.entry === a);
});
