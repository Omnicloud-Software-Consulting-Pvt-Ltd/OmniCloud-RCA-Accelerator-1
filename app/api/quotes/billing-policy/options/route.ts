import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { listAvailableBillingPolicies } from "@/lib/quotes/billing/treatment";

// GET /api/quotes/billing-policy/options — real, currently-active Billing Policies the user can assign (§Fix Billing Policy Recovery).
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  try {
    const result = await listAvailableBillingPolicies(auth.client);
    return NextResponse.json(result);
  } catch (err) {
    return sfErrorResponse(err, "Failed to list Billing Policies");
  }
}
