import type { SalesforceClient, DescribeResult } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { createTTLCache } from "@/lib/salesforce/cache";

/**
 * Independent Salesforce schema discovery for the Attribute Workspace's
 * read/update routes (list, stats, detail, patch) — deliberately NOT wired
 * into app/api/sf/attributes/execute-batch/route.ts's own internal
 * discovery (its `ensureSchemaInfo`/`safeDescribe` helpers). That file is
 * the existing, working, heavily-tested 9-batch RCA deployment pipeline;
 * refactoring it to share this module would risk regressing a delicate,
 * already-shipped flow for no functional benefit. Instead, this module
 * independently re-derives the SAME field names via Salesforce Describe
 * (through the app's general-purpose, cached describe toolbox in
 * lib/salesforce/describe.ts) — satisfying "never guess an object/field
 * name" without touching the deployment route at all.
 */
export interface AttributeSchema {
  /** AttributeDefinition's DataType-equivalent field — candidates: DataType / ValueType / AttributeDataType. */
  attrDefDatatypeField: string | null;
  /** AttributeDefinition's FK to AttributePicklist — candidates: PicklistId / AttributePicklistId. */
  attrDefPicklistFKField: string | null;
  /** AttributePicklistValue's FK to AttributePicklist — candidates: AttributePicklistId / PicklistId. Always resolves to a name (defaults to the well-known one) since every write path needs one. */
  plValueFKField: string;
  /** ProductAttributeDefinition's FK to Product2 — candidates: Product2Id / ProductId. Null if not resolvable (Related Product then can't be shown). */
  padProduct2FKField: string | null;
  attributeDefinitionDescribe: DescribeResult | null;
  attributePicklistValueDescribe: DescribeResult | null;
  productAttributeDefinitionDescribe: DescribeResult | null;
}

function firstExistingField(d: DescribeResult | null, candidates: string[]): string | null {
  if (!d) return null;
  return candidates.find(c => d.fields.some(f => f.name === c)) ?? null;
}

function detectDatatypeField(d: DescribeResult | null): string | null {
  if (!d) return null;
  for (const c of ["DataType", "ValueType", "AttributeDataType"]) {
    if (d.fields.some(f => f.name === c)) return c;
  }
  return d.fields.find(f => /datatype|valuetype/i.test(f.name))?.name ?? null;
}

export function fieldExists(d: DescribeResult | null, name: string): boolean {
  return d?.fields.some(f => f.name === name) ?? false;
}

export function isFieldUpdateable(d: DescribeResult | null, name: string): boolean {
  return d?.fields.find(f => f.name === name)?.updateable ?? false;
}

export function picklistValues(d: DescribeResult | null, fieldName: string | null): string[] {
  if (!fieldName) return [];
  const field = d?.fields.find(f => f.name === fieldName);
  return (field?.picklistValues ?? []).filter(v => v.active).map(v => v.value);
}

const schemaCache = createTTLCache<AttributeSchema>();

export async function resolveAttributeSchema(client: SalesforceClient): Promise<AttributeSchema> {
  return schemaCache.getOrCompute(client.instanceUrl, async () => {
    const [attrDefD, plValueD, padD] = await Promise.all([
      describeObjectCached(client, "AttributeDefinition").catch(() => null),
      describeObjectCached(client, "AttributePicklistValue").catch(() => null),
      describeObjectCached(client, "ProductAttributeDefinition").catch(() => null),
    ]);
    return {
      attrDefDatatypeField: detectDatatypeField(attrDefD),
      attrDefPicklistFKField: firstExistingField(attrDefD, ["PicklistId", "AttributePicklistId"]),
      plValueFKField: firstExistingField(plValueD, ["AttributePicklistId", "PicklistId"]) ?? "AttributePicklistId",
      padProduct2FKField: firstExistingField(padD, ["Product2Id", "ProductId"]),
      attributeDefinitionDescribe: attrDefD,
      attributePicklistValueDescribe: plValueD,
      productAttributeDefinitionDescribe: padD,
    };
  });
}

/** Clear the cached schema for an instance — call after a schema-changing action, mirrors lib/salesforce/describe.ts's own cache-invalidation convention. */
export function clearAttributeSchemaCache(instanceUrl: string) {
  schemaCache.clear(instanceUrl);
}
