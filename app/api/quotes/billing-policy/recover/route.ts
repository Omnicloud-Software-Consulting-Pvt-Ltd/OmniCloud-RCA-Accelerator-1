import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { recoverBillingPolicy } from "@/lib/quotes/billing/treatment";

// POST /api/quotes/billing-policy/recover — automatic recovery for the "no-billing-policy" outcome (§4.3).
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let productId: string;
  try {
    ({ productId } = await req.json());
    if (!productId) return NextResponse.json({ error: "productId is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await recoverBillingPolicy(auth.client, productId);
    return NextResponse.json(result);
  } catch (err) {
    return sfErrorResponse(err, "Failed to recover billing policy");
  }
}
