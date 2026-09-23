/**
 * Attribute-Based Pricing — Steps 2 & 3 (AI extraction -> Salesforce
 * validation -> pricing-rule preview). Deliberately its own type module,
 * separate from lib/pricing-rules/types.ts (which only holds the shell
 * shared across all four pricing types) — nothing here is generic across
 * pricing types, it's all specific to this one flow.
 *
 * Salesforce is the source of truth for Product -> Attributes -> Attribute
 * Values. The AI only ever interprets the user's business requirement; it
 * never invents a product/attribute/value that isn't real, and this module's
 * job is to prove that at every step before a single pricing rule is shown.
 */

export interface ProcedureStepLite {
  step: string;
  status: "start" | "success" | "error" | "info";
  message: string;
  timestamp: number;
}

/* ── Salesforce-sourced facts (never AI-generated) ── */
export interface DiscoveredAttributeValue {
  value: string;
  label: string;
}

export interface DiscoveredAttribute {
  name: string;
  label: string;
  dataType: string;
  isPriceImpacting: boolean | null;
  values: DiscoveredAttributeValue[];
  /** §Live-org fix (Desktop) — preserved effective-attribute metadata, all optional so every existing
   * consumer that only reads name/label/dataType/isPriceImpacting/values keeps working unchanged.
   * `source` distinguishes how this attribute became applicable to the product: a genuinely product-level
   * `ProductAttributeDefinition` record with no classification-attribute link (DIRECT), a product-level
   * record that overrides a classification-inherited one (OVERRIDE), or an attribute that is applicable
   * ONLY via the product's Product Classification with no product-level record at all (INHERITED) —
   * "Overridden Inherited Attributes = 0" in Salesforce's own UI means no OVERRIDE records exist, never
   * that no INHERITED ones do. */
  source?: "DIRECT" | "INHERITED" | "OVERRIDE";
  /** The real Salesforce AttributeDefinition.Id this effective attribute resolves to — never fabricated;
   * absent only if resolution genuinely couldn't determine it. */
  attributeDefinitionId?: string;
  /** The real ProductAttributeDefinition.Id, when this attribute has a product-level record (DIRECT or
   * OVERRIDE) — absent for a purely INHERITED attribute with no such record. */
  productAttributeDefinitionId?: string | null;
  isActive?: boolean | null;
  isRequired?: boolean | null;
  defaultValue?: string | null;
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

/* ── Step 1 — AI extraction (structured, never free-form-only) ── */
export type ExtractedAdjustmentType = "fixed" | "percentage" | "override";

export interface ExtractedAttributeValueAdjustment {
  value: string;
  adjustmentType: ExtractedAdjustmentType | null;
  /** Numeric magnitude only — null when the prompt named this value but never stated an amount/percentage (see Step 13 #10/#12). */
  adjustment: number | null;
}

export interface ExtractedAttribute {
  name: string;
  values: ExtractedAttributeValueAdjustment[];
}

/** §Combination-expansion architecture fix — a genuine EXPLICIT combination requirement (Case B: "when RAM
 * is 32GB AND Storage is 1TB, give an additional ₹5,000"), never fabricated merely because a prompt names
 * multiple independent attributes (Case A — "RAM 32GB adds ₹12,000 and Storage 1TB adds ₹8,000" produces
 * NO entries here). Structured (never a free-text string) so `analyze.ts` can resolve it against real
 * Salesforce data and `createPipeline.ts` can materialize exactly what was requested — never a full
 * Cartesian product of every attribute value the product happens to have. */
export interface ExtractedCombinationMember {
  attribute: string;
  value: string;
}

export interface ExtractedCombination {
  /** 2+ distinct attributes required — a single-attribute "combination" isn't one; Phase A (independent
   * attribute/value pricing) already covers that case, so the AI is instructed never to emit a 1-member entry. */
  members: ExtractedCombinationMember[];
  adjustmentType: ExtractedAdjustmentType | null;
  /** Numeric magnitude only — null when the prompt named the combination but never stated an amount (Step
   * 8.5 fails closed on this rather than defaulting to 0, since an un-priced combination isn't actionable). */
  adjustment: number | null;
  /** The original prompt phrase this combination was extracted from — verbatim or lightly cleaned up,
   * preserved for diagnostics and fail-closed messages, never re-parsed. */
  rawText: string;
}

export interface ExtractedPricingRequirement {
  pricingType: "attribute-based";
  product: string | null;
  attributes: ExtractedAttribute[];
  /** Free-text conditions the AI couldn't structure further (e.g. "only for orders over $500") — preserved for the user to see, never silently dropped. */
  conditions: string[];
  /** Explicit combination-specific pricing requirements — ONLY populated when the prompt used genuine
   * combination language ("when A and B", "if A and B", "combination of A and B", "A + B together",
   * "special price for A and B", etc.), never merely because multiple attributes were mentioned. Resolved
   * against real Salesforce data by `analyze.ts` (Step 8.5) into `CombinationRulePlanRow[]` before
   * anything is created. */
  combinations: ExtractedCombination[];
  currency: string | null;
  basePrice: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  otherNotes: string[];
}

/* ── Step 8/9 — generated rule plan row ── */
export interface PricingRulePlanRow {
  attributeName: string;
  attributeLabel: string;
  value: string;
  valueLabel: string;
  adjustmentType: ExtractedAdjustmentType;
  /** 0 for a value the prompt never priced — every real value of a priced attribute needs a row, and "no adjustment" is the only honest default (never fabricated). */
  adjustment: number;
  /** True only when the prompt itself named this exact value/adjustment. */
  stated: boolean;
  /** True when this row's value doesn't exist in Salesforce yet and the user explicitly approved creating it (Part E/G) — false for every real, already-existing value. */
  isNewValue: boolean;
}

/* ── Step 8.5 — resolved, real-Salesforce-verified explicit combination request (Case B) ── */
export interface CombinationMemberPlan {
  attributeName: string;
  attributeLabel: string;
  value: string;
  valueLabel: string;
}

/** One explicit, user-requested combination-specific pricing rule — every member is a REAL, Salesforce-
 * verified attribute+value pair (never invented, never guessed) and the adjustment is exactly what the
 * prompt stated for this combination (never summed from the members' own individual per-attribute
 * adjustments — that's a different, automatic-closure concept this explicit path doesn't use). */
export interface CombinationRulePlanRow {
  /** 2+ members. */
  members: CombinationMemberPlan[];
  adjustmentType: ExtractedAdjustmentType;
  adjustment: number;
  /** The original prompt phrase this combination came from — carried through for display/audit. */
  rawText: string;
}

/** A single explicit combination requirement that could not be safely resolved against real Salesforce
 * data — fail-closed, never guessed or silently substituted (Step 8.5). */
export interface CombinationResolutionProblem {
  rawText: string;
  reason: string;
}

/* ── Mismatch/mapping detail shapes (Steps 5-7) ── */
export interface NameSuggestion {
  enteredName: string;
  suggestedName: string | null;
  confidence: "high" | "medium" | null;
  /** Populated only when more than one plausible match exists — the caller must ask, never guess (Step 13 #7). */
  alternatives: string[];
}

export interface AttributeMismatchDetail {
  missingAttributes: string[];
  availableAttributes: DiscoveredAttribute[];
  suggestions: NameSuggestion[];
}

/**
 * §Attribute Mapping & Pricing Configuration — one row per attribute value
 * mentioned in the prompt, whether it already exists in Salesforce or not.
 * Rendered as a plain preview (Part 1/7) when every row is `existing` (or
 * `markedForCreation`) and `adjustmentStated`, or as the interactive mapping
 * grid (Part 2/3) otherwise. Never covers values NOT mentioned in the
 * prompt — those are shown separately via `discoveredAttributes` (Part 4).
 */
export interface AttributeValueRow {
  attributeName: string;
  attributeLabel: string;
  enteredValue: string;
  /** True when `enteredValue` already resolves to a real Salesforce attribute value (Part 5 "✓ Existing"). */
  existing: boolean;
  /** The real Salesforce value/label once known — from a direct match, an accepted mapping override, or null while still unresolved. */
  resolvedValue: string | null;
  resolvedValueLabel: string | null;
  /** Every real Salesforce value for this attribute — populated only when `existing` is false, for the mapping dropdown (Part 2). */
  availableValues: DiscoveredAttributeValue[];
  suggestion: { value: string; label: string; confidence: "high" | "medium" } | null;
  /** Populated only when more than one plausible match exists (Step 13 #8) — never a silent guess between them. */
  alternatives: { value: string; label: string }[];
  /** True once the user has explicitly approved creating `enteredValue` as a brand-new Salesforce value (Part 5/8) — Salesforce is never written to until final confirmation. */
  markedForCreation: boolean;
  adjustmentType: ExtractedAdjustmentType;
  adjustment: number;
  /** True once the prompt or a manual override has actually supplied an adjustment — false means the input above is just showing the "fixed"/0 default and still needs the user's attention. */
  adjustmentStated: boolean;
}

/* ── Manual-mapping overrides the client resubmits after Steps 5-7 (Step 7) ── */
export interface AttributeBasedMappingOverrides {
  /** Entered attribute name -> real Salesforce attribute name. */
  attributeNameMappings?: Record<string, string>;
  /** `${realAttributeName}::${enteredValue}` -> real Salesforce value. */
  attributeValueMappings?: Record<string, string>;
  /** Entered attribute names the user chose to Ignore (Part C) — excluded from pricing entirely; never causes the run to fail. */
  ignoredAttributes?: string[];
  /** `${realAttributeName}::${enteredValue}` the user explicitly approved creating as a brand-new Salesforce value (Part E) — everything else with no match stays blocked. */
  valuesToCreate?: string[];
  /** `${realAttributeName}::${enteredValue}` -> the user's chosen adjustment type/amount for that row (Part 3) — overrides whatever (if anything) the prompt itself stated. */
  adjustmentOverrides?: Record<string, { adjustmentType: ExtractedAdjustmentType; adjustment: number }>;
  /** §Phase 6 fix — the user's choice when the prompt's stated base price disagrees with Salesforce's
   * real Standard Pricebook price (`price-conflict` stage). `USE_EXISTING` proceeds with Salesforce's
   * real price unmentioned; `USE_NEW` proceeds acknowledging the prompt's stated price for reference —
   * neither ever changes the real Salesforce price, which is a Product/Pricebook concern outside this
   * pipeline's scope. */
  basePriceDecision?: "USE_EXISTING" | "USE_NEW";
}

/* ── Final discriminated result — the UI renders exactly one of these per call. ── */
export type AttributeBasedAnalysisResult =
  | { stage: "ai-parse-failed"; error: string; steps: ProcedureStepLite[] }
  | { stage: "product-missing"; error: string; steps: ProcedureStepLite[] }
  | { stage: "product-not-found"; productName: string; suggestions: ProductCandidate[]; extracted: ExtractedPricingRequirement; steps: ProcedureStepLite[] }
  | { stage: "product-ambiguous"; productName: string; matches: ProductCandidate[]; extracted: ExtractedPricingRequirement; steps: ProcedureStepLite[] }
  | {
      /** §Phase 6 fix — the prompt explicitly stated a base price that disagrees with Salesforce's real
       * Standard Pricebook price for this product. Never silently resolved either way. */
      stage: "price-conflict";
      product: DiscoveredProduct;
      extracted: ExtractedPricingRequirement;
      existingBasePrice: number;
      requestedBasePrice: number;
      steps: ProcedureStepLite[];
    }
  | { stage: "salesforce-error"; error: string; steps: ProcedureStepLite[] }
  | { stage: "no-attributes-found"; product: DiscoveredProduct; extracted: ExtractedPricingRequirement; steps: ProcedureStepLite[] }
  | {
      stage: "attribute-mismatch";
      product: DiscoveredProduct;
      extracted: ExtractedPricingRequirement;
      mismatch: AttributeMismatchDetail;
      /** Attribute names the user already chose to Ignore in a prior round-trip this run (Part C) — carried through for display continuity, never re-flagged as a mismatch. */
      excludedAttributes: string[];
      steps: ProcedureStepLite[];
    }
  | {
      /** §Attribute Mapping & Pricing Configuration (Parts 1-8) — replaces the old separate
       * "attribute-value-mismatch"/"adjustment-incomplete" terminal stages with one unified,
       * always-fully-computed row set so the client can render one interactive screen instead
       * of forcing the user through a resubmit-per-problem-category cycle. */
      stage: "needs-mapping";
      product: DiscoveredProduct;
      extracted: ExtractedPricingRequirement;
      discoveredAttributes: DiscoveredAttribute[];
      rows: AttributeValueRow[];
      excludedAttributes: string[];
      steps: ProcedureStepLite[];
    }
  | { stage: "attributes-awaiting-pricing"; product: DiscoveredProduct; discoveredAttributes: DiscoveredAttribute[]; steps: ProcedureStepLite[] }
  | {
      /** §Combination-expansion architecture fix (Step 8.5) — one or more explicit combination
       * requirements in the prompt (`extracted.combinations`) could not be safely resolved against real
       * Salesforce attributes/values (unknown attribute, unknown value, ambiguous match, conflicting
       * duplicate combinations, or no adjustment amount stated). Never guessed, never silently dropped —
       * the user must fix the prompt (or resubmit `extracted` with corrected combinations) and retry. */
      stage: "combination-unresolved";
      product: DiscoveredProduct;
      extracted: ExtractedPricingRequirement;
      problems: CombinationResolutionProblem[];
      steps: ProcedureStepLite[];
    }
  | {
      stage: "ready-for-review";
      product: DiscoveredProduct;
      extracted: ExtractedPricingRequirement;
      discoveredAttributes: DiscoveredAttribute[];
      rules: PricingRulePlanRow[];
      /** §Combination-expansion architecture fix — every explicit combination the prompt requested (Case
       * B), already resolved/deduplicated/validated against real Salesforce data. Empty (the default) means
       * no combination-specific pricing was requested, so `createPipeline.ts` skips combinatorial
       * expansion entirely — it never runs a full Cartesian product merely because this array is empty. */
      combinationRules: CombinationRulePlanRow[];
      /** Attribute names the user chose to Ignore (Part C) — shown on the Part F confirmation screen as "Excluded from pricing," never created. */
      excludedAttributes: string[];
      warnings: string[];
      steps: ProcedureStepLite[];
    };
