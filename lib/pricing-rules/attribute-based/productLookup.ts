/**
 * Step 2/3/13#2 — Product is the prerequisite for everything else in this
 * flow. Resolves a user-typed product NAME (never an Id) against Product2,
 * distinguishing three outcomes: a single confident match, several
 * similarly-named products (ambiguous — Step 13 #2), or none at all
 * (not-found — Step 3, with best-effort "did you mean" suggestions pulled
 * from the org, never invented).
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { topFuzzyMatches } from "./fuzzyMatch";
import type { DiscoveredProduct, ProductCandidate } from "./types";

interface Product2Row {
  Id: string;
  Name: string;
  ProductCode: string | null;
  IsActive: boolean;
}

async function enrichProduct(client: SalesforceClient, record: Product2Row): Promise<DiscoveredProduct> {
  let currency = "USD";
  let basePrice: number | null = null;
  try {
    const res = await client.query<{ CurrencyIsoCode?: string }>(`SELECT CurrencyIsoCode FROM Product2 WHERE Id = '${record.Id}' LIMIT 1`);
    currency = res.records[0]?.CurrencyIsoCode ?? "USD";
  } catch {
    currency = "USD"; // multi-currency not enabled on this org — not an error
  }
  try {
    const res = await client.query<{ UnitPrice?: number }>(
      `SELECT UnitPrice FROM PricebookEntry WHERE Product2Id = '${record.Id}' AND Pricebook2.IsStandard = true AND IsActive = true LIMIT 1`,
    );
    basePrice = typeof res.records[0]?.UnitPrice === "number" ? res.records[0].UnitPrice : null;
  } catch {
    basePrice = null; // missing/inactive Standard Price Book entry — a warning elsewhere, never fatal here
  }
  return {
    id: record.Id,
    name: record.Name,
    productCode: record.ProductCode ?? "",
    status: record.IsActive ? "Active" : "Inactive",
    currency,
    basePrice,
  };
}

function toCandidate(record: Product2Row): ProductCandidate {
  return { id: record.Id, name: record.Name, productCode: record.ProductCode ?? "" };
}

/** The longest non-numeric word in the name — a broad-enough net to surface "Laptop Pro 14"/"Laptop Pro 15 Business" as candidates when the exact typed name ("Laptop Pro 15") doesn't exist at all. */
function mostDistinctiveWord(name: string): string | null {
  const words = name.split(/\s+/).filter(w => w.length >= 3 && !/^\d+$/.test(w));
  if (words.length === 0) return null;
  return words.reduce((longest, w) => (w.length > longest.length ? w : longest), words[0]);
}

export type ProductResolution =
  | { status: "resolved"; product: DiscoveredProduct }
  | { status: "ambiguous"; candidates: ProductCandidate[] }
  | { status: "not-found"; candidates: ProductCandidate[] };

/**
 * Resolve a product by name, or explain why it couldn't be resolved
 * uniquely. Never asks for (or requires) a Salesforce Id — Product2.Name
 * isn't unique, so an exact match returning more than one row is reported
 * as ambiguous rather than silently taking the first one.
 */
export async function resolveOrSuggestProduct(client: SalesforceClient, productName: string): Promise<ProductResolution> {
  const trimmed = productName.trim();
  const escaped = soqlEscape(trimmed);

  const exact = await client.query<Product2Row>(`SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Name = '${escaped}' LIMIT 10`);
  if (exact.records.length === 1) return { status: "resolved", product: await enrichProduct(client, exact.records[0]) };
  if (exact.records.length > 1) return { status: "ambiguous", candidates: exact.records.map(toCandidate) };

  const contains = await client.query<Product2Row>(`SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Name LIKE '%${escaped}%' LIMIT 10`);
  if (contains.records.length === 1) return { status: "resolved", product: await enrichProduct(client, contains.records[0]) };
  if (contains.records.length > 1) return { status: "ambiguous", candidates: contains.records.map(toCandidate) };

  // Nothing contains the typed name at all — broaden the net using the most
  // distinctive word, then fuzzy-rank so a genuine typo ("Laptop Pro 150")
  // can still surface real neighbors ("Laptop Pro 15 Business") that don't
  // literally contain the typed string.
  const broadWord = mostDistinctiveWord(trimmed);
  let broadRecords: Product2Row[] = [];
  if (broadWord) {
    try {
      const broad = await client.query<Product2Row>(`SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Name LIKE '%${soqlEscape(broadWord)}%' LIMIT 40`);
      broadRecords = broad.records;
    } catch {
      broadRecords = [];
    }
  }
  const ranked = topFuzzyMatches(trimmed, broadRecords.map(r => ({ value: r.Name, label: r.Name })), 5, 0.3);
  const suggestions = ranked
    .map(r => broadRecords.find(rec => rec.Name === r.candidate.value))
    .filter((r): r is Product2Row => !!r)
    .map(toCandidate);

  return { status: "not-found", candidates: suggestions };
}

/** Resolve a product the user explicitly picked from an ambiguous/not-found candidate list — by Id, the one case where an Id is safe to use since the UI (not the AI) supplied it. */
export async function resolveProduct2ById(client: SalesforceClient, productId: string): Promise<DiscoveredProduct | null> {
  const res = await client.query<Product2Row>(`SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Id = '${soqlEscape(productId.trim())}' LIMIT 1`);
  const record = res.records[0];
  return record ? enrichProduct(client, record) : null;
}
