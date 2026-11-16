"use client";

import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, PrimaryButton, GhostButton, PageShell, FooterBar, Spinner, ErrorPanel, CodeBlock } from "@/components/data/quotes/shared";
import ReferenceLookup from "@/components/data/shared/ReferenceLookup";
import { BILLING_SEARCH_ENDPOINT } from "@/components/data/billing/BillingFieldInput";
import { Panel, StatusPill, Modal, Row, LoadingRow, StatTile, useBillingData } from "@/components/data/billing/billingUi";
import { InvoicePicker, Field } from "@/components/data/billing/BillingPaymentsWorkspace";
import { useSalesforceSuccess, useNotify } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiGet, quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import type { DebitInterpretation, DebitMemoLineRecord, DebitMemoModel, DebitMemoRecord, DebitResolution } from "@/lib/billing/server/debitMemos";
import type { LifecycleState, LifecycleTarget } from "@/lib/billing/server/debitMemoLifecycle";
import { Disclosure, DISCLOSURE_LABELS, WarningsDisclosure, ConfigNotesDisclosure } from "@/components/ui/Disclosure";
import PromptGuide from "@/components/ai/PromptGuide";
import { billingPromptGuides } from "@/lib/ai/promptGuides/billing";

const TARGETS: { id: LifecycleTarget; label: string; detail: string }[] = [
  { id: "draft", label: "Create only (leave as Draft)", detail: "Creates the debit memo and its lines. Nothing is posted or billed." },
  { id: "posted", label: "Create and post", detail: "Applies tax treatment and the next billing date from Salesforce configuration, then posts it (Ready for Invoice Generation)." },
  { id: "invoiced", label: "Post and bill", detail: "Also bills it in the standard billing cycle (the next Salesforce billing run on or after its Next Billing Date) and posts the invoice." },
  { id: "settled", label: "Post, bill and settle", detail: "Also creates and applies a payment for the resulting invoice balance (asks for confirmation first)." },
];
/** Debit memos are billed only through the standard billing cycle. */
const STANDARD_BILLING = { label: "Standard billing cycle", detail: "Posted, then waits for its Next Billing Date. A Salesforce invoice batch run (an org Invoice Scheduler, or \"Run Eligible Billing Now\") turns its lines into invoice lines." };
const STEP_ICON: Record<string, string> = { done: "✓", failed: "✗", current: "→", processing: "⏳", pending: "○", skipped: "–", waiting: "⏸" };

/**
 * Drives the Salesforce lifecycle of one debit memo, one verified step per server call, until the target is reached, a step
 * fails, or the next step needs the user's confirmation (payment). Every state shown is derived from Salesforce records.
 */
function LifecyclePanel({ isDark, id, initialTarget, autoRun, onOpenInvoice }: { isDark: boolean; id: string; initialTarget: LifecycleTarget; autoRun: boolean; onOpenInvoice: (invoiceId: string) => void }) {
  const t = tokens(isDark);
  const [target, setTarget] = useState<LifecycleTarget>(initialTarget);
  const url = `/api/billing/debit-memos/${id}/lifecycle?target=${target}`;
  const loaded = useBillingData<LifecycleState>("Read debit memo lifecycle", url);
  const [override, setOverride] = useState<LifecycleState | null>(null);
  const state = override && override.target === target ? override : loaded.data;
  const [running, setRunning] = useState(false);
  const [askPayment, setAskPayment] = useState(false);
  const [askBilling, setAskBilling] = useState(false);
  const [paymentKey] = useState(() => newKey());
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [started, setStarted] = useState(false);
  const notifier = useNotify();

  async function run(confirm: null | "payment" | "billing" = null, initial: LifecycleState | null = null) {
    setRunning(true); setError(null); setAskPayment(false); setAskBilling(false);
    try {
      let st: LifecycleState | null = initial ?? state ?? null;
      const wasComplete = !!st?.complete;
      for (let i = 0; i < 160; i++) {
        if (st && (st.complete || st.failure)) break;
        const confirmed = i === 0 && ((confirm === "payment" && st?.next?.action === "create-payment") || (confirm === "billing" && st?.next?.action === "run-billing"));
        if (st?.next?.needsConfirmation && !confirmed) { if (st.next.action === "run-billing") setAskBilling(true); else setAskPayment(true); break; }
        // Waiting for the billing cycle (no next action) is a resting state — the user comes back later; nothing is generated early.
        if (st && !st.next) break;
        if (st?.next?.action === "wait") { await new Promise(r => setTimeout(r, 5000)); st = await quoteApiGet<LifecycleState>("Read lifecycle", url); setOverride(st); continue; }
        st = await quoteApiPost<LifecycleState>("Advance lifecycle", `/api/billing/debit-memos/${id}/lifecycle`, {
          target, paymentKey,
          confirmPayment: confirmed && confirm === "payment", confirmBilling: confirmed && confirm === "billing", previewToken: confirmed && confirm === "billing" ? st?.billing.preview?.token ?? null : null,
        });
        setOverride(st);
        confirm = null;
      }
      // Announce only a lifecycle step Salesforce verified as complete — resting / waiting states stay silent.
      if (st?.complete && !wasComplete) notifier.success("Debit Memo Lifecycle Complete", `Reached "${TARGETS.find(x => x.id === target)?.label ?? target}" — verified in Salesforce.`, { module: "Debit Memos", records: [{ objectApiName: "DebitMemo", recordId: st.summary.debitMemo.id, recordName: st.summary.debitMemo.number ?? st.summary.debitMemo.id, salesforceUrl: "" }] });
    } catch (err) { setError(toBillingErrorPanel(err, "The lifecycle step failed")); } finally { setRunning(false); }
  }

  // Retry from the failed step: re-read the lifecycle from Salesforce (the existing debit memo, invoice and payments are found again,
  // so nothing is regenerated or duplicated), then resume from its next step — the server re-evaluates tax before posting.
  async function retry() {
    setOverride(null); setError(null);
    try {
      const fresh = await quoteApiGet<LifecycleState>("Read lifecycle", url);
      setOverride(fresh);
      if (!fresh.complete && !fresh.failure && fresh.next && !fresh.next.needsConfirmation && fresh.next.action !== "wait") await run(null, fresh);
    } catch (err) { setError(toBillingErrorPanel(err, "The lifecycle couldn't be re-read")); }
  }

  // Auto-start once (after the debit memo was created with a lifecycle target) — scheduled, not run during render.
  const canAutoStart = autoRun && !started && !!state && !running && !state.complete && !state.failure && !!state.next && !state.next.needsConfirmation;
  useEffect(() => {
    if (!canAutoStart) return;
    const h = setTimeout(() => { setStarted(true); void run(); }, 0);
    return () => clearTimeout(h);
    // run() reads the latest state when it fires; canAutoStart gates it to a single start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoStart]);

  if (!state) return loaded.error ? <ErrorPanel isDark={isDark} error={loaded.error} /> : <LoadingRow isDark={isDark} label="Reading the lifecycle from Salesforce…" />;
  const sm = state.summary;
  const cur = sm.currency;
  const endStatus = state.complete ? (target === "settled" ? "SUCCESS" : `REACHED "${TARGETS.find(x => x.id === target)?.label}"`) : state.failure ? "STOPPED" : running ? "IN PROGRESS" : "NOT COMPLETE";
  return (
    <Panel isDark={isDark} title="Billing Lifecycle (verified in Salesforce)" icon="activity" right={
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select value={target} disabled={running} onChange={e => { setTarget(e.target.value as LifecycleTarget); setOverride(null); setStarted(true); }} style={{ ...inputStyle(t), fontSize: 12, padding: "4px 8px", width: "auto" }}>
          {TARGETS.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <GhostButton label="Refresh" icon="refresh" isDark={isDark} disabled={running} onClick={() => { setOverride(null); loaded.reload(); }} />
      </div>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {state.steps.map((st, i) => {
          const c = st.state === "done" ? "#00C875" : st.state === "failed" ? t.error : st.state === "current" || st.state === "processing" ? t.accent : t.dim;
          return (
            <div key={st.id} style={{ display: "grid", gridTemplateColumns: "26px 220px 1fr", gap: 8, alignItems: "baseline", fontSize: 12.5, opacity: st.state === "skipped" ? 0.5 : 1 }}>
              <span style={{ color: c, fontWeight: 800 }}>{STEP_ICON[st.state]}</span>
              <span style={{ color: st.state === "failed" ? t.error : t.heading, fontWeight: 700 }}>{i + 1}. {st.label}</span>
              <span style={{ color: st.state === "failed" ? t.error : t.dim }}>{st.state === "failed" ? `Reason: ${st.detail}` : st.detail}</span>
            </div>
          );
        })}
      </div>
      {state.tax && (
        <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 10, border: `1px solid ${state.tax.postable ? "rgba(0,200,117,0.4)" : t.error + "55"}`, background: state.tax.postable ? "rgba(0,200,117,0.06)" : `${t.error}0d`, fontSize: 12.5, color: t.body, display: "grid", gap: 4 }}>
          <div><strong style={{ color: state.tax.postable ? "#00C875" : t.error }}>Tax check: {state.tax.label}</strong>{state.tax.postable ? " — the invoice can be posted." : " — posting blocked."}</div>
          <div style={{ color: t.dim }}>{state.tax.message}</div>
          {state.tax.lines.length > 0 && <div style={{ color: t.dim }}>{state.tax.lines.map(l => `${l.verdict.replace(/_/g, " ").toLowerCase()}: ${l.reason}`).join(" · ")}</div>}
        </div>
      )}
      {!state.complete && !state.failure && !state.next && <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 10, border: `1px solid ${t.warn}55`, background: `${t.warn}10`, fontSize: 12.5, color: t.body }}><strong>Status: {sm.billingStatus}.</strong> {state.message} Come back later — the lifecycle resumes from Salesforce&apos;s records.</div>}
      {["invoiced", "settled"].includes(target) && (
        <div style={{ marginTop: 10, fontSize: 12, color: t.dim, display: "grid", gap: 3 }}>
          <div><b style={{ color: t.heading }}>Billing eligibility:</b> {state.billing.eligibility.map(e => `${e.ok ? "✓" : "✗"} ${e.label} (${e.detail})`).join(" · ")}</div>
          <div><b style={{ color: t.heading }}>Salesforce billing process:</b> {state.billing.schedulers.length ? state.billing.schedulers.map(x => `Invoice Scheduler "${x.name}" (${x.cadence ?? "?"}, next run ${x.nextRunTime ?? "—"})`).join(", ") : "no active Invoice Scheduler in this org"}{state.billing.runNow.available ? " · Run Eligible Billing Now available (Invoice Scheduler API)" : state.billing.runNow.reason ? ` · ${state.billing.runNow.reason}` : ""}</div>
          <div><b style={{ color: t.heading }}>Billing Schedule (matching invoice):</b> {state.billing.dueSchedules.length ? state.billing.dueSchedules.map(b => `${b.number} (next billing ${b.nextBillingDate})`).join(", ") : sm.invoice ? "billed" : "none due for this account"}</div>
          {state.billing.errorLog && <div><b style={{ color: t.heading }}>Revenue Transaction Error Log:</b> {state.billing.errorLog.number} · {state.billing.errorLog.code} — {state.billing.errorLog.message}</div>}
          {state.billing.runs.map(r => (
            <div key={r.schedulerId} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 4, padding: 8, borderRadius: 8, border: `1px solid ${t.border}`, marginTop: 4 }}>
              <span><b style={{ color: t.heading }}>Scheduler ID:</b> {r.schedulerId} ({r.schedulerStatus}{r.startImmediately ? ", start run now" : ""})</span>
              <span><b style={{ color: t.heading }}>Invoice Batch Run ID:</b> {r.runId ? `${r.runNumber} (${r.runId})` : r.phase === "draft" ? "none — scheduler is Draft (Salesforce only runs Active schedulers)" : "not created yet"}</span>
              <span><b style={{ color: t.heading }}>Run State:</b> {(r.phase === "completed" ? (r.invoicesGenerated ? "Completed" : "Completed — 0 invoices (not a success)") : r.phase === "failed" ? "Failed" : r.phase === "processing" ? "Processing" : r.phase === "waiting-to-start" ? "Waiting for Salesforce to start" : "Not started — scheduler is " + r.schedulerStatus)}{r.runStatus ? ` (Salesforce: ${r.runStatus})` : ""}</span>
              <span><b style={{ color: t.heading }}>Processing Status:</b> {r.statusSubtype ?? "—"}</span>
              <span><b style={{ color: t.heading }}>Eligible Billing Schedules:</b> {r.billingSchedulesFiltered ?? "—"}</span>
              <span><b style={{ color: t.heading }}>Eligible Debit Memos:</b> {state.billing.preview ? state.billing.preview.items.filter(x => x.kind === "Debit Memo").length : "see preview"}</span>
              <span><b style={{ color: t.heading }}>Invoices:</b> {r.invoicesGenerated ?? "—"}{r.invoicesFailed ? ` (${r.invoicesFailed} failed)` : ""}</span>
              <span><b style={{ color: t.heading }}>Target / Invoice date:</b> {r.targetDate ?? "—"} / {r.invoiceDate ?? "—"} · {r.expectedInvoiceStatus ?? "—"} invoices</span>
              {r.batchJob && <span><b style={{ color: t.heading }}>Batch job:</b> {r.batchJob.id} · {r.batchJob.status ?? "—"}</span>}
            </div>
          ))}
        </div>
      )}
      {error && <div style={{ marginTop: 10 }}><ErrorPanel isDark={isDark} error={error} /></div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
        {running && <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, color: t.accent }}><Spinner isDark={isDark} size={12} /> {state.next?.label ?? "Working with Salesforce…"}</span>}
        {!running && !state.complete && !state.failure && state.next && !state.next.needsConfirmation && <PrimaryButton label="Run lifecycle" icon="zap" isDark={isDark} onClick={() => void run()} />}
        {!running && state.next?.needsConfirmation && state.next.action === "create-payment" && <PrimaryButton label="Review payment" icon="credit-card" isDark={isDark} onClick={() => setAskPayment(true)} />}
        {!running && state.next?.action === "run-billing" && <PrimaryButton label="Run Eligible Billing Now" icon="zap" isDark={isDark} onClick={() => setAskBilling(true)} />}
        {state.failure && !running && <GhostButton label="Retry from this step" icon="refresh" isDark={isDark} onClick={() => void retry()} />}
      </div>
      <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: `1px solid ${state.complete ? "rgba(0,200,117,0.4)" : state.failure ? t.error + "55" : t.border}`, background: t.surface }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 6 }}>
          <Row isDark={isDark} label="Debit Memo">{sm.debitMemo.number}</Row>
          <Row isDark={isDark} label="Debit Amount">{money(sm.debitMemo.amount, cur ?? "₹")}</Row>
          <Row isDark={isDark} label="Debit Memo Status">{sm.debitMemo.status}</Row>
          <Row isDark={isDark} label="Next Billing Date">{sm.debitMemo.nextBillingDate ?? "—"}</Row>
          <Row isDark={isDark} label="Billing Mode">{STANDARD_BILLING.label}</Row>
          <Row isDark={isDark} label="Billing Status">{sm.billingStatus}</Row>
          <Row isDark={isDark} label="Invoice">{sm.invoice ? <button type="button" onClick={() => onOpenInvoice(sm.invoice!.id)} style={{ background: "none", border: "none", padding: 0, color: t.accent, fontWeight: 700, cursor: "pointer" }}>{sm.invoice.number} ({sm.invoice.status})</button> : "—"}</Row>
          <Row isDark={isDark} label="Debit Charge on Invoice">{sm.invoice ? money(sm.invoice.debitReflected, cur) : "—"}</Row>
          <Row isDark={isDark} label="Invoice Status">{sm.invoice?.status ?? "—"}</Row>
          <Row isDark={isDark} label="Payment">{sm.payment?.number ?? "—"}</Row>
          <Row isDark={isDark} label="Payment Created">{sm.payment ? "Yes" : "No"}</Row>
          <Row isDark={isDark} label="Amount Applied">{sm.payment ? money(sm.payment.applied, cur) : "—"}</Row>
          <Row isDark={isDark} label="Remaining Balance">{sm.invoice ? money(sm.invoice.balance, cur) : "—"}</Row>
          <Row isDark={isDark} label="Settlement Status">{sm.invoice?.settlementStatus ?? "—"}</Row>
          <Row isDark={isDark} label="End-to-End Status"><span style={{ color: state.complete ? "#00C875" : state.failure ? t.error : t.warn, fontWeight: 800 }}>{endStatus}</span></Row>
        </div>
      </div>
      <AnimatePresence>
        {askBilling && state.next?.action === "run-billing" && state.billing.preview && (
          <Modal isDark={isDark} title="Run eligible billing now — Salesforce invoice batch run" tone="warn" actions={<>
            <GhostButton label="Cancel" isDark={isDark} onClick={() => setAskBilling(false)} />
            <PrimaryButton label="Start Salesforce billing run" icon="zap" isDark={isDark} disabled={running} onClick={() => void run("billing")} />
          </>}>
            <div style={{ fontSize: 12.5, color: t.body }}>Creates a one-time Salesforce Invoice Scheduler for <b>{sm.account?.name}</b>, target date <b>{state.billing.preview.targetDate}</b>, that starts immediately. Salesforce bills <b>everything eligible</b> for this account up to that date — the run can&apos;t be limited to one debit memo:</div>
            <div style={{ maxHeight: 240, overflowY: "auto", fontSize: 12, border: `1px solid ${t.border}`, borderRadius: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>{state.billing.preview.items.map(x => (
                <tr key={x.id} style={{ borderBottom: `1px solid ${t.border}`, fontWeight: x.isThisMemo ? 800 : 400 }}>
                  <td style={{ padding: "4px 6px" }}>{x.kind}</td><td style={{ padding: "4px 6px" }}>{x.number}{x.isThisMemo ? " (this debit memo)" : ""}</td><td style={{ padding: "4px 6px" }}>{x.account}</td><td style={{ padding: "4px 6px" }}>{money(x.amount, cur)}</td><td style={{ padding: "4px 6px" }}>next billing {x.nextBillingDate ?? "—"}</td><td style={{ padding: "4px 6px", color: x.certainty === "included" ? t.heading : t.dim }}>{x.certainty}</td>
                </tr>))}</tbody></table>
            </div>
            <div style={{ fontSize: 12, color: t.warn, fontWeight: 600 }}>Invoices for all included items are created in Salesforce (as Draft). This can&apos;t be undone from here.</div>
          </Modal>
        )}
        {askPayment && state.next?.action === "create-payment" && sm.invoice && (
          <Modal isDark={isDark} title="Confirm payment" tone="accent" actions={<>
            <GhostButton label="Cancel" isDark={isDark} onClick={() => setAskPayment(false)} />
            <PrimaryButton label="Create & apply payment" icon="check" isDark={isDark} disabled={running} onClick={() => void run("payment")} />
          </>}>
            <Row isDark={isDark} label="Invoice">{sm.invoice.number} · {sm.invoice.status}</Row>
            <Row isDark={isDark} label="Account">{sm.account?.name}</Row>
            <Row isDark={isDark} label="Payment amount">{money(sm.invoice.balance, cur)} (the invoice&apos;s current balance in Salesforce)</Row>
            <Row isDark={isDark} label="Applied to">The invoice&apos;s lines, through Salesforce&apos;s applyPayment</Row>
            <div style={{ fontSize: 12, color: t.warn, fontWeight: 600 }}>This records a real Salesforce Payment. It can&apos;t be deleted afterwards (only canceled). Your payment permissions are checked before anything is created.</div>
          </Modal>
        )}
      </AnimatePresence>
    </Panel>
  );
}

export type DebitMemosView = { mode: "dashboard" } | { mode: "detail"; id: string };

interface Nav { onNavigate: (view: DebitMemosView) => void; onOpenInvoice: (invoiceId: string) => void }

type Ref = { id: string; name: string };
interface UiLine { key: string; description: string; product: Ref | null; productName: string | null; quantity: string; unitPrice: string; invoiceLineId: string }
interface UiDraft { account: Ref | null; accountName: string | null; invoice: { id: string; number: string | null } | null; invoiceNumber: string | null; currency: string | null; reason: string; billOnNextRun: boolean; nextBillingDate: string; lines: UiLine[] }
type Created = { message: string; duplicate: boolean; debitMemo: DebitMemoRecord; lines: DebitMemoLineRecord[] };
type ListResponse = { available: boolean; reason: string | null; debitMemos: DebitMemoRecord[]; totalSize: number; byStatus: { status: string; count: number; amount: number | null }[]; statusValues: string[]; currency: { symbol: string | null; code: string | null } };

const EMPTY: UiDraft = { account: null, accountName: null, invoice: null, invoiceNumber: null, currency: null, reason: "", billOnNextRun: false, nextBillingDate: "", lines: [] };
let seq = 0;
const lineKey = () => `l${++seq}`;
const blankLine = (): UiLine => ({ key: lineKey(), description: "", product: null, productName: null, quantity: "1", unitPrice: "", invoiceLineId: "" });
const money = (n: number | null | undefined, cur?: string | null) => (n === null || n === undefined ? "—" : `${cur && cur.length === 1 ? cur : cur ? `${cur} ` : ""}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
const lineAmount = (l: UiLine) => { const q = Number(l.quantity), p = Number(l.unitPrice); return l.quantity.trim() && l.unitPrice.trim() && Number.isFinite(q) && Number.isFinite(p) ? Math.round(q * p * 100) / 100 : null; };

/** Server draft from the UI state — names/numbers plus Ids the user picked in Salesforce-backed lookups; re-validated server-side. */
const toServerDraft = (d: UiDraft) => ({
  accountId: d.account?.id ?? null, accountName: d.account ? null : d.accountName,
  invoiceId: d.invoice?.id ?? null, invoiceNumber: d.invoice ? null : d.invoiceNumber,
  currency: d.currency, reason: d.reason || null, billOnNextRun: d.billOnNextRun, nextBillingDate: d.nextBillingDate || null,
  lines: d.lines.map(l => ({ description: l.description || null, productId: l.product?.id ?? null, productName: l.product ? null : l.productName, quantity: l.quantity, unitPrice: l.unitPrice, invoiceLineId: l.invoiceLineId || null })),
});

/** Rebuild the editable draft from a server resolution (resolved records become picked Ids). */
function fromResolution(r: DebitResolution, prev: UiDraft): UiDraft {
  return {
    account: r.account, accountName: r.account ? null : prev.accountName,
    invoice: r.invoice ? { id: r.invoice.id, number: r.invoice.number } : null, invoiceNumber: r.invoice ? null : prev.invoiceNumber,
    currency: r.currency.supplied, reason: r.reason ?? prev.reason, billOnNextRun: r.billOnNextRun, nextBillingDate: r.nextBillingDate ?? prev.nextBillingDate,
    lines: r.lines.map(l => ({ key: lineKey(), description: l.description, product: l.product ? { id: l.product.id, name: l.product.name } : null, productName: l.product ? null : l.productQuery, quantity: l.quantity === null ? "" : String(l.quantity), unitPrice: l.unitPrice === null ? "" : String(l.unitPrice), invoiceLineId: l.invoiceLine?.id ?? "" })),
  };
}

function ResultCard({ isDark, data, nav, title }: { isDark: boolean; data: { debitMemo: DebitMemoRecord; lines: DebitMemoLineRecord[] }; nav: Nav; title?: string }) {
  const t = tokens(isDark);
  const dm = data.debitMemo;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {title && (
        <div style={{ borderRadius: 16, padding: 16, border: "1px solid rgba(0,200,117,0.35)", background: "rgba(0,200,117,0.06)" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>{title}</div>
          <div style={{ fontSize: 12, color: t.dim }}>Read back from Salesforce after creation.</div>
        </div>
      )}
      <Panel isDark={isDark} title={`Debit Memo ${dm.number ?? ""}`} icon="file-text" right={<StatusPill status={dm.status} isDark={isDark} />}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 8 }}>
          <Row isDark={isDark} label="Debit Memo Number">{dm.number}</Row>
          <Row isDark={isDark} label="Account">{dm.account?.name ?? "—"}</Row>
          <Row isDark={isDark} label="Referenced Invoice">{dm.invoice ? <button type="button" onClick={() => nav.onOpenInvoice(dm.invoice!.id)} style={{ background: "none", border: "none", padding: 0, color: t.accent, fontWeight: 700, cursor: "pointer" }}>{dm.invoice.number}</button> : "—"}</Row>
          <Row isDark={isDark} label="Amount">{money(dm.totalCharge, dm.currency)}</Row>
          <Row isDark={isDark} label="Currency">{dm.currency ?? "—"}</Row>
          <Row isDark={isDark} label="Reason">{dm.reason ?? "—"}</Row>
          <Row isDark={isDark} label="Status">{dm.status} · invoice generation: {dm.invoiceGenerationStatus ?? "—"}</Row>
          {dm.nextBillingDate && <Row isDark={isDark} label="Next Billing Date">{dm.nextBillingDate}</Row>}
          <Row isDark={isDark} label="Salesforce ID"><code style={{ fontWeight: 500 }}>{dm.id}</code></Row>
        </div>
        <div style={{ marginTop: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr>{["Line", "Product", "Description", "Amount", "Invoice Line"].map(h => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: t.dim, fontSize: 10.5, textTransform: "uppercase", borderBottom: `1px solid ${t.border}` }}>{h}</th>)}</tr></thead>
            <tbody>{data.lines.map(l => <tr key={l.id} style={{ borderBottom: `1px solid ${t.border}` }}><td style={{ padding: "6px 8px", fontWeight: 700 }}>{l.name}</td><td style={{ padding: "6px 8px" }}>{l.product?.name ?? "—"}</td><td style={{ padding: "6px 8px" }}>{l.description ?? "—"}</td><td style={{ padding: "6px 8px" }}>{money(l.amount, dm.currency)}</td><td style={{ padding: "6px 8px" }}>{l.invoiceLine?.name ?? "—"}</td></tr>)}</tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          <GhostButton label="Open in Salesforce" icon="external-link" isDark={isDark} onClick={() => window.open(dm.salesforceUrl, "_blank", "noopener")} />
        </div>
      </Panel>
    </div>
  );
}

function Dashboard({ isDark, nav }: { isDark: boolean; nav: Nav }) {
  const t = tokens(isDark);
  const notify = useSalesforceSuccess();
  const model = useBillingData<DebitMemoModel>("Discover debit memos", "/api/billing/debit-memos/model");
  const list = useBillingData<ListResponse>("Load debit memos", "/api/billing/debit-memos?pageSize=10");
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState<UiDraft>(EMPTY);
  const [interpretation, setInterpretation] = useState<DebitInterpretation | { success: false; requiresInput: boolean; missingFields: string[]; message: string } | null>(null);
  const [resolution, setResolution] = useState<DebitResolution | null>(null);
  const [preview, setPreview] = useState<{ res: DebitResolution; key: string } | null>(null);
  const [busy, setBusy] = useState<null | "interpret" | "validate" | "create">(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [pickInvoice, setPickInvoice] = useState(false);
  const [showTech, setShowTech] = useState(false);
  const [target, setTarget] = useState<LifecycleTarget>("draft");
  // The selected invoice's lines (from the last Salesforce resolution) — kept while the user edits the draft.
  const [invLines, setInvLines] = useState<{ invoiceId: string; lines: NonNullable<DebitResolution["invoice"]>["lines"] } | null>(null);
  const m = model.data;
  const cur = m?.currency.symbol ?? m?.currency.code ?? null;
  const editing = draft.lines.length > 0 || !!draft.account || !!draft.accountName || !!resolution;

  const reset = () => { setTarget("draft"); setInvLines(null); setPrompt(""); setDraft(EMPTY); setInterpretation(null); setResolution(null); setPreview(null); setError(null); setCreated(null); setPickInvoice(false); };
  const edit = (patch: Partial<UiDraft>) => { setDraft(d => ({ ...d, ...patch })); setResolution(null); };
  const editLine = (key: string, patch: Partial<UiLine>) => { setDraft(d => ({ ...d, lines: d.lines.map(l => (l.key === key ? { ...l, ...patch } : l)) })); setResolution(null); };

  async function interpret() {
    if (!prompt.trim()) return;
    setBusy("interpret"); setError(null); setCreated(null); setPreview(null);
    try {
      const r = await quoteApiPost<DebitInterpretation | { success: false; requiresInput: boolean; missingFields: string[]; message: string }>("Interpret debit memo", "/api/billing/debit-memos/interpret", { prompt });
      setInterpretation(r);
      if (r.success) setTarget(r.extraction.lifecycle);
      if (r.success) { setDraft(d => fromResolution(r, { ...EMPTY, accountName: r.extraction.accountName, invoiceNumber: r.extraction.invoiceNumber, reason: r.extraction.reason ?? "", currency: r.extraction.currency, nextBillingDate: r.extraction.nextBillingDate ?? "", lines: d.lines })); setResolution(r); if (r.invoice) setInvLines({ invoiceId: r.invoice.id, lines: r.invoice.lines }); }
    } catch (err) {
      const panel = toBillingErrorPanel(err, "Couldn't interpret the request");
      const raw = panel.raw as { requiresInput?: boolean; message?: string; missingFields?: string[] } | undefined;
      if (raw?.requiresInput) setInterpretation({ success: false, requiresInput: true, missingFields: raw.missingFields ?? [], message: raw.message ?? "More information is needed." });
      else setError(panel);
    } finally { setBusy(null); }
  }

  async function review() {
    setBusy("validate"); setError(null);
    try {
      const r = await quoteApiPost<DebitResolution>("Validate debit memo", "/api/billing/debit-memos/validate", { draft: toServerDraft(draft) });
      setResolution(r);
      if (r.invoice) setInvLines({ invoiceId: r.invoice.id, lines: r.invoice.lines });
      if (r.valid) setPreview({ res: r, key: newKey() }); // one request key per reviewed debit memo — a second click reuses it
    } catch (err) { setError(toBillingErrorPanel(err, "Couldn't validate the debit memo")); } finally { setBusy(null); }
  }

  async function create() {
    if (!preview) return;
    setBusy("create"); setError(null);
    try {
      const r = await quoteApiPost<Created & { success: true }>("Create debit memo", "/api/billing/debit-memos", { draft: toServerDraft(draft), idempotencyKey: preview.key });
      setCreated(r); setPreview(null); list.reload();
      notify({ title: "Debit Memo Created", message: `${r.debitMemo.number} · ${money(r.debitMemo.totalCharge, r.debitMemo.currency)}`, records: [{ objectApiName: "DebitMemo", recordId: r.debitMemo.id, recordName: r.debitMemo.number ?? r.debitMemo.id, salesforceUrl: r.debitMemo.salesforceUrl }] });
    } catch (err) {
      const panel = toBillingErrorPanel(err, "The Debit Memo could not be created");
      setError(panel);
      const raw = panel.raw as { resolution?: DebitResolution } | undefined;
      if (raw?.resolution) setResolution(raw.resolution);
      setPreview(null);
    } finally { setBusy(null); }
  }

  const issues = resolution?.issues ?? [];
  const lineIssue = (i: number) => issues.filter(x => x.field.startsWith(`lines.${i}.`) && x.severity === "error").map(x => x.message);
  const invoiceLines = resolution?.invoice?.lines ?? (invLines && invLines.invoiceId === draft.invoice?.id ? invLines.lines : []);
  const uiTotal = Math.round(draft.lines.reduce((s, l) => s + (lineAmount(l) ?? 0), 0) * 100) / 100;

  return (
    <PageShell footer={
      <FooterBar isDark={isDark}>
        <GhostButton label="Clear" icon="x" isDark={isDark} disabled={!!busy} onClick={reset} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {busy && <Spinner isDark={isDark} size={13} />}
          <PrimaryButton label={busy === "validate" ? "Validating…" : "Review Debit Memo"} icon="check-circle" isDark={isDark} disabled={!m?.available || !!busy || !editing} onClick={review} />
        </div>
      </FooterBar>}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Debit Memos</div>
          <div style={{ fontSize: 11.5, color: t.dim }}>A debit memo charges a customer an additional amount (a missed service, extra units, a late fee). Salesforce bills it on an invoice in a later invoice run. Describe the charge — the AI interprets it, every record is resolved in Salesforce, and you review before anything is created.</div>
        </div>
        {model.error && <ErrorPanel isDark={isDark} error={model.error} />}
        {m && !m.available && <div role="alert" style={{ fontSize: 12.5, color: t.warn, fontWeight: 600, padding: "10px 12px", borderRadius: 10, border: `1px solid ${t.warn}55`, background: `${t.warn}0c` }}>⚠ {m.reason}</div>}
        {list.data && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <StatTile isDark={isDark} label="Total Debit Memos" value={String(list.data.totalSize)} />
            {list.data.statusValues.map(s => <StatTile key={s} isDark={isDark} label={s} value={String(list.data!.byStatus.find(b => b.status === s)?.count ?? 0)} color={/posted/i.test(s) ? "#00C875" : /draft|pending/i.test(s) ? t.warn : /cancel|void|error/i.test(s) ? t.error : t.accent} />)}
            <StatTile isDark={isDark} label="Total Debit Amount" value={money(list.data.byStatus.filter(b => !/cancel|void/i.test(b.status)).reduce((s, b) => s + (b.amount ?? 0), 0), cur)} />
          </div>
        )}

        {/* Prompt */}
        <div style={{ borderRadius: 16, padding: 16, border: `1px solid ${t.accent}45`, background: isDark ? "linear-gradient(135deg, rgba(0,212,255,0.08), rgba(30,144,255,0.04))" : "linear-gradient(135deg, rgba(0,152,204,0.07), rgba(9,104,211,0.03))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 800, color: t.heading }}><span style={{ color: t.accent, display: "inline-flex" }}><Ic n="sparkles" s={15} /></span> Describe the debit memo</div>
          <div style={{ fontSize: 12, color: t.dim, margin: "4px 0 10px" }}>The AI only interprets your request. Accounts, invoices and products are looked up in Salesforce — nothing is created until you review and confirm.{m ? ` This org bills in ${m.currency.code ?? m.currency.symbol ?? "its configured currency"}.` : ""}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void interpret(); }} rows={3}
              placeholder='e.g. "Create a debit memo for Any Partner Inc for ₹10,000 consisting of ₹6,000 installation and ₹4,000 premium support."' style={{ ...inputStyle(t), flex: "1 1 420px", resize: "vertical", fontSize: 13.5 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <PrimaryButton label={busy === "interpret" ? "Interpreting…" : "Create Debit Memo"} icon="sparkles" isDark={isDark} disabled={!prompt.trim() || !!busy || !m?.available} onClick={interpret} />
              <GhostButton label="Enter manually" icon="edit" isDark={isDark} disabled={!!busy} onClick={() => { setDraft(d => (d.lines.length ? d : { ...d, lines: [blankLine()] })); setCreated(null); }} />
            </div>
          </div>
          {busy === "interpret" && <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={13} /> Interpreting the request and resolving account, invoice and products in Salesforce…</div>}
          {interpretation && !interpretation.success && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: t.warn, fontWeight: 600 }}>⚠ {interpretation.message}{interpretation.missingFields.length ? ` Missing: ${interpretation.missingFields.join(", ")}.` : ""}</div>
          )}
          {interpretation?.success && (
            <div style={{ marginTop: 10, fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>
              <Disclosure isDark={isDark} label={DISCLOSURE_LABELS.ai} icon="cpu"><span style={{ color: t.body }}>AI interpretation: {[interpretation.extraction.accountName && `account "${interpretation.extraction.accountName}"`, interpretation.extraction.invoiceNumber && `invoice ${interpretation.extraction.invoiceNumber}`, interpretation.extraction.totalAmount !== null && `total ${interpretation.extraction.totalAmount}`, `${interpretation.extraction.lines.length} line(s)`, interpretation.extraction.currency && `currency ${interpretation.extraction.currency}`].filter(Boolean).join(" · ")}</span></Disclosure>
              {interpretation.requiresInput && <span style={{ color: t.warn, fontWeight: 700 }}>⚠ {interpretation.message}</span>}
              <WarningsDisclosure isDark={isDark} warnings={interpretation.warnings} />
            </div>
          )}
          <div style={{ marginTop: 10 }}><PromptGuide isDark={isDark} config={billingPromptGuides.debitMemo} onUseExample={setPrompt} /></div>
        </div>

        {error && <ErrorPanel isDark={isDark} error={error} />}
        {created && <ResultCard isDark={isDark} data={created} nav={nav} title={created.duplicate ? "✓ Debit Memo already created for this request" : "✓ Debit Memo Created Successfully"} />}
        {created && <LifecyclePanel isDark={isDark} id={created.debitMemo.id} initialTarget={target} autoRun={target !== "draft"} onOpenInvoice={nav.onOpenInvoice} />}

        {/* Editable preview / manual entry */}
        {editing && !created && m && (
          <Panel isDark={isDark} title="Debit Memo" icon="file-text" right={resolution ? <span style={{ fontSize: 11.5, fontWeight: 700, color: resolution.valid ? "#00C875" : t.warn }}>{resolution.valid ? "✓ Validated in Salesforce" : resolution.requiresInput ? "More information needed" : "Fix the issues below"}</span> : <span style={{ fontSize: 11.5, color: t.dim }}>Not validated yet</span>}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
              <Field t={t} label="Account *">
                <ReferenceLookup isDark={isDark} objectType="Account" searchEndpoint={BILLING_SEARCH_ENDPOINT} value={draft.account} onChange={v => edit({ account: v, accountName: null })} placeholder={draft.accountName ? `"${draft.accountName}" — choose the account…` : "Search accounts…"} noMatchHint="No matching Account in Salesforce." />
                {!!resolution?.accountCandidates.length && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>{resolution.accountCandidates.map(a => <button key={a.id} type="button" onClick={() => edit({ account: a, accountName: null })} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, border: `1px solid ${t.border}`, background: t.surfaceAlt, color: t.body, cursor: "pointer" }}>{a.name}</button>)}</div>}
              </Field>
              <Field t={t} label="Invoice (optional)">
                {draft.invoice || draft.invoiceNumber
                  ? <div style={{ display: "flex", gap: 6, alignItems: "center", paddingTop: 6 }}><strong style={{ color: t.heading }}>{draft.invoice?.number ?? draft.invoiceNumber}</strong><GhostButton label="Remove" icon="x" isDark={isDark} onClick={() => edit({ invoice: null, invoiceNumber: null, lines: draft.lines.map(l => ({ ...l, invoiceLineId: "" })) })} /></div>
                  : <GhostButton label={pickInvoice ? "Hide invoices" : "Choose a posted invoice"} icon="file-text" isDark={isDark} onClick={() => setPickInvoice(v => !v)} />}
              </Field>
              <Field t={t} label="Currency"><div style={{ fontSize: 13, color: t.heading, paddingTop: 8 }}>{m.currency.code ?? m.currency.symbol ?? "—"}{draft.currency && draft.currency !== m.currency.code && draft.currency !== m.currency.symbol ? <span style={{ color: t.warn }}> (requested: {draft.currency})</span> : null}</div></Field>
              <Field t={t} label="Next Billing Date (optional)"><input type="date" value={draft.nextBillingDate} onChange={e => edit({ nextBillingDate: e.target.value })} style={{ ...inputStyle(t), fontSize: 13 }} /><div style={{ fontSize: 11, color: t.dim, marginTop: 3 }}>Blank: the account&apos;s next billing date in Salesforce, else today. Salesforce validates it on posting.</div></Field>
              <div style={{ gridColumn: "1 / -1" }}><Field t={t} label="Reason"><input value={draft.reason} maxLength={200} onChange={e => edit({ reason: e.target.value })} placeholder="Why is the customer being charged more?" style={{ ...inputStyle(t), fontSize: 13 }} /></Field></div>
            </div>
            {pickInvoice && !draft.invoice && <div style={{ marginTop: 10 }}><InvoicePicker isDark={isDark} purpose="credit" onPick={inv => { edit({ invoice: { id: inv.id, number: inv.number }, invoiceNumber: null, account: draft.account ?? inv.account }); setPickInvoice(false); }} /></div>}

            <div style={{ marginTop: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead><tr>{["Description", "Product", "Qty", "Unit Price", "Amount", ...(draft.invoice || draft.invoiceNumber ? ["Invoice Line"] : []), ""].map(h => <th key={h || "x"} style={{ textAlign: "left", padding: "6px 6px", color: t.dim, fontSize: 10.5, textTransform: "uppercase", borderBottom: `1px solid ${t.border}` }}>{h}</th>)}</tr></thead>
                <tbody>{draft.lines.map((l, i) => (
                  <tr key={l.key} style={{ borderBottom: `1px solid ${t.border}`, verticalAlign: "top" }}>
                    <td style={{ padding: 6, minWidth: 160 }}><input value={l.description} onChange={e => editLine(l.key, { description: e.target.value })} style={{ ...inputStyle(t), fontSize: 12.5, padding: "5px 8px" }} />{lineIssue(i).map((x, j) => <div key={j} style={{ fontSize: 11, color: t.error, marginTop: 3 }}>✗ {x}</div>)}<div style={{ marginTop: 3 }}><ConfigNotesDisclosure isDark={isDark} notes={resolution?.lines[i]?.assumptions ?? []} /></div></td>
                    <td style={{ padding: 6, minWidth: 190 }}><ReferenceLookup isDark={isDark} objectType="Product2" searchEndpoint={BILLING_SEARCH_ENDPOINT} value={l.product} onChange={v => editLine(l.key, { product: v, productName: null })} placeholder={l.productName ? `"${l.productName}" — choose…` : "No product"} noMatchHint="No matching product." />
                      {!!resolution?.lines[i]?.productCandidates.length && <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>{resolution.lines[i].productCandidates.map(p => <button key={p.id} type="button" onClick={() => editLine(l.key, { product: { id: p.id, name: p.name }, productName: null })} style={{ fontSize: 10.5, padding: "1px 7px", borderRadius: 999, border: `1px solid ${t.border}`, background: t.surfaceAlt, color: t.body, cursor: "pointer" }}>{p.name}{p.code ? ` (${p.code})` : ""}</button>)}</div>}
                      {l.productName && !l.product && <button type="button" onClick={() => editLine(l.key, { productName: null })} style={{ fontSize: 10.5, background: "none", border: "none", color: t.dim, textDecoration: "underline", cursor: "pointer", padding: 0, marginTop: 3 }}>Bill without a product</button>}
                    </td>
                    <td style={{ padding: 6, width: 80 }}><input type="number" min="0" step="1" value={l.quantity} onChange={e => editLine(l.key, { quantity: e.target.value })} style={{ ...inputStyle(t), fontSize: 12.5, padding: "5px 8px" }} /></td>
                    <td style={{ padding: 6, width: 120 }}><input type="number" min="0" step="0.01" value={l.unitPrice} onChange={e => editLine(l.key, { unitPrice: e.target.value })} style={{ ...inputStyle(t), fontSize: 12.5, padding: "5px 8px" }} /></td>
                    <td style={{ padding: 6, width: 110, fontWeight: 700, color: t.heading, paddingTop: 12 }}>{money(lineAmount(l), cur)}</td>
                    {(draft.invoice || draft.invoiceNumber) && <td style={{ padding: 6, minWidth: 150 }}>
                      <select value={l.invoiceLineId} onChange={e => editLine(l.key, { invoiceLineId: e.target.value })} style={{ ...inputStyle(t), fontSize: 12.5, padding: "5px 8px" }}>
                        <option value="">{invoiceLines.length ? "Choose invoice line…" : "Review to load lines"}</option>
                        {invoiceLines.map(il => <option key={il.id} value={il.id}>{il.product ?? il.name}{il.amount !== null ? ` · ${money(il.amount, cur)}` : ""}</option>)}
                      </select>
                    </td>}
                    <td style={{ padding: 6, width: 40 }}><GhostButton label="" icon="trash" isDark={isDark} onClick={() => edit({ lines: draft.lines.filter(x => x.key !== l.key) })} /></td>
                  </tr>
                ))}</tbody>
              </table>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, flexWrap: "wrap", gap: 8 }}>
                <GhostButton label="Add line" icon="plus" isDark={isDark} disabled={draft.lines.length >= 25} onClick={() => edit({ lines: [...draft.lines, blankLine()] })} />
                <span style={{ fontSize: 13, fontWeight: 800, color: t.heading }}>Total Debit: {money(uiTotal, cur)}</span>
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 6 }}>After creating it</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 6 }}>
                  {TARGETS.map(x => (
                    <label key={x.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px", borderRadius: 10, border: `1px solid ${target === x.id ? t.accent : t.border}`, background: target === x.id ? `${t.accent}0c` : t.surface, cursor: "pointer", fontSize: 12 }}>
                      <input type="radio" name="dm-target" checked={target === x.id} onChange={() => setTarget(x.id)} style={{ marginTop: 2 }} />
                      <span><strong style={{ color: t.heading }}>{x.label}</strong><span style={{ display: "block", color: t.dim, fontSize: 11 }}>{x.detail}</span></span>
                    </label>
                  ))}
                </div>
                {["invoiced", "settled"].includes(target) && <div style={{ marginTop: 8, fontSize: 12, color: t.dim }}><strong style={{ color: t.heading }}>Billed in the {STANDARD_BILLING.label.toLowerCase()}.</strong> {STANDARD_BILLING.detail}</div>}
              </div>
            </div>
            {resolution && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                {resolution.requiresInput && <div style={{ fontSize: 12.5, color: t.warn, fontWeight: 700 }}>⚠ {resolution.message}</div>}
                {issues.filter(x => !x.field.startsWith("lines.")).map((x, i) => <div key={i} style={{ fontSize: 12.5, fontWeight: x.severity === "error" ? 600 : 400, color: x.severity === "error" ? t.error : t.dim }}>{x.severity === "error" ? "✗" : "ⓘ"} {x.message}</div>)}
              </div>
            )}
          </Panel>
        )}

        {/* Recent */}
        <Panel isDark={isDark} title="Recent Debit Memos" icon="list" right={<GhostButton label="Refresh" icon="refresh" isDark={isDark} onClick={list.reload} />}>
          {list.error && <ErrorPanel isDark={isDark} error={list.error} />}
          {!list.data && !list.error && <LoadingRow isDark={isDark} label="Loading debit memos from Salesforce…" />}
          {list.data && list.data.debitMemos.length === 0 && <div style={{ fontSize: 12.5, color: t.dim }}>No debit memos exist in Salesforce yet.</div>}
          {list.data && list.data.debitMemos.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>{["Debit Memo", "Account", "Amount", "Status", "Invoice Generation", "Reason", "Created", ""].map(h => <th key={h || "a"} style={{ textAlign: "left", padding: "6px 8px", color: t.dim, fontSize: 10.5, textTransform: "uppercase", borderBottom: `1px solid ${t.border}` }}>{h}</th>)}</tr></thead>
              <tbody>{list.data.debitMemos.map(d => <tr key={d.id} style={{ borderBottom: `1px solid ${t.border}` }}><td style={{ padding: "6px 8px", fontWeight: 700, color: t.heading }}>{d.number}</td><td style={{ padding: "6px 8px" }}>{d.account?.name ?? "—"}</td><td style={{ padding: "6px 8px" }}>{money(d.totalCharge, d.currency)}</td><td style={{ padding: "6px 8px" }}><StatusPill status={d.status} isDark={isDark} /></td><td style={{ padding: "6px 8px" }}>{d.invoiceGenerationStatus ?? "—"}</td><td style={{ padding: "6px 8px", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.reason ?? "—"}</td><td style={{ padding: "6px 8px" }}>{d.createdDate?.slice(0, 10) ?? "—"}</td><td style={{ padding: "6px 8px" }}><GhostButton label="View" icon="eye" isDark={isDark} onClick={() => nav.onNavigate({ mode: "detail", id: d.id })} /></td></tr>)}</tbody>
            </table>
          )}
        </Panel>
      </div>

      <AnimatePresence>
        {preview && (
          <Modal isDark={isDark} title="Debit Memo Preview" tone="accent" actions={<>
            <GhostButton label="Back" isDark={isDark} onClick={() => setPreview(null)} />
            <PrimaryButton label={busy === "create" ? "Creating…" : "Create Debit Memo"} icon="check" isDark={isDark} disabled={!!busy || !preview.res.valid} onClick={create} />
          </>}>
            <Row isDark={isDark} label="Account">{preview.res.account?.name}</Row>
            <Row isDark={isDark} label="Invoice">{preview.res.invoice?.number ?? "—"}</Row>
            <Row isDark={isDark} label="Reason">{preview.res.reason ?? "—"}</Row>
            {preview.res.lines.map(l => <Row key={l.index} isDark={isDark} label={`Line ${l.index + 1}`}>{l.description}{l.product ? ` [${l.product.name}]` : ""} · Qty {l.quantity} × {money(l.unitPrice, cur)} = {money(l.amount, cur)}{l.invoiceLine ? ` · invoice line ${l.invoiceLine.product ?? l.invoiceLine.name}` : ""}</Row>)}
            <Row isDark={isDark} label="Total Debit"><strong>{money(preview.res.computedTotal, cur)}</strong></Row>
            <Row isDark={isDark} label="Currency">{m?.currency.code ?? m?.currency.symbol ?? "—"}</Row>
            <Row isDark={isDark} label="Created as">{preview.res.createAs.status}</Row>
            <Row isDark={isDark} label="Then">{TARGETS.find(x => x.id === target)?.label} — {TARGETS.find(x => x.id === target)?.detail}</Row>
            {["invoiced", "settled"].includes(target) && <Row isDark={isDark} label="Billing">{STANDARD_BILLING.label} — {STANDARD_BILLING.detail}</Row>}
            <Row isDark={isDark} label="Next Billing Date">{preview.res.nextBillingDate ?? "Resolved from Salesforce before posting (account billing date, else today)"}</Row>
            {target !== "draft" && <div style={{ fontSize: 12, color: t.warn, fontWeight: 600 }}>Posting a debit memo{target !== "posted" ? " and generating/posting its invoice" : ""} can&apos;t be undone from here. Each step is performed through Salesforce and verified before the next one starts.</div>}
            <ConfigNotesDisclosure isDark={isDark} notes={preview.res.lines.flatMap(l => l.assumptions)} />
            <div>
              <button type="button" onClick={() => setShowTech(v => !v)} style={{ background: "none", border: "none", padding: 0, color: t.dim, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>{showTech ? "Hide Salesforce request" : "Show Salesforce request"}</button>
              {showTech && <div style={{ marginTop: 6 }}><CodeBlock open isDark={isDark} data={toServerDraft(draft)} /></div>}
            </div>
            <div style={{ fontSize: 11.5, color: t.dim }}>On confirm the server re-resolves and re-validates everything, then creates the debit memo and its lines in one all-or-nothing Salesforce request and reads them back.</div>
          </Modal>
        )}
      </AnimatePresence>
    </PageShell>
  );
}

function Detail({ isDark, nav, id }: { isDark: boolean; nav: Nav; id: string }) {
  const d = useBillingData<{ debitMemo: DebitMemoRecord; lines: DebitMemoLineRecord[] }>("Load debit memo", `/api/billing/debit-memos/${id}`);
  return (
    <PageShell footer={<FooterBar isDark={isDark}><GhostButton label="Back to Debit Memos" icon="arrow-left" isDark={isDark} onClick={() => nav.onNavigate({ mode: "dashboard" })} /><GhostButton label="Refresh" icon="refresh" isDark={isDark} onClick={d.reload} /></FooterBar>}>
      <div style={{ padding: 20 }}>
        {d.error && <ErrorPanel isDark={isDark} error={d.error} />}
        {!d.data && !d.error && <LoadingRow isDark={isDark} label="Loading the debit memo from Salesforce…" />}
        {d.data && <ResultCard isDark={isDark} data={d.data} nav={nav} />}
        {d.data && <div style={{ marginTop: 12 }}><LifecyclePanel isDark={isDark} id={id} initialTarget={/^posted$/i.test(d.data.debitMemo.status ?? "") ? "settled" : "draft"} autoRun={false} onOpenInvoice={nav.onOpenInvoice} /></div>}
      </div>
    </PageShell>
  );
}

/**
 * Revenue Cloud Billing — Debit Memos: natural-language prompt → AI interpretation → Salesforce record resolution →
 * validation → preview → DebitMemo + DebitMemoLine(s) created in one Salesforce request → verified result.
 * Server logic: lib/billing/server/debitMemos.ts (+ shared billingDocuments.ts).
 */
export default function BillingDebitMemosWorkspace({ isDark, view, ...nav }: { isDark: boolean; view: DebitMemosView } & Nav) {
  if (view.mode === "detail") return <Detail isDark={isDark} nav={nav} id={view.id} />;
  return <Dashboard isDark={isDark} nav={nav} />;
}
