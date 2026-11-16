import { NextRequest, NextResponse } from "next/server";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { checkAssignment } from "@/lib/billing/server/assignment";
import { billingErrorResponse } from "@/lib/billing/server/errors";

// POST /api/billing/assignments/check — { productId?, policyId?, allowReplace? }. Dry-run of the
// assignment: live existing-policy check, billing-chain validation (Policy → Treatment → Item),
// and the conflict payload when the product already has a different policy. Writes nothing.
export async function POST(req: NextRequest) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let body: { productId?: unknown; policyId?: unknown; allowReplace?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body", code: "INVALID_REQUEST" }, { status: 400 }); }
  try {
    return NextResponse.json(await checkAssignment(auth.client, {
      productId: typeof body.productId === "string" ? body.productId : null,
      policyId: typeof body.policyId === "string" ? body.policyId : null,
      allowReplace: body.allowReplace === true,
    }));
  } catch (err) {
    return billingErrorResponse(err, "Failed to validate the assignment", { objectLabel: "Product" });
  }
}
