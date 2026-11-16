import type { RampApi } from "@/lib/ramp/server/api";
import type { LifecycleBillingService, OrderBillingSnapshot } from "../billing";

/**
 * In-memory Revenue Cloud org for asset-lifecycle TESTS ONLY (never used by the app). It answers the SOQL shapes the module sends and
 * simulates initiateAmendment / initiateRenewal / initiateCancellation, Place Sales Transaction, createOrderFromQuote and what
 * activation does to assets — following the record model read from a real org (QuoteAction Amend|Renew|Cancel + SourceAssetId; an
 * amend line's Quantity = change, StartQuantity = current, EndQuantity = result; added lines without QuoteAction → OrderAction Add).
 * The renewal / cancellation line shapes are this fake's assumption and are NOT verified against a live org.
 */
type Rec = Record<string, unknown> & { Id: string };
export interface FakeOptions {
  rejectInitiate?: string;
  /** Place Sales Transaction accepted (201) but these QuoteLineItem fields aren't kept. */
  dropLineFields?: string[];
  rejectOrder?: string;
  /** Activation leaves the assets unchanged (assetization never happens). */
  noAssetization?: boolean;
  missingAction?: string;
  /** The initiate action's response is lost (network) although Salesforce created the quote. */
  loseInitiateResponse?: boolean;
  /** Adds a writable picklist Quote.Cancellation_Reason__c. */
  reasonField?: boolean;
  /** initiateRenewal without the rampOptionsDetails input (API < 67). */
  noRampOptions?: boolean;
  /** Billing readiness (modelled on the live org: products carry Product2.BillingPolicyId; createOrderFromQuote leaves the order
   * unpriced; order pricing stamps OrderItem.BillingTreatmentId = the policy's default treatment). */
  billing?: {
    /** Product names created WITHOUT a Billing Policy. */
    productsWithoutPolicy?: string[];
    /** Order pricing does NOT stamp treatments (Order Setup must apply them). */
    pricingSkipsTreatment?: boolean;
    /** The "Arrears" policy has no default treatment (treatment must be chosen by the user). */
    arrearsWithoutDefault?: boolean;
    /** Place Sales Transaction on the order is refused with this message. */
    rejectOrderPricing?: string;
    /** The order reads as still pricing for this many reads after a pricing request. */
    pricingReads?: number;
  };
}

const FIELDS: Record<string, string[]> = {
  Account: ["Id", "Name", "BillingStreet", "BillingCity", "BillingState", "BillingPostalCode", "BillingCountry", "ShippingStreet", "ShippingCity", "ShippingState", "ShippingPostalCode", "ShippingCountry"],
  Contact: ["Id", "Name", "Email", "AccountId", "MailingStreet", "MailingCity", "MailingState", "MailingPostalCode", "MailingCountry"],
  Asset: ["Id", "Name", "AccountId", "Product2Id", "ProductCode", "HasLifecycleManagement", "CurrentQuantity", "Quantity", "CurrentMrr", "CurrentAmount", "TotalLifecycleAmount", "LifecycleStartDate", "LifecycleEndDate", "Status", "ParentId", "RootAssetId", "Price", "RenewalTerm", "RenewalTermUnit", "DoesAutomaticallyRenew", "CreatedDate"],
  AssetAction: ["Id", "AssetActionNumber", "AssetId", "Type", "CategoryEnum", "ActionDate", "QuantityChange", "Subtype", "CreatedDate", "MrrChange", "Amount"],
  AssetActionSource: ["Id", "AssetActionId", "ReferenceEntityItemId", "ProductSellingModelId", "PricebookEntryId", "NetUnitPrice", "UnitPrice", "Discount", "StartDate", "EndDate", "Quantity", "TotalLineAmount"],
  AssetStatePeriod: ["Id", "AssetId", "StartDate", "EndDate", "Quantity", "UnitPrice", "Discount", "BillingFrequency", "PricingContractId", "Mrr", "Amount"],
  AssetContractRelationship: ["Id", "AssetId", "ContractId", "StartDate", "EndDate"],
  AssetAttribute: ["Id", "AssetId", "AttributeDefinitionId", "AttributeName", "AttributeValue", "AttributePicklistValueId"],
  AssetRelationship: ["Id", "AssetId", "RelatedAssetId", "RelationshipType", "AssetRole", "RelatedAssetRole", "FromDate", "ToDate", "CreatedDate"],
  BillingScheduleGroup: ["Id", "BillingScheduleGroupNumber", "ReferenceEntityId", "StartDate", "EndDate", "CancellationDate", "TotalBilledAmount", "TotalPendingAmount"],
  BillingSchedule: ["Id", "BillingScheduleGroupId"],
  Order: ["Id", "OrderNumber", "Status", "OriginalActionType", "QuoteId", "ContractId", "TotalAmount", "AccountId", "EffectiveDate", "CreatedDate", "BillToContactId", "BillingStreet", "BillingCity", "BillingState", "BillingPostalCode", "BillingCountry", "ShippingStreet", "ShippingCity", "ShippingState", "ShippingPostalCode", "ShippingCountry", "CalculationStatus", "LastPricedDate"],
  OrderItem: ["Id", "OrderId", "Product2Id", "Quantity", "StartQuantity", "EndQuantity", "UnitPrice", "TotalPrice", "OrderActionId", "PricebookEntryId", "ServiceDate", "EndDate", "BillingTreatmentId"],
  OrderAction: ["Id", "OrderId", "Type", "Subtype", "SourceAssetId", "CreatedDate"],
  Quote: ["Id", "QuoteNumber", "Name", "Status", "CalculationStatus", "LastPricedDate", "TotalPrice", "ContractId", "OpportunityId", "OriginalActionType", "StartDate", "QuoteAccountId", "CreatedDate", "BillToContactId", "BillingStreet", "BillingCity", "BillingState", "BillingPostalCode", "BillingCountry", "ShippingStreet", "ShippingCity", "ShippingState", "ShippingPostalCode", "ShippingCountry"],
  QuoteLineItem: ["Id", "QuoteId", "Product2Id", "PricebookEntryId", "Quantity", "StartQuantity", "EndQuantity", "UnitPrice", "NetUnitPrice", "TotalPrice", "ListPrice", "Discount", "BillingFrequency", "StartDate", "EndDate", "SellingModelType", "QuoteActionId", "ParentQuoteLineItemId", "SortOrder", "PeriodBoundary"],
  QuoteLineItemAttribute: ["Id", "QuoteLineItemId", "AttributeDefinitionId", "AttributeValue", "AttributePicklistValueId"],
  QuoteAction: ["Id", "QuoteId", "Type", "Subtype", "SourceAssetId", "CreatedDate"],
  Product2: ["Id", "Name", "UsageModelType", "BillingPolicyId"],
  ProductSellingModel: ["Id", "Name", "SellingModelType", "Status", "PricingTerm", "PricingTermUnit"],
  PricebookEntry: ["Id", "Product2Id", "UnitPrice", "ProductSellingModelId", "Pricebook2Id"],
  Contract: ["Id", "ContractNumber", "Status", "StartDate", "EndDate", "AccountId"],
  AsyncOperationTracker: ["Id", "Status", "Response", "ReferenceEntityId"],
};
const UPDATEABLE_QLI = ["Quantity", "UnitPrice", "Discount", "BillingFrequency", "StartDate", "EndDate", "PeriodBoundary", "QuoteActionId"];
const rel = (r: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), r);
const addDays = (d: string, n: number) => { const x = new Date(`${d.slice(0, 10)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addYear = (d: string) => { const x = new Date(`${d.slice(0, 10)}T00:00:00Z`); x.setUTCFullYear(x.getUTCFullYear() + 1); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

export function fakeLifecycleOrg(opts: FakeOptions = {}, now: () => string = () => new Date().toISOString(), today = "2026-11-11") {
  let seq = 0;
  const nid = (p: string) => `${p}${String(++seq).padStart(15 - p.length, "0")}AAA`;
  const db: Record<string, Rec[]> = Object.fromEntries(Object.keys(FIELDS).map(k => [k, []]));
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const add = (o: string, r: Omit<Rec, "Id"> & { Id?: string }) => { const rec = { Id: r.Id ?? nid(o === "Quote" ? "0Q0" : o.slice(0, 3)), CreatedDate: now(), ...r } as Rec; db[o].push(rec); return rec; };
  const byId = (o: string, id: unknown) => db[o].find(r => r.Id === id);
  const fields = { ...FIELDS, Quote: [...FIELDS.Quote, ...(opts.reasonField ? ["Cancellation_Reason__c"] : [])] };

  // Seed: one account with one-time, term, usage, evergreen, expiring, expired and bundle assets; a contract; an upgrade product.
  const acct = add("Account", { Id: "001A00000000001AAA", Name: "Test Account" }).Id;
  const pb1 = "01sA00000000001AAA", pb2 = "01sA00000000002AAA";
  const smOne = add("ProductSellingModel", { Name: "One Time", SellingModelType: "OneTime", Status: "Active" });
  const smTerm = add("ProductSellingModel", { Name: "Term Annual", SellingModelType: "TermDefined", Status: "Active", PricingTerm: 1, PricingTermUnit: "Annual" });
  const smEver = add("ProductSellingModel", { Name: "Evergreen Monthly", SellingModelType: "Evergreen", Status: "Active", PricingTerm: 1, PricingTermUnit: "Months" });
  const prod = (Name: string, extra: Record<string, unknown> = {}) => add("Product2", { Name, ...extra });
  const pLaptop = prod("Laptop"), pSupport = prod("Support"), pPremium = prod("Support Premium"), pApi = prod("API Calls", { UsageModelType: "Anchor" }), pHosting = prod("Hosting"), pBackup = prod("Backup"), pOld = prod("Old Plan"), pSuite = prod("Suite"), pAddon = prod("Suite Addon");
  const pbe = (p: Rec, price: number, sm: Rec, book = pb1) => add("PricebookEntry", { Product2Id: p.Id, UnitPrice: price, ProductSellingModelId: sm.Id, Pricebook2Id: book });
  const contract = add("Contract", { ContractNumber: "00000100", Status: "Activated", AccountId: acct, StartDate: "2026-01-01", EndDate: "2027-12-31" });
  const origin = add("Order", { OrderNumber: "00000001", Status: "Activated", ContractId: null, AccountId: acct });
  const mkAsset = (name: string, product: Rec, entry: Rec, sm: Rec, qty: number, price: number, o: { start?: string; end?: string | null; parentId?: string | null; extra?: Record<string, unknown> } = {}) => {
    const start = o.start ?? "2026-01-01";
    const end = o.end === undefined ? (sm === smTerm ? "2027-12-31" : null) : o.end;
    const item = add("OrderItem", { OrderId: origin.Id, Product2Id: product.Id, Quantity: qty, UnitPrice: price, PricebookEntryId: entry.Id });
    const asset = add("Asset", { Name: name, AccountId: acct, Product2Id: product.Id, HasLifecycleManagement: true, CurrentQuantity: qty, Quantity: qty, CurrentMrr: 0, LifecycleStartDate: `${start}T00:00:00.000+0000`, LifecycleEndDate: end ? `${end}T23:59:59.000+0000` : null, ParentId: o.parentId ?? null, Price: price, ...(o.extra ?? {}) });
    asset.RootAssetId = o.parentId ?? asset.Id;
    const action = add("AssetAction", { AssetId: asset.Id, Type: "Generate", CategoryEnum: "Initial Sale", ActionDate: `${start}T00:00:00.000+0000`, QuantityChange: qty, CreatedDate: `${start}T00:00:00.000Z` });
    add("AssetActionSource", { AssetActionId: action.Id, ReferenceEntityItemId: item.Id, ProductSellingModelId: sm.Id, PricebookEntryId: entry.Id, NetUnitPrice: price, UnitPrice: price, StartDate: start, EndDate: end, Quantity: qty });
    add("AssetStatePeriod", { AssetId: asset.Id, StartDate: `${start}T00:00:00.000+0000`, EndDate: end ? `${end}T23:59:59.000+0000` : null, Quantity: qty, UnitPrice: price, BillingFrequency: sm === smOne ? null : sm === smEver ? "Monthly" : "Annual" });
    return asset;
  };
  const laptop = mkAsset("Laptop", pLaptop, pbe(pLaptop, 1000, smOne), smOne, 6, 1000);
  const support = mkAsset("Support", pSupport, pbe(pSupport, 50, smTerm), smTerm, 2, 50);
  const pbePremium = pbe(pPremium, 80, smTerm);
  const api = mkAsset("API Calls", pApi, pbe(pApi, 10, smTerm), smTerm, 1, 10);
  const hosting = mkAsset("Hosting", pHosting, pbe(pHosting, 30, smEver, pb2), smEver, 4, 30);
  const backup = mkAsset("Backup", pBackup, pbe(pBackup, 20, smTerm), smTerm, 3, 20, { start: "2025-12-16", end: "2026-12-15" });
  const old = mkAsset("Old Plan", pOld, pbe(pOld, 15, smTerm), smTerm, 3, 15, { start: "2025-07-01", end: "2026-06-30" });
  const suite = mkAsset("Suite", pSuite, pbe(pSuite, 100, smTerm), smTerm, 1, 100);
  const addon = mkAsset("Suite Addon", pAddon, pbe(pAddon, 5, smTerm), smTerm, 1, 5, { parentId: suite.Id });
  const plain = add("Asset", { Name: "Legacy Asset", AccountId: acct, Product2Id: pLaptop.Id, HasLifecycleManagement: false, CurrentQuantity: 1, ParentId: null });
  add("AssetContractRelationship", { AssetId: support.Id, ContractId: contract.Id, StartDate: "2026-01-01T00:00:00.000+0000", EndDate: "2027-12-31T00:00:00.000+0000" });
  const attrDef = "0tjA00000000001AAA";
  add("AssetAttribute", { AssetId: laptop.Id, AttributeDefinitionId: attrDef, AttributeName: "Color", AttributeValue: "Silver", AttributePicklistValueId: null });
  const bsg = add("BillingScheduleGroup", { BillingScheduleGroupNumber: "BSG-1", ReferenceEntityId: support.Id, StartDate: "2026-01-01", EndDate: "2027-12-31", CancellationDate: null, TotalBilledAmount: 1200, TotalPendingAmount: 1200 });
  add("BillingSchedule", { BillingScheduleGroupId: bsg.Id });
  const payer = add("Contact", { Name: "Pat Payer", Email: "pat@example.com", AccountId: acct, MailingStreet: "1 Main St", MailingCity: "Springfield", MailingState: "IL", MailingPostalCode: "62701", MailingCountry: "US" });
  add("Contact", { Name: "Sam Signer", Email: "sam@example.com", AccountId: acct });
  Object.assign(origin, { BillToContactId: payer.Id, BillingStreet: "1 Main St", BillingCity: "Springfield", BillingState: "IL", BillingPostalCode: "62701", BillingCountry: "US", ShippingStreet: "9 Dock Rd", ShippingCity: "Springfield", ShippingState: "IL", ShippingPostalCode: "62702", ShippingCountry: "US" });
  const policies = [
    { id: "1BPA00000000001AAA", name: "Advance", defaultTreatment: { id: "1BTA00000000001AAA", name: "Advance Treatment" } as { id: string; name: string } | null, treatments: [{ id: "1BTA00000000001AAA", name: "Advance Treatment", status: "Active" }] },
    { id: "1BPA00000000002AAA", name: "Arrears", defaultTreatment: opts.billing?.arrearsWithoutDefault ? null : { id: "1BTA00000000002AAA", name: "Arrears Treatment" }, treatments: [{ id: "1BTA00000000002AAA", name: "Arrears Treatment", status: "Active" }, { id: "1BTA00000000003AAA", name: "Arrears Draft", status: "Draft" }] },
  ];
  for (const p of db.Product2) p.BillingPolicyId = (opts.billing?.productsWithoutPolicy ?? []).includes(String(p.Name)) ? null : policies[0].id;
  const billingWrites: { kind: string; id: string; value: unknown }[] = [];
  let pricingReadsLeft = 0;

  const relationship = (o: string, r: Rec): Rec => {
    const out: Rec = { ...r };
    if ("Product2Id" in r) out.Product2 = { Name: byId("Product2", r.Product2Id)?.Name ?? null };
    if ("AccountId" in r && o !== "Contract") out.Account = { Name: byId("Account", r.AccountId)?.Name ?? null };
    if (o === "QuoteLineItem" && r.QuoteActionId) { const a = byId("QuoteAction", r.QuoteActionId); out.QuoteAction = a ? { Type: a.Type, Subtype: a.Subtype ?? null, SourceAssetId: a.SourceAssetId ?? null } : null; }
    if (o === "OrderItem") { const ord = byId("Order", r.OrderId); out.Order = ord ? { OrderNumber: ord.OrderNumber, ContractId: ord.ContractId ?? null } : null; if (r.OrderActionId) { const a = byId("OrderAction", r.OrderActionId); out.OrderAction = a ? { Type: a.Type, SourceAssetId: a.SourceAssetId ?? null } : null; } }
    if (o === "QuoteAction") { const q = byId("Quote", r.QuoteId); out.Quote = q ? { QuoteNumber: q.QuoteNumber, Status: q.Status, OriginalActionType: q.OriginalActionType ?? null } : null; }
    if (o === "OrderAction") { const q = byId("Order", r.OrderId); out.Order = q ? { OrderNumber: q.OrderNumber, Status: q.Status } : null; }
    if (o === "AssetActionSource") { const a = byId("AssetAction", r.AssetActionId); out.AssetAction = a ? { AssetId: a.AssetId, Type: a.Type, CategoryEnum: a.CategoryEnum } : null; }
    if (o === "Quote" && r.QuoteAccountId) out.QuoteAccount = { Name: byId("Account", r.QuoteAccountId)?.Name ?? null };
    if (o === "Order" && r.BillToContactId) out.BillToContact = { Name: byId("Contact", r.BillToContactId)?.Name ?? null };
    if (o === "AssetRelationship") { out.Asset = { Name: byId("Asset", r.AssetId)?.Name ?? null }; out.RelatedAsset = { Name: byId("Asset", r.RelatedAssetId)?.Name ?? null }; }
    return out;
  };

  function query(q: string): Record<string, unknown>[] {
    const from = /\bFROM\s+(\w+)/i.exec(q)?.[1] ?? "";
    if (from === "Order" && /CalculationStatus/.test(q) && pricingReadsLeft > 0 && --pricingReadsLeft === 0) for (const o of db.Order.filter(x => x.CalculationStatus === "InProgress")) Object.assign(o, { CalculationStatus: "CompletedWithPricing", LastPricedDate: now() });
    let rows = (db[from] ?? []).map(r => relationship(from, r));
    // Strip sub-selects ("Id IN (SELECT …)") — the fake ignores them — then apply the simple filters.
    let where = (q.split(/\bWHERE\b/i)[1]?.split(/\bORDER BY\b|\bLIMIT\b/i)[0] ?? "").replace(/\(SELECT[^)]*\)/gi, "()");
    // "(AssetId IN (…) OR RelatedAssetId IN (…))" — the one OR shape the module sends.
    const either = /\(AssetId IN \(([^)]*)\) OR RelatedAssetId IN \(([^)]*)\)\)/i.exec(where);
    if (either) {
      const vals = [...either[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
      rows = rows.filter(r => vals.includes(String(r.AssetId)) || vals.includes(String(r.RelatedAssetId)));
      where = where.replace(either[0], "");
    }
    for (const m of where.matchAll(/([\w.]+)\s+IN\s*\(([^)]*)\)/gi)) { const vals = [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1]); if (vals.length || m[2].trim() === "") rows = rows.filter(r => !m[2].trim() || vals.includes(String(rel(r, m[1])))); }
    for (const m of where.matchAll(/([\w.]+)\s*=\s*'([^']*)'/g)) rows = rows.filter(r => String(rel(r, m[1])) === m[2]);
    // Account name search (the only standalone LIKE the module sends): case-insensitive contains, like Salesforce.
    if (from === "Account") for (const m of where.matchAll(/Name\s+LIKE\s+'%([^']*)%'/gi)) rows = rows.filter(r => String(r.Name ?? "").toLowerCase().includes(m[1].toLowerCase()));
    for (const m of where.matchAll(/([\w.]+)\s*=\s*(true|false)\b/gi)) rows = rows.filter(r => rel(r, m[1]) === (m[2].toLowerCase() === "true"));
    for (const m of where.matchAll(/(?:^|\s|\()([\w.]+)\s*=\s*null\b/gi)) if (!/OR\s+[\w.]+\s*>=/.test(where)) rows = rows.filter(r => rel(r, m[1]) === null || rel(r, m[1]) === undefined);
    const since = /CreatedDate\s*>=\s*(\S+)/.exec(where)?.[1];
    if (since) rows = rows.filter(r => Date.parse(String(r.CreatedDate ?? "")) >= Date.parse(since));
    if (/SELECT\s+COUNT\(/i.test(q)) return [{ total: rows.length }];
    const limit = Number(/\bLIMIT\s+(\d+)/i.exec(q)?.[1] ?? 10_000), offset = Number(/\bOFFSET\s+(\d+)/i.exec(q)?.[1] ?? 0);
    if (/ORDER BY Name/i.test(q)) rows.sort((a, b) => String(a.Name).localeCompare(String(b.Name)) || String(a.Id).localeCompare(String(b.Id)));
    return rows.slice(offset, offset + limit);
  }

  function lineTotals(quoteId: string) {
    const q = byId("Quote", quoteId)!;
    for (const l of db.QuoteLineItem.filter(x => x.QuoteId === quoteId)) { l.NetUnitPrice = Number(l.UnitPrice ?? 0) * (1 - Number(l.Discount ?? 0) / 100); l.TotalPrice = Number(l.NetUnitPrice) * Number(l.Quantity ?? 0); }
    q.TotalPrice = db.QuoteLineItem.filter(l => l.QuoteId === quoteId).reduce((a, l) => a + Number(l.TotalPrice ?? 0), 0);
  }

  const inputsOf: Record<string, string[]> = {
    initiateAmendment: ["amendAssetIds", "amendStartDate", "quantityChange", "amendOutputType", "amendContractId", "amendOpportunityId", "amendRecordId", "skipPricing", "actionSubtype", "transactionOptions"],
    initiateRenewal: ["renewAssetIds", "renewOutputType", "renewOpportunityId", "renewContractId", "renewRecordId", "renewStartDate", "renewEndDate", "skipPricing", ...(opts.noRampOptions ? [] : ["rampOptionsDetails"]), "transactionOptions"],
    initiateCancellation: ["cancelAssetIds", "cancelStartDate", "cancelOutputType", "cancelOpportunityId", "cancelContractId", "cancelRecordId", "skipPricing"],
    createOrderFromQuote: ["quoteRecordId"],
  };

  function newQuote(type: string, input: Record<string, unknown>, start: string | null) {
    return add("Quote", { QuoteNumber: `Q-${seq}`, Name: `${type} Quote`, Status: "Draft", CalculationStatus: "CompletedWithPricing", LastPricedDate: now(), OriginalActionType: type, ContractId: input.amendContractId ?? input.renewContractId ?? input.cancelContractId ?? null, OpportunityId: input.amendOpportunityId ?? input.renewOpportunityId ?? input.cancelOpportunityId ?? null, StartDate: start, QuoteAccountId: acct });
  }
  function lifecycleLine(quote: Rec, type: string, assetId: string, line: Record<string, unknown>) {
    const a = byId("Asset", assetId)!;
    const src = db.AssetActionSource.filter(s => byId("AssetAction", s.AssetActionId)?.AssetId === assetId).at(-1);
    const sm = byId("ProductSellingModel", src?.ProductSellingModelId);
    const qa = add("QuoteAction", { QuoteId: quote.Id, Type: type, Subtype: null, SourceAssetId: assetId });
    const l = add("QuoteLineItem", { QuoteId: quote.Id, Product2Id: a.Product2Id, PricebookEntryId: src?.PricebookEntryId, UnitPrice: src?.UnitPrice, ListPrice: src?.UnitPrice, Discount: null, BillingFrequency: sm?.SellingModelType === "OneTime" ? null : "Annual", SellingModelType: sm?.SellingModelType, QuoteActionId: qa.Id, ParentQuoteLineItemId: null, ...line });
    for (const at of db.AssetAttribute.filter(x => x.AssetId === assetId)) add("QuoteLineItemAttribute", { QuoteLineItemId: l.Id, AttributeDefinitionId: at.AttributeDefinitionId, AttributeValue: at.AttributeValue, AttributePicklistValueId: at.AttributePicklistValueId ?? null });
    // Bundle: Salesforce brings the components with the root.
    for (const child of db.Asset.filter(c => c.ParentId === assetId)) {
      const cqa = add("QuoteAction", { QuoteId: quote.Id, Type: type, SourceAssetId: child.Id });
      add("QuoteLineItem", { QuoteId: quote.Id, Product2Id: child.Product2Id, Quantity: line.Quantity, StartQuantity: child.CurrentQuantity, EndQuantity: line.EndQuantity === 0 ? 0 : child.CurrentQuantity, UnitPrice: 0, QuoteActionId: cqa.Id, ParentQuoteLineItemId: l.Id, StartDate: line.StartDate, EndDate: line.EndDate });
    }
    return l;
  }

  const call: RampApi["call"] = async (method, path, body) => {
    calls.push({ method, path, body });
    const b = (body ?? {}) as Record<string, unknown>;
    const action = /\/actions\/standard\/(\w+)$/.exec(path)?.[1];
    const swapKind = /\/revenue\/transaction-management\/assets\/actions\/(upgrade|downgrade|swap)$/.exec(path)?.[1];
    if (swapKind && method === "GET") return opts.missingAction === swapKind ? { status: 404, body: [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }] } : { status: 405, body: [{ errorCode: "METHOD_NOT_ALLOWED", message: "HTTP Method 'GET' not allowed. Allowed are POST" }] };
    if (swapKind && method === "POST") {
      // Assumed shape (not verified live): out line = Amend / <Kind>From with −quantity; in line = Add / <Kind>To.
      if (opts.rejectInitiate) return { status: 400, body: [{ errorCode: "INVALID_INPUT", message: opts.rejectInitiate }] };
      const sub = swapKind === "upgrade" ? "Upgrade" : swapKind === "downgrade" ? "Downgrade" : "Swap";
      const quote = newQuote("Amend", { amendContractId: b.contractId, amendOpportunityId: b.opportunityId }, String(b.swapStartDate).slice(0, 10));
      for (const g of (b.swapGroups as { groups: { outGroup: { swapAssets: { assetId: string; quantity: number }[] }; inGroup: { records: { record: Record<string, unknown> }[] } }[] }).groups) {
        for (const out of g.outGroup.swapAssets) {
          const a = byId("Asset", out.assetId)!;
          const l = lifecycleLine(quote, "Amend", out.assetId, { Quantity: -out.quantity, StartQuantity: a.CurrentQuantity, EndQuantity: Number(a.CurrentQuantity) - out.quantity, StartDate: String(b.swapStartDate).slice(0, 10) });
          byId("QuoteAction", l.QuoteActionId)!.Subtype = swapKind === "swap" ? "SwapOut" : `${sub}From`;
        }
        for (const { record } of g.inGroup.records) {
          const { attributes: _a, ...flds } = record;
          void _a;
          const qa = add("QuoteAction", { QuoteId: quote.Id, Type: "Add", Subtype: swapKind === "swap" ? "SwapIn" : `${sub}To`, SourceAssetId: null });
          add("QuoteLineItem", { ...flds, QuoteId: quote.Id, StartQuantity: 0, EndQuantity: flds.Quantity, QuoteActionId: qa.Id, ParentQuoteLineItemId: null, SwapFromAssetId: g.outGroup.swapAssets[0].assetId });
        }
      }
      lineTotals(quote.Id);
      if (opts.loseInitiateResponse) throw new Error("socket hang up");
      return { status: 201, body: { salesTransactionId: quote.Id } };
    }
    if (method === "GET" && action) {
      if (opts.missingAction === action || !inputsOf[action]) return { status: 404, body: [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }] };
      return { status: 200, body: { name: action, inputs: inputsOf[action].map(name => ({ name })) } };
    }
    if (method === "POST" && action && ["initiateAmendment", "initiateRenewal", "initiateCancellation"].includes(action)) {
      if (opts.rejectInitiate) return { status: 400, body: [{ actionName: action, isSuccess: false, errors: [{ statusCode: "INVALID_INPUT", message: opts.rejectInitiate }] }] };
      const input = (b.inputs as Record<string, unknown>[])[0];
      let quote: Rec, key: string;
      if (action === "initiateAmendment") {
        key = "amendRecordId";
        quote = newQuote("Amend", input, String(input.amendStartDate).slice(0, 10));
        // Verified live (p13): quantityChange 0 → the asset's line gets QuoteAction Type "No Change".
        for (const id of input.amendAssetIds as string[]) { const a = byId("Asset", id)!; const qc = Number(input.quantityChange); lifecycleLine(quote, qc === 0 ? "No Change" : "Amend", id, { Quantity: qc, StartQuantity: a.CurrentQuantity, EndQuantity: Number(a.CurrentQuantity) + qc, StartDate: String(input.amendStartDate).slice(0, 10), EndDate: (String(a.LifecycleEndDate ?? "") || null)?.slice(0, 10) ?? null }); }
      } else if (action === "initiateRenewal") {
        key = "renewRecordId";
        quote = newQuote("Renew", input, input.renewStartDate ? String(input.renewStartDate).slice(0, 10) : null);
        for (const id of input.renewAssetIds as string[]) {
          const a = byId("Asset", id)!;
          const start = input.renewStartDate ? String(input.renewStartDate).slice(0, 10) : addDays(String(a.LifecycleEndDate), 1);
          const end = input.renewEndDate ? String(input.renewEndDate).slice(0, 10) : addYear(start);
          lifecycleLine(quote, "Renew", id, { Quantity: a.CurrentQuantity || a.Quantity, StartQuantity: 0, EndQuantity: a.CurrentQuantity || a.Quantity, StartDate: start, EndDate: end });
        }
      } else {
        key = "cancelRecordId";
        quote = newQuote("Cancel", input, String(input.cancelStartDate).slice(0, 10));
        for (const id of input.cancelAssetIds as string[]) { const a = byId("Asset", id)!; lifecycleLine(quote, "Cancel", id, { Quantity: -Number(a.CurrentQuantity), StartQuantity: a.CurrentQuantity, EndQuantity: 0, StartDate: String(input.cancelStartDate).slice(0, 10), EndDate: (String(a.LifecycleEndDate ?? "") || null)?.slice(0, 10) ?? null }); }
      }
      lineTotals(quote.Id);
      const tracker = add("AsyncOperationTracker", { Status: "Completed", Response: null, ReferenceEntityId: quote.Id });
      if (opts.loseInitiateResponse) throw new Error("socket hang up");
      return { status: 200, body: [{ actionName: action, isSuccess: true, errors: null, outputValues: { [key]: quote.Id, requestIdentifier: tracker.Id } }] };
    }
    if (method === "POST" && /sales-transaction\/actions\/place$/.test(path) && ((b.graph as { records: { record: { attributes: { type: string } } }[] }).records[0]?.record.attributes.type === "Order")) {
      const orderId = (b.graph as { records: { record: { attributes: { id: string } } }[] }).records[0].record.attributes.id;
      if (opts.billing?.rejectOrderPricing) return { status: 400, body: [{ errorCode: "INVALID_INPUT", message: opts.billing.rejectOrderPricing }] };
      const o = byId("Order", orderId)!;
      pricingReadsLeft = opts.billing?.pricingReads ?? 0;
      Object.assign(o, pricingReadsLeft ? { CalculationStatus: "InProgress" } : { CalculationStatus: "CompletedWithPricing", LastPricedDate: now() });
      if (!opts.billing?.pricingSkipsTreatment) for (const it of db.OrderItem.filter(i => i.OrderId === orderId)) {
        const pol = policies.find(p => p.id === byId("Product2", it.Product2Id)?.BillingPolicyId);
        if (pol?.defaultTreatment && !it.BillingTreatmentId) it.BillingTreatmentId = pol.defaultTreatment.id;
      }
      return { status: 201, body: { success: true, statusURL: null } };
    }
    if (method === "PATCH" && /\/sobjects\/(\w+)\/(\w+)$/.test(path)) {
      const [, obj, recId] = /\/sobjects\/(\w+)\/(\w+)$/.exec(path)!;
      const rec = byId(obj, recId);
      if (!rec) return { status: 404, body: [{ errorCode: "NOT_FOUND", message: `${obj} ${recId} not found` }] };
      for (const [k, v] of Object.entries(b)) if ((fields as Record<string, string[]>)[obj]?.includes(k)) rec[k] = v;
      return { status: 204, body: null };
    }
    if (method === "POST" && /sales-transaction\/actions\/place$/.test(path)) {
      const recs = ((b.graph as { records: { referenceId: string; record: Record<string, unknown> & { attributes: { type: string; method: string; id?: string } } }[] }).records);
      const quoteRec = recs.find(r => r.record.attributes.type === "Quote")!;
      const quoteId = quoteRec.record.attributes.id!;
      for (const { record } of recs) {
        const { attributes, ...flds } = record;
        if (attributes.type === "Quote") { for (const [k, v] of Object.entries(flds)) if (fields.Quote.includes(k)) byId("Quote", quoteId)![k] = v; }
        else if (attributes.type === "QuoteLineItem" && attributes.method === "PATCH") {
          const l = byId("QuoteLineItem", attributes.id)!;
          for (const [k, v] of Object.entries(flds)) if (UPDATEABLE_QLI.includes(k) && !(opts.dropLineFields ?? []).includes(k)) l[k] = v;
          l.EndQuantity = Number(l.StartQuantity ?? 0) + Number(l.Quantity ?? 0);
        } else if (attributes.type === "QuoteAction" && attributes.method === "PATCH") Object.assign(byId("QuoteAction", attributes.id)!, flds);
        else if (attributes.type === "QuoteLineItemAttribute" && attributes.method === "PATCH") Object.assign(byId("QuoteLineItemAttribute", attributes.id)!, flds);
        else if (attributes.type === "QuoteLineItem" && attributes.method === "POST") add("QuoteLineItem", { ...flds, QuoteId: quoteId, StartQuantity: 0, EndQuantity: flds.Quantity, QuoteActionId: null, ParentQuoteLineItemId: null });
      }
      if (b.pricingPref === "Force") Object.assign(byId("Quote", quoteId)!, { LastPricedDate: now(), CalculationStatus: "CompletedWithPricing" });
      lineTotals(quoteId);
      return { status: 201, body: { success: true, statusURL: null } };
    }
    if (method === "POST" && action === "createOrderFromQuote") {
      if (opts.rejectOrder) return { status: 400, body: [{ isSuccess: false, errors: [{ statusCode: "FIELD_INTEGRITY_EXCEPTION", message: opts.rejectOrder }] }] };
      const quoteId = (b.inputs as Record<string, unknown>[])[0].quoteRecordId;
      const quote = byId("Quote", quoteId)!;
      const order = add("Order", { OrderNumber: `0000${seq}`, Status: "Draft", OriginalActionType: quote.OriginalActionType, QuoteId: quoteId, ContractId: quote.ContractId ?? null, AccountId: acct, TotalAmount: quote.TotalPrice, EffectiveDate: quote.StartDate, CalculationStatus: "CompletedWithoutPricing", LastPricedDate: quote.LastPricedDate, BillToContactId: null });
      for (const l of db.QuoteLineItem.filter(x => x.QuoteId === quoteId)) {
        const qa = l.QuoteActionId ? byId("QuoteAction", l.QuoteActionId) : null;
        const oa = add("OrderAction", { OrderId: order.Id, Type: qa ? qa.Type : "Add", Subtype: qa?.Subtype ?? null, SourceAssetId: qa?.SourceAssetId ?? null });
        add("OrderItem", { OrderId: order.Id, Product2Id: l.Product2Id, Quantity: l.Quantity, StartQuantity: l.StartQuantity, EndQuantity: l.EndQuantity, UnitPrice: l.UnitPrice, TotalPrice: l.TotalPrice, OrderActionId: oa.Id, PricebookEntryId: l.PricebookEntryId, ServiceDate: l.StartDate, EndDate: l.EndDate, SwapFromAssetId: l.SwapFromAssetId ?? null });
      }
      return { status: 200, body: [{ isSuccess: true, outputValues: { orderId: order.Id, orderNumber: order.OrderNumber } }] };
    }
    return { status: 404, body: [{ errorCode: "NOT_FOUND", message: `fake org: ${method} ${path} not implemented` }] };
  };

  /** What activation does in Salesforce: order Activated, then assets updated / created from its lines. */
  const activate = async (orderId: string) => {
    const order = byId("Order", orderId);
    if (!order) return { success: false, message: "Order not found", salesforceError: "NOT_FOUND" };
    order.Status = "Activated";
    if (opts.noAssetization) return { success: true, message: "Activated", salesforceError: null };
    for (const it of db.OrderItem.filter(i => i.OrderId === orderId)) {
      const oa = byId("OrderAction", it.OrderActionId);
      if (oa?.SourceAssetId) {
        const a = byId("Asset", oa.SourceAssetId)!;
        if (oa.Type === "Amend") {
          const delta = Number(it.Quantity);
          if (String(it.ServiceDate ?? "") <= today) a.CurrentQuantity = it.EndQuantity;
          add("AssetAction", { AssetId: a.Id, Type: "Change", CategoryEnum: oa.Subtype ? (/^Swap/.test(String(oa.Subtype)) ? "Swaps" : String(oa.Subtype).replace(/From$/, "s")) : delta >= 0 ? "Upsells" : "Downsells", Subtype: oa.Subtype ?? null, QuantityChange: delta, ActionDate: now() });
        } else if (oa.Type === "Renew") {
          a.LifecycleEndDate = `${String(it.EndDate)}T23:59:59.000+0000`;
          add("AssetAction", { AssetId: a.Id, Type: "Change", CategoryEnum: "Renewals", QuantityChange: 0, ActionDate: now() });
        } else if (oa.Type === "Cancel") {
          if (String(it.ServiceDate ?? "") <= today) a.CurrentQuantity = 0;
          a.LifecycleEndDate = `${addDays(String(it.ServiceDate), -1)}T23:59:59.000+0000`;
          add("AssetAction", { AssetId: a.Id, Type: "Cancel", CategoryEnum: "Cancellations", QuantityChange: it.Quantity, ActionDate: now() });
          for (const g of db.BillingScheduleGroup.filter(x => x.ReferenceEntityId === a.Id)) g.CancellationDate = it.ServiceDate;
        }
      } else {
        const a = add("Asset", { Name: byId("Product2", it.Product2Id)?.Name, AccountId: acct, Product2Id: it.Product2Id, HasLifecycleManagement: true, CurrentQuantity: it.Quantity, ParentId: null });
        const aa = add("AssetAction", { AssetId: a.Id, Type: "Generate", CategoryEnum: "Initial Sale", QuantityChange: it.Quantity, ActionDate: now() });
        add("AssetActionSource", { AssetActionId: aa.Id, ReferenceEntityItemId: it.Id, PricebookEntryId: it.PricebookEntryId });
        if (it.SwapFromAssetId) add("AssetRelationship", { AssetId: it.SwapFromAssetId, RelatedAssetId: a.Id, RelationshipType: /^Downgrade/.test(String(oa?.Subtype)) ? "Replacement" : /^Swap/.test(String(oa?.Subtype)) ? "Crossgrade" : "Upgrade", FromDate: now() });
      }
    }
    return { success: true, message: "Activated", salesforceError: null };
  };

  const describe = async (o: string) => {
    const list = (fields as Record<string, string[]>)[o];
    if (!list) return null;
    return {
      name: o, createable: true, updateable: true, queryable: true,
      fields: list.map(name => ({
        name, label: name === "Cancellation_Reason__c" ? "Cancellation Reason" : name, custom: name.endsWith("__c"), createable: name !== "Id", updateable: name !== "Id",
        type: name === "Cancellation_Reason__c" || name === "BillingFrequency" ? "picklist" : "string",
        picklistValues: name === "BillingFrequency" ? ["Monthly", "Quarterly", "Annual"].map(value => ({ value, label: value, active: true })) : name === "PeriodBoundary" ? [{ value: "Anniversary", label: "Anniversary", active: true }] : name === "Cancellation_Reason__c" ? ["Budget", "Switched vendor", "Other"].map(value => ({ value, label: value, active: true })) : [],
      })),
    };
  };

  const addr = (o: Rec, p: string) => { const a = { street: (o[`${p}Street`] as string) ?? null, city: (o[`${p}City`] as string) ?? null, state: (o[`${p}State`] as string) ?? null, postalCode: (o[`${p}PostalCode`] as string) ?? null, country: (o[`${p}Country`] as string) ?? null }; return Object.values(a).some(Boolean) ? a : null; };
  const complete = (a: ReturnType<typeof addr>) => !!a?.street && !!a.city && !!a.country;
  const billing: LifecycleBillingService = {
    async load(orderId) {
      const o = byId("Order", orderId)!;
      const items = db.OrderItem.filter(i => i.OrderId === orderId).map(i => {
        const p = byId("Product2", i.Product2Id);
        const pol = policies.find(x => x.id === p?.BillingPolicyId) ?? null;
        const cur = i.BillingTreatmentId ? pol?.treatments.find(t => t.id === i.BillingTreatmentId) ?? policies.flatMap(x => x.treatments).find(t => t.id === i.BillingTreatmentId) ?? null : null;
        return { id: i.Id, product: p ? { id: p.Id, name: String(p.Name) } : null, policy: pol ? { id: pol.id, name: pol.name } : null, policyErrors: [], treatment: cur ? { id: cur.id, name: cur.name } : null, expectedTreatment: pol?.defaultTreatment ?? null, pendingActions: pol?.defaultTreatment && !cur ? ["billing-treatment"] : [] };
      });
      const contact = o.BillToContactId ? byId("Contact", o.BillToContactId) : null;
      const blockers: OrderBillingSnapshot["blockers"] = [];
      if (!contact) blockers.push({ message: "No Bill-To Contact.", orderItemId: null, product: null });
      if (!complete(addr(o, "Billing"))) blockers.push({ message: "No billing address.", orderItemId: null, product: null });
      if (!complete(addr(o, "Shipping"))) blockers.push({ message: "No shipping address.", orderItemId: null, product: null });
      for (const i of items) { if (!i.policy) blockers.push({ message: "does not have a Billing Policy assigned.", orderItemId: i.id, product: i.product?.name ?? null }); else if (!i.treatment) blockers.push({ message: "needs its Billing Treatment.", orderItemId: i.id, product: i.product?.name ?? null }); }
      return { orderId, orderNumber: String(o.OrderNumber), status: String(o.Status), activated: o.Status === "Activated", billToContact: contact ? { id: contact.Id, name: String(contact.Name) } : null, billingAddress: addr(o, "Billing"), shippingAddress: addr(o, "Shipping"), items, requiresBilling: items.some(i => i.policy), ready: blockers.length === 0 && o.Status === "Draft", blockers, stateToken: null };
    },
    async setDetails(orderId, input) {
      const o = byId("Order", orderId)!;
      if (input.contactId) { const c = byId("Contact", input.contactId); if (!c || c.AccountId !== o.AccountId) return { ok: false, error: "That contact doesn't belong to the order's account." }; o.BillToContactId = c.Id; billingWrites.push({ kind: "Order.BillToContactId", id: orderId, value: c.Id }); }
      for (const [p, a] of [["Billing", input.address], ["Shipping", input.shippingAddress]] as const) if (a) { Object.assign(o, { [`${p}Street`]: a.street, [`${p}City`]: a.city, [`${p}State`]: a.state, [`${p}PostalCode`]: a.postalCode, [`${p}Country`]: a.country }); billingWrites.push({ kind: `Order.${p}Address`, id: orderId, value: a }); }
      return { ok: true };
    },
    async applySetup(orderId, operations) {
      for (const i of db.OrderItem.filter(x => x.OrderId === orderId)) {
        const pol = policies.find(x => x.id === byId("Product2", i.Product2Id)?.BillingPolicyId);
        if (operations.includes("billing-treatment") && pol?.defaultTreatment && !i.BillingTreatmentId) { i.BillingTreatmentId = pol.defaultTreatment.id; billingWrites.push({ kind: "OrderItem.BillingTreatmentId", id: i.Id, value: pol.defaultTreatment.id }); }
      }
      return { ok: true, message: "Applied." };
    },
    async assignPolicy(productId, policyId, expected) {
      const p = byId("Product2", productId);
      if (!p) return { ok: false, error: "Product not found." };
      if ((p.BillingPolicyId ?? null) === policyId) return { ok: true, message: "Already assigned." };
      if ((p.BillingPolicyId ?? null) !== expected) return { ok: false, error: "The product's Billing Policy changed in Salesforce since you reviewed it." };
      p.BillingPolicyId = policyId; billingWrites.push({ kind: "Product2.BillingPolicyId", id: productId, value: policyId });
      return { ok: true };
    },
    async setTreatment(orderItemId, treatmentId, policyId) {
      const pol = policies.find(x => x.id === policyId);
      const tr = pol?.treatments.find(t => t.id === treatmentId);
      if (!tr || tr.status !== "Active") return { ok: false, error: "That Billing Treatment isn't an Active treatment of the product's policy." };
      const i = byId("OrderItem", orderItemId)!;
      if (i.BillingTreatmentId && i.BillingTreatmentId !== treatmentId) return { ok: false, error: "The order product already has a different Billing Treatment." };
      i.BillingTreatmentId = treatmentId; billingWrites.push({ kind: "OrderItem.BillingTreatmentId", id: orderItemId, value: treatmentId });
      return { ok: true };
    },
  };

  const fake: RampApi = { apiVersion: "v68.0", instanceUrl: "https://fake.my.salesforce.com", query: async <T,>(q: string) => query(q) as unknown as T[], call, describe };
  return {
    api: fake, db, calls, activate, byId, billing, billingWrites, policies,
    ids: { acct, contract: contract.Id, laptop: laptop.Id, support: support.Id, api: api.Id, hosting: hosting.Id, backup: backup.Id, old: old.Id, suite: suite.Id, addon: addon.Id, plain: plain.Id, pPremium: pPremium.Id, pbePremium: pbePremium.Id, attrDef, pb1, pb2, payer: payer.Id, origin: origin.Id },
  };
}
