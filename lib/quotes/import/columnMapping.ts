import {
  suggestColumnMapping as genericSuggest,
  toMappingRecord as genericToMappingRecord,
  type ImportFieldDef,
  type ImportToolkitConfig,
  type ColumnMappingSuggestion as GenericColumnMappingSuggestion,
} from "@/lib/import/columnMapping";

/**
 * Canonical import fields for bulk Quote import — mirrors `QuoteFormData`
 * (lib/quotes/types.ts) plus per-line-item Product/Quantity/Unit Price/
 * Discount columns. "name" doubles as the grouping key: rows sharing the
 * same mapped Quote Name value become ONE Quote with N line items, exactly
 * like Quote Number/Quote Code would in a real export — never one Quote
 * per row.
 */
export type QuoteField =
  | "name"
  | "accountName"
  | "opportunityName"
  | "pricebookName"
  | "startDate"
  | "expirationDate"
  | "status"
  | "description"
  | "product"
  | "quantity"
  | "unitPrice"
  | "discount";

export const QUOTE_FIELDS: ImportFieldDef<QuoteField>[] = [
  { key: "name", label: "Quote Name", required: true, aliases: ["quote name", "quotename", "name"],
    toolkit: { format: "Text", example: "Enterprise Quote", description: "Name of the Quote.", groupingKey: true } },
  { key: "accountName", label: "Account", required: false, aliases: ["account", "account name", "customer", "customer name"],
    toolkit: { format: "Text", example: "ABC Technologies", description: "Account this Quote belongs to. If left blank, the Quote is created without one.",
      relationship: { object: "Account", note: "Use the Salesforce Account name — the importer resolves it to the Account Id automatically." } } },
  { key: "opportunityName", label: "Opportunity", required: false, aliases: ["opportunity", "opportunity name"],
    toolkit: { format: "Text", example: "ABC Expansion", description: "Opportunity this Quote is linked to. If left blank, the Quote is created without one.",
      conditional: "Conditional — only meaningful if your Salesforce configuration links Quotes to Opportunities.",
      relationship: { object: "Opportunity", note: "Use the Salesforce Opportunity name — resolved to its Id automatically." } } },
  { key: "pricebookName", label: "Price Book", required: false, aliases: ["price book", "pricebook", "price book name", "pricebook name"],
    toolkit: { format: "Text", example: "Standard Price Book", description: "Price Book used to price the Quote's line items.",
      conditional: "Conditional — required for any Line Items to be added. Without a resolvable Price Book, Product/Quantity/Unit Price columns are ignored.",
      relationship: { object: "Pricebook2", note: "Use the Salesforce Price Book name — resolved to its Id automatically." } } },
  { key: "startDate", label: "Start Date", required: false, aliases: ["start date", "quote start date"],
    toolkit: { format: "Date (YYYY-MM-DD)", example: "2026-08-13", description: "Quote start date." } },
  { key: "expirationDate", label: "Expiration Date", required: false, aliases: ["expiration date", "expirationdate", "end date"],
    toolkit: { format: "Date (YYYY-MM-DD)", example: "2026-09-13", description: "Quote expiration date." } },
  { key: "status", label: "Status", required: false, aliases: ["status"],
    toolkit: { format: "Text", example: "Draft", description: "Quote status. Expected values depend on your Salesforce configuration — Draft is the common default." } },
  { key: "description", label: "Description", required: false, aliases: ["description", "desc"],
    toolkit: { format: "Text", example: "Q3 enterprise renewal", description: "Quote description." } },
  { key: "product", label: "Product", required: false, aliases: ["product", "product name", "product2"],
    toolkit: { format: "Text", example: "Laptop Pro 15", description: "Product for one Quote Line Item — one row per line item. Leave blank on a row that only carries Quote header info.",
      relationship: { object: "Product2 (via the Quote's Price Book)", note: "Resolved by name against the Price Book — must be uniquely identifiable." } } },
  { key: "quantity", label: "Quantity", required: false, aliases: ["quantity", "qty"],
    toolkit: { format: "Number", example: "5", description: "Line item quantity. Defaults to 1 if left blank.",
      conditional: "Conditional — only validated when a Product is given on that row." } },
  { key: "unitPrice", label: "Unit Price", required: false, aliases: ["unit price", "unitprice", "price"],
    toolkit: { format: "Number", example: "1499", description: "Overrides the Price Book's list price for this line item. Leave blank to use the list price.",
      conditional: "Conditional — only validated when a Product is given on that row." } },
  { key: "discount", label: "Discount (%)", required: false, aliases: ["discount", "discount percent", "discountpercent"],
    toolkit: { format: "Number", example: "10", description: "Line item discount percentage.",
      conditional: "Conditional — only validated when a Product is given on that row." } },
];

export const QUOTE_IMPORT_TOOLKIT: ImportToolkitConfig<QuoteField> = {
  moduleLabel: "Quote Import",
  groupingNote: "Rows sharing the same Quote Name are treated as Line Items belonging to the same Quote — one row per line item, not one Quote per row.",
  exampleColumns: ["name", "accountName", "opportunityName", "pricebookName", "startDate", "expirationDate", "status", "product", "quantity", "unitPrice"],
  exampleRows: [
    { name: "Enterprise Quote", accountName: "ABC Technologies", opportunityName: "ABC Expansion", pricebookName: "Standard Price Book", startDate: "2026-08-13", expirationDate: "2026-09-13", status: "Draft", product: "Laptop Pro 15", quantity: "5", unitPrice: "1499" },
    { name: "Enterprise Quote", accountName: "ABC Technologies", opportunityName: "ABC Expansion", pricebookName: "Standard Price Book", startDate: "2026-08-13", expirationDate: "2026-09-13", status: "Draft", product: "Premium Support", quantity: "1", unitPrice: "299" },
  ],
};

export type ColumnMappingSuggestion = GenericColumnMappingSuggestion<QuoteField>;

export function suggestColumnMapping(headers: string[]): ColumnMappingSuggestion[] {
  return genericSuggest(headers, QUOTE_FIELDS);
}

export function toMappingRecord(suggestions: ColumnMappingSuggestion[]): Record<QuoteField, string | null> {
  return genericToMappingRecord(suggestions, QUOTE_FIELDS);
}
