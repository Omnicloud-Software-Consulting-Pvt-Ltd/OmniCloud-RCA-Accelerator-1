import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import type { ContractContact } from "@/lib/contracts/types";

/**
 * Dedicated Account-scoped Contact lookup for "Customer Signed By" (§3.3) —
 * deliberately NOT shared with any other module's Contact-lookup
 * implementation (e.g. Order's Contract-reference lookup has its own
 * separate concerns). Never searches while no Account is selected — there's
 * nothing to scope the search by.
 */
export async function searchAccountContacts(client: SalesforceClient, accountId: string, term: string): Promise<ContractContact[]> {
  const trimmed = term.trim();
  if (!accountId.trim() || !trimmed) return [];
  const soql = `SELECT Id, Name, AccountId FROM Contact WHERE Name LIKE '%${soqlEscape(trimmed)}%' AND AccountId = '${soqlEscape(accountId)}' LIMIT 10`;
  const result = await client.query<{ Id: string; Name: string; AccountId: string }>(soql);
  return result.records.map(r => ({ id: r.Id, name: r.Name, accountId: r.AccountId ?? null }));
}

/** Preload mode (§3.3): every Contact under the selected Account — lets the UI auto-select a single match or show "no contacts under this account". */
export async function listAccountContacts(client: SalesforceClient, accountId: string): Promise<ContractContact[]> {
  if (!accountId.trim()) return [];
  const soql = `SELECT Id, Name, AccountId FROM Contact WHERE AccountId = '${soqlEscape(accountId)}' ORDER BY Name LIMIT 200`;
  const result = await client.query<{ Id: string; Name: string; AccountId: string }>(soql);
  return result.records.map(r => ({ id: r.Id, name: r.Name, accountId: r.AccountId ?? null }));
}

/** Server-side re-verification on create (§3.3) — never trust the client-resolved Contact Id. */
export async function verifyContactById(client: SalesforceClient, contactId: string): Promise<ContractContact | null> {
  if (!contactId.trim()) return null;
  try {
    const record = await client.getRecord("Contact", contactId, ["Id", "Name", "AccountId"]);
    return { id: record.Id as string, name: record.Name as string, accountId: (record.AccountId as string) ?? null };
  } catch {
    return null;
  }
}
