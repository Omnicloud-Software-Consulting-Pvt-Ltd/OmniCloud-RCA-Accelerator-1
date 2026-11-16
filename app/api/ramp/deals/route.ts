import type { NextRequest } from "next/server";
import { RampInputError, rampRoute } from "@/lib/ramp/server/context";
import { RampServiceError, deleteDeal, saveDeal } from "@/lib/ramp/server/service";
import type { RampDealDraft } from "@/lib/ramp/types";

// /api/ramp/deals — line and group ramp deal drafts (application records linked to Salesforce Ids). Saving writes NOTHING to
// Salesforce; Salesforce writes happen only when an execution is started with confirmation (/api/ramp/executions).
const wrap = async <T,>(f: () => Promise<T>) => { try { return await f(); } catch (e) { if (e instanceof RampServiceError) throw new RampInputError(e.message); throw e; } };

export async function GET(req: NextRequest) {
  return rampRoute(req, async ctx => {
    const d = await ctx.store.load(ctx.orgId);
    const kind = req.nextUrl.searchParams.get("kind");
    const rows = d.deals.filter(x => !kind || x.kind === kind).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(x => ({ ...x, execution: x.executionId ? (({ steps, ...rest }) => ({ ...rest, step: steps.find(s => s.status !== "completed" && s.status !== "skipped")?.label ?? null }))(d.executions.find(e => e.id === x.executionId)!) : null }));
    return { success: true, rows };
  }, "Failed to load ramp deals");
}
export async function POST(req: NextRequest) {
  return rampRoute(req, async (ctx, b) => wrap(async () => ({ success: true, deal: await saveDeal(ctx, b.deal as Partial<RampDealDraft>) })), "Failed to save the ramp deal");
}
export async function DELETE(req: NextRequest) {
  return rampRoute(req, async ctx => wrap(async () => { await deleteDeal(ctx, req.nextUrl.searchParams.get("id") ?? ""); return { success: true }; }), "Failed to delete the ramp deal");
}
