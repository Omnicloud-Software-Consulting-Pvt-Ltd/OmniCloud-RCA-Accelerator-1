import { soqlEscape, type SalesforceClient, type DescribeResult } from "@/lib/salesforce/client";
import { buildSalesforceRecordUrl } from "@/lib/salesforce/recordUrl";
import { billingDescribe, billingDescribeGlobal } from "@/lib/billing/server/discovery";
import { SALESFORCE_ID } from "@/lib/billing/server/lookup";
import { findOrderContext, hasStandardAction } from "@/lib/billing/server/orderBilling";
import { BadInputError, NotFoundError, getPaymentModel, loadInvoiceForPayment, type PaymentInvoice } from "@/lib/billing/server/payments";
import { latestApiVersion } from "@/lib/billing/server/billingDocuments";

/**
 * REVENUE CLOUD BILLING — CREDIT MEMOS service (dashboard, details, create, post, apply, void). Discovered from the
 * connected org (Describe, /actions/standard, Connect resource probes) and the Revenue Management Developer Guide:
 *
 *   POST /commerce/invoicing/invoices/{invoiceId}/actions/credit   — creates AND posts a credit memo (one CreditMemoLine
 *        per invoice line) and applies it to the invoice. Invoice must be Posted; each line's credit ≤ the line amount.
 *        Asynchronous: { success, requestIdentifier, statusURL } — the CreditMemo appears once Salesforce has processed it.
 *   POST /commerce/invoicing/credit-memos/{id}/actions/apply        — apply a credit memo to invoices
 *   POST /commerce/invoicing/credit-memo-lines/{id}/actions/apply   — apply a credit memo line to invoice lines
 *   actions/standard/postDraftCreditMemo (API 65+) · voidPostedCreditMemo (API 67) — newer than the app's v64 default,
 *        so they are called on the org's newest API version when the org exposes them.
 *   All of these require the "Credit Memo Operations User" permission set (Revenue Management Developer Guide).
 *
 * Nothing is simulated: success is reported only after the records are re-read from Salesforce.
 */

const q = async (client: SalesforceClient, soql: string) => client.queryAll<Record<string, unknown>>(soql);
const idList = (ids: string[]) => ids.map(i => `'${soqlEscape(i)}'`).join(",");
const rel = (row: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), row);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const cents = (n: number) => Math.round(n * 100);
const has = (d: DescribeResult, name: string) => d.fields.some(f => f.name === name);
const picklist = (d: DescribeResult | null, field: string) => d?.fields.find(f => f.name === field)?.picklistValues?.filter(p => p.active).map(p => p.value) ?? [];
const KEY_RE = /^[A-Za-z0-9-]{16,64}$/;
const today = () => new Date().toISOString().slice(0, 10);
const CREDIT_PATH = (invoiceId: string) => `/commerce/invoicing/invoices/${invoiceId}/actions/credit`;
export const TAX_STRATEGIES = ["Ignore", "CopyFromInvoiceLine", "Calculate", "ManualOverride"] as const; // documented values; ManualOverride needs tax lines (not offered)

/* ───────────────────────────── Capabilities ───────────────────────────── */

export interface CreditCapability { id: string; label: string; available: boolean; detail: string }
export interface CreditMemoModel {
  success: true;
  available: boolean;
  objects: { creditMemo: string | null; line: string | null; invoiceApplication: string | null; lineApplication: string | null };
  statusValues: string[];
  reasonValues: string[];
  /** CreditMemo.ReasonCode exists but isn't settable through the credit API — shown only when the org defines values. */
  reasonField: { name: string; createable: boolean } | null;
  taxStrategies: string[];
  latestApiVersion: string;
  capabilities: CreditCapability[];
  permission: { name: string; label: string; assigned: boolean } | null;
  block: { reason: string; at: number } | null;
  currency: string | null;
}

const cache = (globalThis as { __rcbCreditCache?: Map<string, { at: number; value: unknown }> }).__rcbCreditCache ??= new Map();
async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const latestVersion = latestApiVersion; // shared billing-document utility
const at = (client: SalesforceClient, version: string, path: string) => `${client.instanceUrl}/services/data/${version}${path}`;

/** A Connect resource exists when GET answers 405 (POST-only) rather than 404. Read-only. */
async function resourceExists(client: SalesforceClient, url: string): Promise<boolean> {
  return cached(`${client.cacheScope}:res:${url}`, 3_600_000, async () => {
    const res = await client.requestWithDiagnostics(url, { method: "GET" }).catch(() => null);
    return !!res && res.status === 405;
  });
}
async function actionAt(client: SalesforceClient, version: string, name: string): Promise<boolean> {
  return cached(`${client.cacheScope}:act:${version}:${name}`, 3_600_000, async () => {
    const res = await client.requestWithDiagnostics(at(client, version, `/actions/standard/${name}`), { method: "GET" }).catch(() => null);
    return !!res && res.status < 400;
  });
}

async function userId(client: SalesforceClient): Promise<string | null> {
  const res = await client.requestWithDiagnostics(`${client.instanceUrl}/services/oauth2/userinfo`, { method: "GET" }).catch(() => null);
  return (res?.json as { user_id?: string } | null)?.user_id ?? null;
}

/** The org's credit memo permission set (identified from org metadata) and whether this user has it. */
async function creditPermission(client: SalesforceClient): Promise<CreditMemoModel["permission"]> {
  const [ps] = await q(client, "SELECT Id, Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false AND (Label = 'Credit Memo Operations User' OR Name LIKE '%CreditMemoOperations%') LIMIT 1").catch(() => []);
  if (!ps) return null;
  const uid = await userId(client);
  const a = uid ? await q(client, `SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${soqlEscape(uid)}' AND PermissionSetId = '${soqlEscape(ps.Id as string)}' LIMIT 1`).catch(() => []) : [];
  return { name: String(ps.Name), label: String(ps.Label), assigned: a.length > 0 };
}

// Salesforce rejected a credit operation for missing access → block further attempts until the assignment changes.
const blocks = (globalThis as { __rcbCreditBlocks?: Map<string, { reason: string; at: number; assigned: boolean }> }).__rcbCreditBlocks ??= new Map();
const isPermissionError = (msg: string, status?: number) => status === 403 || /permission|insufficient|not currently enabled|not authorized|access/i.test(msg);

export async function getCreditMemoModel(client: SalesforceClient): Promise<CreditMemoModel> {
  const global = new Map((await billingDescribeGlobal(client)).map(g => [g.name, g]));
  const cm = global.has("CreditMemo") ? await billingDescribe(client, "CreditMemo") : null;
  const line = global.has("CreditMemoLine") ? await billingDescribe(client, "CreditMemoLine") : null;
  const version = await latestVersion(client);
  const fake = { cm: "50g000000000000AAA", line: "9yx000000000000AAA", app: "4sF000000000000AAA", inv: "3tt000000000000AAA" };
  const [credit, apply, applyLine, post, voidCm, unapply] = await Promise.all([
    resourceExists(client, at(client, client.apiVersion, CREDIT_PATH(fake.inv))),
    resourceExists(client, at(client, client.apiVersion, `/commerce/invoicing/credit-memos/${fake.cm}/actions/apply`)),
    resourceExists(client, at(client, client.apiVersion, `/commerce/invoicing/credit-memo-lines/${fake.line}/actions/apply`)),
    actionAt(client, version, "postDraftCreditMemo"),
    actionAt(client, version, "voidPostedCreditMemo"),
    hasStandardAction(client, "unapplyCredit"),
  ]);
  const permission = await creditPermission(client);
  const key = `${client.instanceUrl}:${(await userId(client)) ?? "?"}`;
  let block = blocks.get(key) ?? null;
  if (block && permission && block.assigned !== permission.assigned) { blocks.delete(key); block = null; }
  const noAccess = !!block || (permission ? !permission.assigned : false);
  const why = block ? "Salesforce rejected a credit memo operation for your user." : permission && !permission.assigned ? `Requires the "${permission.label}" permission set, which isn't assigned to your user.` : "";
  const cap = (id: string, label: string, exists: boolean, detail: string): CreditCapability =>
    ({ id, label, available: exists && !noAccess, detail: !exists ? "Not available in this Salesforce org." : noAccess ? `Credit Memos are available in Salesforce metadata, but this operation is not currently enabled for this Salesforce org/user. ${why}` : detail });
  const capabilities: CreditCapability[] = [
    { id: "read", label: "Credit Memos (read)", available: !!cm, detail: cm ? "CreditMemo · CreditMemoLine · applications" : "No CreditMemo object in this org." },
    cap("create", "Create Credit Memo from Invoice", credit, "POST /commerce/invoicing/invoices/{id}/actions/credit — creates, posts and applies"),
    { id: "lines", label: "Credit Memo Lines", available: !!line, detail: line ? "CreditMemoLine → InvoiceLine (one per credited line)" : "No CreditMemoLine object." },
    cap("post", "Post Draft Credit Memo", post, `postDraftCreditMemo (API ${version})`),
    cap("apply", "Apply Credit Memo", apply || applyLine, applyLine ? "credit-memos / credit-memo-lines …/actions/apply" : "credit-memos/{id}/actions/apply"),
    cap("unapply", "Unapply Credit", unapply, "unapplyCredit"),
    cap("void", "Void Posted Credit Memo", voidCm, `voidPostedCreditMemo (API ${version})`),
  ];
  const reasonMeta = cm?.fields.find(f => f.name === "ReasonCode") ?? null;
  return {
    success: true,
    available: capabilities.find(c => c.id === "create")!.available,
    objects: { creditMemo: cm ? "CreditMemo" : null, line: line ? "CreditMemoLine" : null, invoiceApplication: global.has("CreditMemoInvApplication") ? "CreditMemoInvApplication" : null, lineApplication: global.has("CreditMemoLineInvoiceLine") ? "CreditMemoLineInvoiceLine" : null },
    statusValues: picklist(cm, "Status"),
    reasonValues: picklist(cm, "ReasonCode"),
    reasonField: reasonMeta ? { name: reasonMeta.name, createable: !!reasonMeta.createable } : null,
    taxStrategies: ["Ignore", "CopyFromInvoiceLine", "Calculate"],
    latestApiVersion: version,
    capabilities, permission, block: block ? { reason: block.reason, at: block.at } : null,
    currency: (await getPaymentModel(client)).currency,
  };
}

/* ───────────────────────────── Read: list / detail ───────────────────────────── */

export interface CreditMemoRow {
  id: string; number: string | null; status: string | null; account: { id: string; name: string } | null;
  invoice: { id: string; number: string | null } | null;
  amount: number | null; applied: number | null; balance: number | null;
  creditDate: string | null; effectiveDate: string | null; createdDate: string | null; sourceAction: string | null; category: string | null;
  description: string | null; salesforceUrl: string;
}

async function cmSelect(client: SalesforceClient): Promise<string> {
  const d = await billingDescribe(client, "CreditMemo");
  const f = ["Id", "DocumentNumber", "CreditMemoNumber", "Status", "BillingAccountId", "ReferenceEntityId", "TotalAmountWithTax", "TotalCreditAmountApplied", "TotalCreditAmountUnapplied", "NetCreditsApplied", "Balance", "CreditDate", "EffectiveDate", "Description", "SourceAction", "Category", "ReasonCode", "CreationMode", "CreatedDate", "LastModifiedDate"].filter(n => has(d, n));
  if (has(d, "BillingAccountId")) f.push("BillingAccount.Name");
  return f.join(", ");
}

async function invoiceNumbers(client: SalesforceClient, ids: string[]): Promise<Map<string, string | null>> {
  if (!ids.length) return new Map();
  const rows = await q(client, `SELECT Id, DocumentNumber FROM Invoice WHERE Id IN (${idList(ids)})`).catch(() => []);
  return new Map(rows.map(r => [r.Id as string, str(r.DocumentNumber)]));
}

/**
 * The Credit Memo's tax-inclusive total: CreditMemo.TotalAmountWithTax ("Total with Tax") only. A missing or non-finite value is null
 * (shown as unavailable) — never CreditMemo.TotalAmount, whose tax treatment on CreditMemo is unverified (no taxed credit memo exists to prove it).
 */
export function creditMemoTotalWithTax(row: Record<string, unknown> | null | undefined): number | null {
  const v = row?.TotalAmountWithTax;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Sums one aggregate column across GROUP BY rows; null when no row carries a number (unavailable — not a zero total). */
export function sumAggregate(rows: Record<string, unknown>[], key: string): number | null {
  return rows.reduce<number | null>((s, r) => (typeof r[key] === "number" && Number.isFinite(r[key]) ? (s ?? 0) + (r[key] as number) : s), null);
}

function cmRow(r: Record<string, unknown>, invoices: Map<string, string | null>, instanceUrl: string): CreditMemoRow {
  const ref = str(r.ReferenceEntityId);
  return {
    id: r.Id as string, number: str(r.DocumentNumber) ?? str(r.CreditMemoNumber), status: str(r.Status),
    account: r.BillingAccountId ? { id: r.BillingAccountId as string, name: String(rel(r, "BillingAccount.Name") ?? r.BillingAccountId) } : null,
    invoice: ref && invoices.has(ref) ? { id: ref, number: invoices.get(ref) ?? null } : null,
    amount: creditMemoTotalWithTax(r), applied: num(r.TotalCreditAmountApplied) ?? num(r.NetCreditsApplied), balance: num(r.Balance),
    creditDate: str(r.CreditDate), effectiveDate: str(r.EffectiveDate), createdDate: str(r.CreatedDate), sourceAction: str(r.SourceAction), category: str(r.Category),
    description: str(r.Description), salesforceUrl: buildSalesforceRecordUrl(instanceUrl, "CreditMemo", r.Id as string),
  };
}

const SORTS: Record<string, string> = { number: "DocumentNumber", status: "Status", amount: "TotalAmountWithTax", date: "CreditDate", created: "CreatedDate", account: "BillingAccount.Name" };

export async function listCreditMemos(client: SalesforceClient, opts: { search?: string | null; status?: string | null; accountId?: string | null; invoiceId?: string | null; from?: string | null; to?: string | null; sort?: string | null; dir?: string | null; page?: number; pageSize?: number }) {
  const m = await getCreditMemoModel(client);
  if (!m.objects.creditMemo) throw new NotFoundError("This org has no CreditMemo object.");
  const where: string[] = [];
  const term = (opts.search ?? "").trim();
  if (term) where.push(`(DocumentNumber LIKE '%${soqlEscape(term)}%' OR BillingAccount.Name LIKE '%${soqlEscape(term)}%' OR Description LIKE '%${soqlEscape(term)}%')`);
  if (opts.status) { if (!m.statusValues.includes(opts.status)) throw new BadInputError(`Unknown Credit Memo status "${opts.status}".`); where.push(`Status = '${soqlEscape(opts.status)}'`); }
  if (opts.accountId) { if (!SALESFORCE_ID.test(opts.accountId)) throw new BadInputError("Invalid Account Id."); where.push(`BillingAccountId = '${soqlEscape(opts.accountId)}'`); }
  if (opts.invoiceId) { if (!SALESFORCE_ID.test(opts.invoiceId)) throw new BadInputError("Invalid Invoice Id."); where.push(`ReferenceEntityId = '${soqlEscape(opts.invoiceId)}'`); }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (opts.from) { if (!day.test(opts.from)) throw new BadInputError("Invalid from date."); where.push(`CreatedDate >= ${opts.from}T00:00:00Z`); }
  if (opts.to) { if (!day.test(opts.to)) throw new BadInputError("Invalid to date."); where.push(`CreatedDate <= ${opts.to}T23:59:59Z`); }
  const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const pageSize = Math.min(Math.max(opts.pageSize ?? 20, 5), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const [rows, agg] = await Promise.all([
    client.query<Record<string, unknown>>(`SELECT ${await cmSelect(client)} FROM CreditMemo${w} ORDER BY ${SORTS[opts.sort ?? ""] ?? "CreatedDate"} ${opts.dir === "asc" ? "ASC" : "DESC"} NULLS LAST, Id LIMIT ${pageSize} OFFSET ${Math.min((page - 1) * pageSize, 2000)}`),
    q(client, `SELECT Status, COUNT(Id) c, SUM(TotalAmountWithTax) amt, SUM(TotalCreditAmountApplied) app, SUM(Balance) bal FROM CreditMemo${w} GROUP BY Status`),
  ]);
  const inv = await invoiceNumbers(client, [...new Set(rows.records.map(r => str(r.ReferenceEntityId)).filter((x): x is string => !!x))]);
  const live = agg.filter(r => !/cancel|void/i.test(String(r.Status ?? "")));
  return {
    success: true as const,
    creditMemos: rows.records.map(r => cmRow(r, inv, client.instanceUrl)),
    totalSize: agg.reduce((s, r) => s + (num(r.c) ?? 0), 0), page, pageSize,
    stats: { amount: sumAggregate(live, "amt"), applied: sumAggregate(live, "app"), balance: sumAggregate(live, "bal"), byStatus: agg.map(r => ({ status: String(r.Status ?? "—"), count: num(r.c) ?? 0, amount: num(r.amt) })) },
    statusValues: m.statusValues, currency: m.currency,
  };
}

export interface CreditMemoDetail {
  success: true;
  creditMemo: CreditMemoRow & { reasonCode: string | null; creationMode: string | null };
  lines: { id: string; name: string | null; type: string | null; product: string | null; chargeAmount: number | null; lineAmount: number | null; balance: number | null; invoiceLine: { id: string; name: string | null } | null }[];
  applications: { id: string; number: string | null; level: "invoice" | "line"; type: string | null; amount: number | null; unapplied: string | null; date: string | null; invoice: { id: string; number: string | null } | null; invoiceLine: { id: string; name: string | null } | null; creditMemoLine: string | null }[];
  invoice: PaymentInvoice | null;
  order: { id: string; number: string | null; scheduleIds: string[] } | null;
  fields: { name: string; label: string; value: unknown }[];
}

export async function getCreditMemoDetail(client: SalesforceClient, id: string): Promise<CreditMemoDetail> {
  if (!SALESFORCE_ID.test(id)) throw new NotFoundError("Invalid Credit Memo Id.");
  const d = await billingDescribe(client, "CreditMemo");
  const [r] = await q(client, `SELECT ${await cmSelect(client)} FROM CreditMemo WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
  if (!r) throw new NotFoundError("Credit Memo not found in Salesforce (or not visible to your user).");
  const [lineRows, invApps, lineApps] = await Promise.all([
    q(client, `SELECT Id, Name, Type, Product2.Name, ChargeAmount, LineAmount, Balance, ReferenceEntityItemId FROM CreditMemoLine WHERE CreditMemoId = '${soqlEscape(id)}' ORDER BY CreatedDate`).catch(() => []),
    q(client, `SELECT Id, CreditMemoInvoiceNumber, Type, Amount, HasBeenUnapplied, AppliedDate, InvoiceId, Invoice.DocumentNumber FROM CreditMemoInvApplication WHERE CreditMemoId = '${soqlEscape(id)}' ORDER BY CreatedDate`).catch(() => []),
    q(client, `SELECT Id, CreditMemoLineInvoiceLineNumber, Type, Amount, UnappliedStatus, AppliedDateTime, CreditMemoLine.Name, InvoiceLineId, InvoiceLine.Name, InvoiceLine.InvoiceId, InvoiceLine.Invoice.DocumentNumber FROM CreditMemoLineInvoiceLine WHERE CreditMemoLine.CreditMemoId = '${soqlEscape(id)}' ORDER BY CreatedDate`).catch(() => []),
  ]);
  const refIds = lineRows.map(l => str(l.ReferenceEntityItemId)).filter((x): x is string => !!x);
  const invLines = refIds.length ? await q(client, `SELECT Id, Name, InvoiceId FROM InvoiceLine WHERE Id IN (${idList(refIds)})`).catch(() => []) : [];
  const invLineMap = new Map(invLines.map(l => [l.Id as string, { id: l.Id as string, name: str(l.Name), invoiceId: l.InvoiceId as string }]));
  const ref = str(r.ReferenceEntityId);
  const invoiceId = (ref && (await invoiceNumbers(client, [ref])).has(ref)) ? ref : invLines[0]?.InvoiceId as string | undefined ?? str(invApps[0]?.InvoiceId) ?? null;
  const invoice = invoiceId ? await loadInvoiceForPayment(client, invoiceId).catch(() => null) : null;
  const ctx = invoiceId ? await findOrderContext(client, { invoiceId }).catch(() => null) : null;
  const labels = new Map(d.fields.map(f => [f.name, f.label]));
  const row = cmRow(r, new Map(invoice ? [[invoice.id, invoice.number]] : []), client.instanceUrl);
  return {
    success: true,
    creditMemo: { ...row, invoice: invoice ? { id: invoice.id, number: invoice.number } : row.invoice, reasonCode: str(r.ReasonCode), creationMode: str(r.CreationMode) },
    lines: lineRows.map(l => ({ id: l.Id as string, name: str(l.Name), type: str(l.Type), product: str(rel(l, "Product2.Name")), chargeAmount: num(l.ChargeAmount), lineAmount: num(l.LineAmount), balance: num(l.Balance), invoiceLine: invLineMap.get(str(l.ReferenceEntityItemId) ?? "") ?? null })),
    applications: [
      ...invApps.map(a => ({ id: a.Id as string, number: str(a.CreditMemoInvoiceNumber), level: "invoice" as const, type: str(a.Type), amount: num(a.Amount), unapplied: str(a.HasBeenUnapplied), date: str(a.AppliedDate), invoice: a.InvoiceId ? { id: a.InvoiceId as string, number: str(rel(a, "Invoice.DocumentNumber")) } : null, invoiceLine: null, creditMemoLine: null })),
      ...lineApps.map(a => ({ id: a.Id as string, number: str(a.CreditMemoLineInvoiceLineNumber), level: "line" as const, type: str(a.Type), amount: num(a.Amount), unapplied: str(a.UnappliedStatus), date: str(a.AppliedDateTime), invoice: rel(a, "InvoiceLine.InvoiceId") ? { id: rel(a, "InvoiceLine.InvoiceId") as string, number: str(rel(a, "InvoiceLine.Invoice.DocumentNumber")) } : null, invoiceLine: a.InvoiceLineId ? { id: a.InvoiceLineId as string, name: str(rel(a, "InvoiceLine.Name")) } : null, creditMemoLine: str(rel(a, "CreditMemoLine.Name")) })),
    ],
    invoice,
    order: ctx?.orderId ? { id: ctx.orderId, number: ctx.orderNumber, scheduleIds: ctx.scheduleIds } : null,
    fields: Object.entries(r).filter(([k, v]) => k !== "attributes" && (v === null || typeof v !== "object")).map(([k, v]) => ({ name: k, label: labels.get(k) ?? k, value: v })),
  };
}

/* ───────────────────────────── Validate / create ───────────────────────────── */

export interface CreditInput {
  invoiceId: string;
  amount: number;
  allocation?: { lineId: string; amount: number }[] | null;
  taxStrategy?: string | null;
  effectiveDate?: string | null;
  description?: string | null;
  invoiceToken?: string | null;
  idempotencyKey?: string | null;
}
export interface CreditCheck { id: string; label: string; status: "passed" | "failed" | "warning"; detail: string }
export interface CreditPreview {
  success: true; valid: boolean; invoice: PaymentInvoice; checks: CreditCheck[]; errors: string[]; warnings: string[];
  preview: {
    amount: number; allocation: { id: string; label: string; amount: number; allowable: number }[];
    lines: { id: string; label: string; amount: number; credited: number; allowable: number; allocated: number }[];
    balanceBefore: number | null; expectedBalance: number | null; taxStrategy: string; effectiveDate: string; description: string | null;
    statusAfter: string | null;
  } | null;
}

/** Per line, Salesforce allows crediting up to the line amount (less credits already applied to it). */
const allowableFor = (l: PaymentInvoice["lines"][number]) => Math.max(0, Math.round(((l.amount ?? 0) - (l.creditsApplied ?? 0)) * 100) / 100);

function resolveCreditAllocation(invoice: PaymentInvoice, amount: number, manual?: { lineId: string; amount: number }[] | null): { targets: { id: string; label: string; amount: number; allowable: number }[]; error: string | null } {
  if (!invoice.lines.length) return { targets: [], error: "The invoice has no invoice lines to credit." };
  const label = (l: PaymentInvoice["lines"][number]) => l.product ?? l.name ?? "Invoice line";
  if (!manual?.length) {
    // Auto: largest allowable line first (Salesforce applies credits from the highest amount when the level is Invoice Line).
    let left = cents(amount);
    const targets: { id: string; label: string; amount: number; allowable: number }[] = [];
    for (const l of [...invoice.lines].sort((a, b) => allowableFor(b) - allowableFor(a))) {
      if (left <= 0) break;
      const take = Math.min(cents(allowableFor(l)), left);
      if (take > 0) { targets.push({ id: l.id, label: label(l), amount: take / 100, allowable: allowableFor(l) }); left -= take; }
    }
    return { targets, error: left > 0 ? `The invoice lines can be credited by at most ${invoice.lines.reduce((s, l) => s + allowableFor(l), 0).toFixed(2)} in total.` : null };
  }
  const seen = new Set<string>();
  const targets: { id: string; label: string; amount: number; allowable: number }[] = [];
  for (const a of manual) {
    const l = invoice.lines.find(x => x.id === a.lineId || x.id.slice(0, 15) === String(a.lineId).slice(0, 15));
    if (!l) return { targets: [], error: "An allocation refers to a line that isn't on this invoice." };
    if (seen.has(l.id)) return { targets: [], error: `${label(l)} is allocated twice.` };
    seen.add(l.id);
    const v = typeof a.amount === "number" && Number.isFinite(a.amount) ? Math.round(a.amount * 100) / 100 : NaN;
    if (!Number.isFinite(v) || v < 0) return { targets: [], error: `Allocation for ${label(l)} must be a number of 0 or more.` };
    if (cents(v) > cents(allowableFor(l))) return { targets: [], error: `Allocation for ${label(l)} (${v}) exceeds what can be credited on that line (${allowableFor(l)}).` };
    if (v > 0) targets.push({ id: l.id, label: label(l), amount: v, allowable: allowableFor(l) });
  }
  if (targets.reduce((s, t) => s + cents(t.amount), 0) !== cents(amount)) return { targets, error: "Credit Memo allocation does not equal the credit amount." };
  return { targets, error: null };
}

export async function validateCredit(client: SalesforceClient, input: CreditInput, model?: CreditMemoModel): Promise<CreditPreview> {
  const m = model ?? await getCreditMemoModel(client);
  const invoice = await loadInvoiceForPayment(client, input.invoiceId);
  const checks: CreditCheck[] = [];
  const add = (id: string, label: string, ok: boolean | "warning", detail: string) => checks.push({ id, label, status: ok === true ? "passed" : ok === "warning" ? "warning" : "failed", detail });
  const warnings: string[] = [];
  const create = m.capabilities.find(c => c.id === "create")!;
  add("permission", "Credit Memo creation available for your user", create.available, create.available ? create.detail : "Credit Memo creation is not currently available for this Salesforce user.");
  add("posted", "Invoice is Posted", /^posted$/i.test(invoice.status ?? ""), /^posted$/i.test(invoice.status ?? "") ? `${invoice.number} · Posted` : `Salesforce credits only Posted invoices (this one is "${invoice.status ?? "—"}").`);
  const amount = typeof input.amount === "number" && Number.isFinite(input.amount) ? Math.round(input.amount * 100) / 100 : NaN;
  const amountOk = Number.isFinite(amount) && amount > 0;
  add("amount", "Credit amount greater than zero", amountOk, amountOk ? String(amount) : "Enter a credit amount greater than zero.");
  const alloc = amountOk ? resolveCreditAllocation(invoice, amount, input.allocation) : { targets: [], error: null };
  if (amountOk) add("allocation", "Allocation to invoice lines", !alloc.error, alloc.error ?? alloc.targets.map(t => `${t.label}: ${t.amount}`).join(" · "));
  if (amountOk && invoice.balance !== null && cents(amount) > cents(invoice.balance)) warnings.push(`The credit (${amount}) is more than the invoice's outstanding balance (${invoice.balance}); Salesforce decides whether that is allowed for this invoice.`);
  const tax = input.taxStrategy ?? "Ignore";
  add("tax", "Tax strategy", m.taxStrategies.includes(tax), m.taxStrategies.includes(tax) ? tax : `Choose one of: ${m.taxStrategies.join(", ")}.`);
  const eff = input.effectiveDate?.trim() || today();
  const effOk = /^\d{4}-\d{2}-\d{2}$/.test(eff) && !Number.isNaN(Date.parse(eff));
  add("date", "Effective date", effOk, effOk ? eff : "Use a valid date (YYYY-MM-DD).");
  if (input.description && input.description.length > 200) add("description", "Description", false, "Keep the description to 200 characters.");
  const errors = checks.filter(c => c.status === "failed").map(c => c.detail);
  return {
    success: true, valid: errors.length === 0, invoice, checks, errors, warnings,
    preview: amountOk ? {
      amount, allocation: alloc.targets,
      lines: invoice.lines.map(l => ({ id: l.id, label: l.product ?? l.name ?? "Invoice line", amount: l.amount ?? 0, credited: l.creditsApplied ?? 0, allowable: allowableFor(l), allocated: alloc.targets.find(t => t.id === l.id)?.amount ?? 0 })),
      balanceBefore: invoice.balance, expectedBalance: invoice.balance === null ? null : Math.round((invoice.balance - amount) * 100) / 100,
      taxStrategy: tax, effectiveDate: eff, description: input.description?.trim() || null,
      statusAfter: m.statusValues.find(s => /^posted$/i.test(s)) ?? null, // the credit API "creates and posts" the credit memo
    } : null,
  };
}

export type CreditOutcome =
  | { ok: true; status: 200 | 201 | 202; duplicate: boolean; state: "created" | "processing"; message: string; creditMemo: CreditMemoDetail | null; invoice: PaymentInvoice; requestIdentifier: string | null; steps: string[] }
  | { ok: false; status: number; code: string; error: string; possibleCause?: string | null; invoice?: PaymentInvoice; preview?: CreditPreview; technical?: unknown };

const pending = (globalThis as { __rcbCreditPending?: Map<string, { invoiceId: string; requestIdentifier: string | null; at: number }> }).__rcbCreditPending ??= new Map();
const inflight = (globalThis as { __rcbCreditInflight?: Map<string, Promise<CreditOutcome>> }).__rcbCreditInflight ??= new Map();
const refTag = (key: string) => `[ref:${key}]`;

async function findCreditByKey(client: SalesforceClient, key: string): Promise<string | null> {
  const [row] = await q(client, `SELECT Id FROM CreditMemo WHERE Description LIKE '%${soqlEscape(refTag(key))}%' ORDER BY CreatedDate DESC LIMIT 1`).catch(() => []);
  return (row?.Id as string) ?? null;
}

/** Create (and, per Salesforce's credit API, post + apply) a credit memo for invoice lines. Idempotent per key. */
export function createCreditMemo(client: SalesforceClient, input: CreditInput): Promise<CreditOutcome> {
  const key = input.idempotencyKey ?? "";
  if (!KEY_RE.test(key)) return Promise.resolve({ ok: false, status: 400, code: "INVALID_REQUEST", error: "A credit memo request key is required (refresh the form)." });
  const lock = `${client.instanceUrl}:${key}`;
  const running = inflight.get(lock);
  if (running) return running.then((o: CreditOutcome): CreditOutcome => (o.ok ? { ...o, duplicate: true, status: 200 } : o));
  const p = doCreate(client, input, key).finally(() => inflight.delete(lock));
  inflight.set(lock, p);
  return p;
}

async function doCreate(client: SalesforceClient, input: CreditInput, key: string): Promise<CreditOutcome> {
  const lock = `${client.instanceUrl}:${key}`;
  // 1. Same request already created or submitted → return it, never a second credit memo.
  const existing = await findCreditByKey(client, key);
  if (existing) {
    const detail = await getCreditMemoDetail(client, existing);
    return { ok: true, status: 200, duplicate: true, state: "created", message: `Credit memo ${detail.creditMemo.number} already exists for this request.`, creditMemo: detail, invoice: detail.invoice ?? await loadInvoiceForPayment(client, input.invoiceId), requestIdentifier: null, steps: [] };
  }
  const prior = pending.get(lock);
  if (prior) return { ok: true, status: 202, duplicate: true, state: "processing", message: "This credit memo request was already submitted — Salesforce is still processing it. Refresh in a moment.", creditMemo: null, invoice: await loadInvoiceForPayment(client, input.invoiceId), requestIdentifier: prior.requestIdentifier, steps: [] };

  // 2. Re-read and re-validate everything server-side; reject stale state.
  const m = await getCreditMemoModel(client);
  const preview = await validateCredit(client, input, m);
  if (input.invoiceToken && input.invoiceToken !== preview.invoice.token) {
    return { ok: false, status: 409, code: "INVOICE_CHANGED", error: "The invoice changed while you were preparing this credit memo. Refresh and review the current balance.", invoice: preview.invoice, preview };
  }
  const create = m.capabilities.find(c => c.id === "create")!;
  if (!create.available) return { ok: false, status: 403, code: "CREDIT_NOT_ENABLED", error: "Credit Memo creation is not currently available for this Salesforce user. Nothing was created.", possibleCause: m.permission && !m.permission.assigned ? `Ask a Salesforce administrator to assign the "${m.permission.label}" permission set (${m.permission.name}).` : null, invoice: preview.invoice, preview };
  if (!preview.valid || !preview.preview) return { ok: false, status: 400, code: "INVALID_CREDIT", error: preview.errors.join(" "), invoice: preview.invoice, preview };

  // 3. Salesforce's credit API (one request; creates + posts + applies).
  const p = preview.preview;
  const cmDescribe = await billingDescribe(client, "CreditMemo");
  const maxLen = cmDescribe.fields.find(f => f.name === "Description")?.length ?? 255;
  const tag = refTag(key);
  const description = `${(p.description ?? "Credit issued from Revenue Cloud Billing").slice(0, Math.max(0, maxLen - tag.length - 1))} ${tag}`;
  const body = { taxStrategy: p.taxStrategy, effectiveDate: p.effectiveDate, description, invoiceLines: p.allocation.map(a => ({ invoiceLineId: a.id, amountToCredit: a.amount })) };
  const res = await client.requestWithDiagnostics(CREDIT_PATH(preview.invoice.id), { method: "POST", body: JSON.stringify(body) });
  const json = res.json as { success?: boolean; requestIdentifier?: string; statusURL?: string; message?: string; output?: { errors?: { message?: string; errorCode?: string }[]; referenceLineErrorResults?: { referenceLineId?: string; errors?: { message?: string; errorCode?: string }[] }[]; success?: boolean; requestIdentifier?: string } } | { message?: string; errorCode?: string }[] | null;
  const out = json && !Array.isArray(json) ? (json.output ?? json) : null;
  const errs = Array.isArray(json) ? json : [
    ...((out as { errors?: { message?: string; errorCode?: string }[] } | null)?.errors ?? []),
    ...((out as { referenceLineErrorResults?: { errors?: { message?: string; errorCode?: string }[] }[] } | null)?.referenceLineErrorResults ?? []).flatMap(r => r.errors ?? []),
  ];
  const success = res.status < 400 && (out as { success?: boolean } | null)?.success !== false && errs.length === 0;
  if (!success) {
    const msg = errs.map(e => e.message).filter(Boolean).join("; ") || (json && !Array.isArray(json) ? json.message : null) || res.statusText;
    const decoded = String(msg).replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    if (isPermissionError(decoded, res.status)) blocks.set(`${client.instanceUrl}:${(await userId(client)) ?? "?"}`, { reason: decoded, at: Date.now(), assigned: !!m.permission?.assigned });
    return { ok: false, status: res.status === 403 || isPermissionError(decoded, res.status) ? 403 : 422, code: (errs[0] as { errorCode?: string } | undefined)?.errorCode ?? "CREDIT_FAILED", error: `Salesforce didn't create the credit memo: ${decoded}`, possibleCause: isPermissionError(decoded, res.status) && m.permission ? `Ask a Salesforce administrator to assign the "${m.permission.label}" permission set (${m.permission.name}).` : null, invoice: await loadInvoiceForPayment(client, preview.invoice.id), technical: { request: body, response: res.json ?? res.rawText } };
  }
  const requestIdentifier = str((out as { requestIdentifier?: string } | null)?.requestIdentifier);
  pending.set(lock, { invoiceId: preview.invoice.id, requestIdentifier, at: Date.now() });

  // 4. Asynchronous in Salesforce: wait briefly for the credit memo to appear, then re-read everything.
  let createdId: string | null = null;
  for (let i = 0; i < 8 && !createdId; i++) { await new Promise(r => setTimeout(r, 1500)); createdId = await findCreditByKey(client, key); }
  const invoice = await loadInvoiceForPayment(client, preview.invoice.id);
  if (!createdId) return { ok: true, status: 202, duplicate: false, state: "processing", message: "Salesforce accepted the credit memo request and is processing it. Refresh in a moment to see the credit memo and the updated invoice balance.", creditMemo: null, invoice, requestIdentifier, steps: [`Credit request accepted (${requestIdentifier ?? "no request id"})`] };
  pending.delete(lock);
  const detail = await getCreditMemoDetail(client, createdId);
  return { ok: true, status: 201, duplicate: false, state: "created", message: `Credit memo ${detail.creditMemo.number} created in Salesforce (${detail.creditMemo.status}).`, creditMemo: detail, invoice, requestIdentifier, steps: [`Credit request accepted (${requestIdentifier ?? "—"})`, `Credit memo ${detail.creditMemo.number} found`] };
}

/** Look up the result of a submitted request (processing → created) — read-only. */
export async function creditRequestStatus(client: SalesforceClient, key: string, invoiceId: string): Promise<CreditOutcome> {
  if (!KEY_RE.test(key)) throw new BadInputError("Invalid request key.");
  const id = await findCreditByKey(client, key);
  const invoice = await loadInvoiceForPayment(client, invoiceId);
  if (!id) return { ok: true, status: 202, duplicate: false, state: "processing", message: "Salesforce is still processing this credit memo request.", creditMemo: null, invoice, requestIdentifier: pending.get(`${client.instanceUrl}:${key}`)?.requestIdentifier ?? null, steps: [] };
  pending.delete(`${client.instanceUrl}:${key}`);
  const detail = await getCreditMemoDetail(client, id);
  return { ok: true, status: 200, duplicate: false, state: "created", message: `Credit memo ${detail.creditMemo.number} (${detail.creditMemo.status}).`, creditMemo: detail, invoice, requestIdentifier: null, steps: [] };
}

/* ───────────────────────────── Lifecycle: post / apply / void ───────────────────────────── */

export type LifecycleOutcome = { ok: true; status: 200 | 202; message: string; creditMemo: CreditMemoDetail } | { ok: false; status: number; code: string; error: string; creditMemo?: CreditMemoDetail; technical?: unknown; possibleCause?: string | null };

async function lifecycleGuard(client: SalesforceClient, id: string, capId: string, token: string | null | undefined): Promise<{ m: CreditMemoModel; detail: CreditMemoDetail } | LifecycleOutcome> {
  const m = await getCreditMemoModel(client);
  const detail = await getCreditMemoDetail(client, id);
  const capability = m.capabilities.find(c => c.id === capId)!;
  if (!capability.available) return { ok: false, status: 403, code: "NOT_ENABLED", error: `${capability.label}: ${capability.detail}`, creditMemo: detail, possibleCause: m.permission && !m.permission.assigned ? `Ask a Salesforce administrator to assign the "${m.permission.label}" permission set (${m.permission.name}).` : null };
  if (token && token !== stateToken(detail)) return { ok: false, status: 409, code: "CREDIT_MEMO_CHANGED", error: "The credit memo changed in Salesforce since you loaded it. Refresh and review it.", creditMemo: detail };
  return { m, detail };
}
export const stateToken = (d: CreditMemoDetail) => `${d.creditMemo.status}|${d.creditMemo.balance}|${d.creditMemo.applied}|${d.applications.length}`;

async function runAction(client: SalesforceClient, version: string, name: string, inputs: Record<string, unknown>[]) {
  const res = await client.requestWithDiagnostics(at(client, version, `/actions/standard/${name}`), { method: "POST", body: JSON.stringify({ inputs }) });
  const out = (Array.isArray(res.json) ? res.json[0] : null) as { isSuccess?: boolean; errors?: { message?: string; statusCode?: string }[] | null } | null;
  return { ok: res.status < 400 && !!out?.isSuccess, error: (out?.errors ?? []).map(e => e.message).filter(Boolean).join("; ") || res.statusText, code: out?.errors?.[0]?.statusCode ?? "ACTION_FAILED", technical: res.json ?? res.rawText, httpStatus: res.status };
}

export async function postCreditMemo(client: SalesforceClient, id: string, token?: string | null): Promise<LifecycleOutcome> {
  const g = await lifecycleGuard(client, id, "post", token);
  if ("ok" in g) return g;
  if (!/^draft$/i.test(g.detail.creditMemo.status ?? "")) return { ok: false, status: 422, code: "NOT_DRAFT", error: `Only Draft credit memos can be posted (this one is ${g.detail.creditMemo.status}).`, creditMemo: g.detail };
  const r = await runAction(client, g.m.latestApiVersion, "postDraftCreditMemo", [{ creditMemoId: id }]);
  if (!r.ok) return { ok: false, status: isPermissionError(r.error, r.httpStatus) ? 403 : 422, code: r.code, error: `Salesforce didn't post the credit memo: ${r.error}`, creditMemo: g.detail, technical: r.technical };
  return { ok: true, status: 202, message: "Posting requested — Salesforce posts the credit memo asynchronously. Refresh to see its status.", creditMemo: await getCreditMemoDetail(client, id) };
}

export async function voidCreditMemo(client: SalesforceClient, id: string, token?: string | null): Promise<LifecycleOutcome> {
  const g = await lifecycleGuard(client, id, "void", token);
  if ("ok" in g) return g;
  if (!/^posted$/i.test(g.detail.creditMemo.status ?? "")) return { ok: false, status: 422, code: "NOT_POSTED", error: `Only Posted credit memos can be voided (this one is ${g.detail.creditMemo.status}).`, creditMemo: g.detail };
  const r = await runAction(client, g.m.latestApiVersion, "voidPostedCreditMemo", [{ creditMemoId: id }]);
  if (!r.ok) return { ok: false, status: isPermissionError(r.error, r.httpStatus) ? 403 : 422, code: r.code, error: `Salesforce didn't void the credit memo: ${r.error}`, creditMemo: g.detail, technical: r.technical };
  return { ok: true, status: 202, message: "Void requested — Salesforce voids the credit memo asynchronously. Refresh to see its status.", creditMemo: await getCreditMemoDetail(client, id) };
}

/** Apply a posted credit memo's remaining balance to an invoice — per credit memo line → invoice line when its lines reference invoice lines. */
export async function applyCreditMemo(client: SalesforceClient, id: string, input: { invoiceId: string; amount: number; invoiceToken?: string | null; token?: string | null }): Promise<LifecycleOutcome & { invoice?: PaymentInvoice }> {
  const g = await lifecycleGuard(client, id, "apply", input.token);
  if ("ok" in g) return g;
  const invoice = await loadInvoiceForPayment(client, input.invoiceId);
  if (input.invoiceToken && input.invoiceToken !== invoice.token) return { ok: false, status: 409, code: "INVOICE_CHANGED", error: "The invoice changed while you were preparing this credit. Refresh and review the current balance.", creditMemo: g.detail };
  const cm = g.detail.creditMemo;
  if (!/^posted$/i.test(cm.status ?? "")) return { ok: false, status: 422, code: "NOT_POSTED", error: `Only Posted credit memos can be applied (this one is ${cm.status}).`, creditMemo: g.detail };
  if (!/^posted$/i.test(invoice.status ?? "")) return { ok: false, status: 422, code: "INVOICE_NOT_POSTED", error: `The invoice must be Posted (it is ${invoice.status}).`, creditMemo: g.detail };
  if (cm.account && invoice.account && cm.account.id !== invoice.account.id) return { ok: false, status: 400, code: "ACCOUNT_MISMATCH", error: "The credit memo and the invoice belong to different accounts.", creditMemo: g.detail };
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!(amount > 0)) return { ok: false, status: 400, code: "INVALID_AMOUNT", error: "Enter an amount greater than zero.", creditMemo: g.detail };
  if (cents(amount) > cents(cm.balance ?? 0)) return { ok: false, status: 400, code: "EXCEEDS_CREDIT", error: `The amount exceeds the credit memo's remaining balance (${cm.balance ?? 0}).`, creditMemo: g.detail };
  if (cents(amount) > cents(invoice.balance ?? 0)) return { ok: false, status: 400, code: "EXCEEDS_INVOICE", error: `The amount exceeds the invoice's outstanding balance (${invoice.balance ?? 0}).`, creditMemo: g.detail };
  const res = await client.requestWithDiagnostics(`/commerce/invoicing/credit-memos/${id}/actions/apply`, { method: "POST", body: JSON.stringify({ applications: [{ appliedToId: invoice.id, amount }] }) });
  const json = res.json as { success?: boolean; errors?: { message?: string }[] } | { message?: string; errorCode?: string }[] | null;
  const errs = Array.isArray(json) ? json : json?.success === false ? json.errors ?? [] : [];
  if (res.status >= 400 || errs.length) {
    const msg = errs.map(e => e.message).filter(Boolean).join("; ") || res.statusText;
    return { ok: false, status: isPermissionError(msg, res.status) ? 403 : 422, code: (errs[0] as { errorCode?: string } | undefined)?.errorCode ?? "APPLY_FAILED", error: `Salesforce didn't apply the credit memo: ${msg}`, creditMemo: g.detail, technical: res.json ?? res.rawText };
  }
  const after = await getCreditMemoDetail(client, id);
  return { ok: true, status: after.applications.length > g.detail.applications.length ? 200 : 202, message: after.applications.length > g.detail.applications.length ? `Applied ${amount} of ${cm.number} to ${invoice.number}.` : "Salesforce accepted the application and is processing it. Refresh to see the result.", creditMemo: after, invoice: await loadInvoiceForPayment(client, invoice.id) };
}

/* ───────────────────────────── AI interpretation (no mutations) ───────────────────────────── */

export const CREDIT_AI_SYSTEM = `You extract a credit memo instruction for Salesforce Revenue Cloud Billing.
Return ONLY a JSON object: {"invoiceNumber": string|null, "amount": number|null, "lineSelection": string|null, "fullLine": boolean, "reason": string|null, "notes": string[]}.
- invoiceNumber exactly as written (e.g. "DOC-000000001"). lineSelection: the product/line NAME the user wants credited, or null.
- fullLine: true when the user asks to credit the full amount of the named line. amount: plain number or null.
- reason: the user's words for why, or null. Never output Salesforce Ids, line Ids or allocations. Anything else goes into "notes".`;

export async function analyzeCreditPrompt(client: SalesforceClient, extract: (system: string, prompt: string) => Promise<Record<string, unknown>>, prompt: string) {
  const out = await extract(CREDIT_AI_SYSTEM, `Today is ${today()}.\nUser instruction: ${prompt}`);
  const warnings: string[] = Array.isArray(out.notes) ? out.notes.filter((n): n is string => typeof n === "string" && !!n.trim()) : [];
  if (out.allocation !== undefined || out.invoiceLineId !== undefined || out.invoiceLineIds !== undefined) warnings.push("Ignored line Ids/allocations from the AI — lines are matched by name against the invoice's real Salesforce lines.");
  const invoiceNumber = str(out.invoiceNumber)?.trim() || null;
  let invoice: PaymentInvoice | null = null;
  let invoiceMessage: string | null = null;
  if (!invoiceNumber) invoiceMessage = "No invoice number was found in the instruction — choose the invoice.";
  else if (SALESFORCE_ID.test(invoiceNumber) && !/-/.test(invoiceNumber)) invoiceMessage = `"${invoiceNumber}" looks like a record Id — refer to the invoice by its number.`;
  else {
    const rows = await q(client, `SELECT Id FROM Invoice WHERE DocumentNumber = '${soqlEscape(invoiceNumber)}' LIMIT 2`);
    if (rows.length === 1) invoice = await loadInvoiceForPayment(client, rows[0].Id as string);
    else invoiceMessage = rows.length ? `"${invoiceNumber}" matches more than one invoice.` : `Invoice "${invoiceNumber}" was not found in Salesforce.`;
  }
  let amount = typeof out.amount === "number" && Number.isFinite(out.amount) ? Math.round(out.amount * 100) / 100 : typeof out.amount === "string" && out.amount.trim() && !Number.isNaN(Number(out.amount)) ? Math.round(Number(out.amount) * 100) / 100 : null;
  const lineSelection = str(out.lineSelection)?.trim() || null;
  let line: { id: string; name: string } | null = null;
  if (lineSelection && invoice) {
    const want = lineSelection.toLowerCase();
    const hits = invoice.lines.filter(l => [l.product, l.name].some(v => (v ?? "").toLowerCase() === want) || [l.product, l.name].some(v => (v ?? "").toLowerCase().includes(want)));
    if (hits.length === 1) {
      line = { id: hits[0].id, name: hits[0].product ?? hits[0].name ?? "Invoice line" };
      if (out.fullLine === true && amount === null) amount = allowableFor(hits[0]);
    } else warnings.push(hits.length ? `"${lineSelection}" matches ${hits.length} invoice lines — choose the line.` : `No line named "${lineSelection}" on ${invoice.number}.`);
  }
  return { success: true as const, extraction: { invoiceNumber, amount: typeof out.amount === "number" ? out.amount : null, lineSelection, fullLine: out.fullLine === true, reason: str(out.reason) }, invoice, invoiceMessage, amount, line, reason: str(out.reason)?.trim() || null, warnings };
}
