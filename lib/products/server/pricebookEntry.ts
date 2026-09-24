import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/products/server/salesforceWrites";

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
 */

export interface PriceWriteRequest {
  productId: string;
  unitPrice: number;
  /** Name of the target Price Book; blank/undefined = the org's Standard Price Book. */
  priceBook?: string;
  currencyIsoCode?: string;
  isActive: boolean;
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
}

export interface PriceWriteOutcome {
  entry?: PersistedPrice;
  error?: string;
  warnings: string[];
}

interface PricebookRow { Id: string; Name: string; IsStandard: boolean; IsActive: boolean }
interface EntryRow { Id: string; UnitPrice: number; IsActive: boolean; CurrencyIsoCode?: string }

async function orgIsMultiCurrency(client: SalesforceClient): Promise<boolean> {
  const describe = await client.describeObject("PricebookEntry");
  return describe.fields.some(f => f.name === "CurrencyIsoCode");
}

async function findEntry(client: SalesforceClient, productId: string, pricebookId: string, currency?: string): Promise<EntryRow | null> {
  const currencyClause = currency ? ` AND CurrencyIsoCode = '${soqlEscape(currency)}'` : "";
  const fields = currency ? "Id, UnitPrice, IsActive, CurrencyIsoCode" : "Id, UnitPrice, IsActive";
  const res = await client.query<EntryRow>(
    `SELECT ${fields} FROM PricebookEntry WHERE Product2Id = '${soqlEscape(productId)}' AND Pricebook2Id = '${soqlEscape(pricebookId)}'${currencyClause} LIMIT 1`,
  );
  return res.records[0] ?? null;
}

async function upsertEntry(
  client: SalesforceClient,
  req: PriceWriteRequest,
  pricebookId: string,
  currency: string | undefined,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; updated: boolean }> {
  const existing = await findEntry(client, req.productId, pricebookId, currency);
  if (existing) {
    await client.updateRecord("PricebookEntry", existing.Id, { UnitPrice: req.unitPrice, IsActive: req.isActive });
    return { id: existing.Id, updated: true };
  }
  const created = await client.createRecord("PricebookEntry", {
    Product2Id: req.productId,
    Pricebook2Id: pricebookId,
    UnitPrice: req.unitPrice,
    IsActive: req.isActive,
    ...(currency ? { CurrencyIsoCode: currency } : {}),
    ...extra,
  });
  if (!created.success) throw new Error(`PricebookEntry creation failed: ${JSON.stringify(created.errors)}`);
  return { id: created.id, updated: false };
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

  /* ── Currency ── */
  let currency: string | undefined;
  const requestedCurrency = req.currencyIsoCode?.trim().toUpperCase() || undefined;
  if (requestedCurrency) {
    if (await orgIsMultiCurrency(client)) {
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

  /* ── Standard entry first (Salesforce requirement), then the custom one ── */
  let standardEntryId: string | undefined;
  let written: { id: string; updated: boolean };
  if (target.Id === standard.Id) {
    written = await upsertEntry(client, req, standard.Id, currency);
  } else {
    const std = await findEntry(client, req.productId, standard.Id, currency);
    if (!std) {
      const createdStd = await upsertEntry(client, req, standard.Id, currency);
      standardEntryId = createdStd.id;
    }
    written = await upsertEntry(client, req, target.Id, currency, { UseStandardPrice: false });
  }

  /* ── Read back what Salesforce actually stored ── */
  const readBack = await client.query<EntryRow>(
    `SELECT Id, UnitPrice, IsActive${currency ? ", CurrencyIsoCode" : ""} FROM PricebookEntry WHERE Id = '${soqlEscape(written.id)}' LIMIT 1`,
  );
  const stored = readBack.records[0];
  if (!stored) return { error: "The price entry was written but could not be read back from Salesforce.", warnings };
  if (Math.abs(Number(stored.UnitPrice) - req.unitPrice) > 0.005) {
    return { error: `Salesforce stored ${stored.UnitPrice} instead of the requested ${req.unitPrice}.`, warnings };
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
    },
    warnings,
  };
}
