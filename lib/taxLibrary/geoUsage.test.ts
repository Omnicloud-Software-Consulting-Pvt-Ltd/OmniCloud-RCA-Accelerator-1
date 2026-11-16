/**
 * Global Tax Library — (1) Salesforce geography sync: missing Geo Country / Geo State detection by ISO code, create requests with the
 * real parent GeoCountryId, duplicate prevention at validate/create time; (2) the Taxes dashboard's personalised Tax Library:
 * per-user/per-org usage, ranking that keeps no-data countries from dominating.
 *
 * Run: `npx tsx --test lib/taxLibrary/geoUsage.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { geoFlowQuestion, geoFlowWrites, geoStatusOf, indexOrgGeo, missingGeo, planGeoFlow, type OrgGeo } from "./geoSync";
import { geoIssues, evaluateBillingRules } from "@/lib/billing/server/rules";
import { emptyUsage, loadUsage, rankDashboardCountries, recordUsage, trackUsage, usageScope, TAX_USAGE_PREFIX, type UsageStorage } from "./usage";
import type { SalesforceClient } from "@/lib/salesforce/client";
import type { BillingModuleSchema } from "@/lib/billing/types";

const ROOT = path.resolve(__dirname, "..", "..");
const src = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

/** p10's real Geo records (2026-11-09, read-only): India with AP/KA/KL, Canada with ON; no Australia. */
const P10: OrgGeo = {
  success: true, available: { geoCountry: true, geoState: true, createGeoCountry: true, createGeoState: true },
  countries: [{ id: "0vfg80000001P9FAAU", name: "India", isoCode: "IN" }, { id: "0vfg80000001SYXAA2", name: "Canada", isoCode: "CA" }],
  states: [
    { id: "0vSg1", name: "Andhra Pradesh", isoCode: "AP", geoCountryId: "0vfg80000001P9FAAU", countryIso: "IN" },
    { id: "0vSg2", name: "Karnataka", isoCode: "KA", geoCountryId: "0vfg80000001P9FAAU", countryIso: "IN" },
    { id: "0vSg3", name: "Ontario (renamed)", isoCode: "ON", geoCountryId: "0vfg80000001SYXAA2", countryIso: "CA" },
  ],
};
const row = (countryCode: string, geoStateCode: string | null, scope: "country" | "state" | "region" = geoStateCode ? "state" : "country") => ({ countryCode, geoStateCode, scope });

/* ── 1. missing geography detection (ISO codes, parent-aware) ── */

test("status per row: Geo Country missing → Create Geo Country (also for its states); Geo State missing → Create Geo State; both → available", () => {
  const idx = indexOrgGeo(P10);
  assert.equal(geoStatusOf(row("AU", null), idx).status, "country-missing");
  assert.equal(geoStatusOf(row("AU", "AU-NSW"), idx).status, "country-missing", "a state waits for its Geo Country");
  assert.equal(geoStatusOf(row("IN", "IN-TN"), idx).status, "state-missing");
  const ka = geoStatusOf(row("IN", "IN-KA"), idx);
  assert.equal(ka.status, "available");
  assert.equal(ka.state!.id, "0vSg2");
  assert.equal(geoStatusOf(row("IN", null), idx).status, "available");
  assert.equal(geoStatusOf(row("CA", "CA-ON"), idx).status, "available", "matched by ISO code even though the org record's name differs");
  assert.equal(geoStatusOf(row("CA", "CA-AP"), idx).status, "state-missing", "IN's AP never satisfies a Canadian AP — the parent counts");
  assert.equal(geoStatusOf(row("ES", null, "region"), idx).status, "country-missing");
  assert.deepEqual(missingGeo([row("AU", null), row("AU", "AU-NSW"), row("AU", "AU-VIC"), row("IN", "IN-TN"), row("IN", "IN-KA")], idx), { countries: 1, states: 1, statesWithoutCountry: 2 });
});

test("plan from a FRESH read: country missing → create both; state missing → create state under the real parent; present → reuse Ids", () => {
  const none = planGeoFlow({ success: true, available: { geoCountry: true, geoState: true }, country: null, states: [] }, { country: { iso: "CA", name: "Canada" }, state: { code: "CA-BC", name: "British Columbia" } });
  assert.deepEqual(none, { kind: "create", needCountry: true, needState: true, existingCountry: null });
  const ca = { id: "0vfg80000001SYXAA2", name: "Canada", isoCode: "CA" };
  const st = planGeoFlow({ success: true, available: { geoCountry: true, geoState: true }, country: ca, states: [{ id: "0yxON", name: "Ontario", isoCode: "ON" }] }, { country: { iso: "CA", name: "Canada" }, state: { code: "CA-BC", name: "British Columbia" } });
  assert.deepEqual(st, { kind: "create", needCountry: false, needState: true, existingCountry: { id: "0vfg80000001SYXAA2", name: "Canada" } });
  const on = planGeoFlow({ success: true, available: { geoCountry: true, geoState: true }, country: ca, states: [{ id: "0yxON", name: "Ontario", isoCode: "ON" }] }, { country: { iso: "CA", name: "Canada" }, state: { code: "CA-ON", name: "Ontario" } });
  assert.equal(on.kind, "ready");
  if (on.kind === "ready") assert.deepEqual(on.resolved, { country: { id: "0vfg80000001SYXAA2", name: "Canada" }, state: { id: "0yxON", name: "Ontario" } });
  assert.equal(planGeoFlow({ success: true, available: { geoCountry: false, geoState: false }, country: null, states: [] }, { country: { iso: "CA", name: "Canada" }, state: null }).kind, "unavailable");
  // Scenario wording + exactly what will be written
  const both = { country: { iso: "CA", name: "Canada" }, state: { code: "CA-BC", name: "British Columbia" }, needCountry: true, needState: true, existingCountry: null, continueRate: { record: {} as never, usingKey: "k" } };
  assert.equal(geoFlowQuestion(both), "Geo Country Canada and Geo State British Columbia do not exist in Salesforce. Would you like to create both automatically before creating this Tax Rate?");
  assert.equal(geoFlowQuestion({ ...both, needCountry: false }), "Geo State British Columbia does not exist in Salesforce. Would you like to create it automatically before creating this Tax Rate?");
  assert.equal(geoFlowQuestion({ ...both, needCountry: false, continueRate: null }), "Geo State British Columbia does not exist in Salesforce. Would you like to create it automatically?");
  assert.deepEqual(geoFlowWrites({ ...both, needCountry: false, existingCountry: { id: "0vfg80000001SYXAA2", name: "Canada" } }), [{ object: "GeoState", fields: { Name: "British Columbia", IsoCode: "BC", GeoCountryId: "0vfg80000001SYXAA2 (Canada)" } }]);
  assert.deepEqual(geoFlowWrites(both).map(w => w.object), ["GeoCountry", "GeoState"], "Geo Country first");
});

/* ── duplicate prevention (validate + create, fresh read) ── */

test("geoIssues: duplicate ISO → error naming the existing record; own record on update isn't a duplicate; ISO and parent required", () => {
  const dup = geoIssues({ moduleKey: "geo-countries", isoCode: "IN", parentId: null, selfId: null, existing: [{ Id: "0vfg80000001P9FAAU", Name: "India" }] });
  assert.equal(dup.length, 1);
  assert.match(dup[0].message, /India \(0vfg80000001P9FAAU\) already has ISO code IN — no duplicate is created/);
  assert.deepEqual(geoIssues({ moduleKey: "geo-countries", isoCode: "IN", parentId: null, selfId: "0vfg80000001P9FAAU", existing: [{ Id: "0vfg80000001P9FAAU" }] }), []);
  assert.match(geoIssues({ moduleKey: "geo-countries", isoCode: null, parentId: null, selfId: null, existing: [] })[0].message, /ISO Code is required/);
  const orphan = geoIssues({ moduleKey: "geo-states", isoCode: "NSW", parentId: null, selfId: null, existing: [] });
  assert.ok(orphan.some(i => i.field === "GeoCountryId" && /create or select the Geo Country first/.test(i.message)));
  assert.match(geoIssues({ moduleKey: "geo-states", isoCode: "KA", parentId: "0vfg80000001P9FAAU", selfId: null, existing: [{ Id: "0vSg2", Name: "Karnataka" }] })[0].message, /under this Geo Country/);
});

test("the shared create/validate rules read Salesforce FRESH, by ISO code and parent GeoCountryId (never by name)", async () => {
  const soql: string[] = [];
  const client = { query: async (q: string) => { soql.push(q); return { records: q.includes("FROM GeoState") ? [{ Id: "0vSg2", Name: "Karnataka" }] : [] }; } } as unknown as SalesforceClient;
  const schema = { fields: [], statusField: null } as unknown as BillingModuleSchema;
  const st = await evaluateBillingRules({ client, moduleKey: "geo-states", schema, mode: "create", recordId: null, effective: { Name: "Karnataka", IsoCode: "ka", GeoCountryId: "0vfg80000001P9FAAU" }, current: null });
  assert.equal(soql[0], "SELECT Id, Name FROM GeoState WHERE IsoCode = 'KA' AND GeoCountryId = '0vfg80000001P9FAAU' LIMIT 5");
  assert.equal(st.issues.filter(i => i.severity === "error").length, 1, "an existing KA under India blocks the create");
  const gc = await evaluateBillingRules({ client, moduleKey: "geo-countries", schema, mode: "create", recordId: null, effective: { Name: "Australia", IsoCode: "AU" }, current: null });
  assert.equal(soql[1], "SELECT Id, Name FROM GeoCountry WHERE IsoCode = 'AU' LIMIT 5");
  assert.deepEqual(gc.issues, [], "no Australia yet → valid");
  // The create route re-validates (prepareAndValidate → evaluateBillingRules), so the check also runs at create time.
  assert.match(src("lib/billing/server/validate.ts"), /evaluateBillingRules\(\{/);
});

test("UI guards: Tax Rate only with real Geo Ids; missing geography → confirmation → automatic creation; browsing never writes", () => {
  const lib = src("components/data/taxes/library/TaxRateLibrary.tsx");
  const apply = lib.slice(lib.indexOf("const applyReferenceRate"), lib.indexOf("const detail = detailId"));
  assert.ok(!/left empty/.test(apply), "no more Geo Country is left empty fallthrough");
  assert.ok(apply.indexOf("setGeoFlow(") > 0 && apply.indexOf("setGeoFlow(") < apply.indexOf("onUseRate("), "missing geography opens the confirmation before the form");
  assert.match(apply, /Couldn.t read the Salesforce Geo records[\s\S]*return;/, "a failed lookup never opens the form");
  const run = lib.slice(lib.indexOf("const runGeoFlow"), lib.indexOf("const toggleIn"));
  assert.ok(run.includes("if (!flow || flow.busy) return;"), "a second click while creating does nothing");
  assert.ok(run.includes('quoteApiPost<EnsureGeoResponse>("Create Salesforce geography", "/api/taxes/rate-library/geo", { confirmed: true'), "the only Geo write, with explicit confirmation");
  const view = src("components/data/taxes/library/TaxMappingView.tsx");
  assert.ok(!/quoteApiPost/.test(view) && !/quoteApiPost/.test(src("components/data/taxes/library/TaxLibraryWidget.tsx")), "browsing / dashboard never write");
  assert.ok(src("app/api/taxes/rate-library/geo/route.ts").includes("if (body.confirmed !== true) return { success: false"), "the server refuses an unconfirmed write");
});

/* ── 2. usage: per user + org, recency vs frequency ── */

function memStorage(): UsageStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

test("usage is scoped to the app user AND the Salesforce connection; nothing is stored without both", () => {
  const st = memStorage();
  const a = usageScope("Alice@x.com", "https://p10.my.salesforce.com|005A");
  const b = usageScope("bob@x.com", "https://p10.my.salesforce.com|005B");
  const aOtherOrg = usageScope("alice@x.com", "https://p12.my.salesforce.com|005Z");
  trackUsage(st, a, { kind: "country-selected", countryCode: "IN", countryName: "India" }, 1000);
  assert.deepEqual(Object.keys(loadUsage(st, a).countries), ["IN"]);
  assert.deepEqual(loadUsage(st, b).countries, {}, "another user never sees it");
  assert.deepEqual(loadUsage(st, aOtherOrg).countries, {}, "another org never sees it");
  assert.equal(usageScope(null, "x|y"), null);
  assert.equal(usageScope("a@x.com", "none"), null);
  assert.equal(usageScope("a@x.com", "server"), null);
  assert.equal(trackUsage(st, null, { kind: "country-selected", countryCode: "IN", countryName: "India" }), null);
  assert.ok([...st.data.keys()].every(k => k.startsWith(TAX_USAGE_PREFIX)));
  assert.equal(loadUsage({ getItem: () => "{broken", setItem: () => undefined }, a).version, 1, "corrupt storage → empty, not a crash");
});

test("recordUsage: last-used timestamp, per-kind counts, rate history de-duplicated and bounded, invalid codes ignored", () => {
  let s = emptyUsage();
  s = recordUsage(s, { kind: "country-selected", countryCode: "au", countryName: "Australia" }, 10);
  s = recordUsage(s, { kind: "tax-rate-started", countryCode: "AU", countryName: "Australia", rate: { key: "r1|AU-NSW", taxCode: "AU-GST-STD-10", countryCode: "AU", countryName: "Australia", geoStateCode: "AU-NSW", geoStateName: "New South Wales", taxCategory: "Standard", ratePercent: 10 } }, 20);
  s = recordUsage(s, { kind: "tax-rate-started", countryCode: "AU", countryName: "Australia", rate: { key: "r1|AU-NSW", taxCode: "AU-GST-STD-10", countryCode: "AU", countryName: "Australia", geoStateCode: "AU-NSW", geoStateName: "New South Wales", taxCategory: "Standard", ratePercent: 10 } }, 30);
  assert.equal(s.countries.AU.lastUsedAt, 30);
  assert.deepEqual(s.countries.AU.events, { "country-selected": 1, "tax-rate-started": 2 });
  assert.equal(s.rates.length, 1);
  assert.equal(s.rates[0].count, 2);
  assert.equal(recordUsage(s, { kind: "country-selected", countryCode: "XYZ", countryName: "?" }), s);
  for (let i = 0; i < 40; i++) s = recordUsage(s, { kind: "tax-rate-started", countryCode: "IN", countryName: "India", rate: { key: `k${i}`, taxCode: "X", countryCode: "IN", countryName: "India", geoStateCode: null, geoStateName: null, taxCategory: null, ratePercent: 5 } }, 100 + i);
  assert.equal(s.rates.length, 30);
});

const names = (cc: string) => ({ IN: "India", AU: "Australia", US: "United States", CA: "Canada", IE: "Ireland", AF: "Afghanistan", SG: "Singapore", DE: "Germany", MX: "Mexico" } as Record<string, string>)[cc] ?? null;
const DATA = new Map([["US", 45], ["IE", 28], ["ES", 28], ["AU", 11], ["IN", 6], ["CA", 21]]);

test("dashboard ranking: recent → frequent (Salesforce configuration by this user) → org-configured → official data; de-duplicated", () => {
  let usage = emptyUsage();
  usage = recordUsage(usage, { kind: "country-selected", countryCode: "AU", countryName: "Australia" }, 100);
  usage = recordUsage(usage, { kind: "country-selected", countryCode: "IE", countryName: "Ireland" }, 200);
  const r = rankDashboardCountries({
    usage,
    myActivity: [{ iso: "IN", n: 15, lastAt: "2026-11-02T10:22:32Z" }, { iso: "IN", n: 3, lastAt: "2026-10-30T11:05:09Z" }, { iso: "MX", n: 1, lastAt: "2026-11-05T04:23:29Z" }, { iso: "AU", n: 2, lastAt: null }],
    configured: [{ iso: "IN", name: "India", n: 15 }, { iso: "SG", name: "Singapore", n: 2 }, { iso: "CA", name: "Canada", n: 2 }],
    dataCountries: DATA, names,
  });
  assert.deepEqual(r.recent.map(c => c.code), ["IE", "AU"], "most recent first");
  assert.deepEqual(r.frequent.map(c => [c.code, c.count]), [["IN", 18], ["MX", 1]], "Tax Rates + Geo States per country, recent countries not repeated");
  assert.deepEqual(r.configured.map(c => c.code), ["SG", "CA"]);
  assert.deepEqual(r.suggested.map(c => c.code), ["US", "ES"], "official data, most rates first; nothing already listed");
});

test("no-data countries never dominate: without usage or Tax Rates they're absent; with usage they're shown (flagged)", () => {
  const empty = rankDashboardCountries({ usage: emptyUsage(), myActivity: [], configured: [], dataCountries: DATA, names });
  assert.ok(!["AF", "DZ"].some(cc => [...empty.recent, ...empty.frequent, ...empty.configured, ...empty.suggested].some(c => c.code === cc)));
  assert.ok(empty.suggested.length > 0 && empty.suggested.every(c => c.hasData));
  const used = rankDashboardCountries({ usage: recordUsage(emptyUsage(), { kind: "country-selected", countryCode: "AF", countryName: "Afghanistan" }, 1), myActivity: [], configured: [], dataCountries: DATA, names });
  assert.deepEqual(used.recent.map(c => [c.code, c.hasData]), [["AF", false]], "real usage history is respected, marked as no tax data");
});

test("frequency counts configuration, not dropdown selections; local create events are the fallback when Salesforce can't be read", () => {
  let usage = emptyUsage();
  for (let i = 0; i < 9; i++) usage = recordUsage(usage, { kind: "country-selected", countryCode: "US", countryName: "United States" }, i);
  usage = recordUsage(usage, { kind: "geo-state-created", countryCode: "IN", countryName: "India" }, 50);
  const r = rankDashboardCountries({ usage, myActivity: null, configured: [], dataCountries: DATA, names, limits: { recent: 0 } });
  assert.deepEqual(r.frequent.map(c => [c.code, c.count]), [["IN", 1]], "9 US selections count for recency only");
});

test("dashboard wiring: widget on the Taxes dashboard; library opens with the chosen country; read-only Salesforce modes", () => {
  assert.match(src("components/data/taxes/TaxesDashboard.tsx"), /<TaxLibraryWidget isDark=\{isDark\} connectionKey=\{connectionKey\} onLaunch=\{onLaunch\} \/>/);
  const ws = src("components/data/taxes/TaxesWorkspace.tsx");
  assert.match(ws, /"library" in l\) go\(\{ kind: "rate-library", moduleKey: RATE_LIBRARY_MODULE, country: l\.library\.countryCode/);
  assert.match(ws, /<TaxRateLibrary isDark=\{isDark\} initialCountry=\{view\.country \?\? null\}/);
  const route = src("app/api/taxes/rate-library/salesforce/route.ts");
  assert.ok(!/export async function (POST|PATCH|PUT|DELETE)/.test(route));
  assert.match(route, /WHERE CreatedById = '\$\{uid\}'/, "frequency = records the CURRENT Salesforce user created");
});
