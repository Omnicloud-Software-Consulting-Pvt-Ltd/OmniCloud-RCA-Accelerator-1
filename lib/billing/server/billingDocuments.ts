import { soqlEscape, type SalesforceClient, type DescribeResult } from "@/lib/salesforce/client";

/**
 * Shared Billing Document utilities (Credit Memos, Debit Memos, Payments).
 *
 * The app's Salesforce client is pinned to the billing default API version, but newer billing objects only exist on
 * newer versions (DebitMemo/DebitMemoLine: API 65.0+; postDraftCreditMemo: 65.0+). These helpers call the org's
 * newest API version through the SAME authenticated client (absolute URLs) — no second connection or token handling.
 */

const cache = (globalThis as { __rcbDocCache?: Map<string, { at: number; value: unknown }> }).__rcbDocCache ??= new Map();
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Drop one cached entry (e.g. to re-read Salesforce on an explicit retry). */
export function cacheClear(key: string): void { cache.delete(key); }

/** The org's newest REST API version (e.g. "v67.0"). */
export async function latestApiVersion(client: SalesforceClient): Promise<string> {
  return cached(`${client.instanceUrl}:versions`, 3_600_000, async () => {
    const res = await client.requestWithDiagnostics(`${client.instanceUrl}/services/data/`, { method: "GET" }).catch(() => null);
    const list = Array.isArray(res?.json) ? (res!.json as { version: string }[]) : [];
    return list.length ? `v${list[list.length - 1].version}` : client.apiVersion;
  });
}

export const apiUrl = (client: SalesforceClient, version: string, path: string) => `${client.instanceUrl}/services/data/${version}${path}`;

export class SalesforceCallError extends Error {
  constructor(message: string, readonly status: number, readonly errors: { message?: string; errorCode?: string; fields?: string[] }[], readonly raw: unknown) { super(message); }
}

/** The Salesforce user and org behind THIS connection (OAuth userinfo) — resolved per client, never assumed or reused across orgs. */
export interface SfIdentity { userId: string | null; orgId: string | null; username: string | null; displayName: string | null; email: string | null }
const identities = new WeakMap<SalesforceClient, Promise<SfIdentity>>();
export function currentIdentity(client: SalesforceClient): Promise<SfIdentity> {
  let p = identities.get(client);
  if (!p) {
    p = client.requestWithDiagnostics(`${client.instanceUrl}/services/oauth2/userinfo`, { method: "GET" }).then(res => {
      const j = (res.status < 400 ? res.json : null) as { user_id?: string; organization_id?: string; preferred_username?: string; name?: string; email?: string } | null;
      return { userId: j?.user_id ?? null, orgId: j?.organization_id ?? null, username: j?.preferred_username ?? null, displayName: j?.name ?? null, email: j?.email ?? null };
    }).catch(() => ({ userId: null, orgId: null, username: null, displayName: null, email: null }));
    identities.set(client, p);
  }
  return p;
}
/** Cache scope for anything user-dependent (describe createable/FLS, permissions): this org + this user. */
export async function sessionScope(client: SalesforceClient): Promise<string> {
  const id = await currentIdentity(client);
  return `${id.orgId ?? client.instanceUrl}:${id.userId ?? "?"}`;
}

/** Describe an sObject on a given API version; null when the object doesn't exist there (or isn't visible to the user). */
export async function describeAt(client: SalesforceClient, version: string, sobject: string): Promise<DescribeResult | null> {
  return cached(`${await sessionScope(client)}:${version}:describe:${sobject}`, 600_000, async () => {
    const res = await client.requestWithDiagnostics(apiUrl(client, version, `/sobjects/${sobject}/describe`), { method: "GET" });
    return res.status === 200 ? (res.json as DescribeResult) : null;
  });
}

/** SOQL on a given API version (all pages). */
export async function queryAt(client: SalesforceClient, version: string, soql: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let url: string | null = apiUrl(client, version, `/query?q=${encodeURIComponent(soql)}`);
  while (url) {
    const res = await client.requestWithDiagnostics(url, { method: "GET" });
    if (res.status >= 400) {
      const errs = Array.isArray(res.json) ? (res.json as { message?: string; errorCode?: string }[]) : [];
      throw new SalesforceCallError(errs.map(e => e.message).join("; ") || res.statusText, res.status, errs, res.json ?? res.rawText);
    }
    const page = res.json as { records: Record<string, unknown>[]; nextRecordsUrl?: string };
    out.push(...page.records);
    url = page.nextRecordsUrl ? `${client.instanceUrl}${page.nextRecordsUrl}` : null;
  }
  return out;
}

export interface CompositeSub { method: "POST" | "PATCH" | "DELETE"; url: string; referenceId: string; body?: Record<string, unknown> }
export interface CompositeResult { ok: boolean; results: { referenceId: string; httpStatusCode: number; body: unknown }[]; errors: { referenceId: string; message?: string; errorCode?: string; fields?: string[] }[] }

/** One all-or-nothing Composite request on a given API version (sub-request URLs are relative to /services/data/{version}). */
export async function compositeAt(client: SalesforceClient, version: string, requests: CompositeSub[]): Promise<CompositeResult> {
  const res = await client.requestWithDiagnostics(apiUrl(client, version, "/composite"), {
    method: "POST",
    body: JSON.stringify({ allOrNone: true, compositeRequest: requests.map(r => ({ ...r, url: `/services/data/${version}${r.url}` })) }),
  });
  if (res.status >= 400) {
    const errs = Array.isArray(res.json) ? (res.json as { message?: string; errorCode?: string }[]) : [];
    throw new SalesforceCallError(errs.map(e => e.message).join("; ") || res.statusText, res.status, errs, res.json ?? res.rawText);
  }
  const results = ((res.json as { compositeResponse?: { referenceId: string; httpStatusCode: number; body: unknown }[] })?.compositeResponse) ?? [];
  const errors = results.filter(r => r.httpStatusCode >= 400).flatMap(r => (Array.isArray(r.body) ? (r.body as { message?: string; errorCode?: string; fields?: string[] }[]) : [{ message: String(r.body) }])
    .filter(e => e.errorCode !== "PROCESSING_HALTED").map(e => ({ referenceId: r.referenceId, ...e })));
  return { ok: results.length > 0 && errors.length === 0 && results.every(r => r.httpStatusCode < 400), results, errors };
}

/* ───────────────────────────── Org currency ───────────────────────────── */

export interface OrgCurrency { symbol: string | null; code: string | null; sample: string | null }

/**
 * Single-currency orgs don't expose the currency code on Organization/User, so ask Salesforce to FORMAT a real
 * currency value and read the symbol it renders. The ISO code is only filled in when the symbol is unambiguous
 * (e.g. "₹" → INR); "$" stays code-less because several currencies use it.
 */
export async function orgCurrency(client: SalesforceClient): Promise<OrgCurrency> {
  return cached(`${client.instanceUrl}:orgCurrency`, 3_600_000, async () => {
    const rows = await queryAt(client, client.apiVersion, "SELECT FORMAT(TotalAmountWithTax) f FROM Invoice WHERE TotalAmountWithTax != null LIMIT 1").catch(() => []);
    const sample = typeof rows[0]?.f === "string" ? (rows[0].f as string) : null;
    const symbol = sample ? sample.replace(/[\d.,\s-]/g, "") || null : null;
    let code: string | null = null;
    if (symbol) {
      if (/^[A-Z]{3}$/.test(symbol)) code = symbol;
      else {
        const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("currency") ?? [];
        const hits = all.filter(c => { try { return new Intl.NumberFormat("en", { style: "currency", currency: c, currencyDisplay: "narrowSymbol" }).formatToParts(1).find(p => p.type === "currency")?.value === symbol; } catch { return false; } });
        code = hits.length === 1 ? hits[0] : null;
      }
    }
    return { symbol, code, sample };
  });
}

/** Does a user-supplied currency ("INR", "₹", "rupees", "usd"…) match the org currency? null = can't tell. */
export function currencyMatches(org: OrgCurrency, supplied: string): boolean | null {
  const s = supplied.trim();
  if (!s) return null;
  if (org.symbol && s === org.symbol) return true;
  if (org.code && s.toUpperCase() === org.code) return true;
  const words: Record<string, string> = { rupee: "INR", rupees: "INR", dollar: "USD", dollars: "USD", euro: "EUR", euros: "EUR", pound: "GBP", pounds: "GBP", yen: "JPY" };
  const asCode = /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : words[s.toLowerCase()] ?? null;
  if (asCode && org.code) return asCode === org.code;
  if (asCode && org.symbol && !org.code) {
    try { return new Intl.NumberFormat("en", { style: "currency", currency: asCode, currencyDisplay: "narrowSymbol" }).formatToParts(1).find(p => p.type === "currency")?.value === org.symbol; } catch { return false; }
  }
  return null;
}

/* ───────────────────────────── Record resolution ───────────────────────────── */

export type Resolution<T> =
  | { status: "found"; record: T }
  | { status: "multiple"; candidates: T[]; message: string }
  | { status: "not-found"; message: string }
  | { status: "invalid"; record: T; message: string };

const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

export interface AccountRef { id: string; name: string }
/** Account by name — exact (case-insensitive) first, then a contains search. Never by an Id the AI produced. */
export async function resolveAccount(client: SalesforceClient, name: string): Promise<Resolution<AccountRef>> {
  const term = name.trim();
  if (!term) return { status: "not-found", message: "No account name was given." };
  const exact = await queryAt(client, client.apiVersion, `SELECT Id, Name FROM Account WHERE Name = '${soqlEscape(term)}' LIMIT 5`);
  const rows = exact.length ? exact : await queryAt(client, client.apiVersion, `SELECT Id, Name FROM Account WHERE Name LIKE '%${soqlEscape(term)}%' ORDER BY Name LIMIT 6`);
  const list = rows.map(r => ({ id: r.Id as string, name: String(r.Name) }));
  if (list.length === 1) return { status: "found", record: list[0] };
  if (!list.length) return { status: "not-found", message: `No Salesforce account matches "${term}".` };
  return { status: "multiple", candidates: list.slice(0, 5), message: `"${term}" matches ${list.length >= 6 ? "6 or more" : list.length} accounts — choose one.` };
}

export interface ProductRef { id: string; name: string; code: string | null; active: boolean }
/** Product2 by product code (exact) or name (exact, then contains). Inactive products are reported, not used. */
export async function resolveProduct(client: SalesforceClient, nameOrCode: string): Promise<Resolution<ProductRef>> {
  const term = nameOrCode.trim();
  if (!term) return { status: "not-found", message: "No product was given." };
  const map = (r: Record<string, unknown>): ProductRef => ({ id: r.Id as string, name: String(r.Name), code: (r.ProductCode as string) ?? null, active: r.IsActive === true });
  let rows = await queryAt(client, client.apiVersion, `SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE ProductCode = '${soqlEscape(term)}' OR Name = '${soqlEscape(term)}' ORDER BY IsActive DESC, Name LIMIT 6`);
  if (!rows.length) rows = await queryAt(client, client.apiVersion, `SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Name LIKE '%${soqlEscape(term)}%' ORDER BY IsActive DESC, Name LIMIT 6`);
  const list = rows.map(map);
  const active = list.filter(p => p.active);
  if (active.length === 1) return { status: "found", record: active[0] };
  if (!list.length) return { status: "not-found", message: `No Salesforce product matches "${term}".` };
  if (!active.length) return { status: "invalid", record: list[0], message: `Product "${list[0].name}" is inactive in Salesforce.` };
  return { status: "multiple", candidates: active.slice(0, 5), message: `"${term}" matches ${active.length} active products — choose one.` };
}

export interface InvoiceRef { id: string; number: string | null; status: string | null; account: AccountRef | null; lines: { id: string; name: string | null; productId: string | null; product: string | null; amount: number | null }[] }
/** Invoice by its document number (never by an AI-produced Id), with its lines. */
export async function resolveInvoice(client: SalesforceClient, numberOrId: string, opts: { allowId?: boolean } = {}): Promise<Resolution<InvoiceRef>> {
  const term = numberOrId.trim();
  if (!term) return { status: "not-found", message: "No invoice number was given." };
  const where = opts.allowId && SFID.test(term) ? `Id = '${soqlEscape(term)}'` : `DocumentNumber = '${soqlEscape(term)}'`;
  const rows = await queryAt(client, client.apiVersion, `SELECT Id, DocumentNumber, Status, BillingAccountId, BillingAccount.Name FROM Invoice WHERE ${where} LIMIT 3`);
  if (!rows.length) return { status: "not-found", message: `Invoice "${term}" was not found in Salesforce.` };
  if (rows.length > 1) return { status: "multiple", candidates: rows.map(r => ({ id: r.Id as string, number: (r.DocumentNumber as string) ?? null, status: (r.Status as string) ?? null, account: null, lines: [] })), message: `"${term}" matches more than one invoice.` };
  const r = rows[0];
  const lines = await queryAt(client, client.apiVersion, `SELECT Id, Name, Product2Id, Product2.Name, LineAmount FROM InvoiceLine WHERE InvoiceId = '${soqlEscape(r.Id as string)}' ORDER BY CreatedDate, Id`).catch(() => []);
  const acc = r.BillingAccount as { Name?: string } | null;
  return {
    status: "found",
    record: {
      id: r.Id as string, number: (r.DocumentNumber as string) ?? null, status: (r.Status as string) ?? null,
      account: r.BillingAccountId ? { id: r.BillingAccountId as string, name: acc?.Name ?? String(r.BillingAccountId) } : null,
      lines: lines.map(l => ({ id: l.Id as string, name: (l.Name as string) ?? null, productId: (l.Product2Id as string) ?? null, product: ((l.Product2 as { Name?: string } | null)?.Name) ?? null, amount: typeof l.LineAmount === "number" ? l.LineAmount : null })),
    },
  };
}

/* ───────────────────────────── Friendly Salesforce errors ───────────────────────────── */

/** Translate Salesforce error codes into a sentence a billing user can act on (the raw error is logged/returned separately). */
export function friendlySalesforceError(err: { message?: string; errorCode?: string; fields?: string[] }, docLabel: string): string {
  const f = err.fields?.length ? ` (${err.fields.join(", ")})` : "";
  switch (err.errorCode) {
    case "REQUIRED_FIELD_MISSING": return `The ${docLabel} could not be created because a required Salesforce field is missing${f}.`;
    case "INVALID_FIELD":
    case "INVALID_FIELD_FOR_INSERT_UPDATE": return `The ${docLabel} could not be created because a field isn't valid for this org or your user${f}.`;
    case "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST": return `The ${docLabel} could not be created because a picklist value isn't allowed in this org${f}.`;
    case "INSUFFICIENT_ACCESS":
    case "INSUFFICIENT_ACCESS_OR_READONLY":
    case "INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY": return `Your Salesforce user doesn't have access to create this ${docLabel} or one of the records it references.`;
    case "MALFORMED_ID":
    case "INVALID_CROSS_REFERENCE_KEY": return `The ${docLabel} could not be created because a referenced record (account, invoice line or product) is missing or invalid${f}.`;
    case "FIELD_CUSTOM_VALIDATION_EXCEPTION": return `A Salesforce validation rule blocked the ${docLabel}: ${err.message ?? ""}`.trim();
    case "FIELD_INTEGRITY_EXCEPTION": return `The ${docLabel} could not be created because a referenced value isn't allowed here${f}: ${err.message ?? ""}`.trim();
    case "STRING_TOO_LONG": return `A text value is too long for Salesforce${f}.`;
    case "DUPLICATE_VALUE": return `Salesforce reports a duplicate value${f}.`;
    case "INVALID_SESSION_ID": return "Your Salesforce session has expired. Sign in again.";
    default: return err.message ? `Salesforce rejected the ${docLabel}: ${err.message}` : `Salesforce rejected the ${docLabel}.`;
  }
}
