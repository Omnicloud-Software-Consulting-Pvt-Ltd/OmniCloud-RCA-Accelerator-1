"use client";

import { useState } from "react";
import { tokens, PrimaryButton, GhostButton, ErrorPanel } from "@/components/data/quotes/shared";
import { Modal, LoadingRow } from "@/components/data/billing/billingUi";
import { quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import { Notice } from "@/components/data/billing/tax/taxUi";
import type { RefreshResult } from "@/lib/tax/server/refreshApproval";
import type { DecisionTableResult } from "@/lib/tax/server/decisionTable";
import type { RecalcResult } from "@/lib/tax/server/invoiceRecalc";
import { recalcNotice } from "@/lib/tax/recalcDisplay";

/**
 * Separately approved tax actions, each previewed first (read-only) and confirmed on its own:
 *  · RefreshStep — refresh the decision table a tax engine uses (never changes its definition or any engine assignment).
 *  · AssignDecisionTableStep — set TaxEngine.DecisionTableId on ONE engine to the existing TaxCode table; other engines are untouched.
 *  · InvoiceTaxRecalcStep — ask Salesforce to recalculate a Draft invoice's estimated tax, then re-verify its InvoiceLineTax.
 */

const Id = ({ v }: { v: string | null | undefined }) => (v ? <code style={{ fontSize: 11 }}>{v}</code> : <>—</>);

export function RefreshStep({ isDark, engineId, onDone }: { isDark: boolean; engineId: string; onDone: (ok: boolean) => void }) {
  const t = tokens(isDark);
  const [r, setR] = useState<RefreshResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  async function call(body: Record<string, unknown>, label: string) {
    setBusy(label); setError(null);
    try { const out = await quoteApiPost<RefreshResult & { success: true }>("Decision table refresh", "/api/taxes/decision-table/refresh", body); setR(out); if (out.mode === "refresh") onDone(out.state === "Ready"); }
    catch (err) { setError(toBillingErrorPanel(err, "The decision-table refresh failed")); }
    finally { setBusy(null); setConfirm(false); }
  }
  const table = r && r.mode !== "list" ? r.table : null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <GhostButton label={busy === "preview" ? "Reading…" : "Check the decision table"} icon="eye" isDark={isDark} disabled={!!busy} onClick={() => void call({ engineId }, "preview")} />
        {r?.mode === "preview" && r.needsRefresh && <PrimaryButton label="Approve refresh…" icon="refresh" isDark={isDark} disabled={!!busy} onClick={() => setConfirm(true)} />}
      </div>
      {busy && <LoadingRow isDark={isDark} label={busy === "refresh" ? "Salesforce is refreshing the decision table…" : "Reading the decision table…"} />}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {r && r.mode !== "list" && <Notice isDark={isDark} tone={r.mode === "refresh" ? (r.state === "Ready" ? "ok" : "error") : r.needsRefresh ? "warn" : "ok"}>{r.message}</Notice>}
      {table && <div style={{ fontSize: 12, color: t.dim }}>{table.decisionTable.name} <Id v={table.decisionTable.id} /> · status {table.decisionTable.status ?? "—"} · refresh {table.decisionTable.refreshStatus ?? "—"} · last full {table.decisionTable.lastFullRefresh ?? "never"} · last incremental {table.decisionTable.lastIncrementalRefresh ?? "never"} · newest Tax Rate change {table.newestRateChange ?? "—"}</div>}
      {table && table.ratesChangedAfterRefresh?.length > 0 && <div style={{ fontSize: 12, color: "#F5A623" }}>Changed after the last refresh (not yet visible to Salesforce&apos;s lookup): {table.ratesChangedAfterRefresh.map(x => `${x.name} (${x.changedAt ?? "—"})`).join(", ")}</div>}
      {confirm && r?.mode === "preview" && r.confirmation && (
        <Modal isDark={isDark} title="Refresh this decision table in Salesforce?" tone="warn" actions={<>
          <GhostButton label="Not now" isDark={isDark} onClick={() => setConfirm(false)} />
          <PrimaryButton label="Approve refresh" icon="check" isDark={isDark} disabled={!!busy} onClick={() => void call({ engineId, confirm: r.confirmation }, "refresh")} />
        </>}>
          <div style={{ fontSize: 12.5, display: "grid", gap: 6 }}>
            <div>Salesforce re-syncs <b>{r.table.decisionTable.name}</b> ({r.table.decisionTable.id}) from the Tax Rates. The table&apos;s definition and every engine assignment stay unchanged.</div>
            {r.table.sharedWith.length > 0 && <div style={{ color: "#F5A623" }}>⚠ Shared with {r.table.sharedWith.map(s => s.name).join(", ")} — their lookups use the refreshed table too.</div>}
            <div style={{ opacity: 0.8 }}>This approval covers only this refresh.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function AssignDecisionTableStep({ isDark, engineId, onDone }: { isDark: boolean; engineId: string; onDone?: (ok: boolean) => void }) {
  const t = tokens(isDark);
  const [r, setR] = useState<DecisionTableResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  async function call(approve: boolean) {
    setBusy(approve ? "assign" : "preview"); setError(null);
    try { const out = await quoteApiPost<DecisionTableResult>("Decision table assignment", "/api/taxes/decision-table", { engineId, confirm: approve }); setR(out); if (approve) onDone?.(out.status === "READY"); }
    catch (err) { setError(toBillingErrorPanel(err, "The decision table assignment failed")); }
    finally { setBusy(null); setConfirm(false); }
  }
  const tone = !r ? "info" : r.status === "READY" ? "ok" : r.status === "PREVIEW" ? "warn" : "error";
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <GhostButton label={busy === "preview" ? "Reading…" : "Check decision table assignment"} icon="eye" isDark={isDark} disabled={!!busy} onClick={() => void call(false)} />
        {r?.status === "PREVIEW" && <PrimaryButton label="Approve assignment…" icon="link" isDark={isDark} disabled={!!busy} onClick={() => setConfirm(true)} />}
      </div>
      {busy && <LoadingRow isDark={isDark} label={busy === "assign" ? "Configuring the tax engine in Salesforce…" : "Reading the tax engine and decision tables…"} />}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {r && <Notice isDark={isDark} tone={tone}>{r.message}</Notice>}
      {r?.table && <div style={{ fontSize: 12, color: t.dim }}>Expected table {r.table.developerName} <Id v={r.table.id} /> · status {r.table.status ?? "—"} · refresh {r.table.refreshStatus ?? "—"}{r.engine ? <> · engine {r.engine.name} <Id v={r.engine.id} /> (current table <Id v={r.engine.decisionTableId} />)</> : null}</div>}
      {r && r.status === "PREVIEW" && r.plan.length > 0 && <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: t.body }}>{r.plan.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      {confirm && r?.status === "PREVIEW" && (
        <Modal isDark={isDark} title="Assign the decision table to this tax engine?" tone="warn" actions={<>
          <GhostButton label="Not now" isDark={isDark} onClick={() => setConfirm(false)} />
          <PrimaryButton label="Approve" icon="check" isDark={isDark} disabled={!!busy} onClick={() => void call(true)} />
        </>}>
          <div style={{ fontSize: 12.5, display: "grid", gap: 6 }}>
            <div>Only <b>{r.engine?.name}</b> ({r.engine?.id}) is changed — every treatment on this engine then uses {r.table?.developerName}. Other engines keep their tables.</div>
            <div style={{ opacity: 0.8 }}>This approval covers only the steps listed.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function InvoiceTaxRecalcStep({ isDark, invoiceId, onDone }: { isDark: boolean; invoiceId: string; onDone?: () => void }) {
  const t = tokens(isDark);
  const [r, setR] = useState<RecalcResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  async function call(token: string | null) {
    setBusy(token ? "recalculate" : "preview"); setError(null);
    try { const out = await quoteApiPost<RecalcResult & { success: true }>("Invoice tax recalculation", `/api/taxes/invoices/${invoiceId}/recalculate`, token ? { confirm: token } : {}); setR(out); if (out.mode === "recalculate") onDone?.(); }
    catch (err) { setError(toBillingErrorPanel(err, "The invoice tax recalculation failed")); }
    finally { setBusy(null); setConfirm(false); }
  }
  const notice = r ? recalcNotice(r) : null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <GhostButton label={busy === "preview" ? "Reading…" : "Check tax recalculation"} icon="eye" isDark={isDark} disabled={!!busy} onClick={() => void call(null)} />
        {r?.mode === "preview" && r.eligible && <PrimaryButton label="Approve recalculation…" icon="refresh" isDark={isDark} disabled={!!busy} onClick={() => setConfirm(true)} />}
      </div>
      {busy && <LoadingRow isDark={isDark} label={busy === "recalculate" ? "Salesforce is recalculating the invoice tax…" : "Reading the invoice and its decision tables…"} />}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {notice && <Notice isDark={isDark} tone={notice.tone}>{notice.text}</Notice>}
      {r?.mode === "preview" && r.staleTables.map(s => (
        <div key={s.tableId} style={{ display: "grid", gap: 6, fontSize: 12, color: t.dim }}>
          <span>Decision table {s.table} <Id v={s.tableId} /> (engine {s.engine}) — rates changed after its last refresh ({s.refreshedAt ?? "never"}): {s.ratesChangedAfter.join(", ")}</span>
          <RefreshStep isDark={isDark} engineId={s.engineId} onDone={() => void call(null)} />
        </div>
      ))}
      {confirm && r?.mode === "preview" && r.confirmation && (
        <Modal isDark={isDark} title="Recalculate this Draft invoice's tax in Salesforce?" tone="warn" actions={<>
          <GhostButton label="Not now" isDark={isDark} onClick={() => setConfirm(false)} />
          <PrimaryButton label="Approve recalculation" icon="check" isDark={isDark} disabled={!!busy} onClick={() => void call(r.confirmation)} />
        </>}>
          <div style={{ fontSize: 12.5, display: "grid", gap: 6 }}>
            <div>Salesforce re-runs its estimated-tax calculation on this Draft invoice. The result counts only if InvoiceLineTax records exist and the invoice&apos;s tax total equals them.</div>
            <div style={{ opacity: 0.8 }}>The invoice is not posted.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}
