import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { rankProductNameMatches } from "@/lib/quotes/catalog/search";
import type { CatalogProduct } from "@/lib/quotes/types";
import { buildSalesforceRecordUrl } from "@/lib/salesforce/recordUrl";
import { normalizeForCompare, type DuplicateSimilarRecord, type DuplicateExistingRecord, type DuplicateCheckResult } from "@/lib/duplicateDetection";

interface Product2Row {
  Id: string;
  Name: string;
  ProductCode: string | null;
  Type: string | null;
  IsActive: boolean;
  LastModifiedDate: string;
}

/**
 * Bundle-name/code uniqueness matters against ANY Product2 record, not just
 * ones already Type='Bundle' — app/api/bundles/execute/route.ts's own
 * `resolveBundleProduct()` will happily coerce an existing plain Product
 * into Type='Bundle' if the name collides, which is exactly the silent
 * hijack this duplicate check exists to replace with an explicit user
 * decision. No Type filter here on purpose.
 */
async function queryByField(client: SalesforceClient, field: "Name" | "ProductCode", value: string, excludeId?: string): Promise<Product2Row[]> {
  if (!value.trim()) return [];
  const clauses = [`${field} = '${soqlEscape(value)}'`];
  if (excludeId) clauses.push(`Id != '${soqlEscape(excludeId)}'`);
  try {
    const res = await client.query<Product2Row>(
      `SELECT Id, Name, ProductCode, Type, IsActive, LastModifiedDate FROM Product2 WHERE ${clauses.join(" AND ")} LIMIT 5`,
    );
    return res.records;
  } catch {
    return [];
  }
}

/** Similar-name recommendations are scoped to existing Bundles only — a plain Product with a similar name isn't a useful "did you mean this bundle?" suggestion. */
async function findSimilarBundleCandidates(client: SalesforceClient, name: string, excludeId?: string) {
  const token = name.trim().split(/\s+/)[0];
  if (!token) return [];
  const clauses = [`Name LIKE '%${soqlEscape(token)}%'`, `Type = 'Bundle'`];
  if (excludeId) clauses.push(`Id != '${soqlEscape(excludeId)}'`);
  try {
    const res = await client.query<{ Id: string; Name: string; ProductCode: string | null; Description: string | null }>(
      `SELECT Id, Name, ProductCode, Description FROM Product2 WHERE ${clauses.join(" AND ")} LIMIT 25`,
    );
    return res.records;
  } catch {
    return [];
  }
}

function toCatalogProductShape(r: { Id: string; Name: string; ProductCode: string | null; Description: string | null }): CatalogProduct {
  return { id: r.Id, name: r.Name, productCode: r.ProductCode, description: r.Description ?? null, family: null, pricebookEntryId: "", listPrice: 0, isBundleCandidate: true };
}

async function buildExistingRecord(client: SalesforceClient, r: Product2Row): Promise<DuplicateExistingRecord> {
  const base: DuplicateExistingRecord = {
    recordId: r.Id, recordName: r.Name, recordCode: r.ProductCode ?? null,
    isActive: r.IsActive !== false, family: null,
    componentCount: null, sellingModel: null, catalog: null, category: null,
    lastModifiedDate: r.LastModifiedDate ?? null,
  };
  if (r.Type !== "Bundle") return base;

  // Best-effort enrichment for a genuine existing Bundle — never blocks the duplicate result on a failed lookup.
  try {
    const { loadBundleDetail } = await import("@/lib/bundles/server/bundleDetail");
    const detail = await loadBundleDetail(client, r.Id);
    return {
      ...base,
      componentCount: detail.components.length,
      sellingModel: detail.sellingModel,
      catalog: detail.catalog,
      category: detail.category,
    };
  } catch {
    return base;
  }
}

/**
 * The authoritative "would creating a Bundle with this Name/Code duplicate
 * an existing one?" check — the Bundle counterpart to
 * lib/products/server/duplicateCheck.ts's checkProductDuplicate, same
 * response shape, same call sites (frontend pre-check route, and the final
 * server-side gate inside POST /api/bundles/execute before any batch
 * runs). Pass `excludeId` when checking during an Edit save.
 */
export async function checkBundleDuplicate(
  client: SalesforceClient,
  input: { name: string; code?: string | null; excludeId?: string },
): Promise<DuplicateCheckResult> {
  const codeMatches = input.code ? await queryByField(client, "ProductCode", input.code, input.excludeId) : [];
  const exactCode = input.code
    ? codeMatches.find(r => normalizeForCompare(r.ProductCode ?? "") === normalizeForCompare(input.code!)) ?? null
    : null;

  const target = normalizeForCompare(input.name);
  const nameMatches = await queryByField(client, "Name", input.name, input.excludeId);
  const exactName = nameMatches.find(r => normalizeForCompare(r.Name) === target) ?? null;

  const similarCandidates = await findSimilarBundleCandidates(client, input.name, input.excludeId);
  const ranked = rankProductNameMatches(input.name, similarCandidates.map(toCatalogProductShape));
  const similarRecords: DuplicateSimilarRecord[] = ranked.candidates
    .filter(c => c.matchType !== "exact" && (!exactName || c.product.id !== exactName.Id))
    .slice(0, 5)
    .map(c => ({ recordId: c.product.id, recordName: c.product.name, recordCode: c.product.productCode }));

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
      existing: await buildExistingRecord(client, match),
      similarRecords,
    };
  }

  return { isDuplicate: false, similarRecords };
}
