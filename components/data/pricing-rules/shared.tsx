"use client";

import { useState, type ReactNode, type CSSProperties } from "react";

/**
 * Self-contained UI kit for the Pricing Rules module — mirrors
 * components/data/quotes/shared.tsx's pattern (each domain module keeps
 * its own icon set/tokens/primitives rather than sharing one).
 */
export function Ic({ n, s = 16 }: { n: string; s?: number }) {
  const p = {
    width: s, height: s, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.8,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  switch (n) {
    case "zap":          return <svg {...p}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
    case "plus":         return <svg {...p}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
    case "check":        return <svg {...p}><polyline points="20 6 9 17 4 12"/></svg>;
    case "check-circle": return <svg {...p}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
    case "alert":        return <svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
    case "chevron-down": return <svg {...p}><polyline points="6 9 12 15 18 9"/></svg>;
    case "chevron-right":return <svg {...p}><polyline points="9 18 15 12 9 6"/></svg>;
    case "arrow-left":   return <svg {...p}><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>;
    case "arrow-right":  return <svg {...p}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>;
    case "sparkles":     return <svg {...p}><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/></svg>;
    case "list":         return <svg {...p}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>;
    case "table":        return <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>;
    case "sliders":      return <svg {...p}><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>;
    case "layers":       return <svg {...p}><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>;
    case "package":      return <svg {...p}><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>;
    case "refresh":      return <svg {...p}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>;
    case "info":         return <svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>;
    case "x":            return <svg {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
    case "activity":     return <svg {...p}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
    case "cube":         return <svg {...p}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>;
    case "clock":        return <svg {...p}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
    default:             return <svg {...p}><circle cx="12" cy="12" r="4"/></svg>;
  }
}

export function tokens(isDark: boolean) {
  return {
    bg:          isDark ? "rgba(2,6,20,0.97)"       : "rgba(240,246,255,0.99)",
    surface:     isDark ? "rgba(6,12,32,0.95)"      : "rgba(255,255,255,0.97)",
    surfaceAlt:  isDark ? "rgba(8,16,40,0.9)"       : "rgba(245,250,255,0.98)",
    border:      isDark ? "rgba(0,112,214,0.22)"    : "rgba(0,71,171,0.15)",
    borderBright:isDark ? "rgba(0,212,255,0.30)"    : "rgba(0,112,214,0.25)",
    heading:     isDark ? "rgba(220,235,255,0.97)"  : "rgba(0,15,60,0.92)",
    body:        isDark ? "rgba(170,200,235,0.88)"  : "rgba(0,25,80,0.82)",
    dim:         isDark ? "rgba(90,130,170,0.65)"   : "rgba(0,50,130,0.52)",
    accent:      "#00D4FF",
    accentBlue:  "#1E90FF",
    accentCyan:  "#3AABFF",
    inputBg:     isDark ? "rgba(0,15,40,0.7)"       : "rgba(255,255,255,0.95)",
    inputBorder: isDark ? "rgba(0,112,214,0.25)"    : "rgba(0,71,171,0.18)",
    error:       "#FF4066",
    warn:        "#F59E0B",
  };
}
export type Tokens = ReturnType<typeof tokens>;

export function Section({ title, icon, isDark, defaultOpen = true, children, right }: {
  title: string; icon: string; isDark: boolean; defaultOpen?: boolean; children: ReactNode; right?: ReactNode;
}) {
  const t = tokens(isDark);
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, overflow: "hidden" }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "transparent", border: "none", cursor: "pointer", color: t.heading }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
          <span style={{ color: t.accent }}><Ic n={icon} s={15} /></span>
          {title}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {right}
          <span style={{ color: t.dim }}><Ic n={open ? "chevron-down" : "chevron-right"} s={14} /></span>
        </span>
      </button>
      {open && <div style={{ padding: "0 16px 14px" }}>{children}</div>}
    </div>
  );
}

export function Pill({ label, color, isDark }: { label: string; color: string; isDark: boolean }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600,
      padding: "2px 8px", borderRadius: 999, color, background: isDark ? `${color}1c` : `${color}14`, border: `1px solid ${color}40`,
    }}>
      {label}
    </span>
  );
}

export function PrimaryButton({ label, icon, onClick, disabled, isDark, style, title }: {
  label: string; icon?: string; onClick?: () => void; disabled?: boolean; isDark: boolean; style?: CSSProperties; title?: string;
}) {
  const t = tokens(isDark);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 16px", borderRadius: 10,
        border: "none", cursor: disabled ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600,
        color: "#04101F", background: disabled ? t.dim : `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})`,
        opacity: disabled ? 0.5 : 1, ...style,
      }}
    >
      {icon && <Ic n={icon} s={14} />} {label}
    </button>
  );
}

export function GhostButton({ label, icon, onClick, isDark, danger, disabled }: {
  label: string; icon?: string; onClick?: () => void; isDark: boolean; danger?: boolean; disabled?: boolean;
}) {
  const t = tokens(isDark);
  const color = danger ? t.error : t.body;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 10,
        border: `1px solid ${danger ? t.error + "50" : t.border}`, background: "transparent", cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 12.5, fontWeight: 600, color, opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon && <Ic n={icon} s={13} />} {label}
    </button>
  );
}

export function Field({ label, isDark, children, hint, required }: { label: string; isDark: boolean; children: ReactNode; hint?: string; required?: boolean }) {
  const t = tokens(isDark);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: t.dim, letterSpacing: 0.3, textTransform: "uppercase" }}>
        {label}{required && <span style={{ color: t.error }}> *</span>}
      </span>
      {children}
      {hint && <span style={{ fontSize: 11, color: t.dim }}>{hint}</span>}
    </label>
  );
}

export function inputStyle(t: Tokens, opts?: { readOnly?: boolean }): CSSProperties {
  return {
    width: "100%", padding: "9px 12px", borderRadius: 9, fontSize: 13,
    background: opts?.readOnly ? t.surfaceAlt : t.inputBg,
    border: `1px solid ${t.inputBorder}`, color: opts?.readOnly ? t.dim : t.heading, outline: "none",
  };
}

export function PageShell({ header, footer, children }: { header?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {header}
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      {footer}
    </div>
  );
}

export function FooterBar({ isDark, children }: { isDark: boolean; children: ReactNode }) {
  const t = tokens(isDark);
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap",
      padding: "12px 20px", borderTop: `1px solid ${t.border}`, background: t.surface, flexShrink: 0,
    }}>
      {children}
    </div>
  );
}

export function EmptyState({ isDark, icon, title, hint }: { isDark: boolean; icon: string; title: string; hint?: string }) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: "36px 20px", textAlign: "center" }}>
      <span style={{ color: t.dim, opacity: 0.6 }}><Ic n={icon} s={28} /></span>
      <div style={{ fontSize: 13, fontWeight: 600, color: t.body }}>{title}</div>
      {hint && <div style={{ fontSize: 11.5, color: t.dim, maxWidth: 340 }}>{hint}</div>}
    </div>
  );
}

export function Spinner({ isDark, size = 16 }: { isDark: boolean; size?: number }) {
  const t = tokens(isDark);
  return (
    <span
      className="animate-spin"
      style={{ display: "inline-block", width: size, height: size, borderRadius: "50%", border: `2px solid ${t.border}`, borderTopColor: t.accent }}
    />
  );
}

export interface ErrorPanelData {
  title: string;
  message: string;
  possibleCause?: string | null;
  code?: string | null;
  status?: number | null;
  raw?: unknown;
}

export function ErrorPanel({ isDark, error, onRetry }: { isDark: boolean; error: ErrorPanelData; onRetry?: () => void }) {
  const t = tokens(isDark);
  return (
    <div style={{
      borderRadius: 12, border: `1px solid ${t.error}55`,
      background: isDark ? "rgba(255,64,102,0.08)" : "rgba(255,64,102,0.06)",
      padding: 14, display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: t.error, fontWeight: 700, fontSize: 13.5 }}>
        <Ic n="alert" s={16} /> {error.title}
      </div>
      <div style={{ fontSize: 12.5, color: t.body }}>{error.message}</div>
      {error.possibleCause && (
        <div style={{ fontSize: 12, color: t.dim }}><strong style={{ color: t.body }}>Suggested fix: </strong>{error.possibleCause}</div>
      )}
      {onRetry && (
        <div style={{ marginTop: 4 }}>
          <GhostButton label="Retry" icon="refresh" isDark={isDark} onClick={onRetry} />
        </div>
      )}
    </div>
  );
}

export function formatCurrency(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
