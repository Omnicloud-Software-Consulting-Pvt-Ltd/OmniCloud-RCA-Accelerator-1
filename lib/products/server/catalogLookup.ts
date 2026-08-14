import type { SalesforceClient } from "@/lib/salesforce/client";

/**
 * Read-only Catalog/Category existence lookups for the bulk importer's
 * pre-flight validation screen ("Catalog 'X' could not be resolved").
 * Deliberately separate from save/route.ts's `findOrCreate` — that function
 * CREATES a missing Catalog/Category as part of an actual product save, and
 * stays untouched so the AI single-create flow's behavior never changes.
 * This module only reports what already exists, by exact (case-insensitive)
 * name, so the importer can flag unresolved values before any Salesforce
 * write happens.
 */
export async function fetchCatalogNames(client: SalesforceClient): Promise<Map<string, string>> {
  const result = await client.query<{ Id: string; Name: string }>("SELECT Id, Name FROM ProductCatalog LIMIT 500");
  return new Map(result.records.map(r => [r.Name.toLowerCase(), r.Id]));
}

export async function fetchCategoryNames(client: SalesforceClient): Promise<Map<string, string>> {
  const result = await client.query<{ Id: string; Name: string }>("SELECT Id, Name FROM ProductCategory LIMIT 1000");
  return new Map(result.records.map(r => [r.Name.toLowerCase(), r.Id]));
}
