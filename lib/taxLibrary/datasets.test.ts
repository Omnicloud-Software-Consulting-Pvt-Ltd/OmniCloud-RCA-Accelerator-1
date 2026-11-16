import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import euTedb from "@/lib/taxLibrary/datasets/eu-tedb-vat.json";
import { EU_MEMBER_STATES, buildTedbRequest, parseTedbResponse, tedbToRows } from "@/lib/taxLibrary/tedb";
import { computeCoverage, type BundledDataset, type ImportLogEntry } from "@/lib/taxLibrary/datasets";
import { applyImport, parseImport, previewImport } from "@/lib/taxLibrary/importExport";
import { NO_COMPONENT, queryLibrary } from "@/lib/taxLibrary/library";
import { buildTaxRatePrefill } from "@/lib/taxLibrary/prefill";
import { SEED_RATES } from "@/lib/taxLibrary/seed";
import { COUNTRIES, getCountry } from "@/lib/taxLibrary/jurisdictions";
import { TaxLibraryStore, TAX_LIBRARY_KEY, type KeyValueStorage } from "@/lib/taxLibrary/store";
import type { TaxRateReference } from "@/lib/taxLibrary/types";

const DS = euTedb as unknown as BundledDataset;
const ALL = COUNTRIES.map(c => c.code);
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const memory = (): KeyValueStorage & { data: Map<string, string> } => { const data = new Map<string, string>(); return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: k => void data.delete(k) }; };
const importAll = (base: TaxRateReference[], ds: BundledDataset) => applyImport(base, previewImport(base, ds.rows), { origin: `dataset:${ds.manifest.id}` }).records;
const logFor = (ds: BundledDataset): ImportLogEntry => ({ at: "2026-11-05T12:00:00.000Z", datasetId: ds.manifest.id, name: ds.manifest.name, version: ds.manifest.version, source: ds.manifest.source, license: ds.manifest.license, origin: "test", coverage: ds.manifest.coverage, rows: ds.rows.length, created: ds.rows.length, updated: 0, unchanged: 0, conflicts: 0, errors: 0, unmapped: 0, errorSamples: [] });

/* ── TEDB (European Commission) parser + mapping, on a fixture in the service's real response format ── */

const FIXTURE = `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><ns0:retrieveVatRatesRespMsg xmlns="urn:x:types" xmlns:ns0="urn:x">
<additionalInformation/>
<vatRateResults><memberState>EL</memberState><type>STANDARD</type><rate><type>DEFAULT</type><value>24.0</value></rate><situationOn>2026-07-01+02:00</situationOn></vatRateResults>
<vatRateResults><memberState>EL</memberState><type>REDUCED</type><rate><type>REDUCED_RATE</type><value>13.0</value></rate><situationOn>2026-07-01+02:00</situationOn><cnCodes><code><value>0401</value><description>Milk</description></code></cnCodes><category><identifier>FOODSTUFFS</identifier><description>Foodstuffs &amp; drinks</description></category></vatRateResults>
<vatRateResults><memberState>EL</memberState><type>REDUCED</type><rate><type>REDUCED_RATE</type><value>13.0</value></rate><situationOn>2026-07-01+02:00</situationOn><cnCodes><code><value>0402</value><description>Cream</description></code></cnCodes><category><identifier>FOODSTUFFS</identifier><description>Foodstuffs &amp; drinks</description></category></vatRateResults>
<vatRateResults><memberState>EL</memberState><type>REDUCED</type><rate><type>EXEMPTED</type></rate><situationOn>2026-07-01+02:00</situationOn><category><identifier>MEDICAL_CARE</identifier><description>Medical care</description></category></vatRateResults>
<vatRateResults><memberState>EL</memberState><type>REDUCED</type><rate><type>NOT_APPLICABLE</type></rate><situationOn>2026-07-01+02:00</situationOn></vatRateResults>
<vatRateResults><memberState>ES</memberState><type>STANDARD</type><rate><type>DEFAULT</type><value>21.0</value></rate><situationOn>2026-07-01+02:00</situationOn></vatRateResults>
<vatRateResults><memberState>ES</memberState><type>STANDARD</type><rate><type>DEFAULT</type><value>7.0</value></rate><situationOn>2026-07-01+02:00</situationOn><comment>VAT - Canary Islands -</comment></vatRateResults>
</ns0:retrieveVatRatesRespMsg></env:Body></env:Envelope>`;

test("TEDB: parses the official response format (namespaces, entities, every rate type) and throws on a SOAP fault", () => {
  const r = parseTedbResponse(FIXTURE);
  assert.equal(r.length, 7);
  assert.deepEqual([r[0].memberState, r[0].type, r[0].rateType, r[0].value, r[0].situationOn], ["EL", "STANDARD", "DEFAULT", 24, "2026-07-01"]);
  assert.equal(r[1].category?.description, "Foodstuffs & drinks");
  assert.equal(r[3].rateType, "EXEMPTED");
  assert.equal(r[3].value, null);
  assert.throws(() => parseTedbResponse("<env:Envelope><env:Body><env:Fault><faultstring>00002 invalid country</faultstring></env:Fault></env:Body></env:Envelope>"), /fault/i);
  assert.match(buildTedbRequest(["GR", "DE"], "2026-11-05"), /<urn1:isoCode>EL<\/urn1:isoCode><urn1:isoCode>DE<\/urn1:isoCode>.*<urn1:situationOn>2026-11-05</);
});

test("TEDB mapping: EL→GR, merged CN codes per category, exempt = 0 %, no-rate entries skipped, regional rates marked, app-generated codes stated", () => {
  const { rows, skipped, countries } = tedbToRows(parseTedbResponse(FIXTURE), { retrievedOn: "2026-11-05" });
  assert.deepEqual(countries, ["ES", "GR"]);
  assert.equal(skipped.length, 1);
  const food = rows.find(r => r.classificationCode === "FOODSTUFFS")!;
  assert.equal(food.countryCode, "GR");
  assert.equal(food.taxCode, "GR-VAT-RED-13");
  assert.match(String(food.conditions), /CN: 0401, 0402/);
  const exempt = rows.find(r => r.classificationCode === "MEDICAL_CARE")!;
  assert.deepEqual([exempt.ratePercent, exempt.taxCode, exempt.taxCategory], [0, "GR-VAT-EXEMPT", "Exempt"]);
  const canary = rows.find(r => r.taxCode === "ES-VAT-STD-7")!;
  assert.match(String(canary.locality), /Canary Islands/);
  assert.match(String(canary.placeOfSupply), /not country-wide/);
  assert.equal(rows.find(r => r.taxCode === "ES-VAT-STD-21")!.locality, null, "the national rate stays national");
  for (const row of rows) {
    assert.equal(row.verification, "verified");
    assert.equal(row.lastVerifiedAt, "2026-11-05");
    assert.match(String(row.notes), /App-generated Tax Code/);
    assert.match(String(row.sourceName), /European Commission/);
  }
});

/* ── The bundled EU dataset (retrieved from TEDB 2026-11-05) ── */

test("bundled EU dataset: official source, all 27 Member States, every row valid, verified, multiple rates per country", () => {
  assert.equal(DS.manifest.id, "eu-tedb-vat");
  assert.match(DS.manifest.license, /2011\/833\/EU/);
  assert.equal(DS.manifest.coverage.countries.length, 27);
  assert.ok(DS.manifest.coverage.countries.includes("GR") && !DS.manifest.coverage.countries.includes("EL"));
  const countries = new Set(DS.rows.map(r => String(r.countryCode)));
  assert.equal(countries.size, 27);
  for (const cc of countries) assert.ok(getCountry(cc), cc);
  const preview = previewImport([], DS.rows);
  assert.ok(preview.every(p => p.action === "create"), preview.filter(p => p.action !== "create").map(p => `${p.label}: ${p.errors[0]?.message}`).join(" | "));
  assert.ok(DS.rows.every(r => r.verification === "verified" && r.sourceUrl === "https://ec.europa.eu/taxation_customs/tedb/"));
  const de = DS.rows.filter(r => r.countryCode === "DE");
  assert.ok(de.some(r => r.taxCode === "DE-VAT-STD-19") && de.some(r => r.taxCode === "DE-VAT-RED-7"), "standard and reduced");
  assert.ok(DS.rows.some(r => r.taxCategory === "Super-reduced") && DS.rows.some(r => r.taxCategory === "Parking") && DS.rows.some(r => r.taxCategory === "Exempt"));
  assert.ok(DS.rows.filter(r => r.classificationSystem === "TEDB category").length > 300, "classification-specific rates");
  assert.ok(DS.rows.every(r => typeof r.taxCode === "string" && !String(r.taxCode).startsWith("EL-")));
});

/* ── Coverage ── */

test("coverage: jurisdictions alone are NOT tax-rate coverage", () => {
  const c = computeCoverage([], ALL, []);
  assert.equal(c.countriesTotal, 249);
  assert.equal(c.missing, 249);
  assert.equal(c.covered + c.partial, 0);
  assert.equal(c.records, 0);
});

test("coverage: seed examples = partial (no completeness claim); an applied dataset makes its countries covered for ITS scope; verification counted separately", () => {
  const seedOnly = computeCoverage(SEED_RATES, ALL, []);
  for (const cc of ["IN", "CA", "AU", "US"]) assert.equal(seedOnly.byCountry.get(cc)!.level, "partial", cc);
  assert.equal(seedOnly.covered, 0);
  assert.equal(seedOnly.verifiedRecords, 0);
  const lib = importAll(SEED_RATES, DS);
  const withEu = computeCoverage(lib, ALL, [logFor(DS)]);
  assert.equal(withEu.covered, 27);
  assert.equal(withEu.byCountry.get("DE")!.level, "covered");
  assert.match(withEu.byCountry.get("DE")!.scopes[0], /National VAT/);
  assert.equal(withEu.byCountry.get("IN")!.level, "partial");
  assert.equal(withEu.byCountry.get("BR")!.level, "missing");
  assert.equal(withEu.missing, 249 - 27 - 4);
  assert.equal(withEu.verifiedRecords, DS.rows.length);
  assert.equal(withEu.unverifiedRecords, SEED_RATES.length);
  assert.ok(withEu.jurisdictionsVerified >= 27 && withEu.jurisdictionsUnverified > 0);
  assert.equal(withEu.lastDatasetUpdate, "2026-11-05");
});

/* ── Tax codes, components, filters ── */

test("tax code families: GST/CGST/SGST/IGST/UTGST, HST/PST/QST/RST, US sales tax, GST-free / input-taxed, EU VAT standard/reduced/super-reduced/parking/exempt", () => {
  const lib = importAll(SEED_RATES, DS);
  const types = new Set(lib.map(r => r.tax.taxType));
  for (const t of ["GST", "CGST", "SGST", "IGST", "UTGST", "HST", "PST", "QST", "RST", "Sales Tax", "VAT"]) assert.ok(types.has(t), t);
  const codes = new Set(lib.map(r => r.tax.taxCode));
  for (const c of ["GSTFREE", "INPUTTAXED", "CA-SALES-STATE", "GST18-UTGST", "FR-VAT-STD-20"]) assert.ok(codes.has(c), c);
  assert.ok(lib.some(r => r.tax.taxCategory === "Super-reduced") && lib.some(r => r.tax.taxCategory === "Exempt"));
  assert.notEqual(lib.find(r => r.tax.taxCode === "GST18-UTGST")!.tax.taxName, lib.find(r => r.tax.taxCode === "GST18-UTGST")!.tax.taxStructure, "code, name and structure are distinct");
});

test("filters: tax code, tax component (incl. 'not a component') and effective-on-date", () => {
  const lib = importAll(SEED_RATES, DS);
  const q = (o: Parameters<typeof queryLibrary>[1]) => queryLibrary(lib, { pageSize: 200, today: "2026-11-05", ...o });
  assert.ok(q({ taxCode: "DE-VAT-STD-19" }).rows.every(r => r.tax.taxCode === "DE-VAT-STD-19"));
  assert.ok(q({ taxComponent: "QST" }).rows.every(r => r.tax.taxComponent === "QST"));
  assert.ok(q({ countryCode: "CA", taxComponent: NO_COMPONENT }).rows.every(r => !r.tax.taxComponent));
  // Nova Scotia's own HST history (national GST excluded explicitly; with it included, GST 5% is also listed — see browse.test).
  const asOf2020 = q({ countryCode: "CA", subdivisionCode: "CA-NS", includeCountryLevel: false, asOf: "2020-06-01" }).rows;
  assert.deepEqual(asOf2020.map(r => r.rate.ratePercent), [15], "historical rate on a past date");
  assert.deepEqual(q({ countryCode: "CA", subdivisionCode: "CA-NS", includeCountryLevel: false, asOf: "2026-01-01" }).rows.map(r => r.rate.ratePercent), [14]);
  assert.deepEqual(q({ countryCode: "CA", subdivisionCode: "CA-NS", asOf: "2026-01-01" }).rows.map(r => r.rate.ratePercent).sort((a, b) => (a ?? 0) - (b ?? 0)), [5, 14], "with national GST included");
  assert.ok(q({ countryCode: "IN", asOf: "2026-01-01" }).rows.every(r => r.tax.taxCode !== "GST12"), "expired slab excluded on a later date");
});

/* ── Import: missing jurisdictions, re-import, log, storage ── */

test("import preview flags missing jurisdictions separately from invalid rows; re-importing a dataset is idempotent", () => {
  const rows = parseImport([
    "countryCode,subdivisionCode,taxCode,taxName,taxType,taxStructure,ratePercent,effectiveFrom",
    "ZZ,,VAT20,VAT,VAT,VAT,20,2020-01-01",
    "CA,IN-AP,GST5,GST,GST,GST,5,2020-01-01",
    "CA,CA-ON,,No code,HST,HST,13,2020-01-01",
  ].join("\n"), "csv").rows;
  assert.deepEqual(previewImport([], rows).map(p => p.action), ["unmapped", "unmapped", "error"]);
  const lib = importAll([], DS);
  assert.ok(previewImport(lib, DS.rows).every(p => p.action === "unchanged"), "no duplicates on re-import");
});

test("store: reference data is never written to browser storage — only the user's own changes are (overlay)", () => {
  const mem = memory();
  const base = importAll([], DS);
  const s = new TaxLibraryStore(mem, base);
  const first = s.load();
  assert.equal(first.records.length, DS.rows.length);
  assert.ok(s.save(first.records, first.revision).ok, "saving unchanged reference data stores nothing");
  assert.equal(JSON.parse(mem.data.get(TAX_LIBRARY_KEY)!).records.length, 0);
  const edited = first.records.map((r, i) => (i === 0 ? { ...r, source: { ...r.source, notes: "my note" } } : r));
  assert.ok(s.save(edited, s.load().revision).ok);
  const again = new TaxLibraryStore(mem, base).load();
  assert.equal(again.records.length, DS.rows.length, "the edited copy replaces the reference copy (no duplicate)");
  assert.equal(again.records[0].source.notes, "my note");
  assert.equal(again.userRecords, 1);
  assert.match(DS.manifest.license, /2011\/833\/EU/);
  const bytes = [...mem.data.values()].reduce((n, v) => n + v.length * 2, 0);
  assert.ok(bytes < 64 * 1024, `stored ${Math.round(bytes / 1024)} KB — only the overlay`);
  // Clearing site data loses only user edits — the reference data is rebuilt from the bundle.
  assert.equal(new TaxLibraryStore(memory(), base).load().records.length, DS.rows.length);
});

/* ── Explicit Create Tax Rate in Salesforce; isolation ── */

test("selecting a rate only opens its detail; 'Create Tax Rate in Salesforce' is an explicit button there", () => {
  const lib = read("components/data/taxes/library/TaxRateLibrary.tsx");
  assert.match(lib, /label="Select" primary onClick=\{\(\) => setDetailId\(r\.id\)\}/);
  assert.ok(!/label=\{using === r\.id \? "Opening…" : "Use This Rate"\}/.test(lib), "no one-click prefill from the table");
  assert.match(lib, /"Create Tax Rate in Salesforce"/);
  assert.match(lib, /onCreateInSalesforce=\{\(\) => applyReferenceRate\(detail\)\}/);
  assert.match(lib, /Nothing is created until you review, validate and click Create there; cancelling creates nothing/);
});

test("prefill shows the reference record and its source; nothing is activated (TaxRate has no status) or assigned", () => {
  const de = importAll([], DS).find(r => r.tax.taxCode === "DE-VAT-STD-19")!;
  const p = buildTaxRatePrefill(de, "2026-11-05");
  assert.ok(p.notices.some(n => /Reference source: European Commission .* verified 2026-11-05 · reference record/.test(n)));
  assert.deepEqual(Object.keys(p.fields).sort(), ["Rate", "StartDate", "TaxCode"]);
  assert.equal(p.requiresConfirmation, false, "a verified, active rate needs no extra confirmation");
  const canary = importAll([], DS).find(r => r.tax.taxCode === "ES-VAT-STD-7")!;
  assert.ok(buildTaxRatePrefill(canary, "2026-11-05").notices.some(n => /Region-specific/.test(n)));
});

test("cancel creates nothing: the create form's Cancel only navigates back", () => {
  const ws = read("components/data/taxes/TaxesWorkspace.tsx");
  assert.match(ws, /onCancel=\{\(\) => go\(\{ kind: "module", moduleKey: view\.moduleKey \}\)\}/);
  assert.match(ws, /onOpenSalesforceRates=\{\(\) => go\(\{ kind: "history", moduleKey: RATE_LIBRARY_MODULE \}\)\}/, "existing Salesforce rates keep their own edit workflow");
});


/** The library's single sanctioned write — confirmed Geo Country / Geo State creation (/api/taxes/rate-library/geo). Stripped before the no-write checks. */
const withoutGeoWrite = (src: string) => src
  .replace("import { quoteApiGet, quoteApiPost, toErrorPanelData } from \"@/lib/quotes/client/apiClient\";", "")
  .replace('quoteApiPost<EnsureGeoResponse>("Create Salesforce geography", "/api/taxes/rate-library/geo", { confirmed: true', "");

test("TEDB acquisition is internal only: no user-facing live-import route; library UI never writes to Salesforce (except confirmed Geo creation)", () => {
  assert.ok(!fs.existsSync(path.join(process.cwd(), "app/api/taxes/rate-library/tedb")), "the live-import route was removed with the Import UI");
  assert.match(read("scripts/tax-datasets/build-eu-tedb.ts"), /tedb/i, "the internal build script remains");
  assert.equal(EU_MEMBER_STATES.length, 27);
  for (const f of ["components/data/taxes/library/TaxRateLibrary.tsx", "components/data/taxes/library/CoverageDashboard.tsx"]) assert.ok(!/quoteApiPost|method:\s*"(POST|PATCH|PUT|DELETE)"/.test(withoutGeoWrite(read(f))), f);
});
