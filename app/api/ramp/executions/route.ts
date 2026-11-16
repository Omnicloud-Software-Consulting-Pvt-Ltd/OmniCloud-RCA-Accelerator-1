import type { NextRequest } from "next/server";
import { RampInputError, rampRoute } from "@/lib/ramp/server/context";
import { RampServiceError, getExecution, retryExecution, startExecution, stepExecution } from "@/lib/ramp/server/service";

/**
 * /api/ramp/executions — server-side, resumable ramp execution.
 *  GET  (?id=)                          list (or one, with interruption detection)
 *  POST { action: "start", dealId, confirmed: true }  create the run (no Salesforce write yet)
 *  POST { action: "step", id }          run ONE step against Salesforce and persist the checkpoint (the client calls again until done)
 *  POST { action: "retry", id }         re-run a failed / interrupted step (it re-reads Salesforce before writing)
 */
export const maxDuration = 60;
const wrap = async <T,>(f: () => Promise<T>) => { try { return await f(); } catch (e) { if (e instanceof RampServiceError) throw new RampInputError(e.message); throw e; } };

export async function GET(req: NextRequest) {
  return rampRoute(req, async ctx => wrap(async () => {
    const id = req.nextUrl.searchParams.get("id");
    if (id) {
      const ex = await getExecution(ctx, id);
      const d = await ctx.store.load(ctx.orgId);
      return { success: true, execution: ex, deal: d.deals.find(x => x.id === ex.dealId) ?? null };
    }
    const d = await ctx.store.load(ctx.orgId);
    const rows = [...d.executions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(e => ({ ...e, steps: e.steps.map(({ calls, ...s }) => ({ ...s, calls: calls.length })), deal: d.deals.find(x => x.id === e.dealId) ?? null }));
    return { success: true, rows };
  }), "Failed to load ramp executions");
}

export async function POST(req: NextRequest) {
  return rampRoute(req, async (ctx, b) => wrap(async () => {
    const action = b.action;
    if (action === "start") return { success: true, execution: await startExecution(ctx, String(b.dealId ?? ""), b.confirmed === true) };
    if (action === "step") return { success: true, execution: await stepExecution(ctx, ctx.api, String(b.id ?? "")) };
    if (action === "retry") return { success: true, execution: await retryExecution(ctx, String(b.id ?? "")) };
    throw new RampServiceError("action must be start, step or retry.");
  }), "Failed to run the ramp execution");
}
