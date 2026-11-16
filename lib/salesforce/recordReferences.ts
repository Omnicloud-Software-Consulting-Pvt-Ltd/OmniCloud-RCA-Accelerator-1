import { soqlEscape, type DescribeField, type DescribeResult, type SalesforceClient } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { nameFieldOf } from "@/lib/billing/server/discovery";
import { resolveNamesById, SALESFORCE_ID } from "@/lib/billing/server/lookup";

/**
 * Display metadata for a single Salesforce record's detail view (Order / Contract / Quote overviews): lookup names,
 * Salesforce-formatted currency and Describe labels. Object-agnostic — every field list comes from the org's own
 * Describe — and purely additive: the raw record (and its Ids) is never modified.
 */

/** A resolved lookup. `name` is null when the referenced record's name couldn't be read. */
export interface RecordReferenceValue {
  id: string;
  name: string | null;
  /** Target object for single-target lookups; null for polymorphic ones (e.g. OwnerId → User/Group). */
  sobject: string | null;
}

export interface RecordFieldMeta {
  label: string;
  type: string;
}

export interface RecordDisplayMeta {
  /** Display names for every populated reference field, keyed by field API name. */
  references: Record<string, RecordReferenceValue>;
  /** Salesforce-formatted (SOQL FORMAT()) currency values keyed by field API name; missing when formatting was unavailable. */
  formattedCurrency: Record<string, string>;
  /** Describe label/type for each field present on the record. */
  fields: Record<string, RecordFieldMeta>;
  /** Record's CurrencyIsoCode in multi-currency orgs; null otherwise. */
  currencyIsoCode: string | null;
}

/** One populated reference field and how to traverse to its target's name. */
export interface ReferencePlan {
  field: string;
  id: string;
  referenceTo: string[];
  /** Relationship traversal path, e.g. `Account.Name` / `Owner.Name`. Null when the field has no relationship name. */
  path: string | null;
}

const SOBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Salesforce labels reference fields "Account ID" / "Created By ID" — detail views show the resolved name, so drop the suffix. */
export function displayLabel(field: DescribeField): string {
  return field.type === "reference" ? field.label.replace(/\s+ID$/i, "") : field.label;
}

/**
 * Plan a relationship traversal for every POPULATED reference field on the record, using the org's own Describe:
 * the relationship name comes from the field, the name field from the target object's Describe (polymorphic
 * lookups such as OwnerId traverse the generic `Name` entity). Nothing here is a hard-coded field list.
 */
export function planReferences(
  describe: DescribeResult,
  record: Record<string, unknown>,
  targetNameField: (sobject: string) => string | null,
): ReferencePlan[] {
  const plans: ReferencePlan[] = [];
  for (const f of describe.fields) {
    if (f.type !== "reference") continue;
    const id = record[f.name];
    if (typeof id !== "string" || !SALESFORCE_ID.test(id)) continue;
    const referenceTo = f.referenceTo ?? [];
    const nameField = referenceTo.length === 1 ? targetNameField(referenceTo[0]) : "Name";
    const path = f.relationshipName && nameField ? `${f.relationshipName}.${nameField}` : null;
    plans.push({ field: f.name, id, referenceTo, path });
  }
  return plans;
}

/** Currency fields that hold a value — formatted by Salesforce itself via SOQL FORMAT() so the symbol/locale match the org. */
export function currencyFieldsToFormat(describe: DescribeResult, record: Record<string, unknown>): string[] {
  return describe.fields.filter(f => f.type === "currency" && typeof record[f.name] === "number").map(f => f.name);
}

export function buildReferenceQuery(sobject: string, recordId: string, plans: ReferencePlan[], currencyFields: string[]): string | null {
  if (!SOBJECT_NAME.test(sobject)) throw new Error(`Invalid object name "${sobject}".`);
  const select = [...new Set(plans.map(p => p.path).filter((p): p is string => !!p))];
  currencyFields.forEach((f, i) => select.push(`FORMAT(${f}) fmt${i}`));
  if (select.length === 0) return null;
  return `SELECT Id, ${select.join(", ")} FROM ${sobject} WHERE Id = '${soqlEscape(recordId)}'`;
}

/** Walk `Rel.Name` paths on a query row. A null parent (no access, or deleted) yields null — never the Id. */
export function readPath(row: Record<string, unknown>, path: string): string | null {
  let cur: unknown = row;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" && cur.trim() ? cur : null;
}

function currencyCodeOf(record: Record<string, unknown>): string | null {
  return typeof record.CurrencyIsoCode === "string" ? record.CurrencyIsoCode : null;
}

/**
 * Resolve display names for every reference on a record in ONE SOQL round trip (relationship traversal + FORMAT()
 * of currency fields). If that query is rejected (e.g. a traversed object isn't readable by this user), fall back to
 * the shared batched Id → name lookup (one `IN` query per target object). Describes are cached per session.
 * Never throws: names are display-only, so on any failure the UI simply falls back to the raw Ids.
 */
export async function resolveRecordDisplay(client: SalesforceClient, sobject: string, recordId: string, record: Record<string, unknown>): Promise<RecordDisplayMeta> {
  try {
    return await resolve(client, sobject, recordId, record);
  } catch {
    return { references: {}, formattedCurrency: {}, fields: {}, currencyIsoCode: currencyCodeOf(record) };
  }
}

async function resolve(client: SalesforceClient, sobject: string, recordId: string, record: Record<string, unknown>): Promise<RecordDisplayMeta> {
  const describe = await describeObjectCached(client, sobject);

  // Only describe targets of lookups that are actually populated on this record.
  const populated = describe.fields.filter(f => f.type === "reference" && typeof record[f.name] === "string");
  const singleTargets = [...new Set(populated.filter(f => f.referenceTo?.length === 1).map(f => f.referenceTo![0]))];
  const nameFields = new Map<string, string | null>();
  await Promise.all(singleTargets.map(async target => {
    try {
      nameFields.set(target, nameFieldOf(await describeObjectCached(client, target))?.name ?? null);
    } catch {
      nameFields.set(target, null); // Target not describable for this user — resolved by Id below, or left unavailable.
    }
  }));

  const plans = planReferences(describe, record, s => nameFields.get(s) ?? null);
  const currencyFields = currencyFieldsToFormat(describe, record);
  const names = new Map<string, string | null>();
  const formattedCurrency: Record<string, string> = {};

  const soql = buildReferenceQuery(sobject, recordId, plans, currencyFields);
  let row: Record<string, unknown> | null = null;
  if (soql) {
    try {
      row = (await client.query<Record<string, unknown>>(soql)).records[0] ?? null;
    } catch {
      row = null;
    }
  }
  if (row) {
    for (const p of plans) names.set(p.field, p.path ? readPath(row, p.path) : null);
    currencyFields.forEach((f, i) => {
      const v = row![`fmt${i}`];
      if (typeof v === "string" && v.trim()) formattedCurrency[f] = v;
    });
  }

  const missing = plans.filter(p => !names.get(p.field));
  if (missing.length) {
    const byId = await resolveNamesById(client, missing.map(p => ({ id: p.id, referenceTo: p.referenceTo }))).catch(() => new Map());
    for (const p of missing) names.set(p.field, byId.get(p.id)?.name ?? null);
  }

  const references: Record<string, RecordReferenceValue> = {};
  for (const p of plans) {
    const name = names.get(p.field) ?? null;
    references[p.field] = { id: p.id, name: name && name !== p.id ? name : null, sobject: p.referenceTo.length === 1 ? p.referenceTo[0] : null };
  }

  const fields: Record<string, RecordFieldMeta> = {};
  for (const f of describe.fields) if (f.name in record) fields[f.name] = { label: displayLabel(f), type: f.type };

  return { references, formattedCurrency, fields, currencyIsoCode: currencyCodeOf(record) };
}
