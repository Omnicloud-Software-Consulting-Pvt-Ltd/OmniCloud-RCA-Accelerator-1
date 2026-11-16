import { billingFrequencyFor, isSubscription, type LineItemFieldCaps, type SellingModelDetail } from "@/lib/quotes/lineItem/sellingModelFields";
import { likeContains } from "./reads";
import { soql, type RampApi } from "./api";

/**
 * PRODUCT CATALOG FOR QUOTE LINES (Group Ramp "Add products") — every ACTIVE Product2, searched and paged in Salesforce, never
 * restricted by selling-model type or rampability. For the quote's price book each product gets its real options: one per active
 * PricebookEntry (the entry fixes the line's selling model — QuoteLineItem.ProductSellingModelId isn't createable), with the selling
 * model's type, pricing term and the Billing Frequency it implies. Two verdicts are kept separate:
 *  · quoteLine — can a Quote Line Item be created (an active entry in this price book with a usable selling model)?
 *  · groupRamp — can that line take part in a group ramp (Term-Defined + product rampable)?
 */

export interface CatalogOption {
  pricebookEntryId: string; unitPrice: number | null;
  sellingModelId: string | null; sellingModelName: string | null; sellingModelType: string | null; sellingModelStatus: string | null;
  pricingTermUnit: string | null; billingFrequency: string | null; billingFrequencyRequired: boolean;
  usable: boolean; reason: string | null; rampable: boolean;
}
export interface CatalogProduct {
  id: string; name: string; productCode: string | null; sku: string | null; canRamp: boolean | null; usageModelType: string | null;
  /** Selling models offered for the product (ProductSellingModelOption), whether or not this price book prices them. */
  offeredModels: { id: string; name: string; type: string | null }[];
  options: CatalogOption[];
  quoteLine: { ok: boolean; reason: string | null };
  groupRamp: { ok: boolean; reason: string | null };
}
export interface CatalogPage { rows: CatalogProduct[]; page: number; pageSize: number; hasMore: boolean; pricebookId: string | null }

/** Human label for a SellingModelType (the line ramps only when it is Term-Defined). */
export const typeLabel = (t: string | null) => (t === "OneTime" ? "One-Time" : t === "TermDefined" ? "Term-Defined" : t === "Evergreen" ? "Evergreen" : t ?? "selling-model-less");
const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** QuoteLineItem Describe facts the line builder needs (createable fields + active picklist values with labels). */
export async function lineItemFieldCaps(api: RampApi): Promise<LineItemFieldCaps> {
  const d = (await api.describe("QuoteLineItem")) as { fields?: { name: string; createable?: boolean; picklistValues?: { value: string; label?: string; active?: boolean }[] }[] } | null;
  if (!d) throw new Error("Salesforce didn't return the QuoteLineItem fields (Describe failed).");
  const f = (n: string) => d.fields?.find(x => x.name === n);
  const active = (n: string) => (f(n)?.picklistValues ?? []).filter(p => p.active !== false);
  return {
    createable: n => !!f(n)?.createable,
    billingFrequencyOptions: active("BillingFrequency").map(p => ({ value: p.value, label: p.label ?? p.value })),
    periodBoundaryOptions: active("PeriodBoundary").map(p => p.value),
  };
}

/** Selling model details by Id (type, status, pricing term) — columns chosen from the org's Describe. */
export async function sellingModelDetails(api: RampApi, ids: string[]): Promise<Map<string, SellingModelDetail>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const d = (await api.describe("ProductSellingModel")) as { fields?: { name: string }[] } | null;
  const has = (n: string) => !d || !!d.fields?.some(x => x.name === n);
  const cols = ["Id", "Name", "SellingModelType", "Status", "PricingTerm", "PricingTermUnit"].filter(has);
  const rows = await api.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM ProductSellingModel WHERE Id IN (${uniq.map(soql).join(",")})`);
  return new Map(rows.map(r => [String(r.Id), { id: String(r.Id), name: String(r.Name ?? r.Id), type: str(r.SellingModelType), status: str(r.Status), pricingTermUnit: str(r.PricingTermUnit), pricingTerm: typeof r.PricingTerm === "number" ? r.PricingTerm : null }]));
}

export function optionVerdict(sm: SellingModelDetail | null, caps: LineItemFieldCaps): Pick<CatalogOption, "usable" | "reason" | "billingFrequency" | "billingFrequencyRequired"> {
  if (!sm) return { usable: true, reason: null, billingFrequency: null, billingFrequencyRequired: false };
  if (sm.status && sm.status !== "Active") return { usable: false, reason: `Selling model ${sm.name} is ${sm.status}.`, billingFrequency: null, billingFrequencyRequired: false };
  if (!isSubscription(sm.type)) return { usable: true, reason: null, billingFrequency: null, billingFrequencyRequired: false };
  const bf = billingFrequencyFor(sm, caps.billingFrequencyOptions);
  // Not resolvable → still usable: the user picks a Billing Frequency (validated before writing).
  return { usable: caps.createable("BillingFrequency"), reason: caps.createable("BillingFrequency") ? null : "QuoteLineItem.BillingFrequency isn't createable for your user.", billingFrequency: bf?.value ?? null, billingFrequencyRequired: true };
}

export async function searchCatalog(api: RampApi, o: { q?: string; pricebookId: string | null; page?: number; pageSize?: number; inPricebookOnly?: boolean }): Promise<CatalogPage> {
  const pageSize = Math.min(Math.max(Math.trunc(o.pageSize ?? 25), 1), 100);
  const page = Math.min(Math.max(Math.trunc(o.page ?? 1), 1), Math.floor(2000 / pageSize) + 1);
  const pd = (await api.describe("Product2")) as { fields?: { name: string }[] } | null;
  const has = (n: string) => !!pd?.fields?.some(x => x.name === n);
  const cols = ["Id", "Name", "ProductCode", "StockKeepingUnit", "CanRamp", "UsageModelType"].filter(c => c === "Id" || c === "Name" || has(c));
  const where = ["IsActive = true"];
  const q = (o.q ?? "").trim().slice(0, 80);
  if (q) {
    const pat = likeContains(q);
    const ors = [`Name LIKE ${pat}`, ...(has("ProductCode") ? [`ProductCode LIKE ${pat}`] : []), ...(has("StockKeepingUnit") ? [`StockKeepingUnit LIKE ${pat}`] : []), ...(ID.test(q) && q.startsWith("01t") ? [`Id = ${soql(q)}`] : [])];
    where.push(`(${ors.join(" OR ")})`);
  }
  if (o.inPricebookOnly && o.pricebookId) where.push(`Id IN (SELECT Product2Id FROM PricebookEntry WHERE Pricebook2Id = ${soql(o.pricebookId)} AND IsActive = true)`);
  const prows = await api.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM Product2 WHERE ${where.join(" AND ")} ORDER BY Name ASC, Id ASC LIMIT ${pageSize + 1} OFFSET ${(page - 1) * pageSize}`);
  return { rows: await catalogRows(api, prows.slice(0, pageSize), o.pricebookId), page, pageSize, hasMore: prows.length > pageSize, pricebookId: o.pricebookId };
}

/** One product as a catalog row (the "Add product" selection: its real options in this price book). */
export async function catalogProduct(api: RampApi, productId: string, pricebookId: string | null): Promise<CatalogProduct | null> {
  const pd = (await api.describe("Product2")) as { fields?: { name: string }[] } | null;
  const cols = ["Id", "Name", "ProductCode", "StockKeepingUnit", "CanRamp", "UsageModelType", "IsActive"].filter(c => c === "Id" || c === "Name" || !!pd?.fields?.some(x => x.name === c));
  const [r] = await api.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM Product2 WHERE Id = ${soql(productId)} LIMIT 1`);
  if (!r) return null;
  const [row] = await catalogRows(api, [r], pricebookId);
  if (r.IsActive === false) row.quoteLine = { ok: false, reason: "The product is inactive." };
  return row;
}

async function catalogRows(api: RampApi, products: Record<string, unknown>[], pricebookId: string | null): Promise<CatalogProduct[]> {
  const ids = products.map(r => String(r.Id));
  if (!ids.length) return [];
  const o = { pricebookId };

  const pbeDescribe = (await api.describe("PricebookEntry")) as { fields?: { name: string }[] } | null;
  const psmAware = !!pbeDescribe?.fields?.some(x => x.name === "ProductSellingModelId");
  const [entries, offered, caps] = await Promise.all([
    o.pricebookId ? api.query<Record<string, unknown>>(`SELECT Id, Product2Id, UnitPrice${psmAware ? ", ProductSellingModelId" : ""} FROM PricebookEntry WHERE Pricebook2Id = ${soql(o.pricebookId)} AND IsActive = true AND Product2Id IN (${ids.map(soql).join(",")})`) : Promise.resolve([]),
    api.query<Record<string, unknown>>(`SELECT Product2Id, ProductSellingModelId FROM ProductSellingModelOption WHERE Product2Id IN (${ids.map(soql).join(",")})`).catch(() => [] as Record<string, unknown>[]),
    lineItemFieldCaps(api),
  ]);
  const models = await sellingModelDetails(api, [...entries.map(e => str(e.ProductSellingModelId)), ...offered.map(x => str(x.ProductSellingModelId))].filter((x): x is string => !!x));

  return products.map(r => {
    const id = String(r.Id);
    const canRamp = typeof r.CanRamp === "boolean" ? r.CanRamp : null;
    const offeredModels = offered.filter(x => x.Product2Id === id).map(x => models.get(String(x.ProductSellingModelId))).filter((m): m is SellingModelDetail => !!m).map(m => ({ id: m.id, name: m.name, type: m.type }));
    const options: CatalogOption[] = entries.filter(e => e.Product2Id === id).map(e => {
      const sm = str(e.ProductSellingModelId) ? models.get(String(e.ProductSellingModelId)) ?? null : null;
      const v = optionVerdict(sm, caps);
      return { pricebookEntryId: String(e.Id), unitPrice: typeof e.UnitPrice === "number" ? e.UnitPrice : null, sellingModelId: sm?.id ?? null, sellingModelName: sm?.name ?? null, sellingModelType: sm?.type ?? null, sellingModelStatus: sm?.status ?? null, pricingTermUnit: sm?.pricingTermUnit ?? null, ...v, rampable: v.usable && sm?.type === "TermDefined" && canRamp !== false };
    }).sort((a, b) => (a.sellingModelName ?? "").localeCompare(b.sellingModelName ?? ""));
    const usable = options.filter(x => x.usable);
    const quoteLine = !o.pricebookId ? { ok: false, reason: "The quote has no price book." }
      : usable.length ? { ok: true, reason: null }
      : options.length ? { ok: false, reason: options.map(x => x.reason).filter(Boolean).join(" ") || "No usable Price Book Entry." }
      : { ok: false, reason: offeredModels.length ? `No active Price Book Entry in this price book (selling models offered: ${offeredModels.map(m => m.name).join(", ")}).` : "No active Price Book Entry in this price book, and no selling model is set up for the product." };
    const termOption = usable.find(x => x.sellingModelType === "TermDefined");
    const groupRamp = !quoteLine.ok ? { ok: false, reason: "Can't be added to the quote." }
      : !termOption ? { ok: false, reason: `Quote line only — ${[...new Set(usable.map(x => typeLabel(x.sellingModelType)))].join(" / ")} lines don't ramp (term-defined only).` }
      : canRamp === false ? { ok: false, reason: "Quote line only — not rampable yet (no Product Ramp Segment; set one up in Product Ramp Setup)." }
      : { ok: true, reason: r.UsageModelType ? `Usage model ${String(r.UsageModelType)}: line ramps refuse it; group ramps have accepted Anchor products.` : null };
    return { id, name: String(r.Name), productCode: str(r.ProductCode), sku: str(r.StockKeepingUnit), canRamp, usageModelType: str(r.UsageModelType), offeredModels, options, quoteLine, groupRamp };
  });
}
