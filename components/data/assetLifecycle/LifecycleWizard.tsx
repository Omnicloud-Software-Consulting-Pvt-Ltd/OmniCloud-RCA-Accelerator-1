"use client";

import { useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, Field, PrimaryButton, GhostButton, CodeBlock, ErrorPanel, Spinner } from "@/components/data/quotes/shared";
import { Panel, useBillingData } from "@/components/data/billing/billingUi";
import ReferenceLookup, { type ReferenceLookupValue } from "@/components/data/shared/ReferenceLookup";
import { quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { AiIssue } from "@/lib/assetLifecycle/ai";
import LifecyclePromptBox, { PromptResultPanel, type LifecycleAiResult } from "./LifecyclePromptBox";
import { initiateRequest, previewRows, renewalWindow, snapshotOf, swapKindOf, swapRequest, validateTransaction } from "@/lib/assetLifecycle/plan";
import { isIsoDate } from "@/lib/assetLifecycle/eligibility";
import type { LifecycleCapabilities } from "@/lib/assetLifecycle/server/reads";
import type { AddedProduct, AssetChange, AssetRow, LifecycleKind, LifecycleTransaction, RampOptions } from "@/lib/assetLifecycle/types";
import AssetExplorer from "./AssetExplorer";
import BillingDetailsFields, { effectiveBilling, type BillingEdits } from "./BillingDetailsFields";
import { addressText, validateBillingDetails } from "@/lib/assetLifecycle/billing";
import type { BillingOptions } from "@/lib/assetLifecycle/server/reads";
import FieldHelp from "@/components/help/FieldHelp";
import { LIFECYCLE_HELP as LH, LIFECYCLE_SECTION_HELP as SH, sectionHelpFor } from "@/lib/help/lifecycleHelp";
import { EligibilityBadge, KeyValues, Notice, ReasonList, SECTION_META, TableFrame, fmtDate, fmtMoney, fmtNum, td, th, typeLabel } from "./lifecycleUi";

/** The sections of each lifecycle's single-page form, top to bottom (all visible together — no steps). */
export const FORM_SECTIONS: Record<LifecycleKind, string[]> = {
  amend: ["Account and contract", "Assets to amend", "Changes", "Effective date", "Billing contact and addresses", "Preview"],
  renew: ["Account and contract", "Assets to renew", "Renewal pricing", "Renewal dates and term", "Billing contact and addresses", "Preview"],
  cancel: ["Account and contract", "Assets to cancel", "Cancellation type and reason", "Cancellation date", "Billing contact and addresses", "Preview"],
};
/** What happens in Salesforce after the plan is saved (the transaction page runs these after one confirmation; activation asks separately). */
export const SALESFORCE_STEPS = ["Lifecycle quote", "Review, price & order", "Activate & verify"];

interface CatalogOptionLite { pricebookEntryId: string; unitPrice: number | null; sellingModelName: string | null; sellingModelType: string | null; usable: boolean; reason: string | null; billingFrequency: string | null }
interface CatalogRowLite { id: string; name: string; productCode: string | null; options: CatalogOptionLite[] }
export interface PickedProduct { productId: string; productName: string; pricebookEntryId: string; sellingModelType: string | null; unitPrice: number | null; billingFrequency: string | null }

const today = () => new Date().toISOString().slice(0, 10);
/** Only the values a prompt actually gave (absent keys keep the form's defaults). */
const givenBilling = (b: { billToContactId: string | null; billToContactName: string | null; billingAddress: unknown; shippingAddress: unknown } | null | undefined): BillingEdits => {
  const e: BillingEdits = {};
  if (b?.billToContactId) { e.billToContactId = b.billToContactId; e.billToContactName = b.billToContactName; }
  if (b?.billingAddress) e.billingAddress = b.billingAddress as BillingEdits["billingAddress"];
  if (b?.shippingAddress) e.shippingAddress = b.shippingAddress as BillingEdits["shippingAddress"];
  if (Object.keys(e).length) e.source = "From your prompt";
  return e;
};
const numOrNull = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Catalog search (the asset's price book) → one product + price book entry (selling model). Reuses the shared catalog lookup. */
export function ProductPicker({ isDark, pricebookId, onPick, label }: { isDark: boolean; pricebookId: string | null; onPick: (p: PickedProduct) => void; label: string }) {
  const t = tokens(isDark);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState<string | null>(null);
  const res = useBillingData<{ rows: CatalogRowLite[] }>("Search products", term === null ? null : `/api/assets/lookup?type=catalog&q=${encodeURIComponent(term)}${pricebookId ? `&pricebookId=${pricebookId}` : ""}`);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <form onSubmit={e => { e.preventDefault(); setTerm(q.trim()); }} style={{ display: "flex", gap: 6 }}>
        <input aria-label={label} value={q} onChange={e => setQ(e.target.value)} placeholder={`${label} — search the asset's price book…`} style={{ ...inputStyle(t), flex: 1 }} />
        <GhostButton label="Search" icon="search" isDark={isDark} onClick={() => setTerm(q.trim())} />
      </form>
      {res.loading && <span style={{ fontSize: 12, color: t.dim, display: "flex", gap: 6, alignItems: "center" }}><Spinner isDark={isDark} size={12} /> Searching…</span>}
      {res.error && <ErrorPanel isDark={isDark} error={res.error} />}
      {term !== null && !res.loading && (res.data?.rows ?? []).length === 0 && <span style={{ fontSize: 12, color: t.dim }}>No active product found{pricebookId ? " in this price book" : ""}.</span>}
      {(res.data?.rows ?? []).slice(0, 8).map(p => (
        <div key={p.id} style={{ border: `1px solid ${t.border}`, borderRadius: 9, padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: t.heading }}>{p.name} <span style={{ fontWeight: 400, color: t.dim }}>{p.productCode ?? ""}</span></div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {p.options.length === 0 && <span style={{ fontSize: 11.5, color: t.dim }}>No price book entry.</span>}
            {p.options.map(o => (
              <button key={o.pricebookEntryId} disabled={!o.usable} title={o.reason ?? undefined} onClick={() => onPick({ productId: p.id, productName: p.name, pricebookEntryId: o.pricebookEntryId, sellingModelType: o.sellingModelType, unitPrice: o.unitPrice, billingFrequency: o.billingFrequency })}
                style={{ padding: "4px 9px", borderRadius: 8, border: `1px solid ${o.usable ? t.accent + "60" : t.border}`, background: "transparent", color: o.usable ? t.accent : t.dim, fontSize: 11.5, cursor: o.usable ? "pointer" : "not-allowed" }}>
                {o.sellingModelName ?? "No selling model"} · {fmtMoney(o.unitPrice)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type ChangeMode = "quantity" | "upgrade" | "downgrade" | "swap";
const MODE_LABEL: Record<ChangeMode, string> = { quantity: "Change", upgrade: "Upgrade", downgrade: "Downgrade", swap: "Swap" };

/** Amendment changes for one asset: quantity ±, price, discount, billing frequency, end date, attributes, upgrade / downgrade. */
export function ChangeEditor({ isDark, asset, change, onChange, billingFrequencies, features }: {
  isDark: boolean; asset: AssetRow; change: AssetChange; onChange: (c: AssetChange) => void; billingFrequencies: { value: string; label: string }[];
  features: LifecycleCapabilities["features"] | null;
}) {
  const t = tokens(isDark);
  const mode: ChangeMode = change.swap ? change.swap.kind : "quantity";
  const setMode = (m: ChangeMode) => onChange(m === "quantity" ? { assetId: change.assetId, quantityChange: 0 } : { assetId: change.assetId, quantityChange: 0, swap: { kind: m, productId: change.swap?.productId ?? "", productName: change.swap?.productName ?? "", pricebookEntryId: change.swap?.pricebookEntryId ?? "", quantity: change.swap?.quantity ?? asset.quantity ?? 1, outQuantity: change.swap?.outQuantity ?? null } });
  const result = (asset.quantity ?? 0) + (change.swap ? -(change.swap.outQuantity ?? asset.quantity ?? 0) : change.quantityChange);
  // Replacement modes exist only where the org exposes Salesforce's Upgrade / Downgrade / Swap resources (API 66.0+).
  const modes = (["quantity", "upgrade", "downgrade", "swap"] as ChangeMode[]).filter(m => m === "quantity" || !features || features[m]);
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }} data-testid={`change-${asset.id}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: t.heading }}>{asset.name} <span style={{ fontWeight: 400, fontSize: 11.5, color: t.dim }}>{asset.productName} · {typeLabel(asset.sellingModel?.type)} · qty {fmtNum(asset.quantity)} @ {fmtMoney(asset.unitPrice)}</span></div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <FieldHelp isDark={isDark} label="Change type" entry={LH.changeMode} />
          {modes.map(m => (
            <button key={m} onClick={() => setMode(m)} style={{ padding: "4px 10px", borderRadius: 8, fontSize: 11.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${mode === m ? t.accent + "60" : t.border}`, background: mode === m ? `${t.accent}18` : "transparent", color: mode === m ? t.accent : t.dim }}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>
      {mode === "quantity" && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
        <Field label="Quantity change" isDark={isDark} hint={`Result: ${result}${result === 0 ? " — use Cancellations to end the asset" : ""}`} help={LH.quantityChange}>
          <input type="number" step={1} aria-label={`Quantity change for ${asset.name}`} value={change.quantityChange} onChange={e => onChange({ ...change, quantityChange: Math.trunc(Number(e.target.value) || 0) })} style={inputStyle(t)} />
        </Field>
        <Field label="New unit price" isDark={isDark} hint={`Current ${fmtMoney(asset.unitPrice)} — Salesforce pricing may re-price`} help={LH.newUnitPrice}>
          <input type="number" min={0} step="0.01" aria-label={`Unit price for ${asset.name}`} value={change.unitPrice ?? ""} onChange={e => onChange({ ...change, unitPrice: numOrNull(e.target.value) })} style={inputStyle(t)} />
        </Field>
        {features?.lineDiscount !== false && (
          <Field label="Discount %" isDark={isDark} hint={asset.discount != null ? `Current ${asset.discount}%` : undefined} help={LH.discount}>
            <input type="number" min={0} max={100} step="0.01" aria-label={`Discount for ${asset.name}`} value={change.discount ?? ""} onChange={e => onChange({ ...change, discount: numOrNull(e.target.value) })} style={inputStyle(t)} />
          </Field>
        )}
        {asset.sellingModel?.type !== "OneTime" && (
          <Field label="Billing frequency" isDark={isDark} hint={`Current ${asset.billingFrequency ?? "—"}`} help={LH.billingFrequency}>
            <select aria-label={`Billing frequency for ${asset.name}`} value={change.billingFrequency ?? ""} onChange={e => onChange({ ...change, billingFrequency: e.target.value || null })} style={inputStyle(t)}>
              <option value="">No change</option>
              {billingFrequencies.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </Field>
        )}
        {asset.sellingModel?.type === "TermDefined" && (
          <Field label="New end date" isDark={isDark} hint={`Current ${fmtDate(asset.endDate ?? asset.lifecycleEnd)}`} help={LH.newEndDate}>
            <input type="date" aria-label={`End date for ${asset.name}`} value={change.endDate ?? ""} onChange={e => onChange({ ...change, endDate: e.target.value || null })} style={inputStyle(t)} />
          </Field>
        )}
      </div>}
      {mode !== "quantity" && change.swap && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10 }}>
            <Field label={`Quantity of ${asset.name} given up`} isDark={isDark} hint={`Of ${fmtNum(asset.quantity)} — result ${result}`} help={LH.quantityGivenUp}>
              <input type="number" min={1} max={asset.quantity ?? undefined} aria-label={`Quantity given up for ${asset.name}`} value={change.swap.outQuantity ?? asset.quantity ?? ""} onChange={e => onChange({ ...change, swap: { ...change.swap!, outQuantity: Math.trunc(Number(e.target.value) || 0) || null } })} style={inputStyle(t)} />
            </Field>
            {change.swap.productId && <>
              <Field label="Replacement quantity" isDark={isDark} help={LH.replacementQuantity}>
                <input type="number" min={1} aria-label="Replacement quantity" value={change.swap.quantity} onChange={e => onChange({ ...change, swap: { ...change.swap!, quantity: Math.max(1, Math.trunc(Number(e.target.value) || 1)) } })} style={inputStyle(t)} />
              </Field>
              <Field label="Replacement unit price" isDark={isDark} hint="Empty = the price book price" help={LH.replacementUnitPrice}>
                <input type="number" min={0} step="0.01" aria-label="Replacement unit price" value={change.swap.unitPrice ?? ""} onChange={e => onChange({ ...change, swap: { ...change.swap!, unitPrice: numOrNull(e.target.value) } })} style={inputStyle(t)} />
              </Field>
            </>}
          </div>
          {change.swap.productId
            ? <div style={{ fontSize: 12.5, color: t.body, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{MODE_LABEL[mode]} to <b>{change.swap.productName}</b> <GhostButton label="Change product" isDark={isDark} onClick={() => onChange({ ...change, swap: { ...change.swap!, productId: "", pricebookEntryId: "", productName: "" } })} /></div>
            : <><span style={{ fontSize: 11.5, fontWeight: 600, color: t.dim, textTransform: "uppercase", display: "inline-flex", gap: 4, alignItems: "center" }}>{MODE_LABEL[mode]} product <FieldHelp isDark={isDark} label={`${MODE_LABEL[mode]} product`} entry={LH.replacementProduct} /></span><ProductPicker isDark={isDark} pricebookId={asset.pricebookId} label={`${MODE_LABEL[mode]} product`} onPick={p => onChange({ ...change, swap: { ...change.swap!, productId: p.productId, productName: p.productName, pricebookEntryId: p.pricebookEntryId, billingFrequency: p.billingFrequency } })} /></>}
          <span style={{ fontSize: 11.5, color: t.dim }}>Sent through Salesforce&apos;s {MODE_LABEL[mode]} API (Transaction Management, API 66.0+): Salesforce builds the amendment quote, links the old and new asset and records the {mode} on both. One replacement kind per amendment.</span>
        </div>
      )}
      {mode === "quantity" && change.quantityChange === 0 && (change.unitPrice != null || change.discount != null) && (
        <span style={{ fontSize: 11.5, color: t.warn }}>No quantity change: Salesforce creates this asset&apos;s amendment line as &quot;No Change&quot; (quantity 0), so the quote line totals 0. How a new price or discount applies to the existing units is decided by your pricing procedure — check the priced quote before ordering.</span>
      )}
      {mode === "quantity" && features?.attributeChanges && <AttributeEditor isDark={isDark} asset={asset} change={change} onChange={onChange} />}
    </div>
  );
}

/** Attribute values of the asset (AssetAttribute) — changed values are written to the amendment line's QuoteLineItemAttribute. */
function AttributeEditor({ isDark, asset, change, onChange }: { isDark: boolean; asset: AssetRow; change: AssetChange; onChange: (c: AssetChange) => void }) {
  const t = tokens(isDark);
  const attrs = useBillingData<{ attributes: { id: string; definitionId: string | null; name: string | null; value: string | null }[] }>("Load asset attributes", `/api/assets/${asset.id}`).data?.attributes ?? [];
  if (!attrs.length) return null;
  const valueOf = (defId: string, current: string | null) => change.attributes?.find(a => a.definitionId === defId)?.value ?? current ?? "";
  const set = (defId: string, name: string, value: string, current: string | null) => {
    const rest = (change.attributes ?? []).filter(a => a.definitionId !== defId);
    onChange({ ...change, attributes: value === (current ?? "") ? rest : [...rest, { definitionId: defId, name, value }] });
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
      {attrs.filter(a => a.definitionId).map(a => (
        <Field key={a.id} label={a.name ?? "Attribute"} isDark={isDark} hint={`Current ${a.value ?? "—"}`} help={LH.attribute}>
          <input aria-label={`Attribute ${a.name ?? ""} for ${asset.name}`} value={valueOf(a.definitionId!, a.value)} onChange={e => set(a.definitionId!, a.name ?? "", e.target.value, a.value)} style={inputStyle(t)} />
        </Field>
      ))}
    </div>
  );
}

/**
 * One amendment / renewal / cancellation on ONE page: prompt → account & contract → assets → changes → dates → preview → save. The prompt
 * parser and manual entry write the SAME form state, so the preview, validation and save path are identical however a value got there.
 * Saving stores the plan in the app; "Save & create in Salesforce…" opens the transaction page's single execution confirmation.
 */
export default function LifecycleWizard({ isDark, kind, prefill, editing, onSaved, onCancel, onSwitchKind }: {
  isDark: boolean; kind: LifecycleKind;
  prefill?: { account: ReferenceLookupValue | null; assets: AssetRow[]; ai?: LifecycleAiResult | null } | null;
  /** An existing (unsent or quote-stage) transaction to edit. */
  editing?: { transaction: LifecycleTransaction; assets: AssetRow[] } | null;
  /** `execute`: the user chose "Save & create in Salesforce" — the transaction page opens its execution confirmation (nothing runs unconfirmed). */
  onSaved: (id: string, opts?: { execute?: boolean }) => void; onCancel: () => void;
  /** Partial cancellation / a prompt for another lifecycle → open that form with these assets (and the parsed prompt). */
  onSwitchKind?: (kind: LifecycleKind, account: ReferenceLookupValue | null, assets: AssetRow[], ai?: LifecycleAiResult | null) => void;
}) {
  const t = tokens(isDark);
  const meta = SECTION_META[kind];
  const sections = FORM_SECTIONS[kind];
  const tx = editing?.transaction ?? null;
  const locked = !!(tx && (tx.sf.quoteId || tx.sf.requestIdentifier || tx.sf.initiatedAt));
  // The order exists (not activated): only who is billed and where can still change — billing readiness re-applies it before activation.
  const billingOnly = !!(tx && (tx.sf.orderId || tx.sf.orderRequestedAt));
  // A parsed prompt handed over from another section (Assets / another lifecycle) prefills the initial state.
  const ai0 = !tx && prefill?.ai && !prefill.ai.kindMismatch ? prefill.ai : null;
  const initialAssets = editing?.assets ?? (ai0?.prefill.assets.length ? ai0.prefill.assets : null) ?? prefill?.assets ?? [];
  const [aiResult, setAiResult] = useState<LifecycleAiResult | null>(ai0);
  const [account, setAccount] = useState<ReferenceLookupValue | null>(tx ? { id: tx.accountId, name: tx.accountName ?? tx.accountId } : ai0?.prefill.account ?? prefill?.account ?? null);
  const [contractId, setContractId] = useState<string>(tx?.contractId ?? ai0?.prefill.contractId ?? "");
  const [opportunityId, setOpportunityId] = useState<string>(tx?.opportunityId ?? "");
  const [name, setName] = useState(tx?.name ?? ai0?.prefill.name ?? "");
  const [selected, setSelected] = useState<Map<string, AssetRow>>(() => new Map(initialAssets.map(a => [a.id, a])));
  // The asset search opens by itself until assets are chosen (by hand, from an asset page or from a prompt); then it folds away.
  const [pickerOpen, setPickerOpen] = useState(initialAssets.length === 0);
  const [changes, setChanges] = useState<Record<string, AssetChange>>(() => Object.fromEntries((tx?.changes ?? ai0?.prefill.changes ?? []).map(c => [c.assetId, c])));
  const [adds, setAdds] = useState<AddedProduct[]>(tx?.adds ?? []);
  const [effectiveDate, setEffectiveDate] = useState(tx?.effectiveDate ?? ai0?.prefill.effectiveDate ?? (kind === "renew" ? "" : today()));
  const [amendSubtype, setAmendSubtype] = useState<"StartDateAdjustment" | null>(tx?.amendSubtype ?? null);
  const [renewEnd, setRenewEnd] = useState(tx?.renewal?.endDate ?? ai0?.prefill.renewal?.endDate ?? "");
  const [termMonths, setTermMonths] = useState(tx?.renewal?.termMonths ? String(tx.renewal.termMonths) : ai0?.prefill.renewal?.termMonths ? String(ai0.prefill.renewal.termMonths) : "");
  const [ramp, setRamp] = useState<RampOptions | null>(tx?.renewal?.ramp ?? null);
  const [cancelMode, setCancelMode] = useState<"full" | "partial">("full");
  const [reason, setReason] = useState(tx?.cancel?.reason ?? ai0?.prefill.cancelReason ?? "");
  const [reasonField, setReasonField] = useState(tx?.cancel?.reasonField ? `${tx.cancel.reasonField.object}.${tx.cancel.reasonField.field}` : "");
  const [billingEdits, setBillingEdits] = useState<BillingEdits>(() => (tx?.billing ? { ...tx.billing } : givenBilling(ai0?.prefill.billing)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);

  const caps = useBillingData<{ capabilities: LifecycleCapabilities }>("Load org capabilities", "/api/assets/lookup?type=capabilities").data?.capabilities ?? null;
  const freqs = useBillingData<{ billingFrequencies: { value: string; label: string }[] }>("Load billing frequencies", kind === "amend" ? "/api/assets/lookup?type=fields" : null).data?.billingFrequencies ?? [];
  const contracts = useBillingData<{ rows: { id: string; name: string }[] }>("Load contracts", account ? `/api/assets/lookup?type=contracts&accountId=${account.id}` : null).data?.rows ?? [];
  const opps = useBillingData<{ rows: { id: string; name: string; stage: string | null }[] }>("Load opportunities", account ? `/api/assets/lookup?type=opportunities&accountId=${account.id}` : null).data?.rows ?? [];

  const assets = [...selected.values()];
  const originOrders = [...new Set(assets.map(a => a.originOrder?.id).filter((x): x is string => !!x))].slice(0, 20).join(",");
  const billingOpts = useBillingData<BillingOptions>("Load billing contacts and addresses", account ? `/api/assets/lookup?type=billing-details&accountId=${account.id}${originOrders ? `&orderIds=${originOrders}` : ""}` : null);
  const billing = effectiveBilling(billingOpts.data?.defaults ?? null, billingEdits);
  const firstPricebook = assets.find(a => a.pricebookId)?.pricebookId ?? null;
  const changeOf = (a: AssetRow): AssetChange => changes[a.id] ?? { assetId: a.id, quantityChange: 0 };
  const rf = caps?.reasonFields.find(f => `${f.object}.${f.field}` === reasonField) ?? null;
  const draft: Pick<LifecycleTransaction, "kind" | "accountId" | "contractId" | "opportunityId" | "effectiveDate" | "assets" | "changes" | "adds" | "renewal" | "cancel" | "amendSubtype"> = {
    kind, accountId: account?.id ?? "", contractId: contractId || null, opportunityId: opportunityId || null, effectiveDate, amendSubtype: kind === "amend" ? amendSubtype : null,
    assets: assets.map(a => snapshotOf(a)),
    changes: kind === "cancel" ? [] : assets.map(changeOf).filter(c => kind === "amend" || c.unitPrice != null || c.discount != null),
    adds: kind === "amend" ? adds : [],
    renewal: kind === "renew" ? { endDate: renewEnd || null, termMonths: numOrNull(termMonths), ramp } : null,
    cancel: kind === "cancel" ? { reason: reason || null, reasonField: rf } : null,
  };
  const ready = !!account && assets.length > 0;
  // Plan rules + each selected asset's Salesforce eligibility (open quotes / Draft orders, ended, cancelled …) as read for the asset rows.
  const problems = billingOnly ? validateBillingDetails(billing) : ready ? [...new Set([
    ...validateBillingDetails(billing),
    ...(kind !== "renew" && !isIsoDate(effectiveDate) ? [`Enter the ${kind === "cancel" ? "cancellation" : "amendment effective"} date.`] : []),
    ...(kind === "cancel" && cancelMode === "partial" ? ["A partial cancellation is an amendment that reduces the quantity — switch to Full cancellation, or reduce the quantity with an amendment."] : []),
    ...validateTransaction(draft, null, today(), caps ? { actionInputs: caps.actions[kind].inputs } : undefined),
    ...assets.flatMap(a => (a.eligibility?.[kind] ?? []).filter(r => r.severity === "error").map(r => r.message)),
  ])] : [];
  const window = kind === "renew" ? renewalWindow(draft) : null;
  const contractName = contracts.find(c => c.id === contractId)?.name ?? (contractId ? tx?.contractNumber ?? ai0?.prefill.contractNumber ?? contractId : null);

  /** Fill the form from a parsed prompt — the same state manual entry writes; every value stays editable. */
  function applyAi(r: LifecycleAiResult) {
    setAiResult(r);
    if (r.kindMismatch) return;
    const p = r.prefill;
    if (p.account) { if (p.account.id !== account?.id) setBillingEdits({}); setAccount(p.account); }
    if (p.billing) setBillingEdits(e => ({ ...e, ...givenBilling(p.billing) }));
    if (p.name) setName(p.name);
    setContractId(p.contractId ?? "");
    if (p.assets.length) { setSelected(new Map(p.assets.map(a => [a.id, a]))); setPickerOpen(false); }
    else if (p.account) setPickerOpen(true);
    if (p.changes.length) setChanges(Object.fromEntries(p.changes.map(c => [c.assetId, c])));
    if (p.effectiveDate) setEffectiveDate(p.effectiveDate);
    if (kind === "renew") { setRenewEnd(p.renewal?.endDate ?? ""); setTermMonths(p.renewal?.termMonths ? String(p.renewal.termMonths) : ""); }
    if (kind === "cancel" && p.cancelReason) setReason(p.cancelReason);
  }
  /** A real Salesforce record the user picked for an ambiguous / unresolved prompt value. */
  async function pickCandidate(issue: AiIssue, c: { id: string; name: string }) {
    if (issue.field === "Account") { setAccount({ id: c.id, name: c.name }); setSelected(new Map()); setPickerOpen(true); return; }
    if (issue.field === "Contract") { setContractId(c.id); return; }
    if (issue.field === "Bill-To Contact") { setBillingEdits(e => ({ ...e, billToContactId: c.id, billToContactName: c.name, source: e.source ?? "Chosen" })); return; }
    if (/^Asset/.test(issue.field)) {
      try {
        const res = await quoteApiGet<{ rows: AssetRow[] }>("Load asset", `/api/assets?ids=${c.id}&lifecycleOnly=0`);
        if (res.rows[0]) setSelected(prev => new Map(prev).set(res.rows[0].id, res.rows[0]));
      } catch (e) { setError(toErrorPanelData(e, "Couldn't load that asset")); }
    }
  }

  const toggle = (r: AssetRow, on: boolean) => setSelected(prev => { const m = new Map(prev); if (on) m.set(r.id, r); else m.delete(r.id); return m; });
  const pickFirst = (what: string) => <div style={{ fontSize: 12.5, color: t.dim }}>{what}</div>;

  async function save(execute = false) {
    if (!account) return;
    setSaving(true); setError(null);
    try {
      const res = await quoteApiPost<{ transaction: LifecycleTransaction; errors: string[] }>(`Save ${meta.singular.toLowerCase()}`, "/api/asset-lifecycle", {
        kind, id: tx?.id, name: name.trim() || undefined, accountId: account.id, accountName: account.name,
        contractId: contractId || null, contractNumber: contracts.find(c => c.id === contractId)?.name.split(" · ")[0] ?? tx?.contractNumber ?? null,
        opportunityId: opportunityId || null, opportunityName: opps.find(o => o.id === opportunityId)?.name ?? null,
        effectiveDate, amendSubtype: draft.amendSubtype, assetIds: assets.map(a => a.id), changes: draft.changes, adds: draft.adds, renewal: draft.renewal,
        cancel: kind === "cancel" ? { reason: reason || null, reasonField: reasonField || null } : null,
        billing,
      });
      onSaved(res.transaction.id, { execute });
    } catch (e) { setError(toErrorPanelData(e, `Couldn't save the ${meta.singular.toLowerCase()}`)); }
    finally { setSaving(false); }
  }

  const missing = caps?.missing[kind] ?? [];
  if (billingOnly && tx) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }} data-testid={`wizard-${kind}`} data-form="single-page">
        <div style={{ fontSize: 15, fontWeight: 700, color: t.heading }}>Billing details — {tx.name}</div>
        <Notice isDark={isDark} tone="info">Order {tx.sf.orderNumber ?? tx.sf.orderId ?? "(requested)"} exists — only who is billed and where can change now. Saving re-opens billing readiness, which writes these values to the order (and re-prices it) when execution resumes. Nothing is activated.</Notice>
        <Panel isDark={isDark} title={sections[4]} icon="credit-card" right={<FieldHelp isDark={isDark} label={sections[4]} entry={SH.billing} />}>
          <BillingDetailsFields isDark={isDark} options={billingOpts.data ?? null} loading={billingOpts.loading} value={billing} edits={billingEdits} onEdits={setBillingEdits} />
        </Panel>
        {problems.length > 0 && <Notice isDark={isDark} tone="error"><b>Fix before saving:</b><ReasonList isDark={isDark} reasons={problems.map(m => ({ code: "PLAN", severity: "error", message: m }))} /></Notice>}
        {error && <ErrorPanel isDark={isDark} error={error} />}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <GhostButton label="Cancel" icon="x" isDark={isDark} onClick={onCancel} />
          <PrimaryButton isDark={isDark} label={saving ? "Saving…" : "Save billing details"} icon="save" disabled={saving || problems.length > 0} onClick={() => void save(false)} />
        </div>
      </div>
    );
  }
  const grid = (min: number) => ({ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(min(${min}px, 100%), 1fr))`, gap: 12 }) as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} data-testid={`wizard-${kind}`} data-form="single-page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: meta.color, display: "inline-flex" }}><Ic n={meta.icon} s={16} /></span>
          <span style={{ fontSize: 15, fontWeight: 700, color: t.heading }}>{tx ? `Edit ${meta.singular.toLowerCase()} — ${tx.name}` : `New ${meta.singular.toLowerCase()}`}</span>
        </div>
        <span style={{ fontSize: 11.5, color: t.dim, display: "inline-flex", alignItems: "center", gap: 4 }}><Ic n="arrow-right" s={11} /> After saving, Salesforce: {SALESFORCE_STEPS.join(" → ")} (activation asks separately)</span>
      </div>
      {missing.length > 0 && <Notice isDark={isDark} tone="error"><b>This org can&apos;t run {meta.label.toLowerCase()} yet:</b> {missing.join(" ")}</Notice>}
      {locked && <Notice isDark={isDark} tone="info">Salesforce already created quote {tx?.sf.quoteNumber ?? tx?.sf.quoteId ?? "(pending)"} for these assets and dates — only the line changes can be edited. They are re-applied to the quote, then re-priced.</Notice>}

      {!locked && !tx && <LifecyclePromptBox isDark={isDark} kind={kind} onResult={applyAi} />}
      {aiResult && <PromptResultPanel isDark={isDark} result={aiResult} onCandidate={(i, c) => void pickCandidate(i, c)} onDismiss={() => setAiResult(null)}
        onSwitchKind={onSwitchKind && aiResult.kind ? () => onSwitchKind(aiResult.kind!, aiResult.prefill.account, aiResult.prefill.assets, { ...aiResult, kindMismatch: false }) : undefined} />}

      <Panel isDark={isDark} title={sections[0]} icon="building" right={<FieldHelp isDark={isDark} label={sections[0]} entry={SH.account} />}>
        <div style={grid(230)}>
          <Field label="Account" isDark={isDark} hint={locked ? "Fixed: the Salesforce quote already exists." : "Accounts that own lifecycle assets are listed first."} help={LH.account}>
            {locked
              ? <input aria-label="Account" value={account?.name ?? ""} disabled readOnly style={inputStyle(t)} />
              : <ReferenceLookup isDark={isDark} objectType="Account" searchEndpoint="/api/assets/reference/search" value={account} browseOnFocus placeholder="Search accounts…" onChange={v => { setAccount(v); setContractId(""); setOpportunityId(""); setSelected(new Map()); setPickerOpen(true); setBillingEdits({}); }} />}
          </Field>
          <Field label="Contract (optional)" isDark={isDark} hint={`Synced with the ${meta.singular.toLowerCase()} (${kind}ContractId) and filters the assets.`} help={LH.contract}>
            <select aria-label="Contract" value={contractId} disabled={!account || locked} onChange={e => { setContractId(e.target.value); setSelected(new Map()); setPickerOpen(true); }} style={inputStyle(t)}>
              <option value="">No contract</option>
              {contractId && !contracts.some(c => c.id === contractId) && <option value={contractId}>{contractName}</option>}
              {contracts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Opportunity (optional)" isDark={isDark} hint="Synced with the lifecycle quote." help={LH.opportunity}>
            <select aria-label="Opportunity" value={opportunityId} disabled={!account || locked} onChange={e => setOpportunityId(e.target.value)} style={inputStyle(t)}>
              <option value="">No opportunity</option>
              {opps.map(o => <option key={o.id} value={o.id}>{o.name}{o.stage ? ` · ${o.stage}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Name" isDark={isDark} hint="For this app's history." help={LH.name}>
            <input aria-label="Name" value={name} onChange={e => setName(e.target.value)} placeholder={`${meta.singular} ${today()}`} style={inputStyle(t)} />
          </Field>
        </div>
      </Panel>

      <Panel isDark={isDark} title={`${sections[1]}${assets.length ? ` (${assets.length})` : ""}`} icon="archive" right={<FieldHelp isDark={isDark} label={sections[1]} entry={LH.assets} />}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {!account && pickFirst("Choose the account first — its eligible assets are listed here.")}
          {assets.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="selected-assets">
              {assets.map(a => (
                <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 10px", border: `1px solid ${t.border}`, borderRadius: 10 }}>
                  <div style={{ fontSize: 12.5, color: t.body, minWidth: 0, overflowWrap: "anywhere" }}>
                    <b style={{ color: t.heading }}>{a.name}</b>{" "}
                    <span style={{ color: t.dim }}>{a.productName} · {typeLabel(a.sellingModel?.type)} · qty {fmtNum(a.quantity)} @ {fmtMoney(a.unitPrice)} · {fmtDate(a.lifecycleStart)} → {fmtDate(a.lifecycleEnd)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <EligibilityBadge reasons={a.eligibility?.[kind] ?? []} isDark={isDark} />
                    {!locked && <GhostButton label="Remove" icon="x" isDark={isDark} onClick={() => toggle(a, false)} />}
                  </div>
                </div>
              ))}
            </div>
          )}
          {account && !locked && (pickerOpen || !assets.length
            ? <>
                {assets.length > 0 && <div><GhostButton label="Hide asset search" icon="chevron-up" isDark={isDark} onClick={() => setPickerOpen(false)} /></div>}
                <AssetExplorer isDark={isDark} kind={kind} account={account} contractId={contractId || null} selected={selected} onToggle={toggle} initialState={kind === "renew" ? "all" : "active"} pageSize={10} />
              </>
            : <div><GhostButton label="Add or change assets" icon="search" isDark={isDark} onClick={() => setPickerOpen(true)} /></div>)}
        </div>
      </Panel>

      {kind === "amend" && (
        <Panel isDark={isDark} title={sections[2]} icon="edit" right={<FieldHelp isDark={isDark} label={sections[2]} entry={sectionHelpFor(kind).changes} />}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {caps?.features.startDateAdjustment && !locked && (
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.body }}>
                <input type="checkbox" checked={amendSubtype === "StartDateAdjustment"} onChange={e => setAmendSubtype(e.target.checked ? "StartDateAdjustment" : null)} />
                Start-date adjustment only (initiateAmendment actionSubtype StartDateAdjustment — moves the subscription start to the effective date, no other change)
                <FieldHelp isDark={isDark} label="Start-date adjustment" entry={LH.startDateAdjustment} />
              </label>
            )}
            {!assets.length && pickFirst("Select at least one asset above to enter its quantity, price, discount, billing or replacement changes.")}
            {amendSubtype ? <Notice isDark={isDark} tone="info">The selected assets&apos; start date moves to the effective date below. Not verified against a live org yet — review the quote Salesforce builds before ordering.</Notice>
              : assets.map(a => <ChangeEditor key={a.id} isDark={isDark} asset={a} change={changeOf(a)} features={caps?.features ?? null} billingFrequencies={freqs} onChange={c => setChanges(prev => ({ ...prev, [a.id]: c }))} />)}
            {!amendSubtype && !swapKindOf(draft) && assets.length > 0 && (
              <div style={{ border: `1px dashed ${t.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: t.heading, display: "inline-flex", gap: 6, alignItems: "center" }}>Add products / add-ons <FieldHelp isDark={isDark} label="Add products / add-ons" entry={LH.addProducts} /></div>
                {adds.map((p, i) => (
                  <div key={`${p.pricebookEntryId}-${i}`} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5, color: t.body }}>
                    <b>{p.productName}</b> qty <FieldHelp isDark={isDark} label="Quantity" entry={LH.addQuantity} /> <input type="number" min={1} aria-label={`Quantity of ${p.productName}`} value={p.quantity} onChange={e => setAdds(prev => prev.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Math.trunc(Number(e.target.value) || 1)) } : x)))} style={{ ...inputStyle(t), width: 80 }} />
                    end <FieldHelp isDark={isDark} label="End date" entry={LH.addEndDate} /> <input type="date" aria-label={`End date of ${p.productName}`} value={p.endDate ?? ""} onChange={e => setAdds(prev => prev.map((x, j) => (j === i ? { ...x, endDate: e.target.value || null } : x)))} style={{ ...inputStyle(t), width: 160 }} title="Required for Term-Defined products" />
                    <GhostButton label="Remove" icon="trash" danger isDark={isDark} onClick={() => setAdds(prev => prev.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <ProductPicker isDark={isDark} pricebookId={firstPricebook} label="Add product" onPick={p => setAdds(prev => [...prev, { productId: p.productId, productName: p.productName, pricebookEntryId: p.pricebookEntryId, quantity: 1, billingFrequency: p.billingFrequency, endDate: null }])} />
              </div>
            )}
          </div>
        </Panel>
      )}

      {kind === "renew" && (
        <Panel isDark={isDark} title={sections[2]} icon="dollar-sign" right={<FieldHelp isDark={isDark} label={sections[2]} entry={sectionHelpFor(kind).changes} />}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Notice isDark={isDark} tone="info">Leave a price empty to renew at what Salesforce prices (the asset&apos;s pricing source{assets[0]?.renewal.pricingSource ? `: ${assets[0].renewal.pricingSource}` : ""}{assets[0]?.renewal.uplift ? `, uplift ${assets[0].renewal.uplift}%` : ""}). A negotiated price or discount is applied to the renewal quote line after Salesforce builds it.</Notice>
            {!assets.length ? pickFirst("Select at least one asset above to enter negotiated prices or discounts.") : (
              <TableFrame isDark={isDark}>
                <thead><tr>{["Asset", "Current qty", "Current price", "Negotiated unit price", "Discount %"].map(h => <th key={h} style={th(t)}><span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>{h}{h === "Negotiated unit price" ? <FieldHelp isDark={isDark} label={h} entry={LH.renewalPrice} /> : h === "Discount %" ? <FieldHelp isDark={isDark} label={h} entry={LH.renewalDiscount} /> : null}</span></th>)}</tr></thead>
                <tbody>{assets.map(a => { const c = changeOf(a); return (
                  <tr key={a.id}><td style={td(t)}>{a.name}</td><td style={td(t)}>{fmtNum(a.quantity)}</td><td style={td(t)}>{fmtMoney(a.unitPrice)}</td>
                    <td style={td(t)}><input type="number" min={0} step="0.01" aria-label={`Negotiated price for ${a.name}`} value={c.unitPrice ?? ""} onChange={e => setChanges(p => ({ ...p, [a.id]: { ...c, unitPrice: numOrNull(e.target.value) } }))} style={inputStyle(t)} /></td>
                    <td style={td(t)}><input type="number" min={0} max={100} step="0.01" aria-label={`Discount for ${a.name}`} value={c.discount ?? ""} onChange={e => setChanges(p => ({ ...p, [a.id]: { ...c, discount: numOrNull(e.target.value) } }))} style={inputStyle(t)} /></td></tr>); })}</tbody>
              </TableFrame>
            )}
            {!locked && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: caps?.features.rampedRenewal ? t.body : t.dim }}>
                  <input type="checkbox" disabled={!caps?.features.rampedRenewal} checked={!!ramp} onChange={e => setRamp(e.target.checked ? { segmentType: "Yearly", durationInMonths: numOrNull(termMonths) ?? 12, segmentCount: null } : null)} />
                  Ramp the renewal (group ramp schedule){caps && !caps.features.rampedRenewal ? " — this org's initiateRenewal has no rampOptionsDetails input (API 67.0+)" : ""}
                  <FieldHelp isDark={isDark} label="Ramp the renewal" entry={LH.rampRenewal} />
                </label>
                {ramp && (
                  <div style={grid(160)}>
                    <Field label="Segment type" isDark={isDark} help={LH.rampSegmentType}><select aria-label="Segment type" value={ramp.segmentType} onChange={e => setRamp({ ...ramp, segmentType: e.target.value as RampOptions["segmentType"] })} style={inputStyle(t)}><option value="Yearly">Yearly (12-month segments)</option><option value="Custom">Custom (equal segments)</option></select></Field>
                    <Field label="Duration (months)" isDark={isDark} help={LH.rampDuration}><input type="number" min={1} aria-label="Ramp duration" value={ramp.durationInMonths} onChange={e => setRamp({ ...ramp, durationInMonths: Math.trunc(Number(e.target.value) || 0) })} style={inputStyle(t)} /></Field>
                    {ramp.segmentType === "Custom" && <Field label="Segments" isDark={isDark} help={LH.rampSegments}><input type="number" min={1} aria-label="Ramp segments" value={ramp.segmentCount ?? ""} onChange={e => setRamp({ ...ramp, segmentCount: numOrNull(e.target.value) })} style={inputStyle(t)} /></Field>}
                  </div>
                )}
              </div>
            )}
          </div>
        </Panel>
      )}

      {kind === "cancel" && (
        <Panel isDark={isDark} title={sections[2]} icon="x" right={<FieldHelp isDark={isDark} label={sections[2]} entry={sectionHelpFor(kind).changes} />}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <FieldHelp isDark={isDark} label="Cancellation type" entry={LH.cancelMode} />
              {(["full", "partial"] as const).map(m => (
                <button key={m} disabled={locked} onClick={() => setCancelMode(m)} aria-pressed={cancelMode === m} style={{ padding: "8px 12px", borderRadius: 10, fontSize: 12.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${cancelMode === m ? t.accent + "60" : t.border}`, background: cancelMode === m ? `${t.accent}18` : "transparent", color: cancelMode === m ? t.accent : t.body }}>
                  {m === "full" ? "Full cancellation (initiateCancellation)" : "Partial cancellation (reduce quantity)"}
                </button>
              ))}
            </div>
            {cancelMode === "partial" ? (
              <Notice isDark={isDark} tone="info">
                Salesforce&apos;s initiateCancellation cancels the <b>whole</b> asset — it has no quantity input. A partial cancellation is an amendment that reduces the quantity (Asset Action category Downsells).
                {onSwitchKind && <div style={{ marginTop: 8 }}><PrimaryButton isDark={isDark} label="Reduce quantity with an amendment" icon="edit" onClick={() => onSwitchKind("amend", account, assets)} /></div>}
              </Notice>
            ) : (
              <>
                <div style={grid(260)}>
                  <Field label="Cancellation reason" isDark={isDark} help={LH.cancelReason}
                    hint={caps?.reasonFields.length ? "Written to the Salesforce field you choose, and kept in the app's audit trail." : "This org has no writable cancellation-reason field on Quote / Quote Line / Quote Action — the reason is kept in the app's audit trail only."}>
                    {rf?.options.length
                      ? <select aria-label="Cancellation reason" value={reason} onChange={e => setReason(e.target.value)} style={inputStyle(t)}><option value="">—</option>{rf.options.map(o => <option key={o} value={o}>{o}</option>)}</select>
                      : <input aria-label="Cancellation reason" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Budget, switched vendor…" style={inputStyle(t)} />}
                  </Field>
                  {(caps?.reasonFields.length ?? 0) > 0 && (
                    <Field label="Salesforce reason field" isDark={isDark} help={LH.reasonField} hint="Discovered from the org's Describe (writable fields whose name or label mentions a reason).">
                      <select aria-label="Reason field" value={reasonField} disabled={locked} onChange={e => { setReasonField(e.target.value); setReason(""); }} style={inputStyle(t)}>
                        <option value="">Don&apos;t write the reason to Salesforce</option>
                        {caps!.reasonFields.map(f => <option key={`${f.object}.${f.field}`} value={`${f.object}.${f.field}`}>{f.object}.{f.field} ({f.label})</option>)}
                      </select>
                    </Field>
                  )}
                </div>
                <Notice isDark={isDark} tone="warn">Credits, refunds and billing changes are decided by Salesforce&apos;s pricing, proration policy and Revenue Cloud Billing configuration — the cancellation quote shows what Salesforce calculates; nothing is assumed here.</Notice>
              </>
            )}
          </div>
        </Panel>
      )}

      <Panel isDark={isDark} title={sections[3]} icon="calendar" right={<FieldHelp isDark={isDark} label={sections[3]} entry={SH.dates} />}>
        <div style={grid(220)}>
          {kind === "amend" && <Field label={amendSubtype ? "New start date" : "Amendment start (effective) date"} isDark={isDark} help={amendSubtype ? LH.newStartDate : LH.amendEffective} hint="Sent as amendStartDate."><input type="date" aria-label="Effective date" disabled={locked} value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} style={inputStyle(t)} /></Field>}
          {kind === "cancel" && (
            <>
              <Field label="Cancellation date" isDark={isDark} help={LH.cancelDate} hint="Sent as cancelStartDate. Today = immediate; a later date = future-effective."><input type="date" aria-label="Effective date" disabled={locked} value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} style={inputStyle(t)} /></Field>
              <div style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap" }}>
                <GhostButton label="Immediate (today)" isDark={isDark} disabled={locked} onClick={() => setEffectiveDate(today())} />
                <GhostButton label="End of current term" isDark={isDark} disabled={locked || !assets[0]?.lifecycleEnd} onClick={() => assets[0]?.lifecycleEnd && setEffectiveDate(assets[0].lifecycleEnd.slice(0, 10))} />
              </div>
            </>
          )}
          {kind === "renew" && (
            <>
              <Field label="Renewal start (optional)" isDark={isDark} help={LH.renewalStart} hint="Empty = Salesforce's default (the day after the current term). Required for expired assets (today or later)."><input type="date" aria-label="Effective date" disabled={locked} value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} style={inputStyle(t)} /></Field>
              <Field label="Term (months)" isDark={isDark} help={LH.renewalTerm} hint={assets[0]?.renewal.term ? `Asset renewal term: ${assets[0].renewal.term} ${assets[0].renewal.termUnit ?? ""}` : "Empty = the asset's renewal term"}><input type="number" min={1} aria-label="Term months" disabled={locked} value={termMonths} onChange={e => setTermMonths(e.target.value)} style={inputStyle(t)} /></Field>
              <Field label="Renewal end (optional)" isDark={isDark} help={LH.renewalEnd} hint="Overrides the term. Sent as renewEndDate."><input type="date" aria-label="Renewal end" disabled={locked} value={renewEnd} onChange={e => setRenewEnd(e.target.value)} style={inputStyle(t)} /></Field>
              <div style={{ fontSize: 12.5, color: t.body, alignSelf: "end" }}>Renewal window: <b>{window?.start ?? "Salesforce default"}</b> → <b>{window?.end ?? "Salesforce default"}</b></div>
            </>
          )}
        </div>
        {assets.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
            {assets.map(a => <div key={a.id} style={{ fontSize: 12, color: t.dim }}>{a.name}: lifecycle {fmtDate(a.lifecycleStart)} → {fmtDate(a.lifecycleEnd)}</div>)}
          </div>
        )}
      </Panel>

      <Panel isDark={isDark} title={sections[4]} icon="credit-card">
        {!account ? pickFirst("Choose the account first — its contacts and addresses are listed here.")
          : <BillingDetailsFields isDark={isDark} options={billingOpts.data ?? null} loading={billingOpts.loading} value={billing} edits={billingEdits} onEdits={setBillingEdits} />}
        {billingOpts.error && <ErrorPanel isDark={isDark} error={billingOpts.error} />}
      </Panel>

      <Panel isDark={isDark} title={`${sections[5]} — Salesforce now vs requested`} icon="eye" right={<FieldHelp isDark={isDark} label={sections[5]} entry={SH.preview} />}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="lifecycle-preview">
          <KeyValues isDark={isDark} rows={[
            ["Operation", swapKindOf(draft) ? `${meta.singular} (${swapKindOf(draft)})` : amendSubtype ? `${meta.singular} (start-date adjustment)` : meta.singular],
            ["Account", account?.name ?? "—"],
            ["Contract", contractName ?? "None"],
            ["Opportunity", opps.find(o => o.id === opportunityId)?.name ?? "None"],
            kind === "renew" ? ["Renewal window", `${window?.start ?? "Salesforce default"} → ${window?.end ?? "Salesforce default"}`] : [kind === "cancel" ? "Cancellation date" : "Effective date", effectiveDate || "—"],
            ["Assets", assets.length ? assets.map(a => a.name).join(", ") : "—"],
            ...(kind === "amend" && adds.length ? [["Added products", adds.map(a => `${a.productName} × ${a.quantity}`).join(", ")] as [string, string]] : []),
            ...(kind === "renew" && ramp ? [["Ramp", `${ramp.segmentType}, ${ramp.durationInMonths} months${ramp.segmentCount ? `, ${ramp.segmentCount} segments` : ""}`] as [string, string]] : []),
            ...(kind === "cancel" ? [["Reason", reason || "—"] as [string, string]] : []),
            ["Bill-To Contact", billing.billToContactName ?? billing.billToContactId ?? "—"],
            ["Billing address", addressText(billing.billingAddress) || "—"],
            ["Shipping address", addressText(billing.shippingAddress) || "—"],
          ]} />
          {!ready ? <Notice isDark={isDark} tone="info">Choose an account and at least one asset — or describe the transaction in the prompt above — and the preview fills in as you go.</Notice> : (
            <>
              <TableFrame isDark={isDark}>
                <thead><tr>{["Asset", "Change", "Qty (Salesforce now)", "Requested change", "Result", "Price (Salesforce now)", "Requested price / discount", "End: now → requested", "Est. impact* (app)"].map((h, i) => <th key={`${h}-${i}`} style={th(t)}>{h}</th>)}</tr></thead>
                <tbody>{previewRows(draft).map(r => (
                  <tr key={r.assetId}>
                    <td style={td(t)}>{r.name}<div style={{ fontSize: 10.5, color: t.dim }}>{r.fieldChanges.join(" · ")}</div></td><td style={td(t)}>{r.kind}</td>
                    <td style={td(t)}>{fmtNum(r.originalQuantity)}</td><td style={td(t)}>{r.quantityChange > 0 ? `+${r.quantityChange}` : r.quantityChange}</td><td style={td(t)}>{fmtNum(r.resultingQuantity)}</td>
                    <td style={td(t)}>{fmtMoney(r.originalUnitPrice)}{r.originalDiscount ? ` −${r.originalDiscount}%` : ""}</td><td style={td(t)}>{r.newUnitPrice != null ? fmtMoney(r.newUnitPrice) : "—"}{r.newDiscount != null ? ` −${r.newDiscount}%` : ""}</td>
                    <td style={td(t)}>{fmtDate(r.originalEnd)} → {r.newEnd ?? "—"}{r.remainingDays != null ? <div style={{ fontSize: 10.5, color: t.dim }}>{r.remainingDays} day(s) left</div> : null}</td>
                    <td style={td(t)}>{r.estimatedChange != null ? fmtMoney(r.estimatedChange) : "—"}</td>
                  </tr>
                ))}</tbody>
              </TableFrame>
              <div style={{ fontSize: 11, color: t.dim }}>* App estimate (unit price × quantity, no proration or tax). Salesforce&apos;s pricing on the {meta.singular.toLowerCase()} quote — including proration, credits and tax — is what counts, and is shown on the transaction page.</div>
              {problems.length > 0 ? <Notice isDark={isDark} tone="error"><b>Fix before sending to Salesforce:</b><ReasonList isDark={isDark} reasons={problems.map(m => ({ code: "PLAN", severity: "error", message: m }))} /></Notice>
                : <Notice isDark={isDark} tone="success">The plan is valid. Saving stores it in the app only; &quot;Save &amp; create in Salesforce&quot; asks you to confirm once before anything is sent, and activation asks again.</Notice>}
              <CodeBlock isDark={isDark} data={swapKindOf(draft) ? { action: `POST ${swapRequest(draft)!.path}`, body: swapRequest(draft)!.body, note: "The replacement line's selling-model fields and list price are added from its price book entry when sent." } : { action: `POST /actions/standard/${kind === "amend" ? "initiateAmendment" : kind === "renew" ? "initiateRenewal" : "initiateCancellation"}`, body: initiateRequest(draft) }} label="Show the exact Salesforce request" />
            </>
          )}
        </div>
      </Panel>

      {error && <ErrorPanel isDark={isDark} error={error} />}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <GhostButton label="Cancel" icon="x" isDark={isDark} onClick={onCancel} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <GhostButton isDark={isDark} label={saving ? "Saving…" : tx ? "Save changes" : `Save ${meta.singular.toLowerCase()} plan`} icon="save" disabled={saving || !ready || (kind === "cancel" && cancelMode === "partial")} onClick={() => void save(false)} />
          <PrimaryButton isDark={isDark} label="Save & create in Salesforce…" icon="send" disabled={saving || !ready || problems.length > 0} onClick={() => void save(true)} />
        </div>
      </div>
    </div>
  );
}
