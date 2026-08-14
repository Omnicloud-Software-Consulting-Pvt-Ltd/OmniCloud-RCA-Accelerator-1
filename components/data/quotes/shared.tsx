"use client";

import { useState, type ReactNode, type CSSProperties } from "react";

/**
 * Layout note: every scrollable region in this module follows ONE pattern —
 * an outer `flex flex-col h-full overflow-hidden` boundary with exactly one
 * inner `flex-1 min-h-0 overflow-y-auto` scroll region (see PageShell below).
 * Flex children default to `min-height: auto`, which lets content silently
 * overflow past a `flex: 1` container's intended bounds instead of
 * scrolling — `min-h-0` is what makes the inner region actually clip/scroll
 * instead of growing forever and pushing footer/later steps off-screen.
 * Never add a second `overflow` boundary between the outer shell and the
 * inner scroll region, and never give an inner element `height: "100%"`
 * without also giving it `min-h-0` — both re-open the same bug.
 */

/* ── Shared icon set for the Quote module (mirrors the pattern used by
   BundleOrchestrationWorkspace / RCAAttributeStudio / RCProductWorkspace —
   one copy here since every quote component is new and shares this module). ── */
export function Ic({ n, s = 16 }: { n: string; s?: number }) {
  const p = {
    width: s, height: s, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.8,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  switch (n) {
    case "file-text":   return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>;
    case "sparkles":     return <svg {...p}><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M5 17l.75 2.25L8 20l-2.25.75L5 23l-.75-2.25L2 20l2.25-.75L5 17z"/><path d="M19 3l.75 2.25L22 6l-2.25.75L19 9l-.75-2.25L16 6l2.25-.75L19 3z"/></svg>;
    case "check-circle": return <svg {...p}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
    case "check":        return <svg {...p}><polyline points="20 6 9 17 4 12"/></svg>;
    case "alert":        return <svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
    case "clock":        return <svg {...p}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
    case "chevron-down": return <svg {...p}><polyline points="6 9 12 15 18 9"/></svg>;
    case "chevron-right":return <svg {...p}><polyline points="9 18 15 12 9 6"/></svg>;
    case "chevron-left": return <svg {...p}><polyline points="15 18 9 12 15 6"/></svg>;
    case "arrow-left":   return <svg {...p}><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>;
    case "arrow-right":  return <svg {...p}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>;
    case "plus":         return <svg {...p}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
    case "search":       return <svg {...p}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
    case "zap":          return <svg {...p}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
    case "x":            return <svg {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
    case "terminal":     return <svg {...p}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>;
    case "edit":         return <svg {...p}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
    case "layers":       return <svg {...p}><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>;
    case "trash":        return <svg {...p}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>;
    case "cube":         return <svg {...p}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>;
    case "dollar-sign":  return <svg {...p}><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>;
    case "list":         return <svg {...p}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>;
    case "upload":       return <svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>;
    case "activity":     return <svg {...p}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
    case "eye":          return <svg {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
    case "refresh":      return <svg {...p}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>;
    case "copy":         return <svg {...p}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
    case "maximize":     return <svg {...p}><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>;
    case "minimize":     return <svg {...p}><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>;
    case "save":         return <svg {...p}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>;
    case "info":         return <svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>;
    case "package":      return <svg {...p}><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>;
    case "user":         return <svg {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>;
    case "briefcase":    return <svg {...p}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>;
    case "calendar":     return <svg {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
    case "shopping-cart":return <svg {...p}><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>;
    case "table":        return <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>;
    case "image":        return <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>;
    case "building":     return <svg {...p}><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18M3 9h6M3 15h6M15 9h6M15 15h6"/></svg>;
    case "sliders":      return <svg {...p}><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>;
    case "lock":         return <svg {...p}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>;
    case "download":     return <svg {...p}><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>;
    case "send":         return <svg {...p}><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>;
    case "star":         return <svg {...p}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>;
    case "external-link":return <svg {...p}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>;
    case "link":         return <svg {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>;
    case "book-open":    return <svg {...p}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>;
    case "circle-dot":   return <svg {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>;
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
    accentNavy:  "#0070D6",
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

export function PrimaryButton({ label, icon, onClick, disabled, isDark, style }: {
  label: string; icon?: string; onClick?: () => void; disabled?: boolean; isDark: boolean; style?: CSSProperties;
}) {
  const t = tokens(isDark);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
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

export function Field({ label, isDark, children, hint }: { label: string; isDark: boolean; children: ReactNode; hint?: string }) {
  const t = tokens(isDark);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: t.dim, letterSpacing: 0.3, textTransform: "uppercase" }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: t.dim }}>{hint}</span>}
    </label>
  );
}

export function inputStyle(t: Tokens): CSSProperties {
  return {
    width: "100%", padding: "9px 12px", borderRadius: 9, fontSize: 13,
    background: t.inputBg, border: `1px solid ${t.inputBorder}`, color: t.heading, outline: "none",
  };
}

export function formatCurrency(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

/* ── Layout shell: the ONE scroll pattern every view in this module uses. ── */
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

function miniButtonStyle(t: Tokens, active?: boolean): CSSProperties {
  return {
    padding: "4px 10px", borderRadius: 7, border: `1px solid ${active ? t.accent + "60" : t.border}`,
    background: active ? `${t.accent}18` : "transparent", color: active ? t.accent : t.dim,
    fontSize: 11, fontWeight: 600, cursor: "pointer",
  };
}

export function Tabs({ isDark, tabs, active, onChange }: {
  isDark: boolean; tabs: { id: string; label: string; icon: string; badge?: number }[]; active: string; onChange: (id: string) => void;
}) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {tabs.map(tb => (
        <button
          key={tb.id}
          onClick={() => onChange(tb.id)}
          style={{
            display: "flex", alignItems: "center", gap: 6, padding: "7px 13px", borderRadius: 9, border: "none", cursor: "pointer",
            fontSize: 12.5, fontWeight: 600,
            background: active === tb.id ? `linear-gradient(135deg, ${t.accent}26, ${t.accentBlue}1a)` : "transparent",
            color: active === tb.id ? t.accent : t.dim,
          }}
        >
          <Ic n={tb.icon} s={13} /> {tb.label}
          {!!tb.badge && (
            <span style={{ fontSize: 10, fontWeight: 700, padding: "0 5px", borderRadius: 999, background: active === tb.id ? t.accent : t.dim, color: "#04101F" }}>
              {tb.badge}
            </span>
          )}
        </button>
      ))}
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

async function copyText(text: string, onDone: (ok: boolean) => void) {
  try {
    await navigator.clipboard.writeText(text);
    onDone(true);
  } catch {
    onDone(false);
  }
}

/** Minimal JSON syntax highlighter (no external deps) — colors keys/strings/numbers/booleans/null distinctly. */
export function highlightJson(json: string, t: Tokens): ReactNode[] {
  const tokenRegex = /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = tokenRegex.exec(json)) !== null) {
    if (match.index > lastIndex) parts.push(json.slice(lastIndex, match.index));
    const token = match[0];
    let color = t.body;
    if (/^"/.test(token)) color = /:$/.test(token) ? t.accentCyan : "#7EE787";
    else if (/true|false/.test(token)) color = t.accentBlue;
    else if (/null/.test(token)) color = t.dim;
    else color = "#F0883E";
    parts.push(<span key={key++} style={{ color }}>{token}</span>);
    lastIndex = tokenRegex.lastIndex;
  }
  parts.push(json.slice(lastIndex));
  return parts;
}

/** JSON viewer with syntax highlighting, pretty/compact toggle, expand/collapse, and copy (§ Generated JSON tab). */
export function CodeBlock({ isDark, data, defaultExpanded = false, collapsedHeight = 220 }: {
  isDark: boolean; data: unknown; defaultExpanded?: boolean; collapsedHeight?: number;
}) {
  const t = tokens(isDark);
  const [pretty, setPretty] = useState(true);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);

  return (
    <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: t.surfaceAlt, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderBottom: `1px solid ${t.border}` }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setPretty(true)} style={miniButtonStyle(t, pretty)}>Pretty</button>
          <button onClick={() => setPretty(false)} style={miniButtonStyle(t, !pretty)}>Compact</button>
          <button onClick={() => setExpanded(v => !v)} style={miniButtonStyle(t)}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Ic n={expanded ? "minimize" : "maximize"} s={11} /> {expanded ? "Collapse" : "Expand"}</span>
          </button>
        </div>
        <button onClick={() => copyText(json, setCopied)} style={miniButtonStyle(t, copied)}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Ic n={copied ? "check" : "copy"} s={11} /> {copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre style={{
        margin: 0, padding: 12, fontSize: 11.5, lineHeight: 1.6, overflow: "auto",
        maxHeight: expanded ? 560 : collapsedHeight, color: t.body,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      }}>
        {highlightJson(json, t)}
      </pre>
    </div>
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

/** Rich error panel (§ Error handling): title, explanation, SF error, suggested fix, copy, expand, jump-to-log. */
export function ErrorPanel({ isDark, error, onViewLogs }: { isDark: boolean; error: ErrorPanelData; onViewLogs?: () => void }) {
  const t = tokens(isDark);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

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
        <div style={{ fontSize: 12, color: t.dim, display: "flex", gap: 6, alignItems: "flex-start" }}>
          <span style={{ flexShrink: 0, marginTop: 1 }}><Ic n="zap" s={12} /></span>
          <span><strong style={{ color: t.body }}>Suggested fix: </strong>{error.possibleCause}</span>
        </div>
      )}
      {(error.code || error.status != null) && (
        <div style={{ fontSize: 11, color: t.dim }}>
          {error.code && <span>Code: {error.code}</span>}
          {error.code && error.status != null && <span> · </span>}
          {error.status != null && <span>HTTP {error.status}</span>}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
        <button onClick={() => setExpanded(v => !v)} style={miniButtonStyle(t)}>{expanded ? "Hide Details" : "Expand Details"}</button>
        <button onClick={() => copyText(JSON.stringify(error, null, 2), setCopied)} style={miniButtonStyle(t, copied)}>{copied ? "Copied" : "Copy Error"}</button>
        {onViewLogs && <button onClick={onViewLogs} style={miniButtonStyle(t)}>View in Execution Log</button>}
      </div>
      {expanded && (
        <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: t.surfaceAlt, fontSize: 11, color: t.body, overflow: "auto", maxHeight: 240 }}>
          {JSON.stringify(error.raw ?? error, null, 2)}
        </pre>
      )}
    </div>
  );
}
