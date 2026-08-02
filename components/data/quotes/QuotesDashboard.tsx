"use client";

import { useEffect, useMemo, useState } from "react";
import { ObjectWorkspace, StatusBreakdownPanel, type DashboardObject, type StatDef, type ActionDef, type RecentOp } from "@/components/data/dashboardShell";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { tokens, formatCurrency, Spinner, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import { pickBestEffortStatus, activityColorFor } from "@/lib/dashboard/statusStats";
import type { QuoteStatsResponse } from "@/app/api/quotes/stats/route";

type ModuleTarget = { mode: "history" | "create" };

const ACCENT = "#00D4FF";
const ACCENT_BLUE = "#3AABFF";
const ACCENT_SOFT = "#60B8FF";

/**
 * Quotes tile landing page (DataOmnion sidebar → Quotes) — mirrors the
 * Accounts tile's enterprise dashboard (header, stat cards, action cards,
 * recent activity) via the shared `ObjectWorkspace`, but every number comes
 * from the connected Salesforce org (GET /api/quotes/stats) instead of a
 * static config. Action cards navigate into the existing, untouched
 * QuotesModule (history/create/workspace) via `onNavigate` — this component
 * never reimplements Quote creation, line items, or pricing.
 */
export default function QuotesDashboard({ isDark, onNavigate }: { isDark: boolean; onNavigate: (target: ModuleTarget) => void }) {
  const t = tokens(isDark);
  const [data, setData] = useState<QuoteStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);

  const fetchStats = () => {
    quoteApiGet<QuoteStatsResponse>("Load quote dashboard stats", "/api/quotes/stats")
      .then(setData)
      .catch(err => setError(toErrorPanelData(err, "Could not load Quote statistics")))
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
    const approvedLike = pickBestEffortStatus(data.statusBreakdown, /approved|accepted/i, [/^draft$/i], "Won");

    const stats: StatDef[] = [
      { label: "Total", value: String(data.totalQuotes) },
      { label: "Draft", value: String(draft?.count ?? 0) },
      { label: approvedLike.label, value: String(approvedLike.count) },
      { label: "Value", value: data.grandTotalFieldAvailable ? formatCurrency(data.totalValue ?? 0) : "—" },
    ];

    const actions: ActionDef[] = [
      { id: "create-quote", title: "Create Quote", desc: "Create a new Salesforce Quote", icon: "plus", accent: ACCENT, badge: "AI", workflow: "create-quote" },
      { id: "quote-history", title: "Quote History", desc: "Browse all Quotes", icon: "list", accent: ACCENT_BLUE, workflow: "quote-history" },
      { id: "quote-line-items", title: "Add Quote Line Items", desc: "Add products to an existing Quote", icon: "layers", accent: ACCENT, workflow: "quote-line-items" },
      { id: "quote-analytics", title: "Quote Analytics", desc: "View Quote trends and metrics", icon: "bar-chart", accent: ACCENT_BLUE, workflow: "quote-analytics" },
      { id: "ai-quote-assistant", title: "AI Quote Assistant", desc: "Generate Quote using AI", icon: "sparkles", accent: ACCENT_SOFT, badge: "AI", workflow: "ai-quote-assistant" },
      { id: "import-quotes", title: "Import Quotes", desc: "Bulk import Quote data", icon: "upload", accent: ACCENT_BLUE, badge: "Soon" },
    ];

    return {
      id: "quotes",
      label: "Quotes",
      icon: "file-text",
      groupLabel: "Revenue Cloud",
      color: ACCENT,
      stats,
      actions,
    };
  }, [data]);

  const recentActivity: RecentOp[] = useMemo(() => {
    if (!data) return [];
    return data.recentQuotes.map(q => {
      const created = new Date(q.createdDate).getTime();
      const modified = new Date(q.lastModifiedDate).getTime();
      const justCreated = Number.isFinite(created) && Number.isFinite(modified) && Math.abs(modified - created) < 5000;
      const type = justCreated ? "Created" : (q.status ?? "Updated");
      return {
        type,
        item: q.name,
        meta: "Quote",
        time: formatRelativeTime(q.lastModifiedDate),
        color: activityColorFor(q.status, justCreated),
      };
    });
  }, [data]);

  const handleLaunch = (workflow: string) => {
    if (workflow === "create-quote" || workflow === "ai-quote-assistant") {
      onNavigate({ mode: "create" });
    } else if (workflow === "quote-history" || workflow === "quote-line-items") {
      onNavigate({ mode: "history" });
    } else if (workflow === "quote-analytics") {
      setShowAnalytics(v => !v);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: t.dim }}>
          <Spinner isDark={isDark} /> Loading Quotes dashboard…
        </div>
      </div>
    );
  }

  if (error || !obj || !data) {
    return (
      <div className="p-5 overflow-y-auto h-full">
        <ErrorPanel isDark={isDark} error={error ?? { title: "Could not load Quote statistics", message: "Unknown error" }} />
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
      recentActivityLabel="Recent Quote Activity"
      extraSection={showAnalytics ? (
        <StatusBreakdownPanel isDark={isDark} title="Quotes by Status" breakdown={data.statusBreakdown} valueFieldAvailable={data.grandTotalFieldAvailable} />
      ) : undefined}
    />
  );
}
