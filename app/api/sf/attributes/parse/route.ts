import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { SESSION_COOKIE, decodeSession } from "@/lib/salesforce/client";

/* ─────────────────────────────────────────────────────────────────────────────
 * RCA Semantic Parsing System Prompt
 * Exact implementation from uploaded RCA architecture
 * ─────────────────────────────────────────────────────────────────────────── */
const RCA_SYSTEM_PROMPT = `You are a Salesforce Revenue Cloud Advanced (RCA) business architect — not a field parser.

Your job is NOT to convert every detected field into an attribute. Your job is to apply business reasoning to determine which characteristics belong in RCA as product attributes and which belong elsewhere (ERP, WMS, PricebookEntry, audit logs).

==================================================
SEMANTIC REASONING — DO THIS BEFORE EVERY FIELD
==================================================

For each field in the input, ask these questions IN ORDER:

  Q1: Is this a monetary amount (price, cost, margin, MRP, billing amount, or pricing rate)?
      YES → belongs in PricebookEntry → OMIT from attributes
      ⚠ STRICT: "Price", "Pricing", "MRP", "Unit Rate", "Billing Rate", "Net Amount",
        "Total Amount", "Billing Amount", "Price Product Attribute", "Pricing Attribute"
        → ALL must be omitted. NEVER put any price/cost/rate/amount field into attributes.

  Q2: Is this an internal system identifier, tracking code, or reference number?
      YES → belongs in ERP/backend → OMIT from attributes

  Q3: Is this warehouse location data, logistics data, or physical storage metadata?
      YES → belongs in WMS/logistics → OMIT from attributes

  Q4: Is this audit metadata, system-generated data, or operational tracking?
      YES → belongs in audit logs → OMIT from attributes

  Q5: Would a customer configuring or purchasing this product ever see or care about this?
      NO → OMIT from attributes
      YES → include as the appropriate attribute type

Only fields that pass ALL five questions belong in the attributes array.

==================================================
CORE PRINCIPLE: CONFIGURABLE vs INFORMATIONAL
==================================================

CONFIGURABLE attributes (configurable: true, dataType: "Picklist"):
  The customer actively selects from discrete named options when purchasing.
  These are purchase-driving decisions that determine what product the customer gets.

  Classic configurable attributes:
  Computing: RAM: 8GB, 16GB, 32GB → Picklist; Storage: 256GB, 512GB → Picklist
  Television: Screen Size: 65, 75, 85 → Picklist; Display Mode: Standard, HDR → Picklist
  Wearables: Watch Size: 41mm, 45mm → Picklist; Band Finish: Titanium, Steel → Picklist
  Drones: Flight Mode: Sport, Cinematic → Picklist; Camera Resolution: 4K, 2.7K → Picklist

  CRITICAL: values being numeric does NOT make an attribute informational.
  When a customer SELECTS between options, use Picklist even if the options are numbers.

  Rules:
    → dataType = "Picklist"
    → configurable = true
    → required = true
    → values = ["option1", "option2", ...] — list ALL selectable options
    → defaultValue = null

INFORMATIONAL attributes (configurable: false, dataType: Number/Boolean/Text):
  Fixed product specifications set by the manufacturer that the customer cannot change.

  Number — fixed measurable specifications:
    Weight: 1.5 → Number; Refresh Rate: 144 → Number; Battery Capacity: 4000 → Number

  Boolean — yes/no feature flags:
    Touchscreen Enabled → Boolean; WiFi Enabled → Boolean; Waterproof Enabled → Boolean

  Text — freeform informational content:
    Product Description → Text; Marketing Notes → Text

  Rules:
    → dataType = "Number" | "Boolean" | "Text"
    → configurable = false
    → required = false
    → values = []
    → defaultValue = the actual value as a string

==================================================
DATATYPE RULES
==================================================

Picklist: ONLY for customer-configurable selection. Values CAN be numeric (RAM tiers, screen sizes).
  → configurable: true, values: ["opt1","opt2"], defaultValue: null

Number: ONLY for single fixed measurable specs with NO customer selection.
  → configurable: false, values: [], defaultValue: "1.5"
  NEVER use for Price or Cost — those belong in PricebookEntry and must be omitted entirely.

Boolean: ONLY for yes/no feature flags.
  Signs: name contains Enabled/Disabled/Supported/Available/Is/Has/Can
  → configurable: false, values: [], defaultValue: "true" or "false"

Text: ONLY for freeform descriptions, notes, or marketing content.
  → configurable: false, values: [], defaultValue: "the actual text"

==================================================
FIELDS TO COMPLETELY OMIT
==================================================

CATEGORY 1: PRICE & COMMERCIAL DATA → PricebookEntry, NEVER attributes
  Price, List Price, Unit Price, Sale Price, MSRP, MRP, RRP, Cost, Margin, Markup, Discount
  Net/Gross/Total/Billing Amount, Unit/Billing/Contract/Selling Rate
  "Price Product Attribute", "Pricing Attribute", "Product Price"

CATEGORY 2: ERP & INTERNAL IDENTIFIERS → ERP/backend, NEVER attributes
  ERP Reference, ERP ID, Tracking ID, System ID, Procurement Code, Batch ID
  Purchase Order, Vendor Code, SKU Code, Internal Reference

CATEGORY 3: WAREHOUSE & LOGISTICS → WMS, NEVER attributes
  Warehouse ID, Shelf Code, Bin Location, Aisle Code, Rack Number
  Routing Code, Dispatch Code, Fulfillment Code, Logistics Reference

CATEGORY 4: AUDIT & SYSTEM METADATA → audit logs, NEVER attributes
  Audit Metadata, Created By, Modified By, System Generated Fields

CATEGORY 5: ENGINEERING & FIRMWARE → engineering systems, NEVER attributes
  Firmware Build ID, Debug Mode, Engineering Notes, Prototype ID, Calibration ID
  Packaging Slot, Dispatch Zone

==================================================
CRITICAL RULES
==================================================

- Return ONLY valid JSON, no markdown, no explanation
- Do NOT blindly convert every field to Picklist
- Do NOT include pricing, ERP, procurement, warehouse, or audit fields in attributes
- Analyze BUSINESS MEANING and customer configurability FIRST

ATTRIBUTE ELIGIBILITY — final gate:
  ✓ Customer selectable or product-experience relevant?
  ✓ Would appear on a product detail page a customer reads?
  ✓ Drives a purchase decision or describes a product spec?
  If any answer is NO → DO NOT include the field.

- If not specified, infer productCode from name
- If not specified, infer productFamily from context
- If not specified, infer productType as "Goods"
- Default sellingModel to "One Time" unless specified
- Group all attributes under a single category unless specified
- Classification name = productFamily by default`;

/* ─────────────────────────────────────────────────────────────────────────────
 * Types
 * ─────────────────────────────────────────────────────────────────────────── */
interface ParsedAttribute {
  name: string;
  dataType: string;
  configurable: boolean;
  required: boolean;
  active: boolean;
  description: string;
  values: string[];
  defaultValue: string | null;
}

interface SkippedField {
  name: string;
  reason: string;
}

interface RawParseResult {
  productName?: string;
  productCode?: string;
  productFamily?: string;
  productType?: string;
  description?: string;
  isActive?: boolean;
  unitOfMeasure?: string;
  sellingModel?: string;
  classificationName?: string;
  categoryName?: string;
  skipped?: SkippedField[];
  attributes?: ParsedAttribute[];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Eligibility filters (deterministic post-AI pass)
 * ─────────────────────────────────────────────────────────────────────────── */
function isExcludedAttribute(name: string): boolean {
  const n = (name || "").toLowerCase().trim();
  if (/\b(price|pricing|list\s+price|unit\s+price|sale\s+price|retail\s+price|msrp|mrp|margin|markup|discount|surcharge)\b/.test(n)) return true;
  if (/\bcost\b/.test(n) && !/\bno[\s-]?cost\b/.test(n)) return true;
  if (/\b(unit|base|standard|billing|flat|list|contract|selling|trade|wholesale|retail|market|tariff)\s+rate\b/.test(n)) return true;
  if (/\b(price|net|gross|total|billed|charge|payment|invoice|sale|retail|trade|billing|commercial|monetary)\s+amount\b/.test(n)) return true;
  if (/\bamount\s+(due|charged|billed|invoiced|payable)\b/.test(n)) return true;
  if (/\berp\b/.test(n)) return true;
  if (/\btracking\s+(id|code|number|ref(erence)?)\b/.test(n)) return true;
  if (/\bprocurement\b/.test(n)) return true;
  if (/\bwarehouse\b/.test(n)) return true;
  if (/\bshelf\s+(code|id|location)\b/.test(n)) return true;
  if (/\b(bin|aisle|rack|bay)\s+(code|id|location)\b/.test(n)) return true;
  if (/\baudit\b/.test(n)) return true;
  if (/\bbatch\s+(id|number|code|ref)\b/.test(n)) return true;
  if (/\bfirmware\s+(build|id|hash|code)\b/.test(n)) return true;
  if (/\bdebug\b/.test(n)) return true;
  if (/\bengineering\b/.test(n)) return true;
  if (/\bprototype\b/.test(n)) return true;
  if (/\bcalibration\s+(id|code|cert(ificate)?)\b/.test(n)) return true;
  if (/\bpackaging\s+(slot|bin|location)\b/.test(n)) return true;
  if (/\binternal\s+(batch|sku|notes?|ref|id|metadata|erp|system|audit|tracking|firmware)\b/.test(n)) return true;
  return false;
}

function inferDataType(name: string, values: string[], aiDataType: string, aiConfigurable: boolean): string {
  const nameLower = (name || "").toLowerCase();
  const vals = (Array.isArray(values) ? values : []).map(v => String(v).trim()).filter(Boolean);

  if (aiConfigurable === true && vals.length >= 2) return "Picklist";

  if (vals.length > 0 && vals.length <= 2) {
    const vl = vals.map(v => v.toLowerCase());
    const BOOL_PAIRS = [["yes","no"],["true","false"],["enabled","disabled"],["on","off"],["active","inactive"]];
    for (const [a, b] of BOOL_PAIRS) {
      if (vl.includes(a) && vl.includes(b)) return "Boolean";
    }
  }

  if (/\b(enabled|disabled|supported|available|active|inactive)\b/.test(nameLower) ||
      /^(is |has |can |allows? |supports? )/.test(nameLower)) return "Boolean";

  if (vals.length > 0 && aiConfigurable !== true &&
      vals.every(v => /^[\d,]+(\.\d+)?$/.test(v.replace(/\s/g, "")))) return "Number";

  if (aiConfigurable !== true &&
      /\b(weight|height|width|depth|thickness|length|speed|power|wattage|voltage|frequency|capacity|battery|refresh|dpi|rpm)\b/.test(nameLower)) {
    if (vals.length === 0 || vals.every(v => /^[\d,]+(\.\d+)?$/.test(v.replace(/\s/g, "")))) return "Number";
  }

  if (vals.length >= 2 && aiConfigurable !== false) return "Picklist";

  const VALID = new Set(["Boolean","Date","Datetime","Number","Picklist","Text"]);
  if (aiDataType && VALID.has(aiDataType)) return aiDataType;
  return "Text";
}

function inferFamily(productName: string, prompt: string): string {
  const text = (productName + " " + prompt).toLowerCase();
  if (text.includes("laptop") || text.includes("notebook")) return "Laptops";
  if (text.includes("phone") || text.includes("mobile")) return "Mobile Phones";
  if (text.includes("tablet") || text.includes("ipad")) return "Tablets";
  if (text.includes(" tv") || text.includes("television") || text.includes("smart tv")) return "Televisions";
  if (text.includes("watch") || text.includes("wearable")) return "Wearables";
  if (text.includes("drone") || text.includes("uav")) return "Drones";
  if (text.includes("camera") || text.includes("dslr")) return "Cameras";
  if (text.includes("oven") || text.includes("microwave") || text.includes("refrigerator") || text.includes("air fryer")) return "Home Appliances";
  if (text.includes("headphone") || text.includes("earphone") || text.includes("speaker")) return "Audio";
  if (text.includes("printer")) return "Printers";
  if (text.includes("monitor") || text.includes("display")) return "Monitors";
  if (text.includes("server") || text.includes("cloud")) return "Cloud Services";
  if (text.includes("software") || text.includes("license")) return "Software";
  return "Electronics";
}

function normalizeSellingModel(raw: string | undefined): string {
  if (!raw) return "One Time";
  const lower = raw.toLowerCase().replace(/-/g, " ");
  if (lower.includes("evergreen") && lower.includes("monthly")) return "Evergreen - Monthly";
  if (lower.includes("evergreen") && lower.includes("quarterly")) return "Evergreen - Quarterly";
  if (lower.includes("evergreen") && lower.includes("yearly")) return "Evergreen - Yearly";
  if (lower.includes("term") && lower.includes("monthly")) return "Term Based - Monthly";
  if (lower.includes("term") && lower.includes("quarterly")) return "Term Based - Quarterly";
  if (lower.includes("term") && lower.includes("yearly")) return "Term Based - Yearly";
  if (lower.includes("recurring") || lower.includes("subscription")) return "Evergreen - Monthly";
  return "One Time";
}

function validateAndNormalize(data: RawParseResult, prompt: string) {
  if (!data.productName) throw new Error("Product name is required");
  if (!Array.isArray(data.attributes) || data.attributes.length === 0) {
    throw new Error("At least one attribute is required");
  }

  const blacklisted = data.attributes.filter(attr => isExcludedAttribute(attr.name));
  const eligible = data.attributes.filter(attr => !isExcludedAttribute(attr.name));

  const skippedFromBlacklist: SkippedField[] = blacklisted.map(attr => ({
    name: attr.name,
    reason: "Operational / pricing field — excluded from RCA attributes",
  }));
  const existingSkipped: SkippedField[] = Array.isArray(data.skipped) ? data.skipped : [];

  const productNameSlug = data.productName.replace(/\s+/g, "").toUpperCase().slice(0, 6);

  return {
    productName: data.productName,
    productCode: data.productCode || `${productNameSlug}001`,
    productFamily: data.productFamily || inferFamily(data.productName, prompt),
    productType: data.productType || "Goods",
    description: data.description || `${data.productName} product created via RCA Attribute Studio`,
    isActive: data.isActive !== false,
    unitOfMeasure: data.unitOfMeasure || "Each",
    sellingModel: normalizeSellingModel(data.sellingModel),
    classificationName: data.classificationName || data.productFamily || "General",
    categoryName: data.categoryName || `${data.productName} Specifications`,
    skipped: [...existingSkipped, ...skippedFromBlacklist],
    attributes: eligible.map(attr => {
      const rawValues = Array.isArray(attr.values) ? attr.values.map(String) : [];
      const dataType = inferDataType(attr.name, rawValues, attr.dataType, attr.configurable);
      const isPicklist = dataType === "Picklist";

      let defaultValue = attr.defaultValue != null && attr.defaultValue !== "" ? String(attr.defaultValue) : null;
      if (!isPicklist && !defaultValue && rawValues.length > 0) defaultValue = rawValues[0];

      return {
        name: attr.name,
        dataType,
        configurable: isPicklist,
        required: isPicklist ? (attr.required !== false) : false,
        active: attr.active !== false,
        description: attr.description || `${attr.name} attribute`,
        values: isPicklist ? rawValues : [],
        defaultValue: isPicklist ? null : defaultValue,
      };
    }),
  };
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

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: RCA_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `You are an enterprise RCA business architect applying ATTRIBUTE ELIGIBILITY FILTERING.

For every field, run eligibility check FIRST:
  1. Would a customer see or interact with this on a product detail page?
  2. Does it drive a purchase decision or describe a product specification?
  3. Is it customer-selectable or a meaningful product characteristic?

  If ALL THREE = YES → include as attribute.
  If ANY = NO → reject, do not put in attributes array.

ALWAYS REJECT: Price/MRP/Cost → PricebookEntry; ERP IDs/Tracking IDs → backend;
Routing/Dispatch Codes → WMS; Batch Numbers → operational; Warehouse/Shelf/Rack → WMS;
Firmware/Debug/Engineering/Prototype/Calibration → engineering; Audit fields → logs.

Product description:
${prompt.trim()}

Return JSON in this exact format (no markdown, no code fences):
{
  "productName": "string",
  "productCode": "string",
  "productFamily": "string",
  "productType": "Goods|Service|Digital",
  "description": "string",
  "isActive": true,
  "unitOfMeasure": "Each",
  "sellingModel": "One Time",
  "classificationName": "string",
  "categoryName": "string",
  "skipped": [
    { "name": "string", "reason": "string" }
  ],
  "attributes": [
    {
      "name": "string",
      "dataType": "Picklist|Text|Number|Boolean|Date",
      "configurable": true,
      "required": true,
      "active": true,
      "description": "string",
      "values": ["value1", "value2"],
      "defaultValue": null
    }
  ]
}`,
      }],
    });

    const raw = (message.content[0] as { type: string; text: string }).text.trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    let parsed: RawParseResult;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return NextResponse.json({ error: "AI returned malformed JSON — try a more specific prompt" }, { status: 502 });
    }

    const normalized = validateAndNormalize(parsed, prompt);
    return NextResponse.json({ success: true, data: normalized });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI parsing failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
