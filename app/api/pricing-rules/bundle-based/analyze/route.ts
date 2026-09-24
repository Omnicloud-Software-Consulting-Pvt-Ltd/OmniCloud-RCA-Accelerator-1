import { NextRequest, NextResponse } from "next/server";
import { SalesforceError } from "@/lib/salesforce/client";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { resolveAnthropicKey } from "@/lib/config";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import { analyzeBundleBasedPrompt } from "@/lib/pricing-rules/bundle-based/analyze";
import type { BundleBasedMappingOverrides, ExtractedBundlePricingRequirement } from "@/lib/pricing-rules/bundle-based/types";

/**
 * POST /api/pricing-rules/bundle-based/analyze
 *
 * Read-only end to end — mirrors /api/pricing-rules/attribute-based/analyze exactly: AI extraction ->
 * bundle verification -> component discovery/validation -> pricing-rule generation -> preview. Never
 * creates, updates, or deletes a Salesforce record.
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let prompt: string | undefined;
  let extracted: ExtractedBundlePricingRequirement | undefined;
  let selectedBundleId: string | undefined;
  let overrides: BundleBasedMappingOverrides | undefined;

  try {
    const body = await req.json();
    if (typeof body.prompt === "string" && body.prompt.trim()) prompt = body.prompt;
    if (body.extracted && typeof body.extracted === "object") extracted = body.extracted as ExtractedBundlePricingRequirement;
    if (typeof body.selectedBundleId === "string" && body.selectedBundleId.trim()) selectedBundleId = body.selectedBundleId;
    if (body.overrides && typeof body.overrides === "object") overrides = body.overrides as BundleBasedMappingOverrides;

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
    const result = await analyzeBundleBasedPrompt(client, apiKey ?? "", { prompt, extracted, selectedBundleId, overrides });
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
    console.error("[pricing-rules/bundle-based/analyze] Unhandled error:", err);
    return NextResponse.json(
      { stage: "salesforce-error", error: "An unexpected error occurred while analyzing this pricing requirement. Nothing was created — please try again.", steps: [] },
      { status: 500 },
    );
  }
}
