"use client";

import { useState } from "react";
import { Ic, tokens, GhostButton, CodeBlock } from "@/components/data/quotes/shared";
import type { OrderGroupResult, RowStatus } from "@/lib/orders/import/validateRows";

const STATUS_STYLE: Record<RowStatus, { label: string; color: string }> = {
  ready: { label: "Ready", color: "#22C55E" },
  warning: { label: "Warning", color: "#F59E0B" },
  error: { label: "Error", color: "#FF4066" },
};

function StatCard({ label, value, color, t }: { label: string; value: number; color: string; t: ReturnType<typeof tokens> }) {
  return (
    <div style={{ flex: 1, minWidth: 96, padding: "10px 14px", borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface }}>
      <div style={{ fontSize: 20, fontWeight: 800, color, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 11, color: t.dim, marginTop: 2 }}>{label}</div>
    </div>
  );
}

export default function OrderPreviewStep({
  isDark, groups, summary, onBack, onCreate,
}: {
  isDark: boolean;
  groups: OrderGroupResult[];
  summary: { total: number; ready: number; warnings: number; errors: number; totalLineItems: number };
  onBack: () => void;
  onCreate: () => void;
}) {
  const t = tokens(isDark);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showFullJson, setShowFullJson] = useState(false);
  const creatable = groups.filter(g => g.formData);
  const valid = summary.ready + summary.warnings;

  return (
    <div style={{ padding: 24 }}>
      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 10 }}>Order Import Preview</p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
        <StatCard label="Orders Found" value={summary.total} color={t.accent} t={t} />
        <StatCard label="Valid" value={valid} color="#22C55E" t={t} />
        <StatCard label="Warnings" value={summary.warnings} color="#F59E0B" t={t} />
        <StatCard label="Errors" value={summary.errors} color="#FF4066" t={t} />
        <StatCard label="Total Line Items" value={summary.totalLineItems} color={t.accentBlue} t={t} />
      </div>

      <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden", marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1.2fr 1.2fr 1fr 1fr 0.8fr 0.9fr 28px", padding: "9px 14px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
          <span>Order</span><span>Account</span><span>Price Book</span><span>Contract</span><span>Quote</span><span>Line Items</span><span>Status</span><span />
        </div>
        {groups.map(group => {
          const style = STATUS_STYLE[group.status];
          const isOpen = expanded === group.index;
          return (
            <div key={group.index}>
              <button
                onClick={() => setExpanded(isOpen ? null : group.index)}
                style={{
                  display: "grid", gridTemplateColumns: "1.3fr 1.2fr 1.2fr 1fr 1fr 0.8fr 0.9fr 28px", width: "100%", textAlign: "left",
                  padding: "9px 14px", borderTop: `1px solid ${t.border}`, background: "transparent", border: "none", cursor: "pointer", alignItems: "center",
                  fontSize: 12, color: t.heading,
                }}
              >
                <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{group.input.orderKey || <em style={{ color: t.dim }}>Order #{group.index + 1}</em>}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{group.input.accountName || "—"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{group.input.pricebookName || "—"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{group.input.contractName || "—"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{group.input.sourceQuoteName || "—"}</span>
                <span>{group.lineItems.length}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: style.color, fontWeight: 600 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: style.color }} />
                  {style.label}
                </span>
                <span style={{ color: t.dim }}><Ic n={isOpen ? "chevron-down" : "chevron-right"} s={13} /></span>
              </button>

              {isOpen && (
                <div style={{ padding: "14px 20px 18px", borderTop: `1px solid ${t.border}`, background: isDark ? "rgba(0,0,0,0.15)" : "rgba(0,0,0,0.02)" }}>
                  {group.issues.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 14 }}>
                      {group.issues.map((issue, i) => (
                        <div key={i} style={{ fontSize: 11.5, display: "flex", gap: 6, alignItems: "flex-start", color: issue.level === "error" ? "#FF4066" : issue.level === "warning" ? "#F59E0B" : t.dim }}>
                          <span style={{ marginTop: 1, flexShrink: 0 }}><Ic n={issue.level === "info" ? "info" : "alert"} s={11} /></span>
                          {issue.message}
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20, marginBottom: 16 }}>
                    <DetailGroup title="Order" t={t} rows={[
                      ["Account", group.input.accountName || "—"],
                      ["Price Book", group.input.pricebookName || "—"],
                      ["Order Date", group.input.effectiveDate || "—"],
                      ["Status", group.input.status || "—"],
                      ["Type", group.input.type || "—"],
                    ]} />
                    <DetailGroup title="References" t={t} rows={[
                      ["Contract", group.input.contractName || "—"],
                      ["Quote", group.input.sourceQuoteName || "—"],
                      ["PO Number", group.input.poNumber || "—"],
                      ["PO Date", group.input.poDate || "—"],
                    ]} />
                    <DetailGroup title="Description" t={t} rows={[["Description", group.input.description || "—"]]} />
                  </div>

                  {group.lineItems.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, marginBottom: 8 }}>Line Items</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {group.lineItems.map(li => (
                          <div key={li.rowIndex} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderRadius: 8, border: `1px solid ${t.border}`, fontSize: 11.5 }}>
                            <span style={{ color: li.status === "error" ? "#FF4066" : "#22C55E" }}><Ic n={li.status === "error" ? "alert" : "check-circle"} s={12} /></span>
                            <span style={{ fontWeight: 600, color: t.heading, flex: 1 }}>{li.resolvedProductName ?? li.input.product}</span>
                            <span style={{ color: t.dim }}>Qty {li.input.quantity || "1"}</span>
                            {li.input.unitPrice && <span style={{ color: t.dim }}>${li.input.unitPrice}</span>}
                            {li.status === "error" && <span style={{ color: "#FF4066", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{li.issues[0]?.message}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {group.formData && (
                    <CodeBlock isDark={isDark} data={{ formData: group.formData, lineItems: group.lineItems.filter(li => li.draft).map(li => li.draft) }} collapsedHeight={160} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginBottom: 18 }}>
        <GhostButton label={showFullJson ? "Hide Full JSON" : "View Full JSON"} icon="terminal" isDark={isDark} onClick={() => setShowFullJson(v => !v)} />
        {showFullJson && (
          <div style={{ marginTop: 10 }}>
            <CodeBlock isDark={isDark} data={{ orders: creatable.map(g => ({ formData: g.formData, lineItems: g.lineItems.filter(li => li.draft).map(li => li.draft) })) }} defaultExpanded />
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <GhostButton label="Back to Mapping" icon="arrow-left" isDark={isDark} onClick={onBack} />
        <button
          onClick={onCreate}
          disabled={creatable.length === 0}
          style={{
            display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 10, border: "none",
            fontSize: 13.5, fontWeight: 800, cursor: creatable.length === 0 ? "not-allowed" : "pointer", color: "#04101F",
            background: creatable.length === 0 ? t.dim : `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})`,
            opacity: creatable.length === 0 ? 0.5 : 1,
            boxShadow: creatable.length === 0 ? "none" : `0 4px 20px rgba(0,212,255,0.25)`,
          }}
        >
          <Ic n="upload" s={14} />
          Create {creatable.length} Order{creatable.length === 1 ? "" : "s"} in Salesforce
        </button>
      </div>
    </div>
  );
}

function DetailGroup({ title, rows, t }: { title: string; rows: [string, string][]; t: ReturnType<typeof tokens> }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, marginBottom: 8 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ fontSize: 11.5 }}>
            <span style={{ color: t.dim }}>{label}: </span>
            <span style={{ color: t.heading, fontWeight: 600 }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
