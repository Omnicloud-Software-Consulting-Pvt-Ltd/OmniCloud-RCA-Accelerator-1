"use client";

import { useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Ic, hexToRgb } from "@/components/data/dashboardShell";
import { tokens, Spinner } from "@/components/data/quotes/shared";
import { quoteApiGet, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel, statusColor } from "@/lib/billing/client";
import type { BillingAnalysisStep, BillingValidationIssue, BillingValidationResult } from "@/lib/billing/types";
import { Z } from "@/lib/ui/overlay";

/**
 * GET-and-cache hook for billing views. `loading` is derived (request key vs.
 * last-settled key) instead of set synchronously inside the effect, and
 * `reload()` just bumps a nonce — the same async-only setState pattern the
 * rest of DataOmnion uses, so react-hooks/set-state-in-effect stays clean.
 */
export function useBillingData<T>(label: string, path: string | null) {
  const [nonce, setNonce] = useState(0);
  const requestKey = path ? `${path}#${nonce}` : null;
  const [state, setState] = useState<{ key: string | null; data: T | null; error: ErrorPanelDataLike | null }>({ key: null, data: null, error: null });

  useEffect(() => {
    if (!path || !requestKey) return;
    let cancelled = false;
    quoteApiGet<T>(label, path)
      .then(data => { if (!cancelled) setState({ key: requestKey, data, error: null }); })
      .catch(err => { if (!cancelled) setState(s => ({ key: requestKey, data: s.data, error: toBillingErrorPanel(err, label) })); });
    return () => { cancelled = true; };
    // requestKey encodes path + nonce; label is display-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  return {
    data: state.data,
    error: state.key === requestKey ? state.error : null,
    loading: !!requestKey && state.key !== requestKey,
    reload: () => setNonce(n => n + 1),
  };
}

export function StatusPill({ status, isDark }: { status: string | null | undefined; isDark: boolean }) {
  if (!status) return null;
  const c = statusColor(status);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, color: c, background: isDark ? `${c}1c` : `${c}1a`, border: `1px solid ${c}45`, whiteSpace: "nowrap" }}>
      <span style={{ width: 5, height: 5, borderRadius: 999, background: c }} /> {status}
    </span>
  );
}

export function Panel({ isDark, title, icon, right, children, padding = 16 }: { isDark: boolean; title?: string; icon?: string; right?: ReactNode; children: ReactNode; padding?: number }) {
  const t = tokens(isDark);
  return (
    <div style={{ borderRadius: 14, border: `1px solid ${t.border}`, background: t.surface, boxShadow: t.shadow, overflow: "hidden" }}>
      {title && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "11px 16px", borderBottom: `1px solid ${t.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, color: t.heading }}>
            {icon && <span style={{ color: t.accent, display: "inline-flex" }}><Ic n={icon} s={14} /></span>} {title}
          </div>
          {right}
        </div>
      )}
      <div style={{ padding }}>{children}</div>
    </div>
  );
}

export function LoadingRow({ isDark, label }: { isDark: boolean; label: string }) {
  const t = tokens(isDark);
  return <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim, padding: 8 }}><Spinner isDark={isDark} /> {label}</div>;
}

/** Small pill-shaped action button used in module toolbars — same visual language as ContractsModule's header buttons. */
export function ToolbarButton({ isDark, label, icon, onClick, primary, active, disabled, title }: {
  isDark: boolean; label: string; icon?: string; onClick?: () => void; primary?: boolean; active?: boolean; disabled?: boolean; title?: string;
}) {
  const t = tokens(isDark);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 13px", borderRadius: 9, cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 12.5, fontWeight: primary ? 700 : 600, opacity: disabled ? 0.5 : 1, whiteSpace: "nowrap",
        border: primary ? "none" : `1px solid ${active ? t.accent + "60" : t.border}`,
        color: primary ? "#04101F" : active ? t.accent : t.body,
        background: primary ? `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})` : active ? `${t.accent}18` : "transparent",
      }}
    >
      {icon && <Ic n={icon} s={13} />} {label}
    </button>
  );
}

export function Breadcrumbs({ isDark, items }: { isDark: boolean; items: { label: string; onClick?: () => void }[] }) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 11.5 }}>
      {items.map((it, i) => (
        <span key={`${it.label}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {i > 0 && <span style={{ color: t.dim, display: "inline-flex" }}><Ic n="chevron-right" s={11} /></span>}
          {it.onClick ? (
            <button onClick={it.onClick} style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: t.accent, fontWeight: 600, fontSize: 11.5 }}>{it.label}</button>
          ) : (
            <span style={{ color: t.heading, fontWeight: 700 }}>{it.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

const SEVERITY_ICON: Record<BillingValidationIssue["severity"], string> = { error: "alert", warning: "alert", info: "info" };

export function IssueList({ isDark, issues, pathLabel }: { isDark: boolean; issues: BillingValidationIssue[]; pathLabel?: (path: string) => string }) {
  const t = tokens(isDark);
  if (issues.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {issues.map((i, idx) => {
        const c = i.severity === "error" ? t.error : i.severity === "warning" ? t.warn : t.accent;
        return (
          <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: t.body, padding: "7px 10px", borderRadius: 9, border: `1px solid ${c}40`, background: `${c}0f` }}>
            <span style={{ color: c, flexShrink: 0, marginTop: 1, display: "inline-flex" }}><Ic n={SEVERITY_ICON[i.severity]} s={13} /></span>
            <span>
              {pathLabel && i.path && <strong style={{ color: t.heading }}>{pathLabel(i.path)}: </strong>}
              {i.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ValidationChecklist({ isDark, validation }: { isDark: boolean; validation: BillingValidationResult }) {
  const t = tokens(isDark);
  const color = (s: string) => (s === "failed" ? t.error : s === "warning" ? t.warn : s === "skipped" ? t.dim : "#00C875");
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 6 }}>
      {validation.checks.map(c => (
        <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, color: t.body, padding: "6px 9px", borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}` }}>
          <span style={{ color: color(c.status), display: "inline-flex" }}><Ic n={c.status === "passed" ? "check-circle" : c.status === "skipped" ? "info" : "alert"} s={13} /></span>
          <span style={{ flex: 1 }}>{c.label}</span>
          {c.detail && <span style={{ color: color(c.status), fontWeight: 700, fontSize: 10.5 }}>{c.detail}</span>}
        </div>
      ))}
    </div>
  );
}

/** The User Prompt → … → Generated Configuration chain, so it's visible exactly how the AI result was produced. */
export function PipelineSteps({ isDark, steps }: { isDark: boolean; steps: BillingAnalysisStep[] }) {
  const t = tokens(isDark);
  const color = (s: BillingAnalysisStep["status"]) => (s === "failed" ? t.error : s === "warning" ? t.warn : "#00C875");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {steps.map((s, i) => (
        <motion.div key={s.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.06 }} style={{ display: "flex", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ width: 22, height: 22, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", color: color(s.status), background: `${color(s.status)}1c`, border: `1px solid ${color(s.status)}55`, flexShrink: 0 }}>
              <Ic n={s.status === "done" ? "check" : "alert"} s={12} />
            </span>
            {i < steps.length - 1 && <span style={{ width: 1, flex: 1, minHeight: 10, background: t.border }} />}
          </div>
          <div style={{ paddingBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: t.heading }}>{s.label}</div>
            <div style={{ fontSize: 11.5, color: t.dim }}>{s.detail}</div>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

export function StatTile({ isDark, label, value, color }: { isDark: boolean; label: string; value: string; color?: string }) {
  const c = color ?? "#00D4FF";
  const rgb = hexToRgb(c);
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: "8px 12px", borderRadius: 9, minWidth: 70, background: isDark ? `rgba(${rgb},0.06)` : `rgba(${rgb},0.05)`, border: `1px solid rgba(${rgb},${isDark ? 0.14 : 0.18})` }}>
      <span style={{ fontSize: 17, fontWeight: 800, color: c, letterSpacing: "-0.03em", lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 10, marginTop: 4, color: isDark ? "rgba(120,150,190,0.75)" : "rgba(0,15,55,0.7)" }}>{label}</span>
    </div>
  );
}

/** Blocking dialog used by the billing workspaces (conflicts, confirmations). */
export function Modal({ isDark, title, tone, children, actions }: { isDark: boolean; title: string; tone: "warn" | "accent"; children: ReactNode; actions: ReactNode }) {
  const t = tokens(isDark);
  const c = tone === "warn" ? t.warn : t.accent;
  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, zIndex: Z.dialogNested, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,5,15,0.55)", backdropFilter: "blur(3px)" }}>
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} style={{ width: "min(560px, calc(100vw - 32px))", borderRadius: 16, border: `1px solid ${c}60`, background: t.surface, boxShadow: "0 20px 60px rgba(0,0,0,0.45)", padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 15, fontWeight: 800, color: t.heading, marginBottom: 12 }}>
          <span style={{ color: c, display: "inline-flex" }}><Ic n={tone === "warn" ? "alert" : "check-circle"} s={18} /></span>{title}
        </div>
        <div style={{ fontSize: 13, color: t.body, display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 18 }}>{actions}</div>
      </motion.div>
    </div>
  );
}

/** Label / value row. */
export function Row({ isDark, label, children }: { isDark: boolean; label: string; children: ReactNode }) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, 190px) 1fr", gap: 12, fontSize: 12.5, alignItems: "baseline" }}>
      <span style={{ color: t.dim, fontWeight: 600 }}>{label}</span><span style={{ color: t.heading, fontWeight: 700 }}>{children}</span>
    </div>
  );
}
