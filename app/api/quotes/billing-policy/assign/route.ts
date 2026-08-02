import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { assignBillingPolicyToProduct } from "@/lib/quotes/billing/treatment";

// POST /api/quotes/billing-policy/assign — user-chosen Billing Policy assignment + immediate re-resolution (§Fix Billing Policy Recovery).
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let productId: string, billingPolicyId: string;
  try {
    ({ productId, billingPolicyId } = await req.json());
    if (!productId || !billingPolicyId) return NextResponse.json({ error: "productId and billingPolicyId are required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await assignBillingPolicyToProduct(auth.client, productId, billingPolicyId);
    return NextResponse.json(result);
  } catch (err) {
    return sfErrorResponse(err, "Failed to assign Billing Policy");
  }
}
