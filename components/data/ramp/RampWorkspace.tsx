"use client";

import { useCallback, useState } from "react";
import { ObjectWorkspace, type ActionDef } from "@/components/data/dashboardShell";
import { tokens, GhostButton } from "@/components/data/quotes/shared";
import type { RampDealDraft, RampExecution } from "@/lib/ramp/types";
import ProductRampSetup from "./ProductRampSetup";
import RampSchedules from "./RampSchedules";
import RampDeals from "./RampDeals";
import RampAiBuilder from "./RampAiBuilder";
import { RampExecutionCenter, RampHistory } from "./RampActivity";
import { Notice, StorageBanner, useRampEnv, useRampGet } from "./rampUi";

/**
 * RAMP Management workspace — one shell for every RAMP page. Each sidebar item opens it at a view; the homepage cards navigate
 * inside it. All data is per connected org and comes from /api/ramp/* (server-side).
 */
export const RAMP_VIEWS = ["home", "product-setup", "schedules", "deals", "group-deals", "executions", "history", "ai-builder"] as const;
export type RampView = (typeof RAMP_VIEWS)[number];

export const RAMP_VIEW_LABELS: Record<RampView, string> = {
  home: "RAMP Management", "product-setup": "Product Ramp Setup", schedules: "Ramp Schedules", deals: "Ramp Deals", "group-deals": "Group Ramp Deals",
  executions: "Ramp Execution Center", history: "Ramp History", "ai-builder": "AI Ramp Builder",
};

/** The homepage cards (the RAMP modules + the AI builder). `workflow` is the view each card opens. */
export const RAMP_HOME_CARDS: ActionDef[] = [
  { id: "product-setup", title: "Product Ramp Setup", desc: "Make products rampable: create Product Ramp Segments per selling model", icon: "package", accent: "#00D4FF", workflow: "product-setup" },
  { id: "schedules", title: "Ramp Schedules", desc: "Reusable segment templates — periods, trials, uplifts, quantities", icon: "calendar", accent: "#3AABFF", workflow: "schedules" },
  { id: "deals", title: "Ramp Deals", desc: "Split a quote line into yearly ramp segments (Ramp Deal API)", icon: "trending-up", accent: "#60B8FF", workflow: "deals" },
  { id: "group-deals", title: "Group Ramp Deals", desc: "Ramp a whole quote line group with Salesforce group ramp segments", icon: "layers", accent: "#7C83FF", workflow: "group-deals" },
  { id: "executions", title: "Ramp Execution Center", desc: "Resumable server-side runs with read-back verification", icon: "activity", accent: "#F59E0B", workflow: "executions" },
  { id: "history", title: "Ramp History", desc: "Persistent audit trail of every RAMP action and Salesforce call", icon: "clock", accent: "#94A3B8", workflow: "history" },
  { id: "ai-builder", title: "AI Ramp Builder", desc: "Describe a ramp in plain language — get an editable draft", icon: "sparkles", accent: "#E879F9", workflow: "ai-builder" },
];

export function isRampView(v: unknown): v is RampView { return typeof v === "string" && (RAMP_VIEWS as readonly string[]).includes(v); }

export default function RampWorkspace({ isDark, initialView, onViewChange }: { isDark: boolean; initialView?: string | null; onViewChange?: (view: RampView) => void }) {
  const t = tokens(isDark);
  const env = useRampEnv();
  const [view, setViewState] = useState<RampView>(isRampView(initialView) ? initialView : "home");
  const [draft, setDraft] = useState<Partial<RampDealDraft> | null>(null);
  const setView = useCallback((v: RampView) => { setViewState(v); onViewChange?.(v); }, [onViewChange]);
  const clearDraft = useCallback(() => setDraft(null), []);
  const execs = useRampGet<{ rows: (Omit<RampExecution, "steps"> & { deal: RampDealDraft | null })[] }>("Load ramp executions", view === "home" ? "/api/ramp/executions" : null);
  const caps = env.capabilities;

  const body = (() => {
    switch (view) {
      case "product-setup": return <ProductRampSetup isDark={isDark} caps={caps} instanceUrl={env.instanceUrl} />;
      case "schedules": return <RampSchedules isDark={isDark} />;
      case "deals": return <RampDeals isDark={isDark} kind="line" caps={caps} instanceUrl={env.instanceUrl} draft={draft?.kind !== "group" ? draft : null} onDraftUsed={clearDraft} />;
      case "group-deals": return <RampDeals isDark={isDark} kind="group" caps={caps} instanceUrl={env.instanceUrl} draft={draft?.kind === "group" ? draft : null} onDraftUsed={clearDraft} />;
      case "executions": return <RampExecutionCenter isDark={isDark} instanceUrl={env.instanceUrl} />;
      case "history": return <RampHistory isDark={isDark} instanceUrl={env.instanceUrl} />;
      case "ai-builder": return <RampAiBuilder isDark={isDark} onOpenDraft={d => { setDraft(d); setView(d.kind === "group" ? "group-deals" : "deals"); }} />;
      default: return null;
    }
  })();

  if (view === "home") {
    const rows = execs.data?.rows ?? [];
    const count = (f: (s: string) => boolean) => String(rows.filter(r => f(r.status)).length);
    return (
      <div data-testid="ramp-home" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <ObjectWorkspace isDark={isDark} subtitle="Product ramp segments, schedules, line and group ramp deals, uplift pricing, resumable execution and history — verified against Salesforce."
          obj={{ id: "ramp", label: "RAMP Management", icon: "trending-up", groupLabel: "RAMP", color: "#00D4FF", actions: RAMP_HOME_CARDS,
            stats: [{ label: "Runs", value: execs.data ? String(rows.length) : "—" }, { label: "Completed", value: execs.data ? count(s => s === "completed") : "—" }, { label: "In progress", value: execs.data ? count(s => ["pending", "in-progress", "waiting"].includes(s)) : "—" }, { label: "Need attention", value: execs.data ? count(s => s === "failed" || s === "interrupted") : "—" }] }}
          onLaunch={wf => { if (isRampView(wf)) setView(wf); }}
          recentActivityLabel="Recent ramp runs"
          recentActivity={rows.slice(0, 5).map(r => ({ type: r.status, item: r.deal?.name ?? r.dealId, meta: `${r.kind} ramp`, time: r.updatedAt.slice(0, 16).replace("T", " "), color: r.status === "completed" ? "#00C875" : r.status === "failed" || r.status === "interrupted" ? "#FF4066" : "#3AABFF" }))}
          extraSection={<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {env.error && <Notice isDark={isDark} tone="error">{env.error}</Notice>}
            <StorageBanner isDark={isDark} storage={env.storage} />
            {caps && <Notice isDark={isDark} tone="info">This org (API v{caps.apiVersion}): Product Ramp Segments <b>{caps.productRampSegment.available ? "available" : "unavailable"}</b> · line ramps <b>{caps.lineRamp.available ? "available" : "unavailable"}</b> · group ramps <b>{caps.groupRamp.available ? "available" : "unavailable"}</b> · compound uplift <b>{caps.compound.group ? "group ramps" : "unavailable"}{caps.compound.line ? " + lines" : ""}</b>.</Notice>}
          </div>} />
      </div>
    );
  }

  return (
    <div data-testid={`ramp-view-${view}`} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px clamp(12px, 3vw, 28px) 32px", display: "flex", flexDirection: "column", gap: 14, background: t.bg }}>
      <nav aria-label="Breadcrumb" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <GhostButton isDark={isDark} label="← RAMP home" onClick={() => setView("home")} />
        <span style={{ fontSize: 12, color: t.dim }}>RAMP /</span>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: t.heading }}>{RAMP_VIEW_LABELS[view]}</h1>
      </nav>
      {env.error && <Notice isDark={isDark} tone="error">{env.error}</Notice>}
      <StorageBanner isDark={isDark} storage={env.storage} />
      <div key={view} style={{ display: "contents" }}>{body}</div>
    </div>
  );
}
