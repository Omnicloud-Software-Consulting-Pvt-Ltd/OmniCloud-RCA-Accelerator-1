/**
 * Revenue Cloud Billing module registry — the ONE place that maps a billing
 * CONCEPT (e.g. "Unit Aggregation Policy") to the Salesforce objects that
 * may implement it. Nothing here is trusted as fact about the connected org:
 * every `candidates` entry is only a "try this API name first" hint, resolved
 * at runtime against the org's own global Describe (lib/billing/server/
 * discovery.ts). A module whose candidates don't exist in the org is shown as
 * "Not available in this org" instead of being called and failing.
 *
 * Likewise every `columns`/`statusFields` entry lists candidate FIELD names —
 * a column only renders when one of its candidates is present in the object's
 * Describe, so an org on a different API version (or with a trimmed schema)
 * never gets a query for a field it doesn't have.
 *
 * Shared by client and server — keep it free of server-only imports.
 */

import { TAX_MODULES } from "@/lib/taxes/modules";

export type BillingGroupId = "configuration" | "usage" | "operations" | "taxes";

export interface BillingColumnDef {
  id: string;
  /** Optional display override — defaults to the resolved field's Describe label. */
  label?: string;
  /** Candidate field API names, in priority order. The first one present in Describe wins. */
  fields: string[];
}

/**
 * A field on ANOTHER object that can be pointed at the record being created
 * (e.g. Product2.BillingPolicyId → the new Billing Policy). Offered as an
 * explicit, opt-in "Also link" step in the preview — never applied silently.
 */
export interface BillingInboundLinkDef {
  /** Object whose record will be updated (e.g. "Product2"). */
  sobject: string;
  /** Reference field on that object to set (e.g. "BillingPolicyId"). */
  field: string;
  /** What gets written: the new record's own Id, or the value of one of the new record's reference fields. */
  valueSource: "self" | { field: string };
  label: string;
  /** Existing app module this object belongs to, for cross-navigation. */
  appModule?: AppModuleLink;
}

/** Existing (non-billing) Data Omnion modules a billing record can link out to — reused, never duplicated. */
export type AppModuleLink = "products" | "orders" | "contracts" | "quotes";

export interface BillingModuleDef {
  key: string;
  label: string;
  singular: string;
  group: BillingGroupId;
  icon: string;
  description: string;
  /** Candidate SObject API names in priority order (e.g. legacy managed-package names last). */
  candidates: string[];
  /** Fallback discovery by object label when none of the candidates exist. */
  labelPattern?: RegExp;
  columns: BillingColumnDef[];
  /** Candidate status fields — drives the status breakdown and status pills. */
  statusFields: string[];
  /** Child modules that can be created inline with the parent (e.g. Treatment → Treatment Items). */
  children?: string[];
  inboundLinks?: BillingInboundLinkDef[];
  /**
   * Values Revenue Cloud Billing's own business rules require but Describe can't express (they're
   * enforced by the platform at save time, not as picklist defaults). Pre-filled on new records only
   * when the field exists, is createable and — for picklists — the value is one of the org's values.
   */
  defaults?: Record<string, string | number | boolean>;
  /** Why `defaults` exist — shown next to the pre-filled fields and in the AI assumptions. */
  defaultsReason?: string;
  /**
   * `defaults` only apply when the parent record's boolean flag has this value (e.g. items of a
   * NON-milestone treatment). The parent is either the draft parent or the record referenced by
   * the child's reference field to `parentModule`.
   */
  defaultsCondition?: { parentModule: string; parentFlag: string; applyWhen: boolean };
  /** Optional lookups whose absence leaves the configuration incomplete — reported as dependency warnings. */
  recommendedReferences?: { field: string; message: string }[];
  /** Child module that should have at least one record for the configuration to work. */
  recommendedChild?: { moduleKey: string; message: string };
  /**
   * When set, the module is browse-only in this app even if Describe says the user may create/edit it (e.g. Salesforce
   * administrative configuration such as decision tables). The value is the reason shown to the user; create/edit routes refuse.
   */
  viewOnly?: string;
  /** Fixed equality filters applied to every list of this module (e.g. only Revenue Standard Tax decision tables). */
  listFilter?: { field: string; value: string }[];
  /**
   * Taxes modules: the create page's AI analysis goes through the Tax Configuration Assistant (/api/taxes/assistant/*, tax
   * metadata at the taxes API version) for this object (candidates[0]) instead of the generic Billing AI analysis.
   */
  aiViaTaxAssistant?: boolean;
  /** Short button labels for `aiExamples` (same order); the full example is what goes into the prompt. */
  aiExampleLabels?: string[];
  /** Shown when the object exists but isn't createable — e.g. system-generated Billing Schedules. */
  readOnlyNote?: string;
  /** Position in the conceptual Product → Payment flow shown on the Billing dashboard. */
  flowStep?: number;
  aiExamples: string[];
  /** When set, this module mirrors an existing app module that owns the full workflow. */
  appModule?: AppModuleLink;
}

export const BILLING_GROUPS: { id: BillingGroupId; label: string; icon: string; description: string }[] = [
  { id: "configuration", label: "Billing Configuration", icon: "sliders", description: "Policies, treatments and terms that decide how and when products are billed." },
  { id: "usage", label: "Usage Billing", icon: "activity", description: "Usage resources, units, aggregation and rating that turn consumption into charges." },
  { id: "operations", label: "Billing Operations", icon: "credit-card", description: "Billing accounts, schedules, invoices and payments generated from activated orders." },
];

export const BILLING_MODULES: BillingModuleDef[] = [
  /* ── Billing Configuration ── */
  {
    key: "billing-policies",
    label: "Billing Policies",
    singular: "Billing Policy",
    group: "configuration",
    icon: "shield",
    description: "Decide which Billing Treatment applies to a product. Products point at a Billing Policy; the policy selects the treatment.",
    candidates: ["BillingPolicy"],
    columns: [
      { id: "status", fields: ["Status"] },
      { id: "selection", fields: ["BillingTreatmentSelection"] },
      { id: "defaultTreatment", label: "Default Treatment", fields: ["DefaultBillingTreatmentId"] },
      { id: "description", fields: ["Description"] },
    ],
    statusFields: ["Status", "IsActive"],
    children: ["billing-treatments"],
    inboundLinks: [
      { sobject: "Product2", field: "BillingPolicyId", valueSource: "self", label: "Assign this Billing Policy to Products", appModule: "products" },
    ],
    recommendedReferences: [
      { field: "DefaultBillingTreatmentId", message: "Billing Policy can be created, but no Billing Treatment has been selected — products using it won't know how to bill." },
    ],
    flowStep: 3,
    aiExamples: [
      "Create a monthly billing policy for Laptop Basic Bundle using the Standard Monthly Treatment.",
      "Create an active billing policy called Standard Monthly Billing that uses the default treatment selection.",
      "Create a monthly recurring billing policy for subscription products with a treatment that bills 100% in advance.",
    ],
  },
  {
    key: "billing-treatments",
    label: "Billing Treatments",
    singular: "Billing Treatment",
    group: "configuration",
    icon: "layers",
    description: "Configure how billing is applied to products, services and usage — split into ordered Treatment Items (advance/arrears, percentage, flat amount, milestones).",
    candidates: ["BillingTreatment"],
    columns: [
      { id: "status", fields: ["Status"] },
      { id: "policy", label: "Billing Policy", fields: ["BillingPolicyId"] },
      { id: "legalEntity", label: "Legal Entity", fields: ["LegalEntityId"] },
      { id: "exclude", fields: ["ExcludeFromBilling"] },
      { id: "milestone", fields: ["IsMilestoneBilling"] },
    ],
    statusFields: ["Status", "IsActive"],
    children: ["billing-treatment-items"],
    recommendedReferences: [
      { field: "BillingPolicyId", message: "No Billing Policy selected — products can only use this treatment through a Billing Policy." },
    ],
    recommendedChild: { moduleKey: "billing-treatment-items", message: "This Billing Treatment has no Treatment Items — it can't bill anything until at least one item exists." },
    inboundLinks: [
      { sobject: "BillingPolicy", field: "DefaultBillingTreatmentId", valueSource: "self", label: "Make this the default treatment of a Billing Policy" },
      { sobject: "Product2", field: "BillingPolicyId", valueSource: { field: "BillingPolicyId" }, label: "Assign the selected Billing Policy to Products", appModule: "products" },
    ],
    flowStep: 4,
    aiExamples: [
      "Create a monthly recurring billing treatment for Laptop Basic Bundle.",
      "Create a billing treatment for Laptop Basic Bundle using the Standard Billing Policy. Bill 100% in advance.",
      "Create a billing treatment called Arrears Billing that bills everything in arrears.",
    ],
  },
  {
    key: "billing-treatment-items",
    label: "Billing Treatment Items",
    singular: "Billing Treatment Item",
    group: "configuration",
    icon: "list",
    description: "The ordered billing steps inside a Billing Treatment — billing type, distribution (percentage / flat amount / remainder) and processing order.",
    candidates: ["BillingTreatmentItem"],
    columns: [
      { id: "treatment", label: "Billing Treatment", fields: ["BillingTreatmentId"] },
      { id: "status", fields: ["Status"] },
      { id: "order", fields: ["ProcessingOrder"] },
      { id: "billingType", fields: ["BillingType"] },
      { id: "type", fields: ["Type"] },
      { id: "percentage", fields: ["Percentage"] },
      { id: "flat", fields: ["FlatAmount"] },
    ],
    statusFields: ["Status"],
    // Salesforce rejects non-milestone treatment items unless Sequencing = Manual, Controller =
    // BillingScheduleGroup and Zero Amount Behavior = Create Invoice (INVALID_FIELD_FOR_INSERT_UPDATE).
    defaults: { Sequencing: "Manual", Controller: "BillingScheduleGroup", Handling0Amount: "CreateInvoice" },
    defaultsReason: "Required by Salesforce for items of a non-milestone Billing Treatment.",
    defaultsCondition: { parentModule: "billing-treatments", parentFlag: "IsMilestoneBilling", applyWhen: false },
    flowStep: 5,
    aiExamples: [
      "Create a billing treatment item on the Standard Treatment that bills 100% in arrears.",
      "Create a recurring treatment item for Laptop Basic Bundle and configure it for monthly billing.",
    ],
  },
  {
    key: "billing-rules",
    label: "Billing Rules",
    singular: "Billing Rule",
    group: "configuration",
    icon: "book",
    description: "Legacy Salesforce Billing (managed package) billing rules. Revenue Cloud Billing replaces rules with Billing Policies + Treatments, so this only appears when the legacy package is installed.",
    candidates: ["blng__BillingRule__c"],
    columns: [
      { id: "active", fields: ["blng__Active__c"] },
      { id: "initial", fields: ["blng__InitialBillingTrigger__c"] },
      { id: "partial", fields: ["blng__PartialPeriodTreatment__c"] },
    ],
    statusFields: ["blng__Active__c"],
    aiExamples: ["Create a billing rule that triggers billing on order product activation."],
  },
  {
    key: "billing-milestone-plans",
    label: "Billing Milestone Plans",
    singular: "Billing Milestone Plan",
    group: "configuration",
    icon: "flag",
    description: "Billing plans that release charges when milestones (dates or events) are accomplished, for treatments with milestone billing enabled.",
    candidates: ["BillingMilestonePlan"],
    columns: [
      { id: "treatment", label: "Billing Treatment", fields: ["BillingTreatmentId"] },
      { id: "status", fields: ["Status"] },
      { id: "amount", fields: ["ReferenceItemAmount"] },
    ],
    statusFields: ["Status"],
    children: ["billing-milestone-plan-items"],
    aiExamples: ["Create a milestone plan on the Project Treatment with 30% on activation and the remainder on completion."],
  },
  {
    key: "billing-milestone-plan-items",
    label: "Milestone Plan Items",
    singular: "Milestone Plan Item",
    group: "configuration",
    icon: "check-square",
    description: "Individual milestones inside a Billing Milestone Plan.",
    candidates: ["BillingMilestonePlanItem"],
    columns: [
      { id: "plan", label: "Milestone Plan", fields: ["BillingMilestonePlanId"] },
      { id: "type", fields: ["Type"] },
      { id: "percentage", fields: ["Percentage"] },
      { id: "milestoneType", fields: ["MilestoneType"] },
      { id: "status", fields: ["Status"] },
    ],
    statusFields: ["Status"],
    aiExamples: ["Add a 50% milestone item to the Project Delivery plan triggered by an event."],
  },
  {
    key: "payment-terms",
    label: "Payment Terms",
    singular: "Payment Term",
    group: "configuration",
    icon: "calendar",
    description: "When invoices fall due (e.g. Net 30). Used by billing schedule groups, orders and invoices.",
    candidates: ["PaymentTerm"],
    columns: [
      { id: "status", fields: ["Status"] },
      { id: "default", fields: ["IsDefault"] },
      { id: "description", fields: ["Description"] },
    ],
    statusFields: ["Status"],
    children: ["payment-term-items"],
    aiExamples: ["Create an active payment term called Net 30 with one period-based item of 30 days."],
  },
  {
    key: "payment-term-items",
    label: "Payment Term Items",
    singular: "Payment Term Item",
    group: "configuration",
    icon: "clock",
    description: "The due-date rule(s) inside a Payment Term.",
    candidates: ["PaymentTermItem"],
    columns: [
      { id: "term", label: "Payment Term", fields: ["PaymentTermId"] },
      { id: "type", fields: ["Type"] },
      { id: "period", fields: ["Period"] },
      { id: "unit", fields: ["PeriodUnit"] },
    ],
    statusFields: [],
    aiExamples: ["Add a 45-day period-based item to the Net 45 payment term."],
  },
  {
    key: "legal-entities",
    label: "Legal Entities",
    singular: "Legal Entity",
    group: "configuration",
    icon: "building",
    description: "The selling legal entity used for treatment selection, tax and accounting.",
    candidates: ["LegalEntity"],
    columns: [
      { id: "company", fields: ["CompanyName"] },
      { id: "status", fields: ["Status"] },
      { id: "country", fields: ["LegalEntityCountry"] },
    ],
    statusFields: ["Status"],
    aiExamples: ["Create an active legal entity called Omnicloud India Pvt Ltd based in Hyderabad, India."],
  },
  // Tax Policies / Tax Treatments are owned by the dedicated Tax module (lib/tax, components/data/billing/tax): it creates
  // the whole Engine → Policy → Treatment → Items → Product chain with dependency ordering, which the generic engine can't.

  /* ── Usage Billing ── */
  {
    key: "usage-resources",
    label: "Usage Resources",
    singular: "Usage Resource",
    group: "usage",
    icon: "zap",
    description: "The measurable thing a customer consumes (GB stored, API calls, minutes) — with its unit of measure and aggregation policy.",
    candidates: ["UsageResource"],
    columns: [
      { id: "code", fields: ["Code"] },
      { id: "category", fields: ["Category"] },
      { id: "status", fields: ["Status"] },
      { id: "uom", label: "Default Unit", fields: ["DefaultUnitOfMeasureId"] },
      { id: "aggregation", label: "Aggregation Policy", fields: ["UsageResourceBillingPolicyId"] },
      { id: "product", label: "Usage Product", fields: ["UsageDefinitionProductId"] },
    ],
    statusFields: ["Status"],
    children: ["product-usage-resources"],
    flowStep: 6,
    aiExamples: [
      "Create a usage-based billing configuration for Cloud Backup where customers are charged per GB consumed.",
      "Create an active usage resource called API Calls with code API_CALLS measured in Count, summed monthly.",
    ],
  },
  {
    key: "product-usage-resources",
    label: "Product Usage Resources",
    singular: "Product Usage Resource",
    group: "usage",
    icon: "package",
    description: "Links a Product to the Usage Resource it consumes — the relationship that makes a product usage-billable.",
    candidates: ["ProductUsageResource"],
    columns: [
      { id: "product", label: "Product", fields: ["ProductId"] },
      { id: "resource", label: "Usage Resource", fields: ["UsageResourceId"] },
      { id: "status", fields: ["Status"] },
      { id: "start", fields: ["EffectiveStartDate"] },
    ],
    statusFields: ["Status"],
    aiExamples: ["Link the Cloud Backup product to the Storage GB usage resource, active from today."],
  },
  {
    key: "units-of-measure",
    label: "Units of Measure",
    singular: "Unit of Measure",
    group: "usage",
    icon: "sliders",
    description: "Units that usage is measured and rated in (GB, Hours, Calls), with conversion factors inside a unit class.",
    candidates: ["UnitOfMeasure"],
    columns: [
      { id: "code", fields: ["UnitCode"] },
      { id: "type", fields: ["Type"] },
      { id: "status", fields: ["Status"] },
      { id: "class", label: "Unit Class", fields: ["UnitOfMeasureClassId"] },
      { id: "factor", fields: ["ConversionFactor"] },
    ],
    statusFields: ["Status"],
    aiExamples: ["Create an active unit of measure called Gigabyte with unit code GB of type Memory."],
  },
  {
    key: "unit-of-measure-classes",
    label: "Unit of Measure Classes",
    singular: "Unit of Measure Class",
    group: "usage",
    icon: "layers",
    description: "Groups of convertible units (e.g. Data Storage: MB, GB, TB) with a base and default unit.",
    candidates: ["UnitOfMeasureClass"],
    columns: [
      { id: "code", fields: ["Code"] },
      { id: "type", fields: ["Type"] },
      { id: "status", fields: ["Status"] },
      { id: "base", label: "Base Unit", fields: ["BaseUnitOfMeasureId"] },
      { id: "default", label: "Default Unit", fields: ["DefaultUnitOfMeasureId"] },
    ],
    statusFields: ["Status"],
    aiExamples: ["Create a usage unit class called Data Storage with code DATA_STORAGE."],
  },
  {
    key: "usage-aggregation-policies",
    label: "Unit Aggregation Policies",
    singular: "Unit Aggregation Policy",
    group: "usage",
    icon: "bar-chart",
    description: "How raw usage is accumulated before rating — accumulation method (sum / peak) and period (daily / monthly).",
    candidates: ["UsageResourceBillingPolicy", "UsageAggregationPolicy"],
    labelPattern: /aggregation policy/i,
    columns: [
      { id: "code", fields: ["Code"] },
      { id: "method", fields: ["UsageAccumulationMethod"] },
      { id: "period", fields: ["UsageAccumulationPeriod"] },
      { id: "status", fields: ["Status"] },
    ],
    statusFields: ["Status"],
    inboundLinks: [
      { sobject: "UsageResource", field: "UsageResourceBillingPolicyId", valueSource: "self", label: "Apply this Aggregation Policy to Usage Resources" },
    ],
    aiExamples: ["Create an aggregation policy called Monthly Sum that sums usage monthly."],
  },
  {
    key: "rating-frequency-policies",
    label: "Rating Frequency Policies",
    singular: "Rating Frequency Policy",
    group: "usage",
    icon: "clock",
    description: "How often usage is rated (daily / monthly) and the delay before rating, per usage resource or product.",
    candidates: ["RatingFrequencyPolicy"],
    columns: [
      { id: "resource", label: "Usage Resource", fields: ["UsageResourceId"] },
      { id: "product", label: "Product", fields: ["ProductId"] },
      { id: "period", fields: ["RatingPeriod"] },
      { id: "delay", fields: ["RatingDelayDuration"] },
    ],
    statusFields: [],
    aiExamples: ["Create a monthly rating frequency policy for the Storage GB usage resource with a 2 day delay."],
  },
  {
    key: "rate-cards",
    label: "Rate Cards",
    singular: "Rate Card",
    group: "usage",
    icon: "table",
    description: "Usage rates (base, tiered or attribute-based) with effective dates. Rate Card Entries hold the per-unit rate for each usage resource.",
    candidates: ["RateCard"],
    columns: [
      { id: "type", fields: ["Type"] },
      { id: "from", fields: ["EffectiveFrom"] },
      { id: "to", fields: ["EffectiveTo"] },
      { id: "description", fields: ["Description"] },
    ],
    statusFields: [],
    children: ["rate-card-entries"],
    flowStep: 7,
    aiExamples: [
      "Create a tiered usage rate where the first 100 GB costs ₹5 per GB and usage above 100 GB costs ₹3 per GB.",
      "Create a base rate card called Cloud Backup Rates effective today with a rate of 2 per GB for Storage GB.",
    ],
  },
  {
    key: "rate-card-entries",
    label: "Rate Card Entries",
    singular: "Rate Card Entry",
    group: "usage",
    icon: "dollar-sign",
    description: "The rate charged per unit for a usage resource / product on a Rate Card, optionally adjusted by tiers.",
    candidates: ["RateCardEntry"],
    columns: [
      { id: "card", label: "Rate Card", fields: ["RateCardId"] },
      { id: "resource", label: "Usage Resource", fields: ["UsageResourceId"] },
      { id: "product", label: "Product", fields: ["ProductId"] },
      { id: "rate", fields: ["Rate"] },
      { id: "uom", label: "Rate Unit", fields: ["RateUnitOfMeasureId"] },
      { id: "status", fields: ["Status"] },
    ],
    statusFields: ["Status"],
    children: ["rate-tier-adjustments"],
    aiExamples: ["Add an entry to Cloud Backup Rates charging 2 per GB for the Storage GB usage resource."],
  },
  {
    key: "rate-tier-adjustments",
    label: "Tier Rate Adjustments",
    singular: "Tier Rate Adjustment",
    group: "usage",
    icon: "trending-down",
    description: "Volume tiers on a Rate Card Entry — lower/upper bound and an override, amount or percentage adjustment.",
    candidates: ["RateAdjustmentByTier"],
    columns: [
      { id: "entry", label: "Rate Card Entry", fields: ["RateCardEntryId"] },
      { id: "lower", fields: ["LowerBound"] },
      { id: "upper", fields: ["UpperBound"] },
      { id: "type", fields: ["AdjustmentType"] },
      { id: "value", fields: ["AdjustmentValue"] },
    ],
    statusFields: ["RateCardEntryStatus"],
    aiExamples: ["On the Storage GB rate entry, override the rate to 3 for usage above 100 GB."],
  },
  {
    key: "price-book-rate-cards",
    label: "Price Book Rate Cards",
    singular: "Price Book Rate Card",
    group: "usage",
    icon: "book-open",
    description: "Associates a Rate Card with a Price Book so quotes/orders on that price book rate usage with it.",
    candidates: ["PriceBookRateCard"],
    columns: [
      { id: "pricebook", label: "Price Book", fields: ["PriceBookId"] },
      { id: "card", label: "Rate Card", fields: ["RateCardId"] },
    ],
    statusFields: [],
    aiExamples: ["Attach the Cloud Backup Rates rate card to the Standard Price Book."],
  },
  {
    key: "product-usage-grants",
    label: "Usage Grants",
    singular: "Product Usage Grant",
    group: "usage",
    icon: "star",
    description: "Included / committed usage a product grants (e.g. 50 GB included per month) before overage is charged.",
    candidates: ["ProductUsageGrant"],
    columns: [
      { id: "product", label: "Product", fields: ["ProductOfferId"] },
      { id: "resource", label: "Usage Resource", fields: ["UsageResourceId"] },
      { id: "quantity", fields: ["Quantity"] },
      { id: "uom", label: "Unit", fields: ["UnitOfMeasureId"] },
      { id: "type", fields: ["Type"] },
      { id: "status", fields: ["Status"] },
    ],
    statusFields: ["Status"],
    aiExamples: ["Grant 50 GB of Storage GB per month with the Cloud Backup product, overage chargeable."],
  },

  /* ── Billing Operations ── */
  {
    key: "billing-accounts",
    label: "Billing Accounts",
    singular: "Billing Account",
    group: "operations",
    icon: "briefcase",
    description: "The account-level billing profile — bill-to contact and primary billing address.",
    candidates: ["BillingAccount"],
    columns: [
      { id: "contact", label: "Bill-To Contact", fields: ["BillToContactId"] },
      { id: "city", fields: ["PrimaryBillAddrCity"] },
      { id: "country", fields: ["PrimaryBillAddrCountry"] },
    ],
    statusFields: ["Status"],
    aiExamples: ["Create a billing account called Acme Billing with bill-to contact Jane Doe in San Francisco, USA."],
  },
  {
    key: "billing-schedule-groups",
    label: "Billing Schedule Groups",
    singular: "Billing Schedule Group",
    group: "operations",
    icon: "git-branch",
    description: "System-generated per order product on activation — groups the billing schedules for one product across amendments and renewals.",
    candidates: ["BillingScheduleGroup"],
    columns: [
      { id: "product", label: "Product", fields: ["Product2Id"] },
      { id: "treatment", label: "Billing Treatment", fields: ["BillingTreatmentId"] },
      { id: "account", label: "Account", fields: ["BillingAccountId"] },
      { id: "term", fields: ["BillingTermUnit"] },
      { id: "billed", fields: ["TotalBilledAmount"] },
      { id: "next", fields: ["EffectiveNextBillingDate"] },
    ],
    statusFields: ["Status"],
    readOnlyNote: "Billing Schedule Groups are generated by Salesforce when an order is activated — they can't be created directly.",
    flowStep: 9,
    aiExamples: [],
  },
  {
    key: "billing-schedules",
    label: "Billing Schedules",
    singular: "Billing Schedule",
    group: "operations",
    icon: "calendar",
    description: "System-generated from activated order products — what will be billed, when, and how much is still pending.",
    candidates: ["BillingSchedule"],
    columns: [
      { id: "status", fields: ["Status"] },
      { id: "order", label: "Order", fields: ["ReferenceEntityId"] },
      { id: "item", label: "Treatment Item", fields: ["BillingTreatmentItemId"] },
      { id: "method", fields: ["BillingMethod"] },
      { id: "term", fields: ["BillingTermUnit"] },
      { id: "next", fields: ["NextBillingDate"] },
      { id: "pending", fields: ["PendingAmount"] },
    ],
    statusFields: ["Status"],
    readOnlyNote: "Billing Schedules are created by Salesforce for activated orders with billable products. Use an Order's \"Continue with Revenue Cloud Billing\" setup to activate it and request its schedules.",
    appModule: "orders",
    flowStep: 9,
    aiExamples: [],
  },
  {
    key: "invoices",
    label: "Invoices",
    singular: "Invoice",
    group: "operations",
    icon: "file-text",
    description: "Invoices generated from billing schedules. Read-only here for traceability.",
    candidates: ["Invoice"],
    columns: [
      { id: "status", fields: ["Status"] },
      { id: "account", label: "Account", fields: ["BillingAccountId"] },
      { id: "date", fields: ["InvoiceDate"] },
      { id: "due", fields: ["DueDate"] },
      { id: "total", fields: ["TotalAmountWithTax", "TotalAmount"] },
      { id: "balance", fields: ["Balance"] },
    ],
    statusFields: ["Status"],
    readOnlyNote: "Invoices are generated from billing schedules by invoice runs.",
    flowStep: 10,
    aiExamples: [],
  },
  {
    key: "payments",
    label: "Payments",
    singular: "Payment",
    group: "operations",
    icon: "credit-card",
    description: "Payments received against invoices.",
    candidates: ["Payment"],
    columns: [
      { id: "account", label: "Account", fields: ["AccountId"] },
      { id: "amount", fields: ["Amount"] },
      { id: "status", fields: ["Status"] },
      { id: "type", fields: ["Type"] },
      { id: "date", fields: ["Date", "EffectiveDate"] },
    ],
    statusFields: ["Status"],
    flowStep: 11,
    aiExamples: ["Record an external payment of 1200 for Acme Corp, processed today."],
  },
];

// The Taxes section's modules resolve through the same generic engine, but stay out of BILLING_MODULES (Billing dashboard/stats/AI).
export const BILLING_MODULE_BY_KEY: Record<string, BillingModuleDef> = Object.fromEntries([...BILLING_MODULES, ...TAX_MODULES].map(m => [m.key, m]));

export function getBillingModule(key: string): BillingModuleDef | null {
  return BILLING_MODULE_BY_KEY[key] ?? null;
}

/**
 * The registry `defaults` that are valid in this org: the field must exist and be createable, and a
 * picklist value must be one of the org's active values — otherwise the default is silently dropped.
 */
export function applicableDefaults(
  moduleKey: string,
  fields: { name: string; type: string; createable: boolean; picklistValues: { value: string }[] }[],
  /** The parent's `defaultsCondition.parentFlag` value when known; null/undefined = not known yet (defaults apply, validation re-checks). */
  parentFlag?: boolean | null,
): Record<string, string | number | boolean> {
  const cond = getBillingModule(moduleKey)?.defaultsCondition;
  if (cond && typeof parentFlag === "boolean" && parentFlag !== cond.applyWhen) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(getBillingModule(moduleKey)?.defaults ?? {})) {
    const f = fields.find(x => x.name === name);
    if (!f || !f.createable) continue;
    if (f.type === "picklist" && !f.picklistValues.some(p => p.value === value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * The conceptual end-to-end flow shown on the Billing dashboard. Steps with a
 * `module` are billing modules (resolved against the org like any other);
 * steps with an `appModule` reuse the existing Products/Contracts/Orders/
 * Invoices modules instead of duplicating them.
 */
export const BILLING_FLOW: { id: string; label: string; module?: string; appModule?: AppModuleLink }[] = [
  { id: "product", label: "Product", appModule: "products" },
  { id: "pricing", label: "Selling Model / Pricing", appModule: "products" },
  { id: "policy", label: "Billing Policy", module: "billing-policies" },
  { id: "treatment", label: "Billing Treatment", module: "billing-treatments" },
  { id: "item", label: "Treatment Item", module: "billing-treatment-items" },
  { id: "usage", label: "Usage / Rating", module: "usage-resources" },
  { id: "contract", label: "Contract", appModule: "contracts" },
  { id: "order", label: "Order + Activation", appModule: "orders" },
  { id: "schedule", label: "Billing Schedule", module: "billing-schedules" },
  { id: "invoice", label: "Invoice", module: "invoices" },
  { id: "payment", label: "Payment", module: "payments" },
];

/** Fields that are Salesforce system bookkeeping — shown in the "Salesforce" detail section, never in forms. */
export const SYSTEM_FIELDS = new Set([
  "Id", "IsDeleted", "CreatedDate", "CreatedById", "LastModifiedDate", "LastModifiedById", "SystemModstamp",
  "LastViewedDate", "LastReferencedDate", "OwnerId", "RecordTypeId",
]);

export type BillingFieldSection = "basic" | "configuration" | "relationships" | "salesforce";

const BASIC_LABEL = /(start|end|effective|from|to|date|description|currency|code)$/i;

/**
 * The ONE place a billing field is assigned to a UI section — shared by the create form and the
 * detail view, so a field never appears under a different heading in the two places.
 */
export function billingFieldSection(
  field: { name: string; type: string; label: string },
  schema: { nameField: string | null; statusField: string | null },
): BillingFieldSection {
  if (SYSTEM_FIELDS.has(field.name)) return "salesforce";
  if (field.type === "reference") return "relationships";
  if (field.name === schema.nameField || field.name === schema.statusField || field.name === "CurrencyIsoCode") return "basic";
  if (field.type === "date" || field.type === "datetime" || field.type === "textarea") return "basic";
  if ((field.type === "string" || field.type === "email" || field.type === "url" || field.type === "phone") && BASIC_LABEL.test(field.label)) return "basic";
  return "configuration";
}

/** Describe labels end reference fields with " ID" ("Billing Policy ID") — strip it for display, the UI never shows raw Ids. */
export function displayFieldLabel(label: string, type?: string): string {
  if (type === "reference") return label.replace(/\s+ID$/i, "").trim() || label;
  return label;
}
