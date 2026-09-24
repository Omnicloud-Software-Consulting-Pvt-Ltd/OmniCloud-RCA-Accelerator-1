"use client";

import { useEffect, useMemo, useState } from "react";
import { ObjectWorkspace, StatusBreakdownPanel, type DashboardObject, type StatDef, type ActionDef, type RecentOp } from "@/components/data/dashboardShell";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { tokens, Spinner, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import type { BundleStatsResponse } from "@/app/api/bundles/stats/route";
import type { BundleListItem } from "@/app/api/bundles/list/route";

export type BundleModuleTarget = { mode: "create" | "history" | "import" | "catalog" | "dependencies" | "components" };

const ACCENT = "#00D4FF";
const ACCENT_BLUE = "#3AABFF";
const ACCENT_SOFT = "#60B8FF";

/**
 * Bundle Workspace landing page (DataOmnion sidebar → Bundles) — mirrors
 * ProductsDashboard/QuotesDashboard exactly: header, stat cards, action
 * cards, and recent activity via the shared ObjectWorkspace, backed by real
 * Salesforce data (GET /api/bundles/stats) instead of a static config.
 * "Create Bundle" navigates into the existing, untouched
 * BundleOrchestrationWorkspace — this component never reimplements bundle
 * creation, dependency parsing, or Salesforce record creation.
 */
export default function BundlesDashboard({ isDark, onNavigate }: { isDark: boolean; onNavigate: (target: BundleModuleTarget) => void }) {
  const t = tokens(isDark);
  const [data, setData] = useState<BundleStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [bundleList, setBundleList] = useState<BundleListItem[] | null>(null);

  const fetchStats = () => {
    quoteApiGet<BundleStatsResponse>("Load bundle dashboard stats", "/api/bundles/stats")
      .then(setData)
      .catch(err => setError(toErrorPanelData(err, "Could not load Bundle statistics")))
      .finally(() => setLoading(false));
  };

  const retry = () => {
    setLoading(true);
    setError(null);
    fetchStats();
  };

  useEffect(() => { fetchStats(); }, []);

  useEffect(() => {
    if (!showAnalytics || bundleList !== null) return;
    quoteApiGet<{ success: true; bundles: BundleListItem[] }>("List bundles", "/api/bundles/list")
      .then(res => setBundleList(res.bundles))
      .catch(() => setBundleList([]));
  }, [showAnalytics, bundleList]);

  const mostUsedProducts = useMemo(() => {
    if (!bundleList) return [];
    const counts = new Map<string, number>();
    for (const b of bundleList) for (const c of b.children) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([status, count]) => ({ status, count, totalValue: null }));
  }, [bundleList]);

  const bundlesWithDependencies = useMemo(() => {
    if (!bundleList) return 0;
    return bundleList.filter(b => b.children.some(c => !c.isRequired)).length;
  }, [bundleList]);

  const obj: DashboardObject | null = useMemo(() => {
    if (!data) return null;

    const stats: StatDef[] = [
      { label: "Total Bundles", value: String(data.totalBundles) },
      { label: "Active Bundles", value: String(data.activeBundles) },
      { label: "Draft Bundles", value: String(data.draftBundles) },
      { label: "Bundle Components", value: String(data.totalComponents) },
      { label: "Recently Updated", value: String(data.recentlyUpdated) },
    ];

    const actions: ActionDef[] = [
      { id: "create-bundle", title: "Create Bundle", desc: "Create a new Revenue Cloud bundle using natural language.", icon: "plus", accent: ACCENT, badge: "AI", workflow: "create-bundle" },
      { id: "bundle-history", title: "Bundle History", desc: "View and manage bundles that have already been created.", icon: "list", accent: ACCENT_BLUE, workflow: "bundle-history" },
      { id: "import-bundles", title: "Import Bundles", desc: "Bulk import bundles and their products from CSV or Excel.", icon: "upload", accent: ACCENT_BLUE, badge: "Import", workflow: "import-bundles" },
      { id: "bundle-catalog", title: "Bundle Catalog", desc: "Browse and search all available bundles and their product structures.", icon: "layers", accent: ACCENT, workflow: "bundle-catalog" },
      { id: "bundle-dependencies", title: "Bundle Dependencies", desc: "View and manage dependencies between bundle products.", icon: "sliders", accent: ACCENT_SOFT, workflow: "bundle-dependencies" },
      { id: "bundle-components", title: "Bundle Components", desc: "View the products and components included in each bundle.", icon: "cube", accent: ACCENT_BLUE, workflow: "bundle-components" },
      { id: "bundle-analytics", title: "Bundle Analytics", desc: "View bundle usage, composition, activity, and configuration insights.", icon: "activity", accent: ACCENT, workflow: "bundle-analytics" },
    ];

    return {
      id: "bundles",
      label: "Bundles",
      icon: "package",
      groupLabel: "Revenue Cloud",
      color: ACCENT,
      stats,
      actions,
    };
  }, [data]);

  const recentActivity: RecentOp[] = useMemo(() => {
    if (!data) return [];
    return data.recentActivity.map(b => ({
      type: b.action,
      item: b.name,
      meta: [b.isActive ? "Active" : "Draft", b.lastModifiedByName].filter(Boolean).join(" · "),
      time: formatRelativeTime(b.lastModifiedDate),
      color: b.action === "Created" ? ACCENT : ACCENT_BLUE,
    }));
  }, [data]);

  const handleLaunch = (workflow: string) => {
    if (workflow === "create-bundle") onNavigate({ mode: "create" });
    else if (workflow === "bundle-history") onNavigate({ mode: "history" });
    else if (workflow === "import-bundles") onNavigate({ mode: "import" });
    else if (workflow === "bundle-catalog") onNavigate({ mode: "catalog" });
    else if (workflow === "bundle-dependencies") onNavigate({ mode: "dependencies" });
    else if (workflow === "bundle-components") onNavigate({ mode: "components" });
    else if (workflow === "bundle-analytics") setShowAnalytics(v => !v);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: t.dim }}>
          <Spinner isDark={isDark} /> Loading Bundle Workspace…
        </div>
      </div>
    );
  }

  if (error || !obj || !data) {
    return (
      <div className="p-5 overflow-y-auto h-full">
        <ErrorPanel isDark={isDark} error={error ?? { title: "Could not load Bundle statistics", message: "Unknown error" }} />
        <div className="mt-3">
          <GhostButton label="Retry" icon="refresh" isDark={isDark} onClick={retry} />
        </div>
      </div>
    );
  }

  return (
    <ObjectWorkspace
      obj={obj}
      isDark={isDark}
      onLaunch={handleLaunch}
      subtitle="Create, manage, import, configure, and analyze Revenue Cloud bundles."
      recentActivity={recentActivity}
      recentActivityLabel="Recent Bundle Activity"
      extraSection={showAnalytics ? (
        <>
          <StatusBreakdownPanel
            isDark={isDark}
            title="Bundles by Status"
            breakdown={[
              { status: "Active", count: data.activeBundles, totalValue: null },
              { status: "Draft", count: data.draftBundles, totalValue: null },
              { status: "With Optional Components", count: bundlesWithDependencies, totalValue: null },
            ]}
            valueFieldAvailable={false}
          />
          {bundleList === null ? (
            <div className="flex items-center gap-2 mb-8" style={{ fontSize: 12, color: t.dim }}><Spinner isDark={isDark} /> Loading component usage…</div>
          ) : mostUsedProducts.length > 0 && (
            <StatusBreakdownPanel isDark={isDark} title="Most Used Products (across all bundles)" breakdown={mostUsedProducts} valueFieldAvailable={false} />
          )}
        </>
      ) : undefined}
    />
  );
}
