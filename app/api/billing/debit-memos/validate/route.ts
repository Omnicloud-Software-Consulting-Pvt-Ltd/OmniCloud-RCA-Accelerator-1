import { NextResponse, type NextRequest } from "next/server";
import { debitDraftOf, resolveDebitDraft } from "@/lib/billing/server/debitMemos";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";

// POST /api/billing/debit-memos/validate — { draft }. Resolves names/numbers against Salesforce and validates the debit memo
// (the preview). Read-only.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body.", code: "INVALID_REQUEST" }, { status: 400 }); }
  return paymentRoute(req, client => resolveDebitDraft(client, debitDraftOf(body)), "Failed to validate the debit memo");
}
