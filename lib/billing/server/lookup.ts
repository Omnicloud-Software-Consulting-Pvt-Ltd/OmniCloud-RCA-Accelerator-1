import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { billingDescribe, billingDescribeGlobal, moduleKeyBySobject, nameFieldOf } from "@/lib/billing/server/discovery";
import type { BillingReferenceValue } from "@/lib/billing/types";

const SOBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** Salesforce record Id shape (15 or 18 chars). Used to REJECT AI-supplied Ids — every Id must come from a query. */
export const SALESFORCE_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

function escapeLike(value: string): string {
  return soqlEscape(value).replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Secondary "code" fields worth matching in type-ahead (e.g. typing "GB" finds the Gigabyte unit). Only used when present in Describe. */
const CODE_FIELD_CANDIDATES = ["ProductCode", "Code", "UnitCode", "StockKeepingUnit"];

interface SearchableObject {
  sobject: string;
  nameField: string;
  nameFilterable: boolean;
  codeField: string | null;
  hasLastModified: boolean;
  statusField: string | null;
}

async function searchableShape(client: SalesforceClient, sobject: string): Promise<SearchableObject> {
  if (!SOBJECT_NAME.test(sobject)) throw new Error(`Invalid object name "${sobject}".`);
  const global = await billingDescribeGlobal(client);
  const entry = global.find(g => g.name === sobject);
  if (!entry || !entry.queryable) throw new Error(`${sobject} isn't queryable in this org for your user.`);
  const describe = await billingDescribe(client, sobject);
  const nameField = nameFieldOf(describe);
  if (!nameField) throw new Error(`${sobject} has no record-name field to search on.`);
  const codeField = CODE_FIELD_CANDIDATES.map(c => describe.fields.find(f => f.name === c && f.filterable !== false)).find(Boolean) ?? null;
  const status = describe.fields.find(f => f.name === "Status") ?? describe.fields.find(f => f.name === "IsActive") ?? null;
  return {
    sobject,
    nameField: nameField.name,
    nameFilterable: nameField.filterable !== false,
    codeField: codeField?.name ?? null,
    hasLastModified: describe.fields.some(f => f.name === "LastModifiedDate"),
    statusField: status?.name ?? null,
  };
}

function toValue(r: Record<string, unknown>, shape: SearchableObject, moduleKey: string | null): BillingReferenceValue & { status: string | null } {
  const name = (r[shape.nameField] as string | null) ?? (r.Id as string);
  const code = shape.codeField ? (r[shape.codeField] as string | null) : null;
  const statusRaw = shape.statusField ? r[shape.statusField] : null;
  const status = typeof statusRaw === "boolean" ? (statusRaw ? "Active" : "Inactive") : (statusRaw as string | null) ?? null;
  return { id: r.Id as string, name: code && code !== name ? `${name} (${code})` : name, sobject: shape.sobject, moduleKey, status };
}

/** Type-ahead search for the lookup fields — "contains" on the name (and code) field; recent records when the term is empty. */
export async function searchBillingReferences(client: SalesforceClient, sobject: string, term: string, limit = 10): Promise<(BillingReferenceValue & { status: string | null })[]> {
  const shape = await searchableShape(client, sobject);
  const moduleKey = (await moduleKeyBySobject(client)).get(sobject) ?? null;
  const select = ["Id", shape.nameField, shape.codeField, shape.statusField].filter(Boolean).join(", ");
  const trimmed = term.trim();
  let where = "";
  if (trimmed) {
    const clauses: string[] = [];
    if (shape.nameFilterable) clauses.push(`${shape.nameField} LIKE '%${escapeLike(trimmed)}%'`);
    if (shape.codeField) clauses.push(`${shape.codeField} LIKE '%${escapeLike(trimmed)}%'`);
    if (clauses.length === 0) return [];
    where = ` WHERE ${clauses.join(" OR ")}`;
  }
  const orderBy = trimmed || !shape.hasLastModified ? shape.nameField : "LastModifiedDate DESC";
  const res = await client.query<Record<string, unknown>>(`SELECT ${select} FROM ${sobject}${where} ORDER BY ${orderBy} LIMIT ${Math.min(Math.max(limit, 1), 50)}`);
  return res.records.map(r => toValue(r, shape, moduleKey));
}

export type ReferenceResolution =
  | { outcome: "resolved"; match: BillingReferenceValue; matchType: "exact" | "partial" }
  | { outcome: "ambiguous"; candidates: BillingReferenceValue[] }
  | { outcome: "not-found"; candidates: BillingReferenceValue[] };

/**
 * Resolve a natural-language record name ("Standard Billing Policy") to a real
 * Salesforce record. Exact (case-insensitive) name match wins; otherwise a
 * single "contains" match is accepted as a partial match; several matches
 * are returned for the user to choose — never silently picked.
 */
export async function resolveReferenceByName(client: SalesforceClient, sobject: string, name: string): Promise<ReferenceResolution> {
  const shape = await searchableShape(client, sobject);
  const moduleKey = (await moduleKeyBySobject(client)).get(sobject) ?? null;
  const trimmed = name.trim();
  if (!trimmed || !shape.nameFilterable) return { outcome: "not-found", candidates: [] };
  const select = ["Id", shape.nameField, shape.codeField, shape.statusField].filter(Boolean).join(", ");

  const exactClauses = [`${shape.nameField} = '${soqlEscape(trimmed)}'`];
  if (shape.codeField) exactClauses.push(`${shape.codeField} = '${soqlEscape(trimmed)}'`);
  const exact = await client.query<Record<string, unknown>>(`SELECT ${select} FROM ${sobject} WHERE ${exactClauses.join(" OR ")} LIMIT 5`);
  if (exact.records.length === 1) return { outcome: "resolved", match: toValue(exact.records[0], shape, moduleKey), matchType: "exact" };
  if (exact.records.length > 1) return { outcome: "ambiguous", candidates: exact.records.map(r => toValue(r, shape, moduleKey)) };

  // Drop filler words the user naturally adds ("the Standard policy") before the contains-search.
  const core = trimmed.replace(/\b(the|a|an)\b/gi, " ").replace(/\s+/g, " ").trim() || trimmed;
  const partial = await searchBillingReferences(client, sobject, core, 6);
  if (partial.length === 1) return { outcome: "resolved", match: partial[0], matchType: "partial" };
  if (partial.length > 1) return { outcome: "ambiguous", candidates: partial };
  return { outcome: "not-found", candidates: [] };
}

/**
 * Look up display names for a set of record Ids, grouped by object. Polymorphic
 * references are grouped by the Id's key prefix against the org's own global
 * Describe — never by guessing from field names.
 */
export async function resolveNamesById(client: SalesforceClient, refs: { id: string; referenceTo: string[] }[]): Promise<Map<string, BillingReferenceValue>> {
  const out = new Map<string, BillingReferenceValue>();
  if (refs.length === 0) return out;
  const global = await billingDescribeGlobal(client);
  const byPrefix = new Map(global.filter(g => g.keyPrefix).map(g => [g.keyPrefix as string, g.name]));
  const groups = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!ref.id || !SALESFORCE_ID.test(ref.id)) continue;
    const target = ref.referenceTo.length === 1 ? ref.referenceTo[0] : (byPrefix.get(ref.id.slice(0, 3)) ?? ref.referenceTo[0]);
    if (!target) continue;
    if (!groups.has(target)) groups.set(target, new Set());
    groups.get(target)!.add(ref.id);
  }
  const bySobject = await moduleKeyBySobject(client);
  await Promise.all([...groups.entries()].map(async ([sobject, ids]) => {
    try {
      const describe = await billingDescribe(client, sobject);
      const nameField = nameFieldOf(describe)?.name;
      if (!nameField) return;
      const idList = [...ids].map(id => `'${soqlEscape(id)}'`).join(",");
      const res = await client.query<Record<string, unknown>>(`SELECT Id, ${nameField} FROM ${sobject} WHERE Id IN (${idList})`);
      for (const r of res.records) {
        out.set(r.Id as string, { id: r.Id as string, name: (r[nameField] as string) ?? (r.Id as string), sobject, moduleKey: bySobject.get(sobject) ?? null });
      }
    } catch {
      // Names are display sugar — an object the user can't read just shows as an unnamed linked record.
    }
  }));
  return out;
}
