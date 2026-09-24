import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { checkBundleDuplicate } from "@/lib/bundles/server/duplicateCheck";
import type { DuplicateCheckResult } from "@/lib/duplicateDetection";

interface CheckItem {
  key: string;
  name: string;
  code?: string;
  excludeId?: string;
}

/**
 * POST /api/bundles/check-duplicate — the Bundle counterpart to
 * /api/sf/products/check-duplicate (same batch shape, same advisory-only
 * role). Used by BundleOrchestrationWorkspace (single pre-check before
 * /api/bundles/execute) and BundleImportWizard (one batched check covering
 * every parsed bundle GROUP — never one request per component row, §15).
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
      results[item.key ?? item.name] = await checkBundleDuplicate(auth.client, {
        name: item.name, code: item.code, excludeId: item.excludeId,
      });
    }
    return NextResponse.json({ success: true, results });
  } catch (err) {
    return sfErrorResponse(err, "Failed to check for duplicate bundles");
  }
}
