/**
 * Volume-Based Pricing — create-time result/failure shapes. Deliberately its own type module (same
 * stated convention as the sibling attribute-based/bundle-based `create/types.ts`).
 */
import type { ComponentFailure, DeployStatusInfo } from "@/lib/pricing-rules/attribute-based/create/soapEnvelope";
import type { ActivationAttemptDetail } from "@/lib/pricing-rules/attribute-based/create/activation";
import type { ExpressionSetDonorInspectionResult, VolumeDiscountBranchInspection } from "./donorInspection";
import type { ProcedureStepLite, VolumeTier } from "../types";
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

export interface VolumeSalesforceVerificationSummary {
  product: boolean;
  scheduleVerified: boolean;
  tierCount: number;
  pricingElement: boolean;
  expressionSet: ComponentVerificationResult;
  expressionSetVersion: ComponentVerificationResult;
  pricingProcedure: ComponentVerificationResult;
}

export interface VolumeGeneratedProcedureSnapshot {
  executionId: string;
  pricingType: "volume-based";
  product: { name: string; id: string };
  tiers: VolumeTier[];
  salesforce: {
    priceAdjustmentScheduleId: string | null;
    priceAdjustmentTierIds: string[];
    expressionSetId: string | null;
    expressionSetVersionId: string | null;
    pricingProcedureApiName: string | null;
  };
  verificationStatus: "pending" | "verified" | "verified_with_warning" | "failed";
}

export interface VolumePricingLifecycleStatus {
  expressionSetDeployment: "success" | "failed";
  expressionSetVersionDeployment: "success" | "failed";
  expressionSetVersionResolution: "success" | "failed" | "skipped";
  activation: "success" | "failed" | "skipped" | "not_requested";
  scheduleActivation: "success" | "failed" | "skipped";
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

export interface VolumePricingActivationAudit {
  attempted: boolean;
  versionId: string | null;
  success: boolean;
  status: "Draft" | "Active" | null;
  detail?: ActivationAttemptDetail;
}

export interface CanvasStepPlan { seq: number; actionType: string; label: string; description: string; }

export interface CreateVolumePricingResult {
  success: boolean;
  error?: string;
  failure?: CreateFailure;
  warnings: string[];
  steps: ProcedureStepLite[];
  status?: "success" | "deployed_with_verification_warning" | "failed";
  deploymentSummary?: { success: boolean; deploymentId: string | null; componentsDeployed: number; errors: number };
  verificationWarning?: string;
  lifecycleStatus?: VolumePricingLifecycleStatus;
  expressionSetVersionResolution?: ExpressionSetVersionResolutionAudit;
  activationAudit?: VolumePricingActivationAudit;
  expressionSetDonorInspection?: ExpressionSetDonorInspectionResult;
  volumeDiscountBranchSelection?: VolumeDiscountBranchInspection;
  executionId: string;
  auditLog: SanitizedAuditEntry[];
  procedureSnapshot: VolumeGeneratedProcedureSnapshot;
  expressionSetValidation?: Record<string, { status: "PASS" | "FAIL"; missing: string[]; unexpected: string[]; orderMatch: boolean }>;
  deployPayloadFingerprint?: string;
  volumeDiscountInputBinding?: {
    listPriceOutputValues: string[];
    inputUnitPriceValue: string | null;
    originalInputUnitPriceValue: string | null;
    wasPatched: boolean;
    valid: boolean;
  };

  product?: { id: string; name: string };
  priceAdjustmentScheduleId?: string;
  tierIds?: string[];
  tiersCreated?: number;
  resolvedAdjustmentMethod?: string;
  expressionSetId?: string;
  expressionSetApiName?: string;
  expressionSetVersionId?: string;
  versionStatus?: "Draft" | "Active";
  scheduleActivated?: boolean;
  verification?: VolumeSalesforceVerificationSummary;
  canvasSteps?: CanvasStepPlan[];
  canvasDeployed?: boolean;
  canvasStepCount?: number;
  deployError?: string;
  pricingType?: "volume-based";
}

export type CreateStreamEvent =
  | { type: "step"; step: string; status: "running" | "done" | "failed" | "warning"; detail?: string }
  | { type: "result"; result: CreateVolumePricingResult };
