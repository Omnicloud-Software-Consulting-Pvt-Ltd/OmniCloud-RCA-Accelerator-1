import { NextRequest, NextResponse } from "next/server";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { getTaxModuleStats } from "@/lib/billing/server/stats";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import type { BillingStatsResponse } from "@/lib/billing/types";

// GET /api/taxes/stats — availability, createability and live record counts (with status breakdown) for every Taxes card.
// Counts come from Salesforce (Composite Batch), cached 30s per session; ?fresh=1 bypasses the cache.
export async function GET(req: NextRequest) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  try {
    const modules = await getTaxModuleStats(auth.client, { fresh: req.nextUrl.searchParams.get("fresh") === "1" });
    const body: BillingStatsResponse = { success: true, modules, apiVersion: auth.client.apiVersion, generatedAt: new Date().toISOString() };
    return NextResponse.json(body);
  } catch (err) {
    return billingErrorResponse(err, "Failed to load the Taxes statistics");
  }
}
