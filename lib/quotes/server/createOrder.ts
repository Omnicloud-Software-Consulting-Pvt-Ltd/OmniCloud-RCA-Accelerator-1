import type { RampApi } from "@/lib/ramp/server/api";
import { connectFailed, sfMessage, soql } from "@/lib/ramp/server/api";
import { QUOTE_BUSY, QUOTE_FAILED, QUOTE_PRICED } from "@/lib/ramp/execution";
import { repriceQuote, type RunDeps } from "@/lib/ramp/server/runner";

/**
 * Quote → Order with Salesforce's own standard action createOrderFromQuote (Revenue Cloud), so the order carries EVERYTHING on the
 * quote exactly as Salesforce maps it — account, price book, lines (products, quantities, prices, discounts, selling models, billing
 * frequency, bundle structure), dates, Bill-To / addresses, contract and opportunity links. The app never copies fields by hand.
 *  · one order per quote: an order that already exists for the quote (Order.QuoteId) is returned instead of creating a second one;
 *  · the quote must be PRICED by Salesforce first — createOrderFromQuote rejects an unpriced/stale quote with INVALID_OPERATION
 *    ("prices aren't updated. Click Reprice All"). ensureQuotePriced() does that "Reprice All" through Salesforce's own pricing:
 *    one Place Sales Transaction request with pricingPref "Force" (the app's shared repricing, lib/ramp/server/runner.ts), waits for
 *    Salesforce's asynchronous pricing to finish, and re-reads the quote. Prices are never written by the app — Quote.CalculationStatus
 *    and LastPricedDate are read-only and only Salesforce's pricing engine sets them;
 *  · success only after the new order is READ BACK from Salesforce; Salesforce's own error message otherwise.
 */

export const CREATE_ORDER_ACTION = "createOrderFromQuote";

export interface QuoteOrder { id: string; orderNumber: string | null; status: string | null; totalAmount: number | null; itemCount: number; createdDate: string | null }

export interface QuotePricingState { calculationStatus: string | null; lastPricedDate: string | null; lastLineChange: string | null }
export interface PricingResult { repriced: boolean; message: string; state: QuotePricingState }

export type CreateOrderOutcome =
  | { ok: true; created: boolean; order: QuoteOrder; message: string; pricing?: PricingResult }
  | { ok: true; created: true; pending: true; order: null; message: string; pricing?: PricingResult }
  | { ok: false; status: number; code: string; error: string; pricing?: Partial<PricingResult> };

export interface CreateOrderDeps {
  sleep: (ms: number) => Promise<void>;
  /** How long to wait for the new order to become readable after Salesforce accepts the request. */
  waitMs?: number;
  /** Total time allowed for Salesforce to finish repricing before giving up (no order is created then). */
  repriceBudgetMs?: number;
  now?: () => string;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
/** A line saved within this window of LastPricedDate counts as priced (Salesforce stamps both in the same save). */
const CLOCK_SLACK_MS = 5000;
const REPRICE_BUDGET_MS = 90_000;
const NOT_ORDERABLE = /^(rejected|denied)$/i;
const STALE_PRICES = /prices? (aren'?t|are not) (updated|up to date)|reprice/i;

/** Orders already created from this quote (newest first). Read-only. */
export async function ordersFromQuote(api: RampApi, quoteId: string): Promise<QuoteOrder[]> {
  const rows = await api.query<Row>(`SELECT Id, OrderNumber, Status, TotalAmount, CreatedDate, (SELECT Id FROM OrderItems) FROM Order WHERE QuoteId = ${soql(quoteId)} ORDER BY CreatedDate DESC LIMIT 10`);
  return rows.map(r => ({ id: String(r.Id), orderNumber: str(r.OrderNumber), status: str(r.Status), totalAmount: num(r.TotalAmount), createdDate: str(r.CreatedDate), itemCount: ((r.OrderItems as { totalSize?: number; records?: unknown[] } | null)?.totalSize ?? (r.OrderItems as { records?: unknown[] } | null)?.records?.length ?? 0) }));
}

/* ── Pricing state (read-only) ── */

export async function readQuotePricing(api: RampApi, quoteId: string): Promise<QuotePricingState> {
  const [q] = await api.query<Row>(`SELECT Id, CalculationStatus, LastPricedDate FROM Quote WHERE Id = ${soql(quoteId)} LIMIT 1`);
  const [line] = await api.query<Row>(`SELECT LastModifiedDate FROM QuoteLineItem WHERE QuoteId = ${soql(quoteId)} ORDER BY LastModifiedDate DESC LIMIT 1`);
  return { calculationStatus: str(q?.CalculationStatus), lastPricedDate: str(q?.LastPricedDate), lastLineChange: str(line?.LastModifiedDate) };
}

export type PricingVerdict = { kind: "fresh" | "busy" | "failed" | "stale"; reason: string };

/** Fresh = Salesforce priced the quote (priced CalculationStatus + LastPricedDate) and no line changed after that pricing. */
export function pricingVerdict(s: QuotePricingState, pricedAfter?: string): PricingVerdict {
  const cs = s.calculationStatus ?? "unknown";
  if (QUOTE_BUSY.includes(s.calculationStatus ?? "")) return { kind: "busy", reason: `Salesforce is still processing the quote (CalculationStatus ${cs}).` };
  if (QUOTE_FAILED.includes(s.calculationStatus ?? "")) return { kind: "failed", reason: `Salesforce reports a failed calculation (CalculationStatus ${cs}).` };
  if (!QUOTE_PRICED.includes(s.calculationStatus ?? "")) return { kind: "stale", reason: `The quote hasn't been priced by Salesforce (CalculationStatus ${cs}).` };
  if (!s.lastPricedDate) return { kind: "stale", reason: "The quote has no LastPricedDate." };
  const priced = Date.parse(s.lastPricedDate);
  if (pricedAfter && priced < Date.parse(pricedAfter) - CLOCK_SLACK_MS) return { kind: "stale", reason: `Salesforce hasn't saved new prices yet (LastPricedDate ${s.lastPricedDate}).` };
  if (s.lastLineChange && Date.parse(s.lastLineChange) > priced + CLOCK_SLACK_MS) return { kind: "stale", reason: `A quote line changed (${s.lastLineChange}) after the last pricing (${s.lastPricedDate}).` };
  return { kind: "fresh", reason: `Priced by Salesforce (CalculationStatus ${cs}, LastPricedDate ${s.lastPricedDate}).` };
}

/* ── Reprice through Salesforce and wait for it ── */

export type EnsurePricedOutcome = ({ ok: true } & PricingResult) | { ok: false; status: number; code: string; error: string; state: QuotePricingState | null; repriced: boolean };

async function waitWhileBusy(api: RampApi, quoteId: string, until: number, sleep: (ms: number) => Promise<void>, pricedAfter?: string): Promise<{ state: QuotePricingState; verdict: PricingVerdict }> {
  for (;;) {
    const state = await readQuotePricing(api, quoteId);
    const verdict = pricingVerdict(state, pricedAfter);
    if (verdict.kind !== "busy" || Date.now() >= until) return { state, verdict };
    await sleep(2000);
  }
}

/**
 * Makes sure Salesforce has priced the quote before an order is created from it. Already fresh → nothing is sent. Salesforce busy →
 * waits (never sends a second request). Otherwise ONE Place Sales Transaction (pricingPref "Force") request, then waits and re-reads.
 * `force` reprices even when the quote looks fresh (used when Salesforce itself says the prices aren't updated).
 */
export async function ensureQuotePriced(api: RampApi, quoteId: string, deps: CreateOrderDeps, opts: { force?: boolean } = {}): Promise<EnsurePricedOutcome> {
  const until = Date.now() + (deps.repriceBudgetMs ?? REPRICE_BUDGET_MS);
  const timeoutError = (state: QuotePricingState, repriced: boolean): EnsurePricedOutcome => ({ ok: false, status: 504, code: "REPRICE_TIMEOUT", repriced, state,
    error: `Salesforce is still pricing the quote (CalculationStatus ${state.calculationStatus ?? "unknown"}). No order was created — try Create Order again in a minute; the pricing already requested will be used.` });

  let { state, verdict } = await waitWhileBusy(api, quoteId, until, deps.sleep);
  if (verdict.kind === "busy") return timeoutError(state, false);
  if (verdict.kind === "fresh" && !opts.force) return { ok: true, repriced: false, message: `Quote already priced — ${verdict.reason}`, state };

  const now = deps.now ?? (() => new Date().toISOString());
  const runDeps: RunDeps = { now, sleep: deps.sleep, waitMs: Math.max(0, until - Date.now()) };
  const r = await repriceQuote(api, quoteId, runDeps);
  // Salesforce refused the pricing request itself → REPRICE_FAILED with its message. Anything it accepted is judged below from the
  // re-read quote (failed calculation → REPRICE_FAILED, still not current → QUOTE_PRICES_STALE, still running → REPRICE_TIMEOUT).
  const sent = r.calls[0];
  if (!sent || connectFailed(sent.status, sent.response)) {
    return { ok: false, status: 422, code: "REPRICE_FAILED", repriced: false, state: await readQuotePricing(api, quoteId).catch(() => null),
      error: `Salesforce couldn't reprice the quote, so no order was created. ${r.message}` };
  }
  // Re-read the authoritative quote; wait out any remaining asynchronous pricing within the budget.
  ({ state, verdict } = await waitWhileBusy(api, quoteId, until, deps.sleep, r.requestedAt));
  if (verdict.kind === "busy") return timeoutError(state, true);
  if (verdict.kind === "failed") return { ok: false, status: 422, code: "REPRICE_FAILED", repriced: true, state, error: `${verdict.reason} No order was created — check the quote's pricing (lines, price book, pricing procedure) and try again.` };
  if (verdict.kind === "stale") return { ok: false, status: 422, code: "QUOTE_PRICES_STALE", repriced: true, state, error: `Salesforce accepted the reprice request but the quote's prices still aren't current: ${verdict.reason} No order was created.` };
  return { ok: true, repriced: true, message: `Quote repriced by Salesforce — ${verdict.reason}`, state };
}

/* ── One Create Order at a time per quote (repeated clicks / retries) ── */

const inFlight = new Set<string>();

/** Runs `fn` unless the same quote is already being processed by this server; then reports CREATE_IN_PROGRESS instead. */
export async function withQuoteLock<T>(key: string, fn: () => Promise<T>): Promise<T | { ok: false; status: 409; code: "CREATE_IN_PROGRESS"; error: string }> {
  if (inFlight.has(key)) return { ok: false, status: 409, code: "CREATE_IN_PROGRESS", error: "This quote is already being repriced or converted to an order. Wait for it to finish — a second order won't be created." };
  inFlight.add(key);
  try { return await fn(); } finally { inFlight.delete(key); }
}

/* ── Create the order ── */

export async function createOrderFromQuote(api: RampApi, quoteId: string, deps: CreateOrderDeps): Promise<CreateOrderOutcome> {
  const [quote] = await api.query<Row>(`SELECT Id, Name, QuoteNumber, Status FROM Quote WHERE Id = ${soql(quoteId)}`);
  if (!quote) return { ok: false, status: 404, code: "QUOTE_NOT_FOUND", error: "This quote no longer exists or isn't visible to your user." };
  const label = str(quote.QuoteNumber) ?? str(quote.Name) ?? quoteId;

  // Idempotent: an order already created from this quote is returned — no repricing, no second order.
  const existing = await ordersFromQuote(api, quoteId);
  if (existing.length) return { ok: true, created: false, order: existing[0], message: `Quote ${label} already has order ${existing[0].orderNumber ?? existing[0].id} (${existing[0].status ?? "status unknown"}) — opened it instead of creating a second order.` };

  if (NOT_ORDERABLE.test(str(quote.Status) ?? "")) return { ok: false, status: 422, code: "QUOTE_NOT_ORDERABLE", error: `Quote ${label} is ${quote.Status} — an order can't be created from a ${String(quote.Status).toLowerCase()} quote.` };

  const [{ total }] = await api.query<{ total: number }>(`SELECT COUNT(Id) total FROM QuoteLineItem WHERE QuoteId = ${soql(quoteId)}`).catch(() => [{ total: -1 }]);
  if (total === 0) return { ok: false, status: 422, code: "QUOTE_HAS_NO_LINES", error: `Quote ${label} has no line items — add products before creating an order.` };

  // Salesforce must have priced the quote first (its own "Reprice All"), or createOrderFromQuote rejects it.
  let pricing = await ensureQuotePriced(api, quoteId, deps);
  if (!pricing.ok) return { ok: false, status: pricing.status, code: pricing.code, error: pricing.error, pricing: { repriced: pricing.repriced, state: pricing.state ?? undefined } };

  const callAction = () => api.call("POST", `/actions/standard/${CREATE_ORDER_ACTION}`, { inputs: [{ quoteRecordId: quoteId }] });
  const rejection = (r: { status: number; body: unknown }) => {
    const res = Array.isArray(r.body) ? (r.body[0] as { isSuccess?: boolean; errors?: unknown; outputValues?: Row } | undefined) : undefined;
    return r.status >= 300 || !res || res.isSuccess === false ? { res, message: sfMessage(res?.errors ?? r.body, `HTTP ${r.status}`) } : { res, message: null };
  };

  let r = await callAction();
  if (r.status === 404) return { ok: false, status: 501, code: "ACTION_UNAVAILABLE", error: `This org has no ${CREATE_ORDER_ACTION} action (Revenue Cloud) at this API version — the order can't be created from the quote.` };
  let rej = rejection(r);
  if (rej.message && STALE_PRICES.test(rej.message)) {
    // Salesforce still considers the prices out of date: reprice once more (forced) and retry once.
    pricing = await ensureQuotePriced(api, quoteId, deps, { force: true });
    if (!pricing.ok) return { ok: false, status: pricing.status, code: pricing.code, error: pricing.error, pricing: { repriced: pricing.repriced, state: pricing.state ?? undefined } };
    r = await callAction();
    rej = rejection(r);
    if (rej.message && STALE_PRICES.test(rej.message)) {
      return { ok: false, status: 422, code: "QUOTE_PRICES_STALE", pricing, error: `Salesforce still says the quote's prices aren't updated after repricing, so no order was created: ${rej.message}` };
    }
  }
  if (rej.message) return { ok: false, status: 422, code: "SALESFORCE_REJECTED", pricing, error: `Salesforce didn't create the order: ${rej.message}` };
  const res = rej.res!;

  // Read the order back (Salesforce may finish creating it a moment after answering).
  const until = Date.now() + (deps.waitMs ?? 20_000);
  for (;;) {
    const orders = await ordersFromQuote(api, quoteId);
    if (orders.length) return { ok: true, created: true, order: orders[0], pricing, message: `Order ${orders[0].orderNumber ?? orders[0].id} created from quote ${label} (${orders[0].status ?? "status unknown"}, ${orders[0].itemCount} order product(s)) — read back from Salesforce.` };
    if (Date.now() >= until) return { ok: true, created: true, pending: true, order: null, pricing, message: `Salesforce accepted the request${str(res.outputValues?.requestId) ? ` (${res.outputValues!.requestId})` : ""} but the order isn't readable yet — refresh in a moment.` };
    await deps.sleep(2000);
  }
}
