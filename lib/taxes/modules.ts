import type { BillingModuleDef } from "@/lib/billing/registry";

/**
 * TAXES module registry — the Salesforce objects behind the top-level Taxes section, using ONLY the API names verified by the
 * 2026-10-07 metadata audit of the connected org (describe + Tooling). Each entry plugs into the app's existing generic,
 * describe-driven record engine (lib/billing/server/{discovery,records,validate,create,edit}.ts and the shared form/lookup/table
 * components), so forms, lookups, picklists, required fields and create-only fields always come from the org's live describe —
 * nothing here is assumed about fields beyond column hints that are dropped when the org doesn't have them.
 *
 * Kept OUT of BILLING_MODULES on purpose: the Revenue Cloud Billing dashboard, statistics and AI router stay exactly as they were.
 *
 * Not modelled (verified absent or unverified): Tax Region / Jurisdiction objects (don't exist), a Tax Code object (TaxCode is a
 * field), TaxEngineProvider creation (no providers; needs an Apex adapter — unverified), InvoiceLineTax creation (Salesforce-generated).
 * Decision tables and the system lookup-table matrix are view-only administrative configuration: never created, activated, cloned
 * or refreshed by the app.
 */

const LIFECYCLE = "Salesforce activates a Tax Policy only after its default Tax Treatment is Active, so new policies and treatments start as Draft: create the treatment, activate it, set it as the policy's default, then activate the policy.";

export const TAX_MODULES: BillingModuleDef[] = [
  {
    key: "tax-policies", label: "Tax Policies", singular: "Tax Policy", group: "taxes", icon: "shield",
    description: "Decide which Tax Treatment applies to a product (Default, Manual or Legal Entity selection). Products point at a Tax Policy through Product2.TaxPolicyId.",
    candidates: ["TaxPolicy"],
    columns: [
      { id: "status", fields: ["Status"] },
      { id: "selection", fields: ["TreatmentSelection"] },
      { id: "defaultTreatment", label: "Default Tax Treatment", fields: ["DefaultTaxTreatmentId"] },
      { id: "description", fields: ["Description"] },
    ],
    statusFields: ["Status"],
    children: ["tax-treatments"],
    inboundLinks: [{ sobject: "Product2", field: "TaxPolicyId", valueSource: "self", label: "Assign this Tax Policy to Products", appModule: "products" }],
    defaults: { Status: "Draft" },
    defaultsReason: LIFECYCLE,
    recommendedReferences: [{ field: "DefaultTaxTreatmentId", message: "The Tax Policy has no default Tax Treatment — with Default selection, products using it get no treatment. Activate a treatment first, then set it here." }],
    aiExamples: ["Create a Default-selection tax policy called India GST Policy."],
  },
  {
    key: "tax-treatments", label: "Tax Treatments", singular: "Tax Treatment", group: "taxes", icon: "layers",
    description: "How a policy taxes a product: taxable or not, the tax code, the tax engine and the legal entity. Can resolve tax codes per product through Tax Treatment Items.",
    candidates: ["TaxTreatment"],
    columns: [
      { id: "status", fields: ["Status"] },
      { id: "policy", label: "Tax Policy", fields: ["TaxPolicyId"] },
      { id: "taxable", fields: ["IsTaxable"] },
      { id: "taxCode", fields: ["TaxCode"] },
      { id: "engine", label: "Tax Engine", fields: ["TaxEngineId"] },
      { id: "legalEntity", label: "Legal Entity", fields: ["LegalEntityId"] },
    ],
    statusFields: ["Status"],
    children: ["tax-treatment-items"],
    defaults: { Status: "Draft" },
    defaultsReason: LIFECYCLE,
    recommendedReferences: [{ field: "TaxEngineId", message: "A taxable treatment needs a Tax Engine for Salesforce to calculate tax." }],
    aiExamples: ["Create a taxable <tax code> treatment on <tax policy> using <tax engine>."],
  },
  {
    key: "tax-treatment-items", label: "Tax Treatment Items", singular: "Tax Treatment Item", group: "taxes", icon: "list",
    description: "Product-specific tax codes under one Tax Treatment (used when the treatment has Use Tax Treatment Items).",
    candidates: ["TaxTreatmentItem"],
    columns: [
      { id: "treatment", label: "Tax Treatment", fields: ["TaxTreatmentId"] },
      { id: "product", label: "Product", fields: ["ProductId"] },
      { id: "taxCode", fields: ["TaxCode"] },
      { id: "productCode", fields: ["ProductCode"] },
    ],
    statusFields: [],
    aiExamples: ["Create a tax treatment item named <item name> under the existing <tax treatment> for the existing <product>. Resolve both records from Salesforce by name, verify that the treatment allows Tax Treatment Items, and show the resolved Salesforce IDs in the preview. Do not create it until I confirm."],
    aiExampleLabels: ["Create tax treatment item"],
    // TaxTreatmentItem only exists from API v68 — the generic Billing AI analysis (v64) can't see it.
    aiViaTaxAssistant: true,
  },
  {
    key: "tax-rates", label: "Tax Rates", singular: "Tax Rate", group: "taxes", icon: "bar-chart",
    description: "Rates the Revenue Standard Tax engine looks up by tax code, country/state, legal entity and dates. Tax Code and geography are fixed once created — changing them creates a replacement rate.",
    candidates: ["TaxRate"],
    columns: [
      { id: "taxCode", fields: ["TaxCode"] },
      { id: "rate", fields: ["Rate"] },
      { id: "country", label: "Geo Country", fields: ["GeoCountryId"] },
      { id: "state", label: "Geo State", fields: ["GeoStateId"] },
      { id: "usage", fields: ["RateUsageType"] },
      { id: "legalEntity", label: "Legal Entity", fields: ["LegalEntityId"] },
      { id: "start", fields: ["StartDate"] },
      { id: "end", fields: ["EndDate"] },
    ],
    statusFields: [],
    // Pre-filled on new rates (the org's picklist defaults are Commerce / Gross); RevCloud is then ENFORCED by the tax-rate rules
    // (lib/tax/server/rateRules.ts), Net is the verified basis (Gross stays selectable, flagged).
    defaults: { RateUsageType: "RevCloud", ApplicationBasis: "Net" },
    defaultsReason: "Revenue Cloud Billing invoices only match Revenue Cloud rates (the org's picklist defaults are Commerce / Gross); Net is the basis verified to produce InvoiceLineTax.",
    aiExamples: ["Create a <rate>% tax rate with tax code <tax code> for <country>."],
  },
  {
    key: "geo-countries", label: "Geo Countries", singular: "Geo Country", group: "taxes", icon: "globe",
    description: "Countries tax rates are keyed by (ISO-2 code, fixed once created).",
    candidates: ["GeoCountry"],
    columns: [{ id: "iso", fields: ["IsoCode"] }, { id: "description", fields: ["Description"] }],
    statusFields: [],
    aiExamples: ["Create a Geo Country India with ISO code IN."],
  },
  {
    key: "geo-states", label: "Geo States", singular: "Geo State", group: "taxes", icon: "map-pin",
    description: "States/provinces of a Geo Country for state-level tax rates (ISO code fixed once created).",
    candidates: ["GeoState"],
    columns: [{ id: "iso", fields: ["IsoCode"] }, { id: "country", label: "Geo Country", fields: ["GeoCountryId"] }],
    statusFields: [],
    aiExamples: ["Create the Geo State Karnataka (KA) in India."],
  },
  {
    key: "tax-engines", label: "Tax Engines", singular: "Tax Engine", group: "taxes", icon: "cpu",
    description: "The engine that calculates tax — the native Revenue Standard Tax engine looks rates up in a decision table (its own, or Salesforce's StandardTax).",
    candidates: ["TaxEngine"],
    columns: [
      { id: "type", fields: ["Type"] },
      { id: "status", fields: ["Status"] },
      { id: "decisionTable", label: "Decision Table", fields: ["DecisionTableId"] },
      { id: "provider", label: "Provider", fields: ["TaxEngineProviderId"] },
    ],
    statusFields: ["Status"],
    readOnlyNote: "Tax Engine Providers (external engines) need an Apex adapter class; none exist in this org, so only the native Revenue Standard Tax type is usable without Salesforce Setup.",
    aiExamples: ["Create an active Revenue Standard Tax engine."],
  },
  {
    key: "tax-decision-tables", label: "Decision Tables", singular: "Decision Table", group: "taxes", icon: "table",
    description: "Revenue Standard Tax lookup tables (Usage Type Revenue Standard Tax). Administrative configuration — activate, clone and refresh them in Salesforce Setup → Lookup Tables.",
    candidates: ["DecisionTable"],
    columns: [
      { id: "api", label: "API Name", fields: ["DeveloperName"] },
      { id: "status", fields: ["Status"] },
      { id: "refresh", fields: ["RefreshStatus"] },
      { id: "sync", fields: ["LastSyncDate"] },
      { id: "source", fields: ["SourceObject"] },
    ],
    statusFields: ["Status"],
    listFilter: [{ field: "UsageType", value: "RevenueStandardTax" }],
    viewOnly: "Decision tables are Salesforce administrative configuration. This app never creates, edits, activates, clones or refreshes them — use Salesforce Setup → Lookup Tables.",
    aiExamples: [],
  },
  {
    key: "tax-decision-table-parameters", label: "Decision Table Columns", singular: "Decision Table Column", group: "taxes", icon: "layout",
    description: "Input and output columns of the Revenue Standard Tax decision tables (e.g. whether TaxCode is an input).",
    candidates: ["DecisionTableParameter"],
    columns: [
      { id: "table", label: "Decision Table", fields: ["DecisionTableId"] },
      { id: "field", fields: ["FieldName"] },
      { id: "usage", fields: ["Usage"] },
      { id: "operator", fields: ["Operator"] },
      { id: "required", fields: ["IsRequired"] },
    ],
    statusFields: [],
    listFilter: [{ field: "DecisionTable.UsageType", value: "RevenueStandardTax" }],
    viewOnly: "Decision table columns are administrative configuration — change them in Salesforce Setup → Lookup Tables.",
    aiExamples: [],
  },
  {
    key: "tax-decision-dataset-links", label: "Decision Dataset Links", singular: "Decision Dataset Link", group: "taxes", icon: "link",
    description: "Which source object (TaxRate) feeds each Revenue Standard Tax decision table.",
    candidates: ["DecisionTableDatasetLink"],
    columns: [{ id: "table", label: "Decision Table", fields: ["DecisionTableId"] }, { id: "source", fields: ["SourceObject"] }, { id: "default", fields: ["IsDefault"] }],
    statusFields: [],
    listFilter: [{ field: "DecisionTable.UsageType", value: "RevenueStandardTax" }],
    viewOnly: "Dataset links are administrative configuration managed by Salesforce Setup.",
    aiExamples: [],
  },
  {
    key: "tax-lookup-tables", label: "Lookup Tables (Decision Matrix)", singular: "Lookup Table", group: "taxes", icon: "database",
    description: "Salesforce's system lookup-table wrapper for the Revenue Standard Tax decision tables (CalculationMatrix).",
    candidates: ["CalculationMatrix"],
    columns: [{ id: "usage", fields: ["UsageType"] }, { id: "table", label: "Decision Table", fields: ["DecisionMatrixDefinitionId"] }, { id: "status", fields: ["Status"] }, { id: "refresh", fields: ["RefreshStatus"] }],
    statusFields: [],
    listFilter: [{ field: "UsageType", value: "RevenueStandardTax" }],
    viewOnly: "System lookup tables are managed by Salesforce — they reference the decision table and can't be changed here.",
    aiExamples: [],
  },
];

/** Dashboard cards of the Taxes section (Legal Entities reuse the existing Billing module definition). */
export const TAX_DASHBOARD_MODULES = ["tax-policies", "tax-treatments", "tax-treatment-items", "tax-rates", "geo-countries", "geo-states", "tax-engines", "tax-decision-tables", "legal-entities"];
