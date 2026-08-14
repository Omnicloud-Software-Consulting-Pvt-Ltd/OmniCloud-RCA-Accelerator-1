"use client";

import { Ic, tokens, PrimaryButton, GhostButton, Pill } from "@/components/data/quotes/shared";
import type { AttributeProductGroup, AttributeDataTypeKind } from "@/lib/attributes/import/validateRows";

const TYPE_COLOR: Record<AttributeDataTypeKind, string> = {
  Picklist: "#3AABFF", Checkbox: "#22C55E", Text: "#94A3B8", Number: "#F59E0B",
  Decimal: "#F59E0B", Currency: "#F59E0B", Date: "#A78BFA", DateTime: "#A78BFA", Unknown: "#FF4066",
};

/**
 * Human-readable Attribute Import preview (§11) — a Product → Attribute
 * tree with type/value summaries, never raw JSON as the primary view. The
 * generated ParsedRCAData (§12) that will actually be sent to
 * POST /api/sf/attributes/execute-batch is available via "View JSON" only
 * on explicit request, per §12's "do not expose this raw structure unless
 * the user explicitly requests it."
 */
export default function AttributeImportPreviewStep({
  isDark, groups, summary, onBack, onCreate,
}: {
  isDark: boolean;
  groups: AttributeProductGroup[];
  summary: { totalProducts: number; totalAttributes: number; readyProducts: number; warningProducts: number; errorProducts: number; byType: Record<string, number> };
  onBack: () => void;
  onCreate: () => void;
}) {
  const t = tokens(isDark);
  const creatableCount = groups.filter(g => g.parsedRCAData).length;

  return (
    <div style={{ padding: 24, maxWidth: 900, overflowY: "auto" }}>
      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 10 }}>Attribute Import Preview</p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <SummaryStat label="Products" value={summary.totalProducts} color={t.accent} t={t} />
        <SummaryStat label="Attributes" value={summary.totalAttributes} color={t.accentBlue} t={t} />
        {Object.entries(summary.byType).map(([type, count]) => (
          <SummaryStat key={type} label={`${type}${count === 1 ? "" : "s"}`} value={count} color={TYPE_COLOR[type as AttributeDataTypeKind] ?? t.dim} t={t} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 14, fontSize: 11.5, color: t.dim, marginBottom: 20 }}>
        <span>✓ {summary.readyProducts} ready</span>
        {summary.warningProducts > 0 && <span style={{ color: "#F59E0B" }}>⚠ {summary.warningProducts} need attention</span>}
        {summary.errorProducts > 0 && <span style={{ color: "#FF4066" }}>✕ {summary.errorProducts} excluded</span>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {groups.map(g => (
          <ProductGroupCard key={g.index} group={g} isDark={isDark} t={t} />
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
        <GhostButton label="Back" icon="arrow-left" isDark={isDark} onClick={onBack} />
        <PrimaryButton
          label={`Create Attributes (${creatableCount} product${creatableCount === 1 ? "" : "s"})`}
          icon="zap" isDark={isDark} disabled={creatableCount === 0} onClick={onCreate}
        />
      </div>
    </div>
  );
}

function SummaryStat({ label, value, color, t }: { label: string; value: number; color: string; t: ReturnType<typeof tokens> }) {
  return (
    <div style={{ minWidth: 84, padding: "8px 12px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface }}>
      <div style={{ fontSize: 17, fontWeight: 800, color, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 10.5, color: t.dim, marginTop: 1 }}>{label}</div>
    </div>
  );
}

function ProductGroupCard({ group, isDark, t }: { group: AttributeProductGroup; isDark: boolean; t: ReturnType<typeof tokens> }) {
  const borderColor = group.status === "error" ? "rgba(255,64,102,0.3)" : group.status === "warning" ? "rgba(245,158,11,0.3)" : t.border;

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${borderColor}`, background: t.surface, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${t.border}`, background: t.surfaceAlt }}>
        <span style={{ color: group.resolvedProductId ? t.accent : "#FF4066" }}><Ic n={group.resolvedProductId ? "cube" : "alert"} s={15} /></span>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: t.heading, flex: 1 }}>{group.productName}</span>
        {group.status === "ready" && <Pill label="Ready" color="#22C55E" isDark={isDark} />}
        {group.status === "warning" && <Pill label="Needs Attention" color="#F59E0B" isDark={isDark} />}
        {group.status === "error" && <Pill label="Excluded" color="#FF4066" isDark={isDark} />}
      </div>

      <div style={{ padding: "10px 14px" }}>
        {group.issues.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: group.rows.length > 0 ? 10 : 0 }}>
            {group.issues.map((issue, i) => (
              <div key={i} style={{ fontSize: 11.5, color: issue.level === "error" ? "#FF4066" : issue.level === "warning" ? "#F59E0B" : t.dim }}>
                {issue.level === "error" ? "✕ " : issue.level === "warning" ? "⚠ " : ""}{issue.message}
              </div>
            ))}
          </div>
        )}

        {group.rows.filter(r => r.status !== "error" && !r.alreadyExists).map(r => (
          <div key={r.rowIndex} style={{ padding: "8px 0", borderTop: `1px solid ${t.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: t.heading }}>{r.input.attributeName}</span>
              <Pill label={r.dataTypeKind} color={TYPE_COLOR[r.dataTypeKind]} isDark={isDark} />
            </div>
            {r.dataTypeKind === "Picklist" && r.parsedValues.length > 0 && (
              <div style={{ fontSize: 11.5, color: t.dim, marginTop: 3 }}>Values: {r.parsedValues.join(", ")}</div>
            )}
            {r.dataTypeKind === "Checkbox" && (
              <div style={{ fontSize: 11.5, color: t.dim, marginTop: 3 }}>Values: True / False</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
