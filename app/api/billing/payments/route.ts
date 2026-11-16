import type { NextRequest } from "next/server";
import { listPayments, recordPayment } from "@/lib/billing/server/payments";
import { paymentInputOf, paymentMutation, paymentRoute } from "@/lib/billing/server/paymentsRoute";

// GET /api/billing/payments?search&status&accountId&from&to&sort&dir&page&pageSize — real Payment records + stats.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  return paymentRoute(req, client => listPayments(client, {
    search: p.get("search"), status: p.get("status"), accountId: p.get("accountId"), from: p.get("from"), to: p.get("to"),
    sort: p.get("sort"), dir: p.get("dir"), page: Number(p.get("page") ?? 1) || 1, pageSize: Number(p.get("pageSize") ?? 25) || 25,
  }), "Failed to load payments");
}

// POST /api/billing/payments — { invoiceId, amount, paymentDate?, paymentMethodId?, status?, type?, comments?, invoiceToken, idempotencyKey, allowSimilar? }.
// Re-reads and re-validates the invoice, creates the Salesforce Payment, applies it (applyPayment). Idempotent per key.
export async function POST(req: NextRequest) {
  return paymentMutation(req, (client, body) => recordPayment(client, paymentInputOf(body)), "Failed to record the payment");
}
