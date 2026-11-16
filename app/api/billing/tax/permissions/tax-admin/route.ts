import { NextResponse, type NextRequest } from "next/server";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import { knownError } from "@/lib/billing/server/paymentsRoute";
import { assignTaxAdminToCurrentUser, getTaxAdminStatus } from "@/lib/tax/server/admin";
import { getTaxConnection } from "@/lib/tax/server/records";
import { taxRoute } from "@/lib/tax/server/route";

// GET /api/billing/tax/permissions/tax-admin — the connected org, the current Salesforce user and whether that user has Tax Admin.
export async function GET(req: NextRequest) {
  return taxRoute(req, async client => {
    const [connection, taxAdmin] = await Promise.all([getTaxConnection(client), getTaxAdminStatus(client)]);
    return { success: true, connection, taxAdmin };
  }, "Failed to read the Tax Admin permission");
}

// POST /api/billing/tax/permissions/tax-admin — { confirm: true }. Assigns Tax Admin to the CURRENT authenticated user of this
// connection only (no user is accepted from the request), when that user may assign permission sets; otherwise returns the
// admin instruction. Never changes another user's permissions.
export async function POST(req: NextRequest) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body.", code: "INVALID_REQUEST" }, { status: 400 }); }
  if (body.confirm !== true) return NextResponse.json({ error: "Confirm the permission assignment first.", code: "INVALID_REQUEST" }, { status: 400 });
  try {
    const { ok, status, ...rest } = await assignTaxAdminToCurrentUser(auth.client);
    return NextResponse.json({ success: ok, category: ok ? null : "permission", ...rest }, { status });
  } catch (err) {
    return knownError(err) ?? billingErrorResponse(err, "Failed to assign the Tax Admin permission", { objectLabel: "Permission Set Assignment" });
  }
}
