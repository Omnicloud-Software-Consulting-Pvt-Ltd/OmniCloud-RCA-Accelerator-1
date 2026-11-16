/**
 * Quote → Order (reprice first, then createOrderFromQuote) against a small in-memory Salesforce — MOCKED; nothing here talks to
 * Salesforce. The fake behaves like the org: createOrderFromQuote rejects a quote Salesforce hasn't priced with the real
 * INVALID_OPERATION message, and Place Sales Transaction (pricingPref "Force") prices the quote asynchronously.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RampApi } from "@/lib/ramp/server/api";
import { createOrderFromQuote, ensureQuotePriced, pricingVerdict, withQuoteLock } from "./createOrder";

const QUOTE = "0Q0A00000000001AAA";
const PLACE = "/connect/rev/sales-transaction/actions/place";
const STALE_MSG = "We couldn't create the order because the prices aren't updated. Click Reprice All and try again.";

type Pricing = "priced" | "async" | "rejects" | "calcFails" | "noop" | "never";

function fakeApi(o: {
  lines?: number; existing?: boolean; reject?: string; missingAction?: boolean; lateReads?: number;
  calc?: string; lastPriced?: string | null; lineChanged?: string | null; status?: string;
  pricing?: Pricing; asyncReads?: number; staleRejectsOnce?: boolean;
} = {}) {
  const quote = { CalculationStatus: o.calc ?? "CompletedWithPricing", LastPricedDate: o.lastPriced === undefined ? "2026-11-12T10:00:00.000Z" : o.lastPriced, Status: o.status ?? "Draft" };
  const lineChanged = o.lineChanged === undefined ? "2026-11-12T10:00:00.000Z" : o.lineChanged;
  const orders: Record<string, unknown>[] = o.existing ? [{ Id: "801A00000000009AAA", OrderNumber: "00000009", Status: "Draft", TotalAmount: 50, CreatedDate: "2026-11-01", OrderItems: { totalSize: 1 } }] : [];
  const posts: { path: string; body: unknown }[] = [];
  let late = o.lateReads ?? 0, created = false, pendingReads = 0, staleOnce = !!o.staleRejectsOnce;
  const priced = () => ["CompletedWithPricing", "CompletedWithTax", "TaxCalculationSuccess"].includes(quote.CalculationStatus) && !!quote.LastPricedDate
    && (!lineChanged || Date.parse(lineChanged) <= Date.parse(quote.LastPricedDate!) + 5000);
  const api: RampApi = {
    apiVersion: "v68.0", instanceUrl: "https://fake.my.salesforce.com",
    describe: async (n: string) => (n === "Quote" ? { fields: [{ name: "CalculationStatus" }, { name: "LastPricedDate" }] } : null),
    query: async <T,>(q: string) => {
      if (/FROM Quote WHERE/.test(q) && /CalculationStatus/.test(q)) {
        if (pendingReads > 0 && --pendingReads === 0) Object.assign(quote, { CalculationStatus: "CompletedWithPricing", LastPricedDate: new Date().toISOString() });
        return [{ Id: QUOTE, ...quote }] as T[];
      }
      if (/FROM Quote WHERE/.test(q)) return [{ Id: QUOTE, Name: "Big Deal", QuoteNumber: "00000042", Status: quote.Status }] as T[];
      if (/LastModifiedDate FROM QuoteLineItem/.test(q)) return (lineChanged ? [{ LastModifiedDate: lineChanged }] : []) as T[];
      if (/COUNT\(Id\)/.test(q)) return [{ total: o.lines ?? 2 }] as T[];
      if (/FROM Order WHERE QuoteId/.test(q)) {
        if (created && late-- <= 0 && !orders.length) orders.push({ Id: "801A00000000010AAA", OrderNumber: "00000010", Status: "Draft", TotalAmount: 120, CreatedDate: "2026-11-12", OrderItems: { totalSize: 2 } });
        return orders as T[];
      }
      return [] as T[];
    },
    call: async (_method, path, body) => {
      posts.push({ path, body });
      if (path === PLACE) {
        const mode = o.pricing ?? "priced";
        if (mode === "rejects") return { status: 400, body: [{ errorCode: "INVALID_INPUT", message: "Pricing procedure failed: missing price book entry." }] };
        if (mode === "calcFails") { quote.CalculationStatus = "PriceCalculationFailed"; return { status: 201, body: { success: true } }; }
        if (mode === "noop") return { status: 201, body: { success: true } };
        if (mode === "never") { quote.CalculationStatus = "QueuedForPricing"; return { status: 201, body: { success: true } }; }
        if (mode === "async") { quote.CalculationStatus = "QueuedForPricing"; pendingReads = o.asyncReads ?? 3; return { status: 201, body: { success: true } }; }
        Object.assign(quote, { CalculationStatus: "CompletedWithPricing", LastPricedDate: new Date().toISOString() });
        return { status: 201, body: { success: true } };
      }
      if (o.missingAction) return { status: 404, body: [{ errorCode: "NOT_FOUND", message: "action not found" }] };
      if (o.reject) return { status: 400, body: [{ isSuccess: false, errors: [{ statusCode: "INVALID_INPUT", message: o.reject }] }] };
      if (!priced() || staleOnce) {
        staleOnce = false;
        return { status: 400, body: [{ isSuccess: false, errors: [{ statusCode: "INVALID_OPERATION", message: STALE_MSG }] }] };
      }
      created = true;
      return { status: 200, body: [{ isSuccess: true, outputValues: { requestId: "REQ-1" } }] };
    },
  };
  return { api, posts, quote };
}
const deps = { sleep: (ms: number) => new Promise<void>(r => setTimeout(r, Math.min(ms, 5))), waitMs: 0, repriceBudgetMs: 400 };
const placeCalls = (posts: { path: string }[]) => posts.filter(p => p.path === PLACE).length;
const orderCalls = (posts: { path: string }[]) => posts.filter(p => p.path === "/actions/standard/createOrderFromQuote").length;

test("existing behavior: an already-priced quote creates its order without repricing, read back from Salesforce", async () => {
  const { api, posts } = fakeApi();
  const r = await createOrderFromQuote(api, QUOTE, deps);
  assert.ok(r.ok && r.created && r.order?.orderNumber === "00000010" && r.order.id === "801A00000000010AAA");
  assert.match(r.ok ? r.message : "", /read back from Salesforce/);
  assert.deepEqual(posts, [{ path: "/actions/standard/createOrderFromQuote", body: { inputs: [{ quoteRecordId: QUOTE }] } }], "no reprice request for a fresh quote");
  assert.ok(r.ok && r.pricing && !r.pricing.repriced);
});

test("the reported bug: an unpriced quote (CalculationStatus NotStarted) is repriced by Salesforce first, then the order is created", async () => {
  const { api, posts } = fakeApi({ calc: "NotStarted", lastPriced: null });
  const r = await createOrderFromQuote(api, QUOTE, deps);
  assert.ok(r.ok && r.created && r.order?.id === "801A00000000010AAA", JSON.stringify(r));
  assert.deepEqual(posts.map(p => p.path), [PLACE, "/actions/standard/createOrderFromQuote"], "Reprice All (Place Sales Transaction) strictly before createOrderFromQuote");
  assert.deepEqual((posts[0].body as { pricingPref: string }).pricingPref, "Force");
  assert.ok(r.ok && r.pricing?.repriced);
});

test("a line edited after the last pricing counts as stale and is repriced first", async () => {
  const { api, posts } = fakeApi({ lastPriced: "2026-11-12T10:00:00.000Z", lineChanged: "2026-11-13T09:00:00.000Z" });
  const r = await createOrderFromQuote(api, QUOTE, deps);
  assert.ok(r.ok && r.created);
  assert.equal(placeCalls(posts), 1);
});

test("asynchronous repricing: waits while Salesforce is QueuedForPricing, then creates the order", async () => {
  const { api, posts } = fakeApi({ calc: "NotStarted", lastPriced: null, pricing: "async", asyncReads: 4 });
  const r = await createOrderFromQuote(api, QUOTE, { ...deps, repriceBudgetMs: 2000 });
  assert.ok(r.ok && r.created, JSON.stringify(r));
  assert.equal(placeCalls(posts), 1, "one pricing request, then polling — never a second request");
});

test("repricing failure stops everything: Salesforce's error is returned and createOrderFromQuote is never called", async () => {
  for (const [pricing, code] of [["rejects", "REPRICE_FAILED"], ["calcFails", "REPRICE_FAILED"]] as const) {
    const { api, posts } = fakeApi({ calc: "NotStarted", lastPriced: null, pricing });
    const r = await createOrderFromQuote(api, QUOTE, deps);
    assert.ok(!r.ok && r.code === code, `${pricing}: ${JSON.stringify(r)}`);
    assert.equal(orderCalls(posts), 0, `${pricing}: no order attempted`);
    if (pricing === "rejects") assert.match(r.ok ? "" : r.error, /missing price book entry/);
  }
});

test("repricing timeout: Salesforce still pricing after the time limit → REPRICE_TIMEOUT, no order", async () => {
  const { api, posts } = fakeApi({ calc: "NotStarted", lastPriced: null, pricing: "never" });
  const r = await createOrderFromQuote(api, QUOTE, { ...deps, repriceBudgetMs: 150 });
  assert.ok(!r.ok && r.code === "REPRICE_TIMEOUT" && r.status === 504);
  assert.equal(orderCalls(posts), 0);
});

test("a quote Salesforce is already pricing is waited for — no second pricing request is sent", async () => {
  const { api, posts } = fakeApi({ calc: "PriceCalculationInProgress", lastPriced: null });
  const r = await ensureQuotePriced(api, QUOTE, { ...deps, repriceBudgetMs: 150 });
  assert.ok(!r.ok && r.code === "REPRICE_TIMEOUT");
  assert.equal(placeCalls(posts), 0);
});

test("still stale after repricing (Salesforce accepted but saved no new prices) → QUOTE_PRICES_STALE, no order", async () => {
  const { api, posts } = fakeApi({ calc: "NotStarted", lastPriced: null, pricing: "noop" });
  const r = await createOrderFromQuote(api, QUOTE, deps);
  assert.ok(!r.ok && r.code === "QUOTE_PRICES_STALE", JSON.stringify(r));
  assert.match(r.ok ? "" : r.error, /still aren.t current/);
  assert.equal(orderCalls(posts), 0);
});

test("Salesforce says 'prices aren't updated' despite a fresh-looking quote → one forced reprice and one retry", async () => {
  const { api, posts } = fakeApi({ staleRejectsOnce: true });
  const r = await createOrderFromQuote(api, QUOTE, deps);
  assert.ok(r.ok && r.created, JSON.stringify(r));
  assert.deepEqual(posts.map(p => p.path), ["/actions/standard/createOrderFromQuote", PLACE, "/actions/standard/createOrderFromQuote"]);
});

test("Salesforce rejection during order creation (not pricing-related) is returned as SALESFORCE_REJECTED", async () => {
  const r = await createOrderFromQuote(fakeApi({ reject: "Quote must be Approved before ordering." }).api, QUOTE, deps);
  assert.ok(!r.ok && r.code === "SALESFORCE_REJECTED" && /Quote must be Approved/.test(r.error));
});

test("one order per quote: an existing order is returned, nothing sent (no reprice either)", async () => {
  const { api, posts } = fakeApi({ existing: true, calc: "NotStarted", lastPriced: null });
  const r = await createOrderFromQuote(api, QUOTE, deps);
  assert.ok(r.ok && !r.created && r.order?.orderNumber === "00000009");
  assert.equal(posts.length, 0);
});

test("repeated clicks: a second request for the same quote while one runs gets CREATE_IN_PROGRESS — only one order", async () => {
  const { api, posts } = fakeApi({ calc: "NotStarted", lastPriced: null, pricing: "async", asyncReads: 3 });
  const key = `${api.instanceUrl}|${QUOTE}`;
  const run = () => withQuoteLock(key, () => createOrderFromQuote(api, QUOTE, { ...deps, repriceBudgetMs: 2000 }));
  const [a, b] = await Promise.all([run(), run()]);
  const results = [a, b];
  assert.equal(results.filter(r => !r.ok && r.code === "CREATE_IN_PROGRESS").length, 1);
  assert.equal(results.filter(r => r.ok && "created" in r && r.created).length, 1);
  assert.equal(orderCalls(posts), 1);
  const again = await run();
  assert.ok(again.ok && "created" in again && !again.created, "a later retry opens the existing order");
});

test("refusals: no lines, rejected/denied quotes, a missing action, an order not yet readable — never reported as created", async () => {
  const empty = fakeApi({ lines: 0 });
  const e = await createOrderFromQuote(empty.api, QUOTE, deps);
  assert.ok(!e.ok && e.code === "QUOTE_HAS_NO_LINES");
  assert.equal(empty.posts.length, 0);
  for (const status of ["Rejected", "Denied"]) {
    const q = fakeApi({ status });
    const r = await createOrderFromQuote(q.api, QUOTE, deps);
    assert.ok(!r.ok && r.code === "QUOTE_NOT_ORDERABLE");
    assert.equal(q.posts.length, 0);
  }
  const miss = await createOrderFromQuote(fakeApi({ missingAction: true }).api, QUOTE, deps);
  assert.ok(!miss.ok && miss.code === "ACTION_UNAVAILABLE");
  const pending = await createOrderFromQuote(fakeApi({ lateReads: 5 }).api, QUOTE, deps);
  assert.ok(pending.ok && "pending" in pending && pending.pending && pending.order === null, "accepted but not readable yet → 'pending', not 'created'");
});

test("pricing verdict uses Salesforce's own fields only", () => {
  assert.equal(pricingVerdict({ calculationStatus: "CompletedWithPricing", lastPricedDate: "2026-11-12T10:00:00Z", lastLineChange: "2026-11-12T10:00:03Z" }).kind, "fresh");
  assert.equal(pricingVerdict({ calculationStatus: "NotStarted", lastPricedDate: null, lastLineChange: null }).kind, "stale");
  assert.equal(pricingVerdict({ calculationStatus: "CompletedWithPricing", lastPricedDate: null, lastLineChange: null }).kind, "stale");
  assert.equal(pricingVerdict({ calculationStatus: "QueuedForPricing", lastPricedDate: null, lastLineChange: null }).kind, "busy");
  assert.equal(pricingVerdict({ calculationStatus: "PriceCalculationFailed", lastPricedDate: null, lastLineChange: null }).kind, "failed");
  assert.equal(pricingVerdict({ calculationStatus: "CompletedWithPricing", lastPricedDate: "2026-11-12T10:00:00Z", lastLineChange: null }, "2026-11-13T00:00:00Z").kind, "stale", "must be priced AFTER our request");
});

test("Quotes UI has no Create Order button (removed from quote completion and the opened quote); the route still requires confirmation", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  for (const p of ["components/data/quotes/CreateQuoteFlow.tsx", "components/data/quotes/QuoteWorkspace.tsx"]) {
    assert.ok(!/CreateOrderButton/.test(src(p)), `${p} no longer renders the Create Order button`);
  }
  assert.equal(existsSync(join(process.cwd(), "components/data/quotes/CreateOrderButton.tsx")), false);
  const route = src("app/api/quotes/[id]/create-order/route.ts");
  assert.match(route, /if \(body\.confirmed !== true\) return/);
  assert.match(route, /withQuoteLock\(/);
});
