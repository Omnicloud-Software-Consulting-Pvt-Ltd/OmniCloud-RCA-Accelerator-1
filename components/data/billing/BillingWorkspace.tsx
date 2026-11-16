"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Ic } from "@/components/data/dashboardShell";
import { tokens } from "@/components/data/quotes/shared";
import BillingDashboard from "@/components/data/billing/BillingDashboard";
import BillingModuleDashboard from "@/components/data/billing/BillingModuleDashboard";
import BillingHistory from "@/components/data/billing/BillingHistory";
import BillingRecordDetail from "@/components/data/billing/BillingRecordDetail";
import BillingCreateWorkspace from "@/components/data/billing/BillingCreateWorkspace";
import BillingEditWorkspace from "@/components/data/billing/BillingEditWorkspace";
import BillingAssignWorkspace from "@/components/data/billing/BillingAssignWorkspace";
import BillingProductBilling from "@/components/data/billing/BillingProductBilling";
import BillingOrderSetup from "@/components/data/billing/BillingOrderSetup";
import BillingPaymentsWorkspace, { type PaymentsView } from "@/components/data/billing/BillingPaymentsWorkspace";
import BillingCreditMemosWorkspace, { type CreditMemosView } from "@/components/data/billing/BillingCreditMemosWorkspace";
import BillingDebitMemosWorkspace, { type DebitMemosView } from "@/components/data/billing/BillingDebitMemosWorkspace";
import TaxWorkspace, { type TaxView } from "@/components/data/billing/tax/TaxWorkspace";
import { BillingModuleInspector, BillingOrgDiscovery } from "@/components/data/billing/BillingConfigInspector";
import { Breadcrumbs, ToolbarButton, useBillingData } from "@/components/data/billing/billingUi";
import type { BillingNavTarget } from "@/lib/billing/client";
import BulkAssignmentPage from "@/components/data/policy-assignment/BulkAssignmentPage";
import { BULK_ASSIGNMENT_KIND_FOR_MODULE, BULK_ASSIGNMENT_VIEW } from "@/lib/policyAssignment/navigation";
import { getBillingModule, type AppModuleLink } from "@/lib/billing/registry";
import type { BillingAnalysisResult, BillingReferenceValue, BillingStatsResponse } from "@/lib/billing/types";

type View =
  | { kind: "dashboard" }
  | { kind: "discovery" }
  | { kind: "module" | "history" | "inspect"; moduleKey: string }
  | { kind: "bulk-assign"; moduleKey: string }
  | { kind: "create"; moduleKey: string; prompt?: string; analysis?: BillingAnalysisResult | null; nonce?: number; prefill?: Record<string, BillingReferenceValue> }
  | { kind: "detail" | "edit"; moduleKey: string; id: string }
  | { kind: "assign"; productId?: string | null; policyId?: string | null; nonce?: number }
  | { kind: "product"; id: string }
  | { kind: "order"; id: string }
  | { kind: "payments"; view: PaymentsView; nonce?: number }
  | { kind: "credit-memos"; view: CreditMemosView; nonce?: number }
  | { kind: "debit-memos"; view: DebitMemosView; nonce?: number }
  | { kind: "tax"; view: TaxView; nonce?: number };

export interface BillingUrlPatch { bm: string | null; bv: string | null; bid: string | null }

function viewFromInitial(initial: { moduleKey: string | null; view: string | null; recordId: string | null }): View {
  const { moduleKey, view, recordId } = initial;
  if (view === "discovery") return { kind: "discovery" };
  if (view === "assign") return { kind: "assign", productId: moduleKey === "product" ? recordId : null, policyId: moduleKey === "billing-policies" ? recordId : null };
  if (view === "product" && recordId) return { kind: "product", id: recordId };
  if (view === "order" && recordId) return { kind: "order", id: recordId };
  if (view === "tax" || (moduleKey === "tax" && !view)) return { kind: "tax", view: { mode: "dashboard" } };
  if (view === "tax-run" && recordId) return { kind: "tax", view: { mode: "run", orderId: recordId } };
  if (view === "debit-memos" || (moduleKey === "debit-memos" && !view)) return { kind: "debit-memos", view: { mode: "dashboard" } };
  if (view === "debit-memo" && recordId) return { kind: "debit-memos", view: { mode: "detail", id: recordId } };
  if (view === "credit-memos" || (moduleKey === "credit-memos" && !view)) return { kind: "credit-memos", view: { mode: "dashboard" } };
  if (view === "credit-memo-create") return { kind: "credit-memos", view: { mode: "create", invoiceId: recordId } };
  if (view === "credit-memo" && recordId) return { kind: "credit-memos", view: { mode: "detail", id: recordId } };
  if (view === "payments") return { kind: "payments", view: { mode: "dashboard" } };
  if (view === "payment-record") return { kind: "payments", view: { mode: "record", invoiceId: recordId } };
  if (view === "payment" && recordId) return { kind: "payments", view: { mode: "detail", id: recordId } };
  if (view === "payment-settle") return { kind: "payments", view: { mode: "settle", invoiceId: recordId } };
  if (view === "payment-settle-from" && recordId) return { kind: "payments", view: { mode: "settle", paymentId: recordId } };
  // The payments module is served by the dedicated Payments workspace (never the generic create/detail views).
  if (moduleKey === "payments") return view === "create" ? { kind: "payments", view: { mode: "record" } } : view === "detail" && recordId ? { kind: "payments", view: { mode: "detail", id: recordId } } : { kind: "payments", view: { mode: "dashboard" } };
  if (!moduleKey || !getBillingModule(moduleKey)) return { kind: "dashboard" };
  if (view === BULK_ASSIGNMENT_VIEW && BULK_ASSIGNMENT_KIND_FOR_MODULE[moduleKey] === "billing") return { kind: "bulk-assign", moduleKey };
  if ((view === "detail" || view === "edit") && recordId) return { kind: view, moduleKey, id: recordId };
  if (view === "history" || view === "inspect" || view === "create") return view === "create" ? { kind: "create", moduleKey } : { kind: view, moduleKey };
  return { kind: "module", moduleKey };
}

function toUrl(v: View): BillingUrlPatch {
  if (v.kind === "dashboard") return { bm: null, bv: null, bid: null };
  if (v.kind === "discovery") return { bm: null, bv: "discovery", bid: null };
  if (v.kind === "assign") return { bm: v.productId ? "product" : v.policyId ? "billing-policies" : null, bv: "assign", bid: v.productId ?? v.policyId ?? null };
  if (v.kind === "product") return { bm: null, bv: "product", bid: v.id };
  if (v.kind === "order") return { bm: null, bv: "order", bid: v.id };
  if (v.kind === "tax") return { bm: "tax", bv: v.view.mode === "run" ? "tax-run" : "tax", bid: v.view.mode === "run" ? v.view.orderId : null };
  if (v.kind === "debit-memos") return { bm: "debit-memos", bv: v.view.mode === "detail" ? "debit-memo" : "debit-memos", bid: v.view.mode === "detail" ? v.view.id : null };
  if (v.kind === "credit-memos") {
    const cv = v.view;
    return { bm: "credit-memos", bv: cv.mode === "dashboard" ? "credit-memos" : cv.mode === "create" ? "credit-memo-create" : "credit-memo", bid: cv.mode === "create" ? cv.invoiceId ?? null : cv.mode === "detail" ? cv.id : null };
  }
  if (v.kind === "payments") {
    const pv = v.view;
    if (pv.mode === "settle") return pv.paymentId ? { bm: "payments", bv: "payment-settle-from", bid: pv.paymentId } : { bm: "payments", bv: "payment-settle", bid: pv.invoiceId ?? null };
    return { bm: "payments", bv: pv.mode === "dashboard" ? "payments" : pv.mode === "record" ? "payment-record" : "payment", bid: pv.mode === "record" ? pv.invoiceId ?? null : pv.mode === "detail" ? pv.id : null };
  }
  if (v.kind === "bulk-assign") return { bm: v.moduleKey, bv: BULK_ASSIGNMENT_VIEW, bid: null };
  return { bm: v.moduleKey, bv: v.kind === "module" ? null : v.kind, bid: v.kind === "detail" || v.kind === "edit" ? v.id : null };
}

/**
 * Revenue Cloud Billing workspace, mounted by DataOmnion (app/data/page.tsx)
 * for the "Revenue Cloud Billing" sidebar section. Owns its own view state
 * machine — Dashboard → Module dashboard → Create (AI | Manual) → Preview →
 * Result → Details / History — and mirrors it into the page URL so a refresh
 * restores the same screen. Products, Orders, Contracts, Quotes and Invoices
 * are never re-implemented here: links to them go back through the page to
 * the existing modules via `onOpenAppModule`.
 */
export default function BillingWorkspace({ isDark, initial, onUrlChange, onActiveModuleChange, onOpenAppModule }: {
  isDark: boolean;
  initial: { moduleKey: string | null; view: string | null; recordId: string | null };
  onUrlChange: (patch: BillingUrlPatch) => void;
  onActiveModuleChange?: (moduleKey: string | null) => void;
  onOpenAppModule: (module: AppModuleLink, recordId?: string) => void;
}) {
  const t = tokens(isDark);
  const [view, setViewState] = useState<View>(() => viewFromInitial(initial));
  const [backStack, setBackStack] = useState<View[]>([]);
  const [statsRefresh, setStatsRefresh] = useState(0);
  const stats = useBillingData<BillingStatsResponse>("Load billing dashboard", `/api/billing/stats${statsRefresh ? `?fresh=1&n=${statsRefresh}` : ""}`);

  function go(target: View, opts: { replace?: boolean } = {}) {
    const next = paymentsRedirect(target);
    if (!opts.replace) setBackStack(s => [...s.slice(-19), view]);
    setViewState(next);
    onUrlChange(toUrl(next));
    onActiveModuleChange?.(next.kind === "payments" ? "payments" : next.kind === "credit-memos" ? "credit-memos" : next.kind === "debit-memos" ? "debit-memos" : next.kind === "tax" ? "tax" : "moduleKey" in next ? next.moduleKey : null);
  }

  // Generic module views for "payments" are replaced by the Payments workspace (one shared payment service).
  function paymentsRedirect(v: View): View {
    if (!("moduleKey" in v) || v.moduleKey !== "payments") return v;
    if (v.kind === "create") return { kind: "payments", view: { mode: "record" }, nonce: Date.now() };
    if ((v.kind === "detail" || v.kind === "edit") && "id" in v) return { kind: "payments", view: { mode: "detail", id: v.id } };
    if (v.kind === "inspect") return v;
    return { kind: "payments", view: { mode: "dashboard" } };
  }

  function back() {
    const prev = backStack[backStack.length - 1];
    if (!prev) { go({ kind: "dashboard" }, { replace: true }); return; }
    setBackStack(s => s.slice(0, -1));
    setViewState(prev);
    onUrlChange(toUrl(prev));
    onActiveModuleChange?.(prev.kind === "payments" ? "payments" : prev.kind === "credit-memos" ? "credit-memos" : prev.kind === "debit-memos" ? "debit-memos" : prev.kind === "tax" ? "tax" : "moduleKey" in prev ? prev.moduleKey : null);
  }

  function navigate(target: BillingNavTarget) {
    if (target.product) { go({ kind: "product", id: target.product.id }); return; }
    if (target.order) { go({ kind: "order", id: target.order.id }); return; }
    if (target.payment) { go({ kind: "payments", view: target.payment, nonce: Date.now() }); return; }
    if (target.tax) { go({ kind: "tax", view: target.tax, nonce: Date.now() }); return; }
    if (target.debitMemo) { go({ kind: "debit-memos", view: target.debitMemo, nonce: Date.now() }); return; }
    if (target.creditMemo) { go({ kind: "credit-memos", view: target.creditMemo, nonce: Date.now() }); return; }
    if (target.assign) { go({ kind: "assign", productId: target.assign.productId ?? null, policyId: target.assign.policyId ?? null, nonce: Date.now() }); return; }
    if (target.app) { onOpenAppModule(target.app.module, target.app.recordId); return; }
    const b = target.billing;
    if (!b) return;
    if ((b.view === "detail" || b.view === "edit") && b.id) go({ kind: b.view, moduleKey: b.moduleKey, id: b.id });
    else if (b.view === "create") go({ kind: "create", moduleKey: b.moduleKey, nonce: Date.now() });
    else if (b.view === "bulk-assignment") go({ kind: "bulk-assign", moduleKey: b.moduleKey });
    else go({ kind: b.view === "history" ? "history" : "module", moduleKey: b.moduleKey });
  }

  const refreshStats = () => setStatsRefresh(n => n + 1);
  const moduleStatus = (key: string) => stats.data?.modules.find(m => m.moduleKey === key) ?? null;
  const def = "moduleKey" in view ? getBillingModule(view.moduleKey) : null;

  const crumbs: { label: string; onClick?: () => void }[] = [{ label: "Revenue Cloud Billing", onClick: view.kind === "dashboard" ? undefined : () => go({ kind: "dashboard" }) }];
  if (view.kind === "discovery") crumbs.push({ label: "Metadata Discovery" });
  if (view.kind === "assign") crumbs.push({ label: "Assign Billing Policy to Product" });
  if (view.kind === "product") crumbs.push({ label: "Product Billing" });
  if (view.kind === "order") crumbs.push({ label: "Order Setup" });
  if (view.kind === "tax") {
    crumbs.push({ label: "Tax", onClick: view.view.mode === "run" ? () => go({ kind: "tax", view: { mode: "dashboard", tab: "verification" } }) : undefined });
    if (view.view.mode === "run") crumbs.push({ label: "Tax Result" });
  }
  if (view.kind === "debit-memos") {
    crumbs.push({ label: "Debit Memos", onClick: view.view.mode === "dashboard" ? undefined : () => go({ kind: "debit-memos", view: { mode: "dashboard" } }) });
    if (view.view.mode === "detail") crumbs.push({ label: "Debit Memo Details" });
  }
  if (view.kind === "credit-memos") {
    crumbs.push({ label: "Credit Memos", onClick: view.view.mode === "dashboard" ? undefined : () => go({ kind: "credit-memos", view: { mode: "dashboard" } }) });
    if (view.view.mode === "create") crumbs.push({ label: "Create Credit Memo" });
    if (view.view.mode === "detail") crumbs.push({ label: "Credit Memo Details" });
  }
  if (view.kind === "payments") {
    crumbs.push({ label: "Payments", onClick: view.view.mode === "dashboard" ? undefined : () => go({ kind: "payments", view: { mode: "dashboard" } }) });
    if (view.view.mode === "record") crumbs.push({ label: "Record Payment" });
    if (view.view.mode === "settle") crumbs.push({ label: "Settle Payment" });
    if (view.view.mode === "detail") crumbs.push({ label: "Payment Details" });
  }
  if (def && "moduleKey" in view) {
    crumbs.push({ label: def.label, onClick: view.kind === "module" ? undefined : () => go({ kind: "module", moduleKey: view.moduleKey }) });
    if (view.kind === "history") crumbs.push({ label: "History" });
    if (view.kind === "create") crumbs.push({ label: `Create ${def.singular}` });
    if (view.kind === "inspect") crumbs.push({ label: "Salesforce Configuration" });
    if (view.kind === "bulk-assign") crumbs.push({ label: "Bulk Product Assignment" });
    if (view.kind === "detail") crumbs.push({ label: "Details" });
    if (view.kind === "edit") crumbs.push({ label: "Details", onClick: () => go({ kind: "detail", moduleKey: view.moduleKey, id: view.id }) }, { label: "Edit" });
  }

  const viewKey = `${view.kind}:${"moduleKey" in view ? view.moduleKey : ""}:${view.kind === "detail" || view.kind === "edit" ? view.id : ""}:${view.kind === "create" || view.kind === "assign" ? view.nonce ?? 0 : ""}${view.kind === "product" || view.kind === "order" ? view.id : ""}${view.kind === "tax" ? `tax:${view.view.mode}:${view.view.mode === "run" ? view.view.orderId : view.view.tab ?? ""}:${view.nonce ?? 0}` : ""}${view.kind === "debit-memos" ? `dm:${view.view.mode}:${"id" in view.view ? view.view.id : ""}:${view.nonce ?? 0}` : ""}${view.kind === "credit-memos" ? `cm:${view.view.mode}:${"id" in view.view ? view.view.id : ""}:${view.view.mode === "create" ? view.view.invoiceId ?? "" : ""}:${view.nonce ?? 0}` : ""}${view.kind === "payments" ? `${view.view.mode}:${"id" in view.view ? view.view.id : ""}:${view.view.mode === "record" || view.view.mode === "settle" ? view.view.invoiceId ?? "" : ""}${view.view.mode === "settle" ? view.view.paymentId ?? "" : ""}:${view.nonce ?? 0}` : ""}`;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 18px", borderBottom: `1px solid ${t.border}`, flexShrink: 0, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {view.kind !== "dashboard" && (
            <motion.button onClick={back} whileHover={{ x: -2 }} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: t.accent, background: "transparent", border: "none", cursor: "pointer", padding: "4px 6px", borderRadius: 7 }}>
              <Ic n="arrow-left" s={12} /> Back
            </motion.button>
          )}
          <Breadcrumbs isDark={isDark} items={crumbs} />
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {def && "moduleKey" in view && view.kind !== "create" && moduleStatus(view.moduleKey)?.createable && (
            <ToolbarButton isDark={isDark} label={`Create New ${def.singular}`} icon="plus" primary onClick={() => go({ kind: "create", moduleKey: view.moduleKey, nonce: Date.now() })} />
          )}
          {def && "moduleKey" in view && view.kind !== "history" && (
            <ToolbarButton isDark={isDark} label="History" icon="list" onClick={() => go({ kind: "history", moduleKey: view.moduleKey })} />
          )}
          {def && "moduleKey" in view && view.kind !== "inspect" && (
            <ToolbarButton isDark={isDark} label="Salesforce Config" icon="database" onClick={() => go({ kind: "inspect", moduleKey: view.moduleKey })} />
          )}
          {view.kind === "dashboard" && <ToolbarButton isDark={isDark} label="Assign Billing Policy to Product" icon="link" onClick={() => go({ kind: "assign", nonce: Date.now() })} />}
          {view.kind === "dashboard" && <ToolbarButton isDark={isDark} label="Metadata Discovery" icon="database" onClick={() => go({ kind: "discovery" })} />}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div key={viewKey} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="flex flex-col h-full overflow-hidden">
            {view.kind === "dashboard" && (
              <BillingDashboard
                isDark={isDark}
                stats={stats.data}
                statsError={stats.error}
                statsLoading={stats.loading}
                onReload={refreshStats}
                onNavigate={navigate}
                onDiscovery={() => go({ kind: "discovery" })}
                onAnalyzed={(analysis, prompt) => go({ kind: "create", moduleKey: analysis.moduleKey, prompt, analysis, nonce: Date.now() })}
              />
            )}
            {view.kind === "assign" && (
              <BillingAssignWorkspace
                isDark={isDark}
                initialProductId={view.productId}
                initialPolicyId={view.policyId}
                onCancel={back}
                onAssigned={refreshStats}
                onViewProduct={id => go({ kind: "product", id })}
                onViewPolicy={id => go({ kind: "detail", moduleKey: "billing-policies", id })}
              />
            )}
            {view.kind === "product" && (
              <BillingProductBilling
                isDark={isDark}
                productId={view.id}
                onViewPolicy={id => go({ kind: "detail", moduleKey: "billing-policies", id })}
                onViewTreatment={id => go({ kind: "detail", moduleKey: "billing-treatments", id })}
                onAssign={(productId, policyId) => go({ kind: "assign", productId, policyId: policyId ?? null, nonce: Date.now() })}
                onOpenProducts={() => onOpenAppModule("products")}
              />
            )}
            {view.kind === "tax" && (
              <TaxWorkspace
                isDark={isDark}
                view={view.view}
                onNavigate={v => go({ kind: "tax", view: v, nonce: Date.now() })}
                onOpenInvoice={id => go({ kind: "detail", moduleKey: "invoices", id })}
              />
            )}
            {view.kind === "debit-memos" && (
              <BillingDebitMemosWorkspace
                isDark={isDark}
                view={view.view}
                onNavigate={v => go({ kind: "debit-memos", view: v, nonce: Date.now() })}
                onOpenInvoice={id => go({ kind: "detail", moduleKey: "invoices", id })}
              />
            )}
            {view.kind === "credit-memos" && (
              <BillingCreditMemosWorkspace
                isDark={isDark}
                view={view.view}
                onNavigate={v => go({ kind: "credit-memos", view: v, nonce: Date.now() })}
                onOpenInvoice={id => go({ kind: "detail", moduleKey: "invoices", id })}
                onOpenOrder={id => onOpenAppModule("orders", id)}
                onOpenSchedule={id => go({ kind: "detail", moduleKey: "billing-schedules", id })}
              />
            )}
            {view.kind === "payments" && (
              <BillingPaymentsWorkspace
                isDark={isDark}
                view={view.view}
                onNavigate={v => go({ kind: "payments", view: v, nonce: Date.now() })}
                onOpenInvoice={id => go({ kind: "detail", moduleKey: "invoices", id })}
                onOpenOrder={id => onOpenAppModule("orders", id)}
                onOpenSchedule={id => go({ kind: "detail", moduleKey: "billing-schedules", id })}
              />
            )}
            {view.kind === "order" && (
              <BillingOrderSetup
                isDark={isDark}
                orderId={view.id}
                onOpenOrder={id => onOpenAppModule("orders", id)}
                onOpenPolicy={id => go({ kind: "detail", moduleKey: "billing-policies", id })}
                onOpenSchedule={id => go({ kind: "detail", moduleKey: "billing-schedules", id })}
                onOpenInvoice={id => go({ kind: "detail", moduleKey: "invoices", id })}
                onOpenPayments={(invoiceId, mode) => mode === "credit" ? go({ kind: "credit-memos", view: { mode: "create", invoiceId: invoiceId ?? null }, nonce: Date.now() }) : go({ kind: "payments", view: invoiceId ? (mode === "settle" ? { mode: "settle", invoiceId } : { mode: "record", invoiceId }) : { mode: "dashboard" }, nonce: Date.now() })}
                onAssignPolicy={productId => go({ kind: "assign", productId, nonce: Date.now() })}
                onChanged={refreshStats}
              />
            )}
            {view.kind === "discovery" && <BillingOrgDiscovery isDark={isDark} onOpenModule={key => go({ kind: "module", moduleKey: key })} />}
            {view.kind === "module" && (
              <BillingModuleDashboard
                isDark={isDark}
                moduleKey={view.moduleKey}
                status={moduleStatus(view.moduleKey)}
                onNavigate={navigate}
                onInspect={() => go({ kind: "inspect", moduleKey: view.moduleKey })}
                onRefreshStats={refreshStats}
              />
            )}
            {view.kind === "history" && (
              <BillingHistory
                isDark={isDark}
                moduleKey={view.moduleKey}
                canCreate={!!moduleStatus(view.moduleKey)?.createable}
                onCreate={() => go({ kind: "create", moduleKey: view.moduleKey, nonce: Date.now() })}
                onOpen={id => go({ kind: "detail", moduleKey: view.moduleKey, id })}
                onEdit={id => go({ kind: "edit", moduleKey: view.moduleKey, id })}
                onAssign={view.moduleKey === "billing-policies" ? id => go({ kind: "assign", policyId: id, nonce: Date.now() }) : undefined}
                onNavigate={navigate}
              />
            )}
            {view.kind === "inspect" && <BillingModuleInspector isDark={isDark} moduleKey={view.moduleKey} />}
            {view.kind === "bulk-assign" && (
              <BulkAssignmentPage isDark={isDark} kind="billing" onBackToPolicies={() => go({ kind: "module", moduleKey: view.moduleKey })} onAssigned={refreshStats}
                onSingleAssign={() => go({ kind: "assign", nonce: Date.now() })} />
            )}
            {view.kind === "detail" && (
              <BillingRecordDetail isDark={isDark} moduleKey={view.moduleKey} recordId={view.id} onNavigate={navigate} onBack={back}
                onEdit={() => go({ kind: "edit", moduleKey: view.moduleKey, id: view.id })} />
            )}
            {view.kind === "edit" && (
              <BillingEditWorkspace
                isDark={isDark}
                moduleKey={view.moduleKey}
                recordId={view.id}
                onCancel={back}
                onSaved={id => { refreshStats(); go({ kind: "detail", moduleKey: view.moduleKey, id }, { replace: true }); }}
                onOpenRecord={(key, id) => go({ kind: "detail", moduleKey: key, id })}
                onEditRecord={(key, id) => go({ kind: "edit", moduleKey: key, id })}
                onCreateChild={(key, refs) => go({ kind: "create", moduleKey: key, nonce: Date.now(), prefill: refs })}
              />
            )}
            {view.kind === "create" && (
              <BillingCreateWorkspace
                isDark={isDark}
                moduleKey={view.moduleKey}
                initialPrompt={view.prompt}
                initialAnalysis={view.analysis}
                initialReferences={view.prefill}
                onCancel={() => go({ kind: "module", moduleKey: view.moduleKey })}
                onOpenRecord={(key, id) => go({ kind: "detail", moduleKey: key, id })}
                onOpenHistory={() => go({ kind: "history", moduleKey: view.moduleKey })}
                onSwitchModule={(key, prompt) => go({ kind: "create", moduleKey: key, prompt, nonce: Date.now() })}
                onCreated={refreshStats}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
