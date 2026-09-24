"use client";

import { useEffect, useMemo, useState } from "react";
import { ObjectWorkspace, StatusBreakdownPanel, type DashboardObject, type StatDef, type ActionDef, type RecentOp } from "@/components/data/dashboardShell";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { tokens, formatCurrency, Spinner, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import { pickBestEffortStatus, activityColorFor } from "@/lib/dashboard/statusStats";
import type { ContractStatsResponse } from "@/app/api/contracts/stats/route";

type ModuleTarget = { mode: "history" | "create" | "import" };

const ACCENT = "#00D4FF";
const ACCENT_BLUE = "#3AABFF";
const ACCENT_SOFT = "#60B8FF";

/**
 * Contracts tile landing page (DataOmnion sidebar → Contracts) — mirrors the
 * Accounts/Quotes/Orders dashboards (header, stat cards, action cards,
 * recent activity) via the shared `ObjectWorkspace`, but every number comes
 * from the connected Salesforce org (GET /api/contracts/stats) instead of a
 * static config. Action cards navigate into the existing, untouched
 * ContractsModule (history/create/workspace/DocuSign) via `onNavigate` —
 * this component never reimplements Contract creation, document generation,
 * or e-signature.
 */
export default function ContractsDashboard({ isDark, onNavigate }: { isDark: boolean; onNavigate: (target: ModuleTarget) => void }) {
  const t = tokens(isDark);
  const [data, setData] = useState<ContractStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);

  const fetchStats = () => {
    quoteApiGet<ContractStatsResponse>("Load contract dashboard stats", "/api/contracts/stats")
      .then(setData)
      .catch(err => setError(toErrorPanelData(err, "Could not load Contract statistics")))
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

    const active = pickBestEffortStatus(data.statusBreakdown, /^activ/i, [/^draft$/i], "Active");

    const stats: StatDef[] = [
      { label: "Total", value: String(data.totalContracts) },
      { label: active.label, value: String(active.count) },
      { label: "Expiring 30d", value: String(data.expiringSoonContracts) },
      { label: "Value", value: data.valueFieldAvailable ? formatCurrency(data.totalValue ?? 0) : "—" },
    ];

    const actions: ActionDef[] = [
      { id: "create-contract", title: "Create Contract", desc: "Create a new Salesforce Contract", icon: "plus", accent: ACCENT, badge: "AI", workflow: "create-contract" },
      { id: "contract-history", title: "Contract History", desc: "Browse existing Contracts", icon: "list", accent: ACCENT_BLUE, workflow: "contract-history" },
      { id: "renew-contracts", title: "Renew Contracts", desc: "Manage renewals", icon: "refresh", accent: ACCENT, workflow: "renew-contracts" },
      { id: "generate-contract-document", title: "Generate Contract Document", desc: "Generate agreement documents", icon: "file-text", accent: ACCENT_BLUE, workflow: "generate-contract-document" },
      { id: "ai-contract-assistant", title: "AI Contract Assistant", desc: "Generate Contract using AI", icon: "sparkles", accent: ACCENT_SOFT, badge: "AI", workflow: "ai-contract-assistant" },
      { id: "contract-analytics", title: "Contract Analytics", desc: "View contract insights", icon: "bar-chart", accent: ACCENT_BLUE, workflow: "contract-analytics" },
      { id: "import-contracts", title: "Import Contracts", desc: "Import contracts from CSV or Excel and create them in Salesforce.", icon: "upload", accent: ACCENT_BLUE, badge: "Import", workflow: "import-contracts" },
    ];

    return {
      id: "contracts",
      label: "Contracts",
      icon: "file-contract",
      groupLabel: "Revenue Cloud",
      color: ACCENT,
      stats,
      actions,
    };
  }, [data]);

  const recentActivity: RecentOp[] = useMemo(() => {
    if (!data) return [];
    return data.recentContracts.map(c => {
      const created = new Date(c.createdDate).getTime();
      const modified = new Date(c.lastModifiedDate).getTime();
      const justCreated = Number.isFinite(created) && Number.isFinite(modified) && Math.abs(modified - created) < 5000;
      const type = justCreated ? "Created" : (c.status ?? "Updated");
      return {
        type,
        item: c.contractNumber ?? c.id,
        meta: "Contract",
        time: formatRelativeTime(c.lastModifiedDate),
        color: activityColorFor(c.status, justCreated),
      };
    });
  }, [data]);

  const handleLaunch = (workflow: string) => {
    if (workflow === "create-contract" || workflow === "ai-contract-assistant") {
      onNavigate({ mode: "create" });
    } else if (workflow === "contract-history" || workflow === "renew-contracts" || workflow === "generate-contract-document") {
      onNavigate({ mode: "history" });
    } else if (workflow === "contract-analytics") {
      setShowAnalytics(v => !v);
    } else if (workflow === "import-contracts") {
      onNavigate({ mode: "import" });
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: t.dim }}>
          <Spinner isDark={isDark} /> Loading Contracts dashboard…
        </div>
      </div>
    );
  }

  if (error || !obj || !data) {
    return (
      <div className="p-5 overflow-y-auto h-full">
        <ErrorPanel isDark={isDark} error={error ?? { title: "Could not load Contract statistics", message: "Unknown error" }} />
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
      recentActivityLabel="Recent Contract Activity"
      extraSection={showAnalytics ? (
        <StatusBreakdownPanel isDark={isDark} title="Contracts by Status" breakdown={data.statusBreakdown} valueFieldAvailable={data.valueFieldAvailable} />
      ) : undefined}
    />
  );
}
