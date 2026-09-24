"use client";

import { Ic, tokens } from "@/components/data/quotes/shared";

export type ImportCheckStatus = "ok" | "warning" | "error";

export interface ImportCheck {
  id: string;
  label: string;
  status: ImportCheckStatus;
}

const STATUS_META: Record<ImportCheckStatus, { icon: string; color: string }> = {
  ok: { icon: "check", color: "#22C55E" },
  warning: { icon: "alert", color: "#F59E0B" },
  error: { icon: "x", color: "#FF4066" },
};

/**
 * Compact structural-validation checklist shown right after a file parses,
 * before the user commits to Column Mapping. This is informational, not a
 * second validation engine: every check here is derived from data the parse
 * response and each module's own `ImportFieldDef[]`/auto-suggested mapping
 * already produced (lib/import/columnMapping.ts's suggestColumnMapping) — it
 * never re-implements field-level validation, which stays owned by
 * ImportMappingStep (missing-required banner) and each module's own
 * `.../import/validate` route (the actual Salesforce-side gate).
 */
export default function ImportValidationSummary({
  isDark, title = "File Validation", checks,
}: {
  isDark: boolean;
  title?: string;
  checks: ImportCheck[];
}) {
  const t = tokens(isDark);
  return (
    <div style={{ borderRadius: 14, border: `1px solid ${t.border}`, background: t.surface, padding: "12px 16px" }}>
      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 8 }}>{title}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {checks.map(c => {
          const meta = STATUS_META[c.status];
          return (
            <div key={c.id} className="flex items-center gap-2" style={{ fontSize: 12, color: c.status === "ok" ? t.body : meta.color }}>
              <span style={{ color: meta.color, flexShrink: 0 }}><Ic n={meta.icon} s={13} /></span>
              {c.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}
