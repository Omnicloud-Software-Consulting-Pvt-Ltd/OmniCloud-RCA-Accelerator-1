"use client";

import type { ReactNode } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, PageShell, ErrorPanel, GhostButton, PrimaryButton } from "@/components/data/quotes/shared";
import { Panel, StatusPill, LoadingRow, useBillingData, ToolbarButton } from "@/components/data/billing/billingUi";
import { formatBillingValue } from "@/lib/billing/client";
import type { AssignmentPolicyChain } from "@/lib/billing/server/assignment";

interface ProductBillingResponse {
  success: true;
  product: { id: string; name: string; fields: { name: string; label: string; value: unknown }[] };
  field: { name: string; label: string } | null;
  policy: AssignmentPolicyChain | null;
  salesforceUrl: string;
}

/**
 * A Product's details with its Revenue Cloud Billing section (Product → Billing Policy → Default
 * Treatment → Items), read live from Salesforce. The product itself is still owned by the existing
 * Products module — "Open in Products" goes there; this view only adds the billing relationship.
 */
export default function BillingProductBilling({ isDark, productId, onViewPolicy, onViewTreatment, onAssign, onOpenProducts }: {
  isDark: boolean;
  productId: string;
  onViewPolicy: (id: string) => void;
  onViewTreatment: (id: string) => void;
  onAssign: (productId: string, policyId?: string | null) => void;
  onOpenProducts: () => void;
}) {
  const t = tokens(isDark);
  const { data, error, loading, reload } = useBillingData<ProductBillingResponse>("Load product billing", `/api/billing/assignments/product/${productId}`);

  if (error && !data) return <div style={{ padding: 20 }}><ErrorPanel isDark={isDark} error={error} /></div>;
  if (!data) return <div style={{ padding: 20 }}><LoadingRow isDark={isDark} label="Loading product from Salesforce…" /></div>;
  const p = data.policy;
  const kv = (label: string, value: ReactNode) => (
    <div style={{ display: "contents" }}>
      <span style={{ color: t.dim, fontSize: 11.5 }}>{label}</span><span style={{ color: t.heading, fontWeight: 600, fontSize: 12.5 }}>{value}</span>
    </div>
  );

  return (
    <PageShell>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14, opacity: loading ? 0.6 : 1 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", color: t.accent, background: `${t.accent}18`, border: `1px solid ${t.accent}40` }}><Ic n="package" s={20} /></div>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4 }}>Product · Product2</div>
              <div style={{ fontSize: 19, fontWeight: 800, color: t.heading }}>{data.product.name}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <ToolbarButton isDark={isDark} label="Refresh" icon="refresh" onClick={reload} disabled={loading} />
            <ToolbarButton isDark={isDark} label="Open in Products" icon="package" onClick={onOpenProducts} />
            <a href={data.salesforceUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 13px", borderRadius: 9, fontSize: 12.5, fontWeight: 600, color: t.accent, textDecoration: "none", border: `1px solid ${t.border}` }}>
              <Ic n="external-link" s={13} /> Open in Salesforce
            </a>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14 }}>
          <Panel isDark={isDark} title="Product" icon="info">
            <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 40%) 1fr", gap: "8px 12px" }}>
              {data.product.fields.map(f => <div key={f.name} style={{ display: "contents" }}>{kv(f.label, formatBillingValue(f.value, typeof f.value === "boolean" ? "boolean" : "string"))}</div>)}
              {kv("Salesforce ID", <code style={{ fontWeight: 500 }}>{data.product.id}</code>)}
            </div>
          </Panel>

          <Panel isDark={isDark} title="Revenue Cloud Billing" icon="credit-card" right={data.field ? <span style={{ fontSize: 10.5, color: t.dim, fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}>Product2.{data.field.name}</span> : undefined}>
            {!data.field ? (
              <div style={{ fontSize: 12.5, color: t.dim }}>This org has no Product → Billing Policy relationship.</div>
            ) : !p ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 40%) 1fr", gap: "8px 12px" }}>{kv("Billing Policy", <span style={{ color: t.warn }}>Not assigned</span>)}</div>
                <div><PrimaryButton label="Assign Billing Policy" icon="link" isDark={isDark} onClick={() => onAssign(data.product.id)} /></div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 40%) 1fr", gap: "8px 12px" }}>
                  {kv("Billing Policy", <button onClick={() => onViewPolicy(p.id)} style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: t.accent, fontWeight: 700, fontSize: 12.5 }}>{p.name} →</button>)}
                  {kv("Status", <StatusPill status={p.status} isDark={isDark} />)}
                  {kv("Default Treatment", p.defaultTreatment
                    ? <button onClick={() => onViewTreatment(p.defaultTreatment!.id)} style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: t.accent, fontWeight: 700, fontSize: 12.5 }}>{p.defaultTreatment.name} →</button>
                    : <span style={{ color: t.error }}>None</span>)}
                  {kv("Treatment Items", `${p.items.length}${p.items.length ? ` (${p.items.map(i => `${i.name} · ${i.status ?? "—"}`).join(", ")})` : ""}`)}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <GhostButton label="View Billing Policy" icon="eye" isDark={isDark} onClick={() => onViewPolicy(p.id)} />
                  <GhostButton label="Change Billing Policy" icon="edit" isDark={isDark} onClick={() => onAssign(data.product.id)} />
                </div>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </PageShell>
  );
}
