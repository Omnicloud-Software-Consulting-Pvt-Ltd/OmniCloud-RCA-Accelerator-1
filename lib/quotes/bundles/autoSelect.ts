import type { BundleComponent, BundleComponentGroupInfo, CatalogProduct, QuoteLineItemDraft } from "@/lib/quotes/types";

/**
 * Default-selection rule for one Product Component Group's candidates
 * (§5.3). Only falls back to "ask the user" when a choice is genuinely
 * ambiguous and unresolvable from org data — everything else resolves a
 * sensible default automatically.
 */
function selectForGroup(candidates: BundleComponent[], group: BundleComponentGroupInfo | null): BundleComponent[] {
  if (candidates.length === 0) return [];

  // A component with no ProductComponentGroupId is not a "choice" — Salesforce
  // Revenue Cloud has no concept of an ungrouped-yet-optional bundle
  // component. IsDefault/IsRequired only exist to narrow a selection WITHIN a
  // real component group; they are frequently left unpopulated on fixed
  // components since there's no choice to flag. An ungrouped component is
  // therefore always a fixed part of the bundle's structure and must always
  // be included, never gated on those flags.
  if (!group) {
    return candidates;
  }

  const flagged = candidates.filter(c => c.isDefault || c.isRequired);
  const min = group.min;

  if (flagged.length > 0) {
    if (min != null && min > flagged.length) {
      const remaining = candidates.filter(c => !flagged.includes(c));
      const need = min - flagged.length;
      return [...flagged, ...remaining.slice(0, Math.max(0, need))];
    }
    return flagged;
  }

  if (candidates.length === 1) return candidates; // no real choice exists

  if (min != null && min >= candidates.length) return candidates; // mathematically forced

  const n = min ?? 1; // genuine ambiguous choice — auto-pick the first N (org-returned order)
  return candidates.slice(0, n);
}

/** Auto-select which of a bundle's direct components should default into the pending line-item tree (§5.3). */
export function autoSelectComponents(components: BundleComponent[], groups: BundleComponentGroupInfo[]): BundleComponent[] {
  const byGroup = new Map<string | null, BundleComponent[]>();
  for (const c of components) {
    const key = c.groupId;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(c);
  }

  const selected: BundleComponent[] = [];
  for (const [groupId, candidates] of byGroup) {
    const group = groupId ? (groups.find(g => g.id === groupId) ?? candidates[0]?.group ?? null) : null;
    selected.push(...selectForGroup(candidates, group));
  }
  return selected;
}

let draftIdCounter = 0;
function nextDraftId(): string {
  draftIdCounter += 1;
  return `draft-${Date.now()}-${draftIdCounter}`;
}

function defaultAttributeValues(component: BundleComponent): Record<string, string> {
  const values: Record<string, string> = {};
  for (const attr of component.attributes) {
    if (attr.defaultValue != null) values[attr.attributeId] = attr.defaultValue;
  }
  return values;
}

/** Convert one resolved bundle component into a draft node, recursing into its own auto-selected children. */
function componentToDraft(component: BundleComponent, parentDraftId: string): QuoteLineItemDraft {
  const draftId = nextDraftId();
  const selectedChildren = autoSelectComponents(component.children, component.childGroups);
  return {
    draftId,
    productId: component.productId,
    product: component.product as CatalogProduct, // callers only reach here for pricebookStatus === "resolved"
    parentDraftId,
    componentGroupId: component.groupId,
    relatedComponentId: component.relationshipId,
    relationshipTypeId: component.relationshipTypeId,
    quantity: component.quantity || 1,
    discountPercent: 0,
    unitPrice: component.product?.listPrice ?? 0,
    billingFrequency: component.billingFrequency?.value ?? null,
    subscriptionTerm: component.subscriptionTerm?.value ?? null,
    // §Never send a synthetic option id to Salesforce — see toDirectOption in lib/quotes/catalog/sellingModel.ts.
    sellingModelOptionId: (component.sellingModel?.chosen && !component.sellingModel.chosen.isSynthetic) ? component.sellingModel.chosen.id : null,
    sellingModelId: component.sellingModel?.chosen?.sellingModelId ?? null,
    attributeValues: defaultAttributeValues(component),
    pricingInclusion: component.pricingInclusion,
    pricebookStatus: component.pricebookStatus,
    isBundleParent: component.isBundle,
    children: selectedChildren.filter(c => c.pricebookStatus === "resolved").map(c => componentToDraft(c, draftId)),
    sellingModelName: component.sellingModel?.chosen?.name ?? null,
    sellingModelType: component.sellingModel?.chosen?.type ?? null,
    billingFrequencySource: component.billingFrequency?.source ?? null,
    billingTreatmentOutcome: component.billingTreatment?.outcome ?? null,
  };
}

/** Build the auto-selected child draft subtree for a newly-added bundle product (§5.3, §5.7 — every result stays independently editable). */
export function buildAutoSelectedDraftChildren(components: BundleComponent[], groups: BundleComponentGroupInfo[], parentDraftId: string): QuoteLineItemDraft[] {
  const selected = autoSelectComponents(components, groups).filter(c => c.pricebookStatus === "resolved");
  return selected.map(c => componentToDraft(c, parentDraftId));
}

/**
 * Build child drafts from an explicit user-confirmed selection at this
 * level (the configurator dialog only asks about genuinely ambiguous
 * top-level groups, §5.3) — deeper nested levels still resolve via their
 * own auto-select pass inside `componentToDraft`.
 */
export function buildDraftChildrenFromSelection(components: BundleComponent[], selectedProductIds: Set<string>, parentDraftId: string): QuoteLineItemDraft[] {
  return components
    .filter(c => selectedProductIds.has(c.productId) && c.pricebookStatus === "resolved")
    .map(c => componentToDraft(c, parentDraftId));
}

export function createRootDraft(product: CatalogProduct, isBundleParent: boolean): QuoteLineItemDraft {
  return {
    draftId: nextDraftId(),
    productId: product.id,
    product,
    parentDraftId: null,
    componentGroupId: null,
    relatedComponentId: null,
    relationshipTypeId: null,
    quantity: 1,
    discountPercent: 0,
    unitPrice: product.listPrice,
    billingFrequency: null,
    subscriptionTerm: null,
    sellingModelOptionId: null,
    sellingModelId: null,
    attributeValues: {},
    pricingInclusion: false,
    pricebookStatus: "resolved",
    isBundleParent,
    children: [],
    sellingModelName: null,
    sellingModelType: null,
    billingFrequencySource: null,
    billingTreatmentOutcome: null,
  };
}
