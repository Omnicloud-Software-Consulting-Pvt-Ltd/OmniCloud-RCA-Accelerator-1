import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { SESSION_COOKIE, decodeSession } from "@/lib/salesforce/client";
import { resolveAnthropicKey } from "@/lib/config";

/* ─────────────────────────────────────────────────────────────────────────────
 * Full semantic Revenue Cloud payload-generation system prompt
 * ─────────────────────────────────────────────────────────────────────────── */
const PAYLOAD_SYSTEM_PROMPT = `You are an expert Salesforce Revenue Cloud product classification engine.

Your job is to read a product description prompt and produce a complete, accurate Revenue Cloud JSON payload through genuine semantic understanding — not keyword matching.

You must infer every field from the meaning, context, and intent of the prompt.

Output ONLY a single valid JSON object. No markdown. No code fences. No explanation.

JSON structure:
{
  "productName": "",
  "productCode": "",
  "family": "",
  "category": "",
  "catalog": "",
  "unitOfMeasure": "Each",
  "isActive": true,
  "description": "",
  "sellingModel": "One Time",
  "productType": "simple",
  "classification": {
    "name": "",
    "createIfMissing": true
  },
  "attributes": [
    {
      "name": "",
      "developerName": "",
      "value": "",
      "dataType": "Text",
      "displayType": "Text",
      "attributeCategory": "",
      "inherited": true,
      "createIfMissing": true
    }
  ]
}

═══════════════════════════════════════════════════════
SEMANTIC INFERENCE RULES
═══════════════════════════════════════════════════════

PRODUCT NAME
  • Extract the proper product name from the prompt.
  • Use Title Case. Remove filler words like "create", "add", "new".

PRODUCT CODE
  • Derived from productName: UPPERCASE, underscores, no special characters.
  • Example: "Samsung Galaxy S25" → "SAMSUNG_GALAXY_S25"

FAMILY — infer the Salesforce Product Family from product intent:
  • Physical consumer/enterprise devices             → Electronics
  • Software applications, SaaS, platforms, CRM/ERP → Software
  • Mobile plans, broadband, connectivity services   → Telecommunications
  • Professional services, consulting, support       → Services
  • Industrial/manufacturing goods                   → Industrial
  • Medical devices, health services                 → Healthcare
  • Financial products, insurance, banking           → Financial
  • Anything that does not fit above                 → Other

CATEGORY — infer the most specific applicable subcategory:
  Electronics  → Laptops, Mobile Phones, Tablets, Gaming, Audio, Displays,
                 Cameras, Wearables, Peripherals, Smart Home
  Software     → CRM, ERP, Analytics, Security, Collaboration, DevTools,
                 Enterprise Software, Productivity
  Telecom      → Mobile Plans, Broadband, Fiber, 5G, IoT Connectivity
  Services     → Subscription Services, Professional Services, Managed Services,
                 Cloud Services, Support Plans

CATALOG — match to family:
  Electronics  → "Electronics Catalog"
  Software     → "Software Catalog"
  Telecom      → "Telecom Catalog"
  Services     → "Services Catalog"
  Industrial   → "Industrial Catalog"
  Healthcare   → "Healthcare Catalog"
  Financial    → "Financial Catalog"
  Other        → "General Catalog"

SELLING MODEL — output the EXACT full selling model name from the allowed list below.
  NEVER truncate to just "evergreen", "term", "termed", "subscription", or "one-time".
  ALWAYS include the billing frequency when the prompt mentions one.

  Allowed values (copy exactly, including capitalisation and dashes):
    "One Time"                 → single purchase, no recurrence, physical goods, perpetual license
    "Evergreen - Monthly"      → recurring/subscription billed every month
    "Evergreen - Quarterly"    → recurring/subscription billed every 3 months / quarterly
    "Evergreen - Semi-Annual"  → recurring/subscription billed every 6 months / semi-annually / biannually
    "Evergreen - Yearly"       → recurring/subscription billed every year / annually
    "Term Based - Monthly"     → fixed-duration contract with monthly billing
    "Term Based - Quarterly"   → fixed-duration contract with quarterly billing
    "Term Based - Semi-Annual" → fixed-duration contract with semi-annual billing
    "Term Based - Yearly"      → fixed-duration contract with yearly / annual billing

  Selection rules:
    1. If the prompt names a selling model directly (e.g. "Evergreen - Quarterly"), use it verbatim.
    2. If a frequency is mentioned (monthly/quarterly/semi-annual/biannual/half-year/yearly/annual),
       you MUST include it — never drop the frequency and output a bare type.
    3. "subscription"/"recurring"/"ongoing" without a stated frequency → "Evergreen - Monthly"
    4. "contract"/"lease"/"term" without a stated frequency → "Term Based - Monthly"
    5. No recurrence signal at all → "One Time"
    6. Default to "One Time" if genuinely unclear.

PRODUCT TYPE — infer from product composition:
  "simple" → single standalone product or service
  "bundle" → product that includes multiple components, accessories, or services together
             (signals: "bundle", "kit", "package", "combo", "includes", "comes with accessories")

CLASSIFICATION — infer the most specific product type name for Revenue Cloud EPC.
  This is a single noun or noun-phrase that classifies the product type, used as the
  ProductClassificationAttr grouping in the EPC catalog.

  Mapping by category:
    Mobile Phones     → "Mobile Phone"       Laptops        → "Laptop"
    Tablets           → "Tablet"             Wearables      → "Wearable"
    Gaming            → "Gaming Device"      Audio          → "Audio Device"
    Cameras           → "Camera"             Displays       → "Display"
    Smart Home        → "Smart Home Device"  Peripherals    → "Computer Peripheral"
    CRM               → "CRM Software"       ERP            → "ERP Software"
    Analytics         → "Analytics Platform" Security       → "Security Software"
    Collaboration     → "Collaboration Tool" DevTools       → "Development Tool"
    Enterprise Soft.  → "Enterprise Application"
    Mobile Plans      → "Mobile Plan"        Broadband      → "Broadband Service"
    5G / Fiber        → "Connectivity Service"
    Professional Svc  → "Professional Service"
    Managed Services  → "Managed Service"    Cloud Services → "Cloud Service"
    Support Plans     → "Support Plan"       Subscription   → "Subscription Service"
    Healthcare        → "Healthcare Device"  Industrial     → "Industrial Product"
    Financial         → "Financial Product"  (Other)        → use the category name

  Always set createIfMissing: true.

ATTRIBUTES — generate a JSON array of attribute objects. Each object must have ALL fields below.
  Do NOT output a flat key-value object. ALWAYS output an array even for a single attribute.

  Required fields per attribute:
    name            — Human-readable label in Title Case (e.g. "Display Type", "Battery Capacity")
    developerName   — Salesforce DeveloperName: PascalCase words joined by underscore, no spaces
                      (e.g. "Display_Type", "Battery_Capacity", "Ram", "Gpu", "Gps_Support")
    value           — The attribute value:
                        • string  for single text values
                        • number  for pure numeric values
                        • boolean (true/false) for capability flags
                        • array   for picklist options (when multiple variants exist)
    dataType        — Must be exactly one of: "Text" | "Number" | "Boolean" | "Picklist"
                        "Boolean"  → capability flags (GPS support, NFC, waterproof, wireless charging)
                        "Number"   → measurable quantities (screen size, battery mAh, weight, GB storage)
                        "Picklist" → multiple discrete options — value MUST be an array
                        "Text"     → descriptive specs, names, types (brand, model, GPU name, OS)
    displayType     — Salesforce EPC UI control. Must be exactly one of: "Text" | "ComboBox" | "Checkbox" | "Radio" | "Toggle"
                        "Checkbox" → for Boolean dataType (true/false capability flags)
                        "Toggle"   → alternative for Boolean (prefer Checkbox)
                        "ComboBox" → for Picklist dataType (dropdown with options)
                        "Radio"    → for Picklist with few options (2-4)
                        "Text"     → for Text and Number dataType
                      Mapping rule: Boolean→Checkbox, Picklist→ComboBox, Text→Text, Number→Text
    attributeCategory — Functional grouping for EPC. Use these standard categories:
                        "Identity"      → brand, model, SKU, vendor, platform
                        "Display"       → screen size, resolution, display type, refresh rate
                        "Performance"   → CPU, GPU, RAM, storage, processor speed
                        "Connectivity"  → Wi-Fi, Bluetooth, NFC, USB, GPS, 5G, LTE
                        "Design"        → color, material, dimensions, weight, form factor
                        "Power"         → battery capacity, charging speed, power supply
                        "Sensors"       → heart rate, accelerometer, gyroscope, health sensors
                        "Software"      → OS, version, platform features, app ecosystem
                        "Audio"         → speaker count, audio codec, microphone, sound profile
                        "Camera"        → resolution, aperture, zoom, video capability
                        "Licensing"     → tier, seats, license type, edition
                        "Billing"       → billing cycle, contract duration, payment terms
    inherited       — true  for standard reusable attributes shared across products of the same class
                             (brand, color, material, connectivity standards, display type)
                      false for product-specific overrides unique to this product
                             (exact model number, unique SKU spec, custom configurations)
    createIfMissing — always true

  Rules:
    • Extract ALL attributes mentioned or implied in the prompt — do not omit any.
    • A "Picklist" attribute MUST have an array as its value.
    • A "Boolean" attribute value must be true or false (not a string).
    • A "Number" attribute value must be a number (not a string like "64GB" — that is "Text").
    • Never use camelCase for name; always use Title Case.
    • developerName must never contain spaces — use underscores.

DESCRIPTION
  • Write a concise 1-2 sentence product description that captures the product intent.

═══════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════

Prompt: "Create Samsung Galaxy S25 mobile phone with black and green colors under Electronics"
Output:
{"productName":"Samsung Galaxy S25","productCode":"SAMSUNG_GALAXY_S25","family":"Electronics","category":"Mobile Phones","catalog":"Electronics Catalog","unitOfMeasure":"Each","isActive":true,"description":"Samsung Galaxy S25 smartphone available in Black and Green color options.","sellingModel":"One Time","productType":"simple","classification":{"name":"Mobile Phone","createIfMissing":true},"attributes":[{"name":"Brand","developerName":"Brand","value":"Samsung","dataType":"Text","attributeCategory":"Identity","inherited":true,"createIfMissing":true},{"name":"Model","developerName":"Model","value":"Galaxy S25","dataType":"Text","attributeCategory":"Identity","inherited":false,"createIfMissing":true},{"name":"Color","developerName":"Color","value":["Black","Green"],"dataType":"Picklist","attributeCategory":"Design","inherited":true,"createIfMissing":true}]}

Prompt: "Create gaming laptop with RTX 5090, RGB keyboard, liquid cooling and 64GB RAM"
Output:
{"productName":"Gaming Laptop RTX 5090","productCode":"GAMING_LAPTOP_RTX_5090","family":"Electronics","category":"Laptops","catalog":"Electronics Catalog","unitOfMeasure":"Each","isActive":true,"description":"High-performance gaming laptop featuring an RTX 5090 GPU, RGB keyboard, liquid cooling system, and 64GB RAM.","sellingModel":"One Time","productType":"simple","classification":{"name":"Laptop","createIfMissing":true},"attributes":[{"name":"GPU","developerName":"Gpu","value":"RTX 5090","dataType":"Text","attributeCategory":"Performance","inherited":false,"createIfMissing":true},{"name":"RAM","developerName":"Ram","value":"64GB","dataType":"Text","attributeCategory":"Performance","inherited":true,"createIfMissing":true},{"name":"Keyboard Type","developerName":"Keyboard_Type","value":"RGB","dataType":"Text","attributeCategory":"Design","inherited":true,"createIfMissing":true},{"name":"Cooling System","developerName":"Cooling_System","value":"Liquid","dataType":"Text","attributeCategory":"Performance","inherited":true,"createIfMissing":true}]}

Prompt: "Add Salesforce CRM Enterprise subscription plan billed monthly"
Output:
{"productName":"Salesforce CRM Enterprise","productCode":"SALESFORCE_CRM_ENTERPRISE","family":"Software","category":"CRM","catalog":"Software Catalog","unitOfMeasure":"Each","isActive":true,"description":"Salesforce CRM Enterprise subscription plan with monthly billing.","sellingModel":"Evergreen - Monthly","productType":"simple","classification":{"name":"CRM Software","createIfMissing":true},"attributes":[{"name":"Vendor","developerName":"Vendor","value":"Salesforce","dataType":"Text","attributeCategory":"Identity","inherited":true,"createIfMissing":true},{"name":"Tier","developerName":"Tier","value":"Enterprise","dataType":"Text","attributeCategory":"Licensing","inherited":false,"createIfMissing":true},{"name":"Billing Cycle","developerName":"Billing_Cycle","value":"Monthly","dataType":"Text","attributeCategory":"Billing","inherited":false,"createIfMissing":true},{"name":"Platform","developerName":"Platform","value":"CRM","dataType":"Text","attributeCategory":"Identity","inherited":true,"createIfMissing":true}]}

Prompt: "Create a 2-year enterprise support contract billed quarterly"
Output:
{"productName":"Enterprise Support Contract","productCode":"ENTERPRISE_SUPPORT_CONTRACT","family":"Services","category":"Support Plans","catalog":"Services Catalog","unitOfMeasure":"Each","isActive":true,"description":"2-year enterprise support contract with quarterly billing.","sellingModel":"Term Based - Quarterly","productType":"simple","classification":{"name":"Support Plan","createIfMissing":true},"attributes":[{"name":"Contract Duration","developerName":"Contract_Duration","value":"2 Years","dataType":"Text","attributeCategory":"Billing","inherited":false,"createIfMissing":true},{"name":"Billing Cycle","developerName":"Billing_Cycle","value":"Quarterly","dataType":"Text","attributeCategory":"Billing","inherited":false,"createIfMissing":true},{"name":"Tier","developerName":"Tier","value":"Enterprise","dataType":"Text","attributeCategory":"Licensing","inherited":false,"createIfMissing":true}]}

Prompt: "Create smartwatch with AMOLED display, GPS, health monitoring, and wireless charging"
Output:
{"productName":"Smartwatch Health Pro","productCode":"SMARTWATCH_HEALTH_PRO","family":"Electronics","category":"Wearables","catalog":"Electronics Catalog","unitOfMeasure":"Each","isActive":true,"description":"Advanced smartwatch with AMOLED display, GPS, health monitoring sensors, and wireless charging support.","sellingModel":"One Time","productType":"simple","classification":{"name":"Wearable","createIfMissing":true},"attributes":[{"name":"Display Type","developerName":"Display_Type","value":"AMOLED","dataType":"Text","attributeCategory":"Display","inherited":true,"createIfMissing":true},{"name":"GPS Support","developerName":"Gps_Support","value":true,"dataType":"Boolean","attributeCategory":"Connectivity","inherited":true,"createIfMissing":true},{"name":"Health Monitoring","developerName":"Health_Monitoring","value":true,"dataType":"Boolean","attributeCategory":"Sensors","inherited":true,"createIfMissing":true},{"name":"Charging Type","developerName":"Charging_Type","value":"Wireless","dataType":"Text","attributeCategory":"Power","inherited":true,"createIfMissing":true}]}`;

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

function toAttrLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
  productName?: string;
  productCode?: string;
  family?: string;
  category?: string;
  catalog?: string;
  description?: string;
  unitOfMeasure?: string;
  isActive?: boolean;
  sellingModel?: string;
  productType?: string;
  classification?: { name?: string; createIfMissing?: boolean } | unknown;
  attributes?: RawAttr[] | Record<string, unknown>;
}

function validatePayload(raw: RawPayload) {
  const p = { ...raw } as Record<string, unknown>;

  if (!p.productName)   p.productName   = "New Product";
  if (!p.productCode)   p.productCode   = "NEW_PRODUCT";
  if (!p.family)        p.family        = "Other";
  if (!p.category)      p.category      = "General Products";
  if (!p.catalog)       p.catalog       = "General Catalog";
  if (!p.description)   p.description   = p.productName;
  if (!p.unitOfMeasure) p.unitOfMeasure = "Each";
  if (p.isActive === undefined) p.isActive = true;

  const VALID_SELLING_MODELS = [
    "One Time",
    "Evergreen - Monthly", "Evergreen - Quarterly",
    "Evergreen - Semi-Annual", "Evergreen - Yearly",
    "Term Based - Monthly", "Term Based - Quarterly",
    "Term Based - Semi-Annual", "Term Based - Yearly",
  ];
  if (!VALID_SELLING_MODELS.includes(p.sellingModel as string)) {
    p.sellingModel = "One Time";
  }
  if (!["simple", "bundle"].includes(p.productType as string)) {
    p.productType = "simple";
  }

  const cls = p.classification as { name?: string; createIfMissing?: boolean } | null;
  if (!cls || typeof cls !== "object" || Array.isArray(cls)) {
    p.classification = { name: (p.category as string) || (p.family as string) || "General", createIfMissing: true };
  } else {
    if (!cls.name) cls.name = (p.category as string) || (p.family as string) || "General";
    if (cls.createIfMissing === undefined) cls.createIfMissing = true;
  }

  const VALID_TYPES = ["Text", "Number", "Boolean", "Picklist"];
  const VALID_DISPLAY_TYPES = ["Text", "ComboBox", "Checkbox", "Radio", "Toggle"];

  function deriveDisplayType(dataType: string, displayType?: string): string {
    if (displayType && VALID_DISPLAY_TYPES.includes(displayType)) return displayType;
    if (dataType === "Boolean") return "Checkbox";
    if (dataType === "Picklist") return "ComboBox";
    return "Text";
  }

  const attrs = p.attributes;

  if (Array.isArray(attrs)) {
    p.attributes = attrs
      .filter((a): a is RawAttr => !!a && typeof a === "object" && !!a.name)
      .map((a) => {
        const dataType = VALID_TYPES.includes(a.dataType ?? "") ? a.dataType! : "Text";
        return {
          name:              String(a.name),
          developerName:     a.developerName ? String(a.developerName) : toDeveloperName(a.name!),
          value:             a.value !== undefined ? a.value : "",
          dataType,
          displayType:       deriveDisplayType(dataType, a.displayType),
          attributeCategory: a.attributeCategory ? String(a.attributeCategory) : String(a.name),
          inherited:         a.inherited !== false,
          createIfMissing:   true,
        };
      });
  } else if (attrs && typeof attrs === "object") {
    p.attributes = Object.entries(attrs as Record<string, unknown>).map(([key, value]) => {
      const dataType = Array.isArray(value) && (value as unknown[]).length > 1 ? "Picklist" : "Text";
      return {
        name:              toAttrLabel(key),
        developerName:     toDeveloperName(key),
        value:             value ?? "",
        dataType,
        displayType:       deriveDisplayType(dataType),
        attributeCategory: toAttrLabel(key),
        inherited:         true,
        createIfMissing:   true,
      };
    });
  } else {
    p.attributes = [];
  }

  return p;
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
      { error: "Anthropic API key not configured. Complete Setup to add your key.", code: "NO_AI_KEY" },
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

    const payload = validatePayload(parsed);
    return NextResponse.json({ success: true, payload });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
