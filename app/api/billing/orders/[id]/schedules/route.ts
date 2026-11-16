import type { NextRequest } from "next/server";
import { requestOrderBillingSchedules } from "@/lib/billing/server/orderBilling";
import { orderBillingMutation, tokenOf } from "@/lib/billing/server/orderBillingRoute";

type Params = { params: Promise<{ id: string }> };

// POST /api/billing/orders/[id]/schedules — { stateToken }. Requests billing schedule creation through Salesforce's
// standard "Create Billing Schedules from Billing Transaction" action (async). Refused if schedules exist or a job is running.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return orderBillingMutation(req, (client, body) => requestOrderBillingSchedules(client, id, tokenOf(body)), "Failed to request billing schedules");
}
