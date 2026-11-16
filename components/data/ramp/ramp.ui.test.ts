/**
 * RAMP UI — navigation, every homepage card routes to a real page, forms are wired to the RAMP backend routes, and every Salesforce
 * write in the UI sits behind an explicit confirmation. Components are rendered with react-dom/server (this repo has no browser/JSDOM
 * harness — effects and fetches don't run), and wiring is asserted against source like the repo's other component tests. Nothing here
 * talks to Salesforce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesforceSuccessProvider } from "@/components/notifications/SalesforceSuccessContext";
import RampWorkspace, { RAMP_HOME_CARDS, RAMP_VIEWS, RAMP_VIEW_LABELS, isRampView } from "./RampWorkspace";
import { SegmentTable } from "./rampUi";
import { blankSchedule, generateSchedule } from "@/lib/ramp/schedule";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const render = (view: string, isDark = false) => renderToStaticMarkup(h(SalesforceSuccessProvider, null, h(RampWorkspace, { isDark, initialView: view })));
const REQUIRED_CARDS = ["Product Ramp Setup", "Ramp Schedules", "Ramp Deals", "Group Ramp Deals", "Ramp Execution Center", "Ramp History"];

test("homepage has the 6 required cards (+ AI builder), each routed to a real RAMP view", () => {
  for (const title of REQUIRED_CARDS) assert.ok(RAMP_HOME_CARDS.some(c => c.title === title), `missing card ${title}`);
  for (const c of RAMP_HOME_CARDS) { assert.ok(isRampView(c.workflow), `${c.title} → ${c.workflow}`); assert.notEqual(c.workflow, "home"); }
  assert.equal(new Set(RAMP_HOME_CARDS.map(c => c.workflow)).size, RAMP_HOME_CARDS.length, "each card opens a distinct page");
  const html = render("home");
  assert.match(html, /data-testid="ramp-home"/);
  for (const title of REQUIRED_CARDS) assert.ok(html.includes(title.replace("&", "&amp;")), `home renders ${title}`);
});

test("every RAMP view renders its page (light + dark) with breadcrumb back to home", () => {
  for (const v of RAMP_VIEWS.filter(x => x !== "home")) {
    for (const dark of [false, true]) {
      const html = render(v, dark);
      assert.match(html, new RegExp(`data-testid="ramp-view-${v}"`), v);
      assert.ok(html.includes(RAMP_VIEW_LABELS[v].replace("&", "&amp;")), `${v} title`);
      assert.match(html, /RAMP home/);
    }
  }
  assert.match(render("not-a-view"), /data-testid="ramp-home"/, "unknown view falls back to home");
});

test("sidebar has a RAMP section whose items open the workspace at each view", () => {
  const page = src("app/data/page.tsx");
  assert.match(page, /id: "ramp",\s*\n\s*label: "RAMP"/);
  for (const v of RAMP_VIEWS) assert.match(page, new RegExp(`rampView: "${v}"`), `sidebar item for ${v}`);
  assert.match(page, /selectedObj\.groupId === "ramp" \? \(\s*<RampWorkspace/);
  assert.match(page, /key=\{rampNav\}/);
  assert.match(page, /handleRampViewChange/);
});

test("pages are wired to the RAMP backend routes (no mock data in the UI)", () => {
  const dir = "components/data/ramp";
  const all = readdirSync(join(process.cwd(), dir)).filter(f => f.endsWith(".tsx")).map(f => src(`${dir}/${f}`)).join("\n");
  for (const route of ["/api/ramp/capabilities", "/api/ramp/lookup", "/api/ramp/product-segments", "/api/ramp/schedules", "/api/ramp/deals", "/api/ramp/executions", "/api/ramp/history", "/api/ramp/ai"]) {
    assert.ok(all.includes(route), `UI uses ${route}`);
    assert.ok(existsSync(join(process.cwd(), "app", ...route.replace(/^\//, "").split("/"), "route.ts")), `route exists for ${route}`);
  }
  assert.doesNotMatch(all, /fakeOrg|localStorage/, "no fake org or browser-only persistence in the RAMP UI");
});

test("every Salesforce write in the UI is behind a confirmation modal and sends confirmed: true", () => {
  const prs = src("components/data/ramp/ProductRampSetup.tsx"), deals = src("components/data/ramp/RampDeals.tsx");
  assert.match(prs, /setConfirm\(true\)/); assert.match(prs, /confirmed: true, productId/);
  assert.match(deals, /setConfirmRun\(true\)/); assert.match(deals, /action: "start", dealId: saved\.id, confirmed: true/);
  // and the routes refuse a write without it
  assert.match(src("app/api/ramp/product-segments/route.ts"), /b\.confirmed !== true/);
  assert.match(src("lib/ramp/server/service.ts"), /if \(!confirmed\) throw/);
});

test("AI builder never executes: it only opens a draft in the deal editor", () => {
  const ai = src("components/data/ramp/RampAiBuilder.tsx");
  assert.doesNotMatch(ai, /\/api\/ramp\/executions|\/api\/ramp\/deals/);
  assert.match(ai, /onOpenDraft\(res\.draft\)/);
  assert.doesNotMatch(src("app/api/ramp/ai/route.ts"), /saveDeal|startExecution|stepExecution/);
});

test("group ramp UI uses the group APIs (not independent line ramps) and line ramps refuse non-yearly periods", () => {
  const deals = src("components/data/ramp/RampDeals.tsx");
  assert.match(deals, /groupRampAction EditGroup/);
  assert.match(deals, /type=group-eligibility/);
  assert.match(deals, /Line ramps use Salesforce's Yearly segments only/);
});

test("SegmentTable renders the preview with the Salesforce uplift column", () => {
  const s = { ...blankSchedule(), segments: 3, period: "Yearly" as const, priceChange: "percent" as const, defaultChange: 10 };
  const pv = generateSchedule(s, { contractStart: "2027-01-01", contractEnd: "2029-12-31", basePrice: 100, baseQuantity: 1 });
  const html = renderToStaticMarkup(h(SegmentTable, { isDark: true, segments: pv.segments, total: pv.previewTotal }));
  assert.match(html, /Uplift → Salesforce/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 3, "one body row per segment");
  assert.match(html, /2029-12-31/);
});

/* ── Draft-quote lookup (RecordPicker + deal editor) ── */
import { RecordPicker, appendPage, lookupQuery, parseLookupPage } from "./rampUi";
import { QuoteOption, quoteLabel } from "./RampQuoteOption";

test("lookup responses: failures and malformed bodies throw — never shown as an empty 'No matches' list", () => {
  assert.throws(() => parseLookupPage({ success: false, error: "INVALID_FIELD: No such column" }), /INVALID_FIELD/);
  assert.throws(() => parseLookupPage({ success: true }), /no result list/);
  assert.throws(() => parseLookupPage(null), /no data/);
  assert.deepEqual(parseLookupPage({ success: true, rows: [], hasMore: false, page: 1 }), { rows: [], hasMore: false, page: 1 });
  assert.deepEqual(parseLookupPage<{ id: string }>({ success: true, rows: [{ id: "a" }], hasMore: true }, 3), { rows: [{ id: "a" }], hasMore: true, page: 3 });
});

test("account switch = a new lookup key (results of the previous account are never shown); empty filters are dropped", () => {
  const a = lookupQuery("quotes", "", { accountId: "001g500000j9RBQAA2" }), b = lookupQuery("quotes", "", { accountId: "001g500000j9RBTAA2" });
  assert.notEqual(a, b);
  assert.equal(lookupQuery("quotes", "ram", { accountId: null }), "type=quotes&q=ram");
  assert.match(b, /accountId=001g500000j9RBTAA2/);
});

test("Load more appends the next page without duplicates", () => {
  assert.deepEqual(appendPage([{ id: "1" }, { id: "2" }], [{ id: "2" }, { id: "3" }]).map(r => r.id), ["1", "2", "3"]);
});

test("quote options show Quote Name + Quote Number; the selected quote stays displayed on the closed picker", () => {
  const row = { id: "0Q0g5000001juOrCAI", name: "Ramp Deal Test", quoteNumber: "00000071", status: "Draft", accountId: "001g500000j9RBTAA2", accountName: "Any Partner Inc", opportunityName: null, expirationDate: null, grandTotal: 100, lastModifiedDate: null, pricebookId: null };
  assert.equal(quoteLabel(row), "Ramp Deal Test · #00000071");
  const opt = renderToStaticMarkup(h(QuoteOption, { isDark: false, r: row, showAccount: true }));
  assert.match(opt, /Ramp Deal Test/); assert.match(opt, /#00000071/); assert.match(opt, /Draft · Any Partner Inc/);
  const closed = renderToStaticMarkup(h(RecordPicker, { isDark: false, label: "Quote (Draft)", type: "quotes", value: { id: row.id, name: quoteLabel(row) }, onPick: () => undefined }));
  assert.match(closed, /Ramp Deal Test · #00000071/);
  assert.doesNotMatch(closed, /No matches|No Draft Quotes/, "no empty message before any search ran");
});

test("deal editor quote picker: account-filtered, account-specific empty text, cleared + reset on account change, stores the Salesforce Id", () => {
  const deals = src("components/data/ramp/RampDeals.tsx"), ui = src("components/data/ramp/rampUi.tsx");
  assert.match(deals, /type="quotes" params=\{\{ accountId: d\.accountId \}\}/);
  assert.match(deals, /No Draft Quotes found for \$\{d\.accountName \?\? "this Account"\}/);
  assert.match(deals, /key=\{d\.accountId \?\? "any"\}/, "picker search resets when the account changes");
  assert.match(deals, /onPick=\{r => set\(\{ accountId: r\?\.id \?\? null, accountName: r\?\.name \?\? null, quoteId: null, quoteName: null/, "account change clears the quote");
  assert.match(deals, /set\(\{ quoteId: r\?\.id \?\? null, quoteName: r \? quoteLabel\(r\) : null/);
  // empty text only for a successful, current, zero-row result; errors are shown as errors with retry
  assert.match(ui, /const current = st\.key === qs/);
  assert.match(ui, /Couldn&apos;t search Salesforce: \{err\}/);
  assert.match(ui, /: !rows\.length \? <div[^>]*>\{emptyText\}<\/div>/);
  assert.match(src("app/api/ramp/lookup/route.ts"), /case "quotes": return \{ success: true, \.\.\.\(await searchQuotes\(api, \{ accountId:/);
});
