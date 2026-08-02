"use client";

import { Ic, tokens } from "@/components/data/quotes/shared";
import type { BundleHierarchyStep, LineItemCreationError } from "@/lib/quotes/types";

/** Structural subset of LineItemCreationResult (also satisfied by OrderLineItemCreationResult) — this view never touches failureDetail, so it stays reusable across both Quote and Order results without depending on their (differently-shaped) failure detail types. */
export interface BundleDiagnosticsResult {
  steps: BundleHierarchyStep[];
  success: boolean;
  createdCount: number;
  bundleHierarchyValid: boolean;
  issues: string[];
  errors: LineItemCreationError[];
}

function ChecklistRow({ t, label, ok }: { t: ReturnType<typeof tokens>; label: string; ok: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "6px 0" }}>
      <span style={{ color: ok ? t.accent : t.error }}><Ic n={ok ? "check-circle" : "alert"} s={14} /></span>
      <span style={{ color: t.body }}>{label}</span>
    </div>
  );
}

/**
 * Diagnostics/comparison view (§5.9): what the client intended vs. what the
 * server actually created — an explicit checklist rather than a bare pass/fail.
 */
export default function BundleDiagnosticsView({ isDark, result }: { isDark: boolean; result: BundleDiagnosticsResult | null }) {
  const t = tokens(isDark);

  if (!result) {
    return <div style={{ fontSize: 12.5, color: t.dim }}>No bundle creation has run yet this session.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <ChecklistRow t={t} label="Bundle definition loaded" ok={result.steps.some(s => s.step === "resolve-schema" && s.status === "success")} />
      <ChecklistRow t={t} label="Payload built and integrity-checked" ok={result.steps.some(s => s.step === "build-payloads" && s.status === "success")} />
      <ChecklistRow t={t} label="Line items created" ok={result.success && result.createdCount > 0} />
      <ChecklistRow t={t} label="Bundle hierarchy verified on read-back" ok={result.bundleHierarchyValid} />

      {result.issues.length > 0 && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 10, border: `1px solid ${t.warn}50`, fontSize: 12 }}>
          {result.issues.map((issue, i) => <div key={i} style={{ color: t.body }}>• {issue}</div>)}
        </div>
      )}

      {result.errors.length > 0 && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 10, border: `1px solid ${t.error}50`, fontSize: 12 }}>
          {result.errors.map((err, i) => (
            <div key={i} style={{ color: t.error }}>
              {err.path ? `${err.path.join(" → ")}: ` : ""}{err.message}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 6 }}>Step-by-step trace</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto" }}>
          {result.steps.map((step, i) => (
            <div key={i} style={{ fontSize: 11.5, color: step.status === "error" ? t.error : t.dim }}>
              [{step.status}] {step.step}: {step.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
