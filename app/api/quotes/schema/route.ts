import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveQuoteFieldSchema } from "@/lib/quotes/metadata/quoteFields";

// GET /api/quotes/schema — resolved Quote field metadata for conditional form rendering (§3.4, §3.7).
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  try {
    const schema = await resolveQuoteFieldSchema(auth.client);
    return NextResponse.json({ success: true, schema });
  } catch (err) {
    return sfErrorResponse(err, "Failed to resolve Quote field schema");
  }
}
