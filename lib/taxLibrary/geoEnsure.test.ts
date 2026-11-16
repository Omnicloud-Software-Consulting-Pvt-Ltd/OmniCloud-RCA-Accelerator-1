/**
 * Global Tax Library — automatic Geo creation + Tax Rate relationships + default country order.
 * The Salesforce side is an in-memory GeoApi (same contract as the real route's adapter: SOQL in, sObject create out) — MOCKED:
 * no live Salesforce write was made by these tests.
 *
 * Run: `npx tsx --test lib/taxLibrary/geoEnsure.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as Geo from "./jurisdictions";
import { loadReferenceData } from "./reference";
import { buildMapping, queryMapping } from "./mapping";
import { ensureGeography, metaProblem, stateIsoOf, validateEnsureInput, verifyRateGeo, type GeoApi, type GeoObjectMeta } from "./server/geoEnsure";
import { countryPriority, emptyUsage, recordUsage } from "./usage";
import { geoStateParentIssue } from "@/lib/billing/server/rules";
import { buildTaxRatePrefill } from "./prefill";

const ROOT = path.resolve(__dirname, "..", "..");
const src = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

type Row = Record<string, string>;
/** In-memory Salesforce: GeoCountry.IsoCode unique (DUPLICATE_VALUE like Salesforce), GeoState.IsoCode NOT unique. */
function fakeSf(opts: { seed?: { GeoCountry?: Row[]; GeoState?: Row[] }; meta?: Partial<Record<"GeoCountry" | "GeoState", GeoObjectMeta | null>>; failCreate?: Partial<Record<"GeoCountry" | "GeoState", { errorCode: string; message: string }>>; delayMs?: number; raceCountry?: Row } = {}) {
  const store = { GeoCountry: [...(opts.seed?.GeoCountry ?? [])], GeoState: [...(opts.seed?.GeoState ?? [])] };
  const creates: { sobject: string; fields: Record<string, string> }[] = [];
  let n = 0;
  const defaultMeta = (o: "GeoCountry" | "GeoState"): GeoObjectMeta => o === "GeoCountry"
    ? { createable: true, fields: { Name: { createable: true, required: false }, IsoCode: { createable: true, required: true }, OwnerId: { createable: true, required: false } } }
    : { createable: true, fields: { Name: { createable: true, required: false }, IsoCode: { createable: true, required: true }, GeoCountryId: { createable: true, required: true } } };
  const api: GeoApi = {
    async query(soql) {
      const m = /FROM (GeoCountry|GeoState) WHERE (.*?) LIMIT/.exec(soql)!;
      const conds = [...m[2].matchAll(/(\w+) = '([^']*)'/g)].map(x => [x[1], x[2]] as const);
      return store[m[1] as "GeoCountry" | "GeoState"].filter(r => conds.every(([k, v]) => (r[k] ?? "") === v));
    },
    async create(sobject, fields) {
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      const fail = opts.failCreate?.[sobject];
      if (fail) return { ok: false, status: 400, ...fail };
      if (sobject === "GeoCountry" && opts.raceCountry) { store.GeoCountry.push(opts.raceCountry); return { ok: false, status: 400, errorCode: "DUPLICATE_VALUE", message: "duplicate value found: IsoCode" }; }
      if (sobject === "GeoCountry" && store.GeoCountry.some(c => c.IsoCode === fields.IsoCode)) return { ok: false, status: 400, errorCode: "DUPLICATE_VALUE", message: "duplicate value found: IsoCode" };
      creates.push({ sobject, fields });
      const id = `${sobject === "GeoCountry" ? "0vf" : "0yx"}NEW${String(++n).padStart(12, "0")}`;
      store[sobject].push({ Id: id, ...fields });
      return { ok: true, id };
    },
    async meta(o) { return o in (opts.meta ?? {}) ? opts.meta![o]! : defaultMeta(o); },
  };
  return { api, store, creates };
}
const CANADA = { Id: "0vfg80000001SYXAA2", Name: "Canada", IsoCode: "CA" };
const INDIA = { Id: "0vfg80000001P9FAAU", Name: "India", IsoCode: "IN" };
const BC = { country: { iso: "CA", name: "Canada" }, state: { code: "CA-BC", name: "British Columbia" } };

/* ── ISO resolution from the existing dataset ── */

test("ISO codes come from the ISO 3166 dataset: Canada = CA, British Columbia = CA-BC → GeoState.IsoCode BC (also ON, NSW, AP)", () => {
  assert.equal(Geo.resolveCountryCode("Canada"), "CA");
  assert.equal(Geo.resolveSubdivisionCode("British Columbia", "CA"), "CA-BC");
  assert.equal(stateIsoOf("CA-BC"), "BC");
  assert.equal(Geo.salesforceStateIso(Geo.resolveSubdivisionCode("Ontario", "CA")!), "ON");
  assert.equal(Geo.salesforceStateIso(Geo.resolveSubdivisionCode("New South Wales", "AU")!), "NSW");
  assert.equal(Geo.salesforceStateIso(Geo.resolveSubdivisionCode("Andhra Pradesh", "IN")!), "AP");
  assert.equal(validateEnsureInput({ country: { iso: "CA", name: "Canada" }, state: { code: "AU-NSW", name: "New South Wales" } })?.includes("isn't an ISO 3166-2 code of CA"), true, "a subdivision of another country is refused");
});

/* ── Scenario B: Geo Country exists, Geo State missing ── */

test("Create Geo State British Columbia: parent = the REAL Canada GeoCountry Id; ISO BC; Salesforce Id returned and read back", async () => {
  const sf = fakeSf({ seed: { GeoCountry: [CANADA] } });
  const r = await ensureGeography(sf.api, BC);
  assert.equal(r.ok, true, r.error ?? "");
  assert.deepEqual(sf.creates, [{ sobject: "GeoState", fields: { Name: "British Columbia", IsoCode: "BC", GeoCountryId: "0vfg80000001SYXAA2" } }], "only the missing Geo State is created");
  assert.equal(r.country!.id, "0vfg80000001SYXAA2");
  assert.equal(r.country!.created, false);
  assert.match(r.state!.id, /^0yxNEW/, "the Id Salesforce returned");
  assert.equal(r.state!.geoCountryId, "0vfg80000001SYXAA2");
  assert.equal(r.state!.isoCode, "BC");
  assert.ok(r.steps.some(s => s.action === "verified" && s.object === "GeoState"));
});

/* ── Scenario C: both missing ── */

test("both missing: Geo Country Canada (CA) is created FIRST, then British Columbia linked to the new Canada Id", async () => {
  const sf = fakeSf();
  const r = await ensureGeography(sf.api, BC);
  assert.equal(r.ok, true, r.error ?? "");
  assert.deepEqual(sf.creates.map(c => c.sobject), ["GeoCountry", "GeoState"]);
  assert.deepEqual(sf.creates[0].fields, { Name: "Canada", IsoCode: "CA" });
  assert.equal(sf.creates[1].fields.GeoCountryId, r.country!.id, "the state's parent is the country just created");
  assert.equal(r.country!.created && r.state!.created, true);
});

/* ── reuse / no duplicates ── */

test("existing Geo State under the correct parent is reused (no write); a BC under ANOTHER country is never reused", async () => {
  const sf = fakeSf({ seed: { GeoCountry: [CANADA, INDIA], GeoState: [{ Id: "0yxBCCA", Name: "British Columbia", IsoCode: "BC", GeoCountryId: "0vfg80000001SYXAA2" }] } });
  const r = await ensureGeography(sf.api, BC);
  assert.deepEqual([r.ok, r.state!.id, r.state!.created, sf.creates.length], [true, "0yxBCCA", false, 0]);
  const wrongParent = fakeSf({ seed: { GeoCountry: [CANADA, INDIA], GeoState: [{ Id: "0yxBCIN", Name: "Bogus", IsoCode: "BC", GeoCountryId: "0vfg80000001P9FAAU" }] } });
  const w = await ensureGeography(wrongParent.api, BC);
  assert.notEqual(w.state!.id, "0yxBCIN", "India's 'BC' is not Canada's British Columbia");
  assert.equal(wrongParent.creates.length, 1);
  assert.equal(w.state!.geoCountryId, "0vfg80000001SYXAA2");
});

test("repeated clicks: identical concurrent requests share ONE run — one Geo Country, one Geo State", async () => {
  const sf = fakeSf({ delayMs: 15 });
  const [a, b, c] = await Promise.all([ensureGeography(sf.api, BC, "org1"), ensureGeography(sf.api, BC, "org1"), ensureGeography(sf.api, BC, "org1")]);
  assert.deepEqual(sf.creates.map(x => x.sobject), ["GeoCountry", "GeoState"]);
  assert.equal(a.state!.id, b.state!.id);
  assert.equal(b.state!.id, c.state!.id);
  const again = await ensureGeography(sf.api, BC, "org1");
  assert.equal(again.state!.created, false, "a later click finds and reuses it");
  assert.equal(sf.creates.length, 2);
});

test("a concurrent Geo Country create elsewhere (DUPLICATE_VALUE on the unique IsoCode) → re-read and reuse, not an error", async () => {
  const sf = fakeSf({ raceCountry: { Id: "0vfOTHERTAB0000001", Name: "Canada", IsoCode: "CA" } });
  const r = await ensureGeography(sf.api, BC);
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.country!.id, "0vfOTHERTAB0000001");
  assert.ok(r.steps.some(s => s.action === "reused-after-duplicate"));
  assert.equal(sf.creates.at(-1)!.fields.GeoCountryId, "0vfOTHERTAB0000001");
});

/* ── errors / permissions / partial ── */

test("Salesforce errors and permissions are reported verbatim; Geo Country created but Geo State failed → partial, kept, Tax Rate not opened", async () => {
  const noPerm = fakeSf({ meta: { GeoCountry: { createable: false, fields: {} } } });
  const p = await ensureGeography(noPerm.api, BC);
  assert.equal(p.ok, false);
  assert.match(p.error!, /can't create GeoCountry records \(needs the Create permission on Geo Country\)/);
  assert.equal(noPerm.creates.length, 0);
  const rejected = fakeSf({ seed: { GeoCountry: [CANADA] }, failCreate: { GeoState: { errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: "FIELD_CUSTOM_VALIDATION_EXCEPTION: ISO code not allowed" } } });
  const v = await ensureGeography(rejected.api, BC);
  assert.equal(v.ok, false);
  assert.match(v.error!, /Salesforce didn't create Geo State British Columbia \(BC\) under Canada: FIELD_CUSTOM_VALIDATION_EXCEPTION: ISO code not allowed/);
  assert.equal(v.partial, null, "nothing was created");
  const partial = fakeSf({ failCreate: { GeoState: { errorCode: "INSUFFICIENT_ACCESS_OR_READONLY", message: "insufficient access rights" } } });
  const pr = await ensureGeography(partial.api, BC);
  assert.equal(pr.ok, false);
  assert.equal(pr.country!.created, true);
  assert.match(pr.partial!, /Geo Country Canada \(CA, 0vfNEW\w+\) was created and is kept, but Geo State British Columbia wasn't created/);
  assert.equal(partial.store.GeoCountry.length, 1, "the created Geo Country stays");
  assert.match(metaProblem("GeoState", { createable: true, fields: { IsoCode: { createable: true, required: true }, GeoCountryId: { createable: true, required: true }, Region__c: { createable: true, required: true } } }, ["Name", "IsoCode", "GeoCountryId"])!, /requires Region__c/);
});

/* ── Tax Rate relationships ── */

test("Tax Rate form gets the ACTUAL GeoCountryId + GeoStateId; the saved rate is read back and verified; a state of another country is refused", async () => {
  // The library flow builds references from the ensured Ids (applyReferenceRate `resolved`) — never names.
  const lib = src("components/data/taxes/library/TaxRateLibrary.tsx");
  assert.ok(lib.includes('references.GeoCountryId = { id: resolved.country.id, name: resolved.country.name, sobject: "GeoCountry", moduleKey: "geo-countries" };'));
  assert.ok(lib.includes('references.GeoStateId = { id: resolved.state.id, name: resolved.state.name, sobject: "GeoState", moduleKey: "geo-states" };'));
  assert.ok(lib.includes("country: { id: res.country.id, name: res.country.name }"), "after creation the form continues with the server's Ids");
  // The existing create path validates every lookup Id exists (validate.ts "Lookup records exist") and now that the state belongs to the country.
  assert.equal(geoStateParentIssue("0vfg80000001SYXAA2", { id: "0yxBC", name: "British Columbia", geoCountryId: "0vfg80000001SYXAA2" }), null);
  assert.match(geoStateParentIssue("0vfg80000001SYXAA2", { id: "0yxKA", name: "Karnataka", geoCountryId: "0vfg80000001P9FAAU" })!.message, /belongs to another Geo Country/);
  assert.equal(geoStateParentIssue(null, { id: "0yxBC", name: "British Columbia", geoCountryId: "0vfg80000001SYXAA2" })!.field, "GeoCountryId");
  assert.equal(geoStateParentIssue("0vf", null)!.severity, "error");
  // Read-back after the Tax Rate is created.
  assert.equal(verifyRateGeo({ GeoCountryId: "0vfg80000001SYXAA2", GeoStateId: "0yxNEW000000000002" }, { geoCountryId: "0vfg80000001SYXAA2", geoStateId: "0yxNEW000000000002" }).ok, true);
  assert.match(verifyRateGeo({ GeoCountryId: "0vfg80000001SYXAA2", GeoStateId: null }, { geoCountryId: "0vfg80000001SYXAA2", geoStateId: "0yxNEW000000000002" }).message, /not the mapping's/);
  assert.match(src("components/data/taxes/TaxesWorkspace.tsx"), /onCreated=\{res => \{ reload\(\); if \(view\.moduleKey === RATE_LIBRARY_MODULE && view\.notice && res\?\.root\.id && view\.prefill\?\.GeoCountryId\) void verifyLibraryRate/);
  // The British Columbia rate's own prefill targets ISO BC under CA.
  const ref = await loadReferenceData();
  const bc = ref.records.find(r => r.jurisdiction.subdivisionCode === "CA-BC")!;
  assert.deepEqual([buildTaxRatePrefill(bc).geo.countryIso, buildTaxRatePrefill(bc).geo.stateIso], ["CA", "BC"]);
});

test("cancel performs no write; the route refuses unconfirmed requests; nothing writes when the library opens or a country is selected", () => {
  const lib = src("components/data/taxes/library/TaxRateLibrary.tsx");
  assert.ok(lib.includes("onCancel={() => setGeoFlow(null)}"), "Cancel only closes the dialog");
  assert.equal((lib.match(/quoteApiPost/g) ?? []).length, 2, "one import + the single confirmed Geo call");
  assert.ok(src("app/api/taxes/rate-library/geo/route.ts").includes("if (body.confirmed !== true) return { success: false"));
  assert.ok(!/export async function (POST|PATCH|PUT|DELETE)/.test(src("app/api/taxes/rate-library/salesforce/route.ts")), "lookups/dashboard/verify are GET-only");
});

/* ── default order ── */

const all = Geo.COUNTRIES.map(c => ({ code: c.code, name: c.name }));
test("default order: recent → your Tax Rates → your Geo records → frequent → org Tax Rates → official data → other; all 249 kept", async () => {
  let usage = emptyUsage();
  usage = recordUsage(usage, { kind: "country-selected", countryCode: "IE", countryName: "Ireland" }, 100);
  usage = recordUsage(usage, { kind: "country-selected", countryCode: "AU", countryName: "Australia" }, 200);
  const p = countryPriority({
    countries: all, usage,
    myTaxRates: [{ iso: "IN", n: 15, lastAt: "2026-11-02T10:22:32Z" }, { iso: "MX", n: 1, lastAt: "2026-11-05T04:23:29Z" }],
    myGeo: [{ iso: "BT", n: 1, lastAt: "2026-10-30T10:59:24Z" }, { iso: "IN", n: 3, lastAt: "2026-10-30T11:05:09Z" }],
    configured: [{ iso: "SG", name: "Singapore", n: 2 }, { iso: "IN", name: "India", n: 15 }],
    dataCountries: new Map([["US", 45], ["ES", 28]]),
  });
  assert.equal(p.size, 249, "every country has a position");
  const order = [...p.values()].sort((a, b) => a.rank - b.rank).map(x => x.code);
  assert.deepEqual(order.slice(0, 8), ["AU", "IE", "MX", "IN", "BT", "SG", "US", "ES"]);
  assert.deepEqual(order.slice(0, 8).map(cc => p.get(cc)!.tier), [1, 1, 2, 2, 3, 5, 6, 6]);
  assert.equal(p.get("AF")!.tier, 7, "no data, no usage → last tier (still listed)");

  // Applied to the real mapping table: the first rows are the prioritised countries, and paging still returns every row.
  const ref = await loadReferenceData();
  const { rows } = buildMapping({ countries: Geo.COUNTRIES, subdivisionsOf: Geo.subdivisionsOf, records: ref.records, profiles: ref.profiles, asOf: "2026-11-09" });
  const rank = new Map([...p].map(([cc, v]) => [cc, v.rank]));
  const first = queryMapping(rows, { countryRank: rank, pageSize: 50 });
  assert.equal(first.rows[0].countryCode, "AU");
  assert.equal(first.rows[0].scope, "country", "within a country: Country level, then its states");
  const seen = new Set<string>();
  for (let page = 1; ; page++) { const r = queryMapping(rows, { countryRank: rank, page, pageSize: 500 }); r.rows.forEach(x => seen.add(x.key)); if (page >= r.pageCount) break; }
  assert.equal(seen.size, rows.length, "sorting only — nothing removed");
  // An explicit column sort still wins; a country filter still narrows.
  assert.equal(queryMapping(rows, { countryRank: rank, sort: { by: "country", dir: "asc" } }).rows[0].countryCode, "AF");
  assert.ok(queryMapping(rows, { countryRank: rank, countryCode: "CA" }).rows.every(r => r.countryCode === "CA"));
});

test("previously created Tax Rate countries lead when there's no recent activity; the library wires the order in by default", () => {
  const p = countryPriority({ countries: all, usage: emptyUsage(), myTaxRates: [{ iso: "CA", n: 2, lastAt: "2026-11-02T07:00:09Z" }], myGeo: null, configured: [], dataCountries: new Map([["US", 45]]) });
  assert.equal([...p.values()].find(x => x.rank === 0)!.code, "CA");
  const view = src("components/data/taxes/library/TaxMappingView.tsx");
  assert.ok(view.includes("const query = useMemo(() => ({ ...q, countryCode, countryRank }), [q, countryCode, countryRank]);"));
  const lib = src("components/data/taxes/library/TaxRateLibrary.tsx");
  assert.ok(lib.includes("mode=dashboard&n=${geoVersion}"), "activity is re-read after Geo creation (no browser reload)");
  assert.ok(lib.includes("priority={priority}"));
});
