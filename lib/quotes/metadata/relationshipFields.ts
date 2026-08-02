import type { SalesforceClient, DescribeResult, DescribeField } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import {
  resolveField,
  findReferenceFieldByTargetObject,
  findAllReferenceFieldsToTarget,
  findReferenceFieldByLabel,
  findRequiredCreateableFields,
  toFieldRef,
} from "@/lib/salesforce/describe";
import { createTTLCache } from "@/lib/salesforce/cache";
import { resolveQuoteLineItemFieldSchema } from "@/lib/quotes/metadata/lineItemFields";
import type { BundleObjectDiscovery, QuoteLineRelationshipFieldSchema } from "@/lib/quotes/types";

const WELL_KNOWN_RELATIONSHIP = "ProductRelatedComponent";
const WELL_KNOWN_GROUP = "ProductComponentGroup";

const bundleDiscoveryCache = createTTLCache<BundleObjectDiscovery>();

/**
 * Discover the org's bundle component-relationship / group / group-override
 * objects by schema shape (§2.4, §5.1) — never assumed by name beyond a
 * well-known-name fast path. `describeGlobal` is never cached on failure
 * (the cache helper enforces that); a transient failure here should surface
 * as "discovery inconclusive", not a permanently broken bundle feature.
 *
 * §CRITICAL BUG — Bundles treated as normal products: a discovery result
 * finding NOTHING (both relationshipObject and groupObject null) is only
 * ever cached transiently below, never for the full TTL — a "nothing
 * found" answer is far more likely to be a transient per-candidate Describe
 * failure than a permanent org fact, and getting stuck on a false negative
 * for 10 minutes during active testing is worse than re-checking each time.
 */
export async function resolveBundleObjectDiscovery(client: SalesforceClient): Promise<BundleObjectDiscovery> {
  const cached = bundleDiscoveryCache.get(client.instanceUrl);
  if (cached) return cached;

  const result = await computeBundleObjectDiscovery(client);
  if (result.relationshipObject || result.groupObject) {
    bundleDiscoveryCache.set(client.instanceUrl, result);
  }
  console.log(
    `[resolveBundleObjectDiscovery] relationshipObject=${result.relationshipObject ?? "none"} groupObject=${result.groupObject ?? "none"} ` +
    `candidatesConsidered=[${result.diagnostics.candidatesConsidered.join(", ")}] candidatesDescribed=[${result.diagnostics.candidatesDescribed.join(", ")}] ` +
    `candidatesFailed=[${result.diagnostics.candidatesFailed.join(", ")}] referenceCounts=${JSON.stringify(result.diagnostics.referenceCountsToProduct2)} reason="${result.diagnostics.reason}" ` +
    `parentProductField=${result.relationshipFields?.parentProductField?.apiName ?? "none"} childProductField=${result.relationshipFields?.childProductField?.apiName ?? "none"} ` +
    `isDefaultField=${result.relationshipFields?.isDefaultField?.apiName ?? "none (ungrouped components are always included regardless)"} ` +
    `isRequiredField=${result.relationshipFields?.isRequiredField?.apiName ?? "none (ungrouped components are always included regardless)"}`,
  );
  return result;
}

async function computeBundleObjectDiscovery(client: SalesforceClient): Promise<BundleObjectDiscovery> {
  // §Do not infer the relationship from object names: Product2's OWN
  // describe result lists, authoritatively, every OTHER object with a
  // direct foreign-key field pointing at it (`childRelationships`) — this
  // replaces the previous global-describe name-pattern sweep entirely. An
  // object literally cannot be a candidate bundle relationship/group object
  // without appearing here, so this can never miss a real candidate due to
  // an unexpected name, and can never falsely include an unrelated object
  // that merely has "component"/"bundle" in its name.
  const productDescribe = await describeObjectCached(client, "Product2");
  const product2ChildRelationships = (productDescribe.childRelationships ?? [])
    .filter(r => r.childSObject && r.field)
    .map(r => ({ childSObject: r.childSObject, field: r.field }));
  if (product2ChildRelationships.length === 0) {
    console.error("[resolveBundleObjectDiscovery] Product2 describe returned no childRelationships — cannot discover any bundle-related object without this relationship metadata (check API access to the full describe response).");
  }

  const fieldsByObject = new Map<string, string[]>();
  for (const rel of product2ChildRelationships) {
    const list = fieldsByObject.get(rel.childSObject) ?? [];
    list.push(rel.field);
    fieldsByObject.set(rel.childSObject, list);
  }
  const candidateNames = [...fieldsByObject.keys()];

  const candidatesDescribed: string[] = [];
  const candidatesFailed: string[] = [];
  const candidateDescribes = await Promise.all(
    candidateNames.map(async name => {
      try {
        const d = await describeObjectCached(client, name);
        candidatesDescribed.push(name);
        return d;
      } catch (err) {
        candidatesFailed.push(name);
        console.error(`[resolveBundleObjectDiscovery] Describe failed for candidate "${name}" (has a field referencing Product2 per Product2.childRelationships):`, err instanceof Error ? err.message : err);
        return null;
      }
    }),
  );
  const valid = candidateDescribes.filter((d): d is DescribeResult => d !== null);

  // Reference counts come directly from Product2's own relationship
  // metadata (how many DIFFERENT fields on this object point at Product2),
  // not by re-scanning each candidate's own field list.
  const referenceCountsToProduct2: Record<string, number> = {};
  for (const name of candidateNames) referenceCountsToProduct2[name] = (fieldsByObject.get(name) ?? []).length;

  // Classify by reference-field shape to Product2.
  let relationshipObject: DescribeResult | null =
    valid.find(d => d.name === WELL_KNOWN_RELATIONSHIP && referenceCountsToProduct2[d.name] >= 2) ?? null;
  if (!relationshipObject) {
    relationshipObject = valid.find(d => referenceCountsToProduct2[d.name] >= 2) ?? null;
  }

  let groupObject: DescribeResult | null =
    valid.find(d => d.name === WELL_KNOWN_GROUP && d.name !== relationshipObject?.name && referenceCountsToProduct2[d.name] === 1) ?? null;
  if (!groupObject) {
    groupObject = valid.find(d => d.name !== relationshipObject?.name && referenceCountsToProduct2[d.name] === 1) ?? null;
  }

  let groupOverrideObject: DescribeResult | null = null;
  if (groupObject) {
    groupOverrideObject =
      valid.find(
        d =>
          d.name !== relationshipObject?.name &&
          d.name !== groupObject?.name &&
          referenceCountsToProduct2[d.name] >= 1 &&
          findReferenceFieldByTargetObject(d, groupObject!.name) !== null,
      ) ?? null;
  }

  const relationshipFields = relationshipObject ? await resolveRelationshipFieldMapping(client, relationshipObject, groupObject) : null;

  const groupFields = groupObject
    ? {
        parentProductField: toFieldRef(findReferenceFieldByTargetObject(groupObject, "Product2")),
        minField: toFieldRef(resolveField(groupObject, "MinValue", /^min(imum)?( components)?$/i) ?? resolveField(groupObject, "MinimumComponents", /^minimum$/i)),
        maxField: toFieldRef(resolveField(groupObject, "MaxValue", /^max(imum)?( components)?$/i) ?? resolveField(groupObject, "MaximumComponents", /^maximum$/i)),
        nameField: toFieldRef(resolveField(groupObject, "Name", /^(group )?name$/i)),
      }
    : null;

  const groupOverrideFields = groupOverrideObject
    ? {
        groupField: toFieldRef(groupObject ? findReferenceFieldByTargetObject(groupOverrideObject, groupObject.name) : null),
        productField: toFieldRef(findReferenceFieldByTargetObject(groupOverrideObject, "Product2")),
        minField: toFieldRef(resolveField(groupOverrideObject, "MinValue", /^min(imum)?( components)?$/i)),
        maxField: toFieldRef(resolveField(groupOverrideObject, "MaxValue", /^max(imum)?( components)?$/i)),
      }
    : null;

  const reason = relationshipObject
    ? `Chosen relationshipObject="${relationshipObject.name}" (${referenceCountsToProduct2[relationshipObject.name]} field(s) referencing Product2 per Product2.childRelationships).`
    : candidateNames.length === 0
      ? "Product2.childRelationships returned no candidates at all — either this org's Product2 describe is missing relationship metadata, or genuinely nothing references Product2 directly."
      : valid.length === 0
        ? "Every candidate object (from Product2.childRelationships) failed to describe (see candidatesFailed) — a describe permission issue, not necessarily 'no bundles'."
        : `No candidate had >=2 fields referencing Product2 (found: ${JSON.stringify(referenceCountsToProduct2)}) — this org's bundle structure may link parent/child through an object shape this discovery doesn't yet recognize (e.g. child linked directly, parent linked only via an intermediate group object).`;

  return {
    relationshipObject: relationshipObject?.name ?? null,
    groupObject: groupObject?.name ?? null,
    groupOverrideObject: groupOverrideObject?.name ?? null,
    relationshipFields,
    groupFields,
    groupOverrideFields,
    diagnostics: {
      candidatesConsidered: candidateNames,
      candidatesDescribed,
      candidatesFailed,
      referenceCountsToProduct2,
      relationshipObjectChosen: relationshipObject?.name ?? null,
      groupObjectChosen: groupObject?.name ?? null,
      reason,
      product2ChildRelationships,
    },
  };
}

/**
 * Resolve the relationship object's parent-vs-child Product2 reference
 * fields. Both directions can be label-ambiguous (e.g. two fields both
 * labeled generically); when so, cross-check against the (unambiguous)
 * group object's own Product2 reference by sampling a handful of existing
 * rows and letting the empirical majority override a label-only guess —
 * a naive label guess has been observed wrong on a real org for this exact
 * field pair (§5.2).
 */
async function resolveRelationshipFieldMapping(
  client: SalesforceClient,
  relationshipObject: DescribeResult,
  groupObject: DescribeResult | null,
) {
  const productRefs = findAllReferenceFieldsToTarget(relationshipObject, "Product2");
  const byName = (name: string) => productRefs.find(f => f.name === name) ?? null;

  let parentProductField = byName("ParentProductId") ?? productRefs.find(f => /parent/i.test(f.label)) ?? null;
  let childProductField = byName("ChildProductId") ?? productRefs.find(f => /child/i.test(f.label) && f !== parentProductField) ?? null;

  if (productRefs.length >= 2 && (!parentProductField || !childProductField || parentProductField === childProductField)) {
    // Ambiguous by label — empirically sample rows and cross-check against the group object's parent ref.
    const groupParentField = groupObject ? findReferenceFieldByTargetObject(groupObject, "Product2") : null;
    const groupRelField = groupObject ? findReferenceFieldByTargetObject(relationshipObject, groupObject.name) : null;
    if (groupParentField && groupRelField) {
      try {
        const sample = await client.query<Record<string, unknown>>(
          `SELECT Id, ${productRefs.map(f => f.name).join(", ")}, ${groupRelField.name} FROM ${relationshipObject.name} LIMIT 20`,
        );
        const groupSample = await client.query<Record<string, unknown>>(
          `SELECT Id, ${groupParentField.name} FROM ${groupObject!.name} LIMIT 200`,
        );
        const groupParentIds = new Set(groupSample.records.map(r => r[groupParentField.name] as string).filter(Boolean));
        const matchCounts = new Map<string, number>();
        for (const field of productRefs) {
          let matches = 0;
          for (const row of sample.records) {
            const groupId = row[groupRelField.name] as string | undefined;
            if (!groupId) continue;
            // A field counts as "parent-shaped" when its value equals the
            // bundle root product that owns the group this row belongs to.
            if (groupParentIds.has(row[field.name] as string)) matches++;
          }
          matchCounts.set(field.name, matches);
        }
        const ranked = [...matchCounts.entries()].sort((a, b) => b[1] - a[1]);
        if (ranked.length >= 2 && ranked[0][1] > ranked[1][1]) {
          parentProductField = productRefs.find(f => f.name === ranked[0][0]) ?? parentProductField;
          childProductField = productRefs.find(f => f.name === ranked[1][0]) ?? childProductField;
        }
      } catch {
        // Inconclusive — keep the label-based guess rather than blocking discovery.
      }
    }
  }
  if (!childProductField) {
    childProductField = productRefs.find(f => f !== parentProductField) ?? null;
  }

  const groupField = groupObject ? findReferenceFieldByTargetObject(relationshipObject, groupObject.name) : null;
  const relationshipTypeField =
    resolveField(relationshipObject, "ProductRelationshipTypeId", /^relationship type$/i) ?? null;
  const pricingInclusionField =
    resolveField(relationshipObject, "IsComponentPriceIncluded", /^(is )?(component )?price included/i) ??
    resolveField(relationshipObject, "AssociatedQuoteLinePricing", /associated.*pricing|pricing.*inclusion/i) ??
    null;
  const pricingInclusionClassification = pricingInclusionField ? classifyPricingInclusionField(pricingInclusionField) : null;
  const quantityField = resolveField(relationshipObject, "Quantity", /^quantity$/i);
  // §Ungrouped components are fixed, not a choice — these two flags only ever
  // matter for narrowing which candidate(s) default-select WITHIN a real
  // component group. Resolved the same Describe-driven way as every other
  // field on this object; never fabricated, and gated on boolean type so a
  // same-named field of a different shape can't be misread as a flag.
  const isDefaultFieldRaw = resolveField(relationshipObject, "IsDefaultComponent", /^is default( component)?$/i);
  const isDefaultField = isDefaultFieldRaw?.type === "boolean" ? isDefaultFieldRaw : null;
  const isRequiredFieldRaw =
    resolveField(relationshipObject, "IsComponentRequired", /^is (component )?required$/i) ??
    resolveField(relationshipObject, "IsRequired", /^is required$/i);
  const isRequiredField = isRequiredFieldRaw?.type === "boolean" ? isRequiredFieldRaw : null;

  return {
    parentProductField: toFieldRef(parentProductField),
    childProductField: toFieldRef(childProductField),
    groupField: toFieldRef(groupField),
    relationshipTypeField: toFieldRef(relationshipTypeField),
    pricingInclusionField: toFieldRef(pricingInclusionField),
    pricingInclusionKind: pricingInclusionClassification?.kind ?? null,
    pricingInclusionIncludedValue: pricingInclusionClassification?.includedValue ?? null,
    pricingInclusionNotIncludedValue: pricingInclusionClassification?.notIncludedValue ?? null,
    quantityField: toFieldRef(quantityField),
    isDefaultField: toFieldRef(isDefaultField),
    isRequiredField: toFieldRef(isRequiredField),
  };
}

const qlrSchemaCache = createTTLCache<QuoteLineRelationshipFieldSchema>();

interface PricingInclusionClassification {
  kind: "boolean" | "picklist";
  includedValue: string | null;
  notIncludedValue: string | null;
}

/**
 * Classify a resolved pricing-inclusion field's real Describe shape (§Bundle
 * Pricing). Real Revenue Cloud orgs commonly expose this as the picklist
 * `AssociatedQuoteLinePricing` (active values like `IncludedInBundlePrice` /
 * `NotIncludedInBundlePrice`), not a boolean — so this app must be able to
 * pick the RIGHT active value from Describe's own active picklist values,
 * never fabricate one. Matches by value/label text (case/spacing-insensitive
 * "includ..." vs "not includ..."), which tolerates label wording differing
 * slightly across orgs without hardcoding a single exact literal.
 */
export function classifyPricingInclusionField(field: DescribeField): PricingInclusionClassification | null {
  if (field.type === "boolean") return { kind: "boolean", includedValue: null, notIncludedValue: null };
  if (field.type !== "picklist" || !field.picklistValues) return null;

  const active = field.picklistValues.filter(v => v.active);
  const notIncluded = active.find(v => /not[\s_-]?includ/i.test(v.value) || /not[\s_-]?includ/i.test(v.label));
  const included = active.find(v => v !== notIncluded && /includ/i.test(v.value)) ?? active.find(v => v !== notIncluded && /includ/i.test(v.label));
  if (!included) return null; // can't identify the "included" value with confidence — caller must degrade, never guess
  return { kind: "picklist", includedValue: included.value, notIncludedValue: notIncluded?.value ?? null };
}

/**
 * Resolve the native mechanism for representing a QuoteLineItem
 * parent/child bundle link (§5.5), in preference order: dedicated
 * relationship object > QuoteLineItem self-reference > unsupported.
 *
 * §CRITICAL BUG — invalid ProductRelatedComponentId on QuoteLineRelationship
 * create: this result used to be cached unconditionally via
 * qlrSchemaCache.getOrCompute, unlike resolveBundleObjectDiscovery's own
 * cache (above), which explicitly refuses to cache a "nothing found"
 * result. A transient Describe hiccup that left `relatedComponentField`
 * null (even though this org DOES have a relationshipObject and should
 * have resolved one) would get stuck in the cache for the full TTL —
 * every bundle-relationship create in that window would then silently
 * skip writing the component reference, and any code path resolving a
 * candidate id through a DIFFERENT, unmapped fallback field could end up
 * writing an id of the wrong object type into whatever field WAS mapped.
 * Mirrors bundleDiscoveryCache's guard: only cache a resolution that isn't
 * plausibly a transient failure.
 */
export async function resolveQuoteLineRelationshipSchema(
  client: SalesforceClient,
  bundleDiscovery: BundleObjectDiscovery,
): Promise<QuoteLineRelationshipFieldSchema> {
  const cached = qlrSchemaCache.get(client.instanceUrl);
  if (cached) return cached;

  const result = await computeQuoteLineRelationshipSchema(client, bundleDiscovery);
  const inconclusive =
    result.mechanism === "unsupported" ||
    (result.mechanism === "relationship-object" && !!bundleDiscovery.relationshipObject && !result.relatedComponentField);
  if (!inconclusive) {
    qlrSchemaCache.set(client.instanceUrl, result);
  }
  return result;
}

async function computeQuoteLineRelationshipSchema(
  client: SalesforceClient,
  bundleDiscovery: BundleObjectDiscovery,
): Promise<QuoteLineRelationshipFieldSchema> {
  {
    let describe: DescribeResult | null = null;
    try {
      describe = await describeObjectCached(client, "QuoteLineRelationship");
    } catch {
      describe = null;
    }

    if (describe) {
      // Write targets (used to create QuoteLineRelationship rows) — must gate on createable.
      const qliRefs = findAllReferenceFieldsToTarget(describe, "QuoteLineItem", { requireCreateable: true });
      const mainQuoteLineField =
        qliRefs.find(f => /^quote line item$/i.test(f.label)) ??
        qliRefs.find(f => /main|primary/i.test(f.label)) ??
        qliRefs[0] ?? null;
      const associatedQuoteLineField =
        qliRefs.find(f => /associated|related|component|child/i.test(f.label) && f !== mainQuoteLineField) ??
        qliRefs.find(f => f !== mainQuoteLineField) ?? null;

      if (mainQuoteLineField && associatedQuoteLineField) {
        const relatedComponentField = bundleDiscovery.relationshipObject
          ? findReferenceFieldByTargetObject(describe, bundleDiscovery.relationshipObject)
          : null;
        const quantityScaleMethodField = resolveField(describe, "QuantityScaleMethod", /^quantity scale method$/i);
        const relationshipTypeField =
          resolveField(describe, "ProductRelationshipTypeId", /^relationship type$/i) ?? findReferenceFieldByLabel(describe, /relationship type/i);
        // Well-known-name-first: try the boolean shape some orgs use, then the
        // real Revenue Cloud picklist name, then fall back to a label pattern
        // covering either shape — never assume which one this org has.
        const pricingInclusionField =
          resolveField(describe, "IsComponentPriceIncluded", /price included/i) ??
          resolveField(describe, "AssociatedQuoteLinePricing", /associated.*pricing|pricing.*inclusion/i);
        const pricingInclusionClassification = pricingInclusionField ? classifyPricingInclusionField(pricingInclusionField) : null;

        const mapped = new Set(
          [mainQuoteLineField, associatedQuoteLineField, relatedComponentField, quantityScaleMethodField, relationshipTypeField, pricingInclusionField]
            .filter((f): f is NonNullable<typeof f> => !!f)
            .map(f => f.name),
        );
        const requiredFieldsNotMapped = findRequiredCreateableFields(describe)
          .filter(f => !mapped.has(f.name))
          .map(f => toFieldRef(f)!)
          ;

        return {
          mechanism: "relationship-object",
          objectName: describe.name,
          mainQuoteLineField: toFieldRef(mainQuoteLineField),
          associatedQuoteLineField: toFieldRef(associatedQuoteLineField),
          relatedComponentField: toFieldRef(relatedComponentField),
          quantityScaleMethodField: toFieldRef(quantityScaleMethodField),
          relationshipTypeField: toFieldRef(relationshipTypeField),
          pricingInclusionField: toFieldRef(pricingInclusionField),
          pricingInclusionKind: pricingInclusionClassification?.kind ?? null,
          pricingInclusionIncludedValue: pricingInclusionClassification?.includedValue ?? null,
          pricingInclusionNotIncludedValue: pricingInclusionClassification?.notIncludedValue ?? null,
          requiredFieldsNotMapped,
        };
      }
    }

    // Mechanism B: QuoteLineItem self-reference (Root/Parent Item).
    const qliSchema = await resolveQuoteLineItemFieldSchema(client);
    if (qliSchema.rootItemField || qliSchema.parentItemField) {
      return {
        mechanism: "self-reference",
        objectName: "QuoteLineItem",
        mainQuoteLineField: qliSchema.rootItemField,
        associatedQuoteLineField: qliSchema.parentItemField,
        relatedComponentField: null,
        quantityScaleMethodField: null,
        relationshipTypeField: null,
        pricingInclusionField: null,
        pricingInclusionKind: null,
        pricingInclusionIncludedValue: null,
        pricingInclusionNotIncludedValue: null,
        requiredFieldsNotMapped: [],
      };
    }

    return {
      mechanism: "unsupported",
      objectName: null,
      mainQuoteLineField: null,
      associatedQuoteLineField: null,
      relatedComponentField: null,
      quantityScaleMethodField: null,
      relationshipTypeField: null,
      pricingInclusionField: null,
      pricingInclusionKind: null,
      pricingInclusionIncludedValue: null,
      pricingInclusionNotIncludedValue: null,
      requiredFieldsNotMapped: [],
    };
  }
}

export { soqlEscape };
