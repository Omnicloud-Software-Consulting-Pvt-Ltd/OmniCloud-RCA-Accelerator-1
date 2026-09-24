/**
 * Shared (client + server) Product Price normalization.
 *
 * Every place a product price enters the pipeline — AI extraction output,
 * the review form, the bulk importer, /api/sf/products/save — goes through
 * `parseProductPrice()` so "₹50,000", "50,000", "$1,200.50", "5,00,000"
 * (Indian digit grouping) and 50000 all resolve to the same number. The
 * previous `parseFloat(value)` silently truncated at the first comma
 * ("50,000" → 50) and returned NaN for a leading currency symbol, which
 * dropped the price without any error.
 *
 * Commas are always treated as digit-grouping separators (Western and
 * Indian), "." as the decimal point. Anything that still isn't a plain
 * non-negative number after stripping currency symbols/codes, commas and
 * spaces is rejected — never guessed.
 */

export type PriceParseResult =
  | { ok: true; value: number; normalized: string }
  | { ok: false; error: string };

/** Returns null when no price was given at all (null/undefined/blank). */
export function parseProductPrice(raw: string | number | null | undefined): PriceParseResult | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0
      ? { ok: true, value: raw, normalized: String(raw) }
      : { ok: false, error: `Price "${raw}" is not a valid non-negative number.` };
  }
  const text = raw.trim();
  if (!text) return null;

  // Drop currency symbols/ISO codes/words ("₹", "$", "INR", "Rs."), grouping commas and whitespace.
  const stripped = text
    .replace(/\b(?:rs|inr|usd|eur|gbp|aud|cad|jpy)\b\.?/gi, "")
    .replace(/[,\s _]/g, "")
    .replace(/[^\d.\-]/g, "");

  if (!/^\d+(?:\.\d+)?$/.test(stripped)) {
    return { ok: false, error: `Price "${raw}" is not a valid non-negative number.` };
  }
  const value = Number(stripped);
  if (!Number.isFinite(value)) return { ok: false, error: `Price "${raw}" is not a valid number.` };
  return { ok: true, value, normalized: String(value) };
}

/** Display helper — shows the ISO code when known instead of assuming "$". */
export function formatProductPrice(value: string | number | null | undefined, currencyIsoCode?: string | null): string {
  if (value === null || value === undefined || value === "") return "";
  const parsed = parseProductPrice(value);
  if (!parsed || !parsed.ok) return String(value);
  const amount = parsed.value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return currencyIsoCode ? `${currencyIsoCode.toUpperCase()} ${amount}` : amount;
}
