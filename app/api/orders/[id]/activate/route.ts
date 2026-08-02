import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { activateOrder, type OrderActivationAction } from "@/lib/orders/metadata/orderStatus";

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
    const result = await activateOrder(client, id, action);
    return NextResponse.json(result, { status: result.success ? 200 : 422 });
  } catch (err) {
    return sfErrorResponse(err, "Failed to update Order activation status");
  }
}
