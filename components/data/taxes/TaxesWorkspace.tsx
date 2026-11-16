"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, ErrorPanel } from "@/components/data/quotes/shared";
import { Breadcrumbs, LoadingRow, ToolbarButton, useBillingData } from "@/components/data/billing/billingUi";
import BillingModuleDashboard from "@/components/data/billing/BillingModuleDashboard";
import BillingHistory from "@/components/data/billing/BillingHistory";
import BillingRecordDetail from "@/components/data/billing/BillingRecordDetail";
import BillingCreateWorkspace from "@/components/data/billing/BillingCreateWorkspace";
import BillingEditWorkspace from "@/components/data/billing/BillingEditWorkspace";
import { BillingModuleInspector } from "@/components/data/billing/BillingConfigInspector";
import TaxCreate, { AiPrompt } from "@/components/data/billing/tax/TaxCreate";
import TaxReadiness from "@/components/data/billing/tax/TaxReadiness";
import { ProductReadinessPanel } from "@/components/data/taxes/TaxCalculation";
import SalesforceTaxPanel from "@/components/data/taxes/SalesforceTaxPanel";
import { DecisionTableRefreshPanel } from "@/components/data/taxes/CalculationPlanView";
import { VerificationHome, VerificationRun } from "@/components/data/billing/tax/TaxVerification";
import { useConnectionKey, withConnection } from "@/components/data/billing/tax/taxUi";
import TaxesDashboard, { type TaxesLaunch } from "@/components/data/taxes/TaxesDashboard";
import RateReplacePanel from "@/components/data/taxes/RateReplacePanel";
import type { BillingNavTarget } from "@/lib/billing/client";
import BulkAssignmentPage from "@/components/data/policy-assignment/BulkAssignmentPage";
import TaxRateLibrary from "@/components/data/taxes/library/TaxRateLibrary";
import PrefillNotice from "@/components/data/taxes/library/PrefillNotice";
import { RATE_LIBRARY_MODULE, RATE_LIBRARY_VIEW } from "@/lib/taxLibrary/navigation";
import { BULK_ASSIGNMENT_KIND_FOR_MODULE, BULK_ASSIGNMENT_VIEW } from "@/lib/policyAssignment/navigation";
import { getBillingModule, type AppModuleLink } from "@/lib/billing/registry";
import type { BillingReferenceValue, BillingStatsResponse } from "@/lib/billing/types";
import type { TaxDashboard } from "@/lib/tax/types";
import { classifyTaxProvider, UNKNOWN_PROVIDER } from "@/lib/taxes/provider";
import { TaxConfigHelp } from "@/components/data/taxes/NativeTaxGuidance";
import { useNotify } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiGet, toErrorPanelData } from "@/lib/quotes/client/apiClient";

/**
 * TAXES — the top-level Taxes section (app/data/page.tsx). Composes what already exists instead of re-implementing it:
 *  · tax objects (policies, treatments, items, rates, geography, engines, decision tables) → the app's generic describe-driven
 *    record engine (module dashboard, history/search, Salesforce-style create/edit forms with lookups, detail, inspector),
 *  · Configure (AI / Manual), Calculation and Engine Readiness → the lib/tax service and its existing tax components.
 * The view state is mirrored into the URL (tv / tm / tid) so a refresh restores the same screen.
 */
type View =
  | { kind: "dashboard" }
  | { kind: "configure"; tab: "ai" | "manual"; nonce?: number }
  | { kind: "calculation" }
  | { kind: "run"; orderId: string }
  | { kind: "readiness" }
  | { kind: "module" | "history" | "inspect"; moduleKey: string }
  | { kind: "bulk-assign"; moduleKey: string }
  | { kind: "rate-library"; moduleKey: string; country?: string | null }
  | { kind: "create"; moduleKey: string; nonce?: number; prefill?: Record<string, BillingReferenceValue>; fields?: Record<string, string | number>; notice?: { notices: string[]; warnings: string[]; summary: string } }
  | { kind: "detail" | "edit"; moduleKey: string; id: string };

export interface TaxesUrlPatch { tv: string | null; tm: string | null; tid: string | null }
export interface TaxesInitial { view: string | null; moduleKey: string | null; recordId: string | null }

function viewFromInitial(i: TaxesInitial): View {
  if (i.view === "configure" || i.view === "configure-manual") return { kind: "configure", tab: i.view === "configure" ? "ai" : "manual" };
  if (i.view === "calculation") return { kind: "calculation" };
  if (i.view === "run" && i.recordId) return { kind: "run", orderId: i.recordId };
  if (i.view === "readiness") return { kind: "readiness" };
  if (!i.moduleKey || !getBillingModule(i.moduleKey)) return { kind: "dashboard" };
  if (i.view === BULK_ASSIGNMENT_VIEW && BULK_ASSIGNMENT_KIND_FOR_MODULE[i.moduleKey] === "tax") return { kind: "bulk-assign", moduleKey: i.moduleKey };
  if (i.view === RATE_LIBRARY_VIEW && i.moduleKey === RATE_LIBRARY_MODULE) return { kind: "rate-library", moduleKey: i.moduleKey };
  if ((i.view === "detail" || i.view === "edit") && i.recordId) return { kind: i.view, moduleKey: i.moduleKey, id: i.recordId };
  if (i.view === "create") return { kind: "create", moduleKey: i.moduleKey };
  if (i.view === "history" || i.view === "inspect") return { kind: i.view, moduleKey: i.moduleKey };
  return { kind: "module", moduleKey: i.moduleKey };
}
function toUrl(v: View): TaxesUrlPatch {
  switch (v.kind) {
    case "dashboard": return { tv: null, tm: null, tid: null };
    case "configure": return { tv: v.tab === "ai" ? "configure" : "configure-manual", tm: null, tid: null };
    case "calculation": case "readiness": return { tv: v.kind, tm: null, tid: null };
    case "run": return { tv: "run", tm: null, tid: v.orderId };
    case "detail": case "edit": return { tv: v.kind, tm: v.moduleKey, tid: v.id };
    case "create": case "history": case "inspect": return { tv: v.kind, tm: v.moduleKey, tid: null };
    case "bulk-assign": return { tv: BULK_ASSIGNMENT_VIEW, tm: v.moduleKey, tid: null };
    case "rate-library": return { tv: RATE_LIBRARY_VIEW, tm: v.moduleKey, tid: null };
    default: return { tv: null, tm: v.moduleKey, tid: null };
  }
}
/** The sidebar item that matches a view (for the highlight). */
export function taxesNavKey(v: TaxesUrlPatch): string { return v.tv && ["configure", "configure-manual", "calculation", "readiness", "run"].includes(v.tv) ? (v.tv === "run" ? "calculation" : v.tv === "configure-manual" ? "configure" : v.tv) : v.tm ?? "dashboard"; }

export default function TaxesWorkspace({ isDark, initial, onUrlChange, onOpenAppModule }: {
  isDark: boolean; initial: TaxesInitial;
  onUrlChange: (patch: TaxesUrlPatch) => void;
  onOpenAppModule: (module: AppModuleLink, recordId?: string) => void;
}) {
  const t = tokens(isDark);
  const conn = useConnectionKey();
  const [view, setView] = useState<View>(() => viewFromInitial(initial));
  const [backStack, setBackStack] = useState<View[]>([]);
  const [refresh, setRefresh] = useState(0);
  const stats = useBillingData<BillingStatsResponse>("Load Taxes statistics", `/api/taxes/stats${refresh ? `?fresh=1&n=${refresh}` : ""}`);
  const summary = useBillingData<TaxDashboard>("Load tax status", conn !== "server" ? withConnection(`/api/taxes${refresh ? `?n=${refresh}` : ""}`, conn) : null);
  const reload = () => setRefresh(n => n + 1);
  const notify = useNotify();
  /**
   * A Tax Rate created from a Global Tax Library mapping: read it back from Salesforce and confirm its GeoCountryId / GeoStateId are
   * exactly the Geo records the mapping resolved (the relationship fields, not names). A changed lookup is reported, never hidden.
   */
  async function verifyLibraryRate(rateId: string, refs: Record<string, BillingReferenceValue>) {
    const p = new URLSearchParams({ mode: "verify-rate", id: rateId, geoCountryId: refs.GeoCountryId.id, ...(refs.GeoStateId ? { geoStateId: refs.GeoStateId.id } : {}) });
    try {
      const r = await quoteApiGet<{ verified: boolean; message: string }>("Verify Tax Rate geography", `/api/taxes/rate-library/salesforce?${p}`);
      (r.verified ? notify.success : notify.warning)(r.verified ? "Tax Rate geography verified" : "Tax Rate geography differs from the mapping", r.message, { module: "Taxes" });
    } catch (err) {
      notify.warning("Tax Rate geography not verified", toErrorPanelData(err, "The Tax Rate couldn't be read back").message, { module: "Taxes" });
    }
  }
  // Provider from the dashboard's own TaxEngine read: null while loading, unknown if the read failed — never assumed native.
  const provider = summary.data ? classifyTaxProvider(summary.data.engines) : summary.error ? UNKNOWN_PROVIDER : null;

  function go(next: View, opts: { replace?: boolean } = {}) {
    if (!opts.replace) setBackStack(s => [...s.slice(-19), view]);
    setView(next);
    onUrlChange(toUrl(next));
  }
  function back() {
    const prev = backStack[backStack.length - 1];
    if (!prev) { go({ kind: "dashboard" }, { replace: true }); return; }
    setBackStack(s => s.slice(0, -1)); setView(prev); onUrlChange(toUrl(prev));
  }
  function navigate(target: BillingNavTarget) {
    if (target.app) { onOpenAppModule(target.app.module, target.app.recordId); return; }
    if (target.product) { onOpenAppModule("products", target.product.id); return; }
    if (target.order) { onOpenAppModule("orders", target.order.id); return; }
    if (target.tax) { go(target.tax.mode === "run" ? { kind: "run", orderId: target.tax.orderId } : { kind: target.tax.tab === "readiness" ? "readiness" : target.tax.tab === "verification" ? "calculation" : target.tax.tab === "create" ? "configure" : "dashboard", tab: "ai" } as View); return; }
    const b = target.billing;
    if (!b) return;
    if ((b.view === "detail" || b.view === "edit") && b.id) go({ kind: b.view, moduleKey: b.moduleKey, id: b.id });
    else if (b.view === "create") go({ kind: "create", moduleKey: b.moduleKey, nonce: Date.now() });
    else if (b.view === "bulk-assignment") go({ kind: "bulk-assign", moduleKey: b.moduleKey });
    else if (b.view === "rate-library") go({ kind: "rate-library", moduleKey: b.moduleKey });
    else go({ kind: b.view === "history" ? "history" : "module", moduleKey: b.moduleKey });
  }
  function launch(l: TaxesLaunch) {
    if (l === "configure" || l === "configure-manual") go({ kind: "configure", tab: l === "configure" ? "ai" : "manual", nonce: Date.now() });
    else if (l === "calculation" || l === "readiness") go({ kind: l });
    else if ("library" in l) go({ kind: "rate-library", moduleKey: RATE_LIBRARY_MODULE, country: l.library.countryCode ?? null });
    else if (l.view === "detail") go({ kind: "detail", moduleKey: l.module, id: l.id });
    else navigate({ billing: { moduleKey: l.module, view: l.view } });
  }

  const def = "moduleKey" in view ? getBillingModule(view.moduleKey) : null;
  const status = (key: string) => stats.data?.modules.find(m => m.moduleKey === key) ?? null;
  const viewOnly = !!def?.viewOnly;
  const crumbs: { label: string; onClick?: () => void }[] = [{ label: "Taxes", onClick: view.kind === "dashboard" ? undefined : () => go({ kind: "dashboard" }) }];
  if (def) crumbs.push({ label: def.label, onClick: view.kind === "module" ? undefined : () => go({ kind: "module", moduleKey: def.key }) });
  const kindLabel: Partial<Record<View["kind"], string>> = { configure: "Configure", calculation: "Calculation", run: "Tax Result", readiness: "Engine Readiness", history: "Records", inspect: "Salesforce Config", create: "Create", detail: "Details", edit: "Edit", "bulk-assign": "Bulk Product Assignment", "rate-library": "Global Tax Rate Library" };
  if (kindLabel[view.kind]) crumbs.push({ label: kindLabel[view.kind]! });
  const calcBlocked = summary.data && summary.data.status.calculation !== "READY" ? summary.data.status.calculationDetail : null;
  const runNav = { onOpenRun: (orderId: string) => go({ kind: "run", orderId }), onOpenInvoice: (id: string) => go({ kind: "detail", moduleKey: "invoices", id }), onBack: () => go({ kind: "calculation" }) };
  const viewKey = JSON.stringify(view);
  const pad = (node: React.ReactNode) => <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 18 }}>{node}</div>;

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
          {def && <TaxConfigHelp isDark={isDark} moduleKey={def.key} provider={provider} />}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {def && "moduleKey" in view && view.kind !== "create" && !viewOnly && status(view.moduleKey)?.createable && <ToolbarButton isDark={isDark} label={`Create New ${def.singular}`} icon="plus" primary onClick={() => go({ kind: "create", moduleKey: def.key, nonce: Date.now() })} />}
          {def && "moduleKey" in view && view.kind !== "history" && <ToolbarButton isDark={isDark} label="View Records" icon="list" onClick={() => go({ kind: "history", moduleKey: def.key })} />}
          {def && "moduleKey" in view && view.kind !== "inspect" && <ToolbarButton isDark={isDark} label="Salesforce Config" icon="database" onClick={() => go({ kind: "inspect", moduleKey: def.key })} />}
          {view.kind === "dashboard" && <ToolbarButton isDark={isDark} label="AI Tax Configuration" icon="sparkles" primary onClick={() => launch("configure")} />}
          {view.kind === "dashboard" && <ToolbarButton isDark={isDark} label="Refresh" icon="refresh" onClick={reload} />}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div key={viewKey} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="flex flex-col h-full overflow-hidden">
            {view.kind === "dashboard" && <TaxesDashboard isDark={isDark} stats={stats.data} statsError={stats.error} statsLoading={stats.loading} summary={summary.data} provider={provider} connectionKey={conn} onReload={reload} onLaunch={launch} />}
            {view.kind === "configure" && pad(<TaxCreate key={view.nonce ?? 0} isDark={isDark} conn={conn} initialTab={view.tab} assistant onDone={reload} nav={{ onOpenRun: runNav.onOpenRun, calculationBlocked: calcBlocked }} />)}
            {view.kind === "calculation" && pad(<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <AiPrompt isDark={isDark} assistant variant="calculation" onDone={reload} nav={{ onOpenRun: runNav.onOpenRun, calculationBlocked: calcBlocked }} onEdit={() => go({ kind: "configure", tab: "manual", nonce: Date.now() })} />
              <SalesforceTaxPanel isDark={isDark} />
              {!summary.data ? (summary.error ? <ErrorPanel isDark={isDark} error={summary.error} /> : <LoadingRow isDark={isDark} label="Reading tax configuration from Salesforce…" />) : <VerificationHome isDark={isDark} conn={conn} dashboard={summary.data} nav={runNav} />}
            </div>)}
            {view.kind === "run" && pad(<VerificationRun isDark={isDark} orderId={view.orderId} conn={conn} nav={runNav} />)}
            {view.kind === "readiness" && pad(<div style={{ display: "flex", flexDirection: "column", gap: 16 }}><ProductReadinessPanel isDark={isDark} /><DecisionTableRefreshPanel isDark={isDark} /><TaxReadiness isDark={isDark} conn={conn} vocabulary="taxes" /></div>)}
            {view.kind === "module" && (
              <BillingModuleDashboard isDark={isDark} moduleKey={view.moduleKey} status={status(view.moduleKey)} onNavigate={navigate} onInspect={() => go({ kind: "inspect", moduleKey: view.moduleKey })} onRefreshStats={reload} />
            )}
            {view.kind === "history" && (
              <BillingHistory isDark={isDark} moduleKey={view.moduleKey} canCreate={!viewOnly && !!status(view.moduleKey)?.createable} onCreate={() => go({ kind: "create", moduleKey: view.moduleKey, nonce: Date.now() })}
                onOpen={id => go({ kind: "detail", moduleKey: view.moduleKey, id })} onEdit={viewOnly ? undefined : id => go({ kind: "edit", moduleKey: view.moduleKey, id })} onNavigate={navigate} />
            )}
            {view.kind === "inspect" && <BillingModuleInspector isDark={isDark} moduleKey={view.moduleKey} />}
            {view.kind === "rate-library" && (
              <TaxRateLibrary isDark={isDark} initialCountry={view.country ?? null} onOpenSalesforceRates={() => go({ kind: "history", moduleKey: RATE_LIBRARY_MODULE })}
                onUseRate={p => go({ kind: "create", moduleKey: RATE_LIBRARY_MODULE, nonce: Date.now(), prefill: p.references, fields: p.fields, notice: { notices: p.notices, warnings: p.warnings, summary: p.summary } })} />
            )}
            {view.kind === "bulk-assign" && <BulkAssignmentPage isDark={isDark} kind="tax" onBackToPolicies={() => go({ kind: "module", moduleKey: view.moduleKey })} onAssigned={reload} />}
            {view.kind === "detail" && (
              <div className="flex flex-col h-full overflow-y-auto">
                <BillingRecordDetail isDark={isDark} moduleKey={view.moduleKey} recordId={view.id} onNavigate={navigate} onBack={back} onEdit={viewOnly ? undefined : () => go({ kind: "edit", moduleKey: view.moduleKey, id: view.id })} />
                {view.moduleKey === "tax-rates" && <div style={{ padding: "0 18px 18px" }}><RateReplacePanel isDark={isDark} rateId={view.id} onReplaced={id => { reload(); go({ kind: "detail", moduleKey: "tax-rates", id }); }} /></div>}
              </div>
            )}
            {view.kind === "edit" && !viewOnly && (
              <BillingEditWorkspace isDark={isDark} moduleKey={view.moduleKey} recordId={view.id} onCancel={back}
                onSaved={id => { reload(); go({ kind: "detail", moduleKey: view.moduleKey, id }, { replace: true }); }}
                onOpenRecord={(key, id) => go({ kind: "detail", moduleKey: key, id })} onEditRecord={(key, id) => go({ kind: "edit", moduleKey: key, id })}
                onCreateChild={(key, refs) => go({ kind: "create", moduleKey: key, nonce: Date.now(), prefill: refs })} />
            )}
            {view.kind === "create" && !viewOnly && (
              <BillingCreateWorkspace isDark={isDark} moduleKey={view.moduleKey} initialReferences={view.prefill} initialFields={view.fields}
                initialNotice={view.notice ? <PrefillNotice isDark={isDark} notice={view.notice} /> : undefined}
                onCancel={() => go({ kind: "module", moduleKey: view.moduleKey })} onOpenRecord={(key, id) => go({ kind: "detail", moduleKey: key, id })}
                onOpenHistory={() => go({ kind: "history", moduleKey: view.moduleKey })} onSwitchModule={key => go({ kind: "create", moduleKey: key, nonce: Date.now() })} onCreated={res => { reload(); if (view.moduleKey === RATE_LIBRARY_MODULE && view.notice && res?.root.id && view.prefill?.GeoCountryId) void verifyLibraryRate(res.root.id, view.prefill); }} />
            )}
            {(view.kind === "create" || view.kind === "edit") && viewOnly && pad(<ErrorPanel isDark={isDark} error={{ title: `${def?.label} are view-only here`, message: def?.viewOnly ?? "" }} />)}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
