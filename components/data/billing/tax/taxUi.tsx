"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { tokens } from "@/components/data/quotes/shared";
import { Panel, Row } from "@/components/data/billing/billingUi";
import type { PlanIssue, TaxExecutionReport, TaxPlan } from "@/lib/tax/types";

/**
 * Shared Tax UI pieces. The browser's current Salesforce connection (instance + user) is only used as a refresh key so every
 * Tax read re-runs when the user switches orgs/users — the server always resolves org and user from the request's own session.
 */
const SESSION_KEY = "omnicloud_sf_session";
const subscribe = (cb: () => void) => { window.addEventListener("storage", cb); window.addEventListener("focus", cb); return () => { window.removeEventListener("storage", cb); window.removeEventListener("focus", cb); }; };
const read = () => { try { const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as { instanceUrl?: string; userId?: string; username?: string } | null; return s ? `${s.instanceUrl ?? ""}|${s.userId ?? s.username ?? ""}` : "none"; } catch { return "none"; } };
export const useConnectionKey = () => useSyncExternalStore(subscribe, read, () => "server");
export const withConnection = (path: string, key: string) => `${path}${path.includes("?") ? "&" : "?"}c=${encodeURIComponent(key)}`;

export const CATEGORY_LABEL: Record<string, string> = { permission: "Permission", "tax-engine": "Salesforce tax engine", configuration: "Configuration", salesforce: "Salesforce" };
export const money = (n: number | null | undefined, cur?: string | null) => (n === null || n === undefined ? "—" : `${cur && cur.length === 1 ? cur : cur ? `${cur} ` : ""}${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n}%`);
export const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

export function Notice({ isDark, tone, children }: { isDark: boolean; tone: "warn" | "ok" | "error" | "info"; children: ReactNode }) {
  const t = tokens(isDark);
  const c = { warn: "245,166,35", ok: "0,200,117", error: "226,68,92", info: "0,212,255" }[tone];
  return <div style={{ borderRadius: 10, padding: "8px 12px", border: `1px solid rgba(${c},0.35)`, background: `rgba(${c},0.07)`, fontSize: 12.5, color: t.body }}>{children}</div>;
}

export function Table({ isDark, head, rows, empty }: { isDark: boolean; head: string[]; rows: ReactNode[][]; empty: string }) {
  const t = tokens(isDark);
  if (!rows.length) return <div style={{ fontSize: 12.5, color: t.dim, padding: 8 }}>{empty}</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead><tr>{head.map(h => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: t.dim, fontSize: 10.5, textTransform: "uppercase", borderBottom: `1px solid ${t.border}`, whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} style={{ borderBottom: `1px solid ${t.border}` }}>{r.map((c, j) => <td key={j} style={{ padding: "6px 8px", color: t.body, verticalAlign: "top" }}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const ACTION_COLOR: Record<string, string> = { reuse: "#00C875", create: "#00D4FF", update: "#F5A623", blocked: "#E2445C", created: "#00C875", reused: "#00C875", updated: "#F5A623", failed: "#E2445C", "rolled-back": "#E2445C", "not-run": "#8899AA" };
const ACTION_LABEL: Record<string, string> = { reuse: "Existing", create: "Create", update: "Update", blocked: "Blocked", created: "Created", reused: "Existing", updated: "Updated", failed: "Failed", "rolled-back": "Rolled back", "not-run": "Not run" };
export const ActionTag = ({ action }: { action: string }) => <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", color: ACTION_COLOR[action] ?? "#888", whiteSpace: "nowrap" }}>{ACTION_LABEL[action] ?? action}</span>;
const Id = ({ id }: { id: string | null | undefined }) => (id ? <code style={{ fontSize: 11.5 }}>{id}</code> : <span>—</span>);

export function IssueList({ isDark, issues }: { isDark: boolean; issues: PlanIssue[] }) {
  if (!issues.length) return null;
  const order = { error: 0, warning: 1, info: 2 };
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {[...issues].sort((a, b) => order[a.severity] - order[b.severity]).map((i, n) => (
        <Notice key={`${i.code}-${n}`} isDark={isDark} tone={i.severity === "error" ? "error" : i.severity === "warning" ? "warn" : "info"}>
          <b>{i.code === "TAX_ADMIN_MISSING" ? "Permission problem" : i.severity === "error" ? "Blocked" : i.severity === "warning" ? "Warning" : "Note"}{i.object ? ` · ${i.object}${i.field ? `.${i.field}` : ""}` : ""}:</b> {i.message}{i.action ? <span style={{ opacity: 0.85 }}> {i.action}</span> : null}
        </Notice>
      ))}
    </div>
  );
}

/** Configuration preview — what exists, what will be created, in dependency order, before anything is written. */
export function PlanPreview({ isDark, plan }: { isDark: boolean; plan: TaxPlan }) {
  const t = tokens(isDark);
  const r = plan.resolved;
  const creates = plan.steps.filter(s => s.action === "create");
  const existing = plan.steps.filter(s => s.action === "reuse");
  const updates = plan.steps.filter(s => s.action === "update");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 11.5, color: t.dim }}>Resolved in {plan.connection.orgName ?? plan.connection.instanceUrl} ({plan.connection.orgId}) as {plan.connection.username ?? plan.connection.userId} · API {plan.apiVersion}</div>
      <IssueList isDark={isDark} issues={plan.issues} />
      <Panel isDark={isDark} title="Tax Configuration Preview" icon="eye">
        <div style={{ display: "grid", gap: 6 }}>
          <Row isDark={isDark} label="Tax Engine">{r.engine ? `${r.engine.name} (${r.engine.type})` : "— (not needed: no taxable treatment)"}</Row>
          <Row isDark={isDark} label="Tax Policy">{r.policy.name} · {r.policy.selection} selection{r.policy.status ? ` · ${r.policy.status}` : " · new"}</Row>
          {r.treatments.map(x => (
            <Row key={x.key} isDark={isDark} label="Tax Treatment">{x.name} · {x.taxable ? (x.rate === 0 ? "Zero-rated (taxable, 0%)" : "Taxable: Yes") : "Taxable: No (exempt)"}{x.taxCode ? ` · ${x.taxCode}${x.rate !== null ? ` ${x.rate}%` : ""}` : ""}{x.useItems ? " · per-product Tax Treatment Items" : ""}{x.isDefault ? " · default" : ""}</Row>
          ))}
          <Row isDark={isDark} label="Tax Codes">{r.taxCodes.length ? r.taxCodes.map(c => `${c.code} ${c.rate}% (${c.country ?? "—"}, ${c.exists ? "existing code" : "new code"})`).join(" · ") : "—"}</Row>
          <Row isDark={isDark} label="Legal Entity">{r.legalEntity?.name ?? "—"}</Row>
          <Row isDark={isDark} label="Tax Country">{r.country ? `${r.country.name} (${r.country.iso})` : "—"}</Row>
          <Row isDark={isDark} label="Treatment Items">{r.items.length ? r.items.map(i => `${i.product.name} → ${i.taxCode ?? "exempt"}`).join(" · ") : "—"}</Row>
          <Row isDark={isDark} label="Products">{r.products.length ? r.products.map(p => `${p.name}${p.code ? ` (${p.code})` : ""}${p.currentPolicy ? ` — currently "${p.currentPolicy.name}"` : ""}`).join(" · ") : "—"}</Row>
          <Row isDark={isDark} label="Records to Create">{creates.length ? creates.map(s => s.object).join(", ") : "none"}</Row>
          <Row isDark={isDark} label="Existing Records">{existing.length ? existing.map(s => s.object).join(", ") : "none"}</Row>
          {!!updates.length && <Row isDark={isDark} label="Updates">{updates.map(s => s.label).join(" · ")}</Row>}
        </div>
      </Panel>
      <Panel isDark={isDark} title={`Dependency order (${plan.counts.create} create · ${plan.counts.update} update · ${plan.counts.reuse} existing)`} icon="git-branch">
        <Table isDark={isDark} head={["#", "Phase", "Object", "Record", "Action", "Detail", "Salesforce ID"]} empty="Nothing to do."
          rows={plan.steps.map((s, i) => [i + 1, s.phase, s.object, s.label, <ActionTag key="a" action={s.action} />, s.detail, <Id key="i" id={s.recordId && !s.recordId.startsWith("@") ? s.recordId : null} />])} />
      </Panel>
      <FieldPreview isDark={isDark} plan={plan} />
    </div>
  );
}

/** Field-level preview: every value each step sends to Salesforce, with its lookup target, the existing record and validation. */
function FieldPreview({ isDark, plan }: { isDark: boolean; plan: TaxPlan }) {
  const t = tokens(isDark);
  const stepLabel = (ref: string) => plan.steps.find(s => s.id === ref.slice(2, -1))?.label ?? ref;
  const show = (v: unknown) => {
    if (typeof v === "string" && v.startsWith("@{")) return <span style={{ color: t.accent }}>new: {stepLabel(v)}</span>;
    if (typeof v === "string" && plan.refNames[v]) return <>{plan.refNames[v]} <code style={{ fontSize: 11, color: t.dim }}>{v}</code></>;
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
  };
  const rows = plan.steps.filter(s => s.action === "create" || s.action === "update").flatMap(s => Object.entries(s.fields).map(([f, v]) => {
    const info = plan.fieldInfo[s.object]?.[f];
    const problems = plan.issues.filter(i => i.object === s.object && i.field === f);
    const current = s.recordId && !s.recordId.startsWith("@") ? plan.refNames[s.recordId] ?? s.recordId : s.recordId ? stepLabel(s.recordId) : "—";
    return [
      <span key="o"><b>{s.label}</b> <ActionTag action={s.action} /></span>,
      <code key="a">{s.object}</code>,
      <span key="f">{info?.label ?? f} <code style={{ fontSize: 11, color: t.dim }}>{f}</code></span>,
      <span key="v">{show(v)}</span>,
      info?.referenceTo.length ? info.referenceTo.join(" / ") : "—",
      s.action === "update" ? current : "—",
      problems.length ? <span key="x" style={{ color: problems.some(p => p.severity === "error") ? "#E2445C" : "#F5A623" }}>{problems.map(p => p.message).join(" ")}</span> : <span key="x" style={{ color: "#00C875" }}>✓ valid</span>,
    ];
  }));
  return (
    <Panel isDark={isDark} title="Field values sent to Salesforce" icon="list">
      <Table isDark={isDark} head={["Record", "Salesforce API Name", "Field", "Value", "Lookup target", "Current record", "Validation"]} empty="No values to write — everything already exists."
        rows={rows} />
      {plan.issues.some(i => i.severity === "warning") && <div style={{ marginTop: 6, fontSize: 12, color: "#F5A623" }}>{plan.issues.filter(i => i.severity === "warning").map(w => <div key={w.message}>⚠ {w.message}</div>)}</div>}
      <div style={{ marginTop: 6, fontSize: 11.5, color: t.dim }}>To change values, edit them in Manual Configuration and preview again — the preview is re-resolved in Salesforce every time.</div>
    </Panel>
  );
}

/** Creation report — Salesforce record IDs, the exact Salesforce error with its object/field/fix, and verification. */
export function ExecutionResult({ isDark, report }: { isDark: boolean; report: TaxExecutionReport }) {
  const t = tokens(isDark);
  const tone = report.outcome === "CREATED" || report.outcome === "UPDATED" || report.outcome === "NOTHING TO CREATE" ? (report.verification?.passed ? "ok" : "warn") : report.outcome === "STALE" ? "warn" : "error";
  const f = report.failure;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Notice isDark={isDark} tone={tone}><b>{report.outcome}:</b> {report.message}</Notice>
      {f && (
        <Panel isDark={isDark} title={`${f.label} failed`} icon="alert-triangle">
          <div style={{ display: "grid", gap: 6 }}>
            <Row isDark={isDark} label="Object">{f.object}</Row>
            <Row isDark={isDark} label="Field">{f.field ?? "—"}</Row>
            <Row isDark={isDark} label="Salesforce Error"><b>{f.code ?? "—"}</b>: {f.message}</Row>
            <Row isDark={isDark} label="Recommended Action">{f.recommendation}</Row>
            {f.recordId && <Row isDark={isDark} label="Record ID"><Id id={f.recordId} /></Row>}
          </div>
        </Panel>
      )}
      <Panel isDark={isDark} title="Salesforce records" icon="database">
        <div style={{ display: "grid", gap: 4 }}>
          {report.steps.map(s => (
            <div key={s.stepId} style={{ display: "grid", gridTemplateColumns: "18px 100px 1fr 190px", gap: 8, fontSize: 12.5, alignItems: "baseline" }}>
              <span style={{ color: ACTION_COLOR[s.status] }}>{s.status === "created" || s.status === "reused" || s.status === "updated" ? "✓" : s.status === "not-run" ? "○" : "✗"}</span>
              <ActionTag action={s.status} />
              <span style={{ color: t.body }}>{s.label}{s.error ? <span style={{ color: "#E2445C" }}> — {s.error.code}: {s.error.message}</span> : null}</span>
              <Id id={s.recordId} />
            </div>
          ))}
        </div>
      </Panel>
      {report.verification && (
        <Panel isDark={isDark} title={`Verification in Salesforce (${report.verification.checks.filter(c => c.passed).length}/${report.verification.checks.length})`} icon="check-circle">
          <div style={{ display: "grid", gap: 3 }}>
            {report.verification.checks.map(c => (
              <div key={c.id} style={{ display: "grid", gridTemplateColumns: "44px 260px 190px 1fr", gap: 6, fontSize: 12.5 }}>
                <b style={{ color: c.passed ? "#00C875" : "#E2445C" }}>{c.passed ? "PASS" : "FAIL"}</b><span>{c.label}</span><Id id={c.recordId} /><span style={{ color: t.dim }}>{c.detail}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
      <Notice isDark={isDark} tone="info"><b>Configuration ≠ calculation.</b> These records only configure tax. Whether Salesforce actually calculates tax is proven by an invoice — use the Verification tab.</Notice>
    </div>
  );
}
