/**
 * Volume-Based Pricing — client-side static RCA analyzer for a pasted Salesforce Simulate execution JSON.
 *
 * There is no automated backend "execute the pricing engine" call for this pricing type (Salesforce's own
 * Simulate UI is the only way to run a VolumeDiscount BKM end-to-end) — this is a pure function over the
 * simulation's own `additionalOutputData.pricingWaterfall[]` shape, run entirely client-side against
 * whatever JSON the user pastes in from Salesforce.
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
        detail: "The top-level output has no NetUnitPrice — the VolumeDiscount step never published a final unit price.",
        recommendation: "Check the per-step findings below for why VolumeDiscount did not produce an adjustment.",
      });
    }
    if (output.Subtotal === null || output.Subtotal === undefined) {
      findings.push({
        severity: "critical", step: "Subtotal", title: "Subtotal is null",
        detail: "The top-level output has no Subtotal — no step in the waterfall published a line total.",
        recommendation: "Confirm the VolumeDiscount step's output is wired to Subtotal/ItemNetTotalPrice.",
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

      if (elementType === "VolumeDiscount" || elementType === "VolumeTierDiscount") {
        const schedId = inputs.PriceAdjustmentScheduleId;
        const adjustments = (wfStep.pricingElement?.adjustments ?? []) as Record<string, unknown>[];

        if (!schedId || (typeof schedId === "string" && schedId.trim() === "")) {
          findings.push({
            severity: "critical", step: "VolumeDiscount", title: "PriceAdjustmentScheduleId is empty",
            detail: "The VolumeDiscount step's PriceAdjustmentScheduleId input is empty — the BKM has no schedule to look up.",
            recommendation: "In the Simulate UI, set the PriceAdjustmentSchedule context variable to the real PriceAdjustmentSchedule Id shown on the deployment result.",
          });
        } else if (typeof schedId === "string" && !isSalesforceId(schedId) && !schedId.trim().toUpperCase().startsWith("SELECT")) {
          findings.push({
            severity: "critical", step: "VolumeDiscount", title: "PriceAdjustmentScheduleId is not a Salesforce record Id",
            detail: `PriceAdjustmentScheduleId is "${schedId}" — this looks like plain text (e.g. a procedure name or prompt), not a 15/18-character Salesforce Id.`,
            recommendation: "Paste ONLY the Price Adjustment Schedule Id (from the deployment result) into the PriceAdjustmentSchedule context variable — not the procedure name or any other text.",
          });
        } else if (typeof schedId === "string" && schedId.trim().toUpperCase().startsWith("SELECT")) {
          findings.push({
            severity: "warning", step: "VolumeDiscount", title: "PriceAdjustmentScheduleId looks like a SOQL expression",
            detail: `PriceAdjustmentScheduleId is "${schedId}" — this may be a dynamic lookup that resolved fine, or may be broken.`,
            recommendation: "Confirm this resolved to a real PriceAdjustmentSchedule Id before trusting the rest of this simulation.",
          });
        }

        if (inputs.InputUnitPrice === null || inputs.InputUnitPrice === undefined) {
          findings.push({
            severity: "warning", step: "VolumeDiscount", title: "InputUnitPrice is null",
            detail: "VolumeDiscount's InputUnitPrice input is null — it has nothing to discount from.",
            recommendation: "Check the ListPrice step above — if it also failed, fix that first.",
          });
        }

        const validSchedId = isSalesforceId(schedId) || (typeof schedId === "string" && schedId.trim().toUpperCase().startsWith("SELECT"));
        if (validSchedId && inputs.InputUnitPrice !== null && inputs.InputUnitPrice !== undefined && adjustments.length === 0) {
          findings.push({
            severity: "critical", step: "VolumeDiscount", title: "adjustments array is empty despite a valid schedule + unit price",
            detail: "PriceAdjustmentScheduleId and InputUnitPrice both look valid, but the BKM returned zero adjustments — this is the signature of a stale Decision Table dataset.",
            recommendation: 'Go to Setup → Decision Tables → "Volume Discount Entries" (or the resolved Tier Adjustment table) → Refresh Dataset (or Refresh), then re-run the simulation.',
          });
        }

        // Range-vs-Slab miscalculation detector — only fires when every returned adjustment's
        // AdjustmentType is "overrideamount" and there are >=2 adjustments (i.e. Override-type tiers).
        const allOverride = adjustments.length >= 2 && adjustments.every(a => String(a.AdjustmentType ?? "").toLowerCase() === "overrideamount");
        if (allOverride) {
          const qty = num(inputs.Quantity ?? inputs.LineItemQuantity);
          const actualSubtotal = num(outputs.Subtotal);
          const sortedTiers = adjustments
            .map(a => ({ lo: num(a.LowerBound), hi: a.UpperBound === null || a.UpperBound === undefined ? 1e9 : num(a.UpperBound), price: num(a.DiscountedPrice ?? a.AdjustmentValue) }))
            .sort((a, b) => a.lo - b.lo);

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

          const tol = 1;
          if (Math.abs(actualSubtotal - slabSubtotal) < tol && Math.abs(actualSubtotal - rangeSubtotal) >= tol) {
            findings.push({
              severity: "critical", step: "VolumeDiscount", title: "AdjustmentMethod looks like Slab, not Range",
              detail: `Subtotal is ${actualSubtotal} but Range semantics (every unit at the matched tier's rate) would produce ${rangeSubtotal.toFixed(2)} — the actual value matches Slab semantics (${slabSubtotal.toFixed(2)}) instead.`,
              recommendation: "Redeploy this procedure — a fresh PriceAdjustmentSchedule will get the correct AdjustmentMethod=Range. If this persists, check Setup for whether AdjustmentMethod became immutable after tiers were created.",
            });
          }
        }
      }
    }
  }

  return findings;
}
