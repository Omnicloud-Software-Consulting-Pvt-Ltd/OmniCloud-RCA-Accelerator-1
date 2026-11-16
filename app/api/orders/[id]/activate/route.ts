import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { activateOrder, type OrderActivationAction } from "@/lib/orders/metadata/orderStatus";
import { activateOrderWithReadiness } from "@/lib/billing/server/orderBilling";
import { requireBillingClient } from "@/lib/billing/server/discovery";

type Params = { params: Promise<{ id: string }> };

const VALID_ACTIONS: OrderActivationAction[] = ["activate", "deactivate", "cancel"];

// POST /api/orders/[id]/activate — Order activation state transition (§3.6).
// Re-verifies server-side; never trusts a client-side "ready to activate" flag.
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  let action: OrderActivationAction;
  try {
    ({ action } = await req.json());
    if (!VALID_ACTIONS.includes(action)) return NextResponse.json({ error: "Unsupported activation action" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    // Activation goes through the same billing/tax readiness as Revenue Cloud Billing (no bypass); deactivate/cancel don't.
    // The readiness runs at the billing API version, exactly as in the Revenue Cloud Billing routes.
    const billing = action === "activate" ? requireBillingClient(req) : null;
    if (billing && "unauthorized" in billing) return billing.unauthorized;
    const result = billing ? await activateOrderWithReadiness(billing.client, id) : await activateOrder(client, id, action);
    return NextResponse.json(result, { status: result.success ? 200 : 422 });
  } catch (err) {
    return sfErrorResponse(err, "Failed to update Order activation status");
  }
}
