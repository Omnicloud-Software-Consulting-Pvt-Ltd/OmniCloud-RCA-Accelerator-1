import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveContractFieldSchema } from "@/lib/contracts/metadata/contractFields";

// GET /api/contracts/schema — resolved Contract field metadata for conditional form rendering (§3.4).
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  try {
    const schema = await resolveContractFieldSchema(auth.client);
    return NextResponse.json({ success: true, schema });
  } catch (err) {
    return sfErrorResponse(err, "Failed to resolve Contract field schema");
  }
}
