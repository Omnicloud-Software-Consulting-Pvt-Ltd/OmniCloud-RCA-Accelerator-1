"use client";

import { useState } from "react";
import { tokens, GhostButton, PrimaryButton, Spinner, CodeBlock } from "@/components/data/quotes/shared";
import { Modal } from "@/components/data/billing/billingUi";
import { quoteApiPost, toErrorPanelData } from "@/lib/quotes/client/apiClient";
import { useNotify } from "@/components/notifications/SalesforceSuccessContext";
import type { RampCapabilities } from "@/lib/ramp/capabilities";
import type { ProductFacts, Reason, SellingModelFacts } from "@/lib/ramp/eligibility";
import type { SalesforceCall } from "@/lib/ramp/types";
import { Field, Notice, Panel, RecordPicker, SelectIn, SfId, TextIn, useRampGet } from "./rampUi";
import RampAiAssist, { uiConflicts, type AiApplyOutcome } from "./RampAiAssist";
import { mergeAiPatch } from "@/lib/ramp/aiSchema";
import { RAMP_FIELD_HELP as H } from "@/lib/ramp/help";
import type { RampAiFormResult } from "@/lib/ramp/server/aiForms";

type PrsForm = { productId: string | null; productName: string | null; sellingModelId: string; segmentType: string; trialDuration: string; durationType: string };
const EMPTY_FORM = { sellingModelId: "", segmentType: "", trialDuration: "", durationType: "" };

type SegRow = { id: string; name: string | null; sellingModelId: string; sellingModelName: string | null; segmentType: string | null; trialDuration: number | null; durationType: string | null; createdDate: string | null };
type ProductDetail = { product: ProductFacts | null; sellingModels: SellingModelFacts[]; segments: SegRow[]; eligibility: { eligible: boolean; reasons: Reason[]; termModels: SellingModelFacts[] } };
type CreateResult = { success: boolean; ok: boolean; message: string; segmentId: string | null; reused: boolean; canRamp: boolean | null; calls: SalesforceCall[] };

/** Product Ramp Setup — makes a product rampable by creating its ProductRampSegment (the only Salesforce write here, confirmed). */
export default function ProductRampSetup({ isDark, caps, instanceUrl }: { isDark: boolean; caps: RampCapabilities | null; instanceUrl: string | null }) {
  const t = tokens(isDark);
  const notify = useNotify();
  const [onlyRampable, setOnlyRampable] = useState(false);
  const [product, setProduct] = useState<{ id: string; name: string } | null>(null);
  const detail = useRampGet<ProductDetail>("Read product", product ? `/api/ramp/lookup?type=product&productId=${encodeURIComponent(product.id)}` : null);
  const [form, setForm] = useState({ sellingModelId: "", segmentType: "", trialDuration: "", durationType: "" });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const prs = caps?.productRampSegment;
  const trial = form.segmentType === "FreeTrial";
  // AI: merge the validated, Salesforce-resolved result into THIS form (a product the user already picked is never replaced silently).
  const applyPrs = (p: Partial<PrsForm>) => {
    if (p.productId !== undefined) { setProduct(p.productId ? { id: p.productId, name: p.productName ?? p.productId } : null); setResult(null); }
    setForm(f => ({ ...f, ...Object.fromEntries(Object.entries(p).filter(([k, v]) => k in EMPTY_FORM && v !== undefined).map(([k, v]) => [k, v === null ? "" : String(v)])) }));
  };
  const onAi = (r: RampAiFormResult): AiApplyOutcome => {
    const current: PrsForm = { productId: product?.id ?? null, productName: product?.name ?? null, ...form };
    const patch: Partial<PrsForm> = {};
    for (const k of ["productId", "productName", "sellingModelId", "segmentType", "trialDuration", "durationType"] as const) if (r.patch[k] !== undefined && r.patch[k] !== null) (patch as Record<string, unknown>)[k] = k === "trialDuration" ? String(r.patch[k]) : r.patch[k];
    const m = mergeAiPatch<PrsForm>(current, patch, { defaults: { productId: null, productName: null, ...EMPTY_FORM }, replace: r.replace, refs: [{ key: "productId", with: ["productName"], resets: ["sellingModelId"] }, { key: "sellingModelId" }], labels: { productId: "Product", sellingModelId: "Selling model", segmentType: "Segment type", trialDuration: "Trial duration", durationType: "Duration type" } });
    const changed = Object.fromEntries(Object.entries(m.next).filter(([k, v]) => (current as Record<string, unknown>)[k] !== v)) as Partial<PrsForm>;
    if (Object.keys(changed).length) applyPrs({ ...changed, ...(changed.productId !== undefined ? { productName: m.next.productName } : {}) });
    return { applied: m.applied, conflicts: uiConflicts(m.conflicts, applyPrs) };
  };
  const formErrors = [
    !form.sellingModelId ? "Choose a term-defined selling model." : null,
    !form.segmentType ? "Choose a segment type." : null,
    trial && !(Number.isInteger(Number(form.trialDuration)) && Number(form.trialDuration) > 0) ? "Trial duration must be a whole number ≥ 1." : null,
    trial && !form.durationType ? "Choose the trial duration type." : null,
    detail.data?.segments.some(s => s.sellingModelId === form.sellingModelId && s.segmentType === form.segmentType) ? "A segment with this selling model and type already exists." : null,
  ].filter((x): x is string => !!x);

  const create = async () => {
    if (!product) return;
    setConfirm(false); setBusy(true); setErr(null); setResult(null);
    try {
      const r = await quoteApiPost<CreateResult>("Create Product Ramp Segment", "/api/ramp/product-segments", { confirmed: true, productId: product.id, sellingModelId: form.sellingModelId, segmentType: form.segmentType, trialDuration: trial ? Number(form.trialDuration) : null, durationType: trial ? form.durationType : null });
      setResult(r);
      if (r.ok) notify.success(r.reused ? "Existing segment reused" : "Product Ramp Segment created", r.message, { module: "RAMP" });
      detail.reload();
    } catch (e) { setErr(toErrorPanelData(e, "Couldn't create the segment").message); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Notice isDark={isDark} tone="info">A product can be ramped once it has a <b>Product Ramp Segment</b> for a term-defined selling model. Salesforce then shows <code>Product2.CanRamp = true</code> (CanRamp itself isn&apos;t writable through the API).</Notice>
      {prs && !prs.available && <Notice isDark={isDark} tone="warn"><b>Not available in this org:</b> {prs.reason}</Notice>}
      <RampAiAssist isDark={isDark} form="product-segment" helpKey="productSetup" title="Configure a Product Ramp Segment" context={{ productId: product?.id ?? null, productName: product?.name ?? null }} onResult={onAi} />
      <Panel isDark={isDark} title="Find a product" icon="package" right={<label style={{ fontSize: 12, color: t.body, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={onlyRampable} onChange={e => setOnlyRampable(e.target.checked)} /> Already rampable only</label>}>
        <RecordPicker<{ id: string; name: string; productCode: string | null; canRamp: boolean | null }> key={String(onlyRampable)} isDark={isDark} label="Product" required help={H.product} type="products" params={{ rampable: onlyRampable ? "1" : null, eligible: "1" }}
          hint="Active products with an active term-defined selling model (filtered in Salesforce)." value={{ id: product?.id ?? null, name: product?.name ?? null }}
          render={r => <span>{r.name} {r.productCode && <span style={{ color: t.dim, fontSize: 11 }}>{r.productCode}</span>} {r.canRamp && <span style={{ color: "#00C875", fontSize: 11 }}>· rampable</span>}</span>}
          onPick={r => { setProduct(r ? { id: r.id, name: r.name } : null); setResult(null); setForm(EMPTY_FORM); }} />
      </Panel>

      {product && (detail.loading ? <div style={{ display: "flex", gap: 6, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={12} /> Reading the product from Salesforce…</div>
        : detail.error ? <Notice isDark={isDark} tone="error">{detail.error}</Notice>
        : detail.data && (
          <>
            <Panel isDark={isDark} title={detail.data.product?.name ?? product.name} icon="package">
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12.5, color: t.body }}>
                <span>Id <SfId isDark={isDark} id={product.id} instanceUrl={instanceUrl} /></span>
                <span>Active: <b>{String(detail.data.product?.isActive ?? "—")}</b></span>
                <span>CanRamp: <b style={{ color: detail.data.product?.canRamp ? "#00C875" : t.warn }}>{String(detail.data.product?.canRamp ?? "—")}</b></span>
                <span>Usage model: <b>{detail.data.product?.usageModelType ?? "—"}</b></span>
              </div>
              {detail.data.eligibility.reasons.length > 0 && <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>{detail.data.eligibility.reasons.map((r, i) => <li key={i} style={{ color: r.severity === "error" ? t.error : t.warn }}>{r.message}</li>)}</ul>}
              <div style={{ fontSize: 11, fontWeight: 800, color: t.dim, textTransform: "uppercase" }}>Selling models</div>
              <div style={{ fontSize: 12.5, display: "grid", gap: 3 }}>{detail.data.sellingModels.length ? detail.data.sellingModels.map(m => <div key={m.id}>{m.name} · {m.type ?? "?"} · {m.status ?? "?"} <SfId isDark={isDark} id={m.id} instanceUrl={instanceUrl} /></div>) : <span style={{ color: t.dim }}>No selling model options.</span>}</div>
              <div style={{ fontSize: 11, fontWeight: 800, color: t.dim, textTransform: "uppercase" }}>Product Ramp Segments ({detail.data.segments.length})</div>
              {detail.data.segments.length ? (
                <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>{["Segment", "Selling model", "Type", "Trial", "Created"].map(h => <th key={h} style={{ padding: 5 }}>{h}</th>)}</tr></thead>
                  <tbody>{detail.data.segments.map(s => <tr key={s.id} style={{ borderTop: `1px solid ${t.border}` }}><td style={{ padding: 5 }}>{s.name} <SfId isDark={isDark} id={s.id} instanceUrl={instanceUrl} /></td><td style={{ padding: 5 }}>{s.sellingModelName ?? s.sellingModelId}</td><td style={{ padding: 5 }}>{s.segmentType}</td><td style={{ padding: 5 }}>{s.trialDuration ? `${s.trialDuration} ${s.durationType ?? ""}` : "—"}</td><td style={{ padding: 5, color: t.dim }}>{s.createdDate?.slice(0, 10) ?? "—"}</td></tr>)}</tbody>
                </table></div>
              ) : <span style={{ fontSize: 12, color: t.dim }}>None yet — create one below to make the product rampable.</span>}
            </Panel>

            <Panel isDark={isDark} title="Create Product Ramp Segment" icon="plus">
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Field isDark={isDark} label="Selling model (term-defined)" required help={H.sellingModel}><SelectIn isDark={isDark} ariaLabel="Selling model" value={form.sellingModelId} onChange={v => setForm({ ...form, sellingModelId: v })} options={detail.data.eligibility.termModels.map(m => ({ value: m.id, label: m.name }))} /></Field>
                <Field isDark={isDark} label="Segment type" required help={H.segmentType} hint="Values from this org's picklist."><SelectIn isDark={isDark} ariaLabel="Segment type" value={form.segmentType} onChange={v => setForm({ ...form, segmentType: v })} options={(prs?.segmentTypes ?? []).map(v => ({ value: v, label: v }))} /></Field>
                {trial && <Field isDark={isDark} label="Trial duration" required help={H.trialDuration} width={120}><TextIn isDark={isDark} type="number" ariaLabel="Trial duration" value={form.trialDuration} onChange={v => setForm({ ...form, trialDuration: v })} /></Field>}
                {trial && <Field isDark={isDark} label="Duration type" width={140}><SelectIn isDark={isDark} ariaLabel="Duration type" value={form.durationType} onChange={v => setForm({ ...form, durationType: v })} options={(prs?.durationTypes ?? []).map(v => ({ value: v, label: v }))} /></Field>}
              </div>
              {formErrors.length > 0 && <div style={{ fontSize: 12, color: t.dim }}>{formErrors.join(" ")}</div>}
              <div><PrimaryButton isDark={isDark} label={busy ? "Creating…" : "Create in Salesforce…"} icon="plus" disabled={busy || formErrors.length > 0 || !prs?.available} onClick={() => setConfirm(true)} /></div>
              {err && <Notice isDark={isDark} tone="error">{err}</Notice>}
              {result && <Notice isDark={isDark} tone={result.ok ? "ok" : "error"}>{result.message}{result.segmentId && <> — <SfId isDark={isDark} id={result.segmentId} instanceUrl={instanceUrl} /></>}{result.ok && <> · CanRamp read back: <b>{String(result.canRamp ?? "unknown")}</b></>}</Notice>}
              {result?.calls.length ? <CodeBlock isDark={isDark} label={`Salesforce requests (${result.calls.length})`} data={result.calls} /> : null}
            </Panel>
          </>
        ))}

      {confirm && product && (
        <Modal isDark={isDark} title="Create this Product Ramp Segment in Salesforce?" tone="warn" actions={<><GhostButton isDark={isDark} label="Cancel" onClick={() => setConfirm(false)} /><PrimaryButton isDark={isDark} label="Yes, create" icon="plus" onClick={() => void create()} /></>}>
          <div style={{ fontSize: 13 }}>Inserts one <code>ProductRampSegment</code> for <b>{product.name}</b> ({form.segmentType}{trial ? `, ${form.trialDuration} ${form.durationType}` : ""}). The app re-checks for duplicates right before inserting and reads the record back.</div>
        </Modal>
      )}
    </div>
  );
}
