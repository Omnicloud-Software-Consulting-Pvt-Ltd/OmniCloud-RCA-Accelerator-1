import { createHash } from "node:crypto";
import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { apiUrl, compositeAt, currentIdentity, latestApiVersion, queryAt } from "@/lib/billing/server/billingDocuments";
import { getDebitMemo } from "@/lib/billing/server/debitMemos";
import { getPaymentModel, loadInvoiceForPayment, recordPayment, type PaymentInvoice } from "@/lib/billing/server/payments";
import { appliedByPayment } from "@/lib/billing/paymentApplications";
import { NotFoundError } from "@/lib/billing/server/payments";
import { invoicePostingGate, invoiceTaxOutcome, TAX_OUTCOME_LABEL, verifyInvoiceTax, type InvoiceTaxOutcome, type InvoiceTaxVerification } from "@/lib/tax/server/invoiceTax";

/**
 * DEBIT MEMO → BILLING → PAYMENT → SETTLEMENT lifecycle, driven step by step through real Salesforce operations.
 * Verified against the connected org (2026-10-05):
 *
 *  Configure  — Posting is rejected until (Salesforce messages): "specify a valid next billing date" and "Specify tax
 *               treatments for all the related debit memo lines". Tax treatment is resolved from existing config (referenced
 *               invoice line → product tax policy → the legal entity's single treatment); ambiguity stops the flow.
 *               Next Billing Date: the one already on the memo (user/prompt supplied at creation) → the account's billing
 *               date (BillingScheduleGroup.EffectiveNextBillingDate, earliest on/after today) → today. Salesforce validates it.
 *  Post       — DebitMemo.Status → Posted; Salesforce sets PostedDate and InvoiceGenerationStatus "Ready for Invoice Generation".
 *
 *  STANDARD BILLING CYCLE (default). Dev guide: "An invoice is generated for the debit memo in the next invoice run … When the
 *               invoice scheduler or API evaluates debit memos to generate invoices, those with a next billing date on or before
 *               the user-specified target date are included in the invoice batch run." So the memo waits until its Next Billing
 *               Date, then a Salesforce invoice batch run bills it: either an org Invoice Scheduler (BillingBatchScheduler) at its
 *               next run, or — when this user has the Billing Operations User + Data Pipelines Base User permission sets the API
 *               requires — "Run Eligible Billing Now": a one-time, start-immediately Invoice Scheduler through
 *               /commerce/invoicing/invoice-schedulers. Its filter can only scope billing schedules (BillingSchedule/
 *               BillingScheduleGroup fields), so everything such a run may pick up is shown and confirmed first.
 *  The standard billing cycle is the ONLY billing path (2026-11-16: the "Process Now" Invoice Ingestion path was removed — it
 *               invoiced the memo outside the customer's billing cycle and confused users).
 *
 *  The proof of billing is Salesforce's own link: InvoiceLine.ReferenceEntityItemId → DebitMemoLine.
 *  Payment    — The existing Settle Payment service (permission probe before creating, idempotency, compensation).
 *  Settled    — Invoice.Balance 0 and Salesforce's own SettlementStatus, re-read.
 */

export const LIFECYCLE_TARGETS = ["draft", "posted", "invoiced", "settled"] as const;
export type LifecycleTarget = (typeof LIFECYCLE_TARGETS)[number];
/** Debit memos are billed only through the standard billing cycle. */
export const BILLING_MODES = ["standard"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
export type StepState = "done" | "current" | "pending" | "failed" | "skipped" | "processing" | "waiting";

export interface LifecycleStep { id: string; label: string; state: StepState; detail: string }
export interface RunPreviewItem { kind: "Debit Memo" | "Billing Schedule"; id: string; number: string | null; account: string | null; amount: number | null; nextBillingDate: string | null; certainty: "included" | "may be included"; isThisMemo: boolean }
export interface BillingState {
  mode: BillingMode;
  nextBillingDate: string | null;
  eligible: boolean;
  eligibility: { label: string; ok: boolean; detail: string }[];
  /** Org Invoice Schedulers that run on their own (Active, JobType Invoice). */
  schedulers: { id: string; name: string; status: string | null; cadence: string | null; nextRunTime: string | null }[];
  runNow: { available: boolean; reason: string | null; permissions: { name: string; label: string; assigned: boolean }[] };
  /** Billing runs Salesforce performed for THIS debit memo (scheduler named after it) — found again on every read. */
  runs: {
    schedulerId: string; schedulerName: string; schedulerStatus: string | null; startImmediately: boolean | null; schedulerStartTime: string | null; targetDate: string | null; invoiceDate: string | null; expectedInvoiceStatus: string | null;
    runId: string | null; runNumber: string | null; runStatus: string | null; statusSubtype: string | null; startTime: string | null; completionTime: string | null;
    billingSchedulesFiltered: number | null; billingSchedulesFailed: number | null; invoicesGenerated: number | null; invoicesFailed: number | null; invoicedAmount: number | null; comments: string | null;
    batchJob: { id: string; status: string | null; detail: string | null } | null;
    /** Salesforce's own description of where this run is — never "success" for Draft/Starting. */
    phase: "draft" | "inactive" | "waiting-to-start" | "processing" | "completed" | "failed";
  }[];
  preview: { targetDate: string; items: RunPreviewItem[]; token: string } | null;
  /** The account's billing schedules due by today — the invoice Salesforce adds the debit memo lines to. */
  dueSchedules: { id: string; number: string | null; nextBillingDate: string | null }[];
  /** Latest Revenue Transaction Error Log for this memo, its lines, schedulers or runs. */
  errorLog: { number: string | null; code: string | null; message: string | null } | null;
}
export interface LifecycleState {
  success: true;
  debitMemoId: string;
  target: LifecycleTarget;
  steps: LifecycleStep[];
  /** What the next advance would do (null when the target is reached, blocked, or waiting for Salesforce). */
  next: { action: "configure" | "post" | "run-billing" | "post-invoice" | "wait" | "create-payment"; label: string; needsConfirmation: boolean; irreversible: boolean } | null;
  failure: { step: string; reason: string; code: string | null; technical?: unknown } | null;
  /**
   * The invoice's tax check before posting (shared verifier): tax applicable and calculated · not applicable · zero tax · applicable
   * but calculation failed · applicability not established · pending. Null until the invoice is ready to post.
   */
  tax: { invoiceId: string; outcome: InvoiceTaxOutcome; label: string; state: string; postable: boolean; message: string; lines: { line: string; verdict: string; reason: string }[] } | null;
  complete: boolean;
  billing: BillingState;
  summary: {
    debitMemo: { id: string; number: string | null; status: string | null; invoiceGenerationStatus: string | null; amount: number | null; postedDate: string | null; nextBillingDate: string | null };
    account: { id: string; name: string } | null;
    invoice: { id: string; number: string | null; status: string | null; total: number | null; balance: number | null; settlementStatus: string | null; debitReflected: number | null; lineIds: string[] } | null;
    payment: { id: string; number: string | null; applied: number } | null;
    billingStatus: string;
    currency: string | null;
  };
  message: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const cents = (n: number) => Math.round(n * 100);
const today = () => new Date().toISOString().slice(0, 10);
const rank = (t: LifecycleTarget) => LIFECYCLE_TARGETS.indexOf(t);
const idList = (ids: string[]) => ids.map(i => `'${soqlEscape(i)}'`).join(",");
const runNamePrefix = (docNumber: string) => `DM ${docNumber} billing run`;

/* ───────────────────────────── Salesforce reads ───────────────────────────── */

interface Snapshot {
  version: string;
  memo: Record<string, unknown>;
  lines: Record<string, unknown>[];
  invoice: PaymentInvoice | null;
  invoiceLinesForMemo: { id: string; amount: number; debitLineId: string }[];
  billing: Omit<BillingState, "mode" | "eligible" | "eligibility" | "preview" | "dueSchedules" | "errorLog"> & { accountNextBillingDate: string | null; accountDueSchedules: { id: string; number: string | null; nextBillingDate: string | null }[] };
  errorLog: { number: string | null; code: string | null; message: string | null } | null;
}

async function snapshot(client: SalesforceClient, id: string): Promise<Snapshot> {
  const version = await latestApiVersion(client);
  const [memo] = await queryAt(client, version, `SELECT Id, DocumentNumber, Status, InvoiceGenerationStatus, PostedDate, NextBillingDate, LegalEntityId, LegalEntity.Name, AccountId, Account.Name, TotalChargeAmount, TotalAmount FROM DebitMemo WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
  if (!memo) throw new NotFoundError("Debit Memo not found in Salesforce (or not visible to your user).");
  const lines = await queryAt(client, version, `SELECT Id, Name, ChargeAmount, Product2Id, ReferenceRecordId, TaxTreatmentId, LegalEntityId FROM DebitMemoLine WHERE DebitMemoId = '${soqlEscape(id)}' ORDER BY CreatedDate, Id`);
  // The invoice Salesforce generated from this debit memo: its lines reference the debit memo lines.
  const lineIds = lines.map(l => l.Id as string);
  const invLines = lineIds.length ? await queryAt(client, client.apiVersion, `SELECT Id, InvoiceId, LineAmount, ChargeAmount, ReferenceEntityItemId FROM InvoiceLine WHERE ReferenceEntityItemId IN (${idList(lineIds)}) ORDER BY CreatedDate DESC`).catch(() => []) : [];
  let invoiceId = (invLines[0]?.InvoiceId as string | undefined) ?? null;
  if (!invoiceId) {
    const [byHeader] = await queryAt(client, client.apiVersion, `SELECT Id FROM Invoice WHERE ReferenceEntityId = '${soqlEscape(id)}' ORDER BY CreatedDate DESC LIMIT 1`).catch(() => []);
    invoiceId = (byHeader?.Id as string | undefined) ?? null;
  }
  const invoice = invoiceId ? await loadInvoiceForPayment(client, invoiceId).catch(() => null) : null;
  const doc = String(memo.DocumentNumber ?? id);
  const accountId = memo.AccountId as string | undefined;
  const [scheds, mine, due, bsg, ps] = await Promise.all([
    queryAt(client, version, "SELECT Id, BillingSchedulerName, Status, FrequencyCadence, NextRunTime FROM BillingBatchScheduler WHERE JobType = 'Invoice' AND Status = 'Active' ORDER BY NextRunTime LIMIT 20").catch(() => []),
    queryAt(client, version, `SELECT Id, BillingSchedulerName, Status, ShouldStartRunImmediately, StartTime, RunCriteriaId, CreatedDate FROM BillingBatchScheduler WHERE BillingSchedulerName LIKE '${soqlEscape(runNamePrefix(doc))}%' ORDER BY CreatedDate`),
    accountId ? queryAt(client, version, `SELECT Id, BillingScheduleNumber, NextBillingDate FROM BillingSchedule WHERE BillingAccountId = '${soqlEscape(accountId)}' AND Status = 'ReadyForInvoicing' AND NextBillingDate <= TODAY ORDER BY NextBillingDate LIMIT 50`) : Promise.resolve([]),
    accountId ? queryAt(client, version, `SELECT EffectiveNextBillingDate FROM BillingScheduleGroup WHERE BillingAccountId = '${soqlEscape(accountId)}' AND EffectiveNextBillingDate >= TODAY ORDER BY EffectiveNextBillingDate LIMIT 1`).catch(() => []) : Promise.resolve([]),
    queryAt(client, version, "SELECT Id, Name, Label FROM PermissionSet WHERE Name = 'RevenueLifecycleManagementBillingOperations' OR Label = 'Data Pipelines Base User'").catch(() => []),
  ]);
  const runs = mine.length ? await queryAt(client, version, `SELECT Id, InvoiceBatchRunNumber, Status, StatusSubtype, BillingBatchSchedulerId, StartTime, CompletionTime, TotalFilteredBillingSchedules, TotalBillingSchedulesFailed, TotalInvoicesGenerated, TotalInvoicesFailed, TotalInvoicedAmount, Comments, BatchJobId FROM InvoiceBatchRun WHERE BillingBatchSchedulerId IN (${idList(mine.map(m => m.Id as string))}) ORDER BY CreatedDate`).catch(() => []) : [];
  const criteriaIds = mine.map(m => m.RunCriteriaId as string).filter(Boolean);
  const criteria = criteriaIds.length ? await queryAt(client, version, `SELECT Id, TargetDate, InvoiceDate, ExpectedInvoiceStatus FROM InvoiceBatchRunCriteria WHERE Id IN (${idList(criteriaIds)})`).catch(() => []) : [];
  const jobIds = runs.map(r => r.BatchJobId as string).filter(Boolean);
  const jobs = jobIds.length ? await queryAt(client, version, `SELECT FIELDS(STANDARD) FROM BatchJob WHERE Id IN (${idList(jobIds)}) LIMIT 20`).catch(() => []) : [];
  const uid = (await currentIdentity(client)).userId;
  const assigned = uid && ps.length ? new Set((await queryAt(client, version, `SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${soqlEscape(uid)}' AND PermissionSetId IN (${idList(ps.map(p => p.Id as string))})`).catch(() => [])).map(a => a.PermissionSetId as string)) : new Set<string>();
  const permissions = [
    { name: "RevenueLifecycleManagementBillingOperations", label: "Billing Operations User" },
    { name: String(ps.find(p => p.Label === "Data Pipelines Base User")?.Name ?? "Data Pipelines Base User"), label: "Data Pipelines Base User" },
  ].map(x => { const p = ps.find(r => r.Name === x.name || r.Label === x.label); return { ...x, assigned: !!p && assigned.has(p.Id as string) }; });
  const missing = permissions.filter(p => !p.assigned);
  const refs = [id, ...lineIds, ...runs.map(r => r.Id as string), ...mine.map(m => m.Id as string)];
  const [log] = await queryAt(client, version, `SELECT ErrorLogNumber, ErrorCode, ErrorMessage FROM RevenueTransactionErrorLog WHERE PrimaryRecordId IN (${idList(refs)}) OR RelatedRecordId IN (${idList(refs)}) ORDER BY CreatedDate DESC LIMIT 1`).catch(() => []);
  return {
    version, memo, lines, invoice,
    invoiceLinesForMemo: invLines.filter(l => l.InvoiceId === invoiceId).map(l => ({ id: l.Id as string, debitLineId: l.ReferenceEntityItemId as string, amount: typeof l.ChargeAmount === "number" ? l.ChargeAmount : typeof l.LineAmount === "number" ? l.LineAmount : 0 })),
    billing: {
      nextBillingDate: (memo.NextBillingDate as string) ?? null, accountNextBillingDate: (bsg[0]?.EffectiveNextBillingDate as string) ?? null,
      accountDueSchedules: due.map(b => ({ id: b.Id as string, number: (b.BillingScheduleNumber as string) ?? null, nextBillingDate: (b.NextBillingDate as string) ?? null })),
      schedulers: scheds.map(r => ({ id: r.Id as string, name: String(r.BillingSchedulerName), status: (r.Status as string) ?? null, cadence: (r.FrequencyCadence as string) ?? null, nextRunTime: (r.NextRunTime as string) ?? null })),
      runNow: { available: missing.length === 0, reason: missing.length ? `Salesforce's Invoice Scheduler API needs the ${missing.map(p => `"${p.label}"`).join(" and ")} permission set${missing.length > 1 ? "s" : ""} for your user (Salesforce dev guide: Batch Invoice Scheduler). Ask an admin to assign them, or to run an invoice batch run for this account from Billing → Invoice Scheduler.` : null, permissions },
      runs: mine.map(m => {
        const r = [...runs].reverse().find(x => x.BillingBatchSchedulerId === m.Id);
        const crit = criteria.find(c => c.Id === m.RunCriteriaId);
        const job = r?.BatchJobId ? jobs.find(j => j.Id === r.BatchJobId) : undefined;
        const num = (v: unknown) => (typeof v === "number" ? v : null);
        const schedulerStatus = (m.Status as string) ?? null;
        const runStatus = (r?.Status as string) ?? null;
        const phase: BillingState["runs"][number]["phase"] = r
          ? /completed/i.test(runStatus ?? "") ? "completed" : /failed|stopped|canceled/i.test(runStatus ?? "") ? "failed" : "processing"
          : /^draft$/i.test(schedulerStatus ?? "") ? "draft" : /inactive|canceled/i.test(schedulerStatus ?? "") ? "inactive" : /completed/i.test(schedulerStatus ?? "") ? "failed" : "waiting-to-start";
        return {
          schedulerId: m.Id as string, schedulerName: String(m.BillingSchedulerName), schedulerStatus, startImmediately: typeof m.ShouldStartRunImmediately === "boolean" ? m.ShouldStartRunImmediately : null, schedulerStartTime: (m.StartTime as string) ?? null,
          targetDate: (crit?.TargetDate as string) ?? null, invoiceDate: (crit?.InvoiceDate as string) ?? null, expectedInvoiceStatus: (crit?.ExpectedInvoiceStatus as string) ?? null,
          runId: (r?.Id as string) ?? null, runNumber: (r?.InvoiceBatchRunNumber as string) ?? null, runStatus, statusSubtype: (r?.StatusSubtype as string) ?? null, startTime: (r?.StartTime as string) ?? null, completionTime: (r?.CompletionTime as string) ?? null,
          billingSchedulesFiltered: num(r?.TotalFilteredBillingSchedules), billingSchedulesFailed: num(r?.TotalBillingSchedulesFailed), invoicesGenerated: num(r?.TotalInvoicesGenerated), invoicesFailed: num(r?.TotalInvoicesFailed), invoicedAmount: num(r?.TotalInvoicedAmount), comments: (r?.Comments as string) ?? null,
          batchJob: job ? { id: job.Id as string, status: (job.Status as string) ?? null, detail: [job.Name, job.ErrorMessage ?? job.FailureReason ?? job.Description].filter(Boolean).map(String).join(" · ") || null } : r?.BatchJobId ? { id: r.BatchJobId as string, status: null, detail: null } : null,
          phase,
        };
      }),
    },
    errorLog: log ? { number: (log.ErrorLogNumber as string) ?? null, code: (log.ErrorCode as string) ?? null, message: (log.ErrorMessage as string) ?? null } : null,
  };
}

/** Everything a Salesforce invoice batch run for this account and target date may pick up (it can't be narrowed to one memo). */
async function runPreview(client: SalesforceClient, s: Snapshot, targetDate: string): Promise<NonNullable<BillingState["preview"]>> {
  const accountId = s.memo.AccountId as string;
  const [memos, schedules] = await Promise.all([
    queryAt(client, s.version, `SELECT Id, DocumentNumber, AccountId, Account.Name, TotalAmount, NextBillingDate FROM DebitMemo WHERE Status = 'Posted' AND InvoiceGenerationStatus = 'Ready for Invoice Generation' AND NextBillingDate <= ${targetDate} ORDER BY AccountId, NextBillingDate LIMIT 200`),
    queryAt(client, s.version, `SELECT Id, BillingScheduleNumber, BillingAccountId, BillingAccount.Name, TotalAmount, NextBillingDate FROM BillingSchedule WHERE BillingAccountId = '${soqlEscape(accountId)}' AND Status = 'ReadyForInvoicing' AND NextBillingDate <= ${targetDate} ORDER BY NextBillingDate LIMIT 200`).catch(() =>
      queryAt(client, s.version, `SELECT Id, BillingScheduleNumber, BillingAccountId, BillingAccount.Name, NextBillingDate FROM BillingSchedule WHERE BillingAccountId = '${soqlEscape(accountId)}' AND Status = 'ReadyForInvoicing' AND NextBillingDate <= ${targetDate} ORDER BY NextBillingDate LIMIT 200`)),
  ]);
  const items: RunPreviewItem[] = [
    ...memos.map(m => ({ kind: "Debit Memo" as const, id: m.Id as string, number: (m.DocumentNumber as string) ?? null, account: String((m.Account as { Name?: string } | null)?.Name ?? m.AccountId), amount: typeof m.TotalAmount === "number" ? m.TotalAmount : null, nextBillingDate: (m.NextBillingDate as string) ?? null, certainty: (m.AccountId === accountId ? "included" : "may be included") as RunPreviewItem["certainty"], isThisMemo: m.Id === s.memo.Id })),
    ...schedules.map(b => ({ kind: "Billing Schedule" as const, id: b.Id as string, number: (b.BillingScheduleNumber as string) ?? null, account: String((b.BillingAccount as { Name?: string } | null)?.Name ?? b.BillingAccountId), amount: typeof b.TotalAmount === "number" ? b.TotalAmount : null, nextBillingDate: (b.NextBillingDate as string) ?? null, certainty: "included" as const, isThisMemo: false })),
  ];
  const token = createHash("sha256").update(JSON.stringify([targetDate, items.map(i => `${i.id}:${i.certainty}`).sort()])).digest("hex").slice(0, 24);
  return { targetDate, items, token };
}

/* ───────────────────────────── Tax treatment resolution ───────────────────────────── */

async function resolveTaxTreatments(client: SalesforceClient, s: Snapshot): Promise<{ updates: { lineId: string; taxTreatmentId: string; source: string }[]; problems: string[] }> {
  const legalEntityId = (s.memo.LegalEntityId as string) ?? null;
  const treatments = await queryAt(client, client.apiVersion, "SELECT Id, Name, Status, LegalEntityId, ProductId, TaxPolicyId, TaxPolicy.Status, TaxPolicy.TreatmentSelection, TaxPolicy.DefaultTaxTreatmentId FROM TaxTreatment WHERE Status = 'Active'");
  const policyOf = (t: Record<string, unknown>) => (t.TaxPolicy ?? {}) as { Status?: string; TreatmentSelection?: string; DefaultTaxTreatmentId?: string };
  const productIds = [...new Set(s.lines.map(l => l.Product2Id as string).filter(Boolean))];
  const products = productIds.length ? await queryAt(client, client.apiVersion, `SELECT Id, Name, TaxPolicyId FROM Product2 WHERE Id IN (${idList(productIds)})`) : [];
  const refIds = s.lines.map(l => l.ReferenceRecordId as string).filter(Boolean);
  const refLines = refIds.length ? await queryAt(client, client.apiVersion, `SELECT Id, TaxTreatmentId FROM InvoiceLine WHERE Id IN (${idList(refIds)})`).catch(() => []) : [];
  const updates: { lineId: string; taxTreatmentId: string; source: string }[] = [];
  const problems: string[] = [];
  for (const l of s.lines) {
    if (l.TaxTreatmentId) continue;
    const name = String(l.Name ?? "line");
    const ref = refLines.find(r => r.Id === l.ReferenceRecordId);
    if (ref?.TaxTreatmentId) { updates.push({ lineId: l.Id as string, taxTreatmentId: ref.TaxTreatmentId as string, source: "the referenced invoice line" }); continue; }
    const product = products.find(p => p.Id === l.Product2Id);
    const policyId = (product?.TaxPolicyId as string) ?? null;
    if (policyId) {
      const ofPolicy = treatments.filter(t => t.TaxPolicyId === policyId && policyOf(t).Status === "Active");
      const selection = policyOf(ofPolicy[0] ?? {}).TreatmentSelection ?? null;
      let pick: Record<string, unknown> | undefined;
      if (selection === "LegalEntity") { const hits = ofPolicy.filter(t => t.LegalEntityId === legalEntityId); pick = hits.length === 1 ? hits[0] : undefined; }
      else if (selection === "Default") pick = ofPolicy.find(t => t.Id === policyOf(t).DefaultTaxTreatmentId);
      if (pick) { updates.push({ lineId: l.Id as string, taxTreatmentId: pick.Id as string, source: `product ${product!.Name}'s tax policy (${selection})` }); continue; }
      problems.push(`No single active tax treatment of ${product!.Name}'s tax policy applies to "${name}"${selection === "Manual" ? " (the policy uses manual selection)" : ""}.`);
      continue;
    }
    const byLegalEntity = treatments.filter(t => t.LegalEntityId === legalEntityId && !t.ProductId && policyOf(t).Status === "Active" && policyOf(t).TreatmentSelection === "LegalEntity");
    if (legalEntityId && byLegalEntity.length === 1) { updates.push({ lineId: l.Id as string, taxTreatmentId: byLegalEntity[0].Id as string, source: `the tax treatment configured for the debit memo's legal entity (${byLegalEntity[0].Name})` }); continue; }
    problems.push(byLegalEntity.length > 1 ? `Several tax treatments apply to "${name}" for this legal entity — choose one in Salesforce.` : `No tax treatment is configured for "${name}" (no product tax policy and none for the debit memo's legal entity).`);
  }
  return { updates, problems };
}

/* ───────────────────────────── State derivation ───────────────────────────── */

function derive(s: Snapshot, target: LifecycleTarget, mode: BillingMode, failure: LifecycleState["failure"], preview: BillingState["preview"]): LifecycleState {
  const memo = s.memo;
  const status = (memo.Status as string) ?? null;
  const igs = (memo.InvoiceGenerationStatus as string) ?? null;
  const total = typeof memo.TotalChargeAmount === "number" ? memo.TotalChargeAmount : null;
  const nbd = (memo.NextBillingDate as string) ?? null;
  const t = today();
  const posted = /^posted$/i.test(status ?? "");
  const ready = posted && /ready for invoice generation|processing|invoice generated/i.test(igs ?? "");
  const inv = s.invoice;
  const invoicePosted = !!inv && /^posted$/i.test(inv.status ?? "");
  const reflected = round2(s.invoiceLinesForMemo.reduce((a, l) => a + l.amount, 0));
  const everyLineBilled = s.lines.length > 0 && s.lines.every(l => s.invoiceLinesForMemo.some(il => il.debitLineId === l.Id));
  const reflectedOk = !!inv && total !== null && everyLineBilled && cents(reflected) === cents(total);
  const payments = inv ? appliedByPayment(inv.applications) : [];
  const appliedTotal = round2(payments.reduce((a, p) => a + p.amount, 0));
  const balanceZero = invoicePosted && (inv!.balance ?? 1) <= 0;
  const settled = balanceZero && appliedTotal > 0 && /settled|paid|closed/i.test(inv!.settlementStatus ?? "") && !/partial|not/i.test(inv!.settlementStatus ?? "");
  const needInvoice = rank(target) >= rank("invoiced");
  const needPay = rank(target) >= rank("settled");
  const runs = s.billing.runs;
  const lastRun = runs[runs.length - 1] ?? null;
  // Draft / Inactive schedulers never run (Help: "Invoices are generated only when the scheduler is active"), so they are not
  // "processing" — they need activation. Only an Active scheduler or a Started run is processing.
  const runActive = !!lastRun && (lastRun.phase === "processing" || lastRun.phase === "waiting-to-start");
  const runNeedsActivation = !!lastRun && (lastRun.phase === "draft" || lastRun.phase === "inactive");
  const runDone = !!lastRun && lastRun.phase === "completed";
  const runFailed = !!lastRun && lastRun.phase === "failed";
  const runText = (r: NonNullable<typeof lastRun>) => [
    `Scheduler ${r.schedulerId} (${r.schedulerStatus ?? "?"}${r.startImmediately ? ", start run now" : ""})`,
    r.runId ? `Invoice Batch Run ${r.runNumber} (${r.runId}) · ${r.runStatus}${r.statusSubtype ? ` · ${r.statusSubtype}` : ""}` : r.phase === "draft" ? "no batch run — the scheduler is Draft, Salesforce won't run it until it's Active" : r.phase === "waiting-to-start" ? "waiting for Salesforce to start the batch run" : "no batch run",
    r.billingSchedulesFiltered !== null ? `${r.billingSchedulesFiltered} billing schedule(s) selected` : null,
    r.invoicesGenerated !== null ? `${r.invoicesGenerated} invoice(s) generated${r.invoicesFailed ? `, ${r.invoicesFailed} failed` : ""}` : null,
  ].filter(Boolean).join(" · ");

  // Eligibility — every check read from Salesforce before anything is billed.
  const eligibility: BillingState["eligibility"] = [
    { label: "Debit memo posted", ok: posted, detail: status ?? "—" },
    { label: "Ready for invoice generation", ok: /ready for invoice generation/i.test(igs ?? "") || !!inv, detail: igs ?? "—" },
    { label: "Next billing date reached", ok: !!nbd && nbd <= t, detail: nbd ? (nbd <= t ? `${nbd} (on or before today, ${t})` : `${nbd} — after today (${t})`) : "not set" },
    { label: "Account", ok: !!memo.AccountId, detail: String((memo.Account as { Name?: string } | null)?.Name ?? "none") },
    { label: "Debit memo lines", ok: s.lines.length > 0, detail: `${s.lines.length} line(s)` },
    { label: "Tax treatment on every line", ok: s.lines.length > 0 && s.lines.every(l => !!l.TaxTreatmentId), detail: `${s.lines.filter(l => l.TaxTreatmentId).length}/${s.lines.length}` },
    { label: "Legal entity", ok: !!memo.LegalEntityId, detail: String((memo.LegalEntity as { Name?: string } | null)?.Name ?? "none") },
    {
      label: "Matching invoice in the billing run", ok: s.billing.accountDueSchedules.length > 0 || !!inv,
      detail: s.billing.accountDueSchedules.length ? `${s.billing.accountDueSchedules.length} billing schedule(s) of the account due by today (${s.billing.accountDueSchedules.slice(0, 3).map(b => b.number).join(", ")}) — Salesforce adds the debit memo lines to that invoice`
        : "No billing schedule of this account is due — a Salesforce invoice batch run adds debit memo lines only to an invoice it generates for the same account, currency and legal entity, so it would bill nothing",
    },
  ];
  const billable = eligibility.filter(e => e.label !== "Next billing date reached" && e.label !== "Matching invoice in the billing run").every(e => e.ok);
  const hasMatchingInvoice = s.billing.accountDueSchedules.length > 0;
  const dateReached = !!nbd && nbd <= t;
  const eligible = billable && dateReached;
  const configured = s.lines.length > 0 && s.lines.every(l => !!l.TaxTreatmentId) && !!nbd;
  const C = inv?.currency ?? "";
  const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${C && C.length === 1 ? C : C ? `${C} ` : ""}${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const schedulerText = s.billing.schedulers.length ? `Salesforce Invoice Scheduler ${s.billing.schedulers.map(x => `"${x.name}" (${x.cadence ?? "?"}, next run ${x.nextRunTime ?? "—"})`).join(", ")}` : "No active Salesforce Invoice Scheduler in this org";

  const steps: LifecycleStep[] = [
    { id: "created", label: "Debit Memo Created", state: "done", detail: `${memo.DocumentNumber} · ${money(total)}` },
    { id: "validated", label: "Debit Memo Validated", state: configured ? "done" : "pending", detail: configured ? `Tax treatment on every line · next billing date ${nbd}` : `${s.lines.filter(l => !l.TaxTreatmentId).length} line(s) without tax treatment${nbd ? "" : " · no next billing date"}` },
    { id: "posted", label: "Debit Memo Posted", state: posted ? "done" : "pending", detail: posted ? `Posted ${memo.PostedDate ?? ""}` : `Status ${status}` },
    { id: "ready", label: "Ready for Billing", state: ready ? "done" : "pending", detail: `InvoiceGenerationStatus: ${igs ?? "—"}` },
    {
      id: "eligible", label: "Billing Date Eligible",
      state: inv || dateReached && posted ? "done" : posted ? "waiting" : "pending",
      detail: nbd ? (dateReached ? `Next billing date ${nbd} has arrived` : `Waiting for billing cycle — next billing date ${nbd}`) : "No next billing date",
    },
    {
      id: "batch", label: "Billing Batch/Scheduler Processed",
      state: inv && (runDone || !runs.length) ? "done" : runActive ? "processing" : runFailed ? "failed" : runNeedsActivation ? "current" : inv ? "processing" : "pending",
      detail: lastRun ? runText(lastRun) : inv ? "Billed by a Salesforce invoice run" : schedulerText,
    },
    { id: "invoice", label: "Invoice Generated", state: inv ? "done" : /processing/i.test(igs ?? "") || runActive ? "processing" : "pending", detail: inv ? `${inv.number} · ${inv.status}` : lastRun?.phase === "processing" ? `Salesforce batch run ${lastRun.runNumber}: ${lastRun.statusSubtype ?? lastRun.runStatus}` : lastRun?.phase === "waiting-to-start" ? "Waiting for Salesforce to start the invoice batch run" : /processing/i.test(igs ?? "") ? "Salesforce is generating the invoice" : "Not generated" },
    { id: "reflected", label: "Debit Charge Reflected", state: reflectedOk ? "done" : inv ? "failed" : "pending", detail: inv ? `Invoice lines originating from this debit memo's lines (InvoiceLine.ReferenceEntityItemId): ${money(reflected)} of ${money(total)}` : "—" },
    { id: "invoice-posted", label: "Invoice Posted", state: invoicePosted ? "done" : inv ? "current" : "pending", detail: inv ? `${inv.number} · ${inv.status}` : "—" },
    { id: "pay-confirm", label: "Payment Confirmation", state: payments.length ? "done" : "pending", detail: payments.length ? "Confirmed" : invoicePosted ? `Balance ${money(inv!.balance)} — awaiting your confirmation` : "—" },
    { id: "payment", label: "Payment Created", state: payments.length ? "done" : "pending", detail: payments.length ? payments.map(p => p.paymentNumber).join(", ") : "No payment" },
    { id: "applied", label: "Payment Applied", state: appliedTotal > 0 ? "done" : "pending", detail: appliedTotal > 0 ? `${money(appliedTotal)} applied to ${inv!.number}` : "—" },
    { id: "balance", label: "Invoice Balance Verified", state: balanceZero && appliedTotal > 0 ? "done" : "pending", detail: inv ? `Balance ${money(inv.balance)}` : "—" },
    { id: "settled", label: "Settlement Complete", state: settled ? "done" : "pending", detail: inv ? `SettlementStatus: ${inv.settlementStatus ?? "—"}` : "—" },
    { id: "complete", label: "End-to-End Success", state: "pending", detail: "" },
  ];
  // Steps beyond the requested target are skipped, not pending.
  const cut = { draft: "validated", posted: "ready", invoiced: "invoice-posted", settled: "complete" }[target];
  const cutIdx = steps.findIndex(x => x.id === cut);
  steps.forEach((st, i) => { if (i > cutIdx && st.state !== "done") st.state = "skipped"; });
  if (target === "draft") steps[1].state = configured ? "done" : "skipped";

  let next: LifecycleState["next"] = null;
  let waiting: string | null = null;
  if (!failure) {
    if (rank(target) >= rank("posted") && !configured) next = { action: "configure", label: "Apply tax treatment and next billing date", needsConfirmation: false, irreversible: false };
    else if (rank(target) >= rank("posted") && !posted) next = { action: "post", label: "Post the debit memo", needsConfirmation: false, irreversible: true };
    else if (needInvoice && posted && !inv) {
      if (/processing/i.test(igs ?? "") || runActive) next = { action: "wait", label: runActive ? (lastRun!.runId ? `Salesforce invoice batch run ${lastRun!.runNumber}: ${lastRun!.statusSubtype ?? lastRun!.runStatus}` : `Waiting for Salesforce to start the batch run of scheduler ${lastRun!.schedulerId}`) : "Waiting for Salesforce to generate the invoice", needsConfirmation: false, irreversible: false };
      else if (runNeedsActivation && s.billing.runNow.available) next = { action: "run-billing", label: `Activate Salesforce invoice scheduler ${lastRun!.schedulerId} (${lastRun!.schedulerStatus}) and start its run`, needsConfirmation: true, irreversible: true };
      else if (!dateReached) waiting = `Waiting for billing cycle — next billing date ${nbd}. Salesforce bills it in the first invoice run on or after that date.`;
      else if (!billable) waiting = `Not eligible for billing: ${eligibility.filter(e => !e.ok).map(e => e.label).join(", ")}.`;
      else if (!hasMatchingInvoice && !runNeedsActivation) waiting = `Waiting for the account's next billing invoice: Salesforce's invoice batch run adds debit memo lines to the invoice it generates for ${String((memo.Account as { Name?: string } | null)?.Name ?? "the account")} (same currency and legal entity), and no billing schedule of the account is due yet. When one is due, the next run bills the debit memo with it.`;
      else if (s.billing.runNow.available) next = { action: "run-billing", label: "Run eligible billing now (Salesforce invoice batch run)", needsConfirmation: true, irreversible: true };
      else waiting = `${schedulerText}. ${s.billing.runNow.reason}`;
    } else if (needInvoice && inv && !invoicePosted) next = /draft$/i.test(inv.status ?? "") ? { action: "post-invoice", label: `Post invoice ${inv.number}`, needsConfirmation: false, irreversible: true } : { action: "wait", label: `Waiting for Salesforce (${inv.status})`, needsConfirmation: false, irreversible: false };
    else if (needPay && invoicePosted && reflectedOk && (inv!.balance ?? 0) > 0) next = { action: "create-payment", label: `Create and apply a payment of ${money(inv!.balance)} to ${inv!.number}`, needsConfirmation: true, irreversible: true };
  }
  // A finished run that didn't bill this memo: show Salesforce's own result and log at step 6. It is a hard stop only while
  // nothing has changed; once the account has billing due again, a NEW run (confirmed again) can bill it — the old run is
  // never re-used or duplicated.
  if (needInvoice && !inv && (runDone || runFailed)) {
    const runResult = `Salesforce invoice batch run ${lastRun!.runNumber ?? lastRun!.schedulerName} ${lastRun!.runStatus}${lastRun!.statusSubtype ? ` (${lastRun!.statusSubtype})` : ""}: ${lastRun!.billingSchedulesFiltered ?? 0} billing schedule(s) selected, ${lastRun!.invoicesGenerated ?? 0} invoice(s) generated, ${lastRun!.invoicesFailed ?? 0} failed — no invoice line references ${memo.DocumentNumber}'s lines.${lastRun!.comments ? ` ${lastRun!.comments}` : ""}${lastRun!.batchJob ? ` Batch job ${lastRun!.batchJob.id}: ${lastRun!.batchJob.status ?? "—"}.` : ""}${s.errorLog ? ` Salesforce error ${s.errorLog.number}: ${s.errorLog.code} — ${s.errorLog.message}` : ""}`;
    const batch = steps.find(x => x.id === "batch")!;
    batch.state = "failed"; batch.detail = runResult;
    if (!failure && !next) failure = { step: "batch", code: runFailed ? "BILLING_RUN_FAILED" : "NOT_BILLED_BY_RUN", reason: `${runResult}${waiting ? ` ${waiting}` : ""}` };
    if (next?.action === "run-billing") next = { ...next, label: `Start a new Salesforce invoice batch run (the last one, ${lastRun!.runNumber}, didn't bill this debit memo)` };
  }
  const reached = target === "draft" ? true : target === "posted" ? posted && ready : target === "invoiced" ? invoicePosted && reflectedOk : settled && reflectedOk;
  const complete = reached && !failure;
  if (complete) { steps[steps.length - 1].state = target === "settled" ? "done" : "skipped"; if (target === "settled") steps[steps.length - 1].detail = "Every step verified in Salesforce"; }
  if (failure) { const f = steps.find(x => x.id === failure.step); if (f) { f.state = "failed"; f.detail = failure.reason; } }
  else if (next) { const cur = steps.find(x => x.state === "pending" || x.state === "current" || x.state === "processing"); if (cur && cur.state === "pending") cur.state = "current"; }

  const billingStatus = inv ? (runs.length ? `Processed by Salesforce invoice batch run ${lastRun?.runNumber ?? ""}`.trim() : "Processed") : runActive ? "Processing in Salesforce" : posted && !dateReached ? "Waiting for billing cycle" : posted ? "Ready for billing" : "Not posted";
  const lastPay = payments[payments.length - 1];
  return {
    success: true, debitMemoId: memo.Id as string, target, steps, next, failure, complete, tax: null,
    billing: { mode, nextBillingDate: nbd, eligible, eligibility, dueSchedules: s.billing.accountDueSchedules, errorLog: inv ? null : s.errorLog, schedulers: s.billing.schedulers, runNow: s.billing.runNow, runs, preview: next?.action === "run-billing" ? preview : null },
    summary: {
      debitMemo: { id: memo.Id as string, number: (memo.DocumentNumber as string) ?? null, status, invoiceGenerationStatus: igs, amount: total, postedDate: (memo.PostedDate as string) ?? null, nextBillingDate: nbd },
      account: memo.AccountId ? { id: memo.AccountId as string, name: String((memo.Account as { Name?: string } | null)?.Name ?? memo.AccountId) } : null,
      invoice: inv ? { id: inv.id, number: inv.number, status: inv.status, total: inv.total, balance: inv.balance, settlementStatus: inv.settlementStatus, debitReflected: reflected, lineIds: s.invoiceLinesForMemo.map(l => l.id) } : null,
      payment: lastPay ? { id: lastPay.paymentId, number: lastPay.paymentNumber, applied: appliedTotal } : null,
      billingStatus, currency: inv?.currency ?? null,
    },
    message: failure ? `Stopped at "${steps.find(x => x.id === failure!.step)?.label}": ${failure.reason}`
      : complete ? (target === "settled" ? "End-to-end complete — verified in Salesforce." : `Reached "${target}" — verified in Salesforce.`)
        : waiting ?? (next ? next.label : "Waiting for Salesforce."),
  };
}

const modeOf = (target: LifecycleTarget, mode: BillingMode) => (rank(target) >= rank("invoiced") ? mode : "standard");

/**
 * Pure: attach the invoice's tax check to the lifecycle, and show it on the "Invoice Posted" step (unless that step failed, where the
 * failure reason is shown). Only an invoice the shared posting gate accepts is shown as postable.
 */
export function withTaxCheck(state: LifecycleState, v: InvoiceTaxVerification | null): LifecycleState {
  if (!v?.invoice) return state;
  const outcome = invoiceTaxOutcome(v);
  const postable = invoicePostingGate(v).allowed;
  const tax: NonNullable<LifecycleState["tax"]> = {
    invoiceId: v.invoice.id, outcome, label: TAX_OUTCOME_LABEL[outcome], state: v.state, postable, message: v.derivation.message,
    lines: (v.derivation.applicability?.lines ?? []).map(l => ({ line: l.line, verdict: l.verdict, reason: l.reason })),
  };
  const steps = state.steps.map(st => (st.id === "invoice-posted" && st.state !== "failed" && st.state !== "done" ? { ...st, detail: `${st.detail} · Tax check: ${tax.label}${postable ? "" : " — posting blocked"}` } : st));
  return { ...state, steps, tax };
}

/** The lifecycle failure for a tax-blocked invoice: names which of the three cases it is. */
export function taxPostingFailure(v: InvoiceTaxVerification, gate: { code: string; error: string; findings: unknown }): { step: string; reason: string; code: string; technical: unknown } {
  const outcome = invoiceTaxOutcome(v);
  const code = outcome === "TAX_CALCULATION_FAILED" || outcome === "TAX_APPLICABILITY_UNDETERMINED" || outcome === "TAX_PENDING" ? outcome : gate.code;
  return { step: "invoice-posted", reason: `${TAX_OUTCOME_LABEL[outcome]}. ${gate.error}`, code, technical: { taxState: v.state, gateCode: gate.code, reason: v.derivation.reason, applicability: v.derivation.applicability ?? null, diagnostics: gate.findings } };
}

export async function getLifecycle(client: SalesforceClient, id: string, target: LifecycleTarget, mode: BillingMode = "standard", opts: { checkTax?: boolean; snap?: Snapshot } = {}): Promise<LifecycleState> {
  const s = opts.snap ?? await snapshot(client, id);
  const m = modeOf(target, mode);
  const state = derive(s, target, m, null, null);
  // A Draft invoice ready to post: show whether its tax lets it be posted (read-only — the same verifier the posting step uses).
  if (state.next?.action === "post-invoice" && s.invoice && opts.checkTax !== false) return withTaxCheck(state, await verifyInvoiceTax(client, s.invoice.id));
  if (state.next?.action !== "run-billing") return state;
  return derive(s, target, m, null, await runPreview(client, s, today()));
}

/* ───────────────────────────── Advance one step ───────────────────────────── */

const locks = (globalThis as { __rcbDmLifecycle?: Map<string, Promise<LifecycleState>> }).__rcbDmLifecycle ??= new Map();

export interface AdvanceOptions { confirmPayment?: boolean; paymentKey?: string | null; confirmBilling?: boolean; previewToken?: string | null }

export function advanceLifecycle(client: SalesforceClient, id: string, target: LifecycleTarget, mode: BillingMode, opts: AdvanceOptions): Promise<LifecycleState> {
  const key = `${client.instanceUrl}:${id}`;
  const running = locks.get(key);
  if (running) return running; // a double click joins the running step instead of repeating it
  const p = doAdvance(client, id, target, modeOf(target, mode), opts).finally(() => locks.delete(key));
  locks.set(key, p);
  return p;
}

const sfErrors = (json: unknown): { message?: string; errorCode?: string }[] => (Array.isArray(json) ? (json as { message?: string; errorCode?: string }[]) : []);

async function doAdvance(client: SalesforceClient, id: string, target: LifecycleTarget, mode: BillingMode, opts: AdvanceOptions): Promise<LifecycleState> {
  const s = await snapshot(client, id);
  // The posting step verifies tax itself, freshly, right before posting — not twice.
  const state = await getLifecycle(client, id, target, mode, { checkTax: false, snap: s });
  const next = state.next;
  if (!next || next.action === "wait") return state;
  const reread = async () => getLifecycle(client, id, target, mode);
  const fail = async (step: string, reason: string, code: string | null, technical?: unknown) => {
    console.error("[debit-memo lifecycle]", step, code, reason);
    return derive(await snapshot(client, id), target, mode, { step, reason, code, technical }, null);
  };

  if (next.action === "configure") {
    const { updates, problems } = await resolveTaxTreatments(client, s);
    if (problems.length) return fail("validated", problems.join(" "), "TAX_TREATMENT_UNRESOLVED");
    // Next Billing Date: already on the memo (user/prompt) → the account's next billing date → today. Never invented.
    const nbd = s.memo.NextBillingDate ? null : s.billing.accountNextBillingDate ?? today();
    const requests = [
      ...(nbd ? [{ method: "PATCH" as const, url: `/sobjects/DebitMemo/${id}`, referenceId: "memo", body: { NextBillingDate: nbd } }] : []),
      ...updates.map((u, i) => ({ method: "PATCH" as const, url: `/sobjects/DebitMemoLine/${u.lineId}`, referenceId: `line${i}`, body: { TaxTreatmentId: u.taxTreatmentId } })),
    ];
    if (requests.length) {
      const r = await compositeAt(client, s.version, requests);
      if (!r.ok) return fail("validated", `Salesforce rejected the billing/tax configuration: ${r.errors.map(e => e.message).join("; ")}`, r.errors[0]?.errorCode ?? null, r.errors);
    }
    return reread();
  }

  if (next.action === "post") {
    const res = await client.requestWithDiagnostics(apiUrl(client, s.version, `/sobjects/DebitMemo/${id}`), { method: "PATCH", body: JSON.stringify({ Status: "Posted" }) });
    if (res.status >= 400) { const e = sfErrors(res.json)[0]; return fail("posted", `Salesforce didn't post the debit memo: ${e?.message ?? res.statusText}`, e?.errorCode ?? null, res.json); }
    const after = await snapshot(client, id);
    if (!/^posted$/i.test((after.memo.Status as string) ?? "")) return derive(after, target, mode, { step: "posted", reason: `Salesforce accepted the request but the debit memo is "${after.memo.Status}".`, code: "NOT_POSTED" }, null);
    return reread();
  }

  if (next.action === "run-billing") {
    // STANDARD cycle: the real Salesforce invoice batch run — an ACTIVE one-time Invoice Scheduler with "start run now" (Help:
    // "Invoices are generated only when the scheduler is active"). It may also bill other eligible items; the user confirmed
    // the exact preview (token) first. An existing Draft/Inactive scheduler of this memo is activated, never duplicated.
    if (!opts.confirmBilling) return state;
    if (!state.billing.preview || opts.previewToken !== state.billing.preview.token) return fail("batch", "What this billing run would include changed in Salesforce since you reviewed it — review the refreshed preview and confirm again.", "PREVIEW_CHANGED");
    const doc = String(s.memo.DocumentNumber ?? id);
    const existing = [...s.billing.runs].reverse().find(r => r.phase === "draft" || r.phase === "inactive" || r.phase === "waiting-to-start" || r.phase === "processing") ?? null;
    if (existing && (existing.phase === "waiting-to-start" || existing.phase === "processing")) return reread(); // already running — resume, don't start another
    const targetDate = existing?.targetDate ?? state.billing.preview.targetDate;
    const body = {
      schedulerName: existing?.schedulerName ?? `${runNamePrefix(doc)} ${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`,
      status: "Active", invoiceStatus: "Draft", jobType: "Invoice", frequencyCadence: "Once",
      // No startDate: Salesforce rejects it together with "start run now" (INVALID_INPUT, verified).
      frequencyCadenceOptions: { shouldStartRunImmediately: true }, targetDate, invoiceDate: existing?.invoiceDate ?? today(),
      filterCriteria: [{ operation: "Equals", value: s.memo.AccountId, criteriaSequence: 1, objectName: "BillingSchedule", fieldName: "BillingAccount" }],
    };
    const send = async (method: "POST" | "PUT", path: string, payload: Record<string, unknown>) => {
      const res = await client.requestWithDiagnostics(apiUrl(client, s.version, path), { method, body: JSON.stringify(payload) });
      const json = res.json as { billingBatchScheduler?: { id?: string }; errors?: { message?: string; errorCode?: string }[] } | { message?: string; errorCode?: string }[] | null;
      const errs = Array.isArray(json) ? json : json?.errors ?? [];
      return { res, errs, schedulerId: (!Array.isArray(json) ? json?.billingBatchScheduler?.id : undefined) ?? null };
    };
    let out = existing
      ? await send("PUT", `/commerce/invoicing/invoice-schedulers/${existing.schedulerId}`, body)
      : await send("POST", "/commerce/invoicing/invoice-schedulers", body);
    // Some API versions reject "jobType" (68.0+ only) — retry once without it, keeping every other value.
    if ((out.res.status >= 400 || out.errs.length) && out.errs.some(e => /jobType/i.test(e.message ?? ""))) {
      const { jobType: _omit, ...rest } = body; void _omit;
      out = existing ? await send("PUT", `/commerce/invoicing/invoice-schedulers/${existing.schedulerId}`, rest) : await send("POST", "/commerce/invoicing/invoice-schedulers", rest);
    }
    if (out.res.status >= 400 || out.errs.length) return fail("batch", `Salesforce didn't ${existing ? `activate scheduler ${existing.schedulerId}` : "start the invoice batch run"}: ${out.errs.map(e => `${e.errorCode ? `${e.errorCode}: ` : ""}${e.message}`).join("; ") || out.res.rawText || out.res.statusText}`, out.errs[0]?.errorCode ?? `HTTP_${out.res.status}`, out.res.json ?? out.res.rawText);
    // Asynchronous in Salesforce: poll the scheduler → InvoiceBatchRun → invoice lines; the UI keeps polling after this returns.
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const snap = await snapshot(client, id);
      const last = snap.billing.runs[snap.billing.runs.length - 1];
      if (snap.invoice || (last && (last.phase === "completed" || last.phase === "failed"))) break;
    }
    return reread();
  }

  if (next.action === "post-invoice" && s.invoice) {
    // The same tax gate as order invoices, re-evaluated on every attempt (including "Retry from this step"): posting only when tax
    // applies and Salesforce's InvoiceLineTax verifies it, or tax is proven not to apply / zero-rated. The existing Draft invoice is
    // re-used — nothing is regenerated.
    const tax = await verifyInvoiceTax(client, s.invoice.id);
    const gate = invoicePostingGate(tax);
    const blocked = !gate.allowed ? taxPostingFailure(tax, gate) : null;
    if (!gate.allowed) return fail(blocked!.step, blocked!.reason, blocked!.code, blocked!.technical).then(st => withTaxCheck(st, tax));
    const res = await client.requestWithDiagnostics("/commerce/invoicing/invoices/collection/actions/post", { method: "POST", body: JSON.stringify({ invoiceIds: [s.invoice.id] }) });
    const json = res.json as { success?: boolean; errors?: { message?: string; errorCode?: string }[] } | null;
    const errs = Array.isArray(res.json) ? sfErrors(res.json) : json?.success === false ? json.errors ?? [] : [];
    if (res.status >= 400 || errs.length) return withTaxCheck(await fail("invoice-posted", `Salesforce didn't post invoice ${s.invoice.number}: ${errs.map(e => e.message).join("; ") || res.statusText}`, errs[0]?.errorCode ?? null, res.json ?? res.rawText), tax);
    for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 2500)); const snap = await snapshot(client, id); if (snap.invoice && /^posted$/i.test(snap.invoice.status ?? "")) break; }
    const after = await reread();
    return after.tax ? after : withTaxCheck(after, tax);
  }

  if (next.action === "create-payment" && s.invoice) {
    if (!opts.confirmPayment) return state; // irreversible — needs the user's explicit confirmation
    const model = await getPaymentModel(client);
    const out = await recordPayment(client, {
      invoiceId: s.invoice.id, amount: s.invoice.balance ?? 0, level: "lines", idempotencyKey: opts.paymentKey ?? null, invoiceToken: s.invoice.token,
      paymentDate: today(), status: model.defaults.status, type: model.defaults.type,
      comments: `Settles debit memo ${s.memo.DocumentNumber} (invoice ${s.invoice.number})`,
    });
    if (!out.ok) return fail("payment", `${out.error}${out.possibleCause ? ` ${out.possibleCause}` : ""}`, out.code, out.technical);
    return reread();
  }
  return state;
}

/** Read the debit memo + lifecycle in one call (for the result view). */
export async function getDebitMemoWithLifecycle(client: SalesforceClient, id: string, target: LifecycleTarget, mode: BillingMode = "standard") {
  const [dm, lifecycle] = await Promise.all([getDebitMemo(client, id), getLifecycle(client, id, target, mode)]);
  return { ...dm, lifecycle };
}
