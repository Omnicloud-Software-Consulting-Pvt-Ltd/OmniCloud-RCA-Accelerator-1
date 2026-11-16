import type { NextRequest } from "next/server";
import { lifecycleRoute, requireIdParam } from "@/lib/assetLifecycle/server/context";
import { assetDetail } from "@/lib/assetLifecycle/server/reads";

type Params = { params: Promise<{ id: string }> };

// GET /api/assets/[id] — READ-ONLY asset detail: lifecycle facts + eligibility, Asset Actions (with sources / origin orders), Asset
// State Periods, attributes, contracts, Revenue Cloud billing and every lifecycle quote / order that referenced the asset.
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return lifecycleRoute(req, async ({ api, today }) => {
    const detail = await assetDetail(api, requireIdParam(id, "asset id"), today);
    if (!detail) return { success: false, error: "Asset not found (or not visible to your user)." };
    return { success: true, ...detail };
  }, "Failed to load the asset");
}
