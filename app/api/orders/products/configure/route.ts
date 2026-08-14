import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveBundleObjectDiscovery } from "@/lib/quotes/metadata/relationshipFields";
import { resolveProductConfigurationBase, computeConfigurationBlockingReasons } from "@/lib/quotes/server/productConfiguration";
import type { CatalogProduct } from "@/lib/quotes/types";
import type { OrderProductConfigurationResult } from "@/lib/orders/types";

// POST /api/orders/products/configure — resolve a product's full configuration on selection
// (§4.4). Identical service chain to the Quote module's equivalent endpoint — bundle
// expansion/selling-model/billing resolution are Product2/PricebookEntry-keyed, not Quote-specific.
// Both routes call the SAME shared resolver (lib/quotes/server/productConfiguration.ts).
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
    const base = await resolveProductConfigurationBase(client, discovery, product, pricebookId, "OrderItem");
    const { attributes, bundle, sellingModel, billingFrequency, billingTreatment, subscriptionTerm } = base;

    const reasons = computeConfigurationBlockingReasons(base);

    console.log(
      `[orders/products/configure] product=${product.id} ("${product.name}") isBundle=${bundle.isBundle} ` +
      `relationshipObject=${discovery.relationshipObject ?? "none"} childCount=${bundle.diagnostics.resolvedChildCount} ` +
      `childIds=[${bundle.diagnostics.resolvedChildProductIds.join(", ")}]`,
    );
    // §TEMP DIAGNOSTIC (remove once Antivirus-class Billing Frequency
    // failures are confirmed resolved).
    console.log(`[BILLING FREQUENCY CONFIGURE] product=${product.id} ("${product.name}") pricebookEntryId=${product.pricebookEntryId ?? "null"} sellingModelId=${sellingModel.chosen?.sellingModelId ?? "null"} sellingModelName=${sellingModel.chosen?.name ?? "null"} sellingModelType=${sellingModel.chosen?.type ?? "null"} requiresBillingFrequency=${!!sellingModel.chosen?.requiresBillingFrequency} chosenReason=${sellingModel.chosenReason} -> billingFrequency.value=${billingFrequency?.value ?? "null"} source=${billingFrequency?.source ?? "null"}.`);

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

    // §TEMP DIAGNOSTIC (remove once Antivirus-class Billing Frequency
    // failures are confirmed resolved).
    console.log(`[BILLING FREQUENCY RESPONSE] product=${product.id} ("${product.name}") requiresConfiguration=${result.requiresConfiguration} sellingModelType=${result.sellingModel.chosen?.type ?? "null"} -> result.billingFrequency.value=${result.billingFrequency?.value ?? "null"} source=${result.billingFrequency?.source ?? "null"}.`);
    return NextResponse.json({ success: true, configuration: result });
  } catch (err) {
    return sfErrorResponse(err, "Failed to resolve product configuration");
  }
}
