import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { currentIdentity, queryAt } from "@/lib/billing/server/billingDocuments";
import { hasField, objectMeta, selectable } from "@/lib/tax/server/metadata";
import type { GeoCountryRow, LegalEntityRow, ProductRow, TaxConnection, TaxEngineRow, TaxItemRow, TaxMetadata, TaxPolicyRow, TaxProductPage, TaxProviderRow, TaxRateRow, TaxTreatmentRow } from "@/lib/tax/types";

/**
 * Read-only loaders for the tax records of the CONNECTED org. SELECT lists are built from the org's metadata, so a field the org
 * doesn't have is simply not read (instead of the query failing or a value being invented).
 */

export const NATIVE_ENGINE_TYPES = ["RevenueStandardTax"];

export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
export const idList = (ids: string[]) => ids.map(i => `'${soqlEscape(i)}'`).join(",");
const today = () => new Date().toISOString().slice(0, 10);

async function select(client: SalesforceClient, meta: TaxMetadata, obj: string, wanted: string[], tail = ""): Promise<Record<string, unknown>[]> {
  const o = objectMeta(meta, obj);
  if (!o || !o.queryable) return [];
  const cols = selectable(meta, obj, ["Id", ...wanted]);
  return queryAt(client, meta.apiVersion, `SELECT ${cols.join(", ")} FROM ${obj}${tail ? ` ${tail}` : ""}`);
}

export interface TaxSnapshot {
  meta: TaxMetadata;
  engines: TaxEngineRow[]; providers: TaxProviderRow[]; policies: TaxPolicyRow[]; treatments: TaxTreatmentRow[]; items: TaxItemRow[]; rates: TaxRateRow[];
  legalEntities: LegalEntityRow[]; geoCountries: GeoCountryRow[];
}

export async function readEngines(client: SalesforceClient, meta: TaxMetadata): Promise<TaxEngineRow[]> {
  const rows = await select(client, meta, "TaxEngine", ["TaxEngineName", "Type", "Status", "TaxEngineProviderId", "TaxEngineProvider.MasterLabel", "SellerCode", "DecisionTableId"], "ORDER BY CreatedDate");
  return rows.map(r => ({
    id: r.Id as string, name: String(r.TaxEngineName ?? r.Id), type: str(r.Type), status: str(r.Status), sellerCode: str(r.SellerCode),
    provider: str(r.TaxEngineProviderId) ? { id: r.TaxEngineProviderId as string, name: String((r.TaxEngineProvider as Record<string, unknown> | null)?.MasterLabel ?? r.TaxEngineProviderId) } : null,
    native: NATIVE_ENGINE_TYPES.includes(String(r.Type)), decisionTableId: str(r.DecisionTableId),
  }));
}

export async function readProviders(client: SalesforceClient, meta: TaxMetadata): Promise<TaxProviderRow[]> {
  const rows = await select(client, meta, "TaxEngineProvider", ["MasterLabel", "DeveloperName"], "ORDER BY MasterLabel").catch(() => []);
  return rows.map(r => ({ id: r.Id as string, name: String(r.MasterLabel ?? r.DeveloperName ?? r.Id), developerName: str(r.DeveloperName) }));
}

export async function readPolicies(client: SalesforceClient, meta: TaxMetadata): Promise<TaxPolicyRow[]> {
  const rows = await select(client, meta, "TaxPolicy", ["Name", "Status", "TreatmentSelection", "DefaultTaxTreatmentId", "Description"], "ORDER BY CreatedDate");
  const counts = hasField(meta, "Product2", "TaxPolicyId") ? await queryAt(client, meta.apiVersion, "SELECT TaxPolicyId, COUNT(Id) c FROM Product2 WHERE TaxPolicyId != null GROUP BY TaxPolicyId") : [];
  const by = new Map(counts.map(c => [c.TaxPolicyId as string, Number(c.c) || 0]));
  return rows.map(r => ({ id: r.Id as string, name: String(r.Name), status: str(r.Status), selection: str(r.TreatmentSelection), defaultTreatmentId: str(r.DefaultTaxTreatmentId), description: str(r.Description), products: by.get(r.Id as string) ?? 0 }));
}

export async function readTreatments(client: SalesforceClient, meta: TaxMetadata): Promise<TaxTreatmentRow[]> {
  const rows = await select(client, meta, "TaxTreatment", ["Name", "Status", "IsTaxable", "TaxCode", "ProductCode", "TaxPolicyId", "TaxEngineId", "LegalEntityId", "ShouldUseTaxTreatmentItems"], "ORDER BY CreatedDate");
  return rows.map(r => ({
    id: r.Id as string, name: String(r.Name), status: str(r.Status), taxable: r.IsTaxable === true, taxCode: str(r.TaxCode), productCode: str(r.ProductCode),
    policyId: str(r.TaxPolicyId), engineId: str(r.TaxEngineId), legalEntityId: str(r.LegalEntityId), useItems: r.ShouldUseTaxTreatmentItems === true,
  }));
}

export async function readItems(client: SalesforceClient, meta: TaxMetadata): Promise<TaxItemRow[]> {
  const rows = await select(client, meta, "TaxTreatmentItem", ["Name", "TaxTreatmentId", "ProductId", "Product.Name", "TaxCode", "ProductCode"], "ORDER BY CreatedDate");
  return rows.map(r => ({ id: r.Id as string, name: String(r.Name), treatmentId: str(r.TaxTreatmentId), productId: str(r.ProductId), productName: str((r.Product as Record<string, unknown> | null)?.Name), taxCode: str(r.TaxCode), productCode: str(r.ProductCode) }));
}

export async function readRates(client: SalesforceClient, meta: TaxMetadata): Promise<TaxRateRow[]> {
  const rows = await select(client, meta, "TaxRate", ["Name", "TaxCode", "ProductCode", "Rate", "RateUsageType", "ApplicationBasis", "Priority", "Country", "GeoCountryId", "State", "City", "ZipCode", "LegalEntityId", "StartDate", "EndDate", "LastModifiedDate"], "ORDER BY CreatedDate");
  const t = today();
  return rows.map(r => {
    const start = str(r.StartDate), end = str(r.EndDate);
    return {
      id: r.Id as string, name: String(r.Name ?? r.Id), taxCode: str(r.TaxCode), productCode: str(r.ProductCode), rate: num(r.Rate), usage: str(r.RateUsageType),
      country: str(r.Country)?.toUpperCase() ?? null, geoCountryId: str(r.GeoCountryId), legalEntityId: str(r.LegalEntityId), start, end,
      effective: (!start || start <= t) && (!end || end >= t), lastModified: str(r.LastModifiedDate),
      state: str(r.State)?.toUpperCase() ?? null, city: str(r.City), zipCode: str(r.ZipCode), basis: str(r.ApplicationBasis), priority: num(r.Priority),
    };
  });
}

export async function readLegalEntities(client: SalesforceClient, meta: TaxMetadata): Promise<LegalEntityRow[]> {
  const rows = await select(client, meta, "LegalEntity", ["Name", "Status", "LegalEntityCountry"], "ORDER BY CreatedDate");
  return rows.map(r => ({ id: r.Id as string, name: String(r.Name), status: str(r.Status), country: str(r.LegalEntityCountry) }));
}

export async function readGeoCountries(client: SalesforceClient, meta: TaxMetadata): Promise<GeoCountryRow[]> {
  // select() already returns [] when the object isn't available; a failed query propagates (never "no countries").
  const rows = await select(client, meta, "GeoCountry", ["Name", "IsoCode"]);
  return rows.map(r => ({ id: r.Id as string, name: String(r.Name ?? r.IsoCode), iso: String(r.IsoCode ?? "").toUpperCase() }));
}

export async function loadSnapshot(client: SalesforceClient, meta: TaxMetadata): Promise<TaxSnapshot> {
  const [engines, providers, policies, treatments, items, rates, legalEntities, geoCountries] = await Promise.all([
    readEngines(client, meta), readProviders(client, meta), readPolicies(client, meta), readTreatments(client, meta), readItems(client, meta), readRates(client, meta),
    readLegalEntities(client, meta), readGeoCountries(client, meta),
  ]);
  return { meta, engines, providers, policies, treatments, items, rates, legalEntities, geoCountries };
}

const productCols = (meta: TaxMetadata) => selectable(meta, "Product2", ["Id", "Name", "ProductCode", "IsActive", "TaxPolicyId", "Family"]).join(", ");
const toProduct = (r: Record<string, unknown>): ProductRow => ({ id: r.Id as string, name: String(r.Name), code: str(r.ProductCode), active: r.IsActive === true, taxPolicyId: str(r.TaxPolicyId), family: str(r.Family) });

export type ProductResolution = { status: "found"; product: ProductRow } | { status: "not-found" | "inactive" | "ambiguous"; message: string; candidates: ProductRow[] };

/**
 * Resolve a product reference: a picked Id, else an EXACT name or product code (case-insensitive). A partial match is never used —
 * tax mapping must not silently pick "Quickbooks Online" for "Book" — it's offered as a suggestion instead. Inactive products are
 * reported, never used.
 */
export async function resolveProductRef(client: SalesforceClient, meta: TaxMetadata, ref: { id?: string | null; name?: string | null }): Promise<ProductResolution> {
  const v = meta.apiVersion;
  if (ref.id) {
    const [r] = await queryAt(client, v, `SELECT ${productCols(meta)} FROM Product2 WHERE Id = '${soqlEscape(ref.id)}'`);
    if (!r) return { status: "not-found", message: `Product ${ref.id} doesn't exist in the connected org.`, candidates: [] };
    const p = toProduct(r);
    return p.active ? { status: "found", product: p } : { status: "inactive", message: `Product "${p.name}" is inactive in Salesforce.`, candidates: [p] };
  }
  const term = (ref.name ?? "").trim();
  if (!term) return { status: "not-found", message: "No product was given.", candidates: [] };
  const rows = (await queryAt(client, v, `SELECT ${productCols(meta)} FROM Product2 WHERE Name = '${soqlEscape(term)}' OR ProductCode = '${soqlEscape(term)}' ORDER BY IsActive DESC, Name LIMIT 10`)).map(toProduct);
  const active = rows.filter(p => p.active);
  if (active.length === 1) return { status: "found", product: active[0] };
  if (!rows.length) {
    const similar = (await queryAt(client, v, `SELECT ${productCols(meta)} FROM Product2 WHERE IsActive = true AND Name LIKE '%${soqlEscape(term)}%' ORDER BY Name LIMIT 5`).catch(() => [])).map(toProduct);
    return { status: "not-found", message: `No Salesforce product is named "${term}"${similar.length ? ` (similar: ${similar.map(p => `${p.name}${p.code ? ` [${p.code}]` : ""}`).join(", ")} — pick the exact product)` : ""}.`, candidates: similar };
  }
  if (!active.length) return { status: "inactive", message: `Product "${rows[0].name}" is inactive in Salesforce.`, candidates: rows.slice(0, 5) };
  return { status: "ambiguous", message: `"${term}" matches ${active.length} active products (${active.slice(0, 5).map(p => `${p.name}${p.code ? ` [${p.code}]` : ""}`).join(", ")}) — pick one.`, candidates: active.slice(0, 5) };
}

/** Salesforce-backed product search for the manual UI. */
export async function searchProducts(client: SalesforceClient, meta: TaxMetadata, q: string): Promise<ProductRow[]> {
  const term = q.trim();
  const where = term ? `WHERE Name LIKE '%${soqlEscape(term)}%' OR ProductCode LIKE '%${soqlEscape(term)}%'` : "";
  return (await queryAt(client, meta.apiVersion, `SELECT ${productCols(meta)} FROM Product2 ${where} ORDER BY IsActive DESC, Name LIMIT 25`)).map(toProduct);
}

export async function productsByPolicy(client: SalesforceClient, meta: TaxMetadata, policyIds: string[]): Promise<ProductRow[]> {
  if (!policyIds.length || !hasField(meta, "Product2", "TaxPolicyId")) return [];
  // No LIMIT: queryAt follows nextRecordsUrl, so every mapped product is returned (a cap would silently drop some).
  return (await queryAt(client, meta.apiVersion, `SELECT ${productCols(meta)} FROM Product2 WHERE TaxPolicyId IN (${idList(policyIds)}) ORDER BY Name`)).map(toProduct);
}

/** Policies whose products are taxable: an active policy resolving to an active taxable treatment of an active engine. */
export function taxablePolicyIds(engines: TaxEngineRow[], policies: TaxPolicyRow[], treatments: TaxTreatmentRow[]): Set<string> {
  const taxable = treatments.filter(t => t.status === "Active" && t.taxable && engines.some(e => e.id === t.engineId && e.status === "Active"));
  return new Set(policies.filter(p => p.status === "Active" && taxable.some(t => t.id === p.defaultTreatmentId || t.policyId === p.id)).map(p => p.id));
}

/* ── Taxable-product lookup (End-to-end tax verification) ── */

export const PRODUCT_PAGE_SIZE = 50;
export interface ProductCursor { name: string; id: string }

export const escapeLike = (s: string) => soqlEscape(s).replace(/[%_]/g, m => `\\${m}`);
export const encodeProductCursor = (c: ProductCursor) => Buffer.from(JSON.stringify([c.name, c.id]), "utf8").toString("base64url");
export function decodeProductCursor(raw: string | null | undefined): ProductCursor | null {
  if (!raw) return null;
  try {
    const [name, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown[];
    return typeof name === "string" && typeof id === "string" && /^[a-zA-Z0-9]{15,18}$/.test(id) ? { name, id } : null;
  } catch { return null; }
}

/**
 * One page of ACTIVE products (the verification rejects inactive ones), matched on Name or Product Code. Keyset pagination on
 * (Name, Id) — no OFFSET, so it has no 2,000-row ceiling and pages never overlap. Fetches one extra row to know if more exist.
 */
export function taxProductSoql(cols: string, opts: { q: string; after: ProductCursor | null; pageSize: number; hasCode: boolean }): string {
  const where = ["IsActive = true"];
  const term = opts.q.trim();
  if (term) {
    const or = [`Name LIKE '%${escapeLike(term)}%'`];
    if (opts.hasCode) or.push(`ProductCode LIKE '%${escapeLike(term)}%'`);
    if (/^01t[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(term)) or.push(`Id = '${term}'`); // a pasted Product2 Id
    where.push(`(${or.join(" OR ")})`);
  }
  if (opts.after) {
    const n = soqlEscape(opts.after.name);
    where.push(`(Name > '${n}' OR (Name = '${n}' AND Id > '${soqlEscape(opts.after.id)}'))`);
  }
  return `SELECT ${cols} FROM Product2 WHERE ${where.join(" AND ")} ORDER BY Name, Id LIMIT ${opts.pageSize + 1}`;
}

/** Searchable, paged product list for the verification form; each product says whether its tax policy is taxable. */
export async function searchTaxProducts(client: SalesforceClient, meta: TaxMetadata, opts: { q: string; cursor?: string | null; pageSize?: number }): Promise<TaxProductPage> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? PRODUCT_PAGE_SIZE, 1), 200);
  const soql = taxProductSoql(productCols(meta), { q: opts.q, after: decodeProductCursor(opts.cursor), pageSize, hasCode: hasField(meta, "Product2", "ProductCode") });
  const [rows, engines, policies, treatments] = await Promise.all([
    queryAt(client, meta.apiVersion, soql), readEngines(client, meta), readPolicies(client, meta), readTreatments(client, meta),
  ]);
  const page = rows.slice(0, pageSize).map(toProduct);
  const taxableIds = taxablePolicyIds(engines, policies, treatments);
  const last = page[page.length - 1];
  return {
    products: page.map(p => ({ ...p, policyName: policies.find(x => x.id === p.taxPolicyId)?.name ?? null, taxable: !!p.taxPolicyId && taxableIds.has(p.taxPolicyId) })),
    nextCursor: rows.length > pageSize && last ? encodeProductCursor({ name: last.name, id: last.id }) : null,
  };
}

/** The org and user of THIS connection. */
export async function getTaxConnection(client: SalesforceClient): Promise<TaxConnection> {
  const id = await currentIdentity(client);
  const [org] = await queryAt(client, client.apiVersion, "SELECT Id, Name, OrganizationType, IsSandbox FROM Organization LIMIT 1").catch(() => []);
  return {
    orgId: str(org?.Id) ?? id.orgId, orgName: str(org?.Name), orgType: str(org?.OrganizationType), isSandbox: typeof org?.IsSandbox === "boolean" ? org.IsSandbox : null,
    instanceUrl: client.instanceUrl, userId: id.userId, username: id.username, displayName: id.displayName,
  };
}
