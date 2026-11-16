import { NextResponse, type NextRequest } from "next/server";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import { clearBillingStatsCache } from "@/lib/billing/server/stats";
import type { MutationOutcome } from "@/lib/billing/server/orderBilling";

/**
 * Shared POST handler for the Order Billing mutations (setup / activate / invoices / post):
 * existing session guard, JSON body, one service call, the app's standard error translation.
 */
export async function orderBillingMutation(
  req: NextRequest,
  run: (client: SalesforceClient, body: Record<string, unknown>) => Promise<MutationOutcome>,
  fallback: string,
): Promise<NextResponse> {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  try {
    const out = await run(auth.client, body);
    if (!out.ok) return NextResponse.json({ success: false, error: out.error, code: out.code, possibleCause: out.possibleCause ?? null, state: out.state ?? null, technical: out.technical ?? null }, { status: out.status });
    clearBillingStatsCache();
    return NextResponse.json({ success: true, message: out.message, state: out.state });
  } catch (err) {
    if (err instanceof Error && /^(Invalid Order Id|Order not found)/.test(err.message)) return NextResponse.json({ error: err.message, code: "NOT_FOUND" }, { status: 404 });
    return billingErrorResponse(err, fallback, { objectLabel: "Order" });
  }
}

export const tokenOf = (body: Record<string, unknown>) => (typeof body.stateToken === "string" ? body.stateToken : null);
