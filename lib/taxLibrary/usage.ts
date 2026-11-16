/**
 * TAX LIBRARY USAGE — the user's own recent tax-library activity (which countries they work on, which reference rates they used),
 * for the Taxes dashboard's "Tax Library – Frequently Used & Recent" widget.
 *
 * Storage follows the app's existing model (there is no app database): browser localStorage, scoped to the signed-in app user
 * (lib/auth/identity) AND the Salesforce connection (instance + Salesforce user, useConnectionKey) — so one user's history is never
 * shown to another user, and one org's history never mixes into another org. Without both, nothing is recorded or shown.
 *
 * What counts:
 *  · RECENT — interactions in the library: selecting a country / opening its mappings, starting a Tax Rate from a mapping, creating
 *    a Geo Country / Geo State. Last-used timestamp per country.
 *  · FREQUENT — real configuration in Salesforce, read live: Tax Rates, Geo States and Geo Countries the CURRENT Salesforce user
 *    created, per country (server: /api/taxes/rate-library/salesforce?mode=dashboard). Dropdown opens are never counted. Local
 *    create events are only used when Salesforce couldn't be read.
 */

export type UsageKind = "country-selected" | "tax-rate-started" | "geo-country-created" | "geo-state-created";
/** Kinds that represent configuration work (fallback frequency when Salesforce activity can't be read). */
const MEANINGFUL: UsageKind[] = ["tax-rate-started", "geo-country-created", "geo-state-created"];

export interface RateUsage { key: string; taxCode: string; countryCode: string; countryName: string; geoStateCode: string | null; geoStateName: string | null; taxCategory: string | null; ratePercent: number | null; at: number; count: number }
export interface CountryUsage { name: string; lastUsedAt: number; events: Partial<Record<UsageKind, number>> }
export interface UsageState { version: 1; countries: Record<string, CountryUsage>; rates: RateUsage[] }
export interface UsageEvent { kind: UsageKind; countryCode: string; countryName: string; rate?: Omit<RateUsage, "at" | "count"> }

export const emptyUsage = (): UsageState => ({ version: 1, countries: {}, rates: [] });
const MAX_RATES = 30, MAX_COUNTRIES = 100;

/** Pure: the state after one event (newest first; bounded). */
export function recordUsage(state: UsageState, ev: UsageEvent, now = Date.now()): UsageState {
  const cc = ev.countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return state;
  const prev = state.countries[cc];
  const countries = { ...state.countries, [cc]: { name: ev.countryName || prev?.name || cc, lastUsedAt: now, events: { ...prev?.events, [ev.kind]: (prev?.events[ev.kind] ?? 0) + 1 } } };
  const keep = Object.entries(countries).sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt).slice(0, MAX_COUNTRIES);
  let rates = state.rates;
  if (ev.rate) {
    const old = rates.find(r => r.key === ev.rate!.key);
    rates = [{ ...ev.rate, at: now, count: (old?.count ?? 0) + 1 }, ...rates.filter(r => r.key !== ev.rate!.key)].slice(0, MAX_RATES);
  }
  return { version: 1, countries: Object.fromEntries(keep), rates };
}

/* ── storage (per app user + Salesforce connection) ── */

export const TAX_USAGE_PREFIX = "omnicloud_tax_library_usage_v1::";
export const TAX_USAGE_EVENT = "omnicloud:tax-library-usage";
export interface UsageStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

/** Scope key, or null when the user or the Salesforce connection isn't known (then nothing is recorded or shown). */
export function usageScope(appUser: string | null | undefined, connectionKey: string | null | undefined): string | null {
  if (!appUser || !connectionKey || connectionKey === "none" || connectionKey === "server") return null;
  return `${appUser.trim().toLowerCase()}::${connectionKey}`;
}

export function loadUsage(storage: UsageStorage | null, scope: string | null): UsageState {
  if (!storage || !scope) return emptyUsage();
  try {
    const v = JSON.parse(storage.getItem(TAX_USAGE_PREFIX + scope) ?? "null") as UsageState | null;
    return v && v.version === 1 && v.countries && Array.isArray(v.rates) ? v : emptyUsage();
  } catch { return emptyUsage(); }
}

export function trackUsage(storage: UsageStorage | null, scope: string | null, ev: UsageEvent, now = Date.now()): UsageState | null {
  if (!storage || !scope) return null;
  const next = recordUsage(loadUsage(storage, scope), ev, now);
  try { storage.setItem(TAX_USAGE_PREFIX + scope, JSON.stringify(next)); } catch { return null; }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TAX_USAGE_EVENT));
  return next;
}

/** Browser helpers: the current app user (identity) — the Salesforce part comes from useConnectionKey. */
export function browserUsageStorage(): UsageStorage | null { try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; } }
export function currentAppUser(storage: UsageStorage | null): string | null {
  try { const v = JSON.parse(storage?.getItem("omnicloud_identity") ?? "null") as { email?: string } | null; return v?.email ?? null; } catch { return null; }
}

/* ── default library ordering (all countries, sorting — never filtering) ── */

export type PriorityTier = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const PRIORITY_TIER_LABEL: Record<PriorityTier, string> = {
  1: "Recently used", 2: "You created Tax Rates", 3: "You created Geo records", 4: "Frequently used", 5: "Tax Rates in this org", 6: "Official tax data", 7: "Other",
};
export interface CountryPriority { code: string; tier: PriorityTier; rank: number }

/**
 * Deterministic default order of the Global Tax Library's countries:
 *  1 recent user activity (newest first) → 2 countries where this Salesforce user created Tax Rates (latest, then most) →
 *  3 … created Geo Countries / Geo States (latest, then most) → 4 frequently used in the library (create actions, most first) →
 *  5 countries with Tax Rates in the org (most first) → 6 countries with official tax data (most rates first) → 7 everything else
 *  (alphabetical). EVERY country gets a rank — this orders the full 249-country list, it never removes one.
 */
export function countryPriority(a: {
  countries: { code: string; name: string }[];
  usage: UsageState;
  myTaxRates: SalesforceCountryActivity[] | null;
  myGeo: SalesforceCountryActivity[] | null;
  configured: ConfiguredCountry[];
  dataCountries: Map<string, number>;
}): Map<string, CountryPriority> {
  const agg = (list: SalesforceCountryActivity[] | null) => {
    const m = new Map<string, { n: number; last: number }>();
    for (const x of list ?? []) { const cc = x.iso.toUpperCase(); const p = m.get(cc); m.set(cc, { n: (p?.n ?? 0) + x.n, last: Math.max(p?.last ?? 0, x.lastAt ? Date.parse(x.lastAt) || 0 : 0) }); }
    return m;
  };
  const rates = agg(a.myTaxRates), geo = agg(a.myGeo);
  const configured = new Map(a.configured.map(c => [c.iso.toUpperCase(), c.n]));
  const meaningful = (cc: string) => { const u = a.usage.countries[cc]; return u ? MEANINGFUL.reduce((s, k) => s + (u.events[k] ?? 0), 0) : 0; };
  const keyed = a.countries.map(c => {
    const cc = c.code.toUpperCase();
    const u = a.usage.countries[cc];
    // [tier, primary (desc), secondary (desc)]
    const k: [PriorityTier, number, number] =
      u ? [1, u.lastUsedAt, 0]
      : rates.has(cc) ? [2, rates.get(cc)!.last, rates.get(cc)!.n]
      : geo.has(cc) ? [3, geo.get(cc)!.last, geo.get(cc)!.n]
      : meaningful(cc) > 0 ? [4, meaningful(cc), 0]
      : (configured.get(cc) ?? 0) > 0 ? [5, configured.get(cc)!, 0]
      : (a.dataCountries.get(cc) ?? 0) > 0 ? [6, a.dataCountries.get(cc)!, 0]
      : [7, 0, 0];
    return { code: cc, name: c.name, k };
  });
  keyed.sort((x, y) => x.k[0] - y.k[0] || y.k[1] - x.k[1] || y.k[2] - x.k[2] || x.name.localeCompare(y.name));
  return new Map(keyed.map((x, i) => [x.code, { code: x.code, tier: x.k[0], rank: i }]));
}

/* ── dashboard ranking ── */

export interface SalesforceCountryActivity { iso: string; n: number; lastAt: string | null }
export interface ConfiguredCountry { iso: string; name: string | null; n: number }
export interface RankedCountry { code: string; name: string; reason: "recent" | "frequent" | "configured" | "official-data"; lastUsedAt: number | null; count: number | null; hasData: boolean }

/**
 * Dashboard countries, in priority order: 1 recently used → 2 frequently used (Salesforce configuration by this user) → 3 countries
 * with Tax Rates configured in the org → 4 countries with official source data in the library. Countries with no data, no Tax Rates
 * and no usage are never returned (they stay in the full library). Each list is de-duplicated against the higher-priority ones.
 */
export function rankDashboardCountries(a: {
  usage: UsageState;
  /** null = Salesforce activity couldn't be read → local meaningful events are used for "frequent". */
  myActivity: SalesforceCountryActivity[] | null;
  configured: ConfiguredCountry[];
  /** Countries with source-backed rates in the library → their rate count. */
  dataCountries: Map<string, number>;
  names: (code: string) => string | null;
  limits?: { recent?: number; frequent?: number; configured?: number; suggested?: number };
}): { recent: RankedCountry[]; frequent: RankedCountry[]; configured: RankedCountry[]; suggested: RankedCountry[] } {
  const L = { recent: 5, frequent: 5, configured: 6, suggested: 6, ...a.limits };
  const name = (cc: string, fallback?: string | null) => a.names(cc) ?? fallback ?? cc;
  const has = (cc: string) => a.dataCountries.has(cc) || a.configured.some(c => c.iso === cc);
  const recent = Object.entries(a.usage.countries).sort((x, y) => y[1].lastUsedAt - x[1].lastUsedAt).slice(0, L.recent)
    .map(([cc, u]): RankedCountry => ({ code: cc, name: name(cc, u.name), reason: "recent", lastUsedAt: u.lastUsedAt, count: null, hasData: has(cc) }));
  const seen = new Set(recent.map(r => r.code));
  const freqSource = a.myActivity
    ? a.myActivity.map(x => ({ cc: x.iso.toUpperCase(), n: x.n, last: x.lastAt ? Date.parse(x.lastAt) : 0 }))
    : Object.entries(a.usage.countries).map(([cc, u]) => ({ cc, n: MEANINGFUL.reduce((s, k) => s + (u.events[k] ?? 0), 0), last: u.lastUsedAt }));
  const byCc = new Map<string, { n: number; last: number }>();
  for (const f of freqSource) { const p = byCc.get(f.cc); byCc.set(f.cc, { n: (p?.n ?? 0) + f.n, last: Math.max(p?.last ?? 0, f.last) }); }
  const frequent = [...byCc.entries()].filter(([cc, v]) => v.n > 0 && !seen.has(cc)).sort((x, y) => y[1].n - x[1].n || y[1].last - x[1].last).slice(0, L.frequent)
    .map(([cc, v]): RankedCountry => ({ code: cc, name: name(cc), reason: "frequent", lastUsedAt: v.last || null, count: v.n, hasData: has(cc) }));
  for (const f of frequent) seen.add(f.code);
  const configured = a.configured.filter(c => c.iso && c.n > 0 && !seen.has(c.iso.toUpperCase())).sort((x, y) => y.n - x.n).slice(0, L.configured)
    .map((c): RankedCountry => ({ code: c.iso.toUpperCase(), name: name(c.iso.toUpperCase(), c.name), reason: "configured", lastUsedAt: null, count: c.n, hasData: true }));
  for (const c of configured) seen.add(c.code);
  const suggested = [...a.dataCountries.entries()].filter(([cc, n]) => n > 0 && !seen.has(cc)).sort((x, y) => y[1] - x[1] || name(x[0]).localeCompare(name(y[0]))).slice(0, L.suggested)
    .map(([cc, n]): RankedCountry => ({ code: cc, name: name(cc), reason: "official-data", lastUsedAt: null, count: n, hasData: true }));
  return { recent, frequent, configured, suggested };
}
