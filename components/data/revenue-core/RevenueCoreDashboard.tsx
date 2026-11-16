"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ic, ObjectWorkspace, type ActionDef, type DashboardObject, type RecentOp, type StatDef } from "@/components/data/dashboardShell";
import { tokens, ErrorPanel, Spinner, GhostButton, EmptyState } from "@/components/data/quotes/shared";
import { ModuleCard } from "@/components/data/billing/BillingDashboard";
import { StatusPill } from "@/components/data/billing/billingUi";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import { REVENUE_CORE_AREAS, REVENUE_CORE_KPIS, REVENUE_CORE_MODULES, getRevenueCoreModule, kpiValue, type RevenueCoreNavTarget } from "@/lib/revenueCore/modules";
import type { RevenueCoreStatsResponse } from "@/app/api/revenue-core/stats/route";

const ACCENT = "#00D4FF";
const ACCENT_BLUE = "#3AABFF";
const ACCENT_SOFT = "#60B8FF";

const SHORTCUTS: (ActionDef & { target: RevenueCoreNavTarget })[] = [
  { id: "create-product", title: "Create Product", desc: "Describe a product in plain language — review the generated fields, then create it in Salesforce.", icon: "plus", accent: ACCENT, badge: "AI", target: { tile: "products", view: "choose-type" } },
  { id: "product-configuration", title: "Product Configuration", desc: "Check a product's selling model, catalog, price book, tax and billing setup and what's still missing.", icon: "layers", accent: ACCENT, badge: "AI", target: { tile: "products", view: "configuration" } },
  { id: "create-attribute", title: "Create Attributes", desc: "Define attributes, picklists and categories, then assign them to products or classifications.", icon: "sliders", accent: ACCENT_SOFT, badge: "AI", target: { tile: "attributes", view: "create" } },
  { id: "create-bundle", title: "Create Bundle", desc: "Build a bundle with its component groups and quantity rules.", icon: "package", accent: ACCENT_BLUE, badge: "AI", target: { tile: "bundles", view: "create" } },
  { id: "create-pricing-rule", title: "Pricing Rules", desc: "Tier, volume, attribute- and bundle-based pricing on a pricing procedure.", icon: "zap", accent: ACCENT, badge: "AI", target: { tile: "pricing-rules", view: "create" } },
  { id: "catalogs", title: "Catalogs & Categories", desc: "Organise products into catalogs and categories.", icon: "book-open", accent: ACCENT_BLUE, target: { tile: "catalogs" } },
  { id: "create-quote", title: "Create Quote", desc: "Use configured products on a quote to check pricing end to end.", icon: "file-text", accent: ACCENT_BLUE, target: { tile: "quotes", view: "create" } },
  { id: "billing-policies", title: "Billing Setup", desc: "Next step after pricing: the Billing Policy and Treatment that decide how products are invoiced.", icon: "credit-card", accent: ACCENT_SOFT, target: { tile: "billing-policies" } },
];

/**
 * Revenue Cloud Core landing page — the product-configuration side of Revenue Cloud (catalog, attributes, bundles,
 * selling models, price books, pricing procedures, configurator). Same shell, cards and states as the Billing and Tax
 * dashboards. Every number comes from GET /api/revenue-core/stats (live Salesforce counts); objects the org doesn't
 * have are listed as unavailable, never shown as zero. Cards open the EXISTING module that manages each object.
 */
export default function RevenueCoreDashboard({ isDark, onNavigate }: { isDark: boolean; onNavigate: (target: RevenueCoreNavTarget) => void }) {
  const t = tokens(isDark);
  const [data, setData] = useState<RevenueCoreStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);

  // State is only set from the request's callbacks; `load` (Refresh/Retry) flips loading first.
  const fetchStats = useCallback((fresh: boolean) => {
    quoteApiGet<RevenueCoreStatsResponse>("Load Revenue Cloud Core dashboard", `/api/revenue-core/stats${fresh ? "?fresh=1" : ""}`)
      .then(d => { setData(d); setError(null); })
      .catch(err => setError(toErrorPanelData(err, "Could not load Revenue Cloud Core statistics")))
      .finally(() => setLoading(false));
  }, []);
  const load = (fresh: boolean) => { setLoading(true); setError(null); fetchStats(fresh); };

  useEffect(() => { fetchStats(false); }, [fetchStats]);

  const byKey = useMemo(() => new Map((data?.modules ?? []).map(m => [m.moduleKey, m])), [data]);

  const stats: StatDef[] = REVENUE_CORE_KPIS
    .filter(k => !data || byKey.get(k.moduleKey)?.available) // once loaded, omit KPIs for objects this org doesn't have
    .map(k => {
      const v = data ? kpiValue(byKey.get(k.moduleKey), k.measure) : null;
      return { label: k.label, value: v === null ? "—" : String(v) };
    });

  const obj: DashboardObject = {
    id: "revenue-core", label: "Revenue Cloud Core", icon: "zap", groupLabel: "Revenue Cloud Core", color: ACCENT,
    stats, actions: SHORTCUTS.map(a => ({ id: a.id, title: a.title, desc: a.desc, icon: a.icon, accent: a.accent, badge: a.badge, workflow: a.id })),
  };

  const activity: RecentOp[] = (data?.modules ?? [])
    .filter(m => m.available && m.lastModifiedDate)
    .sort((a, b) => (b.lastModifiedDate ?? "").localeCompare(a.lastModifiedDate ?? ""))
    .slice(0, 8)
    .map(m => ({ type: "Updated", item: getRevenueCoreModule(m.moduleKey)?.label ?? m.moduleKey, meta: m.sobject ?? "", time: formatRelativeTime(m.lastModifiedDate!), color: ACCENT }));

  const unavailable = (data?.modules ?? []).filter(m => !m.available);
  const orgIsEmpty = !!data && (byKey.get("products")?.recordCount ?? 0) === 0 && byKey.get("products")?.available;

  const extra = (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, marginBottom: 8 }}>
      {error && (
        <div>
          <ErrorPanel isDark={isDark} error={error} />
          <div className="mt-3"><GhostButton label="Retry" icon="refresh" isDark={isDark} onClick={() => load(true)} /></div>
        </div>
      )}
      {!data && loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}>
          <Spinner isDark={isDark} /> Reading the Revenue Cloud Core objects of the connected org…
        </div>
      )}
      {orgIsEmpty && (
        <EmptyState isDark={isDark} icon="package" title="No products in this org yet"
          hint="Start with Create Product — then add a selling model, a price book entry and a catalog category so the product can be quoted." />
      )}

      {data && REVENUE_CORE_AREAS.map(area => {
        const cards = REVENUE_CORE_MODULES.filter(m => m.area === area.id).map(def => ({ def, status: byKey.get(def.key) })).filter(c => c.status?.available);
        if (cards.length === 0) return null;
        return (
          <div key={area.id}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
              <p className="text-[10px] font-semibold tracking-widest uppercase" style={{ color: isDark ? "rgba(0,212,255,0.5)" : "rgba(0,71,171,0.66)", margin: 0 }}>{area.label}</p>
              <span style={{ fontSize: 11, color: t.dim }}>{area.description}</span>
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
              {cards.map((c, i) => (
                <ModuleCard key={c.def.key} isDark={isDark} def={c.def} status={{ ...c.status!, createable: !!c.def.create && c.status!.createable }} index={i}
                  labels={{ create: "Create New", history: "Open" }}
                  onOpen={() => { if (c.def.open) onNavigate(c.def.open); }}
                  onCreate={() => { if (c.def.create) onNavigate(c.def.create); }}
                  onHistory={c.def.open ? () => onNavigate(c.def.open!) : undefined} />
              ))}
            </div>
          </div>
        );
      })}

      {data && (
        <div>
          <p className="text-[10px] font-semibold tracking-widest uppercase mb-3" style={{ color: isDark ? "rgba(0,212,255,0.5)" : "rgba(0,71,171,0.66)" }}>Recently Created Products</p>
          {data.recentProductsError ? (
            <div style={{ fontSize: 11.5, color: t.warn }}>Recent products unavailable: {data.recentProductsError}</div>
          ) : (data.recentProducts ?? []).length === 0 ? (
            <div style={{ fontSize: 11.5, color: t.dim }}>No products have been created in this org yet.</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {(data.recentProducts ?? []).map(p => (
                <button key={p.id} onClick={() => onNavigate({ tile: "products", view: "history" })}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg text-left"
                  style={{ cursor: "pointer", background: isDark ? "rgba(8,16,32,0.4)" : "rgba(222,235,255,0.85)", border: isDark ? "1px solid rgba(0,212,255,0.06)" : "1px solid rgba(0,71,171,0.10)" }}>
                  <StatusPill status={p.isActive ? "Active" : "Draft"} isDark={isDark} />
                  <span className="text-[12px] font-medium flex-1 truncate" style={{ color: t.heading }}>{p.name}</span>
                  <span className="text-[10.5px] shrink-0" style={{ color: t.dim }}>{[p.productCode, p.type ?? "Standard"].filter(Boolean).join(" · ")}</span>
                  <span className="text-[10.5px] shrink-0" style={{ color: t.dim }}>{formatRelativeTime(p.createdDate)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {unavailable.length > 0 && (
        <div style={{ fontSize: 11.5, color: t.dim, padding: "10px 12px", borderRadius: 10, border: `1px dashed ${t.border}` }}>
          <strong style={{ color: t.body }}>Not available in this org: </strong>
          {unavailable.map(m => `${getRevenueCoreModule(m.moduleKey)?.label ?? m.moduleKey} (${m.candidatesTried.join(", ")})`).join(" · ")}
        </div>
      )}

      {data && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: t.dim }}>
          <span>Counts from Salesforce · API {data.apiVersion} · {formatRelativeTime(data.generatedAt)}</span>
          <button onClick={() => load(true)} disabled={loading} style={{ background: "transparent", border: "none", color: t.accent, cursor: "pointer", fontWeight: 700, fontSize: 11, display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Ic n="refresh" s={11} /> {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <ObjectWorkspace
      obj={obj}
      isDark={isDark}
      onLaunch={wf => { const s = SHORTCUTS.find(x => x.id === wf); if (s) onNavigate(s.target); }}
      subtitle="Products, attributes, catalogs, bundles, selling models, price books and pricing procedures — the product configuration every quote, order and invoice depends on. Every count is read live from the connected org."
      extraSection={extra}
      recentActivity={activity}
      recentActivityLabel="Configuration Activity — recently changed Revenue Cloud Core objects"
    />
  );
}
