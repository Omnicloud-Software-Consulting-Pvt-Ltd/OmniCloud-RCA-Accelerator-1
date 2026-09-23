/**
 * Step 1 — Claude-based NL -> structured extraction. Produces an explicit,
 * typed representation (never relies on free-form AI text alone) that the
 * rest of this flow validates against Salesforce before anything is shown
 * as "ready". The AI is only ever allowed to interpret the user's business
 * requirement — it never invents a product/attribute/value, and every
 * field it fills in is re-verified downstream, not trusted as-is.
 */
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL } from "@/lib/config";
import type { ExtractedAdjustmentType, ExtractedAttribute, ExtractedCombination, ExtractedPricingRequirement } from "./types";

const SYSTEM_PROMPT = `You are an expert Salesforce Revenue Cloud attribute-based pricing assistant.

Parse the user's natural-language request into a structured extraction. Output ONLY a single valid JSON object — no markdown, no code fences, no explanation.

JSON STRUCTURE
{
  "product": "string — the product name exactly as the user wrote it, or null if not mentioned",
  "attributes": [
    {
      "name": "string — the attribute name, e.g. RAM, Storage, Processor, Display Type",
      "values": [
        {
          "value": "string — the specific attribute value, e.g. 16GB, Intel Core i7, OLED",
          "adjustmentType": "one of: fixed, percentage, override — or null if no adjustment was stated for this value",
          "adjustment": "number — the magnitude only, no currency symbol or % sign, no +/- sign (e.g. 150, 10, 1200) — or null if not stated"
        }
      ]
    }
  ],
  "conditions": ["string — any condition you could not reduce to a plain attribute/value/adjustment, e.g. \\"only for orders over $500\\", verbatim or lightly cleaned up"],
  "combinations": [
    {
      "members": [
        { "attribute": "string — e.g. RAM", "value": "string — e.g. 32GB" },
        { "attribute": "string — e.g. Storage", "value": "string — e.g. 1TB" }
      ],
      "adjustmentType": "one of: fixed, percentage, override — or null if no adjustment was stated for this specific combination",
      "adjustment": "number — the magnitude only, or null if not stated",
      "rawText": "string — the exact phrase (verbatim or lightly cleaned up) this combination came from"
    }
  ],
  "currency": "string — an ISO currency code like USD, EUR, GBP if stated, else null",
  "basePrice": "number — the base/list price if stated, digits only, else null",
  "effectiveFrom": "YYYY-MM-DD if a start/effective date was stated, else null",
  "effectiveTo": "YYYY-MM-DD if an end date was stated, else null",
  "otherNotes": ["string — anything else pricing-relevant that doesn't fit the fields above"]
}

RULES
- Only extract what is explicitly stated or unambiguously implied — never invent a product, attribute, value, condition, or price.
- "Increase the price by X%" / "add $X" / "X% more" -> adjustmentType "percentage" or "fixed" as appropriate, adjustment is the bare number.
- A stated final absolute price for a value (not a delta) -> adjustmentType "override", adjustment is that absolute price.
- If the user names an attribute value but never states a number for it, set adjustmentType and adjustment to null for that value — do NOT guess or default to 0 yourself; the caller decides how to handle that.
- If the user only names a product and says something like "using the attributes available for this product" without listing any attributes, return an empty attributes array — do not invent attributes to fill it.
- This is a starting point that will be re-verified against real Salesforce data — accuracy matters far more than completeness.

COMBINATIONS — read this carefully, it is the part most often gotten wrong
"combinations" captures ONLY a genuine, EXPLICIT combination-specific pricing requirement: a price that
applies specifically when two or more attribute values occur TOGETHER, as its own distinct rule — never
merely because the prompt happens to mention more than one attribute.
- Populate "combinations" ONLY when the prompt uses combination language such as: "when A and B", "if A
  and B", "combination of A and B", "A + B together", "when selected together", "specific combination",
  "special price for A and B", or an unambiguous equivalent.
- Do NOT populate "combinations" just because several attributes are each independently priced in the same
  prompt. Example: "RAM 32GB adds ₹12,000 and Storage 1TB adds ₹8,000" describes two INDEPENDENT
  attribute/value adjustments (put these in "attributes", NOT "combinations") — there is no explicit
  combination language here, so "combinations" must be an empty array for this example.
- Do NOT populate "combinations" just because a prompt lists several attributes to price without any
  combination language. Example: "Create pricing for RAM, Storage and Processor" never implies every
  permutation of their values should be combined — "combinations" must be an empty array here too.
- DO populate "combinations" for: "When RAM is 32GB AND Storage is 1TB, give an additional ₹5,000." — one
  entry with members [{attribute: RAM, value: 32GB}, {attribute: Storage, value: 1TB}], adjustmentType
  "fixed", adjustment 5000.
- Every combination needs 2 or more members — never emit a 1-member "combination" (that's just an
  independent attribute/value; put it in "attributes" instead).
- If a combination phrase never states a price adjustment for that specific combination, still include it
  with adjustmentType and adjustment both null — do NOT guess or invent an amount, and do NOT silently drop it.`;

/** Exported for direct unit testing (bypasses the Anthropic call entirely — this is pure mapping/filtering
 * logic over whatever JSON shape the AI returned for "combinations"). */
export function toExtractedCombinations(raw: unknown): ExtractedCombination[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedCombination[] = [];
  for (const entry of raw as Record<string, unknown>[]) {
    const membersRaw = Array.isArray(entry?.members) ? (entry.members as Record<string, unknown>[]) : [];
    const members = membersRaw
      .filter(m => typeof m?.attribute === "string" && m.attribute.trim() && typeof m?.value === "string" && m.value.trim())
      .map(m => ({ attribute: String(m.attribute).trim(), value: String(m.value).trim() }));
    // Fewer than 2 distinct members isn't a combination at all (it's an independent attribute/value) —
    // dropped here rather than passed downstream as something `analyze.ts` would have to reject anyway.
    if (members.length < 2) continue;
    const rawText = typeof entry?.rawText === "string" && entry.rawText.trim() ? entry.rawText.trim() : members.map(m => `${m.attribute}=${m.value}`).join(" AND ");
    out.push({
      members,
      adjustmentType: toAdjustmentType(entry?.adjustmentType),
      adjustment: toFiniteNumberOrNull(entry?.adjustment),
      rawText,
    });
  }
  return out;
}

function toFiniteNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = parseFloat(v.replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toAdjustmentType(v: unknown): ExtractedAdjustmentType | null {
  return v === "fixed" || v === "percentage" || v === "override" ? v : null;
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

/** Parses free text into an ExtractedPricingRequirement via Claude. Throws on an Anthropic API error or a response with no parseable JSON — the caller decides how to surface that (Step 13 #9). */
export async function parseAttributeBasedPrompt(apiKey: string, prompt: string): Promise<ExtractedPricingRequirement> {
  const anthropic = new Anthropic({ apiKey });
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1536,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("The AI's response didn't contain a valid structured extraction. Try rephrasing your prompt with more detail.");
    parsed = JSON.parse(match[0]);
  }

  const attributesRaw = Array.isArray(parsed.attributes) ? (parsed.attributes as Record<string, unknown>[]) : [];
  const attributes: ExtractedAttribute[] = attributesRaw
    .filter(a => typeof a?.name === "string" && a.name.trim())
    .map(a => ({
      name: String(a.name).trim(),
      values: (Array.isArray(a.values) ? (a.values as Record<string, unknown>[]) : [])
        .filter(v => typeof v?.value === "string" && v.value.trim())
        .map(v => ({
          value: String(v.value).trim(),
          adjustmentType: toAdjustmentType(v.adjustmentType),
          adjustment: toFiniteNumberOrNull(v.adjustment),
        })),
    }));

  return {
    pricingType: "attribute-based",
    product: typeof parsed.product === "string" && parsed.product.trim() ? parsed.product.trim() : null,
    attributes,
    conditions: toStringArray(parsed.conditions),
    combinations: toExtractedCombinations(parsed.combinations),
    currency: typeof parsed.currency === "string" && parsed.currency.trim() ? parsed.currency.trim().toUpperCase() : null,
    basePrice: toFiniteNumberOrNull(parsed.basePrice),
    effectiveFrom: typeof parsed.effectiveFrom === "string" && parsed.effectiveFrom.trim() ? parsed.effectiveFrom.trim() : null,
    effectiveTo: typeof parsed.effectiveTo === "string" && parsed.effectiveTo.trim() ? parsed.effectiveTo.trim() : null,
    otherNotes: toStringArray(parsed.otherNotes),
  };
}
