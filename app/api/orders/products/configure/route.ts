import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveBundleObjectDiscovery } from "@/lib/quotes/metadata/relationshipFields";
import { expandBundle } from "@/lib/quotes/bundles/expansion";
import { resolveProductAttributes } from "@/lib/quotes/catalog/attributes";
import { resolveSellingModelForProduct } from "@/lib/quotes/catalog/sellingModel";
import { resolveBillingFrequency, resolveSubscriptionTerm } from "@/lib/quotes/billing/frequency";
import { validateBillingTreatment } from "@/lib/quotes/billing/treatment";
import type { BundleComponent, CatalogProduct } from "@/lib/quotes/types";
import type { OrderProductConfigurationResult } from "@/lib/orders/types";

/**
 * §Order billing frequency parity fix (mirrors app/api/quotes/products/configure/route.ts):
 * a bundle CHILD needing a billing frequency that couldn't be auto-resolved
 * must surface here too, not only the root product being configured —
 * otherwise it silently reaches createOrderItems() with a null value and
 * fails at submission instead of offering the fallback dropdown up front.
 */
function hasUnresolvedBillingFrequency(components: BundleComponent[]): boolean {
  return components.some(
    c =>
      (c.sellingModel?.chosen?.requiresBillingFrequency && !c.billingFrequency?.value) ||
      hasUnresolvedBillingFrequency(c.children),
  );
}

// POST /api/orders/products/configure — resolve a product's full configuration on selection
// (§4.4). Identical service chain to the Quote module's equivalent endpoint — bundle
// expansion/selling-model/billing resolution are Product2/PricebookEntry-keyed, not Quote-specific.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let product: CatalogProduct, pricebookId: string;
  try {
    ({ product, pricebookId } = await req.json());
    if (!product?.id || !pricebookId) return NextResponse.json({ error: "product and pricebookId are required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const discovery = await resolveBundleObjectDiscovery(client);
    const [attributes, bundle, sellingModel] = await Promise.all([
      resolveProductAttributes(client, product.id),
      expandBundle(client, discovery, product.id, pricebookId, "OrderItem"),
      resolveSellingModelForProduct(client, product.id, product.pricebookEntryId),
    ]);

    let billingFrequency = null;
    let billingTreatment = null;
    let subscriptionTerm = null;
    if (sellingModel.chosen?.requiresBillingFrequency) {
      [billingFrequency, billingTreatment] = await Promise.all([
        resolveBillingFrequency(client, product.id, sellingModel.chosen.sellingModelId, sellingModel.chosen.name, "OrderItem"),
        validateBillingTreatment(client, product.id),
      ]);
    }
    if (sellingModel.chosen?.type === "TermDefined") {
      subscriptionTerm = await resolveSubscriptionTerm(client, product.id, sellingModel.chosen.sellingModelId, "OrderItem");
    }

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

    console.log(
      `[orders/products/configure] product=${product.id} ("${product.name}") isBundle=${bundle.isBundle} ` +
      `relationshipObject=${discovery.relationshipObject ?? "none"} childCount=${bundle.diagnostics.resolvedChildCount} ` +
      `childIds=[${bundle.diagnostics.resolvedChildProductIds.join(", ")}]`,
    );

    const result: OrderProductConfigurationResult = {
      product,
      attributes,
      bundle: bundle.isBundle ? bundle : null,
      bundleDiagnostics: bundle.diagnostics,
      sellingModel,
      billingFrequency,
      subscriptionTerm,
      billingTreatment,
      requiresConfiguration: reasons.length > 0,
      requiresConfigurationReasons: reasons,
    };

    return NextResponse.json({ success: true, configuration: result });
  } catch (err) {
    return sfErrorResponse(err, "Failed to resolve product configuration");
  }
}
