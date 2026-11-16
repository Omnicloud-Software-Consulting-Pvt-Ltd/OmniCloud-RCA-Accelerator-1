"use client";

import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, PrimaryButton, GhostButton, PageShell, FooterBar, Spinner, ErrorPanel, CodeBlock } from "@/components/data/quotes/shared";
import ReferenceLookup from "@/components/data/shared/ReferenceLookup";
import { BILLING_SEARCH_ENDPOINT } from "@/components/data/billing/BillingFieldInput";
import { Panel, StatusPill, Modal, Row, LoadingRow, StatTile, useBillingData } from "@/components/data/billing/billingUi";
import { InvoicePicker, Field, Stepper } from "@/components/data/billing/BillingPaymentsWorkspace";
import { useSalesforceSuccess, useNotify } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiGet, quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import type { PaymentInvoice } from "@/lib/billing/server/payments";
import { money } from "@/components/data/billing/creditMemoFormat";
import type { CreditMemoDetail, CreditMemoModel, CreditMemoRow, CreditPreview } from "@/lib/billing/server/creditMemos";
import { WarningsDisclosure } from "@/components/ui/Disclosure";
import PromptGuide from "@/components/ai/PromptGuide";
import { billingPromptGuides } from "@/lib/ai/promptGuides/billing";

export type CreditMemosView = { mode: "dashboard" } | { mode: "create"; invoiceId?: string | null } | { mode: "detail"; id: string };

interface Nav {
  onNavigate: (view: CreditMemosView) => void;
  onOpenInvoice: (invoiceId: string) => void;
  onOpenOrder: (orderId: string) => void;
  onOpenSchedule: (scheduleId: string) => void;
}

type ListResponse = { creditMemos: CreditMemoRow[]; totalSize: number; page: number; pageSize: number; stats: { amount: number | null; applied: number | null; balance: number | null; byStatus: { status: string; count: number; amount: number | null }[] }; statusValues: string[]; currency: string | null };
type CreateResult = { duplicate: boolean; state: "created" | "processing"; message: string; creditMemo: CreditMemoDetail | null; invoice: PaymentInvoice; requestIdentifier: string | null };

const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : "—");
const todayIso = () => new Date().toISOString().slice(0, 10);
const toCents = (v: string | number) => Math.round(Number(v) * 100);
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
const allowable = (l: PaymentInvoice["lines"][number]) => Math.max(0, Math.round(((l.amount ?? 0) - (l.creditsApplied ?? 0)) * 100) / 100);

/** One user-facing warning when the org's metadata/Salesforce says the user can't run credit operations (no raw errors). */
function CreditUnavailable({ isDark, model }: { isDark: boolean; model: CreditMemoModel }) {
  const t = tokens(isDark);
  return (
    <div role="alert" style={{ fontSize: 12.5, color: t.body, padding: "12px 14px", borderRadius: 10, border: `1px solid ${t.warn}55`, background: `${t.warn}0c` }}>
      <div style={{ fontWeight: 800, color: t.warn }}>⚠ Credit Memo creation is not currently available for this Salesforce user.</div>
      <div style={{ marginTop: 4 }}>Credit Memos are available in Salesforce metadata, but this operation is not currently enabled for this Salesforce org/user. Existing credit memos stay readable here.</div>
      {model.permission && !model.permission.assigned && <div style={{ marginTop: 6 }}>Ask a Salesforce administrator to assign the <strong>{model.permission.label}</strong> permission set.</div>}
    </div>
  );
}

function Capabilities({ isDark, model }: { isDark: boolean; model: CreditMemoModel }) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6 }}>
      {model.capabilities.map(c => (
        <div key={c.id} title={c.detail} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: t.body, padding: "7px 10px", borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}` }}>
          <span style={{ color: c.available ? "#00C875" : t.warn, display: "inline-flex" }}><Ic n={c.available ? "check-circle" : "alert"} s={13} /></span>
          <span style={{ flex: 1 }}>{c.label}</span>
          <strong style={{ fontSize: 11, color: c.available ? "#00C875" : t.warn }}>{c.available ? "✓ Available" : "⚠ Not available"}</strong>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── Dashboard / history ───────────────────────── */

function Dashboard({ isDark, nav }: { isDark: boolean; nav: Nav }) {
  const t = tokens(isDark);
  const model = useBillingData<CreditMemoModel>("Discover credit memos", "/api/billing/credit-memos/model");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("");
  const [account, setAccount] = useState<{ id: string; name: string } | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState("created");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  useEffect(() => { const h = setTimeout(() => setDebounced(search.trim()), 350); return () => clearTimeout(h); }, [search]);
  const qs = new URLSearchParams({ page: String(page), pageSize: "20", sort, dir, ...(debounced ? { search: debounced } : {}), ...(status ? { status } : {}), ...(account ? { accountId: account.id } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
  const list = useBillingData<ListResponse>("Load credit memos", `/api/billing/credit-memos?${qs.toString()}`);
  const m = model.data, data = list.data;
  const canCreate = !!m?.capabilities.find(c => c.id === "create")?.available;
  const filtered = !!(debounced || status || account || from || to);
  const pages = data ? Math.max(1, Math.ceil(data.totalSize / data.pageSize)) : 1;
  const toggleSort = (k: string) => { setPage(1); if (sort === k) setDir(d => (d === "asc" ? "desc" : "asc")); else { setSort(k); setDir("desc"); } };
  const statusColor = (s: string) => (/posted/i.test(s) ? "#00C875" : /draft|pending|progress/i.test(s) ? t.warn : /cancel|void|error/i.test(s) ? t.error : t.accent);

  return (
    <PageShell footer={
      <FooterBar isDark={isDark}>
        <GhostButton label="Refresh" icon="refresh" isDark={isDark} onClick={() => { list.reload(); model.reload(); }} />
        <PrimaryButton label="Create Credit Memo" icon="plus" isDark={isDark} disabled={!m} onClick={() => nav.onNavigate({ mode: "create" })} />
      </FooterBar>}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Credit Memos</div>
          <div style={{ fontSize: 11.5, color: t.dim }}>Salesforce CreditMemo records, their lines and applications to invoices — read live from the connected org.</div>
        </div>
        {model.error && <ErrorPanel isDark={isDark} error={model.error} />}
        {data && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <StatTile isDark={isDark} label={filtered ? "Credit Memos (filtered)" : "Total Credit Memos"} value={String(data.totalSize)} />
            {data.statusValues.map(st => <StatTile key={st} isDark={isDark} label={st} value={String(data.stats.byStatus.find(s => s.status === st)?.count ?? 0)} color={statusColor(st)} />)}
            <StatTile isDark={isDark} label="Total Credit Amount" value={money(data.stats.amount, data.currency)} />
            <StatTile isDark={isDark} label="Applied" value={money(data.stats.applied, data.currency)} color="#00C875" />
            <StatTile isDark={isDark} label="Remaining Balance" value={money(data.stats.balance, data.currency)} color={t.warn} />
          </div>
        )}
        {m && !canCreate && <CreditUnavailable isDark={isDark} model={m} />}
        {m && <Panel isDark={isDark} title="Org capabilities" icon="database"><Capabilities isDark={isDark} model={m} /></Panel>}
        <Panel isDark={isDark} title="Credit Memo History" icon="list" right={list.loading ? <Spinner isDark={isDark} size={13} /> : null}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8, marginBottom: 12 }}>
            <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search number, account or description…" style={{ ...inputStyle(t), fontSize: 12.5 }} />
            <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} style={{ ...inputStyle(t), fontSize: 12.5 }}>
              <option value="">All statuses</option>
              {(data?.statusValues ?? m?.statusValues ?? []).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <ReferenceLookup isDark={isDark} objectType="Account" searchEndpoint={BILLING_SEARCH_ENDPOINT} value={account} onChange={v => { setAccount(v); setPage(1); }} placeholder="Filter by account…" noMatchHint="No matching Account." />
            <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} title="Created from" style={{ ...inputStyle(t), fontSize: 12.5 }} />
            <input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} title="Created to" style={{ ...inputStyle(t), fontSize: 12.5 }} />
          </div>
          {list.error && <ErrorPanel isDark={isDark} error={list.error} />}
          {!data && !list.error && <LoadingRow isDark={isDark} label="Loading credit memos from Salesforce…" />}
          {data && data.creditMemos.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 13, color: t.dim }}>{filtered ? "No credit memos match these filters." : "No credit memos exist in Salesforce yet."}</div>
              {!filtered && <PrimaryButton label="Create Credit Memo" icon="plus" isDark={isDark} disabled={!m} onClick={() => nav.onNavigate({ mode: "create" })} />}
            </div>
          )}
          {data && data.creditMemos.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>
                  {([["number", "Credit Memo"], ["account", "Account"], [null, "Invoice"], ["amount", "Total with Tax"], [null, "Applied"], [null, "Remaining"], ["status", "Status"], ["date", "Credit Date"], [null, "Effective"], ["created", "Created"], [null, ""]] as const).map(([k, h]) => (
                    <th key={h || "a"} onClick={k ? () => toggleSort(k) : undefined} style={{ textAlign: "left", padding: "6px 8px", color: t.dim, fontSize: 10.5, textTransform: "uppercase", borderBottom: `1px solid ${t.border}`, cursor: k ? "pointer" : "default", whiteSpace: "nowrap" }}>{h}{k && sort === k ? (dir === "asc" ? " ▲" : " ▼") : ""}</th>
                  ))}
                </tr></thead>
                <tbody>{data.creditMemos.map(c => (
                  <tr key={c.id} style={{ borderBottom: `1px solid ${t.border}` }}>
                    <td style={{ padding: "6px 8px", fontWeight: 700, color: t.heading }}>{c.number}</td>
                    <td style={{ padding: "6px 8px" }}>{c.account?.name ?? "—"}</td>
                    <td style={{ padding: "6px 8px" }}>{c.invoice?.number ?? "—"}</td>
                    <td style={{ padding: "6px 8px" }}>{money(c.amount, data.currency)}</td>
                    <td style={{ padding: "6px 8px" }}>{money(c.applied, data.currency)}</td>
                    <td style={{ padding: "6px 8px" }}>{money(c.balance, data.currency)}</td>
                    <td style={{ padding: "6px 8px" }}><StatusPill status={c.status} isDark={isDark} /></td>
                    <td style={{ padding: "6px 8px" }}>{day(c.creditDate)}</td>
                    <td style={{ padding: "6px 8px" }}>{day(c.effectiveDate)}</td>
                    <td style={{ padding: "6px 8px" }}>{day(c.createdDate)}</td>
                    <td style={{ padding: "6px 8px" }}><GhostButton label="View" icon="eye" isDark={isDark} onClick={() => nav.onNavigate({ mode: "detail", id: c.id })} /></td>
                  </tr>
                ))}</tbody>
              </table>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 10, fontSize: 12, color: t.dim }}>
                <span>{data.totalSize} credit memo(s) · page {page} of {pages}</span>
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

/* ───────────────────────── Create Credit Memo ───────────────────────── */

const CREATE_STEPS = ["Select Invoice", "Review Invoice", "Lines & Amount", "Reason & Tax", "Review", "Result"];

function autoAllocate(lines: PaymentInvoice["lines"], amount: number): Record<string, string> {
  // Mirrors the server: largest creditable line first, never above a line's allowable amount.
  let left = toCents(amount);
  const out: Record<string, string> = {};
  for (const l of [...lines].sort((a, b) => allowable(b) - allowable(a))) { const take = Math.max(0, Math.min(toCents(allowable(l)), left)); out[l.id] = (take / 100).toFixed(2); left -= take; }
  return out;
}

function CreateCreditMemo({ isDark, nav, initialInvoiceId }: { isDark: boolean; nav: Nav; initialInvoiceId?: string | null }) {
  const t = tokens(isDark);
  const notify = useSalesforceSuccess();
  const model = useBillingData<CreditMemoModel>("Discover credit memos", "/api/billing/credit-memos/model");
  const prefill = useBillingData<{ invoice: PaymentInvoice }>("Load invoice", initialInvoiceId ? `/api/billing/payments/invoices/${initialInvoiceId}` : null);
  const [picked, setPicked] = useState<PaymentInvoice | null | undefined>(undefined);
  const invoice = picked === undefined ? prefill.data?.invoice ?? null : picked;
  const [amount, setAmount] = useState<string>("");
  const [manual, setManual] = useState(false);
  const [alloc, setAlloc] = useState<Record<string, string> | null>(null);
  const [tax, setTax] = useState<string | null>(null);
  const [effective, setEffective] = useState(todayIso);
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ai, setAi] = useState<{ invoiceMessage: string | null; warnings: string[]; invoice: PaymentInvoice | null; line: { id: string; name: string } | null } | null>(null);
  const [preview, setPreview] = useState<{ data: CreditPreview; key: string } | null>(null);
  const [busy, setBusy] = useState<null | "ai" | "review" | "confirm" | "status">(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<(CreateResult & { key: string; previousBalance: number | null }) | null>(null);
  const [showTech, setShowTech] = useState(false);
  const m = model.data;
  const canCreate = !!m?.capabilities.find(c => c.id === "create")?.available;
  const amountNum = Number(amount);
  const amountOk = amount.trim() !== "" && Number.isFinite(amountNum) && amountNum > 0;
  const allocation = alloc ?? (invoice && amountOk ? autoAllocate(invoice.lines, amountNum) : {});
  const allocTotal = Object.values(allocation).reduce((s, v) => s + (Number.isFinite(Number(v)) ? toCents(v) : 0), 0);
  const allocMismatch = amountOk && allocTotal !== toCents(amountNum);
  const taxValue = tax ?? m?.taxStrategies[0] ?? "Ignore";
  const step = result ? 5 : preview ? 4 : !invoice ? 0 : !amountOk ? 2 : 3;
  const permissionBlocked = !canCreate || !!preview?.data.checks.some(c => c.id === "permission" && c.status === "failed");
  const canConfirm = !!preview && preview.data.valid && !permissionBlocked && !busy;

  const choose = (inv: PaymentInvoice | null) => { setPicked(inv); setAmount(""); setAlloc(null); setPreview(null); setNotice(null); setError(null); };
  const allocationRows = () => (manual ? Object.entries(allocation).map(([lineId, v]) => ({ lineId, amount: Number(v) })) : null);
  const body = () => ({ invoiceId: invoice?.id, amount: amountNum, allocation: allocationRows(), taxStrategy: taxValue, effectiveDate: effective, description: description || null });

  async function analyze() {
    if (!prompt.trim()) return;
    setBusy("ai"); setError(null);
    try {
      const r = await quoteApiPost<{ invoice: PaymentInvoice | null; invoiceMessage: string | null; amount: number | null; line: { id: string; name: string } | null; reason: string | null; warnings: string[] }>("AI credit memo", "/api/billing/credit-memos/ai", { prompt });
      setAi(r);
      if (r.invoice) { setPicked(r.invoice); setPreview(null); }
      if (r.amount !== null) setAmount(String(r.amount));
      if (r.reason) setDescription(r.reason);
      if (r.invoice && r.line && r.amount !== null) { setManual(true); setAlloc(Object.fromEntries(r.invoice.lines.map(l => [l.id, l.id === r.line!.id ? r.amount!.toFixed(2) : "0.00"]))); }
      else { setManual(false); setAlloc(null); }
    } catch (err) { setError(toBillingErrorPanel(err, "AI analysis failed")); } finally { setBusy(null); }
  }

  async function review() {
    if (!invoice) return;
    setBusy("review"); setError(null); setNotice(null);
    try {
      const data = await quoteApiPost<CreditPreview>("Validate credit memo", "/api/billing/credit-memos/validate", body());
      setPreview({ data, key: newKey() }); // one request key per reviewed credit memo — retries reuse it
    } catch (err) { setError(toBillingErrorPanel(err, "Couldn't validate the credit memo")); } finally { setBusy(null); }
  }

  async function confirm() {
    if (!preview || !invoice || !canConfirm) return;
    setBusy("confirm"); setError(null);
    try {
      const r = await quoteApiPost<CreateResult & { success: true }>("Create credit memo", "/api/billing/credit-memos", { ...body(), invoiceToken: preview.data.invoice.token, idempotencyKey: preview.key });
      setResult({ ...r, key: preview.key, previousBalance: preview.data.invoice.balance }); setPreview(null);
      if (r.creditMemo) notify({ title: "Credit Memo created", message: r.message, records: [{ objectApiName: "CreditMemo", recordId: r.creditMemo.creditMemo.id, recordName: r.creditMemo.creditMemo.number ?? r.creditMemo.creditMemo.id, salesforceUrl: r.creditMemo.creditMemo.salesforceUrl }] });
    } catch (err) {
      const panel = toBillingErrorPanel(err, "Salesforce didn't create the credit memo");
      setError(panel);
      const raw = panel.raw as { code?: string; invoice?: PaymentInvoice | null } | undefined;
      if (raw?.code === "INVOICE_CHANGED" && raw.invoice) { choose(raw.invoice); setNotice("The invoice changed while you were preparing this credit memo. Refresh and review the current balance."); }
      else setPreview(null);
      model.reload();
    } finally { setBusy(null); }
  }

  async function refreshStatus() {
    if (!result || !invoice) return;
    setBusy("status");
    try { const r = await quoteApiGet<CreateResult>("Credit memo status", `/api/billing/credit-memos/status?key=${encodeURIComponent(result.key)}&invoiceId=${invoice.id}`); setResult({ ...result, ...r }); } catch (err) { setError(toBillingErrorPanel(err, "Couldn't read the request status")); } finally { setBusy(null); }
  }

  if (result) {
    const cm = result.creditMemo;
    return (
      <PageShell>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <Stepper isDark={isDark} current={5} steps={CREATE_STEPS} />
          <div style={{ borderRadius: 16, padding: 18, border: `1px solid ${cm ? "rgba(0,200,117,0.35)" : t.warn + "55"}`, background: cm ? "rgba(0,200,117,0.06)" : `${t.warn}0c` }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>{cm ? `Credit Memo ${cm.creditMemo.number} created ✓` : "⏳ Salesforce is processing the credit memo"}</div>
            <div style={{ fontSize: 12, color: t.dim }}>{result.message} {cm ? "Values below were re-read from Salesforce." : "Nothing is shown as created until Salesforce has created it."}</div>
          </div>
          {error && <ErrorPanel isDark={isDark} error={error} />}
          <Panel isDark={isDark} title="Result (from Salesforce)" icon="file-text">
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {cm && <>
                <Row isDark={isDark} label="Credit Memo">{cm.creditMemo.number} <StatusPill status={cm.creditMemo.status} isDark={isDark} /></Row>
                <Row isDark={isDark} label="Total with Tax">{money(cm.creditMemo.amount)}</Row>
                <Row isDark={isDark} label="Applied">{money(cm.creditMemo.applied)}</Row>
                <Row isDark={isDark} label="Remaining">{money(cm.creditMemo.balance)}</Row>
                <Row isDark={isDark} label="Lines">{cm.lines.map(l => `${l.product ?? l.name} ${money(l.chargeAmount)}`).join(" · ") || "—"}</Row>
              </>}
              <Row isDark={isDark} label="Invoice">{result.invoice.number} <StatusPill status={result.invoice.status} isDark={isDark} /></Row>
              <Row isDark={isDark} label="Previous Balance">{money(result.previousBalance)}</Row>
              <Row isDark={isDark} label="Current Balance">{money(result.invoice.balance)}</Row>
              <Row isDark={isDark} label="Credits Applied">{money(result.invoice.creditsApplied)}</Row>
            </div>
          </Panel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!cm && <PrimaryButton label={busy === "status" ? "Checking…" : "Refresh Status"} icon="refresh" isDark={isDark} disabled={!!busy} onClick={refreshStatus} />}
            {cm && <PrimaryButton label="View Credit Memo" icon="eye" isDark={isDark} onClick={() => nav.onNavigate({ mode: "detail", id: cm.creditMemo.id })} />}
            <GhostButton label="View Invoice" icon="file-text" isDark={isDark} onClick={() => nav.onOpenInvoice(result.invoice.id)} />
            <GhostButton label="Back to Credit Memos" icon="list" isDark={isDark} onClick={() => nav.onNavigate({ mode: "dashboard" })} />
          </div>
        </div>
      </PageShell>
    );
  }

  const pv = preview?.data;
  return (
    <PageShell footer={
      <FooterBar isDark={isDark}>
        <GhostButton label="Cancel" icon="x" isDark={isDark} onClick={() => nav.onNavigate({ mode: "dashboard" })} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {busy && <Spinner isDark={isDark} size={13} />}
          <PrimaryButton label={busy === "review" ? "Validating…" : "Review Credit Memo"} icon="check-circle" isDark={isDark} disabled={!invoice || !m || !!busy || !amountOk || allocMismatch} onClick={review} />
        </div>
      </FooterBar>}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>Create Credit Memo</div>
          <div style={{ fontSize: 11.5, color: t.dim }}>Uses Salesforce&apos;s credit API for invoices, which creates, posts and applies the credit memo to the invoice&apos;s lines. Nothing is written until you confirm; the server re-reads the invoice, lines and your permissions first.</div>
        </div>
        <Stepper isDark={isDark} current={step} steps={CREATE_STEPS} />
        {m && !canCreate && <CreditUnavailable isDark={isDark} model={m} />}
        {model.error && <ErrorPanel isDark={isDark} error={model.error} />}

        <div style={{ borderRadius: 16, padding: 16, border: `1px solid ${t.accent}45`, background: isDark ? "linear-gradient(135deg, rgba(0,212,255,0.08), rgba(30,144,255,0.04))" : "linear-gradient(135deg, rgba(0,152,204,0.07), rgba(9,104,211,0.03))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 800, color: t.heading }}>
            <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="sparkles" s={15} /></span> Describe the credit
            <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, border: `1px solid ${t.border}`, borderRadius: 999, padding: "1px 8px" }}>OPTIONAL</span>
          </div>
          <div style={{ fontSize: 12, color: t.dim, margin: "4px 0 10px" }}>The AI only fills this form — the invoice is resolved by its number and lines by their names in Salesforce. You review and confirm.</div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2} placeholder='e.g. "Credit the Keyboard line of DOC-000000001 by 5."' style={{ ...inputStyle(t), flex: "1 1 380px", resize: "vertical", fontSize: 13.5 }} />
            <PrimaryButton label={busy === "ai" ? "Analyzing…" : "Analyze & Fill"} icon="sparkles" isDark={isDark} disabled={!prompt.trim() || !!busy} onClick={analyze} />
          </div>
          {ai && (
            <div style={{ marginTop: 10, fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ color: ai.invoice ? "#00C875" : t.error, fontWeight: 700 }}>{ai.invoice ? `✓ Invoice ${ai.invoice.number} found in Salesforce${ai.line ? ` · line ${ai.line.name}` : ""}` : `✗ ${ai.invoiceMessage}`}</span>
              <WarningsDisclosure isDark={isDark} warnings={ai.warnings} />
            </div>
          )}
          <div style={{ marginTop: 10 }}><PromptGuide isDark={isDark} config={billingPromptGuides.creditMemo} onUseExample={setPrompt} /></div>
        </div>

        {error && <ErrorPanel isDark={isDark} error={error} />}
        {notice && <div style={{ fontSize: 12.5, color: t.warn, fontWeight: 600, padding: "8px 12px", borderRadius: 10, border: `1px solid ${t.warn}55`, background: `${t.warn}0c` }}>⚠ {notice}</div>}

        <Panel isDark={isDark} title="1. Invoice" icon="file-text" right={invoice ? <GhostButton label="Change" icon="edit" isDark={isDark} onClick={() => choose(null)} /> : null}>
          {initialInvoiceId && prefill.loading && picked === undefined && <LoadingRow isDark={isDark} label="Loading the invoice from Salesforce…" />}
          {prefill.error && picked === undefined && <ErrorPanel isDark={isDark} error={prefill.error} />}
          {!invoice && !(initialInvoiceId && prefill.loading && picked === undefined) && <InvoicePicker isDark={isDark} onPick={choose} purpose="credit" />}
          {invoice && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 8 }}>
              <Row isDark={isDark} label="Invoice Number">{invoice.number}</Row>
              <Row isDark={isDark} label="Account">{invoice.account?.name ?? "—"}</Row>
              <Row isDark={isDark} label="Status"><StatusPill status={invoice.status} isDark={isDark} /></Row>
              <Row isDark={isDark} label="Total">{money(invoice.total, invoice.currency)}</Row>
              <Row isDark={isDark} label="Current Balance">{money(invoice.balance, invoice.currency)}</Row>
              <Row isDark={isDark} label="Payments Applied">{money(invoice.paymentsApplied, invoice.currency)}</Row>
              <Row isDark={isDark} label="Credits Applied">{money(invoice.creditsApplied, invoice.currency)}</Row>
              {invoice.orders.length > 0 && <Row isDark={isDark} label="Order">{invoice.orders.map(o => o.number).join(", ")}</Row>}
              {!/^posted$/i.test(invoice.status ?? "") && <div style={{ gridColumn: "1 / -1", fontSize: 12.5, color: t.error, fontWeight: 600 }}>✗ Salesforce credits only Posted invoices.</div>}
            </div>
          )}
        </Panel>

        {invoice && m && (
          <>
            <Panel isDark={isDark} title="2. Lines & Credit Amount" icon="layers" right={
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <label style={{ fontSize: 11.5, color: t.dim, display: "flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={manual} onChange={e => { setManual(e.target.checked); setPreview(null); if (!e.target.checked) setAlloc(null); }} /> Choose lines</label>
                <GhostButton label="Auto Allocate" icon="wand" isDark={isDark} disabled={!amountOk} onClick={() => { setAlloc(null); setPreview(null); }} />
              </div>}>
              <div style={{ maxWidth: 280, marginBottom: 10 }}>
                <Field t={t} label={`Credit Amount${invoice.currency ? ` (${invoice.currency})` : ""} *`}>
                  <input type="number" step="0.01" min="0.01" value={amount} onChange={e => { setAmount(e.target.value); setPreview(null); if (!manual) setAlloc(null); }} style={{ ...inputStyle(t), fontSize: 13 }} />
                </Field>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead><tr>{["Product / Line", "Line Amount", "Already Credited", "Can Credit", "Credit Allocation"].map(h => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: t.dim, fontSize: 10.5, textTransform: "uppercase", borderBottom: `1px solid ${t.border}` }}>{h}</th>)}</tr></thead>
                <tbody>{invoice.lines.map(l => {
                  const v = allocation[l.id] ?? "0.00";
                  const over = Number.isFinite(Number(v)) && toCents(v) > toCents(allowable(l));
                  return (
                    <tr key={l.id} style={{ borderBottom: `1px solid ${t.border}` }}>
                      <td style={{ padding: "6px 8px", fontWeight: 700, color: t.heading }}>{l.product ?? l.name}</td>
                      <td style={{ padding: "6px 8px" }}>{money(l.amount, invoice.currency)}</td>
                      <td style={{ padding: "6px 8px" }}>{money(l.creditsApplied ?? 0, invoice.currency)}</td>
                      <td style={{ padding: "6px 8px" }}>{money(allowable(l), invoice.currency)}</td>
                      <td style={{ padding: "6px 8px", width: 150 }}>{manual
                        ? <input type="number" step="0.01" min="0" value={v} onChange={e => { setAlloc({ ...allocation, [l.id]: e.target.value }); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 12.5, padding: "5px 8px", borderColor: over ? t.error : undefined }} />
                        : <strong style={{ color: t.heading }}>{money(Number(v), invoice.currency)}</strong>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
              <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: allocMismatch ? t.error : t.dim }}>Allocated {money(allocTotal / 100, invoice.currency)} of {amountOk ? money(amountNum, invoice.currency) : "—"}{allocMismatch ? " — Credit Memo allocation does not equal the credit amount." : ""}</div>
            </Panel>
            <Panel isDark={isDark} title="3. Reason & Tax" icon="sliders">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                <Field t={t} label="Reason">
                  {m.reasonValues.length
                    ? <div style={{ fontSize: 12, color: t.dim, paddingTop: 8 }}>{m.reasonField?.name} values exist but Salesforce&apos;s credit API doesn&apos;t accept a reason code — describe the reason below.</div>
                    : <div style={{ fontSize: 12, color: t.dim, paddingTop: 8 }}>No credit memo reason codes are configured in this Salesforce org — describe the reason below.</div>}
                </Field>
                <Field t={t} label="Tax Strategy *"><select value={taxValue} onChange={e => { setTax(e.target.value); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 13 }}>{m.taxStrategies.map(s => <option key={s} value={s}>{s}</option>)}</select></Field>
                <Field t={t} label="Effective Date"><input type="date" value={effective} onChange={e => { setEffective(e.target.value); setPreview(null); }} style={{ ...inputStyle(t), fontSize: 13 }} /></Field>
                <div style={{ gridColumn: "1 / -1" }}><Field t={t} label="Description / Reason"><input value={description} maxLength={200} onChange={e => { setDescription(e.target.value); setPreview(null); }} placeholder="Why is this credit being issued?" style={{ ...inputStyle(t), fontSize: 13 }} /></Field></div>
              </div>
            </Panel>
          </>
        )}
      </div>

      <AnimatePresence>
        {pv && preview && (
          <Modal isDark={isDark} title="Credit Memo Preview" tone={pv.valid && !permissionBlocked ? "accent" : "warn"} actions={<>
            <GhostButton label="Cancel" isDark={isDark} onClick={() => setPreview(null)} />
            <span title={permissionBlocked ? "Credit Memo creation is not available for your Salesforce user" : !pv.valid ? "Fix the issues above first" : undefined} aria-disabled={!canConfirm} style={{ display: "inline-flex" }}>
              <PrimaryButton label={busy === "confirm" ? "Creating…" : "Confirm & Create Credit Memo"} icon={permissionBlocked ? "lock" : "check"} isDark={isDark} disabled={!canConfirm} onClick={confirm} />
            </span>
          </>}>
            {pv.preview && <>
              <Row isDark={isDark} label="Invoice">{pv.invoice.number}</Row>
              <Row isDark={isDark} label="Account">{pv.invoice.account?.name ?? "—"}</Row>
              <Row isDark={isDark} label="Current Invoice Balance">{money(pv.preview.balanceBefore)}</Row>
              <Row isDark={isDark} label="Credit Amount">{money(pv.preview.amount)}</Row>
              <Row isDark={isDark} label="Allocation">{pv.preview.allocation.map(a => `${a.label}: ${money(a.amount)}`).join(" · ") || "—"}</Row>
              <Row isDark={isDark} label="Reason">{pv.preview.description ?? "—"}</Row>
              <Row isDark={isDark} label="Tax Strategy / Effective">{pv.preview.taxStrategy} · {pv.preview.effectiveDate}</Row>
              <Row isDark={isDark} label="Expected Invoice Balance"><span style={{ color: "#00C875" }}>{money(pv.preview.expectedBalance)}</span></Row>
              {pv.preview.statusAfter && <Row isDark={isDark} label="Expected status after creation">{pv.preview.statusAfter} (Salesforce&apos;s credit API creates and posts the credit memo)</Row>}
            </>}
            {permissionBlocked && m && <CreditUnavailable isDark={isDark} model={m} />}
            {pv.checks.filter(c => c.status === "failed" && c.id !== "permission").map(c => <div key={c.id} style={{ color: t.error, fontWeight: 600 }}>✗ {c.detail}</div>)}
            <WarningsDisclosure isDark={isDark} warnings={pv.warnings} />
            {permissionBlocked && (
              <div>
                <button type="button" onClick={() => setShowTech(v => !v)} style={{ background: "none", border: "none", padding: 0, color: t.dim, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>{showTech ? "Hide technical details" : "Technical details"}</button>
                {showTech && <div style={{ marginTop: 6 }}><CodeBlock open isDark={isDark} data={{ capability: m?.capabilities.find(c => c.id === "create") ?? null, permission: m?.permission ?? null, block: m?.block ?? null }} /></div>}
              </div>
            )}
            <div style={{ fontSize: 11.5, color: t.dim }}>&ldquo;Expected&rdquo; values are projections. On confirm the server re-reads the invoice, its lines and your permissions; Salesforce then processes the credit, and the result shows Salesforce&apos;s actual values.</div>
          </Modal>
        )}
      </AnimatePresence>
    </PageShell>
  );
}

/* ───────────────────────── Details ───────────────────────── */

function Detail({ isDark, nav, id }: { isDark: boolean; nav: Nav; id: string }) {
  const t = tokens(isDark);
  const model = useBillingData<CreditMemoModel>("Discover credit memos", "/api/billing/credit-memos/model");
  const d = useBillingData<CreditMemoDetail & { stateToken: string }>("Load credit memo", `/api/billing/credit-memos/${id}`);
  const [busy, setBusy] = useState<null | "post" | "void" | "apply">(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const notifier = useNotify();
  const [applyAmount, setApplyAmount] = useState("");
  const [raw, setRaw] = useState(false);
  const data = d.data, m = model.data;
  if (!data) return <div style={{ padding: 20 }}>{d.error ? <ErrorPanel isDark={isDark} error={d.error} /> : <LoadingRow isDark={isDark} label="Loading the credit memo from Salesforce…" />}</div>;
  const cm = data.creditMemo;
  const cap = (k: string) => !!m?.capabilities.find(c => c.id === k)?.available;
  const accountUrl = cm.account ? cm.salesforceUrl.replace(/\/CreditMemo\/[^/]+\/view$/, `/Account/${cm.account.id}/view`) : null;

  async function act(action: "post" | "void" | "apply") {
    setBusy(action); setError(null); setNotice(null);
    try {
      const r = await quoteApiPost<{ message: string }>(`${action} credit memo`, `/api/billing/credit-memos/${id}/${action}`, action === "apply" ? { invoiceId: data!.invoice?.id, amount: Number(applyAmount), invoiceToken: data!.invoice?.token, stateToken: data!.stateToken } : { stateToken: data!.stateToken });
      setNotice(r.message); d.reload();
      notifier.success(`Credit Memo ${action === "post" ? "Posted" : action === "void" ? "Voided" : "Applied"}`, r.message, { module: "Credit Memos", records: [{ objectApiName: "CreditMemo", recordId: cm.id, recordName: cm.number ?? cm.id, salesforceUrl: cm.salesforceUrl }] });
    } catch (err) { setError(toBillingErrorPanel(err, `Salesforce didn't ${action} the credit memo`)); } finally { setBusy(null); }
  }

  return (
    <PageShell>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ fontSize: 19, fontWeight: 800, color: t.heading }}>{cm.number}</span><StatusPill status={cm.status} isDark={isDark} /></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {cm.invoice && <GhostButton label={`View Invoice ${cm.invoice.number ?? ""}`.trim()} icon="file-text" isDark={isDark} onClick={() => nav.onOpenInvoice(cm.invoice!.id)} />}
            {data.order && <GhostButton label={`View Order ${data.order.number ?? ""}`.trim()} icon="shopping-cart" isDark={isDark} onClick={() => nav.onOpenOrder(data.order!.id)} />}
            {data.order?.scheduleIds[0] && <GhostButton label="View Billing Schedule" icon="calendar" isDark={isDark} onClick={() => nav.onOpenSchedule(data.order!.scheduleIds[0])} />}
            {accountUrl && <GhostButton label="View Account" icon="building" isDark={isDark} onClick={() => window.open(accountUrl, "_blank", "noopener")} />}
            <GhostButton label="Refresh" icon="refresh" isDark={isDark} onClick={d.reload} />
            <GhostButton label="Open in Salesforce" icon="external-link" isDark={isDark} onClick={() => window.open(cm.salesforceUrl, "_blank", "noopener")} />
          </div>
        </div>
        {error && <ErrorPanel isDark={isDark} error={error} />}
        {notice && <div style={{ fontSize: 12.5, color: "#00C875", fontWeight: 600 }}>✓ {notice}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
          <Panel isDark={isDark} title="Credit Memo" icon="file-text">
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <Row isDark={isDark} label="Number">{cm.number}</Row>
              <Row isDark={isDark} label="Status"><StatusPill status={cm.status} isDark={isDark} /></Row>
              <Row isDark={isDark} label="Account">{cm.account?.name ?? "—"}</Row>
              <Row isDark={isDark} label="Invoice">{cm.invoice?.number ?? "—"}</Row>
              <Row isDark={isDark} label="Credit Date">{day(cm.creditDate)}</Row>
              <Row isDark={isDark} label="Effective Date">{day(cm.effectiveDate)}</Row>
              {cm.reasonCode && <Row isDark={isDark} label="Reason Code">{cm.reasonCode}</Row>}
              {cm.description && <Row isDark={isDark} label="Description">{cm.description}</Row>}
              {cm.sourceAction && <Row isDark={isDark} label="Source">{cm.sourceAction}{cm.category ? ` · ${cm.category}` : ""}</Row>}
            </div>
          </Panel>
          <Panel isDark={isDark} title="Amounts" icon="layers">
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <Row isDark={isDark} label="Total with Tax">{money(cm.amount)}</Row>
              <Row isDark={isDark} label="Applied">{money(cm.applied)}</Row>
              <Row isDark={isDark} label="Remaining">{money(cm.balance)}</Row>
              {data.invoice && <Row isDark={isDark} label={`Invoice ${data.invoice.number} balance`}>{money(data.invoice.balance)}</Row>}
            </div>
          </Panel>
        </div>
        <Panel isDark={isDark} title="Actions" icon="zap">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            {/^draft$/i.test(cm.status ?? "") && <PrimaryButton label={busy === "post" ? "Posting…" : "Post Credit Memo"} icon="send" isDark={isDark} disabled={!cap("post") || !!busy} onClick={() => act("post")} />}
            {/^posted$/i.test(cm.status ?? "") && (cm.balance ?? 0) > 0 && data.invoice && <>
              <input type="number" step="0.01" min="0.01" value={applyAmount} onChange={e => setApplyAmount(e.target.value)} placeholder={`Up to ${Math.min(cm.balance ?? 0, data.invoice.balance ?? 0)}`} style={{ ...inputStyle(t), width: 160, fontSize: 12.5 }} />
              <PrimaryButton label={busy === "apply" ? "Applying…" : `Apply Credit Memo to ${data.invoice.number}`} icon="link" isDark={isDark} disabled={!cap("apply") || !!busy || !(Number(applyAmount) > 0)} onClick={() => act("apply")} />
            </>}
            {/^posted$/i.test(cm.status ?? "") && <GhostButton label={busy === "void" ? "Voiding…" : "Void Credit Memo"} icon="x" isDark={isDark} danger disabled={!cap("void") || !!busy} onClick={() => act("void")} />}
            {m && !cap("apply") && !cap("post") && <span style={{ fontSize: 12, color: t.warn }}>⚠ This operation is not currently enabled for this Salesforce org/user.</span>}
          </div>
        </Panel>
        <Panel isDark={isDark} title="Credit Memo Lines" icon="list">
          {data.lines.length === 0 ? <div style={{ fontSize: 12.5, color: t.dim }}>No credit memo lines.</div> : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>{["Line", "Type", "Product", "Charge", "Line Amount", "Remaining", "Invoice Line"].map(h => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: t.dim, fontSize: 10.5, textTransform: "uppercase", borderBottom: `1px solid ${t.border}` }}>{h}</th>)}</tr></thead>
              <tbody>{data.lines.map(l => <tr key={l.id} style={{ borderBottom: `1px solid ${t.border}` }}><td style={{ padding: "6px 8px", fontWeight: 700 }}>{l.name}</td><td style={{ padding: "6px 8px" }}>{l.type ?? "—"}</td><td style={{ padding: "6px 8px" }}>{l.product ?? "—"}</td><td style={{ padding: "6px 8px" }}>{money(l.chargeAmount)}</td><td style={{ padding: "6px 8px" }}>{money(l.lineAmount)}</td><td style={{ padding: "6px 8px" }}>{money(l.balance)}</td><td style={{ padding: "6px 8px" }}>{l.invoiceLine?.name ?? "—"}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
        <Panel isDark={isDark} title="Applications (Credit Memo → Invoice / Invoice Line)" icon="link">
          {data.applications.length === 0 ? <div style={{ fontSize: 12.5, color: t.dim }}>This credit memo isn&apos;t applied to any invoice.</div> : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>{["Application", "Object", "Type", "Amount", "Invoice", "Invoice Line", "Date", "Unapplied"].map(h => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: t.dim, fontSize: 10.5, textTransform: "uppercase", borderBottom: `1px solid ${t.border}` }}>{h}</th>)}</tr></thead>
              <tbody>{data.applications.map(a => <tr key={a.id} style={{ borderBottom: `1px solid ${t.border}` }}><td style={{ padding: "6px 8px", fontWeight: 700 }}>{a.number}</td><td style={{ padding: "6px 8px" }}>{a.level === "line" ? "CreditMemoLineInvoiceLine" : "CreditMemoInvApplication"}</td><td style={{ padding: "6px 8px" }}>{a.type}</td><td style={{ padding: "6px 8px" }}>{money(a.amount)}</td><td style={{ padding: "6px 8px" }}>{a.invoice?.number ?? "—"}</td><td style={{ padding: "6px 8px" }}>{a.invoiceLine?.name ?? "—"}</td><td style={{ padding: "6px 8px" }}>{day(a.date)}</td><td style={{ padding: "6px 8px" }}>{a.unapplied ?? "—"}</td></tr>)}</tbody>
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

/**
 * Revenue Cloud Billing — Credit Memos: dashboard/history, details (post / apply / void when the org and user allow it)
 * and Create Credit Memo (manual + AI) on one shared server service (lib/billing/server/creditMemos.ts). Opened from the
 * Credit Memos card, Invoice details and the Order Billing Setup.
 */
export default function BillingCreditMemosWorkspace({ isDark, view, ...nav }: { isDark: boolean; view: CreditMemosView } & Nav) {
  if (view.mode === "create") return <CreateCreditMemo isDark={isDark} nav={nav} initialInvoiceId={view.invoiceId} />;
  if (view.mode === "detail") return <Detail isDark={isDark} nav={nav} id={view.id} />;
  return <Dashboard isDark={isDark} nav={nav} />;
}
