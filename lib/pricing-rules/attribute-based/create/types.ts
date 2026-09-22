/**
 * Parts G-Q — the Salesforce-write creation pipeline's own result/failure
 * shapes. Kept separate from ../types.ts (the read-only analysis module) —
 * this is the first stage where Salesforce write operations are allowed,
 * so its result shape is deliberately explicit about exactly what was
 * created vs. reused vs. never attempted (Part R: never report success
 * unless read-back confirms it).
 */
import type { ComponentFailure, DeployStatusInfo } from "./soapEnvelope";
import type { ProcedureStepLite } from "../types";
import type { SanitizedAuditEntry } from "@/lib/salesforce/auditLog";
import type { AdjustmentDecision, AdjustmentConflict, MissingAttributeConfigInfo, ResolvedAttributeConfigInfo } from "./nativeRecords";
import type { ParentStepValidationEntry } from "./schemaDiff";
import type { AttributeDiscountBranchSelection } from "./canvasBuilder";
import type { ConnectExpressionSetResponse, ConnectExpressionSetVersion } from "./verifySalesforceState";
import type { ActivationAttemptDetail } from "./activation";
import type { ExpressionSetDonorInspectionResult } from "./donorInspection";
import type { SalesforceCapacityPreflightResult } from "./capacityPreflight";

/**
 * §Phase 5 fix (generic failure-category classification) — never step-specific: a storage or API
 * exhaustion can surface at ANY pipeline stage (native-record creation, Expression Set Version deploy,
 * Pricing Procedure creation, activation), and must be labeled identically wherever it happens. See
 * `errorDiagnostics.ts`'s `classifyFailureCategory`/`classifyComponentFailures`.
 */
export type SalesforceFailureCategory = "salesforce-storage-limit" | "salesforce-api-limit";

export interface CreateFailure {
  step: string;
  endpoint?: string;
  httpStatus?: number;
  salesforceErrorCode?: string;
  salesforceErrorMessage?: string;
  /** Set only when this failure matches a recognized Salesforce org-capacity pattern — never invented,
   * never inferred from which step failed. Absent (not `undefined`-valued but genuinely omitted) for every
   * other kind of failure, so its mere presence is itself the signal a UI can key off of. */
  category?: SalesforceFailureCategory;
  reason: string;
  resolutionHint: string;
  object?: string;
  operation?: string;
  salesforceId?: string | null;
  lastSuccessfulStep?: string | null;
  packagingReport?: string;
  schemaReport?: string;
  deployComponentFailures?: ComponentFailure[];
  deployFullStatus?: DeployStatusInfo | null;
  generatedFileXml?: string;
  deployZipBase64?: string;
  rawDeployStatusXml?: string;
  /** §Follow-on 42 — present only for the specific "one or more price-impacting attributes have no
   * resolvable base value" failure. Never invented candidate values — each entry's `candidateValues`
   * is the exact set `resolveBaseProductConfiguration` found on Salesforce for that attribute (possibly
   * empty, possibly 2+ meaning genuine ambiguity a human must resolve). Lets the UI offer a real
   * "configure and retry" flow instead of only a text error. */
  missingAttributeConfig?: MissingAttributeConfigInfo[];
  /** The attributes that DID resolve, alongside the failing ones — so the UI can render the complete
   * ✓/⚠ checklist the user requested, not just the failing row. */
  resolvedAttributeConfig?: ResolvedAttributeConfigInfo[];
}

export interface CreatedValueRecord {
  attributeName: string;
  value: string;
  id: string;
}

/** §Deploy-vs-read-back distinction — `deployed` reflects the real, first-party Salesforce Metadata API
 * deploy result (the only thing that can make the OVERALL creation FAILED); `verified` reflects whether
 * a SUBSEQUENT direct read-back could also confirm the record — these are deliberately independent
 * claims. `verificationMethod` names the exact SOQL query or derivation used (never a fabricated object
 * name), and `error` carries a genuine Salesforce error message when the lookup itself failed (never
 * silently swallowed) rather than the record simply not existing. */
export interface ComponentVerificationResult {
  deployed: boolean;
  verified: boolean;
  verificationMethod: string;
  id: string | null;
  error?: string;
}

/** Part Q — Salesforce read-back verification. `expressionSet`/`expressionSetVersion`/`pricingProcedure`
 * are rich per-component results (see `ComponentVerificationResult`) since deploy success and read-back
 * confirmation are independent claims for those metadata-backed objects; the other components (native
 * records created directly via REST, not Metadata API) remain plain booleans since read-after-write lag
 * is not a concern for them. */
export interface SalesforceVerificationSummary {
  product: boolean;
  attributesValues: boolean;
  pricingRules: boolean;
  lookupTable: boolean;
  pricingElement: boolean;
  expressionSet: ComponentVerificationResult;
  expressionSetVersion: ComponentVerificationResult;
  pricingProcedure: ComponentVerificationResult;
}

/**
 * §Part 14/15 — the complete logical Attribute-Based Pricing configuration, reflecting whatever
 * Salesforce Ids are ACTUALLY known at the point this snapshot is built (null/empty until that stage
 * completes) — never a fabricated Id. Built once, at the end of a run (success or failure), from the
 * exact same local state the pipeline itself used.
 */
export interface GeneratedProcedureSnapshot {
  executionId: string;
  pricingType: "attribute-based";
  product: { name: string; id: string };
  attributes: { name: string; label: string; values: string[] }[];
  pricingRules: { attribute: string; value: string; adjustmentType: string; adjustmentValue: number }[];
  salesforce: {
    priceAdjustmentScheduleId: string | null;
    attributeBasedAdjustmentRuleIds: string[];
    attributeAdjustmentConditionIds: string[];
    attributeBasedAdjustmentIds: string[];
    expressionSetId: string | null;
    expressionSetVersionId: string | null;
    /** Same underlying record as `expressionSetId` — Salesforce's "Pricing Procedure" IS the deployed ExpressionSet, not a separate object. */
    pricingProcedureApiName: string | null;
  };
  verificationStatus: "pending" | "verified" | "verified_with_warning" | "failed";
}

/** §Part 9/11 — the deploy/read-back layer is not one boolean: Salesforce's Metadata API deploy creates
 * the ExpressionSet + ExpressionSetVersion + steps in a single call, but resolving the real
 * ExpressionSetVersion Id (via Connect REST or its SOQL fallback), activating it, and confirming that
 * activation are each their own independent outcome. "skipped" (not "in_progress") is used for a stage
 * a synchronous run never got to attempt because an earlier stage in this same chain didn't resolve —
 * there is no genuinely async/pending state once this result has been returned. */
export interface AttributePricingLifecycleStatus {
  expressionSetDeployment: "success" | "failed";
  expressionSetVersionDeployment: "success" | "failed";
  expressionSetVersionResolution: "success" | "failed" | "skipped";
  activation: "success" | "failed" | "skipped" | "not_requested";
  pricingProcedure: "verified" | "deployed" | "not_verified";
}

/** §Final Fix / Part "UI / JSON DETAILS" — the exact Connect REST request/response and
 * version-resolution decision, for the "API/JSON Details" audit panel. The raw request/response also
 * already appears in the generic `auditLog` (every `client.request()` call is instrumented there) —
 * this field additionally carries the STRUCTURED matching decision (strategy/candidates/selected
 * version/selectedBy/verified) that the generic audit log doesn't parse out. `strategy` no longer
 * includes a "metadata-component-id" option — live evidence (a real HTTP 404 on activation) proved the
 * ExpressionSetDefinition deployment component's own Id is NOT an ExpressionSetVersion Id, so that path
 * was removed entirely; Connect REST is now the only genuine resolution source, with a Describe-verified
 * SOQL lookup as the sole fallback. */
export interface ExpressionSetVersionResolutionAudit {
  strategy: "connect-rest" | "fallback";
  /** The Metadata API deployment component's own Id — kept ONLY for logging/debugging (per explicit
   * instruction, three completely separate identities). NEVER the same value as `expressionSetId` or
   * `expressionSetVersionId` unless independently proven identical (never observed on this org). */
  metadataDeploymentComponentId: string | null;
  expressionSetId: string | null;
  expressionSetVersionId: string | null;
  /** True only once `expressionSetVersionId` has been independently confirmed as a real
   * ExpressionSetVersion record via direct Id read-back — never merely "selected from Connect REST's
   * response." */
  verified: boolean;
  selectedBy: "deployment-id" | "api-name" | "full-name" | "version-name" | "version-number" | "sole-version" | null;
  request: { method: "GET"; path: string };
  response: ConnectExpressionSetResponse | null;
  method: string;
  selectedVersion: ConnectExpressionSetVersion | null;
  candidates: ConnectExpressionSetVersion[];
  error?: string;
}

/** §UI / JSON AUDIT — the exact activation-lifecycle summary requested this turn, kept separate from
 * `ExpressionSetVersionResolutionAudit` so the UI can render `{ expressionSet, expressionSetVersion,
 * activation }` as three clearly-distinct identities/outcomes without conflating resolution with
 * activation. */
export interface AttributePricingActivationAudit {
  attempted: boolean;
  versionId: string | null;
  success: boolean;
  status: "Draft" | "Active" | null;
  /** §"If activation fails, show: exact endpoint/action used, HTTP status, Salesforce errorCode,
   * Salesforce message, version Id, current status, whether the activation request was actually
   * attempted" — the full diagnostic detail from `activateExpressionSetVersion`, present whenever
   * activation was requested (`attempted` above may be true here even if it ultimately couldn't proceed
   * because no supported field was found). */
  detail?: ActivationAttemptDetail;
}

export interface CreateAttributePricingResult {
  success: boolean;
  error?: string;
  failure?: CreateFailure;
  warnings: string[];
  steps: ProcedureStepLite[];
  /** §Three-state model — `success` alone can't distinguish "fully confirmed" from "deployed but
   * read-back incomplete"; `status` makes that explicit. `deployed_with_verification_warning` is only
   * ever set when `success` is ALSO true (Salesforce's own deploy result is the only thing that can make
   * the overall creation `failed`; an incomplete read-back on an already-successful deploy never does). */
  status?: "success" | "deployed_with_verification_warning" | "failed" | "pending-adjustment-confirmation" | "blocked";
  /** §Phase 3/4/11 fix (generic Salesforce capacity preflight) — present whenever the combinatorial
   * closure's storage/API cost was checked against this org's REAL, live `/limits` before any combination
   * write was attempted. `status: "blocked"` (with this field's own `status: "BLOCKED"`) means the run
   * stopped here — zero combination Rules/Conditions/Adjustments were created — because proceeding would
   * predictably exhaust this org's Data Storage partway through, exactly reproducing the
   * "storage limit exceeded" failure this fix exists to catch BEFORE it happens, not after. Every field on
   * it is dynamically computed from the connected org/product — never a hardcoded product or org value. */
  capacityPreflight?: SalesforceCapacityPreflightResult;
  /** §Phase 8/9/10/24 — present only when `status === "pending-adjustment-confirmation"`: one or more
   * Rules resolved to an AttributeBasedAdjustment identity that already exists in Salesforce with a
   * DIFFERENT adjustment value than this request wants. Never auto-resolved. Resubmit the SAME create
   * request with `adjustmentDecisions` (keyed by `adjustmentDecisionKey(attributeName, value)`, from
   * "./nativeRecords") set to `"USE_EXISTING"` or `"USE_NEW"` for each entry here to proceed — every
   * other already-created/reused/updated record from this attempt is found and reused again
   * automatically, never re-done. */
  pendingAdjustmentConflicts?: AdjustmentConflict[];
  /** §Part 3 — the actual Metadata API deploy result identifiers, captured directly from Salesforce's
   * own response rather than reconstructed from the UI-supplied name. Present once the deploy call has
   * returned, whether it succeeded or not. */
  deploymentSummary?: { success: boolean; deploymentId: string | null; componentsDeployed: number; errors: number };
  /** §Part 4/11 — set only when `status === "deployed_with_verification_warning"`; names exactly which
   * component(s) could not be confirmed via direct read-back despite a successful deploy. */
  verificationWarning?: string;
  /** §Part 9/11 — the granular per-stage lifecycle breakdown (deploy/resolve/activate/verify), so a
   * pending activation is never reported as an undifferentiated "verification warning." Present once
   * the deploy stage has run, success or failure. */
  lifecycleStatus?: AttributePricingLifecycleStatus;
  /** §Part 15 — present once ExpressionSetVersion resolution has been attempted (i.e. once an
   * ExpressionSet Id was resolved), whether or not it succeeded. */
  expressionSetVersionResolution?: ExpressionSetVersionResolutionAudit;
  /** §UI / JSON AUDIT — present once activation has been attempted (or explicitly not requested). */
  activationAudit?: AttributePricingActivationAudit;
  /** §Phase 2 — evidence-only ExpressionSetDefinition donor inventory (never affects which donor the
   * real build actually uses). Present once the diagnostic-only inspection stage has run, whether it
   * succeeded or not (a failure there only ever produces a warning, never blocks the real pipeline). */
  expressionSetDonorInspection?: ExpressionSetDonorInspectionResult;

  /** §Part 21 — unique per creation attempt, e.g. "ABP-20260817-093201-7F42"; threaded through server
   * logs, this result, and every UI surface so a single Id can correlate all three. */
  executionId: string;
  /** §Part 11-13/16 — sanitized request/response JSON for every Salesforce REST operation this run
   * performed, in chronological order. Always present (possibly empty), even on failure (Part 20). */
  auditLog: SanitizedAuditEntry[];
  /** §Part 14/15 — always present (possibly mostly-null on an early failure), even on failure (Part 20). */
  procedureSnapshot: GeneratedProcedureSnapshot;
  /** §Part 18 — the exact CREATE-vs-REUSE decision (with the requested configuration + candidate
   * comparison) for every AttributeBasedAdjustment this run attempted. Only present once the
   * create-adjustment stage has run. */
  adjustmentDecisions?: AdjustmentDecision[];
  /** Per-step (ListPrice/AttributeDiscount/PricingSettings) structural comparison against the donor
   * Expression Set — present once the build-expression-set stage has run, whether it passed or not. */
  expressionSetValidation?: Record<string, { status: "PASS" | "FAIL"; missing: string[]; unexpected: string[]; orderMatch: boolean }>;
  /** §Referential integrity — per-step check that each <parentStep> VALUE resolves to a real step in
   * the final generated set and matches the donor's own value; present once the build-expression-set
   * stage has run, whether every step passed or not. */
  parentStepValidation?: ParentStepValidationEntry[];
  /** Generated step names that appear more than once — Salesforce cannot resolve a <parentStep>
   * reference unambiguously when two steps share a name. Empty when none found. */
  duplicateStepNames?: string[];
  /** §Payload fingerprint — sha256 of the exact Expression Set XML string that was both validated and
   * sent to Salesforce's Metadata API, so a caller can independently confirm the two were the same
   * payload rather than trusting a comment. Present once the build-expression-set stage has run. */
  deployPayloadFingerprint?: string;
  /** §Pricing-waterfall — ListPrice's own (donor-verbatim, never patched or renamed) output Parameter
   * value(s). `valid` only requires at least one real output to exist — never a specific literal name. */
  listPriceOutputValidation?: { donorOutputs: string[]; generatedOutputs: string[]; outputCount: number; valid: boolean };
  /** §Pricing-waterfall — AttributeDiscount's InputUnitPrice value, checked against ListPrice's real
   * (donor-verbatim) output values. `inputUnitPriceValue` is the FINAL value (post-patch);
   * `originalInputUnitPriceValue` is the donor's raw value; `wasPatched` is true only when the donor's
   * own value was inconsistent AND ListPrice published exactly one unambiguous output to align to. */
  attributeDiscountInputBinding?: {
    listPriceOutputValues: string[];
    inputUnitPriceValue: string | null;
    originalInputUnitPriceValue: string | null;
    wasPatched: boolean;
    valid: boolean;
  };
  /** §Complete donor/generated hierarchy comparison — total physical step counts (every depth, every
   * container/list/child step), any donor step (by OCCURRENCE INDEX, never by name — see
   * canvasBuilder.ts's file-level "Occurrence-based identity" note) missing from the generated set, and
   * rendered physical-nesting trees for visual diff. Present once the build-expression-set stage has
   * assembled the final file. */
  hierarchyComparison?: {
    donorStepCount: number;
    generatedStepCount: number;
    missingDonorOccurrences: number[];
    hierarchyMatches: boolean;
    donorTree: string;
    generatedTree: string;
  };
  /** §Gate A — sanity check on the occurrence-graph extraction itself (re-run twice on identical donor
   * bytes must agree); this architecture never parses-and-reserializes a DOM, so there's no serializer
   * to test for round-trip loss, only the extraction function. */
  donorExtractionDeterministic?: boolean;
  /** §Gate B / Part 6 — donor vs. generated identity-field (name/actionType/parentStep/sequenceNumber)
   * drift, by occurrence index. Must always be empty; any entry is a hard failure. */
  identityFieldDrift?: { occurrenceIndex: number; pathLabel: string; field: string; donorValue: string | null; generatedValue: string | null }[];
  /** §Gate B / Part 15 — root-branch content-hash comparison, skipping only the branch containing the
   * patched AttributeDiscount occurrence. `changedBranches` must always be empty. */
  unrelatedBranchIntegrity?: { checkedBranches: number; changedBranches: string[] };
  /** §Parts 2-8/12/15 — every physical AttributeDiscount branch candidate discovered in the donor, with
   * full ancestry/signal/score diagnostics, and which one (if any) was deterministically selected as the
   * Attribute-Based Pricing branch — never by array index, never by a single field alone. */
  attributeDiscountBranchSelection?: AttributeDiscountBranchSelection;

  product?: { id: string; name: string };
  priceAdjustmentScheduleId?: string;
  createdValues?: CreatedValueRecord[];
  existingValuesReused?: CreatedValueRecord[];
  ruleIds?: string[];
  conditionIds?: string[];
  adjustmentIds?: string[];
  excludedAttributes?: string[];
  expressionSetId?: string;
  expressionSetApiName?: string;
  expressionSetVersionId?: string;
  versionStatus?: "Draft" | "Active";
  verification?: SalesforceVerificationSummary;
}

export type CreateStreamEvent =
  | { type: "step"; step: string; status: "running" | "done" | "failed" | "warning"; detail?: string }
  | { type: "result"; result: CreateAttributePricingResult };
