"use client";

import { useMemo } from "react";
import { Ic, ObjectWorkspace, type ActionDef, type DashboardObject, type RecentOp, type StatDef } from "@/components/data/dashboardShell";
import { tokens, ErrorPanel, Spinner } from "@/components/data/quotes/shared";
import { ModuleCard } from "@/components/data/billing/BillingDashboard";
import { StatusPill } from "@/components/data/billing/billingUi";
import type { ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import { getBillingModule } from "@/lib/billing/registry";
import { TAX_DASHBOARD_MODULES } from "@/lib/taxes/modules";
import type { BillingStatsResponse } from "@/lib/billing/types";
import type { TaxDashboard } from "@/lib/tax/types";
import type { TaxProviderInfo } from "@/lib/taxes/provider";
import { NativeTaxConfigurationNotice } from "@/components/data/taxes/NativeTaxGuidance";
import TaxLibraryWidget from "@/components/data/taxes/library/TaxLibraryWidget";

const ACCENT = "#00D4FF";
const ACCENT_SOFT = "#60B8FF";

export type TaxesLaunch = "configure" | "configure-manual" | "calculation" | "readiness" | { module: string; view: "module" | "create" | "history" } | { module: string; view: "detail"; id: string } | { library: { countryCode?: string | null } };

/**
 * Taxes landing page — same dashboard shell and cards as Revenue Cloud Billing. Every count comes from Salesforce
 * (GET /api/taxes/stats); configuration vs calculation status comes from GET /api/taxes. Nothing is hard-coded.
 */
export default function TaxesDashboard({ isDark, stats, statsError, statsLoading, summary, provider, connectionKey, onReload, onLaunch }: {
  isDark: boolean;
  stats: BillingStatsResponse | null; statsError: ErrorPanelDataLike | null; statsLoading: boolean;
  summary: TaxDashboard | null;
  /** From the dashboard's own TaxEngine read; null while it loads. */
  provider: TaxProviderInfo | null; connectionKey: string;
  onReload: () => void;
  onLaunch: (target: TaxesLaunch) => void;
}) {
  const t = tokens(isDark);
  const byKey = useMemo(() => new Map((stats?.modules ?? []).map(m => [m.moduleKey, m])), [stats]);
  const count = (key: string) => byKey.get(key)?.recordCount ?? null;
  const st = summary?.status;
  const obj: DashboardObject = {
    id: "taxes-overview", label: "Taxes", icon: "dollar-sign", groupLabel: "Data Omni", color: ACCENT,
    stats: [
      { label: "Tax policies", value: String(count("tax-policies") ?? "—") },
      { label: "Tax treatments", value: String(count("tax-treatments") ?? "—") },
      { label: "Tax rates", value: String(count("tax-rates") ?? "—") },
      { label: "Tax engines", value: String(count("tax-engines") ?? "—") },
      { label: "Configuration", value: st?.configuration ?? "—" },
      { label: "Calculation", value: st?.calculation ?? "—" },
    ] satisfies StatDef[],
    actions: ([
      { id: "ai", title: "AI Tax Configuration", desc: "Describe the tax — the AI proposes the Salesforce records, you review the dependency-ordered preview, then confirm.", icon: "sparkles", accent: ACCENT_SOFT, badge: "AI", workflow: "configure" },
      { id: "manual", title: "Manual Configuration", desc: "Engine → Policy → Treatments → Items → Rates → Products, validated against the org's metadata.", icon: "edit", accent: ACCENT, workflow: "configure-manual" },
      { id: "calc", title: "Tax Calculation", desc: "Run a real Order → Invoice → InvoiceLineTax and read Salesforce's own tax result.", icon: "check-circle", accent: ACCENT, workflow: "calculation" },
      { id: "ready", title: "Engine Readiness", desc: "Can Salesforce calculate tax? Decision table, engine and permission checks (read-only).", icon: "activity", accent: ACCENT_SOFT, workflow: "readiness" },
    ] satisfies ActionDef[]),
  };
  const recentActivity: RecentOp[] = (stats?.modules ?? []).filter(m => m.available && m.lastModifiedDate)
    .sort((a, b) => (b.lastModifiedDate ?? "").localeCompare(a.lastModifiedDate ?? "")).slice(0, 6)
    .map(m => ({ type: "Updated", item: getBillingModule(m.moduleKey)?.label ?? m.moduleKey, meta: m.sobject ?? "", time: formatRelativeTime(m.lastModifiedDate!), color: ACCENT }));

  const cards = TAX_DASHBOARD_MODULES.map(k => ({ def: getBillingModule(k)!, status: byKey.get(k) })).filter(c => c.def && c.status?.available);
  const unavailable = (stats?.modules ?? []).filter(m => !m.available);
  const extra = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <NativeTaxConfigurationNotice isDark={isDark} provider={provider} connectionKey={connectionKey}
        readiness={st ? { blocked: st.calculation === "BLOCKED", detail: st.calculationDetail } : undefined} onOpenReadiness={() => onLaunch("readiness")} />
      {st && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: t.body }}>
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><b style={{ color: t.heading }}>Configuration</b> <StatusPill status={st.configuration} isDark={isDark} /> <span style={{ color: t.dim }}>{st.configurationDetail}</span></span>
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><b style={{ color: t.heading }}>Calculation</b> <StatusPill status={st.calculation} isDark={isDark} /> <span style={{ color: t.dim }}>{st.calculationDetail}</span></span>
        </div>
      )}
      <TaxLibraryWidget isDark={isDark} connectionKey={connectionKey} onLaunch={onLaunch} />
      {statsError && <ErrorPanel isDark={isDark} error={statsError} />}
      {!stats && statsLoading && <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}><Spinner isDark={isDark} /> Reading the tax objects of the connected org…</div>}
      {stats && (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
            <p className="text-[10px] font-semibold tracking-widest uppercase" style={{ color: isDark ? "rgba(0,212,255,0.5)" : "rgba(0,71,171,0.66)", margin: 0 }}>Tax Configuration</p>
            <span style={{ fontSize: 11, color: t.dim }}>Salesforce objects behind Revenue Cloud tax — counts read live from the org.</span>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
            {cards.map((c, i) => (
              <ModuleCard key={c.def.key} isDark={isDark} def={c.def} status={c.status!} index={i} labels={{ create: "Create New", history: "View Records" }}
                onOpen={() => onLaunch({ module: c.def.key, view: "module" })} onCreate={() => onLaunch({ module: c.def.key, view: "create" })} onHistory={() => onLaunch({ module: c.def.key, view: "history" })} />
            ))}
          </div>
        </div>
      )}
      {unavailable.length > 0 && (
        <div style={{ fontSize: 11.5, color: t.dim, padding: "10px 12px", borderRadius: 10, border: `1px dashed ${t.border}` }}>
          <strong style={{ color: t.body }}>Not available in this org: </strong>{unavailable.map(m => `${getBillingModule(m.moduleKey)?.label} (${m.candidatesTried.join(", ")})`).join(" · ")}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: t.dim }}>Not shown: Tax Regions/Jurisdictions (no such objects in this org), a Tax Code object (Tax Code is a field on rates, treatments and items) and Tax Engine Providers (none exist; they need an Apex adapter — Salesforce Setup).</div>
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
    <ObjectWorkspace obj={obj} isDark={isDark} onLaunch={wf => onLaunch(wf as TaxesLaunch)}
      subtitle="Configure Revenue Cloud tax — policies, treatments, items, rates, geography and engines — by AI prompt or Salesforce-style forms, then prove the calculation on a real invoice. Every card reflects the connected org."
      extraSection={extra} recentActivity={recentActivity} recentActivityLabel="Recently changed tax configuration" />
  );
}
