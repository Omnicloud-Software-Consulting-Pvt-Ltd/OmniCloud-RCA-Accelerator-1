import type { NextRequest } from "next/server";
import { getTaxDashboard } from "@/lib/tax/server/dashboard";
import { taxRoute } from "@/lib/tax/server/route";

// GET /api/billing/tax — Tax Dashboard for the CURRENT org: engines, providers, policies, treatments, items, rates, legal entities,
// taxable products, and configuration vs calculation status (read-only).
export async function GET(req: NextRequest) {
  return taxRoute(req, client => getTaxDashboard(client), "Failed to load the tax configuration");
}
