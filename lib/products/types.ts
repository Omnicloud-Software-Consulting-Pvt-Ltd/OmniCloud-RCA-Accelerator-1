/**
 * The Salesforce-facing product create payload — the single shape both the
 * AI prompt flow (RCProductWorkspace) and the bulk CSV/Excel importer build
 * and POST to /api/sf/products/save, so both creation paths produce
 * identical Product2/PricebookEntry/ProductSellingModelOption records.
 */
export interface ProductPayload {
  productName: string;
  productCode: string;
  family: string;
  category?: string;
  catalog?: string;
  description?: string;
  isActive?: boolean;
  sellingModel?: string;
  productOwner?: string;
  priceBook?: string;
  basePrice?: string;
  /** Product2.Type — optional; omitted (as today) unless a caller sets it. */
  productType?: string;
  /** PricebookEntry.CurrencyIsoCode — optional; omitted (as today, single-currency orgs) unless a caller sets it. */
  currencyIsoCode?: string;
  /** Product2.UnitOfMeasureId / QuantityUnitOfMeasure — resolved against the org by name/code; never auto-created. */
  unitOfMeasure?: string;
  /** Product2.BasedOnId — name or code of an existing Active ProductClassification; never auto-created. */
  classification?: string;
  /**
   * "Continue Anyway" — the user saw the exact full-name duplicate warning and chose to create another Product2 with the same
   * Name. Skips ONLY the app's duplicate-name gate; price/config validation and Salesforce's own rules (duplicate rules,
   * required fields, uniqueness constraints) still apply.
   */
  allowDuplicateName?: boolean;
  /**
   * Revenue Cloud tax/billing configuration, by record NAME (resolved server-side; never auto-created). Only the two policies
   * are Product2 fields (TaxPolicyId / BillingPolicyId); treatments, items and the engine are related records that are
   * verified against the policy — see lib/products/revenueConfig.ts.
   */
  taxPolicy?: string;
  taxTreatment?: string;
  taxTreatmentItem?: string;
  taxEngine?: string;
  /** Expected tax code (verified against the treatment/item; never written). */
  taxCode?: string;
  billingPolicy?: string;
  billingTreatment?: string;
  billingTreatmentItem?: string;
  /** Explicit record choices (e.g. after an ambiguity) — relation key → Salesforce Id. Validated server-side. */
  relationIds?: Partial<Record<import("@/lib/products/revenueConfig").RelationKey, string>>;
}

export interface ProductStepResult {
  id?: string; name?: string; created?: boolean;
  matched?: { name: string }[]; items?: unknown[];
  pricebook?: string; unitPrice?: number;
  [k: string]: unknown;
}

export interface ProductDeployResult {
  success: boolean;
  salesforceId?: string;
  error?: string;
  steps: Record<string, ProductStepResult>;
  errors: { step: string; error: string }[];
  skipped: { step: string; reason: string }[];
  /** Non-fatal notes (e.g. a currency the org can't store) — the step still succeeded. */
  warnings?: string[];
}
