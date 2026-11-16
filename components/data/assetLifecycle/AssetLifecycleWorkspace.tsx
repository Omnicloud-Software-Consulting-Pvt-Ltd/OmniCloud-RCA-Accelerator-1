"use client";

import { useState } from "react";
import { ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { LoadingRow, useBillingData } from "@/components/data/billing/billingUi";
import type { ReferenceLookupValue } from "@/components/data/shared/ReferenceLookup";
import type { AssetRow, AssetState, LifecycleKind, LifecycleTransaction } from "@/lib/assetLifecycle/types";
import AssetExplorer from "./AssetExplorer";
import AssetDetail from "./AssetDetail";
import LifecyclePromptBox, { PromptResultPanel, type LifecycleAiResult } from "./LifecyclePromptBox";
import LifecycleWizard from "./LifecycleWizard";
import TransactionDetail from "./TransactionDetail";
import { AssetsDashboard, LifecycleDashboard, TransactionLists, type LifecycleListResponse } from "./LifecycleDashboard";
import { SECTIONS, SECTION_META, isSection, type Section } from "./lifecycleUi";

type View =
  | { mode: "dashboard" }
  | { mode: "list"; state?: AssetState | "all" }
  | { mode: "create"; nonce?: number; prefill?: { account: ReferenceLookupValue | null; assets: AssetRow[]; ai?: LifecycleAiResult | null } }
  | { mode: "edit"; transaction: LifecycleTransaction }
  | { mode: "transaction"; id: string; autoExecute?: boolean }
  | { mode: "asset"; id: string; from: Section };

export const LIFECYCLE_VIEWS = SECTIONS;
export const isLifecycleView = isSection;

/**
 * Asset Lifecycle workspace — Assets, Amendments, Renewals and Cancellations as ONE module: the same asset discovery component, the
 * same wizard and the same Salesforce step runner for every lifecycle, and asset detail ↔ transaction links across all four.
 * Mounted from the sidebar (app/data/page.tsx) at the chosen section. The sidebar is the only section navigation (no tab row or header):
 * each sidebar click remounts the workspace on that section's dashboard, whose tiles open Create / History / Browse. When the workspace
 * itself moves to another section (an asset's "Amend", a prompt opened as another lifecycle …) it reports it so the sidebar highlight follows.
 */
export default function AssetLifecycleWorkspace({ isDark, initialSection = "assets", onSectionChange }: { isDark: boolean; initialSection?: string; onSectionChange?: (section: Section) => void }) {
  const [section, setSection] = useState<Section>(isSection(initialSection) ? initialSection : "assets");
  const [view, setView] = useState<View>({ mode: "dashboard" });
  const meta = SECTION_META[section];
  const kind = section === "assets" ? null : section;

  // A new "create" view always remounts the wizard (counter bumped from the previous view — no impure calls in render scope).
  const fresh = (v: View) => (prev: View): View => (v.mode === "create" ? { ...v, nonce: (prev.mode === "create" ? prev.nonce ?? 0 : 0) + 1 } : v);
  const go = (s: Section, v: View = { mode: "dashboard" }) => { setSection(s); setView(fresh(v)); if (s !== section) onSectionChange?.(s); };
  const launch = (workflow: string) => {
    if (workflow === "create") setView(fresh({ mode: "create" }));
    else if (workflow === "history") setView({ mode: "list" });
    else if (workflow === "assets") go("assets", { mode: "list" });
    else if (workflow === "assets-expiring") go("assets", { mode: "list", state: "expiring" });
    else if (workflow === "amend" || workflow === "renew" || workflow === "cancel") go(workflow, { mode: "create" });
  };
  const startFromAsset = (k: LifecycleKind, a: AssetRow) => go(k, { mode: "create", prefill: { account: a.accountId ? { id: a.accountId, name: a.accountName ?? a.accountId } : null, assets: [a] } });

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="asset-lifecycle-workspace">
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {view.mode === "dashboard" && (kind
          ? <LifecycleDashboard key={kind} isDark={isDark} kind={kind} onLaunch={launch} onOpen={id => setView({ mode: "transaction", id })} />
          : <AssetsDashboard isDark={isDark} onLaunch={launch} />)}
        {view.mode !== "dashboard" && (
          <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 20 }}>
            {view.mode === "list" && <div style={{ marginBottom: 12 }}><GhostButton label={`${meta.label} dashboard`} icon="arrow-left" isDark={isDark} onClick={() => setView({ mode: "dashboard" })} /></div>}
            {view.mode === "list" && !kind && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <AssetsPrompt isDark={isDark} onOpen={(k, r) => go(k, { mode: "create", prefill: { account: r.prefill.account, assets: r.prefill.assets, ai: { ...r, kindMismatch: false } } })} />
                <AssetExplorer key={view.state ?? "all"} isDark={isDark} initialState={view.state ?? "all"} onOpen={id => setView({ mode: "asset", id, from: "assets" })} />
              </div>
            )}
            {view.mode === "list" && kind && <History isDark={isDark} kind={kind} onOpen={id => setView({ mode: "transaction", id })} />}
            {view.mode === "create" && kind && (
              <LifecycleWizard key={`${kind}-${view.nonce ?? 0}-${view.prefill?.assets.map(a => a.id).join(",") ?? "new"}`} isDark={isDark} kind={kind} prefill={view.prefill ?? null}
                onSaved={(id, o) => setView({ mode: "transaction", id, autoExecute: !!o?.execute })} onCancel={() => setView({ mode: "dashboard" })}
                onSwitchKind={(k, account, assets, ai) => go(k, { mode: "create", prefill: { account, assets, ai } })} />
            )}
            {view.mode === "edit" && <EditLoader isDark={isDark} transaction={view.transaction} onSaved={id => setView({ mode: "transaction", id })} onCancel={() => setView({ mode: "transaction", id: view.transaction.id })} />}
            {view.mode === "transaction" && <TransactionDetail key={view.id} isDark={isDark} transactionId={view.id} autoExecute={view.autoExecute} onBack={() => setView({ mode: "dashboard" })} onEdit={tx => setView({ mode: "edit", transaction: tx })} onOpenAsset={id => setView({ mode: "asset", id, from: section })} />}
            {view.mode === "asset" && <AssetDetail key={view.id} isDark={isDark} assetId={view.id} onBack={() => go(view.from, view.from === "assets" ? { mode: "list" } : { mode: "dashboard" })} onStart={startFromAsset} onOpenAsset={id => setView({ mode: "asset", id, from: view.from })} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** Assets section: one prompt for any lifecycle — the detected lifecycle's wizard opens prefilled (nothing is sent). */
function AssetsPrompt({ isDark, onOpen }: { isDark: boolean; onOpen: (k: LifecycleKind, r: LifecycleAiResult) => void }) {
  const [r, setR] = useState<LifecycleAiResult | null>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <LifecyclePromptBox isDark={isDark} kind={null} compact onResult={res => { if (res.kind && !res.issues.some(i => i.field === "Type" && i.status === "missing")) onOpen(res.kind, res); else setR(res); }} />
      {r && <PromptResultPanel isDark={isDark} result={r} onDismiss={() => setR(null)} />}
    </div>
  );
}

function History({ isDark, kind, onOpen }: { isDark: boolean; kind: LifecycleKind; onOpen: (id: string) => void }) {
  const { data, error, loading } = useBillingData<LifecycleListResponse>(`Load ${SECTION_META[kind].label.toLowerCase()}`, `/api/asset-lifecycle?kind=${kind}`);
  if (error) return <ErrorPanel isDark={isDark} error={error} />;
  if (loading || !data) return <LoadingRow isDark={isDark} label={`Loading ${SECTION_META[kind].label.toLowerCase()}…`} />;
  return <TransactionLists isDark={isDark} kind={kind} data={data} onOpen={onOpen} />;
}

/** Edit a saved transaction: re-reads its assets from Salesforce, then opens the wizard (line changes only once the quote exists). */
function EditLoader({ isDark, transaction, onSaved, onCancel }: { isDark: boolean; transaction: LifecycleTransaction; onSaved: (id: string) => void; onCancel: () => void }) {
  const ids = transaction.assets.map(a => a.id).join(",");
  const { data, error, loading } = useBillingData<{ rows: AssetRow[] }>("Load assets", `/api/assets?ids=${ids}&lifecycleOnly=0&pageSize=100`);
  if (error) return <ErrorPanel isDark={isDark} error={error} />;
  if (loading || !data) return <LoadingRow isDark={isDark} label="Re-reading the assets from Salesforce…" />;
  return <LifecycleWizard isDark={isDark} kind={transaction.kind} editing={{ transaction, assets: data.rows }} onSaved={onSaved} onCancel={onCancel} />;
}
