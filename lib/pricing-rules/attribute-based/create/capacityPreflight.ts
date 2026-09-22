/**
 * §Root-cause fix (generic, org/product-agnostic capacity preflight) — a real live failure ("storage limit
 * exceeded" at Create Expression Set Version / Create Pricing Procedure, for a product whose combinatorial
 * closure needed 22 Rules/132 Conditions/22 Adjustments) proved this pipeline had ZERO awareness of
 * Salesforce's own Data Storage limit before attempting a potentially large, product-complexity-driven
 * batch of writes. A SEPARATE product in the SAME org had already deployed successfully earlier — proving
 * this is not a product-specific defect, but an org-capacity problem this pipeline never checked for.
 *
 * This module answers, BEFORE any combinatorial write happens: given the REAL, dynamically-discovered
 * combination space for whichever product/org is connected right now, and the REAL remaining Salesforce
 * capacity for that SAME org (via the standard, already-existing `client.validate()` → `/limits` call —
 * never a second implementation of it), is it safe to proceed?
 *
 * Nothing here is product/org-specific. Every number — attribute count, value count, combination count,
 * existing-vs-missing split, storage/API limits — is discovered fresh from the connected org and the
 * requested product on every call. The only non-discovered constant is `SALESFORCE_STORAGE_PER_RECORD_KB`,
 * which is not this app's own assumption — it is Salesforce's own long-documented data storage accounting
 * rule (every record, regardless of its own field contents, is billed as a flat 2 KB against Data Storage;
 * see Salesforce's Data Storage documentation) — a platform constant, not a per-product or per-org tuning
 * value.
 */
import type { SalesforceClient, OrgLimits } from "@/lib/salesforce/client";
import {
  discoverSingleAttributePricedOptions, computeAttributeCombinations, discoverExistingRuleContentIdentities,
  matchExistingRulesToCombinations, estimateCombinationApiCost, resolveBaseProductConfiguration,
  buildAttributeIdentityReverseMap,
  type AttributeBasedPricingSchema, type AttributeContext, type ExistingRuleContentIdentity,
} from "./nativeRecords";

/** Salesforce's own documented Data Storage accounting rule: every record is billed as exactly 2 KB
 * against an org's Data Storage limit, regardless of how many fields it has or how large its values are.
 * Not derived from this app's data — a fixed platform constant, the same for every org and every object. */
export const SALESFORCE_STORAGE_PER_RECORD_KB = 2;

export interface CombinatorialWriteCostEstimate {
  totalCombinations: number;
  keepCount: number;
  completeCount: number;
  createCount: number;
  ambiguousCount: number;
  estimatedNewRules: number;
  estimatedNewConditions: number;
  estimatedNewAdjustments: number;
  estimatedTotalNewRecords: number;
}

/**
 * Reuse-aware — NEVER a naive `totalCombinations * fixedRecordsPerCombination` multiply. Built directly on
 * top of the same, already-tested `CombinationRuleMatch` classification the real creation path uses
 * (`matchExistingRulesToCombinations`), so this estimate can never disagree with what the real run would
 * actually do:
 *   - KEEP combinations need zero new records (an identical, complete Rule+Adjustment already exists).
 *   - CREATE combinations need exactly 1 new Rule, one Condition per price-impacting attribute (a brand
 *     new Rule always needs its full condition set), and exactly 1 new Adjustment (a Rule that didn't
 *     exist a moment ago can never already have a matching Adjustment).
 *   - COMPLETE combinations need zero new Rules (an incomplete one is being finished), only the Conditions
 *     that Rule doesn't already have (`priceImpactingAttributeCount - rule.conditionCount`), and exactly 1
 *     new Adjustment (an incomplete Rule's condition set was never complete enough to have one already).
 *   - AMBIGUOUS combinations are never created (the existing "never guess" gate refuses them) — they cost
 *     zero writes, but are reported separately since they represent real, unresolved work.
 */
export function estimateCombinatorialWriteCost(
  combinations: unknown[][],
  matches: Map<number, { status: "KEEP" | "COMPLETE" | "CREATE" | "AMBIGUOUS"; ruleId: string | null }>,
  existingRulesById: Map<string, ExistingRuleContentIdentity>,
  priceImpactingAttributeCount: number,
): CombinatorialWriteCostEstimate {
  let keepCount = 0, completeCount = 0, createCount = 0, ambiguousCount = 0;
  let estimatedNewConditions = 0, estimatedNewAdjustments = 0;

  combinations.forEach((_combo, i) => {
    const match = matches.get(i);
    if (!match) return;
    switch (match.status) {
      case "KEEP":
        keepCount++;
        break;
      case "CREATE":
        createCount++;
        estimatedNewConditions += priceImpactingAttributeCount;
        estimatedNewAdjustments += 1;
        break;
      case "COMPLETE": {
        completeCount++;
        const existingRule = match.ruleId ? existingRulesById.get(match.ruleId) : undefined;
        const alreadyPresent = existingRule?.conditionCount ?? 0;
        estimatedNewConditions += Math.max(0, priceImpactingAttributeCount - alreadyPresent);
        estimatedNewAdjustments += 1;
        break;
      }
      case "AMBIGUOUS":
        ambiguousCount++;
        break;
    }
  });

  const estimatedNewRules = createCount;
  const estimatedTotalNewRecords = estimatedNewRules + estimatedNewConditions + estimatedNewAdjustments;
  return {
    totalCombinations: combinations.length, keepCount, completeCount, createCount, ambiguousCount,
    estimatedNewRules, estimatedNewConditions, estimatedNewAdjustments, estimatedTotalNewRecords,
  };
}

export interface SalesforceCapacityPreflightResult {
  status: "SAFE" | "BLOCKED" | "REQUIRES_REVIEW";
  reason: string;
  product: { id: string; name: string };
  priceImpactingAttributeCount: number;
  combinationCount: number;
  existingCombinations: number;
  missingCombinations: number;
  ambiguousCombinations: number;
  estimatedRules: number;
  estimatedConditions: number;
  estimatedAdjustments: number;
  estimatedTotalRecords: number;
  estimatedDataStorageMB: number;
  dataStorageRemainingMB: number | null;
  dataStorageMaxMB: number | null;
  fileStorageRemainingMB: number | null;
  fileStorageMaxMB: number | null;
  dailyApiRequestsRemaining: number | null;
  dailyApiRequestsMax: number | null;
  estimatedApiCallsLow: number;
  estimatedApiCallsHigh: number;
  recommendedAction: string;
  /** True only when `client.validate()` itself failed (e.g. no permission to call `/limits` on this org) —
   * storage/API fields above are then `null`, and `status` degrades to `REQUIRES_REVIEW` rather than
   * pretending a real number was checked. Never silently treated as SAFE. */
  limitsUnavailable: boolean;
}

/** Above this fraction of REMAINING (not total) capacity, a plan that isn't outright over the limit still
 * gets flagged for human review rather than proceeding silently — a generic, org-size-independent safety
 * margin (a plan that would consume the great majority of whatever headroom is left is inherently risky
 * regardless of which org or product it's for), not a per-product threshold. */
const REVIEW_MARGIN_FRACTION = 0.8;

/**
 * The Phase 3/4/11 preflight: discovers the REAL combinatorial closure for `args.product` on the connected
 * org, classifies every planned combination by content (KEEP/COMPLETE/CREATE/AMBIGUOUS — the same,
 * already-proven mechanism `expandAttributeCombinationRules` itself uses), estimates the resulting
 * Salesforce writes without any naive multiplication, and compares that estimate against this SAME org's
 * REAL, live `/limits` response. Strictly read-only — the only Salesforce calls made are the existing
 * read-only discovery/describe/SOQL calls this pipeline already trusts, plus `client.validate()`.
 */
export async function checkAttributeBasedPricingCapacityPreflight(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  args: { product: { id: string; name: string }; sellingModelId: string | null; scheduleId: string },
  contexts: Map<string, AttributeContext>,
): Promise<SalesforceCapacityPreflightResult> {
  const priceImpactingEntries = [...contexts.entries()].filter(([, ctx]) => ctx.isPriceImpacting === true);
  const priceImpactingAttributeNames = priceImpactingEntries.map(([name]) => name);
  const attributeIdentityById = buildAttributeIdentityReverseMap(contexts);

  const options = await discoverSingleAttributePricedOptions(client, schema, args, contexts);
  const combinations = computeAttributeCombinations(options);

  const baseConfig = await resolveBaseProductConfiguration(client, args.product.id, priceImpactingEntries);
  const defaultValueByAttr = new Map<string, string | null>(priceImpactingEntries.map(([name]) => [name, baseConfig.attributes[name]?.value ?? null]));

  const existingRuleIdentities = await discoverExistingRuleContentIdentities(
    client, schema, attributeIdentityById, args.product.id, priceImpactingAttributeNames, defaultValueByAttr,
  );
  const existingRulesById = new Map(existingRuleIdentities.map(r => [r.ruleId, r]));
  const matches = matchExistingRulesToCombinations(combinations, existingRuleIdentities, args.product.id, priceImpactingAttributeNames, defaultValueByAttr);

  const costEstimate = estimateCombinatorialWriteCost(combinations, matches, existingRulesById, priceImpactingAttributeNames.length);
  const apiEstimate = estimateCombinationApiCost(costEstimate.createCount + costEstimate.completeCount, priceImpactingAttributeNames.length);
  const estimatedDataStorageMB = (costEstimate.estimatedTotalNewRecords * SALESFORCE_STORAGE_PER_RECORD_KB) / 1024;

  let limits: OrgLimits | null = null;
  let limitsError: string | null = null;
  try {
    limits = await client.validate();
  } catch (err) {
    limitsError = err instanceof Error ? err.message : String(err);
  }

  const dataStorage = limits?.DataStorageMB ?? null;
  const fileStorage = limits?.FileStorageMB ?? null;
  const dailyApi = limits?.DailyApiRequests ?? null;

  const base: Omit<SalesforceCapacityPreflightResult, "status" | "reason" | "recommendedAction"> = {
    product: args.product,
    priceImpactingAttributeCount: priceImpactingAttributeNames.length,
    combinationCount: combinations.length,
    existingCombinations: costEstimate.keepCount,
    missingCombinations: costEstimate.createCount + costEstimate.completeCount,
    ambiguousCombinations: costEstimate.ambiguousCount,
    estimatedRules: costEstimate.estimatedNewRules,
    estimatedConditions: costEstimate.estimatedNewConditions,
    estimatedAdjustments: costEstimate.estimatedNewAdjustments,
    estimatedTotalRecords: costEstimate.estimatedTotalNewRecords,
    estimatedDataStorageMB,
    dataStorageRemainingMB: dataStorage?.Remaining ?? null,
    dataStorageMaxMB: dataStorage?.Max ?? null,
    fileStorageRemainingMB: fileStorage?.Remaining ?? null,
    fileStorageMaxMB: fileStorage?.Max ?? null,
    dailyApiRequestsRemaining: dailyApi?.Remaining ?? null,
    dailyApiRequestsMax: dailyApi?.Max ?? null,
    estimatedApiCallsLow: apiEstimate.estimatedApiCallsLowBound,
    estimatedApiCallsHigh: apiEstimate.estimatedApiCallsHighBound,
    limitsUnavailable: limits === null,
  };

  if (limits === null) {
    return {
      ...base,
      status: "REQUIRES_REVIEW",
      reason: `Could not read this org's Salesforce storage/API limits (${limitsError ?? "unknown error"}) — proceeding without a verified capacity check would risk the exact "storage limit exceeded" failure this preflight exists to catch. This is a permissions/connectivity issue with the /limits endpoint, never treated as "capacity confirmed safe."`,
      recommendedAction: "Confirm the connected user can call the standard Salesforce /limits REST endpoint, then retry. If this persists, review capacity manually in Setup before proceeding.",
    };
  }

  if (costEstimate.estimatedTotalNewRecords === 0) {
    return {
      ...base,
      status: "SAFE",
      reason: `All ${combinations.length} planned combination(s) for "${args.product.name}" already exist (or are ambiguous and will be skipped, never guessed) — this run needs zero new Rule/Condition/Adjustment records, so Salesforce Data Storage is not a concern.`,
      recommendedAction: "Proceed.",
    };
  }

  if (dataStorage && dataStorage.Remaining <= 0) {
    return {
      ...base,
      status: "BLOCKED",
      reason: `This org's Data Storage is already fully exhausted (${dataStorage.Remaining} MB of ${dataStorage.Max} MB remaining) — ANY new record write will fail with Salesforce's own "storage limit exceeded" error, regardless of how small this specific run's own estimate is. This is an org-capacity problem, not an Expression Set or product-configuration defect.`,
      recommendedAction: "Recover or provision additional Salesforce Data Storage for this org before retrying — no amount of retrying this pipeline will succeed until remaining Data Storage is above 0 MB.",
    };
  }

  if (dataStorage && estimatedDataStorageMB > dataStorage.Remaining) {
    return {
      ...base,
      status: "BLOCKED",
      reason: `This run is estimated to need ~${estimatedDataStorageMB.toFixed(3)} MB of Data Storage (${costEstimate.estimatedTotalNewRecords} new record(s) for "${args.product.name}": ${costEstimate.estimatedNewRules} Rule(s), ${costEstimate.estimatedNewConditions} Condition(s), ${costEstimate.estimatedNewAdjustments} Adjustment(s)), but this org only has ${dataStorage.Remaining} MB of ${dataStorage.Max} MB remaining. Proceeding would predictably fail partway through with Salesforce's own "storage limit exceeded" error, after some records are already created — this is an org-capacity problem, not an Expression Set or product-configuration defect.`,
      recommendedAction: "Recover or provision additional Salesforce Data Storage before retrying, or reduce the scope of this run (fewer attributes/values) so it needs fewer new records.",
    };
  }

  if (dataStorage && estimatedDataStorageMB > dataStorage.Remaining * REVIEW_MARGIN_FRACTION) {
    return {
      ...base,
      status: "REQUIRES_REVIEW",
      reason: `This run is estimated to need ~${estimatedDataStorageMB.toFixed(3)} MB of Data Storage, which is more than ${Math.round(REVIEW_MARGIN_FRACTION * 100)}% of this org's remaining ${dataStorage.Remaining} MB (of ${dataStorage.Max} MB total) — technically within capacity right now, but little headroom is left for anything else in this org afterward.`,
      recommendedAction: "Review before proceeding — this run alone should fit, but will leave very little Data Storage headroom in this org.",
    };
  }

  return {
    ...base,
    status: "SAFE",
    reason: `This run is estimated to need ~${estimatedDataStorageMB.toFixed(3)} MB of Data Storage (${costEstimate.estimatedTotalNewRecords} new record(s)) against ${dataStorage ? `${dataStorage.Remaining} MB of ${dataStorage.Max} MB` : "an unknown amount of"} remaining — within capacity.`,
    recommendedAction: "Proceed.",
  };
}
