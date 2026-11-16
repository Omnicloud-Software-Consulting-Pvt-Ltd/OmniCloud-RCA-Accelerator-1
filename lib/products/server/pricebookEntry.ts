import { SalesforceError, type SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/products/server/salesforceWrites";
import { sameSalesforceId } from "@/lib/products/server/sellingModel";

/**
 * Persists a product's price as PricebookEntry record(s) — shared by
 * /api/sf/products/save (create) and /api/sf/products/[id] (edit) so both
 * follow Salesforce's actual rules instead of each hand-rolling a single
 * `createRecord("PricebookEntry")` that could fail silently:
 *
 *  1. The Standard Price Book is resolved by `IsStandard = true`, never by
 *     its display Name (orgs can rename it).
 *  2. Salesforce requires a STANDARD price for a product before it can be
 *     added to any custom Price Book (STANDARD_PRICE_NOT_DEFINED) — when a
 *     custom Price Book is requested, the standard entry is created first
 *     with the same price.
 *  3. `CurrencyIsoCode` only exists on PricebookEntry in multi-currency
 *     orgs; sending it to a single-currency org makes Salesforce reject the
 *     whole entry (INVALID_FIELD). It is only sent when the field exists and
 *     the currency is active in the org; otherwise the price is still saved
 *     (in the org's own currency) and a warning explains why the currency
 *     wasn't applied.
 *  4. The written entry is read back and its UnitPrice compared with what
 *     was requested, so the caller reports what Salesforce actually holds.
 *  5. Revenue Cloud prices per selling model: PricebookEntry.ProductSellingModelId
 *     (create-only — it can't be patched onto an existing entry) ties the
 *     entry to a ProductSellingModel, and a product has one entry per
 *     Price Book × selling model (× currency). When `productSellingModelId`
 *     is given, the standard AND the custom entry are found/created for
 *     that selling model, and the read-back confirms Salesforce stored it
 *     on both. When it's omitted, entries are matched by Product + Price
 *     Book only (the pre-selling-model behavior, kept for price-only edits).
 *  6. What happens to an EXISTING matching entry (same Product2 + Pricebook2 + ProductSellingModel [+ currency], matched by
 *     Salesforce Id) is explicit: `existingPrice: "update"` (default — standalone create/edit) writes the requested price;
 *     `existingPrice: "keep"` (bundle creation) reuses the entry untouched and reports the retained price. A different selling
 *     model or a different Price Book is a different combination, so it gets its own entry.
 *  7. Concurrency: if Salesforce rejects a create as a duplicate (another request created the same combination a moment
 *     earlier), the entry is re-read and treated as existing — never created twice, never failing on the race.
 */

export interface PriceWriteRequest {
  productId: string;
  unitPrice: number;
  /** Name of the target Price Book; blank/undefined = the org's Standard Price Book. */
  priceBook?: string;
  currencyIsoCode?: string;
  isActive: boolean;
  /** ProductSellingModel the entries must carry (PricebookEntry.ProductSellingModelId). Omit for selling-model-agnostic legacy matching. */
  productSellingModelId?: string;
  /** What to do when a matching entry already exists: "update" its price (default, standalone create/edit) or "keep" it unchanged (bundle creation). */
  existingPrice?: "update" | "keep";
}

export interface PersistedPrice {
  id: string;
  pricebook: string;
  pricebookId: string;
  unitPrice: number;
  currencyIsoCode?: string;
  /** true when an existing entry was updated instead of a new one created. */
  updated?: boolean;
  /** Id of the standard entry auto-created because a custom Price Book was targeted. */
  standardEntryId?: string;
  /** PricebookEntry.ProductSellingModelId as read back from Salesforce (written entry) — set only when a selling model was requested. */
  productSellingModelId?: string | null;
  /** The Standard Price Book entry for this selling model, as read back — the written entry itself when the target is the standard book. */
  standardEntry?: { id: string; productSellingModelId: string | null; created: boolean };
  /** true when an existing matching entry was reused without changes (existingPrice: "keep"). */
  reused?: boolean;
  /** Set when a reused entry's price differs from the requested one: the existing price was retained, never overwritten. */
  retainedPrice?: { existing: number; requested: number };
  /** true when the reused entry is inactive in Salesforce (left as-is; reported so it can be activated deliberately). */
  inactive?: boolean;
}

export interface PriceWriteOutcome {
  entry?: PersistedPrice;
  error?: string;
  warnings: string[];
}

interface PricebookRow { Id: string; Name: string; IsStandard: boolean; IsActive: boolean }
interface EntryRow { Id: string; UnitPrice: number; IsActive: boolean; CurrencyIsoCode?: string; ProductSellingModelId?: string | null }

async function pricebookEntryFields(client: SalesforceClient): Promise<{ multiCurrency: boolean; sellingModel: boolean }> {
  const describe = await client.describeObject("PricebookEntry");
  return {
    multiCurrency: describe.fields.some(f => f.name === "CurrencyIsoCode"),
    sellingModel: describe.fields.some(f => f.name === "ProductSellingModelId"),
  };
}

async function findEntry(client: SalesforceClient, productId: string, pricebookId: string, currency?: string, sellingModelId?: string): Promise<EntryRow | null> {
  const currencyClause = currency ? ` AND CurrencyIsoCode = '${soqlEscape(currency)}'` : "";
  const modelClause = sellingModelId ? ` AND ProductSellingModelId = '${soqlEscape(sellingModelId)}'` : "";
  const fields = ["Id", "UnitPrice", "IsActive", ...(currency ? ["CurrencyIsoCode"] : []), ...(sellingModelId ? ["ProductSellingModelId"] : [])].join(", ");
  const res = await client.query<EntryRow>(
    `SELECT ${fields} FROM PricebookEntry WHERE Product2Id = '${soqlEscape(productId)}' AND Pricebook2Id = '${soqlEscape(pricebookId)}'${currencyClause}${modelClause} LIMIT 1`,
  );
  return res.records[0] ?? null;
}

/** Salesforce's own signal that this Product2 + Pricebook2 (+ selling model + currency) combination already exists. */
export function isDuplicateEntryError(err: unknown): boolean {
  return err instanceof SalesforceError && (err.errorCode === "DUPLICATE_VALUE" || /already exists|duplicate/i.test(err.message));
}

interface UpsertResult { id: string; updated: boolean; reused: boolean; existing: EntryRow | null }

async function upsertEntry(
  client: SalesforceClient,
  req: PriceWriteRequest,
  pricebookId: string,
  currency: string | undefined,
  extra: Record<string, unknown> = {},
  sellingModelId?: string,
): Promise<UpsertResult> {
  const keep = req.existingPrice === "keep";
  const applyToExisting = async (existing: EntryRow): Promise<UpsertResult> => {
    if (keep) return { id: existing.Id, updated: false, reused: true, existing };
    await client.updateRecord("PricebookEntry", existing.Id, { UnitPrice: req.unitPrice, IsActive: req.isActive });
    return { id: existing.Id, updated: true, reused: false, existing };
  };
  const existing = await findEntry(client, req.productId, pricebookId, currency, sellingModelId);
  if (existing) return applyToExisting(existing);
  try {
    const created = await client.createRecord("PricebookEntry", {
      Product2Id: req.productId,
      Pricebook2Id: pricebookId,
      UnitPrice: req.unitPrice,
      IsActive: req.isActive,
      ...(currency ? { CurrencyIsoCode: currency } : {}),
      ...(sellingModelId ? { ProductSellingModelId: sellingModelId } : {}),
      ...extra,
    });
    if (!created.success) throw new Error(`PricebookEntry creation failed: ${JSON.stringify(created.errors)}`);
    return { id: created.id, updated: false, reused: false, existing: null };
  } catch (err) {
    // A concurrent request created the same combination between our check and our create: use that entry instead.
    if (isDuplicateEntryError(err)) {
      const raced = await findEntry(client, req.productId, pricebookId, currency, sellingModelId);
      if (raced) return applyToExisting(raced);
    }
    throw err;
  }
}

export async function persistProductPrice(client: SalesforceClient, req: PriceWriteRequest): Promise<PriceWriteOutcome> {
  const warnings: string[] = [];

  /* ── Price Books: standard (always needed) + the requested target ── */
  const stdRes = await client.query<PricebookRow>("SELECT Id, Name, IsStandard, IsActive FROM Pricebook2 WHERE IsStandard = true LIMIT 1");
  const standard = stdRes.records[0];
  if (!standard) return { error: "No Standard Price Book exists in this org, so the price could not be saved.", warnings };

  const requestedName = (req.priceBook ?? "").trim();
  let target: PricebookRow = standard;
  if (requestedName && requestedName.toLowerCase() !== standard.Name.toLowerCase() && requestedName.toLowerCase() !== "standard price book") {
    const res = await client.query<PricebookRow>(
      `SELECT Id, Name, IsStandard, IsActive FROM Pricebook2 WHERE Name = '${soqlEscape(requestedName)}' ORDER BY IsActive DESC LIMIT 1`,
    );
    if (!res.records[0]) return { error: `Price Book "${requestedName}" was not found in this org, so the price was not saved.`, warnings };
    target = res.records[0];
    if (!target.IsActive) warnings.push(`Price Book "${target.Name}" is inactive in Salesforce — the price was saved but won't be usable until it's activated.`);
  }

  /* ── Org shape (one describe): multi-currency? selling-model-aware PricebookEntry? ── */
  const requestedModel = req.productSellingModelId?.trim() || undefined;
  const requestedCurrency = req.currencyIsoCode?.trim().toUpperCase() || undefined;
  const shape = requestedModel || requestedCurrency ? await pricebookEntryFields(client) : { multiCurrency: false, sellingModel: false };
  let sellingModelId: string | undefined;
  if (requestedModel) {
    if (shape.sellingModel) sellingModelId = requestedModel;
    else warnings.push("PricebookEntry has no ProductSellingModelId field in this org/API version, so the price entry was saved without a Product Selling Model.");
  }

  /* ── Currency ── */
  let currency: string | undefined;
  if (requestedCurrency) {
    if (shape.multiCurrency) {
      const cur = await client.query<{ IsoCode: string }>(
        `SELECT IsoCode FROM CurrencyType WHERE IsoCode = '${soqlEscape(requestedCurrency)}' AND IsActive = true LIMIT 1`,
      );
      if (!cur.records[0]) {
        return { error: `Currency ${requestedCurrency} is not an active currency in this org, so the price was not saved.`, warnings };
      }
      currency = requestedCurrency;
    } else {
      warnings.push(`This org is single-currency, so Currency ${requestedCurrency} can't be stored — the price was saved in the org's own currency.`);
    }
  }

  /* ── Standard entry first (Salesforce requirement — per selling model when one is given), then the custom one ── */
  let standardEntryId: string | undefined;
  let standardEntry: { id: string; created: boolean };
  let written: UpsertResult;
  if (target.Id === standard.Id) {
    written = await upsertEntry(client, req, standard.Id, currency, {}, sellingModelId);
    standardEntry = { id: written.id, created: !written.updated && !written.reused };
  } else {
    // The standard entry is only a prerequisite here: an existing one is never re-priced, even if one appears concurrently.
    const std = await upsertEntry(client, { ...req, existingPrice: "keep" }, standard.Id, currency, {}, sellingModelId);
    standardEntry = { id: std.id, created: !std.reused };
    if (!std.reused) standardEntryId = std.id;
    written = await upsertEntry(client, req, target.Id, currency, { UseStandardPrice: false }, sellingModelId);
  }

  /* ── Read back what Salesforce actually stored (price, and the selling model on BOTH entries) ── */
  const readFields = ["Id", "UnitPrice", "IsActive", ...(currency ? ["CurrencyIsoCode"] : []), ...(sellingModelId ? ["ProductSellingModelId"] : [])].join(", ");
  const readIds = Array.from(new Set([written.id, standardEntry.id]));
  const readBack = await client.query<EntryRow>(
    `SELECT ${readFields} FROM PricebookEntry WHERE Id IN (${readIds.map(i => `'${soqlEscape(i)}'`).join(",")})`,
  );
  const stored = readBack.records.find(r => sameSalesforceId(r.Id, written.id));
  const storedStd = readBack.records.find(r => sameSalesforceId(r.Id, standardEntry.id));
  if (!stored) return { error: "The price entry was written but could not be read back from Salesforce.", warnings };
  // A reused entry must still hold its own (retained) price; a written one must hold the requested price.
  const expectedPrice = written.reused ? Number(written.existing?.UnitPrice) : req.unitPrice;
  if (Math.abs(Number(stored.UnitPrice) - expectedPrice) > 0.005) {
    return { error: `Salesforce holds ${stored.UnitPrice} instead of the expected ${expectedPrice}.`, warnings };
  }
  const retainedPrice = written.reused && Math.abs(Number(stored.UnitPrice) - req.unitPrice) > 0.005 ? { existing: Number(stored.UnitPrice), requested: req.unitPrice } : undefined;
  if (retainedPrice) warnings.push(`An entry for this product, Price Book and selling model already exists at ${retainedPrice.existing}; it was reused and its price was kept (the requested ${retainedPrice.requested} was not applied).`);
  const inactive = written.reused && stored.IsActive === false;
  if (inactive) warnings.push("The existing price entry is inactive in Salesforce. It was left unchanged — activate it in Salesforce if this product should be sellable from this Price Book.");
  if (sellingModelId) {
    for (const [label, row] of [[target.Name, stored], ["Standard Price Book", storedStd]] as const) {
      if (!row || !sameSalesforceId(row.ProductSellingModelId, sellingModelId)) {
        return { error: `The ${label} entry was saved but Salesforce has ProductSellingModelId ${row?.ProductSellingModelId ?? "empty"} instead of ${sellingModelId}.`, warnings };
      }
    }
  }

  return {
    entry: {
      id: stored.Id,
      pricebook: target.Name,
      pricebookId: target.Id,
      unitPrice: Number(stored.UnitPrice),
      ...(stored.CurrencyIsoCode ? { currencyIsoCode: stored.CurrencyIsoCode } : {}),
      ...(written.updated ? { updated: true } : {}),
      ...(standardEntryId ? { standardEntryId } : {}),
      ...(sellingModelId ? { productSellingModelId: stored.ProductSellingModelId ?? null } : {}),
      standardEntry: { id: standardEntry.id, productSellingModelId: storedStd?.ProductSellingModelId ?? null, created: standardEntry.created },
      ...(written.reused ? { reused: true } : {}),
      ...(retainedPrice ? { retainedPrice } : {}),
      ...(inactive ? { inactive: true } : {}),
    },
    warnings,
  };
}
