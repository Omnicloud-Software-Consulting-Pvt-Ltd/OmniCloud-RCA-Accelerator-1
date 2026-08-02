import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import type { ReferenceLookupResult, ReferenceObjectType } from "@/lib/quotes/types";

/**
 * Standard Contract has NO free-text Name field — its real identifier is the
 * system-assigned ContractNumber, with Name only present if this specific org
 * added a custom one (§2.1 of the Contract spec). Every Contract lookup
 * (exact-match validation AND type-ahead search) resolves both fields once
 * here instead of assuming the generic `Name`-only shape every other
 * reference object uses.
 */
async function resolveContractIdentifyingFields(client: SalesforceClient): Promise<{ numberApi: string | null; nameApi: string | null }> {
  const describe = await describeObjectCached(client, "Contract");
  const numberField = describe.fields.find(f => f.name === "ContractNumber") ?? describe.fields.find(f => /^contract number$/i.test(f.label));
  const nameField = describe.fields.find(f => f.name === "Name") ?? describe.fields.find(f => /^contract name$/i.test(f.label));
  return { numberApi: numberField?.name ?? null, nameApi: nameField?.name ?? null };
}

/** Prefer a real Name value when this org has one (mirrors every other reference object); otherwise the ContractNumber IS the identifier — never fabricate a combined label that wouldn't round-trip through an exact-match lookup. */
function contractDisplayName(id: string, number: string | null, name: string | null): string {
  return name ?? number ?? id;
}

/**
 * Generic "validate reference by name" capability (§3.3) shared by every
 * lookup field (Account, Pricebook2, Opportunity, Contact, User, Quote,
 * Contract) — one implementation, not one bespoke query per object.
 * Every user-supplied string is SOQL-escaped before interpolation.
 */
export async function resolveReferenceByName(
  client: SalesforceClient,
  objectType: ReferenceObjectType,
  name: string,
): Promise<ReferenceLookupResult | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const escaped = soqlEscape(trimmed);

  if (objectType === "Contract") {
    const { numberApi, nameApi } = await resolveContractIdentifyingFields(client);
    const clauses = [numberApi && `${numberApi} = '${escaped}'`, nameApi && `${nameApi} = '${escaped}'`].filter(Boolean);
    if (clauses.length === 0) return null;
    const selectFields = ["Id", numberApi, nameApi].filter(Boolean).join(", ");
    try {
      const result = await client.query<Record<string, unknown>>(`SELECT ${selectFields} FROM Contract WHERE ${clauses.join(" OR ")} LIMIT 1`);
      const record = result.records[0];
      if (!record) return null;
      const number = numberApi ? (record[numberApi] as string | null) : null;
      const recordName = nameApi ? (record[nameApi] as string | null) : null;
      return { id: record.Id as string, name: contractDisplayName(record.Id as string, number, recordName) };
    } catch {
      return null;
    }
  }

  const activeFilter = objectType === "Pricebook2" ? " AND IsActive = true" : "";
  const soql = `SELECT Id, Name FROM ${objectType} WHERE Name = '${escaped}'${activeFilter} LIMIT 1`;

  try {
    const result = await client.query<{ Id: string; Name: string }>(soql);
    const record = result.records[0];
    return record ? { id: record.Id, name: record.Name } : null;
  } catch {
    return null;
  }
}

export async function resolveReferencesByName(
  client: SalesforceClient,
  lookups: { objectType: ReferenceObjectType; name: string }[],
): Promise<(ReferenceLookupResult | null)[]> {
  return Promise.all(lookups.map(l => resolveReferenceByName(client, l.objectType, l.name)));
}

/** Escape a term for safe interpolation into a SOQL LIKE pattern — soqlEscape handles the quote/backslash injection risk; `%`/`_` are LIKE wildcards that also need literal-escaping so a search term containing them doesn't behave unexpectedly. */
function escapeSoqlLike(value: string): string {
  return soqlEscape(value).replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Type-ahead "contains" search by name, shared by every reference lookup
 * field (Account, Opportunity, Pricebook2, Contact, Contract, User, ...) —
 * the search-side counterpart of resolveReferenceByName's exact-match
 * validation. Powers the generic `ReferenceLookup` component's dropdown.
 */
export async function searchReferencesByName(
  client: SalesforceClient,
  objectType: ReferenceObjectType,
  term: string,
  limit = 10,
): Promise<ReferenceLookupResult[]> {
  const trimmed = term.trim();
  if (!trimmed) return [];
  const escaped = escapeSoqlLike(trimmed);

  if (objectType === "Contract") {
    const { numberApi, nameApi } = await resolveContractIdentifyingFields(client);
    const clauses = [numberApi && `${numberApi} LIKE '%${escaped}%'`, nameApi && `${nameApi} LIKE '%${escaped}%'`].filter(Boolean);
    if (clauses.length === 0) return [];
    const selectFields = ["Id", numberApi, nameApi].filter(Boolean).join(", ");
    const orderBy = nameApi ?? numberApi;
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${selectFields} FROM Contract WHERE ${clauses.join(" OR ")} ORDER BY ${orderBy} LIMIT ${limit}`,
      );
      return result.records.map(r => {
        const number = numberApi ? (r[numberApi] as string | null) : null;
        const recordName = nameApi ? (r[nameApi] as string | null) : null;
        return { id: r.Id as string, name: contractDisplayName(r.Id as string, number, recordName) };
      });
    } catch {
      return [];
    }
  }

  const activeFilter = objectType === "Pricebook2" ? " AND IsActive = true" : "";
  const soql = `SELECT Id, Name FROM ${objectType} WHERE Name LIKE '%${escaped}%'${activeFilter} ORDER BY Name LIMIT ${limit}`;

  try {
    const result = await client.query<{ Id: string; Name: string }>(soql);
    return result.records.map(r => ({ id: r.Id, name: r.Name }));
  } catch {
    return [];
  }
}
