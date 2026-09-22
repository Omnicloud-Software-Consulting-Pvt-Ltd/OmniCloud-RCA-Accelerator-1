/**
 * Natural-language -> structured extraction for Bundle-Based Pricing prompts.
 *
 * Mirrors lib/pricing-rules/attribute-based/parsePrompt.ts exactly: a single-turn Claude call demanding
 * pure JSON, with a regex fallback if the model wraps the JSON in prose/markdown, and no invented
 * component names/values — anything the model didn't confidently extract comes back null/empty and is
 * resolved against real Salesforce data later, never trusted as-is.
 */
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL } from "@/lib/config";
import type { ExtractedAdjustmentType, ExtractedBundlePricingRequirement, ExtractedComponentAdjustment } from "./types";

const SYSTEM_PROMPT = `You are an expert Salesforce Revenue Cloud bundle-based pricing assistant.

Parse the user's natural-language request into a structured extraction. Output ONLY a single valid JSON object — no markdown, no code fences, no explanation.

JSON STRUCTURE
{
  "bundleName": "string (the name of the existing bundle/parent product) or null",
  "components": [
    {
      "componentName": "string (the name of a child/component product)",
      "adjustmentType": "fixed|percentage|override or null",
      "adjustment": "number or null",
      "quantityCondition": "number or null (only if the prompt states a quantity threshold for this component's adjustment to apply)"
    }
  ],
  "conditions": ["bundle-level conditions stated in the prompt, as plain strings"],
  "combinations": ["combination-specific rules stated in the prompt, as plain strings"],
  "currency": "ISO code or null",
  "basePrice": "number or null (only if the prompt explicitly states a base bundle price — never assume it should come from Salesforce here)",
  "effectiveFrom": "YYYY-MM-DD or null",
  "effectiveTo": "YYYY-MM-DD or null",
  "sellingModel": "string or null",
  "otherNotes": ["anything else relevant, as plain strings"]
}

RULES
- Only extract what is explicitly stated or unambiguously implied — never invent a component, a bundle name, or a dollar amount that isn't in the prompt.
- "Add $X" / "+$X" -> adjustmentType "fixed", adjustment is the bare positive number.
- "Increase by X%" / "X% more" -> adjustmentType "percentage", adjustment is the bare number.
- A stated final absolute price for a component -> adjustmentType "override".
- A component named with no adjustment amount -> both adjustmentType and adjustment stay null — never guess or default to 0.
- Do not fabricate a Salesforce Id, record name, or field value anywhere in this output — component/bundle identity is resolved separately against real Salesforce data after this extraction.
- This is a starting point that gets re-verified against real Salesforce data — accuracy over completeness.`;

function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function toAdjustmentType(value: unknown): ExtractedAdjustmentType | null {
  return value === "fixed" || value === "percentage" || value === "override" ? value : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
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

export async function parseBundleBasedPrompt(apiKey: string, prompt: string): Promise<ExtractedBundlePricingRequirement> {
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

  const components: ExtractedComponentAdjustment[] = Array.isArray(parsed.components)
    ? (parsed.components as unknown[])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map(c => ({
          componentName: typeof c.componentName === "string" ? c.componentName.trim() : "",
          adjustmentType: toAdjustmentType(c.adjustmentType),
          adjustment: toFiniteNumberOrNull(c.adjustment),
          quantityCondition: toFiniteNumberOrNull(c.quantityCondition),
        }))
        .filter(c => c.componentName !== "")
    : [];

  return {
    pricingType: "bundle-based",
    bundleName: toStringOrNull(parsed.bundleName),
    components,
    conditions: toStringArray(parsed.conditions),
    combinations: toStringArray(parsed.combinations),
    currency: toStringOrNull(parsed.currency),
    basePrice: toFiniteNumberOrNull(parsed.basePrice),
    effectiveFrom: toStringOrNull(parsed.effectiveFrom),
    effectiveTo: toStringOrNull(parsed.effectiveTo),
    sellingModel: toStringOrNull(parsed.sellingModel),
    otherNotes: toStringArray(parsed.otherNotes),
  };
}
