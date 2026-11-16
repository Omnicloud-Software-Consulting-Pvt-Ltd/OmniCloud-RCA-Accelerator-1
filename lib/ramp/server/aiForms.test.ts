/**
 * AI-assisted RAMP forms — server resolution against a MOCKED org (lib/ramp/server/fakeOrg.ts): Salesforce references are resolved by
 * reading the org (never from the AI), ambiguity is reported (never auto-selected), required fields are never invented, and NO
 * Salesforce write is sent during generation. Run: `npx tsx --test lib/ramp/server/aiForms.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { fakeOrg } from "./fakeOrg";
import { aiRampForm, rampAiSystemPrompt, resolveRampAiForm } from "./aiForms";
import { blankSchedule } from "@/lib/ramp/schedule";
import type { RampSchedule } from "@/lib/ramp/types";

const T = "2026-11-10";
const ACME = "001A00000000001AAA", Q1 = "0Q0A00000000001AAA", Q2 = "0Q0A00000000002AAA", Q3 = "0Q0A00000000003AAA";
const v = (value: unknown, source: "explicit" | "inferred" = "explicit") => ({ value, source });
const line = (id: string, quote: string, product: string, o: Record<string, unknown> = {}) => ({ Id: id, QuoteId: quote, Product2Id: product, ProductSellingModelId: "0jPA00000000001AAA", SellingModelType: "TermDefined", Quantity: 10, UnitPrice: 100, StartDate: "2027-01-01", EndDate: "2029-12-31", RampIdentifier: null, QuoteLineGroupId: null, CreatedDate: "2026-11-01", ...o });
function seed() {
  return {
    Account: [{ Id: ACME, Name: "Acme" }],
    Quote: [
      { Id: Q1, Name: "Acme Renewal", QuoteNumber: "00000071", Status: "Draft", QuoteAccountId: ACME, LastModifiedDate: "2026-11-09" },
      { Id: Q2, Name: "Acme Expansion", QuoteNumber: "00000072", Status: "Draft", QuoteAccountId: ACME, LastModifiedDate: "2026-11-08" },
      { Id: Q3, Name: "Acme Bundle", QuoteNumber: "00000073", Status: "Draft", QuoteAccountId: ACME, LastModifiedDate: "2026-11-07" },
    ],
    Product2: [
      { Id: "01tA00000000001AAA", Name: "API Access Premium", IsActive: true, ProductCode: "API-PREM", CanRamp: true, UsageModelType: null, Type: null },
      { Id: "01tA00000000002AAA", Name: "API Access Basic", IsActive: true, ProductCode: "API-BAS", CanRamp: false, UsageModelType: null, Type: null },
      { Id: "01tA00000000003AAA", Name: "Premium Support", IsActive: true, ProductCode: "SUP", CanRamp: true, UsageModelType: null, Type: null },
    ],
    ProductSellingModel: [{ Id: "0jPA00000000001AAA", Name: "Term-Based Yearly", SellingModelType: "TermDefined", Status: "Active" }, { Id: "0jPA00000000002AAA", Name: "Term-Based Monthly", SellingModelType: "TermDefined", Status: "Active" }],
    ProductSellingModelOption: [
      { Id: "0iO1", Product2Id: "01tA00000000001AAA", ProductSellingModelId: "0jPA00000000001AAA" },
      { Id: "0iO2", Product2Id: "01tA00000000002AAA", ProductSellingModelId: "0jPA00000000001AAA" },
      { Id: "0iO3", Product2Id: "01tA00000000003AAA", ProductSellingModelId: "0jPA00000000001AAA" }, { Id: "0iO4", Product2Id: "01tA00000000003AAA", ProductSellingModelId: "0jPA00000000002AAA" },
    ],
    ProductRampSegment: [],
    QuoteLineItem: [
      line("0QLA00000000001AAA", Q1, "01tA00000000001AAA"),
      line("0QLA00000000002AAA", Q2, "01tA00000000001AAA"), line("0QLA00000000003AAA", Q2, "01tA00000000003AAA"),
    ],
    QuoteLineGroup: [
      { Id: "1C9A00000000001AAA", Name: "Platform", QuoteId: Q3, SortOrder: 1, IsRamped: false },
      { Id: "1C9A00000000002AAA", Name: "Services", QuoteId: Q3, SortOrder: 2, IsRamped: false },
      { Id: "1C9A00000000003AAA", Name: "Only group", QuoteId: Q1, SortOrder: 1, IsRamped: false },
    ],
  };
}
const org = () => fakeOrg(seed());
const saved = (name: string): RampSchedule => ({ ...blankSchedule("2026-11-01T00:00:00Z"), id: `rs_${name}`, name, period: "Yearly", segments: 3, defaultChange: 7, version: 2 });

test("Product Ramp Setup: product + its only term model resolved FROM SALESFORCE; segment type validated; no writes", async () => {
  const o = org();
  const r = await resolveRampAiForm(o.api, "product-segment", { fields: { productName: v("API Access Premium"), segmentType: v("Yearly"), contractMonths: v(36) } }, {}, [], T);
  assert.equal(r.patch.productId, "01tA00000000001AAA");
  assert.equal(r.patch.sellingModelId, "0jPA00000000001AAA");
  assert.equal(r.sources.productId, "salesforce");
  assert.equal(r.patch.segmentType, "Yearly");
  assert.deepEqual(r.missingRequired, []);
  assert.ok(r.notes.some(n => /not on the Product Ramp Segment/.test(n)), "contract length explained, not stored");
  assert.deepEqual(o.calls, [], "no Salesforce write");
});

test("Product Ramp Setup: product code wins; an ambiguous name is never auto-selected; several term models must be chosen", async () => {
  const byCode = await resolveRampAiForm(org().api, "product-segment", { fields: { productCode: v("SUP"), productName: v("Premium Support"), segmentType: v("Yearly") } }, {}, [], T);
  assert.equal(byCode.patch.productId, "01tA00000000003AAA");
  assert.equal(byCode.patch.sellingModelId, undefined, "two term models → not picked");
  assert.equal(byCode.references.find(x => x.field === "Selling model")?.status, "ambiguous");
  assert.ok(byCode.missingRequired.includes("Selling model"));
  const amb = await resolveRampAiForm(org().api, "product-segment", { fields: { productName: v("API Access"), segmentType: v("Yearly") } }, {}, [], T);
  assert.equal(amb.patch.productId, undefined);
  assert.equal(amb.references[0].status, "ambiguous");
  assert.equal(amb.references[0].candidates?.length, 2);
  const picked = await resolveRampAiForm(org().api, "product-segment", { fields: { productName: v("Premium Support"), sellingModelName: v("term-based monthly"), segmentType: v("Yearly") } }, {}, [], T);
  assert.equal(picked.patch.sellingModelId, "0jPA00000000002AAA");
});

test("Product Ramp Setup: AI-supplied Ids are ignored; unknown product → not found; FreeTrial without duration → still required", async () => {
  const r = await resolveRampAiForm(org().api, "product-segment", { fields: { productId: v("01tFAKE00000000AAA"), productName: v("Nonexistent"), segmentType: v("FreeTrial") } }, {}, [], T);
  assert.equal(r.patch.productId, undefined);
  assert.ok(r.rejected.some(x => x.key === "productId"));
  assert.equal(r.references[0].status, "not-found");
  assert.ok(r.missingRequired.includes("Product") && r.missingRequired.includes("Trial duration"));
});

test("Schedule: the example prompt fills the schedule form; missing name reported, never invented", async () => {
  const r = await resolveRampAiForm(org().api, "schedule", { fields: { period: v("Yearly"), contractMonths: v(36), defaultChange: v(5), upliftMethod: v("Standard"), freeTrial: v(false) } }, {}, [], T);
  assert.deepEqual({ period: r.patch.period, segments: r.patch.segments, defaultChange: r.patch.defaultChange, upliftMethod: r.patch.upliftMethod, trialMonths: r.patch.trialMonths, priceChange: r.patch.priceChange },
    { period: "Yearly", segments: 3, defaultChange: 5, upliftMethod: "Standard", trialMonths: null, priceChange: "percent" });
  assert.equal(r.sources.segments, "inferred");
  assert.deepEqual(r.missingRequired, ["Schedule name"]);
  assert.ok(r.optionalNotSupplied.includes("Description"));
});

test("Ramp Deal: 'the selected quote' uses the user's selection; the named product picks the line; line data comes from Salesforce", async () => {
  const o = org();
  const r = await resolveRampAiForm(o.api, "deal", { fields: { dealName: v("API 3y"), useSelectedQuote: v(true), productName: v("API Access Premium"), period: v("Yearly"), segments: v(3), defaultChange: v(5), contractStart: v("2026-12-01") } }, { quoteId: Q1, quoteName: "Acme Renewal" }, [], T);
  assert.equal(r.references.find(x => x.field === "Quote")?.status, "selected");
  assert.equal(r.patch.quoteId, undefined, "the selection is kept, not re-set");
  assert.equal(r.patch.lineId, "0QLA00000000001AAA");
  assert.equal(r.patch.contractStart, "2027-01-01", "a line ramp keeps the line's dates");
  assert.ok(r.warnings.some(w => /quote line's own dates/.test(w)));
  assert.deepEqual((r.patch.schedule as Record<string, unknown>).segments, 3);
  assert.deepEqual(r.missingRequired, []);
  assert.deepEqual(o.calls, [], "no Salesforce write");
});

test("Ramp Deal: quote by number; several lines and no product named → ambiguous, never auto-selected", async () => {
  const r = await resolveRampAiForm(org().api, "deal", { fields: { dealName: v("x"), accountName: v("Acme"), quoteName: v("00000072"), period: v("Yearly"), segments: v(3) } }, {}, [], T);
  assert.equal(r.patch.accountId, ACME);
  assert.equal(r.patch.quoteId, Q2);
  assert.equal(r.patch.quoteName, "Acme Expansion · #00000072");
  assert.equal(r.patch.lineId, undefined);
  const lr = r.references.find(x => x.field === "Quote line")!;
  assert.equal(lr.status, "ambiguous");
  assert.equal(lr.candidates?.length, 2);
  assert.ok(r.missingRequired.includes("Quote line"));
});

test("Ramp Deal: no quote anywhere → missing; unknown quote → not found; saved schedule applied by name", async () => {
  const a = await resolveRampAiForm(org().api, "deal", { fields: { dealName: v("x"), useSelectedQuote: v(true) } }, {}, [saved("Std 7%")], T);
  assert.equal(a.references.find(x => x.field === "Quote")?.status, "missing");
  assert.ok(a.missingRequired.includes("Quote") && a.missingRequired.includes("Period"));
  const b = await resolveRampAiForm(org().api, "deal", { fields: { dealName: v("x"), quoteName: v("Globex"), scheduleName: v("std 7%") } }, {}, [saved("Std 7%")], T);
  assert.equal(b.references.find(x => x.field === "Quote")?.status, "not-found");
  assert.equal(b.patch.scheduleId, "rs_Std 7%");
  assert.equal((b.patch.schedule as Record<string, unknown>).defaultChange, 7);
  assert.ok(!b.missingRequired.includes("Period"), "the saved schedule supplies the period");
});

test("Group Ramp: group resolved on the quote; several groups ambiguous; per-segment quantity removed", async () => {
  const one = await resolveRampAiForm(org().api, "group-deal", { fields: { dealName: v("G"), quoteName: v("Acme Renewal"), period: v("Yearly"), segments: v(3), contractStart: v("2027-01-01") } }, {}, [], T);
  assert.equal(one.patch.groupId, "1C9A00000000003AAA");
  assert.equal(one.patch.contractEnd, "2029-12-31");
  assert.deepEqual(one.missingRequired, []);
  const many = await resolveRampAiForm(org().api, "group-deal", { fields: { dealName: v("G"), quoteName: v("Acme Bundle"), overrides: v([{ segment: 2, value: 5, quantity: 50 }]) } }, {}, [], T);
  assert.equal(many.patch.groupId, undefined);
  assert.equal(many.references.find(x => x.field === "Quote line group")?.status, "ambiguous");
  assert.ok(many.missingRequired.includes("Quote line group") && many.missingRequired.includes("Contract start"));
  assert.deepEqual((many.patch.schedule as { overrides: unknown }).overrides, [{ segment: 2, value: 5, quantity: null, discount: null }]);
  const named = await resolveRampAiForm(org().api, "group-deal", { fields: { quoteName: v("Acme Bundle"), groupName: v("services") } }, {}, [], T);
  assert.equal(named.patch.groupId, "1C9A00000000002AAA");
});

test("aiRampForm: the model gets the form's schema; its output is validated; still no writes", async () => {
  let system = "", user = "";
  const fake = { messages: { create: async (a: { system: string; messages: { content: string }[] }) => { system = a.system; user = a.messages[0].content; return { content: [{ type: "text", text: JSON.stringify({ fields: { name: { value: "AI sched", source: "explicit" }, period: { value: "Yearly", source: "explicit" }, segments: { value: 3, source: "explicit" }, quoteId: { value: "0Q0FAKE", source: "explicit" } }, replace: false, notes: [] }) }] }; } } } as unknown as Anthropic;
  const o = org();
  const r = await aiRampForm(o.api, fake, "schedule", "3-year yearly schedule", { name: null }, [], T);
  assert.match(system, /"segments": integer 1-60/);
  assert.match(system, /Never invent record names, Salesforce Ids/);
  assert.match(user, /Today is 2026-11-10/);
  assert.equal(r.patch.name, "AI sched");
  assert.ok(r.rejected.some(x => x.key === "quoteId"));
  assert.deepEqual(o.calls, []);
});

test("every form's system prompt lists exactly its validated keys", () => {
  for (const f of ["product-segment", "schedule", "deal", "group-deal"] as const) assert.match(rampAiSystemPrompt(f), /Allowed keys/);
  assert.doesNotMatch(rampAiSystemPrompt("schedule"), /"quoteName"/);
  assert.match(rampAiSystemPrompt("group-deal"), /"groupName"/);
});
