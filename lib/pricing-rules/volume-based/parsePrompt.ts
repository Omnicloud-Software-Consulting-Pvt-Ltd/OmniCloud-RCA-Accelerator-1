/**
 * Natural-language -> structured extraction for Volume-Based Pricing prompts.
 *
 * Mirrors lib/pricing-rules/bundle-based/parsePrompt.ts exactly: a single-turn Claude call demanding pure
 * JSON, with a regex fallback if the model wraps the JSON in prose/markdown, and no invented product
 * names/values — anything the model didn't confidently extract comes back null/empty and is resolved
 * against real Salesforce data later, never trusted as-is.
 *
 * The system prompt below disambiguates volume-based ("Range" — every unit gets the matched band's rate)
 * from its tier-based/"Slab" sibling (only the units inside a band get that band's rate) — the two are
 * easy for a model to confuse, so the wording here is deliberately explicit and repeated.
 */
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL } from "@/lib/config";
import type { ExtractedVolumePricingRequirement, TierType, VolumeTier } from "./types";

const VALID_TIER_TYPES = ["Percentage", "Amount", "Override", "OverridePrice"];

const SYSTEM_PROMPT = `You are an expert Salesforce Revenue Cloud volume-based pricing assistant.

Parse the user's natural-language request into a structured extraction. Output ONLY a single valid JSON object — no markdown, no code fences, no explanation.

PRICING TYPE DISAMBIGUATION (critical — do not confuse these):
- volume-based: Range/threshold discount applied to ALL units once total quantity hits a band. The discount for the band the total falls in applies to EVERY unit. AdjustmentMethod=Range in Salesforce. Use this when the user says "volume", "volume-based", "volume discount", "quantity discount", "all units get X% off".
- tier-based: Slab pricing where ONLY the units within each band get that band's rate. AdjustmentMethod=Slab. This extraction is ONLY ever used for volume-based requests — if the prompt sounds like tier-based/slab pricing, still extract the tiers as given; pricing-type resolution itself is handled outside this extraction.

JSON STRUCTURE
{
  "productName": "string (the name of the existing product being priced) or null",
  "basePrice": "number or null (only if the prompt explicitly states a base/list price — never assume it should come from Salesforce here)",
  "volumeTiers": [
    {
      "lowerBound": "integer >= 1 (minimum quantity for this tier)",
      "upperBound": "integer or null (maximum quantity for this tier; null = open-ended/unlimited)",
      "tierType": "Percentage | Amount | Override",
      "tierValue": "number (the discount or override price for this tier)"
    }
  ],
  "currency": "ISO code or null",
  "effectiveFrom": "YYYY-MM-DD or null",
  "effectiveTo": "YYYY-MM-DD or null",
  "otherNotes": ["anything else relevant, as plain strings"]
}

VOLUME TIER TYPE RULES (CRITICAL — do NOT guess):
- Percentage: Discount expressed as a percentage (e.g., 10 = 10% off). tierValue must be between 0 and 100.
- Amount: Fixed amount discount subtracted from list price (e.g., 50 = $50 off).
- Override: Override the unit price to this exact final price (e.g., 100 = $100/unit).
- If the tier values look like final unit prices (e.g., 100, 200, 300 per unit) -> use "Override".
- If the tier values are between 0 and 100 and the user says "%" or "discount" or "off" -> use "Percentage".
- If the tier values are dollar amounts to subtract from list price -> use "Amount".
- Values greater than 100 are NEVER valid Percentages. If tierValue > 100, use "Override" or "Amount".
- When ambiguous and values are large (> 50), prefer "Override" over "Percentage".

VOLUME TIERS RULES
- Extract ALL tiers mentioned. Always create a base tier starting at qty 1 with tierValue 0 if the user only specifies discount tiers.
- The last tier should always have upperBound: null (open-ended).
- Tiers must NOT overlap and must be contiguous.
- Never invent a Salesforce Id, record name, or field value anywhere in this output — product identity is resolved separately against real Salesforce data after this extraction.
- This is a starting point that gets re-verified against real Salesforce data — accuracy over completeness.

EXAMPLE — "10% discount for qty 100-299, 20% for qty 300+":
{
  "volumeTiers": [
    { "lowerBound": 1, "upperBound": 99, "tierType": "Percentage", "tierValue": 0 },
    { "lowerBound": 100, "upperBound": 299, "tierType": "Percentage", "tierValue": 10 },
    { "lowerBound": 300, "upperBound": null, "tierType": "Percentage", "tierValue": 20 }
  ]
}`;

function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

function extractJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch { /* fall through to the throw below */ }
    }
    throw new Error("The AI's response didn't contain a valid structured extraction (expected a single JSON object).");
  }
}

function toVolumeTiers(raw: unknown): VolumeTier[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map(t => {
      const lowerBound = parseInt(String((t as Record<string, unknown>).lowerBound ?? 0), 10) || 0;
      const rawUpper = (t as Record<string, unknown>).upperBound;
      const upperBound = rawUpper === null || rawUpper === undefined || rawUpper === "" ? null : (parseInt(String(rawUpper), 10) || null);
      const rawTierType = String((t as Record<string, unknown>).tierType ?? "Percentage");
      const tierType = (VALID_TIER_TYPES.includes(rawTierType) ? rawTierType : "Percentage") as TierType;
      const tierValue = parseFloat(String((t as Record<string, unknown>).tierValue ?? 0)) || 0;
      return { lowerBound, upperBound, tierType, tierValue };
    })
    .filter(t => t.lowerBound >= 0);
}

export async function parseVolumeBasedPrompt(apiKey: string, prompt: string): Promise<ExtractedVolumePricingRequirement> {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1536,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find(b => b.type === "text");
  const rawText = textBlock && "text" in textBlock ? textBlock.text : "";
  const parsed = extractJson(rawText);

  return {
    pricingType: "volume-based",
    productName: toStringOrNull(parsed.productName),
    basePrice: toFiniteNumberOrNull(parsed.basePrice),
    volumeTiers: toVolumeTiers(parsed.volumeTiers),
    currency: toStringOrNull(parsed.currency),
    effectiveFrom: toStringOrNull(parsed.effectiveFrom),
    effectiveTo: toStringOrNull(parsed.effectiveTo),
    otherNotes: toStringArray(parsed.otherNotes),
  };
}
