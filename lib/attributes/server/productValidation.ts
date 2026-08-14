import type { SalesforceClient } from "@/lib/salesforce/client";
import { findProductMatches } from "@/lib/products/server/duplicateCheck";
import type { ProductValidationResult, ProductValidationCandidate } from "@/lib/attributes/types";

/**
 * Does the Product referenced by an Attribute prompt already exist in
 * Salesforce? Reuses the SAME `findProductMatches` primitive the global
 * Duplicate Prevention system (lib/products/server/duplicateCheck.ts) uses
 * for its own exact/similar Product2 lookup — one Product-name-resolution
 * implementation shared by two different framings of the result: blocking
 * a duplicate create there, resolving a product to attach an attribute to
 * here. Not pricebook-scoped (unlike the old implementation), so a Product
 * with no PricebookEntry yet is still discoverable.
 *
 * Only an exact (case-insensitive, whitespace-trimmed) name match is
 * treated as "found" and allowed to continue automatically — a high-
 * confidence fuzzy match is still surfaced as a candidate for the user to
 * explicitly pick (Section 28's gate: never attach an Attribute to a
 * product the user didn't confirm exists).
 */
export async function validateProductExists(client: SalesforceClient, productName: string): Promise<ProductValidationResult> {
  const { exact, similar } = await findProductMatches(client, productName);
  if (exact) {
    return { status: "found", product: { id: exact.Id, name: exact.Name, productCode: exact.ProductCode } };
  }

  const candidates: ProductValidationCandidate[] = similar.map(s => ({
    id: s.recordId, name: s.recordName, productCode: s.recordCode,
    confidence: 0.85, matchType: "substring",
  }));
  return { status: "not_found", candidates };
}
