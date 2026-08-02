import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { createTTLCache } from "@/lib/salesforce/cache";
import { resolveBundleObjectDiscovery } from "@/lib/quotes/metadata/relationshipFields";
import { expandBundle } from "@/lib/quotes/bundles/expansion";
import { resolveProductAttributes } from "@/lib/quotes/catalog/attributes";
import { resolveSellingModelForProduct } from "@/lib/quotes/catalog/sellingModel";
import { resolveBillingFrequency, resolveSubscriptionTerm } from "@/lib/quotes/billing/frequency";
import { validateBillingTreatment } from "@/lib/quotes/billing/treatment";
import type {
  BillingFrequencyResolution,
  BillingTreatmentValidation,
  BundleComponent,
  BundleExpansionResult,
  BundleObjectDiscovery,
  CatalogProduct,
  ProductConfigurationResult,
  SellingModelResolution,
  SubscriptionTermResolution,
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
interface CachedProductConfiguration {
  attributes: Awaited<ReturnType<typeof resolveProductAttributes>>;
  bundleRaw: BundleExpansionResult;
  sellingModel: SellingModelResolution;
  billingFrequency: BillingFrequencyResolution | null;
  billingTreatment: BillingTreatmentValidation | null;
  subscriptionTerm: SubscriptionTermResolution | null;
}

const configureCache = createTTLCache<CachedProductConfiguration>();
const configureInFlight = new Map<string, Promise<CachedProductConfiguration>>();

async function resolveCachedBaseConfiguration(
  client: SalesforceClient,
  discovery: BundleObjectDiscovery,
  product: CatalogProduct,
  pricebookId: string,
): Promise<CachedProductConfiguration> {
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

  const promise = (async (): Promise<CachedProductConfiguration> => {
    const [attributes, bundleRaw, sellingModel] = await Promise.all([
      resolveProductAttributes(client, product.id),
      expandBundle(client, discovery, product.id, pricebookId, "QuoteLineItem"),
      resolveSellingModelForProduct(client, product.id, product.pricebookEntryId),
    ]);

    let billingFrequency: BillingFrequencyResolution | null = null;
    let billingTreatment: BillingTreatmentValidation | null = null;
    let subscriptionTerm: SubscriptionTermResolution | null = null;
    if (sellingModel.chosen?.requiresBillingFrequency) {
      [billingFrequency, billingTreatment] = await Promise.all([
        resolveBillingFrequency(client, product.id, sellingModel.chosen.sellingModelId, sellingModel.chosen.name, "QuoteLineItem"),
        validateBillingTreatment(client, product.id),
      ]);
    }
    if (sellingModel.chosen?.type === "TermDefined") {
      subscriptionTerm = await resolveSubscriptionTerm(client, product.id, sellingModel.chosen.sellingModelId, "QuoteLineItem");
    }
    return { attributes, bundleRaw, sellingModel, billingFrequency, billingTreatment, subscriptionTerm };
  })();

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
 * §Automatic Billing Frequency Resolution: a bundle CHILD needing a billing
 * frequency that couldn't be auto-resolved must surface here too, not only
 * the root product being configured — otherwise it silently reaches
 * createQuoteLineItems() with a null value and fails at submission instead
 * of offering the fallback dropdown up front (§Do NOT fail immediately).
 */
function hasUnresolvedBillingFrequency(components: BundleComponent[]): boolean {
  return components.some(
    c =>
      (c.sellingModel?.chosen?.requiresBillingFrequency && !c.billingFrequency?.value) ||
      hasUnresolvedBillingFrequency(c.children),
  );
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
    const { attributes, bundleRaw, sellingModel, billingTreatment, subscriptionTerm } = base;

    const billingFrequency = sellingModel.chosen?.requiresBillingFrequency
      ? withManualOverride(base.billingFrequency, manualBillingFrequencies[product.id])
      : null;

    const bundle = { ...bundleRaw, components: applyManualOverrides(bundleRaw.components, manualBillingFrequencies) };
    // §Perf instrumentation (dev-log only, never customer-facing UI): the
    // single number that most directly answers "why is + Add slow".
    console.log(`[products/configure] product=${product.id} ("${product.name}") resolved in ${Date.now() - t0}ms (cache ${wasCached ? "HIT" : "MISS"}).`);

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

    return NextResponse.json({ success: true, configuration: result });
  } catch (err) {
    return sfErrorResponse(err, "Failed to resolve product configuration");
  }
}
