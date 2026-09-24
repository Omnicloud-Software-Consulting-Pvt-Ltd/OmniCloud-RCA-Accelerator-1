"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ObjectWorkspace, type DashboardObject, type StatDef, type ActionDef, type RecentOp } from "@/components/data/dashboardShell";
import { Spinner, ErrorPanel, GhostButton, tokens, type ErrorPanelData } from "@/components/data/pricing-rules/shared";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import { pickBestEffortStatus, activityColorFor, type StatusCount } from "@/lib/dashboard/statusStats";
import { PRICING_TYPE_LABELS, type PricingType } from "@/lib/pricing-rules/types";
import type { PricingRuleStatsResponse } from "@/app/api/pricing-rules/stats/route";

type ModuleTarget = { mode: "history" | "create" };

const PRICING_TYPE_ICONS: Record<PricingType, string> = {
  "tier-based": "layers",
  "volume-based": "package",
  "attribute-based": "sliders",
  "bundle-based": "cube",
};
const PRICING_TYPE_DESCRIPTIONS: Record<PricingType, string> = {
  "tier-based": "Slab quantity bands — each unit priced at its own tier's rate.",
  "volume-based": "Quantity discount bands — every unit gets the rate of the band the total falls in.",
  "attribute-based": "Price adjustments driven by product attribute values.",
  "bundle-based": "Component-level pricing for bundle configurations.",
};

/**
 * "Pricing Rules" tile landing page — rebuilt on the same `ObjectWorkspace`
 * shell every other tile (Accounts/Quotes/Orders/Contracts/...) uses, with
 * real stats + recent activity pulled from the connected org (GET
 * /api/pricing-rules/stats) instead of a bare 4-card grid. Each pricing-type
 * action jumps straight to its own dedicated route
 * (/pricing-rules/create/<type>) exactly like the previous version did —
 * this component still never reimplements procedure creation itself.
 */
export default function PricingRulesDashboard({ isDark, onNavigate }: { isDark: boolean; onNavigate: (target: ModuleTarget) => void }) {
  const router = useRouter();
  const [data, setData] = useState<PricingRuleStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelData | null>(null);

  // ObjectWorkspace/ActionCard render these accent hexes verbatim (no isDark
  // branching of their own), so the light-mode value has to be picked here.
  const accent = isDark ? "#00D4FF" : "#0098CC";
  const accentBlue = isDark ? "#3AABFF" : "#1789B0";

  const fetchStats = () => {
    fetch("/api/pricing-rules/stats")
      .then(async res => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error ?? `Request failed (HTTP ${res.status})`);
        return json as PricingRuleStatsResponse;
      })
      .then(setData)
      .catch(err => setError({ title: "Could not load Pricing Rules statistics", message: err instanceof Error ? err.message : "Unknown error" }))
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

    const statusCounts: StatusCount[] = data.statusBreakdown.map(s => ({ status: s.status, count: s.count, totalValue: null }));
    const activeLike = data.statusFieldAvailable ? pickBestEffortStatus(statusCounts, /active/i, [/draft/i]) : null;
    const draftEntry = data.statusFieldAvailable ? data.statusBreakdown.find(s => /draft/i.test(s.status)) : null;

    const stats: StatDef[] = [
      { label: "Total Procedures", value: String(data.totalProcedures) },
      ...(activeLike ? [{ label: activeLike.label, value: String(activeLike.count) }] : []),
      ...(draftEntry ? [{ label: draftEntry.status, value: String(draftEntry.count) }] : []),
      { label: "New (7d)", value: data.createdLast7d !== null ? String(data.createdLast7d) : "—" },
    ];

    const typeActions: ActionDef[] = (Object.keys(PRICING_TYPE_LABELS) as PricingType[]).map(pt => ({
      id: `create-${pt}`,
      title: `${PRICING_TYPE_LABELS[pt]} Rule`,
      desc: PRICING_TYPE_DESCRIPTIONS[pt],
      icon: PRICING_TYPE_ICONS[pt],
      accent,
      badge: "AI-Guided",
      workflow: `create-type:${pt}`,
    }));

    const actions: ActionDef[] = [
      { id: "create-rule", title: "Create Pricing Rule", desc: "Choose a pricing type and build a new procedure.", icon: "plus", accent, badge: "AI", workflow: "create" },
      ...typeActions,
      { id: "rule-history", title: "Rule History", desc: "Browse deployed Pricing Procedures.", icon: "list", accent: accentBlue, workflow: "history" },
    ];

    return { id: "pricing-rules", label: "Pricing Rules", icon: "zap", groupLabel: "Revenue Cloud", color: accent, stats, actions };
  }, [data, accent, accentBlue]);

  const recentActivity: RecentOp[] = useMemo(() => {
    if (!data) return [];
    return data.recentProcedures.map(r => {
      const created = r.createdDate ? new Date(r.createdDate).getTime() : NaN;
      const modified = r.lastModifiedDate ? new Date(r.lastModifiedDate).getTime() : NaN;
      const justCreated = Number.isFinite(created) && Number.isFinite(modified) && Math.abs(modified - created) < 5000;
      const type = justCreated ? "Created" : (r.status ?? "Updated");
      const timeSource = r.lastModifiedDate ?? r.createdDate;
      return {
        type,
        item: r.name,
        meta: r.versionNumber !== null ? `v${r.versionNumber}` : "Procedure",
        time: timeSource ? formatRelativeTime(timeSource) : "",
        color: activityColorFor(r.status, justCreated),
      };
    });
  }, [data]);

  const handleLaunch = (workflow: string) => {
    if (workflow === "create") { onNavigate({ mode: "create" }); return; }
    if (workflow === "history") { onNavigate({ mode: "history" }); return; }
    if (workflow.startsWith("create-type:")) {
      const pt = workflow.slice("create-type:".length) as PricingType;
      router.push(`/pricing-rules/create/${pt}`);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: tokens(isDark).dim }}>
          <Spinner isDark={isDark} /> Loading Pricing Rules dashboard…
        </div>
      </div>
    );
  }

  if (error || !obj || !data) {
    return (
      <div className="p-5 overflow-y-auto h-full">
        <ErrorPanel isDark={isDark} error={error ?? { title: "Could not load Pricing Rules statistics", message: "Unknown error" }} />
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
      recentActivityLabel="Recent Pricing Procedures"
      subtitle="Attribute-based, tier-based, volume-based, and bundle-based Pricing Procedures — every type here deploys a real Salesforce Expression Set."
    />
  );
}
