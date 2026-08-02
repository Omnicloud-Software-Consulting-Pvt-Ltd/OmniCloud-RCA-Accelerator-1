import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { searchReferencesByName } from "@/lib/quotes/quote/reference";
import type { ReferenceObjectType } from "@/lib/quotes/types";

const VALID_TYPES: ReferenceObjectType[] = ["Account", "Pricebook2", "Contract", "Quote"];

// POST /api/orders/reference/search — type-ahead "contains" search by name for the
// generic ReferenceLookup component, reusing the same object-agnostic search the
// Quote module resolves through — no second implementation.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let objectType: ReferenceObjectType, term: string;
  try {
    ({ objectType, term } = await req.json());
    if (!VALID_TYPES.includes(objectType)) return NextResponse.json({ error: "Unsupported reference object type" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const matches = await searchReferencesByName(auth.client, objectType, term ?? "");
    return NextResponse.json({ success: true, matches });
  } catch (err) {
    return sfErrorResponse(err, "Failed to search reference");
  }
}
