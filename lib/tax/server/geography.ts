import { resolveCountry } from "@/lib/tax/server/country";

/**
 * Address Country/State → the codes Salesforce's tax decision table matches. The table compares Order.BillingCountry /
 * BillingState as exact values: "IN"/"AP" match a rate while "India"/"Andhra Pradesh" (or "canada"/"ontario") return No Match.
 * Every address write and every geography check goes through here, resolved against the connected org's GeoCountry / GeoState
 * records — no country is special-cased. Pure — no Salesforce calls.
 */

/** The org's GeoCountry / GeoState codes (loadTaxGeoFacts). */
export interface TaxGeoFacts { countries: { name: string; iso: string }[]; states: { name: string; iso: string; countryIso: string | null }[] }

/** A resolved Country or State: its code, readable name, and whether the org has a Geo record for it. */
export interface GeoMatch { iso: string; name: string; known: boolean }

const lc = (v: string) => v.trim().toLowerCase();

/** "canada" / "Canada" / "CA" → CA (org GeoCountry first, then ISO names and aliases such as "USA"). Null when unrecognised. */
export function normalizeCountry(raw: string | null | undefined, geo: TaxGeoFacts | null): GeoMatch | null {
  const v = raw?.trim();
  if (!v) return null;
  const c = geo?.countries.find(x => lc(x.iso) === lc(v) || lc(x.name) === lc(v));
  if (c) return { iso: c.iso, name: c.name, known: true };
  const r = resolveCountry(v, (geo?.countries ?? []).map(x => ({ id: "", name: x.name, iso: x.iso })));
  if (!r) return null;
  const g = geo?.countries.find(x => x.iso === r.iso);
  return { iso: r.iso, name: g?.name ?? r.name, known: !!g };
}

/**
 * "ontario" / "Ontario" / "ON" → ON within the given country (GeoState records). A name that matches states of several countries
 * resolves only when the country narrows it to one. An unknown short code (≤3 letters/digits) is kept, upper-cased; an unknown
 * name is null — it can't be turned into a code.
 */
export function normalizeState(raw: string | null | undefined, countryIso: string | null, geo: TaxGeoFacts | null): GeoMatch | null {
  const v = raw?.trim();
  if (!v) return null;
  const matches = (geo?.states ?? []).filter(x => (lc(x.iso) === lc(v) || lc(x.name) === lc(v)) && (!countryIso || !x.countryIso || x.countryIso === countryIso));
  const st = matches.length === 1 ? matches[0] : matches.find(x => lc(x.iso) === lc(v)) ?? null;
  if (st) return { iso: st.iso, name: st.name, known: true };
  return /^[A-Za-z0-9]{1,3}$/.test(v) ? { iso: v.toUpperCase(), name: v.toUpperCase(), known: false } : null;
}

export interface NormalizedGeography {
  /** The values to store: the ISO code when resolved, otherwise the trimmed input (left for readiness to report). */
  country: string | null; state: string | null;
  /** Readable labels for display ("Canada", "Ontario"); the input when unresolved. */
  countryName: string | null; stateName: string | null;
  countryKnown: boolean; stateKnown: boolean;
}

/** An address's Country/State as stored values (ISO codes) plus their readable labels. */
export function normalizeGeography(a: { country: string | null | undefined; state: string | null | undefined }, geo: TaxGeoFacts | null): NormalizedGeography {
  const country = a.country?.trim() || null, state = a.state?.trim() || null;
  const c = normalizeCountry(country, geo);
  const s = normalizeState(state, c?.iso ?? null, geo);
  return {
    country: c?.iso ?? country, state: s?.iso ?? state,
    countryName: c?.name ?? country, stateName: s?.name ?? state,
    countryKnown: !!c?.known, stateKnown: !!s?.known,
  };
}

/** "Canada (CA)" — the readable label with the stored code; just the value when they're the same. */
export function geographyLabel(name: string | null, iso: string | null): string | null {
  if (!iso) return name;
  return name && name !== iso ? `${name} (${iso})` : iso;
}
