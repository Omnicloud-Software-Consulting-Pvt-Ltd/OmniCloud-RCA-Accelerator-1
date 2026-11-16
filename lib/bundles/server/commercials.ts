import { SalesforceError, type SalesforceClient } from "@/lib/salesforce/client";
import { persistProductPrice, type PersistedPrice } from "@/lib/products/server/pricebookEntry";
import {
  fetchSellingModels, linkSellingModelToProduct, matchSellingModel, productSellingModelLinks, verifySellingModelMapping,
  type SellingModelMappingCheck, type SellingModelRecord,
} from "@/lib/products/server/sellingModel";

/**
 * Selling-model + price commercials for EVERY component of a bundle — the root bundle, nested bundles (any depth), their
 * products and dependency products — using the SAME shared logic as standalone product creation:
 *   matchSellingModel / linkSellingModelToProduct (ProductSellingModelOption, reused when present),
 *   persistProductPrice (PricebookEntry per Product2 + Pricebook2 + ProductSellingModel, matched by Salesforce Id),
 *   verifySellingModelMapping (read back from Salesforce before anything is reported as done).
 * Bundle creation never re-prices existing entries: persistProductPrice runs with existingPrice "keep".
 */

/* ── Planning (pure): which selling model / price book each component gets ── */

export interface BundleLike {
  bundleName: string;
  sellingModel?: string;
  priceBook?: string;
  products?: { name: string; sellingModel?: string; priceBook?: string }[];
  nestedBundles?: BundleLike[];
}

export type ComponentKind = "root" | "bundle" | "product" | "dependency";
export interface PlannedComponent { name: string; kind: ComponentKind; depth: number; sellingModel?: string; priceBook?: string; owner: string | null }

const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/**
 * Each component inherits from its NEAREST bundle (not the root): a product without its own selling model / price book uses its
 * owning bundle's, which uses its parent's, and so on. Keyed by lower-cased name, matching the bundle route's name maps.
 */
export function planBundleCommercials(root: BundleLike, dependencies: { name: string; ownerBundleName: string; sellingModel?: string; priceBook?: string }[] = []): Map<string, PlannedComponent> {
  const plan = new Map<string, PlannedComponent>();
  const bundleSettings = new Map<string, { sellingModel?: string; priceBook?: string; depth: number }>();
  const walk = (b: BundleLike, inherited: { sellingModel?: string; priceBook?: string }, depth: number, owner: string | null) => {
    const sellingModel = clean(b.sellingModel) ?? inherited.sellingModel;
    const priceBook = clean(b.priceBook) ?? inherited.priceBook;
    bundleSettings.set(b.bundleName.toLowerCase(), { sellingModel, priceBook, depth });
    plan.set(b.bundleName.toLowerCase(), { name: b.bundleName, kind: depth === 0 ? "root" : "bundle", depth, sellingModel, priceBook, owner });
    for (const p of b.products ?? []) {
      plan.set(p.name.toLowerCase(), { name: p.name, kind: "product", depth: depth + 1, sellingModel: clean(p.sellingModel) ?? sellingModel, priceBook: clean(p.priceBook) ?? priceBook, owner: b.bundleName });
    }
    for (const child of b.nestedBundles ?? []) walk(child, { sellingModel, priceBook }, depth + 1, b.bundleName);
  };
  walk(root, {}, 0, null);
  for (const d of dependencies) {
    if (plan.has(d.name.toLowerCase())) continue;
    const owner = bundleSettings.get(d.ownerBundleName.toLowerCase()) ?? bundleSettings.get(root.bundleName.toLowerCase())!;
    plan.set(d.name.toLowerCase(), { name: d.name, kind: "dependency", depth: owner.depth + 1, sellingModel: clean(d.sellingModel) ?? owner.sellingModel, priceBook: clean(d.priceBook) ?? owner.priceBook, owner: d.ownerBundleName });
  }
  return plan;
}

/* ── Salesforce errors with a meaningful explanation ── */

export function explainSalesforceError(err: unknown): string {
  if (!(err instanceof SalesforceError)) return err instanceof Error ? err.message : String(err);
  const hint: Record<string, string> = {
    DUPLICATE_VALUE: "Salesforce already has a record for this exact combination.",
    STANDARD_PRICE_NOT_DEFINED: "Salesforce needs a Standard Price Book entry for this product and selling model before a custom Price Book entry.",
    FIELD_INTEGRITY_EXCEPTION: "Salesforce rejected how the records reference each other (for example, the product isn't linked to this selling model, or the Price Book isn't usable).",
    INVALID_CROSS_REFERENCE_KEY: "One of the referenced records doesn't exist or isn't visible to your Salesforce user.",
    INSUFFICIENT_ACCESS_OR_READONLY: "Your Salesforce user doesn't have permission for this change.",
    INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: "Your Salesforce user can't access one of the referenced records.",
    REQUIRED_FIELD_MISSING: "Salesforce requires a field that wasn't provided.",
  };
  const code = err.errorCode ?? `HTTP ${err.status}`;
  return `${code}: ${err.message}${err.errorCode && hint[err.errorCode] ? ` — ${hint[err.errorCode]}` : ""}`;
}

/* ── Phase 1 (route batch 7): resolve + link the selling model for each component ── */

export interface CommercialItem { name: string; productId: string; kind: ComponentKind; unitPrice: number; sellingModel?: string; priceBook?: string }

export interface LinkedItem extends CommercialItem {
  model: { id: string; name: string; defaulted: boolean };
  optionId: string;
  alreadyLinked: boolean;
  activated: boolean;
  /** Selling models the product was already linked to before this run (existing products). */
  existingModels: string[];
}

export interface CommercialFailure { name: string; kind: ComponentKind; productId: string; stage: "selling-model" | "price" | "verify"; error: string; checks?: SellingModelMappingCheck[] }

export const DEFAULT_SELLING_MODEL = "One Time";

export async function resolveAndLinkSellingModels(client: SalesforceClient, items: CommercialItem[], modelsInput?: SellingModelRecord[]): Promise<{ linked: LinkedItem[]; failures: CommercialFailure[]; models: SellingModelRecord[] }> {
  const failures: CommercialFailure[] = [];
  let models = modelsInput;
  if (!models) {
    try { models = await fetchSellingModels(client); }
    catch (e) { return { linked: [], models: [], failures: items.map(i => ({ name: i.name, kind: i.kind, productId: i.productId, stage: "selling-model" as const, error: `Couldn't read Product Selling Models: ${explainSalesforceError(e)}` })) }; }
  }
  const linked: LinkedItem[] = [];
  for (const item of items) {
    const requested = clean(item.sellingModel);
    const model = matchSellingModel(models, requested ?? DEFAULT_SELLING_MODEL);
    if (!model) {
      failures.push({ name: item.name, kind: item.kind, productId: item.productId, stage: "selling-model",
        error: requested
          ? `No Product Selling Model in this org matches "${requested}". Available: ${models.map(m => m.Name).join(", ") || "none"}.`
          : `No selling model was requested and this org has no "${DEFAULT_SELLING_MODEL}" Product Selling Model to default to.` });
      continue;
    }
    try {
      const existingModels = (await productSellingModelLinks(client, item.productId).catch(() => [])).map(l => l.modelName ?? l.modelId);
      const link = await linkSellingModelToProduct(client, item.productId, model);
      linked.push({ ...item, model: { id: model.Id, name: model.Name, defaulted: !requested }, optionId: link.optionId, alreadyLinked: link.alreadyLinked, activated: link.activated, existingModels });
    } catch (e) {
      failures.push({ name: item.name, kind: item.kind, productId: item.productId, stage: "selling-model", error: explainSalesforceError(e) });
    }
  }
  return { linked, failures, models };
}

/* ── Phase 2 (route batch 8): the PricebookEntry for Product + Price Book + selling model, then read everything back ── */

export interface PricedItem extends LinkedItem { entry: PersistedPrice; warnings: string[]; checks: SellingModelMappingCheck[] }

export async function priceAndVerify(client: SalesforceClient, linked: LinkedItem[]): Promise<{ priced: PricedItem[]; failures: CommercialFailure[] }> {
  const priced: PricedItem[] = [];
  const failures: CommercialFailure[] = [];
  for (const item of linked) {
    try {
      const out = await persistProductPrice(client, {
        productId: item.productId,
        unitPrice: item.unitPrice,
        priceBook: item.priceBook,
        isActive: true,
        productSellingModelId: item.model.id,
        existingPrice: "keep",
      });
      if (!out.entry) { failures.push({ name: item.name, kind: item.kind, productId: item.productId, stage: "price", error: out.error ?? "The price entry could not be saved." }); continue; }
      // Read back: model Active, product ↔ model link, and every entry (target + standard) carries this product and selling model.
      const entryIds = [out.entry.id, out.entry.standardEntry?.id].filter((v): v is string => !!v);
      const checks = await verifySellingModelMapping(client, { productId: item.productId, modelId: item.model.id, entryIds });
      if (checks.some(c => !c.passed)) {
        failures.push({ name: item.name, kind: item.kind, productId: item.productId, stage: "verify", error: `Salesforce doesn't show the expected mapping: ${checks.filter(c => !c.passed).map(c => c.label).join("; ")}.`, checks });
        continue;
      }
      priced.push({ ...item, entry: out.entry, warnings: out.warnings, checks });
    } catch (e) {
      failures.push({ name: item.name, kind: item.kind, productId: item.productId, stage: "price", error: explainSalesforceError(e) });
    }
  }
  return { priced, failures };
}
