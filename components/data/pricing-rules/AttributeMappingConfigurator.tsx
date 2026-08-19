"use client";

import { useMemo, useState } from "react";
import { Ic, tokens, PrimaryButton, Pill, inputStyle } from "./shared";
import type { AttributeValueRow, ExtractedAdjustmentType } from "@/lib/pricing-rules/attribute-based/types";

/**
 * §Attribute Mapping & Pricing Configuration (Parts 1-8) — the interactive
 * screen shown whenever at least one prompt-mentioned attribute value either
 * doesn't exist in Salesforce yet or has no adjustment configured. Every
 * edit here (dropdown selection, adjustment type/value) is pure local state —
 * nothing is sent to the server until "Next" is clicked, and nothing is ever
 * written to Salesforce until the user reaches the separate final
 * confirmation screen and clicks "Create in Salesforce" (Part 6).
 */

const CREATE_NEW_SENTINEL = "__create_new__";

export interface AttributeMappingOverridesPayload {
  attributeValueMappings: Record<string, string>;
  valuesToCreate: string[];
  adjustmentOverrides: Record<string, { adjustmentType: ExtractedAdjustmentType; adjustment: number }>;
}

function rowKey(row: AttributeValueRow): string {
  return `${row.attributeName}::${row.enteredValue}`;
}

interface RowState {
  /** null = unresolved, CREATE_NEW_SENTINEL = will be created, otherwise a real Salesforce value. */
  selection: string | null;
  adjustmentType: ExtractedAdjustmentType;
  /** Kept as text so the field can be legitimately empty (unset) rather than defaulting to "0". */
  amountText: string;
}

function initialRowState(row: AttributeValueRow): RowState {
  let selection: string | null = null;
  if (row.existing) selection = row.resolvedValue;
  else if (row.markedForCreation) selection = CREATE_NEW_SENTINEL;
  else if (row.suggestion?.confidence === "high") selection = row.suggestion.value;

  return {
    selection,
    adjustmentType: row.adjustmentType,
    amountText: row.adjustmentStated ? String(row.adjustment) : "",
  };
}

const ADJUSTMENT_TYPE_OPTIONS: { value: ExtractedAdjustmentType; label: string }[] = [
  { value: "fixed", label: "Fixed Price" },
  { value: "percentage", label: "Percentage" },
  { value: "override", label: "Override Value" },
];

function amountPlaceholder(type: ExtractedAdjustmentType): string {
  if (type === "percentage") return "e.g. 10";
  if (type === "override") return "e.g. 1499";
  return "e.g. 200";
}

function amountPrefixSuffix(type: ExtractedAdjustmentType): { prefix?: string; suffix?: string } {
  if (type === "percentage") return { suffix: "%" };
  return { prefix: "$" };
}

export default function AttributeMappingConfigurator({
  isDark,
  rows,
  onNext,
  submitting,
}: {
  isDark: boolean;
  rows: AttributeValueRow[];
  onNext: (overrides: AttributeMappingOverridesPayload) => void;
  submitting: boolean;
}) {
  const t = tokens(isDark);
  const [state, setState] = useState<Record<string, RowState>>(() => {
    const initial: Record<string, RowState> = {};
    for (const row of rows) initial[rowKey(row)] = initialRowState(row);
    return initial;
  });

  const grouped = useMemo(() => {
    const byAttr = new Map<string, { label: string; rows: AttributeValueRow[] }>();
    for (const row of rows) {
      const existing = byAttr.get(row.attributeName);
      if (existing) existing.rows.push(row);
      else byAttr.set(row.attributeName, { label: row.attributeLabel, rows: [row] });
    }
    return [...byAttr.values()];
  }, [rows]);

  function updateRow(key: string, patch: Partial<RowState>) {
    setState(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function isRowComplete(row: AttributeValueRow): boolean {
    const s = state[rowKey(row)];
    if (!s) return false;
    if (!row.existing && s.selection === null) return false;
    const amount = Number(s.amountText);
    return s.amountText.trim() !== "" && Number.isFinite(amount);
  }

  const allComplete = rows.every(isRowComplete);
  const unresolvedCount = rows.filter(r => !r.existing && !state[rowKey(r)]?.selection).length;
  const incompleteAmountCount = rows.filter(r => state[rowKey(r)]?.amountText.trim() === "").length;

  function handleNext() {
    const attributeValueMappings: Record<string, string> = {};
    const valuesToCreate: string[] = [];
    const adjustmentOverrides: Record<string, { adjustmentType: ExtractedAdjustmentType; adjustment: number }> = {};

    for (const row of rows) {
      const key = rowKey(row);
      const s = state[key];
      if (!s) continue;
      if (!row.existing) {
        if (s.selection === CREATE_NEW_SENTINEL) valuesToCreate.push(key);
        else if (s.selection) attributeValueMappings[key] = s.selection;
      }
      const amount = Number(s.amountText);
      if (s.amountText.trim() !== "" && Number.isFinite(amount)) {
        adjustmentOverrides[key] = { adjustmentType: s.adjustmentType, adjustment: amount };
      }
    }

    onNext({ attributeValueMappings, valuesToCreate, adjustmentOverrides });
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div className="flex items-center gap-2" style={{ color: t.warn, fontWeight: 700, fontSize: 13 }}>
          <Ic n="sliders" s={16} /> Attribute Mapping &amp; Pricing Configuration
        </div>
        <p style={{ fontSize: 12, color: t.dim, margin: "4px 0 0" }}>
          Salesforce is the source of truth — map every value that doesn&apos;t already exist to a real Salesforce
          value or mark it to be created, then set the adjustment for every row. Nothing is created in Salesforce
          until you confirm on the next screen.
        </p>
      </div>

      {grouped.map(group => (
        <div key={group.label} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 12.5, fontWeight: 700, color: t.heading, margin: 0 }}>{group.label}</p>
          <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${t.border}` }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 640 }}>
              <thead>
                <tr style={{ background: t.surfaceAlt }}>
                  {["Prompt Value", "Salesforce Value", "Adjustment Type", "Adjustment"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "7px 10px", color: t.dim, fontWeight: 700, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3, borderBottom: `1px solid ${t.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.rows.map(row => {
                  const key = rowKey(row);
                  const s = state[key] ?? initialRowState(row);
                  const { prefix, suffix } = amountPrefixSuffix(s.adjustmentType);
                  return (
                    <tr key={key} style={{ borderBottom: `1px solid ${t.border}` }}>
                      <td style={{ padding: "8px 10px", color: t.body, verticalAlign: "top" }}>{row.enteredValue}</td>
                      <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                        {row.existing ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <Pill label="✓ Existing" color="#22C55E" isDark={isDark} />
                            <span style={{ color: t.body }}>{row.resolvedValueLabel}</span>
                          </div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <select
                              value={s.selection ?? ""}
                              onChange={e => updateRow(key, { selection: e.target.value || null })}
                              style={inputStyle(t)}
                            >
                              <option value="">Select…</option>
                              {row.availableValues.map(v => (
                                <option key={v.value} value={v.value}>{v.label}</option>
                              ))}
                              <option value={CREATE_NEW_SENTINEL}>+ Create New Value</option>
                            </select>
                            {s.selection === CREATE_NEW_SENTINEL ? (
                              <Pill label="Will be created" color={t.accent} isDark={isDark} />
                            ) : (
                              <span style={{ fontSize: 11, color: t.dim }}>
                                Available: {row.availableValues.map(v => v.label).join(", ") || "(none)"}
                                {row.suggestion && row.suggestion.confidence !== "high" && (
                                  <> — did you mean &ldquo;{row.suggestion.label}&rdquo;?</>
                                )}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                        <select
                          value={s.adjustmentType}
                          onChange={e => updateRow(key, { adjustmentType: e.target.value as ExtractedAdjustmentType })}
                          style={inputStyle(t)}
                        >
                          {ADJUSTMENT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {prefix && <span style={{ color: t.dim, fontSize: 12.5 }}>{prefix}</span>}
                          <input
                            type="number"
                            value={s.amountText}
                            onChange={e => updateRow(key, { amountText: e.target.value })}
                            placeholder={amountPlaceholder(s.adjustmentType)}
                            style={{ ...inputStyle(t), width: 110 }}
                          />
                          {suffix && <span style={{ color: t.dim, fontSize: 12.5 }}>{suffix}</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", paddingTop: 4, borderTop: `1px solid ${t.border}` }}>
        <PrimaryButton label={submitting ? "Validating…" : "Next"} icon="arrow-right" isDark={isDark} disabled={!allComplete || submitting} onClick={handleNext} />
        {!allComplete && (
          <span style={{ fontSize: 11.5, color: t.warn }}>
            {unresolvedCount > 0 && `${unresolvedCount} value(s) still need mapping. `}
            {incompleteAmountCount > 0 && `${incompleteAmountCount} row(s) still need an adjustment amount.`}
          </span>
        )}
      </div>
    </div>
  );
}
