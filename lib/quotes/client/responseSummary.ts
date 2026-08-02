import type { SalesforceResponseSummary } from "@/lib/quotes/types";

/**
 * Accumulating "what has the app actually done this session" store (§3.8) —
 * every preview panel reads from this ONE place instead of re-deriving
 * facts independently, so the summary and the JSON/log views can never
 * disagree with each other.
 */

let summary: SalesforceResponseSummary = { quote: null, lineItems: null, bundleResult: null, repricing: null };
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function subscribeResponseSummary(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getResponseSummarySnapshot(): SalesforceResponseSummary {
  return summary;
}

export function updateResponseSummary(patch: Partial<SalesforceResponseSummary>): void {
  summary = { ...summary, ...patch };
  notify();
}

export function resetResponseSummary(): void {
  summary = { quote: null, lineItems: null, bundleResult: null, repricing: null };
  notify();
}
