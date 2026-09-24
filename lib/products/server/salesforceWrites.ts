import type { SalesforceClient } from "@/lib/salesforce/client";

/**
 * Small Salesforce write helpers shared by /api/sf/products/save (create)
 * and /api/sf/products/[id] (update) — extracted from save/route.ts
 * verbatim so both routes resolve Catalog/Category the exact same way
 * instead of the update path re-implementing its own version.
 */

export function soqlEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function isUnsupportedSObject(e: Error): boolean {
  return /sObject type .+ is not supported/i.test(e.message) || /INVALID_TYPE/i.test(e.message);
}

export async function findOrCreate(
  client: SalesforceClient,
  sobject: string,
  fields: Record<string, unknown>,
  searchOn: string[],
): Promise<{ id: string; created: boolean }> {
  const whereClauses = searchOn
    .map((k) => `${k} = '${soqlEscape(String(fields[k] ?? ""))}'`)
    .join(" AND ");
  const soql = `SELECT Id FROM ${sobject} WHERE ${whereClauses} LIMIT 1`;

  try {
    const result = await client.query<{ Id: string }>(soql);
    if (result.records.length > 0) return { id: result.records[0].Id, created: false };
  } catch {
    // not found — fall through to create
  }

  const created = await client.createRecord(sobject, fields);
  if (!created.success) throw new Error(`Failed to create ${sobject}: ${JSON.stringify(created.errors)}`);
  return { id: created.id, created: true };
}
