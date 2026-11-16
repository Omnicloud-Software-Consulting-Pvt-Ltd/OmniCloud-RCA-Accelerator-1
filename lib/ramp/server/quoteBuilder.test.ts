/**
 * Group Ramp quote builder (MOCKED Salesforce — fakeOrg, with p10/p12's verified createable / required fields): create quote, create
 * Quote Line Group, add products (PricebookEntry per selling model), read-back, refusals — and the full flow into a real group ramp
 * execution on a quote that ALREADY holds another ramp (verification must only look at this run's segments).
 * Passing here is NOT live Salesforce verification. Run: `npx tsx --test lib/ramp/server/quoteBuilder.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeOrg } from "./fakeOrg";
import { RampStore } from "./store";
import { accountOpportunities, activePricebooks, addGroupLines, createDraftQuote, createQuoteLineGroup, productLineOptions } from "./quoteBuilder";
import { saveDeal, startExecution, stepExecution } from "./service";
import { quoteGroups } from "./reads";
import { blankSchedule } from "@/lib/ramp/schedule";
import type { RunDeps } from "./runner";

const ACCT = "001A00000000001AAA", PB = "01sA00000000001AAA", PB_OFF = "01sA00000000002AAA";
const PROD = "01tA00000000001AAA", SUP = "01tA00000000002AAA", USE = "01tA00000000003AAA";
const YEARLY = "0jPA00000000001AAA", MONTHLY = "0jPA00000000002AAA", ONETIME = "0jPA00000000003AAA";
let clock = Date.parse("2026-11-10T10:00:00Z");
const deps: RunDeps = { now: () => new Date((clock += 1000)).toISOString(), sleep: async () => undefined, waitMs: 0 };

function seed() {
  return {
    Account: [{ Id: ACCT, Name: "Any Partner Inc" }, { Id: "001A00000000002AAA", Name: "Other" }],
    Opportunity: [{ Id: "006A00000000001AAA", Name: "Any Partner — Expansion", AccountId: ACCT, StageName: "Prospecting", IsClosed: false, LastModifiedDate: "2026-11-01" }, { Id: "006A00000000002AAA", Name: "Other deal", AccountId: "001A00000000002AAA", StageName: "Prospecting", IsClosed: false, LastModifiedDate: "2026-11-01" }],
    Pricebook2: [{ Id: PB, Name: "Standard Price Book", IsActive: true, IsStandard: true }, { Id: PB_OFF, Name: "Standard", IsActive: false, IsStandard: false }],
    Quote: [],
    Product2: [
      { Id: PROD, Name: "API Access Premium", IsActive: true, ProductCode: "API", CanRamp: true, UsageModelType: null, Type: null },
      { Id: SUP, Name: "Premium Support", IsActive: true, ProductCode: "SUP", CanRamp: true, UsageModelType: null, Type: null },
      { Id: USE, Name: "API Calls", IsActive: true, ProductCode: "USE", CanRamp: false, UsageModelType: "Anchor", Type: null },
    ],
    ProductSellingModel: [{ Id: YEARLY, Name: "Term-Based Yearly", SellingModelType: "TermDefined", Status: "Active" }, { Id: MONTHLY, Name: "Term-Based Monthly", SellingModelType: "TermDefined", Status: "Active" }, { Id: ONETIME, Name: "One Time", SellingModelType: "OneTime", Status: "Active" }],
    ProductSellingModelOption: [
      { Id: "0iO1", Product2Id: PROD, ProductSellingModelId: YEARLY }, { Id: "0iO2", Product2Id: PROD, ProductSellingModelId: MONTHLY },
      { Id: "0iO3", Product2Id: SUP, ProductSellingModelId: YEARLY }, { Id: "0iO4", Product2Id: SUP, ProductSellingModelId: ONETIME }, { Id: "0iO5", Product2Id: USE, ProductSellingModelId: YEARLY },
    ],
    PricebookEntry: [
      { Id: "01uA00000000001AAA", Pricebook2Id: PB, Product2Id: PROD, ProductSellingModelId: YEARLY, UnitPrice: 70, IsActive: true },
      { Id: "01uA00000000002AAA", Pricebook2Id: PB, Product2Id: PROD, ProductSellingModelId: MONTHLY, UnitPrice: 6, IsActive: true },
      { Id: "01uA00000000003AAA", Pricebook2Id: PB, Product2Id: SUP, ProductSellingModelId: YEARLY, UnitPrice: 200, IsActive: true },
      { Id: "01uA00000000004AAA", Pricebook2Id: PB, Product2Id: USE, ProductSellingModelId: YEARLY, UnitPrice: 1, IsActive: true },
    ],
    ProductRampSegment: [{ Id: "1FTA00000000001AAA", Name: "PPRS-1", ProductId: PROD, ProductSellingModelId: YEARLY, SegmentType: "Yearly", CreatedDate: "2026-11-01" }],
    QuoteLineGroup: [], QuoteLineItem: [],
  };
}

test("Create New Quote: Draft quote with Quote Account + Price Book, read back with Id and Quote Number", async () => {
  const o = fakeOrg(seed());
  const r = await createDraftQuote(o.api, { name: "Any Partner — Group Ramp", accountId: ACCT, pricebookId: PB, expirationDate: "2026-12-31", opportunityId: "006A00000000001AAA" });
  assert.equal(r.ok, true, r.message);
  assert.match(r.record!.id, /^0Q0/);
  assert.ok(r.record!.quoteNumber);
  assert.equal(r.record!.status, "Draft");
  assert.equal(r.record!.accountId, ACCT);
  const post = o.calls.find(c => c.method === "POST" && c.path === "/sobjects/Quote")!;
  assert.deepEqual(post.body, { Name: "Any Partner — Group Ramp", QuoteAccountId: ACCT, OpportunityId: "006A00000000001AAA", Pricebook2Id: PB, ExpirationDate: "2026-12-31" });
  assert.equal(o.calls.length, 1, "exactly one write");
  assert.equal(r.calls.length, 1);
});

test("Create New Quote refusals: no name, inactive price book, opportunity of another account, Salesforce error verbatim — no write", async () => {
  const o = fakeOrg(seed());
  assert.match((await createDraftQuote(o.api, { name: " ", accountId: ACCT, pricebookId: PB })).message, /Quote Name is required/);
  assert.match((await createDraftQuote(o.api, { name: "Q", accountId: ACCT, pricebookId: PB_OFF })).message, /inactive/);
  assert.match((await createDraftQuote(o.api, { name: "Q", accountId: ACCT, pricebookId: PB, opportunityId: "006A00000000002AAA" })).message, /different account/);
  assert.match((await createDraftQuote(o.api, { name: "Q", accountId: ACCT, pricebookId: PB, expirationDate: "31/12/2026" })).message, /YYYY-MM-DD/);
  assert.equal(o.calls.length, 0);
  const bad = fakeOrg(seed(), { rejectInsert: { Quote: "Validation rule: Quote needs an Opportunity" } });
  const r = await createDraftQuote(bad.api, { name: "Q", accountId: ACCT, pricebookId: PB });
  assert.equal(r.ok, false);
  assert.match(r.message, /Validation rule: Quote needs an Opportunity/);
});

test("Create New Quote Line Group: created on the Draft quote, read back un-ramped; duplicate name / ramped parent / non-Draft refused", async () => {
  const o = fakeOrg(seed());
  const q = (await createDraftQuote(o.api, { name: "Q1", accountId: ACCT, pricebookId: PB })).record!;
  const g = await createQuoteLineGroup(o.api, { quoteId: q.id, name: "Platform Ramp", description: "API products" });
  assert.equal(g.ok, true, g.message);
  assert.match(g.record!.id, /^1C9/);
  assert.equal(g.record!.isRamped, false);
  assert.deepEqual(o.calls.at(-1)!.body, { Name: "Platform Ramp", QuoteId: q.id, Description: "API products", SortOrder: 1 });
  assert.match((await createQuoteLineGroup(o.api, { quoteId: q.id, name: "platform ramp" })).message, /already has a group named/);
  o.store.QuoteLineGroup.push({ Id: "1C9RAMPED000001AAA", Name: "Seg", QuoteId: q.id, IsRamped: true, SortOrder: 5 });
  assert.match((await createQuoteLineGroup(o.api, { quoteId: q.id, name: "Child", parentId: "1C9RAMPED000001AAA" })).message, /part of an existing ramp/);
  o.store.Quote.find(x => x.Id === q.id)!.Status = "Approved";
  assert.match((await createQuoteLineGroup(o.api, { quoteId: q.id, name: "Late" })).message, /Draft quote/);
});

test("Add products: one line per product in the group, PricebookEntry chosen by selling model, dated, read back", async () => {
  const o = fakeOrg(seed());
  const q = (await createDraftQuote(o.api, { name: "Q", accountId: ACCT, pricebookId: PB })).record!;
  const g = (await createQuoteLineGroup(o.api, { quoteId: q.id, name: "G" })).record!;
  const r = await addGroupLines(o.api, { quoteId: q.id, groupId: g.id, items: [{ productId: PROD, sellingModelId: MONTHLY, quantity: 10 }, { productId: SUP, sellingModelId: YEARLY, quantity: 2 }], startDate: "2027-01-01", endDate: "2029-12-31" });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.record!.length, 2);
  assert.ok(r.record!.every(x => x.groupId === g.id));
  const inserts = o.calls.filter(c => c.path === "/sobjects/QuoteLineItem").map(c => c.body as Record<string, unknown>);
  assert.equal(inserts[0].PricebookEntryId, "01uA00000000002AAA", "the Monthly entry, not the first entry of the product");
  assert.deepEqual(inserts[0], { QuoteId: q.id, QuoteLineGroupId: g.id, Product2Id: PROD, PricebookEntryId: "01uA00000000002AAA", Quantity: 10, BillingFrequency: "Monthly", StartDate: "2027-01-01", EndDate: "2029-12-31", PeriodBoundary: "Anniversary", UnitPrice: 6 });
  assert.equal(inserts[1].BillingFrequency, "Annual", "Billing Frequency follows each line's own selling model");
  assert.ok(r.record!.every(x => x.verified), "every sent field read back");
  assert.equal(r.record![0].sellingModelId, MONTHLY, "read back: Salesforce derived the selling model from the entry");
  assert.ok(!("ProductSellingModelId" in inserts[0]), "ProductSellingModelId isn't createable — never sent");
});

test("Add products refusals: selling model not offered, no Price Book Entry, usage product, ramped group, quote without price book — nothing written", async () => {
  const o = fakeOrg(seed());
  const q = (await createDraftQuote(o.api, { name: "Q", accountId: ACCT, pricebookId: PB })).record!;
  const g = (await createQuoteLineGroup(o.api, { quoteId: q.id, name: "G" })).record!;
  const before = o.calls.length;
  assert.match((await addGroupLines(o.api, { quoteId: q.id, groupId: g.id, items: [{ productId: SUP, sellingModelId: MONTHLY, quantity: 1 }] })).message, /isn't one of the product's selling models/);
  assert.match((await addGroupLines(o.api, { quoteId: q.id, groupId: g.id, items: [{ productId: SUP, sellingModelId: ONETIME, quantity: 1 }] })).message, /no active Price Book Entry for One Time/);
  assert.match((await addGroupLines(o.api, { quoteId: q.id, groupId: g.id, items: [{ productId: PROD, sellingModelId: YEARLY, quantity: 0 }] })).message, /more than zero/);
  o.store.QuoteLineGroup.find(x => x.Id === g.id)!.IsRamped = true;
  assert.match((await addGroupLines(o.api, { quoteId: q.id, groupId: g.id, items: [{ productId: PROD, sellingModelId: YEARLY, quantity: 1 }] })).message, /a ramp segment/);
  const nopb = (await createDraftQuote(o.api, { name: "No PB", accountId: ACCT, pricebookId: null })).record!;
  const g2 = (await createQuoteLineGroup(o.api, { quoteId: nopb.id, name: "G" })).record!;
  assert.match((await addGroupLines(o.api, { quoteId: nopb.id, groupId: g2.id, items: [{ productId: PROD, sellingModelId: YEARLY, quantity: 1 }] })).message, /no price book/);
  assert.equal(o.calls.filter((c, i) => i >= before && c.path === "/sobjects/QuoteLineItem").length, 0);
});

test("Add products: a Salesforce refusal mid-way reports the lines already created (read back), nothing hidden", async () => {
  const o = fakeOrg(seed());
  const q = (await createDraftQuote(o.api, { name: "Q", accountId: ACCT, pricebookId: PB })).record!;
  const g = (await createQuoteLineGroup(o.api, { quoteId: q.id, name: "G" })).record!;
  o.store.PricebookEntry.find(e => e.Id === "01uA00000000003AAA")!.Product2Id = "01tWRONG0000000AAA"; // Salesforce will refuse the 2nd line
  o.store.PricebookEntry.push({ Id: "01uA00000000009AAA", Pricebook2Id: PB, Product2Id: SUP, ProductSellingModelId: YEARLY, UnitPrice: 200, IsActive: false });
  const fresh = fakeOrg({ ...seed(), Quote: o.store.Quote, QuoteLineGroup: o.store.QuoteLineGroup, PricebookEntry: [...seed().PricebookEntry] }, { rejectInsert: {} });
  const r = await addGroupLines(fresh.api, { quoteId: q.id, groupId: g.id, items: [{ productId: PROD, sellingModelId: YEARLY, quantity: 1 }, { productId: SUP, sellingModelId: YEARLY, quantity: 1 }], startDate: "2027-01-01", endDate: "2027-12-31" });
  assert.equal(r.ok, true, "control: both lines are fine in a healthy org");
  const broken = fakeOrg({ ...seed(), Quote: o.store.Quote, QuoteLineGroup: o.store.QuoteLineGroup });
  let n = 0;
  const api = { ...broken.api, call: async (m: "GET" | "POST" | "PATCH" | "DELETE", p: string, b?: unknown) => (p === "/sobjects/QuoteLineItem" && ++n === 2 ? { status: 400, body: [{ errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: "Billing Treatment required" }] } : broken.api.call(m, p, b)) };
  const partial = await addGroupLines(api, { quoteId: q.id, groupId: g.id, items: [{ productId: PROD, sellingModelId: YEARLY, quantity: 1 }, { productId: SUP, sellingModelId: YEARLY, quantity: 1 }], startDate: "2027-01-01", endDate: "2027-12-31" });
  assert.equal(partial.ok, false);
  assert.match(partial.message, /Billing Treatment required — 1 line\(s\) were added before this/);
  assert.equal(partial.record?.length, 1);
});

test("Add products: a usage (Anchor) product is added with a warning — Salesforce group-ramped Anchor products in p12", async () => {
  const o = fakeOrg(seed());
  const q = (await createDraftQuote(o.api, { name: "Q", accountId: ACCT, pricebookId: PB })).record!;
  const g = (await createQuoteLineGroup(o.api, { quoteId: q.id, name: "G" })).record!;
  const r = await addGroupLines(o.api, { quoteId: q.id, groupId: g.id, items: [{ productId: USE, sellingModelId: YEARLY, quantity: 1 }], startDate: "2027-01-01", endDate: "2027-12-31" });
  assert.equal(r.ok, true, r.message);
  assert.ok(r.warnings.some(w => /UsageModelType Anchor/.test(w)));
});

test("read-only lookups: active price books, the account's open opportunities, selling models with price book entries", async () => {
  const o = fakeOrg(seed());
  assert.deepEqual((await activePricebooks(o.api)).map(p => p.name), ["Standard Price Book"]);
  assert.deepEqual((await accountOpportunities(o.api, ACCT)).map(x => x.name), ["Any Partner — Expansion"]);
  const opts = await productLineOptions(o.api, SUP, PB);
  assert.deepEqual(opts.product!.options.map(m => [m.sellingModelName, m.sellingModelType, m.pricebookEntryId, m.billingFrequency]), [["Term-Based Yearly", "TermDefined", "01uA00000000003AAA", "Annual"]]);
  assert.deepEqual(opts.product!.offeredModels.map(m => m.name), ["Term-Based Yearly", "One Time"], "offered models are listed even without a price");
  assert.ok(opts.billingFrequencyOptions.some(x => x.value === "Annual"));
  assert.equal(o.calls.length, 0, "lookups never write");
});

test("END TO END (mocked, org allowing several ramp schedules like p12 #40): new quote → group → product → group ramp; only THIS ramp verified", async () => {
  const o = fakeOrg(seed(), { now: deps.now, multipleRampSchedules: true });
  const q = (await createDraftQuote(o.api, { name: "E2E", accountId: ACCT, pricebookId: PB })).record!;
  // an existing ramp already on this quote (chain shape, as in p12)
  o.store.QuoteLineGroup.push({ Id: "1C9OLD0000000001AAA".slice(0, 18), Name: "Old Ramp", QuoteId: q.id, IsRamped: true, SegmentType: "Yearly", SortOrder: 1, StartDate: "2026-01-01", EndDate: "2026-12-31", ParentQuoteLineGroupId: null });
  o.store.QuoteLineItem.push({ Id: "0QLOLD000000001AAA", QuoteId: q.id, QuoteLineGroupId: "1C9OLD0000000001AA", Product2Id: SUP, ProductSellingModelId: YEARLY, SellingModelType: "TermDefined", Quantity: 1, UnitPrice: 200, StartDate: "2026-01-01", EndDate: "2026-12-31", RampIdentifier: "RDIOLD", PeriodBoundary: "Anniversary", CreatedDate: "2026-01-01" });
  const g = (await createQuoteLineGroup(o.api, { quoteId: q.id, name: "New Ramp" })).record!;
  const added = await addGroupLines(o.api, { quoteId: q.id, groupId: g.id, items: [{ productId: PROD, sellingModelId: YEARLY, quantity: 5 }], startDate: "2027-01-01", endDate: "2029-12-31" });
  assert.equal(added.ok, true, added.message);

  const ctx = { store: new RampStore(fs.mkdtempSync(path.join(os.tmpdir(), "rampqb-"))), orgId: "00Dg500000KSpiPEAT", userId: null };
  const { id: _i, createdAt: _c, updatedAt: _u, createdBy: _b, version: _v, ...schedule } = { ...blankSchedule(), name: "3y compound", period: "Yearly" as const, segments: 3, defaultChange: 10, upliftMethod: "Compound" as const };
  void _i; void _c; void _u; void _b; void _v;
  const deal = await saveDeal(ctx, { kind: "group", name: "E2E group", accountId: ACCT, quoteId: q.id, quoteName: q.name, groupId: g.id, groupName: g.name, contractStart: "2027-01-01", contractEnd: "2029-12-31", basePrice: 70, baseQuantity: 5, schedule, periodBoundary: "Anniversary" });
  let ex = await startExecution(ctx, deal.id, true);
  for (let i = 0; i < 40 && ex.status !== "completed" && ex.status !== "failed"; i++) ex = await stepExecution(ctx, o.api, ex.id, deps);
  assert.equal(ex.status, "completed", ex.steps.find(s => s.status === "failed")?.message ?? "");
  assert.equal(ex.sf.segmentGroupIds.length, 3, "only THIS ramp's 3 segments — the old ramp isn't counted");
  assert.ok(!ex.sf.segmentGroupIds.includes("1C9OLD0000000001AA"));
  assert.equal(ex.sf.segmentGroupIds[0], g.id, "segment 1 is the group the user created");
  const ridCheck = ex.verification.filter(c => c.id.startsWith("ramp-id-"));
  assert.equal(ridCheck.length, 1);
  assert.equal(ridCheck[0].passed, true);
  assert.ok(ex.verification.every(c => c.passed || c.severity === "info"));
  assert.deepEqual(ex.segments.map(s => s.netUnitPrice), [70, 77, 84.7], "compound uplift priced and saved");
  const finalGroups = await quoteGroups(o.api, q.id);
  assert.equal(finalGroups.find(x => x.id === "1C9OLD0000000001AA")?.isRamped, true, "the other ramp is untouched");
  assert.ok(o.calls.some(c => c.path === "/connect/rev/sales-transaction/actions/clone"), "segments created with Clone Sales Transaction");
  assert.ok(o.calls.some(c => (c.body as { groupRampAction?: string })?.groupRampAction === "EditGroup"), "segment 1 via groupRampAction EditGroup");
});

test("default org (single ramp schedule per quote, per the dev guide): converting a 2nd group is refused verbatim, nothing else written", async () => {
  const o = fakeOrg(seed(), { now: deps.now });
  const q = (await createDraftQuote(o.api, { name: "One schedule", accountId: ACCT, pricebookId: PB })).record!;
  o.store.QuoteLineGroup.push({ Id: "1C9OLD0000000001AA", Name: "Old Ramp", QuoteId: q.id, IsRamped: true, SegmentType: "Yearly", SortOrder: 1, StartDate: "2026-01-01", EndDate: "2026-12-31", ParentQuoteLineGroupId: null });
  const g = (await createQuoteLineGroup(o.api, { quoteId: q.id, name: "Second" })).record!;
  assert.equal((await addGroupLines(o.api, { quoteId: q.id, groupId: g.id, items: [{ productId: PROD, sellingModelId: YEARLY, quantity: 1 }], startDate: "2027-01-01", endDate: "2029-12-31" })).ok, true);
  const ctx = { store: new RampStore(fs.mkdtempSync(path.join(os.tmpdir(), "rampqb1-"))), orgId: "00Dg500000KSpiPEAT", userId: null };
  const { id: _i, createdAt: _c, updatedAt: _u, createdBy: _b, version: _v, ...schedule } = { ...blankSchedule(), name: "3y", period: "Yearly" as const, segments: 3, defaultChange: 5 };
  void _i; void _c; void _u; void _b; void _v;
  const deal = await saveDeal(ctx, { kind: "group", name: "Second ramp", accountId: ACCT, quoteId: q.id, quoteName: q.name, groupId: g.id, groupName: g.name, contractStart: "2027-01-01", contractEnd: "2029-12-31", basePrice: 70, baseQuantity: 1, schedule, periodBoundary: "Anniversary" });
  let ex = await startExecution(ctx, deal.id, true);
  for (let i = 0; i < 20 && ex.status !== "completed" && ex.status !== "failed"; i++) ex = await stepExecution(ctx, o.api, ex.id, deps);
  assert.equal(ex.status, "failed");
  assert.match(ex.steps.find(s2 => s2.status === "failed")!.message!, /You can’t convert a group to a ramped segment when the .* has a ramp schedule/);
  assert.ok(!o.calls.some(c => c.path.endsWith("/clone")), "no clone after a refused conversion");
});
