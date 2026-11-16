import type { PromptGuideConfig, PromptGuideExample, PromptGuideField } from "@/lib/ai/promptGuideConfig";
import type { FieldHelpEntry } from "@/lib/help/fieldHelp";
import { generateSchedule } from "./schedule";

/**
 * CENTRAL RAMP HELP — one definition per RAMP page, rendered by the app's existing help components:
 *  · <PromptGuide> (components/ai/PromptGuide.tsx — the same Overview / Required / Optional / Example panel the Product, Bundle,
 *    Billing and Tax forms use), via `rampGuide(key)`;
 *  · <FieldHelp> ⓘ tips next to form labels (same TaxInfoTip as every other form), via `RAMP_FIELD_HELP`.
 * Every statement is about what this app and the connected Salesforce org actually do (verified p10 / p12, API v68) — where Salesforce
 * doesn't support something (group ramp per-segment quantity, compound uplift on lines in some orgs) the text says so.
 */

export type RampHelpKey = "productSetup" | "schedule" | "deal" | "groupDeal" | "executions" | "history";

export interface RampHelp {
  title: string;
  overview: string;
  capabilities: string[];
  required: PromptGuideField[];
  optional: PromptGuideField[];
  prerequisites: string[];
  examples: PromptGuideExample[];
  commonErrors: string[];
  nextSteps: string[];
  /** Notes for the AI prompt on this page (how the prompt is interpreted). */
  aiNotes?: string[];
}

/** Field-level ⓘ help, keyed by the form field. */
export const RAMP_FIELD_HELP: Record<string, FieldHelpEntry> = {
  product: { text: "The Salesforce product to make rampable. Only active products with an active term-defined selling model are listed.", example: "API Access Premium" },
  sellingModel: { text: "The product's term-defined selling model the segment belongs to (ProductRampSegment.ProductSellingModelId).", example: "Term Based - Yearly", impact: "Ramps of this product on this selling model use the segment." },
  segmentType: { text: "How Salesforce splits the term (ProductRampSegment.SegmentType). Values come from this org's picklist.", format: "Yearly · Custom · FreeTrial · Prorated", example: "Yearly" },
  trialDuration: { text: "Length of the free trial — FreeTrial segments only.", format: "Whole number ≥ 1, with Duration Type Months or Days", example: "3 (Months)" },
  scheduleName: { text: "A unique name for this reusable schedule template.", example: "3-year +5% yearly" },
  period: { text: "Segment length. Yearly = Salesforce's anniversary segments (line and group ramps). Monthly / Quarterly / Custom run as group ramps only.", format: "Monthly · Quarterly · Yearly · Custom (n months)", example: "Yearly" },
  segments: { text: "Number of paid segments. If the contract isn't a whole number of periods, the last segment is prorated.", format: "1–60", example: "3" },
  trialMonths: { text: "Optional free-trial segment before the paid ones (priced at 0).", format: "1–24 months", example: "3" },
  upliftMethod: { text: "Standard: each segment's uplift is relative to the base price. Compound: each segment builds on the previous one.", format: "Standard · Compound", example: "Standard", impact: "Sent as RampUpliftType; Salesforce's Price Revision step computes the price." },
  priceChange: { text: "How you describe each segment's price. The app converts it to the uplift % Salesforce takes (UnitPriceUplift).", format: "Percentage · Fixed amount · Price per segment · No change", example: "Percentage per segment" },
  defaultChange: { text: "The change applied to every segment after the first (percent or amount, per the price-change method). Overrides win.", example: "5 (= +5% per year)" },
  basePriceMultiplier: { text: "Multiplies the base price before uplifts — preview and uplift conversion only (Salesforce has no such field).", example: "1" },
  overrides: { text: "Per-segment uplift / price, quantity and discount. Group ramps support the per-segment uplift only.", example: "Segment 3: uplift 10%" },
  dealName: { text: "Your name for this ramp deal (stored in the app; Salesforce gets the segment lines / groups).", example: "Acme API 3-year ramp" },
  account: { text: "Optional filter — narrows the quote search to this account's quotes (Quote Account or Account).", example: "Any Partner Inc" },
  quote: { text: "The Salesforce quote to ramp. Only Draft quotes can be ramped.", example: "Ramp Deal Test · #00000071" },
  quoteLine: { text: "The quote line Salesforce splits into yearly segment lines (they share a RampIdentifier).", impact: "Its own start / end dates define the ramp." },
  quoteLineGroup: { text: "The quote line group that becomes ramp segment 1; Salesforce clones it for each next segment.", impact: "Every line in the group ramps together." },
  contractDates: { text: "The ramp's start and end. A line ramp always uses the quote line's dates; a group ramp uses these.", format: "YYYY-MM-DD", example: "2027-01-01 → 2029-12-31" },
  periodBoundary: { text: "QuoteLineItem.PeriodBoundary set on segment lines that have none (pricing needs one).", format: "Anniversary · AlignToCalendar · DayOfPeriod · LastDayOfPeriod", example: "Anniversary" },
};

/** The schedule example rendered with the app's own engine, so the boundaries shown are exactly what the app generates. */
function scheduleExampleBoundaries(): string[] {
  const p = generateSchedule({ period: "Yearly", customMonths: null, segments: 3, trialMonths: null, priceChange: "percent", defaultChange: 5, upliftMethod: "Standard", basePriceMultiplier: 1, overrides: [] }, { contractStart: "2027-01-01", contractEnd: "2029-12-31", basePrice: 100, baseQuantity: 1 });
  return p.segments.map(s => `${s.name}: ${s.startDate} → ${s.endDate} · uplift ${s.upliftPercent}% (preview ${s.previewUnitPrice} on a base of 100)`);
}

const AI_RESOLVE = "Records you name (product, selling model, account, quote, quote line, group, saved schedule) are looked up in the connected org — the AI never supplies Ids. One match is selected; several or none are listed for you to pick.";
const AI_REVIEW = "The AI only fills this form. It never overwrites a record you already picked without asking, and nothing is saved, created or executed until you do it yourself (each Salesforce write has its own confirmation).";

export const RAMP_HELP: Record<RampHelpKey, RampHelp> = {
  productSetup: {
    title: "Product Ramp Setup",
    overview: "A Product Ramp Segment (ProductRampSegment) tells Salesforce how a product can be split into ramp segments for one of its term-defined selling models. Line ramps (Ramp Deal API) need it: once the product has one, Salesforce shows Product2.CanRamp = true (CanRamp itself can't be set through the API).",
    capabilities: ["Find an eligible product and see its selling models and existing segments.", "Create one Product Ramp Segment for a product + term-defined selling model + segment type.", "Describe it in plain language and let the AI fill the form."],
    required: [{ label: "Product", hint: "Active, with an active term-defined selling model." }, { label: "Selling Model", hint: "One of the product's TermDefined selling models (ProductSellingModelId)." }, { label: "Segment Type", hint: "From this org's picklist: Yearly, Custom, FreeTrial, Prorated." }, { label: "Trial Duration + Duration Type", hint: "Required only when Segment Type is FreeTrial." }],
    optional: [],
    prerequisites: ["The product is active and has an active TermDefined selling model option.", "The product isn't usage-based (usage products can't be ramped).", "Your user can create ProductRampSegment records (the page shows when the org doesn't expose the object)."],
    examples: [{ label: "Example", prompt: "Create yearly ramp segments for API Access Premium using its Term-Based Yearly selling model.", details: ["Creates: one ProductRampSegment (Product = API Access Premium, Selling Model = Term-Based Yearly, Segment Type = Yearly).", "Salesforce verifies: the product + selling model exist and the values are valid; the app checks for a duplicate right before inserting and reads the record back with the product's CanRamp.", "Next: create a Draft quote with that product, then build a Ramp Deal on its line."] }],
    commonErrors: ["\"No active term-defined selling model\" — add a TermDefined Product Selling Model Option to the product first.", "\"Segment already exists\" — the existing segment is reused, nothing new is created.", "CanRamp still false after creation — Salesforce sets it; check the selling model on the segment."],
    nextSteps: ["Ramp Schedules — save a reusable schedule.", "Ramp Deals — ramp a quote line of this product."],
    aiNotes: ["\"yearly ramp segments\" → Segment Type Yearly; \"30-day free trial\" → FreeTrial, 30 Days.", "Contract length and period belong to the schedule / deal — the AI shows them but doesn't put them on the segment."],
  },
  schedule: {
    title: "Ramp Schedules",
    overview: "A Ramp Schedule is a reusable template of segments: how long each segment is, how many there are, an optional free trial, and how the price changes (uplift). Salesforce has no schedule object — a schedule becomes Salesforce data only when a ramp deal applies it (segment lines or ramped quote line groups).",
    capabilities: ["Yearly, quarterly, monthly or custom-length segments.", "A free trial before the paid segments.", "Percentage, fixed-amount or per-segment price changes, Standard or Compound uplift.", "Per-segment quantity, discount and uplift overrides.", "Live preview of every segment's dates and uplift."],
    required: [{ label: "Schedule Name", hint: "Unique per org." }, { label: "Period", hint: "Monthly, Quarterly, Yearly or Custom." }, { label: "Number of Segments", hint: "1–60 paid segments (the contract length = segments × period, plus any trial)." }, { label: "Months per segment", hint: "Only for a Custom period." }],
    optional: [{ label: "Description" }, { label: "Free Trial", hint: "1–24 months, priced at 0." }, { label: "Uplift Method", hint: "Standard (default) or Compound." }, { label: "Price Change + Default Uplift", hint: "Defaults to +5% per segment in a new schedule; set No change for a flat ramp." }, { label: "Base Price Multiplier", hint: "Defaults to 1." }, { label: "Per-Segment Overrides", hint: "Uplift / price, quantity, discount." }],
    prerequisites: ["Contract dates that cover whole periods (otherwise the last segment is prorated).", "A period the deal type supports: line ramps are Yearly only; group ramps take any period.", "Compound uplift needs a pricing procedure ready for it (IsCompoundUpliftEnabled in its Price Revision step)."],
    examples: [{ label: "Example", prompt: "Create a 3-year yearly schedule with 3 segments, no free trial, and 5% uplift per segment.", details: ["Generated segments for a 2027-01-01 start (Standard uplift is relative to the base price):", ...scheduleExampleBoundaries()] }],
    commonErrors: ["\"The contract produces N paid segments\" — the dates don't match the segment count; adjust either.", "\"Custom periods need a whole number of months\" — set Months per segment.", "Duplicate schedule name — names are unique per org."],
    nextSteps: ["Apply the schedule to a Ramp Deal or Group Ramp Deal."],
    aiNotes: ["\"3-year yearly\" → Yearly × 3 segments (inferred).", "Period boundary is a deal setting, not part of a schedule — the AI tells you instead of saving it."],
  },
  deal: {
    title: "Ramp Deals",
    overview: "A Ramp Deal splits ONE quote line into yearly segment lines with Salesforce's Ramp Deal API (they share a RampIdentifier), sets each segment's quantity, discount and uplift, re-prices the quote and verifies what Salesforce saved.",
    capabilities: ["Pick the account, Draft quote and quote line (eligibility is checked live).", "Apply a saved schedule or edit one inline, with a segment preview.", "Save a draft, then execute it with confirmation — resumable and verified."],
    required: [{ label: "Deal Name" }, { label: "Quote", hint: "A Draft quote." }, { label: "Quote Line", hint: "Eligible: term-defined, not usage-based, product has a Product Ramp Segment, not already ramped." }, { label: "Schedule", hint: "Yearly period + number of segments (saved or inline)." }],
    optional: [{ label: "Account", hint: "Narrows the quote search." }, { label: "Saved schedule", hint: "Or configure the schedule inline." }, { label: "Base quantity / Per-segment overrides" }, { label: "Period Boundary", hint: "Defaults to Anniversary." }, { label: "Free trial" }],
    prerequisites: ["A Draft quote with an eligible quote line.", "The line's product has a Product Ramp Segment for the line's selling model (CanRamp = true).", "Line ramps use Yearly segments; Compound uplift on lines needs RampUpliftType writable on QuoteLineItem (otherwise use a group ramp).", "The pricing procedure applies ramp uplifts (its Price Revision step maps UnitPriceUplift / RampUpliftType)."],
    examples: [{ label: "Example", prompt: "Create a 3-year ramp deal on API Access Premium with yearly segments and 5% standard uplift.", details: ["Draft: saved in the app only — nothing changes in Salesforce.", "Execute (confirmed): ramp-deal-create → Place Sales Transaction commits the segment lines → segment quantity / discount / uplift updated → quote re-priced with pricingPref Force.", "Verification: segment count, dates, uplift, NetUnitPrice saved, CalculationStatus and LastPricedDate after the request are read back from Salesforce."] }],
    commonErrors: ["\"Quote isn't Draft\" — ramps are added to Draft quotes only.", "\"Line already ramped\" — it has a RampIdentifier.", "Prices calculated but not saved — LastPricedDate didn't move; the run reports it as not verified.", "UNKNOWN_EXCEPTION on commit — often a stale Price Book Entry decision table; refresh it in Salesforce, then Retry."],
    nextSteps: ["Watch the run in the Ramp Execution Center.", "Check the segment prices in the run's verification table."],
    aiNotes: ["\"the selected quote\" uses the quote picked in the form.", "The product you name picks the quote line; several matches are listed, never auto-picked.", "A line ramp always keeps the line's own dates."],
  },
  groupDeal: {
    title: "Group Ramp Deals",
    overview: "A Group Ramp ramps every line of a Quote Line Group together with Salesforce's group ramp APIs: the group becomes ramp segment 1 (QuoteLineGroup.IsRamped = true), Salesforce clones it (Clone Sales Transaction) for each next segment, and each segment group gets its dates, uplift and uplift method. A Line Ramp, by contrast, splits ONE quote line into yearly segment lines; a group ramp moves several products together, supports monthly / quarterly / custom segments and Compound uplift — it is never a set of independent line ramps.",
    capabilities: ["Start from an existing Draft quote or create a new one (confirmed, read back).", "Select an existing Quote Line Group or create one; add products to it (confirmed, read back).", "Live eligibility diagnostics from Salesforce: quote, group state, existing ramps and their RampIdentifiers, every line, pricing readiness.", "Monthly, quarterly, yearly or custom segments with Standard or Compound uplift per segment.", "Resumable execution with read-back verification of every segment group and line."],
    required: [
      { label: "Account", hint: "Required to create a new quote; filters existing Draft quotes." },
      { label: "Quote", hint: "A Draft quote — existing, or created here (Quote Name + Price Book)." },
      { label: "Quote Line Group", hint: "Not a ramp segment and not already holding a ramp schedule — existing, or created here (Group Name)." },
      { label: "Eligible Quote Line Items", hint: "At least one line in the group: term-defined selling model, product rampable (Product Ramp Segment), active, not already ramped." },
      { label: "Ramp Schedule", hint: "Contract start / end, period, number of segments (saved schedule or inline)." },
      { label: "Salesforce configuration", hint: "Group ramps enabled (QuoteLineGroup.IsRamped / SegmentType writable) and an active default pricing procedure." },
    ],
    optional: [{ label: "Opportunity", hint: "Quote.OpportunityId is optional in p10 / p12." }, { label: "Expiration Date / Quote Start Date" }, { label: "Group Description / Parent Group" }, { label: "Saved schedule", hint: "Or configure the schedule inline." }, { label: "Uplift method + default uplift + per-segment uplift", hint: "Standard by default; Compound where the org supports it." }, { label: "Free trial" }],
    prerequisites: [
      "Group Ramp enabled in Revenue Settings — the app checks QuoteLineGroup.IsRamped / SegmentType / RampUpliftType are writable (p10: not writable; p12: writable).",
      "An eligible Draft Quote with a Price Book (needed to add products).",
      "A Quote Line Group that isn't already a ramp segment or a ramp's parent.",
      "Eligible subscription products: active, term-defined selling model with a Price Book Entry in the quote's price book, a Product Ramp Segment (CanRamp). Usage (Anchor) products: line ramps refuse them, but Salesforce has group-ramped them in p12 — shown as a warning.",
      "Salesforce pricing configuration: an active default pricing procedure whose Price Revision step applies UnitPriceUplift / RampUpliftType (Compound needs IsCompoundUpliftEnabled).",
      "The supported transaction APIs: Place Sales Transaction (groupRampAction EditGroup / EditRampSchedule) and Clone Sales Transaction.",
      "One ramp schedule per quote: the dev guide says a quote can contain a single ramp schedule, and Salesforce refuses EditGroup once the quote has one (\"You can’t convert a group to a ramped segment when the quote has a ramp schedule\"). p12 quote #40 holds two, so some orgs allow it — the app warns and Salesforce decides.",
    ],
    examples: [{ label: "Example workflow", prompt: "Create a 3-year Group Ramp on the selected Quote Line Group with yearly segments.", details: [
      "1. Select the Account.",
      "2. Create or select a Draft Quote (a new quote is created only after you confirm, then read back with its Id and Quote Number).",
      "3. Create or select a Quote Line Group.",
      "4. Add products to the group (confirmed; each line uses the Price Book Entry of its selling model and is read back).",
      "5. Validate eligibility — the diagnostics panel reads the quote, group, lines and pricing setup from Salesforce.",
      "6. Configure the Group Ramp (AI prompt or manual): contract dates, period, segments, uplift.",
      "7. Preview the segments.",
      "8. Execute (confirmed): EditGroup (once — converts the group into segment 1) → Clone Sales Transaction of the last segment, per new segment → EditRampSchedule (dates, if needed) → EditRampSchedule (uplift + method on every segment) → Force pricing.",
      "9. Verify Salesforce results: segment groups (IsRamped), one RampIdentifier per product across segments, contiguous dates, uplift, saved prices and LastPricedDate.",
    ] }],
    commonErrors: [
      "No Quote Line Groups — the quote has none yet; create one in step 3.",
      "No Quote Line Items — the group is empty; add products in step 4.",
      "Already ramped — the group is a ramp segment or holds a ramp schedule; use View Existing Ramp instead of creating a duplicate.",
      "Unsupported product — inactive, not term-defined, or without a Product Ramp Segment (CanRamp = false). A usage-based product is refused by Salesforce if its usage model can't be ramped.",
      "Missing Selling Model — the line has no term-defined selling model, or the price book has no entry for it.",
      "Pricing Procedure unavailable — no active default pricing procedure, or its Price Revision step lacks the uplift mappings.",
      "Stale Decision Tables — Salesforce returns UNKNOWN_EXCEPTION; refresh the Price Book Entry decision table in Salesforce, then Retry.",
      "Salesforce transaction failure (e.g. GroupRampConfigurationFailed) — the step shows Salesforce's own response; fix it and Retry (completed steps aren't repeated).",
    ],
    nextSteps: ["Watch the run in the Ramp Execution Center.", "Check the segment prices in the run's verification table."],
    aiNotes: ["\"the selected quote line group\" uses the group picked in the form; a quote with several groups is never auto-picked.", "Per-segment quantity and period boundary from the prompt are removed — a group ramp sets uplift and discount per segment group (QuoteLineGroup.UnitPriceUplift / Discount); each line keeps its own quantity."],
  },
  executions: {
    title: "Ramp Execution Center",
    overview: "Every ramp runs server-side one checkpointed step at a time: Validate → Stage (line: ramp-deal-create) / Convert group → Commit or Clone segments → Segment values → Read back → Price (Force) → Verify. Each step is saved, so a closed tab or server restart never loses progress.",
    capabilities: ["Resume an interrupted run — completed steps are not repeated.", "Retry a failed step — it re-reads Salesforce before writing again.", "See every Salesforce request/response and the verification table."],
    required: [],
    optional: [],
    prerequisites: ["A saved ramp deal whose execution was started with confirmation."],
    examples: [{ label: "Lifecycle", prompt: "Validate → Stage → Commit → Segment values → Read back → Price → Verify", details: ["Calculated prices are not necessarily persisted prices: a run is only Completed when LastPricedDate moved after the price request and NetUnitPrice is saved on every segment.", "Waiting = Salesforce is still processing asynchronously; the run keeps checking."] }],
    commonErrors: ["Interrupted — the run stopped mid-step; Retry re-reads Salesforce first.", "Failed at Commit — read the Salesforce response in the step (e.g. a stale decision table).", "Failed at Verify — Salesforce saved different values than expected; the table shows expected vs actual."],
    nextSteps: ["Open Ramp History for the full audit trail."],
  },
  history: {
    title: "Ramp History",
    overview: "The persistent audit trail of everything RAMP did in this org: schedules, deals, product segments, executions, pricing and verification — stored server-side per org (not in the browser), with the Salesforce Ids each action produced.",
    capabilities: ["Filter by type, result, dates, text or Salesforce Id.", "Open an event to see its Salesforce requests, responses and inputs."],
    required: [],
    optional: [],
    prerequisites: ["Durable storage on hosted deployments (RAMP_DATA_DIR) — otherwise the page warns that history can be lost on redeploy."],
    examples: [{ label: "Statuses", prompt: "success · failed · info", details: ["success — the action completed; for executions and pricing that means the values were read back from Salesforce and verified.", "failed — the event detail holds Salesforce's own error.", "info — recorded without a pass/fail outcome (e.g. a draft saved, pricing still processing — not verified).", "Salesforce Ids link straight to the record in your org; search by any Id to find every event that touched it."] }],
    commonErrors: ["Empty history after a redeploy — the store isn't durable; set RAMP_DATA_DIR."],
    nextSteps: ["Open the execution from the Execution Center to resume or retry."],
  },
};

/** The page's guide in the shared <PromptGuide> shape (Overview / Required / Optional / Prerequisites / Example / Errors). */
export function rampGuide(key: RampHelpKey): PromptGuideConfig {
  const h = RAMP_HELP[key];
  const [example, second, ...more] = h.examples;
  return {
    title: `${h.title} — Help`,
    whatItCreates: h.overview,
    requiredFields: h.required,
    optionalFields: h.optional,
    capabilities: h.capabilities,
    interpretationNotes: h.aiNotes ? [...h.aiNotes, AI_RESOLVE] : [],
    example,
    multipleExample: second,
    moreExamples: more,
    prerequisites: h.prerequisites,
    commonErrors: h.commonErrors,
    nextSteps: h.nextSteps,
    reviewNote: h.aiNotes ? AI_REVIEW : "Reading this help needs no AI key and never calls Salesforce.",
  };
}
