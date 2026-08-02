"use client";

import { useState, useSyncExternalStore } from "react";
import { Ic, tokens } from "@/components/data/quotes/shared";
import ContractHistoryList from "@/components/data/contracts/ContractHistoryList";
import CreateContractFlow from "@/components/data/contracts/CreateContractFlow";
import ContractWorkspace from "@/components/data/contracts/ContractWorkspace";
import ContractPreviewPanel from "@/components/data/contracts/ContractPreviewPanel";
import DocuSignSettings from "@/components/data/contracts/DocuSignSettings";
import { subscribeExecutionLog, getExecutionLogSnapshot } from "@/lib/quotes/client/executionLog";

type View = { mode: "history" } | { mode: "create" } | { mode: "workspace"; contractId: string; tab?: string } | { mode: "docusign-settings" };

interface NavigatePatch { cv?: string | null; cid?: string | null; ctab?: string | null }

/**
 * Top-level entry point for the Contract / document-generation / e-signature
 * module, mounted as the "Contracts" tile's content inside DataOmnion
 * (app/data/page.tsx) — mirrors OrdersModule.tsx/QuotesModule.tsx exactly
 * (same layout shell, same Diagnostics drawer pattern, same execution-log
 * store) so the Contracts tile feels like it has always been part of
 * DataOmnion, per the "slot into existing nav, don't add a new top-level
 * area" instruction.
 */
export default function ContractsModule({
  isDark,
  initialView = "history",
  initialWorkspaceId,
  initialTab,
  onNavigate,
}: {
  isDark: boolean;
  initialView?: "history" | "create" | "workspace" | "docusign-settings";
  /** Contract id to resume into, from the page's URL — only meaningful when initialView is "workspace". */
  initialWorkspaceId?: string;
  /** Workspace tab to resume into, from the page's URL — only applied for the same contract this module was first mounted with. */
  initialTab?: string;
  /** Bubbles this module's view (and its workspace's active tab) up so the page can keep the URL in sync — refresh then restores the same contract/tab instead of resetting to History. */
  onNavigate?: (patch: NavigatePatch) => void;
}) {
  const t = tokens(isDark);
  const [view, setViewState] = useState<View>(() => {
    if (initialView === "workspace" && initialWorkspaceId) return { mode: "workspace", contractId: initialWorkspaceId };
    if (initialView === "docusign-settings") return { mode: "docusign-settings" };
    if (initialView === "create") return { mode: "create" };
    return { mode: "history" };
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  function setView(next: View) {
    setViewState(next);
    onNavigate?.({
      cv: next.mode,
      cid: next.mode === "workspace" ? next.contractId : null,
      ctab: null, // the newly (re)mounted workspace/tab, if any, reasserts its own resolved tab right after mount
    });
  }
  const log = useSyncExternalStore(subscribeExecutionLog, getExecutionLogSnapshot, getExecutionLogSnapshot);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 700, color: t.heading }}>
          <Ic n="file-contract" s={16} /> Contracts
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setView({ mode: "docusign-settings" })}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9,
              border: `1px solid ${view.mode === "docusign-settings" ? t.accent + "60" : t.border}`, cursor: "pointer", fontSize: 12.5, fontWeight: 600,
              background: view.mode === "docusign-settings" ? `${t.accent}18` : "transparent", color: view.mode === "docusign-settings" ? t.accent : t.body,
            }}
          >
            <Ic n="plug" s={13} /> DocuSign Settings
          </button>
          <button
            onClick={() => setDrawerOpen(v => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9,
              border: `1px solid ${drawerOpen ? t.accent + "60" : t.border}`, cursor: "pointer", fontSize: 12.5, fontWeight: 600,
              background: drawerOpen ? `${t.accent}18` : "transparent", color: drawerOpen ? t.accent : t.body,
            }}
            title="Execution Log, Generated JSON, Salesforce Response — always available"
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
            <Ic n="plus" s={13} /> Create Contract
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="flex-1 min-h-0 overflow-hidden" style={{ display: "flex", flexDirection: "column" }}>
          {view.mode === "history" && <ContractHistoryList isDark={isDark} onOpen={id => setView({ mode: "workspace", contractId: id })} />}
          {view.mode === "create" && (
            <CreateContractFlow isDark={isDark} onViewContract={id => setView({ mode: "workspace", contractId: id, tab: "documents" })} />
          )}
          {view.mode === "workspace" && (
            <ContractWorkspace
              isDark={isDark}
              contractId={view.contractId}
              initialTab={view.tab ?? (initialWorkspaceId === view.contractId ? initialTab : undefined)}
              onTabChange={tab => onNavigate?.({ cv: "workspace", cid: view.contractId, ctab: tab })}
              onBack={() => setView({ mode: "history" })}
            />
          )}
          {view.mode === "docusign-settings" && <DocuSignSettings isDark={isDark} onBack={() => setView({ mode: "history" })} />}
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
            <ContractPreviewPanel isDark={isDark} requestJson={{ note: "This drawer mirrors whatever the active view most recently built — open a contract's own Diagnostics tab for exact request payloads." }} initialTab="logs" />
          </div>
        )}
      </div>
    </div>
  );
}
