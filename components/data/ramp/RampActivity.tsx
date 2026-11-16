"use client";

import { useState } from "react";
import { tokens, GhostButton, EmptyState, Spinner, CodeBlock } from "@/components/data/quotes/shared";
import { Modal, StatusPill } from "@/components/data/billing/billingUi";
import type { HistoryEvent, RampDealDraft, RampExecution } from "@/lib/ramp/types";
import { RampHelpPanel } from "./RampAiAssist";
import { ExecutionPanel, Field, Notice, Panel, SelectIn, SfId, TextIn, useRampGet } from "./rampUi";

type ExecRow = Omit<RampExecution, "steps"> & { steps: (Omit<RampExecution["steps"][number], "calls"> & { calls: number })[]; deal: RampDealDraft | null };
const GROUPS: { id: string; label: string; match: (s: string) => boolean }[] = [
  { id: "attention", label: "Needs attention", match: s => s === "failed" || s === "interrupted" },
  { id: "active", label: "In progress", match: s => s === "in-progress" || s === "waiting" || s === "pending" },
  { id: "done", label: "Completed", match: s => s === "completed" },
];

/** Ramp Execution Center — every run in the org, grouped by status; open one to resume / retry / inspect its verification. */
export function RampExecutionCenter({ isDark, instanceUrl, initialId }: { isDark: boolean; instanceUrl: string | null; initialId?: string | null }) {
  const t = tokens(isDark);
  const list = useRampGet<{ rows: ExecRow[] }>("Load ramp executions", "/api/ramp/executions");
  const [open, setOpen] = useState<string | null>(initialId ?? null);
  const [q, setQ] = useState("");
  if (open) return (
    <Panel isDark={isDark} title="Execution" icon="activity" right={<GhostButton isDark={isDark} label="Back to all runs" onClick={() => { setOpen(null); list.reload(); }} />}>
      <ExecutionPanel isDark={isDark} executionId={open} instanceUrl={instanceUrl} onChanged={list.reload} />
    </Panel>
  );
  const rows = (list.data?.rows ?? []).filter(r => !q || `${r.deal?.name ?? ""} ${r.sf.quoteId ?? ""} ${r.id}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <RampHelpPanel isDark={isDark} helpKey="executions" />
      <Notice isDark={isDark} tone="info">Runs execute <b>server-side, one checkpointed step per request</b>. A run that stopped (closed tab, timeout, server restart) shows as interrupted — Resume re-reads Salesforce before any write, so completed writes are never repeated.</Notice>
      <input aria-label="Search executions" placeholder="Search by deal, quote Id or run Id…" value={q} onChange={e => setQ(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.inputBg, color: t.heading, fontSize: 12.5, maxWidth: 420 }} />
      {list.loading ? <div style={{ display: "flex", gap: 6, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={12} /> Loading…</div>
        : list.error ? <Notice isDark={isDark} tone="error">{list.error}</Notice>
        : !rows.length ? <EmptyState isDark={isDark} icon="activity" title="No executions" hint="Executions appear when a ramp deal or group ramp is executed." />
        : GROUPS.map(g => { const gr = rows.filter(r => g.match(r.status)); return gr.length ? (
          <Panel key={g.id} isDark={isDark} title={`${g.label} (${gr.length})`} icon="activity">
            <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 700 }}>
              <thead><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>{["Deal", "Kind", "Quote", "Status", "Step", "Verification", "Updated", ""].map(h => <th key={h} style={{ padding: 6 }}>{h}</th>)}</tr></thead>
              <tbody>{gr.map(r => { const step = r.steps.find(s => s.status !== "completed" && s.status !== "skipped"); return (
                <tr key={r.id} style={{ borderTop: `1px solid ${t.border}` }}>
                  <td style={{ padding: 6 }}><b style={{ color: t.heading }}>{r.deal?.name ?? r.dealId}</b></td><td style={{ padding: 6 }}>{r.kind}</td>
                  <td style={{ padding: 6 }}><SfId isDark={isDark} id={r.sf.quoteId} instanceUrl={instanceUrl} /></td>
                  <td style={{ padding: 6 }}><StatusPill status={r.status} isDark={isDark} /></td>
                  <td style={{ padding: 6 }}>{step ? `${step.label}${step.message ? ` — ${step.message.slice(0, 80)}` : ""}` : "—"}</td>
                  <td style={{ padding: 6 }}>{r.verification.length ? `${r.verification.filter(c => c.passed).length}/${r.verification.length}` : "—"}</td>
                  <td style={{ padding: 6, color: t.dim }}>{r.updatedAt.slice(0, 16).replace("T", " ")}</td>
                  <td style={{ padding: 6 }}><GhostButton isDark={isDark} label="Open" onClick={() => setOpen(r.id)} /></td>
                </tr>); })}</tbody>
            </table></div>
          </Panel>) : null; })}
    </div>
  );
}

/** Ramp History — the org's persistent RAMP audit trail (server-side store), filterable + paginated, with full event detail. */
export function RampHistory({ isDark, instanceUrl }: { isDark: boolean; instanceUrl: string | null }) {
  const t = tokens(isDark);
  const [f, setF] = useState({ q: "", kind: "", status: "", from: "", to: "", salesforceId: "" });
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ page: String(page), pageSize: "25", ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }).toString();
  const list = useRampGet<{ rows: HistoryEvent[]; total: number; page: number; pageCount: number }>("Load RAMP history", `/api/ramp/history?${params}`);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = useRampGet<{ event: HistoryEvent | null }>("Read history event", detailId ? `/api/ramp/history?id=${encodeURIComponent(detailId)}` : null);
  const setFilter = (p: Partial<typeof f>) => { setF({ ...f, ...p }); setPage(1); };
  const tone = (s: string) => (s === "success" ? "#00C875" : s === "failed" ? t.error : t.dim);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <RampHelpPanel isDark={isDark} helpKey="history" />
      <Panel isDark={isDark} title={`RAMP history${list.data ? ` (${list.data.total})` : ""}`} icon="clock">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Field isDark={isDark} label="Search"><TextIn isDark={isDark} ariaLabel="Search history" value={f.q} onChange={v => setFilter({ q: v })} placeholder="Summary, action, Id…" /></Field>
          <Field isDark={isDark} label="Type" width={150}><SelectIn isDark={isDark} ariaLabel="History type" value={f.kind} placeholder="All" onChange={v => setFilter({ kind: v })} options={["product-segment", "schedule", "deal", "group-deal", "execution", "pricing", "verification"].map(v => ({ value: v, label: v }))} /></Field>
          <Field isDark={isDark} label="Result" width={120}><SelectIn isDark={isDark} ariaLabel="History result" value={f.status} placeholder="All" onChange={v => setFilter({ status: v })} options={["success", "failed", "info"].map(v => ({ value: v, label: v }))} /></Field>
          <Field isDark={isDark} label="From" width={140}><TextIn isDark={isDark} type="date" ariaLabel="From date" value={f.from} onChange={v => setFilter({ from: v })} /></Field>
          <Field isDark={isDark} label="To" width={140}><TextIn isDark={isDark} type="date" ariaLabel="To date" value={f.to} onChange={v => setFilter({ to: v })} /></Field>
          <Field isDark={isDark} label="Salesforce Id" width={170}><TextIn isDark={isDark} ariaLabel="Salesforce Id" value={f.salesforceId} onChange={v => setFilter({ salesforceId: v.trim() })} /></Field>
        </div>
        {list.loading ? <div style={{ display: "flex", gap: 6, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={12} /> Loading…</div>
          : list.error ? <Notice isDark={isDark} tone="error">{list.error}</Notice>
          : !list.data?.rows.length ? <EmptyState isDark={isDark} icon="clock" title="No history" hint="Schedule, deal, segment, execution and pricing activity is recorded here." />
          : (
            <>
              <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 700 }}>
                <thead><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>{["When", "Type", "Action", "Result", "Summary", ""].map(h => <th key={h} style={{ padding: 6 }}>{h}</th>)}</tr></thead>
                <tbody>{list.data.rows.map(h => (
                  <tr key={h.id} style={{ borderTop: `1px solid ${t.border}` }}>
                    <td style={{ padding: 6, color: t.dim, whiteSpace: "nowrap" }}>{h.at.slice(0, 19).replace("T", " ")}</td><td style={{ padding: 6 }}>{h.kind}</td><td style={{ padding: 6 }}>{h.action}</td>
                    <td style={{ padding: 6, fontWeight: 700, color: tone(h.status) }}>{h.status}</td><td style={{ padding: 6 }}>{h.summary}</td>
                    <td style={{ padding: 6 }}><GhostButton isDark={isDark} label="Details" onClick={() => setDetailId(h.id)} /></td>
                  </tr>))}</tbody>
              </table></div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end", fontSize: 12, color: t.dim }}>
                <GhostButton isDark={isDark} label="Prev" disabled={list.data.page <= 1} onClick={() => setPage(list.data!.page - 1)} />Page {list.data.page} / {list.data.pageCount}<GhostButton isDark={isDark} label="Next" disabled={list.data.page >= list.data.pageCount} onClick={() => setPage(list.data!.page + 1)} />
              </div>
            </>
          )}
      </Panel>
      {detailId && (
        <Modal isDark={isDark} title="History event" tone="accent" actions={<GhostButton isDark={isDark} label="Close" onClick={() => setDetailId(null)} />}>
          {detail.loading ? <Spinner isDark={isDark} size={14} /> : detail.error ? <Notice isDark={isDark} tone="error">{detail.error}</Notice> : detail.data?.event ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5 }}>
              <div><b>{detail.data.event.summary}</b></div>
              <div style={{ color: t.dim }}>{detail.data.event.at} · {detail.data.event.kind} / {detail.data.event.action} · {detail.data.event.status}</div>
              <div style={{ display: "grid", gap: 3 }}>{Object.entries(detail.data.event.refs).filter(([, v]) => v).map(([k, v]) => <div key={k}>{k}: {/^[a-zA-Z0-9]{15,18}$/.test(String(v)) ? <SfId isDark={isDark} id={String(v)} instanceUrl={instanceUrl} /> : <code>{String(v)}</code>}</div>)}</div>
              {detail.data.event.detail !== undefined && <CodeBlock isDark={isDark} label="Detail" data={detail.data.event.detail} />}
            </div>
          ) : <div>Event not found.</div>}
        </Modal>
      )}
    </div>
  );
}
