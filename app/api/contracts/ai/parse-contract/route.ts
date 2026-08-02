import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { SESSION_COOKIE, decodeSession } from "@/lib/salesforce/client";
import { resolveAnthropicKey, CLAUDE_MODEL } from "@/lib/config";

function systemPrompt(todayISO: string) {
  return `You are an expert Salesforce contract-authoring assistant.

Parse the user's natural language request into a structured Contract field extraction.

Today's date is ${todayISO}. Resolve every relative date ("next Monday", "in 30 days", "12 months from now") into an absolute ISO date (YYYY-MM-DD) relative to today.

Output ONLY a single valid JSON object. No markdown. No code fences. No explanation.

JSON STRUCTURE
{
  "accountName": "string — customer/account name, or null",
  "priceBookName": "string — price book name, or null",
  "status": "string — e.g. Draft, or null",
  "contractType": "string — e.g. Master Service Agreement, or null",
  "startDate": "YYYY-MM-DD or null",
  "endDate": "YYYY-MM-DD or null — informational only, Contract.EndDate is a read-only formula field and is never written",
  "contractTerm": "number of months as a string, or null",
  "companySignedByName": "string — a person name mentioned as the internal signatory, or null",
  "companySignedDate": "YYYY-MM-DD or null",
  "customerSignedByName": "string — a person name mentioned as the customer signatory, or null",
  "customerSignedTitle": "string or null",
  "customerSignedDate": "YYYY-MM-DD or null",
  "description": "string or null"
}

RULES
- Standard Contract has no free-text Name field — never invent one; ContractNumber is system-assigned.
- companySignedByName and customerSignedByName are SEARCH HINTS ONLY, never resolved record Ids. NEVER invent a plausible-sounding person name that wasn't stated or clearly implied — leave null if no name was mentioned.
- Only extract fields explicitly stated or clearly implied — leave anything not mentioned as null.
- Never invent an account or price book name that wasn't said.
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

    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const fields = {
      accountName: str(parsed.accountName),
      pricebookName: str(parsed.priceBookName),
      status: str(parsed.status),
      contractType: str(parsed.contractType),
      startDate: str(parsed.startDate),
      endDate: str(parsed.endDate), // informational only — no editable form field consumes this (§2.1: EndDate is a formula field)
      contractTerm: str(parsed.contractTerm),
      companySignedByName: str(parsed.companySignedByName),
      companySignedDate: str(parsed.companySignedDate),
      customerSignedByName: str(parsed.customerSignedByName),
      customerSignedTitle: str(parsed.customerSignedTitle),
      customerSignedDate: str(parsed.customerSignedDate),
      description: str(parsed.description),
    };

    return NextResponse.json({ success: true, fields });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
