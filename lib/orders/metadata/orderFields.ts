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
import type { OrderFieldSchema, OrderListFieldSchema, PicklistFieldRef } from "@/lib/orders/types";

const orderSchemaCache = createTTLCache<OrderFieldSchema>();
const orderListSchemaCache = createTTLCache<OrderListFieldSchema>();

/**
 * Resolve the writable Order field schema used by the creation form and
 * payload builder — the Order-side counterpart of resolveQuoteFieldSchema
 * (see lib/quotes/metadata/quoteFields.ts), but with Order's own field set:
 * no free-text Name (Order has none — OrderNumber is system-assigned, §3.5),
 * EffectiveDate instead of Start Date, and Contract/Type/PoNumber/PoDate in
 * place of Quote's Opportunity/Expiration Date. Every field resolves via
 * well-known-name-first, label-fallback, requireCreateable:true (§2.1) —
 * a field that exists but isn't createable in this org must resolve to
 * null so the caller omits it, never sends it and lets the whole call fail.
 */
export async function resolveOrderFieldSchema(client: SalesforceClient): Promise<OrderFieldSchema> {
  return orderSchemaCache.getOrCompute(client.instanceUrl, async () => {
    const describe = await describeObjectCached(client, "Order");

    const accountField = findReferenceFieldByTargetObject(describe, "Account", { requireCreateable: true })
      ?? resolveField(describe, "AccountId", /^account$/i, { requireCreateable: true });
    const pricebookField = findReferenceFieldByTargetObject(describe, "Pricebook2", { requireCreateable: true })
      ?? resolveField(describe, "Pricebook2Id", /^price\s?book$/i, { requireCreateable: true });
    const contractField = findReferenceFieldByTargetObject(describe, "Contract", { requireCreateable: true })
      ?? resolveField(describe, "ContractId", /^contract$/i, { requireCreateable: true });
    const sourceQuoteField = findReferenceFieldByTargetObject(describe, "Quote", { requireCreateable: true })
      ?? resolveField(describe, "QuoteId", /^quote$/i, { requireCreateable: true });

    const effectiveDateField = resolveField(describe, "EffectiveDate", /^(effective date|start date)$/i, { requireCreateable: true });
    const poNumberField = resolveField(describe, "PoNumber", /^(po|purchase order) number$/i, { requireCreateable: true });
    const poDateField = resolveField(describe, "PoDate", /^(po|purchase order) date$/i, { requireCreateable: true });
    const descriptionField = resolveField(describe, "Description", /^description$/i, { requireCreateable: true });

    const statusPicklist = findPicklistFieldByLabel(describe, "Status", /^status$/i, { requireCreateable: true });
    const statusField: PicklistFieldRef | null = statusPicklist
      ? { apiName: statusPicklist.field.name, label: statusPicklist.field.label, options: statusPicklist.activeOptions, defaultValue: statusPicklist.defaultValue }
      : null;

    const typePicklist = findPicklistFieldByLabel(describe, "Type", /^type$/i, { requireCreateable: true });
    const typeField: PicklistFieldRef | null = typePicklist
      ? { apiName: typePicklist.field.name, label: typePicklist.field.label, options: typePicklist.activeOptions, defaultValue: typePicklist.defaultValue }
      : null;

    // Best-effort, describe-derived signal only (§3.2): a validation rule's
    // conditional requirement itself can't be introspected via Describe, so
    // this reflects whether the org's own active Type values even include a
    // "Contracted"-shaped option — never a hardcoded assumption beyond that.
    const contractRequiredForContractedType = !!typeField?.options.some(o => /contract/i.test(o.label) || /contract/i.test(o.value));

    return {
      accountField: toFieldRef(accountField),
      pricebookField: toFieldRef(pricebookField),
      contractField: toFieldRef(contractField),
      effectiveDateField: toFieldRef(effectiveDateField),
      statusField,
      typeField,
      poNumberField: toFieldRef(poNumberField),
      poDateField: toFieldRef(poDateField),
      descriptionField: toFieldRef(descriptionField),
      sourceQuoteField: toFieldRef(sourceQuoteField),
      contractRequiredForContractedType,
    };
  });
}

/**
 * Read-oriented schema for Order history/list views — existence-only checks
 * (not gated on createable), using each field's Describe-reported
 * `relationshipName` for SOQL parent traversal (never guessed by stripping "Id").
 */
export async function resolveOrderListFieldSchema(client: SalesforceClient): Promise<OrderListFieldSchema> {
  return orderListSchemaCache.getOrCompute(client.instanceUrl, async () => {
    const describe = await describeObjectCached(client, "Order");

    const orderNumberField = resolveField(describe, "OrderNumber", /^order number$/i);
    const totalAmountField = resolveField(describe, "TotalAmount", /^total(\samount)?$/i);
    const accountRelationshipField = findReferenceFieldByTargetObject(describe, "Account") ?? findReferenceFieldByLabel(describe, /^account$/i);
    const pricebookRelationshipField = findReferenceFieldByTargetObject(describe, "Pricebook2") ?? findReferenceFieldByLabel(describe, /^price\s?book$/i);
    const contractRelationshipField = findReferenceFieldByTargetObject(describe, "Contract") ?? findReferenceFieldByLabel(describe, /^contract$/i);

    return {
      orderNumberField: toFieldRef(orderNumberField),
      totalAmountField: toFieldRef(totalAmountField),
      accountRelationshipField: toFieldRef(accountRelationshipField),
      pricebookRelationshipField: toFieldRef(pricebookRelationshipField),
      contractRelationshipField: toFieldRef(contractRelationshipField),
    };
  });
}

export interface OrderFieldDiagnostic {
  requestedApiName: string;
  resolvedApiName: string | null;
  label: string | null;
  relationshipName: string | null;
  exists: boolean;
  createable: boolean | null;
  includedInPayload: boolean;
  reason: string;
  raw: unknown;
}

/** Raw Describe facts for Order's Account/PriceBook/Contract lookups — surfaced into the execution log so a "field excluded" outcome is provable from the org's own Describe response. */
export async function diagnoseOrderLookupFields(client: SalesforceClient): Promise<OrderFieldDiagnostic[]> {
  const describe = await describeObjectCached(client, "Order");

  function diagnose(requestedApiName: string, targetObject: string): OrderFieldDiagnostic {
    const field = describe.fields.find(f => f.name === requestedApiName)
      ?? describe.fields.find(f => f.type === "reference" && f.referenceTo?.includes(targetObject));
    if (!field) {
      return { requestedApiName, resolvedApiName: null, label: null, relationshipName: null, exists: false, createable: null, includedInPayload: false, reason: `No reference field to ${targetObject} found on Order in this org.`, raw: null };
    }
    const createable = field.createable ?? false;
    return {
      requestedApiName, resolvedApiName: field.name, label: field.label, relationshipName: field.relationshipName ?? null,
      exists: true, createable, includedInPayload: createable,
      reason: createable ? `${field.name} is createable — included in the payload.` : `${field.name} exists but Describe reports createable=false for this org/user — excluded from the payload rather than sent.`,
      raw: field,
    };
  }

  return [diagnose("AccountId", "Account"), diagnose("Pricebook2Id", "Pricebook2"), diagnose("ContractId", "Contract")];
}
