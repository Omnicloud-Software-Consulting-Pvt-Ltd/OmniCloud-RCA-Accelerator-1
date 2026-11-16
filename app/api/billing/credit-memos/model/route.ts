import type { NextRequest } from "next/server";
import { getCreditMemoModel } from "@/lib/billing/server/creditMemos";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";

// GET /api/billing/credit-memos/model — discovered credit memo objects, statuses, reasons, Connect/action capabilities, permission.
export async function GET(req: NextRequest) {
  return paymentRoute(req, client => getCreditMemoModel(client), "Failed to discover the credit memo model");
}
