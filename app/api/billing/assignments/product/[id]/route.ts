import { NextRequest, NextResponse } from "next/server";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { loadProductBilling } from "@/lib/billing/server/assignment";
import { billingErrorResponse } from "@/lib/billing/server/errors";

type Params = { params: Promise<{ id: string }> };

// GET /api/billing/assignments/product/[id] — a Product with its Revenue Cloud Billing chain
// (assigned Billing Policy → default treatment → items), read live from Salesforce.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { id } = await params;
  try {
    return NextResponse.json(await loadProductBilling(auth.client, id));
  } catch (err) {
    if (err instanceof Error && /not found|Invalid Product/.test(err.message)) return NextResponse.json({ error: err.message, code: "NOT_FOUND" }, { status: 404 });
    return billingErrorResponse(err, "Failed to load the product's billing configuration", { objectLabel: "Product" });
  }
}
