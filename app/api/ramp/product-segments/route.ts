import type { NextRequest } from "next/server";
import { RampInputError, rampRoute, requireId } from "@/lib/ramp/server/context";
import { createProductRampSegment } from "@/lib/ramp/server/productSegments";
import { recordEvent } from "@/lib/ramp/server/service";

// POST /api/ramp/product-segments — create ONE ProductRampSegment after the user's explicit confirmation (confirmed: true).
// Duplicate-checked against Salesforce right before the insert, then read back. The attempt (success or failure) goes to RAMP history.
export async function POST(req: NextRequest) {
  return rampRoute(req, async (ctx, b) => {
    if (b.confirmed !== true) throw new RampInputError("Creating a Product Ramp Segment writes to Salesforce — confirm it first (confirmed: true).");
    const productId = requireId(b.productId, "productId", "01t"), sellingModelId = requireId(b.sellingModelId, "sellingModelId", "0jP");
    const segmentType = typeof b.segmentType === "string" ? b.segmentType : "";
    const r = await createProductRampSegment(ctx.api, { productId, sellingModelId, segmentType, trialDuration: typeof b.trialDuration === "number" ? b.trialDuration : null, durationType: typeof b.durationType === "string" ? b.durationType : null });
    await recordEvent(ctx, { kind: "product-segment", action: r.reused ? "reused" : "create", status: r.ok ? "success" : "failed", summary: r.message, refs: { productId, salesforceId: r.segmentId }, detail: { calls: r.calls, input: { productId, sellingModelId, segmentType } } });
    return { success: r.ok, ...r };
  }, "Failed to create the Product Ramp Segment");
}
