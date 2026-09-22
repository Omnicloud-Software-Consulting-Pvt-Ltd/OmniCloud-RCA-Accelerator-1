/**
 * Volume-Based Pricing module — analyze-time types.
 *
 * Deliberately its own type module, mirroring lib/pricing-rules/bundle-based/types.ts's own stated
 * convention: nothing here is generic across pricing types, even where a shape looks similar to a
 * sibling's (e.g. ProcedureStepLite).
 *
 * Volume-Based Pricing is a Range-type quantity discount: contiguous quantity bands (tiers), where the
 * band the transaction's total line quantity falls into applies its rate to EVERY unit on the line (the
 * "Range" AdjustmentMethod, as opposed to Tier-Based/Slab pricing where each band only prices the units
 * that fall inside it). This module implements ONLY the volume-based/Range branch — a sibling
 * tier-based/Slab branch shares the same native objects and UI shape but is out of scope here.
 */

export interface ProcedureStepLite {
  step: string;
  status: "start" | "success" | "error" | "info";
  message: string;
  timestamp: number;
}

export interface DiscoveredProduct {
  id: string;
  name: string;
  productCode: string;
  status: string;
  currency: string;
  basePrice: number | null;
}

export interface ProductCandidate {
  id: string;
  name: string;
  productCode: string;
}

/** Salesforce PriceAdjustmentTier.TierType picklist — "Override" is the UI label; the real Salesforce API
 * value on some orgs is "OverridePrice"/"OverrideAmount" — resolved dynamically at create time, never
 * assumed (see create/nativeRecords.ts's `resolveTierType`). */
export type TierType = "Percentage" | "Amount" | "Override";

export interface VolumeTier {
  lowerBound: number;
  /** null = open-ended (no upper limit) — the last tier should always be open-ended. */
  upperBound: number | null;
  tierType: TierType;
  tierValue: number;
}

export interface ExtractedVolumePricingRequirement {
  pricingType: "volume-based";
  productName: string | null;
  basePrice: number | null;
  volumeTiers: VolumeTier[];
  currency: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  otherNotes: string[];
}

export type VolumeBasedAnalysisResult =
  | { stage: "ai-parse-failed"; error: string; steps: ProcedureStepLite[] }
  | { stage: "product-missing"; error: string; steps: ProcedureStepLite[] }
  | { stage: "product-not-found"; productName: string; suggestions: ProductCandidate[]; extracted: ExtractedVolumePricingRequirement; steps: ProcedureStepLite[] }
  | { stage: "product-ambiguous"; productName: string; matches: ProductCandidate[]; extracted: ExtractedVolumePricingRequirement; steps: ProcedureStepLite[] }
  | { stage: "salesforce-error"; error: string; steps: ProcedureStepLite[] }
  | { stage: "needs-tiers"; product: DiscoveredProduct; extracted: ExtractedVolumePricingRequirement; steps: ProcedureStepLite[] }
  | {
      stage: "ready-for-review";
      product: DiscoveredProduct;
      extracted: ExtractedVolumePricingRequirement;
      tiers: VolumeTier[];
      basePrice: number;
      warnings: string[];
      steps: ProcedureStepLite[];
    };
