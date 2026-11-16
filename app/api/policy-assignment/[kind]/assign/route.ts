import { NextRequest, NextResponse } from "next/server";
import { salesforceBackend } from "@/lib/policyAssignment/server";
import { parseBulkInput, runBulkAssignment } from "@/lib/policyAssignment/engine";
import { policyRoute, type KindParams } from "@/lib/policyAssignment/route";
import { clearBillingStatsCache } from "@/lib/billing/server/stats";

// POST /api/policy-assignment/{billing|tax}/assign — { policyId, productIds[] }. Re-validates the policy, re-reads every product
// and writes Product2.<field> ONLY where it's still empty (conditional on the product being unchanged since that read). Products
// that already have a policy of this kind are reported, never overwritten. Returns a per-product result.
export async function POST(req: NextRequest, ctx: KindParams) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, code: "INVALID_REQUEST", error: "Invalid request body." }, { status: 400 }); }
  return policyRoute(req, ctx, async (client, kind) => {
    const input = parseBulkInput(body);
    if ("success" in input) return NextResponse.json(input, { status: input.status });
    const out = await runBulkAssignment(await salesforceBackend(client, kind), input);
    if (!out.success) return NextResponse.json(out, { status: out.status });
    if (out.assigned > 0) clearBillingStatsCache();
    return out;
  });
}
