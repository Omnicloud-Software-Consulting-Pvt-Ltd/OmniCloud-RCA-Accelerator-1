"use client";

import { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

/* ─────────────────────────────────────────────────────────────────────────────
 * Types
 * ─────────────────────────────────────────────────────────────────────────── */
interface ParsedAttribute {
  name: string;
  dataType: "Picklist" | "Text" | "Number" | "Boolean" | "Checkbox" | "Date";
  configurable: boolean;
  required: boolean;
  active: boolean;
  description: string;
  values: string[];
  defaultValue: string | null;
}

interface SkippedField {
  name: string;
  reason: string;
}

interface ParsedRCAData {
  productName: string;
  productCode: string;
  productFamily: string;
  productType: string;
  description: string;
  isActive: boolean;
  unitOfMeasure: string;
  sellingModel: string;
  classificationName: string;
  categoryName: string;
  skipped: SkippedField[];
  attributes: ParsedAttribute[];
}

type BatchStatus = "idle" | "running" | "success" | "failed";

interface BatchState {
  status: BatchStatus;
  logs: string[];
}

interface StorageHealth {
  reuseCount:    number;
  createCount:   number;
  storageErrors: number;
  storageWarning: boolean;
  reusedObjects: Record<string, number>;
  failedObjects: Record<string, number>;
}

function emptyHealth(): StorageHealth {
  return { reuseCount: 0, createCount: 0, storageErrors: 0, storageWarning: false, reusedObjects: {}, failedObjects: {} };
}

function mergeHealth(a: StorageHealth, b: StorageHealth): StorageHealth {
  const mergeMap = (x: Record<string, number>, y: Record<string, number>) => {
    const out = { ...x };
    for (const [k, v] of Object.entries(y)) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  return {
    reuseCount:    a.reuseCount    + b.reuseCount,
    createCount:   a.createCount   + b.createCount,
    storageErrors: a.storageErrors + b.storageErrors,
    storageWarning: a.storageWarning || b.storageWarning,
    reusedObjects: mergeMap(a.reusedObjects, b.reusedObjects),
    failedObjects: mergeMap(a.failedObjects, b.failedObjects),
  };
}

interface BatchContext {
  productId?:                 string;
  classificationId?:          string;
  catalogId?:                 string;
  categoryId?:                string;
  sellingModelId?:            string;
  attributePicklistIds?:      Record<string, string>;
  attributePicklistValueIds?: Record<string, string[]>;
  attributeDefIds?:           Record<string, string>;
  attributeCategoryId?:       string;
  attributeCatAttrIds?:       Record<string, string>;
  pcaIds?:                    Record<string, string>;
  padIds?:                    Record<string, string>;
  runtimeValueIds?:           Record<string, string>;
  normalizedTypes?:           Record<string, string>;
  schemaInfo?: {
    padDatatypeField:       string | null;
    attrDefDatatypeField:   string | null;
    attrDefPicklistFKField: string | null;
    validDatatypes:         string[];
    product2ValidTypes:     string[];
    padProduct2FKField:     string | null;
    padPCAFKField:          string | null;
    smoProductFKField:      string | null;
    discoveredAt:           string;
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Constants
 * ─────────────────────────────────────────────────────────────────────────── */
const ACCENT = "#00D4FF";      // semantic success
const ACCENT_CYAN = "#00D4FF"; // primary accent cyan

const BATCH_DEFS = [
  { id: 1, name: "Datatype Detection",         desc: "Detect RCA datatypes, normalize semantic types, generate datatype map" },
  { id: 2, name: "Picklist Creation",          desc: "Create AttributePicklist containers for Picklist-type attributes" },
  { id: 3, name: "Picklist Values",            desc: "Create AttributePicklistValue records inside each picklist container" },
  { id: 4, name: "Attr Definition + Category", desc: "Create AttributeDefinition, AttributeCategory, and mapping records" },
  { id: 5, name: "Product Classification",     desc: "Create or reuse ProductClassification grouping" },
  { id: 6, name: "Product Creation",           desc: "Create Product2 with resolved Type, Family, and ProductCode" },
  { id: 7, name: "PCA + PAD Mapping",          desc: "Create ProductClassificationAttr then ProductAttributeDefinition — hybrid RCA model" },
  { id: 8, name: "Runtime Value Persistence",  desc: "Persist configured default attribute values on the deployed product" },
  { id: 9, name: "Commercial Enablement",      desc: "Create SellingModel, PricebookEntry, and CategoryProduct mappings" },
];

const DT_CONFIG: Record<string, { color: string; bg: string }> = {
  Picklist: { color: "#1E90FF", bg: "rgba(30,144,255,0.13)"  },
  Number:   { color: "#00D4FF", bg: "rgba(0,212,255,0.11)"   },
  Boolean:  { color: "#3AABFF", bg: "rgba(58,171,255,0.12)"  },
  Checkbox: { color: "#3AABFF", bg: "rgba(58,171,255,0.12)"  },
  Text:     { color: "#60B8FF", bg: "rgba(96,184,255,0.10)"  },
  Date:     { color: "#0070D6", bg: "rgba(0,112,214,0.11)"   },
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Batch payload generator — produces preview JSON for each of the 8 batches
 * ─────────────────────────────────────────────────────────────────────────── */
function generateBatchPayloads(d: ParsedRCAData): unknown[] {
  const catalogName = d.productFamily ? `${d.productFamily} Catalog` : `${d.classificationName} Catalog`;
  const smType = d.sellingModel.startsWith("Evergreen") ? "Evergreen"
    : d.sellingModel.startsWith("Term") ? "TermDefined" : "OneTime";
  const picklistAttrs = d.attributes.filter(a => a.dataType === "Picklist" || a.values.length > 0);

  return [
    // Batch 0 (1) — Datatype Detection (internal schema + normalization, no mutations)
    {
      operation: "describe+normalize",
      objects: ["AttributePicklist", "AttributePicklistValue", "AttributeDefinition",
                "ProductAttributeDefinition", "Product2",
                "ProductCatalog", "ProductCategory", "ProductClassification",
                "AttributeCategory", "AttributeCategoryAttribute",
                "ProductSellingModel", "ProductSellingModelOption", "ProductCategoryProduct"],
      note: "Read-only — detects valid DataType values, FK field names, normalizes AI types to org types",
      normalizedTypes: d.attributes.reduce((acc, a) => ({
        ...acc,
        [a.name]: a.dataType === "Boolean" ? "Checkbox" : a.dataType,
      }), {} as Record<string, string>),
    },
    // Batch 1 (2) — AttributePicklist (one container per Picklist-type attr)
    {
      operation: "findOrCreate",
      sObjectType: "AttributePicklist",
      searchOn: ["Name"],
      note: "One per Picklist-type attribute — provides PicklistId FK for AttributeDefinition",
      records: picklistAttrs.map(a => ({ Name: a.name, Label: a.name, Status: "Active" })),
    },
    // Batch 2 (3) — AttributePicklistValue (individual values inside each container)
    {
      operation: "findOrCreate",
      sObjectType: "AttributePicklistValue",
      note: "AttributePicklistId injected from Batch 2 context at runtime",
      records: picklistAttrs.flatMap(a =>
        (a.values.length > 0 ? a.values : ["Default"]).map((v, i) => ({
          Name: v, Value: v, DisplayValue: v, Sequence: i + 1, Status: "Active",
          AttributePicklistId: `REF:AttributePicklist[Name='${a.name}']`,
        }))
      ),
    },
    // Batch 3 (4) — AttributeDefinition + AttributeCategory + AttributeCategoryAttribute
    {
      operation: "sequential",
      steps: [
        {
          sObjectType: "AttributeCategory", op: "findOrCreate", searchOn: ["Name"],
          record: { Name: d.classificationName },
          note: "safeDescribe guard — skipped if object not accessible in org",
        },
        {
          sObjectType: "AttributeDefinition", op: "findOrCreate", searchOn: ["DeveloperName"],
          note: "DataType normalized; PicklistId injected for Picklist-type attrs; bulk pre-fetch prevents duplicates",
          records: d.attributes.map(a => ({
            Name: a.name, Label: a.name,
            DeveloperName: `[DERIVED from "${a.name}"]`,
            DataType: `[NORMALIZED from "${a.dataType}"]`,
            ...(a.dataType === "Picklist" || a.values.length > 0 ? {
              PicklistId: `REF:AttributePicklist[Name='${a.name}'] — FK field detected at runtime`,
            } : {}),
            IsActive: a.active,
          })),
        },
        {
          sObjectType: "AttributeCategoryAttribute", op: "findOrCreate",
          note: "Junction: AttributeCategory ↔ AttributeDefinition; safeDescribe guard applied",
          records: d.attributes.map(a => ({
            AttributeCategoryId: `REF:AttributeCategory[Name='${d.classificationName}']`,
            AttributeDefinitionId: `REF:AttributeDefinition[Name='${a.name}']`,
          })),
        },
      ],
    },
    // Batch 4 (5) — ProductClassification
    {
      operation: "findOrCreate",
      sObjectType: "ProductClassification",
      searchOn: ["Name"],
      record: { Name: d.classificationName, Code: d.classificationName.replace(/\s+/g, "_").toUpperCase() },
      note: "IsActive omitted — filtered by filterCreatable if not present",
    },
    // Batch 5 (6) — Product2 (simple creation — no BasedOnId, no classification inheritance)
    {
      operation: "findOrCreate",
      sObjectType: "Product2",
      searchOn: ["ProductCode"],
      record: {
        Name: d.productName, ProductCode: d.productCode, Family: d.productFamily,
        Type: `[DYNAMIC — resolved from Product2.Type picklist at runtime]`,
        Description: d.description, IsActive: d.isActive, QuantityUnitOfMeasure: d.unitOfMeasure,
      },
      note: "No BasedOnId — Product2 created independently of ProductClassification",
    },
    // Batch 6 (7) — Hybrid PCA → PAD: Step 1 creates ProductClassificationAttr, Step 2 creates ProductAttributeDefinition with PCA FK
    {
      operation: "sequential",
      steps: [
        {
          sObjectType: "ProductClassificationAttr", op: "findOrCreate",
          searchOn: ["[ClassificationFK]", "AttributeDefinitionId"],
          note: "Step 1 — junction between ProductClassification + AttributeDefinition; FK field names detected at runtime",
          records: d.attributes.map(a => ({
            Name: `${a.name} Classification`,
            "[ClassificationFK]": `REF:ProductClassification[Name='${d.classificationName}'] — FK field detected at runtime`,
            AttributeDefinitionId: `REF:AttributeDefinition[Name='${a.name}']`,
            Status: "Active",
          })),
        },
        {
          sObjectType: "ProductAttributeDefinition", op: "findOrCreate",
          searchOn: ["[Product2FK]", "AttributeDefinitionId"],
          note: "Step 2 — requires PCA FK (ProductClassificationAttributeId) from Step 1; Product2FK detected at runtime",
          records: d.attributes.map(a => ({
            Name: a.name,
            "[Product2FK]":                      `REF:Product2[ProductCode='${d.productCode}'] — FK field detected at runtime`,
            AttributeDefinitionId:               `REF:AttributeDefinition[Name='${a.name}']`,
            "[ProductClassificationAttributeId]": `REF:ProductClassificationAttr[Name='${a.name} Classification'] — from Step 1`,
          })),
        },
      ],
    },
    // Batch 7 (8) — Runtime Value Persistence: default/configured values per attribute
    {
      operation: "findOrCreate",
      sObjectType: "ProductAttributeDefinitionValue",
      note: "Candidates: ProductAttributeDefinitionValue, AttributeDefinitionValue, ProductAttributeDefinitionOverride — discovered at runtime via safeDescribe",
      records: d.attributes.map(a => ({
        Name: `${a.name} Value`,
        "[PAD_FK]": `REF:ProductAttributeDefinition[Name='${a.name}'] — FK detected at runtime`,
        Value: a.defaultValue ?? (a.values.length > 0 ? a.values[0] : a.dataType === "Boolean" ? "false" : "0"),
        IsActive: true,
      })),
    },
    // Batch 8 (9) — Commercial Enablement: Catalog + Category + SellingModel + PricebookEntry
    {
      operation: "sequential",
      steps: [
        { sObjectType: "ProductCatalog",  op: "findOrCreate", searchOn: ["Name"], record: { Name: catalogName } },
        { sObjectType: "ProductCategory", op: "findOrCreate", searchOn: ["Name"],
          record: { Name: d.categoryName, CatalogId: `REF:ProductCatalog[Name='${catalogName}']` } },
        { sObjectType: "ProductCategoryProduct", op: "findOrCreate",
          record: { "[Product2FK]": `REF:Product2[ProductCode='${d.productCode}']`,
                    ProductCategoryId: `REF:ProductCategory[Name='${d.categoryName}']` } },
        { sObjectType: "ProductSellingModel", op: "findOrCreate", searchOn: ["Name"],
          record: { Name: d.sellingModel, SellingModelType: smType, Status: "Active" } },
        { sObjectType: "ProductSellingModelOption", op: "findOrCreate",
          record: { "[Product2FK]": `REF:Product2[ProductCode='${d.productCode}']`,
                    ProductSellingModelId: `REF:ProductSellingModel[Name='${d.sellingModel}']` },
          note: "Product FK field detected at runtime" },
        { sObjectType: "PricebookEntry", op: "findOrCreate",
          record: { Product2Id: `REF:Product2[ProductCode='${d.productCode}']`,
                    Pricebook2Id: "REF:Pricebook2[IsStandard=true]",
                    UnitPrice: 0, IsActive: d.isActive },
          note: "Standard Pricebook at $0 — required for RCA commercial enablement" },
      ],
    },
  ];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Icon component (inline SVG)
 * ─────────────────────────────────────────────────────────────────────────── */
function Ic({ n, s = 14 }: { n: string; s?: number }) {
  const P: Record<string, React.ReactNode> = {
    sparkles:      <><path d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></>,
    send:          <><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></>,
    "check-circle":<><path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>,
    "alert-circle":<><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>,
    loader:        <><line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="4.93" y1="4.93" x2="7.76" y2="7.76" /><line x1="16.24" y1="16.24" x2="19.07" y2="19.07" /><line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" /><line x1="4.93" y1="19.07" x2="7.76" y2="16.24" /><line x1="16.24" y1="7.76" x2="19.07" y2="4.93" /></>,
    play:          <polygon points="5 3 19 12 5 21 5 3" />,
    code:          <><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>,
    terminal:      <><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>,
    layers:        <><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></>,
    list:          <><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></>,
    activity:      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
    info:          <><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></>,
    copy:          <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></>,
    refresh:       <><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></>,
    package:       <><line x1="16.5" y1="9.4" x2="7.55" y2="4.24" /><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></>,
    x:             <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
    eye:           <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>,
    zap:           <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
  };
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {P[n] ?? <circle cx="12" cy="12" r="5" />}
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DataType Badge
 * ─────────────────────────────────────────────────────────────────────────── */
function DataTypeBadge({ type }: { type: string }) {
  const c = DT_CONFIG[type] ?? DT_CONFIG.Text;
  return (
    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0"
      style={{ color: c.color, background: c.bg, border: `1px solid ${c.color}35` }}>
      {type}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Product Context Summary Card
 * ─────────────────────────────────────────────────────────────────────────── */
function ProductContextCard({ data, isDark }: { data: ParsedRCAData; isDark: boolean }) {
  const fields = [
    { label: "Product Name",    value: data.productName },
    { label: "Product Code",    value: data.productCode },
    { label: "Product Family",  value: data.productFamily },
    { label: "Product Type",    value: data.productType },
    { label: "Selling Model",   value: data.sellingModel },
    { label: "Classification",  value: data.classificationName },
    { label: "Category",        value: data.categoryName },
    { label: "Unit Of Measure", value: data.unitOfMeasure },
  ];
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl p-3 mb-3"
      style={{
        background: isDark ? "rgba(0,212,255,0.04)" : "rgba(0,212,255,0.04)",
        border: "1px solid rgba(0,212,255,0.18)",
      }}
    >
      <div className="flex items-center gap-2 mb-2.5">
        <span style={{ color: ACCENT }}><Ic n="package" s={12} /></span>
        <span className="text-[10px] font-semibold tracking-widest uppercase" style={{ color: ACCENT }}>
          Product Context Summary
        </span>
        <span className="ml-auto text-[9px] font-mono px-2 py-0.5 rounded-full"
          style={{ background: "rgba(0,212,255,0.1)", color: ACCENT, border: "1px solid rgba(0,212,255,0.2)" }}>
          RCA DEPLOYMENT HEADER
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
        {fields.map(f => (
          <div key={f.label} className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[9px] font-medium tracking-wider uppercase truncate"
              style={{ color: isDark ? "rgba(0,212,255,0.45)" : "rgba(0,112,214,0.45)" }}>
              {f.label}
            </span>
            <span className="text-[11px] font-semibold truncate"
              style={{ color: isDark ? "rgba(220,240,230,0.9)" : "#001F5B" }}>
              {f.value || "—"}
            </span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Attribute Card
 * ─────────────────────────────────────────────────────────────────────────── */
function AttributeCard({ attr, idx, isDark }: { attr: ParsedAttribute; idx: number; isDark: boolean }) {
  const c = DT_CONFIG[attr.dataType] ?? DT_CONFIG.Text;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: idx * 0.025, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-xl p-3 flex flex-col gap-2"
      style={{
        background: isDark ? "rgba(6,12,28,0.65)" : "rgba(228,241,255,0.90)",
        border: isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,112,214,0.1)",
        backdropFilter: "blur(8px)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12px] font-semibold leading-tight flex-1 min-w-0"
          style={{ color: isDark ? "rgba(220,240,230,0.9)" : "#001F5B" }}>
          {attr.name}
        </span>
        <DataTypeBadge type={attr.dataType} />
      </div>
      <p className="text-[10px] leading-relaxed"
        style={{ color: isDark ? "rgba(100,130,170,0.6)" : "rgba(0,15,55,0.74)" }}>
        {attr.description}
      </p>
      <div className="flex flex-wrap gap-1.5 items-center">
        {attr.configurable && (
          <span className="text-[9px] px-1.5 py-0.5 rounded font-medium"
            style={{ background: "rgba(30,144,255,0.12)", color: "#1E90FF" }}>
            Configurable
          </span>
        )}
        {attr.required && (
          <span className="text-[9px] px-1.5 py-0.5 rounded font-medium"
            style={{ background: "rgba(239,68,68,0.1)", color: "#EF4444" }}>
            Required
          </span>
        )}
        {attr.defaultValue && (
          <span className="text-[9px] px-1.5 py-0.5 rounded font-mono"
            style={{ background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)", color: isDark ? "rgba(180,210,240,0.7)" : "rgba(0,15,55,0.78)" }}>
            default: {attr.defaultValue}
          </span>
        )}
      </div>
      {attr.values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {attr.values.map(v => (
            <span key={v} className="text-[9px] px-1.5 py-0.5 rounded"
              style={{ background: c.bg, color: c.color, border: `1px solid ${c.color}28` }}>
              {v}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Batch Row
 * ─────────────────────────────────────────────────────────────────────────── */
function BatchRow({
  def, state, payload, isDark, canExecute, onExecute,
}: {
  def: (typeof BATCH_DEFS)[0];
  state: BatchState;
  payload: unknown;
  isDark: boolean;
  canExecute: boolean;
  onExecute: () => void;
}) {
  const [showJson, setShowJson] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [copied, setCopied] = useState(false);

  const statusColor = state.status === "success" ? ACCENT
    : state.status === "failed" ? "#FF4066"
    : state.status === "running" ? ACCENT_CYAN
    : isDark ? "rgba(90,120,160,0.45)" : "rgba(0,31,91,0.56)";

  const statusLabel = { idle: "Pending", running: "Running", success: "Complete", failed: "Failed" }[state.status];

  const jsonStr = JSON.stringify(payload, null, 2);

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonStr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const borderColor = state.status === "success" ? "rgba(0,212,255,0.28)"
    : state.status === "failed" ? "rgba(255,64,102,0.28)"
    : state.status === "running" ? "rgba(0,212,255,0.28)"
    : isDark ? "rgba(0,212,255,0.08)" : "rgba(0,112,214,0.1)";

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ border: `1px solid ${borderColor}`, background: isDark ? "rgba(4,10,22,0.72)" : "rgba(255,255,255,0.68)", backdropFilter: "blur(8px)" }}>

      {/* Main row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-[10px] font-bold"
          style={{ background: `${statusColor}18`, color: statusColor, border: `1px solid ${statusColor}38` }}>
          {def.id}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px] font-semibold" style={{ color: isDark ? "rgba(220,240,230,0.9)" : "#001F5B" }}>
              {def.name}
            </span>
            <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
              style={{ background: `${statusColor}15`, color: statusColor, border: `1px solid ${statusColor}30` }}>
              {statusLabel}
            </span>
          </div>
          <p className="text-[10px] mt-0.5 truncate"
            style={{ color: isDark ? "rgba(90,120,160,0.58)" : "rgba(0,15,55,0.70)" }}>
            {def.desc}
          </p>
        </div>

        {state.status === "running" && (
          <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            style={{ color: ACCENT_CYAN }}>
            <Ic n="loader" s={13} />
          </motion.span>
        )}
        {state.status === "success" && <span style={{ color: ACCENT }}><Ic n="check-circle" s={13} /></span>}
        {state.status === "failed"  && <span style={{ color: "#FF4066" }}><Ic n="alert-circle" s={13} /></span>}

        <div className="flex items-center gap-1.5 shrink-0">
          <motion.button onClick={() => setShowJson(v => !v)}
            className="text-[10px] px-2 py-1 rounded-lg cursor-pointer"
            style={{ color: isDark ? "rgba(0,212,255,0.65)" : "rgba(0,112,214,0.65)", border: `1px solid ${isDark ? "rgba(0,212,255,0.14)" : "rgba(0,112,214,0.12)"}` }}
            whileHover={{ background: "rgba(0,212,255,0.06)" }} whileTap={{ scale: 0.96 }}>
            <Ic n="code" s={11} />
          </motion.button>
          {state.logs.length > 0 && (
            <motion.button onClick={() => setShowLogs(v => !v)}
              className="text-[10px] px-2 py-1 rounded-lg cursor-pointer"
              style={{ color: isDark ? "rgba(0,212,255,0.65)" : "rgba(0,71,171,0.6)", border: `1px solid ${isDark ? "rgba(0,212,255,0.14)" : "rgba(0,71,171,0.22)"}` }}
              whileHover={{ background: "rgba(0,212,255,0.06)" }} whileTap={{ scale: 0.96 }}>
              <Ic n="terminal" s={11} />
            </motion.button>
          )}
          <motion.button
            onClick={onExecute}
            disabled={!canExecute || state.status === "running"}
            className="flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1.5 rounded-lg cursor-pointer"
            style={{
              background: canExecute && state.status !== "running"
                ? `linear-gradient(135deg, ${ACCENT_CYAN} 0%, ${ACCENT} 100%)`
                : isDark ? "rgba(0,212,255,0.06)" : "rgba(0,212,255,0.04)",
              color: canExecute && state.status !== "running"
                ? "rgba(0,10,20,0.9)" : isDark ? "rgba(0,212,255,0.28)" : "rgba(0,112,214,0.22)",
              opacity: state.status === "running" ? 0.6 : 1,
            }}
            whileHover={canExecute && state.status !== "running" ? { scale: 1.04 } : {}}
            whileTap={canExecute && state.status !== "running" ? { scale: 0.96 } : {}}>
            <Ic n={state.status === "failed" ? "refresh" : "play"} s={10} />
            {state.status === "failed" ? "Retry" : state.status === "success" ? "Re-run" : "Execute"}
          </motion.button>
        </div>
      </div>

      {/* Running progress shimmer */}
      {state.status === "running" && (
        <div className="h-0.5 w-full overflow-hidden" style={{ background: "rgba(0,212,255,0.08)" }}>
          <motion.div className="h-full" style={{ background: `linear-gradient(90deg, transparent, ${ACCENT_CYAN}, ${ACCENT}, transparent)` }}
            animate={{ x: ["-100%", "200%"] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }} />
        </div>
      )}
      {state.status === "success" && (
        <div className="h-0.5 w-full" style={{ background: "rgba(0,212,255,0.22)" }} />
      )}

      {/* JSON Preview panel */}
      <AnimatePresence>
        {showJson && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="px-4 pb-3 mx-4 mb-3">
              <div className="rounded-lg overflow-hidden"
                style={{ background: isDark ? "rgba(0,0,0,0.55)" : "rgba(236,246,255,0.85)", border: isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,112,214,0.1)" }}>
                <div className="flex items-center justify-between px-3 py-2"
                  style={{ borderBottom: isDark ? "1px solid rgba(0,212,255,0.08)" : "1px solid rgba(0,112,214,0.07)" }}>
                  <span className="text-[9px] font-mono font-bold uppercase tracking-widest" style={{ color: ACCENT }}>
                    Batch {def.id} · Salesforce JSON Payload
                  </span>
                  <motion.button onClick={handleCopy}
                    className="flex items-center gap-1 text-[9px] px-2 py-0.5 rounded cursor-pointer"
                    style={{ color: isDark ? "rgba(0,212,255,0.6)" : "rgba(0,112,214,0.6)" }}
                    whileTap={{ scale: 0.92 }}>
                    <Ic n="copy" s={9} />
                    {copied ? "Copied!" : "Copy"}
                  </motion.button>
                </div>
                <pre className="text-[10px] font-mono px-3 py-2 overflow-x-auto"
                  style={{ color: isDark ? "rgba(0,212,255,0.82)" : "rgba(0,80,40,0.82)", maxHeight: 200, overflowY: "auto", scrollbarWidth: "thin" }}>
                  {jsonStr}
                </pre>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Execution logs */}
      <AnimatePresence>
        {showLogs && state.logs.length > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="px-4 pb-3 mx-4 mb-3">
              <div className="rounded-lg px-3 py-2"
                style={{ background: isDark ? "rgba(0,0,0,0.4)" : "rgba(240,248,255,0.85)", border: isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,71,171,0.20)", maxHeight: 160, overflowY: "auto", scrollbarWidth: "thin" }}>
                <span className="block text-[9px] font-mono font-bold uppercase tracking-widest mb-1.5" style={{ color: ACCENT_CYAN }}>
                  Execution Log
                </span>
                {state.logs.map((log, i) => (
                  <div key={i} className="text-[10px] font-mono mb-0.5"
                    style={{
                      color: log.includes("✗") || log.includes("[ERROR]") || log.includes("[STORAGE LIMIT]") || log.includes("[ORG STORAGE]") || log.includes("[PICKLIST_MISMATCH]") ? "#FF6080"
                        : log.includes("✓") || log.includes("[SUCCESS]") || log.includes("[VALIDATION]") ? ACCENT
                        : log.includes("[REUSE]") || log.includes("[CACHE]") || log.includes("[PREFETCH]") || log.includes("[RECOVERY]") || log.includes("[PICKLIST_DEBUG]") || log.includes("[PCA_DEBUG]") || log.includes("[PICKLIST_COMPAT]") ? ACCENT_CYAN
                        : log.includes("[ATTR_DEBUG]") || log.includes("[CREATE]") || log.includes("[SUMMARY]") ? "#3AABFF"
                        : isDark ? "rgba(180,210,240,0.72)" : "rgba(0,31,91,0.68)",
                    }}>
                    {log}
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Analysis Table — AI attribute decision overview
 * ─────────────────────────────────────────────────────────────────────────── */
function decisionLabel(attr: ParsedAttribute): { label: string; color: string; bg: string } {
  if (!attr.configurable) return { label: "Informational", color: "#60B8FF", bg: "rgba(96,184,255,0.10)" };
  const lower = (attr.dataType ?? "").toLowerCase();
  if (lower === "picklist" || attr.values.length > 0)
    return { label: "Picklist Attr",  color: "#1E90FF", bg: "rgba(30,144,255,0.12)" };
  if (lower === "boolean" || lower === "checkbox")
    return { label: "Boolean Attr",   color: "#3AABFF", bg: "rgba(58,171,255,0.12)" };
  if (lower === "number")
    return { label: "Number Attr",    color: "#00D4FF", bg: "rgba(0,212,255,0.11)" };
  return { label: "Text Attr", color: "#0070D6", bg: "rgba(0,112,214,0.10)" };
}

function displayTypeLabel(attr: ParsedAttribute): string {
  const lower = (attr.dataType ?? "").toLowerCase();
  if (lower === "picklist" || lower === "enum" || lower === "select") return "ComboBox";
  if (lower === "boolean" || lower === "checkbox")                    return "Checkbox";
  if (lower === "number")                                             return "Number";
  return "Text";
}

function AnalysisTable({ attrs, skipped, isDark }: {
  attrs: ParsedAttribute[];
  skipped: { name: string; reason: string }[];
  isDark: boolean;
}) {
  const headerColor = isDark ? "rgba(0,212,255,0.45)" : "rgba(0,112,214,0.45)";
  const rowBg       = isDark ? "rgba(4,10,22,0.55)"   : "rgba(222,235,255,0.85)";
  const borderColor = isDark ? "rgba(0,212,255,0.08)"  : "rgba(0,112,214,0.08)";

  const cols = ["#", "Attribute Name", "Detected Type", "DisplayType", "Configurable", "Decision", "Values"];
  return (
    <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${borderColor}` }}>
      {/* Header row */}
      <div className="grid text-[9px] font-semibold tracking-widest uppercase px-3 py-2"
        style={{
          background: isDark ? "rgba(0,212,255,0.05)" : "rgba(0,212,255,0.04)",
          borderBottom: `1px solid ${borderColor}`,
          gridTemplateColumns: "28px 1fr 90px 80px 80px 110px 1fr",
          color: headerColor,
        }}>
        {cols.map(c => <span key={c}>{c}</span>)}
      </div>

      {/* Attribute rows */}
      {attrs.map((attr, i) => {
        const dt  = DT_CONFIG[attr.dataType] ?? DT_CONFIG.Text;
        const dec = decisionLabel(attr);
        const dsp = displayTypeLabel(attr);
        return (
          <div key={attr.name}
            className="grid items-center px-3 py-2 text-[10px]"
            style={{
              gridTemplateColumns: "28px 1fr 90px 80px 80px 110px 1fr",
              background: i % 2 === 0 ? rowBg : "transparent",
              borderBottom: `1px solid ${borderColor}`,
            }}>
            <span className="font-mono" style={{ color: isDark ? "rgba(90,120,160,0.5)" : "rgba(0,31,91,0.35)" }}>{i + 1}</span>
            <span className="font-semibold truncate pr-2" style={{ color: isDark ? "rgba(220,240,230,0.9)" : "#001F5B" }}>{attr.name}</span>
            <span>
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                style={{ background: dt.bg, color: dt.color, border: `1px solid ${dt.color}35` }}>
                {attr.dataType}
              </span>
            </span>
            <span className="text-[9px] font-mono" style={{ color: isDark ? "rgba(180,210,240,0.7)" : "rgba(0,15,55,0.78)" }}>{dsp}</span>
            <span>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${attr.configurable ? "" : ""}`}
                style={{
                  background: attr.configurable ? "rgba(0,212,255,0.10)" : "rgba(90,122,154,0.08)",
                  color: attr.configurable ? "#00D4FF" : isDark ? "rgba(150,170,190,0.7)" : "rgba(80,100,120,0.7)",
                  border: `1px solid ${attr.configurable ? "rgba(0,212,255,0.25)" : "rgba(90,122,154,0.18)"}`,
                }}>
                {attr.configurable ? "Yes" : "No"}
              </span>
            </span>
            <span>
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                style={{ background: dec.bg, color: dec.color, border: `1px solid ${dec.color}35` }}>
                {dec.label}
              </span>
            </span>
            <span className="font-mono truncate" style={{ color: isDark ? "rgba(0,212,255,0.65)" : "rgba(0,71,171,0.6)" }}>
              {attr.values.length > 0
                ? attr.values.slice(0, 3).join(", ") + (attr.values.length > 3 ? ` +${attr.values.length - 3}` : "")
                : attr.defaultValue ?? "—"}
            </span>
          </div>
        );
      })}

      {/* Skipped / Rejected rows */}
      {skipped.map((f, i) => (
        <div key={`sk-${f.name}`}
          className="grid items-center px-3 py-2 text-[10px]"
          style={{
            gridTemplateColumns: "28px 1fr 90px 80px 80px 110px 1fr",
            background: "rgba(255,64,102,0.03)",
            borderBottom: `1px solid rgba(255,64,102,0.1)`,
            opacity: 0.72,
          }}>
          <span className="font-mono" style={{ color: "rgba(255,64,102,0.4)" }}>{attrs.length + i + 1}</span>
          <span className="font-semibold truncate pr-2" style={{ color: isDark ? "rgba(255,180,180,0.75)" : "rgba(120,0,0,0.65)" }}>{f.name}</span>
          <span className="text-[9px]" style={{ color: isDark ? "rgba(255,100,100,0.5)" : "rgba(150,0,0,0.45)" }}>—</span>
          <span>—</span>
          <span>—</span>
          <span>
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
              style={{ background: "rgba(255,64,102,0.1)", color: "#FF6080", border: "1px solid rgba(255,64,102,0.25)" }}>
              Rejected
            </span>
          </span>
          <span className="truncate text-[9px]" style={{ color: isDark ? "rgba(255,100,100,0.55)" : "rgba(120,0,0,0.5)" }}>{f.reason}</span>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * RCA Dependency Graph — visual deployment order + relationship map
 * ─────────────────────────────────────────────────────────────────────────── */
const GRAPH_NODES = [
  { idx: 0, obj: "Datatype Detection",          sfObj: null,                              deps: [],        color: "#60B8FF" },
  { idx: 1, obj: "AttributePicklist",           sfObj: "AttributePicklist",               deps: [],        color: "#1E90FF" },
  { idx: 2, obj: "AttributePicklistValue",      sfObj: "AttributePicklistValue",          deps: [1],       color: "#3AABFF" },
  { idx: 3, obj: "AttrDefinition + Category",   sfObj: "AttributeDefinition",             deps: [1, 2],    color: "#0070D6" },
  { idx: 4, obj: "ProductClassification",       sfObj: "ProductClassification",           deps: [],        color: "#0047AB" },
  { idx: 5, obj: "Product2",                    sfObj: "Product2",                        deps: [],        color: "#2563EB" },
  { idx: 6, obj: "PCA + PAD Mapping",           sfObj: "ProductAttributeDefinition",      deps: [3, 4, 5], color: "#00D4FF" },
  { idx: 7, obj: "Runtime Value Persistence",   sfObj: "ProductAttributeDefinitionValue", deps: [6],       color: "#29A8E0" },
  { idx: 8, obj: "Commercial Enablement",       sfObj: "ProductSellingModelOption",       deps: [5],       color: "#4299E1" },
];

function RCADependencyGraph({ batchStates, isDark }: { batchStates: BatchState[]; isDark: boolean }) {
  return (
    <div className="rounded-xl p-4 mb-4"
      style={{ background: isDark ? "rgba(0,0,0,0.45)" : "rgba(236,246,255,0.85)",
               border: isDark ? "1px solid rgba(0,212,255,0.12)" : "1px solid rgba(0,71,171,0.20)" }}>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[9px] font-mono font-bold uppercase tracking-widest" style={{ color: ACCENT_CYAN }}>
          RCA Object Dependency Graph
        </span>
        <span className="text-[8px] px-1.5 py-0.5 rounded font-mono"
          style={{ background: "rgba(0,212,255,0.1)", color: ACCENT_CYAN, border: "1px solid rgba(0,212,255,0.2)" }}>
          deployment order
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {GRAPH_NODES.map(node => {
          const status = batchStates[node.idx]?.status ?? "idle";
          const statusColor = status === "success" ? ACCENT
            : status === "failed"  ? "#FF4066"
            : status === "running" ? ACCENT_CYAN
            : isDark ? "rgba(90,120,160,0.35)" : "rgba(74,106,160,0.3)";
          return (
            <div key={node.idx} className="flex items-start gap-2.5">
              {/* Step number */}
              <div className="w-5 h-5 rounded flex items-center justify-center shrink-0 text-[9px] font-bold mt-0.5"
                style={{ background: `${statusColor}18`, color: statusColor, border: `1px solid ${statusColor}38` }}>
                {node.idx + 1}
              </div>
              {/* Node body */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-semibold"
                    style={{ color: isDark ? "rgba(210,235,255,0.88)" : "#001F5B" }}>
                    {node.obj}
                  </span>
                  {node.sfObj && (
                    <span className="text-[8px] font-mono px-1.5 py-0.5 rounded shrink-0"
                      style={{ background: `${node.color}14`, color: node.color, border: `1px solid ${node.color}30` }}>
                      {node.sfObj}
                    </span>
                  )}
                  {status === "success" && (
                    <span className="text-[8px] px-1.5 py-0.5 rounded font-medium shrink-0"
                      style={{ background: "rgba(0,212,255,0.1)", color: ACCENT, border: "1px solid rgba(0,212,255,0.22)" }}>
                      ✓ done
                    </span>
                  )}
                  {status === "failed" && (
                    <span className="text-[8px] px-1.5 py-0.5 rounded font-medium shrink-0"
                      style={{ background: "rgba(255,64,102,0.1)", color: "#FF4066", border: "1px solid rgba(255,64,102,0.22)" }}>
                      ✗ failed
                    </span>
                  )}
                </div>
                {node.deps.length > 0 && (
                  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                    <span className="text-[8px]" style={{ color: isDark ? "rgba(90,120,160,0.5)" : "rgba(0,31,91,0.38)" }}>
                      requires:
                    </span>
                    {node.deps.map(di => (
                      <span key={di} className="text-[8px] font-mono px-1 py-0.5 rounded"
                        style={{
                          background: batchStates[di]?.status === "success"
                            ? "rgba(0,212,255,0.08)" : isDark ? "rgba(90,120,160,0.1)" : "rgba(0,31,91,0.05)",
                          color: batchStates[di]?.status === "success"
                            ? ACCENT : isDark ? "rgba(120,150,180,0.65)" : "rgba(0,15,55,0.74)",
                          border: `1px solid ${batchStates[di]?.status === "success" ? "rgba(0,212,255,0.2)" : "rgba(90,120,160,0.15)"}`,
                        }}>
                        #{di + 1} {GRAPH_NODES[di].sfObj ?? GRAPH_NODES[di].obj}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-3 mt-3 pt-2.5"
        style={{ borderTop: isDark ? "1px solid rgba(90,120,160,0.15)" : "1px solid rgba(0,31,91,0.07)" }}>
        {[
          { label: "Pending",  c: isDark ? "rgba(90,120,160,0.35)" : "rgba(74,106,160,0.3)" },
          { label: "Running",  c: ACCENT_CYAN },
          { label: "Complete", c: ACCENT },
          { label: "Failed",   c: "#FF4066" },
        ].map(({ label, c }) => (
          <div key={label} className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: c }} />
            <span className="text-[8px]" style={{ color: isDark ? "rgba(90,120,160,0.6)" : "rgba(0,15,55,0.70)" }}>
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Storage Health Panel
 * ─────────────────────────────────────────────────────────────────────────── */
function StorageHealthPanel({ health, isDark }: { health: StorageHealth; isDark: boolean }) {
  const totalOps   = health.reuseCount + health.createCount + health.storageErrors;
  const reuseObjs  = Object.entries(health.reusedObjects);
  const failedObjs = Object.entries(health.failedObjects);
  const hasActivity = totalOps > 0 || health.storageWarning;
  if (!hasActivity) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl p-3 mb-3"
      style={{
        background: health.storageWarning
          ? (isDark ? "rgba(255,64,102,0.05)" : "rgba(255,64,102,0.04)")
          : (isDark ? "rgba(0,212,255,0.04)" : "rgba(0,71,171,0.09)"),
        border: health.storageWarning
          ? "1px solid rgba(255,64,102,0.25)"
          : "1px solid rgba(0,212,255,0.18)",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2.5 flex-wrap">
        <span className="text-[9px] font-mono font-bold uppercase tracking-widest"
          style={{ color: health.storageWarning ? "#FF6080" : ACCENT_CYAN }}>
          Storage Health
        </span>
        {health.storageWarning && (
          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full animate-pulse"
            style={{ background: "rgba(255,64,102,0.12)", color: "#FF6080", border: "1px solid rgba(255,64,102,0.3)" }}>
            ⚠ Org Storage Exhausted
          </span>
        )}
      </div>

      {/* Counters */}
      <div className="grid grid-cols-3 gap-2 mb-2.5">
        {[
          { label: "Reused",  value: health.reuseCount,    color: ACCENT_CYAN },
          { label: "Created", value: health.createCount,   color: ACCENT },
          { label: "Errors",  value: health.storageErrors, color: health.storageErrors > 0 ? "#FF6080" : isDark ? "rgba(90,120,160,0.5)" : "rgba(0,15,55,0.65)" },
        ].map(s => (
          <div key={s.label} className="rounded-lg px-2 py-1.5 text-center"
            style={{ background: isDark ? "rgba(0,0,0,0.25)" : "rgba(218,232,255,0.80)", border: `1px solid ${s.color}20` }}>
            <div className="text-[15px] font-black font-mono" style={{ color: s.color }}>{s.value}</div>
            <div className="text-[8px] font-medium uppercase tracking-wider mt-0.5"
              style={{ color: isDark ? "rgba(90,120,160,0.6)" : "rgba(0,15,55,0.70)" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Per-object breakdown */}
      {(reuseObjs.length > 0 || failedObjs.length > 0) && (
        <div className="flex flex-col gap-1 mb-2.5">
          {reuseObjs.map(([obj, count]) => (
            <div key={`r-${obj}`} className="flex items-center justify-between">
              <span className="text-[9px] font-mono truncate" style={{ color: isDark ? "rgba(180,210,240,0.65)" : "rgba(0,15,55,0.78)" }}>{obj}</span>
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ml-2"
                style={{ background: "rgba(0,212,255,0.1)", color: ACCENT_CYAN, border: "1px solid rgba(0,212,255,0.22)" }}>
                {count} reused
              </span>
            </div>
          ))}
          {failedObjs.map(([obj, count]) => (
            <div key={`f-${obj}`} className="flex items-center justify-between">
              <span className="text-[9px] font-mono truncate" style={{ color: isDark ? "rgba(255,120,130,0.75)" : "rgba(160,0,20,0.65)" }}>{obj}</span>
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ml-2"
                style={{ background: "rgba(255,64,102,0.1)", color: "#FF6080", border: "1px solid rgba(255,64,102,0.25)" }}>
                {count} storage err
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Org storage warning message */}
      {health.storageWarning && (
        <div className="rounded-lg px-3 py-2.5 flex items-start gap-2"
          style={{ background: "rgba(255,64,102,0.07)", border: "1px solid rgba(255,64,102,0.18)" }}>
          <span className="shrink-0" style={{ color: "#FF6080", marginTop: 1 }}><Ic n="alert-circle" s={12} /></span>
          <p className="text-[10px] leading-relaxed" style={{ color: isDark ? "rgba(255,160,160,0.85)" : "rgba(150,0,0,0.75)" }}>
            This Salesforce org has exhausted available RCA metadata/data storage.
            Clean old test RCA records (AttributePicklist, AttributeDefinition, Product2, etc.) or use a fresh org to continue deployment.
          </p>
        </div>
      )}
    </motion.div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Main component
 * ─────────────────────────────────────────────────────────────────────────── */
export default function RCAAttributeStudio({ isDark }: { isDark: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [parsedData, setParsedData] = useState<ParsedRCAData | null>(null);
  const [batchPayloads, setBatchPayloads] = useState<unknown[]>([]);
  const [batchStates, setBatchStates] = useState<BatchState[]>(
    () => Array(9).fill(null).map(() => ({ status: "idle" as BatchStatus, logs: [] }))
  );
  const [batchCtx, setBatchCtx] = useState<BatchContext>({});
  const [allLogs, setAllLogs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<"attributes" | "execution" | "console" | "product" | "skipped">("attributes");
  const [genError, setGenError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [isDeployingAll, setIsDeployingAll] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [attrView, setAttrView]   = useState<"cards" | "table">("cards");
  const [cumulativeHealth, setCumulativeHealth] = useState<StorageHealth>(emptyHealth);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const border = isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,112,214,0.1)";

  const appendLog = useCallback((msg: string) => {
    setAllLogs(prev => [...prev, msg]);
  }, []);

  const handleGenerate = async () => {
    if (!prompt.trim() || isGenerating) return;
    setIsGenerating(true);
    setGenError(null);
    setParsedData(null);
    setBatchStates(Array(9).fill(null).map(() => ({ status: "idle" as BatchStatus, logs: [] })));
    setBatchCtx({});
    setCumulativeHealth(emptyHealth());
    setAllLogs([`[${new Date().toISOString()}] Initiating RCA semantic attribute analysis…`]);

    try {
      const res = await fetch("/api/sf/attributes/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        const msg = data.error ?? "AI parsing failed";
        setGenError(msg);
        appendLog(`[ERROR] ${msg}`);
        return;
      }
      setParsedData(data.data);
      setBatchPayloads(generateBatchPayloads(data.data));
      appendLog(`[SUCCESS] Generated ${data.data.attributes.length} attribute(s), ${data.data.skipped?.length ?? 0} field(s) rejected by eligibility filter`);
      setActiveTab("attributes");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setGenError(msg);
      appendLog(`[ERROR] ${msg}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExecuteBatch = useCallback(async (batchIndex: number) => {
    if (!parsedData) return;
    setBatchStates(prev => {
      const next = [...prev];
      next[batchIndex] = { status: "running", logs: [] };
      return next;
    });
    appendLog(`[${new Date().toISOString()}] Executing Batch ${batchIndex + 1}: ${BATCH_DEFS[batchIndex].name}`);
    try {
      const res = await fetch("/api/sf/attributes/execute-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchIndex, parsedData, context: batchCtx }),
      });
      const data = await res.json();
      if (Array.isArray(data.logs)) data.logs.forEach((l: string) => appendLog(l));
      if (data.context) setBatchCtx(data.context);
      if (data.storageHealth) setCumulativeHealth(prev => mergeHealth(prev, data.storageHealth));
      setBatchStates(prev => {
        const next = [...prev];
        next[batchIndex] = {
          status: res.ok && data.success !== false ? "success" : "failed",
          logs: data.logs ?? [],
        };
        return next;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Batch failed";
      appendLog(`[ERROR] Batch ${batchIndex + 1}: ${msg}`);
      setBatchStates(prev => {
        const next = [...prev];
        next[batchIndex] = { status: "failed", logs: [`[ERROR] ${msg}`] };
        return next;
      });
    }
  }, [parsedData, batchCtx, appendLog]);

  const handleReset = () => {
    setParsedData(null);
    setBatchStates(Array(9).fill(null).map(() => ({ status: "idle" as BatchStatus, logs: [] })));
    setBatchCtx({});
    setAllLogs([]);
    setGenError(null);
    setCumulativeHealth(emptyHealth());
  };

  const handleDeployAll = async () => {
    if (!parsedData || isDeployingAll) return;
    setIsDeployingAll(true);
    setActiveTab("execution");
    let currentCtx: BatchContext = batchCtx;

    for (let i = 0; i < 9; i++) {
      setBatchStates(prev => {
        const next = [...prev];
        next[i] = { status: "running", logs: [] };
        return next;
      });
      appendLog(`[${new Date().toISOString()}] Executing Batch ${i + 1}: ${BATCH_DEFS[i].name}`);

      try {
        const res = await fetch("/api/sf/attributes/execute-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchIndex: i, parsedData, context: currentCtx }),
        });
        const data = await res.json();
        if (Array.isArray(data.logs)) data.logs.forEach((l: string) => appendLog(l));
        if (data.context) {
          currentCtx = data.context;
          setBatchCtx(data.context);
        }
        if (data.storageHealth) setCumulativeHealth(prev => mergeHealth(prev, data.storageHealth));
        const succeeded = res.ok && data.success !== false;
        setBatchStates(prev => {
          const next = [...prev];
          next[i] = { status: succeeded ? "success" : "failed", logs: data.logs ?? [] };
          return next;
        });
        if (!succeeded) {
          appendLog(`[WARN] Batch ${i + 1} failed — stopping deployment`);
          break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Batch failed";
        appendLog(`[ERROR] Batch ${i + 1}: ${msg}`);
        setBatchStates(prev => {
          const next = [...prev];
          next[i] = { status: "failed", logs: [`[ERROR] ${msg}`] };
          return next;
        });
        break;
      }
    }

    setIsDeployingAll(false);
  };

  const completedBatches = batchStates.filter(b => b.status === "success").length;
  const canExecuteBatch = (i: number) => i === 0 || batchStates[i - 1].status === "success" || batchStates[i - 1].status === "failed";

  /* ── Loading state ──────────────────────────────────────────────────────── */
  if (isGenerating) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-5">
        <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
          style={{ color: ACCENT }}>
          <Ic n="loader" s={38} />
        </motion.div>
        <div className="text-center">
          <p className="text-[14px] font-semibold mb-1" style={{ color: isDark ? "rgba(0,212,255,0.9)" : "rgba(0,112,214,0.85)" }}>
            Semantic AI Analysis in Progress
          </p>
          <p className="text-[11px]" style={{ color: isDark ? "rgba(90,120,160,0.6)" : "rgba(0,15,55,0.70)" }}>
            Reasoning like an RCA business architect…
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2 max-w-xs">
          {["Eligibility Filtering", "Datatype Inference", "Configurable vs Informational", "Picklist Detection"].map(s => (
            <motion.span key={s} animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.6, repeat: Infinity, delay: Math.random() * 1 }}
              className="text-[9px] font-mono px-2 py-1 rounded-full"
              style={{ background: "rgba(0,212,255,0.06)", color: ACCENT, border: "1px solid rgba(0,212,255,0.15)" }}>
              {s}
            </motion.span>
          ))}
        </div>
      </div>
    );
  }

  /* ── Pre-generation prompt view ─────────────────────────────────────────── */
  if (!parsedData) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Studio header */}
        <div className="px-6 py-4 shrink-0" style={{ borderBottom: border }}>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "linear-gradient(135deg, rgba(0,212,255,0.18) 0%, rgba(0,212,255,0.1) 100%)", border: "1px solid rgba(0,212,255,0.28)", color: ACCENT, boxShadow: "0 0 20px rgba(0,212,255,0.1)" }}>
              <Ic n="layers" s={18} />
            </div>
            <div>
              <h2 className="text-[16px] font-bold" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.02em" }}>
                RCA Attribute Creation Studio
              </h2>
              <p className="text-[11px]" style={{ color: isDark ? "rgba(0,212,255,0.6)" : "rgba(0,112,214,0.65)" }}>
                AI-powered Revenue Cloud Advanced attribute generation & deployment orchestration
              </p>
            </div>
            <div className="ml-auto hidden sm:flex items-center gap-2">
              {["ProductAttributeDefinition", "8-Batch Deploy", "RCA v62.0"].map(badge => (
                <span key={badge} className="text-[9px] font-mono px-2 py-0.5 rounded-full"
                  style={{ background: "rgba(0,212,255,0.07)", color: ACCENT, border: "1px solid rgba(0,212,255,0.18)" }}>
                  {badge}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Prompt area */}
        <div className="flex-1 overflow-y-auto px-6 py-6" style={{ scrollbarWidth: "thin" }}>
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="max-w-2xl mx-auto">

            <div className="text-center mb-7">
              <motion.div animate={{ opacity: [0.6, 1, 0.6] }} transition={{ duration: 2.8, repeat: Infinity }}
                className="inline-flex items-center gap-2 text-[10px] font-mono tracking-widest uppercase mb-4 px-3 py-1.5 rounded-full"
                style={{ background: "rgba(0,212,255,0.07)", color: ACCENT, border: "1px solid rgba(0,212,255,0.18)" }}>
                <Ic n="sparkles" s={11} />
                AI Attribute Requirement Prompt
              </motion.div>
              <h3 className="text-[22px] font-black mb-2" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.03em" }}>
                Describe your product attributes
              </h3>
              <p className="text-[12px]" style={{ color: isDark ? "rgba(100,130,170,0.65)" : "rgba(0,15,55,0.74)" }}>
                The AI reasons like an RCA business architect — distinguishing configurable vs informational attributes, inferring datatypes, and filtering pricing, ERP, and logistics fields.
              </p>
            </div>

            {/* Prompt box */}
            <div className="rounded-2xl overflow-hidden mb-5"
              style={{ background: isDark ? "rgba(4,10,22,0.82)" : "rgba(228,238,255,0.95)", border: isDark ? "1px solid rgba(0,212,255,0.18)" : "1px solid rgba(0,112,214,0.15)", boxShadow: isDark ? "0 0 40px rgba(0,212,255,0.05)" : "0 8px 32px rgba(0,112,214,0.06)", backdropFilter: "blur(16px)" }}>
              <div className="px-5 pt-4 pb-1 flex items-center gap-2">
                <span style={{ color: ACCENT }}><Ic n="sparkles" s={13} /></span>
                <span className="text-[11px] font-semibold" style={{ color: isDark ? "rgba(0,212,255,0.8)" : "rgba(0,112,214,0.8)" }}>
                  AI Attribute Requirement Prompt
                </span>
              </div>
              <textarea
                ref={promptRef}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && e.metaKey) handleGenerate(); }}
                placeholder={"Describe product attributes and configurable specifications in natural language…\n\nExample: \"Create configurable laptop attributes for RAM 8GB/16GB/32GB, Storage 256GB/512GB, RGB keyboard, WiFi enabled, and weight 1.5kg.\""}
                rows={8}
                className="w-full bg-transparent outline-none resize-none text-[13px] px-5 py-3"
                style={{ color: isDark ? "rgba(200,225,245,0.9)" : "rgba(0,15,45,0.88)", minHeight: 180, scrollbarWidth: "thin" }}
              />
              <div className="flex items-center justify-between px-5 py-3"
                style={{ borderTop: isDark ? "1px solid rgba(0,212,255,0.08)" : "1px solid rgba(0,112,214,0.07)" }}>
                <span className="text-[10px]" style={{ color: isDark ? "rgba(90,120,160,0.5)" : "rgba(0,31,91,0.58)" }}>
                  ⌘+Enter to generate
                </span>
                <motion.button onClick={handleGenerate} disabled={!prompt.trim()}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-[12px] font-semibold cursor-pointer"
                  style={{
                    background: prompt.trim() ? `linear-gradient(135deg, ${ACCENT_CYAN} 0%, ${ACCENT} 100%)` : isDark ? "rgba(0,212,255,0.06)" : "rgba(0,112,214,0.05)",
                    color: prompt.trim() ? "rgba(0,10,20,0.9)" : isDark ? "rgba(0,212,255,0.25)" : "rgba(0,112,214,0.2)",
                  }}
                  whileHover={prompt.trim() ? { scale: 1.04 } : {}}
                  whileTap={prompt.trim() ? { scale: 0.97 } : {}}>
                  <Ic n="sparkles" s={13} />
                  Generate Attributes
                </motion.button>
              </div>
            </div>

            {/* Error */}
            {genError && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="mb-5 px-4 py-3 rounded-xl flex items-start gap-2"
                style={{ background: "rgba(255,64,102,0.07)", border: "1px solid rgba(255,64,102,0.2)" }}>
                <span style={{ color: "#FF4066", marginTop: 1 }}><Ic n="alert-circle" s={13} /></span>
                <span className="text-[12px]" style={{ color: "#FF4066" }}>{genError}</span>
              </motion.div>
            )}

            {/* Feature badges */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: "Semantic AI", desc: "RCA architect reasoning" },
                { label: "8-Batch Deploy", desc: "Dependency-ordered execution" },
                { label: "Eligibility Filter", desc: "Rejects ERP / pricing fields" },
                { label: "Real Salesforce", desc: "ProductAttributeDefinition" },
              ].map(f => (
                <div key={f.label} className="px-3 py-2.5 rounded-xl"
                  style={{ background: isDark ? "rgba(0,212,255,0.04)" : "rgba(0,212,255,0.03)", border: "1px solid rgba(0,212,255,0.1)" }}>
                  <div className="text-[10px] font-semibold mb-0.5" style={{ color: ACCENT }}>{f.label}</div>
                  <div className="text-[9px]" style={{ color: isDark ? "rgba(90,120,160,0.6)" : "rgba(0,15,55,0.70)" }}>{f.desc}</div>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    );
  }

  /* ── Post-generation workspace ──────────────────────────────────────────── */
  const TABS = [
    { id: "attributes" as const, label: "Attributes",  icon: "list",     count: parsedData.attributes.length },
    { id: "execution"  as const, label: "Execution",   icon: "activity", count: completedBatches > 0 ? completedBatches : undefined },
    { id: "console"    as const, label: "Console",     icon: "terminal", count: allLogs.length > 0 ? allLogs.length : undefined },
    { id: "product"    as const, label: "Product",     icon: "package",  count: batchCtx.productId ? 1 : undefined },
    { id: "skipped"    as const, label: "Skipped",     icon: "info",     count: parsedData.skipped?.length ?? 0 },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Compact top header */}
      <div className="shrink-0 px-5 pt-3 pb-0" style={{ borderBottom: border }}>
        <div className="flex items-center gap-2 mb-2.5 flex-wrap">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "linear-gradient(135deg, rgba(0,212,255,0.18), rgba(0,212,255,0.1))", border: "1px solid rgba(0,212,255,0.25)", color: ACCENT }}>
            <Ic n="layers" s={14} />
          </div>
          <span className="text-[13px] font-bold" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.02em" }}>
            RCA Attribute Creation Studio
          </span>
          <span className="text-[9px] font-mono px-2 py-0.5 rounded-full"
            style={{ background: "rgba(0,212,255,0.1)", color: ACCENT, border: "1px solid rgba(0,212,255,0.2)" }}>
            {parsedData.attributes.length} ATTRS · {completedBatches}/9 BATCHES
          </span>
          <motion.button onClick={() => setShowPreview(true)}
            className="ml-auto flex items-center gap-1 text-[10px] px-2.5 py-1.5 rounded-lg cursor-pointer"
            style={{ color: isDark ? "rgba(0,212,255,0.7)" : "rgba(0,71,171,0.65)", border: isDark ? "1px solid rgba(0,212,255,0.18)" : "1px solid rgba(0,71,171,0.14)" }}
            whileHover={{ background: "rgba(0,212,255,0.06)" }} whileTap={{ scale: 0.96 }}>
            <Ic n="eye" s={10} />
            Preview JSON
          </motion.button>
          <motion.button
            onClick={handleDeployAll}
            disabled={isDeployingAll}
            className="flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1.5 rounded-lg cursor-pointer"
            style={{
              background: isDeployingAll
                ? (isDark ? "rgba(0,212,255,0.07)" : "rgba(0,212,255,0.05)")
                : `linear-gradient(135deg, ${ACCENT_CYAN} 0%, ${ACCENT} 100%)`,
              color: isDeployingAll
                ? (isDark ? "rgba(0,212,255,0.3)" : "rgba(0,112,214,0.25)")
                : "rgba(0,10,20,0.9)",
            }}
            whileHover={!isDeployingAll ? { scale: 1.03 } : {}}
            whileTap={!isDeployingAll ? { scale: 0.97 } : {}}>
            {isDeployingAll ? (
              <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
                <Ic n="loader" s={10} />
              </motion.span>
            ) : (
              <Ic n="zap" s={10} />
            )}
            {isDeployingAll ? "Deploying…" : "Deploy to Salesforce"}
          </motion.button>
          <motion.button onClick={handleReset}
            className="flex items-center gap-1 text-[10px] px-2.5 py-1.5 rounded-lg cursor-pointer"
            style={{ color: isDark ? "rgba(0,212,255,0.65)" : "rgba(0,112,214,0.65)", border: isDark ? "1px solid rgba(0,212,255,0.15)" : "1px solid rgba(0,112,214,0.12)" }}
            whileHover={{ background: "rgba(0,212,255,0.06)" }} whileTap={{ scale: 0.96 }}>
            <Ic n="refresh" s={10} />
            New Analysis
          </motion.button>
        </div>

        {/* Product Context */}
        <ProductContextCard data={parsedData} isDark={isDark} />

        {/* Tabs */}
        <div className="flex items-center gap-0.5 -mb-px">
          {TABS.map(tab => {
            const active = activeTab === tab.id;
            return (
              <motion.button key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium cursor-pointer rounded-t-lg"
                style={{
                  color: active ? ACCENT : isDark ? "rgba(90,120,160,0.65)" : "rgba(0,15,55,0.74)",
                  background: active ? (isDark ? "rgba(0,212,255,0.08)" : "rgba(0,212,255,0.06)") : "transparent",
                  borderBottom: active ? `2px solid ${ACCENT}` : "2px solid transparent",
                }}
                whileHover={!active ? { background: isDark ? "rgba(0,212,255,0.04)" : "rgba(0,212,255,0.03)" } : {}}
                whileTap={{ scale: 0.97 }}>
                <Ic n={tab.icon} s={11} />
                {tab.label}
                {tab.count !== undefined && tab.count > 0 && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full"
                    style={{ background: active ? "rgba(0,212,255,0.18)" : isDark ? "rgba(90,120,160,0.14)" : "rgba(0,31,91,0.08)", color: active ? ACCENT : isDark ? "rgba(120,150,180,0.7)" : "rgba(0,15,55,0.74)" }}>
                    {tab.count}
                  </span>
                )}
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-5 py-4" style={{ scrollbarWidth: "thin" }}>
        <AnimatePresence mode="wait">

          {/* ── Attributes Tab ──────────────────────────────────────────────── */}
          {activeTab === "attributes" && (
            <motion.div key="attributes" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}>
              {/* Header row */}
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <span className="text-[10px] font-semibold tracking-widest uppercase flex-1"
                  style={{ color: isDark ? "rgba(0,212,255,0.5)" : "rgba(0,112,214,0.45)" }}>
                  {attrView === "table" ? "AI Analysis Overview" : "Generated Attribute Definitions"}
                </span>
                {/* Datatype badges (cards view only) */}
                {attrView === "cards" && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {Object.entries(DT_CONFIG).map(([type, cfg]) => {
                      const count = parsedData.attributes.filter(a => a.dataType === type).length;
                      if (!count) return null;
                      return (
                        <span key={type} className="text-[9px] px-2 py-0.5 rounded-full font-medium"
                          style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}30` }}>
                          {count} {type}
                        </span>
                      );
                    })}
                  </div>
                )}
                {/* View toggle */}
                <div className="flex items-center rounded-lg overflow-hidden shrink-0"
                  style={{ border: isDark ? "1px solid rgba(0,212,255,0.14)" : "1px solid rgba(0,112,214,0.12)" }}>
                  {(["cards", "table"] as const).map(v => (
                    <motion.button key={v}
                      onClick={() => setAttrView(v)}
                      className="text-[9px] font-semibold px-2.5 py-1 cursor-pointer"
                      style={{
                        background: attrView === v
                          ? isDark ? "rgba(0,212,255,0.12)" : "rgba(0,212,255,0.1)"
                          : "transparent",
                        color: attrView === v ? ACCENT : isDark ? "rgba(0,212,255,0.4)" : "rgba(0,112,214,0.45)",
                      }}
                      whileTap={{ scale: 0.96 }}>
                      {v === "cards" ? "Cards" : "Analysis"}
                    </motion.button>
                  ))}
                </div>
              </div>

              {/* Analysis Table view */}
              {attrView === "table" && (
                <AnalysisTable
                  attrs={parsedData.attributes}
                  skipped={parsedData.skipped ?? []}
                  isDark={isDark}
                />
              )}

              {/* Cards view */}
              {attrView === "cards" && (
                <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
                  {parsedData.attributes.map((attr, i) => (
                    <AttributeCard key={attr.name} attr={attr} idx={i} isDark={isDark} />
                  ))}
                </div>
              )}
            </motion.div>
          )}

          {/* ── Execution Timeline Tab ─────────────────────────────────────── */}
          {activeTab === "execution" && (
            <motion.div key="execution" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] font-semibold tracking-widest uppercase"
                  style={{ color: isDark ? "rgba(0,212,255,0.5)" : "rgba(0,112,214,0.45)" }}>
                  Batch Execution Timeline
                </span>
                <span className="text-[10px] font-mono"
                  style={{ color: isDark ? "rgba(90,120,160,0.55)" : "rgba(0,15,55,0.65)" }}>
                  {completedBatches} / 9 complete
                </span>
              </div>

              {/* Org storage warning banner */}
              <AnimatePresence>
                {cumulativeHealth.storageWarning && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                    className="mb-3 rounded-xl px-4 py-3 flex items-start gap-2.5"
                    style={{ background: "rgba(255,64,102,0.07)", border: "1px solid rgba(255,64,102,0.28)" }}>
                    <span style={{ color: "#FF6080", marginTop: 1, flexShrink: 0 }}><Ic n="alert-circle" s={14} /></span>
                    <div>
                      <p className="text-[11px] font-semibold mb-0.5" style={{ color: "#FF6080" }}>Org Storage Exhausted</p>
                      <p className="text-[10px]" style={{ color: isDark ? "rgba(255,160,160,0.75)" : "rgba(150,0,0,0.65)" }}>
                        This Salesforce org has exhausted available RCA metadata/data storage. Clean old test RCA records or use a fresh org.
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Overall progress */}
              <div className="mb-4 rounded-xl p-3"
                style={{ background: isDark ? "rgba(0,212,255,0.04)" : "rgba(0,212,255,0.03)", border: "1px solid rgba(0,212,255,0.12)" }}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-medium" style={{ color: ACCENT }}>Overall Deployment Progress</span>
                  <span className="text-[10px] font-mono font-bold" style={{ color: ACCENT }}>
                    {Math.round((completedBatches / 9) * 100)}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(0,212,255,0.1)" }}>
                  <motion.div className="h-full rounded-full"
                    style={{ background: `linear-gradient(90deg, ${ACCENT_CYAN}, ${ACCENT})` }}
                    animate={{ width: `${(completedBatches / 9) * 100}%` }}
                    transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} />
                </div>
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  {[
                    { label: "Pending",  color: isDark ? "rgba(90,120,160,0.45)" : "rgba(0,31,91,0.56)", count: batchStates.filter(b => b.status === "idle").length },
                    { label: "Running",  color: ACCENT_CYAN, count: batchStates.filter(b => b.status === "running").length },
                    { label: "Complete", color: ACCENT,      count: completedBatches },
                    { label: "Failed",   color: "#FF4066",   count: batchStates.filter(b => b.status === "failed").length },
                  ].map(s => (
                    <div key={s.label} className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
                      <span className="text-[9px]" style={{ color: isDark ? "rgba(90,120,160,0.6)" : "rgba(0,15,55,0.70)" }}>
                        {s.count} {s.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                {BATCH_DEFS.map((def, i) => (
                  <BatchRow key={def.id} def={def} state={batchStates[i]} payload={batchPayloads[i]}
                    isDark={isDark} canExecute={canExecuteBatch(i)} onExecute={() => handleExecuteBatch(i)} />
                ))}
              </div>
            </motion.div>
          )}

          {/* ── Console Tab ────────────────────────────────────────────────── */}
          {activeTab === "console" && (
            <motion.div key="console" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}>
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <span className="text-[10px] font-semibold tracking-widest uppercase flex-1"
                  style={{ color: isDark ? "rgba(0,212,255,0.5)" : "rgba(0,112,214,0.45)" }}>
                  Deployment Console
                </span>
                <motion.button onClick={() => setShowGraph(v => !v)}
                  className="flex items-center gap-1 text-[9px] px-2 py-1 rounded cursor-pointer"
                  style={{
                    color: showGraph ? ACCENT_CYAN : isDark ? "rgba(0,212,255,0.5)" : "rgba(0,71,171,0.72)",
                    border: showGraph
                      ? "1px solid rgba(0,212,255,0.3)"
                      : isDark ? "1px solid rgba(0,212,255,0.12)" : "1px solid rgba(0,71,171,0.20)",
                    background: showGraph ? "rgba(0,212,255,0.07)" : "transparent",
                  }}
                  whileHover={{ background: "rgba(0,212,255,0.07)" }} whileTap={{ scale: 0.95 }}>
                  <Ic n="activity" s={9} />
                  {showGraph ? "Hide Graph" : "Show Dependency Graph"}
                </motion.button>
                <motion.button onClick={() => setAllLogs([])}
                  className="text-[9px] px-2 py-1 rounded cursor-pointer"
                  style={{ color: isDark ? "rgba(90,120,160,0.55)" : "rgba(0,15,55,0.65)", border: isDark ? "1px solid rgba(90,120,160,0.15)" : "1px solid rgba(0,31,91,0.1)" }}
                  whileHover={{ background: isDark ? "rgba(90,120,160,0.07)" : "rgba(0,31,91,0.04)" }}
                  whileTap={{ scale: 0.95 }}>
                  Clear
                </motion.button>
              </div>

              {/* Storage Health Panel */}
              <StorageHealthPanel health={cumulativeHealth} isDark={isDark} />

              {/* RCA Dependency Graph (optional) */}
              <AnimatePresence>
                {showGraph && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden">
                    <RCADependencyGraph batchStates={batchStates} isDark={isDark} />
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="rounded-xl p-4"
                style={{ background: isDark ? "rgba(0,0,0,0.52)" : "rgba(240,248,255,0.88)", border: isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,71,171,0.20)", minHeight: 240 }}>
                {allLogs.length === 0 ? (
                  <p className="text-[11px] font-mono"
                    style={{ color: isDark ? "rgba(90,120,160,0.38)" : "rgba(0,31,91,0.3)" }}>
                    No deployment activity yet. Execute batches to see logs.
                  </p>
                ) : (
                  allLogs.map((log, i) => (
                    <motion.div key={i} initial={{ opacity: 0, x: -3 }} animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: Math.min(i * 0.008, 0.3) }}
                      className="text-[10px] font-mono mb-0.5"
                      style={{
                        color: log.includes("[ERROR]") || log.includes("✗") || log.includes("[STORAGE LIMIT]") || log.includes("[ORG STORAGE]") || log.includes("[PICKLIST_MISMATCH]") ? "#FF6080"
                          : log.includes("[SUCCESS]") || log.includes("✓") || log.includes("[SCHEMA]") || log.includes("[VALIDATION]") ? ACCENT
                          : log.includes("[REUSE]") || log.includes("[CACHE]") || log.includes("[PREFETCH]") || log.includes("[RECOVERY]") || log.includes("[PICKLIST_DEBUG]") || log.includes("[PCA_DEBUG]") || log.includes("[PICKLIST_COMPAT]") ? ACCENT_CYAN
                          : log.includes("[ATTR_DEBUG]") || log.includes("[CREATE]") || log.includes("[SUMMARY]") ? "#3AABFF"
                          : isDark ? "rgba(180,210,240,0.72)" : "rgba(0,31,91,0.68)",
                      }}>
                      {log}
                    </motion.div>
                  ))
                )}
              </div>
            </motion.div>
          )}

          {/* ── Product Preview Tab ───────────────────────────────────────── */}
          {activeTab === "product" && (
            <motion.div key="product" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}>
              <span className="block text-[10px] font-semibold tracking-widest uppercase mb-3"
                style={{ color: isDark ? "rgba(0,212,255,0.5)" : "rgba(0,112,214,0.45)" }}>
                Product Preview &amp; Deployment Summary
              </span>

              {/* Product Info Card */}
              <div className="rounded-xl p-3 mb-3"
                style={{ background: isDark ? "rgba(0,212,255,0.04)" : "rgba(0,212,255,0.03)", border: "1px solid rgba(0,212,255,0.18)" }}>
                <div className="flex items-center gap-2 mb-2.5">
                  <span style={{ color: ACCENT }}><Ic n="package" s={12} /></span>
                  <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: ACCENT }}>Product Details</span>
                  {batchCtx.productId && (
                    <span className="ml-auto text-[9px] font-mono px-2 py-0.5 rounded-full"
                      style={{ background: "rgba(0,212,255,0.1)", color: ACCENT, border: "1px solid rgba(0,212,255,0.22)" }}>
                      ID: {batchCtx.productId}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2.5">
                  {[
                    { label: "Product Name",     value: parsedData.productName },
                    { label: "Product Code",     value: parsedData.productCode },
                    { label: "Family",           value: parsedData.productFamily },
                    { label: "Type",             value: parsedData.productType },
                    { label: "Classification",   value: parsedData.classificationName + (batchCtx.classificationId ? ` (${batchCtx.classificationId.slice(-6)})` : "") },
                    { label: "Category",         value: parsedData.categoryName + (batchCtx.categoryId ? ` (${batchCtx.categoryId.slice(-6)})` : "") },
                    { label: "Selling Model",    value: parsedData.sellingModel },
                    { label: "Unit of Measure",  value: parsedData.unitOfMeasure },
                    { label: "Status",           value: parsedData.isActive ? "Active" : "Inactive" },
                  ].map(f => (
                    <div key={f.label} className="flex flex-col gap-0.5">
                      <span className="text-[9px] font-medium tracking-wider uppercase"
                        style={{ color: isDark ? "rgba(0,212,255,0.4)" : "rgba(0,112,214,0.4)" }}>{f.label}</span>
                      <span className="text-[11px] font-semibold truncate"
                        style={{ color: isDark ? "rgba(220,240,230,0.88)" : "#001F5B" }}>{f.value || "—"}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Attribute Mapping Summary */}
              <div className="rounded-xl overflow-hidden mb-3"
                style={{ border: isDark ? "1px solid rgba(0,212,255,0.12)" : "1px solid rgba(0,71,171,0.20)" }}>
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ background: isDark ? "rgba(0,212,255,0.05)" : "rgba(0,71,171,0.09)", borderBottom: isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,71,171,0.16)" }}>
                  <span className="text-[9px] font-bold tracking-widest uppercase flex-1" style={{ color: ACCENT_CYAN }}>
                    Attribute Mapping ({Object.keys(batchCtx.padIds ?? {}).length}/{parsedData.attributes.length} PADs deployed)
                  </span>
                </div>
                <div className="divide-y" style={{ borderColor: isDark ? "rgba(0,212,255,0.07)" : "rgba(0,71,171,0.12)" }}>
                  {parsedData.attributes.map(attr => {
                    const padId = batchCtx.padIds?.[attr.name];
                    const pcaId = batchCtx.pcaIds?.[attr.name];
                    const rvId  = batchCtx.runtimeValueIds?.[attr.name];
                    const dt    = DT_CONFIG[attr.dataType] ?? DT_CONFIG.Text;
                    return (
                      <div key={attr.name} className="flex items-center gap-2 px-3 py-2">
                        <span className="text-[10px] font-semibold flex-1 truncate"
                          style={{ color: isDark ? "rgba(220,240,230,0.85)" : "#001F5B" }}>{attr.name}</span>
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                          style={{ background: dt.bg, color: dt.color, border: `1px solid ${dt.color}35` }}>
                          {attr.dataType}
                        </span>
                        {padId ? (
                          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded shrink-0"
                            style={{ background: "rgba(0,212,255,0.08)", color: ACCENT, border: "1px solid rgba(0,212,255,0.2)" }}>
                            PAD ✓
                          </span>
                        ) : (
                          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded shrink-0"
                            style={{ background: "rgba(255,64,102,0.07)", color: "#FF6080", border: "1px solid rgba(255,64,102,0.2)" }}>
                            PAD —
                          </span>
                        )}
                        {pcaId && (
                          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded shrink-0"
                            style={{ background: "rgba(0,212,255,0.08)", color: ACCENT_CYAN, border: "1px solid rgba(0,212,255,0.18)" }}>
                            PCA ✓
                          </span>
                        )}
                        {rvId && (
                          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded shrink-0"
                            style={{ background: "rgba(167,139,250,0.1)", color: "#A78BFA", border: "1px solid rgba(167,139,250,0.25)" }}>
                            Val ✓
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Runtime Values Viewer */}
              {Object.keys(batchCtx.runtimeValueIds ?? {}).length > 0 && (
                <div className="rounded-xl overflow-hidden mb-3"
                  style={{ border: "1px solid rgba(167,139,250,0.2)" }}>
                  <div className="flex items-center gap-2 px-3 py-2"
                    style={{ background: "rgba(167,139,250,0.05)", borderBottom: "1px solid rgba(167,139,250,0.12)" }}>
                    <span className="text-[9px] font-bold tracking-widest uppercase" style={{ color: "#A78BFA" }}>
                      Runtime Attribute Values
                    </span>
                    <span className="ml-auto text-[8px] px-2 py-0.5 rounded-full font-mono"
                      style={{ background: "rgba(167,139,250,0.1)", color: "#A78BFA", border: "1px solid rgba(167,139,250,0.25)" }}>
                      {Object.keys(batchCtx.runtimeValueIds ?? {}).length} persisted
                    </span>
                  </div>
                  {/* Table header */}
                  <div className="grid text-[9px] font-semibold tracking-widest uppercase px-3 py-2"
                    style={{
                      gridTemplateColumns: "1fr 90px 1fr 130px",
                      background: isDark ? "rgba(0,0,0,0.3)" : "rgba(240,240,255,0.5)",
                      borderBottom: "1px solid rgba(167,139,250,0.1)",
                      color: isDark ? "rgba(167,139,250,0.5)" : "rgba(100,80,200,0.5)",
                    }}>
                    <span>Attribute</span><span>Type</span><span>Configured Value</span><span>Record ID</span>
                  </div>
                  {parsedData.attributes.map((attr, i) => {
                    const rvId = batchCtx.runtimeValueIds?.[attr.name];
                    if (!rvId) return null;
                    const runtimeValue = attr.defaultValue ?? (attr.values.length > 0 ? attr.values[0] : attr.dataType === "Boolean" ? "false" : "0");
                    const dt = DT_CONFIG[attr.dataType] ?? DT_CONFIG.Text;
                    return (
                      <div key={attr.name}
                        className="grid items-center px-3 py-2 text-[10px]"
                        style={{
                          gridTemplateColumns: "1fr 90px 1fr 130px",
                          background: i % 2 === 0 ? (isDark ? "rgba(4,10,22,0.4)" : "rgba(218,232,255,0.80)") : "transparent",
                          borderBottom: "1px solid rgba(167,139,250,0.07)",
                        }}>
                        <span className="font-semibold truncate pr-2" style={{ color: isDark ? "rgba(220,240,230,0.85)" : "#001F5B" }}>{attr.name}</span>
                        <span>
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                            style={{ background: dt.bg, color: dt.color, border: `1px solid ${dt.color}35` }}>
                            {attr.dataType}
                          </span>
                        </span>
                        <span className="font-mono" style={{ color: "#A78BFA" }}>{runtimeValue}</span>
                        <span className="font-mono text-[9px] truncate" style={{ color: isDark ? "rgba(167,139,250,0.55)" : "rgba(100,80,200,0.6)" }}>{rvId}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Empty state */}
              {!batchCtx.productId && (
                <div className="rounded-xl p-8 text-center flex flex-col items-center gap-3"
                  style={{ background: isDark ? "rgba(0,212,255,0.03)" : "rgba(0,212,255,0.02)", border: "1px solid rgba(0,212,255,0.1)" }}>
                  <span style={{ color: "rgba(0,212,255,0.4)" }}><Ic n="package" s={28} /></span>
                  <p className="text-[12px] font-medium" style={{ color: isDark ? "rgba(0,212,255,0.55)" : "rgba(0,112,214,0.55)" }}>
                    Product not yet deployed — run Batches 1–6 to create the product and see the preview here
                  </p>
                </div>
              )}
            </motion.div>
          )}

          {/* ── Skipped Tab ────────────────────────────────────────────────── */}
          {activeTab === "skipped" && (
            <motion.div key="skipped" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}>
              <div className="mb-3">
                <span className="text-[10px] font-semibold tracking-widest uppercase"
                  style={{ color: isDark ? "rgba(0,212,255,0.5)" : "rgba(0,112,214,0.45)" }}>
                  Skipped / Rejected Attributes
                </span>
              </div>
              {(!parsedData.skipped || parsedData.skipped.length === 0) ? (
                <div className="rounded-xl p-8 text-center flex flex-col items-center gap-3"
                  style={{ background: isDark ? "rgba(0,212,255,0.03)" : "rgba(0,212,255,0.02)", border: "1px solid rgba(0,212,255,0.1)" }}>
                  <span style={{ color: ACCENT }}><Ic n="check-circle" s={28} /></span>
                  <p className="text-[12px] font-medium" style={{ color: isDark ? "rgba(0,212,255,0.7)" : "rgba(0,112,214,0.7)" }}>
                    No fields rejected — all attributes passed eligibility filtering
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {parsedData.skipped.map((f, i) => (
                    <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.04 }}
                      className="flex items-start gap-3 px-4 py-3 rounded-xl"
                      style={{ background: isDark ? "rgba(255,64,102,0.04)" : "rgba(255,64,102,0.03)", border: "1px solid rgba(255,64,102,0.15)" }}>
                      <span style={{ color: "rgba(255,64,102,0.6)", marginTop: 1 }}><Ic n="x" s={13} /></span>
                      <div className="flex-1 min-w-0">
                        <span className="text-[12px] font-semibold block"
                          style={{ color: isDark ? "rgba(220,180,180,0.9)" : "rgba(100,0,0,0.82)" }}>
                          {f.name}
                        </span>
                        <span className="text-[11px]"
                          style={{ color: isDark ? "rgba(180,100,100,0.65)" : "rgba(120,40,40,0.6)" }}>
                          {f.reason}
                        </span>
                      </div>
                      <span className="text-[9px] px-2 py-0.5 rounded-full shrink-0 font-medium"
                        style={{ background: "rgba(255,64,102,0.1)", color: "#FF4066", border: "1px solid rgba(255,64,102,0.22)" }}>
                        Rejected
                      </span>
                    </motion.div>
                  ))}
                </div>
              )}
            </motion.div>
          )}

        </AnimatePresence>
      </div>

      {/* Full JSON Preview Overlay */}
      <AnimatePresence>
        {showPreview && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(10px)" }}
            onClick={() => setShowPreview(false)}>
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.94, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="w-full max-w-3xl max-h-[86vh] rounded-2xl overflow-hidden flex flex-col"
              style={{
                background: isDark ? "rgba(4,10,22,0.98)" : "rgba(255,255,255,0.98)",
                border: isDark ? "1px solid rgba(0,212,255,0.22)" : "1px solid rgba(0,112,214,0.15)",
                boxShadow: "0 28px 90px rgba(0,0,0,0.55)",
              }}
              onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="flex items-center gap-3 px-5 py-4 shrink-0"
                style={{ borderBottom: isDark ? "1px solid rgba(0,212,255,0.12)" : "1px solid rgba(0,112,214,0.1)" }}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: "linear-gradient(135deg, rgba(0,212,255,0.18), rgba(0,212,255,0.1))", border: "1px solid rgba(0,212,255,0.28)", color: ACCENT_CYAN }}>
                  <Ic n="eye" s={15} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-[14px] font-bold" style={{ color: isDark ? "white" : "#001F5B" }}>
                    Full Salesforce JSON Payload Preview
                  </h3>
                  <p className="text-[10px]" style={{ color: isDark ? "rgba(0,212,255,0.55)" : "rgba(0,71,171,0.72)" }}>
                    {parsedData.attributes.length} attributes · 8 deployment batches · {parsedData.productName}
                  </p>
                </div>
                <motion.button onClick={() => setShowPreview(false)}
                  className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer"
                  style={{ color: isDark ? "rgba(0,212,255,0.6)" : "rgba(0,112,214,0.55)", border: isDark ? "1px solid rgba(0,212,255,0.15)" : "1px solid rgba(0,112,214,0.12)" }}
                  whileHover={{ background: isDark ? "rgba(0,212,255,0.08)" : "rgba(0,112,214,0.06)" }}
                  whileTap={{ scale: 0.93 }}>
                  <Ic n="x" s={12} />
                </motion.button>
              </div>

              {/* Batch payload list */}
              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3" style={{ scrollbarWidth: "thin" }}>
                {BATCH_DEFS.map((def, i) => {
                  const bstate = batchStates[i];
                  const statusColor = bstate.status === "success" ? ACCENT
                    : bstate.status === "failed" ? "#FF4066"
                    : bstate.status === "running" ? ACCENT_CYAN
                    : isDark ? "rgba(90,120,160,0.4)" : "rgba(74,106,160,0.35)";
                  return (
                    <div key={def.id} className="rounded-xl overflow-hidden"
                      style={{ border: isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,112,214,0.1)" }}>
                      <div className="flex items-center gap-2.5 px-3 py-2.5"
                        style={{ background: isDark ? "rgba(0,212,255,0.04)" : "rgba(0,212,255,0.03)", borderBottom: isDark ? "1px solid rgba(0,212,255,0.08)" : "1px solid rgba(0,112,214,0.07)" }}>
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded font-mono shrink-0"
                          style={{ background: `${statusColor}18`, color: statusColor, border: `1px solid ${statusColor}35` }}>
                          BATCH {def.id}
                        </span>
                        <span className="text-[11px] font-semibold flex-1 min-w-0 truncate"
                          style={{ color: isDark ? "rgba(220,240,230,0.9)" : "#001F5B" }}>
                          {def.name}
                        </span>
                        <span className="text-[9px] shrink-0 hidden sm:block"
                          style={{ color: isDark ? "rgba(90,120,160,0.5)" : "rgba(0,31,91,0.38)" }}>
                          {def.desc}
                        </span>
                      </div>
                      <pre className="text-[10px] font-mono px-3 py-2.5 overflow-x-auto"
                        style={{
                          color: isDark ? "rgba(0,212,255,0.82)" : "rgba(0,70,35,0.82)",
                          maxHeight: 180,
                          overflowY: "auto",
                          scrollbarWidth: "thin",
                          background: isDark ? "rgba(0,0,0,0.42)" : "rgba(240,252,248,0.75)",
                        }}>
                        {JSON.stringify(batchPayloads[i], null, 2)}
                      </pre>
                    </div>
                  );
                })}
              </div>

              {/* Footer */}
              <div className="px-5 py-3 shrink-0 flex items-center justify-between"
                style={{ borderTop: isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,112,214,0.08)" }}>
                <span className="text-[10px]" style={{ color: isDark ? "rgba(90,120,160,0.5)" : "rgba(0,15,55,0.65)" }}>
                  Read-only preview — execute batches to deploy to Salesforce
                </span>
                <motion.button
                  onClick={() => { navigator.clipboard.writeText(JSON.stringify(batchPayloads, null, 2)); }}
                  className="flex items-center gap-1.5 text-[10px] px-3 py-1.5 rounded-lg cursor-pointer"
                  style={{ color: isDark ? "rgba(0,212,255,0.7)" : "rgba(0,112,214,0.65)", border: isDark ? "1px solid rgba(0,212,255,0.18)" : "1px solid rgba(0,112,214,0.15)" }}
                  whileHover={{ background: "rgba(0,212,255,0.06)" }} whileTap={{ scale: 0.95 }}>
                  <Ic n="copy" s={11} />
                  Copy All JSON
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
