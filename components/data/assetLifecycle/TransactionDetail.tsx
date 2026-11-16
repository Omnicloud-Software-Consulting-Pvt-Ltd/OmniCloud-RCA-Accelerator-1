"use client";

import { useRef, useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, PrimaryButton, GhostButton, CodeBlock, ErrorPanel } from "@/components/data/quotes/shared";
import { LoadingRow, Modal, Panel, ToolbarButton, useBillingData } from "@/components/data/billing/billingUi";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiDelete, quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toCreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";
import { STEP_ORDER, swapKindOf, swapPath, type PreviewRow } from "@/lib/assetLifecycle/plan";
import { executeLifecycle, TARGET_LABEL, TARGET_LAST_STEP, type ExecutionResult, type ExecutionTarget } from "@/lib/assetLifecycle/executor";
import type { LifecycleOrder, LifecycleQuote } from "@/lib/assetLifecycle/server/reads";
import { ACTION_TYPE, type AuditEvent, type LifecycleKind, type LifecycleStep, type LifecycleTransaction, type StepId, type SwapKind } from "@/lib/assetLifecycle/types";
import { Badge, KeyValues, Notice, SECTION_META, TableFrame, fmtDate, fmtMoney, fmtNum, td, th } from "./lifecycleUi";
import BillingNeedsDialog from "./BillingNeedsDialog";
import { addressText } from "@/lib/assetLifecycle/billing";
import FieldHelp from "@/components/help/FieldHelp";
import { LIFECYCLE_SECTION_HELP as SH } from "@/lib/help/lifecycleHelp";

interface DetailResponse {
  instanceUrl: string; transaction: LifecycleTransaction; preview: PreviewRow[]; request: unknown; window: { start: string | null; end: string | null } | null;
  problems: string[]; quote: LifecycleQuote | { error: string } | null; order: LifecycleOrder | { error: string } | null; audit: AuditEvent[];
}

/** What each Salesforce write does — shown in the confirmation dialog before anything is sent. */
export function writeDetail(kind: LifecycleKind, step: StepId, swap: SwapKind | null = null): string {
  const noun = SECTION_META[kind].singular.toLowerCase();
  switch (step) {
    case "initiate": if (swap) return `Calls Salesforce's ${swap} API (POST ${swapPath(swap)}) for the selected assets. Salesforce creates a NEW amendment quote that gives up the old product and adds the replacement, linked for reporting — the original orders and assets are not modified. Sent once: a lost response is recovered from Salesforce, never re-sent.`;
      return `Calls Salesforce's standard action ${kind === "amend" ? "initiateAmendment" : kind === "renew" ? "initiateRenewal" : "initiateCancellation"} for the selected assets. Salesforce creates a NEW ${noun} quote (OriginalActionType ${ACTION_TYPE[kind]}) — the original orders and assets are not modified. Sent once: a lost response is recovered from Salesforce, never re-sent.`;
    case "apply-changes": return kind === "cancel" ? "Writes the cancellation reason to the chosen field of the cancellation quote (Place Sales Transaction, pricing skipped)." : `Updates the ${noun} quote's lines (quantities, prices, discounts, fields${kind === "amend" ? ", upgrade/downgrade marks, added products" : ""}) in one Place Sales Transaction request with pricing skipped, then reads the quote back.`;
    case "price": return "Runs Salesforce pricing on the quote and saves the prices (Place Sales Transaction, pricingPref Force) — skipped when Salesforce already priced the quote and nothing changed since. Taxes, proration and pricing procedures are Salesforce's.";
    case "create-order": return `Calls createOrderFromQuote for this ${noun} quote. An order that already exists for the quote is adopted instead — never a second order.`;
    case "prepare-billing": return `Makes the new ${noun} order billing-ready, automatically: writes the Bill-To Contact and Billing / Shipping address you chose to the order; re-prices the order in Salesforce (Place Sales Transaction, pricingPref Force — what "Reprice All" does, which also stamps each order product's Billing Treatment from its policy); applies Order Setup's default treatments and line settings; re-checks readiness. A product without a Billing Policy (a shared product setting) or an unresolvable treatment STOPS for your decision — never guessed. Never activates.`;
    case "activate": return `Activates the NEW ${noun} order through the app's standard Order activation (billing and tax readiness first). Refused for any order not created from this quote. Activation changes the assets in Salesforce and can't be undone.`;
    default: return "";
  }
}

const STEP_COLOR: Record<LifecycleStep["status"], string> = { pending: "#8A9BB5", "in-progress": "#3AABFF", waiting: "#F59E0B", "needs-input": "#B07CFF", completed: "#00C896", failed: "#FF4066", skipped: "#8A9BB5" };
const isErr = (v: unknown): v is { error: string } => !!v && typeof v === "object" && "error" in v;

export default function TransactionDetail({ isDark, transactionId, onBack, onEdit, onOpenAsset, autoExecute }: {
  isDark: boolean; transactionId: string; onBack: () => void;
  /** Opened from "Save & create in Salesforce": show the execution confirmation right away (nothing runs until confirmed). */
  autoExecute?: boolean;
  onEdit: (tx: LifecycleTransaction) => void; onOpenAsset: (id: string) => void;
}) {
  const t = tokens(isDark);
  const { data, error, loading, reload } = useBillingData<DetailResponse>("Load transaction", `/api/asset-lifecycle/${transactionId}`);
  const [execOpen, setExecOpen] = useState(!!autoExecute);
  const [target, setTarget] = useState<ExecutionTarget>("order");
  const [executing, setExecuting] = useState(false);
  const [liveTx, setLiveTx] = useState<LifecycleTransaction | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [activation, setActivation] = useState<{ order: LifecycleOrder | null; resolve: (ok: boolean) => void } | null>(null);
  const [runError, setRunError] = useState<ErrorPanelDataLike | null>(null);
  const [showCalls, setShowCalls] = useState<StepId | null>(null);
  /** Billing readiness asked for decisions: the popup is open; resolve with the updated transaction (or null = pause). */
  const [needsPrompt, setNeedsPrompt] = useState<{ tx: LifecycleTransaction; resolve: (tx: LifecycleTransaction | null) => void } | null>(null);
  const stop = useRef(false);
  const notify = useSalesforceSuccess();
  const tx = liveTx && liveTx.id === data?.transaction.id && liveTx.updatedAt >= data.transaction.updatedAt ? liveTx : data?.transaction ?? null;
  const meta = tx ? SECTION_META[tx.kind] : SECTION_META.amend;
  const next = tx?.steps.find(s => s.status !== "completed" && s.status !== "skipped") ?? null;
  const swap = tx ? swapKindOf(tx) : null;

  /** ONE step on the server — the same endpoint, guards and read-backs as before; notifications only after Salesforce confirmed. */
  async function runOne(step: StepId, o: { confirmed: boolean; activationConfirmed: boolean }): Promise<LifecycleTransaction> {
    const res = await quoteApiPost<{ transaction: LifecycleTransaction }>(`Run ${step}`, `/api/asset-lifecycle/${transactionId}/step`, { step, ...o });
    const out = res.transaction;
    setLiveTx(out);
    const st = out.steps.find(x => x.id === step);
    const sf = out.sf;
    if (st?.status === "completed" && data?.instanceUrl) {
      if (step === "initiate" && sf.quoteId) notify({ title: `${SECTION_META[out.kind].singular} Quote Created`, message: st.message ?? "", records: [toCreatedSalesforceRecord(data.instanceUrl, "Quote", sf.quoteId, sf.quoteNumber ?? sf.quoteId)] });
      if (step === "create-order" && sf.orderId) notify({ title: `${SECTION_META[out.kind].singular} Order Created`, message: st.message ?? "", records: [toCreatedSalesforceRecord(data.instanceUrl, "Order", sf.orderId, sf.orderNumber ?? sf.orderId)] });
      if (step === "activate" && sf.orderId) notify({ title: `${SECTION_META[out.kind].singular} Order Activated`, message: st.message ?? "", records: [toCreatedSalesforceRecord(data.instanceUrl, "Order", sf.orderId, sf.orderNumber ?? sf.orderId)] });
    }
    return out;
  }

  /** Before activation: re-read the ACTUAL order Salesforce created and ask — activation is never covered by the execution confirmation. */
  async function confirmActivation(current: LifecycleTransaction): Promise<boolean> {
    let order: LifecycleOrder | null = null;
    try {
      const d = await quoteApiGet<DetailResponse>("Load the order to activate", `/api/asset-lifecycle/${current.id}`);
      order = d.order && !isErr(d.order) ? d.order : null;
    } catch { order = null; }
    return new Promise<boolean>(resolve => setActivation({ order, resolve }));
  }

  async function execute(goal: ExecutionTarget) {
    if (!tx) return;
    setExecOpen(false); setExecuting(true); setRunError(null); setResult(null); setProgress([]); stop.current = false;
    const r = await executeLifecycle(tx, {
      target: goal, runStep: runOne, confirmActivation,
      resolveNeeds: current => new Promise(resolve => setNeedsPrompt({ tx: current, resolve })),
      onProgress: (_t, note) => setProgress(p => [...p.slice(-40), note]),
      sleep: ms => new Promise(res => setTimeout(res, ms)), pollMs: 5000, cancelled: () => stop.current,
    });
    setResult(r); setExecuting(false); reload();
  }
  async function remove() {
    try { await quoteApiDelete(`Delete ${meta.singular.toLowerCase()}`, `/api/asset-lifecycle/${transactionId}`); onBack(); }
    catch (e) { setRunError(toErrorPanelData(e, "Couldn't delete")); }
  }

  const quote = data && !isErr(data.quote) ? data.quote : null;
  const order = data && !isErr(data.order) ? data.order : null;
  const sent = !!(tx?.sf.quoteId || tx?.sf.requestIdentifier || tx?.sf.initiatedAt);
  const editable = !!tx && !tx.sf.orderId && !tx.sf.orderRequestedAt;
  // Bill-To + addresses stay editable until the order is activated (billing readiness re-applies them).
  const billingEditable = !!tx && !tx.sf.activatedAt && !editable;
  const billingReady = tx?.billingLog?.filter(l => l.action === "Billing ready").slice(-1)[0] ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} data-testid="transaction-detail">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <GhostButton label={`Back to ${meta.label.toLowerCase()}`} icon="arrow-left" isDark={isDark} onClick={onBack} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <ToolbarButton isDark={isDark} label="Refresh from Salesforce" icon="refresh" onClick={reload} />
          {editable && !executing && <ToolbarButton isDark={isDark} label={sent ? "Edit line changes" : "Edit plan"} icon="edit" onClick={() => tx && onEdit(tx)} />}
          {billingEditable && !executing && <ToolbarButton isDark={isDark} label="Edit billing details" icon="edit" onClick={() => tx && onEdit(tx)} />}
          {tx && !sent && <ToolbarButton isDark={isDark} label="Delete draft" icon="trash" onClick={() => void remove()} />}
        </div>
      </div>
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {runError && <ErrorPanel isDark={isDark} error={runError} />}
      {loading && !data && <LoadingRow isDark={isDark} label="Loading the transaction and reading Salesforce…" />}
      {tx && data && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ color: meta.color }}><Ic n={meta.icon} s={18} /></span>
            <div style={{ fontSize: 18, fontWeight: 800, color: t.heading }}>{tx.name}</div>
            <Badge label={tx.status} color={STEP_COLOR[tx.status === "draft" ? "pending" : tx.status === "in-progress" ? "in-progress" : tx.status]} isDark={isDark} />
          </div>
          <Panel isDark={isDark} title="Salesforce records" icon="database" right={<FieldHelp isDark={isDark} label="Salesforce records" entry={SH.salesforceRecords} />}>
            <KeyValues isDark={isDark} rows={[
              ["Account", tx.accountName ?? tx.accountId], ["Contract", tx.contractNumber ?? tx.contractId ?? "—"], ["Opportunity", tx.opportunityName ?? tx.opportunityId ?? "—"],
              [tx.kind === "renew" ? "Renewal window" : tx.kind === "cancel" ? "Cancellation date" : "Effective date", tx.kind === "renew" ? `${data.window?.start ?? "Salesforce default"} → ${data.window?.end ?? "Salesforce default"}` : tx.effectiveDate],
              ["Request identifier", tx.sf.requestIdentifier ?? "—"], [`${meta.singular} quote`, tx.sf.quoteNumber ?? tx.sf.quoteId ?? "—"], ["Order", tx.sf.orderNumber ?? tx.sf.orderId ?? "—"], ["Activated", tx.sf.activatedAt ? fmtDate(tx.sf.activatedAt) : "—"],
              ...(tx.kind === "cancel" ? [["Reason", tx.cancel?.reason ? `${tx.cancel.reason}${tx.cancel.reasonField ? ` → ${tx.cancel.reasonField.object}.${tx.cancel.reasonField.field}` : " (app audit only)"}` : "—"] as [string, string]] : []),
            ]} />
          </Panel>
          {data.problems.length > 0 && <Notice isDark={isDark} tone="error"><b>Not ready to send:</b> {data.problems.join(" ")}</Notice>}
          <Panel isDark={isDark} title="Billing readiness" icon="credit-card" right={<FieldHelp isDark={isDark} label="Billing readiness" entry={SH.billingReadiness} />}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-testid="billing-readiness">
              <KeyValues isDark={isDark} rows={[
                ["Bill-To Contact", tx.billing?.billToContactName ?? tx.billing?.billToContactId ?? "—"],
                ["Billing address", addressText(tx.billing?.billingAddress) || "—"],
                ["Shipping address", addressText(tx.billing?.shippingAddress) || "—"],
                ["Source", tx.billing?.source ?? "—"],
              ]} />
              {(tx.billingNeeds ?? []).length > 0 && <Notice isDark={isDark} tone="warn"><b>Your decision is needed:</b> {(tx.billingNeeds ?? []).map(n => n.message).join(" ")}</Notice>}
              {[...(tx.billingResolutions?.policies ?? []).map(p => `${p.productName} → Billing Policy ${p.policyName} (${p.appliedAt ? "applied & read back" : "approved, applied on resume"})`), ...(tx.billingResolutions?.treatments ?? []).map(x => `${x.productName} order product → Billing Treatment ${x.treatmentName} (${x.appliedAt ? "applied & read back" : "approved, applied on resume"})`)].map(l => <div key={l} style={{ fontSize: 12, color: t.body }}>✔ {l}</div>)}
              {(tx.billingLog ?? []).length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }} aria-live="polite">
                  {(tx.billingLog ?? []).slice(-12).map((l, i) => (
                    <div key={`${l.at}-${i}`} style={{ fontSize: 12, color: l.ok ? t.body : t.error }}>
                      <span style={{ color: l.ok ? "#00C896" : t.error }}>●</span> {new Date(l.at).toLocaleTimeString()} · <b>{l.action}</b> — {l.detail}
                    </div>
                  ))}
                </div>
              ) : <div style={{ fontSize: 12, color: t.dim }}>Runs automatically after the order is created: Bill-To &amp; addresses → billing policy &amp; treatment → Salesforce re-pricing → readiness check. Progress appears here.</div>}
            </div>
          </Panel>

          <Panel isDark={isDark} title="Lifecycle in Salesforce" icon="activity" right={
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <FieldHelp isDark={isDark} label="Lifecycle in Salesforce" entry={SH.lifecycleSteps} />
              {executing
                ? <><span style={{ fontSize: 11.5, color: t.dim }}>Executing…</span><GhostButton label="Stop after this step" icon="x" isDark={isDark} onClick={() => { stop.current = true; }} /></>
                : next
                  ? (next.id === "activate"
                    ? <PrimaryButton isDark={isDark} label="Activate order…" icon="zap" onClick={() => void execute("activate")} />
                    : <PrimaryButton isDark={isDark} label={sent ? (next.status === "failed" ? `Retry from "${next.label}"…` : next.status === "needs-input" ? "Answer billing questions & resume…" : "Resume execution…") : "Execute lifecycle…"} icon="send" disabled={!sent && data.problems.length > 0} onClick={() => setExecOpen(true)} />)
                  : <Badge label="Complete — verified in Salesforce" color="#00C896" isDark={isDark} />}
            </div>
          }>
            {result && (
              <div style={{ marginBottom: 10 }}>
                <Notice isDark={isDark} tone={result.status === "completed" ? "success" : result.status === "failed" ? "error" : "info"}>
                  <b>{result.status === "completed" ? "Done." : result.status === "failed" ? `Stopped at "${tx.steps.find(x => x.id === result.step)?.label ?? result.step}".` : result.status === "awaiting-activation" ? "Order ready — not activated." : result.status === "needs-input" ? "Waiting for your billing decision." : "Paused."}</b> {result.message}
                  {result.status === "failed" && <div style={{ marginTop: 4 }}>Nothing after this step was run. Fix the cause (or wait for Salesforce), then use the button above to retry from this step — existing quotes and orders are reused, never duplicated.</div>}
                </Notice>
              </div>
            )}
            {executing && progress.length > 0 && <div style={{ fontSize: 11.5, color: t.dim, marginBottom: 8 }} aria-live="polite">{progress[progress.length - 1]}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {tx.steps.map((s, i) => {
                const isNext = next?.id === s.id;
                return (
                  <div key={s.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 11px", borderRadius: 10, border: `1px solid ${isNext ? t.accent + "55" : t.border}`, background: isNext ? `${t.accent}0c` : "transparent" }}>
                    <span style={{ width: 22, height: 22, borderRadius: 999, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: "#04101F", background: STEP_COLOR[s.status] }}>{s.status === "completed" ? "✓" : i + 1}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5, fontWeight: 700, color: t.heading }}>
                        {s.label} <Badge label={s.status} color={STEP_COLOR[s.status]} isDark={isDark} />{s.writes && <Badge label="writes to Salesforce" color="#F59E0B" isDark={isDark} />}
                      </div>
                      {s.message && <div style={{ fontSize: 12, color: s.status === "failed" ? t.error : t.body, marginTop: 3, overflowWrap: "anywhere" }}>{s.message}</div>}
                      {s.calls.length > 0 && (
                        <button onClick={() => setShowCalls(v => (v === s.id ? null : s.id))} style={{ marginTop: 4, background: "none", border: "none", padding: 0, color: t.accent, fontSize: 11.5, cursor: "pointer" }}>
                          {showCalls === s.id ? "Hide" : "Show"} {s.calls.length} Salesforce call(s)
                        </button>
                      )}
                      {showCalls === s.id && <CodeBlock isDark={isDark} data={s.calls} open label="Salesforce requests and responses" />}
                    </div>
                    {isNext && executing && <span style={{ fontSize: 11.5, color: t.accent, flexShrink: 0 }}>running…</span>}
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel isDark={isDark} title="Original vs changed" icon="eye" right={<FieldHelp isDark={isDark} label="Original vs changed" entry={SH.originalVsChanged} />}>
            <TableFrame isDark={isDark}>
              <thead><tr>{["Asset", "Change", "Original qty", "Result", "Original price", "New price", "End", "Est. impact*"].map(h => <th key={h} style={th(t)}>{h}</th>)}</tr></thead>
              <tbody>{data.preview.map(r => (
                <tr key={r.assetId}>
                  <td style={td(t)}><button onClick={() => onOpenAsset(r.assetId)} style={{ background: "none", border: "none", padding: 0, color: t.accent, cursor: "pointer", fontSize: 12.5 }}>{r.name}</button><div style={{ fontSize: 10.5, color: t.dim }}>{r.fieldChanges.join(" · ")}</div></td>
                  <td style={td(t)}>{r.kind}</td><td style={td(t)}>{fmtNum(r.originalQuantity)}</td><td style={td(t)}>{fmtNum(r.resultingQuantity)}</td>
                  <td style={td(t)}>{fmtMoney(r.originalUnitPrice)}</td><td style={td(t)}>{r.newUnitPrice != null ? fmtMoney(r.newUnitPrice) : "—"}{r.newDiscount != null ? ` −${r.newDiscount}%` : ""}</td>
                  <td style={td(t)}>{fmtDate(r.originalEnd)} → {r.newEnd ?? "—"}</td><td style={td(t)}>{r.estimatedChange != null ? fmtMoney(r.estimatedChange) : "—"}</td>
                </tr>
              ))}</tbody>
            </TableFrame>
            <div style={{ fontSize: 11, color: t.dim, marginTop: 6 }}>* App estimate. The quote below shows what Salesforce actually calculated (proration, credits, tax).</div>
            <div style={{ marginTop: 8 }}><CodeBlock isDark={isDark} data={data.request} label="Show the initiate request" /></div>
          </Panel>

          {isErr(data.quote) && <Notice isDark={isDark} tone="error">The quote couldn&apos;t be read: {data.quote.error}</Notice>}
          {quote && (
            <Panel isDark={isDark} title={`${meta.singular} quote ${quote.quoteNumber ?? quote.id} (live from Salesforce)`} icon="file-text"
              right={<span style={{ fontSize: 11.5, color: t.dim }}>{quote.originalActionType ?? "—"} · {quote.status ?? "—"} · Calc {quote.calculationStatus ?? "—"} · priced {fmtDate(quote.lastPricedDate)}</span>}>
              <TableFrame isDark={isDark}>
                <thead><tr>{["Product", "Action", "Start qty", "Change", "End qty", "Unit", "Discount", "Net unit", "Total", "Billing", "Dates"].map(h => <th key={h} style={th(t)}>{h}</th>)}</tr></thead>
                <tbody>{quote.lines.map(l => (
                  <tr key={l.id}>
                    <td style={td(t)}>{l.parentLineId ? "↳ " : ""}{l.productName ?? "—"}</td><td style={td(t)}>{l.actionType ?? "Add"}{l.actionSubtype ? ` / ${l.actionSubtype}` : ""}</td>
                    <td style={td(t)}>{fmtNum(l.startQuantity)}</td><td style={td(t)}>{fmtNum(l.quantity)}</td><td style={td(t)}>{fmtNum(l.endQuantity)}</td>
                    <td style={td(t)}>{fmtMoney(l.unitPrice)}</td><td style={td(t)}>{l.discount != null ? `${l.discount}%` : "—"}</td><td style={td(t)}>{fmtMoney(l.netUnitPrice)}</td><td style={td(t)}>{fmtMoney(l.totalPrice)}</td>
                    <td style={td(t)}>{l.billingFrequency ?? "—"}</td><td style={td(t)}>{fmtDate(l.startDate)} → {fmtDate(l.endDate)}</td>
                  </tr>
                ))}</tbody>
              </TableFrame>
              <div style={{ marginTop: 8, fontSize: 12.5, color: t.heading, fontWeight: 700 }}>Financial impact (Salesforce): total {fmtMoney(quote.totalPrice)}{quote.tax != null ? ` · tax ${fmtMoney(quote.tax)}` : ""}{quote.grandTotal != null ? ` · grand total ${fmtMoney(quote.grandTotal)}` : ""}</div>
            </Panel>
          )}
          {isErr(data.order) && <Notice isDark={isDark} tone="error">The order couldn&apos;t be read: {data.order.error}</Notice>}
          {order && (
            <Panel isDark={isDark} title={`${meta.singular} order ${order.orderNumber ?? order.id}`} icon="shopping-cart" right={<span style={{ fontSize: 11.5, color: t.dim }}>{order.originalActionType ?? "—"} · {order.status ?? "—"} · total {fmtMoney(order.totalAmount)}</span>}>
              {order.items.map(i => <div key={i.id} style={{ fontSize: 12.5, color: t.body }}>{i.productName ?? "—"} · {i.actionType ?? "—"} · qty {fmtNum(i.quantity)} ({fmtNum(i.startQuantity)} → {fmtNum(i.endQuantity)}) @ {fmtMoney(i.unitPrice)}</div>)}
              <div style={{ fontSize: 11.5, color: t.dim, marginTop: 6 }}>Billing schedules, invoices, credit/debit memos and payments for this order are handled in Order Setup / Revenue Cloud Billing, as for any order.</div>
            </Panel>
          )}

          {tx.checks.length > 0 && (
            <Panel isDark={isDark} title="Read-back checks" icon="check-circle">
              {tx.checks.map(c => (
                <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, color: t.body, marginBottom: 4 }}>
                  <span style={{ color: c.ok ? "#00C896" : c.required === false ? t.warn : t.error, flexShrink: 0 }}><Ic n={c.ok ? "check-circle" : "alert"} s={14} /></span>
                  <span><b>{c.label}</b>{c.required === false ? " (informational)" : ""} — {c.detail}</span>
                </div>
              ))}
            </Panel>
          )}

          <Panel isDark={isDark} title="Audit trail" icon="clock">
            {data.audit.length === 0 ? <div style={{ fontSize: 12, color: t.dim }}>No events yet.</div> : data.audit.map(a => (
              <div key={a.id} style={{ fontSize: 12, color: t.body, marginBottom: 4 }}>
                <span style={{ color: a.status === "failed" ? t.error : a.status === "success" ? "#00C896" : t.dim }}>●</span> {new Date(a.at).toLocaleString()} · <b>{a.action}</b> · {a.summary}
              </div>
            ))}
          </Panel>
        </>
      )}

      {execOpen && tx && next && (
        <Modal isDark={isDark} tone="warn" title={`${sent ? "Resume" : "Execute"} the ${meta.singular.toLowerCase()} in Salesforce`}
          actions={<><GhostButton label="Cancel" isDark={isDark} onClick={() => setExecOpen(false)} /><PrimaryButton isDark={isDark} label="Confirm and send to Salesforce" icon="send" onClick={() => void execute(target)} /></>}>
          <div>Runs the remaining steps in order on {tx.accountName ?? tx.accountId} — {tx.assets.map(a => a.name).join(", ")} — and stops at the first failure. Each result is read back from Salesforce.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }} role="radiogroup" aria-label="How far to go">
            {(["quote", "order", "activate"] as ExecutionTarget[]).map(g => (
              <label key={g} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, cursor: "pointer" }}>
                <input type="radio" name="exec-target" checked={target === g} onChange={() => setTarget(g)} disabled={STEP_ORDER.indexOf(TARGET_LAST_STEP[g]) < STEP_ORDER.indexOf(next.id)} />
                <span><b>{TARGET_LABEL[g]}</b>{g === "quote" ? " — a DRAFT quote only; no order." : g === "order" ? " — creates a Draft order; nothing is activated." : " — the order is shown again and activation needs its own confirmation."}</span>
              </label>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
            {tx.steps.filter(x => x.status !== "completed" && x.status !== "skipped" && STEP_ORDER.indexOf(x.id) <= STEP_ORDER.indexOf(TARGET_LAST_STEP[target])).map(x => (
              <div key={x.id}><b>{x.label}</b>{x.writes ? <span style={{ color: t.warn }}> · writes to Salesforce</span> : ""}{x.writes && x.id !== "activate" ? <div style={{ color: t.dim }}>{writeDetail(tx.kind, x.id, swap)}</div> : null}</div>
            ))}
          </div>
        </Modal>
      )}
      {activation && tx && (
        <Modal isDark={isDark} tone="warn" title={`Activate ${meta.singular.toLowerCase()} order ${activation.order?.orderNumber ?? tx.sf.orderNumber ?? tx.sf.orderId ?? ""}?`}
          actions={<><GhostButton label="Not now" isDark={isDark} onClick={() => { activation.resolve(false); setActivation(null); }} /><PrimaryButton isDark={isDark} label="Activate order (irreversible)" icon="zap" onClick={() => { activation.resolve(true); setActivation(null); }} /></>}>
          <div>{writeDetail(tx.kind, "activate", swap)}</div>
          {activation.order ? (
            <div style={{ fontSize: 12.5, display: "flex", flexDirection: "column", gap: 3 }}>
              <div><b>Order {activation.order.orderNumber ?? activation.order.id}</b> · {activation.order.originalActionType ?? "—"} · status {activation.order.status ?? "—"} · total {fmtMoney(activation.order.totalAmount)}</div>
              {activation.order.items.map(i => <div key={i.id}>{i.productName ?? "—"} · {i.actionType ?? "—"} · qty {fmtNum(i.quantity)} ({fmtNum(i.startQuantity)} → {fmtNum(i.endQuantity)})</div>)}
            </div>
          ) : <Notice isDark={isDark} tone="warn">The order couldn&apos;t be re-read for this summary — check it in Salesforce before activating.</Notice>}
          {billingReady
            ? <Notice isDark={isDark} tone="success"><b>Billing readiness (read back from Salesforce):</b> {billingReady.detail}</Notice>
            : <Notice isDark={isDark} tone="warn">Billing readiness hasn&apos;t confirmed this order — activation re-checks it and is refused if anything is missing.</Notice>}
          <div style={{ fontSize: 12, color: t.dim }}>Assets affected: {tx.assets.map(a => a.name).join(", ")}</div>
        </Modal>
      )}
      {needsPrompt && (
        <BillingNeedsDialog isDark={isDark} tx={needsPrompt.tx}
          onDone={updated => { const r = needsPrompt.resolve; setNeedsPrompt(null); if (updated) setLiveTx(updated); r(updated); }}
          onEditBilling={() => { const r = needsPrompt.resolve; setNeedsPrompt(null); r(null); onEdit(needsPrompt.tx); }} />
      )}
    </div>
  );
}
