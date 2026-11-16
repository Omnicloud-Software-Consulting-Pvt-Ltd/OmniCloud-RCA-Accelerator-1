import type { GeoCountryRow } from "@/lib/tax/types";

/**
 * The country Salesforce's tax lookup matches on. TaxRate.Country is derived from GeoCountry.IsoCode (ISO-2) and the invoice
 * sends the invoice address country, so a country the user names ("India", "USA") is normalised to its ISO-2 code and matched
 * to the org's GeoCountry records. Pure — no Salesforce calls.
 */
export interface ResolvedCountry { iso: string; name: string; geoCountryId: string | null; input: string; normalized: boolean }

const ALIASES: Record<string, string> = { USA: "US", "U.S.": "US", "U.S.A.": "US", "UNITED STATES OF AMERICA": "US", UK: "GB", "U.K.": "GB", "GREAT BRITAIN": "GB", ENGLAND: "GB", UAE: "AE", BHARAT: "IN" };

export function resolveCountry(raw: string | null | undefined, geos: GeoCountryRow[]): ResolvedCountry | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const up = value.toUpperCase();
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  const isRegion = (code: string) => { try { return display.of(code) !== code; } catch { return false; } };
  let iso: string | null = /^[A-Z]{2}$/.test(up) && isRegion(up) ? up : null;
  iso ??= geos.find(g => g.name.toUpperCase() === up)?.iso ?? null;
  iso ??= ALIASES[up] ?? null;
  if (!iso) {
    // English region names ("United States", "India", …) from the platform's own ISO table.
    for (let a = 65; a <= 90 && !iso; a++) for (let b = 65; b <= 90 && !iso; b++) {
      const code = String.fromCharCode(a, b);
      try { if (display.of(code)?.toUpperCase() === up) iso = code; } catch { /* not a region */ }
    }
  }
  if (!iso) return null;
  const geo = geos.find(g => g.iso === iso);
  return { iso, name: geo?.name ?? display.of(iso) ?? iso, geoCountryId: geo?.id ?? null, input: value, normalized: value !== iso };
}
