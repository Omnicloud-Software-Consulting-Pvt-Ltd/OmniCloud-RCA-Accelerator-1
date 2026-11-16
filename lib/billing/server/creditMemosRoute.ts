import { NextResponse, type NextRequest } from "next/server";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import { clearBillingStatsCache } from "@/lib/billing/server/stats";
import { BadInputError } from "@/lib/billing/server/payments";
import { allocationOf, knownError } from "@/lib/billing/server/paymentsRoute";
import type { CreditInput } from "@/lib/billing/server/creditMemos";

type Outcome = { ok: boolean; status: number } & Record<string, unknown>;

/** Shared handler for credit memo mutations: existing session guard, JSON body, one service call, consistent errors. */
export async function creditMutation(req: NextRequest, run: (client: SalesforceClient, body: Record<string, unknown>) => Promise<Outcome>, fallback: string): Promise<NextResponse> {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body.", code: "INVALID_REQUEST" }, { status: 400 }); }
  try {
    const { ok, status, ...rest } = await run(auth.client, body);
    if (ok) clearBillingStatsCache();
    return NextResponse.json({ success: ok, ...rest }, { status });
  } catch (err) {
    return knownError(err) ?? billingErrorResponse(err, fallback, { objectLabel: "Billing document" });
  }
}

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Only the user's choices come from the browser; invoice, lines, balances and allowable amounts are re-read server-side. */
export function creditInputOf(body: Record<string, unknown>): CreditInput {
  const invoiceId = s(body.invoiceId);
  if (!invoiceId) throw new BadInputError("Choose an invoice.");
  const amount = typeof body.amount === "number" ? body.amount : typeof body.amount === "string" && body.amount.trim() ? Number(body.amount) : NaN;
  return { invoiceId, amount, allocation: allocationOf(body.allocation), taxStrategy: s(body.taxStrategy), effectiveDate: s(body.effectiveDate), description: s(body.description), invoiceToken: s(body.invoiceToken), idempotencyKey: s(body.idempotencyKey) };
}
