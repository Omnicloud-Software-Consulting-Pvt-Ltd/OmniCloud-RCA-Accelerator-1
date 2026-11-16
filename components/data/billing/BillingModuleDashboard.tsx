"use client";

import { useMemo } from "react";
import { ObjectWorkspace, type ActionDef, type DashboardObject, type RecentOp, type StatDef } from "@/components/data/dashboardShell";
import { tokens, ErrorPanel } from "@/components/data/quotes/shared";
import BillingRecordsTable from "@/components/data/billing/BillingRecordsTable";
import { Panel, useBillingData } from "@/components/data/billing/billingUi";
import { navTargetForReference, statusColor, type BillingNavTarget } from "@/lib/billing/client";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import { BILLING_MODULES, BILLING_GROUPS, getBillingModule, type AppModuleLink } from "@/lib/billing/registry";
import type { BillingListResponse, BillingModuleStatus } from "@/lib/billing/types";
import { BULK_ASSIGNMENT_KIND_FOR_MODULE } from "@/lib/policyAssignment/navigation";

const ACCENT = "#00D4FF";
const ACCENT_BLUE = "#3AABFF";
const ACCENT_SOFT = "#60B8FF";

const APP_MODULE_LABEL: Record<AppModuleLink, string> = { products: "Products", orders: "Orders", contracts: "Contracts", quotes: "Quotes" };

/**
 * Landing page for one billing module (e.g. Billing Treatments): header with
 * live counts/status breakdown, actions (Create, History, Refresh, Inspect
 * Salesforce Configuration, related modules), and the existing records table
 * — Salesforce is the only data source.
 */
export default function BillingModuleDashboard({ isDark, moduleKey, status, onNavigate, onInspect, onRefreshStats }: {
  isDark: boolean;
  moduleKey: string;
  status: BillingModuleStatus | null;
  onNavigate: (target: BillingNavTarget) => void;
  onInspect: () => void;
  onRefreshStats: () => void;
}) {
  const t = tokens(isDark);
  const def = getBillingModule(moduleKey)!;
  const { data, error, loading, reload } = useBillingData<BillingListResponse>(`Load ${def.label}`, status?.available === false ? null : `/api/billing/${moduleKey}?limit=25`);

  const parents = useMemo(() => BILLING_MODULES.filter(m => m.children?.includes(moduleKey)), [moduleKey]);
  const groupLabel = def.group === "taxes" ? "Taxes" : BILLING_GROUPS.find(g => g.id === def.group)?.label ?? "Revenue Cloud Billing";

  const obj: DashboardObject = useMemo(() => {
    const breakdown = (status?.statusBreakdown ?? []).slice().sort((a, b) => b.count - a.count);
    const stats: StatDef[] = [
      { label: "Records", value: status?.recordCount !== null && status?.recordCount !== undefined ? String(status.recordCount) : "—" },
      ...breakdown.slice(0, 3).map(b => ({ label: b.status, value: String(b.count) })),
      { label: "Last change", value: status?.lastModifiedDate ? formatRelativeTime(status.lastModifiedDate) : "—" },
    ];
    const actions: ActionDef[] = [];
    if (status?.createable) actions.push({ id: "create", title: `Create New ${def.singular}`, desc: "Optional AI prompt fills the Salesforce form; review, validate, then create.", icon: "plus", accent: ACCENT, badge: "AI", workflow: "create" });
    actions.push({ id: "history", title: "View History", desc: `Search, filter and sort every ${def.singular} in Salesforce.`, icon: "list", accent: ACCENT_BLUE, workflow: "history" });
    actions.push({ id: "refresh", title: "Refresh", desc: "Reload records and counts from Salesforce.", icon: "refresh", accent: ACCENT, workflow: "refresh" });
    actions.push({ id: "inspect", title: "Inspect Salesforce Configuration", desc: `Object, fields, required fields, picklists and relationships discovered for ${status?.sobject ?? def.candidates[0]}.`, icon: "database", accent: ACCENT_SOFT, workflow: "inspect" });
    for (const childKey of def.children ?? []) {
      const c = getBillingModule(childKey);
      if (c) actions.push({ id: `child-${childKey}`, title: c.label, desc: c.description, icon: c.icon, accent: ACCENT_BLUE, workflow: `module:${childKey}` });
    }
    for (const p of parents) actions.push({ id: `parent-${p.key}`, title: p.label, desc: p.description, icon: p.icon, accent: ACCENT_BLUE, workflow: `module:${p.key}` });
    if (moduleKey === "billing-policies") actions.push({ id: "assign", title: "Assign Billing Policy to Product", desc: "Link an existing policy to an existing product — the product's current policy is checked first.", icon: "link", accent: ACCENT_SOFT, badge: "AI", workflow: "assign" });
    if (BULK_ASSIGNMENT_KIND_FOR_MODULE[moduleKey] && status?.available !== false) actions.push({ id: "bulk-assign", title: "Bulk Product Assignment", desc: `Open the dedicated page to assign one ${def.singular} to many products — only products without a ${def.singular} are listed, existing assignments are never overwritten, and Treatment Items are configured with it.`, icon: "layers", accent: ACCENT, workflow: "bulk-assign" });
    if (moduleKey === "tax-rates" && status?.available !== false) actions.push({ id: "rate-library", title: "Global Tax Rate Library", desc: "Browse, maintain, and reuse tax rates across countries and jurisdictions.", icon: "globe", accent: ACCENT, workflow: "rate-library" });
    if (def.appModule) actions.push({ id: "app", title: `Open ${APP_MODULE_LABEL[def.appModule]}`, desc: def.appModule === "orders" ? "Activate an Order with billable products to generate billing schedules." : `Continue in the existing ${APP_MODULE_LABEL[def.appModule]} module.`, icon: "external-link", accent: ACCENT_SOFT, workflow: `app:${def.appModule}` });
    return { id: `billing-${moduleKey}`, label: def.label, icon: def.icon, groupLabel: `Revenue Cloud Billing · ${groupLabel}`, color: ACCENT, stats, actions };
  }, [def, status, parents, groupLabel, moduleKey]);

  const recentActivity: RecentOp[] = useMemo(() => (data?.records ?? []).slice(0, 5).map(r => {
    const created = r.createdDate ? new Date(r.createdDate).getTime() : NaN;
    const modified = r.lastModifiedDate ? new Date(r.lastModifiedDate).getTime() : NaN;
    const justCreated = Number.isFinite(created) && Number.isFinite(modified) && Math.abs(modified - created) < 5000;
    return {
      type: justCreated ? "Created" : "Updated",
      item: r.name,
      meta: r.status ?? def.singular,
      time: r.lastModifiedDate ? formatRelativeTime(r.lastModifiedDate) : "",
      color: justCreated ? ACCENT : statusColor(r.status),
    };
  }), [data, def.singular]);

  const handleLaunch = (workflow: string) => {
    if (workflow === "create") onNavigate({ billing: { moduleKey, view: "create" } });
    else if (workflow === "history") onNavigate({ billing: { moduleKey, view: "history" } });
    else if (workflow === "refresh") { reload(); onRefreshStats(); }
    else if (workflow === "inspect") onInspect();
    else if (workflow === "assign") onNavigate({ assign: {} });
    else if (workflow === "bulk-assign") onNavigate({ billing: { moduleKey, view: "bulk-assignment" } });
    else if (workflow === "rate-library") onNavigate({ billing: { moduleKey, view: "rate-library" } });
    else if (workflow.startsWith("module:")) onNavigate({ billing: { moduleKey: workflow.slice(7), view: "module" } });
    else if (workflow.startsWith("app:")) onNavigate({ app: { module: workflow.slice(4) as AppModuleLink } });
  };

  if (status && !status.available) {
    return (
      <div style={{ padding: 20 }}>
        <Panel isDark={isDark} title={`${def.label} aren't available in this org`} icon="info">
          <div style={{ fontSize: 12.5, color: t.body, display: "flex", flexDirection: "column", gap: 8 }}>
            <div>{def.description}</div>
            <div style={{ color: t.dim }}>Looked for: <code>{status.candidatesTried.join(", ")}</code> — none exist in the connected org&apos;s schema, so this module is disabled instead of calling an API that would fail.</div>
          </div>
        </Panel>
      </div>
    );
  }

  const extra = (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
      {status && !status.createable && (
        <div style={{ fontSize: 12, color: t.body, padding: "9px 12px", borderRadius: 10, border: `1px solid ${t.accent}40`, background: `${t.accent}0c` }}>
          {def.readOnlyNote ?? `${def.label} are read-only for your user in this org.`}
        </div>
      )}
      <p className="text-[10px] font-semibold tracking-widest uppercase" style={{ color: isDark ? "rgba(0,212,255,0.5)" : "rgba(0,71,171,0.66)", margin: 0 }}>Existing Records</p>
      {error && <ErrorPanel isDark={isDark} error={error} />}
      <BillingRecordsTable
        isDark={isDark}
        data={data}
        loading={loading}
        singular={def.singular}
        icon={def.icon}
        compact
        maxRows={10}
        onOpen={id => onNavigate({ billing: { moduleKey, view: "detail", id } })}
        onEdit={id => onNavigate({ billing: { moduleKey, view: "edit", id } })}
        onAssign={moduleKey === "billing-policies" ? id => onNavigate({ assign: { policyId: id } }) : undefined}
        onOpenLinked={l => onNavigate({ product: { id: l.id } })}
        onOpenReference={ref => { const target = navTargetForReference(ref); if (target) onNavigate(target); }}
        onRefresh={() => { reload(); onRefreshStats(); }}
      />
    </div>
  );

  return (
    <ObjectWorkspace
      obj={obj}
      isDark={isDark}
      onLaunch={handleLaunch}
      subtitle={def.description}
      extraSection={extra}
      recentActivity={recentActivity}
      recentActivityLabel={`Recent ${def.singular} Activity`}
    />
  );
}
