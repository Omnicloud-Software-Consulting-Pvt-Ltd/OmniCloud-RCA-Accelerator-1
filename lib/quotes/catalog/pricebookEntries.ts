/**
 * Selling-model-aware PricebookEntry re-resolution for Quote Line Item and Order Item creation.
 *
 * A Revenue Cloud product can have one active PricebookEntry PER selling model in the same price book (e.g. "API Access
 * Premium": Term Based - Yearly ₹70 and Term Based - Monthly ₹75). QuoteLineItem/OrderItem.ProductSellingModelId is not
 * writable — Salesforce derives the line's selling model from its PricebookEntry — so picking the wrong entry silently
 * switches the line to another selling model. The previous re-resolution (`fetchCatalogProductsByIds`) kept ONE entry per
 * product (whichever row came last) and replaced the draft's entry with it, which turned a Yearly line into a Monthly one;
 * with BillingFrequency = Annual Salesforce then rejected it: "Add a Billing Treatment to make sure that you can change the
 * Billing Frequency of its related Quote Line Item" (422 CREATE_FAILED).
 */
import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";

export interface ActivePricebookEntry {
  pricebookEntryId: string;
  productId: string;
  listPrice: number;
  /** PricebookEntry.ProductSellingModelId; null when the org has no such field or the entry has no selling model. */
  sellingModelId: string | null;
}

/** Every active entry per product in the price book (not just one). */
export async function fetchActivePricebookEntries(client: SalesforceClient, pricebookId: string, productIds: string[]): Promise<Map<string, ActivePricebookEntry[]>> {
  const out = new Map<string, ActivePricebookEntry[]>();
  if (!productIds.length) return out;
  const pbe = await describeObjectCached(client, "PricebookEntry").catch(() => null);
  const hasPsm = !!pbe?.fields.some(f => f.name === "ProductSellingModelId");
  for (let i = 0; i < productIds.length; i += 100) {
    const ids = productIds.slice(i, i + 100).map(id => `'${soqlEscape(id)}'`).join(",");
    const res = await client.query<Record<string, unknown>>(
      `SELECT Id, Product2Id, UnitPrice${hasPsm ? ", ProductSellingModelId" : ""} FROM PricebookEntry WHERE Pricebook2Id = '${soqlEscape(pricebookId)}' AND IsActive = true AND Product2Id IN (${ids}) ORDER BY Id`,
    );
    for (const r of res.records) {
      const e: ActivePricebookEntry = { pricebookEntryId: r.Id as string, productId: r.Product2Id as string, listPrice: (r.UnitPrice as number) ?? 0, sellingModelId: hasPsm ? ((r.ProductSellingModelId as string) ?? null) : null };
      out.set(e.productId, [...(out.get(e.productId) ?? []), e]);
    }
  }
  return out;
}

export type PricebookEntryChoice =
  | { ok: true; entry: ActivePricebookEntry; reason: "draft-entry-active" | "selling-model-match" | "only-entry" | "legacy-fallback" }
  | { ok: false; code: "NO_ACTIVE_ENTRY" | "NO_ENTRY_FOR_SELLING_MODEL" | "AMBIGUOUS_ENTRY"; reason: string };

const id15 = (id: string | null | undefined) => (id ? id.slice(0, 15) : null);

/**
 * Choose the entry a line must be created with:
 *  1. with a known selling model, only entries of THAT selling model qualify — the draft's own entry if it's one of them,
 *     else the single matching entry; none → NO_ENTRY_FOR_SELLING_MODEL (never another selling model's entry);
 *  2. without a selling model, the draft's entry if it's still active, else the product's only entry; several → ambiguous
 *     (`legacyFallback` keeps the old behaviour for callers that must not start failing).
 */
export function choosePricebookEntry(entries: ActivePricebookEntry[], draftPricebookEntryId: string | null, draftSellingModelId: string | null, opts: { legacyFallback?: ActivePricebookEntry | null } = {}): PricebookEntryChoice {
  if (!entries.length) return { ok: false, code: "NO_ACTIVE_ENTRY", reason: "The product has no active PricebookEntry in this price book." };
  const draft = entries.find(e => id15(e.pricebookEntryId) === id15(draftPricebookEntryId)) ?? null;
  const psmAware = entries.some(e => e.sellingModelId);
  if (draftSellingModelId && psmAware) {
    const matching = entries.filter(e => id15(e.sellingModelId) === id15(draftSellingModelId));
    if (draft && matching.includes(draft)) return { ok: true, entry: draft, reason: "draft-entry-active" };
    if (matching.length >= 1) return { ok: true, entry: matching[0], reason: "selling-model-match" };
    return { ok: false, code: "NO_ENTRY_FOR_SELLING_MODEL", reason: `The price book has no active PricebookEntry for the selected selling model (${draftSellingModelId}); active entries are for: ${[...new Set(entries.map(e => e.sellingModelId ?? "no selling model"))].join(", ")}.` };
  }
  if (draft) return { ok: true, entry: draft, reason: "draft-entry-active" };
  if (entries.length === 1) return { ok: true, entry: entries[0], reason: "only-entry" };
  if (opts.legacyFallback) return { ok: true, entry: opts.legacyFallback, reason: "legacy-fallback" };
  return { ok: false, code: "AMBIGUOUS_ENTRY", reason: `The product has ${entries.length} active PricebookEntries in this price book (one per selling model) and no selling model was chosen for the line.` };
}
