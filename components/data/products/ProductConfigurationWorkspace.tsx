"use client";

import { useEffect, useState } from "react";
import { tokens, inputStyle, PrimaryButton, GhostButton, ErrorPanel, Field } from "@/components/data/quotes/shared";
import { Panel, Modal, LoadingRow } from "@/components/data/billing/billingUi";
import { Notice } from "@/components/data/billing/tax/taxUi";
import { quoteApiGet, quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import { useNotify } from "@/components/notifications/SalesforceSuccessContext";
import { ProductConfigurationPanel, UpdatePlanView, type UpdatePlanLike } from "@/components/data/products/ProductConfigViews";
import type { ProductConfiguration, RecordRef, RelationKey, RelationRequest } from "@/lib/products/revenueConfig";
import PromptGuide from "@/components/ai/PromptGuide";
import { taxConfigPromptGuides } from "@/lib/ai/promptGuides/taxConfig";

/**
 * Products → Product Configuration: the central configuration view of a Revenue Cloud product. Show it ("Show me the
 * configuration of X"), or change ONLY what is asked ("Update X and assign the OmniCloud India Tax Policy", "Change the Unit of
 * Measure to Each", "Change the price to 2500") — every change is previewed before → after and executed only after confirmation,
 * then re-read from Salesforce.
 */

interface Change { relations?: RelationRequest; ids?: Partial<Record<RelationKey, string>>; unitOfMeasure?: string | null; unitPrice?: string | null; priceBook?: string | null }
type Plan = UpdatePlanLike & { productId: string; before: ProductConfiguration };
interface CommandResponse { success: boolean; command: { kind: string }; productId?: string; configuration?: ProductConfiguration; plan?: Plan; error?: string; candidates?: (RecordRef & { code: string | null })[] }
interface ExecuteResponse { success: boolean; after: ProductConfiguration | null; verification: { label: string; expected: string | null; actual: string | null; passed: boolean }[]; errors: string[]; plan: Plan }

const EXAMPLES = [
  "Show me the configuration of OmniCloud Prompt E2E Quantum Laptop 2026",
  "Update OmniCloud Prompt E2E Quantum Laptop 2026 and assign the OmniCloud India Tax Policy.",
  "Change the Unit of Measure to Each.",
  "Assign Billing Policy OmniCloud Prompt E2E Billing Policy.",
  "Change the price to 2500.",
];

export default function ProductConfigurationWorkspace({ isDark, initialProductId, initialPrompt }: { isDark: boolean; initialProductId?: string | null; initialPrompt?: string | null }) {
  const t = tokens(isDark);
  const [ref, setRef] = useState("");
  const [productId, setProductId] = useState<string | null>(initialProductId ?? null);
  const [config, setConfig] = useState<ProductConfiguration | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [change, setChange] = useState<Change | null>(null);
  const [form, setForm] = useState({ taxPolicy: "", billingPolicy: "", unitOfMeasure: "", unitPrice: "" });
  const [uoms, setUoms] = useState<string[] | null>(null);
  const [candidates, setCandidates] = useState<(RecordRef & { code: string | null })[]>([]);
  const [outcome, setOutcome] = useState<ExecuteResponse | null>(null);
  const notifier = useNotify();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => { quoteApiGet<{ unitsOfMeasure: { value: string }[] }>("Load units of measure", "/api/sf/products/options").then(r => setUoms(r.unitsOfMeasure.map(u => u.value))).catch(() => setUoms(null)); }, []);
  // Opened from Product History → Configuration: read that product once.
  useEffect(() => {
    if (!initialProductId) return;
    let cancelled = false;
    quoteApiGet<{ configuration: ProductConfiguration }>("Product configuration", `/api/sf/products/${encodeURIComponent(initialProductId)}/configuration`)
      .then(r => { if (!cancelled) { setConfig(r.configuration); setProductId(initialProductId); } })
      .catch(err => { if (!cancelled) setError(toBillingErrorPanel(err, "Could not read the product configuration")); });
    return () => { cancelled = true; };
  }, [initialProductId]);
  async function runCommand(text: string, pid: string | null = productId) {
    setBusy("Interpreting the request…"); setError(null); setNote(null); setPlan(null); setOutcome(null); setCandidates([]);
    try {
      const res = await fetch("/api/sf/products/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: text, productId: pid }) });
      const r = (await res.json()) as CommandResponse & { command?: { kind: string; change?: Change } };
      if (!res.ok || !r.success) { setCandidates(r.candidates ?? []); setNote(r.error ?? "The request failed."); return; }
      if (r.command.kind === "create") { setNote("That's a create request — use Products → Create Product (it supports tax and billing configuration too)."); return; }
      if (r.productId) setProductId(r.productId);
      if (r.configuration) setConfig(r.configuration);
      if (r.plan) { setPlan(r.plan); setConfig(r.plan.before); const c = (r.command as { change?: Change }).change ?? {}; setChange({ relations: c.relations, unitOfMeasure: c.unitOfMeasure ?? null, unitPrice: c.unitPrice ?? null, priceBook: c.priceBook ?? null, ids: {} }); }
    } catch (err) { setError(toBillingErrorPanel(err, "The product request failed")); }
    finally { setBusy(null); }
  }
  async function preview(next: Change) {
    if (!productId) return;
    setBusy("Building the preview…"); setError(null); setOutcome(null);
    try { const r = await quoteApiPost<{ plan: Plan }>("Preview product changes", `/api/sf/products/${encodeURIComponent(productId)}/configuration`, { action: "preview", change: next }); setPlan(r.plan); setChange(next); setConfig(r.plan.before); }
    catch (err) { setError(toBillingErrorPanel(err, "The preview failed")); }
    finally { setBusy(null); }
  }
  async function execute() {
    if (!productId || !change) return;
    setConfirming(false); setBusy("Applying the changes in Salesforce and re-reading the product…"); setError(null);
    try {
      const res = await fetch(`/api/sf/products/${encodeURIComponent(productId)}/configuration`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "execute", change }) });
      const r = (await res.json()) as ExecuteResponse & { error?: string };
      if (!res.ok && !r.plan) { setNote(r.error ?? "Nothing was changed."); return; }
      setOutcome(r); setPlan(r.plan); if (r.after) setConfig(r.after);
      if (r.success) notifier.success("Product Configuration Updated", `${r.after?.product?.name ?? "The product"} was updated in Salesforce and re-read to verify the change.`, { module: "Products", records: r.after ? [{ objectApiName: "Product2", recordId: r.after.product.id, recordName: r.after.product.name, salesforceUrl: "" }] : [] });
      else if (r.errors.length) notifier.error("Product Configuration Not Fully Applied", r.errors[0], { module: "Products" });
    } catch (err) { setError(toBillingErrorPanel(err, "The update failed")); }
    finally { setBusy(null); }
  }
  const pick = (key: RelationKey, id: string) => { if (change) void preview({ ...change, ids: { ...(change.ids ?? {}), [key]: id } }); };
  const canExecute = !!plan && plan.changes.length > 0 && plan.blockers.length === 0 && !outcome;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel isDark={isDark} title="Product Configuration" icon="package">
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
            <Field label="Product (name, code or Id)" isDark={isDark}><input value={ref} onChange={e => setRef(e.target.value)} placeholder="e.g. OmniCloud Prompt E2E Quantum Laptop 2026" style={{ ...inputStyle(t), minWidth: 340 }} /></Field>
            <GhostButton label="Show configuration" icon="search" isDark={isDark} disabled={!ref.trim() || !!busy} onClick={() => void runCommand(`Show me the configuration of ${ref.trim()}`, null)} />
          </div>
          <Field label="Or ask (show / update)" isDark={isDark}><textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2} placeholder='e.g. "Update OmniCloud Prompt E2E Quantum Laptop 2026 and assign the OmniCloud India Tax Policy."' style={{ ...inputStyle(t), width: "100%", resize: "vertical" }} /></Field>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{EXAMPLES.map(x => <button key={x} type="button" onClick={() => setPrompt(x)} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, border: `1px solid ${t.border}`, background: "transparent", color: t.dim, cursor: "pointer" }}>{x}</button>)}</div>
          <div><PrimaryButton label="Run" icon="zap" isDark={isDark} disabled={!prompt.trim() || !!busy} onClick={() => void runCommand(prompt.trim())} /></div>
          <div style={{ fontSize: 11.5, color: t.dim }}>Show is read-only. An update only changes what you asked for, shows before → after first, and runs after you confirm. Tax and Billing Policies are Product2 fields; treatments, items and the engine are related records resolved through the policy.</div>
          <PromptGuide isDark={isDark} config={taxConfigPromptGuides.productConfiguration} onUseExample={setPrompt} />
        </div>
      </Panel>
      {busy && <LoadingRow isDark={isDark} label={busy} />}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {note && <Notice isDark={isDark} tone="warn">{note}</Notice>}
      {candidates.length > 0 && <Notice isDark={isDark} tone="info"><b>Choose the product:</b> {candidates.map(c => <button key={c.id} type="button" onClick={() => { setRef(c.id); void runCommand(prompt.trim() || `Show me the configuration of ${c.id}`, c.id); }} style={{ marginLeft: 6, fontSize: 11.5, padding: "2px 8px", borderRadius: 6, border: `1px solid ${t.border}`, background: "transparent", color: t.body, cursor: "pointer" }}>{c.name} · {c.code ?? "—"} · {c.id}</button>)}</Notice>}
      {productId && config && (
        <Panel isDark={isDark} title="Change configuration" icon="edit">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 8, alignItems: "end" }}>
            <Field label="Tax Policy (name)" isDark={isDark}><input value={form.taxPolicy} onChange={e => setForm({ ...form, taxPolicy: e.target.value })} placeholder={config.tax.policy.record?.name ?? "not assigned"} style={inputStyle(t)} /></Field>
            <Field label="Billing Policy (name)" isDark={isDark}><input value={form.billingPolicy} onChange={e => setForm({ ...form, billingPolicy: e.target.value })} placeholder={config.billing.policy.record?.name ?? "not assigned"} style={inputStyle(t)} /></Field>
            <Field label="Unit of Measure" isDark={isDark}>{uoms ? <select value={form.unitOfMeasure} onChange={e => setForm({ ...form, unitOfMeasure: e.target.value })} style={inputStyle(t)}><option value="">(unchanged — {config.product.unitOfMeasure.value ?? "none"})</option>{uoms.map(u => <option key={u} value={u}>{u}</option>)}</select> : <input value={form.unitOfMeasure} onChange={e => setForm({ ...form, unitOfMeasure: e.target.value })} placeholder="validated against Salesforce" style={inputStyle(t)} />}</Field>
            <Field label="Unit Price (Standard Price Book)" isDark={isDark}><input type="number" value={form.unitPrice} onChange={e => setForm({ ...form, unitPrice: e.target.value })} placeholder={String(config.revenue.pricebookEntries.find(e => e.pricebook.isStandard)?.unitPrice ?? "")} style={inputStyle(t)} /></Field>
            <GhostButton label="Preview changes" icon="eye" isDark={isDark} disabled={!!busy || !(form.taxPolicy || form.billingPolicy || form.unitOfMeasure || form.unitPrice)} onClick={() => void preview({ relations: { ...(form.taxPolicy ? { taxPolicy: form.taxPolicy } : {}), ...(form.billingPolicy ? { billingPolicy: form.billingPolicy } : {}) }, unitOfMeasure: form.unitOfMeasure || null, unitPrice: form.unitPrice || null, ids: {} })} />
          </div>
        </Panel>
      )}
      {plan && <UpdatePlanView isDark={isDark} plan={plan} onPick={outcome ? undefined : pick} />}
      {canExecute && <div><PrimaryButton label="Apply changes…" icon="check" isDark={isDark} disabled={!!busy} onClick={() => setConfirming(true)} /></div>}
      {outcome && <Notice isDark={isDark} tone={outcome.success ? "ok" : "error"}>{outcome.success ? "Applied and verified in Salesforce." : `Not fully applied: ${[...outcome.errors, ...outcome.verification.filter(v => !v.passed).map(v => `${v.label}: expected ${v.expected}, Salesforce has ${v.actual ?? "nothing"}`)].join(" · ")}`}</Notice>}
      {config && <ProductConfigurationPanel isDark={isDark} c={config} verification={outcome?.verification} title={outcome ? "Configuration after the change (re-read from Salesforce)" : "Current configuration (read from Salesforce)"} />}
      {confirming && plan && (
        <Modal isDark={isDark} title="Apply these changes in Salesforce?" tone="warn" actions={<>
          <GhostButton label="Back" isDark={isDark} onClick={() => setConfirming(false)} />
          <PrimaryButton label="Apply" icon="check" isDark={isDark} disabled={!!busy} onClick={() => void execute()} />
        </>}>
          <div style={{ fontSize: 12.5, display: "grid", gap: 4 }}>
            {plan.changes.map(c => <div key={c.field}>• <b>{c.label}</b>: {c.from ?? "—"} → <b>{c.to}</b> <span style={{ opacity: 0.7 }}>({c.storage})</span></div>)}
            <div style={{ opacity: 0.8 }}>Nothing else on the product is changed.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}
