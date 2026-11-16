import type { SalesforceClient } from "@/lib/salesforce/client";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { staleDecisionTables, type StaleTable } from "@/lib/tax/server/taxApplicability";
import { BadInputError } from "@/lib/billing/server/payments";
import { isInvoiceProcessing, verifyInvoiceTax, type InvoiceTaxVerification } from "@/lib/tax/server/invoiceTax";
import { calculateEstimatedTax } from "@/lib/tax/server/verification";

/**
 * INVOICE TAX RECALCULATION — an explicit, separately approved action for a Draft invoice whose taxable lines Salesforce left
 * Estimated / Pending without InvoiceLineTax (p10 DOC-000000034 / DOC-000000035). It only asks Salesforce to run its own estimated-tax
 * calculation (calculate-estimated-tax, Draft only) and then re-reads the invoice: success is reported only when the InvoiceLineTax
 * records exist and Invoice.TotalTaxAmount equals their sum (verifyInvoiceTax). Nothing is ever written to InvoiceLineTax.
 *
 *  · no token     → preview: eligibility, the reason, the lines' decision tables, and the confirmation token (read-only).
 *  · token        → Salesforce's calculation (requested once), then a bounded wait until the invoice is back to Draft and settled;
 *                   still processing at the timeout → STILL_PENDING, never "not verified".
 * A recalculation while a line's decision table is stale is refused: the lookup would return No Match again.
 */

export type { StaleTable };
export interface RecalcApi {
  verify(invoiceId: string): Promise<InvoiceTaxVerification>;
  calculate(invoiceId: string): Promise<{ ok: true } | { ok: false; status: number; code: string; error: string }>;
  /** Decision tables of the given treatments' engines that have Tax Rates changed after their last refresh. */
  staleTables(treatmentIds: string[]): Promise<StaleTable[]>;
  sleep(ms: number): Promise<void>;
}

export type RecalcOutcome = "VERIFIED_TAX_APPLIED" | "VERIFIED_ZERO_TAX" | "STILL_PENDING" | "TAX_NOT_VERIFIED" | "REJECTED";
export type RecalcResult =
  | { mode: "preview"; eligible: boolean; reason: string; confirmation: string | null; staleTables: StaleTable[]; verification: InvoiceTaxVerification }
  | { mode: "recalculate"; outcome: RecalcOutcome; message: string; verification: InvoiceTaxVerification };

export const recalcToken = (invoiceId: string) => `recalculate-invoice-tax:${invoiceId.slice(0, 15)}`;
const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const UNTAXED = /^(estimated|pending)$/i;

/** Pure: may this invoice's tax be recalculated now? */
export function recalcEligibility(v: InvoiceTaxVerification, stale: StaleTable[]): { eligible: boolean; reason: string } {
  const inv = v.invoice;
  if (!inv) return { eligible: false, reason: v.derivation.message };
  const doc = inv.number ?? inv.id;
  if (!/^draft$/i.test(inv.status ?? "")) return { eligible: false, reason: `${doc} is ${inv.status ?? "not Draft"} — Salesforce recalculates estimated tax on Draft invoices only.` };
  if (v.state === "VERIFIED_TAX_APPLIED") return { eligible: false, reason: `${doc}'s tax is already verified: InvoiceLineTax exists on every taxable line and matches TotalTaxAmount.` };
  const lines = inv.lines.filter(l => !l.taxes.length && (!l.taxStatus || UNTAXED.test(l.taxStatus)));
  if (!lines.length) return { eligible: false, reason: `No line of ${doc} is Estimated or Pending without InvoiceLineTax — nothing to recalculate.` };
  if (stale.length) return { eligible: false, reason: `Refresh first: ${stale.map(s => `decision table ${s.table} (${s.tableId}, engine "${s.engine}") was last refreshed ${s.refreshedAt ?? "never"}, before Tax Rate change(s) ${s.ratesChangedAfter.join(", ")}`).join("; ")}. Recalculating now would return No Match again.` };
  return { eligible: true, reason: `${lines.length} line(s) of ${doc} are ${[...new Set(lines.map(l => l.taxStatus ?? "unprocessed"))].join("/")} without InvoiceLineTax — Salesforce can recalculate them.` };
}

export async function recalculateInvoiceTax(api: RecalcApi, input: { invoiceId: string; confirm?: string | null }, opts: { pollMs?: number; maxWaitMs?: number } = {}): Promise<RecalcResult> {
  const { pollMs = 3000, maxWaitMs = 60_000 } = opts;
  if (!SFID.test(input.invoiceId)) throw new BadInputError("invoiceId isn't a valid Salesforce Id.");
  const before = await api.verify(input.invoiceId);
  const treatmentIds = [...new Set((before.invoice?.lines ?? []).map(l => l.treatment?.id).filter((x): x is string => !!x))];
  const stale = treatmentIds.length ? await api.staleTables(treatmentIds) : [];
  const { eligible, reason } = recalcEligibility(before, stale);
  const token = recalcToken(input.invoiceId);
  if (input.confirm !== token || !eligible) {
    if (input.confirm && input.confirm !== token) throw new BadInputError(`The confirmation doesn't match invoice ${input.invoiceId} — nothing was recalculated.`);
    return { mode: "preview", eligible, reason, confirmation: eligible ? token : null, staleTables: stale, verification: before };
  }
  const doc = before.invoice?.number ?? input.invoiceId;
  // Salesforce processes the request asynchronously (DOC-000000035: Draft → Draft In Progress → Draft, the line "Estimated" all
  // along), so a read right after the request can still show the old state. Settled = Salesforce visibly acted on THIS request (the
  // invoice was seen processing, or it changed since the baseline read) and isn't processing any more. A LastModifiedDate change alone
  // isn't completion; an unchanged invoice may simply not have started.
  const baseline = before.invoice?.modifiedAt ?? null;
  let sawProcessing = false;
  const settled = (x: InvoiceTaxVerification) => {
    if (!x.invoice) return true; // unreadable: reported below, never waited on
    if (isInvoiceProcessing(x.invoice.status)) { sawProcessing = true; return false; }
    return x.state !== "TAX_PENDING" && (sawProcessing || (x.invoice.modifiedAt ?? null) !== baseline);
  };
  // Requested exactly once — never repeated automatically.
  const out = await api.calculate(input.invoiceId);
  if (!out.ok) return { mode: "recalculate", outcome: "REJECTED", message: `Salesforce rejected the tax recalculation of ${doc} (HTTP ${out.status} ${out.code}): ${out.error}`, verification: before };
  let v = await api.verify(input.invoiceId);
  for (let waited = 0; !settled(v) && waited < maxWaitMs; waited += pollMs) { await api.sleep(pollMs); v = await api.verify(input.invoiceId); }
  const inv = v.invoice;
  if (!settled(v)) return { mode: "recalculate", outcome: "STILL_PENDING", message: `Salesforce is still processing ${doc}${inv?.status ? ` (status ${inv.status})` : ""}; check again shortly. The recalculation was requested once and isn't repeated.`, verification: v };
  if (!inv) return { mode: "recalculate", outcome: "TAX_NOT_VERIFIED", message: `Salesforce ran the recalculation of ${doc}, but the invoice couldn't be read back: ${v.derivation.message}`, verification: v };
  // The recalculation runs on a Draft invoice and must hand it back as Draft; anything else (Error…) is reported with Salesforce's detail.
  if ((inv.status ?? "").trim().toLowerCase() !== "draft") return { mode: "recalculate", outcome: "TAX_NOT_VERIFIED", message: `Salesforce finished processing ${doc} with status ${inv.status ?? "unknown"} (expected Draft): ${v.derivation.message}`, verification: v };
  if (v.state === "VERIFIED_TAX_APPLIED") return { mode: "recalculate", outcome: "VERIFIED_TAX_APPLIED", message: `Salesforce recalculated ${doc}: ${v.derivation.message}`, verification: v };
  if (v.state === "VERIFIED_ZERO_TAX") return { mode: "recalculate", outcome: "VERIFIED_ZERO_TAX", message: `Salesforce recalculated ${doc}: ${v.derivation.message}`, verification: v };
  return { mode: "recalculate", outcome: "TAX_NOT_VERIFIED", message: `Salesforce ran the recalculation of ${doc}, but its tax is still not verified: ${v.derivation.message}`, verification: v };
}

export async function recalcApiFor(client: SalesforceClient): Promise<RecalcApi> {
  const v = (await discoverTaxMetadata(client)).apiVersion;
  return {
    verify: id => verifyInvoiceTax(client, id),
    calculate: id => calculateEstimatedTax(client, id),
    staleTables: treatmentIds => staleDecisionTables(client, v, treatmentIds),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  };
}
