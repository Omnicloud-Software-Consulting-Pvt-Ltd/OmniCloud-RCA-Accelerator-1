import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, decodeSession } from "@/lib/salesforce/client";
import { resolveAnthropicKey } from "@/lib/config";
import type { CanvasStepPreview, PricingType } from "@/lib/pricing-rules/types";
import { parsePricingPrompt, computeAiConfidence } from "@/lib/pricing-rules/ai/parsePricingPrompt";

const CANVAS_PREVIEW_BY_TYPE: Partial<Record<PricingType, CanvasStepPreview[]>> = {
  "attribute-based": [
    { seq: 1, actionType: "PricingSettings", label: "Pricing Settings", description: "Initializes pricing context and effective date window" },
    { seq: 2, actionType: "ListPrice", label: "List Price", description: "Fetches base unit price from Standard Price Book" },
    { seq: 3, actionType: "AttributeBasedPrice", label: "Attribute Price", description: "Applies price adjustments based on configured product attribute values" },
  ],
};

const VALID_PRICING_TYPES: PricingType[] = ["tier-based", "volume-based", "attribute-based", "bundle-based"];

export async function POST(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE);
  const session = cookie?.value ? decodeSession(cookie.value) : null;
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let prompt: string;
  let knownPricingType: PricingType | null = null;
  try {
    const body = await req.json();
    prompt = body.prompt;
    if (!prompt?.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    if (typeof body.pricingType === "string" && (VALID_PRICING_TYPES as string[]).includes(body.pricingType)) {
      knownPricingType = body.pricingType as PricingType;
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const apiKey = resolveAnthropicKey(req);
  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic API key not configured. Complete Setup to add your key.", code: "NO_AI_KEY" },
      { status: 503 },
    );
  }

  try {
    const result = await parsePricingPrompt(apiKey, prompt, knownPricingType);
    const confidence = computeAiConfidence(result);
    const canvasPreview = result.pricingType ? CANVAS_PREVIEW_BY_TYPE[result.pricingType] ?? [] : [];
    return NextResponse.json({ success: true, result, confidence, canvasPreview });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
