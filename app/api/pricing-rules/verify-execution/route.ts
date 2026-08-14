import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import { verifyAttributeExecution, type VerifyExecutionArgs } from "@/lib/pricing-rules/salesforce/verifyExecution";

// POST /api/pricing-rules/verify-execution — §9: call the real Salesforce
// pricing engine against a just-deployed procedure to prove it actually
// prices correctly, rather than trusting a clean metadata deploy alone.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let args: VerifyExecutionArgs;
  let debug = false;
  try {
    const body = await req.json();
    debug = body?.debug === true;
    args = body as VerifyExecutionArgs;
    if (!args?.productId || !args?.attributeValue) {
      return NextResponse.json({ error: "productId and attributeValue are required" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const { success, executionReport, steps } = await verifyAttributeExecution(client, args);
    return NextResponse.json({ success, executionReport, steps, debugLog: debug ? client.debugLog : undefined });
  } catch (err) {
    return sfErrorResponse(err, "Failed to verify pricing procedure execution.");
  }
}
