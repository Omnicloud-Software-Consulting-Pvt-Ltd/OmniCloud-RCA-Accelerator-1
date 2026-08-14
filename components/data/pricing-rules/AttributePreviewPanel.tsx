"use client";

import { Ic, tokens, Section, Pill } from "./shared";
import type { AttributePreviewEntry } from "@/lib/pricing-rules/types";

/**
 * §B — the complete Attribute JSON Preview: every attribute this run will touch (not just the first or
 * first failing one), shown BEFORE any native record (PAS/Rule/Condition/Adjustment) is created. Purely
 * a read-only rendering of what the backend already computed (see `createNativeAttributePricing`'s
 * `onAttributePreview` callback / the `attributePreview` NDJSON event) — this component never computes
 * or infers anything itself.
 */
export default function AttributePreviewPanel({
  isDark,
  product2Id,
  sellingModelId,
  priceAdjustmentScheduleId,
  attributes,
}: {
  isDark: boolean;
  product2Id: string;
  sellingModelId: string;
  priceAdjustmentScheduleId: string | null;
  attributes: AttributePreviewEntry[];
}) {
  const t = tokens(isDark);
  const blockedCount = attributes.filter(a => a.status === "BLOCKED").length;

  return (
    <Section title="Attribute JSON Preview" icon="list" isDark={isDark} defaultOpen>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 6 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, fontSize: 11.5 }}>
          <div><strong style={{ color: t.heading }}>Product2Id:</strong> <span style={{ color: t.body }}>{product2Id}</span></div>
          <div><strong style={{ color: t.heading }}>Selling Model Id:</strong> <span style={{ color: t.body }}>{sellingModelId}</span></div>
          <div><strong style={{ color: t.heading }}>Price Adjustment Schedule Id:</strong> <span style={{ color: t.body }}>{priceAdjustmentScheduleId ?? "(not yet created)"}</span></div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Pill label={`${attributes.length} attribute(s)`} color={t.accent} isDark={isDark} />
          {blockedCount > 0
            ? <Pill label={`${blockedCount} BLOCKED`} color={t.error} isDark={isDark} />
            : <Pill label="All READY" color="#22C55E" isDark={isDark} />}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {attributes.map((a, i) => (
            <div key={i} style={{
              border: `1px solid ${a.status === "BLOCKED" ? t.error : t.border}55`,
              borderRadius: 8, padding: "6px 10px",
              background: a.status === "BLOCKED" ? (isDark ? "rgba(255,64,102,0.08)" : "rgba(255,64,102,0.06)") : undefined,
              display: "flex", alignItems: "center", gap: 8, fontSize: 12,
            }}>
              <span style={{ color: a.status === "BLOCKED" ? t.error : "#22C55E" }}>
                <Ic n={a.status === "BLOCKED" ? "alert" : "check-circle"} s={14} />
              </span>
              <strong style={{ color: t.heading }}>{a.attributeName}</strong>
              <span style={{ color: t.dim }}>= {a.attributeValue}</span>
              <span style={{ color: t.dim }}>· {a.dataType ?? "(unresolved)"}</span>
              <span style={{ color: t.dim }}>· {a.status}</span>
              {a.reason && <span style={{ color: t.error }}>— {a.reason}</span>}
            </div>
          ))}
        </div>

        <details>
          <summary style={{ fontSize: 11.5, color: t.dim, cursor: "pointer" }}>Raw JSON</summary>
          <pre style={{
            margin: "6px 0 0", maxHeight: 420, overflow: "auto", fontSize: 11, lineHeight: 1.5,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            background: isDark ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.04)",
            border: `1px solid ${t.border}`, borderRadius: 8, padding: 10, color: t.body, whiteSpace: "pre-wrap",
          }}>{JSON.stringify({ product2Id, sellingModelId, priceAdjustmentScheduleId, attributes }, null, 2)}</pre>
        </details>
      </div>
    </Section>
  );
}
