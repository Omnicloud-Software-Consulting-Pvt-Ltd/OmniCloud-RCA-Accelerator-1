import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { SESSION_COOKIE, decodeSession } from "@/lib/salesforce/client";
import { resolveAnthropicKey } from "@/lib/config";
import { describeProductAiError, AI_KEY_UNAVAILABLE_MESSAGE } from "@/lib/products/ai/anthropicError";
import { buildProductIntent, type RawFieldInput, type ProductIntentMap } from "@/lib/products/ai/productIntent";
import type { ProductPayload } from "@/lib/products/types";

/**
 * Multi-product variant of app/api/sf/products/generate-payload/route.ts's
 * AI parsing step — same explicit-only extraction philosophy, same
 * centralized buildProductIntent() mapping layer, extended to split a
 * single prompt into N independent products. Every product's fields are
 * derived ONLY from what the prompt says about THAT product; a field never
 * mentioned for a given product comes back null and stays unspecified —
 * never copied from another product in the same prompt and never guessed
 * from what the product sounds like. This route itself never touches
 * Salesforce.
 */
const MULTI_PRODUCT_SYSTEM_PROMPT = `You are a precise field-extraction engine for Salesforce Revenue Cloud products.

The user's prompt describes ONE OR MORE products in natural language — they may be separated by semicolons, "and", numbered/lettered lists, or simply described one after another. Identify every distinct product mentioned and extract an independent field mapping for EACH one.

Your ONLY job is to extract exactly what the user explicitly said about EACH product, mapped to the correct field. You are NOT trying to guess what a product "usually" needs — if a field was not mentioned for a given product, it is null for that product, even if a sibling product in the same prompt did specify it.

Output ONLY a single valid JSON object. No markdown. No code fences. No explanation.

JSON structure:
{
  "products": [
    {
      "productName": "",
      "productCode": null,
      "family": null,
      "category": null,
      "catalog": null,
      "productType": null,
      "sellingModel": null,
      "basePrice": null,
      "currencyIsoCode": null,
      "taxIncluded": null,
      "isActive": null,
      "productOwner": null,
      "description": null
    }
  ]
}

═══════════════════════════════════════════════════════
CRITICAL RULE — FIELD INDEPENDENCE
═══════════════════════════════════════════════════════
Every product's fields must be derived ONLY from what the prompt says about THAT product. Do NOT copy another product's family, category, catalog, selling model, price, tax, or any other field onto a product that didn't specify it — output null for that product's field instead, UNLESS the prompt explicitly states the value applies to all products (e.g. "all of these use the One Time selling model" or "every product is billed monthly").

═══════════════════════════════════════════════════════
FIELD-BY-FIELD MAPPING RULES (apply independently to each product) — recognize ANY of these phrasings and map to the field shown, without requiring the literal words "map this to X".
═══════════════════════════════════════════════════════

productName (ALWAYS extract for each product)
  • Title Case. Remove filler like "create", "add", "new".

productCode — ONLY if given explicitly for THIS product ("product code X", "code X", "SKU X"). Otherwise null — do not derive one yourself.

family — ONLY if explicitly stated for THIS product ("product family X", "family X", "in the X family", "in X" right after the product name). Use the user's exact wording. If not mentioned, null — do NOT infer a family from what the product is.

catalog — ONLY if explicitly stated ("catalog X", "product catalog X"). If not mentioned, null — do NOT infer a catalog from the family.

category — ONLY if explicitly stated ("category X", "product category X"). If not mentioned, null — do NOT infer a category from the product description.

productType — ONLY if explicitly stated ("product type X", "type X"). Use the user's exact wording verbatim. If not mentioned, null.

sellingModel — ONLY if the prompt describes billing/recurrence for THIS product. If no signal at all, null — do NOT default to "One Time".
  Map to EXACTLY one of these values (copy exactly, including capitalisation and dashes):
    "One Time"                 → explicit one-time/perpetual/outright purchase language
    "Evergreen - Monthly"      → recurring/subscription billed monthly
    "Evergreen - Quarterly"    → recurring/subscription billed quarterly
    "Evergreen - Semi-Annual"  → recurring/subscription billed semi-annually/biannually
    "Evergreen - Yearly"       → recurring/subscription billed yearly/annually
    "Term Based - Monthly"     → fixed-term contract billed monthly
    "Term Based - Quarterly"   → fixed-term contract billed quarterly
    "Term Based - Semi-Annual" → fixed-term contract billed semi-annually
    "Term Based - Yearly"      → fixed-term contract billed yearly/annually
  Unstated frequency: "subscription"/"recurring"/"ongoing" → "Evergreen - Monthly"; "contract"/"lease"/"term" → "Term Based - Monthly".

basePrice — ONLY if a price is stated for THIS product ("$1200", "$1,200", "price 1200", "base price 1200", "selling price 1200", "1200 including tax", "1200 before tax"). Output the plain numeric string only. If none, null.

currencyIsoCode — ONLY if a currency is named or unambiguous from a symbol (€→EUR, £→GBP, $→USD). If a price is given with no currency indicator, null (never assume USD). If no price, null.

taxIncluded — a SEPARATE flag from basePrice; never fold into the price number.
  • "including tax"/"tax included"/"with tax" → true
  • "before tax"/"excluding tax"/"tax excluded"/"plus tax" → false
  • Not mentioned for this product → null

isActive — ONLY if the prompt says active/inactive/status for THIS product.
  • "active"/"status active"/"enabled" → true
  • "inactive"/"disabled"/"status inactive" → false
  • Not mentioned → null (do not default to true yourself)

productOwner — ONLY if a specific name/email is given for this product. Otherwise null.

description — ONLY if the prompt has an actual descriptive sentence for this product beyond restating its field values. If the prompt is just a flat list of field values, null — do NOT synthesize one.

═══════════════════════════════════════════════════════
EXAMPLES — note independence between products and null for anything unmentioned
═══════════════════════════════════════════════════════

Prompt: "Create three products: Laptop Pro 15, family Computers, catalog Hardware Catalog, category Laptops, product type Physical, active, price 1200 including tax. Wireless Mouse, family Accessories, catalog Hardware Catalog, category Computer Accessories, product type Physical, price 40. Office Monitor 27, family Displays, catalog Hardware Catalog, category Monitors, product type Physical, inactive, price 300 before tax."
Output:
{"products":[{"productName":"Laptop Pro 15","productCode":null,"family":"Computers","category":"Laptops","catalog":"Hardware Catalog","productType":"Physical","sellingModel":null,"basePrice":"1200","currencyIsoCode":null,"taxIncluded":true,"isActive":true,"productOwner":null,"description":null},{"productName":"Wireless Mouse","productCode":null,"family":"Accessories","category":"Computer Accessories","catalog":"Hardware Catalog","productType":"Physical","sellingModel":null,"basePrice":"40","currencyIsoCode":null,"taxIncluded":null,"isActive":null,"productOwner":null,"description":null},{"productName":"Office Monitor 27","productCode":null,"family":"Displays","category":"Monitors","catalog":"Hardware Catalog","productType":"Physical","sellingModel":null,"basePrice":"300","currencyIsoCode":null,"taxIncluded":false,"isActive":false,"productOwner":null,"description":null}]}

Prompt: "Create: Laptop Pro 15, family Computers, category Laptops, price 1200. Wireless Mouse, family Accessories, category Computer Accessories, price 40. Office Monitor 27, family Displays, category Monitors, price 300."
Output:
{"products":[{"productName":"Laptop Pro 15","productCode":null,"family":"Computers","category":"Laptops","catalog":null,"productType":null,"sellingModel":null,"basePrice":"1200","currencyIsoCode":null,"taxIncluded":null,"isActive":null,"productOwner":null,"description":null},{"productName":"Wireless Mouse","productCode":null,"family":"Accessories","category":"Computer Accessories","catalog":null,"productType":null,"sellingModel":null,"basePrice":"40","currencyIsoCode":null,"taxIncluded":null,"isActive":null,"productOwner":null,"description":null},{"productName":"Office Monitor 27","productCode":null,"family":"Displays","category":"Monitors","catalog":null,"productType":null,"sellingModel":null,"basePrice":"300","currencyIsoCode":null,"taxIncluded":null,"isActive":null,"productOwner":null,"description":null}]}

Prompt: "Add a monthly Salesforce CRM Enterprise subscription and a one-time Enterprise Support Contract billed quarterly."
Output:
{"products":[{"productName":"Salesforce CRM Enterprise","productCode":null,"family":null,"category":null,"catalog":null,"productType":null,"sellingModel":"Evergreen - Monthly","basePrice":null,"currencyIsoCode":null,"taxIncluded":null,"isActive":null,"productOwner":null,"description":null},{"productName":"Enterprise Support Contract","productCode":null,"family":null,"category":null,"catalog":null,"productType":null,"sellingModel":"Term Based - Quarterly","basePrice":null,"currencyIsoCode":null,"taxIncluded":null,"isActive":null,"productOwner":null,"description":null}]}`;

interface RawMultiProduct {
  productName?: string | null;
  productCode?: string | null;
  family?: string | null;
  category?: string | null;
  catalog?: string | null;
  productType?: string | null;
  sellingModel?: string | null;
  basePrice?: string | number | null;
  currencyIsoCode?: string | null;
  taxIncluded?: boolean | null;
  isActive?: boolean | null;
  productOwner?: string | null;
  description?: string | null;
}

export interface GenerateMultiProductResponse {
  success: true;
  products: ProductPayload[];
  intents: ProductIntentMap[];
}

function sanitizeRaw(raw: unknown): RawMultiProduct | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.productName === "string" ? r.productName.trim() : "";
  if (!name) return null;
  return { ...r, productName: name } as RawMultiProduct;
}

export async function POST(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE);
  if (!cookie?.value || !decodeSession(cookie.value)) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let prompt: string;
  try {
    ({ prompt } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!prompt?.trim()) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }

  const apiKey = resolveAnthropicKey(req);
  if (!apiKey) {
    return NextResponse.json(
      { error: AI_KEY_UNAVAILABLE_MESSAGE, code: "NO_AI_KEY" },
      { status: 503 },
    );
  }

  const anthropic = new Anthropic({ apiKey });

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: MULTI_PRODUCT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt.trim() }],
    });

    const raw = (message.content[0] as { type: string; text: string }).text.trim();

    let parsed: { products?: unknown[] };
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      parsed = JSON.parse(cleaned);
    } catch {
      return NextResponse.json({ error: "AI returned malformed JSON" }, { status: 502 });
    }

    const rawProducts = Array.isArray(parsed.products)
      ? parsed.products.map(sanitizeRaw).filter((p): p is RawMultiProduct => p !== null)
      : [];

    if (rawProducts.length === 0) {
      return NextResponse.json({ error: "Could not identify any products in this prompt." }, { status: 422 });
    }

    const built = rawProducts.map(p => {
      const rawFields: RawFieldInput = {
        productName: p.productName,
        productCode: p.productCode,
        family: p.family,
        category: p.category,
        catalog: p.catalog,
        description: p.description,
        isActive: p.isActive,
        sellingModel: p.sellingModel,
        productOwner: p.productOwner,
        basePrice: p.basePrice !== null && p.basePrice !== undefined ? String(p.basePrice) : null,
        priceBook: null,
        productType: p.productType,
        currencyIsoCode: p.currencyIsoCode,
        taxIncluded: p.taxIncluded,
      };
      return buildProductIntent(rawFields);
    });

    const response: GenerateMultiProductResponse = {
      success: true,
      products: built.map(b => b.payload),
      intents: built.map(b => b.intent),
    };
    return NextResponse.json(response);
  } catch (err) {
    const { status, message } = describeProductAiError(err);
    return NextResponse.json({ error: message }, { status });
  }
}
