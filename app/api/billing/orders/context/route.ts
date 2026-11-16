import { NextResponse, type NextRequest } from "next/server";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { findOrderContext } from "@/lib/billing/server/orderBilling";
import { billingErrorResponse } from "@/lib/billing/server/errors";

// GET /api/billing/orders/context?scheduleId=…|invoiceId=… — read-only: the Order (and billing schedules)
// behind a billing schedule or invoice, so their detail views can link back to the order.
export async function GET(req: NextRequest) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const p = req.nextUrl.searchParams;
  try {
    return NextResponse.json({ success: true, ...(await findOrderContext(auth.client, { scheduleId: p.get("scheduleId"), invoiceId: p.get("invoiceId") })) });
  } catch (err) {
    return billingErrorResponse(err, "Failed to find the related order", { objectLabel: "Order" });
  }
}
