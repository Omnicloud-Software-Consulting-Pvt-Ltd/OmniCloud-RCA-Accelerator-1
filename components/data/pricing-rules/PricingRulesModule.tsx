"use client";

import { useState } from "react";
import { Ic, tokens } from "./shared";
import PricingRuleHistoryList from "./PricingRuleHistoryList";
import CreatePricingRuleFlow from "./CreatePricingRuleFlow";

type View = { mode: "history" } | { mode: "create" };
interface NavigatePatch { pv?: string | null }

/**
 * Top-level entry point for the Pricing Rules module, mounted as the
 * "Pricing Rules" tile's content inside DataOmnion (app/data/page.tsx) —
 * mirrors QuotesModule/OrdersModule/ContractsModule's history/create shell.
 */
export default function PricingRulesModule({
  isDark,
  initialView = "history",
  onNavigate,
}: {
  isDark: boolean;
  initialView?: "history" | "create";
  initialWorkspaceId?: string;
  initialTab?: string;
  onNavigate?: (patch: NavigatePatch) => void;
}) {
  const t = tokens(isDark);
  const [view, setViewState] = useState<View>(initialView === "create" ? { mode: "create" } : { mode: "history" });

  function setView(next: View) {
    setViewState(next);
    onNavigate?.({ pv: next.mode });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 700, color: t.heading }}>
          <Ic n="zap" s={16} /> Pricing Rules
        </div>
        <div style={{ display: "flex", gap: 8 }}>
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
            <Ic n="plus" s={13} /> Create Rule
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0" style={{ display: "flex", flexDirection: "column", overflow: view.mode === "history" ? "auto" : "hidden" }}>
        {view.mode === "history" && <PricingRuleHistoryList isDark={isDark} />}
        {view.mode === "create" && <CreatePricingRuleFlow isDark={isDark} onDone={() => setView({ mode: "history" })} />}
      </div>
    </div>
  );
}
