import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import { discoverProductAttributes, ProductAttributeAuthError, ProductNotFoundError } from "@/lib/pricing-rules/salesforce/productAttributeDiscovery";

// POST /api/pricing-rules/product-attributes — §4: discover a product's
// price-impacting attributes + picklist values live from the connected org.
// Best-effort by design: individual SOQL/describe failures degrade to a
// warning rather than a hard failure, except for "product not found" and
// an expired/invalid session (both re-thrown to the top-level catch below).
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let productName: string;
  let productId: string | undefined;
  let debug = false;
  try {
    ({ productName, productId, debug } = await req.json());
    debug = debug === true;
    if (!productName?.trim()) return NextResponse.json({ error: "productName is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    // productId (when provided by the caller — e.g. a ProductLookup selection) always takes precedence
    // over name-based resolution, since Product2.Name isn't guaranteed unique.
    const { data, steps } = await discoverProductAttributes(client, productName.trim(), productId?.trim() || undefined);
    return NextResponse.json({ ...data, logs: steps, debugLog: debug ? client.debugLog : undefined });
  } catch (err) {
    if (err instanceof ProductAttributeAuthError) {
      return NextResponse.json({ error: "Session expired. Please reconnect to Salesforce.", authError: true }, { status: 401 });
    }
    if (err instanceof ProductNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return sfErrorResponse(err, "Failed to discover product attributes.");
  }
}
