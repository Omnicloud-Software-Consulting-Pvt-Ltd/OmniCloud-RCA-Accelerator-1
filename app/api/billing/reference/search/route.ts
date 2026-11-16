import { NextRequest, NextResponse } from "next/server";
import { requireBillingClient, TAX_SOBJECTS } from "@/lib/billing/server/discovery";
import { searchBillingReferences } from "@/lib/billing/server/lookup";
import { billingErrorResponse } from "@/lib/billing/server/errors";

// POST /api/billing/reference/search — { objectType, term } → { matches: {id,name}[] }. Same
// request/response contract as the other modules' reference search routes, so the shared
// ReferenceLookup component works unchanged. objectType can be any queryable object that a
// billing lookup field references (Product2, BillingPolicy, UnitOfMeasure, Order, ...); it's
// validated against the org's global Describe and searched on its real name (and code) field.
export async function POST(req: NextRequest) {
  let objectType: string;
  let term: string;
  try {
    const body = await req.json();
    objectType = String(body.objectType ?? "");
    term = typeof body.term === "string" ? body.term : "";
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(objectType)) return NextResponse.json({ error: "Invalid object type", code: "INVALID_REQUEST" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "INVALID_REQUEST" }, { status: 400 });
  }

  // Taxes objects (e.g. TaxTreatmentItem, GeoState) are searched on the taxes API version; everything else on the billing one.
  const auth = requireBillingClient(req, { taxes: TAX_SOBJECTS.has(objectType) });
  if ("unauthorized" in auth) return auth.unauthorized;

  try {
    const matches = await searchBillingReferences(auth.client, objectType, term);
    return NextResponse.json({ success: true, matches });
  } catch (err) {
    return billingErrorResponse(err, `Failed to search ${objectType}`, { objectLabel: objectType });
  }
}
