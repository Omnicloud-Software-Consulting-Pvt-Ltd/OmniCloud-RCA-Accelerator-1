import { NextResponse, type NextRequest } from "next/server";
import { validateCredit } from "@/lib/billing/server/creditMemos";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";
import { creditInputOf } from "@/lib/billing/server/creditMemosRoute";

// POST /api/billing/credit-memos/validate — Credit Memo preview: server-side checks against the re-read invoice and lines. Read-only.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body.", code: "INVALID_REQUEST" }, { status: 400 }); }
  return paymentRoute(req, client => validateCredit(client, creditInputOf(body)), "Failed to validate the credit memo");
}
