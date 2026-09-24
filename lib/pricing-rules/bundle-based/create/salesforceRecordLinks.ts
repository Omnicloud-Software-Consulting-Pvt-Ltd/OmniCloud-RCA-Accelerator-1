/**
 * "Salesforce Records" navigation section for Bundle-Based Pricing — mirrors
 * lib/pricing-rules/attribute-based/create/salesforceRecordLinks.ts's generic Expression Set/version-list
 * rows exactly, with the 3 native-object rows renamed to the Bundle-Based object family.
 */
import { buildSalesforceRecordUrl, buildSalesforceObjectHomeUrl } from "@/lib/salesforce/recordUrl";

export type SalesforceRecordCategory =
  | "pricingProcedure" | "expressionSet" | "expressionSetVersion" | "priceAdjustmentSchedule"
  | "bundleBasedAdjustments" | "bundleAdjustmentConditions" | "bundleBasedAdjRules";

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

export interface BundlePricingVersionCandidate { id: string | null; versionNumber: string | number | null; enabled: boolean | null; }

export interface BundlePricingSalesforceRecordsInput {
  expressionSetId?: string | null;
  expressionSetApiName?: string | null;
  expressionSetVersionId?: string | null;
  versionStatus?: "Draft" | "Active" | null;
  priceAdjustmentScheduleId?: string | null;
  ruleCount?: number;
  conditionCount?: number;
  adjustmentCount?: number;
  allVersions?: BundlePricingVersionCandidate[];
  verification?: {
    expressionSet?: { verified: boolean };
    expressionSetVersion?: { verified: boolean };
    pricingProcedure?: { verified: boolean };
  };
}

export function buildBundlePricingSalesforceRecords(
  instanceUrl: string | null,
  input: BundlePricingSalesforceRecordsInput,
): SalesforceRecordLink[] {
  const recordLink = (objectApiName: string, id: string | null | undefined): string | null =>
    instanceUrl && id ? buildSalesforceRecordUrl(instanceUrl, objectApiName, id) : null;
  const homeLink = (objectApiName: string): string | null =>
    instanceUrl ? buildSalesforceObjectHomeUrl(instanceUrl, objectApiName) : null;

  const versionActive = input.versionStatus === "Active";
  const versionStatus: SalesforceRecordLink["status"] = versionActive ? "active" : input.versionStatus === "Draft" ? "draft" : "unknown";

  const versionRows: SalesforceRecordLink[] = (input.allVersions && input.allVersions.length > 0)
    ? [...input.allVersions]
        .sort((a, b) => {
          const an = Number(a.versionNumber), bn = Number(b.versionNumber);
          return Number.isFinite(an) && Number.isFinite(bn) ? an - bn : 0;
        })
        .map((v, i) => {
          const isSelected = !!v.id && v.id === input.expressionSetVersionId;
          const active = isSelected ? versionActive : v.enabled === true;
          return {
            category: "expressionSetVersion" as const,
            key: `expressionSetVersion-${v.id ?? i}`,
            label: `Expression Set Version V${v.versionNumber ?? i + 1}`,
            name: null, id: v.id ?? null,
            status: !v.id ? "not_verified" as const : active ? "active" as const : (isSelected ? versionStatus : "draft" as const),
            url: recordLink("ExpressionSetVersion", v.id),
            actionLabel: active ? "Open in Salesforce" : "Open & Activate",
          };
        })
    : [{
        category: "expressionSetVersion", key: "expressionSetVersion",
        label: "Expression Set Version",
        name: null, id: input.expressionSetVersionId ?? null,
        status: input.expressionSetVersionId ? versionStatus : "not_verified",
        url: recordLink("ExpressionSetVersion", input.expressionSetVersionId),
        actionLabel: versionActive ? "Open in Salesforce" : "Open & Activate",
      }];

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
    ...versionRows,
    {
      category: "priceAdjustmentSchedule", key: "priceAdjustmentSchedule", label: "Price Adjustment Schedule",
      name: null, id: input.priceAdjustmentScheduleId ?? null,
      status: input.priceAdjustmentScheduleId ? "verified" : "not_verified",
      url: recordLink("PriceAdjustmentSchedule", input.priceAdjustmentScheduleId), actionLabel: "Open in Salesforce",
    },
    {
      category: "bundleBasedAdjustments", key: "bundleBasedAdjustments", label: "Bundle-Based Adjustments",
      name: null, id: null, count: input.adjustmentCount ?? 0,
      status: (input.adjustmentCount ?? 0) > 0 ? "verified" : "not_verified",
      url: homeLink("BundleBasedAdjustment"), actionLabel: "View in Salesforce",
    },
    {
      category: "bundleAdjustmentConditions", key: "bundleAdjustmentConditions", label: "Bundle Adjustment Conditions",
      name: null, id: null, count: input.conditionCount ?? 0,
      status: (input.conditionCount ?? 0) > 0 ? "verified" : "not_verified",
      url: homeLink("BundleAdjustmentCondition"), actionLabel: "View in Salesforce",
    },
    {
      category: "bundleBasedAdjRules", key: "bundleBasedAdjRules", label: "Bundle-Based Adjustment Rules",
      name: null, id: null, count: input.ruleCount ?? 0,
      status: (input.ruleCount ?? 0) > 0 ? "verified" : "not_verified",
      url: homeLink("BundleBasedAdjRule"), actionLabel: "View in Salesforce",
    },
  ];
}
