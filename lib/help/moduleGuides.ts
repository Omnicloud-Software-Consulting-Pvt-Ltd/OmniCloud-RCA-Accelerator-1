/**
 * Beginner-friendly module introductions for <ModuleIntro> (components/help/ModuleIntro.tsx), shown at the top of every
 * /data module ("About this module"). One entry per module or workspace view, keyed by the same ids the app already uses
 * (sidebar item ids, billing module keys, tax module keys / Taxes views) — see `moduleGuideKeyFor` below.
 *
 * Static educational content only: it never reads Salesforce, never needs an AI key, and never claims the app does
 * something it doesn't (where Salesforce has a capability this app doesn't drive — e.g. Place Sales Transaction or order
 * orchestration — the text says so).
 */

export interface ModuleGuideConcept { term: string; meaning: string }

export interface ModuleGuide {
  title: string;
  /** What is this? — one or two sentences, always visible in the collapsed bar. */
  summary: string;
  /** Why is it used / what business problem does it solve? */
  why: string;
  /** Where is it used in Salesforce Revenue Cloud? */
  where: string;
  /** How does it work? */
  how: string[];
  prerequisites: string[];
  /** What should the user configure next? */
  next: string[];
  /** How does it connect to other modules? */
  connects: string[];
  /** Key terms, for modules whose vocabulary is new to most people (Taxes, Pricing, Usage). */
  concepts?: ModuleGuideConcept[];
  /** Implementation sequence, shown as numbered steps. */
  flow?: string[];
}

// Shared sequences ────────────────────────────────────────────────────────────
const PRODUCT_FLOW = ["Product", "Selling Model", "Price Book Entry", "Catalog & Category", "Attributes / Bundle (optional)", "Pricing Procedure", "Billing Policy", "Tax Policy", "Quote → Order"];
const BILLING_FLOW = ["Legal Entity & Payment Term", "Billing Treatment + Items", "Billing Policy (Active)", "Assign policy to Product", "Activate Order", "Billing Schedules", "Invoice", "Payment / Credit / Debit Memo"];
const TAX_FLOW = ["Geo Country / State", "Tax Engine", "Tax Treatment (+ Items)", "Tax Policy (Active)", "Tax Rates", "Assign policy to Product", "Order → Invoice", "Invoice Line Tax"];
const USAGE_FLOW = ["Unit of Measure Class & Units", "Usage Resource", "Aggregation / Rating Policy", "Product Usage Resource", "Rate Card + Entries", "Price Book Rate Card", "Usage Grant (optional)"];

const TAX_CONCEPTS: ModuleGuideConcept[] = [
  { term: "Tax Engine", meaning: "What calculates the tax. Salesforce's native Revenue Standard Tax engine looks rates up in a decision table; an external engine (e.g. Avalara) calls out to a provider." },
  { term: "Tax Policy", meaning: "Attached to a product (Product2.TaxPolicyId). It decides which Tax Treatment applies." },
  { term: "Tax Treatment", meaning: "How the product is taxed: taxable or exempt, its Tax Code, the engine and the legal entity." },
  { term: "Tax Treatment Item", meaning: "Optional per-product tax codes under one treatment." },
  { term: "Tax Rate", meaning: "The percentage for a Tax Code in a country/state, for a legal entity and date range." },
  { term: "Invoice Line Tax", meaning: "The tax result Salesforce writes for each invoice line when the invoice is calculated. You never create it by hand." },
];

const PRICING_CONCEPTS: ModuleGuideConcept[] = [
  { term: "Pricing Procedure", meaning: "An expression set that runs step by step on every quote/order line: list price → adjustments → discounts → net price." },
  { term: "Pricing Element", meaning: "One step inside the procedure (e.g. a list-price lookup, a volume discount, a rounding rule)." },
  { term: "Price Adjustment Schedule", meaning: "A table of tiers or volume ranges that a pricing element looks up." },
  { term: "Attribute / Bundle-Based Adjustment", meaning: "Price changes driven by the attribute values chosen, or by a component being sold inside a bundle." },
];

// ─────────────────────────────────────────────────────────────────────────────
export const MODULE_GUIDES: Record<string, ModuleGuide> = {
  // ══ Revenue Cloud Core ══
  "revenue-core": {
    title: "Revenue Cloud Core",
    summary: "The product-configuration foundation of Revenue Cloud: products, attributes, catalogs, bundles, selling models, price books and pricing procedures.",
    why: "Quotes, orders, billing and tax all work from these records. If they're incomplete, prices are wrong, lines can't be added, and invoices can't be generated.",
    where: "Product Catalog Management, Salesforce Pricing and Product Configurator — used whenever a product is added to a quote or order.",
    how: ["Every count on this dashboard is read live from the connected org.", "Each card opens the existing module that manages that object.", "Objects your org doesn't have are listed as \"not available\" rather than shown as zero."],
    prerequisites: ["A connected Salesforce org with Revenue Cloud (Revenue Lifecycle Management) enabled.", "Permission to read Product2, ProductSellingModel, Pricebook2 and ExpressionSet."],
    next: ["Create a product, then give it a selling model and a price book entry.", "Place it in a catalog category so sales users can find it.", "Verify pricing on a test quote."],
    connects: ["Feeds Quotes and Orders (what can be sold, at what price).", "Billing Policy and Tax Policy are assigned per product.", "Pricing rules build on the pricing procedure."],
    flow: PRODUCT_FLOW,
  },
  products: {
    title: "Products",
    summary: "A Revenue Cloud product (Product2) is anything you sell — a licence, a device, a service or a usage-based offering.",
    why: "Products are the foundation of Revenue Cloud. Every quote line, order product, billing schedule, invoice line and tax line points back to a product.",
    where: "Product Catalog Management; products appear in the quote/order product picker, the catalog and on invoices.",
    how: ["A product alone isn't sellable. It needs a Product Selling Model (one-time, evergreen or term), a Price Book Entry for that selling model and, to be browsable, a catalog category.", "Type = Bundle turns a product into a bundle whose components are other products.", "Active products are sellable; inactive ones are treated as drafts on the dashboard."],
    prerequisites: ["Selling models you plan to use should exist (e.g. \"Term Monthly\", \"One Time\").", "A price book (Standard Price Book at minimum)."],
    next: ["Product Configuration: check selling model, price book entry, catalog, billing and tax readiness.", "Assign a Billing Policy and a Tax Policy before invoicing.", "Add attributes or make it a bundle if it's configurable."],
    connects: ["Selling Models + Price Book Entries → pricing on quotes/orders.", "Catalogs/Categories → discoverability.", "Billing Policy → invoicing; Tax Policy → tax on invoices."],
    flow: PRODUCT_FLOW,
  },
  "product-create": {
    title: "Product Creation",
    summary: "Create one product, or several, from a plain-language description. You review the generated fields before anything is written to Salesforce.",
    why: "Creating a sellable product by hand means filling in several related records (product, selling model option, price book entry, catalog category). This flow fills them in together.",
    where: "Writes Product2 and, where you describe them, ProductSellingModelOption, PricebookEntry and ProductCategoryProduct.",
    how: ["Describe the product, or fill in the form.", "Generate → review the field mapping (each field is tagged Provided / Default / Not specified).", "Deploy creates the records. Names you give (catalog, category, selling model) are matched against real records in your org."],
    prerequisites: ["Product Family is required by this app.", "Selling models must already exist in the org to be linked."],
    next: ["Open Product Configuration to confirm the product is fully sellable.", "Assign billing and tax policies."],
    connects: ["Products dashboard lists the result.", "Bundles and Attributes can then use the product."],
  },
  "product-configuration": {
    title: "Product Configuration",
    summary: "A single view of everything that makes a product sellable and billable: selling models, price book entries, catalog placement, billing policy and tax policy.",
    why: "Most product issues (\"can't add to quote\", \"no billing schedule\", \"no tax on invoice\") come from one missing link. This view shows which link is missing.",
    where: "Reads Product2, ProductSellingModelOption, PricebookEntry, ProductCategoryProduct, BillingPolicy and TaxPolicy.",
    how: ["Pick a product (or describe a change), review the readiness checks, then confirm any updates.", "Each check states what Salesforce needs and whether your product has it."],
    prerequisites: ["The product exists.", "Selling models, price books and policies you want to link exist."],
    next: ["Fix any missing link shown, then test the product on a quote."],
    connects: ["Pricing (selling model + PBE) → Quotes/Orders.", "Billing Policy → Billing Schedules.", "Tax Policy → Invoice Line Tax."],
    concepts: [
      { term: "Product Selling Model", meaning: "How the product is sold: One Time, Evergreen (renews until cancelled) or Term Defined (fixed term, e.g. 12 months)." },
      { term: "Price Book Entry", meaning: "The product's list price in a price book, for one selling model and currency. You need one per selling model." },
      { term: "Catalog / Category", meaning: "Where sales users browse for the product." },
    ],
  },
  "product-import": {
    title: "Product Import",
    summary: "Bulk-create products from a CSV or Excel file: upload, map columns to fields, validate, then create.",
    why: "Loading a product catalogue one record at a time is slow and error-prone.",
    where: "Creates Product2 records (and related pricing where mapped).",
    how: ["Upload → map columns → validation highlights problems per row → create only valid rows.", "Import history keeps the outcome of each run."],
    prerequisites: ["One row per product, with at least Name and Family columns."],
    next: ["Review the created products in Product History and complete their configuration."],
    connects: ["Same records the Products dashboard and Product Configuration use."],
  },
  catalogs: {
    title: "Catalogs",
    summary: "A Product Catalog is a top-level collection of categories. Categories hold the products sales users browse when adding lines to a quote or order.",
    why: "Without catalogs and categories, users have to search for products by name. Catalogs also let you present different product sets to different channels.",
    where: "Product Catalog Management: ProductCatalog → ProductCategory → ProductCategoryProduct.",
    how: ["Create a catalog, add categories (they can be nested), then place products into categories."],
    prerequisites: ["Products to place in categories."],
    next: ["Assign products to categories, then check the product picker on a quote."],
    connects: ["Product creation can find or create a catalog and category for you.", "The Revenue Cloud Core dashboard shows live catalog and category counts."],
  },
  bundles: {
    title: "Product Bundles",
    summary: "A bundle is a product (Type = Bundle) that packages other products — its components — with quantity rules and optional groups.",
    why: "Bundles let you sell a solution (e.g. \"Laptop + Dock + Warranty\") as one line, while each component keeps its own price, billing and tax behaviour.",
    where: "Product Catalog Management: Product2 (bundle) → ProductComponentGroup → ProductRelatedComponent.",
    how: ["Components are linked to the bundle with min/max/default quantities and can be required or optional.", "Component groups organise components into sections of the configurator.", "Pricing procedures can apply bundle-based adjustments to components."],
    prerequisites: ["Component products exist and are priced (selling model + price book entry)."],
    next: ["Price the bundle and test it in the configurator on a quote.", "Optionally add bundle-based pricing rules."],
    connects: ["Quotes/Orders expand bundles into a line hierarchy.", "Pricing Rules → Bundle-Based Adjustments."],
    flow: ["Component products", "Bundle product", "Component groups", "Related components + quantity rules", "Price & test on a quote"],
  },
  "bundle-create": {
    title: "Bundle Creation",
    summary: "Describe a bundle in plain language. The AI proposes the bundle, its groups and components, and you review it before anything is created.",
    why: "A bundle involves several linked records; building them together keeps the hierarchy consistent.",
    where: "Creates Product2 (Type = Bundle), ProductComponentGroup and ProductRelatedComponent.",
    how: ["Describe → analyse → review hierarchy and quantity rules → execute.", "Component names are matched against existing products; anything unmatched is flagged, never invented."],
    prerequisites: ["Component products exist."],
    next: ["Open the bundle detail view and test it on a quote."],
    connects: ["Bundle Components view; Quotes/Orders configurator."],
  },
  "bundle-components": {
    title: "Bundle Components & Relationships",
    summary: "The parent → child relationships inside your bundles (ProductRelatedComponent), with their quantity rules and groups.",
    why: "Use it to see which bundles a component belongs to before you change or deactivate that component.",
    where: "ProductRelatedComponent, ProductComponentGroup, ProductRelationshipType.",
    how: ["Browse components and dependencies across bundles; open a bundle to edit it."],
    prerequisites: ["At least one bundle."],
    next: ["Adjust quantity rules or groups on the bundle detail page."],
    connects: ["Bundles; Pricing Rules (bundle-based adjustments)."],
  },
  attributes: {
    title: "Product Attributes",
    summary: "Attributes are configurable characteristics of a product, such as Color, Storage or Region. A customer picks values for them during configuration.",
    why: "With attributes you can sell one product in many variants instead of creating a separate product for every combination.",
    where: "AttributeDefinition (+ AttributePicklist values), grouped by AttributeCategory, assigned to products directly or through a ProductClassification.",
    how: ["Define the attribute and its data type. Picklist attributes take their values from an Attribute Picklist.", "Group related attributes into Attribute Categories.", "A Product Classification is a template: products based on it inherit its attributes."],
    prerequisites: ["Know which attributes vary per sale (and which affect price)."],
    next: ["Assign attributes to a classification or product.", "Optionally price by attribute value with Attribute-Based Pricing."],
    connects: ["Products (via classification); Configurator on quotes/orders; Attribute-Based Pricing Rules."],
    concepts: [
      { term: "Attribute Definition", meaning: "The attribute itself (name, data type, required/optional)." },
      { term: "Attribute Category", meaning: "A group of attributes shown together." },
      { term: "Product Classification", meaning: "A reusable set of attributes that products of one kind share." },
    ],
  },
  "attribute-create": {
    title: "Attribute Creation",
    summary: "Create attributes, picklists and categories from a description, and optionally assign them to a product or classification.",
    why: "It sets up the full attribute chain (definition → picklist → values → category → assignment) in one reviewed batch.",
    where: "AttributeDefinition, AttributePicklist, AttributePicklistValue, AttributeCategory, ProductAttributeDefinition.",
    how: ["Describe → review the proposed records → create in dependency order."],
    prerequisites: ["The target product/classification exists if you want the attributes assigned."],
    next: ["Check the product in the configurator; add attribute-based pricing if values change price."],
    connects: ["Attributes dashboard; Products; Pricing Rules."],
  },
  "pricing-rules": {
    title: "Pricing Procedures & Pricing Rules",
    summary: "A pricing procedure is the calculation Salesforce runs on every quote/order line to work out its price. Pricing rules (tiers, volume, attribute- and bundle-based adjustments) are steps inside it.",
    why: "List prices alone rarely match how you sell. Procedures apply discounts, tiers, uplifts and adjustments the same way on every line, without manual overrides.",
    where: "Salesforce Pricing: ExpressionSet (pricing procedure) with pricing elements, PriceAdjustmentSchedule/Tier, AttributeBasedAdjustment, BundleBasedAdjustment.",
    how: ["When a line is added or repriced, the active procedure runs its elements in order: list price → adjustments → net price.", "Lookup elements read adjustment tables (tiers, volume ranges, attribute matrices)."],
    prerequisites: ["Products with price book entries.", "A pricing procedure set as the org's default (Salesforce Pricing Setup)."],
    next: ["Create a tier/volume/attribute/bundle rule, then reprice a test quote to see the effect."],
    connects: ["Products and Price Books (inputs).", "Quotes/Orders (where it runs).", "Bundles and Attributes (adjustment drivers)."],
    concepts: PRICING_CONCEPTS,
  },
  quotes: {
    title: "Quote Management",
    summary: "A quote is a priced proposal for an account: a header (account, price book, dates) plus quote line items for the products being offered.",
    why: "Quotes are where pricing, configuration and discounts come together before the customer commits.",
    where: "Quote and QuoteLineItem, priced by the pricing procedure; bundles appear as a line hierarchy.",
    how: ["Create the quote header, add lines (product + selling model + quantity), configure bundles/attributes, then reprice.", "Every line needs the product's price book entry for its selling model."],
    prerequisites: ["An Account.", "Priced products (selling model + price book entry) in the quote's price book."],
    next: ["Review pricing, then create an Order from the quote."],
    connects: ["Products and Pricing (inputs); Orders and Contracts (outputs)."],
  },
  orders: {
    title: "Orders",
    summary: "An order records what the customer bought (order products / order items). Activating it starts Revenue Cloud Billing.",
    why: "The order is the hand-off from selling to fulfilment and billing. Billing schedules and invoices come from activated order products.",
    where: "Order and OrderItem. In Salesforce, orders can also come from Place Order / Place Sales Transaction APIs and be fulfilled through Dynamic Revenue Orchestrator. This app creates orders over the REST API and activates them; it doesn't drive orchestration.",
    how: ["Create the order (account, price book, dates, bill-to), add order products, then activate.", "On activation Salesforce creates Billing Schedule Groups and Billing Schedules for billable products.", "Order products carry the tax treatment and billing data used later on the invoice."],
    prerequisites: ["Account with billing address and a bill-to contact.", "Products with a Billing Policy (and a Tax Policy if tax applies)."],
    next: ["Continue with Revenue Cloud Billing: check billing schedules, then generate and post the invoice."],
    connects: ["Quotes → Orders → Billing Schedules → Invoices → Payments.", "Taxes are calculated on the resulting invoice."],
    flow: ["Account & Bill-To", "Order header", "Order products", "Activate", "Billing schedules", "Invoice"],
  },
  contracts: {
    title: "Contracts",
    summary: "A contract records the agreed terms with an account: start date, term, status and signed documents.",
    why: "Contracts govern renewals and amendments and provide the legal record of the deal.",
    where: "Contract (with generated documents).",
    how: ["Create the contract, generate or attach its document, then activate it."],
    prerequisites: ["An Account."],
    next: ["Link orders/quotes to the contract; manage renewals from it."],
    connects: ["Accounts, Quotes, Orders."],
  },

  // ══ Core CRM ══
  accounts: {
    title: "Accounts",
    summary: "An account is a company (or person) you sell to. It's the anchor for quotes, orders, contracts, billing and tax.",
    why: "Every transaction needs an account. Its billing address drives invoice delivery and, for tax, the country and state used to find rates.",
    where: "Account — referenced by Quote, Order, Contract, BillingAccount and Invoice.",
    how: ["Fill in the form and create the record in Salesforce. Billing Country/State are used later for tax determination."],
    prerequisites: ["None."],
    next: ["Add contacts (a bill-to contact is needed for billing), then create a quote or order."],
    connects: ["Contacts, Opportunities, Quotes, Orders, Billing, Taxes."],
  },
  contacts: {
    title: "Contacts",
    summary: "People at an account, such as buyers, approvers or the bill-to contact who receives invoices.",
    why: "Orders and invoices need a bill-to contact, and contracts need signers.",
    where: "Contact — used as Order Bill-To Contact, contract signer and on billing accounts.",
    how: ["Create the contact under its account."],
    prerequisites: ["The account exists."],
    next: ["Use it as Bill-To Contact on orders."],
    connects: ["Accounts, Orders, Contracts, Billing Accounts."],
  },
  leads: {
    title: "Leads",
    summary: "Prospects not yet qualified. When converted, a lead becomes an account, a contact and optionally an opportunity.",
    why: "Keeps unqualified interest separate from real customers.",
    where: "Lead (standard CRM).",
    how: ["Create the lead; convert it when qualified. The numbers on this tile are illustrative, not read from your org."],
    prerequisites: ["None."],
    next: ["Convert qualified leads into accounts and opportunities."],
    connects: ["Accounts, Contacts, Opportunities."],
  },
  opportunities: {
    title: "Opportunities",
    summary: "A potential deal with an account, tracked through sales stages.",
    why: "Forecasts revenue and links the quotes produced for the deal.",
    where: "Opportunity — quotes are usually created from an opportunity.",
    how: ["Create the opportunity with stage and close date. The numbers on this tile are illustrative."],
    prerequisites: ["An Account."],
    next: ["Create a quote for the opportunity."],
    connects: ["Accounts, Quotes."],
  },
  cases: {
    title: "Cases",
    summary: "Customer support issues.",
    why: "Tracks service requests and SLAs.",
    where: "Case (Service Cloud). Not part of Revenue Cloud configuration.",
    how: ["Create and track cases. The numbers on this tile are illustrative."],
    prerequisites: ["An Account/Contact."],
    next: ["—"],
    connects: ["Accounts, Contacts, Entitlements."],
  },
  assets: {
    title: "Assets",
    summary: "What a customer owns after an order is activated: subscriptions, one-time purchases and usage products, with their lifecycle history.",
    why: "Assets are the starting point for amendments, renewals and cancellations. Each change is made against the asset Salesforce created, never by editing the original order.",
    where: "Asset (HasLifecycleManagement, CurrentQuantity, lifecycle dates), Asset Action and Asset Action Source (history and origin order line), Asset State Period (quantity and price per period), Asset Contract Relationship, Billing Schedule Group.",
    how: [
      "Choose an account (a contract is optional) or search all accounts; filter by state, expiry window or product; sort and page through the results.",
      "Open an asset to see its actions, state periods, contracts, billing and every lifecycle quote and order that referenced it.",
      "Each asset shows whether it can be amended, renewed or cancelled, and why not when it's blocked.",
    ],
    prerequisites: ["Revenue Cloud asset lifecycle enabled, and orders activated with assetization (HasLifecycleManagement = true)."],
    next: ["Amend, renew or cancel an asset straight from its detail page."],
    connects: ["Orders (origin order), Contracts, Amendments, Renewals, Cancellations, Revenue Cloud Billing."],
  },
  amendments: {
    title: "Amendments",
    summary: "Change assets mid-term: quantity up or down, price, discount, billing frequency, end date, attributes, upgrades and downgrades, and add-on products.",
    why: "An amendment records the change as a new Salesforce transaction (quote, then order, then asset action), so the original order and the asset history are preserved.",
    where: "Standard action initiateAmendment → amendment Quote (QuoteAction Type Amend) → createOrderFromQuote → Order (OriginalActionType Amend) → Asset Action (Upsells, Downsells, Upgrades and so on).",
    how: [
      "Describe the amendment in a prompt, or fill the one-page form: account, contract (optional), eligible assets, changes and the effective date.",
      "Check the preview of Salesforce values against the requested ones. Every field stays editable.",
      "Save & create in Salesforce: one confirmation runs initiate, modify lines, price, validate, create order and billing readiness (Bill-To, addresses, billing policy and treatment, order re-pricing) in order. A product without a Billing Policy stops for your choice. Activation asks separately.",
    ],
    prerequisites: ["Lifecycle-managed assets and access to the initiateAmendment and createOrderFromQuote actions.", "A Bill-To Contact on the account. For activation, the same billing and tax readiness as Order Setup — the app prepares it automatically."],
    next: ["Billing for the amendment order runs in Order Setup and Revenue Cloud Billing."],
    connects: ["Assets, Quotes, Orders, Pricing Procedures, Billing, Tax."],
  },
  renewals: {
    title: "Renewals",
    summary: "Renew term assets that are active, expiring or already expired, with negotiated prices, discounts and optional ramp schedules.",
    why: "A renewal extends the asset's lifecycle through a renewal quote and order, keeping its history and its contract and opportunity links.",
    where: "Standard action initiateRenewal (renewStartDate, renewEndDate, rampOptionsDetails) → renewal Quote (QuoteAction Type Renew) → Order (OriginalActionType Renew) → Asset Action (Renewals).",
    how: [
      "Describe the renewal in a prompt, or select the assets to renew on the one-page form.",
      "Set negotiated prices or discounts, the renewal start, and a term or end date. Leave them empty to use Salesforce's defaults.",
      "Save & create in Salesforce and confirm once; activation asks separately. Verification checks that the asset's lifecycle end moved.",
    ],
    prerequisites: ["Term-Defined assets with a lifecycle end date (One-Time and Evergreen assets have no term to renew)."],
    next: ["Billing for the renewal order runs in Order Setup and Revenue Cloud Billing."],
    connects: ["Assets, Contracts, Opportunities, Quotes, Orders, Billing."],
  },
  cancellations: {
    title: "Cancellations",
    summary: "Cancel assets immediately or from a future date, and record a reason where the org has a field for it.",
    why: "A cancellation is a Salesforce transaction (quote, then order, then a Cancel asset action). Its credits, proration and billing changes come from Salesforce's own configuration, never from a status edit.",
    where: "Standard action initiateCancellation (cancelStartDate) → cancellation Quote (QuoteAction Type Cancel) → Order (OriginalActionType Cancel) → Asset Action (Cancellations) and the billing schedule group's cancellation date.",
    how: [
      "Describe the cancellation in a prompt, or select eligible assets on the one-page form. All assets in one request must share a price book.",
      "Choose the cancellation date and a reason. Partial cancellation is a quantity decrease, made as an amendment.",
      "Save & create in Salesforce and confirm once (activation asks separately), then review the quote's financial impact and the billing read-back.",
    ],
    prerequisites: ["Lifecycle-managed assets that aren't already cancelled or ended."],
    next: ["Credit memos and refunds, if Salesforce generates any, appear in Revenue Cloud Billing."],
    connects: ["Assets, Quotes, Orders, Billing Schedules, Credit Memos."],
  },

  // ══ Revenue Cloud Billing ══
  "billing-overview": {
    title: "Revenue Cloud Billing",
    summary: "Turns activated orders into billing schedules, invoices, payments and memos, using the billing configuration on each product.",
    why: "It automates when and how much to bill: in advance or in arrears, by milestone, or by usage. You don't build invoices by hand.",
    where: "Billing Policy/Treatment on products → Billing Schedules on activated order products → Invoices → Payments, Credit and Debit Memos.",
    how: ["Configure policies and treatments once, assign the policy to products, then activate orders.", "Salesforce generates billing schedules; invoice runs or on-demand actions turn them into invoices."],
    prerequisites: ["Legal Entity and Payment Term.", "Products with an active Billing Policy."],
    next: ["Create a Billing Treatment and Policy, then assign the policy to your products."],
    connects: ["Products (policy assignment), Orders (activation), Taxes (invoice tax)."],
    flow: BILLING_FLOW,
  },
  "billing-policies": {
    title: "Billing Policies",
    summary: "A Billing Policy is attached to a product and decides which Billing Treatment applies to it.",
    why: "It separates what is sold (the product) from how it's billed (the treatment), so many products can share one billing behaviour.",
    where: "BillingPolicy, referenced by Product2.BillingPolicyId; its DefaultBillingTreatmentId points at a treatment.",
    how: ["Create the treatment first and activate it, set it as the policy's default, then activate the policy.", "When an order product is activated, Salesforce uses the product's policy to pick the treatment and build the billing schedule.", "A product only bills once its policy's Billing Treatment has its Active Billing Treatment Item. That item is SHARED by every product on the policy (Salesforce allows exactly one on a non-milestone treatment, with no product on it), so assigning a product never creates an item — it relies on, and verifies, the shared one."],
    prerequisites: ["An active Billing Treatment with its one Active Billing Treatment Item."],
    next: ["Assign the policy to products — one at a time (Assign Billing Policy) or many at once on the dedicated Bulk Product Assignment page. It lists only products with no Billing Policy (their Tax Policy doesn't matter), never overwrites an existing assignment, and verifies the shared Billing Treatment Item for each product."],
    connects: ["Billing Treatments; Products; Billing Schedules."],
    flow: BILLING_FLOW,
  },
  "billing-bulk-assignment": {
    title: "Billing Policy Bulk Product Assignment",
    summary: "Assign one existing Billing Policy to many products at once, on its own page.",
    why: "Setting Product2.BillingPolicyId one product at a time is slow for large catalogs, and easy to get wrong — e.g. overwriting a product that already bills differently.",
    where: "Writes Product2.BillingPolicyId (the same field the single-product assignment writes). Reads BillingPolicy → default BillingTreatment → BillingTreatmentItem.",
    how: ["Pick a Billing Policy — its Treatment → Treatment Item chain is validated first (an Inactive or broken chain can't be assigned).", "Only products with NO Billing Policy are listed — a product's Tax Policy is irrelevant here. Search, page, select or Select All Eligible.", "On confirm each product is re-read; one that got a Billing Policy meanwhile (even from someone else) is skipped, never overwritten.", "Billing Treatment Items are shared by all products of the policy, so none are created — the shared item is verified per product. If it isn't Active, products are reported as 'Assigned — Item Incomplete'."],
    prerequisites: ["An Active Billing Policy with an Active Billing Treatment and its one Active Billing Treatment Item.", "Edit access to Product2.BillingPolicyId."],
    next: ["Activate an order with the products and check their billing schedules."],
    connects: ["Billing Policies, Billing Treatments, Billing Treatment Items, Products, Orders."],
  },
  "billing-treatments": {
    title: "Billing Treatments",
    summary: "A Billing Treatment defines how a charge is billed. It's split into ordered Treatment Items, for example 100% in advance, or 50% at signing and 50% on a milestone.",
    why: "It captures billing terms such as advance vs arrears, split percentages and milestones, so they don't have to be handled manually on each invoice.",
    where: "BillingTreatment (+ BillingTreatmentItem), selected by a Billing Policy.",
    how: ["Create the treatment with its items, activate it, then reference it from a Billing Policy."],
    prerequisites: ["A Legal Entity, if your org requires it on treatments."],
    next: ["Add treatment items, then create/activate the Billing Policy that uses it."],
    connects: ["Billing Policies; Billing Milestone Plans (milestone treatments)."],
  },
  "billing-treatment-items": {
    title: "Billing Treatment Items",
    summary: "The ordered billing steps inside a treatment: billing type (advance/arrears), distribution (percentage, flat amount or remainder) and processing order.",
    why: "They define exactly how much is billed at each step.",
    where: "BillingTreatmentItem under a BillingTreatment.",
    how: ["Percentages across items should account for 100% (or use a remainder item).", "Processing order decides the sequence."],
    prerequisites: ["The parent Billing Treatment."],
    next: ["Activate the treatment and its policy."],
    connects: ["Billing Treatments."],
  },
  "billing-rules": {
    title: "Billing Rules (legacy)",
    summary: "Billing rules from the legacy Salesforce Billing managed package.",
    why: "Shown only for orgs that still have the legacy package installed.",
    where: "blng__BillingRule__c. In Revenue Cloud Billing, Billing Policies and Treatments replace rules.",
    how: ["Read-only reference for migration."],
    prerequisites: ["The legacy package."],
    next: ["Model the same behaviour with Billing Policies + Treatments."],
    connects: ["Billing Policies."],
  },
  "billing-milestone-plans": {
    title: "Billing Milestone Plans",
    summary: "Plans that release charges when milestones (dates or events) are reached, for treatments with milestone billing enabled.",
    why: "Projects and services are often billed on delivery milestones instead of a calendar schedule.",
    where: "BillingMilestonePlan (+ items), used with milestone-enabled Billing Treatments.",
    how: ["Define milestones and the share billed at each; mark milestones accomplished to release billing."],
    prerequisites: ["A milestone-enabled Billing Treatment."],
    next: ["Add plan items."],
    connects: ["Billing Treatments; Billing Schedules."],
  },
  "billing-milestone-plan-items": {
    title: "Billing Milestone Plan Items",
    summary: "The individual milestones inside a Billing Milestone Plan.",
    why: "Each milestone releases its share of the charge for billing.",
    where: "BillingMilestonePlanItem.",
    how: ["Set the milestone and its amount or percentage."],
    prerequisites: ["The parent plan."],
    next: ["Track and accomplish milestones."],
    connects: ["Billing Milestone Plans."],
  },
  "payment-terms": {
    title: "Payment Terms",
    summary: "When an invoice falls due, for example Net 30.",
    why: "Sets due dates consistently and drives collections and overdue reporting.",
    where: "PaymentTerm (+ PaymentTermItem) — used by billing schedule groups, orders and invoices.",
    how: ["Items define the due-date rule(s) — e.g. 100% due 30 days after invoice date."],
    prerequisites: ["None."],
    next: ["Add payment term items; reference the term on orders/accounts."],
    connects: ["Invoices; Billing Schedule Groups."],
  },
  "payment-term-items": {
    title: "Payment Term Items",
    summary: "The due-date rules inside a Payment Term.",
    why: "They let one term split payment, e.g. 50% in 15 days and 50% in 45 days.",
    where: "PaymentTermItem.",
    how: ["Each item has a share and a day offset."],
    prerequisites: ["The parent Payment Term."],
    next: ["—"],
    connects: ["Payment Terms."],
  },
  "legal-entities": {
    title: "Legal Entities",
    summary: "The legal company that does the selling. It appears on invoices and drives tax and accounting.",
    why: "Companies that sell from several entities or countries need each invoice and tax calculation tied to the right one.",
    where: "LegalEntity — used by Billing Treatments, Tax Treatments (LegalEntityId), Tax Rates and invoices.",
    how: ["Create the entity with its address; reference it from treatments and rates."],
    prerequisites: ["None."],
    next: ["Link it to Billing and Tax Treatments."],
    connects: ["Billing Treatments, Tax Treatments, Tax Rates, Invoices."],
  },
  "usage-resources": {
    title: "Usage-Based Billing · Usage Resources",
    summary: "A usage resource is the measurable thing a customer consumes, such as GB stored, API calls or minutes.",
    why: "Usage-based billing charges customers for what they actually consume, not only a fixed fee.",
    where: "UsageResource, with a unit of measure and an aggregation policy; linked to products through ProductUsageResource.",
    how: ["Usage records are aggregated per period, rated using rate cards, then billed."],
    prerequisites: ["A Unit of Measure Class and units."],
    next: ["Link the resource to a product, then define a rate card."],
    connects: ["Units of Measure, Aggregation/Rating Policies, Rate Cards, Product Usage Grants."],
    flow: USAGE_FLOW,
  },
  "product-usage-resources": {
    title: "Product Usage Resources",
    summary: "Links a product to the usage resource it consumes. This link is what makes a product usage-billable.",
    why: "Without it, consumption can't be rated against the product.",
    where: "ProductUsageResource.",
    how: ["Pick the product and resource; optionally set policies per link."],
    prerequisites: ["The product and the usage resource."],
    next: ["Add a rate card entry for the resource."],
    connects: ["Usage Resources, Rate Cards, Usage Grants."],
    flow: USAGE_FLOW,
  },
  "units-of-measure": {
    title: "Units of Measure",
    summary: "Units that usage is measured and rated in, such as GB, hours or calls, with conversion factors inside a unit class.",
    why: "Lets usage be recorded in one unit (MB) and rated in another (GB).",
    where: "UnitOfMeasure in a UnitOfMeasureClass.",
    how: ["Define units with conversion factors relative to the class's base unit."],
    prerequisites: ["A Unit of Measure Class."],
    next: ["Create Usage Resources that use the unit."],
    connects: ["Usage Resources, Rate Cards."],
  },
  "unit-of-measure-classes": {
    title: "Unit of Measure Classes",
    summary: "Groups of convertible units (e.g. Data Storage: MB, GB, TB) with a base and default unit.",
    why: "Keeps conversions consistent across usage and rating.",
    where: "UnitOfMeasureClass.",
    how: ["Create the class, then its units."],
    prerequisites: ["None."],
    next: ["Add Units of Measure."],
    connects: ["Units of Measure."],
  },
  "usage-aggregation-policies": {
    title: "Usage Aggregation Policies",
    summary: "How raw usage is accumulated before rating: the method (sum or peak) and the period (daily or monthly).",
    why: "Determines what quantity is billed, e.g. total GB per month vs peak concurrent users.",
    where: "Usage resource billing / aggregation policy object.",
    how: ["Attach the policy to a usage resource."],
    prerequisites: ["A usage resource."],
    next: ["Set a rating frequency policy."],
    connects: ["Usage Resources, Rating Frequency."],
  },
  "rating-frequency-policies": {
    title: "Rating Frequency Policies",
    summary: "How often usage is rated (daily or monthly) and how long to wait before rating.",
    why: "Balances timeliness against late-arriving usage records.",
    where: "RatingFrequencyPolicy, per usage resource or product.",
    how: ["Set frequency and delay."],
    prerequisites: ["A usage resource."],
    next: ["Define rate cards."],
    connects: ["Usage Resources, Rate Cards."],
  },
  "rate-cards": {
    title: "Rate Cards",
    summary: "Usage rates (base, tiered or attribute-based) with effective dates. Rate card entries hold the per-unit rate for each usage resource.",
    why: "Separates the price of consumption from the product's list price.",
    where: "RateCard (+ RateCardEntry, RateAdjustmentByTier), linked to a price book through PriceBookRateCard.",
    how: ["Create the card, add entries per resource, optionally add tiers, then link to a price book."],
    prerequisites: ["Usage resources and products."],
    next: ["Add entries and a Price Book Rate Card."],
    connects: ["Usage Resources, Price Books, Quotes/Orders."],
    flow: USAGE_FLOW,
  },
  "rate-card-entries": {
    title: "Rate Card Entries",
    summary: "The rate charged per unit for a usage resource or product on a rate card, optionally adjusted by tiers.",
    why: "This is the actual usage price.",
    where: "RateCardEntry.",
    how: ["Set rate, unit and effective dates; add tier adjustments for volume pricing."],
    prerequisites: ["The rate card and usage resource."],
    next: ["Add Rate Tier Adjustments if volume-based."],
    connects: ["Rate Cards, Rate Tier Adjustments."],
  },
  "rate-tier-adjustments": {
    title: "Rate Tier Adjustments",
    summary: "Volume tiers on a rate card entry: lower and upper bounds, with an override, amount or percentage adjustment.",
    why: "Rewards higher consumption with lower unit rates.",
    where: "RateAdjustmentByTier.",
    how: ["Tiers shouldn't overlap; the matching tier adjusts the entry's rate."],
    prerequisites: ["A rate card entry."],
    next: ["—"],
    connects: ["Rate Card Entries."],
  },
  "price-book-rate-cards": {
    title: "Price Book Rate Cards",
    summary: "Links a rate card to a price book, so quotes and orders on that price book rate usage with it.",
    why: "Different price books (regions, channels) can use different usage rates.",
    where: "PriceBookRateCard.",
    how: ["Pick the price book and rate card."],
    prerequisites: ["Both records."],
    next: ["Quote a usage product on that price book."],
    connects: ["Price Books, Rate Cards."],
  },
  "product-usage-grants": {
    title: "Product Usage Grants",
    summary: "Included or committed usage a product grants (e.g. 50 GB included per month) before overage is charged.",
    why: "Models plans such as \"includes 1,000 calls, then $0.01 per call\".",
    where: "ProductUsageGrant.",
    how: ["Set quantity, period and resource; consumption beyond the grant is rated."],
    prerequisites: ["The product's usage resource link."],
    next: ["—"],
    connects: ["Product Usage Resources, Rate Cards."],
  },
  "billing-accounts": {
    title: "Billing Accounts",
    summary: "The account-level billing profile: bill-to contact and primary billing address.",
    why: "Invoices need to know who receives them and where they go.",
    where: "BillingAccount.",
    how: ["Create the profile per account."],
    prerequisites: ["The Account and Contact."],
    next: ["Activate orders for the account."],
    connects: ["Accounts, Orders, Invoices."],
  },
  "billing-schedule-groups": {
    title: "Billing Schedule Groups",
    summary: "Generated by Salesforce for each order product when the order is activated. A group holds that product's billing schedules across amendments and renewals.",
    why: "Keeps a product's billing history together across changes.",
    where: "BillingScheduleGroup (read-only — system generated).",
    how: ["Created automatically on order activation."],
    prerequisites: ["An activated order with billable products."],
    next: ["Review its billing schedules."],
    connects: ["Orders, Billing Schedules."],
  },
  "billing-schedules": {
    title: "Billing Schedules",
    summary: "Generated by Salesforce from activated order products. They record what will be billed, when, and how much is still pending.",
    why: "They're the bridge between what was sold (order) and what's invoiced.",
    where: "BillingSchedule (read-only — system generated).",
    how: ["Created when a billable order is activated (use an order's \"Continue with Revenue Cloud Billing\" setup). Invoice runs bill the pending amounts."],
    prerequisites: ["Products with an active Billing Policy; an activated order with bill-to data."],
    next: ["Generate and post the invoice."],
    connects: ["Orders → Billing Schedules → Invoices."],
  },
  invoices: {
    title: "Invoices & Invoice Lines",
    summary: "Invoices are generated from billing schedules. Each invoice line bills one schedule amount, and tax is calculated per line.",
    why: "The invoice is the customer-facing bill and the basis for payments and tax.",
    where: "Invoice and InvoiceLine (+ InvoiceLineTax). Read-only here for traceability.",
    how: ["Invoices start as Draft; posting finalises them. Tax is calculated during invoicing and stored as Invoice Line Tax."],
    prerequisites: ["Billing schedules with pending amounts."],
    next: ["Post the invoice, then apply payments or memos."],
    connects: ["Billing Schedules, Payments, Credit/Debit Memos, Taxes."],
  },
  payments: {
    title: "Payments & Settlements",
    summary: "Payments received from a customer, applied (settled) against invoices.",
    why: "Applying payments reduces what the customer owes and keeps invoice balances accurate.",
    where: "Payment and PaymentLineInvoice (the application of a payment to an invoice).",
    how: ["Record the payment, then apply it to one or more posted invoices."],
    prerequisites: ["Posted invoices; the payment permission sets in Salesforce."],
    next: ["Check the invoice balances."],
    connects: ["Invoices, Accounts."],
  },
  "credit-memos": {
    title: "Credit Memos",
    summary: "A credit memo reduces what a customer owes, for example for a refund, a correction or goodwill.",
    why: "Corrects billing without deleting or editing a posted invoice.",
    where: "CreditMemo (+ lines), applied to invoices.",
    how: ["Create the memo (standalone or against invoice lines), post it, then apply it."],
    prerequisites: ["A posted invoice (for invoice-related credits) and the Credit Memo permissions."],
    next: ["Apply the credit to the invoice balance."],
    connects: ["Invoices, Payments."],
  },
  "debit-memos": {
    title: "Debit Memos",
    summary: "A debit memo increases what a customer owes, for example for an extra charge or a correction.",
    why: "Adds charges without re-invoicing.",
    where: "DebitMemo (requires Salesforce API v65+).",
    how: ["Create, post, then collect alongside invoices."],
    prerequisites: ["An account (and invoice where applicable)."],
    next: ["Collect payment."],
    connects: ["Invoices, Payments."],
  },
  "billing-tax": {
    title: "Billing · Tax",
    summary: "Tax as part of billing. Tax is calculated on invoice lines using each product's Tax Policy.",
    why: "Invoices must carry the correct tax before they're posted.",
    where: "Tax Policy → Tax Treatment → Tax Rate → Invoice Line Tax.",
    how: ["Configure tax in the Taxes section; it's applied when invoices are calculated."],
    prerequisites: ["See Taxes."],
    next: ["Open the Taxes dashboard."],
    connects: ["Taxes, Invoices."],
    concepts: TAX_CONCEPTS,
  },
  "billing-assign": {
    title: "Assign Billing Policy",
    summary: "Assign an existing Billing Policy to existing products. The product's current policy is checked first.",
    why: "A product without a Billing Policy gets no billing schedule when its order is activated.",
    where: "Updates Product2.BillingPolicyId.",
    how: ["Pick or describe products and the policy, review, then confirm."],
    prerequisites: ["An Active Billing Policy."],
    next: ["Activate an order with the product and check its billing schedule."],
    connects: ["Products, Billing Policies, Orders."],
  },
  "billing-product": {
    title: "Product Billing Configuration",
    summary: "The billing configuration of one product: its policy, treatment and usage setup.",
    why: "Shows why a product will or won't produce billing schedules.",
    where: "Product2 → BillingPolicy → BillingTreatment (+ usage links).",
    how: ["Review the chain; fix missing links."],
    prerequisites: ["The product."],
    next: ["Assign a policy if missing."],
    connects: ["Products, Billing Policies."],
  },
  "billing-order": {
    title: "Order Billing Setup",
    summary: "Prepares an order for billing: bill-to data, activation and billing schedule requests.",
    why: "Billing schedules only exist after an order is activated with complete billing data.",
    where: "Order, OrderItem, BillingScheduleGroup, BillingSchedule.",
    how: ["Check readiness, fill in bill-to, activate, then request schedules."],
    prerequisites: ["Products with active Billing Policies; account address and bill-to contact."],
    next: ["Generate the invoice."],
    connects: ["Orders, Billing Schedules, Invoices."],
  },

  // ══ Taxes ══
  "taxes-dashboard": {
    title: "Taxes",
    summary: "Configure how Revenue Cloud calculates tax on invoices (engine, policies, treatments, rates and geography), then prove it on a real invoice.",
    why: "Invoices must carry correct tax for each country or state, product and selling entity. Getting it wrong means under-collecting, or overcharging customers.",
    where: "Taxes are calculated when an invoice is generated or recalculated: for each invoice line, Salesforce follows Product → Tax Policy → Tax Treatment → Tax Engine → Tax Rate and writes Invoice Line Tax.",
    how: ["Native tax: the Revenue Standard Tax engine looks rates up in a decision table built from your Tax Rate records (refresh the table after rate changes).", "External tax: an engine such as Avalara sends the invoice to the provider, which returns the tax.", "You can use AI configuration (describe the tax → review a dependency-ordered plan → confirm) or the manual forms."],
    prerequisites: ["Geo Countries/States for where you sell.", "A Legal Entity.", "Products that will be invoiced."],
    next: ["Create (or reuse) a Tax Engine, then a Treatment and Policy, then Rates; assign the policy to products; run a Tax Calculation."],
    connects: ["Products (TaxPolicyId), Orders (tax treatment stamped on order products), Invoices (Invoice Line Tax), Legal Entities."],
    concepts: TAX_CONCEPTS,
    flow: TAX_FLOW,
  },
  "taxes-configure": {
    title: "Tax Configuration",
    summary: "Build the whole tax chain (engine, treatment, policy, rates and product assignment) from a description or step-by-step forms.",
    why: "The tax objects depend on each other, so they have to be created in the right order.",
    where: "TaxEngine, TaxTreatment, TaxPolicy, TaxTreatmentItem, TaxRate, Product2.TaxPolicyId.",
    how: ["AI: describe the tax → the plan lists each record in dependency order → you approve each step.", "Manual: Engine → Policy → Treatments → Items → Rates → Products, validated against your org's metadata."],
    prerequisites: ["Geography and Legal Entity exist."],
    next: ["Refresh the decision table if rates changed, then run a Tax Calculation."],
    connects: ["Tax Calculation, Engine Readiness, Products."],
    concepts: TAX_CONCEPTS,
    flow: TAX_FLOW,
  },
  "taxes-calculation": {
    title: "Tax Calculation",
    summary: "Proves your tax setup on a real Order → Invoice → Invoice Line Tax, and reads Salesforce's own tax result.",
    why: "A configuration only counts once Salesforce actually calculates the expected tax on an invoice.",
    where: "Order, Invoice, InvoiceLine, InvoiceLineTax.",
    how: ["Pick or create a test order, generate the invoice, then read the tax Salesforce wrote. Failures are traced back to the missing link."],
    prerequisites: ["A complete tax chain and an active product with a tax policy."],
    next: ["Fix anything the trace reports, then recalculate."],
    connects: ["Tax Configuration, Orders, Invoices."],
    concepts: TAX_CONCEPTS,
  },
  "taxes-readiness": {
    title: "Engine Readiness",
    summary: "Read-only checks on whether Salesforce can calculate tax: decision table, engine and permissions.",
    why: "Explains \"no tax on invoice\" before you spend time on test orders.",
    where: "TaxEngine, DecisionTable (Revenue Standard Tax), permission sets.",
    how: ["Runs checks only; never changes Salesforce."],
    prerequisites: ["None."],
    next: ["Resolve blocked items (often: refresh the decision table in Setup)."],
    connects: ["Tax Engines, Decision Tables, Tax Calculation."],
  },
  "tax-engines": {
    title: "Tax Engines",
    summary: "The engine that calculates tax. The native Revenue Standard Tax engine looks rates up in a decision table; an external engine calls a provider such as Avalara.",
    why: "Every Tax Treatment needs an engine, which decides where the tax number comes from.",
    where: "TaxEngine — referenced by Tax Treatments.",
    how: ["Native: no provider, rates come from your Tax Rate records.", "External: needs a provider adapter and a Named Credential."],
    prerequisites: ["For external engines: the provider package/adapter and credentials."],
    next: ["Create a Tax Treatment that uses this engine."],
    connects: ["Tax Treatments, Decision Tables."],
    concepts: TAX_CONCEPTS,
  },
  "tax-policies": {
    title: "Tax Policies",
    summary: "A Tax Policy is attached to a product (Product2.TaxPolicyId) and decides which Tax Treatment applies: Default, Manual or Legal Entity selection.",
    why: "Many products can share one policy, so tax behaviour is managed in one place.",
    where: "TaxPolicy → DefaultTaxTreatmentId.",
    how: ["Policies start as Draft. Create and activate the treatment, set it as the policy default, then activate the policy.", "If the default Tax Treatment has 'Use Tax Treatment Items', every product also needs its own Tax Treatment Item (product + Tax Code) under it — otherwise the treatment's own Tax Code applies to all products."],
    prerequisites: ["An active Tax Treatment.", "For per-product items: a Tax Code on the default Tax Treatment — bulk assignment copies it onto each product's item."],
    next: ["Assign the policy to products on the dedicated Bulk Product Assignment page. It lists only products with no Tax Policy (their Billing Policy doesn't matter), never overwrites an existing assignment, and creates or reuses each product's Tax Treatment Item before linking the policy."],
    connects: ["Tax Treatments, Products."],
    concepts: TAX_CONCEPTS,
    flow: TAX_FLOW,
  },
  "tax-bulk-assignment": {
    title: "Tax Policy Bulk Product Assignment",
    summary: "Assign one existing Tax Policy to many products at once — and configure each product's Tax Treatment Item with it.",
    why: "Each taxable product needs both its Tax Policy and (when the treatment uses items) its own Tax Treatment Item with the right Tax Code; doing both for many products by hand is error-prone.",
    where: "Writes TaxTreatmentItem (TaxTreatmentId, ProductId, TaxCode, ProductCode) when needed, then Product2.TaxPolicyId.",
    how: ["Pick a Tax Policy — Inactive policies can't be assigned; the page shows whether its default Tax Treatment uses per-product items or one treatment Tax Code.", "Only products with NO Tax Policy are listed — a product's Billing Policy is irrelevant here.", "The Tax Code is resolved automatically from Salesforce — the default Tax Treatment's Tax Code, else the Tax Engine's (only if the org's Tax Engine has a Tax Code field), else not configured — and shown read-only with its source. It can't be typed or overridden, and is never taken from a Product Code.", "For per-product items: the product's existing item is reused and its Tax Code is never changed (a different code is reported as a conflict); otherwise one is created with the resolved Tax Code, or without one when none is configured — an empty Tax Code doesn't block assignment.", "The item is configured BEFORE the policy is linked, then both are re-read from Salesforce. Existing assignments and items are never overwritten or duplicated."],
    prerequisites: ["An Active Tax Policy with its default Tax Treatment.", "Edit access to Product2.TaxPolicyId; create access to Tax Treatment Items when the treatment uses them."],
    next: ["Make sure Tax Rates exist for the Tax Codes used, refresh the decision table, then run a Tax Calculation."],
    connects: ["Tax Policies, Tax Treatments, Tax Treatment Items, Tax Rates, Products."],
    concepts: TAX_CONCEPTS,
  },
  "tax-treatments": {
    title: "Tax Treatments",
    summary: "How a policy taxes a product: taxable or not, the Tax Code, the Tax Engine and the Legal Entity.",
    why: "The Tax Code on the treatment is what Salesforce matches against Tax Rates.",
    where: "TaxTreatment (+ TaxTreatmentItem), selected by a Tax Policy; stamped on order products.",
    how: ["Set the Tax Code, engine and legal entity; activate.", "Use Tax Treatment Items when different products under one policy need different tax codes."],
    prerequisites: ["A Tax Engine and Legal Entity."],
    next: ["Create Tax Rates for the Tax Code; set the treatment as a policy default."],
    connects: ["Tax Policies, Tax Engines, Tax Rates, Legal Entities."],
    concepts: TAX_CONCEPTS,
  },
  "tax-treatment-items": {
    title: "Tax Treatment Items",
    summary: "Product-specific tax codes under one Tax Treatment, used when the treatment has Use Tax Treatment Items set.",
    why: "One policy can cover products taxed at different rates.",
    where: "TaxTreatmentItem.",
    how: ["Each item maps a product to a tax code."],
    prerequisites: ["The parent treatment and the product."],
    next: ["Create Tax Rates for each tax code."],
    connects: ["Tax Treatments, Tax Rates, Products."],
    concepts: TAX_CONCEPTS,
  },
  "tax-rates": {
    title: "Tax Rates",
    summary: "The percentage the native engine applies for a Tax Code in a country or state, for a legal entity and date range.",
    why: "Without a matching rate, the invoice line gets no tax.",
    where: "TaxRate — fed into the Revenue Standard Tax decision table.",
    how: ["Match = Tax Code + country/state (+ legal entity, product) within the effective dates.", "Tax Code and geography can't be changed after creation; changing them creates a replacement rate.", "Refresh the decision table after adding or changing rates."],
    prerequisites: ["Geo Country/State and the treatment's Tax Code."],
    next: ["Refresh the decision table, then run a Tax Calculation.", "To reuse a known rate, open the Global Tax Rate Library and choose Create Tax Rate in Salesforce — it pre-fills this form for review."],
    connects: ["Tax Treatments, Geo Countries/States, Decision Tables."],
    concepts: TAX_CONCEPTS,
  },
  "tax-rate-library": {
    title: "Global Tax Rate Library",
    summary: "A reusable reference catalog of tax rates for any country and state/province — searchable, versioned and sourced — that can prefill the Salesforce Tax Rate form.",
    why: "Implementations repeatedly look up the same rates (GST slabs, HST/PST/QST, VAT). Keeping them once, with their source, effective dates and history, avoids re-typing — and mistakes — every time a Salesforce Tax Rate is created.",
    where: "Outside Salesforce: source-backed reference data shipped with the app (EU VAT from the European Commission's TEDB; other countries from national tax authorities and legislation). Your own edits are kept in this browser. It only reaches Salesforce through \"Create Tax Rate in Salesforce\", which opens the existing Create Tax Rate form pre-filled.",
    how: ["Every ISO 3166 country and ISO 3166-2 subdivision is available; a country can hold many rates (types, codes, components, classifications, periods).", "Rates change by NEW VERSION: the old one is closed (Effective To) and kept as history — never overwritten. Records are archived, not deleted.", "Use This Rate pre-fills Geo Country, Geo State, Tax Code, Rate and dates (Geo records are looked up in the org, never created). You review, validate and click Create — nothing is written before that.", "National rates apply in every state/province of the country (selecting a state shows them alongside any state/provincial rates); local taxes appear only where a source covers them.", "Each rate shows its source and verification: Verified (re-confirmed against the official source), Partially verified (official source + verbatim quote, automated re-check unavailable) or Unverified. Where no official source was confirmed, the country shows the missing scope instead of a rate. The library is not a tax determination."],
    prerequisites: ["For Use This Rate: the country (and state) as Geo Country / Geo State records in the org."],
    next: ["Check the rates for your jurisdictions and their sources, then create the Salesforce Tax Rates you need, refresh the decision table and run a Tax Calculation."],
    connects: ["Tax Rates (Salesforce), Geo Countries, Geo States, Tax Treatments (Tax Code)."],
    concepts: TAX_CONCEPTS,
  },
  "geo-countries": {
    title: "Geo Countries",
    summary: "The countries tax rates are keyed by, using ISO-2 codes (fixed once created).",
    why: "Account addresses are matched to these to find the right rate.",
    where: "GeoCountry.",
    how: ["Create one per country you sell into."],
    prerequisites: ["None."],
    next: ["Add Geo States if rates vary by state/province."],
    connects: ["Tax Rates, Geo States."],
  },
  "geo-states": {
    title: "Geo States",
    summary: "States or provinces of a Geo Country, for state-level tax rates (ISO code fixed once created).",
    why: "Needed wherever tax differs by state or province.",
    where: "GeoState.",
    how: ["Create under its country."],
    prerequisites: ["The Geo Country."],
    next: ["Create state-level Tax Rates."],
    connects: ["Geo Countries, Tax Rates."],
  },
  "tax-decision-tables": {
    title: "Decision Tables",
    summary: "The lookup tables the native engine reads rates from. They're administrative configuration, managed in Salesforce Setup.",
    why: "A stale or outdated table is the most common reason invoices show no tax.",
    where: "DecisionTable (Usage Type Revenue Standard Tax). View-only here.",
    how: ["Refresh in Setup after rate changes."],
    prerequisites: ["Admin access in Salesforce Setup."],
    next: ["Check Engine Readiness."],
    connects: ["Tax Rates, Tax Engines."],
  },
  "tax-decision-table-parameters": {
    title: "Decision Table Columns",
    summary: "The input and output columns of the tax decision tables, for example whether Tax Code is an input.",
    why: "Explains why a rate does or doesn't match.",
    where: "DecisionTableParameter. View-only.",
    how: ["Read-only reference."],
    prerequisites: ["—"],
    next: ["—"],
    connects: ["Decision Tables."],
  },
  "tax-decision-dataset-links": {
    title: "Decision Dataset Links",
    summary: "Which source object (Tax Rate) feeds each tax decision table.",
    why: "Confirms the table reads your rates.",
    where: "DecisionTableDatasetLink. View-only.",
    how: ["Read-only reference."],
    prerequisites: ["—"],
    next: ["—"],
    connects: ["Decision Tables, Tax Rates."],
  },
  "tax-lookup-tables": {
    title: "Lookup Tables (Decision Matrix)",
    summary: "Salesforce's system lookup-table wrapper for the tax decision tables.",
    why: "Reference only.",
    where: "CalculationMatrix. View-only.",
    how: ["Read-only reference."],
    prerequisites: ["—"],
    next: ["—"],
    connects: ["Decision Tables."],
  },

  // ══ Service Cloud / Custom ══
  "work-orders": { title: "Work Orders", summary: "Field service jobs.", why: "Schedules and tracks on-site work.", where: "WorkOrder (Field Service). Not part of Revenue Cloud configuration.", how: ["The numbers on this tile are illustrative."], prerequisites: ["An Account/Asset."], next: ["—"], connects: ["Assets, Cases."] },
  entitlements: { title: "Entitlements", summary: "The support a customer is entitled to.", why: "Drives SLAs.", where: "Entitlement (Service Cloud).", how: ["The numbers on this tile are illustrative."], prerequisites: ["An Account."], next: ["—"], connects: ["Cases, Assets."] },
  knowledge: { title: "Knowledge", summary: "Help articles.", why: "Self-service and agent answers.", where: "Knowledge (Service Cloud).", how: ["The numbers on this tile are illustrative."], prerequisites: ["Knowledge enabled."], next: ["—"], connects: ["Cases."] },
  queues: { title: "Queues", summary: "Shared work queues.", why: "Routes records to teams.", where: "Group (Queue).", how: ["The numbers on this tile are illustrative."], prerequisites: ["Users."], next: ["—"], connects: ["Cases, Leads."] },
  "custom-records": { title: "Custom Records", summary: "Records of your org's custom objects.", why: "Covers org-specific data.", where: "Custom objects (__c).", how: ["The numbers on this tile are illustrative."], prerequisites: ["The custom object."], next: ["—"], connects: ["—"] },
};

/** Taxes view/module key (taxesNavKey) → guide key. */
/** Intro key for the Taxes workspace's URL state — the sidebar key (taxesNavKey), except on the dedicated bulk-assignment page. */
export function taxesIntroKey(v: { tv: string | null; tm: string | null; tid: string | null }): string {
  if (v.tv === "bulk-assignment") return "tax-bulk-assignment";
  if (v.tv === "rate-library") return "tax-rate-library";
  if (v.tv && ["configure", "configure-manual", "calculation", "readiness", "run"].includes(v.tv)) return v.tv === "run" ? "calculation" : v.tv === "configure-manual" ? "configure" : v.tv;
  return v.tm ?? "dashboard";
}

function taxesGuideKey(navKey: string | null | undefined): string {
  if (!navKey || navKey === "dashboard") return "taxes-dashboard";
  if (navKey === "configure" || navKey === "calculation" || navKey === "readiness") return `taxes-${navKey}`;
  return navKey;
}

/** Billing workspace active module (BillingWorkspace onActiveModuleChange / sub-view) → guide key. */
function billingGuideKey(moduleKey: string | null | undefined, view?: string | null): string {
  if (view === "assign" || view === "product" || view === "order") return `billing-${view}`;
  if (view === "bulk-assignment") return "billing-bulk-assignment";
  if (!moduleKey) return "billing-overview";
  if (moduleKey === "tax") return "billing-tax";
  return moduleKey;
}

export interface ModuleGuideContext {
  /** Sidebar item id (app/data/page.tsx DATA_GROUPS). */
  itemId: string;
  groupId: string;
  /** The tile's current sub-view (products/bundles/attributes module view mode), when it has one. */
  subView?: string | null;
  /** Billing: workspace's active module key and sub-view. */
  billingModule?: string | null;
  billingView?: string | null;
  /** Taxes: taxesNavKey of the workspace's current view. */
  taxesKey?: string | null;
}

/** Resolve the guide for the module the user is looking at right now (follows the workspaces' own navigation). */
export function moduleGuideKeyFor(ctx: ModuleGuideContext): string | null {
  let key: string;
  if (ctx.groupId === "taxes") key = taxesGuideKey(ctx.taxesKey);
  else if (ctx.groupId === "billing") key = billingGuideKey(ctx.billingModule, ctx.billingView);
  else if (ctx.itemId === "products") {
    const v = ctx.subView;
    key = v === "create" || v === "create-multi" || v === "choose-type" || v === "edit" ? "product-create"
      : v === "configuration" ? "product-configuration" : v === "import" ? "product-import" : "products";
  } else if (ctx.itemId === "bundles") {
    const v = ctx.subView;
    key = v === "create" || v === "edit" ? "bundle-create" : v === "components" || v === "dependencies" ? "bundle-components" : "bundles";
  } else if (ctx.itemId === "attributes") {
    key = ctx.subView === "create" || ctx.subView === "edit" ? "attribute-create" : "attributes";
  } else key = ctx.itemId;
  return key in MODULE_GUIDES ? key : null;
}

export function getModuleGuide(key: string | null | undefined): ModuleGuide | null {
  return key ? MODULE_GUIDES[key] ?? null : null;
}
