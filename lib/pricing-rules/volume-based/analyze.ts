/**
 * Volume-Based Pricing — read-only analyze orchestrator. Mirrors
 * lib/pricing-rules/bundle-based/analyze.ts's stage-by-stage shape, simplified for volume-based's single
 * product (no bundle/component discovery needed): AI extraction -> product verification -> tier
 * validation -> preview. Never writes to Salesforce. Product resolution is reused verbatim from
 * lib/pricing-rules/attribute-based/productLookup.ts — Product2 lookup has no pricing-type-specific logic.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { resolveOrSuggestProduct, resolveProduct2ById } from "@/lib/pricing-rules/attribute-based/productLookup";
import { parseVolumeBasedPrompt } from "./parsePrompt";
import type { DiscoveredProduct, ExtractedVolumePricingRequirement, ProcedureStepLite, VolumeBasedAnalysisResult, VolumeTier } from "./types";

export interface VolumeAnalyzeInput {
  prompt?: string;
  extracted?: ExtractedVolumePricingRequirement;
  selectedProductId?: string;
  /** Tiers the user edited in the UI after extraction — takes priority over `extracted.volumeTiers`. */
  tierOverrides?: VolumeTier[];
  basePriceOverride?: number;
}

function push(steps: ProcedureStepLite[], step: string, status: ProcedureStepLite["status"], message: string): void {
  steps.push({ step, status, message, timestamp: Date.now() });
}

export async function analyzeVolumeBasedPrompt(
  client: SalesforceClient,
  apiKey: string,
  input: VolumeAnalyzeInput,
): Promise<VolumeBasedAnalysisResult> {
  const steps: ProcedureStepLite[] = [];

  /* ── 1. Extraction ── */
  let extracted: ExtractedVolumePricingRequirement;
  if (input.extracted) {
    extracted = input.extracted;
    push(steps, "parse-prompt", "info", "Reusing a previously-extracted pricing requirement.");
  } else {
    push(steps, "parse-prompt", "start", "Parsing the natural-language pricing requirement.");
    try {
      extracted = await parseVolumeBasedPrompt(apiKey, input.prompt ?? "");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not parse the prompt.";
      push(steps, "parse-prompt", "error", message);
      return { stage: "ai-parse-failed", error: message, steps };
    }
    push(steps, "parse-prompt", "success", "Extracted a structured volume pricing requirement.");
  }

  /* ── 2. Resolve the product ── */
  push(steps, "verify-product", "start", "Resolving the product in Salesforce.");
  let product: DiscoveredProduct | null;
  if (input.selectedProductId) {
    product = await resolveProduct2ById(client, input.selectedProductId);
    if (!product) {
      const message = "The selected product could not be found.";
      push(steps, "verify-product", "error", message);
      return { stage: "product-not-found", productName: extracted.productName ?? "", suggestions: [], extracted, steps };
    }
  } else if (!extracted.productName?.trim()) {
    const message = "Couldn't tell which product this pricing requirement is for — please name the product explicitly.";
    push(steps, "verify-product", "error", message);
    return { stage: "product-missing", error: message, steps };
  } else {
    const resolution = await resolveOrSuggestProduct(client, extracted.productName);
    if (resolution.status === "not-found") {
      push(steps, "verify-product", "error", `No product named "${extracted.productName}" was found.`);
      return { stage: "product-not-found", productName: extracted.productName, suggestions: resolution.candidates, extracted, steps };
    }
    if (resolution.status === "ambiguous") {
      push(steps, "verify-product", "error", `Multiple products matched "${extracted.productName}".`);
      return { stage: "product-ambiguous", productName: extracted.productName, matches: resolution.candidates, extracted, steps };
    }
    product = resolution.product;
  }
  push(steps, "verify-product", "success", `Found ${product.name} (${product.productCode || product.id}).`);

  /* ── 3. Validate tiers ── */
  const tiers = input.tierOverrides && input.tierOverrides.length > 0 ? input.tierOverrides : extracted.volumeTiers;
  if (tiers.length === 0) {
    push(steps, "validate-tiers", "info", "No volume tiers were extracted yet.");
    return { stage: "needs-tiers", product, extracted, steps };
  }
  push(steps, "validate-tiers", "success", `${tiers.length} tier(s) ready for review.`);

  const basePrice = input.basePriceOverride ?? extracted.basePrice ?? product.basePrice ?? 0;
  const warnings: string[] = [];
  if (!tiers.some(t => t.upperBound === null)) {
    warnings.push("No tier is open-ended (upperBound: null) — the last band should normally have no upper limit.");
  }

  return { stage: "ready-for-review", product, extracted, tiers, basePrice, warnings, steps };
}
