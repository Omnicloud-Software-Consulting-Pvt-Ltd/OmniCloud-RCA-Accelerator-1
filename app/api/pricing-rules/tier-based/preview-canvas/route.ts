import { NextRequest, NextResponse } from "next/server";
import { SalesforceError } from "@/lib/salesforce/client";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import { buildTierCanvas } from "@/lib/pricing-rules/tier-based/create/canvasBuilder";

/**
 * POST /api/pricing-rules/tier-based/preview-canvas
 *
 * READ-ONLY canvas preview — calls the existing, already-pure `buildTierCanvas()` directly and nothing
 * else. Does NOT call `runCreateTierPricingPipeline()`, `createPriceAdjustmentSchedule()`,
 * `createPriceAdjustmentTiers()`, or `deployExpressionSetDefinition()` — no PriceAdjustmentSchedule/Tier is
 * created, no Expression Set is deployed, nothing is activated. Exists so the donor resolution + Expression
 * Set composition/validation logic can be re-tested after a `canvasBuilder.ts` fix without creating another
 * Schedule/Tier set.
 *
 * Call chain (verified, every hop): buildTierCanvas -> resolveTierBasedPricingDonor -> ONLY
 * `retrieveVersionScopedExpressionSetDefinitionFiles` (Metadata API `retrieve`/`checkRetrieveStatus` — the
 * read side of the Metadata API, never `deploy`) and `client.logDebug` (in-memory only); and
 * buildTierCanvas's own local `resolveDecisionTable` -> ONLY `client.describeObject` and `client.query`
 * (SOQL SELECT). None of `client.createRecord`/`updateRecord`/any delete/metadata-deploy method is ever
 * reachable from this call chain.
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let procedureName: string;
  let apiName: string;
  let description: string | undefined;
  let versionNumber: number | undefined;
  let rank: number | null | undefined;

  try {
    const body = await req.json();
    if (typeof body.procedureName !== "string" || !body.procedureName.trim()) {
      return NextResponse.json({ error: "procedureName is required" }, { status: 400 });
    }
    if (typeof body.apiName !== "string" || !body.apiName.trim()) {
      return NextResponse.json({ error: "apiName is required" }, { status: 400 });
    }
    procedureName = body.procedureName;
    apiName = body.apiName;
    if (typeof body.description === "string") description = body.description;
    if (typeof body.versionNumber === "number") versionNumber = body.versionNumber;
    if (typeof body.rank === "number" || body.rank === null) rank = body.rank;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const progressPhases: string[] = [];

  try {
    const canvas = await buildTierCanvas(client, {
      procedureName, apiName, description, versionNumber, rank,
      onProgress: phase => { progressPhases.push(phase); },
    });

    return NextResponse.json({
      success: canvas.success,
      readOnly: true,
      deployed: false,
      recordsCreated: false,
      progressPhases,
      canvas,
    });
  } catch (err) {
    if (err instanceof SalesforceError) {
      const bodyStr = JSON.stringify(err.body ?? "");
      if (err.status === 401 || bodyStr.includes("INVALID_SESSION_ID")) {
        return NextResponse.json({ error: "Your Salesforce session has expired. Please reconnect and try again.", code: "TOKEN_EXPIRED", readOnly: true, deployed: false, recordsCreated: false }, { status: 401 });
      }
      return NextResponse.json(
        { error: `Salesforce request failed: ${err.message}`, readOnly: true, deployed: false, recordsCreated: false },
        { status: 502 },
      );
    }
    console.error("[pricing-rules/tier-based/preview-canvas] Unhandled error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred while previewing this Expression Set canvas. Nothing was created or deployed.", readOnly: true, deployed: false, recordsCreated: false },
      { status: 500 },
    );
  }
}
