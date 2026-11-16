import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { configApiFor, unitOfMeasureOptions } from "@/lib/products/server/revenueConfig";

// GET /api/sf/products/options — org-specific option lists for the product form (Unit of Measure: UnitOfMeasure records and
// the Quantity Unit Of Measure picklist), so no unsupported value is ever hardcoded.
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  try { return NextResponse.json({ success: true, unitsOfMeasure: await unitOfMeasureOptions(await configApiFor(auth.client)) }); }
  catch (err) { return sfErrorResponse(err, "Failed to load product options"); }
}
