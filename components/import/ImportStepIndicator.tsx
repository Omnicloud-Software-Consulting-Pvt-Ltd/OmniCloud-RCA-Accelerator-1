"use client";

import { Ic, tokens } from "@/components/data/quotes/shared";

export interface ImportStepDef {
  id: string;
  label: string;
}

/**
 * Shared bulk-import stage stepper (Upload / Map & Validate / Preview /
 * Create) — extracted from what was six near-identical inline copies (one
 * per importer) so every module renders the exact same pill markup. Purely
 * presentational: it only reads `currentIndex`, it never drives step
 * transitions itself.
 */
export default function ImportStepIndicator({
  isDark, steps, currentIndex,
}: {
  isDark: boolean;
  steps: ImportStepDef[];
  currentIndex: number;
}) {
  const t = tokens(isDark);
  return (
    <div className="flex items-center gap-2 mb-2" style={{ flexWrap: "wrap" }} role="list" aria-label="Import progress">
      {steps.map((s, i) => {
        const done = i < currentIndex;
        const current = i === currentIndex;
        const bg = done
          ? (isDark ? "rgba(34,197,94,0.16)" : "rgba(34,197,94,0.12)")
          : current
          ? `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})`
          : (isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)");
        const color = done ? "#22C55E" : current ? "#04101F" : t.dim;
        return (
          <div key={s.id} className="flex items-center gap-2" role="listitem">
            <div
              aria-current={current ? "step" : undefined}
              style={{
                display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                color, background: bg,
                border: done ? "1px solid rgba(34,197,94,0.35)" : "none",
              }}
            >
              <span style={{
                width: 15, height: 15, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9,
                background: done ? "rgba(34,197,94,0.25)" : current ? "rgba(4,16,31,0.25)" : "transparent",
                border: current || done ? "none" : `1px solid ${t.border}`,
              }}>
                {done ? <Ic n="check" s={9} /> : i + 1}
              </span>
              {s.label}
            </div>
            {i < steps.length - 1 && <span style={{ color: t.dim, opacity: 0.5 }}><Ic n="chevron-right" s={12} /></span>}
          </div>
        );
      })}
    </div>
  );
}
