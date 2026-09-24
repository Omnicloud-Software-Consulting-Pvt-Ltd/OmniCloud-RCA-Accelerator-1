import type { SalesforceClient } from "@/lib/salesforce/client";
import { resolveReferencesByName } from "@/lib/quotes/quote/reference";
import { resolveContractFieldSchema } from "@/lib/contracts/metadata/contractFields";
import type { ContractFormData } from "@/lib/contracts/types";
import type { ContractField } from "./columnMapping";

export type RowStatus = "ready" | "warning" | "error";
export interface RowIssue { level: "error" | "warning" | "info"; field?: string; message: string }

export interface ContractImportRowInput {
  displayName: string;
  accountName: string;
  pricebookName: string;
  status: string;
  contractType: string;
  startDate: string;
  contractTerm: string;
  description: string;
}

export interface ContractImportRowResult {
  index: number;
  status: RowStatus;
  issues: RowIssue[];
  input: ContractImportRowInput;
  /** The exact shape POSTed as `{ formData }` to /api/contracts — null for rows excluded from creation (error). */
  formData: ContractFormData | null;
}

export interface ValidateContractRowsResult {
  rows: ContractImportRowResult[];
  summary: { total: number; ready: number; warnings: number; errors: number };
}

/**
 * Validates + resolves every parsed Contract import row against the
 * connected Salesforce org and builds the exact ContractFormData each
 * creatable row will later POST (as `{ formData }`) to the existing
 * POST /api/contracts — the same endpoint the manual Contract Creation flow
 * already uses, via the same resolveContractFieldSchema/
 * resolveReferencesByName this route itself calls. This route only reads
 * from Salesforce, it never creates anything.
 */
export async function validateContractRows(
  client: SalesforceClient,
  rawRows: Record<string, string>[],
  mapping: Record<ContractField, string | null>,
): Promise<ValidateContractRowsResult> {
  const get = (row: Record<string, string>, field: ContractField): string => {
    const header = mapping[field];
    if (!header) return "";
    return (row[header] ?? "").toString().trim();
  };

  const inputs: ContractImportRowInput[] = rawRows.map(row => ({
    displayName: get(row, "displayName"),
    accountName: get(row, "accountName"),
    pricebookName: get(row, "pricebookName"),
    status: get(row, "status"),
    contractType: get(row, "contractType"),
    startDate: get(row, "startDate"),
    contractTerm: get(row, "contractTerm"),
    description: get(row, "description"),
  }));

  const schema = await resolveContractFieldSchema(client);

  const accountResults = await resolveReferencesByName(client, inputs.map(i => ({ objectType: "Account" as const, name: i.accountName })));
  const pricebookResults = await resolveReferencesByName(client, inputs.map(i => ({ objectType: "Pricebook2" as const, name: i.pricebookName })));

  const rows: ContractImportRowResult[] = inputs.map((input, i) => {
    const issues: RowIssue[] = [];

    if (!input.accountName) issues.push({ level: "error", field: "accountName", message: "Account is required." });
    else if (!accountResults[i]) issues.push({ level: "error", field: "accountName", message: `Account "${input.accountName}" could not be resolved in Salesforce.` });

    if (input.pricebookName && !pricebookResults[i]) {
      issues.push({ level: "warning", field: "pricebookName", message: `Price Book "${input.pricebookName}" could not be resolved — the contract will be created without a Price Book.` });
    }

    if (input.contractTerm && Number.isNaN(Number(input.contractTerm))) {
      issues.push({ level: "error", field: "contractTerm", message: `Contract Term "${input.contractTerm}" is not a valid number of months.` });
    }

    if (input.status && schema.statusField?.options?.length) {
      const known = schema.statusField.options.some(o => o.value.toLowerCase() === input.status.toLowerCase() || o.label.toLowerCase() === input.status.toLowerCase());
      if (!known) issues.push({ level: "warning", field: "status", message: `Status "${input.status}" is not one of this org's Contract Status values (${schema.statusField.options.map(o => o.label).join(", ")}) — Salesforce may reject it.` });
    }

    if (input.contractType && !schema.contractTypeField) {
      issues.push({ level: "info", field: "contractType", message: "This org's Contract object has no Contract Type field — this column will be ignored." });
    }

    const hasError = issues.some(iss => iss.level === "error");
    const status: RowStatus = hasError ? "error" : issues.some(iss => iss.level === "warning") ? "warning" : "ready";

    const formData: ContractFormData | null = status === "error" ? null : {
      accountName: input.accountName,
      pricebookName: input.pricebookName,
      status: input.status,
      contractType: input.contractType,
      startDate: input.startDate,
      contractTerm: input.contractTerm,
      companySignedByName: "",
      companySignedDate: "",
      customerSignedById: "",
      customerSignedByName: "",
      customerSignedTitle: "",
      customerSignedDate: "",
      description: input.description,
    };

    return { index: i, status, issues, input, formData };
  });

  const summary = {
    total: rows.length,
    ready: rows.filter(r => r.status === "ready").length,
    warnings: rows.filter(r => r.status === "warning").length,
    errors: rows.filter(r => r.status === "error").length,
  };

  return { rows, summary };
}
