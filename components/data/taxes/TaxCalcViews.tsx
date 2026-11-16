"use client";

import { tokens } from "@/components/data/quotes/shared";
import { Panel } from "@/components/data/billing/billingUi";
import { Notice, Table } from "@/components/data/billing/tax/taxUi";
import type { TaxDiagnostic } from "@/lib/tax/server/diagnostics";
import type { TaxCalculationResult } from "@/lib/tax/server/calculation";
import type { AreaStatus, InvoiceLineTaxVerification, PipelineStage, ProductTaxReadiness, StageStatus } from "@/lib/tax/server/pipeline";
import type { E2EResult } from "@/lib/tax/server/e2e";
import type { TaxQueryAnswer } from "@/lib/tax/server/taxQuery";

/** Shared views for the tax CALCULATION layer (readiness, calculation, pipeline, InvoiceLineTax, diagnostics). Display only. */

const AREA_COLOR: Record<AreaStatus, string> = { READY: "#00C875", WARNING: "#F5A623", BLOCKED: "#E2445C", FAILED: "#E2445C" };
const STAGE_COLOR: Record<StageStatus, string> = { DONE: "#00C875", WARNING: "#F5A623", IN_PROGRESS: "#00D4FF", PENDING: "#8899AA", BLOCKED: "#E2445C", FAILED: "#E2445C", NOT_STARTED: "#8899AA" };
const CALC_COLOR: Record<string, string> = { NO_TAX_EXPECTED: "#8899AA", CALCULATED: "#00C875", CONFIGURATION_READY: "#F5A623", NOT_READY: "#E2445C", CALCULATION_FAILED: "#E2445C", INVALID_REQUEST: "#E2445C" };
const ILT_COLOR: Record<string, string> = { SUCCESS: "#00C875", VERIFIED: "#00C875", NO_TAX_EXPECTED: "#8899AA", PENDING: "#F5A623", FAILED: "#E2445C", MISMATCH: "#E2445C", MISSING: "#E2445C", ERROR: "#E2445C" };
const Tag = ({ text, color }: { text: string; color: string }) => <b style={{ fontSize: 10.5, letterSpacing: "0.02em", color, whiteSpace: "nowrap" }}>{text}</b>;
const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function ReadinessAreas({ isDark, r }: { isDark: boolean; r: ProductTaxReadiness }) {
  const t = tokens(isDark);
  return (
    <Panel isDark={isDark} title={`Tax readiness${r.product ? ` · ${r.product.name}` : ""}`} icon="activity" right={<Tag text={r.status} color={AREA_COLOR[r.status]} />}>
      <div style={{ display: "grid", gap: 8 }}>
        <Notice isDark={isDark} tone={r.status === "READY" ? "ok" : r.status === "WARNING" ? "warn" : "error"}>{r.message}</Notice>
        <div style={{ display: "grid", gap: 4 }}>
          {r.areas.map(a => (
            <div key={a.id} style={{ display: "grid", gridTemplateColumns: "84px 210px 1fr", gap: 8, fontSize: 12.5, alignItems: "baseline" }}>
              <Tag text={a.status} color={AREA_COLOR[a.status]} />
              <span style={{ fontWeight: 700, color: t.heading }}>{a.label}</span>
              <span style={{ color: t.body }}>{a.detail}{a.recordId ? <code style={{ fontSize: 11, marginLeft: 6, color: t.dim }}>{a.recordId}</code> : null}</span>
            </div>
          ))}
        </div>
        {r.engineReadiness && (
          <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: t.heading }}>Tax engine readiness · {r.engineReadiness.engine?.name ?? "—"} <Tag text={r.engineReadiness.status} color={AREA_COLOR[r.engineReadiness.status]} /></div>
            <Table isDark={isDark} head={["Check", "Object", "Result", "Detail", "Remediation"]} empty=""
              rows={r.engineReadiness.checks.map(c => [<span key="l">{c.label} <span style={{ fontSize: 10.5, opacity: 0.7 }}>({c.code})</span></span>, `${c.object}${c.recordId ? ` ${c.recordId}` : ""}`, <Tag key="r" text={c.passed ? "PASS" : "FAIL"} color={c.passed ? "#00C875" : "#E2445C"} />, `${c.detail}${c.salesforceMessage ? ` · Salesforce: ${c.salesforceMessage}` : ""}`, c.remediation ?? "—"])} />
          </div>
        )}
      </div>
    </Panel>
  );
}

export function Diagnostics({ isDark, list }: { isDark: boolean; list: TaxDiagnostic[] }) {
  const shown = list.filter((d, i) => list.findIndex(x => x.code === d.code && x.explanation === d.explanation) === i);
  if (!shown.length) return null;
  return (
    <Panel isDark={isDark} title="Diagnostics" icon="alert">
      <div style={{ display: "grid", gap: 6 }}>
        {shown.map((d, i) => (
          <Notice key={`${d.code}-${i}`} isDark={isDark} tone={d.severity === "error" ? "error" : d.severity === "warning" ? "warn" : "info"}>
            <b>{d.title}</b> <span style={{ opacity: 0.7, fontSize: 11 }}>({d.code} · {d.stage})</span>: {d.explanation}
            {d.salesforceMessage ? <div style={{ marginTop: 3 }}><b>Salesforce{d.salesforceCode ? ` ${d.salesforceCode}` : ""}:</b> {d.salesforceMessage}</div> : null}
            {d.httpStatus || d.operation ? <div style={{ marginTop: 3, fontSize: 11.5, opacity: 0.8 }}>{d.operation ?? ""}{d.httpStatus ? " · HTTP " + d.httpStatus : ""}</div> : null}
            {d.action ? <div style={{ marginTop: 3, opacity: 0.85 }}>→ {d.action}</div> : null}
          </Notice>
        ))}
      </div>
    </Panel>
  );
}

export function CalculationResultView({ isDark, r }: { isDark: boolean; r: TaxCalculationResult }) {
  const s = r.summary;
  const sf = r.salesforce;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel isDark={isDark} title="Tax calculation" icon="dollar-sign" right={<Tag text={r.status.replace(/_/g, " ")} color={CALC_COLOR[r.status] ?? "#888"} />}>
        <div style={{ display: "grid", gap: 8 }}>
          <Notice isDark={isDark} tone={r.status === "CALCULATED" ? "ok" : r.status === "NO_TAX_EXPECTED" ? "info" : r.status === "CONFIGURATION_READY" ? "warn" : "error"}>{r.message}</Notice>
          {s && (
            <Table isDark={isDark} head={["Item", "Value"]} empty="" rows={[
              ["Product", `${s.product?.name ?? "—"}${s.product?.code ? ` (${s.product.code})` : ""} × ${s.quantity ?? "—"} @ ${money(s.unitPrice)}`],
              ["Taxable Amount", money(s.taxableAmount)],
              ["Tax Policy", s.policy?.name ?? "—"],
              ["Tax Treatment", s.treatment ? `${s.treatment.name} · ${s.treatment.status ?? "—"} · ${s.treatment.taxable ? "taxable" : "NOT taxable"}${s.item ? ` · item ${s.item.name}` : ""}` : "—"],
              ["Tax Engine", s.engine ? `${s.engine.name} · ${s.engine.status ?? "—"}` : "—"],
              ["Tax Code / Product Code", `${s.taxCode ?? "—"} / ${s.productCode ?? "—"}`],
              ["Tax Rate (configured)", s.taxRate ? `${s.taxRate.rate ?? "?"}% · ${s.taxRate.taxCode ?? s.taxRate.name} (${s.taxRate.id})` : "—"],
              ["Geography", [s.geography.country, s.geography.state, s.geography.city, s.geography.zipCode].filter(Boolean).join(" · ") || "—"],
              ["Legal Entity", s.legalEntity?.name ?? "—"],
              ["Expected tax (configured rate)", r.expected ? `${money(r.expected.taxAmount)} — ${r.expected.note}` : "—"],
              ["Salesforce Tax Amount", sf?.totalTax !== null && sf?.totalTax !== undefined ? <b key="t">{money(sf.totalTax)}</b> : sf?.httpStatus ? `none — HTTP ${sf.httpStatus}${sf.errorCode ? ` ${sf.errorCode}` : ""}: ${sf.message ?? ""}` : "not requested"],
            ]} />
          )}
          {r.resolution?.rate && r.resolution.rate.selected && <div style={{ fontSize: 12, opacity: 0.85 }}><b>Why this rate:</b> {r.resolution.rate.why.join("; ")}</div>}
          {r.decisionTable && <div style={{ fontSize: 12, opacity: 0.85 }}><b>Decision table:</b> {r.decisionTable.name} · {r.decisionTable.status} · refresh {r.decisionTable.refreshStatus ?? "—"}{r.decisionTable.ready ? " · ready" : r.decisionTable.reason ? ` · ${r.decisionTable.reason}` : ""}</div>}
          {sf?.request && <details style={{ fontSize: 12 }}><summary>Salesforce request ({sf.endpoint})</summary><pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{JSON.stringify(sf.request, null, 2)}</pre></details>}
        </div>
      </Panel>
      <Diagnostics isDark={isDark} list={r.diagnostics} />
    </div>
  );
}

export function PipelineView({ isDark, stages, title = "Tax pipeline" }: { isDark: boolean; stages: PipelineStage[]; title?: string }) {
  const t = tokens(isDark);
  return (
    <Panel isDark={isDark} title={title} icon="layers">
      <div style={{ display: "grid", gap: 2 }}>
        {stages.map((s, i) => (
          <div key={s.id}>
            <div style={{ display: "grid", gridTemplateColumns: "100px 170px 1fr", gap: 8, fontSize: 12.5, alignItems: "baseline" }}>
              <Tag text={s.status.replace("_", " ")} color={STAGE_COLOR[s.status]} />
              <span style={{ fontWeight: 800, color: t.heading }}>{s.label}</span>
              <span style={{ color: t.body }}>
                {s.error ? <span style={{ color: "#E2445C" }}>{s.error} </span> : null}
                {s.verification ?? s.diagnostic ?? ""}
                {s.recordId ? <code style={{ fontSize: 11, marginLeft: 6, color: t.dim }}>{s.recordId}</code> : null}
                {s.timestamp ? <span style={{ fontSize: 11, marginLeft: 6, color: t.dim }}>{s.timestamp}</span> : null}
              </span>
            </div>
            {i < stages.length - 1 && <div style={{ marginLeft: 40, color: t.dim, fontSize: 11, lineHeight: "12px" }}>↓</div>}
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function InvoiceTaxView({ isDark, v }: { isDark: boolean; v: InvoiceLineTaxVerification }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel isDark={isDark} title={`InvoiceLineTax · ${v.invoice?.number ?? v.invoiceId}`} icon="file-text" right={<Tag text={v.status.replace(/_/g, " ")} color={ILT_COLOR[v.status] ?? "#888"} />}>
        <div style={{ display: "grid", gap: 8 }}>
          <Notice isDark={isDark} tone={v.status === "SUCCESS" ? "ok" : v.status === "NO_TAX_EXPECTED" ? "info" : v.status === "PENDING" ? "warn" : "error"}>{v.message}</Notice>
          {v.invoice && <div style={{ fontSize: 12.5 }}>Invoice {v.invoice.number} · {v.invoice.status} · subtotal {money(v.invoice.subtotal)} · tax {money(v.invoice.tax)} · total {money(v.invoice.totalWithTax)}</div>}
          <Table isDark={isDark} head={["Invoice Line", "Product", "Treatment", "Charge", "InvoiceLineTax (Salesforce)", "Applicable rate", "Status"]} empty="No invoice lines."
            rows={v.lines.map(l => [<code key="i" style={{ fontSize: 11 }}>{l.invoiceLineId}</code>, l.product ?? "—", l.treatment ?? "—", money(l.charge),
              l.taxes.length ? l.taxes.map(x => `${x.name ?? x.code ?? "tax"} ${x.rate ?? "?"}% = ${money(x.amount)} (${x.id})`).join("; ") : "none",
              l.expected ? `${l.expected.taxCode ?? ""} ${l.expected.rate ?? "?"}% → ${money(l.expected.taxAmount)}` : "—", <Tag key="s" text={l.status.replace(/_/g, " ")} color={ILT_COLOR[l.status] ?? "#888"} />])} />
        </div>
      </Panel>
      <Diagnostics isDark={isDark} list={v.diagnostics} />
    </div>
  );
}

export function E2EView({ isDark, e }: { isDark: boolean; e: E2EResult }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Notice isDark={isDark} tone={e.status === "SUCCESS" ? "ok" : e.status === "BLOCKED" || e.status === "FAILED" ? "error" : "info"}>
        <b>{e.status.replace(/_/g, " ")}:</b> {e.message}
        <div style={{ marginTop: 4, fontSize: 12 }}>Configuration: <b>{e.outcome.configuration}</b> · Salesforce calculated tax: <b>{e.outcome.salesforceCalculated ? "yes" : "no"}</b> · InvoiceLineTax generated: <b>{e.outcome.invoiceLineTaxGenerated ? "yes" : "no"}</b> · Tax Calculation: <b>{e.outcome.taxCalculation.replace("_", " ")}</b></div>
      </Notice>
      {e.plan && (e.plan.create.length > 0 || e.status === "READY_TO_START") && (
        <Panel isDark={isDark} title="What happens on confirmation" icon="list">
          <div style={{ fontSize: 12.5, display: "grid", gap: 3 }}>
            {e.plan.create.map(x => <div key={x}>• Create: {x}</div>)}
            {e.plan.salesforceGenerates.map(x => <div key={x} style={{ opacity: 0.8 }}>• Salesforce generates: {x}</div>)}
          </div>
        </Panel>
      )}
      <PipelineView isDark={isDark} stages={e.pipeline} />
      {e.readiness && e.readiness.areas.length > 0 && <ReadinessAreas isDark={isDark} r={e.readiness} />}
    </div>
  );
}

/** Renders an assistant answer to a calculation / readiness / verification command. */
export function TaxQueryAnswerView({ isDark, a }: { isDark: boolean; a: TaxQueryAnswer }) {
  const label: Record<string, string> = { "salesforce-calculate": "TAX CALCULATION (Salesforce)", "salesforce-preview": "TAX PREVIEW (decision-table evaluation — not tax)", "invoice-result": "INVOICE · SALESFORCE TAX RESULT", "invoice-explain": "INVOICE · WHY NO TAX", readiness: "READINESS CHECK", explain: "DIAGNOSIS", e2e: "END-TO-END VALIDATION (preview)", "latest-invoice-config": "LATEST INVOICE · TAX CONFIGURATION", "verify-invoice-tax": "INVOICELINETAX VERIFICATION" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Notice isDark={isDark} tone="info"><b>{label[a.kind]}</b> — a calculation/verification command: no configuration is created or changed.{a.query.noMutation ? " (You asked not to modify anything.)" : ""}</Notice>
      {a.kind === "e2e" && <E2EView isDark={isDark} e={a.e2e} />}
      {(a.kind === "readiness" || a.kind === "explain" || a.kind === "latest-invoice-config" || a.kind === "verify-invoice-tax") && (
        <>
          {a.kind !== "readiness" && <Notice isDark={isDark} tone="info">{a.message}</Notice>}
          {a.invoiceTax && <InvoiceTaxView isDark={isDark} v={a.invoiceTax} />}
          {a.readiness && a.readiness.areas.length > 0 && <ReadinessAreas isDark={isDark} r={a.readiness} />}
          {a.readiness && <Diagnostics isDark={isDark} list={a.readiness.diagnostics} />}
        </>
      )}
    </div>
  );
}
