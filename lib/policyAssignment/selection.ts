import { MAX_BULK_PRODUCTS, resolvedProductIds, type BulkProductResult, type EligibleProduct } from "@/lib/policyAssignment/types";

/**
 * Selection state for the Bulk Product Assignment card. Keyed by product Id and independent of what's on screen, so a selection
 * survives searching, filtering and loading more pages. Immutable helpers (React state friendly).
 */
export type Selection = ReadonlyMap<string, EligibleProduct>;

export const emptySelection = (): Selection => new Map();

export function toggle(sel: Selection, p: EligibleProduct): Selection {
  const next = new Map(sel);
  if (next.has(p.id)) next.delete(p.id); else if (next.size < MAX_BULK_PRODUCTS) next.set(p.id, p);
  return next;
}

/** Add every given product (e.g. the visible page, or "Select All Eligible"), up to the per-request cap. */
export function selectMany(sel: Selection, products: EligibleProduct[]): Selection {
  const next = new Map(sel);
  for (const p of products) { if (next.size >= MAX_BULK_PRODUCTS) break; next.set(p.id, p); }
  return next;
}

export function deselectMany(sel: Selection, products: EligibleProduct[]): Selection {
  const next = new Map(sel);
  for (const p of products) next.delete(p.id);
  return next;
}

/** "all" / "some" / "none" of these products are selected — drives the header checkbox. */
export function pageState(sel: Selection, products: EligibleProduct[]): "all" | "some" | "none" {
  const n = products.filter(p => sel.has(p.id)).length;
  return n === 0 ? "none" : n === products.length ? "all" : "some";
}

/** After an assignment: drop everything that's settled (assigned / already assigned / ineligible) from the list and the selection; keep failures selected so they can be retried. */
export function applyResults(list: EligibleProduct[], sel: Selection, results: BulkProductResult[]): { list: EligibleProduct[]; selection: Selection } {
  const settled = resolvedProductIds(results);
  const next = new Map(sel);
  for (const id of settled) next.delete(id);
  return { list: list.filter(p => !settled.has(p.id)), selection: next };
}

/** Append a newly loaded page without duplicates (keyset pages never overlap, but a refresh might). */
export function mergePage(list: EligibleProduct[], page: EligibleProduct[]): EligibleProduct[] {
  const seen = new Set(list.map(p => p.id));
  return [...list, ...page.filter(p => !seen.has(p.id))];
}

/** Request key for the eligible-products list: the selected policy + search + reload counter. */
export const listKeyFor = (policyId: string, q: string, reloadToken: number) => `${policyId}|${q}|${reloadToken}`;

/**
 * The loaded list state ONLY if it belongs to the current request key — a response for a previously selected policy (its
 * products, its Tax Treatment, its resolved Tax Code) is never shown after the policy changes; the page shows loading instead.
 */
export function currentFor<T extends { key: string }>(state: T | null, key: string): T | null {
  return state && state.key === key ? state : null;
}
