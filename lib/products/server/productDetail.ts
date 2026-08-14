import type { SalesforceClient } from "@/lib/salesforce/client";
import type { ProductPayload } from "@/lib/products/types";
import { soqlEscape } from "@/lib/products/server/salesforceWrites";

export interface ProductEditDetail extends ProductPayload {
  id: string;
}

/**
 * Reads back everything the Edit workspace needs to pre-populate a product
 * with its CURRENT Salesforce values — the mirror image of what
 * /api/sf/products/save writes (Product2 core fields, its Catalog/Category
 * link, its PricebookEntry, its ProductSellingModelOption) — so "Edit
 * Product" opens showing what's actually in the org, not stale/blank
 * fields. Read-only; never creates or modifies anything.
 */
export async function loadProductDetail(client: SalesforceClient, id: string): Promise<ProductEditDetail> {
  const record = await client.getRecord("Product2", id, ["Id", "Name", "ProductCode", "Family", "Description", "IsActive", "Type"]);

  let category = "";
  let catalog = "";
  try {
    const catRes = await client.query<{ ProductCategory: { Name: string; Catalog?: { Name: string } | null } | null }>(
      `SELECT ProductCategory.Name, ProductCategory.Catalog.Name FROM ProductCategoryProduct WHERE ProductId = '${soqlEscape(id)}' LIMIT 1`,
    );
    const link = catRes.records[0]?.ProductCategory;
    if (link) {
      category = link.Name ?? "";
      catalog = link.Catalog?.Name ?? "";
    }
  } catch {
    // ProductCategoryProduct not accessible in this org, or no category linked — leave blank.
  }

  let priceBook = "";
  let basePrice = "";
  let currencyIsoCode = "";
  try {
    const pbRes = await client.query<{ Id: string; UnitPrice: number; CurrencyIsoCode?: string; Pricebook2: { Name: string } | null }>(
      `SELECT Id, UnitPrice, CurrencyIsoCode, Pricebook2.Name FROM PricebookEntry WHERE Product2Id = '${soqlEscape(id)}' LIMIT 5`,
    );
    const preferred = pbRes.records.find(r => r.Pricebook2?.Name === "Standard Price Book") ?? pbRes.records[0];
    if (preferred) {
      priceBook = preferred.Pricebook2?.Name ?? "";
      basePrice = preferred.UnitPrice !== undefined && preferred.UnitPrice !== null ? String(preferred.UnitPrice) : "";
      currencyIsoCode = preferred.CurrencyIsoCode ?? "";
    }
  } catch {
    // PricebookEntry not accessible, or none created yet — leave blank.
  }

  let sellingModel = "";
  try {
    const smRes = await client.query<{ ProductSellingModel: { Name: string } | null }>(
      `SELECT ProductSellingModel.Name FROM ProductSellingModelOption WHERE Product2Id = '${soqlEscape(id)}' LIMIT 1`,
    );
    sellingModel = smRes.records[0]?.ProductSellingModel?.Name ?? "";
  } catch {
    // ProductSellingModelOption not accessible, or none linked — leave blank.
  }

  return {
    id,
    productName: (record.Name as string) ?? "",
    productCode: (record.ProductCode as string) ?? "",
    family: (record.Family as string) ?? "",
    description: (record.Description as string) || undefined,
    isActive: record.IsActive !== false,
    category: category || undefined,
    catalog: catalog || undefined,
    sellingModel: sellingModel || undefined,
    priceBook: priceBook || undefined,
    basePrice: basePrice || undefined,
    currencyIsoCode: currencyIsoCode || undefined,
    productType: (record.Type as string) === "Bundle" ? "bundle" : undefined,
  };
}
