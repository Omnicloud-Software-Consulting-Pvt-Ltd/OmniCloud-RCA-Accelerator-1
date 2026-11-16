import type { NextRequest } from "next/server";
import { getPaymentDetail } from "@/lib/billing/server/payments";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";

type Params = { params: Promise<{ id: string }> };

// GET /api/billing/payments/[id] — Payment details with its applications, invoices and related orders.
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return paymentRoute(req, client => getPaymentDetail(client, id), "Failed to load the payment");
}
