import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { runtimeApiFor } from "@/lib/tax/server/runtime";
import { verifyInvoiceLineTax } from "@/lib/tax/server/pipeline";

type Params = { params: Promise<{ invoiceId: string }> };

// GET /api/taxes/invoices/[invoiceId]/tax — read-only: Salesforce's InvoiceLineTax for each line, verified against the applicable rate.
export async function GET(req: NextRequest, { params }: Params) {
  const { invoiceId } = await params;
  return taxRoute(req, async client => verifyInvoiceLineTax(await runtimeApiFor(client), invoiceId), "Failed to verify the invoice tax");
}
