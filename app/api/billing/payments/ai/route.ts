import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropicKey } from "@/lib/config";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { analyzePaymentPrompt } from "@/lib/billing/server/payments";
import { callClaude, describeBillingAiError } from "@/lib/billing/server/ai";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import { SalesforceError } from "@/lib/salesforce/client";

// POST /api/billing/payments/ai — { prompt }. Claude extracts a structured payment intent; the invoice number and payment
// method are resolved against Salesforce and run through the same validatePayment as the form. Never writes to Salesforce.
export async function POST(req: NextRequest) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let prompt = "";
  try { const b = await req.json(); prompt = typeof b.prompt === "string" ? b.prompt.trim() : ""; } catch { /* handled below */ }
  if (!prompt) return NextResponse.json({ error: "Describe the payment, e.g. \"Record a payment of 39.97 against invoice DOC-000000001.\"", code: "INVALID_REQUEST" }, { status: 400 });
  const apiKey = resolveAnthropicKey(req);
  if (!apiKey) return NextResponse.json({ error: "Anthropic API key not configured. Complete Setup to add your key.", code: "NO_AI_KEY" }, { status: 503 });
  const anthropic = new Anthropic({ apiKey });
  try {
    return NextResponse.json(await analyzePaymentPrompt(auth.client, (system, p) => callClaude(anthropic, system, p, 400), prompt));
  } catch (err) {
    if (err instanceof SalesforceError) return billingErrorResponse(err, "Payment analysis failed", { objectLabel: "Payment" });
    const { status, message } = describeBillingAiError(err);
    return NextResponse.json({ error: message, code: status === 503 ? "NO_AI_KEY" : "AI_ERROR" }, { status });
  }
}
