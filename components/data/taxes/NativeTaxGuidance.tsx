"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens } from "@/components/data/quotes/shared";
import AnchoredOverlay from "@/components/ui/AnchoredOverlay";
import { quoteApiGet } from "@/lib/quotes/client/apiClient";
import { useConnectionKey, withConnection } from "@/components/data/billing/tax/taxUi";
import {
  NATIVE_MESSAGE, NATIVE_NOTE, NATIVE_STEPS, NATIVE_TITLE, UNKNOWN_MESSAGE, UNKNOWN_PROVIDER, UNKNOWN_TITLE,
  configTipText, externalLabel, readDismissed, tipKeyAction, transactionTaxText, usesNativeTax, writeDismissed, type TaxProviderInfo,
} from "@/lib/taxes/provider";

/**
 * Native Salesforce Tax guidance — informational only (never blocks a workflow, never writes to Salesforce). Provider-aware: Native Tax
 * instructions appear only when the connected org has an active Revenue Standard Tax engine; an external engine gets a provider note
 * and an unverified provider gets a neutral notice. Copy lives in lib/taxes/provider.ts.
 */

/* ───────────────────────────── Provider for screens outside Taxes ───────────────────────────── */

const providerCache = new Map<string, Promise<TaxProviderInfo>>();
/** The connected org's tax provider (GET /api/taxes/provider), fetched once per connection; null while loading. Failure → unknown. */
export function useTaxProvider(): TaxProviderInfo | null {
  const conn = useConnectionKey();
  const [state, setState] = useState<{ key: string; info: TaxProviderInfo } | null>(null);
  useEffect(() => {
    if (conn === "server") return;
    let cancelled = false;
    let p = providerCache.get(conn);
    if (!p) {
      p = quoteApiGet<{ provider: TaxProviderInfo }>("Read tax provider", withConnection("/api/taxes/provider", conn)).then(r => r.provider ?? UNKNOWN_PROVIDER, () => { providerCache.delete(conn); return UNKNOWN_PROVIDER; });
      providerCache.set(conn, p);
    }
    p.then(info => { if (!cancelled) setState({ key: conn, info }); });
    return () => { cancelled = true; };
  }, [conn]);
  return state?.key === conn ? state.info : null;
}

/* ───────────────────────────── Info tip (popover) ───────────────────────────── */

const SR_ONLY: CSSProperties = { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 };

/**
 * A small ⓘ button whose text opens on hover, keyboard focus and tap/click (touch), and closes on Escape, blur or tapping elsewhere.
 * The text is always linked through aria-describedby (an inline, visually hidden copy), so screen readers announce it with the
 * button; what's seen is the shared foreground layer (components/ui/AnchoredOverlay), so no panel, scroll container or animated
 * (transformed) ancestor clips or misplaces it.
 */
export function TaxInfoTip({ isDark, label, children, defaultOpen = false }: { isDark: boolean; label: string; children: ReactNode; defaultOpen?: boolean }) {
  const t = tokens(isDark);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const WIDTH = 300;
  // Tapping elsewhere (pointerdown outside the button and the tip) closes it via AnchoredOverlay; Escape is handled on the button.
  const panel: CSSProperties = {
    width: `min(${WIDTH}px, calc(100vw - 32px))`,
    padding: "9px 11px", borderRadius: 10, border: `1px solid ${t.borderBright}`, background: isDark ? "rgba(6,14,36,0.98)" : "#fff",
    boxShadow: "0 8px 24px rgba(0,20,60,0.22)", fontSize: 12, lineHeight: 1.5, color: t.body, fontWeight: 400, textTransform: "none", letterSpacing: 0, whiteSpace: "normal",
  };
  return (
    <span style={{ position: "relative", display: "inline-flex", verticalAlign: "middle" }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button ref={btn} type="button" aria-label={label} aria-expanded={open} aria-describedby={id}
        onClick={() => setOpen(true)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onKeyDown={e => { if (tipKeyAction(e.key, open) === "close") { e.stopPropagation(); setOpen(false); } }}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0, borderRadius: 9, border: "none", background: "transparent", color: t.accent, cursor: "pointer" }}>
        <Ic n="info" s={13} />
      </button>
      <span id={id} role="tooltip" hidden={!open} style={SR_ONLY}>{children}</span>
      <AnchoredOverlay anchorRef={btn} open={open} onDismiss={() => setOpen(false)} closeOnEscape={false} matchWidth={false} minWidth={WIDTH}
        gap={6} margin={16} maxHeight={400} aria-hidden="true" style={panel}>
        {children}
      </AnchoredOverlay>
    </span>
  );
}

/* ───────────────────────────── Dashboard banner ───────────────────────────── */

export interface ReadinessHint { blocked: boolean; detail: string | null }

const safeStorage = () => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };
const subscribeStorage = (cb: () => void) => { window.addEventListener("storage", cb); return () => window.removeEventListener("storage", cb); };

/** The Tax Dashboard notice. `provider` null = still loading (renders nothing, so no provider is assumed). */
export function NativeTaxConfigurationNotice({ isDark, provider, connectionKey, readiness, onOpenReadiness, defaultDismissed, defaultExpanded = false }: {
  isDark: boolean; provider: TaxProviderInfo | null; connectionKey: string;
  /** From the existing Engine Readiness status — shown only when it reports a verified block; never hidden by dismissal. */
  readiness?: ReadinessHint; onOpenReadiness?: () => void;
  defaultDismissed?: boolean; defaultExpanded?: boolean;
}) {
  const t = tokens(isDark);
  const stepsId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  // This viewer's choice for this org: the latest click wins, else what's stored (false on the server / when storage is blocked).
  const [choice, setChoice] = useState<{ key: string; dismissed: boolean } | null>(null);
  const stored = useSyncExternalStore(subscribeStorage, () => readDismissed(safeStorage(), connectionKey), () => false);
  const dismissed = choice?.key === connectionKey ? choice.dismissed : defaultDismissed ?? stored;
  const setAndStore = (v: boolean) => { setChoice({ key: connectionKey, dismissed: v }); writeDismissed(safeStorage(), connectionKey, v); if (!v) setExpanded(true); };
  if (!provider) return null;

  const link = (label: string, onClick: () => void) => <button type="button" onClick={onClick} style={{ background: "transparent", border: "none", padding: 0, color: t.accent, fontWeight: 700, fontSize: "inherit", cursor: "pointer" }}>{label}</button>;
  const blocked = readiness?.blocked ? (
    <div role="status" style={{ fontSize: 12, color: t.body }}>
      <b style={{ color: t.warn }}>Engine Readiness reports a problem:</b> {readiness.detail ?? "tax calculation is blocked."} {onOpenReadiness && link("Open Engine Readiness", onOpenReadiness)}
    </div>
  ) : null;
  const box = (tone: string, body: ReactNode, label: string) => (
    <section aria-label={label} style={{ borderRadius: 12, padding: "11px 14px", border: `1px solid rgba(${tone},0.35)`, background: `rgba(${tone},0.07)`, display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5, color: t.body }}>{body}</section>
  );
  const INFO = "0,212,255", NEUTRAL = "136,153,170";

  if (provider.kind === "external") return box(NEUTRAL, (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: t.dim, marginTop: 1 }}><Ic n="info" s={14} /></span>
      <div><b style={{ color: t.heading }}>Tax provider: external</b> — this org calculates tax through {externalLabel(provider)}. Tax rates for that engine are maintained by the provider; the Native Salesforce Tax setup steps don&apos;t apply.</div>
    </div>
  ), "Tax provider");

  if (provider.kind === "unknown") return box(NEUTRAL, (<>
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: t.dim, marginTop: 1 }}><Ic n="info" s={14} /></span>
      <div><b style={{ color: t.heading }}>{UNKNOWN_TITLE}</b><div>{UNKNOWN_MESSAGE} {onOpenReadiness && link("Open Engine Readiness", onOpenReadiness)}</div></div>
    </div>
    {blocked}
  </>), "Tax provider");

  if (dismissed) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: t.dim }}>
        <span>Tax provider: <b style={{ color: t.body }}>Native Salesforce Tax</b></span>
        <button type="button" onClick={() => setAndStore(false)} aria-label="Show tax configuration help" style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "transparent", border: "none", padding: "2px 4px", color: t.accent, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
          <Ic n="info" s={13} /> Tax configuration help
        </button>
      </div>
      {blocked}
    </div>
  );

  return box(INFO, (<>
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: t.accent, marginTop: 1 }}><Ic n="info" s={15} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <b style={{ color: t.heading, fontSize: 13 }}>{NATIVE_TITLE}</b>
          <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: t.accent, border: `1px solid ${t.borderBright}`, borderRadius: 6, padding: "1px 6px" }}>Provider: Native Salesforce Tax</span>
        </div>
        <div style={{ marginTop: 3 }}>{NATIVE_MESSAGE}</div>
        {provider.kind === "mixed" && <div style={{ marginTop: 3, color: t.dim }}>Treatments on {externalLabel(provider)} calculate through an external provider; these steps apply only to the native engine{provider.nativeEngines.length === 1 ? "" : "s"} ({provider.nativeEngines.join(", ")}).</div>}
      </div>
      <button type="button" onClick={() => setAndStore(true)} aria-label="Dismiss tax configuration notice" style={{ background: "transparent", border: "none", padding: 2, color: t.dim, cursor: "pointer", flexShrink: 0 }}><Ic n="x" s={14} /></button>
    </div>
    <div style={{ paddingLeft: 23 }}>
      <button type="button" aria-expanded={expanded} aria-controls={stepsId} onClick={() => setExpanded(e => !e)} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "transparent", border: "none", padding: 0, color: t.accent, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
        <Ic n={expanded ? "chevron-down" : "chevron-right"} s={12} /> Learn how to configure tax
      </button>
      <div id={stepsId} hidden={!expanded} style={{ marginTop: 6 }}>
        <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 3 }}>{NATIVE_STEPS.map(s => <li key={s}>{s}</li>)}</ol>
        <div style={{ marginTop: 6, color: t.dim }}>{NATIVE_NOTE}</div>
      </div>
    </div>
    {blocked}
  </>), "Native Salesforce Tax");
}

/* ───────────────────────────── Compact variants ───────────────────────────── */

/** Next to a tax configuration screen's title (Tax Rate / Treatment / Item / Policy / Engine). Nothing for other modules or while loading. */
export function TaxConfigHelp({ isDark, moduleKey, provider }: { isDark: boolean; moduleKey: string; provider: TaxProviderInfo | null }) {
  const text = provider ? configTipText(moduleKey, provider) : null;
  if (!text || !provider) return null;
  return <TaxInfoTip isDark={isDark} label={usesNativeTax(provider) ? "How this tax configuration is used" : "Tax provider information"}>{text}</TaxInfoTip>;
}

/** Next to a tax amount / tax status on Quote, Order, Billing Schedule and Invoice screens; reads the provider itself unless given one. */
export function TransactionTaxHelp({ isDark, provider }: { isDark: boolean; provider?: TaxProviderInfo | null }) {
  if (provider === undefined) return <LiveTransactionTaxHelp isDark={isDark} />;
  return <TaxInfoTip isDark={isDark} label="How tax is calculated">{transactionTaxText(provider ?? UNKNOWN_PROVIDER)}</TaxInfoTip>;
}
function LiveTransactionTaxHelp({ isDark }: { isDark: boolean }) {
  return <TransactionTaxHelp isDark={isDark} provider={useTaxProvider()} />;
}
