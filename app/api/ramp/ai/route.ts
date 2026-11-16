import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropicKey } from "@/lib/config";
import { RampInputError, rampRoute } from "@/lib/ramp/server/context";
import { aiRampDraft } from "@/lib/ramp/server/ai";

// POST /api/ramp/ai { prompt } — AI Ramp Builder: prompt → editable deal draft. Uses the user's own Setup key server-side (never sent
// to the browser); Salesforce is only READ to resolve names. Nothing is saved or executed here.
export async function POST(req: NextRequest) {
  const apiKey = resolveAnthropicKey(req);
  if (!apiKey) return NextResponse.json({ success: false, error: "Anthropic API key not configured. Complete Setup to add your key.", code: "NO_AI_KEY" }, { status: 503 });
  return rampRoute(req, async (ctx, b) => {
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    if (!prompt) throw new RampInputError("Describe the ramp you want to create.");
    if (prompt.length > 4000) throw new RampInputError("Prompt is too long (4,000 characters max).");
    return { success: true, ...(await aiRampDraft(ctx.api, new Anthropic({ apiKey }), prompt)) };
  }, "The AI Ramp Builder couldn't build a draft");
}
