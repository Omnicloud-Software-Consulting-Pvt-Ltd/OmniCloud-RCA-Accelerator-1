"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, PrimaryButton, GhostButton, PageShell, FooterBar, Spinner, ErrorPanel, CodeBlock } from "@/components/data/quotes/shared";
import ReferenceLookup from "@/components/data/shared/ReferenceLookup";
import { BILLING_SEARCH_ENDPOINT } from "@/components/data/billing/BillingFieldInput";
import { Panel, StatusPill, Modal, Row, LoadingRow, StatTile, useBillingData } from "@/components/data/billing/billingUi";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiGet, quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import type { PaymentAiResult, PaymentDetail, PaymentInvoice, PaymentListResponse, PaymentModel, PaymentPreview } from "@/lib/billing/server/payments";
import { WarningsDisclosure } from "@/components/ui/Disclosure";
import PromptGuide from "@/components/ai/PromptGuide";
import { billingPromptGuides } from "@/lib/ai/promptGuides/billing";

export type PaymentsView = { mode: "dashboard" } | { mode: "record"; invoiceId?: string | null } | { mode: "settle"; invoiceId?: string | null; paymentId?: string | null } | { mode: "detail"; id: string };

interface Nav {
  onNavigate: (view: PaymentsView) => void;
  onOpenInvoice: (invoiceId: string) => void;
  onOpenOrder: (orderId: string) => void;
  onOpenSchedule: (scheduleId: string) => void;
}

const money = (n: number | null | undefined, currency?: string | null) => (n === null || n === undefined ? "—" : `${currency ? `${currency} ` : ""}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : "—");
const todayIso = () => new Date().toISOString().slice(0, 10);
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

function Capabilities({ isDark, model }: { isDark: boolean; model: PaymentModel }) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 6 }}>
      {model.capabilities.map(c => (
        <div key={c.id} title={c.detail} style={{ display: "flex", alignItems: "flex-start", gap: 7, fontSize: 11.5, color: t.body, padding: "6px 9px", borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}` }}>
          <span style={{ color: c.available ? "#00C875" : t.warn, display: "inline-flex", marginTop: 1 }}><Ic n={c.available ? "check-circle" : "alert"} s={13} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>{c.label} — <strong style={{ color: c.available ? "#00C875" : t.warn }}>{c.available ? "Available" : "Not available in this Salesforce org"}</strong>
            <span style={{ display: "block", fontSize: 10.5, color: t.dim, overflowWrap: "anywhere" }}>{c.detail}</span></span>
        </div>
      ))}
    </div>
  );
}

function PermissionNote({ isDark, model }: { isDark: boolean; model: PaymentModel }) {
  const t = tokens(isDark);
  const apply = model.capabilities.find(c => c.id === "apply");
  const missing = model.permissions.filter(p => !p.assigned);
  if (apply?.available || !missing.length) return null;
  return (
    <div style={{ fontSize: 12, color: t.warn, fontWeight: 600, padding: "8px 12px", borderRadius: 10, border: `1px solid ${t.warn}55`, background: `${t.warn}0c` }}>
      ⚠ Salesforce refused to apply payments for your user. This org has payment permission sets you don&apos;t have: {missing.map(p => `${p.label} (${p.name})`).join(", ")}. Ask a Salesforce admin to assign them (with their permission set licence) — new payments are blocked until then, so no unapplied payments are created.
    </div>
  );
}

/* ───────────────────────── Dashboard + history ───────────────────────── */

function PaymentsDashboard({ isDark, nav }: { isDark: boolean; nav: Nav }) {
  const t = tokens(isDark);
  const model = useBillingData<PaymentModel>("Discover payment model", "/api/billing/payments/model");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [account, setAccount] = useState<{ id: string; name: string } | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState("created");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const h = setTimeout(() => setDebounced(search.trim()), 350); return () => clearTimeout(h); }, [search]);
  const qs = new URLSearchParams({ page: String(page), pageSize: "20", sort, dir, ...(debounced ? { search: debounced } : {}), ...(status ? { status } : {}), ...(account ? { accountId: account.id } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
  const list = useBillingData<PaymentListResponse>("Load payments", `/api/billing/payments?${qs.toString()}`);
  const data = list.data;
  const m = model.data;
  const statusColor = (s: string) => (/processed/i.test(s) ? "#00C875" : /pending|draft/i.test(s) ? t.warn : /fail|cancel/i.test(s) ? t.error : t.accent);
  const toggleSort = (k: string) => { setPage(1); if (sort === k) setDir(d => (d === "asc" ? "desc" : "asc")); else { setSort(k); setDir("desc"); } };
  const pages = data ? Math.max(1, Math.ceil(data.totalSize / data.pageSize)) : 1;
  const filtered = !!(debounced || status || account || from || to);

  const footer = (
    <FooterBar isDark={isDark}>
      <GhostButton label="Refresh" icon="refresh" isDark={isDark} onClick={() => { list.reload(); model.reload(); }} />
      <div style={{ display: "flex", gap: 8 }}>
        <GhostButton label="Record Payment" icon="plus" isDark={isDark} disabled={!m?.available} onClick={() => nav.onNavigate({ mode: "record" })} />
        <PrimaryButton label="Settle Payment" icon="check-circle" isDark={isDark} disabled={!m} onClick={() => nav.onNavigate({ mode: "settle" })} />
      </div>
    </FooterBar>
  );

  return (
    <PageShell footer={footer}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Payments</div>
          <div style={{ fontSize: 11.5, color: t.dim }}>Salesforce Payment records and their applications to invoices — read live from the connected org.</div>
        </div>
        {model.error && <ErrorPanel isDark={isDark} error={model.error} />}
        {data && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <StatTile isDark={isDark} label={filtered ? "Payments (filtered)" : "Total Payments"} value={String(data.stats.count)} />
            {(data.statusValues.length ? data.statusValues : data.stats.byStatus.map(s => s.status)).map(st => <StatTile key={st} isDark={isDark} label={st} value={String(data.stats.byStatus.find(s => s.status === st)?.count ?? 0)} color={statusColor(st)} />)}
            {data.stats.amount !== null && <StatTile isDark={isDark} label="Total Amount" value={money(data.stats.amount, data.currency)} />}
            {data.stats.applied !== null && <StatTile isDark={isDark} label="Applied Amount" value={money(data.stats.applied, data.currency)} color="#00C875" />}
            {data.stats.unapplied !== null && <StatTile isDark={isDark} label="Unapplied Amount" value={money(data.stats.unapplied, data.currency)} color={t.warn} />}
          </div>
        )}
        {m && <PermissionNote isDark={isDark} model={m} />}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
          <button type="button" onClick={() => nav.onNavigate({ mode: "settle" })} disabled={!m} style={{ textAlign: "left", padding: 14, borderRadius: 14, border: `1px solid ${t.accent}55`, background: `${t.accent}0d`, cursor: "pointer", color: t.body }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: t.heading, display: "flex", gap: 6, alignItems: "center" }}><Ic n="check-circle" s={15} /> Settle Payment</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Guided: pick an eligible invoice, allocate the amount across its lines, create the payment and apply it in Salesforce.</div>
            {m && !m.capabilities.find(c => c.id === "settle")?.available && <div style={{ fontSize: 11.5, marginTop: 6, color: t.warn, fontWeight: 600 }}>⚠ Payment settlement is not currently enabled for this Salesforce user.</div>}
          </button>
          <button type="button" onClick={() => nav.onNavigate({ mode: "record" })} disabled={!m?.available} style={{ textAlign: "left", padding: 14, borderRadius: 14, border: `1px solid ${t.border}`, background: t.surface, cursor: m?.available ? "pointer" : "not-allowed", color: t.body, opacity: m?.available ? 1 : 0.6 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: t.heading, display: "flex", gap: 6, alignItems: "center" }}><Ic n="plus" s={15} /> Record Payment</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Record a Salesforce Payment received against an invoice.</div>
          </button>
        </div>
        {m && <Panel isDark={isDark} title="Org capabilities" icon="database"><Capabilities isDark={isDark} model={m} /></Panel>}

        <Panel isDark={isDark} title="Payment History" icon="list" right={list.loading ? <Spinner isDark={isDark} size={13} /> : null}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8, marginBottom: 12 }}>
            <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search payment number or account…" style={{ ...inputStyle(t), fontSize: 12.5 }} />
            <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} style={{ ...inputStyle(t), fontSize: 12.5 }}>
              <option value="">All statuses</option>
              {(data?.statusValues ?? m?.statusValues ?? []).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <ReferenceLookup isDark={isDark} objectType="Account" searchEndpoint={BILLING_SEARCH_ENDPOINT} value={account} onChange={v => { setAccount(v); setPage(1); }} placeholder="Filter by account…" noMatchHint="No matching Account." />
            <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} title="Payment date from" style={{ ...inputStyle(t), fontSize: 12.5 }} />
            <input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} title="Payment date to" style={{ ...inputStyle(t), fontSize: 12.5 }} />
          </div>
          {list.error && <ErrorPanel isDark={isDark} error={list.error} />}
          {!data && !list.error && <LoadingRow isDark={isDark} label="Loading payments from Salesforce…" />}
          {data && data.payments.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 13, color: t.dim }}>{filtered ? "No payments match these filters." : "No payments have been recorded yet."}</div>
              {!filtered && <PrimaryButton label="Record Payment" icon="plus" isDark={isDark} disabled={!m?.available} onClick={() => nav.onNavigate({ mode: "record" })} />}
            </div>
          )}
          {data && data.payments.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>
                  {([["number", "Payment"], ["date", "Date"], ["account", "Account"], [null, "Invoice"], ["amount", "Amount"], [null, "Applied"], [null, "Remaining"], ["status", "Status"], [null, "Method"], ["created", "Created"], [null, ""]] as const).map(([k, h]) => (
                    <th key={h || "actions"} onClick={k ? () => toggleSort(k) : undefined} style={{ textAlign: "left", padding: "6px 8px", color: t.dim, fontSize: 10.5, textTransform: "uppercase", borderBottom: `1px solid ${t.border}`, cursor: k ? "pointer" : "default", whiteSpace: "nowrap" }}>
                      {h}{k && sort === k ? (dir === "asc" ? " ▲" : " ▼") : ""}
                    </th>
                  ))}
                </tr></thead>
                <tbody>
                  {data.payments.map(p => (
                    <tr key={p.id} style={{ borderBottom: `1px solid ${t.border}` }}>
                      <td style={{ padding: "6px 8px", fontWeight: 700, color: t.heading }}>{p.number}</td>
                      <td style={{ padding: "6px 8px" }}>{day(p.date)}</td>
                      <td style={{ padding: "6px 8px" }}>{p.account?.name ?? "—"}</td>
                      <td style={{ padding: "6px 8px" }}>{p.invoices.map(i => i.number).join(", ") || "—"}</td>
                      <td style={{ padding: "6px 8px" }}>{money(p.amount, data.currency)}</td>
                      <td style={{ padding: "6px 8px" }}>{money(p.applied, data.currency)}</td>
                      <td style={{ padding: "6px 8px" }}>{money(p.balance, data.currency)}</td>
                      <td style={{ padding: "6px 8px" }}><StatusPill status={p.status} isDark={isDark} /></td>
                      <td style={{ padding: "6px 8px" }}>{p.paymentMethod?.name ?? "—"}</td>
                      <td style={{ padding: "6px 8px" }}>{day(p.createdDate)}</td>
                      <td style={{ padding: "6px 8px" }}><GhostButton label="View" icon="eye" isDark={isDark} onClick={() => nav.onNavigate({ mode: "detail", id: p.id })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 10, fontSize: 12, color: t.dim }}>
                <span>{data.totalSize} payment(s) · page {page} of {pages}</span>
                <GhostButton label="Previous" icon="chevron-left" isDark={isDark} disabled={page <= 1} onClick={() => setPage(p => p - 1)} />
                <GhostButton label="Next" icon="chevron-right" isDark={isDark} disabled={page >= pages} onClick={() => setPage(p => p + 1)} />
              </div>
            </div>
          )}
        </Panel>
      </div>
    </PageShell>
  );
}

/* ───────────────────────── Record Payment ───────────────────────── */

/** Salesforce-backed invoice search shared by Record/Settle Payment and Credit Memos (purpose decides eligibility server-side). */
export function InvoicePicker({ isDark, onPick, purpose = "payment" }: { isDark: boolean; onPick: (inv: PaymentInvoice) => void; purpose?: "payment" | "credit" }) {
  const t = tokens(isDark);
  const [term, setTerm] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const h = setTimeout(() => setDebounced(term.trim()), 300); return () => clearTimeout(h); }, [term]);
  const qs = new URLSearchParams({ ...(debounced ? { search: debounced } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(purpose === "credit" ? { purpose } : {}) }).toString();
  const res = useBillingData<{ invoices: PaymentInvoice[]; eligibleStatuses: string[] }>("Search invoices", `/api/billing/payments/invoices${qs ? `?${qs}` : ""}`);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
        <input value={term} onChange={e => setTerm(e.target.value)} placeholder="Search by invoice number, account or order number…" style={{ ...inputStyle(t), fontSize: 13 }} />
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} title="Invoice date from" style={{ ...inputStyle(t), fontSize: 13 }} />
        <input type="date" value={to} onChange={e => setTo(e.target.value)} title="Invoice date to" style={{ ...inputStyle(t), fontSize: 13 }} />
      </div>
      {res.error && <ErrorPanel isDark={isDark} error={res.error} />}
      {res.loading && !res.data && <LoadingRow isDark={isDark} label="Searching Salesforce invoices…" />}
      {res.data && res.data.invoices.length === 0 && <div style={{ fontSize: 12.5, color: t.dim }}>{debounced ? "No eligible invoice matches." : purpose === "credit" ? "No invoices are currently eligible for a credit memo." : "No invoices are currently eligible for payment."} Eligible: {res.data.eligibleStatuses.join(" / ") || "—"} invoices{purpose === "credit" ? "" : " with an outstanding balance"}.</div>}
      {res.data?.invoices.map(inv => (
        <button key={inv.id} type="button" onClick={() => onPick(inv)} style={{ display: "grid", gridTemplateColumns: "1.2fr 1.4fr 1fr 1fr 1fr", gap: 8, alignItems: "center", textAlign: "left", padding: "8px 10px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, cursor: "pointer", fontSize: 12, color: t.body }}>
          <strong style={{ color: t.heading }}>{inv.number}<span style={{ display: "block", fontSize: 10.5, fontWeight: 500, color: t.dim }}>{inv.invoiceDate ?? ""}{inv.orders.length ? ` · Order ${inv.orders.map(o => o.number).join(", ")}` : ""}</span></strong>
          <span>{inv.account?.name ?? "—"}</span>
          <span>Total {money(inv.total, inv.currency)}</span>
          <span><StatusPill status={inv.status} isDark={isDark} /></span>
          <span style={{ fontWeight: 700, color: t.heading }}>Due {money(inv.balance, inv.currency)}{purpose === "credit" ? <span style={{ display: "block", fontSize: 10.5, fontWeight: 500, color: t.dim }}>Paid {money(inv.paymentsApplied ?? 0)} · Credited {money(inv.creditsApplied ?? 0)}</span> : null}</span>
        </button>
      ))}
    </div>
  );
}

type Done = { payment: PaymentDetail; invoice: PaymentInvoice; message: string; duplicate: boolean; steps: string[] };

function RecordPayment({ isDark, nav, initialInvoiceId }: { isDark: boolean; nav: Nav; initialInvoiceId?: string | null }) {
  const t = tokens(isDark);
  const notify = useSalesforceSuccess();
  const model = useBillingData<PaymentModel>("Discover payment model", "/api/billing/payments/model");
  const prefill = useBillingData<{ invoice: PaymentInvoice }>("Load invoice", initialInvoiceId ? `/api/billing/payments/invoices/${initialInvoiceId}` : null);
  const [picked, setPicked] = useState<PaymentInvoice | null | undefined>(undefined);
  const invoice = picked === undefined ? prefill.data?.invoice ?? null : picked;
  const [amount, setAmount] = useState<string | null>(null);
  const [date, setDate] = useState(todayIso);
  const [methodId, setMethodId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [comments, setComments] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ai, setAi] = useState<PaymentAiResult | null>(null);
  const [preview, setPreview] = useState<{ data: PaymentPreview; key: string } | null>(null);
  const [allowSimilar, setAllowSimilar] = useState(false);
  const [busy, setBusy] = useState<null | "ai" | "review" | "confirm" | "refresh">(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const m = model.data;
  const amountValue = amount ?? (invoice?.balance != null ? String(invoice.balance) : "");
  const statusValue = status ?? m?.defaults.status ?? "";
  const typeValue = type ?? m?.defaults.type ?? "";

  const choose = (inv: PaymentInvoice | null) => { setPicked(inv); setAmount(null); setPreview(null); setNotice(null); setError(null); };

  async function analyze() {
    if (!prompt.trim()) return;
    setBusy("ai"); setError(null);
    try {
      const r = await quoteApiPost<PaymentAiResult>("AI payment", "/api/billing/payments/ai", { prompt });
      setAi(r);
      if (r.invoice) { setPicked(r.invoice); setPreview(null); }
      if (r.amount !== null) setAmount(String(r.amount));
      if (r.paymentDate) setDate(r.paymentDate);
      if (r.paymentMethod) setMethodId(r.paymentMethod.id);
      if (r.comments) setComments(r.comments);
    } catch (err) { setError(toBillingErrorPanel(err, "AI analysis failed")); } finally { setBusy(null); }
  }

  const body = () => ({ invoiceId: invoice?.id, amount: Number(amountValue), paymentDate: date, paymentMethodId: methodId || null, status: statusValue || null, type: typeValue || null, comments: comments || null });

  async function review() {
    if (!invoice) return;
    setBusy("review"); setError(null); setNotice(null); setAllowSimilar(false);
    try {
      const data = await quoteApiPost<PaymentPreview>("Validate payment", "/api/billing/payments/validate", body());
      setPreview({ data, key: newKey() }); // one idempotency key per reviewed payment — a second confirm reuses it
    } catch (err) { setError(toBillingErrorPanel(err, "Couldn't validate the payment")); } finally { setBusy(null); }
  }

  async function refreshInvoice() {
    if (!invoice) return;
    setBusy("refresh");
    try { const r = await quoteApiGet<{ invoice: PaymentInvoice }>("Load invoice", `/api/billing/payments/invoices/${invoice.id}`); choose(r.invoice); } catch (err) { setError(toBillingErrorPanel(err, "Couldn't reload the invoice")); } finally { setBusy(null); }
  }

  async function confirm() {
    if (!preview || !invoice) return;
    setBusy("confirm"); setError(null);
    try {
      const r = await quoteApiPost<Done & { success: true }>("Record payment", "/api/billing/payments", { ...body(), invoiceToken: preview.data.invoice.token, idempotencyKey: preview.key, allowSimilar });
      setDone(r); setPreview(null);
      notify({ title: r.duplicate ? "Payment already recorded" : "Payment recorded", message: r.message, records: [{ objectApiName: "Payment", recordId: r.payment.payment.id, recordName: r.payment.payment.number ?? r.payment.payment.id, salesforceUrl: r.payment.payment.salesforceUrl }] });
    } catch (err) {
      const panel = toBillingErrorPanel(err, "Salesforce didn't record the payment");
      setError(panel);
      const raw = panel.raw as { code?: string; invoice?: PaymentInvoice | null; preview?: PaymentPreview | null } | undefined;
      if (raw?.code === "INVOICE_CHANGED" && raw.invoice) { choose(raw.invoice); setNotice("The invoice balance changed while you were preparing this payment. The latest Salesforce state is shown — review the amount and try again."); }
      else if (raw?.code === "POSSIBLE_DUPLICATE" && raw.preview) setPreview(p => (p ? { ...p, data: raw.preview! } : p));
      else if (raw?.invoice) setPreview(null);
    } finally { setBusy(null); }
  }

  if (done) {
    const p = done.payment.payment;
    return (
      <PageShell>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ borderRadius: 16, padding: 18, border: "1px solid rgba(0,200,117,0.35)", background: "rgba(0,200,117,0.06)" }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>✓ {done.duplicate ? "Payment already exists / has already been applied" : "Payment recorded in Salesforce"}</div>
            <div style={{ fontSize: 12, color: t.dim }}>{done.message} Values below were re-read from Salesforce.</div>
          </div>
          <Panel isDark={isDark} title="Result" icon="credit-card">
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <Row isDark={isDark} label="Payment">{p.number} <StatusPill status={p.status} isDark={isDark} /></Row>
              <Row isDark={isDark} label="Payment Amount">{money(p.amount, done.invoice.currency)}</Row>
              <Row isDark={isDark} label="Applied">{money(p.applied, done.invoice.currency)}</Row>
              <Row isDark={isDark} label="Unapplied (payment)">{money(p.balance, done.invoice.currency)}</Row>
              <Row isDark={isDark} label="Invoice">{done.invoice.number} <StatusPill status={done.invoice.status} isDark={isDark} /></Row>
              <Row isDark={isDark} label="Remaining Invoice Balance">{money(done.invoice.balance, done.invoice.currency)}</Row>
              <Row isDark={isDark} label="Settlement Status">{done.invoice.settlementStatus ?? "—"}</Row>
              <Row isDark={isDark} label="Applications">{done.payment.applications.map(a => `${a.number} ${a.type} ${a.amount}${a.invoiceLine ? ` (${a.invoiceLine.name})` : ""}`).join(" · ") || "—"}</Row>
            </div>
          </Panel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <PrimaryButton label="View Payment" icon="eye" isDark={isDark} onClick={() => nav.onNavigate({ mode: "detail", id: p.id })} />
            <GhostButton label="View Invoice" icon="file-text" isDark={isDark} onClick={() => nav.onOpenInvoice(done.invoice.id)} />
            <GhostButton label="Payments" icon="list" isDark={isDark} onClick={() => nav.onNavigate({ mode: "dashboard" })} />
          </div>
        </div>
      </PageShell>
    );
  }

  const pv = preview?.data;
  const footer = (
    <FooterBar isDark={isDark}>
      <GhostButton label="Cancel" icon="x" isDark={isDark} onClick={() => nav.onNavigate({ mode: "dashboard" })} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {busy && <Spinner isDark={isDark} size={13} />}
        <PrimaryButton label={busy === "review" ? "Validating…" : "Review Payment"} icon="check-circle" isDark={isDark} disabled={!invoice || !m || !!busy || !amountValue} onClick={review} />
      </div>
    </FooterBar>
  );

  return (
    <PageShell footer={footer}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>Record Payment</div>
          <div style={{ fontSize: 11.5, color: t.dim }}>Creates a Salesforce Payment and applies it to the invoice (applyPayment). The invoice is re-read and re-validated on the server before anything is written.</div>
        </div>
        {model.error && <ErrorPanel isDark={isDark} error={model.error} />}
        {m && <PermissionNote isDark={isDark} model={m} />}

        {/* AI (optional) */}
        <div style={{ borderRadius: 16, padding: 16, border: `1px solid ${t.accent}45`, background: isDark ? "linear-gradient(135deg, rgba(0,212,255,0.08), rgba(30,144,255,0.04))" : "linear-gradient(135deg, rgba(0,152,204,0.07), rgba(9,104,211,0.03))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 800, color: t.heading }}>
            <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="sparkles" s={15} /></span> Describe the payment
            <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, border: `1px solid ${t.border}`, borderRadius: 999, padding: "1px 8px" }}>OPTIONAL</span>
          </div>
          <div style={{ fontSize: 12, color: t.dim, margin: "4px 0 10px" }}>The AI only fills this form — the invoice is looked up by its number in Salesforce, and nothing is recorded until you review and confirm.</div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2} placeholder='e.g. "Record a payment of 39.97 against the posted invoice DOC-000000001."' style={{ ...inputStyle(t), flex: "1 1 380px", resize: "vertical", fontSize: 13.5 }} />
            <PrimaryButton label={busy === "ai" ? "Analyzing…" : "Analyze & Fill"} icon="sparkles" isDark={isDark} disabled={!prompt.trim() || !!busy} onClick={analyze} />
          </div>
          {ai && (
            <div style={{ marginTop: 10, fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ color: ai.invoice ? "#00C875" : t.error, fontWeight: 700 }}>{ai.invoice ? `✓ Invoice ${ai.invoice.number} found in Salesforce` : `✗ ${ai.invoiceMessage}`}</span>
              <WarningsDisclosure isDark={isDark} warnings={ai.warnings} />
            </div>
          )}
          <div style={{ marginTop: 10 }}><PromptGuide isDark={isDark} config={billingPromptGuides.recordPayment} onUseExample={setPrompt} /></div>
        </div>

        {error && <ErrorPanel isDark={isDark} error={error} />}
        {notice && <div style={{ fontSize: 12.5, color: t.warn, fontWeight: 600, padding: "8px 12px", borderRadius: 10, border: `1px solid ${t.warn}55`, background: `${t.warn}0c` }}>⚠ {notice}</div>}

        <Panel isDark={isDark} title="Invoice" icon="file-text" right={invoice ? <div style={{ display: "flex", gap: 6 }}><GhostButton label="Refresh" icon="refresh" isDark={isDark} onClick={refreshInvoice} /><GhostButton label="Change" icon="edit" isDark={isDark} onClick={() => choose(null)} /></div> : null}>
          {initialInvoiceId && prefill.loading && picked === undefined && <LoadingRow isDark={isDark} label="Loading the invoice from Salesforce…" />}
          {prefill.error && picked === undefined && <ErrorPanel isDark={isDark} error={prefill.error} />}
          {!invoice && !(initialInvoiceId && prefill.loading && picked === undefined) && <InvoicePicker isDark={isDark} onPick={choose} />}
          {invoice && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8 }}>
              <Row isDark={isDark} label="Invoice">{invoice.number} <StatusPill status={invoice.status} isDark={isDark} /></Row>
              <Row isDark={isDark} label="Account">{invoice.account?.name ?? "—"}</Row>
              <Row isDark={isDark} label="Invoice Amount">{money(invoice.total, invoice.currency)}</Row>
              <Row isDark={isDark} label="Outstanding Balance">{money(invoice.balance, invoice.currency)}</Row>
              <Row isDark={isDark} label="Payments Applied">{money(invoice.paymentsApplied, invoice.currency)}</Row>
              <Row isDark={isDark} label="Settlement">{invoice.settlementStatus ?? "—"}</Row>
              <Row isDark={isDark} label="Due Date">{invoice.dueDate ?? "—"}</Row>
              <Row isDark={isDark} label="Applied to">{invoice.applyTo === "lines" ? "Invoice lines" : "Invoice (per line if Salesforce requires it)"}</Row>
              {!invoice.eligible && <div style={{ gridColumn: "1 / -1", fontSize: 12.5, color: t.error, fontWeight: 600 }}>✗ {invoice.reasons.join(" ")}</div>}
            </div>
          )}
        </Panel>

        {invoice && m && (
          <Panel isDark={isDark} title="Payment" icon="credit-card">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
              <Field t={t} label={`Payment Amount${invoice.currency ? ` (${invoice.currency})` : ""} *`}>
                <input type="number" step="0.01" min="0.01" value={amountValue} onChange={e => { setAmount(e.target.value); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 13 }} />
              </Field>
              <Field t={t} label="Payment Date *"><input type="date" value={date} onChange={e => { setDate(e.target.value); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 13 }} /></Field>
              <Field t={t} label="Payment Method">
                {m.paymentMethods.length ? (
                  <select value={methodId} onChange={e => { setMethodId(e.target.value); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 13 }}>
                    <option value="">None</option>
                    {m.paymentMethods.filter(p => !p.accountId || p.accountId === invoice.account?.id).map(p => <option key={p.id} value={p.id}>{p.name}{p.type ? ` (${p.type})` : ""}</option>)}
                  </select>
                ) : <div style={{ fontSize: 12, color: t.dim, paddingTop: 8 }}>No payment methods are configured in this Salesforce org.</div>}
              </Field>
              <Field t={t} label="Status *">
                <select value={statusValue} onChange={e => { setStatus(e.target.value); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 13 }}>{m.statusValues.map(s => <option key={s} value={s}>{s}</option>)}</select>
              </Field>
              <Field t={t} label="Type *">
                <select value={typeValue} onChange={e => { setType(e.target.value); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 13 }}>{m.typeValues.map(s => <option key={s} value={s}>{s}</option>)}</select>
              </Field>
              <Field t={t} label="Processing Mode"><div style={{ fontSize: 12.5, color: t.heading, paddingTop: 8 }}>{m.defaults.processingMode ?? "—"}{m.gatewayCount ? "" : " (no active payment gateway)"}</div></Field>
              <div style={{ gridColumn: "1 / -1" }}><Field t={t} label="Comments"><input value={comments} onChange={e => setComments(e.target.value)} style={{ ...inputStyle(t), fontSize: 13 }} /></Field></div>
            </div>
          </Panel>
        )}
      </div>

      <AnimatePresence>
        {pv && preview && (
          <Modal isDark={isDark} title="Payment Preview" tone={pv.valid ? "accent" : "warn"} actions={<>
            <GhostButton label="Back to form" isDark={isDark} onClick={() => setPreview(null)} />
            <PrimaryButton label={busy === "confirm" ? "Recording…" : "Confirm & Record Payment"} icon="check" isDark={isDark} disabled={!pv.valid || !m?.available || !!busy || (pv.similar.length > 0 && !allowSimilar)} onClick={confirm} />
          </>}>
            {pv.preview && <>
              <Row isDark={isDark} label="Invoice">{pv.invoice.number}</Row>
              <Row isDark={isDark} label="Account">{pv.preview.account?.name ?? "—"}</Row>
              <Row isDark={isDark} label="Invoice Amount">{money(pv.invoice.total, pv.preview.currency)}</Row>
              <Row isDark={isDark} label="Outstanding">{money(pv.preview.balanceBefore, pv.preview.currency)}</Row>
              <Row isDark={isDark} label="Payment">{money(pv.preview.amount, pv.preview.currency)}{pv.preview.partial ? " (partial)" : ""}</Row>
              <Row isDark={isDark} label="Applied">{pv.preview.allocation.map(a => `${a.label} ${money(a.amount)}`).join(" · ") || "—"}</Row>
              <Row isDark={isDark} label="Payment Date">{pv.preview.paymentDate}</Row>
              <Row isDark={isDark} label="Status / Type">{pv.preview.status} · {pv.preview.type} · {pv.preview.processingMode}</Row>
              <Row isDark={isDark} label="Payment Method">{pv.preview.paymentMethod?.name ?? "None"}</Row>
              <Row isDark={isDark} label="After: Invoice Balance"><span style={{ color: "#00C875" }}>{money(pv.preview.balanceAfter, pv.preview.currency)}</span></Row>
            </>}
            {pv.errors.map((e, i) => <div key={i} style={{ color: t.error, fontWeight: 600 }}>✗ {e}</div>)}
            <WarningsDisclosure isDark={isDark} warnings={pv.warnings} />
            {pv.similar.length > 0 && (
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.warn }}>
                <input type="checkbox" checked={allowSimilar} onChange={e => setAllowSimilar(e.target.checked)} /> This is a separate payment, not a duplicate.
              </label>
            )}
            {m && !m.available && <div style={{ color: t.warn, fontWeight: 600 }}>⚠ Confirming is disabled: payments can&apos;t be applied for your user in this org (see the notice above).</div>}
            <div style={{ fontSize: 11.5, color: t.dim }}>Nothing is written until you confirm. On confirm the server re-reads the invoice; if it changed, nothing is recorded.</div>
          </Modal>
        )}
      </AnimatePresence>
    </PageShell>
  );
}

export function Field({ t, label, children }: { t: ReturnType<typeof tokens>; label: string; children: ReactNode }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: t.dim }}>{label}{children}</label>;
}

/* ───────────────────────── Payment details ───────────────────────── */

function PaymentDetailView({ isDark, nav, id }: { isDark: boolean; nav: Nav; id: string }) {
  const t = tokens(isDark);
  const d = useBillingData<PaymentDetail>("Load payment", `/api/billing/payments/${id}`);
  const [raw, setRaw] = useState(false);
  const data = d.data;
  if (!data) return <div style={{ padding: 20 }}>{d.error ? <ErrorPanel isDark={isDark} error={d.error} /> : <LoadingRow isDark={isDark} label="Loading the payment from Salesforce…" />}</div>;
  const p = data.payment;
  const inv = data.invoices[0] ?? null;
  const canApply = !/cancel/i.test(p.status ?? "") && (p.balance ?? 0) > 0;
  const accountUrl = p.account ? p.salesforceUrl.replace(/\/Payment\/[^/]+\/view$/, `/Account/${p.account.id}/view`) : null;

  return (
    <PageShell>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 19, fontWeight: 800, color: t.heading }}>{p.number}</span><StatusPill status={p.status} isDark={isDark} />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {data.invoices.map(i => <GhostButton key={i.id} label={`View Invoice ${i.number ?? ""}`.trim()} icon="file-text" isDark={isDark} onClick={() => nav.onOpenInvoice(i.id)} />)}
            {data.orders.map(o => <GhostButton key={o.id} label={`View Order ${o.number ?? ""}`.trim()} icon="shopping-cart" isDark={isDark} onClick={() => nav.onOpenOrder(o.id)} />)}
            {data.orders[0]?.scheduleIds[0] && <GhostButton label="View Billing Schedule" icon="calendar" isDark={isDark} onClick={() => nav.onOpenSchedule(data.orders[0].scheduleIds[0])} />}
            {accountUrl && <GhostButton label="View Account" icon="building" isDark={isDark} onClick={() => window.open(accountUrl, "_blank", "noopener")} />}
            <GhostButton label="Refresh" icon="refresh" isDark={isDark} onClick={d.reload} />
            <GhostButton label="Open in Salesforce" icon="external-link" isDark={isDark} onClick={() => window.open(p.salesforceUrl, "_blank", "noopener")} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
          <Panel isDark={isDark} title="Payment" icon="credit-card">
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <Row isDark={isDark} label="Payment Number">{p.number}</Row>
              <Row isDark={isDark} label="Status"><StatusPill status={p.status} isDark={isDark} /></Row>
              <Row isDark={isDark} label="Account">{p.account?.name ?? "—"}</Row>
              <Row isDark={isDark} label="Payment Date">{day(p.date)}</Row>
              <Row isDark={isDark} label="Amount">{money(p.amount, inv?.currency)}</Row>
              <Row isDark={isDark} label="Type / Mode">{p.type ?? "—"} · {p.processingMode ?? "—"}</Row>
              <Row isDark={isDark} label="Payment Method">{p.paymentMethod?.name ?? "—"}</Row>
              {p.comments && <Row isDark={isDark} label="Comments">{p.comments}</Row>}
            </div>
          </Panel>
          <Panel isDark={isDark} title="Application Summary" icon="layers">
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <Row isDark={isDark} label="Amount Applied">{money(p.applied, inv?.currency)}</Row>
              <Row isDark={isDark} label="Remaining (unapplied)">{money(p.balance, inv?.currency)}</Row>
              <Row isDark={isDark} label="Total Unapplied">{money(p.unapplied, inv?.currency)}</Row>
              {data.invoices.map(i => <Row key={i.id} isDark={isDark} label={`Invoice ${i.number}`}>Balance {money(i.balance, i.currency)} · {i.settlementStatus ?? "—"}</Row>)}
            </div>
          </Panel>
        </div>
        {data.applications.length > 0 && (canApply
          ? <div style={{ display: "flex", gap: 10, alignItems: "center" }}><span style={{ fontSize: 12.5, color: t.warn, fontWeight: 600 }}>{money(p.balance, inv?.currency)} of this payment is still unapplied.</span><PrimaryButton label="Settle Payment" icon="check-circle" isDark={isDark} onClick={() => nav.onNavigate({ mode: "settle", paymentId: p.id })} /></div>
          : (p.balance ?? 0) <= 0 && <div style={{ fontSize: 13, color: "#00C875", fontWeight: 800 }}>✓ Fully Applied</div>)}
        <Panel isDark={isDark} title="Payment → Payment Application → Invoice → Invoice Line" icon="link">
          {data.applications.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12.5, color: t.warn }}>This payment isn&apos;t applied to any invoice.</div>
              {canApply && <div><PrimaryButton label="Settle Payment" icon="check-circle" isDark={isDark} onClick={() => nav.onNavigate({ mode: "settle", paymentId: p.id })} /></div>}
              {!canApply && <div style={{ fontSize: 12.5, color: t.dim }}>Status in Salesforce: {p.status}</div>}
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>{["Application", "Level", "Type", "Amount", "Invoice", "Invoice line", "Applied", "Unapplied"].map(h => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: t.dim, fontSize: 10.5, textTransform: "uppercase", borderBottom: `1px solid ${t.border}` }}>{h}</th>)}</tr></thead>
              <tbody>{data.applications.map(a => (
                <tr key={a.id} style={{ borderBottom: `1px solid ${t.border}` }}>
                  <td style={{ padding: "6px 8px", fontWeight: 700, color: t.heading }}>{a.number}</td>
                  <td style={{ padding: "6px 8px" }}>{a.level === "line" ? "PaymentLineInvoiceLine" : "PaymentLineInvoice"}</td>
                  <td style={{ padding: "6px 8px" }}>{a.type}</td>
                  <td style={{ padding: "6px 8px" }}>{money(a.amount)}</td>
                  <td style={{ padding: "6px 8px" }}>{a.invoice ? <button type="button" onClick={() => nav.onOpenInvoice(a.invoice!.id)} style={{ background: "none", border: "none", color: t.accent, fontWeight: 700, cursor: "pointer", padding: 0 }}>{a.invoice.number}</button> : "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{a.invoiceLine?.name ?? "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{day(a.appliedDate)}</td>
                  <td style={{ padding: "6px 8px" }}>{a.hasBeenUnapplied ?? "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Panel>
        <div>
          <GhostButton label={raw ? "Hide all Salesforce fields" : "Show all Salesforce fields"} icon="database" isDark={isDark} onClick={() => setRaw(v => !v)} />
          {raw && <div style={{ marginTop: 8 }}><CodeBlock open isDark={isDark} data={Object.fromEntries(data.fields.map(f => [f.label, f.value]))} /></div>}
        </div>
      </div>
    </PageShell>
  );
}

/* ───────────────────────── Settle Payment ───────────────────────── */

const toCents = (v: string | number) => Math.round(Number(v) * 100);
/** Client-side mirror of the server's auto allocation (line order, never above a line's balance) — the server re-computes/validates. */
function autoAllocate(lines: PaymentInvoice["lines"], amount: number): Record<string, string> {
  let left = toCents(amount);
  const out: Record<string, string> = {};
  for (const l of lines) {
    const take = Math.max(0, Math.min(toCents(l.balance ?? 0), left));
    out[l.id] = (take / 100).toFixed(2);
    left -= take;
  }
  return out;
}

/** Server checks that fail only because the user lacks the payment-application permission (shown as ONE warning). */
const isPermissionCheck = (c: { id: string; status: string; detail: string }) =>
  c.status === "failed" && (c.id === "settle" || (c.id === "available" && /not enabled for your salesforce user/i.test(c.detail)));

function SettlementUnavailable({ isDark, compact }: { isDark: boolean; compact?: boolean }) {
  const t = tokens(isDark);
  return (
    <div role="alert" style={{ fontSize: 12.5, color: t.body, padding: compact ? "10px 12px" : "12px 14px", borderRadius: 10, border: `1px solid ${t.warn}55`, background: `${t.warn}0c` }}>
      <div style={{ fontWeight: 800, color: t.warn }}>⚠ Payment settlement unavailable</div>
      <div style={{ marginTop: 4 }}>Your Salesforce user does not currently have permission to apply payments to invoice lines.</div>
      <div style={{ marginTop: 6 }}>Ask a Salesforce administrator to assign:</div>
      <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
        <li>Billing Advanced permission set license</li>
        <li>Payment Operations User or Payment Admin</li>
      </ul>
      <div style={{ marginTop: 6, color: t.dim }}>Payment settlement will become available after the Salesforce permissions are assigned.</div>
    </div>
  );
}

const SETTLE_STEPS = ["Select Invoice", "Review Invoice Lines", "Payment Amount", "Review Settlement", "Confirm & Settle", "Result"];

export function Stepper({ isDark, current, steps = SETTLE_STEPS }: { isDark: boolean; current: number; steps?: string[] }) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {steps.map((s, i) => {
        const c = i < current ? "#00C875" : i === current ? t.accent : t.dim;
        return <div key={s} style={{ flex: "1 1 120px", padding: "7px 10px", borderRadius: 10, border: `1px solid ${c}${i <= current ? "60" : "30"}`, background: i === current ? `${c}10` : t.surface, fontSize: 11, fontWeight: 800, color: c }}>{i < current ? "✓" : `${i + 1}.`} {s}</div>;
      })}
    </div>
  );
}

/**
 * Settle Payment: create a Salesforce Payment (or use an existing unapplied one) and apply it to the invoice's
 * LINES via applyPayment — this org rejects invoice-level application ("Provide a valid Invoice Line ID."). The same
 * server service as Record Payment does all validation, the permission pre-check, idempotency and compensation.
 */
function SettlePayment({ isDark, nav, initialInvoiceId, paymentId }: { isDark: boolean; nav: Nav; initialInvoiceId?: string | null; paymentId?: string | null }) {
  const t = tokens(isDark);
  const notify = useSalesforceSuccess();
  const model = useBillingData<PaymentModel>("Discover payment model", "/api/billing/payments/model");
  const existing = useBillingData<PaymentDetail>("Load payment", paymentId ? `/api/billing/payments/${paymentId}` : null);
  const prefill = useBillingData<{ invoice: PaymentInvoice }>("Load invoice", initialInvoiceId ? `/api/billing/payments/invoices/${initialInvoiceId}` : null);
  const [picked, setPicked] = useState<PaymentInvoice | null | undefined>(undefined);
  const invoice = picked === undefined ? prefill.data?.invoice ?? null : picked;
  const [amount, setAmount] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [alloc, setAlloc] = useState<Record<string, string> | null>(null);
  const [date, setDate] = useState(todayIso);
  const [methodId, setMethodId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [ai, setAi] = useState<PaymentAiResult | null>(null);
  const [preview, setPreview] = useState<{ data: PaymentPreview; key: string } | null>(null);
  const [busy, setBusy] = useState<null | "ai" | "review" | "confirm" | "refresh">(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<(Done & { previousBalance: number | null }) | null>(null);
  const m = model.data;
  const pay = existing.data?.payment ?? null;
  const settle = m?.capabilities.find(c => c.id === "settle");
  const settleEnabled = !!settle?.available;
  const cap = pay ? Math.min(pay.balance ?? 0, invoice?.balance ?? 0) : invoice?.balance ?? 0;
  const amountValue = amount ?? (invoice ? String(cap) : "");
  const amountNum = Number(amountValue);
  const amountOk = amountValue.trim() !== "" && Number.isFinite(amountNum) && amountNum > 0;
  const allocation = alloc ?? (invoice && amountOk ? autoAllocate(invoice.lines, amountNum) : {});
  const allocTotal = Object.values(allocation).reduce((s, v) => s + (Number.isFinite(Number(v)) ? toCents(v) : 0), 0);
  const allocMismatch = amountOk && allocTotal !== toCents(amountNum);
  const statusValue = status ?? m?.defaults.status ?? "";
  const typeValue = type ?? m?.defaults.type ?? "";
  const step = done ? 5 : preview ? 3 : !invoice ? 0 : amountOk ? 2 : 1;
  // Both flags come from the server: the model's capability check and the preview's own server-side checks.
  const blockedByPermission = !settleEnabled || !!preview?.data.checks.some(isPermissionCheck);
  const canConfirm = !!preview && preview.data.valid && !blockedByPermission && !busy;
  const [showTech, setShowTech] = useState(false);

  const choose = (inv: PaymentInvoice | null) => { setPicked(inv); setAmount(null); setAlloc(null); setPreview(null); setNotice(null); setError(null); };
  const changeAmount = (v: string) => { setAmount(v); setPreview(null); if (!manual) setAlloc(null); };

  async function analyze() {
    if (!prompt.trim()) return;
    setBusy("ai"); setError(null);
    try {
      const r = await quoteApiPost<PaymentAiResult>("AI settlement", "/api/billing/payments/ai", { prompt });
      setAi(r);
      if (r.invoice) { setPicked(r.invoice); setPreview(null); setAlloc(null); }
      if (r.amount !== null) setAmount(String(r.amount));
      if (r.paymentDate) setDate(r.paymentDate);
      if (r.paymentMethod) setMethodId(r.paymentMethod.id);
      setManual(r.extraction.allocationMode === "manual");
    } catch (err) { setError(toBillingErrorPanel(err, "AI analysis failed")); } finally { setBusy(null); }
  }

  const allocationRows = () => (manual ? Object.entries(allocation).map(([lineId, v]) => ({ lineId, amount: Number(v) })) : null);
  const body = () => ({ invoiceId: invoice?.id, amount: amountNum, paymentDate: date, paymentMethodId: methodId || null, status: statusValue || null, type: typeValue || null, level: "lines", allocation: allocationRows() });

  async function review() {
    if (!invoice) return;
    setBusy("review"); setError(null); setNotice(null);
    try {
      const data = await quoteApiPost<PaymentPreview>("Validate settlement", "/api/billing/payments/validate", body());
      setPreview({ data, key: newKey() }); // one settlement request key per reviewed settlement — retries reuse it
    } catch (err) { setError(toBillingErrorPanel(err, "Couldn't validate the settlement")); } finally { setBusy(null); }
  }

  async function refreshInvoice() {
    if (!invoice) return;
    setBusy("refresh");
    try { const r = await quoteApiGet<{ invoice: PaymentInvoice }>("Load invoice", `/api/billing/payments/invoices/${invoice.id}`); choose(r.invoice); } catch (err) { setError(toBillingErrorPanel(err, "Couldn't reload the invoice")); } finally { setBusy(null); }
  }

  async function confirm() {
    if (!preview || !invoice || !canConfirm) return; // never submit while the server reports settlement unavailable
    setBusy("confirm"); setError(null);
    try {
      const r = pay
        ? await quoteApiPost<Done & { success: true }>("Settle payment", `/api/billing/payments/${pay.id}/apply`, { invoiceId: invoice.id, amount: amountNum, invoiceToken: preview.data.invoice.token, level: "lines", allocation: allocationRows() })
        : await quoteApiPost<Done & { success: true }>("Settle payment", "/api/billing/payments", { ...body(), invoiceToken: preview.data.invoice.token, idempotencyKey: preview.key });
      setDone({ ...r, previousBalance: preview.data.invoice.balance }); setPreview(null);
      notify({ title: (r.invoice.balance ?? 0) > 0 ? "Payment partially applied" : "Payment settled", message: r.message, records: [{ objectApiName: "Payment", recordId: r.payment.payment.id, recordName: r.payment.payment.number ?? r.payment.payment.id, salesforceUrl: r.payment.payment.salesforceUrl }] });
    } catch (err) {
      const panel = toBillingErrorPanel(err, "Payment settlement failed");
      setError(panel);
      const raw = panel.raw as { code?: string; invoice?: PaymentInvoice | null } | undefined;
      if (raw?.code === "INVOICE_CHANGED" && raw.invoice) { choose(raw.invoice); setNotice("The invoice balance changed while you were preparing this payment. Refresh the settlement and review the updated amount."); }
      else setPreview(null);
      model.reload();
    } finally { setBusy(null); }
  }

  /* Step 6 — the result, entirely as re-read from Salesforce. */
  if (done) {
    const p = done.payment.payment;
    const inv = done.invoice;
    const appliedHere = done.payment.applications.filter(a => a.invoice?.id === inv.id && /^applied$/i.test(a.type ?? ""));
    const confirmed = appliedHere.length > 0;
    const full = confirmed && (inv.balance ?? 0) <= 0;
    return (
      <PageShell>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <Stepper isDark={isDark} current={5} />
          <div style={{ borderRadius: 16, padding: 18, border: `1px solid ${confirmed ? "rgba(0,200,117,0.35)" : t.warn + "55"}`, background: confirmed ? "rgba(0,200,117,0.06)" : `${t.warn}0c` }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>{!confirmed ? "⚠ Salesforce returned no payment application for this invoice" : full ? "Payment Settled Successfully ✓" : "Payment Partially Applied"}</div>
            <div style={{ fontSize: 12, color: t.dim }}>{done.message} Everything below was re-read from Salesforce after the payment was applied.</div>
          </div>
          <Panel isDark={isDark} title="Settlement result" icon="credit-card">
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <Row isDark={isDark} label="Payment">{p.number} <StatusPill status={p.status} isDark={isDark} /></Row>
              <Row isDark={isDark} label="Amount">{money(p.amount, inv.currency)}</Row>
              <Row isDark={isDark} label="Applied">{money(p.applied, inv.currency)}</Row>
              <Row isDark={isDark} label="Payment balance (unapplied)">{money(p.balance, inv.currency)}</Row>
              <Row isDark={isDark} label="Invoice">{inv.number} <StatusPill status={inv.status} isDark={isDark} /></Row>
              <Row isDark={isDark} label="Previous Balance">{money(done.previousBalance, inv.currency)}</Row>
              <Row isDark={isDark} label="Current Balance">{money(inv.balance, inv.currency)}</Row>
              <Row isDark={isDark} label="Settlement Status">{inv.settlementStatus ?? "—"}</Row>
              <Row isDark={isDark} label="Payment → Application → Invoice Line">{appliedHere.map(a => `${a.number} → ${a.invoiceLine?.name ?? inv.number} ${money(a.amount)}`).join(" · ") || "—"}</Row>
            </div>
          </Panel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <PrimaryButton label="View Payment" icon="eye" isDark={isDark} onClick={() => nav.onNavigate({ mode: "detail", id: p.id })} />
            <GhostButton label="View Invoice" icon="file-text" isDark={isDark} onClick={() => nav.onOpenInvoice(inv.id)} />
            <GhostButton label="Back to Payments" icon="list" isDark={isDark} onClick={() => nav.onNavigate({ mode: "dashboard" })} />
          </div>
        </div>
      </PageShell>
    );
  }

  const pv = preview?.data;
  const footer = (
    <FooterBar isDark={isDark}>
      <GhostButton label="Cancel" icon="x" isDark={isDark} onClick={() => nav.onNavigate({ mode: "dashboard" })} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {busy && <Spinner isDark={isDark} size={13} />}
        <PrimaryButton label={busy === "review" ? "Validating…" : "Review Settlement"} icon="check-circle" isDark={isDark} disabled={!invoice || !m || !!busy || !amountOk || allocMismatch} onClick={review} />
      </div>
    </FooterBar>
  );

  return (
    <PageShell footer={footer}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>Settle Payment</div>
          <div style={{ fontSize: 11.5, color: t.dim }}>{pay ? `Applies the unapplied balance of ${pay.number} to an invoice's lines.` : "Creates a Salesforce Payment and applies it to the invoice's lines (applyPayment → PaymentLineInvoiceLine)."} Nothing is written until you confirm; the server re-reads the invoice, its lines and your permissions first.</div>
        </div>
        <Stepper isDark={isDark} current={step} />
        {m && !settleEnabled && <SettlementUnavailable isDark={isDark} />}
        {model.error && <ErrorPanel isDark={isDark} error={model.error} />}
        {existing.error && <ErrorPanel isDark={isDark} error={existing.error} />}

        {!pay && (
          <div style={{ borderRadius: 16, padding: 16, border: `1px solid ${t.accent}45`, background: isDark ? "linear-gradient(135deg, rgba(0,212,255,0.08), rgba(30,144,255,0.04))" : "linear-gradient(135deg, rgba(0,152,204,0.07), rgba(9,104,211,0.03))" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 800, color: t.heading }}>
              <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="sparkles" s={15} /></span> Describe the settlement
              <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, border: `1px solid ${t.border}`, borderRadius: 999, padding: "1px 8px" }}>OPTIONAL</span>
            </div>
            <div style={{ fontSize: 12, color: t.dim, margin: "4px 0 10px" }}>The AI only fills this form. The invoice is resolved by its number and lines are allocated against the real Salesforce invoice lines — you review and confirm.</div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2} placeholder='e.g. "Settle invoice DOC-000000001 for the full outstanding amount."' style={{ ...inputStyle(t), flex: "1 1 380px", resize: "vertical", fontSize: 13.5 }} />
              <PrimaryButton label={busy === "ai" ? "Analyzing…" : "Analyze & Fill"} icon="sparkles" isDark={isDark} disabled={!prompt.trim() || !!busy} onClick={analyze} />
            </div>
            {ai && (
              <div style={{ marginTop: 10, fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ color: ai.invoice ? "#00C875" : t.error, fontWeight: 700 }}>{ai.invoice ? `✓ Invoice ${ai.invoice.number} found in Salesforce · ${ai.invoice.lines.length} line(s) · allocation ${ai.extraction.allocationMode}` : `✗ ${ai.invoiceMessage}`}</span>
                <WarningsDisclosure isDark={isDark} warnings={ai.warnings} />
              </div>
            )}
            <div style={{ marginTop: 10 }}><PromptGuide isDark={isDark} config={billingPromptGuides.settlePayment} onUseExample={setPrompt} /></div>
          </div>
        )}

        {error && <ErrorPanel isDark={isDark} error={error} />}
        {notice && <div style={{ fontSize: 12.5, color: t.warn, fontWeight: 600, padding: "8px 12px", borderRadius: 10, border: `1px solid ${t.warn}55`, background: `${t.warn}0c` }}>⚠ {notice}</div>}

        {/* Step 1 — invoice */}
        <Panel isDark={isDark} title="1. Invoice" icon="file-text" right={invoice ? <div style={{ display: "flex", gap: 6 }}><GhostButton label="Refresh" icon="refresh" isDark={isDark} onClick={refreshInvoice} /><GhostButton label="Change" icon="edit" isDark={isDark} onClick={() => choose(null)} /></div> : null}>
          {initialInvoiceId && prefill.loading && picked === undefined && <LoadingRow isDark={isDark} label="Loading the invoice from Salesforce…" />}
          {prefill.error && picked === undefined && <ErrorPanel isDark={isDark} error={prefill.error} />}
          {!invoice && !(initialInvoiceId && prefill.loading && picked === undefined) && <InvoicePicker isDark={isDark} onPick={choose} />}
          {invoice && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 8 }}>
              <Row isDark={isDark} label="Invoice Number">{invoice.number}</Row>
              <Row isDark={isDark} label="Account">{invoice.account?.name ?? "—"}</Row>
              <Row isDark={isDark} label="Status"><StatusPill status={invoice.status} isDark={isDark} /></Row>
              <Row isDark={isDark} label="Invoice Total">{money(invoice.total, invoice.currency)}</Row>
              <Row isDark={isDark} label="Current Balance">{money(invoice.balance, invoice.currency)}</Row>
              <Row isDark={isDark} label="Payments Applied">{money(invoice.paymentsApplied, invoice.currency)}</Row>
              <Row isDark={isDark} label="Credits Applied">{money(invoice.creditsApplied, invoice.currency)}</Row>
              <Row isDark={isDark} label="Due Date">{invoice.dueDate ?? "—"}</Row>
              <Row isDark={isDark} label="Currency">{invoice.currency ?? "Org currency"}</Row>
              {invoice.orders.length > 0 && <Row isDark={isDark} label="Order">{invoice.orders.map(o => o.number).join(", ")}</Row>}
              {!invoice.eligible && <div style={{ gridColumn: "1 / -1", fontSize: 12.5, color: t.error, fontWeight: 600 }}>✗ {invoice.reasons.join(" ")}</div>}
              {pay && invoice.account && pay.account && pay.account.id !== invoice.account.id && <div style={{ gridColumn: "1 / -1", fontSize: 12.5, color: t.error, fontWeight: 600 }}>✗ {pay.number} belongs to {pay.account.name}, not {invoice.account.name}.</div>}
            </div>
          )}
        </Panel>

        {invoice && m && (
          <>
            {/* Step 2 — lines + allocation */}
            <Panel isDark={isDark} title="2. Invoice Lines & Allocation" icon="layers" right={
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <label style={{ fontSize: 11.5, color: t.dim, display: "flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={manual} onChange={e => { setManual(e.target.checked); setPreview(null); if (!e.target.checked) setAlloc(null); }} /> Edit allocation</label>
                <GhostButton label="Auto Allocate" icon="wand" isDark={isDark} disabled={!amountOk} onClick={() => { setAlloc(null); setPreview(null); }} />
              </div>}>
              {invoice.lines.length === 0 ? <div style={{ fontSize: 12.5, color: t.error }}>✗ The invoice has no invoice lines.</div> : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead><tr>{["Product / Line", "Original Amount", "Paid", "Line Balance", "Payment Allocation", "Remaining after"].map(h => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: t.dim, fontSize: 10.5, textTransform: "uppercase", borderBottom: `1px solid ${t.border}` }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {invoice.lines.map(l => {
                      const v = allocation[l.id] ?? "0.00";
                      const over = Number.isFinite(Number(v)) && toCents(v) > toCents(l.balance ?? 0);
                      return (
                        <tr key={l.id} style={{ borderBottom: `1px solid ${t.border}` }}>
                          <td style={{ padding: "6px 8px", fontWeight: 700, color: t.heading }}>{l.product ?? l.name}{l.product && l.name && l.name !== l.product ? <span style={{ fontWeight: 400, color: t.dim }}> · {l.name}</span> : null}</td>
                          <td style={{ padding: "6px 8px" }}>{money(l.amount, invoice.currency)}</td>
                          <td style={{ padding: "6px 8px" }}>{money(l.paymentsApplied ?? 0, invoice.currency)}</td>
                          <td style={{ padding: "6px 8px" }}>{money(l.balance, invoice.currency)}</td>
                          <td style={{ padding: "6px 8px", width: 150 }}>
                            {manual
                              ? <input type="number" step="0.01" min="0" value={v} onChange={e => { setAlloc({ ...allocation, [l.id]: e.target.value }); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 12.5, padding: "5px 8px", borderColor: over ? t.error : undefined }} />
                              : <strong style={{ color: t.heading }}>{money(Number(v), invoice.currency)}</strong>}
                          </td>
                          <td style={{ padding: "6px 8px", color: over ? t.error : t.body }}>{Number.isFinite(Number(v)) ? money(Math.round(((l.balance ?? 0) - Number(v)) * 100) / 100, invoice.currency) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: allocMismatch ? t.error : t.dim }}>
                Allocated {money(allocTotal / 100, invoice.currency)} of {amountOk ? money(amountNum, invoice.currency) : "—"}{allocMismatch ? " — Payment allocation does not equal the payment amount." : ""}
              </div>
            </Panel>
            {/* Step 3 — amount (+ payment fields) */}
            <Panel isDark={isDark} title={pay ? `3. Amount to apply from ${pay.number}` : "3. Payment"} icon="credit-card">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
                <Field t={t} label={`Payment Amount${invoice.currency ? ` (${invoice.currency})` : ""} *`}>
                  <input type="number" step="0.01" min="0.01" value={amountValue} onChange={e => changeAmount(e.target.value)} style={{ ...inputStyle(t), fontSize: 13 }} />
                </Field>
                <Field t={t} label="Remaining after settlement"><div style={{ fontSize: 13, fontWeight: 700, color: t.heading, paddingTop: 8 }}>{amountOk ? money(Math.round(((invoice.balance ?? 0) - amountNum) * 100) / 100, invoice.currency) : "—"}</div></Field>
                {!pay && <>
                  <Field t={t} label="Payment Date *"><input type="date" value={date} onChange={e => { setDate(e.target.value); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 13 }} /></Field>
                  <Field t={t} label="Payment Method">
                    {m.paymentMethods.length ? (
                      <select value={methodId} onChange={e => { setMethodId(e.target.value); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 13 }}>
                        <option value="">None</option>
                        {m.paymentMethods.filter(p => !p.accountId || p.accountId === invoice.account?.id).map(p => <option key={p.id} value={p.id}>{p.name}{p.type ? ` (${p.type})` : ""}</option>)}
                      </select>
                    ) : <div style={{ fontSize: 12, color: t.dim, paddingTop: 8 }}>No payment methods configured — {m.defaults.processingMode ?? "External"} payment.</div>}
                  </Field>
                  <Field t={t} label="Status *"><select value={statusValue} onChange={e => { setStatus(e.target.value); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 13 }}>{m.statusValues.map(s => <option key={s} value={s}>{s}</option>)}</select></Field>
                  <Field t={t} label="Type *"><select value={typeValue} onChange={e => { setType(e.target.value); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 13 }}>{m.typeValues.map(s => <option key={s} value={s}>{s}</option>)}</select></Field>
                </>}
              </div>
              {amountOk && toCents(amountNum) > toCents(cap) && <div style={{ marginTop: 8, fontSize: 12.5, color: t.error, fontWeight: 600 }}>✗ The amount exceeds the {pay ? "payment's unapplied balance or the invoice balance" : "invoice balance"} ({money(cap, invoice.currency)}).</div>}
              {amountOk && toCents(amountNum) < toCents(invoice.balance ?? 0) && <div style={{ marginTop: 8, fontSize: 12, color: m.capabilities.find(c => c.id === "partial")?.available ? t.dim : t.error }}>{m.capabilities.find(c => c.id === "partial")?.available ? "Partial settlement — the invoice stays open for the remainder." : "Partial payment is not supported by this org configuration."}</div>}
            </Panel>

          </>
        )}
      </div>

      <AnimatePresence>
        {pv && preview && (
          <Modal isDark={isDark} title="Settlement Preview" tone={pv.valid && !blockedByPermission ? "accent" : "warn"} actions={<>
            <GhostButton label="Cancel" isDark={isDark} onClick={() => setPreview(null)} />
            <span title={blockedByPermission ? "Payment settlement is unavailable for your Salesforce user" : !pv.valid ? "Fix the issues above first" : undefined} aria-disabled={!canConfirm} style={{ display: "inline-flex" }}>
              <PrimaryButton label={busy === "confirm" ? "Settling…" : "Confirm & Settle Payment"} icon={blockedByPermission ? "lock" : "check"} isDark={isDark} disabled={!canConfirm} onClick={confirm} />
            </span>
          </>}>
            {pv.preview && <>
              <Row isDark={isDark} label="Invoice">{pv.invoice.number}</Row>
              <Row isDark={isDark} label="Account">{pv.preview.account?.name ?? "—"}</Row>
              <Row isDark={isDark} label="Current Balance">{money(pv.preview.balanceBefore, pv.preview.currency)}</Row>
              <Row isDark={isDark} label={pay ? `Apply from ${pay.number}` : "Payment"}>{money(pv.preview.amount, pv.preview.currency)}{pv.preview.partial ? " (partial)" : ""}</Row>
              <Row isDark={isDark} label="Allocation">{pv.preview.allocation.map(a => `${a.label}: ${money(a.amount)}`).join(" · ") || "—"}</Row>
              {!pay && <Row isDark={isDark} label="Type / Processing Mode / Date">{pv.preview.status} · {pv.preview.type} · {pv.preview.processingMode} · {pv.preview.paymentDate}{pv.preview.paymentMethod ? ` · ${pv.preview.paymentMethod.name}` : ""}</Row>}
              <Row isDark={isDark} label="Expected Remaining Balance"><span style={{ color: "#00C875" }}>{money(pv.preview.balanceAfter, pv.preview.currency)}</span></Row>
              <Row isDark={isDark} label="Expected Payment Applied">{money(pv.preview.applied, pv.preview.currency)}</Row>
            </>}
            {blockedByPermission && <SettlementUnavailable isDark={isDark} compact />}
            {pv.checks.filter(c => c.status === "failed" && !isPermissionCheck(c)).map(c => <div key={c.id} style={{ color: t.error, fontWeight: 600 }}>✗ {c.detail}</div>)}
            <WarningsDisclosure isDark={isDark} warnings={pv.warnings} />
            {blockedByPermission && (
              <div>
                <button type="button" onClick={() => setShowTech(v => !v)} style={{ background: "none", border: "none", padding: 0, color: t.dim, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>{showTech ? "Hide technical details" : "Technical details"}</button>
                {showTech && <div style={{ marginTop: 6 }}><CodeBlock open isDark={isDark} data={{ capabilityCheck: m?.applicationProbe ?? null, failedChecks: pv.checks.filter(isPermissionCheck) }} /></div>}
              </div>
            )}
            <div style={{ fontSize: 11.5, color: t.dim }}>&ldquo;Expected&rdquo; values are a preview. After confirming, the server re-reads the invoice, lines and your permissions, applies the payment in Salesforce, then shows Salesforce&apos;s actual values.</div>
          </Modal>
        )}
      </AnimatePresence>
    </PageShell>
  );
}

/**
 * Revenue Cloud Billing — Payments. Dashboard/history, Payment details and Record Payment (manual + AI) on one
 * shared server service (lib/billing/server/payments.ts). Opened from the Payments card, from Invoice details
 * ("Record Payment" / "View Payments") and from the Order billing setup after an invoice is posted.
 */
export default function BillingPaymentsWorkspace({ isDark, view, ...nav }: { isDark: boolean; view: PaymentsView } & Nav) {
  if (view.mode === "settle") return <SettlePayment isDark={isDark} nav={nav} initialInvoiceId={view.invoiceId} paymentId={view.paymentId} />;
  if (view.mode === "record") return <RecordPayment isDark={isDark} nav={nav} initialInvoiceId={view.invoiceId} />;
  if (view.mode === "detail") return <PaymentDetailView isDark={isDark} nav={nav} id={view.id} />;
  return <PaymentsDashboard isDark={isDark} nav={nav} />;
}
