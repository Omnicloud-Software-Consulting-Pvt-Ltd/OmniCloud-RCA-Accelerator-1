/**
 * Tooltip content (the ⓘ next to labels, rendered by components/help/FieldHelp) for the Asset Lifecycle module —
 * Assets, Amendments, Renewals and Cancellations. Same FieldHelpEntry shape as the app-wide glossary in fieldHelp.ts,
 * kept here because these fields are lifecycle-specific (they map to initiateAmendment / initiateRenewal /
 * initiateCancellation inputs and to lifecycle quote lines), not generic Salesforce fields.
 *
 * Every statement describes what the app actually sends or reads — nothing here promises behavior the code doesn't have.
 */
import type { FieldHelpEntry } from "./fieldHelp";
import type { LifecycleKind } from "@/lib/assetLifecycle/types";

type E = FieldHelpEntry;
const e = (text: string, opts: Omit<E, "text"> = {}): E => ({ text, ...opts });

export const LIFECYCLE_HELP = {
  // ── Account and contract ──
  account: e("The customer account that owns the assets. Only assets created through Revenue Cloud's order-to-asset lifecycle can be amended, renewed or cancelled; accounts that own such assets are listed first.", { example: "Acme Corporation", impact: "Becomes the account on the lifecycle quote and order. Changing it clears the selected assets." }),
  contract: e("Optional. The contract the assets belong to. Choosing one filters the asset list to assets related to it and links the lifecycle quote to that contract.", { format: "A contract of the selected account", impact: "Sent as amendContractId / renewContractId / cancelContractId." }),
  opportunity: e("Optional. An opportunity of the account to link the lifecycle quote to, for pipeline reporting.", { impact: "Set on the lifecycle quote Salesforce creates." }),
  name: e("A name for this transaction in the app's history, so you can find it later. Leave it empty to use the default.", { example: "Acme Q4 upsell" }),

  // ── Assets ──
  assets: e("The assets this transaction changes. Each asset shows an eligibility badge — hover it to see why an asset can't be used or what to watch out for (bundles, usage-based products, dates). Assets from one account only.", { impact: "One lifecycle quote line is created per selected asset." }),
  assetSearch: e("Search by asset name, product name, product code or account name.", { example: "Laptop Pro" }),
  assetState: e("Filter by lifecycle state: Active, Expiring (within 90 days), Expired, Starts in future, Cancelled or Not lifecycle-managed. Renewals start on All states because expired assets can still be renewed."),
  expiresFrom: e("Only show assets whose lifecycle ends on or after this date — useful for finding assets due for renewal.", { format: "Date (YYYY-MM-DD)" }),
  expiresTo: e("Only show assets whose lifecycle ends on or before this date.", { format: "Date (YYYY-MM-DD)" }),
  lifecycleOnly: e("Hide assets that weren't created by Revenue Cloud's order-to-asset flow (no Asset State Periods). Those assets can't be amended, renewed or cancelled through Salesforce's lifecycle actions."),
  contractFilter: e("Optional. Limits the list to assets related to this contract (Asset Contract Relationship, origin order or pricing contract)."),

  // ── Amendment changes ──
  changeMode: e("What kind of change this asset gets. Change = quantity, price, discount, billing frequency, end date or attributes on the same product. Upgrade / Downgrade / Swap replace (part of) the asset with another product.", { impact: "Upgrade, Downgrade and Swap use Salesforce's Transaction Management APIs (API 66.0+) and only appear when your org exposes them." }),
  quantityChange: e("How many units to add (positive) or remove (negative). The result is the asset's current quantity plus this number.", { format: "Whole number, e.g. 3 or -2", example: "+3 turns 5 units into 8", impact: "A result of 0 isn't allowed — use Cancellations to end the asset." }),
  newUnitPrice: e("Optional. A negotiated unit price for the amended line. Leave it empty to keep what Salesforce prices.", { format: "Number in the asset's currency", example: "89.99", impact: "Applied to the amendment quote line; your pricing procedure can still re-price it — check the priced quote." }),
  discount: e("Optional. A line discount percentage on the amended line.", { format: "0–100", example: "10", impact: "Written to the amendment quote line's discount. Hidden when the org's quote line has no writable discount field." }),
  billingFrequency: e("Optional. Change how often this subscription is billed. \"No change\" keeps the current frequency. Not shown for one-time products.", { format: "Values from your org's billing frequency picklist", example: "Quarterly" }),
  newEndDate: e("Optional. A new end date for a Term-Defined asset (extends or shortens the term).", { format: "Date (YYYY-MM-DD), after the effective date" }),
  attribute: e("A configurable attribute of the asset (from its Asset Attributes). Change the value to amend it; leave it as is to keep it.", { impact: "Changed values are written to the amendment line's Quote Line Item Attribute." }),
  quantityGivenUp: e("How many units of the current asset are replaced. Usually the whole quantity; a smaller number keeps the rest of the asset.", { format: "Whole number, 1 up to the current quantity" }),
  replacementProduct: e("The product that replaces the asset. Search the asset's price book and choose a price book entry (selling model).", { impact: "Salesforce links the old and new assets with an Asset Relationship (Upgrade, Downgrade or Swap)." }),
  replacementQuantity: e("How many units of the replacement product the customer gets.", { format: "Whole number ≥ 1", example: "5" }),
  replacementUnitPrice: e("Optional. A negotiated unit price for the replacement product. Empty = the price book entry's price.", { format: "Number", example: "120" }),
  startDateAdjustment: e("Moves the selected subscriptions' start date to the effective date, with no other change (initiateAmendment actionSubtype StartDateAdjustment). Only shown when your org supports it.", { impact: "Not verified against a live org yet — review the quote Salesforce builds before ordering." }),
  addProducts: e("Add new products or add-ons to the account as part of this amendment. Search the asset's price book and pick a selling model.", { impact: "Added as new lines on the amendment quote; they become new assets when the order is activated." }),
  addQuantity: e("How many units of the added product.", { format: "Whole number ≥ 1" }),
  addEndDate: e("End date of the added product. Required for Term-Defined products; leave empty for Evergreen or One-Time.", { format: "Date (YYYY-MM-DD)" }),
  amendEffective: e("The date the amendment takes effect. Salesforce prorates the change from this date to the end of the current term.", { format: "Date (YYYY-MM-DD), within the asset's lifecycle", example: "2026-12-01", impact: "Sent as amendStartDate." }),
  newStartDate: e("The new subscription start date for a start-date adjustment.", { format: "Date (YYYY-MM-DD)", impact: "Sent as amendStartDate with actionSubtype StartDateAdjustment." }),

  // ── Renewal ──
  renewalPrice: e("Optional. A negotiated unit price for the renewal line. Leave empty to renew at what Salesforce prices (the asset's renewal pricing source and uplift).", { format: "Number", example: "95" }),
  renewalDiscount: e("Optional. A discount percentage applied to the renewal quote line after Salesforce builds it.", { format: "0–100", example: "5" }),
  rampRenewal: e("Split the renewal into a group ramp schedule (segments with their own prices). Only available when the org's initiateRenewal accepts rampOptionsDetails (API 67.0+).", { impact: "Sent as rampOptionsDetails on initiateRenewal." }),
  rampSegmentType: e("Yearly = one segment per 12 months. Custom = the duration split into the number of equal segments you enter.", { example: "Yearly" }),
  rampDuration: e("Total length of the ramped renewal in months.", { format: "Whole number ≥ 1", example: "36" }),
  rampSegments: e("How many equal segments a Custom ramp has.", { format: "Whole number ≥ 1", example: "3" }),
  renewalStart: e("Optional. The day the renewal term starts. Empty = Salesforce's default, the day after the current term ends. Required for expired assets (today or later).", { format: "Date (YYYY-MM-DD)", example: "2026-12-01" }),
  renewalTerm: e("Length of the renewal term in months. Empty = the asset's own renewal term.", { format: "Whole number ≥ 1", example: "12" }),
  renewalEnd: e("Optional. An explicit renewal end date; it overrides the term.", { format: "Date (YYYY-MM-DD), after the renewal start", impact: "Sent as renewEndDate." }),

  // ── Cancellation ──
  cancelMode: e("Full cancellation ends the whole asset with Salesforce's initiateCancellation (it has no quantity input). To cancel only some units, use a partial cancellation — an amendment that reduces the quantity."),
  cancelReason: e("Why the customer is cancelling. Kept in the app's audit trail, and written to Salesforce when a reason field is chosen.", { example: "Budget cuts" }),
  reasonField: e("The Salesforce field the reason is written to. The list comes from your org's Describe — writable fields on Quote, Quote Line or Quote Action whose name or label mentions a reason.", { example: "Quote.Cancellation_Reason__c" }),
  cancelDate: e("The date the cancellation takes effect. Today = immediate; a later date = future-effective (the asset stays active until then).", { format: "Date (YYYY-MM-DD)", impact: "Sent as cancelStartDate. Credits and refunds follow your proration and billing configuration." }),

  // ── Billing details ──
  billTo: e("The contact who receives the invoices. Choose one of the account's contacts; search by name or email.", { example: "Jane Doe", impact: "Written to the lifecycle quote and, before activation, to the order's Bill-To Contact." }),
  billingAddress: e("Where invoices are addressed. Pick an address already in Salesforce (the original order, other orders, the account or its contacts) or type it.", { format: "Street, City, State, Postal code, Country", example: "1 Market St, San Francisco, CA, 94105, US", impact: "Tax rates are looked up from this address's country and state." }),
  shippingAddress: e("Where the products or services are delivered. Pick a Salesforce address or type it.", { format: "Street, City, State, Postal code, Country" }),
  shippingSame: e("Use the billing address as the shipping address too."),
} satisfies Record<string, E>;

export type LifecycleHelpKey = keyof typeof LIFECYCLE_HELP;

/** Section (panel) help for the single-page forms and the transaction page. */
export const LIFECYCLE_SECTION_HELP = {
  account: e("Who the transaction is for. The account decides which assets, contracts, opportunities and contacts you can pick below."),
  assets: e("Choose the assets to change. Only eligible assets can be selected; the badge on each asset explains why one isn't eligible."),
  amendChanges: e("What changes on each asset: quantity, price, discount, billing frequency, end date, attributes — or an upgrade, downgrade or swap to another product. You can also add new products."),
  renewPricing: e("Optional negotiated prices or discounts for the renewal, and an optional ramp schedule. Leave prices empty to renew at what Salesforce prices."),
  cancelType: e("Full or partial cancellation, and the reason for it."),
  dates: e("When the change takes effect. Salesforce prorates amounts from this date; the asset's current lifecycle dates are listed underneath for reference."),
  billing: e("Who is billed and where. Salesforce needs a Bill-To Contact, a Billing address and a Shipping address on the order before it can be billed."),
  preview: e("What Salesforce has now next to what you're requesting, plus the exact request the app sends. Estimates here are the app's; Salesforce's priced quote — with proration, credits and tax — is what counts."),
  salesforceRecords: e("The real records Salesforce created for this transaction (quote, order, assets), each with a link to open it in Salesforce."),
  billingReadiness: e("Checks the order before activation: Bill-To Contact, addresses, Billing Policy and Billing Treatment on every order product, and pricing. Anything missing is asked for here — nothing on shared Product configuration changes without your confirmation."),
  lifecycleSteps: e("The Salesforce steps for this transaction, in order. Steps marked \"writes to Salesforce\" change records; activation always asks separately."),
  originalVsChanged: e("The assets as they were before the transaction next to what Salesforce shows now."),
  orgReadiness: e("Whether the connected org has what lifecycle transactions need: the initiateAmendment / initiateRenewal / initiateCancellation actions, the Upgrade / Downgrade / Swap APIs, and the fields this module reads and writes."),
} satisfies Record<string, E>;

export const sectionHelpFor = (kind: LifecycleKind) => ({
  changes: kind === "amend" ? LIFECYCLE_SECTION_HELP.amendChanges : kind === "renew" ? LIFECYCLE_SECTION_HELP.renewPricing : LIFECYCLE_SECTION_HELP.cancelType,
});
