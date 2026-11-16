import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropicKey } from "@/lib/config";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { loadOrderBilling } from "@/lib/billing/server/orderBilling";
import { analyzeOrderBillingPrompt } from "@/lib/billing/server/orderBillingAi";
import { callClaude, describeBillingAiError } from "@/lib/billing/server/ai";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import { SalesforceError } from "@/lib/salesforce/client";

type Params = { params: Promise<{ id: string }> };

// POST /api/billing/orders/[id]/ai — { prompt }. Interprets the instruction into structured steps from a fixed
// action list, resolved against this order's real Salesforce state. Read-only: the user runs each step through
// the same guarded endpoints (and readiness validation) as the buttons.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let prompt = "";
  try { const b = await req.json(); prompt = typeof b.prompt === "string" ? b.prompt.trim() : ""; } catch { /* handled below */ }
  if (!prompt) return NextResponse.json({ error: "Describe what to do, e.g. \"Set up billing, bill Peter Partner Sales Rep, then activate the order.\"", code: "INVALID_REQUEST" }, { status: 400 });
  const apiKey = resolveAnthropicKey(req);
  if (!apiKey) return NextResponse.json({ error: "Anthropic API key not configured. Complete Setup to add your key.", code: "NO_AI_KEY" }, { status: 503 });
  try {
    const state = await loadOrderBilling(auth.client, id);
    const anthropic = new Anthropic({ apiKey });
    return NextResponse.json(await analyzeOrderBillingPrompt(state, (system, p) => callClaude(anthropic, system, p, 500), prompt));
  } catch (err) {
    if (err instanceof SalesforceError) return billingErrorResponse(err, "Order billing analysis failed", { objectLabel: "Order" });
    if (err instanceof Error && /Invalid Order Id|Order not found/.test(err.message)) return NextResponse.json({ error: err.message, code: "NOT_FOUND" }, { status: 404 });
    const { status, message } = describeBillingAiError(err);
    return NextResponse.json({ error: message, code: status === 503 ? "NO_AI_KEY" : "AI_ERROR" }, { status });
  }
}
