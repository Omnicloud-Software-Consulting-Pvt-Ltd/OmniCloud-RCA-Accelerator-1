import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveSellingModelsBatch } from "@/lib/quotes/catalog/sellingModel";

// POST /api/quotes/selling-model/diagnostics — reuses the exact same resolution
// function as real product selection (§4.2), so diagnostics can never disagree with production behavior.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let productIds: string[];
  try {
    ({ productIds } = await req.json());
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return NextResponse.json({ error: "productIds array is required" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const resolutions = await resolveSellingModelsBatch(auth.client, productIds);
    return NextResponse.json({ success: true, resolutions: Object.fromEntries(resolutions) });
  } catch (err) {
    return sfErrorResponse(err, "Failed to run selling model diagnostics");
  }
}
