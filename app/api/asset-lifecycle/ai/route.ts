import type { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropicKey } from "@/lib/config";
import { lifecycleRoute } from "@/lib/assetLifecycle/server/context";
import { aiLifecycleDraft } from "@/lib/assetLifecycle/server/ai";
import { LifecycleInputError, parseKind } from "@/lib/assetLifecycle/server/service";

// POST /api/asset-lifecycle/ai { prompt, kind? } — natural language → an EDITABLE prefill for the lifecycle wizard. The user's own
// Setup key is used server-side (never sent to the browser); without one, the built-in rules parser is used and the response says
// so. Salesforce is only READ (names → records). Nothing is saved and nothing is sent to Salesforce here.
export async function POST(req: NextRequest) {
  const apiKey = resolveAnthropicKey(req);
  return lifecycleRoute(req, async ({ api, today }, body) => {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) throw new LifecycleInputError("Describe the amendment, renewal or cancellation.");
    if (prompt.length > 4000) throw new LifecycleInputError("The prompt is too long (4,000 characters max).");
    const kind = body.kind ? parseKind(body.kind) : null;
    return { success: true, aiConfigured: !!apiKey, ...(await aiLifecycleDraft(api, prompt, kind, today, apiKey ? new Anthropic({ apiKey }) : null)) };
  }, "The prompt couldn't be interpreted");
}
