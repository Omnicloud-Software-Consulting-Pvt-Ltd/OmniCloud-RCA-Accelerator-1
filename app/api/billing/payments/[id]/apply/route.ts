import type { NextRequest } from "next/server";
import { applyExistingPayment, BadInputError } from "@/lib/billing/server/payments";
import { allocationOf, paymentMutation } from "@/lib/billing/server/paymentsRoute";

type Params = { params: Promise<{ id: string }> };

// POST /api/billing/payments/[id]/apply — { invoiceId, amount?, invoiceToken, level?: "lines", allocation?: [{lineId, amount}] }. Applies an existing payment's unapplied
// amount to an invoice via applyPayment (recovery path). Never applies more than is unapplied or outstanding.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return paymentMutation(req, (client, body) => {
    if (typeof body.invoiceId !== "string" || !body.invoiceId) throw new BadInputError("Choose an invoice.");
    return applyExistingPayment(client, id, {
      invoiceId: body.invoiceId,
      amount: typeof body.amount === "number" ? body.amount : null,
      invoiceToken: typeof body.invoiceToken === "string" ? body.invoiceToken : null,
      level: body.level === "lines" ? "lines" : null,
      allocation: allocationOf(body.allocation),
    });
  }, "Failed to apply the payment");
}
