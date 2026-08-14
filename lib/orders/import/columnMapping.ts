import {
  suggestColumnMapping as genericSuggest,
  toMappingRecord as genericToMappingRecord,
  type ImportFieldDef,
  type ImportToolkitConfig,
  type ColumnMappingSuggestion as GenericColumnMappingSuggestion,
} from "@/lib/import/columnMapping";

/**
 * Canonical import fields for bulk Order import — mirrors `OrderFormData`
 * (lib/orders/types.ts) plus per-line-item Product/Quantity/Unit Price
 * columns. Order has no writable Name/OrderNumber (system-assigned) — the
 * "Order Number" a CSV provides is only a grouping/display key
 * (`orderKey`), used to group multiple rows into one Order + N line items,
 * never sent to Salesforce.
 */
export type OrderField =
  | "orderKey"
  | "accountName"
  | "pricebookName"
  | "effectiveDate"
  | "status"
  | "type"
  | "poNumber"
  | "poDate"
  | "contractName"
  | "sourceQuoteName"
  | "description"
  | "product"
  | "quantity"
  | "unitPrice";

export const ORDER_FIELDS: ImportFieldDef<OrderField>[] = [
  { key: "orderKey", label: "Order Number", required: false, aliases: ["order number", "ordernumber", "order name", "order", "order code", "order id"],
    toolkit: { format: "Text", example: "ORD-1001", description: "Groups rows into one Order.", groupingKey: true, notSentToSalesforce: "Order Number is system-assigned by Salesforce — this column is only used to group rows into one Order during import." } },
  { key: "accountName", label: "Account", required: true, aliases: ["account", "account name", "customer", "customer name"],
    toolkit: { format: "Text", example: "ABC Technologies", description: "Account this Order belongs to.",
      relationship: { object: "Account", note: "Use the Salesforce Account name — the importer resolves it to the Account Id automatically." } } },
  { key: "pricebookName", label: "Price Book", required: true, aliases: ["price book", "pricebook", "price book name", "pricebook name"],
    toolkit: { format: "Text", example: "Standard Price Book", description: "Price Book used to price the Order's line items.",
      relationship: { object: "Pricebook2", note: "Use the Salesforce Price Book name — resolved to its Id automatically." } } },
  { key: "effectiveDate", label: "Order Date", required: false, aliases: ["order date", "effective date", "start date"],
    toolkit: { format: "Date (YYYY-MM-DD)", example: "2026-08-13", description: "Order effective/start date." } },
  { key: "status", label: "Status", required: false, aliases: ["status"],
    toolkit: { format: "Text", example: "Draft", description: "Order status. Expected values depend on your Salesforce configuration." } },
  { key: "type", label: "Order Type", required: false, aliases: ["order type", "type"],
    toolkit: { format: "Text", example: "Standard", description: "Order type. Expected values depend on your Salesforce configuration." } },
  { key: "poNumber", label: "PO Number", required: false, aliases: ["po number", "ponumber", "purchase order number"],
    toolkit: { format: "Text", example: "PO-4471", description: "Customer purchase order number." } },
  { key: "poDate", label: "PO Date", required: false, aliases: ["po date", "podate"],
    toolkit: { format: "Date (YYYY-MM-DD)", example: "2026-08-10", description: "Purchase order date." } },
  { key: "contractName", label: "Contract", required: false, aliases: ["contract", "contract name", "contract number"],
    toolkit: { format: "Text", example: "Enterprise Agreement", description: "Contract this Order is linked to. If left blank, the Order is created without one.",
      relationship: { object: "Contract", note: "Use the Salesforce Contract name/number — resolved automatically." } } },
  { key: "sourceQuoteName", label: "Quote", required: false, aliases: ["quote", "source quote", "quote name", "sourcequote"],
    toolkit: { format: "Text", example: "Enterprise Quote", description: "Quote this Order was created from. If left blank, the Order is created without one.",
      relationship: { object: "Quote", note: "Use the Salesforce Quote name — resolved automatically." } } },
  { key: "description", label: "Description", required: false, aliases: ["description", "desc"],
    toolkit: { format: "Text", example: "Q3 hardware rollout", description: "Order description." } },
  { key: "product", label: "Product", required: false, aliases: ["product", "product name", "product2"],
    toolkit: { format: "Text", example: "Laptop Pro 15", description: "Product for one Order Line Item — one row per line item. Leave blank on a row that only carries Order header info.",
      relationship: { object: "Product2 (via the Order's Price Book)", note: "Resolved by name against the Price Book — must be uniquely identifiable." } } },
  { key: "quantity", label: "Quantity", required: false, aliases: ["quantity", "qty"],
    toolkit: { format: "Number", example: "2", description: "Line item quantity. Defaults to 1 if left blank.",
      conditional: "Conditional — only validated when a Product is given on that row." } },
  { key: "unitPrice", label: "Unit Price", required: false, aliases: ["unit price", "unitprice", "price"],
    toolkit: { format: "Number", example: "1499", description: "Overrides the Price Book's list price for this line item. Leave blank to use the list price.",
      conditional: "Conditional — only validated when a Product is given on that row." } },
];

export const ORDER_IMPORT_TOOLKIT: ImportToolkitConfig<OrderField> = {
  moduleLabel: "Order Import",
  groupingNote: "Multiple rows with the same Order Number represent multiple Order Line Items for the same Order — one row per line item, not one Order per row.",
  exampleColumns: ["orderKey", "accountName", "effectiveDate", "type", "status", "pricebookName", "product", "quantity", "unitPrice"],
  exampleRows: [
    { orderKey: "ORD-1001", accountName: "ABC Technologies", effectiveDate: "2026-08-13", type: "Standard", status: "Draft", pricebookName: "Standard Price Book", product: "Laptop Pro 15", quantity: "2", unitPrice: "1499" },
  ],
};

export type ColumnMappingSuggestion = GenericColumnMappingSuggestion<OrderField>;

export function suggestColumnMapping(headers: string[]): ColumnMappingSuggestion[] {
  return genericSuggest(headers, ORDER_FIELDS);
}

export function toMappingRecord(suggestions: ColumnMappingSuggestion[]): Record<OrderField, string | null> {
  return genericToMappingRecord(suggestions, ORDER_FIELDS);
}
