import type { NextRequest } from "next/server";
import { createCreditMemo, listCreditMemos } from "@/lib/billing/server/creditMemos";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";
import { creditInputOf, creditMutation } from "@/lib/billing/server/creditMemosRoute";

// GET /api/billing/credit-memos?search&status&accountId&invoiceId&from&to&sort&dir&page&pageSize — real CreditMemo records + stats.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  return paymentRoute(req, client => listCreditMemos(client, {
    search: p.get("search"), status: p.get("status"), accountId: p.get("accountId"), invoiceId: p.get("invoiceId"), from: p.get("from"), to: p.get("to"),
    sort: p.get("sort"), dir: p.get("dir"), page: Number(p.get("page") ?? 1) || 1, pageSize: Number(p.get("pageSize") ?? 20) || 20,
  }), "Failed to load credit memos");
}

// POST /api/billing/credit-memos — { invoiceId, amount, allocation?, taxStrategy?, effectiveDate?, description?, invoiceToken, idempotencyKey }.
// Re-validates everything, then calls Salesforce's credit API (creates + posts + applies). Idempotent per key; 202 while Salesforce processes.
export async function POST(req: NextRequest) {
  return creditMutation(req, (client, body) => createCreditMemo(client, creditInputOf(body)), "Failed to create the credit memo");
}
