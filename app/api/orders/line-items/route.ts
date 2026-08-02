import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";

// DELETE /api/orders/line-items — bulk delete, best-effort per-record (§4.8):
// a failure on one record must not silently fail or block the others.
export async function DELETE(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let ids: string[];
  try {
    ({ ids } = await req.json());
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "ids array is required" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const results = await client.compositeDelete(ids, false);
    const perRecord = results.map((r, i) => ({ id: ids[i], success: r.success, error: r.success ? null : (r.errors?.[0]?.message ?? "Unknown error") }));
    return NextResponse.json({ success: true, results: perRecord });
  } catch (err) {
    return sfErrorResponse(err, "Failed to delete order line items");
  }
}
