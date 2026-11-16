import type { NextRequest } from "next/server";
import { postOrderInvoice } from "@/lib/billing/server/orderBilling";
import { orderBillingMutation, tokenOf } from "@/lib/billing/server/orderBillingRoute";

type Params = { params: Promise<{ id: string; invoiceId: string }> };

// POST /api/billing/orders/[id]/invoices/[invoiceId]/post — { stateToken }. Posts one of this
// order's Draft invoices through Salesforce's invoicing API (verifies the invoice belongs to the order). Posting is refused
// unless Salesforce's InvoiceLineTax verifies the tax (or the configuration verifies none is due) and the invoice's tax records are
// consistent. { allowUnverifiedTax: true } is accepted but refused (TAX_OVERRIDE_UNAVAILABLE): an override must be audited, and no
// audit store is configured.
export async function POST(req: NextRequest, { params }: Params) {
  const { id, invoiceId } = await params;
  return orderBillingMutation(req, (client, body) => postOrderInvoice(client, id, invoiceId, tokenOf(body), { allowUnverifiedTax: body.allowUnverifiedTax === true }), "Failed to post the invoice");
}
