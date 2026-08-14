import {
  suggestColumnMapping as genericSuggest,
  toMappingRecord as genericToMappingRecord,
  type ImportFieldDef,
  type ImportToolkitConfig,
  type ColumnMappingSuggestion as GenericColumnMappingSuggestion,
} from "@/lib/import/columnMapping";

/**
 * Canonical import fields for Bundles — same generic matching engine
 * Products/Quotes/Contracts/Orders already share, just this module's own
 * field list. One row = one (Bundle, Product) pairing — multiple rows with
 * the same Bundle Code/Name are grouped into a single bundle by
 * lib/bundles/import/validateRows.ts, per the requirement that a
 * multi-row bundle create ONE parent bundle with N related products, not
 * N separate bundles.
 */
export type BundleCanonicalField =
  | "bundleName"
  | "bundleCode"
  | "description"
  | "family"
  | "bundleType"
  | "isActive"
  | "catalog"
  | "category"
  | "sellingModel"
  | "price"
  | "productName"
  | "relationship";

export const BUNDLE_CANONICAL_FIELDS: ImportFieldDef<BundleCanonicalField>[] = [
  { key: "bundleName", label: "Bundle Name", required: true, aliases: ["bundle name", "bundlename", "name", "bundle"],
    toolkit: { format: "Text", example: "Laptop Business Bundle", description: "Name of the parent bundle." } },
  { key: "bundleCode", label: "Bundle Code", required: false, aliases: ["bundle code", "bundlecode", "code", "sku"],
    toolkit: { format: "Text", example: "LBB-001", description: "Groups rows into one bundle when provided — falls back to Bundle Name for grouping if left blank.", groupingKey: true } },
  { key: "description", label: "Description", required: false, aliases: ["description", "desc", "bundle description"],
    toolkit: { format: "Text", example: "Complete business laptop setup", description: "Bundle description." } },
  { key: "family", label: "Family", required: false, aliases: ["family", "bundle family", "product family"],
    toolkit: { format: "Text", example: "Electronics", description: "Bundle family.", notSentToSalesforce: "Recorded during import, but not currently sent to Salesforce when the bundle is created." } },
  { key: "bundleType", label: "Bundle Type", required: false, aliases: ["bundle type", "bundletype", "type"],
    toolkit: { format: "Text", example: "Standard", description: "Bundle type." } },
  { key: "isActive", label: "Active", required: false, aliases: ["active", "isactive", "status"],
    toolkit: { format: "Boolean", example: "TRUE", description: "Whether the bundle is active.", expectedValues: ["TRUE", "FALSE", "Yes", "No"], notSentToSalesforce: "Recorded during import, but not currently sent to Salesforce when the bundle is created." } },
  { key: "catalog", label: "Catalog", required: false, aliases: ["catalog", "product catalog", "bundle catalog"],
    toolkit: { format: "Text", example: "Electronics Catalog", description: "Revenue Cloud catalog for the bundle.", relationship: { object: "ProductCatalog", note: "Resolved by name; created automatically when not found." } } },
  { key: "category", label: "Category", required: false, aliases: ["category", "product category", "bundle category"],
    toolkit: { format: "Text", example: "Laptops", description: "Revenue Cloud category — can also be set per component row.", relationship: { object: "ProductCategory", note: "Resolved by name; created automatically when not found." } } },
  { key: "sellingModel", label: "Selling Model", required: false, aliases: ["selling model", "sellingmodel", "psm"],
    toolkit: { format: "Text", example: "One-Time", description: "Selling model — can also be set per component row." } },
  { key: "price", label: "Price", required: false, aliases: ["price", "unit price", "unitprice", "base price"],
    toolkit: { format: "Number", example: "1499", description: "Price for this component product (per row, not the bundle total)." } },
  { key: "productName", label: "Product", required: true, aliases: ["product", "product name", "productname", "child product", "component"],
    toolkit: { format: "Text", example: "Laptop Pro 15", description: "One row per component product in the bundle.", relationship: { object: "Product2", note: "Resolved by name against your Salesforce product catalog." } } },
  { key: "relationship", label: "Relationship Type", required: false, aliases: ["relationship", "relationship type", "relationshiptype"],
    toolkit: { format: "Text", example: "Component", description: "Defines whether the component is required in the bundle.", expectedValues: ["Component", "Optional", "Dependency"] } },
];

export const BUNDLE_IMPORT_TOOLKIT: ImportToolkitConfig<BundleCanonicalField> = {
  moduleLabel: "Bundle Import",
  groupingNote: "Multiple rows with the same Bundle Code (or Bundle Name, if no code is given) are treated as components of the same Bundle — one row per component, not one bundle per row.",
  exampleColumns: ["bundleName", "bundleCode", "productName", "relationship"],
  exampleRows: [
    { bundleName: "Laptop Business Bundle", bundleCode: "LBB-001", productName: "Laptop Pro 15", relationship: "Component" },
    { bundleName: "Laptop Business Bundle", bundleCode: "LBB-001", productName: "Wireless Mouse", relationship: "Optional" },
    { bundleName: "Laptop Business Bundle", bundleCode: "LBB-001", productName: "USB-C Dock", relationship: "Component" },
  ],
};

export type BundleColumnMappingSuggestion = GenericColumnMappingSuggestion<BundleCanonicalField>;

export function suggestBundleColumnMapping(headers: string[]): BundleColumnMappingSuggestion[] {
  return genericSuggest(headers, BUNDLE_CANONICAL_FIELDS);
}

export function toBundleMappingRecord(suggestions: BundleColumnMappingSuggestion[]): Record<BundleCanonicalField, string | null> {
  return genericToMappingRecord(suggestions, BUNDLE_CANONICAL_FIELDS);
}
