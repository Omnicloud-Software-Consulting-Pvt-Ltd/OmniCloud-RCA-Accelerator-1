import type { SalesforceClient } from "@/lib/salesforce/client";
import { expandBundle } from "@/lib/quotes/bundles/expansion";
import { resolveProductAttributes } from "@/lib/quotes/catalog/attributes";
import { resolveSellingModelForProduct } from "@/lib/quotes/catalog/sellingModel";
import { resolveBillingFrequency, resolveSubscriptionTerm, type LineItemObjectName } from "@/lib/quotes/billing/frequency";
import { validateBillingTreatment } from "@/lib/quotes/billing/treatment";
import type {
  BillingFrequencyResolution, BillingTreatmentValidation, BundleComponent, BundleExpansionResult,
  BundleObjectDiscovery, CatalogProduct, ProductAttribute, SellingModelResolution, SubscriptionTermResolution,
} from "@/lib/quotes/types";

export type { LineItemObjectName };

export interface ProductConfigurationBase {
  attributes: ProductAttribute[];
  bundle: BundleExpansionResult;
  sellingModel: SellingModelResolution;
  billingFrequency: BillingFrequencyResolution | null;
  billingTreatment: BillingTreatmentValidation | null;
  subscriptionTerm: SubscriptionTermResolution | null;
}

/**
 * The exact per-product resolution chain both POST /api/quotes/products/
 * configure and POST /api/orders/products/configure run the moment a
 * product is added manually — extracted verbatim (both routes now call
 * this instead of inlining it) so bulk Quote/Order import can resolve each
 * line item through the SAME chain rather than skipping it.
 *
 * That skip was the actual root cause of imported line items either never
 * reaching Salesforce, or reaching it silently under-configured: any
 * product whose resolved Selling Model requires a Billing Frequency needs
 * that value BEFORE createQuoteLineItems/createOrderItems will accept the
 * line (see lib/quotes/server/lineItemCreate.ts's "Resolve Billing
 * Frequency" step, which explicitly VALIDATES a draft's existing
 * configuration rather than resolving it fresh) — the importer was
 * building drafts with `billingFrequency: null` unconditionally, so every
 * such line failed at creation time, and because createQuoteLineItems
 * creates a request's lines together, one bad line failed the whole batch.
 */
export async function resolveProductConfigurationBase(
  client: SalesforceClient,
  discovery: BundleObjectDiscovery,
  product: CatalogProduct,
  pricebookId: string,
  lineItemObject: LineItemObjectName,
): Promise<ProductConfigurationBase> {
  const [attributes, bundle, sellingModel] = await Promise.all([
    resolveProductAttributes(client, product.id),
    expandBundle(client, discovery, product.id, pricebookId, lineItemObject),
    resolveSellingModelForProduct(client, product.id, product.pricebookEntryId),
  ]);

  let billingFrequency: BillingFrequencyResolution | null = null;
  let billingTreatment: BillingTreatmentValidation | null = null;
  let subscriptionTerm: SubscriptionTermResolution | null = null;
  if (sellingModel.chosen?.requiresBillingFrequency) {
    [billingFrequency, billingTreatment] = await Promise.all([
      resolveBillingFrequency(client, product.id, sellingModel.chosen.sellingModelId, sellingModel.chosen.name, lineItemObject),
      validateBillingTreatment(client, product.id),
    ]);
  }
  if (sellingModel.chosen?.type === "TermDefined") {
    subscriptionTerm = await resolveSubscriptionTerm(client, product.id, sellingModel.chosen.sellingModelId, lineItemObject);
  }
  return { attributes, bundle, sellingModel, billingFrequency, billingTreatment, subscriptionTerm };
}

/** A bundle CHILD needing a billing frequency that couldn't be auto-resolved must block too, not only the root product — mirrors both configure routes' own local copy of this check (now the one shared copy). */
export function hasUnresolvedBillingFrequency(components: BundleComponent[]): boolean {
  return components.some(
    c => (c.sellingModel?.chosen?.requiresBillingFrequency && !c.billingFrequency?.value) || hasUnresolvedBillingFrequency(c.children),
  );
}

/** The exact "can this product be added without further user input?" reasons both configure routes compute — reused so import validation flags the same blocking conditions those routes already flag for manual Add. */
export function computeConfigurationBlockingReasons(base: ProductConfigurationBase): string[] {
  const { attributes, bundle, sellingModel, billingFrequency, billingTreatment } = base;
  const reasons: string[] = [];
  if (attributes.some(a => a.required)) reasons.push("Required product attributes need input.");
  if (bundle.isBundle) {
    const hasAmbiguousGroup = bundle.groups.some(g => {
      const candidates = bundle.components.filter(c => c.groupId === g.id);
      const flagged = candidates.some(c => c.isDefault || c.isRequired);
      return !flagged && g.min == null && candidates.length > 1;
    });
    if (hasAmbiguousGroup) reasons.push("This bundle has component choices that need confirmation.");
  }
  if (sellingModel.chosen?.requiresBillingFrequency && !billingFrequency?.value) {
    reasons.push("A billing frequency could not be automatically resolved.");
  }
  if (bundle.isBundle && hasUnresolvedBillingFrequency(bundle.components)) {
    reasons.push("One or more bundle components need a billing frequency selected.");
  }
  if (billingTreatment?.outcome === "no-billing-policy") {
    reasons.push("This product has no Billing Policy configured.");
  } else if (billingTreatment?.blocks) {
    reasons.push(billingTreatment.message ?? "Billing treatment configuration is invalid for this product.");
  }
  return reasons;
}

/**
 * Distinct from computeConfigurationBlockingReasons above: that function
 * flags configuration a HUMAN still needs to complete (an ambiguous choice,
 * a missing attribute). This checks whether the bundle's underlying
 * Salesforce structure/configuration data could be resolved AT ALL — a real
 * SOQL query failure while resolving relationship rows/component groups
 * (bundle.diagnostics.queryErrors), or a component that IS structurally
 * linked but whose Product2 record couldn't be resolved
 * (skippedComponents reason "Product record could not be resolved"). Either
 * condition means this Quote's bundle Quote Line Item would reach Salesforce
 * referencing incomplete/unverifiable bundle data — precisely the shape of
 * problem behind native "Refresh Prices" failing with "we couldn't retrieve
 * the product and price information... ensure Product Discovery is set up
 * correctly." Quote-import-only (not called from any Order code path).
 */
export function computeBundleConfigurationErrors(bundle: BundleExpansionResult): string[] {
  const reasons: string[] = [];
  if (!bundle.isBundle) return reasons;
  if (bundle.diagnostics.queryErrors.length > 0) {
    reasons.push(`Bundle structure could not be fully queried from Salesforce: ${bundle.diagnostics.queryErrors.join(" ")}`);
  }
  const unresolvedComponents = bundle.skippedComponents.filter(s => /product record could not be resolved/i.test(s.reason));
  if (unresolvedComponents.length > 0) {
    reasons.push(`${unresolvedComponents.length} bundle component(s) reference a Product2 that could not be resolved: ${unresolvedComponents.map(c => c.productId).join(", ")}.`);
  }
  return reasons;
}
