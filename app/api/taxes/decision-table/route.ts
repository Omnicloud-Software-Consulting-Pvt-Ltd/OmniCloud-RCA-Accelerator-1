import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { configureTaxCodeDecisionTable, dtApiFor } from "@/lib/tax/server/decisionTable";

// POST /api/taxes/decision-table — { engineId, confirm? }. Revenue Standard Tax decision table WITH a TaxCode input for ONE tax
// engine: without confirm a read-only preview; with confirm: true, create (or reuse) → parameters → own TaxRate dataset link →
// activate → refresh (confirmed by Salesforce) → assign to that engine → re-read & verify. Never modifies StandardTax.
export async function POST(req: NextRequest) {
  return taxRoute(req, async (client, body) => configureTaxCodeDecisionTable(await dtApiFor(client), { engineId: typeof body.engineId === "string" ? body.engineId : "", confirm: body.confirm === true }), "Decision table configuration failed", { mutates: true });
}
