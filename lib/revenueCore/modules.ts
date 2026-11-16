/**
 * Revenue Cloud Core dashboard registry — the product-configuration objects of Salesforce Revenue Cloud (Product Catalog
 * Management, Pricing, Configurator). Each entry is counted live by GET /api/revenue-core/stats through the same
 * Describe-resolved, Composite-Batch counter the Billing and Tax dashboards use (lib/billing/server/stats.ts), so:
 *  - an object the connected org doesn't have is reported as "not available" (never shown as a 0 card);
 *  - a count that fails is reported as unavailable (never a fabricated number).
 *
 * `nav` points a card at the EXISTING app module that manages that object — this registry never adds a new create flow.
 * Shared by client and server: no server-only imports here.
 */

export type RevenueCoreArea = "catalog" | "attributes" | "bundles" | "pricing" | "configuration";

/** Where a dashboard card/shortcut opens — always an existing /data module (see app/data/page.tsx). */
export type RevenueCoreNavTarget =
  | { tile: "products"; view?: "history" | "choose-type" | "configuration" | "import" }
  | { tile: "attributes"; view?: "create" | "history" | "catalog" | "import" }
  | { tile: "bundles"; view?: "create" | "history" | "components" | "dependencies" | "catalog" }
  | { tile: "pricing-rules"; view?: "create" | "history" }
  | { tile: "catalogs" }
  | { tile: "quotes"; view?: "create" | "history" }
  | { tile: "billing-policies" };

export interface RevenueCoreModuleDef {
  key: string;
  label: string;
  area: RevenueCoreArea;
  icon: string;
  description: string;
  /** Candidate SObject API names, priority order. */
  candidates: string[];
  /** Candidate status field — drives the status breakdown pill; the counter falls back to a plain count if it's absent. */
  statusFields: string[];
  listFilter?: { field: string; value: string }[];
  /** Opens the module that manages these records. Omitted when the app has no module for it (count only). */
  open?: RevenueCoreNavTarget;
  /** Opens that module's create flow. Omitted when the app has no create flow for it. */
  create?: RevenueCoreNavTarget;
}

export const REVENUE_CORE_AREAS: { id: RevenueCoreArea; label: string; description: string }[] = [
  { id: "catalog", label: "Product Catalog", description: "Products, how they're classified and where they're sold." },
  { id: "attributes", label: "Attributes", description: "The configurable characteristics a product can carry." },
  { id: "bundles", label: "Bundles & Components", description: "How products are packaged together." },
  { id: "pricing", label: "Pricing", description: "Selling models, price books and the procedures that compute prices." },
  { id: "configuration", label: "Configuration & Rules", description: "Configurator flows and qualification rules." },
];

export const REVENUE_CORE_MODULES: RevenueCoreModuleDef[] = [
  // ── Catalog ──
  { key: "products", label: "Products", area: "catalog", icon: "package", candidates: ["Product2"], statusFields: ["IsActive"],
    description: "Product2 records — the sellable items every quote, order, invoice and tax line refers to.",
    open: { tile: "products" }, create: { tile: "products", view: "choose-type" } },
  { key: "product-classifications", label: "Product Classifications", area: "catalog", icon: "layers", candidates: ["ProductClassification"], statusFields: ["Status"],
    description: "Templates that give products of one kind the same set of attributes.",
    open: { tile: "attributes", view: "catalog" } },
  { key: "product-catalogs", label: "Product Catalogs", area: "catalog", icon: "book-open", candidates: ["ProductCatalog"], statusFields: [],
    description: "Top-level collections of categories that sales users browse when adding products.",
    open: { tile: "catalogs" } },
  { key: "product-categories", label: "Product Categories", area: "catalog", icon: "list", candidates: ["ProductCategory"], statusFields: [],
    description: "Folders inside a catalog; products are placed in categories through ProductCategoryProduct.",
    open: { tile: "catalogs" } },
  // ── Attributes ──
  { key: "attribute-definitions", label: "Attribute Definitions", area: "attributes", icon: "sliders", candidates: ["AttributeDefinition"], statusFields: ["IsActive"],
    description: "Reusable attributes such as Color or Storage that products and classifications use.",
    open: { tile: "attributes" }, create: { tile: "attributes", view: "create" } },
  { key: "attribute-categories", label: "Attribute Categories", area: "attributes", icon: "layers", candidates: ["AttributeCategory"], statusFields: [],
    description: "Groups of related attributes, shown together in the configurator.",
    open: { tile: "attributes", view: "catalog" } },
  { key: "attribute-picklists", label: "Attribute Picklists", area: "attributes", icon: "list", candidates: ["AttributePicklist"], statusFields: ["Status"],
    description: "The allowed values for picklist-type attributes.",
    open: { tile: "attributes", view: "history" } },
  // ── Bundles ──
  { key: "product-bundles", label: "Product Bundles", area: "bundles", icon: "package", candidates: ["Product2"], statusFields: ["IsActive"], listFilter: [{ field: "Type", value: "Bundle" }],
    description: "Products of Type = Bundle that group component products.",
    open: { tile: "bundles" }, create: { tile: "bundles", view: "create" } },
  { key: "bundle-components", label: "Bundle Components", area: "bundles", icon: "link", candidates: ["ProductRelatedComponent"], statusFields: [],
    description: "Parent → child product relationships inside a bundle, with quantity rules.",
    open: { tile: "bundles", view: "components" } },
  { key: "component-groups", label: "Component Groups", area: "bundles", icon: "layers", candidates: ["ProductComponentGroup"], statusFields: [],
    description: "Sections of a bundle that group its components (e.g. \"Accessories\").",
    open: { tile: "bundles", view: "dependencies" } },
  // ── Pricing ──
  { key: "product-selling-models", label: "Product Selling Models", area: "pricing", icon: "refresh", candidates: ["ProductSellingModel"], statusFields: ["Status"],
    description: "How a product is sold: One Time, Evergreen or Term Defined, with a pricing term.",
    open: { tile: "products", view: "configuration" } },
  { key: "selling-model-options", label: "Selling Model Options", area: "pricing", icon: "link", candidates: ["ProductSellingModelOption"], statusFields: [],
    description: "Which selling models each product offers.",
    open: { tile: "products", view: "configuration" } },
  { key: "price-books", label: "Price Books", area: "pricing", icon: "book-open", candidates: ["Pricebook2"], statusFields: ["IsActive"],
    description: "Lists of prices; quotes and orders use one price book.",
    open: { tile: "products", view: "configuration" } },
  { key: "price-book-entries", label: "Price Book Entries", area: "pricing", icon: "dollar-sign", candidates: ["PricebookEntry"], statusFields: ["IsActive"],
    description: "A product's list price in a price book, for one selling model and currency.",
    open: { tile: "products", view: "configuration" } },
  { key: "pricing-procedures", label: "Pricing Procedures", area: "pricing", icon: "zap", candidates: ["ExpressionSet"], statusFields: [],
    description: "Expression sets that calculate line prices step by step (counts every expression set, as the Pricing Rules dashboard does).",
    open: { tile: "pricing-rules" }, create: { tile: "pricing-rules", view: "create" } },
  { key: "price-adjustment-schedules", label: "Price Adjustment Schedules", area: "pricing", icon: "bar-chart", candidates: ["PriceAdjustmentSchedule"], statusFields: ["IsActive"],
    description: "Volume and tier discount schedules that pricing procedures look up.",
    open: { tile: "pricing-rules", view: "history" }, create: { tile: "pricing-rules", view: "create" } },
  { key: "price-adjustment-tiers", label: "Price Adjustment Tiers", area: "pricing", icon: "list", candidates: ["PriceAdjustmentTier"], statusFields: [],
    description: "The quantity ranges and discounts inside a schedule.",
    open: { tile: "pricing-rules", view: "history" } },
  { key: "attribute-based-adjustments", label: "Attribute-Based Adjustments", area: "pricing", icon: "sliders", candidates: ["AttributeBasedAdjustment"], statusFields: [],
    description: "Price changes triggered by the attribute values a customer picks.",
    open: { tile: "pricing-rules", view: "history" } },
  { key: "bundle-based-adjustments", label: "Bundle-Based Adjustments", area: "pricing", icon: "package", candidates: ["BundleBasedAdjustment"], statusFields: [],
    description: "Component prices that change when the component is sold inside a bundle.",
    open: { tile: "pricing-rules", view: "history" } },
  // ── Configuration & rules ──
  { key: "configuration-flows", label: "Product Configuration Flows", area: "configuration", icon: "activity", candidates: ["ProductConfigurationFlow"], statusFields: ["Status"],
    description: "Configurator flows that run when a user configures a product on a quote or order.",
    open: { tile: "products", view: "configuration" } },
  { key: "product-qualifications", label: "Product Qualification Rules", area: "configuration", icon: "check-circle", candidates: ["ProductQualification"], statusFields: [],
    description: "Rules that decide whether a product is offered to an account (read-only here — managed in Salesforce Setup)." },
];

/** Top-row KPI → which module status feeds it. */
export const REVENUE_CORE_KPIS: { label: string; moduleKey: string; measure: "total" | "active" | "inactive" }[] = [
  { label: "Total Products", moduleKey: "products", measure: "total" },
  { label: "Active Products", moduleKey: "products", measure: "active" },
  { label: "Draft Products", moduleKey: "products", measure: "inactive" },
  { label: "Product Bundles", moduleKey: "product-bundles", measure: "total" },
  { label: "Attributes", moduleKey: "attribute-definitions", measure: "total" },
  { label: "Catalogs", moduleKey: "product-catalogs", measure: "total" },
  { label: "Categories", moduleKey: "product-categories", measure: "total" },
  { label: "Selling Models", moduleKey: "product-selling-models", measure: "total" },
  { label: "Pricing Procedures", moduleKey: "pricing-procedures", measure: "total" },
];

export function getRevenueCoreModule(key: string): RevenueCoreModuleDef | undefined {
  return REVENUE_CORE_MODULES.find(m => m.key === key);
}

/** KPI value from a module's status, or null when unavailable (object missing, count failed, or no status breakdown). */
export function kpiValue(
  status: { available: boolean; recordCount: number | null; statusBreakdown: { status: string; count: number }[] | null } | undefined,
  measure: "total" | "active" | "inactive",
): number | null {
  if (!status?.available || status.recordCount === null) return null;
  if (measure === "total") return status.recordCount;
  if (!status.statusBreakdown) return null;
  const want = measure === "active" ? "Active" : "Inactive";
  return status.statusBreakdown.filter(b => b.status === want).reduce((s, b) => s + b.count, 0);
}
