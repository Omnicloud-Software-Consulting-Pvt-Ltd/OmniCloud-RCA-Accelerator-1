import type { NextRequest } from "next/server";
import { advanceTaxRun, getTaxRun, type RunAction } from "@/lib/tax/server/verification";
import { taxRoute } from "@/lib/tax/server/route";

type Params = { params: Promise<{ orderId: string }> };

// GET /api/billing/tax/runs/[orderId] — order → schedule → invoice → Salesforce tax, with the 15 verification checks (read-only).
export async function GET(req: NextRequest, { params }: Params) {
  const { orderId } = await params;
  return taxRoute(req, client => getTaxRun(client, orderId), "Failed to read the tax verification");
}

// POST /api/billing/tax/runs/[orderId] — { retry?, confirm? }. Performs the NEXT Salesforce operation, re-reads Salesforce and returns
// the state. Billable steps (activation, billing schedules, invoice generation, posting) run only when `confirm` names that step.
export async function POST(req: NextRequest, { params }: Params) {
  const { orderId } = await params;
  return taxRoute(req, (client, body) => advanceTaxRun(client, orderId, { retry: body.retry === true, confirm: typeof body.confirm === "string" ? body.confirm as RunAction : null }), "Failed to advance the tax verification", { mutates: true });
}
