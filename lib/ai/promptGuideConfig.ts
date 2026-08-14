/**
 * Config for the shared <PromptGuide> panel (components/ai/PromptGuide.tsx),
 * shown next to every AI-driven "Create" prompt in the app. One entry per
 * AI entry point — NOT one per Salesforce object, since Product single-create
 * (RCProductWorkspace) and Product multi-create (MultiProductWorkspace) are
 * genuinely different workflows with different required-field sets and
 * different multi-record behavior, so they get their own entries rather than
 * being forced into one.
 *
 * Every required/optional claim below was traced end-to-end (AI parse route
 * -> normalization/defaulting layer -> create route -> Salesforce payload)
 * against the actual code, not guessed. Where the current implementation
 * doesn't support something the field/example might imply (e.g. Quote/Order
 * prompts do not create line items; Bundle prompts create one root bundle,
 * not several independent ones), that limitation is called out explicitly
 * in `notes`/`multipleNote` rather than glossed over — this config must
 * never claim a capability the code doesn't have.
 */

export interface PromptGuideField {
  label: string;
  hint?: string;
}

export interface PromptGuideExample {
  label?: string;
  prompt: string;
}

export interface PromptGuideConfig {
  /** Panel title, e.g. "AI Prompt Guide — Product". */
  title: string;
  /** One or two sentences: what does Generate actually create? */
  whatItCreates: string;
  /** Fields the workflow genuinely cannot proceed without. */
  requiredFields: PromptGuideField[];
  /** Fields that can be omitted — defaulted, skipped, or left blank. */
  optionalFields: PromptGuideField[];
  /** "What can I describe?" bullets — capabilities, not field names. */
  capabilities: string[];
  /** "How is this interpreted?" bullets — defaulting/lookup/no-fabrication behavior. */
  interpretationNotes: string[];
  example: PromptGuideExample;
  /** A second example specifically demonstrating multi-record description, where supported. */
  multipleExample?: PromptGuideExample;
  /** Explains multi-record behavior (or its current absence) for this workflow. */
  multipleNote?: string;
  /** Warnings/limitations worth flagging (fields that look supported but aren't persisted, etc.). */
  notes?: string[];
  /** Reinforces the existing Generate -> extract -> review -> create workflow; never bypass review. */
  reviewNote: string;
}

export type PromptGuideModule =
  | "product"
  | "productMulti"
  | "attribute"
  | "bundle"
  | "quote"
  | "order"
  | "contract"
  | "pricingRule";

export const promptGuideConfig: Record<PromptGuideModule, PromptGuideConfig> = {
  product: {
    title: "AI Prompt Guide — Product",
    whatItCreates: "Creates one Revenue Cloud Product — plus its Catalog, Category, Selling Model, and a Price Book Entry, wherever those are resolvable — from a natural-language description.",
    requiredFields: [
      { label: "Product Name", hint: "Deploy is blocked until this is filled in." },
      { label: "Product Family", hint: "This app requires it before Deploy, even though Salesforce itself may not — describe it explicitly, e.g. \"family Computers\"." },
    ],
    optionalFields: [
      { label: "Product Code", hint: "Auto-generated from the Product Name if you don't specify one." },
      { label: "Catalog", hint: "Found or created automatically if it doesn't already exist." },
      { label: "Category", hint: "Found or created automatically — needs a Catalog to also be given." },
      { label: "Product Type", hint: "Only a value of \"Bundle\" is actually written to Salesforce today; other values show in the review but aren't sent." },
      { label: "Active Status", hint: "Defaults to Active if not mentioned — say \"inactive\" to override." },
      { label: "Description", hint: "Left blank if not mentioned; Salesforce falls back to showing the Product Name." },
      { label: "Selling Model", hint: "Matched against real Selling Models in your org — skipped (not an error) if it can't be resolved." },
      { label: "Base Price & Currency", hint: "Adds a Price Book Entry. Needs a Price Book too, which defaults to \"Standard Price Book\" once you give a price." },
      { label: "Configurable attributes", hint: "Specs you name (e.g. \"RAM 16GB or 32GB\") are captured as attributes for the product." },
    ],
    capabilities: [
      "Name, family, catalog, category, type, price, currency, and active status.",
      "Configurable attributes/specs mentioned by name, e.g. \"RAM 16GB or 32GB, RGB keyboard\".",
    ],
    interpretationNotes: [
      "Only fields you actually mention are filled in — nothing is guessed or inferred.",
      "Anything left out stays blank, or keeps Salesforce's own default (like Active = Yes), rather than being invented.",
    ],
    example: { prompt: "Create a Laptop Pro 15 with product family Computers, catalog Hardware Catalog, category Laptops, product code LAP-001, and base price $1200." },
    notes: [
      "Product Owner, Classification, and Unit of Measure appear in the review screen for reference but are not currently saved to the Product record.",
      "Tax treatment isn't backed by a real Salesforce field here — it's tracked for your own reference only and never sent.",
    ],
    reviewNote: "After Generate, review every field in the Field Mapping table — each one is tagged Provided, Default, or Not specified — before you click Deploy. Nothing is created in Salesforce until then.",
  },

  productMulti: {
    title: "AI Prompt Guide — Multiple Products",
    whatItCreates: "Creates several independent Products from one prompt — each one gets its own Family, Catalog, Category, Selling Model, and Price.",
    requiredFields: [
      { label: "Product Name (per product)", hint: "Every product you describe needs its own name." },
      { label: "Product Family (per product)", hint: "Every product needs its own family — it is never copied from a sibling product." },
    ],
    optionalFields: [
      { label: "Product Code", hint: "Auto-generated from the Product Name if omitted." },
      { label: "Catalog / Category", hint: "Created automatically if they don't already exist; shown as a warning (not blocked) if new." },
      { label: "Selling Model", hint: "Unlike single-product creation, a Selling Model that doesn't match a real one in your org excludes that product from creation, with a clear reason shown." },
      { label: "Base Price & Currency", hint: "Optional per product." },
      { label: "Active Status / Description", hint: "Optional per product." },
    ],
    capabilities: [
      "Describe 2, 3, 5, 10, or more products in a single prompt — separate each one clearly (a numbered list works well).",
    ],
    interpretationNotes: [
      "Each product is mapped completely independently — a field you state for one product is never copied onto another, even a similar one, unless you say \"all of these...\".",
    ],
    example: {
      prompt: "Create three products:\n\n1. Laptop Pro 15, family Computers, category Laptops, price $1200.\n2. Wireless Mouse, family Accessories, category Computer Accessories, price $40.\n3. Office Monitor 27, family Displays, category Monitors, price $300.",
    },
    multipleNote: "This workflow is built entirely around describing multiple products at once — every product in your prompt is mapped and shown as its own card in the review step.",
    notes: [
      "Before anything is created, every draft is re-validated against your Salesforce org (the same check the bulk CSV importer uses) — a product with an unresolved Selling Model or a duplicate Product Code is excluded with a clear reason, not created wrong.",
    ],
    reviewNote: "After Generate, each product appears as its own review card with a Field Mapping table. Nothing is created until you click Deploy.",
  },

  attribute: {
    title: "AI Prompt Guide — Attribute",
    whatItCreates: "Creates one or more Attribute Definitions — and their Picklist values, where applicable — for a single Product.",
    requiredFields: [
      { label: "Product Name", hint: "The existing (or new) Product these attributes belong to." },
      { label: "At least one attribute", hint: "Each attribute needs at least a name — describe as many as you like for this one product." },
    ],
    optionalFields: [
      { label: "Data Type", hint: "Inferred from how you describe it — e.g. listing multiple options implies Picklist. Defaults to Text if it can't be inferred." },
      { label: "Values", hint: "Only required if the attribute ends up as a Picklist (2 or more options). Optional for every other data type." },
      { label: "Description", hint: "Auto-filled with a generic description if not mentioned." },
      { label: "Active Status", hint: "Defaults to Active unless you say otherwise." },
      { label: "Required-for-selection", hint: "Whether a customer must choose a value — defaults to required for Picklist attributes, not required for everything else." },
      { label: "Product details (Code, Family, Type, Selling Model, Catalog, Category)", hint: "Only relevant if the Product doesn't exist yet; all optional and defaulted/inferred if omitted." },
    ],
    capabilities: [
      "Multiple attributes for the same product in one prompt (e.g. RAM, Storage, and Color together).",
      "The intended data type and behavior, described naturally — \"as a picklist\", \"a yes/no option\", \"a number\", etc.",
    ],
    interpretationNotes: [
      "Picklist is only chosen when you list 2 or more distinct options — a single value or a number becomes Text/Number instead.",
      "Reserved-sounding attribute names (price, SKU, warehouse, etc.) are automatically skipped and shown separately, since those belong to other Salesforce fields, not custom attributes.",
    ],
    example: { prompt: "Create a RAM attribute with values 8GB, 16GB, 32GB and 64GB." },
    multipleExample: { label: "Multiple attributes, one product", prompt: "Create a Screen Size attribute as a picklist with values 13 inch, 14 inch, 15 inch and 16 inch, and also a Touchscreen attribute as yes/no." },
    multipleNote: "One Generate action always applies to a single Product — describe every attribute that product needs in the same prompt. To add attributes to a different product, run Generate again.",
    reviewNote: "After Generate, review every attribute — and the Product it will attach to — in the Attributes and Product Preview tabs before running the deployment.",
  },

  bundle: {
    title: "AI Prompt Guide — Bundle",
    whatItCreates: "Creates one bundle Product and links its component products — and, optionally, nested child bundles — as bundle relationships.",
    requiredFields: [
      { label: "Bundle Name", hint: "The only field this app strictly requires — Deploy fails without it." },
    ],
    optionalFields: [
      { label: "Component products", hint: "Not enforced by the app, but a bundle with zero components will still deploy, empty — list at least one so it's actually useful." },
      { label: "Bundle Code", hint: "Used for duplicate-checking, but the deployed record's Product Code is always auto-generated from the Bundle Name." },
      { label: "Description", hint: "Defaults to the Bundle Name if not mentioned." },
      { label: "Category / Family", hint: "Defaults to \"Products\" if not mentioned." },
      { label: "Catalog", hint: "Defaults to \"Enterprise Catalog\", auto-created if it doesn't exist." },
      { label: "Selling Model", hint: "Matched to a real Selling Model in your org; falls back to a \"One Time\"-style model if not mentioned." },
      { label: "Component pricing", hint: "Defaults to $0 for any component whose price isn't mentioned." },
      { label: "Component \"required\"", hint: "Defaults to required unless you say a component is optional." },
      { label: "Nested / child bundles", hint: "Describe a bundle-within-a-bundle and it's created as a nested child, not a separate top-level bundle." },
      { label: "Dependency rules", hint: "e.g. \"Firewall depends on Threat Intelligence Hub\" — captured as a dependency between components." },
    ],
    capabilities: [
      "A bundle name plus a list of component products, with optional per-component price and selling model.",
      "Nested child bundles described inside the parent bundle.",
      "Dependency relationships between products.",
    ],
    interpretationNotes: [
      "Component quantity isn't tracked by this app yet — each listed product becomes one bundle component regardless of how many units you mention.",
      "Bundle components are always created Active — there's currently no way to mark one inactive from a prompt.",
    ],
    example: { prompt: "Create a Laptop Starter Bundle containing Laptop Pro 15, Wireless Mouse, and USB-C Dock." },
    multipleNote: "One \"Parse Bundle\" action creates one root bundle. You can describe nested child bundles inside it (a bundle that itself contains bundles), but to create two unrelated top-level bundles, run this flow twice — once per bundle.",
    reviewNote: "After Parse Bundle, review the full hierarchy — root bundle, child bundles, components, and prices — in the Bundle Hierarchy Workspace before clicking Deploy.",
  },

  quote: {
    title: "AI Prompt Guide — Quote",
    whatItCreates: "Fills in the Quote header (Name, Account, Price Book, Opportunity, dates, status) from your description. Quote Line Items are added afterward using the product catalog search — not from this prompt.",
    requiredFields: [
      { label: "Quote Name", hint: "The only field the Create Quote step itself enforces." },
    ],
    optionalFields: [
      { label: "Account", hint: "Optional at creation, but the catalog search on the next step works best with one set." },
      { label: "Price Book", hint: "Optional at creation, but required before you can add Line Items — the app will prompt for it if you skip it here." },
      { label: "Opportunity", hint: "Optional — linked only if it resolves to a real Salesforce record." },
      { label: "Start Date / Expiration Date", hint: "Left blank if not mentioned." },
      { label: "Status", hint: "Left to Salesforce's own default if not mentioned." },
      { label: "Description", hint: "Optional free text." },
    ],
    capabilities: [
      "Quote name, account/customer, price book, opportunity, start/expiration dates, status, and description.",
    ],
    interpretationNotes: [
      "Account/Price Book/Opportunity names are looked up against real Salesforce records — an exact single match is selected automatically, multiple matches are left for you to pick, and no match is left blank rather than guessed.",
      "This prompt does not add products, quantities, or pricing — after the quote header is created, add Line Items using the catalog search on the next screen.",
    ],
    example: { prompt: "Create a quote for Acme Corp using the Standard price book, starting next Monday, status Draft." },
    multipleNote: "Each Generate action fills in one quote's header. There's no AI support yet for describing multiple quotes in a single prompt — run Generate again for each additional quote.",
    notes: [
      "Products, quantities, and prices you mention here (like \"10 Laptop Pro 15 units at $1200 each\") are not extracted by this prompt today — add them in the Line Items step that follows.",
    ],
    reviewNote: "After Generate, check the Quote Details fields below — anything the AI couldn't confidently match is left blank for you to fill in. Nothing is created in Salesforce until you continue.",
  },

  order: {
    title: "AI Prompt Guide — Order",
    whatItCreates: "Fills in the Order header (Account, Price Book, dates, type, status) from your description. Order Products are added afterward using the product catalog search — not from this prompt.",
    requiredFields: [
      { label: "Account", hint: "The customer this order is for — required before the order can be created." },
      { label: "Price Book", hint: "Required — used to search the product catalog for order items afterward." },
    ],
    optionalFields: [
      { label: "Effective/Order Date", hint: "Left blank if not mentioned." },
      { label: "Status", hint: "Left to Salesforce's own default picklist value if not mentioned." },
      { label: "Order Type", hint: "Left blank if not mentioned. If your org's Type picklist implies a Contract is required, you'll see a hint on the Contract field." },
      { label: "Contract", hint: "Optional — only checked against your Order Type as a soft hint, never a hard requirement." },
      { label: "PO Number & PO Date", hint: "Optional purchase-order reference fields." },
      { label: "Source Quote", hint: "Optional — links this order back to the quote it originated from." },
      { label: "Description", hint: "Optional free text." },
    ],
    capabilities: [
      "Account/customer name, price book, order date, type, status, PO details, and a source Contract or Quote — all matched against real Salesforce records.",
    ],
    interpretationNotes: [
      "Account and Price Book names are looked up against real Salesforce records — an exact single match is selected automatically, multiple matches are left for you to pick, and no match is left blank rather than guessed.",
      "This prompt does not add products or quantities — after the order header is created, add Order Products using the catalog search on the next screen.",
    ],
    example: { prompt: "Create an order for Acme Corporation using the Standard price book, effective next Monday, type New." },
    multipleNote: "Each Generate action fills in one order's header. There's no AI support yet for describing multiple orders in a single prompt — run Generate again for each additional order.",
    notes: [
      "Products/quantities you mention here (like \"2 Laptop Pro 15 units\") are not extracted by this prompt today — add them in the Order Items step that follows.",
    ],
    reviewNote: "After Generate, check the Order Details fields below — anything the AI couldn't confidently match is left blank for you to fill in. Nothing is created in Salesforce until you continue.",
  },

  contract: {
    title: "AI Prompt Guide — Contract",
    whatItCreates: "Fills in the Contract details (Account, Price Book, dates, term, type, status, signatories) from your description. Standard Salesforce Contracts have no free-text Name field — Salesforce assigns the Contract Number automatically.",
    requiredFields: [
      { label: "Account", hint: "The only field this app enforces — Create Contract stays disabled until a real Account is selected." },
    ],
    optionalFields: [
      { label: "Price Book", hint: "Optional." },
      { label: "Status", hint: "Optional — left to Salesforce's default if not mentioned." },
      { label: "Contract Type", hint: "Optional — only applies if your org has added this custom field." },
      { label: "Start Date", hint: "Optional." },
      { label: "Contract Term (months)", hint: "Optional — Salesforce calculates the End Date from this; End Date itself can't be set directly." },
      { label: "Company/Customer Signed By, Title, Date", hint: "Optional — typically filled in later by the e-signature flow, not required at creation." },
      { label: "Description", hint: "Optional free text." },
    ],
    capabilities: [
      "Account/customer, price book, start date, contract term in months, status, contract type, signatory names, and description.",
    ],
    interpretationNotes: [
      "An end date you mention is informational only — Contracts don't have a writable End Date field; state the term in months instead and Salesforce computes it.",
      "Signatory names are search hints for existing Contacts, never invented.",
    ],
    example: { prompt: "Create a 12-month contract for Acme Corporation starting September 1, 2026." },
    multipleNote: "Each Generate action fills in one contract. There's no AI support yet for describing multiple contracts in a single prompt.",
    notes: [
      "This app doesn't attach Products/Services to Contracts as structured line items — mentioning one (like \"for the Laptop Pro support service\") only becomes part of the free-text Description.",
    ],
    reviewNote: "After Generate, review the populated Contract Details fields, then check Generated JSON / Execution Log / Salesforce Response before confirming Create Contract.",
  },

  pricingRule: {
    title: "AI Prompt Guide — Attribute-Based Pricing",
    whatItCreates: "Creates an Attribute-Based Pricing Procedure for one Product — a Price Adjustment Schedule with one rule/condition/adjustment per attribute condition you describe.",
    requiredFields: [
      { label: "Procedure Name", hint: "Required by the create step." },
      { label: "Product", hint: "Required — must resolve to a real Product in your org." },
      { label: "At least one priced attribute condition", hint: "Required, unless you choose to reuse a pricing schedule that already exists on this product." },
    ],
    optionalFields: [
      { label: "Selling Model", hint: "Resolved from the Product; required by the review step but not something you usually need to state if the product only has one." },
      { label: "Base Price", hint: "Auto-fetched from the Standard Price Book — a missing entry is shown as a warning, never blocks creation." },
      { label: "Effective From / To dates", hint: "Effective From is required by the review step; Effective To is optional (open-ended)." },
      { label: "Description", hint: "Optional free text." },
    ],
    capabilities: [
      "Multiple attribute conditions in one prompt — each with its own Attribute, Value, and adjustment.",
      "Adjustment type described naturally: a percentage discount, a fixed dollar amount, or an override price.",
    ],
    interpretationNotes: [
      "A dollar amount or percentage is only set if you actually state one — the AI never invents a price adjustment.",
      "If an attribute or value you mention doesn't exactly match a real one in Salesforce, the flow stops and asks you to confirm the closest match instead of guessing.",
      "If this product already has pricing rules, you can choose to reuse them instead of restating every condition.",
    ],
    example: { prompt: "Create attribute-based pricing for Laptop Pro 15: when RAM is 32GB, add $120; when storage is 1TB, add $200." },
    multipleNote: "List as many attribute conditions as you like in one prompt (separate them with semicolons or \"and\") — each becomes its own pricing rule for the same product.",
    notes: [
      "Nothing is created in Salesforce until you confirm on the final Review page — Discover/Generate only fills in the form.",
    ],
    reviewNote: "After Discover & Review (or Generate), check the Pricing Mappings and Not Yet Mapped sections, then the Final Review summary, before clicking Confirm & Create.",
  },
};
