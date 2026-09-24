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
  // Unit of Measure / Classification fields only exist in some orgs — only request the ones this org has.
  let optionalFields: string[] = [];
  try {
    const names = new Set((await client.describeObject("Product2")).fields.map(f => f.name));
    optionalFields = ["UnitOfMeasureId", "QuantityUnitOfMeasure", "BasedOnId"].filter(f => names.has(f));
  } catch { /* describe unavailable — read only the core fields */ }
  const record = await client.getRecord("Product2", id, ["Id", "Name", "ProductCode", "Family", "Description", "IsActive", "Type", ...optionalFields]);

  let unitOfMeasure = (record.QuantityUnitOfMeasure as string) ?? "";
  if (record.UnitOfMeasureId) {
    try {
      const u = await client.query<{ Name: string }>(`SELECT Name FROM UnitOfMeasure WHERE Id = '${soqlEscape(String(record.UnitOfMeasureId))}' LIMIT 1`);
      unitOfMeasure = u.records[0]?.Name ?? unitOfMeasure;
    } catch { /* UnitOfMeasure not queryable — keep the picklist value */ }
  }
  let classification = "";
  if (record.BasedOnId) {
    try {
      const c = await client.query<{ Name: string }>(`SELECT Name FROM ProductClassification WHERE Id = '${soqlEscape(String(record.BasedOnId))}' LIMIT 1`);
      classification = c.records[0]?.Name ?? "";
    } catch { /* ProductClassification not queryable — leave blank */ }
  }

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
  let multiCurrency = false;
  try {
    // CurrencyIsoCode only exists on PricebookEntry in multi-currency orgs — selecting it
    // unconditionally made this whole query fail (and the price show blank) in single-currency orgs.
    multiCurrency = (await client.describeObject("PricebookEntry")).fields.some(f => f.name === "CurrencyIsoCode");
  } catch { /* assume single-currency */ }
  try {
    const pbRes = await client.query<{ Id: string; UnitPrice: number; CurrencyIsoCode?: string; Pricebook2: { Name: string; IsStandard?: boolean } | null }>(
      `SELECT Id, UnitPrice, ${multiCurrency ? "CurrencyIsoCode, " : ""}Pricebook2.Name, Pricebook2.IsStandard FROM PricebookEntry WHERE Product2Id = '${soqlEscape(id)}' LIMIT 5`,
    );
    const preferred = pbRes.records.find(r => r.Pricebook2?.IsStandard) ?? pbRes.records[0];
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
    unitOfMeasure: unitOfMeasure || undefined,
    classification: classification || undefined,
  };
}
