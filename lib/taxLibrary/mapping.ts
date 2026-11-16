import { foldText } from "@/lib/taxLibrary/library";
import type { CountryProfile } from "@/lib/taxLibrary/reference";
import { rateLabel, statusOf, todayIso, type TaxRateReference, type VerificationStatus } from "@/lib/taxLibrary/types";

/**
 * COUNTRY → GEO STATE → TAX RATE MAPPING for the Global Tax Rate Library — one row per actual mapping, and a row for every
 * subdivision that has none, so no state is hidden. Pure and in-memory: built once from the already-loaded library records, the
 * ISO 3166 geography and the dataset country profiles (no per-country / per-state requests).
 *
 * Keys (never display names): a rate belongs to a country by ISO 3166-1 alpha-2 (`jurisdiction.countryCode`) and to a state by its
 * ISO 3166-2 code (`jurisdiction.subdivisionCode`, e.g. "AU-NSW"). Salesforce GeoCountry / GeoState records are matched to the
 * same codes separately (GeoCountry.IsoCode = "AU"; GeoState.IsoCode = "NSW" under GeoState.GeoCountryId).
 *
 * Data rules:
 *  · A state's own rates come only from records with that state's ISO 3166-2 code.
 *  · A national (country-level) rate is shown on a state ONLY where the source explicitly supports it: the country profile says the
 *    country has no state/provincial tax layer (`subnational: "none"`, e.g. AU "GST is a single national tax; states and territories
 *    levy no GST", IN "uniform nationwide"). Those rows are marked "Inherited national rate". Elsewhere national rates are shown on
 *    the Country-level rows only — e.g. Spain's VAT is NOT put on the Canary Islands (outside the EU VAT territory).
 *  · 0 % is a value; a missing rate is never turned into 0 %. "No Tax Rate Configured" (source covers the country, nothing for this
 *    state) ≠ "Tax rate unavailable in source" (no official source confirmed) ≠ "No consumption tax" (official source says none).
 */

export type MappingStatus = "state-rate" | "inherited-national" | "national" | "region-specific" | "no-rate-configured" | "unavailable-in-source" | "no-consumption-tax";

export const MAPPING_STATUS_LABEL: Record<MappingStatus, string> = {
  "state-rate": "State / provincial rate",
  "inherited-national": "Inherited national rate",
  national: "National (country-level) rate",
  "region-specific": "Region-specific rate (no ISO subdivision)",
  "no-rate-configured": "No Tax Rate Configured",
  "unavailable-in-source": "Tax rate unavailable in source",
  "no-consumption-tax": "No consumption tax (official source)",
};

/** How the rate value must be shown — never collapsing "no rate" into 0 %. */
export type RateKind = "percent" | "zero" | "fixed" | "no-percentage" | "none";

export interface GeoCountryRef { code: string; name: string }
export interface GeoStateRef { code: string; name: string; level?: 1 | 2; parent?: string }

export interface MappingRow {
  /** Unique, stable row key. */
  key: string;
  countryCode: string;
  countryName: string;
  /** ISO 3166-1 country the Geo Country record matches (GeoCountry.IsoCode). */
  geoCountryName: string;
  /** null = the Country-level row. */
  geoStateCode: string | null;
  geoStateName: string | null;
  scope: "country" | "state" | "region";
  record: TaxRateReference | null;
  taxCode: string | null;
  taxType: string | null;
  taxCategory: string | null;
  ratePercent: number | null;
  rateKind: RateKind;
  rateDisplay: string;
  dataStatus: string;
  status: MappingStatus;
  statusDetail: string | null;
  /** Rate rows for the same Geo State (country or state) — > 1 means multiple applicable rates. */
  ratesForGeo: number;
}

export interface MappingTotals { countries: number; countriesWithRates: number; geoStates: number; geoStatesWithRates: number; geoStatesWithoutRates: number; taxMappings: number; rows: number }

const VERIFY: Record<VerificationStatus, string> = { verified: "Verified", "partially-verified": "Partially verified", unverified: "Unverified", "needs-review": "Needs review" };

export function rateView(r: TaxRateReference | null): { kind: RateKind; display: string } {
  if (!r) return { kind: "none", display: "No Tax Rate Configured" };
  if (r.rate.ratePercent === 0 && r.rate.fixedAmount === null) return { kind: "zero", display: "0%" };
  if (r.rate.ratePercent !== null) return { kind: "percent", display: rateLabel(r.rate) };
  if (r.rate.fixedAmount !== null) return { kind: "fixed", display: rateLabel(r.rate) };
  return { kind: "no-percentage", display: `No percentage rate${r.tax.taxCategory ? ` (${r.tax.taxCategory})` : ""}` };
}

const sourceStatus = (r: TaxRateReference) => `${r.source.sourceName ?? "Source not recorded"} · ${VERIFY[r.source.verification] ?? r.source.verification}`;

/** Rates that count as mappings on `asOf`: published and in effect (drafts, archived, expired and upcoming rates are excluded). */
export const isApplicable = (r: TaxRateReference, asOf: string) => statusOf(r, asOf) === "Active";

export interface MappingInput {
  countries: GeoCountryRef[];
  subdivisionsOf: (countryCode: string) => GeoStateRef[];
  records: TaxRateReference[];
  profiles: Map<string, CountryProfile>;
  asOf?: string;
}

export function buildMapping(input: MappingInput): { rows: MappingRow[]; totals: MappingTotals } {
  const asOf = input.asOf ?? todayIso();
  // One pass to index applicable records by country → national / region / per-state (no per-country scans).
  type CountryIndex = { national: TaxRateReference[]; region: TaxRateReference[]; byState: Map<string, TaxRateReference[]> };
  const idx = new Map<string, CountryIndex>();
  for (const r of input.records) {
    if (!isApplicable(r, asOf)) continue;
    const cc = r.jurisdiction.countryCode;
    const e: CountryIndex = idx.get(cc) ?? { national: [], region: [], byState: new Map() };
    if (r.jurisdiction.subdivisionCode) { const l = e.byState.get(r.jurisdiction.subdivisionCode) ?? []; l.push(r); e.byState.set(r.jurisdiction.subdivisionCode, l); }
    else if (r.jurisdiction.locality) e.region.push(r);
    else e.national.push(r);
    idx.set(cc, e);
  }
  const rows: MappingRow[] = [];
  const totals: MappingTotals = { countries: input.countries.length, countriesWithRates: 0, geoStates: 0, geoStatesWithRates: 0, geoStatesWithoutRates: 0, taxMappings: 0, rows: 0 };
  const sortRecs = (l: TaxRateReference[]) => l.slice().sort((a, b) => a.tax.taxCode.localeCompare(b.tax.taxCode) || (a.rate.ratePercent ?? -1) - (b.rate.ratePercent ?? -1) || a.id.localeCompare(b.id));

  for (const c of input.countries) {
    const e = idx.get(c.code);
    const profile = input.profiles.get(c.code) ?? null;
    if (e && (e.national.length || e.region.length || e.byState.size)) totals.countriesWithRates++;
    const base = { countryCode: c.code, countryName: c.name, geoCountryName: c.name };
    const rateRow = (r: TaxRateReference, scope: MappingRow["scope"], geo: GeoStateRef | null, status: MappingStatus, ratesForGeo: number, detail: string | null): MappingRow => {
      const v = rateView(r);
      return {
        ...base, key: `${c.code}|${geo?.code ?? scope}|${r.id}|${status}`, geoStateCode: geo?.code ?? null, geoStateName: geo?.name ?? (scope === "region" ? r.jurisdiction.locality : null), scope, record: r,
        taxCode: r.tax.taxCode, taxType: r.tax.taxType, taxCategory: r.tax.taxCategory, ratePercent: r.rate.ratePercent, rateKind: v.kind, rateDisplay: v.display,
        dataStatus: sourceStatus(r), status, statusDetail: detail, ratesForGeo,
      };
    };
    const emptyRow = (geo: GeoStateRef | null, status: MappingStatus, detail: string): MappingRow => ({
      ...base, key: `${c.code}|${geo?.code ?? "country"}|${status}`, geoStateCode: geo?.code ?? null, geoStateName: geo?.name ?? null, scope: geo ? "state" : "country", record: null,
      taxCode: null, taxType: null, taxCategory: null, ratePercent: null, rateKind: "none", rateDisplay: status === "no-rate-configured" ? "No Tax Rate Configured" : MAPPING_STATUS_LABEL[status],
      dataStatus: profile?.status === "not-found" ? "No official source confirmed" : profile?.status === "no-consumption-tax" ? "Official source: no general consumption tax" : e ? "Library has rates for this country" : "No rates in the library", status, statusDetail: detail, ratesForGeo: 0,
    });
    const noDataStatus = (): MappingStatus => (profile?.status === "no-consumption-tax" ? "no-consumption-tax" : profile?.status === "not-found" || !e ? "unavailable-in-source" : "no-rate-configured");
    const missing = profile?.missingScope.length ? ` Missing in source: ${profile.missingScope.join("; ")}.` : "";

    // Country-level rows.
    const national = sortRecs(e?.national ?? []);
    if (national.length) for (const r of national) { rows.push(rateRow(r, "country", null, "national", national.length, null)); totals.taxMappings++; }
    else {
      const s = noDataStatus();
      rows.push(emptyRow(null, s, s === "unavailable-in-source" ? `No source-backed national rate.${missing}` : s === "no-consumption-tax" ? "The official source states there is no general consumption tax." : `No national rate in the library${profile?.subnational === "included" ? " — this country's consumption taxes are levied per state/province (see the state rows)" : ""}.`));
    }
    for (const r of sortRecs(e?.region ?? [])) { rows.push(rateRow(r, "region", null, "region-specific", 1, `Applies to ${r.jurisdiction.locality} only — not mapped to an ISO subdivision.`)); totals.taxMappings++; }

    // State rows: every ISO subdivision, plus any subdivision a record uses that ISO doesn't list (never dropped).
    const subs = input.subdivisionsOf(c.code);
    const known = new Set(subs.map(s => s.code));
    const extra = [...(e?.byState.keys() ?? [])].filter(code => !known.has(code)).map(code => ({ code, name: e!.byState.get(code)![0].jurisdiction.subdivisionName ?? code }));
    const inherit = profile?.subnational === "none" && national.length > 0;
    for (const s of [...subs, ...extra]) {
      totals.geoStates++;
      const own = sortRecs(e?.byState.get(s.code) ?? []);
      const inherited = inherit ? national : [];
      const n = own.length + inherited.length;
      if (!n) {
        totals.geoStatesWithoutRates++;
        const st = noDataStatus();
        rows.push(emptyRow(s, st, st === "no-rate-configured"
          ? (national.length ? `No state-specific rate in the source. National rates exist (Country-level rows), but the source doesn't confirm they apply in ${s.name}.` : `No rate for ${s.name} in the library.`) + missing
          : st === "unavailable-in-source" ? `No source-backed rate for this country.${missing}` : "The official source states there is no general consumption tax."));
        continue;
      }
      totals.geoStatesWithRates++;
      for (const r of own) { rows.push(rateRow(r, "state", s, "state-rate", n, null)); totals.taxMappings++; }
      for (const r of inherited) {
        rows.push(rateRow(r, "state", s, "inherited-national", n, `National rate applied in ${s.name}: the source states ${c.name} has no state/provincial tax layer${profile?.note ? ` (“${profile.note.split(/(?<=\.)\s/)[0]}”)` : ""}.`));
        totals.taxMappings++;
      }
    }
  }
  totals.rows = rows.length;
  return { rows, totals };
}

export interface MappingQuery {
  countryCode?: string | null;
  /** Free text over country name / ISO code. */
  countryQ?: string;
  /** Free text over Geo State name / ISO 3166-2 code ("Country level" matches the country rows). */
  stateQ?: string;
  taxCode?: string | null;
  taxCategory?: string | null;
  status?: MappingStatus | null;
  /** Hide the Country-level rows (state view only). */
  statesOnly?: boolean;
  sort?: { by: "country" | "state" | "taxCode" | "taxCategory" | "rate" | "status"; dir: "asc" | "desc" };
  /**
   * DEFAULT order when no column sort is chosen: country code → position (usage.ts countryPriority — recent / your Tax Rates / your
   * Geo records / frequent / org Tax Rates / official data / other). Sorting only: every row stays; within a country the build
   * order (Country level, then states) is kept. Countries missing from the map go last, alphabetically.
   */
  countryRank?: Map<string, number>;
  page?: number;
  pageSize?: number;
}

export const MAPPING_PAGE_SIZES = [25, 50, 100, 200] as const;

/** Filter → stable sort → paginate. Filters only narrow; ties keep the build order (country, Country level first, then states). */
export function queryMapping(rows: MappingRow[], q: MappingQuery): { rows: MappingRow[]; total: number; page: number; pageCount: number; from: number; to: number; geoStates: number; mappings: number } {
  const cq = foldText(q.countryQ?.trim() ?? ""), sq = foldText(q.stateQ?.trim() ?? "");
  const filtered = rows.filter(r => {
    if (q.countryCode && r.countryCode !== q.countryCode) return false;
    if (cq && !foldText(`${r.countryName} ${r.countryCode}`).includes(cq)) return false;
    if (sq && !foldText(`${r.geoStateName ?? "Country level"} ${r.geoStateCode ?? ""}`).includes(sq)) return false;
    if (q.taxCode && r.taxCode !== q.taxCode) return false;
    if (q.taxCategory && r.taxCategory !== q.taxCategory) return false;
    if (q.status && r.status !== q.status) return false;
    if (q.statesOnly && r.scope !== "state") return false;
    return true;
  });
  const order = new Map(rows.map((r, i) => [r.key, i]));
  const by = q.sort?.by, dir = q.sort?.dir === "desc" ? -1 : 1;
  const key = (r: MappingRow): string | number => by === "state" ? foldText(r.geoStateName ?? "") : by === "taxCode" ? (r.taxCode ?? "~") : by === "taxCategory" ? (r.taxCategory ?? "~") : by === "rate" ? (r.ratePercent ?? -1) : by === "status" ? MAPPING_STATUS_LABEL[r.status] : foldText(r.countryName);
  const rank = q.countryRank;
  const sorted = by ? filtered.slice().sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || order.get(a.key)! - order.get(b.key)!; })
    : rank ? filtered.slice().sort((a, b) => (rank.get(a.countryCode) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.countryCode) ?? Number.MAX_SAFE_INTEGER) || order.get(a.key)! - order.get(b.key)!)
    : filtered;
  const pageSize = Math.max(1, Math.min(q.pageSize ?? 50, 500));
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(Math.max(1, q.page ?? 1), pageCount);
  const out = sorted.slice((page - 1) * pageSize, page * pageSize);
  return {
    rows: out, total: sorted.length, page, pageCount, from: out.length ? (page - 1) * pageSize + 1 : 0, to: (page - 1) * pageSize + out.length,
    geoStates: new Set(filtered.filter(r => r.scope === "state").map(r => `${r.countryCode}|${r.geoStateCode}`)).size,
    mappings: filtered.filter(r => r.record).length,
  };
}

/** Distinct tax codes / categories present in the mapping (for the filters). */
export function mappingFacets(rows: MappingRow[], countryCode?: string | null) {
  const pick = (f: (r: MappingRow) => string | null) => [...new Set(rows.filter(r => !countryCode || r.countryCode === countryCode).map(f).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));
  return { taxCodes: pick(r => r.taxCode), taxCategories: pick(r => r.taxCategory) };
}
