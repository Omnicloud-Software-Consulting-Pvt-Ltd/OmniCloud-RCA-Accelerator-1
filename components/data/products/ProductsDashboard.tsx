"use client";

import { useEffect, useMemo, useState } from "react";
import { ObjectWorkspace, StatusBreakdownPanel, type DashboardObject, type StatDef, type ActionDef, type RecentOp } from "@/components/data/dashboardShell";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { tokens, Spinner, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import { activityColorFor } from "@/lib/dashboard/statusStats";
import type { ProductStatsResponse } from "@/app/api/sf/products/stats/route";

export type ProductModuleTarget = { mode: "history" | "create" | "create-multi" | "choose-type" | "import" | "catalog" | "attributes" };

const ACCENT = "#00D4FF";
const ACCENT_BLUE = "#3AABFF";
const ACCENT_SOFT = "#60B8FF";

/**
 * Products tile landing page (DataOmnion sidebar → Products) — mirrors
 * QuotesDashboard/OrdersDashboard/ContractsDashboard: header, stat cards,
 * action cards, and recent activity via the shared `ObjectWorkspace`, backed
 * by real Salesforce data (GET /api/sf/products/stats) instead of a static
 * config. Action cards navigate into the existing, untouched
 * RCProductWorkspace (create) / ProductHistoryList / RCAAttributeStudio /
 * Catalogs tile via `onNavigate` — this component never reimplements product
 * creation, field generation, or Salesforce payload/record creation.
 */
export default function ProductsDashboard({ isDark, onNavigate }: { isDark: boolean; onNavigate: (target: ProductModuleTarget) => void }) {
  const t = tokens(isDark);
  const [data, setData] = useState<ProductStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);

  const fetchStats = () => {
    quoteApiGet<ProductStatsResponse>("Load product dashboard stats", "/api/sf/products/stats")
      .then(setData)
      .catch(err => setError(toErrorPanelData(err, "Could not load Product statistics")))
      .finally(() => setLoading(false));
  };

  const retry = () => {
    setLoading(true);
    setError(null);
    fetchStats();
  };

  useEffect(() => { fetchStats(); }, []);

  const obj: DashboardObject | null = useMemo(() => {
    if (!data) return null;

    const stats: StatDef[] = [
      { label: "Total Products", value: String(data.totalProducts) },
      { label: "Active Products", value: String(data.activeProducts) },
      { label: "Draft Products", value: String(data.draftProducts) },
      { label: "Bundles", value: String(data.bundleProducts) },
      { label: "Recently Created", value: String(data.recentlyCreated) },
    ];

    const actions: ActionDef[] = [
      { id: "create-product", title: "Create Product", desc: "Create a new Salesforce Revenue Cloud product using natural language.", icon: "plus", accent: ACCENT, badge: "AI", workflow: "create-product" },
      { id: "product-history", title: "Product History", desc: "Browse products previously created in Salesforce.", icon: "list", accent: ACCENT_BLUE, workflow: "product-history" },
      { id: "import-products", title: "Import Products", desc: "Bulk import products from CSV or Excel and create them in Salesforce.", icon: "upload", accent: ACCENT_BLUE, badge: "Import", workflow: "import-products" },
      { id: "product-catalog", title: "Product Catalog", desc: "Browse and manage products available in the Revenue Cloud catalog.", icon: "layers", accent: ACCENT, workflow: "product-catalog" },
      { id: "product-attributes", title: "Product Attributes", desc: "View and manage attributes associated with products.", icon: "sliders", accent: ACCENT_SOFT, workflow: "product-attributes" },
      { id: "product-analytics", title: "Product Analytics", desc: "View product activity, status, and catalog metrics.", icon: "bar-chart", accent: ACCENT_BLUE, workflow: "product-analytics" },
    ];

    return {
      id: "products",
      label: "Products",
      icon: "package",
      groupLabel: "Revenue Cloud",
      color: ACCENT,
      stats,
      actions,
    };
  }, [data]);

  const recentActivity: RecentOp[] = useMemo(() => {
    if (!data) return [];
    return data.recentProducts.map(p => {
      const created = new Date(p.createdDate).getTime();
      const modified = new Date(p.lastModifiedDate).getTime();
      const justCreated = Number.isFinite(created) && Number.isFinite(modified) && Math.abs(modified - created) < 5000;
      const statusLabel = p.isActive ? "Active" : "Draft";
      const type = justCreated ? "Created" : statusLabel;
      return {
        type,
        item: p.name,
        meta: [p.productCode, p.type ?? "Standard"].filter(Boolean).join(" · "),
        time: formatRelativeTime(p.lastModifiedDate),
        color: activityColorFor(justCreated ? null : statusLabel, justCreated),
      };
    });
  }, [data]);

  const handleLaunch = (workflow: string) => {
    if (workflow === "create-product") onNavigate({ mode: "choose-type" });
    else if (workflow === "product-history") onNavigate({ mode: "history" });
    else if (workflow === "import-products") onNavigate({ mode: "import" });
    else if (workflow === "product-catalog") onNavigate({ mode: "catalog" });
    else if (workflow === "product-attributes") onNavigate({ mode: "attributes" });
    else if (workflow === "product-analytics") setShowAnalytics(v => !v);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: t.dim }}>
          <Spinner isDark={isDark} /> Loading Products dashboard…
        </div>
      </div>
    );
  }

  if (error || !obj || !data) {
    return (
      <div className="p-5 overflow-y-auto h-full">
        <ErrorPanel isDark={isDark} error={error ?? { title: "Could not load Product statistics", message: "Unknown error" }} />
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
      subtitle="Create, manage, import, and analyze Revenue Cloud products."
      recentActivity={recentActivity}
      recentActivityLabel="Recent Product Activity"
      extraSection={showAnalytics ? (
        <>
          <StatusBreakdownPanel
            isDark={isDark}
            title="Products by Status"
            breakdown={data.statusBreakdown.map(b => ({ status: b.status, count: b.count, totalValue: null }))}
            valueFieldAvailable={false}
          />
          <StatusBreakdownPanel
            isDark={isDark}
            title="Products by Type"
            breakdown={data.typeBreakdown.map(b => ({ status: b.status, count: b.count, totalValue: null }))}
            valueFieldAvailable={false}
          />
        </>
      ) : undefined}
    />
  );
}
