import { NextRequest, NextResponse } from "next/server";
import { SalesforceError } from "@/lib/salesforce/client";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import { verifyTierSchedule } from "@/lib/pricing-rules/tier-based/create/verifyTierSchedule";

/**
 * POST /api/pricing-rules/tier-based/verify-tier-schedule
 *
 * Manual "Diagnose" action (Section 9, bug #1 fix) — read-only, traces the VolumeTierDiscount BKM's own
 * filter predicates against the PriceAdjustmentSchedule/PriceAdjustmentTier records for a user-supplied
 * scheduleId + quantity. The create pipeline already calls the same underlying logic automatically right
 * after tier creation; this route exists so a schedule created in an earlier session (or one whose
 * automatic self-check warned) can be re-diagnosed on demand without recreating anything.
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let scheduleId: string;
  let quantity: number;
  try {
    const body = await req.json();
    if (typeof body.scheduleId !== "string" || !body.scheduleId.trim()) {
      return NextResponse.json({ error: "scheduleId is required." }, { status: 400 });
    }
    if (typeof body.quantity !== "number" || !Number.isFinite(body.quantity)) {
      return NextResponse.json({ error: "quantity (number) is required." }, { status: 400 });
    }
    scheduleId = body.scheduleId.trim();
    quantity = body.quantity;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await verifyTierSchedule(client, { scheduleId, quantity });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SalesforceError) {
      const bodyStr = JSON.stringify(err.body ?? "");
      if (err.status === 401 || bodyStr.includes("INVALID_SESSION_ID")) {
        return NextResponse.json({ error: "Your Salesforce session has expired. Please reconnect and try again.", code: "TOKEN_EXPIRED" }, { status: 401 });
      }
      return NextResponse.json({ error: `Salesforce request failed: ${err.message}` }, { status: 502 });
    }
    console.error("[pricing-rules/tier-based/verify-tier-schedule] Unhandled error:", err);
    return NextResponse.json({ error: "An unexpected error occurred while diagnosing this schedule." }, { status: 500 });
  }
}
