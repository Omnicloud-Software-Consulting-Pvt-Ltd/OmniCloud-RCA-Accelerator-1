"use client";

import { useState, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, PrimaryButton, GhostButton, PageShell, FooterBar, Spinner, ErrorPanel, CodeBlock } from "@/components/data/quotes/shared";
import { Panel, StatusPill, Modal, Row, LoadingRow, useBillingData } from "@/components/data/billing/billingUi";
import { useSalesforceSuccess, useNotify } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import type { BillingAddress, OrderBillingItem, OrderBillingState } from "@/lib/billing/server/orderBilling";
import type { OrderBillingAiResult, OrderBillingAction } from "@/lib/billing/server/orderBillingAi";
import { AssignDecisionTableStep, InvoiceTaxRecalcStep, RefreshStep } from "@/components/data/taxes/DecisionTableActions";
import PromptGuide from "@/components/ai/PromptGuide";
import { billingPromptGuides } from "@/lib/ai/promptGuides/billing";

type Busy = null | "refresh" | "ai" | "setup" | "details" | "activate" | "schedules" | "invoice" | "post";

/** Toast titles for mutations that don't raise their own record-linked notification (activate / post do). */
const SUCCESS_TITLE: Partial<Record<NonNullable<Busy>, string>> = {
  setup: "Billing Setup Applied",
  details: "Billing Details Saved",
  schedules: "Billing Schedules Requested",
  invoice: "Invoice Generation Requested",
};
type MutationResponse = { success: true; message: string; state: OrderBillingState };
type Readiness = "READY" | "ACTION REQUIRED" | "WARNING" | "BLOCKED" | "ALREADY CONFIGURED";

const EMPTY_ADDRESS: BillingAddress = { street: null, city: null, state: null, postalCode: null, country: null };
const ADDRESS_INPUTS: [keyof BillingAddress, string, string][] = [["street", "Street", "1 / -1"], ["city", "City", "auto"], ["state", "State / Province", "auto"], ["postalCode", "Postal Code", "auto"], ["country", "Country", "auto"]];
const addressText = (a: BillingAddress | null) => (a ? [a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(", ") : "");
const money = (n: number | null | undefined, currency?: string | null) => (n === null || n === undefined ? "—" : `${currency ? `${currency} ` : ""}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function overallReadiness(s: OrderBillingState): Readiness {
  if (s.order.activated) return s.items.some(i => i.status === "WARNING" || i.status === "BLOCKED") ? "WARNING" : "ALREADY CONFIGURED";
  if (s.readiness.blockers.length || s.items.some(i => i.status === "BLOCKED")) return "BLOCKED";
  if (s.readiness.ready) return s.items.some(i => i.status === "WARNING") ? "WARNING" : "READY";
  return "ACTION REQUIRED";
}

const itemColor = (status: OrderBillingItem["status"], t: ReturnType<typeof tokens>) =>
  status === "READY" || status === "ALREADY_CONFIGURED" ? "#00C875" : status === "WARNING" || status === "ACTION_REQUIRED" ? t.warn : t.error;

function Badge({ label, color }: { label: string; color: string }) {
  return <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.3, padding: "2px 9px", borderRadius: 999, color, border: `1px solid ${color}60`, background: `${color}14`, whiteSpace: "nowrap" }}>{label}</span>;
}

function SectionNote({ isDark, children, tone = "dim" }: { isDark: boolean; children: ReactNode; tone?: "dim" | "warn" | "error" | "ok" }) {
  const t = tokens(isDark);
  const color = tone === "warn" ? t.warn : tone === "error" ? t.error : tone === "ok" ? "#00C875" : t.dim;
  return <div style={{ fontSize: 12, color, fontWeight: tone === "dim" ? 500 : 600 }}>{children}</div>;
}

/**
 * "Revenue Cloud Billing — Order Setup": the one reusable workspace every Orders entry point opens
 * with an Order Id. Everything shown is read from Salesforce (GET /api/billing/orders/[id]); every
 * button calls a guarded server endpoint that re-validates readiness and rejects stale state
 * (stateToken → 409) before writing, then returns the re-read state. Resumable at any step.
 *
 *   Order → Billing Details → Billing Configuration → Order Actions → Usage → Readiness
 *     → Activate → Billing Schedules (Salesforce action, async) → Invoice (generate → post) → Payment
 */
export default function BillingOrderSetup({ isDark, orderId, onOpenOrder, onOpenPolicy, onOpenSchedule, onOpenInvoice, onOpenPayments, onAssignPolicy, onChanged }: {
  isDark: boolean;
  orderId: string;
  onOpenOrder: (orderId: string) => void;
  onOpenPolicy: (policyId: string) => void;
  onOpenSchedule: (scheduleId: string) => void;
  onOpenInvoice: (invoiceId: string) => void;
  onOpenPayments: (invoiceId?: string, mode?: "record" | "settle" | "credit") => void;
  onAssignPolicy: (productId: string) => void;
  onChanged?: () => void;
}) {
  const t = tokens(isDark);
  const notifySalesforceSuccess = useSalesforceSuccess();
  const notifier = useNotify();
  const loaded = useBillingData<OrderBillingState>("Load order billing", `/api/billing/orders/${orderId}`);
  const [override, setOverride] = useState<OrderBillingState | null>(null);
  const state = override ?? loaded.data;
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [modal, setModal] = useState<null | "activate" | "post">(null);
  // The invoice the Post Invoice confirmation is for (the one whose button was clicked).
  const [postTargetId, setPostTargetId] = useState<string | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [ai, setAi] = useState<OrderBillingAiResult | null>(null);
  // Billing details drafts — null means "show what Salesforce has".
  const [contactDraft, setContactDraft] = useState<string | null>(null);
  const [billingDraft, setBillingDraft] = useState<BillingAddress | null>(null);
  const [shippingDraft, setShippingDraft] = useState<BillingAddress | null>(null);

  const refresh = () => { setOverride(null); setError(null); loaded.reload(); };

  async function mutate(kind: Exclude<Busy, null | "refresh" | "ai">, path: string, body: Record<string, unknown>, title: string) {
    if (!state) return null;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const res = await quoteApiPost<MutationResponse>(title, `/api/billing/orders/${orderId}/${path}`, { ...body, stateToken: state.stateToken });
      setOverride(res.state);
      setNotice({ tone: "ok", text: res.message });
      const successTitle = SUCCESS_TITLE[kind];
      if (successTitle) notifier.success(successTitle, `Order ${res.state.order.number ?? orderId}: ${res.message}`, { module: "Billing", context: "billing", records: [{ objectApiName: "Order", recordId: res.state.order.id, recordName: res.state.order.number ?? res.state.order.id, salesforceUrl: res.state.order.salesforceUrl }] });
      onChanged?.();
      return res;
    } catch (err) {
      const panel = withAppRouteDiagnosis(toBillingErrorPanel(err, title), `/api/billing/orders/${orderId}/${path}`);
      setError(panel);
      const raw = panel.raw as { state?: OrderBillingState | null; code?: string } | undefined;
      if (raw?.state) setOverride(raw.state); // stale / blocked → show the latest Salesforce state
      if (raw?.code === "ORDER_CHANGED") setNotice({ tone: "warn", text: "The order changed in Salesforce since you loaded it — the latest state is shown. Review it and try again." });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function analyze() {
    if (!prompt.trim()) return;
    setBusy("ai");
    setError(null);
    try {
      const res = await quoteApiPost<OrderBillingAiResult>("AI order billing", `/api/billing/orders/${orderId}/ai`, { prompt });
      setAi(res);
      const details = res.steps.find(s => s.action === "billing-details");
      if (details?.contact) setContactDraft(details.contact.id);
      if (state && typeof details?.addressSuggestion === "number") {
        const sug = state.addressSuggestions[details.addressSuggestion]?.address;
        if (sug) { if (!state.order.billingAddress) setBillingDraft(sug); if (!state.order.shippingAddress) setShippingDraft(sug); }
      }
    } catch (err) {
      setError(toBillingErrorPanel(err, "AI analysis failed"));
    } finally {
      setBusy(null);
    }
  }

  async function saveDetails() {
    if (!state) return;
    const body: Record<string, unknown> = {};
    if (contactDraft && contactDraft !== state.order.billToContact?.id) body.contactId = contactDraft;
    if (billingDraft) body.address = billingDraft;
    if (shippingDraft) body.shippingAddress = shippingDraft;
    if (!Object.keys(body).length) { setNotice({ tone: "warn", text: "No billing detail changes to save." }); return; }
    const res = await mutate("details", "bill-to", body, "Save billing details");
    if (res) { setContactDraft(null); setBillingDraft(null); setShippingDraft(null); }
  }

  async function activate() {
    setModal(null);
    const res = await mutate("activate", "activate", {}, "Activate Order & Start Billing");
    if (res) notifySalesforceSuccess({ title: "Order Activated", message: `Order ${res.state.order.number} activated for billing.`, records: [{ objectApiName: "Order", recordId: res.state.order.id, recordName: res.state.order.number ?? res.state.order.id, salesforceUrl: res.state.order.salesforceUrl }], module: "Billing", context: "billing" });
  }

  async function postInvoice(invoiceId: string) {
    setModal(null);
    setPostTargetId(null);
    if (busy) return; // one posting request at a time (the server refuses a concurrent one too)
    const res = await mutate("post", `invoices/${invoiceId}/post`, {}, "Post Invoice");
    const inv = res?.state.invoices.find(i => i.id === invoiceId);
    if (res && inv) notifySalesforceSuccess({ title: /^posted$/i.test(inv.status ?? "") ? "Invoice Posted" : "Invoice Posting Requested", message: `${inv.number} — Salesforce status: ${inv.status ?? "unknown"}`, records: [{ objectApiName: "Invoice", recordId: inv.id, recordName: inv.number ?? inv.id, salesforceUrl: inv.salesforceUrl }] });
  }

  function runPlanStep(action: OrderBillingAction) {
    if (!state) return;
    if (action === "setup") void mutate("setup", "setup", { operations: ["order-action", "billing-treatment", "tax-treatment", "billing-start-month", "billing-end-date"] }, "Apply billing setup");
    else if (action === "billing-details") document.getElementById("order-billing-details")?.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (action === "activate") setModal("activate");
    else if (action === "schedules") void mutate("schedules", "schedules", {}, "Create Billing Schedules");
    else if (action === "invoice") void mutate("invoice", "invoices", {}, "Generate Invoice");
    else if (action === "post") { const inv = state.invoices.find(invoicePostable); if (inv) { setPostTargetId(inv.id); setModal("post"); } }
    else refresh();
  }

  if (!state) {
    return (
      <PageShell>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {loaded.error ? <ErrorPanel isDark={isDark} error={loaded.error} /> : <LoadingRow isDark={isDark} label="Reading the order, its products and billing records from Salesforce…" />}
          {loaded.error && <div><GhostButton label="Retry" icon="refresh" isDark={isDark} onClick={refresh} /></div>}
        </div>
      </PageShell>
    );
  }

  const o = state.order;
  const readiness = overallReadiness(state);
  const readinessColor = readiness === "READY" || readiness === "ALREADY CONFIGURED" ? "#00C875" : readiness === "BLOCKED" ? t.error : t.warn;
  const pendingSetup = state.items.filter(i => i.pendingActions.length);
  // Order-level setup (Order.LegalEntityId from the tax treatments) also needs "Apply".
  const orderLePending = state.readiness.checks.some(c => c.id === "taxLegalEntity" && c.status === "pending");
  const usageItems = state.items.filter(i => i.usage.required);
  const readySchedules = state.schedules.filter(s => !s.invoiced && /readyforinvoicing/i.test(s.status ?? ""));
  const processingSchedules = state.schedules.filter(s => /processing/i.test(s.status ?? ""));
  const runningJobs = state.jobs.filter(j => /submitted|inprogress/i.test(j.status ?? ""));
  const draftInvoice = state.invoices.find(invoicePostable);
  const postTarget = state.invoices.find(i => i.id === postTargetId && invoicePostable(i)) ?? null;
  const postingInvoice = state.invoices.find(i => /progress/i.test(i.status ?? ""));
  const detailChecks = state.readiness.checks.filter(c => ["billTo", "billingAddress", "shippingAddress"].includes(c.id));
  const detailsComplete = detailChecks.every(c => c.status === "passed");
  const detailsDirty = (!!contactDraft && contactDraft !== o.billToContact?.id) || !!billingDraft || !!shippingDraft;
  const checkColor = (s: string) => (s === "passed" ? "#00C875" : s === "warning" || s === "pending" ? t.warn : t.error);
  const btn = (b: Busy, label: string, active: string) => (busy === b ? active : label);

  const addressEditor = (kind: "billing" | "shipping") => {
    const current = kind === "billing" ? o.billingAddress : o.shippingAddress;
    const labels = current && !(kind === "billing" ? billingDraft : shippingDraft) ? o.addressLabels?.[kind] : null;
    const draft = kind === "billing" ? billingDraft : shippingDraft;
    const setDraft = kind === "billing" ? setBillingDraft : setShippingDraft;
    const value = draft ?? current ?? EMPTY_ADDRESS;
    const title = kind === "billing" ? "Billing Address" : "Shipping Address";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: t.heading }}>{title}</span>
          {current ? <Badge label="SET IN SALESFORCE" color="#00C875" /> : <Badge label="MISSING" color={t.warn} />}
          {draft && <Badge label="UNSAVED" color={t.accent} />}
          {kind === "shipping" && (billingDraft ?? o.billingAddress) && <GhostButton label="Same as billing" icon="copy" isDark={isDark} onClick={() => setShippingDraft(billingDraft ?? o.billingAddress)} />}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
          {ADDRESS_INPUTS.map(([k, label, col]) => (
            <label key={k} style={{ display: "flex", flexDirection: "column", gap: 3, gridColumn: col, fontSize: 11, fontWeight: 700, color: t.dim }}>
              {label}{["street", "city", "country"].includes(k) ? " *" : ""}
              <input value={value[k] ?? ""} onChange={e => setDraft({ ...value, [k]: e.target.value })} style={{ ...inputStyle(t), fontSize: 13 }} />
            </label>
          ))}
        </div>
        <div style={{ fontSize: 11, color: t.dim }}>
          {labels && (labels.country || labels.state) ? <>Country <b style={{ color: t.body }}>{labels.country ?? "—"}</b>{labels.state && <> · State <b style={{ color: t.body }}>{labels.state}</b></>} · </> : null}
          Country and State names are saved as ISO codes (e.g. Canada → CA, Ontario → ON) — the tax lookup matches the code.
        </div>
        {!current && state.addressSuggestions.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: t.dim }}>Use an address already in Salesforce:</span>
            {state.addressSuggestions.map((s, i) => (
              <button key={i} type="button" onClick={() => setDraft(s.address)} title={addressText(s.address)}
                style={{ fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 999, border: `1px solid ${t.border}`, background: t.surfaceAlt, color: t.body, cursor: "pointer" }}>
                {s.source}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const footer = (
    <FooterBar isDark={isDark}>
      <GhostButton label="View Order" icon="shopping-cart" isDark={isDark} onClick={() => onOpenOrder(o.id)} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {(busy || loaded.loading) && <span style={{ fontSize: 12, color: t.accent, display: "inline-flex", gap: 6, alignItems: "center" }}><Spinner isDark={isDark} size={12} /> Working with Salesforce…</span>}
        <GhostButton label="Refresh Billing Status" icon="refresh" isDark={isDark} disabled={!!busy} onClick={refresh} />
        {!o.activated && <PrimaryButton label={btn("activate", "Activate Order & Start Billing", "Activating…")} icon="zap" isDark={isDark} disabled={!state.readiness.ready || !!busy} onClick={() => setModal("activate")} />}
        {o.activated && state.scheduleCreation.available && <PrimaryButton label={btn("schedules", "Create Billing Schedules", "Requesting…")} icon="calendar" isDark={isDark} disabled={!!busy} onClick={() => void mutate("schedules", "schedules", {}, "Create Billing Schedules")} />}
        {o.activated && !state.scheduleCreation.available && readySchedules.length > 0 && <PrimaryButton label={btn("invoice", "Generate Invoice", "Generating…")} icon="file-text" isDark={isDark} disabled={!!busy} onClick={() => void mutate("invoice", "invoices", {}, "Generate Invoice")} />}
        {o.activated && !readySchedules.length && draftInvoice && <PrimaryButton label={btn("post", "Post Invoice", "Posting…")} icon="send" isDark={isDark} disabled={!!busy} onClick={() => { setPostTargetId(draftInvoice.id); setModal("post"); }} />}
      </div>
    </FooterBar>
  );

  return (
    <PageShell footer={footer}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {/* ── Header ── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Revenue Cloud Billing — Order Setup</div>
            <div style={{ fontSize: 11.5, color: t.dim }}>Order {o.number} · {o.account?.name ?? "No Account"} · everything below is read from Salesforce and re-validated on the server before each change.</div>
          </div>
          <Badge label={readiness} color={readinessColor} />
        </div>

        {/* ── Lifecycle tracker (derived from Salesforce records) ── */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {state.lifecycle.map((step, i) => {
            const c = step.status === "done" ? "#00C875" : step.status === "current" ? t.accent : step.status === "blocked" ? t.error : t.dim;
            return (
              <div key={step.id} title={step.detail} style={{ flex: "1 1 120px", minWidth: 110, padding: "8px 10px", borderRadius: 10, border: `1px solid ${c}${step.status === "pending" || step.status === "not-required" ? "30" : "60"}`, background: step.status === "current" ? `${c}10` : t.surface }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, fontWeight: 800, color: c }}>
                  <span style={{ display: "inline-flex" }}><Ic n={step.status === "done" ? "check-circle" : step.status === "blocked" ? "alert" : step.status === "current" ? "arrow-right" : "clock"} s={12} /></span>
                  {i + 1}. {step.label}
                </div>
                <div style={{ fontSize: 10.5, color: t.dim, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{step.status === "not-required" ? "Not required" : step.detail}</div>
              </div>
            );
          })}
        </div>

        {/* ── AI (optional; instructions only) ── */}
        <div style={{ borderRadius: 16, padding: 16, border: `1px solid ${t.accent}45`, background: isDark ? "linear-gradient(135deg, rgba(0,212,255,0.08), rgba(30,144,255,0.04))" : "linear-gradient(135deg, rgba(0,152,204,0.07), rgba(9,104,211,0.03))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 800, color: t.heading }}>
            <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="sparkles" s={15} /></span> Plan billing with AI
            <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, border: `1px solid ${t.border}`, borderRadius: 999, padding: "1px 8px" }}>OPTIONAL</span>
          </div>
          <div style={{ fontSize: 12, color: t.dim, margin: "4px 0 10px" }}>Describe what to do. The AI only proposes steps — names are matched to this order&apos;s real Salesforce records and you run each step yourself, through the same validation as the buttons.</div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void analyze(); }} rows={2}
              placeholder={`e.g. "Bill ${state.accountContacts[0]?.name ?? "the account contact"}, set up billing, activate the order and generate the invoice."`} style={{ ...inputStyle(t), flex: "1 1 380px", resize: "vertical", fontSize: 13.5 }} />
            <PrimaryButton label={busy === "ai" ? "Analyzing…" : "Analyze"} icon="sparkles" isDark={isDark} disabled={!prompt.trim() || !!busy} onClick={analyze} />
          </div>
          {ai && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              {ai.summary && <div style={{ fontSize: 12.5, color: t.body }}>{ai.summary}</div>}
              {ai.steps.map((s, i) => (
                <div key={s.action} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 10, border: `1px solid ${s.available ? "rgba(0,200,117,0.4)" : t.border}`, background: t.surface, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: t.heading, minWidth: 18 }}>{i + 1}.</span>
                  <span style={{ flex: "1 1 220px", fontSize: 12.5, fontWeight: 700, color: t.heading }}>{s.label}
                    <span style={{ display: "block", fontSize: 11, fontWeight: 500, color: s.available ? t.dim : t.warn }}>{s.reason}{s.contact ? ` · Contact: ${s.contact.name}` : ""}{typeof s.addressSuggestion === "number" ? ` · Address: ${state.addressSuggestions[s.addressSuggestion]?.source}` : ""}</span>
                  </span>
                  <GhostButton label={s.action === "billing-details" ? "Review" : "Run"} icon={s.action === "billing-details" ? "eye" : "rocket"} isDark={isDark} disabled={!s.available || !!busy} onClick={() => runPlanStep(s.action)} />
                </div>
              ))}
              {[...ai.warnings, ...ai.ignored.map(x => `Ignored unsupported action "${x}".`)].map((w, i) => <div key={i} style={{ fontSize: 12, color: t.warn }}>⚠ {w}</div>)}
            </div>
          )}
          <div style={{ marginTop: 10 }}><PromptGuide isDark={isDark} config={billingPromptGuides.orderSetup} onUseExample={setPrompt} /></div>
        </div>

        {error && <ErrorPanel isDark={isDark} error={error} />}
        {notice && <div style={{ fontSize: 12.5, color: notice.tone === "ok" ? "#00C875" : t.warn, fontWeight: 600, padding: "8px 12px", borderRadius: 10, border: `1px solid ${notice.tone === "ok" ? "rgba(0,200,117,0.4)" : t.warn + "55"}`, background: notice.tone === "ok" ? "rgba(0,200,117,0.06)" : `${t.warn}0c` }}>{notice.tone === "ok" ? "✓ " : "⚠ "}{notice.text}</div>}

        {/* ── 1. Order ── */}
        <Panel isDark={isDark} title="Order" icon="shopping-cart" right={<GhostButton label="View Order" icon="eye" isDark={isDark} onClick={() => onOpenOrder(o.id)} />}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 8 }}>
            <Row isDark={isDark} label="Order Number">{o.number}</Row>
            <Row isDark={isDark} label="Status"><StatusPill status={o.status} isDark={isDark} /></Row>
            <Row isDark={isDark} label="Account">{o.account?.name ?? <span style={{ color: t.error }}>None</span>}</Row>
            <Row isDark={isDark} label="Effective Date">{o.effectiveDate ?? "—"}</Row>
            <Row isDark={isDark} label="Order Total">{money(o.totalAmount, o.currency)}</Row>
            <Row isDark={isDark} label="Order Products">{state.items.length}</Row>
            <Row isDark={isDark} label="Salesforce ID"><code style={{ fontWeight: 500 }}>{o.id}</code></Row>
          </div>
        </Panel>

        {/* ── 2. Billing details (Bill To + addresses, required by Salesforce's schedule action) ── */}
        {o.billToSupported && (
          <div id="order-billing-details" style={{ scrollMarginTop: 12 }}>
            <Panel isDark={isDark} title="Billing Details" icon="user" right={detailsComplete ? <Badge label="COMPLETE" color="#00C875" /> : <Badge label="ACTION REQUIRED" color={t.warn} />}>
              <SectionNote isDark={isDark}>Salesforce&apos;s billing schedule action for this order requires a Bill To Contact, a Billing Address and a Shipping Address. Only Contacts of {o.account?.name ?? "the order's Account"} can be chosen; suggested addresses come from existing Salesforce records and are applied only when you save.</SectionNote>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 800, color: t.heading, maxWidth: 420 }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>Bill To Contact {o.billToContact ? <Badge label="SET IN SALESFORCE" color="#00C875" /> : <Badge label="MISSING" color={t.warn} />}</span>
                  <select value={contactDraft ?? o.billToContact?.id ?? ""} onChange={e => setContactDraft(e.target.value || null)} style={{ ...inputStyle(t), fontSize: 13 }}>
                    <option value="">{state.accountContacts.length ? "Choose a Contact…" : "No Contacts on this Account"}</option>
                    {state.accountContacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.email ? ` — ${c.email}` : ""}</option>)}
                  </select>
                </label>
                {addressEditor("billing")}
                {addressEditor("shipping")}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <PrimaryButton label={btn("details", "Save Billing Details", "Saving…")} icon="check" isDark={isDark} disabled={!detailsDirty || !!busy} onClick={saveDetails} />
                  {detailsDirty && <GhostButton label="Discard changes" icon="x" isDark={isDark} onClick={() => { setContactDraft(null); setBillingDraft(null); setShippingDraft(null); }} />}
                </div>
              </div>
            </Panel>
          </div>
        )}

        {/* ── 3. Billing configuration per Order Product ── */}
        <Panel isDark={isDark} title="Billing Configuration" icon="shield">
          {state.items.length === 0 && <SectionNote isDark={isDark} tone="error">✗ The Order has no Order Products — add products in the Orders module first.</SectionNote>}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {state.items.map(item => (
              <div key={item.id} style={{ padding: 12, borderRadius: 12, border: `1px solid ${itemColor(item.status, t)}40`, background: t.surface }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: t.heading }}>{item.product?.name ?? "Order Product"}</span>
                  {item.product?.code && <span style={{ fontSize: 11, color: t.dim }}>{item.product.code}</span>}
                  <Badge label={item.status.replace("_", " ")} color={itemColor(item.status, t)} />
                  <span style={{ marginLeft: "auto", fontSize: 11.5, color: t.dim }}>Qty {item.quantity ?? "—"} · {money(item.totalPrice, o.currency)} · {item.billingModel}{item.billingFrequency ? ` · ${item.billingFrequency}` : ""}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {([["Product", item.product?.name ?? null, null], ["Billing Policy", item.policy?.name ?? null, item.policy?.id ?? null], ["Default Treatment", item.policy?.defaultTreatment?.name ?? null, null], ["Treatment Item", item.policy?.items.map(i => i.name).join(", ") || null, null]] as const).map(([k, v, link], i) => (
                    <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {i > 0 && <span style={{ color: t.dim, display: "inline-flex" }}><Ic n="arrow-right" s={12} /></span>}
                      <button type="button" disabled={!link} onClick={() => link && onOpenPolicy(link)} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", padding: "6px 10px", borderRadius: 10, border: `1px solid ${v ? "rgba(0,200,117,0.45)" : t.error + "60"}`, background: v ? "rgba(0,200,117,0.07)" : `${t.error}0c`, cursor: link ? "pointer" : "default" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: t.dim }}>{k}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: v ? t.heading : t.error }}>{v ?? "missing"}</span>
                      </button>
                    </span>
                  ))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 6, marginTop: 8, fontSize: 11.5, color: t.body }}>
                  <span>Order Product Billing Treatment: <strong style={{ color: t.heading }}>{item.treatment.current?.name ?? (item.treatment.state === "will-set" ? `— (will set ${item.treatment.expected?.name})` : "—")}</strong></span>
                  <span>Order Product Tax Treatment: <strong style={{ color: item.tax.state === "will-set" && o.activated ? t.error : t.heading }}>{item.tax.current?.name ?? (item.tax.state === "will-set" ? (o.activated ? `missing (expected ${item.tax.expected?.name})` : `— (will set ${item.tax.expected?.name})`) : item.tax.state === "unavailable" ? "not checked" : "—")}</strong></span>
                  <span>Product Selling Model: <strong style={{ color: t.heading }}>{item.sellingModel?.name ?? "—"}</strong></span>
                  <span>Order Action: <strong style={{ color: t.heading }}>{item.orderAction ? `${item.orderAction.name} (${item.orderAction.type})` : "—"}</strong></span>
                  <span>Usage: <strong style={{ color: t.heading }}>{item.usage.required ? item.usage.state : "not required"}</strong></span>
                </div>
                {item.tax.state !== "unavailable" && <TaxDiagnostics item={item} order={o} orderLegalEntityId={state.legalEntityId} schedules={state.schedules.filter(s => s.orderItemId === item.id)} isDark={isDark} onChanged={refresh} />}
                {item.issues.map((x, i) => <div key={i} style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: x.severity === "error" ? t.error : x.severity === "warning" ? t.warn : t.dim }}>{x.severity === "error" ? "✗" : "⚠"} {x.message}</div>)}
                {!item.policy && item.product && !o.activated && <div style={{ marginTop: 8 }}><GhostButton label="Assign Billing Policy" icon="link" isDark={isDark} onClick={() => onAssignPolicy(item.product!.id)} /></div>}
              </div>
            ))}
          </div>
        </Panel>

        {/* ── 4. Order Actions ── */}
        <Panel isDark={isDark} title="Order Actions, Billing & Tax Treatments" icon="layers" right={pendingSetup.length ? <Badge label={`${pendingSetup.length} PENDING`} color={t.warn} /> : <Badge label="CONFIGURED" color="#00C875" />}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Row isDark={isDark} label="Order Actions in Salesforce">{state.orderActions.length ? state.orderActions.map(a => `${a.name} (${a.type ?? "—"})`).join(", ") : "None yet"}</Row>
            {(pendingSetup.length > 0 || orderLePending) && !o.activated && (
              <>
                <SectionNote isDark={isDark}>Applying will {state.orderActions.some(a => a.type === "Add") ? "link the existing \"Add\" Order Action" : "create one Order Action (Type \"Add\")"} and set the Billing Treatment and Tax Treatment from each product&apos;s Billing and Tax Policy on {pendingSetup.length} Order Product(s), in one all-or-nothing Salesforce transaction. Existing values are never overwritten; re-running never duplicates.</SectionNote>
                <div><PrimaryButton label={btn("setup", "Apply Order Actions, Billing & Tax Treatments", "Applying…")} icon="check" isDark={isDark} disabled={!!busy || state.items.some(i => i.status === "BLOCKED")} onClick={() => void mutate("setup", "setup", { operations: ["order-action", "billing-treatment", "tax-treatment", "billing-start-month", "billing-end-date"] }, "Apply billing setup")} /></div>
              </>
            )}
            {o.activated && <SectionNote isDark={isDark}>The order is activated — Salesforce doesn&apos;t allow changing its Order Products&apos; Order Action, Billing Treatment or Tax Treatment.</SectionNote>}
          </div>
        </Panel>

        {/* ── 5. Usage (only when a product is usage-based) ── */}
        {usageItems.length > 0 && (
          <Panel isDark={isDark} title="Usage Configuration" icon="activity">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {usageItems.map(i => (
                <div key={i.id} style={{ fontSize: 12.5, color: t.body }}>
                  <strong style={{ color: t.heading }}>{i.product?.name}</strong> — {i.usage.reason}
                  {i.usage.entitlements.length > 0 && <div style={{ fontSize: 11.5, color: t.dim }}>Entitlements: {i.usage.entitlements.map(e => `${e.name}${e.resource ? ` (${e.resource})` : ""}`).join(", ")}</div>}
                </div>
              ))}
              <SectionNote isDark={isDark}>Usage entitlements are generated by Salesforce on activation — they are never created by this app.</SectionNote>
            </div>
          </Panel>
        )}

        {/* ── 6. Readiness ── */}
        <Panel isDark={isDark} title="Billing Readiness" icon="check-circle" right={<Badge label={readiness} color={readinessColor} />}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 6 }}>
            {state.readiness.checks.map(ch => (
              <div key={ch.id} title={ch.detail} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, color: t.body, padding: "6px 9px", borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}` }}>
                <span style={{ color: checkColor(ch.status), display: "inline-flex" }}><Ic n={ch.status === "passed" ? "check-circle" : "alert"} s={13} /></span>
                <span style={{ flex: 1 }}>{ch.label}<span style={{ display: "block", fontSize: 10.5, color: t.dim }}>{ch.detail}</span></span>
              </div>
            ))}
          </div>
          {state.readiness.taxStatus !== "NOT_APPLICABLE" && <div style={{ marginTop: 8, fontSize: 12, color: state.readiness.taxStatus === "READY" ? "#00C875" : t.error, fontWeight: 700 }}>Tax readiness: {state.readiness.taxStatus.replace(/_/g, " ")}</div>}
          {state.readiness.blockerDetails.length
            ? state.readiness.blockerDetails.map((b, i) => <div key={i} style={{ marginTop: 8, fontSize: 12.5, color: t.error, fontWeight: 600 }}>✗ <span style={{ fontSize: 10.5, fontWeight: 800, padding: "1px 6px", borderRadius: 6, border: `1px solid ${t.error}60`, marginRight: 6 }}>{b.category.replace(/_/g, " ")}</span>{b.product ? `${b.product}: ` : ""}{b.message}</div>)
            : state.readiness.blockers.map((b, i) => <div key={i} style={{ marginTop: 8, fontSize: 12.5, color: t.error, fontWeight: 600 }}>✗ {b}</div>)}
          {state.scheduleTaxError && <div style={{ marginTop: 8, fontSize: 12, color: t.warn, fontWeight: 600 }}>⚠ The billing schedules&apos; tax treatments couldn&apos;t be read: {state.scheduleTaxError}</div>}
        </Panel>

        {/* ── 7. Activation ── */}
        <Panel isDark={isDark} title="Activation" icon="zap" right={o.activated ? <Badge label="ACTIVATED" color="#00C875" /> : null}>
          {o.activated
            ? <SectionNote isDark={isDark} tone="ok">✓ Order {o.number} is activated in Salesforce.</SectionNote>
            : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <SectionNote isDark={isDark} tone={state.readiness.ready ? "ok" : "warn"}>{state.readiness.ready ? "✓ All readiness checks passed. Activation is re-validated on the server immediately before it runs." : "Complete the pending steps above — activation stays disabled until every readiness check passes."}</SectionNote>
                <div><PrimaryButton label={btn("activate", "Activate Order & Start Billing", "Activating…")} icon="zap" isDark={isDark} disabled={!state.readiness.ready || !!busy} onClick={() => setModal("activate")} /></div>
              </div>
            )}
        </Panel>

        {/* ── 8. Billing Schedules ── */}
        <Panel isDark={isDark} title="Billing Schedule" icon="calendar" right={<GhostButton label="Refresh Billing Status" icon="refresh" isDark={isDark} disabled={!!busy} onClick={refresh} />}>
          {!o.activated && <SectionNote isDark={isDark}>Billing schedules are created after the order is activated.</SectionNote>}
          {o.activated && !state.schedules.length && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <SectionNote isDark={isDark} tone={state.scheduleCreation.available ? "dim" : "warn"}>{runningJobs.length ? `⏳ Salesforce is processing: ${runningJobs.map(j => `${j.number ?? "job"} (${j.status})`).join(", ")}. Use Refresh Billing Status.` : state.scheduleCreation.reason}</SectionNote>
              {state.scheduleCreation.available && <div><PrimaryButton label={btn("schedules", "Create Billing Schedules", "Requesting…")} icon="calendar" isDark={isDark} disabled={!!busy} onClick={() => void mutate("schedules", "schedules", {}, "Create Billing Schedules")} /></div>}
              <SectionNote isDark={isDark}>Runs Salesforce&apos;s standard &ldquo;Create Billing Schedules from Billing Transaction&rdquo; action for this order. Salesforce creates the schedules asynchronously — nothing is shown until Salesforce has created them.</SectionNote>
            </div>
          )}
          {state.schedules.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>{["Schedule", "Product", "Status", "Term", "Start", "Next Billing", "Amount", "Invoiced", ""].map(h => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: t.dim, fontSize: 10.5, textTransform: "uppercase", borderBottom: `1px solid ${t.border}` }}>{h}</th>)}</tr></thead>
                <tbody>
                  {state.schedules.map(s => (
                    <tr key={s.id} style={{ borderBottom: `1px solid ${t.border}` }}>
                      <td style={{ padding: "6px 8px", fontWeight: 700, color: t.heading }}>{s.number}</td>
                      <td style={{ padding: "6px 8px" }}>{s.product ?? "—"}</td>
                      <td style={{ padding: "6px 8px" }}><StatusPill status={s.status} isDark={isDark} /></td>
                      <td style={{ padding: "6px 8px" }}>{s.term ?? "—"}</td>
                      <td style={{ padding: "6px 8px" }}>{s.start ?? "—"}</td>
                      <td style={{ padding: "6px 8px" }}>{s.nextBillingDate ?? "—"}</td>
                      <td style={{ padding: "6px 8px" }}>{money(s.amount, o.currency)}</td>
                      <td style={{ padding: "6px 8px" }}>{s.invoiced ? "Yes" : "No"}</td>
                      <td style={{ padding: "6px 8px" }}><GhostButton label="View" icon="eye" isDark={isDark} onClick={() => onOpenSchedule(s.id)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {processingSchedules.length > 0 && <div style={{ marginTop: 8 }}><SectionNote isDark={isDark} tone="warn">⏳ Salesforce is processing {processingSchedules.length} schedule(s). Use Refresh Billing Status.</SectionNote></div>}
            </div>
          )}
        </Panel>

        {/* ── 9. Invoice ── */}
        <Panel isDark={isDark} title="Invoice" icon="file-text">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {!state.schedules.length && <SectionNote isDark={isDark}>Invoices are generated from the order&apos;s billing schedules.</SectionNote>}
            {readySchedules.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <SectionNote isDark={isDark}>{readySchedules.length} schedule(s) ready for invoicing ({money(readySchedules.reduce((a, s) => a + (s.amount ?? 0), 0), o.currency)}). Salesforce&apos;s invoicing API creates a Draft invoice.</SectionNote>
                <PrimaryButton label={btn("invoice", "Generate Invoice", "Generating…")} icon="file-text" isDark={isDark} disabled={!!busy} onClick={() => void mutate("invoice", "invoices", {}, "Generate Invoice")} />
              </div>
            )}
            {state.invoices.map(inv => (
              <div key={inv.id} style={{ padding: 12, borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: t.heading }}>{inv.number ?? "Invoice"}</span>
                  <StatusPill status={inv.status} isDark={isDark} />
                  <span style={{ marginLeft: "auto", fontSize: 12, color: t.body }}>Total {money(inv.amount, o.currency)} · Balance {money(inv.balance, o.currency)} · {inv.invoiceDate ?? "—"}</span>
                </div>
                {inv.tax && (
                  <div style={{ fontSize: 12, color: t.body, padding: "8px 10px", borderRadius: 10, background: t.surfaceAlt, border: `1px solid ${/^VERIFIED/.test(inv.tax.state) ? "rgba(0,200,117,0.45)" : t.error + "60"}` }}>
                    <strong style={{ color: /^VERIFIED/.test(inv.tax.state) ? "#00C875" : t.error }}>Salesforce invoice tax: {inv.tax.state.replace(/_/g, " ")}</strong>
                    <span style={{ display: "block", marginTop: 2 }}>Tax {money(inv.tax.totalTax, o.currency)} · Total with tax {money(inv.tax.totalWithTax, o.currency)} · InvoiceLineTax: {inv.tax.invoiceLineTax.length ? inv.tax.invoiceLineTax.map(x => `${x.id} ${x.code ?? "—"} ${x.rate ?? "?"}% = ${x.amount ?? "—"}`).join(" · ") : "none"}</span>
                    <span style={{ display: "block", marginTop: 2, color: t.dim }}>{inv.tax.message}</span>
                    {/^draft$/i.test(inv.status ?? "") && !/^VERIFIED/.test(inv.tax.state) && <span style={{ display: "block", marginTop: 2, color: t.error, fontWeight: 600 }}>Posting is blocked until Salesforce&apos;s tax is verified.</span>}
                    {/^draft$/i.test(inv.status ?? "") && !/^VERIFIED/.test(inv.tax.state) && <div style={{ marginTop: 8 }}><InvoiceTaxRecalcStep isDark={isDark} invoiceId={inv.id} onDone={refresh} /></div>}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <GhostButton label="View Invoice" icon="eye" isDark={isDark} onClick={() => onOpenInvoice(inv.id)} />
                  <GhostButton label="View Order" icon="shopping-cart" isDark={isDark} onClick={() => onOpenOrder(o.id)} />
                  {inv.scheduleIds[0] && <GhostButton label="View Billing Schedule" icon="calendar" isDark={isDark} onClick={() => onOpenSchedule(inv.scheduleIds[0])} />}
                  {/^draft$/i.test(inv.status ?? "") && <PrimaryButton label={btn("post", "Post Invoice", "Posting…")} icon="send" isDark={isDark} disabled={!!busy || !invoicePostable(inv)} onClick={() => { setPostTargetId(inv.id); setModal("post"); }} />}
                </div>
                {/posted/i.test(inv.status ?? "") && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", paddingTop: 8, borderTop: `1px solid ${t.border}` }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: t.dim, textTransform: "uppercase" }}>Next</span>
                    <GhostButton label="Settle Payment" icon="check-circle" isDark={isDark} onClick={() => onOpenPayments(inv.id, "settle")} />
                    <GhostButton label="Record Payment" icon="credit-card" isDark={isDark} onClick={() => onOpenPayments(inv.id)} />
                    <GhostButton label="Create Credit Memo" icon="file-text" isDark={isDark} onClick={() => onOpenPayments(inv.id, "credit")} />
                    <GhostButton label="View Payments" icon="list" isDark={isDark} onClick={() => onOpenPayments()} />
                    <GhostButton label="Credit Memo (in Salesforce)" icon="external-link" isDark={isDark} onClick={() => window.open(inv.salesforceUrl, "_blank", "noopener")} />
                    <span title="This org has no Debit Memo object." style={{ fontSize: 11.5, color: t.dim }}>Debit Memo — not available in this org</span>
                  </div>
                )}
              </div>
            ))}
            {postingInvoice && <SectionNote isDark={isDark} tone="warn">⏳ Salesforce is posting {postingInvoice.number}. Use Refresh Billing Status.</SectionNote>}
          </div>
        </Panel>

        <div>
          <GhostButton label={showTechnical ? "Hide technical details" : "Show technical details"} icon="terminal" isDark={isDark} onClick={() => setShowTechnical(v => !v)} />
          {showTechnical && <div style={{ marginTop: 8 }}><CodeBlock open isDark={isDark} data={{ fields: state.fields, stateToken: state.stateToken, jobs: state.jobs, ai }} /></div>}
        </div>
      </div>

      <AnimatePresence>
        {modal === "activate" && (
          <Modal isDark={isDark} title="Activate Order & Start Billing" tone="accent" actions={<>
            <GhostButton label="Cancel" isDark={isDark} onClick={() => setModal(null)} />
            <PrimaryButton label="Activate Order" icon="zap" isDark={isDark} onClick={activate} />
          </>}>
            <Row isDark={isDark} label="Order">{o.number} · {o.account?.name}</Row>
            <Row isDark={isDark} label="Order Total">{money(o.totalAmount, o.currency)}</Row>
            <Row isDark={isDark} label="Bill To">{o.billToContact?.name ?? "—"}</Row>
            <Row isDark={isDark} label="Billing Address">{addressText(o.billingAddress) || "—"}</Row>
            {state.items.map(i => <Row key={i.id} isDark={isDark} label={i.product?.name ?? "Order Product"}>{i.billingModel} · {i.treatment.current?.name ?? "—"}</Row>)}
            <div style={{ fontSize: 12, color: t.warn, fontWeight: 600 }}>Activation is permanent: Salesforce doesn&apos;t allow an activated order&apos;s products to be changed. Readiness is re-checked on the server first; if anything changed, nothing is activated.</div>
          </Modal>
        )}
        {modal === "post" && postTarget && (
          <Modal isDark={isDark} title="Post Invoice" tone="accent" actions={<>
            <GhostButton label="Cancel" isDark={isDark} onClick={() => { setModal(null); setPostTargetId(null); }} />
            <PrimaryButton label="Post Invoice" icon="send" isDark={isDark} disabled={!!busy} onClick={() => void postInvoice(postTarget.id)} />
          </>}>
            <Row isDark={isDark} label="Invoice">{postTarget.number} · Salesforce status: {postTarget.status ?? "—"}</Row>
            <Row isDark={isDark} label="Total">{money(postTarget.amount, o.currency)}</Row>
            <Row isDark={isDark} label="Bill To">{o.billToContact?.name ?? "—"}</Row>
            <div style={{ fontSize: 12, color: t.warn, fontWeight: 600 }}>A posted invoice can&apos;t be edited — corrections are made with credit memos in Salesforce.</div>
          </Modal>
        )}
      </AnimatePresence>
    </PageShell>
  );
}


/**
 * Per-order-product tax diagnostics — LOCAL pre-validation from Salesforce's records (the rate the decision table's dimensions
 * select is resolved by the app; it is not Salesforce's invoice-time result, which is shown on the invoice).
 */
function TaxDiagnostics({ item, order, orderLegalEntityId, schedules, isDark, onChanged }: { item: OrderBillingItem; order: OrderBillingState["order"]; orderLegalEntityId: string | null; schedules: OrderBillingState["schedules"]; isDark: boolean; onChanged: () => void }) {
  const t = tokens(isDark);
  const e = item.tax.effective;
  const has = (code: string) => item.tax.issues.some(i => i.code === code);
  const r = e?.rate ?? null;
  const row = (k: string, v: ReactNode, bad = false) => <span key={k}>{k}: <strong style={{ color: bad ? t.error : t.heading }}>{v}</strong></span>;
  return (
    <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 10, border: `1px dashed ${t.border}`, background: t.surfaceAlt }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", color: t.dim, marginBottom: 4 }}>Tax diagnostics — local pre-validation (not Salesforce&apos;s invoice-time result)</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 4, fontSize: 11.5, color: t.body }}>
        {row("Product", item.product ? `${item.product.name} · ${item.product.id} · ${item.product.code ?? "no code"}` : "—", !item.product)}
        {row("Tax Policy", item.tax.policy ? `${item.tax.policy.name} (${item.tax.policy.selection ?? "—"}, ${item.tax.policy.status ?? "—"}) · ${item.tax.policy.id}` : "none")}
        {row("Tax Treatment", e ? `${e.treatmentName ?? e.treatmentId} · ${e.treatmentId} · ${e.taxable ? "taxable" : "NOT taxable"}` : "none", !e || !e.taxable)}
        {row("Treatment Legal Entity", e?.legalEntityId ?? "missing", !!e?.taxable && !e?.legalEntityId)}
        {row("Tax Engine", e?.engineId ? `${e.engineName ?? e.engineId} · ${e.engineId}` : "—", !!e?.taxable && !e?.engineId)}
        {row("Decision Table", e?.decisionTable ? `${e.decisionTable.name} · ${e.decisionTable.id} (${e.decisionTable.source})` : "—", !!e?.taxable && !e?.decisionTable)}
        {e?.item !== undefined && row("Treatment Item", e?.item ? `tax code ${e.item.taxCode ?? "—"} · product code ${e.item.productCode ?? "—"}` : "missing", !e?.item)}
        {row("Tax Rate", r ? `${r.name} · ${r.id} · ${r.rate ?? "?"}% · ${r.usage ?? "—"} / ${r.basis ?? "—"}` : e?.taxable ? "no matching rate" : "—", !!e?.taxable && !r)}
        {r && row("Rate dimensions", `tax code ${r.taxCode ?? "any"} · product code ${r.productCode ?? "any"} · ${r.countryIso ?? "any"}/${r.stateIso ?? "any"} · LE ${r.legalEntityId ?? "any"} · ${r.start ?? "…"} → ${r.end ?? "open"}`)}
        {row("PricebookEntry / Selling Model", `${item.pricebookEntryId ?? "—"} · ${item.sellingModel?.name ?? "none"}`, !item.sellingModel)}
        {row("OrderItem.TaxTreatmentId", item.tax.current ? `${item.tax.current.name} · ${item.tax.current.id}` : order.activated ? "blank (fallback billed)" : "blank", !item.tax.current && order.activated)}
        {row("OrderItem / Order Legal Entity", `${item.legalEntityId ?? "—"} / ${orderLegalEntityId ?? "—"}`)}
        {schedules.map(s => row(`Schedule ${s.number}`, s.taxTreatment ? `${s.taxTreatment.name} · ${s.taxTreatment.id}` : "no tax treatment", !!item.tax.current && s.taxTreatment?.id?.slice(0, 15) !== item.tax.current.id.slice(0, 15)))}
      </div>
      {e?.engineId && has("TAX_ENGINE_DECISION_TABLE_MISSING") && <div style={{ marginTop: 8 }}><AssignDecisionTableStep isDark={isDark} engineId={e.engineId} onDone={onChanged} /></div>}
      {e?.engineId && has("TAX_DECISION_TABLE_STALE") && <div style={{ marginTop: 8 }}><RefreshStep isDark={isDark} engineId={e.engineId} onDone={onChanged} /></div>}
    </div>
  );
}

type PostableInvoice = { status: string | null; tax?: { state: string } | null };
/** A Draft invoice whose Salesforce tax is verified (or not read yet — the server re-verifies before posting). Posted, In Progress etc. are never postable. */
export function invoicePostable(inv: PostableInvoice): boolean {
  return /^draft$/i.test(inv.status ?? "") && (!inv.tax || /^VERIFIED/.test(inv.tax.state));
}

/**
 * A 404 whose body wasn't JSON came from this app's server (its API route wasn't found — e.g. a stale dev-server route cache),
 * not from Salesforce: every app route and every Salesforce error returns JSON. Say so instead of a bare "status 404".
 */
export function withAppRouteDiagnosis<T extends { status?: number | null; raw?: unknown; message: string; possibleCause?: string | null }>(panel: T, route: string): T {
  if (panel.status !== 404 || (panel.raw !== null && panel.raw !== undefined)) return panel;
  return { ...panel, message: `The app's API route ${route} returned HTTP 404 (not JSON) — the request never reached Salesforce.`, possibleCause: "The running Next.js server doesn't have this route registered. Restart the dev server (if it persists, stop it, delete .next/dev and start it again)." };
}
