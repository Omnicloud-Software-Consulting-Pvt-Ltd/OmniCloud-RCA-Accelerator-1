"use client";

import { useState } from "react";
import { tokens, inputStyle, PrimaryButton, GhostButton, ErrorPanel } from "@/components/data/quotes/shared";
import { LoadingRow, Modal, useBillingData } from "@/components/data/billing/billingUi";
import { quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { BillingNeed, LifecycleTransaction } from "@/lib/assetLifecycle/types";
import { Badge, Notice, fmtMoney, fmtNum } from "./lifecycleUi";

export interface BillingChoicesResponse {
  needs: BillingNeed[];
  orderProducts: { id: string; product: string; productCode: string | null; quantity: number | null; unitPrice: number | null; totalPrice: number | null; start: string | null; end: string | null; sellingModel: string | null; orderNumber: string | null }[];
  policies: { id: string; name: string; status: string | null; selection: string | null; defaultTreatment: string | null; items: string[]; eligible: boolean; reason: string | null }[];
  treatments: { id: string; name: string; policyId: string; status: string | null; legalEntity: string | null; items: string[]; eligible: boolean; reason: string | null }[];
}

const keyOf = (n: BillingNeed) => `${n.kind}:${n.product?.id ?? ""}:${n.orderItemIds.join(",")}`;

/** One searchable list of real Salesforce records (ineligible ones shown, disabled, with Salesforce's reason). */
function RecordPicker<T extends { id: string; name: string; eligible: boolean; reason: string | null }>({ isDark, label, rows, value, onPick, detail }: {
  isDark: boolean; label: string; rows: T[]; value: string | null; onPick: (r: T) => void; detail: (r: T) => string;
}) {
  const t = tokens(isDark);
  const [q, setQ] = useState("");
  const shown = rows.filter(r => !q.trim() || `${r.name} ${detail(r)}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <input aria-label={`Search ${label}`} value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}…`} style={inputStyle(t)} />
      <div role="radiogroup" aria-label={label} style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
        {shown.length === 0 && <div style={{ fontSize: 12, color: t.dim }}>No {label.toLowerCase()} match.</div>}
        {shown.map(r => (
          <label key={r.id} title={r.reason ?? undefined} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "7px 9px", borderRadius: 9, border: `1px solid ${value === r.id ? t.accent + "70" : t.border}`, background: value === r.id ? `${t.accent}12` : "transparent", cursor: r.eligible ? "pointer" : "not-allowed", opacity: r.eligible ? 1 : 0.6 }}>
            <input type="radio" disabled={!r.eligible} checked={value === r.id} onChange={() => onPick(r)} />
            <span style={{ fontSize: 12.5, color: t.body, minWidth: 0 }}>
              <b style={{ color: t.heading }}>{r.name}</b> {!r.eligible && <Badge label="not eligible" color="#FF4066" isDark={isDark} />}
              <div style={{ fontSize: 11.5, color: t.dim }}>{detail(r)}{r.reason ? ` — ${r.reason}` : ""}</div>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Billing readiness stopped for decisions only the user can make. Shows each affected product / order product (live from Salesforce)
 * with the eligible Billing Policies / Treatments of THIS org, then the exact records that will be updated — nothing is written until
 * "Confirm updates"; even then this only stores the decision, and the lifecycle step writes + reads it back when execution resumes.
 */
export default function BillingNeedsDialog({ isDark, tx, onDone, onEditBilling }: {
  isDark: boolean; tx: LifecycleTransaction;
  /** The updated transaction (decisions stored) — or null: closed without deciding (execution stays paused). */
  onDone: (tx: LifecycleTransaction | null) => void;
  onEditBilling?: () => void;
}) {
  const t = tokens(isDark);
  const { data, error, loading } = useBillingData<BillingChoicesResponse>("Load billing choices", `/api/asset-lifecycle/${tx.id}/billing`);
  const [pick, setPick] = useState<Record<string, { id: string; name: string }>>({});
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<ErrorPanelDataLike | null>(null);
  const needs = data?.needs ?? tx.billingNeeds ?? [];
  const decidable = needs.filter(n => n.kind === "billing-policy" || n.kind === "billing-treatment");
  const details = needs.filter(n => n.kind === "bill-to" || n.kind === "billing-address" || n.kind === "shipping-address");
  const complete = decidable.length > 0 && decidable.every(n => pick[keyOf(n)]);

  async function confirm() {
    setSaving(true); setErr(null);
    try {
      const res = await quoteApiPost<{ transaction: LifecycleTransaction }>("Save billing decisions", `/api/asset-lifecycle/${tx.id}/billing`, {
        confirmed: true,
        policies: decidable.filter(n => n.kind === "billing-policy").map(n => ({ productId: n.product!.id, policyId: pick[keyOf(n)].id })),
        treatments: decidable.filter(n => n.kind === "billing-treatment").map(n => ({ orderItemId: n.orderItemIds[0], treatmentId: pick[keyOf(n)].id })),
      });
      onDone(res.transaction);
    } catch (e) { setErr(toErrorPanelData(e, "Couldn't save the billing decisions")); setReview(false); }
    finally { setSaving(false); }
  }

  const products = (n: BillingNeed) => (data?.orderProducts ?? []).filter(p => n.orderItemIds.includes(p.id));
  return (
    <Modal isDark={isDark} tone="warn" title={review ? "Confirm the Salesforce updates" : "Billing setup needed before activation"}
      actions={review
        ? <><GhostButton label="Back" isDark={isDark} onClick={() => setReview(false)} /><PrimaryButton isDark={isDark} label={saving ? "Saving…" : "Confirm updates & continue"} icon="check" disabled={saving} onClick={() => void confirm()} /></>
        : <><GhostButton label="Not now" isDark={isDark} onClick={() => onDone(null)} />{decidable.length > 0 && <PrimaryButton isDark={isDark} label="Review updates…" icon="eye" disabled={!complete} onClick={() => setReview(true)} />}</>}>
      <div data-testid="billing-needs-dialog" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {error && <ErrorPanel isDark={isDark} error={error} />}
        {err && <ErrorPanel isDark={isDark} error={err} />}
        {loading && !data && <LoadingRow isDark={isDark} label="Reading the order products and billing policies from Salesforce…" />}
        {details.length > 0 && (
          <Notice isDark={isDark} tone="warn">
            {details.map(n => <div key={n.kind}>{n.message}</div>)}
            <div style={{ marginTop: 6 }}>Set the Bill-To Contact and addresses on the transaction, then resume.{onEditBilling && <span> <GhostButton label="Edit billing details" icon="edit" isDark={isDark} onClick={onEditBilling} /></span>}</div>
          </Notice>
        )}
        {!review && data && decidable.map(n => (
          <div key={keyOf(n)} style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: t.heading }}>{n.kind === "billing-policy" ? `Billing Policy for product ${n.product?.name}` : `Billing Treatment for ${n.product?.name ?? "order product"}`}</div>
            <div style={{ fontSize: 12, color: t.body }}>{n.message}</div>
            {products(n).map(p => (
              <div key={p.id} style={{ fontSize: 11.5, color: t.dim }}>Order {p.orderNumber ?? "—"} · {p.product}{p.productCode ? ` (${p.productCode})` : ""} · qty {fmtNum(p.quantity)} @ {fmtMoney(p.unitPrice)} = {fmtMoney(p.totalPrice)} · {p.sellingModel ?? "—"}{p.start ? ` · ${p.start} → ${p.end ?? "—"}` : ""}</div>
            ))}
            {n.kind === "billing-policy"
              ? <RecordPicker isDark={isDark} label="Billing Policies" rows={data.policies} value={pick[keyOf(n)]?.id ?? null} onPick={r => setPick(p => ({ ...p, [keyOf(n)]: { id: r.id, name: r.name } }))}
                  detail={r => [r.status, r.selection ? `selection ${r.selection}` : null, r.defaultTreatment ? `default treatment ${r.defaultTreatment}` : "no default treatment", r.items.length ? `items: ${r.items.join(", ")}` : null].filter(Boolean).join(" · ")} />
              : <RecordPicker isDark={isDark} label="Billing Treatments" rows={data.treatments.filter(x => !n.policy || x.policyId.slice(0, 15) === n.policy.id.slice(0, 15))} value={pick[keyOf(n)]?.id ?? null} onPick={r => setPick(p => ({ ...p, [keyOf(n)]: { id: r.id, name: r.name } }))}
                  detail={r => [r.status, r.legalEntity ? `legal entity ${r.legalEntity}` : null, r.items.length ? `items: ${r.items.join(", ")}` : "no items"].filter(Boolean).join(" · ")} />}
          </div>
        ))}
        {review && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="billing-updates-review">
            <div style={{ fontSize: 12.5, color: t.body }}>These Salesforce records will be updated when execution resumes (each change is read back; nothing else is modified):</div>
            {decidable.map(n => n.kind === "billing-policy" ? (
              <Notice key={keyOf(n)} isDark={isDark} tone="warn"><b>Product {n.product?.name}</b> — Billing Policy: <b>none → {pick[keyOf(n)]?.name}</b>. This is a PRODUCT setting: every future order of {n.product?.name} uses this policy, not only this order.</Notice>
            ) : (
              <Notice key={keyOf(n)} isDark={isDark} tone="info"><b>Order product {n.product?.name}</b>{products(n)[0]?.orderNumber ? ` (order ${products(n)[0].orderNumber})` : ""} — Billing Treatment: <b>none → {pick[keyOf(n)]?.name}</b>. Only this order product changes.</Notice>
            ))}
            <div style={{ fontSize: 11.5, color: t.dim }}>Then Salesforce re-prices the order and billing readiness is checked again. The order is NOT activated — that asks separately.</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
