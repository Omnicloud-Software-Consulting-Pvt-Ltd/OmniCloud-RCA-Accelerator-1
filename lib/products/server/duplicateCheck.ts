import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/products/server/salesforceWrites";
import { rankProductNameMatches } from "@/lib/quotes/catalog/search";
import type { CatalogProduct } from "@/lib/quotes/types";
import { buildSalesforceRecordUrl } from "@/lib/salesforce/recordUrl";
import { isSameProductName, type DuplicateSimilarRecord, type DuplicateExistingRecord, type DuplicateCheckResult } from "@/lib/duplicateDetection";

interface Product2Row {
  Id: string;
  Name: string;
  ProductCode: string | null;
  Family: string | null;
  IsActive: boolean;
  LastModifiedDate: string;
}

async function queryByName(client: SalesforceClient, value: string, excludeId?: string): Promise<Product2Row[]> {
  if (!value.trim()) return [];
  // SOQL `=` on Name is a whole-value (case-insensitive) match — never LIKE — so it can only narrow the candidate set.
  const clauses = [`Name = '${soqlEscape(value.trim())}'`];
  if (excludeId) clauses.push(`Id != '${soqlEscape(excludeId)}'`);
  const res = await client.query<Product2Row>(
    `SELECT Id, Name, ProductCode, Family, IsActive, LastModifiedDate FROM Product2 WHERE ${clauses.join(" AND ")} LIMIT 5`,
  );
  return res.records;
}

async function findSimilarCandidates(client: SalesforceClient, name: string, excludeId?: string) {
  const token = name.trim().split(/\s+/)[0];
  if (!token) return [];
  const clauses = [`Name LIKE '%${soqlEscape(token)}%'`];
  if (excludeId) clauses.push(`Id != '${soqlEscape(excludeId)}'`);
  try {
    const res = await client.query<{ Id: string; Name: string; ProductCode: string | null; Family: string | null; Description: string | null }>(
      `SELECT Id, Name, ProductCode, Family, Description FROM Product2 WHERE ${clauses.join(" AND ")} LIMIT 25`,
    );
    return res.records;
  } catch {
    return [];
  }
}

function toCatalogProductShape(r: { Id: string; Name: string; ProductCode: string | null; Family: string | null; Description: string | null }): CatalogProduct {
  return { id: r.Id, name: r.Name, productCode: r.ProductCode, description: r.Description ?? null, family: r.Family, pricebookEntryId: "", listPrice: 0, isBundleCandidate: false };
}

export interface ProductMatches {
  exact: Product2Row | null;
  similar: DuplicateSimilarRecord[];
}

/**
 * Shared primitive: exact-name Product2 match + up to 5 ranked similar-name
 * candidates. Reused by BOTH the duplicate-prevention check below and the
 * Attribute workflow's Product Existence Validation
 * (lib/attributes/server/productValidation.ts) — one Product-name-
 * resolution implementation, two different framings of the same result
 * (block a duplicate create vs. resolve a product to attach an attribute
 * to). Reuses the exact ranking algorithm (rankProductNameMatches) Quotes/
 * Bundles already use for product-name resolution rather than a second
 * similarity heuristic.
 */
export async function findProductMatches(client: SalesforceClient, name: string, opts: { excludeId?: string } = {}): Promise<ProductMatches> {
  const byName = await queryByName(client, name, opts.excludeId).catch(() => [] as Product2Row[]);
  const exact = byName.find(r => isSameProductName(r.Name, name)) ?? null;

  const candidates = await findSimilarCandidates(client, name, opts.excludeId);
  const ranked = rankProductNameMatches(name, candidates.map(toCatalogProductShape));
  const similar: DuplicateSimilarRecord[] = ranked.candidates
    .filter(c => c.matchType !== "exact" && (!exact || c.product.id !== exact.Id))
    .slice(0, 5)
    .map(c => ({ recordId: c.product.id, recordName: c.product.name, recordCode: c.product.productCode }));

  return { exact, similar };
}

function toExistingRecord(r: Product2Row): DuplicateExistingRecord {
  return {
    recordId: r.Id, recordName: r.Name, recordCode: r.ProductCode ?? null,
    isActive: r.IsActive !== false, family: r.Family ?? null,
    componentCount: null, sellingModel: null, catalog: null, category: null,
    lastModifiedDate: r.LastModifiedDate ?? null,
  };
}

/**
 * The authoritative "would creating a Product with this Name duplicate an
 * existing one?" check. Called both by the frontend pre-check route
 * (POST /api/sf/products/check-duplicate) AND server-side as the FINAL gate
 * inside POST /api/sf/products/save itself — a frontend-only check can't
 * stop two concurrent requests that both ran their check before either
 * record existed (§21). Pass `excludeId` (the record's own Id) when
 * checking during an Edit save, so a record never flags its own unchanged
 * name as a duplicate of itself (§25).
 *
 * Only the COMPLETE Product2.Name counts (isSameProductName: trim +
 * case-fold) — no prefix/substring/token/fuzzy matching and no ProductCode,
 * so "OmniCloud RCA" is never a duplicate of "OmniCloud RCA Product".
 * `similarRecords` is always empty: a partial resemblance is not a duplicate
 * and must not interrupt creation. A failed query throws (callers fail closed).
 */
export async function checkProductDuplicate(
  client: SalesforceClient,
  input: { name: string; excludeId?: string },
): Promise<DuplicateCheckResult> {
  const rows = await queryByName(client, input.name, input.excludeId);
  const match = rows.find(r => isSameProductName(r.Name, input.name));
  if (!match) return { isDuplicate: false, similarRecords: [] };
  return {
    isDuplicate: true,
    matchType: "exact-name",
    objectApiName: "Product2",
    recordId: match.Id,
    recordName: match.Name,
    recordCode: match.ProductCode ?? null,
    salesforceUrl: buildSalesforceRecordUrl(client.instanceUrl, "Product2", match.Id),
    existing: toExistingRecord(match),
    similarRecords: [],
  };
}
