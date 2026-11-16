/**
 * Turns a Salesforce error into an actionable explanation — the Salesforce message is always kept verbatim; this only adds the
 * field it concerns and a recommended fix. Never replaces the message with a generic "Tax creation failed".
 */

const FIELD_FIX: Record<string, string> = {
  TaxEngineId: "Verify that the selected Tax Engine exists and is Active.",
  TaxEngineProviderId: "Select a Tax Engine Provider that exists in this org, or use the native Revenue Standard Tax engine type (it needs no provider).",
  MerchantCredentialId: "Select a Named Credential that exists in this org.",
  TaxPolicyId: "Verify that the Tax Policy exists and isn't Inactive.",
  DefaultTaxTreatmentId: "The default treatment must belong to this policy and be Active.",
  TaxTreatmentId: "Verify that the Tax Treatment exists (and uses Tax Treatment Items for item-level tax codes).",
  LegalEntityId: "Verify that the Legal Entity exists and is Active.",
  GeoCountryId: "Verify the tax country (GeoCountry ISO code).",
  ProductId: "Verify that the product exists and is active.",
  Product2Id: "Verify that the product exists and is active.",
  TaxCode: "Use a tax code that exists in this org's Revenue Cloud tax rates, or give the rate so it can be created.",
  ProductCode: "Salesforce doesn't allow editing the product code of an Active treatment — create a new treatment instead.",
  Status: "Check the record's status transition (Draft → Active).",
  TreatmentSelection: "Choose a Treatment Selection value Salesforce lists for Tax Policy.",
  RateUsageType: "Use the Revenue Cloud rate usage type this org lists for Tax Rate.",
};

const CODE_FIX: Record<string, string> = {
  REQUIRED_FIELD_MISSING: "Provide a value for the required field shown.",
  INVALID_FIELD: "This field doesn't exist for the current user in this org — re-check the org's metadata (Tax → Metadata).",
  INVALID_TYPE: "This object isn't available in this org/API version — Revenue Cloud Billing tax may not be enabled.",
  FIELD_INTEGRITY_EXCEPTION: "A referenced value is invalid for this record — check the field shown.",
  INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: "Choose one of the picklist values Salesforce lists for this field.",
  DUPLICATE_VALUE: "A record with this value already exists — reuse it or choose another name.",
  INSUFFICIENT_ACCESS: "The current user lacks access — assign the Tax Admin permission set (Tax → Engine Readiness).",
  INSUFFICIENT_ACCESS_OR_READONLY: "The current user lacks access — assign the Tax Admin permission set (Tax → Engine Readiness).",
  INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: "The current user can't access a referenced record — check sharing and the Tax Admin permission set.",
  INVALID_CROSS_REFERENCE_KEY: "A referenced record doesn't exist or isn't accessible — re-check the field shown.",
  UNABLE_TO_LOCK_ROW: "Another process is updating the record — wait a moment and run Create again (existing records are reused).",
  CANNOT_EXECUTE_FLOW_TRIGGER: "An org automation rejected the record — review the flow/trigger named in the message.",
  FIELD_CUSTOM_VALIDATION_EXCEPTION: "An org validation rule rejected the record — adjust the value it names.",
  ENTITY_IS_DELETED: "A referenced record was deleted — reload and preview again.",
};

export function recommendationFor(code: string | null | undefined, field: string | null | undefined, message?: string | null): string {
  if (/active/i.test(message ?? "") && /can't edit|cannot edit|while status is active/i.test(message ?? "")) return "Salesforce doesn't allow editing an Active record's fields — create a new record (another name) instead.";
  if (field && FIELD_FIX[field]) return FIELD_FIX[field];
  if (code && CODE_FIX[code]) return CODE_FIX[code];
  if (/permission|not currently enabled|insufficient access/i.test(message ?? "")) return CODE_FIX.INSUFFICIENT_ACCESS;
  return "Review the Salesforce message; nothing after this step was applied. Correct the input and preview again — records that were created are reused.";
}

/** The field a Salesforce error concerns: errors[].fields, else a field name quoted in the message. */
export function errorField(err: { fields?: string[]; message?: string } | null | undefined): string | null {
  if (err?.fields?.length) return err.fields[0];
  const m = (err?.message ?? "").match(/\b([A-Z][A-Za-z0-9]+(?:Id|Code|Name|Status|Selection|Type))\b/);
  return m ? m[1] : null;
}
