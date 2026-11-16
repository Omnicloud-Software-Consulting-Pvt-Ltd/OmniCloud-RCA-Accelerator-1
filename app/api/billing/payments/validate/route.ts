import { NextResponse, type NextRequest } from "next/server";
import { validatePayment } from "@/lib/billing/server/payments";
import { paymentInputOf, paymentRoute } from "@/lib/billing/server/paymentsRoute";

// POST /api/billing/payments/validate — the payment preview: server-side checks against the re-read invoice. Read-only.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body.", code: "INVALID_REQUEST" }, { status: 400 }); }
  return paymentRoute(req, client => validatePayment(client, paymentInputOf(body)), "Failed to validate the payment");
}
