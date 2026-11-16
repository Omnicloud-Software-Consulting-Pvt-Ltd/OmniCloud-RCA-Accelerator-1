"use client";

import { useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, PageShell, ErrorPanel, GhostButton, CodeBlock } from "@/components/data/quotes/shared";
import { Panel, StatusPill, LoadingRow, useBillingData, ToolbarButton } from "@/components/data/billing/billingUi";
import { formatBillingValue, navTargetForReference, type BillingNavTarget } from "@/lib/billing/client";
import { getBillingModule } from "@/lib/billing/registry";
import type { BillingDetailField, BillingDetailResponse, BillingDetailSectionId } from "@/lib/billing/types";
import type { PaymentInvoice, PaymentModel } from "@/lib/billing/server/payments";
import { appliedByPayment } from "@/lib/billing/paymentApplications";
import { TransactionTaxHelp } from "@/components/data/taxes/NativeTaxGuidance";

const SECTIONS: { id: BillingDetailSectionId; title: string; icon: string }[] = [
  { id: "basic", title: "Basic Information", icon: "info" },
  { id: "relationships", title: "Relationships", icon: "link" },
  { id: "configuration", title: "Billing Configuration", icon: "sliders" },
  { id: "salesforce", title: "Salesforce", icon: "database" },
];

/** Tax amount / status fields on transaction records that get the compact "how tax is calculated" tip. */
const TAX_HELP_MODULES = new Set(["invoices", "billing-schedules"]);
const TAX_HELP_FIELD = /^(TotalTaxAmount|TaxAmount|TotalAmountWithTax|TaxStatus|TaxCalculationStatus)$/;

/**
 * Detail view for any billing record — every readable field from the live
 * record, grouped into the four standard sections, with lookups rendered as
 * names that navigate (to another billing module, or to the existing
 * Products/Orders/Contracts/Quotes modules), plus related child records.
 */
export default function BillingRecordDetail({ isDark, moduleKey, recordId, onNavigate, onBack, onEdit }: {
  isDark: boolean;
  moduleKey: string;
  recordId: string;
  onNavigate: (target: BillingNavTarget) => void;
  onBack: () => void;
  onEdit?: () => void;
}) {
  const t = tokens(isDark);
  const def = getBillingModule(moduleKey)!;
  const { data, error, loading, reload } = useBillingData<BillingDetailResponse>(`Load ${def.singular}`, `/api/billing/${moduleKey}/${recordId}`);
  const orderLinked = moduleKey === "billing-schedules" || moduleKey === "invoices";
  const context = useBillingData<{ orderId: string | null; orderNumber: string | null; scheduleIds: string[]; invoices: { id: string; number: string | null }[] }>("Find related order", orderLinked ? `/api/billing/orders/context?${moduleKey === "invoices" ? "invoiceId" : "scheduleId"}=${recordId}` : null);
  // Invoice → Payments: the same server service the Payments workspace uses (balance, eligibility, applications).
  const payModel = useBillingData<PaymentModel>("Payment capabilities", moduleKey === "invoices" ? "/api/billing/payments/model" : null);
  const payInfo = useBillingData<{ invoice: PaymentInvoice }>("Load invoice payments", moduleKey === "invoices" ? `/api/billing/payments/invoices/${recordId}` : null);
  const [showEmpty, setShowEmpty] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const renderValue = (f: BillingDetailField) => {
    if (f.reference) {
      const target = navTargetForReference(f.reference);
      return target ? (
        <button onClick={() => onNavigate(target)} style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: t.accent, fontWeight: 700, fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 4 }}>
          {f.reference.name} <Ic n="arrow-right" s={11} />
        </button>
      ) : <span style={{ color: t.heading, fontWeight: 600 }}>{f.reference.name} <span style={{ color: t.dim, fontWeight: 400, fontSize: 11 }}>({f.reference.sobject})</span></span>;
    }
    if (f.name === "Id") return <code style={{ fontSize: 11.5, color: t.body }}>{String(f.value)}</code>;
    return <span style={{ color: f.value === null || f.value === "" ? t.dim : t.body }}>{formatBillingValue(f.value, f.type)}</span>;
  };

  if (error && !data) {
    return (
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
        <ErrorPanel isDark={isDark} error={error} />
        <div style={{ display: "flex", gap: 8 }}><GhostButton label="Retry" icon="refresh" isDark={isDark} onClick={reload} /><GhostButton label="Back" icon="arrow-left" isDark={isDark} onClick={onBack} /></div>
      </div>
    );
  }
  if (!data) return <div style={{ padding: 20 }}><LoadingRow isDark={isDark} label={`Loading ${def.singular} from Salesforce…`} /></div>;

  return (
    <PageShell>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14, opacity: loading ? 0.6 : 1 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", color: t.accent, background: `${t.accent}18`, border: `1px solid ${t.accent}40` }}><Ic n={def.icon} s={20} /></div>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4 }}>{def.singular} · {data.sobject}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 19, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>{data.name}</span>
                <StatusPill status={data.status} isDark={isDark} />
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {onEdit && <ToolbarButton isDark={isDark} label={`Edit ${def.singular}`} icon="edit" primary onClick={onEdit} />}
            {context.data?.orderId && <ToolbarButton isDark={isDark} label={`View Order ${context.data.orderNumber ?? ""}`.trim()} icon="shopping-cart" onClick={() => onNavigate({ app: { module: "orders", recordId: context.data!.orderId! } })} />}
            {context.data?.orderId && <ToolbarButton isDark={isDark} label="Order Billing Setup" icon="calendar" onClick={() => onNavigate({ order: { id: context.data!.orderId! } })} />}
            {moduleKey === "invoices" && payInfo.data?.invoice.eligible && <ToolbarButton isDark={isDark} label={(payInfo.data.invoice.paymentsApplied ?? 0) > 0 ? "Settle Remaining Balance" : "Settle Payment"} icon="check-circle" primary onClick={() => onNavigate({ payment: { mode: "settle", invoiceId: recordId } })} />}
            {moduleKey === "invoices" && payInfo.data?.invoice.eligible && <ToolbarButton isDark={isDark} label="Record Payment" icon="credit-card" onClick={() => onNavigate({ payment: { mode: "record", invoiceId: recordId } })} />}
            {moduleKey === "invoices" && <ToolbarButton isDark={isDark} label="View Payments" icon="list" onClick={() => onNavigate({ payment: { mode: "dashboard" } })} />}
            {moduleKey === "invoices" && payInfo.data && /^posted$/i.test(payInfo.data.invoice.status ?? "") && <ToolbarButton isDark={isDark} label="Create Credit Memo" icon="file-text" onClick={() => onNavigate({ creditMemo: { mode: "create", invoiceId: recordId } })} />}
            {moduleKey === "invoices" && <ToolbarButton isDark={isDark} label="View Credit Memos" icon="list" onClick={() => onNavigate({ creditMemo: { mode: "dashboard" } })} />}
            {moduleKey === "invoices" && <ToolbarButton isDark={isDark} label="Debit Memos" icon="file-text" onClick={() => onNavigate({ debitMemo: { mode: "dashboard" } })} />}
            {moduleKey === "billing-schedules" && context.data?.invoices.map(i => <ToolbarButton key={i.id} isDark={isDark} label={`View Invoice ${i.number ?? ""}`.trim()} icon="file-text" onClick={() => onNavigate({ billing: { moduleKey: "invoices", view: "detail", id: i.id } })} />)}
            {moduleKey === "invoices" && context.data?.scheduleIds[0] && <ToolbarButton isDark={isDark} label="View Billing Schedule" icon="calendar" onClick={() => onNavigate({ billing: { moduleKey: "billing-schedules", view: "detail", id: context.data!.scheduleIds[0] } })} />}
            <ToolbarButton isDark={isDark} label="Refresh" icon="refresh" onClick={reload} disabled={loading} />
            <ToolbarButton isDark={isDark} label={showEmpty ? "Hide empty fields" : "Show empty fields"} icon="eye" onClick={() => setShowEmpty(v => !v)} active={showEmpty} />
            <a href={data.salesforceUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 13px", borderRadius: 9, fontSize: 12.5, fontWeight: 700, color: "#04101F", textDecoration: "none", background: `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})` }}>
              <Ic n="external-link" s={13} /> Open in Salesforce
            </a>
          </div>
        </div>

        {error && <ErrorPanel isDark={isDark} error={error} />}

        {moduleKey === "invoices" && payInfo.data && (() => {
          const inv = payInfo.data.invoice;
          const byPayment = appliedByPayment(inv.applications);
          return (
            <Panel isDark={isDark} title="Payments" icon="credit-card" right={<StatusPill status={inv.settlementStatus} isDark={isDark} />}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8, fontSize: 12.5 }}>
                <div><div style={{ color: t.dim, fontSize: 11 }}>Invoice Amount</div><strong style={{ color: t.heading }}>{inv.total ?? "—"}</strong></div>
                <div><div style={{ color: t.dim, fontSize: 11 }}>Paid Amount</div><strong style={{ color: "#00C875" }}>{inv.paymentsApplied ?? 0}</strong></div>
                <div><div style={{ color: t.dim, fontSize: 11 }}>Outstanding</div><strong style={{ color: (inv.balance ?? 0) > 0 ? t.heading : "#00C875" }}>{inv.balance ?? "—"}</strong></div>
                <div><div style={{ color: t.dim, fontSize: 11 }}>Can accept payment</div><strong style={{ color: inv.eligible ? "#00C875" : t.dim }}>{inv.eligible ? "Yes" : "No"}</strong></div>
              </div>
              {!inv.eligible && (inv.balance ?? 0) <= 0 && (inv.paymentsApplied ?? 0) > 0 && <div style={{ marginTop: 8, fontSize: 13, color: "#00C875", fontWeight: 800 }}>✓ Fully Settled{inv.settlementStatus ? ` (Salesforce: ${inv.settlementStatus})` : ""}</div>}
              {!inv.eligible && !((inv.balance ?? 0) <= 0 && (inv.paymentsApplied ?? 0) > 0) && <div style={{ marginTop: 8, fontSize: 12, color: t.dim }}>{inv.reasons.join(" ")}</div>}
              {inv.eligible && payModel.data && !payModel.data.capabilities.find(c => c.id === "settle")?.available && (
                <div style={{ marginTop: 8, fontSize: 12, color: t.warn, fontWeight: 600 }}>⚠ Payment settlement is not currently enabled for this Salesforce user — your user needs the Billing Advanced / Payment Operations permission to apply payments to invoice lines.</div>
              )}
              {byPayment.length > 0 && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {byPayment.map(p => (
                    <div key={p.paymentId} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                      <span style={{ flex: 1 }}><strong style={{ color: t.heading }}>{p.paymentNumber}</strong> applied {p.amount}{p.appliedDate ? ` on ${p.appliedDate.slice(0, 10)}` : ""}</span>
                      <GhostButton label="View Payment" icon="eye" isDark={isDark} onClick={() => onNavigate({ payment: { mode: "detail", id: p.paymentId } })} />
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          );
        })()}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14 }}>
          {SECTIONS.map(section => {
            const fields = data.fields.filter(f => f.section === section.id && (showEmpty || section.id === "salesforce" || (f.value !== null && f.value !== "")));
            if (fields.length === 0 && section.id !== "relationships") return null;
            return (
              <Panel key={section.id} isDark={isDark} title={section.title} icon={section.icon}>
                {fields.length === 0 ? (
                  <div style={{ fontSize: 12, color: t.dim }}>No lookups set on this record.</div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 42%) 1fr", gap: "8px 12px", fontSize: 12.5 }}>
                    {fields.map(f => (
                      <div key={f.name} style={{ display: "contents" }}>
                        <span style={{ color: t.dim, fontSize: 11.5, display: "inline-flex", alignItems: "center", gap: 4 }}><span title={f.name}>{f.label}</span>{TAX_HELP_MODULES.has(moduleKey) && TAX_HELP_FIELD.test(f.name) && <TransactionTaxHelp isDark={isDark} />}</span>
                        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{renderValue(f)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>

        {moduleKey === "billing-policies" && (() => {
          const products = data.children.find(c => c.sobject === "Product2")?.records ?? [];
          return (
            <Panel isDark={isDark} title="Product Association" icon="package" right={<span style={{ fontSize: 10.5, color: t.dim, fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}>Product2 → {def.singular}</span>}>
              {products.length === 0 ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, color: t.dim }}>Product: <strong style={{ color: t.warn }}>Not assigned</strong></span>
                  <ToolbarButton isDark={isDark} label="Assign to Product" icon="link" primary onClick={() => onNavigate({ assign: { policyId: data.id } })} />
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {products.map(p => (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "8px 12px", borderRadius: 10, border: "1px solid rgba(0,200,117,0.4)", background: "rgba(0,200,117,0.06)", fontSize: 12.5 }}>
                      <span style={{ color: t.dim }}>Product: <strong style={{ color: t.heading }}>{p.name}</strong></span>
                      <span style={{ color: t.dim }}>Billing Policy: <strong style={{ color: t.heading }}>{data.name}</strong></span>
                      <span style={{ color: "#00C875", fontWeight: 700 }}>Relationship: ✓ Assigned</span>
                      <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                        <GhostButton label="View Product" icon="package" isDark={isDark} onClick={() => onNavigate({ product: { id: p.id } })} />
                        <GhostButton label="Change Product" icon="edit" isDark={isDark} onClick={() => onNavigate({ assign: { policyId: data.id } })} />
                      </span>
                    </div>
                  ))}
                  <div><GhostButton label="Assign to another Product" icon="link" isDark={isDark} onClick={() => onNavigate({ assign: { policyId: data.id } })} /></div>
                </div>
              )}
            </Panel>
          );
        })()}

        {data.children.filter(c => !(moduleKey === "billing-policies" && c.sobject === "Product2")).map(c => (
          <Panel key={`${c.sobject}.${c.field}`} isDark={isDark} title={`${c.label} (${c.totalSize})`} icon={c.moduleKey ? getBillingModule(c.moduleKey)?.icon ?? "list" : "package"}
            right={c.moduleKey ? <span style={{ fontSize: 10.5, color: t.dim, fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}>{c.sobject}.{c.field}</span> : undefined} padding={c.records.length ? 0 : 16}>
            {c.records.length === 0 ? (
              <div style={{ fontSize: 12, color: t.dim }}>None yet.</div>
            ) : c.records.map(r => {
              const target: BillingNavTarget | null = c.moduleKey
                ? { billing: { moduleKey: c.moduleKey, view: "detail", id: r.id } }
                : navTargetForReference({ id: r.id, name: r.name, sobject: c.sobject });
              return (
                <button key={r.id} onClick={() => target && onNavigate(target)} disabled={!target}
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 16px", border: "none", borderBottom: `1px solid ${t.border}`, background: "transparent", cursor: target ? "pointer" : "default", textAlign: "left" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: t.heading }}>{r.name}</span>
                  <StatusPill status={r.status} isDark={isDark} />
                  {target && <span style={{ marginLeft: "auto", color: t.accent, display: "inline-flex" }}><Ic n="arrow-right" s={13} /></span>}
                </button>
              );
            })}
          </Panel>
        ))}

        <div>
          <GhostButton label={showRaw ? "Hide raw Salesforce record" : "View raw Salesforce record"} icon="terminal" isDark={isDark} onClick={() => setShowRaw(v => !v)} />
          {showRaw && <div style={{ marginTop: 8 }}><CodeBlock open isDark={isDark} data={Object.fromEntries(data.fields.map(f => [f.name, f.value]))} /></div>}
        </div>
      </div>
    </PageShell>
  );
}
