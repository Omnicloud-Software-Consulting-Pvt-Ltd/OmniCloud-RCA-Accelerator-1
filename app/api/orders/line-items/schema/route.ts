import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveOrderItemFieldSchema, resolveOrderItemAttributeFieldSchema } from "@/lib/orders/metadata/lineItemFields";
import { resolveOrderItemRelationshipSchema } from "@/lib/orders/metadata/relationshipFields";
import { resolveBundleObjectDiscovery } from "@/lib/quotes/metadata/relationshipFields";

// GET /api/orders/line-items/schema — OrderItem + attribute + relationship schemas, plus bundle object discovery.
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const [oiSchema, oiAttributeSchema, bundleDiscovery] = await Promise.all([
      resolveOrderItemFieldSchema(client),
      resolveOrderItemAttributeFieldSchema(client),
      resolveBundleObjectDiscovery(client),
    ]);
    const orderItemRelationshipSchema = await resolveOrderItemRelationshipSchema(client, bundleDiscovery);

    return NextResponse.json({ success: true, oiSchema, oiAttributeSchema, bundleDiscovery, orderItemRelationshipSchema });
  } catch (err) {
    return sfErrorResponse(err, "Failed to resolve OrderItem schema");
  }
}
