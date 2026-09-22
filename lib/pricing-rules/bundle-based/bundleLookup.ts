/**
 * Resolve a bundle's PARENT Product2 by name — mirrors
 * lib/pricing-rules/attribute-based/productLookup.ts's exact resolution strategy (exact match ->
 * contains match -> fuzzy-ranked broad match on the most distinctive word). A bundle's parent is just a
 * Product2 record like any other; whether it's actually CONFIGURED as a bundle (has real components) is
 * decided separately by discoverBundleStructure.ts, never here.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { topFuzzyMatches, type FuzzyCandidate } from "./fuzzyMatch";
import type { BundleCandidate } from "./types";

export interface EnrichedBundleProduct {
  id: string;
  name: string;
  productCode: string | null;
  status: string | null;
  currency: string;
  basePrice: number | null;
}

export type BundleProductResolution =
  | { status: "resolved"; product: EnrichedBundleProduct }
  | { status: "ambiguous"; candidates: BundleCandidate[] }
  | { status: "not-found"; candidates: BundleCandidate[] };

interface Product2Row {
  Id: string;
  Name: string;
  ProductCode: string | null;
  IsActive?: boolean;
}

function toCandidate(rec: Product2Row): BundleCandidate {
  return { id: rec.Id, name: rec.Name, productCode: rec.ProductCode ?? null };
}

/** Longest non-purely-numeric word ≥3 chars — the same "most distinctive word" heuristic productLookup.ts uses. */
function mostDistinctiveWord(name: string): string | null {
  const words = name.split(/\s+/).filter(w => w.length >= 3 && /[a-zA-Z]/.test(w));
  if (words.length === 0) return null;
  return words.reduce((a, b) => (b.length > a.length ? b : a));
}

async function enrichBundleProduct(client: SalesforceClient, rec: Product2Row): Promise<EnrichedBundleProduct> {
  let currency = "USD";
  try {
    const curRes = await client.query<{ CurrencyIsoCode?: string }>(
      `SELECT CurrencyIsoCode FROM Product2 WHERE Id = '${soqlEscape(rec.Id)}' LIMIT 1`,
    );
    if (curRes.records[0]?.CurrencyIsoCode) currency = curRes.records[0].CurrencyIsoCode as string;
  } catch { /* org may not have multi-currency enabled — default to USD, never fatal */ }

  let basePrice: number | null = null;
  try {
    const pbRes = await client.query<{ UnitPrice: number }>(
      `SELECT UnitPrice FROM PricebookEntry WHERE Product2Id = '${soqlEscape(rec.Id)}' AND Pricebook2.IsStandard = true AND IsActive = true LIMIT 1`,
    );
    basePrice = pbRes.records[0]?.UnitPrice ?? null;
  } catch { /* no accessible Standard Pricebook entry — leave null rather than guessing */ }

  return { id: rec.Id, name: rec.Name, productCode: rec.ProductCode ?? null, status: rec.IsActive === false ? "Inactive" : "Active", currency, basePrice };
}

export async function resolveOrSuggestBundle(client: SalesforceClient, bundleName: string): Promise<BundleProductResolution> {
  const trimmed = bundleName.trim();

  const exact = await client.query<Product2Row>(
    `SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Name = '${soqlEscape(trimmed)}' LIMIT 10`,
  );
  if (exact.records.length === 1) return { status: "resolved", product: await enrichBundleProduct(client, exact.records[0]) };
  if (exact.records.length > 1) return { status: "ambiguous", candidates: exact.records.map(toCandidate) };

  const contains = await client.query<Product2Row>(
    `SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Name LIKE '%${soqlEscape(trimmed)}%' LIMIT 10`,
  );
  if (contains.records.length === 1) return { status: "resolved", product: await enrichBundleProduct(client, contains.records[0]) };
  if (contains.records.length > 1) return { status: "ambiguous", candidates: contains.records.map(toCandidate) };

  const word = mostDistinctiveWord(trimmed);
  if (!word) return { status: "not-found", candidates: [] };

  const broad = await client.query<Product2Row>(
    `SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Name LIKE '%${soqlEscape(word)}%' LIMIT 40`,
  );
  if (broad.records.length === 0) return { status: "not-found", candidates: [] };

  const candidates: FuzzyCandidate[] = broad.records.map(r => ({ value: r.Name, label: r.Name }));
  const ranked = topFuzzyMatches(trimmed, candidates, 5, 0.3);
  const byName = new Map(broad.records.map(r => [r.Name, r]));
  const suggestions = ranked
    .map(r => byName.get(r.candidate.value))
    .filter((r): r is Product2Row => !!r)
    .map(toCandidate);
  return { status: "not-found", candidates: suggestions };
}

export async function resolveBundleProductById(client: SalesforceClient, productId: string): Promise<EnrichedBundleProduct | null> {
  const res = await client.query<Product2Row>(
    `SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Id = '${soqlEscape(productId)}' LIMIT 1`,
  );
  const rec = res.records[0];
  return rec ? enrichBundleProduct(client, rec) : null;
}
