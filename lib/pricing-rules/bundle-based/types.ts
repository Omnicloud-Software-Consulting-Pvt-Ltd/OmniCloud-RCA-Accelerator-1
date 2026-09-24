/**
 * Bundle-Based Pricing module — analyze-time types.
 *
 * Deliberately its own type module, mirroring lib/pricing-rules/attribute-based/types.ts's own stated
 * convention: nothing here is generic across pricing types, even where a shape looks similar to its
 * attribute-based counterpart (e.g. ProcedureStepLite) — each pricing-type folder stays self-contained.
 *
 * Bundle components are a CLOSED WORLD: unlike an Attribute Value, a bundle component can never be
 * invented/created by this flow — it must already exist as a real ProductRelatedComponent (or equivalent
 * relationship) row in the connected org. There is therefore no "create new component" concept anywhere
 * in this module, unlike attribute-based's "create new value" path.
 */

export interface ProcedureStepLite {
  step: string;
  status: "start" | "success" | "error" | "info";
  message: string;
  timestamp: number;
}

export interface DiscoveredBundleComponent {
  productId: string;
  productName: string;
  productCode: string | null;
  /** Sequence/ordering position of this component within the bundle, if the discovered relationship object exposes one. */
  sequence: number | null;
  /** Minimum/default quantity for this component, if the discovered relationship object exposes a quantity-like field. Never fabricated — null when absent. */
  quantity: number | null;
  isDefaultComponent: boolean | null;
  isComponentRequired: boolean | null;
  /** The component group/bundle element this component belongs to, if the org's schema exposes one (e.g. ProductComponentGroup). */
  componentGroup: string | null;
  /** The Id of the relationship row itself (ProductRelatedComponent / ProductRelationship / etc.) — never a fabricated identifier. */
  relationshipId: string;
  basePrice: number | null;
  sellingModel: string | null;
}

export type BundleRelationshipSource = "ProductRelatedComponent" | "ProductComponentGroup" | "ProductRelationship" | "ProductComponent";

export interface DiscoveredBundle {
  id: string;
  name: string;
  productCode: string | null;
  status: string | null;
  currency: string;
  basePrice: number | null;
  components: DiscoveredBundleComponent[];
  /** Which real Salesforce relationship object this org's bundle structure was actually discovered through — never assumed in advance. */
  relationshipSource: BundleRelationshipSource;
}

export interface BundleCandidate {
  id: string;
  name: string;
  productCode: string | null;
}

export type ExtractedAdjustmentType = "fixed" | "percentage" | "override";

export interface ExtractedComponentAdjustment {
  componentName: string;
  adjustmentType: ExtractedAdjustmentType | null;
  adjustment: number | null;
  /** Optional quantity condition stated in the prompt (e.g. "if 2 or more X are included") — never fabricated, null unless the prompt states one. */
  quantityCondition: number | null;
}

export interface ExtractedBundlePricingRequirement {
  pricingType: "bundle-based";
  bundleName: string | null;
  components: ExtractedComponentAdjustment[];
  /** Bundle-level conditions (e.g. selling-model gating) stated in the prompt — recorded, never auto-applied unless a later phase implements them. */
  conditions: string[];
  combinations: string[];
  currency: string | null;
  basePrice: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sellingModel: string | null;
  otherNotes: string[];
}

export interface BundleComponentPlanRow {
  componentProductId: string;
  componentName: string;
  quantity: number | null;
  adjustmentType: ExtractedAdjustmentType;
  adjustment: number;
  /** True only for a component the user's prompt actually named/priced — everything else defaults to a $0 fixed adjustment and is never invented. */
  stated: boolean;
}

export interface NameSuggestion {
  enteredName: string;
  suggestedName: string | null;
  confidence: "high" | "medium" | null;
  alternatives: string[];
}

export interface ComponentMismatchDetail {
  /** Requested component names that do not match any real component discovered for this bundle. */
  missingComponents: string[];
  availableComponents: DiscoveredBundleComponent[];
  suggestions: NameSuggestion[];
}

export interface ComponentAdjustmentRow {
  componentName: string;
  componentProductId: string;
  adjustmentType: ExtractedAdjustmentType;
  adjustment: number;
  adjustmentStated: boolean;
}

export interface BundleBasedMappingOverrides {
  /** enteredName -> the real component name the user confirmed it refers to. */
  componentNameMappings?: Record<string, string>;
  /** Component names the user explicitly said to drop from pricing (never priced, never blocks the run). */
  ignoredComponents?: string[];
  /** Final per-component adjustment values, keyed by real component name — set via the mapping/adjustment grid. */
  adjustmentOverrides?: Record<string, { adjustmentType: ExtractedAdjustmentType; adjustment: number }>;
}

export type BundleBasedAnalysisResult =
  | { stage: "ai-parse-failed"; error: string; steps: ProcedureStepLite[] }
  | { stage: "bundle-missing"; error: string; steps: ProcedureStepLite[] }
  | { stage: "bundle-not-found"; bundleName: string; suggestions: BundleCandidate[]; extracted: ExtractedBundlePricingRequirement; steps: ProcedureStepLite[] }
  | { stage: "bundle-ambiguous"; bundleName: string; matches: BundleCandidate[]; extracted: ExtractedBundlePricingRequirement; steps: ProcedureStepLite[] }
  | { stage: "salesforce-error"; error: string; steps: ProcedureStepLite[] }
  | { stage: "not-a-bundle"; bundle: { id: string; name: string; productCode: string | null }; extracted: ExtractedBundlePricingRequirement; steps: ProcedureStepLite[] }
  | { stage: "component-mismatch"; bundle: DiscoveredBundle; extracted: ExtractedBundlePricingRequirement; mismatch: ComponentMismatchDetail; ignoredComponents: string[]; steps: ProcedureStepLite[] }
  | { stage: "needs-adjustment-values"; bundle: DiscoveredBundle; extracted: ExtractedBundlePricingRequirement; rows: ComponentAdjustmentRow[]; ignoredComponents: string[]; steps: ProcedureStepLite[] }
  | { stage: "components-awaiting-pricing"; bundle: DiscoveredBundle; steps: ProcedureStepLite[] }
  | {
      stage: "ready-for-review";
      bundle: DiscoveredBundle;
      extracted: ExtractedBundlePricingRequirement;
      rules: BundleComponentPlanRow[];
      ignoredComponents: string[];
      warnings: string[];
      steps: ProcedureStepLite[];
    };
