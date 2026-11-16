import type { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropicKey } from "@/lib/config";
import { callClaude, describeBillingAiError } from "@/lib/billing/server/ai";
import { interpretAssistantPrompt, assistantObject } from "@/lib/tax/server/assistantAi";
import { AiServiceError, taxRoute } from "@/lib/tax/server/route";
import { SalesforceCallError } from "@/lib/billing/server/billingDocuments";
import { SalesforceError } from "@/lib/salesforce/client";
import { answerTaxQuery, parseTaxQuery } from "@/lib/tax/server/taxQuery";
import { resolveCalculationQuery } from "@/lib/tax/server/calculationAi";

// POST /api/taxes/assistant/interpret — { prompt, object?, form? } (object: the tax object of the create page the prompt was typed on;
// form: return that one record's values for the page's create form instead of previewed operations).
//  · Tax CALCULATION / verification requests (a product, an order, an invoice, "what is missing", "is the decision table current"…):
//    interpreted by the AI when a key is configured (intent + references only, every value grounded in the prompt), else by the built-in
//    rules — the response says which, and why — then answered by the deterministic tax services from real Salesforce records.
//  · CONFIGURATION requests (create / update / assign / lifecycle / delete / show tax records): Claude turns them into previewed operations.
// Never writes.
export async function POST(req: NextRequest) {
  const apiKey = resolveAnthropicKey(req);
  const anthropic = apiKey ? new Anthropic({ apiKey }) : null;
  return taxRoute(req, async (client, body) => {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 4000) : "";
    if (!prompt) return { success: false, requiresInput: true, message: "Describe what to do, e.g. \"Calculate tax for <product> for <customer account>\" or \"Show me the current configuration of <policy>\"." };
    if (!body.object) {
      const det = parseTaxQuery(prompt);
      const r = await resolveCalculationQuery({ prompt, det, call: anthropic ? (system, p) => callClaude(anthropic, system, p, 800) : null, classify: describeBillingAiError });
      if (r.query) return { success: true, mode: "query", query: r.query, interpretation: r.info, answer: await answerTaxQuery(client, r.query) };
      if (r.error) throw new AiServiceError(r.error.status, r.error.code, r.error.message);
    }
    if (!anthropic) throw new AiServiceError(503, "NO_AI_KEY", "Anthropic API key not configured. Complete Setup to add your key.");
    try {
      return await interpretAssistantPrompt(client, (system, p) => callClaude(anthropic, system, p, 2000), prompt, { object: assistantObject(body.object), form: body.form === true });
    } catch (err) {
      if (err instanceof SalesforceCallError || err instanceof SalesforceError) throw err;
      const { status, message } = describeBillingAiError(err);
      throw new AiServiceError(status === 503 ? 503 : 502, status === 503 ? "AI_KEY_REJECTED" : "AI_ERROR", status === 503 ? "The Anthropic API key was rejected (invalid or expired). Update it in Setup." : message);
    }
  }, "Tax request analysis failed");
}
