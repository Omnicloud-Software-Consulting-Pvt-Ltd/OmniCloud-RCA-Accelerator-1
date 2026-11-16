"use client";

import { tokens, GhostButton, ErrorPanel } from "@/components/data/quotes/shared";
import { Panel, Row, LoadingRow, useBillingData } from "@/components/data/billing/billingUi";
import type { ReadinessStatus, TaxReadiness as Readiness } from "@/lib/tax/server/engine";
import { CATEGORY_LABEL, Notice, withConnection } from "@/components/data/billing/tax/taxUi";

const COLOR: Record<ReadinessStatus, string> = { PASS: "#00C875", WARNING: "#F5A623", FAILED: "#E2445C", "ACTION REQUIRED": "#F5A623" };
/** The Taxes section's status vocabulary (READY / WARNING / BLOCKED / FAILED); Billing's Tax tab keeps PASS / ACTION REQUIRED. */
const TAXES_LABEL: Record<ReadinessStatus, string> = { PASS: "READY", WARNING: "WARNING", FAILED: "FAILED", "ACTION REQUIRED": "BLOCKED" };

/** Read-only: re-reads the org on every Re-check. Repairing the StandardTax system table is a Salesforce admin task — no repair here. */
export default function TaxReadiness({ isDark, conn, vocabulary = "billing" }: { isDark: boolean; conn: string; vocabulary?: "billing" | "taxes" }) {
  const label = (st: ReadinessStatus) => (vocabulary === "taxes" ? TAXES_LABEL[st] : st);
  const t = tokens(isDark);
  const loaded = useBillingData<Readiness>("Read tax engine readiness", withConnection("/api/billing/tax/readiness", conn));
  const data = loaded.data;
  if (!data) return loaded.error ? <ErrorPanel isDark={isDark} error={loaded.error} /> : <LoadingRow isDark={isDark} label="Checking the Salesforce tax engine…" />;
  const a = data.adminAction;
  const when = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 19).replace("T", " ")} UTC` : "—");
  const recheck = <GhostButton label={loaded.loading ? "Checking…" : "Re-check Readiness"} icon="refresh-cw" isDark={isDark} disabled={loaded.loading} onClick={loaded.reload} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Notice isDark={isDark} tone={data.ready ? "ok" : "error"}><b>{vocabulary === "taxes" ? (data.ready ? "READY" : "BLOCKED") : data.ready ? "PASS" : "FAIL"} · Salesforce tax engine:</b> {data.headline}</Notice>
      <Panel isDark={isDark} title="Tax Engine Readiness" icon="activity" right={recheck}>
        <div style={{ display: "grid", gap: 4 }}>
          {data.items.map(i => (
            <div key={i.id} style={{ display: "grid", gridTemplateColumns: "130px 230px 1fr", gap: 8, fontSize: 12.5, alignItems: "baseline" }}>
              <b style={{ color: COLOR[i.status] }}>{label(i.status)}</b>
              <span style={{ fontWeight: 700, color: t.heading }}>{i.label}</span>
              <span style={{ color: t.body }}>{i.category ? <b style={{ color: t.dim }}>{CATEGORY_LABEL[i.category]}: </b> : null}{i.detail}{i.action ? <span style={{ color: t.dim }}> {i.action}</span> : null}</span>
            </div>
          ))}
        </div>
      </Panel>
      {a && (
        <Panel isDark={isDark} title="Salesforce Admin Action Required" icon="alert-triangle" right={recheck}>
          <div style={{ display: "grid", gap: 6, fontSize: 12.5, color: t.body }}>
            <Row isDark={isDark} label="Status"><b style={{ color: "#E2445C" }}>{a.status}</b></Row>
            <Row isDark={isDark} label="Category">{a.category}</Row>
            <Row isDark={isDark} label="Error">{a.error ? <><b>{a.error.number}</b> – {a.error.code}{a.error.message ? <span style={{ color: t.dim }}> · {a.error.message}</span> : null}</> : "No Salesforce tax error logged yet"}</Row>
            <Row isDark={isDark} label="Issue">{a.issue}</Row>
            <Row isDark={isDark} label="Admin Action"><b>{a.adminAction}</b></Row>
            <Row isDark={isDark} label="Decision Table ID">{a.decisionTable ? <><code>{a.decisionTable.id}</code> · {a.decisionTable.apiName}{a.decisionTable.name ? ` ("${a.decisionTable.name}")` : ""}</> : "— (not found)"}</Row>
            <Row isDark={isDark} label="Internal Matrix ID">{a.internalMatrix ? <><code>{a.internalMatrix.id}</code> · {a.internalMatrix.name} (Salesforce system dependency)</> : "—"}</Row>
            <Row isDark={isDark} label="Current table status">{a.decisionTable ? `${a.decisionTable.status ?? "—"} · refresh ${a.decisionTable.refreshStatus ?? "—"}` : "—"}</Row>
            <Row isDark={isDark} label="Last refresh">{when(a.decisionTable?.lastRefresh)}</Row>
            <Row isDark={isDark} label="Current inputs">{a.currentInputs.join(", ") || "—"}</Row>
            <Row isDark={isDark} label="Missing input"><b style={{ color: "#E2445C" }}>{a.missingInputs.join(", ") || "—"}</b></Row>
            <div style={{ marginTop: 6, padding: 10, borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface }}>
              <div style={{ fontWeight: 800, color: t.heading, marginBottom: 4 }}>Salesforce Support case information</div>
              <div style={{ marginBottom: 4 }}><b>Subject:</b> {a.supportCase.subject}</div>
              <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>{a.supportCase.details.map(d => <li key={d}>{d}</li>)}</ul>
            </div>
            <div style={{ fontSize: 11.5, color: t.dim }}>This application doesn&apos;t change the decision table or Billing settings. After a Salesforce administrator repairs it, use Re-check Readiness.</div>
          </div>
        </Panel>
      )}
    </div>
  );
}
