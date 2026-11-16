import type { NextRequest } from "next/server";
import { generateOrderInvoices } from "@/lib/billing/server/orderBilling";
import { orderBillingMutation, tokenOf } from "@/lib/billing/server/orderBillingRoute";

type Params = { params: Promise<{ id: string }> };

// POST /api/billing/orders/[id]/invoices — { stateToken }. Generates invoices through Salesforce's
// own invoicing API for this order's billing schedules that aren't invoiced yet (never duplicates).
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return orderBillingMutation(req, (client, body) => generateOrderInvoices(client, id, tokenOf(body)), "Failed to generate the invoice");
}
