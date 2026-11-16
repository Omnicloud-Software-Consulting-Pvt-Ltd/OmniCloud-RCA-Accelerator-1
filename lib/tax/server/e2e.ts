import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { resolveAccount } from "@/lib/billing/server/billingDocuments";
import { BadInputError } from "@/lib/billing/server/payments";
import { runtimeApiFor, type TaxRuntimeApi } from "@/lib/tax/server/runtime";
import { ensureDecisionTableFresh, generateTaxInvoice, getProductTaxReadiness, pipelineFromReadiness, pipelineFromRun, type PipelineStage, type ProductTaxReadiness } from "@/lib/tax/server/pipeline";
import { advanceTaxRun, BILLABLE_ACTIONS, getTaxRun, startVerificationRun, type RunAction, type TaxRunState } from "@/lib/tax/server/verification";

/**
 * END-TO-END TAX VALIDATION — one orchestration over Salesforce's Revenue Cloud lifecycle, built on the existing verification run
 * (verification.ts): Product → Tax Policy → Treatment (→ Item) → Rate → Engine → readiness → Order → Order Product → activation →
 * Billing Schedule → Invoice → Invoice Line → InvoiceLineTax → verification.
 *
 *  · preview  — read-only: readiness + what would be created (Order + Order Product) and what Salesforce generates.
 *  · start    — confirm required: decision table made current, then the verification order is created (Draft).
 *  · advance  — confirm required: performs the run's NEXT Salesforce step (setup, activation, schedules, invoice, tax, posting);
 *               a billable step (activation, schedules, invoice, posting) also needs confirmAction = that exact step. Invoice
 *               generation goes through generateTaxInvoice (eligibility → decision table fresh → Salesforce → InvoiceLineTax check).
 *  · state    — read-only: the run's pipeline from Salesforce's records.
 * Only Salesforce's InvoiceLineTax at the applicable rate makes "Tax Calculation = SUCCESS".
 */

export type E2EMode = "preview" | "start" | "advance" | "state";
export interface E2EInput { confirmAction?: string | null; mode: E2EMode; product?: { id?: string | null; name?: string | null } | null; accountName?: string | null; quantity?: number | null; unitPrice?: number | null; country?: string | null; state?: string | null; orderId?: string | null; confirm?: boolean; key?: string | null; /** The user approved the explicit decision-table refresh step (never performed otherwise). */ approveDecisionTableRefresh?: boolean }

export interface E2EResult {
  success: true; mode: E2EMode;
  status: "BLOCKED" | "READY_TO_START" | "IN_PROGRESS" | "SUCCESS" | "FAILED";
  /** Kept separate on purpose: configuration ≠ Salesforce calculation ≠ InvoiceLineTax generated. */
  outcome: { configuration: "READY" | "WARNING" | "BLOCKED"; salesforceCalculated: boolean; invoiceLineTaxGenerated: boolean; taxCalculation: "SUCCESS" | "FAILED" | "PENDING" | "NOT_STARTED" };
  pipeline: PipelineStage[];
  readiness: ProductTaxReadiness | null;
  run: TaxRunState | null;
  plan: { create: string[]; salesforceGenerates: string[]; requiresConfirmation: boolean } | null;
  next: { action: string; label: string } | null;
  message: string;
}

async function accountContext(api: TaxRuntimeApi, client: SalesforceClient, accountName: string | null | undefined) {
  if (!accountName?.trim()) return null;
  const acc = await resolveAccount(client, accountName);
  if (acc.status !== "found") throw new BadInputError(acc.message);
  const [a] = await api.query(`SELECT BillingCountry, BillingState, BillingCity, BillingPostalCode FROM Account WHERE Id = '${soqlEscape(acc.record.id)}'`);
  return { id: acc.record.id, name: acc.record.name, country: (a?.BillingCountry as string) ?? null, state: (a?.BillingState as string) ?? null, city: (a?.BillingCity as string) ?? null, zip: (a?.BillingPostalCode as string) ?? null };
}

function fromRun(mode: E2EMode, run: TaxRunState, readiness: ProductTaxReadiness | null): E2EResult {
  const ilt = !!run.invoice?.lines.some(l => l.taxes.length);
  return {
    success: true, mode, status: run.complete ? "SUCCESS" : run.endToEnd === "FAILED" ? "FAILED" : "IN_PROGRESS",
    outcome: { configuration: run.steps[0]?.state === "failed" ? "BLOCKED" : "READY", salesforceCalculated: !!run.invoice && run.taxCalculation !== "PENDING" && ilt, invoiceLineTaxGenerated: ilt, taxCalculation: run.taxCalculation },
    pipeline: pipelineFromRun(run), readiness, run, plan: null, next: run.next, message: run.message,
  };
}

export async function runEndToEndTaxValidation(client: SalesforceClient, input: E2EInput): Promise<E2EResult> {
  const api = await runtimeApiFor(client);
  if (input.mode === "state" || input.mode === "advance") {
    if (!input.orderId) throw new BadInputError("orderId is required.");
    if (input.mode === "state") return fromRun("state", await getTaxRun(client, input.orderId), null);
    if (input.confirm !== true) throw new BadInputError("Confirm the next step first.");
    const before = await getTaxRun(client, input.orderId);
    const action = before.next?.action ?? null;
    if (action && BILLABLE_ACTIONS.has(action) && input.confirmAction !== action) return { ...fromRun("advance", before, null), message: `Nothing was done: "${before.next!.label}" is a billable step — confirm it explicitly (${before.confirmation?.detail ?? action}).` };
    if (action === "generate-invoice") {
      // The single invoice-generation path of the Taxes module.
      const gen = await generateTaxInvoice(api, input.orderId, { confirm: true, refresh: input.approveDecisionTableRefresh === true ? "approved" : "never" });
      const after = fromRun("advance", await getTaxRun(client, input.orderId), null);
      return gen.status === "GENERATED" || gen.status === "PROCESSING" ? { ...after, message: `${gen.message} ${after.message}` } : { ...after, status: "FAILED", message: `Invoice not generated: ${gen.message}` };
    }
    return fromRun("advance", await advanceTaxRun(client, input.orderId, { confirm: action as RunAction | null }), null);
  }
  if (!input.product?.id && !input.product?.name) throw new BadInputError("Which product?");
  const acc = await accountContext(api, client, input.accountName);
  const readiness = await getProductTaxReadiness(api, input.product, { country: acc?.country ?? input.country ?? null, state: acc?.state ?? input.state ?? null, city: acc?.city ?? null, zipCode: acc?.zip ?? null });
  const calc = readiness.areas.find(a => a.id === "calculation")?.status;
  const canStart = readiness.status !== "BLOCKED" && readiness.status !== "FAILED" && calc !== "BLOCKED" && !!acc;
  const configuration = (readiness.areas.find(a => a.id === "configuration")?.status ?? "BLOCKED") as "READY" | "WARNING" | "BLOCKED";
  const plan = {
    create: acc && readiness.product ? [`Order (Draft) for ${acc.name}, legal entity and addresses from the account`, `Order Product: ${readiness.product.name} × ${input.quantity ?? 1}${input.unitPrice ? ` @ ${input.unitPrice}` : " at the Standard Price Book price"} with the resolved tax treatment`] : [],
    salesforceGenerates: ["Billing Schedule (after activation)", "Invoice and Invoice Lines (from the billing schedule)", "InvoiceLineTax (Salesforce's Revenue Standard Tax result)"],
    requiresConfirmation: true,
  };
  if (input.mode === "preview" || !canStart) {
    const why = !acc ? "Which customer account should the validation order be for?" : readiness.message;
    return {
      success: true, mode: input.mode, status: canStart ? "READY_TO_START" : "BLOCKED", outcome: { configuration, salesforceCalculated: false, invoiceLineTaxGenerated: false, taxCalculation: "NOT_STARTED" },
      pipeline: pipelineFromReadiness(readiness), readiness, run: null, plan, next: canStart ? { action: "start", label: "Create the validation order" } : null,
      message: canStart ? `Ready to start. Nothing has been created — confirm to create the order; Salesforce then generates the billing schedule, invoice and InvoiceLineTax.` : `Not started — nothing was created. ${why}`,
    };
  }
  if (input.confirm !== true) throw new BadInputError("Confirm before anything is created.");
  const table = await ensureDecisionTableFresh(api, { refresh: input.approveDecisionTableRefresh === true ? "approved" : "never", engineId: readiness.resolution?.treatment.engine?.id ?? null });
  if (table.state !== "Ready") return { success: true, mode: "start", status: "BLOCKED", outcome: { configuration, salesforceCalculated: false, invoiceLineTaxGenerated: false, taxCalculation: "NOT_STARTED" }, pipeline: pipelineFromReadiness(readiness), readiness, run: null, plan, next: null, message: `Not started — the tax decision table is ${table.state}: ${table.reason}` };
  const key = input.key && /^[A-Za-z0-9-]{8,64}$/.test(input.key) ? input.key : `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const started = await startVerificationRun(client, { product: input.product, accountName: input.accountName ?? null, quantity: input.quantity ?? null, unitPrice: input.unitPrice ?? null, key });
  return fromRun("start", await getTaxRun(client, started.orderId), readiness);
}
