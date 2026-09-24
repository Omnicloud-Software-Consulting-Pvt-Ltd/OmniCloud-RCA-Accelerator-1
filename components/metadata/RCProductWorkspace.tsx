"use client";

import React, { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { loadSession } from "@/lib/auth/session";
import { toCreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import {
  Ic, FieldWrap, FInput, FSelect, FTextarea, SectionHeader, RCConfigCard, rcCssVars,
  autoCode, SELLING_MODELS, FAMILIES, CATEGORY_MAP, CATALOG_MAP, UNIT_OF_MEASURES,
} from "@/components/metadata/shared/productFields";
import FieldMappingTable from "@/components/metadata/shared/FieldMappingTable";
import type { ProductIntentMap } from "@/lib/products/ai/productIntent";
import { formatProductPrice } from "@/lib/products/price";
import { buildProductMappingRows } from "@/lib/products/ai/productMappingRows";
import type { ProductPayload } from "@/lib/products/types";
import type { DuplicateCheckResult } from "@/lib/duplicateDetection";
import DuplicateRecordModal from "@/components/duplicates/DuplicateRecordModal";
import PromptGuide from "@/components/ai/PromptGuide";
import { promptGuideConfig } from "@/lib/ai/promptGuideConfig";

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
  currencyIsoCode: string;
  /** Verbatim "product type" text from the prompt (e.g. "Physical") — separate from the simple/bundle toggle above, which only controls actual bundle behavior. Shown in the Field Mapping table for traceability; only forwarded to Salesforce when it resolves to "Bundle" (Type is a restricted picklist). */
  productTypeRaw: string;
  /** null = the prompt said nothing about tax. There is no Product2/PricebookEntry field for this in standard Salesforce — never sent to /api/sf/products/save, shown here only so the meaning is never silently dropped. */
  taxIncluded: boolean | null;
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
  warnings?: string[];
  /** Set by /save when the product was created but its PricebookEntry could not be written. */
  priceError?: string;
}
type ValidationIssue = { field: string; msg: string };

/** Passed in when the workspace is opened via "Edit Product" from Product History, instead of "Create Product". */
export interface ProductEditContext {
  id: string;
  original: ProductPayload;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Constants
 * ─────────────────────────────────────────────────────────────────────────── */
const EMPTY_PRODUCT: ProductState = {
  productName: "", productCode: "", status: "Active", description: "",
  family: "", category: "", catalog: "", sellingModel: "One Time",
  productType: "simple", isActive: true, unitOfMeasure: "Each",
  classification: "", productOwner: "", priceBook: "Standard Price Book",
  basePrice: "", currencyIsoCode: "", productTypeRaw: "", taxIncluded: null,
};

const EXAMPLE_PROMPTS = [
  "Samsung Galaxy S25 mobile phone with black and silver colors under Electronics",
  "Salesforce CRM Enterprise subscription plan billed monthly",
  "Gaming laptop with RTX 5090, 64GB RAM, RGB keyboard, liquid cooling",
  "Smartwatch with AMOLED display, GPS, health monitoring, wireless charging",
  "Enterprise support contract billed quarterly for 2 years",
];

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
      {card("Product Information", isDark ? "#1E90FF" : "#0968D3", rows([
        ["Name", product.productName || "—"],
        ["Code", product.productCode || "—"],
        ["Family", product.family || "—"],
        ["Category", product.category || "—"],
        ["Type", product.productType || "—"],
        ["Status", product.status],
        ["Active", product.isActive ? "Yes" : "No"],
        ["Unit", product.unitOfMeasure],
        ...(product.productOwner ? [["Owner", product.productOwner] as [string, string]] : []),
      ], isDark ? "#3AABFF" : "#1789B0"))}

      {card("Revenue Cloud", isDark ? "#00D4FF" : "#0098CC", rows([
        ["Catalog", product.catalog || "—"],
        ["Selling Model", product.sellingModel || "—"],
        ["Classification", product.classification || "—"],
        ["Price Book", product.priceBook || "—"],
        ["Base Price", formatProductPrice(product.basePrice, product.currencyIsoCode) || "—"],
        ["Tax", product.taxIncluded === null ? "—" : product.taxIncluded ? "Included" : "Excluded"],
      ], isDark ? "#00D4FF" : "#0098CC"))}

      {product.description && card("Description", isDark ? "#60B8FF" : "#1C6DBF", (
        <p className="text-[11px] leading-relaxed" style={{ color: "var(--rc-text-primary)" }}>
          {product.description}
        </p>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Edit mode — pre-populate from the CURRENT Salesforce values, diff back a
 * minimal patch on Save
 * ─────────────────────────────────────────────────────────────────────────── */
function fromEditDetail(p: ProductPayload): ProductState {
  return {
    ...EMPTY_PRODUCT,
    productName: p.productName,
    productCode: p.productCode,
    status: p.isActive !== false ? "Active" : "Draft",
    description: p.description ?? "",
    family: p.family ?? "",
    category: p.category ?? "",
    catalog: p.catalog ?? "",
    sellingModel: p.sellingModel ?? "",
    productType: p.productType === "bundle" ? "bundle" : "simple",
    isActive: p.isActive !== false,
    productOwner: p.productOwner ?? "",
    priceBook: p.priceBook || "Standard Price Book",
    basePrice: p.basePrice ?? "",
    currencyIsoCode: p.currencyIsoCode ?? "",
    unitOfMeasure: p.unitOfMeasure ?? "",
    classification: p.classification ?? "",
  };
}

/** Only the fields that actually differ from what was loaded — sent to PATCH /api/sf/products/[id]. */
function buildEditPatch(product: ProductState, original: ProductPayload): Partial<ProductPayload> {
  const patch: Partial<ProductPayload> = {};
  if (product.productName !== original.productName) patch.productName = product.productName;
  if (product.productCode !== original.productCode) patch.productCode = product.productCode;
  if (product.family !== original.family) patch.family = product.family;
  if ((product.category || undefined) !== original.category) patch.category = product.category || undefined;
  if ((product.catalog || undefined) !== original.catalog) patch.catalog = product.catalog || undefined;
  if ((product.description || undefined) !== original.description) patch.description = product.description || undefined;
  if (product.isActive !== (original.isActive !== false)) patch.isActive = product.isActive;
  if ((product.sellingModel || undefined) !== original.sellingModel) patch.sellingModel = product.sellingModel || undefined;
  if ((product.productOwner || undefined) !== original.productOwner) patch.productOwner = product.productOwner || undefined;
  if ((product.priceBook || undefined) !== original.priceBook) patch.priceBook = product.priceBook || undefined;
  if ((product.basePrice || undefined) !== original.basePrice) patch.basePrice = product.basePrice || undefined;
  if ((product.currencyIsoCode || undefined) !== original.currencyIsoCode) patch.currencyIsoCode = product.currencyIsoCode || undefined;
  if ((product.unitOfMeasure || undefined) !== original.unitOfMeasure && product.unitOfMeasure) patch.unitOfMeasure = product.unitOfMeasure;
  if ((product.classification || undefined) !== original.classification && product.classification) patch.classification = product.classification;
  const wasBundle = original.productType === "bundle";
  if (product.productType === "bundle" && !wasBundle) patch.productType = "bundle";
  return patch;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Main Component
 * ─────────────────────────────────────────────────────────────────────────── */
export default function RCProductWorkspace({ isDark, editProductId, onSaved, onCancel }: {
  isDark: boolean;
  /** When set, opens in Edit mode: loads this Product2's current values from Salesforce and Save Changes updates it (never creates a new one). */
  editProductId?: string;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const notifySalesforceSuccess = useSalesforceSuccess();
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
  // Whether Product Code was explicitly set (by the user, or by an AI extraction that found one
  // in the prompt) rather than auto-derived from the Product Name — state, not a ref, because the
  // Field Mapping table needs to read it during render.
  const [codeIsManual, setCodeIsManual] = useState(!!editProductId);
  const [intent, setIntent] = useState<ProductIntentMap | null>(null);
  const isEditMode = !!editProductId;
  const [editContext, setEditContext] = useState<ProductEditContext | null>(null);
  const [editLoad, setEditLoad] = useState<"loading" | "ready" | "error">(editProductId ? "loading" : "ready");
  const [editLoadError, setEditLoadError] = useState<string | null>(null);
  const [duplicateCheck, setDuplicateCheck] = useState<DuplicateCheckResult | null>(null);

  /* ── Edit mode: load the product's CURRENT Salesforce values ── */
  useEffect(() => {
    if (!editProductId) return;
    fetch(`/api/sf/products/${editProductId}`)
      .then(async res => {
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error ?? "Could not load this product");
        setEditContext({ id: editProductId, original: data.product });
        setProduct(fromEditDetail(data.product));
        setEditLoad("ready");
      })
      .catch(err => {
        setEditLoadError(err instanceof Error ? err.message : "Could not load this product");
        setEditLoad("error");
      });
  }, [editProductId]);

  const cssVars = rcCssVars(isDark);

  const border = isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.18)";

  // Product Code auto-derives from Product Name as the user types, exactly like typing it in
  // manually always has — applied directly where productName changes (here, and in handleGenerate
  // below) rather than via a reactive effect, so there's no synchronous setState-in-effect.
  const setField = useCallback(<K extends keyof ProductState>(key: K, value: ProductState[K]) => {
    setProduct(p => {
      const next = { ...p, [key]: value };
      if (key === "family") {
        next.catalog = CATALOG_MAP[value as string] ?? "";
        next.category = "";
      }
      if (key === "productName" && !codeIsManual) {
        next.productCode = autoCode(value as string);
      }
      // Product2 has no Status field — IsActive is what Salesforce stores, so the
      // two controls are kept in sync instead of letting them contradict each other.
      if (key === "status") next.isActive = value === "Active";
      if (key === "isActive") next.status = value ? "Active" : (p.status === "Active" ? "Draft" : p.status);
      return next;
    });
    if (key === "productCode") setCodeIsManual(true);
  }, [codeIsManual]);

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
    setCodeIsManual(false);

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
      const nextIntent: ProductIntentMap | null = data.intent ?? null;
      setProduct(prev => ({
        ...prev,
        productName:    p.productName  ?? "",
        productCode:    p.productCode || autoCode(p.productName ?? ""),
        status:         p.isActive !== false ? "Active" : "Draft",
        description:    p.description  ?? "",
        family:         p.family       ?? "",
        category:       p.category     ?? "",
        catalog:        p.catalog      ?? "",
        // Unspecified in the prompt stays blank — never force "One Time" just to fill the field.
        sellingModel:   p.sellingModel ?? "",
        productType:    p.productType === "bundle" ? "bundle" : "simple",
        productTypeRaw: nextIntent?.productType.value ?? "",
        isActive:       p.isActive !== false,
        unitOfMeasure:  p.unitOfMeasure || "Each",
        classification: p.classification ?? "",
        productOwner:   p.productOwner ?? "",
        // The extracted price was previously never copied into the form, so every
        // AI-generated product reached /save with basePrice "" and no PricebookEntry.
        basePrice:      p.basePrice ?? "",
        priceBook:      p.priceBook || "Standard Price Book",
        currencyIsoCode: p.currencyIsoCode ?? "",
        taxIncluded:    nextIntent?.taxIncluded.value ?? null,
      }));
      // Only treat the code as "explicitly set" if the AI actually extracted one from the
      // prompt — otherwise leave it false so the existing auto-generate-from-name effect fills
      // it in (a system default, shown as such in the Field Mapping table), same as manual entry.
      setCodeIsManual(nextIntent?.productCode.provenance === "explicit");
      setIntent(nextIntent);
      setAiPhase("done");
      setValidationIssues([]);
    } catch {
      setAiError("Network error — could not reach AI");
      setAiPhase("error");
    }
  }, [aiPrompt, aiPhase]);

  /* ── Deploy ── */
  const proceedToSave = useCallback(async () => {
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
      classification: product.classification || undefined,
      productOwner:   product.productOwner,
      priceBook:      product.priceBook,
      basePrice:      product.basePrice,
      currencyIsoCode: product.currencyIsoCode || undefined,
    };

    try {
      const res = await fetch("/api/sf/products/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        // The backend re-runs the same duplicate check as its own final gate
        // (§21) — surface that result the same way the frontend pre-check
        // would have, rather than a generic error, in case a concurrent
        // request created it between our pre-check and this save.
        if (data.duplicate) {
          setDuplicateCheck(data.duplicate as DuplicateCheckResult);
          setDeployPhase("idle");
          return;
        }
        setDeployError(data.error ?? "Deployment failed");
        setDeployPhase("idle");
        return;
      }
      setDeployResult(data as DeployResult);
      setDeployPhase("done");

      const instanceUrl = loadSession()?.instanceUrl;
      if (instanceUrl && data.salesforceId) {
        const record = toCreatedSalesforceRecord(instanceUrl, "Product2", data.salesforceId, product.productName);
        notifySalesforceSuccess({
          title: "Product Created Successfully",
          message: data.priceError
            ? `${record.recordName} was created in Salesforce, but its price was NOT saved: ${data.priceError}`
            : `${record.recordName} has been successfully created in Salesforce.`,
          records: [record],
        });
      }
    } catch {
      setDeployError("Network error — could not reach Salesforce");
      setDeployPhase("idle");
    }
  }, [product, notifySalesforceSuccess]);

  const handleDeploy = useCallback(async () => {
    const issues = validate();
    if (issues.length > 0) return;

    setDeployPhase("deploying");
    setDeployError(null);

    // Duplicate Prevention pre-check (§1, §20) — runs before the create
    // request itself. Advisory only: /api/sf/products/save re-runs this
    // exact check server-side as the final authority (§21), so a failed
    // pre-check (network hiccup) doesn't need to block the user — it just
    // means the backend gate is the one that'll catch a real duplicate.
    try {
      const res = await fetch("/api/sf/products/check-duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ key: "product", name: product.productName, code: product.productCode }] }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const result = data.results.product as DuplicateCheckResult;
        if (result.isDuplicate || result.similarRecords.length > 0) {
          setDuplicateCheck(result);
          setDeployPhase("idle");
          return;
        }
      }
    } catch { /* pre-check failed — fall through to the backend's own authoritative check */ }

    await proceedToSave();
  }, [product, validate, proceedToSave]);

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
    setCodeIsManual(false);
    setIntent(null);
    setDuplicateCheck(null);
  };

  /* ── Save edit (UPDATE, never CREATE) ── */
  const handleSaveEdit = useCallback(async () => {
    if (!editContext) return;
    const issues = validate();
    if (issues.length > 0) return;

    const patch = buildEditPatch(product, editContext.original);
    if (Object.keys(patch).length === 0) {
      setDeployError("No changes to save.");
      return;
    }

    setDeployPhase("deploying");
    setDeployError(null);

    try {
      const res = await fetch(`/api/sf/products/${editContext.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setDeployError(data.error ?? "Update failed");
        setDeployPhase("idle");
        return;
      }
      setDeployResult(data as DeployResult);
      setDeployPhase("done");

      const instanceUrl = loadSession()?.instanceUrl;
      if (instanceUrl) {
        const record = toCreatedSalesforceRecord(instanceUrl, "Product2", editContext.id, product.productName);
        notifySalesforceSuccess({
          title: "Product Updated Successfully",
          message: `${record.recordName} has been successfully updated in Salesforce.`,
          records: [record],
        });
      }
      onSaved?.();
    } catch {
      setDeployError("Network error — could not reach Salesforce");
      setDeployPhase("idle");
    }
  }, [editContext, product, validate, notifySalesforceSuccess, onSaved]);

  /* ── Edit mode: block the form until the current Salesforce values have loaded ── */
  if (isEditMode && editLoad !== "ready") {
    return (
      <div className="flex flex-col h-full items-center justify-center" style={cssVars}>
        {editLoad === "loading" ? (
          <div className="flex items-center gap-2 text-[13px]" style={{ color: "var(--rc-text-muted)" }}>
            <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
              <Ic n="refresh" s={16} />
            </motion.span>
            Loading product…
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center px-6">
            <div style={{ color: "#E84444" }}><Ic n="alert" s={22} /></div>
            <p className="text-[13px]" style={{ color: "var(--rc-text-primary)" }}>{editLoadError}</p>
            <motion.button onClick={onCancel}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-medium cursor-pointer"
              style={{ color: "var(--rc-text-muted)", border: "1px solid var(--rc-field-border)", background: "transparent" }}
              whileTap={{ scale: 0.96 }}>
              <Ic n="arrow-left" s={12} />Back
            </motion.button>
          </div>
        )}
      </div>
    );
  }

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
    classification: product.classification || undefined,
    productOwner:   product.productOwner || undefined,
    priceBook:      product.priceBook || undefined,
    basePrice:      product.basePrice || undefined,
    currencyIsoCode: product.currencyIsoCode || undefined,
  }, null, 2);

  const mappingRows = buildProductMappingRows(product, intent, codeIsManual);

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
              style={{ background: "linear-gradient(135deg, rgba(30,144,255,0.18) 0%, rgba(0,212,255,0.12) 100%)", border: "1px solid rgba(30,144,255,0.22)", color: isDark ? "#1E90FF" : "#0968D3" }}>
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
                    {isEditMode && (
                      <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full"
                        style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.35)", color: "#F59E0B" }}>
                        EDITING
                      </span>
                    )}
                    <span className="text-[9px] font-mono px-2 py-0.5 rounded"
                      style={{ background: isDark ? "rgba(30,144,255,0.08)" : "rgba(0,71,171,0.10)", border, color: isDark ? "#3AABFF" : "#0047AB" }}>
                      {product.productCode || "—"}
                    </span>
                    <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: statusColors[product.status].bg, border: `1px solid ${statusColors[product.status].border}`, color: statusColors[product.status].text }}>
                      {product.status}
                    </span>
                    <span className="text-[9px] font-mono px-2 py-0.5 rounded"
                      style={{ background: "rgba(0,212,255,0.08)", border: "1px solid rgba(0,212,255,0.2)", color: isDark ? "#00D4FF" : "#0098CC" }}>
                      EPC v62.0
                    </span>
                  </div>
                )}
                {!product.productName && (
                  <span className="text-[9px] font-mono px-2 py-0.5 rounded"
                    style={{ background: "rgba(0,212,255,0.08)", border: "1px solid rgba(0,212,255,0.2)", color: isDark ? "#00D4FF" : "#0098CC" }}>
                    AI · EPC v62.0
                  </span>
                )}
              </div>
              <p className="text-[12px] mt-1 leading-relaxed" style={{ color: "var(--rc-text-muted)" }}>
                {isEditMode
                  ? "Editing an existing Salesforce product — Save Changes updates this record, it never creates a new one."
                  : product.productName
                    ? (product.description || "Revenue Cloud product workspace")
                    : "Describe your product to auto-fill all fields, or fill manually and deploy to Salesforce."}
              </p>
            </div>
          </div>

          {isEditMode ? (
            <motion.button onClick={onCancel}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-medium cursor-pointer shrink-0"
              style={{ color: "var(--rc-text-muted)", border, background: "transparent" }}
              whileHover={{ background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.09)" }}
              whileTap={{ scale: 0.96 }}>
              <Ic n="arrow-left" s={12} />Cancel
            </motion.button>
          ) : product.productName && (
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
                    onChange={v => { setCodeIsManual(true); setField("productCode", v); }}
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
                    options={product.unitOfMeasure && !UNIT_OF_MEASURES.includes(product.unitOfMeasure) ? [product.unitOfMeasure, ...UNIT_OF_MEASURES] : UNIT_OF_MEASURES} />
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
                          color: (product.isActive ? "Yes" : "No") === v ? (isDark ? "#1E90FF" : "#0968D3") : "var(--rc-text-muted)",
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
                      style={{ background: "rgba(0,212,255,0.1)", border: "1px solid rgba(0,212,255,0.25)", color: isDark ? "#00D4FF" : "#0098CC" }}>
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
                  style={{ color: isDark ? "rgba(30,144,255,0.4)" : "rgba(15,45,100,0.6)" }}>
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

              <div className="mb-3">
                <PromptGuide isDark={isDark} config={promptGuideConfig.product} onUseExample={setAiPrompt} />
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
                    options={["", ...SELLING_MODELS]} />
                </FieldWrap>
                <FieldWrap label="Product Owner">
                  <FInput value={product.productOwner} onChange={v => setField("productOwner", v)}
                    placeholder="e.g. jane.doe@company.com" />
                </FieldWrap>
                <FieldWrap label="Price Book">
                  <FInput value={product.priceBook} onChange={v => setField("priceBook", v)}
                    placeholder="Standard Price Book" />
                </FieldWrap>
                <FieldWrap label="Base Price">
                  <FInput value={product.basePrice} onChange={v => setField("basePrice", v)}
                    placeholder="0.00" type="number" />
                </FieldWrap>
                <FieldWrap label="Currency">
                  <FInput value={product.currencyIsoCode} onChange={v => setField("currencyIsoCode", v)}
                    placeholder="USD" />
                </FieldWrap>
                <FieldWrap label="Product Type (as stated)">
                  <FInput value={product.productTypeRaw} onChange={v => setField("productTypeRaw", v)}
                    placeholder="e.g. Physical" />
                </FieldWrap>
                <FieldWrap label="Tax Included">
                  <div className="flex gap-2 pt-0.5">
                    {([["Yes", true], ["No", false], ["Not specified", null]] as const).map(([label, v]) => (
                      <motion.button key={label}
                        onClick={() => setField("taxIncluded", v)}
                        className="flex-1 py-2 rounded-lg text-[10.5px] font-medium cursor-pointer"
                        style={{
                          background: product.taxIncluded === v ? "rgba(30,144,255,0.14)" : "var(--rc-field-bg)",
                          border: `1px solid ${product.taxIncluded === v ? "rgba(30,144,255,0.35)" : "var(--rc-field-border)"}`,
                          color: product.taxIncluded === v ? (isDark ? "#1E90FF" : "#0968D3") : "var(--rc-text-muted)",
                        }}
                        whileTap={{ scale: 0.96 }}>{label}</motion.button>
                    ))}
                  </div>
                </FieldWrap>
              </div>
              <p className="text-[10px] mt-1.5 leading-relaxed" style={{ color: "var(--rc-text-muted)" }}>
                Tax Included is not sent to Salesforce — Product2/PricebookEntry have no standard field for it. It&apos;s tracked here so the prompt&apos;s meaning isn&apos;t lost.
              </p>

              {/* RC Config summary cards */}
              {(product.catalog || product.category || product.sellingModel || product.classification) && (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-2">
                  {product.catalog        && <RCConfigCard icon="layers"       label="Catalog"         value={product.catalog}         color={isDark ? "#1E90FF" : "#0968D3"} />}
                  {product.category       && <RCConfigCard icon="tag"          label="Category"        value={product.category}        color={isDark ? "#3AABFF" : "#1789B0"} sub={product.family} />}
                  {product.sellingModel   && <RCConfigCard icon="zap"          label="Selling Model"   value={product.sellingModel}    color={isDark ? "#00D4FF" : "#0098CC"} />}
                  {product.classification && <RCConfigCard icon="package"      label="Classification"  value={product.classification}  color={isDark ? "#60B8FF" : "#1C6DBF"} />}
                  {product.priceBook      && <RCConfigCard icon="book-open"    label="Price Book"      value={product.priceBook}       color={isDark ? "#0070D6" : "#0047AB"} sub={formatProductPrice(product.basePrice, product.currencyIsoCode) || undefined} />}
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
              <div style={{ color: isDark ? "#1E90FF" : "#0968D3" }}><Ic n="rocket" s={14} /></div>
              <span className="text-[12px] font-bold" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.01em" }}>
                Deploy &amp; Preview
              </span>
              {deployPhase === "done" && deployResult && (
                <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  className="ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: "rgba(0,212,255,0.1)", border: "1px solid rgba(0,212,255,0.25)", color: isDark ? "#00D4FF" : "#0098CC" }}>
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
                  <div className="text-[10px] font-semibold mb-2" style={{ color: isDark ? "#1E90FF" : "#0968D3" }}>{isEditMode ? "Product Updated in Salesforce" : "Product Created in Salesforce"}</div>
                  <div className="flex items-center gap-2 mb-2.5">
                    <span className="text-[9px] font-mono" style={{ color: isDark ? "rgba(30,144,255,0.6)" : "rgba(15,45,100,0.6)" }}>ID</span>
                    <span className="text-[11px] font-mono font-semibold truncate flex-1" style={{ color: isDark ? "#3AABFF" : "#1789B0" }}>{deployResult.salesforceId}</span>
                    <motion.button onClick={() => {
                      navigator.clipboard.writeText(deployResult.salesforceId ?? "");
                      setCopied(true); setTimeout(() => setCopied(false), 1600);
                    }} style={{ color: isDark ? "rgba(0,212,255,0.6)" : "rgba(0,152,204,0.7)", flexShrink: 0 }} whileTap={{ scale: 0.9 }}>
                      <Ic n="copy" s={11} />
                    </motion.button>
                    {copied && <span className="text-[9px]" style={{ color: isDark ? "#00D4FF" : "#0098CC" }}>Copied!</span>}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {[
                      deployResult.steps.product        && { ok: true,  label: isEditMode ? "Product2 updated" : "Product2 created" },
                      deployResult.steps.catalog        && { ok: true,  label: `Catalog: ${(deployResult.steps.catalog as StepResult).name}` },
                      deployResult.steps.sellingModel   && { ok: true,  label: "Selling Model linked" },
                      deployResult.steps.unitOfMeasure  && { ok: true,  label: `Unit of Measure: ${(deployResult.steps.unitOfMeasure as StepResult).value}` },
                      deployResult.steps.classification && { ok: true,  label: `Classification: ${(deployResult.steps.classification as StepResult).value}` },
                      // Shows the UnitPrice Salesforce actually stored (read back server-side), not the form value.
                      deployResult.steps.pricebookEntry && { ok: true,  label: `Price saved: ${formatProductPrice((deployResult.steps.pricebookEntry as StepResult).unitPrice, (deployResult.steps.pricebookEntry as StepResult).currencyIsoCode as string | undefined)} in ${(deployResult.steps.pricebookEntry as StepResult).pricebook}` },
                      ...deployResult.errors.map(e => ({ ok: false, label: e.step === "pricebookEntry" ? `Price NOT saved: ${e.error}` : `Error: ${e.step} — ${e.error}` })),
                      ...deployResult.skipped.map(s => ({ ok: null,  label: `Skipped: ${s.step} — ${s.reason}` })),
                      ...(deployResult.warnings ?? []).map(w => ({ ok: null, label: w })),
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

            {/* Field Mapping — visible before Deploy, per-field Provided/Default/Not specified */}
            {product.productName && (
              <div className="mb-4">
                <p className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--rc-text-section)" }}>
                  Field Mapping
                </p>
                <FieldMappingTable rows={mappingRows} />
              </div>
            )}

            {/* Deploy / Save button */}
            <motion.button
              onClick={isEditMode ? handleSaveEdit : handleDeploy}
              disabled={deployPhase === "deploying"}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-[12px] font-bold cursor-pointer"
              style={{
                background: deployPhase === "deploying"
                  ? isDark ? "rgba(30,144,255,0.08)" : "rgba(30,144,255,0.06)"
                  : "linear-gradient(135deg, #0070D6 0%, #00D4FF 100%)",
                color: deployPhase === "deploying" ? (isDark ? "#1E90FF" : "#0968D3") : "rgba(0,10,20,0.92)",
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
                  {isEditMode ? "Saving Changes…" : "Creating Salesforce Records…"}
                </>
              ) : (
                <>
                  <Ic n={isEditMode ? "check-circle" : "rocket"} s={13} />
                  {isEditMode ? "Save Changes" : "Create Record in Salesforce"}
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
                      style={{ background: "rgba(30,144,255,0.08)", border: "1px solid rgba(30,144,255,0.15)", color: isDark ? "#3AABFF" : "#1789B0" }}>
                      {product.family}
                    </span>
                  )}
                  {product.sellingModel && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded"
                      style={{ background: "rgba(0,212,255,0.07)", border: "1px solid rgba(0,212,255,0.15)", color: isDark ? "#00D4FF" : "#0098CC" }}>
                      {product.sellingModel}
                    </span>
                  )}
                </div>
              </motion.div>
            )}

          </div>
        </div>

      </div>

      {duplicateCheck && (
        <DuplicateRecordModal
          isDark={isDark}
          kind="product"
          requestedName={product.productName}
          result={duplicateCheck}
          onClose={() => {
            const wasAdvisoryOnly = !duplicateCheck.isDuplicate;
            setDuplicateCheck(null);
            if (wasAdvisoryOnly) void proceedToSave();
          }}
          onChooseAnotherName={() => setDuplicateCheck(null)}
          onUseExisting={duplicateCheck.isDuplicate ? () => { setDuplicateCheck(null); onCancel?.(); } : undefined}
        />
      )}
    </div>
  );
}
