import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/products/server/salesforceWrites";
import { rankProductNameMatches } from "@/lib/quotes/catalog/search";
import type { CatalogProduct } from "@/lib/quotes/types";
import { buildSalesforceRecordUrl } from "@/lib/salesforce/recordUrl";
import { normalizeForCompare, type DuplicateSimilarRecord, type DuplicateExistingRecord, type DuplicateCheckResult } from "@/lib/duplicateDetection";

interface Product2Row {
  Id: string;
  Name: string;
  ProductCode: string | null;
  Family: string | null;
  IsActive: boolean;
  LastModifiedDate: string;
}

async function queryByField(client: SalesforceClient, field: "Name" | "ProductCode", value: string, excludeId?: string): Promise<Product2Row[]> {
  if (!value.trim()) return [];
  const clauses = [`${field} = '${soqlEscape(value)}'`];
  if (excludeId) clauses.push(`Id != '${soqlEscape(excludeId)}'`);
  try {
    const res = await client.query<Product2Row>(
      `SELECT Id, Name, ProductCode, Family, IsActive, LastModifiedDate FROM Product2 WHERE ${clauses.join(" AND ")} LIMIT 5`,
    );
    return res.records;
  } catch {
    return [];
  }
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
  const target = normalizeForCompare(name);
  const byName = await queryByField(client, "Name", name, opts.excludeId);
  const exact = byName.find(r => normalizeForCompare(r.Name) === target) ?? null;

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
 * The authoritative "would creating a Product with this Name/Code duplicate
 * an existing one?" check. Called both by the frontend pre-check route
 * (POST /api/sf/products/check-duplicate) AND server-side as the FINAL gate
 * inside POST /api/sf/products/save itself — a frontend-only check can't
 * stop two concurrent requests that both ran their check before either
 * record existed (§21). Pass `excludeId` (the record's own Id) when
 * checking during an Edit save, so a record never flags its own unchanged
 * name/code as a duplicate of itself (§25).
 */
export async function checkProductDuplicate(
  client: SalesforceClient,
  input: { name: string; code?: string | null; excludeId?: string },
): Promise<DuplicateCheckResult> {
  const codeMatches = input.code ? await queryByField(client, "ProductCode", input.code, input.excludeId) : [];
  const exactCode = input.code
    ? codeMatches.find(r => normalizeForCompare(r.ProductCode ?? "") === normalizeForCompare(input.code!)) ?? null
    : null;

  const { exact: exactName, similar } = await findProductMatches(client, input.name, { excludeId: input.excludeId });

  const match = exactName ?? exactCode;
  if (match) {
    return {
      isDuplicate: true,
      matchType: exactName ? "exact-name" : "exact-code",
      objectApiName: "Product2",
      recordId: match.Id,
      recordName: match.Name,
      recordCode: match.ProductCode ?? null,
      salesforceUrl: buildSalesforceRecordUrl(client.instanceUrl, "Product2", match.Id),
      existing: toExistingRecord(match),
      similarRecords: similar,
    };
  }

  return { isDuplicate: false, similarRecords: similar };
}
