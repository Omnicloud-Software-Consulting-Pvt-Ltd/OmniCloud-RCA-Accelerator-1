import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import euTedb from "@/lib/taxLibrary/datasets/eu-tedb-vat.json";
import { COUNTRIES, SUBDIVISIONS, getCountry, getSubdivision, subdivisionsOf } from "@/lib/taxLibrary/jurisdictions";
import { COUNTRY_LEVEL, DEFAULT_PAGE_SIZE, PAGE_SIZES, REGION_SPECIFIC, foldText, queryLibrary, type LibraryQuery } from "@/lib/taxLibrary/library";
import { applyImport, previewImport } from "@/lib/taxLibrary/importExport";
import { computeCoverage, type BundledDataset } from "@/lib/taxLibrary/datasets";
import { recordsFromDataset, type ReferenceDataset } from "@/lib/taxLibrary/reference";
import { SEED_RATES } from "@/lib/taxLibrary/seed";
import { TaxLibraryStore, type KeyValueStorage } from "@/lib/taxLibrary/store";
import { buildTaxRatePrefill } from "@/lib/taxLibrary/prefill";
import type { TaxRateReference } from "@/lib/taxLibrary/types";

const DS = euTedb as unknown as BundledDataset;
const TODAY = "2026-11-06";
const LIB: TaxRateReference[] = applyImport(SEED_RATES, previewImport(SEED_RATES, DS.rows), { origin: "test" }).records;
const DEFAULT: LibraryQuery = { sort: { by: "country", dir: "asc" }, page: 1, pageSize: 15, statuses: ["Active", "Upcoming", "Expired", "Draft"], today: TODAY };
const q = (o: Partial<LibraryQuery>) => queryLibrary(LIB, { ...DEFAULT, pageSize: 200, ...o });
const codesOf = (cc: string) => new Set(subdivisionsOf(cc).map(s => s.code));
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const memory = (): KeyValueStorage => { const d = new Map<string, string>(); return { getItem: k => d.get(k) ?? null, setItem: (k, v) => void d.set(k, v), removeItem: k => void d.delete(k) }; };

/* ── Geographic dataset (ISO 3166) ── */

test("countries: complete ISO 3166-1 set, Afghanistan → Zimbabwe, unique alpha-2 / alpha-3 / numeric, alphabetical", () => {
  assert.equal(COUNTRIES.length, 249);
  assert.equal(COUNTRIES[0].name, "Afghanistan");
  assert.equal(COUNTRIES.at(-1)!.name, "Zimbabwe");
  for (const k of ["code", "alpha3", "numeric"] as const) assert.equal(new Set(COUNTRIES.map(c => c[k])).size, 249, `${k} unique`);
  assert.ok(COUNTRIES.every(c => /^[A-Z]{2}$/.test(c.code) && /^[A-Z]{3}$/.test(c.alpha3) && /^\d{3}$/.test(c.numeric)));
  const names = COUNTRIES.map(c => c.name);
  assert.deepEqual(names, names.slice().sort((a, b) => a.localeCompare(b)));
});

test("subdivisions: unique codes, every one belongs to a valid country and parent", () => {
  assert.ok(SUBDIVISIONS.length > 5000);
  assert.equal(new Set(SUBDIVISIONS.map(s => s.code)).size, SUBDIVISIONS.length, "no duplicate subdivision codes");
  for (const s of SUBDIVISIONS) {
    assert.ok(getCountry(s.countryCode), `${s.code} → ${s.countryCode}`);
    assert.ok(s.code.startsWith(`${s.countryCode}-`), s.code);
    assert.ok(s.parent === s.countryCode || getSubdivision(s.parent), `${s.code} parent ${s.parent}`);
  }
});

test("expected subdivisions: Australia, India, Canada, US, Brazil, Mexico, Germany, China, UK, UAE", () => {
  assert.deepEqual([...codesOf("AU")].sort(), ["AU-ACT", "AU-NSW", "AU-NT", "AU-QLD", "AU-SA", "AU-TAS", "AU-VIC", "AU-WA"]);
  for (const c of ["IN-AP", "IN-KA", "IN-MH", "IN-TN", "IN-CH", "IN-DL"]) assert.ok(codesOf("IN").has(c), c);
  assert.equal(subdivisionsOf("IN").find(s => foldText(s.name) === "telangana")?.code, "IN-TS", "Telangana (ISO name has a diacritic; code as in the dataset)");
  assert.equal(codesOf("IN").size, 36);
  assert.deepEqual([...codesOf("CA")].sort(), ["CA-AB", "CA-BC", "CA-MB", "CA-NB", "CA-NL", "CA-NS", "CA-NT", "CA-NU", "CA-ON", "CA-PE", "CA-QC", "CA-SK", "CA-YT"]);
  const us = codesOf("US");
  assert.equal([...us].filter(c => !["US-DC", "US-AS", "US-GU", "US-MP", "US-PR", "US-UM", "US-VI"].includes(c)).length, 50, "50 states");
  for (const c of ["US-DC", "US-PR", "US-GU", "US-VI", "US-AS", "US-MP"]) assert.ok(us.has(c), c);
  assert.ok(codesOf("BR").has("BR-DF") && codesOf("BR").size === 27);
  assert.ok(codesOf("MX").has("MX-CMX") && codesOf("MX").size === 32);
  assert.equal(codesOf("DE").size, 16);
  for (const c of ["CN-HK", "CN-MO", "CN-BJ"]) assert.ok(codesOf("CN").has(c), c);
  for (const c of ["GB-ENG", "GB-SCT", "GB-WLS", "GB-NIR"]) assert.ok(codesOf("GB").has(c), c);
  assert.equal(codesOf("AE").size, 7);
  assert.ok(codesOf("AF").size > 0 && codesOf("ZW").size > 0);
});

test("dropdowns come from the geographic catalog, never from tax-rate records", () => {
  const lib = read("components/data/taxes/library/TaxRateLibrary.tsx");
  assert.match(lib, /countryOptions = useMemo<SelectOption\[\]>\(\(\) => \(geo\?\.COUNTRIES \?\? \[\]\)\.map/);
  assert.match(lib, /\.\.\.subs\.map\(s => \(\{ value: s\.code/, "subdivision options = every ISO subdivision of the country");
  assert.ok(!/f\.countries\.map\(|records\.map\(r => \(\{ value: r\.jurisdiction/.test(lib), "not derived from rate records");
  assert.ok(subdivisionsOf("BR").length > 0 && q({ countryCode: "BR" }).total === 0, "a country with no rates still has its subdivisions");
});

/* ── Filters ── */

test("country filter: only that country, no cross-country leakage", () => {
  for (const cc of ["IN", "DE", "AU", "CA", "US"]) {
    const r = q({ countryCode: cc });
    assert.ok(r.total > 0, cc);
    assert.ok(r.rows.every(x => x.jurisdiction.countryCode === cc), cc);
  }
});

test("state filter by ISO code: the state's own rates + national rates (explicit rule); toggle off = state only", () => {
  const vic = q({ countryCode: "AU", subdivisionCode: "AU-VIC" });
  assert.deepEqual(vic.rows.map(r => r.tax.taxCode).sort(), ["GST10", "GSTFREE", "INPUTTAXED"], "Australia + Victoria → national GST rates");
  assert.equal(q({ countryCode: "AU", subdivisionCode: "AU-VIC", includeCountryLevel: false }).total, 0);
  const ap = q({ countryCode: "IN", subdivisionCode: "IN-AP" });
  assert.ok(ap.rows.every(r => r.jurisdiction.subdivisionCode === "IN-AP" || (!r.jurisdiction.subdivisionCode && r.jurisdiction.countryCode === "IN")));
  assert.ok(!ap.rows.some(r => r.jurisdiction.subdivisionCode === "IN-KA"), "no other state");
  assert.equal(q({ countryCode: "CA", subdivisionCode: "IN-AP" }).total, 0, "invalid country/state combination returns nothing");
});

test("combined filters from the brief", () => {
  assert.ok(q({ countryCode: "IN", subdivisionCode: "IN-AP", taxType: "GST" }).rows.every(r => r.tax.taxType === "GST" && r.jurisdiction.countryCode === "IN"));
  assert.ok(q({ countryCode: "IN", taxType: "IGST" }).rows.some(r => r.tax.taxCode === "IGST18"));
  assert.deepEqual(q({ countryCode: "CA", subdivisionCode: "CA-ON", taxType: "HST" }).rows.map(r => r.tax.taxCode), ["HST13"]);
  assert.deepEqual(q({ countryCode: "CA", subdivisionCode: "CA-QC", taxType: "QST" }).rows.map(r => r.tax.taxCode), ["QST9975"]);
  assert.deepEqual(q({ countryCode: "US", subdivisionCode: "US-CA", taxType: "Sales Tax" }).rows.map(r => r.tax.taxCode), ["CA-SALES-STATE"]);
  const deReduced = q({ countryCode: "DE", taxType: "VAT", q: "reduced" });
  assert.ok(deReduced.rows.every(r => r.jurisdiction.countryCode === "DE" && r.tax.taxType === "VAT"), "Germany VAT only");
  const allDeReduced = LIB.filter(r => r.jurisdiction.countryCode === "DE" && r.tax.taxCategory === "Reduced");
  assert.ok(allDeReduced.length > 0 && allDeReduced.every(r => deReduced.rows.includes(r)), "every German reduced rate found");
  assert.deepEqual(q({ countryCode: "CA", taxCode: "HST", asOf: "2024-01-01" }).rows.map(r => r.rate.ratePercent), [15]);
  assert.deepEqual(q({ countryCode: "CA", taxCode: "HST", asOf: "2026-01-01" }).rows.map(r => r.rate.ratePercent), [14]);
  const v = q({ countryCode: "FR", verification: ["verified"], q: "standard" });
  assert.ok(v.total > 0 && v.rows.every(r => r.source.verification === "verified" && r.jurisdiction.countryCode === "FR"));
  assert.equal(q({ countryCode: "IN", verification: ["verified"] }).total, 0, "unverified examples never pass as verified");
});

test("Country Level vs region-specific vs state; region-specific rates are labelled, not treated as national", () => {
  const es = q({ countryCode: "ES", subdivisionCode: COUNTRY_LEVEL });
  assert.ok(es.rows.some(r => r.tax.taxCode === "ES-VAT-STD-21") && !es.rows.some(r => r.tax.taxCode === "ES-VAT-STD-7"));
  assert.deepEqual(q({ countryCode: "ES", subdivisionCode: REGION_SPECIFIC }).rows.some(r => r.tax.taxCode === "ES-VAT-STD-7"), true);
  assert.ok(!q({ countryCode: "ES", subdivisionCode: "ES-M" }).rows.some(r => r.tax.taxCode === "ES-VAT-STD-7"), "Canary rate not shown for Madrid");
});

test("search: country, code, state (accent-insensitive), subdivision code, tax code/name/type/structure/component, classification, source", () => {
  assert.equal(foldText("Karnātaka Québec"), "karnataka quebec");
  assert.ok(q({ q: "karnataka" }).rows.some(r => r.jurisdiction.subdivisionCode === "IN-KA"), "diacritics");
  assert.ok(q({ q: "quebec" }).total >= 2);
  assert.ok(q({ q: "IN-AP" }).total >= 5);
  assert.ok(q({ q: "germany" }).total > 0 && q({ q: "DE-VAT-STD-19" }).total === 1);
  assert.ok(q({ q: "UTGST" }).total >= 1 && q({ q: "CGST + UTGST" }).total >= 2);
  assert.ok(q({ q: "FOODSTUFFS" }).total > 20);
  assert.ok(q({ q: "european commission" }).total === DS.rows.length, "search by source");
  assert.equal(q({ q: "zzzz-no-such-rate" }).total, 0);
});

test("clearing filters restores the default view (archived stay hidden)", () => {
  const filtered = q({ countryCode: "DE", taxType: "VAT" }).total;
  const cleared = queryLibrary(LIB, DEFAULT).total;
  assert.ok(filtered < cleared);
  assert.equal(cleared, LIB.filter(r => r.lifecycle !== "archived").length);
  const lib = read("components/data/taxes/library/TaxRateLibrary.tsx");
  assert.match(lib, /onClick=\{\(\) => setQuery\(\{ \.\.\.DEFAULT_QUERY, sort: query\.sort, pageSize: query\.pageSize \}\)\}/);
  assert.match(lib, /setQ = \(patch: Partial<LibraryQuery>\) => setQuery\(q => \(\{ \.\.\.q, \.\.\.patch, page: patch\.page \?\? 1 \}\)\)/, "any filter change resets to page 1");
  assert.match(lib, /onChange=\{v => setQ\(\{ countryCode: v \|\| null, subdivisionCode: null \}\)\}/, "country change resets the state");
});

/* ── Pagination ── */

test("pagination: default 15, sizes 10/15/25/50/100, every record exactly once across pages, stable order, correct x–y of N", () => {
  assert.equal(DEFAULT_PAGE_SIZE, 15);
  assert.deepEqual([...PAGE_SIZES], [10, 15, 25, 50, 100]);
  const total = queryLibrary(LIB, DEFAULT).total;
  for (const size of PAGE_SIZES) {
    const first = queryLibrary(LIB, { ...DEFAULT, pageSize: size, page: 1 });
    assert.equal(first.from, 1);
    assert.equal(first.to, Math.min(size, total));
    const seen: string[] = [];
    for (let p = 1; p <= first.pageCount; p++) seen.push(...queryLibrary(LIB, { ...DEFAULT, pageSize: size, page: p }).rows.map(r => r.id));
    assert.equal(seen.length, total, `size ${size}: nothing missing`);
    assert.equal(new Set(seen).size, total, `size ${size}: no duplicates`);
  }
  const a = queryLibrary(LIB, { ...DEFAULT, sort: { by: "rate", dir: "desc" }, pageSize: 50, page: 2 }).rows.map(r => r.id);
  const b = queryLibrary(LIB, { ...DEFAULT, sort: { by: "rate", dir: "desc" }, pageSize: 50, page: 2 }).rows.map(r => r.id);
  assert.deepEqual(a, b, "stable");
  const last = queryLibrary(LIB, { ...DEFAULT, page: 9999 });
  assert.equal(last.page, last.pageCount);
  assert.equal(last.to, total);
});

test("pagination: zero results → Showing 0–0 of 0, one empty page", () => {
  const r = q({ countryCode: "BR" });
  assert.deepEqual([r.total, r.from, r.to, r.page, r.pageCount, r.rows.length], [0, 0, 0, 1, 1, 0]);
  assert.match(read("components/data/taxes/library/TaxRateLibrary.tsx"), /Showing \{result\.from\}–\{result\.to\} of \{result\.total\} tax rate/);
});

/* ── Tax data coverage, seeding ── */

test("reference data is served from the bundled dataset (no user import), stable ids, and never overridden by the store", () => {
  const base = recordsFromDataset(DS as unknown as ReferenceDataset);
  assert.equal(base.length, DS.rows.length);
  assert.deepEqual(recordsFromDataset(DS as unknown as ReferenceDataset).map(r => r.id), base.map(r => r.id), "same rows → same ids");
  assert.equal(new Set(base.map(r => r.id)).size, base.length, "ids are unique");
  const store = new TaxLibraryStore(memory(), base);
  const loaded = store.load();
  assert.equal(loaded.records.length, DS.rows.length);
  assert.equal(loaded.userRecords, 0);
  const cov = computeCoverage(loaded.records, COUNTRIES.map(c => c.code), [DS.manifest]);
  assert.equal(cov.covered, 27);
  assert.equal(cov.countriesWithVerified, 27);
  assert.equal(cov.byCountry.get("BR")!.level, "missing", "geography alone ≠ tax coverage");
});

test("a country with zero records shows the dedicated empty state + its facts; prefill notes the tax name can't be set", () => {
  const lib = read("components/data/taxes/library/TaxRateLibrary.tsx");
  assert.match(lib, /No source-backed tax rates for /);
  assert.match(lib, /function CountryStatus/);
  assert.match(lib, /Geography:<\/span> \{subdivisions\} subdivision/);
  assert.match(lib, /data-testid="missing-scope"/);
  const p = buildTaxRatePrefill(LIB.find(r => r.tax.taxCode === "DE-VAT-STD-19")!, TODAY);
  assert.ok(p.notices.some(n => /TaxRate\.Name can't be set/.test(n)));
});

/* ── Salesforce isolation ── */


/** The library's single sanctioned write — confirmed Geo Country / Geo State creation (/api/taxes/rate-library/geo). Stripped before the no-write checks. */
const withoutGeoWrite = (src: string) => src
  .replace("import { quoteApiGet, quoteApiPost, toErrorPanelData } from \"@/lib/quotes/client/apiClient\";", "")
  .replace('quoteApiPost<EnsureGeoResponse>("Create Salesforce geography", "/api/taxes/rate-library/geo", { confirmed: true', "");

test("selecting / editing / versioning / seeding never write to Salesforce; only the existing form's Create does (plus confirmed Geo creation)", () => {
  for (const f of ["components/data/taxes/library/TaxRateLibrary.tsx", "components/data/taxes/library/SearchableSelect.tsx", "components/data/taxes/library/CoverageDashboard.tsx", "lib/taxLibrary/reference.ts", "lib/taxLibrary/store.ts", "lib/taxLibrary/library.ts"]) {
    const src = withoutGeoWrite(read(f));
    assert.ok(!/quoteApiPost|method:\s*"(POST|PATCH|PUT|DELETE)"|\/api\/billing\/tax-rates|\/api\/taxes\/objects/.test(src), f);
  }
  const lib = read("components/data/taxes/library/TaxRateLibrary.tsx");
  assert.match(lib, /label="Select" primary onClick=\{\(\) => setDetailId\(r\.id\)\}/, "select = view only");
  assert.match(lib, /onCreateInSalesforce=\{\(\) => applyReferenceRate\(detail\)\}/, "explicit button → existing form");
});

/* ── Searchable dropdown ranking (found in browser QA: "India" + Enter picked British Indian Ocean Territory) ── */
import { rankOptions } from "@/components/data/taxes/library/SearchableSelect";

test("country search ranks exact and prefix matches first", () => {
  const opts = COUNTRIES.map(c => ({ value: c.code, label: `${c.name} (${c.code})`, hint: c.alpha3 }));
  assert.equal(rankOptions(opts, "india")[0].value, "IN");
  assert.equal(rankOptions(opts, "IN")[0].value, "IN", "exact code");
  assert.equal(rankOptions(opts, "united states")[0].value, "US");
  assert.equal(rankOptions(opts, "niger")[0].value, "NE", "Niger before Nigeria");
  assert.equal(rankOptions(opts, "cote")[0].value, "CI", "accent-insensitive (Côte d'Ivoire)");
  const subs = subdivisionsOf("IN").map(s => ({ value: s.code, label: s.name, hint: s.code }));
  assert.equal(rankOptions(subs, "andhra")[0].value, "IN-AP");
  assert.equal(rankOptions(subs, "IN-KA")[0].value, "IN-KA");
  assert.equal(rankOptions([{ value: "", label: "All countries" }, ...opts], "").length, 250, "empty term keeps every option incl. All");
});
