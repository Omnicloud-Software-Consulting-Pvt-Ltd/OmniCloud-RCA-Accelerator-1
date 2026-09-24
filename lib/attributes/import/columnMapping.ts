import {
  type ImportFieldDef,
  type ImportToolkitConfig,
} from "@/lib/import/columnMapping";

/**
 * Canonical import fields for bulk Attribute import — mirrors the exact
 * 4-column spec (Product Name | Attribute Name | Data Type | Values) rather
 * than the earlier placeholder's forward-looking guess (which also carried
 * Description/Active columns the real spec doesn't ask for). "Values"
 * intentionally isn't called "Picklist Values" — it also carries Checkbox's
 * optional True/False sanity-check content, not just Picklist options.
 */
export type AttributeCanonicalField = "productName" | "attributeName" | "dataType" | "values";

export const ATTRIBUTE_FIELDS: ImportFieldDef<AttributeCanonicalField>[] = [
  { key: "productName", label: "Product Name", required: true, aliases: ["product name", "productname", "product"],
    toolkit: {
      format: "Text", example: "Laptop Pro 15", description: "The existing Product this attribute attaches to — rows sharing the same Product Name are grouped into one product's attribute set.",
      relationship: { object: "Product2", note: "Resolved by exact name match against Salesforce. If not found, this line is skipped — no Product is created automatically." },
      groupingKey: true,
    } },
  { key: "attributeName", label: "Attribute Name", required: true, aliases: ["attribute name", "attributename", "attribute"],
    toolkit: { format: "Text", example: "RAM", description: "The attribute's name/label. Skipped (not duplicated) if this exact Product already has an attribute with this name." } },
  { key: "dataType", label: "Data Type", required: true, aliases: ["data type", "datatype", "type"],
    toolkit: { format: "Text", example: "Picklist", description: "Attribute data type.", expectedValues: ["Picklist", "Checkbox", "Text", "Number", "Decimal", "Currency", "Date"] } },
  { key: "values", label: "Values", required: false, aliases: ["values", "value", "picklist values", "options"],
    toolkit: {
      format: "Comma-separated list", example: "8GB,16GB,32GB",
      description: "Allowed options for Picklist, or True/False for Checkbox (optional — Checkbox works with this left blank). Ignored for Text/Number/Decimal/Currency/Date.",
      conditional: "Conditional — required when Data Type = Picklist. Never treated as predefined values for any other Data Type.",
    } },
];

export const ATTRIBUTE_IMPORT_TOOLKIT: ImportToolkitConfig<AttributeCanonicalField> = {
  moduleLabel: "Attribute Import",
  groupingNote: "Rows sharing the same Product Name are grouped into one product's attribute set — one row per attribute, not one product per row.",
  exampleColumns: ["productName", "attributeName", "dataType", "values"],
  exampleRows: [
    { productName: "Laptop Pro 15", attributeName: "RAM", dataType: "Picklist", values: "8GB,16GB,32GB" },
    { productName: "Laptop Pro 15", attributeName: "Storage", dataType: "Picklist", values: "256GB,512GB,1TB" },
    { productName: "Laptop Pro 15", attributeName: "Touchscreen", dataType: "Checkbox", values: "True,False" },
    { productName: "Laptop Pro 15", attributeName: "Warranty Years", dataType: "Number", values: "" },
    { productName: "Laptop Pro 15", attributeName: "Processor", dataType: "Text", values: "" },
  ],
};
