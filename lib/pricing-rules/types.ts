/**
 * Pricing Rules module — shared types.
 *
 * A "Pricing Rule" here means a Salesforce Revenue Cloud Pricing Procedure
 * (an Expression Set). Only `pricingType === "attribute-based"` is wired to
 * a real Metadata API deploy today — the real Salesforce action-type names
 * and binding requirements for tier/volume/bundle pricing aren't documented
 * anywhere this build could verify against, so those three are represented
 * here (so the shared architecture is genuinely generic) but their
 * create-procedure branch returns `notImplemented: true` rather than
 * deploying guessed metadata.
 */

/**
 * ExpressionSet/ExpressionSetVersion/ExpressionSetStep and the Decision
 * Table objects this module reads are newer Revenue Cloud constructs than
 * the rest of this app targets (SF_API_VERSION/SF_API_VERSION_RCA in
 * lib/salesforce/client.ts) — this module pins its own, newer version for
 * both REST SOQL and the Metadata API SOAP endpoint.
 */
export const PRICING_RULES_API_VERSION = "v61.0";

/** The Connect REST pricing-engine execute/run endpoints specifically require this version per Salesforce's documented Pricing Procedure simulation API — kept independent of PRICING_RULES_API_VERSION above. */
export const PRICING_ENGINE_API_VERSION = "v67.0";

export type PricingType = "tier-based" | "volume-based" | "attribute-based" | "bundle-based";

export const PRICING_TYPE_LABELS: Record<PricingType, string> = {
  "tier-based": "Tier-Based",
  "volume-based": "Volume-Based",
  "attribute-based": "Attribute-Based",
  "bundle-based": "Bundle-Based",
};

/** Which pricing types have a real, working deploy engine behind them. */
export const IMPLEMENTED_PRICING_TYPES: PricingType[] = ["attribute-based"];

/* ── Step trace (this module's own copy of the app-wide step-trace shape —
 * every domain module keeps its own per existing convention). ── */
export interface ProcedureStep {
  step: string;
  status: "start" | "success" | "error" | "info";
  message: string;
  detail?: unknown;
  timestamp: number;
}

/* ── Attribute discovery ── */
export interface AttributeValue {
  id: string;
  label: string;
  value: string;
  developerName?: string | null;
  code?: string | null;
  isActive?: boolean | null;
  sortOrder?: number | null;
}

export interface AttributeDefinition {
  id: string;
  name: string;
  label: string;
  developerName: string;
  dataType: string;
  attributeCategory: string;
  attributePicklistName: string;
  isPriceImpacting?: boolean | null;
  values: AttributeValue[];
  source: "overridden" | "inherited";
}

export type AttributePricingType = "Percentage Discount" | "Fixed Amount" | "Override Price";

export interface AttributePricingEntry {
  id: string;
  attributeName: string;
  attributeLabel: string;
  attributeValue: string;
  attributeValueLabel: string;
  pricingType: AttributePricingType | "";
  adjustmentValue: string;
}

export interface ProductAttributeData {
  product: {
    id: string;
    name: string;
    productCode: string;
    status: string;
    currency: string;
    sellingModelId: string;
    sellingModelName: string;
    effectiveFrom: string;
    effectiveTo: string;
    /** UnitPrice off the active Standard Price Book entry — null when no such entry exists (a warning, never a hard failure). */
    basePrice: number | null;
  };
  attributes: AttributeDefinition[];
  totalAttributes: number;
  warning?: string;
  debugLog?: DebugLogEntry[];
}

/* ── AI generation ── */
export interface AIAttributeEntry {
  attributeName: string;
  attributeValue: string;
  adjustmentType: AttributePricingType;
  adjustmentValue: number;
}

export interface AIGeneratedProcedure {
  procedureName: string;
  productName: string;
  pricingType: PricingType | "";
  description?: string;
  basePrice?: string;
  attributeEntries?: AIAttributeEntry[];
}

export type AIConfidence = "high" | "medium" | "low";

/* ── Canvas preview (display-only step list shown in the AI-generation UI
 * before a real deploy happens; distinct from the real deployed canvas). ── */
export interface CanvasStepPreview {
  seq: number;
  actionType: string;
  label: string;
  description: string;
}

/* ── Form / payload ── */
export interface ProcedureFormData {
  procedureName: string;
  apiName: string;
  description: string;
  productName: string;
  pricingType: PricingType | "";

  // Auto-populated from Salesforce once a product is resolved (attribute-based only).
  productId: string;
  productCode: string;
  productStatus: string;
  currency: string;
  sellingModel: string;
  sellingModelId: string;
  effectiveFrom: string;
  effectiveTo: string;
  procedureStatus: "Draft" | "Active";

  basePrice: string;

  attributeEntries: AttributePricingEntry[];
}

export function emptyProcedureForm(): ProcedureFormData {
  return {
    procedureName: "",
    apiName: "",
    description: "",
    productName: "",
    pricingType: "",
    productId: "",
    productCode: "",
    productStatus: "",
    currency: "",
    sellingModel: "",
    sellingModelId: "",
    effectiveFrom: "",
    effectiveTo: "",
    procedureStatus: "Draft",
    basePrice: "",
    attributeEntries: [],
  };
}

export interface ProcedurePayload {
  procedureName: string;
  apiName: string;
  description?: string;
  productName: string;
  pricingType: PricingType;

  productId?: string;
  productCode?: string;
  productStatus?: string;
  currency?: string;
  sellingModel?: string;
  sellingModelId?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  procedureStatus?: "Draft" | "Active";

  basePrice?: string;

  attributeEntries?: AttributePricingEntry[];

  /**
   * Only meaningful when `attributeEntries` resolves to zero valid rows.
   * The guided form's own client-side validation never lets that happen
   * (see CreatePricingRuleFlow's `validate()`), so this only matters for a
   * caller that can legitimately arrive with no NEW pricing to configure —
   * Autopilot, when the user reviewed and confirmed reusing an existing
   * Price Adjustment Schedule for this product instead of adding new
   * mappings. When true and no valid entries were submitted, the pipeline
   * checks for an existing PriceAdjustmentSchedule with real rules before
   * failing — see runCreateProcedurePipeline in create-procedure/route.ts.
   */
  allowReuseExistingSchedule?: boolean;

  /**
   * §Auto-Fix Price Impacting — opt-in (default false). When an attribute's ProductAttributeDefinition
   * (or AttributeDefinition) isn't flagged price-impacting, Salesforce rejects Condition/Rule creation
   * with FIELD_INTEGRITY_EXCEPTION ("Ensure that your attribute is price impacting"). With this on and
   * the controlling field API-updateable, the pipeline flips it to true (and verifies the update) instead
   * of stopping. Off by default because flipping it can affect every OTHER product/procedure sharing the
   * same attribute/PAD record — never applied without explicit opt-in.
   */
  autoFixPriceImpacting?: boolean;

  /**
   * §REQUEST_LIMIT_EXCEEDED remediation (Autopilot request-volume audit):
   * both the guided flow (POST /api/pricing-rules/product-attributes) and
   * Autopilot's discovery pass (POST /api/pricing-rules/ai/discover-procedure)
   * already run the FULL discoverProductAttributes pipeline (~15-30
   * Salesforce round trips: Product2/selling-model/pricebook queries,
   * Describe calls, per-attribute value discovery) before the user ever
   * reaches the confirm step — the create-procedure pipeline's own
   * "Attribute Discovery" step previously re-ran that entire pipeline again,
   * unconditionally, for the exact same product. When the caller already
   * has this data, it can be passed straight through here instead of
   * re-fetched; the step's own validation of `attributeEntries` against it
   * runs exactly the same either way. Optional and purely additive — a
   * caller with no discovery result yet (or one that doesn't trust its
   * freshness) simply omits this, and the step discovers fresh exactly as
   * before.
   */
  discoveredAttributes?: ProductAttributeData;
}

/**
 * §DeploymentContext — resolved once, right after Product Discovery (Product
 * Lookup + Fetch Selling Model), and threaded unchanged into every native
 * record creation function from there on. Exists because ProductId was
 * previously re-derived ad hoc at each creation site — AttributeAdjustmentCondition
 * never had a Product2 lookup field resolved for it at all, so its payload
 * silently omitted a field the object actually requires. `priceAdjustmentScheduleId`
 * is filled in once PriceAdjustmentSchedule create/reuse resolves it;
 * `expressionSetId`/`expressionSetVersionId` are filled in later still, once
 * Metadata deploy resolves them — both start undefined and are never
 * required by anything in the native-record-creation pipeline itself.
 */
export interface DeploymentContext {
  productId: string;
  /** For diagnostics/preview only (e.g. the Attribute JSON Preview and per-condition build logs) — never used to re-derive or re-resolve the product itself. */
  productName?: string;
  productCode?: string;
  sellingModelId: string;
  currency?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  basePrice?: string;
  expressionSetId?: string;
  expressionSetVersionId?: string;
  priceAdjustmentScheduleId?: string;
}

/**
 * §Native Salesforce object creation diagnostics — captured for the exact
 * createRecord() call that failed (or would have, had a required field
 * been missing) so the failure panel can answer "which object, which
 * payload, which field, which Salesforce error, which response" directly,
 * instead of a generic "Create Price Adjustment Schedule failed" no matter
 * which of the 4 object types actually broke.
 */
export interface NativeCreateFailureDetail {
  objectName: string;
  restEndpoint: string;
  payload: Record<string, unknown>;
  requiredFields: string[];
  optionalFields: string[];
  /** Non-empty only when this call was refused locally before Salesforce was ever contacted. */
  missingFields: string[];
  httpStatus: number | null;
  salesforceErrorCode: string | null;
  salesforceErrorMessage: string | null;
  responseBody: unknown;
}

/** §Payload Preview — expected record count per object type, computed before the first create call. */
export interface NativeRecordCountPreview {
  objectName: string;
  expectedCount: number;
  /** Populated only when expectedCount is 0 — explains which filtering rule produced that. */
  reason?: string;
}

/**
 * §Execution trace — Step 5 Final Execution Report, per object type.
 * - CREATED: a new record was made this run.
 * - REUSED: an existing record (found by the duplicate check) was adopted —
 *   its Id flows into ruleIds/conditionIds/abaIds exactly as if it had just
 *   been created; this is a success outcome, never a failure.
 * - SKIPPED: execution deliberately did not attempt this object (e.g. §D4's
 *   coverage check failed for one entry, or no entries were submitted at
 *   all) — not itself a failure of anything.
 * - FAILED: a createRecord() call for this object was actually attempted
 *   and rejected (or refused locally for a missing/mismatched field).
 */
export type NativeExecutionStatus = "CREATED" | "REUSED" | "SKIPPED" | "FAILED";
export interface NativeExecutionStepReport {
  status: NativeExecutionStatus;
  reason: string;
}
export interface NativeExecutionReport {
  priceAdjustmentSchedule: NativeExecutionStepReport;
  attributeBasedAdjRule: NativeExecutionStepReport;
  attributeAdjustmentCondition: NativeExecutionStepReport;
  attributeBasedAdjustment: NativeExecutionStepReport;
}

/* ── create-procedure result ── */
/** §B — one row of the Attribute JSON Preview: every attribute this run will touch (each submitted
 * entry's own attribute, plus every other price-impacting attribute needing an anchor Condition),
 * computed from data already resolved via Describe/SOQL BEFORE any create call is attempted — never a
 * live Salesforce call of its own, and never limited to only the first (or first failing) attribute. */
export interface AttributePreviewEntry {
  attributeName: string;
  attributeDefinitionId: string | null;
  productAttributeDefinitionId: string | null;
  dataType: string | null;
  /** "<Object>.<Field>" the datatype value was actually read from (e.g. "AttributeDefinition.DataType"), or null if none was found. */
  dataTypeSource: string | null;
  attributeValue: string;
  isPriceImpacting: boolean | null;
  /** The exact AttributeAdjustmentCondition field this value will be written to (e.g. "StringValue"), or null when BLOCKED. */
  conditionValueField: string | null;
  operator: string;
  conditionPayload: Record<string, unknown>;
  /** Empty for an anchor-only attribute (no Rule/Adjustment of its own — it only needs a Condition under the priced entry's Rule). */
  rulePayload: Record<string, unknown>;
  adjustmentPayload: Record<string, unknown>;
  status: "READY" | "BLOCKED";
  reason: string | null;
}

export interface AttrNativeResult {
  scheduleId?: string;
  /** §B — the complete Attribute JSON Preview, computed once before Step A. */
  attributePreview?: AttributePreviewEntry[];
  scheduleCreated: boolean;
  rulesCreated: number;
  rulesSkipped: number;
  conditionsCreated: number;
  abasCreated: number;
  abasSkipped: number;
  error?: string;
  /** Every record Id actually created, per object — required for post-deploy Native Record Validation (§Native Record Validation), not just counts. */
  ruleIds: string[];
  conditionIds: string[];
  abaIds: string[];
  /** The first (and, per §Stop immediately, only) create call that actually failed — absent when every attempted create succeeded. */
  firstFailure?: NativeCreateFailureDetail;
  /** Expected record count per object, computed before Step A's create/reuse ever runs. */
  recordCountPreview?: NativeRecordCountPreview[];
  /** §Execution trace — Step 5 Final Execution Report: whether execution ever actually reached each object's createRecord() call this run, and why not for any that didn't. */
  executionReport?: NativeExecutionReport;
}

export interface SimulationContext {
  ItemContractAttributePasId: string;
  note: string;
}

/**
 * §3 — structured failure diagnostics for create-procedure. The exact
 * step names come from a fixed vocabulary (Product Lookup, Fetch Selling
 * Model, Retrieve Template Expression Set, Build Expression Set XML,
 * Validate XML, Deploy Metadata, ...) so the UI can always show which
 * stage broke, not just a generic message. `endpoint` is a human-readable
 * description of the Salesforce API surface involved (e.g. "Salesforce
 * Metadata API (deploy)"), not a literal URL — SalesforceClient doesn't
 * expose raw request URLs to callers. Never carries a stack trace: that
 * goes to server console.error only (see buildFailureDiagnostics).
 */
/**
 * §Deployment Diagnostics — mirrors lib/pricing-rules/metadata/soapEnvelope.ts's `ComponentFailure`
 * shape exactly (redefined here, not imported, so this leaf types module stays import-free) — one
 * entry per Salesforce Metadata API `componentFailures` DeployMessage: Component Name (`fullName`),
 * Component Type, File Name, Problem Type, Problem Message (`problem`), Line Number, Column Number.
 */
export interface DeployComponentFailure {
  fileName: string | null;
  fullName: string | null;
  problem: string | null;
  componentType: string | null;
  problemType: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
}

/** §Deployment Diagnostics — the COMPLETE raw deploy status Salesforce returned, mirroring `DeployStatusInfo` (see soapEnvelope.ts) — not just the numberComponentsDeployed/numberComponentErrors summary already on `SalesforceCreationResult.deployStatus`. */
export interface DeployFullStatus {
  id: string;
  done: boolean;
  success: boolean;
  status: string | null;
  numberComponentsDeployed: number;
  numberComponentErrors: number;
  errorMessage: string | null;
  componentFailures: DeployComponentFailure[];
}

/** §Sequential Workflow — one line of an NDJSON stream from POST /api/pricing-rules/create-procedure.
 * A "step" line reports one of the 8 live-tracked checklist rows (see DeploymentProgressPanel.tsx)
 * transitioning to Running/Completed/Failed, in real backend execution order, as it actually happens —
 * never more than one row "running" for a genuinely sequential phase. The stream always ends with
 * exactly one "result" line carrying the complete `SalesforceCreationResult`, identical in shape to
 * what this endpoint used to return as a single JSON response. */
export type CreateProcedureStreamEvent =
  | { type: "step"; step: string; status: "running" | "done" | "failed"; detail?: string }
  | { type: "attributePreview"; product2Id: string; sellingModelId: string; priceAdjustmentScheduleId: string | null; attributes: AttributePreviewEntry[] }
  | { type: "result"; result: SalesforceCreationResult };

export interface CreateProcedureFailure {
  step: string;
  endpoint?: string;
  httpStatus?: number;
  salesforceErrorCode?: string;
  salesforceErrorMessage?: string;
  reason: string;
  resolutionHint: string;
  /** Full ZIP directory tree / package.xml / per-member PASS-FAIL report, present only for a "Deploy Metadata" failure caught by local pre-deploy packaging validation (§ZIP packaging bug investigation) — see lib/pricing-rules/metadata/deploy.ts. */
  packagingReport?: string;
  /** Root element / namespaces / child-ordering / per-child-tag comparison against the donor Expression Set, present only for a "Validate XML" failure caught by the structural schema comparison — see lib/pricing-rules/metadata/schemaDiff.ts. */
  schemaReport?: string;
  /** Present only when `step` names a native Salesforce object (PriceAdjustmentSchedule/AttributeBasedAdjRule/AttributeAdjustmentCondition/AttributeBasedAdjustment) — the exact create call that failed. */
  nativeCreateFailure?: NativeCreateFailureDetail;
  /** §Sequential Workflow — the exact Salesforce object this step operated on (e.g. "Product2", "PriceAdjustmentSchedule"), never a generic step label. */
  object?: string;
  /** §Sequential Workflow — the exact operation attempted (e.g. "Query", "Create", "Verify (query-back)", "Metadata Deploy", "Activate", "Simulate"). */
  operation?: string;
  /** §Sequential Workflow — the Salesforce Id involved (the record being created/verified/activated), when one exists yet. Null when the failure happened before any Id was assigned. */
  salesforceId?: string | null;
  /** §Sequential Workflow — the name of the last step in the 12-stage workflow that completed successfully before this one failed. Null only when Step 1 (Product Lookup) itself is the first failure. */
  lastSuccessfulStep?: string | null;
  /** §Deployment Diagnostics — present only for a "Deploy Metadata" failure with real Salesforce componentFailures[]; rendered as an itemized list, never collapsed into one generic string. */
  deployComponentFailures?: DeployComponentFailure[];
  /** §Deployment Diagnostics — the complete raw deploy status (see DeployFullStatus above), present only for a "Deploy Metadata" failure where the Metadata API was actually called (absent for a local pre-deploy packaging failure, since Salesforce never returned one). */
  deployFullStatus?: DeployFullStatus | null;
  /** §Deployment Diagnostics — the exact generated Expression Set XML that was (or would have been) deployed, present for a "Deploy Metadata" failure so the panel can show precisely what Salesforce rejected. */
  generatedFileXml?: string;
  /** §Deployment Diagnostics — base64 of the ZIP package sent to (or built for) the Metadata API, present for a "Deploy Metadata" failure — downloadable from the failure panel for offline inspection ("save the failed deployment package"). */
  deployZipBase64?: string;
  /** §Deployment Diagnostics — the raw SOAP checkDeployStatus response XML, present for a "Deploy Metadata" failure where the Metadata API was actually called. The failure panel falls back to rendering this verbatim when `deployComponentFailures` came back empty, instead of only the generic message. */
  rawDeployStatusXml?: string;
}

export interface DeployStatusSummary {
  numberComponentsDeployed: number;
  numberComponentErrors: number;
  status: string | null;
}

/** A single instrumented Salesforce call/record — populated only when the request opted into Debug Mode (§Debug Mode). */
export interface DebugLogEntry {
  type: "soql" | "rest" | "metadata-soap" | "record" | "retry" | "deploy-response" | "xml-diagnostic" | "zip-diagnostic" | "native-create-request" | "native-create-response" | "execution-trace";
  detail: string;
  timestamp: number;
}

export interface SalesforceCreationResult {
  success: boolean;
  notImplemented?: boolean;
  /** True only for the "zero valid attribute pricing rows" pre-flight check (§Row validation) — a local, pre-Salesforce validation failure, never a deployment failure. No Salesforce call was made when this is true. The frontend must not render this via the deployment failure panel. */
  validationError?: boolean;
  procedureId?: string;
  versionId?: string;
  apiName?: string;
  /** "Active" only when the ExpressionSetVersion was actually activated post-deploy (requested via procedureStatus === "Active"); "Draft" otherwise, including when activation was requested but failed (see warnings). */
  versionStatus?: "Draft" | "Active";
  canvasSteps?: CanvasStepPreview[];
  /** §Expression Set Retrieval verification — every actionType actually found in the donor template Expression Set(s). */
  observedActionTypes?: string[];
  /** §XML Generation verification — per-step parameter counts on the final (patched) canvas. */
  stepParameterCounts?: { actionType: string; parameterCount: number }[];
  /** §XML Generation verification — variables declared on the donor template Expression Set. */
  variableCount?: number;
  /** §Metadata Deployment verification — the raw Metadata API deploy result, present on success too (not just failure). */
  deployStatus?: DeployStatusSummary;
  /** The exact final (patched) XML per step that was actually deployed — needed by post-deploy validation to diff against a fresh Metadata API retrieve. */
  canvasXml?: { actionType: string; xml: string }[];
  /** The ORIGINAL, unpatched donor template step XML each canvas step was cloned from — needed by post-deploy validation to diff generated-vs-template. */
  donorSteps?: { actionType: string; xml: string }[];
  attrNative?: AttrNativeResult;
  simulationContext?: SimulationContext;
  /** §Sequential Workflow Step 12 — Runtime Verification now runs synchronously as the workflow's last
   * step (previously a separate, non-blocking follow-up call the client made on its own after success).
   * Present whenever the workflow reached Step 12 at all, success or not — a failed simulation still
   * fails the overall response (see runAttributePricingWorkflow), but every record created by Steps
   * 1-11 stays intact and is still reported via attrNative/procedureId/versionId above. */
  verifyResult?: VerifyExecutionResult;
  steps: ProcedureStep[];
  warnings: string[];
  error?: string;
  failure?: CreateProcedureFailure;
  /** Present only when the request set `debug: true` — every SOQL query/REST endpoint/Metadata API call/record Id/retry made while handling this request. */
  debugLog?: DebugLogEntry[];
}

/* ── verify-execution ── */
export interface ExecutionReportBlocker {
  step: string;
  category: string;
  reason: string;
  details?: unknown;
  resolutionHint: string;
}

export interface ExecutionReport {
  listPrice: number | null;
  adjustment: { type: string | null; value: number | null; computedAmount: number | null } | null;
  netUnitPrice: number | null;
  subtotal: number | null;
  decisionTableRowMatched: boolean;
  blocker: ExecutionReportBlocker | null;
  /** The raw `additionalOutputData.pricingWaterfall[0].waterfall` array from the pricing engine response, when one was returned — §Runtime Verification "Pricing Waterfall" display. */
  pricingWaterfall?: unknown;
}

export interface VerifyExecutionResult {
  success: boolean;
  executionReport: ExecutionReport;
  steps: ProcedureStep[];
  debugLog?: DebugLogEntry[];
}

/* ── Post-deploy validation (§Salesforce validation phase) ──
 * The generated procedure must be validated against the ACTUALLY DEPLOYED
 * org state, not just the pre-deploy build — every check here re-reads
 * something real from Salesforce (a fresh Metadata retrieve, a SOQL query,
 * a real pricing-engine call), it never re-derives from what create-
 * procedure already believed before deploying.
 */
export type ValidationStatus = "match" | "different" | "missing" | "pass" | "fail" | "warning";

export interface ValidationCheck {
  label: string;
  status: ValidationStatus;
  detail?: string;
}

export interface DecisionTableValidation {
  lookUpId: string | null;
  name: string | null;
  id: string | null;
  version: string | null;
  datasetStatus: string | null;
  refreshStatus: string | null;
  mappedLookupName: string | null;
  mappedLookupId: string | null;
  stale: boolean;
  issues: string[];
}

export interface NativeRecordValidation {
  objectType: "PriceAdjustmentSchedule" | "AttributeBasedAdjRule" | "AttributeAdjustmentCondition" | "AttributeBasedAdjustment";
  recordId: string;
  createdSuccessfully: boolean;
  relatedExpressionSet?: string | null;
  relatedProduct?: string | null;
  relatedSellingModel?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  issues: string[];
}

export interface ExpectedVsActualCheck {
  attributeName: string;
  attributeValue: string;
  adjustmentType: string;
  adjustmentValue: number;
  expectedPrice: number | null;
  actualPrice: number | null;
  difference: number | null;
  status: "pass" | "fail" | "error";
  detail?: string;
}

/* ── AI Autopilot — discovery + review pipeline ──
 * Autopilot behaves like an assistant, not a direct executor: a prompt
 * only ever drives /api/pricing-rules/ai/discover-procedure (Product
 * Discovery → Attribute Discovery → Attribute Validation → mapped-vs-
 * unmapped breakdown), which NEVER writes to Salesforce. The user reviews
 * the Product Summary, discovered attributes, extracted mappings, and
 * resolves any "Not Yet Mapped" values, then explicitly confirms a final
 * Review page. Only that confirmation calls the real, already-battle-
 * tested /api/pricing-rules/create-procedure endpoint (the same one the
 * guided/manual flow uses) — so Autopilot's creation progress is,
 * necessarily, identical to the manual workflow's, not a reimplementation
 * of it.
 */

/**
 * §Attribute Validation UX — a suggested real-Salesforce replacement for an
 * attribute/value the prompt named that didn't match anything. `method`
 * records how it was found: deterministic string/token similarity
 * (fuzzyMatch.ts) or an AI-assisted semantic guess (suggestAttributeMappings.ts)
 * — both are validated against the real discovered attribute/value list
 * before ever reaching this shape, so a suggestion here is always a real,
 * already-discovered Salesforce value, never invented.
 */
export interface AttributeValidationSuggestion {
  attributeName: string;
  attributeLabel: string;
  attributeValue: string;
  attributeValueLabel: string;
  confidence: "high" | "medium";
  method: "fuzzy-match" | "ai-suggested";
}

/** One attribute/value pair from the prompt that couldn't be matched to a real Salesforce attribute/value, exactly as the user/AI typed it, plus the closest real suggestion (if any was found). */
export interface AttributeValidationIssue {
  enteredAttributeName: string;
  enteredAttributeValue: string;
  adjustmentType: string;
  adjustmentValue: number;
  suggestion?: AttributeValidationSuggestion;
}

/** A canonical (already-matched-to-Salesforce) attribute pricing entry, shaped for both server internals (NormalizedAttributeEntry) and the auto-create wire contract (overrideEntries) — deliberately structural/duck-typed rather than importing either concrete type, so this stays a pure data shape. */
export interface ResolvedAttributeEntryLike {
  attributeName: string;
  attributeValue: string;
  adjustmentType: string;
  adjustmentValue: number;
}

export interface DiscoveredAttributeValueSummary {
  value: string;
  label: string;
}

export interface DiscoveredAttributeSummary {
  attributeName: string;
  attributeLabel: string;
  values: DiscoveredAttributeValueSummary[];
}

/** One attribute/value pair from the prompt that DID match a real Salesforce attribute/value, labeled for display in the "Pricing Mappings extracted from the prompt" section. */
export interface AttributeValueMappingPreview {
  attributeName: string;
  attributeLabel: string;
  attributeValue: string;
  attributeValueLabel: string;
  adjustmentType: string;
  adjustmentValue: number;
}

/** Read-only reuse check — a PriceAdjustmentSchedule with at least one real AttributeBasedAdjRule already exists for this product, found by /api/pricing-rules/salesforce/existingAttributePricing. Shown on the Review page as "Price Adjustment Schedule: will reuse existing" rather than silently creating a duplicate. */
export interface ExistingScheduleSummary {
  scheduleId: string;
  ruleCount: number;
}

/**
 * Result of /api/pricing-rules/ai/discover-procedure — Steps 1-7 of
 * Autopilot's assistant workflow. NEVER writes to Salesforce; every field
 * here is either read-only Salesforce state or a client-side-editable
 * draft (`mappedEntries`) the user reviews before anything is created.
 */
export interface DiscoverProcedureResult {
  success: boolean;
  /** The exact product named in the prompt doesn't exist in Salesforce. Message is always exactly `Product '<name>' does not exist.` */
  productNotFound?: boolean;
  /**
   * The prompt named an attribute or attribute value that isn't real on
   * this product. Rendered as an intelligent validation summary (not a
   * bare error) — see `attributeIssues` for the per-entry detail and
   * suggested fix, and `resolvedEntries` for the entries that already
   * matched fine and must be carried forward on resubmit.
   */
  needsAttributeResolution?: boolean;
  attributeIssues?: AttributeValidationIssue[];
  resolvedEntries?: ResolvedAttributeEntryLike[];
  /** Only "attribute-based" has a real deploy path (see IMPLEMENTED_PRICING_TYPES) — a prompt that explicitly names a different pricing type stops here. */
  notImplemented?: boolean;

  productName?: string;
  procedureName?: string;
  product?: {
    id: string;
    name: string;
    productCode: string;
    status: string;
    currency: string;
    sellingModelId: string;
    sellingModelName: string;
    effectiveFrom: string;
    effectiveTo: string;
    basePrice: number | null;
  };
  /** Every discovered price-impacting attribute + all of its real values (Step 5 — "Available Salesforce Attributes"). */
  attributes?: DiscoveredAttributeSummary[];
  /** Step 6 — the pricing mappings the prompt actually specified, already validated and labeled. The user can still edit/add to this client-side before confirming (Step 7's "Not Yet Mapped" resolution) — this is a draft, not a commitment. */
  mappedEntries?: AttributeValueMappingPreview[];
  /** Step 8's Price Adjustment Schedule / Lookup Table row needs to know this up front. Null/absent means none exists yet for this product. */
  existingSchedule?: ExistingScheduleSummary | null;

  /**
   * §REQUEST_LIMIT_EXCEEDED remediation — the COMPLETE, untouched result of
   * this route's own discoverProductAttributes call (the same data `product`/
   * `attributes` above are derived FROM, before being summarized down to
   * `DiscoveredAttributeSummary[]` for display). Only present on a success
   * response. The client carries this straight through as
   * `ProcedurePayload.discoveredAttributes` on the eventual create-procedure
   * call so that pipeline's own "Attribute Discovery" step can reuse it
   * instead of re-running the entire ~15-30-call discovery pipeline again
   * for the same product.
   */
  fullAttributeData?: ProductAttributeData;

  steps: ProcedureStep[];
  warnings: string[];
  error?: string;
  /** A user-friendly stop reason for genuine infrastructure problems (e.g. Salesforce session/API errors) — never a raw payload/field-name diagnostic (see friendlyMessage in AutoCreatePanel.tsx). */
  friendlyError?: string;
  debugLog?: DebugLogEntry[];
}

export interface DeploymentValidationReport {
  expressionSet: { status: "pass" | "fail"; checks: ValidationCheck[] };
  canvas: { status: "pass" | "fail"; checks: ValidationCheck[] };
  decisionTables: { status: "pass" | "fail"; tables: DecisionTableValidation[] };
  nativeRecords: { status: "pass" | "fail"; records: NativeRecordValidation[] };
  runtimePricing: { status: "pass" | "fail"; expectedVsActual: ExpectedVsActualCheck[]; executionReport?: ExecutionReport };
  overall: "pass" | "fail";
  steps: ProcedureStep[];
  warnings: string[];
  debugLog?: DebugLogEntry[];
}
