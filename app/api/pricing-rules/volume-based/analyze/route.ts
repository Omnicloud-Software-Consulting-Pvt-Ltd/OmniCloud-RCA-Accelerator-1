import { NextRequest, NextResponse } from "next/server";
import { SalesforceError } from "@/lib/salesforce/client";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { resolveAnthropicKey } from "@/lib/config";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import { analyzeVolumeBasedPrompt } from "@/lib/pricing-rules/volume-based/analyze";
import type { ExtractedVolumePricingRequirement, VolumeTier } from "@/lib/pricing-rules/volume-based/types";

/**
 * POST /api/pricing-rules/volume-based/analyze
 *
 * Read-only end to end — mirrors /api/pricing-rules/bundle-based/analyze: AI extraction -> product
 * verification -> tier validation -> preview. Never creates, updates, or deletes a Salesforce record.
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let prompt: string | undefined;
  let extracted: ExtractedVolumePricingRequirement | undefined;
  let selectedProductId: string | undefined;
  let tierOverrides: VolumeTier[] | undefined;
  let basePriceOverride: number | undefined;

  try {
    const body = await req.json();
    if (typeof body.prompt === "string" && body.prompt.trim()) prompt = body.prompt;
    if (body.extracted && typeof body.extracted === "object") extracted = body.extracted as ExtractedVolumePricingRequirement;
    if (typeof body.selectedProductId === "string" && body.selectedProductId.trim()) selectedProductId = body.selectedProductId;
    if (Array.isArray(body.tierOverrides)) tierOverrides = body.tierOverrides as VolumeTier[];
    if (typeof body.basePriceOverride === "number") basePriceOverride = body.basePriceOverride;

    if (!prompt && !extracted) {
      return NextResponse.json({ error: "A prompt (or a previous extraction to re-validate) is required." }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  let apiKey: string | null = null;
  if (!extracted) {
    apiKey = resolveAnthropicKey(req);
    if (!apiKey) {
      return NextResponse.json(
        { error: "Anthropic API key not configured. Complete Setup to add your key.", code: "NO_AI_KEY" },
        { status: 503 },
      );
    }
  }

  try {
    const result = await analyzeVolumeBasedPrompt(client, apiKey ?? "", { prompt, extracted, selectedProductId, tierOverrides, basePriceOverride });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SalesforceError) {
      const bodyStr = JSON.stringify(err.body ?? "");
      if (err.status === 401 || bodyStr.includes("INVALID_SESSION_ID")) {
        return NextResponse.json({ error: "Your Salesforce session has expired. Please reconnect and try again.", code: "TOKEN_EXPIRED" }, { status: 401 });
      }
      return NextResponse.json(
        { stage: "salesforce-error", error: `Salesforce request failed: ${err.message}`, steps: [] },
        { status: 502 },
      );
    }
    console.error("[pricing-rules/volume-based/analyze] Unhandled error:", err);
    return NextResponse.json(
      { stage: "salesforce-error", error: "An unexpected error occurred while analyzing this pricing requirement. Nothing was created — please try again.", steps: [] },
      { status: 500 },
    );
  }
}
