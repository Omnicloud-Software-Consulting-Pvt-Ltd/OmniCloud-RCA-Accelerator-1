"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, GhostButton, PrimaryButton, Spinner } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData } from "@/lib/quotes/client/apiClient";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import type { TaxesLaunch } from "@/components/data/taxes/TaxesDashboard";
import {
  TAX_USAGE_EVENT, browserUsageStorage, currentAppUser, emptyUsage, loadUsage, rankDashboardCountries, usageScope,
  type ConfiguredCountry, type RankedCountry, type SalesforceCountryActivity, type UsageState,
} from "@/lib/taxLibrary/usage";
import type { TaxRateReference } from "@/lib/taxLibrary/types";

interface DashboardData {
  success: boolean;
  myActivity: SalesforceCountryActivity[] | null;
  configured: ConfiguredCountry[];
  recentRates: { id: string; name: string; taxCode: string | null; rate: number | null; countryIso: string | null; countryName: string | null; stateIso: string | null; stateName: string | null; createdDate: string; lastModifiedDate: string }[];
  errors: string[];
}
interface Reference { dataCountries: Map<string, number>; names: Map<string, string>; records: TaxRateReference[] }

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * "Tax Library – Frequently Used & Recent" — the Taxes dashboard's personalised entry to the Global Tax Rate Library. Priority:
 * recently used → frequently used (Salesforce configuration this user created) → countries with Tax Rates in the org → countries
 * with official source data. Countries without data, Tax Rates or usage never lead (they stay in the full library). Read-only.
 */
export default function TaxLibraryWidget({ isDark, connectionKey, onLaunch }: { isDark: boolean; connectionKey: string; onLaunch: (t: TaxesLaunch) => void }) {
  const t = tokens(isDark);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ref, setRef] = useState<Reference | null>(null);
  const [usage, setUsage] = useState<UsageState>(emptyUsage);
  const scopeReady = connectionKey !== "server" && connectionKey !== "none";

  // The user's own activity (this app user + this Salesforce connection only).
  useEffect(() => {
    const read = () => { const st = browserUsageStorage(); setUsage(loadUsage(st, usageScope(currentAppUser(st), connectionKey))); };
    read();
    window.addEventListener(TAX_USAGE_EVENT, read);
    window.addEventListener("storage", read);
    return () => { window.removeEventListener(TAX_USAGE_EVENT, read); window.removeEventListener("storage", read); };
  }, [connectionKey]);

  // Salesforce: this user's configuration per country, the org's Tax Rates per country, this user's recent Tax Rates.
  useEffect(() => {
    if (!scopeReady) return;
    let live = true;
    quoteApiGet<DashboardData>("Load Tax Library activity", `/api/taxes/rate-library/salesforce?mode=dashboard&c=${encodeURIComponent(connectionKey)}`)
      .then(r => { if (live) { setData(r); setError(null); } })
      .catch(err => { if (live) setError(toErrorPanelData(err, "Couldn't read your Salesforce tax activity").message); });
    return () => { live = false; };
  }, [connectionKey, scopeReady]);

  // Library reference data (lazy — not in the dashboard's main bundle): which countries have source-backed rates, country names.
  useEffect(() => {
    let live = true;
    Promise.all([import("@/lib/taxLibrary/reference").then(m => m.loadReferenceData()), import("@/lib/taxLibrary/jurisdictions")]).then(([d, g]) => {
      if (!live) return;
      const dataCountries = new Map<string, number>();
      for (const r of d.records) if (r.lifecycle === "published") dataCountries.set(r.jurisdiction.countryCode, (dataCountries.get(r.jurisdiction.countryCode) ?? 0) + 1);
      setRef({ dataCountries, names: new Map(g.COUNTRIES.map(c => [c.code, c.name])), records: d.records });
    }).catch(() => { if (live) setRef({ dataCountries: new Map(), names: new Map(), records: [] }); });
    return () => { live = false; };
  }, []);

  const ranked = useMemo(() => rankDashboardCountries({
    usage, myActivity: data ? data.myActivity : null, configured: data?.configured ?? [], dataCountries: ref?.dataCountries ?? new Map(),
    names: cc => ref?.names.get(cc) ?? null,
  }), [usage, data, ref]);
  // Tax Category for a Salesforce Tax Rate: only when the library has exactly one category for that tax code in that country.
  const categoryOf = (code: string | null, cc: string | null) => {
    if (!ref || !code || !cc) return null;
    const cats = new Set(ref.records.filter(r => r.tax.taxCode === code && r.jurisdiction.countryCode === cc).map(r => r.tax.taxCategory).filter(Boolean));
    return cats.size === 1 ? [...cats][0] : null;
  };

  const openCountry = (cc: string) => onLaunch({ library: { countryCode: cc } });
  const section = (title: string, hint: string, body: ReactNode) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}><b style={{ fontSize: 12, color: t.heading }}>{title}</b><span style={{ fontSize: 10.5, color: t.dim }}>{hint}</span></div>
      {body}
    </div>
  );
  const chips = (list: RankedCountry[], detail: (c: RankedCountry) => string) => (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {list.map(c => (
        <button key={c.code} type="button" onClick={() => openCountry(c.code)} title={`Open ${c.name} in the Global Tax Rate Library`}
          style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 1, padding: "5px 10px", borderRadius: 9, cursor: "pointer", border: `1px solid ${t.border}`, background: t.surface, color: t.body, fontSize: 12 }}>
          <span><b style={{ color: t.heading }}>{c.name}</b> <span style={{ color: t.dim }}>{c.code}</span></span>
          <span style={{ fontSize: 10.5, color: t.dim }}>{detail(c)}{!c.hasData ? " · no tax data" : ""}</span>
        </button>
      ))}
    </div>
  );
  const none = (text: string) => <span style={{ fontSize: 11.5, color: t.dim }}>{text}</span>;

  const myRates = data?.recentRates ?? [];
  const libraryRates = usage.rates.slice(0, 4);
  const empty = !ranked.recent.length && !ranked.frequent.length && !ranked.configured.length && !myRates.length && !libraryRates.length;
  const loading = scopeReady && !data && !error;

  return (
    <div data-testid="tax-library-widget" style={{ border: `1px solid ${t.border}`, borderRadius: 14, padding: 14, background: t.surface, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="globe" s={16} /></span>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: t.heading }}>Tax Library – Frequently Used &amp; Recent</div>
            <div style={{ fontSize: 11, color: t.dim }}>Your countries and tax rates in this Salesforce org first — the full 249-country library is one click away.</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <PrimaryButton label="Quick Create Tax Rate" icon="plus" isDark={isDark} onClick={() => onLaunch({ module: "tax-rates", view: "create" })} />
          <GhostButton label="View Full Tax Library" icon="globe" isDark={isDark} onClick={() => onLaunch({ library: {} })} />
        </div>
      </div>

      {loading && <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={12} /> Reading your tax activity from Salesforce…</div>}
      {error && <div style={{ fontSize: 11.5, color: t.warn }}>{error} — showing this browser&apos;s activity only.</div>}
      {!!data?.errors.length && <div style={{ fontSize: 11, color: t.dim }}>Partly unavailable: {data.errors.join(" · ")}</div>}
      {!scopeReady && <div style={{ fontSize: 11.5, color: t.dim }}>Connect to Salesforce to see your recent and frequent tax countries.</div>}

      {empty && !loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: t.body }}>You haven&apos;t used the Tax Library or configured Tax Rates in this org yet. Pick a country in the library, or start with a country that has official tax data:</div>
          {ranked.suggested.length ? chips(ranked.suggested, c => `${c.count} source-backed rate${c.count === 1 ? "" : "s"}`) : ref ? none("No reference data loaded.") : <Spinner isDark={isDark} size={12} />}
        </div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          {section("Recently Used Countries", "last opened first", ranked.recent.length ? chips(ranked.recent, c => (c.lastUsedAt ? `used ${formatRelativeTime(iso(c.lastUsedAt))}` : "")) : none("None yet — countries you open in the Tax Library appear here."))}
          {section("Frequently Used Countries", data?.myActivity ? "Tax Rates & Geo records you created in Salesforce" : "from this browser's activity", ranked.frequent.length ? chips(ranked.frequent, c => `${c.count} configuration${c.count === 1 ? "" : "s"}${c.lastUsedAt ? ` · last ${formatRelativeTime(iso(c.lastUsedAt))}` : ""}`) : none("No tax configuration by you in this org yet."))}
          {section("Countries with Configured Tax Rates", "in this org", ranked.configured.length ? chips(ranked.configured, c => `${c.count} Tax Rate${c.count === 1 ? "" : "s"}`) : none(ranked.recent.length || ranked.frequent.length ? "Already shown above." : "No Tax Rates with a Geo Country in this org."))}
          {section("Recently Used Tax Rates", "yours, newest first", (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {myRates.slice(0, 5).map(r => (
                <button key={r.id} type="button" onClick={() => onLaunch({ module: "tax-rates", view: "detail", id: r.id })} title="Open the Salesforce Tax Rate"
                  style={{ textAlign: "left", display: "grid", gridTemplateColumns: "1fr auto", gap: 6, padding: "5px 8px", borderRadius: 8, border: `1px solid ${t.border}`, background: "transparent", cursor: "pointer", color: t.body, fontSize: 11.5 }}>
                  <span><b style={{ color: t.heading }}>{r.name}</b> · <code style={{ color: t.accent }}>{r.taxCode ?? "—"}</code> · {[r.stateName, r.countryName].filter(Boolean).join(", ") || "No Geo Country"}{categoryOf(r.taxCode, r.countryIso) ? ` · ${categoryOf(r.taxCode, r.countryIso)}` : ""}</span>
                  <span style={{ whiteSpace: "nowrap" }}><b style={{ color: t.heading }}>{r.rate === null ? "—" : `${r.rate}%`}</b> <span style={{ color: t.dim }}>{formatRelativeTime(r.lastModifiedDate)}</span></span>
                </button>
              ))}
              {libraryRates.map(r => (
                <button key={r.key} type="button" onClick={() => openCountry(r.countryCode)} title="Open this country in the Tax Library"
                  style={{ textAlign: "left", display: "grid", gridTemplateColumns: "1fr auto", gap: 6, padding: "5px 8px", borderRadius: 8, border: `1px dashed ${t.border}`, background: "transparent", cursor: "pointer", color: t.body, fontSize: 11.5 }}>
                  <span><span style={{ color: t.dim }}>Library ·</span> <code style={{ color: t.accent }}>{r.taxCode}</code> · {[r.geoStateName, r.countryName].filter(Boolean).join(", ")}{r.taxCategory ? ` · ${r.taxCategory}` : ""}</span>
                  <span style={{ whiteSpace: "nowrap" }}><b style={{ color: t.heading }}>{r.ratePercent === null ? "—" : `${r.ratePercent}%`}</b> <span style={{ color: t.dim }}>{formatRelativeTime(iso(r.at))}</span></span>
                </button>
              ))}
              {!myRates.length && !libraryRates.length && none("Tax Rates you create or start from the library appear here.")}
            </div>
          ))}
        </div>
      )}
      {!empty && ranked.recent.length + ranked.frequent.length + ranked.configured.length < 3 && ranked.suggested.length > 0 && (
        section("Countries with Official Tax Data", "quick start", chips(ranked.suggested.slice(0, 4), c => `${c.count} source-backed rate${c.count === 1 ? "" : "s"}`))
      )}
    </div>
  );
}
