import type { BundleComponent, ProductConfigurationResult } from "@/lib/quotes/types";
import type { DraftValidationProductInfo, ProductInfoResolver } from "@/lib/quotes/bundles/validate";

/**
 * Build a per-product info lookup for the client-side bundle-tree validator
 * from every ProductConfigurationResult resolved so far — including nested
 * bundle descendants, since `expandBundle` already recursively resolved
 * their attributes/selling-model/groups in one configure call.
 */
export function buildProductInfoLookup(configs: ProductConfigurationResult[]): ProductInfoResolver {
  const map = new Map<string, DraftValidationProductInfo>();

  function visit(component: BundleComponent) {
    map.set(component.productId, {
      attributes: component.attributes,
      requiresBillingFrequency: !!component.sellingModel?.chosen?.requiresBillingFrequency,
      groups: component.childGroups,
      candidates: component.children,
    });
    for (const child of component.children) visit(child);
  }

  for (const config of configs) {
    map.set(config.product.id, {
      attributes: config.attributes,
      requiresBillingFrequency: !!config.sellingModel.chosen?.requiresBillingFrequency,
      groups: config.bundle?.groups ?? [],
      candidates: config.bundle?.components ?? [],
    });
    for (const c of config.bundle?.components ?? []) visit(c);
  }

  return (productId: string) => map.get(productId) ?? null;
}
