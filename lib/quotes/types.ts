/**
 * Shared domain types for the Quote / Quote Line Item authoring module.
 * Every service, API route, and UI component imports from here so the
 * client and server can never silently disagree about a shape.
 */

import type { FieldRef } from "@/lib/salesforce/describe";
export type { FieldRef } from "@/lib/salesforce/describe";

/* ── Generic field/reference resolution ── */

export type ReferenceFieldStatus = "idle" | "checking" | "valid" | "invalid";

export interface ReferenceFieldState {
  status: ReferenceFieldStatus;
  query: string;
  resolvedId: string | null;
  resolvedName: string | null;
}

export type ReferenceObjectType = "Account" | "Pricebook2" | "Opportunity" | "Contact" | "User" | "Quote" | "Contract" | "Order";

/* ── Quote field schema ── */

export interface PicklistFieldRef extends FieldRef {
  options: { value: string; label: string }[];
  defaultValue: string | null;
}

export interface QuoteFieldSchema {
  nameField: FieldRef | null;
  accountField: FieldRef | null;
  pricebookField: FieldRef | null;
  opportunityField: FieldRef | null;
  startDateField: FieldRef | null;
  expirationDateField: FieldRef | null;
  descriptionField: FieldRef | null;
  statusField: PicklistFieldRef | null;
}

export interface QuoteListFieldSchema {
  quoteNumberField: FieldRef | null;
  grandTotalField: FieldRef | null;
  accountRelationshipField: FieldRef | null;
  opportunityRelationshipField: FieldRef | null;
  pricebookRelationshipField: FieldRef | null;
}

/* ── Quote CRUD ── */

export interface QuoteFormData {
  name: string;
  accountName: string;
  pricebookName: string;
  opportunityName: string;
  startDate: string;
  expirationDate: string;
  status: string;
  description: string;
}

export interface QuoteCreateResult {
  id: string;
  finalName: string;
  requestedName: string;
  wasVersioned: boolean;
  resolvedLookups: { account: ReferenceLookupResult | null; pricebook: ReferenceLookupResult | null; opportunity: ReferenceLookupResult | null };
  payload: Record<string, unknown>;
  /** Step-by-step trace (metadata resolution, field/createable checks, reference lookups, payload build, SF create call) for the client to replay verbatim into the execution log (§Issue 4). */
  steps: BundleHierarchyStep[];
  /** Fields that resolved but were excluded from the payload (e.g. not createable in this org) — surfaced so a missing field is never a silent mystery. */
  warnings: string[];
}

export interface ReferenceLookupResult {
  id: string;
  name: string;
}

export interface QuoteListItem {
  id: string;
  name: string;
  quoteNumber: string | null;
  grandTotal: number | null;
  status: string | null;
  accountName: string | null;
  opportunityName: string | null;
  pricebookName: string | null;
  lastModifiedDate: string;
  lineItemCount: number | null;
}

export interface QuoteDetail {
  id: string;
  name: string;
  record: Record<string, unknown>;
  accountId: string | null;
  pricebookId: string | null;
  opportunityId: string | null;
}

/* ── Product catalog ── */

export interface CatalogProduct {
  id: string;
  name: string;
  productCode: string | null;
  description: string | null;
  family: string | null;
  pricebookEntryId: string;
  listPrice: number;
  isBundleCandidate: boolean;
}

export interface ProductNameMatch {
  product: CatalogProduct;
  confidence: number;
  matchType: "exact" | "substring" | "fuzzy";
}

/* ── Selling model ── */

export type SellingModelType = "OneTime" | "Evergreen" | "TermDefined" | "Unknown";

export interface SellingModelOption {
  id: string;
  name: string;
  sellingModelId: string;
  isDefault: boolean;
  isActive: boolean;
  requiresBillingFrequency: boolean;
  type: SellingModelType;
}

export interface SellingModelResolution {
  productId: string;
  pricebookEntryId: string | null;
  pricebookEntrySellingModelId: string | null; // the specific selling model PricebookEntry.ProductSellingModelId points at, when that field exists
  options: SellingModelOption[];
  chosen: SellingModelOption | null;
  chosenReason: "pricebook-entry-linked" | "default-active" | "requires-frequency" | "first-active" | "first-returned" | "none" | null;
}

/* ── Product attributes ── */

export type AttributeDataType =
  | "Picklist" | "Multipicklist" | "Checkbox" | "Number" | "Currency" | "Percent" | "Date" | "Datetime" | "Text";

export interface AttributeOption {
  value: string;
  label: string;
}

export interface ProductAttribute {
  id: string;
  attributeId: string;
  name: string;
  category: string | null;
  dataType: AttributeDataType;
  required: boolean;
  defaultValue: string | null;
  priceImpacting: boolean;
  sequence: number;
  options: AttributeOption[] | null;
}

/* ── Bundle discovery + expansion ── */

export interface BundleObjectDiscovery {
  relationshipObject: string | null; // e.g. ProductRelatedComponent (2+ refs to Product)
  groupObject: string | null;        // e.g. ProductComponentGroup (exactly 1 ref to Product)
  groupOverrideObject: string | null; // refs both groupObject and Product
  relationshipFields: {
    parentProductField: FieldRef | null;
    childProductField: FieldRef | null;
    groupField: FieldRef | null;
    relationshipTypeField: FieldRef | null;
    pricingInclusionField: FieldRef | null; // "does the parent's price include this child" flag
    pricingInclusionKind: "boolean" | "picklist" | null;
    pricingInclusionIncludedValue: string | null;
    pricingInclusionNotIncludedValue: string | null;
    quantityField: FieldRef | null;
    isDefaultField: FieldRef | null; // e.g. IsDefaultComponent — only meaningful for narrowing a CHOICE within a group
    isRequiredField: FieldRef | null; // e.g. IsComponentRequired
  } | null;
  groupFields: {
    parentProductField: FieldRef | null;
    minField: FieldRef | null;
    maxField: FieldRef | null;
    nameField: FieldRef | null;
  } | null;
  groupOverrideFields: {
    groupField: FieldRef | null;
    productField: FieldRef | null; // the bundle instance this override applies to
    minField: FieldRef | null;
    maxField: FieldRef | null;
  } | null;
  diagnostics: BundleDiscoveryDiagnostics;
}

/**
 * §Discount pricing investigation — evidence-only discovery of whatever
 * object (if any) this org uses to represent a manual, line-level price
 * adjustment (Salesforce Revenue Cloud's "Percentage-Based (Line-Level)"
 * adjustment shown in Calculation Details) as a DISTINCT related record,
 * separate from the standard QuoteLineItem.Discount field. Discovered the
 * same way bundle relationship/group objects are (via the target object's
 * own `childRelationships` — never a guessed API name), and used PURELY for
 * diagnostics/logging — this app's actual fix routes the discount through
 * the standard, already-persisted Discount field plus Salesforce's own
 * documented Instant Pricing repricing call (see lib/quotes/pricing/
 * reprice.ts), never by writing to a guessed object. If a real, distinct
 * adjustment object DOES exist in a given org and repricing alone doesn't
 * reproduce the manual-UI result, this evidence is what a future fix would
 * build on — never fabricated meanwhile.
 */
export interface QuoteLineAdjustmentDiscovery {
  objectName: string | null;
  quoteLineItemField: FieldRef | null;
  percentField: FieldRef | null;
  amountField: FieldRef | null;
  valueField: FieldRef | null;
  typeField: FieldRef | null;
  typePercentageValue: string | null;
  levelField: FieldRef | null;
  levelLineValue: string | null;
  diagnostics: {
    candidatesConsidered: string[];
    candidatesDescribed: string[];
    candidatesFailed: string[];
    reason: string;
    /** Every field of the chosen candidate object (or, if none was chosen, of every candidate considered) — apiName/label/type/createable/updateable/calculated, exactly as Describe reported it. Never summarized away. */
    fieldEvidence: { objectName: string; apiName: string; label: string; type: string; createable: boolean; updateable: boolean; calculated: boolean }[];
  };
}

/** §Investigation Required: exactly what the discovery pass considered and why it landed on (or failed to find) a relationship/group object — surfaced so "why isn't this bundle detected" is answerable without re-deriving it from scratch. */
export interface BundleDiscoveryDiagnostics {
  candidatesConsidered: string[];
  candidatesDescribed: string[];
  candidatesFailed: string[];
  /** Candidate object name -> number of DIRECT reference fields to Product2 (the shape heuristic this app classifies relationship-vs-group objects by). */
  referenceCountsToProduct2: Record<string, number>;
  relationshipObjectChosen: string | null;
  groupObjectChosen: string | null;
  reason: string;
  /**
   * Every {childSObject, field} pair from Product2's OWN Describe
   * `childRelationships` metadata — the authoritative, name-independent
   * list of every object+field with a direct foreign key to Product2.
   * `candidatesConsidered` is derived FROM this, never from a global
   * object-name pattern scan (§Do not infer the relationship from object names).
   */
  product2ChildRelationships: { childSObject: string; field: string }[];
}

/**
 * §Inspect the actual API calls being made: one real, product-scoped query
 * per {object, field} pair Product2's own relationship metadata says COULD
 * be a parent link, run only when normal expansion found zero children —
 * exactly the data needed to determine which object Salesforce's own
 * Product Structure page is actually backed by, empirically, rather than
 * guessing from names.
 */
export interface BundleCandidateQueryDiagnostic {
  object: string;
  fieldQueried: string; // the field the WHERE clause filtered on, treating it as the "parent" role for this probe
  soql: string;
  whereClause: string;
  parentProductId: string;
  rowCount: number; // -1 if the query itself failed (see reason logged server-side)
  relationshipIds: string[];
  returnedProduct2Ids: string[]; // values of this SAME object's OTHER Product2-referencing field(s), across returned rows
}

export type PricebookResolutionStatus = "resolved" | "missing";

export interface BundleComponentGroupInfo {
  id: string;
  name: string;
  min: number | null; // confirmed minimum (override-adjusted); null = unresolved/inconclusive
  max: number | null;
  minSource: "override" | "group" | "unresolved";
}

export interface BundleComponent {
  productId: string;
  product: CatalogProduct | null; // null only if the product record itself couldn't be batch-resolved
  relationshipId: string;
  groupId: string | null;
  group: BundleComponentGroupInfo | null;
  relationshipTypeId: string | null;
  isDefault: boolean;
  isRequired: boolean;
  quantity: number;
  pricingInclusion: boolean; // parent bundle price already includes this child
  pricebookStatus: PricebookResolutionStatus;
  isBundle: boolean;
  children: BundleComponent[]; // recursive expansion (empty if not a bundle or expansion stopped at max depth)
  childGroups: BundleComponentGroupInfo[]; // this component's OWN component groups, when it is itself a bundle
  attributes: ProductAttribute[];
  sellingModel: SellingModelResolution | null;
  billingFrequency: BillingFrequencyResolution | null;
  subscriptionTerm: SubscriptionTermResolution | null;
  billingTreatment: BillingTreatmentValidation | null;
  skippedComponents: SkippedComponent[]; // rolled up from this node's own recursion
}

export interface SkippedComponent {
  productId: string;
  productName: string | null;
  reason: string;
  path: string[]; // name path from the bundle root
}

export interface BundleExpansionResult {
  rootProductId: string;
  isBundle: boolean;
  components: BundleComponent[];
  groups: BundleComponentGroupInfo[];
  skippedComponents: SkippedComponent[];
  depthReached: number;
  diagnostics: BundleExpansionDiagnostics;
}

/** §Investigation Required (Bundle detection): every field the ticket asked to be logged before creating line items — never fabricated, null where this org genuinely has no such field/data. */
export interface BundleExpansionDiagnostics {
  rootProductId: string;
  rootProductFamily: string | null;
  rootProductType: string | null; // Product2.Type-shaped field, if this org has one — null if not resolvable, never guessed
  detectedIsBundleField: boolean | null; // a Product2.IsBundle-shaped field's raw value, if this org exposes one — null if not resolvable
  bundleDetectionResult: boolean; // final isBundle verdict
  relationshipObjectUsed: string | null;
  groupObjectUsed: string | null;
  resolvedChildCount: number;
  resolvedChildProductIds: string[];
  expansionSucceeded: boolean;
  reasons: string[];
  /** Populated only when resolvedChildCount is 0 — one real, product-scoped query per candidate {object, field}, to empirically determine which object actually holds this product's structure. */
  candidateQueries: BundleCandidateQueryDiagnostic[];
  /** Real SOQL query failures (permission/FLS/malformed-field errors) encountered while resolving relationship rows or component groups anywhere in this bundle's tree — never swallowed silently. A non-empty list here means "0 children" may mean the query FAILED, not that the product genuinely has no components — the single most likely explanation for a real bundle showing as a Standalone Product. */
  queryErrors: string[];
  /**
   * Explicit classification of why this product did or didn't expand into
   * a bundle — never collapse a real failure into a bare "not a bundle":
   *   BUNDLE_WITH_COMPONENTS   — real child rows were resolved.
   *   NOT_A_BUNDLE             — schema resolved fine, query ran fine, genuinely 0 rows.
   *   QUERY_FAILED             — a SOQL query threw (see queryErrors for the real Salesforce error).
   *   SCHEMA_UNRESOLVED        — no relationship/group object could be discovered in this org at all.
   *   RELATIONSHIP_MAPPING_FAILED — a relationship object WAS discovered, but its parent/child Product2 reference fields could not be resolved, so no query was ever even attempted.
   */
  classification: "BUNDLE_WITH_COMPONENTS" | "NOT_A_BUNDLE" | "QUERY_FAILED" | "SCHEMA_UNRESOLVED" | "RELATIONSHIP_MAPPING_FAILED";
}

/* ── Billing ── */

export interface BillingFrequencyResolution {
  value: string | null;
  source: "product" | "selling-model" | "selling-model-name" | "existing-qli" | "cadence-mapping" | "org-default" | "manual-entry" | null;
  fieldApiName: string | null;
  /** Which lookup(s) were attempted and why each one didn't yield a value — shown in the execution log so a failure names exactly which source failed. */
  attempts: { step: string; outcome: string }[];
  /** QuoteLineItem.BillingFrequency's real, currently active picklist values (Describe) — always populated when the field itself resolves, even on automatic-resolution success, so the UI can offer exactly these as a fallback dropdown without a separate lookup. Empty when the field/picklist itself couldn't be resolved. */
  activeOptions: { value: string; label: string }[];
}

export interface SubscriptionTermResolution {
  value: number | null;
  source: "product" | "selling-model" | "existing-qli" | null;
}

export type BillingTreatmentOutcome =
  | "ok"
  | "inconclusive"
  | "no-billing-policy"
  | "billing-policy-inactive"
  | "no-default-treatment"
  | "billing-treatment-inactive"
  | "cannot-change-frequency";

export interface BillingTreatmentValidation {
  outcome: BillingTreatmentOutcome;
  blocks: boolean; // true only for positively-confirmed-missing outcomes
  message: string | null;
  billingPolicyId: string | null;
  billingPolicyName: string | null;
  billingTreatmentId: string | null;
  billingTreatmentName: string | null;
  /** Salesforce's own BillingTreatment.CanChangeBillingFrequency (or equivalent) — null means unresolved/inconclusive, NEVER assumed true. */
  canChangeBillingFrequency: boolean | null;
  recoverable: boolean; // true only when outcome === "no-billing-policy"
}

export interface BillingPolicyRecoveryResult {
  success: boolean;
  billingPolicyId: string | null;
  billingTreatmentId: string | null;
  createdNew: boolean;
  unresolvedField: string | null;
  message: string;
}

export interface BillingPolicyOption {
  id: string;
  name: string;
  hasDefaultTreatment: boolean; // false = this policy alone won't resolve the outcome; still listed so the user isn't misled by omission
}

export interface BillingPolicyOptionsResult {
  policies: BillingPolicyOption[];
  /** Salesforce Lightning object-home URL for BillingPolicy, for "Open Billing Policy Setup" — null if instanceUrl isn't known. */
  orgSetupUrl: string | null;
}

export interface BillingPolicyAssignResult {
  success: boolean;
  message: string;
  /** The freshly re-resolved outcome for this product after assignment — the caller never has to guess whether it worked. */
  billingTreatment: BillingTreatmentValidation;
}

/* ── Pricing ── */

export type PricingModel = "ManualPricing" | "RevenueCloudPricing" | "Indeterminate";

/** One candidate pricing field's real Describe metadata — the exact evidence a pricing-model classification was based on, never just a name. */
export interface PricingModelFieldEvidence {
  apiName: string;
  label: string;
  type: string;
  createable: boolean;
  updateable: boolean;
  calculated: boolean;
}

export interface PricingModelDiagnosis {
  model: PricingModel;
  reason: string;
  /**
   * §Phase 3/5 — do not classify merely because one field exists: the
   * actual Describe evidence every candidate pricing field carried,
   * always populated (null only when the field genuinely doesn't exist
   * on this org's QuoteLineItem) so the classification can be verified
   * or overridden by a human instead of trusted blindly.
   */
  evidence: {
    unitPrice: PricingModelFieldEvidence | null;
    listPrice: PricingModelFieldEvidence | null;
    netUnitPrice: PricingModelFieldEvidence | null;
    netTotalPrice: PricingModelFieldEvidence | null;
    totalPrice: PricingModelFieldEvidence | null;
    pricingStatus: PricingModelFieldEvidence | null;
  };
}

export interface RepricingLineResult {
  quoteLineItemId: string;
  netUnitPrice: number | null;
  netTotalPrice: number | null;
  listPrice: number | null;
  discount: number | null;
  /** True ONLY when this app explicitly re-wrote NetUnitPrice/NetTotalPrice via a verified compositeUpdate() after Describe confirmed those fields are updateable — never assumed true merely because the pricing request used method:"PUT". False means either the write-back was skipped (fields not updateable — Salesforce's own PUT-based persistence, if any, is unverified by this app) or the explicit write-back itself was rejected; the final QuoteLineItem re-query is the true authority either way. */
  written: boolean;
}

/**
 * One error object exactly as Salesforce returned it inside the response
 * body array — Connect REST error bodies are commonly an ARRAY of these
 * (one org can legitimately return several distinct errors for one failed
 * call), so every entry is kept, never just the first. `extra` carries
 * whatever OTHER keys Salesforce included on this specific entry beyond
 * errorCode/message/fields (e.g. `details`, `nestedErrors`, `extraInfo`,
 * or any org/release-specific key) — passed through untouched rather than
 * guessing a fixed shape for fields this app has never seen against a live
 * Revenue Cloud "Product Discovery" rejection.
 */
export interface RepricingErrorEntry {
  errorCode: string | null;
  message: string | null;
  fields: string[] | null;
  extra: Record<string, unknown> | null;
}

/** §Do not truncate: the complete Salesforce error for one failed repricing candidate path — every error entry, the raw response body, and (when the body wasn't even valid JSON) the raw response text, all untouched — never collapsed to a single message string. */
export interface RepricingAttemptError {
  path: string;
  status: number | null;
  /** The first entry's errorCode, for quick display — the full set is in `entries`. */
  errorCode: string | null;
  message: string;
  /** The first entry's fields, for quick display — the full set is in `entries`. */
  fields: string[] | null;
  /** Every error object in the response body, in order, untouched — never collapsed to just the first. */
  entries: RepricingErrorEntry[];
  /** The complete parsed response body exactly as Salesforce sent it. */
  rawBody: unknown;
  /** The raw, unparsed response text — populated ONLY when the body could not be parsed as JSON at all, so nothing is ever silently lost. */
  rawText: string | null;
}

/** One Connect REST call this app actually sent to Salesforce's pricing engine — path + complete request body, whether or not it succeeded. Lets a native-vs-app comparison inspect exactly what THIS app asked for, alongside a HAR capture of what native Salesforce's own UI sends for the same action. */
export interface RepricingAttemptRequest {
  path: string;
  method: string;
  body: unknown;
}

/**
 * §Never lose the real Salesforce response (Phase 2): the COMPLETE HTTP
 * transcript for one pricing attempt, captured regardless of whether the
 * call "succeeded" by HTTP status — status/statusText/content-type, the
 * raw response text read exactly once, and the JSON-parsed body when
 * parseable. This exists specifically because collapsing an error/Response
 * object into a hand-written summary string (or `JSON.stringify`-ing an
 * Error, which serializes to `{}`) has previously discarded the real
 * Salesforce content — this type is the antidote, always populated,
 * never optional.
 */
export interface RepricingHttpTranscript {
  url: string;
  method: string;
  status: number;
  statusText: string;
  contentType: string | null;
  /** The exact raw response text, always captured (even when it parsed as JSON) — nothing is ever thrown away. */
  rawText: string;
  /** The JSON.parse()'d body, or null if the response wasn't valid JSON (see jsonParseError). */
  json: unknown;
  jsonParseError: string | null;
}

export interface RepricingSummary {
  attempted: boolean;
  succeeded: boolean;
  isConfigurationIssue: boolean;
  message: string | null;
  lines: RepricingLineResult[];
  attemptErrors: RepricingAttemptError[];
  /** Every candidate request this app sent, in order — the complete outgoing request, not just the errors it got back. */
  attemptedRequests: RepricingAttemptRequest[];
  /** The complete raw HTTP transcript for the pricing call — status/statusText/content-type/raw text/parsed JSON, always populated when the call was actually sent (§Phase 2: never lose the real Salesforce response). Null only when the call was never attempted at all (e.g. no line items to reprice). */
  transcript: RepricingHttpTranscript | null;
}

/* ── Quote Line Item draft tree (client staging model) ── */

export interface QuoteLineItemDraft {
  draftId: string; // client-generated, stable across edits until submit
  productId: string;
  product: CatalogProduct;
  parentDraftId: string | null; // null = root-level line
  componentGroupId: string | null;
  relatedComponentId: string | null; // the bundle relationship-object row this draft was expanded from
  relationshipTypeId: string | null;
  quantity: number;
  discountPercent: number;
  unitPrice: number; // manual-pricing orgs only; ignored/overwritten by repricing otherwise
  billingFrequency: string | null;
  subscriptionTerm: number | null;
  sellingModelOptionId: string | null;
  attributeValues: Record<string, string>; // attributeId -> value
  pricingInclusion: boolean; // display-only suppression, never affects payload
  pricebookStatus: PricebookResolutionStatus;
  isBundleParent: boolean;
  children: QuoteLineItemDraft[];
  /* Display-only resolved metadata for the Preview screen (§Preview) — never read by buildQLIPayload. */
  sellingModelName: string | null;
  sellingModelType: SellingModelType | null;
  billingFrequencySource: BillingFrequencyResolution["source"] | null;
  billingTreatmentOutcome: BillingTreatmentOutcome | null;
}

export interface ProductConfigurationResult {
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

/* ── QLI / QLI-attribute / relationship field schemas ── */

export interface QuoteLineItemFieldSchema {
  quoteField: FieldRef | null;
  productField: FieldRef | null;
  pricebookEntryField: FieldRef | null;
  quantityField: FieldRef | null;
  unitPriceField: FieldRef | null;
  listPriceField: FieldRef | null;
  discountField: FieldRef | null;
  totalPriceField: FieldRef | null;
  /** Revenue Cloud's own pricing-RESULT fields (populated by the Instant Pricing/repricing call, never written directly by this app) — null when this org has no such fields at all (ManualPricing orgs). When present and pricingModel is RevenueCloudPricing, these are the AUTHORITATIVE price to read back and display, never plain UnitPrice/TotalPrice (which stay 0/unwritten on a RevenueCloudPricing org). */
  netUnitPriceField: FieldRef | null;
  netTotalPriceField: FieldRef | null;
  /** Revenue Cloud's own read-only pricing-run status (e.g. "Fresh"/"Stale"/"Error") — never written by this app, resolved purely for diagnostics/display so a stale-vs-repriced line is distinguishable. Null on orgs with no such field. */
  pricingStatusField: FieldRef | null;
  sellingModelOptionField: FieldRef | null;
  billingFrequencyField: FieldRef | null;
  subscriptionTermField: FieldRef | null;
  rootItemField: FieldRef | null; // self-reference fallback (mechanism B, §5.5)
  parentItemField: FieldRef | null;
  pricingModel: PricingModel;
  /** The full Describe-based evidence behind `pricingModel` — never discard this after computing the model, so a wrong classification can be diagnosed from real org metadata instead of guessed at again. */
  pricingModelDiagnosis: PricingModelDiagnosis;
}

export interface QuoteLineItemAttributeFieldSchema {
  objectName: string | null;
  quoteLineItemField: FieldRef | null;
  attributeField: FieldRef | null;
  valueField: FieldRef | null;
}

export type NativeBundleMechanism = "relationship-object" | "self-reference" | "unsupported";

export interface QuoteLineRelationshipFieldSchema {
  mechanism: NativeBundleMechanism;
  objectName: string | null;
  mainQuoteLineField: FieldRef | null;
  associatedQuoteLineField: FieldRef | null;
  relatedComponentField: FieldRef | null;
  quantityScaleMethodField: FieldRef | null;
  relationshipTypeField: FieldRef | null;
  pricingInclusionField: FieldRef | null;
  /** Whether pricingInclusionField is a boolean (e.g. IsComponentPriceIncluded) or a dependent picklist (e.g. AssociatedQuoteLinePricing) — null when pricingInclusionField itself is null. */
  pricingInclusionKind: "boolean" | "picklist" | null;
  /** For a picklist pricingInclusionField: the active value meaning "this child's price is included in the parent bundle price", discovered from Describe — never hardcoded as the only possibility. */
  pricingInclusionIncludedValue: string | null;
  /** For a picklist pricingInclusionField: the active value meaning "this child is separately priced". */
  pricingInclusionNotIncludedValue: string | null;
  requiredFieldsNotMapped: FieldRef[]; // audited required fields with no explicit mapping above
}

/* ── Existing quote line items (edit/delete view) ── */

export interface ExistingQuoteLineItem {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  listPrice: number;
  discount: number;
  totalPrice: number;
  /** Revenue Cloud's own read-only pricing-run status (e.g. "Fresh"/"Stale"), read back purely for display/diagnostics — null on orgs with no such field. */
  pricingStatus: string | null;
  /** True when this line's bundle relationship marks it as priced inside its parent (AssociatedQuoteLinePricing = IncludedInBundlePrice, or an equivalent boolean field) — the app displays/treats this line as $0, never Salesforce's raw totalPrice, unless Salesforce explicitly says it's separately priced. */
  pricingInclusion: boolean;
  parentDraftId: string | null;
  rootItemId: string | null;
  parentItemId: string | null;
  children: ExistingQuoteLineItem[];
}

export type RefreshedLineItem = ExistingQuoteLineItem;

/**
 * §Price Pipeline Trace — the end-to-end checkpoints requested for
 * diagnosing the $0 pricing issue, per line, never collapsed into a single
 * pass/fail. A `null` checkpoint value means "not resolvable/not
 * attempted" and must be shown as such — never coerced to 0, which would
 * make an unresolved price indistinguishable from a genuine Salesforce $0.
 */
export interface PricingTraceLine {
  productName: string;
  productId: string;
  quoteLineItemId: string;
  /** True when this line's price is included in its parent bundle's price — expected to legitimately show $0, never flagged as a failure. */
  pricingInclusion: boolean;
  /** Checkpoint A — PricebookEntry.UnitPrice, freshly queried (never a stale UI value). */
  pricebookEntryPrice: number;
  /** Checkpoint B — the value actually included in the QLI create payload for the price field this app writes, or null if intentionally omitted. */
  createPayloadPrice: number | null;
  createPayloadFieldUsed: string | null;
  /** Checkpoint C — the QuoteLineItem's own price fields immediately after INSERT, before any post-creation pricing write. */
  priceAfterInsert: number;
  /** §Runtime evidence item 7 — the exact API field name `priceAfterInsert` was read from; never assumed, so a wrong source field is visible instead of silently producing a misleading $0. */
  afterInsertSourceField: string | null;
  /**
   * §Phase 8 — "List Price Applied: yes" must mean confirmed by a
   * subsequent Salesforce read, never merely "the update call was
   * attempted". `updateSucceeded` reflects only what compositeUpdate's
   * response said; `confirmed` is the one field allowed to gate a "yes" in
   * the UI, and is only true when `readBackValue` (Checkpoint F, already
   * captured below as `finalPrice`) actually matches the value written.
   */
  listPriceWrite: {
    attempted: boolean;
    field: string | null;
    value: number | null;
    updateSucceeded: boolean;
    readBackValue: number | null;
    confirmed: boolean;
  };
  /** Checkpoint F — the final, authoritative Salesforce re-query. */
  finalPrice: number;
  /** §Runtime evidence item 7 — the exact API field name `finalPrice` was read from. */
  finalPriceSourceField: string | null;
  /**
   * §Discount pricing fix — present only for a line with a non-zero
   * requested discount percentage: what Salesforce's OWN Instant Pricing
   * repricing call (lib/quotes/pricing/reprice.ts) returned for this exact
   * line, if repricing was attempted for this Quote. `null` when
   * discountPercent is 0 (no repricing needed) or repricing was never
   * attempted/didn't return a result for this line — never coerced to 0,
   * so "Salesforce didn't confirm this" stays visibly distinct from "this
   * line's confirmed adjustment amount happens to be zero".
   */
  discountRepricing: {
    requestedPercent: number;
    salesforceNetUnitPrice: number | null;
    salesforceNetTotalPrice: number | null;
    /** pricebookEntryPrice minus salesforceNetUnitPrice — the per-unit amount Salesforce's own pricing procedure attributes to this line's adjustment, not a locally recomputed estimate. */
    salesforceAdjustmentAmount: number | null;
    /** True only when Salesforce's OWN repricing response actually returned a value for this line — never true merely because the repricing HTTP call returned 200/201. */
    confirmed: boolean;
  } | null;
}

/* ── Bundle hierarchy creation trace / errors ── */

export interface BundleHierarchyStep {
  step: string;
  status: "start" | "success" | "error" | "info";
  message: string;
  detail?: unknown;
  timestamp: number;
}

export interface LineItemCreationError {
  message: string;
  code: string | null;
  path: string[] | null; // path-qualified location within the bundle tree, if applicable
}

export interface LineItemRollbackDetail {
  attempted: boolean;
  records: { sobject: string; ids: string[] }[];
}

/**
 * Full diagnostic detail for a failed line-item creation (never a bare
 * "Request failed with status 422") — everything needed to diagnose the
 * exact failure from the UI alone, without opening the source code.
 */
export interface LineItemFailureDetail {
  currentStep: string;
  validationRule: string;
  reason: string;
  missingField: string | null;
  invalidValue: unknown;
  salesforceObject: string | null;
  quoteId: string;
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
  rollback: LineItemRollbackDetail;
  lastSuccessfulStep: string | null;
}

export interface LineItemCreationResult {
  success: boolean;
  createdIds: string[];
  createdCount: number;
  bundleHierarchyValid: boolean;
  /** False when a RevenueCloudPricing org's created lines came back with an authoritative price of 0 despite the selected PricebookEntry having a non-zero price — a $0.00 result must never be silently treated as success. True (never blocks success) for ManualPricing/Indeterminate orgs, where 0 can be a genuine price. */
  pricingVerified: boolean;
  issues: string[];
  steps: BundleHierarchyStep[];
  repricing: RepricingSummary | null;
  errors: LineItemCreationError[];
  refreshedLineItems: RefreshedLineItem[];
  /** Per-line, end-to-end price checkpoints (PBE price → create payload → after insert → after List Price applied → final re-query) — empty only when creation failed before any QLI existed. */
  pricingTrace: PricingTraceLine[];
  /** Present only when success is false — the full structured diagnosis of the failure (§Issue 2-4). */
  failureDetail: LineItemFailureDetail | null;
}

/* ── Bundle tree validation (§5.4) ── */

export interface UnresolvedNode {
  path: string[];
  message: string;
}

export interface UserSelectionRequired {
  path: string[];
  groupId: string;
  groupName: string;
  min: number;
  candidates: CatalogProduct[];
  currentlySelected: string[];
}

export interface BundleTreeValidationResult {
  valid: boolean; // true iff unresolvedNodes is empty (userSelectionsRequired never blocks)
  unresolvedNodes: UnresolvedNode[];
  userSelectionsRequired: UserSelectionRequired[];
}

/* ── Execution log / response summary (client-side, in-memory) ── */

export type ExecutionLogStatus = "pending" | "success" | "error";

export interface ExecutionLogEntry {
  id: string;
  label: string;
  method: string;
  path: string;
  status: ExecutionLogStatus;
  httpStatus: number | null;
  startedAt: number;
  durationMs: number | null;
  requestBody: unknown;
  responseBody: unknown;
  errorSummary: StructuredError | null;
}

export interface StructuredError {
  message: string;
  possibleCause: string | null;
  isConfigurationIssue: boolean;
  code: string | null;
}

/** Structural shape shared by RepricingSummary (Quote) and OrderRepricingSummary (Order) — both are assignable here since `lines` only needs to be read as an array, never keyed by name in the shared store/UI. */
export interface GenericRepricingSummary {
  attempted: boolean;
  succeeded: boolean;
  isConfigurationIssue: boolean;
  message: string | null;
  lines: unknown[];
}

export interface SalesforceResponseSummary {
  quote: { id: string; name: string } | null;
  lineItems: { count: number; ids: string[] } | null;
  bundleResult: LineItemCreationResult | null;
  repricing: GenericRepricingSummary | null;
  /** Order-side counterparts (§0 of the Order/OrderItem module) — same shared store, additive fields so Quote code is unaffected. */
  order?: { id: string; orderNumber: string | null; status: string | null } | null;
  orderLineItems?: { count: number; ids: string[] } | null;
  orderBundleResult?: unknown;
  orderActivation?: unknown;
  /** Contract-side counterparts (Contract/document-generation/e-signature module) — same shared store, additive fields so Quote/Order code is unaffected. */
  contract?: { id: string; contractNumber: string | null; status: string | null } | null;
  contractActivation?: unknown;
  contractDocument?: { contentVersionId: string; templateName: string } | null;
  contractSignature?: unknown;
}

/* ── Bundle diagnostics ── */

export interface BundleDiagnosticsChecklist {
  definitionLoaded: boolean;
  payloadBuilt: boolean;
  created: boolean;
  hierarchyMatches: boolean;
  missingComponents: string[];
  missingGroups: string[];
  missingParentRelationships: string[];
  missingNestedBundles: string[];
}
