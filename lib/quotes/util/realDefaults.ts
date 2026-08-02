import type { SalesforceClient } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { findRequiredCreateableFields } from "@/lib/salesforce/describe";

const MAX_AUTO_CREATE_DEPTH = 3;

/**
 * Resolve a real value for a required-on-create field: an active picklist
 * default, the sole active picklist option, or an existing record's real
 * value for a reference field. If a reference field's target object has NO
 * existing record to reuse (common for per-quote junction/child objects),
 * recursively create a minimal one from ITS OWN real defaults before giving
 * up — bounded by `MAX_AUTO_CREATE_DEPTH` and a visited-set to guard against
 * circular reference graphs. Returns `undefined` (never a fabricated
 * placeholder) only when no real value can be found or created at any depth
 * (§2.3). Shared by the billing policy recovery flow and (for reference-type
 * fields only) the QuoteLineRelationship required-field audit — dependent
 * PICKLIST fields on QuoteLineRelationship (e.g. AssociatedQuoteLinePricing)
 * are resolved separately in lib/quotes/bundles/relationshipCreate.ts, which
 * is controller/validFor-aware; this function's picklist branch below only
 * ever returns an org-marked default or a sole active value, by design.
 */
export async function resolveRealDefaultForField(
  client: SalesforceClient,
  sobject: string,
  fieldName: string,
  fieldType: string,
  picklistValues?: { value: string; active: boolean; defaultValue?: boolean }[],
): Promise<unknown> {
  return resolveOrCreate(client, sobject, fieldName, fieldType, picklistValues, 0, new Set());
}

async function resolveOrCreate(
  client: SalesforceClient,
  sobject: string,
  fieldName: string,
  fieldType: string,
  picklistValues: { value: string; active: boolean; defaultValue?: boolean }[] | undefined,
  depth: number,
  visited: Set<string>,
): Promise<unknown> {
  if (fieldType === "picklist" && picklistValues) {
    const active = picklistValues.filter(v => v.active);
    const withDefault = active.find(v => v.defaultValue);
    if (withDefault) return withDefault.value;
    if (active.length === 1) return active[0].value;
    return undefined;
  }
  if (fieldType === "boolean") return false;
  if (fieldType !== "reference") return undefined;

  let targetObject: string | undefined;
  try {
    const referenced = await describeObjectCached(client, sobject);
    const field = referenced.fields.find(f => f.name === fieldName);
    targetObject = field?.referenceTo?.[0];
  } catch {
    return undefined;
  }
  if (!targetObject || visited.has(targetObject)) return undefined;

  // 1. Reuse an existing record of the target type if one is visible.
  try {
    const res = await client.query<{ Id: string }>(`SELECT Id FROM ${targetObject} LIMIT 1`);
    if (res.records[0]?.Id) return res.records[0].Id;
  } catch {
    /* fall through to auto-create */
  }

  // 2. None exists (common for per-quote child objects) — create a minimal
  // one from ITS OWN real required-field defaults, recursively, bounded.
  if (depth >= MAX_AUTO_CREATE_DEPTH) return undefined;
  try {
    const targetDescribe = await describeObjectCached(client, targetObject);
    const requiredFields = findRequiredCreateableFields(targetDescribe).filter(f => f.name !== "Name");
    const payload: Record<string, unknown> = targetDescribe.fields.some(f => f.name === "Name") ? { Name: `Auto-Created ${targetObject}` } : {};
    const nextVisited = new Set(visited).add(targetObject);

    for (const requiredField of requiredFields) {
      const value = await resolveOrCreate(client, targetObject, requiredField.name, requiredField.type, requiredField.picklistValues, depth + 1, nextVisited);
      if (value === undefined) return undefined; // a deeper required field couldn't be resolved either — refuse to fabricate
      payload[requiredField.name] = value;
    }

    const result = await client.createRecord(targetObject, payload);
    return result.success ? result.id : undefined;
  } catch {
    return undefined;
  }
}
