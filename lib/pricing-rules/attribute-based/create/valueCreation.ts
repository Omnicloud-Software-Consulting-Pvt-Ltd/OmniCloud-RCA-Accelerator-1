/**
 * Part G — creates a genuinely missing attribute value in Salesforce, but
 * ONLY when that attribute's values are confirmed to live on the standard
 * `AttributePicklistValue` object (the fast, high-confidence path also used
 * by discovery — see discoverAttributes.ts). For any other (dynamically
 * discovered, org-specific) value-source object, this refuses to guess at
 * field names and reports the value as unsupported instead — consistent
 * with "do not invent Salesforce object names, fields, or relationships."
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";

export type CreateValueOutcome =
  | { status: "created"; id: string }
  | { status: "already-exists"; id: string }
  | { status: "unsupported"; reason: string };

/**
 * Re-resolves the AttributePicklist Id backing this attribute, purely for
 * value creation — checks ProductAttributeDefinition first (an override
 * scoped to this product), then AttributeDefinition (the org-wide
 * definition), for a reference field pointing at AttributePicklist.
 */
export async function resolveAttributePicklistId(
  client: SalesforceClient,
  attributeDefinitionId: string | null,
  productAttributeDefinitionId: string | null,
): Promise<string | null> {
  const candidates: { object: string; id: string | null }[] = [
    { object: "ProductAttributeDefinition", id: productAttributeDefinitionId },
    { object: "AttributeDefinition", id: attributeDefinitionId },
  ];
  for (const { object, id } of candidates) {
    if (!id) continue;
    try {
      const describe = await client.describeObject(object);
      const picklistField = describe.fields.find(f => f.type === "reference" && (f.referenceTo ?? []).some(r => /^attributepicklist$/i.test(r)));
      if (!picklistField) continue;
      const res = await client.query<Record<string, unknown>>(`SELECT ${picklistField.name} FROM ${object} WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
      const picklistId = res.records[0]?.[picklistField.name];
      if (typeof picklistId === "string" && picklistId) return picklistId;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Creates one new AttributePicklistValue for `value`, unless one already
 * exists (case-insensitive match on Value/DisplayValue/Name) — re-queries
 * immediately before creating (Part G #3/#4), so a value created by
 * another process between validation and creation is reused, never
 * duplicated. Query-backs the created record before returning it (never
 * trusts the create response's Id alone).
 */
export async function createMissingAttributeValue(
  client: SalesforceClient,
  attributePicklistId: string,
  value: string,
): Promise<CreateValueOutcome> {
  const existing = await client.query<{ Id: string; Value?: string; DisplayValue?: string; Name?: string }>(
    `SELECT Id, Name, Value, DisplayValue FROM AttributePicklistValue WHERE PicklistId = '${soqlEscape(attributePicklistId)}'`,
  );
  const match = existing.records.find(r => [r.Value, r.DisplayValue, r.Name].some(v => typeof v === "string" && v.toLowerCase() === value.toLowerCase()));
  if (match) return { status: "already-exists", id: match.Id };

  const describe = await client.describeObject("AttributePicklistValue");
  const fieldNames = new Set(describe.fields.map(f => f.name));

  const payload: Record<string, unknown> = { PicklistId: attributePicklistId, Name: value };
  if (fieldNames.has("Value")) payload.Value = value;
  if (fieldNames.has("DisplayValue")) payload.DisplayValue = value;
  if (fieldNames.has("Sequence")) payload.Sequence = existing.records.length;

  const created = await client.createRecord("AttributePicklistValue", payload);
  const verify = await client.query<{ Id: string }>(`SELECT Id FROM AttributePicklistValue WHERE Id = '${soqlEscape(created.id)}' LIMIT 1`);
  if (verify.records.length === 0) {
    throw new Error(`AttributePicklistValue "${value}" was reported as created (Id ${created.id}), but querying it back found no matching record — treating this as a failed create.`);
  }
  return { status: "created", id: created.id };
}
