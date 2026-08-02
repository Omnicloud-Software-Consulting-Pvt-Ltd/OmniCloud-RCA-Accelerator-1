import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveQuoteLineItemFieldSchema, resolveQuoteLineItemAttributeFieldSchema } from "@/lib/quotes/metadata/lineItemFields";
import { resolveBundleObjectDiscovery, resolveQuoteLineRelationshipSchema } from "@/lib/quotes/metadata/relationshipFields";

// GET /api/quotes/line-items/schema — QuoteLineItem + attribute + relationship schemas, plus bundle object discovery.
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const [qliSchema, qliAttributeSchema, bundleDiscovery] = await Promise.all([
      resolveQuoteLineItemFieldSchema(client),
      resolveQuoteLineItemAttributeFieldSchema(client),
      resolveBundleObjectDiscovery(client),
    ]);
    const quoteLineRelationshipSchema = await resolveQuoteLineRelationshipSchema(client, bundleDiscovery);

    return NextResponse.json({ success: true, qliSchema, qliAttributeSchema, bundleDiscovery, quoteLineRelationshipSchema });
  } catch (err) {
    return sfErrorResponse(err, "Failed to resolve QuoteLineItem schema");
  }
}
