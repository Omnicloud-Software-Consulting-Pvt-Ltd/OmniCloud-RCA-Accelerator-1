import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { checkProductDuplicate } from "@/lib/products/server/duplicateCheck";
import type { DuplicateCheckResult } from "@/lib/duplicateDetection";

interface CheckItem {
  key: string;
  name: string;
  code?: string;
  excludeId?: string;
}

/**
 * POST /api/sf/products/check-duplicate — the frontend pre-check for the
 * Duplicate Prevention system (§1-5, §12, §20). Accepts a batch of items
 * (`{items:[{key,name,code,excludeId}]}`) so a single request can cover
 * both a lone prompt-based create AND every row of a bulk import/multi-
 * product wizard. `excludeId` is the record's own Id during an Edit save,
 * so a record never flags its own unchanged name/code (§25). This route is
 * advisory only — POST /api/sf/products/save re-runs the identical check
 * server-side as the final, race-condition-safe gate before ever creating
 * a record (§21).
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let items: CheckItem[];
  try {
    const body = await req.json();
    items = Array.isArray(body.items) ? body.items : [body];
    if (items.length === 0 || items.some(i => !i?.name)) {
      return NextResponse.json({ error: "Each item requires a name" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const results: Record<string, DuplicateCheckResult> = {};
    for (const item of items) {
      results[item.key ?? item.name] = await checkProductDuplicate(auth.client, {
        name: item.name, code: item.code, excludeId: item.excludeId,
      });
    }
    return NextResponse.json({ success: true, results });
  } catch (err) {
    return sfErrorResponse(err, "Failed to check for duplicate products");
  }
}
