import type { NextRequest } from "next/server";
import { getDebitMemo } from "@/lib/billing/server/debitMemos";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";

type Params = { params: Promise<{ id: string }> };

// GET /api/billing/debit-memos/[id] — one Debit Memo and its lines, read from Salesforce.
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return paymentRoute(req, client => getDebitMemo(client, id), "Failed to load the debit memo");
}
