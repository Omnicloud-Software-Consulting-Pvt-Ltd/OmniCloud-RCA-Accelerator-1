"use client";

import { useState } from "react";
import { tokens, inputStyle, PrimaryButton, GhostButton, ErrorPanel } from "@/components/data/quotes/shared";
import { Panel, Modal, LoadingRow } from "@/components/data/billing/billingUi";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import type { AssistantOperation, AssistantPreview, AssistantResult, OpChange, OpPreview, OpStep } from "@/lib/tax/types";
import { IssueList, Notice, Table } from "@/components/data/billing/tax/taxUi";
import { WarningsDisclosure } from "@/components/ui/Disclosure";

/**
 * Tax Configuration Assistant — preview → confirm → audit for operations on tax records (create / update / assign / lifecycle /
 * delete / show). The server resolves everything in Salesforce; this component only shows the preview, collects the user's
 * selections for ambiguous records, and sends the confirmed token back. Nothing is written without the confirmation.
 */

const OP_LABEL: Record<string, string> = { create: "Create", update: "Update", assign: "Assign", activate: "Activate", deactivate: "Deactivate", draft: "Set to Draft", "end-date": "End-date", replace: "Replace", delete: "Delete", show: "Show", configure: "Configure" };
const STATUS: Record<string, { label: string; color: string }> = {
  ready: { label: "Ready", color: "#00D4FF" }, exists: { label: "Already exists", color: "#00C875" }, "needs-selection": { label: "Choose a record", color: "#F5A623" },
  blocked: { label: "Blocked", color: "#E2445C" }, "no-change": { label: "No change", color: "#8899AA" }, info: { label: "Info", color: "#8899AA" },
};
const RESULT_COLOR: Record<string, string> = { success: "#00C875", failed: "#E2445C", "verification-failed": "#E2445C", "not-run": "#8899AA" };

const Tag = ({ text, color }: { text: string; color: string }) => <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", color, whiteSpace: "nowrap" }}>{text}</span>;

function OperationCard({ isDark, p, selections, onSelect, onOffer }: { isDark: boolean; p: OpPreview; selections: Record<string, string>; onSelect: (k: string, v: string) => void; onOffer: (op: AssistantOperation) => void }) {
  const t = tokens(isDark);
  const st = STATUS[p.status] ?? STATUS.info;
  const changes = p.steps.flatMap((s): { s: OpStep; c: OpChange | null }[] => s.changes.length ? s.changes.map(c => ({ s, c })) : [{ s, c: null }]);
  const warnings = p.issues.filter(i => i.severity === "warning");
  return (
    <Panel isDark={isDark} title={`${OP_LABEL[p.op] ?? p.op} · ${p.objectLabel}${p.record ? ` · ${p.record.name}` : ""}`} icon={p.op === "delete" ? "trash" : p.op === "show" ? "eye" : "edit"} right={<Tag text={st.label} color={st.color} />}>
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 6, fontSize: 12.5, color: t.body }}>
          <div><b>Operation:</b> {OP_LABEL[p.op] ?? p.op}</div>
          <div><b>Salesforce object:</b> {p.object}</div>
          <div><b>Record:</b> {p.record ? <>{p.record.name}{p.record.id ? <code style={{ fontSize: 11, marginLeft: 4 }}>{p.record.id}</code> : " (new)"}{p.record.status ? ` · ${p.record.status}` : ""}</> : "—"}</div>
          {p.relationship && <div><b>Relationship:</b> {p.relationship.updatedObject}.{p.relationship.field} ({p.relationship.fieldLabel}) — {p.relationship.sourceRecord} → {p.relationship.targetRecord}</div>}
          <div><b>Validation:</b> {p.issues.some(i => i.severity === "error") ? "failed" : p.status === "needs-selection" ? "waiting for your choice" : "passed"}</div>
          <div><b>Dependencies:</b> {p.dependencies.length ? p.dependencies.map(d => d.detail).join("; ") : p.op === "delete" ? "none found" : p.issues.some(i => i.severity === "error") || p.status === "needs-selection" ? "—" : "Passed"}</div>
          {p.lifecycle && <div><b>Current status:</b> {p.lifecycle.current ?? "—"}</div>}
          {p.lifecycle && <div><b>Lifecycle changes:</b> {p.lifecycle.changes.length ? p.lifecycle.changes.join("; ") : "None required"}</div>}
          <div><b>Warnings:</b> {warnings.length || "none"}</div>
        </div>
        {p.choices?.map(c => (
          <label key={c.selectionKey} style={{ display: "grid", gap: 4, fontSize: 12.5, color: t.body }}>
            <b>{c.prompt}</b>
            <select value={selections[c.selectionKey] ?? ""} onChange={e => onSelect(c.selectionKey, e.target.value)} style={{ ...inputStyle(t), fontSize: 12.5 }}>
              <option value="">— select —</option>
              {c.options.map(o => <option key={o.id} value={o.id}>{o.name}{o.detail ? ` — ${o.detail}` : ""} ({o.id})</option>)}
            </select>
          </label>
        ))}
        {!!changes.length && (
          <Table isDark={isDark} head={["Step", "Object", "Record", "Field", "Current value", "New value"]} empty=""
            rows={changes.map(({ s, c }) => [s.kind === "replace-rate" ? "Replace rate" : s.kind[0].toUpperCase() + s.kind.slice(1), s.object, s.recordName,
              c ? <span title={c.field}>{c.label}</span> : "—", c ? (c.currentDisplay ?? "—") : s.kind === "delete" ? "exists" : "—", c ? <b>{c.nextDisplay ?? "(empty)"}</b> : s.kind === "delete" ? <b style={{ color: "#E2445C" }}>deleted</b> : "—"])} />
        )}
        {p.view && (
          <div style={{ display: "grid", gap: 8 }}>
            <Table isDark={isDark} head={["Field", "Value"]} empty="No values." rows={p.view.fields.map(f => [f.label, f.value])} />
            {p.view.related.map(r => <div key={r.label} style={{ fontSize: 12.5, color: t.body }}><b>{r.label} ({r.rows.length}):</b> {r.rows.length ? <ul style={{ margin: "4px 0 0 18px" }}>{r.rows.map(x => <li key={x}>{x}</li>)}</ul> : <span style={{ color: t.dim }}>none</span>}</div>)}
          </div>
        )}
        <IssueList isDark={isDark} issues={p.issues} />
        {!!p.offers?.length && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{p.offers.map(o => <GhostButton key={o.label} label={o.label} icon="arrow-right" isDark={isDark} onClick={() => onOffer(o.operation)} />)}</div>}
      </div>
    </Panel>
  );
}

export function AuditTrail({ isDark, result }: { isDark: boolean; result: AssistantResult }) {
  return (
    <Panel isDark={isDark} title="Audit trail" icon="check-circle" right={<Tag text={result.success ? "Verified" : "Not completed"} color={result.success ? "#00C875" : "#E2445C"} />}>
      <div style={{ display: "grid", gap: 8 }}>
        <Notice isDark={isDark} tone={result.success ? "ok" : "error"}>{result.message}</Notice>
        {result.failure && <Notice isDark={isDark} tone="error"><b>Salesforce error{result.failure.code ? ` (${result.failure.code})` : ""}{result.failure.field ? ` on ${result.failure.object}.${result.failure.field}` : ""}:</b> {result.failure.message} <span style={{ opacity: 0.85 }}>{result.failure.recommendation}</span></Notice>}
        <Table isDark={isDark} head={["Operation", "Object", "Record", "Salesforce ID", "Fields changed", "Previous", "New", "Timestamp", "Salesforce result"]} empty="Nothing was run."
          rows={result.audit.map(a => [a.operation, a.object, a.recordName, a.recordId ? <code style={{ fontSize: 11 }}>{a.recordId}</code> : "—",
            a.fields.map(f => f.label).join(", ") || "—", a.fields.map(f => f.before ?? "∅").join(", ") || "—", a.fields.map(f => f.after ?? "∅").join(", ") || "—",
            new Date(a.timestamp).toLocaleString(), <span key="r"><Tag text={a.result} color={RESULT_COLOR[a.result] ?? "#888"} /> <span style={{ fontSize: 11.5 }}>{a.message}</span></span>])} />
      </div>
    </Panel>
  );
}

export default function TaxAssistant({ isDark, operations: initialOps, preview: initialPreview, warnings, onDone }: { isDark: boolean; operations: AssistantOperation[]; preview: AssistantPreview; warnings: string[]; onDone: (result?: AssistantResult) => void }) {
  const t = tokens(isDark);
  const notify = useSalesforceSuccess();
  const [operations, setOperations] = useState(initialOps);
  const [preview, setPreview] = useState(initialPreview);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<AssistantResult | null>(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);

  async function refresh(ops: AssistantOperation[], sel: Record<string, string>) {
    setBusy("Resolving in Salesforce…"); setError(null);
    try { setPreview(await quoteApiPost<AssistantPreview>("Preview tax operations", "/api/taxes/assistant/preview", { operations: ops, selections: sel })); }
    catch (err) { setError(toBillingErrorPanel(err, "The preview failed")); }
    finally { setBusy(null); }
  }
  async function execute() {
    setBusy("Applying in Salesforce and verifying…"); setError(null);
    try {
      const r = await quoteApiPost<AssistantResult>("Apply tax operations", "/api/taxes/assistant/execute", { operations, selections, token: preview.token, confirm: true });
      setResult(r); setPreview(r.preview);
      const done = r.audit.filter(a => a.result === "success" && a.recordId && a.operation !== "DELETE");
      if (done.length) notify({ title: "Tax Configuration Updated", message: r.message, records: done.map(a => ({ objectApiName: a.object, recordId: a.recordId!, recordName: a.recordName, salesforceUrl: "" })) });
      onDone(r);
    } catch (err) { setError(toBillingErrorPanel(err, "The change wasn't applied")); }
    finally { setBusy(null); setConfirm(false); }
  }
  const select = (k: string, v: string) => { const next = { ...selections, [k]: v }; if (!v) delete next[k]; setSelections(next); void refresh(operations, next); };
  const offer = (op: AssistantOperation) => { setOperations([op]); setSelections({}); setResult(null); void refresh([op], {}); };
  const steps = preview.operations.flatMap(p => p.steps);
  const hasDelete = steps.some(s => s.kind === "delete");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <WarningsDisclosure isDark={isDark} warnings={warnings} />
      {preview.operations.map(p => <OperationCard key={p.key} isDark={isDark} p={p} selections={selections} onSelect={select} onOffer={offer} />)}
      {steps.length > 0 && !result?.success && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <PrimaryButton label={busy ?? "Apply in Salesforce"} icon="upload" isDark={isDark} disabled={!preview.ok || !!busy} onClick={() => setConfirm(true)} />
          {!preview.ok && <span style={{ fontSize: 12, color: "#E2445C" }}>{preview.needsSelection ? "Choose the records above first." : "Resolve the blocked items above first — nothing is changed while any item is blocked."}</span>}
        </div>
      )}
      {busy && <LoadingRow isDark={isDark} label={busy} />}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {result && <AuditTrail isDark={isDark} result={result} />}
      {confirm && (
        <Modal isDark={isDark} title={hasDelete ? "Delete in Salesforce?" : "Apply these changes in Salesforce?"} tone={hasDelete ? "warn" : "accent"} actions={<>
          <GhostButton label="Back" isDark={isDark} onClick={() => setConfirm(false)} />
          <PrimaryButton label={busy ? "Working…" : "Confirm"} icon="check" isDark={isDark} disabled={!!busy} onClick={() => void execute()} />
        </>}>
          <div style={{ fontSize: 12.5, color: t.body, display: "grid", gap: 6 }}>
            <div>Org: <b>{preview.connection.orgName}</b> ({preview.connection.orgId}) · user <b>{preview.connection.username}</b>.</div>
            {steps.map(s => <div key={s.id}>• {s.detail}</div>)}
            {preview.operations.flatMap(p => p.dependencies.filter(d => d.cascade)).map(d => <div key={d.label} style={{ color: "#E2445C" }}>⚠ {d.detail}</div>)}
            {preview.operations.flatMap(p => p.issues.filter(i => i.severity === "warning")).map(w => <div key={w.message} style={{ color: "#F5A623" }}>⚠ {w.message}</div>)}
            <div style={{ color: t.dim }}>Steps run in this order as separate Salesforce requests and stop at the first error; every changed record is re-read afterwards.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}
