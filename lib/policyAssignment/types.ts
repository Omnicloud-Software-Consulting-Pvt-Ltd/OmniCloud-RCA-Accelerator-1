/**
 * Bulk Product Policy Assignment — shared (client + server) types. One feature, two independent policy kinds:
 *  · billing → Product2's reference field to BillingPolicy (discovered from Describe; BillingPolicyId in Revenue Cloud)
 *  · tax     → Product2's reference field to TaxPolicy (discovered from tax metadata; TaxPolicyId)
 * Eligibility is always "this product has no policy of THIS kind" — the other kind is never looked at.
 */

export type PolicyKind = "billing" | "tax";
export const POLICY_KINDS: PolicyKind[] = ["billing", "tax"];
export const isPolicyKind = (v: unknown): v is PolicyKind => v === "billing" || v === "tax";

/** Hard cap per assignment request (and for "Select All Eligible"). */
export const MAX_BULK_PRODUCTS = 500;
export const ELIGIBLE_PAGE_SIZE = 50;

export const POLICY_KIND_LABELS: Record<PolicyKind, { policy: string; policies: string; module: string }> = {
  billing: { policy: "Billing Policy", policies: "Billing Policies", module: "Revenue Cloud Billing" },
  tax: { policy: "Tax Policy", policies: "Tax Policies", module: "Taxes" },
};

export interface BulkPolicyOption {
  id: string;
  name: string;
  status: string | null;
  /** Products currently assigned to this policy (null when the count couldn't be read). */
  productCount: number | null;
}

/**
 * How Treatment Items relate to products for the selected policy — read from Salesforce, never assumed:
 *  · tax-per-product   — the policy's default Tax Treatment has "Use Tax Treatment Items" on: every product needs its OWN
 *                        TaxTreatmentItem (TaxTreatmentId + ProductId + TaxCode [+ ProductCode]) — created/reused per product.
 *  · tax-treatment-code — the default treatment does NOT use items: its own Tax Code applies to every product; no item needed
 *                        (Salesforce refuses items on such a treatment).
 *  · billing-shared    — Billing Treatment Items are shared by every product on the policy: Salesforce allows exactly one item
 *                        on a non-milestone treatment and none can be added while it's Active, so nothing is created per product;
 *                        the shared item is verified instead.
 *  · none              — the policy has no default treatment, so there's nothing to map yet.
 */
export type TreatmentItemMode = "tax-per-product" | "tax-treatment-code" | "billing-shared" | "none";

/** Where the policy's Tax Code came from (Tax Treatment → Tax Engine → not configured). Never entered by the user. */
export type TaxCodeSource = "tax-treatment" | "tax-engine" | "not-configured";
export const TAX_CODE_SOURCE_LABEL: Record<TaxCodeSource, string> = { "tax-treatment": "Tax Treatment", "tax-engine": "Tax Engine", "not-configured": "Not Configured" };

export interface TreatmentItemSummary {
  mode: TreatmentItemMode;
  treatmentId: string | null;
  treatmentName: string | null;
  treatmentStatus: string | null;
  /** The default treatment's own TaxCode field (raw). */
  treatmentTaxCode: string | null;
  /** Tax: the authoritative Tax Code for this policy — TaxTreatment.TaxCode, else the Tax Engine's Tax Code (only if the org's TaxEngine has such a field), else null. */
  resolvedTaxCode?: string | null;
  taxCodeSource?: TaxCodeSource | null;
  /** Tax: the default treatment's Tax Engine, and the TaxEngine Tax Code field if this org's schema has one (null = no such field). */
  engineName?: string | null;
  engineTaxCodeField?: string | null;
  /** billing-shared: the shared item(s). */
  sharedItems: { id: string; name: string; status: string | null }[];
  /** tax-per-product: the user can create items (object createable + fields writable). */
  canCreateItems: boolean;
  /** Plain-language explanation shown on the page. */
  detail: string;
}

export interface PolicyCheckResult {
  id: string;
  name: string;
  status: string | null;
  /** Reasons the policy can't be assigned (e.g. Inactive, broken billing chain). Non-empty = assignment refused. */
  blockers: string[];
  /** Assignable, but worth knowing (e.g. Draft — Salesforce won't use it until it's Active). */
  warnings: string[];
  /** Treatment Item configuration for this policy (null when it couldn't be read). */
  treatmentItems?: TreatmentItemSummary | null;
}

/**
 * Per-product Treatment Item outcome.
 *  created / reused / updated (TaxCode filled on the product's existing item) / shared (billing) / not-required (treatment code)
 *  are complete; missing-tax-code / failed / not-verified are not.
 */
export type TreatmentItemStatus = "created" | "reused" | "updated" | "conflict" | "shared" | "not-required" | "missing-tax-code" | "failed" | "not-verified";
/** "conflict" = the product's existing item has a DIFFERENT Tax Code than the policy's — mapped (so not blocking), never overwritten, reported. */
export const TREATMENT_ITEM_COMPLETE: ReadonlySet<TreatmentItemStatus> = new Set(["created", "reused", "updated", "conflict", "shared", "not-required"]);

export interface TreatmentItemResult {
  status: TreatmentItemStatus;
  itemId: string | null;
  itemName: string | null;
  treatmentName: string | null;
  taxCode: string | null;
  /** Where the item's Tax Code came from: the policy's resolution, or the existing item (kept as is). */
  taxCodeSource: TaxCodeSource | "existing-item" | null;
  detail: string;
}

/** Why a product failed — so the UI can say "permission" vs "missing tax code" vs "verification". */
export type FailureKind = "not-found" | "permission" | "missing-tax-code" | "treatment-item" | "salesforce" | "concurrent-change" | "verification";

export interface EligibleProduct {
  id: string;
  name: string;
  code: string | null;
  family: string | null;
  active: boolean | null;
}

export interface PoliciesResponse { success: true; kind: PolicyKind; field: string; policies: BulkPolicyOption[] }

export interface EligibleProductsResponse {
  success: true;
  kind: PolicyKind;
  /** The Product2 field checked (e.g. BillingPolicyId / TaxPolicyId). */
  field: string;
  products: EligibleProduct[];
  nextCursor: string | null;
  /** Eligible products matching the search (null if the count failed). */
  totalEligible: number | null;
  /** `all=1` only: more eligible products exist than MAX_BULK_PRODUCTS. */
  truncated: boolean;
  /** Validation of the selected policy, when `policyId` was given. */
  policy: PolicyCheckResult | null;
}

/**
 * assigned             — policy written and re-read, AND its Treatment Item configuration is complete and verified
 * already-assigned     — the product already had THIS policy and its Treatment Item configuration is complete (missing
 *                        items are completed here — that's how a retry repairs a partial state; the policy is never re-written)
 * assigned-incomplete  — the product HAS the policy, but its Treatment Item configuration isn't complete/verified (partial state)
 * ineligible           — the product has a DIFFERENT policy of this kind (never overwritten), incl. one set concurrently
 * failed               — the policy was NOT assigned; `failureKind` says why and `retryable` whether retrying can help
 */
export type BulkOutcome = "assigned" | "already-assigned" | "assigned-incomplete" | "ineligible" | "failed";

export interface BulkProductResult {
  productId: string;
  productName: string;
  productCode: string | null;
  outcome: BulkOutcome;
  reason: string | null;
  existingPolicy: { id: string; name: string } | null;
  retryable: boolean;
  failureKind?: FailureKind | null;
  treatmentItem?: TreatmentItemResult | null;
}

export interface BulkAssignResponse {
  success: true;
  kind: PolicyKind;
  field: string;
  policy: { id: string; name: string; status: string | null };
  requested: number;
  /** Policy assigned AND Treatment Item configuration complete. */
  assigned: number;
  /** already-assigned + ineligible */
  skipped: number;
  /** Policy on the product but Treatment Item configuration incomplete (partial). */
  incomplete: number;
  failed: number;
  /** Products whose existing Tax Treatment Item has a different Tax Code than the policy's (kept, reported). */
  conflicts: number;
  warnings: string[];
  treatmentItems: TreatmentItemSummary | null;
  results: BulkProductResult[];
}

export interface BulkAssignError { success: false; status: number; code: string; error: string }

export function summarizeResults(results: BulkProductResult[]): { assigned: number; skipped: number; incomplete: number; failed: number; conflicts: number } {
  return {
    assigned: results.filter(r => r.outcome === "assigned").length,
    skipped: results.filter(r => r.outcome === "already-assigned" || r.outcome === "ineligible").length,
    incomplete: results.filter(r => r.outcome === "assigned-incomplete").length,
    failed: results.filter(r => r.outcome === "failed").length,
    conflicts: results.filter(r => r.treatmentItem?.status === "conflict").length,
  };
}

/** Products that still need attention (and stay selected for "Retry"): failed + assigned-incomplete. */
export const needsRetry = (r: BulkProductResult) => (r.outcome === "failed" || r.outcome === "assigned-incomplete") && r.retryable;

/** Client-side: which selected products should leave the eligible list / selection after an assignment (everything settled). */
export function resolvedProductIds(results: BulkProductResult[]): Set<string> {
  return new Set(results.filter(r => r.outcome !== "failed" && r.outcome !== "assigned-incomplete").map(r => r.productId));
}
