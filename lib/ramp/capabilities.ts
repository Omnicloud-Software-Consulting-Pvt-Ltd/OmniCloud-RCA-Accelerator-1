/**
 * What THIS org supports for ramps — decided only from its own Describe (never assumed from another org). Verified 2026-11-09:
 *  · p12 (v68): QuoteLineGroup.IsRamped / SegmentType / UnitPriceUplift / RampUpliftType createable → group ramps + compound.
 *  · p10 (v68): QuoteLineGroup.SegmentType read-only, IsRamped not createable, no RampUpliftType → NO group ramps there.
 *  · Both: ProductRampSegment createable; QuoteLineItem.RampIdentifier / SegmentType / UnitPriceUplift createable+updateable;
 *    QuoteLineItem.RampUpliftType (p12 only) is read-only; Quote.CalculationStatus / LastPricedDate read-only.
 */
export interface FieldCap { exists: boolean; createable: boolean; updateable: boolean; picklist: string[] }
export interface ObjectCap { exists: boolean; createable: boolean; updateable: boolean; fields: Record<string, FieldCap> }

export interface RampCapabilities {
  apiVersion: string;
  productRampSegment: { available: boolean; reason: string | null; segmentTypes: string[]; durationTypes: string[] };
  lineRamp: { available: boolean; reason: string | null; segmentTypes: string[] };
  groupRamp: { available: boolean; reason: string | null; segmentTypes: string[] };
  compound: { line: boolean; group: boolean; reason: string | null };
  pricing: { lastPricedDate: boolean; calculationStatus: boolean; appliedUplift: boolean };
  canRampField: { exists: boolean; updateable: boolean };
  usageModelField: boolean;
}

const f = (o: ObjectCap | undefined, name: string): FieldCap => o?.fields[name] ?? { exists: false, createable: false, updateable: false, picklist: [] };

export function deriveCapabilities(apiVersion: string, o: { Product2?: ObjectCap; ProductRampSegment?: ObjectCap; QuoteLineItem?: ObjectCap; QuoteLineGroup?: ObjectCap; Quote?: ObjectCap }): RampCapabilities {
  const prs = o.ProductRampSegment, qli = o.QuoteLineItem, qlg = o.QuoteLineGroup, q = o.Quote;
  const prsOk = !!prs?.exists && prs.createable && f(prs, "ProductId").createable && f(prs, "ProductSellingModelId").createable && f(prs, "SegmentType").createable;
  const lineFields = ["RampIdentifier", "SegmentType", "UnitPriceUplift"].filter(n => !f(qli, n).exists);
  const lineOk = !!qli?.exists && lineFields.length === 0;
  const groupNeed = ["IsRamped", "SegmentType", "StartDate", "EndDate"];
  const groupMissing = groupNeed.filter(n => !(f(qlg, n).createable || f(qlg, n).updateable));
  const groupOk = !!qlg?.exists && groupMissing.length === 0 && !!q?.exists;
  const compoundGroup = groupOk && (f(qlg, "RampUpliftType").createable || f(qlg, "RampUpliftType").updateable) && f(qlg, "RampUpliftType").picklist.includes("Compound");
  const compoundLine = f(qli, "RampUpliftType").updateable && f(qli, "RampUpliftType").picklist.includes("Compound");
  return {
    apiVersion,
    productRampSegment: {
      available: prsOk,
      reason: prsOk ? null : !prs?.exists ? "ProductRampSegment isn't available to your Salesforce user (needs Read/Create on Product Ramp Segment; Ramp Deals must be on in Revenue Settings)." : "Your Salesforce user can't create Product Ramp Segments (ProductId / ProductSellingModelId / SegmentType aren't createable).",
      segmentTypes: f(prs, "SegmentType").picklist, durationTypes: f(prs, "DurationType").picklist,
    },
    lineRamp: {
      available: lineOk,
      reason: lineOk ? null : !qli?.exists ? "QuoteLineItem isn't available." : `QuoteLineItem has no ${lineFields.join(", ")} in this org at ${apiVersion} — line ramps need Ramp Deals enabled.`,
      segmentTypes: f(qli, "SegmentType").picklist,
    },
    groupRamp: {
      available: groupOk,
      reason: groupOk ? null : !qlg?.exists ? "QuoteLineGroup isn't available to your user." : `QuoteLineGroup.${groupMissing.join(", ")} can't be written in this org — turn on "Ramp Deals for Groups" (and Clone Quote Line Groups) in Revenue Settings; Salesforce then exposes these fields.`,
      segmentTypes: f(qlg, "SegmentType").picklist,
    },
    compound: {
      line: compoundLine, group: compoundGroup,
      reason: compoundGroup ? (compoundLine ? null : "Compound uplift can be set on group ramps only — QuoteLineItem.RampUpliftType is read-only here.") : "RampUpliftType isn't writable on QuoteLineGroup in this org, so compound uplift can't be requested (Salesforce prices Standard).",
    },
    pricing: { lastPricedDate: f(q, "LastPricedDate").exists, calculationStatus: f(q, "CalculationStatus").exists, appliedUplift: f(qli, "ApplUnitPriceUpliftPct").exists },
    canRampField: { exists: f(o.Product2, "CanRamp").exists, updateable: f(o.Product2, "CanRamp").updateable },
    usageModelField: f(o.Product2, "UsageModelType").exists,
  };
}

/** Build an ObjectCap from a raw Salesforce describe body. */
export function objectCapFromDescribe(body: { createable?: boolean; updateable?: boolean; fields?: { name: string; createable?: boolean; updateable?: boolean; picklistValues?: { value: string; active?: boolean }[] }[] } | null): ObjectCap {
  if (!body || !Array.isArray(body.fields)) return { exists: false, createable: false, updateable: false, fields: {} };
  return {
    exists: true, createable: !!body.createable, updateable: !!body.updateable,
    fields: Object.fromEntries(body.fields.map(x => [x.name, { exists: true, createable: !!x.createable, updateable: !!x.updateable, picklist: (x.picklistValues ?? []).filter(p => p.active !== false).map(p => p.value) }])),
  };
}
