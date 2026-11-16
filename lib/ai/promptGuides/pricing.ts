/**
 * <PromptGuide> configs for the Pricing Rule AI prompts. Same contract as
 * lib/ai/promptGuideConfig.ts: every required/optional claim below was traced through the AI route ->
 * normalization -> create route, and anything the prompt can mention but the code does not apply is
 * called out in `notes` instead of being implied.
 *
 * Traced against:
 *   Tier/Volume  — app/api/pricing-rules/{tier,volume}-based/{analyze,create}, lib/pricing-rules/{tier,volume}-based
 *                  (parsePrompt -> analyze -> create/createPipeline). Currency/effective dates are extracted but the
 *                  create pipeline always uses the product's Price Book Entry currency and today -> 2099-12-31; the
 *                  prompt's base price is never sent to the create pipeline.
 *   Attribute    — app/api/pricing-rules/attribute-based/{analyze,create}, lib/pricing-rules/attribute-based.
 *                  `conditions`, currency and dates are extracted for display only.
 *   Bundle       — app/api/pricing-rules/bundle-based/{analyze,create}, lib/pricing-rules/bundle-based.
 *                  quantityCondition/conditions/combinations/sellingModel/currency/dates are extracted, not applied.
 */
import type { PromptGuideConfig } from "@/lib/ai/promptGuideConfig";

const NO_KEY_NOTE = "Reading this guide needs no AI key — only the Analyze/Generate button calls the AI.";

const TIER_TYPE_HINT = "Each band is a percentage off, a fixed amount off, or an override unit price. Values over 100 are never treated as a percentage.";

export const pricingPromptGuides: Record<string, PromptGuideConfig> = {
  tierBasedPricing: {
    title: "AI Prompt Guide — Tier-Based (Slab) Pricing",
    whatItCreates: "Creates and activates a tier-based pricing procedure for one existing product: a Price Adjustment Schedule (Slab method) with one Price Adjustment Tier per quantity band, plus a pricing procedure (Expression Set) cloned from an existing tier-discount procedure in your org. With Slab pricing, each band prices only the units that fall inside it.",
    requiredFields: [
      { label: "Product name", hint: "Must already exist in Salesforce. It is looked up by name: an exact match first, then a partial match. If several products match you pick one; if none match you get suggestions. Nothing is created for an unknown product." },
      { label: "At least one quantity band", hint: "For example \"units 1–50\", \"51–200\", \"201+\". If you leave tiers out you can still add them by hand in the tier editor before you create." },
    ],
    optionalFields: [
      { label: "Discount type and value per band", hint: TIER_TYPE_HINT },
      { label: "Base / list price", hint: "Shown in the review for reference only. Pricing always starts from the product's real list price in the Standard Price Book, and this flow does not change that price." },
    ],
    capabilities: [
      "Contiguous quantity bands, each with a % discount, a fixed amount off, or a final unit price.",
      "An open-ended last band (\"201 and above\").",
      "How it applies at runtime: the procedure runs Pricing Settings, then List Price, then a Tier Discount step. The Tier Discount step reads the schedule's tiers, and each band discounts only its own units.",
    ],
    interpretationNotes: [
      "If you only describe discount bands, the AI adds a 0% base band that starts at quantity 1.",
      "Bands must be contiguous and must not overlap. You get a warning if no band is open-ended.",
      "The AI never supplies a Salesforce Id. The product is resolved against real Product2 records after extraction.",
      "The procedure is named \"<Product> Tier-Based Pricing Procedure\" automatically and is activated when it is created.",
    ],
    example: { prompt: "Create a tier-based pricing procedure for Enterprise Widget. Units 1–50 get no discount, units 51–200 get 10% off, and units above 200 get 20% off. Each band only prices the units inside it." },
    multipleNote: "Each run prices one product. To price several products, run the flow once per product.",
    notes: [
      "If every band is an override price, Salesforce uses the Range method instead of Slab, so an override-priced schedule isn't double-counted. Percentage and amount bands always use Slab.",
      "Currency and effective dates in the prompt are not applied. Tiers use the currency of the product's Price Book Entry and run from today to 2099-12-31.",
      "Your org needs an existing, working tier-discount pricing procedure to clone. This flow never builds one from scratch, so it stops with a diagnostic if none is found.",
      NO_KEY_NOTE,
    ],
    reviewNote: "The AI output is only a suggestion. Analyze is read-only: review the product and every tier row, and edit them if needed. Nothing is written to Salesforce until you confirm the create step.",
  },

  volumeBasedPricing: {
    title: "AI Prompt Guide — Volume-Based Pricing",
    whatItCreates: "Creates and activates a volume-based pricing procedure for one existing product: a Price Adjustment Schedule (Range method) with one Price Adjustment Tier per quantity band, plus a pricing procedure (Expression Set) cloned from an existing volume-discount procedure in your org. With Range pricing, every unit gets the rate of the band that the total quantity falls in.",
    requiredFields: [
      { label: "Product name", hint: "Must already exist in Salesforce. It is looked up by name: an exact match first, then a partial match. If several products match you pick one; if none match you get suggestions." },
      { label: "At least one quantity band", hint: "For example \"100–499 units\", \"500+\". If you leave tiers out you can still add them in the tier editor before you create." },
    ],
    optionalFields: [
      { label: "Discount type and value per band", hint: TIER_TYPE_HINT },
      { label: "Base / list price", hint: "Shown in the review for reference only. Pricing always starts from the product's real list price in the Standard Price Book." },
    ],
    capabilities: [
      "Threshold bands where reaching a band re-prices all units, for example 10% off every unit once the order reaches 100.",
      "Percentage, fixed-amount, or override unit price per band.",
      "How it applies at runtime: the procedure runs Pricing Settings, then List Price, then a Volume Discount step. That step finds the band that the total quantity falls in and applies its rate to the whole line.",
    ],
    interpretationNotes: [
      "If you only describe discount bands, the AI adds a 0% base band that starts at quantity 1.",
      "Bands must be contiguous and must not overlap. You get a warning if no band is open-ended.",
      "The product is resolved against real Product2 records, and the AI never supplies an Id.",
      "The procedure is named \"<Product> Volume-Based Pricing Procedure\" automatically and is activated when it is created.",
    ],
    example: { prompt: "Create a volume-based pricing procedure for Bulk Cable Spool. 1–99 units: no discount. 100–499 units: 10% off. 500 or more units: 20% off every unit." },
    multipleNote: "Each run prices one product. To price several products, run the flow once per product.",
    notes: [
      "If you want only the units inside each band discounted, use Tier-Based (Slab) pricing instead.",
      "Currency and effective dates in the prompt are not applied. Tiers use the currency of the product's Price Book Entry and run from today to 2099-12-31.",
      "Your org needs an existing volume-discount pricing procedure to clone, otherwise creation stops with a diagnostic.",
      NO_KEY_NOTE,
    ],
    reviewNote: "The AI output is only a suggestion. Analyze is read-only: review the product and every tier, and edit them if needed. Nothing is written to Salesforce until you confirm the create step.",
  },

  attributeBasedPricing: {
    title: "AI Prompt Guide — Attribute-Based Pricing",
    whatItCreates: "Creates and activates an attribute-based pricing procedure for one existing product. It creates attribute-based adjustment records (a rule, a condition and an adjustment per priced attribute value, on a Price Adjustment Schedule) and a pricing procedure cloned from an existing one in your org. At runtime the adjustment for the selected attribute value is applied on top of the product's list price.",
    requiredFields: [
      { label: "Product name", hint: "Must already exist in Salesforce and have attributes. It is matched by exact name, then by partial match. If several match you pick one." },
      { label: "Attribute values and their adjustments", hint: "For example \"16GB RAM adds $150\". If you name no attributes, the app lists the product's real attributes for you to price. A value with no amount is held on the mapping screen until you give one." },
    ],
    optionalFields: [
      { label: "Adjustment type", hint: "\"add $X\" is a fixed amount, \"X% more\" is a percentage, and a stated final price is an override. Amounts are recorded as plain magnitudes." },
      { label: "Combination pricing", hint: "Only applied when you use combination wording, such as \"when RAM is 32GB AND Storage is 1TB, add $50\". Pricing several attributes separately never creates combinations." },
      { label: "Base price", hint: "If it differs from the Standard Price Book price, you're asked which to use. This flow never changes the list price itself." },
    ],
    capabilities: [
      "Several attributes and values in one prompt, each with its own adjustment.",
      "Explicit two-or-more-value combinations with their own adjustment.",
      "Values the product doesn't have yet. These are flagged, and you choose whether to create them or ignore them.",
    ],
    interpretationNotes: [
      "Attribute and value names are matched against the product's real attributes in Salesforce. Unmatched names get suggestions, never silent substitutes.",
      "Real attribute values you don't mention get a $0 rule. No adjustment is invented for them.",
      "The procedure is named \"<Product> Attribute-Based Pricing Procedure\" automatically and is activated when it is created.",
    ],
    example: { prompt: "Create attribute-based pricing for Laptop Pro 15. Add $150 for 16GB RAM and $300 for 32GB RAM, add $100 for 512GB storage, and add 5% when the Processor is Intel Core i7." },
    multipleExample: { label: "Combination", prompt: "For Laptop Pro 15, add $150 for 32GB RAM and $100 for 1TB storage. When RAM is 32GB and Storage is 1TB together, give an additional $50." },
    multipleNote: "One product per run. Multiple attributes, values and explicit combinations for that product are supported in one prompt.",
    notes: [
      "Conditions such as \"only for orders over $500\", plus currency and effective dates, are shown back to you but are not turned into pricing rules.",
      "Before creating, the pipeline makes sure every priced attribute is marked price-impacting on the product, and turns that flag on if needed. That is a Salesforce write, shown in the execution log.",
      NO_KEY_NOTE,
    ],
    reviewNote: "The AI output is only a suggestion. Analysis is read-only: review the attribute mapping, the adjustments and the rule plan. Nothing is written to Salesforce until you click Create in Salesforce on the confirmation screen.",
  },

  bundleBasedPricing: {
    title: "AI Prompt Guide — Bundle-Based Pricing",
    whatItCreates: "Creates and activates a bundle-based pricing procedure for one existing bundle. It creates a Bundle Price Adjustment Schedule and one Bundle-Based Adjustment per component, refreshes the bundle-discount lookup table, and deploys a procedure cloned from an existing bundle-discount procedure in your org. At runtime each component's adjustment applies when it is sold inside this bundle.",
    requiredFields: [
      { label: "Bundle name", hint: "The existing bundle's parent product, resolved by name against real Salesforce products. Its real child components are read from Salesforce." },
      { label: "Component adjustments", hint: "For example \"if Wireless Mouse is included, add $100\". Components must be real children of that bundle. If you name none, the app lists the components for you to price." },
    ],
    optionalFields: [
      { label: "Adjustment type", hint: "\"add $X\" is a fixed amount, \"increase by X%\" is a percentage, and a stated final price is an override." },
    ],
    capabilities: [
      "Different adjustments for different components of the same bundle.",
      "A component named without an amount is held until you enter one. Components you don't mention get a $0 adjustment.",
    ],
    interpretationNotes: [
      "Component names are matched only against the bundle's real components. Names that don't match get suggestions, and you can ignore them.",
      "The procedure is named \"<Bundle> Bundle-Based Pricing Procedure\" automatically and is activated when it is created. Afterwards you can price a test Quote to check the result.",
    ],
    example: { prompt: "Create bundle-based pricing for the existing bundle Laptop Basic Bundle. If Laptop is included, add $500. If Wireless Mouse is included, add $100. If Keyboard is included, add $150." },
    multipleNote: "One bundle per run. To price another bundle, run the flow again.",
    notes: [
      "Quantity thresholds, bundle-level conditions, combination rules, selling model, currency and dates in the prompt are extracted but not applied. Only per-component adjustments are created.",
      "Your org needs an existing, working bundle-discount procedure and its lookup table, otherwise creation stops with a diagnostic.",
      NO_KEY_NOTE,
    ],
    reviewNote: "The AI output is only a suggestion. Analysis is read-only: review every component row. Nothing is written to Salesforce until you confirm the create step.",
  },
};
