import { NextResponse, type NextRequest } from "next/server";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import { clearBillingStatsCache } from "@/lib/billing/server/stats";
import { BadInputError, NotFoundError, type PaymentInput, type PaymentOutcome } from "@/lib/billing/server/payments";
import { SalesforceCallError, friendlySalesforceError } from "@/lib/billing/server/billingDocuments";

export function knownError(err: unknown): NextResponse | null {
  if (err instanceof SalesforceCallError) {
    console.error("[billing] Salesforce call failed", { status: err.status, errors: err.errors });
    if (err.status === 401) return NextResponse.json({ error: "Your Salesforce session has expired. Please sign in again.", code: "TOKEN_EXPIRED" }, { status: 401 });
    return NextResponse.json({ error: friendlySalesforceError(err.errors[0] ?? { message: err.message }, "request"), code: err.errors[0]?.errorCode ?? "SALESFORCE_ERROR" }, { status: err.status === 403 ? 403 : err.status === 404 ? 404 : 502 });
  }
  if (err instanceof NotFoundError) return NextResponse.json({ error: err.message, code: "NOT_FOUND" }, { status: 404 });
  if (err instanceof BadInputError) return NextResponse.json({ error: err.message, code: "INVALID_REQUEST" }, { status: 400 });
  return null;
}

/** Shared handler for the payment read routes: existing session guard, one service call, consistent error mapping. */
export async function paymentRoute(req: NextRequest, run: (client: SalesforceClient) => Promise<unknown>, fallback: string): Promise<NextResponse> {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  try {
    return NextResponse.json(await run(auth.client));
  } catch (err) {
    return knownError(err) ?? billingErrorResponse(err, fallback, { objectLabel: "Payment" });
  }
}

/** Mutations return the PaymentOutcome with its own status (201 created, 200 duplicate, 409 stale/duplicate, 422 Salesforce rejection). */
export async function paymentMutation(req: NextRequest, run: (client: SalesforceClient, body: Record<string, unknown>) => Promise<PaymentOutcome>, fallback: string): Promise<NextResponse> {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body.", code: "INVALID_REQUEST" }, { status: 400 }); }
  try {
    const out = await run(auth.client, body);
    if (!out.ok) {
      return NextResponse.json({ success: false, error: out.error, code: out.code, possibleCause: out.possibleCause ?? null, invoice: out.invoice ?? null, preview: out.preview ?? null, payment: out.payment ?? null, technical: out.technical ?? null }, { status: out.status });
    }
    clearBillingStatsCache();
    return NextResponse.json({ success: true, duplicate: out.duplicate, message: out.message, payment: out.payment, invoice: out.invoice, applicationCreated: out.applicationCreated, steps: out.steps }, { status: out.status });
  } catch (err) {
    return knownError(err) ?? billingErrorResponse(err, fallback, { objectLabel: "Payment" });
  }
}

/** Settle Payment allocation rows from the browser — only line Ids and amounts; re-validated against Salesforce lines. */
export function allocationOf(v: unknown): { lineId: string; amount: number }[] | null {
  if (!Array.isArray(v)) return null;
  const rows = v.filter((r): r is Record<string, unknown> => !!r && typeof r === "object").map(r => ({ lineId: typeof r.lineId === "string" ? r.lineId : "", amount: typeof r.amount === "number" ? r.amount : Number(r.amount) }));
  if (rows.some(r => !r.lineId)) throw new BadInputError("Every allocation row needs an invoice line.");
  return rows.length ? rows : null;
}

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Only the user's choices come from the browser; every payment-critical value is re-resolved on the server. */
export function paymentInputOf(body: Record<string, unknown>): PaymentInput {
  const amount = typeof body.amount === "number" ? body.amount : typeof body.amount === "string" && body.amount.trim() ? Number(body.amount) : NaN;
  const invoiceId = s(body.invoiceId);
  if (!invoiceId) throw new BadInputError("Choose an invoice.");
  return {
    invoiceId, amount, paymentDate: s(body.paymentDate), paymentMethodId: s(body.paymentMethodId), status: s(body.status), type: s(body.type),
    comments: s(body.comments), invoiceToken: s(body.invoiceToken), idempotencyKey: s(body.idempotencyKey), allowSimilar: body.allowSimilar === true,
    level: body.level === "lines" ? "lines" : null, allocation: allocationOf(body.allocation),
  };
}
