import type { NextRequest } from "next/server";
import { loadInvoiceForPayment } from "@/lib/billing/server/payments";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";

type Params = { params: Promise<{ id: string }> };

// GET /api/billing/payments/invoices/[id] — one invoice re-read for payment: balance, eligibility, applications, state token.
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return paymentRoute(req, async client => ({ success: true, invoice: await loadInvoiceForPayment(client, id) }), "Failed to load the invoice");
}
