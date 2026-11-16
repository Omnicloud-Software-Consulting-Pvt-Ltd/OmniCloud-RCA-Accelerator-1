import { NextRequest, NextResponse } from "next/server";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { getBillingStats } from "@/lib/billing/server/stats";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import type { BillingStatsResponse } from "@/lib/billing/types";

// GET /api/billing/stats — availability (which billing modules this org actually has), record
// counts and status breakdowns for the Billing dashboard. Counts come from 1–2 Composite Batch
// calls and are cached for 30s per org; `?fresh=1` bypasses the cache (dashboard Refresh button).
export async function GET(req: NextRequest) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const modules = await getBillingStats(client, { fresh: req.nextUrl.searchParams.get("fresh") === "1" });
    const body: BillingStatsResponse = { success: true, modules, apiVersion: client.apiVersion, generatedAt: new Date().toISOString() };
    return NextResponse.json(body);
  } catch (err) {
    return billingErrorResponse(err, "Failed to load Revenue Cloud Billing statistics");
  }
}
