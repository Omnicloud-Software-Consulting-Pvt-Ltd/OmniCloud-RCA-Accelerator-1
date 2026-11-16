import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropicKey } from "@/lib/config";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { interpretDebitPrompt } from "@/lib/billing/server/debitMemos";
import { callClaude, describeBillingAiError } from "@/lib/billing/server/ai";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import { SalesforceError } from "@/lib/salesforce/client";
import { SalesforceCallError } from "@/lib/billing/server/billingDocuments";

// POST /api/billing/debit-memos/interpret — { prompt }. The app's Claude integration turns the prompt into a structured debit
// memo intent (names, numbers, amounts — never Ids); every record is then resolved and validated in Salesforce. Never writes.
export async function POST(req: NextRequest) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let prompt = "";
  try { const b = await req.json(); prompt = typeof b.prompt === "string" ? b.prompt.trim() : ""; } catch { /* handled below */ }
  if (!prompt) return NextResponse.json({ success: false, requiresInput: true, missingFields: ["Prompt"], message: "Describe the debit memo, e.g. \"Create a ₹5,000 debit memo for Any Partner Inc for installation service.\"" }, { status: 400 });
  const apiKey = resolveAnthropicKey(req);
  if (!apiKey) return NextResponse.json({ error: "Anthropic API key not configured. Complete Setup to add your key.", code: "NO_AI_KEY" }, { status: 503 });
  const anthropic = new Anthropic({ apiKey });
  try {
    return NextResponse.json(await interpretDebitPrompt(auth.client, (system, p) => callClaude(anthropic, system, p, 700), prompt));
  } catch (err) {
    if (err instanceof SalesforceError) return billingErrorResponse(err, "Debit memo analysis failed", { objectLabel: "Debit Memo" });
    if (err instanceof SalesforceCallError) return NextResponse.json({ error: `Salesforce couldn't resolve the request: ${err.message}`, code: "SALESFORCE_ERROR" }, { status: err.status === 401 ? 401 : 502 });
    const { status, message } = describeBillingAiError(err);
    return NextResponse.json({ error: message, code: status === 503 ? "NO_AI_KEY" : "AI_ERROR" }, { status });
  }
}
