"use client";

import { useState } from "react";
import { Ic, tokens, GhostButton, CodeBlock } from "@/components/data/quotes/shared";
import type { ContractImportRowResult, RowStatus } from "@/lib/contracts/import/validateRows";

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

export default function ContractPreviewStep({
  isDark, rows, summary, onBack, onCreate,
}: {
  isDark: boolean;
  rows: ContractImportRowResult[];
  summary: { total: number; ready: number; warnings: number; errors: number };
  onBack: () => void;
  onCreate: () => void;
}) {
  const t = tokens(isDark);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showFullJson, setShowFullJson] = useState(false);
  const creatable = rows.filter(r => r.formData);
  const valid = summary.ready + summary.warnings;

  return (
    <div style={{ padding: 24 }}>
      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 10 }}>Contract Import Preview</p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
        <StatCard label="Contracts Found" value={summary.total} color={t.accent} t={t} />
        <StatCard label="Valid" value={valid} color="#22C55E" t={t} />
        <StatCard label="Warnings" value={summary.warnings} color="#F59E0B" t={t} />
        <StatCard label="Errors" value={summary.errors} color="#FF4066" t={t} />
      </div>

      <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden", marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.2fr 1fr 1fr 0.9fr 0.7fr 0.9fr 28px", padding: "9px 14px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
          <span>Contract</span><span>Account</span><span>Price Book</span><span>Type</span><span>Start Date</span><span>Term</span><span>Status</span><span />
        </div>
        {rows.map(row => {
          const style = STATUS_STYLE[row.status];
          const isOpen = expanded === row.index;
          return (
            <div key={row.index}>
              <button
                onClick={() => setExpanded(isOpen ? null : row.index)}
                style={{
                  display: "grid", gridTemplateColumns: "1.4fr 1.2fr 1fr 1fr 0.9fr 0.7fr 0.9fr 28px", width: "100%", textAlign: "left",
                  padding: "9px 14px", borderTop: `1px solid ${t.border}`, background: "transparent", border: "none", cursor: "pointer", alignItems: "center",
                  fontSize: 12, color: t.heading,
                }}
              >
                <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{row.input.displayName || <em style={{ color: t.dim }}>Row #{row.index + 1}</em>}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.input.accountName || "—"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.input.pricebookName || "—"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.input.contractType || "—"}</span>
                <span>{row.input.startDate || "—"}</span>
                <span>{row.input.contractTerm || "—"}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: style.color, fontWeight: 600 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: style.color }} />
                  {style.label}
                </span>
                <span style={{ color: t.dim }}><Ic n={isOpen ? "chevron-down" : "chevron-right"} s={13} /></span>
              </button>

              {isOpen && (
                <div style={{ padding: "14px 20px 18px", borderTop: `1px solid ${t.border}`, background: isDark ? "rgba(0,0,0,0.15)" : "rgba(0,0,0,0.02)" }}>
                  {row.issues.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 14 }}>
                      {row.issues.map((issue, i) => (
                        <div key={i} style={{ fontSize: 11.5, display: "flex", gap: 6, alignItems: "flex-start", color: issue.level === "error" ? "#FF4066" : issue.level === "warning" ? "#F59E0B" : t.dim }}>
                          <span style={{ marginTop: 1, flexShrink: 0 }}><Ic n={issue.level === "info" ? "info" : "alert"} s={11} /></span>
                          {issue.message}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
                    <DetailGroup title="Contract" t={t} rows={[
                      ["Account", row.input.accountName || "—"],
                      ["Price Book", row.input.pricebookName || "—"],
                      ["Status", row.input.status || "—"],
                      ["Contract Type", row.input.contractType || "—"],
                    ]} />
                    <DetailGroup title="Term" t={t} rows={[
                      ["Start Date", row.input.startDate || "—"],
                      ["Contract Term (months)", row.input.contractTerm || "—"],
                    ]} />
                    <DetailGroup title="Description" t={t} rows={[["Description", row.input.description || "—"]]} />
                  </div>
                  {row.formData && (
                    <div style={{ marginTop: 14 }}>
                      <CodeBlock isDark={isDark} data={row.formData} collapsedHeight={160} />
                    </div>
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
            <CodeBlock isDark={isDark} data={{ contracts: creatable.map(r => r.formData) }} defaultExpanded />
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
          Create {creatable.length} Contract{creatable.length === 1 ? "" : "s"} in Salesforce
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
