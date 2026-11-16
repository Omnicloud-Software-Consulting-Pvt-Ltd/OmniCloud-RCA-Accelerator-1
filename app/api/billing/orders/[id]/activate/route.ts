import type { NextRequest } from "next/server";
import { activateOrderForBilling } from "@/lib/billing/server/orderBilling";
import { orderBillingMutation, tokenOf } from "@/lib/billing/server/orderBillingRoute";

type Params = { params: Promise<{ id: string }> };

// POST /api/billing/orders/[id]/activate — { stateToken }. Re-runs the complete billing readiness
// validation immediately before activating (stale/concurrent changes → 409), activates through the
// existing Orders activation logic, then re-reads the order and its billing schedules from Salesforce.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return orderBillingMutation(req, (client, body) => activateOrderForBilling(client, id, tokenOf(body)), "Failed to activate the order");
}
