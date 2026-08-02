import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { SESSION_COOKIE, decodeSession } from "@/lib/salesforce/client";
import { resolveAnthropicKey, CLAUDE_MODEL } from "@/lib/config";

function systemPrompt(todayISO: string) {
  return `You are an expert Salesforce Revenue Cloud quoting assistant.

Parse the user's natural language request into a structured Quote field extraction.

Today's date is ${todayISO}. Resolve every relative date ("next Monday", "in 30 days", "end of quarter") into an absolute ISO date (YYYY-MM-DD) relative to today.

Output ONLY a single valid JSON object. No markdown. No code fences. No explanation.

JSON STRUCTURE
{
  "name": "string — quote name, or null if not mentioned",
  "accountName": "string — customer/account name, or null",
  "priceBookName": "string — price book name, or null",
  "opportunityName": "string — opportunity name, or null",
  "startDate": "YYYY-MM-DD or null",
  "expirationDate": "YYYY-MM-DD or null",
  "status": "string — e.g. Draft, or null",
  "description": "string or null"
}

RULES
- Only extract fields explicitly stated or clearly implied — leave anything not mentioned as null.
- Never invent an account, price book, or opportunity name that wasn't said.
- These extracted values are a starting point for a form the user can still edit — accuracy matters more than completeness.`;
}

export async function POST(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE);
  const session = cookie?.value ? decodeSession(cookie.value) : null;
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let prompt: string;
  try {
    const body = await req.json();
    prompt = body.prompt;
    if (!prompt?.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const apiKey = resolveAnthropicKey(req);
  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic API key not configured. Complete Setup to add your key.", code: "NO_AI_KEY" },
      { status: 503 },
    );
  }
  const anthropic = new Anthropic({ apiKey });
  const todayISO = new Date().toISOString().slice(0, 10);

  try {
    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt(todayISO),
      messages: [{ role: "user", content: prompt }],
    });

    const text = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No valid JSON in AI response. Try a more detailed description.");
      parsed = JSON.parse(match[0]);
    }

    // Deterministic normalization pass — never trust the AI's shape blindly.
    const fields = {
      name: typeof parsed.name === "string" ? parsed.name : "",
      accountName: typeof parsed.accountName === "string" ? parsed.accountName : "",
      pricebookName: typeof parsed.priceBookName === "string" ? parsed.priceBookName : "",
      opportunityName: typeof parsed.opportunityName === "string" ? parsed.opportunityName : "",
      startDate: typeof parsed.startDate === "string" ? parsed.startDate : "",
      expirationDate: typeof parsed.expirationDate === "string" ? parsed.expirationDate : "",
      status: typeof parsed.status === "string" ? parsed.status : "",
      description: typeof parsed.description === "string" ? parsed.description : "",
    };

    return NextResponse.json({ success: true, fields });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
