"use client";

import { Ic } from "@/components/data/dashboardShell";
import { tokens } from "@/components/data/quotes/shared";

/** Shown above the existing Create Tax Rate form when it was opened by "Use This Rate" (Global Tax Rate Library). */
export default function PrefillNotice({ isDark, notice }: { isDark: boolean; notice: { notices: string[]; warnings: string[]; summary: string } }) {
  const t = tokens(isDark);
  return (
    <div role="note" data-testid="rate-library-prefill" style={{ borderRadius: 12, padding: "10px 12px", border: `1px solid ${t.accent}45`, background: `${t.accent}0c`, display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 800, color: t.heading }}>
        <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="globe" s={14} /></span> Prefilled from the Global Tax Rate Library · <code style={{ color: t.accent }}>{notice.summary}</code>
      </div>
      {notice.warnings.map((w, i) => <div key={`w${i}`} style={{ fontSize: 12, color: t.warn, display: "flex", gap: 6 }}><Ic n="alert" s={12} />{w}</div>)}
      {notice.notices.map((n, i) => <div key={`n${i}`} style={{ fontSize: 12, color: t.body }}>{n}</div>)}
    </div>
  );
}
