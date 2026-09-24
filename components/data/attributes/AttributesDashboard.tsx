"use client";

import { useEffect, useMemo, useState } from "react";
import { ObjectWorkspace, StatusBreakdownPanel, type DashboardObject, type StatDef, type ActionDef, type RecentOp } from "@/components/data/dashboardShell";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { tokens, Spinner, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import type { AttributeStatsResponse } from "@/app/api/sf/attributes/stats/route";
import type { AttributeListItem } from "@/lib/attributes/types";

export type AttributeModuleTarget = { mode: "create" | "history" | "import" | "catalog" };

const ACCENT = "#00D4FF";
const ACCENT_BLUE = "#1E90FF";
const ACCENT_SOFT = "#3AABFF";

/**
 * Attribute Workspace landing page (DataOmnion sidebar → Attributes) —
 * mirrors ProductsDashboard/BundlesDashboard exactly: header, stat cards,
 * action cards, and recent activity via the shared ObjectWorkspace, backed
 * by real Salesforce data (GET /api/sf/attributes/stats) instead of a
 * static config. "Create Attribute" navigates into the existing, untouched
 * RCAAttributeStudio — this component never reimplements attribute
 * generation, batch deployment, or Salesforce writes.
 */
export default function AttributesDashboard({ isDark, onNavigate }: { isDark: boolean; onNavigate: (target: AttributeModuleTarget) => void }) {
  const t = tokens(isDark);
  const [data, setData] = useState<AttributeStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [attributeList, setAttributeList] = useState<AttributeListItem[] | null>(null);

  const fetchStats = () => {
    quoteApiGet<AttributeStatsResponse>("Load attribute dashboard stats", "/api/sf/attributes/stats")
      .then(setData)
      .catch(err => setError(toErrorPanelData(err, "Could not load Attribute statistics")))
      .finally(() => setLoading(false));
  };

  const retry = () => {
    setLoading(true);
    setError(null);
    fetchStats();
  };

  useEffect(() => { fetchStats(); }, []);

  useEffect(() => {
    if (!showAnalytics || attributeList !== null) return;
    quoteApiGet<{ success: true; attributes: AttributeListItem[] }>("List attributes", "/api/sf/attributes/list")
      .then(res => setAttributeList(res.attributes))
      .catch(() => setAttributeList([]));
  }, [showAnalytics, attributeList]);

  const dataTypeBreakdown = useMemo(() => {
    if (!attributeList) return [];
    const counts = new Map<string, number>();
    for (const a of attributeList) {
      const key = a.dataType ?? "Unknown";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([status, count]) => ({ status, count, totalValue: null }));
  }, [attributeList]);

  const mostUsedProducts = useMemo(() => {
    if (!attributeList) return [];
    const counts = new Map<string, number>();
    for (const a of attributeList) for (const p of a.relatedProducts) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([status, count]) => ({ status, count, totalValue: null }));
  }, [attributeList]);

  const obj: DashboardObject | null = useMemo(() => {
    if (!data) return null;

    const stats: StatDef[] = [
      { label: "Total Attributes", value: String(data.totalAttributes) },
      { label: "Active Attributes", value: String(data.activeAttributes) },
      { label: "Recently Created", value: String(data.recentlyCreated) },
      { label: "Picklist Attributes", value: String(data.picklistAttributes) },
      { label: "Products Using Attributes", value: String(data.productsUsingAttributes) },
    ];

    const actions: ActionDef[] = [
      { id: "create-attribute", title: "Create Attribute", desc: "Generate and deploy Revenue Cloud attributes using natural language.", icon: "sparkles", accent: ACCENT, badge: "AI", workflow: "create-attribute" },
      { id: "attribute-history", title: "Attribute History", desc: "View, search, and edit attributes that have already been created.", icon: "list", accent: ACCENT_BLUE, workflow: "attribute-history" },
      { id: "import-attributes", title: "Import Attributes", desc: "Bulk import attributes and picklist values from CSV or Excel.", icon: "upload", accent: ACCENT_BLUE, badge: "Import", workflow: "import-attributes" },
      { id: "attribute-catalog", title: "Attribute Catalog", desc: "Browse and search all available attributes and their configurations.", icon: "layers", accent: ACCENT, workflow: "attribute-catalog" },
      { id: "attribute-analytics", title: "Attribute Analytics", desc: "View attribute usage, data type mix, and product coverage.", icon: "activity", accent: ACCENT_SOFT, workflow: "attribute-analytics" },
    ];

    return {
      id: "attributes",
      label: "Attributes",
      icon: "sliders",
      groupLabel: "Revenue Cloud",
      color: ACCENT,
      stats,
      actions,
    };
  }, [data]);

  const recentActivity: RecentOp[] = useMemo(() => {
    if (!data) return [];
    return data.recentActivity.map(a => ({
      type: a.action,
      item: a.name,
      meta: [a.dataType, a.relatedProductName, a.isActive ? "Active" : "Inactive"].filter(Boolean).join(" · "),
      time: formatRelativeTime(a.lastModifiedDate),
      color: a.action === "Created" ? ACCENT : ACCENT_BLUE,
    }));
  }, [data]);

  const handleLaunch = (workflow: string) => {
    if (workflow === "create-attribute") onNavigate({ mode: "create" });
    else if (workflow === "attribute-history") onNavigate({ mode: "history" });
    else if (workflow === "import-attributes") onNavigate({ mode: "import" });
    else if (workflow === "attribute-catalog") onNavigate({ mode: "catalog" });
    else if (workflow === "attribute-analytics") setShowAnalytics(v => !v);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: t.dim }}>
          <Spinner isDark={isDark} /> Loading Attribute Workspace…
        </div>
      </div>
    );
  }

  if (error || !obj || !data) {
    return (
      <div className="p-5 overflow-y-auto h-full">
        <ErrorPanel isDark={isDark} error={error ?? { title: "Could not load Attribute statistics", message: "Unknown error" }} />
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
      subtitle="Create, manage, deploy, and configure product attributes."
      recentActivity={recentActivity}
      recentActivityLabel="Recent Attribute Activity"
      extraSection={showAnalytics ? (
        <>
          {dataTypeBreakdown.length > 0 && (
            <StatusBreakdownPanel isDark={isDark} title="Attributes by Data Type" breakdown={dataTypeBreakdown} valueFieldAvailable={false} />
          )}
          {attributeList === null ? (
            <div className="flex items-center gap-2 mb-8" style={{ fontSize: 12, color: t.dim }}><Spinner isDark={isDark} /> Loading product coverage…</div>
          ) : mostUsedProducts.length > 0 && (
            <StatusBreakdownPanel isDark={isDark} title="Products With the Most Attributes" breakdown={mostUsedProducts} valueFieldAvailable={false} />
          )}
        </>
      ) : undefined}
    />
  );
}
