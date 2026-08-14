import {
  suggestColumnMapping as genericSuggest,
  toMappingRecord as genericToMappingRecord,
  type ImportFieldDef,
  type ImportToolkitConfig,
  type ColumnMappingSuggestion as GenericColumnMappingSuggestion,
} from "@/lib/import/columnMapping";

/**
 * Canonical import fields for Products. The matching engine itself now
 * lives in lib/import/columnMapping.ts (shared with Quotes/Contracts/
 * Orders) — this file only supplies the Product-specific field list and
 * re-exports the same `CANONICAL_FIELDS`/`CanonicalField`/
 * `suggestColumnMapping`/`toMappingRecord` names the Product importer
 * already depends on, so nothing downstream needed to change.
 */
export type CanonicalField =
  | "name"
  | "productCode"
  | "description"
  | "family"
  | "type"
  | "category"
  | "catalog"
  | "sellingModel"
  | "price"
  | "currency"
  | "isActive";

export type ColumnMappingSuggestion = GenericColumnMappingSuggestion<CanonicalField>;

export const CANONICAL_FIELDS: ImportFieldDef<CanonicalField>[] = [
  { key: "name", label: "Product Name", required: true, aliases: ["product name", "productname", "name", "title"],
    toolkit: { format: "Text", example: "Laptop Pro 15", description: "Name of the product." } },
  { key: "productCode", label: "Product Code", required: false, aliases: ["product code", "productcode", "code", "sku", "item code"],
    toolkit: { format: "Text", example: "LAP-015", description: "Unique product code. Leave blank and one is auto-generated from the Product Name." } },
  { key: "description", label: "Description", required: false, aliases: ["description", "desc", "product description"],
    toolkit: { format: "Text", example: "Professional laptop for business use", description: "Product description." } },
  { key: "family", label: "Product Family", required: true, aliases: ["product family", "family"],
    toolkit: { format: "Text", example: "Electronics", description: "Product family/grouping." } },
  { key: "type", label: "Product Type", required: false, aliases: ["product type", "producttype", "type", "classification"],
    toolkit: { format: "Text", example: "Goods", description: "Product type, sent as given. Leave blank for a standard product — most orgs only recognize a special value for bundles." } },
  { key: "category", label: "Product Category", required: false, aliases: ["product category", "productcategory", "category"],
    toolkit: {
      format: "Text", example: "Laptops", description: "Revenue Cloud product category. Created automatically if it doesn't already exist.",
      relationship: { object: "ProductCategory", note: "Resolved by name; auto-created when not found, so this never blocks the import." },
    } },
  { key: "catalog", label: "Product Catalog", required: false, aliases: ["product catalog", "productcatalog", "catalog"],
    toolkit: {
      format: "Text", example: "Electronics Catalog", description: "Revenue Cloud catalog. Created automatically if it doesn't already exist.",
      relationship: { object: "ProductCatalog", note: "Resolved by name; auto-created when not found, so this never blocks the import." },
    } },
  { key: "sellingModel", label: "Product Selling Model", required: false, aliases: ["product selling model", "productsellingmodel", "selling model", "sellingmodel", "psm"],
    toolkit: {
      format: "Text", example: "One-Time", description: "Product selling model.",
      conditional: "If provided, must match an existing Salesforce Product Selling Model — the row fails validation if it can't be resolved. Leave blank to skip.",
      relationship: { object: "ProductSellingModel", note: "Resolved by name against existing Salesforce records — NOT created automatically." },
    } },
  { key: "price", label: "Price", required: false, aliases: ["price", "unit price", "unitprice", "base price", "baseprice", "list price"],
    toolkit: { format: "Number", example: "1499", description: "Base list price — creates a Standard Price Book entry." } },
  { key: "currency", label: "Currency", required: false, aliases: ["currency", "currencyisocode", "currency code"],
    toolkit: { format: "3-letter ISO code", example: "USD", description: "Currency for the price. Non-ISO values are still sent, but Salesforce may reject them." } },
  { key: "isActive", label: "Active", required: false, aliases: ["active", "isactive", "status"],
    toolkit: { format: "Boolean", example: "TRUE", description: "Whether the product is active. Defaults to Active if left blank.", expectedValues: ["TRUE", "FALSE", "Yes", "No", "1", "0", "Active", "Inactive"] } },
];

export const PRODUCT_IMPORT_TOOLKIT: ImportToolkitConfig<CanonicalField> = {
  moduleLabel: "Product Import",
  exampleColumns: ["name", "productCode", "family", "category", "catalog", "sellingModel", "price", "isActive"],
  exampleRows: [
    { name: "Laptop Pro 15", productCode: "LAP-015", family: "Electronics", category: "Laptops", catalog: "Electronics Catalog", sellingModel: "One-Time", price: "1499", isActive: "TRUE" },
    { name: "Wireless Mouse", productCode: "MOU-002", family: "Electronics", category: "Accessories", catalog: "Electronics Catalog", sellingModel: "One-Time", price: "29", isActive: "TRUE" },
  ],
};

export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function suggestColumnMapping(headers: string[]): ColumnMappingSuggestion[] {
  return genericSuggest(headers, CANONICAL_FIELDS);
}

export function toMappingRecord(suggestions: ColumnMappingSuggestion[]): Record<CanonicalField, string | null> {
  return genericToMappingRecord(suggestions, CANONICAL_FIELDS);
}
