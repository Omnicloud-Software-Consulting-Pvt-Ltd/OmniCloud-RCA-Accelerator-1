import type { NextRequest } from "next/server";
import { normalizeSpec } from "@/lib/tax/server/spec";
import { executeTaxConfiguration } from "@/lib/tax/server/execute";
import { taxRoute } from "@/lib/tax/server/route";
import { BadInputError } from "@/lib/billing/server/payments";

// POST /api/billing/tax/configure — { spec, token, confirm: true }. Re-resolves the plan (it must match the previewed token), then
// creates/activates/maps the records in Salesforce in all-or-nothing phases and re-reads every record to verify it.
export async function POST(req: NextRequest) {
  return taxRoute(req, (client, body) => {
    if (body.confirm !== true) throw new BadInputError("Review the preview and confirm first.");
    return executeTaxConfiguration(client, normalizeSpec(body), typeof body.token === "string" ? body.token : null);
  }, "Failed to create the tax configuration", { mutates: true });
}
