import {
  suggestColumnMapping as genericSuggest,
  toMappingRecord as genericToMappingRecord,
  type ImportFieldDef,
  type ImportToolkitConfig,
  type ColumnMappingSuggestion as GenericColumnMappingSuggestion,
} from "@/lib/import/columnMapping";

/**
 * Canonical import fields for bulk Contract import — mirrors the fields
 * `ContractFormData` (lib/contracts/types.ts) actually supports today.
 * Standard Contract has no writable Name field and EndDate is a read-only
 * formula field (§ existing Contract creation implementation) — both are
 * deliberately absent here rather than invented; "displayName" exists only
 * for the Preview UI's row label and is never sent to Salesforce.
 */
export type ContractField =
  | "displayName"
  | "accountName"
  | "pricebookName"
  | "status"
  | "contractType"
  | "startDate"
  | "contractTerm"
  | "description";

export const CONTRACT_FIELDS: ImportFieldDef<ContractField>[] = [
  { key: "displayName", label: "Contract Name (display only)", required: false, aliases: ["contract name", "name"],
    toolkit: { format: "Text", example: "Enterprise Agreement", description: "Label shown in the import preview only.", notSentToSalesforce: "Standard Contract has no writable Name field in Salesforce — this column is for your own reference and is never sent." } },
  { key: "accountName", label: "Account", required: true, aliases: ["account", "account name", "customer", "customer name"],
    toolkit: { format: "Text", example: "Grand Hotels & Resorts Ltd", description: "Account this Contract belongs to.",
      relationship: { object: "Account", note: "Use the Salesforce Account name — the importer resolves it to the Account Id automatically." } } },
  { key: "pricebookName", label: "Price Book", required: false, aliases: ["price book", "pricebook", "price book name", "pricebook name"],
    toolkit: { format: "Text", example: "Standard Price Book", description: "Price Book associated with the Contract. If left blank, the Contract is created without one.",
      relationship: { object: "Pricebook2", note: "Use the Salesforce Price Book name — resolved to its Id automatically." } } },
  { key: "status", label: "Status", required: false, aliases: ["status"],
    toolkit: { format: "Text", example: "Draft", description: "Contract status. Expected values depend on your Salesforce configuration — an unrecognized value is still sent, with a warning." } },
  { key: "contractType", label: "Contract Type", required: false, aliases: ["contract type", "type"],
    toolkit: { format: "Text", example: "Standard", description: "Contract type — only used if your org's Contract object has a Contract Type field; ignored otherwise." } },
  { key: "startDate", label: "Start Date", required: false, aliases: ["start date", "contract start date"],
    toolkit: { format: "Date (YYYY-MM-DD)", example: "2026-08-01", description: "Contract start date." } },
  { key: "contractTerm", label: "Contract Term (months)", required: false, aliases: ["contract term", "term", "term months", "months"],
    toolkit: { format: "Number (months)", example: "12", description: "Contract length in months. Salesforce computes End Date from Start Date + this Term — there is no separate writable End Date column." } },
  { key: "description", label: "Description", required: false, aliases: ["description", "desc"],
    toolkit: { format: "Text", example: "Annual enterprise services agreement", description: "Contract description." } },
];

export const CONTRACT_IMPORT_TOOLKIT: ImportToolkitConfig<ContractField> = {
  moduleLabel: "Contract Import",
  exampleColumns: ["displayName", "accountName", "startDate", "contractTerm", "status", "pricebookName"],
  exampleRows: [
    { displayName: "Enterprise Agreement", accountName: "Grand Hotels & Resorts Ltd", startDate: "2026-08-01", contractTerm: "12", status: "Draft", pricebookName: "Standard Price Book" },
  ],
};

export type ColumnMappingSuggestion = GenericColumnMappingSuggestion<ContractField>;

export function suggestColumnMapping(headers: string[]): ColumnMappingSuggestion[] {
  return genericSuggest(headers, CONTRACT_FIELDS);
}

export function toMappingRecord(suggestions: ColumnMappingSuggestion[]): Record<ContractField, string | null> {
  return genericToMappingRecord(suggestions, CONTRACT_FIELDS);
}
