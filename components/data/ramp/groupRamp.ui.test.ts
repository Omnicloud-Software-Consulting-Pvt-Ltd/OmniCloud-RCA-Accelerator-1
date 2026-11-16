/**
 * Group Ramp builder UI — rendered with react-dom/server (no browser harness here: effects/fetches don't run) + source assertions for
 * wiring: quote / group choice, empty-group explanation, group states with View Existing Ramp, line items + add products, diagnostics,
 * confirmations on every write, and the group-only schedule fields. Nothing here talks to Salesforce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesforceSuccessProvider } from "@/components/notifications/SalesforceSuccessContext";
import GroupRampBuilder, { RampChainView, type GroupDiag, type GroupRow, type QuoteLinesData } from "./GroupRampBuilder";
import { ScheduleEditor, blankScheduleBody } from "./RampSchedules";
import { RAMP_HELP } from "@/lib/ramp/help";
import { validateAiExtraction } from "@/lib/ramp/aiSchema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const Q = "0Q0g5000001juOrCAI";
const base = { accountId: "001g500000j9RBTAA2", accountName: "Any Partner Inc", quoteId: null as string | null, quoteName: null as string | null, groupId: null as string | null, groupName: null as string | null, contractStart: "2027-01-01", contractEnd: "2029-12-31" };
const grp = (id: string, o: Partial<GroupRow> = {}): GroupRow => ({ id, name: id, quoteId: Q, isRamped: false, segmentType: null, startDate: null, endDate: null, parentId: null, parentName: null, sortOrder: 1, state: "unramped", lineCount: 0, rampKey: null, ...o });
const render = (p: Partial<Parameters<typeof GroupRampBuilder>[0]> = {}) => renderToStaticMarkup(h(SalesforceSuccessProvider, null, h(GroupRampBuilder, {
  isDark: false, instanceUrl: "https://x.my.salesforce.com", locked: false, d: base, set: () => undefined,
  quoteData: null, quoteLoading: false, quoteError: null, reloadQuote: () => undefined, diag: null, diagLoading: false, diagError: null, reloadDiag: () => undefined, ...p,
})));

test("starts with Account and the two quote options: Use Existing Draft Quote / Create New Quote", () => {
  const html = render();
  assert.match(html, /data-testid="group-ramp-builder"/);
  assert.match(html, /role="radiogroup" aria-label="Quote source"/);
  assert.match(html, /Use Existing Draft Quote/);
  assert.match(html, /Create New Quote/);
  assert.match(html, /aria-label="Quote \(Draft\)"/);
  assert.doesNotMatch(html, /Quote Line Group/, "group step appears only after a quote is chosen");
});

test("a quote with no groups explains it instead of an empty '— Select —' dropdown, and offers to create one", () => {
  const html = render({ d: { ...base, quoteId: Q, quoteName: "Ramp Deal Test · #00000071" }, quoteData: { quote: { id: Q, name: "Ramp Deal Test", status: "Draft", accountId: base.accountId, pricebookId: "01sX" }, groups: [], ramps: [] } });
  assert.match(html, /This quote has no Quote Line Groups yet/);
  assert.match(html, /create one now/);
  assert.match(html, /Select Existing Group/);
  assert.match(html, /Create New Group/);
  assert.doesNotMatch(html, /— Select —/);
});

test("loading and Salesforce errors for the group lookup are shown as such", () => {
  assert.match(render({ d: { ...base, quoteId: Q }, quoteLoading: true }), /Reading the quote&#x27;s groups from Salesforce/);
  assert.match(render({ d: { ...base, quoteId: Q }, quoteError: "INVALID_FIELD: x" }), /Couldn&#x27;t read the quote line groups: INVALID_FIELD: x/);
});

test("existing groups show Name, Salesforce Id, IsRamped, SegmentType, dates, parent and their real state; ramped ones offer View Existing Ramp, not Select", () => {
  const chain = { key: "PARENT", shape: "parent" as const, parent: { id: "PARENT", name: "RAMP GROUP", quoteId: Q, isRamped: false, parentId: null, sortOrder: 1, segmentType: null, startDate: null, endDate: null, unitPriceUplift: null, rampUpliftType: null }, segments: [{ id: "Y1", name: "YEAR 1", quoteId: Q, isRamped: true, parentId: "PARENT", sortOrder: 2, segmentType: "Yearly", startDate: "2026-10-27", endDate: "2027-10-26", unitPriceUplift: 0, rampUpliftType: "Standard" }], rampIdentifiers: ["RDI0bbe4b989d714b7"] };
  const data: QuoteLinesData = { quote: null, ramps: [chain], groups: [
    grp("PARENT", { name: "RAMP GROUP", state: "ramp-container", rampKey: "PARENT", lineCount: 0 }),
    grp("Y1", { name: "YEAR 1", isRamped: true, segmentType: "Yearly", startDate: "2026-10-27", endDate: "2027-10-26", parentId: "PARENT", parentName: "RAMP GROUP", state: "ramp-segment", rampKey: "PARENT", lineCount: 1 }),
    grp("FRESH", { name: "Platform", lineCount: 2 }),
  ] };
  const html = render({ d: { ...base, quoteId: Q }, quoteData: data });
  for (const h2 of ["Salesforce Id", "IsRamped", "SegmentType", "Parent", "State"]) assert.ok(html.includes(h2), h2);
  assert.match(html, /Holds a ramp schedule/);
  assert.match(html, /Ramp segment \(IsRamped\)/);
  assert.match(html, /Not ramped/);
  assert.equal(html.split("View Existing Ramp").length - 1 - (html.includes("open them with View Existing Ramp") ? 1 : 0), 2, "one button per ramped group (plus the hint text)");
  assert.equal(html.split("Select</button>").length - 1, 1, "only the un-ramped group is selectable");
  const ramp = renderToStaticMarkup(h(RampChainView, { isDark: true, chain, instanceUrl: null }));
  assert.match(ramp, /RAMP GROUP/); assert.match(ramp, /RDI0bbe4b989d714b7/); assert.match(ramp, /2026-10-27 → 2027-10-26/);
});

const diag = (o: Partial<GroupDiag> = {}): GroupDiag => ({
  quote: { id: Q, name: "Q", status: "Draft", accountId: base.accountId, pricebookId: "01sX" }, eligible: true, reasons: [], quoteReasons: [], groupState: "unramped", chain: null, otherRamps: [],
  lines: [{ id: "0QLA", productId: "01tA", productName: "API Access Premium", quantity: 5, sellingModelId: "0jPY", sellingModelType: "TermDefined", rampIdentifier: null, startDate: "2027-01-01", endDate: "2029-12-31", product: { id: "01tA", name: "API Access Premium", isActive: true, canRamp: true, usageModelType: null, type: null, productCode: "API" }, eligible: true, reasons: [] }],
  pricing: { groupRamp: { available: true, reason: null, segmentTypes: ["Custom", "Yearly", "Prorated"] }, compound: { line: false, group: true, reason: null }, activeProcedures: [{ apiName: "P", name: "Default Pricing", activeVersion: 7 }] }, ...o,
});

test("line items of the selected group: Product, Quantity, Selling Model, Salesforce Id and whether each can participate; add-products section", () => {
  const html = render({ d: { ...base, quoteId: Q, groupId: "FRESH", groupName: "Platform" }, quoteData: { quote: null, groups: [grp("FRESH", { name: "Platform" })], ramps: [] }, diag: diag() });
  assert.match(html, /data-testid="group-lines"/);
  assert.match(html, /API Access Premium/); assert.match(html, /TermDefined/); assert.match(html, /0QLA/); assert.match(html, /Can participate/);
  assert.match(html, /data-testid="add-products"/);
  assert.match(html, /aria-label="Selling model for the new line"/);
  assert.match(html, /aria-label="Quantity for the new line"/);
  assert.match(html, /data-testid="group-diagnostics"/);
  assert.match(html, /This group can be ramped/);
  assert.match(html, /Active default pricing procedure: Default Pricing v7/);
});

test("diagnostics: an ineligible group lists Salesforce reasons, existing ramp and other ramps; products can't be added to a ramped group", () => {
  const chain = { key: "NG1", shape: "chain" as const, parent: null, segments: [], rampIdentifiers: ["RDIchain"] };
  const html = render({ d: { ...base, quoteId: Q, groupId: "NG1", groupName: "New Group 1" }, quoteData: { quote: null, groups: [], ramps: [] },
    diag: diag({ eligible: false, groupState: "ramp-segment", chain, otherRamps: [{ ...chain, key: "X", rampIdentifiers: ["RDIother"] }], reasons: [{ code: "group-ramped", severity: "error", message: "New Group 1 is already a ramp segment" }], pricing: { ...diag().pricing, activeProcedures: [] } }) });
  assert.match(html, /New Group 1 is already a ramp segment/);
  assert.match(html, /Existing ramp on this group/);
  assert.match(html, /RDIchain/);
  assert.match(html, /Other ramp schedules on the quote/);
  assert.match(html, /No active default pricing procedure/);
  assert.doesNotMatch(html, /data-testid="add-products"/);
});

test("every builder write is confirmed and sends confirmed: true; the route refuses without it; selections reset on account / quote change", () => {
  const ui = src("components/data/ramp/GroupRampBuilder.tsx"), route = src("app/api/ramp/quote-builder/route.ts");
  assert.match(ui, /"\/api\/ramp\/quote-builder", \{ \.\.\.body, confirmed: true \}/);
  for (const c of ["quote", "group", "lines"]) assert.match(ui, new RegExp(`setConfirm\\("${c}"\\)`));
  assert.match(ui, /action: "create-quote"/); assert.match(ui, /action: "create-group"/); assert.match(ui, /action: "add-lines"/);
  assert.match(route, /b\.confirmed !== true/);
  assert.match(ui, /set\(\{ accountId: r\?\.id \?\? null, accountName: r\?\.name \?\? null, quoteId: null, quoteName: null, groupId: null, groupName: null \}\)/, "account change clears quote + group");
  assert.match(ui, /set\(\{ quoteId: r\?\.id \?\? null, quoteName: r \? quoteLabel\(r\) : null, groupId: null, groupName: null \}\)/, "quote change clears the group");
  assert.match(ui, /set\(\{ quoteId: r\.record\.id, quoteName: quoteLabel\(r\.record\), groupId: null, groupName: null \}\)/, "a created quote is selected automatically");
  assert.match(ui, /set\(\{ groupId: r\.record\.id, groupName: r\.record\.name \}\)/, "a created group is selected automatically");
  assert.match(ui, /data-testid="create-quote-form"/); assert.match(ui, /data-testid="create-group-form"/);
});

test("the deal editor uses the builder for group ramps only — line ramps keep their own pickers", () => {
  const deals = src("components/data/ramp/RampDeals.tsx");
  assert.match(deals, /\{d\.kind === "group" && \(\s*<GroupRampBuilder/);
  assert.match(deals, /\{d\.kind === "line" && d\.quoteId && \(qLines\.loading/);
  assert.match(deals, /label="Quote line to ramp"/);
  assert.match(deals, /groupRamp=\{d\.kind === "group"\}/);
  assert.match(deals, /\{d\.kind === "line" && <Field isDark=\{isDark\} label="Period boundary"/);
});

test("group schedule form exposes only Salesforce group-ramp fields: uplift + group discount, no per-segment quantity", () => {
  const v = { ...blankScheduleBody(), segments: 3 };
  const group = renderToStaticMarkup(h(ScheduleEditor, { isDark: false, value: v, onChange: () => undefined, groupRamp: true }));
  const line = renderToStaticMarkup(h(ScheduleEditor, { isDark: false, value: v, onChange: () => undefined }));
  assert.doesNotMatch(group, /Segment 1 quantity/);
  assert.match(group, /Segment 1 discount/);
  assert.match(group, /Group discount %/);
  assert.match(line, /Segment 1 quantity/);
  assert.match(group, /QuoteLineGroup\.UnitPriceUplift \/ Discount/);
});

test("Group Ramp AI: period boundary and per-segment quantity are dropped with an explanation", () => {
  const x = validateAiExtraction("group-deal", { fields: { periodBoundary: { value: "Anniversary", source: "explicit" }, overrides: { value: [{ segment: 2, value: 5, quantity: 9 }], source: "explicit" } } }, "2026-11-10");
  assert.equal(x.fields.periodBoundary, undefined);
  assert.ok(x.notes.some(n => /isn't part of a group ramp/.test(n)));
  assert.deepEqual(x.fields.overrides.value, [{ segment: 2, value: 5, quantity: null, discount: null }]);
});

test("Group Ramp help: overview vs line ramp, required incl. eligible lines + Salesforce config, 9-step workflow, common errors", () => {
  const h2 = RAMP_HELP.groupDeal;
  assert.match(h2.overview, /A Line Ramp, by contrast/);
  for (const r of ["Account", "Quote", "Quote Line Group", "Eligible Quote Line Items", "Ramp Schedule", "Salesforce configuration"]) assert.ok(h2.required.some(f => f.label === r), r);
  assert.equal(h2.examples[0].details!.filter(d => /^\d\. /.test(d)).length, 9);
  for (const e of ["No Quote Line Groups", "No Quote Line Items", "Already ramped", "Unsupported product", "Missing Selling Model", "Pricing Procedure unavailable", "Stale Decision Tables", "Salesforce transaction failure"]) assert.ok(h2.commonErrors.some(c => c.startsWith(e)), e);
  assert.ok(h2.prerequisites.some(p => /Revenue Settings/.test(p)) && h2.prerequisites.some(p => /Clone Sales Transaction/.test(p)));
  assert.ok(!h2.prerequisites.some(p => /Only one ramped group schedule per quote/.test(p)), "the disproven one-schedule rule is gone");
});

/* ── full catalog + universal line creation (UI) ── */
import { AddedLinesTable, CatalogRow, ProductVerdict, optionLabel, pendingFrom } from "./GroupRampBuilder";
import type { CatalogOption, CatalogProduct } from "@/lib/ramp/server/catalog";

const opt = (o: Partial<CatalogOption> = {}): CatalogOption => ({ pricebookEntryId: "01uX", unitPrice: 1049, sellingModelId: "0jP1", sellingModelName: "One Time", sellingModelType: "OneTime", sellingModelStatus: "Active", pricingTermUnit: null, billingFrequency: null, billingFrequencyRequired: false, usable: true, reason: null, rampable: false, ...o });
const cat = (o: Partial<CatalogProduct> = {}): CatalogProduct => ({ id: "01tL", name: "Laptop", productCode: "LP001", sku: null, canRamp: false, usageModelType: null, offeredModels: [], options: [opt()], quoteLine: { ok: true, reason: null }, groupRamp: { ok: false, reason: "Quote line only — OneTime lines don't ramp (term-defined only)." }, ...o });

test("product picker uses the full catalog (not rampable-only) with the quote's price book", () => {
  const ui = src("components/data/ramp/GroupRampBuilder.tsx");
  assert.match(ui, /type="catalog" params=\{\{ pricebookId: quotePricebook/);
  assert.doesNotMatch(ui, /type="products" params=\{\{ eligible: "1" \}\}/);
  assert.match(src("app/api/ramp/lookup/route.ts"), /case "catalog": return \{ success: true, \.\.\.\(await searchCatalog/);
});

test("catalog rows show name, ProductCode and the three-way verdict", () => {
  const row = (r: CatalogProduct) => renderToStaticMarkup(h(CatalogRow, { isDark: false, r }));
  assert.match(row(cat()), /Laptop/); assert.match(row(cat()), /LP001/); assert.match(row(cat()), /Quote line only/);
  assert.match(row(cat({ name: "Warranty", options: [opt({ sellingModelType: "TermDefined", rampable: true })], groupRamp: { ok: true, reason: null } })), /Quote line \+ Group Ramp/);
  assert.match(row(cat({ name: "Billing Service", options: [], quoteLine: { ok: false, reason: "No active Price Book Entry in this price book." } })), /Can&#x27;t add to the quote/);
});

test("selling-model options name the type, Billing Frequency and price; pending lines carry the entry, not a guessed model", () => {
  assert.equal(optionLabel(opt()), "One Time (One-Time) · 1049 · quote line only");
  assert.equal(optionLabel(opt({ sellingModelName: "Term Based - Monthly", sellingModelType: "TermDefined", billingFrequency: "Monthly", billingFrequencyRequired: true, unitPrice: 75, rampable: true })), "Term Based - Monthly (Term-Defined) · billed Monthly · 75");
  assert.match(optionLabel(opt({ sellingModelType: "Evergreen", sellingModelName: "Evergreen - Yearly", billingFrequencyRequired: true })), /\(Evergreen\) · billing frequency: choose/);
  const p = pendingFrom(cat(), opt({ sellingModelType: "TermDefined", billingFrequencyRequired: true, billingFrequency: null }), 2, "Quarterly");
  assert.deepEqual([p.pricebookEntryId, p.billingFrequency, p.billingFrequencySource], ["01uX", "Quarterly", "user"]);
});

test("product verdict distinguishes not-creatable / quote-line-only / both", () => {
  const v = (product: CatalogProduct, option: CatalogOption | null) => renderToStaticMarkup(h(ProductVerdict, { isDark: false, product, option }));
  assert.match(v(cat({ options: [], quoteLine: { ok: false, reason: "No active Price Book Entry in this price book." } }), null), /Not eligible for Quote Line creation/);
  assert.match(v(cat(), opt()), /Eligible for Quote Line creation, not for the Group Ramp/);
  assert.match(v(cat(), opt()), /It can still be added to the group/);
  assert.match(v(cat({ groupRamp: { ok: true, reason: null } }), opt({ sellingModelType: "TermDefined", rampable: true })), /Eligible for Quote Line creation and the Group Ramp/);
  assert.doesNotMatch(v(cat(), opt()), /no rampable products/i);
});

test("added lines show the read-back verification and group-ramp participation per line", () => {
  const line = { id: "0QLX", productId: "01tL", productName: "Warranty", quantity: 1, pricebookEntryId: "01uX", sellingModelId: "0jP", sellingModelType: "TermDefined", billingFrequency: "Annual", groupId: "1C9", quoteId: "0Q0", startDate: "2027-01-01", endDate: "2029-12-31", checks: [{ field: "BillingFrequency", expected: "Annual", actual: "Annual", passed: true }], verified: true, groupRampEligible: true, groupRampReason: null };
  const html = renderToStaticMarkup(h(AddedLinesTable, { isDark: false, instanceUrl: null, lines: [line, { ...line, id: "0QLY", productName: "Laptop", sellingModelType: "OneTime", billingFrequency: null, groupRampEligible: false, groupRampReason: "Quote line only — OneTime lines don't ramp (term-defined only)." }] }));
  assert.match(html, /✓ 1 fields match/); assert.match(html, /Term-Defined/); assert.match(html, /One-Time/); assert.match(html, /Annual/); assert.match(html, /Can participate/); assert.match(html, /Quote line only/);
});

/* ── schedule selection → segment table (group ramp) ── */
import { SegmentTable } from "./rampUi";
import { generateSchedule, scheduleBodyOf, blankSchedule as blankSched } from "@/lib/ramp/schedule";

test("group ramp segment table shows the saved schedule's uplift (not 0%), its source, the group discount and no quantity column", () => {
  const s = { ...blankSched("2026-11-09T00:00:00Z"), id: "sch", name: "Ramp trail", segments: 3, defaultChange: 5, overrides: [{ segment: 3, value: null, discount: 10 }] };
  const pv = generateSchedule(scheduleBodyOf(s), { contractStart: "2026-11-10", contractEnd: "2029-11-09", basePrice: 0, baseQuantity: 1, ignoreQuantityOverrides: true });
  const html = renderToStaticMarkup(h(SegmentTable, { isDark: false, segments: pv.segments, total: pv.previewTotal, groupRamp: true }));
  assert.match(html, /Group discount/);
  assert.doesNotMatch(html, />Qty</);
  assert.deepEqual([...html.matchAll(/data-uplift-source="(\w+)">([\d.]+)%/g)].map(m => [m[1], m[2]]), [["first", "0"], ["default", "5"], ["default", "5"]]);
  assert.match(html, /10%/);
  assert.match(html, /schedule default/);
});

test("the deal editor applies a saved schedule through the shared applySavedSchedule (whole template, group-aware preview)", () => {
  const deals = src("components/data/ramp/RampDeals.tsx");
  assert.match(deals, /const p = applySavedSchedule\(d, schedules\.data\?\.rows\.find\(x => x\.id === v\) \?\? null\); set\(p as Partial<Draft>\);/);
  assert.match(deals, /ignoreQuantityOverrides: d\.kind === "group"/);
  assert.match(src("lib/ramp/server/runner.ts"), /ignoreQuantityOverrides: deal\.kind === "group" \}\)\.segments/);
});
