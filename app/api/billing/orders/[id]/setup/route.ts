import type { NextRequest } from "next/server";
import { applyOrderBillingSetup, type OrderSetupOperation } from "@/lib/billing/server/orderBilling";
import { orderBillingMutation, tokenOf } from "@/lib/billing/server/orderBillingRoute";

type Params = { params: Promise<{ id: string }> };

// POST /api/billing/orders/[id]/setup — { operations: ["order-action", "billing-treatment", "tax-treatment", "billing-start-month", "billing-end-date"], stateToken }.
// Idempotently creates/reuses the order's Order Action and applies Order Product Billing and Tax Treatments (and annual lines' billing start month),
// in one all-or-nothing Salesforce transaction. Never overwrites or duplicates existing records.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return orderBillingMutation(req, (client, body) => {
    const ops = (Array.isArray(body.operations) ? body.operations : []).filter((o): o is OrderSetupOperation => o === "order-action" || o === "billing-treatment" || o === "tax-treatment" || o === "billing-start-month" || o === "billing-end-date");
    return applyOrderBillingSetup(client, id, { operations: ops.length ? ops : ["order-action", "billing-treatment", "tax-treatment", "billing-start-month", "billing-end-date"], stateToken: tokenOf(body) });
  }, "Failed to apply the order's billing setup");
}
