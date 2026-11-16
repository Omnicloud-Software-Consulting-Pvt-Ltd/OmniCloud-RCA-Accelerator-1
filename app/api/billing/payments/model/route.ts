import type { NextRequest } from "next/server";
import { getPaymentModel } from "@/lib/billing/server/payments";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";

// GET /api/billing/payments/model — the org's discovered payment model: objects, picklists, payment methods, capabilities.
export async function GET(req: NextRequest) {
  return paymentRoute(req, client => getPaymentModel(client), "Failed to discover the payment model");
}
