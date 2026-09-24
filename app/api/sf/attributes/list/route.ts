import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { loadAttributeList } from "@/lib/attributes/server/attributeDetail";

/** GET /api/sf/attributes/list — every AttributeDefinition in the org, for Attribute History/Catalog/Dashboard. */
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  try {
    const attributes = await loadAttributeList(auth.client);
    return NextResponse.json({ success: true, attributes });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load attributes");
  }
}
