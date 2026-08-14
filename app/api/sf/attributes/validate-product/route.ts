import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { validateProductExists } from "@/lib/attributes/server/productValidation";

/**
 * POST /api/sf/attributes/validate-product — does the Product an Attribute
 * prompt refers to already exist in Salesforce? The mandatory gate before
 * any Attribute batch executes (RCAAttributeStudio must not deploy until
 * this resolves to an existing, newly-created, or user-selected Product).
 * Reuses the same product search Quotes/Bundles already use — see
 * lib/attributes/server/productValidation.ts.
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let productName: string;
  try {
    ({ productName } = await req.json());
    if (!productName || !productName.trim()) {
      return NextResponse.json({ error: "productName is required" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await validateProductExists(auth.client, productName);
    return NextResponse.json({ success: true, result });
  } catch (err) {
    return sfErrorResponse(err, "Failed to check whether this product exists in Salesforce");
  }
}
