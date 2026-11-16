import { deriveCapabilities, objectCapFromDescribe, type ObjectCap, type RampCapabilities } from "@/lib/ramp/capabilities";
import type { LineFacts, ProductFacts, QuoteFacts, RampSegmentFacts, SellingModelFacts } from "@/lib/ramp/eligibility";
import type { SegmentResult } from "@/lib/ramp/types";
import { soql, type RampApi } from "./api";

/** READ-ONLY Salesforce reads for RAMP. Columns are chosen from the org's own Describe (a field this org lacks is never queried). */

export async function objectCaps(api: RampApi): Promise<Record<string, ObjectCap>> {
  const names = ["Product2", "ProductRampSegment", "QuoteLineItem", "QuoteLineGroup", "Quote"];
  const ds = await Promise.all(names.map(n => api.describe(n)));
  return Object.fromEntries(names.map((n, i) => [n, objectCapFromDescribe(ds[i] as Parameters<typeof objectCapFromDescribe>[0])]));
}

export async function capabilities(api: RampApi): Promise<RampCapabilities> {
  return deriveCapabilities(api.apiVersion, await objectCaps(api));
}

const has = (caps: Record<string, ObjectCap>, o: string, f: string) => !!caps[o]?.fields[f];
const s = (v: unknown) => (typeof v === "string" && v ? v : null);
const n = (v: unknown) => (typeof v === "number" ? v : null);

/* ── record pickers ── */

export async function searchAccounts(api: RampApi, q: string) {
  const rows = await api.query<{ Id: string; Name: string }>(`SELECT Id, Name FROM Account${q.trim() ? ` WHERE Name LIKE ${soql(`%${q.trim()}%`)}` : ""} ORDER BY LastModifiedDate DESC LIMIT 25`);
  return rows.map(r => ({ id: r.Id, name: r.Name }));
}

/**
 * Quote search for the RAMP pickers — server-side, this request's own session, verified against the org's Quote Describe:
 *  · the Account filter matches BOTH Quote.QuoteAccountId (where Revenue Cloud quotes keep the account — Quote.AccountId is null on
 *    most p10/p12 quotes) and Quote.AccountId (the Opportunity-derived standard field), whichever of them the org has;
 *  · "Draft" must be one of the org's Quote.Status picklist values — otherwise the search fails loudly instead of returning nothing;
 *  · the text matches Quote Name OR Quote Number;
 *  · paged with LIMIT/OFFSET (one extra row tells whether more exist).
 * If the Quote Describe can't be read the search THROWS — it never guesses fields and silently returns an empty list.
 */
export interface QuoteSearchRow { id: string; name: string; quoteNumber: string | null; status: string | null; accountId: string | null; accountName: string | null; opportunityName: string | null; expirationDate: string | null; grandTotal: number | null; lastModifiedDate: string | null; pricebookId: string | null }
export interface QuoteSearchResult { rows: QuoteSearchRow[]; page: number; pageSize: number; hasMore: boolean; draftStatus: string | null; accountFields: string[] }

export const QUOTE_DRAFT_STATUS = "Draft";
/** A SOQL `LIKE '%text%'` literal: backslash + quote escaped as string-literal escapes, user `%` / `_` escaped so they match literally. */
export const likeContains = (v: string) => `'%${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[%_]/g, m => `\\${m}`)}%'`;

async function quoteDescribe(api: RampApi): Promise<ObjectCap> {
  const d = await api.describe("Quote");
  if (!d) throw new Error("Salesforce didn't return the Quote object's fields (Describe failed or Quote isn't visible to your user), so quotes can't be searched.");
  return objectCapFromDescribe(d as Parameters<typeof objectCapFromDescribe>[0]);
}
/** The Quote account reference fields this org has, in priority order (QuoteAccountId first). */
export function quoteAccountFields(cap: ObjectCap): string[] { return ["QuoteAccountId", "AccountId"].filter(f => !!cap.fields[f]); }

export async function searchQuotes(api: RampApi, opts: { accountId?: string | null; q?: string; draftOnly?: boolean; page?: number; pageSize?: number } = {}): Promise<QuoteSearchResult> {
  const cap = await quoteDescribe(api);
  const has = (f: string) => !!cap.fields[f];
  const accountFields = quoteAccountFields(cap);
  const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? 25), 1), 100);
  const page = Math.min(Math.max(Math.trunc(opts.page ?? 1), 1), Math.floor(2000 / pageSize) + 1); // SOQL OFFSET max 2000
  const draftOnly = opts.draftOnly ?? true;
  let draftStatus: string | null = null;
  if (draftOnly) {
    const values = cap.fields.Status?.picklist ?? [];
    if (!values.includes(QUOTE_DRAFT_STATUS)) throw new Error(`This org's Quote.Status has no "${QUOTE_DRAFT_STATUS}" value (values: ${values.join(", ") || "none visible"}), so Draft quotes can't be identified.`);
    draftStatus = QUOTE_DRAFT_STATUS;
  }
  const where: string[] = [];
  if (draftStatus) where.push(`Status = ${soql(draftStatus)}`);
  if (opts.accountId) {
    if (!accountFields.length) throw new Error("This org's Quote has no account field visible to your user (QuoteAccountId / AccountId), so quotes can't be filtered by account.");
    where.push(accountFields.length === 1 ? `${accountFields[0]} = ${soql(opts.accountId)}` : `(${accountFields.map(f => `${f} = ${soql(opts.accountId!)}`).join(" OR ")})`);
  }
  const q = (opts.q ?? "").trim().slice(0, 80);
  if (q) {
    const pat = likeContains(q);
    where.push(has("QuoteNumber") ? `(Name LIKE ${pat} OR QuoteNumber LIKE ${pat})` : `Name LIKE ${pat}`);
  }
  const cols = ["Id", "Name", ...["QuoteNumber", "Status", "QuoteAccountId", "AccountId", "ExpirationDate", "GrandTotal", "LastModifiedDate", "Pricebook2Id"].filter(has),
    ...(has("QuoteAccountId") ? ["QuoteAccount.Name"] : []), ...(has("AccountId") ? ["Account.Name"] : []), ...(has("OpportunityId") ? ["Opportunity.Name"] : [])];
  const rows = await api.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM Quote${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY LastModifiedDate DESC, Id DESC LIMIT ${pageSize + 1} OFFSET ${(page - 1) * pageSize}`);
  const name = (r: Record<string, unknown>, rel: string) => s((r[rel] as { Name?: unknown } | null)?.Name);
  return {
    page, pageSize, hasMore: rows.length > pageSize, draftStatus, accountFields,
    rows: rows.slice(0, pageSize).map(r => ({
      id: String(r.Id), name: String(r.Name ?? r.Id), quoteNumber: s(r.QuoteNumber), status: s(r.Status),
      accountId: s(r.QuoteAccountId) ?? s(r.AccountId), accountName: name(r, "QuoteAccount") ?? name(r, "Account"), opportunityName: name(r, "Opportunity"),
      expirationDate: s(r.ExpirationDate), grandTotal: n(r.GrandTotal), lastModifiedDate: s(r.LastModifiedDate), pricebookId: s(r.Pricebook2Id),
    })),
  };
}

export async function quoteFacts(api: RampApi, quoteId: string): Promise<QuoteFacts | null> {
  const cap = await quoteDescribe(api);
  const acct = quoteAccountFields(cap);
  const [r] = await api.query<Record<string, unknown>>(`SELECT Id, Name, Status, ${[...acct, "Pricebook2Id"].filter(f => !!cap.fields[f]).join(", ")} FROM Quote WHERE Id = ${soql(quoteId)} LIMIT 1`);
  return r ? { id: String(r.Id), name: String(r.Name), status: s(r.Status), accountId: acct.map(f => s(r[f])).find(Boolean) ?? null, pricebookId: s(r.Pricebook2Id) } : null;
}

const LINE_FIELDS = ["Id", "QuoteId", "Product2Id", "Product2.Name", "ProductSellingModelId", "SellingModelType", "RampIdentifier", "QuoteLineGroupId", "StartDate", "EndDate", "Quantity", "UnitPrice", "PeriodBoundary", "SubscriptionTerm", "Discount", "UnitPriceUplift", "ApplUnitPriceUpliftPct", "RampUpliftType", "NetUnitPrice", "NetTotalPrice", "SegmentName", "SegmentType"];
async function lineSelect(api: RampApi) {
  const caps = await objectCaps(api);
  return LINE_FIELDS.filter(f => f.includes(".") || has(caps, "QuoteLineItem", f)).join(", ");
}
function toLine(r: Record<string, unknown>): LineFacts & { productName: string | null; segmentName: string | null } {
  return {
    id: String(r.Id), quoteId: String(r.QuoteId), productId: s(r.Product2Id), productName: s((r.Product2 as { Name?: string } | null)?.Name), sellingModelId: s(r.ProductSellingModelId), sellingModelType: s(r.SellingModelType),
    rampIdentifier: s(r.RampIdentifier), groupId: s(r.QuoteLineGroupId), startDate: s(r.StartDate), endDate: s(r.EndDate), quantity: n(r.Quantity), unitPrice: n(r.UnitPrice),
    periodBoundary: s(r.PeriodBoundary), subscriptionTerm: n(r.SubscriptionTerm), segmentName: s(r.SegmentName),
  };
}

export async function quoteLines(api: RampApi, quoteId: string) {
  const rows = await api.query<Record<string, unknown>>(`SELECT ${await lineSelect(api)} FROM QuoteLineItem WHERE QuoteId = ${soql(quoteId)} ORDER BY CreatedDate ASC LIMIT 500`);
  return rows.map(toLine);
}
export async function lineFacts(api: RampApi, lineId: string) {
  const [r] = await api.query<Record<string, unknown>>(`SELECT ${await lineSelect(api)} FROM QuoteLineItem WHERE Id = ${soql(lineId)} LIMIT 1`);
  return r ? toLine(r) : null;
}

export async function quoteGroups(api: RampApi, quoteId: string) {
  const caps = await objectCaps(api);
  const cols = ["Id", "Name", "QuoteId", "SortOrder", "IsRamped", "SegmentType", "StartDate", "EndDate", "UnitPriceUplift", "RampUpliftType", "Discount", "ParentQuoteLineGroupId"].filter(f => has(caps, "QuoteLineGroup", f));
  const rows = await api.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM QuoteLineGroup WHERE QuoteId = ${soql(quoteId)} ORDER BY SortOrder ASC NULLS LAST LIMIT 200`);
  return rows.map(r => ({ id: String(r.Id), name: String(r.Name ?? r.Id), quoteId: String(r.QuoteId), sortOrder: n(r.SortOrder), isRamped: typeof r.IsRamped === "boolean" ? r.IsRamped : null, segmentType: s(r.SegmentType), startDate: s(r.StartDate), endDate: s(r.EndDate), unitPriceUplift: n(r.UnitPriceUplift), rampUpliftType: s(r.RampUpliftType), discount: n(r.Discount), parentId: s(r.ParentQuoteLineGroupId) }));
}

/* ── products ── */

export async function productFacts(api: RampApi, ids: string[]): Promise<Map<string, ProductFacts>> {
  if (!ids.length) return new Map();
  const caps = await objectCaps(api);
  const cols = ["Id", "Name", "IsActive", "ProductCode", "CanRamp", "UsageModelType", "Type"].filter(f => has(caps, "Product2", f));
  const rows = await api.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM Product2 WHERE Id IN (${[...new Set(ids)].map(soql).join(",")})`);
  return new Map(rows.map(r => [String(r.Id), { id: String(r.Id), name: String(r.Name), isActive: typeof r.IsActive === "boolean" ? r.IsActive : null, canRamp: has(caps, "Product2", "CanRamp") && typeof r.CanRamp === "boolean" ? r.CanRamp : null, usageModelType: s(r.UsageModelType), type: s(r.Type), productCode: s(r.ProductCode) }]));
}

/**
 * Product search for Product Ramp Setup / deals. `rampableOnly` filters CanRamp = true IN SALESFORCE; `eligibleOnly` keeps active
 * products with an active TermDefined selling model option (semi-join — never a client-side slice of a partial list).
 */
export async function searchProducts(api: RampApi, q: string, opts: { rampableOnly?: boolean; eligibleOnly?: boolean; limit?: number } = {}) {
  const caps = await objectCaps(api);
  const cols = ["Id", "Name", "ProductCode", "IsActive", "CanRamp", "UsageModelType", "Type"].filter(f => has(caps, "Product2", f));
  const where = ["IsActive = true"];
  if (opts.rampableOnly) { if (!has(caps, "Product2", "CanRamp")) throw new Error("This org's Product2 has no CanRamp field visible to your user, so rampable products can't be filtered."); where.push("CanRamp = true"); }
  if (opts.eligibleOnly) {
    const models = await api.query<{ Id: string }>("SELECT Id FROM ProductSellingModel WHERE SellingModelType = 'TermDefined' AND Status = 'Active' LIMIT 200");
    if (!models.length) return [];
    where.push(`Id IN (SELECT Product2Id FROM ProductSellingModelOption WHERE ProductSellingModelId IN (${models.map(m => soql(m.Id)).join(",")}))`);
  }
  if (q.trim()) where.push(`(Name LIKE ${soql(`%${q.trim()}%`)} OR ProductCode LIKE ${soql(`%${q.trim()}%`)})`);
  const rows = await api.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM Product2 WHERE ${where.join(" AND ")} ORDER BY Name LIMIT ${Math.min(opts.limit ?? 50, 200)}`);
  return rows.map(r => ({ id: String(r.Id), name: String(r.Name), productCode: s(r.ProductCode), canRamp: typeof r.CanRamp === "boolean" ? r.CanRamp : null, usageModelType: s(r.UsageModelType), type: s(r.Type) }));
}

export async function sellingModels(api: RampApi, productId: string): Promise<SellingModelFacts[]> {
  const rows = await api.query<Record<string, unknown>>(`SELECT ProductSellingModelId, ProductSellingModel.Name, ProductSellingModel.SellingModelType, ProductSellingModel.Status FROM ProductSellingModelOption WHERE Product2Id = ${soql(productId)} LIMIT 50`);
  return rows.map(r => { const m = (r.ProductSellingModel ?? {}) as Record<string, unknown>; return { id: String(r.ProductSellingModelId), name: String(m.Name ?? r.ProductSellingModelId), type: s(m.SellingModelType), status: s(m.Status) }; });
}

export async function productRampSegments(api: RampApi, productIds: string[]): Promise<(RampSegmentFacts & { productId: string; sellingModelName: string | null; trialDuration: number | null; durationType: string | null; createdDate: string | null })[]> {
  if (!productIds.length) return [];
  const rows = await api.query<Record<string, unknown>>(`SELECT Id, Name, ProductId, ProductSellingModelId, ProductSellingModel.Name, SegmentType, TrialDuration, DurationType, CreatedDate FROM ProductRampSegment WHERE ProductId IN (${[...new Set(productIds)].map(soql).join(",")}) ORDER BY CreatedDate ASC LIMIT 500`);
  return rows.map(r => ({ id: String(r.Id), name: s(r.Name), productId: String(r.ProductId), sellingModelId: String(r.ProductSellingModelId), sellingModelName: s((r.ProductSellingModel as { Name?: string } | null)?.Name), segmentType: s(r.SegmentType), trialDuration: n(r.TrialDuration), durationType: s(r.DurationType), createdDate: s(r.CreatedDate) }));
}

/* ── read-back ── */

export async function segmentLines(api: RampApi, quoteId: string, where: { rampIdentifier?: string; groupIds?: string[] }): Promise<SegmentResult[]> {
  const cond = where.rampIdentifier ? `RampIdentifier = ${soql(where.rampIdentifier)}` : where.groupIds?.length ? `QuoteLineGroupId IN (${where.groupIds.map(soql).join(",")})` : null;
  if (!cond) return [];
  const rows = await api.query<Record<string, unknown>>(`SELECT ${await lineSelect(api)} FROM QuoteLineItem WHERE QuoteId = ${soql(quoteId)} AND ${cond} ORDER BY StartDate ASC LIMIT 500`);
  return rows.map(r => ({
    id: String(r.Id), name: s(r.SegmentName), startDate: s(r.StartDate), endDate: s(r.EndDate), quantity: n(r.Quantity), discount: n(r.Discount),
    unitPriceUplift: n(r.UnitPriceUplift), appliedUpliftPct: n(r.ApplUnitPriceUpliftPct), rampUpliftType: s(r.RampUpliftType), unitPrice: n(r.UnitPrice),
    netUnitPrice: n(r.NetUnitPrice), netTotalPrice: n(r.NetTotalPrice), groupId: s(r.QuoteLineGroupId), productId: s(r.Product2Id), rampIdentifier: s(r.RampIdentifier),
  }));
}

export async function quotePricing(api: RampApi, quoteId: string): Promise<{ calculationStatus: string | null; lastPricedDate: string | null }> {
  const caps = await objectCaps(api);
  const cols = ["Id", "CalculationStatus", "LastPricedDate"].filter(f => f === "Id" || has(caps, "Quote", f));
  const [r] = await api.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM Quote WHERE Id = ${soql(quoteId)} LIMIT 1`);
  return { calculationStatus: s(r?.CalculationStatus), lastPricedDate: s(r?.LastPricedDate) };
}

/** An async operation Salesforce handed back (statusURL / requestIdentifier): its Status when readable. */
export async function asyncStatus(api: RampApi, statusUrl: string | null): Promise<{ status: string | null; error: string | null; raw: unknown }> {
  if (!statusUrl || !/^\/services\/data\/v\d+\.\d\/sobjects\/(RevenueAsyncOperation|AsyncOperationTracker)\/[a-zA-Z0-9]{15,18}$/.test(statusUrl)) return { status: null, error: null, raw: null };
  const r = await api.call("GET", statusUrl);
  const b = (r.body ?? {}) as Record<string, unknown>;
  return { status: s(b.Status), error: s(b.Response) ?? s(b.ErrorMessage), raw: r.body };
}
