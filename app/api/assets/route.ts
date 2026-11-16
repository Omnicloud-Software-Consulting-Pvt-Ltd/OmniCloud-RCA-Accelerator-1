import type { NextRequest } from "next/server";
import { idParam, lifecycleRoute } from "@/lib/assetLifecycle/server/context";
import { listAssets } from "@/lib/assetLifecycle/server/reads";
import type { AssetState } from "@/lib/assetLifecycle/types";

const STATES: (AssetState | "all")[] = ["all", "active", "expiring", "expired", "future", "cancelled", "unmanaged"];
const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// GET /api/assets — READ-ONLY asset discovery shared by Assets, Amendments, Renewals and Cancellations: search, filters (account,
// contract, product, lifecycle state, expiry window), sorting and pagination, with lifecycle eligibility for every row.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  return lifecycleRoute(req, async ({ api, today }) => {
    const state = p.get("state");
    return {
      success: true,
      ...(await listAssets(api, {
        ids: (p.get("ids") ?? "").split(",").filter(Boolean).map(x => idParam(x, "ids")!).slice(0, 200), accountId: idParam(p.get("accountId"), "accountId"), contractId: idParam(p.get("contractId"), "contractId"), productId: idParam(p.get("productId"), "productId"),
        q: (p.get("q") ?? "").slice(0, 80), state: STATES.includes(state as AssetState) ? (state as AssetState) : "all", lifecycleOnly: p.get("lifecycleOnly") !== "0",
        expiresFrom: date(p.get("expiresFrom")), expiresTo: date(p.get("expiresTo")),
        sort: p.get("sort"), dir: p.get("dir") === "desc" ? "desc" : "asc", page: Number(p.get("page") ?? 1) || 1, pageSize: Number(p.get("pageSize") ?? 25) || 25,
      }, today)),
    };
  }, "Failed to load assets");
}
