import type { SalesforceClient, DescribeResult } from "@/lib/salesforce/client";
import { describeObjectCached, resolveField, findReferenceFieldByTargetObject, findPicklistFieldByLabel, toFieldRef } from "@/lib/salesforce/describe";
import type { QuoteLineAdjustmentDiscovery } from "@/lib/quotes/types";

/**
 * §Discount pricing investigation (Phase 2) — discover whether this org
 * represents a manual, line-level price adjustment ("Percentage-Based
 * (Line-Level)" in Salesforce's own Calculation Details panel) as a
 * DISTINCT related object, the same way bundle relationship/group objects
 * are discovered (lib/quotes/metadata/relationshipFields.ts): via
 * QuoteLineItem's own Describe `childRelationships` — every object with a
 * real foreign-key field pointing at QuoteLineItem, authoritatively, never
 * a guessed object name. This is DIAGNOSTIC ONLY: nothing in this app writes
 * to whatever object this discovers. The app's actual fix for discounted
 * pricing routes through the standard, already-persisted QuoteLineItem.
 * Discount field plus Salesforce's own documented Instant Pricing repricing
 * call (lib/quotes/pricing/reprice.ts) — never a create call against an
 * object this discovery merely suspects exists.
 *
 * A candidate is scored by field SHAPE, never by name alone (beyond a
 * "contains adjust" naming hint used only to break ties): a genuine
 * candidate must have a creatable reference field to QuoteLineItem, plus at
 * least one of (a) a percentage-shaped numeric field, or (b) a generic
 * "Value" field alongside a Type/Method picklist that could discriminate
 * Percentage vs Amount.
 */
export async function resolveQuoteLineAdjustmentDiscovery(client: SalesforceClient): Promise<QuoteLineAdjustmentDiscovery> {
  const qliDescribe = await describeObjectCached(client, "QuoteLineItem");
  const childRelationships = (qliDescribe.childRelationships ?? []).filter(r => r.childSObject && r.field);

  const candidatesConsidered = [...new Set(childRelationships.map(r => r.childSObject))];
  const candidatesDescribed: string[] = [];
  const candidatesFailed: string[] = [];

  if (candidatesConsidered.length === 0) {
    return {
      objectName: null, quoteLineItemField: null, percentField: null, amountField: null, valueField: null,
      typeField: null, typePercentageValue: null, levelField: null, levelLineValue: null,
      diagnostics: {
        candidatesConsidered: [], candidatesDescribed: [], candidatesFailed: [],
        reason: "QuoteLineItem describe returned no childRelationships — cannot discover any related adjustment object without this relationship metadata.",
        fieldEvidence: [],
      },
    };
  }

  const describes = await Promise.all(
    candidatesConsidered.map(async name => {
      try {
        const d = await describeObjectCached(client, name);
        candidatesDescribed.push(name);
        return d;
      } catch (err) {
        candidatesFailed.push(name);
        console.error(`[resolveQuoteLineAdjustmentDiscovery] Describe failed for candidate "${name}":`, err instanceof Error ? err.message : err);
        return null;
      }
    }),
  );
  const valid = describes.filter((d): d is DescribeResult => d !== null);

  interface Candidate {
    describe: DescribeResult;
    qliField: ReturnType<typeof findReferenceFieldByTargetObject>;
    percentField: ReturnType<typeof resolveField>;
    amountField: ReturnType<typeof resolveField>;
    valueField: ReturnType<typeof resolveField>;
    typeField: ReturnType<typeof findPicklistFieldByLabel>;
    levelField: ReturnType<typeof findPicklistFieldByLabel>;
    score: number;
  }

  const candidates: Candidate[] = valid.map(d => {
    const qliField = findReferenceFieldByTargetObject(d, "QuoteLineItem", { requireCreateable: true });
    const percentField = resolveField(d, "AdjustmentPercent", /percent/i);
    const amountField = resolveField(d, "AdjustmentAmount", /adjustment amount|^amount$/i);
    const valueField = resolveField(d, "Value", /^(adjustment )?value$/i);
    const typeField = findPicklistFieldByLabel(d, "AdjustmentType", /adjustment type|^type$|method/i);
    const levelField = findPicklistFieldByLabel(d, "AdjustmentLevel", /adjustment level|^level$|scope/i);

    let score = 0;
    if (qliField) score += 10; // mandatory anchor — without this it cannot represent a per-line adjustment at all
    if (percentField) score += 3;
    if (amountField) score += 2;
    if (valueField && typeField) score += 3;
    if (/adjust/i.test(d.name)) score += 1; // naming hint only, never decisive on its own
    return { describe: d, qliField, percentField, amountField, valueField, typeField, levelField, score };
  });

  const scored = candidates.filter(c => c.qliField && c.score > 10); // must have the anchor AND at least one real pricing-shaped signal
  scored.sort((a, b) => b.score - a.score);
  const chosen = scored[0] ?? null;

  if (!chosen) {
    return {
      objectName: null, quoteLineItemField: null, percentField: null, amountField: null, valueField: null,
      typeField: null, typePercentageValue: null, levelField: null, levelLineValue: null,
      diagnostics: {
        candidatesConsidered, candidatesDescribed, candidatesFailed,
        reason: candidates.length === 0
          ? "Every candidate object referencing QuoteLineItem failed to describe."
          : `No candidate had a createable QuoteLineItem reference plus a percent/amount/value+type field shape (considered: ${candidates.map(c => `${c.describe.name}[qli=${!!c.qliField},pct=${!!c.percentField},amt=${!!c.amountField},val=${!!c.valueField},type=${!!c.typeField}]`).join(", ")}). This org's manual line-level adjustment is most likely represented via the standard QuoteLineItem.Discount field directly (see lib/quotes/pricing/reprice.ts), not a distinct child object.`,
        fieldEvidence: candidates.flatMap(c => c.describe.fields.map(f => ({
          objectName: c.describe.name, apiName: f.name, label: f.label, type: f.type,
          createable: !!f.createable, updateable: !!f.updateable, calculated: !!f.calculated,
        }))),
      },
    };
  }

  const typePercentageValue = chosen.typeField?.activeOptions.find(o => /percent/i.test(o.value) || /percent/i.test(o.label))?.value ?? null;
  const levelLineValue = chosen.levelField?.activeOptions.find(o => /^line/i.test(o.value) || /^line/i.test(o.label))?.value ?? null;

  return {
    objectName: chosen.describe.name,
    quoteLineItemField: toFieldRef(chosen.qliField),
    percentField: toFieldRef(chosen.percentField),
    amountField: toFieldRef(chosen.amountField),
    valueField: toFieldRef(chosen.valueField),
    typeField: toFieldRef(chosen.typeField?.field ?? null),
    typePercentageValue,
    levelField: toFieldRef(chosen.levelField?.field ?? null),
    levelLineValue,
    diagnostics: {
      candidatesConsidered, candidatesDescribed, candidatesFailed,
      reason: `Chosen objectName="${chosen.describe.name}" (score ${chosen.score}) — candidates considered: ${candidates.map(c => `${c.describe.name}(${c.score})`).join(", ")}.`,
      fieldEvidence: chosen.describe.fields.map(f => ({
        objectName: chosen.describe.name, apiName: f.name, label: f.label, type: f.type,
        createable: !!f.createable, updateable: !!f.updateable, calculated: !!f.calculated,
      })),
    },
  };
}
