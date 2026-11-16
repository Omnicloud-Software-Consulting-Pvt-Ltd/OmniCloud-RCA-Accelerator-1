import type { FlatRow } from "@/lib/taxLibrary/importExport";
import { statusOf, type TaxRateReference } from "@/lib/taxLibrary/types";

/**
 * Datasets & coverage for the Global Tax Rate Library.
 *
 * A DATASET is a sourced set of rows plus a manifest (source, license, version, coverage claim). Datasets are bundled reference
 * data (reference.ts) produced by internal scripts from official sources — end users never import them.
 *
 * COVERAGE is computed from rate records only — a country's ISO subdivisions existing never counts as tax-rate coverage:
 *  · missing  — no published (non-archived) rate records for the country;
 *  · partial  — records exist, but no dataset claims complete coverage of the country for its scope;
 *  · covered  — a dataset declares the country complete FOR ITS STATED SCOPE (e.g. "national VAT") — never "all taxes".
 * Verification is reported separately (verified / partially verified / unverified records), so "covered" never implies "verified".
 * Further dimensions (reduced / zero / exempt rates, components, classifications, subnational and local layers) are reported
 * separately too, because a country can have national VAT coverage while regional or local taxes are missing.
 */

export interface DatasetManifest {
  id: string;
  name: string;
  version: string;
  retrievedAt: string;
  source: string;
  sourceUrl: string | null;
  license: string;
  coverage: { countries: string[]; scope: string; complete: boolean };
  recordCount: number;
  notes?: string | null;
}

export interface BundledDataset { manifest: DatasetManifest; rows: FlatRow[] }

/** Internal audit entry for programmatic dataset loads (scripts/tests). No user-facing import exists. */
export interface ImportLogEntry {
  at: string;
  datasetId: string | null;
  name: string;
  version: string | null;
  source: string | null;
  license: string | null;
  origin: string;
  coverage: DatasetManifest["coverage"] | null;
  rows: number;
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  errors: number;
  unmapped: number;
  errorSamples: string[];
}

/** Sources evaluated for the library — shown read-only in the Coverage panel (what is bundled, what isn't, and why). */
export const EVALUATED_SOURCES: { name: string; url: string; coverage: string; access: string; license: string; status: "bundled" | "not-bundled" | "commercial" }[] = [
  { name: "European Commission — Taxes in Europe Database (TEDB)", url: "https://ec.europa.eu/taxation_customs/tedb/", coverage: "27 EU Member States · national VAT standard / reduced / super-reduced / parking / exempt rates with CN/CPA codes and categories", access: "Official SOAP web service (no key), refreshed by an internal script", license: "Reuse with acknowledgement (Decision 2011/833/EU); informational, not a legal reference", status: "bundled" },
  { name: "National tax authorities, ministries of finance and official legislation (per country)", url: "https://www.oecd.org/en/topics/consumption-tax-trends.html", coverage: "Non-EU countries · standard / reduced / zero / exempt consumption-tax rates where the official page states them; US state, Canadian provincial, Brazilian state and Indian GST rules", access: "Official pages read on the retrieval date; each rate keeps its URL and a verbatim quote", license: "Public official information, cited per record", status: "bundled" },
  { name: "OECD — Consumption Tax Trends", url: "https://www.oecd.org/en/publications/2024/11/consumption-tax-trends-2024_57c7322a.html", coverage: "38 OECD members · standard and reduced VAT/GST rates as at 1 January 2024 (biennial)", access: "Excel annex tables; no rate API (the OECD SDMX catalogue has no VAT-rate dataflow)", license: "OECD terms", status: "not-bundled" },
  { name: "Streamlined Sales Tax Governing Board — Rate & Boundary files", url: "https://www.streamlinedsalestax.org/", coverage: "US member states (~24) · state + local rates by ZIP / address boundary", access: "Per-state files, quarterly", license: "Official state files; SSTGB terms", status: "not-bundled" },
  { name: "Commercial tax content (Avalara, Vertex, Fonoa, Stripe Tax, Sovos…)", url: "https://www.avalara.com/", coverage: "Vendors claim 100–190+ countries incl. local US rates and product taxability", access: "Paid API / licence", license: "Commercial — redistribution normally prohibited; needs a contract", status: "commercial" },
];

export type CoverageLevel = "covered" | "partial" | "missing";
export interface CountryCoverage {
  countryCode: string;
  level: CoverageLevel;
  records: number;
  verified: number;
  partiallyVerified: number;
  unverified: number;
  subdivisionsWithRates: number;
  countryLevelRates: number;
  taxCodes: number;
  scopes: string[];
  /** Rate categories present among current (non-expired) rates. */
  hasStandard: boolean;
  hasReduced: boolean;
  hasZero: boolean;
  hasExempt: boolean;
  components: string[];
  taxTypes: string[];
  classifications: number;
  historical: number;
}
export interface CoverageSummary {
  countriesTotal: number;
  covered: number;
  partial: number;
  missing: number;
  /** Countries with at least one tax-rate record (covered + partial). */
  countriesWithRates: number;
  /** Countries with at least one VERIFIED record. */
  countriesWithVerified: number;
  records: number;
  verifiedRecords: number;
  partiallyVerifiedRecords: number;
  unverifiedRecords: number;
  jurisdictionsVerified: number;
  jurisdictionsUnverified: number;
  taxCodes: number;
  standardRates: number;
  reducedRates: number;
  zeroRates: number;
  exemptRecords: number;
  components: number;
  classifications: number;
  historical: number;
  /** Subdivisions with their own rates / covered only by inherited national rates / with no applicable rates at all. */
  subdivisionsWithOwnRates: number;
  subdivisionsWithNationalOnly: number;
  subdivisionsWithoutData: number;
  lastVerified: string | null;
  lastDatasetUpdate: string | null;
  byCountry: Map<string, CountryCoverage>;
}

/** Rate category of a record, from its category text and rate (open vocabulary → the headline buckets). */
export function rateBucket(r: TaxRateReference): "standard" | "reduced" | "zero" | "exempt" | "other" {
  const c = (r.tax.taxCategory ?? "").toLowerCase();
  if (/exempt|input.taxed/.test(c) || (r.rate.ratePercent === null && r.rate.fixedAmount === null)) return "exempt";
  if (/zero|gst.free/.test(c) || r.rate.ratePercent === 0) return "zero";
  if (/reduced|parking/.test(c)) return "reduced";
  if (/standard|general/.test(c) || c === "") return "standard";
  return "other";
}

/** A coverage claim: a dataset manifest (or an internal load log entry) declaring countries complete for a scope. */
export interface CoverageClaim { coverage: DatasetManifest["coverage"] | null; retrievedAt?: string; at?: string }

/**
 * `subdivisions` (optional): ISO subdivision codes per country — enables the own / national-only / no-data subdivision counts.
 * A subdivision is covered by national rates when its country has current country-level rates (jurisdiction inheritance).
 */
export function computeCoverage(records: TaxRateReference[], countries: string[], claimsIn: CoverageClaim[], today?: string, subdivisions?: Map<string, string[]>): CoverageSummary {
  const live = records.filter(r => r.lifecycle === "published" && statusOf(r, today) !== "Archived");
  const isCurrent = (r: TaxRateReference) => statusOf(r, today) !== "Expired";
  const current = live.filter(isCurrent);
  const claims = new Map<string, string[]>();
  for (const e of claimsIn) if (e.coverage?.complete) for (const c of e.coverage.countries) claims.set(c, [...new Set([...(claims.get(c) ?? []), e.coverage.scope])]);
  const byCc = new Map<string, TaxRateReference[]>();
  for (const r of live) byCc.set(r.jurisdiction.countryCode, [...(byCc.get(r.jurisdiction.countryCode) ?? []), r]);
  const byCountry = new Map<string, CountryCoverage>();
  let own = 0, nationalOnly = 0, none = 0;
  for (const cc of countries) {
    const rs = byCc.get(cc) ?? [];
    const cur = rs.filter(isCurrent);
    const scopes = claims.get(cc) ?? [];
    const buckets = new Set(cur.map(rateBucket));
    const subsWithRates = new Set(rs.map(r => r.jurisdiction.subdivisionCode).filter((x): x is string => !!x));
    const national = cur.some(r => !r.jurisdiction.subdivisionCode && !r.jurisdiction.locality);
    for (const s of subdivisions?.get(cc) ?? []) { if (subsWithRates.has(s)) own++; else if (national) nationalOnly++; else none++; }
    byCountry.set(cc, {
      countryCode: cc,
      level: rs.length === 0 ? "missing" : scopes.length ? "covered" : "partial",
      records: rs.length,
      verified: rs.filter(r => r.source.verification === "verified").length,
      partiallyVerified: rs.filter(r => r.source.verification === "partially-verified").length,
      unverified: rs.filter(r => r.source.verification !== "verified" && r.source.verification !== "partially-verified").length,
      subdivisionsWithRates: subsWithRates.size,
      countryLevelRates: rs.filter(r => !r.jurisdiction.subdivisionCode).length,
      taxCodes: new Set(rs.map(r => r.tax.taxCode)).size,
      scopes,
      hasStandard: buckets.has("standard"), hasReduced: buckets.has("reduced"), hasZero: buckets.has("zero"), hasExempt: buckets.has("exempt"),
      components: [...new Set(rs.map(r => r.tax.taxComponent).filter((x): x is string => !!x))].sort(),
      taxTypes: [...new Set(rs.map(r => r.tax.taxType))].sort(),
      classifications: new Set(rs.map(r => r.classification.code ?? r.classification.productCategory ?? r.classification.serviceCategory).filter(Boolean)).size,
      historical: rs.length - cur.length,
    });
  }
  const jurisdictions = new Map<string, { v: boolean; u: boolean }>();
  for (const r of live) {
    const k = `${r.jurisdiction.countryCode}|${r.jurisdiction.subdivisionCode ?? ""}`;
    const cur = jurisdictions.get(k) ?? { v: false, u: false };
    if (r.source.verification === "verified") cur.v = true; else cur.u = true;
    jurisdictions.set(k, cur);
  }
  const levels = [...byCountry.values()];
  const bucket = (b: string) => current.filter(r => rateBucket(r) === b).length;
  const dates = claimsIn.map(e => e.retrievedAt ?? e.at ?? null).filter((x): x is string => !!x);
  return {
    countriesTotal: countries.length,
    covered: levels.filter(c => c.level === "covered").length,
    partial: levels.filter(c => c.level === "partial").length,
    missing: levels.filter(c => c.level === "missing").length,
    countriesWithRates: levels.filter(c => c.records > 0).length,
    countriesWithVerified: levels.filter(c => c.verified > 0).length,
    records: live.length,
    verifiedRecords: live.filter(r => r.source.verification === "verified").length,
    partiallyVerifiedRecords: live.filter(r => r.source.verification === "partially-verified").length,
    unverifiedRecords: live.filter(r => r.source.verification !== "verified" && r.source.verification !== "partially-verified").length,
    jurisdictionsVerified: [...jurisdictions.values()].filter(j => j.v).length,
    jurisdictionsUnverified: [...jurisdictions.values()].filter(j => !j.v).length,
    taxCodes: new Set(live.map(r => `${r.jurisdiction.countryCode}|${r.tax.taxCode}`)).size,
    standardRates: bucket("standard"), reducedRates: bucket("reduced"), zeroRates: bucket("zero"), exemptRecords: bucket("exempt"),
    components: new Set(live.map(r => r.tax.taxComponent).filter(Boolean)).size,
    classifications: new Set(live.map(r => r.classification.code ?? r.classification.productCategory ?? r.classification.serviceCategory).filter(Boolean).map(String)).size,
    historical: live.length - current.length,
    subdivisionsWithOwnRates: own, subdivisionsWithNationalOnly: nationalOnly, subdivisionsWithoutData: none,
    lastVerified: live.map(r => r.source.lastVerifiedAt).filter((x): x is string => !!x).sort().pop() ?? null,
    lastDatasetUpdate: dates.sort().pop()?.slice(0, 10) ?? null,
    byCountry,
  };
}
