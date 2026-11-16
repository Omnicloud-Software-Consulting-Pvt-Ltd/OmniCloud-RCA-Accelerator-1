"use client";

import { useEffect, useState } from "react";
import { tokens, inputStyle, PrimaryButton, GhostButton, ErrorPanel, Field } from "@/components/data/quotes/shared";
import { Panel, StatusPill, Modal, Row, LoadingRow, useBillingData } from "@/components/data/billing/billingUi";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiGet, quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import type { TaxDashboard } from "@/lib/tax/types";
import type { TaxRunList, TaxRunState } from "@/lib/tax/server/verification";
import { CATEGORY_LABEL, Notice, Table, money, newKey, pct, withConnection } from "@/components/data/billing/tax/taxUi";
import SalesforceLookup from "@/components/data/taxes/SalesforceLookup";
import type { LookupOption } from "@/lib/tax/types";

/** A product the caller already knows (the dashboard's taxable products, a configuration's products) — used only to pre-select. */
export interface KnownProduct { id: string; name: string; code: string | null }
const asOption = (p: KnownProduct): LookupOption => ({ id: p.id, label: p.name, code: p.code, detail: null, badge: null });

const STEP_ICON: Record<string, string> = { done: "✓", failed: "✗", current: "→", processing: "⏳", pending: "○" };
export interface VerificationNav { onOpenRun: (orderId: string) => void; onOpenInvoice: (invoiceId: string) => void; onBack: () => void }

export interface RunDefaults { productId?: string | null; productName?: string | null; accountName?: string | null; quantity?: number | null; unitPrice?: number | null }

/**
 * Starts a REAL Salesforce transaction for a configured product: the server first checks that Salesforce can calculate tax and
 * that the product's tax chain resolves, then creates the Draft order. The tax itself comes only from Salesforce afterwards.
 * `products` only pre-selects a product (the requested one, or the only one); the lookup searches every active Salesforce product.
 */
export function StartRunForm({ isDark, products, defaults, blockedReason, onStarted, title = "End-to-end tax verification" }: {
  isDark: boolean; products: KnownProduct[]; defaults?: RunDefaults | null; blockedReason?: string | null; onStarted: (orderId: string) => void; title?: string;
}) {
  const t = tokens(isDark);
  const notify = useSalesforceSuccess();
  const wanted = defaults?.productName?.toLowerCase() ?? null;
  const initialProduct = (defaults?.productId ? products.find(p => p.id === defaults.productId) : null)
    ?? (wanted ? products.find(p => p.name.toLowerCase() === wanted || p.code?.toLowerCase() === wanted) : null)
    ?? (products.length === 1 ? products[0] : null);
  const [product, setProduct] = useState<LookupOption | null>(initialProduct ? asOption(initialProduct) : null);
  const productId = product?.id ?? "";
  // A picked Account record (its Id is sent); a prefilled name is resolved to the one exactly matching account.
  const [account, setAccount] = useState<LookupOption | null>(null);
  const noBillingAddress = account?.facts?.billingComplete === false;
  const [quantity, setQuantity] = useState(String(defaults?.quantity ?? 1));
  const [unitPrice, setUnitPrice] = useState(defaults?.unitPrice ? String(defaults.unitPrice) : "");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ panel: ErrorPanelDataLike; adminAction: string | null } | null>(null);
  async function start() {
    if (!confirm) return;
    setBusy(true); setError(null);
    try {
      const r = await quoteApiPost<{ orderId: string; orderNumber: string | null; duplicate: boolean }>("Start tax calculation", "/api/billing/tax/runs", { product: { id: productId }, accountId: account!.id, quantity: Number(quantity) || 1, unitPrice: unitPrice.trim() ? Number(unitPrice.replace(/[,₹\s]/g, "")) : null, key: confirm, confirm: true });
      notify({ title: r.duplicate ? "Tax Transaction Already Created" : "Tax Transaction Created", message: `Order ${r.orderNumber ?? r.orderId} — Salesforce bills it and calculates the tax`, records: [{ objectApiName: "Order", recordId: r.orderId, recordName: r.orderNumber ?? r.orderId, salesforceUrl: "" }], module: "Tax", context: "tax" });
      onStarted(r.orderId);
    } catch (err) {
      const panel = toBillingErrorPanel(err, "The tax calculation didn't start");
      setError({ panel, adminAction: ((panel as { raw?: { adminAction?: string | null } }).raw?.adminAction) ?? null });
    } finally { setBusy(false); setConfirm(null); }
  }
  const input = { ...inputStyle(t), padding: "7px 10px" };
  return (
    <>
      {blockedReason && <Notice isDark={isDark} tone="error"><b>Salesforce tax engine: BLOCKED.</b> {blockedReason} No transaction is created until Salesforce can calculate tax (see Engine Readiness).</Notice>}
      <Panel isDark={isDark} title={title} icon="play-circle">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
          <Field label="Taxable product" isDark={isDark}>
            <SalesforceLookup isDark={isDark} object="Product2" label="Taxable product" value={product} onChange={setProduct} disabled={busy} resolveText={initialProduct ? null : defaults?.productName} placeholder="Search by product name or code…" />
          </Field>
          <Field label="Customer account" isDark={isDark} hint={account && !noBillingAddress ? `Billing address: ${account.detail}` : "Required. Needs a billing address and a contact."}>
            <SalesforceLookup isDark={isDark} object="Account" label="Customer account" value={account} onChange={setAccount} disabled={busy} resolveText={defaults?.accountName} placeholder="Search accounts by name or number…" />
          </Field>
          <Field label="Quantity" isDark={isDark}><input value={quantity} onChange={e => setQuantity(e.target.value)} style={input} /></Field>
          <Field label="Unit price" isDark={isDark} hint="Blank uses the Standard Price Book price."><input value={unitPrice} onChange={e => setUnitPrice(e.target.value)} placeholder="10000" style={input} /></Field>
        </div>
        {noBillingAddress && (
          <div style={{ marginTop: 8 }}><Notice isDark={isDark} tone="error">
            Account &ldquo;{account!.label}&rdquo; has no complete billing address (street, city and country). Salesforce&apos;s billing schedules and tax need one — add it to the account in Salesforce, or pick another account.
          </Notice></div>
        )}
        {product?.facts?.taxable === false && (
          <div style={{ marginTop: 8 }}><Notice isDark={isDark} tone="warn">
            {product.facts.policyName ? <>&ldquo;{product.label}&rdquo; uses <b>{String(product.facts.policyName)}</b>, which doesn&apos;t resolve to an active taxable treatment.</> : <>&ldquo;{product.label}&rdquo; has no Tax Policy.</>} Salesforce&apos;s pre-check will stop the verification before any order is created — map it to a taxable policy in Tax → Create first.
          </Notice></div>
        )}
        <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <PrimaryButton label="Calculate tax in Salesforce" icon="play" isDark={isDark} disabled={!productId || !account || noBillingAddress || busy || !!blockedReason} onClick={() => setConfirm(newKey())} />
          <span style={{ fontSize: 12, color: t.dim }}>Order → Order Product → Billing Setup → Activation → Billing Schedule → Invoice → Salesforce tax → InvoiceLineTax → Posting.</span>
        </div>
      </Panel>
      {error && <div style={{ display: "grid", gap: 8 }}><ErrorPanel isDark={isDark} error={error.panel} />{error.adminAction && <Notice isDark={isDark} tone="warn"><b>Suggested correction (Salesforce admin):</b> {error.adminAction}</Notice>}</div>}
      {confirm && (
        <Modal isDark={isDark} title="Create a real transaction in Salesforce?" tone="accent" actions={<>
          <GhostButton label="Back" isDark={isDark} onClick={() => setConfirm(null)} />
          <PrimaryButton label={busy ? "Working…" : "Confirm"} icon="check" isDark={isDark} disabled={busy} onClick={() => void start()} />
        </>}>
          <div style={{ fontSize: 12.5, color: t.body, display: "grid", gap: 6 }}>
            <div>A Draft order for <b>{account?.label}</b>{account?.detail ? <> (billing: {account.detail})</> : null} with <b>{product?.label}</b> × {quantity}{unitPrice ? <> at <b>{unitPrice}</b></> : null} is created and billed through Salesforce. Salesforce calculates the tax on the invoice; the app only reads it.</div>
            <div>No tax configuration is created or changed.</div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Start an end-to-end verification for a configured product, and list past verifications. Creates no tax configuration. */
export function VerificationHome({ isDark, conn, dashboard, nav }: { isDark: boolean; conn: string; dashboard: TaxDashboard; nav: VerificationNav }) {
  const runs = useBillingData<TaxRunList>("List tax verifications", withConnection("/api/billing/tax/runs", conn));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Notice isDark={isDark} tone="info"><b>Configuration successful</b> means the tax records exist and are linked. <b>Calculation successful</b> means a real Salesforce invoice carries InvoiceLineTax at the configured rate — only this verification proves it.</Notice>
      <StartRunForm isDark={isDark} products={dashboard.taxableProducts} blockedReason={dashboard.status.calculation !== "READY" ? dashboard.status.calculationDetail : null} onStarted={nav.onOpenRun} />
      <Panel isDark={isDark} title="Verification results" icon="list">
        {!runs.data ? (runs.error ? <ErrorPanel isDark={isDark} error={runs.error} /> : <LoadingRow isDark={isDark} label="Loading verifications…" />) : (
          <Table isDark={isDark} head={["Order", "Account", "Status", "Request", "Invoice", "Tax", "Total with tax", ""]} empty="No verification orders yet."
            rows={runs.data.runs.map(r => [r.orderNumber, r.account ?? "—", r.status ?? "—", r.description ?? "—", r.invoice ? `${r.invoice.number} · ${r.invoice.status}` : "—", money(r.invoice?.tax ?? null), money(r.invoice?.totalWithTax ?? null), <GhostButton key="o" label="Open" isDark={isDark} onClick={() => nav.onOpenRun(r.orderId)} />])} />
        )}
      </Panel>
    </div>
  );
}

/** One verification run: advances Salesforce one step at a time and shows Salesforce's own numbers and the 15 checks. */
export function VerificationRun({ isDark, orderId, conn, nav }: { isDark: boolean; orderId: string; conn: string; nav: VerificationNav }) {
  const t = tokens(isDark);
  const loaded = useBillingData<TaxRunState>("Read tax verification", withConnection(`/api/billing/tax/runs/${orderId}`, conn));
  const [override, setOverride] = useState<TaxRunState | null>(null);
  const state = override ?? loaded.data;
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  /** A billable step awaiting the user's confirmation (activation, billing schedules, invoice generation, posting). */
  const [pending, setPending] = useState<NonNullable<TaxRunState["confirmation"]> | null>(null);
  async function run(retry = false, confirmed: string | null = null) {
    setRunning(true); setError(null); setPending(null);
    try {
      let st: TaxRunState | null = state;
      for (let i = 0; i < 40; i++) {
        if (st && !retry && (st.complete || st.failure || !st.next)) break;
        if (st?.next?.action === "wait") { await new Promise(r => setTimeout(r, 5000)); st = await quoteApiGet<TaxRunState>("Read tax verification", `/api/billing/tax/runs/${orderId}`); setOverride(st); continue; }
        // Billable steps pause for an explicit confirmation of that exact step; one confirmation runs one step.
        if (st?.confirmation && st.confirmation.action !== confirmed && !retry) { setPending(st.confirmation); break; }
        const confirm = st?.confirmation && st.confirmation.action === confirmed ? confirmed : null;
        st = await quoteApiPost<TaxRunState>("Advance tax verification", `/api/billing/tax/runs/${orderId}`, { retry, confirm });
        if (confirm) confirmed = null;
        retry = false;
        setOverride(st);
        if (st.confirmation && st.confirmation.action !== confirmed) { setPending(st.confirmation); break; }
      }
    } catch (err) { setError(toBillingErrorPanel(err, "The verification step failed")); } finally { setRunning(false); }
  }
  const canAutoStart = !started && !!state && !running && !state.complete && !state.failure && !!state.next;
  useEffect(() => {
    if (!canAutoStart) return;
    const h = setTimeout(() => { setStarted(true); void run(); }, 0);
    return () => clearTimeout(h);
    // run is recreated each render; canAutoStart gates the single auto-start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoStart]);
  if (!state) return loaded.error ? <ErrorPanel isDark={isDark} error={loaded.error} /> : <LoadingRow isDark={isDark} label="Reading the order, invoice and tax from Salesforce…" />;
  const c = state.currency, inv = state.invoice, first = state.items[0];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Notice isDark={isDark} tone={state.endToEnd === "SUCCESS" ? "ok" : state.endToEnd === "FAILED" ? "error" : "info"}><b>{state.message}</b></Notice>
      {pending && !running && (
        <Modal isDark={isDark} title="Confirm this Salesforce step?" tone="warn" actions={<>
          <GhostButton label="Not now" isDark={isDark} onClick={() => setPending(null)} />
          <PrimaryButton label="Confirm" icon="check" isDark={isDark} onClick={() => void run(false, pending.action)} />
        </>}>
          <div style={{ fontSize: 12.5, color: t.body }}>{pending.detail}</div>
        </Modal>
      )}
      <Panel isDark={isDark} title="Tax result (read from Salesforce)" icon="percent" right={<StatusPill status={state.endToEnd} isDark={isDark} />}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 6 }}>
          <Row isDark={isDark} label="Salesforce Org">{state.connection.orgName ?? state.connection.instanceUrl}{state.connection.orgId ? ` (${state.connection.orgId})` : ""}</Row>
          <Row isDark={isDark} label="Current User">{state.connection.displayName ?? "—"}{state.connection.username ? ` (${state.connection.username})` : ""}</Row>
          <Row isDark={isDark} label="Tax Engine">{first?.expectedTreatment?.engine ? `${first.expectedTreatment.engine.name} (${first.expectedTreatment.engine.type})` : "—"}</Row>
          <Row isDark={isDark} label="Tax Policy">{[...new Set(state.items.map(i => i.taxPolicy?.name ?? "—"))].join(", ")}</Row>
          <Row isDark={isDark} label="Tax Treatment">{[...new Set(state.items.map(i => i.expectedTreatment?.name ?? "—"))].join(", ")}</Row>
          <Row isDark={isDark} label="Tax Code / Rate">{[...new Set(state.items.map(i => (i.expectedRate ? `${i.expectedRate.taxCode} ${pct(i.expectedRate.rate)}` : i.expectedCode ?? "—")))].join(", ")}</Row>
          <Row isDark={isDark} label="Product">{state.items.map(i => `${i.product?.name}${i.product?.code ? ` (${i.product.code})` : ""} × ${i.quantity}`).join(", ")}</Row>
          <Row isDark={isDark} label="Order">{state.order.number} · {state.order.status}</Row>
          <Row isDark={isDark} label="Invoice">{inv ? <button type="button" onClick={() => nav.onOpenInvoice(inv.id)} style={{ background: "none", border: "none", padding: 0, color: t.accent, fontWeight: 700, cursor: "pointer" }}>{inv.number} · {inv.status}</button> : "—"}</Row>
          <Row isDark={isDark} label="Subtotal (Invoice.TotalChargeAmount)">{money(inv?.subtotal ?? null, c)}</Row>
          <Row isDark={isDark} label="Actual Salesforce Tax (InvoiceLineTax)">{inv ? money(inv.lines.reduce((sum, l) => sum + l.taxes.reduce((x, tx) => x + (tx.amount ?? 0), 0), 0), c) : "—"}</Row>
          <Row isDark={isDark} label="Invoice Tax (Invoice.TotalTaxAmount)">{money(inv?.tax ?? null, c)}</Row>
          <Row isDark={isDark} label="Total With Tax (Invoice.TotalAmountWithTax)">{money(inv?.totalWithTax ?? null, c)}</Row>
          <Row isDark={isDark} label="Tax Calculation"><StatusPill status={state.taxCalculation} isDark={isDark} /></Row>
          <Row isDark={isDark} label="Checks"><b style={{ color: state.checks.every(x => x.passed) ? "#00C875" : "#E2445C" }}>{state.checks.filter(x => x.passed).length} / {state.checks.length} PASS</b></Row>
        </div>
      </Panel>
      <Panel isDark={isDark} title="Billing lifecycle" icon="activity" right={state.failure ? (state.failure.retryLabel ? <GhostButton label={state.failure.retryLabel} icon="refresh-cw" isDark={isDark} disabled={running} onClick={() => void run(true)} /> : undefined) : state.next && !running ? <GhostButton label={state.next.label} icon="play" isDark={isDark} onClick={() => void run()} /> : undefined}>
        <div style={{ display: "grid", gap: 4 }}>
          {state.steps.map(s => (
            <div key={s.id} style={{ display: "grid", gridTemplateColumns: "22px 200px 1fr", gap: 8, fontSize: 12.5, color: s.state === "failed" ? "#E2445C" : s.state === "pending" ? t.dim : t.body }}>
              <span>{STEP_ICON[s.state]}</span><b>{s.label}</b><span style={{ color: t.dim }}>{s.detail}</span>
            </div>
          ))}
          {running && <LoadingRow isDark={isDark} label="Working in Salesforce…" />}
        </div>
      </Panel>
      {state.failure && <Notice isDark={isDark} tone="error"><b>{CATEGORY_LABEL[state.failure.category ?? "salesforce"] ?? "Salesforce"} problem{state.failure.code ? ` (${state.failure.code})` : ""}:</b> {state.failure.reason}</Notice>}
      {state.failure?.adminAction && <Notice isDark={isDark} tone="warn"><b>Action required in Salesforce:</b> {state.failure.adminAction}</Notice>}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {inv && (
        <Panel isDark={isDark} title="Invoice lines and Salesforce tax" icon="file-text">
          {/* The line total is DERIVED (charge + InvoiceLineTax). Salesforce's InvoiceLine.ChargeAmountWithTax isn't shown as one: in
              p10 it equals the charge on taxed Draft/Estimated lines. The invoice totals above are Salesforce's own invoice fields. */}
          <Table isDark={isDark} head={["Product", "Qty", "Unit price", "Charge", "Tax treatment", "Tax", "Charge + tax (derived)", "Tax status", "InvoiceLineTax"]} empty="No invoice lines."
            rows={inv.lines.map(l => [l.product ?? l.name, l.quantity, money(l.unitPrice, c), money(l.charge, c), l.treatment?.name ?? "—", money(l.taxAmount, c), l.totalWithTax?.basis === "derived" ? <span title={l.totalWithTax.detail}>{money(l.totalWithTax.value, c)}</span> : <span title={l.totalWithTax?.detail ?? "Not derived."} style={{ color: t.dim }}>unavailable</span>, l.taxStatus ?? "—", l.taxes.length ? l.taxes.map(x => `${x.name ?? "—"} · ${x.code ?? "—"} · ${pct(x.rate)} · ${money(x.amount, c)}${x.status ? ` (${x.status})` : ""}`).join("; ") : "none"])} />
        </Panel>
      )}
      <Panel isDark={isDark} title={`Verification (${state.checks.filter(x => x.passed).length}/${state.checks.length} passed)`} icon="check-circle">
        <div style={{ display: "grid", gap: 3 }}>
          {state.checks.map((x, i) => (
            <div key={x.id} style={{ display: "grid", gridTemplateColumns: "26px 50px 330px 1fr", gap: 6, fontSize: 12.5 }}>
              <span style={{ color: t.dim }}>{i + 1}.</span>
              <b style={{ color: x.passed ? "#00C875" : x.passed === false ? "#E2445C" : t.dim }}>{x.passed ? "PASS" : x.passed === false ? "FAIL" : "—"}</b>
              <span>{x.label}</span><span style={{ color: t.dim }}>{x.detail}</span>
            </div>
          ))}
        </div>
      </Panel>
      <div style={{ display: "flex", gap: 8 }}>
        <GhostButton label="Back to Verification" icon="arrow-left" isDark={isDark} onClick={nav.onBack} />
        <GhostButton label="Reload from Salesforce" icon="refresh-cw" isDark={isDark} onClick={() => { setOverride(null); loaded.reload(); }} />
      </div>
    </div>
  );
}
