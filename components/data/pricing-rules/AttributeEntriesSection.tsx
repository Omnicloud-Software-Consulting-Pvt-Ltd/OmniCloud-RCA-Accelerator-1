"use client";

import { Ic, tokens, inputStyle, Spinner, EmptyState, GhostButton } from "./shared";
import type { AttributePricingEntry, ProductAttributeData, AttributePricingType } from "@/lib/pricing-rules/types";

const PRICING_TYPE_SUFFIX: Record<AttributePricingType, string> = {
  "Percentage Discount": "%",
  "Fixed Amount": "$",
  "Override Price": "=$",
};

/**
 * §6 — one row per discovered AttributeValue, grouped by attribute for
 * display. No add/remove UI: rows are always exactly what Salesforce
 * returned. Non-price-impacting attributes are excluded upstream (at
 * fetch time), not filtered here.
 */
export default function AttributeEntriesSection({
  isDark,
  entries,
  attributeData,
  isFetchingAttributes,
  attributeError,
  onFetchAttributes,
  onEntryChange,
}: {
  isDark: boolean;
  entries: AttributePricingEntry[];
  attributeData?: ProductAttributeData | null;
  isFetchingAttributes?: boolean;
  attributeError?: string | null;
  onFetchAttributes?: () => void;
  onEntryChange?: (entryId: string, field: keyof AttributePricingEntry, value: string) => void;
}) {
  const t = tokens(isDark);

  if (isFetchingAttributes) {
    return (
      <div className="flex items-center gap-2 justify-center py-8" style={{ color: t.dim, fontSize: 12.5 }}>
        <Spinner isDark={isDark} /> Discovering price-impacting attributes from Salesforce…
      </div>
    );
  }

  if (attributeError) {
    return (
      <div style={{ padding: "16px 0", display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
        <div style={{ color: t.error, fontSize: 12.5 }}>{attributeError}</div>
        {onFetchAttributes && <GhostButton label="Retry" icon="refresh" isDark={isDark} onClick={onFetchAttributes} />}
      </div>
    );
  }

  if (!attributeData) {
    return <EmptyState isDark={isDark} icon="sliders" title="Enter a Product Name above" hint="Attributes are discovered automatically once a matching product is found." />;
  }

  if (attributeData.totalAttributes === 0 || entries.length === 0) {
    return (
      <div style={{
        padding: 12, borderRadius: 10, border: `1px solid ${t.warn}55`, background: isDark ? "rgba(245,158,11,0.08)" : "rgba(245,158,11,0.07)",
        color: t.warn, fontSize: 12.5, display: "flex", alignItems: "center", gap: 8,
      }}>
        <Ic n="alert" s={15} /> &quot;{attributeData.product.name}&quot; has no price-impacting attributes configured in Salesforce.
      </div>
    );
  }

  const grouped = new Map<string, AttributePricingEntry[]>();
  for (const entry of entries) {
    const key = entry.attributeName;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(entry);
  }
  const populatedCount = entries.filter(e => e.pricingType && e.adjustmentValue.trim()).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {[...grouped.entries()].map(([attrName, rows]) => (
        <div key={attrName}>
          <div style={{ fontSize: 12, fontWeight: 700, color: t.heading, marginBottom: 6 }}>{rows[0].attributeLabel || attrName}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rows.map(row => (
              <div key={row.id} style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) minmax(180px, 260px) minmax(140px, 220px)", gap: 8, alignItems: "center" }}>
                <div style={{
                  padding: "8px 12px", borderRadius: 8, fontSize: 12.5, color: t.body,
                  background: t.surfaceAlt, border: `1px solid ${t.border}`,
                }}>
                  {row.attributeValueLabel || row.attributeValue}
                </div>
                <select
                  value={row.pricingType}
                  onChange={e => onEntryChange?.(row.id, "pricingType", e.target.value)}
                  style={inputStyle(t)}
                >
                  <option value="">— not set —</option>
                  <option value="Percentage Discount">Percentage Discount (%)</option>
                  <option value="Fixed Amount">Fixed Amount ($)</option>
                  <option value="Override Price">Override Price</option>
                </select>
                <div style={{ position: "relative" }}>
                  <input
                    type="number"
                    value={row.adjustmentValue}
                    onChange={e => onEntryChange?.(row.id, "adjustmentValue", e.target.value)}
                    placeholder="0.00"
                    disabled={!row.pricingType}
                    style={{ ...inputStyle(t, { readOnly: !row.pricingType }), paddingRight: 32 }}
                  />
                  {row.pricingType && (
                    <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 11.5, color: t.dim, pointerEvents: "none" }}>
                      {PRICING_TYPE_SUFFIX[row.pricingType]}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div style={{ fontSize: 11.5, color: t.dim, borderTop: `1px solid ${t.border}`, paddingTop: 8 }}>
        {populatedCount} of {entries.length} values priced
      </div>
    </div>
  );
}
