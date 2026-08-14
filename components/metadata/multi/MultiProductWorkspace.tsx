"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Ic, FieldWrap, FInput, FSelect, FTextarea, rcCssVars,
  autoCode, SELLING_MODELS, FAMILIES, CATEGORY_MAP, UNIT_OF_MEASURES,
} from "@/components/metadata/shared/productFields";
import FieldMappingTable from "@/components/metadata/shared/FieldMappingTable";
import type { ProductPayload, ProductDeployResult } from "@/lib/products/types";
import type { ProductIntentMap } from "@/lib/products/ai/productIntent";
import { buildProductMappingRows } from "@/lib/products/ai/productMappingRows";
import type { GenerateMultiProductResponse } from "@/app/api/sf/products/generate-payload-multi/route";
import type { CanonicalField } from "@/lib/products/import/columnMapping";
import type { ImportRowResult } from "@/lib/products/import/validateRows";
import type { ProductImportValidateResponse } from "@/app/api/sf/products/import/validate/route";
import ImportCreateStep, { type CreateQueueItem, type ExcludedQueueItem } from "@/components/import/ImportCreateStep";
import PromptGuide from "@/components/ai/PromptGuide";
import { promptGuideConfig } from "@/lib/ai/promptGuideConfig";

type Step = "prompt" | "review" | "create";

/**
 * Editable draft shape — the Salesforce-facing fields are exactly
 * ProductPayload's own fields (see toPayload() below); `status` is a
 * UI-only field mirroring RCProductWorkspace's own ProductState (never
 * sent to /api/sf/products/save, same as the single-product form).
 * "The multiple-product object is simply { products: ProductPayload[] }."
 */
interface MultiProductDraft {
  productName: string;
  productCode: string;
  status: "Draft" | "Active" | "Archived";
  description: string;
  family: string;
  category: string;
  catalog: string;
  sellingModel: string;
  productType: "simple" | "bundle";
  /** Verbatim "product type" text from the prompt (e.g. "Physical") — separate from the simple/bundle toggle, which only controls actual bundle behavior. */
  productTypeRaw: string;
  isActive: boolean;
  unitOfMeasure: string;
  productOwner: string;
  priceBook: string;
  basePrice: string;
  currencyIsoCode: string;
  /** null = the prompt said nothing about tax for this product. Never sent to /api/sf/products/save (no such Salesforce field exists) — carried through review only. */
  taxIncluded: boolean | null;
}

const EMPTY_DRAFT: MultiProductDraft = {
  productName: "", productCode: "", status: "Draft", description: "",
  family: "", category: "", catalog: "", sellingModel: "One Time",
  productType: "simple", productTypeRaw: "", isActive: true, unitOfMeasure: "Each",
  productOwner: "", priceBook: "Standard Price Book", basePrice: "", currencyIsoCode: "",
  taxIncluded: null,
};

function fromAiProduct(p: ProductPayload, intent: ProductIntentMap | undefined): MultiProductDraft {
  return {
    ...EMPTY_DRAFT,
    productName: p.productName,
    productCode: p.productCode || autoCode(p.productName),
    description: p.description ?? "",
    family: p.family ?? "",
    category: p.category ?? "",
    catalog: p.catalog ?? "",
    // Unspecified in the prompt stays blank — never force "One Time" just to fill the field.
    sellingModel: p.sellingModel ?? "",
    productType: p.productType?.toLowerCase() === "bundle" ? "bundle" : "simple",
    productTypeRaw: intent?.productType.value ?? "",
    isActive: p.isActive !== false,
    productOwner: p.productOwner ?? "",
    basePrice: p.basePrice ?? "",
    currencyIsoCode: p.currencyIsoCode ?? "",
    taxIncluded: intent?.taxIncluded.value ?? null,
  };
}

/** The exact payload /api/sf/products/save accepts — identical conversion RCProductWorkspace's own handleDeploy performs. */
function toPayload(d: MultiProductDraft): ProductPayload {
  return {
    productName: d.productName,
    productCode: d.productCode,
    family: d.family,
    category: d.category || undefined,
    catalog: d.catalog || undefined,
    description: d.description || undefined,
    isActive: d.isActive,
    sellingModel: d.sellingModel || undefined,
    productOwner: d.productOwner || undefined,
    priceBook: d.priceBook || undefined,
    basePrice: d.basePrice || undefined,
    productType: d.productType === "bundle" ? "bundle" : undefined,
    currencyIsoCode: d.currencyIsoCode || undefined,
  };
}

/**
 * Field-independent AI extraction (see generate-payload-multi's system
 * prompt) legitimately produces Family/Category/Catalog/Selling Model
 * values outside RCProductWorkspace's fixed dropdown lists when the
 * prompt names one explicitly (e.g. "product family Computers"). Rather
 * than silently dropping or hiding that value, every dropdown here always
 * includes the draft's current value even if it isn't one of the
 * canonical options.
 */
function optionsWithCurrent(list: string[], current: string): string[] {
  return current && !list.includes(current) ? [current, ...list] : list;
}

const CANONICAL_MAPPING: Record<CanonicalField, string | null> = {
  name: "name", productCode: "productCode", description: "description", family: "family",
  type: "type", category: "category", catalog: "catalog", sellingModel: "sellingModel",
  price: "price", currency: "currency", isActive: "isActive",
};

function draftToCanonicalRow(d: MultiProductDraft): Record<string, string> {
  return {
    name: d.productName, productCode: d.productCode, description: d.description, family: d.family,
    type: d.productType === "bundle" ? "bundle" : "", category: d.category, catalog: d.catalog,
    sellingModel: d.sellingModel, price: d.basePrice, currency: d.currencyIsoCode,
    isActive: d.isActive ? "true" : "false",
  };
}

function localIssues(d: MultiProductDraft): string[] {
  const issues: string[] = [];
  if (!d.productName.trim()) issues.push("Product Name is required.");
  if (!d.family.trim()) issues.push("Product Family is required.");
  return issues;
}

type ReviewStatus = "ok" | "warning" | "error" | "duplicate" | "unchecked";

function reviewStatus(index: number, draft: MultiProductDraft, rows: ImportRowResult[]): ReviewStatus {
  if (localIssues(draft).length > 0) return "error";
  const r = rows.find(row => row.index === index);
  if (!r) return "unchecked";
  // Duplicate Prevention (§1, §16 acceptance criteria): a product that
  // already exists in Salesforce is never treated as "Ready" — it's
  // excluded from the create queue below, same as a hard validation error.
  if (r.status === "skipped") return "duplicate";
  if (r.status === "error") return "error";
  if (r.status === "warning") return "warning";
  return "ok";
}

const STATUS_META: Record<ReviewStatus, { label: string; color: string; icon: string }> = {
  ok:        { label: "Ready",             color: "#22C55E", icon: "check-circle" },
  warning:   { label: "Warning",           color: "#F59E0B", icon: "alert" },
  error:     { label: "Needs attention",   color: "#FF4066", icon: "x-circle" },
  duplicate: { label: "Duplicate",         color: "#FF4066", icon: "alert" },
  unchecked: { label: "Not yet checked",   color: "#5A78A0", icon: "info" },
};

async function createOneProduct(payload: ProductPayload): Promise<{ id?: string; error?: string }> {
  try {
    const res = await fetch("/api/sf/products/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json() as ProductDeployResult;
    if (!res.ok || !data.success) return { error: data.error ?? "Salesforce rejected this product." };
    return { id: data.salesforceId };
  } catch {
    return { error: "Network error — could not reach Salesforce." };
  }
}

const EXAMPLE_PROMPT = "Create three products: Laptop Pro 15 with product family Computers, catalog Hardware Catalog, category Laptops, selling model One Time, and base price 1200; Wireless Mouse with product family Accessories, catalog Hardware Catalog, category Computer Accessories, selling model One Time, and base price 40; Office Monitor 27 with product family Displays, catalog Hardware Catalog, category Monitors, selling model One Time, and base price 300.";

/**
 * Multiple Product Creation workspace — Prompt → Generate → Product 1-of-N
 * review wizard → All Products Ready → Deploy. This is NOT a second
 * product-creation experience: every field is the exact same
 * ProductPayload shape and the exact same field components
 * (Ic/FieldWrap/FInput/FSelect/FTextarea, RC blue styling) that
 * RCProductWorkspace.tsx — the Single Product workspace — uses, imported
 * from the shared components/metadata/shared/productFields module rather
 * than re-implemented. Validation reuses the existing
 * /api/sf/products/import/validate endpoint (same catalog/category/
 * selling-model resolution the CSV bulk importer already relies on) for
 * read-only status feedback; the actual create payload always comes from
 * the live-edited draft so edits made while stepping through the review
 * wizard are never silently discarded. Creation reuses the existing
 * /api/sf/products/save endpoint, one product at a time via the shared
 * ImportCreateStep, with stopOnFailure enabled so a failure does not
 * silently continue past later products.
 */
export default function MultiProductWorkspace({ isDark }: { isDark: boolean }) {
  const cssVars = rcCssVars(isDark);
  const border = isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.18)";

  const [step, setStep] = useState<Step>("prompt");
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<MultiProductDraft[]>([]);
  const [intents, setIntents] = useState<ProductIntentMap[]>([]);
  const [page, setPage] = useState(0); // 0..drafts.length-1 = product pages; drafts.length = "All Products Ready" summary
  const [needsValidate, setNeedsValidate] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [validateResult, setValidateResult] = useState<ProductImportValidateResponse | null>(null);
  const [showJson, setShowJson] = useState(false);

  const rows: ImportRowResult[] = validateResult?.rows ?? [];

  const runValidate = async (rowsToCheck: MultiProductDraft[]) => {
    setValidating(true);
    setValidateError(null);
    try {
      const res = await fetch("/api/sf/products/import/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: rowsToCheck.map(draftToCanonicalRow), mapping: CANONICAL_MAPPING }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setValidateError(data.error ?? "Could not check these products against Salesforce.");
        return;
      }
      setValidateResult(data as ProductImportValidateResponse);
      setNeedsValidate(false);
    } catch {
      setValidateError("Network error — could not reach the server to check these products.");
    } finally {
      setValidating(false);
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await fetch("/api/sf/products/generate-payload-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setGenerateError(data.error ?? "Could not generate products from this prompt.");
        return;
      }
      const { products, intents: nextIntents } = data as GenerateMultiProductResponse;
      const nextDrafts = products.map((p, i) => fromAiProduct(p, nextIntents[i]));
      setDrafts(nextDrafts);
      setIntents(nextIntents);
      setValidateResult(null);
      setPage(0);
      setStep("review");
      await runValidate(nextDrafts);
    } catch {
      setGenerateError("Network error — could not reach the server to generate these products.");
    } finally {
      setGenerating(false);
    }
  };

  const updateDraft = (index: number, patch: Partial<MultiProductDraft>) => {
    setDrafts(prev => prev.map((d, i) => {
      if (i !== index) return d;
      const next = { ...d, ...patch };
      // Mirrors RCProductWorkspace's own setField: changing Family resets Category (Catalog is left as-is here since the AI/user may have already set a specific catalog for this product).
      if (patch.family !== undefined && patch.family !== d.family) next.category = "";
      return next;
    }));
    setNeedsValidate(true);
  };

  const handleReset = () => {
    setPrompt(""); setDrafts([]); setIntents([]); setValidateResult(null); setValidateError(null); setGenerateError(null);
    setNeedsValidate(false); setPage(0); setShowJson(false); setStep("prompt");
  };

  const createItems: CreateQueueItem[] = [];
  const excludedItems: ExcludedQueueItem[] = [];
  drafts.forEach((d, i) => {
    const name = d.productName || `Product ${i + 1}`;
    const status = reviewStatus(i, d, rows);
    if (status === "error" || status === "duplicate") {
      const reason = status === "duplicate"
        ? (rows.find(r => r.index === i)?.issues.find(iss => iss.field === "duplicate")?.message ?? "Already exists in Salesforce.")
        : (localIssues(d)[0] ?? rows.find(r => r.index === i)?.issues.find(iss => iss.level === "error")?.message ?? "Blocked by a validation error.");
      excludedItems.push({ index: i, name, reason });
    } else {
      createItems.push({ index: i, name, create: () => createOneProduct(toPayload(d)) });
    }
  });

  const jsonPreview = JSON.stringify({
    products: drafts.map((d, i) => {
      const payload = toPayload(d);
      const r = rows.find(row => row.index === i);
      if (!r) return payload;
      return {
        ...payload,
        resolvedSellingModelId: r.resolvedSellingModelId ?? undefined,
        catalogExistsInSalesforce: r.catalogResolved ?? undefined,
        categoryExistsInSalesforce: r.categoryResolved ?? undefined,
      };
    }),
  }, null, 2);

  /* ── Create step ── */
  if (step === "create") {
    return (
      <div className="flex flex-col h-full" style={cssVars}>
        <Header isDark={isDark} border={border} count={drafts.length} />
        <div className="flex-1 overflow-y-auto">
          <ImportCreateStep
            isDark={isDark}
            items={createItems}
            excluded={excludedItems}
            totalCount={drafts.length}
            warningsCount={validateResult?.summary.warnings ?? 0}
            nounSingular="Product"
            nounPlural="Products"
            objectApiName="Product2"
            stopOnFailure
            onBack={handleReset}
          />
        </div>
      </div>
    );
  }

  /* ── Prompt step ── */
  if (step === "prompt") {
    return (
      <div className="flex flex-col h-full" style={cssVars}>
        <Header isDark={isDark} border={border} count={drafts.length} />
        <div className="flex-1 overflow-y-auto">
          <div className="px-6 py-5 max-w-3xl">
            <p className="text-[11px] leading-relaxed mb-3" style={{ color: "var(--rc-text-muted)" }}>
              Describe several products in one natural-language prompt — each one gets its own independent Family, Catalog, Category, Selling Model, and Price. Supports 2, 3, 5, 10, 20+ products in a single prompt. Nothing is created in Salesforce until you review every product and click Deploy.
            </p>

            <div className="relative mb-3">
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
                placeholder={EXAMPLE_PROMPT}
                rows={7}
                disabled={generating}
                className="w-full rounded-xl px-4 py-3.5 text-[13px] resize-none outline-none"
                style={{
                  background: isDark ? "rgba(30,144,255,0.06)" : "rgba(30,144,255,0.04)",
                  border: generating ? "1.5px solid rgba(30,144,255,0.45)" : "1.5px solid rgba(30,144,255,0.2)",
                  color: "var(--rc-text-primary)",
                  fontFamily: "inherit",
                  lineHeight: 1.65,
                  transition: "border-color 200ms",
                }}
                onFocus={e => (e.target.style.borderColor = "#1E90FF")}
                onBlur={e => (e.target.style.borderColor = generating ? "rgba(30,144,255,0.45)" : "rgba(30,144,255,0.22)")}
              />
              <div className="absolute bottom-2.5 right-3 text-[9px] font-mono pointer-events-none" style={{ color: "rgba(30,144,255,0.4)" }}>
                ⌘↵ to generate
              </div>
            </div>

            <div className="mb-3">
              <button
                onClick={() => setPrompt(EXAMPLE_PROMPT)}
                className="text-[10px] font-medium cursor-pointer"
                style={{ color: isDark ? "rgba(30,144,255,0.8)" : "#0047AB", background: "transparent", border: "none" }}
              >
                Use example prompt (3 products)
              </button>
            </div>

            <div className="mb-3">
              <PromptGuide isDark={isDark} config={promptGuideConfig.productMulti} onUseExample={setPrompt} />
            </div>

            {generateError && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="mb-3 px-3 py-2.5 rounded-lg flex items-start gap-2 text-[11px]"
                style={{ background: "rgba(232,68,68,0.08)", border: "1px solid rgba(232,68,68,0.2)", color: "#E84444" }}>
                <div className="mt-0.5 shrink-0"><Ic n="alert" s={13} /></div>
                {generateError}
              </motion.div>
            )}

            <motion.button
              onClick={handleGenerate}
              disabled={!prompt.trim() || generating}
              className="flex items-center gap-2.5 px-5 py-2.5 rounded-xl text-[13px] font-semibold cursor-pointer"
              style={{
                background: prompt.trim() && !generating ? "linear-gradient(135deg, #0070D6 0%, #00D4FF 100%)" : isDark ? "rgba(30,144,255,0.08)" : "rgba(30,144,255,0.06)",
                color: prompt.trim() && !generating ? "white" : "var(--rc-text-muted)",
                border: "none",
                opacity: prompt.trim() && !generating ? 1 : 0.55,
                boxShadow: prompt.trim() && !generating ? "0 4px 20px rgba(30,144,255,0.35)" : "none",
              }}
              whileHover={prompt.trim() && !generating ? { scale: 1.02, y: -1 } : {}}
              whileTap={prompt.trim() && !generating ? { scale: 0.97 } : {}}
            >
              {generating ? (
                <>
                  <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
                    <Ic n="refresh" s={15} />
                  </motion.span>
                  Analyzing products…
                </>
              ) : (
                <>
                  <Ic n="sparkles" s={15} />
                  Generate Products
                </>
              )}
            </motion.button>
          </div>
        </div>
      </div>
    );
  }

  /* ── Review step: Product 1-of-N wizard + All Products Ready summary ── */
  const isSummary = page >= drafts.length;
  const current = !isSummary ? drafts[page] : null;
  const currentStatus = current ? reviewStatus(page, current, rows) : "unchecked";

  return (
    <div className="flex flex-col h-full" style={cssVars}>
      <Header isDark={isDark} border={border} count={drafts.length} />

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-5">

          {/* Products Detected + stepper */}
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[9px] font-mono px-2 py-1 rounded" style={{ background: "rgba(30,144,255,0.1)", border: "1px solid rgba(30,144,255,0.25)", color: "#3AABFF" }}>
                Products Detected: {drafts.length}
              </span>
              {validating && (
                <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--rc-text-muted)" }}>
                  <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}><Ic n="refresh" s={12} /></motion.span>
                  Checking against Salesforce…
                </span>
              )}
              {needsValidate && !validating && (
                <button onClick={() => runValidate(drafts)} className="text-[10px] font-medium cursor-pointer" style={{ color: "#F59E0B", background: "transparent", border: "none" }}>
                  Products edited — click to re-check
                </button>
              )}
            </div>
            <button
              onClick={() => setShowJson(v => !v)}
              className="flex items-center gap-1.5 text-[10px] font-medium px-2.5 py-1.5 rounded-lg cursor-pointer"
              style={{ color: "#1E90FF", border: "1px solid rgba(30,144,255,0.2)", background: "transparent" }}
            >
              <Ic n={showJson ? "eye-off" : "code"} s={11} />
              {showJson ? "Hide JSON Preview" : "View JSON Preview"}
            </button>
          </div>

          {validateError && (
            <div className="mb-4 px-3 py-2.5 rounded-lg text-[11px]" style={{ background: "rgba(232,68,68,0.08)", border: "1px solid rgba(232,68,68,0.2)", color: "#E84444" }}>
              {validateError}
            </div>
          )}

          {/* Stepper dots — direct navigation to any product, in addition to Back/Next */}
          {drafts.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mb-5">
              {drafts.map((d, i) => {
                const s = reviewStatus(i, d, rows);
                const active = i === page;
                return (
                  <button
                    key={i}
                    onClick={() => setPage(i)}
                    title={d.productName || `Product ${i + 1}`}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold cursor-pointer"
                    style={{
                      background: active ? "rgba(30,144,255,0.16)" : "var(--rc-field-bg)",
                      border: `1px solid ${active ? "rgba(30,144,255,0.4)" : "var(--rc-field-border)"}`,
                      color: active ? "#1E90FF" : "var(--rc-text-muted)",
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: STATUS_META[s].color, display: "inline-block" }} />
                    {i + 1}
                  </button>
                );
              })}
              <button
                onClick={() => setPage(drafts.length)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold cursor-pointer"
                style={{
                  background: isSummary ? "rgba(30,144,255,0.16)" : "var(--rc-field-bg)",
                  border: `1px solid ${isSummary ? "rgba(30,144,255,0.4)" : "var(--rc-field-border)"}`,
                  color: isSummary ? "#1E90FF" : "var(--rc-text-muted)",
                }}
              >
                <Ic n="check-square" s={11} />
                Summary
              </button>
            </div>
          )}

          {drafts.length === 0 && (
            <div className="text-center py-16" style={{ color: "var(--rc-text-muted)" }}>
              <Ic n="package" s={28} />
              <p className="text-[13px] mt-3">No products generated yet.</p>
            </div>
          )}

          <AnimatePresence mode="wait">
            {current && (
              <motion.div key={page} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.16 }}>
                <ProductReviewCard
                  index={page}
                  total={drafts.length}
                  draft={current}
                  intent={intents[page]}
                  status={currentStatus}
                  issues={rows.find(r => r.index === page)?.issues ?? []}
                  onChange={patch => updateDraft(page, patch)}
                />
              </motion.div>
            )}

            {isSummary && drafts.length > 0 && (
              <motion.div key="summary" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.16 }}>
                <SummaryCard drafts={drafts} rows={rows} onEdit={i => setPage(i)} />
              </motion.div>
            )}
          </AnimatePresence>

          {showJson && (
            <div className="relative mt-4">
              <pre className="text-[9px] font-mono rounded-xl px-3 py-3 overflow-x-auto leading-relaxed"
                style={{
                  background: isDark ? "rgba(0,4,12,0.85)" : "rgba(228,235,252,0.9)",
                  border: "1px solid rgba(30,144,255,0.14)",
                  color: isDark ? "rgba(120,180,255,0.85)" : "#0047AB",
                  maxHeight: 380, overflowY: "auto",
                  whiteSpace: "pre-wrap", wordBreak: "break-all",
                }}>
                {jsonPreview}
              </pre>
            </div>
          )}

          {/* Back / Next / Deploy nav */}
          {drafts.length > 0 && (
            <div className="flex items-center justify-between mt-6">
              <div className="flex items-center gap-2">
                <NavButton icon="arrow-left" label="Back to Prompt" isDark={isDark} onClick={() => setStep("prompt")} />
                <NavButton icon="x" label="Clear / Reset" isDark={isDark} onClick={handleReset} />
              </div>
              <div className="flex items-center gap-2">
                {!isSummary && (
                  <>
                    <NavButton icon="arrow-left" label="Back" isDark={isDark} disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))} />
                    <NavButton icon="arrow-right" label={page === drafts.length - 1 ? "Review All" : "Next"} isDark={isDark} primary onClick={() => setPage(p => p + 1)} />
                  </>
                )}
                {isSummary && (
                  <>
                    <NavButton icon="arrow-left" label="Back" isDark={isDark} onClick={() => setPage(drafts.length - 1)} />
                    <motion.button
                      onClick={() => setStep("create")}
                      disabled={createItems.length === 0}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-[13px] font-bold cursor-pointer"
                      style={{
                        background: createItems.length > 0 ? "linear-gradient(135deg, #0070D6 0%, #00D4FF 100%)" : isDark ? "rgba(30,144,255,0.08)" : "rgba(30,144,255,0.06)",
                        color: createItems.length > 0 ? "white" : "var(--rc-text-muted)",
                        border: "none",
                        opacity: createItems.length > 0 ? 1 : 0.55,
                        boxShadow: createItems.length > 0 ? "0 4px 20px rgba(0,212,255,0.25)" : "none",
                      }}
                      whileHover={createItems.length > 0 ? { scale: 1.02, y: -1 } : {}}
                      whileTap={createItems.length > 0 ? { scale: 0.97 } : {}}
                    >
                      <Ic n="rocket" s={14} />
                      Deploy {createItems.length} Product{createItems.length === 1 ? "" : "s"} to Salesforce
                    </motion.button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Header({ isDark, border, count }: { isDark: boolean; border: string; count: number }) {
  return (
    <div className="px-6 py-5 shrink-0" style={{ borderBottom: border }}>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "linear-gradient(135deg, rgba(30,144,255,0.18) 0%, rgba(0,212,255,0.12) 100%)", border: "1px solid rgba(30,144,255,0.22)", color: "#1E90FF" }}>
          <Ic n="layers" s={18} />
        </div>
        <div>
          <h2 className="text-[18px] font-bold leading-tight" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.025em" }}>
            Create Multiple Products
          </h2>
          <p className="text-[12px] mt-0.5" style={{ color: "var(--rc-text-muted)" }}>
            {count > 0 ? `${count} product${count === 1 ? "" : "s"} in this batch` : "One prompt, several products — same fields, same Salesforce creation as Single Product."}
          </p>
        </div>
      </div>
    </div>
  );
}

function NavButton({ icon, label, isDark, onClick, disabled, primary }: {
  icon: string; label: string; isDark: boolean; onClick: () => void; disabled?: boolean; primary?: boolean;
}) {
  return (
    <motion.button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[11.5px] font-medium cursor-pointer"
      style={{
        color: disabled ? "var(--rc-text-muted)" : primary ? "#1E90FF" : isDark ? "rgba(30,144,255,0.85)" : "#0047AB",
        border: `1px solid ${primary ? "rgba(30,144,255,0.4)" : "rgba(30,144,255,0.2)"}`,
        background: primary ? "rgba(30,144,255,0.1)" : "transparent",
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
      whileHover={!disabled ? { background: "rgba(30,144,255,0.08)" } : {}}
      whileTap={!disabled ? { scale: 0.96 } : {}}
    >
      {icon === "arrow-right" ? null : <Ic n={icon} s={12} />}
      {label}
      {icon === "arrow-right" ? <Ic n={icon} s={12} /> : null}
    </motion.button>
  );
}

function ProductReviewCard({ index, total, draft, intent, status, issues, onChange }: {
  index: number; total: number; draft: MultiProductDraft; intent: ProductIntentMap | undefined; status: ReviewStatus;
  issues: { level: "error" | "warning" | "info"; message: string }[];
  onChange: (patch: Partial<MultiProductDraft>) => void;
}) {
  const meta = STATUS_META[status];
  const categories = optionsWithCurrent(CATEGORY_MAP[draft.family] ?? [], draft.category);
  const codeIsManual = intent?.productCode.provenance === "explicit" || draft.productCode !== autoCode(draft.productName);
  const mappingRows = buildProductMappingRows(draft, intent ?? null, codeIsManual);

  return (
    <div className="rounded-2xl p-5" style={{ background: "var(--rc-card-bg)", border: "1px solid var(--rc-panel-border)" }}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <span className="text-[13px] font-bold" style={{ color: "var(--rc-text-section)" }}>
          Product {index + 1} of {total}
        </span>
        <span className="flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-full" style={{ background: `${meta.color}18`, border: `1px solid ${meta.color}40`, color: meta.color }}>
          <Ic n={meta.icon} s={11} />
          {meta.label}
        </span>
      </div>

      {issues.length > 0 && (
        <div className="flex flex-col gap-1.5 mb-4">
          {issues.map((iss, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px]" style={{ color: iss.level === "error" ? "#FF4066" : iss.level === "warning" ? "#F59E0B" : "var(--rc-text-muted)" }}>
              <span className="mt-0.5 shrink-0"><Ic n={iss.level === "info" ? "info" : "alert"} s={11} /></span>
              {iss.message}
            </div>
          ))}
        </div>
      )}

      <div className="mb-4">
        <FieldWrap label="Product Name *">
          <FInput large value={draft.productName} onChange={v => onChange({ productName: v })} placeholder="Enter product name…" />
        </FieldWrap>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        <FieldWrap label="Product Code">
          <FInput value={draft.productCode} onChange={v => onChange({ productCode: v })} placeholder="AUTO_GENERATED" mono />
        </FieldWrap>
        <FieldWrap label="Product Family *">
          <FSelect value={draft.family} onChange={v => onChange({ family: v })} options={["", ...optionsWithCurrent(FAMILIES, draft.family)]} />
        </FieldWrap>
        <FieldWrap label="Product Category">
          <FSelect value={draft.category} onChange={v => onChange({ category: v })} options={["", ...categories]} />
        </FieldWrap>
        <FieldWrap label="Product Catalog">
          <FInput value={draft.catalog} onChange={v => onChange({ catalog: v })} placeholder="e.g. Electronics Catalog" />
        </FieldWrap>
        <FieldWrap label="Selling Model">
          <FSelect value={draft.sellingModel} onChange={v => onChange({ sellingModel: v })} options={optionsWithCurrent(SELLING_MODELS, draft.sellingModel)} />
        </FieldWrap>
        <FieldWrap label="Unit of Measure">
          <FSelect value={draft.unitOfMeasure} onChange={v => onChange({ unitOfMeasure: v })} options={UNIT_OF_MEASURES} />
        </FieldWrap>
        <FieldWrap label="Product Type (as stated)">
          <FInput value={draft.productTypeRaw} onChange={v => onChange({ productTypeRaw: v })} placeholder="e.g. Physical" />
        </FieldWrap>
        <FieldWrap label="Is Active">
          <div className="flex gap-2 pt-0.5">
            {["Yes", "No"].map(v => (
              <button key={v}
                onClick={() => onChange({ isActive: v === "Yes" })}
                className="flex-1 py-2 rounded-lg text-[11px] font-medium cursor-pointer"
                style={{
                  background: (draft.isActive ? "Yes" : "No") === v ? "rgba(30,144,255,0.14)" : "var(--rc-field-bg)",
                  border: `1px solid ${(draft.isActive ? "Yes" : "No") === v ? "rgba(30,144,255,0.35)" : "var(--rc-field-border)"}`,
                  color: (draft.isActive ? "Yes" : "No") === v ? "#1E90FF" : "var(--rc-text-muted)",
                }}>{v}</button>
            ))}
          </div>
        </FieldWrap>
        <FieldWrap label="Tax Included">
          <div className="flex gap-2 pt-0.5">
            {([["Yes", true], ["No", false], ["N/A", null]] as const).map(([label, v]) => (
              <button key={label}
                onClick={() => onChange({ taxIncluded: v })}
                className="flex-1 py-2 rounded-lg text-[10.5px] font-medium cursor-pointer"
                style={{
                  background: draft.taxIncluded === v ? "rgba(30,144,255,0.14)" : "var(--rc-field-bg)",
                  border: `1px solid ${draft.taxIncluded === v ? "rgba(30,144,255,0.35)" : "var(--rc-field-border)"}`,
                  color: draft.taxIncluded === v ? "#1E90FF" : "var(--rc-text-muted)",
                }}>{label}</button>
            ))}
          </div>
        </FieldWrap>
      </div>

      <div className="mb-4">
        <FieldWrap label="Description" span2>
          <FTextarea value={draft.description} onChange={v => onChange({ description: v })} placeholder="Enter product description…" rows={2} />
        </FieldWrap>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <FieldWrap label="Price Book">
          <FInput value={draft.priceBook} onChange={v => onChange({ priceBook: v })} placeholder="Standard Price Book" />
        </FieldWrap>
        <FieldWrap label="Base Price (USD)">
          <FInput value={draft.basePrice} onChange={v => onChange({ basePrice: v })} placeholder="0.00" type="number" />
        </FieldWrap>
        <FieldWrap label="Currency">
          <FInput value={draft.currencyIsoCode} onChange={v => onChange({ currencyIsoCode: v })} placeholder="USD" />
        </FieldWrap>
        <FieldWrap label="Product Owner">
          <FInput value={draft.productOwner} onChange={v => onChange({ productOwner: v })} placeholder="e.g. jane.doe@company.com" />
        </FieldWrap>
      </div>

      <div className="mt-5">
        <p className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--rc-text-section)" }}>
          Field Mapping
        </p>
        <FieldMappingTable rows={mappingRows} />
      </div>
    </div>
  );
}

function SummaryCard({ drafts, rows, onEdit }: {
  drafts: MultiProductDraft[]; rows: ImportRowResult[]; onEdit: (index: number) => void;
}) {
  const readyCount = drafts.filter((d, i) => {
    const s = reviewStatus(i, d, rows);
    return s !== "error" && s !== "duplicate";
  }).length;
  return (
    <div className="rounded-2xl p-5" style={{ background: "var(--rc-card-bg)", border: "1px solid var(--rc-panel-border)" }}>
      <div className="flex items-center gap-2 mb-4">
        <div style={{ color: "#1E90FF" }}><Ic n="check-square" s={16} /></div>
        <span className="text-[14px] font-bold" style={{ color: "var(--rc-text-section)" }}>All Products Ready</span>
      </div>
      <p className="text-[11.5px] mb-4" style={{ color: "var(--rc-text-muted)" }}>
        {readyCount} of {drafts.length} product{drafts.length === 1 ? "" : "s"} will be created in Salesforce when you click Deploy. Products marked &quot;Needs attention&quot; or &quot;Duplicate&quot; will be skipped — go back and fix or rename them, or deploy the rest now.
      </p>
      <div className="flex flex-col gap-2">
        {drafts.map((d, i) => {
          const status = reviewStatus(i, d, rows);
          const meta = STATUS_META[status];
          return (
            <button key={i} onClick={() => onEdit(i)}
              className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-left cursor-pointer"
              style={{ background: "var(--rc-field-bg)", border: "1px solid var(--rc-field-border)" }}>
              <span style={{ color: meta.color }}><Ic n={meta.icon} s={15} /></span>
              <span className="text-[12.5px] font-semibold flex-1 truncate" style={{ color: "var(--rc-text-primary)" }}>
                {i + 1}. {d.productName || <em>Unnamed product</em>}
              </span>
              <span className="text-[10px]" style={{ color: "var(--rc-text-muted)" }}>{d.family || "—"}{d.category ? ` · ${d.category}` : ""}</span>
              <span className="text-[10px] font-semibold" style={{ color: meta.color }}>{meta.label}</span>
              <Ic n="edit" s={12} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
