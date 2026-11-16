import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { executeRateReplacement, previewRateReplacement, type RateReplacementInput } from "@/lib/tax/server/rateReplace";
import { BadInputError } from "@/lib/billing/server/payments";

type Params = { params: Promise<{ id: string }> };
const inputOf = (id: string, body: Record<string, unknown>): RateReplacementInput => ({
  rateId: id,
  effectiveDate: typeof body.effectiveDate === "string" ? body.effectiveDate : "",
  changes: body.changes && typeof body.changes === "object" && !Array.isArray(body.changes) ? (body.changes as Record<string, unknown>) : {},
});

// POST /api/taxes/rates/[id]/replace — { effectiveDate, changes, preview?: true } → preview (no writes), or
// { effectiveDate, changes, token, confirm: true } → create the replacement rate and end-date this one in ONE all-or-nothing
// request, then verify both in Salesforce. TaxCode / GeoCountryId / GeoStateId are create-only, so they can't be edited in place.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return taxRoute(req, (client, body) => {
    const input = inputOf(id, body);
    if (body.confirm === true) return executeRateReplacement(client, input, typeof body.token === "string" ? body.token : null);
    if (body.preview !== true) throw new BadInputError("Preview the replacement first (preview: true), then confirm it.");
    return previewRateReplacement(client, input);
  }, "Failed to replace the tax rate", { mutates: true });
}
