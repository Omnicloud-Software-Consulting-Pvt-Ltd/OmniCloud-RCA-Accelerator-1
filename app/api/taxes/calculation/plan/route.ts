import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { planMessage, planTaxCalculation } from "@/lib/tax/server/taxQuery";
import { parsePlanInput } from "@/lib/tax/server/planInput";

// POST /api/taxes/calculation/plan — { product: { id } | { name }, account?, quantity?, unitPrice?, country?, state?, taxCode?, rate?,
// basis?, treatmentId?, engineId? }. READ-ONLY: Salesforce's validation of the calculation plus the configuration plan and its ranked
// diagnostics (records to reuse, link, update, create, activate, the refresh, questions). Writes go through /calculation/remediate.
export async function POST(req: NextRequest) {
  return taxRoute(req, async (client, body) => {
    const { salesforce, plan } = await planTaxCalculation(client, parsePlanInput(body));
    return { success: true, salesforce, plan, message: planMessage(plan, salesforce) };
  }, "Tax calculation plan failed");
}
