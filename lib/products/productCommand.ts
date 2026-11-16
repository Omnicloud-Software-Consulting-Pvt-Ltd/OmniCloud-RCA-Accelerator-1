import { parseRevenueConfigPrompt, type RelationRequest } from "@/lib/products/revenueConfig";

/**
 * Product prompts that are NOT a create: "Show me the configuration of X" (read) and "Update X and assign the Y Tax Policy" /
 * "Change the Unit of Measure to Each" / "Change the price to 2500" (targeted update, previewed before → after). Anything else is
 * a create and goes to the existing generate-payload flow unchanged. Pure and deterministic — no record is ever created here.
 */

export interface ProductChangeRequest { relations: RelationRequest; unitOfMeasure: string | null; unitPrice: string | null; priceBook: string | null }
export type ProductCommand =
  | { kind: "show"; product: string | null }
  | { kind: "update"; product: string | null; change: ProductChangeRequest; unnamed: string[] }
  | { kind: "create" };

const trimName = (s: string | undefined | null) => (s ?? "").replace(/^\s*(?:the\s+)?(?:product\s+)?/i, "").replace(/[\s."'“”]+$/g, "").replace(/^["'“]/, "").trim() || null;

export function parseProductCommand(prompt: string): ProductCommand {
  const p = prompt.trim();
  const low = p.toLowerCase();
  if (/^\s*(?:please\s+)?(?:create|add|new|make|build|set\s*up|define)\b/i.test(p)) return { kind: "create" };
  if (/\b(?:show|display|view|describe|get|what(?:'s| is))\b[^.]*\bconfig(?:uration)?\b/.test(low) || /^\s*(?:show|display|view)\b/i.test(p)) {
    const product = trimName(/\bconfig(?:uration)?\s+(?:of|for)\s+(.+?)\s*[.?!]*$/i.exec(p)?.[1])
      ?? trimName(/^\s*(?:show|display|view|describe)\s+(?:me\s+)?(?:the\s+)?(.+?)\s+(?:product\s+)?config(?:uration)?\b/i.exec(p)?.[1]);
    return { kind: "show", product };
  }
  if (/^\s*(?:please\s+)?(?:update|change|modify|set|assign|edit|switch|replace|move)\b/i.test(p)) {
    const rc = parseRevenueConfigPrompt(p);
    let product = trimName(/^\s*(?:please\s+)?(?:update|modify|edit)\s+(.+?)(?=\s+(?:and|to|with|so|by)\b|[,;:]|\.(?:\s|$)|$)/i.exec(p)?.[1]);
    if (!product) product = trimName(/\bto\s+(?:the\s+)?product\s+(.+?)\s*[.]?$/i.exec(p)?.[1]) ?? trimName(/\bon\s+(?:the\s+)?product\s+(.+?)\s*[.]?$/i.exec(p)?.[1]);
    if (product && /^(?:the\s+)?(?:unit of measure|uom|price|tax|billing)\b/i.test(product)) product = null;
    const unitOfMeasure = trimName(/\b(?:unit\s+of\s+measure|uom)\s*(?:to|=|:|as|is)\s*([A-Za-z][\w -]*?)(?=\s+(?:and|for)\b|[,;]|\.(?:\s|$)|$)/i.exec(p)?.[1]);
    const unitPrice = /\b(?:unit\s+)?price\s*(?:to|=|:|of|as)\s*(?:₹|\$|€|£|rs\.?\s*|inr\s*|usd\s*)?([\d,]+(?:\.\d+)?)/i.exec(p)?.[1]?.replace(/,/g, "") ?? null;
    return { kind: "update", product, change: { relations: rc.relations, unitOfMeasure, unitPrice, priceBook: rc.priceBook }, unnamed: rc.unnamed };
  }
  return { kind: "create" };
}
