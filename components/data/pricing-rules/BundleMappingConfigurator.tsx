"use client";

/**
 * Bundle-Based Pricing — per-component adjustment grid, shown when a matched real bundle component still
 * needs an adjustment type/amount. Mirrors AttributeMappingConfigurator.tsx's editable-grid pattern, but
 * simpler: every row's component is ALREADY a real, resolved Salesforce Product2 (bundles are a closed
 * world — there is no "create new component" option here, unlike attribute values).
 */
import { useState } from "react";
import { Ic, tokens, PrimaryButton, Pill, inputStyle } from "./shared";
import type { ComponentAdjustmentRow, ExtractedAdjustmentType } from "@/lib/pricing-rules/bundle-based/types";

export interface BundleAdjustmentOverridesPayload {
  adjustmentOverrides: Record<string, { adjustmentType: ExtractedAdjustmentType; adjustment: number }>;
}

interface RowState { adjustmentType: ExtractedAdjustmentType; amountText: string }

const ADJUSTMENT_TYPE_OPTIONS: { value: ExtractedAdjustmentType; label: string }[] = [
  { value: "fixed", label: "Fixed Amount" },
  { value: "percentage", label: "Percentage" },
  { value: "override", label: "Override Value" },
];

function amountPrefixSuffix(type: ExtractedAdjustmentType): { prefix?: string; suffix?: string } {
  if (type === "percentage") return { suffix: "%" };
  return { prefix: "$" };
}

function initialRowState(row: ComponentAdjustmentRow): RowState {
  return { adjustmentType: row.adjustmentType, amountText: row.adjustmentStated ? String(row.adjustment) : "" };
}

export default function BundleMappingConfigurator({
  isDark, rows, onNext, submitting,
}: {
  isDark: boolean;
  rows: ComponentAdjustmentRow[];
  onNext: (overrides: BundleAdjustmentOverridesPayload) => void;
  submitting: boolean;
}) {
  const t = tokens(isDark);
  const [state, setState] = useState<Record<string, RowState>>(() => {
    const initial: Record<string, RowState> = {};
    for (const row of rows) initial[row.componentName] = initialRowState(row);
    return initial;
  });

  function updateRow(componentName: string, patch: Partial<RowState>) {
    setState(prev => ({ ...prev, [componentName]: { ...prev[componentName], ...patch } }));
  }

  const incompleteCount = rows.filter(r => (state[r.componentName]?.amountText ?? "").trim() === "").length;
  const allComplete = incompleteCount === 0;

  function handleNext() {
    const adjustmentOverrides: BundleAdjustmentOverridesPayload["adjustmentOverrides"] = {};
    for (const row of rows) {
      const s = state[row.componentName];
      if (!s) continue;
      const amount = Number(s.amountText);
      if (s.amountText.trim() !== "" && Number.isFinite(amount)) {
        adjustmentOverrides[row.componentName] = { adjustmentType: s.adjustmentType, adjustment: amount };
      }
    }
    onNext({ adjustmentOverrides });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 13.5, color: t.body }}>
        Set the adjustment for each requested component. These are real, already-resolved bundle components — you&apos;re only confirming how much each one adjusts the price by.
      </div>
      <div style={{ overflowX: "auto", border: `1px solid ${t.border}`, borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: t.surfaceAlt }}>
              <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim, letterSpacing: 0.4 }}>Component</th>
              <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim, letterSpacing: 0.4 }}>Adjustment Type</th>
              <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim, letterSpacing: 0.4 }}>Adjustment</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const s = state[row.componentName] ?? initialRowState(row);
              const { prefix, suffix } = amountPrefixSuffix(s.adjustmentType);
              return (
                <tr key={row.componentName} style={{ borderTop: `1px solid ${t.border}` }}>
                  <td style={{ padding: "8px 12px", color: t.heading }}>{row.componentName}</td>
                  <td style={{ padding: "8px 12px" }}>
                    <select
                      value={s.adjustmentType}
                      onChange={e => updateRow(row.componentName, { adjustmentType: e.target.value as ExtractedAdjustmentType })}
                      style={inputStyle(t)}
                    >
                      {ADJUSTMENT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {prefix && <span style={{ color: t.dim }}>{prefix}</span>}
                      <input
                        type="number"
                        value={s.amountText}
                        placeholder={s.adjustmentType === "percentage" ? "e.g. 10" : "e.g. 500"}
                        onChange={e => updateRow(row.componentName, { amountText: e.target.value })}
                        style={{ ...inputStyle(t), width: 120 }}
                      />
                      {suffix && <span style={{ color: t.dim }}>{suffix}</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <PrimaryButton label={submitting ? "Validating…" : "Next"} icon="check" isDark={isDark} disabled={!allComplete || submitting} onClick={handleNext} />
        {!allComplete && (
          <span style={{ fontSize: 11.5, color: t.warn, display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Ic n="alert" s={13} /> {incompleteCount} component(s) still need an adjustment amount.
          </span>
        )}
        <Pill label={`${rows.length} component(s)`} color={t.accent} isDark={isDark} />
      </div>
    </div>
  );
}
