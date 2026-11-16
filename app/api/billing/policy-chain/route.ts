import { NextRequest, NextResponse } from "next/server";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import { clearBillingStatsCache } from "@/lib/billing/server/stats";
import { loadOrderBilling } from "@/lib/billing/server/orderBilling";
import { chainApiFor, completePolicyChain, orderBillingPrerequisite } from "@/lib/billing/server/policyChainCompletion";
import { SALESFORCE_ID } from "@/lib/billing/server/lookup";

// POST /api/billing/policy-chain — { policyId, treatmentId, productId?, confirm?, orderId? }.
// Without `confirm`: read-only preview of every stage (Item → activate Item → activate Treatment → policy default → activate Policy).
// With `confirm: "<stage>"`: performs exactly that stage if it's the next ready one, then re-reads Salesforce and verifies it.
// `orderId` adds a READ-ONLY check of that order's billing-policy prerequisite. Never activates orders or creates schedules/invoices.
export async function POST(req: NextRequest) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body", code: "INVALID_REQUEST" }, { status: 400 }); }
  const id = (v: unknown) => (typeof v === "string" && SALESFORCE_ID.test(v) ? v : null);
  const policyId = id(body.policyId), treatmentId = id(body.treatmentId);
  if (!policyId || !treatmentId) return NextResponse.json({ error: "A valid policyId and treatmentId are required.", code: "INVALID_REQUEST" }, { status: 400 });
  try {
    const out = await completePolicyChain(chainApiFor(auth.client), { policyId, treatmentId, productId: id(body.productId), confirm: typeof body.confirm === "string" ? body.confirm : null });
    if (out.writes.length) clearBillingStatsCache();
    const orderId = id(body.orderId);
    const order = orderId ? orderBillingPrerequisite(await loadOrderBilling(auth.client, orderId)) : null;
    return NextResponse.json({ ...out, order });
  } catch (err) {
    return billingErrorResponse(err, "Billing policy chain failed", { objectLabel: "Billing Policy" });
  }
}
