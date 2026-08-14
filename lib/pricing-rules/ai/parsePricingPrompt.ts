/**
 * Shared Claude-based NL→structured extraction for a Pricing Procedure
 * prompt — the exact parsing logic /api/pricing-rules/ai/generate-pricing
 * used inline before this was extracted, now also used by
 * /api/pricing-rules/ai/auto-create (the fully-automated, no-review
 * pipeline) so both callers stay byte-for-byte consistent instead of
 * drifting apart.
 */
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL } from "@/lib/config";
import { PRICING_TYPE_LABELS } from "@/lib/pricing-rules/types";
import type { AIAttributeEntry, AIGeneratedProcedure, AttributePricingType, PricingType } from "@/lib/pricing-rules/types";

function systemPrompt(knownPricingType: PricingType | null): string {
  const hint = knownPricingType
    ? `\nThe user is already on the "${PRICING_TYPE_LABELS[knownPricingType]}" pricing page — assume pricingType is "${knownPricingType}" unless the prompt clearly states a different type.`
    : "";

  return `You are an expert Salesforce Revenue Cloud pricing assistant.

Parse the user's natural language request into a structured Pricing Procedure extraction.
${hint}
Output ONLY a single valid JSON object. No markdown. No code fences. No explanation.

JSON STRUCTURE
{
  "procedureName": "string — the pricing procedure's name, or null if not mentioned",
  "productName": "string — the product this pricing applies to, or null",
  "pricingType": "one of: tier-based, volume-based, attribute-based, bundle-based — or null if not clearly stated",
  "description": "string or null",
  "basePrice": "number — the base/list price mentioned, digits only (no currency symbol or commas), or null if not stated. Only meaningful when pricingType is attribute-based.",
  "attributeEntries": [
    {
      "attributeName": "string — the attribute/dimension, e.g. Display, Storage",
      "attributeValue": "string — the specific picklist value being priced, e.g. 1080p, 512GB",
      "adjustmentType": "Percentage Discount | Fixed Amount | Override Price",
      "adjustmentValue": "number — absolute value, no sign or currency symbol"
    }
  ]
}

RULES
- Only extract fields explicitly stated or clearly implied — leave anything not mentioned as null.
- Never invent a product, attribute, value, or price that wasn't said.
- "attributeEntries" and "basePrice" only apply when pricingType is "attribute-based" — omit/null them otherwise.
- Classify each attribute entry's adjustmentType: a "%"/"percent"/"off" phrasing -> "Percentage Discount"; a stated +/- dollar delta -> "Fixed Amount"; a stated final absolute price -> "Override Price".
- These extracted values are a starting point for a form the user can still edit — accuracy matters more than completeness.`;
}

const VALID_ADJUSTMENT_TYPES: AttributePricingType[] = ["Percentage Discount", "Fixed Amount", "Override Price"];
const VALID_PRICING_TYPES: PricingType[] = ["tier-based", "volume-based", "attribute-based", "bundle-based"];

/** Parses free text into an AIGeneratedProcedure via Claude — throws on missing/invalid JSON or an Anthropic API error; the caller decides how to surface that. */
export async function parsePricingPrompt(
  apiKey: string,
  prompt: string,
  knownPricingType: PricingType | null = null,
): Promise<AIGeneratedProcedure> {
  const anthropic = new Anthropic({ apiKey });
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: systemPrompt(knownPricingType),
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

  const pricingTypeRaw = typeof parsed.pricingType === "string" ? parsed.pricingType.trim().toLowerCase() : "";
  const aiPricingType = (VALID_PRICING_TYPES as string[]).includes(pricingTypeRaw) ? (pricingTypeRaw as PricingType) : "";
  // The page the user is already on (if any) always wins over the AI's own guess.
  const pricingType: PricingType | "" = knownPricingType ?? aiPricingType;

  const result: AIGeneratedProcedure = {
    procedureName: typeof parsed.procedureName === "string" ? parsed.procedureName : "",
    productName: typeof parsed.productName === "string" ? parsed.productName : "",
    pricingType,
    description: typeof parsed.description === "string" ? parsed.description : "",
  };

  if (pricingType === "attribute-based") {
    if (parsed.basePrice !== null && parsed.basePrice !== undefined && parsed.basePrice !== "") {
      const numeric = parseFloat(String(parsed.basePrice).replace(/[^0-9.]/g, ""));
      if (!Number.isNaN(numeric)) result.basePrice = String(numeric);
    }

    if (Array.isArray(parsed.attributeEntries)) {
      const entries: AIAttributeEntry[] = (parsed.attributeEntries as Record<string, unknown>[])
        .filter(e => typeof e?.attributeName === "string" && e.attributeName.trim() && typeof e?.attributeValue === "string" && e.attributeValue.trim())
        .map(e => {
          const adjustmentType = typeof e.adjustmentType === "string" && (VALID_ADJUSTMENT_TYPES as string[]).includes(e.adjustmentType)
            ? (e.adjustmentType as AttributePricingType)
            : "Fixed Amount";
          return {
            attributeName: String(e.attributeName).trim(),
            attributeValue: String(e.attributeValue).trim(),
            adjustmentType,
            adjustmentValue: parseFloat(String(e.adjustmentValue).replace(/[^0-9.-]/g, "")) || 0,
          };
        });
      if (entries.length > 0) result.attributeEntries = entries;
    }
  }

  return result;
}

/** How many of the fields the workflow cares about actually came back populated — shared confidence heuristic. */
export function computeAiConfidence(result: AIGeneratedProcedure): "high" | "medium" | "low" {
  const filledCount = [result.procedureName, result.productName, result.pricingType, result.description, result.basePrice]
    .filter(v => typeof v === "string" && v.trim() !== "").length
    + ((result.attributeEntries?.length ?? 0) > 0 ? 1 : 0);
  return filledCount >= 5 ? "high" : filledCount >= 3 ? "medium" : "low";
}
