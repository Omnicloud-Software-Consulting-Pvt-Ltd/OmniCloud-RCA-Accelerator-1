"use client";

import React from "react";
import { motion } from "framer-motion";

/**
 * Shared Product Creation field primitives — extracted verbatim from
 * RCProductWorkspace.tsx (the Single Product workspace, the reference
 * implementation for Product Creation UI) so the Multiple Product
 * workspace can render the exact same look/behavior instead of a
 * differently-styled duplicate. RCProductWorkspace.tsx now imports these
 * from here too; nothing about their markup or styling changed during the
 * extraction, only where the code physically lives.
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * Constants
 * ─────────────────────────────────────────────────────────────────────────── */
export const SELLING_MODELS = [
  "One Time",
  "Evergreen - Monthly", "Evergreen - Quarterly", "Evergreen - Semi-Annual", "Evergreen - Yearly",
  "Term Based - Monthly", "Term Based - Quarterly", "Term Based - Semi-Annual", "Term Based - Yearly",
];

export const FAMILIES = ["Electronics", "Software", "Telecommunications", "Services", "Industrial", "Healthcare", "Financial", "Other"];

export const CATEGORY_MAP: Record<string, string[]> = {
  Electronics:        ["Mobile Phones", "Laptops", "Tablets", "Gaming", "Audio", "Displays", "Cameras", "Wearables", "Peripherals", "Smart Home"],
  Software:           ["CRM", "ERP", "Analytics", "Security", "Collaboration", "DevTools", "Enterprise Software", "Productivity"],
  Telecommunications: ["Mobile Plans", "Broadband", "Fiber", "5G", "IoT Connectivity"],
  Services:           ["Subscription Services", "Professional Services", "Managed Services", "Cloud Services", "Support Plans"],
  Industrial:         ["Manufacturing", "Equipment", "Industrial Software"],
  Healthcare:         ["Medical Devices", "Health Services", "Diagnostics"],
  Financial:          ["Insurance", "Banking Products", "Investment"],
  Other:              ["General Products"],
};

export const CATALOG_MAP: Record<string, string> = {
  Electronics: "Electronics Catalog", Software: "Software Catalog",
  Telecommunications: "Telecom Catalog", Services: "Services Catalog",
  Industrial: "Industrial Catalog", Healthcare: "Healthcare Catalog",
  Financial: "Financial Catalog", Other: "General Catalog",
};

export const UNIT_OF_MEASURES = ["Each", "Hour", "License", "Month", "Year", "GB", "TB", "User", "Seat"];

/* ─────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ─────────────────────────────────────────────────────────────────────────── */
export function autoCode(name: string) {
  return name.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "").slice(0, 40);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Icon system
 * ─────────────────────────────────────────────────────────────────────────── */
export function Ic({ n, s = 16 }: { n: string; s?: number }) {
  const I: Record<string, React.ReactNode> = {
    package:        <><line x1="16.5" y1="9.4" x2="7.55" y2="4.24"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></>,
    zap:            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>,
    wand:           <><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8L19 13"/><path d="M15 9h.01"/><path d="M17.8 6.2L19 5"/><path d="M3 21l9-9"/><path d="M12.2 6.2L11 5"/></>,
    sparkles:       <><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 3l.75 2.25L22 6l-2.25.75L19 9l-.75-2.25L16 6l2.25-.75z"/></>,
    rocket:         <><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/></>,
    "check-circle": <><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>,
    "x-circle":     <><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></>,
    alert:          <><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
    refresh:        <><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></>,
    x:              <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>,
    copy:           <><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></>,
    plus:           <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
    edit:           <><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></>,
    trash:          <><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></>,
    "arrow-left":   <><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></>,
    "arrow-right":  <><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></>,
    "chevron-down": <polyline points="6 9 12 15 18 9"/>,
    info:           <><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></>,
    "check-square": <><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></>,
    layers:         <><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></>,
    tag:            <><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></>,
    "bar-chart":    <><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></>,
    code:           <><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></>,
    eye:            <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>,
    "eye-off":      <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></>,
    user:           <><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></>,
    "book-open":    <><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></>,
    "dollar-sign":  <><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></>,
    clock:          <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>,
  };
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {I[n] ?? <circle cx="12" cy="12" r="5"/>}
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Field components
 * ─────────────────────────────────────────────────────────────────────────── */
export function FieldWrap({ label, children, span2 }: { label: string; children: React.ReactNode; span2?: boolean }) {
  return (
    <div style={{ gridColumn: span2 ? "1 / -1" : undefined }}>
      <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1.5"
        style={{ color: "rgba(90,120,160,0.7)" }}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function FInput({ value, onChange, placeholder, mono, large, readOnly, type }: {
  value: string; onChange?: (v: string) => void; placeholder?: string;
  mono?: boolean; large?: boolean; readOnly?: boolean; type?: string;
}) {
  return (
    <input
      value={value}
      type={type ?? "text"}
      readOnly={readOnly}
      onChange={e => onChange?.(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-lg outline-none ${large ? "text-[14px] px-3.5 py-2.5" : "text-[12px] px-3 py-2"}`}
      style={{
        background: "var(--rc-field-bg)",
        border: "1px solid var(--rc-field-border)",
        color: "var(--rc-text-primary)",
        fontFamily: mono ? "monospace" : "inherit",
        cursor: readOnly ? "default" : "text",
        transition: "border-color 180ms",
      }}
      onFocus={e => !readOnly && (e.target.style.borderColor = "#1E90FF")}
      onBlur={e => (e.target.style.borderColor = "var(--rc-field-border)")}
    />
  );
}

export function FSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full rounded-lg text-[12px] px-3 py-2 outline-none"
      style={{
        background: "var(--rc-field-bg)",
        border: "1px solid var(--rc-field-border)",
        color: "var(--rc-text-primary)",
        fontFamily: "inherit",
        cursor: "pointer",
      }}
    >
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

export function FTextarea({ value, onChange, placeholder, rows = 3 }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full rounded-lg text-[12px] px-3 py-2 outline-none resize-none"
      style={{
        background: "var(--rc-field-bg)",
        border: "1px solid var(--rc-field-border)",
        color: "var(--rc-text-primary)",
        fontFamily: "inherit",
        lineHeight: 1.55,
        transition: "border-color 180ms",
      }}
      onFocus={e => (e.target.style.borderColor = "#1E90FF")}
      onBlur={e => (e.target.style.borderColor = "var(--rc-field-border)")}
    />
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Section header
 * ─────────────────────────────────────────────────────────────────────────── */
export function SectionHeader({ icon, label, badge, action }: {
  icon: string; label: string; badge?: string | number;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <div className="w-5 h-5 flex items-center justify-center" style={{ color: "#1E90FF" }}>
          <Ic n={icon} s={14} />
        </div>
        <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: "var(--rc-text-section)" }}>
          {label}
        </span>
        {badge !== undefined && (
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: "rgba(30,144,255,0.1)", border: "1px solid rgba(30,144,255,0.2)", color: "#3AABFF" }}>
            {badge}
          </span>
        )}
      </div>
      {action && (
        <motion.button
          onClick={action.onClick}
          className="flex items-center gap-1.5 text-[10px] font-medium px-2.5 py-1.5 rounded-lg cursor-pointer"
          style={{ color: "#1E90FF", border: "1px solid rgba(30,144,255,0.2)", background: "transparent" }}
          whileHover={{ background: "rgba(30,144,255,0.07)" }}
          whileTap={{ scale: 0.95 }}
        >
          <Ic n="plus" s={11} />
          {action.label}
        </motion.button>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * RC Config Card
 * ─────────────────────────────────────────────────────────────────────────── */
export function RCConfigCard({ icon, label, value, color, sub }: {
  icon: string; label: string; value: string; color: string; sub?: string;
}) {
  return (
    <div className="px-4 py-3 rounded-xl"
      style={{ background: `${color}0A`, border: `1px solid ${color}22`, minWidth: 0 }}>
      <div className="flex items-center gap-2 mb-1.5">
        <div style={{ color }}><Ic n={icon} s={13} /></div>
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: `${color}90` }}>{label}</span>
      </div>
      <div className="text-[13px] font-bold truncate" style={{ color, letterSpacing: "-0.02em" }}>{value || "—"}</div>
      {sub && <div className="text-[10px] mt-0.5 truncate" style={{ color: `${color}70` }}>{sub}</div>}
    </div>
  );
}

/**
 * The RCProductWorkspace CSS-variable scheme, exported so the Multiple
 * Product workspace's per-product review cards use the exact same
 * field/text colors in light and dark mode instead of re-deriving them.
 */
export function rcCssVars(isDark: boolean): React.CSSProperties {
  return {
    "--rc-field-bg":     isDark ? "rgba(30,144,255,0.04)" : "rgba(0,71,171,0.08)",
    "--rc-field-border": isDark ? "rgba(30,144,255,0.12)" : "rgba(0,71,171,0.20)",
    "--rc-text-primary": isDark ? "rgba(180,210,240,0.9)" : "rgba(0,15,45,0.85)",
    "--rc-text-muted":   isDark ? "rgba(90,120,160,0.65)" : "rgba(0,31,91,0.66)",
    "--rc-text-section": isDark ? "rgba(30,144,255,0.6)" : "rgba(0,71,171,0.72)",
    "--rc-divider":      isDark ? "rgba(30,144,255,0.07)" : "rgba(0,71,171,0.12)",
    "--rc-card-bg":      isDark ? "rgba(6,12,28,0.6)" : "rgba(222,234,255,0.92)",
    "--rc-panel-bg":     isDark ? "rgba(2,7,18,0.7)" : "rgba(228,238,255,0.96)",
    "--rc-panel-border": isDark ? "rgba(30,144,255,0.1)" : "rgba(0,71,171,0.18)",
  } as React.CSSProperties;
}
