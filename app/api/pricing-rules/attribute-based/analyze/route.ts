import { NextRequest, NextResponse } from "next/server";
import { SalesforceError } from "@/lib/salesforce/client";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { resolveAnthropicKey } from "@/lib/config";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import { analyzeAttributeBasedPrompt } from "@/lib/pricing-rules/attribute-based/analyze";
import type { AttributeBasedMappingOverrides, ExtractedPricingRequirement } from "@/lib/pricing-rules/attribute-based/types";

/**
 * POST /api/pricing-rules/attribute-based/analyze
 *
 * Steps 1-9 of the new Attribute-Based Pricing flow: AI extraction ->
 * Product verification -> attribute discovery -> attribute/value
 * validation -> pricing-rule generation -> preview. Read-only end to end —
 * this route never creates, updates, or deletes a Salesforce record. All
 * Salesforce/AI credentials stay server-side; the client only ever sends a
 * prompt (or a previous extraction plus manual mappings) and receives a
 * structured result to render.
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let prompt: string | undefined;
  let extracted: ExtractedPricingRequirement | undefined;
  let selectedProductId: string | undefined;
  let overrides: AttributeBasedMappingOverrides | undefined;

  try {
    const body = await req.json();
    if (typeof body.prompt === "string" && body.prompt.trim()) prompt = body.prompt;
    if (body.extracted && typeof body.extracted === "object") extracted = body.extracted as ExtractedPricingRequirement;
    if (typeof body.selectedProductId === "string" && body.selectedProductId.trim()) selectedProductId = body.selectedProductId;
    if (body.overrides && typeof body.overrides === "object") overrides = body.overrides as AttributeBasedMappingOverrides;

    if (!prompt && !extracted) {
      return NextResponse.json({ error: "A prompt (or a previous extraction to re-validate) is required." }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // The AI is only needed for a first-time prompt parse — a mapping-correction
  // round-trip resubmits the already-extracted requirement and skips it.
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
    const result = await analyzeAttributeBasedPrompt(client, apiKey ?? "", { prompt, extracted, selectedProductId, overrides });
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
    console.error("[pricing-rules/attribute-based/analyze] Unhandled error:", err);
    return NextResponse.json(
      { stage: "salesforce-error", error: "An unexpected error occurred while analyzing this pricing requirement. Nothing was created — please try again.", steps: [] },
      { status: 500 },
    );
  }
}
