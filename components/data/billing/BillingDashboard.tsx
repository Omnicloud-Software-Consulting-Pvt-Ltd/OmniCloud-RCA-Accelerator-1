"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Ic, hexToRgb, ObjectWorkspace, type ActionDef, type DashboardObject, type RecentOp, type StatDef } from "@/components/data/dashboardShell";
import { tokens, inputStyle, ErrorPanel, Spinner, PrimaryButton } from "@/components/data/quotes/shared";
import { StatusPill } from "@/components/data/billing/billingUi";
import { quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel, type BillingNavTarget } from "@/lib/billing/client";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import { BILLING_FLOW, BILLING_GROUPS, BILLING_MODULES, getBillingModule, type AppModuleLink, type BillingModuleDef } from "@/lib/billing/registry";
import type { BillingAnalysisResult, BillingModuleStatus, BillingStatsResponse } from "@/lib/billing/types";
import PromptGuide from "@/components/ai/PromptGuide";
import { billingPromptGuides } from "@/lib/ai/promptGuides/billing";

const ACCENT = "#00D4FF";
const ACCENT_BLUE = "#3AABFF";
const ACCENT_SOFT = "#60B8FF";

export function ModuleCard({ isDark, def, status, index, onOpen, onCreate, onHistory, labels }: {
  isDark: boolean; def: Pick<BillingModuleDef, "icon" | "label" | "description">; status: Pick<BillingModuleStatus, "createable" | "recordCount" | "statusBreakdown" | "lastModifiedDate" | "countError">; index: number;
  onOpen: () => void; onCreate: () => void; onHistory?: () => void;
  /** Button labels (defaults: Create / History). */
  labels?: { create?: string; history?: string };
}) {
  const t = tokens(isDark);
  const [hov, setHov] = useState(false);
  const rgb = hexToRgb(ACCENT);
  const top = (status.statusBreakdown ?? []).slice().sort((a, b) => b.count - a.count)[0];
  const btn = (label: string, icon: string, onClick: () => void, primary?: boolean) => (
    <button
      onClick={e => { e.stopPropagation(); onClick(); }}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 8, cursor: "pointer", fontSize: 11.5, fontWeight: 700,
        border: primary ? "none" : `1px solid ${t.border}`, color: primary ? "#04101F" : t.body,
        background: primary ? `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})` : "transparent",
      }}
    >
      <Ic n={icon} s={12} /> {label}
    </button>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03, duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ y: -2 }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={onOpen}
      className="relative rounded-xl p-4 flex flex-col gap-3 overflow-hidden"
      style={{
        cursor: "pointer",
        background: isDark ? (hov ? `rgba(${rgb},0.09)` : "rgba(8,16,32,0.58)") : (hov ? `rgba(${rgb},0.06)` : "rgba(228,241,255,0.90)"),
        border: hov ? `1px solid rgba(${rgb},0.38)` : isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,71,171,0.16)",
        boxShadow: hov ? `0 8px 32px rgba(${rgb},0.14)` : "none",
        backdropFilter: "blur(12px)",
        transition: "background 0.22s, border 0.22s, box-shadow 0.22s",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `rgba(${rgb},0.15)`, color: ACCENT, border: `1px solid rgba(${rgb},0.25)` }}>
          <Ic n={def.icon} s={15} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {!status.createable && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full" style={{ color: t.dim, border: `1px solid ${t.border}` }}>READ-ONLY</span>}
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: `rgba(${rgb},0.15)`, color: ACCENT, border: `1px solid rgba(${rgb},0.3)` }} title="Records in Salesforce">
            {status.recordCount ?? "—"}
          </span>
        </div>
      </div>
      <div className="flex-1">
        <p className="text-[13px] font-semibold mb-1" style={{ color: isDark ? "rgba(210,230,250,0.9)" : "rgba(0,15,45,0.88)", letterSpacing: "-0.01em" }}>{def.label}</p>
        <p className="text-[11px] leading-relaxed" style={{ color: isDark ? "rgba(100,130,170,0.65)" : "rgba(0,15,55,0.74)" }}>{def.description}</p>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minHeight: 20 }}>
        {top && <StatusPill status={`${top.status} · ${top.count}`} isDark={isDark} />}
        {status.lastModifiedDate && <span style={{ fontSize: 10.5, color: t.dim }}>updated {formatRelativeTime(status.lastModifiedDate)}</span>}
        {status.countError && <span style={{ fontSize: 10.5, color: t.warn }} title={status.countError}>count unavailable</span>}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {status.createable && btn(labels?.create ?? "Create", "plus", onCreate, true)}
        {onHistory && btn(labels?.history ?? "History", "list", onHistory)}
      </div>
    </motion.div>
  );
}

/**
 * Revenue Cloud Billing workspace landing page. Same shell as every other
 * DataOmnion dashboard; cards are generated from what the connected org
 * actually supports (GET /api/billing/stats) — unavailable concepts are
 * listed separately rather than shown as broken cards.
 */
export default function BillingDashboard({ isDark, stats, statsError, statsLoading, onReload, onNavigate, onDiscovery, onAnalyzed }: {
  isDark: boolean;
  stats: BillingStatsResponse | null;
  statsError: ErrorPanelDataLike | null;
  statsLoading: boolean;
  onReload: () => void;
  onNavigate: (target: BillingNavTarget) => void;
  onDiscovery: () => void;
  onAnalyzed: (result: BillingAnalysisResult, prompt: string) => void;
}) {
  const t = tokens(isDark);
  const [prompt, setPrompt] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [aiError, setAiError] = useState<ErrorPanelDataLike | null>(null);
  const byKey = useMemo(() => new Map((stats?.modules ?? []).map(m => [m.moduleKey, m])), [stats]);

  async function analyze() {
    if (!prompt.trim()) return;
    setAnalyzing(true);
    setAiError(null);
    try {
      const res = await quoteApiPost<BillingAnalysisResult>("AI billing assistant", "/api/billing/ai/analyze", { prompt });
      onAnalyzed(res, prompt);
    } catch (err) {
      setAiError(toBillingErrorPanel(err, "AI analysis failed"));
    } finally {
      setAnalyzing(false);
    }
  }

  const count = (key: string) => byKey.get(key)?.recordCount ?? null;
  const activeOf = (key: string) => byKey.get(key)?.statusBreakdown?.find(b => /^active$/i.test(b.status))?.count ?? null;
  const available = (stats?.modules ?? []).filter(m => m.available);

  const obj: DashboardObject = {
    id: "billing-overview",
    label: "Revenue Cloud Billing",
    icon: "credit-card",
    groupLabel: "Data Omni",
    color: ACCENT,
    stats: [
      { label: "Modules available", value: stats ? `${available.length}/${stats.modules.length}` : "—" },
      { label: "Active policies", value: String(activeOf("billing-policies") ?? count("billing-policies") ?? "—") },
      { label: "Active treatments", value: String(activeOf("billing-treatments") ?? count("billing-treatments") ?? "—") },
      { label: "Usage resources", value: String(count("usage-resources") ?? "—") },
      { label: "Billing schedules", value: String(count("billing-schedules") ?? "—") },
      { label: "Invoices", value: String(count("invoices") ?? "—") },
    ] satisfies StatDef[],
    actions: ([
      { id: "ai", title: "AI Billing Assistant", desc: "Describe any billing setup — the AI picks the right object and builds a reviewable configuration.", icon: "sparkles", accent: ACCENT_SOFT, badge: "AI", workflow: "ai" },
      { id: "policy", title: "Create Billing Policy", desc: "Decide which treatment applies to a product.", icon: "shield", accent: ACCENT, workflow: "create:billing-policies" },
      { id: "treatment", title: "Create Billing Treatment", desc: "Advance / arrears billing, split into treatment items.", icon: "layers", accent: ACCENT, badge: "AI", workflow: "create:billing-treatments" },
      { id: "usage", title: "Create Usage Resource", desc: "Set up usage-based billing with a unit and aggregation policy.", icon: "zap", accent: ACCENT_BLUE, badge: "AI", workflow: "create:usage-resources" },
      { id: "assign", title: "Assign Billing Policy to Product", desc: "Link an existing Billing Policy to an existing Product, with conflict and billing-chain checks.", icon: "link", accent: ACCENT_SOFT, badge: "AI", workflow: "assign" },
      { id: "rates", title: "Create Rate Card", desc: "Base or tiered usage rates.", icon: "table", accent: ACCENT_BLUE, workflow: "create:rate-cards" },
      { id: "orders", title: "Activate Orders", desc: "Billing schedules are generated when an order with billable products is activated.", icon: "shopping-cart", accent: ACCENT_BLUE, workflow: "app:orders" },
      { id: "debit-memos", title: "Debit Memos", desc: "Describe an additional charge — AI interprets it, records are resolved in Salesforce, you review, then it's created.", icon: "file-text", accent: ACCENT, badge: "AI", workflow: "debit-memos" },
      { id: "tax", title: "Tax", desc: "Configure Revenue Cloud tax — engine, policy, treatments, items and products — by AI prompt or manually, then verify Salesforce calculates it.", icon: "percent", accent: ACCENT, badge: "AI", workflow: "tax" },
      { id: "credit-memos", title: "Credit Memos", desc: "Credit posted invoices (per invoice line), then post, apply or void credit memos.", icon: "file-text", accent: ACCENT, badge: "AI", workflow: "credit-memos" },
      { id: "payments", title: "Payments", desc: "Record payments against posted invoices and track how they are applied.", icon: "credit-card", accent: ACCENT, badge: "AI", workflow: "payments" },
      { id: "discovery", title: "Inspect Salesforce Configuration", desc: "Which billing objects, fields and relationships this org supports.", icon: "database", accent: ACCENT_SOFT, workflow: "discovery" },
    ] satisfies ActionDef[]).filter(a => !a.workflow.startsWith("create:") || byKey.get(a.workflow.slice(7))?.createable),
  };

  const recentActivity: RecentOp[] = available
    .filter(m => m.lastModifiedDate)
    .sort((a, b) => (b.lastModifiedDate ?? "").localeCompare(a.lastModifiedDate ?? ""))
    .slice(0, 6)
    .map(m => ({ type: "Updated", item: getBillingModule(m.moduleKey)?.label ?? m.moduleKey, meta: m.sobject ?? "", time: formatRelativeTime(m.lastModifiedDate!), color: ACCENT }));

  const handleLaunch = (wf: string) => {
    if (wf === "ai") document.getElementById("billing-ai-prompt")?.focus();
    else if (wf === "discovery") onDiscovery();
    else if (wf === "assign") onNavigate({ assign: {} });
    else if (wf === "payments") onNavigate({ payment: { mode: "dashboard" } });
    else if (wf === "credit-memos") onNavigate({ creditMemo: { mode: "dashboard" } });
    else if (wf === "debit-memos") onNavigate({ debitMemo: { mode: "dashboard" } });
    else if (wf === "tax") onNavigate({ tax: { mode: "dashboard", tab: "create" } });
    else if (wf.startsWith("create:")) onNavigate({ billing: { moduleKey: wf.slice(7), view: "create" } });
    else if (wf.startsWith("app:")) onNavigate({ app: { module: wf.slice(4) as AppModuleLink } });
  };

  const flowNode = (step: (typeof BILLING_FLOW)[number]) => {
    const st = step.module ? byKey.get(step.module) : null;
    const ok = step.appModule ? true : !!st?.available;
    return (
      <button
        key={step.id}
        onClick={() => {
          if (step.module && st?.available) onNavigate({ billing: { moduleKey: step.module, view: "module" } });
          else if (step.appModule) onNavigate({ app: { module: step.appModule } });
        }}
        style={{
          display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "7px 11px", borderRadius: 10, cursor: ok ? "pointer" : "default", flexShrink: 0,
          border: `1px solid ${ok ? (step.module ? t.accent + "55" : t.border) : t.border}`, background: step.module && ok ? `${t.accent}10` : t.surface, opacity: ok ? 1 : 0.5,
        }}
        title={step.appModule ? "Handled by the existing module" : st?.sobject ?? "Not available in this org"}
      >
        <span style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, whiteSpace: "nowrap" }}>{step.label}</span>
        <span style={{ fontSize: 9.5, color: t.dim, whiteSpace: "nowrap" }}>{step.appModule ? "existing module" : st?.recordCount !== null && st?.recordCount !== undefined ? `${st.recordCount} records` : "—"}</span>
      </button>
    );
  };

  const extra = (
    <div style={{ display: "flex", flexDirection: "column", gap: 22, marginBottom: 28 }}>
      {/* AI assistant */}
      <div style={{ borderRadius: 16, padding: 16, border: `1px solid ${t.accent}45`, background: isDark ? "linear-gradient(135deg, rgba(0,212,255,0.08), rgba(30,144,255,0.04))" : "linear-gradient(135deg, rgba(0,152,204,0.07), rgba(9,104,211,0.03))" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 800, color: t.heading, marginBottom: 8 }}>
          <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="sparkles" s={15} /></span> AI Billing Assistant
          <span style={{ fontSize: 11, fontWeight: 500, color: t.dim }}>— describe it; the AI identifies the billing object, resolves names in Salesforce and prepares a preview.</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <textarea
            id="billing-ai-prompt"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) analyze(); }}
            rows={2}
            placeholder='e.g. "Create a usage-based billing configuration for Cloud Backup where customers are charged per GB consumed."'
            style={{ ...inputStyle(t), flex: "1 1 360px", resize: "vertical" }}
          />
          <PrimaryButton label={analyzing ? "Analyzing…" : "Analyze"} icon="sparkles" isDark={isDark} disabled={analyzing || !prompt.trim()} onClick={analyze} />
        </div>
        {analyzing && <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.dim }}><Spinner isDark={isDark} size={12} /> Identifying the billing object and building the configuration…</div>}
        {aiError && <div style={{ marginTop: 10 }}><ErrorPanel isDark={isDark} error={aiError} /></div>}
        <div style={{ marginTop: 10 }}><PromptGuide isDark={isDark} config={billingPromptGuides.dashboard} onUseExample={setPrompt} /></div>
      </div>

      {/* End-to-end flow */}
      <div>
        <p className="text-[10px] font-semibold tracking-widest uppercase mb-3" style={{ color: isDark ? "rgba(0,212,255,0.5)" : "rgba(0,71,171,0.66)" }}>End-to-End Billing Flow</p>
        <div style={{ display: "flex", alignItems: "center", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
          {BILLING_FLOW.map((s, i) => (
            <span key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {i > 0 && <span style={{ color: t.dim, display: "inline-flex" }}><Ic n="arrow-right" s={12} /></span>}
              {flowNode(s)}
            </span>
          ))}
        </div>
      </div>

      {statsError && <ErrorPanel isDark={isDark} error={statsError} />}
      {!stats && statsLoading && <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}><Spinner isDark={isDark} /> Discovering Revenue Cloud Billing objects in the connected org…</div>}

      {stats && BILLING_GROUPS.map(g => {
        const mods = BILLING_MODULES.filter(m => m.group === g.id && byKey.get(m.key)?.available);
        if (mods.length === 0) return null;
        return (
          <div key={g.id}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <p className="text-[10px] font-semibold tracking-widest uppercase" style={{ color: isDark ? "rgba(0,212,255,0.5)" : "rgba(0,71,171,0.66)", margin: 0 }}>{g.label}</p>
              <span style={{ fontSize: 11, color: t.dim }}>{g.description}</span>
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
              {mods.map((m, i) => (
                <ModuleCard
                  key={m.key}
                  isDark={isDark}
                  def={m}
                  status={byKey.get(m.key)!}
                  index={i}
                  onOpen={() => onNavigate({ billing: { moduleKey: m.key, view: "module" } })}
                  onCreate={() => onNavigate({ billing: { moduleKey: m.key, view: "create" } })}
                  onHistory={() => onNavigate({ billing: { moduleKey: m.key, view: "history" } })}
                />
              ))}
            </div>
          </div>
        );
      })}

      {stats && stats.modules.some(m => !m.available) && (
        <div style={{ fontSize: 11.5, color: t.dim, padding: "10px 12px", borderRadius: 10, border: `1px dashed ${t.border}` }}>
          <strong style={{ color: t.body }}>Not available in this org: </strong>
          {stats.modules.filter(m => !m.available).map(m => `${getBillingModule(m.moduleKey)?.label} (${m.candidatesTried.join(", ")})`).join(" · ")}
          <button onClick={onDiscovery} style={{ marginLeft: 8, background: "transparent", border: "none", color: t.accent, cursor: "pointer", fontWeight: 700, fontSize: 11.5 }}>Details →</button>
        </div>
      )}

      {stats && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: t.dim }}>
          <span>Counts from Salesforce · API {stats.apiVersion} · {formatRelativeTime(stats.generatedAt)}</span>
          <button onClick={onReload} disabled={statsLoading} style={{ background: "transparent", border: "none", color: t.accent, cursor: "pointer", fontWeight: 700, fontSize: 11, display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Ic n="refresh" s={11} /> {statsLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <ObjectWorkspace
      obj={obj}
      isDark={isDark}
      onLaunch={handleLaunch}
      subtitle="Configure how products are billed — policies, treatments, usage and rating — and follow activated orders through billing schedules to invoices. Every card reflects what the connected org actually supports."
      extraSection={extra}
      recentActivity={recentActivity}
      recentActivityLabel="Recently changed billing configuration"
    />
  );
}
