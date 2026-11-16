import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { isSalesforceId } from "@/lib/orders/order/billingDetails";

export interface ContactLookupMatch {
  id: string;
  name: string;
  /** Secondary line in the lookup dropdown: "email · Account Name". */
  description: string;
}

const escapeLike = (s: string) => soqlEscape(s).replace(/[%_]/g, m => `\\${m}`);

/**
 * Contacts for the Bill To Contact lookup. Scoped to the order's Account — the Revenue Cloud Billing
 * Order Setup only accepts a Contact of the order's Account (see setOrderBillingDetails), so offering
 * any other Contact here would create an order Billing can't use. An empty term lists that Account's
 * Contacts so the dropdown can be browsed. Query errors propagate so the lookup shows them.
 */
export async function searchBillToContacts(client: SalesforceClient, accountId: string, term: string, limit = 20): Promise<ContactLookupMatch[]> {
  if (!isSalesforceId(accountId)) return [];
  const t = term.trim();
  const nameFilter = t ? ` AND Name LIKE '%${escapeLike(t)}%'` : "";
  const res = await client.query<{ Id: string; Name: string; Email: string | null; Account: { Name: string } | null }>(
    `SELECT Id, Name, Email, Account.Name FROM Contact WHERE AccountId = '${soqlEscape(accountId)}'${nameFilter} ORDER BY Name LIMIT ${limit}`,
  );
  return res.records.map(c => ({
    id: c.Id,
    name: c.Name,
    description: [c.Email, c.Account?.Name].filter(Boolean).join(" · ") || "No email",
  }));
}

export type BillToContactCheck =
  | { ok: true; contact: { id: string; name: string } }
  | { ok: false; error: string };

/** The selected Id must be a real Contact of the order's Account — checked in Salesforce right before the write. */
export async function verifyBillToContact(client: SalesforceClient, contactId: string, accountId: string | null): Promise<BillToContactCheck> {
  if (!isSalesforceId(contactId)) return { ok: false, error: "Bill To Contact must be a Salesforce Contact selected from the lookup." };
  const res = await client.query<{ Id: string; Name: string; AccountId: string | null }>(
    `SELECT Id, Name, AccountId FROM Contact WHERE Id = '${soqlEscape(contactId)}' LIMIT 1`,
  );
  const c = res.records[0];
  if (!c) return { ok: false, error: "The selected Bill To Contact no longer exists or isn't visible to you in Salesforce. Select another Contact." };
  if (accountId && c.AccountId?.slice(0, 15) !== accountId.slice(0, 15)) {
    return { ok: false, error: `${c.Name} isn't a Contact of the order's Account. Select a Contact that belongs to the selected Account.` };
  }
  return { ok: true, contact: { id: c.Id, name: c.Name } };
}
