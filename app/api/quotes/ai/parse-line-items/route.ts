import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { SESSION_COOKIE, decodeSession } from "@/lib/salesforce/client";
import { resolveAnthropicKey, CLAUDE_MODEL } from "@/lib/config";

const SYSTEM_PROMPT = `You are an expert Salesforce Revenue Cloud quoting assistant.

Parse the user's natural language request into a list of products to add to a quote.

Output ONLY a single valid JSON object. No markdown. No code fences. No explanation.

JSON STRUCTURE
{
  "items": [
    {
      "productName": "string — the product name as mentioned by the user",
      "quantity": 1,
      "discountPercent": 0
    }
  ]
}

RULES
- One entry per distinct product mentioned.
- Default quantity to 1 if not stated.
- Default discountPercent to 0 if not stated.
- Keep product names as close to the user's original wording as possible — a separate matching step will resolve them against the real catalog.`;

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

  try {
    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const text = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
    let parsed: { items?: unknown[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No valid JSON in AI response. Try a more detailed description.");
      parsed = JSON.parse(match[0]);
    }

    const items = Array.isArray(parsed.items)
      ? parsed.items
          .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
          .map(i => ({
            productName: typeof i.productName === "string" ? i.productName : "",
            quantity: typeof i.quantity === "number" && i.quantity > 0 ? i.quantity : 1,
            discountPercent: typeof i.discountPercent === "number" && i.discountPercent >= 0 ? i.discountPercent : 0,
          }))
          .filter(i => i.productName.trim().length > 0)
      : [];

    return NextResponse.json({ success: true, items });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
