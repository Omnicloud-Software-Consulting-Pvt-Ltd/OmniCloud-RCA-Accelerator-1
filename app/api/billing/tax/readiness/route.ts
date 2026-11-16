import type { NextRequest } from "next/server";
import { getTaxReadiness } from "@/lib/tax/server/engine";
import { taxRoute } from "@/lib/tax/server/route";

// GET /api/billing/tax/readiness — can Salesforce CALCULATE tax in the CURRENT org (permission, configuration, StandardTax decision
// table), read-only. The app exposes no endpoint that changes the StandardTax system table or toggles Billing.
export async function GET(req: NextRequest) {
  return taxRoute(req, client => getTaxReadiness(client), "Failed to read tax engine readiness");
}
