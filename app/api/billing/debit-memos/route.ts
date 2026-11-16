import type { NextRequest } from "next/server";
import { createDebitMemo, debitDraftOf, listDebitMemos } from "@/lib/billing/server/debitMemos";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";
import { creditMutation } from "@/lib/billing/server/creditMemosRoute";

// GET /api/billing/debit-memos?search&status&page&pageSize — real DebitMemo records (API 65.0+) with status counts.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  return paymentRoute(req, client => listDebitMemos(client, { search: p.get("search"), status: p.get("status"), page: Number(p.get("page") ?? 1) || 1, pageSize: Number(p.get("pageSize") ?? 20) || 20 }), "Failed to load debit memos");
}

// POST /api/billing/debit-memos — { draft, idempotencyKey }. Re-resolves and re-validates the draft against Salesforce, then
// creates DebitMemo + DebitMemoLine(s) in one all-or-nothing Composite request and returns the record re-read from Salesforce.
export async function POST(req: NextRequest) {
  return creditMutation(req, (client, body) => createDebitMemo(client, debitDraftOf(body), typeof body.idempotencyKey === "string" ? body.idempotencyKey : null), "Failed to create the debit memo");
}
