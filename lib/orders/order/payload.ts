import type { OrderFieldSchema, OrderFormData } from "@/lib/orders/types";

export interface ResolvedOrderLookupIds {
  accountId: string | null;
  pricebookId: string | null;
  contractId: string | null;
  sourceQuoteId: string | null;
}

/**
 * Build the Order creation payload from only the fields that both resolved
 * via metadata mapping AND have a non-null value (§3.8) — the exact same
 * function backs both the pre-submission preview JSON and the real create
 * call. Unlike Quote, there is no name/versioning concern (§3.5): OrderNumber
 * is system-assigned and never part of this payload.
 */
export function buildOrderPayload(
  schema: OrderFieldSchema,
  formData: OrderFormData,
  lookups: ResolvedOrderLookupIds,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (schema.accountField && lookups.accountId) payload[schema.accountField.apiName] = lookups.accountId;
  if (schema.pricebookField && lookups.pricebookId) payload[schema.pricebookField.apiName] = lookups.pricebookId;
  if (schema.contractField && lookups.contractId) payload[schema.contractField.apiName] = lookups.contractId;
  if (schema.sourceQuoteField && lookups.sourceQuoteId) payload[schema.sourceQuoteField.apiName] = lookups.sourceQuoteId;
  if (schema.effectiveDateField && formData.effectiveDate) payload[schema.effectiveDateField.apiName] = formData.effectiveDate;
  if (schema.statusField && formData.status) payload[schema.statusField.apiName] = formData.status;
  if (schema.typeField && formData.type) payload[schema.typeField.apiName] = formData.type;
  if (schema.poNumberField && formData.poNumber) payload[schema.poNumberField.apiName] = formData.poNumber;
  if (schema.poDateField && formData.poDate) payload[schema.poDateField.apiName] = formData.poDate;
  if (schema.descriptionField && formData.description) payload[schema.descriptionField.apiName] = formData.description;

  return payload;
}
