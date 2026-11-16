"use client";

import { useMemo } from "react";
import { ObjectWorkspace, type ActionDef, type DashboardObject, type RecentOp, type StatDef } from "@/components/data/dashboardShell";
import { tokens, EmptyState, ErrorPanel, GhostButton, Spinner } from "@/components/data/quotes/shared";
import { Panel, useBillingData } from "@/components/data/billing/billingUi";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import type { AssetStats, LifecycleCapabilities } from "@/lib/assetLifecycle/server/reads";
import type { AuditEvent, LifecycleKind, SalesforceRefs, TransactionStatus } from "@/lib/assetLifecycle/types";
import { Badge, Notice, SECTION_META, TableFrame, fmtDate, fmtMoney, td, th } from "./lifecycleUi";
import FieldHelp from "@/components/help/FieldHelp";
import { LIFECYCLE_SECTION_HELP as SH } from "@/lib/help/lifecycleHelp";

export interface TransactionSummary { id: string; name: string; status: TransactionStatus; accountId: string; accountName: string | null; contractNumber: string | null; effectiveDate: string; assets: number; createdAt: string; updatedAt: string; sf: SalesforceRefs; nextStep: string | null }
interface SalesforceTx { source: "Quote" | "Order"; quoteId: string | null; quoteNumber: string | null; quoteStatus: string | null; effectiveDate: string | null; contractId: string | null; createdDate: string | null; total: number | null; accountId: string | null; accountName: string | null; order: { id: string; number: string | null; status: string | null } | null }
export interface LifecycleListResponse { kind: LifecycleKind; capabilities: LifecycleCapabilities; durability: { durable: boolean; warning: string | null }; transactions: TransactionSummary[]; salesforce: SalesforceTx[]; salesforceError: string | null; audit: AuditEvent[] }

const STATUS_COLOR: Record<TransactionStatus, string> = { draft: "#8A9BB5", "in-progress": "#3AABFF", waiting: "#F59E0B", "needs-input": "#B07CFF", failed: "#FF4066", completed: "#00C896" };

/** This app's lifecycle transactions + the lifecycle quotes / orders that exist in Salesforce (history). */
export function TransactionLists({ isDark, kind, data, onOpen }: { isDark: boolean; kind: LifecycleKind; data: LifecycleListResponse; onOpen: (id: string) => void }) {
  const t = tokens(isDark);
  const meta = SECTION_META[kind];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel isDark={isDark} title={`${meta.label} in this app`} icon={meta.icon}>
        {data.transactions.length === 0 ? <EmptyState isDark={isDark} icon={meta.icon} title={`No ${meta.label.toLowerCase()} yet`} hint={`Use ${meta.create} to plan one — nothing is sent to Salesforce until you confirm each step.`} /> : (
          <TableFrame isDark={isDark}>
            <thead><tr>{["Name", "Status", "Customer", "Contract", kind === "renew" ? "Renewal start" : "Effective", "Assets", "Quote", "Order", "Next step", "Updated"].map(h => <th key={h} style={th(t)}>{h}</th>)}</tr></thead>
            <tbody>{data.transactions.map(x => (
              <tr key={x.id} style={{ cursor: "pointer" }} onClick={() => onOpen(x.id)}>
                <td style={{ ...td(t), color: t.heading, fontWeight: 700 }}>{x.name}</td><td style={td(t)}><Badge label={x.status} color={STATUS_COLOR[x.status]} isDark={isDark} /></td>
                <td style={td(t)}>{x.accountName ?? x.accountId}</td><td style={td(t)}>{x.contractNumber ?? "—"}</td><td style={td(t)}>{x.effectiveDate || "Salesforce default"}</td><td style={td(t)}>{x.assets}</td>
                <td style={td(t)}>{x.sf.quoteNumber ?? x.sf.quoteId ?? "—"}</td><td style={td(t)}>{x.sf.orderNumber ?? "—"}</td><td style={td(t)}>{x.nextStep ?? "Done"}</td><td style={td(t)}>{formatRelativeTime(x.updatedAt)}</td>
              </tr>
            ))}</tbody>
          </TableFrame>
        )}
      </Panel>
      <Panel isDark={isDark} title={`${meta.label} in Salesforce (OriginalActionType ${kind === "amend" ? "Amend" : kind === "renew" ? "Renew" : "Cancel"})`} icon="database">
        {data.salesforceError && <Notice isDark={isDark} tone="error">{data.salesforceError}</Notice>}
        {data.salesforce.length === 0 ? <div style={{ fontSize: 12, color: t.dim }}>No {meta.singular.toLowerCase()} quotes or orders exist in this org yet.</div> : (
          <TableFrame isDark={isDark}>
            <thead><tr>{["Record", "Status", "Customer", "Effective", "Total", "Order", "Created"].map(h => <th key={h} style={th(t)}>{h}</th>)}</tr></thead>
            <tbody>{data.salesforce.map((x, i) => (
              <tr key={`${x.quoteId ?? x.order?.id}-${i}`}>
                <td style={td(t)}>{x.source} {x.source === "Quote" ? x.quoteNumber : x.order?.number}</td><td style={td(t)}>{x.source === "Quote" ? x.quoteStatus ?? "—" : x.order?.status ?? "—"}</td>
                <td style={td(t)}>{x.accountName ?? "—"}</td><td style={td(t)}>{fmtDate(x.effectiveDate)}</td><td style={td(t)}>{fmtMoney(x.total)}</td>
                <td style={td(t)}>{x.order ? `${x.order.number ?? x.order.id} · ${x.order.status ?? ""}` : "—"}</td><td style={td(t)}>{fmtDate(x.createdDate)}</td>
              </tr>
            ))}</tbody>
          </TableFrame>
        )}
      </Panel>
    </div>
  );
}

/** Lifecycle dashboard (Amendments / Renewals / Cancellations) — the shared ObjectWorkspace with live counts from the org + app. */
export function LifecycleDashboard({ isDark, kind, onLaunch, onOpen }: { isDark: boolean; kind: LifecycleKind; onLaunch: (workflow: string) => void; onOpen: (id: string) => void }) {
  const t = tokens(isDark);
  const meta = SECTION_META[kind];
  const { data, error, loading, reload } = useBillingData<LifecycleListResponse>(`Load ${meta.label.toLowerCase()}`, `/api/asset-lifecycle?kind=${kind}`);
  const stats = useBillingData<{ stats: AssetStats }>("Load asset stats", "/api/assets/lookup?type=stats").data?.stats ?? null;

  const obj: DashboardObject | null = useMemo(() => {
    if (!data) return null;
    const count = (s: TransactionStatus[]) => String(data.transactions.filter(x => s.includes(x.status)).length);
    const sv: StatDef[] = [
      { label: "In progress", value: count(["draft", "in-progress", "waiting", "needs-input"]) },
      { label: "Completed", value: count(["completed"]) },
      { label: "Failed", value: count(["failed"]) },
      { label: "In Salesforce", value: String(data.salesforce.length) },
      { label: kind === "renew" ? "Expiring 90d" : "Active assets", value: kind === "renew" ? String(stats?.expiring ?? "—") : String(stats?.active ?? "—") },
    ];
    const actions: ActionDef[] = [
      { id: "create", title: meta.create, desc: `Plan a quote-first ${meta.singular.toLowerCase()} with Salesforce's ${kind === "amend" ? "initiateAmendment" : kind === "renew" ? "initiateRenewal" : "initiateCancellation"}`, icon: "plus", accent: meta.color, workflow: "create" },
      { id: "history", title: `${meta.singular} History`, desc: "This app's transactions and Salesforce's lifecycle quotes / orders", icon: "list", accent: "#3AABFF", workflow: "history" },
      { id: "assets", title: kind === "renew" ? "Expiring & Expired Assets" : "Eligible Assets", desc: "Find assets and see why any are blocked", icon: "archive", accent: "#00D4FF", workflow: kind === "renew" ? "assets-expiring" : "assets" },
    ];
    return { id: `lifecycle-${kind}`, label: meta.label, icon: meta.icon, groupLabel: "Asset Lifecycle", color: meta.color, stats: sv, actions };
  }, [data, stats, kind, meta]);

  const recent: RecentOp[] = (data?.audit ?? []).slice(0, 8).map(a => ({ type: a.action, item: a.summary.slice(0, 80), meta: meta.singular, time: formatRelativeTime(a.at), color: a.status === "failed" ? "#FF4066" : a.status === "success" ? "#00C896" : "#3AABFF" }));

  if (loading && !data) return <div className="flex-1 flex items-center justify-center h-full"><div className="flex items-center gap-2 text-[12.5px]" style={{ color: t.dim }}><Spinner isDark={isDark} /> Loading {meta.label} dashboard…</div></div>;
  if (error || !obj || !data) return <div className="p-5 overflow-y-auto h-full"><ErrorPanel isDark={isDark} error={error ?? { title: `Could not load ${meta.label}`, message: "Unknown error" }} /><div className="mt-3"><GhostButton label="Retry" icon="refresh" isDark={isDark} onClick={reload} /></div></div>;
  return (
    <ObjectWorkspace obj={obj} isDark={isDark} onLaunch={onLaunch} recentActivity={recent} recentActivityLabel={`Recent ${meta.singular} Activity`}
      subtitle={`Quote-first ${meta.label.toLowerCase()} on Revenue Cloud assets — every write confirmed, every result read back from Salesforce.`}
      extraSection={
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {data.capabilities.missing[kind].length > 0 && <Notice isDark={isDark} tone="error"><b>Not available in this org:</b> {data.capabilities.missing[kind].join(" ")}</Notice>}
          {data.durability.warning && <Notice isDark={isDark} tone="warn">{data.durability.warning}</Notice>}
          <TransactionLists isDark={isDark} kind={kind} data={data} onOpen={onOpen} />
        </div>
      } />
  );
}

/** Assets dashboard — live counts from the org and the entry points into the three lifecycles. */
export function AssetsDashboard({ isDark, onLaunch }: { isDark: boolean; onLaunch: (workflow: string) => void }) {
  const { data, error, loading, reload } = useBillingData<{ stats: AssetStats }>("Load asset stats", "/api/assets/lookup?type=stats");
  const caps = useBillingData<{ capabilities: LifecycleCapabilities }>("Load org capabilities", "/api/assets/lookup?type=capabilities").data?.capabilities ?? null;
  const t = tokens(isDark);
  const s = data?.stats;
  const v = (n: number | null | undefined) => (n === null || n === undefined ? "—" : String(n));
  const obj: DashboardObject = {
    id: "lifecycle-assets", label: "Assets", icon: "archive", groupLabel: "Asset Lifecycle", color: SECTION_META.assets.color,
    stats: [{ label: "Lifecycle", value: v(s?.lifecycle) }, { label: "Active", value: v(s?.active) }, { label: "Expiring 90d", value: v(s?.expiring) }, { label: "Expired", value: v(s?.expired) }, { label: "Cancelled", value: v(s?.cancelled) }],
    actions: [
      { id: "browse", title: "Browse Assets", desc: "Search, filter and open any asset", icon: "search", accent: "#00D4FF", workflow: "assets" },
      { id: "expiring", title: "Expiring Assets", desc: "Assets ending in the next 90 days", icon: "clock", accent: "#F59E0B", workflow: "assets-expiring" },
      { id: "amend", title: "Amend Assets", desc: "Quantity, price, upgrade / downgrade, add-ons", icon: "edit", accent: SECTION_META.amend.color, workflow: "amend" },
      { id: "renew", title: "Renew Assets", desc: "Renewal quotes with negotiated pricing", icon: "refresh", accent: SECTION_META.renew.color, workflow: "renew" },
      { id: "cancel", title: "Cancel Assets", desc: "Immediate or future-effective cancellation", icon: "x", accent: SECTION_META.cancel.color, workflow: "cancel" },
    ],
  };
  if (error) return <div className="p-5 overflow-y-auto h-full"><ErrorPanel isDark={isDark} error={error} /><div className="mt-3"><GhostButton label="Retry" icon="refresh" isDark={isDark} onClick={reload} /></div></div>;
  return (
    <ObjectWorkspace obj={obj} isDark={isDark} onLaunch={onLaunch} recentActivity={[]} recentActivityLabel="Recent Asset Activity"
      subtitle={loading ? "Reading asset counts from Salesforce…" : "Revenue Cloud assets (Asset, Asset Actions, Asset State Periods) read live from the connected org."}
      extraSection={caps ? (
        <Panel isDark={isDark} title="Org readiness" icon="shield" right={<FieldHelp isDark={isDark} label="Org readiness" entry={SH.orgReadiness} />}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8, fontSize: 12.5, color: t.body }}>
            {(["amend", "renew", "cancel"] as LifecycleKind[]).map(k => <div key={k}><Badge label={caps.missing[k].length ? "Not available" : "Ready"} color={caps.missing[k].length ? "#FF4066" : "#00C896"} isDark={isDark} /> {SECTION_META[k].label} ({k === "amend" ? "initiateAmendment" : k === "renew" ? "initiateRenewal" : "initiateCancellation"})</div>)}
            <div><Badge label={caps.actions.createOrderFromQuote.available ? "Ready" : "Not available"} color={caps.actions.createOrderFromQuote.available ? "#00C896" : "#FF4066"} isDark={isDark} /> createOrderFromQuote</div>
            <div>API version <b>{caps.apiVersion}</b></div>
            <div>Ramped renewals: <b>{caps.features.rampedRenewal ? "supported" : "not available"}</b></div>
            <div>Start-date adjustment: <b>{caps.features.startDateAdjustment ? "supported" : "not available"}</b></div>
            <div>Cancellation reason fields: <b>{caps.reasonFields.length || "none (app audit only)"}</b></div>
            {caps.permissions.map(p => <div key={p.object}><Badge label={p.ok ? "OK" : "Missing"} color={p.ok ? "#00C896" : "#FF4066"} isDark={isDark} /> {p.object} ({p.access})</div>)}
          </div>
        </Panel>
      ) : undefined} />
  );
}
