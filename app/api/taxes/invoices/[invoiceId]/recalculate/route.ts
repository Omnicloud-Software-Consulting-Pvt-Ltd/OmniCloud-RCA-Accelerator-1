import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { recalcApiFor, recalculateInvoiceTax } from "@/lib/tax/server/invoiceRecalc";

type Params = { params: Promise<{ invoiceId: string }> };

// POST /api/taxes/invoices/[invoiceId]/recalculate — {} previews (eligibility, stale decision tables, confirmation token; read-only);
// { confirm: "<token>" } asks Salesforce to recalculate the Draft invoice's estimated tax, then re-verifies its InvoiceLineTax.
export async function POST(req: NextRequest, { params }: Params) {
  const { invoiceId } = await params;
  return taxRoute(req, async (client, body) => ({
    success: true,
    ...(await recalculateInvoiceTax(await recalcApiFor(client), { invoiceId, confirm: typeof body.confirm === "string" ? body.confirm : null })),
  }), "Invoice tax recalculation failed", { mutates: true });
}
