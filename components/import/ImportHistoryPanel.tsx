"use client";

import { useState } from "react";
import { Ic, tokens, EmptyState } from "@/components/data/quotes/shared";
import { loadImportHistory, type ImportHistoryEntry, type ImportModule } from "@/lib/import/history";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Shared bulk-import History panel — originally Product-only
 * (components/data/products/import/ImportHistoryPanel.tsx, which now
 * delegates here), generalized to filter by module.
 */
export default function ImportHistoryPanel({ isDark, module, emptyHint }: { isDark: boolean; module: ImportModule; emptyHint: string }) {
  const t = tokens(isDark);
  // localStorage is synchronous and read-only for this panel's lifetime — a
  // lazy useState initializer avoids a setState-in-effect render cascade.
  const [entries] = useState<ImportHistoryEntry[]>(() => loadImportHistory(module));

  if (entries.length === 0) {
    return <EmptyState isDark={isDark} icon="upload" title="No imports yet" hint={emptyHint} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {entries.map(e => (
        <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface }}>
          <Ic n="file-text" s={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: t.heading, overflow: "hidden", textOverflow: "ellipsis" }}>{e.fileName}</div>
            <div style={{ fontSize: 11, color: t.dim, marginTop: 1 }}>{formatDate(e.importedAt)} · {e.total} record{e.total === 1 ? "" : "s"}</div>
          </div>
          <div style={{ display: "flex", gap: 8, fontSize: 11.5, fontWeight: 600, flexShrink: 0 }}>
            <span style={{ color: "#22C55E" }}>{e.created} Created</span>
            {e.failed > 0 && <span style={{ color: "#FF4066" }}>· {e.failed} Failed</span>}
            {e.skipped > 0 && <span style={{ color: t.dim }}>· {e.skipped} Skipped</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
