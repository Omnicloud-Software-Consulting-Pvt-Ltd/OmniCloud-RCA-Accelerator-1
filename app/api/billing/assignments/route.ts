import { NextRequest, NextResponse } from "next/server";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { assignBillingPolicy } from "@/lib/billing/server/assignment";
import { clearBillingStatsCache } from "@/lib/billing/server/stats";
import { billingErrorResponse } from "@/lib/billing/server/errors";

// POST /api/billing/assignments — assign an existing Billing Policy to an existing Product:
// { productId, policyId, confirmReplace?, expectedCurrentPolicyId? }. Re-validates everything
// server-side; a product that already has a DIFFERENT policy returns 409 unless the user explicitly
// confirmed the replacement AND the live current policy still matches what they reviewed.
export async function POST(req: NextRequest) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let body: { productId?: unknown; policyId?: unknown; confirmReplace?: unknown; expectedCurrentPolicyId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body", code: "INVALID_REQUEST" }, { status: 400 }); }
  if (typeof body.productId !== "string" || typeof body.policyId !== "string") {
    return NextResponse.json({ error: "Select both a Product and a Billing Policy.", code: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const out = await assignBillingPolicy(auth.client, {
      productId: body.productId, policyId: body.policyId,
      confirmReplace: body.confirmReplace === true,
      expectedCurrentPolicyId: typeof body.expectedCurrentPolicyId === "string" ? body.expectedCurrentPolicyId : null,
    });
    if (!out.ok) return NextResponse.json({ success: false, error: out.error, code: out.code, check: out.check }, { status: out.status });
    clearBillingStatsCache();
    return NextResponse.json({ success: true, ...out });
  } catch (err) {
    return billingErrorResponse(err, "Failed to assign the Billing Policy", { objectLabel: "Product" });
  }
}
