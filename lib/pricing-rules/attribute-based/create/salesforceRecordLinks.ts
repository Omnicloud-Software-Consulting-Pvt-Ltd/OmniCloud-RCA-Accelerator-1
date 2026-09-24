/**
 * §"Salesforce Records" navigation section — pure, client-safe link-building for the post-creation UI.
 * Deliberately accepts ONLY the already-verified identities this pipeline resolved (expressionSetId,
 * expressionSetVersionId, priceAdjustmentScheduleId, ...) — there is no `metadataDeploymentComponentId`
 * parameter anywhere in this file's input type, so a Metadata API deployment component's own Id
 * structurally CANNOT be used for navigation here, by construction, not by a runtime check.
 */
import { buildSalesforceRecordUrl, buildSalesforceObjectHomeUrl } from "@/lib/salesforce/recordUrl";

export type SalesforceRecordCategory =
  | "pricingProcedure" | "expressionSet" | "expressionSetVersion" | "priceAdjustmentSchedule"
  | "attributeBasedAdjustments" | "attributeAdjustmentConditions" | "attributeBasedAdjRules";

export interface SalesforceRecordLink {
  category: SalesforceRecordCategory;
  /** Unique across the returned list — defaults to `category`, but multiple rows sharing one category
   * (every ExpressionSetVersion row when `allVersions` is supplied) each get their own distinct key so a
   * `<div key={r.key}>` in the UI never collides. */
  key: string;
  label: string;
  name: string | null;
  id: string | null;
  count?: number;
  status: "verified" | "active" | "draft" | "not_verified" | "unknown";
  url: string | null;
  actionLabel: string;
}

export interface AttributePricingVersionCandidate {
  id: string | null;
  versionNumber: string | number | null;
  enabled: boolean | null;
}

export interface AttributePricingSalesforceRecordsInput {
  expressionSetId?: string | null;
  expressionSetApiName?: string | null;
  expressionSetVersionId?: string | null;
  versionStatus?: "Draft" | "Active" | null;
  priceAdjustmentScheduleId?: string | null;
  ruleCount?: number;
  conditionCount?: number;
  adjustmentCount?: number;
  /** §Section 6/11 — every ExpressionSetVersion Connect REST actually reported for this ExpressionSet
   * (not just the one this run resolved/activated) — when present and non-empty, this replaces the
   * single "Expression Set Version" row below with one row PER version, so a repeated creation's V1/V2/V3
   * history is genuinely visible rather than only ever showing whichever version this run touched. */
  allVersions?: AttributePricingVersionCandidate[];
  verification?: {
    expressionSet?: { verified: boolean };
    expressionSetVersion?: { verified: boolean };
    pricingProcedure?: { verified: boolean };
  };
}

/** Builds the 7-row "Salesforce Records" navigation list. `instanceUrl` of `null` (session not loaded
 * yet, or not connected) simply produces `url: null` for every row rather than throwing — the caller
 * decides how to render a link-less row (e.g. disable the button). */
export function buildAttributePricingSalesforceRecords(
  instanceUrl: string | null,
  input: AttributePricingSalesforceRecordsInput,
): SalesforceRecordLink[] {
  const recordLink = (objectApiName: string, id: string | null | undefined): string | null =>
    instanceUrl && id ? buildSalesforceRecordUrl(instanceUrl, objectApiName, id) : null;
  const homeLink = (objectApiName: string): string | null =>
    instanceUrl ? buildSalesforceObjectHomeUrl(instanceUrl, objectApiName) : null;

  const versionActive = input.versionStatus === "Active";
  const versionStatus: SalesforceRecordLink["status"] = versionActive ? "active" : input.versionStatus === "Draft" ? "draft" : "unknown";

  // §Section 11 — one row per version Connect REST actually reported, ordered oldest-to-newest by
  // VersionNumber when every candidate has one, else left in the order Connect REST returned them
  // (never resorted by anything invented). Falls back to the single already-existing row below when no
  // candidate list was supplied at all (e.g. resolution failed) — never an empty "Expression Set Version"
  // section.
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
    // §"Pricing Procedure" IS the deployed ExpressionSet — Salesforce's own business term for it, with
    // no separate SObject in this org's schema (confirmed via Describe in an earlier turn). Reusing
    // `expressionSetId` here is that already-proven identity, never a guess.
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
      category: "attributeBasedAdjustments", key: "attributeBasedAdjustments", label: "Attribute-Based Adjustments",
      name: null, id: null, count: input.adjustmentCount ?? 0,
      status: (input.adjustmentCount ?? 0) > 0 ? "verified" : "not_verified",
      url: homeLink("AttributeBasedAdjustment"), actionLabel: "View in Salesforce",
    },
    {
      category: "attributeAdjustmentConditions", key: "attributeAdjustmentConditions", label: "Attribute Adjustment Conditions",
      name: null, id: null, count: input.conditionCount ?? 0,
      status: (input.conditionCount ?? 0) > 0 ? "verified" : "not_verified",
      url: homeLink("AttributeAdjustmentCondition"), actionLabel: "View in Salesforce",
    },
    {
      category: "attributeBasedAdjRules", key: "attributeBasedAdjRules", label: "Attribute-Based Adjustment Rules",
      name: null, id: null, count: input.ruleCount ?? 0,
      status: (input.ruleCount ?? 0) > 0 ? "verified" : "not_verified",
      url: homeLink("AttributeBasedAdjRule"), actionLabel: "View in Salesforce",
    },
  ];
}
