"use client";

import { useEffect, useMemo, useState } from "react";
import { ObjectWorkspace, StatusBreakdownPanel, type DashboardObject, type StatDef, type ActionDef, type RecentOp } from "@/components/data/dashboardShell";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { tokens, formatCurrency, Spinner, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import { pickBestEffortStatus, activityColorFor } from "@/lib/dashboard/statusStats";
import type { OrderStatsResponse } from "@/app/api/orders/stats/route";

type ModuleTarget = { mode: "history" | "create" };

const ACCENT = "#00D4FF";
const ACCENT_BLUE = "#3AABFF";
const ACCENT_SOFT = "#60B8FF";

/**
 * Orders tile landing page (DataOmnion sidebar → Orders) — mirrors the
 * Accounts/Quotes dashboards (header, stat cards, action cards, recent
 * activity) via the shared `ObjectWorkspace`, but every number comes from
 * the connected Salesforce org (GET /api/orders/stats) instead of a static
 * config. Action cards navigate into the existing, untouched OrdersModule
 * (history/create/workspace) via `onNavigate` — this component never
 * reimplements Order creation, line items, or fulfillment.
 */
export default function OrdersDashboard({ isDark, onNavigate }: { isDark: boolean; onNavigate: (target: ModuleTarget) => void }) {
  const t = tokens(isDark);
  const [data, setData] = useState<OrderStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);

  const fetchStats = () => {
    quoteApiGet<OrderStatsResponse>("Load order dashboard stats", "/api/orders/stats")
      .then(setData)
      .catch(err => setError(toErrorPanelData(err, "Could not load Order statistics")))
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

    const draft = data.statusBreakdown.find(b => /^draft$/i.test(b.status));
    const activated = pickBestEffortStatus(data.statusBreakdown, /^activ/i, [/^draft$/i], "Activated");

    const stats: StatDef[] = [
      { label: "Total", value: String(data.totalOrders) },
      { label: "Draft", value: String(draft?.count ?? 0) },
      { label: activated.label, value: String(activated.count) },
      { label: "Value", value: data.totalAmountFieldAvailable ? formatCurrency(data.totalValue ?? 0) : "—" },
    ];

    const actions: ActionDef[] = [
      { id: "create-order", title: "Create Order", desc: "Create a new Salesforce Order", icon: "plus", accent: ACCENT, badge: "AI", workflow: "create-order" },
      { id: "order-history", title: "Order History", desc: "Browse all Orders", icon: "list", accent: ACCENT_BLUE, workflow: "order-history" },
      { id: "create-order-items", title: "Create Order Items", desc: "Add products to an existing Order", icon: "layers", accent: ACCENT, workflow: "create-order-items" },
      { id: "order-fulfillment", title: "Order Fulfillment", desc: "Track and activate orders for fulfillment", icon: "package", accent: ACCENT_BLUE, workflow: "order-fulfillment" },
      { id: "order-analytics", title: "Order Analytics", desc: "View Order trends and metrics", icon: "bar-chart", accent: ACCENT_BLUE, workflow: "order-analytics" },
      { id: "ai-order-assistant", title: "AI Order Assistant", desc: "Generate Order using AI", icon: "sparkles", accent: ACCENT_SOFT, badge: "AI", workflow: "ai-order-assistant" },
      { id: "import-orders", title: "Import Orders", desc: "Bulk import Order data", icon: "upload", accent: ACCENT_BLUE, badge: "Soon" },
    ];

    return {
      id: "orders",
      label: "Orders",
      icon: "shopping-cart",
      groupLabel: "Revenue Cloud",
      color: ACCENT,
      stats,
      actions,
    };
  }, [data]);

  const recentActivity: RecentOp[] = useMemo(() => {
    if (!data) return [];
    return data.recentOrders.map(o => {
      const created = new Date(o.createdDate).getTime();
      const modified = new Date(o.lastModifiedDate).getTime();
      const justCreated = Number.isFinite(created) && Number.isFinite(modified) && Math.abs(modified - created) < 5000;
      const type = justCreated ? "Created" : (o.status ?? "Updated");
      return {
        type,
        item: o.orderNumber ?? o.id,
        meta: "Order",
        time: formatRelativeTime(o.lastModifiedDate),
        color: activityColorFor(o.status, justCreated),
      };
    });
  }, [data]);

  const handleLaunch = (workflow: string) => {
    if (workflow === "create-order" || workflow === "ai-order-assistant") {
      onNavigate({ mode: "create" });
    } else if (workflow === "order-history" || workflow === "create-order-items" || workflow === "order-fulfillment") {
      onNavigate({ mode: "history" });
    } else if (workflow === "order-analytics") {
      setShowAnalytics(v => !v);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: t.dim }}>
          <Spinner isDark={isDark} /> Loading Orders dashboard…
        </div>
      </div>
    );
  }

  if (error || !obj || !data) {
    return (
      <div className="p-5 overflow-y-auto h-full">
        <ErrorPanel isDark={isDark} error={error ?? { title: "Could not load Order statistics", message: "Unknown error" }} />
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
      recentActivity={recentActivity}
      recentActivityLabel="Recent Order Activity"
      extraSection={showAnalytics ? (
        <StatusBreakdownPanel isDark={isDark} title="Orders by Status" breakdown={data.statusBreakdown} valueFieldAvailable={data.totalAmountFieldAvailable} />
      ) : undefined}
    />
  );
}
