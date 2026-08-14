import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveStandardPricebookId } from "@/lib/bundles/server/relationships";

/**
 * GET /api/bundles/pricebook — the Standard Pricebook Id, so Bundle Edit's
 * "+ Add Product" lookup can call the existing /api/quotes/products/search
 * endpoint (pricebook-scoped) instead of a second product-search
 * implementation.
 */
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  try {
    const pricebookId = await resolveStandardPricebookId(auth.client);
    if (!pricebookId) return NextResponse.json({ error: "Standard Pricebook not found in this org" }, { status: 404 });
    return NextResponse.json({ success: true, pricebookId });
  } catch (err) {
    return sfErrorResponse(err, "Failed to resolve Standard Pricebook");
  }
}
