import type { PromptGuideConfig } from "@/lib/ai/promptGuideConfig";

/**
 * Prompt guides for the Revenue Cloud Billing workspaces that have their own AI prompt
 * (separate from the generic billing Create workspace, which uses `promptGuideConfig.billing`).
 *
 * Same honesty rules as lib/ai/promptGuideConfig.ts: every claim below was traced through the
 * AI route (app/api/billing/...), the server interpretation/resolution layer (lib/billing/server/...)
 * and what the workspace does with the result. None of these AI routes write to Salesforce —
 * they only fill a form or propose steps that the user reviews and confirms.
 */

const NO_KEY_NOTE = "Reading this guide needs no AI key — only the Analyze button calls the AI (it uses the Anthropic key from Setup).";

export const billingPromptGuides: Record<string, PromptGuideConfig> = {
  /* POST /api/billing/assignments/ai → analyzeAssignmentPrompt → checkAssignment (lib/billing/server/assignment.ts) */
  assignPolicy: {
    title: "AI Prompt Guide — Assign Billing Policy",
    whatItCreates: "Nothing new is created. The AI picks out a Product and a Billing Policy by name, both are looked up in Salesforce, and the same assignment check as the manual form runs. Assigning only updates the Product's Billing Policy field.",
    requiredFields: [
      { label: "Product", hint: "Name or Product Code exactly as it appears in Salesforce, e.g. \"the Keyboard product\"." },
      { label: "Billing Policy", hint: "The name of an existing Billing Policy, e.g. \"Keyboard Monthly Billing Policy\"." },
    ],
    optionalFields: [],
    capabilities: [
      "One assignment per prompt: link one existing Product to one existing Billing Policy.",
    ],
    interpretationNotes: [
      "Names are looked up in Salesforce (exact name/code first, then a contains-search). One match is selected; several matches or none are shown for you to pick with the lookups.",
      "A partial match is selected but flagged so you can confirm it is the right record.",
      "The policy chain is checked live: the policy needs a Default Billing Treatment with a valid Treatment Item. An inactive policy or treatment blocks the assignment; a Draft one only warns.",
      "If the product already has a different Billing Policy, the AI never overwrites it. You get a conflict prompt and must confirm the replacement yourself.",
    ],
    example: { prompt: "Assign the Keyboard Monthly Billing Policy to the Keyboard product." },
    multipleNote: "One prompt handles one Product and one Billing Policy. To assign more products, run it again for each one.",
    notes: [
      "To assign one policy to MANY products, use Billing Policies → Bulk Product Assignment (its own page, no AI key needed): it lists only products without a Billing Policy, never overwrites one, and verifies the policy's shared Billing Treatment Item.",
      "The AI never creates products, policies or treatments. Create them first in the Billing Policies or Products workspaces.",
      "Assignment needs the org to have a Product field that references Billing Policy and needs your user to be able to update it. Otherwise the check is blocked.",
    ],
    reviewNote: `The AI's output is a suggestion: you review the selected records and validation checks, then click Assign before anything is written to Salesforce. ${NO_KEY_NOTE}`,
  },

  /* POST /api/billing/credit-memos/ai → analyzeCreditPrompt; then /validate and POST /api/billing/credit-memos (lib/billing/server/creditMemos.ts) */
  creditMemo: {
    title: "AI Prompt Guide — Credit Memo",
    whatItCreates: "Fills in the credit memo form: which invoice, how much to credit, an optional invoice line, and a reason. The credit memo is created only after you review the validated preview and confirm.",
    requiredFields: [
      { label: "Invoice number", hint: "The invoice's document number as shown in Salesforce, e.g. \"invoice DOC-… for Acme\". It must be a Posted invoice." },
      { label: "Credit amount", hint: "A number greater than zero. You can say \"the full amount of the <product> line\" instead, and the line's creditable amount is used." },
    ],
    optionalFields: [
      { label: "Invoice line", hint: "A product/line name on that invoice, e.g. \"the Keyboard line\". The whole amount then goes to that line. Without one, the amount is spread across the invoice lines automatically." },
      { label: "Reason", hint: "Your words for why. Goes into the Description field." },
    ],
    capabilities: [
      "Credit a Posted invoice by an amount, or credit one named line in full.",
      "Add a short reason for the credit.",
    ],
    interpretationNotes: [
      "The invoice is looked up by its exact document number in Salesforce. A record Id, a number with no match, or a number with several matches is not used, and you choose the invoice yourself.",
      "Line names are matched against the invoice's real lines. If several lines or none match, the line is left for you to pick.",
      "Line Ids or allocations the AI produces are ignored. Allocations are always computed from the real invoice lines.",
    ],
    example: { prompt: "Credit the Keyboard line of invoice DOC-… for Acme by 5 because one unit arrived damaged." },
    multipleExample: { label: "Full line credit", prompt: "Credit the full amount of the Wireless Mouse line on invoice DOC-…." },
    multipleNote: "One prompt fills one credit memo for one invoice. A single named line gets the whole credit. Use the manual allocation table to split it across several lines.",
    notes: [
      "Tax strategy and effective date are not read from the prompt. Set them in the form (they default to the org's first tax strategy and today).",
      "Creating credit memos requires Credit Memo permissions for your Salesforce user. If they're missing, the preview shows it as a failed check.",
    ],
    reviewNote: `The AI's output is a suggestion: it only fills the form, and you review the validated preview and confirm before anything is written to Salesforce. ${NO_KEY_NOTE}`,
  },

  /* POST /api/billing/debit-memos/interpret → interpretDebitPrompt → resolveDebitDraft; then /validate and POST /api/billing/debit-memos (lib/billing/server/debitMemos.ts, debitMemoLifecycle.ts) */
  debitMemo: {
    title: "AI Prompt Guide — Debit Memo",
    whatItCreates: "Turns your request into a debit memo draft (an extra charge billed to a customer): account, optional invoice reference, charge lines, and how far to take it through billing. You review and edit the draft, then confirm before it is created.",
    requiredFields: [
      { label: "Account", hint: "The customer's Account name, unless you name an invoice, in which case the invoice's account is used." },
      { label: "Amount", hint: "A total, or one amount per charge line. Without an amount the draft asks for one." },
    ],
    optionalFields: [
      { label: "Invoice number", hint: "References a Posted invoice of the same account, e.g. \"invoice DOC-…\"." },
      { label: "Charge lines", hint: "One line per charge, each with a description and optionally a product, quantity and unit price. Products are looked up in Salesforce by name." },
      { label: "Reason", hint: "Why the customer is being charged." },
      { label: "Currency", hint: "Must match the org's billing currency. A different currency is rejected, not converted." },
      { label: "How far to go", hint: "Draft (default), post it, bill it in the next billing cycle, or also collect payment." },
      { label: "Next billing date", hint: "Only used if you state a date." },
    ],
    capabilities: [
      "An additional charge for an account, split into several lines (e.g. installation plus premium support).",
      "Optionally linking the charge to an existing Posted invoice and to existing products.",
      "Choosing the target lifecycle: draft, posted, invoiced, or settled.",
    ],
    interpretationNotes: [
      "Accounts, invoices and products are resolved by name/number in Salesforce. Several matches are listed for you to pick; no match is flagged as an issue. Ids the AI produces are ignored.",
      "Nothing is guessed: unknown amounts, quantities, prices or dates stay blank for you to fill in.",
      "Requests that aren't additional charges (refunds, credits, questions) are rejected with an explanation.",
    ],
    example: { prompt: "Create a debit memo for Acme Corporation for ₹10,000 consisting of ₹6,000 installation and ₹4,000 premium support." },
    multipleExample: { label: "Against an invoice, then post it", prompt: "Charge Acme Corporation an extra 500 for expedited shipping on invoice DOC-…, and post it." },
    multipleNote: "One prompt creates one debit memo, which can have several charge lines.",
    notes: [
      "Lifecycle steps past Draft run only after the debit memo is created, one Salesforce step at a time. Steps such as starting a billing run or creating a payment ask for your confirmation first.",
      "The org bills in a single currency. A request in a different currency is flagged, not converted.",
    ],
    reviewNote: `The AI's output is a suggestion: it fills an editable draft, and you review and validate it in Salesforce, then confirm before anything is written. ${NO_KEY_NOTE}`,
  },

  /* POST /api/billing/ai/analyze with { moduleKey, recordId } → analyzeBillingEdit (lib/billing/server/ai.ts); save via PATCH /api/billing/[module]/[id] */
  editRecord: {
    title: "AI Prompt Guide — Edit Billing Record",
    whatItCreates: "Proposes changes to the record you opened (fields, lookups, and linked records such as products). The changes fill the edit form below. The record is updated only when you save.",
    requiredFields: [
      { label: "The change you want", hint: "e.g. \"set Status to Active\" or \"use the Standard Monthly Treatment as the default treatment\"." },
    ],
    optionalFields: [
      { label: "Related records by name", hint: "Lookups such as a default treatment or policy are resolved in Salesforce by name. Unresolved names are left for you to pick." },
      { label: "Links to add or remove", hint: "e.g. \"link this policy to the Keyboard product\". Only links this record supports are used." },
    ],
    capabilities: [
      "Changing updateable fields, including picklists (using the org's real values).",
      "Changing lookups by naming the related record.",
      "Adding or removing linked records (e.g. products that use this billing policy).",
    ],
    interpretationNotes: [
      "Only fields you ask to change are touched. Fields that are locked, read-only, or don't exist in this org are dropped with a warning.",
      "Salesforce status rules are respected. For example, a record can't go back to Draft, and a Treatment Item can't be edited once its treatment is no longer Draft. Such changes are explained in warnings, not applied.",
      "The edit always applies to the record you opened. Any other record Id from the AI is ignored.",
    ],
    example: { prompt: "Set this billing policy to Active and use the Standard Monthly Treatment as the default treatment." },
    multipleNote: "One prompt edits the one record you opened. To edit child records (e.g. treatment items), open each one and edit it there.",
    notes: [
      "The AI can't create new child records from the edit prompt. Use the create action for that.",
    ],
    reviewNote: `The AI's output is a suggestion: review the requested changes and validation, then click Save Changes before anything is written to Salesforce. ${NO_KEY_NOTE}`,
  },

  /* POST /api/billing/orders/[id]/ai → analyzeOrderBillingPrompt (lib/billing/server/orderBillingAi.ts); each step runs via the existing guarded endpoints */
  orderSetup: {
    title: "AI Prompt Guide — Order Billing Plan",
    whatItCreates: "Turns your instruction into an ordered list of billing steps for this order (setup, billing details, activate, schedules, invoice, post, refresh). Nothing runs automatically. You click Run on each step.",
    requiredFields: [
      { label: "At least one billing step", hint: "e.g. \"set up billing\", \"activate the order\", \"create billing schedules\", \"generate the invoice\", \"post the invoice\"." },
    ],
    optionalFields: [
      { label: "Bill To Contact", hint: "A contact name, matched only against this order's Account contacts." },
      { label: "Which address", hint: "Your words for which address on file to use, matched against the addresses Salesforce already has for the account." },
    ],
    capabilities: [
      "Applying Order Actions and Billing Treatments to the order products.",
      "Setting the Bill To Contact and billing/shipping address from existing records.",
      "Activating the order, requesting billing schedules, generating and posting the invoice, and refreshing status.",
    ],
    interpretationNotes: [
      "Each step is checked against the order's live state. Steps that can't run yet (e.g. activate before setup is complete) are shown with the reason, and their Run button is disabled.",
      "Contact and address wording only selects existing records. If several or none match, you pick in Billing Details.",
      "Anything outside the fixed step list is listed as ignored rather than attempted.",
    ],
    example: { prompt: "Bill the account's primary contact at their billing address, set up billing, activate the order and generate the invoice." },
    notes: [
      "The AI doesn't change products, quantities, prices or amounts on the order. Only the listed billing steps are supported.",
      "Activating the order and posting an invoice still ask for confirmation in their own dialogs.",
    ],
    reviewNote: `The AI's output is a suggested plan: you run each step yourself, through the same validation as the buttons, before anything is written to Salesforce. ${NO_KEY_NOTE}`,
  },

  /* POST /api/billing/payments/ai → analyzePaymentPrompt → validatePayment; record via POST /api/billing/payments (lib/billing/server/payments.ts) */
  recordPayment: {
    title: "AI Prompt Guide — Record Payment",
    whatItCreates: "Fills in the payment form: invoice, amount, date, payment method and comments. The payment is created and applied to the invoice only after you review the validated preview and confirm.",
    requiredFields: [
      { label: "Invoice number", hint: "The invoice's document number, e.g. \"invoice DOC-… for Acme\". The invoice must be able to accept payment." },
    ],
    optionalFields: [
      { label: "Amount", hint: "Defaults to the invoice's outstanding balance. \"Full balance\" works too. It can't exceed the balance." },
      { label: "Payment date", hint: "Defaults to today. Invalid dates are ignored with a warning." },
      { label: "Payment method", hint: "Must match exactly one active Payment Method in the org by name or type. Otherwise it is left blank with a warning." },
      { label: "Comments", hint: "Free text for the payment." },
    ],
    capabilities: [
      "A payment against one invoice, for a specific amount or the full balance, with a date, method and comments.",
    ],
    interpretationNotes: [
      "The invoice is looked up by its exact document number in Salesforce. Record Ids and unmatched numbers are not used, and you pick the invoice instead.",
      "Status and Type are not read from the prompt. They use the org's defaults, which you can change in the form.",
      "Line allocations from the AI are ignored. Allocation is computed against the invoice's real lines.",
    ],
    example: { prompt: "Record a payment of 250 against invoice DOC-… for Acme, paid by bank transfer today." },
    multipleNote: "One prompt records one payment against one invoice.",
    notes: [
      "Applying payments requires the Payment-related permission sets for your Salesforce user. If they're missing, the preview shows it as a failed check.",
    ],
    reviewNote: `The AI's output is a suggestion: it only fills the form, and you review the validated preview and confirm before anything is written to Salesforce. ${NO_KEY_NOTE}`,
  },

  /* Same POST /api/billing/payments/ai; settle via POST /api/billing/payments with level "lines" (lib/billing/server/payments.ts) */
  settlePayment: {
    title: "AI Prompt Guide — Settle Payment",
    whatItCreates: "Fills in the settlement form: invoice, amount, date, payment method, and whether you want to split the amount across lines yourself. A Payment is created and applied to the invoice's lines only after you review and confirm.",
    requiredFields: [
      { label: "Invoice number", hint: "The invoice's document number, e.g. \"invoice DOC-… for Acme\"." },
    ],
    optionalFields: [
      { label: "Amount", hint: "Defaults to the invoice's outstanding balance. \"Full outstanding amount\" works too." },
      { label: "Payment date", hint: "Defaults to today." },
      { label: "Payment method", hint: "Must match exactly one active Payment Method in the org by name or type." },
      { label: "Manual allocation", hint: "Say you want to split it across specific lines yourself to open the allocation table. Otherwise the amount is spread automatically." },
    ],
    capabilities: [
      "Settle an invoice for its full outstanding amount or a partial amount, allocated to its real invoice lines.",
    ],
    interpretationNotes: [
      "The invoice is looked up by its exact document number in Salesforce. Record Ids and unmatched numbers are not used.",
      "The AI never sets per-line amounts. You enter those in the allocation table if you chose manual allocation.",
      "Status and Type use the org's defaults.",
    ],
    example: { prompt: "Settle invoice DOC-… for Acme for the full outstanding amount." },
    multipleExample: { label: "Partial, split manually", prompt: "Settle 100 of invoice DOC-… and let me split it across the lines myself." },
    multipleNote: "One prompt settles one invoice.",
    notes: [
      "Comments from the prompt aren't used in the settlement form.",
      "Settlement requires Payment permissions for your Salesforce user. If they're missing, the form shows settlement as unavailable.",
    ],
    reviewNote: `The AI's output is a suggestion: it only fills the form, and you review the validated preview and confirm before anything is written to Salesforce. ${NO_KEY_NOTE}`,
  },

  /* POST /api/billing/ai/analyze (no moduleKey) → identifyBillingModule → analyzeBillingPrompt; opens the Create workspace preview */
  dashboard: {
    title: "AI Prompt Guide — AI Billing Assistant",
    whatItCreates: "Works out which billing object you want to create (billing policy, treatment, usage resource, rate card, payment term…), extracts its fields, and opens a reviewable preview in the Create workspace.",
    requiredFields: [
      { label: "What to create", hint: "Name the billing concept clearly, e.g. \"Create a billing policy…\". If the AI can't tell which object you mean, it asks you to rephrase." },
    ],
    optionalFields: [
      { label: "Field values", hint: "Status, names, picklist choices. Only fields that exist in this org are kept, and values are checked against its real picklists." },
      { label: "Related records by name", hint: "Products, policies, units of measure, etc. are looked up in Salesforce by name." },
      { label: "Child records", hint: "e.g. treatment items under a treatment, or rate card entries under a rate card." },
    ],
    capabilities: [
      "Billing policies, treatments and treatment items; billing rules; milestone plans; payment terms; legal entities (whichever your org lets you create).",
      "Usage billing: usage resources, units of measure, aggregation and rating frequency policies, rate cards and tiers.",
    ],
    interpretationNotes: [
      "The prompt is routed to one billing object that your org lets you create. The rest of the flow is the same as the Create workspace's AI prompt.",
      "Names are resolved against Salesforce. One match is selected; several or none are left for you to pick. Ids from the AI are rejected.",
    ],
    example: { prompt: "Create a usage-based billing configuration for Cloud Backup where customers are charged per GB consumed." },
    multipleNote: "One prompt creates one parent record plus its child records. For a second, unrelated object, run the assistant again.",
    notes: [
      "Billing Schedules and Invoices are generated by Salesforce from activated orders and can't be created from a prompt.",
      "Credit memos, debit memos, invoice payments/settlement and policy-to-product assignment have their own workspaces with their own AI prompts, which resolve invoices and lines more precisely.",
    ],
    reviewNote: `The AI's output is a suggestion: review the preview (resolved records, validation, assumptions) before you click Create, and nothing is written to Salesforce until then. ${NO_KEY_NOTE}`,
  },
};
