/**
 * Group Ramp product catalog + universal Quote Line Item creation (MOCKED Salesforce — fakeOrg, shaped like p12 as read on 2026-11-10:
 * selling models with PricingTermUnit, QuoteLineItem.BillingFrequency picklist, Salesforce's own "BillingFrequency can't be null"
 * rule for Term-Defined / Evergreen lines). Passing here is NOT live Salesforce verification.
 * Run: `npx tsx --test lib/ramp/server/lineItems.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeOrg } from "./fakeOrg";
import { searchCatalog, catalogProduct } from "./catalog";
import { addGroupLines, createDraftQuote, createQuoteLineGroup } from "./quoteBuilder";
import { groupRampDiagnostics } from "@/lib/ramp/groupDiagnostics";
import { productFacts, quoteFacts, quoteGroups, quoteLines } from "./reads";
import { billingFrequencyFor, planSellingModelFields, type LineItemFieldCaps } from "@/lib/quotes/lineItem/sellingModelFields";

const ACCT = "001A00000000001AAA", PB = "01sA00000000001AAA", PB2 = "01sA00000000002AAA";
const psm = (id: string, Name: string, SellingModelType: string, PricingTermUnit: string | null, Status = "Active") => ({ Id: id, Name, SellingModelType, Status, PricingTerm: PricingTermUnit ? 1 : null, PricingTermUnit });
const M = { ONE: "0jPA0000000000ONE", YR: "0jPA00000000000YR", MO: "0jPA00000000000MO", QT: "0jPA00000000000QT", EVY: "0jPA0000000000EVY", ODD: "0jPA0000000000ODD", OFF: "0jPA0000000000OFF" };
const P = { LAPTOP: "01tA000000LAPTOPAA", DESKTOP: "01tA00000DESKTOPAA", MONITOR: "01tA00000MONITORAA", WARRANTY: "01tA0000WARRANTYAA", API: "01tA000000000APIAA", VAULT: "01tA0000000VAULTAA", AV: "01tA00000000000AVA", REG: "01tA0000000000REGA", BILLSVC: "01tA00000BILLSVCAA", MOBILE: "01tA000000MOBILEAA", BRAZIL: "01tA000000BRAZILAA", ODD: "01tA00000000000ODD", RETIRED: "01tA00000RETIREDAA" };
const prod = (Id: string, Name: string, ProductCode: string | null, o: Record<string, unknown> = {}) => ({ Id, Name, ProductCode, IsActive: true, CanRamp: false, UsageModelType: null, Type: null, ...o });
const pbe = (Id: string, Product2Id: string, ProductSellingModelId: string | null, UnitPrice: number, Pricebook2Id = PB, IsActive = true) => ({ Id, Pricebook2Id, Product2Id, ProductSellingModelId, UnitPrice, IsActive });
const opt = (Product2Id: string, ProductSellingModelId: string) => ({ Id: `0iO${Product2Id.slice(4, 10)}${ProductSellingModelId.slice(-3)}`, Product2Id, ProductSellingModelId });

function seed() {
  return {
    Account: [{ Id: ACCT, Name: "Any Partner Inc" }],
    Pricebook2: [{ Id: PB, Name: "Standard Price Book", IsActive: true, IsStandard: true }, { Id: PB2, Name: "Nonprofit", IsActive: true, IsStandard: false }],
    Quote: [], QuoteLineGroup: [], QuoteLineItem: [], ProductRampSegment: [{ Id: "1FTA0000000000WARR", Name: "PPRS-W", ProductId: P.WARRANTY, ProductSellingModelId: M.YR, SegmentType: "Yearly", CreatedDate: "2026-10-01" }],
    ProductSellingModel: [psm(M.ONE, "One Time", "OneTime", null), psm(M.YR, "Term Based - Yearly", "TermDefined", "Annual"), psm(M.MO, "Term Based - Monthly", "TermDefined", "Months"), psm(M.QT, "Term Based - Quarterly", "TermDefined", "Quarterly"), psm(M.EVY, "Evergreen - Yearly", "Evergreen", "Annual"), psm(M.ODD, "Partner Plan", "TermDefined", null), psm(M.OFF, "Legacy Term", "TermDefined", "Annual", "Inactive")],
    Product2: [
      prod(P.LAPTOP, "Laptop", "LP001"), prod(P.DESKTOP, "Desktop", "DS001"), prod(P.MONITOR, "Monitor", "MO001"),
      prod(P.WARRANTY, "Warranty", "W001", { CanRamp: true }), prod(P.API, "API Access Premium", "CLOUD00910", { CanRamp: true, UsageModelType: "Anchor" }),
      prod(P.VAULT, "OmniCloud DataVault Premium Storage", "OC-DATAVAULT-003"), prod(P.AV, "Antivirus", "AV001"), prod(P.REG, "Registers", "REG01"),
      prod(P.BILLSVC, "Billing Service", null), prod(P.MOBILE, "Mobile Plan", "PROD994"), prod(P.BRAZIL, "Brazil Laptop", "BRAZIL_LAPTOP"), prod(P.ODD, "Partner Bundle", "PB-1"),
      prod(P.RETIRED, "Retired Gadget", "RG-1", { IsActive: false }),
    ],
    ProductSellingModelOption: [opt(P.LAPTOP, M.ONE), opt(P.DESKTOP, M.ONE), opt(P.MONITOR, M.ONE), opt(P.WARRANTY, M.YR), opt(P.API, M.YR), opt(P.API, M.MO), opt(P.VAULT, M.QT), opt(P.AV, M.EVY), opt(P.REG, M.ONE), opt(P.REG, M.YR), opt(P.BRAZIL, M.ONE), opt(P.ODD, M.ODD), opt(P.ODD, M.OFF)],
    PricebookEntry: [
      pbe("01uA00000000LAPTOP", P.LAPTOP, M.ONE, 1049), pbe("01uA0000000DESKTOP", P.DESKTOP, M.ONE, 1149), pbe("01uA0000000MONITOR", P.MONITOR, M.ONE, 144.99),
      pbe("01uA000000WARRANTY", P.WARRANTY, M.YR, 49.99), pbe("01uA000000000APIYR", P.API, M.YR, 70), pbe("01uA000000000APIMO", P.API, M.MO, 75),
      pbe("01uA00000000000VLT", P.VAULT, M.QT, 7499), pbe("01uA000000000000AV", P.AV, M.EVY, 99.99), pbe("01uA000000000REG1T", P.REG, M.ONE, 10000), pbe("01uA000000000REGYR", P.REG, M.YR, 10000),
      pbe("01uA0000000MOBILEX", P.MOBILE, null, 25), pbe("01uA0000000BRAZILX", P.BRAZIL, M.ONE, 999, PB2), pbe("01uA000000000ODDXX", P.ODD, M.ODD, 300), pbe("01uA000000000OFFXX", P.ODD, M.OFF, 280),
      pbe("01uA00000000LAPOLD", P.LAPTOP, M.ONE, 999, PB, false),
    ],
  };
}

async function setup() {
  const o = fakeOrg(seed());
  const q = (await createDraftQuote(o.api, { name: "Line test", accountId: ACCT, pricebookId: PB })).record!;
  const g = (await createQuoteLineGroup(o.api, { quoteId: q.id, name: "Ramp group" })).record!;
  return { o, q, g, base: { quoteId: q.id, groupId: g.id, startDate: "2027-01-01", endDate: "2029-12-31" } };
}
const body = (o: ReturnType<typeof fakeOrg>, n = -1) => o.calls.filter(c => c.path === "/sobjects/QuoteLineItem").at(n)!.body as Record<string, unknown>;

/* ── shared field plan (pure) ── */

const caps: LineItemFieldCaps = { createable: () => true, billingFrequencyOptions: ["MilestonePlan", "Weekly", "Monthly", "Quarterly", "Semi-Annual", "Annual"].map(v => ({ value: v, label: v })), periodBoundaryOptions: ["AlignToCalendar", "Anniversary", "DayOfPeriod", "LastDayOfPeriod"] };
const sm = (type: string, unit: string | null, name = "SM") => ({ id: "x", name, type, status: "Active", pricingTermUnit: unit, pricingTerm: 1 });

test("Billing Frequency comes from the selling model's pricing term (then its name), mapped to ACTIVE picklist values — no fixed table", () => {
  assert.equal(billingFrequencyFor(sm("TermDefined", "Annual"), caps.billingFrequencyOptions)?.value, "Annual");
  assert.equal(billingFrequencyFor(sm("TermDefined", "Months"), caps.billingFrequencyOptions)?.value, "Monthly");
  assert.equal(billingFrequencyFor(sm("TermDefined", "Quarterly"), caps.billingFrequencyOptions)?.value, "Quarterly");
  assert.equal(billingFrequencyFor(sm("TermDefined", "Semi-Annual"), caps.billingFrequencyOptions)?.value, "Semi-Annual", "never misread as Annual");
  assert.deepEqual(billingFrequencyFor(sm("TermDefined", null, "Plan - Monthly"), caps.billingFrequencyOptions), { value: "Monthly", source: "selling-model-name" });
  assert.equal(billingFrequencyFor(sm("TermDefined", "Annual"), [{ value: "Monthly", label: "Monthly" }]), null, "Annual isn't active in that org → not invented");
});

test("field plan per selling-model type: One-Time sends nothing extra; Term-Defined sends BF + start + end; Evergreen sends BF + start, no end", () => {
  const dates = { startDate: "2027-01-01", endDate: "2029-12-31" };
  assert.deepEqual(planSellingModelFields(sm("OneTime", null), caps, dates).fields, {});
  assert.deepEqual(planSellingModelFields(sm("TermDefined", "Annual"), caps, dates).fields, { BillingFrequency: "Annual", StartDate: "2027-01-01", EndDate: "2029-12-31", PeriodBoundary: "Anniversary" });
  const ev = planSellingModelFields(sm("Evergreen", "Annual"), caps, dates);
  assert.deepEqual(ev.fields, { BillingFrequency: "Annual", StartDate: "2027-01-01", PeriodBoundary: "Anniversary" });
  assert.ok(ev.notes.some(n => /open-ended/.test(n)));
  assert.deepEqual(planSellingModelFields(sm("OneTime", null), caps, { ...dates, billingFrequency: "Annual" }).fields, {}, "a One-Time line never gets a subscription Billing Frequency");
  assert.ok(planSellingModelFields(sm("TermDefined", "Annual"), caps, {}).errors.some(e => /start date/.test(e)));
  assert.ok(planSellingModelFields(sm("TermDefined", "Annual"), { ...caps, createable: f => f !== "BillingFrequency" }, dates).errors.some(e => /isn't createable/.test(e)));
  assert.ok(planSellingModelFields({ ...sm("TermDefined", "Annual"), status: "Inactive" }, caps, dates).errors.some(e => /Inactive/.test(e)));
  assert.ok(planSellingModelFields(sm("TermDefined", null, "Partner Plan"), caps, dates).errors.some(e => /can't be resolved/.test(e)));
  assert.equal(planSellingModelFields(sm("TermDefined", null, "Partner Plan"), caps, { ...dates, billingFrequency: "Quarterly" }).fields.BillingFrequency, "Quarterly");
  assert.ok(planSellingModelFields(sm("TermDefined", "Annual"), caps, { ...dates, billingFrequency: "Fortnightly" }).errors.some(e => /isn't an active/.test(e)));
});

/* ── catalog ── */

test("catalog shows EVERY active product (One-Time, Term-Defined, Evergreen, no selling model) once, never rampable-only", async () => {
  const o = fakeOrg(seed());
  const all = await searchCatalog(o.api, { pricebookId: PB, pageSize: 100 });
  const names = all.rows.map(r => r.name);
  for (const n of ["Laptop", "Desktop", "Monitor", "Warranty", "Antivirus", "OmniCloud DataVault Premium Storage", "Registers", "Billing Service", "Mobile Plan", "Brazil Laptop"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes("Retired Gadget"), "inactive products are not offered");
  assert.equal(new Set(all.rows.map(r => r.id)).size, all.rows.length, "no duplicates from several selling models / entries");
  const reg = all.rows.find(r => r.name === "Registers")!;
  assert.deepEqual(reg.options.map(x => x.sellingModelType).sort(), ["OneTime", "TermDefined"], "both selling models offered");
  assert.equal(all.rows.find(r => r.name === "Laptop")!.options.length, 1, "the inactive Laptop entry isn't offered");
  assert.equal(o.calls.length, 0, "read-only");
});

test("catalog verdicts keep Quote Line creation and Group Ramp separate", async () => {
  const o = fakeOrg(seed());
  const rows = (await searchCatalog(o.api, { pricebookId: PB, pageSize: 100 })).rows;
  const by = (n: string) => rows.find(r => r.name === n)!;
  assert.deepEqual([by("Laptop").quoteLine.ok, by("Laptop").groupRamp.ok], [true, false]);
  assert.match(by("Laptop").groupRamp.reason!, /Quote line only — One-Time lines don't ramp/);
  assert.deepEqual([by("Warranty").quoteLine.ok, by("Warranty").groupRamp.ok], [true, true]);
  assert.deepEqual([by("OmniCloud DataVault Premium Storage").quoteLine.ok, by("OmniCloud DataVault Premium Storage").groupRamp.ok], [true, false]);
  assert.match(by("OmniCloud DataVault Premium Storage").groupRamp.reason!, /not rampable yet/);
  assert.deepEqual([by("Antivirus").quoteLine.ok, by("Antivirus").groupRamp.ok], [true, false]);
  assert.equal(by("Billing Service").quoteLine.ok, false);
  assert.match(by("Billing Service").quoteLine.reason!, /no selling model is set up/);
  assert.equal(by("Brazil Laptop").quoteLine.ok, false);
  assert.match(by("Brazil Laptop").quoteLine.reason!, /No active Price Book Entry in this price book \(selling models offered: One Time\)/);
  assert.equal(by("Mobile Plan").quoteLine.ok, true, "an entry without a selling model is still a valid quote line");
  assert.equal(by("API Access Premium").options.find(x => x.sellingModelName === "Term Based - Monthly")!.billingFrequency, "Monthly");
  const odd = by("Partner Bundle");
  assert.equal(odd.options.find(x => x.sellingModelName === "Partner Plan")!.billingFrequency, null, "unresolvable → user must choose");
  assert.equal(odd.options.find(x => x.sellingModelName === "Legacy Term")!.usable, false);
});

test("catalog search: name, ProductCode, Id; server-side paging without overlap; price-book-only filter", async () => {
  const o = fakeOrg(seed());
  assert.deepEqual((await searchCatalog(o.api, { q: "laptop", pricebookId: PB })).rows.map(r => r.name), ["Brazil Laptop", "Laptop"]);
  assert.deepEqual((await searchCatalog(o.api, { q: "MO001", pricebookId: PB })).rows.map(r => r.name), ["Monitor"]);
  assert.deepEqual((await searchCatalog(o.api, { q: P.DESKTOP, pricebookId: PB })).rows.map(r => r.name), ["Desktop"]);
  const p1 = await searchCatalog(o.api, { pricebookId: PB, pageSize: 5, page: 1 }), p2 = await searchCatalog(o.api, { pricebookId: PB, pageSize: 5, page: 2 });
  assert.equal(p1.rows.length, 5); assert.equal(p1.hasMore, true);
  assert.ok(!p1.rows.some(r => p2.rows.some(x => x.id === r.id)));
  const priced = await searchCatalog(o.api, { pricebookId: PB, pageSize: 100, inPricebookOnly: true });
  assert.ok(!priced.rows.some(r => r.name === "Billing Service" || r.name === "Brazil Laptop"));
  const noPb = await searchCatalog(o.api, { pricebookId: null, pageSize: 100 });
  assert.ok(noPb.rows.every(r => !r.quoteLine.ok && /no price book/.test(r.quoteLine.reason!)));
});

/* ── universal Quote Line Item creation ── */

test("One-Time (Laptop, Desktop, Monitor): no Billing Frequency, no dates, in the group, read back", async () => {
  const { o, g, base } = await setup();
  const r = await addGroupLines(o.api, { ...base, items: [{ productId: P.LAPTOP, quantity: 2 }, { productId: P.DESKTOP, quantity: 1 }, { productId: P.MONITOR, quantity: 3 }] });
  assert.equal(r.ok, true, r.message);
  for (let i = 1; i <= 3; i++) { const b = body(o, -i); assert.equal(b.BillingFrequency, undefined); assert.equal(b.StartDate, undefined); assert.equal(b.QuoteLineGroupId, g.id); }
  assert.deepEqual(r.record!.map(l => [l.productName, l.sellingModelType, l.billingFrequency, l.verified, l.groupRampEligible]), [["Laptop", "OneTime", null, true, false], ["Desktop", "OneTime", null, true, false], ["Monitor", "OneTime", null, true, false]]);
  assert.match(r.message, /3 can't take part in the group ramp/);
});

test("Term-Defined Yearly / Monthly / Quarterly: Billing Frequency from each selling model's pricing term, dated, verified", async () => {
  const { o, base } = await setup();
  const r = await addGroupLines(o.api, { ...base, items: [{ productId: P.WARRANTY, quantity: 1 }, { productId: P.API, pricebookEntryId: "01uA000000000APIMO", quantity: 5 }, { productId: P.VAULT, quantity: 1 }] });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.record!.map(l => [l.productName, l.billingFrequency, l.startDate, l.endDate, l.verified]), [["Warranty", "Annual", "2027-01-01", "2029-12-31", true], ["API Access Premium", "Monthly", "2027-01-01", "2029-12-31", true], ["OmniCloud DataVault Premium Storage", "Quarterly", "2027-01-01", "2029-12-31", true]]);
  const checks = r.record![0].checks.map(c => c.field);
  for (const f of ["QuoteId", "Product2Id", "QuoteLineGroupId", "Quantity", "PricebookEntryId", "ProductSellingModelId", "BillingFrequency"]) assert.ok(checks.includes(f), f);
  assert.deepEqual(r.record!.map(l => l.groupRampEligible), [true, true, false], "DataVault is a valid line but not rampable");
});

test("Evergreen (Antivirus): Billing Frequency + start date, no end date", async () => {
  const { o, base } = await setup();
  const r = await addGroupLines(o.api, { ...base, items: [{ productId: P.AV, quantity: 1 }] });
  assert.equal(r.ok, true, r.message);
  assert.equal(body(o).BillingFrequency, "Annual");
  assert.equal(body(o).EndDate, undefined);
  assert.equal(r.record![0].sellingModelType, "Evergreen");
  assert.ok(r.warnings.some(w => /open-ended/.test(w)));
});

test("multiple selling models / entries: the chosen entry decides; without a choice it asks instead of guessing", async () => {
  const { o, base } = await setup();
  const none = await addGroupLines(o.api, { ...base, items: [{ productId: P.REG, quantity: 1 }] });
  assert.match(none.message, /Registers has 2 usable Price Book Entries in this price book — choose the selling model/);
  const one = await addGroupLines(o.api, { ...base, items: [{ productId: P.REG, pricebookEntryId: "01uA000000000REG1T", quantity: 1 }, { productId: P.REG, sellingModelId: M.YR, quantity: 1 }] });
  assert.equal(one.ok, true, one.message);
  assert.deepEqual(one.record!.map(l => [l.pricebookEntryId, l.sellingModelType, l.billingFrequency]), [["01uA000000000REG1T", "OneTime", null], ["01uA000000000REGYR", "TermDefined", "Annual"]]);
});

test("product not in the quote's price book, entry of another price book, no selling model + no entry: refused before any write", async () => {
  const { o, base } = await setup();
  const before = o.calls.length;
  assert.match((await addGroupLines(o.api, { ...base, items: [{ productId: P.BRAZIL, quantity: 1 }] })).message, /Brazil Laptop can't be added: No active Price Book Entry in this price book/);
  assert.match((await addGroupLines(o.api, { ...base, items: [{ productId: P.BRAZIL, pricebookEntryId: "01uA0000000BRAZILX", quantity: 1 }] })).message, /isn't an active entry of this product in the quote's price book|can't be added/);
  assert.match((await addGroupLines(o.api, { ...base, items: [{ productId: P.BILLSVC, quantity: 1 }] })).message, /no selling model is set up/);
  assert.match((await addGroupLines(o.api, { ...base, items: [{ productId: P.LAPTOP, pricebookEntryId: "01uA00000000LAPOLD", quantity: 1 }] })).message, /isn't an active entry/);
  assert.equal(o.calls.length, before, "no write was sent");
});

test("Billing Frequency unresolvable: blocked with the active values; resolved by the user's choice; Salesforce's own rule is never hit", async () => {
  const { o, base } = await setup();
  const blocked = await addGroupLines(o.api, { ...base, items: [{ productId: P.ODD, pricebookEntryId: "01uA000000000ODDXX", quantity: 1 }] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /Billing Frequency can't be resolved from selling model Partner Plan .* choose one of MilestonePlan, Weekly, Monthly, Quarterly, Semi-Annual, Annual/);
  assert.equal(o.calls.filter(c => c.path === "/sobjects/QuoteLineItem").length, 0);
  const chosen = await addGroupLines(o.api, { ...base, items: [{ productId: P.ODD, pricebookEntryId: "01uA000000000ODDXX", quantity: 1, billingFrequency: "Quarterly" }] });
  assert.equal(chosen.ok, true, chosen.message);
  assert.equal(chosen.record![0].billingFrequency, "Quarterly");
  assert.match((await addGroupLines(o.api, { ...base, items: [{ productId: P.ODD, pricebookEntryId: "01uA000000000OFFXX", quantity: 1 }] })).message, /Inactive/);
});

test("regression: the payload that failed live (Term-Defined without BillingFrequency) is exactly what Salesforce rejects", async () => {
  const { o, q, g } = await setup();
  const r = await o.api.call("POST", "/sobjects/QuoteLineItem", { QuoteId: q.id, QuoteLineGroupId: g.id, Product2Id: P.WARRANTY, PricebookEntryId: "01uA000000WARRANTY", Quantity: 1, StartDate: "2027-01-01", EndDate: "2029-12-31" });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.body), /When the SellingModelType is Evergreen or Term-Defined, BillingFrequency can't be null/);
});

test("Quote Line Group relationship + existing lines preserved; group ramp eligibility refreshed from Salesforce", async () => {
  const { o, q, g, base } = await setup();
  const other = (await createQuoteLineGroup(o.api, { quoteId: q.id, name: "Other group" })).record!;
  await addGroupLines(o.api, { ...base, groupId: other.id, items: [{ productId: P.MONITOR, quantity: 1 }] });
  const keep = (await quoteLines(o.api, q.id)).map(l => ({ ...l }));
  const r = await addGroupLines(o.api, { ...base, items: [{ productId: P.WARRANTY, quantity: 1 }, { productId: P.LAPTOP, quantity: 1 }] });
  assert.equal(r.ok, true, r.message);
  const after = await quoteLines(o.api, q.id);
  for (const k of keep) assert.deepEqual(after.find(l => l.id === k.id), k, "existing lines unchanged");
  assert.deepEqual(after.filter(l => l.groupId === g.id).map(l => l.productName).sort(), ["Laptop", "Warranty"]);
  const lines = after;
  const products = await productFacts(o.api, lines.map(l => l.productId!).filter(Boolean));
  const d = groupRampDiagnostics({ quote: await quoteFacts(o.api, q.id), groupId: g.id, groups: await quoteGroups(o.api, q.id), lines, products, segmentsByProduct: new Map([[P.WARRANTY, [{ id: "1FT", sellingModelId: M.YR, segmentType: "Yearly", name: null }]]]) });
  assert.equal(d.eligible, false, "the One-Time Laptop line keeps the group from ramping");
  assert.deepEqual(d.lines.map(x => [x.line.productId === P.WARRANTY ? "Warranty" : "Laptop", x.eligible]).sort(), [["Laptop", false], ["Warranty", true]]);
  assert.ok(d.lines.find(x => x.line.productId === P.LAPTOP)!.reasons.some(r2 => r2.code === "line-not-term"));
});

test("a single product lookup returns the same verdicts as the catalog (one implementation)", async () => {
  const o = fakeOrg(seed());
  const a = await catalogProduct(o.api, P.API, PB);
  const b = (await searchCatalog(o.api, { q: "API Access", pricebookId: PB })).rows[0];
  assert.deepEqual(a, b);
  assert.equal((await catalogProduct(o.api, P.RETIRED, PB))!.quoteLine.ok, false);
});
