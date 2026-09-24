/**
 * Steps 2-9 orchestration: Product verification -> attribute discovery ->
 * attribute validation -> attribute-value validation -> pricing-rule
 * generation -> preview. Every stage either proves something real against
 * Salesforce or stops and explains why, so the client never has to guess
 * what happened — see AttributeBasedAnalysisResult in ./types for the exact
 * shape each stage returns.
 *
 * This module never creates, updates, or deletes anything in Salesforce —
 * it only queries. Nothing here builds a PriceAdjustmentSchedule, Lookup
 * Table, Pricing Element, or Expression Set; that's a later stage.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { parseAttributeBasedPrompt } from "./parsePrompt";
import { resolveOrSuggestProduct, resolveProduct2ById } from "./productLookup";
import { discoverProductAttributes } from "./discoverAttributes";
import { resolveMappingSuggestion } from "./fuzzyMatch";
import type {
  AttributeBasedAnalysisResult,
  AttributeBasedMappingOverrides,
  AttributeMismatchDetail,
  AttributeValueRow,
  CombinationResolutionProblem,
  CombinationRulePlanRow,
  DiscoveredAttribute,
  ExtractedAttribute,
  ExtractedAdjustmentType,
  ExtractedCombination,
  ExtractedPricingRequirement,
  NameSuggestion,
  PricingRulePlanRow,
  ProcedureStepLite,
} from "./types";

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findAttribute(attributes: DiscoveredAttribute[], name: string): DiscoveredAttribute | undefined {
  const key = normalizeForMatch(name);
  return attributes.find(a => normalizeForMatch(a.name) === key || normalizeForMatch(a.label) === key);
}

/**
 * §Combination-expansion architecture fix (Step 8.5) — resolves every explicit combination requirement
 * from the prompt (`extracted.combinations`) against REAL Salesforce data, using the SAME
 * case/whitespace-insensitive normalization (`normalizeForMatch`) Step 6/7's own attribute-value matching
 * already uses. Fails closed — reports a problem, never guesses/substitutes — for: an unknown attribute, an
 * unknown value, an attribute referenced twice within one combination (a product can only hold one value
 * per attribute at a time), a value ambiguous across 2+ real values, or a combination with no stated
 * adjustment. Identical combinations (same resolved member set) are deduplicated silently when their
 * adjustments agree; a disagreement between duplicates is itself a fail-closed problem, never guessed.
 */
/** Exported for direct unit testing (pure — no Salesforce/AI dependency). */
export function resolveExplicitCombinations(
  combinations: ExtractedCombination[],
  discoveredAttributes: DiscoveredAttribute[],
): { resolved: CombinationRulePlanRow[]; problems: CombinationResolutionProblem[] } {
  const problems: CombinationResolutionProblem[] = [];
  const bySignature = new Map<string, CombinationRulePlanRow>();

  for (const combo of combinations) {
    const memberPlans: CombinationRulePlanRow["members"] = [];
    const seenAttrKeys = new Set<string>();
    let failed = false;

    for (const m of combo.members) {
      const real = findAttribute(discoveredAttributes, m.attribute);
      if (!real) {
        problems.push({ rawText: combo.rawText, reason: `Attribute "${m.attribute}" does not exist for this product.` });
        failed = true;
        continue;
      }
      const attrKey = normalizeForMatch(real.name);
      if (seenAttrKeys.has(attrKey)) {
        problems.push({ rawText: combo.rawText, reason: `Attribute "${real.label}" is referenced more than once in the same combination — a product can only have one value per attribute at a time.` });
        failed = true;
        continue;
      }
      seenAttrKeys.add(attrKey);

      const vkey = normalizeForMatch(m.value);
      const valueMatches = real.values.filter(v => normalizeForMatch(v.value) === vkey || normalizeForMatch(v.label) === vkey);
      if (valueMatches.length === 0) {
        problems.push({ rawText: combo.rawText, reason: `Value "${m.value}" does not exist for attribute "${real.label}" on this product.` });
        failed = true;
        continue;
      }
      if (valueMatches.length > 1) {
        problems.push({ rawText: combo.rawText, reason: `Value "${m.value}" for attribute "${real.label}" is ambiguous — it matches ${valueMatches.length} real values (${valueMatches.map(v => v.label).join(", ")}).` });
        failed = true;
        continue;
      }
      memberPlans.push({ attributeName: real.name, attributeLabel: real.label, value: valueMatches[0].value, valueLabel: valueMatches[0].label });
    }

    if (failed) continue;
    if (memberPlans.length < 2) {
      problems.push({ rawText: combo.rawText, reason: "This combination resolved to fewer than 2 distinct attributes — a combination needs 2 or more." });
      continue;
    }
    if (combo.adjustmentType === null || combo.adjustment === null) {
      problems.push({ rawText: combo.rawText, reason: "No price adjustment was stated for this combination — restate it with an explicit amount." });
      continue;
    }

    const signature = memberPlans.map(m => `${normalizeForMatch(m.attributeName)}=${normalizeForMatch(m.value)}`).sort().join("|");
    const existing = bySignature.get(signature);
    if (existing) {
      if (existing.adjustmentType !== combo.adjustmentType || existing.adjustment !== combo.adjustment) {
        problems.push({
          rawText: combo.rawText,
          reason: `This combination was already stated elsewhere in the prompt ("${existing.rawText}") with a DIFFERENT adjustment (${existing.adjustmentType}/${existing.adjustment} vs ${combo.adjustmentType}/${combo.adjustment}) — never resolved by guessing which one is correct.`,
        });
      }
      // Identical duplicate (same members, same adjustment) — deduplicated silently, nothing to report.
      continue;
    }
    bySignature.set(signature, { members: memberPlans, adjustmentType: combo.adjustmentType, adjustment: combo.adjustment, rawText: combo.rawText });
  }

  return { resolved: [...bySignature.values()], problems };
}

export interface AnalyzeInput {
  /** First-time submission — parsed via AI. Omit when resubmitting `extracted` directly (Step 7 mapping round-trips skip re-parsing). */
  prompt?: string;
  /** A previously-returned extraction, resubmitted after the user applied manual mappings — skips the AI call entirely. */
  extracted?: ExtractedPricingRequirement;
  /** The user picked an exact product from a `product-ambiguous`/`product-not-found` candidate list. */
  selectedProductId?: string;
  overrides?: AttributeBasedMappingOverrides;
}

export async function analyzeAttributeBasedPrompt(client: SalesforceClient, apiKey: string, input: AnalyzeInput): Promise<AttributeBasedAnalysisResult> {
  const steps: ProcedureStepLite[] = [];
  const push = (step: string, status: ProcedureStepLite["status"], message: string) => steps.push({ step, status, message, timestamp: Date.now() });

  /* ── Step 1 — extraction ── */
  let extracted: ExtractedPricingRequirement;
  if (input.extracted) {
    extracted = input.extracted;
    push("parse-prompt", "info", "Reusing the previously extracted requirement (manual mapping applied).");
  } else {
    push("parse-prompt", "start", "Analyzing pricing requirement.");
    try {
      extracted = await parseAttributeBasedPrompt(apiKey, input.prompt ?? "");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not understand that pricing requirement.";
      push("parse-prompt", "error", message);
      return { stage: "ai-parse-failed", error: message, steps };
    }
    push("parse-prompt", "success", `Extracted ${extracted.attributes.length} attribute(s) for "${extracted.product ?? "unknown product"}".`);
  }

  /* ── Step 2/3 — product verification ── */
  let product;
  if (input.selectedProductId) {
    push("verify-product", "start", `Resolving the product you selected.`);
    product = await resolveProduct2ById(client, input.selectedProductId);
    if (!product) {
      push("verify-product", "error", "The selected product could not be resolved.");
      return { stage: "product-not-found", productName: extracted.product ?? "", suggestions: [], extracted, steps };
    }
  } else {
    if (!extracted.product?.trim()) {
      push("verify-product", "error", "Could not determine which product this prompt refers to.");
      return {
        stage: "product-missing",
        error: "Couldn't tell which product you meant. Restate the prompt with the product name included, e.g. \"Create an attribute-based pricing procedure for Laptop Pro 15.\"",
        steps,
      };
    }
    push("verify-product", "start", `Verifying "${extracted.product}" exists in Salesforce.`);
    const resolution = await resolveOrSuggestProduct(client, extracted.product);
    if (resolution.status === "not-found") {
      push("verify-product", "error", `Product "${extracted.product}" was not found.`);
      return { stage: "product-not-found", productName: extracted.product, suggestions: resolution.candidates, extracted, steps };
    }
    if (resolution.status === "ambiguous") {
      push("verify-product", "info", `${resolution.candidates.length} products matched "${extracted.product}" — need you to pick one.`);
      return { stage: "product-ambiguous", productName: extracted.product, matches: resolution.candidates, extracted, steps };
    }
    product = resolution.product;
  }
  push("verify-product", "success", `Found ${product.name} (${product.productCode || product.id}).`);

  /* ── §Phase 6 fix — existing vs requested base price. Attribute-Based Adjustments apply ON TOP of
   * whatever Salesforce's real Standard Pricebook List Price already is (`product.basePrice`) — this
   * pipeline has no mechanism to change that price itself (a Product2/PricebookEntry concern, out of
   * scope for an Attribute-Based Adjustment). If the prompt explicitly stated a base price that DISAGREES
   * with the real one, never silently pick either side: surface it and require an explicit decision,
   * exactly like every other ambiguity this pipeline already refuses to guess through. Skipped entirely
   * when the prompt never stated a price at all (`extracted.basePrice === null`) — nothing to compare. */
  if (extracted.basePrice !== null && product.basePrice !== null && Math.abs(extracted.basePrice - product.basePrice) >= 0.005) {
    const decision = input.overrides?.basePriceDecision;
    if (!decision) {
      push(
        "verify-price", "info",
        `Prompt requests a base price of ${extracted.basePrice}, but Salesforce's existing Standard Pricebook price is ${product.basePrice} — need you to choose which to use.`,
      );
      return { stage: "price-conflict", product, extracted, existingBasePrice: product.basePrice, requestedBasePrice: extracted.basePrice, steps };
    }
    push(
      "verify-price", "info",
      decision === "USE_EXISTING"
        ? `Using Salesforce's existing base price (${product.basePrice}) — the prompt's requested ${extracted.basePrice} is not applied.`
        : `Proceeding with the prompt's requested base price (${extracted.basePrice}) for reference — Attribute-Based Adjustments still apply on top of Salesforce's real List Price (${product.basePrice}), which this pipeline does not itself change; update the product's price in Salesforce Setup if the List Price should actually be ${extracted.basePrice}.`,
    );
  }

  /* ── Step 4 — discover attributes ── */
  push("discover-attributes", "start", "Discovering this product's attributes from Salesforce.");
  const { attributes: discoveredAttributes, warnings: discoveryWarnings } = await discoverProductAttributes(client, product.id);
  if (discoveredAttributes.length === 0) {
    push("discover-attributes", "error", "No attributes were found for this product.");
    return { stage: "no-attributes-found", product, extracted, steps };
  }
  push("discover-attributes", "success", `${discoveredAttributes.length} attribute(s) discovered.`);

  /* ── Step 5 — compare prompt attributes vs Salesforce attributes ── */
  if (extracted.attributes.length === 0) {
    push("validate-attributes", "info", "No attributes were specified in the prompt — showing this product's real attributes for you to price.");
    return { stage: "attributes-awaiting-pricing", product, discoveredAttributes, steps };
  }

  const matched: { extracted: ExtractedAttribute; real: DiscoveredAttribute }[] = [];
  const missing: string[] = [];
  const attrSuggestions: NameSuggestion[] = [];
  /** Part C — attributes the user explicitly chose to Ignore in a prior round-trip this run; excluded before matching, never re-flagged, never failing the run. */
  const excludedAttributes: string[] = [];

  for (const ea of extracted.attributes) {
    if (input.overrides?.ignoredAttributes?.includes(ea.name)) {
      excludedAttributes.push(ea.name);
      continue;
    }
    const mappedName = input.overrides?.attributeNameMappings?.[ea.name] ?? ea.name;
    const real = findAttribute(discoveredAttributes, mappedName);
    if (real) {
      matched.push({ extracted: ea, real });
      continue;
    }
    missing.push(ea.name);
    const candidates = discoveredAttributes.map(a => ({ value: a.name, label: a.label }));
    const suggestion = resolveMappingSuggestion(ea.name, candidates);
    attrSuggestions.push({
      enteredName: ea.name,
      suggestedName: suggestion.suggested?.value ?? null,
      confidence: suggestion.confidence,
      alternatives: suggestion.alternatives.map(a => a.value),
    });
  }

  if (missing.length > 0) {
    push("validate-attributes", "error", `${missing.length} attribute(s) from the prompt don't exist for this product.`);
    const mismatch: AttributeMismatchDetail = { missingAttributes: missing, availableAttributes: discoveredAttributes, suggestions: attrSuggestions };
    return { stage: "attribute-mismatch", product, extracted, mismatch, excludedAttributes, steps };
  }
  if (matched.length === 0) {
    push("validate-attributes", "info", "Every requested attribute was excluded — showing this product's real attributes for you to price.");
    return { stage: "attributes-awaiting-pricing", product, discoveredAttributes, steps };
  }
  push("validate-attributes", "success", "All requested attributes are available for this product.");

  /* ── Step 6/7 — compare + map attribute values. Always builds one row per
   * prompt-mentioned value (whether it matches Salesforce or not, whether its
   * adjustment is stated or not) instead of stopping at the first problem
   * category — the client renders every row on one Attribute Mapping &
   * Pricing Configuration screen (Parts 1-8) rather than a resubmit-per-issue
   * cycle. ── */
  const rows: AttributeValueRow[] = [];
  interface ResolvedValue { value: string; valueLabel: string; adjustmentType: ExtractedAdjustmentType; adjustment: number; isNewValue: boolean }
  const resolvedValues = new Map<string, ResolvedValue[]>();

  for (const { extracted: ea, real } of matched) {
    const values: ResolvedValue[] = [];
    for (const ev of ea.values) {
      const mapKey = `${real.name}::${ev.value}`;
      const mappedValue = input.overrides?.attributeValueMappings?.[mapKey] ?? ev.value;
      const vkey = normalizeForMatch(mappedValue);
      const realValue = real.values.find(v => normalizeForMatch(v.value) === vkey || normalizeForMatch(v.label) === vkey);

      const adjOverride = input.overrides?.adjustmentOverrides?.[mapKey];
      const adjustmentType: ExtractedAdjustmentType = adjOverride?.adjustmentType ?? ev.adjustmentType ?? "fixed";
      const adjustment = adjOverride?.adjustment ?? ev.adjustment;
      const adjustmentStated = !!adjOverride || (!!ev.adjustmentType && ev.adjustment !== null);

      if (!realValue) {
        const markedForCreation = !!input.overrides?.valuesToCreate?.includes(mapKey);
        const candidates = real.values.map(v => ({ value: v.value, label: v.label }));
        const suggestion = resolveMappingSuggestion(ev.value, candidates);
        rows.push({
          attributeName: real.name,
          attributeLabel: real.label,
          enteredValue: ev.value,
          existing: false,
          resolvedValue: markedForCreation ? ev.value : null,
          resolvedValueLabel: markedForCreation ? ev.value : null,
          availableValues: real.values,
          suggestion: suggestion.suggested && suggestion.confidence ? { value: suggestion.suggested.value, label: suggestion.suggested.label, confidence: suggestion.confidence } : null,
          alternatives: suggestion.alternatives.map(a => ({ value: a.value, label: a.label })),
          markedForCreation,
          adjustmentType,
          adjustment: adjustment ?? 0,
          adjustmentStated,
        });
        if (markedForCreation && adjustmentStated) {
          values.push({ value: ev.value, valueLabel: ev.value, adjustmentType, adjustment: adjustment!, isNewValue: true });
        }
        continue;
      }

      rows.push({
        attributeName: real.name,
        attributeLabel: real.label,
        enteredValue: ev.value,
        existing: true,
        resolvedValue: realValue.value,
        resolvedValueLabel: realValue.label,
        availableValues: real.values,
        suggestion: null,
        alternatives: [],
        markedForCreation: false,
        adjustmentType,
        adjustment: adjustment ?? 0,
        adjustmentStated,
      });
      if (adjustmentStated) {
        values.push({ value: realValue.value, valueLabel: realValue.label, adjustmentType, adjustment: adjustment!, isNewValue: false });
      }
    }
    resolvedValues.set(real.name, values);
  }

  const unresolvedCount = rows.filter(r => !r.existing && !r.markedForCreation).length;
  const incompleteCount = rows.filter(r => (r.existing || r.markedForCreation) && !r.adjustmentStated).length;
  if (unresolvedCount > 0 || incompleteCount > 0) {
    push("validate-values", "info", `${unresolvedCount} attribute value(s) need mapping and ${incompleteCount} need a pricing adjustment — showing the mapping & configuration screen.`);
    return { stage: "needs-mapping", product, extracted, discoveredAttributes, rows, excludedAttributes, steps };
  }
  push("validate-values", "success", "All attribute values matched Salesforce and every adjustment is configured.");

  /* ── Step 8.5 — resolve any EXPLICIT combination-specific pricing requirement (Case B) against real
   * Salesforce data. §Combination-expansion architecture fix — this is what lets `createPipeline.ts`
   * materialize ONLY the combinations the user actually asked for, never a full Cartesian product of every
   * attribute value the product happens to have. Independent of `matched`/`rows` above: a combination may
   * reference an attribute already priced standalone in this SAME prompt, or one priced in an earlier run
   * entirely — always resolved against the full real `discoveredAttributes`, never just this run's own list. ── */
  const { resolved: combinationRules, problems: combinationProblems } = resolveExplicitCombinations(extracted.combinations, discoveredAttributes);
  if (combinationProblems.length > 0) {
    push("validate-combinations", "error", `${combinationProblems.length} explicit combination requirement(s) could not be resolved — see details.`);
    return { stage: "combination-unresolved", product, extracted, problems: combinationProblems, steps };
  }
  if (extracted.combinations.length > 0) {
    push("validate-combinations", "success", `${combinationRules.length} explicit combination-specific pricing rule(s) resolved against real Salesforce data.`);
  }

  /* ── Step 8 — generate the rule plan ── */
  const rules: PricingRulePlanRow[] = [];
  for (const { real } of matched) {
    const resolved = resolvedValues.get(real.name)!;
    const statedByValue = new Map(resolved.map(r => [r.value, r]));
    // Every real, already-existing value gets a row — stated ones carry the user's adjustment, unstated ones default to $0 (never fabricated).
    for (const v of real.values) {
      const stated = statedByValue.get(v.value);
      rules.push({
        attributeName: real.name,
        attributeLabel: real.label,
        value: v.value,
        valueLabel: v.label,
        adjustmentType: stated?.adjustmentType ?? "fixed",
        adjustment: stated?.adjustment ?? 0,
        stated: !!stated,
        isNewValue: false,
      });
    }
    // Plus one row for every user-approved brand-new value (Part E/G) — never a real Salesforce value yet, always explicitly stated.
    for (const r of resolved) {
      if (!r.isNewValue) continue;
      rules.push({
        attributeName: real.name,
        attributeLabel: real.label,
        value: r.value,
        valueLabel: r.valueLabel,
        adjustmentType: r.adjustmentType,
        adjustment: r.adjustment,
        stated: true,
        isNewValue: true,
      });
    }
  }
  push("generate-rules", "success", `${rules.length} pricing rule row(s) generated across ${matched.length} attribute(s).`);

  return { stage: "ready-for-review", product, extracted, discoveredAttributes, rules, combinationRules, excludedAttributes, warnings: discoveryWarnings, steps };
}
