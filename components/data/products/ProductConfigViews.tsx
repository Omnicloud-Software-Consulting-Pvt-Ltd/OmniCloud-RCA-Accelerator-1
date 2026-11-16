"use client";

import type { ReactNode } from "react";
import { tokens } from "@/components/data/quotes/shared";
import { Panel } from "@/components/data/billing/billingUi";
import { Notice, Table } from "@/components/data/billing/tax/taxUi";
import type { ConfigValue, ProductConfiguration, RecordRef, RelationKey, RevenueConfigResolution } from "@/lib/products/revenueConfig";
import { WarningsDisclosure } from "@/components/ui/Disclosure";

/**
 * Product configuration views — the central read view of a Revenue Cloud product. Every relationship is shown by NAME + Id,
 * and every value says where Salesforce keeps it: a Product2 field ("Product2 field") or a related record ("Related record").
 */

const Id = ({ v }: { v: string | null | undefined }) => (v ? <code style={{ fontSize: 11, opacity: 0.8 }}>{v}</code> : null);
const statusColor = (s: string | null | undefined) => (s === "Active" ? "#00C875" : s ? "#F5A623" : "#8899AA");

function Source({ isDark, direct, source }: { isDark: boolean; direct: boolean; source: string }) {
  const t = tokens(isDark);
  return (
    <span style={{ fontSize: 10.5, color: t.dim, whiteSpace: "nowrap" }}>
      <b style={{ color: direct ? "#00D4FF" : "#A78BFA", textTransform: "uppercase", fontSize: 9.5, marginRight: 4 }}>{direct ? "Product2 field" : "Related record"}</b>
      {source.replace(/^related: /, "")}
    </span>
  );
}

function Rows({ isDark, rows }: { isDark: boolean; rows: { label: string; value: ReactNode; source?: ReactNode }[] }) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, 200px) 1fr auto", gap: "6px 12px", fontSize: 12.5, alignItems: "baseline" }}>
      {rows.flatMap(r => [
        <span key={`l${r.label}`} style={{ color: t.dim }}>{r.label}</span>,
        <span key={`v${r.label}`} style={{ color: t.body }}>{r.value}</span>,
        <span key={`s${r.label}`}>{r.source ?? null}</span>,
      ])}
    </div>
  );
}

function recordValue(v: ConfigValue | ConfigValue<boolean>, empty = "Not configured"): ReactNode {
  if (v.record) return <span><b>{v.record.name}</b> {v.record.status ? <span style={{ color: statusColor(v.record.status), fontSize: 11 }}>· {v.record.status}</span> : null}<br /><Id v={v.record.id} />{v.note ? <><br /><span style={{ fontSize: 11, opacity: 0.75 }}>{v.note}</span></> : null}</span>;
  if (v.value !== null && v.value !== undefined) return <span>{typeof v.value === "boolean" ? (v.value ? "Yes" : "No") : v.value}{v.note ? <><br /><span style={{ fontSize: 11, opacity: 0.75 }}>{v.note}</span></> : null}</span>;
  return <span style={{ opacity: 0.6 }}>{empty}{v.note ? ` — ${v.note}` : ""}</span>;
}
const list = (items: (RecordRef & { extra?: string })[], empty: string) => items.length
  ? <span>{items.map(i => <span key={i.id} style={{ display: "block" }}><b>{i.name}</b>{i.extra ? ` · ${i.extra}` : ""} {i.status ? <span style={{ color: statusColor(i.status), fontSize: 11 }}>· {i.status}</span> : null} <Id v={i.id} /></span>)}</span>
  : <span style={{ opacity: 0.6 }}>{empty}</span>;

export function ProductConfigurationPanel({ isDark, c, verification, title }: { isDark: boolean; c: ProductConfiguration; verification?: { label: string; expected: string | null; actual: string | null; passed: boolean }[]; title?: string }) {
  const p = c.product, r = c.revenue, tx = c.tax, b = c.billing;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {title && <div style={{ fontSize: 13, fontWeight: 800 }}>{title}</div>}
      <Panel isDark={isDark} title="Product Information" icon="package">
        <Rows isDark={isDark} rows={[
          { label: "Name", value: <span><b>{p.name}</b> <Id v={p.id} /></span>, source: <Source isDark={isDark} direct source="Product2.Name" /> },
          { label: "Code", value: p.code ?? "—", source: <Source isDark={isDark} direct source="Product2.ProductCode" /> },
          { label: "Family", value: p.family ?? "—", source: <Source isDark={isDark} direct source="Product2.Family" /> },
          { label: "Description", value: p.description ?? "—", source: <Source isDark={isDark} direct source="Product2.Description" /> },
          { label: "Active", value: <b style={{ color: p.isActive ? "#00C875" : "#E2445C" }}>{p.isActive ? "Yes" : "No"}</b>, source: <Source isDark={isDark} direct source="Product2.IsActive" /> },
          { label: "Unit of Measure", value: recordValue(p.unitOfMeasure), source: <Source isDark={isDark} direct source={p.unitOfMeasure.source} /> },
        ]} />
      </Panel>
      <Panel isDark={isDark} title="Revenue Cloud Configuration" icon="layers">
        <Rows isDark={isDark} rows={[
          { label: "Product Selling Model", value: list(r.sellingModels.map(m => ({ ...m, extra: m.type ?? undefined })), "No selling model"), source: <Source isDark={isDark} direct={false} source="ProductSellingModelOption" /> },
          { label: "Catalog", value: list(r.catalogs, "No catalog"), source: <Source isDark={isDark} direct={false} source="ProductCategory.CatalogId" /> },
          { label: "Category", value: list(r.categories.map(x => ({ ...x, extra: x.catalog ? `in ${x.catalog}` : undefined })), "No category"), source: <Source isDark={isDark} direct={false} source="ProductCategoryProduct" /> },
          { label: "Pricebook / Unit Price", value: r.pricebookEntries.length ? <span>{r.pricebookEntries.map(e => <span key={e.id} style={{ display: "block" }}><b>{e.pricebook.name}</b>{e.pricebook.isStandard ? " (standard)" : ""} · <b>{e.unitPrice ?? "—"}</b>{e.sellingModel ? ` · ${e.sellingModel}` : ""} <span style={{ color: e.isActive ? "#00C875" : "#F5A623", fontSize: 11 }}>· {e.isActive ? "Active" : "Inactive"}</span> <Id v={e.id} /></span>)}</span> : <span style={{ opacity: 0.6 }}>No PricebookEntry</span>, source: <Source isDark={isDark} direct={false} source="PricebookEntry" /> },
        ]} />
      </Panel>
      <Panel isDark={isDark} title="Tax Configuration" icon="percent">
        <Rows isDark={isDark} rows={[
          { label: "Tax Policy", value: recordValue(tx.policy, "No Tax Policy assigned"), source: <Source isDark={isDark} direct source={tx.policy.source} /> },
          { label: "Tax Treatment", value: recordValue(tx.treatment), source: <Source isDark={isDark} direct={false} source={tx.treatment.source} /> },
          { label: "Tax Treatment Item", value: recordValue(tx.treatmentItem, tx.treatment.usesItems ? "None for this product" : "Not used"), source: <Source isDark={isDark} direct={false} source={tx.treatmentItem.source} /> },
          { label: "Tax Engine", value: <span>{recordValue(tx.engine)}{tx.engine.type ? <span style={{ fontSize: 11 }}> · {tx.engine.type}</span> : null}</span>, source: <Source isDark={isDark} direct={false} source={tx.engine.source} /> },
          { label: "Tax Code", value: recordValue(tx.taxCode, "—"), source: <Source isDark={isDark} direct={false} source={tx.taxCode.source} /> },
          { label: "Taxable", value: recordValue(tx.taxable, "—"), source: <Source isDark={isDark} direct={false} source={tx.taxable.source} /> },
        ]} />
      </Panel>
      <Panel isDark={isDark} title="Billing Configuration" icon="credit-card">
        <Rows isDark={isDark} rows={[
          { label: "Billing Policy", value: recordValue(b.policy, "No Billing Policy assigned"), source: <Source isDark={isDark} direct source={b.policy.source} /> },
          { label: "Billing Treatment", value: recordValue(b.treatment), source: <Source isDark={isDark} direct={false} source={b.treatment.source} /> },
          { label: "Billing Treatment Item", value: list(b.treatmentItems.map(i => ({ ...i, extra: [i.billingType, i.type].filter(Boolean).join(" / ") || undefined })), "No billing treatment item"), source: <Source isDark={isDark} direct={false} source="BillingTreatmentItem.BillingTreatmentId" /> },
        ]} />
      </Panel>
      <ReadinessView isDark={isDark} readiness={c.readiness} />
      {verification && verification.length > 0 && (
        <Panel isDark={isDark} title="Verification (re-read from Salesforce)" icon="check-circle">
          <Table isDark={isDark} head={["Requested", "Expected", "Salesforce has", "Result"]} empty="" rows={verification.map(v => [v.label, v.expected ?? "—", v.actual ?? "—", <b key="r" style={{ color: v.passed ? "#00C875" : "#E2445C" }}>{v.passed ? "✓ Verified" : "✗ Not applied"}</b>])} />
        </Panel>
      )}
    </div>
  );
}

export function ReadinessView({ isDark, readiness }: { isDark: boolean; readiness: ProductConfiguration["readiness"] }) {
  return (
    <Panel isDark={isDark} title="Product readiness" icon="activity" right={<b style={{ fontSize: 11, color: readiness.ready ? "#00C875" : "#E2445C" }}>{readiness.ready ? "READY" : "NOT READY"}</b>}>
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "grid", gap: 3 }}>
          {readiness.checks.map(c => <div key={c.id} style={{ display: "grid", gridTemplateColumns: "18px 230px 1fr", gap: 8, fontSize: 12.5 }}><b style={{ color: c.passed ? "#00C875" : "#E2445C" }}>{c.passed ? "✓" : "✗"}</b><span>{c.label}</span><span style={{ opacity: 0.8 }}>{c.detail}</span></div>)}
        </div>
        {readiness.ready
          ? <Notice isDark={isDark} tone="ok">Configured for Order → Billing → Tax calculation (configuration only — the actual tax is Salesforce&apos;s InvoiceLineTax).</Notice>
          : <Notice isDark={isDark} tone="error"><b>MISSING:</b> {readiness.missing.join(" · ")}. This product isn&apos;t ready for Order → Billing → Tax calculation.</Notice>}
      </div>
    </Panel>
  );
}

const RESULT_COLOR: Record<string, string> = { resolved: "#00C875", derived: "#00D4FF", not_found: "#E2445C", ambiguous: "#F5A623", invalid: "#E2445C", mismatch: "#E2445C" };

export function RelationResolutionView({ isDark, resolution, onPick }: { isDark: boolean; resolution: RevenueConfigResolution; onPick?: (key: RelationKey, id: string) => void }) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <Table isDark={isDark} head={["Relationship", "Requested", "Result", "Salesforce record", "Stored as"]} empty="No tax/billing configuration requested." rows={resolution.resolutions.map(r => [
        <b key="l">{r.label}</b>, r.requested,
        <b key="s" style={{ color: r.dependency ? "#F5A623" : RESULT_COLOR[r.status] }}>{r.dependency ? "DEPENDENCY" : r.status.replace("_", " ").toUpperCase()}{r.matchedBy === "partial" ? " (partial)" : ""}</b>,
        <span key="r">
          {r.record ? <><b>{r.record.name}</b> <Id v={r.record.id} /></> : null}
          <span style={{ display: "block", fontSize: 11.5, color: t.dim }}>{r.message}</span>
          {r.candidates.length > 0 && <span style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>{r.candidates.map(c => (
            <button key={c.id} type="button" onClick={() => onPick?.(r.key, c.id)} disabled={!onPick} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, border: `1px solid ${t.border}`, background: "transparent", color: t.body, cursor: onPick ? "pointer" : "default" }}>{c.name} · {c.status ?? "—"} · {c.id.slice(0, 8)}…</button>
          ))}</span>}
        </span>,
        <span key="o" style={{ fontSize: 11 }}>{r.direct ? <b style={{ color: "#00D4FF" }}>Product2</b> : "related"} · {r.storage.replace(/^related: /, "")}</span>,
      ])} />
      {resolution.blockers.length > 0 && <Notice isDark={isDark} tone="error"><b>Can&apos;t be applied:</b> {resolution.blockers.join(" · ")}</Notice>}
      <WarningsDisclosure isDark={isDark} warnings={resolution.warnings} />
    </div>
  );
}

export interface UpdatePlanLike { changes: { field: string; label: string; storage: string; from: string | null; to: string | null }[]; blockers: string[]; warnings: string[]; resolution: RevenueConfigResolution | null }
export function UpdatePlanView({ isDark, plan, onPick }: { isDark: boolean; plan: UpdatePlanLike; onPick?: (key: RelationKey, id: string) => void }) {
  return (
    <Panel isDark={isDark} title="Preview — only the requested configuration changes" icon="eye">
      <div style={{ display: "grid", gap: 8 }}>
        <Table isDark={isDark} head={["Change", "Before", "After", "Salesforce field"]} empty="No change." rows={plan.changes.map(c => [<b key="l">{c.label}</b>, c.from ?? "—", <b key="t">{c.to ?? "—"}</b>, <code key="s" style={{ fontSize: 11 }}>{c.storage}</code>])} />
        {plan.resolution && plan.resolution.resolutions.length > 0 && <RelationResolutionView isDark={isDark} resolution={plan.resolution} onPick={onPick} />}
        {(() => { const extra = plan.blockers.filter(b => !plan.resolution?.blockers.includes(b)); return extra.length > 0 && <Notice isDark={isDark} tone="error">{extra.join(" · ")}</Notice>; })()}
        {(() => { const extra = plan.warnings.filter(w => !plan.resolution?.warnings.includes(w)); return extra.length > 0 && <Notice isDark={isDark} tone="warn">{extra.join(" · ")}</Notice>; })()}
      </div>
    </Panel>
  );
}
