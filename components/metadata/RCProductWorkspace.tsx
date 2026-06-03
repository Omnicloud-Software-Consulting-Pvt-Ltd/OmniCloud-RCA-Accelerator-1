"use client";

import React, { useState, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

/* ─────────────────────────────────────────────────────────────────────────────
 * Types
 * ─────────────────────────────────────────────────────────────────────────── */
type ProductStatus = "Draft" | "Active" | "Archived";
type ProductType = "simple" | "bundle";
type DeployPhase = "idle" | "deploying" | "done";
type PreviewTab = "visual" | "json";

interface ProductState {
  productName: string;
  productCode: string;
  status: ProductStatus;
  description: string;
  family: string;
  category: string;
  catalog: string;
  sellingModel: string;
  productType: ProductType;
  isActive: boolean;
  unitOfMeasure: string;
  classification: string;
  productOwner: string;
  priceBook: string;
  basePrice: string;
}

interface StepResult {
  id?: string; name?: string; created?: boolean;
  matched?: { name: string }[]; items?: unknown[];
  pricebook?: string; unitPrice?: number;
  [k: string]: unknown;
}
interface DeployResult {
  success: boolean; salesforceId?: string; error?: string;
  steps: Record<string, StepResult>;
  errors: { step: string; error: string }[];
  skipped: { step: string; reason: string }[];
}
type ValidationIssue = { field: string; msg: string };

/* ─────────────────────────────────────────────────────────────────────────────
 * Constants
 * ─────────────────────────────────────────────────────────────────────────── */
const EMPTY_PRODUCT: ProductState = {
  productName: "", productCode: "", status: "Draft", description: "",
  family: "", category: "", catalog: "", sellingModel: "One Time",
  productType: "simple", isActive: true, unitOfMeasure: "Each",
  classification: "", productOwner: "", priceBook: "Standard Price Book",
  basePrice: "",
};

const SELLING_MODELS = [
  "One Time",
  "Evergreen - Monthly", "Evergreen - Quarterly", "Evergreen - Semi-Annual", "Evergreen - Yearly",
  "Term Based - Monthly", "Term Based - Quarterly", "Term Based - Semi-Annual", "Term Based - Yearly",
];

const FAMILIES = ["Electronics", "Software", "Telecommunications", "Services", "Industrial", "Healthcare", "Financial", "Other"];
const CATEGORY_MAP: Record<string, string[]> = {
  Electronics:        ["Mobile Phones", "Laptops", "Tablets", "Gaming", "Audio", "Displays", "Cameras", "Wearables", "Peripherals", "Smart Home"],
  Software:           ["CRM", "ERP", "Analytics", "Security", "Collaboration", "DevTools", "Enterprise Software", "Productivity"],
  Telecommunications: ["Mobile Plans", "Broadband", "Fiber", "5G", "IoT Connectivity"],
  Services:           ["Subscription Services", "Professional Services", "Managed Services", "Cloud Services", "Support Plans"],
  Industrial:         ["Manufacturing", "Equipment", "Industrial Software"],
  Healthcare:         ["Medical Devices", "Health Services", "Diagnostics"],
  Financial:          ["Insurance", "Banking Products", "Investment"],
  Other:              ["General Products"],
};
const CATALOG_MAP: Record<string, string> = {
  Electronics: "Electronics Catalog", Software: "Software Catalog",
  Telecommunications: "Telecom Catalog", Services: "Services Catalog",
  Industrial: "Industrial Catalog", Healthcare: "Healthcare Catalog",
  Financial: "Financial Catalog", Other: "General Catalog",
};
const UNIT_OF_MEASURES = ["Each", "Hour", "License", "Month", "Year", "GB", "TB", "User", "Seat"];
const EXAMPLE_PROMPTS = [
  "Samsung Galaxy S25 mobile phone with black and silver colors under Electronics",
  "Salesforce CRM Enterprise subscription plan billed monthly",
  "Gaming laptop with RTX 5090, 64GB RAM, RGB keyboard, liquid cooling",
  "Smartwatch with AMOLED display, GPS, health monitoring, wireless charging",
  "Enterprise support contract billed quarterly for 2 years",
];

/* ─────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ─────────────────────────────────────────────────────────────────────────── */
function autoCode(name: string) {
  return name.toUpperCase().replace(/\s+/g,"_").replace(/[^A-Z0-9_]/g,"").slice(0,40);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Icon system
 * ─────────────────────────────────────────────────────────────────────────── */
function Ic({ n, s = 16 }: { n: string; s?: number }) {
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
function FieldWrap({ label, children, span2 }: { label: string; children: React.ReactNode; span2?: boolean }) {
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

function FInput({ value, onChange, placeholder, mono, large, readOnly, type }: {
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

function FSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
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

function FTextarea({ value, onChange, placeholder, rows = 3 }: {
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
function SectionHeader({ icon, label, badge, action }: {
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
function RCConfigCard({ icon, label, value, color, sub }: {
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

/* ─────────────────────────────────────────────────────────────────────────────
 * Visual Preview Panel
 * ─────────────────────────────────────────────────────────────────────────── */
function VisualPreview({ product, isDark }: { product: ProductState; isDark: boolean }) {
  const rows = (items: [string, string][], accentColor: string) => (
    <div className="space-y-1.5">
      {items.map(([label, val]) => (
        <div key={label} className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] shrink-0" style={{ color: "var(--rc-text-muted)" }}>{label}</span>
          <span className="text-[11px] font-semibold font-mono text-right truncate max-w-[160px]"
            style={{ color: val === "—" ? "var(--rc-text-muted)" : accentColor }}>
            {val}
          </span>
        </div>
      ))}
    </div>
  );

  const card = (title: string, accent: string, content: React.ReactNode) => (
    <div className="rounded-xl p-3" style={{ background: `${accent}08`, border: `1px solid ${accent}20` }}>
      <p className="text-[9px] font-bold uppercase tracking-wider mb-2.5" style={{ color: `${accent}80` }}>{title}</p>
      {content}
    </div>
  );

  return (
    <div className="space-y-2.5">
      {card("Product Information", "#1E90FF", rows([
        ["Name", product.productName || "—"],
        ["Code", product.productCode || "—"],
        ["Family", product.family || "—"],
        ["Category", product.category || "—"],
        ["Type", product.productType || "—"],
        ["Status", product.status],
        ["Active", product.isActive ? "Yes" : "No"],
        ["Unit", product.unitOfMeasure],
        ...(product.productOwner ? [["Owner", product.productOwner] as [string, string]] : []),
      ], "#3AABFF"))}

      {card("Revenue Cloud", "#00D4FF", rows([
        ["Catalog", product.catalog || "—"],
        ["Selling Model", product.sellingModel || "—"],
        ["Classification", product.classification || "—"],
        ["Price Book", product.priceBook || "—"],
        ["Base Price", product.basePrice ? `$${product.basePrice}` : "—"],
      ], "#00D4FF"))}

      {product.description && card("Description", "#60B8FF", (
        <p className="text-[11px] leading-relaxed" style={{ color: "var(--rc-text-primary)" }}>
          {product.description}
        </p>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Main Component
 * ─────────────────────────────────────────────────────────────────────────── */
export default function RCProductWorkspace({ isDark }: { isDark: boolean }) {
  const [product, setProduct] = useState<ProductState>(EMPTY_PRODUCT);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiPhase, setAiPhase] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [aiError, setAiError] = useState<string | null>(null);
  const [deployPhase, setDeployPhase] = useState<DeployPhase>("idle");
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [previewTab, setPreviewTab] = useState<PreviewTab>("visual");
  const [copied, setCopied] = useState(false);
  const codeManualSet = useRef(false);

  const cssVars = {
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

  const border = isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.18)";

  /* ── Auto-generate product code ── */
  useEffect(() => {
    if (!codeManualSet.current && product.productName) {
      setProduct(p => ({ ...p, productCode: autoCode(p.productName) }));
    }
  }, [product.productName]);

  const setField = useCallback(<K extends keyof ProductState>(key: K, value: ProductState[K]) => {
    setProduct(p => {
      const next = { ...p, [key]: value };
      if (key === "family") {
        next.catalog = CATALOG_MAP[value as string] ?? "";
        next.category = "";
      }
      return next;
    });
    if (key === "productCode") codeManualSet.current = true;
  }, []);

  const validate = useCallback(() => {
    const issues: ValidationIssue[] = [];
    if (!product.productName.trim()) issues.push({ field: "Product Name", msg: "Required" });
    if (!product.productCode.trim()) issues.push({ field: "Product Code", msg: "Required" });
    if (!product.family.trim()) issues.push({ field: "Family", msg: "Required" });
    setValidationIssues(issues);
    return issues;
  }, [product]);

  /* ── AI Generate ── */
  const handleGenerate = useCallback(async () => {
    if (!aiPrompt.trim() || aiPhase === "generating") return;
    setAiPhase("generating");
    setAiError(null);
    codeManualSet.current = false;

    try {
      const res = await fetch("/api/sf/products/generate-payload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setAiError(data.error ?? "Generation failed");
        setAiPhase("error");
        return;
      }
      const p = data.payload;
      setProduct(prev => ({
        ...prev,
        productName:    p.productName  ?? "",
        productCode:    p.productCode  ?? "",
        status:         "Draft",
        description:    p.description  ?? "",
        family:         p.family       ?? "",
        category:       p.category     ?? "",
        catalog:        p.catalog      ?? "",
        sellingModel:   p.sellingModel ?? "One Time",
        productType:    p.productType  ?? "simple",
        isActive:       p.isActive !== false,
        unitOfMeasure:  p.unitOfMeasure ?? "Each",
        classification: p.classification?.name ?? "",
      }));
      codeManualSet.current = true;
      setAiPhase("done");
      setValidationIssues([]);
    } catch {
      setAiError("Network error — could not reach AI");
      setAiPhase("error");
    }
  }, [aiPrompt, aiPhase]);

  /* ── Deploy ── */
  const handleDeploy = useCallback(async () => {
    const issues = validate();
    if (issues.length > 0) return;

    setDeployPhase("deploying");
    setDeployError(null);

    const payload = {
      productName:    product.productName,
      productCode:    product.productCode,
      family:         product.family,
      category:       product.category,
      catalog:        product.catalog,
      description:    product.description,
      isActive:       product.isActive,
      sellingModel:   product.sellingModel,
      unitOfMeasure:  product.unitOfMeasure,
      productType:    product.productType,
      classification: { name: product.classification, createIfMissing: true },
      productOwner:   product.productOwner,
      priceBook:      product.priceBook,
      basePrice:      product.basePrice,
    };

    try {
      const res = await fetch("/api/sf/products/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setDeployError(data.error ?? "Deployment failed");
        setDeployPhase("idle");
        return;
      }
      setDeployResult(data as DeployResult);
      setDeployPhase("done");
    } catch {
      setDeployError("Network error — could not reach Salesforce");
      setDeployPhase("idle");
    }
  }, [product, validate]);

  const handleReset = () => {
    setProduct(EMPTY_PRODUCT);
    setAiPrompt("");
    setAiPhase("idle");
    setAiError(null);
    setDeployPhase("idle");
    setDeployResult(null);
    setDeployError(null);
    setValidationIssues([]);
    setShowPreview(false);
    codeManualSet.current = false;

  };

  const payloadJson = JSON.stringify({
    productName:    product.productName,
    productCode:    product.productCode,
    family:         product.family,
    category:       product.category,
    catalog:        product.catalog,
    description:    product.description,
    isActive:       product.isActive,
    unitOfMeasure:  product.unitOfMeasure,
    sellingModel:   product.sellingModel,
    productType:    product.productType,
    classification: { name: product.classification, createIfMissing: true },
    productOwner:   product.productOwner || undefined,
    priceBook:      product.priceBook || undefined,
    basePrice:      product.basePrice || undefined,
  }, null, 2);

  const statusColors: Record<ProductStatus, { bg: string; text: string; border: string }> = {
    Draft:    { bg: "rgba(0,212,255,0.10)",   text: "#00D4FF", border: "rgba(0,212,255,0.28)"  },
    Active:   { bg: "rgba(30,144,255,0.12)",  text: "#1E90FF", border: "rgba(30,144,255,0.30)" },
    Archived: { bg: "rgba(90,120,160,0.08)",  text: "rgba(90,120,160,0.7)", border: "rgba(90,120,160,0.22)" },
  };

  const categories = CATEGORY_MAP[product.family] ?? [];

  return (
    <div className="flex flex-col h-full" style={cssVars}>

      {/* ── Workspace Header ── */}
      <div className="px-6 py-5 shrink-0" style={{ borderBottom: border }}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "linear-gradient(135deg, rgba(30,144,255,0.18) 0%, rgba(0,212,255,0.12) 100%)", border: "1px solid rgba(30,144,255,0.22)", color: "#1E90FF" }}>
              <Ic n="package" s={18} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-[18px] font-bold leading-tight truncate"
                  style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.025em" }}>
                  {product.productName || "Revenue Cloud Product Workspace"}
                </h2>
                {product.productName && (
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[9px] font-mono px-2 py-0.5 rounded"
                      style={{ background: isDark ? "rgba(30,144,255,0.08)" : "rgba(0,71,171,0.10)", border, color: isDark ? "#3AABFF" : "#0047AB" }}>
                      {product.productCode || "—"}
                    </span>
                    <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: statusColors[product.status].bg, border: `1px solid ${statusColors[product.status].border}`, color: statusColors[product.status].text }}>
                      {product.status}
                    </span>
                    <span className="text-[9px] font-mono px-2 py-0.5 rounded"
                      style={{ background: "rgba(0,212,255,0.08)", border: "1px solid rgba(0,212,255,0.2)", color: "#00D4FF" }}>
                      EPC v62.0
                    </span>
                  </div>
                )}
                {!product.productName && (
                  <span className="text-[9px] font-mono px-2 py-0.5 rounded"
                    style={{ background: "rgba(0,212,255,0.08)", border: "1px solid rgba(0,212,255,0.2)", color: "#00D4FF" }}>
                    AI · EPC v62.0
                  </span>
                )}
              </div>
              <p className="text-[12px] mt-1 leading-relaxed" style={{ color: "var(--rc-text-muted)" }}>
                {product.productName
                  ? (product.description || "Revenue Cloud product workspace")
                  : "Describe your product to auto-fill all fields, or fill manually and deploy to Salesforce."}
              </p>
            </div>
          </div>

          {product.productName && (
            <motion.button onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-medium cursor-pointer shrink-0"
              style={{ color: "var(--rc-text-muted)", border, background: "transparent" }}
              whileHover={{ background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.09)" }}
              whileTap={{ scale: 0.96 }}>
              <Ic n="plus" s={12} />New Product
            </motion.button>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── Main scrollable form ── */}
        <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
          <div className="px-6 py-5 space-y-8 pb-12">

            {/* ═══════ SECTION 1: PRODUCT DETAILS ═══════ */}
            <section>
              <SectionHeader icon="package" label="Product Details" />

              {/* Product Name */}
              <div className="mb-4">
                <FieldWrap label="Product Name *">
                  <input
                    value={product.productName}
                    onChange={e => setField("productName", e.target.value)}
                    placeholder="Enter product name…"
                    className="w-full rounded-xl outline-none text-[16px] font-semibold px-4 py-3"
                    style={{
                      background: isDark ? "rgba(30,144,255,0.04)" : "rgba(0,71,171,0.08)",
                      border: isDark ? "1px solid rgba(30,144,255,0.15)" : "1px solid rgba(0,71,171,0.22)",
                      color: isDark ? "white" : "#001F5B",
                      fontFamily: "inherit",
                      letterSpacing: "-0.02em",
                      transition: "border-color 180ms",
                    }}
                    onFocus={e => (e.target.style.borderColor = "#1E90FF")}
                    onBlur={e => (e.target.style.borderColor = isDark ? "rgba(30,144,255,0.15)" : "rgba(0,71,171,0.22)")}
                  />
                </FieldWrap>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
                <FieldWrap label="Product Code *">
                  <FInput value={product.productCode}
                    onChange={v => { codeManualSet.current = true; setField("productCode", v); }}
                    placeholder="AUTO_GENERATED" mono />
                </FieldWrap>
                <FieldWrap label="Product Status">
                  <FSelect value={product.status} onChange={v => setField("status", v as ProductStatus)}
                    options={["Draft","Active","Archived"]} />
                </FieldWrap>
                <FieldWrap label="Product Type">
                  <FSelect value={product.productType} onChange={v => setField("productType", v as ProductType)}
                    options={["simple","bundle"]} />
                </FieldWrap>
                <FieldWrap label="Unit of Measure">
                  <FSelect value={product.unitOfMeasure} onChange={v => setField("unitOfMeasure", v)}
                    options={UNIT_OF_MEASURES} />
                </FieldWrap>
                <FieldWrap label="Is Active">
                  <div className="flex gap-2 pt-0.5">
                    {["Yes","No"].map(v => (
                      <motion.button key={v}
                        onClick={() => setField("isActive", v === "Yes")}
                        className="flex-1 py-2 rounded-lg text-[11px] font-medium cursor-pointer"
                        style={{
                          background: (product.isActive ? "Yes" : "No") === v ? "rgba(30,144,255,0.14)" : "var(--rc-field-bg)",
                          border: `1px solid ${(product.isActive ? "Yes" : "No") === v ? "rgba(30,144,255,0.35)" : "var(--rc-field-border)"}`,
                          color: (product.isActive ? "Yes" : "No") === v ? "#1E90FF" : "var(--rc-text-muted)",
                        }}
                        whileTap={{ scale: 0.96 }}>{v}</motion.button>
                    ))}
                  </div>
                </FieldWrap>
                <FieldWrap label="Product Classification">
                  <FInput value={product.classification} onChange={v => setField("classification", v)}
                    placeholder="e.g. Mobile Phone" />
                </FieldWrap>
              </div>

              <FieldWrap label="Description" span2>
                <FTextarea value={product.description} onChange={v => setField("description", v)}
                  placeholder="Enter product description…" rows={2} />
              </FieldWrap>

              {validationIssues.length > 0 && (
                <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                  className="mt-3 px-3 py-2.5 rounded-lg flex items-start gap-2 text-[11px]"
                  style={{ background: "rgba(232,68,68,0.07)", border: "1px solid rgba(232,68,68,0.18)", color: "#E84444" }}>
                  <div className="mt-0.5 shrink-0"><Ic n="alert" s={13} /></div>
                  <div>{validationIssues.map(i => i.msg ? `${i.field}: ${i.msg}` : i.field).join(" · ")}</div>
                </motion.div>
              )}
            </section>

            <div className="h-px" style={{ background: "var(--rc-divider)" }} />

            {/* ═══════ SECTION 2: AI PRODUCT REQUIREMENT PROMPT ═══════ */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <motion.div
                    className="w-5 h-5 rounded-md flex items-center justify-center"
                    style={{ background: "linear-gradient(135deg, #0070D6 0%, #1E90FF 100%)", color: "white" }}
                    animate={aiPhase === "generating"
                      ? { boxShadow: ["0 0 0px #1E90FF", "0 0 12px #1E90FF", "0 0 0px #1E90FF"] }
                      : {}}
                    transition={{ duration: 1.2, repeat: Infinity }}>
                    <Ic n="sparkles" s={12} />
                  </motion.div>
                  <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: "var(--rc-text-section)" }}>
                    AI Product Requirement Prompt
                  </span>
                  {aiPhase === "done" && (
                    <motion.span initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
                      className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                      style={{ background: "rgba(0,212,255,0.1)", border: "1px solid rgba(0,212,255,0.25)", color: "#00D4FF" }}>
                      ✓ FIELDS FILLED
                    </motion.span>
                  )}
                </div>
              </div>

              <p className="text-[11px] leading-relaxed mb-3" style={{ color: "var(--rc-text-muted)" }}>
                Describe your product requirements in natural language. The AI will semantically infer Revenue Cloud structures — categories, catalogs, selling models, and classification — and auto-populate all fields.
              </p>

              {/* AI Prompt textarea */}
              <div className="relative mb-3">
                <textarea
                  value={aiPrompt}
                  onChange={e => setAiPrompt(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
                  placeholder="Describe the product requirements in natural language…&#10;&#10;Example: Create Samsung Galaxy S25 mobile phone with black and green colors under Electronics family with yearly support subscription."
                  rows={5}
                  disabled={aiPhase === "generating"}
                  className="w-full rounded-xl px-4 py-3.5 text-[13px] resize-none outline-none"
                  style={{
                    background: isDark ? "rgba(30,144,255,0.06)" : "rgba(30,144,255,0.04)",
                    border: aiPhase === "generating"
                      ? "1.5px solid rgba(30,144,255,0.45)"
                      : "1.5px solid rgba(30,144,255,0.2)",
                    color: "var(--rc-text-primary)",
                    fontFamily: "inherit",
                    lineHeight: 1.65,
                    transition: "border-color 200ms",
                  }}
                  onFocus={e => (e.target.style.borderColor = "#1E90FF")}
                  onBlur={e => (e.target.style.borderColor = aiPhase === "generating"
                    ? "rgba(30,144,255,0.45)" : "rgba(30,144,255,0.22)")}
                />
                {/* Cmd/Ctrl+Enter hint */}
                <div className="absolute bottom-2.5 right-3 text-[9px] font-mono pointer-events-none"
                  style={{ color: "rgba(30,144,255,0.4)" }}>
                  ⌘↵ to generate
                </div>
              </div>

              {/* Quick examples */}
              <div className="mb-3">
                <p className="text-[9px] font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--rc-text-muted)" }}>
                  Quick examples — click to use:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {EXAMPLE_PROMPTS.map((ex, i) => (
                    <motion.button key={i} onClick={() => setAiPrompt(ex)}
                      className="text-left px-2.5 py-1 rounded-lg text-[10px] cursor-pointer"
                      style={{ color: isDark ? "rgba(30,144,255,0.8)" : "#0047AB", border: "1px solid rgba(30,144,255,0.14)", background: "transparent" }}
                      whileHover={{ background: "rgba(30,144,255,0.08)" }}
                      whileTap={{ scale: 0.97 }}>
                      {ex}
                    </motion.button>
                  ))}
                </div>
              </div>

              {/* Error */}
              {aiError && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  className="mb-3 px-3 py-2.5 rounded-lg flex items-start gap-2 text-[11px]"
                  style={{ background: "rgba(232,68,68,0.08)", border: "1px solid rgba(232,68,68,0.2)", color: "#E84444" }}>
                  <div className="mt-0.5 shrink-0"><Ic n="alert" s={13} /></div>
                  {aiError}
                </motion.div>
              )}

              {/* Generate button */}
              <div className="flex items-center gap-3">
                <motion.button
                  onClick={handleGenerate}
                  disabled={!aiPrompt.trim() || aiPhase === "generating"}
                  className="flex items-center gap-2.5 px-5 py-2.5 rounded-xl text-[13px] font-semibold cursor-pointer"
                  style={{
                    background: aiPrompt.trim() && aiPhase !== "generating"
                      ? "linear-gradient(135deg, #0070D6 0%, #00D4FF 100%)"
                      : isDark ? "rgba(30,144,255,0.08)" : "rgba(30,144,255,0.06)",
                    color: aiPrompt.trim() && aiPhase !== "generating" ? "white" : "var(--rc-text-muted)",
                    border: "none",
                    opacity: aiPrompt.trim() && aiPhase !== "generating" ? 1 : 0.55,
                    boxShadow: aiPrompt.trim() && aiPhase !== "generating"
                      ? "0 4px 20px rgba(30,144,255,0.35)"
                      : "none",
                    transition: "opacity 180ms, box-shadow 180ms",
                  }}
                  whileHover={aiPrompt.trim() && aiPhase !== "generating" ? { scale: 1.02, y: -1 } : {}}
                  whileTap={aiPrompt.trim() && aiPhase !== "generating" ? { scale: 0.97 } : {}}
                >
                  {aiPhase === "generating" ? (
                    <>
                      <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
                        <Ic n="refresh" s={15} />
                      </motion.span>
                      Analyzing product requirements…
                    </>
                  ) : (
                    <>
                      <Ic n="sparkles" s={15} />
                      Generate Revenue Cloud Payload
                    </>
                  )}
                </motion.button>

                {aiPhase === "done" && (
                  <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                    className="flex items-center gap-1.5 text-[11px] font-medium"
                    style={{ color: "#00D4FF" }}>
                    <Ic n="check-circle" s={14} />
                    Fields auto-populated from AI
                  </motion.div>
                )}
              </div>
            </section>

            <div className="h-px" style={{ background: "var(--rc-divider)" }} />

            {/* ═══════ SECTION 3: REVENUE CLOUD CONFIGURATION ═══════ */}
            <section>
              <SectionHeader icon="layers" label="Revenue Cloud Configuration" />

              <div className="grid grid-cols-2 gap-3 mb-4">
                <FieldWrap label="Product Family *">
                  <FSelect value={product.family || ""} onChange={v => setField("family", v)}
                    options={["", ...FAMILIES]} />
                </FieldWrap>
                <FieldWrap label="Product Category">
                  <FSelect value={product.category || ""} onChange={v => setField("category", v)}
                    options={["", ...categories]} />
                </FieldWrap>
                <FieldWrap label="Product Catalog">
                  <FInput value={product.catalog} onChange={v => setField("catalog", v)}
                    placeholder="Electronics Catalog" />
                </FieldWrap>
                <FieldWrap label="Selling Model">
                  <FSelect value={product.sellingModel} onChange={v => setField("sellingModel", v)}
                    options={SELLING_MODELS} />
                </FieldWrap>
                <FieldWrap label="Product Owner">
                  <FInput value={product.productOwner} onChange={v => setField("productOwner", v)}
                    placeholder="e.g. jane.doe@company.com" />
                </FieldWrap>
                <FieldWrap label="Price Book">
                  <FInput value={product.priceBook} onChange={v => setField("priceBook", v)}
                    placeholder="Standard Price Book" />
                </FieldWrap>
                <FieldWrap label="Base Price (USD)">
                  <FInput value={product.basePrice} onChange={v => setField("basePrice", v)}
                    placeholder="0.00" type="number" />
                </FieldWrap>
              </div>

              {/* RC Config summary cards */}
              {(product.catalog || product.category || product.sellingModel || product.classification) && (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-2">
                  {product.catalog        && <RCConfigCard icon="layers"       label="Catalog"         value={product.catalog}         color="#1E90FF" />}
                  {product.category       && <RCConfigCard icon="tag"          label="Category"        value={product.category}        color="#3AABFF" sub={product.family} />}
                  {product.sellingModel   && <RCConfigCard icon="zap"          label="Selling Model"   value={product.sellingModel}    color="#00D4FF" />}
                  {product.classification && <RCConfigCard icon="package"      label="Classification"  value={product.classification}  color="#60B8FF" />}
                  {product.priceBook      && <RCConfigCard icon="book-open"    label="Price Book"      value={product.priceBook}       color="#0070D6" sub={product.basePrice ? `$${product.basePrice}` : undefined} />}
                  {product.productOwner   && <RCConfigCard icon="user"         label="Owner"           value={product.productOwner}    color="#2563EB" />}
                </div>
              )}
            </section>

          </div>
        </div>

        {/* ── Right panel: Preview + Deploy ── */}
        <div className="w-72 shrink-0 flex flex-col overflow-hidden"
          style={{ borderLeft: border, background: "var(--rc-panel-bg)" }}>

          <div className="flex-1 overflow-y-auto p-4" style={{ scrollbarWidth: "none" }}>

            {/* Panel header */}
            <div className="flex items-center gap-2 mb-4">
              <div style={{ color: "#1E90FF" }}><Ic n="rocket" s={14} /></div>
              <span className="text-[12px] font-bold" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.01em" }}>
                Deploy &amp; Preview
              </span>
              {deployPhase === "done" && deployResult && (
                <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  className="ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: "rgba(0,212,255,0.1)", border: "1px solid rgba(0,212,255,0.25)", color: "#00D4FF" }}>
                  ✓ LIVE
                </motion.span>
              )}
            </div>

            {/* Deploy result */}
            <AnimatePresence>
              {deployPhase === "done" && deployResult && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="mb-4 px-3 py-3 rounded-xl"
                  style={{ background: "rgba(30,144,255,0.07)", border: "1px solid rgba(30,144,255,0.20)" }}>
                  <div className="text-[10px] font-semibold mb-2" style={{ color: "#1E90FF" }}>Product Created in Salesforce</div>
                  <div className="flex items-center gap-2 mb-2.5">
                    <span className="text-[9px] font-mono" style={{ color: "rgba(30,144,255,0.6)" }}>ID</span>
                    <span className="text-[11px] font-mono font-semibold truncate flex-1" style={{ color: "#3AABFF" }}>{deployResult.salesforceId}</span>
                    <motion.button onClick={() => {
                      navigator.clipboard.writeText(deployResult.salesforceId ?? "");
                      setCopied(true); setTimeout(() => setCopied(false), 1600);
                    }} style={{ color: "rgba(0,212,255,0.6)", flexShrink: 0 }} whileTap={{ scale: 0.9 }}>
                      <Ic n="copy" s={11} />
                    </motion.button>
                    {copied && <span className="text-[9px]" style={{ color: "#00D4FF" }}>Copied!</span>}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {[
                      deployResult.steps.product        && { ok: true,  label: "Product2 created" },
                      deployResult.steps.catalog        && { ok: true,  label: `Catalog: ${(deployResult.steps.catalog as StepResult).name}` },
                      deployResult.steps.sellingModel   && { ok: true,  label: "Selling Model linked" },
                      deployResult.steps.pricebookEntry && { ok: true,  label: `PricebookEntry @ $${(deployResult.steps.pricebookEntry as StepResult).unitPrice}` },
                      ...deployResult.errors.map(e => ({ ok: false, label: `Error: ${e.step}` })),
                      ...deployResult.skipped.map(s => ({ ok: null,  label: `Skipped: ${s.step}` })),
                    ].filter(Boolean).map((item, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-[10px]" style={{
                        color: item!.ok === true ? "#00C875" : item!.ok === false ? "#FF4066" : "var(--rc-text-muted)"
                      }}>
                        <Ic n={item!.ok === true ? "check-circle" : item!.ok === false ? "x-circle" : "info"} s={11} />
                        {item!.label}
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Deploy error */}
            {deployError && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="mb-3 px-3 py-2 rounded-lg text-[10px]"
                style={{ background: "rgba(232,68,68,0.08)", border: "1px solid rgba(232,68,68,0.18)", color: "#E84444" }}>
                {deployError}
              </motion.div>
            )}

            {/* Action buttons */}
            <div className="flex flex-col gap-2 mb-4">
              {/* Validate */}
              <motion.button
                onClick={() => { const issues = validate(); if (issues.length === 0) setValidationIssues([]); }}
                className="flex items-center justify-center gap-2 py-2 rounded-lg text-[11px] font-medium cursor-pointer"
                style={{ color: isDark ? "rgba(30,144,255,0.85)" : "#0047AB", border: "1px solid rgba(30,144,255,0.2)", background: "transparent" }}
                whileHover={{ background: "rgba(30,144,255,0.07)" }}
                whileTap={{ scale: 0.96 }}>
                <Ic n="check-square" s={12} />Validate Configuration
              </motion.button>

              {/* Preview Payload */}
              <motion.button
                onClick={() => setShowPreview(v => !v)}
                className="flex items-center justify-center gap-2 py-2 rounded-lg text-[11px] font-medium cursor-pointer"
                style={{ color: isDark ? "rgba(30,144,255,0.85)" : "#0047AB", border: "1px solid rgba(30,144,255,0.2)", background: "transparent" }}
                whileHover={{ background: "rgba(30,144,255,0.07)" }}
                whileTap={{ scale: 0.96 }}>
                <Ic n={showPreview ? "eye-off" : "eye"} s={12} />
                {showPreview ? "Hide Preview" : "Preview Payload"}
              </motion.button>
            </div>

            {/* Preview panel */}
            <AnimatePresence>
              {showPreview && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}
                  className="mb-4"
                >
                  {/* Tabs */}
                  <div className="flex mb-2 rounded-lg overflow-hidden"
                    style={{ border: "1px solid rgba(30,144,255,0.15)", background: isDark ? "rgba(30,144,255,0.04)" : "rgba(0,71,171,0.08)" }}>
                    {(["visual", "json"] as PreviewTab[]).map(tab => (
                      <button key={tab}
                        onClick={() => setPreviewTab(tab)}
                        className="flex-1 py-1.5 text-[10px] font-semibold uppercase tracking-wider cursor-pointer transition-all"
                        style={{
                          background: previewTab === tab
                            ? isDark ? "rgba(30,144,255,0.14)" : "rgba(0,71,171,0.20)"
                            : "transparent",
                          color: previewTab === tab
                            ? isDark ? "#3AABFF" : "#0047AB"
                            : "var(--rc-text-muted)",
                          border: "none",
                        }}>
                        {tab === "visual" ? "Preview View" : "JSON View"}
                      </button>
                    ))}
                  </div>

                  {/* Visual tab */}
                  {previewTab === "visual" && (
                    <VisualPreview product={product} isDark={isDark} />
                  )}

                  {/* JSON tab */}
                  {previewTab === "json" && (
                    <div className="relative">
                      <motion.button
                        onClick={() => { navigator.clipboard.writeText(payloadJson); setCopied(true); setTimeout(() => setCopied(false), 1600); }}
                        className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded text-[9px] cursor-pointer z-10"
                        style={{ background: isDark ? "rgba(30,144,255,0.15)" : "rgba(0,71,171,0.16)", border: "1px solid rgba(30,144,255,0.2)", color: isDark ? "#3AABFF" : "#0047AB" }}
                        whileTap={{ scale: 0.95 }}>
                        <Ic n="copy" s={10} />
                        {copied ? "Copied!" : "Copy"}
                      </motion.button>
                      <pre className="text-[9px] font-mono rounded-xl px-3 py-3 overflow-x-auto leading-relaxed"
                        style={{
                          background: isDark ? "rgba(0,4,12,0.85)" : "rgba(228,235,252,0.9)",
                          border: "1px solid rgba(30,144,255,0.14)",
                          color: isDark ? "rgba(120,180,255,0.85)" : "#0047AB",
                          maxHeight: 380, overflowY: "auto", scrollbarWidth: "thin",
                          whiteSpace: "pre-wrap", wordBreak: "break-all",
                        }}>
                        {payloadJson}
                      </pre>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Deploy button */}
            <motion.button
              onClick={handleDeploy}
              disabled={deployPhase === "deploying"}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-[12px] font-bold cursor-pointer"
              style={{
                background: deployPhase === "deploying"
                  ? isDark ? "rgba(30,144,255,0.08)" : "rgba(30,144,255,0.06)"
                  : "linear-gradient(135deg, #0070D6 0%, #00D4FF 100%)",
                color: deployPhase === "deploying" ? "#1E90FF" : "rgba(0,10,20,0.92)",
                border: deployPhase === "deploying" ? "1px solid rgba(30,144,255,0.3)" : "none",
                opacity: deployPhase === "deploying" ? 0.7 : 1,
                boxShadow: deployPhase !== "deploying" ? "0 4px 20px rgba(0,212,255,0.25)" : "none",
              }}
              whileHover={deployPhase !== "deploying" ? { scale: 1.02, y: -1 } : {}}
              whileTap={deployPhase !== "deploying" ? { scale: 0.97 } : {}}
            >
              {deployPhase === "deploying" ? (
                <>
                  <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
                    <Ic n="refresh" s={13} />
                  </motion.span>
                  Creating Salesforce Records…
                </>
              ) : (
                <>
                  <Ic n="rocket" s={13} />
                  Create Record in Salesforce
                </>
              )}
            </motion.button>

            {/* Product Summary strip (when product exists) */}
            {product.productName && (
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="mt-3 px-3 py-2.5 rounded-xl"
                style={{ background: isDark ? "rgba(30,144,255,0.05)" : "rgba(0,71,171,0.09)", border }}>
                <p className="text-[9px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "var(--rc-text-section)" }}>
                  Current Product
                </p>
                <p className="text-[12px] font-semibold truncate" style={{ color: isDark ? "white" : "#001F5B" }}>{product.productName}</p>
                <p className="text-[10px] font-mono mt-0.5" style={{ color: "var(--rc-text-muted)" }}>{product.productCode}</p>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  {product.family && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded"
                      style={{ background: "rgba(30,144,255,0.08)", border: "1px solid rgba(30,144,255,0.15)", color: "#3AABFF" }}>
                      {product.family}
                    </span>
                  )}
                  {product.sellingModel && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded"
                      style={{ background: "rgba(0,212,255,0.07)", border: "1px solid rgba(0,212,255,0.15)", color: "#00D4FF" }}>
                      {product.sellingModel}
                    </span>
                  )}
                </div>
              </motion.div>
            )}

          </div>
        </div>

      </div>
    </div>
  );
}
