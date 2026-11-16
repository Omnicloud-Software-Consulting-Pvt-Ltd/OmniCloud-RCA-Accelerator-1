"use client";

import { useState } from "react";
import { tokens, inputStyle, PrimaryButton, GhostButton, ErrorPanel, Field } from "@/components/data/quotes/shared";
import { Panel, LoadingRow } from "@/components/data/billing/billingUi";
import { quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import { Notice, Table } from "@/components/data/billing/tax/taxUi";
import RemediationPanel from "@/components/data/taxes/RemediationPanel";
import SalesforceTaxPanel from "@/components/data/taxes/SalesforceTaxPanel";
import type { CalculationPlan, PlanQuestionField } from "@/lib/tax/server/calculationPlan";
import type { SfTaxResult } from "@/lib/tax/server/salesforceTaxCalculation";
import type { RefreshResult } from "@/lib/tax/server/refreshApproval";
import { RefreshStep } from "@/components/data/taxes/DecisionTableActions";
import { ConfigNotesDisclosure } from "@/components/ui/Disclosure";

/**
 * The tax-calculation plan for a prompt ("Calculate tax for the existing Mouse product…"): what Salesforce already has (reused),
 * the configuration steps still needed — EACH previewed and approved on its own, in dependency order — the decision-table refresh
 * (its own approval), questions for details that must not be invented, and, once the plan is ready, the Salesforce calculation
 * (order → activation → billing schedule → Draft invoice → InvoiceLineTax, every billable step confirmed separately).
 */

export interface PlanInputs { product: { id?: string | null; name?: string | null }; account: string; accountId?: string; country: string; state: string; taxCode: string; rate: string; basis: string; quantity: string; unitPrice: string; treatmentId: string; engineId: string; legalEntityId?: string; sellingModelId?: string }
type PlanResponse = { success: true; salesforce: SfTaxResult; plan: CalculationPlan; message: string };

const STATUS: Record<CalculationPlan["status"], { label: string; color: string }> = {
  READY_TO_CALCULATE: { label: "Ready to calculate", color: "#00C875" }, NEEDS_CONFIGURATION: { label: "Configuration steps needed", color: "#00D4FF" },
  NEEDS_INPUT: { label: "Details needed", color: "#F5A623" }, BLOCKED: { label: "Blocked", color: "#E2445C" },
};
const FIELD_LABEL: Record<PlanQuestionField, string> = { product: "Product (name, code or Id)", country: "Country", state: "State / province", taxCode: "Tax code", rate: "Rate %", basis: "Application basis", account: "Customer account", treatment: "Tax treatment", engine: "Tax engine", legalEntity: "Legal entity", policy: "Tax policy" };
const Id = ({ v }: { v: string | null | undefined }) => (v ? <code style={{ fontSize: 11 }}>{v}</code> : <>—</>);

/** Taxes → Engine Readiness: the engines' decision tables, their freshness, and the separately approved refresh. */
export function DecisionTableRefreshPanel({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const [list, setList] = useState<Extract<RefreshResult, { mode: "list" }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  async function load() {
    setBusy(true); setError(null);
    try { setList(await quoteApiPost<Extract<RefreshResult, { mode: "list" }> & { success: true }>("Decision tables", "/api/taxes/decision-table/refresh", {})); }
    catch (err) { setError(toBillingErrorPanel(err, "The decision tables couldn't be read")); }
    finally { setBusy(false); }
  }
  return (
    <Panel isDark={isDark} title="Decision-table freshness & refresh" icon="refresh">
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontSize: 11.5, color: t.dim }}>Read-only until you approve a refresh. A refresh is never run automatically; each approval covers one table.</div>
        <div><GhostButton label={busy ? "Reading…" : list ? "Re-read" : "Show decision tables"} icon="eye" isDark={isDark} disabled={busy} onClick={() => void load()} /></div>
        {error && <ErrorPanel isDark={isDark} error={error} />}
        {list && !list.tables.length && <Notice isDark={isDark} tone="info">No Active tax engine has a decision table.</Notice>}
        {list?.tables.map(x => (
          <div key={x.decisionTable.id} style={{ border: `1px solid ${t.border}`, borderRadius: 10, padding: 10, display: "grid", gap: 6 }}>
            <div style={{ fontSize: 12.5 }}><b>{x.decisionTable.name}</b> <Id v={x.decisionTable.id} /> · engine {x.engine?.name ?? "—"}{x.sharedWith.length ? ` (shared with ${x.sharedWith.map(e => e.name).join(", ")})` : ""} · <b style={{ color: x.stale ? "#F5A623" : "#00C875" }}>{x.stale ? "STALE" : "CURRENT"}</b></div>
            <div style={{ fontSize: 12, color: t.dim }}>last successful refresh {x.lastSuccessfulRefresh ?? "never"} · newest Tax Rate change {x.newestRateChange ?? "—"}</div>
            {x.engine && <RefreshStep isDark={isDark} engineId={x.engine.id} onDone={() => void load()} />}
          </div>
        ))}
      </div>
    </Panel>
  );
}

export default function CalculationPlanView({ isDark, initial, initialPlan, initialSalesforce, onRunPrompt, embedded = false }: { isDark: boolean; initial: PlanInputs; initialPlan: CalculationPlan; initialSalesforce?: SfTaxResult | null; onRunPrompt?: (prompt: string) => void; embedded?: boolean }) {
  const t = tokens(isDark);
  const [inputs, setInputs] = useState<PlanInputs>(initial);
  const [plan, setPlan] = useState(initialPlan);
  const [sf, setSf] = useState<SfTaxResult | null>(initialSalesforce ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [n, setN] = useState(0);
  /** The plan context sent with every re-check and remediation (the server rebuilds the plan from it — never trusts a client plan). */
  const planBody = (next: PlanInputs = inputs) => ({
    // The picked Account's Id while its name is unchanged; an account answered in the plan is resolved by name.
    product: next.product, account: next.account || null, accountId: next.accountId && next.account === initial.account ? next.accountId : null, country: next.country || null, state: next.state || null, taxCode: next.taxCode || null, rate: next.rate || null,
    basis: next.basis || null, quantity: next.quantity || null, unitPrice: next.unitPrice || null, treatmentId: next.treatmentId || null, engineId: next.engineId || null, legalEntityId: next.legalEntityId || null, sellingModelId: next.sellingModelId || null,
  });
  async function replan(next: PlanInputs = inputs) {
    setBusy(true); setError(null);
    try {
      const r = await quoteApiPost<PlanResponse>("Re-check the tax plan", "/api/taxes/calculation/plan", planBody(next));
      setPlan(r.plan); setSf(r.salesforce); setN(x => x + 1);
    } catch (err) { setError(toBillingErrorPanel(err, "The plan couldn't be re-checked")); }
    finally { setBusy(false); }
  }
  const key: Record<PlanQuestionField, keyof PlanInputs | null> = { product: null, country: "country", state: "state", taxCode: "taxCode", rate: "rate", basis: "basis", account: "account", treatment: "treatmentId", engine: "engineId", legalEntity: "legalEntityId", policy: null };
  const st = STATUS[plan.status];
  // Resolution-card inputs ↔ the plan context (answers resume the same plan; the product and account are never re-entered).
  const FIELD_INPUT: Record<string, keyof PlanInputs> = { account: "account", country: "country", state: "state", taxCode: "taxCode", rate: "rate", basis: "basis", legalEntity: "legalEntityId", engine: "engineId", treatment: "treatmentId", sellingModel: "sellingModelId", unitPrice: "unitPrice" };
  const values: Record<string, string> = Object.fromEntries(Object.entries(FIELD_INPUT).map(([f, k]) => [f, String(inputs[k] ?? "")]));
  const setValue = (field: string, v: string) => { const k = FIELD_INPUT[field]; if (k) setInputs(x => ({ ...x, [k]: v })); };
  const input = { ...inputStyle(t), padding: "7px 10px" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel isDark={isDark} title={`Tax calculation plan${plan.product ? ` · ${plan.product.name}${plan.product.code ? ` (${plan.product.code})` : ""}` : ""}`} icon="map" right={<b style={{ fontSize: 11, color: st.color }}>{st.label.toUpperCase()}</b>}>
        <div style={{ display: "grid", gap: 8 }}>
          <Notice isDark={isDark} tone={plan.status === "READY_TO_CALCULATE" ? "ok" : plan.status === "BLOCKED" ? "error" : plan.status === "NEEDS_INPUT" ? "warn" : "info"}>{plan.summary}</Notice>
          <div style={{ fontSize: 12.5, color: t.body }}><b>Source:</b> the connected Salesforce session (read-only) · <b>Jurisdiction:</b> {[plan.jurisdiction.stateName ?? plan.jurisdiction.stateIso, plan.jurisdiction.countryName].filter(Boolean).join(", ") || "not given"}{plan.jurisdiction.countryIso ? ` (${[plan.jurisdiction.countryIso, plan.jurisdiction.stateIso].filter(Boolean).join("/")})` : ""}</div>
          <ConfigNotesDisclosure isDark={isDark} notes={plan.notes} />
          <div><GhostButton label={busy ? "Re-checking in Salesforce…" : "Re-check plan"} icon="refresh" isDark={isDark} disabled={busy} onClick={() => void replan()} /></div>
        </div>
      </Panel>
      {busy && <LoadingRow isDark={isDark} label="Reading the configuration from Salesforce…" />}
      {error && <ErrorPanel isDark={isDark} error={error} />}

      {plan.questions.length > 0 && (
        <Panel isDark={isDark} title="Details needed (nothing is assumed)" icon="help-circle">
          <div style={{ display: "grid", gap: 10 }}>
            {plan.questions.map(q => {
              const k = key[q.field];
              if (q.field === "product" && q.options?.length) return (
                <Field key={q.field} label={FIELD_LABEL[q.field]} isDark={isDark} hint={q.question}>
                  <select aria-label={FIELD_LABEL[q.field]} value={inputs.product.id ?? ""} onChange={e => setInputs({ ...inputs, product: e.target.value ? { id: e.target.value } : initial.product })} style={input}>
                    <option value="">— choose the Salesforce product —</option>
                    {q.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
              );
              return (
                <Field key={q.field} label={FIELD_LABEL[q.field]} isDark={isDark} hint={q.question}>
                  {!k ? <span style={{ fontSize: 12, color: t.dim }}>Choose one of the options in “Issues &amp; fixes” below.</span>
                    : q.options?.length ? (
                      <select aria-label={FIELD_LABEL[q.field]} value={String(inputs[k] ?? "")} onChange={e => setInputs({ ...inputs, [k]: e.target.value })} style={input}>
                        <option value="">— choose —</option>
                        {q.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : q.field === "country" ? (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <input aria-label="Country" value={inputs.country} onChange={e => setInputs({ ...inputs, country: e.target.value })} placeholder="Country (name or ISO code)" style={input} />
                        <input aria-label="State / province" value={inputs.state} onChange={e => setInputs({ ...inputs, state: e.target.value })} placeholder="State / province (optional)" style={input} />
                      </div>
                    ) : <input aria-label={FIELD_LABEL[q.field]} value={String(inputs[k] ?? "")} onChange={e => setInputs({ ...inputs, [k]: e.target.value })} style={input} />}
                </Field>
              );
            })}
            <div><PrimaryButton label={busy ? "Re-checking…" : "Update plan"} icon="refresh" isDark={isDark} disabled={busy} onClick={() => void replan()} /></div>
          </div>
        </Panel>
      )}

      <Panel isDark={isDark} title="Existing records reused" icon="check-circle">
        <Table isDark={isDark} head={["Object", "Record", "Salesforce Id", "Detail"]} empty="Nothing resolved yet." rows={plan.reuse.map(r => [r.object, r.name, <Id key="i" v={r.id} />, r.detail])} />
      </Panel>

      <RemediationPanel isDark={isDark} diagnostics={plan.diagnostics} version={plan.version} context={{ plan: planBody() }} values={values} setValue={setValue} onApplyInputs={() => void replan()} onChanged={() => void replan()} onRunPrompt={onRunPrompt} />

      {plan.expected && (
        <Panel isDark={isDark} title="Expected / reference tax" icon="eye" right={<b style={{ fontSize: 10.5, color: "#8899AA" }}>REFERENCE ONLY</b>}>
          <div style={{ fontSize: 12.5, display: "grid", gap: 3 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>{plan.expected.taxAmount ?? "—"}</div>
            <div>{plan.expected.taxCode ?? "—"} {plan.expected.rate}% {plan.expected.basis ?? ""} × {plan.expected.taxableAmount ?? "—"}. <b>{plan.expected.note}</b></div>
          </div>
        </Panel>
      )}

      <Panel isDark={isDark} title="Salesforce billing workflow" icon="zap">
        <div style={{ display: "grid", gap: 4, fontSize: 12.5, color: plan.status === "READY_TO_CALCULATE" ? t.body : t.dim }}>
          {plan.transaction.map((s, i) => <div key={s.step}><b>{i + 1}. {s.label}</b> — {s.detail}</div>)}
          {plan.status !== "READY_TO_CALCULATE" && <div style={{ marginTop: 4 }}>Available once the plan is ready (re-check after the configuration steps).</div>}
        </div>
      </Panel>
      {plan.status === "READY_TO_CALCULATE" && (embedded
        ? <Notice isDark={isDark} tone="ok">The configuration is ready — use <b>Calculate with Salesforce</b> above; each billable step is confirmed separately.</Notice>
        : <SalesforceTaxPanel key={`sf${n}`} isDark={isDark} onNotReady={() => void replan()} initial={{ result: sf, product: inputs.product.id ?? inputs.product.name ?? "", account: inputs.account }} />)}
    </div>
  );
}
