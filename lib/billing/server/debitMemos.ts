import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { buildSalesforceRecordUrl } from "@/lib/salesforce/recordUrl";
import {
  compositeAt, currencyMatches, describeAt, friendlySalesforceError, latestApiVersion, orgCurrency, queryAt, resolveAccount, resolveInvoice, resolveProduct,
  SalesforceCallError, type AccountRef, type InvoiceRef, type OrgCurrency, type ProductRef,
} from "@/lib/billing/server/billingDocuments";
import { BadInputError, NotFoundError } from "@/lib/billing/server/payments";

/**
 * REVENUE CLOUD BILLING — DEBIT MEMOS. Verified against the connected org and the Revenue Management Developer Guide:
 *
 *   DebitMemo (API 65.0+ — not visible on the app's v64 default, so calls use the org's newest version)
 *     required: AccountId, Status [Draft|Posted|Pending|Error|Canceled|Void], InvoiceGenerationStatus
 *     Description, ReasonCode (dynamic picklist), NextBillingDate, InvoiceMatchingRefKeyId (Product2/Asset)
 *     TotalChargeAmount = Σ line ChargeAmount (calculated). "An invoice is generated for the debit memo in the next
 *     invoice run" — a debit memo is billed, not applied to an existing invoice.
 *   DebitMemoLine — required: Name, DebitMemoId (master-detail), ChargeAmount. Product2Id, Description,
 *     ReferenceRecordId → InvoiceLine/Asset/Contract/Refund/CreditMemoLine. There is NO quantity/unit-price field:
 *     the app validates qty × unit price = ChargeAmount and records it in the line description.
 *     Invoice association is therefore line-level (ReferenceRecordId → the invoice's InvoiceLine).
 *   No Connect API / invocable action exists for debit memos in this org (probed: 404) — the sObject API is used,
 *   as one all-or-nothing Composite request (header + lines), so a failed line never leaves a partial debit memo.
 *   Access (guide): Billing Admin, Billing Operations User, Payments Admin/Operation User or Credit Memo Operations User.
 */

const MIN_VERSION = 65;
const KEY_RE = /^[A-Za-z0-9-]{16,64}$/;
const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const cents = (n: number) => Math.round(n * 100);
const round2 = (n: number) => Math.round(n * 100) / 100;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(/[,\s]/g, ""))) ? Number(v.replace(/[,\s]/g, "")) : null);
const today = () => new Date().toISOString().slice(0, 10);
const refTag = (key: string) => `[ref:${key}]`;

/* ───────────────────────────── Model ───────────────────────────── */

export interface DebitMemoModel {
  success: true;
  available: boolean;
  reason: string | null;
  apiVersion: string;
  statusValues: string[];
  invoiceGenerationValues: string[];
  reasonCodes: string[];
  createStatus: string | null;
  required: { debitMemo: string[]; line: string[] };
  currency: OrgCurrency;
  limits: { description: number; lineName: number; lineDescription: number };
}

const picklist = (d: { fields: { name: string; picklistValues?: { value: string; active: boolean }[] }[] } | null, f: string) => d?.fields.find(x => x.name === f)?.picklistValues?.filter(p => p.active).map(p => p.value) ?? [];

export async function getDebitMemoModel(client: SalesforceClient): Promise<DebitMemoModel> {
  const version = await latestApiVersion(client);
  const currency = await orgCurrency(client);
  const base = { success: true as const, apiVersion: version, currency, statusValues: [] as string[], invoiceGenerationValues: [] as string[], reasonCodes: [] as string[], createStatus: null, required: { debitMemo: [] as string[], line: [] as string[] }, limits: { description: 255, lineName: 80, lineDescription: 255 } };
  if (Number(version.replace(/^v/, "")) < MIN_VERSION) return { ...base, available: false, reason: `Debit memos need Salesforce API ${MIN_VERSION}.0 or later; this org's newest is ${version}.` };
  const [dm, line] = await Promise.all([describeAt(client, version, "DebitMemo"), describeAt(client, version, "DebitMemoLine")]);
  if (!dm || !line) return { ...base, available: false, reason: "Debit memos aren't available in this Salesforce org (or to your user)." };
  const required = (d: typeof dm) => d.fields.filter(f => f.createable && !f.nillable && !f.defaultedOnCreate && f.type !== "boolean").map(f => f.name);
  const statusValues = picklist(dm, "Status");
  const createable = (d: typeof dm) => (d as unknown as { createable?: boolean }).createable !== false;
  const len = (d: typeof dm, f: string, dflt: number) => d.fields.find(x => x.name === f)?.length || dflt;
  return {
    ...base,
    available: createable(dm) && createable(line),
    reason: createable(dm) && createable(line) ? null : "Your Salesforce user can't create debit memos (DebitMemo / DebitMemoLine aren't createable).",
    statusValues, invoiceGenerationValues: picklist(dm, "InvoiceGenerationStatus"), reasonCodes: picklist(dm, "ReasonCode"),
    createStatus: statusValues.find(s => /^draft$/i.test(s)) ?? null,
    required: { debitMemo: required(dm), line: required(line) },
    limits: { description: len(dm, "Description", 255), lineName: len(line, "Name", 80), lineDescription: len(line, "Description", 255) },
  };
}

/* ───────────────────────────── Draft → resolution ───────────────────────────── */

export interface DebitDraftLine { description?: string | null; productId?: string | null; productName?: string | null; quantity?: number | string | null; unitPrice?: number | string | null; amount?: number | string | null; invoiceLineId?: string | null }
export interface DebitDraft {
  accountId?: string | null; accountName?: string | null;
  invoiceId?: string | null; invoiceNumber?: string | null;
  currency?: string | null; reason?: string | null; reasonCode?: string | null;
  totalAmount?: number | string | null;
  lines?: DebitDraftLine[];
  billOnNextRun?: boolean;
  /** YYYY-MM-DD when the user named a billing date; otherwise resolved before posting (account billing date, else today). */
  nextBillingDate?: string | null;
}

export interface DebitIssue { field: string; severity: "error" | "warning" | "info"; message: string }
export interface ResolvedLine {
  index: number; description: string; quantity: number | null; unitPrice: number | null; amount: number | null;
  product: ProductRef | null; productCandidates: ProductRef[]; productQuery: string | null;
  invoiceLine: { id: string; name: string | null; product: string | null } | null;
  assumptions: string[];
}
export interface DebitResolution {
  success: true;
  valid: boolean;
  requiresInput: boolean;
  missingFields: string[];
  message: string;
  issues: DebitIssue[];
  account: AccountRef | null; accountCandidates: AccountRef[];
  invoice: (InvoiceRef & { eligible: boolean }) | null;
  currency: { supplied: string | null; org: OrgCurrency; matches: boolean | null };
  reason: string | null; reasonCode: string | null;
  lines: ResolvedLine[];
  totalAmount: number | null; computedTotal: number;
  billOnNextRun: boolean;
  nextBillingDate: string | null;
  createAs: { status: string | null; invoiceGenerationStatus: string | null };
}

/**
 * Resolve every name/number against Salesforce and validate the debit memo. Read-only. Ids in the draft come only
 * from the UI's own pickers (the AI never supplies Ids) and are re-verified here.
 */
export async function resolveDebitDraft(client: SalesforceClient, draft: DebitDraft, model?: DebitMemoModel): Promise<DebitResolution> {
  const m = model ?? await getDebitMemoModel(client);
  const issues: DebitIssue[] = [];
  const missing: string[] = [];
  const err = (field: string, message: string) => issues.push({ field, severity: "error", message });

  if (!m.available) err("availability", m.reason ?? "Debit memos aren't available.");

  // Invoice (by number, or an Id chosen in the UI).
  let invoice: (InvoiceRef & { eligible: boolean }) | null = null;
  const invRef = str(draft.invoiceId) ?? str(draft.invoiceNumber);
  if (invRef) {
    const r = await resolveInvoice(client, invRef, { allowId: !!str(draft.invoiceId) });
    if (r.status === "found") {
      const eligible = /^(split )?posted$/i.test(r.record.status ?? "");
      invoice = { ...r.record, eligible };
      if (!eligible) err("invoice", `Invoice ${r.record.number} is "${r.record.status ?? "—"}" — a debit memo can reference only a Posted invoice.`);
    } else err("invoice", r.message);
  }

  // Account (by name, an Id chosen in the UI, or the invoice's billing account).
  let account: AccountRef | null = null;
  let accountCandidates: AccountRef[] = [];
  const accId = str(draft.accountId);
  if (accId) {
    if (!SFID.test(accId)) err("account", "Invalid account.");
    else {
      const rows = await queryAt(client, client.apiVersion, `SELECT Id, Name FROM Account WHERE Id = '${soqlEscape(accId)}' LIMIT 1`);
      if (rows[0]) account = { id: rows[0].Id as string, name: String(rows[0].Name) }; else err("account", "That account no longer exists in Salesforce.");
    }
  } else if (str(draft.accountName)) {
    const r = await resolveAccount(client, draft.accountName!);
    if (r.status === "found") account = r.record;
    else if (r.status === "multiple") { accountCandidates = r.candidates; err("account", r.message); }
    else err("account", r.status === "invalid" ? r.message : r.message);
  } else if (invoice?.account) {
    account = invoice.account;
    issues.push({ field: "account", severity: "info", message: `Account taken from invoice ${invoice.number}: ${invoice.account.name}.` });
  } else missing.push("Account");
  if (account && invoice?.account && invoice.account.id !== account.id) err("invoice", `Invoice ${invoice.number} belongs to ${invoice.account.name}, not ${account.name}. Choose an invoice of ${account.name} or the right account.`);

  // Currency — the org is single-currency; a different currency in the request is rejected, not converted.
  const org = m.currency;
  const supplied = str(draft.currency);
  const matches = supplied ? currencyMatches(org, supplied) : null;
  if (supplied && matches === false) err("currency", `The request is in ${supplied}, but this Salesforce org bills in ${org.code ?? org.symbol ?? "a different currency"}.`);

  // Lines.
  const total = numOrNull(draft.totalAmount);
  let rawLines = (draft.lines ?? []).filter(l => l && (str(l.description) || str(l.productName) || str(l.productId) || numOrNull(l.amount) !== null || numOrNull(l.unitPrice) !== null));
  if (!rawLines.length && total !== null) rawLines = [{ description: str(draft.reason) ?? "Additional charge", amount: total, quantity: 1 }];
  if (!rawLines.length) missing.push("Debit Memo Amount");
  const lines: ResolvedLine[] = [];
  for (const [i, l] of rawLines.entries()) {
    const n = rawLines.length > 1 ? ` (line ${i + 1})` : "";
    const assumptions: string[] = [];
    let product: ProductRef | null = null;
    let productCandidates: ProductRef[] = [];
    const pid = str(l.productId), pname = str(l.productName);
    if (pid) {
      const rows = SFID.test(pid) ? await queryAt(client, client.apiVersion, `SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Id = '${soqlEscape(pid)}' LIMIT 1`) : [];
      if (!rows[0]) err(`lines.${i}.product`, `The selected product${n} no longer exists.`);
      else { product = { id: rows[0].Id as string, name: String(rows[0].Name), code: (rows[0].ProductCode as string) ?? null, active: rows[0].IsActive === true }; if (!product.active) err(`lines.${i}.product`, `Product "${product.name}"${n} is inactive in Salesforce.`); }
    } else if (pname) {
      const r = await resolveProduct(client, pname);
      if (r.status === "found") product = r.record;
      else if (r.status === "multiple") { productCandidates = r.candidates; err(`lines.${i}.product`, `${r.message}${n}`); }
      else err(`lines.${i}.product`, `${r.message}${n} Choose a product or remove it to bill the line as a description-only charge.`);
    }
    let qty = numOrNull(l.quantity);
    const up = numOrNull(l.unitPrice);
    let amount = numOrNull(l.amount);
    if (qty === null) { qty = 1; if (up !== null || amount !== null) assumptions.push("Quantity 1 (not stated)."); }
    let unitPrice = up;
    if (!(qty > 0)) err(`lines.${i}.quantity`, `Quantity${n} must be greater than zero.`);
    if (unitPrice !== null && !(unitPrice > 0)) err(`lines.${i}.unitPrice`, `Unit price${n} must be greater than zero.`);
    if (unitPrice !== null && qty > 0) {
      const computed = round2(qty * unitPrice);
      if (amount !== null && cents(amount) !== cents(computed)) err(`lines.${i}.amount`, `Line amount${n} ${amount} doesn't equal quantity × unit price (${qty} × ${unitPrice} = ${computed}).`);
      amount = computed;
    } else if (amount !== null && qty > 0) unitPrice = round2(amount / qty);
    if (amount === null) missing.push(`Amount${n}`);
    else if (!(amount > 0)) err(`lines.${i}.amount`, `Amount${n} must be greater than zero.`);

    // Invoice association is line-level (DebitMemoLine.ReferenceRecordId → InvoiceLine).
    let invoiceLine: ResolvedLine["invoiceLine"] = null;
    if (invoice) {
      const chosen = str(l.invoiceLineId);
      if (chosen) {
        const hit = invoice.lines.find(x => x.id === chosen || x.id.slice(0, 15) === chosen.slice(0, 15));
        if (hit) invoiceLine = { id: hit.id, name: hit.name, product: hit.product }; else err(`lines.${i}.invoiceLine`, `The selected invoice line${n} isn't on invoice ${invoice.number}.`);
      } else if (product && invoice.lines.filter(x => x.productId === product!.id).length === 1) {
        const hit = invoice.lines.find(x => x.productId === product!.id)!;
        invoiceLine = { id: hit.id, name: hit.name, product: hit.product };
        assumptions.push(`Linked to invoice line ${hit.name ?? hit.product} (same product).`);
      } else if (invoice.lines.length === 1) {
        invoiceLine = { id: invoice.lines[0].id, name: invoice.lines[0].name, product: invoice.lines[0].product };
        assumptions.push(`Linked to the invoice's only line (${invoiceLine.name ?? invoiceLine.product}).`);
      } else err(`lines.${i}.invoiceLine`, `Choose which line of invoice ${invoice.number} this charge${n} relates to — Salesforce links debit memo lines to invoice lines.`);
    }
    const description = str(l.description) ?? product?.name ?? str(draft.reason) ?? "Additional charge";
    lines.push({ index: i, description, quantity: qty, unitPrice, amount: amount === null ? null : round2(amount), product, productCandidates, productQuery: pname, invoiceLine, assumptions });
  }
  const computedTotal = round2(lines.reduce((s, l) => s + (l.amount ?? 0), 0));
  if (total !== null && lines.length && lines.every(l => l.amount !== null) && cents(total) !== cents(computedTotal)) err("totalAmount", `The debit memo total ${total} doesn't equal the sum of its lines (${computedTotal}).`);

  const reason = str(draft.reason);
  if (reason && reason.length > m.limits.description - 45) err("reason", `Keep the reason under ${m.limits.description - 45} characters.`);
  const reasonCode = str(draft.reasonCode);
  if (reasonCode && !m.reasonCodes.includes(reasonCode)) err("reasonCode", `"${reasonCode}" isn't a debit memo reason code in this org.`);
  if (!m.createStatus) err("status", "This org's DebitMemo Status picklist has no Draft value.");
  const billOnNextRun = draft.billOnNextRun === true;
  const igs = billOnNextRun ? m.invoiceGenerationValues.find(v => /^ready for invoice generation$/i.test(v)) ?? null : m.invoiceGenerationValues.find(v => /^none$/i.test(v)) ?? null;
  if (!igs) err("invoiceGenerationStatus", "This org's InvoiceGenerationStatus picklist doesn't have the expected value.");
  // A billing date the user named must be a real calendar date; Salesforce itself validates it when the memo is posted.
  const nbdRaw = str(draft.nextBillingDate);
  const nextBillingDate = nbdRaw && /^\d{4}-\d{2}-\d{2}$/.test(nbdRaw) && !Number.isNaN(Date.parse(`${nbdRaw}T00:00:00Z`)) && new Date(`${nbdRaw}T00:00:00Z`).toISOString().slice(0, 10) === nbdRaw ? nbdRaw : null;
  if (nbdRaw && !nextBillingDate) err("nextBillingDate", `"${nbdRaw}" isn't a valid billing date (use YYYY-MM-DD).`);

  const errors = issues.filter(x => x.severity === "error");
  const requiresInput = missing.length > 0;
  return {
    success: true, valid: !requiresInput && errors.length === 0, requiresInput, missingFields: missing,
    message: requiresInput ? `Please provide the ${missing.join(" and ").replace(/Debit Memo Amount/, "debit amount").toLowerCase()}.` : errors.length ? errors[0].message : "Ready to create.",
    issues, account, accountCandidates, invoice,
    currency: { supplied, org, matches },
    reason, reasonCode, lines, totalAmount: total, computedTotal, billOnNextRun, nextBillingDate,
    createAs: { status: m.createStatus, invoiceGenerationStatus: igs },
  };
}

/* ───────────────────────────── AI interpretation (no mutations) ───────────────────────────── */

export const DEBIT_AI_SYSTEM = `You interpret a request to create a Salesforce Revenue Cloud Billing DEBIT MEMO (an additional charge billed to a customer).
Return ONLY a JSON object:
{"isDebitMemo": boolean, "accountName": string|null, "invoiceNumber": string|null, "currency": string|null, "reason": string|null, "totalAmount": number|null,
 "lines": [{"description": string|null, "productName": string|null, "quantity": number|null, "unitPrice": number|null, "amount": number|null}],
 "lifecycle": "draft"|"posted"|"invoiced"|"settled", "nextBillingDate": string|null, "notes": string[]}
Rules:
- isDebitMemo=false for anything that isn't a request to charge a customer more (e.g. refunds/credits, questions).
- Copy names and numbers exactly as written. NEVER output Salesforce Ids, and never invent accounts, invoices, products, prices, quantities or dates.
- currency: the symbol/code/word the user used (e.g. "₹", "INR"), else null. Amounts are plain numbers (₹5,000 → 5000).
- One line per distinct charge. productName only when the user names a product/service; description is a short label.
- lifecycle: how far the user wants the billing process to go — "draft" (create only / leave as Draft — the default when not stated), "posted" (create and post only), "invoiced" (bill it in the standard billing cycle — also when the user says "invoice it now"; it is billed in the next billing run), "settled" (also collect the payment and settle the invoice).
- nextBillingDate: YYYY-MM-DD only when the user states a billing date (resolve relative dates like "tomorrow" only if unambiguous); else null.
- Leave unknown values null — do not guess. Put anything you couldn't map into "notes".`;

export interface DebitInterpretation extends DebitResolution {
  extraction: { isDebitMemo: boolean; accountName: string | null; invoiceNumber: string | null; currency: string | null; reason: string | null; totalAmount: number | null; lines: DebitDraftLine[]; lifecycle: "draft" | "posted" | "invoiced" | "settled"; nextBillingDate: string | null };
  draft: DebitDraft;
  warnings: string[];
}

export async function interpretDebitPrompt(client: SalesforceClient, extract: (system: string, prompt: string) => Promise<Record<string, unknown>>, prompt: string): Promise<DebitInterpretation | { success: false; requiresInput: boolean; missingFields: string[]; message: string; extraction: Record<string, unknown> }> {
  const out = await extract(DEBIT_AI_SYSTEM, prompt);
  const warnings: string[] = Array.isArray(out.notes) ? out.notes.filter((n): n is string => typeof n === "string" && !!n.trim()) : [];
  if (out.isDebitMemo === false) return { success: false, requiresInput: false, missingFields: [], message: "This doesn't look like a debit memo request. Describe the additional charge to bill (account, amount, and optionally the invoice and products).", extraction: out };
  const rawLines = Array.isArray(out.lines) ? out.lines.filter((l): l is Record<string, unknown> => !!l && typeof l === "object") : [];
  // Ids are never taken from the model — strip any it produced.
  if ([out, ...rawLines].some(o => Object.keys(o).some(k => /id$/i.test(k) && o[k]))) warnings.push("Ignored Salesforce Ids in the AI output — records are resolved by name/number in Salesforce.");
  const extraction = {
    isDebitMemo: true,
    accountName: str(out.accountName), invoiceNumber: str(out.invoiceNumber), currency: str(out.currency), reason: str(out.reason), totalAmount: numOrNull(out.totalAmount),
    lines: rawLines.map(l => ({ description: str(l.description), productName: str(l.productName), quantity: numOrNull(l.quantity), unitPrice: numOrNull(l.unitPrice), amount: numOrNull(l.amount) })),
    lifecycle: (["draft", "posted", "invoiced", "settled"] as const).find(v => v === out.lifecycle) ?? "draft",
    nextBillingDate: str(out.nextBillingDate),
  };
  const draft: DebitDraft = { accountName: extraction.accountName, invoiceNumber: extraction.invoiceNumber, currency: extraction.currency, reason: extraction.reason, totalAmount: extraction.totalAmount, lines: extraction.lines, nextBillingDate: extraction.nextBillingDate };
  const resolution = await resolveDebitDraft(client, draft);
  return { ...resolution, extraction, draft, warnings };
}

/* ───────────────────────────── Create ───────────────────────────── */

export interface DebitMemoRecord {
  id: string; number: string | null; status: string | null; invoiceGenerationStatus: string | null;
  account: AccountRef | null; description: string | null; reason: string | null; reasonCode: string | null;
  totalAmount: number | null; totalCharge: number | null; totalTax: number | null; currency: string | null;
  nextBillingDate: string | null; postedDate: string | null; createdDate: string | null; salesforceUrl: string;
  invoice: { id: string; number: string | null } | null;
}
export interface DebitMemoLineRecord { id: string; name: string | null; description: string | null; product: { id: string; name: string } | null; amount: number | null; lineAmount: number | null; invoiceLine: { id: string; name: string | null } | null }

export type DebitOutcome =
  | { ok: true; status: 200 | 201; duplicate: boolean; message: string; debitMemo: DebitMemoRecord; lines: DebitMemoLineRecord[] }
  | { ok: false; status: number; code: string; error: string; resolution?: DebitResolution; technical?: unknown };

const DM_FIELDS = "Id, DocumentNumber, Status, InvoiceGenerationStatus, AccountId, Account.Name, Description, ReasonCode, TotalAmount, TotalChargeAmount, TotalTaxAmount, NextBillingDate, PostedDate, CreatedDate";
const stripTag = (d: string | null) => (d ? d.replace(/\s*\[ref:[A-Za-z0-9-]+\]\s*$/, "").trim() || null : null);

async function readDebitMemo(client: SalesforceClient, version: string, id: string, currency: OrgCurrency): Promise<{ debitMemo: DebitMemoRecord; lines: DebitMemoLineRecord[] } | null> {
  const [r] = await queryAt(client, version, `SELECT ${DM_FIELDS} FROM DebitMemo WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
  if (!r) return null;
  const lineRows = await queryAt(client, version, `SELECT Id, Name, Description, Product2Id, Product2.Name, ChargeAmount, LineAmount, ReferenceRecordId FROM DebitMemoLine WHERE DebitMemoId = '${soqlEscape(id)}' ORDER BY CreatedDate, Id`);
  const refIds = lineRows.map(l => l.ReferenceRecordId as string).filter(Boolean);
  const invLines = refIds.length ? await queryAt(client, client.apiVersion, `SELECT Id, Name, InvoiceId, Invoice.DocumentNumber FROM InvoiceLine WHERE Id IN (${refIds.map(x => `'${soqlEscape(x)}'`).join(",")})`).catch(() => []) : [];
  const il = new Map(invLines.map(l => [l.Id as string, l]));
  const firstInv = invLines[0];
  const acc = r.Account as { Name?: string } | null;
  return {
    debitMemo: {
      id: r.Id as string, number: (r.DocumentNumber as string) ?? null, status: (r.Status as string) ?? null, invoiceGenerationStatus: (r.InvoiceGenerationStatus as string) ?? null,
      account: r.AccountId ? { id: r.AccountId as string, name: acc?.Name ?? String(r.AccountId) } : null,
      description: (r.Description as string) ?? null, reason: stripTag((r.Description as string) ?? null), reasonCode: (r.ReasonCode as string) ?? null,
      totalAmount: (r.TotalAmount as number) ?? null, totalCharge: (r.TotalChargeAmount as number) ?? null, totalTax: (r.TotalTaxAmount as number) ?? null,
      currency: currency.code ?? currency.symbol, nextBillingDate: (r.NextBillingDate as string) ?? null, postedDate: (r.PostedDate as string) ?? null, createdDate: (r.CreatedDate as string) ?? null,
      salesforceUrl: buildSalesforceRecordUrl(client.instanceUrl, "DebitMemo", r.Id as string),
      invoice: firstInv ? { id: firstInv.InvoiceId as string, number: ((firstInv.Invoice as { DocumentNumber?: string } | null)?.DocumentNumber) ?? null } : null,
    },
    lines: lineRows.map(l => ({
      id: l.Id as string, name: (l.Name as string) ?? null, description: (l.Description as string) ?? null,
      product: l.Product2Id ? { id: l.Product2Id as string, name: ((l.Product2 as { Name?: string } | null)?.Name) ?? String(l.Product2Id) } : null,
      amount: (l.ChargeAmount as number) ?? null, lineAmount: (l.LineAmount as number) ?? null,
      invoiceLine: l.ReferenceRecordId && il.get(l.ReferenceRecordId as string) ? { id: l.ReferenceRecordId as string, name: (il.get(l.ReferenceRecordId as string)!.Name as string) ?? null } : null,
    })),
  };
}

const inflight = (globalThis as { __rcbDebitInflight?: Map<string, Promise<DebitOutcome>> }).__rcbDebitInflight ??= new Map();

export function createDebitMemo(client: SalesforceClient, draft: DebitDraft, key: string | null): Promise<DebitOutcome> {
  if (!key || !KEY_RE.test(key)) return Promise.resolve({ ok: false, status: 400, code: "INVALID_REQUEST", error: "A debit memo request key is required (refresh and review again)." });
  const lock = `${client.instanceUrl}:${key}`;
  const running = inflight.get(lock);
  if (running) return running.then((o: DebitOutcome): DebitOutcome => (o.ok ? { ...o, duplicate: true, status: 200, message: "Debit memo already created for this request." } : o));
  const p = doCreate(client, draft, key).finally(() => inflight.delete(lock));
  inflight.set(lock, p);
  return p;
}

async function doCreate(client: SalesforceClient, draft: DebitDraft, key: string): Promise<DebitOutcome> {
  const m = await getDebitMemoModel(client);
  const version = m.apiVersion;
  // 1. Same request already created (double click / retry) → return it.
  const [existing] = await queryAt(client, version, `SELECT Id FROM DebitMemo WHERE Description LIKE '%${soqlEscape(refTag(key))}%' LIMIT 1`).catch(() => []);
  if (existing) {
    const r = await readDebitMemo(client, version, existing.Id as string, m.currency);
    if (r) return { ok: true, status: 200, duplicate: true, message: `Debit memo ${r.debitMemo.number} already exists for this request.`, ...r };
  }
  // 2. Re-resolve and re-validate everything on the server.
  const res = await resolveDebitDraft(client, draft, m);
  if (!m.available) return { ok: false, status: 403, code: "NOT_AVAILABLE", error: m.reason ?? "Debit memos aren't available for your Salesforce user.", resolution: res };
  if (res.requiresInput) return { ok: false, status: 400, code: "MISSING_INPUT", error: res.message, resolution: res };
  if (!res.valid || !res.account) return { ok: false, status: 400, code: "INVALID_DEBIT_MEMO", error: res.issues.filter(i => i.severity === "error").map(i => i.message).join(" "), resolution: res };

  // 3. One all-or-nothing Composite request: DebitMemo + DebitMemoLine(s).
  const header: Record<string, unknown> = {
    AccountId: res.account.id, Status: res.createAs.status, InvoiceGenerationStatus: res.createAs.invoiceGenerationStatus,
    Description: `${(res.reason ?? "Debit memo").slice(0, Math.max(0, m.limits.description - refTag(key).length - 1))} ${refTag(key)}`,
  };
  if (res.nextBillingDate) header.NextBillingDate = res.nextBillingDate;
  else if (res.billOnNextRun) header.NextBillingDate = today();
  if (res.reasonCode) header.ReasonCode = res.reasonCode;
  const requests = [
    { method: "POST" as const, url: "/sobjects/DebitMemo", referenceId: "dm", body: header },
    ...res.lines.map((l, i) => {
      const detail = `${l.description} — Qty ${l.quantity} × ${l.unitPrice}`;
      const body: Record<string, unknown> = { DebitMemoId: "@{dm.id}", Name: l.description.slice(0, m.limits.lineName), ChargeAmount: l.amount, Description: detail.slice(0, m.limits.lineDescription) };
      if (l.product) body.Product2Id = l.product.id;
      if (l.invoiceLine) body.ReferenceRecordId = l.invoiceLine.id;
      return { method: "POST" as const, url: "/sobjects/DebitMemoLine", referenceId: `line${i}`, body };
    }),
  ];
  let result;
  try { result = await compositeAt(client, version, requests); }
  catch (e) {
    if (e instanceof SalesforceCallError) {
      console.error("[debit-memo] composite request failed", { status: e.status, errors: e.errors });
      return { ok: false, status: e.status === 401 ? 401 : e.status >= 500 ? 502 : 422, code: e.errors[0]?.errorCode ?? "SALESFORCE_ERROR", error: friendlySalesforceError(e.errors[0] ?? { message: e.message }, "debit memo"), resolution: res, technical: e.raw };
    }
    throw e;
  }
  if (!result.ok) {
    console.error("[debit-memo] Salesforce rejected the debit memo", { errors: result.errors });
    const first = result.errors[0] ?? {};
    const code = first.errorCode ?? "SALESFORCE_ERROR";
    return { ok: false, status: /INSUFFICIENT_ACCESS/.test(code) ? 403 : 422, code, error: `${friendlySalesforceError(first, first.referenceId?.startsWith("line") ? "debit memo line" : "debit memo")} Nothing was created.`, resolution: res, technical: { request: requests, errors: result.errors } };
  }
  const id = (result.results.find(r => r.referenceId === "dm")?.body as { id?: string } | undefined)?.id;
  const read = id ? await readDebitMemo(client, version, id, m.currency) : null;
  if (!read) return { ok: false, status: 502, code: "VERIFY_FAILED", error: "Salesforce reported success but the debit memo couldn't be read back. Refresh the Debit Memo list." };
  // 4. Verify what Salesforce stored matches what was validated.
  const stored = round2(read.lines.reduce((s, l) => s + (l.amount ?? 0), 0));
  if (cents(stored) !== cents(res.computedTotal) || read.lines.length !== res.lines.length) console.error("[debit-memo] verification mismatch", { expected: res.computedTotal, stored, lines: read.lines.length });
  return { ok: true, status: 201, duplicate: false, message: "Debit Memo created successfully.", ...read };
}

/* ───────────────────────────── Read ───────────────────────────── */

export async function listDebitMemos(client: SalesforceClient, opts: { search?: string | null; status?: string | null; page?: number; pageSize?: number }) {
  const m = await getDebitMemoModel(client);
  if (!m.available && !m.statusValues.length) return { success: true as const, available: false, reason: m.reason, debitMemos: [] as DebitMemoRecord[], totalSize: 0, page: 1, pageSize: 20, byStatus: [] as { status: string; count: number; amount: number | null }[], statusValues: [] as string[], currency: m.currency };
  const where: string[] = [];
  const term = (opts.search ?? "").trim();
  if (term) where.push(`(DocumentNumber LIKE '%${soqlEscape(term)}%' OR Account.Name LIKE '%${soqlEscape(term)}%' OR Description LIKE '%${soqlEscape(term)}%')`);
  if (opts.status) { if (!m.statusValues.includes(opts.status)) throw new BadInputError(`Unknown debit memo status "${opts.status}".`); where.push(`Status = '${soqlEscape(opts.status)}'`); }
  const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const pageSize = Math.min(Math.max(opts.pageSize ?? 20, 5), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const [rows, agg] = await Promise.all([
    queryAt(client, m.apiVersion, `SELECT ${DM_FIELDS} FROM DebitMemo${w} ORDER BY CreatedDate DESC, Id LIMIT ${pageSize} OFFSET ${Math.min((page - 1) * pageSize, 2000)}`),
    queryAt(client, m.apiVersion, `SELECT Status, COUNT(Id) c, SUM(TotalChargeAmount) amt FROM DebitMemo${w} GROUP BY Status`),
  ]);
  return {
    success: true as const, available: m.available, reason: m.reason,
    debitMemos: rows.map(r => ({
      id: r.Id as string, number: (r.DocumentNumber as string) ?? null, status: (r.Status as string) ?? null, invoiceGenerationStatus: (r.InvoiceGenerationStatus as string) ?? null,
      account: r.AccountId ? { id: r.AccountId as string, name: ((r.Account as { Name?: string } | null)?.Name) ?? String(r.AccountId) } : null,
      description: (r.Description as string) ?? null, reason: stripTag((r.Description as string) ?? null), reasonCode: (r.ReasonCode as string) ?? null,
      totalAmount: (r.TotalAmount as number) ?? null, totalCharge: (r.TotalChargeAmount as number) ?? null, totalTax: (r.TotalTaxAmount as number) ?? null,
      currency: m.currency.code ?? m.currency.symbol, nextBillingDate: (r.NextBillingDate as string) ?? null, postedDate: (r.PostedDate as string) ?? null, createdDate: (r.CreatedDate as string) ?? null,
      salesforceUrl: buildSalesforceRecordUrl(client.instanceUrl, "DebitMemo", r.Id as string), invoice: null,
    })),
    totalSize: agg.reduce((s, r) => s + (typeof r.c === "number" ? r.c : 0), 0), page, pageSize,
    byStatus: agg.map(r => ({ status: String(r.Status ?? "—"), count: typeof r.c === "number" ? r.c : 0, amount: typeof r.amt === "number" ? r.amt : null })),
    statusValues: m.statusValues, currency: m.currency,
  };
}

export async function getDebitMemo(client: SalesforceClient, id: string) {
  if (!SFID.test(id)) throw new NotFoundError("Invalid Debit Memo Id.");
  const m = await getDebitMemoModel(client);
  const r = await readDebitMemo(client, m.apiVersion, id, m.currency);
  if (!r) throw new NotFoundError("Debit Memo not found in Salesforce (or not visible to your user).");
  return { success: true as const, ...r };
}

/** Parse the browser's draft — only names, numbers, user-picked Ids and amounts; everything is re-resolved server-side. */
export function debitDraftOf(body: Record<string, unknown>): DebitDraft {
  const d = (body.draft && typeof body.draft === "object" ? body.draft : body) as Record<string, unknown>;
  const lines = Array.isArray(d.lines) ? d.lines.filter((l): l is Record<string, unknown> => !!l && typeof l === "object") : [];
  if (lines.length > 25) throw new BadInputError("A debit memo can have at most 25 lines here.");
  return {
    accountId: str(d.accountId), accountName: str(d.accountName), invoiceId: str(d.invoiceId), invoiceNumber: str(d.invoiceNumber),
    currency: str(d.currency), reason: str(d.reason), reasonCode: str(d.reasonCode), totalAmount: numOrNull(d.totalAmount), billOnNextRun: d.billOnNextRun === true, nextBillingDate: str(d.nextBillingDate),
    lines: lines.map(l => ({ description: str(l.description), productId: str(l.productId), productName: str(l.productName), quantity: numOrNull(l.quantity), unitPrice: numOrNull(l.unitPrice), amount: numOrNull(l.amount), invoiceLineId: str(l.invoiceLineId) })),
  };
}
