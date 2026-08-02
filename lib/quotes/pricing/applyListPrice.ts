import type { SalesforceClient } from "@/lib/salesforce/client";
import type { FlatDraftItem } from "@/lib/quotes/bundles/relationshipCreate";
import type { QuoteLineItemFieldSchema } from "@/lib/quotes/types";
import { netUnitPrice as computeNetUnitPrice, lineTotal } from "@/lib/quotes/pricing/calc";

export interface ListPriceApplicationResult {
  attempted: boolean;
  appliedCount: number;
  /** Bundle children whose price is included in the parent bundle's price — intentionally left at whatever Salesforce/creation produced, never forced to list price (§established bundle pricing rule). */
  skippedIncludedCount: number;
  failedIds: string[];
  fieldsUsed: { netUnitPriceField: string | null; netTotalPriceField: string | null; unitPriceField: string | null; totalPriceField: string | null };
  issues: string[];
}

/**
 * §User directive (explicit, not a Salesforce-behavior inference): the
 * product price must never be $0 — it must be the PricebookEntry's own
 * List Price, with the line's discount applied if any. This intentionally
 * bypasses Salesforce Revenue Cloud's Instant Pricing engine entirely
 * (`lib/quotes/pricing/reprice.ts`, kept in the codebase but no longer
 * called from the main creation flow) — after 5 rounds of that endpoint
 * failing or returning unusable per-record errors, the user chose a
 * deterministic, always-correct alternative over continuing to depend on
 * it. Net Unit Price / Net Total Price (or Unit Price / Total Price, on an
 * org with no Net* fields at all) are computed directly from
 * `draft.unitPrice` and `draft.discountPercent`, using the exact same
 * formula as the client-side Preview (`lib/quotes/pricing/calc.ts`) so the
 * number a user sees pre-save is the number that gets persisted.
 *
 * §Uses `draft.unitPrice`, NOT `draft.product.listPrice` directly: for a
 * ManualPricing org the "Unit $" field is user-editable (LineItemTree.tsx),
 * so `draft.unitPrice` may be a deliberately customized price, not the raw
 * catalog List Price — using the raw catalog value would silently discard
 * that customization. For a RevenueCloudPricing org that field is hidden
 * and the caller keeps `draft.unitPrice` in lockstep with the freshly
 * re-resolved List Price, so this is equivalent to the catalog price
 * there. Either way, `draft.unitPrice` is the correct "list price,
 * possibly manually adjusted" input for every org.
 *
 * §Never force-write a calculated/read-only field: every target field is
 * gated on `qliSchema.pricingModelDiagnosis.evidence`'s real Describe
 * `updateable` flag (already resolved, never re-guessed here) — a field
 * Salesforce reports as calculated/non-updateable is simply never included
 * in the update payload, exactly like every other write path in this app.
 *
 * §Bundle pricing is preserved: a line whose `pricingInclusion` is true
 * (its price is included in its parent bundle's price) is skipped entirely
 * — its $0 is legitimate and must not be overwritten.
 */
export async function applyListPriceFallback(
  client: SalesforceClient,
  qliSchema: QuoteLineItemFieldSchema,
  flatItems: FlatDraftItem[],
  idByIndex: Map<number, string>,
): Promise<ListPriceApplicationResult> {
  const evidence = qliSchema.pricingModelDiagnosis.evidence;
  const netUnitPriceField = evidence.netUnitPrice?.updateable ? evidence.netUnitPrice.apiName : null;
  const netTotalPriceField = evidence.netTotalPrice?.updateable ? evidence.netTotalPrice.apiName : null;
  // §Sales Price double-discount fix — this doc comment already said "Unit
  // Price / Total Price, on an org with no Net* fields at all", but the
  // code below it did NOT implement that: it treated plain UnitPrice as a
  // discounted-value WRITE TARGET whenever it was updateable and merely
  // differently-named from NetUnitPriceField, regardless of whether
  // NetUnitPriceField itself existed. On an org that has BOTH (confirmed by
  // a manual reference QLI: Sales Price stayed 1149, Net Unit Price became
  // 1034.10 after a 10% discount — two genuinely distinct, independently
  // queryable Salesforce fields), that meant this function ALSO overwrote
  // UnitPrice ("Sales Price" — the pre-discount input Salesforce's own
  // pricing engine reads FROM) with the discounted result, right after
  // create-time correctly wrote 1149 into it.
  //
  // Gated on whether a NetUnitPrice/NetTotalPrice field EXISTS at all
  // (`evidence.netUnitPrice`/`evidence.netTotalPrice`), not merely whether
  // THIS app can directly write it (`netUnitPriceField`/`netTotalPriceField`
  // above, which also requires `updateable`): an org can have a genuine,
  // Salesforce-engine-owned Net Unit Price concept that only `repriceQuote`
  // (never a direct compositeUpdate) is allowed to set — Sales Price must
  // stay protected either way. UnitPrice/TotalPrice are only valid
  // discounted-value fallback targets when this org has NO Net* field
  // concept at all — i.e. Sales Price is this org's ONLY price-ish field
  // and must double as both list and net (a true ManualPricing org).
  const unitPriceField = !evidence.netUnitPrice && evidence.unitPrice?.updateable ? evidence.unitPrice.apiName : null;
  const totalPriceField = !evidence.netTotalPrice && evidence.totalPrice?.updateable ? evidence.totalPrice.apiName : null;
  const fieldsUsed = { netUnitPriceField, netTotalPriceField, unitPriceField, totalPriceField };

  if (!netUnitPriceField && !unitPriceField) {
    return {
      attempted: false, appliedCount: 0, skippedIncludedCount: 0, failedIds: [], fieldsUsed,
      issues: [
        `Neither Net Unit Price (${evidence.netUnitPrice?.apiName ?? "not found"}) nor Unit Price (${evidence.unitPrice?.apiName ?? "not found"}) is writable on this org's QuoteLineItem ` +
        `(calculated=${evidence.unitPrice?.calculated ?? "n/a"}, updateable=${evidence.unitPrice?.updateable ?? "n/a"}) — this app cannot write List Price into any price field here; Salesforce's own pricing engine would need to own it exclusively.`,
      ],
    };
  }

  let skippedIncludedCount = 0;
  const updates: { Id: string; [key: string]: unknown }[] = [];
  const updateItemByIndex = new Map<string, FlatDraftItem>();

  for (const item of flatItems) {
    const id = idByIndex.get(item.index);
    if (!id) continue;
    if (item.draft.pricingInclusion) { skippedIncludedCount++; continue; }

    const unit = computeNetUnitPrice(item.draft.unitPrice, item.draft.discountPercent);
    const total = lineTotal(item.draft.quantity, unit);
    const record: { Id: string; [key: string]: unknown } = { Id: id };
    if (netUnitPriceField) record[netUnitPriceField] = unit;
    if (netTotalPriceField) record[netTotalPriceField] = total;
    if (unitPriceField) record[unitPriceField] = unit;
    if (totalPriceField) record[totalPriceField] = total;
    updates.push(record);
    updateItemByIndex.set(id, item);
  }

  if (updates.length === 0) {
    return { attempted: true, appliedCount: 0, skippedIncludedCount, failedIds: [], fieldsUsed, issues: [] };
  }

  console.log(
    `[applyListPriceFallback] Writing list-price-derived values for ${updates.length} line(s) via ` +
    `${netUnitPriceField ?? unitPriceField}${netTotalPriceField || totalPriceField ? ` / ${netTotalPriceField ?? totalPriceField}` : ""} ` +
    `(${skippedIncludedCount} bundle-included child line(s) skipped).`,
  );

  const failedIds: string[] = [];
  const issues: string[] = [];
  try {
    const chunkSize = 200;
    for (let offset = 0; offset < updates.length; offset += chunkSize) {
      const chunk = updates.slice(offset, offset + chunkSize);
      const results = await client.compositeUpdate("QuoteLineItem", chunk, false);
      for (let i = 0; i < results.length; i++) {
        if (!results[i].success) {
          failedIds.push(chunk[i].Id);
          const item = updateItemByIndex.get(chunk[i].Id);
          issues.push(`Failed to write list price for "${item?.draft.product.name ?? chunk[i].Id}": ${results[i].errors?.[0]?.message ?? "unknown error"}.`);
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[applyListPriceFallback] compositeUpdate failed:`, message);
    return { attempted: true, appliedCount: 0, skippedIncludedCount, failedIds: updates.map(u => u.Id), fieldsUsed, issues: [`Failed to write list price for any line: ${message}`] };
  }

  if (failedIds.length > 0) {
    console.error(`[applyListPriceFallback] ${failedIds.length} of ${updates.length} update(s) rejected by Salesforce:`, JSON.stringify(issues));
  }

  return { attempted: true, appliedCount: updates.length - failedIds.length, skippedIncludedCount, failedIds, fieldsUsed, issues };
}
