/**
 * Bundle-Based Pricing — read-only analyze orchestrator. Mirrors
 * lib/pricing-rules/attribute-based/analyze.ts's stage-by-stage shape exactly, adapted for a CLOSED-WORLD
 * component model: a bundle component can never be created/invented, only matched against (or excluded
 * from) the bundle's real, already-configured Salesforce structure. Never writes to Salesforce.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { resolveOrSuggestBundle, resolveBundleProductById } from "./bundleLookup";
import { discoverBundleStructure } from "./discoverBundleStructure";
import { parseBundleBasedPrompt } from "./parsePrompt";
import { resolveMappingSuggestion } from "./fuzzyMatch";
import type {
  BundleBasedAnalysisResult, BundleBasedMappingOverrides, BundleComponentPlanRow, ComponentAdjustmentRow,
  DiscoveredBundle, ExtractedBundlePricingRequirement, NameSuggestion, ProcedureStepLite,
} from "./types";

export interface BundleAnalyzeInput {
  prompt?: string;
  extracted?: ExtractedBundlePricingRequirement;
  selectedBundleId?: string;
  overrides?: BundleBasedMappingOverrides;
}

function push(steps: ProcedureStepLite[], step: string, status: ProcedureStepLite["status"], message: string): void {
  steps.push({ step, status, message, timestamp: Date.now() });
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function analyzeBundleBasedPrompt(
  client: SalesforceClient,
  apiKey: string,
  input: BundleAnalyzeInput,
): Promise<BundleBasedAnalysisResult> {
  const steps: ProcedureStepLite[] = [];

  /* ── 1. Extraction ── */
  let extracted: ExtractedBundlePricingRequirement;
  if (input.extracted) {
    extracted = input.extracted;
    push(steps, "parse-prompt", "info", "Reusing a previously-extracted pricing requirement.");
  } else {
    push(steps, "parse-prompt", "start", "Parsing the natural-language pricing requirement.");
    try {
      extracted = await parseBundleBasedPrompt(apiKey, input.prompt ?? "");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not parse the prompt.";
      push(steps, "parse-prompt", "error", message);
      return { stage: "ai-parse-failed", error: message, steps };
    }
    push(steps, "parse-prompt", "success", "Extracted a structured bundle pricing requirement.");
  }

  /* ── 2. Resolve the bundle's parent product ── */
  push(steps, "verify-bundle", "start", "Resolving the bundle's parent product in Salesforce.");
  let bundleProduct;
  if (input.selectedBundleId) {
    bundleProduct = await resolveBundleProductById(client, input.selectedBundleId);
    if (!bundleProduct) {
      const message = "The selected bundle product could not be found.";
      push(steps, "verify-bundle", "error", message);
      return { stage: "bundle-not-found", bundleName: extracted.bundleName ?? "", suggestions: [], extracted, steps };
    }
  } else if (!extracted.bundleName?.trim()) {
    const message = "Couldn't tell which bundle this pricing requirement is for — please name the bundle explicitly.";
    push(steps, "verify-bundle", "error", message);
    return { stage: "bundle-missing", error: message, steps };
  } else {
    const resolution = await resolveOrSuggestBundle(client, extracted.bundleName);
    if (resolution.status === "not-found") {
      push(steps, "verify-bundle", "error", `No product named "${extracted.bundleName}" was found.`);
      return { stage: "bundle-not-found", bundleName: extracted.bundleName, suggestions: resolution.candidates, extracted, steps };
    }
    if (resolution.status === "ambiguous") {
      push(steps, "verify-bundle", "error", `Multiple products matched "${extracted.bundleName}".`);
      return { stage: "bundle-ambiguous", bundleName: extracted.bundleName, matches: resolution.candidates, extracted, steps };
    }
    bundleProduct = resolution.product;
  }
  push(steps, "verify-bundle", "success", `Found ${bundleProduct.name} (${bundleProduct.productCode ?? bundleProduct.id}).`);

  /* ── 3. Discover the bundle's real child components ── */
  push(steps, "discover-bundle-components", "start", "Discovering the bundle's real child components.");
  const structure = await discoverBundleStructure(client, bundleProduct);
  if (!structure.bundle || structure.bundle.components.length === 0) {
    const attemptSummary = structure.attempts
      .map(a => `${a.objectName}: ${a.fieldsResolved ? `${a.rowCount} row(s)` : "not present/not resolvable on this org"}`)
      .join("; ");
    push(steps, "discover-bundle-components", "error", `No components found. Checked: ${attemptSummary}`);
    return {
      stage: "not-a-bundle",
      bundle: { id: bundleProduct.id, name: bundleProduct.name, productCode: bundleProduct.productCode },
      extracted, steps,
    };
  }
  const bundle: DiscoveredBundle = structure.bundle;
  push(steps, "discover-bundle-components", "success", `Discovered ${bundle.components.length} component(s) via ${bundle.relationshipSource}.`);

  /* ── 4. Validate the prompt's requested components against the bundle's real structure ── */
  if (extracted.components.length === 0) {
    push(steps, "validate-components", "info", "No components were named for pricing yet.");
    return { stage: "components-awaiting-pricing", bundle, steps };
  }

  push(steps, "validate-components", "start", "Validating requested components against the bundle's real structure.");
  const componentByNormalizedName = new Map(bundle.components.map(c => [normalize(c.productName), c]));
  const fuzzyCandidates = bundle.components.map(c => ({ value: c.productName, label: c.productName }));

  const ignoredComponents = [...(input.overrides?.ignoredComponents ?? [])];
  const matched: { real: string; requested: typeof extracted.components[number] }[] = [];
  const missing: string[] = [];
  const suggestions: NameSuggestion[] = [];

  for (const requestedComponent of extracted.components) {
    if (ignoredComponents.includes(requestedComponent.componentName)) continue;

    const mappedName = input.overrides?.componentNameMappings?.[requestedComponent.componentName] ?? requestedComponent.componentName;
    const real = componentByNormalizedName.get(normalize(mappedName));
    if (real) {
      matched.push({ real: real.productName, requested: requestedComponent });
      continue;
    }

    missing.push(requestedComponent.componentName);
    const suggestion = resolveMappingSuggestion(requestedComponent.componentName, fuzzyCandidates);
    suggestions.push({
      enteredName: requestedComponent.componentName,
      suggestedName: suggestion.suggested?.value ?? null,
      confidence: suggestion.confidence,
      alternatives: suggestion.alternatives.map(a => a.value),
    });
  }

  if (missing.length > 0) {
    push(steps, "validate-components", "error", `${missing.length} requested component(s) were not found in the resolved bundle structure for "${bundle.name}".`);
    return {
      stage: "component-mismatch",
      bundle, extracted,
      mismatch: { missingComponents: missing, availableComponents: bundle.components, suggestions },
      ignoredComponents, steps,
    };
  }
  if (matched.length === 0) {
    push(steps, "validate-components", "info", "Every requested component was excluded.");
    return { stage: "components-awaiting-pricing", bundle, steps };
  }
  push(steps, "validate-components", "success", `All ${matched.length} requested component(s) matched real bundle components.`);

  /* ── 5. Validate that every matched component has a stated adjustment (or an override) ── */
  const rows: ComponentAdjustmentRow[] = matched.map(({ real, requested }) => {
    const override = input.overrides?.adjustmentOverrides?.[real];
    return {
      componentName: real,
      componentProductId: componentByNormalizedName.get(normalize(real))!.productId,
      adjustmentType: override?.adjustmentType ?? requested.adjustmentType ?? "fixed",
      adjustment: override?.adjustment ?? requested.adjustment ?? 0,
      adjustmentStated: !!override || (requested.adjustmentType !== null && requested.adjustment !== null),
    };
  });
  const incompleteCount = rows.filter(r => !r.adjustmentStated).length;
  if (incompleteCount > 0) {
    push(steps, "validate-adjustments", "info", `${incompleteCount} component(s) still need an adjustment value.`);
    return { stage: "needs-adjustment-values", bundle, extracted, rows, ignoredComponents, steps };
  }
  push(steps, "validate-adjustments", "success", "Every requested component has a stated adjustment.");

  /* ── 6. Generate the full rule plan — one row per EVERY real bundle component, unstated ones default to $0 ── */
  push(steps, "generate-rules", "start", "Generating the bundle pricing rule plan.");
  const rowByProductId = new Map(rows.map(r => [r.componentProductId, r]));
  const rules: BundleComponentPlanRow[] = bundle.components.map(c => {
    const row = rowByProductId.get(c.productId);
    return {
      componentProductId: c.productId,
      componentName: c.productName,
      quantity: c.quantity,
      adjustmentType: row?.adjustmentType ?? "fixed",
      adjustment: row?.adjustment ?? 0,
      stated: row?.adjustmentStated ?? false,
    };
  });
  push(steps, "generate-rules", "success", `Generated ${rules.length} component pricing row(s) (${rules.filter(r => r.stated).length} priced, ${rules.filter(r => !r.stated).length} default $0).`);

  return { stage: "ready-for-review", bundle, extracted, rules, ignoredComponents, warnings: [], steps };
}
