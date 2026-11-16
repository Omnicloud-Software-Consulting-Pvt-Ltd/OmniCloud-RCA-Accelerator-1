import type { NextRequest } from "next/server";
import { normalizeSpec } from "@/lib/tax/server/spec";
import { planTaxConfiguration } from "@/lib/tax/server/plan";
import { taxRoute } from "@/lib/tax/server/route";

// POST /api/billing/tax/plan — { spec }. Resolves every record, field, picklist value and relationship in the connected org and
// returns the dependency-ordered preview (reuse / create / update) with its validation issues. Never writes.
export async function POST(req: NextRequest) {
  return taxRoute(req, (client, body) => planTaxConfiguration(client, normalizeSpec(body)), "Failed to preview the tax configuration");
}
