import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropicKey } from "@/lib/config";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { analyzeCreditPrompt } from "@/lib/billing/server/creditMemos";
import { callClaude, describeBillingAiError } from "@/lib/billing/server/ai";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import { SalesforceError } from "@/lib/salesforce/client";

// POST /api/billing/credit-memos/ai — { prompt }. Claude extracts a structured credit intent (invoice number, amount, line name);
// the invoice and line are resolved against Salesforce. Never writes to Salesforce.
export async function POST(req: NextRequest) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let prompt = "";
  try { const b = await req.json(); prompt = typeof b.prompt === "string" ? b.prompt.trim() : ""; } catch { /* handled below */ }
  if (!prompt) return NextResponse.json({ error: "Describe the credit, e.g. \"Create a 20 credit for invoice DOC-000000001.\"", code: "INVALID_REQUEST" }, { status: 400 });
  const apiKey = resolveAnthropicKey(req);
  if (!apiKey) return NextResponse.json({ error: "Anthropic API key not configured. Complete Setup to add your key.", code: "NO_AI_KEY" }, { status: 503 });
  const anthropic = new Anthropic({ apiKey });
  try {
    return NextResponse.json(await analyzeCreditPrompt(auth.client, (system, p) => callClaude(anthropic, system, p, 400), prompt));
  } catch (err) {
    if (err instanceof SalesforceError) return billingErrorResponse(err, "Credit analysis failed", { objectLabel: "Credit Memo" });
    const { status, message } = describeBillingAiError(err);
    return NextResponse.json({ error: message, code: status === 503 ? "NO_AI_KEY" : "AI_ERROR" }, { status });
  }
}
