import type { NextRequest } from "next/server";
import { searchPaymentInvoices } from "@/lib/billing/server/payments";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";

// GET /api/billing/payments/invoices?search=(invoice no. / account / order no.)&from&to&all=1 — Salesforce invoices for the Record Payment lookup (eligible only unless all=1).
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  return paymentRoute(req, client => searchPaymentInvoices(client, { search: p.get("search") ?? "", eligibleOnly: p.get("all") !== "1", from: p.get("from"), to: p.get("to"), purpose: p.get("purpose") === "credit" ? "credit" : "payment" }), "Failed to search invoices");
}
