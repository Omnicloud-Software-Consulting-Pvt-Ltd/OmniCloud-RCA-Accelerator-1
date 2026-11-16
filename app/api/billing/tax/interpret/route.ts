import type { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropicKey } from "@/lib/config";
import { callClaude, describeBillingAiError } from "@/lib/billing/server/ai";
import { interpretTaxConfigPrompt } from "@/lib/tax/server/ai";
import { AiServiceError, noAiKeyResponse, taxRoute } from "@/lib/tax/server/route";
import { SalesforceCallError } from "@/lib/billing/server/billingDocuments";
import { SalesforceError } from "@/lib/salesforce/client";

// POST /api/billing/tax/interpret — { prompt }. Claude turns the prompt into a tax configuration spec (names, taxability, rates,
// codes, products — never Ids); the spec is then resolved against the connected org and returned with its preview. Never writes.
export async function POST(req: NextRequest) {
  const apiKey = resolveAnthropicKey(req);
  if (!apiKey) return noAiKeyResponse();
  const anthropic = new Anthropic({ apiKey });
  return taxRoute(req, async (client, body) => {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 4000) : "";
    if (!prompt) return { success: false, requiresInput: true, message: "Describe the tax configuration, e.g. \"Create an India GST configuration for Laptop with 18% GST using the standard tax engine.\"" };
    try {
      return await interpretTaxConfigPrompt(client, (system, p) => callClaude(anthropic, system, p, 1500), prompt);
    } catch (err) {
      if (err instanceof SalesforceCallError || err instanceof SalesforceError) throw err;
      const { status, message } = describeBillingAiError(err);
      throw new AiServiceError(status === 503 ? 503 : 502, status === 503 ? "AI_KEY_REJECTED" : "AI_ERROR", status === 503 ? "The Anthropic API key was rejected (invalid or expired). Update it in Setup." : message);
    }
  }, "Tax request analysis failed");
}
