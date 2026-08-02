import type { QuoteLineItemDraft } from "@/lib/quotes/types";

/** Immutably patch one node (by draftId) anywhere in a draft forest (§4.7 — every auto-selected child stays independently editable). */
export function updateDraftNode(roots: QuoteLineItemDraft[], draftId: string, patch: Partial<QuoteLineItemDraft>): QuoteLineItemDraft[] {
  return roots.map(node => {
    if (node.draftId === draftId) return { ...node, ...patch };
    if (node.children.length === 0) return node;
    return { ...node, children: updateDraftNode(node.children, draftId, patch) };
  });
}

/** Remove one node (and its whole subtree) from a draft forest by draftId (§4.7). */
export function removeDraftNode(roots: QuoteLineItemDraft[], draftId: string): QuoteLineItemDraft[] {
  return roots
    .filter(node => node.draftId !== draftId)
    .map(node => (node.children.length === 0 ? node : { ...node, children: removeDraftNode(node.children, draftId) }));
}

export function findDraftNode(roots: QuoteLineItemDraft[], draftId: string): QuoteLineItemDraft | null {
  for (const node of roots) {
    if (node.draftId === draftId) return node;
    const found = findDraftNode(node.children, draftId);
    if (found) return found;
  }
  return null;
}

/** Find an existing root draft with the given productId (used to bump quantity instead of duplicating a row, §4.7). */
export function findRootByProductId(roots: QuoteLineItemDraft[], productId: string): QuoteLineItemDraft | null {
  return roots.find(r => r.productId === productId) ?? null;
}
