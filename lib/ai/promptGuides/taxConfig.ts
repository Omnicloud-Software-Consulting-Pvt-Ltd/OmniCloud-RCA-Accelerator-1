import type { PromptGuideConfig } from "@/lib/ai/promptGuideConfig";

/**
 * <PromptGuide> configs for the Tax prompts and the Product Configuration prompt. Same honesty rules as
 * lib/ai/promptGuideConfig.ts: every claim is traced through the actual route → normalization → create/execute path, and
 * limitations are stated instead of implied away.
 *
 * Entry points (key → where it is shown → what handles the prompt):
 *  · taxConfigure        Billing → Tax → Create → AI Prompt        POST /api/billing/tax/interpret (Claude → TaxConfigSpec → lib/tax/server/plan.ts)
 *  · taxAssistant        Taxes → Configure → AI Prompt             POST /api/taxes/assistant/interpret (no object) → calculation query, or
 *                                                                  record operations previewed by lib/tax/server/operations.ts, or the planner
 *  · taxCalculation      Taxes → Calculation                       same route; calculation/verification queries (AI or built-in rules)
 *  · <tax module key>    Taxes → <object> → Create (BillingCreateWorkspace)
 *                          - tax-treatment-items (aiViaTaxAssistant): /api/taxes/assistant/interpret { object, form: true } → lib/tax/server/formDraft.ts
 *                          - the others:                            /api/billing/ai/analyze { moduleKey } → generic describe-driven billing draft
 *  · taxObject           fallback for any other aiViaTaxAssistant tax module without its own entry
 *  · productConfiguration Products → Product Configuration          POST /api/sf/products/command (deterministic parser — NO AI)
 */

/** Beginner primer on how the Revenue Cloud tax records fit together — shared by the tax guides. */
const TAX_CHAIN = "How the pieces fit: a Product points at a Tax Policy (Product2.TaxPolicyId) → the policy picks a Tax Treatment (its default one, or by Manual / Legal Entity selection) → the treatment says taxable or not, the Tax Code and the Tax Engine (optionally a per-product code through Tax Treatment Items) → the native engine looks up a Tax Rate by tax code, product code, country/state, legal entity and dates.";
const INVOICE_LINK = "Tax is calculated by Salesforce on the invoice: an activated order's billing schedules produce an invoice, and the engine writes one InvoiceLineTax per taxed invoice line. There is no separate Tax Code object — the code is a value on the treatment / treatment item / rate, and the rate's Product Code is matched against the product's own Product Code.";
const NATIVE_VS_EXTERNAL = "Native vs external: this app configures Salesforce's native Revenue Standard Tax engine, whose rates you maintain yourself. External providers (e.g. Avalara) need a Tax Engine Provider with an Apex adapter set up in Salesforce Setup — the app never creates providers and only reads which engines are active.";
const DT_REFRESH = "New or changed Tax Rates are only seen by the native engine after its decision table is refreshed — that is a separate, explicitly approved step under Taxes → Engine Readiness, never part of creating a record.";
const NAMES_RESOLVED = "Records you mention (products, policies, treatments, engines, legal entities, countries) are resolved against the real records in the connected Salesforce org by name — the AI never supplies Ids. One match is selected; several or none are shown for you to choose or fix.";
const REVIEW_FORM = "The AI output is only a suggestion: it fills the form below, which you review, edit and Validate before Create writes anything. Reading this guide needs no AI key.";

/** Shared beginner content for the per-object create pages. */
function objectGuide(o: {
  label: string;
  whatItCreates: string;
  requiredFields: PromptGuideConfig["requiredFields"];
  optionalFields: PromptGuideConfig["optionalFields"];
  capabilities: string[];
  extraNotes?: string[];
  example: string;
  second?: { label: string; prompt: string };
}): PromptGuideConfig {
  return {
    title: `AI Prompt Guide — ${o.label}`,
    whatItCreates: o.whatItCreates,
    requiredFields: o.requiredFields,
    optionalFields: o.optionalFields,
    capabilities: [...o.capabilities, TAX_CHAIN],
    interpretationNotes: [
      NAMES_RESOLVED,
      "Fields, picklist values and required (*) fields come from the org's live describe — anything the prompt doesn't cover stays blank and is flagged by validation.",
      "Needs the Anthropic key from Setup; without it Analyze returns \"AI key not configured\" and you can still fill the form manually.",
    ],
    example: { prompt: o.example },
    ...(o.second ? { multipleExample: o.second } : {}),
    multipleNote: `This page creates one ${o.label} (plus any child records its form shows). For a whole configuration (policy, treatments, rates and products together) use Taxes → Configure.`,
    notes: [...(o.extraNotes ?? []), INVOICE_LINK],
    reviewNote: REVIEW_FORM,
  };
}

export const taxConfigPromptGuides: Record<string, PromptGuideConfig> = {
  /* ───────────── Whole-configuration prompts (TaxCreate → AiPrompt) ───────────── */

  taxConfigure: {
    title: "AI Prompt Guide — Tax Configuration",
    whatItCreates: "Builds a complete tax configuration from one description — Tax Engine, Tax Rates, Tax Policy, Tax Treatment(s), Tax Treatment Items and the product mapping — as a dependency-ordered plan that reuses every matching record already in the org. Nothing is created until you confirm the preview.",
    requiredFields: [
      { label: "The products to tax", hint: "Named exactly as in Salesforce; each product's Tax Policy is set to the new/reused policy. Rates are keyed to the product's own Product Code, so a product without a code is blocked." },
      { label: "Taxability and rate", hint: "e.g. \"18% GST\", \"tax-exempt\", \"zero-rated\" (zero-rated = taxable at 0%)." },
    ],
    optionalFields: [
      { label: "Country", hint: "Rates are keyed by country; a Geo Country is created only if the org has none for it." },
      { label: "Tax code", hint: "Only when you give a literal code. Otherwise codes are resolved against existing Revenue Cloud rates; a new code is created only with its rate." },
      { label: "Policy / treatment names", hint: "Used as given; otherwise a descriptive name is suggested and shown in the preview." },
      { label: "Treatment selection", hint: "Default unless you ask for Manual or Legal Entity selection." },
      { label: "Legal entity", hint: "Resolved, never created. A country (\"India GST\") is not a legal entity — blank uses the org's only active legal entity." },
      { label: "Tax engine", hint: "Native Revenue Standard Tax unless you name another type." },
      { label: "Test sale", hint: "\"…and calculate the tax when it is sold at 10000 to Acme\" — run after the configuration is verified." },
    ],
    capabilities: [
      TAX_CHAIN,
      "Different rates for different products under one policy (e.g. 18% on Laptop and Software, 5% on Book) — becomes one treatment with per-product Tax Treatment Items.",
      "Tax-exempt and zero-rated treatments.",
      NATIVE_VS_EXTERNAL,
    ],
    interpretationNotes: [
      "The AI only extracts intent (names, taxability, rates, codes, products); the same planner as Manual Configuration then resolves every record, field and picklist value in the connected org.",
      NAMES_RESOLVED,
      "Records are created as Draft, then treatments are activated, the policy's default treatment is set and the policy activated — Salesforce only activates a policy whose default treatment is Active.",
      "Needs the Anthropic key from Setup. Without it, use the Manual Configuration tab.",
    ],
    example: { prompt: "Create an India GST tax configuration for Laptop with 18% GST. Make the product taxable and use the standard tax engine." },
    multipleExample: { label: "Several products, different rates", prompt: "Apply GST 18% to Laptop and Software, and GST 5% to Book." },
    multipleNote: "One prompt plans one policy with as many treatments, items, rates and product mappings as it needs; the plan shows each step as create, update or reuse.",
    notes: [INVOICE_LINK, DT_REFRESH],
    reviewNote: "The AI output is a suggestion: review the plan (create / reuse / blocked steps), use \"Edit in Manual Configuration\" to adjust it, then confirm Create. Reading this guide needs no AI key.",
  },

  taxAssistant: {
    title: "AI Prompt Guide — Tax Configuration Assistant",
    whatItCreates: "Turns a request into previewed operations on tax records — create, update, assign, activate / deactivate / set to Draft, end-date, replace a rate, delete or show — or hands a whole new configuration to the configuration planner. It also answers tax calculation and verification questions. Nothing changes until you confirm.",
    requiredFields: [
      { label: "What to do", hint: "The verb decides the operation: create / update / assign / activate / deactivate / end-date / replace / delete / show." },
      { label: "Which record", hint: "Name the existing record (policy, treatment, item, rate, product…) exactly as it is in Salesforce." },
    ],
    optionalFields: [
      { label: "Field values", hint: "Only the fields you want set or changed; field names and picklist values are those of the connected org." },
      { label: "Relationship", hint: "\"Assign <treatment> as the default treatment for <policy>\", \"Assign <policy> to the <product> product\"." },
      { label: "Date", hint: "For end-date and rate replacement (YYYY-MM-DD)." },
    ],
    capabilities: [
      TAX_CHAIN,
      "Several requests in one message become several operations, in the order they must run.",
      "Show a policy's complete configuration (treatments, items, products, engine, rates) — read-only.",
      "Calculation questions (\"Calculate tax for…\", \"Why was tax not applied to order…\") are answered from real Salesforce records.",
      NATIVE_VS_EXTERNAL,
    ],
    interpretationNotes: [
      "The AI is grounded with this org's tax objects, writable fields and picklist values, and must name records — never Ids. Its output is re-validated against metadata and resolved in Salesforce before the preview.",
      NAMES_RESOLVED,
      "Lifecycle steps a change needs are planned from the record's current status (e.g. a policy activates only after its default treatment is Active).",
      "Configuration requests need the Anthropic key from Setup. Calculation / verification questions fall back to built-in rules without it, and say which interpreter was used.",
    ],
    example: { prompt: "Assign 'Cloud Storage Standard GST Treatment' as the default treatment for 'Cloud Storage India GST Policy'." },
    multipleExample: { label: "Several steps in order", prompt: "Activate 'Cloud Storage Standard GST Treatment', then activate 'Cloud Storage India GST Policy' after verifying its default treatment is active." },
    multipleNote: "Steps run in the order shown, as separate Salesforce requests, and stop at the first error; every changed record is re-read afterwards.",
    notes: [
      "Delete and deactivate show their dependency impact before you confirm. Changing a rate's tax code or geography creates a replacement rate (the old one is end-dated).",
      INVOICE_LINK,
      DT_REFRESH,
    ],
    reviewNote: "The AI output is a suggestion: check each operation card (record, current → new values, dependencies, warnings), pick any ambiguous record, then Apply and confirm. Reading this guide needs no AI key.",
  },

  taxCalculation: {
    title: "AI Prompt Guide — Tax Calculation",
    whatItCreates: "Answers tax calculation and verification questions about a product, an order, an invoice or the decision table — what Salesforce already has, what is missing, and the actual tax Salesforce calculated. Any change it suggests is shown and approved on its own.",
    requiredFields: [
      { label: "What to check", hint: "A product, an order number, an invoice (DOC-…) or the decision table." },
    ],
    optionalFields: [
      { label: "Customer account", hint: "The account the sale is to (its address drives the country/state)." },
      { label: "Jurisdiction", hint: "Country / state, e.g. \"in Karnataka, India\"." },
      { label: "Quantity and price", hint: "Used for the test sale." },
      { label: "Tax code / rate", hint: "Only if you want a specific code or rate checked." },
    ],
    capabilities: [
      "Calculate tax for a product through the real Salesforce billing flow (order → invoice → InvoiceLineTax).",
      "Explain an order or invoice: tax code, rate, taxable amount, tax amount, total incl. tax — or why no tax was applied.",
      "Inspect what configuration is missing before calculating; check whether the decision table holds the latest rate.",
      TAX_CHAIN,
    ],
    interpretationNotes: [
      "The AI (when a key is configured) only extracts what you wrote — product, order, invoice, customer, jurisdiction, code, rate; otherwise the built-in rules do, and the result says which.",
      NAMES_RESOLVED,
      "The tax shown as the result is only ever Salesforce's InvoiceLineTax — the app never computes tax itself.",
    ],
    example: { prompt: "Calculate tax for the existing Laptop product for Acme Corporation using its configured tax policy, and show the actual tax calculated by Salesforce." },
    multipleExample: { label: "Explain a missing tax", prompt: "Why was tax not applied to order <your order number>?" },
    multipleNote: "One question at a time: each prompt produces one plan or answer. Follow-up steps can be run from the answer on the same page.",
    notes: [
      NATIVE_VS_EXTERNAL,
      DT_REFRESH,
    ],
    reviewNote: "The AI output is a suggestion: the plan lists every step (reused, missing, blocked) and each write is approved separately — nothing is changed by asking. Reading this guide needs no AI key.",
  },

  /* ───────────── Per-object create pages (BillingCreateWorkspace) ───────────── */

  taxObject: objectGuide({
    label: "Tax Record",
    whatItCreates: "Fills this page's create form for one tax record from your description. Nothing is created until you validate and click Create.",
    requiredFields: [{ label: "The org's required fields", hint: "Marked * in the form — from the org's describe." }],
    optionalFields: [{ label: "Related records by name", hint: "Resolved in Salesforce, never by Id." }],
    capabilities: ["Describe the record in plain words, or as \"Field: value\" lines."],
    example: "Create a Geo Country India with ISO code IN.",
  }),

  "tax-engines": objectGuide({
    label: "Tax Engine",
    whatItCreates: "Fills the form for one Tax Engine — the engine that calculates tax. The native Revenue Standard Tax engine looks rates up in a decision table.",
    requiredFields: [
      { label: "Engine name", hint: "The form's * marks (from the org's describe) are authoritative." },
      { label: "Type", hint: "Revenue Standard Tax for the native engine." },
    ],
    optionalFields: [
      { label: "Status", hint: "e.g. Active." },
      { label: "Decision table / provider", hint: "Lookups, resolved by name if you give them." },
    ],
    capabilities: [NATIVE_VS_EXTERNAL],
    extraNotes: ["No Tax Engine Provider exists in this org, so only the native Revenue Standard Tax type is usable without Salesforce Setup."],
    example: "Create an active Revenue Standard Tax engine called India Standard Tax Engine.",
  }),

  "tax-policies": objectGuide({
    label: "Tax Policy",
    whatItCreates: "Fills the form for one Tax Policy — it decides which Tax Treatment applies to the products that point at it (Product2.TaxPolicyId).",
    requiredFields: [
      { label: "Policy name", hint: "The form's * marks are authoritative." },
      { label: "Treatment selection", hint: "Default, Manual or Legal Entity." },
    ],
    optionalFields: [
      { label: "Default Tax Treatment", hint: "Only an Active treatment can be the default; often set later." },
      { label: "Description" },
      { label: "Products to assign", hint: "Offered as an opt-in link in the preview." },
    ],
    capabilities: ["Default, Manual or Legal Entity treatment selection."],
    extraNotes: ["New policies start as Draft: create the treatment, activate it, set it as the policy's default, then activate the policy.", "To assign a policy to many products, use Tax Policies → Bulk Product Assignment (no AI key needed): it lists only products without a Tax Policy, never overwrites one, and creates or reuses each product's Tax Treatment Item before linking the policy."],
    example: "Create a Default-selection tax policy called India GST Policy.",
  }),

  "tax-treatments": objectGuide({
    label: "Tax Treatment",
    whatItCreates: "Fills the form for one Tax Treatment — how its policy taxes a product: taxable or not, the Tax Code, the Tax Engine and the legal entity.",
    requiredFields: [
      { label: "Treatment name", hint: "The form's * marks are authoritative." },
      { label: "Tax Policy", hint: "The existing policy it belongs to, by name." },
    ],
    optionalFields: [
      { label: "Taxable", hint: "Taxable vs exempt." },
      { label: "Tax Code", hint: "Must match the Tax Rates' code for tax to be found." },
      { label: "Tax Engine", hint: "A taxable treatment needs one for Salesforce to calculate tax." },
      { label: "Legal Entity", hint: "Observed to be needed for invoice-time tax (InvoiceLineTax)." },
      { label: "Use Tax Treatment Items", hint: "Turn on for per-product tax codes." },
    ],
    capabilities: ["Taxable or exempt treatments, with a tax code and engine."],
    extraNotes: ["New treatments start as Draft — activate before setting it as a policy's default."],
    example: "Create a taxable GST18 treatment called GST 18 Taxable on India GST Policy using India Standard Tax Engine.",
  }),

  "tax-treatment-items": {
    title: "AI Prompt Guide — Tax Treatment Item",
    whatItCreates: "Fills the form for one Tax Treatment Item — a product-specific tax code under one Tax Treatment (used when that treatment has Use Tax Treatment Items on). Nothing is created until you validate and click Create.",
    requiredFields: [
      { label: "Item name" },
      { label: "Tax Treatment", hint: "Existing treatment, by name; it must have Use Tax Treatment Items enabled or Create is blocked." },
      { label: "Product", hint: "Existing product, by name — required in this org." },
    ],
    optionalFields: [
      { label: "Tax Code", hint: "Only if you give one." },
      { label: "Product Code", hint: "Say \"Product Code: leave blank\" to keep it empty." },
    ],
    capabilities: [
      "Plain sentences, or one \"Field: value\" per line (e.g. \"Tax Treatment: GST 18 Taxable\") — your own lines win over the AI's reading.",
      TAX_CHAIN,
    ],
    interpretationNotes: [
      NAMES_RESOLVED,
      "A lookup is only resolved for a record you actually named in the prompt — a name the AI supplied on its own is ignored and reported.",
      "Fields the object doesn't have, or that can't be set on create, are reported as notices and never sent.",
      "Needs the Anthropic key from Setup; you can always fill the form manually.",
    ],
    example: { prompt: "Create a tax treatment item named Laptop GST Item under the existing GST 18 Taxable treatment for the existing Laptop product." },
    multipleExample: { label: "Field: value lines", prompt: "Name: Laptop GST Item\nTax Treatment: GST 18 Taxable\nProduct: Laptop\nTax Code: GST18" },
    multipleNote: "This page creates one item. Other operations in the prompt (e.g. \"and activate the treatment\") are listed as not applied — use Taxes → Configure for those. For many products at once, Tax Policies → Bulk Product Assignment creates or reuses each product's item as it assigns the policy.",
    notes: [INVOICE_LINK],
    reviewNote: REVIEW_FORM,
  },

  "tax-rates": objectGuide({
    label: "Tax Rate",
    whatItCreates: "Fills the form for one Tax Rate — what the native Revenue Standard Tax engine looks up by tax code, product code, country/state, legal entity and dates.",
    requiredFields: [
      { label: "Tax Code", hint: "Same code as the treatment / treatment item. Fixed once created." },
      { label: "Rate", hint: "A percentage: 18% → 18." },
      { label: "Geo Country", hint: "Existing Geo Country, by name or ISO code. Fixed once created." },
    ],
    optionalFields: [
      { label: "Geo State", hint: "For state-level rates." },
      { label: "Product Code", hint: "Matched against the product's own Product Code; blank matches every product with this code and geography." },
      { label: "Legal Entity" },
      { label: "Start / End date" },
      { label: "Usage type / basis", hint: "Pre-set to RevCloud / Net — RevCloud is enforced (invoices only match Revenue Cloud rates); Gross is allowed but flagged as unverified." },
    ],
    capabilities: ["Country- or state-level rates, optionally per product and legal entity, with effective dates."],
    extraNotes: [DT_REFRESH, "Changing a rate's tax code or geography later creates a replacement rate."],
    example: "Create an 18% tax rate with tax code GST18 for India, starting today.",
  }),

  "geo-countries": objectGuide({
    label: "Geo Country",
    whatItCreates: "Fills the form for one Geo Country — the country tax rates are keyed by.",
    requiredFields: [
      { label: "Country name" },
      { label: "ISO code", hint: "ISO-2, e.g. IN. Fixed once created." },
    ],
    optionalFields: [{ label: "Description" }],
    capabilities: ["One country with its ISO-2 code."],
    extraNotes: ["Check the list first — the org may already have the country."],
    example: "Create a Geo Country India with ISO code IN.",
  }),

  "geo-states": objectGuide({
    label: "Geo State",
    whatItCreates: "Fills the form for one Geo State / province of an existing Geo Country, for state-level tax rates.",
    requiredFields: [
      { label: "State name" },
      { label: "ISO code", hint: "e.g. KA. Fixed once created." },
      { label: "Geo Country", hint: "Existing country, by name." },
    ],
    optionalFields: [],
    capabilities: ["One state or province under an existing country."],
    example: "Create the Geo State Karnataka (KA) in India.",
  }),

  "legal-entities": objectGuide({
    label: "Legal Entity",
    whatItCreates: "Fills the form for one Legal Entity — the selling company used for treatment selection, tax and accounting.",
    requiredFields: [{ label: "Legal entity name", hint: "The form's * marks are authoritative." }],
    optionalFields: [
      { label: "Company name / status" },
      { label: "Address", hint: "City, state, country." },
    ],
    capabilities: ["One legal entity with its company details and address. Tax Treatments, Tax Rates and Tax Policies with Legal Entity selection can then reference it."],
    example: "Create an active legal entity called Omnicloud India Pvt Ltd based in Hyderabad, India.",
  }),

  /* ───────────── Products → Product Configuration ───────────── */

  productConfiguration: {
    title: "Prompt Guide — Product Configuration",
    whatItCreates: "Shows a product's complete revenue configuration (tax, billing, unit of measure, prices), or prepares a targeted update of only what you ask for, previewed before → after. This prompt is read by built-in rules, not by the AI — no AI key is needed.",
    requiredFields: [
      { label: "A verb", hint: "\"Show / view … configuration of …\" to read; \"Update / change / assign / set …\" to change. \"Create …\" is sent to Products → Create Product." },
      { label: "The product", hint: "By name, code or Id in the prompt (\"Update Laptop and …\") — or open it first with Show configuration." },
    ],
    optionalFields: [
      { label: "Tax Policy", hint: "\"assign the tax policy India GST Policy\" — the keyword first, then the name. Written to Product2.TaxPolicyId." },
      { label: "Billing Policy", hint: "\"assign the billing policy Standard Billing Policy\" — written to Product2.BillingPolicyId." },
      { label: "Unit of Measure", hint: "\"Change the Unit of Measure to Each\" — must exist in the org." },
      { label: "Price", hint: "\"Change the price to 2500\" — the Standard Price Book entry." },
    ],
    capabilities: [
      "Read the product's tax chain (policy → treatment → item → engine) and billing chain in one view.",
      "Change the Tax Policy, Billing Policy, Unit of Measure or price — nothing else on the product is touched.",
    ],
    interpretationNotes: [
      "Names are resolved against the real records in Salesforce; several matching products are listed for you to choose.",
      "A Tax / Billing Treatment, Treatment Item or Tax Engine you mention is verified through the policy, not written to Product2.",
      "A policy mentioned without a name is reported as a blocker instead of being guessed.",
    ],
    example: { prompt: "Update Laptop and assign the tax policy India GST Policy." },
    multipleExample: { label: "Read only", prompt: "Show me the configuration of Laptop" },
    multipleNote: "One product per prompt; several changes (e.g. a tax policy and a price) can be combined in the same update.",
    notes: ["Creating tax records (policies, treatments, rates) happens under Taxes, not here."],
    reviewNote: "Show is read-only. An update is a preview of before → after; Apply asks for confirmation, then the product is re-read from Salesforce to verify. Reading this guide needs no AI key.",
  },
};
