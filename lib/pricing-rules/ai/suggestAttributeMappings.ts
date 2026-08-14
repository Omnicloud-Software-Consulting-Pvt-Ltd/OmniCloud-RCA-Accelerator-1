/**
 * §Attribute Validation UX — AI-assisted fallback for when deterministic
 * fuzzy matching (fuzzyMatch.ts) finds nothing confident enough. Some real
 * mappings need domain knowledge no string-similarity metric can see
 * ("Integrated Graphics" -> "Intel Iris Xe Graphics" share almost no
 * characters or tokens). Claude is given ONLY the enumerated real
 * candidate list per item and is instructed to return one of those
 * strings verbatim, or null — the caller (attributeMappingSuggestions.ts)
 * still re-verifies the returned string is an exact member of that same
 * candidate list before ever surfacing it as a suggestion, so a
 * hallucinated or reworded answer can never reach the user as if it were
 * a real Salesforce value.
 */
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL } from "@/lib/config";

const SYSTEM_PROMPT = `You match a user-typed product attribute value to the single closest REAL option from an enumerated candidate list, using domain/technical knowledge (product spec terminology, common abbreviations, generation/model naming).

Rules:
- You may ONLY return a string that appears verbatim in that item's own "candidates" array, or null.
- Never invent, reword, abbreviate, or combine a candidate string.
- If nothing in the candidates plausibly corresponds to the input, return null for that item.
- Output ONLY a single valid JSON array. No markdown, no code fences, no explanation.

OUTPUT SHAPE
[{"id": "string — copied verbatim from the input item", "match": "one of that item's candidates, verbatim, or null"}]`;

export interface MatchRequest {
  id: string;
  input: string;
  candidates: string[];
}

/** Returns a map of id -> the AI's chosen candidate string (or null). The map may contain values the caller still must verify are an exact member of that request's own candidates — this function does not do that check itself, since it doesn't have the per-item candidate list once collapsed into a Map. */
export async function suggestClosestMatches(apiKey: string, requests: MatchRequest[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (requests.length === 0) return result;

  const anthropic = new Anthropic({ apiKey });
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(requests) }],
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return result;
    try { parsed = JSON.parse(match[0]); } catch { return result; }
  }
  if (!Array.isArray(parsed)) return result;

  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const id = (item as Record<string, unknown>).id;
    const match = (item as Record<string, unknown>).match;
    if (typeof id !== "string") continue;
    result.set(id, typeof match === "string" ? match : null);
  }
  return result;
}
