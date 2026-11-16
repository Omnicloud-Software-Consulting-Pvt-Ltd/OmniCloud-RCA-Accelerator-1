"use client";

import { useState } from "react";
import { tokens, Tabs, EmptyState, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { LoadingRow, Panel, ToolbarButton, useBillingData } from "@/components/data/billing/billingUi";
import type { AssetDetail as Detail } from "@/lib/assetLifecycle/server/reads";
import { LIFECYCLE_KINDS, type AssetRow, type LifecycleKind } from "@/lib/assetLifecycle/types";
import { Badge, EligibilityBadge, KeyValues, ReasonList, SECTION_META, StateBadge, TableFrame, fmtDate, fmtMoney, fmtNum, td, th, typeLabel } from "./lifecycleUi";

/** Asset record detail (Salesforce read-only): lifecycle facts, eligibility, Asset Actions, State Periods, transactions, billing. */
export default function AssetDetail({ isDark, assetId, onBack, onStart, onOpenAsset }: {
  isDark: boolean; assetId: string; onBack: () => void;
  onStart: (kind: LifecycleKind, asset: AssetRow) => void;
  onOpenAsset: (id: string) => void;
}) {
  const t = tokens(isDark);
  const { data, error, loading, reload } = useBillingData<Detail>("Load asset", `/api/assets/${assetId}`);
  const [tab, setTab] = useState("overview");
  const a = data?.asset ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} data-testid="asset-detail">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <GhostButton label="Back to assets" icon="arrow-left" isDark={isDark} onClick={onBack} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <ToolbarButton isDark={isDark} label="Refresh" icon="refresh" onClick={reload} />
          {a && LIFECYCLE_KINDS.map(k => {
            const blocked = a.eligibility[k].some(r => r.severity === "error");
            return <ToolbarButton key={k} isDark={isDark} primary={!blocked} disabled={blocked} label={`${SECTION_META[k].verb} asset`} icon={SECTION_META[k].icon} title={blocked ? a.eligibility[k].filter(r => r.severity === "error").map(r => r.message).join("\n") : undefined} onClick={() => onStart(k, a)} />;
          })}
        </div>
      </div>
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {loading && !data && <LoadingRow isDark={isDark} label="Reading the asset from Salesforce…" />}
      {a && data && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: t.heading }}>{a.name}</div>
            <StateBadge state={a.state} isDark={isDark} />
            {a.usage.usageBased && <Badge label="Usage-based" color="#B47CFF" isDark={isDark} title={a.usage.reason ?? undefined} />}
            {a.childIds.length > 0 && <Badge label={`Bundle · ${a.childIds.length} component(s)`} color="#3AABFF" isDark={isDark} />}
            <span style={{ fontSize: 11, color: t.dim }}>{a.id}</span>
          </div>
          <Tabs isDark={isDark} active={tab} onChange={setTab} tabs={[
            { id: "overview", label: "Overview", icon: "info" },
            { id: "actions", label: "Asset Actions", icon: "activity", badge: data.actions.length },
            { id: "periods", label: "State Periods", icon: "calendar", badge: data.statePeriods.length },
            { id: "transactions", label: "Transactions", icon: "list", badge: data.transactions.length },
            { id: "billing", label: "Billing", icon: "dollar-sign", badge: data.billing.length },
            { id: "attributes", label: "Attributes", icon: "sliders", badge: data.attributes.length },
            { id: "relationships", label: "Related assets", icon: "link", badge: data.relationships.length },
          ]} />
          {tab === "relationships" && (data.relationships.length ? (
            <TableFrame isDark={isDark}>
              <thead><tr>{["Asset", "Relationship", "Related asset", "From", "To"].map(h => <th key={h} style={th(t)}>{h}</th>)}</tr></thead>
              <tbody>{data.relationships.map(r => (
                <tr key={r.id}>
                  <td style={td(t)}><button onClick={() => r.assetId && onOpenAsset(r.assetId)} style={{ background: "none", border: "none", padding: 0, color: t.accent, cursor: "pointer", fontSize: 12.5 }}>{r.assetName ?? r.assetId}</button></td>
                  <td style={td(t)}>{r.type ?? "—"}</td>
                  <td style={td(t)}><button onClick={() => r.relatedAssetId && onOpenAsset(r.relatedAssetId)} style={{ background: "none", border: "none", padding: 0, color: t.accent, cursor: "pointer", fontSize: 12.5 }}>{r.relatedAssetName ?? r.relatedAssetId}</button></td>
                  <td style={td(t)}>{fmtDate(r.fromDate)}</td><td style={td(t)}>{fmtDate(r.toDate)}</td>
                </tr>
              ))}</tbody>
            </TableFrame>
          ) : <EmptyState isDark={isDark} icon="link" title="No upgrade / replacement relationships" hint="Asset Relationship records (Upgrade, Replacement, Crossgrade) appear here after an upgrade, downgrade or swap is activated." />)}
          {tab === "overview" && (
            <>
              <Panel isDark={isDark} title="Asset" icon="archive">
                <KeyValues isDark={isDark} rows={[
                  ["Product", `${a.productName ?? "—"}${a.productCode ? ` (${a.productCode})` : ""}`], ["Account", a.accountName ?? a.accountId ?? "—"],
                  ["Current quantity", fmtNum(a.quantity)], ["Selling model", `${typeLabel(a.sellingModel?.type)}${a.sellingModel?.name ? ` · ${a.sellingModel.name}` : ""}`],
                  ["Unit price", fmtMoney(a.unitPrice)], ["Discount", a.discount != null ? `${a.discount}%` : "—"], ["Billing frequency", a.billingFrequency ?? "—"],
                  ["MRR", fmtMoney(a.mrr)], ["Current amount", fmtMoney(a.currentAmount)], ["Total lifecycle amount", fmtMoney(a.totalAmount)],
                  ["Lifecycle start", fmtDate(a.lifecycleStart)], ["Lifecycle end", fmtDate(a.lifecycleEnd)], ["Current period", `${fmtDate(a.startDate)} → ${fmtDate(a.endDate)}`],
                  ["Status", a.status ?? "—"], ["Origin order", a.originOrder?.number ?? "—"], ["Price book", a.pricebookId ?? "—"],
                  ["Renewal term", a.renewal.term ? `${a.renewal.term} ${a.renewal.termUnit ?? ""}` : "—"], ["Auto-renews", a.renewal.autoRenew === null ? "—" : a.renewal.autoRenew ? "Yes" : "No"],
                  ["Renewal pricing", a.renewal.pricingSource ?? "—"], ["Renewal uplift", a.renewal.uplift != null ? `${a.renewal.uplift}%` : "—"],
                  ["Last action", a.lastAction ? `${a.lastAction.type ?? ""} / ${a.lastAction.category ?? ""} (${fmtDate(a.lastAction.date)})` : "—"],
                  ["Parent (bundle)", a.parentId ? <button key="p" onClick={() => onOpenAsset(a.parentId!)} style={{ background: "none", border: "none", color: t.accent, cursor: "pointer", padding: 0 }}>{a.parentId}</button> : "—"],
                ]} />
              </Panel>
              <Panel isDark={isDark} title="Contracts" icon="file-contract">
                {a.contracts.length ? a.contracts.map(c => <div key={c.id} style={{ fontSize: 12.5, color: t.body }}>{c.number ?? c.id} · {c.status ?? "—"} · {fmtDate(c.startDate)} → {fmtDate(c.endDate)} <span style={{ color: t.dim }}>({c.source === "relationship" ? "Asset Contract Relationship" : c.source === "order" ? "origin order's contract" : "pricing contract"})</span></div>)
                  : <div style={{ fontSize: 12.5, color: t.dim }}>No contract is related to this asset (no Asset Contract Relationship, no contract on its origin order, no pricing contract). Lifecycle transactions don&apos;t need one.</div>}
              </Panel>
              <Panel isDark={isDark} title="Lifecycle eligibility" icon="shield">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
                  {LIFECYCLE_KINDS.map(k => (
                    <div key={k} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, fontWeight: 700, color: t.heading }}>{SECTION_META[k].singular} <EligibilityBadge reasons={a.eligibility[k]} isDark={isDark} /></div>
                      <ReasonList reasons={a.eligibility[k]} isDark={isDark} empty="No restrictions found." />
                    </div>
                  ))}
                </div>
              </Panel>
              {data.children.length > 0 && (
                <Panel isDark={isDark} title="Bundle components" icon="layers">
                  {data.children.map(c => <div key={c.id}><button onClick={() => onOpenAsset(c.id)} style={{ background: "none", border: "none", color: t.accent, cursor: "pointer", padding: 0, fontSize: 12.5 }}>{c.name}</button> <span style={{ fontSize: 12, color: t.dim }}>qty {fmtNum(c.quantity)}</span></div>)}
                </Panel>
              )}
            </>
          )}
          {tab === "actions" && (data.actions.length ? (
            <TableFrame isDark={isDark}>
              <thead><tr>{["Date", "Action", "Category", "Subtype", "Qty change", "MRR change", "Amount", "Source order lines"].map(h => <th key={h} style={th(t)}>{h}</th>)}</tr></thead>
              <tbody>{data.actions.map(x => (
                <tr key={x.id}>
                  <td style={td(t)}>{fmtDate(x.date)}<div style={{ fontSize: 10.5, color: t.dim }}>{x.number}</div></td><td style={td(t)}>{x.type ?? "—"}</td><td style={td(t)}>{x.category ?? "—"}</td><td style={td(t)}>{x.subtype ?? "—"}</td>
                  <td style={td(t)}>{fmtNum(x.quantityChange)}</td><td style={td(t)}>{fmtMoney(x.mrrChange)}</td><td style={td(t)}>{fmtMoney(x.amount)}</td>
                  <td style={td(t)}>{x.sources.map(s => <div key={s.id} style={{ fontSize: 11.5 }}>{s.orderNumber ? `Order ${s.orderNumber}` : s.orderItemId ?? "—"} · qty {fmtNum(s.quantity)} @ {fmtMoney(s.netUnitPrice ?? s.unitPrice)} · {fmtDate(s.startDate)} → {fmtDate(s.endDate)}</div>)}</td>
                </tr>
              ))}</tbody>
            </TableFrame>
          ) : <EmptyState isDark={isDark} icon="activity" title="No Asset Actions" hint="This asset has no lifecycle history in Salesforce." />)}
          {tab === "periods" && (data.statePeriods.length ? (
            <TableFrame isDark={isDark}>
              <thead><tr>{["Period", "Start", "End", "Qty", "Unit price", "Discount", "MRR", "Amount", "Billing", "Segment"].map(h => <th key={h} style={th(t)}>{h}</th>)}</tr></thead>
              <tbody>{data.statePeriods.map(p => <tr key={p.id}><td style={td(t)}>{p.number ?? p.id}</td><td style={td(t)}>{fmtDate(p.startDate)}</td><td style={td(t)}>{fmtDate(p.endDate)}</td><td style={td(t)}>{fmtNum(p.quantity)}</td><td style={td(t)}>{fmtMoney(p.unitPrice)}</td><td style={td(t)}>{p.discount != null ? `${p.discount}%` : "—"}</td><td style={td(t)}>{fmtMoney(p.mrr)}</td><td style={td(t)}>{fmtMoney(p.amount)}</td><td style={td(t)}>{p.billingFrequency ?? "—"}</td><td style={td(t)}>{p.segment ?? "—"}</td></tr>)}</tbody>
            </TableFrame>
          ) : <EmptyState isDark={isDark} icon="calendar" title="No Asset State Periods" />)}
          {tab === "transactions" && (data.transactions.length ? (
            <TableFrame isDark={isDark}>
              <thead><tr>{["Record", "Type", "Subtype", "Status", "Order", "Created"].map(h => <th key={h} style={th(t)}>{h}</th>)}</tr></thead>
              <tbody>{data.transactions.map((x, i) => <tr key={`${x.source}-${x.id}-${i}`}><td style={td(t)}>{x.source} {x.number ?? x.id}</td><td style={td(t)}>{x.type ?? "—"}</td><td style={td(t)}>{x.subtype ?? "—"}</td><td style={td(t)}>{x.status ?? "—"}</td><td style={td(t)}>{x.orderNumber ?? "—"}</td><td style={td(t)}>{fmtDate(x.createdDate)}</td></tr>)}</tbody>
            </TableFrame>
          ) : <EmptyState isDark={isDark} icon="list" title="No lifecycle quotes or orders reference this asset" />)}
          {tab === "billing" && (data.billing.length ? (
            <TableFrame isDark={isDark}>
              <thead><tr>{["Billing schedule group", "Start", "End", "Cancellation", "Billed", "Pending", "Next bill", "Schedules"].map(h => <th key={h} style={th(t)}>{h}</th>)}</tr></thead>
              <tbody>{data.billing.map(g => <tr key={g.groupId}><td style={td(t)}>{g.number ?? g.groupId}</td><td style={td(t)}>{fmtDate(g.startDate)}</td><td style={td(t)}>{fmtDate(g.endDate)}</td><td style={td(t)}>{fmtDate(g.cancellationDate)}</td><td style={td(t)}>{fmtMoney(g.billed)}</td><td style={td(t)}>{fmtMoney(g.pending)}</td><td style={td(t)}>{fmtDate(g.nextBillingDate)}</td><td style={td(t)}>{g.schedules}</td></tr>)}</tbody>
            </TableFrame>
          ) : <EmptyState isDark={isDark} icon="dollar-sign" title="Not billed through Revenue Cloud Billing" hint="No Billing Schedule Group references this asset." />)}
          {tab === "attributes" && (data.attributes.length ? (
            <TableFrame isDark={isDark}>
              <thead><tr>{["Attribute", "Value", "Definition"].map(h => <th key={h} style={th(t)}>{h}</th>)}</tr></thead>
              <tbody>{data.attributes.map(x => <tr key={x.id}><td style={td(t)}>{x.name ?? "—"}</td><td style={td(t)}>{x.value ?? "—"}</td><td style={td(t)}>{x.definitionId ?? "—"}</td></tr>)}</tbody>
            </TableFrame>
          ) : <EmptyState isDark={isDark} icon="sliders" title="No asset attributes" />)}
        </>
      )}
    </div>
  );
}
