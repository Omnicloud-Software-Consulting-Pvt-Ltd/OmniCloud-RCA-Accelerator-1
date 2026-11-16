import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNTRIES, DATASET_INFO, getCountry, getSubdivision, resolveCountryCode, resolveSubdivisionCode, salesforceStateIso, subdivisionsOf } from "@/lib/taxLibrary/jurisdictions";
import { COUNTRY_LEVEL, createRecord, duplicateRecord, facets, lineageOf, newVersion, queryLibrary, setArchived, splitByClassification, updateRecord, upsertAll, validateInput } from "@/lib/taxLibrary/library";
import { applyImport, exportRecords, parseImport, previewImport } from "@/lib/taxLibrary/importExport";
import { buildTaxRatePrefill } from "@/lib/taxLibrary/prefill";
import { SEED_RATES } from "@/lib/taxLibrary/seed";
import { TaxLibraryStore, TAX_LIBRARY_KEY, type KeyValueStorage } from "@/lib/taxLibrary/store";
import { identityKey, statusOf, type TaxRateInput, type TaxRateReference } from "@/lib/taxLibrary/types";

const TODAY = "2026-11-05";
const memory = (): KeyValueStorage & { data: Map<string, string> } => { const data = new Map<string, string>(); return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: k => void data.delete(k) }; };
const input = (o: Partial<{ cc: string; sub: string | null; code: string; name: string; type: string; structure: string; component: string | null; pct: number | null; from: string; to: string | null; cls: string | null; lifecycle: TaxRateInput["lifecycle"] }> = {}): TaxRateInput => ({
  jurisdiction: { countryCode: o.cc ?? "IN", countryName: "", subdivisionCode: o.sub === undefined ? "IN-AP" : o.sub, subdivisionName: null, level: "subdivision", locality: null },
  tax: { taxCode: o.code ?? "GST18", taxName: o.name ?? "GST 18%", taxType: o.type ?? "GST", taxStructure: o.structure ?? "CGST + SGST", taxComponent: o.component ?? null, taxAuthority: null, taxCategory: null },
  rate: { ratePercent: o.pct === undefined ? 18 : o.pct, fixedAmount: null, fixedAmountCurrency: null, minRatePercent: null, maxRatePercent: null, calculation: "percentage", compound: false, componentOrder: null },
  classification: { code: o.cls ?? null, system: o.cls ? "HSN" : null, productCategory: null, serviceCategory: null, description: null, conditions: null, transactionType: null, placeOfSupply: null },
  effective: { effectiveFrom: o.from ?? "2017-07-01", effectiveTo: o.to ?? null },
  source: { sourceName: "Test", sourceUrl: null, sourceReference: null, notes: null, verification: "unverified", lastVerifiedAt: null },
  lifecycle: o.lifecycle ?? "published",
});
const mk = (records: TaxRateReference[], i: TaxRateInput) => { const r = createRecord(records, i, { now: "2026-11-05T10:00:00.000Z" }); assert.ok(r.ok, JSON.stringify(!r.ok && r.errors)); return r.value; };

/* ── Jurisdiction reference data ── */

test("countries: every ISO 3166-1 country, not a short list", () => {
  assert.equal(COUNTRIES.length, 249);
  for (const c of ["IN", "AU", "CA", "US", "DE", "JP", "BR", "ZA", "NZ", "SG", "AE", "MC", "VA"]) assert.ok(getCountry(c), c);
  assert.equal(resolveCountryCode("india"), "IN");
  assert.equal(resolveCountryCode("IND"), "IN");
  assert.equal(resolveCountryCode("Atlantis"), null);
});

test("subdivisions: ISO 3166-2 for states, provinces, territories, regions, prefectures; countries without subdivisions are empty", () => {
  assert.ok(DATASET_INFO.subdivisions > 4500);
  assert.equal(subdivisionsOf("IN").length, 36);
  assert.equal(subdivisionsOf("CA").length, 13);
  assert.equal(subdivisionsOf("AU").length, 8);
  assert.ok(subdivisionsOf("JP").length >= 47, "prefectures");
  assert.ok(subdivisionsOf("US").some(s => s.code === "US-CA"));
  assert.ok(subdivisionsOf("FR").some(s => s.level === 2) || subdivisionsOf("FR").length > 0);
  assert.equal(subdivisionsOf("VA").length, 0, "Vatican City has no subdivisions → country-level only");
  assert.equal(getSubdivision("IN-AP")?.name, "Andhra Pradesh");
  assert.equal(resolveSubdivisionCode("AP", "IN"), "IN-AP");
  assert.equal(resolveSubdivisionCode("Ontario", "CA"), "CA-ON");
  assert.equal(resolveSubdivisionCode("ON", "IN"), null, "a code from another country isn't accepted");
  assert.equal(salesforceStateIso("IN-AP"), "AP", "Salesforce GeoState.IsoCode stores the part after the dash");
});

/* ── Multiple rates per jurisdiction ── */

test("multiple rates, codes, components and classifications in ONE state are all allowed", () => {
  let rs: TaxRateReference[] = [];
  for (const i of [
    input({ code: "GST5", pct: 5 }), input({ code: "GST18", pct: 18 }), input({ code: "GST40", pct: 40, from: "2025-09-22" }),
    input({ code: "GST18-CGST", type: "CGST", component: "CGST", pct: 9 }), input({ code: "GST18-SGST", type: "SGST", component: "SGST", pct: 9 }),
    input({ code: "GST18", pct: 18, cls: "8471" }), input({ code: "GST18", pct: 18, cls: "9983" }),
  ]) rs = [...rs, mk(rs, i)];
  assert.equal(rs.length, 7);
  assert.equal(queryLibrary(rs, { subdivisionCode: "IN-AP", today: TODAY }).total, 7);
});

test("country-level and state-level rates coexist; the country-level filter shows only country-level ones", () => {
  let rs: TaxRateReference[] = [];
  rs = [...rs, mk(rs, input({ cc: "CA", sub: null, code: "GST5", pct: 5, structure: "GST" }))];
  rs = [...rs, mk(rs, input({ cc: "CA", sub: "CA-BC", code: "BCPST7", type: "PST", pct: 7, structure: "GST + PST" }))];
  assert.equal(rs[0].jurisdiction.level, "country");
  assert.equal(rs[0].jurisdiction.subdivisionName, null);
  assert.equal(rs[1].jurisdiction.subdivisionName, "British Columbia");
  assert.deepEqual(queryLibrary(rs, { countryCode: "CA", subdivisionCode: COUNTRY_LEVEL, today: TODAY }).rows.map(r => r.tax.taxCode), ["GST5"]);
  assert.equal(queryLibrary(rs, { countryCode: "CA", today: TODAY }).total, 2);
});

test("seed dataset: several rates per state, components, country-level, versions — and none marked verified", () => {
  assert.ok(SEED_RATES.filter(r => r.jurisdiction.subdivisionCode === "IN-AP").length >= 5);
  assert.ok(SEED_RATES.some(r => r.tax.taxComponent === "QST") && SEED_RATES.some(r => r.tax.taxComponent === "GST" && r.jurisdiction.subdivisionCode === "CA-QC"));
  assert.ok(SEED_RATES.some(r => r.jurisdiction.countryCode === "AU" && !r.jurisdiction.subdivisionCode));
  assert.equal(lineageOf(SEED_RATES, "seed-ca-ns-hst-14").length, 2);
  assert.ok(SEED_RATES.every(r => r.source.verification === "unverified" && r.source.sourceUrl?.startsWith("https://")), "seed data is never claimed as verified");
  for (const r of SEED_RATES) assert.deepEqual(validateInput(r, SEED_RATES, [r.id]).errors, [], r.id);
  assert.equal(statusOf(SEED_RATES.find(r => r.id === "seed-in-ap-gst-12")!, TODAY), "Expired");
  assert.equal(statusOf(SEED_RATES.find(r => r.id === "seed-ca-ns-hst-14")!, TODAY), "Active");
});

/* ── Validation, duplicates, overlaps ── */

test("validation: ISO codes, subdivision must belong to the country, rate bounds, dates", () => {
  const errs = (i: TaxRateInput) => validateInput(i, []).errors.map(e => e.field);
  assert.deepEqual(errs(input({ cc: "XX" })), ["countryCode", "subdivisionCode"]);
  assert.ok(errs(input({ cc: "CA", sub: "IN-AP" })).includes("subdivisionCode"));
  assert.ok(errs(input({ pct: 120 })).includes("ratePercent"));
  assert.ok(errs(input({ pct: null })).includes("ratePercent"));
  assert.ok(errs(input({ from: "2026-13-01" })).includes("effectiveFrom"));
  assert.ok(errs(input({ from: "2026-02-01", to: "2026-01-01" })).includes("effectiveTo"));
  assert.ok(errs({ ...input(), source: { ...input().source, verification: "verified" as const, sourceName: null } }).includes("verification"));
});

test("duplicate prevention: the same rate identity can't overlap in time; different classification / type / component can", () => {
  let rs: TaxRateReference[] = [mk([], input())];
  const dup = createRecord(rs, input({ pct: 18, from: "2020-01-01" }));
  assert.equal(dup.ok, false);
  assert.match(!dup.ok ? dup.errors[0].message : "", /Overlaps/);
  for (const i of [input({ cls: "8471" }), input({ type: "IGST" }), input({ component: "CGST" })]) { const r = createRecord(rs, i); assert.ok(r.ok, "legitimate overlap allowed"); rs = [...rs, r.value]; }
  assert.ok(createRecord(rs, input({ lifecycle: "draft" })).ok, "a draft never blocks");
});

/* ── Edit / versions / history ── */

test("editing metadata is fine; a published rate or start date can't be overwritten in place", () => {
  const rs = [mk([], input())];
  const ok = updateRecord(rs, rs[0].id, { ...input(), source: { ...input().source, notes: "checked" } });
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.value.history.at(-1)?.action, "updated");
  const bad = updateRecord(rs, rs[0].id, input({ pct: 20 }));
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.errors[0].message : "", /New Version/);
});

test("new version closes the previous one and preserves it (history, lineage, no overlap)", () => {
  const rs = [mk([], input({ cc: "CA", sub: "CA-NS", code: "HST", type: "HST", structure: "HST", pct: 15, from: "2010-07-01" }))];
  const v = newVersion(rs, rs[0].id, { rate: { ...rs[0].rate, ratePercent: 14 }, effective: { effectiveFrom: "2025-04-01" } });
  assert.ok(v.ok, JSON.stringify(!v.ok && v.errors));
  const { closed, created } = v.value;
  assert.equal(closed.effective.effectiveTo, "2025-03-31");
  assert.equal(closed.rate.ratePercent, 15, "old rate untouched");
  assert.equal(created.version, 2);
  assert.equal(created.lineageId, rs[0].lineageId);
  assert.equal(created.supersedesId, rs[0].id);
  const all = upsertAll(rs, [closed, created]);
  assert.equal(all.length, 2);
  assert.deepEqual(lineageOf(all, created.id).map(r => r.version), [2, 1]);
  assert.equal(statusOf(closed, TODAY), "Expired");
  assert.equal(newVersion(all, rs[0].id, { effective: { effectiveFrom: "2026-01-01" } }).ok, false, "only the latest version can be versioned");
  assert.equal(newVersion(all, created.id, { effective: { effectiveFrom: "2020-01-01" } }).ok, false, "must start after the current version");
});

test("upcoming, expired, draft and archived statuses; archive keeps the record, restore re-checks overlaps", () => {
  const rs = [mk([], input({ from: "2027-01-01" }))];
  assert.equal(statusOf(rs[0], TODAY), "Upcoming");
  assert.equal(statusOf({ ...rs[0], effective: { effectiveFrom: "2020-01-01", effectiveTo: "2021-01-01" } }, TODAY), "Expired");
  assert.equal(statusOf({ ...rs[0], lifecycle: "draft" }, TODAY), "Draft");
  const a = setArchived(rs, rs[0].id, true);
  assert.ok(a.ok && a.value.lifecycle === "archived" && statusOf(a.value, TODAY) === "Archived");
  const all = upsertAll(rs, [a.ok ? a.value : rs[0]]);
  assert.equal(all.length, 1, "archiving never deletes");
  assert.equal(updateRecord(all, rs[0].id, input()).ok, false, "archived records are read-only");
});

test("duplicate creates an unverified draft copy with a new identity", () => {
  const rs = [mk([], input())];
  const d = duplicateRecord(rs, rs[0].id);
  assert.ok(d.ok && d.value.lifecycle === "draft" && d.value.id !== rs[0].id && d.value.lineageId === d.value.id && d.value.source.verification === "unverified");
});

/* ── Search / filters / sort / pagination ── */

test("search by country name/code, state, tax code, name, type, classification; filters; sort; pagination", () => {
  const q = (o: Parameters<typeof queryLibrary>[1]) => queryLibrary(SEED_RATES, { today: TODAY, pageSize: 200, ...o });
  assert.ok(q({ q: "andhra" }).total >= 5);
  assert.ok(q({ q: "canada" }).total >= 8 && q({ q: "CA-QC" }).total === 2);
  assert.ok(q({ q: "qst" }).rows.every(r => r.tax.taxType === "QST" || r.tax.taxStructure.includes("QST")));
  assert.ok(q({ q: "8471" }).total === 1 && q({ q: "HSN" }).total >= 1);
  assert.ok(q({ taxType: "HST" }).rows.every(r => r.tax.taxType === "HST"));
  assert.ok(q({ taxStructure: "GST + QST" }).total === 2);
  assert.ok(q({ statuses: ["Expired"] }).rows.every(r => statusOf(r, TODAY) === "Expired"));
  assert.ok(q({ statuses: ["Expired"] }).total >= 3);
  assert.equal(q({ verification: ["verified"] }).total, 0);
  assert.ok(q({ classification: "HSN 8471" }).total === 1);
  const byRate = q({ sort: { by: "rate", dir: "desc" } }).rows.map(r => r.rate.ratePercent ?? 0);
  assert.deepEqual(byRate, byRate.slice().sort((a, b) => b - a));
  const p1 = queryLibrary(SEED_RATES, { pageSize: 5, page: 1, today: TODAY }), p2 = queryLibrary(SEED_RATES, { pageSize: 5, page: 2, today: TODAY });
  assert.equal(p1.rows.length, 5);
  assert.equal(p1.pageCount, Math.ceil(SEED_RATES.length / 5));
  assert.equal(new Set([...p1.rows, ...p2.rows].map(r => r.id)).size, 10, "pages don't overlap");
  assert.ok(facets(SEED_RATES).taxTypes.includes("QST"));
});

test("product classification context: explicit metadata only, nothing auto-selected", () => {
  const ap = SEED_RATES.filter(r => r.jurisdiction.subdivisionCode === "IN-AP");
  const none = splitByClassification(ap, null);
  assert.equal(none.matching.length, 0);
  assert.ok(none.general.length > 0 && none.other.length > 0, "all candidates shown when there's no classification");
  const m = splitByClassification(ap, { classificationCode: "8471", classificationName: null });
  assert.deepEqual(m.matching.map(r => r.id), ["seed-in-ap-hsn-8471"]);
  assert.ok(m.other.some(r => r.id === "seed-in-ap-sac-9983"));
  assert.equal(splitByClassification(ap, { classificationCode: null, classificationName: null }).hasProductClassification, false);
});

/* ── Import / export ── */

test("import: preview validates and classifies rows (create / update / unchanged / conflict / error) without changing anything; apply upserts", () => {
  const base = [mk([], input())];
  const csv = [
    "countryCode,subdivisionCode,taxCode,taxName,taxType,taxStructure,ratePercent,effectiveFrom,notes",
    "IN,IN-AP,GST18,GST 18%,GST,CGST + SGST,18,2017-07-01,now verified",   // same identity + start → update (notes)
    "IN,AP,GST5,GST 5%,GST,CGST + SGST,5,2017-07-01,",                      // create (AP resolved to IN-AP)
    "IN,IN-AP,GST18,GST 18%,GST,CGST + SGST,18,2020-01-01,",               // overlaps → conflict
    "XX,,VAT,VAT,VAT,VAT,20,2020-01-01,",                                   // not an ISO country → missing jurisdiction (unmapped)
    "IN,IN-AP,GST5,GST 5% again,GST,CGST + SGST,5,2018-01-01,",            // overlaps row 2 of THIS file → conflict
  ].join("\n");
  const parsed = parseImport(csv, "csv");
  assert.deepEqual(parsed.errors, []);
  const preview = previewImport(base, parsed.rows);
  assert.deepEqual(preview.map(p => p.action), ["update", "create", "conflict", "unmapped", "conflict"]);
  assert.equal(base.length, 1, "preview changes nothing");
  const applied = applyImport(base, preview, { origin: "import:test.csv" });
  assert.deepEqual([applied.created, applied.updated, applied.skipped], [1, 1, 3]);
  assert.equal(applied.records.find(r => r.tax.taxCode === "GST5")?.origin, "import:test.csv");
  // re-importing the same file creates nothing new (safe upsert)
  const again = previewImport(applied.records, parsed.rows);
  assert.equal(again.filter(p => p.action === "create").length, 0);
});

test("export → import round-trips (CSV and JSON)", () => {
  for (const f of ["csv", "json"] as const) {
    const text = exportRecords(SEED_RATES, f);
    const parsed = parseImport(text, f);
    assert.equal(parsed.rows.length, SEED_RATES.length, f);
    const preview = previewImport(SEED_RATES, parsed.rows);
    assert.ok(preview.every(p => p.action === "unchanged"), `${f}: ${preview.filter(p => p.action !== "unchanged").map(p => `${p.label}:${p.action}:${p.errors[0]?.message}`).join(" | ")}`);
  }
});

/* ── Storage ── */

test("store: reference + user overlay, user edits win, revision-checked, not scoped to a Salesforce org", () => {
  const mem = memory();
  const s = new TaxLibraryStore(mem, SEED_RATES);
  const first = s.load();
  assert.equal(first.records.length, SEED_RATES.length);
  assert.equal(first.userRecords, 0);
  const edited = first.records.map(r => (r.id === "seed-au-gst-10" ? { ...r, source: { ...r.source, notes: "my note" } } : r));
  assert.ok(s.save(edited, first.revision).ok);
  const second = new TaxLibraryStore(mem, SEED_RATES).load();
  assert.equal(second.userRecords, 1, "only the edited record is stored");
  assert.equal(second.records.find(r => r.id === "seed-au-gst-10")?.source.notes, "my note");
  assert.equal(s.save(edited, first.revision).ok, false, "stale revision refused");
  assert.ok(!mem.data.get(TAX_LIBRARY_KEY)!.includes("instanceUrl"), "no org data stored");
});

/* ── Use This Rate ── */

test("Use This Rate: prefills the 4 primary fields (Geo Country, Geo State, Tax Code, Rate) + dates; country-level → no state", () => {
  const ap = SEED_RATES.find(r => r.id === "seed-in-ap-gst-18")!;
  const p = buildTaxRatePrefill(ap, TODAY);
  assert.deepEqual(p.geo, { countryIso: "IN", stateIso: "AP", countryName: "India", stateName: "Andhra Pradesh" });
  assert.equal(p.fields.TaxCode, "GST18");
  assert.equal(p.fields.Rate, 18);
  assert.equal(p.fields.StartDate, "2017-07-01");
  assert.ok(!("RateUsageType" in p.fields) && !("LegalEntityId" in p.fields), "Salesforce-specific decisions aren't guessed");
  const au = buildTaxRatePrefill(SEED_RATES.find(r => r.id === "seed-au-gst-10")!, TODAY);
  assert.equal(au.geo.stateIso, null);
  assert.ok(au.notices.some(n => /Geo State is left empty/.test(n)));
});

test("Use This Rate: expired / draft / unverified need explicit confirmation; upcoming warns; archived is blocked", () => {
  const exp = buildTaxRatePrefill(SEED_RATES.find(r => r.id === "seed-in-ap-gst-12")!, TODAY);
  assert.ok(exp.requiresConfirmation && exp.confirmationReasons.includes("The rate is expired.") && exp.fields.EndDate === "2025-09-21");
  const base = SEED_RATES.find(r => r.id === "seed-au-gst-10")!;
  const up = buildTaxRatePrefill({ ...base, effective: { effectiveFrom: "2027-01-01", effectiveTo: null }, source: { ...base.source, verification: "verified", lastVerifiedAt: TODAY } }, TODAY);
  assert.ok(up.warnings.some(w => /only takes effect on 2027-01-01/.test(w)));
  assert.equal(up.requiresConfirmation, false);
  assert.ok(buildTaxRatePrefill(base, TODAY).confirmationReasons.includes("The reference data isn't verified."));
  assert.match(buildTaxRatePrefill({ ...base, lifecycle: "archived" }, TODAY).blocked ?? "", /Archived/);
});

test("identity key ignores names (so a renamed rate is still the same rate)", () => {
  assert.equal(identityKey(input({ name: "A" })), identityKey(input({ name: "B" })));
  assert.notEqual(identityKey(input()), identityKey(input({ cls: "8471" })));
});
