import type { SalesforceClient } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import {
  resolveField,
  findReferenceFieldByTargetObject,
  findReferenceFieldByLabel,
  findPicklistFieldByLabel,
  toFieldRef,
} from "@/lib/salesforce/describe";
import { createTTLCache } from "@/lib/salesforce/cache";
import type { QuoteFieldSchema, QuoteListFieldSchema, PicklistFieldRef } from "@/lib/quotes/types";

const quoteSchemaCache = createTTLCache<QuoteFieldSchema>();
const quoteListSchemaCache = createTTLCache<QuoteListFieldSchema>();

/**
 * Resolve the writable Quote field schema used by the creation form and
 * payload builder (§3.4). Every field resolves via well-known-name-first,
 * label-fallback (§2.1), and — critically for anything this app intends to
 * WRITE — must pass `requireCreateable: true`. A field can legitimately
 * exist on Quote but be non-createable (e.g. system-managed / derived from
 * another object); sending it anyway is what produces Salesforce's
 * "Unable to create/update fields: <name>" error. When that happens the
 * field must resolve to `null` here so the caller hides/omits it, never
 * silently include it and let the whole create call fail.
 */
export async function resolveQuoteFieldSchema(client: SalesforceClient): Promise<QuoteFieldSchema> {
  return quoteSchemaCache.getOrCompute(client.instanceUrl, async () => {
    const describe = await describeObjectCached(client, "Quote");

    const accountField = findReferenceFieldByTargetObject(describe, "Account", { requireCreateable: true })
      ?? resolveField(describe, "AccountId", /^account$/i, { requireCreateable: true });
    const pricebookField = findReferenceFieldByTargetObject(describe, "Pricebook2", { requireCreateable: true })
      ?? resolveField(describe, "Pricebook2Id", /^price\s?book$/i, { requireCreateable: true });
    const opportunityField = findReferenceFieldByTargetObject(describe, "Opportunity", { requireCreateable: true })
      ?? resolveField(describe, "OpportunityId", /^opportunity$/i, { requireCreateable: true });

    const nameField = resolveField(describe, "Name", /^(quote\s)?name$/i, { requireCreateable: true });
    const startDateField = resolveField(describe, "StartDate", /^(start date|effective date)$/i, { requireCreateable: true });
    const expirationDateField = resolveField(describe, "ExpirationDate", /^expiration date$/i, { requireCreateable: true });
    const descriptionField = resolveField(describe, "Description", /^description$/i, { requireCreateable: true });

    const statusPicklist = findPicklistFieldByLabel(describe, "Status", /^status$/i, { requireCreateable: true });
    const statusField: PicklistFieldRef | null = statusPicklist
      ? {
          apiName: statusPicklist.field.name,
          label: statusPicklist.field.label,
          options: statusPicklist.activeOptions,
          defaultValue: statusPicklist.defaultValue,
        }
      : null;

    return {
      nameField: toFieldRef(nameField),
      accountField: toFieldRef(accountField),
      pricebookField: toFieldRef(pricebookField),
      opportunityField: toFieldRef(opportunityField),
      startDateField: toFieldRef(startDateField),
      expirationDateField: toFieldRef(expirationDateField),
      descriptionField: toFieldRef(descriptionField),
      statusField,
    };
  });
}

/**
 * Read-oriented schema for Quote history/list views (§3.4). Existence-only
 * checks — not gated on `createable` since these fields are for display,
 * but the resolved FieldRef's `relationshipName` (from Describe) is what
 * callers MUST use to dot-walk the relationship in SOQL (`Account.Name`,
 * not `AccountId.Name`) — never guess it from the field's own API name.
 */
export async function resolveQuoteListFieldSchema(client: SalesforceClient): Promise<QuoteListFieldSchema> {
  return quoteListSchemaCache.getOrCompute(client.instanceUrl, async () => {
    const describe = await describeObjectCached(client, "Quote");

    const quoteNumberField = resolveField(describe, "QuoteNumber", /^quote number$/i);
    const grandTotalField = resolveField(describe, "GrandTotal", /^grand total$/i);
    const accountRelationshipField = findReferenceFieldByTargetObject(describe, "Account")
      ?? findReferenceFieldByLabel(describe, /^account$/i);
    const opportunityRelationshipField = findReferenceFieldByTargetObject(describe, "Opportunity")
      ?? findReferenceFieldByLabel(describe, /^opportunity$/i);
    const pricebookRelationshipField = findReferenceFieldByTargetObject(describe, "Pricebook2")
      ?? findReferenceFieldByLabel(describe, /^price\s?book$/i);

    return {
      quoteNumberField: toFieldRef(quoteNumberField),
      grandTotalField: toFieldRef(grandTotalField),
      accountRelationshipField: toFieldRef(accountRelationshipField),
      opportunityRelationshipField: toFieldRef(opportunityRelationshipField),
      pricebookRelationshipField: toFieldRef(pricebookRelationshipField),
    };
  });
}

export interface QuoteFieldDiagnostic {
  requestedApiName: string;
  resolvedApiName: string | null;
  label: string | null;
  relationshipName: string | null;
  exists: boolean;
  createable: boolean | null;
  updateable: boolean | null;
  accessible: boolean | null;
  nillable: boolean | null;
  referenceTo: string[] | null;
  includedInPayload: boolean;
  reason: string;
  /** The complete, unfiltered Describe field object Salesforce returned — nothing summarized away. */
  raw: unknown;
}

/**
 * Raw Describe facts for Quote's Account/PriceBook/Opportunity lookups,
 * independent of the cached schema above — used purely for the execution
 * log (§Issue 4) so a "field excluded" outcome is provable from the org's
 * own Describe response, not asserted. Carries the FULL Describe field
 * object (createable, updateable, accessible, nillable, referenceTo,
 * relationshipName) — never collapsed to a single boolean.
 */
export async function diagnoseQuoteLookupFields(client: SalesforceClient): Promise<QuoteFieldDiagnostic[]> {
  const describe = await describeObjectCached(client, "Quote");

  function diagnose(requestedApiName: string, targetObject: string): QuoteFieldDiagnostic {
    const field = describe.fields.find(f => f.name === requestedApiName)
      ?? describe.fields.find(f => f.type === "reference" && f.referenceTo?.includes(targetObject));
    if (!field) {
      return {
        requestedApiName, resolvedApiName: null, label: null, relationshipName: null, exists: false,
        createable: null, updateable: null, accessible: null, nillable: null, referenceTo: null,
        includedInPayload: false, reason: `No reference field to ${targetObject} found on Quote in this org.`, raw: null,
      };
    }
    const createable = field.createable ?? false;
    return {
      requestedApiName,
      resolvedApiName: field.name,
      label: field.label,
      relationshipName: field.relationshipName ?? null,
      exists: true,
      createable,
      updateable: field.updateable ?? null,
      accessible: field.accessible ?? null,
      nillable: field.nillable ?? null,
      referenceTo: field.referenceTo ?? null,
      includedInPayload: createable,
      reason: createable
        ? `${field.name} is createable — included in the payload.`
        : `${field.name} exists but Describe reports createable=false for this org/user — Salesforce would reject a create call that sets it, so it is excluded from the payload rather than sent.`,
      raw: field,
    };
  }

  return [
    diagnose("AccountId", "Account"),
    diagnose("Pricebook2Id", "Pricebook2"),
    diagnose("OpportunityId", "Opportunity"),
  ];
}
