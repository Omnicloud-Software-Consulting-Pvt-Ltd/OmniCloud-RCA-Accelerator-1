/**
 * "Salesforce Records" navigation section for Tier-Based Pricing — mirrors
 * lib/pricing-rules/volume-based/create/salesforceRecordLinks.ts's generic Expression Set/version-list
 * rows exactly, with the native-object row renamed to PriceAdjustmentTier.
 */
import { buildSalesforceRecordUrl, buildSalesforceObjectHomeUrl } from "@/lib/salesforce/recordUrl";

export type SalesforceRecordCategory = "pricingProcedure" | "expressionSet" | "expressionSetVersion" | "priceAdjustmentSchedule" | "priceAdjustmentTiers";

export interface SalesforceRecordLink {
  category: SalesforceRecordCategory;
  key: string;
  label: string;
  name: string | null;
  id: string | null;
  count?: number;
  status: "verified" | "active" | "draft" | "not_verified" | "unknown";
  url: string | null;
  actionLabel: string;
}

export interface TierPricingSalesforceRecordsInput {
  expressionSetId?: string | null;
  expressionSetApiName?: string | null;
  expressionSetVersionId?: string | null;
  versionStatus?: "Draft" | "Active" | null;
  priceAdjustmentScheduleId?: string | null;
  tierCount?: number;
  verification?: {
    expressionSet?: { verified: boolean };
    expressionSetVersion?: { verified: boolean };
    pricingProcedure?: { verified: boolean };
  };
}

export function buildTierPricingSalesforceRecords(
  instanceUrl: string | null,
  input: TierPricingSalesforceRecordsInput,
): SalesforceRecordLink[] {
  const recordLink = (objectApiName: string, id: string | null | undefined): string | null =>
    instanceUrl && id ? buildSalesforceRecordUrl(instanceUrl, objectApiName, id) : null;
  const homeLink = (objectApiName: string): string | null =>
    instanceUrl ? buildSalesforceObjectHomeUrl(instanceUrl, objectApiName) : null;

  const versionActive = input.versionStatus === "Active";
  const versionStatus: SalesforceRecordLink["status"] = versionActive ? "active" : input.versionStatus === "Draft" ? "draft" : "unknown";

  return [
    {
      category: "pricingProcedure", key: "pricingProcedure", label: "Pricing Procedure",
      name: input.expressionSetApiName ?? null, id: input.expressionSetId ?? null,
      status: input.verification?.pricingProcedure?.verified ? "verified" : "not_verified",
      url: recordLink("ExpressionSet", input.expressionSetId), actionLabel: "Open in Salesforce",
    },
    {
      category: "expressionSet", key: "expressionSet", label: "Expression Set",
      name: input.expressionSetApiName ?? null, id: input.expressionSetId ?? null,
      status: input.verification?.expressionSet?.verified ? "verified" : "not_verified",
      url: recordLink("ExpressionSet", input.expressionSetId), actionLabel: "Open in Salesforce",
    },
    {
      category: "expressionSetVersion", key: "expressionSetVersion", label: "Expression Set Version",
      name: null, id: input.expressionSetVersionId ?? null,
      status: input.expressionSetVersionId ? versionStatus : "not_verified",
      url: recordLink("ExpressionSetVersion", input.expressionSetVersionId),
      actionLabel: versionActive ? "Open in Salesforce" : "Open & Activate",
    },
    {
      category: "priceAdjustmentSchedule", key: "priceAdjustmentSchedule", label: "Price Adjustment Schedule",
      name: null, id: input.priceAdjustmentScheduleId ?? null,
      status: input.priceAdjustmentScheduleId ? "verified" : "not_verified",
      url: recordLink("PriceAdjustmentSchedule", input.priceAdjustmentScheduleId), actionLabel: "Open in Salesforce",
    },
    {
      category: "priceAdjustmentTiers", key: "priceAdjustmentTiers", label: "Price Adjustment Tiers",
      name: null, id: null, count: input.tierCount ?? 0,
      status: (input.tierCount ?? 0) > 0 ? "verified" : "not_verified",
      url: homeLink("PriceAdjustmentTier"), actionLabel: "View in Salesforce",
    },
  ];
}
