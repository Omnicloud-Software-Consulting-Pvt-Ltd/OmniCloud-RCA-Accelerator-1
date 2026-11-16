import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { LOOKUP_OBJECTS, searchLookup } from "@/lib/tax/server/lookup";
import { BadInputError } from "@/lib/billing/server/payments";
import type { TaxLookupObject } from "@/lib/tax/types";

// GET /api/taxes/lookup?object=Account|Contact|Product2|Invoice|GeoCountry|GeoState&q=&cursor=&accountId=&country= — read-only,
// one keyset page of matching Salesforce records for the tax pages' SalesforceLookup (Contact needs accountId, GeoState needs country).
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  return taxRoute(req, async client => {
    const object = p.get("object") as TaxLookupObject;
    if (!LOOKUP_OBJECTS.includes(object)) throw new BadInputError(`object must be one of ${LOOKUP_OBJECTS.join(", ")}.`);
    const page = await searchLookup(client, object, { q: (p.get("q") ?? "").slice(0, 80), cursor: p.get("cursor"), accountId: p.get("accountId"), country: p.get("country") });
    return { success: true, ...page };
  }, "Failed to search Salesforce records");
}
