import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { queryAt } from "@/lib/billing/server/billingDocuments";
import { BadInputError } from "@/lib/billing/server/payments";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { escapeLike, num, searchTaxProducts, str } from "@/lib/tax/server/records";
import type { LookupOption, LookupPage, TaxLookupObject } from "@/lib/tax/types";

/**
 * Server-side search for the tax pages' lookups (Account, Contact, Product2, Invoice, GeoCountry, GeoState). Every query is built
 * here from the org's describe (a field the org lacks is neither selected nor searched), user text only ever appears escaped inside
 * a LIKE literal, record Ids are format-checked, and results come one keyset page at a time (no OFFSET ceiling, no overlap).
 */

export const LOOKUP_OBJECTS: TaxLookupObject[] = ["Account", "Contact", "Product2", "Invoice", "GeoCountry", "GeoState"];
export const LOOKUP_PAGE_SIZE = 25;
const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const DATETIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:?\d\d)$/;

type Rec = Record<string, unknown>;
export interface LookupOpts { q: string; cursor?: string | null; accountId?: string | null; country?: string | null; pageSize?: number }
/** Just what the query builder needs from a describe. */
export type FieldInfo = { name: string; relationshipName?: string | null; filterable?: boolean };

interface Spec {
  sort: { field: string; desc?: boolean; kind: "string" | "datetime" };
  /** Optional fields — selected only when the org has them. */
  select: string[];
  /** Searched with LIKE '%term%' when present and filterable. */
  search: string[];
  /** A pasted record Id with this key prefix also matches by Id. */
  idPrefix: string | null;
  /** Required scope (Account → Contact, Country → State). */
  scope?: (o: LookupOpts) => string;
  toOption: (r: Rec) => LookupOption;
}

const rel = (r: Rec, k: string) => (r[k] as Rec | null | undefined) ?? null;
const join = (xs: unknown[], sep = ", ") => xs.map(str).filter(Boolean).join(sep) || null;

export const LOOKUP_SPECS: Record<Exclude<TaxLookupObject, "Product2">, Spec> = {
  Account: {
    sort: { field: "Name", kind: "string" }, idPrefix: "001",
    select: ["Name", "AccountNumber", "BillingStreet", "BillingCity", "BillingState", "BillingPostalCode", "BillingCountry"],
    search: ["Name", "AccountNumber"],
    toOption: r => {
      // The same fields startVerificationRun requires before it creates an order.
      const complete = !!(str(r.BillingStreet) && str(r.BillingCity) && str(r.BillingCountry));
      return {
        id: String(r.Id), label: String(r.Name), code: str(r.AccountNumber), detail: join([r.BillingCity, r.BillingState, r.BillingCountry]) ?? "No billing address",
        badge: complete ? null : { text: "Incomplete billing address", tone: "warn" },
        facts: { billingComplete: complete, billingCountry: str(r.BillingCountry), billingState: str(r.BillingState) },
      };
    },
  },
  Contact: {
    sort: { field: "Name", kind: "string" }, idPrefix: "003",
    select: ["Name", "Email", "Title", "AccountId", "Account.Name"],
    search: ["Name", "Email"],
    scope: o => {
      if (!o.accountId || !SFID.test(o.accountId)) throw new BadInputError("Select an Account first — the Contact must belong to it.");
      return `AccountId = '${o.accountId}'`;
    },
    toOption: r => ({ id: String(r.Id), label: String(r.Name), code: null, detail: join([r.Email, r.Title, rel(r, "Account")?.Name], " · "), badge: null, facts: { accountId: str(r.AccountId) } }),
  },
  Invoice: {
    sort: { field: "CreatedDate", desc: true, kind: "datetime" }, idPrefix: "3tt",
    select: ["DocumentNumber", "InvoiceNumber", "BillingAccountId", "BillingAccount.Name", "Status", "InvoiceDate", "TotalAmountWithTax"],
    search: ["DocumentNumber", "InvoiceNumber", "BillingAccount.Name"],
    toOption: r => {
      const total = num(r.TotalAmountWithTax);
      return {
        id: String(r.Id), label: str(r.DocumentNumber) ?? String(r.Id), code: str(r.Status),
        detail: join([rel(r, "BillingAccount")?.Name, r.InvoiceDate, total === null ? null : `total ${total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`], " · "),
        badge: null, facts: { accountId: str(r.BillingAccountId) },
      };
    },
  },
  GeoCountry: {
    sort: { field: "Name", kind: "string" }, idPrefix: null,
    select: ["Name", "IsoCode"], search: ["Name", "IsoCode"],
    toOption: r => ({ id: String(r.Id), label: String(r.Name), code: str(r.IsoCode), detail: null, badge: null, facts: { iso: str(r.IsoCode)?.toUpperCase() ?? null } }),
  },
  GeoState: {
    sort: { field: "Name", kind: "string" }, idPrefix: null,
    select: ["Name", "IsoCode", "GeoCountry.Name"], search: ["Name", "IsoCode"],
    scope: o => {
      const iso = (o.country ?? "").trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(iso)) throw new BadInputError("Select a Country first — states are listed for the selected country.");
      return `GeoCountry.IsoCode = '${iso}'`;
    },
    toOption: r => ({ id: String(r.Id), label: String(r.Name), code: str(r.IsoCode), detail: str(rel(r, "GeoCountry")?.Name), badge: null, facts: { iso: str(r.IsoCode)?.toUpperCase() ?? null } }),
  },
};

/* ── Cursor: [sort value, Id] of the last row ── */

export const encodeLookupCursor = (v: string, id: string) => Buffer.from(JSON.stringify([v, id]), "utf8").toString("base64url");
export function decodeLookupCursor(raw: string | null | undefined, kind: "string" | "datetime"): { v: string; id: string } | null {
  if (!raw) return null;
  try {
    const [v, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown[];
    if (typeof v !== "string" || typeof id !== "string" || !SFID.test(id)) return null;
    if (kind === "datetime") {
      // Salesforce returns "…+0000"; SOQL wants an ISO literal (CreatedDate has whole seconds).
      const iso = v.replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
      return DATETIME.test(v) && !Number.isNaN(Date.parse(iso)) ? { v: new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z"), id } : null;
    }
    return { v, id };
  } catch { return null; }
}

/** The SOQL for one page (pure — unit-tested). Throws BadInputError when a required parent (Account, Country) is missing. */
export function buildLookupSoql(object: Exclude<TaxLookupObject, "Product2">, fields: FieldInfo[], opts: LookupOpts): string {
  const spec = LOOKUP_SPECS[object];
  const has = (path: string) => path.includes(".") ? fields.some(f => f.relationshipName === path.split(".")[0]) : fields.some(f => f.name === path);
  const filterable = (path: string) => has(path) && (path.includes(".") || fields.find(f => f.name === path)?.filterable !== false);
  const cols = [...new Set(["Id", spec.sort.field, ...spec.select.filter(has)])];
  const where: string[] = [];
  if (spec.scope) where.push(spec.scope(opts));
  const term = opts.q.trim();
  if (term) {
    const or = spec.search.filter(filterable).map(f => `${f} LIKE '%${escapeLike(term)}%'`);
    if (spec.idPrefix && SFID.test(term) && term.startsWith(spec.idPrefix)) or.push(`Id = '${term}'`);
    if (!or.length) throw new BadInputError(`${object} can't be searched in this org (no searchable field).`);
    where.push(`(${or.join(" OR ")})`);
  }
  const after = decodeLookupCursor(opts.cursor, spec.sort.kind);
  if (after) {
    const lit = spec.sort.kind === "string" ? `'${soqlEscape(after.v)}'` : after.v;
    const op = spec.sort.desc ? "<" : ">";
    where.push(`(${spec.sort.field} ${op} ${lit} OR (${spec.sort.field} = ${lit} AND Id ${op} '${after.id}'))`);
  }
  const dir = spec.sort.desc ? " DESC" : "";
  const size = Math.min(Math.max(opts.pageSize ?? LOOKUP_PAGE_SIZE, 1), 100);
  return `SELECT ${cols.join(", ")} FROM ${object}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${spec.sort.field}${dir}, Id${dir} LIMIT ${size + 1}`;
}

/** One page of matching records for a lookup. */
export async function searchLookup(client: SalesforceClient, object: TaxLookupObject, opts: LookupOpts): Promise<LookupPage> {
  const meta = await discoverTaxMetadata(client);
  if (object === "Product2") {
    // The Product2 lookup is the verification search (active products, name / code / Id, tax-policy status).
    const page = await searchTaxProducts(client, meta, { q: opts.q, cursor: opts.cursor, pageSize: opts.pageSize ?? LOOKUP_PAGE_SIZE });
    return {
      nextCursor: page.nextCursor,
      options: page.products.map(p => ({
        id: p.id, label: p.name, code: p.code,
        detail: p.taxable ? `Tax policy: ${p.policyName}` : p.policyName ? `Tax policy: ${p.policyName} (no active taxable treatment)` : "No tax policy",
        badge: p.taxable ? { text: "Taxable", tone: "ok" } : { text: "Not taxable", tone: "dim" },
        facts: { taxable: p.taxable, taxPolicyId: p.taxPolicyId, policyName: p.policyName },
      })),
    };
  }
  const spec = LOOKUP_SPECS[object];
  const describe = await describeObjectCached(client, object);
  const size = Math.min(Math.max(opts.pageSize ?? LOOKUP_PAGE_SIZE, 1), 100);
  const rows = await queryAt(client, meta.apiVersion, buildLookupSoql(object, describe.fields, { ...opts, pageSize: size }));
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    options: page.map(spec.toOption),
    nextCursor: rows.length > size && last ? encodeLookupCursor(String(last[spec.sort.field]), String(last.Id)) : null,
  };
}
