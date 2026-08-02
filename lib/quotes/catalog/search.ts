import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { resolveField } from "@/lib/salesforce/describe";
import { createTTLCache } from "@/lib/salesforce/cache";
import type { CatalogProduct, ProductNameMatch } from "@/lib/quotes/types";

interface CatalogFieldSchema {
  productCodeField: string | null;
  descriptionField: string | null;
  familyField: string | null;
}

const catalogFieldCache = createTTLCache<CatalogFieldSchema>();

/** Resolve which optional descriptive Product2 fields this org actually has/exposes (§4.1). */
async function resolveCatalogFieldSchema(client: SalesforceClient): Promise<CatalogFieldSchema> {
  return catalogFieldCache.getOrCompute(client.instanceUrl, async () => {
    const describe = await describeObjectCached(client, "Product2");
    return {
      productCodeField: resolveField(describe, "ProductCode", /^product code$/i)?.name ?? null,
      descriptionField: resolveField(describe, "Description", /^description$/i)?.name ?? null,
      familyField: resolveField(describe, "Family", /^(product )?family$/i)?.name ?? null,
    };
  });
}

interface CatalogRow {
  Id: string;
  Name: string;
  ProductCode?: string;
  Description?: string;
  Family?: string;
  UnitPrice: number;
  PricebookEntryId: string;
}

function rowToProduct(row: CatalogRow, bundleCandidateIds: Set<string> | null): CatalogProduct {
  return {
    id: row.Id,
    name: row.Name,
    productCode: row.ProductCode ?? null,
    description: row.Description ?? null,
    family: row.Family ?? null,
    pricebookEntryId: row.PricebookEntryId,
    listPrice: row.UnitPrice,
    isBundleCandidate: bundleCandidateIds ? bundleCandidateIds.has(row.Id) : false,
  };
}

/** Debounced-search backend: name search within a price book, active Product2 + active PricebookEntry only (§4.1). */
export async function searchCatalogProducts(
  client: SalesforceClient,
  pricebookId: string,
  searchTerm: string,
  limit = 25,
): Promise<CatalogProduct[]> {
  const fields = await resolveCatalogFieldSchema(client);
  const selectFields = ["Product2.Id", "Product2.Name", "Product2Id", "UnitPrice", "Id"];
  if (fields.productCodeField) selectFields.push(`Product2.${fields.productCodeField}`);
  if (fields.descriptionField) selectFields.push(`Product2.${fields.descriptionField}`);
  if (fields.familyField) selectFields.push(`Product2.${fields.familyField}`);

  const term = soqlEscape(searchTerm.trim());
  const nameFilter = term ? `AND Product2.Name LIKE '%${term}%'` : "";

  const soql = `SELECT ${selectFields.join(", ")} FROM PricebookEntry
    WHERE Pricebook2Id = '${soqlEscape(pricebookId)}' AND IsActive = true
    AND Product2.IsActive = true ${nameFilter}
    ORDER BY Product2.Name LIMIT ${limit}`;

  const result = await client.query<Record<string, unknown>>(soql);
  return result.records.map(r => {
    const product2 = (r.Product2 ?? {}) as Record<string, unknown>;
    return rowToProduct(
      {
        Id: product2.Id as string,
        Name: product2.Name as string,
        ProductCode: fields.productCodeField ? (product2[fields.productCodeField] as string) : undefined,
        Description: fields.descriptionField ? (product2[fields.descriptionField] as string) : undefined,
        Family: fields.familyField ? (product2[fields.familyField] as string) : undefined,
        UnitPrice: r.UnitPrice as number,
        PricebookEntryId: r.Id as string,
      },
      null,
    );
  });
}

/** Batch-resolve a set of Product2 Ids to full catalog records within a given price book (used when resolving bundle children, §4.1). */
export async function fetchCatalogProductsByIds(
  client: SalesforceClient,
  pricebookId: string,
  productIds: string[],
): Promise<Map<string, CatalogProduct>> {
  const result = new Map<string, CatalogProduct>();
  if (productIds.length === 0) return result;

  const fields = await resolveCatalogFieldSchema(client);
  const selectFields = ["Product2.Id", "Product2.Name", "UnitPrice", "Id"];
  if (fields.productCodeField) selectFields.push(`Product2.${fields.productCodeField}`);
  if (fields.descriptionField) selectFields.push(`Product2.${fields.descriptionField}`);
  if (fields.familyField) selectFields.push(`Product2.${fields.familyField}`);

  const chunks: string[][] = [];
  for (let i = 0; i < productIds.length; i += 100) chunks.push(productIds.slice(i, i + 100));

  for (const chunk of chunks) {
    const ids = chunk.map(id => `'${soqlEscape(id)}'`).join(",");
    const soql = `SELECT ${selectFields.join(", ")} FROM PricebookEntry
      WHERE Pricebook2Id = '${soqlEscape(pricebookId)}' AND IsActive = true AND Product2Id IN (${ids})`;
    try {
      const res = await client.query<Record<string, unknown>>(soql);
      for (const r of res.records) {
        const product2 = (r.Product2 ?? {}) as Record<string, unknown>;
        const product = rowToProduct(
          {
            Id: product2.Id as string,
            Name: product2.Name as string,
            ProductCode: fields.productCodeField ? (product2[fields.productCodeField] as string) : undefined,
            Description: fields.descriptionField ? (product2[fields.descriptionField] as string) : undefined,
            Family: fields.familyField ? (product2[fields.familyField] as string) : undefined,
            UnitPrice: r.UnitPrice as number,
            PricebookEntryId: r.Id as string,
          },
          null,
        );
        result.set(product.id, product);
      }
    } catch {
      // A failed batch is reported to the caller as "missing" via the map lookup — never throws.
    }
  }
  return result;
}

/* ── AI-assisted product name matching (§4.1) ── */

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

export interface ProductMatchRanking {
  candidates: ProductNameMatch[];
  autoSelected: ProductNameMatch | null;
}

/** Rank candidate products against a free-text name (exact > substring > fuzzy), per §4.1. */
export function rankProductNameMatches(searchName: string, candidates: CatalogProduct[]): ProductMatchRanking {
  const target = searchName.trim().toLowerCase();
  const ranked: ProductNameMatch[] = candidates.map(product => {
    const name = product.name.toLowerCase();
    if (name === target) return { product, confidence: 1, matchType: "exact" as const };
    if (name.includes(target) || target.includes(name)) {
      const lengthRatio = Math.min(name.length, target.length) / Math.max(name.length, target.length);
      return { product, confidence: 0.85 + 0.1 * lengthRatio, matchType: "substring" as const };
    }
    return { product, confidence: similarity(name, target), matchType: "fuzzy" as const };
  });
  ranked.sort((a, b) => b.confidence - a.confidence);

  const top = ranked[0];
  const runnerUp = ranked[1];
  const autoSelected =
    top && top.confidence >= 0.92 && (!runnerUp || top.confidence - runnerUp.confidence >= 0.15) ? top : null;

  return { candidates: ranked.slice(0, 10), autoSelected };
}
