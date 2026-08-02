import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveReferenceByName } from "@/lib/quotes/quote/reference";
import type { ReferenceObjectType } from "@/lib/quotes/types";

const VALID_TYPES: ReferenceObjectType[] = ["Account", "Pricebook2", "Opportunity", "Contact", "User", "Quote", "Contract"];

// POST /api/quotes/reference — generic live-validating reference lookup (§3.3).
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let objectType: ReferenceObjectType, name: string;
  try {
    ({ objectType, name } = await req.json());
    if (!VALID_TYPES.includes(objectType)) return NextResponse.json({ error: "Unsupported reference object type" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await resolveReferenceByName(auth.client, objectType, name ?? "");
    return NextResponse.json({ success: true, resolved: result });
  } catch (err) {
    return sfErrorResponse(err, "Failed to validate reference");
  }
}
