import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { resolveField } from "@/lib/salesforce/describe";
import { createTTLCache } from "@/lib/salesforce/cache";
import type { SellingModelOption, SellingModelResolution, SellingModelType } from "@/lib/quotes/types";

/**
 * Classify from Salesforce Revenue Cloud's OWN `ProductSellingModel.SellingModelType`
 * picklist value — this is the field the platform's own validation rules
 * (e.g. "When the SellingModelType is Evergreen or Term-Defined,
 * BillingFrequency can't be null") are actually keyed on. Normalizes
 * spacing/hyphenation so "One-Time", "One Time", "Term Defined" etc. all match.
 */
function classifyFromFieldValue(raw: string | undefined | null): SellingModelType | null {
  if (!raw) return null;
  const v = raw.toLowerCase().replace(/[\s-]/g, "");
  if (v.includes("onetime")) return "OneTime";
  if (v.includes("evergreen")) return "Evergreen";
  if (v.includes("termdefined") || v === "term") return "TermDefined";
  return null;
}

/**
 * Fallback ONLY: keyword-match the selling model's Name when the real
 * `SellingModelType` field didn't resolve. Real-world selling models are
 * commonly named by BILLING CADENCE ("Annual", "Monthly", "Quarterly")
 * rather than literally containing "evergreen"/"term" — a recognized
 * cadence word is strong evidence of a recurring model, classified as
 * Evergreen (both Evergreen and Term-Defined require BillingFrequency, so
 * the distinction doesn't change what this app needs to do with it).
 */
function classifyFromName(name: string): SellingModelType {
  const n = name.toLowerCase();
  if (n.includes("one-time") || n.includes("one time") || n.includes("onetime")) return "OneTime";
  if (n.includes("evergreen")) return "Evergreen";
  if (n.includes("term")) return "TermDefined";
  if (/\b(annual|yearly|monthly|quarterly|weekly|daily|recurring|subscription)\b/.test(n)) return "Evergreen";
  return "Unknown";
}

interface RawOptionRow {
  Id: string;
  Product2Id: string;
  IsDefault?: boolean;
  IsActive?: boolean;
  ProductSellingModelId: string;
}

const sellingModelTypeFieldCache = createTTLCache<string | null>();

/** Resolve the real Describe field name for ProductSellingModel's type picklist. */
async function resolveSellingModelTypeFieldName(client: SalesforceClient): Promise<string | null> {
  return sellingModelTypeFieldCache.getOrCompute(client.instanceUrl, async () => {
    try {
      const describe = await describeObjectCached(client, "ProductSellingModel");
      return resolveField(describe, "SellingModelType", /^selling model type$/i)?.name ?? null;
    } catch {
      return null;
    }
  });
}

export interface ProductSellingModelInfo {
  id: string;
  name: string;
  rawType: string | null;
  type: SellingModelType;
}

/**
 * Load ProductSellingModel records DIRECTLY by Id — Describe-driven,
 * independent of ProductSellingModelOption entirely. This is the primary
 * source of truth once a ProductSellingModelId is already known (e.g. from
 * `PricebookEntry.ProductSellingModelId`) — ProductSellingModelOption is a
 * multiple-choice/metadata object, not a required gate in front of a
 * selling model we can already identify directly.
 */
export async function fetchProductSellingModelsByIds(client: SalesforceClient, sellingModelIds: string[]): Promise<Map<string, ProductSellingModelInfo>> {
  const result = new Map<string, ProductSellingModelInfo>();
  if (sellingModelIds.length === 0) return result;

  const typeFieldName = await resolveSellingModelTypeFieldName(client);
  const selectFields = ["Id", "Name", ...(typeFieldName ? [typeFieldName] : [])];

  const chunks: string[][] = [];
  for (let i = 0; i < sellingModelIds.length; i += 100) chunks.push(sellingModelIds.slice(i, i + 100));

  for (const chunk of chunks) {
    const ids = chunk.map(id => `'${soqlEscape(id)}'`).join(",");
    const soql = `SELECT ${selectFields.join(", ")} FROM ProductSellingModel WHERE Id IN (${ids})`;
    try {
      const res = await client.query<Record<string, unknown>>(soql);
      console.log(`[fetchProductSellingModelsByIds] SOQL: ${soql} -> ${res.records.length} row(s)`);
      for (const row of res.records) {
        const id = row.Id as string;
        const name = (row.Name as string) ?? "Unknown";
        const rawType = typeFieldName ? ((row[typeFieldName] as string) ?? null) : null;
        result.set(id, { id, name, rawType, type: classifyFromFieldValue(rawType) ?? classifyFromName(name) });
      }
    } catch (err) {
      console.error(`[fetchProductSellingModelsByIds] SOQL FAILED: ${soql}`, err instanceof Error ? err.message : err);
    }
  }
  return result;
}

const pricebookEntrySellingModelFieldCache = createTTLCache<string | null>();

/**
 * Resolve the real Describe field name for PricebookEntry's own selling
 * model reference. In Revenue Cloud, a product can have MULTIPLE
 * PricebookEntry rows in the same price book — one per selling model
 * (e.g. a "One-Time" priced entry and a separate "Annual" priced entry) —
 * so the entry the user actually picked in the catalog unambiguously
 * determines which selling model applies.
 */
async function resolvePricebookEntrySellingModelFieldName(client: SalesforceClient): Promise<string | null> {
  return pricebookEntrySellingModelFieldCache.getOrCompute(client.instanceUrl, async () => {
    try {
      const describe = await describeObjectCached(client, "PricebookEntry");
      return resolveField(describe, "ProductSellingModelId", /^selling model$/i)?.name ?? null;
    } catch {
      return null;
    }
  });
}

/** Batch-resolve which ProductSellingModel each of a set of PricebookEntries is linked to (if the org has that field at all). */
async function resolvePricebookEntrySellingModelIds(client: SalesforceClient, pricebookEntryIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (pricebookEntryIds.length === 0) return result;
  const fieldName = await resolvePricebookEntrySellingModelFieldName(client);
  if (!fieldName) return result;

  const chunks: string[][] = [];
  for (let i = 0; i < pricebookEntryIds.length; i += 100) chunks.push(pricebookEntryIds.slice(i, i + 100));
  for (const chunk of chunks) {
    const ids = chunk.map(id => `'${soqlEscape(id)}'`).join(",");
    const soql = `SELECT Id, ${fieldName} FROM PricebookEntry WHERE Id IN (${ids})`;
    try {
      const res = await client.query<Record<string, unknown>>(soql);
      console.log(`[resolvePricebookEntrySellingModelIds] SOQL: ${soql} -> ${res.records.length} row(s)`);
      for (const row of res.records) {
        const value = row[fieldName] as string | undefined;
        if (value) result.set(row.Id as string, value);
      }
    } catch (err) {
      console.error(`[resolvePricebookEntrySellingModelIds] SOQL FAILED: ${soql}`, err instanceof Error ? err.message : err);
    }
  }
  return result;
}

/**
 * Resolve Selling Model OPTIONS for a set of products by querying the
 * `ProductSellingModelOption` junction object — this is a MULTIPLE-CHOICE /
 * metadata source (which options exist, which is flagged default/active),
 * NOT the sole path to determining a product's selling model. A product
 * can have zero ProductSellingModelOption rows and still have a perfectly
 * well-defined selling model via its PricebookEntry's direct
 * `ProductSellingModelId` link — see `resolveSellingModelsBatch`, which
 * uses this function's results as one input among several, never the only one.
 *
 * Split into two independent queries: Query A (this object's own columns,
 * no relationship traversal) is always attempted and cannot be broken by a
 * bad relationship-alias guess; Query B (`fetchProductSellingModelsByIds`,
 * enrichment by Id) degrades independently.
 */
export async function resolveSellingModelsForProducts(
  client: SalesforceClient,
  productIds: string[],
): Promise<Map<string, SellingModelOption[]>> {
  const result = new Map<string, SellingModelOption[]>();
  if (productIds.length === 0) return result;
  for (const id of productIds) result.set(id, []);

  let isDefaultField = "IsDefault";
  let isActiveField = "IsActive";
  try {
    const describe = await describeObjectCached(client, "ProductSellingModelOption");
    isDefaultField = resolveField(describe, "IsDefault", /^default$/i)?.name ?? isDefaultField;
    isActiveField = resolveField(describe, "IsActive", /^active$/i)?.name ?? isActiveField;
  } catch {
    // Describe failed — proceed with the well-known names; the query itself will fail gracefully below if wrong.
  }

  const rawRows: RawOptionRow[] = [];
  const chunks: string[][] = [];
  for (let i = 0; i < productIds.length; i += 100) chunks.push(productIds.slice(i, i + 100));

  for (const chunk of chunks) {
    const ids = chunk.map(id => `'${soqlEscape(id)}'`).join(",");
    // ORDER BY Id: without an explicit order, Salesforce does not guarantee
    // row order is stable across repeated executions of the same query.
    // chooseOption()'s "first-active"/"first-returned" tie-break (below)
    // depends on a stable order — otherwise the SAME product can resolve to
    // a DIFFERENT chosen Selling Model Option on two calls a few seconds
    // apart (e.g. once at product-configure/add time, once again at
    // create-time), which is exactly what lets a product silently skip the
    // Billing Frequency prompt at add-time and then fail line-item creation
    // moments later demanding one.
    const soql = `SELECT Id, Product2Id, ${isDefaultField}, ${isActiveField}, ProductSellingModelId
      FROM ProductSellingModelOption WHERE Product2Id IN (${ids}) ORDER BY Id`;
    try {
      const res = await client.query<RawOptionRow>(soql);
      console.log(`[resolveSellingModelsForProducts] SOQL: ${soql.replace(/\s+/g, " ")} -> ${res.records.length} row(s) for product(s): ${ids}`);
      rawRows.push(...res.records);
    } catch (err) {
      console.error(`[resolveSellingModelsForProducts] SOQL FAILED: ${soql.replace(/\s+/g, " ")}`, err instanceof Error ? err.message : err);
    }
  }
  if (rawRows.length === 0) return result;

  const sellingModelIds = [...new Set(rawRows.map(r => r.ProductSellingModelId))];
  const infoById = await fetchProductSellingModelsByIds(client, sellingModelIds);

  for (const row of rawRows) {
    const info = infoById.get(row.ProductSellingModelId);
    const name = info?.name ?? "Unknown";
    const type = info?.type ?? classifyFromName(name);
    const option: SellingModelOption = {
      id: row.Id,
      name,
      sellingModelId: row.ProductSellingModelId,
      isDefault: !!(row as unknown as Record<string, unknown>)[isDefaultField],
      isActive: !!(row as unknown as Record<string, unknown>)[isActiveField],
      requiresBillingFrequency: type === "Evergreen" || type === "TermDefined",
      type,
    };
    const list = result.get(row.Product2Id) ?? [];
    list.push(option);
    result.set(row.Product2Id, list);
  }
  return result;
}

/**
 * Preference order (§4.2): default+active > active+requires-frequency > any
 * active > first returned. The PricebookEntry-linked case is handled by the
 * caller BEFORE this ever runs (see resolveSellingModelsBatch).
 *
 * Sorted by `id` FIRST so the "any active"/"first returned" tiers — which
 * pick literally whichever candidate appears first — are a pure function of
 * the option set, never of whatever order the caller's array happens to be
 * in. Without this, the same product with multiple ambiguous active options
 * (none flagged default, none requiring billing frequency) could resolve to
 * a DIFFERENT chosen option on two separate calls, which is exactly the kind
 * of disagreement that must never happen for a single shared resolver.
 */
function chooseOption(options: SellingModelOption[]): { chosen: SellingModelOption | null; reason: SellingModelResolution["chosenReason"] } {
  const sorted = [...options].sort((a, b) => a.id.localeCompare(b.id));
  const defaultActive = sorted.find(o => o.isDefault && o.isActive);
  if (defaultActive) return { chosen: defaultActive, reason: "default-active" };
  const activeWithFrequency = sorted.find(o => o.isActive && o.requiresBillingFrequency);
  if (activeWithFrequency) return { chosen: activeWithFrequency, reason: "requires-frequency" };
  const anyActive = sorted.find(o => o.isActive);
  if (anyActive) return { chosen: anyActive, reason: "first-active" };
  if (sorted[0]) return { chosen: sorted[0], reason: "first-returned" };
  return { chosen: null, reason: "none" };
}

/**
 * Build a synthetic SellingModelOption directly from a ProductSellingModel
 * record (no ProductSellingModelOption row required) — used when a
 * PricebookEntry already tells us exactly which selling model applies.
 * Treated as both default and active: it's the unambiguous answer for
 * THIS specific priced catalog entry, not a candidate among many.
 */
function toDirectOption(info: ProductSellingModelInfo): SellingModelOption {
  return {
    id: `direct:${info.id}`,
    name: info.name,
    sellingModelId: info.id,
    isDefault: true,
    isActive: true,
    requiresBillingFrequency: info.type === "Evergreen" || info.type === "TermDefined",
    type: info.type,
    // §Never send a fake id to Salesforce: this `id` is a synthetic
    // placeholder (no real ProductSellingModelOption row backs it) — every
    // caller writing to a QuoteLineItem must use `sellingModelId` (the real
    // ProductSellingModel Id, above) for a parent-typed reference field, and
    // must treat `id` as absent for a ProductSellingModelOption-typed one.
    isSynthetic: true,
  };
}

/**
 * Resolve the Selling Model for a single product, in the order the org's
 * data actually supports (§Implement A New Resolution Order):
 *   1. The specific PricebookEntry's own `ProductSellingModelId` link,
 *      loaded DIRECTLY from ProductSellingModel — authoritative and
 *      sufficient on its own, no ProductSellingModelOption row required.
 *   2. Only if no PricebookEntry link exists: search
 *      ProductSellingModelOption for candidates and choose among them.
 */
export async function resolveSellingModelForProduct(
  client: SalesforceClient,
  productId: string,
  pricebookEntryId: string | null = null,
): Promise<SellingModelResolution> {
  const batch = await resolveSellingModelsBatch(client, [productId], pricebookEntryId ? new Map([[productId, pricebookEntryId]]) : undefined);
  return batch.get(productId) ?? { productId, pricebookEntryId, pricebookEntrySellingModelId: null, options: [], chosen: null, chosenReason: "none" };
}

/**
 * Batch selling-model resolution. For every product with a resolved
 * PricebookEntry→ProductSellingModel link, that link is loaded DIRECTLY
 * and used as the chosen selling model — ProductSellingModelOption is
 * consulted only to enrich the candidate list (for display / multi-option
 * UI) and as the FALLBACK search when no direct link exists at all.
 */
export async function resolveSellingModelsBatch(
  client: SalesforceClient,
  productIds: string[],
  pricebookEntryByProductId?: Map<string, string>,
): Promise<Map<string, SellingModelResolution>> {
  const optionsByProduct = await resolveSellingModelsForProducts(client, productIds);

  const pricebookEntryIds = pricebookEntryByProductId ? [...new Set(pricebookEntryByProductId.values())] : [];
  const linkedSellingModelByEntry = pricebookEntryIds.length > 0 ? await resolvePricebookEntrySellingModelIds(client, pricebookEntryIds) : new Map<string, string>();

  // Resolve the ProductSellingModel record directly for every linked Id,
  // regardless of whether ProductSellingModelOption had a matching row.
  const linkedSellingModelIds = [...new Set([...linkedSellingModelByEntry.values()])];
  const directInfoById = await fetchProductSellingModelsByIds(client, linkedSellingModelIds);

  const result = new Map<string, SellingModelResolution>();
  for (const productId of productIds) {
    const options = optionsByProduct.get(productId) ?? [];
    const pricebookEntryId = pricebookEntryByProductId?.get(productId) ?? null;
    const linkedSellingModelId = pricebookEntryId ? (linkedSellingModelByEntry.get(pricebookEntryId) ?? null) : null;

    if (linkedSellingModelId) {
      const existingMatch = options.find(o => o.sellingModelId === linkedSellingModelId);
      if (existingMatch) {
        result.set(productId, { productId, pricebookEntryId, pricebookEntrySellingModelId: linkedSellingModelId, options, chosen: existingMatch, chosenReason: "pricebook-entry-linked" });
        continue;
      }
      const directInfo = directInfoById.get(linkedSellingModelId);
      if (directInfo) {
        const directOption = toDirectOption(directInfo);
        result.set(productId, {
          productId, pricebookEntryId, pricebookEntrySellingModelId: linkedSellingModelId,
          options: [...options, directOption], chosen: directOption, chosenReason: "pricebook-entry-linked",
        });
        continue;
      }
      // The link exists but ProductSellingModel itself couldn't be loaded — fall through to the ProductSellingModelOption search below rather than giving up.
    }

    const { chosen, reason } = chooseOption(options);
    result.set(productId, { productId, pricebookEntryId, pricebookEntrySellingModelId: linkedSellingModelId, options, chosen, chosenReason: reason });
  }
  return result;
}
