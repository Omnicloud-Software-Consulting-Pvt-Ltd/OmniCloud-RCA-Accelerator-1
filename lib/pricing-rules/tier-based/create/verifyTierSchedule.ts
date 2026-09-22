/**
 * verify-tier-schedule — traces the VolumeTierDiscount BKM's own filter predicates against the
 * PriceAdjustmentSchedule/PriceAdjustmentTier records this pipeline actually created, for a given test
 * quantity. This is a pure native-records read-back — it never calls into Salesforce's real pricing
 * engine (that requires the Simulate action, see lib/pricing-rules/tier-based/rca/analyzeSimulation.ts for
 * the paste-and-analyze tool for THAT), so it cannot catch a stale Decision Table dataset — it can only
 * confirm whether the records THEMSELVES would satisfy the filter a correctly-refreshed BKM would apply:
 *   quantity is within [LowerBound, UpperBound], AND the tier's [EffectiveFrom, EffectiveTo] window covers
 *   today, AND the schedule itself is active.
 *
 * Wired into two places (Section 9, bug #1 of the port spec this module follows):
 *   - createPipeline.ts calls this automatically right after tier creation with a self-check quantity
 *     (the first tier's own lowerBound, which is guaranteed in-range by construction) and surfaces a
 *     warning for any verdict other than MATCH_FOUND — never fatal, since the native records are already
 *     real by this point.
 *   - POST /api/pricing-rules/tier-based/verify-tier-schedule exposes the same logic for a user-chosen
 *     scheduleId + quantity, as a manual "Diagnose" action after the fact.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";

export type VerifyTierScheduleVerdict =
  | "MATCH_FOUND"
  | "NO_MATCH"
  | "MULTIPLE_MATCHES"
  | "NO_TIERS"
  | "SCHEDULE_NOT_FOUND"
  | "SCHEDULE_INACTIVE";

export interface TierRecordSnapshot {
  id: string;
  lowerBound: number | null;
  upperBound: number | null;
  tierType: string | null;
  tierValue: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  withinBounds: boolean;
  withinEffectiveWindow: boolean;
}

export interface VerifyTierScheduleResult {
  verdict: VerifyTierScheduleVerdict;
  scheduleId: string;
  quantity: number;
  adjustmentMethod: string | null;
  scheduleActive: boolean | null;
  allTiers: TierRecordSnapshot[];
  matchedTiers: TierRecordSnapshot[];
  detail: string;
  recommendation: string;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function withinEffectiveWindow(effectiveFrom: string | null, effectiveTo: string | null, todayIso: string): boolean {
  if (effectiveFrom && effectiveFrom > todayIso) return false;
  if (effectiveTo && effectiveTo < todayIso) return false;
  return true;
}

export async function verifyTierSchedule(
  client: SalesforceClient,
  args: { scheduleId: string; quantity: number },
): Promise<VerifyTierScheduleResult> {
  const todayIso = new Date().toISOString().slice(0, 10);

  const schedRes = await client.query<Record<string, unknown>>(
    `SELECT Id, AdjustmentMethod, IsActive FROM PriceAdjustmentSchedule WHERE Id = '${soqlEscape(args.scheduleId)}' LIMIT 1`,
  ).catch(() => ({ records: [] as Record<string, unknown>[] }));
  const schedRecord = schedRes.records[0];
  if (!schedRecord) {
    return {
      verdict: "SCHEDULE_NOT_FOUND", scheduleId: args.scheduleId, quantity: args.quantity,
      adjustmentMethod: null, scheduleActive: null, allTiers: [], matchedTiers: [],
      detail: `No PriceAdjustmentSchedule record with Id ${args.scheduleId} was found.`,
      recommendation: "Confirm the schedule Id was copied correctly and has not been deleted.",
    };
  }
  const adjustmentMethod = typeof schedRecord.AdjustmentMethod === "string" ? schedRecord.AdjustmentMethod : null;
  const scheduleActive = schedRecord.IsActive === true;

  const tierRes = await client.query<Record<string, unknown>>(
    `SELECT Id, LowerBound, UpperBound, TierType, TierValue, EffectiveFrom, EffectiveTo FROM PriceAdjustmentTier WHERE PriceAdjustmentScheduleId = '${soqlEscape(args.scheduleId)}' LIMIT 200`,
  ).catch(() => ({ records: [] as Record<string, unknown>[] }));

  const allTiers: TierRecordSnapshot[] = tierRes.records.map(rec => {
    const lowerBound = num(rec.LowerBound);
    const upperBound = num(rec.UpperBound);
    const effectiveFrom = typeof rec.EffectiveFrom === "string" ? rec.EffectiveFrom : null;
    const effectiveTo = typeof rec.EffectiveTo === "string" ? rec.EffectiveTo : null;
    const withinBounds = lowerBound !== null && args.quantity >= lowerBound && (upperBound === null || args.quantity <= upperBound);
    return {
      id: String(rec.Id), lowerBound, upperBound,
      tierType: typeof rec.TierType === "string" ? rec.TierType : null,
      tierValue: num(rec.TierValue),
      effectiveFrom, effectiveTo,
      withinBounds,
      withinEffectiveWindow: withinEffectiveWindow(effectiveFrom, effectiveTo, todayIso),
    };
  });

  if (allTiers.length === 0) {
    return {
      verdict: "NO_TIERS", scheduleId: args.scheduleId, quantity: args.quantity,
      adjustmentMethod, scheduleActive, allTiers: [], matchedTiers: [],
      detail: `PriceAdjustmentSchedule ${args.scheduleId} has zero PriceAdjustmentTier child records.`,
      recommendation: "Nothing was created for this schedule — re-run the create pipeline, or check whether tier creation failed partway through.",
    };
  }

  const matchedTiers = allTiers.filter(t => t.withinBounds && t.withinEffectiveWindow);

  if (!scheduleActive) {
    return {
      verdict: "SCHEDULE_INACTIVE", scheduleId: args.scheduleId, quantity: args.quantity,
      adjustmentMethod, scheduleActive, allTiers, matchedTiers,
      detail: `PriceAdjustmentSchedule ${args.scheduleId} is not active (IsActive=false)${matchedTiers.length === 1 ? " — the tier records themselves would otherwise match cleanly" : ""}.`,
      recommendation: "Activate the schedule in Setup, or via the pipeline's own activate-schedule step, before trusting a live simulation.",
    };
  }

  if (matchedTiers.length === 0) {
    const boundsOnly = allTiers.filter(t => t.withinBounds);
    const detail = boundsOnly.length > 0
      ? `Quantity ${args.quantity} falls within a tier's [LowerBound, UpperBound] but that tier's EffectiveFrom/EffectiveTo window does not cover today (${todayIso}).`
      : `No PriceAdjustmentTier record's [LowerBound, UpperBound] range covers quantity ${args.quantity} — there is a gap in the configured bands.`;
    return {
      verdict: "NO_MATCH", scheduleId: args.scheduleId, quantity: args.quantity,
      adjustmentMethod, scheduleActive, allTiers, matchedTiers,
      detail,
      recommendation: boundsOnly.length > 0
        ? "Check the tier's EffectiveFrom/EffectiveTo dates — they should have been set to today and a far-future sentinel by the create pipeline."
        : "Review the configured tier bands for a gap or off-by-one boundary around this quantity.",
    };
  }

  if (matchedTiers.length > 1) {
    return {
      verdict: "MULTIPLE_MATCHES", scheduleId: args.scheduleId, quantity: args.quantity,
      adjustmentMethod, scheduleActive, allTiers, matchedTiers,
      detail: `Quantity ${args.quantity} falls within ${matchedTiers.length} overlapping PriceAdjustmentTier ranges — the bands are not disjoint.`,
      recommendation: "Review the tier bounds for overlap; the BKM's own tie-breaking behavior on overlapping bands is not guaranteed.",
    };
  }

  return {
    verdict: "MATCH_FOUND", scheduleId: args.scheduleId, quantity: args.quantity,
    adjustmentMethod, scheduleActive, allTiers, matchedTiers,
    detail: `Quantity ${args.quantity} matches exactly one active PriceAdjustmentTier (${matchedTiers[0].id}, [${matchedTiers[0].lowerBound}–${matchedTiers[0].upperBound ?? "∞"}], ${matchedTiers[0].tierType} ${matchedTiers[0].tierValue}).`,
    recommendation: "The native records are self-consistent for this quantity. If Salesforce's own Simulate action still returns adjustments:[], the Tier Adjustment Decision Table's dataset is stale — refresh it in Setup.",
  };
}
