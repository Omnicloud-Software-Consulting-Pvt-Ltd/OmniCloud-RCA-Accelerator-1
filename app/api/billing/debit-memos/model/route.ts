import type { NextRequest } from "next/server";
import { getDebitMemoModel } from "@/lib/billing/server/debitMemos";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";

// GET /api/billing/debit-memos/model — discovered DebitMemo availability, API version, picklists, required fields, org currency.
export async function GET(req: NextRequest) {
  return paymentRoute(req, client => getDebitMemoModel(client), "Failed to discover debit memos");
}
