import { NextResponse, type NextRequest } from "next/server";
import { creditRequestStatus } from "@/lib/billing/server/creditMemos";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";

// GET /api/billing/credit-memos/status?key=&invoiceId= — result of a submitted (asynchronous) credit request. Read-only.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const key = p.get("key"), invoiceId = p.get("invoiceId");
  if (!key || !invoiceId) return NextResponse.json({ error: "key and invoiceId are required.", code: "INVALID_REQUEST" }, { status: 400 });
  return paymentRoute(req, async client => { const { ok, status, ...rest } = await creditRequestStatus(client, key, invoiceId); return { success: ok, httpStatus: status, ...rest }; }, "Failed to read the credit memo request");
}
