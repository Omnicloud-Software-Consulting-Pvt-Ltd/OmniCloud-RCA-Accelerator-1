import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { createTTLCache } from "@/lib/salesforce/cache";
import { resolveBundleObjectDiscovery } from "@/lib/quotes/metadata/relationshipFields";
import {
  resolveProductConfigurationBase, computeConfigurationBlockingReasons,
  type ProductConfigurationBase,
} from "@/lib/quotes/server/productConfiguration";
import type {
  BillingFrequencyResolution,
  BundleComponent,
  BundleObjectDiscovery,
  CatalogProduct,
  ProductConfigurationResult,
} from "@/lib/quotes/types";

/**
 * §Slow Add fix (Issue 2C): the FULL per-product resolution chain
 * (attributes, bundle expansion, selling model, billing frequency/
 * treatment/term) is expensive and was previously re-run from scratch on
 * every "+ Add" click for the same product — even re-selecting a product
 * already resolved once this session repeated the whole sequence.  Cached
 * per (org + Product2Id + pricebookId), since the natural (pre-manual-
 * override) resolution never varies for that triple within the TTL.
 * `manualBillingFrequencies` overrides are applied AFTER the cache lookup
 * (below, in the route handler), never baked into the cached value, so a
 * cache hit never masks a fresh manual selection.
 *
 * In-flight de-duplication: two near-simultaneous requests for the same
 * key (e.g. a double-click, or two bundle siblings sharing a child
 * product) share the SAME in-progress computation instead of each
 * launching their own full resolution chain.
 */
const configureCache = createTTLCache<ProductConfigurationBase>();
const configureInFlight = new Map<string, Promise<ProductConfigurationBase>>();

async function resolveCachedBaseConfiguration(
  client: SalesforceClient,
  discovery: BundleObjectDiscovery,
  product: CatalogProduct,
  pricebookId: string,
): Promise<ProductConfigurationBase> {
  // §Cache key MUST include pricebookEntryId: a single Product2 can have
  // MULTIPLE PricebookEntry rows in the SAME price book — one per Selling
  // Model (e.g. a One-Time entry and a separate Annual entry). Keying only
  // on (product, pricebookId) let resolving the product via one entry
  // silently poison the cache for every subsequent add via a DIFFERENT
  // entry of the SAME product — e.g. resolve "Antivirus" via its One-Time
  // PricebookEntry first (cached: no Billing Frequency required), then
  // select it again via its Annual/Evergreen PricebookEntry and get back
  // the stale One-Time result, skipping the configurator dialog entirely
  // and reaching line-item creation with a null Billing Frequency.
  const key = `${client.instanceUrl}:${product.id}:${pricebookId}:${product.pricebookEntryId ?? "none"}`;
  const cached = configureCache.get(key);
  if (cached) return cached;
  const existing = configureInFlight.get(key);
  if (existing) return existing;

  const promise = resolveProductConfigurationBase(client, discovery, product, pricebookId, "QuoteLineItem");
  configureInFlight.set(key, promise);
  try {
    const result = await promise;
    configureCache.set(key, result);
    return result;
  } finally {
    configureInFlight.delete(key);
  }
}

/**
 * §Never ask twice: apply a client-remembered manual billing-frequency
 * selection for this exact product, made earlier in the SAME quote session
 * (e.g. it was removed and is being re-added). Re-validated against the
 * field's CURRENT active picklist values every time — a remembered value is
 * a hint, never trusted blindly, and is silently ignored (falling back to
 * normal resolution / asking again) if it's no longer valid.
 */
function withManualOverride(resolution: BillingFrequencyResolution | null, override: string | undefined): BillingFrequencyResolution | null {
  if (!resolution || resolution.value || !override) return resolution;
  if (!resolution.activeOptions.some(o => o.value === override)) return resolution;
  return { ...resolution, value: override, source: "manual-entry" };
}

function applyManualOverrides(components: BundleComponent[], overrides: Record<string, string>): BundleComponent[] {
  return components.map(c => ({
    ...c,
    billingFrequency: withManualOverride(c.billingFrequency, overrides[c.productId]),
    children: applyManualOverrides(c.children, overrides),
  }));
}

// POST /api/quotes/products/configure — resolve a product's full configuration on selection (§4.4).
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let product: CatalogProduct, pricebookId: string, manualBillingFrequencies: Record<string, string>;
  try {
    const body = await req.json();
    ({ product, pricebookId } = body);
    manualBillingFrequencies = (body?.manualBillingFrequencies && typeof body.manualBillingFrequencies === "object") ? body.manualBillingFrequencies : {};
    if (!product?.id || !pricebookId) return NextResponse.json({ error: "product and pricebookId are required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const t0 = Date.now();
    const discovery = await resolveBundleObjectDiscovery(client);
    const cacheKey = `${client.instanceUrl}:${product.id}:${pricebookId}:${product.pricebookEntryId ?? "none"}`;
    const wasCached = !!configureCache.get(cacheKey);
    const base = await resolveCachedBaseConfiguration(client, discovery, product, pricebookId);
    const { attributes, sellingModel, billingTreatment, subscriptionTerm } = base;

    const billingFrequency = sellingModel.chosen?.requiresBillingFrequency
      ? withManualOverride(base.billingFrequency, manualBillingFrequencies[product.id])
      : null;

    const bundle = { ...base.bundle, components: applyManualOverrides(base.bundle.components, manualBillingFrequencies) };
    // §Perf instrumentation (dev-log only, never customer-facing UI): the
    // single number that most directly answers "why is + Add slow".
    console.log(`[products/configure] product=${product.id} ("${product.name}") resolved in ${Date.now() - t0}ms (cache ${wasCached ? "HIT" : "MISS"}).`);
    // §TEMP DIAGNOSTIC (remove once Antivirus-class Billing Frequency
    // failures are confirmed resolved).
    console.log(`[BILLING FREQUENCY CONFIGURE] product=${product.id} ("${product.name}") pricebookEntryId=${product.pricebookEntryId ?? "null"} sellingModelId=${sellingModel.chosen?.sellingModelId ?? "null"} sellingModelName=${sellingModel.chosen?.name ?? "null"} sellingModelType=${sellingModel.chosen?.type ?? "null"} requiresBillingFrequency=${!!sellingModel.chosen?.requiresBillingFrequency} chosenReason=${sellingModel.chosenReason} -> billingFrequency.value=${billingFrequency?.value ?? "null"} source=${billingFrequency?.source ?? "null"} (cache ${wasCached ? "HIT" : "MISS"}).`);

    // Reasons are computed from the POST-manual-override values (billingFrequency/bundle
    // above), never the raw cached `base` — a manual override can resolve exactly the
    // condition that would otherwise be reported as blocking.
    const reasons = computeConfigurationBlockingReasons({ ...base, billingFrequency, bundle });

    console.log(
      `[products/configure] product=${product.id} ("${product.name}") isBundle=${bundle.isBundle} ` +
      `relationshipObject=${discovery.relationshipObject ?? "none"} childCount=${bundle.diagnostics.resolvedChildCount} ` +
      `childIds=[${bundle.diagnostics.resolvedChildProductIds.join(", ")}]`,
    );

    const result: ProductConfigurationResult = {
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
    // failures are confirmed resolved): what's ACTUALLY in the JSON response
    // the client receives — proves whether resolution's result survives
    // being assembled into `result` and serialized.
    console.log(`[BILLING FREQUENCY RESPONSE] product=${product.id} ("${product.name}") requiresConfiguration=${result.requiresConfiguration} sellingModelType=${result.sellingModel.chosen?.type ?? "null"} -> result.billingFrequency.value=${result.billingFrequency?.value ?? "null"} source=${result.billingFrequency?.source ?? "null"}.`);
    return NextResponse.json({ success: true, configuration: result });
  } catch (err) {
    return sfErrorResponse(err, "Failed to resolve product configuration");
  }
}
