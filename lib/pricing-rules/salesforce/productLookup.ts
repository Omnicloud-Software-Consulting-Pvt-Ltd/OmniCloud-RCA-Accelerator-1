import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";

export interface ResolvedProduct {
  id: string;
  name: string;
  productCode: string;
  isActive: boolean;
  currencyIsoCode: string | null;
}

async function enrichProduct(client: SalesforceClient, record: { Id: string; Name: string; ProductCode: string | null; IsActive: boolean }): Promise<ResolvedProduct> {
  let currencyIsoCode: string | null = null;
  try {
    const curRes = await client.query<{ CurrencyIsoCode?: string }>(`SELECT CurrencyIsoCode FROM Product2 WHERE Id = '${record.Id}' LIMIT 1`);
    currencyIsoCode = curRes.records[0]?.CurrencyIsoCode ?? null;
  } catch {
    currencyIsoCode = null; // multi-currency not enabled on this org — not an error
  }
  return { id: record.Id, name: record.Name, productCode: record.ProductCode ?? "", isActive: record.IsActive, currencyIsoCode };
}

/** Resolve a Product2 by exact name, falling back to a `LIKE` match. Prefer `resolveProduct2ById` whenever the caller already has an exact Id (e.g. a lookup selection) — Name is not unique in Salesforce, so a name-only re-resolve can silently land on a different record than the one actually picked. */
export async function resolveProduct2ByName(client: SalesforceClient, productName: string): Promise<ResolvedProduct | null> {
  const escaped = soqlEscape(productName.trim());
  let res = await client.query<{ Id: string; Name: string; ProductCode: string | null; IsActive: boolean }>(
    `SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Name = '${escaped}' LIMIT 1`,
  );
  if (res.records.length === 0) {
    res = await client.query(`SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Name LIKE '%${escaped}%' LIMIT 1`);
  }
  const record = res.records[0];
  return record ? enrichProduct(client, record) : null;
}

/** Resolve a Product2 by exact Id — the safe path when the caller already knows precisely which record was selected. */
export async function resolveProduct2ById(client: SalesforceClient, productId: string): Promise<ResolvedProduct | null> {
  const res = await client.query<{ Id: string; Name: string; ProductCode: string | null; IsActive: boolean }>(
    `SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Id = '${soqlEscape(productId.trim())}' LIMIT 1`,
  );
  const record = res.records[0];
  return record ? enrichProduct(client, record) : null;
}

export interface ResolvedSellingModel {
  id: string;
  name: string;
}

export async function resolveSellingModelForProduct(client: SalesforceClient, productId: string): Promise<ResolvedSellingModel | null> {
  const optRes = await client.query<{ ProductSellingModelId: string }>(
    `SELECT ProductSellingModelId FROM ProductSellingModelOption WHERE Product2Id = '${productId}' LIMIT 1`,
  );
  const smId = optRes.records[0]?.ProductSellingModelId;
  if (!smId) return null;
  const smRes = await client.query<{ Id: string; Name: string }>(`SELECT Id, Name FROM ProductSellingModel WHERE Id = '${smId}' LIMIT 1`);
  const rec = smRes.records[0];
  return rec ? { id: rec.Id, name: rec.Name } : null;
}

export interface StandardPricebookEntryInfo {
  effectiveFrom: string;
  effectiveTo: string;
  /** UnitPrice off the active Standard Price Book entry — the auto-populated Base Price. Null when no such entry exists (never fatal — caller should warn, not fail). */
  basePrice: number | null;
}

/**
 * The single source of truth for a product's Base Price: the active
 * Standard Price Book entry's UnitPrice. Also carries effective dates off
 * the same row since both come from the identical PricebookEntry lookup.
 */
export async function resolveStandardPricebookEntry(client: SalesforceClient, productId: string): Promise<StandardPricebookEntryInfo> {
  const defaults: StandardPricebookEntryInfo = { effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: "2099-12-31", basePrice: null };
  try {
    const res = await client.query<{ StartDate?: string; EndDate?: string; UnitPrice?: number }>(
      `SELECT StartDate, EndDate, UnitPrice FROM PricebookEntry WHERE Product2Id = '${productId}' AND Pricebook2.IsStandard = true AND IsActive = true LIMIT 1`,
    );
    const rec = res.records[0];
    if (rec) {
      return {
        effectiveFrom: rec.StartDate ?? defaults.effectiveFrom,
        effectiveTo: rec.EndDate ?? defaults.effectiveTo,
        basePrice: typeof rec.UnitPrice === "number" ? rec.UnitPrice : null,
      };
    }
  } catch {
    // fall through to defaults — a missing/inactive Standard Price Book entry is a warning, never a hard failure.
  }
  return defaults;
}
