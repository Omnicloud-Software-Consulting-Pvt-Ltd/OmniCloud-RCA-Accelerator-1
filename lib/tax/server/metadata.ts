import type { SalesforceClient } from "@/lib/salesforce/client";
import { apiUrl, cached, describeAt, latestApiVersion } from "@/lib/billing/server/billingDocuments";
import type { FieldMeta, MissingObject, ObjectMeta, TaxMetadata } from "@/lib/tax/types";

/**
 * Salesforce metadata discovery for the Tax module. Every object the module reads or writes is described in the CONNECTED org on
 * its newest API version; field names, types, required/createable/updateable flags, picklist values and relationships come
 * from that describe — never from a hard-coded list. An object that doesn't exist is reported (with the tax objects the org
 * does have) instead of fabricating an API name.
 */

/** The objects the tax module uses, and why. */
export const TAX_OBJECTS = ["TaxEngineProvider", "TaxEngine", "TaxPolicy", "TaxTreatment", "TaxTreatmentItem", "TaxRate", "LegalEntity", "GeoCountry", "GeoState", "Product2", "InvoiceLineTax"] as const;
export type TaxObject = (typeof TAX_OBJECTS)[number];
/** Objects without which no tax configuration can be created at all. */
const CORE: TaxObject[] = ["TaxPolicy", "TaxTreatment", "Product2"];

/** "From→To" pairs whose relationship field is resolved from metadata (referenceTo), not assumed. */
const RELATIONSHIPS: [TaxObject, string][] = [
  ["TaxEngine", "TaxEngineProvider"], ["TaxEngine", "NamedCredential"],
  ["TaxPolicy", "TaxTreatment"],
  ["TaxTreatment", "TaxPolicy"], ["TaxTreatment", "TaxEngine"], ["TaxTreatment", "LegalEntity"],
  ["TaxTreatmentItem", "TaxTreatment"], ["TaxTreatmentItem", "Product2"],
  ["TaxRate", "GeoCountry"], ["TaxRate", "GeoState"], ["TaxRate", "LegalEntity"], ["GeoState", "GeoCountry"],
  ["Product2", "TaxPolicy"],
  ["InvoiceLineTax", "TaxTreatment"],
];

function toObjectMeta(d: { name: string; label: string; createable?: boolean; updateable?: boolean; queryable?: boolean; deletable?: boolean; fields: unknown[] }): ObjectMeta {
  const fields: Record<string, FieldMeta> = {};
  for (const raw of d.fields as Record<string, unknown>[]) {
    const createable = raw.createable === true;
    const nillable = raw.nillable === true;
    fields[String(raw.name)] = {
      name: String(raw.name), label: String(raw.label ?? raw.name), type: String(raw.type ?? "string"),
      // Required on create = Salesforce won't accept a null and won't default it.
      required: createable && !nillable && raw.defaultedOnCreate !== true && raw.type !== "boolean",
      createable, updateable: raw.updateable === true, nillable,
      picklist: Array.isArray(raw.picklistValues) ? (raw.picklistValues as { value: string; label: string; active: boolean }[]).filter(p => p.active).map(p => ({ value: p.value, label: p.label })) : [],
      referenceTo: Array.isArray(raw.referenceTo) ? (raw.referenceTo as string[]) : [],
      nameField: raw.nameField === true, unique: raw.unique === true, externalId: raw.externalId === true,
    };
  }
  return { name: d.name, label: d.label, exists: true, createable: d.createable === true, updateable: d.updateable === true, queryable: d.queryable !== false, deletable: d.deletable === true, fields };
}

/** Discover the tax objects' metadata in the connected org (cached per org + user session for 10 minutes). */
export async function discoverTaxMetadata(client: SalesforceClient): Promise<TaxMetadata> {
  const v = await latestApiVersion(client);
  return cached(`${client.cacheScope}:${v}:taxMetadata`, 600_000, async () => {
    const objects: TaxMetadata["objects"] = {};
    await Promise.all(TAX_OBJECTS.map(async name => {
      const d = await describeAt(client, v, name).catch(() => null);
      objects[name] = d && Array.isArray((d as { fields?: unknown[] }).fields)
        ? toObjectMeta(d as unknown as Parameters<typeof toObjectMeta>[0])
        : ({ name, exists: false, reason: `${name} isn't available in this org on API ${v} (not enabled, not licensed, or not visible to the current user).` } satisfies MissingObject);
    }));
    const global = await client.requestWithDiagnostics(apiUrl(client, v, "/sobjects"), { method: "GET" }).catch(() => null);
    const sobjects = ((global?.json as { sobjects?: { name: string }[] } | null)?.sobjects ?? []).map(s => s.name);
    const availableTaxObjects = sobjects.filter(n => /tax/i.test(n) && !/(History|Share|Feed|ChangeEvent)$/.test(n) && !/^ContentTaxonomy/.test(n)).sort();
    const relationships: TaxMetadata["relationships"] = {};
    for (const [from, to] of RELATIONSHIPS) relationships[`${from}→${to}`] = referenceField(objects[from], to);
    const problems: string[] = [];
    for (const name of CORE) if (!objects[name]?.exists) problems.push(`Required object ${name} is missing. Tax objects available in this org: ${availableTaxObjects.join(", ") || "none"}.`);
    const policyRef = relationships["Product2→TaxPolicy"];
    if (objects.Product2?.exists && !policyRef) problems.push("Product2 has no field referencing TaxPolicy in this org — products can't be assigned a tax policy.");
    return { apiVersion: v, objects, availableTaxObjects, relationships, problems };
  });
}

/** The (first) field on `obj` that references `target`, from metadata. */
export function referenceField(obj: ObjectMeta | MissingObject | undefined, target: string): string | null {
  if (!obj?.exists) return null;
  const f = Object.values(obj.fields).find(x => x.type === "reference" && x.referenceTo.includes(target));
  return f?.name ?? null;
}

export function objectMeta(meta: TaxMetadata, name: string): ObjectMeta | null {
  const o = meta.objects[name];
  return o?.exists ? o : null;
}
export function field(meta: TaxMetadata, obj: string, name: string): FieldMeta | null {
  return objectMeta(meta, obj)?.fields[name] ?? null;
}
export function hasField(meta: TaxMetadata, obj: string, name: string): boolean { return !!field(meta, obj, name); }
/** A field list for SOQL — only the wanted fields this org actually has (relationship paths are checked by their Id field). */
export function selectable(meta: TaxMetadata, obj: string, wanted: string[]): string[] {
  const o = objectMeta(meta, obj);
  if (!o) return [];
  return wanted.filter(w => {
    const [head] = w.split(".");
    if (!w.includes(".")) return !!o.fields[w];
    const idField = head.endsWith("__r") ? head.replace(/__r$/, "__c") : `${head}Id`;
    return !!o.fields[idField];
  });
}
/** Active picklist values of a field (empty when the field isn't a picklist or doesn't exist). */
export function picklist(meta: TaxMetadata, obj: string, name: string): string[] {
  return (field(meta, obj, name)?.picklist ?? []).map(p => p.value);
}
/** Match a value against a picklist case/space-insensitively, returning Salesforce's exact value. */
export function picklistValue(meta: TaxMetadata, obj: string, name: string, wanted: string | null | undefined): string | null {
  if (!wanted) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const values = picklist(meta, obj, name);
  return values.find(v => v === wanted) ?? values.find(v => norm(v) === norm(wanted)) ?? null;
}
