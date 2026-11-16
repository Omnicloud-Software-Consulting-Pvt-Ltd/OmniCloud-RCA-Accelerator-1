import type { NextRequest } from "next/server";
import { RampInputError, rampRoute } from "@/lib/ramp/server/context";
import { RampServiceError, deleteSchedule, saveSchedule } from "@/lib/ramp/server/service";
import type { RampSchedule } from "@/lib/ramp/types";

// /api/ramp/schedules — application-managed ramp schedule templates (Salesforce has no ramp schedule object). No Salesforce writes.
export async function GET(req: NextRequest) {
  return rampRoute(req, async ctx => {
    const d = await ctx.store.load(ctx.orgId);
    return { success: true, rows: [...d.schedules].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), history: d.history.filter(h => h.kind === "schedule").slice(-50).reverse() };
  }, "Failed to load ramp schedules");
}
export async function POST(req: NextRequest) {
  return rampRoute(req, async (ctx, b) => {
    try { return { success: true, schedule: await saveSchedule(ctx, b.schedule as Partial<RampSchedule>) }; } catch (e) { if (e instanceof RampServiceError) throw new RampInputError(e.message); throw e; }
  }, "Failed to save the ramp schedule");
}
export async function DELETE(req: NextRequest) {
  return rampRoute(req, async ctx => {
    const id = req.nextUrl.searchParams.get("id") ?? "";
    try { await deleteSchedule(ctx, id); return { success: true }; } catch (e) { if (e instanceof RampServiceError) throw new RampInputError(e.message); throw e; }
  }, "Failed to delete the ramp schedule");
}
