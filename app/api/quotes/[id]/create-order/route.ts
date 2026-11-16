import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { latestApiVersion } from "@/lib/billing/server/billingDocuments";
import { rampApiFor } from "@/lib/ramp/server/api";
import { createOrderFromQuote, ensureQuotePriced, ordersFromQuote, withQuoteLock } from "@/lib/quotes/server/createOrder";

type Params = { params: Promise<{ id: string }> };
const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/** This request's Salesforce session at the org's newest API version (standard actions are versioned). */
async function apiFor(req: NextRequest) {
  const base = requireSFClient(req);
  if ("unauthorized" in base) return { unauthorized: base.unauthorized };
  const version = await latestApiVersion(base.client);
  const auth = version === base.client.apiVersion ? base : requireSFClient(req, version);
  if ("unauthorized" in auth) return { unauthorized: auth.unauthorized };
  return { api: rampApiFor(auth.client, version), instanceUrl: auth.client.instanceUrl };
}

// GET /api/quotes/[id]/create-order — orders already created from this quote (read-only), so the UI shows "Open order" instead of
// offering a second one.
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!ID.test(id)) return NextResponse.json({ success: false, error: "Invalid quote Id." }, { status: 400 });
  try {
    const a = await apiFor(req);
    if ("unauthorized" in a) return a.unauthorized;
    return NextResponse.json({ success: true, instanceUrl: a.instanceUrl, orders: await ordersFromQuote(a.api, id) });
  } catch (err) { return sfErrorResponse(err, "Couldn't read the quote's orders"); }
}

// POST /api/quotes/[id]/create-order { confirmed: true, step?: "prepare" } — writes to Salesforce, so the UI sends `confirmed`
// only from its confirmation dialog.
//  · step "prepare": make sure Salesforce has priced the quote (Reprice All through Place Sales Transaction, waited for and re-read)
//    — lets the UI show "Repricing quote…" as its own stage;
//  · default: create the order with Salesforce's createOrderFromQuote — it re-checks pricing itself (repricing if needed), so it
//    never depends on the browser having called "prepare" first.
// One request per quote at a time on this server: a repeated click gets CREATE_IN_PROGRESS instead of a second order.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!ID.test(id)) return NextResponse.json({ success: false, error: "Invalid quote Id." }, { status: 400 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) ?? {}; } catch { /* empty body */ }
  if (body.confirmed !== true) return NextResponse.json({ success: false, error: "Creating an order writes to Salesforce — confirm it first (confirmed: true).", code: "CONFIRMATION_REQUIRED" }, { status: 400 });
  const deps = { sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)) };
  try {
    const a = await apiFor(req);
    if ("unauthorized" in a) return a.unauthorized;
    const out = await withQuoteLock(`${a.instanceUrl}|${id}`, async () => {
      if (body.step === "prepare") {
        const existing = await ordersFromQuote(a.api, id);
        if (existing.length) return { ok: true as const, prepared: true, alreadyOrdered: true, message: "This quote already has an order — no repricing needed." };
        const p = await ensureQuotePriced(a.api, id, deps);
        return p.ok ? { ok: true as const, prepared: true, repriced: p.repriced, message: p.message, pricing: p } : p;
      }
      return createOrderFromQuote(a.api, id, deps);
    });
    if (!out.ok) return NextResponse.json({ success: false, error: out.error, code: out.code, ...("pricing" in out && out.pricing ? { pricing: out.pricing } : {}) }, { status: out.status });
    return NextResponse.json({ success: true, instanceUrl: a.instanceUrl, ...out });
  } catch (err) { return sfErrorResponse(err, "Couldn't create the order from the quote"); }
}
