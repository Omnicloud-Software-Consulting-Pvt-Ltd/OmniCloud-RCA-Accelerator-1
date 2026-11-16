import { iso31661, iso31662 } from "iso-3166";

/**
 * Jurisdiction reference data — ISO 3166-1 (countries) and ISO 3166-2 (subdivisions) from the `iso-3166` package
 * (MIT, wooorm, data maintained from the ISO 3166 lists). 249 assigned countries and ~5,000 subdivisions, including nested ones
 * (e.g. a district inside a region). Nothing here is hand-typed.
 *
 * ISO doesn't label a subdivision as "state", "province", "territory" or "prefecture" in this dataset, so the app shows the
 * neutral term "Subdivision" (with its hierarchy level) instead of guessing a category.
 * Client code should load this module lazily (`await import(...)`) so the data isn't in the main bundle.
 */

export interface Country { code: string; name: string; alpha3: string; numeric: string }
export interface Subdivision { code: string; name: string; countryCode: string; parent: string; /** 1 = directly under the country, 2 = under another subdivision. */ level: 1 | 2 }

export const COUNTRIES: Country[] = iso31661
  .map(c => ({ code: c.alpha2, name: c.name, alpha3: c.alpha3, numeric: c.numeric }))
  .sort((a, b) => a.name.localeCompare(b.name));

const COUNTRY_BY_CODE = new Map(COUNTRIES.map(c => [c.code, c]));

export const SUBDIVISIONS: Subdivision[] = iso31662.map(s => ({
  code: s.code, name: s.name, countryCode: s.code.split("-")[0], parent: s.parent, level: s.parent.includes("-") ? 2 : 1,
}));

const SUBS_BY_COUNTRY = new Map<string, Subdivision[]>();
for (const s of SUBDIVISIONS) {
  const list = SUBS_BY_COUNTRY.get(s.countryCode) ?? [];
  list.push(s);
  SUBS_BY_COUNTRY.set(s.countryCode, list);
}
for (const list of SUBS_BY_COUNTRY.values()) list.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
const SUB_BY_CODE = new Map(SUBDIVISIONS.map(s => [s.code, s]));

export const DATASET_INFO = {
  source: "ISO 3166-1 / ISO 3166-2 via the iso-3166 npm package (MIT)",
  countries: COUNTRIES.length,
  subdivisions: SUBDIVISIONS.length,
  countriesWithSubdivisions: SUBS_BY_COUNTRY.size,
};

export function getCountry(code: string | null | undefined): Country | null {
  return code ? COUNTRY_BY_CODE.get(code.trim().toUpperCase()) ?? null : null;
}

/** Subdivisions of a country — empty for countries without ISO 3166-2 subdivisions (country-level only). */
export function subdivisionsOf(countryCode: string | null | undefined): Subdivision[] {
  return countryCode ? SUBS_BY_COUNTRY.get(countryCode.trim().toUpperCase()) ?? [] : [];
}

export function getSubdivision(code: string | null | undefined): Subdivision | null {
  return code ? SUB_BY_CODE.get(code.trim().toUpperCase()) ?? null : null;
}

/** "India" / "in" / "IND" → IN. */
export function resolveCountryCode(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  const u = v.toUpperCase();
  const hit = COUNTRY_BY_CODE.get(u) ?? COUNTRIES.find(c => c.alpha3 === u || c.name.toLowerCase() === v.toLowerCase());
  return hit?.code ?? null;
}

/** "IN-AP" / "AP" (with country IN) / "Andhra Pradesh" → IN-AP; null if it isn't a subdivision of that country. */
export function resolveSubdivisionCode(raw: string | null | undefined, countryCode: string): string | null {
  const v = raw?.trim();
  if (!v) return null;
  const cc = countryCode.toUpperCase();
  const full = v.toUpperCase().startsWith(`${cc}-`) ? v.toUpperCase() : `${cc}-${v.toUpperCase()}`;
  const direct = SUB_BY_CODE.get(full);
  if (direct && direct.countryCode === cc) return direct.code;
  const byName = subdivisionsOf(cc).filter(s => s.name.toLowerCase() === v.toLowerCase());
  return byName.length === 1 ? byName[0].code : null;
}

/** ISO 3166-2 "IN-AP" → the part Salesforce GeoState.IsoCode stores ("AP"; verified in p10, where GeoCountry.IsoCode is "IN"). */
export function salesforceStateIso(subdivisionCode: string): string {
  return subdivisionCode.includes("-") ? subdivisionCode.slice(subdivisionCode.indexOf("-") + 1) : subdivisionCode;
}
