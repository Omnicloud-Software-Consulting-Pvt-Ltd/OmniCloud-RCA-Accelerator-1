import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { readSalesforceTax, sfTaxApiFor } from "@/lib/tax/server/salesforceTaxCalculation";

type Params = { params: Promise<{ runId: string }> };

// GET /api/taxes/calculation/salesforce/[runId] — read-only state of a run (runId = the run's Salesforce Order Id).
export async function GET(req: NextRequest, { params }: Params) {
  const { runId } = await params;
  return taxRoute(req, async client => readSalesforceTax(await sfTaxApiFor(client), runId), "Failed to read the Salesforce tax calculation");
}
