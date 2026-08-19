import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import type { ProcedurePayload, SalesforceCreationResult } from "@/lib/pricing-rules/types";

/**
 * §Reset — the Attribute-Based Pricing implementation (Product/Selling Model discovery, native
 * PriceAdjustmentSchedule/Rule/Condition/Adjustment creation, Expression Set XML generation, Metadata
 * API deploy, uniqueness validation, runtime verification) has been completely removed to make way for
 * a new implementation. This endpoint is now a plain shared stub, shared by all four pricing types —
 * every `pricingType` (including `attribute-based`) returns `notImplemented: true`. Nothing here writes
 * to Salesforce.
 *
 * POST /api/pricing-rules/create-procedure
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;

  let payload: ProcedurePayload;
  try {
    ({ payload } = await req.json());
    if (!payload?.procedureName?.trim() || !payload?.pricingType) {
      return NextResponse.json({ error: "procedureName and pricingType are required" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const result: SalesforceCreationResult = {
    success: false,
    notImplemented: true,
    steps: [],
    warnings: [],
    error: `${payload.pricingType} pricing doesn't have a deploy engine implemented yet — this pricing type's create flow is being rebuilt.`,
  };
  return NextResponse.json(result, { status: 501 });
}
