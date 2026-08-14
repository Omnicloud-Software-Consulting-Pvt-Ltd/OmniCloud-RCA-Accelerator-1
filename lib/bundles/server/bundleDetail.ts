import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { loadBundleComponents, type BundleComponentRow } from "@/lib/bundles/server/relationships";

export interface BundleDetail {
  id: string;
  name: string;
  productCode: string | null;
  description: string | null;
  family: string | null;
  type: string | null;
  isActive: boolean;
  catalog: string | null;
  category: string | null;
  sellingModel: string | null;
  priceBook: string | null;
  basePrice: string | null;
  currencyIsoCode: string | null;
  components: BundleComponentRow[];
  createdDate: string;
  lastModifiedDate: string;
}

/**
 * Reads back everything the Bundle Detail/Edit workspace needs — the
 * mirror image of Create Bundle's write path (Product2 core fields, its
 * Catalog/Category link, its PricebookEntry, its ProductSellingModelOption,
 * and its ProductRelatedComponent children) — so Edit Bundle opens showing
 * what's actually in Salesforce right now, never a blank form. Reuses
 * loadBundleComponents() (the same read Bundle History's row-expand and the
 * [id] route share) for the child list.
 */
export async function loadBundleDetail(client: SalesforceClient, id: string): Promise<BundleDetail> {
  const record = await client.getRecord("Product2", id, ["Id", "Name", "ProductCode", "Description", "Family", "Type", "IsActive", "CreatedDate", "LastModifiedDate"]);
  if (record.Type !== "Bundle") {
    throw new Error(`Product ${id} is not a Bundle (Type=${record.Type ?? "null"}).`);
  }

  let catalog: string | null = null;
  let category: string | null = null;
  try {
    const catRes = await client.query<{ ProductCategory: { Name: string; Catalog?: { Name: string } | null } | null }>(
      `SELECT ProductCategory.Name, ProductCategory.Catalog.Name FROM ProductCategoryProduct WHERE ProductId = '${soqlEscape(id)}' LIMIT 1`,
    );
    const link = catRes.records[0]?.ProductCategory;
    if (link) { category = link.Name ?? null; catalog = link.Catalog?.Name ?? null; }
  } catch { /* ProductCategoryProduct not accessible, or none linked */ }

  let priceBook: string | null = null;
  let basePrice: string | null = null;
  let currencyIsoCode: string | null = null;
  try {
    const pbRes = await client.query<{ UnitPrice: number; CurrencyIsoCode?: string; Pricebook2: { Name: string } | null }>(
      `SELECT UnitPrice, CurrencyIsoCode, Pricebook2.Name FROM PricebookEntry WHERE Product2Id = '${soqlEscape(id)}' LIMIT 5`,
    );
    const preferred = pbRes.records.find(r => r.Pricebook2?.Name === "Standard Price Book") ?? pbRes.records[0];
    if (preferred) {
      priceBook = preferred.Pricebook2?.Name ?? null;
      basePrice = preferred.UnitPrice != null ? String(preferred.UnitPrice) : null;
      currencyIsoCode = preferred.CurrencyIsoCode ?? null;
    }
  } catch { /* PricebookEntry not accessible, or none created yet */ }

  let sellingModel: string | null = null;
  try {
    const smRes = await client.query<{ ProductSellingModel: { Name: string } | null }>(
      `SELECT ProductSellingModel.Name FROM ProductSellingModelOption WHERE Product2Id = '${soqlEscape(id)}' LIMIT 1`,
    );
    sellingModel = smRes.records[0]?.ProductSellingModel?.Name ?? null;
  } catch { /* ProductSellingModelOption not accessible, or none linked */ }

  const components = await loadBundleComponents(client, id);

  return {
    id,
    name: (record.Name as string) ?? "",
    productCode: (record.ProductCode as string) ?? null,
    description: (record.Description as string) ?? null,
    family: (record.Family as string) ?? null,
    type: (record.Type as string) ?? null,
    isActive: record.IsActive !== false,
    catalog, category, sellingModel, priceBook, basePrice, currencyIsoCode,
    components,
    createdDate: record.CreatedDate as string,
    lastModifiedDate: record.LastModifiedDate as string,
  };
}
