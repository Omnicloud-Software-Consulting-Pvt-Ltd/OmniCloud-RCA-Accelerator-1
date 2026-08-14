"use client";

import { useState } from "react";
import { Ic, tokens, GhostButton } from "@/components/data/quotes/shared";
import type { BundleImportGroup, BundleValidateResult } from "@/lib/bundles/import/validateRows";

const STATUS_META: Record<string, { label: string; color: string }> = {
  ready: { label: "Ready", color: "#22C55E" },
  warning: { label: "Warning", color: "#F59E0B" },
  error: { label: "Error", color: "#FF4066" },
};

/**
 * Bundle Import Preview — "N Bundles / M Components" summary, then a table
 * of every distinct bundle the file will create, expandable to its full
 * product list. One row here = one bundle, even though it came from
 * several CSV rows — the grouping already happened in validateRows.ts.
 */
export default function BundleImportPreviewStep({ isDark, result, onBack, onCreate }: {
  isDark: boolean; result: BundleValidateResult; onBack: () => void; onCreate: () => void;
}) {
  const t = tokens(isDark);
  const [expanded, setExpanded] = useState<string | null>(null);
  const creatable = result.groups.filter(g => g.status !== "error");

  return (
    <div style={{ padding: 24, maxWidth: 900 }}>
      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 12 }}>Bundle Import Preview</p>

      <div className="flex items-center gap-3 flex-wrap" style={{ marginBottom: 18 }}>
        <StatPill label="Bundles" value={result.summary.totalBundles} color={t.accent} t={t} />
        <StatPill label="Components" value={result.summary.totalComponents} color={t.accentBlue} t={t} />
        <StatPill label="Ready" value={result.summary.ready} color="#22C55E" t={t} />
        <StatPill label="Warnings" value={result.summary.warnings} color="#F59E0B" t={t} />
        <StatPill label="Errors" value={result.summary.errors} color="#FF4066" t={t} />
      </div>

      <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden", marginBottom: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 0.9fr 0.8fr 0.9fr 1fr 0.6fr", padding: "9px 14px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
          <span>Bundle</span><span>Code</span><span>Components</span><span>Selling Model</span><span>Status</span><span />
        </div>
        {result.groups.map((g, i) => {
          const meta = STATUS_META[g.status];
          const isOpen = expanded === g.key;
          return (
            <div key={g.key} style={{ borderTop: i > 0 ? `1px solid ${t.border}` : undefined }}>
              <button
                onClick={() => setExpanded(isOpen ? null : g.key)}
                style={{ width: "100%", display: "grid", gridTemplateColumns: "1.6fr 0.9fr 0.8fr 0.9fr 1fr 0.6fr", padding: "10px 14px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left", fontSize: 12, color: t.body, alignItems: "center" }}
              >
                <span style={{ fontWeight: 700, color: t.heading }}>{g.bundleName || <em style={{ color: t.dim }}>Unnamed</em>}</span>
                <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: t.dim }}>{g.bundleCode || "—"}</span>
                <span>{g.productNames.length}</span>
                <span>{g.sellingModel || "—"}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: meta.color }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: meta.color }} /> {meta.label}
                </span>
                <span className="flex justify-end" style={{ color: t.dim }}><Ic n={isOpen ? "chevron-down" : "chevron-right"} s={13} /></span>
              </button>
              {isOpen && <BundleGroupDetail group={g} isDark={isDark} />}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <GhostButton label="Back to Mapping" icon="arrow-left" isDark={isDark} onClick={onBack} />
        <button
          onClick={onCreate}
          disabled={creatable.length === 0}
          style={{
            display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 10, border: "none",
            fontSize: 13.5, fontWeight: 800, color: "#04101F", cursor: creatable.length === 0 ? "not-allowed" : "pointer",
            background: creatable.length === 0 ? t.dim : `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})`,
            opacity: creatable.length === 0 ? 0.5 : 1,
          }}
        >
          <Ic n="upload" s={14} /> Create {creatable.length} Bundle{creatable.length === 1 ? "" : "s"} in Salesforce
        </button>
      </div>
    </div>
  );
}

function StatPill({ label, value, color, t }: { label: string; value: number; color: string; t: ReturnType<typeof tokens> }) {
  return (
    <div style={{ padding: "8px 14px", borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface }}>
      <div style={{ fontSize: 17, fontWeight: 800, color, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 10, color: t.dim, marginTop: 1 }}>{label}</div>
    </div>
  );
}

function BundleGroupDetail({ group, isDark }: { group: BundleImportGroup; isDark: boolean }) {
  const t = tokens(isDark);
  return (
    <div style={{ padding: "0 14px 14px" }}>
      {group.issues.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 10 }}>
          {group.issues.map((issue, i) => (
            <div key={i} style={{ fontSize: 11.5, display: "flex", gap: 6, alignItems: "flex-start", color: issue.level === "error" ? "#FF4066" : issue.level === "warning" ? "#F59E0B" : t.dim }}>
              <span style={{ marginTop: 1, flexShrink: 0 }}><Ic n={issue.level === "info" ? "info" : "alert"} s={11} /></span>
              {issue.message}
            </div>
          ))}
        </div>
      )}
      {group.parsedBundle ? (
        <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.9 }}>
          <div style={{ color: t.accentBlue, fontWeight: 700 }}>{group.parsedBundle.bundleName}</div>
          {group.parsedBundle.products.map((p, i) => {
            const isLast = i === group.parsedBundle!.products.length - 1;
            return (
              <div key={p.name} style={{ marginLeft: 16, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: t.dim }}>{isLast ? "└── " : "├── "}</span>
                <span style={{ color: t.body }}>{p.name}</span>
                {p.price > 0 && <span style={{ color: t.accent, fontSize: 11 }}>${p.price.toLocaleString()}</span>}
                {p.isRequired === false && <span style={{ fontSize: 9, color: t.dim }}>(optional)</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <p style={{ fontSize: 11.5, color: t.dim }}>This bundle will not be created until the errors above are fixed.</p>
      )}
    </div>
  );
}
