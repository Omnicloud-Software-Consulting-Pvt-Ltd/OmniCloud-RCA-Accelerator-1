"use client";

import { useState } from "react";
import { tokens, PrimaryButton, GhostButton, ErrorPanel } from "@/components/data/quotes/shared";
import { Panel, StatusPill, Modal, Row, StatTile } from "@/components/data/billing/billingUi";
import { quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import type { TaxDashboard as Dashboard } from "@/lib/tax/types";
import { Notice, Table, pct } from "@/components/data/billing/tax/taxUi";

type TaxAdmin = { status: "enabled" | "missing" | "not-available"; message: string; canAssign: boolean; adminInstruction: string | null; permissionSet: { name: string; label: string } | null; license: { name: string | null; assigned: boolean } | null };

/** Org, user and Tax Admin — assignment is offered only for the current user, and only if they may assign permission sets. */
function ConnectionPanel({ isDark, data, taxAdmin, reload }: { isDark: boolean; data: Dashboard; taxAdmin: TaxAdmin | null; reload: () => void }) {
  const t = tokens(isDark);
  const c = data.connection;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  async function assign() {
    setBusy(true); setError(null); setMsg(null);
    try { const r = await quoteApiPost<{ message: string }>("Assign Tax Admin", "/api/billing/tax/permissions/tax-admin", { confirm: true }); setMsg(r.message); reload(); }
    catch (err) { setError(toBillingErrorPanel(err, "Tax Admin wasn't assigned")); }
    finally { setBusy(false); setConfirm(false); }
  }
  return (
    <Panel isDark={isDark} title="Salesforce connection" icon="link" right={<GhostButton label="Refresh" icon="refresh-cw" isDark={isDark} onClick={reload} />}>
      <div style={{ display: "grid", gap: 6 }}>
        <Row isDark={isDark} label="Connected Org">{c.orgName ?? "—"}{c.orgId ? ` (${c.orgId})` : ""}{c.orgType ? ` · ${c.orgType}` : ""} · {c.instanceUrl}</Row>
        <Row isDark={isDark} label="Current User">{c.displayName ?? "—"}{c.username ? ` (${c.username})` : ""}</Row>
        <Row isDark={isDark} label="Tax Admin">{taxAdmin ? <StatusPill status={taxAdmin.status === "enabled" ? "Enabled" : taxAdmin.status === "missing" ? "Missing" : "Not available"} isDark={isDark} /> : <span style={{ color: t.dim }}>Checking…</span>}</Row>
      </div>
      {taxAdmin && taxAdmin.status !== "enabled" && (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          <Notice isDark={isDark} tone="warn"><b>Permission problem:</b> {taxAdmin.message}</Notice>
          {taxAdmin.status === "missing" && (taxAdmin.canAssign
            ? <div><PrimaryButton label="Assign Tax Admin to me" icon="shield" isDark={isDark} disabled={busy} onClick={() => setConfirm(true)} /></div>
            : taxAdmin.adminInstruction && <Notice isDark={isDark} tone="info"><b>Admin action:</b> {taxAdmin.adminInstruction}</Notice>)}
        </div>
      )}
      {msg && <div style={{ marginTop: 8 }}><Notice isDark={isDark} tone="ok">{msg}</Notice></div>}
      {error && <div style={{ marginTop: 8 }}><ErrorPanel isDark={isDark} error={error} /></div>}
      {confirm && (
        <Modal isDark={isDark} title="Assign Tax Admin to yourself?" tone="accent" actions={<>
          <GhostButton label="Cancel" isDark={isDark} onClick={() => setConfirm(false)} />
          <PrimaryButton label={busy ? "Assigning…" : "Assign"} icon="check" isDark={isDark} disabled={busy} onClick={() => void assign()} />
        </>}>
          <div style={{ fontSize: 12.5, color: t.body }}>Assigns <b>{taxAdmin?.permissionSet?.label ?? "Tax Admin"}</b>{taxAdmin?.license && !taxAdmin.license.assigned ? <> and its <b>{taxAdmin.license.name}</b> licence</> : null} to <b>{c.username}</b> — the user of this connection — in <b>{c.orgName}</b>. No other user&apos;s permissions change.</div>
        </Modal>
      )}
    </Panel>
  );
}

export default function TaxDashboard({ isDark, data, taxAdmin, reload }: { isDark: boolean; data: Dashboard; taxAdmin: TaxAdmin | null; reload: () => void }) {
  const t = tokens(isDark);
  const s = data.stats, st = data.status;
  const engineName = (id: string | null) => data.engines.find(e => e.id === id)?.name ?? (id ? id : "—");
  const policyName = (id: string | null) => data.policies.find(p => p.id === id)?.name ?? "—";
  const treatmentName = (id: string | null) => data.treatments.find(x => x.id === id)?.name ?? "—";
  const leName = (id: string | null) => data.legalEntities.find(l => l.id === id)?.name ?? "—";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <StatTile isDark={isDark} label="Active engines" value={String(s.activeEngines)} />
        <StatTile isDark={isDark} label="Active policies" value={String(s.activePolicies)} />
        <StatTile isDark={isDark} label="Taxable treatments" value={String(s.taxableTreatments)} />
        <StatTile isDark={isDark} label="Treatment items" value={String(s.items)} />
        <StatTile isDark={isDark} label="Effective rates" value={String(s.effectiveRates)} />
        <StatTile isDark={isDark} label="Taxable products" value={String(data.taxableProducts.length)} color="#00C875" />
        <StatTile isDark={isDark} label="Taxed invoices" value={s.taxedInvoices === null ? "unavailable" : String(s.taxedInvoices)} color="#00C875" />
      </div>
      <Panel isDark={isDark} title="Tax Configuration Status" icon="activity">
        <div style={{ display: "grid", gap: 6 }}>
          <Row isDark={isDark} label="Configuration"><StatusPill status={st.configuration} isDark={isDark} /> <span style={{ color: t.dim }}>{st.configurationDetail}</span></Row>
          <Row isDark={isDark} label="Calculation (Salesforce)"><StatusPill status={st.calculation} isDark={isDark} /> <span style={{ color: t.dim }}>{st.calculationDetail}</span></Row>
        </div>
      </Panel>
      {data.missingObjects.map(o => <Notice key={o.name} isDark={isDark} tone="warn"><b>{o.name}:</b> {o.reason}</Notice>)}
      <ConnectionPanel isDark={isDark} data={data} taxAdmin={taxAdmin} reload={reload} />
      <Panel isDark={isDark} title="Tax Engines" icon="cpu">
        <Table isDark={isDark} head={["Name", "Type", "Status", "Provider", "Seller Code", "ID"]} empty="No tax engines in Salesforce."
          rows={data.engines.map(e => [<b key="n">{e.name}</b>, `${e.type ?? "—"}${e.native ? " (native)" : ""}`, <StatusPill key="s" status={e.status} isDark={isDark} />, e.provider?.name ?? "—", e.sellerCode ?? "—", <code key="i">{e.id}</code>])} />
      </Panel>
      <Panel isDark={isDark} title="Tax Policies" icon="shield">
        <Table isDark={isDark} head={["Name", "Status", "Selection", "Default Treatment", "Products", "ID"]} empty="No tax policies in Salesforce."
          rows={data.policies.map(p => [<b key="n">{p.name}</b>, <StatusPill key="s" status={p.status} isDark={isDark} />, p.selection ?? "—", treatmentName(p.defaultTreatmentId), p.products, <code key="i">{p.id}</code>])} />
      </Panel>
      <Panel isDark={isDark} title="Tax Treatments" icon="layers">
        <Table isDark={isDark} head={["Name", "Status", "Taxable", "Tax Code", "Items", "Engine", "Policy", "Legal Entity", "ID"]} empty="No tax treatments in Salesforce."
          rows={data.treatments.map(x => [<b key="n">{x.name}</b>, <StatusPill key="s" status={x.status} isDark={isDark} />, x.taxable ? "Yes" : "No", x.taxCode ?? "—", x.useItems ? "Yes" : "—", engineName(x.engineId), policyName(x.policyId), leName(x.legalEntityId), <code key="i">{x.id}</code>])} />
      </Panel>
      <Panel isDark={isDark} title="Tax Treatment Items" icon="list">
        <Table isDark={isDark} head={["Name", "Treatment", "Product", "Tax Code", "ID"]} empty="No tax treatment items in Salesforce."
          rows={data.items.map(i => [<b key="n">{i.name}</b>, treatmentName(i.treatmentId), i.productName ?? i.productId ?? "—", i.taxCode ?? "—", <code key="i">{i.id}</code>])} />
      </Panel>
      <Panel isDark={isDark} title="Tax Rates (tax codes)" icon="percent">
        <Table isDark={isDark} head={["Tax Code", "Rate", "Country", "Usage", "Legal Entity", "Start", "End", "Effective", "ID"]} empty="No tax rates in Salesforce."
          rows={data.rates.map(r => [<b key="c">{r.taxCode ?? "—"}</b>, pct(r.rate), r.country ?? "—", r.usage ?? "—", leName(r.legalEntityId), r.start ?? "—", r.end ?? "—", r.effective ? "Yes" : "No", <code key="i">{r.id}</code>])} />
      </Panel>
      <Panel isDark={isDark} title="Taxable Products" icon="package">
        <Table isDark={isDark} head={["Product", "Code", "Active", "Tax Policy", "ID"]} empty="No product is mapped to a taxable tax policy yet."
          rows={data.taxableProducts.map(p => [<b key="n">{p.name}</b>, p.code ?? "—", p.active ? "Yes" : "No", policyName(p.taxPolicyId), <code key="i">{p.id}</code>])} />
      </Panel>
    </div>
  );
}
