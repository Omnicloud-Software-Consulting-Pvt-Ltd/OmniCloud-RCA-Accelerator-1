/**
 * Shared by the Quote and Order product catalogs to mark rows as "already
 * added" (§Product Catalog "Added" state). Works on any tree shaped like a
 * draft/line-item forest — QuoteLineItemDraft, OrderLineItemDraft,
 * ExistingQuoteLineItem, ExistingOrderItem all qualify — so the same
 * function covers pending (session-only) and persisted (Salesforce) line
 * items, root products and bundle children alike, regardless of product
 * type (simple, bundle parent/child, subscription, usage, one-time).
 */
interface ProductNode {
  productId: string;
  children: ProductNode[];
}

/** Every distinct productId anywhere in the forest — roots AND every nested bundle child. */
export function collectAllProductIds<T extends ProductNode>(nodes: T[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: ProductNode[]) => {
    for (const node of list) {
      ids.add(node.productId);
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}
