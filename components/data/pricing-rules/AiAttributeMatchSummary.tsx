"use client";

import { Ic, tokens } from "./shared";

/**
 * §AI-to-Salesforce attribute matching diagnostics — shown right after AI
 * generation triggers attribute discovery, BEFORE the user ever clicks
 * Create Procedure. Every AI-extracted pricing entry either landed on a
 * real discovered Salesforce attribute value ("priced"/"skipped") or
 * didn't ("unmatched-attribute"/"unmatched-value") — this is the visible
 * record of which, and why, so a silent "zero AttributeBasedAdjustment
 * records" failure at Create Procedure time never has to be reverse-
 * engineered after the fact.
 */
export interface AiMatchDiagnostic {
  attributeName: string;
  aiValue: string;
  status: "priced" | "skipped" | "unmatched-attribute" | "unmatched-value";
  matchedValueLabel?: string;
  /** The Salesforce values actually available for this attribute — only populated for an unmatched-value diagnostic, so the "why" is self-evident without cross-referencing the table. */
  candidateValues?: string[];
  reason?: string;
}

export interface AiMatchSummary {
  discovered: number;
  matched: number;
  priced: number;
  skipped: number;
  unmatched: number;
}

const STATUS_COLOR: Record<AiMatchDiagnostic["status"], string> = {
  priced: "#22C55E",
  skipped: "#F59E0B",
  "unmatched-attribute": "#FF4066",
  "unmatched-value": "#FF4066",
};
const STATUS_LABEL: Record<AiMatchDiagnostic["status"], string> = {
  priced: "Matched",
  skipped: "Matched — not priced",
  "unmatched-attribute": "No Match",
  "unmatched-value": "No Match",
};

export default function AiAttributeMatchSummary({
  isDark,
  summary,
  diagnostics,
}: {
  isDark: boolean;
  summary: AiMatchSummary;
  diagnostics: AiMatchDiagnostic[];
}) {
  const t = tokens(isDark);
  const issues = diagnostics.filter(d => d.status !== "priced");

  const counts: { label: string; value: number }[] = [
    { label: "Discovered Values", value: summary.discovered },
    { label: "Matched Values", value: summary.matched },
    { label: "Priced Values", value: summary.priced },
    { label: "Skipped Values", value: summary.skipped },
    { label: "Unmatched Values", value: summary.unmatched },
  ];

  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 10, padding: 12, background: t.surfaceAlt, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>
        AI → Salesforce Attribute Matching
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
        {counts.map(c => (
          <div key={c.label} style={{ borderRadius: 8, border: `1px solid ${t.border}`, padding: "6px 10px", textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: t.heading }}>{c.value}</div>
            <div style={{ fontSize: 10, color: t.dim }}>{c.label}</div>
          </div>
        ))}
      </div>

      {issues.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {issues.map((d, i) => (
            <div key={i} style={{ borderTop: `1px solid ${t.border}`, paddingTop: 8, fontSize: 11.5 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                <strong style={{ color: t.heading }}>{d.attributeName}:</strong>
                <span style={{ color: t.body }}>&quot;{d.aiValue}&quot;</span>
              </div>
              {d.candidateValues && d.candidateValues.length > 0 && (
                <div style={{ color: t.dim, marginTop: 2 }}>Salesforce Values: {d.candidateValues.join(", ")}</div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                <Ic n={d.status === "priced" || d.status === "skipped" ? "check-circle" : "alert"} s={12} />
                <span style={{ color: STATUS_COLOR[d.status], fontWeight: 600 }}>
                  {STATUS_LABEL[d.status]}{d.matchedValueLabel ? ` to "${d.matchedValueLabel}"` : ""}
                </span>
              </div>
              {d.reason && <div style={{ color: t.dim, marginTop: 2 }}>Reason: {d.reason}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
