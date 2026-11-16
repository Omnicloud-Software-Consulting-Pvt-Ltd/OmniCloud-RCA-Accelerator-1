import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { BadInputError } from "@/lib/billing/server/payments";
import { diag, type TaxDiagnostic } from "@/lib/tax/server/diagnostics";
import { runtimeApiFor, type TaxRuntimeApi } from "@/lib/tax/server/runtime";
import { generateTaxInvoice, getProductTaxReadiness, type ProductTaxReadiness, type TaxInvoiceGeneration } from "@/lib/tax/server/pipeline";
import { advanceTaxRun, BILLABLE_ACTIONS, calculateEstimatedTax, getTaxRun, readInvoice, startVerificationRun, type RunAction, type TaxRunState } from "@/lib/tax/server/verification";
import type { TaxContext } from "@/lib/tax/server/resolution";
import { evaluateCalculationValidation, type CalcAccount, type ExpectedReference, type TaxCalcValidation } from "@/lib/tax/server/calculationValidation";
import { evidenceApisFor, invoiceTaxEvidence, previewDecisionTable } from "@/lib/tax/server/calculationDiagnostics";
import { deriveSalesforceTax, expectedTreatmentsForProducts, type ActualTax, type ExpectedTreatments, type TaxDerivation } from "@/lib/tax/server/invoiceTax";
import { invoiceTaxFlowState, type TaxFlowState } from "@/lib/tax/server/calculationResult";
import { PREVIEW_LABEL, REFERENCE_LABEL, reasonForStep, round2, type AuthoritativeTax, type DecisionTablePreview, type InvoiceTaxEvidence, type TaxCalcReason, type TaxCalcStatus, type TaxInputs } from "@/lib/tax/server/calculationResult";

/**
 * TAX CALCULATION SERVICE — the authoritative tax of a transaction is Salesforce's InvoiceLineTax, nothing else.
 *
 * Lifecycle:  1 Validate · 2 Resolve Tax Treatment · 3 Resolve Tax Engine · 4 Resolve Decision Table · 5 Decision table readiness ·
 *             6 Resolve Tax Rate  (calculationValidation.ts — read-only)
 *           → [Preview: Salesforce's own decision-table evaluation — a preview, never tax]
 *           → 7 Create the Salesforce transaction (Order + Order Product, tax treatment stamped) · 8 Activate · 9 Billing schedule ·
 *             10 Generate invoice (generateTaxInvoice, refresh = "never") · 11 Read invoice line · 12 Read InvoiceLineTax ·
 *             13 Return the authoritative Salesforce result.
 *
 * Built on the existing, p10-proven services (verification.ts → orderBilling.ts): composite Order/OrderItem create, Revenue Cloud
 * order actions + activation, Salesforce's "Create Billing Schedules from Billing Transaction" action, invoice generation,
 * POST /commerce/invoicing/invoices/collection/actions/calculate-estimated-tax (Draft invoices). The direct Tax Calculation API
 * (POST /commerce/taxes/actions/calculate) returns 404 NOT_FOUND for Revenue Standard Tax engines in p10 and is NOT used.
 *
 *  · Billable steps — create order, activate, billing schedules, generate invoice, post — each run ONLY when this request confirms
 *    exactly that step; nothing chains into the next billable step. Non-billable steps (billing setup on the run's own Draft order,
 *    Salesforce's estimated-tax calculation on the Draft invoice) proceed automatically.
 *  · CALCULATED only when Salesforce's InvoiceLineTax exists with a TaxAmount. A decision-table match is reported as a PREVIEW and
 *    the configured rate × amount as an EXPECTED/REFERENCE value — neither ever becomes the result. No InvoiceLineTax is written.
 *  · Invoice generated + Salesforce finished + TaxAmount 0 + no InvoiceLineTax + no error → CALCULATION_FAILED with reason
 *    INVOICE_TIME_TAX_NOT_APPLIED and read-only evidence (trace + decision-table preview). This is the behaviour reproduced in p10.
 */

export const DIRECT_TAX_API = { endpoint: "POST /commerce/taxes/actions/calculate", observedStatus: 404, observedCode: "NOT_FOUND", note: "Salesforce returns NOT_FOUND for Revenue Standard Tax engines in this org (no Tax Engine Provider adapter); it is not used for the authoritative calculation." } as const;

export type SfTaxStatus = TaxCalcStatus;
export type SfTaxStep = "create-order" | RunAction;
export type SfTaxAction = "validate" | "preview" | "calculate";

export interface SfTaxInput {
  /** validate / preview are read-only; calculate (default) runs the confirmed Salesforce lifecycle. */
  action?: SfTaxAction | null;
  mode?: "billing" | "invoice";
  product?: { id?: string | null; name?: string | null } | null;
  accountId?: string | null; accountName?: string | null; contactId?: string | null;
  quantity?: number | null; unitPrice?: number | null;
  /** Geography for validate / preview without an account. */
  country?: string | null; state?: string | null; city?: string | null; postalCode?: string | null;
  effectiveDate?: string | null;
  /** Explicit treatment selection when the policy's treatment is ambiguous (validate / preview only). */
  treatmentId?: string | null;
  orderId?: string | null; invoiceId?: string | null; invoiceNumber?: string | null;
  /** Invoice mode: only read (never ask Salesforce to calculate the Draft invoice's tax). */
  readOnly?: boolean | null;
  /** The ONE billable step this request confirms (e.g. "create-order", "activate", "generate-invoice"). */
  confirm?: string | null;
  /** Test-run identifier (8–64 chars) stamped on the order so created records can be found. */
  runKey?: string | null;
  /** Clear a previously recorded run failure (e.g. after an admin fixed the cause) and re-read. Never performs a billable step. */
  retry?: boolean | null;
  /** Bounded wait for Salesforce's InvoiceLineTax after the invoice exists (default 45 s, max 120 s). */
  waitMs?: number | null;
}

export { deriveSalesforceTax, type ActualTax, type TaxDerivation } from "@/lib/tax/server/invoiceTax";
export type ExpectedTax = ExpectedReference;

export interface SfTaxResult {
  success: true;
  status: SfTaxStatus;
  reason: TaxCalcReason | null;
  /** End-to-end state name (VERIFIED_TAX_APPLIED, VERIFIED_ZERO_TAX, TREATMENT_MISMATCH, TAX_RECORDS_UNREADABLE…) derived from status + reason. */
  taxState?: TaxFlowState;
  /** Provenance of the amount in `actual` — never anything but SALESFORCE_INVOICELINETAX. */
  source: "SALESFORCE_INVOICELINETAX" | null;
  message: string;
  runKey: string | null;
  orderId: string | null;
  invoiceId: string | null;
  /** The billable step awaiting confirmation (send it back as `confirm`). */
  awaiting: { step: SfTaxStep; detail: string } | null;
  actual: ActualTax[];
  /** The authoritative Salesforce result (CALCULATED only). */
  result: AuthoritativeTax | null;
  /** Reference only — configured rate × taxable amount. Never the result. */
  expected: ExpectedTax | null;
  validation: TaxCalcValidation | null;
  preview: DecisionTablePreview | null;
  /** Read-only evidence about the invoice line (always when Salesforce produced no InvoiceLineTax). */
  evidence: InvoiceTaxEvidence | null;
  readiness: { status: string; message: string } | null;
  run: Pick<TaxRunState, "order" | "items" | "schedules" | "invoice" | "steps" | "checks" | "taxCalculation"> | null;
  /** The invoice as Salesforce holds it: status and its own totals (TotalChargeAmount / TotalTaxAmount / TotalAmountWithTax). */
  invoiceSummary?: { id: string; number: string | null; status: string | null; subtotal: number | null; tax: number | null; totalWithTax: number | null;
    lines?: { id: string; product: string | null; charge: number | null; taxAmount: number | null; taxStatus: string | null; treatment: string | null }[] } | null;
  verification: { label: string; recordId: string | null; passed: boolean; detail: string }[];
  createdRecords: { object: string; id: string; name: string | null }[];
  directTaxApi: typeof DIRECT_TAX_API;
  diagnostics: TaxDiagnostic[];
}

/** Salesforce access used by the service (real implementation wraps the existing services; tests use an in-memory one). */
export interface SfTaxApi {
  readiness(product: { id?: string | null; name?: string | null }, ctx: TaxContext): Promise<ProductTaxReadiness>;
  account(input: { id?: string | null; name?: string | null }): Promise<CalcAccount | null>;
  contactOf(accountId: string, contactId: string | null): Promise<{ id: string; name: string } | null>;
  startRun(input: { product: { id?: string | null; name?: string | null }; accountId: string; contactId: string; quantity: number | null; unitPrice: number | null; key: string }): Promise<{ orderId: string }>;
  runState(orderId: string): Promise<TaxRunState>;
  advance(orderId: string, confirm: RunAction | null, opts?: { retry?: boolean }): Promise<TaxRunState>;
  invoice(invoiceId: string): Promise<NonNullable<TaxRunState["invoice"]>>;
  /** Invoice Id by its document number (DOC-…), null when none. */
  findInvoice(documentNumber: string): Promise<string | null>;
  /** The confirmed invoice step: existing generateTaxInvoice, inspecting the decision table WITHOUT the API refresh action. */
  generateInvoice(orderId: string): Promise<Pick<TaxInvoiceGeneration, "status" | "message" | "diagnostics" | "decisionTable" | "invoice">>;
  calculateInvoiceTax(invoiceId: string): Promise<{ ok: true } | { ok: false; status: number; code: string; error: string; technical?: unknown }>;
  treatments(ids: string[]): Promise<{ id: string; name: string; taxable: boolean }[]>;
  /** The treatment each product's tax policy selects (to recognise a fallback treatment on an invoice line). Optional for fakes. */
  expectedTreatments?(productIds: string[]): Promise<ExpectedTreatments>;
  errorLog(recordIds: string[]): Promise<{ number: string | null; code: string | null; message: string | null } | null>;
  /** Salesforce's decision-table evaluation (read-only preview). */
  preview(input: { decisionTableId: string; decisionTableName: string | null; inputs: TaxInputs; taxRate: DecisionTablePreview["taxRate"] }): Promise<DecisionTablePreview>;
  /** Read-only trace + preview for an invoice line. */
  evidence(invoiceId: string, invoiceLineId: string | null): Promise<InvoiceTaxEvidence>;
  sleep(ms: number): Promise<void>;
}

export async function sfTaxApiFor(client: SalesforceClient): Promise<SfTaxApi> {
  const rt: TaxRuntimeApi = await runtimeApiFor(client);
  const q = rt.query;
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  let ev: Awaited<ReturnType<typeof evidenceApisFor>> | null = null;
  const evApis = async () => (ev ??= await evidenceApisFor(client));
  const ACC = "Id, Name, BillingStreet, BillingCity, BillingState, BillingPostalCode, BillingCountry";
  return {
    readiness: (product, ctx) => getProductTaxReadiness(rt, product, ctx),
    account: async ({ id, name }) => {
      const rows = id ? await q(`SELECT ${ACC} FROM Account WHERE Id = '${soqlEscape(id)}'`) : name ? await q(`SELECT ${ACC} FROM Account WHERE Name = '${soqlEscape(name)}' LIMIT 2`) : [];
      if (rows.length > 1) throw new BadInputError(`${rows.length} accounts are named "${name}" — give the Account Id.`);
      const a = rows[0];
      return a ? { id: String(a.Id), name: String(a.Name), street: s(a.BillingStreet), city: s(a.BillingCity), state: s(a.BillingState), postalCode: s(a.BillingPostalCode), country: s(a.BillingCountry) } : null;
    },
    contactOf: async (accountId, contactId) => {
      const [c] = await q(`SELECT Id, Name FROM Contact WHERE AccountId = '${soqlEscape(accountId)}'${contactId ? ` AND Id = '${soqlEscape(contactId)}'` : ""} ORDER BY CreatedDate LIMIT 1`);
      return c ? { id: String(c.Id), name: String(c.Name) } : null;
    },
    startRun: async input => startVerificationRun(client, { ...input, accountName: null }),
    runState: orderId => getTaxRun(client, orderId),
    advance: (orderId, confirm, opts) => advanceTaxRun(client, orderId, { confirm, retry: opts?.retry === true }),
    invoice: invoiceId => readInvoice(client, rt.apiVersion, invoiceId),
    findInvoice: async number => { const [r] = await q(`SELECT Id FROM Invoice WHERE DocumentNumber = '${soqlEscape(number)}' LIMIT 1`); return r ? String(r.Id) : null; },
    generateInvoice: orderId => generateTaxInvoice(rt, orderId, { confirm: true, refresh: "never" }),
    calculateInvoiceTax: invoiceId => calculateEstimatedTax(client, invoiceId),
    expectedTreatments: ids => expectedTreatmentsForProducts(client, rt.apiVersion, ids),
    treatments: async ids => (ids.length ? await q(`SELECT Id, Name, IsTaxable FROM TaxTreatment WHERE Id IN (${ids.map(i => `'${soqlEscape(i)}'`).join(",")})`) : []).map(t => ({ id: String(t.Id), name: String(t.Name), taxable: t.IsTaxable === true })),
    errorLog: rt.errorLog,
    preview: async input => previewDecisionTable((await evApis()).preview, input),
    evidence: async (invoiceId, lineId) => invoiceTaxEvidence(await evApis(), invoiceId, lineId),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  };
}

const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const assertId = (v: string | null | undefined, what: string) => { if (v && !SFID.test(v)) throw new BadInputError(`${what} isn't a valid Salesforce Id.`); };
const today = () => new Date().toISOString().slice(0, 10);

/* ───────────── Pure: the authoritative result from Salesforce's records ───────────── */

type Invoice = NonNullable<TaxRunState["invoice"]>;

/** The verification chain read from Salesforce: Account → Order → Order Item → Billing Schedule → Invoice → Invoice Line → InvoiceLineTax. */
export function verificationChain(run: TaxRunState, actual: ActualTax[], expectedTaxCode: string | null): SfTaxResult["verification"] {
  const inv = run.invoice;
  const out: SfTaxResult["verification"] = [
    { label: "Account", recordId: run.order.account?.id ?? null, passed: !!run.order.account, detail: run.order.account?.name ?? "—" },
    { label: "Order", recordId: run.order.id, passed: true, detail: `${run.order.number} · ${run.order.status}` },
    { label: "Order Item", recordId: run.items[0]?.id ?? null, passed: run.items.length > 0, detail: run.items.map(i => `${i.product?.name} × ${i.quantity} · treatment ${i.treatment?.name ?? "none"}`).join(" · ") || "—" },
    { label: "Billing Schedule", recordId: run.schedules[0]?.id ?? null, passed: run.schedules.length > 0, detail: run.schedules.map(s => `${s.number} · ${s.status} · ${s.treatment?.name ?? "no tax treatment"}`).join(", ") || "none yet" },
    { label: "Invoice", recordId: inv?.id ?? null, passed: !!inv, detail: inv ? `${inv.number} · ${inv.status} · tax ${inv.tax ?? "—"}` : "none yet" },
    { label: "Invoice Line", recordId: inv?.lines[0]?.id ?? null, passed: !!inv?.lines.length, detail: inv?.lines.map(l => `${l.product ?? l.name} · ${l.charge} · tax status ${l.taxStatus ?? "—"}`).join(" · ") || "none yet" },
    { label: "InvoiceLineTax", recordId: actual[0]?.invoiceLineTaxId ?? null, passed: actual.length > 0, detail: actual.map(a => `${a.taxCode ?? "—"} ${a.taxRate ?? "?"}% = ${a.taxAmount} (${a.taxProcessingStatus ?? "—"})`).join(" · ") || "none" },
  ];
  if (expectedTaxCode && actual.length) out.push({ label: `InvoiceLineTax.TaxCode = ${expectedTaxCode}`, recordId: actual[0].invoiceLineTaxId, passed: actual.every(a => a.taxCode === expectedTaxCode), detail: actual.map(a => a.taxCode ?? "—").join(", ") });
  return out;
}

/* ───────────── Orchestration ───────────── */

const createOrderDetail = (account: string, product: string | null, contact: string, qty: number | null, price: number | null) => `Create a Draft Salesforce Order for ${account} with ${product ?? "the product"}${qty ? ` × ${qty}` : ""}${price !== null ? ` at ${price}` : ""} (the tax treatment stamped on the order product). Bill To Contact: ${contact}.`;

/** Stages 1–6, read-only: account, contact, product readiness → structured validation. */
async function validate(api: SfTaxApi, input: SfTaxInput): Promise<TaxCalcValidation> {
  if (!input.product?.id && !input.product?.name) throw new BadInputError("Which product?");
  const wantsAccount = !!(input.accountId || input.accountName);
  const account = wantsAccount ? await api.account({ id: input.accountId, name: input.accountName }) : null;
  if (wantsAccount && !account) throw new BadInputError(`Account ${input.accountId ?? input.accountName ?? ""} doesn't exist.`);
  const contact = account ? await api.contactOf(account.id, input.contactId ?? null) : null;
  if (account && input.contactId && !contact) throw new BadInputError(`Contact ${input.contactId} doesn't belong to "${account.name}".`);
  const geography = account ? null : { country: input.country ?? null, state: input.state ?? null, city: input.city ?? null, postalCode: input.postalCode ?? null };
  const g = account ? { country: account.country, state: account.state, city: account.city, postalCode: account.postalCode } : geography!;
  const effectiveDate = input.effectiveDate && /^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate) ? input.effectiveDate : today();
  const readiness = await api.readiness(input.product, { country: g.country, state: g.state, city: g.city, zipCode: g.postalCode, effectiveDate, treatmentId: input.treatmentId ?? null });
  return evaluateCalculationValidation(readiness, { account, contact, quantity: input.quantity ?? 1, unitPrice: input.unitPrice ?? null, effectiveDate, geography });
}

export async function calculateSalesforceTax(api: SfTaxApi, input: SfTaxInput): Promise<SfTaxResult> {
  const waitMs = Math.min(Math.max(input.waitMs ?? 45_000, 0), 120_000);
  const runKey = input.runKey && /^[A-Za-z0-9-]{8,64}$/.test(input.runKey) ? input.runKey : null;
  for (const [v, w] of [[input.accountId, "accountId"], [input.contactId, "contactId"], [input.orderId, "orderId"], [input.invoiceId, "invoiceId"], [input.product?.id, "product.id"], [input.treatmentId, "treatmentId"]] as const) assertId(v, w);
  const action: SfTaxAction = input.action ?? "calculate";
  const base = (o: Partial<SfTaxResult> & Pick<SfTaxResult, "status" | "message">): SfTaxResult => ({ success: true, reason: null, source: null, runKey, orderId: input.orderId ?? null, invoiceId: input.invoiceId ?? null, awaiting: null, actual: [], result: null, expected: null, validation: null, preview: null, evidence: null, readiness: null, run: null, verification: [], createdRecords: [], directTaxApi: DIRECT_TAX_API, diagnostics: [], ...o });

  /* A. Existing invoice (by Id or document number) */
  if ((input.mode ?? (input.invoiceId || input.invoiceNumber ? "invoice" : "billing")) === "invoice") {
    const invoiceId = input.invoiceId ?? (input.invoiceNumber ? await api.findInvoice(input.invoiceNumber.trim()) : null);
    if (!invoiceId) throw new BadInputError(input.invoiceNumber ? `Invoice ${input.invoiceNumber} doesn't exist in the connected org.` : "invoiceId or invoiceNumber is required.");
    const inv = await api.invoice(invoiceId);
    if (!inv?.number && !inv?.lines.length && !inv?.status) throw new BadInputError(`Invoice ${invoiceId} doesn't exist.`);
    // Draft invoice with lines Salesforce hasn't taxed yet → Salesforce's invoice estimated-tax calculation (Draft only, by Salesforce).
    if (!input.readOnly && /^draft$/i.test(inv.status ?? "") && inv.lines.some(l => !l.taxes.length && (!l.taxStatus || /pending/i.test(l.taxStatus)))) {
      const out = await api.calculateInvoiceTax(inv.id);
      if (!out.ok) return base({ status: "CALCULATION_FAILED", reason: "SALESFORCE_ERROR", invoiceId: inv.id, message: `Salesforce didn't calculate the invoice tax: ${out.error}`, diagnostics: [diag("CALCULATION_REJECTED", `Salesforce rejected the invoice tax calculation (HTTP ${out.status} ${out.code}): ${out.error}`, { httpStatus: out.status, salesforceCode: out.code, salesforceMessage: out.error, operation: "POST /commerce/invoicing/invoices/collection/actions/calculate-estimated-tax", recordId: inv.id })] });
    }
    return settle(api, inv, base({ status: "IN_PROGRESS", message: "", invoiceId: inv.id }), input.readOnly ? 0 : waitMs, [], null, null);
  }

  /* B. No order yet: stages 1–6 → validate | preview | (confirm) create the Salesforce transaction */
  if (!input.orderId) {
    const v = await validate(api, input);
    const common = { validation: v, expected: v.expected, readiness: { status: v.status, message: v.message } };
    if (action === "validate") return base({ ...common, status: v.status, reason: v.reason, message: v.message });
    if (action === "preview") {
      if (!v.configurationReady || !v.decisionTable) return base({ ...common, status: "NOT_READY", reason: v.reason ?? "CONFIGURATION_NOT_READY", message: `Preview not run — ${v.message}` });
      const preview = await api.preview({ decisionTableId: v.decisionTable.id, decisionTableName: v.decisionTable.name, inputs: v.inputs, taxRate: v.rate ? { id: v.rate.id, name: v.rate.name, taxCode: v.rate.taxCode, rate: v.rate.rate } : null });
      if (preview.error) return base({ ...common, preview, status: "NOT_READY", reason: "SALESFORCE_ERROR", message: `Salesforce's decision-table evaluation failed (HTTP ${preview.error.status} ${preview.error.code ?? ""}): ${preview.error.message}`, diagnostics: [diag("CALCULATION_REJECTED", `Decision-table evaluation failed: ${preview.error.message}`, { httpStatus: preview.error.status, salesforceCode: preview.error.code, salesforceMessage: preview.error.message, operation: preview.endpoint, recordId: preview.decisionTableId })] });
      return base({ ...common, preview, status: preview.matched ? "PREVIEW_MATCH" : "NOT_READY", reason: preview.matched ? null : "DECISION_TABLE_NO_MATCH",
        message: preview.matched ? `${PREVIEW_LABEL} Salesforce's evaluation of ${preview.decisionTableName ?? preview.decisionTableId} returned ${preview.outcomeType}: Rate ${preview.rate ?? "—"}%, ${preview.applicationBasis ?? "—"}, priority ${preview.priority ?? "—"}.${v.status === "READY" ? "" : ` ${v.message}`}`
          : `${PREVIEW_LABEL} Salesforce's evaluation of ${preview.decisionTableName ?? preview.decisionTableId} returned ${preview.outcomeType ?? "no outcome"} for these inputs — no rate would apply.` });
    }
    // calculate
    if (input.treatmentId) throw new BadInputError("A treatment selection applies to Validate and Preview only — the Salesforce order uses the treatment its tax policy resolves.");
    if (v.status !== "READY") return base({ ...common, status: "NOT_READY", reason: v.reason, diagnostics: v.diagnostics.filter(d => d.severity === "error"), message: `Not started — nothing was created. ${v.message}` });
    if (input.confirm !== "create-order") return base({ ...common, status: "AWAITING_CONFIRMATION", awaiting: { step: "create-order", detail: createOrderDetail(v.account!.name, v.product?.name ?? null, v.contact!.name, v.quantity, v.unitPrice) }, diagnostics: v.diagnostics.filter(d => d.severity === "warning"), message: `${v.message} Nothing has been created — confirm "create-order" to create the Salesforce order.` });
    const key = runKey ?? `sftax-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const { orderId } = await api.startRun({ product: input.product!, accountId: v.account!.id, contactId: v.contact!.id, quantity: v.quantity, unitPrice: input.unitPrice ?? null, key });
    const run = await autoAdvance(api, orderId);
    return fromRun(api, run, { ...base({ ...common, status: "IN_PROGRESS", message: "" }), runKey: key, createdRecords: [{ object: "Order", id: orderId, name: run.order.number }, ...run.items.map(i => ({ object: "OrderItem", id: i.id, name: i.product?.name ?? null }))] }, waitMs);
  }

  /* C. Existing run: perform the confirmed billable step (only that one), then the non-billable steps, then settle */
  // retry: clears the recorded failure only — advanceTaxRun never runs a billable step without its confirmation.
  let run = input.retry ? await api.advance(input.orderId, null, { retry: true }) : await api.runState(input.orderId);
  if (run.next?.action === "generate-invoice" && input.confirm === "generate-invoice") {
    const g = await api.generateInvoice(input.orderId);
    if (g.status === "BLOCKED" || g.status === "FAILED") {
      const after = await api.runState(input.orderId);
      const r = await fromRun(api, after, base({ status: "IN_PROGRESS", message: "" }), 0);
      const stale = g.status === "BLOCKED" && !!g.decisionTable && g.decisionTable.state !== "Ready" || /decision table/i.test(g.message);
      return { ...r, status: g.status === "BLOCKED" ? "NOT_READY" : "CALCULATION_FAILED", reason: g.status === "BLOCKED" ? (stale ? "DECISION_TABLE_STALE" : "CONFIGURATION_NOT_READY") : "INVOICE_GENERATION_FAILED", awaiting: null, message: g.message, diagnostics: [...r.diagnostics, ...g.diagnostics] };
    }
    run = await autoAdvance(api, input.orderId);
  }
  else if (run.next && BILLABLE_ACTIONS.has(run.next.action) && input.confirm === run.next.action) run = await autoAdvance(api, input.orderId, await api.advance(input.orderId, run.next.action));
  else if (input.confirm && input.confirm !== run.next?.action) return fromRun(api, run, { ...base({ status: "IN_PROGRESS", message: "" }), diagnostics: [diag("ORDER_NOT_READY", `"${input.confirm}" isn't the next step (next: ${run.next?.label ?? "none"}). Nothing was done.`, { severity: "warning" })] }, 0);
  else run = await autoAdvance(api, input.orderId, run);
  return fromRun(api, run, base({ status: "IN_PROGRESS", message: "" }), waitMs);
}

/** Run non-billable steps (treatment stamp, billing setup, Salesforce estimated-tax calculation) until a billable step, a wait, completion or a failure. */
async function autoAdvance(api: SfTaxApi, orderId: string, start?: TaxRunState): Promise<TaxRunState> {
  let run = start ?? await api.runState(orderId);
  for (let i = 0; i < 6; i++) {
    if (run.failure || !run.next || run.next.action === "wait" || BILLABLE_ACTIONS.has(run.next.action)) break;
    run = await api.advance(orderId, null);
  }
  return run;
}

function expectedFromRun(run: TaxRunState): ExpectedTax | null {
  const i = run.items[0], r = i?.expectedRate;
  if (!r) return null;
  const t = i.total ?? (i.quantity ?? 0) * (i.unitPrice ?? 0);
  return { source: "EXPECTED_ONLY", label: REFERENCE_LABEL, rate: r.rate, taxCode: r.taxCode, taxableAmount: t, taxAmount: r.rate !== null ? round2(t * r.rate / 100) : null, note: `${REFERENCE_LABEL} Configured ${r.taxCode ?? ""} ${r.rate ?? "?"}% × taxable amount.` };
}

async function fromRun(api: SfTaxApi, run: TaxRunState, acc: SfTaxResult, waitMs: number): Promise<SfTaxResult> {
  const out: SfTaxResult = { ...acc, orderId: run.orderId, run: pickRun(run) };
  const expectedCode = run.items[0]?.expectedCode ?? null;
  out.expected ??= expectedFromRun(run);
  if (run.failure) {
    // A Salesforce stop before or after the invoice means Salesforce did not produce tax — reported as a failure, never "in progress".
    out.status = "CALCULATION_FAILED";
    out.reason = reasonForStep(run.failure.step);
    out.diagnostics = [...out.diagnostics, diag(run.failure.step === "activate" || run.failure.step === "setup" ? "ORDER_ACTIVATION_FAILED" : run.failure.step === "schedules" ? "BILLING_SCHEDULE_MISSING" : run.failure.step === "invoice" ? "INVOICE_GENERATION_FAILED" : "CALCULATION_REJECTED", `Salesforce stopped the run at "${run.failure.step}": ${run.failure.reason}`, { salesforceCode: run.failure.code, salesforceMessage: run.failure.reason, operation: `${run.failure.step} (${run.invoice ? "Invoice" : "Order"})`, recordId: run.invoice?.id ?? run.orderId, action: run.failure.adminAction ?? null })];
    out.message = `Stopped at "${run.steps.find(s => s.id === run.failure!.step)?.label ?? run.failure.step}": ${run.failure.reason}`;
    out.verification = verificationChain(run, [], expectedCode);
    return out;
  }
  if (run.invoice) return settle(api, run.invoice, out, waitMs, out.diagnostics, run, expectedCode);
  // Before the invoice: which billable step is next?
  if (run.next && run.confirmation) { out.status = "AWAITING_CONFIRMATION"; out.awaiting = { step: run.next.action, detail: run.confirmation.detail }; out.message = `Next billable step needs your confirmation: ${run.next.label}.`; }
  else { out.status = "IN_PROGRESS"; out.message = run.message; }
  out.verification = verificationChain(run, [], expectedCode);
  return out;
}

/** Bounded re-read of Salesforce until the invoice's tax is settled (calculated, failed or no tax), else PENDING → TIMEOUT. */
async function settle(api: SfTaxApi, inv0: Invoice, base: SfTaxResult, waitMs: number, diagnostics: TaxDiagnostic[], run: TaxRunState | null, expectedCode: string | null): Promise<SfTaxResult> {
  let inv = inv0;
  const interval = 5_000;
  let d: TaxDerivation;
  for (let waited = 0; ; waited += interval) {
    const t = await api.treatments([...new Set(inv.lines.map(l => l.treatment?.id).filter((x): x is string => !!x))]);
    const log = await api.errorLog([inv.id, ...inv.lines.map(l => l.id)]);
    let expected: ExpectedTreatments | null = null;
    try { expected = api.expectedTreatments ? await api.expectedTreatments(inv.lines.map(l => l.productId).filter((x): x is string => !!x)) : null; }
    catch (e) { inv = { ...inv, taxRecordsError: `the products' tax policies couldn't be read: ${e instanceof Error ? e.message : String(e)}` }; }
    d = deriveSalesforceTax(inv, t, log, expected);
    if (d.status !== "CALCULATION_PENDING" || waited >= waitMs) break;
    await api.sleep(interval);
    inv = await api.invoice(inv.id);
  }
  const status: SfTaxStatus = d.status === "CALCULATION_PENDING" && waitMs > 0 ? "CALCULATION_TIMEOUT" : d.status;
  const fresh = run ? { ...run, invoice: inv } : null;
  const extra: TaxDiagnostic[] = [];
  // Read-only evidence (trace + Salesforce's decision-table preview) when Salesforce produced no InvoiceLineTax, or for the
  // application basis of a calculated line. A failure to read it is reported, never hidden.
  let evidence: InvoiceTaxEvidence | null = null;
  if (status === "CALCULATED" || (status === "CALCULATION_FAILED" && d.reason !== null)) {
    const line = status === "CALCULATED" ? inv.lines.find(l => l.taxes.length) : inv.lines.find(l => !l.taxes.length) ?? inv.lines[0];
    try { evidence = await api.evidence(inv.id, line?.id ?? null); }
    catch (e) { extra.push(diag("CALCULATION_REJECTED", `The read-only diagnostic evidence couldn't be read: ${e instanceof Error ? e.message : String(e)}`, { severity: "warning", recordId: inv.id, operation: "Invoice tax evidence (SOQL + decision-table preview)" })); }
  }
  const a = d.actual[0];
  const basis = evidence?.matchedTaxRate ? (typeof evidence.matchedTaxRate.outputs.ApplicationBasis === "string" ? evidence.matchedTaxRate.outputs.ApplicationBasis : null) : null;
  const result: AuthoritativeTax | null = status === "CALCULATED" && a ? { status: "CALCULATED", source: "SALESFORCE", invoiceId: inv.id, invoiceNumber: inv.number, invoiceLineId: a.invoiceLineId, invoiceLineTaxId: a.invoiceLineTaxId, taxAmount: a.taxAmount, taxRate: a.taxRate, taxCode: a.taxCode, applicationBasis: basis, applicationBasisSource: basis ? "TaxRate" : null } : null;
  return {
    ...base, invoiceSummary: { id: inv.id, number: inv.number, status: inv.status, subtotal: inv.subtotal, tax: inv.tax, totalWithTax: inv.totalWithTax, lines: inv.lines.map(l => ({ id: l.id, product: l.product ?? l.name, charge: l.charge, taxAmount: l.taxAmount, taxStatus: l.taxStatus, treatment: l.treatment?.name ?? null })) }, status, reason: status === "CALCULATION_FAILED" ? d.reason : null, taxState: invoiceTaxFlowState(status, status === "CALCULATION_FAILED" ? d.reason : null), invoiceId: inv.id,
    source: status === "CALCULATED" ? "SALESFORCE_INVOICELINETAX" : null,
    actual: status === "CALCULATED" ? d.actual : [],
    result, evidence,
    awaiting: fresh?.confirmation && fresh.next ? { step: fresh.next.action, detail: fresh.confirmation.detail } : null,
    run: fresh ? pickRun(fresh) : base.run,
    verification: fresh ? verificationChain(fresh, d.actual, expectedCode) : [],
    diagnostics: [...diagnostics, ...d.diagnostics, ...extra],
    message: status === "CALCULATION_TIMEOUT" ? `Timed out after ${Math.round(waitMs / 1000)} s waiting for Salesforce's InvoiceLineTax on invoice ${inv.number ?? inv.id} (status ${inv.status}; lines ${inv.lines.map(l => l.taxStatus ?? "—").join(", ")}). Re-check later — nothing was assumed.` : d.message,
  };
}

const pickRun = (r: TaxRunState): SfTaxResult["run"] => ({ order: r.order, items: r.items, schedules: r.schedules, invoice: r.invoice, steps: r.steps, checks: r.checks, taxCalculation: r.taxCalculation });

/** Read-only state of a calculation run (no step is performed, no polling): what Salesforce holds right now. */
export async function readSalesforceTax(api: SfTaxApi, orderId: string): Promise<SfTaxResult> {
  assertId(orderId, "runId");
  const run = await api.runState(orderId);
  const base: SfTaxResult = { success: true, status: "IN_PROGRESS", reason: null, source: null, message: "", runKey: null, orderId, invoiceId: run.invoice?.id ?? null, awaiting: null, actual: [], result: null, expected: null, validation: null, preview: null, evidence: null, readiness: null, run: null, verification: [], createdRecords: [], directTaxApi: DIRECT_TAX_API, diagnostics: [] };
  const out = await fromRun(api, run, base, 0);
  // A read never waits: an unsettled invoice is PENDING, not TIMEOUT.
  return out.status === "CALCULATION_TIMEOUT" ? { ...out, status: "CALCULATION_PENDING" } : out;
}
