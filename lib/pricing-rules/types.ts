/**
 * Pricing Rules module — shared types.
 *
 * A "Pricing Rule" here means a Salesforce Revenue Cloud Pricing Procedure
 * (an Expression Set). §Reset — the Attribute-Based Pricing deploy engine and
 * its Autopilot were removed to be rebuilt from scratch; this file now holds
 * only the shell shared by all four pricing types (`create-procedure`
 * currently returns `notImplemented: true` for every one of them).
 */

/**
 * ExpressionSet/ExpressionSetVersion/ExpressionSetStep and the Decision
 * Table objects this module reads are newer Revenue Cloud constructs than
 * the rest of this app targets (SF_API_VERSION/SF_API_VERSION_RCA in
 * lib/salesforce/client.ts) — this module pins its own, newer version for
 * both REST SOQL and the Metadata API SOAP endpoint.
 *
 * §Root-cause fix — was "v61.0". `ExpressionSetDefinitionVersion.rank` (the field required to create a
 * second ExpressionSetVersion under an existing ExpressionSet — Salesforce rejects a deploy that omits
 * it with "Assign a unique rank ...") is only available in the Metadata API from v62.0 onward (confirmed
 * via Salesforce's own Metadata API Developer Guide). `canvasBuilder.ts`'s `injectVersionNumberAndRank`
 * call has an explicit, correct defensive gate that refuses to embed `<rank>` when the deploy's OWN
 * declared package.xml `<version>` (derived from THIS constant, in `deploy.ts`) is below 62 — v61.0
 * tripped that gate on every single run, silently skipping rank injection while leaving the donor's own
 * leftover `<rank>` value untouched. This was never a bug in the injection/verification logic itself
 * (which was already correct and directly tested) — it was this one constant being one version short of
 * what the feature it enables actually requires. v62.0 is already proven safe/supported on this org: it's
 * the SAME version `SF_API_VERSION_RCA` already uses successfully for Quote/QuoteLineItem routes.
 */
export const PRICING_RULES_API_VERSION = "v62.0";

export type PricingType = "tier-based" | "volume-based" | "attribute-based" | "bundle-based";

export const PRICING_TYPE_LABELS: Record<PricingType, string> = {
  "tier-based": "Tier-Based",
  "volume-based": "Volume-Based",
  "attribute-based": "Attribute-Based",
  "bundle-based": "Bundle-Based",
};

/** Which pricing types have a real, working deploy engine behind them. Empty — Attribute-Based's deploy engine was reset and no pricing type has one yet. */
export const IMPLEMENTED_PRICING_TYPES: PricingType[] = [];

/* ── Step trace (this module's own copy of the app-wide step-trace shape —
 * every domain module keeps its own per existing convention). ── */
export interface ProcedureStep {
  step: string;
  status: "start" | "success" | "error" | "info";
  message: string;
  detail?: unknown;
  timestamp: number;
}

/* ── Form / payload ── */
export interface ProcedureFormData {
  procedureName: string;
  apiName: string;
  description: string;
  productName: string;
  pricingType: PricingType | "";

  productId: string;
  productCode: string;
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
}

export interface SalesforceCreationResult {
  success: boolean;
  notImplemented?: boolean;
  procedureId?: string;
  versionId?: string;
  apiName?: string;
  steps: ProcedureStep[];
  warnings: string[];
  error?: string;
}
