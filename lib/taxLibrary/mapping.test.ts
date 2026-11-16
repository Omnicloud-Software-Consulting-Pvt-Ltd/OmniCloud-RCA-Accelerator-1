/**
 * Country → Geo State → Tax Rate mapping (lib/taxLibrary/mapping.ts) against the REAL bundled library data (EU TEDB + official
 * sources + ISO 3166) and small synthetic cases for edge conditions.
 *
 * Run: `npx tsx --test lib/taxLibrary/mapping.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as Geo from "./jurisdictions";
import { loadReferenceData, type CountryProfile } from "./reference";
import { buildMapping, queryMapping, rateView, type MappingRow } from "./mapping";
import { buildTaxRatePrefill } from "./prefill";
import type { TaxRateReference } from "./types";

const real = (async () => {
  const ref = await loadReferenceData();
  return { ref, ...buildMapping({ countries: Geo.COUNTRIES, subdivisionsOf: Geo.subdivisionsOf, records: ref.records, profiles: ref.profiles, asOf: "2026-11-09" }) };
})();
const of = (rows: MappingRow[], cc: string) => rows.filter(r => r.countryCode === cc);

/* ── real data ── */

test("coverage: every ISO country and every ISO subdivision is in the mapping, none hidden, no duplicate rows", async () => {
  const { rows, totals } = await real;
  assert.equal(totals.countries, 249);
  assert.equal(totals.geoStates, Geo.DATASET_INFO.subdivisions, "5,070 ISO 3166-2 subdivisions");
  for (const c of Geo.COUNTRIES) assert.ok(rows.some(r => r.countryCode === c.code && r.scope === "country"), `${c.code} has a Country-level row`);
  for (const s of Geo.SUBDIVISIONS) assert.ok(rows.some(r => r.geoStateCode === s.code), `${s.code} has at least one row`);
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length, "no duplicate mappings");
  assert.equal(totals.geoStatesWithRates + totals.geoStatesWithoutRates, totals.geoStates);
  assert.equal(totals.taxMappings, rows.filter(r => r.record).length);
});

test("Australia: all 8 states/territories carry the national GST (source: single national tax) — 10% standard, explicit 0%, exempt has no percentage", async () => {
  const { rows } = await real;
  const au = of(rows, "AU");
  const states = new Set(au.filter(r => r.scope === "state").map(r => r.geoStateCode));
  assert.equal(states.size, 8);
  for (const s of states) {
    const sr = au.filter(r => r.geoStateCode === s);
    assert.ok(sr.every(r => r.status === "inherited-national"), `${s}: marked as inherited, not as a state rate`);
    assert.ok(sr.some(r => r.taxCode === "AU-GST-STD-10" && r.rateDisplay === "10%"));
    assert.ok(sr.some(r => r.rateKind === "zero" && r.rateDisplay === "0%"), "0% shown explicitly");
    assert.ok(sr.filter(r => r.taxCategory === "Exempt").every(r => r.rateKind === "no-percentage" && r.rateDisplay !== "0%"), "a missing percentage is never shown as 0%");
    assert.ok(sr[0].ratesForGeo > 1, "multiple applicable rates");
  }
  assert.ok(au.find(r => r.status === "inherited-national")!.statusDetail!.includes("GST is a single national tax"));
});

test("Afghanistan / Algeria: no official source — every Geo State shown as 'Tax rate unavailable in source', never as 0%", async () => {
  const { rows } = await real;
  for (const [cc, n] of [["AF", Geo.subdivisionsOf("AF").length], ["DZ", Geo.subdivisionsOf("DZ").length]] as const) {
    const r = of(rows, cc);
    assert.equal(r.filter(x => x.scope === "state").length, n);
    assert.ok(r.every(x => x.status === "unavailable-in-source" && x.ratePercent === null && x.rateKind === "none"));
  }
});

test("Ireland / Spain: national VAT on the Country-level rows only; states show 'No Tax Rate Configured' (no assumed inheritance — e.g. Canary Islands)", async () => {
  const { rows } = await real;
  const ie = of(rows, "IE");
  assert.ok(ie.some(r => r.scope === "country" && r.taxCode === "IE-VAT-STD-23" && r.rateDisplay === "23%"));
  assert.ok(ie.filter(r => r.scope === "state").every(r => r.status === "no-rate-configured" && !r.record));
  const canary = of(rows, "ES").filter(r => r.geoStateCode === "ES-CN" || r.geoStateCode === "ES-GC" || r.geoStateCode === "ES-TF");
  assert.ok(canary.length > 0);
  assert.ok(canary.every(r => !r.record && r.status === "no-rate-configured"), "Spain's 21% is never put on the Canary Islands");
  assert.ok(of(rows, "ES").some(r => r.status === "region-specific"), "TEDB's Canary Islands row stays region-specific");
});

test("Canada / US: provincial and state rates by ISO 3166-2 code; national GST not copied onto provinces; multiple rates per state", async () => {
  const { rows } = await real;
  const ca = of(rows, "CA");
  assert.ok(ca.some(r => r.geoStateCode === "CA-BC" && r.status === "state-rate" && r.rateDisplay === "7%"));
  assert.ok(!ca.some(r => r.status === "inherited-national"));
  assert.ok(ca.some(r => r.geoStateCode === "CA-AB" && r.status === "no-rate-configured"));
  const al = of(rows, "US").filter(r => r.geoStateCode === "US-AL");
  assert.deepEqual(al.map(r => r.rateDisplay).sort(), ["2%", "4%"]);
  assert.ok(al.every(r => r.ratesForGeo === 2));
  assert.ok(of(rows, "US").some(r => r.scope === "country" && r.status === "no-rate-configured"), "no federal sales tax");
});

test("India: 36 Geo States each with the 6 national GST rows (uniform nationwide per the source)", async () => {
  const { rows } = await real;
  const inn = of(rows, "IN");
  const states = new Set(inn.filter(r => r.scope === "state").map(r => r.geoStateCode));
  assert.equal(states.size, Geo.subdivisionsOf("IN").length);
  for (const s of states) assert.equal(inn.filter(r => r.geoStateCode === s && r.status === "inherited-national").length, inn.filter(r => r.scope === "country").length);
});

test("query: paging returns every row exactly once; filters only narrow; search is accent-insensitive", async () => {
  const { rows } = await real;
  const seen: string[] = [];
  for (let page = 1; ; page++) { const r = queryMapping(rows, { page, pageSize: 500 }); seen.push(...r.rows.map(x => x.key)); if (page >= r.pageCount) break; }
  assert.equal(seen.length, rows.length);
  assert.equal(new Set(seen).size, rows.length);
  const au = queryMapping(rows, { countryCode: "AU", pageSize: 500 });
  assert.equal(au.geoStates, 8);
  const nsw = queryMapping(rows, { countryCode: "AU", stateQ: "south wales", pageSize: 500 });
  assert.ok(nsw.rows.length > 0 && nsw.rows.every(r => r.geoStateCode === "AU-NSW"));
  assert.ok(queryMapping(rows, { countryCode: "CA", stateQ: "quebec" }).rows.some(r => r.geoStateCode === "CA-QC"), "Québec found by 'quebec'");
  const zero = queryMapping(rows, { countryCode: "AU", taxCategory: "Zero", pageSize: 500 });
  assert.ok(zero.rows.length > 0 && zero.rows.every(r => r.taxCategory === "Zero"));
  assert.equal(queryMapping(rows, { countryCode: "AU", taxCode: "AU-GST-STD-10", pageSize: 500 }).total, 9, "1 national + 8 states");
  const sorted = queryMapping(rows, { countryCode: "US", sort: { by: "rate", dir: "desc" }, pageSize: 500 }).rows.map(r => r.ratePercent ?? -1);
  assert.deepEqual(sorted, sorted.slice().sort((a, b) => b - a));
  assert.equal(queryMapping(rows, { countryCode: "AU", statesOnly: true, pageSize: 500 }).rows.filter(r => r.scope !== "state").length, 0);
});

/* ── synthetic edge cases ── */

let n = 0;
function rec(cc: string, sub: string | null, code: string, pct: number | null, extra: Partial<{ category: string; to: string; lifecycle: TaxRateReference["lifecycle"]; fixed: number; subName: string }> = {}): TaxRateReference {
  const id = `t${++n}`;
  return {
    id, lineageId: id, version: 1, supersedesId: null, origin: "user", createdAt: "2026-01-01", updatedAt: "2026-01-01", history: [], lifecycle: extra.lifecycle ?? "published",
    jurisdiction: { countryCode: cc, countryName: cc, subdivisionCode: sub, subdivisionName: sub ? extra.subName ?? sub : null, level: sub ? "subdivision" : "country", locality: null },
    tax: { taxCode: code, taxName: code, taxType: "VAT", taxStructure: "VAT", taxComponent: null, taxAuthority: null, taxCategory: extra.category ?? "Standard" },
    rate: { ratePercent: pct, fixedAmount: extra.fixed ?? null, fixedAmountCurrency: null, minRatePercent: null, maxRatePercent: null, calculation: "percentage", compound: false, componentOrder: null },
    classification: { code: null, system: null, productCategory: null, serviceCategory: null, description: null, conditions: null, transactionType: null, placeOfSupply: null },
    effective: { effectiveFrom: "2020-01-01", effectiveTo: extra.to ?? null },
    source: { sourceName: "Test", sourceUrl: null, sourceReference: null, notes: null, verification: "verified", lastVerifiedAt: null },
  };
}
const profile = (cc: string, p: Partial<CountryProfile> = {}): [string, CountryProfile] => [cc, { countryCode: cc, status: "found", note: null, subnational: "not-assessed", local: "not-assessed", missingScope: [], ...p }];

test("synthetic: 0% vs missing, multiple codes, no subdivisions, expired/archived excluded, keys by code (same state name in two countries)", () => {
  const subs: Record<string, { code: string; name: string }[]> = { XA: [{ code: "XA-01", name: "North" }, { code: "XA-02", name: "South" }], XB: [{ code: "XB-01", name: "North" }], XC: [] };
  const records = [
    rec("XA", "XA-01", "XA-ZERO", 0, { category: "Zero" }), rec("XA", "XA-01", "XA-STD", 15), rec("XA", "XA-01", "XA-OLD", 12, { to: "2021-01-01" }), rec("XA", "XA-01", "XA-ARCH", 9, { lifecycle: "archived" }),
    rec("XB", null, "XB-STD", 5), rec("XC", null, "XC-STD", 7), rec("XC", null, "XC-FIX", null, { fixed: 2 }),
    rec("XA", "XA-99", "XA-EXTRA", 3, { subName: "Not in ISO" }),
  ];
  const { rows } = buildMapping({ countries: [{ code: "XA", name: "Xa" }, { code: "XB", name: "Xb" }, { code: "XC", name: "Xc" }], subdivisionsOf: cc => subs[cc] ?? [], records, profiles: new Map([profile("XA"), profile("XB"), profile("XC")]), asOf: "2026-11-09" });
  const north = rows.filter(r => r.geoStateCode === "XA-01");
  assert.deepEqual(north.map(r => [r.taxCode, r.rateDisplay]), [["XA-STD", "15%"], ["XA-ZERO", "0%"]], "expired and archived rates aren't mappings; 0% kept");
  assert.ok(north.every(r => r.ratesForGeo === 2));
  assert.deepEqual(rows.filter(r => r.geoStateCode === "XA-02").map(r => [r.status, r.rateDisplay]), [["no-rate-configured", "No Tax Rate Configured"]]);
  assert.ok(rows.some(r => r.geoStateCode === "XA-99" && r.taxCode === "XA-EXTRA"), "a subdivision code the record uses but ISO doesn't list is kept");
  // XB's "North" isn't confused with XA's "North": XB has no state rates and no inheritance (profile not "none").
  assert.deepEqual(rows.filter(r => r.geoStateCode === "XB-01").map(r => r.status), ["no-rate-configured"]);
  const xc = rows.filter(r => r.countryCode === "XC");
  assert.ok(xc.every(r => r.scope === "country"), "no subdivisions → country rows only");
  assert.deepEqual(xc.map(r => [r.taxCode, r.rateKind]).sort(), [["XC-FIX", "fixed"], ["XC-STD", "percent"]]);
  assert.equal(rateView(null).display, "No Tax Rate Configured");
});

test("synthetic: inheritance only when the profile says there's no state layer; no-consumption-tax and not-found stay distinct", () => {
  const subs = (cc: string) => [{ code: `${cc}-01`, name: "One" }];
  const records = [rec("YA", null, "YA-STD", 10), rec("YB", null, "YB-STD", 10)];
  const { rows } = buildMapping({
    countries: [{ code: "YA", name: "Ya" }, { code: "YB", name: "Yb" }, { code: "YC", name: "Yc" }, { code: "YD", name: "Yd" }], subdivisionsOf: subs, records, asOf: "2026-11-09",
    profiles: new Map([profile("YA", { subnational: "none" }), profile("YB", { subnational: "included" }), profile("YC", { status: "no-consumption-tax" }), profile("YD", { status: "not-found" })]),
  });
  assert.equal(rows.find(r => r.geoStateCode === "YA-01")!.status, "inherited-national");
  assert.equal(rows.find(r => r.geoStateCode === "YB-01")!.status, "no-rate-configured");
  assert.equal(rows.find(r => r.geoStateCode === "YC-01")!.status, "no-consumption-tax");
  assert.equal(rows.find(r => r.geoStateCode === "YD-01")!.status, "unavailable-in-source");
});

/* ── Tax Rate creation ── */

test("Create Tax Rate from a mapping row: an inherited row carries its Geo State; a state row keeps its own; foreign states are ignored", async () => {
  const { rows } = await real;
  const inherited = rows.find(r => r.geoStateCode === "AU-NSW" && r.taxCode === "AU-GST-STD-10")!;
  const p = buildTaxRatePrefill(inherited.record!, "2026-11-09", { state: { code: "AU-NSW", name: "New South Wales" } });
  assert.deepEqual([p.geo.countryIso, p.geo.stateIso, p.fields.TaxCode, p.fields.Rate], ["AU", "NSW", "AU-GST-STD-10", 10]);
  assert.ok(p.notices.some(x => /National rate selected for New South Wales/.test(x)));
  assert.equal(buildTaxRatePrefill(inherited.record!, "2026-11-09").geo.stateIso, null, "without a mapping state: country-level, no state invented");
  assert.equal(buildTaxRatePrefill(inherited.record!, "2026-11-09", { state: { code: "CA-BC", name: "BC" } }).geo.stateIso, null, "another country's state is ignored");
  const bc = rows.find(r => r.geoStateCode === "CA-BC" && r.status === "state-rate")!;
  const pb = buildTaxRatePrefill(bc.record!, "2026-11-09");
  assert.deepEqual([pb.geo.stateIso, pb.fields.Rate], ["BC", 7]);
});

test("guards: the mapping view never writes to Salesforce; the geo-states route only reads", () => {
  const ROOT = path.resolve(__dirname, "..", "..");
  const view = fs.readFileSync(path.join(ROOT, "components/data/taxes/library/TaxMappingView.tsx"), "utf8");
  assert.ok(!/quoteApiPost|method:\s*"(POST|PATCH|DELETE)"/.test(view));
  const route = fs.readFileSync(path.join(ROOT, "app/api/taxes/rate-library/salesforce/route.ts"), "utf8");
  assert.ok(!/export async function (POST|PATCH|PUT|DELETE)/.test(route));
  assert.match(route, /FROM GeoState WHERE \$\{parentField\} = /, "Geo States joined by the GeoCountry lookup, not by name");
});
