import type { NextRequest } from "next/server";
import { rampRoute } from "@/lib/ramp/server/context";
import { capabilities } from "@/lib/ramp/server/reads";

// GET /api/ramp/capabilities — what THIS org supports for ramps (from its own Describe) + where RAMP history is stored. Read-only.
export async function GET(req: NextRequest) {
  return rampRoute(req, async ctx => ({ success: true, capabilities: await capabilities(ctx.api), storage: ctx.store.durability(), orgId: ctx.orgId, userId: ctx.userId, username: ctx.username, instanceUrl: ctx.api.instanceUrl }), "Failed to read RAMP capabilities");
}
