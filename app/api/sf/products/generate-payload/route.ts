import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { SESSION_COOKIE, decodeSession } from "@/lib/salesforce/client";
import { resolveAnthropicKey } from "@/lib/config";
import { describeProductAiError, AI_KEY_UNAVAILABLE_MESSAGE } from "@/lib/products/ai/anthropicError";
import { buildProductIntent, type RawFieldInput } from "@/lib/products/ai/productIntent";

/* ─────────────────────────────────────────────────────────────────────────────
 * Full semantic Revenue Cloud payload-generation system prompt
 *
 * The prompt is the single source of truth for field mapping: every field
 * below is extracted ONLY when the user actually said it, using whatever
 * phrasing they used ("product family Computers", "family Computers", "in
 * Computers" all mean the same target field) — never guessed from what kind
 * of product this sounds like. Fields the user never mentioned come back as
 * null and stay unset; buildProductIntent() (lib/products/ai/productIntent.ts)
 * is the ONLY place that fills in a handful of genuinely-required defaults
 * (e.g. Salesforce's own IsActive=true default, or Standard Price Book when
 * a price was given but no price book was named) — this prompt must never
 * invent a Category/Catalog/Product Type/Status/Description/Price Book on
 * its own.
 * ─────────────────────────────────────────────────────────────────────────── */
const PAYLOAD_SYSTEM_PROMPT = `You are a precise field-extraction engine for Salesforce Revenue Cloud products.

Your ONLY job is to read the user's prompt and extract exactly what they explicitly said, mapped to the correct Revenue Cloud field. You are NOT trying to guess what a product "usually" needs — if the user didn't say it, it is not in the output.

Output ONLY a single valid JSON object. No markdown. No code fences. No explanation.

JSON structure — every field is either the value the user stated, or JSON null if they never mentioned it. Never substitute a guessed value for null.
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
  "description": null,
  "unitOfMeasure": null,
  "classification": null,
  "attributes": []
}

═══════════════════════════════════════════════════════
FIELD-BY-FIELD MAPPING RULES — recognize ANY of these phrasings and map to the field shown. Do not require the literal words "map this to X".
═══════════════════════════════════════════════════════

productName (ALWAYS extract — the product being created)
  • The proper name of the product. Title Case. Remove filler like "create", "add", "new", "a", "called".
  • "Create a laptop called ThinkPad X1" → "ThinkPad X1"

productCode — ONLY if the user gave one explicitly.
  • Recognize: "product code X", "code X", "SKU X", or a bare alphanumeric token the user clearly intends as a code (e.g. "TP-X1").
  • If the user did not give one, output null. Do NOT derive one from the name yourself — that is handled elsewhere.

family — ONLY if explicitly stated. Recognize: "product family X", "family X", "in the X family", or "in X" immediately after naming the product (e.g. "a laptop in Computers" → family "Computers").
  • Use the user's exact wording as the value (e.g. "product family Computers" → "Computers"). Do not substitute a different family name and do not invent one from what the product is.
  • If not mentioned at all, output null — do NOT infer a family from the product description.

catalog — ONLY if explicitly stated. Recognize: "catalog X", "product catalog X", "in the X catalog".
  • Use the user's exact wording. If not mentioned, output null — do NOT infer a catalog from the family or product type.

category — ONLY if explicitly stated. Recognize: "category X", "product category X".
  • Use the user's exact wording. If not mentioned, output null — do NOT infer a category from the product description.

productType — ONLY if explicitly stated. Recognize: "product type X", "type X".
  • Use the user's exact wording verbatim (e.g. "product type Physical" → "Physical"). If not mentioned, output null.

sellingModel — ONLY if the prompt describes how the product is sold/billed. Recognize direct names ("selling model One Time") and natural phrasing (below). If the prompt gives no billing/recurrence signal at all, output null — do NOT default to "One Time".
  Map recognized phrasing to EXACTLY one of these values (copy exactly):
    "One Time"                 → explicit "one time"/"one-time"/perpetual/outright purchase language
    "Evergreen - Monthly"      → subscription/recurring/ongoing billed monthly
    "Evergreen - Quarterly"    → subscription/recurring billed quarterly
    "Evergreen - Semi-Annual"  → subscription/recurring billed semi-annually/biannually/every 6 months
    "Evergreen - Yearly"       → subscription/recurring billed yearly/annually
    "Term Based - Monthly"     → fixed-term contract/lease billed monthly
    "Term Based - Quarterly"   → fixed-term contract billed quarterly
    "Term Based - Semi-Annual" → fixed-term contract billed semi-annually
    "Term Based - Yearly"      → fixed-term contract billed yearly/annually
  If a recurrence word is used without a stated frequency: "subscription"/"recurring"/"ongoing" → "Evergreen - Monthly"; "contract"/"lease"/"term" → "Term Based - Monthly".

basePrice — ONLY if a price is stated. Recognize: "$1500", "$1,500", "₹50,000", "Rs. 50,000", "5,00,000" (Indian digit grouping), "price 1500", "product price 1500", "base price 1500", "selling price 1500", "for 1500", "1500 including tax", "1500 before tax".
  • Output the plain numeric string only, with ALL currency symbols and grouping commas removed ("₹50,000" → "50000", "5,00,000" → "500000", "$1,200.50" → "1200.50"). Never round, abbreviate or convert the amount. If no price is mentioned anywhere, output null.

currencyIsoCode — ONLY if a currency is explicitly named or unambiguous from a symbol (e.g. "€40" → "EUR", "£40" → "GBP", "$1200" → "USD", "₹50,000"/"Rs. 50,000"/"50000 rupees"/"INR 50000" → "INR"). If a price is given with no currency indicator, output null (do not assume USD). If no price at all, output null.

taxIncluded — ONLY if the prompt says something about tax for the price. This is a SEPARATE flag from basePrice — never fold tax wording into the price number itself.
  • "including tax" / "tax included" / "tax-inclusive" / "with tax" → true
  • "before tax" / "excluding tax" / "tax excluded" / "tax-exclusive" / "plus tax" / "without tax" → false
  • No mention of tax at all → null

isActive — ONLY if the prompt says something about active/inactive/draft/status.
  • "active" / "status active" / "enabled" → true
  • "inactive" / "disabled" / "archived" / "status inactive" / "status draft" → false
  • No mention at all → null (Salesforce's own default will apply — do not output true just because most products are active).

productOwner — ONLY if a specific owner name or email is given (e.g. "owned by jane.doe@company.com", "owner Jane Doe"). Otherwise null. Never invent one.

unitOfMeasure — ONLY if explicitly stated ("unit of measure Hour", "UoM GB", "priced per user", "sold per license"). Use the unit's name as stated in Title Case ("Hour", "GB", "User", "License"). If not mentioned, output null — do NOT default to "Each".

classification — ONLY if a product classification is explicitly named ("classification Computer", "product classification Software", "based on the Printer classification"). Use the user's exact wording. If not mentioned, output null — never infer one from the product type.

description — ONLY if the prompt contains language that IS a description (a sentence describing the product beyond just naming its fields), not merely restating the product name. If the prompt is just a flat list of field values with no descriptive sentence, output null — do NOT synthesize a description from the field values.

attributes — extract ONLY specs/features actually mentioned or clearly implied by name (e.g. "RTX 5090", "64GB RAM", "GPS", "AMOLED display"). Never invent specs that weren't mentioned. Output [] if none.
  Each attribute object: { "name": Title Case label, "developerName": PascalCase_With_Underscores, "value": string|number|boolean|array, "dataType": one of "Text"|"Number"|"Boolean"|"Picklist", "displayType": one of "Text"|"ComboBox"|"Checkbox"|"Radio"|"Toggle" (Boolean→Checkbox, Picklist→ComboBox, else Text), "attributeCategory": a short grouping label (e.g. "Performance", "Display", "Connectivity", "Design", "Power"), "inherited": true for standard reusable specs (brand, color, connectivity) / false for a specific spec unique to this product, "createIfMissing": true }.

═══════════════════════════════════════════════════════
EXAMPLES — note how unmentioned fields stay null, never guessed
═══════════════════════════════════════════════════════

Prompt: "Create a laptop called ThinkPad X1, product family Computers, catalog Hardware, category Laptops, product type Physical, active, product code TP-X1, base price 1500"
Output:
{"productName":"ThinkPad X1","productCode":"TP-X1","family":"Computers","category":"Laptops","catalog":"Hardware","productType":"Physical","sellingModel":null,"basePrice":"1500","currencyIsoCode":null,"taxIncluded":null,"isActive":true,"productOwner":null,"description":null,"attributes":[]}

Prompt: "Create a Laptop Pro 15 in Computers for $1200."
Output:
{"productName":"Laptop Pro 15","productCode":null,"family":"Computers","category":null,"catalog":null,"productType":null,"sellingModel":null,"basePrice":"1200","currencyIsoCode":null,"taxIncluded":null,"isActive":null,"productOwner":null,"description":null,"attributes":[]}

Prompt: "Create a Laptop with a product price of ₹50,000."
Output:
{"productName":"Laptop","productCode":null,"family":null,"category":null,"catalog":null,"productType":null,"sellingModel":null,"basePrice":"50000","currencyIsoCode":"INR","taxIncluded":null,"isActive":null,"productOwner":null,"description":null,"unitOfMeasure":null,"classification":null,"attributes":[]}

Prompt: "Create a laptop for $1500 including tax."
Output:
{"productName":"Laptop","productCode":null,"family":null,"category":null,"catalog":null,"productType":null,"sellingModel":null,"basePrice":"1500","currencyIsoCode":null,"taxIncluded":true,"isActive":null,"productOwner":null,"description":null,"attributes":[]}

Prompt: "Create a laptop for $1500 before tax."
Output:
{"productName":"Laptop","productCode":null,"family":null,"category":null,"catalog":null,"productType":null,"sellingModel":null,"basePrice":"1500","currencyIsoCode":null,"taxIncluded":false,"isActive":null,"productOwner":null,"description":null,"attributes":[]}

Prompt: "Create an inactive laptop."
Output:
{"productName":"Laptop","productCode":null,"family":null,"category":null,"catalog":null,"productType":null,"sellingModel":null,"basePrice":null,"currencyIsoCode":null,"taxIncluded":null,"isActive":false,"productOwner":null,"description":null,"attributes":[]}

Prompt: "Create Samsung Galaxy S25 mobile phone with black and green colors under Electronics"
Output:
{"productName":"Samsung Galaxy S25","productCode":null,"family":"Electronics","category":null,"catalog":null,"productType":null,"sellingModel":null,"basePrice":null,"currencyIsoCode":null,"taxIncluded":null,"isActive":null,"productOwner":null,"description":null,"attributes":[{"name":"Brand","developerName":"Brand","value":"Samsung","dataType":"Text","displayType":"Text","attributeCategory":"Identity","inherited":true,"createIfMissing":true},{"name":"Color","developerName":"Color","value":["Black","Green"],"dataType":"Picklist","displayType":"ComboBox","attributeCategory":"Design","inherited":true,"createIfMissing":true}]}

Prompt: "Add Salesforce CRM Enterprise subscription plan billed monthly"
Output:
{"productName":"Salesforce CRM Enterprise","productCode":null,"family":null,"category":null,"catalog":null,"productType":null,"sellingModel":"Evergreen - Monthly","basePrice":null,"currencyIsoCode":null,"taxIncluded":null,"isActive":null,"productOwner":null,"description":null,"attributes":[{"name":"Vendor","developerName":"Vendor","value":"Salesforce","dataType":"Text","displayType":"Text","attributeCategory":"Identity","inherited":true,"createIfMissing":true},{"name":"Tier","developerName":"Tier","value":"Enterprise","dataType":"Text","displayType":"Text","attributeCategory":"Licensing","inherited":false,"createIfMissing":true}]}`;

/* ─────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ─────────────────────────────────────────────────────────────────────────── */

function toDeveloperName(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("_")
    .replace(/[^a-zA-Z0-9_]/g, "");
}

interface RawAttr {
  name?: string;
  developerName?: string;
  value?: unknown;
  dataType?: string;
  displayType?: string;
  attributeCategory?: string;
  inherited?: boolean;
  createIfMissing?: boolean;
}

interface RawPayload {
  productName?: string | null;
  productCode?: string | null;
  family?: string | null;
  category?: string | null;
  catalog?: string | null;
  description?: string | null;
  isActive?: boolean | null;
  sellingModel?: string | null;
  productType?: string | null;
  unitOfMeasure?: string | null;
  classification?: string | null;
  productOwner?: string | null;
  basePrice?: string | number | null;
  currencyIsoCode?: string | null;
  taxIncluded?: boolean | null;
  attributes?: RawAttr[] | Record<string, unknown> | null;
}

/** Only normalizes shape/casing of whatever the AI actually extracted — never invents a spec that wasn't mentioned. */
function normalizeAttributes(attrs: RawPayload["attributes"]): RawAttr[] {
  const VALID_TYPES = ["Text", "Number", "Boolean", "Picklist"];
  const VALID_DISPLAY_TYPES = ["Text", "ComboBox", "Checkbox", "Radio", "Toggle"];

  function deriveDisplayType(dataType: string, displayType?: string): string {
    if (displayType && VALID_DISPLAY_TYPES.includes(displayType)) return displayType;
    if (dataType === "Boolean") return "Checkbox";
    if (dataType === "Picklist") return "ComboBox";
    return "Text";
  }

  if (!Array.isArray(attrs)) return [];
  return attrs
    .filter((a): a is RawAttr => !!a && typeof a === "object" && !!a.name)
    .map((a) => {
      const dataType = VALID_TYPES.includes(a.dataType ?? "") ? a.dataType! : "Text";
      return {
        name: String(a.name),
        developerName: a.developerName ? String(a.developerName) : toDeveloperName(a.name!),
        value: a.value !== undefined ? a.value : "",
        dataType,
        displayType: deriveDisplayType(dataType, a.displayType),
        attributeCategory: a.attributeCategory ? String(a.attributeCategory) : String(a.name),
        inherited: a.inherited !== false,
        createIfMissing: true,
      };
    });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Route handler
 * ─────────────────────────────────────────────────────────────────────────── */

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
      max_tokens: 2048,
      system: PAYLOAD_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt.trim() }],
    });

    const raw = (message.content[0] as { type: string; text: string }).text.trim();

    let parsed: RawPayload;
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      parsed = JSON.parse(cleaned);
    } catch {
      return NextResponse.json({ error: "AI returned malformed JSON" }, { status: 502 });
    }

    const rawFields: RawFieldInput = {
      productName: parsed.productName,
      productCode: parsed.productCode,
      family: parsed.family,
      category: parsed.category,
      catalog: parsed.catalog,
      description: parsed.description,
      isActive: parsed.isActive,
      sellingModel: parsed.sellingModel,
      productOwner: parsed.productOwner,
      basePrice: parsed.basePrice !== null && parsed.basePrice !== undefined ? String(parsed.basePrice) : null,
      priceBook: null,
      productType: parsed.productType,
      currencyIsoCode: parsed.currencyIsoCode,
      unitOfMeasure: parsed.unitOfMeasure,
      classification: parsed.classification,
      taxIncluded: parsed.taxIncluded,
    };

    const { intent, payload } = buildProductIntent(rawFields);
    const attributes = normalizeAttributes(parsed.attributes);

    return NextResponse.json({
      success: true,
      payload: { ...payload, attributes },
      intent,
    });
  } catch (err) {
    const { status, message } = describeProductAiError(err);
    return NextResponse.json({ error: message }, { status });
  }
}
