import type { QuoteFieldSchema, QuoteFormData } from "@/lib/quotes/types";

export interface ResolvedLookupIds {
  accountId: string | null;
  pricebookId: string | null;
  opportunityId: string | null;
}

/**
 * Build the Quote creation payload from only the fields that both resolved
 * via metadata mapping AND have a non-null value (§3.6). This exact
 * function is used for both the pre-submission preview JSON and the real
 * create call — the two can never drift apart.
 */
export function buildQuotePayload(
  schema: QuoteFieldSchema,
  formData: QuoteFormData,
  lookups: ResolvedLookupIds,
  finalName: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (schema.nameField) payload[schema.nameField.apiName] = finalName;
  if (schema.accountField && lookups.accountId) payload[schema.accountField.apiName] = lookups.accountId;
  if (schema.pricebookField && lookups.pricebookId) payload[schema.pricebookField.apiName] = lookups.pricebookId;
  if (schema.opportunityField && lookups.opportunityId) payload[schema.opportunityField.apiName] = lookups.opportunityId;
  if (schema.startDateField && formData.startDate) payload[schema.startDateField.apiName] = formData.startDate;
  if (schema.expirationDateField && formData.expirationDate) payload[schema.expirationDateField.apiName] = formData.expirationDate;
  if (schema.descriptionField && formData.description) payload[schema.descriptionField.apiName] = formData.description;
  if (schema.statusField && formData.status) payload[schema.statusField.apiName] = formData.status;

  return payload;
}
