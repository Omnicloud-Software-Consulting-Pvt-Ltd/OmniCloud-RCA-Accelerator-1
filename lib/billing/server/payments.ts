import { createHash } from "node:crypto";
import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { buildSalesforceRecordUrl } from "@/lib/salesforce/recordUrl";
import type { DescribeResult } from "@/lib/salesforce/client";
import { billingDescribe, billingDescribeGlobal } from "@/lib/billing/server/discovery";
import { invoiceTotalWithTax } from "@/lib/tax/server/invoiceTax";
import { SALESFORCE_ID } from "@/lib/billing/server/lookup";
import { summarizeSalesforceErrors, type SalesforceErrorItem } from "@/lib/billing/server/errors";
import { findOrderContext, hasStandardAction } from "@/lib/billing/server/orderBilling";
import { activeApplications, appliedByPayment } from "@/lib/billing/paymentApplications";
import { orgCurrency } from "@/lib/billing/server/billingDocuments";

export { appliedByPayment };

/**
 * REVENUE CLOUD BILLING — PAYMENTS service: the single backend for the Payments dashboard, Payment
 * details, Record Payment (manual and AI) and Invoice → Record Payment. Everything is discovered
 * from the connected org (Describe + /actions/standard) and read from / written to Salesforce:
 *
 *   Payment (sObject, created via REST)            — the money received
 *     → applyPayment (standard invocable action)   — creates the PaymentLineInvoice application
 *       → PaymentLineInvoice (Type Applied)        — Payment → Invoice relationship
 *         → Invoice.Balance / NetPaymentsApplied / SettlementStatus (recalculated by Salesforce)
 *
 * Safety: the browser only sends an invoice Id, an amount, a date, optional choices and an
 * idempotency key. Account, balance, eligibility and currency are always re-read server-side; a
 * changed invoice is rejected with 409; the idempotency key is stored on Payment.PaymentIntentGuid
 * (createable, not updateable) so a repeated confirm returns the existing payment instead of a new one.
 */

export const APPLY_ACTION = "applyPayment";
const q = async (client: SalesforceClient, soql: string) => client.queryAll<Record<string, unknown>>(soql);
const idList = (ids: string[]) => ids.map(i => `'${soqlEscape(i)}'`).join(",");
const rel = (row: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), row);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const cents = (n: number) => Math.round(n * 100);
const has = (d: DescribeResult, name: string) => d.fields.some(f => f.name === name);
const KEY_RE = /^[A-Za-z0-9-]{16,64}$/;

/* ───────────────────────────── Model / capabilities ───────────────────────────── */

export interface PaymentCapability { id: string; label: string; available: boolean; detail: string }
export interface PaymentModel {
  success: true;
  available: boolean;
  objects: { payment: string | null; application: string | null; invoice: string | null; paymentMethod: string | null; gateway: string | null };
  statusValues: string[];
  typeValues: string[];
  processingModes: string[];
  defaults: { status: string | null; type: string | null; processingMode: string | null };
  /** Invoice.Status values Salesforce treats as accepting payments (the posted states of the org's own picklist). */
  eligibleInvoiceStatuses: string[];
  settlementValues: string[];
  paymentMethods: { id: string; name: string; type: string | null; accountId: string | null }[];
  gatewayCount: number;
  currency: string | null;
  capabilities: PaymentCapability[];
  /** Result of the non-mutating line-application permission check (see probeLineApplication). */
  applicationProbe: ApplicationProbe;
  /** The org's payment-related permission sets and whether the current user has them (applying payments per invoice
   * line was rejected with "This feature is not currently enabled for this user" without them). */
  permissions: { name: string; label: string; assigned: boolean }[];
  fields: Record<string, string | null>;
}

async function currentUserId(client: SalesforceClient): Promise<string | null> {
  const res = await client.requestWithDiagnostics(`${client.instanceUrl}/services/oauth2/userinfo`, { method: "GET" }).catch(() => null);
  return (res?.json as { user_id?: string } | null)?.user_id ?? null;
}

async function paymentPermissions(client: SalesforceClient): Promise<PaymentModel["permissions"]> {
  const sets = await q(client, "SELECT Id, Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false AND (Label LIKE '%Payment%' OR Name LIKE '%Payment%') ORDER BY Label LIMIT 20").catch(() => []);
  if (!sets.length) return [];
  const uid = await currentUserId(client);
  const assigned = uid ? new Set((await q(client, `SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${soqlEscape(uid)}' AND PermissionSetId IN (${idList(sets.map(s => s.Id as string))})`).catch(() => [])).map(a => a.PermissionSetId as string)) : new Set<string>();
  return sets.map(s => ({ name: String(s.Name), label: String(s.Label), assigned: assigned.has(s.Id as string) }));
}

/** Shown with an application failure that Salesforce reports as a missing feature/permission. */
export function applicationPermissionHint(model: PaymentModel, error: string): string | null {
  if (!/not currently enabled|insufficient|permission/i.test(error)) return null;
  const missing = model.permissions.filter(p => !p.assigned);
  return `Salesforce rejected the payment application for your user. ${missing.length ? `This org has payment permission sets you don't have: ${missing.map(p => `"${p.label}" (${p.name})`).join(", ")}. ` : ""}Ask a Salesforce admin to assign the payment permissions (and their permission set licence) to your user, then try again.`;
}

const picklist = (d: DescribeResult | null, field: string) => d?.fields.find(f => f.name === field)?.picklistValues?.filter(p => p.active).map(p => p.value) ?? [];

/** Org currency for display — Salesforce's own formatting of a real amount (shared billing-document utility). */
async function orgDefaultCurrency(client: SalesforceClient): Promise<string | null> {
  const c = await orgCurrency(client);
  return c.code ?? c.symbol;
}

export interface ApplicationProbe { state: "available" | "unavailable" | "unknown"; detail: string; checkedAt: number }

const probeCache = ((globalThis as { __rcbApplyProbe?: Map<string, ApplicationProbe> }).__rcbApplyProbe ??= new Map());

/**
 * Non-mutating check of whether this user may apply payments to invoice lines. Salesforce evaluates the
 * permission before the amount (verified: both a zero and an over-balance amount returned "This feature is not
 * currently enabled for this user."), so applyPayment is called with an EXISTING payment, a real invoice line and an
 * amount larger than that payment's own balance — a request Salesforce can never execute. "Not enabled"/insufficient
 * access → unavailable; any other rejection (amount/validation) → the permission is present. Nothing is ever applied.
 */
export async function probeLineApplication(client: SalesforceClient, opts: { fresh?: boolean } = {}): Promise<ApplicationProbe> {
  const key = `${client.instanceUrl}:${(await currentUserId(client)) ?? "?"}`;
  const cached = probeCache.get(key);
  if (!opts.fresh && cached && Date.now() - cached.checkedAt < 60_000) return cached;
  const [payment] = await q(client, "SELECT Id, Balance, Amount FROM Payment ORDER BY CreatedDate DESC LIMIT 1").catch(() => []);
  const [line] = await q(client, "SELECT Id FROM InvoiceLine ORDER BY CreatedDate DESC LIMIT 1").catch(() => []);
  let result: ApplicationProbe;
  if (!payment || !line) result = { state: "unknown", detail: "Can't be verified in advance (no existing payment or invoice line to test with) — Salesforce decides when the payment is applied.", checkedAt: Date.now() };
  else {
    const impossible = Math.ceil(Math.max(num(payment.Balance) ?? 0, num(payment.Amount) ?? 0)) + 1_000_000_000;
    const res = await client.requestWithDiagnostics(`/actions/standard/${APPLY_ACTION}`, { method: "POST", body: JSON.stringify({ inputs: [{ paymentId: payment.Id, appliedToId: line.Id, amount: impossible }] }) });
    const out = (Array.isArray(res.json) ? res.json[0] : null) as { isSuccess?: boolean; errors?: { message?: string; statusCode?: string }[] | null } | null;
    const msg = (out?.errors ?? []).map(e => `${e.statusCode ?? ""} ${e.message ?? ""}`).join("; ");
    if (out?.isSuccess) result = { state: "available", detail: "Salesforce accepted the check.", checkedAt: Date.now() }; // can't happen with an over-balance amount
    else if (/not currently enabled|INSUFFICIENT_ACCESS/i.test(msg) || res.status === 403) result = { state: "unavailable", detail: (out?.errors?.[0]?.message ?? msg) || "Payment application isn't permitted for this user.", checkedAt: Date.now() };
    else result = { state: "available", detail: "Your user may apply payments to invoice lines (verified with a non-executing check).", checkedAt: Date.now() };
  }
  probeCache.set(key, result);
  return result;
}

export async function getPaymentModel(client: SalesforceClient): Promise<PaymentModel> {
  const global = new Map((await billingDescribeGlobal(client)).map(g => [g.name, g]));
  const payment = global.has("Payment") ? await billingDescribe(client, "Payment") : null;
  const pli = global.has("PaymentLineInvoice") ? await billingDescribe(client, "PaymentLineInvoice") : null;
  const invoice = global.has("Invoice") ? await billingDescribe(client, "Invoice") : null;
  const paymentCreateable = !!global.get("Payment")?.createable;
  const applyAction = await hasStandardAction(client, APPLY_ACTION);
  const saleAction = await hasStandardAction(client, "paymentSale");

  const statusValues = picklist(payment, "Status");
  const typeValues = picklist(payment, "Type");
  const processingModes = picklist(payment, "ProcessingMode");
  const invoiceStatuses = picklist(invoice, "Status");
  const eligibleInvoiceStatuses = invoiceStatuses.filter(s => /^(split )?posted$/i.test(s));

  const paymentMethods = global.has("PaymentMethod")
    ? (await q(client, "SELECT Id, Name, PaymentMethodType, Status, AccountId FROM PaymentMethod WHERE Status = 'Active' ORDER BY Name LIMIT 200").catch(() => []))
      .map(m => ({ id: m.Id as string, name: String(m.Name ?? m.Id), type: str(m.PaymentMethodType), accountId: str(m.AccountId) }))
    : [];
  const gateways = global.has("PaymentGateway") ? await q(client, "SELECT Id FROM PaymentGateway WHERE Status = 'Active' LIMIT 50").catch(() => []) : [];

  // Without an active gateway Salesforce can't process the payment itself — it can only be recorded as External.
  const external = processingModes.find(m => /^external$/i.test(m)) ?? null;
  const processingMode = gateways.length ? (processingModes[0] ?? null) : external;
  const available = paymentCreateable && !!pli && !!invoice && applyAction;
  const partial = !!pli && applyAction; // applyPayment's own contract: "apply all or part of the payment amount" — confirmed by the real test.

  const capabilities: PaymentCapability[] = [
    { id: "create", label: "Payment Creation", available: paymentCreateable, detail: payment ? `Payment sObject (${paymentCreateable ? "createable" : "read-only"} for your user)` : "No Payment object in this org." },
    { id: "apply", label: "Payment Application", available: !!pli && applyAction, detail: applyAction ? `Standard action "${APPLY_ACTION}" → PaymentLineInvoice` : `Standard action "${APPLY_ACTION}" isn't available.` },
    { id: "partial", label: "Partial Payment", available: partial, detail: partial ? "Apply part of an invoice balance; the invoice stays open for the remainder." : "Partial payment is not supported by this org configuration." },
    { id: "external", label: "External (offline) payments", available: !!external, detail: external ? `ProcessingMode "${external}"` : "No External processing mode." },
    { id: "gateway", label: "Payment Gateway processing", available: gateways.length > 0 && saleAction, detail: gateways.length ? `${gateways.length} active gateway(s)${saleAction ? " · paymentSale action" : ""}` : "No active Payment Gateway is configured in this Salesforce org." },
    { id: "methods", label: "Payment Methods", available: paymentMethods.length > 0, detail: paymentMethods.length ? `${paymentMethods.length} active payment method(s)` : "No payment methods are configured in this Salesforce org." },
  ];

  const permissions = await paymentPermissions(client);
  const draftModel = { permissions } as PaymentModel;
  const block = await applicationBlock(client, draftModel);
  const probe = applyAction ? await probeLineApplication(client) : { state: "unknown" as const, detail: "", checkedAt: Date.now() };
  const blocked = !!block || probe.state === "unavailable";
  if (blocked) {
    const cap = capabilities.find(c => c.id === "apply");
    if (cap) { cap.available = false; cap.detail = `Not enabled for your Salesforce user — Salesforce: "${probe.state === "unavailable" ? probe.detail : block!.reason.replace(/^Salesforce didn't apply the payment: /, "")}"`; }
  }
  capabilities.push({ id: "settle", label: "Payment Settlement (invoice lines)", available: !blocked && !!pli && applyAction, detail: probe.state === "unavailable" ? "Payment settlement is not currently enabled for this Salesforce user." : probe.detail || "Applied to invoice lines via applyPayment." });
  return {
    success: true, available: available && !blocked,
    applicationProbe: probe,
    objects: { payment: payment ? "Payment" : null, application: pli ? "PaymentLineInvoice" : null, invoice: invoice ? "Invoice" : null, paymentMethod: global.has("PaymentMethod") ? "PaymentMethod" : null, gateway: global.has("PaymentGateway") ? "PaymentGateway" : null },
    statusValues, typeValues, processingModes,
    defaults: {
      // An externally received payment is already processed; fall back to the org's first value otherwise.
      status: statusValues.find(s => /^processed$/i.test(s)) ?? statusValues[0] ?? null,
      type: typeValues.find(s => /^sale$/i.test(s)) ?? typeValues[0] ?? null,
      processingMode,
    },
    eligibleInvoiceStatuses,
    settlementValues: picklist(invoice, "SettlementStatus"),
    paymentMethods, gatewayCount: gateways.length,
    currency: await orgDefaultCurrency(client),
    capabilities,
    permissions,
    fields: {
      "Payment amount": "Payment.Amount", "Applied / unapplied": "Payment.TotalApplied / Payment.TotalUnapplied",
      "Application": "PaymentLineInvoice (PaymentId → InvoiceId, Type, Amount)", "Invoice balance": "Invoice.Balance",
      "Idempotency key": has(payment ?? { fields: [] } as unknown as DescribeResult, "PaymentIntentGuid") ? "Payment.PaymentIntentGuid" : null,
      "Payment method": payment && has(payment, "PaymentMethodId") ? "Payment.PaymentMethodId → PaymentMethod" : null,
    },
  };
}

/* ───────────────────────────── Invoices for payment ───────────────────────────── */

export interface PaymentInvoice {
  id: string; number: string | null; status: string | null;
  account: { id: string; name: string } | null;
  total: number | null; balance: number | null; paymentsApplied: number | null; creditsApplied: number | null;
  settlementStatus: string | null; invoiceDate: string | null; dueDate: string | null; currency: string | null;
  excluded: boolean; exclusionReason: string | null;
  eligible: boolean; reasons: string[];
  /** Invoice.SettlementLevel. "InvoiceLine" → payments are applied per invoice line; otherwise to the invoice
   * (with a per-line fallback only when Salesforce itself asks for Invoice Line Ids). */
  settlementLevel: string | null;
  applyTo: "invoice" | "lines";
  lines: { id: string; name: string | null; product: string | null; amount: number | null; balance: number | null; paymentsApplied: number | null; creditsApplied: number | null; scheduleId: string | null }[];
  /** Orders behind the invoice (InvoiceLine → BillingSchedule → Order). */
  orders: { id: string; number: string | null }[];
  applications: PaymentApplication[];
  salesforceUrl: string;
  /** Hash of everything a payment depends on (status, balance, applied totals, line balances, last modification). */
  token: string;
}

export interface PaymentApplication {
  id: string; number: string | null;
  /** PaymentLineInvoice (invoice level) or PaymentLineInvoiceLine (invoice-line level). */
  level: "invoice" | "line";
  type: string | null; amount: number | null; hasBeenUnapplied: string | null; appliedDate: string | null;
  payment: { id: string; number: string | null; status: string | null } | null;
  invoice: { id: string; number: string | null; status: string | null; balance: number | null } | null;
  invoiceLine: { id: string; name: string | null; balance: number | null } | null;
}

const INVOICE_FIELDS = ["Id", "DocumentNumber", "Status", "BillingAccountId", "BillingAccount.Name", "TotalAmountWithTax", "Balance", "NetPaymentsApplied", "NetCreditsApplied", "SettlementStatus", "SettlementLevel", "InvoiceDate", "DueDate", "ShouldExcludePayment", "PaymentExclusionReason", "LastModifiedDate"];

async function invoiceSelect(client: SalesforceClient): Promise<string> {
  const d = await billingDescribe(client, "Invoice");
  return INVOICE_FIELDS.filter(f => f.includes(".") ? has(d, "BillingAccountId") : has(d, f)).join(", ");
}

type InvoiceLineRow = PaymentInvoice["lines"][number];

function evaluateInvoice(row: Record<string, unknown>, model: PaymentModel, applications: PaymentApplication[], lines: InvoiceLineRow[], currency: string | null, instanceUrl: string, orders: { id: string; number: string | null }[] = []): PaymentInvoice {
  const balance = num(row.Balance);
  const status = str(row.Status);
  const settlementLevel = str(row.SettlementLevel);
  const reasons: string[] = [];
  if (!model.eligibleInvoiceStatuses.includes(status ?? "")) reasons.push(`Invoice status is "${status ?? "—"}" — Salesforce accepts payments only on ${model.eligibleInvoiceStatuses.map(s => `"${s}"`).join(" / ") || "posted"} invoices.`);
  if (row.ShouldExcludePayment === true) reasons.push(`Salesforce excludes this invoice from payment${row.PaymentExclusionReason ? `: ${String(row.PaymentExclusionReason)}` : "."}`);
  if (balance === null || cents(balance) <= 0) reasons.push("The invoice has no outstanding balance.");
  if (!row.BillingAccountId) reasons.push("The invoice has no billing account.");
  const token = createHash("sha256").update(JSON.stringify([row.Id, status, balance, row.NetPaymentsApplied ?? null, row.NetCreditsApplied ?? null, row.LastModifiedDate ?? null, lines.map(l => [l.id, l.balance])])).digest("hex").slice(0, 24);
  return {
    id: row.Id as string, number: str(row.DocumentNumber), status,
    account: row.BillingAccountId ? { id: row.BillingAccountId as string, name: String(rel(row, "BillingAccount.Name") ?? row.BillingAccountId) } : null,
    // Invoice.TotalAmountWithTax only — Invoice.TotalAmount is the PRE-tax amount on taxed invoices (p10 DOC-000000019/21), so it's
    // never a fallback. Missing → null (every consumer renders null as "—", never 0).
    total: invoiceTotalWithTax(row), balance, paymentsApplied: num(row.NetPaymentsApplied), creditsApplied: num(row.NetCreditsApplied),
    settlementStatus: str(row.SettlementStatus), invoiceDate: str(row.InvoiceDate), dueDate: str(row.DueDate), currency,
    excluded: row.ShouldExcludePayment === true, exclusionReason: str(row.PaymentExclusionReason),
    eligible: reasons.length === 0, reasons,
    settlementLevel, applyTo: /^invoiceline$/i.test(settlementLevel ?? "") ? "lines" : "invoice", lines, orders,
    applications,
    salesforceUrl: buildSalesforceRecordUrl(instanceUrl, "Invoice", row.Id as string), token,
  };
}

async function invoiceLines(client: SalesforceClient, invoiceIds: string[]): Promise<Map<string, InvoiceLineRow[]>> {
  const out = new Map<string, InvoiceLineRow[]>();
  if (!invoiceIds.length) return out;
  const rows = await q(client, `SELECT Id, Name, InvoiceId, Product2.Name, LineAmount, Balance, NetPaymentsApplied, NetCreditsApplied, BillingScheduleId FROM InvoiceLine WHERE InvoiceId IN (${idList(invoiceIds)}) ORDER BY CreatedDate, Id`).catch(() => []);
  for (const r of rows) {
    const list = out.get(r.InvoiceId as string) ?? [];
    list.push({ id: r.Id as string, name: str(r.Name), product: str(rel(r, "Product2.Name")), amount: num(r.LineAmount), balance: num(r.Balance), paymentsApplied: num(r.NetPaymentsApplied), creditsApplied: num(r.NetCreditsApplied), scheduleId: str(r.BillingScheduleId) });
    out.set(r.InvoiceId as string, list);
  }
  return out;
}

async function ordersForLines(client: SalesforceClient, lines: InvoiceLineRow[]): Promise<Map<string, { id: string; number: string | null }>> {
  const scheduleIds = [...new Set(lines.map(l => l.scheduleId).filter((x): x is string => !!x))];
  const out = new Map<string, { id: string; number: string | null }>();
  if (!scheduleIds.length) return out;
  const sched = await q(client, `SELECT Id, ReferenceEntityId FROM BillingSchedule WHERE Id IN (${idList(scheduleIds)})`).catch(() => []);
  const refIds = [...new Set(sched.map(x => str(x.ReferenceEntityId)).filter((x): x is string => !!x))];
  const orders = refIds.length ? await q(client, `SELECT Id, OrderNumber FROM Order WHERE Id IN (${idList(refIds)})`).catch(() => []) : [];
  const byId = new Map(orders.map(o => [o.Id as string, { id: o.Id as string, number: str(o.OrderNumber) }]));
  for (const x of sched) { const o = byId.get(str(x.ReferenceEntityId) ?? ""); if (o) out.set(x.Id as string, o); }
  return out;
}
const ordersOf = (lines: InvoiceLineRow[], bySchedule: Map<string, { id: string; number: string | null }>) =>
  [...new Map(lines.map(l => bySchedule.get(l.scheduleId ?? "")).filter((o): o is { id: string; number: string | null } => !!o).map(o => [o.id, o])).values()];

/** Both application records Salesforce can hold: PaymentLineInvoice (invoice) and PaymentLineInvoiceLine (invoice line). */
async function applicationsFor(client: SalesforceClient, by: { invoiceId?: string; paymentIds?: string[] }): Promise<PaymentApplication[]> {
  const invWhere = by.invoiceId ? `InvoiceId = '${soqlEscape(by.invoiceId)}'` : `PaymentId IN (${idList(by.paymentIds ?? [])})`;
  const lineWhere = by.invoiceId ? `InvoiceLine.InvoiceId = '${soqlEscape(by.invoiceId)}'` : `PaymentId IN (${idList(by.paymentIds ?? [])})`;
  if (!by.invoiceId && !by.paymentIds?.length) return [];
  const [inv, lines] = await Promise.all([
    q(client, `SELECT Id, PaymentLineInvoiceNumber, Type, Amount, HasBeenUnapplied, AppliedDate, PaymentId, Payment.PaymentNumber, Payment.Status, InvoiceId, Invoice.DocumentNumber, Invoice.Status, Invoice.Balance FROM PaymentLineInvoice WHERE ${invWhere} ORDER BY CreatedDate`).catch(() => []),
    q(client, `SELECT Id, PaymentLineInvoiceLineNumber, Type, Amount, UnappliedStatus, AppliedDateTime, PaymentId, Payment.PaymentNumber, Payment.Status, InvoiceLineId, InvoiceLine.Name, InvoiceLine.Balance, InvoiceLine.InvoiceId, InvoiceLine.Invoice.DocumentNumber, InvoiceLine.Invoice.Status, InvoiceLine.Invoice.Balance FROM PaymentLineInvoiceLine WHERE ${lineWhere} ORDER BY CreatedDate`).catch(() => []),
  ]);
  const pay = (r: Record<string, unknown>) => (r.PaymentId ? { id: r.PaymentId as string, number: str(rel(r, "Payment.PaymentNumber")), status: str(rel(r, "Payment.Status")) } : null);
  return [
    ...inv.map(r => ({
      id: r.Id as string, number: str(r.PaymentLineInvoiceNumber), level: "invoice" as const, type: str(r.Type), amount: num(r.Amount), hasBeenUnapplied: str(r.HasBeenUnapplied), appliedDate: str(r.AppliedDate),
      payment: pay(r), invoiceLine: null,
      invoice: r.InvoiceId ? { id: r.InvoiceId as string, number: str(rel(r, "Invoice.DocumentNumber")), status: str(rel(r, "Invoice.Status")), balance: num(rel(r, "Invoice.Balance")) } : null,
    })),
    ...lines.map(r => ({
      id: r.Id as string, number: str(r.PaymentLineInvoiceLineNumber), level: "line" as const, type: str(r.Type), amount: num(r.Amount), hasBeenUnapplied: str(r.UnappliedStatus), appliedDate: str(r.AppliedDateTime),
      payment: pay(r),
      invoiceLine: r.InvoiceLineId ? { id: r.InvoiceLineId as string, name: str(rel(r, "InvoiceLine.Name")), balance: num(rel(r, "InvoiceLine.Balance")) } : null,
      invoice: rel(r, "InvoiceLine.InvoiceId") ? { id: rel(r, "InvoiceLine.InvoiceId") as string, number: str(rel(r, "InvoiceLine.Invoice.DocumentNumber")), status: str(rel(r, "InvoiceLine.Invoice.Status")), balance: num(rel(r, "InvoiceLine.Invoice.Balance")) } : null,
    })),
  ];
}

/** Allocate an amount to the application targets Salesforce expects: the invoice, or its open lines in line order. */
export function allocatePayment(invoice: PaymentInvoice, amount: number): { targets: { id: string; label: string; amount: number }[]; unallocated: number } {
  let left = cents(amount);
  if (invoice.applyTo === "invoice") {
    const take = Math.min(left, cents(invoice.balance ?? 0));
    return { targets: take > 0 ? [{ id: invoice.id, label: invoice.number ?? "Invoice", amount: take / 100 }] : [], unallocated: (left - take) / 100 };
  }
  const targets: { id: string; label: string; amount: number }[] = [];
  for (const l of invoice.lines) {
    const open = cents(l.balance ?? 0);
    if (left <= 0 || open <= 0) continue;
    const take = Math.min(open, left);
    targets.push({ id: l.id, label: l.name ?? l.product ?? "Invoice line", amount: take / 100 });
    left -= take;
  }
  return { targets, unallocated: left / 100 };
}

export async function loadInvoiceForPayment(client: SalesforceClient, invoiceId: string, model?: PaymentModel): Promise<PaymentInvoice> {
  if (!SALESFORCE_ID.test(invoiceId)) throw new NotFoundError("Invalid Invoice Id.");
  const m = model ?? await getPaymentModel(client);
  const [row] = await q(client, `SELECT ${await invoiceSelect(client)} FROM Invoice WHERE Id = '${soqlEscape(invoiceId)}' LIMIT 1`);
  if (!row) throw new NotFoundError("Invoice not found in Salesforce (or not visible to your user).");
  const [apps, lines] = await Promise.all([applicationsFor(client, { invoiceId }), invoiceLines(client, [row.Id as string])]);
  const own = lines.get(row.Id as string) ?? [];
  return evaluateInvoice(row, m, apps, own, m.currency, client.instanceUrl, ordersOf(own, await ordersForLines(client, own)));
}

/** Invoice lookup for Record Payment: real invoices, eligible first (search by number or account). */
export async function searchPaymentInvoices(client: SalesforceClient, opts: { search?: string; eligibleOnly?: boolean; from?: string | null; to?: string | null; purpose?: "payment" | "credit" }): Promise<{ success: true; invoices: PaymentInvoice[]; eligibleStatuses: string[] }> {
  const m = await getPaymentModel(client);
  const where: string[] = [];
  const term = (opts.search ?? "").trim();
  if (term) {
    // Invoice number, account name, or the number of an order billed on the invoice (Order → BillingSchedule → InvoiceLine).
    const orders = await q(client, `SELECT Id FROM Order WHERE OrderNumber LIKE '%${soqlEscape(term)}%' LIMIT 50`).catch(() => []);
    const sched = orders.length ? await q(client, `SELECT Id FROM BillingSchedule WHERE ReferenceEntityId IN (${idList(orders.map(o => o.Id as string))})`).catch(() => []) : [];
    const lineInv = sched.length ? await q(client, `SELECT InvoiceId FROM InvoiceLine WHERE BillingScheduleId IN (${idList(sched.map(x => x.Id as string))})`).catch(() => []) : [];
    const viaOrder = [...new Set(lineInv.map(l => l.InvoiceId as string))];
    where.push(`(DocumentNumber LIKE '%${soqlEscape(term)}%' OR BillingAccount.Name LIKE '%${soqlEscape(term)}%'${viaOrder.length ? ` OR Id IN (${idList(viaOrder)})` : ""})`);
  }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (opts.from) { if (!day.test(opts.from)) throw new BadInputError("Invalid from date."); where.push(`InvoiceDate >= ${opts.from}`); }
  if (opts.to) { if (!day.test(opts.to)) throw new BadInputError("Invalid to date."); where.push(`InvoiceDate <= ${opts.to}`); }
  if (opts.purpose === "credit") {
    // Crediting an invoice: Salesforce requires the invoice status to be Posted (no balance requirement).
    const posted = m.eligibleInvoiceStatuses.filter(st => /^posted$/i.test(st));
    if (!posted.length) return { success: true, invoices: [], eligibleStatuses: [] };
    where.push(`Status IN (${idList(posted)})`);
  } else if (opts.eligibleOnly !== false) {
    if (!m.eligibleInvoiceStatuses.length) return { success: true, invoices: [], eligibleStatuses: [] };
    where.push(`Status IN (${idList(m.eligibleInvoiceStatuses)})`, "Balance > 0", "ShouldExcludePayment = false");
  }
  const rows = await q(client, `SELECT ${await invoiceSelect(client)} FROM Invoice${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY CreatedDate DESC LIMIT 50`);
  const lines = await invoiceLines(client, rows.map(r => r.Id as string));
  const bySchedule = await ordersForLines(client, [...lines.values()].flat());
  return { success: true, invoices: rows.map(r => { const own = lines.get(r.Id as string) ?? []; return evaluateInvoice(r, m, [], own, m.currency, client.instanceUrl, ordersOf(own, bySchedule)); }), eligibleStatuses: opts.purpose === "credit" ? m.eligibleInvoiceStatuses.filter(st => /^posted$/i.test(st)) : m.eligibleInvoiceStatuses };
}

/* ───────────────────────────── Payments: list / stats / detail ───────────────────────────── */

export interface PaymentRow {
  id: string; number: string | null; status: string | null; type: string | null; processingMode: string | null;
  date: string | null; amount: number | null; applied: number | null; unapplied: number | null; balance: number | null;
  account: { id: string; name: string } | null; paymentMethod: { id: string; name: string } | null;
  invoices: { id: string; number: string | null }[]; createdDate: string | null; salesforceUrl: string;
}

const PAYMENT_SORTS: Record<string, string> = { date: "Date", amount: "Amount", number: "PaymentNumber", status: "Status", created: "CreatedDate", account: "Account.Name" };

async function paymentSelect(client: SalesforceClient): Promise<string> {
  const d = await billingDescribe(client, "Payment");
  const base = ["Id", "PaymentNumber", "Status", "Type", "ProcessingMode", "Date", "EffectiveDate", "Amount", "TotalApplied", "TotalUnapplied", "Balance", "AccountId", "PaymentMethodId", "PaymentIntentGuid", "Comments", "CreatedDate", "LastModifiedDate"].filter(f => has(d, f));
  if (has(d, "AccountId")) base.push("Account.Name");
  if (has(d, "PaymentMethodId")) base.push("PaymentMethod.Name");
  return base.join(", ");
}

function paymentRow(r: Record<string, unknown>, invoices: Map<string, { id: string; number: string | null }[]>, instanceUrl: string): PaymentRow {
  return {
    id: r.Id as string, number: str(r.PaymentNumber), status: str(r.Status), type: str(r.Type), processingMode: str(r.ProcessingMode),
    date: str(r.Date) ?? str(r.EffectiveDate), amount: num(r.Amount), applied: num(r.TotalApplied), unapplied: num(r.TotalUnapplied), balance: num(r.Balance),
    account: r.AccountId ? { id: r.AccountId as string, name: String(rel(r, "Account.Name") ?? r.AccountId) } : null,
    paymentMethod: r.PaymentMethodId ? { id: r.PaymentMethodId as string, name: String(rel(r, "PaymentMethod.Name") ?? r.PaymentMethodId) } : null,
    invoices: invoices.get(r.Id as string) ?? [], createdDate: str(r.CreatedDate),
    salesforceUrl: buildSalesforceRecordUrl(instanceUrl, "Payment", r.Id as string),
  };
}

export interface PaymentListResponse {
  success: true;
  payments: PaymentRow[];
  totalSize: number; page: number; pageSize: number;
  /** unapplied = SUM(Payment.Balance): the part of each payment not applied to any invoice (TotalUnapplied only counts reversed applications). */
  stats: { count: number; amount: number | null; applied: number | null; unapplied: number | null; byStatus: { status: string; count: number; amount: number | null }[] };
  statusValues: string[];
  currency: string | null;
}

export async function listPayments(client: SalesforceClient, opts: { search?: string | null; status?: string | null; accountId?: string | null; from?: string | null; to?: string | null; sort?: string | null; dir?: string | null; page?: number; pageSize?: number }): Promise<PaymentListResponse> {
  const m = await getPaymentModel(client);
  if (!m.objects.payment) throw new NotFoundError("This org has no Payment object.");
  const where: string[] = [];
  const term = (opts.search ?? "").trim();
  if (term) where.push(`(PaymentNumber LIKE '%${soqlEscape(term)}%' OR Account.Name LIKE '%${soqlEscape(term)}%')`);
  if (opts.status) { if (!m.statusValues.includes(opts.status)) throw new BadInputError(`Unknown Payment status "${opts.status}".`); where.push(`Status = '${soqlEscape(opts.status)}'`); }
  if (opts.accountId) { if (!SALESFORCE_ID.test(opts.accountId)) throw new BadInputError("Invalid Account Id."); where.push(`AccountId = '${soqlEscape(opts.accountId)}'`); }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (opts.from) { if (!day.test(opts.from)) throw new BadInputError("Invalid from date."); where.push(`Date >= ${opts.from}T00:00:00Z`); }
  if (opts.to) { if (!day.test(opts.to)) throw new BadInputError("Invalid to date."); where.push(`Date <= ${opts.to}T23:59:59Z`); }
  const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const sort = PAYMENT_SORTS[opts.sort ?? ""] ?? "CreatedDate";
  const dir = opts.dir === "asc" ? "ASC" : "DESC";
  const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 5), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const offset = Math.min((page - 1) * pageSize, 2000);

  const [rows, agg] = await Promise.all([
    client.query<Record<string, unknown>>(`SELECT ${await paymentSelect(client)} FROM Payment${w} ORDER BY ${sort} ${dir} NULLS LAST, Id LIMIT ${pageSize} OFFSET ${offset}`),
    q(client, `SELECT Status, COUNT(Id) c, SUM(Amount) amt, SUM(TotalApplied) app, SUM(Balance) un FROM Payment${w} GROUP BY Status`),
  ]);
  const ids = rows.records.map(r => r.Id as string);
  const apps = ids.length ? activeApplications(await applicationsFor(client, { paymentIds: ids })) : [];
  const invoices = new Map<string, { id: string; number: string | null }[]>();
  for (const a of apps) if (a.payment && a.invoice) {
    const list = invoices.get(a.payment.id) ?? [];
    if (!list.some(x => x.id === a.invoice!.id)) list.push({ id: a.invoice.id, number: a.invoice.number });
    invoices.set(a.payment.id, list);
  }
  const sum = (k: string) => agg.reduce<number | null>((s, r) => (typeof r[k] === "number" ? (s ?? 0) + (r[k] as number) : s), null);
  const count = agg.reduce((s, r) => s + (num(r.c) ?? 0), 0);
  return {
    success: true,
    payments: rows.records.map(r => paymentRow(r, invoices, client.instanceUrl)),
    totalSize: count, page, pageSize,
    stats: { count, amount: sum("amt"), applied: sum("app"), unapplied: agg.filter(r => !/cancel|fail/i.test(String(r.Status ?? ""))).reduce<number | null>((s, r) => (typeof r.un === "number" ? (s ?? 0) + r.un : s), null), byStatus: agg.map(r => ({ status: String(r.Status ?? "—"), count: num(r.c) ?? 0, amount: num(r.amt) })) },
    statusValues: m.statusValues, currency: m.currency,
  };
}

export interface PaymentDetail {
  success: true;
  payment: PaymentRow & { comments: string | null; idempotencyKey: string | null; effectiveDate: string | null };
  fields: { name: string; label: string; value: unknown }[];
  applications: PaymentApplication[];
  invoices: PaymentInvoice[];
  orders: { id: string; number: string | null; scheduleIds: string[]; invoiceId: string }[];
}

export async function getPaymentDetail(client: SalesforceClient, paymentId: string): Promise<PaymentDetail> {
  if (!SALESFORCE_ID.test(paymentId)) throw new NotFoundError("Invalid Payment Id.");
  const m = await getPaymentModel(client);
  const d = await billingDescribe(client, "Payment");
  const [r] = await q(client, `SELECT ${await paymentSelect(client)} FROM Payment WHERE Id = '${soqlEscape(paymentId)}' LIMIT 1`);
  if (!r) throw new NotFoundError("Payment not found in Salesforce (or not visible to your user).");
  const applications = await applicationsFor(client, { paymentIds: [paymentId] });
  const invoiceIds = [...new Set(applications.map(a => a.invoice?.id).filter((x): x is string => !!x))];
  const invoices = await Promise.all(invoiceIds.map(id => loadInvoiceForPayment(client, id, m)));
  const orders = (await Promise.all(invoiceIds.map(async id => ({ invoiceId: id, ...(await findOrderContext(client, { invoiceId: id })) }))))
    .filter(o => o.orderId).map(o => ({ id: o.orderId!, number: o.orderNumber, scheduleIds: o.scheduleIds, invoiceId: o.invoiceId }));
  const map = new Map<string, { id: string; number: string | null }[]>([[paymentId, activeApplications(applications).map(a => ({ id: a.invoice!.id, number: a.invoice!.number }))]]);
  const row = paymentRow(r, map, client.instanceUrl);
  const labels = new Map(d.fields.map(f => [f.name, f.label]));
  return {
    success: true,
    payment: { ...row, comments: str(r.Comments), idempotencyKey: str(r.PaymentIntentGuid), effectiveDate: str(r.EffectiveDate) },
    fields: Object.entries(r).filter(([k, v]) => k !== "attributes" && (v === null || typeof v !== "object")).map(([k, v]) => ({ name: k, label: labels.get(k) ?? k, value: v })),
    applications, invoices, orders,
  };
}

/* ───────────────────────────── Validate / record / apply ───────────────────────────── */

export class NotFoundError extends Error {}
export class BadInputError extends Error {}

export interface PaymentInput {
  invoiceId: string;
  amount: number;
  paymentDate?: string | null;
  paymentMethodId?: string | null;
  status?: string | null;
  type?: string | null;
  comments?: string | null;
  invoiceToken?: string | null;
  idempotencyKey?: string | null;
  /** The user confirmed that a similar recent payment is intentional. */
  allowSimilar?: boolean;
  /** Settle Payment: apply to invoice lines ("lines"). Without an explicit allocation the server auto-allocates in line order. */
  level?: "lines" | null;
  /** Settle Payment manual allocation — invoice line Ids from the server's own line list, re-validated server-side. */
  allocation?: { lineId: string; amount: number }[] | null;
}

export type AllocationTarget = { id: string; label: string; amount: number };

/** Validate / compute a line allocation against the invoice's CURRENT Salesforce lines (never the browser's copy). */
export function resolveLineAllocation(invoice: PaymentInvoice, amount: number, manual?: { lineId: string; amount: number }[] | null): { targets: AllocationTarget[]; error: string | null } {
  if (!invoice.lines.length) return { targets: [], error: "The invoice has no invoice lines to apply the payment to." };
  if (!manual || !manual.length) {
    const auto = allocatePayment({ ...invoice, applyTo: "lines" }, amount);
    return { targets: auto.targets, error: cents(auto.unallocated) > 0 ? `The invoice lines' open balances don't cover ${amount}.` : null };
  }
  const seen = new Set<string>();
  const targets: AllocationTarget[] = [];
  for (const a of manual) {
    const line = invoice.lines.find(l => l.id === a.lineId || l.id.slice(0, 15) === String(a.lineId).slice(0, 15));
    if (!line) return { targets: [], error: "An allocation refers to a line that isn't on this invoice." };
    if (seen.has(line.id)) return { targets: [], error: `${line.name ?? "A line"} is allocated twice.` };
    seen.add(line.id);
    const v = typeof a.amount === "number" && Number.isFinite(a.amount) ? Math.round(a.amount * 100) / 100 : NaN;
    if (!Number.isFinite(v) || v < 0) return { targets: [], error: `Allocation for ${line.name ?? "a line"} must be a number of 0 or more.` };
    if (cents(v) > cents(line.balance ?? 0)) return { targets: [], error: `Allocation for ${line.name ?? "a line"} (${v}) exceeds its remaining balance (${line.balance ?? 0}).` };
    if (v > 0) targets.push({ id: line.id, label: line.name ?? line.product ?? "Invoice line", amount: v });
  }
  const total = targets.reduce((t, x) => t + cents(x.amount), 0);
  if (total !== cents(amount)) return { targets, error: "Payment allocation does not equal the payment amount." };
  return { targets, error: null };
}

export interface PaymentCheck { id: string; label: string; status: "passed" | "failed" | "warning"; detail: string }
export interface PaymentPreview {
  success: true;
  valid: boolean;
  invoice: PaymentInvoice;
  checks: PaymentCheck[];
  errors: string[];
  warnings: string[];
  preview: {
    amount: number; applied: number; unapplied: number; balanceBefore: number | null; balanceAfter: number | null; partial: boolean;
    paymentDate: string; status: string | null; type: string | null; processingMode: string | null;
    paymentMethod: { id: string; name: string } | null; account: { id: string; name: string } | null; currency: string | null;
    /** Where the amount will be applied — the invoice, or (this org) its open invoice lines in line order. */
    applyTo: "invoice" | "lines";
    allocation: { id: string; label: string; amount: number }[];
    /** Per invoice line: current balance, the allocation, and the expected remaining (a preview — Salesforce confirms after execution). */
    lines: { id: string; label: string; balance: number; allocated: number; remainingAfter: number }[];
  } | null;
  similar: { paymentId: string; paymentNumber: string | null; amount: number; appliedDate: string | null }[];
}

export type PaymentOutcome =
  | { ok: true; status: 200 | 201; duplicate: boolean; message: string; payment: PaymentDetail; invoice: PaymentInvoice; applicationCreated: boolean; steps: string[] }
  | { ok: false; status: number; code: string; error: string; invoice?: PaymentInvoice; preview?: PaymentPreview; payment?: PaymentDetail; possibleCause?: string | null; technical?: unknown };

const today = () => new Date().toISOString().slice(0, 10);

/** Server-side validation — the same function the preview, the AI path and the final create use. */
export async function validatePayment(client: SalesforceClient, input: PaymentInput, model?: PaymentModel): Promise<PaymentPreview> {
  const m = model ?? await getPaymentModel(client);
  const invoice = await loadInvoiceForPayment(client, input.invoiceId, m);
  const checks: PaymentCheck[] = [];
  const add = (id: string, label: string, ok: boolean | "warning", detail: string) => checks.push({ id, label, status: ok === true ? "passed" : ok === "warning" ? "warning" : "failed", detail });
  const warnings: string[] = [];

  add("available", "Payments available in this org", m.available, m.available ? "Payment + applyPayment (PaymentLineInvoice / PaymentLineInvoiceLine)" : m.capabilities.filter(c => ["create", "apply"].includes(c.id) && !c.available).map(c => c.detail).join(" ") || "Not available in this Salesforce org.");
  add("eligible", "Invoice can accept payment", invoice.eligible, invoice.eligible ? `${invoice.number} · ${invoice.status}` : invoice.reasons.join(" "));
  const amount = typeof input.amount === "number" && Number.isFinite(input.amount) ? Math.round(input.amount * 100) / 100 : NaN;
  const amountOk = Number.isFinite(amount) && amount > 0;
  add("amount", "Payment amount greater than zero", amountOk, amountOk ? String(amount) : "Enter a payment amount greater than zero.");
  const balance = invoice.balance ?? 0;
  const withinBalance = amountOk && cents(amount) <= cents(balance);
  if (amountOk) add("balance", "Within the outstanding balance", withinBalance, withinBalance ? `${amount} of ${balance}` : `The amount exceeds the invoice's outstanding balance (${balance}). Overpayment isn't applied to invoices by this workflow.`);
  const partial = amountOk && withinBalance && cents(amount) < cents(balance);
  const lineMode = input.level === "lines" || !!input.allocation?.length;
  let allocation: { targets: AllocationTarget[]; unallocated: number } = { targets: [], unallocated: 0 };
  if (amountOk && withinBalance) {
    if (lineMode) {
      const r = resolveLineAllocation(invoice, amount, input.allocation);
      allocation = { targets: r.targets, unallocated: r.error ? 1 : 0 };
      add("allocation", "Allocation to invoice lines", !r.error, r.error ?? r.targets.map(t => `${t.label}: ${t.amount}`).join(" · "));
    } else {
      allocation = allocatePayment(invoice, amount);
      const ok = allocation.targets.length > 0 && cents(allocation.unallocated) === 0;
      add("allocation", invoice.applyTo === "lines" ? "Allocated to open invoice lines" : "Applied to the invoice", ok,
        ok ? allocation.targets.map(t => `${t.label}: ${t.amount}`).join(" · ") : `The invoice lines' open balances don't cover ${amount} (${allocation.unallocated} left unallocated).`);
    }
  }
  if (lineMode) {
    const settle = m.capabilities.find(c => c.id === "settle");
    add("settle", "Payment settlement enabled for your user", !!settle?.available, settle?.available ? settle.detail : "Payment settlement is not currently enabled for this Salesforce user. Your Salesforce user needs the required Billing Advanced / Payment Operations permission to apply payments to invoice lines.");
  }
  if (partial) {
    const cap = m.capabilities.find(c => c.id === "partial");
    add("partial", "Partial payment supported", !!cap?.available, cap?.detail ?? "");
  }
  add("currency", "Currency", true, m.currency ? `${m.currency} (single-currency org — invoice and payment share it)` : "Org currency");
  const date = input.paymentDate?.trim() || today();
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date));
  add("date", "Payment date", dateOk, dateOk ? date : "Use a valid date (YYYY-MM-DD).");
  if (dateOk && date > today()) warnings.push("The payment date is in the future.");
  const status = input.status ?? m.defaults.status;
  const type = input.type ?? m.defaults.type;
  add("status", "Payment status", !!status && m.statusValues.includes(status), status && m.statusValues.includes(status) ? status : `Choose one of: ${m.statusValues.join(", ")}.`);
  add("type", "Payment type", !!type && m.typeValues.includes(type), type && m.typeValues.includes(type) ? type : `Choose one of: ${m.typeValues.join(", ")}.`);
  add("mode", "Processing mode", !!m.defaults.processingMode, m.defaults.processingMode ? `${m.defaults.processingMode}${m.gatewayCount ? "" : " (no active payment gateway)"}` : "No usable processing mode.");
  let method: { id: string; name: string } | null = null;
  if (input.paymentMethodId) {
    const pm = m.paymentMethods.find(p => p.id === input.paymentMethodId || p.id.slice(0, 15) === input.paymentMethodId);
    const okAccount = !!pm && (!pm.accountId || pm.accountId === invoice.account?.id);
    add("method", "Payment method", okAccount, pm ? (okAccount ? pm.name : `${pm.name} belongs to a different account.`) : "That payment method isn't an active Payment Method in this org.");
    if (pm && okAccount) method = { id: pm.id, name: pm.name };
  }

  // Equivalent recent payment on the same invoice (possible double entry).
  const since = Date.now() - 30 * 60 * 1000;
  const similar = amountOk ? appliedByPayment(invoice.applications).filter(a => cents(a.amount) === cents(amount) && a.appliedDate && Date.parse(a.appliedDate) >= since) : [];
  if (similar.length) warnings.push(`A payment of the same amount was applied to ${invoice.number} in the last 30 minutes (${similar.map(x => x.paymentNumber).filter(Boolean).join(", ")}).`);

  const errors = checks.filter(c => c.status === "failed").map(c => c.detail);
  const valid = errors.length === 0;
  return {
    success: true, valid, invoice, checks, errors, warnings, similar,
    preview: amountOk ? {
      amount, applied: withinBalance ? amount : 0, unapplied: withinBalance ? 0 : amount,
      balanceBefore: invoice.balance, balanceAfter: withinBalance ? Math.round((balance - amount) * 100) / 100 : invoice.balance, partial,
      paymentDate: date, status: status ?? null, type: type ?? null, processingMode: m.defaults.processingMode, paymentMethod: method,
      account: invoice.account, currency: m.currency,
      applyTo: lineMode ? "lines" : invoice.applyTo, allocation: allocation.targets,
      lines: invoice.lines.map(l => {
        const alloc = allocation.targets.find(t => t.id === l.id)?.amount ?? 0;
        return { id: l.id, label: l.name ?? l.product ?? "Invoice line", balance: l.balance ?? 0, allocated: alloc, remainingAfter: Math.round(((l.balance ?? 0) - alloc) * 100) / 100 };
      }),
    } : null,
  };
}

const inflight = ((globalThis as { __rcbPaymentInflight?: Map<string, Promise<PaymentOutcome>> }).__rcbPaymentInflight ??= new Map());

/** Create the Salesforce Payment and apply it to the invoice. Idempotent per idempotencyKey; concurrent duplicates share one run. */
export function recordPayment(client: SalesforceClient, input: PaymentInput): Promise<PaymentOutcome> {
  const key = input.idempotencyKey ?? "";
  if (!KEY_RE.test(key)) return Promise.resolve({ ok: false, status: 400, code: "INVALID_REQUEST", error: "A payment idempotency key is required (refresh the form)." });
  const lockKey = `${client.instanceUrl}:${key}`;
  const running = inflight.get(lockKey);
  if (running) return running.then((o: PaymentOutcome): PaymentOutcome => (o.ok ? { ...o, duplicate: true, status: 200, message: "Payment already exists / has already been applied." } : o));
  const p = doRecordPayment(client, input, key).finally(() => inflight.delete(lockKey));
  inflight.set(lockKey, p);
  return p;
}

async function findByKey(client: SalesforceClient, key: string): Promise<string | null> {
  const d = await billingDescribe(client, "Payment");
  if (!has(d, "PaymentIntentGuid")) return null;
  const [row] = await q(client, `SELECT Id FROM Payment WHERE PaymentIntentGuid = '${soqlEscape(key)}' LIMIT 1`);
  return (row?.Id as string) ?? null;
}

type ApplyResult = { ok: true; created: string[] } | { ok: false; status: number; code: string; error: string; created: string[]; technical: unknown };

/** One applyPayment call with one input per target (invoice, or invoice lines); every target must succeed. */
async function applyAction(client: SalesforceClient, paymentId: string, targets: { id: string; label: string; amount: number }[], date: string | null): Promise<ApplyResult> {
  const inputs = targets.map(t => ({ paymentId, appliedToId: t.id, amount: t.amount, ...(date ? { effectiveDate: `${date}T12:00:00+0000` } : {}) }));
  const res = await client.requestWithDiagnostics(`/actions/standard/${APPLY_ACTION}`, { method: "POST", body: JSON.stringify({ inputs }) });
  const outs = (Array.isArray(res.json) ? res.json : []) as { isSuccess?: boolean; errors?: { message?: string; statusCode?: string }[] | null; outputValues?: { paymentLineInvoiceId?: string } | null }[];
  const created = outs.filter(o => o.isSuccess).map(o => o.outputValues?.paymentLineInvoiceId).filter((x): x is string => !!x);
  const failed = outs.map((o, i) => ({ o, t: targets[i] })).filter(x => !x.o.isSuccess);
  if (res.status >= 400 || outs.length !== targets.length || failed.length) {
    const errs = failed.flatMap(x => (x.o.errors ?? []).map(e => ({ ...e, label: x.t?.label }))) as { message?: string; statusCode?: string; errorCode?: string; label?: string }[];
    const top = errs.length ? errs : (Array.isArray(res.json) ? (res.json as { message?: string; errorCode?: string }[]) : []);
    return {
      ok: false, status: res.status === 403 ? 403 : 422, code: (top[0] as { statusCode?: string; errorCode?: string } | undefined)?.statusCode ?? (top[0] as { errorCode?: string } | undefined)?.errorCode ?? "APPLICATION_FAILED",
      error: `Salesforce didn't apply the payment${created.length ? ` to every target (${created.length} of ${targets.length} applied)` : ""}: ${top.map(e => `${"label" in e && e.label ? `${e.label}: ` : ""}${e.message ?? ""}`).filter(Boolean).join("; ") || res.statusText}`,
      created, technical: res.json ?? res.rawText,
    };
  }
  return { ok: true, created };
}

/** Apply to the targets the invoice's settlement level calls for; if Salesforce answers that it needs Invoice
 * Line Ids, re-allocate to the open invoice lines and try once more. Returns the targets actually used. */
async function applyToInvoice(client: SalesforceClient, paymentId: string, invoice: PaymentInvoice, amount: number, date: string | null): Promise<ApplyResult & { targets: { id: string; label: string; amount: number }[] }> {
  const first = allocatePayment(invoice, amount);
  if (!first.targets.length || cents(first.unallocated) > 0) return { ok: false, status: 422, code: "ALLOCATION_FAILED", error: "The invoice's open balance doesn't cover this amount.", created: [], technical: null, targets: first.targets };
  const r1 = await applyAction(client, paymentId, first.targets, date);
  if (r1.ok || invoice.applyTo === "lines" || r1.created.length || !/invoice line id/i.test(r1.error)) return { ...r1, targets: first.targets };
  const lines = allocatePayment({ ...invoice, applyTo: "lines" }, amount);
  if (!lines.targets.length || cents(lines.unallocated) > 0) return { ...r1, targets: first.targets };
  const r2 = await applyAction(client, paymentId, lines.targets, date);
  return { ...r2, targets: lines.targets, ...(r2.ok ? {} : { error: `${r1.error} → per invoice line: ${(r2 as { error: string }).error}` }) };
}

/** Compensation for a payment this request created but Salesforce wouldn't apply: delete it when Salesforce allows
 * that, otherwise cancel it (Status → the org's "Canceled" value + CancellationDate) so it is never counted as received. */
async function compensatePayment(client: SalesforceClient, paymentId: string, model: PaymentModel): Promise<{ outcome: "deleted" | "canceled" | "kept"; reason: string | null }> {
  const still = activeApplications(await applicationsFor(client, { paymentIds: [paymentId] }));
  if (still.length) return { outcome: "kept", reason: "The payment already has applications." };
  const del = await client.requestWithDiagnostics(`/sobjects/Payment/${paymentId}`, { method: "DELETE" });
  if (del.status === 204) return { outcome: "deleted", reason: null };
  const delReason = (Array.isArray(del.json) ? (del.json as { message?: string }[]) : []).map(i => i.message).filter(Boolean).join("; ") || del.statusText;
  const canceled = model.statusValues.find(v => /^cancel+ed$/i.test(v));
  if (!canceled) return { outcome: "kept", reason: delReason };
  // Status first — Salesforce rejects CancellationDate while the payment is still Processed.
  const upd = await client.requestWithDiagnostics(`/sobjects/Payment/${paymentId}`, { method: "PATCH", body: JSON.stringify({ Status: canceled }) });
  if (upd.status === 204) {
    const pd = await billingDescribe(client, "Payment");
    if (has(pd, "CancellationDate")) await client.requestWithDiagnostics(`/sobjects/Payment/${paymentId}`, { method: "PATCH", body: JSON.stringify({ CancellationDate: new Date().toISOString() }) }).catch(() => null);
    return { outcome: "canceled", reason: delReason };
  }
  return { outcome: "kept", reason: `${delReason}; cancel failed: ${(Array.isArray(upd.json) ? (upd.json as { message?: string }[]) : []).map(i => i.message).join("; ") || upd.statusText}` };
}

/** Once Salesforce has refused to apply payments for this user, block new payments up front (so no more unapplied
 * payments get created) until the user's payment permission-set assignments change. */
// On globalThis: Next.js bundles each route separately, so module-level state isn't shared between routes.
const applicationBlocks = ((globalThis as { __rcbPaymentBlocks?: Map<string, { fingerprint: string; reason: string; at: number }> }).__rcbPaymentBlocks ??= new Map());
const permFingerprint = (m: PaymentModel) => m.permissions.filter(p => p.assigned).map(p => p.name).sort().join(",");
async function blockKey(client: SalesforceClient) { return `${client.instanceUrl}:${(await currentUserId(client)) ?? "?"}`; }
export async function applicationBlock(client: SalesforceClient, model: PaymentModel): Promise<{ reason: string; at: number } | null> {
  const key = await blockKey(client);
  const b = applicationBlocks.get(key);
  if (!b) return null;
  if (b.fingerprint !== permFingerprint(model)) { applicationBlocks.delete(key); return null; }
  return { reason: b.reason, at: b.at };
}
async function rememberBlock(client: SalesforceClient, model: PaymentModel, reason: string) {
  applicationBlocks.set(await blockKey(client), { fingerprint: permFingerprint(model), reason, at: Date.now() });
}

async function doRecordPayment(client: SalesforceClient, input: PaymentInput, key: string): Promise<PaymentOutcome> {
  const steps: string[] = [];
  const m = await getPaymentModel(client);

  // 1. Already created with this key (double click / retry)? Return it — never a second payment.
  const existingId = await findByKey(client, key);
  if (existingId) {
    const detail = await getPaymentDetail(client, existingId);
    const applied = activeApplications(detail.applications).some(a => a.invoice?.id.slice(0, 15) === input.invoiceId.slice(0, 15));
    const invoice = await loadInvoiceForPayment(client, input.invoiceId, m);
    if (applied) return { ok: true, status: 200, duplicate: true, message: "Payment already exists / has already been applied.", payment: detail, invoice, applicationCreated: false, steps: [`Found existing payment ${detail.payment.number} for this request`] };
    if (/^cancel+ed$/i.test(detail.payment.status ?? "")) return { ok: false, status: 409, code: "PAYMENT_CANCELED", error: `Payment ${detail.payment.number} for this request was canceled because Salesforce wouldn't apply it. Start a new payment from the latest invoice state.`, payment: detail, invoice };
    return { ok: false, status: 409, code: "PAYMENT_NOT_APPLIED", error: `Payment ${detail.payment.number} was already created for this request but isn't applied to the invoice yet — apply it instead of recording another payment.`, payment: detail, invoice };
  }

  // 2. Re-read and re-validate the invoice; reject stale state.
  const preview = await validatePayment(client, input, m);
  if (input.invoiceToken && input.invoiceToken !== preview.invoice.token) {
    return { ok: false, status: 409, code: "INVOICE_CHANGED", error: "The invoice balance changed while you were preparing this payment. Refresh and review the updated balance.", invoice: preview.invoice, preview };
  }
  if (input.level === "lines" || input.allocation?.length) {
    const probe = await probeLineApplication(client, { fresh: true });
    if (probe.state === "unavailable") return { ok: false, status: 403, code: "SETTLEMENT_NOT_ENABLED", error: "Payment settlement is not currently enabled for this Salesforce user. No payment was created.", possibleCause: `Your Salesforce user needs the required Billing Advanced / Payment Operations permission to apply payments to invoice lines. Salesforce: "${probe.detail}"`, invoice: preview.invoice, preview };
  }
  const blocked = await applicationBlock(client, m);
  if (blocked) return { ok: false, status: 403, code: "APPLICATION_NOT_PERMITTED", error: `Payment application isn't permitted for your user in this org (Salesforce: ${blocked.reason.replace(/^Salesforce didn't apply the payment: /, "")}). No payment was created.`, possibleCause: applicationPermissionHint(m, blocked.reason), invoice: preview.invoice, preview };
  if (!preview.valid || !preview.preview) return { ok: false, status: 400, code: "INVALID_PAYMENT", error: preview.errors.join(" "), invoice: preview.invoice, preview };
  if (preview.similar.length && !input.allowSimilar) {
    return { ok: false, status: 409, code: "POSSIBLE_DUPLICATE", error: `${preview.warnings.find(w => w.startsWith("A payment of the same amount")) ?? "A similar payment already exists."} Confirm that this is a separate payment to continue.`, invoice: preview.invoice, preview };
  }
  steps.push(`Invoice ${preview.invoice.number} re-read: ${preview.invoice.status}, balance ${preview.invoice.balance}`);

  // 3. Create the Payment.
  const pd = await billingDescribe(client, "Payment");
  const p = preview.preview;
  const body: Record<string, unknown> = { Amount: p.amount, Status: p.status, Type: p.type, ProcessingMode: p.processingMode, AccountId: p.account!.id };
  if (has(pd, "Date")) body.Date = `${p.paymentDate}T12:00:00.000Z`;
  if (has(pd, "EffectiveDate")) body.EffectiveDate = `${p.paymentDate}T12:00:00.000Z`;
  if (p.paymentMethod && has(pd, "PaymentMethodId")) body.PaymentMethodId = p.paymentMethod.id;
  if (input.comments?.trim() && has(pd, "Comments")) body.Comments = input.comments.trim().slice(0, 1000);
  if (has(pd, "PaymentIntentGuid")) body.PaymentIntentGuid = key;
  const created = await client.requestWithDiagnostics("/sobjects/Payment", { method: "POST", body: JSON.stringify(body) });
  const createdId = (created.json as { id?: string } | null)?.id;
  if (created.status >= 400 || !createdId) {
    const again = await findByKey(client, key); // a concurrent request may have won the race
    if (again) return doRecordPayment(client, input, key);
    const items: SalesforceErrorItem[] = Array.isArray(created.json) ? (created.json as SalesforceErrorItem[]) : [{ message: created.rawText || created.statusText }];
    const sum = summarizeSalesforceErrors(items, { objectLabel: "Payment" });
    return { ok: false, status: created.status === 403 ? 403 : created.status === 401 ? 401 : 422, code: sum.code ?? "PAYMENT_CREATE_FAILED", error: `Salesforce didn't create the payment: ${sum.message}`, possibleCause: sum.possibleCause, invoice: preview.invoice, technical: { request: body, response: created.json ?? created.rawText } };
  }
  steps.push(`Payment created (${createdId})`);

  // 4. Apply — unless Salesforce already applied it on its own.
  let applicationCreated = false;
  const auto = activeApplications(await applicationsFor(client, { paymentIds: [createdId] }));
  if (auto.length) steps.push("Salesforce applied the payment automatically — no extra application created");
  else {
    const applied = p.applyTo === "lines" && (input.level === "lines" || input.allocation?.length)
      ? { ...(await applyAction(client, createdId, p.allocation, p.paymentDate)), targets: p.allocation }
      : await applyToInvoice(client, createdId, preview.invoice, p.applied, p.paymentDate);
    if (!applied.ok) {
      const detail = await getPaymentDetail(client, createdId);
      const comp = await compensatePayment(client, createdId, m);
      if (applicationPermissionHint(m, applied.error)) await rememberBlock(client, m, applied.error);
      return {
        ok: false, status: applied.status, code: applied.code,
        possibleCause: applicationPermissionHint(m, applied.error),
        error: (input.level === "lines" || input.allocation?.length ? "Payment settlement failed. Salesforce could not apply the payment to the invoice line. " : "") + (comp.outcome === "deleted" ? `${applied.error} Nothing was recorded — the payment was removed.`
          : comp.outcome === "canceled" ? `${applied.error} Payment ${detail.payment.number} was canceled in Salesforce (it can't be deleted) — nothing was received or applied.`
          : `${applied.error} Payment ${detail.payment.number} exists but is not applied — finish it from Payment details.`),
        payment: comp.outcome === "deleted" ? undefined : await getPaymentDetail(client, createdId), invoice: await loadInvoiceForPayment(client, preview.invoice.id, m),
        technical: { application: applied.technical, compensation: comp, paymentNumber: detail.payment.number },
      };
    }
    p.allocation = applied.targets;
    applicationCreated = true;
    steps.push(`Applied via ${APPLY_ACTION} (${p.allocation.map(t => `${t.label} ${t.amount}`).join(", ")})`);
  }

  // 5. Re-query Salesforce for the authoritative result.
  const detail = await getPaymentDetail(client, createdId);
  const invoice = await loadInvoiceForPayment(client, preview.invoice.id, m);
  steps.push(`Invoice ${invoice.number}: balance ${invoice.balance}, settlement ${invoice.settlementStatus ?? "—"}`);
  return { ok: true, status: 201, duplicate: false, message: `Payment ${detail.payment.number} recorded and applied to ${invoice.number}.`, payment: detail, invoice, applicationCreated, steps };
}

/** Apply an existing (unapplied) payment to an invoice — recovery path when the application step failed. */
export async function applyExistingPayment(client: SalesforceClient, paymentId: string, input: { invoiceId: string; amount?: number | null; invoiceToken?: string | null; level?: "lines" | null; allocation?: { lineId: string; amount: number }[] | null }): Promise<PaymentOutcome> {
  const m = await getPaymentModel(client);
  const detail = await getPaymentDetail(client, paymentId);
  const invoice = await loadInvoiceForPayment(client, input.invoiceId, m);
  if (input.invoiceToken && input.invoiceToken !== invoice.token) return { ok: false, status: 409, code: "INVOICE_CHANGED", error: "The invoice balance changed while you were preparing this payment. Refresh and review the updated balance.", invoice, payment: detail };
  if (!invoice.eligible) return { ok: false, status: 422, code: "INVOICE_NOT_ELIGIBLE", error: invoice.reasons.join(" "), invoice, payment: detail };
  if (detail.payment.account && invoice.account && detail.payment.account.id !== invoice.account.id) return { ok: false, status: 400, code: "ACCOUNT_MISMATCH", error: "The payment and the invoice belong to different accounts.", invoice, payment: detail };
  const unapplied = detail.payment.balance ?? detail.payment.unapplied ?? 0;
  if (cents(unapplied) <= 0) return { ok: true, status: 200, duplicate: true, message: "Payment already exists / has already been applied.", payment: detail, invoice, applicationCreated: false, steps: [] };
  const amount = Math.round(Math.min(input.amount ?? unapplied, unapplied, invoice.balance ?? 0) * 100) / 100;
  if (!(amount > 0)) return { ok: false, status: 400, code: "INVALID_PAYMENT", error: "Nothing to apply.", invoice, payment: detail };
  const lineMode = input.level === "lines" || !!input.allocation?.length;
  if (lineMode) {
    const probe = await probeLineApplication(client, { fresh: true });
    if (probe.state === "unavailable") return { ok: false, status: 403, code: "SETTLEMENT_NOT_ENABLED", error: "Payment settlement is not currently enabled for this Salesforce user. Nothing was applied.", possibleCause: `Your Salesforce user needs the required Billing Advanced / Payment Operations permission to apply payments to invoice lines. Salesforce: "${probe.detail}"`, invoice, payment: detail };
  }
  const lineAlloc = lineMode ? resolveLineAllocation(invoice, amount, input.allocation) : null;
  if (lineAlloc?.error) return { ok: false, status: 400, code: "INVALID_ALLOCATION", error: lineAlloc.error, invoice, payment: detail };
  const applied = lineAlloc ? { ...(await applyAction(client, paymentId, lineAlloc.targets, null)), targets: lineAlloc.targets } : await applyToInvoice(client, paymentId, invoice, amount, null);
  const allocation = { targets: applied.targets };
  if (!applied.ok && applicationPermissionHint(m, applied.error)) await rememberBlock(client, m, applied.error);
  if (!applied.ok) return { ok: false, status: applied.status, code: applied.code, error: applied.error, possibleCause: applicationPermissionHint(m, applied.error), invoice: await loadInvoiceForPayment(client, invoice.id, m), payment: await getPaymentDetail(client, paymentId), technical: applied.technical };
  const after = await getPaymentDetail(client, paymentId);
  const inv = await loadInvoiceForPayment(client, invoice.id, m);
  return { ok: true, status: 201, duplicate: false, message: `Applied ${amount} of ${after.payment.number} to ${inv.number}.`, payment: after, invoice: inv, applicationCreated: true, steps: [`Applied via ${APPLY_ACTION} (${allocation.targets.map(t => `${t.label} ${t.amount}`).join(", ")})`] };
}

/* ───────────────────────────── AI interpretation (no mutations) ───────────────────────────── */

export const PAYMENT_AI_SYSTEM = `You extract a payment instruction for Salesforce Revenue Cloud Billing.
Return ONLY a JSON object: {"invoiceNumber": string|null, "amount": number|null, "paymentDate": "YYYY-MM-DD"|null, "paymentMethodName": string|null, "comments": string|null, "allocationMode": "auto"|"manual", "notes": string[]}.
- allocationMode: "manual" only when the user explicitly wants to split the amount across specific invoice lines themselves; otherwise "auto". Never output invoice line Ids or allocations.
- invoiceNumber exactly as the user wrote it (e.g. "DOC-000000001"). amount as a plain number; "full"/"remaining balance" → null and add a note "full balance".
- Never invent Salesforce Ids, invoices, accounts, payment methods or fields. Unmappable details go into "notes".`;

export interface PaymentAiResult {
  success: true;
  extraction: { invoiceNumber: string | null; amount: number | null; paymentDate: string | null; paymentMethodName: string | null; comments: string | null; allocationMode: "auto" | "manual" };
  invoice: PaymentInvoice | null;
  invoiceMessage: string | null;
  amount: number | null;
  paymentDate: string | null;
  paymentMethod: { id: string; name: string } | null;
  comments: string | null;
  warnings: string[];
  validation: PaymentPreview | null;
}

export async function analyzePaymentPrompt(client: SalesforceClient, extract: (system: string, prompt: string) => Promise<Record<string, unknown>>, prompt: string): Promise<PaymentAiResult> {
  const out = await extract(PAYMENT_AI_SYSTEM, `Today is ${today()}.\nUser instruction: ${prompt}`);
  const m = await getPaymentModel(client);
  const warnings: string[] = Array.isArray(out.notes) ? out.notes.filter((n): n is string => typeof n === "string" && !!n.trim()) : [];
  const extraction = {
    invoiceNumber: str(out.invoiceNumber)?.trim() || null,
    amount: typeof out.amount === "number" && Number.isFinite(out.amount) ? out.amount : typeof out.amount === "string" && out.amount.trim() && !Number.isNaN(Number(out.amount)) ? Number(out.amount) : null,
    paymentDate: str(out.paymentDate)?.trim() || null,
    paymentMethodName: str(out.paymentMethodName)?.trim() || null,
    comments: str(out.comments)?.trim() || null,
    allocationMode: out.allocationMode === "manual" ? "manual" as const : "auto" as const,
  };
  if (out.allocation !== undefined || out.invoiceLineIds !== undefined || out.lines !== undefined) warnings.push("Ignored line allocations from the AI — allocations are computed against the invoice's real Salesforce lines.");
  // Resolve the invoice by its number — never by an Id the model produced.
  let invoice: PaymentInvoice | null = null;
  let invoiceMessage: string | null = null;
  if (!extraction.invoiceNumber) invoiceMessage = "No invoice number was found in the instruction — choose the invoice.";
  else if (SALESFORCE_ID.test(extraction.invoiceNumber) && !/-/.test(extraction.invoiceNumber)) invoiceMessage = `"${extraction.invoiceNumber}" looks like a record Id — refer to the invoice by its number.`;
  else {
    const rows = await q(client, `SELECT Id FROM Invoice WHERE DocumentNumber = '${soqlEscape(extraction.invoiceNumber)}' LIMIT 2`);
    if (rows.length === 1) invoice = await loadInvoiceForPayment(client, rows[0].Id as string, m);
    else invoiceMessage = rows.length ? `"${extraction.invoiceNumber}" matches more than one invoice.` : `Invoice "${extraction.invoiceNumber}" was not found in Salesforce.`;
  }
  let amount = extraction.amount !== null ? Math.round(extraction.amount * 100) / 100 : null;
  if (amount === null && invoice && warnings.some(w => /full balance/i.test(w))) amount = invoice.balance;
  let paymentDate = extraction.paymentDate;
  if (paymentDate && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) { warnings.push(`Ignored the payment date "${paymentDate}" — not a valid date.`); paymentDate = null; }
  let paymentMethod: { id: string; name: string } | null = null;
  if (extraction.paymentMethodName) {
    const want = extraction.paymentMethodName.toLowerCase();
    const hits = m.paymentMethods.filter(p => p.name.toLowerCase() === want || (p.type ?? "").toLowerCase() === want);
    if (hits.length === 1) paymentMethod = { id: hits[0].id, name: hits[0].name };
    else warnings.push(m.paymentMethods.length ? `Payment method "${extraction.paymentMethodName}" didn't match exactly one active Payment Method.` : `Payment method "${extraction.paymentMethodName}" ignored — no payment methods are configured in this Salesforce org.`);
  }
  const validation = invoice && amount !== null ? await validatePayment(client, { invoiceId: invoice.id, amount, paymentDate, paymentMethodId: paymentMethod?.id ?? null }, m) : null;
  return { success: true, extraction, invoice, invoiceMessage, amount, paymentDate, paymentMethod, comments: extraction.comments, warnings, validation };
}
