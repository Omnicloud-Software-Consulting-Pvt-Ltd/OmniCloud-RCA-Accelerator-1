import type { RampApi } from "@/lib/ramp/server/api";
import { soql } from "@/lib/ramp/server/api";
import { sellingModelDetails } from "@/lib/ramp/server/catalog";
import { assetEligibility, assetState, day, EXPIRING_DAYS } from "../eligibility";
import { LINE_TYPE_VALUES, swapPath, type QuoteLineFacts } from "../plan";
import { ACTION_TYPE, INITIATE_ACTION, LIFECYCLE_KINDS, type AssetAttributeValue, type AssetContractLink, type AssetFacts, type AssetRow, type AssetState, type LifecycleKind, type OpenTransaction, type PostalAddress, type ReasonField } from "../types";

/**
 * Asset lifecycle reads — read-only SOQL / Describe against the connected org at its newest API version. Every column is chosen from
 * the org's Describe (an org without a field simply doesn't get it in the SELECT); no record Id, name or org URL is assumed.
 */

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" && v ? v : null);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const b = (v: unknown) => (typeof v === "boolean" ? v : null);
export const rel = (r: Row, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Row)[k] : undefined), r);
const ids = (v: string[]) => [...new Set(v.filter(Boolean))].map(soql).join(",");
const uniq = <T,>(v: (T | null | undefined)[]) => [...new Set(v.filter((x): x is T => x !== null && x !== undefined))];

interface FieldInfo { name: string; type?: string; label?: string; updateable?: boolean; createable?: boolean; custom?: boolean; picklistValues?: { value: string; label?: string; active?: boolean }[] }
interface DescribeInfo { fields: FieldInfo[]; createable?: boolean; updateable?: boolean; queryable?: boolean }

const describeCache = new WeakMap<RampApi, Map<string, Promise<DescribeInfo | null>>>();
export async function describeOf(api: RampApi, sobject: string): Promise<DescribeInfo | null> {
  let m = describeCache.get(api);
  if (!m) { m = new Map(); describeCache.set(api, m); }
  if (!m.has(sobject)) m.set(sobject, api.describe(sobject).then(d => (d && Array.isArray((d as { fields?: unknown }).fields) ? (d as unknown as DescribeInfo) : null)).catch(() => null));
  return m.get(sobject)!;
}
/** The org's field names for an object (null = the object doesn't exist / isn't readable). */
export async function fieldsOf(api: RampApi, sobject: string): Promise<Set<string> | null> {
  const d = await describeOf(api, sobject);
  return d ? new Set(d.fields.map(f => f.name)) : null;
}
/** Keep the columns the org has. "Rel.Field" is kept when the lookup field (RelId / Rel__c) exists. */
export function pick(have: Set<string> | null, cols: string[]): string[] {
  return cols.filter(c => {
    if (c === "Id") return true;
    if (!have) return false;
    if (!c.includes(".")) return have.has(c);
    const r = c.split(".")[0];
    return have.has(`${r}Id`) || have.has(r.replace(/__r$/, "__c"));
  });
}

/* ───────────────────────── capabilities ───────────────────────── */

export interface ActionInfo { available: boolean; inputs: string[] }
export interface LifecycleCapabilities {
  apiVersion: string;
  actions: Record<LifecycleKind, ActionInfo> & { createOrderFromQuote: ActionInfo };
  lifecycleAssets: boolean; quoteActions: boolean; orderActions: boolean; assetActions: boolean; statePeriods: boolean; contractRelationships: boolean; asyncTracker: boolean; billingGroups: boolean; assetAttributes: boolean;
  /** Object permissions of THIS user, from Describe. */
  permissions: { object: string; access: string; ok: boolean }[];
  features: { rampedRenewal: boolean; startDateAdjustment: boolean; lineDiscount: boolean; attributeChanges: boolean; upgrade: boolean; downgrade: boolean; swap: boolean };
  /** Writable fields that look like a cancellation reason (custom or standard) — none = the reason is kept in the app's audit only. */
  reasonFields: ReasonField[];
  /** Missing pieces per lifecycle (empty = ready). */
  missing: Record<LifecycleKind, string[]> & { assets: string[] };
}

async function actionInfo(api: RampApi, name: string): Promise<ActionInfo> {
  const r = await api.call("GET", `/actions/standard/${name}`).catch(() => null);
  if (!r || r.status >= 300 || !r.body || typeof r.body !== "object" || Array.isArray(r.body)) return { available: false, inputs: [] };
  return { available: true, inputs: (((r.body as { inputs?: { name: string }[] }).inputs) ?? []).map(i => i.name) };
}

/** A POST-only Connect resource exists when GET answers 405 METHOD_NOT_ALLOWED (a missing one answers 404 NOT_FOUND). Read-only. */
async function postResourceExists(api: RampApi, path: string): Promise<boolean> {
  const r = await api.call("GET", path).catch(() => null);
  if (!r) return false;
  return r.status === 405 || JSON.stringify(r.body ?? "").includes("METHOD_NOT_ALLOWED");
}

const REQUIRED_INPUTS: Record<LifecycleKind, string[]> = {
  amend: ["amendAssetIds", "amendStartDate", "quantityChange", "amendOutputType"],
  renew: ["renewAssetIds", "renewOutputType"],
  cancel: ["cancelAssetIds", "cancelStartDate", "cancelOutputType"],
};

export async function discoverReasonFields(api: RampApi): Promise<ReasonField[]> {
  const out: ReasonField[] = [];
  for (const object of ["Quote", "QuoteLineItem", "QuoteAction"] as const) {
    const d = await describeOf(api, object);
    for (const f of d?.fields ?? []) {
      const text = `${f.name} ${f.label ?? ""}`;
      if (!/reason/i.test(text) || !f.updateable) continue;
      if (!["picklist", "string", "textarea"].includes(f.type ?? "")) continue;
      if (!/cancel|terminat|churn|reason/i.test(text)) continue;
      out.push({ object, field: f.name, label: f.label ?? f.name, type: f.type ?? "string", options: (f.picklistValues ?? []).filter(p => p.active !== false).map(p => p.value) });
    }
  }
  return out;
}

export async function lifecycleCapabilities(api: RampApi): Promise<LifecycleCapabilities> {
  const [amend, renew, cancel, cofq, upgrade, downgrade, swap] = await Promise.all([actionInfo(api, INITIATE_ACTION.amend), actionInfo(api, INITIATE_ACTION.renew), actionInfo(api, INITIATE_ACTION.cancel), actionInfo(api, "createOrderFromQuote"),
    ...(["upgrade", "downgrade", "swap"] as const).map(k => postResourceExists(api, swapPath(k)))]);
  const [asset, qli, oi, aa, asp, acr, aot, bsg, attr, quoteD, qliD, qaD, orderD, qliaD] = await Promise.all([
    fieldsOf(api, "Asset"), fieldsOf(api, "QuoteLineItem"), fieldsOf(api, "OrderItem"), fieldsOf(api, "AssetAction"), fieldsOf(api, "AssetStatePeriod"), fieldsOf(api, "AssetContractRelationship"),
    fieldsOf(api, "AsyncOperationTracker"), fieldsOf(api, "BillingScheduleGroup"), fieldsOf(api, "AssetAttribute"),
    describeOf(api, "Quote"), describeOf(api, "QuoteLineItem"), describeOf(api, "QuoteAction"), describeOf(api, "Order"), describeOf(api, "QuoteLineItemAttribute"),
  ]);
  const actions = {
    amend: { ...amend, available: amend.available && REQUIRED_INPUTS.amend.every(i => amend.inputs.includes(i)) },
    renew: { ...renew, available: renew.available && REQUIRED_INPUTS.renew.every(i => renew.inputs.includes(i)) },
    cancel: { ...cancel, available: cancel.available && REQUIRED_INPUTS.cancel.every(i => cancel.inputs.includes(i)) },
    createOrderFromQuote: { ...cofq, available: cofq.available && cofq.inputs.includes("quoteRecordId") },
  };
  const upd = (d: DescribeInfo | null, f: string) => !!d?.fields.find(x => x.name === f)?.updateable;
  const permissions = [
    { object: "Asset", access: "read", ok: !!asset },
    { object: "AssetAction", access: "read", ok: !!aa },
    { object: "Quote", access: "edit", ok: !!quoteD && quoteD.updateable !== false },
    { object: "QuoteLineItem", access: "create / edit", ok: !!qliD && qliD.updateable !== false && qliD.createable !== false },
    { object: "QuoteAction", access: "edit", ok: !!qaD && qaD.updateable !== false },
    { object: "Order", access: "edit (activation)", ok: !!orderD && orderD.updateable !== false },
  ];
  const caps: LifecycleCapabilities = {
    apiVersion: api.apiVersion, actions,
    lifecycleAssets: !!asset?.has("HasLifecycleManagement") && !!asset?.has("CurrentQuantity"),
    quoteActions: !!qli?.has("QuoteActionId"), orderActions: !!oi?.has("OrderActionId"), assetActions: !!aa, statePeriods: !!asp, contractRelationships: !!acr, asyncTracker: !!aot, billingGroups: !!bsg, assetAttributes: !!attr,
    permissions,
    features: {
      rampedRenewal: renew.inputs.includes("rampOptionsDetails"),
      startDateAdjustment: amend.inputs.includes("actionSubtype"),
      lineDiscount: upd(qliD, "Discount"),
      attributeChanges: !!attr && !!qliaD && upd(qliaD, "AttributeValue"),
      upgrade, downgrade, swap,
    },
    reasonFields: await discoverReasonFields(api),
    missing: { amend: [], renew: [], cancel: [], assets: [] },
  };
  if (!caps.lifecycleAssets) caps.missing.assets.push("Asset has no lifecycle fields (HasLifecycleManagement / CurrentQuantity) — Revenue Cloud asset lifecycle isn't enabled for this org or user.");
  if (!caps.assetActions) caps.missing.assets.push("AssetAction isn't readable — asset lifecycle history can't be shown or verified.");
  for (const k of LIFECYCLE_KINDS) {
    if (!actions[k].available) caps.missing[k].push(`The standard action ${INITIATE_ACTION[k]} isn't available to this user / org${actions[k].inputs.length ? ` (missing inputs: ${REQUIRED_INPUTS[k].filter(i => !actions[k].inputs.includes(i)).join(", ")})` : ""}.`);
    if (!actions.createOrderFromQuote.available) caps.missing[k].push("The standard action createOrderFromQuote isn't available — orders can't be created from lifecycle quotes.");
    if (!caps.quoteActions) caps.missing[k].push("QuoteLineItem.QuoteActionId isn't readable — lifecycle quote lines can't be matched to their assets.");
    caps.missing[k].push(...caps.missing.assets);
    for (const p of permissions) if (!p.ok) caps.missing[k].push(`Your user lacks ${p.access} access to ${p.object}.`);
  }
  return caps;
}

/* ───────────────────────── asset facts ───────────────────────── */

const ASSET_COLS = ["Id", "Name", "AccountId", "Account.Name", "Product2Id", "Product2.Name", "ProductCode", "HasLifecycleManagement", "CurrentQuantity", "Quantity", "CurrentMrr", "CurrentAmount", "TotalLifecycleAmount", "LifecycleStartDate", "LifecycleEndDate", "CurrentLifecycleEndDate", "Status", "ParentId", "RootAssetId", "Price", "RenewalTerm", "RenewalTermUnit", "DoesAutomaticallyRenew", "PricingSource", "UnitPriceUplift", "CreatedDate"];

interface ActionSummary { count: number; firstOrderItemId: string | null; sellingModelId: string | null; pricebookEntryId: string | null; netUnitPrice: number | null; discount: number | null; startDate: string | null; endDate: string | null; last: AssetFacts["lastAction"] }

async function actionSummaries(api: RampApi, assetIds: string[]): Promise<Map<string, ActionSummary>> {
  const [aa, src] = await Promise.all([fieldsOf(api, "AssetAction"), fieldsOf(api, "AssetActionSource")]);
  const out = new Map<string, ActionSummary>();
  if (!aa || !assetIds.length) return out;
  const order = aa.has("ActionDate") ? "ActionDate" : "CreatedDate";
  const cols = pick(aa, ["Id", "AssetId", "Type", "CategoryEnum", "Subtype", "ActionDate", "CreatedDate"]);
  const actions = await api.query<Row>(`SELECT ${cols.join(", ")} FROM AssetAction WHERE AssetId IN (${ids(assetIds)}) ORDER BY ${order}, CreatedDate LIMIT 2000`);
  for (const a of actions) {
    const k = String(a.AssetId);
    const cur = out.get(k);
    out.set(k, { ...(cur ?? { firstOrderItemId: null, sellingModelId: null, pricebookEntryId: null, netUnitPrice: null, discount: null, startDate: null, endDate: null }), count: (cur?.count ?? 0) + 1, last: { type: s(a.Type), category: s(a.CategoryEnum), subtype: s(a.Subtype), date: s(a.ActionDate) ?? s(a.CreatedDate) } });
  }
  if (!src || !actions.length) return out;
  const scols = pick(src, ["Id", "AssetActionId", "ReferenceEntityItemId", "ProductSellingModelId", "PricebookEntryId", "NetUnitPrice", "UnitPrice", "Discount", "StartDate", "EndDate"]);
  const sources = await api.query<Row>(`SELECT ${scols.join(", ")} FROM AssetActionSource WHERE AssetActionId IN (${ids(actions.map(a => String(a.Id)))}) LIMIT 2000`);
  const assetOf = new Map(actions.map(a => [String(a.Id), String(a.AssetId)]));
  const pos = new Map(actions.map((a, i) => [String(a.Id), i]));
  sources.sort((x, y) => (pos.get(String(x.AssetActionId)) ?? 0) - (pos.get(String(y.AssetActionId)) ?? 0));
  for (const r of sources) {
    const k = assetOf.get(String(r.AssetActionId));
    if (!k) continue;
    const cur = out.get(k)!;
    // First source = the originating order line; the LATEST source carries the current selling model / price / dates.
    out.set(k, { ...cur, firstOrderItemId: cur.firstOrderItemId ?? s(r.ReferenceEntityItemId), sellingModelId: s(r.ProductSellingModelId) ?? cur.sellingModelId, pricebookEntryId: s(r.PricebookEntryId) ?? cur.pricebookEntryId, netUnitPrice: n(r.NetUnitPrice) ?? n(r.UnitPrice) ?? cur.netUnitPrice, discount: n(r.Discount) ?? cur.discount, startDate: s(r.StartDate) ?? cur.startDate, endDate: s(r.EndDate) ?? cur.endDate });
  }
  return out;
}

interface PeriodSummary { unitPrice: number | null; discount: number | null; billingFrequency: string | null; startDate: string | null; endDate: string | null; pricingContractId: string | null }
async function currentPeriods(api: RampApi, assetIds: string[], today: string): Promise<Map<string, PeriodSummary>> {
  const have = await fieldsOf(api, "AssetStatePeriod");
  const out = new Map<string, PeriodSummary>();
  if (!have || !assetIds.length) return out;
  const cols = pick(have, ["Id", "AssetId", "StartDate", "EndDate", "Quantity", "UnitPrice", "Discount", "BillingFrequency", "PricingContractId"]);
  const rows = await api.query<Row>(`SELECT ${cols.join(", ")} FROM AssetStatePeriod WHERE AssetId IN (${ids(assetIds)}) ORDER BY StartDate DESC LIMIT 2000`);
  const settled = new Set<string>();
  for (const r of rows) {
    const k = String(r.AssetId);
    if (settled.has(k)) continue;
    const start = day(s(r.StartDate)), end = day(s(r.EndDate));
    const current = (!start || start <= today) && (!end || end >= today);
    // Rows are newest first: the newest period covering today wins; otherwise the newest period overall.
    if (!out.has(k) || current) out.set(k, { unitPrice: n(r.UnitPrice), discount: n(r.Discount), billingFrequency: s(r.BillingFrequency), startDate: start, endDate: end, pricingContractId: s(r.PricingContractId) });
    if (current) settled.add(k);
  }
  return out;
}

async function originOrders(api: RampApi, orderItemIds: string[]) {
  const out = new Map<string, { id: string; number: string | null; contractId: string | null }>();
  if (!orderItemIds.length) return out;
  const have = await fieldsOf(api, "Order");
  const rows = await api.query<Row>(`SELECT Id, OrderId, Order.OrderNumber${have?.has("ContractId") ? ", Order.ContractId" : ""} FROM OrderItem WHERE Id IN (${ids(orderItemIds)})`);
  for (const r of rows) out.set(String(r.Id), { id: String(r.OrderId), number: s(rel(r, "Order.OrderNumber")), contractId: s(rel(r, "Order.ContractId")) });
  return out;
}

/** Usage-based products: Product2.UsageModelType set, or usage resources defined for the product (whichever the org has). */
export async function usageFlags(api: RampApi, productIds: string[]): Promise<Map<string, { usageBased: boolean; reason: string | null }>> {
  const out = new Map<string, { usageBased: boolean; reason: string | null }>();
  const list = uniq(productIds);
  if (!list.length) return out;
  const p2 = await fieldsOf(api, "Product2");
  if (p2?.has("UsageModelType")) {
    for (const r of await api.query<Row>(`SELECT Id, UsageModelType FROM Product2 WHERE Id IN (${ids(list)})`)) if (s(r.UsageModelType)) out.set(String(r.Id), { usageBased: true, reason: `UsageModelType ${r.UsageModelType}` });
  }
  const pur = await fieldsOf(api, "ProductUsageResource");
  const key = pur ? ["ProductId", "Product2Id"].find(f => pur.has(f)) : null;
  if (key) {
    for (const r of await api.query<Row>(`SELECT ${key} FROM ProductUsageResource WHERE ${key} IN (${ids(list)})`).catch(() => [])) {
      const k = String(r[key]);
      if (!out.has(k)) out.set(k, { usageBased: true, reason: "has Product Usage Resources" });
    }
  }
  return out;
}

/** Lifecycle quotes referencing these assets (QuoteAction with SourceAssetId — Amend, No Change, Renew, Cancel, Transfer …) that are
 * still in flight: no order yet, or an order that isn't ACTIVATED (a Draft amendment order still holds the asset — observed live in p13
 * 2026-11-11: orders 00000123 / 00000124 stayed Draft after activation was refused for billing readiness). Any line type counts. */
export async function openTransactions(api: RampApi, assetIds: string[]): Promise<Map<string, OpenTransaction[]>> {
  const out = new Map<string, OpenTransaction[]>();
  const qa = await fieldsOf(api, "QuoteAction");
  if (!qa?.has("SourceAssetId") || !assetIds.length) return out;
  const rows = await api.query<Row>(`SELECT SourceAssetId, Type, QuoteId, Quote.QuoteNumber, Quote.Status, Quote.OriginalActionType FROM QuoteAction WHERE SourceAssetId IN (${ids(assetIds)}) LIMIT 1000`);
  if (!rows.length) return out;
  const orders = await api.query<Row>(`SELECT QuoteId, OrderNumber, Status FROM Order WHERE QuoteId IN (${ids(rows.map(r => String(r.QuoteId)))})`);
  const activated = new Set(orders.filter(o => /^activated$/i.test(s(o.Status) ?? "")).map(o => String(o.QuoteId)));
  for (const r of rows) {
    const quoteStatus = s(rel(r, "Quote.Status"));
    if (activated.has(String(r.QuoteId)) || /denied|rejected|cancel/i.test(quoteStatus ?? "")) continue;
    const pending = orders.find(o => String(o.QuoteId) === String(r.QuoteId));
    const status = pending ? `order ${s(pending.OrderNumber) ?? ""} ${s(pending.Status) ?? "not activated"}, not activated`.replace(/\s+/g, " ") : quoteStatus;
    const k = String(r.SourceAssetId);
    const list = out.get(k) ?? [];
    if (!list.some(x => x.quoteId === String(r.QuoteId))) list.push({ quoteId: String(r.QuoteId), quoteNumber: s(rel(r, "Quote.QuoteNumber")), status, type: s(rel(r, "Quote.OriginalActionType")) ?? s(r.Type) });
    out.set(k, list);
  }
  return out;
}

async function contractLinks(api: RampApi, assetIds: string[], fromOrders: Map<string, string | null>, fromPeriods: Map<string, string | null>): Promise<Map<string, AssetContractLink[]>> {
  const out = new Map<string, AssetContractLink[]>();
  const acr = await fieldsOf(api, "AssetContractRelationship");
  const raw: { assetId: string; contractId: string; source: AssetContractLink["source"]; start: string | null; end: string | null }[] = [];
  if (acr && assetIds.length) {
    const cols = pick(acr, ["Id", "AssetId", "ContractId", "StartDate", "EndDate"]);
    for (const r of await api.query<Row>(`SELECT ${cols.join(", ")} FROM AssetContractRelationship WHERE AssetId IN (${ids(assetIds)}) LIMIT 2000`)) raw.push({ assetId: String(r.AssetId), contractId: String(r.ContractId), source: "relationship", start: day(s(r.StartDate)), end: day(s(r.EndDate)) });
  }
  for (const [a, c] of fromOrders) if (c) raw.push({ assetId: a, contractId: c, source: "order", start: null, end: null });
  for (const [a, c] of fromPeriods) if (c) raw.push({ assetId: a, contractId: c, source: "pricing", start: null, end: null });
  if (!raw.length) return out;
  const ch = await fieldsOf(api, "Contract");
  const ccols = pick(ch, ["Id", "ContractNumber", "Status", "StartDate", "EndDate"]);
  const contracts = new Map((await api.query<Row>(`SELECT ${ccols.join(", ")} FROM Contract WHERE Id IN (${ids(raw.map(r => r.contractId))})`).catch(() => [])).map(r => [String(r.Id), r]));
  for (const r of raw) {
    const c = contracts.get(r.contractId);
    const list = out.get(r.assetId) ?? [];
    if (list.some(x => x.id === r.contractId)) continue;
    list.push({ id: r.contractId, number: s(c?.ContractNumber), status: s(c?.Status), startDate: r.start ?? day(s(c?.StartDate)), endDate: r.end ?? day(s(c?.EndDate)), source: r.source });
    out.set(r.assetId, list);
  }
  return out;
}

/** Bundle parent / components from AssetRelationship (AssetRole Bundle → RelatedAssetRole BundleComponent), where the org has it. */
async function bundleRelationships(api: RampApi, assetIds: string[]): Promise<{ parentOf: Map<string, string>; childrenOf: Map<string, string[]> }> {
  const out = { parentOf: new Map<string, string>(), childrenOf: new Map<string, string[]>() };
  const have = await fieldsOf(api, "AssetRelationship");
  if (!have?.has("RelatedAssetRole") || !assetIds.length) return out;
  const list = ids(assetIds);
  const rows = await api.query<Row>(`SELECT AssetId, RelatedAssetId, RelatedAssetRole FROM AssetRelationship WHERE RelatedAssetRole = 'BundleComponent' AND (AssetId IN (${list}) OR RelatedAssetId IN (${list})) LIMIT 2000`).catch(() => [] as Row[]);
  for (const r of rows) {
    const parent = s(r.AssetId), child = s(r.RelatedAssetId);
    if (!parent || !child) continue;
    out.parentOf.set(child, parent);
    out.childrenOf.set(parent, uniq([...(out.childrenOf.get(parent) ?? []), child]));
  }
  return out;
}

/** Replacement history (AssetRelationship Upgrade / Replacement / Crossgrade) of these assets — swapped-from ↔ swapped-to. */
export async function replacementRelationships(api: RampApi, assetIds: string[]) {
  const have = await fieldsOf(api, "AssetRelationship");
  if (!have?.has("RelationshipType") || !assetIds.length) return [];
  const list = ids(assetIds);
  const rows = await api.query<Row>(`SELECT Id, AssetId, Asset.Name, RelatedAssetId, RelatedAsset.Name, RelationshipType, FromDate, ToDate, CreatedDate FROM AssetRelationship WHERE RelationshipType != null AND (AssetId IN (${list}) OR RelatedAssetId IN (${list})) LIMIT 500`).catch(() => [] as Row[]);
  return rows.map(r => ({ id: String(r.Id), assetId: s(r.AssetId), assetName: s(rel(r, "Asset.Name")), relatedAssetId: s(r.RelatedAssetId), relatedAssetName: s(rel(r, "RelatedAsset.Name")), type: s(r.RelationshipType), fromDate: day(s(r.FromDate)), toDate: day(s(r.ToDate)), createdDate: s(r.CreatedDate) }));
}

/** Turn Asset rows into full lifecycle facts (actions, current period, origin order, contracts, usage, open transactions). */
export async function enrichAssets(api: RampApi, assets: Row[], today: string): Promise<AssetFacts[]> {
  if (!assets.length) return [];
  const assetIds = assets.map(a => String(a.Id));
  const [actions, periods, usage, open, children, bundles] = await Promise.all([
    actionSummaries(api, assetIds), currentPeriods(api, assetIds, today), usageFlags(api, assets.map(a => s(a.Product2Id)).filter((x): x is string => !!x)), openTransactions(api, assetIds),
    api.query<Row>(`SELECT Id, ParentId FROM Asset WHERE ParentId IN (${ids(assetIds)}) LIMIT 2000`).catch(() => [] as Row[]),
    bundleRelationships(api, assetIds),
  ]);
  const origins = await originOrders(api, uniq([...actions.values()].map(a => a.firstOrderItemId)));
  const models = await sellingModelDetails(api, uniq([...actions.values()].map(a => a.sellingModelId))).catch(() => new Map());
  const pbeIds = uniq([...actions.values()].map(a => a.pricebookEntryId));
  const books = new Map((pbeIds.length ? await api.query<Row>(`SELECT Id, Pricebook2Id FROM PricebookEntry WHERE Id IN (${ids(pbeIds)})`).catch(() => []) : []).map(r => [String(r.Id), s(r.Pricebook2Id)]));
  const orderContract = new Map(assetIds.map(id => { const o = actions.get(id)?.firstOrderItemId; return [id, o ? origins.get(o)?.contractId ?? null : null]; }));
  const periodContract = new Map(assetIds.map(id => [id, periods.get(id)?.pricingContractId ?? null]));
  const links = await contractLinks(api, assetIds, orderContract, periodContract);

  return assets.map(a => {
    const id = String(a.Id);
    const act = actions.get(id);
    const per = periods.get(id) ?? null;
    const sm = act?.sellingModelId ? models.get(act.sellingModelId) ?? null : null;
    const productId = s(a.Product2Id);
    return {
      id, name: s(a.Name) ?? id, accountId: s(a.AccountId), accountName: s(rel(a, "Account.Name")),
      productId, productName: s(rel(a, "Product2.Name")), productCode: s(a.ProductCode),
      hasLifecycle: a.HasLifecycleManagement === true, lifecycleActions: act?.count ?? 0, lastAction: act?.last ?? null,
      quantity: n(a.CurrentQuantity) ?? n(a.Quantity), mrr: n(a.CurrentMrr), currentAmount: n(a.CurrentAmount), totalAmount: n(a.TotalLifecycleAmount),
      lifecycleStart: s(a.LifecycleStartDate), lifecycleEnd: s(a.CurrentLifecycleEndDate) ?? s(a.LifecycleEndDate), status: s(a.Status),
      // Bundle structure: Asset.ParentId, or an AssetRelationship with RelatedAssetRole BundleComponent (Revenue Cloud bundles).
      parentId: s(a.ParentId) ?? bundles.parentOf.get(id) ?? null, rootId: s(a.RootAssetId) ?? bundles.parentOf.get(id) ?? null,
      childIds: uniq([...assets.filter(c => c.ParentId === id).map(c => String(c.Id)), ...children.filter(c => c.ParentId === id).map(c => String(c.Id)), ...(bundles.childrenOf.get(id) ?? [])]),
      sellingModel: act?.sellingModelId ? { id: act.sellingModelId, name: sm?.name ?? null, type: sm?.type ?? null, pricingTerm: sm?.pricingTerm ?? null, pricingTermUnit: sm?.pricingTermUnit ?? null } : null,
      unitPrice: per?.unitPrice ?? act?.netUnitPrice ?? n(a.Price), discount: per?.discount ?? act?.discount ?? null, billingFrequency: per?.billingFrequency ?? null,
      startDate: per?.startDate ?? day(act?.startDate) ?? null, endDate: per?.endDate ?? day(act?.endDate) ?? null,
      pricebookEntryId: act?.pricebookEntryId ?? null, pricebookId: act?.pricebookEntryId ? books.get(act.pricebookEntryId) ?? null : null,
      originOrder: act?.firstOrderItemId ? origins.get(act.firstOrderItemId) ?? null : null,
      contracts: links.get(id) ?? [],
      usage: productId ? usage.get(productId) ?? { usageBased: false, reason: null } : { usageBased: false, reason: null },
      renewal: { term: n(a.RenewalTerm), termUnit: s(a.RenewalTermUnit), autoRenew: b(a.DoesAutomaticallyRenew), pricingSource: s(a.PricingSource), uplift: n(a.UnitPriceUplift) },
      open: open.get(id) ?? [],
    };
  });
}

export function toRow(f: AssetFacts, today: string, ctx: { accountId?: string | null; contractId?: string | null; effectiveDate?: string | null } = {}): AssetRow {
  const ec = { accountId: ctx.accountId ?? null, contractId: ctx.contractId ?? null, effectiveDate: ctx.effectiveDate ?? null, today };
  return { ...f, state: assetState(f, today), eligibility: { amend: assetEligibility(f, "amend", ec), renew: assetEligibility(f, "renew", ec), cancel: assetEligibility(f, "cancel", ec) } };
}

/** Facts for specific assets (validation before a write). */
export async function assetFactsByIds(api: RampApi, assetIds: string[], today: string): Promise<Map<string, AssetFacts>> {
  if (!assetIds.length) return new Map();
  const have = await fieldsOf(api, "Asset");
  if (!have) throw new Error("Asset isn't readable for this user.");
  const rows = await api.query<Row>(`SELECT ${pick(have, ASSET_COLS).join(", ")} FROM Asset WHERE Id IN (${ids(assetIds)})`);
  return new Map((await enrichAssets(api, rows, today)).map(a => [a.id, a]));
}

/* ───────────────────────── asset list (search / filter / sort / page) ───────────────────────── */

export interface AssetFilter {
  ids?: string[] | null; accountId?: string | null; contractId?: string | null; productId?: string | null; q?: string | null;
  state?: AssetState | "all" | null; lifecycleOnly?: boolean; expiresFrom?: string | null; expiresTo?: string | null;
  sort?: string | null; dir?: "asc" | "desc" | null; page?: number; pageSize?: number;
}
export interface AssetPage { rows: AssetRow[]; total: number; page: number; pageSize: number; hasMore: boolean; soql: string }

const SORTS: Record<string, string> = { name: "Name", product: "Product2.Name", account: "Account.Name", quantity: "CurrentQuantity", start: "LifecycleStartDate", end: "LifecycleEndDate", created: "CreatedDate" };
const like = (v: string) => `'%${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/%/g, "\\%").replace(/_/g, "\\_")}%'`;

/** Assets related to a contract: Asset Contract Relationship, origin order on the contract, or the contract as pricing contract. */
export async function contractAssetIds(api: RampApi, contractId: string): Promise<string[]> {
  const out = new Set<string>();
  if (await fieldsOf(api, "AssetContractRelationship")) for (const r of await api.query<Row>(`SELECT AssetId FROM AssetContractRelationship WHERE ContractId = ${soql(contractId)} LIMIT 2000`)) out.add(String(r.AssetId));
  const order = await fieldsOf(api, "Order");
  if (order?.has("ContractId")) {
    const items = await api.query<Row>(`SELECT Id FROM OrderItem WHERE Order.ContractId = ${soql(contractId)} LIMIT 2000`).catch(() => [] as Row[]);
    if (items.length && (await fieldsOf(api, "AssetActionSource"))) {
      for (const r of await api.query<Row>(`SELECT AssetAction.AssetId FROM AssetActionSource WHERE ReferenceEntityItemId IN (${ids(items.map(i => String(i.Id)))}) LIMIT 2000`)) { const a = s(rel(r, "AssetAction.AssetId")); if (a) out.add(a); }
    }
  }
  if ((await fieldsOf(api, "AssetStatePeriod"))?.has("PricingContractId")) for (const r of await api.query<Row>(`SELECT AssetId FROM AssetStatePeriod WHERE PricingContractId = ${soql(contractId)} LIMIT 2000`)) out.add(String(r.AssetId));
  return [...out];
}

export async function listAssets(api: RampApi, f: AssetFilter, today: string): Promise<AssetPage> {
  const have = await fieldsOf(api, "Asset");
  if (!have) throw new Error("Asset isn't readable for this user.");
  const pageSize = Math.min(Math.max(Math.trunc(f.pageSize ?? 25), 1), 100);
  const page = Math.min(Math.max(Math.trunc(f.page ?? 1), 1), Math.floor(2000 / pageSize) + 1);
  const where: string[] = [];
  const lc = have.has("HasLifecycleManagement");
  const end = have.has("LifecycleEndDate") ? "LifecycleEndDate" : null;
  const qty = have.has("CurrentQuantity") ? "CurrentQuantity" : "Quantity";
  if (f.ids?.length) where.push(`Id IN (${ids(f.ids.slice(0, 200))})`);
  if (f.accountId) where.push(`AccountId = ${soql(f.accountId)}`);
  if (f.productId) where.push(`Product2Id = ${soql(f.productId)}`);
  if (f.contractId) {
    const scoped = await contractAssetIds(api, f.contractId);
    if (!scoped.length) return { rows: [], total: 0, page, pageSize, hasMore: false, soql: `-- no assets are related to contract ${f.contractId}` };
    where.push(`Id IN (${ids(scoped)})`);
  }
  const q = (f.q ?? "").trim().slice(0, 80);
  if (q) where.push(`(${["Name", "Product2.Name", "Account.Name", ...(have.has("ProductCode") ? ["ProductCode"] : []), ...(have.has("SerialNumber") ? ["SerialNumber"] : [])].map(c => `${c} LIKE ${like(q)}`).join(" OR ")})`);
  if (lc && (f.lifecycleOnly ?? true) && f.state !== "unmanaged") where.push("HasLifecycleManagement = true");
  const st = f.state && f.state !== "all" ? f.state : null;
  if (st === "unmanaged" && lc) where.push("HasLifecycleManagement = false");
  if (st === "cancelled") where.push(`${qty} <= 0${end ? ` AND (${end} = null OR ${end} >= TODAY)` : ""}`);
  if (st === "active") where.push(`${qty} > 0${end ? ` AND (${end} = null OR ${end} >= TODAY)` : ""}`);
  if (end && st === "expiring") where.push(`${end} >= TODAY AND ${end} <= NEXT_N_DAYS:${EXPIRING_DAYS}`);
  if (end && st === "expired") where.push(`${end} < TODAY`);
  if (st === "future" && have.has("LifecycleStartDate")) where.push("LifecycleStartDate > TODAY");
  if (end && f.expiresFrom && /^\d{4}-\d{2}-\d{2}$/.test(f.expiresFrom)) where.push(`${end} >= ${f.expiresFrom}T00:00:00Z`);
  if (end && f.expiresTo && /^\d{4}-\d{2}-\d{2}$/.test(f.expiresTo)) where.push(`${end} <= ${f.expiresTo}T23:59:59Z`);
  const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const sortCol = SORTS[f.sort ?? ""] ?? "Name";
  const dir = f.dir === "desc" ? "DESC" : "ASC";
  const sql = `SELECT ${pick(have, ASSET_COLS).join(", ")} FROM Asset${w} ORDER BY ${pick(have, [sortCol])[0] ?? "Name"} ${dir} NULLS LAST, Id ASC LIMIT ${pageSize + 1} OFFSET ${(page - 1) * pageSize}`;
  const [rows, count] = await Promise.all([api.query<Row>(sql), api.query<Row>(`SELECT COUNT(Id) total FROM Asset${w}`).catch(() => [] as Row[])]);
  const facts = await enrichAssets(api, rows.slice(0, pageSize), today);
  const total = n(count[0]?.total) ?? n(count[0]?.expr0) ?? (page - 1) * pageSize + rows.length;
  return { rows: facts.map(x => toRow(x, today, { accountId: f.accountId, contractId: f.contractId })), total, page, pageSize, hasMore: rows.length > pageSize, soql: sql };
}

/* ───────────────────────── asset detail ───────────────────────── */

export interface AssetDetail {
  asset: AssetRow;
  actions: { id: string; number: string | null; type: string | null; category: string | null; subtype: string | null; date: string | null; quantityChange: number | null; mrrChange: number | null; amount: number | null; sources: { id: string; orderItemId: string | null; orderId: string | null; orderNumber: string | null; quantity: number | null; unitPrice: number | null; netUnitPrice: number | null; startDate: string | null; endDate: string | null; totalLineAmount: number | null }[] }[];
  statePeriods: { id: string; number: string | null; startDate: string | null; endDate: string | null; quantity: number | null; unitPrice: number | null; discount: number | null; mrr: number | null; amount: number | null; billingFrequency: string | null; segment: string | null }[];
  attributes: AssetAttributeValue[];
  billing: { groupId: string; number: string | null; startDate: string | null; endDate: string | null; cancellationDate: string | null; billed: number | null; pending: number | null; nextBillingDate: string | null; schedules: number }[];
  transactions: { source: "Quote" | "Order"; id: string; number: string | null; status: string | null; type: string | null; subtype: string | null; createdDate: string | null; orderId: string | null; orderNumber: string | null }[];
  children: { id: string; name: string; quantity: number | null }[];
  /** Upgrade / Replacement / Crossgrade links (AssetRelationship) — where this asset was swapped from or to. */
  relationships: Awaited<ReturnType<typeof replacementRelationships>>;
}

export async function assetAttributes(api: RampApi, assetIds: string[]): Promise<Map<string, AssetAttributeValue[]>> {
  const out = new Map<string, AssetAttributeValue[]>();
  const have = await fieldsOf(api, "AssetAttribute");
  if (!have || !assetIds.length) return out;
  const cols = pick(have, ["Id", "AssetId", "AttributeDefinitionId", "AttributeName", "AttributeValue", "AttributePicklistValueId"]);
  for (const r of await api.query<Row>(`SELECT ${cols.join(", ")} FROM AssetAttribute WHERE AssetId IN (${ids(assetIds)}) LIMIT 2000`).catch(() => [] as Row[])) {
    const list = out.get(String(r.AssetId)) ?? [];
    list.push({ id: String(r.Id), definitionId: s(r.AttributeDefinitionId), name: s(r.AttributeName), value: s(r.AttributeValue), picklistValueId: s(r.AttributePicklistValueId) });
    out.set(String(r.AssetId), list);
  }
  return out;
}

/** Revenue Cloud Billing for assets: BillingScheduleGroup.ReferenceEntityId = Asset (absent = not billed through Revenue Cloud Billing). */
export async function assetBilling(api: RampApi, assetIds: string[]): Promise<Map<string, AssetDetail["billing"]>> {
  const out = new Map<string, AssetDetail["billing"]>();
  const have = await fieldsOf(api, "BillingScheduleGroup");
  if (!have?.has("ReferenceEntityId") || !assetIds.length) return out;
  const cols = pick(have, ["Id", "BillingScheduleGroupNumber", "ReferenceEntityId", "StartDate", "EndDate", "CancellationDate", "TotalBilledAmount", "TotalPendingAmount", "EffectiveNextBillingDate"]);
  const groups = await api.query<Row>(`SELECT ${cols.join(", ")} FROM BillingScheduleGroup WHERE ReferenceEntityId IN (${ids(assetIds)}) LIMIT 500`).catch(() => [] as Row[]);
  const bs = await fieldsOf(api, "BillingSchedule");
  const counts = new Map<string, number>();
  if (groups.length && bs?.has("BillingScheduleGroupId")) for (const r of await api.query<Row>(`SELECT BillingScheduleGroupId FROM BillingSchedule WHERE BillingScheduleGroupId IN (${ids(groups.map(g => String(g.Id)))}) LIMIT 2000`).catch(() => [] as Row[])) counts.set(String(r.BillingScheduleGroupId), (counts.get(String(r.BillingScheduleGroupId)) ?? 0) + 1);
  for (const g of groups) {
    const list = out.get(String(g.ReferenceEntityId)) ?? [];
    list.push({ groupId: String(g.Id), number: s(g.BillingScheduleGroupNumber), startDate: day(s(g.StartDate)), endDate: day(s(g.EndDate)), cancellationDate: day(s(g.CancellationDate)), billed: n(g.TotalBilledAmount), pending: n(g.TotalPendingAmount), nextBillingDate: day(s(g.EffectiveNextBillingDate)), schedules: counts.get(String(g.Id)) ?? 0 });
    out.set(String(g.ReferenceEntityId), list);
  }
  return out;
}

export async function assetDetail(api: RampApi, assetId: string, today: string): Promise<AssetDetail | null> {
  const facts = await assetFactsByIds(api, [assetId], today);
  const f = facts.get(assetId);
  if (!f) return null;
  const [aa, src, asp, qa, oa] = await Promise.all([fieldsOf(api, "AssetAction"), fieldsOf(api, "AssetActionSource"), fieldsOf(api, "AssetStatePeriod"), fieldsOf(api, "QuoteAction"), fieldsOf(api, "OrderAction")]);
  const actions = aa ? await api.query<Row>(`SELECT ${pick(aa, ["Id", "AssetActionNumber", "Type", "CategoryEnum", "Subtype", "ActionDate", "CreatedDate", "QuantityChange", "MrrChange", "Amount"]).join(", ")} FROM AssetAction WHERE AssetId = ${soql(assetId)} ORDER BY ${aa.has("ActionDate") ? "ActionDate" : "CreatedDate"} DESC LIMIT 200`) : [];
  const sources = src && actions.length ? await api.query<Row>(`SELECT ${pick(src, ["Id", "AssetActionId", "ReferenceEntityItemId", "Quantity", "UnitPrice", "NetUnitPrice", "StartDate", "EndDate", "TotalLineAmount"]).join(", ")} FROM AssetActionSource WHERE AssetActionId IN (${ids(actions.map(a => String(a.Id)))}) LIMIT 1000`) : [];
  const items = await originOrders(api, uniq(sources.map(r => s(r.ReferenceEntityItemId))));
  const periods = asp ? await api.query<Row>(`SELECT ${pick(asp, ["Id", "AssetStatePeriodNumber", "StartDate", "EndDate", "Quantity", "UnitPrice", "Discount", "Mrr", "Amount", "BillingFrequency", "SegmentName", "SegmentType"]).join(", ")} FROM AssetStatePeriod WHERE AssetId = ${soql(assetId)} ORDER BY StartDate DESC LIMIT 200`) : [];
  const [attrs, billing, relationships] = await Promise.all([assetAttributes(api, [assetId]), assetBilling(api, [assetId]), replacementRelationships(api, [assetId])]);
  const qrows = qa?.has("SourceAssetId") ? await api.query<Row>(`SELECT Id, Type, Subtype, QuoteId, Quote.QuoteNumber, Quote.Status, CreatedDate FROM QuoteAction WHERE SourceAssetId = ${soql(assetId)} ORDER BY CreatedDate DESC LIMIT 100`).catch(() => [] as Row[]) : [];
  const qorders = qrows.length ? await api.query<Row>(`SELECT Id, OrderNumber, QuoteId FROM Order WHERE QuoteId IN (${ids(qrows.map(r => String(r.QuoteId)))})`).catch(() => [] as Row[]) : [];
  const orows = oa?.has("SourceAssetId") ? await api.query<Row>(`SELECT Id, Type, Subtype, OrderId, Order.OrderNumber, Order.Status, CreatedDate FROM OrderAction WHERE SourceAssetId = ${soql(assetId)} ORDER BY CreatedDate DESC LIMIT 100`).catch(() => [] as Row[]) : [];
  const children = f.childIds.length ? await api.query<Row>(`SELECT Id, Name, CurrentQuantity FROM Asset WHERE Id IN (${ids(f.childIds)})`).catch(() => [] as Row[]) : [];
  return {
    asset: toRow(f, today, { accountId: f.accountId }),
    actions: actions.map(a => ({
      id: String(a.Id), number: s(a.AssetActionNumber), type: s(a.Type), category: s(a.CategoryEnum), subtype: s(a.Subtype), date: s(a.ActionDate) ?? s(a.CreatedDate), quantityChange: n(a.QuantityChange), mrrChange: n(a.MrrChange), amount: n(a.Amount),
      sources: sources.filter(x => x.AssetActionId === a.Id).map(x => { const o = items.get(String(x.ReferenceEntityItemId)); return { id: String(x.Id), orderItemId: s(x.ReferenceEntityItemId), orderId: o?.id ?? null, orderNumber: o?.number ?? null, quantity: n(x.Quantity), unitPrice: n(x.UnitPrice), netUnitPrice: n(x.NetUnitPrice), startDate: day(s(x.StartDate)), endDate: day(s(x.EndDate)), totalLineAmount: n(x.TotalLineAmount) }; }),
    })),
    statePeriods: periods.map(p => ({ id: String(p.Id), number: s(p.AssetStatePeriodNumber), startDate: day(s(p.StartDate)), endDate: day(s(p.EndDate)), quantity: n(p.Quantity), unitPrice: n(p.UnitPrice), discount: n(p.Discount), mrr: n(p.Mrr), amount: n(p.Amount), billingFrequency: s(p.BillingFrequency), segment: s(p.SegmentName) ?? s(p.SegmentType) })),
    attributes: attrs.get(assetId) ?? [],
    billing: billing.get(assetId) ?? [],
    transactions: [
      ...qrows.map(r => { const o = qorders.find(x => x.QuoteId === r.QuoteId); return { source: "Quote" as const, id: String(r.QuoteId), number: s(rel(r, "Quote.QuoteNumber")), status: s(rel(r, "Quote.Status")), type: s(r.Type), subtype: s(r.Subtype), createdDate: s(r.CreatedDate), orderId: o ? String(o.Id) : null, orderNumber: s(o?.OrderNumber) }; }),
      ...orows.map(r => ({ source: "Order" as const, id: String(r.OrderId), number: s(rel(r, "Order.OrderNumber")), status: s(rel(r, "Order.Status")), type: s(r.Type), subtype: s(r.Subtype), createdDate: s(r.CreatedDate), orderId: String(r.OrderId), orderNumber: s(rel(r, "Order.OrderNumber")) })),
    ],
    children: children.map(c => ({ id: String(c.Id), name: s(c.Name) ?? String(c.Id), quantity: n(c.CurrentQuantity) })),
    relationships,
  };
}

/* ───────────────────────── contracts / stats ───────────────────────── */

export async function accountContracts(api: RampApi, accountId: string) {
  const have = await fieldsOf(api, "Contract");
  if (!have) return [];
  const cols = pick(have, ["Id", "ContractNumber", "Status", "StartDate", "EndDate", "ContractTerm"]);
  const rows = await api.query<Row>(`SELECT ${cols.join(", ")} FROM Contract WHERE AccountId = ${soql(accountId)} ORDER BY StartDate DESC NULLS LAST LIMIT 200`);
  return rows.map(r => ({ id: String(r.Id), name: `${s(r.ContractNumber) ?? r.Id}${s(r.Status) ? ` · ${r.Status}` : ""}`, contractNumber: s(r.ContractNumber), status: s(r.Status), startDate: s(r.StartDate), endDate: s(r.EndDate) }));
}

export interface AssetStats { total: number | null; lifecycle: number | null; active: number | null; expiring: number | null; expired: number | null; cancelled: number | null }
export async function assetStats(api: RampApi): Promise<AssetStats> {
  const have = await fieldsOf(api, "Asset");
  if (!have) return { total: null, lifecycle: null, active: null, expiring: null, expired: null, cancelled: null };
  const lc = have.has("HasLifecycleManagement") ? "HasLifecycleManagement = true" : null;
  const end = have.has("LifecycleEndDate") ? "LifecycleEndDate" : null;
  const qty = have.has("CurrentQuantity") ? "CurrentQuantity" : "Quantity";
  const count = async (w: string | null) => { const r = await api.query<Row>(`SELECT COUNT(Id) total FROM Asset${w ? ` WHERE ${w}` : ""}`).catch(() => [] as Row[]); return n(r[0]?.total) ?? n(r[0]?.expr0); };
  const and = (...p: (string | null)[]) => p.filter(Boolean).join(" AND ") || null;
  const [total, lifecycle, active, expiring, expired, cancelled] = await Promise.all([
    count(null), lc ? count(lc) : Promise.resolve(null),
    count(and(lc, `${qty} > 0`, end ? `(${end} = null OR ${end} >= TODAY)` : null)),
    end ? count(and(lc, `${end} >= TODAY`, `${end} <= NEXT_N_DAYS:${EXPIRING_DAYS}`)) : Promise.resolve(null),
    end ? count(and(lc, `${end} < TODAY`)) : Promise.resolve(null),
    count(and(lc, `${qty} <= 0`, end ? `(${end} = null OR ${end} >= TODAY)` : null)),
  ]);
  return { total, lifecycle, active, expiring, expired, cancelled };
}

/* ───────────────────────── lifecycle quote / order ───────────────────────── */

export interface LifecycleQuote {
  id: string; quoteNumber: string | null; name: string | null; status: string | null; calculationStatus: string | null; lastPricedDate: string | null;
  totalPrice: number | null; subtotal: number | null; tax: number | null; grandTotal: number | null;
  contractId: string | null; opportunityId: string | null; originalActionType: string | null; startDate: string | null; reasonValue: string | null; lines: QuoteLineFacts[];
}

export async function lifecycleQuote(api: RampApi, quoteId: string, reasonField?: ReasonField | null): Promise<LifecycleQuote | null> {
  const [q, l] = await Promise.all([fieldsOf(api, "Quote"), fieldsOf(api, "QuoteLineItem")]);
  const extraQ = reasonField?.object === "Quote" && q?.has(reasonField.field) ? [reasonField.field] : [];
  const qcols = pick(q, ["Id", "QuoteNumber", "Name", "Status", "CalculationStatus", "LastPricedDate", "TotalPrice", "Subtotal", "Tax", "GrandTotal", "ContractId", "OpportunityId", "OriginalActionType", "StartDate", ...extraQ]);
  const [h] = await api.query<Row>(`SELECT ${qcols.join(", ")} FROM Quote WHERE Id = ${soql(quoteId)} LIMIT 1`);
  if (!h) return null;
  const extraL = reasonField?.object === "QuoteLineItem" && l?.has(reasonField.field) ? [reasonField.field] : [];
  const lcols = pick(l, ["Id", "Product2Id", "Product2.Name", "PricebookEntryId", "Quantity", "StartQuantity", "EndQuantity", "UnitPrice", "NetUnitPrice", "TotalPrice", "ListPrice", "Discount", "BillingFrequency", "StartDate", "EndDate", "SellingModelType", "QuoteActionId", "ParentQuoteLineItemId", ...extraL]);
  const qaFields = l?.has("QuoteActionId") ? await fieldsOf(api, "QuoteAction") : null;
  if (qaFields) lcols.push(...["QuoteAction.Type", "QuoteAction.Subtype", "QuoteAction.SourceAssetId", ...(reasonField?.object === "QuoteAction" && qaFields.has(reasonField.field) ? [`QuoteAction.${reasonField.field}`] : [])].filter(c => qaFields.has(c.split(".")[1])));
  const rows = await api.query<Row>(`SELECT ${lcols.join(", ")} FROM QuoteLineItem WHERE QuoteId = ${soql(quoteId)} ORDER BY SortOrder NULLS LAST, CreatedDate LIMIT 1000`);
  const attrHave = rows.length ? await fieldsOf(api, "QuoteLineItemAttribute") : null;
  const attrs = attrHave ? await api.query<Row>(`SELECT ${pick(attrHave, ["Id", "QuoteLineItemId", "AttributeDefinitionId", "AttributeValue", "AttributePicklistValueId"]).join(", ")} FROM QuoteLineItemAttribute WHERE QuoteLineItemId IN (${ids(rows.map(r => String(r.Id)))}) LIMIT 2000`).catch(() => [] as Row[]) : [];
  return {
    id: String(h.Id), quoteNumber: s(h.QuoteNumber), name: s(h.Name), status: s(h.Status), calculationStatus: s(h.CalculationStatus), lastPricedDate: s(h.LastPricedDate),
    totalPrice: n(h.TotalPrice), subtotal: n(h.Subtotal), tax: n(h.Tax), grandTotal: n(h.GrandTotal),
    contractId: s(h.ContractId), opportunityId: s(h.OpportunityId), originalActionType: s(h.OriginalActionType), startDate: s(h.StartDate), reasonValue: extraQ.length ? s(h[extraQ[0]]) : null,
    lines: rows.map(r => ({
      id: String(r.Id), productId: s(r.Product2Id), productName: s(rel(r, "Product2.Name")), pricebookEntryId: s(r.PricebookEntryId),
      quantity: n(r.Quantity), startQuantity: n(r.StartQuantity), endQuantity: n(r.EndQuantity), unitPrice: n(r.UnitPrice), netUnitPrice: n(r.NetUnitPrice), totalPrice: n(r.TotalPrice), listPrice: n(r.ListPrice), discount: n(r.Discount),
      billingFrequency: s(r.BillingFrequency), startDate: s(r.StartDate), endDate: s(r.EndDate), sellingModelType: s(r.SellingModelType),
      quoteActionId: s(r.QuoteActionId), actionType: s(rel(r, "QuoteAction.Type")), actionSubtype: s(rel(r, "QuoteAction.Subtype")), sourceAssetId: s(rel(r, "QuoteAction.SourceAssetId")), parentLineId: s(r.ParentQuoteLineItemId),
      reasonValue: reasonField?.object === "QuoteLineItem" ? s(r[reasonField.field]) : reasonField?.object === "QuoteAction" ? s(rel(r, `QuoteAction.${reasonField.field}`)) : null,
      attributes: attrs.filter(a => a.QuoteLineItemId === r.Id).map(a => ({ id: String(a.Id), definitionId: s(a.AttributeDefinitionId), value: s(a.AttributeValue), picklistValueId: s(a.AttributePicklistValueId) })),
    })),
  };
}

export interface LifecycleOrder { id: string; orderNumber: string | null; status: string | null; originalActionType: string | null; quoteId: string | null; contractId: string | null; totalAmount: number | null; effectiveDate: string | null; items: { id: string; productName: string | null; quantity: number | null; startQuantity: number | null; endQuantity: number | null; unitPrice: number | null; totalPrice: number | null; actionType: string | null; sourceAssetId: string | null }[] }

export async function lifecycleOrder(api: RampApi, where: { orderId?: string; quoteId?: string }): Promise<LifecycleOrder | null> {
  const [o, oi] = await Promise.all([fieldsOf(api, "Order"), fieldsOf(api, "OrderItem")]);
  const ocols = pick(o, ["Id", "OrderNumber", "Status", "OriginalActionType", "QuoteId", "ContractId", "TotalAmount", "EffectiveDate"]);
  const filter = where.orderId ? `Id = ${soql(where.orderId)}` : `QuoteId = ${soql(where.quoteId!)}`;
  const [h] = await api.query<Row>(`SELECT ${ocols.join(", ")} FROM Order WHERE ${filter} ORDER BY CreatedDate DESC LIMIT 1`);
  if (!h) return null;
  const icols = pick(oi, ["Id", "Product2.Name", "Quantity", "StartQuantity", "EndQuantity", "UnitPrice", "TotalPrice", "OrderActionId"]);
  if (oi?.has("OrderActionId")) icols.push("OrderAction.Type", "OrderAction.SourceAssetId");
  const items = await api.query<Row>(`SELECT ${icols.join(", ")} FROM OrderItem WHERE OrderId = ${soql(String(h.Id))} LIMIT 1000`);
  return {
    id: String(h.Id), orderNumber: s(h.OrderNumber), status: s(h.Status), originalActionType: s(h.OriginalActionType), quoteId: s(h.QuoteId), contractId: s(h.ContractId), totalAmount: n(h.TotalAmount), effectiveDate: s(h.EffectiveDate),
    items: items.map(r => ({ id: String(r.Id), productName: s(rel(r, "Product2.Name")), quantity: n(r.Quantity), startQuantity: n(r.StartQuantity), endQuantity: n(r.EndQuantity), unitPrice: n(r.UnitPrice), totalPrice: n(r.TotalPrice), actionType: s(rel(r, "OrderAction.Type")), sourceAssetId: s(rel(r, "OrderAction.SourceAssetId")) })),
  };
}

/** Async tracker (requestIdentifier) status. */
export async function trackerStatus(api: RampApi, id: string | null): Promise<{ status: string | null; response: string | null; referenceId: string | null }> {
  if (!id) return { status: null, response: null, referenceId: null };
  const have = await fieldsOf(api, "AsyncOperationTracker");
  if (!have) return { status: null, response: null, referenceId: null };
  const [r] = await api.query<Row>(`SELECT ${pick(have, ["Id", "Status", "Response", "ReferenceEntityId"]).join(", ")} FROM AsyncOperationTracker WHERE Id = ${soql(id)} LIMIT 1`).catch(() => []);
  return { status: s(r?.Status), response: s(r?.Response), referenceId: s(r?.ReferenceEntityId) };
}

/** A lifecycle quote Salesforce created for these assets since `since` (recovers an initiation whose response was lost). */
export async function findInitiatedQuote(api: RampApi, kind: LifecycleKind, assetIds: string[], since: string, anyType = false): Promise<{ quoteId: string; quoteNumber: string | null } | null> {
  const qa = await fieldsOf(api, "QuoteAction");
  if (!qa?.has("SourceAssetId") || !assetIds.length) return null;
  const from = new Date(Date.parse(since) - 120_000).toISOString().replace(/\.\d+Z$/, "Z");
  const rows = await api.query<Row>(`SELECT QuoteId, Quote.QuoteNumber, SourceAssetId, CreatedDate FROM QuoteAction WHERE ${anyType ? "" : `Type IN (${LINE_TYPE_VALUES[kind].map(soql).join(",")}) AND `}SourceAssetId IN (${ids(assetIds)}) AND CreatedDate >= ${from} ORDER BY CreatedDate DESC LIMIT 200`);
  const byQuote = new Map<string, Set<string>>();
  for (const r of rows) { const set = byQuote.get(String(r.QuoteId)) ?? new Set(); set.add(String(r.SourceAssetId)); byQuote.set(String(r.QuoteId), set); }
  for (const [quoteId, set] of byQuote) if (assetIds.every(a => set.has(a))) return { quoteId, quoteNumber: s(rel(rows.find(r => r.QuoteId === quoteId)!, "Quote.QuoteNumber")) };
  return null;
}

/** Asset state after activation: current quantity / end date + asset actions created since the activation. */
export async function assetsAfter(api: RampApi, assetIds: string[], since: string | null) {
  const have = await fieldsOf(api, "Asset");
  const cols = pick(have, ["Id", "Name", "CurrentQuantity", "Quantity", "CurrentMrr", "LifecycleEndDate", "CurrentLifecycleEndDate", "Product2Id"]);
  const assets = assetIds.length ? await api.query<Row>(`SELECT ${cols.join(", ")} FROM Asset WHERE Id IN (${ids(assetIds)})`) : [];
  const aa = await fieldsOf(api, "AssetAction");
  // Look back 2 minutes before the activation request: the app server's clock and Salesforce's may differ slightly.
  const from = since && !Number.isNaN(Date.parse(since)) ? new Date(Date.parse(since) - 120_000).toISOString().replace(/\.\d+Z$/, "Z") : null;
  const acols = pick(aa, ["Id", "AssetId", "Type", "CategoryEnum", "Subtype", "QuantityChange", "CreatedDate"]);
  const actions = aa && assetIds.length ? await api.query<Row>(`SELECT ${acols.join(", ")} FROM AssetAction WHERE AssetId IN (${ids(assetIds)})${from ? ` AND CreatedDate >= ${from}` : ""} ORDER BY CreatedDate`) : [];
  return assets.map(a => ({
    id: String(a.Id), name: s(a.Name), quantity: n(a.CurrentQuantity) ?? n(a.Quantity), mrr: n(a.CurrentMrr), lifecycleEnd: day(s(a.CurrentLifecycleEndDate) ?? s(a.LifecycleEndDate)), productId: s(a.Product2Id),
    newActions: actions.filter(x => x.AssetId === a.Id).map(x => ({ id: String(x.Id), type: s(x.Type), category: s(x.CategoryEnum), subtype: s(x.Subtype), quantityChange: n(x.QuantityChange), createdDate: s(x.CreatedDate) })),
  }));
}

/** Assets created for an order's lines (added products / upgrade targets): AssetActionSource → OrderItem of the order. */
export async function assetsFromOrder(api: RampApi, orderId: string) {
  const src = await fieldsOf(api, "AssetActionSource");
  if (!src?.has("ReferenceEntityItemId")) return [];
  const items = await api.query<Row>(`SELECT Id FROM OrderItem WHERE OrderId = ${soql(orderId)} LIMIT 1000`);
  if (!items.length) return [];
  const rows = await api.query<Row>(`SELECT AssetAction.AssetId, AssetAction.Type, AssetAction.CategoryEnum, ReferenceEntityItemId FROM AssetActionSource WHERE ReferenceEntityItemId IN (${ids(items.map(i => String(i.Id)))}) LIMIT 1000`);
  return rows.map(r => ({ assetId: s(rel(r, "AssetAction.AssetId")), type: s(rel(r, "AssetAction.Type")), category: s(rel(r, "AssetAction.CategoryEnum")), orderItemId: s(r.ReferenceEntityItemId) }));
}

/** Lifecycle quotes / orders in Salesforce (OriginalActionType = Amend | Renew | Cancel), newest first — for the dashboards. */
export async function salesforceTransactions(api: RampApi, kind: LifecycleKind, accountId: string | null) {
  const [q, o] = await Promise.all([fieldsOf(api, "Quote"), fieldsOf(api, "Order")]);
  const type = soql(ACTION_TYPE[kind]);
  const out: { source: "Quote" | "Order"; quoteId: string | null; quoteNumber: string | null; quoteStatus: string | null; effectiveDate: string | null; contractId: string | null; createdDate: string | null; total: number | null; accountId: string | null; accountName: string | null; order: { id: string; number: string | null; status: string | null } | null }[] = [];
  if (q?.has("OriginalActionType")) {
    const acct = q.has("QuoteAccountId") ? "QuoteAccountId" : q.has("AccountId") ? "AccountId" : null;
    const qcols = pick(q, ["Id", "QuoteNumber", "Status", "StartDate", "ContractId", "CreatedDate", "TotalPrice", ...(acct ? [acct] : [])]);
    const quotes = await api.query<Row>(`SELECT ${qcols.join(", ")}${acct ? `, ${acct.replace(/Id$/, "")}.Name` : ""} FROM Quote WHERE OriginalActionType = ${type}${accountId && acct ? ` AND ${acct} = ${soql(accountId)}` : ""} ORDER BY CreatedDate DESC LIMIT 100`);
    const orders = quotes.length && o ? await api.query<Row>(`SELECT Id, OrderNumber, Status, QuoteId FROM Order WHERE QuoteId IN (${ids(quotes.map(r => String(r.Id)))})`) : [];
    for (const r of quotes) {
      const ord = orders.find(x => x.QuoteId === r.Id);
      out.push({ source: "Quote", quoteId: String(r.Id), quoteNumber: s(r.QuoteNumber), quoteStatus: s(r.Status), effectiveDate: day(s(r.StartDate)), contractId: s(r.ContractId), createdDate: s(r.CreatedDate), total: n(r.TotalPrice), accountId: acct ? s(r[acct]) : null, accountName: acct ? s(rel(r, `${acct.replace(/Id$/, "")}.Name`)) : null, order: ord ? { id: String(ord.Id), number: s(ord.OrderNumber), status: s(ord.Status) } : null });
    }
  }
  if (o?.has("OriginalActionType")) {
    // Orders created directly (no quote) by a lifecycle action.
    const ocols = pick(o, ["Id", "OrderNumber", "Status", "EffectiveDate", "ContractId", "CreatedDate", "TotalAmount", "AccountId", "Account.Name"]);
    const orders = await api.query<Row>(`SELECT ${ocols.join(", ")} FROM Order WHERE OriginalActionType = ${type} AND QuoteId = null${accountId ? ` AND AccountId = ${soql(accountId)}` : ""} ORDER BY CreatedDate DESC LIMIT 100`).catch(() => [] as Row[]);
    for (const r of orders) out.push({ source: "Order", quoteId: null, quoteNumber: null, quoteStatus: null, effectiveDate: day(s(r.EffectiveDate)), contractId: s(r.ContractId), createdDate: s(r.CreatedDate), total: n(r.TotalAmount), accountId: s(r.AccountId), accountName: s(rel(r, "Account.Name")), order: { id: String(r.Id), number: s(r.OrderNumber), status: s(r.Status) } });
  }
  return out.sort((a, b2) => (b2.createdDate ?? "").localeCompare(a.createdDate ?? ""));
}

/* ───────────── Bill-To + addresses for the lifecycle forms (read-only) ───────────── */

export interface BillingOptions {
  contacts: { id: string; name: string; email: string | null; mailing: PostalAddress | null }[];
  /** Addresses on real records: the assets' original orders first, then the account's other orders, the account, contacts. */
  addresses: { source: string; address: PostalAddress }[];
  /** A sensible starting point — the assets' original order (else the account's latest billed order); always editable. */
  defaults: { billToContactId: string | null; billToContactName: string | null; billingAddress: PostalAddress | null; shippingAddress: PostalAddress | null; source: string } | null;
}
const ADDR = ["Street", "City", "State", "PostalCode", "Country"] as const;
const addrOf = (r: Row, prefix: string): PostalAddress | null => {
  const a: PostalAddress = { street: s(r[`${prefix}Street`]), city: s(r[`${prefix}City`]), state: s(r[`${prefix}State`]), postalCode: s(r[`${prefix}PostalCode`]), country: s(r[`${prefix}Country`]) };
  return Object.values(a).some(Boolean) ? a : null;
};
const addrCols = (have: Set<string>, prefix: string) => pick(have, ADDR.map(k => `${prefix}${k}`));

export async function billingOptions(api: RampApi, accountId: string, originOrderIds: string[] = []): Promise<BillingOptions> {
  const [contactF, accountF, orderF] = await Promise.all([fieldsOf(api, "Contact"), fieldsOf(api, "Account"), fieldsOf(api, "Order")]);
  const contacts = contactF ? await api.query<Row>(`SELECT ${["Id", "Name", ...pick(contactF, ["Email"]), ...addrCols(contactF, "Mailing")].join(", ")} FROM Contact WHERE AccountId = ${soql(accountId)} ORDER BY Name LIMIT 200`) : [];
  const [account] = accountF ? await api.query<Row>(`SELECT ${["Id", "Name", ...addrCols(accountF, "Billing"), ...addrCols(accountF, "Shipping")].join(", ")} FROM Account WHERE Id = ${soql(accountId)}`) : [];
  const billTo = orderF?.has("BillToContactId") ? ["BillToContactId", "BillToContact.Name"] : [];
  const orderCols = orderF ? ["Id", "OrderNumber", ...billTo, ...addrCols(orderF, "Billing"), ...addrCols(orderF, "Shipping")].join(", ") : null;
  const origin = orderCols && originOrderIds.length ? await api.query<Row>(`SELECT ${orderCols} FROM Order WHERE Id IN (${[...new Set(originOrderIds)].map(soql).join(",")})`) : [];
  const recent = orderCols ? await api.query<Row>(`SELECT ${orderCols} FROM Order WHERE AccountId = ${soql(accountId)} ORDER BY CreatedDate DESC LIMIT 10`) : [];
  const out: BillingOptions = {
    contacts: contacts.map(c => ({ id: String(c.Id), name: String(c.Name ?? c.Id), email: s(c.Email), mailing: addrOf(c, "Mailing") })),
    addresses: [], defaults: null,
  };
  const seen = new Set<string>();
  const push = (source: string, a: PostalAddress | null) => {
    if (!a?.street || !a.city || !a.country) return;
    const k = Object.values(a).map(v => (v ?? "").trim().toLowerCase()).join("|");
    if (!seen.has(k)) { seen.add(k); out.addresses.push({ source, address: a }); }
  };
  const orders = [...origin.map(o => ({ o, origin: true })), ...recent.filter(o => !origin.some(x => x.Id === o.Id)).map(o => ({ o, origin: false }))];
  for (const { o, origin: isOrigin } of orders) {
    push(`${isOrigin ? "Original order" : "Order"} ${o.OrderNumber ?? o.Id} — billing`, addrOf(o, "Billing"));
    push(`${isOrigin ? "Original order" : "Order"} ${o.OrderNumber ?? o.Id} — shipping`, addrOf(o, "Shipping"));
  }
  if (account) { push("Account billing address", addrOf(account, "Billing")); push("Account shipping address", addrOf(account, "Shipping")); }
  for (const c of out.contacts) push(`Contact ${c.name} — mailing`, c.mailing);
  // Default: the first order (original first) that has a Bill-To Contact of THIS account; else only the account's own addresses.
  const best = orders.find(({ o }) => o.BillToContactId && out.contacts.some(c => c.id.slice(0, 15) === String(o.BillToContactId).slice(0, 15)));
  if (best) {
    const o = best.o;
    out.defaults = { billToContactId: String(o.BillToContactId), billToContactName: s((o.BillToContact as Row | null)?.Name) ?? null, billingAddress: addrOf(o, "Billing"), shippingAddress: addrOf(o, "Shipping"), source: `${best.origin ? "Original order" : "Latest order"} ${o.OrderNumber ?? o.Id}` };
  } else if (account && (addrOf(account, "Billing") || addrOf(account, "Shipping"))) {
    const only = out.contacts.length === 1 ? out.contacts[0] : null;
    out.defaults = { billToContactId: only?.id ?? null, billToContactName: only?.name ?? null, billingAddress: addrOf(account, "Billing"), shippingAddress: addrOf(account, "Shipping") ?? addrOf(account, "Billing"), source: "Account addresses" };
  }
  return out;
}
