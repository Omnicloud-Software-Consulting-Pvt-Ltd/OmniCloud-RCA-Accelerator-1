/**
 * Bundle-Based Pricing — create-time result/failure shapes. Deliberately its own type module (same
 * stated convention as lib/pricing-rules/attribute-based/create/types.ts): nothing here is shared across
 * pricing types even where a shape looks identical to its attribute-based counterpart.
 */
import type { ComponentFailure, DeployStatusInfo } from "@/lib/pricing-rules/attribute-based/create/soapEnvelope";
import type { ParentStepValidationEntry } from "@/lib/pricing-rules/attribute-based/create/schemaDiff";
import type { ActivationAttemptDetail } from "@/lib/pricing-rules/attribute-based/create/activation";
import type { ExpressionSetDonorInspectionResult } from "./donorInspection";
import type { BundleDiscountBranchSelection } from "./canvasBuilder";
import type { ProcedureStepLite } from "../types";
import type { SanitizedAuditEntry } from "@/lib/salesforce/auditLog";
import type { ConnectExpressionSetResponse, ConnectExpressionSetVersion } from "@/lib/pricing-rules/attribute-based/create/verifySalesforceState";

export interface CreateFailure {
  step: string;
  endpoint?: string;
  httpStatus?: number;
  salesforceErrorCode?: string;
  salesforceErrorMessage?: string;
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
}

export interface ComponentVerificationResult {
  deployed: boolean;
  verified: boolean;
  verificationMethod: string;
  id: string | null;
  error?: string;
}

export interface BundleSalesforceVerificationSummary {
  bundle: boolean;
  componentsResolved: boolean;
  pricingRules: boolean;
  lookupTable: boolean;
  pricingElement: boolean;
  expressionSet: ComponentVerificationResult;
  expressionSetVersion: ComponentVerificationResult;
  pricingProcedure: ComponentVerificationResult;
}

export interface BundleGeneratedProcedureSnapshot {
  executionId: string;
  pricingType: "bundle-based";
  bundle: { name: string; id: string };
  components: { name: string; adjustmentType: string; adjustmentValue: number }[];
  salesforce: {
    priceAdjustmentScheduleId: string | null;
    bundleBasedAdjRuleIds: string[];
    bundleAdjustmentConditionIds: string[];
    bundleBasedAdjustmentIds: string[];
    expressionSetId: string | null;
    expressionSetVersionId: string | null;
    pricingProcedureApiName: string | null;
  };
  verificationStatus: "pending" | "verified" | "verified_with_warning" | "failed";
}

export interface BundlePricingLifecycleStatus {
  expressionSetDeployment: "success" | "failed";
  expressionSetVersionDeployment: "success" | "failed";
  expressionSetVersionResolution: "success" | "failed" | "skipped";
  activation: "success" | "failed" | "skipped" | "not_requested";
  pricingProcedure: "verified" | "deployed" | "not_verified";
}

export interface ExpressionSetVersionResolutionAudit {
  strategy: "connect-rest" | "fallback";
  metadataDeploymentComponentId: string | null;
  expressionSetId: string | null;
  expressionSetVersionId: string | null;
  verified: boolean;
  selectedBy: "deployment-id" | "api-name" | "full-name" | "version-name" | "version-number" | "sole-version" | null;
  request: { method: "GET"; path: string };
  response: ConnectExpressionSetResponse | null;
  method: string;
  selectedVersion: ConnectExpressionSetVersion | null;
  candidates: ConnectExpressionSetVersion[];
  error?: string;
}

export interface BundlePricingActivationAudit {
  attempted: boolean;
  versionId: string | null;
  success: boolean;
  status: "Draft" | "Active" | null;
  detail?: ActivationAttemptDetail;
}

export interface BundleAdjustmentDecision {
  step: "bundle-based-adjustment";
  ruleId: string;
  requestedConfiguration: {
    bundleProductId: string;
    componentProductId: string;
    scheduleId: string;
    effectiveFrom: string;
    effectiveTo: string;
  };
  componentSignature: string;
  candidateAdjustmentId: string | null;
  candidateCount: number;
  componentMatch: boolean;
  decision: "CREATE" | "REUSE";
  adjustmentId: string;
}

export interface CreateBundlePricingResult {
  success: boolean;
  error?: string;
  failure?: CreateFailure;
  warnings: string[];
  steps: ProcedureStepLite[];
  status?: "success" | "deployed_with_verification_warning" | "failed";
  deploymentSummary?: { success: boolean; deploymentId: string | null; componentsDeployed: number; errors: number };
  verificationWarning?: string;
  lifecycleStatus?: BundlePricingLifecycleStatus;
  expressionSetVersionResolution?: ExpressionSetVersionResolutionAudit;
  activationAudit?: BundlePricingActivationAudit;
  expressionSetDonorInspection?: ExpressionSetDonorInspectionResult;
  executionId: string;
  auditLog: SanitizedAuditEntry[];
  procedureSnapshot: BundleGeneratedProcedureSnapshot;
  adjustmentDecisions?: BundleAdjustmentDecision[];
  expressionSetValidation?: Record<string, { status: "PASS" | "FAIL"; missing: string[]; unexpected: string[]; orderMatch: boolean }>;
  parentStepValidation?: ParentStepValidationEntry[];
  duplicateStepNames?: string[];
  deployPayloadFingerprint?: string;
  listPriceOutputValidation?: { donorOutputs: string[]; generatedOutputs: string[]; outputCount: number; valid: boolean };
  bundleDiscountInputBinding?: {
    listPriceOutputValues: string[];
    inputUnitPriceValue: string | null;
    originalInputUnitPriceValue: string | null;
    wasPatched: boolean;
    valid: boolean;
  };
  hierarchyComparison?: {
    donorStepCount: number;
    generatedStepCount: number;
    missingDonorOccurrences: number[];
    hierarchyMatches: boolean;
    donorTree: string;
    generatedTree: string;
  };
  donorExtractionDeterministic?: boolean;
  bundleDiscountBranchSelection?: BundleDiscountBranchSelection;

  bundle?: { id: string; name: string };
  priceAdjustmentScheduleId?: string;
  ruleIds?: string[];
  conditionIds?: string[];
  adjustmentIds?: string[];
  ignoredComponents?: string[];
  expressionSetId?: string;
  expressionSetApiName?: string;
  expressionSetVersionId?: string;
  versionStatus?: "Draft" | "Active";
  verification?: BundleSalesforceVerificationSummary;
}

export type CreateStreamEvent =
  | { type: "step"; step: string; status: "running" | "done" | "failed" | "warning"; detail?: string }
  | { type: "result"; result: CreateBundlePricingResult };
