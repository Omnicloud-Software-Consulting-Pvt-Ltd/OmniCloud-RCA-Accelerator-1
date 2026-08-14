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
}
