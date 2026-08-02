"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

/* ── SVG Icon helper ── */
function Ic({ n, s = 16 }: { n: string; s?: number }) {
  const p = {
    width: s, height: s, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.8,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  switch (n) {
    case "package":      return <svg {...p}><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>;
    case "sparkles":     return <svg {...p}><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M5 17l.75 2.25L8 20l-2.25.75L5 23l-.75-2.25L2 20l2.25-.75L5 17z"/><path d="M19 3l.75 2.25L22 6l-2.25.75L19 9l-.75-2.25L16 6l2.25-.75L19 3z"/></svg>;
    case "check-circle": return <svg {...p}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
    case "alert":        return <svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
    case "clock":        return <svg {...p}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
    case "chevron-down": return <svg {...p}><polyline points="6 9 12 15 18 9"/></svg>;
    case "chevron-right":return <svg {...p}><polyline points="9 18 15 12 9 6"/></svg>;
    case "plus":         return <svg {...p}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
    case "zap":          return <svg {...p}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
    case "refresh":      return <svg {...p}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>;
    case "git-branch":   return <svg {...p}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>;
    case "x":            return <svg {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
    case "terminal":     return <svg {...p}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>;
    case "edit":         return <svg {...p}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
    case "rocket":       return <svg {...p}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>;
    case "layers":       return <svg {...p}><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>;
    case "tag":          return <svg {...p}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>;
    case "trash":        return <svg {...p}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>;
    case "link":         return <svg {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>;
    case "cube":         return <svg {...p}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>;
    case "database":     return <svg {...p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>;
    case "settings":     return <svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
    case "shield":       return <svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case "activity":     return <svg {...p}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
    case "eye":          return <svg {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
    case "list":         return <svg {...p}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>;
    default:             return <svg {...p}><circle cx="12" cy="12" r="4"/></svg>;
  }
}

/* ══════════════════════════════════════════════════════════════
 * TYPES — Centralized orchestration state
 * ══════════════════════════════════════════════════════════════ */

interface ParsedProduct {
  name: string;
  price: number;
  isDependency: boolean;
  dependencyOf?: string | null;
  sellingModel?: string;
  category?: string;
  attributes?: AttributeDefinition[];
}

interface AttributeDefinition {
  name: string;
  type: "Picklist" | "Text" | "Number" | "Boolean";
  values?: string[];
  required?: boolean;
}

interface ParsedBundle {
  bundleName: string;
  description?: string;
  category?: string;
  catalog?: string;
  sellingModel?: string;
  bundleType?: string;
  products: ParsedProduct[];
  nestedBundles?: ParsedBundle[];
  dependencies?: { source: string; target: string; targetPrice: number; type?: string }[];
  attributes?: AttributeDefinition[];
  totalPrice: number;
}

type DependencyRuleType = "AUTO_ADD" | "DEPENDS_ON" | "REQUIRES" | "EXCLUDES";

interface DependencyRule {
  id: string;
  type: DependencyRuleType;
  source: string;
  target: string;
  active: boolean;
  validationStatus: "valid" | "warning" | "error" | "unchecked";
  validationMessage?: string;
}

interface LogEntry {
  id: string;
  timestamp: number;
  batch: number;
  level: "info" | "success" | "error" | "warning";
  message: string;
  sfId?: string;
}

interface BatchStatus {
  batch: number;
  name: string;
  status: "pending" | "running" | "success" | "error";
  count: number;
  duration?: number;
  error?: string;
}

interface CommercializationEntry {
  productName: string;
  catalog?: string;
  catalogAction?: "reused" | "reused_fallback" | "created";
  category?: string;
  categoryAction?: "reused" | "created";
  sellingModel?: string;
  sellingModelAction?: "reused" | "created";
}

/* Centralized orchestration store */
interface BundleOrchestrationState {
  parsedBundle: ParsedBundle | null;
  depRules: DependencyRule[];
  executing: boolean;
  batches: BatchStatus[];
  logs: LogEntry[];
  completedBundleId: string | null;
  commMap: Record<string, CommercializationEntry>;
}

/* ══════════════════════════════════════════════════════════════
 * CONSTANTS
 * ══════════════════════════════════════════════════════════════ */

const INITIAL_BATCHES: BatchStatus[] = [
  { batch: 1, name: "Create Products",        status: "pending", count: 0 },
  { batch: 2, name: "Create Bundles",         status: "pending", count: 0 },
  { batch: 3, name: "Create Relationships",   status: "pending", count: 0 },
  { batch: 4, name: "Create Dependencies",    status: "pending", count: 0 },
  { batch: 5, name: "Create Attributes",      status: "pending", count: 0 },
  { batch: 6, name: "Commercialization",      status: "pending", count: 0 },
  { batch: 7, name: "Selling Models",         status: "pending", count: 0 },
  { batch: 8, name: "Pricebook Entries",      status: "pending", count: 0 },
  { batch: 9, name: "Validation + Deploy",    status: "pending", count: 0 },
];

const DEP_TYPE_CFG: Record<DependencyRuleType, { color: string; label: string; icon: string; desc: string }> = {
  AUTO_ADD:   { color: "#00D4FF", label: "AUTO ADD",   icon: "plus",      desc: "Auto-creates required product" },
  DEPENDS_ON: { color: "#1E90FF", label: "DEPENDS ON", icon: "link",      desc: "Soft dependency" },
  REQUIRES:   { color: "#3AABFF", label: "REQUIRES",   icon: "zap",       desc: "Hard requirement" },
  EXCLUDES:   { color: "#FF4066", label: "EXCLUDES",   icon: "x",         desc: "Cannot coexist" },
};

/* ══════════════════════════════════════════════════════════════
 * DESIGN TOKENS — Blue-only system
 * ══════════════════════════════════════════════════════════════ */

function tokens(isDark: boolean) {
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

/* ══════════════════════════════════════════════════════════════
 * STATUS HELPERS
 * ══════════════════════════════════════════════════════════════ */

function batchColor(s: BatchStatus["status"]) {
  return s === "success" ? "#00D4FF" : s === "error" ? "#FF4066" : s === "running" ? "#1E90FF" : "rgba(90,130,170,0.3)";
}
function logColor(level: string) {
  return level === "success" ? "#00D4FF" : level === "error" ? "#FF4066" : level === "warning" ? "#F59E0B" : "#3AABFF";
}

/* ══════════════════════════════════════════════════════════════
 * DEPENDENCY ENGINE UTILITIES
 * ══════════════════════════════════════════════════════════════ */

function detectCircular(rules: DependencyRule[], source: string, newTarget: string): boolean {
  const deps = rules.filter(r => r.active && r.type !== "EXCLUDES");
  const visited = new Set<string>();
  const stack = [newTarget];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    deps.filter(r => r.source === cur).forEach(r => stack.push(r.target));
  }
  return false;
}

function validateRules(rules: DependencyRule[]): DependencyRule[] {
  return rules.map(rule => {
    if (!rule.active) return { ...rule, validationStatus: "unchecked" as const, validationMessage: undefined };
    if (rule.type !== "EXCLUDES") {
      const others = rules.filter(r => r.id !== rule.id);
      if (detectCircular(others, rule.source, rule.target))
        return { ...rule, validationStatus: "error" as const, validationMessage: "Circular dependency detected" };
    }
    if (rule.type === "EXCLUDES") {
      const conflict = rules.find(r =>
        r.id !== rule.id && r.active && (r.type === "REQUIRES" || r.type === "DEPENDS_ON") &&
        r.source === rule.target && r.target === rule.source,
      );
      if (conflict) return { ...rule, validationStatus: "error" as const, validationMessage: `Conflicts with ${conflict.type}` };
    }
    return { ...rule, validationStatus: "valid" as const, validationMessage: undefined };
  });
}

function parseNL(text: string): { type: DependencyRuleType; source: string; target: string } | null {
  const t = text.trim();
  const cap = (s: string) => s.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const patterns: [RegExp, DependencyRuleType][] = [
    [/^(.+?)\s+auto.?adds?\s+(.+)$/i,        "AUTO_ADD"],
    [/^(.+?)\s+automatically adds?\s+(.+)$/i, "AUTO_ADD"],
    [/^(.+?)\s+depends on\s+(.+)$/i,          "DEPENDS_ON"],
    [/^(.+?)\s+requires?\s+(.+)$/i,           "REQUIRES"],
    [/^(.+?)\s+needs?\s+(.+)$/i,              "REQUIRES"],
    [/^(.+?)\s+excludes?\s+(.+)$/i,           "EXCLUDES"],
    [/^(.+?)\s+blocks?\s+(.+)$/i,             "EXCLUDES"],
    [/^(.+?)\s+conflicts? with\s+(.+)$/i,     "EXCLUDES"],
  ];
  for (const [pat, type] of patterns) {
    const m = t.match(pat);
    if (m) return { type, source: cap(m[1].trim()), target: cap(m[2].trim()) };
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════
 * SECTION WRAPPER — collapsible panel with blue header
 * ══════════════════════════════════════════════════════════════ */

function Section({
  isDark, icon, title, subtitle, badge, defaultOpen = true, children,
}: {
  isDark: boolean; icon: string; title: string; subtitle?: string;
  badge?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const tk = tokens(isDark);
  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${tk.border}`, background: tk.surface }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-4 cursor-pointer"
        style={{ background: isDark ? "rgba(0,112,214,0.08)" : "rgba(0,71,171,0.04)", borderBottom: open ? `1px solid ${tk.border}` : "none" }}
      >
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "rgba(0,112,214,0.16)", color: tk.accentBlue, border: `1px solid rgba(0,112,214,0.28)` }}>
          <Ic n={icon} s={16} />
        </div>
        <div className="flex flex-col items-start text-left flex-1">
          <span className="text-[13px] font-bold leading-tight" style={{ color: tk.heading }}>{title}</span>
          {subtitle && <span className="text-[10px] mt-0.5" style={{ color: tk.dim }}>{subtitle}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {badge}
          <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} style={{ color: tk.dim }}>
            <Ic n="chevron-down" s={14} />
          </motion.span>
        </div>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span className="text-[9px] px-2 py-0.5 rounded-full font-bold"
      style={{ background: `${color}18`, color, border: `1px solid ${color}30` }}>
      {label}
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════
 * HIERARCHY TREE — recursive bundle/product tree
 * ══════════════════════════════════════════════════════════════ */

function HierarchyTree({
  isDark, bundle, rules, depth = 0,
}: {
  isDark: boolean; bundle: ParsedBundle; rules: DependencyRule[]; depth?: number;
}) {
  const tk = tokens(isDark);
  const activeRules = rules.filter(r => r.active);

  const depEdgesFor = (name: string) => activeRules.filter(r => r.source === name);

  const renderDepEdges = (name: string, prefix: string) =>
    depEdgesFor(name).map((rule) => {
      const cfg = DEP_TYPE_CFG[rule.type];
      const isErr = rule.validationStatus === "error";
      const color = isErr ? tk.error : cfg.color;
      return (
        <div key={rule.id} className="flex items-center gap-1.5 flex-wrap" style={{ marginLeft: (depth * 24) + 16 }}>
          <span style={{ color: tk.dim, fontFamily: "monospace" }}>{prefix}╌╌</span>
          <span className="text-[8px] px-1 py-0.5 rounded font-bold"
            style={{ background: `${color}14`, color, border: `1px solid ${color}28` }}>
            {cfg.label}
          </span>
          <span style={{ color, fontFamily: "monospace" }}>╌╌▶</span>
          <span className="text-[11px] font-medium" style={{ color: tk.body }}>{rule.target}</span>
          {isErr && <span className="text-[9px]" style={{ color: tk.error }}>⚠ {rule.validationMessage}</span>}
        </div>
      );
    });

  return (
    <div className="font-mono text-[12px]" style={{ lineHeight: 2 }}>
      {/* Bundle header */}
      <div className="flex items-center gap-2 flex-wrap" style={{ marginLeft: depth * 24 }}>
        {depth > 0 && <span style={{ color: tk.dim }}>└── </span>}
        <span style={{ color: tk.accentBlue, fontWeight: 700 }}>{bundle.bundleName}</span>
        <span className="text-[9px] px-1.5 py-0.5 rounded"
          style={{ background: "rgba(30,144,255,0.12)", color: tk.accentBlue, border: `1px solid rgba(30,144,255,0.25)` }}>
          Type=Bundle
        </span>
        {depth === 0 && <Pill label="ROOT" color={tk.accentBlue} />}
        {depth > 0 && <Pill label="CHILD BUNDLE" color={tk.accentCyan} />}
        <span className="text-[10px] font-mono" style={{ color: tk.dim }}>${bundle.totalPrice.toLocaleString()}</span>
      </div>

      {/* Bundle dep edges */}
      {renderDepEdges(bundle.bundleName, "    ")}

      {/* Direct products */}
      {(bundle.products ?? []).map((p, i) => {
        const isLast = i === (bundle.products.length - 1) && !(bundle.nestedBundles?.length);
        const pfx = "    ".repeat(depth + 1) + (isLast ? "└── " : "├── ");
        return (
          <div key={p.name}>
            <div className="flex items-center gap-1.5 flex-wrap" style={{ marginLeft: (depth + 1) * 24 }}>
              <span style={{ color: tk.dim }}>{isLast ? "└── " : "├── "}</span>
              <span style={{ color: p.isDependency ? tk.accent : tk.body, fontWeight: p.isDependency ? 600 : 400 }}>{p.name}</span>
              <span className="text-[9px] px-1 py-0.5 rounded"
                style={{ background: "rgba(0,212,255,0.07)", color: tk.dim, border: `1px solid rgba(0,212,255,0.12)` }}>
                Type=null
              </span>
              {p.isDependency && <Pill label="AUTO ADDED" color={tk.accent} />}
              {p.sellingModel && <Pill label={p.sellingModel} color={tk.accentCyan} />}
              {p.category && <Pill label={p.category} color={tk.accentNavy} />}
              <span className="text-[10px]" style={{ color: tk.dim }}>${p.price.toLocaleString()}</span>
            </div>
            {renderDepEdges(p.name, pfx)}
          </div>
        );
      })}

      {/* Nested child bundles */}
      {(bundle.nestedBundles ?? []).map((child) => (
        <HierarchyTree key={child.bundleName} isDark={isDark} bundle={child} rules={rules} depth={depth + 1} />
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
 * AI BUNDLE PROMPT PANEL
 * ══════════════════════════════════════════════════════════════ */

function AiBundlePanel({
  isDark, onParsed,
}: {
  isDark: boolean;
  onParsed: (b: ParsedBundle) => void;
}) {
  const [prompt, setPrompt]       = useState("");
  const [parsing, setParsing]     = useState(false);
  const [parseError, setParseError] = useState("");
  const tk = tokens(isDark);

  const EXAMPLES = [
    `Enterprise Security Suite\n\nChild Bundles:\n- Network Security Bundle\n  - Firewall Appliance $8000 (One Time, Hardware)\n  - VPN Gateway $3000 (One Time, Hardware)\n- AI Monitoring Bundle\n  - Threat Scanner $500/month (Evergreen Monthly, Software)\n  - Analytics Engine $800/month (Evergreen Monthly, Software)\n\nFirewall depends on Threat Intelligence Hub\nAnalytics Engine auto adds Reporting Service`,
    `Office Productivity Suite\n\nChild Bundles:\n- Hardware Bundle\n  - Laptop Pro $1500 (One Time, Hardware)\n  - Monitor $400 (One Time, Hardware)\n- Software Bundle\n  - Office 365 $120/year (Evergreen Yearly, Software)\n  - Security Suite $60/year (Evergreen Yearly, Software)\n\nLaptop Pro requires IT Support Contract`,
  ];

  const handleParse = async () => {
    if (!prompt.trim()) return;
    setParsing(true);
    setParseError("");
    try {
      const res  = await fetch("/api/bundles/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error ?? "Parse failed");
      onParsed(data.bundle);
    } catch (err) {
      setParseError((err as Error).message);
    } finally {
      setParsing(false);
    }
  };

  return (
    <div className="p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: tk.dim }}>
          Bundle Description
        </span>
        <span className="text-[9px] px-2 py-0.5 rounded font-mono"
          style={{ background: "rgba(0,212,255,0.08)", color: tk.accent, border: `1px solid rgba(0,212,255,0.18)` }}>
          RCA v62
        </span>
      </div>

      <textarea
        value={prompt}
        onChange={e => { setPrompt(e.target.value); setParseError(""); }}
        placeholder={"Describe your bundle in natural language.\n\nExample:\nEnterprise Security Suite\n- Network Security Bundle\n  - Firewall $8000 (One Time)\n  - VPN Gateway $3000\n- AI Monitoring Bundle\n  - Threat Scanner $500/month\n\nFirewall depends on Threat Intelligence Hub"}
        rows={9}
        className="w-full rounded-xl text-[12px] outline-none resize-none font-mono"
        style={{
          background: tk.inputBg, border: `1px solid ${tk.inputBorder}`,
          color: tk.body, padding: "12px 14px", lineHeight: 1.65,
        }}
      />

      {parseError && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl"
          style={{ background: "rgba(255,64,102,0.07)", border: "1px solid rgba(255,64,102,0.22)" }}>
          <Ic n="alert" s={13} />
          <span className="text-[11px]" style={{ color: tk.error }}>{parseError}</span>
        </div>
      )}

      <div className="flex items-center gap-3">
        <motion.button
          onClick={handleParse}
          disabled={parsing || !prompt.trim()}
          whileHover={!parsing && prompt.trim() ? { scale: 1.02 } : {}}
          whileTap={!parsing && prompt.trim() ? { scale: 0.97 } : {}}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-[12px] font-bold"
          style={{
            background: parsing || !prompt.trim()
              ? isDark ? "rgba(0,112,214,0.07)" : "rgba(0,71,171,0.08)"
              : "linear-gradient(135deg, #0070D6 0%, #00D4FF 100%)",
            color: parsing || !prompt.trim() ? tk.dim : "rgba(0,5,20,0.92)",
            cursor: parsing || !prompt.trim() ? "not-allowed" : "pointer",
            border: "none",
          }}
        >
          {parsing ? (
            <><motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}><Ic n="refresh" s={13} /></motion.span>Parsing with Claude AI…</>
          ) : (
            <><Ic n="sparkles" s={13} />Parse Bundle</>
          )}
        </motion.button>
      </div>

      {/* Example quick-fill */}
      <div>
        <p className="text-[10px] font-semibold mb-2" style={{ color: tk.dim }}>Quick examples:</p>
        <div className="flex flex-col gap-1.5">
          {EXAMPLES.map((ex, i) => (
            <button
              key={i}
              onClick={() => { setPrompt(ex); setParseError(""); }}
              className="text-left text-[10px] px-3 py-2 rounded-xl cursor-pointer hover:opacity-80 transition-opacity"
              style={{
                background: isDark ? "rgba(0,112,214,0.05)" : "rgba(0,71,171,0.04)",
                color: tk.dim, border: `1px solid ${tk.border}`,
              }}
            >
              {ex.split("\n")[0]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
 * BUNDLE HIERARCHY WORKSPACE — parsed bundle overview + controls
 * ══════════════════════════════════════════════════════════════ */

function BundleHierarchyWorkspace({
  isDark, bundle, onUpdate, onExecute, executing,
}: {
  isDark: boolean; bundle: ParsedBundle;
  onUpdate: (b: ParsedBundle) => void;
  onExecute: () => void;
  executing: boolean;
}) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const tk = tokens(isDark);

  const updatePrice = (idx: number, price: number) => {
    const products = [...bundle.products];
    products[idx] = { ...products[idx], price };
    onUpdate({ ...bundle, products, totalPrice: products.reduce((s, p) => s + p.price, 0) });
  };

  const removeProduct = (idx: number) => {
    const products = bundle.products.filter((_, i) => i !== idx);
    onUpdate({ ...bundle, products, totalPrice: products.reduce((s, p) => s + p.price, 0) });
  };

  let totalBundles = 0, totalProducts = 0;
  const countAll = (b: ParsedBundle) => { totalBundles++; totalProducts += b.products?.length ?? 0; (b.nestedBundles ?? []).forEach(countAll); };
  countAll(bundle);

  return (
    <div className="p-5 flex flex-col gap-5">
      {/* Bundle header card */}
      <div className="rounded-2xl p-4 flex items-start gap-4"
        style={{ background: isDark ? "rgba(0,112,214,0.08)" : "rgba(0,71,171,0.04)", border: `1px solid rgba(0,112,214,0.22)` }}>
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
          style={{ background: "rgba(0,112,214,0.18)", color: tk.accentBlue, border: `1px solid rgba(0,112,214,0.32)` }}>
          <Ic n="package" s={22} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[18px] font-bold leading-tight" style={{ color: tk.heading, letterSpacing: "-0.025em" }}>
            {bundle.bundleName}
          </h3>
          {bundle.description && <p className="text-[11px] mt-1" style={{ color: tk.dim }}>{bundle.description}</p>}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {bundle.category && <Pill label={bundle.category} color={tk.accentBlue} />}
            {bundle.catalog && <Pill label={bundle.catalog} color={tk.accentCyan} />}
            {bundle.sellingModel && <Pill label={bundle.sellingModel} color={tk.accent} />}
            <Pill label={bundle.bundleType ?? "Static"} color={tk.accentNavy} />
            <Pill label={`${totalBundles} bundle${totalBundles !== 1 ? "s" : ""}`} color={tk.accentBlue} />
            <Pill label={`${totalProducts} product${totalProducts !== 1 ? "s" : ""}`} color={tk.accentCyan} />
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-2">
          <span className="text-[20px] font-bold font-mono" style={{ color: tk.accent }}>${bundle.totalPrice.toLocaleString()}</span>
          <motion.button
            onClick={onExecute}
            disabled={executing}
            whileHover={!executing ? { scale: 1.02 } : {}}
            whileTap={!executing ? { scale: 0.97 } : {}}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-bold"
            style={{
              background: executing
                ? isDark ? "rgba(0,112,214,0.07)" : "rgba(0,71,171,0.06)"
                : "linear-gradient(135deg, #0070D6 0%, #00D4FF 100%)",
              color: executing ? tk.dim : "rgba(0,5,20,0.92)",
              cursor: executing ? "not-allowed" : "pointer",
              border: "none",
            }}
          >
            <Ic n="rocket" s={13} />
            {executing ? "Executing…" : "Deploy to Salesforce"}
          </motion.button>
        </div>
      </div>

      {/* Nested bundles */}
      {(bundle.nestedBundles?.length ?? 0) > 0 && (
        <div>
          <p className="text-[10px] font-bold tracking-widest uppercase mb-2.5"
            style={{ color: tk.dim }}>Child Bundles ({bundle.nestedBundles!.length})</p>
          <div className="flex flex-col gap-2">
            {bundle.nestedBundles!.map((nb) => (
              <div key={nb.bundleName} className="rounded-xl px-4 py-3 flex items-center gap-3"
                style={{ background: isDark ? "rgba(0,112,214,0.06)" : "rgba(0,71,171,0.03)", border: `1px solid ${tk.border}` }}>
                <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: "rgba(30,144,255,0.14)", color: tk.accentBlue }}>
                  <Ic n="package" s={13} />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[12px] font-semibold truncate block" style={{ color: tk.heading }}>
                    {nb.bundleName}
                  </span>
                  <span className="text-[9px]" style={{ color: tk.dim }}>
                    {nb.products?.length ?? 0} product{(nb.products?.length ?? 0) !== 1 ? "s" : ""}
                    {(nb.nestedBundles?.length ?? 0) > 0 ? ` · ${nb.nestedBundles!.length} child bundle${nb.nestedBundles!.length !== 1 ? "s" : ""}` : ""}
                    {nb.sellingModel ? ` · ${nb.sellingModel}` : ""}
                    {" · Type=Bundle"}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Pill label="CHILD BUNDLE" color={tk.accentCyan} />
                  <span className="text-[12px] font-mono font-bold" style={{ color: tk.accentCyan }}>${nb.totalPrice.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Direct products */}
      {(bundle.products?.length ?? 0) > 0 && (
        <div>
          <p className="text-[10px] font-bold tracking-widest uppercase mb-2.5" style={{ color: tk.dim }}>
            {(bundle.nestedBundles?.length ?? 0) > 0 ? "Direct Products" : "Products"} ({bundle.products.length})
          </p>
          <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${tk.border}` }}>
            <div className="grid grid-cols-12 px-4 py-2 text-[9px] font-bold tracking-wide uppercase"
              style={{ background: isDark ? "rgba(0,112,214,0.06)" : "rgba(0,71,171,0.05)", color: tk.dim }}>
              <span className="col-span-5">Product Name</span>
              <span className="col-span-3 text-right">Price</span>
              <span className="col-span-3 text-center">Selling Model</span>
              <span className="col-span-1" />
            </div>
            {bundle.products.map((p, i) => (
              <div key={i} className="grid grid-cols-12 px-4 py-2.5 items-center"
                style={{ borderTop: i > 0 ? `1px solid ${tk.border}` : undefined }}>
                <div className="col-span-5 flex items-center gap-1.5">
                  <span style={{ color: p.isDependency ? tk.accent : tk.accentCyan }}><Ic n={p.isDependency ? "link" : "tag"} s={11} /></span>
                  <span className="text-[11px] truncate" style={{ color: tk.body }}>{p.name}</span>
                  {p.isDependency && <Pill label="DEP" color={tk.accent} />}
                </div>
                <div className="col-span-3 flex justify-end">
                  {editingIdx === i ? (
                    <input
                      type="number"
                      defaultValue={p.price}
                      autoFocus
                      onBlur={e => { updatePrice(i, parseFloat(e.target.value) || 0); setEditingIdx(null); }}
                      onKeyDown={e => { if (e.key === "Enter") { updatePrice(i, parseFloat((e.target as HTMLInputElement).value) || 0); setEditingIdx(null); } }}
                      className="w-24 text-right text-[12px] font-mono outline-none rounded-lg px-2 py-0.5"
                      style={{ background: isDark ? "rgba(0,212,255,0.10)" : "rgba(0,212,255,0.06)", color: tk.accent, border: `1px solid rgba(0,212,255,0.30)` }}
                    />
                  ) : (
                    <button onClick={() => setEditingIdx(i)} className="text-[12px] font-mono cursor-pointer hover:opacity-80 transition-opacity"
                      style={{ color: tk.accent }}>${p.price.toLocaleString()}</button>
                  )}
                </div>
                <div className="col-span-3 flex justify-center">
                  {p.sellingModel ? <Pill label={p.sellingModel} color={tk.accentCyan} /> : <span className="text-[10px]" style={{ color: tk.dim }}>—</span>}
                </div>
                <div className="col-span-1 flex justify-end">
                  <button onClick={() => removeProduct(i)} className="opacity-30 hover:opacity-80 transition-opacity cursor-pointer" style={{ color: tk.error }}>
                    <Ic n="x" s={12} />
                  </button>
                </div>
              </div>
            ))}
            <div className="grid grid-cols-12 px-4 py-2.5 items-center"
              style={{ background: isDark ? "rgba(0,112,214,0.07)" : "rgba(0,71,171,0.04)", borderTop: `1px solid ${tk.border}` }}>
              <span className="col-span-5 text-[11px] font-semibold" style={{ color: isDark ? "rgba(58,171,255,0.85)" : "#003380" }}>Bundle Total</span>
              <span className="col-span-7 text-right text-[15px] font-bold font-mono" style={{ color: tk.accent }}>${bundle.totalPrice.toLocaleString()}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
 * DEPENDENCY ENGINE PANEL
 * ══════════════════════════════════════════════════════════════ */

function DependencyEnginePanel({
  isDark, rules, onRulesChange,
}: {
  isDark: boolean; rules: DependencyRule[]; onRulesChange: (r: DependencyRule[]) => void;
}) {
  const [nlInput, setNlInput]       = useState("");
  const [nlError, setNlError]       = useState("");
  const [mSource, setMSource]       = useState("");
  const [mTarget, setMTarget]       = useState("");
  const [mType, setMType]           = useState<DependencyRuleType>("DEPENDS_ON");
  const tk = tokens(isDark);

  const pushRule = (type: DependencyRuleType, source: string, target: string): boolean => {
    const s = source.trim(), t = target.trim();
    if (!s || !t) { setNlError("Source and target are required"); return false; }
    if (s === t)  { setNlError("Source and target must be different"); return false; }
    const newRule: DependencyRule = { id: `rule-${Date.now()}`, type, source: s, target: t, active: true, validationStatus: "unchecked" };
    onRulesChange(validateRules([...rules, newRule]));
    setNlError("");
    return true;
  };

  const handleNL = () => {
    if (!nlInput.trim()) { setNlError("Enter a dependency description"); return; }
    const parsed = parseNL(nlInput);
    if (!parsed) { setNlError('Try: "Firewall depends on Router" or "Support auto adds Monitoring"'); return; }
    if (pushRule(parsed.type, parsed.source, parsed.target)) setNlInput("");
  };

  const handleManual = () => {
    if (pushRule(mType, mSource, mTarget)) { setMSource(""); setMTarget(""); }
  };

  const removeRule = (id: string) => onRulesChange(validateRules(rules.filter(r => r.id !== id)));
  const toggleRule = (id: string) => onRulesChange(validateRules(rules.map(r => r.id === id ? { ...r, active: !r.active } : r)));

  const activeCount = rules.filter(r => r.active).length;
  const errorCount  = rules.filter(r => r.validationStatus === "error").length;

  return (
    <div className="p-5 grid grid-cols-2 gap-6">
      {/* LEFT: Input */}
      <div className="flex flex-col gap-5">

        {/* Natural language */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Ic n="sparkles" s={11} />
            <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: isDark ? "rgba(0,212,255,0.75)" : "#003380" }}>
              Natural Language
            </span>
          </div>
          <textarea
            value={nlInput}
            onChange={e => { setNlInput(e.target.value); setNlError(""); }}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleNL(); } }}
            placeholder={"Firewall depends on Threat Intelligence Hub\nPremium Support auto adds Monitoring\nAntivirus excludes Third Party Security"}
            rows={3}
            className="w-full rounded-xl text-[11px] outline-none resize-none font-mono"
            style={{ background: tk.inputBg, border: `1px solid ${tk.inputBorder}`, color: tk.body, padding: "10px 12px", lineHeight: 1.65 }}
          />
          {nlError && <p className="text-[10px] mt-1" style={{ color: tk.error }}>{nlError}</p>}
          <motion.button
            onClick={handleNL}
            disabled={!nlInput.trim()}
            whileHover={nlInput.trim() ? { scale: 1.02 } : {}}
            className="w-full mt-2 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[11px] font-bold"
            style={{
              background: nlInput.trim() ? "linear-gradient(135deg, #0070D6 0%, #00D4FF 100%)" : isDark ? "rgba(0,112,214,0.06)" : "rgba(0,71,171,0.05)",
              color: nlInput.trim() ? "rgba(0,5,20,0.92)" : tk.dim,
              cursor: nlInput.trim() ? "pointer" : "not-allowed",
              border: "none",
            }}
          >
            <Ic n="zap" s={12} />Parse &amp; Add Rule
          </motion.button>

          {/* Quick examples */}
          <div className="mt-2 flex flex-col gap-1">
            {["Firewall depends on Router", "Support auto adds Monitoring", "Antivirus excludes Competitor AV"].map(ex => (
              <button key={ex} onClick={() => { setNlInput(ex); setNlError(""); }}
                className="text-left text-[9px] px-2 py-1 rounded-lg cursor-pointer hover:opacity-80"
                style={{ background: isDark ? "rgba(0,112,214,0.06)" : "rgba(0,71,171,0.04)", color: tk.dim, border: `1px solid ${tk.border}`, fontFamily: "monospace" }}>
                "{ex}"
              </button>
            ))}
          </div>
        </div>

        {/* Manual rule */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Ic n="edit" s={11} />
            <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: isDark ? "rgba(58,171,255,0.8)" : "#003380" }}>
              Manual Rule
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <input value={mSource} onChange={e => setMSource(e.target.value)} placeholder="Source product"
              className="text-[11px] rounded-xl px-3 py-2 outline-none"
              style={{ background: tk.inputBg, border: `1px solid ${tk.inputBorder}`, color: tk.body }} />
            <div className="grid grid-cols-2 gap-1.5">
              {(["AUTO_ADD", "DEPENDS_ON", "REQUIRES", "EXCLUDES"] as DependencyRuleType[]).map(t => {
                const cfg = DEP_TYPE_CFG[t];
                const active = mType === t;
                return (
                  <button key={t} onClick={() => setMType(t)}
                    className="py-1.5 rounded-xl text-[9px] font-bold cursor-pointer transition-all flex items-center justify-center gap-1"
                    style={{
                      background: active ? `${cfg.color}1C` : "transparent",
                      border: active ? `1px solid ${cfg.color}55` : `1px solid ${tk.border}`,
                      color: active ? cfg.color : tk.dim,
                    }}>
                    <Ic n={cfg.icon} s={9} />{cfg.label}
                  </button>
                );
              })}
            </div>
            <input value={mTarget} onChange={e => setMTarget(e.target.value)} placeholder="Target product"
              className="text-[11px] rounded-xl px-3 py-2 outline-none"
              style={{ background: tk.inputBg, border: `1px solid ${tk.inputBorder}`, color: tk.body }} />
            <button onClick={handleManual} disabled={!mSource.trim() || !mTarget.trim()}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-[11px] font-bold cursor-pointer"
              style={{
                background: mSource.trim() && mTarget.trim() ? "rgba(30,144,255,0.14)" : "transparent",
                border: `1px solid ${mSource.trim() && mTarget.trim() ? "rgba(30,144,255,0.40)" : tk.border}`,
                color: mSource.trim() && mTarget.trim() ? tk.accentBlue : tk.dim,
              }}>
              <Ic n="plus" s={12} />Add Rule
            </button>
          </div>
        </div>
      </div>

      {/* RIGHT: Active rules */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: tk.dim }}>
            Active Rules
          </span>
          {rules.length > 0 && (
            <span className="text-[9px] font-mono" style={{ color: tk.dim }}>{activeCount}/{rules.length}</span>
          )}
        </div>

        <div className="flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: 340, scrollbarWidth: "thin" }}>
          <AnimatePresence mode="popLayout">
            {rules.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 rounded-xl"
                style={{ border: `1px dashed rgba(0,112,214,0.2)` }}>
                <Ic n="git-branch" s={28} />
                <p className="text-[11px] text-center mt-2 leading-relaxed" style={{ color: tk.dim }}>
                  No rules yet.<br />Use Natural Language or Manual form.
                </p>
              </div>
            ) : rules.map(rule => {
              const cfg = DEP_TYPE_CFG[rule.type];
              const isErr = rule.validationStatus === "error";
              return (
                <motion.div
                  key={rule.id}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: rule.active ? 1 : 0.45, y: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  className="rounded-xl p-3"
                  style={{ background: isErr ? "rgba(255,64,102,0.07)" : isDark ? "rgba(0,112,214,0.07)" : "rgba(0,71,171,0.04)", border: `1px solid ${isErr ? "rgba(255,64,102,0.28)" : cfg.color + "2A"}` }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] px-1.5 py-0.5 rounded font-bold"
                      style={{ background: `${cfg.color}14`, color: cfg.color, border: `1px solid ${cfg.color}28` }}>
                      {cfg.label}
                    </span>
                    <div className="flex items-center gap-1 ml-auto">
                      <button onClick={() => toggleRule(rule.id)} className="cursor-pointer opacity-60 hover:opacity-100 transition-opacity"
                        style={{ color: rule.active ? tk.accent : tk.dim }}>
                        <Ic n={rule.active ? "check-circle" : "clock"} s={12} />
                      </button>
                      <button onClick={() => removeRule(rule.id)} className="cursor-pointer opacity-40 hover:opacity-90 transition-opacity"
                        style={{ color: tk.error }}>
                        <Ic n="trash" s={12} />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className="text-[11px] font-semibold" style={{ color: tk.body }}>{rule.source}</span>
                    <span style={{ color: cfg.color, fontSize: 11 }}>╌╌▶</span>
                    <span className="text-[11px] font-semibold" style={{ color: tk.body }}>{rule.target}</span>
                  </div>
                  {isErr && <p className="text-[9px] mt-1" style={{ color: tk.error }}>⚠ {rule.validationMessage}</p>}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>

        {/* Validation banner */}
        {rules.length > 0 && (
          <div className="px-3 py-2 rounded-xl flex items-center gap-2"
            style={{
              background: errorCount > 0 ? "rgba(255,64,102,0.07)" : "rgba(0,112,214,0.07)",
              border: `1px solid ${errorCount > 0 ? "rgba(255,64,102,0.22)" : "rgba(0,112,214,0.22)"}`,
            }}>
            <Ic n={errorCount > 0 ? "alert" : "check-circle"} s={12} />
            <span className="text-[10px]" style={{ color: errorCount > 0 ? tk.error : tk.accentBlue }}>
              {errorCount > 0
                ? `${errorCount} rule${errorCount !== 1 ? "s" : ""} with errors — resolve before deploying`
                : `${activeCount} rule${activeCount !== 1 ? "s" : ""} validated — ready for orchestration`}
            </span>
          </div>
        )}

        {/* Legend */}
        <div className="flex flex-col gap-1">
          {(Object.entries(DEP_TYPE_CFG) as [DependencyRuleType, typeof DEP_TYPE_CFG[DependencyRuleType]][]).map(([, cfg]) => (
            <div key={cfg.label} className="flex items-center gap-1.5">
              <Ic n={cfg.icon} s={9} />
              <span className="text-[8px] font-bold" style={{ color: cfg.color }}>{cfg.label}</span>
              <span className="text-[8px]" style={{ color: tk.dim }}>— {cfg.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
 * NESTED BUNDLE VISUALIZATION
 * ══════════════════════════════════════════════════════════════ */

function NestedBundleViz({
  isDark, bundle, rules,
}: {
  isDark: boolean; bundle: ParsedBundle; rules: DependencyRule[];
}) {
  const tk = tokens(isDark);

  let totalBundles = 0, totalProducts = 0, maxDepth = 0;
  const countAll = (b: ParsedBundle, d = 0) => {
    totalBundles++;
    totalProducts += b.products?.length ?? 0;
    maxDepth = Math.max(maxDepth, d);
    (b.nestedBundles ?? []).forEach(c => countAll(c, d + 1));
  };
  countAll(bundle);

  return (
    <div className="p-5 flex flex-col gap-4">
      {/* Stats bar */}
      <div className="flex items-center gap-4 flex-wrap">
        {[
          { label: "Total Bundles", value: totalBundles, color: tk.accentBlue },
          { label: "Total Products", value: totalProducts, color: tk.accentCyan },
          { label: "Max Depth", value: maxDepth + 1, color: tk.accent },
          { label: "Dep Rules", value: rules.filter(r => r.active).length, color: tk.accentNavy },
        ].map(stat => (
          <div key={stat.label} className="flex flex-col items-center px-4 py-2 rounded-xl"
            style={{ background: isDark ? "rgba(0,112,214,0.07)" : "rgba(0,71,171,0.04)", border: `1px solid ${tk.border}` }}>
            <span className="text-[18px] font-bold font-mono" style={{ color: stat.color }}>{stat.value}</span>
            <span className="text-[9px] font-medium" style={{ color: tk.dim }}>{stat.label}</span>
          </div>
        ))}
      </div>

      {/* Tree visualization */}
      <div className="rounded-xl p-4 overflow-x-auto"
        style={{ background: isDark ? "rgba(2,6,18,0.85)" : "rgba(228,238,255,0.95)", border: `1px solid ${tk.border}` }}>
        <HierarchyTree isDark={isDark} bundle={bundle} rules={rules} depth={0} />
      </div>

      {/* RCA type legend */}
      <div className="flex items-center gap-4 flex-wrap">
        {[
          { label: "Type=Bundle (parent/child)", color: tk.accentBlue, icon: "package" },
          { label: "Type=null (leaf product)", color: tk.body, icon: "tag" },
          { label: "AUTO ADDED (dependency)", color: tk.accent, icon: "link" },
        ].map(item => (
          <div key={item.label} className="flex items-center gap-1.5">
            <span style={{ color: item.color }}><Ic n={item.icon} s={11} /></span>
            <span className="text-[10px]" style={{ color: tk.dim }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
 * COMMERCIALIZATION PANEL
 * ══════════════════════════════════════════════════════════════ */

function CommercializationPanel({
  isDark, commMap,
}: {
  isDark: boolean; commMap: Record<string, CommercializationEntry>;
}) {
  const tk = tokens(isDark);
  const entries = Object.values(commMap);

  if (entries.length === 0) {
    return (
      <div className="p-5 flex flex-col items-center justify-center py-12">
        <Ic n="tag" s={32} />
        <p className="text-[12px] mt-3 text-center" style={{ color: tk.dim }}>
          Commercialization map will appear after deployment.
        </p>
      </div>
    );
  }

  const ActionBadge = ({ action }: { action?: string }) => {
    if (!action) return null;
    const color = action === "created" ? tk.accent : action === "reused_fallback" ? tk.warn : tk.accentBlue;
    const label = action === "created" ? "CREATED" : action === "reused_fallback" ? "FALLBACK" : "REUSED";
    return <Pill label={label} color={color} />;
  };

  return (
    <div className="p-5">
      <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${tk.border}` }}>
        <div className="grid grid-cols-12 px-4 py-2.5 text-[9px] font-bold tracking-widest uppercase"
          style={{ background: isDark ? "rgba(0,112,214,0.07)" : "rgba(0,71,171,0.05)", color: tk.dim, borderBottom: `1px solid ${tk.border}` }}>
          <span className="col-span-3">Product</span>
          <span className="col-span-3">Catalog</span>
          <span className="col-span-3">Category</span>
          <span className="col-span-3">Selling Model</span>
        </div>
        {entries.map((entry, i) => (
          <div key={entry.productName} className="grid grid-cols-12 px-4 py-3 items-start gap-1"
            style={{ borderTop: i > 0 ? `1px solid ${tk.border}` : undefined, background: i % 2 === 0 ? "transparent" : isDark ? "rgba(0,112,214,0.02)" : "rgba(0,71,171,0.01)" }}>
            <div className="col-span-3">
              <p className="text-[11px] font-semibold leading-tight" style={{ color: tk.heading }}>{entry.productName}</p>
            </div>
            <div className="col-span-3 flex flex-col gap-1">
              {entry.catalog ? (
                <><span className="text-[10px]" style={{ color: tk.accent }}>{entry.catalog}</span><ActionBadge action={entry.catalogAction} /></>
              ) : <span style={{ color: tk.dim }}>—</span>}
            </div>
            <div className="col-span-3 flex flex-col gap-1">
              {entry.category ? (
                <><span className="text-[10px]" style={{ color: tk.accentCyan }}>{entry.category}</span><ActionBadge action={entry.categoryAction} /></>
              ) : <span style={{ color: tk.dim }}>—</span>}
            </div>
            <div className="col-span-3 flex flex-col gap-1">
              {entry.sellingModel ? (
                <><span className="text-[10px]" style={{ color: tk.accentBlue }}>{entry.sellingModel}</span><ActionBadge action={entry.sellingModelAction} /></>
              ) : <span style={{ color: tk.dim }}>—</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
 * EXECUTION CONSOLE
 * ══════════════════════════════════════════════════════════════ */

function ExecutionConsole({
  isDark, batches, logs, executing, onClear,
}: {
  isDark: boolean; batches: BatchStatus[]; logs: LogEntry[]; executing: boolean; onClear: () => void;
}) {
  const logsEndRef = useRef<HTMLDivElement>(null);
  const tk = tokens(isDark);

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs.length]);

  return (
    <div className="p-5 flex flex-col gap-4">
      {/* Batch grid */}
      <div className="grid grid-cols-3 gap-2.5">
        {batches.map(b => {
          const color = batchColor(b.status);
          return (
            <div key={b.batch} className="rounded-xl p-3 flex flex-col gap-1.5"
              style={{
                background: b.status === "pending" ? (isDark ? "rgba(0,112,214,0.03)" : "rgba(0,71,171,0.02)") : isDark ? `${color}0A` : `${color}07`,
                border: `1px solid ${b.status === "pending" ? tk.border : color + "2C"}`,
              }}>
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-mono" style={{ color: tk.dim }}>Batch {b.batch}</span>
                {b.status === "success" ? (
                  <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} style={{ color: tk.accent }}><Ic n="check-circle" s={12} /></motion.span>
                ) : b.status === "error" ? (
                  <span style={{ color: tk.error }}><Ic n="alert" s={12} /></span>
                ) : b.status === "running" ? (
                  <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }} style={{ color: tk.accentBlue }}><Ic n="refresh" s={12} /></motion.span>
                ) : (
                  <span style={{ color: tk.dim }}><Ic n="clock" s={12} /></span>
                )}
              </div>
              <div className="text-[10px] font-semibold leading-tight"
                style={{ color: b.status === "pending" ? tk.dim : tk.body }}>
                {b.name}
              </div>
              {b.status !== "pending" && (
                <div className="h-0.5 rounded-full transition-all duration-500"
                  style={{ background: color, width: b.status === "running" ? "55%" : "100%", opacity: 0.6 }} />
              )}
              {b.status === "success" && (
                <div className="flex justify-between">
                  {b.count > 0 && <span className="text-[8px] font-mono" style={{ color }}>+{b.count}</span>}
                  {b.duration && <span className="text-[8px] font-mono" style={{ color: tk.dim }}>{(b.duration / 1000).toFixed(1)}s</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Log stream */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: tk.dim }}>
            {executing ? (
              <span className="flex items-center gap-1.5">
                <motion.span className="w-1.5 h-1.5 rounded-full inline-block" animate={{ opacity: [1, 0.2, 1] }} transition={{ duration: 0.7, repeat: Infinity }}
                  style={{ background: tk.accent, display: "inline-block" }} />
                Streaming Logs
              </span>
            ) : "Deployment Logs"}
          </span>
          {!executing && logs.length > 0 && (
            <button onClick={onClear} className="text-[9px] cursor-pointer px-2 py-1 rounded-lg hover:opacity-80"
              style={{ color: tk.dim, border: `1px solid ${tk.border}` }}>Clear</button>
          )}
        </div>
        <div className="rounded-xl p-3 overflow-y-auto"
          style={{
            maxHeight: 300, scrollbarWidth: "thin",
            background: isDark ? "rgba(1,4,14,0.9)" : "rgba(248,252,255,0.97)",
            border: `1px solid ${tk.border}`,
            fontFamily: "var(--font-mono, monospace)",
          }}>
          {logs.length === 0 ? (
            <div className="flex items-center justify-center h-16">
              <p className="text-[11px]" style={{ color: tk.dim }}>Logs will stream here during execution…</p>
            </div>
          ) : logs.map(log => (
            <motion.div key={log.id}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.12 }}
              className="flex items-start gap-2 mb-0.5 py-0.5">
              <span className="text-[9px] shrink-0 font-mono mt-0.5" style={{ color: tk.dim }}>B{log.batch}</span>
              <span className="text-[10px] font-mono leading-relaxed break-all" style={{ color: logColor(log.level) }}>
                {log.level === "success" ? "✓ " : log.level === "error" ? "✗ " : log.level === "warning" ? "⚠ " : "› "}
                {log.message}
              </span>
            </motion.div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
 * DEPLOYMENT LOGS — completed bundle IDs and summary
 * ══════════════════════════════════════════════════════════════ */

function DeploymentLogsPanel({
  isDark, completedBundleId, batches, logs,
}: {
  isDark: boolean; completedBundleId: string | null; batches: BatchStatus[]; logs: LogEntry[];
}) {
  const tk = tokens(isDark);
  const successBatches = batches.filter(b => b.status === "success");
  const errorBatches   = batches.filter(b => b.status === "error");
  const totalRecords   = batches.reduce((s, b) => s + b.count, 0);
  const totalDuration  = batches.reduce((s, b) => s + (b.duration ?? 0), 0);

  return (
    <div className="p-5 flex flex-col gap-4">
      {completedBundleId ? (
        <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
          className="rounded-2xl p-5 flex items-center gap-4"
          style={{ background: "rgba(0,112,214,0.10)", border: "1px solid rgba(0,112,214,0.30)" }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
            style={{ background: "rgba(0,212,255,0.16)", color: tk.accent }}>
            <Ic n="rocket" s={26} />
          </div>
          <div className="flex-1">
            <p className="text-[16px] font-bold" style={{ color: tk.accentBlue }}>Bundle Deployed Successfully!</p>
            <p className="text-[10px] font-mono mt-1" style={{ color: tk.dim }}>ID: {completedBundleId}</p>
            <div className="flex items-center gap-4 mt-2 flex-wrap">
              <span className="text-[10px]" style={{ color: tk.dim }}>{totalRecords} records created</span>
              <span className="text-[10px]" style={{ color: tk.dim }}>{successBatches.length}/9 batches completed</span>
              <span className="text-[10px]" style={{ color: tk.dim }}>{(totalDuration / 1000).toFixed(1)}s total</span>
            </div>
          </div>
        </motion.div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12">
          <Ic n="shield" s={32} />
          <p className="text-[12px] mt-3" style={{ color: tk.dim }}>Deployment summary will appear here after execution.</p>
        </div>
      )}

      {/* Batch summary table */}
      {successBatches.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${tk.border}` }}>
          <div className="grid grid-cols-12 px-4 py-2 text-[9px] font-bold tracking-widest uppercase"
            style={{ background: isDark ? "rgba(0,112,214,0.07)" : "rgba(0,71,171,0.05)", color: tk.dim, borderBottom: `1px solid ${tk.border}` }}>
            <span className="col-span-1">Batch</span>
            <span className="col-span-5">Name</span>
            <span className="col-span-2 text-center">Records</span>
            <span className="col-span-2 text-center">Duration</span>
            <span className="col-span-2 text-center">Status</span>
          </div>
          {batches.map(b => (
            <div key={b.batch} className="grid grid-cols-12 px-4 py-2.5 items-center"
              style={{ borderTop: `1px solid ${tk.border}` }}>
              <span className="col-span-1 text-[10px] font-mono" style={{ color: tk.dim }}>#{b.batch}</span>
              <span className="col-span-5 text-[11px]" style={{ color: tk.body }}>{b.name}</span>
              <span className="col-span-2 text-center text-[11px] font-mono" style={{ color: b.status === "success" ? tk.accent : tk.dim }}>
                {b.status === "success" ? `+${b.count}` : "—"}
              </span>
              <span className="col-span-2 text-center text-[10px] font-mono" style={{ color: tk.dim }}>
                {b.duration ? `${(b.duration / 1000).toFixed(1)}s` : "—"}
              </span>
              <div className="col-span-2 flex justify-center">
                {b.status === "success" ? <Pill label="OK" color={tk.accent} /> :
                 b.status === "error" ? <Pill label="ERR" color={tk.error} /> :
                 b.status === "running" ? <Pill label="RUN" color={tk.accentBlue} /> :
                 <Pill label="WAIT" color={tk.dim} />}
              </div>
            </div>
          ))}
          {errorBatches.length > 0 && (
            <div className="px-4 py-2.5 flex items-center gap-2"
              style={{ background: "rgba(255,64,102,0.06)", borderTop: `1px solid ${tk.border}` }}>
              <Ic n="alert" s={12} />
              <span className="text-[10px]" style={{ color: tk.error }}>
                {errorBatches.length} batch{errorBatches.length !== 1 ? "es" : ""} failed — check logs above
              </span>
            </div>
          )}
        </div>
      )}

      {/* Error logs excerpt */}
      {logs.filter(l => l.level === "error").length > 0 && (
        <div>
          <p className="text-[10px] font-bold mb-2" style={{ color: tk.error }}>Error Summary</p>
          <div className="rounded-xl p-3 flex flex-col gap-1.5"
            style={{ background: "rgba(255,64,102,0.05)", border: "1px solid rgba(255,64,102,0.18)" }}>
            {logs.filter(l => l.level === "error").slice(-10).map(l => (
              <p key={l.id} className="text-[10px] font-mono" style={{ color: tk.error }}>✗ {l.message}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
 * OMNION LOGO MARK
 * ══════════════════════════════════════════════════════════════ */

function OmnionMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill="url(#omni-grad)" />
      <path d="M16 6C10.477 6 6 10.477 6 16s4.477 10 10 10 10-4.477 10-10S21.523 6 16 6zm0 3a7 7 0 1 1 0 14A7 7 0 0 1 16 9z" fill="rgba(255,255,255,0.15)" />
      <path d="M16 10a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 2.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z" fill="white" fillOpacity="0.9" />
      <circle cx="16" cy="16" r="2" fill="#00D4FF" />
      <defs>
        <linearGradient id="omni-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0050B3" />
          <stop offset="1" stopColor="#00D4FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════
 * MAIN EXPORT — BundleOrchestrationWorkspace
 * ══════════════════════════════════════════════════════════════ */

const INITIAL_STATE: BundleOrchestrationState = {
  parsedBundle:      null,
  depRules:          [],
  executing:         false,
  batches:           INITIAL_BATCHES.map(b => ({ ...b })),
  logs:              [],
  completedBundleId: null,
  commMap:           {},
};

export default function BundleOrchestrationWorkspace({ isDark }: { isDark: boolean }) {
  const [state, setState] = useState<BundleOrchestrationState>(INITIAL_STATE);
  const logIdRef          = useRef(0);
  const lastBundleRef     = useRef<string | null>(null);
  const tk = tokens(isDark);

  /* Helpers to update centralized state slices */
  const setSlice = useCallback(<K extends keyof BundleOrchestrationState>(key: K, val: BundleOrchestrationState[K]) => {
    setState(prev => ({ ...prev, [key]: val }));
  }, []);

  const addLog = useCallback((entry: Omit<LogEntry, "id" | "timestamp">) => {
    const id = String(logIdRef.current++);
    setState(prev => ({
      ...prev,
      logs: [...prev.logs.slice(-600), { ...entry, id, timestamp: Date.now() }],
    }));
  }, []);

  /* Merge AI-detected deps into dep rules when a bundle is parsed */
  useEffect(() => {
    if (!state.parsedBundle?.bundleName) return;
    if (lastBundleRef.current === state.parsedBundle.bundleName) return;
    lastBundleRef.current = state.parsedBundle.bundleName;

    const collectDeps = (b: ParsedBundle): NonNullable<ParsedBundle["dependencies"]> => {
      const deps = [...(b.dependencies ?? [])];
      for (const child of b.nestedBundles ?? []) deps.push(...collectDeps(child));
      return deps;
    };

    const aiDeps = collectDeps(state.parsedBundle);
    const aiRules: DependencyRule[] = aiDeps.map((d, i) => ({
      id: `ai-${Date.now()}-${i}`,
      type: (d.type as DependencyRuleType | undefined) ?? "AUTO_ADD",
      source: d.source,
      target: d.target,
      active: true,
      validationStatus: "valid" as const,
    }));

    setState(prev => {
      const existing = new Set(prev.depRules.map(r => `${r.source}|${r.target}`));
      const fresh = aiRules.filter(d => !existing.has(`${d.source}|${d.target}`));
      if (fresh.length === 0) return prev;
      return { ...prev, depRules: validateRules([...prev.depRules, ...fresh]) };
    });
  }, [state.parsedBundle?.bundleName]);

  /* Execute handler */
  const handleExecute = useCallback(async () => {
    if (!state.parsedBundle || state.executing) return;
    setState(prev => ({
      ...prev,
      executing: true,
      completedBundleId: null,
      logs: [],
      commMap: {},
      batches: INITIAL_BATCHES.map(b => ({ ...b })),
    }));

    try {
      const res = await fetch("/api/bundles/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundle: state.parsedBundle, depRules: state.depRules }),
      });

      if (!res.ok || !res.body) {
        addLog({ batch: 0, level: "error", message: "Failed to connect to orchestration engine" });
        setState(prev => ({ ...prev, executing: false }));
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "batch_start") {
              setState(prev => ({
                ...prev,
                batches: prev.batches.map(b => b.batch === ev.batch ? { ...b, status: "running" } : b),
              }));
              addLog({ batch: ev.batch, level: "info", message: `▶ ${ev.name} (${ev.total} items)` });
            } else if (ev.type === "batch_complete") {
              setState(prev => ({
                ...prev,
                batches: prev.batches.map(b => b.batch === ev.batch ? { ...b, status: "success", count: ev.count, duration: ev.duration } : b),
              }));
              addLog({ batch: ev.batch, level: "success", message: `✓ ${ev.name} — ${ev.count} records (${(ev.duration / 1000).toFixed(1)}s)` });
            } else if (ev.type === "batch_error") {
              setState(prev => ({
                ...prev,
                batches: prev.batches.map(b => b.batch === ev.batch ? { ...b, status: "error", error: ev.error } : b),
              }));
              addLog({ batch: ev.batch, level: "error", message: `✗ ${ev.name}: ${ev.error}` });
            } else if (ev.type === "record_created") {
              addLog({ batch: ev.batch, level: "success", message: `${ev.sobject}: ${ev.name} → ${ev.id}`, sfId: ev.id });
            } else if (ev.type === "log") {
              addLog({ batch: ev.batch, level: ev.level, message: ev.message });
            } else if (ev.type === "commercialization_update") {
              setState(prev => ({
                ...prev,
                commMap: {
                  ...prev.commMap,
                  [ev.product]: {
                    ...(prev.commMap[ev.product] ?? { productName: ev.product }),
                    ...(ev.sellingModel ? { sellingModel: ev.sellingModel, sellingModelAction: ev.sellingModelAction } : {}),
                    ...(ev.catalog ? { catalog: ev.catalog, catalogAction: ev.catalogAction } : {}),
                    ...(ev.category ? { category: ev.category, categoryAction: ev.categoryAction } : {}),
                  },
                },
              }));
            } else if (ev.type === "complete") {
              setState(prev => ({ ...prev, completedBundleId: ev.bundleId }));
              addLog({ batch: 9, level: "success", message: `Bundle deployed! ID: ${ev.bundleId}` });
            } else if (ev.type === "error") {
              addLog({ batch: 0, level: "error", message: `Error: ${ev.message}` });
            }
          } catch { /* malformed SSE */ }
        }
      }
    } catch (err) {
      addLog({ batch: 0, level: "error", message: (err as Error).message });
    } finally {
      setState(prev => ({ ...prev, executing: false }));
    }
  }, [state.parsedBundle, state.executing, state.depRules, addLog]);

  const handleClear = useCallback(() => {
    setState(prev => ({
      ...prev,
      logs: [],
      batches: INITIAL_BATCHES.map(b => ({ ...b })),
      completedBundleId: null,
      commMap: {},
    }));
  }, []);

  const { parsedBundle, depRules, executing, batches, logs, completedBundleId, commMap } = state;
  const showConsole = logs.length > 0 || executing;
  const activeRuleCount = depRules.filter(r => r.active).length;

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: tk.bg }}>

      {/* ── Top Bar ── */}
      <div className="px-6 py-3.5 shrink-0 flex items-center gap-3"
        style={{ background: isDark ? "rgba(2,6,20,0.98)" : "rgba(240,246,255,0.99)", borderBottom: `1px solid ${tk.border}` }}>
        <OmnionMark size={34} />
        <div>
          <h1 className="text-[15px] font-bold leading-tight" style={{ color: tk.heading, letterSpacing: "-0.025em" }}>
            RCA Bundle Orchestration Studio
          </h1>
          <p className="text-[10px]" style={{ color: tk.dim }}>
            Salesforce Revenue Cloud Advanced · AI-Powered · Dependency-Aware
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {activeRuleCount > 0 && (
            <span className="text-[10px] px-3 py-1 rounded-full font-semibold"
              style={{ background: "rgba(0,112,214,0.14)", color: tk.accentBlue, border: `1px solid rgba(0,112,214,0.30)` }}>
              {activeRuleCount} dep rule{activeRuleCount !== 1 ? "s" : ""}
            </span>
          )}
          {parsedBundle && (
            <span className="text-[10px] px-3 py-1 rounded-full font-semibold"
              style={{ background: "rgba(0,212,255,0.12)", color: tk.accent, border: `1px solid rgba(0,212,255,0.28)` }}>
              {parsedBundle.bundleName}
            </span>
          )}
          {executing && (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full"
              style={{ background: "rgba(0,112,214,0.14)", border: `1px solid rgba(0,112,214,0.28)` }}>
              <motion.span className="w-1.5 h-1.5 rounded-full" animate={{ opacity: [1, 0.2, 1] }} transition={{ duration: 0.7, repeat: Infinity }}
                style={{ background: tk.accent, display: "inline-block" }} />
              <span className="text-[10px]" style={{ color: tk.accentBlue }}>Executing…</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Scrollable Body ── */}
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
        <div className="px-6 py-5 flex flex-col gap-5" style={{ maxWidth: 1160, margin: "0 auto" }}>

          {/* 1. AI Bundle Prompt Panel */}
          <Section
            isDark={isDark}
            icon="sparkles"
            title="AI Bundle Creator"
            subtitle="Describe your bundle in natural language — Claude AI parses it into full RCA structure"
            badge={parsedBundle ? <Pill label="PARSED" color={tk.accent} /> : undefined}
          >
            <AiBundlePanel isDark={isDark} onParsed={b => { lastBundleRef.current = null; setSlice("parsedBundle", b); }} />
          </Section>

          {/* 2. Bundle Hierarchy Workspace (only after parse) */}
          <AnimatePresence>
            {parsedBundle && (
              <motion.div key="hierarchy-workspace"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25 }}
              >
                <Section
                  isDark={isDark}
                  icon="package"
                  title="Bundle Hierarchy Workspace"
                  subtitle="Review structure, edit prices, and deploy to Salesforce"
                  badge={
                    <span className="text-[10px] px-2 py-0.5 rounded font-mono"
                      style={{ background: "rgba(30,144,255,0.12)", color: tk.accentBlue, border: `1px solid rgba(30,144,255,0.25)` }}>
                      Type=Bundle
                    </span>
                  }
                >
                  <BundleHierarchyWorkspace
                    isDark={isDark}
                    bundle={parsedBundle}
                    onUpdate={b => setSlice("parsedBundle", b)}
                    onExecute={handleExecute}
                    executing={executing}
                  />
                </Section>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 3. Dependency Engine */}
          <Section
            isDark={isDark}
            icon="git-branch"
            title="Dependency Engine"
            subtitle="Define product relationships — persists across bundle parses"
            badge={activeRuleCount > 0 ? <Pill label={`${activeRuleCount} rules`} color={tk.accentBlue} /> : undefined}
          >
            <DependencyEnginePanel
              isDark={isDark}
              rules={depRules}
              onRulesChange={r => setSlice("depRules", r)}
            />
          </Section>

          {/* 4. Nested Bundle Visualization (only after parse) */}
          <AnimatePresence>
            {parsedBundle && (
              <motion.div key="nested-viz"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22, delay: 0.05 }}
              >
                <Section
                  isDark={isDark}
                  icon="layers"
                  title="Nested Bundle Visualization"
                  subtitle="Full hierarchy tree with RCA product types and dependency arrows"
                >
                  <NestedBundleViz isDark={isDark} bundle={parsedBundle} rules={depRules} />
                </Section>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 5. Commercialization Panel */}
          <Section
            isDark={isDark}
            icon="tag"
            title="Commercialization Panel"
            subtitle="Catalog · Category · Selling Model assignments per product"
            badge={Object.keys(commMap).length > 0 ? <Pill label={`${Object.keys(commMap).length} mapped`} color={tk.accent} /> : undefined}
            defaultOpen={false}
          >
            <CommercializationPanel isDark={isDark} commMap={commMap} />
          </Section>

          {/* 6. Execution Console (appears when running or has logs) */}
          <AnimatePresence>
            {showConsole && (
              <motion.div key="exec-console"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25 }}
              >
                <Section
                  isDark={isDark}
                  icon="terminal"
                  title="Live Execution Console"
                  subtitle="Real-time 9-batch orchestration stream"
                  badge={executing ? (
                    <span className="flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full"
                      style={{ background: "rgba(0,212,255,0.12)", color: tk.accent, border: "1px solid rgba(0,212,255,0.26)" }}>
                      <motion.span className="w-1.5 h-1.5 rounded-full inline-block"
                        animate={{ opacity: [1, 0.2, 1] }} transition={{ duration: 0.7, repeat: Infinity }}
                        style={{ background: tk.accent, display: "inline-block" }} />
                      LIVE
                    </span>
                  ) : <Pill label="DONE" color={tk.accentBlue} />}
                >
                  <ExecutionConsole
                    isDark={isDark}
                    batches={batches}
                    logs={logs}
                    executing={executing}
                    onClear={handleClear}
                  />
                </Section>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 7. Deployment Logs (always visible after run) */}
          <AnimatePresence>
            {(completedBundleId || batches.some(b => b.status !== "pending")) && (
              <motion.div key="deploy-logs"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22 }}
              >
                <Section
                  isDark={isDark}
                  icon="activity"
                  title="Deployment Summary"
                  subtitle="Batch results, record counts, and error report"
                  badge={completedBundleId ? <Pill label="DEPLOYED" color={tk.accent} /> : undefined}
                  defaultOpen={!!completedBundleId}
                >
                  <DeploymentLogsPanel
                    isDark={isDark}
                    completedBundleId={completedBundleId}
                    batches={batches}
                    logs={logs}
                  />
                </Section>
              </motion.div>
            )}
          </AnimatePresence>

        </div>
      </div>
    </div>
  );
}
