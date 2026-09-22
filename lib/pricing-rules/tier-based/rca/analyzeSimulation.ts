/**
 * Tier-Based (Slab) Pricing — client-side static RCA analyzer for a pasted Salesforce Simulate execution
 * JSON. Mirrors lib/pricing-rules/volume-based/rca/analyzeSimulation.ts's checks (there is no automated
 * backend "execute the pricing engine" call for this pricing type either — Salesforce's own Simulate UI
 * is the only way to run a VolumeTierDiscount BKM end-to-end), with the Range-vs-Slab mismatch detector
 * generalized to fire in BOTH directions instead of only "looks like Slab when Range was expected":
 *   - All-Override adjustments (expected AdjustmentMethod=Range per this module's own business rule —
 *     see create/nativeRecords.ts's resolveAdjustmentMethodValue) that actually compute like Slab.
 *   - All-Percentage/Amount adjustments (expected AdjustmentMethod=Slab) that actually compute like
 *     Range — this direction needs a list price to derive each band's effective per-unit price, so it
 *     only fires when the waterfall's own ListPrice output is present; it silently skips otherwise rather
 *     than risk a false positive from an assumed value.
 */

export interface RcaFinding {
  severity: "critical" | "warning" | "info";
  step: string;
  title: string;
  detail: string;
  recommendation: string;
}

interface WaterfallStep {
  sequence?: number;
  pricingElement?: { elementType?: string; adjustments?: Record<string, unknown>[] };
  inputParameters?: Record<string, unknown>;
  outputParameters?: Record<string, unknown>;
}

interface WaterfallEntry {
  output?: Record<string, unknown>;
  waterfall?: WaterfallStep[];
}

interface SimulationShape {
  additionalOutputData?: { pricingWaterfall?: WaterfallEntry[] };
}

function isSalesforceId(v: unknown): boolean {
  return typeof v === "string" && /^[a-zA-Z0-9]{15,18}$/.test(v.trim());
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function computeRangeAndSlabSubtotals(qty: number, sortedTiers: { lo: number; hi: number; price: number }[]): { rangeSubtotal: number; slabSubtotal: number } {
  const matchingTier = sortedTiers.find(t => qty >= t.lo && qty <= t.hi) ?? sortedTiers[sortedTiers.length - 1];
  const rangeSubtotal = matchingTier ? qty * matchingTier.price : 0;

  let slabSubtotal = 0;
  let remaining = qty;
  for (let i = 0; i < sortedTiers.length; i++) {
    if (remaining <= 0) break;
    const tier = sortedTiers[i];
    const isLast = i === sortedTiers.length - 1;
    const bandUnits = isLast ? remaining : Math.min(remaining, tier.hi - tier.lo + 1);
    slabSubtotal += bandUnits * tier.price;
    remaining -= bandUnits;
  }
  return { rangeSubtotal, slabSubtotal };
}

export function analyzeSimulation(sim: unknown): RcaFinding[] {
  const findings: RcaFinding[] = [];
  const parsed = sim as SimulationShape;
  const entries = parsed?.additionalOutputData?.pricingWaterfall ?? [];

  if (entries.length === 0) {
    findings.push({
      severity: "critical", step: "(none)", title: "No pricing waterfall found",
      detail: "The pasted JSON has no additionalOutputData.pricingWaterfall array — this may not be a Simulate response, or the response shape has changed.",
      recommendation: "Paste the full JSON returned by Salesforce's Simulate action, not a subset of it.",
    });
    return findings;
  }

  for (const entry of entries) {
    const output = entry.output ?? {};
    if (output.ListPrice === null || output.ListPrice === undefined) {
      findings.push({
        severity: "critical", step: "ListPrice", title: "ListPrice is null",
        detail: "The top-level output has no ListPrice — the ListPrice step never resolved a base unit price.",
        recommendation: "Check that a Standard Price Book entry exists and is active for this product.",
      });
    } else if (output.NetUnitPrice === null || output.NetUnitPrice === undefined) {
      findings.push({
        severity: "critical", step: "NetUnitPrice", title: "NetUnitPrice is null",
        detail: "The top-level output has no NetUnitPrice — the VolumeTierDiscount step never published a final unit price.",
        recommendation: "Check the per-step findings below for why VolumeTierDiscount did not produce an adjustment.",
      });
    }
    if (output.Subtotal === null || output.Subtotal === undefined) {
      findings.push({
        severity: "critical", step: "Subtotal", title: "Subtotal is null",
        detail: "The top-level output has no Subtotal — no step in the waterfall published a line total.",
        recommendation: "Confirm the VolumeTierDiscount step's output is wired to Subtotal/ItemNetTotalPrice.",
      });
    }

    for (const wfStep of entry.waterfall ?? []) {
      const elementType = wfStep.pricingElement?.elementType;
      const inputs = wfStep.inputParameters ?? {};
      const outputs = wfStep.outputParameters ?? {};

      if (elementType === "ListPrice" && (outputs.ListPrice === null || outputs.ListPrice === undefined)) {
        findings.push({
          severity: "critical", step: "ListPrice",
          title: "ListPrice step produced no output",
          detail: `ListPrice step ran with Product=${JSON.stringify(inputs.Product2Id ?? inputs.Product ?? "(unknown)")}, SellingModel=${JSON.stringify(inputs.ProductSellingModelId ?? "(unknown)")}, PricingDate=${JSON.stringify(inputs.PricingDate ?? inputs.EffectiveDate ?? "(unknown)")} but published no ListPrice value.`,
          recommendation: "Verify a Standard Price Book entry exists for this exact product/selling-model combination.",
        });
      }

      if (elementType === "VolumeTierDiscount" || elementType === "VolumeDiscount") {
        const schedId = inputs.PriceAdjustmentScheduleId;
        const adjustments = (wfStep.pricingElement?.adjustments ?? []) as Record<string, unknown>[];

        if (!schedId || (typeof schedId === "string" && schedId.trim() === "")) {
          findings.push({
            severity: "critical", step: "VolumeTierDiscount", title: "PriceAdjustmentScheduleId is empty",
            detail: "The VolumeTierDiscount step's PriceAdjustmentScheduleId input is empty — the BKM has no schedule to look up.",
            recommendation: "In the Simulate UI, set the PriceAdjustmentSchedule context variable to the real PriceAdjustmentSchedule Id shown on the deployment result.",
          });
        } else if (typeof schedId === "string" && !isSalesforceId(schedId) && !schedId.trim().toUpperCase().startsWith("SELECT")) {
          findings.push({
            severity: "critical", step: "VolumeTierDiscount", title: "PriceAdjustmentScheduleId is not a Salesforce record Id",
            detail: `PriceAdjustmentScheduleId is "${schedId}" — this looks like plain text (e.g. a procedure name or prompt), not a 15/18-character Salesforce Id.`,
            recommendation: "Paste ONLY the Price Adjustment Schedule Id (from the deployment result) into the PriceAdjustmentSchedule context variable — not the procedure name or any other text.",
          });
        } else if (typeof schedId === "string" && schedId.trim().toUpperCase().startsWith("SELECT")) {
          findings.push({
            severity: "warning", step: "VolumeTierDiscount", title: "PriceAdjustmentScheduleId looks like a SOQL expression",
            detail: `PriceAdjustmentScheduleId is "${schedId}" — this may be a dynamic lookup that resolved fine, or may be broken.`,
            recommendation: "Confirm this resolved to a real PriceAdjustmentSchedule Id before trusting the rest of this simulation.",
          });
        }

        if (inputs.InputUnitPrice === null || inputs.InputUnitPrice === undefined) {
          findings.push({
            severity: "warning", step: "VolumeTierDiscount", title: "InputUnitPrice is null",
            detail: "VolumeTierDiscount's InputUnitPrice input is null — it has nothing to discount from.",
            recommendation: "Check the ListPrice step above — if it also failed, fix that first.",
          });
        }

        const validSchedId = isSalesforceId(schedId) || (typeof schedId === "string" && schedId.trim().toUpperCase().startsWith("SELECT"));
        if (validSchedId && inputs.InputUnitPrice !== null && inputs.InputUnitPrice !== undefined && adjustments.length === 0) {
          findings.push({
            severity: "critical", step: "VolumeTierDiscount", title: "adjustments array is empty despite a valid schedule + unit price",
            detail: "PriceAdjustmentScheduleId and InputUnitPrice both look valid, but the BKM returned zero adjustments — this is the signature of a stale Decision Table dataset.",
            recommendation: 'Go to Setup → Decision Tables → the resolved Tier Adjustment table → Refresh Dataset (or Refresh), then re-run the simulation.',
          });
        }

        const qty = num(inputs.Quantity ?? inputs.LineItemQuantity);
        const actualSubtotal = num(outputs.Subtotal);

        // Direction 1 — all-Override adjustments, expected AdjustmentMethod=Range (this module's own
        // business rule for Override tiers), flag if the actual value computes like Slab instead.
        const allOverride = adjustments.length >= 2 && adjustments.every(a => String(a.AdjustmentType ?? "").toLowerCase().includes("override"));
        if (allOverride) {
          const sortedTiers = adjustments
            .map(a => ({ lo: num(a.LowerBound), hi: a.UpperBound === null || a.UpperBound === undefined ? 1e9 : num(a.UpperBound), price: num(a.DiscountedPrice ?? a.AdjustmentValue) }))
            .sort((a, b) => a.lo - b.lo);
          const { rangeSubtotal, slabSubtotal } = computeRangeAndSlabSubtotals(qty, sortedTiers);
          const tol = 1;
          if (Math.abs(actualSubtotal - slabSubtotal) < tol && Math.abs(actualSubtotal - rangeSubtotal) >= tol) {
            findings.push({
              severity: "critical", step: "VolumeTierDiscount", title: "AdjustmentMethod looks like Slab, not Range",
              detail: `Subtotal is ${actualSubtotal} but Range semantics (every unit at the matched tier's Override price) would produce ${rangeSubtotal.toFixed(2)} — the actual value matches Slab semantics (${slabSubtotal.toFixed(2)}) instead. Override-tier procedures resolve to AdjustmentMethod=Range by design (see this module's AdjustmentMethod resolution rule) — a Slab result here means the schedule's AdjustmentMethod did not resolve/PATCH correctly.`,
              recommendation: "Redeploy this procedure, or manually set the PriceAdjustmentSchedule's AdjustmentMethod to its Range-equivalent picklist value in Setup. Check for whether AdjustmentMethod became immutable after tiers were created.",
            });
          }
        }

        // Direction 2 — all-Percentage/Amount adjustments, expected AdjustmentMethod=Slab, flag if the
        // actual value computes like Range instead. Needs a list price to derive each band's effective
        // per-unit price — skips silently if ListPrice isn't present, to avoid a false positive.
        const allNonOverride = adjustments.length >= 2 && adjustments.every(a => !String(a.AdjustmentType ?? "").toLowerCase().includes("override"));
        const listPrice = output.ListPrice !== null && output.ListPrice !== undefined ? num(output.ListPrice) : null;
        if (allNonOverride && listPrice !== null && listPrice > 0) {
          const isPercentageType = (t: string) => t.includes("percent");
          const sortedTiers = adjustments
            .map(a => {
              const type = String(a.AdjustmentType ?? "").toLowerCase();
              const value = num(a.AdjustmentValue ?? a.DiscountedPrice);
              const price = isPercentageType(type) ? listPrice * (1 - value / 100) : listPrice - value;
              return { lo: num(a.LowerBound), hi: a.UpperBound === null || a.UpperBound === undefined ? 1e9 : num(a.UpperBound), price };
            })
            .sort((a, b) => a.lo - b.lo);
          const { rangeSubtotal, slabSubtotal } = computeRangeAndSlabSubtotals(qty, sortedTiers);
          const tol = 1;
          if (Math.abs(actualSubtotal - rangeSubtotal) < tol && Math.abs(actualSubtotal - slabSubtotal) >= tol) {
            findings.push({
              severity: "critical", step: "VolumeTierDiscount", title: "AdjustmentMethod looks like Range, not Slab",
              detail: `Subtotal is ${actualSubtotal} but Slab semantics (each band pricing only its own units) would produce ${slabSubtotal.toFixed(2)} — the actual value matches Range semantics (${rangeSubtotal.toFixed(2)}) instead. Percentage/Amount-tier procedures resolve to AdjustmentMethod=Slab by design — a Range result here means the schedule's AdjustmentMethod did not resolve/PATCH correctly.`,
              recommendation: "Redeploy this procedure, or manually set the PriceAdjustmentSchedule's AdjustmentMethod to its Slab-equivalent picklist value in Setup. Check for whether AdjustmentMethod became immutable after tiers were created.",
            });
          }
        }
      }
    }
  }

  return findings;
}
