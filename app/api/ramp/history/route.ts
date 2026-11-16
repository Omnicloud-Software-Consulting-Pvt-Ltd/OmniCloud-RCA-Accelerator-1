import type { NextRequest } from "next/server";
import { rampRoute } from "@/lib/ramp/server/context";
import { filterHistory } from "@/lib/ramp/server/service";

// GET /api/ramp/history — RAMP history for the connected org (server-side store), filtered + paginated. ?id= returns one event in full.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  return rampRoute(req, async ctx => {
    const d = await ctx.store.load(ctx.orgId);
    const id = p.get("id");
    if (id) return { success: true, event: d.history.find(h => h.id === id) ?? null };
    const g = (k: string) => p.get(k) || null;
    return { success: true, ...filterHistory(d.history, { kind: g("kind"), status: g("status"), q: g("q"), from: g("from"), to: g("to"), quoteId: g("quoteId"), accountId: g("accountId"), productId: g("productId"), dealId: g("dealId"), salesforceId: g("salesforceId"), page: Number(p.get("page") ?? 1), pageSize: Number(p.get("pageSize") ?? 25) }), storage: ctx.store.durability() };
  }, "Failed to load RAMP history");
}
