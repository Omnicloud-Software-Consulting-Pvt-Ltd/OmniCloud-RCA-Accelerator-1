import type { ContractFieldSchema, ContractFormData } from "@/lib/contracts/types";

export interface ResolvedContractLookupIds {
  accountId: string | null;
  pricebookId: string | null;
  companySignedById: string | null;
  customerSignedById: string | null;
}

/**
 * Build the Contract creation payload from only fields that both resolved
 * via metadata AND have a non-null value (§3.5) — the exact same function
 * backs both the pre-submission preview JSON and the real create call.
 * Company/Customer Signed Date ARE written here if the user supplied them
 * manually — they're only exempted from the *required-field* check (§3.2),
 * not excluded from the payload outright.
 */
export function buildContractPayload(
  schema: ContractFieldSchema,
  formData: ContractFormData,
  lookups: ResolvedContractLookupIds,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (schema.accountField && lookups.accountId) payload[schema.accountField.apiName] = lookups.accountId;
  if (schema.pricebookField && lookups.pricebookId) payload[schema.pricebookField.apiName] = lookups.pricebookId;
  if (schema.statusField && formData.status) payload[schema.statusField.apiName] = formData.status;
  if (schema.contractTypeField && formData.contractType) payload[schema.contractTypeField.apiName] = formData.contractType;
  if (schema.startDateField && formData.startDate) payload[schema.startDateField.apiName] = formData.startDate;
  if (schema.contractTermField && formData.contractTerm) payload[schema.contractTermField.apiName] = Number(formData.contractTerm);
  if (schema.companySignedByField && lookups.companySignedById) payload[schema.companySignedByField.apiName] = lookups.companySignedById;
  if (schema.companySignedDateField && formData.companySignedDate) payload[schema.companySignedDateField.apiName] = formData.companySignedDate;
  if (schema.customerSignedByField && lookups.customerSignedById) payload[schema.customerSignedByField.apiName] = lookups.customerSignedById;
  if (schema.customerSignedTitleField && formData.customerSignedTitle) payload[schema.customerSignedTitleField.apiName] = formData.customerSignedTitle;
  if (schema.customerSignedDateField && formData.customerSignedDate) payload[schema.customerSignedDateField.apiName] = formData.customerSignedDate;
  if (schema.descriptionField && formData.description) payload[schema.descriptionField.apiName] = formData.description;

  // §2.1 defense-in-depth: EndDate must NEVER be written, even if some future
  // caller mistakenly believes it's editable — there is no branch above that
  // could add it, and this holds even if schema.endDateField.calculated is
  // ever (incorrectly) false, because no formData field feeds it at all.

  return payload;
}

/**
 * Partial-update payload builder (§3.5) — writes a field only if it BOTH
 * resolved via metadata AND is present in `updateableApiNames`. Repeats the
 * EndDate `calculated` guard explicitly as defense-in-depth, even though
 * `updateableApiNames` should already exclude a formula field.
 */
export function buildContractUpdatePayload(
  schema: ContractFieldSchema,
  patch: Partial<ContractFormData>,
  lookups: Partial<ResolvedContractLookupIds>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const updateable = new Set(schema.updateableApiNames);

  function setIfEditable(field: { apiName: string } | null, value: unknown) {
    if (!field || value == null || value === "") return;
    if (!updateable.has(field.apiName)) return;
    if (schema.endDateField && field.apiName === schema.endDateField.apiName && schema.endDateField.calculated) return;
    payload[field.apiName] = value;
  }

  setIfEditable(schema.accountField, lookups.accountId);
  setIfEditable(schema.pricebookField, lookups.pricebookId);
  setIfEditable(schema.statusField, patch.status);
  setIfEditable(schema.contractTypeField, patch.contractType);
  setIfEditable(schema.startDateField, patch.startDate);
  setIfEditable(schema.contractTermField, patch.contractTerm != null && patch.contractTerm !== "" ? Number(patch.contractTerm) : undefined);
  setIfEditable(schema.companySignedByField, lookups.companySignedById);
  setIfEditable(schema.companySignedDateField, patch.companySignedDate);
  setIfEditable(schema.customerSignedByField, lookups.customerSignedById);
  setIfEditable(schema.customerSignedTitleField, patch.customerSignedTitle);
  setIfEditable(schema.customerSignedDateField, patch.customerSignedDate);
  setIfEditable(schema.descriptionField, patch.description);

  return payload;
}
