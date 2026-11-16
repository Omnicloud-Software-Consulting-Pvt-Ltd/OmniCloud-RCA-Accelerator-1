import { NextRequest, NextResponse } from "next/server";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { loadOrderBilling } from "@/lib/billing/server/orderBilling";
import { billingErrorResponse } from "@/lib/billing/server/errors";

type Params = { params: Promise<{ id: string }> };

// GET /api/billing/orders/[id] — the order's full billing lifecycle read live from Salesforce:
// Order Products with their Product → Billing Policy → Treatment → Item chain, Order Actions,
// usage configuration/entitlements, readiness, billing schedules, invoices and the lifecycle
// tracker. Every step is derived from Salesforce records, so leaving and returning resumes exactly.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { id } = await params;
  try {
    return NextResponse.json(await loadOrderBilling(auth.client, id));
  } catch (err) {
    if (err instanceof Error && /^(Invalid Order Id|Order not found)/.test(err.message)) return NextResponse.json({ error: err.message, code: "NOT_FOUND" }, { status: 404 });
    return billingErrorResponse(err, "Failed to load the order's billing status", { objectLabel: "Order" });
  }
}
