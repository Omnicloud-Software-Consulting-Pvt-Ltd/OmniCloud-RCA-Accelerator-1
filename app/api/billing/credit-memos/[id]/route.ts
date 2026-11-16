import type { NextRequest } from "next/server";
import { getCreditMemoDetail, stateToken } from "@/lib/billing/server/creditMemos";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";

type Params = { params: Promise<{ id: string }> };

// GET /api/billing/credit-memos/[id] — Credit Memo details: lines, applications, invoice, order, all fields, state token.
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return paymentRoute(req, async client => { const d = await getCreditMemoDetail(client, id); return { ...d, stateToken: stateToken(d) }; }, "Failed to load the credit memo");
}
