"use client";

import { useEffect, useState } from "react";
import { tokens, inputStyle, PrimaryButton, GhostButton, ErrorPanel } from "@/components/data/quotes/shared";
import { Panel, Modal, LoadingRow } from "@/components/data/billing/billingUi";
import { quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import { Notice, Table } from "@/components/data/billing/tax/taxUi";
import type { ApprovalGroup, ProposedRecord, RemediationOutcome, ResolutionInput, ResolutionOption, TaxDiagnosticItem } from "@/lib/tax/server/remediation";

/**
 * Taxes → Calculation: every diagnostic of the plan with its own resolution controls, in dependency order. "Resolve this issue" asks the
 * server for the itemized proposal of the next approval group (with Salesforce's field-level preview); "Approve & run" sends the
 * approval token bound to that exact proposal. The server revalidates, writes, re-reads Salesforce and re-plans — a card disappears only
 * when the fresh plan no longer has the issue. Inputs (business facts) go into the same plan context, so nothing is re-entered.
 */

const SEV_COLOR: Record<TaxDiagnosticItem["severity"], string> = { blocker: "#E2445C", error: "#E2445C", warning: "#F5A623", info: "#8899AA" };
const STAGE: Record<number, string> = { 1: "Transaction", 2: "Product · account · jurisdiction", 3: "Policy & treatment", 4: "Items & tax code", 5: "Tax rates", 6: "Engine & decision table", 7: "Billing pipeline", 8: "Result verification" };
const KIND: Record<ResolutionOption["kind"], string> = { reuse: "Reuse", link: "Link existing", update: "Update", create: "Create", activate: "Activate", refresh: "Refresh", "end-date": "End-date", ask: "Your decision", unsupported: "Not automatic" };
const GROUP_LABEL: Record<ApprovalGroup, string> = { config: "configuration changes", link: "relationship change", activation: "activation", refresh: "decision-table refresh", permission: "permission assignment" };
const Id = ({ v }: { v: string | null | undefined }) => (v ? <code style={{ fontSize: 11 }}>{v}</code> : <>new</>);

export type InputValues = Record<string, string>;
type Preview = Extract<RemediationOutcome, { mode: "preview" }>;
type Executed = Extract<RemediationOutcome, { mode: "executed" }>;
type Stale = Extract<RemediationOutcome, { mode: "stale" }>;

function InputField({ isDark, input, value, onChange }: { isDark: boolean; input: ResolutionInput; value: string; onChange: (v: string) => void }) {
  const t = tokens(isDark);
  const style = { ...inputStyle(t), padding: "7px 10px" };
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 12.5, color: t.body }}>
      <span>{input.question}</span>
      {input.options?.length
        ? <select aria-label={input.question} value={value} onChange={e => onChange(e.target.value)} style={style}><option value="">— choose —</option>{input.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        : <input aria-label={input.question} value={value} onChange={e => onChange(e.target.value)} style={style} />}
    </label>
  );
}

export interface RemediationReport { title: string; tone: "ok" | "error" | "warn"; text: string; records: { op: string; object: string; id: string | null; result: string }[] }

const ACTION_LABEL: Record<ProposedRecord["action"], string> = { create: "CREATE", update: "UPDATE", link: "LINK", reuse: "REUSE", activate: "ACTIVATE", refresh: "REFRESH" };
/** Record-by-record preview of an option — shown before any approval; missing values are marked REQUIRED (never invented). */
export function ProposalTable({ isDark, proposal }: { isDark: boolean; proposal: ProposedRecord[] }) {
  const t = tokens(isDark);
  const missing = proposal.flatMap(r => r.fields.filter(f => f.required).map(f => `${r.object}.${f.field}`));
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 12, color: t.heading }}><b>Proposed configuration</b> {missing.length ? <span style={{ color: "#E2445C" }}>· {missing.length} required value(s) missing — supply them below</span> : <span style={{ color: "#00C875" }}>· complete</span>}</div>
      {proposal.map((r, i) => (
        <div key={`${r.object}:${i}`} style={{ border: `1px solid ${t.border}`, borderRadius: 8, padding: "6px 8px", opacity: r.when === "next approval" ? 0.75 : 1 }}>
          <div style={{ fontSize: 12.5 }}><b style={{ color: r.action === "reuse" ? "#00C875" : t.accent }}>{ACTION_LABEL[r.action]}</b> {r.object} “{r.name}”{r.recordId ? <> <Id v={r.recordId} /></> : null} <span style={{ fontSize: 11, color: t.dim }}>· {r.when === "this approval" ? "in this proposal" : "next, separately approved"}</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 200px) 1fr", gap: "2px 10px", fontSize: 12, marginTop: 4 }}>
            {r.fields.flatMap(f => [
              <span key={`k${f.field}`} style={{ color: t.dim }}>{f.field}</span>,
              <span key={`v${f.field}`}>{f.required ? <b style={{ color: "#E2445C" }}>REQUIRED — not supplied</b> : <b>{f.value}</b>}{!f.required && f.source ? <span style={{ color: t.dim }}> · {f.source}</span> : null}</span>,
            ])}
          </div>
        </div>
      ))}
    </div>
  );
}

function DiagnosticCard({ isDark, d, rank, waitingFor, context, values, setValue, onApplyInputs, onChanged, report, onRunPrompt }: {
  isDark: boolean; d: TaxDiagnosticItem; rank: number; waitingFor: TaxDiagnosticItem[]; context: Record<string, unknown>;
  values: InputValues; setValue: (field: string, v: string) => void; onApplyInputs: () => void; onChanged: () => void; report: (r: RemediationReport) => void; onRunPrompt?: (prompt: string) => void;
}) {
  const t = tokens(isDark);
  const [optionId, setOptionId] = useState<string | null>(d.recommendedOptionId ?? d.options[0]?.id ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState<Preview | null>(null);
  const [outcome, setOutcome] = useState<Executed | Stale | null>(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const o = d.options.find(x => x.id === optionId) ?? null;
  const blocked = waitingFor.length > 0;

  async function call(body: Record<string, unknown>, label: string) {
    setBusy(label); setError(null);
    try { return await quoteApiPost<RemediationOutcome & { success: true }>("Tax remediation", "/api/taxes/calculation/remediate", { ...context, diagnosticId: d.id, optionId: o!.id, ...body }); }
    catch (err) { setError(toBillingErrorPanel(err, "The resolution step failed")); return null; }
    finally { setBusy(null); }
  }
  async function resolve() {
    if (!o) return;
    if (o.prompt && onRunPrompt && !o.steps.length && !o.inputs?.length) { onRunPrompt(o.prompt); return; }
    if (o.kind === "ask" || (o.inputs?.length && !o.steps.length)) { onApplyInputs(); return; }
    setOutcome(null);
    const r = await call({}, "preview");
    if (!r) return;
    if (r.mode === "preview") setReview(r);
    else if (r.mode === "stale") { report({ title: d.title, tone: "warn", text: r.message, records: [] }); onChanged(); }
  }
  async function approve() {
    if (!review?.approvalToken) return;
    const r = await call({ group: review.group, approvalToken: review.approvalToken }, "execute");
    setReview(null);
    if (!r) return;
    if (r.mode === "executed") report({ title: d.title, tone: r.resolved || r.verified ? "ok" : "error", text: `${r.message}${r.failure?.permission ? " Ask your Salesforce administrator for the permission; the change is not retried." : ""}`, records: r.result?.audit.map(a => ({ op: a.operation, object: a.object, id: a.recordId, result: a.result })) ?? [] });
    else if (r.mode === "stale") report({ title: d.title, tone: "warn", text: r.message, records: [] });
    setOutcome(r.mode === "executed" || r.mode === "stale" ? r : null);
    onChanged();
  }

  return (
    <div style={{ border: `1px solid ${SEV_COLOR[d.severity]}55`, borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13.5, color: t.heading }}><b>{rank}. {d.title}</b>{d.record ? <span style={{ fontSize: 11.5, color: t.dim }}> · {d.object} {d.record.name} <Id v={d.record.id} /></span> : null}</div>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: SEV_COLOR[d.severity], textTransform: "uppercase" }}>{d.severity} · {STAGE[d.stage]}</span>
      </div>
      <div style={{ fontSize: 12.5, color: t.body }}>{d.cause}</div>
      <div style={{ fontSize: 12, color: t.dim }}>{d.blocksCalculation ? "Blocks the calculation: Salesforce can't produce a correct InvoiceLineTax until this is resolved." : "Doesn't block the calculation; it affects confidence in the result."} <span style={{ opacity: 0.8 }}>Code {d.code}</span></div>
      {d.evidence.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowEvidence(v => !v)} style={{ fontSize: 11.5, background: "none", border: "none", color: t.accent, cursor: "pointer", padding: 0 }}>{showEvidence ? "Hide" : "Show"} Salesforce evidence ({d.evidence.length})</button>
          {showEvidence && <ul style={{ margin: "4px 0 0 18px", fontSize: 12 }}>{d.evidence.map(e => <li key={e}>{e}</li>)}</ul>}
        </div>
      )}
      {blocked && <Notice isDark={isDark} tone="info">Resolve first: {waitingFor.map(w => w.title).join("; ")} — this issue&apos;s fix depends on it.</Notice>}
      {d.options.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 12, color: t.dim }}><b>Recommended:</b> {d.recommendation}</div>
          {d.options.map(x => (
            <label key={x.id} style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: 6, fontSize: 12.5, color: x.supported ? t.body : t.dim, border: `1px solid ${x.id === optionId ? t.accent : t.border}`, borderRadius: 8, padding: "6px 8px" }}>
              <input type="radio" name={`opt-${d.id}`} checked={x.id === optionId} onChange={() => setOptionId(x.id)} aria-label={x.label} />
              <span>
                <b>{x.label}</b> <span style={{ fontSize: 10.5, fontWeight: 800, color: x.supported ? t.accent : t.dim, textTransform: "uppercase" }}>{KIND[x.kind]}{x.id === d.recommendedOptionId ? " · recommended" : ""}</span>
                <div style={{ fontSize: 12, marginTop: 2 }}>{x.supported ? x.rationale : x.unsupportedReason ?? x.rationale}</div>
                {x.records.length > 0 && <div style={{ fontSize: 11.5, marginTop: 2, color: t.dim }}>{x.records.map(r => `${r.role} ${r.object} "${r.name}"${r.id ? ` (${r.id})` : ""}`).join(" · ")}</div>}
                {x.steps.length > 0 && <div style={{ fontSize: 11.5, marginTop: 2, color: t.dim }}>Steps: {x.steps.map(s => `${s.title} [${GROUP_LABEL[s.group]}]`).join(" → ")}</div>}
                {x.consequences?.map(c => <div key={c} style={{ fontSize: 11.5, color: "#F5A623" }}>⚠ {c}</div>)}
              </span>
            </label>
          ))}
        </div>
      )}
      {o?.proposal?.length ? <ProposalTable isDark={isDark} proposal={o.proposal} /> : null}
      {o?.inputs?.length ? <div style={{ fontSize: 12, color: t.heading, fontWeight: 700 }}>Edit proposed values</div> : null}
      {o?.inputs?.length ? (
        <div style={{ display: "grid", gap: 6 }}>
          {o.inputs.map(i => <InputField key={i.field} isDark={isDark} input={i} value={values[i.field] ?? ""} onChange={v => setValue(i.field, v)} />)}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {o?.prompt && onRunPrompt && <GhostButton label="Run the next step here" icon="arrow-right" isDark={isDark} disabled={!!busy} onClick={() => onRunPrompt(o.prompt!)} />}
        {o?.prompt && <span style={{ fontSize: 11.5, color: t.dim }}>“{o.prompt}”</span>}
        {o && o.supported && (o.steps.length > 0 || o.inputs?.length || (o.kind === "ask" && !o.prompt))
          ? <PrimaryButton label={busy === "preview" ? "Preparing the proposal…" : o.kind === "ask" || !o.steps.length ? "Apply answer & re-check" : "Resolve this issue"} icon="check" isDark={isDark} disabled={!!busy || (blocked && o.kind !== "ask")} onClick={() => void resolve()} />
          : o && !o.supported ? <span style={{ fontSize: 12, color: t.dim }}>No automatic action: {o.unsupportedReason ?? o.rationale}</span>
          : !d.options.length ? <span style={{ fontSize: 12, color: t.dim }}>Informational — nothing to change.</span> : null}
      </div>
      {busy === "execute" && <LoadingRow isDark={isDark} label="Writing to Salesforce, re-reading it and re-checking the plan…" />}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {outcome && (outcome.mode === "executed"
        ? <Notice isDark={isDark} tone={outcome.resolved || outcome.verified ? "ok" : "error"}>{outcome.message}{outcome.failure?.permission ? " Ask your Salesforce administrator for the permission; the change is not retried." : ""}</Notice>
        : <Notice isDark={isDark} tone="warn">{outcome.message}</Notice>)}
      {review && (
        <Modal isDark={isDark} title={`Approve the ${GROUP_LABEL[review.group]}?`} tone={review.group === "activation" || review.group === "link" || review.group === "refresh" ? "warn" : "accent"} actions={<>
          <GhostButton label="Cancel" isDark={isDark} onClick={() => setReview(null)} />
          <PrimaryButton label={busy ? "Working…" : review.executable ? "Approve & run" : "Can't run"} icon="check" isDark={isDark} disabled={!!busy || !review.executable} onClick={() => void approve()} />
        </>}>
          <div style={{ fontSize: 12.5, display: "grid", gap: 6 }}>
            <div><b>{d.title}</b> — {review.option.label}</div>
            <div style={{ color: t.dim }}>Plan version {review.planVersion} · this approval covers exactly these {review.steps.length} step(s); {review.remainingGroups.length > 1 ? `the ${review.remainingGroups.filter(g => g !== review.group).map(g => GROUP_LABEL[g]).join(" and ")} will ask for its own approval.` : "nothing else."}</div>
            {review.steps.map(s => <div key={s.id}>• {s.title} {s.recordId ? <Id v={s.recordId} /> : null}</div>)}
            <Table isDark={isDark} head={["Step", "Object", "Field", "Proposed value"]} empty="" rows={review.steps.flatMap(s => s.changes.filter(c => c.field).map(c => [s.title, s.object, c.field, <b key="v">{c.value}</b>]))} />
            {review.preview && review.preview.operations.some(p => p.steps.some(st => st.changes.length)) && <Table isDark={isDark} head={["Object", "Record", "Field", "Current (Salesforce)", "New"]} empty="" rows={review.preview.operations.flatMap(p => p.steps.flatMap(st => st.changes.map(c => [st.object, st.recordName, c.label, c.currentDisplay ?? "—", <b key="n">{c.nextDisplay ?? "(empty)"}</b>])))} />}
            {review.blockers.map(b => <div key={b} style={{ color: "#E2445C" }}>✗ {b}</div>)}
            {review.option.consequences?.map(c => <div key={c} style={{ color: "#F5A623" }}>⚠ {c}</div>)}
            <div style={{ color: t.dim }}>Salesforce is re-read after the write; the issue is marked resolved only if the re-checked plan no longer shows it.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Every diagnostic of the plan, ranked (dependency, stage, severity), each with its own controls. */
/** `context` is the request context sent with every call ({ plan } for a product plan, { order } for an existing order) — the server
 *  rebuilds the diagnostics from it; it never trusts client-held diagnostics. */
export default function RemediationPanel({ isDark, diagnostics, version, context, values, setValue, onApplyInputs, onChanged, onRunPrompt }: {
  isDark: boolean; diagnostics: TaxDiagnosticItem[]; version: string; context: Record<string, unknown>; values: InputValues; setValue: (field: string, v: string) => void; onApplyInputs: () => void; onChanged: () => void; onRunPrompt?: (prompt: string) => void;
}) {
  const t = tokens(isDark);
  const [reports, setReports] = useState<RemediationReport[]>([]);
  const report = (r: RemediationReport) => setReports(x => [r, ...x].slice(0, 10));
  const list = diagnostics ?? [];
  if (!list.length && !reports.length) return null;
  const blockers = list.filter(d => d.blocksCalculation).length;
  return (
    <Panel isDark={isDark} title={`Issues & fixes — ${blockers} blocking, ${list.length - blockers} other`} icon="tool">
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ fontSize: 11.5, color: t.dim }}>Ranked by dependency and severity. Each fix reuses or links existing Salesforce records before creating anything, shows the exact changes, and needs your approval; activations, relationship changes and refreshes are approved separately.</div>
        {reports.map((r, i) => (
          <Notice key={`${i}:${r.title}`} isDark={isDark} tone={r.tone}><b>{r.title}:</b> {r.text}{r.records.length ? ` Salesforce records: ${r.records.map(x => `${x.op} ${x.object}${x.id ? ` ${x.id}` : ""} (${x.result})`).join("; ")}.` : ""}</Notice>
        ))}
        {!list.length && <Notice isDark={isDark} tone="ok">No open issues in the re-checked plan.</Notice>}
        {list.map((d, i) => (
          <DiagnosticCard key={`${d.id}:${version}`} isDark={isDark} d={d} rank={i + 1} waitingFor={list.filter(x => d.dependsOn.includes(x.id))} context={context} onRunPrompt={onRunPrompt}
            values={values} setValue={setValue} onApplyInputs={onApplyInputs} onChanged={onChanged} report={report} />
        ))}
      </div>
    </Panel>
  );
}

/** An existing order's diagnostics (Taxes → Calculation, order answers): loaded and re-checked from Salesforce through the same route. */
export function OrderRemediation({ isDark, orderId, onRunPrompt }: { isDark: boolean; orderId: string; onRunPrompt?: (prompt: string) => void }) {
  const [address, setAddress] = useState<Record<string, string>>({});
  const [data, setData] = useState<{ diagnostics: TaxDiagnosticItem[]; version: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const ctx = (a: Record<string, string> = address) => ({ order: { orderId, address: { country: a.addressCountry || null, state: a.addressState || null, city: a.addressCity || null, street: a.addressStreet || null, postalCode: a.addressPostalCode || null } } });
  async function load(a?: Record<string, string>) {
    setBusy(true); setError(null);
    try { const r = await quoteApiPost<{ success: true; diagnostics: TaxDiagnosticItem[]; version: string }>("Order diagnostics", "/api/taxes/calculation/remediate", { ...ctx(a), mode: "diagnose" }); setData({ diagnostics: r.diagnostics, version: r.version }); }
    catch (err) { setError(toBillingErrorPanel(err, "The order couldn't be diagnosed")); }
    finally { setBusy(false); }
  }
  // Initial read (deferred one tick so the effect itself sets no state).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [orderId]);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {busy && <LoadingRow isDark={isDark} label="Diagnosing the order in Salesforce…" />}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {data && (data.diagnostics.length
        ? <RemediationPanel isDark={isDark} diagnostics={data.diagnostics} version={data.version} context={ctx()} values={address} setValue={(f, v) => setAddress(x => ({ ...x, [f]: v }))} onApplyInputs={() => void load()} onChanged={() => void load()} onRunPrompt={onRunPrompt} />
        : <Notice isDark={isDark} tone="ok">No open issues on this order — the next step is shown below (each billable step needs its own confirmation).</Notice>)}
    </div>
  );
}
