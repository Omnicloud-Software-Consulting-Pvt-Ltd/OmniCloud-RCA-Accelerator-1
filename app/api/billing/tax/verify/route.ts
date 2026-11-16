import type { NextRequest } from "next/server";
import { normalizeSpec } from "@/lib/tax/server/spec";
import { verifyTaxConfiguration } from "@/lib/tax/server/execute";
import { taxRoute } from "@/lib/tax/server/route";

// POST /api/billing/tax/verify — { spec }. Re-reads Salesforce and verifies the configuration (every record exists, is linked and
// active, codes/rates/products correct). Configuration only — calculation is proven by /runs. Never writes.
export async function POST(req: NextRequest) {
  return taxRoute(req, (client, body) => verifyTaxConfiguration(client, normalizeSpec(body)), "Failed to verify the tax configuration");
}
