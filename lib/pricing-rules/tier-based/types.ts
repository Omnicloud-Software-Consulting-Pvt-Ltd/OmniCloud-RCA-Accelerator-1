/**
 * Tier-Based (Slab) Pricing module — analyze-time types.
 *
 * Deliberately its own type module, mirroring lib/pricing-rules/volume-based/types.ts's own stated
 * convention: nothing here is generic across pricing types, even where a shape looks identical to a
 * sibling's (e.g. VolumeTier/TierType — genuinely the same wire shape as volume-based, re-exported rather
 * than duplicated, since PriceAdjustmentTier is the same native object either way).
 *
 * Tier-Based Pricing is a Slab-type quantity discount: contiguous quantity bands (tiers), where EACH band
 * only prices the units that fall inside it — the opposite of Volume-Based/Range pricing, where hitting a
 * threshold re-prices EVERY unit at the winning band's rate. This module implements ONLY the
 * tier-based/Slab branch — volume-based/Range is out of scope here (see lib/pricing-rules/volume-based/).
 *
 * One deliberate exception, confirmed by this org's own AdjustmentMethod resolution rule (see
 * create/nativeRecords.ts's `resolveAdjustmentMethodValue`): a tier-based procedure whose tiers are all
 * "Override" (absolute final unit price, not a delta) resolves to the Range-equivalent AdjustmentMethod
 * instead of Slab, because "spread units across every band at each band's override price" would double-
 * count/misprice an override-priced schedule. Percentage/Amount tiers always resolve to Slab.
 */

export type { TierType, VolumeTier } from "@/lib/pricing-rules/volume-based/types";
import type { VolumeTier } from "@/lib/pricing-rules/volume-based/types";

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

export interface ExtractedTierPricingRequirement {
  pricingType: "tier-based";
  productName: string | null;
  basePrice: number | null;
  volumeTiers: VolumeTier[];
  currency: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  otherNotes: string[];
}

export type TierBasedAnalysisResult =
  | { stage: "ai-parse-failed"; error: string; steps: ProcedureStepLite[] }
  | { stage: "product-missing"; error: string; steps: ProcedureStepLite[] }
  | { stage: "product-not-found"; productName: string; suggestions: ProductCandidate[]; extracted: ExtractedTierPricingRequirement; steps: ProcedureStepLite[] }
  | { stage: "product-ambiguous"; productName: string; matches: ProductCandidate[]; extracted: ExtractedTierPricingRequirement; steps: ProcedureStepLite[] }
  | { stage: "salesforce-error"; error: string; steps: ProcedureStepLite[] }
  | { stage: "needs-tiers"; product: DiscoveredProduct; extracted: ExtractedTierPricingRequirement; steps: ProcedureStepLite[] }
  | {
      stage: "ready-for-review";
      product: DiscoveredProduct;
      extracted: ExtractedTierPricingRequirement;
      tiers: VolumeTier[];
      basePrice: number;
      warnings: string[];
      steps: ProcedureStepLite[];
    };
