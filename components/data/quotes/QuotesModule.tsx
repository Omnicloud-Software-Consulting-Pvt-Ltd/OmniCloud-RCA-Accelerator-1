"use client";

import { useState, useSyncExternalStore } from "react";
import { Ic, tokens } from "@/components/data/quotes/shared";
import QuoteHistoryList from "@/components/data/quotes/QuoteHistoryList";
import CreateQuoteFlow from "@/components/data/quotes/CreateQuoteFlow";
import QuoteWorkspace from "@/components/data/quotes/QuoteWorkspace";
import PreviewPanel from "@/components/data/quotes/PreviewPanel";
import { subscribeExecutionLog, getExecutionLogSnapshot } from "@/lib/quotes/client/executionLog";

type View = { mode: "history" } | { mode: "create" } | { mode: "workspace"; quoteId: string };

interface NavigatePatch { qv?: string | null; qid?: string | null; qtab?: string | null }

/**
 * Top-level entry point for the Quote / Quote Line Item module, mounted as
 * the "Quotes" tile's content inside DataOmnion (app/data/page.tsx) —
 * clicking "Create Quote" launches the full AI-assisted Quote + bundle-aware
 * line-item authoring workflow described in the Quote/QLI spec.
 *
 * Layout: this is the outermost `flex flex-col h-full overflow-hidden`
 * boundary for the whole module. The header/nav below is a fixed-height
 * flex-none row; everything else (including the diagnostics drawer) is a
 * flex-1 min-h-0 region so nested views can each own their own single
 * scroll region without ever clipping content unreachable (see shared.tsx).
 */
export default function QuotesModule({
  isDark,
  initialView = "history",
  initialWorkspaceId,
  initialTab,
  onNavigate,
}: {
  isDark: boolean;
  initialView?: "history" | "create" | "workspace";
  /** Quote id to resume into, from the page's URL — only meaningful when initialView is "workspace". */
  initialWorkspaceId?: string;
  /** Workspace tab to resume into, from the page's URL — only applied for the same quote this module was first mounted with. */
  initialTab?: string;
  /** Bubbles this module's view (and its workspace's active tab) up so the page can keep the URL in sync — refresh then restores the same quote/tab instead of resetting to History. */
  onNavigate?: (patch: NavigatePatch) => void;
}) {
  const t = tokens(isDark);
  const [view, setViewState] = useState<View>(() => {
    if (initialView === "workspace" && initialWorkspaceId) return { mode: "workspace", quoteId: initialWorkspaceId };
    if (initialView === "create") return { mode: "create" };
    return { mode: "history" };
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  function setView(next: View) {
    setViewState(next);
    onNavigate?.({
      qv: next.mode,
      qid: next.mode === "workspace" ? next.quoteId : null,
      qtab: null, // the newly (re)mounted workspace/tab, if any, reasserts its own resolved tab right after mount
    });
  }
  const log = useSyncExternalStore(subscribeExecutionLog, getExecutionLogSnapshot, getExecutionLogSnapshot);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 700, color: t.heading }}>
          <Ic n="file-text" s={16} /> Quotes
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setDrawerOpen(v => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9,
              border: `1px solid ${drawerOpen ? t.accent + "60" : t.border}`, cursor: "pointer", fontSize: 12.5, fontWeight: 600,
              background: drawerOpen ? `${t.accent}18` : "transparent", color: drawerOpen ? t.accent : t.body,
            }}
            title="Execution Log, Generated JSON, Salesforce Response, Bundle Diagnostics — always available"
          >
            <Ic n="activity" s={13} /> Diagnostics
            {log.length > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: "0 5px", borderRadius: 999, background: t.accent, color: "#04101F" }}>{log.length}</span>
            )}
          </button>
          <button
            onClick={() => setView({ mode: "history" })}
            style={{
              padding: "7px 14px", borderRadius: 9, border: `1px solid ${t.border}`, cursor: "pointer", fontSize: 12.5, fontWeight: 600,
              background: view.mode === "history" ? `${t.accent}20` : "transparent", color: view.mode === "history" ? t.accent : t.body,
            }}
          >
            History
          </button>
          <button
            onClick={() => setView({ mode: "create" })}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, border: "none", cursor: "pointer",
              fontSize: 12.5, fontWeight: 700, color: "#04101F",
              background: `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})`,
            }}
          >
            <Ic n="plus" s={13} /> Create Quote
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="flex-1 min-h-0 overflow-hidden" style={{ display: "flex", flexDirection: "column" }}>
          {view.mode === "history" && <QuoteHistoryList isDark={isDark} onOpen={id => setView({ mode: "workspace", quoteId: id })} />}
          {view.mode === "create" && <CreateQuoteFlow isDark={isDark} />}
          {view.mode === "workspace" && (
            <QuoteWorkspace
              isDark={isDark}
              quoteId={view.quoteId}
              initialTab={initialWorkspaceId === view.quoteId ? initialTab : undefined}
              onTabChange={tab => onNavigate?.({ qv: "workspace", qid: view.quoteId, qtab: tab })}
              onBack={() => setView({ mode: "history" })}
            />
          )}
        </div>

        {drawerOpen && (
          <div
            className="flex-shrink-0 min-h-0 overflow-y-auto"
            style={{ width: 420, borderLeft: `1px solid ${t.border}`, background: t.bg, padding: 16 }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: t.heading, display: "flex", alignItems: "center", gap: 6 }}>
                <Ic n="activity" s={14} /> Session Diagnostics
              </div>
              <button onClick={() => setDrawerOpen(false)} style={{ background: "transparent", border: "none", cursor: "pointer", color: t.dim }}>
                <Ic n="x" s={15} />
              </button>
            </div>
            <PreviewPanel isDark={isDark} requestJson={{ note: "This drawer mirrors whatever the active view most recently built — open the Preview step for the exact request payload." }} initialTab="logs" />
          </div>
        )}
      </div>
    </div>
  );
}
