import type { NextRequest } from "next/server";
import { lifecycleRoute } from "@/lib/assetLifecycle/server/context";
import { executeStep, LifecycleInputError } from "@/lib/assetLifecycle/server/service";
import { STEP_ORDER } from "@/lib/assetLifecycle/plan";
import type { StepId } from "@/lib/assetLifecycle/types";

type Params = { params: Promise<{ id: string }> };

// POST /api/asset-lifecycle/[id]/step { step, confirmed } — run ONE lifecycle step. Steps that write to Salesforce are refused unless
// `confirmed: true` (the UI sends it only from its confirmation dialog); steps run strictly in order.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return lifecycleRoute(req, async (ctx, body) => {
    const step = body.step as StepId;
    if (!STEP_ORDER.includes(step)) throw new LifecycleInputError("Unknown step.");
    const transaction = await executeStep(ctx, id, step, body.confirmed === true, ctx.deps, { activationConfirmed: body.activationConfirmed === true });
    return { success: true, transaction };
  }, "The lifecycle step failed");
}
