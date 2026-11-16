/**
 * Asset Lifecycle — Assets, Amendments, Renewals and Cancellations on Salesforce Revenue Cloud (Agentforce Revenue Management).
 *
 * Data model (read from a Revenue Cloud org's Describe, API v68, 2026-11-11 — every read is still Describe-guarded at runtime):
 *  · Asset: HasLifecycleManagement, CurrentQuantity, CurrentMrr, CurrentAmount, TotalLifecycleAmount, LifecycleStartDate,
 *    LifecycleEndDate / CurrentLifecycleEndDate, ParentId / RootAssetId (bundles), RenewalTerm / RenewalTermUnit,
 *    DoesAutomaticallyRenew, PricingSource, UnitPriceUplift.
 *  · AssetAction (Type Generate | Change | Cancel | Convert; CategoryEnum Initial Sale | Upsells | Downsells | Renewals | Cancellations
 *    | Upgrades | Downgrades | Swaps …; Subtype UpgradeFrom/To, DowngradeFrom/To, SwapIn/Out, FieldAmendment, StartDateAdjustment …)
 *    → AssetActionSource (ReferenceEntityItemId = the OrderItem, ProductSellingModelId, PricebookEntryId, prices, dates).
 *  · AssetStatePeriod (Quantity, UnitPrice, Discount, BillingFrequency, Mrr, Amount, PricingContractId per period).
 *  · AssetContractRelationship (AssetId, ContractId, StartDate, EndDate). AssetAttribute (attribute values of the asset).
 *  · BillingScheduleGroup.ReferenceEntityId = the Asset (billing schedules, CancellationDate, billed / pending amounts).
 *  · Standard invocable actions initiateAmendment / initiateRenewal / initiateCancellation → { <kind>RecordId, requestIdentifier
 *    (AsyncOperationTracker, JobType PearAmendQtyAssets / PearRenewAssets / PearCancelAssets) }; createOrderFromQuote (quoteRecordId).
 *  · The lifecycle quote's lines carry QuoteAction (Type Amend | Renew | Cancel, Subtype, SourceAssetId); orders carry OrderAction;
 *    Quote / Order.OriginalActionType = Amend | Renew | Cancel.
 */

export type LifecycleKind = "amend" | "renew" | "cancel";
export const LIFECYCLE_KINDS: LifecycleKind[] = ["amend", "renew", "cancel"];
export const KIND_LABEL: Record<LifecycleKind, string> = { amend: "Amendment", renew: "Renewal", cancel: "Cancellation" };
/** The standard invocable action that starts each lifecycle. */
export const INITIATE_ACTION: Record<LifecycleKind, string> = { amend: "initiateAmendment", renew: "initiateRenewal", cancel: "initiateCancellation" };
/** QuoteAction / OrderAction Type and Quote / Order OriginalActionType written by Salesforce for each lifecycle. */
export const ACTION_TYPE: Record<LifecycleKind, string> = { amend: "Amend", renew: "Renew", cancel: "Cancel" };

export type StepId = "initiate" | "await-quote" | "apply-changes" | "price" | "validate" | "create-order" | "prepare-billing" | "activate" | "verify";
/** "needs-input": the step stopped for a decision only the user can make (e.g. which Billing Policy a product gets) — see billingNeeds. */
export type StepStatus = "pending" | "in-progress" | "waiting" | "needs-input" | "completed" | "failed" | "skipped";

export interface SfCall { at: string; method: string; path: string; request?: unknown; status: number; response: unknown }

export interface LifecycleStep {
  id: StepId; label: string; writes: boolean; status: StepStatus; message: string | null;
  startedAt: string | null; finishedAt: string | null; calls: SfCall[];
}

/** Why an asset can / can't take part in a lifecycle transaction. Errors block; warnings inform. */
export interface AssetReason { code: string; severity: "error" | "warning"; message: string }

export interface SellingModelInfo { id: string; name: string | null; type: string | null; pricingTerm: number | null; pricingTermUnit: string | null }
export interface AssetContractLink { id: string; number: string | null; status: string | null; startDate: string | null; endDate: string | null; source: "relationship" | "order" | "pricing" }
/** A lifecycle quote in Salesforce that references the asset and has no order yet (a second transaction would duplicate it). */
export interface OpenTransaction { quoteId: string; quoteNumber: string | null; status: string | null; type: string | null }
export interface AssetAttributeValue { id: string; definitionId: string | null; name: string | null; value: string | null; picklistValueId: string | null }

/** Facts about one Salesforce asset, read server-side from the connected org. */
export interface AssetFacts {
  id: string; name: string; accountId: string | null; accountName: string | null;
  productId: string | null; productName: string | null; productCode: string | null;
  hasLifecycle: boolean; lifecycleActions: number;
  lastAction: { type: string | null; category: string | null; subtype: string | null; date: string | null } | null;
  quantity: number | null; mrr: number | null; currentAmount: number | null; totalAmount: number | null;
  lifecycleStart: string | null; lifecycleEnd: string | null; status: string | null;
  parentId: string | null; rootId: string | null; childIds: string[];
  sellingModel: SellingModelInfo | null;
  unitPrice: number | null; discount: number | null; billingFrequency: string | null; startDate: string | null; endDate: string | null;
  pricebookEntryId: string | null; pricebookId: string | null;
  originOrder: { id: string; number: string | null; contractId: string | null } | null;
  contracts: AssetContractLink[];
  usage: { usageBased: boolean; reason: string | null };
  renewal: { term: number | null; termUnit: string | null; autoRenew: boolean | null; pricingSource: string | null; uplift: number | null };
  open: OpenTransaction[];
}

/** Lifecycle state derived from Salesforce values (quantity, lifecycle dates). */
export type AssetState = "active" | "expiring" | "expired" | "future" | "cancelled" | "unmanaged";

export interface AssetRow extends AssetFacts { state: AssetState; eligibility: Record<LifecycleKind, AssetReason[]> }

/** Snapshot of an asset's ORIGINAL values when the transaction was planned (for original-vs-changed review and verification). */
export interface AssetSnapshot {
  id: string; name: string; productId: string | null; productName: string | null; quantity: number | null; unitPrice: number | null; discount: number | null; mrr: number | null;
  sellingModelType: string | null; sellingModelName: string | null; billingFrequency: string | null; startDate: string | null; endDate: string | null;
  lifecycleEnd: string | null; parentId: string | null; childIds: string[]; usageBased: boolean; pricebookId: string | null;
  attributes: AssetAttributeValue[];
}

/**
 * Replacement of an asset through Salesforce's dedicated Transaction Management APIs (API 66.0+):
 * POST /revenue/transaction-management/assets/actions/{upgrade|downgrade|swap} — outGroup = the asset (and quantity) given up,
 * inGroup = the new QuoteLineItem. Salesforce creates the amendment quote with the linked quote action subtypes itself.
 */
export type SwapKind = "upgrade" | "downgrade" | "swap";
export interface AssetSwap { kind: SwapKind; productId: string; productName: string; pricebookEntryId: string; quantity: number; unitPrice?: number | null; billingFrequency?: string | null; endDate?: string | null; /** Quantity of the CURRENT asset given up (default: all of it). */ outQuantity?: number | null }
export interface AttributeChange { definitionId: string; name: string; value: string; picklistValueId?: string | null }

/** What the user asked to change on one selected asset. Amendments use every field; renewals use the price / discount only. */
export interface AssetChange {
  assetId: string;
  /** Amendments: delta (+2 adds two units, −1 removes one). */
  quantityChange: number;
  /** New (negotiated) unit price on the lifecycle line — Salesforce pricing may still re-price it; the read-back shows what it kept. */
  unitPrice?: number | null;
  /** Line discount (%). */
  discount?: number | null;
  billingFrequency?: string | null;
  endDate?: string | null;
  swap?: AssetSwap | null;
  attributes?: AttributeChange[];
}

export interface AddedProduct { productId: string; productName: string; pricebookEntryId: string; quantity: number; unitPrice?: number | null; billingFrequency?: string | null; startDate?: string | null; endDate?: string | null }

export interface RampOptions { segmentType: "Yearly" | "Custom"; durationInMonths: number; segmentCount: number | null }
export interface RenewalOptions { endDate: string | null; termMonths: number | null; ramp: RampOptions | null }
export interface ReasonField { object: "Quote" | "QuoteLineItem" | "QuoteAction" | "Order"; field: string; label: string; type: string; options: string[] }
export interface CancelOptions { reason: string | null; reasonField: ReasonField | null }

export type TransactionStatus = "draft" | "in-progress" | "waiting" | "needs-input" | "failed" | "completed";

/** A postal address as Salesforce stores it on Quote / Order (Billing* / Shipping* fields). */
export interface PostalAddress { street: string | null; city: string | null; state: string | null; postalCode: string | null; country: string | null }
/**
 * Who is billed and where — chosen on the form (or from the prompt / the asset's original order). Written to the lifecycle quote
 * (Quote.BillToContactId + Billing/Shipping address) and to the order before activation (Order.BillToContactId + addresses).
 */
export interface BillingDetails {
  billToContactId: string | null; billToContactName: string | null;
  billingAddress: PostalAddress | null; shippingAddress: PostalAddress | null;
  /** Where the values came from ("Original order 00000110", "Account billing address", "Entered") — shown, never trusted for writes. */
  source: string | null;
}
/** A Billing Policy the user chose (and confirmed) for a product that has none — written to Product2.<billing policy field> by the step. */
export interface PolicyResolution { productId: string; productName: string; policyId: string; policyName: string; previousPolicyId: string | null; confirmedAt: string; appliedAt: string | null }
/** A Billing Treatment the user chose (and confirmed) for an order product Salesforce couldn't resolve — written to OrderItem.BillingTreatmentId. */
export interface TreatmentResolution { orderItemId: string; productName: string; policyId: string | null; treatmentId: string; treatmentName: string; confirmedAt: string; appliedAt: string | null }
export interface BillingResolutions { policies: PolicyResolution[]; treatments: TreatmentResolution[] }
/** Something billing readiness can't decide alone. Only the user resolves it — with a real Salesforce record — then execution resumes. */
export interface BillingNeed {
  kind: "billing-policy" | "billing-treatment" | "bill-to" | "billing-address" | "shipping-address";
  message: string;
  product: { id: string; name: string } | null;
  orderItemIds: string[];
  /** For billing-treatment needs: the product's Billing Policy (eligible treatments belong to it). */
  policy: { id: string; name: string } | null;
}
/** One automatic billing-readiness action, as it happened (shown as progress on the transaction page). */
export interface BillingLogEntry { at: string; action: string; detail: string; ok: boolean }

export interface SalesforceRefs {
  requestIdentifier: string | null; quoteId: string | null; quoteNumber: string | null; orderId: string | null; orderNumber: string | null;
  initiatedAt: string | null; activatedAt: string | null; priceRequestedAt: string | null; orderRequestedAt: string | null;
  initiatedQuantityChange: number | null;
  /** Line changes sent (Place Sales Transaction) and not yet confirmed by a read-back — never re-sent while Salesforce saves them. */
  changesSentAt?: string | null;
  /** Billing readiness: order re-pricing requested (Place Sales Transaction Force on the Order) and how often in this transaction. */
  orderPriceRequestedAt?: string | null;
  orderRepriceCount?: number;
  /** Last time billing readiness changed the order / its products, and whether that came after the last confirmed re-pricing. */
  billingChangedAt?: string | null;
  billingDirty?: boolean;
  /** Fingerprint of the BillingDetails last written to the order / quote (never re-written while unchanged). */
  orderBillingHash?: string | null;
  quoteBillingHash?: string | null;
}

/** One amendment / renewal / cancellation — the plan, its Salesforce records and every step's outcome (server-side, per org). */
export interface LifecycleTransaction {
  id: string; kind: LifecycleKind; orgId: string; createdBy: string | null; createdAt: string; updatedAt: string; name: string;
  accountId: string; accountName: string | null;
  contractId: string | null; contractNumber: string | null;
  opportunityId: string | null; opportunityName: string | null;
  /** Amendment start / cancellation date / renewal start (renewals: optional — empty = Salesforce's default, the day after the term). */
  effectiveDate: string;
  /** Amendments only: initiateAmendment actionSubtype (StartDateAdjustment) when the org supports it. */
  amendSubtype: "StartDateAdjustment" | null;
  assets: AssetSnapshot[];
  changes: AssetChange[];
  adds: AddedProduct[];
  renewal: RenewalOptions | null;
  cancel: CancelOptions | null;
  status: TransactionStatus;
  steps: LifecycleStep[];
  sf: SalesforceRefs;
  /** Read-back checks from the last validate / verify step. */
  checks: VerificationCheck[];
  /** Bill-To Contact + Billing / Shipping address for the quote and order. */
  billing?: BillingDetails | null;
  /** User decisions for billing readiness (confirmed in the app; applied — and read back — by the prepare-billing step). */
  billingResolutions?: BillingResolutions;
  /** Open decisions that stopped billing readiness (empty when none). */
  billingNeeds?: BillingNeed[];
  /** What billing readiness did, in order. */
  billingLog?: BillingLogEntry[];
}

/** `required: false` = informational (shown, never blocks — e.g. billing that only exists when Revenue Cloud Billing is configured). */
export interface VerificationCheck { id: string; label: string; ok: boolean; detail: string; required?: boolean }

export interface AuditEvent { id: string; at: string; transactionId: string | null; kind: LifecycleKind | null; userId: string | null; action: string; status: "success" | "failed" | "info"; summary: string; refs: Record<string, string | null | undefined> }
