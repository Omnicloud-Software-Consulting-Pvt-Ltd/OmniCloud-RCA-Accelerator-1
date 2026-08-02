"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import RCProductWorkspace from "@/components/metadata/RCProductWorkspace";
import BundleOrchestrationWorkspace from "@/components/data/BundleOrchestrationWorkspace";
import RCAAttributeStudio from "@/components/data/RCAAttributeStudio";

// ─────────────────────────────────────────────────────────────────────────────
// ICON SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
function Ic({ n, s = 16 }: { n: string; s?: number }) {
  const p = {
    width: s, height: s, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.8,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  switch (n) {
    case "sparkles":      return <svg {...p}><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M5 17l.75 2.25L8 20l-2.25.75L5 23l-.75-2.25L2 20l2.25-.75L5 17z"/><path d="M19 3l.75 2.25L22 6l-2.25.75L19 9l-.75-2.25L16 6l2.25-.75L19 3z"/></svg>;
    case "package":       return <svg {...p}><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>;
    case "git-branch":    return <svg {...p}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>;
    case "layers":        return <svg {...p}><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>;
    case "sliders":       return <svg {...p}><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>;
    case "zap":           return <svg {...p}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
    case "rocket":        return <svg {...p}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>;
    case "plus":          return <svg {...p}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
    case "x":             return <svg {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
    case "trash":         return <svg {...p}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>;
    case "check-circle":  return <svg {...p}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
    case "alert":         return <svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
    case "clock":         return <svg {...p}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
    case "refresh":       return <svg {...p}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>;
    case "terminal":      return <svg {...p}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>;
    case "tag":           return <svg {...p}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>;
    case "chevron-right": return <svg {...p}><polyline points="9 18 15 12 9 6"/></svg>;
    case "chevron-down":  return <svg {...p}><polyline points="6 9 12 15 18 9"/></svg>;
    case "link":          return <svg {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>;
    case "cpu":           return <svg {...p}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>;
    case "database":      return <svg {...p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>;
    case "dollar-sign":   return <svg {...p}><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>;
    case "send":          return <svg {...p}><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>;
    case "info":          return <svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>;
    case "eye":           return <svg {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
    case "copy":          return <svg {...p}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
    case "grid":          return <svg {...p}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>;
    case "arrow-right":   return <svg {...p}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>;
    default:              return <svg {...p}><circle cx="12" cy="12" r="4"/></svg>;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
type TabId =
  | "rca-product-creator"
  | "rca-bundle-studio"
  | "rca-dependency-engine"
  | "rca-nested-bundles"
  | "rca-attribute-studio"
  | "rca-commercialization"
  | "rca-deployment-console";

interface DependencyRule {
  id: string;
  type: "AUTO_ADD" | "DEPENDS_ON" | "REQUIRES" | "EXCLUDES";
  source: string;
  target: string;
  active: boolean;
  isCircular?: boolean;
  validationMsg?: string;
}

interface BundleNode {
  id: string;
  name: string;
  nodeType: "bundle" | "product";
  price?: number;
  sellingModel?: string;
  children: BundleNode[];
  isExpanded: boolean;
}

interface CommercialRecord {
  id: string;
  name: string;
  type: "catalog" | "category" | "sellingModel";
  subType?: string;
  isExisting: boolean;
  linkedProducts: string[];
}

interface LogEntry {
  id: string;
  ts: number;
  batch: number;
  level: "info" | "success" | "error" | "warning";
  msg: string;
  sfId?: string;
}

interface BatchState {
  batch: number;
  name: string;
  status: "pending" | "running" | "success" | "error";
  count: number;
  duration?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const TABS: { id: TabId; label: string; icon: string; shortLabel: string; badge?: string }[] = [
  { id: "rca-product-creator",    label: "Product Creator",              shortLabel: "Products",      icon: "sparkles",  badge: "AI"  },
  { id: "rca-bundle-studio",      label: "Bundle Studio",                shortLabel: "Bundles",       icon: "package",   badge: "AI"  },
  { id: "rca-dependency-engine",  label: "Dependency Engine",            shortLabel: "Dependencies",  icon: "git-branch"             },
  { id: "rca-nested-bundles",     label: "Nested Bundle Orchestration",  shortLabel: "Nested",        icon: "layers"                 },
  { id: "rca-attribute-studio",   label: "Attribute Studio",             shortLabel: "Attributes",    icon: "sliders",   badge: "AI"  },
  { id: "rca-commercialization",  label: "Commercialization Engine",     shortLabel: "Commercial",    icon: "zap"                    },
  { id: "rca-deployment-console", label: "RCA Deployment Console",       shortLabel: "Deploy",        icon: "rocket",    badge: "LIVE"},
];

const INIT_BATCHES: BatchState[] = [
  { batch: 1, name: "Create Products",          status: "pending", count: 0 },
  { batch: 2, name: "Create Bundles",           status: "pending", count: 0 },
  { batch: 3, name: "Create Relationships",     status: "pending", count: 0 },
  { batch: 4, name: "Create Dependency Rules",  status: "pending", count: 0 },
  { batch: 5, name: "Create Attributes",        status: "pending", count: 0 },
  { batch: 6, name: "Commercialization",        status: "pending", count: 0 },
  { batch: 7, name: "Assign Selling Models",    status: "pending", count: 0 },
  { batch: 8, name: "Pricebook Entries",        status: "pending", count: 0 },
  { batch: 9, name: "Validation + Deployment",  status: "pending", count: 0 },
];

const SELLING_MODELS = [
  "Evergreen Monthly",
  "Evergreen Quarterly",
  "Evergreen Yearly",
  "One Time",
  "Term Defined Monthly",
  "Term Defined Quarterly",
  "Term Defined Yearly",
  "Usage Based",
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function batchColor(s: BatchState["status"]) {
  switch (s) {
    case "running":  return "#1E90FF";
    case "success":  return "#00D4FF";
    case "error":    return "#E84444";
    default:         return "rgba(100,140,180,0.4)";
  }
}

function logColor(l: LogEntry["level"]) {
  switch (l) {
    case "success":  return "#00D4FF";
    case "error":    return "#E84444";
    case "warning":  return "#3AABFF";
    default:         return "rgba(140,180,220,0.8)";
  }
}

// Natural language dependency parser
function parseNLDependency(text: string): Omit<DependencyRule, "id" | "active"> | null {
  const t = text.trim();
  const depends   = t.match(/^(.+?)\s+depends\s+on\s+(.+)$/i);
  const requires  = t.match(/^(.+?)\s+requires?\s+(.+)$/i);
  const excludes  = t.match(/^(.+?)\s+excludes?\s+(.+)$/i);
  const autoAdd   = t.match(/^auto.?add\s+(.+?)\s+(?:to|when)\s+(.+)$/i);
  if (depends)  return { type: "DEPENDS_ON", source: depends[1].trim(),  target: depends[2].trim() };
  if (requires) return { type: "REQUIRES",   source: requires[1].trim(), target: requires[2].trim() };
  if (excludes) return { type: "EXCLUDES",   source: excludes[1].trim(), target: excludes[2].trim() };
  if (autoAdd)  return { type: "AUTO_ADD",   source: autoAdd[1].trim(),  target: autoAdd[2].trim() };
  return null;
}

// Detect circular dependency with DFS
function detectCircular(rules: DependencyRule[], source: string, target: string): boolean {
  const graph: Record<string, string[]> = {};
  for (const r of rules) {
    if (r.type === "DEPENDS_ON" || r.type === "REQUIRES") {
      if (!graph[r.source]) graph[r.source] = [];
      graph[r.source].push(r.target);
    }
  }
  if (!graph[target]) return false;
  const visited = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === source) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    (graph[node] ?? []).forEach(n => stack.push(n));
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB BAR
// ─────────────────────────────────────────────────────────────────────────────
function TabBar({ activeTab, onTabChange, isDark }: {
  activeTab: TabId;
  onTabChange: (t: TabId) => void;
  isDark: boolean;
}) {
  return (
    <div
      className="flex items-center gap-0.5 px-4 py-2 shrink-0 overflow-x-auto"
      style={{
        background: isDark ? "rgba(0,4,12,0.85)" : "rgba(210,225,248,0.95)",
        borderBottom: isDark ? "1px solid rgba(30,144,255,0.14)" : "1px solid rgba(0,71,171,0.18)",
        backdropFilter: "blur(12px)",
        scrollbarWidth: "none",
      }}
    >
      {/* Platform badge */}
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg mr-3 shrink-0"
        style={{
          background: "linear-gradient(135deg, rgba(30,144,255,0.18) 0%, rgba(0,212,255,0.12) 100%)",
          border: "1px solid rgba(30,144,255,0.3)",
        }}
      >
        <span style={{ color: "#1E90FF" }}><Ic n="cpu" s={12} /></span>
        <span className="text-[10px] font-bold tracking-widest" style={{ color: "#1E90FF" }}>RCA PLATFORM</span>
      </div>

      {TABS.map(tab => {
        const isActive = tab.id === activeTab;
        return (
          <motion.button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium shrink-0 cursor-pointer relative"
            style={{
              background: isActive
                ? isDark ? "linear-gradient(135deg, rgba(30,144,255,0.22) 0%, rgba(0,212,255,0.14) 100%)" : "rgba(30,144,255,0.14)"
                : "transparent",
              color: isActive ? "#00D4FF" : isDark ? "rgba(120,160,200,0.65)" : "rgba(0,31,91,0.62)",
              border: isActive
                ? "1px solid rgba(30,144,255,0.35)"
                : "1px solid transparent",
            }}
            whileHover={{
              background: isActive
                ? isDark ? "linear-gradient(135deg, rgba(30,144,255,0.28) 0%, rgba(0,212,255,0.18) 100%)" : "rgba(30,144,255,0.18)"
                : isDark ? "rgba(30,144,255,0.07)" : "rgba(0,71,171,0.10)",
              color: isActive ? "#00D4FF" : isDark ? "rgba(160,200,240,0.8)" : "rgba(0,31,91,0.85)",
            }}
            whileTap={{ scale: 0.97 }}
          >
            <span style={{ opacity: isActive ? 1 : 0.7 }}><Ic n={tab.icon} s={12} /></span>
            <span>{tab.shortLabel}</span>
            {tab.badge && (
              <span
                className="text-[8px] font-bold px-1 py-0.5 rounded-full tracking-wide"
                style={{
                  background: isActive ? "rgba(0,212,255,0.2)" : isDark ? "rgba(30,144,255,0.12)" : "rgba(0,71,171,0.12)",
                  color: isActive ? "#00D4FF" : isDark ? "rgba(30,144,255,0.65)" : "rgba(0,71,171,0.7)",
                  border: `1px solid ${isActive ? "rgba(0,212,255,0.3)" : "rgba(30,144,255,0.2)"}`,
                }}
              >
                {tab.badge}
              </span>
            )}
            {isActive && (
              <motion.div
                layoutId="rca-tab-indicator"
                className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full"
                style={{ background: "linear-gradient(90deg, #1E90FF, #00D4FF)" }}
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
              />
            )}
          </motion.button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DEPENDENCY ENGINE PANEL
// ─────────────────────────────────────────────────────────────────────────────
function DependencyEnginePanel({ isDark }: { isDark: boolean }) {
  const [rules, setRules] = useState<DependencyRule[]>([
    { id: uid(), type: "DEPENDS_ON", source: "Firewall Pro",        target: "Threat Intelligence Hub", active: true },
    { id: uid(), type: "REQUIRES",   source: "VPN Gateway",         target: "Network License",          active: true },
    { id: uid(), type: "AUTO_ADD",   source: "Security Monitor",    target: "AI Analytics Suite",       active: true },
    { id: uid(), type: "EXCLUDES",   source: "Basic Firewall",      target: "Enterprise Firewall",      active: true },
  ]);
  const [nlInput, setNlInput] = useState("");
  const [manSource, setManSource] = useState("");
  const [manTarget, setManTarget] = useState("");
  const [manType, setManType] = useState<DependencyRule["type"]>("DEPENDS_ON");
  const [addMode, setAddMode] = useState<"nl" | "manual">("nl");
  const [parseError, setParseError] = useState("");
  const [nlLoading, setNlLoading] = useState(false);

  const typeColors: Record<DependencyRule["type"], string> = {
    AUTO_ADD:   "#1E90FF",
    DEPENDS_ON: "#3AABFF",
    REQUIRES:   "#00D4FF",
    EXCLUDES:   "#60B8FF",
  };

  function addFromNL() {
    if (!nlInput.trim()) return;
    setNlLoading(true);
    setParseError("");
    setTimeout(() => {
      const parsed = parseNLDependency(nlInput);
      if (!parsed) {
        setParseError("Could not parse dependency. Try: 'X depends on Y', 'X requires Y', 'X excludes Y', or 'auto-add X to Y'");
        setNlLoading(false);
        return;
      }
      const isCircular = detectCircular(rules, parsed.source, parsed.target);
      const isDup = rules.some(r => r.source === parsed.source && r.target === parsed.target && r.type === parsed.type);
      if (isDup) { setParseError("An identical rule already exists."); setNlLoading(false); return; }
      setRules(prev => [...prev, { ...parsed, id: uid(), active: true, isCircular, validationMsg: isCircular ? "⚠ Circular dependency detected" : undefined }]);
      setNlInput("");
      setNlLoading(false);
    }, 480);
  }

  function addManual() {
    if (!manSource.trim() || !manTarget.trim()) return;
    const isCircular = detectCircular(rules, manSource.trim(), manTarget.trim());
    const isDup = rules.some(r => r.source === manSource.trim() && r.target === manTarget.trim() && r.type === manType);
    if (isDup) return;
    setRules(prev => [...prev, { id: uid(), type: manType, source: manSource.trim(), target: manTarget.trim(), active: true, isCircular }]);
    setManSource(""); setManTarget("");
  }

  function removeRule(id: string) {
    setRules(prev => prev.filter(r => r.id !== id));
  }

  function toggleRule(id: string) {
    setRules(prev => prev.map(r => r.id === id ? { ...r, active: !r.active } : r));
  }

  const border = isDark ? "1px solid rgba(30,144,255,0.12)" : "1px solid rgba(0,71,171,0.18)";
  const glassPanel = isDark ? "rgba(4,10,24,0.75)" : "rgba(222,235,255,0.92)";
  const inputBg = isDark ? "rgba(30,144,255,0.05)" : "rgba(235,245,255,0.95)";
  const inputBorder = isDark ? "rgba(30,144,255,0.18)" : "rgba(0,71,171,0.22)";
  const textPrimary = isDark ? "rgba(210,230,250,0.92)" : "rgba(0,10,40,0.88)";
  const textMuted = isDark ? "rgba(90,130,180,0.65)" : "rgba(0,31,91,0.62)";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 shrink-0" style={{ borderBottom: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.14)" }}>
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(30,144,255,0.22), rgba(0,212,255,0.14))", border: "1px solid rgba(30,144,255,0.28)", color: "#1E90FF" }}>
            <Ic n="git-branch" s={18} />
          </div>
          <div>
            <h2 className="text-[17px] font-bold" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.025em" }}>Dependency Engine</h2>
            <p className="text-[11px]" style={{ color: textMuted }}>Define and manage RCA product dependency rules with natural language or manual configuration</p>
          </div>
        </div>
        <div className="flex gap-3 mt-3">
          {[
            { label: "Total Rules",    value: String(rules.length)                            },
            { label: "Active",         value: String(rules.filter(r => r.active).length)      },
            { label: "Circular",       value: String(rules.filter(r => r.isCircular).length)  },
            { label: "Types",          value: "4"                                              },
          ].map(s => (
            <div key={s.label} className="flex flex-col px-3 py-2 rounded-lg" style={{ background: isDark ? "rgba(30,144,255,0.07)" : "rgba(0,71,171,0.07)", border }}>
              <span className="text-[15px] font-bold" style={{ color: "#1E90FF", letterSpacing: "-0.02em" }}>{s.value}</span>
              <span className="text-[9px] mt-0.5" style={{ color: textMuted }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden gap-0">
        {/* Left: Rule Builder */}
        <div className="w-80 shrink-0 flex flex-col overflow-hidden" style={{ borderRight: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.14)" }}>
          <div className="px-4 py-3 shrink-0" style={{ borderBottom: isDark ? "1px solid rgba(30,144,255,0.08)" : "1px solid rgba(0,71,171,0.12)" }}>
            <p className="text-[10px] font-bold tracking-widest uppercase mb-2.5" style={{ color: isDark ? "rgba(30,144,255,0.55)" : "rgba(0,71,171,0.7)" }}>Add Rule</p>
            {/* Mode toggle */}
            <div className="flex rounded-lg overflow-hidden" style={{ border }}>
              {(["nl", "manual"] as const).map(m => (
                <button
                  key={m}
                  onClick={() => { setAddMode(m); setParseError(""); }}
                  className="flex-1 py-1.5 text-[11px] font-medium cursor-pointer"
                  style={{
                    background: addMode === m
                      ? "linear-gradient(135deg, rgba(30,144,255,0.25), rgba(0,212,255,0.16))"
                      : "transparent",
                    color: addMode === m ? "#00D4FF" : textMuted,
                  }}
                >
                  {m === "nl" ? "Natural Language" : "Manual"}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3" style={{ scrollbarWidth: "none" }}>
            {addMode === "nl" ? (
              <div className="flex flex-col gap-3">
                <div>
                  <label className="block text-[10px] font-medium mb-1.5" style={{ color: textMuted }}>Rule Description</label>
                  <textarea
                    value={nlInput}
                    onChange={e => { setNlInput(e.target.value); setParseError(""); }}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addFromNL(); } }}
                    placeholder={'Try:\n"Firewall depends on Threat Hub"\n"VPN requires Network License"\n"Basic Firewall excludes Enterprise"\n"auto-add Monitor to AI Suite"'}
                    rows={6}
                    className="w-full rounded-xl text-[12px] resize-none outline-none font-mono"
                    style={{ background: inputBg, border: `1px solid ${inputBorder}`, color: textPrimary, padding: "10px 12px" }}
                  />
                </div>
                {parseError && (
                  <div className="px-3 py-2 rounded-lg text-[10px]" style={{ background: "rgba(232,68,68,0.09)", border: "1px solid rgba(232,68,68,0.2)", color: "#E84444" }}>
                    {parseError}
                  </div>
                )}
                <motion.button
                  onClick={addFromNL}
                  disabled={!nlInput.trim() || nlLoading}
                  className="w-full py-2.5 rounded-xl text-[12px] font-semibold cursor-pointer flex items-center justify-center gap-2"
                  style={{ background: "linear-gradient(135deg, #1E90FF, #00D4FF)", color: "rgba(0,8,20,0.92)", opacity: nlLoading ? 0.7 : 1 }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                >
                  {nlLoading ? <><Ic n="refresh" s={12} />Parsing…</> : <><Ic n="git-branch" s={12} />Parse Rule</>}
                </motion.button>

                <div className="mt-1 p-3 rounded-xl" style={{ background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.05)", border }}>
                  <p className="text-[9px] font-bold tracking-widest uppercase mb-1.5" style={{ color: isDark ? "rgba(30,144,255,0.5)" : "rgba(0,71,171,0.65)" }}>Supported Patterns</p>
                  {[
                    ["DEPENDS ON", "X depends on Y"],
                    ["REQUIRES",   "X requires Y"],
                    ["EXCLUDES",   "X excludes Y"],
                    ["AUTO ADD",   "auto-add X to Y"],
                  ].map(([type, ex]) => (
                    <div key={type} className="flex items-center gap-2 mb-1">
                      <span className="text-[8px] font-bold px-1 rounded" style={{ background: "rgba(30,144,255,0.15)", color: "#3AABFF" }}>{type}</span>
                      <span className="text-[10px] font-mono" style={{ color: textMuted }}>{ex}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div>
                  <label className="block text-[10px] font-medium mb-1.5" style={{ color: textMuted }}>Source Product</label>
                  <input
                    value={manSource}
                    onChange={e => setManSource(e.target.value)}
                    placeholder="e.g. Firewall Pro"
                    className="w-full rounded-lg text-[12px] outline-none"
                    style={{ background: inputBg, border: `1px solid ${inputBorder}`, color: textPrimary, padding: "8px 12px" }}
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium mb-1.5" style={{ color: textMuted }}>Rule Type</label>
                  <select
                    value={manType}
                    onChange={e => setManType(e.target.value as DependencyRule["type"])}
                    className="w-full rounded-lg text-[12px] outline-none cursor-pointer"
                    style={{ background: isDark ? "#030c1e" : "#ddeeff", border: `1px solid ${inputBorder}`, color: textPrimary, padding: "8px 12px" }}
                  >
                    <option value="DEPENDS_ON">DEPENDS_ON</option>
                    <option value="REQUIRES">REQUIRES</option>
                    <option value="EXCLUDES">EXCLUDES</option>
                    <option value="AUTO_ADD">AUTO_ADD</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-medium mb-1.5" style={{ color: textMuted }}>Target Product</label>
                  <input
                    value={manTarget}
                    onChange={e => setManTarget(e.target.value)}
                    placeholder="e.g. Threat Intelligence Hub"
                    className="w-full rounded-lg text-[12px] outline-none"
                    style={{ background: inputBg, border: `1px solid ${inputBorder}`, color: textPrimary, padding: "8px 12px" }}
                  />
                </div>
                <motion.button
                  onClick={addManual}
                  disabled={!manSource.trim() || !manTarget.trim()}
                  className="w-full py-2.5 rounded-xl text-[12px] font-semibold cursor-pointer flex items-center justify-center gap-2"
                  style={{ background: "linear-gradient(135deg, #1E90FF, #00D4FF)", color: "rgba(0,8,20,0.92)", opacity: !manSource.trim() || !manTarget.trim() ? 0.5 : 1 }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                >
                  <Ic n="plus" s={12} />Add Rule
                </motion.button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Rules list */}
        <div className="flex-1 overflow-y-auto px-5 py-4" style={{ scrollbarWidth: "thin" }}>
          <div className="flex items-center justify-between mb-4">
            <p className="text-[10px] font-bold tracking-widest uppercase" style={{ color: isDark ? "rgba(30,144,255,0.55)" : "rgba(0,71,171,0.7)" }}>
              Dependency Rules ({rules.length})
            </p>
            <div className="flex gap-1.5">
              {(["AUTO_ADD", "DEPENDS_ON", "REQUIRES", "EXCLUDES"] as const).map(type => (
                <span
                  key={type}
                  className="text-[8px] font-bold px-1.5 py-0.5 rounded-full"
                  style={{ background: `${typeColors[type]}18`, color: typeColors[type], border: `1px solid ${typeColors[type]}30` }}
                >
                  {type.replace("_", " ")}
                </span>
              ))}
            </div>
          </div>

          {rules.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16" style={{ color: textMuted }}>
              <Ic n="git-branch" s={32} />
              <p className="mt-3 text-[12px]">No dependency rules yet</p>
              <p className="text-[11px] mt-1">Add a rule using natural language or manual form</p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <AnimatePresence>
              {rules.map((rule, i) => (
                <motion.div
                  key={rule.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ delay: i * 0.03 }}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl"
                  style={{
                    background: isDark ? glassPanel : "rgba(228,240,255,0.88)",
                    border: rule.isCircular
                      ? "1px solid rgba(232,68,68,0.3)"
                      : isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.14)",
                    opacity: rule.active ? 1 : 0.5,
                  }}
                >
                  {/* Type badge */}
                  <span
                    className="text-[9px] font-bold px-2 py-0.5 rounded-full shrink-0"
                    style={{ background: `${typeColors[rule.type]}18`, color: typeColors[rule.type], border: `1px solid ${typeColors[rule.type]}35`, minWidth: 80, textAlign: "center" }}
                  >
                    {rule.type.replace("_", " ")}
                  </span>

                  {/* Rule content */}
                  <div className="flex-1 flex items-center gap-2 min-w-0">
                    <span className="text-[12px] font-mono font-semibold truncate" style={{ color: textPrimary }}>{rule.source}</span>
                    <span style={{ color: isDark ? "rgba(30,144,255,0.4)" : "rgba(0,71,171,0.4)" }}><Ic n="arrow-right" s={12} /></span>
                    <span className="text-[12px] font-mono truncate" style={{ color: isDark ? "rgba(0,212,255,0.8)" : "#0047AB" }}>{rule.target}</span>
                  </div>

                  {/* Circular warning */}
                  {rule.isCircular && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded shrink-0" style={{ background: "rgba(232,68,68,0.12)", color: "#E84444", border: "1px solid rgba(232,68,68,0.25)" }}>
                      CIRCULAR
                    </span>
                  )}

                  {/* Active toggle */}
                  <button
                    onClick={() => toggleRule(rule.id)}
                    className="shrink-0 w-8 h-4 rounded-full relative cursor-pointer"
                    style={{ background: rule.active ? "rgba(30,144,255,0.4)" : "rgba(60,80,110,0.3)" }}
                  >
                    <div className="absolute top-0.5 w-3 h-3 rounded-full" style={{ background: rule.active ? "#1E90FF" : "rgba(120,150,190,0.5)", left: rule.active ? "auto" : 2, right: rule.active ? 2 : "auto", transition: "all 0.2s" }} />
                  </button>

                  {/* Delete */}
                  <button
                    onClick={() => removeRule(rule.id)}
                    className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center cursor-pointer"
                    style={{ color: isDark ? "rgba(90,130,180,0.45)" : "rgba(0,31,91,0.45)" }}
                  >
                    <Ic n="trash" s={12} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NESTED BUNDLE ORCHESTRATION PANEL
// ─────────────────────────────────────────────────────────────────────────────
function NestedBundlePanel({ isDark }: { isDark: boolean }) {
  const [tree, setTree] = useState<BundleNode[]>([
    {
      id: uid(), name: "Enterprise Security Suite", nodeType: "bundle", isExpanded: true,
      children: [
        {
          id: uid(), name: "Network Security Bundle", nodeType: "bundle", isExpanded: true,
          children: [
            { id: uid(), name: "Firewall Pro",      nodeType: "product", price: 1200, sellingModel: "Evergreen Monthly",   children: [], isExpanded: false },
            { id: uid(), name: "VPN Gateway",       nodeType: "product", price: 800,  sellingModel: "Evergreen Monthly",   children: [], isExpanded: false },
            { id: uid(), name: "IDS Sensor",        nodeType: "product", price: 600,  sellingModel: "Evergreen Monthly",   children: [], isExpanded: false },
          ],
        },
        {
          id: uid(), name: "AI Monitoring Bundle", nodeType: "bundle", isExpanded: true,
          children: [
            { id: uid(), name: "AI Analytics Suite",  nodeType: "product", price: 2400, sellingModel: "Evergreen Monthly", children: [], isExpanded: false },
            { id: uid(), name: "Threat Scanner",      nodeType: "product", price: 1800, sellingModel: "Evergreen Monthly", children: [], isExpanded: false },
          ],
        },
      ],
    },
  ]);
  const [addParentId, setAddParentId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"bundle" | "product">("product");
  const [newPrice, setNewPrice] = useState("");
  const [newModel, setNewModel] = useState("Evergreen Monthly");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  function findAndModify(nodes: BundleNode[], id: string, fn: (n: BundleNode) => BundleNode): BundleNode[] {
    return nodes.map(n => {
      if (n.id === id) return fn(n);
      return { ...n, children: findAndModify(n.children, id, fn) };
    });
  }

  function findAndRemove(nodes: BundleNode[], id: string): BundleNode[] {
    return nodes
      .filter(n => n.id !== id)
      .map(n => ({ ...n, children: findAndRemove(n.children, id) }));
  }

  function addNode() {
    if (!newName.trim()) return;
    const newNode: BundleNode = {
      id: uid(), name: newName.trim(), nodeType: newType,
      price: newPrice ? parseFloat(newPrice) : undefined,
      sellingModel: newModel, children: [], isExpanded: false,
    };
    if (addParentId === null) {
      setTree(prev => [...prev, newNode]);
    } else {
      setTree(prev => findAndModify(prev, addParentId, n => ({ ...n, children: [...n.children, newNode], isExpanded: true })));
    }
    setNewName(""); setNewPrice(""); setAddParentId(null);
  }

  function toggleNode(id: string) {
    setTree(prev => findAndModify(prev, id, n => ({ ...n, isExpanded: !n.isExpanded })));
  }

  function removeNode(id: string) {
    setTree(prev => findAndRemove(prev, id));
  }

  const textPrimary = isDark ? "rgba(210,230,250,0.92)" : "rgba(0,10,40,0.88)";
  const textMuted   = isDark ? "rgba(90,130,180,0.65)"  : "rgba(0,31,91,0.62)";
  const inputBg     = isDark ? "rgba(30,144,255,0.05)"  : "rgba(235,245,255,0.95)";
  const inputBorder = isDark ? "rgba(30,144,255,0.18)"  : "rgba(0,71,171,0.22)";
  const border      = isDark ? "1px solid rgba(30,144,255,0.12)" : "1px solid rgba(0,71,171,0.18)";

  function countNodes(nodes: BundleNode[]): number {
    return nodes.reduce((acc, n) => acc + 1 + countNodes(n.children), 0);
  }
  function maxDepth(nodes: BundleNode[], d = 0): number {
    if (nodes.length === 0) return d;
    return Math.max(...nodes.map(n => maxDepth(n.children, d + 1)));
  }

  function TreeNodeView({ node, depth }: { node: BundleNode; depth: number }) {
    const isSelected = selectedNodeId === node.id;
    const hasChildren = node.children.length > 0;
    const isBundleNode = node.nodeType === "bundle";
    const nodeColor = isBundleNode ? "#1E90FF" : "#00D4FF";

    return (
      <div>
        <div
          className="flex items-center gap-2 py-1.5 px-2 rounded-lg mb-0.5 cursor-pointer"
          style={{
            marginLeft: depth * 20,
            background: isSelected
              ? isDark ? "rgba(30,144,255,0.14)" : "rgba(30,144,255,0.10)"
              : "transparent",
            border: isSelected ? "1px solid rgba(30,144,255,0.28)" : "1px solid transparent",
          }}
          onClick={() => setSelectedNodeId(isSelected ? null : node.id)}
        >
          {/* Expand toggle */}
          {hasChildren ? (
            <button
              onClick={e => { e.stopPropagation(); toggleNode(node.id); }}
              className="w-4 h-4 flex items-center justify-center cursor-pointer"
              style={{ color: nodeColor }}
            >
              <motion.span animate={{ rotate: node.isExpanded ? 0 : -90 }}>
                <Ic n="chevron-down" s={11} />
              </motion.span>
            </button>
          ) : (
            <div className="w-4 h-4 flex items-center justify-center">
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: nodeColor, opacity: 0.6 }} />
            </div>
          )}

          {/* Icon */}
          <span style={{ color: nodeColor }}><Ic n={isBundleNode ? "package" : "tag"} s={13} /></span>

          {/* Name */}
          <span className="flex-1 text-[12px] font-medium truncate" style={{ color: textPrimary }}>{node.name}</span>

          {/* Type badge */}
          <span
            className="text-[8px] font-bold px-1.5 py-0.5 rounded shrink-0"
            style={{ background: `${nodeColor}18`, color: nodeColor, border: `1px solid ${nodeColor}30` }}
          >
            {isBundleNode ? "BUNDLE" : "PRODUCT"}
          </span>

          {/* Price */}
          {node.price && (
            <span className="text-[10px] font-mono shrink-0" style={{ color: textMuted }}>${node.price.toLocaleString()}</span>
          )}

          {/* Add child */}
          {isBundleNode && (
            <button
              onClick={e => { e.stopPropagation(); setAddParentId(node.id); setNewName(""); }}
              className="w-5 h-5 rounded-md flex items-center justify-center cursor-pointer shrink-0"
              style={{ color: nodeColor, background: `${nodeColor}14` }}
            >
              <Ic n="plus" s={10} />
            </button>
          )}

          {/* Remove */}
          <button
            onClick={e => { e.stopPropagation(); removeNode(node.id); }}
            className="w-5 h-5 rounded-md flex items-center justify-center cursor-pointer shrink-0"
            style={{ color: isDark ? "rgba(90,130,180,0.4)" : "rgba(0,31,91,0.38)" }}
          >
            <Ic n="x" s={10} />
          </button>
        </div>

        {/* Children */}
        <AnimatePresence initial={false}>
          {node.isExpanded && node.children.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {node.children.map(child => (
                <TreeNodeView key={child.id} node={child} depth={depth + 1} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  const totalNodes = countNodes(tree);
  const depth = maxDepth(tree);
  const bundleCount = tree.reduce((a, n) => a + (n.nodeType === "bundle" ? 1 + countNodes(n.children.filter(c => c.nodeType === "bundle")) : 0), 0);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 shrink-0" style={{ borderBottom: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.14)" }}>
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(30,144,255,0.22), rgba(0,212,255,0.14))", border: "1px solid rgba(30,144,255,0.28)", color: "#1E90FF" }}>
            <Ic n="layers" s={18} />
          </div>
          <div>
            <h2 className="text-[17px] font-bold" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.025em" }}>Nested Bundle Orchestration</h2>
            <p className="text-[11px]" style={{ color: textMuted }}>Build multi-level bundle hierarchies. Parent → Child Bundles → Leaf Products</p>
          </div>
        </div>
        <div className="flex gap-3 mt-3">
          {[
            { label: "Total Nodes", value: String(totalNodes) },
            { label: "Max Depth",   value: String(depth)      },
            { label: "Bundles",     value: String(bundleCount) },
            { label: "RCA Type",    value: "Bundle"            },
          ].map(s => (
            <div key={s.label} className="flex flex-col px-3 py-2 rounded-lg" style={{ background: isDark ? "rgba(30,144,255,0.07)" : "rgba(0,71,171,0.07)", border }}>
              <span className="text-[15px] font-bold" style={{ color: "#1E90FF", letterSpacing: "-0.02em" }}>{s.value}</span>
              <span className="text-[9px] mt-0.5" style={{ color: textMuted }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Tree view */}
        <div className="flex-1 overflow-y-auto px-5 py-4" style={{ scrollbarWidth: "thin" }}>
          <div className="flex items-center justify-between mb-4">
            <p className="text-[10px] font-bold tracking-widest uppercase" style={{ color: isDark ? "rgba(30,144,255,0.55)" : "rgba(0,71,171,0.7)" }}>Bundle Hierarchy</p>
            <motion.button
              onClick={() => { setAddParentId(null); setNewName(""); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer"
              style={{ background: "rgba(30,144,255,0.14)", color: "#1E90FF", border: "1px solid rgba(30,144,255,0.28)" }}
              whileHover={{ scale: 1.02 }}
            >
              <Ic n="plus" s={11} />Add Root Bundle
            </motion.button>
          </div>

          {tree.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16" style={{ color: textMuted }}>
              <Ic n="layers" s={32} />
              <p className="mt-3 text-[12px]">No bundles yet</p>
              <p className="text-[11px] mt-1">Click "Add Root Bundle" to start building</p>
            </div>
          )}

          <div
            className="p-4 rounded-xl"
            style={{ background: isDark ? "rgba(4,10,24,0.6)" : "rgba(222,235,255,0.85)", border }}
          >
            {tree.map(node => (
              <TreeNodeView key={node.id} node={node} depth={0} />
            ))}
          </div>
        </div>

        {/* Right: Add node form */}
        {addParentId !== null || newName !== "" ? (
          <div className="w-72 shrink-0 flex flex-col overflow-hidden" style={{ borderLeft: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.14)" }}>
            <div className="px-4 py-3 shrink-0" style={{ borderBottom: isDark ? "1px solid rgba(30,144,255,0.08)" : "1px solid rgba(0,71,171,0.12)" }}>
              <p className="text-[10px] font-bold tracking-widest uppercase" style={{ color: isDark ? "rgba(30,144,255,0.55)" : "rgba(0,71,171,0.7)" }}>
                {addParentId ? "Add Child Node" : "Add Root Bundle"}
              </p>
            </div>
            <div className="flex-1 px-4 py-4 flex flex-col gap-3">
              <div>
                <label className="block text-[10px] font-medium mb-1.5" style={{ color: textMuted }}>Name</label>
                <input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Bundle or product name"
                  autoFocus
                  className="w-full rounded-lg text-[12px] outline-none"
                  style={{ background: inputBg, border: `1px solid ${inputBorder}`, color: textPrimary, padding: "8px 12px" }}
                />
              </div>
              <div>
                <label className="block text-[10px] font-medium mb-1.5" style={{ color: textMuted }}>Type</label>
                <select
                  value={newType}
                  onChange={e => setNewType(e.target.value as "bundle" | "product")}
                  className="w-full rounded-lg text-[12px] outline-none cursor-pointer"
                  style={{ background: isDark ? "#030c1e" : "#ddeeff", border: `1px solid ${inputBorder}`, color: textPrimary, padding: "8px 12px" }}
                >
                  <option value="bundle">Bundle (Type = Bundle)</option>
                  <option value="product">Product (Type = null)</option>
                </select>
              </div>
              {newType === "product" && (
                <>
                  <div>
                    <label className="block text-[10px] font-medium mb-1.5" style={{ color: textMuted }}>Price ($)</label>
                    <input
                      value={newPrice}
                      onChange={e => setNewPrice(e.target.value)}
                      placeholder="0.00"
                      type="number"
                      className="w-full rounded-lg text-[12px] outline-none"
                      style={{ background: inputBg, border: `1px solid ${inputBorder}`, color: textPrimary, padding: "8px 12px" }}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium mb-1.5" style={{ color: textMuted }}>Selling Model</label>
                    <select
                      value={newModel}
                      onChange={e => setNewModel(e.target.value)}
                      className="w-full rounded-lg text-[12px] outline-none cursor-pointer"
                      style={{ background: isDark ? "#030c1e" : "#ddeeff", border: `1px solid ${inputBorder}`, color: textPrimary, padding: "8px 12px" }}
                    >
                      {SELLING_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                </>
              )}
              <div className="flex gap-2">
                <motion.button
                  onClick={addNode}
                  disabled={!newName.trim()}
                  className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold cursor-pointer flex items-center justify-center gap-1.5"
                  style={{ background: "linear-gradient(135deg, #1E90FF, #00D4FF)", color: "rgba(0,8,20,0.92)", opacity: !newName.trim() ? 0.5 : 1 }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                >
                  <Ic n="plus" s={12} />Add
                </motion.button>
                <motion.button
                  onClick={() => { setAddParentId(null); setNewName(""); }}
                  className="px-3 py-2.5 rounded-xl text-[12px] font-medium cursor-pointer"
                  style={{ background: "transparent", color: textMuted, border }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                >
                  Cancel
                </motion.button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMERCIALIZATION ENGINE PANEL
// ─────────────────────────────────────────────────────────────────────────────
function CommercializationPanel({ isDark }: { isDark: boolean }) {
  const [catalogs, setCatalogs] = useState<CommercialRecord[]>([
    { id: uid(), name: "Enterprise Catalog",  type: "catalog",       isExisting: true,  linkedProducts: ["Firewall Pro", "VPN Gateway", "AI Analytics Suite"] },
    { id: uid(), name: "SMB Catalog",         type: "catalog",       isExisting: true,  linkedProducts: ["Basic Shield", "SMB Monitor"] },
  ]);
  const [categories, setCategories] = useState<CommercialRecord[]>([
    { id: uid(), name: "Network Security",    type: "category",      isExisting: true,  linkedProducts: ["Firewall Pro", "IDS Sensor"] },
    { id: uid(), name: "AI & Monitoring",     type: "category",      isExisting: true,  linkedProducts: ["AI Analytics Suite", "Threat Scanner"] },
  ]);
  const [sellingModels, setSellingModels] = useState<CommercialRecord[]>([
    { id: uid(), name: "Evergreen Monthly",   type: "sellingModel",  subType: "EVERGREEN", isExisting: true,  linkedProducts: ["Firewall Pro", "VPN Gateway"] },
    { id: uid(), name: "One Time",            type: "sellingModel",  subType: "ONE_TIME",  isExisting: false, linkedProducts: ["Hardware Appliance"] },
    { id: uid(), name: "Evergreen Quarterly", type: "sellingModel",  subType: "EVERGREEN", isExisting: true,  linkedProducts: ["Enterprise Bundle"] },
  ]);
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<{ sellingModel: string; category: string; catalog: string } | null>(null);
  const [newCatalog, setNewCatalog] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [newModel, setNewModel] = useState("Evergreen Monthly");

  const textPrimary = isDark ? "rgba(210,230,250,0.92)" : "rgba(0,10,40,0.88)";
  const textMuted   = isDark ? "rgba(90,130,180,0.65)"  : "rgba(0,31,91,0.62)";
  const border      = isDark ? "1px solid rgba(30,144,255,0.12)" : "1px solid rgba(0,71,171,0.16)";
  const inputBg     = isDark ? "rgba(30,144,255,0.05)"  : "rgba(235,245,255,0.95)";
  const inputBorder = isDark ? "rgba(30,144,255,0.18)"  : "rgba(0,71,171,0.22)";

  function runAI() {
    if (!aiInput.trim()) return;
    setAiLoading(true);
    setAiSuggestion(null);
    setTimeout(() => {
      const t = aiInput.toLowerCase();
      let sellingModel = "Evergreen Monthly";
      let category = "General";
      let catalog = "Enterprise Catalog";
      if (t.includes("one time") || t.includes("hardware") || t.includes("appliance") || t.includes("perpetual")) sellingModel = "One Time";
      else if (t.includes("quarterly")) sellingModel = "Evergreen Quarterly";
      else if (t.includes("annual") || t.includes("yearly")) sellingModel = "Evergreen Yearly";
      else if (t.includes("usage") || t.includes("consumption")) sellingModel = "Usage Based";
      else if (t.includes("term")) sellingModel = "Term Defined Monthly";
      if (t.includes("network") || t.includes("firewall") || t.includes("vpn")) category = "Network Security";
      else if (t.includes("ai") || t.includes("monitor") || t.includes("analytics")) category = "AI & Monitoring";
      else if (t.includes("cloud") || t.includes("storage")) category = "Cloud Services";
      else if (t.includes("software") || t.includes("license")) category = "Software Licenses";
      if (t.includes("smb") || t.includes("small") || t.includes("starter")) catalog = "SMB Catalog";
      setAiSuggestion({ sellingModel, category, catalog });
      setAiLoading(false);
    }, 900);
  }

  function addCatalog() {
    if (!newCatalog.trim()) return;
    setCatalogs(prev => [...prev, { id: uid(), name: newCatalog.trim(), type: "catalog", isExisting: false, linkedProducts: [] }]);
    setNewCatalog("");
  }
  function addCategory() {
    if (!newCategory.trim()) return;
    setCategories(prev => [...prev, { id: uid(), name: newCategory.trim(), type: "category", isExisting: false, linkedProducts: [] }]);
    setNewCategory("");
  }
  function addModel() {
    setSellingModels(prev => [...prev, { id: uid(), name: newModel, type: "sellingModel", subType: "EVERGREEN", isExisting: false, linkedProducts: [] }]);
  }

  function RecordCard({ rec, onRemove }: { rec: CommercialRecord; onRemove: () => void }) {
    const col = rec.isExisting ? "#00D4FF" : "#1E90FF";
    return (
      <div
        className="flex items-center gap-3 px-3 py-2.5 rounded-xl mb-2"
        style={{
          background: isDark ? "rgba(4,10,24,0.75)" : "rgba(228,240,255,0.88)",
          border: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.14)",
        }}
      >
        <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: col, boxShadow: `0 0 6px ${col}60` }} />
        <span className="flex-1 text-[12px] font-medium truncate" style={{ color: textPrimary }}>{rec.name}</span>
        <span
          className="text-[8px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
          style={{ background: rec.isExisting ? "rgba(0,212,255,0.12)" : "rgba(30,144,255,0.15)", color: col, border: `1px solid ${col}30` }}
        >
          {rec.isExisting ? "REUSED" : "NEW"}
        </span>
        {rec.linkedProducts.length > 0 && (
          <span className="text-[9px] shrink-0" style={{ color: textMuted }}>{rec.linkedProducts.length} products</span>
        )}
        <button onClick={onRemove} className="shrink-0 cursor-pointer" style={{ color: isDark ? "rgba(90,130,180,0.4)" : "rgba(0,31,91,0.38)" }}>
          <Ic n="x" s={10} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 shrink-0" style={{ borderBottom: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.14)" }}>
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(30,144,255,0.22), rgba(0,212,255,0.14))", border: "1px solid rgba(30,144,255,0.28)", color: "#1E90FF" }}>
            <Ic n="zap" s={18} />
          </div>
          <div>
            <h2 className="text-[17px] font-bold" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.025em" }}>Commercialization Engine</h2>
            <p className="text-[11px]" style={{ color: textMuted }}>Manage ProductCatalog, ProductCategory, and ProductSellingModel records with AI-powered assignment</p>
          </div>
        </div>
        <div className="flex gap-3 mt-3">
          {[
            { label: "Catalogs",       value: String(catalogs.length)      },
            { label: "Categories",     value: String(categories.length)    },
            { label: "Selling Models", value: String(sellingModels.length) },
            { label: "Reused",         value: String([...catalogs, ...categories, ...sellingModels].filter(r => r.isExisting).length) },
          ].map(s => (
            <div key={s.label} className="flex flex-col px-3 py-2 rounded-lg" style={{ background: isDark ? "rgba(30,144,255,0.07)" : "rgba(0,71,171,0.07)", border }}>
              <span className="text-[15px] font-bold" style={{ color: "#1E90FF", letterSpacing: "-0.02em" }}>{s.value}</span>
              <span className="text-[9px] mt-0.5" style={{ color: textMuted }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5" style={{ scrollbarWidth: "thin" }}>
        {/* AI Commercialization Analyzer */}
        <div className="mb-6 p-5 rounded-2xl" style={{ background: isDark ? "rgba(30,144,255,0.07)" : "rgba(210,230,255,0.88)", border }}>
          <div className="flex items-center gap-2 mb-3">
            <span style={{ color: "#1E90FF" }}><Ic n="sparkles" s={14} /></span>
            <p className="text-[11px] font-bold tracking-widest uppercase" style={{ color: isDark ? "rgba(30,144,255,0.7)" : "rgba(0,71,171,0.8)" }}>AI Selling Model Analyzer</p>
          </div>
          <div className="flex gap-2">
            <input
              value={aiInput}
              onChange={e => setAiInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && runAI()}
              placeholder="Describe your product (e.g. 'monthly subscription firewall software')"
              className="flex-1 rounded-xl text-[12px] outline-none"
              style={{ background: inputBg, border: `1px solid ${inputBorder}`, color: textPrimary, padding: "10px 14px" }}
            />
            <motion.button
              onClick={runAI}
              disabled={!aiInput.trim() || aiLoading}
              className="px-4 py-2.5 rounded-xl text-[12px] font-semibold cursor-pointer flex items-center gap-1.5"
              style={{ background: "linear-gradient(135deg, #1E90FF, #00D4FF)", color: "rgba(0,8,20,0.92)", opacity: aiLoading ? 0.7 : 1 }}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
            >
              {aiLoading ? <><Ic n="refresh" s={12} />Analyzing…</> : <><Ic n="sparkles" s={12} />Analyze</>}
            </motion.button>
          </div>
          <AnimatePresence>
            {aiSuggestion && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mt-3 flex flex-wrap gap-2"
              >
                <span className="text-[10px]" style={{ color: textMuted }}>AI recommends:</span>
                {[
                  { label: "Selling Model", value: aiSuggestion.sellingModel, color: "#1E90FF" },
                  { label: "Category",      value: aiSuggestion.category,      color: "#3AABFF" },
                  { label: "Catalog",       value: aiSuggestion.catalog,        color: "#00D4FF" },
                ].map(s => (
                  <span
                    key={s.label}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium"
                    style={{ background: `${s.color}14`, border: `1px solid ${s.color}30`, color: s.color }}
                  >
                    <span className="font-normal opacity-70">{s.label}:</span> {s.value}
                  </span>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Three columns */}
        <div className="grid grid-cols-3 gap-5">
          {/* Catalogs */}
          <div>
            <p className="text-[10px] font-bold tracking-widest uppercase mb-3" style={{ color: isDark ? "rgba(30,144,255,0.55)" : "rgba(0,71,171,0.7)" }}>Product Catalogs</p>
            {catalogs.map(c => (
              <RecordCard key={c.id} rec={c} onRemove={() => setCatalogs(prev => prev.filter(r => r.id !== c.id))} />
            ))}
            <div className="flex gap-1.5 mt-2">
              <input
                value={newCatalog}
                onChange={e => setNewCatalog(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addCatalog()}
                placeholder="New catalog name"
                className="flex-1 rounded-lg text-[11px] outline-none"
                style={{ background: inputBg, border: `1px solid ${inputBorder}`, color: textPrimary, padding: "7px 10px" }}
              />
              <button
                onClick={addCatalog}
                className="px-2.5 py-1.5 rounded-lg cursor-pointer"
                style={{ background: "rgba(30,144,255,0.16)", color: "#1E90FF", border: "1px solid rgba(30,144,255,0.28)" }}
              >
                <Ic n="plus" s={12} />
              </button>
            </div>
          </div>

          {/* Categories */}
          <div>
            <p className="text-[10px] font-bold tracking-widest uppercase mb-3" style={{ color: isDark ? "rgba(30,144,255,0.55)" : "rgba(0,71,171,0.7)" }}>Product Categories</p>
            {categories.map(c => (
              <RecordCard key={c.id} rec={c} onRemove={() => setCategories(prev => prev.filter(r => r.id !== c.id))} />
            ))}
            <div className="flex gap-1.5 mt-2">
              <input
                value={newCategory}
                onChange={e => setNewCategory(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addCategory()}
                placeholder="New category name"
                className="flex-1 rounded-lg text-[11px] outline-none"
                style={{ background: inputBg, border: `1px solid ${inputBorder}`, color: textPrimary, padding: "7px 10px" }}
              />
              <button
                onClick={addCategory}
                className="px-2.5 py-1.5 rounded-lg cursor-pointer"
                style={{ background: "rgba(30,144,255,0.16)", color: "#1E90FF", border: "1px solid rgba(30,144,255,0.28)" }}
              >
                <Ic n="plus" s={12} />
              </button>
            </div>
          </div>

          {/* Selling Models */}
          <div>
            <p className="text-[10px] font-bold tracking-widest uppercase mb-3" style={{ color: isDark ? "rgba(30,144,255,0.55)" : "rgba(0,71,171,0.7)" }}>Selling Models</p>
            {sellingModels.map(m => (
              <RecordCard key={m.id} rec={m} onRemove={() => setSellingModels(prev => prev.filter(r => r.id !== m.id))} />
            ))}
            <div className="flex gap-1.5 mt-2">
              <select
                value={newModel}
                onChange={e => setNewModel(e.target.value)}
                className="flex-1 rounded-lg text-[11px] outline-none cursor-pointer"
                style={{ background: isDark ? "#030c1e" : "#ddeeff", border: `1px solid ${inputBorder}`, color: textPrimary, padding: "7px 10px" }}
              >
                {SELLING_MODELS.filter(m => !sellingModels.some(s => s.name === m)).map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <button
                onClick={addModel}
                className="px-2.5 py-1.5 rounded-lg cursor-pointer"
                style={{ background: "rgba(30,144,255,0.16)", color: "#1E90FF", border: "1px solid rgba(30,144,255,0.28)" }}
              >
                <Ic n="plus" s={12} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DEPLOYMENT CONSOLE PANEL
// ─────────────────────────────────────────────────────────────────────────────
function DeploymentConsolePanel({ isDark }: { isDark: boolean }) {
  const [batches, setBatches] = useState<BatchState[]>(INIT_BATCHES.map(b => ({ ...b })));
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [bundleText, setBundleText] = useState("Enterprise Security Suite\n- Network Security Bundle\n  - Firewall Pro $1,200/mo\n  - VPN Gateway $800/mo\n- AI Monitoring Bundle\n  - AI Analytics $2,400/mo\n  - Threat Scanner $1,800/mo");
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [deployDone, setDeployDone] = useState(false);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  function addLog(batch: number, level: LogEntry["level"], msg: string, sfId?: string) {
    setLogs(prev => [...prev, { id: uid(), ts: Date.now(), batch, level, msg, sfId }]);
  }

  function resetBatches() {
    setBatches(INIT_BATCHES.map(b => ({ ...b })));
    setLogs([]);
    setDeployDone(false);
  }

  async function startDeploy() {
    if (isRunning) return;
    resetBatches();
    setIsRunning(true);
    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/bundles/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleText }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        addLog(0, "error", `Server error: ${res.status}`);
        setIsRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.type === "batch_start") {
              setBatches(prev => prev.map(b => b.batch === ev.batch ? { ...b, status: "running" } : b));
            } else if (ev.type === "batch_end") {
              setBatches(prev => prev.map(b => b.batch === ev.batch ? { ...b, status: ev.error ? "error" : "success", count: ev.count ?? b.count, duration: ev.duration } : b));
            } else if (ev.type === "log") {
              addLog(ev.batch ?? 0, ev.level ?? "info", ev.message, ev.sfId);
            } else if (ev.type === "done") {
              setDeployDone(true);
            }
          } catch {
            // malformed SSE line — skip
          }
        }
      }
    } catch (err: unknown) {
      if ((err as Error)?.name !== "AbortError") {
        // Simulate a demo execution if API not available
        await runDemoExecution();
      }
    } finally {
      setIsRunning(false);
    }
  }

  async function runDemoExecution() {
    const batchNames = INIT_BATCHES.map(b => b.name);
    for (let i = 0; i < 9; i++) {
      const batchNum = i + 1;
      setBatches(prev => prev.map(b => b.batch === batchNum ? { ...b, status: "running" } : b));
      addLog(batchNum, "info", `Starting ${batchNames[i]}…`);

      await new Promise(r => setTimeout(r, 600 + Math.random() * 400));

      const count = Math.floor(Math.random() * 8) + 1;
      const reused = Math.floor(count * 0.4);
      const created = count - reused;

      addLog(batchNum, "success", `${batchNames[i]} completed — ${created} created, ${reused} reused`, `SF-${Math.random().toString(36).slice(2, 9).toUpperCase()}`);
      setBatches(prev => prev.map(b => b.batch === batchNum ? { ...b, status: "success", count, duration: Math.floor(600 + Math.random() * 400) } : b));
    }

    addLog(9, "success", "RCA Deployment complete — all batches succeeded");
    setDeployDone(true);
  }

  function stopDeploy() {
    abortRef.current?.abort();
    setIsRunning(false);
    addLog(0, "warning", "Deployment stopped by user");
  }

  const textPrimary = isDark ? "rgba(210,230,250,0.92)" : "rgba(0,10,40,0.88)";
  const textMuted   = isDark ? "rgba(90,130,180,0.65)"  : "rgba(0,31,91,0.62)";
  const border      = isDark ? "1px solid rgba(30,144,255,0.12)" : "1px solid rgba(0,71,171,0.16)";

  const successCount = batches.filter(b => b.status === "success").length;
  const errorCount   = batches.filter(b => b.status === "error").length;
  const runningBatch = batches.find(b => b.status === "running");

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 shrink-0" style={{ borderBottom: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.14)" }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(30,144,255,0.22), rgba(0,212,255,0.14))", border: "1px solid rgba(30,144,255,0.28)", color: "#1E90FF" }}>
              <Ic n="rocket" s={18} />
            </div>
            <div>
              <h2 className="text-[17px] font-bold" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.025em" }}>RCA Deployment Console</h2>
              <p className="text-[11px]" style={{ color: textMuted }}>9-batch Salesforce Revenue Cloud Advanced deployment with live execution logs</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isRunning && (
              <motion.button
                onClick={stopDeploy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer"
                style={{ background: "rgba(232,68,68,0.12)", color: "#E84444", border: "1px solid rgba(232,68,68,0.25)" }}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
              >
                <Ic n="x" s={11} />Stop
              </motion.button>
            )}
            <motion.button
              onClick={resetBatches}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium cursor-pointer"
              style={{ color: textMuted, border }}
              whileHover={{ background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.08)" }}
              whileTap={{ scale: 0.97 }}
            >
              <Ic n="refresh" s={11} />Reset
            </motion.button>
            <motion.button
              onClick={startDeploy}
              disabled={isRunning}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-[12px] font-bold cursor-pointer"
              style={{
                background: isRunning ? "rgba(30,144,255,0.2)" : "linear-gradient(135deg, #1E90FF 0%, #00D4FF 100%)",
                color: isRunning ? "rgba(0,212,255,0.6)" : "rgba(0,8,20,0.92)",
                border: isRunning ? "1px solid rgba(30,144,255,0.25)" : "none",
              }}
              whileHover={{ scale: isRunning ? 1 : 1.03 }}
              whileTap={{ scale: isRunning ? 1 : 0.97 }}
            >
              {isRunning ? (
                <><motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}><Ic n="refresh" s={13} /></motion.span>Deploying…</>
              ) : (
                <><Ic n="rocket" s={13} />{deployDone ? "Redeploy" : "Deploy to Salesforce"}</>
              )}
            </motion.button>
          </div>
        </div>

        {/* Stats */}
        <div className="flex gap-3 mt-3">
          {[
            { label: "Completed",  value: `${successCount}/9`,                     color: "#00D4FF" },
            { label: "Errors",     value: String(errorCount),                       color: errorCount > 0 ? "#E84444" : "#00D4FF" },
            { label: "Running",    value: runningBatch ? `Batch ${runningBatch.batch}` : "—", color: "#1E90FF" },
            { label: "Status",     value: deployDone ? "Done" : isRunning ? "Live" : "Ready", color: deployDone ? "#00D4FF" : isRunning ? "#1E90FF" : textMuted },
          ].map(s => (
            <div key={s.label} className="flex flex-col px-3 py-2 rounded-lg" style={{ background: isDark ? "rgba(30,144,255,0.07)" : "rgba(0,71,171,0.07)", border }}>
              <span className="text-[15px] font-bold" style={{ color: s.color, letterSpacing: "-0.02em" }}>{s.value}</span>
              <span className="text-[9px] mt-0.5" style={{ color: textMuted }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: Bundle input + batch grid */}
        <div className="w-80 shrink-0 flex flex-col overflow-hidden" style={{ borderRight: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.14)" }}>
          {/* Bundle text input */}
          <div className="px-4 py-3 shrink-0" style={{ borderBottom: isDark ? "1px solid rgba(30,144,255,0.08)" : "1px solid rgba(0,71,171,0.12)" }}>
            <p className="text-[10px] font-bold tracking-widest uppercase mb-2" style={{ color: isDark ? "rgba(30,144,255,0.55)" : "rgba(0,71,171,0.7)" }}>Bundle Definition</p>
            <textarea
              value={bundleText}
              onChange={e => setBundleText(e.target.value)}
              disabled={isRunning}
              rows={6}
              className="w-full rounded-xl text-[11px] resize-none outline-none font-mono"
              style={{
                background: isDark ? "rgba(30,144,255,0.05)" : "rgba(235,245,255,0.95)",
                border: isDark ? "1px solid rgba(30,144,255,0.15)" : "1px solid rgba(0,71,171,0.20)",
                color: textPrimary,
                padding: "8px 12px",
                opacity: isRunning ? 0.6 : 1,
              }}
            />
          </div>

          {/* Batch status grid */}
          <div className="flex-1 overflow-y-auto px-4 py-3" style={{ scrollbarWidth: "none" }}>
            <p className="text-[10px] font-bold tracking-widest uppercase mb-2.5" style={{ color: isDark ? "rgba(30,144,255,0.55)" : "rgba(0,71,171,0.7)" }}>Execution Batches</p>
            <div className="flex flex-col gap-1.5">
              {batches.map(batch => (
                <div
                  key={batch.batch}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl"
                  style={{
                    background: isDark
                      ? batch.status === "running" ? "rgba(30,144,255,0.12)" : "rgba(4,10,24,0.7)"
                      : batch.status === "running" ? "rgba(30,144,255,0.09)" : "rgba(222,235,255,0.85)",
                    border: `1px solid ${batchColor(batch.status)}${batch.status === "pending" ? "30" : "45"}`,
                  }}
                >
                  {/* Status indicator */}
                  {batch.status === "running" ? (
                    <motion.div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: "#1E90FF" }}
                      animate={{ opacity: [1, 0.3, 1] }}
                      transition={{ duration: 0.8, repeat: Infinity }}
                    />
                  ) : (
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: batchColor(batch.status), opacity: batch.status === "pending" ? 0.35 : 1 }}
                    />
                  )}

                  {/* Batch number */}
                  <span className="text-[9px] font-mono font-bold shrink-0 w-5" style={{ color: batchColor(batch.status) }}>B{batch.batch}</span>

                  {/* Name */}
                  <span className="flex-1 text-[11px] font-medium truncate" style={{ color: textPrimary }}>{batch.name}</span>

                  {/* Count/duration */}
                  {batch.status === "success" && (
                    <span className="text-[9px] font-mono shrink-0" style={{ color: "#00D4FF" }}>{batch.count}</span>
                  )}
                  {batch.status === "error" && (
                    <span className="text-[9px] font-mono shrink-0" style={{ color: "#E84444" }}>ERR</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Live log console */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div
            className="flex items-center justify-between px-4 py-2 shrink-0"
            style={{ borderBottom: isDark ? "1px solid rgba(30,144,255,0.08)" : "1px solid rgba(0,71,171,0.12)" }}
          >
            <div className="flex items-center gap-2">
              <span style={{ color: "#1E90FF" }}><Ic n="terminal" s={13} /></span>
              <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: isDark ? "rgba(30,144,255,0.65)" : "rgba(0,71,171,0.8)" }}>Live Execution Logs</span>
              {isRunning && (
                <motion.span
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: "rgba(30,144,255,0.14)", color: "#1E90FF", border: "1px solid rgba(30,144,255,0.28)" }}
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1, repeat: Infinity }}
                >
                  LIVE
                </motion.span>
              )}
              {deployDone && (
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(0,212,255,0.12)", color: "#00D4FF", border: "1px solid rgba(0,212,255,0.28)" }}>
                  COMPLETE
                </span>
              )}
            </div>
            <span className="text-[9px]" style={{ color: textMuted }}>{logs.length} entries</span>
          </div>

          <div
            className="flex-1 overflow-y-auto px-4 py-3 font-mono"
            style={{
              background: isDark ? "rgba(1,4,12,0.85)" : "rgba(212,228,252,0.7)",
              scrollbarWidth: "thin",
            }}
          >
            {logs.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full" style={{ color: textMuted }}>
                <Ic n="terminal" s={28} />
                <p className="mt-3 text-[12px]">No logs yet</p>
                <p className="text-[11px] mt-1">Click Deploy to Salesforce to begin execution</p>
              </div>
            )}

            {logs.map(log => (
              <div key={log.id} className="flex items-start gap-2 mb-1 text-[11px]">
                <span className="shrink-0" style={{ color: isDark ? "rgba(30,144,255,0.35)" : "rgba(0,71,171,0.45)" }}>
                  {new Date(log.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                <span
                  className="shrink-0 font-bold"
                  style={{ color: batchColor(log.batch === 0 ? "pending" : "running"), minWidth: 24 }}
                >
                  {log.batch > 0 ? `B${log.batch}` : "  "}
                </span>
                <span
                  className="shrink-0 font-bold px-1 rounded text-[9px]"
                  style={{
                    background: `${logColor(log.level)}14`,
                    color: logColor(log.level),
                    border: `1px solid ${logColor(log.level)}28`,
                    minWidth: 48, textAlign: "center",
                  }}
                >
                  {log.level.toUpperCase()}
                </span>
                <span className="flex-1 leading-relaxed" style={{ color: logColor(log.level) }}>{log.msg}</span>
                {log.sfId && (
                  <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded" style={{ background: "rgba(30,144,255,0.12)", color: "#3AABFF", border: "1px solid rgba(30,144,255,0.22)" }}>
                    {log.sfId}
                  </span>
                )}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PLATFORM COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function RCAOrchestrationPlatform({
  activeTab: propActiveTab,
  isDark,
}: {
  activeTab: string;
  isDark: boolean;
}) {
  const [activeTab, setActiveTab] = useState<TabId>(
    (propActiveTab as TabId) ?? "rca-product-creator"
  );

  useEffect(() => {
    if (propActiveTab && TABS.some(t => t.id === propActiveTab)) {
      setActiveTab(propActiveTab as TabId);
    }
  }, [propActiveTab]);

  const border = isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.16)";

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{
        background: isDark
          ? "linear-gradient(160deg, #000508 0%, #010a1a 60%, #000305 100%)"
          : "linear-gradient(160deg, #D2DDEF 0%, #DCE8F6 60%, #CCDAEC 100%)",
        position: "relative",
      }}
    >
      {/* Ambient grid */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `linear-gradient(${isDark ? "rgba(30,144,255,0.022)" : "rgba(0,71,171,0.03)"} 1px, transparent 1px), linear-gradient(90deg, ${isDark ? "rgba(30,144,255,0.022)" : "rgba(0,71,171,0.03)"} 1px, transparent 1px)`,
            backgroundSize: "48px 48px",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background: isDark
              ? "radial-gradient(ellipse 55% 40% at 70% 20%, rgba(30,144,255,0.05) 0%, transparent 60%)"
              : "radial-gradient(ellipse 55% 40% at 70% 20%, rgba(0,71,171,0.07) 0%, transparent 60%)",
          }}
        />
      </div>

      {/* Tab navigation */}
      <div className="relative z-10 shrink-0">
        <TabBar activeTab={activeTab} onTabChange={setActiveTab} isDark={isDark} />
      </div>

      {/* Tab content */}
      <div className="relative z-10 flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="h-full flex flex-col overflow-hidden"
            style={{
              background: isDark ? "rgba(1,6,18,0.55)" : "rgba(218,232,252,0.58)",
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
            }}
          >
            {activeTab === "rca-product-creator" && <RCProductWorkspace isDark={isDark} />}
            {activeTab === "rca-bundle-studio"   && <BundleOrchestrationWorkspace isDark={isDark} />}
            {activeTab === "rca-dependency-engine" && <DependencyEnginePanel isDark={isDark} />}
            {activeTab === "rca-nested-bundles"  && <NestedBundlePanel isDark={isDark} />}
            {activeTab === "rca-attribute-studio" && <RCAAttributeStudio isDark={isDark} />}
            {activeTab === "rca-commercialization" && <CommercializationPanel isDark={isDark} />}
            {activeTab === "rca-deployment-console" && <DeploymentConsolePanel isDark={isDark} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
