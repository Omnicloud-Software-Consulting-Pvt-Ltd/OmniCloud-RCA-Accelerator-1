"use client";

import { useState } from "react";
import { tokens, inputStyle, PrimaryButton, GhostButton, ErrorPanel, Tabs, Field } from "@/components/data/quotes/shared";
import { Panel, Modal, LoadingRow, useBillingData } from "@/components/data/billing/billingUi";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiGet, quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import type { ProductRow, RecordRef, TaxConfigSpec, TaxDashboard, TaxExecutionReport, TaxMetadata, TaxPlan } from "@/lib/tax/types";
import { ExecutionResult, Notice, PlanPreview, withConnection } from "@/components/data/billing/tax/taxUi";
import { StartRunForm } from "@/components/data/billing/tax/TaxVerification";
import type { TestTransaction } from "@/lib/tax/server/ai";
import type { AssistantOperation, AssistantPreview } from "@/lib/tax/types";
import TaxAssistant from "@/components/data/billing/tax/TaxAssistant";
import { TaxQueryAnswerView } from "@/components/data/taxes/TaxCalcViews";
import SalesforceTaxPanel from "@/components/data/taxes/SalesforceTaxPanel";
import CalculationPlanView, { DecisionTableRefreshPanel } from "@/components/data/taxes/CalculationPlanView";
import { OrderRemediation } from "@/components/data/taxes/RemediationPanel";
import type { InterpretationInfo } from "@/lib/tax/server/calculationAi";
import type { TaxQueryAnswer } from "@/lib/tax/server/taxQuery";
import { Disclosure, DISCLOSURE_LABELS, WarningsDisclosure } from "@/components/ui/Disclosure";
import PromptGuide from "@/components/ai/PromptGuide";
import { taxConfigPromptGuides } from "@/lib/ai/promptGuides/taxConfig";

/** What the Create flow needs from the workspace: open a calculation run, and whether Salesforce can calculate tax right now. */
export interface CreateNav { onOpenRun: (orderId: string) => void; calculationBlocked: string | null }

type MetadataResponse = TaxMetadata & { providers: { id: string; name: string }[]; namedCredentials: { id: string; name: string }[] };
type Interpretation = { success: false; requiresInput: boolean; message: string } | { success: true; spec: TaxConfigSpec; warnings: string[]; plan: TaxPlan; transaction: TestTransaction | null };
/** Taxes section only: the assistant answers with record operations, or delegates a whole new configuration to the planner. */
type AssistantInterpretation = { success: false; requiresInput: boolean; message: string }
  | { success: true; mode: "operations"; operations: AssistantOperation[]; warnings: string[]; preview: AssistantPreview }
  | { success: true; mode: "configure"; configuration: Extract<Interpretation, { success: true }> }
  | { success: true; mode: "query"; answer: TaxQueryAnswer; interpretation?: InterpretationInfo };

/* ───────────────────────────── Shared preview → create flow ───────────────────────────── */

function ConfigFlow({ isDark, spec, plan, setPlan, onDone, nav, transaction }: { isDark: boolean; spec: TaxConfigSpec; plan: TaxPlan; setPlan: (p: TaxPlan) => void; onDone: () => void; nav: CreateNav; transaction?: TestTransaction | null }) {
  const t = tokens(isDark);
  const notify = useSalesforceSuccess();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<TaxExecutionReport | null>(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  async function create() {
    setBusy(true); setError(null);
    try {
      const r = await quoteApiPost<TaxExecutionReport>("Create tax configuration", "/api/billing/tax/configure", { spec, token: plan.token, confirm: true });
      setReport(r); setPlan(r.plan);
      const made = r.steps.filter(s => s.status === "created" && s.recordId);
      if (made.length) notify({ title: "Tax Configuration Created", message: r.message, records: made.map(s => ({ objectApiName: s.object, recordId: s.recordId!, recordName: s.label, salesforceUrl: "" })) });
      onDone();
    } catch (err) { setError(toBillingErrorPanel(err, "The tax configuration wasn't created")); }
    finally { setBusy(false); setConfirm(false); }
  }
  const writes = plan.steps.filter(s => s.action === "create" || s.action === "update");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PlanPreview isDark={isDark} plan={plan} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <PrimaryButton label={busy ? "Creating in Salesforce…" : writes.length ? "Create in Salesforce" : "Verify (nothing to create)"} icon="upload-cloud" isDark={isDark} disabled={!plan.ok || busy} onClick={() => setConfirm(true)} />
        {!plan.ok && <span style={{ fontSize: 12, color: "#E2445C" }}>Resolve the blocked items above first — nothing is created while any item is blocked.</span>}
      </div>
      {busy && <LoadingRow isDark={isDark} label="Creating in dependency order and verifying in Salesforce…" />}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {report && <ExecutionResult isDark={isDark} report={report} />}
      {report && report.failure === null && report.verification?.passed && (() => {
        // Configuration is verified — now prove CALCULATION: a real Salesforce transaction for one of the configured products.
        const products = [...new Map([...report.plan.resolved.products, ...report.plan.resolved.items.map(i => ({ ...i.product, currentPolicy: null }))].map(x => [x.id, { id: x.id, name: x.name, code: x.code }])).values()];
        return products.length
          ? <StartRunForm isDark={isDark} title="Calculate the tax on a real sale" products={products} blockedReason={nav.calculationBlocked} onStarted={nav.onOpenRun}
              defaults={{ productName: transaction?.productName ?? null, accountName: transaction?.accountName ?? null, quantity: transaction?.quantity ?? null, unitPrice: transaction?.unitPrice ?? null }} />
          : <Notice isDark={isDark} tone="info">No product is mapped to this configuration yet — map one to calculate tax on a real sale.</Notice>;
      })()}
      {confirm && (
        <Modal isDark={isDark} title={writes.length ? "Create this tax configuration in Salesforce?" : "Verify the existing configuration?"} tone="accent" actions={<>
          <GhostButton label="Back" isDark={isDark} onClick={() => setConfirm(false)} />
          <PrimaryButton label={busy ? "Working…" : "Confirm"} icon="check" isDark={isDark} disabled={busy} onClick={() => void create()} />
        </>}>
          <div style={{ fontSize: 12.5, color: t.body, display: "grid", gap: 6 }}>
            <div>Org: <b>{plan.connection.orgName}</b> ({plan.connection.orgId}) · user <b>{plan.connection.username}</b>.</div>
            <div><b>Create:</b> {plan.steps.filter(s => s.action === "create").map(s => s.label).join(", ") || "nothing"}.</div>
            {plan.steps.some(s => s.action === "update") && <div><b>Update:</b> {plan.steps.filter(s => s.action === "update").map(s => s.label).join(", ")}.</div>}
            <div><b>Reuse:</b> {plan.steps.filter(s => s.action === "reuse").map(s => s.label).join(", ") || "nothing"}.</div>
            {plan.issues.filter(i => i.severity === "warning").map(w => <div key={w.message} style={{ color: "#F5A623" }}>⚠ {w.message}</div>)}
            <div style={{ color: t.dim }}>Each step is all-or-nothing in Salesforce; every record is re-read and verified afterwards.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ───────────────────────────── AI Prompt ───────────────────────────── */

const EXAMPLES = [
  "Create an India GST tax configuration for Laptop with 18% GST. Make the product taxable and use the standard tax engine.",
  "Apply <rate>% <tax> to <product> and calculate the tax when it is sold at <price> to <customer account>.",
  "Apply GST 18% to Laptop and Software, and GST 5% to Book.",
  "Create a tax-exempt treatment for Laptop Bag.",
];
/** Taxes section only: one example per assistant operation (the label is the button; clicking fills in the full prompt). */
const ASSISTANT_EXAMPLES: { label: string; prompt: string }[] = [
  { label: "Create policy", prompt: "Create a Draft tax policy named 'Cloud Storage India GST Policy' using Manual treatment selection." },
  { label: "Create treatment", prompt: "Create a Draft taxable treatment named 'Cloud Storage Standard GST Treatment' for the Cloud Storage Pro product." },
  { label: "Create treatment item", prompt: "Create a tax treatment item named 'Cloud Storage Pro GST Item' under 'Cloud Storage Standard GST Treatment' for the Cloud Storage Pro product." },
  { label: "Create tax rate", prompt: "Create an 18% GST tax rate for Cloud Storage Pro in Andhra Pradesh using TaxCode 'CLOUD_GST_18'." },
  { label: "Create Geo Country", prompt: "Create the India GeoCountry using ISO code 'IN', but first check whether it already exists." },
  { label: "Create Geo State", prompt: "Create Andhra Pradesh under India using ISO code 'AP'." },
  { label: "Assign default treatment", prompt: "Assign 'Cloud Storage Standard GST Treatment' as the default treatment for 'Cloud Storage India GST Policy'." },
  { label: "Assign policy to product", prompt: "Assign 'Cloud Storage India GST Policy' to the 'Cloud Storage Pro' product." },
  { label: "Activate treatment", prompt: "Activate 'Cloud Storage Standard GST Treatment' after checking all required dependencies." },
  { label: "Activate policy", prompt: "Activate 'Cloud Storage India GST Policy' after verifying that its default treatment is active." },
  { label: "Update", prompt: "Update 'Cloud Storage India GST Policy' and change its description to 'GST policy for Indian cloud storage sales'." },
  { label: "Show configuration", prompt: "Show me the complete configuration of 'Cloud Storage India GST Policy', including treatments, treatment items, products, tax engine, and related rates." },
  { label: "Deactivate", prompt: "Deactivate 'Cloud Storage India GST Policy' and show me the impact before making the change." },
  { label: "Delete", prompt: "Delete 'Cloud Storage Pro GST Item' and show me the dependency and deletion impact before executing." },
  { label: "Replace tax rate", prompt: "Change the GST rate for 'Cloud Storage Pro' from 18% to 20% and show me the replacement and end-date plan before executing." },
  { label: "Duplicate prevention", prompt: "Create India GeoCountry with ISO code 'IN'. If it already exists, show me the existing record instead of creating a duplicate." },
  { label: "Ambiguous record", prompt: "Show me the GST policies matching 'Cloud Storage'. If there is more than one, let me choose which policy I mean." },
  { label: "Tax readiness", prompt: "Check whether <product> is ready for tax calculation. Do not modify anything." },
  { label: "Calculate tax", prompt: "Calculate tax for <product> for quantity <n> in <state>, <country>." },
  { label: "Calculate tax (plan)", prompt: "Calculate tax for the existing <product> using the applicable tax configuration. Reuse compatible records, identify missing configuration, calculate tax through the Salesforce billing workflow, generate a draft invoice, and show the actual tax calculated by Salesforce." },
  { label: "Verify InvoiceLineTax", prompt: "Verify the InvoiceLineTax generated for <product>." },
];

/** Taxes → Calculation: prompts about calculating, verifying or explaining tax (placeholders in <…> are filled in by the user — no product is assumed). */
const CALC_EXAMPLES: { label: string; prompt: string }[] = [
  { label: "Calculate for a product", prompt: "Calculate tax for the existing <product> for <customer account> using its configured tax policy, and show the actual tax calculated by Salesforce." },
  { label: "Tax on an order", prompt: "Calculate the tax for the product in order <order number> and show the tax amount and total including tax." },
  { label: "What is missing?", prompt: "Inspect the existing tax configuration for <product> and tell me what is missing before calculating tax." },
  { label: "Invoice tax", prompt: "Show the tax code, rate, taxable amount, tax amount and total including tax for invoice <DOC-number>." },
  { label: "Why no tax (order)", prompt: "Why was tax not applied to order <order number>?" },
  { label: "Decision table current?", prompt: "Check whether the configured decision table contains the latest applicable tax rate." },
];

export function AiPrompt({ isDark, onEdit, onDone, nav, assistant = false, variant = "configure" }: { isDark: boolean; onEdit: (spec: TaxConfigSpec) => void; onDone: () => void; nav: CreateNav; assistant?: boolean; variant?: "configure" | "calculation" }) {
  const t = tokens(isDark);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [result, setResult] = useState<{ spec: TaxConfigSpec; warnings: string[]; plan: TaxPlan; transaction: TestTransaction | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [answer, setAnswer] = useState<TaxQueryAnswer | null>(null);
  const [interp, setInterp] = useState<InterpretationInfo | null>(null);
  const [ops, setOps] = useState<{ operations: AssistantOperation[]; warnings: string[]; preview: AssistantPreview; n: number } | null>(null);
  /** Run a follow-up request in place (from a resolution card) — the same page, a new plan, nothing re-entered by hand. */
  const runPrompt = (p: string) => { setPrompt(p); void interpret(p); };
  async function interpret(override?: string) {
    const text = override ?? prompt;
    setBusy(true); setError(null); setResult(null); setMessage(null); setOps(null); setAnswer(null); setInterp(null);
    try {
      if (assistant) {
        const r = await quoteApiPost<AssistantInterpretation>("Interpret tax request", "/api/taxes/assistant/interpret", { prompt: text });
        if (!r.success) setMessage(r.message);
        else if (r.mode === "configure") setResult(r.configuration);
        else if (r.mode === "query") { setAnswer(r.answer); setInterp(r.interpretation ?? null); }
        else setOps({ operations: r.operations, warnings: r.warnings, preview: r.preview, n: Date.now() });
        return;
      }
      const r = await quoteApiPost<Interpretation>("Interpret tax prompt", "/api/billing/tax/interpret", { prompt: text });
      if (!r.success) setMessage(r.message); else setResult(r);
    } catch (err) { setError(toBillingErrorPanel(err, "The AI interpretation failed")); }
    finally { setBusy(false); }
  }
  const s = result?.spec;
  const calc = variant === "calculation";
  const examples = calc ? CALC_EXAMPLES : assistant ? ASSISTANT_EXAMPLES : EXAMPLES.map(x => ({ label: x.length > 46 ? `${x.slice(0, 44)}…` : x, prompt: x }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel isDark={isDark} title={calc ? "Ask about tax — calculate, verify or explain (natural language)" : assistant ? "Describe the tax configuration or change" : "Describe the tax configuration"} icon="sparkles">
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) void interpret(); }} rows={3}
          placeholder={`e.g. "${examples[0].prompt}"`} style={{ ...inputStyle(t), resize: "vertical", fontSize: 13.5, lineHeight: 1.5 }} />
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          <PrimaryButton label={busy ? "Interpreting…" : calc ? "Interpret & plan" : "Generate Preview"} icon="sparkles" isDark={isDark} disabled={!prompt.trim() || busy} onClick={() => void interpret()} />
          {!assistant && examples.map(x => <GhostButton key={x.prompt} label={x.label} isDark={isDark} onClick={() => setPrompt(x.prompt)} />)}
        </div>
        {assistant && (
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: t.dim, marginRight: 2 }}>Examples:</span>
            {examples.map(x => <GhostButton key={x.label} label={x.label} isDark={isDark} onClick={() => setPrompt(x.prompt)} />)}
          </div>
        )}
        {calc && <div style={{ fontSize: 11.5, color: t.dim, marginTop: 6 }}>The AI (when configured) only extracts what you wrote — product, order, invoice, customer, jurisdiction, code, rate. Every record is resolved in Salesforce, every write is shown and approved on its own, and the tax shown as the result is only ever Salesforce&apos;s InvoiceLineTax.</div>}
        <div style={{ fontSize: 11.5, color: t.dim, marginTop: 6, display: calc ? "none" : undefined }}>{assistant && "Create, update, assign, activate / deactivate, end-date, replace, delete or show tax records — or describe a whole new configuration. "}The AI only extracts intent (names, taxability, rates, codes, products). Every record, field and picklist value is resolved in Salesforce, and nothing is created until you confirm the preview.</div>
        <div style={{ marginTop: 10 }}><PromptGuide isDark={isDark} config={taxConfigPromptGuides[calc ? "taxCalculation" : assistant ? "taxAssistant" : "taxConfigure"]} onUseExample={setPrompt} /></div>
      </Panel>
      {busy && <LoadingRow isDark={isDark} label="Interpreting with AI and resolving in Salesforce…" />}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {message && <Notice isDark={isDark} tone="warn">{message}</Notice>}
      {/* Actionable: inputs the request still needs stay visible; how it was interpreted is diagnostic and hidden until asked for. */}
      {interp && interp.missing.length > 0 && <Notice isDark={isDark} tone="warn">Missing: {interp.missing.join(", ")}.</Notice>}
      {interp && (
        <Disclosure isDark={isDark} label={DISCLOSURE_LABELS.ai} icon="cpu">
          <Notice isDark={isDark} tone={interp.ai.status === "OK" ? "info" : "warn"}>
            <b>{interp.by === "ai" ? "Interpreted by the AI" : "Interpreted by the built-in rules"}</b>{interp.ai.status === "NOT_CONFIGURED" ? " — AI not configured" : interp.ai.status === "REJECTED" ? " — AI key rejected" : interp.ai.status === "ERROR" ? " — AI unavailable" : ""}.{interp.ai.message ? ` ${interp.ai.message}` : ""}
          </Notice>
        </Disclosure>
      )}
      {answer && (answer.kind === "order-explain" || answer.kind === "invoice-explain") && <Notice isDark={isDark} tone="info">{answer.message}</Notice>}
      {answer?.kind === "needs-input" && <Notice isDark={isDark} tone="warn">{answer.message}</Notice>}
      {answer?.kind === "decision-table" && <><Notice isDark={isDark} tone={answer.tables.some(x => x.stale) ? "warn" : "ok"}>{answer.message}</Notice><DecisionTableRefreshPanel isDark={isDark} /></>}
      {answer && (answer.kind === "order-result" || answer.kind === "order-explain") && answer.salesforce.orderId && <OrderRemediation key={answer.salesforce.orderId} isDark={isDark} orderId={answer.salesforce.orderId} onRunPrompt={runPrompt} />}
      {answer && "planError" in answer && answer.planError && <Notice isDark={isDark} tone="warn">{answer.planError}</Notice>}
      {answer && !("salesforce" in answer) && "plan" in answer && answer.plan && <TaxQueryAnswerView isDark={isDark} a={answer} />}
      {answer && "plan" in answer && answer.plan
        ? <CalculationPlanView isDark={isDark} onRunPrompt={runPrompt} initialPlan={answer.plan} initialSalesforce={"salesforce" in answer ? answer.salesforce : null} initial={{
            product: answer.query.productId ? { id: answer.query.productId } : { name: answer.query.product ?? answer.query.productCode }, account: answer.query.account ?? "",
            country: answer.query.country ?? "", state: answer.query.state ?? "", taxCode: answer.query.taxCode ?? "", rate: answer.query.rate !== null && answer.query.rate !== undefined ? String(answer.query.rate) : "",
            basis: answer.query.basis ?? "", quantity: answer.query.quantity ? String(answer.query.quantity) : "", unitPrice: answer.query.unitPrice !== null ? String(answer.query.unitPrice) : "", treatmentId: "", engineId: "" }} />
        : answer && "salesforce" in answer
        ? <SalesforceTaxPanel isDark={isDark} initial={{ result: answer.salesforce, product: answer.query.product ?? "", account: answer.query.account ?? "" }} />
        : answer && answer.kind !== "needs-input" && answer.kind !== "decision-table" && <TaxQueryAnswerView isDark={isDark} a={answer} />}
      {ops && <TaxAssistant key={ops.n} isDark={isDark} operations={ops.operations} preview={ops.preview} warnings={ops.warnings} onDone={onDone} />}
      {result && s && (
        <>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <Disclosure isDark={isDark} variant="card" icon="cpu" label={DISCLOSURE_LABELS.ai}>
            <div style={{ display: "grid", gap: 4, fontSize: 12.5, color: t.body }}>
              <div><b>Engine:</b> {s.engine?.type ?? "native Revenue Standard Tax"}{s.engine?.name ? ` "${s.engine.name}"` : ""} · <b>Country:</b> {s.country ?? "—"} · <b>Legal entity:</b> {s.legalEntity?.name ?? "(org default)"}</div>
              <div><b>Policy:</b> {s.policy.name ?? `${s.policy.suggestedName ?? "derived"} (suggested)`} · {s.policy.treatmentSelection ?? "Default"} selection</div>
              {s.treatments.map(x => <div key={x.key}><b>Treatment {x.key}:</b> {x.name ?? x.suggestedName ?? "—"} · {x.taxable ? (x.rate === 0 ? "zero-rated" : "taxable") : "exempt"}{x.rate !== null && x.rate !== undefined ? ` · ${x.rate}%` : ""}{x.taxCode ? ` · code ${x.taxCode}` : x.taxName ? ` · ${x.taxName}` : ""}{x.useItems ? " · per-product items" : ""}</div>)}
              {!!s.items.length && <div><b>Items:</b> {s.items.map(i => `${i.product.name} → ${i.taxCode ?? `${i.taxName ?? ""} ${i.rate ?? ""}%`}`).join(" · ")}</div>}
              {!!s.products.length && <div><b>Products:</b> {s.products.map(p => p.product.name).join(", ")}</div>}
              {result.transaction && <div><b>Test sale:</b> {result.transaction.productName ?? "—"} × {result.transaction.quantity ?? 1}{result.transaction.unitPrice ? ` at ${result.transaction.unitPrice}` : ""}{result.transaction.accountName ? ` to ${result.transaction.accountName}` : ""} — Salesforce calculates its tax after the configuration is verified.</div>}
            </div>
          </Disclosure>
            </div>
            <GhostButton label="Edit in Manual Configuration" icon="edit" isDark={isDark} onClick={() => onEdit(s)} />
          </div>
          <WarningsDisclosure isDark={isDark} warnings={result.warnings} />
          <ConfigFlow isDark={isDark} spec={s} plan={result.plan} setPlan={p => setResult(r => (r ? { ...r, plan: p } : r))} onDone={onDone} nav={nav} transaction={result.transaction} />
        </>
      )}
    </div>
  );
}

/* ───────────────────────────── Manual Configuration ───────────────────────────── */

type Kind = "taxable" | "exempt" | "zero";
interface TreatmentForm { key: string; name: string; kind: Kind; taxCode: string; taxName: string; rate: string; legalEntityId: string; useItems: boolean; isDefault: boolean }
interface ItemForm { key: string; treatmentKey: string; product: RecordRef | null; taxCode: string; rate: string }
interface ManualForm {
  engineMode: "existing" | "new"; engineId: string;
  engine: { name: string; type: string; providerId: string; namedCredentialId: string; sellerCode: string; street: string; city: string; state: string; postalCode: string; country: string };
  legalEntityId: string; country: string;
  policyMode: "existing" | "new"; policyId: string; policy: { name: string; description: string; selection: string };
  treatments: TreatmentForm[]; items: ItemForm[]; products: RecordRef[];
}
let seq = 0;
const key = (p: string) => `${p}${++seq}`;
const blankTreatment = (): TreatmentForm => ({ key: key("t"), name: "", kind: "taxable", taxCode: "", taxName: "", rate: "", legalEntityId: "", useItems: false, isDefault: false });
const blankForm = (): ManualForm => ({
  engineMode: "new", engineId: "", engine: { name: "", type: "RevenueStandardTax", providerId: "", namedCredentialId: "", sellerCode: "", street: "", city: "", state: "", postalCode: "", country: "" },
  legalEntityId: "", country: "", policyMode: "new", policyId: "", policy: { name: "", description: "", selection: "Default" },
  treatments: [blankTreatment()], items: [], products: [],
});
const orNull = (s: string) => (s.trim() ? s.trim() : null);
const numOrNull = (s: string) => (s.trim() && Number.isFinite(Number(s.replace("%", ""))) ? Number(s.replace("%", "")) : null);

export function formToSpec(f: ManualForm): TaxConfigSpec {
  const e = f.engine;
  return {
    engine: f.engineMode === "existing" ? { existingId: orNull(f.engineId) } : { name: orNull(e.name), type: orNull(e.type), providerId: orNull(e.providerId), namedCredentialId: orNull(e.namedCredentialId), sellerCode: orNull(e.sellerCode), address: { street: orNull(e.street), city: orNull(e.city), state: orNull(e.state), postalCode: orNull(e.postalCode), country: orNull(e.country) } },
    legalEntity: f.legalEntityId ? { id: f.legalEntityId } : null,
    country: orNull(f.country),
    policy: f.policyMode === "existing" ? { existingId: orNull(f.policyId) } : { name: orNull(f.policy.name), description: orNull(f.policy.description), treatmentSelection: orNull(f.policy.selection) },
    treatments: f.treatments.map(t => ({ key: t.key, name: orNull(t.name), taxable: t.kind !== "exempt", taxCode: t.kind === "exempt" ? null : orNull(t.taxCode), taxName: orNull(t.taxName), rate: t.kind === "zero" ? 0 : t.kind === "exempt" ? null : numOrNull(t.rate), legalEntity: t.legalEntityId ? { id: t.legalEntityId } : null, useItems: t.useItems || f.items.some(i => i.treatmentKey === t.key), isDefault: t.isDefault })),
    items: f.items.filter(i => i.product).map(i => ({ treatmentKey: i.treatmentKey, product: i.product!, taxCode: orNull(i.taxCode), rate: numOrNull(i.rate) })),
    products: f.products.map(p => ({ product: p })),
  };
}
export function specToForm(s: TaxConfigSpec): ManualForm {
  const f = blankForm();
  if (s.engine?.existingId) { f.engineMode = "existing"; f.engineId = s.engine.existingId; }
  else if (s.engine) f.engine = { ...f.engine, name: s.engine.name ?? "", type: s.engine.type ?? f.engine.type, providerId: s.engine.providerId ?? "", sellerCode: s.engine.sellerCode ?? "" };
  f.legalEntityId = s.legalEntity?.id ?? "";
  f.country = s.country ?? "";
  if (s.policy.existingId) { f.policyMode = "existing"; f.policyId = s.policy.existingId; }
  else f.policy = { name: s.policy.name ?? s.policy.suggestedName ?? "", description: s.policy.description ?? "", selection: s.policy.treatmentSelection ?? "Default" };
  f.treatments = s.treatments.map(t => ({ key: t.key, name: t.name ?? t.suggestedName ?? "", kind: !t.taxable ? "exempt" : t.rate === 0 ? "zero" : "taxable", taxCode: t.taxCode ?? "", taxName: t.taxName ?? "", rate: t.rate === null || t.rate === undefined ? "" : String(t.rate), legalEntityId: t.legalEntity?.id ?? "", useItems: !!t.useItems, isDefault: !!t.isDefault }));
  if (!f.treatments.length) f.treatments = [blankTreatment()];
  f.items = s.items.map(i => ({ key: key("i"), treatmentKey: i.treatmentKey, product: i.product, taxCode: i.taxCode ?? "", rate: i.rate === null || i.rate === undefined ? "" : String(i.rate) }));
  f.products = s.products.map(p => p.product);
  return f;
}

function ProductPicker({ isDark, onPick, label = "Add product" }: { isDark: boolean; onPick: (p: RecordRef) => void; label?: string }) {
  const t = tokens(isDark);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ProductRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  async function search() {
    setBusy(true);
    try { setHits((await quoteApiGet<{ products: ProductRow[] }>("Search products", `/api/billing/tax/products?q=${encodeURIComponent(q)}`)).products); } catch { setHits([]); } finally { setBusy(false); }
  }
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} placeholder="Search Salesforce products by name or code" style={{ ...inputStyle(t), padding: "7px 10px" }} />
        <GhostButton label={busy ? "Searching…" : label} icon="search" isDark={isDark} disabled={busy} onClick={() => void search()} />
      </div>
      {hits && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {!hits.length && <span style={{ fontSize: 12, color: t.dim }}>No products match.</span>}
          {hits.map(p => (
            <button key={p.id} type="button" disabled={!p.active} onClick={() => { onPick({ id: p.id, name: p.name }); setHits(null); setQ(""); }}
              style={{ fontSize: 12, padding: "4px 9px", borderRadius: 999, border: `1px solid ${t.border}`, background: "transparent", color: p.active ? t.body : t.dim, cursor: p.active ? "pointer" : "not-allowed" }}>
              {p.name}{p.code ? ` · ${p.code}` : ""}{p.active ? "" : " (inactive)"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LegalEntitySelect({ isDark, entities, value, onChange, allowDefault }: { isDark: boolean; entities: TaxDashboard["legalEntities"]; value: string; onChange: (v: string) => void; allowDefault: string }) {
  const t = tokens(isDark);
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{ ...inputStyle(t), padding: "7px 10px" }}>
      <option value="">{allowDefault}</option>
      {entities.map(l => <option key={l.id} value={l.id} disabled={!!l.status && l.status !== "Active"}>{l.name}{l.status && l.status !== "Active" ? ` (${l.status})` : ""}</option>)}
    </select>
  );
}

function Manual({ isDark, initial, conn, onDone, nav }: { isDark: boolean; initial: TaxConfigSpec | null; conn: string; onDone: () => void; nav: CreateNav }) {
  const t = tokens(isDark);
  const meta = useBillingData<MetadataResponse>("Read tax metadata", withConnection("/api/billing/tax/metadata", conn));
  const dash = useBillingData<TaxDashboard>("Load tax configuration", withConnection("/api/billing/tax", conn));
  const [f, setF] = useState<ManualForm>(() => (initial ? specToForm(initial) : blankForm()));
  const [plan, setPlan] = useState<TaxPlan | null>(null);
  const [planSpec, setPlanSpec] = useState<TaxConfigSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const set = (patch: Partial<ManualForm>) => { setF(x => ({ ...x, ...patch })); setPlan(null); };
  const setT = (k: string, patch: Partial<TreatmentForm>) => set({ treatments: f.treatments.map(x => (x.key === k ? { ...x, ...patch } : patch.isDefault ? { ...x, isDefault: false } : x)) });
  const setI = (k: string, patch: Partial<ItemForm>) => set({ items: f.items.map(x => (x.key === k ? { ...x, ...patch } : x)) });
  if (!meta.data || !dash.data) return (meta.error || dash.error) ? <ErrorPanel isDark={isDark} error={(meta.error ?? dash.error)!} /> : <LoadingRow isDark={isDark} label="Reading the org's tax metadata…" />;
  const m = meta.data, d = dash.data;
  const pick = (obj: string, field: string) => { const o = m.objects[obj]; return o?.exists ? (o.fields[field]?.picklist ?? []) : []; };
  const has = (obj: string, field: string) => { const o = m.objects[obj]; return !!(o?.exists && o.fields[field]); };
  const input = { ...inputStyle(t), padding: "7px 10px" };
  const codes = [...new Set(d.rates.map(r => r.taxCode).filter((c): c is string => !!c))];
  async function preview() {
    setBusy(true); setError(null);
    const spec = formToSpec(f);
    try { setPlan(await quoteApiPost<TaxPlan>("Preview tax configuration", "/api/billing/tax/plan", { spec })); setPlanSpec(spec); }
    catch (err) { setError(toBillingErrorPanel(err, "Preview failed")); } finally { setBusy(false); }
  }
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 } as const;
  const leSelect = (value: string, onChange: (v: string) => void, allowDefault: string) => <LegalEntitySelect isDark={isDark} entities={d.legalEntities} value={value} onChange={onChange} allowDefault={allowDefault} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {m.problems.map(p => <Notice key={p} isDark={isDark} tone="error">{p}</Notice>)}
      <Panel isDark={isDark} title="1 · Tax Engine" icon="cpu">
        <div style={{ display: "flex", gap: 14, marginBottom: 8, fontSize: 12.5, color: t.body }}>
          <label><input type="radio" checked={f.engineMode === "existing"} onChange={() => set({ engineMode: "existing" })} /> Use an existing engine</label>
          <label><input type="radio" checked={f.engineMode === "new"} onChange={() => set({ engineMode: "new" })} /> New engine (reused automatically if an equivalent active one exists)</label>
        </div>
        {f.engineMode === "existing" ? (
          <select value={f.engineId} onChange={e => set({ engineId: e.target.value })} style={input}>
            <option value="">— choose —</option>
            {d.engines.map(e => <option key={e.id} value={e.id}>{e.name} · {e.type} · {e.status}</option>)}
          </select>
        ) : (
          <div style={grid}>
            <Field label="Tax Engine Name" isDark={isDark}><input value={f.engine.name} onChange={e => set({ engine: { ...f.engine, name: e.target.value } })} placeholder="Revenue Standard Tax Engine" style={input} /></Field>
            <Field label="Tax Engine Type" isDark={isDark}><select value={f.engine.type} onChange={e => set({ engine: { ...f.engine, type: e.target.value } })} style={input}>{pick("TaxEngine", "Type").map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
            <Field label="Tax Engine Provider" isDark={isDark} hint="Required for external engines; the native Revenue Standard Tax engine needs none."><select value={f.engine.providerId} onChange={e => set({ engine: { ...f.engine, providerId: e.target.value } })} style={input}><option value="">— none —</option>{m.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            {has("TaxEngine", "MerchantCredentialId") && <Field label="Named Credential" isDark={isDark}><select value={f.engine.namedCredentialId} onChange={e => set({ engine: { ...f.engine, namedCredentialId: e.target.value } })} style={input}><option value="">— none —</option>{m.namedCredentials.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
            {has("TaxEngine", "SellerCode") && <Field label="Seller Code" isDark={isDark}><input value={f.engine.sellerCode} onChange={e => set({ engine: { ...f.engine, sellerCode: e.target.value } })} style={input} /></Field>}
            {has("TaxEngine", "TaxEngineStreet") && <Field label="Street" isDark={isDark}><input value={f.engine.street} onChange={e => set({ engine: { ...f.engine, street: e.target.value } })} style={input} /></Field>}
            {has("TaxEngine", "TaxEngineCity") && <Field label="City" isDark={isDark}><input value={f.engine.city} onChange={e => set({ engine: { ...f.engine, city: e.target.value } })} style={input} /></Field>}
            {has("TaxEngine", "TaxEngineState") && <Field label="State" isDark={isDark}><input value={f.engine.state} onChange={e => set({ engine: { ...f.engine, state: e.target.value } })} style={input} /></Field>}
            {has("TaxEngine", "TaxEnginePostalCode") && <Field label="Postal Code" isDark={isDark}><input value={f.engine.postalCode} onChange={e => set({ engine: { ...f.engine, postalCode: e.target.value } })} style={input} /></Field>}
            {has("TaxEngine", "TaxEngineCountry") && <Field label="Country" isDark={isDark}><input value={f.engine.country} onChange={e => set({ engine: { ...f.engine, country: e.target.value } })} style={input} /></Field>}
          </div>
        )}
      </Panel>
      <Panel isDark={isDark} title="2 · Tax Policy" icon="shield">
        <div style={{ display: "flex", gap: 14, marginBottom: 8, fontSize: 12.5, color: t.body }}>
          <label><input type="radio" checked={f.policyMode === "existing"} onChange={() => set({ policyMode: "existing" })} /> Add to an existing policy</label>
          <label><input type="radio" checked={f.policyMode === "new"} onChange={() => set({ policyMode: "new" })} /> New policy</label>
        </div>
        {f.policyMode === "existing" ? (
          <select value={f.policyId} onChange={e => set({ policyId: e.target.value })} style={input}>
            <option value="">— choose —</option>
            {d.policies.map(p => <option key={p.id} value={p.id}>{p.name} · {p.selection} · {p.status} · {p.products} product(s)</option>)}
          </select>
        ) : (
          <div style={grid}>
            <Field label="Name" isDark={isDark}><input value={f.policy.name} onChange={e => set({ policy: { ...f.policy, name: e.target.value } })} placeholder="India GST Policy" style={input} /></Field>
            <Field label="Treatment Selection" isDark={isDark} hint={f.policy.selection === "Default" ? "Default: one default treatment applies to every product of the policy." : f.policy.selection === "Manual" ? "Manual: the treatment is chosen explicitly on each transaction line." : "Legal Entity: the treatment is resolved from the selling legal entity."}>
              <select value={f.policy.selection} onChange={e => set({ policy: { ...f.policy, selection: e.target.value } })} style={input}>{pick("TaxPolicy", "TreatmentSelection").map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
            </Field>
            <Field label="Description" isDark={isDark}><input value={f.policy.description} onChange={e => set({ policy: { ...f.policy, description: e.target.value } })} style={input} /></Field>
          </div>
        )}
      </Panel>
      <Panel isDark={isDark} title="3 · Tax Treatments" icon="layers" right={<GhostButton label="Add treatment" icon="plus" isDark={isDark} onClick={() => set({ treatments: [...f.treatments, blankTreatment()] })} />}>
        <datalist id="tax-codes">{codes.map(c => <option key={c} value={c} />)}</datalist>
        <div style={{ display: "grid", gap: 10 }}>
          {f.treatments.map((x, n) => (
            <div key={x.key} style={{ border: `1px solid ${t.border}`, borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
              <div style={grid}>
                <Field label={`Treatment ${n + 1} name`} isDark={isDark} hint="Blank: an equivalent existing treatment is reused, or a name is derived."><input value={x.name} onChange={e => setT(x.key, { name: e.target.value })} placeholder="GST Standard" style={input} /></Field>
                <Field label="Taxability" isDark={isDark}><select value={x.kind} onChange={e => setT(x.key, { kind: e.target.value as Kind })} style={input}><option value="taxable">Taxable</option><option value="zero">Zero-rated (taxable at 0%)</option><option value="exempt">Tax exempt (not taxable)</option></select></Field>
                {x.kind !== "exempt" && <Field label="Tax Code" isDark={isDark} hint="An existing code, or a new one with its rate."><input list="tax-codes" value={x.taxCode} onChange={e => setT(x.key, { taxCode: e.target.value })} style={input} /></Field>}
                {x.kind === "taxable" && <Field label="Rate %" isDark={isDark}><input value={x.rate} onChange={e => setT(x.key, { rate: e.target.value })} placeholder="18" style={input} /></Field>}
                {x.kind !== "exempt" && !x.taxCode && <Field label="Tax name" isDark={isDark} hint="Used to name a new code (GST + 18 → GST18)."><input value={x.taxName} onChange={e => setT(x.key, { taxName: e.target.value })} placeholder="GST" style={input} /></Field>}
                <Field label="Legal Entity" isDark={isDark}>{leSelect(x.legalEntityId, v => setT(x.key, { legalEntityId: v }), "(configuration legal entity)")}</Field>
              </div>
              <div style={{ display: "flex", gap: 14, fontSize: 12.5, color: t.body, flexWrap: "wrap" }}>
                {has("TaxTreatment", "ShouldUseTaxTreatmentItems") && <label><input type="checkbox" checked={x.useItems} onChange={e => setT(x.key, { useItems: e.target.checked })} /> Use Tax Treatment Items (tax code per product)</label>}
                <label><input type="radio" name="default-treatment" checked={x.isDefault} onChange={() => setT(x.key, { isDefault: true })} /> Default treatment of the policy</label>
                {f.treatments.length > 1 && <GhostButton label="Remove" isDark={isDark} danger onClick={() => set({ treatments: f.treatments.filter(y => y.key !== x.key), items: f.items.filter(i => i.treatmentKey !== x.key) })} />}
              </div>
            </div>
          ))}
        </div>
      </Panel>
      <Panel isDark={isDark} title="4 · Tax Treatment Items" icon="list">
        {!f.treatments.some(x => x.useItems) ? <div style={{ fontSize: 12.5, color: t.dim }}>Turn on &quot;Use Tax Treatment Items&quot; on a treatment to give products their own tax codes without a treatment per product.</div> : (
          <div style={{ display: "grid", gap: 8 }}>
            {f.items.map(i => (
              <div key={i.key} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 0.8fr 0.6fr auto", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                <span style={{ color: t.heading, fontWeight: 600 }}>{i.product?.name ?? "—"}</span>
                <select value={i.treatmentKey} onChange={e => setI(i.key, { treatmentKey: e.target.value })} style={input}>{f.treatments.filter(x => x.useItems).map(x => <option key={x.key} value={x.key}>{x.name || x.key}</option>)}</select>
                <input list="tax-codes" value={i.taxCode} onChange={e => setI(i.key, { taxCode: e.target.value })} placeholder="Tax code" style={input} />
                <input value={i.rate} onChange={e => setI(i.key, { rate: e.target.value })} placeholder="Rate %" style={input} />
                <GhostButton label="Remove" isDark={isDark} danger onClick={() => set({ items: f.items.filter(y => y.key !== i.key) })} />
              </div>
            ))}
            <ProductPicker isDark={isDark} label="Add item" onPick={p => set({ items: [...f.items, { key: key("i"), treatmentKey: f.treatments.find(x => x.useItems)!.key, product: p, taxCode: "", rate: "" }] })} />
          </div>
        )}
      </Panel>
      <Panel isDark={isDark} title="5 · Product Mapping" icon="package">
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {f.products.map(p => <span key={p.id ?? p.name} style={{ fontSize: 12, padding: "4px 9px", borderRadius: 999, border: `1px solid ${t.border}`, color: t.body }}>{p.name} <button type="button" onClick={() => set({ products: f.products.filter(x => x !== p) })} style={{ border: "none", background: "none", color: t.dim, cursor: "pointer" }}>✕</button></span>)}
            {!f.products.length && <span style={{ fontSize: 12, color: t.dim }}>Products on Tax Treatment Items are mapped automatically.</span>}
          </div>
          <ProductPicker isDark={isDark} onPick={p => set({ products: f.products.some(x => x.id === p.id) ? f.products : [...f.products, p] })} />
          <div style={{ fontSize: 11.5, color: t.dim }}>Each product&apos;s Salesforce tax policy (Product2 → Tax Policy) is set to this policy.</div>
        </div>
      </Panel>
      <Panel isDark={isDark} title="6 · Legal Entity & Country" icon="building">
        <div style={grid}>
          <Field label="Legal Entity" isDark={isDark} hint="Resolved, never created. Blank uses the org's only active legal entity.">{leSelect(f.legalEntityId, v => set({ legalEntityId: v }), "(org's only active legal entity)")}</Field>
          <Field label="Tax Country" isDark={isDark} hint="ISO-2 or name; tax rates are keyed by country."><input value={f.country} onChange={e => set({ country: e.target.value })} placeholder="IN / India" style={input} /></Field>
        </div>
      </Panel>
      <Panel isDark={isDark} title="7 · Review & Create" icon="check-square">
        <PrimaryButton label={busy ? "Resolving in Salesforce…" : "Preview Configuration"} icon="eye" isDark={isDark} disabled={busy} onClick={() => void preview()} />
      </Panel>
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {plan && planSpec && <ConfigFlow isDark={isDark} spec={planSpec} plan={plan} setPlan={setPlan} onDone={() => { dash.reload(); onDone(); }} nav={nav} />}
    </div>
  );
}

export default function TaxCreate({ isDark, conn, onDone, nav, initialTab = "ai", assistant = false }: { isDark: boolean; conn: string; onDone: () => void; nav: CreateNav; initialTab?: "ai" | "manual"; assistant?: boolean }) {
  const [tab, setTab] = useState<"ai" | "manual">(initialTab);
  const [seed, setSeed] = useState<{ spec: TaxConfigSpec; n: number } | null>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Tabs isDark={isDark} tabs={[{ id: "ai", label: "AI Prompt", icon: "sparkles" }, { id: "manual", label: "Manual Configuration", icon: "edit" }]} active={tab} onChange={id => setTab(id as "ai" | "manual")} />
      {tab === "ai"
        ? <AiPrompt key={conn} isDark={isDark} onDone={onDone} nav={nav} assistant={assistant} onEdit={spec => { setSeed({ spec, n: Date.now() }); setTab("manual"); }} />
        : <Manual key={`${conn}:${seed?.n ?? 0}`} isDark={isDark} conn={conn} initial={seed?.spec ?? null} onDone={onDone} nav={nav} />}
    </div>
  );
}
