"use client";

import { useEffect, useRef, useState } from "react";
import { Ic, tokens, PageShell, FooterBar, PrimaryButton, GhostButton, Spinner, Section } from "./shared";
import ProcedureForm from "./ProcedureForm";
import AutoCreatePanel from "./AutoCreatePanel";
import AIPricingAssistant, { type AIExtractedSummary } from "./AIPricingAssistant";
import AttrWarningModal, { type AttrWarningModalState } from "./AttrWarningModal";
import { type AiMatchSummary, type AiMatchDiagnostic } from "./AiAttributeMatchSummary";
import CreateProcedureFailurePanel from "./CreateProcedureFailurePanel";
import DeploymentProgressPanel, { computeDeploymentSteps, type LiveSteps } from "./DeploymentProgressPanel";
import AttributePreviewPanel from "./AttributePreviewPanel";
import DebugLogPanel from "./DebugLogPanel";
import { streamCreateProcedure } from "@/lib/pricing-rules/ui/streamCreateProcedure";
import { salesforceRecordUrl } from "@/lib/salesforce/client/recordLink";
import { loadSession } from "@/lib/auth/session";
import { toCreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import {
  emptyProcedureForm,
  PRICING_TYPE_LABELS,
  IMPLEMENTED_PRICING_TYPES,
  type ProcedureFormData,
  type PricingType,
  type AttributePricingEntry,
  type ProductAttributeData,
  type AIAttributeEntry,
  type AIConfidence,
  type SalesforceCreationResult,
  type CreateProcedureFailure,
  type AttrNativeResult,
  type AttributePreviewEntry,
  type VerifyExecutionResult,
  type DebugLogEntry,
} from "@/lib/pricing-rules/types";

const PRICING_TYPE_ICONS: Record<PricingType, string> = {
  "tier-based": "layers",
  "volume-based": "package",
  "attribute-based": "sliders",
  "bundle-based": "cube",
};

function generateId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `id_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Lowercased, alphanumeric-only comparison key — an AI-extracted attribute name/value is free text
 * ("13-inch", "Storage") and rarely matches Salesforce's raw field/picklist value character-for-character
 * even when it clearly means the same thing as the label ("13 Inch", "Storage_Capacity__c"/"Storage").
 * Stripping spaces/hyphens/punctuation and case is enough to bridge that without a fuzzy-matching library. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Mirrors the server's evaluateAttributePricingRow validity rule (lib/pricing-rules/salesforce/nativeAttributeRecords.ts) — a matched row only counts as "priced" once it has a real Adjustment Type and a meaningful Adjustment Amount. */
function isValidAdjustment(pricingType: string, adjustmentValue: number): boolean {
  if (!pricingType || !Number.isFinite(adjustmentValue)) return false;
  return /override/i.test(pricingType) ? adjustmentValue >= 0 : adjustmentValue > 0;
}

async function postJson<T>(url: string, body: unknown, timeoutMs = 60_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json?.error ?? `Request failed (HTTP ${res.status})`) as Error & { status?: number; payload?: unknown };
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

interface ProductAttributesResponse extends ProductAttributeData {
  error?: string;
  authError?: boolean;
}

export default function CreatePricingRuleFlow({
  isDark,
  onDone,
  lockedPricingType,
  onBack,
}: {
  isDark: boolean;
  onDone?: () => void;
  /** When set, the type-selector step is skipped entirely and the form starts pre-locked to this type — used by the dedicated /pricing-rules/create/[type] routes. */
  lockedPricingType?: PricingType;
  /** Where the form step's "Back" button goes when `lockedPricingType` is set (there's no select-type step to fall back to). */
  onBack?: () => void;
}) {
  const t = tokens(isDark);
  const notifySalesforceSuccess = useSalesforceSuccess();

  const [step, setStep] = useState<"select-type" | "form" | "success">(lockedPricingType ? "form" : "select-type");
  const [form, setForm] = useState<ProcedureFormData>(() =>
    lockedPricingType ? { ...emptyProcedureForm(), pricingType: lockedPricingType } : emptyProcedureForm(),
  );
  const [errors, setErrors] = useState<Partial<Record<keyof ProcedureFormData, string>>>({});

  const [productAttributeData, setProductAttributeData] = useState<ProductAttributeData | null>(null);
  const [isFetchingAttributes, setIsFetchingAttributes] = useState(false);
  const [attributeError, setAttributeError] = useState<string | null>(null);
  const [attrWarningModal, setAttrWarningModal] = useState<AttrWarningModalState | null>(null);

  const [aiPrompt, setAiPrompt] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiConfidence, setAiConfidence] = useState<AIConfidence | null>(null);
  const [aiSummary, setAiSummary] = useState<AIExtractedSummary | null>(null);
  const [aiValidationMessages, setAiValidationMessages] = useState<string[]>([]);
  const [aiMatchSummary, setAiMatchSummary] = useState<AiMatchSummary | null>(null);
  const [aiMatchDiagnostics, setAiMatchDiagnostics] = useState<AiMatchDiagnostic[]>([]);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createFailure, setCreateFailure] = useState<CreateProcedureFailure | null>(null);
  const [createResult, setCreateResult] = useState<SalesforceCreationResult | null>(null);
  /** Populated from a FAILED create-procedure response too (not just success) — the failure panel needs `attrNative.recordCountPreview`/`firstFailure` even though `createResult` itself stays null on failure. */
  const [createAttrNative, setCreateAttrNative] = useState<AttrNativeResult | null>(null);
  // §Sequential Workflow — live per-checklist-row state streamed from create-procedure as it actually
  // runs (see streamCreateProcedure.ts/DeploymentProgressPanel.tsx's LiveSteps) — reset at the start of
  // every Create Procedure attempt.
  const [liveSteps, setLiveSteps] = useState<LiveSteps>({});
  // §B — the complete Attribute JSON Preview, streamed live before any native record create begins.
  const [attributePreview, setAttributePreview] = useState<{
    product2Id: string; sellingModelId: string; priceAdjustmentScheduleId: string | null; attributes: AttributePreviewEntry[];
  } | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyExecutionResult | null>(null);
  // §Sequential Workflow — Runtime Verification (Step 12) now runs server-side as part of the same
  // create-procedure request/response (no separate async follow-up call), so there's no longer a
  // distinct "verifying" gap to show a spinner for. Kept as a stable `false` so
  // computeDeploymentSteps's existing verify-status logic (which already handles a null verifyResult
  // correctly for the "nothing to simulate" case) needs no changes.
  const verifying = false;

  // Development-only: when on, every product-attributes/create-procedure/verify-execution call asks
  // the server to include its raw SOQL/REST/Metadata/record/retry trace (§Debug Mode).
  const [debugMode, setDebugMode] = useState(false);
  const [debugEntries, setDebugEntries] = useState<DebugLogEntry[]>([]);
  // §Auto-Fix Price Impacting — opt-in, off by default (see ProcedurePayload.autoFixPriceImpacting):
  // flipping this flag can affect every OTHER product/procedure sharing the same attribute/PAD record.
  const [autoFixPriceImpacting, setAutoFixPriceImpacting] = useState(false);
  function appendDebugEntries(entries?: DebugLogEntry[]) {
    if (!entries || entries.length === 0) return;
    setDebugEntries(prev => [...prev, ...entries]);
  }

  const productNameDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (productNameDebounceRef.current) clearTimeout(productNameDebounceRef.current); }, []);

  function updateForm(field: keyof ProcedureFormData, value: string) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  function selectPricingType(pricingType: PricingType) {
    setForm(prev => ({
      ...emptyProcedureForm(),
      procedureName: prev.procedureName,
      productName: prev.productName,
      pricingType,
    }));
    setProductAttributeData(null);
    setAttributeError(null);
    setErrors({});
    setStep("form");
  }

  /**
   * §7 applyAiEntriesToRows — matches AI-extracted attribute pricing onto the
   * Salesforce-discovered rows. A prior version compared `attributeName`/
   * `attributeValue` character-for-character (case-insensitive only), which
   * almost never matched real AI output against real Salesforce field names/
   * picklist values ("13-inch" vs. "13 Inch", a human label vs. a raw API
   * name) — silently leaving every discovered row unpriced and producing
   * zero native records downstream despite attribute discovery having
   * succeeded. Both the attribute NAME and VALUE are now matched against
   * either the raw Salesforce field/value or its human label, normalized
   * (§normalizeForMatch), and every match attempt — success or failure — is
   * captured as a diagnostic so "why didn't this get priced" is visible in
   * the UI instead of just silently vanishing.
   */
  function applyAiEntriesToRows(sfRows: AttributePricingEntry[], aiEntries: AIAttributeEntry[]) {
    const rows = sfRows.map(r => ({ ...r }));
    const diagnostics: AiMatchDiagnostic[] = [];
    const matchedRowIds = new Set<string>();
    const pricedRowIds = new Set<string>();

    for (const entry of aiEntries) {
      const entryAttrKey = normalizeForMatch(entry.attributeName);
      const attrRows = rows.filter(r => normalizeForMatch(r.attributeName) === entryAttrKey || normalizeForMatch(r.attributeLabel) === entryAttrKey);

      if (attrRows.length === 0) {
        diagnostics.push({
          attributeName: entry.attributeName, aiValue: entry.attributeValue, status: "unmatched-attribute",
          reason: `No Salesforce attribute named "${entry.attributeName}" was discovered on this product.`,
        });
        continue;
      }

      const entryValueKey = normalizeForMatch(entry.attributeValue);
      const match = attrRows.find(r => normalizeForMatch(r.attributeValue) === entryValueKey || normalizeForMatch(r.attributeValueLabel) === entryValueKey);

      if (!match) {
        diagnostics.push({
          attributeName: entry.attributeName, aiValue: entry.attributeValue, status: "unmatched-value",
          candidateValues: attrRows.map(r => r.attributeValueLabel || r.attributeValue),
          reason: "No corresponding Salesforce picklist value exists.",
        });
        continue;
      }

      matchedRowIds.add(match.id);
      if (isValidAdjustment(entry.adjustmentType, entry.adjustmentValue)) {
        match.pricingType = entry.adjustmentType;
        match.adjustmentValue = String(entry.adjustmentValue);
        pricedRowIds.add(match.id);
        diagnostics.push({
          attributeName: entry.attributeName, aiValue: entry.attributeValue, status: "priced",
          matchedValueLabel: match.attributeValueLabel || match.attributeValue,
        });
      } else {
        diagnostics.push({
          attributeName: entry.attributeName, aiValue: entry.attributeValue, status: "skipped",
          matchedValueLabel: match.attributeValueLabel || match.attributeValue,
          reason: `The AI extraction had no usable Adjustment Type/Amount for this value (type: "${entry.adjustmentType || "none"}", amount: ${entry.adjustmentValue}).`,
        });
      }
    }

    const summary: AiMatchSummary = {
      discovered: rows.length,
      matched: matchedRowIds.size,
      priced: pricedRowIds.size,
      skipped: matchedRowIds.size - pricedRowIds.size,
      unmatched: diagnostics.filter(d => d.status === "unmatched-attribute" || d.status === "unmatched-value").length,
    };

    const invalidAttributes = diagnostics.filter(d => d.status === "unmatched-attribute").map(d => d.attributeName);
    const invalidValues = diagnostics.filter(d => d.status === "unmatched-value").map(d => ({ attributeName: d.attributeName, attributeValue: d.aiValue }));
    if (invalidAttributes.length > 0 || invalidValues.length > 0) {
      setAttrWarningModal({ show: true, invalidAttributes, invalidValues, appliedCount: summary.priced });
    }

    return { rows, summary, diagnostics };
  }

  /* ── §7 handleFetchAttributes ── */
  async function handleFetchAttributes(productNameOverride?: string, aiEntriesToApply?: AIAttributeEntry[], productIdHint?: string) {
    const nameToUse = (productNameOverride ?? form.productName).trim();
    if (!nameToUse) return;

    setIsFetchingAttributes(true);
    setAttributeError(null);
    try {
      // productIdHint (set when the user picked an exact record from the ProductLookup dropdown) always
      // wins over name-based resolution server-side — Product2.Name isn't guaranteed unique, so without
      // this a duplicate-named product could silently resolve to the wrong record.
      const data = await postJson<ProductAttributesResponse>("/api/pricing-rules/product-attributes", { productName: nameToUse, productId: productIdHint, debug: debugMode });
      appendDebugEntries(data.debugLog);

      const piAttrs = data.attributes.filter(a => a.isPriceImpacting === true);
      let sfEntries: AttributePricingEntry[] = [];
      for (const attr of piAttrs) {
        for (const val of attr.values ?? []) {
          sfEntries.push({
            id: generateId(),
            attributeName: attr.name,
            attributeLabel: attr.label || attr.name,
            attributeValue: val.value,
            attributeValueLabel: val.label,
            pricingType: "",
            adjustmentValue: "",
          });
        }
      }
      if (aiEntriesToApply && aiEntriesToApply.length > 0) {
        const applied = applyAiEntriesToRows(sfEntries, aiEntriesToApply);
        sfEntries = applied.rows;
        setAiMatchSummary(applied.summary);
        setAiMatchDiagnostics(applied.diagnostics);
      } else {
        setAiMatchSummary(null);
        setAiMatchDiagnostics([]);
      }

      setProductAttributeData(data);
      setForm(prev => ({
        ...prev,
        productId: data.product.id,
        productCode: data.product.productCode,
        productStatus: data.product.status,
        currency: data.product.currency,
        sellingModel: data.product.sellingModelName,
        sellingModelId: data.product.sellingModelId,
        effectiveFrom: data.product.effectiveFrom,
        effectiveTo: data.product.effectiveTo,
        basePrice: data.product.basePrice != null ? String(data.product.basePrice) : "",
        attributeEntries: sfEntries,
      }));
    } catch (err) {
      const e = err as Error & { status?: number; payload?: { authError?: boolean } };
      if (e.status === 401 || e.payload?.authError) {
        setAttributeError("Your Salesforce session has expired. Please reconnect and try again.");
      } else {
        setAttributeError(e.message || "Failed to discover product attributes.");
      }
    } finally {
      setIsFetchingAttributes(false);
    }
  }

  /** Wipes every Salesforce-sourced field back to empty — used the instant the Product Name no longer matches whatever was last discovered, so stale data never lingers on screen while a new fetch is pending. */
  function clearDiscoveredProductState() {
    setProductAttributeData(null);
    setAttributeError(null);
    setAiMatchSummary(null);
    setAiMatchDiagnostics([]);
    setForm(prev => ({
      ...prev,
      productId: "", productCode: "", productStatus: "", currency: "",
      sellingModel: "", sellingModelId: "", effectiveFrom: "", effectiveTo: "",
      basePrice: "", attributeEntries: [],
    }));
  }

  /**
   * §4 auto-refresh: fires on every Product Name keystroke (debounced) so
   * the user never has to click a button — clears stale product info
   * immediately, then re-fetches Product/Selling Model/Standard
   * Price/price-impacting Attributes once typing settles.
   */
  function handleProductNameChange(value: string) {
    setForm(prev => ({ ...prev, productName: value }));
    if (form.pricingType !== "attribute-based") return;

    if (productNameDebounceRef.current) {
      clearTimeout(productNameDebounceRef.current);
      productNameDebounceRef.current = null;
    }

    const trimmed = value.trim();
    const alreadyFetched = productAttributeData?.product?.name?.toLowerCase() === trimmed.toLowerCase();
    if (!alreadyFetched && productAttributeData) clearDiscoveredProductState();
    if (!trimmed || alreadyFetched) return;

    productNameDebounceRef.current = setTimeout(() => { void handleFetchAttributes(trimmed); }, 700);
  }

  function handleProductNameBlur(name: string) {
    if (form.pricingType !== "attribute-based" || !name.trim()) return;
    if (productNameDebounceRef.current) {
      clearTimeout(productNameDebounceRef.current);
      productNameDebounceRef.current = null;
    }
    const alreadyFetched = productAttributeData?.product?.name?.toLowerCase() === name.trim().toLowerCase();
    if (!alreadyFetched) void handleFetchAttributes(name.trim());
  }

  /** §1 — picking a product from the lookup dropdown fires discovery immediately, no debounce and no extra button click. */
  function handleProductSelect(match: { id: string; name: string }) {
    if (productNameDebounceRef.current) {
      clearTimeout(productNameDebounceRef.current);
      productNameDebounceRef.current = null;
    }
    setForm(prev => ({ ...prev, productName: match.name }));
    if (form.pricingType !== "attribute-based") return;
    void handleFetchAttributes(match.name, undefined, match.id);
  }

  function handleEntryChange(entryId: string, field: keyof AttributePricingEntry, value: string) {
    setForm(prev => ({
      ...prev,
      attributeEntries: prev.attributeEntries.map(e => (e.id !== entryId ? e : { ...e, [field]: value })),
    }));
  }

  /**
   * The AI Pricing Assistant is the primary entry point for Attribute-Based
   * Pricing: Generate ONLY populates the form (Procedure Details, then —
   * for attribute-based — triggers the same handleFetchAttributes()
   * cascade a manual Product Name blur would (Product, Selling Model,
   * Effective Dates, Status, Currency, price-impacting Attributes, all in
   * one discovery call), merging any AI-extracted attribute entries onto
   * the discovered Salesforce rows. It never calls create-procedure —
   * that only happens when the user clicks "Create Procedure" below.
   */
  async function handleAiGenerate() {
    if (!aiPrompt.trim()) return;
    setAiGenerating(true);
    setAiError(null);
    setAiSummary(null);
    setAiConfidence(null);
    setAiValidationMessages([]);
    try {
      const data = await postJson<{
        success: boolean;
        result: { procedureName: string; productName: string; pricingType: PricingType | ""; description?: string; basePrice?: string; attributeEntries?: AIAttributeEntry[] };
        confidence: AIConfidence;
        error?: string;
      }>(
        "/api/pricing-rules/ai/generate-pricing",
        { prompt: aiPrompt, pricingType: lockedPricingType ?? (form.pricingType || undefined) },
      );
      if (!data.success || !data.result) throw new Error(data.error || "AI generation failed.");
      const result = data.result;
      // The page's locked type (if any) always wins over whatever the AI guessed.
      const resolvedPricingType = lockedPricingType ?? (result.pricingType || form.pricingType);

      setForm(prev => ({
        ...prev,
        procedureName: result.procedureName || prev.procedureName,
        productName: result.productName || prev.productName,
        description: result.description ?? prev.description,
        basePrice: result.basePrice || prev.basePrice,
        pricingType: resolvedPricingType || prev.pricingType,
      }));

      setAiConfidence(data.confidence ?? null);
      setAiSummary({
        procedureName: result.procedureName,
        productName: result.productName,
        pricingType: resolvedPricingType,
        description: result.description,
        basePrice: result.basePrice,
        attributeEntryCount: result.attributeEntries?.length ?? 0,
      });

      const messages: string[] = [];
      if (!result.procedureName) messages.push("Procedure Name was not detected — enter one manually.");
      if (!result.productName) messages.push("Product Name was not detected — attribute discovery can't run without it.");
      if (!resolvedPricingType) messages.push("Pricing type could not be determined — select one manually.");
      if (resolvedPricingType === "attribute-based") {
        // Base Price is always auto-fetched from the Standard Price Book once the product resolves
        // (§2) — never flagged here based on whether the AI happened to extract one from the prompt.
        if (!result.attributeEntries || result.attributeEntries.length === 0) {
          messages.push("No attribute pricing entries were extracted — add them manually once attributes are discovered below.");
        }
      }
      setAiValidationMessages(messages);

      if (resolvedPricingType && step === "select-type") setStep("form");

      if (resolvedPricingType === "attribute-based" && result.productName) {
        void handleFetchAttributes(result.productName, result.attributeEntries);
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "AI generation failed.");
    } finally {
      setAiGenerating(false);
    }
  }

  /** Clears only the AI prompt/result panel — never touches already-populated form fields, which stay user-editable. */
  function handleAiClear() {
    setAiPrompt("");
    setAiError(null);
    setAiConfidence(null);
    setAiSummary(null);
    setAiValidationMessages([]);
  }

  /* ── §7 validate ── */
  function validate(): boolean {
    const next: Partial<Record<keyof ProcedureFormData, string>> = {};
    if (!form.procedureName.trim()) next.procedureName = "Procedure name is required";
    if (!form.productName.trim()) next.productName = "Product name is required";

    if (form.pricingType === "attribute-based") {
      if (!form.productId?.trim()) next.productId = "Product must be found in Salesforce";
      if (!form.sellingModelId?.trim()) next.sellingModelId = "Product Selling Model is required";
      if (!form.effectiveFrom?.trim()) next.effectiveFrom = "Effective From date is required";
      // Base Price is auto-fetched from the Standard Price Book and read-only — a missing entry is a
      // warning shown in the Base Price section, never a submission blocker (§3).
      // §Row validation — mirrors the server's evaluateAttributePricingRow: a row only counts once it
      // has a real Adjustment Type AND a meaningful Adjustment Amount (>0, or >=0 for Override Price —
      // a plain non-empty string like "0" used to pass this check and reach the server as a no-op row).
      const hasValidPricingRow = form.attributeEntries.some(e => {
        if (!e.pricingType) return false;
        const amount = Number(e.adjustmentValue);
        if (!Number.isFinite(amount)) return false;
        return /override/i.test(e.pricingType) ? amount >= 0 : amount > 0;
      });
      if (!hasValidPricingRow) {
        next.attributeEntries = "No valid attribute pricing rules have been configured. Configure at least one priced attribute value before creating the pricing procedure.";
      }
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  /* ── §7 handleCreate ── */
  async function handleCreate() {
    if (!validate()) return;

    if (form.pricingType === "attribute-based") {
      if (!form.productId?.trim()) { setCreateError("Product not found in Salesforce."); return; }
      if (!form.sellingModelId?.trim()) { setCreateError("This product has no Selling Model configured."); return; }
      if ((productAttributeData?.attributes?.length ?? 0) === 0) { setCreateError("No attributes were discovered for this product."); return; }
    }

    setCreating(true);
    setCreateError(null);
    setCreateFailure(null);
    setCreateAttrNative(null);
    setLiveSteps({});
    setAttributePreview(null);
    try {
      const payload = {
        procedureName: form.procedureName,
        apiName: form.apiName,
        description: form.description,
        productName: form.productName,
        pricingType: form.pricingType,
        productId: form.productId,
        productCode: form.productCode,
        productStatus: form.productStatus,
        currency: form.currency,
        sellingModel: form.sellingModel,
        sellingModelId: form.sellingModelId,
        effectiveFrom: form.effectiveFrom,
        effectiveTo: form.effectiveTo,
        procedureStatus: form.procedureStatus,
        basePrice: form.basePrice,
        ...(form.attributeEntries.length > 0 ? { attributeEntries: form.attributeEntries } : {}),
        autoFixPriceImpacting,
        // §REQUEST_LIMIT_EXCEEDED remediation — productAttributeData was
        // already fetched (POST /api/pricing-rules/product-attributes) to
        // populate this form's attribute pickers; reuse it instead of making
        // create-procedure's own Attribute Discovery step repeat that same
        // ~15-30-call pipeline for the same product. The backend re-verifies
        // the product Id matches before trusting it.
        ...(productAttributeData ? { discoveredAttributes: productAttributeData } : {}),
      };
      // §Sequential Workflow — streams one live event per checklist row as the backend actually reaches
      // it (see streamCreateProcedure.ts), then resolves with the same SalesforceCreationResult shape
      // this used to return as a single JSON response. A pipeline failure no longer throws (the endpoint
      // always answers HTTP 200 once the pipeline starts) — `result.success` is now the source of truth;
      // streamCreateProcedure still throws for the fast, pre-pipeline rejections (bad request, zero valid
      // rows, unimplemented pricing type), handled in the catch block exactly as before.
      const result = await streamCreateProcedure(
        { payload, debug: debugMode },
        evt => {
          if (evt.type === "attributePreview") {
            setAttributePreview({ product2Id: evt.product2Id, sellingModelId: evt.sellingModelId, priceAdjustmentScheduleId: evt.priceAdjustmentScheduleId, attributes: evt.attributes });
            return;
          }
          setLiveSteps(prev => ({ ...prev, [evt.step]: { status: evt.status, detail: evt.detail } }));
        },
      );
      setCreateAttrNative(result.attrNative ?? null);
      setVerifyResult(result.verifyResult ?? null);
      appendDebugEntries(result.debugLog);
      if (result.success) {
        setCreateResult(result);
        setStep("success");

        const instanceUrl = loadSession()?.instanceUrl;
        if (instanceUrl && result.procedureId) {
          const record = toCreatedSalesforceRecord(instanceUrl, "ExpressionSet", result.procedureId, result.apiName ?? result.procedureId);
          notifySalesforceSuccess({
            title: "Pricing Procedure Created Successfully",
            message: `${record.recordName} has been successfully created in Salesforce.`,
            records: [record],
          });
        }
      } else {
        setCreateFailure(result.failure ?? null);
        setCreateError(result.error || "Failed to create pricing procedure.");
      }
    } catch (err) {
      const e = err as Error & { payload?: SalesforceCreationResult };
      if (e.payload?.validationError) {
        // §Failure Handling — a local "no valid pricing rows" check, not a deployment failure: surface
        // it the same way as every other field-level validation error, never via the failure panel.
        setErrors(prev => ({ ...prev, attributeEntries: e.payload?.error || "No valid attribute pricing rules have been configured. Configure at least one priced attribute value before creating the pricing procedure." }));
        return;
      }
      setCreateFailure(e.payload?.failure ?? null);
      setCreateAttrNative(e.payload?.attrNative ?? null);
      // A failure at Step 12 (Runtime Verification) still carries a verifyResult — every earlier step
      // (including Deploy/Activate) already succeeded, so it's shown exactly as it would be on success.
      setVerifyResult(e.payload?.verifyResult ?? null);
      setCreateError(e.payload?.error || e.message || "Failed to create pricing procedure.");
      appendDebugEntries(e.payload?.debugLog);
    } finally {
      setCreating(false);
    }
  }

  function handleReset() {
    setForm(lockedPricingType ? { ...emptyProcedureForm(), pricingType: lockedPricingType } : emptyProcedureForm());
    setDebugEntries([]);
    setErrors({});
    setProductAttributeData(null);
    setAttributeError(null);
    setAttrWarningModal(null);
    setAiMatchSummary(null);
    setAiMatchDiagnostics([]);
    setCreateResult(null);
    setCreateError(null);
    setCreateFailure(null);
    setCreateAttrNative(null);
    setLiveSteps({});
    setAttributePreview(null);
    setVerifyResult(null);
    setStep(lockedPricingType ? "form" : "select-type");
  }

  /* ── Render ── */
  if (step === "select-type") {
    return (
      <PageShell>
        <div style={{ padding: "28px clamp(16px, 4vw, 56px)", maxWidth: 1560, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: t.heading }}>Create Pricing Rule</div>
            <div style={{ fontSize: 12.5, color: t.dim, marginTop: 4 }}>Choose a pricing type to get started, or let Autopilot run the entire workflow from one prompt.</div>
          </div>

          <AutoCreatePanel isDark={isDark} />

          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0" }}>
            <div style={{ flex: 1, height: 1, background: t.border }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4 }}>Or build it guided, with a review step</span>
            <div style={{ flex: 1, height: 1, background: t.border }} />
          </div>

          <AIPricingAssistant
            isDark={isDark}
            prompt={aiPrompt}
            onPromptChange={setAiPrompt}
            generating={aiGenerating}
            error={aiError}
            confidence={aiConfidence}
            summary={aiSummary}
            validationMessages={aiValidationMessages}
            matchSummary={aiMatchSummary}
            matchDiagnostics={aiMatchDiagnostics}
            onGenerate={handleAiGenerate}
            onClear={handleAiClear}
          />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            {(Object.keys(PRICING_TYPE_LABELS) as PricingType[]).map(pt => {
              const implemented = IMPLEMENTED_PRICING_TYPES.includes(pt);
              return (
                <button
                  key={pt}
                  onClick={() => selectPricingType(pt)}
                  style={{
                    textAlign: "left", padding: 16, borderRadius: 14, cursor: "pointer",
                    background: t.surface, border: `1px solid ${t.border}`, color: t.heading,
                    display: "flex", flexDirection: "column", gap: 8, position: "relative",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: t.accent }}>
                    <Ic n={PRICING_TYPE_ICONS[pt]} s={18} />
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{PRICING_TYPE_LABELS[pt]}</span>
                  </div>
                  <span style={{ fontSize: 11.5, color: t.dim }}>
                    {implemented ? "Deploys a real Salesforce Expression Set." : "Coming soon — form only, not yet deployable."}
                  </span>
                  {!implemented && (
                    <span style={{ position: "absolute", top: 12, right: 12, fontSize: 10, fontWeight: 700, color: t.warn, background: isDark ? "rgba(245,158,11,0.12)" : "rgba(245,158,11,0.1)", border: `1px solid ${t.warn}50`, borderRadius: 999, padding: "2px 8px" }}>
                      Coming Soon
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </PageShell>
    );
  }

  if (step === "success" && createResult) {
    return (
      <PageShell footer={<FooterBar isDark={isDark}><GhostButton label="Create Another" icon="plus" isDark={isDark} onClick={handleReset} /><PrimaryButton label="Done" isDark={isDark} onClick={() => onDone?.()} /></FooterBar>}>
        <div style={{ padding: "28px clamp(16px, 4vw, 56px)", display: "flex", flexDirection: "column", gap: 14, maxWidth: 960, margin: "0 auto", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#22C55E", fontSize: 16, fontWeight: 700 }}>
              <Ic n="check-circle" s={20} /> Pricing procedure deployed
            </div>
            {createResult.procedureId && salesforceRecordUrl(createResult.procedureId) && (
              <a
                href={salesforceRecordUrl(createResult.procedureId)!}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, border: `1px solid ${t.border}`, color: t.body, fontSize: 12.5, fontWeight: 600, textDecoration: "none" }}
              >
                <Ic n="external-link" s={13} /> Open in Salesforce
              </a>
            )}
          </div>

          <Section title="Summary" icon="zap" isDark={isDark} defaultOpen>
            <div style={{ paddingTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, fontSize: 12 }}>
              <div><strong style={{ color: t.heading }}>Procedure Name:</strong> <span style={{ color: t.body }}>{form.procedureName}</span></div>
              <div><strong style={{ color: t.heading }}>Expression Set Id:</strong> <span style={{ color: t.body }}>{createResult.procedureId ?? "—"}</span></div>
              <div><strong style={{ color: t.heading }}>Expression Set Version Id:</strong> <span style={{ color: t.body }}>{createResult.versionId ?? "—"}</span></div>
              <div><strong style={{ color: t.heading }}>Status:</strong> <span style={{ color: t.body }}>{createResult.versionStatus ?? "Draft"}</span></div>
              <div><strong style={{ color: t.heading }}>Price Adjustment Schedule Id:</strong> <span style={{ color: t.body }}>{createResult.attrNative?.scheduleId ?? "—"}</span></div>
            </div>
          </Section>

          {createResult.canvasSteps && createResult.canvasSteps.length > 0 && (
            <Section title="Deployed Canvas" icon="layers" isDark={isDark} defaultOpen>
              <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {createResult.canvasSteps.map(s => {
                    const stat = createResult.stepParameterCounts?.find(p => p.actionType === s.actionType);
                    return (
                      <div key={s.seq} style={{ fontSize: 12, color: t.body, display: "flex", gap: 8 }}>
                        <span style={{ color: t.dim }}>{s.seq}.</span> <strong style={{ color: t.heading }}>{s.actionType}</strong>
                        {stat && <span style={{ color: t.dim }}>— {stat.parameterCount} parameter(s)</span>}
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11.5, color: t.dim, borderTop: `1px solid ${t.border}`, paddingTop: 8 }}>
                  {createResult.canvasSteps.length} step(s) · {createResult.variableCount ?? 0} declared variable(s) on the donor template
                  {createResult.observedActionTypes && <> · Template action types: {createResult.observedActionTypes.join(", ")}</>}
                </div>
                {createResult.deployStatus && (
                  <div style={{ fontSize: 11.5, color: t.dim }}>
                    Deploy result: {createResult.deployStatus.status ?? "—"} · {createResult.deployStatus.numberComponentsDeployed} component(s) deployed, {createResult.deployStatus.numberComponentErrors} error(s)
                  </div>
                )}
              </div>
            </Section>
          )}

          {createResult.attrNative && (
            <Section title="Native Attribute Records" icon="table" isDark={isDark} defaultOpen>
              <div style={{ paddingTop: 10, fontSize: 12, color: t.body, display: "flex", flexDirection: "column", gap: 4 }}>
                <div>Rules created: {createResult.attrNative.rulesCreated} (skipped: {createResult.attrNative.rulesSkipped})</div>
                <div>Adjustments created: {createResult.attrNative.abasCreated} (skipped: {createResult.attrNative.abasSkipped})</div>
                <div>Conditions created: {createResult.attrNative.conditionsCreated}</div>
              </div>
            </Section>
          )}

          {createResult.warnings.length > 0 && (
            <Section title="Warnings" icon="alert" isDark={isDark} defaultOpen>
              <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                {createResult.warnings.map((w, i) => <div key={i} style={{ fontSize: 11.5, color: t.warn }}>{w}</div>)}
              </div>
            </Section>
          )}

          <Section title="Runtime Verification" icon="zap" isDark={isDark} defaultOpen>
            <div style={{ paddingTop: 10 }}>
              {verifying && <div className="flex items-center gap-2" style={{ color: t.dim, fontSize: 12.5 }}><Spinner isDark={isDark} /> Simulating the pricing engine…</div>}
              {!verifying && verifyResult && (
                <div style={{ fontSize: 12.5, color: verifyResult.success ? "#22C55E" : t.error, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontWeight: 700 }}>{verifyResult.success ? "Verified — pricing engine confirmed a discount." : "Verification found an issue."}</div>
                  <div style={{ color: t.body }}>
                    List Price: {verifyResult.executionReport.listPrice ?? "—"} → Adjusted: {verifyResult.executionReport.adjustment ? `${verifyResult.executionReport.adjustment.type ?? ""} ${verifyResult.executionReport.adjustment.value ?? ""}` : "—"} → Net Unit Price: {verifyResult.executionReport.netUnitPrice ?? "—"} → Subtotal: {verifyResult.executionReport.subtotal ?? "—"}
                  </div>
                  {verifyResult.executionReport.listPrice != null && verifyResult.executionReport.netUnitPrice != null && (
                    <div style={{ color: verifyResult.executionReport.netUnitPrice < verifyResult.executionReport.listPrice ? "#22C55E" : t.warn }}>
                      {verifyResult.executionReport.netUnitPrice < verifyResult.executionReport.listPrice
                        ? "Confirmed: the Attribute Discount node changed the price."
                        : "The Net Unit Price did not decrease from List Price — the Attribute Discount node may not be applying."}
                    </div>
                  )}
                  {verifyResult.executionReport.blocker && (
                    <div style={{ color: t.dim }}>{verifyResult.executionReport.blocker.reason} — {verifyResult.executionReport.blocker.resolutionHint}</div>
                  )}
                  {!!verifyResult.executionReport.pricingWaterfall && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: "pointer", color: t.dim, fontSize: 11.5 }}>Pricing Waterfall (raw)</summary>
                      <pre style={{ marginTop: 6, padding: 10, borderRadius: 8, background: t.surfaceAlt, fontSize: 10.5, color: t.body, overflow: "auto", maxHeight: 260, border: `1px solid ${t.border}` }}>
                        {JSON.stringify(verifyResult.executionReport.pricingWaterfall, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              )}
              {!verifying && !verifyResult && <div style={{ fontSize: 12, color: t.dim }}>No attribute pricing entries were submitted — nothing to simulate.</div>}
            </div>
          </Section>

          {debugMode && <DebugLogPanel isDark={isDark} entries={debugEntries} steps={createResult.steps} warnings={createResult.warnings} />}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      footer={
        <FooterBar isDark={isDark}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <GhostButton label="Back" icon="arrow-left" isDark={isDark} onClick={() => (lockedPricingType ? onBack?.() : setStep("select-type"))} />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.dim, cursor: "pointer" }} title="Development only — shows every SOQL query, REST endpoint, Metadata API call, and record Id created.">
              <input type="checkbox" checked={debugMode} onChange={e => setDebugMode(e.target.checked)} />
              Debug Mode
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.dim, cursor: "pointer" }} title="If an attribute isn't marked Price Impacting in Salesforce, automatically enable it (and verify the update) instead of stopping. Off by default — this can affect every other product/procedure sharing the same attribute.">
              <input type="checkbox" checked={autoFixPriceImpacting} onChange={e => setAutoFixPriceImpacting(e.target.checked)} />
              Auto-Fix Price Impacting
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {createError && (
              <span style={{ color: t.error, fontSize: 11.5 }}>
                {createFailure ? `Failed at "${createFailure.step}" — see details above.` : createError}
              </span>
            )}
            <PrimaryButton label={creating ? "Creating…" : "Create Procedure"} icon="check" isDark={isDark} disabled={creating} onClick={handleCreate} />
          </div>
        </FooterBar>
      }
    >
      <div style={{ padding: "28px clamp(16px, 4vw, 56px)", maxWidth: 1560, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: t.accent, display: "inline-flex" }}><Ic n={PRICING_TYPE_ICONS[form.pricingType as PricingType]} s={18} /></span>
          <span style={{ fontSize: 15, fontWeight: 700, color: t.heading }}>{PRICING_TYPE_LABELS[form.pricingType as PricingType]} Pricing</span>
        </div>

        {attributePreview && form.pricingType === "attribute-based" && (
          <AttributePreviewPanel
            isDark={isDark}
            product2Id={attributePreview.product2Id}
            sellingModelId={attributePreview.sellingModelId}
            priceAdjustmentScheduleId={attributePreview.priceAdjustmentScheduleId}
            attributes={attributePreview.attributes}
          />
        )}

        {(creating || createResult || createFailure) && form.pricingType === "attribute-based" && (
          <DeploymentProgressPanel
            isDark={isDark}
            items={computeDeploymentSteps({ form, attributeData: productAttributeData, creating, createResult, createFailure, verifying, verifyResult, liveSteps })}
          />
        )}

        {createError && <CreateProcedureFailurePanel isDark={isDark} failure={createFailure} fallbackMessage={!createFailure ? createError : null} attrNative={createAttrNative} />}

        <AIPricingAssistant
          isDark={isDark}
          prompt={aiPrompt}
          onPromptChange={setAiPrompt}
          generating={aiGenerating}
          error={aiError}
          confidence={aiConfidence}
          summary={aiSummary}
          validationMessages={aiValidationMessages}
          onGenerate={handleAiGenerate}
          onClear={handleAiClear}
        />

        <ProcedureForm
          isDark={isDark}
          form={form}
          errors={errors}
          onChange={updateForm}
          attributeData={productAttributeData}
          isFetchingAttributes={isFetchingAttributes}
          attributeError={attributeError}
          onProductNameChange={handleProductNameChange}
          onProductNameBlur={handleProductNameBlur}
          onSelectProduct={handleProductSelect}
          onFetchAttributes={() => handleFetchAttributes()}
          onEntryChange={handleEntryChange}
        />

        {debugMode && <DebugLogPanel isDark={isDark} entries={debugEntries} steps={createResult ? createResult.steps : []} warnings={createResult?.warnings ?? []} />}
      </div>
      {attrWarningModal && <AttrWarningModal isDark={isDark} state={attrWarningModal} onClose={() => setAttrWarningModal(null)} />}
    </PageShell>
  );
}
