import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { runtimeApiFor } from "@/lib/tax/server/runtime";
import { generateTaxInvoice, validateOrderTaxReadiness, verifyBillingScheduleForTax } from "@/lib/tax/server/pipeline";

type Params = { params: Promise<{ orderId: string }> };

// GET /api/taxes/billing/[orderId] — read-only: the order's tax readiness and its Salesforce-generated billing schedules.
export async function GET(req: NextRequest, { params }: Params) {
  const { orderId } = await params;
  return taxRoute(req, async client => {
    const api = await runtimeApiFor(client);
    const [order, billingSchedule] = await Promise.all([validateOrderTaxReadiness(api, orderId), verifyBillingScheduleForTax(api, orderId)]);
    return { success: true, order, billingSchedule };
  }, "Failed to read the order's tax state");
}

// POST /api/taxes/billing/[orderId] — { action: "generate-invoice", confirm }. Without confirm: eligibility preview only. A stale
// decision table blocks; it is refreshed first only with approveDecisionTableRefresh: true (explicit approval), never automatically.
export async function POST(req: NextRequest, { params }: Params) {
  const { orderId } = await params;
  return taxRoute(req, async (client, body) => generateTaxInvoice(await runtimeApiFor(client), orderId, { confirm: body.confirm === true, refresh: body.approveDecisionTableRefresh === true ? "approved" : "never" }), "Invoice generation failed", { mutates: true });
}
