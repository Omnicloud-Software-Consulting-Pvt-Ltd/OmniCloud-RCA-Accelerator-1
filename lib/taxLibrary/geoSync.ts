import { salesforceStateIso } from "@/lib/taxLibrary/jurisdictions";

/**
 * Library geography ↔ the connected org's Salesforce Geo records, matched by ISO codes only (never names):
 *  · Geo Country: GeoCountry.IsoCode = ISO 3166-1 alpha-2 ("AU").
 *  · Geo State: GeoState.IsoCode = the ISO 3166-2 suffix ("NSW" for AU-NSW — verified in p10: "AP" for IN-AP) UNDER its parent
 *    (GeoState.GeoCountryId → that GeoCountry). A state of the same code under another country never matches.
 * Salesforce metadata (p10): GeoCountry.IsoCode required + unique (2 chars); GeoState.GeoCountryId and IsoCode required and
 * create-only; GeoState.IsoCode is NOT unique, so duplicates are prevented by the app (lib/billing/server/rules.ts geoIssues).
 */

export interface OrgGeoCountry { id: string; name: string; isoCode: string }
export interface OrgGeoState { id: string; name: string; isoCode: string | null; geoCountryId: string; countryIso: string }
export interface OrgGeo {
  success: boolean;
  countries: OrgGeoCountry[];
  states: OrgGeoState[];
  available: { geoCountry: boolean; geoState: boolean; createGeoCountry?: boolean; createGeoState?: boolean };
  error?: string;
}

export interface OrgGeoIndex { countryByIso: Map<string, OrgGeoCountry>; stateByKey: Map<string, OrgGeoState>; statesByCountryId: Map<string, OrgGeoState[]> }

export function indexOrgGeo(g: OrgGeo): OrgGeoIndex {
  const countryByIso = new Map(g.countries.map(c => [c.isoCode.toUpperCase(), c]));
  const byId = new Map(g.countries.map(c => [c.id, c]));
  const stateByKey = new Map<string, OrgGeoState>();
  const statesByCountryId = new Map<string, OrgGeoState[]>();
  for (const s of g.states) {
    const parentIso = (byId.get(s.geoCountryId)?.isoCode ?? s.countryIso).toUpperCase();
    if (s.isoCode) stateByKey.set(`${parentIso}|${s.isoCode.toUpperCase()}`, s);
    statesByCountryId.set(s.geoCountryId, [...(statesByCountryId.get(s.geoCountryId) ?? []), s]);
  }
  return { countryByIso, stateByKey, statesByCountryId };
}

export type GeoStatus = "available" | "country-missing" | "state-missing";
export const GEO_STATUS_LABEL: Record<GeoStatus, string> = { available: "Available in Salesforce", "country-missing": "Geo Country missing", "state-missing": "Geo State missing" };

/** Status of one mapping row: a state row needs its Geo Country first, then its Geo State; country / region rows need the country. */
export function geoStatusOf(row: { countryCode: string; geoStateCode: string | null; scope: "country" | "state" | "region" }, idx: OrgGeoIndex): { status: GeoStatus; country: OrgGeoCountry | null; state: OrgGeoState | null } {
  const country = idx.countryByIso.get(row.countryCode.toUpperCase()) ?? null;
  if (!country) return { status: "country-missing", country: null, state: null };
  if (row.scope !== "state" || !row.geoStateCode) return { status: "available", country, state: null };
  const state = idx.stateByKey.get(`${country.isoCode.toUpperCase()}|${salesforceStateIso(row.geoStateCode).toUpperCase()}`) ?? null;
  return { status: state ? "available" : "state-missing", country, state };
}

/** Missing-geography counts for a set of mapping rows (distinct countries / states). */
export function missingGeo(rows: { countryCode: string; geoStateCode: string | null; scope: "country" | "state" | "region" }[], idx: OrgGeoIndex) {
  const countries = new Set<string>(), states = new Set<string>(), statesWithoutCountry = new Set<string>();
  for (const r of rows) {
    const s = geoStatusOf(r, idx);
    if (s.status === "country-missing") { countries.add(r.countryCode); if (r.scope === "state" && r.geoStateCode) statesWithoutCountry.add(r.geoStateCode); }
    else if (s.status === "state-missing" && r.geoStateCode) states.add(r.geoStateCode);
  }
  return { countries: countries.size, states: states.size, statesWithoutCountry: statesWithoutCountry.size };
}

/* ── automatic creation flow (UI side; the writes happen server-side in lib/taxLibrary/server/geoEnsure.ts) ── */

/** A fresh read of one country's Salesforce geography (route mode=geo-states: GeoCountry by IsoCode, its GeoStates by GeoCountryId). */
export interface FreshGeo {
  success: boolean;
  country: { id: string; name: string; isoCode: string } | null;
  states: { id: string; name: string; isoCode: string | null }[];
  available: { geoCountry: boolean; geoState: boolean };
}
export interface GeoTarget { country: { iso: string; name: string }; state: { code: string; name: string } | null }
export type GeoPlan =
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; message: string; resolved: { country: { id: string; name: string }; state: { id: string; name: string } | null } }
  | { kind: "create"; needCountry: boolean; needState: boolean; existingCountry: { id: string; name: string } | null };

/** What (if anything) must be created for a mapping row — from a FRESH read; a Geo State only counts under its own Geo Country. */
export function planGeoFlow(fresh: FreshGeo, target: GeoTarget): GeoPlan {
  if (!fresh.available.geoCountry || (target.state && fresh.country && !fresh.available.geoState)) {
    return { kind: "unavailable", message: "This org doesn't expose Geo Country / Geo State (or their ISO Code) to your Salesforce user, so they can't be created from here." };
  }
  const iso = target.state ? (target.state.code.includes("-") ? target.state.code.slice(target.state.code.indexOf("-") + 1) : target.state.code).toUpperCase() : null;
  if (!fresh.country) return { kind: "create", needCountry: true, needState: !!target.state, existingCountry: null };
  const existingState = iso ? fresh.states.find(s => (s.isoCode ?? "").toUpperCase() === iso) ?? null : null;
  if (iso && !existingState) return { kind: "create", needCountry: false, needState: true, existingCountry: { id: fresh.country.id, name: fresh.country.name } };
  return {
    kind: "ready",
    message: existingState ? `Geo State ${existingState.name} (${iso}) already exists under ${fresh.country.name} — nothing to create.` : `Geo Country ${fresh.country.name} (${fresh.country.isoCode}) already exists — nothing to create.`,
    resolved: { country: { id: fresh.country.id, name: fresh.country.name }, state: existingState ? { id: existingState.id, name: existingState.name } : null },
  };
}

export interface GeoFlow extends GeoTarget {
  needCountry: boolean;
  needState: boolean;
  existingCountry: { id: string; name: string } | null;
  /** Set when the flow was started by Create Tax Rate: the rate to open the form for once the geography exists. */
  continueRate: { record: import("@/lib/taxLibrary/types").TaxRateReference; state?: { code: string; name: string }; usingKey: string } | null;
  busy: boolean;
  error: string | null;
  partial: string | null;
}

/** The confirmation question (Scenario B / C wording for Create Tax Rate). */
export function geoFlowQuestion(f: Pick<GeoFlow, "country" | "state" | "needCountry" | "needState" | "continueRate">): string {
  const tail = f.continueRate ? " before creating this Tax Rate?" : "?";
  if (f.needCountry && f.needState && f.state) return `Geo Country ${f.country.name} and Geo State ${f.state.name} do not exist in Salesforce. Would you like to create both automatically${tail}`;
  if (f.needState && f.state) return `Geo State ${f.state.name} does not exist in Salesforce. Would you like to create it automatically${tail}`;
  return `Geo Country ${f.country.name} does not exist in Salesforce. Would you like to create it automatically${tail}`;
}

/** Exactly what will be written (Salesforce field = value), in order. */
export function geoFlowWrites(f: Pick<GeoFlow, "country" | "state" | "needCountry" | "needState" | "existingCountry">): { object: "GeoCountry" | "GeoState"; fields: Record<string, string> }[] {
  const out: { object: "GeoCountry" | "GeoState"; fields: Record<string, string> }[] = [];
  if (f.needCountry) out.push({ object: "GeoCountry", fields: { Name: f.country.name, IsoCode: f.country.iso.toUpperCase() } });
  if (f.needState && f.state) {
    const iso = (f.state.code.includes("-") ? f.state.code.slice(f.state.code.indexOf("-") + 1) : f.state.code).toUpperCase();
    out.push({ object: "GeoState", fields: { Name: f.state.name, IsoCode: iso, GeoCountryId: f.existingCountry ? `${f.existingCountry.id} (${f.existingCountry.name})` : `the new Geo Country ${f.country.name} (${f.country.iso.toUpperCase()})` } });
  }
  return out;
}

