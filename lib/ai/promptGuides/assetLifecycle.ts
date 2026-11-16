/**
 * AI Prompt Guides (components/ai/PromptGuide) + the quick examples shown under the Amendment / Renewal / Cancellation prompt.
 * Every example was checked against the lifecycle prompt parser (lib/assetLifecycle/ai.ts — the built-in rules used when no AI
 * key is configured, which the AI path is a superset of): see assetLifecyclePromptGuide.test.ts. Account, product, contact and
 * company names here are illustrative only — the prompt resolves them against the connected org; Ids are never taken from a prompt.
 */
import type { PromptGuideConfig, PromptGuideExample } from "@/lib/ai/promptGuideConfig";
import type { LifecycleKind } from "@/lib/assetLifecycle/types";

/** Short, clickable examples shown directly under the prompt box (click = fill the prompt). */
export const LIFECYCLE_QUICK_EXAMPLES: Record<LifecycleKind, PromptGuideExample[]> = {
  amend: [
    { label: "Increase quantity", prompt: "Create an amendment for Acme Corporation named Q4 Upsell. Increase Laptop Pro quantity from 2 to 5 effective December 1, 2026." },
    { label: "Reduce + discount", prompt: "Amend the assets for Acme Corporation, reduce Cloud Storage by 2 and apply a 10% discount effective today." },
    { label: "Upgrade", prompt: "Upgrade Laptop Basic to Laptop Pro for Acme Corporation effective today." },
    { label: "Billing frequency", prompt: "Change Cloud Storage to quarterly billing for Acme Corporation effective December 1, 2026." },
  ],
  renew: [
    { label: "Renew 12 months", prompt: "Renew Cloud Storage for Acme Corporation for another 12 months starting December 1, 2026." },
    { label: "Renew with discount", prompt: "Renew Cloud Storage for Acme Corporation for 2 years with a 5% discount." },
    { label: "Negotiated price", prompt: "Renew Laptop Pro for Acme Corporation for 12 months at unit price 95." },
  ],
  cancel: [
    { label: "Cancel today", prompt: "Cancel the Cloud Storage asset for Acme Corporation effective today. Reason: budget cuts." },
    { label: "Future-dated", prompt: "Cancel Laptop Pro for Acme Corporation effective December 31, 2026. Reason: switched vendor." },
    { label: "Terminate", prompt: "Terminate the Support Plan for Acme Corporation on 2026-12-31." },
  ],
};

const BILLING_EXAMPLE = "bill to Jane Doe, billing address 1 Market St, San Francisco, CA 94105, US and shipping same as billing.";

const COMMON_NOTES = [
  "Names are matched against the connected Salesforce org (account → its lifecycle assets → products). Nothing is guessed: an unknown or ambiguous name is listed under \"to resolve\" with the closest matches to pick from.",
  "Record Ids are never accepted from a prompt — use names.",
  "Dates: \"today\", \"tomorrow\", \"December 1, 2026\", \"1 Dec 2026\", \"2026-12-01\" or \"12/01/2026\".",
  "Without an AI key the built-in rules parse the prompt (shown as \"Built-in rules\"); with one, the AI extracts the same fields. Either way you review every field before saving.",
];
const BILLING_OPTIONAL = [
  { label: "Bill-To Contact", hint: "\"bill to Jane Doe\" — matched to one of the account's contacts." },
  { label: "Billing address", hint: "\"billing address 1 Market St, San Francisco, CA 94105, US\"." },
  { label: "Shipping address", hint: "\"ship to …\" or \"shipping same as billing\"." },
];
const REVIEW = "Parse & preview only reads Salesforce to match names and fills the form below — nothing is saved or sent. You review and edit every field, then Save the plan or Save & create in Salesforce (which asks once more). Order activation always asks separately.";
const PREREQS = [
  "The assets were created through Revenue Cloud's order-to-asset lifecycle (an activated order with Asset State Periods).",
  "The org exposes the matching standard action (initiateAmendment / initiateRenewal / initiateCancellation) — see Org readiness on the dashboard.",
  "Your user can create Quotes and Orders in Revenue Cloud.",
];

export const assetLifecyclePromptGuides: Record<LifecycleKind, PromptGuideConfig> = {
  amend: {
    title: "AI Prompt Guide — Amendment",
    whatItCreates: "Fills the amendment form: the account, the assets to change, and per asset a quantity change, price, discount, billing frequency or an upgrade / downgrade / swap, plus the effective date and billing details. Saving creates the amendment quote in Salesforce (initiateAmendment) only after you confirm.",
    requiredFields: [
      { label: "Account", hint: "\"for Acme Corporation\"." },
      { label: "Asset / product", hint: "The product name of the asset to change, e.g. \"Laptop Pro\"." },
      { label: "The change", hint: "\"from 2 to 5\", \"to 5\", \"increase … by 3\", \"reduce … by 2\", \"10% discount\", \"price to 89\", \"quarterly billing\", \"upgrade X to Y\"." },
      { label: "Effective date", hint: "\"effective today\", \"effective December 1, 2026\" — when it's missing you're asked to set it." },
    ],
    optionalFields: [
      { label: "Name", hint: "\"named Q4 Upsell\" — for the app's history." },
      { label: "Contract", hint: "\"contract 00000123\"." },
      ...BILLING_OPTIONAL,
    ],
    capabilities: [
      "Increase or reduce a quantity (the result can't be 0 — use Cancellations).",
      "Set a negotiated unit price or a discount %.",
      "Change the billing frequency (monthly, quarterly, semi-annual, annual).",
      "Upgrade, downgrade or swap to another product (when the org has those APIs, API 66.0+).",
      "Several assets of the same account in one amendment.",
    ],
    interpretationNotes: [
      ...COMMON_NOTES,
      "\"from 2 to 5\" is checked against the quantity Salesforce has now; a mismatch is flagged instead of trusted.",
    ],
    example: LIFECYCLE_QUICK_EXAMPLES.amend[0],
    moreExamples: [
      ...LIFECYCLE_QUICK_EXAMPLES.amend.slice(1),
      { label: "With billing details", prompt: `Amend the assets for Acme Corporation, increase Cloud Storage by 3 effective today, ${BILLING_EXAMPLE}` },
    ],
    reviewNote: REVIEW,
    prerequisites: PREREQS,
    commonErrors: [
      "\"Account not found\" / \"ambiguous\" — pick the right one from the suggestions, or type the exact account name.",
      "\"Asset not found\" — the product isn't among the account's lifecycle assets; check the Assets page.",
      "\"Result 0\" — reducing to zero is a cancellation; use Cancellations.",
    ],
    nextSteps: ["Review the preview, Save & create in Salesforce, then follow the transaction page: quote → price → order → billing readiness → activate (asks separately)."],
  },
  renew: {
    title: "AI Prompt Guide — Renewal",
    whatItCreates: "Fills the renewal form: the account, the assets to renew, the renewal start, term or end date, and optional negotiated prices or discounts. Saving creates the renewal quote in Salesforce (initiateRenewal) only after you confirm.",
    requiredFields: [
      { label: "Account", hint: "\"for Acme Corporation\"." },
      { label: "Asset / product", hint: "\"Renew Cloud Storage …\" — the product name of the asset. Without one, the account's assets are listed for you to pick." },
    ],
    optionalFields: [
      { label: "Term", hint: "\"for another 12 months\", \"for 2 years\" — empty = the asset's renewal term." },
      { label: "Renewal start", hint: "\"starting December 1, 2026\" — empty = the day after the current term." },
      { label: "Discount / price", hint: "\"with a 5% discount\", \"at unit price 95\"." },
      ...BILLING_OPTIONAL,
    ],
    capabilities: [
      "Renew one or several assets of an account.",
      "Set the term in months or years, and the start date.",
      "Negotiated unit price or discount on the renewal lines.",
    ],
    interpretationNotes: [...COMMON_NOTES, "Expired assets need a renewal start of today or later."],
    example: LIFECYCLE_QUICK_EXAMPLES.renew[0],
    moreExamples: [
      ...LIFECYCLE_QUICK_EXAMPLES.renew.slice(1),
      { label: "With billing details", prompt: `Renew Cloud Storage for Acme Corporation for 12 months, ${BILLING_EXAMPLE}` },
    ],
    reviewNote: REVIEW,
    prerequisites: [...PREREQS, "The asset has a renewal term (Term-Defined or Evergreen with renewal settings)."],
    commonErrors: ["\"Not renewable\" — the asset has no renewal term, or is already cancelled.", "A renewal start before today on an expired asset is rejected."],
    nextSteps: ["Review the renewal window in the preview, then Save & create in Salesforce."],
  },
  cancel: {
    title: "AI Prompt Guide — Cancellation",
    whatItCreates: "Fills the cancellation form: the account, the assets to cancel, the cancellation date and a reason. Saving creates the cancellation quote in Salesforce (initiateCancellation) only after you confirm — the asset is never cancelled by just changing its status.",
    requiredFields: [
      { label: "Account", hint: "\"for Acme Corporation\"." },
      { label: "Asset / product", hint: "\"Cancel the Cloud Storage asset …\"." },
      { label: "Cancellation date", hint: "\"effective today\", \"on 2026-12-31\" — a later date is future-effective; when it's missing you're asked to set it." },
    ],
    optionalFields: [
      { label: "Reason", hint: "\"Reason: budget cuts\", \"because …\", \"due to …\"." },
      ...BILLING_OPTIONAL,
    ],
    capabilities: [
      "Full cancellation of one or several assets (initiateCancellation cancels the whole asset).",
      "Immediate or future-dated cancellation.",
      "To cancel only some units, describe an amendment that reduces the quantity instead.",
    ],
    interpretationNotes: [...COMMON_NOTES, "Credits and refunds come from Salesforce's proration and billing configuration — the cancellation quote shows them."],
    example: LIFECYCLE_QUICK_EXAMPLES.cancel[0],
    moreExamples: LIFECYCLE_QUICK_EXAMPLES.cancel.slice(1),
    reviewNote: REVIEW,
    prerequisites: PREREQS,
    commonErrors: ["\"Date after lifecycle end\" — the cancellation date must fall within the asset's current lifecycle."],
    nextSteps: ["Review the preview and the credit Salesforce calculates on the cancellation quote before ordering."],
  },
};
