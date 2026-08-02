import type { QuoteLineItemDraft } from "@/lib/quotes/types";

/** The only local pricing formula (§4.6) — never auto-derived by QuoteLineItem itself. */
export function netUnitPrice(listPrice: number, discountPercent: number): number {
  return listPrice * (1 - discountPercent / 100);
}

export function lineTotal(quantity: number, unitPrice: number): number {
  return quantity * unitPrice;
}

/** Display-only line total: suppressed to 0 when the parent bundle's price already includes this child (§4.6, §5.6). Never affects the create payload. */
export function displayLineTotal(draft: QuoteLineItemDraft): number {
  if (draft.pricingInclusion) return 0;
  return lineTotal(draft.quantity, netUnitPrice(draft.unitPrice, draft.discountPercent));
}

export function flattenDraftTree(roots: QuoteLineItemDraft[]): QuoteLineItemDraft[] {
  const flat: QuoteLineItemDraft[] = [];
  const walk = (nodes: QuoteLineItemDraft[]) => {
    for (const node of nodes) {
      flat.push(node);
      walk(node.children);
    }
  };
  walk(roots);
  return flat;
}

/** Running Quote Summary total across the full bundle-aware, flattened set of pending line items (§4.6). */
export function sumDraftTreeTotal(roots: QuoteLineItemDraft[]): number {
  return flattenDraftTree(roots).reduce((sum, draft) => sum + displayLineTotal(draft), 0);
}
