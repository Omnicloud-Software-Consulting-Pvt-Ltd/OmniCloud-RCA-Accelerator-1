/**
 * Shared domain types for the Order / OrderItem authoring module — the
 * Order-side counterpart of lib/quotes/types.ts. Reuses every Quote/QLI
 * type that is genuinely object-agnostic (bundle discovery/expansion,
 * product catalog, selling model, attributes, billing) directly; only
 * types that differ because Order's own field schema/lifecycle differs
 * from Quote's are redefined here (see the Order/OrderItem master prompt §0).
 */

import type { FieldRef } from "@/lib/salesforce/describe";
import type {
  CatalogProduct,
  QuoteLineItemDraft,
  NativeBundleMechanism,
  PricingModel,
  BundleExpansionResult,
  BundleExpansionDiagnostics,
  SellingModelResolution,
  BillingFrequencyResolution,
  SubscriptionTermResolution,
  BillingTreatmentValidation,
  ProductAttribute,
  BundleHierarchyStep,
} from "@/lib/quotes/types";

export type { FieldRef } from "@/lib/salesforce/describe";

/* ── Order field schema ── */

export interface PicklistFieldRef extends FieldRef {
  options: { value: string; label: string }[];
  defaultValue: string | null;
}

export interface OrderFieldSchema {
  accountField: FieldRef | null;
  pricebookField: FieldRef | null;
  contractField: FieldRef | null;
  effectiveDateField: FieldRef | null;
  statusField: PicklistFieldRef | null;
  typeField: PicklistFieldRef | null;
  poNumberField: FieldRef | null;
  poDateField: FieldRef | null;
  descriptionField: FieldRef | null;
  /** Only populated if this org's Order schema actually has a lookup back to Quote (§3.7) — never fabricated. */
  sourceQuoteField: FieldRef | null;
  /** Whether Type's describe metadata marks Contract as conditionally required (heuristic: a validation-rule-shaped dependency cannot be introspected directly, so this reflects whatever is discoverable — see resolveOrderFieldSchema). */
  contractRequiredForContractedType: boolean;
}

export interface OrderListFieldSchema {
  orderNumberField: FieldRef | null;
  totalAmountField: FieldRef | null;
  accountRelationshipField: FieldRef | null;
  pricebookRelationshipField: FieldRef | null;
  contractRelationshipField: FieldRef | null;
}

/* ── Order Status / activation resolution (§2.9, §3.6) ── */

export interface OrderStatusResolution {
  statusField: PicklistFieldRef | null;
  /** The org's own picklist value semantically matching "not yet activated" (label/semantic match, never the hardcoded literal "Draft"). */
  draftValue: string | null;
  /** The org's own picklist value semantically matching "activated" (never the hardcoded literal "Activated"). */
  activatedValue: string | null;
  /** Present only if the org's active values suggest a further "cancelled"/"deactivated" transition exists. */
  cancelledValue: string | null;
}

export type OrderMutabilityStatus = "mutable" | "blocked" | "inconclusive";

export interface OrderMutabilityCheck {
  status: OrderMutabilityStatus;
  currentStatus: string | null;
  reason: string;
}

export interface OrderActivationResult {
  success: boolean;
  attemptedTransition: { from: string | null; to: string } | null;
  message: string;
  /** The org's own rejection text when Salesforce refuses the transition — never a guessed alternate mechanism. */
  salesforceError: string | null;
}

/* ── Order CRUD ── */

export interface OrderFormData {
  accountName: string;
  pricebookName: string;
  effectiveDate: string;
  status: string;
  contractName: string;
  type: string;
  poNumber: string;
  poDate: string;
  description: string;
  sourceQuoteName: string;
}

export interface ReferenceLookupResult {
  id: string;
  name: string;
}

export interface OrderCreateResult {
  id: string;
  orderNumber: string | null;
  resolvedLookups: { account: ReferenceLookupResult | null; pricebook: ReferenceLookupResult | null; contract: ReferenceLookupResult | null; sourceQuote: ReferenceLookupResult | null };
  payload: Record<string, unknown>;
  steps: BundleHierarchyStep[];
  warnings: string[];
}

export interface OrderListItem {
  id: string;
  orderNumber: string | null;
  totalAmount: number | null;
  status: string | null;
  accountName: string | null;
  pricebookName: string | null;
  contractName: string | null;
  lastModifiedDate: string;
  lineItemCount: number | null;
}

export interface OrderDetail {
  id: string;
  orderNumber: string | null;
  record: Record<string, unknown>;
  accountId: string | null;
  pricebookId: string | null;
  contractId: string | null;
  status: string | null;
  mutability: OrderMutabilityCheck;
}

/* ── OrderItem / OrderItemAttribute field schemas ── */

export interface OrderItemFieldSchema {
  orderField: FieldRef | null;
  productField: FieldRef | null;
  pricebookEntryField: FieldRef | null;
  quantityField: FieldRef | null;
  unitPriceField: FieldRef | null;
  /** Whether UnitPrice is actually createable/updateable in this org — a field can resolve (exist) but still be non-writable (e.g. calculated by a pricing engine). Payload building must gate on this, not just on unitPriceField being non-null. */
  unitPriceWritable: boolean;
  listPriceField: FieldRef | null;
  discountField: FieldRef | null; // null in orgs that never extended OrderItem with Revenue Cloud's Discount field (§4.6) — degrade to quantity/list-price-only math
  totalPriceField: FieldRef | null;
  /** Whether TotalPrice (aka "Product Subtotal") is createable/updateable — the fallback write target when UnitPrice isn't writable. Standard OrderItem requires one of UnitPrice/TotalPrice at create time. */
  totalPriceWritable: boolean;
  sellingModelOptionField: FieldRef | null;
  billingFrequencyField: FieldRef | null;
  subscriptionTermField: FieldRef | null;
  rootItemField: FieldRef | null; // self-reference fallback mechanism
  parentItemField: FieldRef | null;
  pricingModel: PricingModel;
}

export interface OrderItemAttributeFieldSchema {
  objectName: string | null;
  orderItemField: FieldRef | null;
  attributeField: FieldRef | null;
  valueField: FieldRef | null;
}

/* ── OrderItemRelationship (independent discovery from QuoteLineRelationship, §5.1) ── */

export interface OrderItemRelationshipFieldSchema {
  mechanism: NativeBundleMechanism;
  objectName: string | null;
  mainOrderItemField: FieldRef | null;
  associatedOrderItemField: FieldRef | null;
  relatedComponentField: FieldRef | null;
  quantityScaleMethodField: FieldRef | null;
  relationshipTypeField: FieldRef | null;
  pricingInclusionField: FieldRef | null;
  requiredFieldsNotMapped: FieldRef[];
}

/* ── Order-side repricing (§6.2) — mirrors RepricingSummary/RepricingLineResult but keyed by orderItemId, since Order's Connect REST repricing action is a distinct capability from Quote's. ── */

export interface OrderRepricingLineResult {
  orderItemId: string;
  netUnitPrice: number | null;
  netTotalPrice: number | null;
  listPrice: number | null;
  discount: number | null;
  written: boolean;
}

/** §Do not truncate: the complete Salesforce error for one failed repricing candidate path — same shape as the Quote side's RepricingAttemptError. */
export interface OrderRepricingAttemptError {
  path: string;
  status: number | null;
  errorCode: string | null;
  message: string;
  fields: string[] | null;
  rawBody: unknown;
}

export interface OrderRepricingSummary {
  attempted: boolean;
  succeeded: boolean;
  isConfigurationIssue: boolean;
  message: string | null;
  lines: OrderRepricingLineResult[];
  attemptErrors: OrderRepricingAttemptError[];
}

/* ── Order line item draft tree — identical shape to Quote's (§8: "thin type alias") ── */

export type OrderLineItemDraft = QuoteLineItemDraft;

export interface OrderProductConfigurationResult {
  product: CatalogProduct;
  attributes: ProductAttribute[];
  bundle: BundleExpansionResult | null;
  /** Always populated, even when `bundle` is null (not detected as a bundle) — the whole point is to explain why. */
  bundleDiagnostics: BundleExpansionDiagnostics;
  sellingModel: SellingModelResolution;
  billingFrequency: BillingFrequencyResolution | null;
  subscriptionTerm: SubscriptionTermResolution | null;
  billingTreatment: BillingTreatmentValidation | null;
  requiresConfiguration: boolean;
  requiresConfigurationReasons: string[];
}

/* ── Existing OrderItems (edit/delete view) ── */

export interface ExistingOrderItem {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  listPrice: number;
  discount: number;
  totalPrice: number;
  parentDraftId: string | null;
  rootItemId: string | null;
  parentItemId: string | null;
  children: ExistingOrderItem[];
}

export type RefreshedOrderItem = ExistingOrderItem;

/* ── OrderItem bundle-hierarchy creation trace / errors (§5.2) ── */

export interface OrderLineItemCreationError {
  message: string;
  code: string | null;
  path: string[] | null;
}

export interface OrderLineItemRollbackDetail {
  attempted: boolean;
  records: { sobject: string; ids: string[] }[];
}

export interface OrderLineItemFailureDetail {
  currentStep: string;
  validationRule: string;
  reason: string;
  missingField: string | null;
  invalidValue: unknown;
  salesforceObject: string | null;
  orderId: string;
  productId: string | null;
  productName: string | null;
  pricebookEntryId: string | null;
  sellingModel: unknown;
  billingFrequency: unknown;
  bundle: unknown;
  attributes: unknown;
  relationshipFields: unknown;
  generatedPayload: unknown;
  validationErrors: string[];
  rollback: OrderLineItemRollbackDetail;
  lastSuccessfulStep: string | null;
}

export interface OrderLineItemCreationResult {
  success: boolean;
  createdIds: string[];
  createdCount: number;
  bundleHierarchyValid: boolean;
  issues: string[];
  steps: BundleHierarchyStep[];
  repricing: OrderRepricingSummary | null;
  errors: OrderLineItemCreationError[];
  refreshedLineItems: RefreshedOrderItem[];
  failureDetail: OrderLineItemFailureDetail | null;
}
