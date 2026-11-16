import { NextResponse, type NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { runtimeApiFor } from "@/lib/tax/server/runtime";
import { calculateTax, type CalculationInput, type CalculationMode } from "@/lib/tax/server/calculation";

// POST /api/taxes/calculation — { action: "validate" | "preview", product, quantity, unitPrice, country, state, city, zipCode,
// effectiveDate, legalEntityId }. Read-only configuration resolution. "calculate" (Salesforce's direct Tax Calculation API,
// POST /commerce/taxes/actions/calculate) is refused: it returns 404 NOT_FOUND for Revenue Standard Tax engines (verified in p10).
// Tax is calculated by Salesforce through the billing workflow: POST /api/taxes/calculation/salesforce.
export async function POST(req: NextRequest) {
  const peek = await req.clone().json().catch(() => null) as { action?: unknown } | null;
  if (peek?.action !== "validate" && peek?.action !== "preview") return NextResponse.json({ success: false, code: "UNSUPPORTED_CALCULATION_PATH", error: "Salesforce's direct Tax Calculation API returns 404 for Revenue Standard Tax engines, so it isn't used. Calculate tax through the Salesforce billing workflow: POST /api/taxes/calculation/salesforce (order → billing schedule → Draft invoice → InvoiceLineTax).", supported: "/api/taxes/calculation/salesforce" }, { status: 410 });
  return taxRoute(req, async (client, body) => {
    const action: CalculationMode = body.action === "preview" ? "preview" : "validate";
    return calculateTax(await runtimeApiFor(client), body as unknown as CalculationInput, action);
  }, "Tax calculation failed");
}
