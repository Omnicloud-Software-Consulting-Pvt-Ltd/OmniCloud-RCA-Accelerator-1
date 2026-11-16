import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropicKey } from "@/lib/config";
import { RampInputError, optionalId, rampRoute } from "@/lib/ramp/server/context";
import { aiRampForm, type RampAiContext } from "@/lib/ramp/server/aiForms";
import { RAMP_AI_FORMS, type RampAiForm } from "@/lib/ramp/aiSchema";

/**
 * POST /api/ramp/ai/form { form, prompt, context } — AI assistance for one RAMP form (product-segment | schedule | deal | group-deal).
 * The user's own Setup key is used server-side (never sent to the browser). Salesforce is only READ (names → records); the AI output
 * is schema-validated; NOTHING is saved, created or executed — the client fills the existing form for review.
 */
export async function POST(req: NextRequest) {
  const apiKey = resolveAnthropicKey(req);
  if (!apiKey) return NextResponse.json({ success: false, error: "Anthropic API key not configured. Complete Setup to add your key.", code: "NO_AI_KEY" }, { status: 503 });
  return rampRoute(req, async (ctx, b) => {
    const form = b.form as RampAiForm;
    if (!RAMP_AI_FORMS.includes(form)) throw new RampInputError(`form must be one of ${RAMP_AI_FORMS.join(", ")}.`);
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    if (!prompt) throw new RampInputError("Describe what you want to configure.");
    if (prompt.length > 4000) throw new RampInputError("Prompt is too long (4,000 characters max).");
    const c = (b.context && typeof b.context === "object" ? b.context : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 255) : null);
    const context: RampAiContext = {
      name: str(c.name), accountName: str(c.accountName), quoteName: str(c.quoteName), groupName: str(c.groupName), productName: str(c.productName),
      accountId: optionalId(c.accountId, "context.accountId", "001"), quoteId: optionalId(c.quoteId, "context.quoteId", "0Q0"), lineId: optionalId(c.lineId, "context.lineId", "0QL"),
      groupId: optionalId(c.groupId, "context.groupId"), productId: optionalId(c.productId, "context.productId", "01t"), scheduleSet: c.scheduleSet === true,
    };
    const schedules = form === "deal" || form === "group-deal" ? (await ctx.store.load(ctx.orgId)).schedules : [];
    return { success: true, ...(await aiRampForm(ctx.api, new Anthropic({ apiKey }), form, prompt, context, schedules)) };
  }, "The AI assistant couldn't generate a configuration");
}
