import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropicKey } from "@/lib/config";
import { SalesforceError } from "@/lib/salesforce/client";
import { getBillingModule } from "@/lib/billing/registry";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { analyzeBillingPrompt, analyzeBillingEdit, identifyBillingModule, describeBillingAiError } from "@/lib/billing/server/ai";
import { SALESFORCE_ID } from "@/lib/billing/server/lookup";
import { billingErrorResponse } from "@/lib/billing/server/errors";

// POST /api/billing/ai/analyze — { prompt, moduleKey? }. The billing "analyze-billing-prompt"
// capability on the app's existing Claude integration (same model, same per-user Setup key).
// Without a moduleKey the prompt is first routed to the right billing object. Returns a reviewed-
// before-create draft: fields coerced to the org's real types/picklists, lookups resolved by
// querying Salesforce (AI Ids are rejected), child records, optional links, and validation.
// NOTHING is written to Salesforce here.
export async function POST(req: NextRequest) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let prompt: string;
  let moduleKey: string | null;
  let recordId: string | null;
  try {
    const body = await req.json();
    prompt = typeof body.prompt === "string" ? body.prompt : "";
    moduleKey = typeof body.moduleKey === "string" ? body.moduleKey : null;
    // Edit mode: the Id of the record the user OPENED (from the page, never from the AI).
    recordId = typeof body.recordId === "string" && body.recordId ? body.recordId : null;
    if (recordId && (!SALESFORCE_ID.test(recordId) || !moduleKey)) return NextResponse.json({ error: "Invalid record for AI edit.", code: "INVALID_REQUEST" }, { status: 400 });
    if (!prompt.trim()) return NextResponse.json({ error: "Describe the billing configuration you want to create.", code: "INVALID_REQUEST" }, { status: 400 });
    if (prompt.length > 4000) return NextResponse.json({ error: "Prompt is too long (4,000 characters max).", code: "INVALID_REQUEST" }, { status: 400 });
    if (moduleKey && !getBillingModule(moduleKey)) return NextResponse.json({ error: `Unknown billing module "${moduleKey}".`, code: "BILLING_MODULE_UNKNOWN" }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "INVALID_REQUEST" }, { status: 400 });
  }

  const apiKey = resolveAnthropicKey(req);
  if (!apiKey) {
    return NextResponse.json({ error: "Anthropic API key not configured. Complete Setup to add your key.", code: "NO_AI_KEY" }, { status: 503 });
  }
  const anthropic = new Anthropic({ apiKey });

  try {
    if (recordId && moduleKey) return NextResponse.json(await analyzeBillingEdit(auth.client, anthropic, prompt.trim(), moduleKey, recordId));
    let routing: { confidence: number; reason: string } | undefined;
    if (!moduleKey) {
      const identified = await identifyBillingModule(auth.client, anthropic, prompt);
      if (!identified.moduleKey) {
        return NextResponse.json({
          error: "Couldn't tell which billing object this prompt describes. Try naming it (e.g. \"Create a billing policy…\").",
          code: "BILLING_INTENT_UNCLEAR", possibleCause: identified.reason || null,
        }, { status: 422 });
      }
      moduleKey = identified.moduleKey;
      routing = { confidence: identified.confidence, reason: identified.reason };
    }
    const result = await analyzeBillingPrompt(auth.client, anthropic, prompt.trim(), moduleKey, routing);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SalesforceError || (err instanceof Error && err.name === "BillingModuleUnavailableError")) {
      return billingErrorResponse(err, "Billing AI analysis failed", { objectLabel: getBillingModule(moduleKey ?? "")?.singular ?? "billing record" });
    }
    const { status, message } = describeBillingAiError(err);
    return NextResponse.json({ error: message, code: status === 503 ? "NO_AI_KEY" : "AI_ERROR" }, { status });
  }
}
