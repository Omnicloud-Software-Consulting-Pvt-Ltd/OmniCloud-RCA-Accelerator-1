"use client";

import { useState, type ReactNode } from "react";
import { tokens, inputStyle, PrimaryButton, GhostButton, ErrorPanel, Field } from "@/components/data/quotes/shared";
import { Panel, Modal, LoadingRow } from "@/components/data/billing/billingUi";
import { QuoteApiError, quoteApiGet, quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { isRecoverableCalculationError, resultNeedsPlan } from "@/lib/tax/calcRecovery";
import CalculationPlanView from "@/components/data/taxes/CalculationPlanView";
import type { CalculationPlan } from "@/lib/tax/server/calculationPlan";
import { toBillingErrorPanel } from "@/lib/billing/client";
import { Notice, Table } from "@/components/data/billing/tax/taxUi";
import { Diagnostics } from "@/components/data/taxes/TaxCalcViews";
import type { SfTaxResult } from "@/lib/tax/server/salesforceTaxCalculation";
import type { DecisionTablePreview } from "@/lib/tax/server/calculationResult";
import type { InvoiceTaxTrace } from "@/lib/tax/server/invoiceTaxTrace";
import type { LookupOption } from "@/lib/tax/types";
import SalesforceLookup from "@/components/data/taxes/SalesforceLookup";

/**
 * Taxes → Tax Calculation. Validate → Preview Tax (Salesforce's decision-table evaluation — a preview, not tax) → Calculate with
 * Salesforce (order → activation → billing schedule → invoice → InvoiceLineTax, every billable step confirmed separately). The actual
 * tax is shown ONLY from Salesforce's InvoiceLineTax; the configured-rate amount is a labelled reference value. When Salesforce
 * produces no InvoiceLineTax, that is said prominently with the evidence and the read-only diagnostic trace.
 */

// Labels mirrored from calculationResult.ts (kept literal here so the client bundle doesn't import server modules).
const PREVIEW_LABEL = "Decision-table preview — not yet an invoice-time Salesforce tax result.";
const REFERENCE_LABEL = "Expected/reference amount — NOT a Salesforce calculation.";
const NO_INVOICE_LINE_TAX = "Salesforce did not generate an InvoiceLineTax record.";

const STATUS_COLOR: Record<string, string> = { CALCULATED: "#00C875", READY: "#00C875", PREVIEW_MATCH: "#00D4FF", NO_TAX_EXPECTED: "#8899AA", AWAITING_CONFIRMATION: "#F5A623", IN_PROGRESS: "#00D4FF", CALCULATION_PENDING: "#F5A623", CALCULATION_TIMEOUT: "#F5A623", CALCULATION_FAILED: "#E2445C", NOT_READY: "#E2445C" };
const STEP_LABEL: Record<string, string> = { "create-order": "Create Order", activate: "Activate Order", schedules: "Create Billing Schedule", "generate-invoice": "Generate Invoice", "post-invoice": "Post Invoice" };
const CHECK_COLOR = { PASS: "#00C875", WARN: "#F5A623", FAIL: "#E2445C" } as const;
const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const Id = ({ v }: { v: string | null | undefined }) => (v ? <code style={{ fontSize: 11 }}>{v}</code> : <>—</>);

function KV({ isDark, rows }: { isDark: boolean; rows: [string, ReactNode][] }) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 200px) 1fr", gap: "4px 12px", fontSize: 12.5 }}>
      {rows.map(([k, v]) => [<span key={`k${k}`} style={{ color: t.dim }}>{k}</span>, <span key={`v${k}`}>{v}</span>])}
    </div>
  );
}

function stages(r: SfTaxResult): { label: string; state: "done" | "current" | "pending" | "failed"; detail: string }[] {
  const step = (id: string) => r.run?.steps.find(s => s.id === id);
  const st = (s?: { state: string }) => (s?.state === "done" ? "done" : s?.state === "failed" ? "failed" : s?.state === "current" || s?.state === "processing" ? "current" : "pending") as "done" | "current" | "pending" | "failed";
  const inv = r.run?.invoice;
  const noIlt = r.status === "CALCULATION_FAILED" && !!inv;
  return [
    { label: "1–6. Validate & resolve", state: r.status === "NOT_READY" ? "failed" : r.validation?.status === "READY" || r.run ? "done" : "pending", detail: r.validation?.message ?? (r.run ? "READY (validated before the order was created)" : "") },
    { label: "7. Salesforce transaction (Order)", state: r.run ? "done" : r.awaiting?.step === "create-order" ? "current" : "pending", detail: r.run ? `${r.run.order.number} · ${r.run.order.status}` : "" },
    { label: "8. Order activation", state: r.run?.order.activated ? "done" : st(step("activate")), detail: r.run?.order.status ?? "" },
    { label: "9. Billing schedule", state: st(step("schedules")), detail: step("schedules")?.detail ?? "" },
    { label: "10. Invoice", state: inv ? "done" : st(step("invoice")), detail: inv ? `${inv.number} · ${inv.status}` : "" },
    { label: "11. Invoice line", state: inv?.lines.length ? "done" : "pending", detail: inv ? inv.lines.map(l => `${l.product ?? l.name} · ${money(l.charge)} · tax ${money(l.taxAmount)} · ${l.taxStatus ?? "—"}`).join(" · ") : "" },
    { label: "12. InvoiceLineTax", state: r.actual.length ? "done" : noIlt ? "failed" : inv ? "current" : "pending", detail: r.actual.map(a => a.invoiceLineTaxId).join(", ") || (noIlt ? "none — Salesforce created no InvoiceLineTax" : inv ? "none yet" : "") },
    { label: "13. Salesforce result", state: r.status === "CALCULATED" || r.status === "NO_TAX_EXPECTED" ? "done" : r.status === "CALCULATION_FAILED" ? "failed" : "pending", detail: `${r.status.replace(/_/g, " ")}${r.reason ? ` · ${r.reason}` : ""}` },
  ];
}

/**
 * Four separate verdicts — never merged: (1) configuration validation (records read from Salesforce), (2) Salesforce's
 * decision-table match (a preview, not tax), (3) Salesforce's invoice-time tax on the invoice line, (4) the InvoiceLineTax record.
 * Only (4) proves Salesforce calculated tax.
 */
function verdicts(r: SfTaxResult): { label: string; note: string; tone: "ok" | "fail" | "warn" | "idle"; value: string }[] {
  const v = r.validation;
  const p = r.preview ?? r.evidence?.preview ?? null;
  const line = r.run?.invoice?.lines[0] ?? null;
  const lineTax = line?.taxAmount ?? r.evidence?.invoiceLineTaxAmount ?? null;
  const lineStatus = line?.taxStatus ?? r.evidence?.taxProcessingStatus ?? null;
  const invoiced = !!(r.run?.invoice ?? r.evidence);
  const a = r.actual[0] ?? null;
  return [
    { label: "1 · Configuration validation", note: "records read from Salesforce", tone: !v ? "idle" : v.status === "READY" ? "ok" : "fail", value: !v ? "not run" : v.status === "READY" ? "READY" : `NOT READY${v.reason ? ` · ${v.reason.replace(/_/g, " ")}` : ""}` },
    { label: "2 · Decision-table match", note: "Salesforce evaluation — a preview, not tax", tone: !p ? "idle" : p.error ? "fail" : p.matched ? "ok" : "fail", value: !p ? "not evaluated" : p.error ? `ERROR ${p.error.code ?? p.error.status}` : p.matched ? `MATCH · ${p.rate ?? "?"}% ${p.applicationBasis ?? ""}` : "NO MATCH" },
    { label: "3 · Invoice tax calculation", note: "Salesforce's tax on the invoice line", tone: !invoiced ? "idle" : lineTax ? "ok" : "fail", value: !invoiced ? "no invoice yet" : `tax ${money(lineTax)} · ${lineStatus ?? "—"}` },
    { label: "4 · InvoiceLineTax verification", note: "the only proof of Salesforce tax", tone: a ? "ok" : invoiced ? "fail" : "idle", value: a ? `${a.invoiceLineTaxId} · ${money(a.taxAmount)} @ ${a.taxRate ?? "?"}%` : invoiced ? "NONE — no InvoiceLineTax record" : "pending" },
  ];
}

function VerdictStrip({ isDark, r }: { isDark: boolean; r: SfTaxResult }) {
  const t = tokens(isDark);
  const color = { ok: "#00C875", fail: "#E2445C", warn: "#F5A623", idle: t.dim };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 8 }}>
      {verdicts(r).map(x => (
        <div key={x.label} style={{ border: `1px solid ${color[x.tone]}66`, borderRadius: 10, padding: "8px 10px" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: t.heading }}>{x.label}</div>
          <div style={{ fontSize: 10.5, color: t.dim }}>{x.note}</div>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 4, color: color[x.tone], overflowWrap: "anywhere" }}>{x.value}</div>
        </div>
      ))}
    </div>
  );
}

export function PreviewView({ isDark, p }: { isDark: boolean; p: DecisionTablePreview }) {
  return (
    <Panel isDark={isDark} title="Decision-table preview" icon="eye" right={<b style={{ fontSize: 10.5, color: p.matched ? "#00D4FF" : "#E2445C" }}>{p.error ? "ERROR" : p.matched ? "MATCH (PREVIEW)" : "NO MATCH"}</b>}>
      <div style={{ display: "grid", gap: 8 }}>
        <Notice isDark={isDark} tone="info"><b>{PREVIEW_LABEL}</b></Notice>
        {p.error && <Notice isDark={isDark} tone="error">Salesforce&apos;s evaluation failed — HTTP {p.error.status} {p.error.code ?? ""}: {p.error.message}</Notice>}
        <KV isDark={isDark} rows={[
          ["Decision table", <>{p.decisionTableName ?? "—"} <Id v={p.decisionTableId} /></>],
          ["Salesforce outcome", p.outcomeType ?? "—"],
          ["Rate", p.rate !== null ? `${p.rate}%` : "—"],
          ["Application basis", p.applicationBasis ?? "—"],
          ["Priority", p.priority ?? "—"],
          ["Matched TaxRate", p.taxRate ? <>{p.taxRate.name} · {p.taxRate.taxCode ?? "—"} · {p.taxRate.rate ?? "?"}% <Id v={p.taxRate.id} /> {p.consistent === false ? <b style={{ color: "#E2445C" }}>≠ Salesforce&apos;s output</b> : null}</> : "—"],
          ["Inputs sent", <span key="c" style={{ fontSize: 11.5 }}>{p.conditions.map(c => `${c.fieldName} ${c.operator === "Equals" ? "=" : c.operator} ${c.value}`).join(" · ") || "—"}</span>],
        ]} />
      </div>
    </Panel>
  );
}

function TraceView({ isDark, tr }: { isDark: boolean; tr: InvoiceTaxTrace & { preview: DecisionTablePreview | null } }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel isDark={isDark} title="Diagnostic trace (read-only)" icon="list" right={<b style={{ fontSize: 10.5 }}>{tr.classification.replace(/_/g, " ")}</b>}>
        <div style={{ display: "grid", gap: 8 }}>
          <Notice isDark={isDark} tone={tr.classification === "CONFIGURATION_MATCH" ? "ok" : "warn"}>{tr.summary}</Notice>
          <Table isDark={isDark} head={["", "Object", "Record Id", "Status", "Relationship field", "Resolved value"]} empty="" rows={tr.chain.map((c, i) => [
            <b key="o" style={{ color: c.ok === false ? "#E2445C" : c.ok ? "#00C875" : "#8899AA" }}>{i ? "↓" : "•"}</b>, `${c.object}${c.name ? ` · ${c.name}` : ""}`, <Id key="i" v={c.recordId} />, c.status ?? "—", <code key="f" style={{ fontSize: 11 }}>{c.field}</code>, c.value ?? "—",
          ])} />
        </div>
      </Panel>
      {tr.preview && <PreviewView isDark={isDark} p={tr.preview} />}
      <Panel isDark={isDark} title="Invoice-time result & InvoiceLineTax" icon="file-text">
        <KV isDark={isDark} rows={[
          ["Invoice TaxAmount", money(tr.invoiceTime.invoiceTaxAmount)],
          ["Invoice line TaxAmount", money(tr.invoiceTime.lineTaxAmount)],
          ["Tax processing status", tr.invoiceTime.lineTaxStatus ?? "—"],
          ["InvoiceLineTax records", <b key="n" style={{ color: tr.invoiceTime.invoiceLineTaxCount ? "#00C875" : "#E2445C" }}>{tr.invoiceTime.invoiceLineTaxCount}</b>],
          ["RevenueTransactionErrorLog", tr.invoiceTime.errorLogCount],
        ]} />
      </Panel>
      <Panel isDark={isDark} title="What is proven" icon="check-circle">
        <div style={{ fontSize: 12.5, display: "grid", gap: 3 }}>
          {tr.proven.map(x => <div key={x}>✓ {x}</div>)}
          {tr.unproven.map(x => <div key={x} style={{ opacity: 0.75 }}>? {x}</div>)}
          <div style={{ marginTop: 4 }}><b>Next step:</b> {tr.nextStep}</div>
        </div>
      </Panel>
    </div>
  );
}

const NA = <span style={{ opacity: 0.7 }}>unavailable</span>;
const sum = (xs: (number | null | undefined)[]) => (xs.length && xs.every(x => typeof x === "number" && Number.isFinite(x)) ? Math.round((xs as number[]).reduce((a, b) => a + b, 0) * 100) / 100 : null);

/** One summary of the requested product / order / invoice, read from Salesforce: what was taxed, by which configuration, and the result. */
export function TaxResultSummary({ isDark, r }: { isDark: boolean; r: SfTaxResult }) {
  const run = r.run, inv = r.invoiceSummary ?? null, item = run?.items[0] ?? null, v = r.validation;
  if (!run && !inv) return null;
  const lines = inv?.lines ?? run?.invoice?.lines.map(l => ({ id: l.id, product: l.product ?? l.name, charge: l.charge, taxAmount: l.taxAmount, taxStatus: l.taxStatus, treatment: l.treatment?.name ?? null })) ?? [];
  const addr = run?.order.billingAddress ?? (v?.account ? { state: v.account.state, country: v.account.country, city: v.account.city, postalCode: v.account.postalCode } : null);
  const a = r.actual;
  const verdict = r.taxState ?? r.status;
  const tone = r.status === "CALCULATED" ? "#00C875" : r.status === "CALCULATION_FAILED" || r.status === "NOT_READY" ? "#E2445C" : "#F5A623";
  const val = (x: ReactNode | null | undefined) => (x === null || x === undefined || x === "" ? NA : x);
  return (
    <Panel isDark={isDark} title="Tax result (read from Salesforce)" icon="file-text" right={<b style={{ fontSize: 11, color: tone }}>{verdict.replace(/_/g, " ")}</b>}>
      <KV isDark={isDark} rows={[
        ["Product", val(item?.product ? `${item.product.name} · ${item.product.code ?? "no ProductCode"}` : lines[0]?.product ?? (v?.product ? `${v.product.name} · ${v.product.code ?? "no ProductCode"}` : null))],
        ["Order", val(run ? <>{run.order.number} · {run.order.status} <Id v={run.order.id} /></> : null)],
        ["Invoice", val(inv ? <>{inv.number ?? "—"} · <b>{inv.status ?? "—"}</b> <Id v={inv.id} /></> : run?.invoice ? <>{run.invoice.number} · {run.invoice.status}</> : null)],
        ["Customer", val(run?.order.account?.name ?? v?.account?.name)],
        ["Jurisdiction", val(addr ? [addr.city, addr.state, addr.country].filter(Boolean).join(", ") : null)],
        ["Tax Policy", val(item?.taxPolicy?.name)],
        ["Tax Treatment (order product)", val(item?.treatment?.name)],
        ["Tax Treatment used on the invoice line", val(lines.length ? [...new Set(lines.map(l => l.treatment ?? "none"))].join(", ") : null)],
        ["Tax code", val(a.length ? [...new Set(a.map(x => x.taxCode ?? "—"))].join(", ") : null)],
        ["Tax rate", val(a.length ? [...new Set(a.map(x => (x.taxRate === null ? "—" : `${x.taxRate}%`)))].join(", ") : null)],
        ["Taxable charge (invoice lines)", val(lines.length ? money(sum(lines.map(l => l.charge))) : null)],
        ["Tax amount (InvoiceLineTax)", a.length ? <b>{money(sum(a.map(x => x.taxAmount)))}</b> : <b style={{ color: inv ? "#E2445C" : undefined }}>{inv ? "none — Salesforce created no InvoiceLineTax" : "not calculated yet"}</b>],
        ["Total before tax (Invoice.TotalChargeAmount)", val(inv ? money(inv.subtotal) : null)],
        ["Total tax (Invoice.TotalTaxAmount)", val(inv ? money(inv.tax) : null)],
        ["Total including tax (Invoice.TotalAmountWithTax)", inv ? <b>{money(inv.totalWithTax)}</b> : NA],
        ["Tax processing status", val(lines.length ? [...new Set(lines.map(l => l.taxStatus ?? "—"))].join(", ") : null)],
        ["Verification", <span key="v" style={{ color: tone }}>{r.message}</span>],
      ]} />
    </Panel>
  );
}

function ResultView({ isDark, r, busy, autoConfirm, onConfirm, onRecheck, onTrace }: { isDark: boolean; r: SfTaxResult; busy: boolean; autoConfirm: boolean; onConfirm: (step: string) => void; onRecheck: () => void; onTrace: (invoiceId: string) => void }) {
  const t = tokens(isDark);
  // "Calculate with Salesforce" opens the create-order confirmation straight away; nothing runs until it is confirmed.
  const [confirming, setConfirming] = useState<boolean>(autoConfirm && r.awaiting?.step === "create-order");
  const ICON = { done: "✓", current: "→", pending: "○", failed: "✗" };
  const v = r.validation;
  const inv = r.run?.invoice ?? null;
  const line = inv?.lines[0] ?? null;
  const noIlt = !r.actual.length && (r.reason === "INVOICE_TIME_TAX_NOT_APPLIED" || (r.status === "CALCULATION_FAILED" && !!(inv ?? r.evidence)));
  const e = r.evidence;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <VerdictStrip isDark={isDark} r={r} />
      <TaxResultSummary isDark={isDark} r={r} />
      {v && (
        <Panel isDark={isDark} title="Tax Calculation" icon="dollar-sign" right={<b style={{ fontSize: 11, color: STATUS_COLOR[v.status] }}>{v.status.replace(/_/g, " ")}</b>}>
          <KV isDark={isDark} rows={[
            ["Account", v.account ? <>{v.account.name} <Id v={v.account.id} /></> : "—"],
            ["Product", v.product ? <>{v.product.name} · {v.product.code ?? "no code"} <Id v={v.product.id} /></> : "—"],
            ["Quantity", v.quantity ?? "—"],
            ["Unit Price", v.unitPrice !== null ? `${money(v.unitPrice)} (${v.unitPriceSource})` : "—"],
            ["Tax Treatment", v.treatment ? <>{v.treatment.treatmentName} · {v.treatment.isTaxable ? "taxable" : "not taxable"}{v.treatment.shouldUseTaxTreatmentItems ? " · uses items" : ""} <Id v={v.treatment.treatmentId} /></> : "—"],
            ["Tax Engine", v.engine ? <>{v.engine.name} · {v.engine.status} · {v.engine.type} <Id v={v.engine.id} /></> : "—"],
            ["Decision Table", v.decisionTable ? <>{v.decisionTable.name} · {v.decisionTable.status} · refresh {v.decisionTable.refreshStatus ?? "—"} <Id v={v.decisionTable.id} /></> : "—"],
            ["Tax Code", v.treatment?.taxCode ?? "—"],
            ["Tax Rate", v.rate ? <>{v.rate.name} · {v.rate.rate ?? "?"}% {v.rate.applicationBasis ?? ""} · {v.rate.usage ?? ""} <Id v={v.rate.id} /></> : "—"],
            ["Expected Tax", v.expected ? <span><b>{money(v.expected.taxAmount)}</b> <span style={{ color: t.dim }}>— {REFERENCE_LABEL}</span></span> : "—"],
          ]} />
        </Panel>
      )}
      <Panel isDark={isDark} title="Salesforce tax calculation" icon="zap" right={<b style={{ fontSize: 11, color: STATUS_COLOR[r.status] ?? "#888" }}>{r.status.replace(/_/g, " ")}{r.reason ? ` · ${r.reason.replace(/_/g, " ")}` : ""}</b>}>
        <div style={{ display: "grid", gap: 8 }}>
          {noIlt && <div style={{ border: "2px solid #E2445C", borderRadius: 8, padding: "10px 12px", fontSize: 14, fontWeight: 800, color: "#E2445C" }}>{NO_INVOICE_LINE_TAX}</div>}
          <Notice isDark={isDark} tone={r.status === "CALCULATED" || r.status === "READY" ? "ok" : r.status === "CALCULATION_FAILED" || r.status === "NOT_READY" ? "error" : r.status === "NO_TAX_EXPECTED" || r.status === "PREVIEW_MATCH" ? "info" : "warn"}>{r.message}</Notice>
          {(r.run || r.awaiting) && <div style={{ display: "grid", gap: 3 }}>
            {stages(r).map(s => (
              <div key={s.label} style={{ display: "grid", gridTemplateColumns: "20px 230px 1fr", gap: 8, fontSize: 12.5, color: s.state === "failed" ? "#E2445C" : s.state === "pending" ? t.dim : t.body }}>
                <span>{ICON[s.state]}</span><b>{s.label}</b><span>{s.detail}</span>
              </div>
            ))}
          </div>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {r.awaiting && <PrimaryButton label={`Confirm: ${STEP_LABEL[r.awaiting.step] ?? r.awaiting.step}…`} icon="check" isDark={isDark} disabled={busy} onClick={() => setConfirming(true)} />}
            {r.orderId && <GhostButton label="Re-check Salesforce" icon="refresh" isDark={isDark} disabled={busy} onClick={onRecheck} />}
            {r.invoiceId && <GhostButton label="Diagnostic trace" icon="list" isDark={isDark} disabled={busy} onClick={() => onTrace(r.invoiceId!)} />}
          </div>
        </div>
      </Panel>
      {(inv || r.result || e) && (
        <Panel isDark={isDark} title="Salesforce Tax Calculation Result" icon="check-circle" right={<b style={{ fontSize: 10.5, color: r.result ? "#00C875" : "#E2445C" }}>{r.result ? "SOURCE: SALESFORCE InvoiceLineTax" : "NO SALESFORCE TAX"}</b>}>
          <KV isDark={isDark} rows={[
            ["Invoice", <>{r.result?.invoiceNumber ?? inv?.number ?? r.invoiceSummary?.number ?? e?.invoiceNumber ?? "—"} · {r.invoiceSummary?.status ?? inv?.status ?? "—"} <Id v={r.invoiceId} /></>],
            ["Invoice totals (Salesforce)", r.invoiceSummary ? <>charges {money(r.invoiceSummary.subtotal)} · tax {money(r.invoiceSummary.tax)} · total with tax <b>{money(r.invoiceSummary.totalWithTax)}</b> <span style={{ opacity: 0.7 }}>(Invoice.TotalChargeAmount / TotalTaxAmount / TotalAmountWithTax)</span></> : "—"],
            ["Invoice Line", <>{line ? `${line.product ?? line.name} · charge ${money(line.charge)} · tax ${money(line.taxAmount)} · ${line.taxStatus ?? "—"}` : e ? `tax ${money(e.invoiceLineTaxAmount)} · ${e.taxProcessingStatus ?? "—"}` : "—"} <Id v={r.result?.invoiceLineId ?? line?.id ?? e?.invoiceLineId} /></>],
            ["InvoiceLineTax", r.result ? <Id v={r.result.invoiceLineTaxId} /> : <b style={{ color: "#E2445C" }}>none</b>],
            ["Tax Amount", r.result ? <b style={{ fontSize: 15 }}>{money(r.result.taxAmount)}</b> : "— (Salesforce produced no tax amount)"],
            ["Tax Rate", r.result?.taxRate !== null && r.result?.taxRate !== undefined ? `${r.result.taxRate}%` : "—"],
            ["Tax Code", r.result?.taxCode ?? "—"],
            ["Application Basis", r.result?.applicationBasis ? `${r.result.applicationBasis} (from the matched TaxRate)` : "—"],
          ]} />
        </Panel>
      )}
      {noIlt && e && (
        <Panel isDark={isDark} title="Why — evidence (read-only)" icon="alert-triangle">
          <div style={{ display: "grid", gap: 8 }}>
            <KV isDark={isDark} rows={[
              ["Reason", r.reason ?? "—"],
              ["Tax state", r.taxState?.replace(/_/g, " ") ?? "—"],
              ["Invoice", <>{e.invoiceNumber ?? "—"} <Id v={e.invoiceId} /></>],
              ["Invoice Line", <Id key="l" v={e.invoiceLineId} />],
              ["Tax Treatment", <Id key="t" v={e.taxTreatmentId} />],
              ["Tax Engine", <Id key="e" v={e.taxEngineId} />],
              ["Decision Table", <Id key="d" v={e.decisionTableId} />],
              ["Invoice TaxAmount", money(e.invoiceTaxAmount)],
              ["InvoiceLine TaxAmount", `${money(e.invoiceLineTaxAmount)} · ${e.taxProcessingStatus ?? "—"}`],
              ["InvoiceLineTax count", e.invoiceLineTaxCount],
              ["RevenueTransactionErrorLog count", e.errorLogCount],
              ["Trace", e.traceClassification ?? "—"],
            ]} />
            {e.configurationChangedAfterInvoice && <Notice isDark={isDark} tone="info">The rate that matches today ({e.configurationChangedAfterInvoice.rate}) was created or changed at {e.configurationChangedAfterInvoice.rateChangedAt}, after this invoice ({e.configurationChangedAfterInvoice.invoiceCreatedAt}). Today&apos;s match doesn&apos;t show the configuration Salesforce used for this invoice — a new order and invoice test the current configuration.</Notice>}
            {r.reason === "INVOICE_TIME_TAX_NOT_APPLIED" && !e.configurationChangedAfterInvoice && <Notice isDark={isDark} tone="warn">Decision-table match ≠ Salesforce invoice tax. The configuration resolves {e.preview?.matched ? `${e.preview.rate}% ${e.preview.applicationBasis ?? ""}` : "a rate"}, but Salesforce&apos;s invoice-time processing produced no InvoiceLineTax — this needs a Salesforce Support investigation, not another configuration change.</Notice>}
            {e.errors.map(x => <Notice key={x} isDark={isDark} tone="error">{x}</Notice>)}
          </div>
        </Panel>
      )}
      {(r.preview ?? e?.preview) && <PreviewView isDark={isDark} p={(r.preview ?? e!.preview)!} />}
      {r.expected && (
        <Panel isDark={isDark} title="Expected / reference tax" icon="eye" right={<b style={{ fontSize: 10.5, color: "#8899AA" }}>REFERENCE ONLY</b>}>
          <div style={{ fontSize: 12.5, display: "grid", gap: 3 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{money(r.expected.taxAmount)}</div>
            <div><b>{REFERENCE_LABEL}</b> Configured {r.expected.taxCode ?? ""} {r.expected.rate ?? "?"}% × {money(r.expected.taxableAmount)}.</div>
          </div>
        </Panel>
      )}
      {v && v.checks.length > 0 && (
        <Panel isDark={isDark} title="Validation checks" icon="check-square">
          <Table isDark={isDark} head={["Check", "Result", "Detail", "Record"]} empty="" rows={v.checks.map(c => [c.label, <b key="s" style={{ color: CHECK_COLOR[c.status] }}>{c.status}</b>, c.detail, <Id key="i" v={c.recordId} />])} />
        </Panel>
      )}
      {r.verification.length > 0 && (
        <Panel isDark={isDark} title="Verification (read from Salesforce)" icon="list">
          <Table isDark={isDark} head={["Record", "Salesforce Id", "Result", "Detail"]} empty="" rows={r.verification.map(x => [x.label, <Id key="i" v={x.recordId} />, <b key="r" style={{ color: x.passed ? "#00C875" : "#F5A623" }}>{x.passed ? "✓" : "…"}</b>, x.detail])} />
        </Panel>
      )}
      {r.createdRecords.length > 0 && <Notice isDark={isDark} tone="info"><b>Created in Salesforce{r.runKey ? ` (test run ${r.runKey})` : ""}:</b> {r.createdRecords.map(c => `${c.object} ${c.name ?? ""} (${c.id})`).join(" · ")}. Nothing is deleted or rolled back automatically.</Notice>}
      <Diagnostics isDark={isDark} list={r.diagnostics} />
      {confirming && r.awaiting && (
        <Modal isDark={isDark} title={`Confirm: ${STEP_LABEL[r.awaiting.step] ?? r.awaiting.step}`} tone="warn" actions={<>
          <GhostButton label="Not now" isDark={isDark} onClick={() => setConfirming(false)} />
          <PrimaryButton label="Confirm" icon="check" isDark={isDark} disabled={busy} onClick={() => { setConfirming(false); onConfirm(r.awaiting!.step); }} />
        </>}>
          <div style={{ fontSize: 12.5, display: "grid", gap: 6 }}>
            <div>{r.awaiting.detail}</div>
            <div style={{ opacity: 0.8 }}>This is one Salesforce step. The next billable step will ask for its own confirmation.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Self-contained dashboard (Taxes → Tax Calculation, and assistant answers seeded with a prepared result). */
/**
 * `onNotReady`: inside a calculation plan, a blocker found by a calculation step re-checks THAT plan instead of nesting a new one.
 * Standalone, a NOT READY result or a recoverable 4xx prepares the resolution plan automatically (read-only) below the result.
 */
export default function SalesforceTaxPanel({ isDark, initial, onNotReady }: { isDark: boolean; initial?: { result?: SfTaxResult | null; product: string; account: string }; onNotReady?: () => void }) {
  const t = tokens(isDark);
  const [f, setF] = useState({ quantity: "1", unitPrice: "" });
  // Every reference is a record picked from Salesforce (its Id is what the service receives); country/state carry their ISO codes.
  const [account, setAccountValue] = useState<LookupOption | null>(null);
  const [contact, setContact] = useState<LookupOption | null>(null);
  const [product, setProduct] = useState<LookupOption | null>(null);
  const [country, setCountryValue] = useState<LookupOption | null>(null);
  const [state, setState] = useState<LookupOption | null>(null);
  const [invoice, setInvoice] = useState<LookupOption | null>(null);
  // A Contact belongs to one Account and a State to one Country: a new parent clears the dependent selection.
  const setAccount = (a: LookupOption | null) => { setAccountValue(a); if (a?.id !== account?.id) setContact(null); };
  const setCountry = (c: LookupOption | null) => { setCountryValue(c); if (c?.id !== country?.id) setState(null); };
  const [r, setR] = useState<SfTaxResult | null>(initial?.result ?? null);
  // One run key per calculation: a repeated or retried "Create Order" confirmation finds the order already created for this key
  // (startVerificationRun is idempotent per key) instead of creating a second order.
  const [runKey, setRunKey] = useState(() => `sftax-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const [trace, setTrace] = useState<(InvoiceTaxTrace & { preview: DecisionTablePreview | null }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [autoPlan, setAutoPlan] = useState<{ plan: CalculationPlan; salesforce: SfTaxResult; key: number } | null>(null);
  const [planNote, setPlanNote] = useState<string | null>(null);
  /** Read-only: the resolution plan for the current product/account (never writes). */
  async function preparePlan(note: string | null) {
    if (onNotReady) { onNotReady(); return; }
    if (!product) return;
    setBusy("Preparing the resolution plan from Salesforce (read-only)…"); setPlanNote(note);
    try {
      const out = await quoteApiPost<{ success: true; plan: CalculationPlan; salesforce: SfTaxResult }>("Prepare the tax resolution plan", "/api/taxes/calculation/plan", { ...base, account: account?.label ?? null });
      setAutoPlan(prev => ({ plan: out.plan, salesforce: out.salesforce, key: (prev?.key ?? 0) + 1 }));
    } catch (err) { setError(toBillingErrorPanel(err, "The resolution plan couldn't be prepared")); }
    finally { setBusy(null); }
  }
  async function call(body: Record<string, unknown>, label: string) {
    setBusy(label); setLast(label); setError(null); setTrace(null);
    setAutoPlan(null); setPlanNote(null);
    let recover: string | null = null;
    try {
      const out = await quoteApiPost<SfTaxResult>("Tax calculation", "/api/taxes/calculation/salesforce", body);
      setR(out);
      if (body.mode !== "invoice" && resultNeedsPlan(out)) recover = "Salesforce can't calculate yet — the issues and their proposed fixes are prepared below (read-only until you approve).";
    } catch (err) {
      setError(toBillingErrorPanel(err, "The tax calculation step failed"));
      // A recoverable configuration / input problem (e.g. HTTP 422, an unknown account) → the resolution plan, not a dead end.
      if (err instanceof QuoteApiError && isRecoverableCalculationError(err.status, err.code) && body.mode !== "invoice") recover = `The request stopped (HTTP ${err.status}${err.code ? ` ${err.code}` : ""}) — the error is kept above; the issues and their proposed fixes are prepared below.`;
    }
    setBusy(null);
    if (recover) await preparePlan(recover);
  }
  async function loadTrace(invoiceId: string) {
    setBusy("Tracing the invoice in Salesforce (read-only)…"); setError(null);
    try { setTrace(await quoteApiGet<InvoiceTaxTrace & { preview: DecisionTablePreview | null }>("Invoice tax trace", `/api/taxes/invoices/${encodeURIComponent(invoiceId)}/trace?preview=1`)); }
    catch (err) { setError(toBillingErrorPanel(err, "The diagnostic trace failed")); }
    finally { setBusy(null); }
  }
  const base = { product: product ? { id: product.id } : null, accountId: account?.id ?? null, contactId: contact?.id ?? null, quantity: Number(f.quantity) || 1, unitPrice: f.unitPrice ? Number(f.unitPrice) : null, country: (country?.facts?.iso as string | undefined) ?? country?.code ?? null, state: (state?.facts?.iso as string | undefined) ?? state?.code ?? null };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel isDark={isDark} title="Tax Calculation" icon="zap">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, alignItems: "start" }}>
          <Field label="Customer account" isDark={isDark} hint={account?.facts?.billingComplete === false ? "No complete billing address — Calculate needs one." : undefined}>
            <SalesforceLookup isDark={isDark} object="Account" label="Customer account" value={account} onChange={setAccount} resolveText={initial?.account} placeholder="Search accounts by name or number…" />
          </Field>
          <Field label="Contact (optional)" isDark={isDark}>
            <SalesforceLookup isDark={isDark} object="Contact" label="Contact" value={contact} onChange={setContact} params={{ accountId: account?.id }} blockedReason={account ? null : "Select an account first"} placeholder="Defaults to the account's first contact" />
          </Field>
          <Field label="Product" isDark={isDark}>
            <SalesforceLookup isDark={isDark} object="Product2" label="Product" value={product} onChange={setProduct} resolveText={initial?.product} placeholder="Search by name, code or Product2 Id…" />
          </Field>
          <Field label="Quantity" isDark={isDark}><input type="number" value={f.quantity} onChange={set("quantity")} style={inputStyle(t)} /></Field>
          <Field label="Unit price" isDark={isDark}><input type="number" value={f.unitPrice} onChange={set("unitPrice")} placeholder="standard price if blank" style={inputStyle(t)} /></Field>
          <Field label="Country (no account)" isDark={isDark} hint={account ? "The account's billing address is used." : undefined}>
            <SalesforceLookup isDark={isDark} object="GeoCountry" label="Country" value={country} onChange={setCountry} placeholder="For Validate / Preview" />
          </Field>
          <Field label="State (no account)" isDark={isDark}>
            <SalesforceLookup isDark={isDark} object="GeoState" label="State" value={state} onChange={setState} params={{ country: base.country }} blockedReason={country ? null : "Select a country first"} placeholder="Optional" />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <GhostButton label={busy === "validate" ? "Validating…" : "Validate"} icon="check" isDark={isDark} disabled={!product || !!busy} onClick={() => void call({ ...base, action: "validate" }, "validate")} />
          <GhostButton label={busy === "preview" ? "Previewing…" : "Preview Tax"} icon="eye" isDark={isDark} disabled={!product || !!busy} onClick={() => void call({ ...base, action: "preview" }, "preview")} />
          <PrimaryButton label={busy === "calculate" ? "Validating…" : "Calculate with Salesforce…"} icon="zap" isDark={isDark} disabled={!product || !account || !!busy} onClick={() => { setRunKey(`sftax-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`); void call({ ...base, action: "calculate" }, "calculate"); }} />
        </div>
        <div style={{ fontSize: 11.5, color: t.dim, marginTop: 6 }}>Validate and Preview are read-only (Preview asks Salesforce to evaluate the decision table — a preview, not tax). Calculate with Salesforce validates first and then asks you to confirm each Salesforce step: order, activation, billing schedule, invoice. Only Salesforce&apos;s InvoiceLineTax is reported as tax.</div>
      </Panel>
      <Panel isDark={isDark} title="Existing invoice" icon="file-text">
        <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 280px", maxWidth: 420 }}>
            <Field label="Invoice" isDark={isDark}>
              <SalesforceLookup isDark={isDark} object="Invoice" label="Invoice" value={invoice} onChange={setInvoice} placeholder="Search by invoice number or account…" />
            </Field>
          </div>
          {/* The selected Invoice's Id — the service re-reads it and rejects one that no longer exists before reading InvoiceLineTax. */}
          <GhostButton label="Show Salesforce tax result" icon="search" isDark={isDark} disabled={!invoice || !!busy} onClick={() => void call({ mode: "invoice", invoiceId: invoice!.id, readOnly: true, waitMs: 0 }, "invoice")} />
        </div>
      </Panel>
      {busy && <LoadingRow isDark={isDark} label={busy === "validate" ? "Validating the tax configuration in Salesforce…" : busy === "preview" ? "Validating and asking Salesforce to evaluate the decision table…" : busy === "calculate" ? "Validating before the first Salesforce step…" : busy === "invoice" ? "Reading the invoice from Salesforce…" : busy.endsWith("…") ? busy : "Running the confirmed Salesforce step and reading the result…"} />}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {r && <ResultView key={`${r.status}-${r.awaiting?.step ?? ""}-${r.orderId ?? ""}`} isDark={isDark} r={r} busy={!!busy} autoConfirm={last === "calculate"}
        onConfirm={step => void call(step === "create-order" ? { ...base, action: "calculate", confirm: step, runKey } : { orderId: r.orderId, confirm: step }, "step")}
        onRecheck={() => void call({ orderId: r.orderId }, "recheck")}
        onTrace={id => void loadTrace(id)} />}
      {trace && <TraceView isDark={isDark} tr={trace} />}
      {planNote && autoPlan && <Notice isDark={isDark} tone="info">{planNote}</Notice>}
      {autoPlan && <CalculationPlanView key={autoPlan.key} isDark={isDark} embedded initialPlan={autoPlan.plan} initialSalesforce={autoPlan.salesforce}
        initial={{ product: product ? { id: product.id } : { name: "" }, account: account?.label ?? "", accountId: account?.id, country: base.country ?? "", state: base.state ?? "", taxCode: "", rate: "", basis: "", quantity: f.quantity, unitPrice: f.unitPrice, treatmentId: "", engineId: "" }} />}
    </div>
  );
}
