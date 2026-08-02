import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { repriceOrder } from "@/lib/orders/pricing/reprice";

type Params = { params: Promise<{ id: string }> };

// POST /api/orders/[id]/reprice — manually trigger the Order-side Instant Pricing action (§6.2),
// a distinct Connect REST capability from the Quote-side one — never falls back to it.
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { id } = await params;

  try {
    const repricing = await repriceOrder(auth.client, id);
    return NextResponse.json({ success: repricing.succeeded, repricing });
  } catch (err) {
    return sfErrorResponse(err, "Failed to reprice order");
  }
}
