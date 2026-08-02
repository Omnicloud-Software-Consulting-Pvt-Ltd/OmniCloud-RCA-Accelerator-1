import type {
  BundleComponent,
  BundleComponentGroupInfo,
  BundleTreeValidationResult,
  ProductAttribute,
  QuoteLineItemDraft,
  UnresolvedNode,
  UserSelectionRequired,
} from "@/lib/quotes/types";

/** Per-product info the validator needs beyond what's stored on the draft itself. */
export interface DraftValidationProductInfo {
  attributes: ProductAttribute[];
  requiresBillingFrequency: boolean;
  groups: BundleComponentGroupInfo[];
  candidates: BundleComponent[]; // this product's own direct bundle candidates (meaningful only when it's a bundle)
}

export type ProductInfoResolver = (productId: string) => DraftValidationProductInfo | null;

function pathLabel(path: string[]): string {
  return path.join(" → ");
}

function validateNode(
  node: QuoteLineItemDraft,
  path: string[],
  resolveInfo: ProductInfoResolver,
  unresolvedNodes: UnresolvedNode[],
  userSelectionsRequired: UserSelectionRequired[],
) {
  const info = resolveInfo(node.productId);

  if (info) {
    for (const attr of info.attributes) {
      if (!attr.required) continue;
      const value = node.attributeValues[attr.attributeId];
      if (value == null || value === "") {
        unresolvedNodes.push({ path, message: `${pathLabel(path)}: required attribute "${attr.name}" is not set.` });
      }
    }

    if (info.requiresBillingFrequency && !node.billingFrequency) {
      unresolvedNodes.push({ path, message: `${pathLabel(path)}: a billing frequency is required but none is set.` });
    }

    if (node.isBundleParent) {
      const byGroup = new Map<string, BundleComponent[]>();
      for (const c of info.candidates) {
        if (!c.groupId) continue;
        if (!byGroup.has(c.groupId)) byGroup.set(c.groupId, []);
        byGroup.get(c.groupId)!.push(c);
      }
      const selectedProductIds = new Set(node.children.map(c => c.productId));

      for (const group of info.groups) {
        const candidates = byGroup.get(group.id) ?? [];
        if (candidates.length === 0) continue;
        const selectedCount = candidates.filter(c => selectedProductIds.has(c.productId)).length;

        if (group.min != null && selectedCount < group.min) {
          unresolvedNodes.push({
            path,
            message: `${pathLabel(path)} → ${group.name}: requires at least ${group.min} component(s), ${selectedCount} selected.`,
          });
        } else if (group.min == null && selectedCount === 0) {
          userSelectionsRequired.push({
            path,
            groupId: group.id,
            groupName: group.name,
            min: 1,
            candidates: candidates.map(c => c.product).filter((p): p is NonNullable<typeof p> => !!p),
            currentlySelected: [],
          });
        }
      }
    }
  }

  for (const child of node.children) {
    validateNode(child, [...path, child.product.name], resolveInfo, unresolvedNodes, userSelectionsRequired);
  }
}

/**
 * Full-tree, depth-agnostic bundle validator (§5.4). Classifies every gap
 * into `unresolvedNodes` (confirmed-invalid org configuration — always
 * blocks) or `userSelectionsRequired` (a genuine unresolved choice — shown
 * in the UI, never a hard block). Must be re-run independently on the
 * server before any write (§2.6) — never trust a client-supplied "valid" flag.
 */
export function validateDraftTree(root: QuoteLineItemDraft, resolveInfo: ProductInfoResolver): BundleTreeValidationResult {
  const unresolvedNodes: UnresolvedNode[] = [];
  const userSelectionsRequired: UserSelectionRequired[] = [];
  validateNode(root, [root.product.name], resolveInfo, unresolvedNodes, userSelectionsRequired);
  return { valid: unresolvedNodes.length === 0, unresolvedNodes, userSelectionsRequired };
}

export function validateDraftForest(roots: QuoteLineItemDraft[], resolveInfo: ProductInfoResolver): BundleTreeValidationResult {
  const unresolvedNodes: UnresolvedNode[] = [];
  const userSelectionsRequired: UserSelectionRequired[] = [];
  for (const root of roots) {
    const result = validateDraftTree(root, resolveInfo);
    unresolvedNodes.push(...result.unresolvedNodes);
    userSelectionsRequired.push(...result.userSelectionsRequired);
  }
  return { valid: unresolvedNodes.length === 0, unresolvedNodes, userSelectionsRequired };
}

/** True only if every attribute, component group, and billing-frequency requirement at every depth already resolves — no dialog needed. */
export function canAutoApplyWithoutUserInput(root: QuoteLineItemDraft, resolveInfo: ProductInfoResolver): boolean {
  const result = validateDraftTree(root, resolveInfo);
  return result.unresolvedNodes.length === 0 && result.userSelectionsRequired.length === 0;
}
