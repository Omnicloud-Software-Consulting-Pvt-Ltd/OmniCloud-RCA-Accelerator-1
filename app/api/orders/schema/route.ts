import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveOrderFieldSchema } from "@/lib/orders/metadata/orderFields";

// GET /api/orders/schema — resolved Order field metadata for conditional form rendering (§3.4).
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  try {
    const schema = await resolveOrderFieldSchema(auth.client);
    return NextResponse.json({ success: true, schema });
  } catch (err) {
    return sfErrorResponse(err, "Failed to resolve Order field schema");
  }
}
