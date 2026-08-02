import type { SalesforceClient } from "@/lib/salesforce/client";
import {
  describeObjectCached,
  resolveField,
  findFieldByExactName,
  findFieldByLabel,
  findAccessibleFieldByNameOrLabel,
  findReferenceFieldByTargetObject,
  findReferenceFieldByLabel,
  findPicklistFieldByLabel,
  toFieldRef,
} from "@/lib/salesforce/describe";
import { createTTLCache } from "@/lib/salesforce/cache";
import type { ContractFieldSchema, ContractListFieldSchema, ContractFormData } from "@/lib/contracts/types";
import type { PicklistFieldRef } from "@/lib/quotes/types";

const contractSchemaCache = createTTLCache<ContractFieldSchema>();
const contractListSchemaCache = createTTLCache<ContractListFieldSchema>();

/**
 * Resolve the writable Contract field schema used by the creation form,
 * workspace edit view, and payload builder (§2.1, §3.4) — every field
 * resolves well-known-name-first, label-fallback, requireCreateable:true,
 * EXCEPT the two deliberate exceptions this spec calls out:
 *   - ContractNumber: name-first (its API name can never be renamed), not
 *     createable-gated (it's system-assigned, never part of a write payload).
 *   - EndDate: accessible-only, never createable-gated, because standard
 *     Contract.EndDate is a formula field (createable/updateable are
 *     always false) — its `calculated` flag rides along so the form/payload
 *     builder can refuse to ever treat it as writable.
 */
export async function resolveContractFieldSchema(client: SalesforceClient): Promise<ContractFieldSchema> {
  return contractSchemaCache.getOrCompute(client.instanceUrl, async () => {
    const describe = await describeObjectCached(client, "Contract");

    const accountField = findReferenceFieldByTargetObject(describe, "Account", { requireCreateable: true })
      ?? resolveField(describe, "AccountId", /^account$/i, { requireCreateable: true });
    const pricebookField = findReferenceFieldByTargetObject(describe, "Pricebook2", { requireCreateable: true })
      ?? resolveField(describe, "Pricebook2Id", /^price\s?book$/i, { requireCreateable: true });

    // Standard Contract has NO free-text Name field at all (§3.2) — only render if a real field resolves in this org.
    const nameField = resolveField(describe, "Name", /^contract name$/i, { requireCreateable: true });

    const statusPicklist = findPicklistFieldByLabel(describe, "Status", /^status$/i, { requireCreateable: true });
    const statusField: PicklistFieldRef | null = statusPicklist
      ? { apiName: statusPicklist.field.name, label: statusPicklist.field.label, options: statusPicklist.activeOptions, defaultValue: statusPicklist.defaultValue }
      : null;

    // Not standard on Contract (§2.3) — resolves only if this specific org added a custom field. Never a hardcoded guess.
    // requireCreateable: true — some orgs expose a "Contract Type"-labeled field that Describe marks non-createable
    // (e.g. a formula/managed-package field); sending it anyway is what produces Salesforce's
    // "Unable to create/update fields: ContractType" rejection, so it must resolve to null here instead.
    const contractTypePicklist = findPicklistFieldByLabel(describe, "ContractType__c", /^contract type$/i, { requireCreateable: true });
    const contractTypeField: PicklistFieldRef | null = contractTypePicklist
      ? { apiName: contractTypePicklist.field.name, label: contractTypePicklist.field.label, options: contractTypePicklist.activeOptions, defaultValue: contractTypePicklist.defaultValue }
      : null;

    const startDateField = resolveField(describe, "StartDate", /^(contract )?start date$/i, { requireCreateable: true });

    // §2.1: EndDate — accessible-only, NEVER createable-gated (it's a formula field on virtually every org).
    const endDateRaw = findAccessibleFieldByNameOrLabel(describe, "EndDate", /^(contract )?end date$/i);
    const endDateField = endDateRaw
      ? { apiName: endDateRaw.name, label: endDateRaw.label, relationshipName: endDateRaw.relationshipName ?? null, calculated: !!endDateRaw.calculated }
      : null;

    const contractTermField = resolveField(describe, "ContractTerm", /^contract term(\s*\(months\))?$/i, { requireCreateable: true });

    // Well-known-name-first, label-fallback ONLY — deliberately not falling back to
    // "first reference field to User", since Contract also carries OwnerId/CreatedById/
    // LastModifiedById User lookups that would be silently wrong to pick instead.
    const companySignedByField = resolveField(describe, "CompanySignedId", /^company signed by$/i, { requireCreateable: true });
    const companySignedDateField = resolveField(describe, "CompanySignedDate", /^company signed date$/i, { requireCreateable: true });

    const customerSignedByField = resolveField(describe, "CustomerSignedId", /^customer signed by$/i, { requireCreateable: true })
      ?? findReferenceFieldByTargetObject(describe, "Contact", { requireCreateable: true });
    const customerSignedTitleField = resolveField(describe, "CustomerSignedTitle", /^customer signed title$/i, { requireCreateable: true });
    const customerSignedDateField = resolveField(describe, "CustomerSignedDate", /^customer signed date$/i, { requireCreateable: true });

    const descriptionField = resolveField(describe, "Description", /^description$/i, { requireCreateable: true });

    // §2.1: ContractNumber — try the exact, unrenamable standard API name first. System-assigned, never createable-gated.
    const contractNumberField = findFieldByExactName(describe, "ContractNumber") ?? findFieldByLabel(describe, /^contract number$/i);

    // §2.2: display-only — Describe alone can't tell us which Record Types this user's profile can assign.
    const recordTypeIdField = findFieldByExactName(describe, "RecordTypeId");

    const updateableApiNames = describe.fields.filter(f => f.updateable).map(f => f.name);

    return {
      accountField: toFieldRef(accountField),
      pricebookField: toFieldRef(pricebookField),
      nameField: toFieldRef(nameField),
      statusField,
      contractTypeField,
      startDateField: toFieldRef(startDateField),
      endDateField,
      contractTermField: toFieldRef(contractTermField),
      companySignedByField: toFieldRef(companySignedByField),
      companySignedDateField: toFieldRef(companySignedDateField),
      customerSignedByField: toFieldRef(customerSignedByField),
      customerSignedTitleField: toFieldRef(customerSignedTitleField),
      customerSignedDateField: toFieldRef(customerSignedDateField),
      descriptionField: toFieldRef(descriptionField),
      contractNumberField: toFieldRef(contractNumberField),
      recordTypeIdField: toFieldRef(recordTypeIdField),
      updateableApiNames,
    };
  });
}

/**
 * Read-oriented schema for Contract history/list views — existence-only
 * checks, using each field's real Describe `relationshipName` for SOQL
 * parent traversal (never guessed by stripping "Id").
 */
export async function resolveContractListFieldSchema(client: SalesforceClient): Promise<ContractListFieldSchema> {
  return contractListSchemaCache.getOrCompute(client.instanceUrl, async () => {
    const describe = await describeObjectCached(client, "Contract");

    const contractNumberField = findFieldByExactName(describe, "ContractNumber") ?? findFieldByLabel(describe, /^contract number$/i);
    const startDateField = resolveField(describe, "StartDate", /^(contract )?start date$/i);
    const endDateField = findAccessibleFieldByNameOrLabel(describe, "EndDate", /^(contract )?end date$/i);
    const accountRelationshipField = findReferenceFieldByTargetObject(describe, "Account") ?? findReferenceFieldByLabel(describe, /^account$/i);

    return {
      contractNumberField: toFieldRef(contractNumberField),
      startDateField: toFieldRef(startDateField),
      endDateField: toFieldRef(endDateField),
      accountRelationshipField: toFieldRef(accountRelationshipField),
    };
  });
}

export interface ContractFieldDiagnostic {
  field: string;
  apiName: string | null;
  createable: boolean | null;
  value: unknown;
  includedInPayload: boolean;
  reason: string;
}

/**
 * Per-field createable/inclusion audit for the Contract create payload,
 * built directly from Describe and the actual payload the create call is
 * about to send — never a hardcoded assumption about which fields are
 * writable. For Status/ContractType specifically, the raw label-matched
 * field is looked up independent of `schema` (which already nulls out a
 * non-createable field) so a non-createable field's real Describe state is
 * still visible here instead of just reading "field did not resolve."
 */
export async function diagnoseContractFields(
  client: SalesforceClient,
  schema: ContractFieldSchema,
  formData: ContractFormData,
  payload: Record<string, unknown>,
): Promise<ContractFieldDiagnostic[]> {
  const describe = await describeObjectCached(client, "Contract");

  function rawByLabel(labelPattern: RegExp) {
    return describe.fields.find(f => labelPattern.test(f.label)) ?? null;
  }

  function row(label: string, field: { apiName: string } | null, rawField: { name: string; createable?: boolean } | null, value: unknown): ContractFieldDiagnostic {
    const apiName = field?.apiName ?? rawField?.name ?? null;
    const createable = field ? true : (rawField?.createable ?? null);
    if (!apiName) {
      return { field: label, apiName: null, createable: null, value: value ?? null, includedInPayload: false, reason: "No matching field found on Contract in this org's Describe." };
    }
    const included = apiName in payload;
    const reason = included
      ? `${apiName} is createable and a value was supplied — included in the payload.`
      : (value ? `${apiName} exists but createable=${createable} — SKIPPED, not sent.` : `${apiName} resolved but no value was supplied.`);
    return { field: label, apiName, createable, value: value ?? null, includedInPayload: included, reason };
  }

  const statusRaw = rawByLabel(/^status$/i);
  const contractTypeRaw = rawByLabel(/^contract type$/i);

  return [
    row("Account", schema.accountField, null, formData.accountName),
    row("Price Book", schema.pricebookField, null, formData.pricebookName),
    row("Status", schema.statusField, statusRaw, formData.status),
    row("Contract Type", schema.contractTypeField, contractTypeRaw, formData.contractType),
    row("Start Date", schema.startDateField, null, formData.startDate),
    row("Contract Term", schema.contractTermField, null, formData.contractTerm),
    row("Company Signed By", schema.companySignedByField, null, formData.companySignedByName),
    row("Company Signed Date", schema.companySignedDateField, null, formData.companySignedDate),
    row("Customer Signed By", schema.customerSignedByField, null, formData.customerSignedById),
    row("Customer Signed Title", schema.customerSignedTitleField, null, formData.customerSignedTitle),
    row("Customer Signed Date", schema.customerSignedDateField, null, formData.customerSignedDate),
    row("Description", schema.descriptionField, null, formData.description),
  ];
}
