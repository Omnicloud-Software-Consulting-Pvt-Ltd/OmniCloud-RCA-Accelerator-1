import { objectCapFromDescribe, type ObjectCap } from "@/lib/ramp/capabilities";
import { isIsoDate } from "@/lib/ramp/schedule";
import { groupState } from "@/lib/ramp/groupDiagnostics";
import type { SalesforceCall } from "@/lib/ramp/types";
import { quoteFacts, quoteGroups, searchQuotes, type QuoteSearchRow } from "./reads";
import { catalogProduct, lineItemFieldCaps, sellingModelDetails, typeLabel } from "./catalog";
import { planSellingModelFields } from "@/lib/quotes/lineItem/sellingModelFields";
import { sfMessage, soql, type RampApi } from "./api";

/**
 * GROUP RAMP QUOTE BUILDER — the three Salesforce writes the Group Ramp page can make BEFORE a ramp runs, each only after the user's
 * explicit confirmation (the routes require confirmed: true) and each read back from Salesforce:
 *  · create a Draft Quote          POST /sobjects/Quote           (only Name is required in p10 / p12; account via QuoteAccountId)
 *  · create a Quote Line Group     POST /sobjects/QuoteLineGroup  (Name + QuoteId required; Description / ParentQuoteLineGroupId optional)
 *  · add products to a group       POST /sobjects/QuoteLineItem   (QuoteId, PricebookEntryId, Quantity, Product2Id required;
 *                                   ProductSellingModelId is NOT createable — the selling model follows the PricebookEntry, so the entry is
 *                                   chosen per selling model, as the Quote module does)
 * Payloads only carry fields this org's Describe says are createable; required fields the org adds that this form doesn't collect are
 * reported instead of guessed. Ids returned are the ones Salesforce created; nothing is fabricated.
 */

export interface BuilderResult<T> { ok: boolean; message: string; record: T | null; calls: SalesforceCall[]; warnings: string[] }

async function cap(api: RampApi, sobject: string): Promise<ObjectCap> {
  const d = await api.describe(sobject);
  if (!d) throw new Error(`Salesforce didn't return the ${sobject} fields (Describe failed or your user can't see ${sobject}).`);
  return objectCapFromDescribe(d as Parameters<typeof objectCapFromDescribe>[0]);
}
/** Fields the org REQUIRES on create (not nillable, not defaulted) — from the raw Describe. */
async function requiredOnCreate(api: RampApi, sobject: string): Promise<string[]> {
  const d = (await api.describe(sobject)) as { fields?: { name: string; createable?: boolean; nillable?: boolean; defaultedOnCreate?: boolean }[] } | null;
  return (d?.fields ?? []).filter(f => f.createable && f.nillable === false && !f.defaultedOnCreate).map(f => f.name);
}
const now = () => new Date().toISOString();

async function insert(api: RampApi, sobject: string, body: Record<string, unknown>, calls: SalesforceCall[]): Promise<{ id: string | null; error: string | null }> {
  const path = `/sobjects/${sobject}`;
  const r = await api.call("POST", path, body);
  calls.push({ at: now(), method: "POST", path, request: body, status: r.status, response: r.body });
  const id = r.status < 300 && r.body && typeof r.body === "object" ? String((r.body as { id?: unknown }).id ?? "") : "";
  return id ? { id, error: null } : { id: null, error: sfMessage(r.body, `HTTP ${r.status}`) };
}

/* ── Quote ── */

export interface CreateQuoteInput { name: string; accountId: string | null; opportunityId?: string | null; pricebookId: string | null; expirationDate?: string | null; startDate?: string | null }

export async function createDraftQuote(api: RampApi, input: CreateQuoteInput): Promise<BuilderResult<QuoteSearchRow>> {
  const calls: SalesforceCall[] = [], warnings: string[] = [];
  const fail = (message: string): BuilderResult<QuoteSearchRow> => ({ ok: false, message, record: null, calls, warnings });
  const name = input.name?.trim();
  if (!name) return fail("Quote Name is required.");
  if (name.length > 255) return fail("Quote Name is longer than 255 characters.");
  for (const [k, v] of [["Expiration Date", input.expirationDate], ["Start Date", input.startDate]] as const) if (v && !isIsoDate(v)) return fail(`${k} must be a date (YYYY-MM-DD).`);
  const q = await cap(api, "Quote");
  const can = (f: string) => !!q.fields[f]?.createable;
  const body: Record<string, unknown> = { Name: name };
  if (input.accountId) {
    if (can("QuoteAccountId")) body.QuoteAccountId = input.accountId;
    else if (!input.opportunityId) return fail("This org's Quote has no createable account field (QuoteAccountId) — pick an Opportunity of the account instead.");
    const [a] = await api.query<{ Id: string }>(`SELECT Id FROM Account WHERE Id = ${soql(input.accountId)} LIMIT 1`);
    if (!a) return fail("The selected account wasn't found.");
  }
  if (input.opportunityId) {
    if (!can("OpportunityId")) return fail("This org's Quote.OpportunityId isn't createable for your user.");
    const [o] = await api.query<{ Id: string; AccountId: string | null }>(`SELECT Id, AccountId FROM Opportunity WHERE Id = ${soql(input.opportunityId)} LIMIT 1`);
    if (!o) return fail("The selected opportunity wasn't found.");
    if (input.accountId && o.AccountId && o.AccountId !== input.accountId) return fail("The opportunity belongs to a different account.");
    body.OpportunityId = input.opportunityId;
  }
  if (input.pricebookId) {
    if (!can("Pricebook2Id")) return fail("This org's Quote.Pricebook2Id isn't createable for your user.");
    const [p] = await api.query<{ Id: string; IsActive: boolean }>(`SELECT Id, IsActive FROM Pricebook2 WHERE Id = ${soql(input.pricebookId)} LIMIT 1`);
    if (!p) return fail("The selected price book wasn't found.");
    if (!p.IsActive) return fail("The selected price book is inactive.");
    body.Pricebook2Id = input.pricebookId;
  } else warnings.push("No price book: products can't be added until the quote has one.");
  if (input.expirationDate && can("ExpirationDate")) body.ExpirationDate = input.expirationDate;
  if (input.startDate && can("StartDate")) body.StartDate = input.startDate;
  if (can("Status") && (q.fields.Status?.picklist ?? []).includes("Draft")) body.Status = "Draft";
  const missing = (await requiredOnCreate(api, "Quote")).filter(f => !(f in body));
  if (missing.length) return fail(`This org requires ${missing.join(", ")} on Quote, which this form doesn't collect — create the quote in Salesforce instead.`);

  const r = await insert(api, "Quote", body, calls);
  if (!r.id) return fail(`Salesforce didn't create the quote: ${r.error}`);
  // Read back exactly what Salesforce saved (Id, QuoteNumber, Status, account, price book).
  const back = (await searchQuotes(api, { q: name, draftOnly: false, pageSize: 50 })).rows.find(x => x.id === r.id) ?? null;
  const facts = await quoteFacts(api, r.id);
  if (!back || !facts) return { ok: false, message: `Salesforce returned Id ${r.id}, but the quote couldn't be read back — check it in Salesforce before continuing.`, record: null, calls, warnings };
  if (facts.status !== "Draft") warnings.push(`Salesforce saved the quote with Status ${facts.status ?? "blank"}, not Draft — group ramps need a Draft quote.`);
  if (input.accountId && facts.accountId !== input.accountId) warnings.push("The account on the saved quote differs from the one chosen.");
  if (input.pricebookId && facts.pricebookId !== input.pricebookId) warnings.push("The price book on the saved quote differs from the one chosen.");
  return { ok: true, message: `Quote "${back.name}" #${back.quoteNumber ?? "?"} created (${back.id}) and read back from Salesforce — Status ${facts.status ?? "?"}.`, record: back, calls, warnings };
}

/* ── Quote Line Group ── */

export interface GroupRecord { id: string; name: string; quoteId: string; isRamped: boolean | null; parentId: string | null; sortOrder: number | null; segmentType: string | null; startDate: string | null; endDate: string | null }

export async function createQuoteLineGroup(api: RampApi, input: { quoteId: string; name: string; description?: string | null; parentId?: string | null }): Promise<BuilderResult<GroupRecord>> {
  const calls: SalesforceCall[] = [], warnings: string[] = [];
  const fail = (message: string): BuilderResult<GroupRecord> => ({ ok: false, message, record: null, calls, warnings });
  const name = input.name?.trim();
  if (!name) return fail("Group Name is required.");
  if (name.length > 255) return fail("Group Name is longer than 255 characters.");
  const quote = await quoteFacts(api, input.quoteId);
  if (!quote) return fail("The quote wasn't found.");
  if (quote.status !== "Draft") return fail(`Quote ${quote.name} is ${quote.status}; groups for a ramp go on a Draft quote.`);
  const g = await cap(api, "QuoteLineGroup");
  const can = (f: string) => !!g.fields[f]?.createable;
  const groups = await quoteGroups(api, input.quoteId);
  if (groups.some(x => x.name.trim().toLowerCase() === name.toLowerCase())) return fail(`This quote already has a group named "${name}".`);
  const body: Record<string, unknown> = { Name: name, QuoteId: input.quoteId };
  if (input.description?.trim()) { if (can("Description")) body.Description = input.description.trim(); else warnings.push("Description isn't createable on QuoteLineGroup in this org — not saved."); }
  if (input.parentId) {
    if (!can("ParentQuoteLineGroupId")) return fail("ParentQuoteLineGroupId isn't createable in this org.");
    const parent = groups.find(x => x.id === input.parentId);
    if (!parent) return fail("The parent group isn't on this quote.");
    if (groupState(parent, groups) !== "unramped") return fail(`${parent.name} is part of an existing ramp — it can't be a parent here.`);
    body.ParentQuoteLineGroupId = input.parentId;
  }
  if (can("SortOrder")) body.SortOrder = Math.max(0, ...groups.map(x => x.sortOrder ?? 0)) + 1;
  const missing = (await requiredOnCreate(api, "QuoteLineGroup")).filter(f => !(f in body) && f !== "IsRamped");
  if (missing.length) return fail(`This org requires ${missing.join(", ")} on QuoteLineGroup, which this form doesn't collect.`);
  const r = await insert(api, "QuoteLineGroup", body, calls);
  if (!r.id) return fail(`Salesforce didn't create the group: ${r.error}`);
  const back = (await quoteGroups(api, input.quoteId)).find(x => x.id === r.id);
  if (!back) return { ok: false, message: `Salesforce returned Id ${r.id}, but the group couldn't be read back.`, record: null, calls, warnings };
  if (back.isRamped) warnings.push("Salesforce created the group as ramped — unexpected; check it before ramping.");
  return { ok: true, message: `Quote Line Group "${back.name}" created (${back.id}) on ${quote.name} and read back — IsRamped ${String(back.isRamped)}.`, record: { id: back.id, name: back.name, quoteId: back.quoteId, isRamped: back.isRamped, parentId: back.parentId, sortOrder: back.sortOrder, segmentType: back.segmentType, startDate: back.startDate, endDate: back.endDate }, calls, warnings };
}

/* ── Quote Line Items in a group ── */

/**
 * One line to add. `pricebookEntryId` is the selling-model choice (Salesforce derives the line's selling model from the entry);
 * `sellingModelId` alone is accepted too and resolved to the quote price book's entry for that selling model. `billingFrequency` is only
 * needed when the selling model's own pricing term can't be mapped to an active QuoteLineItem.BillingFrequency value.
 */
export interface AddLineInput { productId: string; pricebookEntryId?: string | null; sellingModelId?: string | null; quantity: number; billingFrequency?: string | null }
export interface LineCheck { field: string; expected: string | null; actual: string | null; passed: boolean }
export interface AddedLine {
  id: string; productId: string | null; productName: string | null; quantity: number | null; pricebookEntryId: string | null;
  sellingModelId: string | null; sellingModelType: string | null; billingFrequency: string | null; groupId: string | null; quoteId: string | null;
  startDate: string | null; endDate: string | null; checks: LineCheck[]; verified: boolean; groupRampEligible: boolean; groupRampReason: string | null;
}

interface PlannedLine { name: string; body: Record<string, unknown>; expect: { productId: string; pricebookEntryId: string; quantity: number; sellingModelId: string | null; billingFrequency: string | null }; groupRamp: { ok: boolean; reason: string | null } }

export async function addGroupLines(api: RampApi, input: { quoteId: string; groupId: string; items: AddLineInput[]; startDate?: string | null; endDate?: string | null }): Promise<BuilderResult<AddedLine[]>> {
  const calls: SalesforceCall[] = [], warnings: string[] = [];
  const fail = (message: string, record: AddedLine[] | null = null): BuilderResult<AddedLine[]> => ({ ok: false, message, record, calls, warnings });
  if (!input.items.length) return fail("Add at least one product.");
  if (input.items.length > 25) return fail("Add at most 25 products at a time.");
  for (const it of input.items) if (!(typeof it.quantity === "number" && Number.isFinite(it.quantity) && it.quantity > 0)) return fail("Every quantity must be more than zero.");
  if ((input.startDate && !isIsoDate(input.startDate)) || (input.endDate && !isIsoDate(input.endDate))) return fail("Start / end dates must be YYYY-MM-DD.");
  if (input.startDate && input.endDate && input.endDate < input.startDate) return fail("The end date is before the start date.");
  const quote = await quoteFacts(api, input.quoteId);
  if (!quote) return fail("The quote wasn't found.");
  if (quote.status !== "Draft") return fail(`Quote ${quote.name} is ${quote.status}; products are added to Draft quotes only here.`);
  if (!quote.pricebookId) return fail("The quote has no price book — set one on the quote first.");
  const groups = await quoteGroups(api, input.quoteId);
  const group = groups.find(g => g.id === input.groupId);
  if (!group) return fail("The group isn't on this quote.");
  const state = groupState(group, groups);
  if (state !== "unramped") return fail(`${group.name} is ${state === "ramp-segment" ? "a ramp segment" : "the container of an existing ramp"} — products can't be added to it here.`);
  const caps = await lineItemFieldCaps(api);
  for (const f of ["QuoteId", "Product2Id", "PricebookEntryId", "Quantity", "QuoteLineGroupId"]) if (!caps.createable(f)) return fail(`QuoteLineItem.${f} isn't createable for your user.`);

  // Validate EVERY line (product, price book entry, selling model, required subscription fields) BEFORE writing anything.
  const planned: PlannedLine[] = [];
  for (const it of input.items) {
    const product = await catalogProduct(api, it.productId, quote.pricebookId);
    if (!product) return fail(`Product ${it.productId} wasn't found.`);
    if (!product.quoteLine.ok && !product.options.length) return fail(`${product.name} can't be added: ${product.quoteLine.reason}`);
    let option = it.pricebookEntryId ? product.options.find(o => o.pricebookEntryId === it.pricebookEntryId) : undefined;
    if (it.pricebookEntryId && !option) return fail(`${product.name}: Price Book Entry ${it.pricebookEntryId} isn't an active entry of this product in the quote's price book.`);
    if (!option && it.sellingModelId) {
      const m = product.options.filter(o => o.sellingModelId === it.sellingModelId);
      if (!m.length) return fail(`${product.name} has no active Price Book Entry for ${product.offeredModels.find(x => x.id === it.sellingModelId)?.name ?? "that selling model"} in the quote's price book${product.offeredModels.some(x => x.id === it.sellingModelId) ? "" : " (it isn't one of the product's selling models)"}.`);
      option = m[0];
    }
    if (!option) {
      const usable = product.options.filter(o => o.usable);
      if (usable.length !== 1) return fail(`${product.name} has ${usable.length} usable Price Book Entries in this price book — choose the selling model.`);
      option = usable[0];
    }
    if (!option.usable) return fail(`${product.name}: ${option.reason}`);
    const sm = option.sellingModelId ? (await sellingModelDetails(api, [option.sellingModelId])).get(option.sellingModelId) ?? null : null;
    const fieldPlan = planSellingModelFields(sm, caps, { startDate: input.startDate, endDate: input.endDate, billingFrequency: it.billingFrequency });
    if (fieldPlan.errors.length) return fail(`${product.name}${sm ? ` (${sm.name})` : ""}: ${fieldPlan.errors.join(" ")}`);
    warnings.push(...fieldPlan.notes.map(n => `${product.name}: ${n}`));
    if (product.usageModelType) warnings.push(`${product.name} has UsageModelType ${product.usageModelType} — line ramps refuse it; group ramps have accepted Anchor products in p12.`);
    const body: Record<string, unknown> = { QuoteId: input.quoteId, QuoteLineGroupId: input.groupId, Product2Id: product.id, PricebookEntryId: option.pricebookEntryId, Quantity: it.quantity, ...fieldPlan.fields };
    if (caps.createable("UnitPrice") && option.unitPrice !== null) body.UnitPrice = option.unitPrice;
    const groupRamp = option.rampable ? { ok: true, reason: null } : { ok: false, reason: option.sellingModelType === "TermDefined" ? product.groupRamp.reason ?? "Not rampable." : `Quote line only — ${typeLabel(option.sellingModelType)} lines don't ramp (term-defined only).` };
    planned.push({ name: product.name, body, expect: { productId: product.id, pricebookEntryId: option.pricebookEntryId, quantity: it.quantity, sellingModelId: option.sellingModelId, billingFrequency: fieldPlan.billingFrequency.value }, groupRamp });
  }

  const created: { id: string; p: PlannedLine }[] = [];
  for (const p of planned) {
    const r = await insert(api, "QuoteLineItem", p.body, calls);
    if (!r.id) {
      const done = created.length ? await readLines(api, input, created) : [];
      return fail(`Salesforce refused ${p.name}: ${r.error}${created.length ? ` — ${created.length} line(s) were added before this (shown below); nothing was rolled back.` : ""}`, done);
    }
    created.push({ id: r.id, p });
  }
  const back = await readLines(api, input, created);
  const missingBack = created.filter(c => !back.some(b => b.id === c.id));
  if (missingBack.length) return { ok: false, message: `Salesforce created ${created.length} line(s) but ${missingBack.length} couldn't be read back.`, record: back, calls, warnings };
  const bad = back.filter(b => !b.verified);
  if (bad.length) return { ok: false, message: `${created.length} line(s) were created, but ${bad.length} don't match what was sent: ${bad.map(b => `${b.productName}: ${b.checks.filter(c => !c.passed).map(c => `${c.field} expected ${c.expected}, Salesforce has ${c.actual}`).join("; ")}`).join(" | ")}.`, record: back, calls, warnings };
  const quoteOnly = back.filter(b => !b.groupRampEligible);
  return { ok: true, message: `${back.length} line(s) added to ${group.name} and verified against Salesforce${quoteOnly.length ? ` — ${quoteOnly.length} can't take part in the group ramp (shown per line)` : ""}.`, record: back, calls, warnings };
}

/** Read the new lines back and compare every field that was sent with what Salesforce saved. */
async function readLines(api: RampApi, input: { quoteId: string; groupId: string }, created: { id: string; p: PlannedLine }[]): Promise<AddedLine[]> {
  const d = (await api.describe("QuoteLineItem")) as { fields?: { name: string }[] } | null;
  const cols = ["Id", "QuoteId", "Product2Id", "Product2.Name", "QuoteLineGroupId", "Quantity", "PricebookEntryId", "ProductSellingModelId", "SellingModelType", "BillingFrequency", "StartDate", "EndDate"].filter(c => c.includes(".") || !!d?.fields?.some(x => x.name === c));
  const rows = await api.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM QuoteLineItem WHERE Id IN (${created.map(c => soql(c.id)).join(",")})`);
  const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
  return created.map(({ id, p }): AddedLine | null => {
    const r = rows.find(x => x.Id === id);
    if (!r) return null;
    const checks: LineCheck[] = [];
    const chk = (field: string, expected: unknown, actual: unknown) => checks.push({ field, expected: s(expected), actual: s(actual), passed: s(expected) === s(actual) });
    chk("QuoteId", input.quoteId, r.QuoteId);
    chk("Product2Id", p.expect.productId, r.Product2Id);
    chk("QuoteLineGroupId", input.groupId, r.QuoteLineGroupId);
    chk("Quantity", p.expect.quantity, r.Quantity);
    chk("PricebookEntryId", p.expect.pricebookEntryId, r.PricebookEntryId);
    if ("ProductSellingModelId" in r) chk("ProductSellingModelId", p.expect.sellingModelId, r.ProductSellingModelId);
    if (p.expect.billingFrequency) chk("BillingFrequency", p.expect.billingFrequency, r.BillingFrequency);
    if (p.body.StartDate) chk("StartDate", p.body.StartDate, r.StartDate);
    if (p.body.EndDate) chk("EndDate", p.body.EndDate, r.EndDate);
    return {
      id, productId: s(r.Product2Id), productName: s((r.Product2 as { Name?: string } | null)?.Name) ?? p.name, quantity: typeof r.Quantity === "number" ? r.Quantity : null,
      pricebookEntryId: s(r.PricebookEntryId), sellingModelId: s(r.ProductSellingModelId), sellingModelType: s(r.SellingModelType), billingFrequency: s(r.BillingFrequency),
      groupId: s(r.QuoteLineGroupId), quoteId: s(r.QuoteId), startDate: s(r.StartDate), endDate: s(r.EndDate), checks, verified: checks.every(c => c.passed),
      groupRampEligible: p.groupRamp.ok, groupRampReason: p.groupRamp.reason,
    };
  }).filter((x): x is AddedLine => !!x);
}

/* ── read-only lookups for the builder ── */

export async function activePricebooks(api: RampApi) {
  const rows = await api.query<{ Id: string; Name: string; IsStandard: boolean }>("SELECT Id, Name, IsStandard FROM Pricebook2 WHERE IsActive = true ORDER BY IsStandard DESC, Name LIMIT 100");
  return rows.map(r => ({ id: r.Id, name: r.Name, isStandard: !!r.IsStandard }));
}
export async function accountOpportunities(api: RampApi, accountId: string) {
  const rows = await api.query<{ Id: string; Name: string; StageName: string | null }>(`SELECT Id, Name, StageName FROM Opportunity WHERE AccountId = ${soql(accountId)} AND IsClosed = false ORDER BY LastModifiedDate DESC LIMIT 50`);
  return rows.map(r => ({ id: r.Id, name: r.Name, stage: r.StageName ?? null }));
}
/** A product's real options in the quote's price book (one per active PricebookEntry), for "Add product". */
export async function productLineOptions(api: RampApi, productId: string, pricebookId: string | null) {
  const [product, caps] = await Promise.all([catalogProduct(api, productId, pricebookId), lineItemFieldCaps(api)]);
  return { product, billingFrequencyOptions: caps.billingFrequencyOptions };
}
