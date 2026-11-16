"use client";

import { useMemo, useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, GhostButton, EmptyState, Spinner } from "@/components/data/quotes/shared";
import SearchableSelect, { type SelectOption } from "@/components/data/taxes/library/SearchableSelect";
import { classificationLabel } from "@/lib/taxLibrary/library";
import { GEO_STATUS_LABEL, geoStatusOf, indexOrgGeo, missingGeo, type GeoStatus, type OrgGeo } from "@/lib/taxLibrary/geoSync";
import { PRIORITY_TIER_LABEL, type CountryPriority } from "@/lib/taxLibrary/usage";
import { MAPPING_PAGE_SIZES, MAPPING_STATUS_LABEL, mappingFacets, queryMapping, type MappingQuery, type MappingRow, type MappingStatus, type MappingTotals } from "@/lib/taxLibrary/mapping";

type SortBy = NonNullable<MappingQuery["sort"]>["by"];

const STATUS_COLOR: Record<MappingStatus, string> = {
  "state-rate": "#00C875", "inherited-national": "#3B82F6", national: "#00C875", "region-specific": "#F59E0B",
  "no-rate-configured": "#94A3B8", "unavailable-in-source": "#F59E0B", "no-consumption-tax": "#94A3B8",
};
const GEO_COLOR: Record<GeoStatus, string> = { available: "#00C875", "country-missing": "#F59E0B", "state-missing": "#F59E0B" };

/**
 * COUNTRY → GEO STATE → TAX RATE MAPPING — one row per actual mapping and one row for every Geo State without a rate (never hidden).
 * The mapping is computed once by the parent (lib/taxLibrary/mapping.ts); this view only filters / sorts / pages it in memory.
 * Salesforce geography (the connected org's GeoCountry / GeoState records, read once by the parent) is matched by ISO code per row:
 * a missing Geo Country / Geo State gets a Create action (parent first, created automatically after confirmation), and "Create Tax Rate"
 * on a row with missing geography first offers to create it, then opens the form with the real Ids — the Tax Rate form never gets a
 * missing or invented Geo Id.
 */
export default function TaxMappingView({ isDark, rows, totals, countryCode, countryOptions, orgGeo, priority, onCountry, onCreate, onCreateGeo, onRetryGeo, creatingKey }: {
  isDark: boolean;
  rows: MappingRow[];
  totals: MappingTotals;
  countryCode: string | null;
  countryOptions: SelectOption[];
  /** The connected org's Geo records: "loading", the result, or null when not requested. */
  orgGeo: OrgGeo | "loading" | null;
  /** Default country order (usage.ts countryPriority) — applied when no column sort is chosen; sorting only, nothing is hidden. */
  priority?: Map<string, CountryPriority> | null;
  onCountry: (cc: string | null) => void;
  /** Opens the existing Salesforce Tax Rate create form, prefilled — nothing is created until the user confirms there. */
  onCreate: (row: MappingRow) => void;
  /** Opens the existing Geo Country / Geo State create form for this row (after a fresh existence check). */
  onCreateGeo: (kind: "country" | "state", row: MappingRow) => void;
  onRetryGeo: () => void;
  creatingKey: string | null;
}) {
  const t = tokens(isDark);
  const [q, setQuery] = useState<MappingQuery>({ page: 1, pageSize: 50 });
  const [geoFilter, setGeoFilter] = useState<GeoStatus | "">("");
  const setQ = (p: Partial<MappingQuery>) => setQuery(x => ({ ...x, ...p, page: p.page ?? 1 }));
  const geo = orgGeo && orgGeo !== "loading" && orgGeo.success ? orgGeo : null;
  const idx = useMemo(() => (geo ? indexOrgGeo(geo) : null), [geo]);
  // The Salesforce geography filter narrows the row set before paging (so pagination never omits matching rows).
  const scoped = useMemo(() => (geoFilter && idx ? rows.filter(r => geoStatusOf(r, idx).status === geoFilter) : rows), [rows, geoFilter, idx]);
  const countryRank = useMemo(() => (priority ? new Map([...priority].map(([cc, p]) => [cc, p.rank])) : undefined), [priority]);
  const query = useMemo(() => ({ ...q, countryCode, countryRank }), [q, countryCode, countryRank]);
  const defaultOrder = !countryCode && !q.sort && !!priority;
  const res = useMemo(() => queryMapping(scoped, query), [scoped, query]);
  const f = useMemo(() => mappingFacets(rows, countryCode), [rows, countryCode]);
  const country = useMemo(() => (countryCode ? queryMapping(rows, { countryCode, pageSize: 1 }) : null), [rows, countryCode]);
  const countryRows = useMemo(() => (countryCode ? rows.filter(r => r.countryCode === countryCode) : []), [rows, countryCode]);
  const missing = useMemo(() => (idx ? missingGeo(countryCode ? countryRows : rows, idx) : null), [idx, countryCode, countryRows, rows]);
  const orgCountry = countryCode && idx ? idx.countryByIso.get(countryCode) ?? null : null;
  const unmatchedOrgStates = useMemo(() => {
    if (!idx || !orgCountry) return [];
    const isoCodes = new Set(countryRows.filter(r => r.geoStateCode).map(r => r.geoStateCode!.split("-").slice(1).join("-").toUpperCase()));
    return (idx.statesByCountryId.get(orgCountry.id) ?? []).filter(s => !s.isoCode || !isoCodes.has(s.isoCode.toUpperCase()));
  }, [idx, orgCountry, countryRows]);

  const sortBy = (by: SortBy) => setQuery(x => ({ ...x, sort: { by, dir: x.sort?.by === by && x.sort.dir === "asc" ? "desc" : "asc" } }));
  const th = (label: string, by?: SortBy) => (
    <th style={{ padding: 8, whiteSpace: "nowrap", cursor: by ? "pointer" : undefined }} onClick={by ? () => sortBy(by) : undefined} aria-sort={by && q.sort?.by === by ? (q.sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      {label}{by && q.sort?.by === by ? (q.sort.dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
  const sel = (label: string, value: string, opts: { v: string; l: string }[], on: (v: string) => void, disabled = false) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 160, flex: "1 1 160px" }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</span>
      <select value={value} disabled={disabled} onChange={e => on(e.target.value)} style={inputStyle(t)} aria-label={label}><option value="">All</option>{opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
    </label>
  );
  const stat = (label: string, value: number | string, tone?: string) => (
    <div style={{ display: "flex", flexDirection: "column", padding: "6px 12px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, minWidth: 120 }}>
      <span style={{ fontSize: 10.5, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3, fontWeight: 700 }}>{label}</span>
      <b style={{ fontSize: 16, color: tone ?? t.heading }}>{typeof value === "number" ? value.toLocaleString() : value}</b>
    </div>
  );
  const btn = (label: string, icon: string, onClick: () => void, opts: { busy?: boolean; tone?: string; title?: string } = {}) => (
    <button type="button" onClick={onClick} disabled={opts.busy} title={opts.title}
      style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 11.5, fontWeight: 700, padding: "4px 9px", borderRadius: 8, cursor: "pointer", border: `1px solid ${opts.tone ?? t.accent}`, color: opts.tone ?? t.accent, background: `${opts.tone ?? t.accent}12`, whiteSpace: "nowrap" }}>
      {opts.busy ? <Spinner isDark={isDark} size={11} /> : <Ic n={icon} s={11} />} {label}
    </button>
  );
  const cell = { padding: "7px 8px", verticalAlign: "top" as const };
  const geoLoading = orgGeo === "loading";
  const geoFailed = orgGeo && orgGeo !== "loading" && !orgGeo.success;

  return (
    <div data-testid="tax-mapping" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Totals */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {countryCode && country ? <>
          {stat("Geo States", country.geoStates)}
          {stat("Tax mappings", country.mappings)}
          {stat("States without a rate", countryRows.filter(r => r.scope === "state" && !r.record).length)}
          {stat("Salesforce Geo Country", geoLoading ? "…" : !idx ? "—" : orgCountry ? "Available" : "Missing", idx ? (orgCountry ? "#00C875" : "#F59E0B") : undefined)}
          {stat("Geo States missing in Salesforce", geoLoading ? "…" : missing ? missing.states + missing.statesWithoutCountry : "—", missing && missing.states + missing.statesWithoutCountry ? "#F59E0B" : undefined)}
        </> : <>
          {stat("Countries", totals.countries)}
          {stat("Countries with rates", totals.countriesWithRates)}
          {stat("Geo States", totals.geoStates)}
          {stat("Geo States with a rate", totals.geoStatesWithRates)}
          {stat("Tax mappings", totals.taxMappings)}
          {stat("Salesforce Geo Countries", geoLoading ? "…" : geo ? geo.countries.length : "—")}
        </>}
      </div>

      {/* Filters */}
      <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", background: t.surface }}>
        <SearchableSelect isDark={isDark} label="Country" value={countryCode ?? ""} allLabel="All countries" placeholder="Search countries…" options={countryOptions} onChange={v => onCountry(v || null)} emptyText="No country matches." />
        {!countryCode && (
          <label style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 180, flex: "1 1 180px" }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>Country search</span>
            <input value={q.countryQ ?? ""} onChange={e => setQ({ countryQ: e.target.value })} placeholder="Name or ISO code…" aria-label="Country search" style={inputStyle(t)} />
          </label>
        )}
        <label style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 180, flex: "1 1 180px" }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>Geo State search</span>
          <input value={q.stateQ ?? ""} onChange={e => setQ({ stateQ: e.target.value })} placeholder="Name or ISO 3166-2 code…" aria-label="Geo State search" style={inputStyle(t)} />
        </label>
        {sel("Tax code", q.taxCode ?? "", f.taxCodes.map(v => ({ v, l: v })), v => setQ({ taxCode: v || null }))}
        {sel("Tax category", q.taxCategory ?? "", f.taxCategories.map(v => ({ v, l: v })), v => setQ({ taxCategory: v || null }))}
        {sel("Mapping status", q.status ?? "", (Object.keys(MAPPING_STATUS_LABEL) as MappingStatus[]).map(v => ({ v, l: MAPPING_STATUS_LABEL[v] })), v => setQ({ status: (v || null) as MappingStatus | null }))}
        {sel("Salesforce geography", geoFilter, (Object.keys(GEO_STATUS_LABEL) as GeoStatus[]).map(v => ({ v, l: GEO_STATUS_LABEL[v] })), v => { setGeoFilter(v as GeoStatus | ""); setQ({}); }, !idx)}
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: t.body, paddingBottom: 8 }}>
          <input type="checkbox" checked={!!q.statesOnly} onChange={e => setQ({ statesOnly: e.target.checked })} /> Geo States only
        </label>
        <GhostButton label="Clear" icon="x" isDark={isDark} onClick={() => { setGeoFilter(""); setQuery({ page: 1, pageSize: q.pageSize, sort: q.sort }); }} />
      </div>

      {/* Salesforce geography (connected org) */}
      <div style={{ fontSize: 12, color: t.body, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: t.dim }}>Salesforce geography (connected org):</span>
        {geoLoading ? <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Spinner isDark={isDark} size={12} /> Reading Geo Country / Geo State records…</span>
          : geoFailed ? <span style={{ color: t.warn }}>Couldn&apos;t read Geo records: {(orgGeo as OrgGeo).error ?? "unknown error"} — the tax mapping is unaffected; Geo and Tax Rate actions are disabled until it&apos;s read. <button type="button" onClick={onRetryGeo} style={{ background: "none", border: "none", color: t.accent, cursor: "pointer", fontWeight: 700 }}>Retry</button></span>
          : !geo ? <span style={{ color: t.dim }}>—</span>
          : <span>{geo.countries.length} Geo Countr{geo.countries.length === 1 ? "y" : "ies"} · {geo.states.length} Geo State{geo.states.length === 1 ? "" : "s"} in this org · matched by ISO code
            {missing && <> · <b style={{ color: missing.countries || missing.states ? t.warn : "#00C875" }}>{countryCode ? (orgCountry ? `${missing.states} Geo State${missing.states === 1 ? "" : "s"} missing` : `Geo Country ${countryCode} missing (${missing.statesWithoutCountry} state${missing.statesWithoutCountry === 1 ? "" : "s"} wait for it)`) : `${missing.countries} countries and ${missing.states} Geo States missing`}</b></>}
            {unmatchedOrgStates.length > 0 && <span style={{ color: t.warn }}> · {unmatchedOrgStates.length} org Geo State{unmatchedOrgStates.length === 1 ? "" : "s"} not matching an ISO 3166-2 code ({unmatchedOrgStates.slice(0, 5).map(s => `${s.name}${s.isoCode ? ` [${s.isoCode}]` : ""}`).join(", ")}{unmatchedOrgStates.length > 5 ? "…" : ""}) — no library mapping</span>}
            {geo.available.createGeoCountry === false && <span style={{ color: t.warn }}> · your Salesforce user can&apos;t create Geo Countries</span>}
            {geo.available.createGeoState === false && <span style={{ color: t.warn }}> · your Salesforce user can&apos;t create Geo States</span>}</span>}
      </div>

      {defaultOrder && <div style={{ fontSize: 11.5, color: t.dim }}>Default order: countries you used recently, where you created Tax Rates or Geo records, then frequently used, then Tax Rates in this org and official tax data — all {totals.countries} countries stay below. Click a column header to sort differently.</div>}

      {/* Table */}
      {res.total === 0 ? (
        <EmptyState isDark={isDark} icon="search" title="No mappings match these filters" hint="Clear or change the filters — every Geo State has at least one row, so a country selection alone never returns nothing." />
      ) : (
        <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, overflow: "hidden", background: t.surface }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 1380 }}>
              <thead style={{ background: t.surfaceAlt }}>
                <tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>
                  {th("Country", "country")}{th("Code")}{th("Geo Country")}{th("Geo State", "state")}{th("Geo State Code")}{th("Tax Code", "taxCode")}{th("Tax Type")}{th("Tax Category", "taxCategory")}{th("Tax Rate (%)", "rate")}{th("Tax Source / Data Status")}{th("Mapping Status", "status")}{th("Salesforce Geography")}{th("Actions")}
                </tr>
              </thead>
              <tbody>
                {res.rows.map(r => {
                  const g = idx ? geoStatusOf(r, idx) : null;
                  const applies = r.record ? classificationLabel(r.record) ?? r.record.tax.taxName : null;
                  return (
                    <tr key={r.key} data-status={r.status} data-geo={g?.status ?? "unknown"} style={{ borderTop: `1px solid ${t.border}` }}>
                      <td style={cell}><b style={{ color: t.heading }}>{r.countryName}</b>{defaultOrder && priority!.get(r.countryCode)!.tier <= 6 && <div data-testid="priority-tier" style={{ fontSize: 10.5, fontWeight: 700, color: priority!.get(r.countryCode)!.tier <= 3 ? t.accent : t.dim }}>{PRIORITY_TIER_LABEL[priority!.get(r.countryCode)!.tier]}</div>}</td>
                      <td style={{ ...cell, color: t.dim }}>{r.countryCode}</td>
                      <td style={cell}>{r.geoCountryName}</td>
                      <td style={cell}>{r.geoStateName ? (r.scope === "region" ? <span title={r.geoStateName}><span style={{ color: t.warn, fontWeight: 700 }}>Region</span><div style={{ fontSize: 11, color: t.dim }}>{r.geoStateName.slice(0, 48)}</div></span> : r.geoStateName) : <span style={{ color: t.dim, fontWeight: 600 }}>Country level</span>}</td>
                      <td style={{ ...cell, color: t.dim, whiteSpace: "nowrap" }}>{r.geoStateCode ?? "—"}</td>
                      <td style={{ ...cell, fontFamily: "ui-monospace, Menlo, Consolas, monospace", color: r.taxCode ? t.accent : t.dim }}>{r.taxCode ?? "—"}{applies && <div style={{ fontSize: 10.5, color: t.dim, fontFamily: "inherit" }} title={applies}>{applies.slice(0, 60)}</div>}</td>
                      <td style={cell}>{r.taxType ?? "—"}</td>
                      <td style={cell}>{r.taxCategory ?? "—"}</td>
                      <td style={{ ...cell, whiteSpace: "nowrap", fontWeight: r.record ? 700 : 500, color: r.record ? t.heading : t.dim, fontStyle: r.record ? undefined : "italic" }} data-rate-kind={r.rateKind}>{r.rateDisplay}</td>
                      <td style={{ ...cell, color: t.body, fontSize: 11.5 }}>{r.dataStatus}</td>
                      <td style={cell}>
                        <span style={{ fontWeight: 700, color: STATUS_COLOR[r.status] }}>{MAPPING_STATUS_LABEL[r.status]}</span>
                        {r.ratesForGeo > 1 && <div style={{ fontSize: 10.5, color: t.dim }}>Multiple applicable rates ({r.ratesForGeo})</div>}
                        {r.statusDetail && <div style={{ fontSize: 10.5, color: t.dim, maxWidth: 320 }}>{r.statusDetail}</div>}
                      </td>
                      <td style={{ ...cell, fontSize: 11.5, whiteSpace: "nowrap" }}>
                        {geoLoading ? <span style={{ color: t.dim }}>Checking…</span> : !g ? <span style={{ color: t.dim }}>Not checked</span>
                          : <><span style={{ fontWeight: 700, color: GEO_COLOR[g.status] }}>{g.status === "available" ? "✓ " : ""}{GEO_STATUS_LABEL[g.status]}</span>
                            {g.status === "available" && <div style={{ color: t.dim }}>{g.state ? `${g.state.name} · ${g.country!.name}` : g.country!.name}</div>}
                            {g.status === "country-missing" && r.scope === "state" && <div style={{ color: t.dim }}>Create the Geo Country first</div>}</>}
                      </td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {g?.status === "country-missing" && btn("Create Geo Country", "globe", () => onCreateGeo("country", r), { busy: creatingKey === `geo:${r.countryCode}`, tone: "#F59E0B", title: `Opens the Geo Country form prefilled with ${r.countryName} (${r.countryCode}) — nothing is created until you validate and confirm.` })}
                          {g?.status === "state-missing" && btn("Create Geo State", "map-pin", () => onCreateGeo("state", r), { busy: creatingKey === `geo:${r.geoStateCode}`, tone: "#F59E0B", title: `Opens the Geo State form prefilled with ${r.geoStateName} under ${g.country?.name} — nothing is created until you validate and confirm.` })}
                          {r.record && g && btn("Create Tax Rate", "plus", () => onCreate(r), { busy: creatingKey === r.key, title: g.status === "available" ? "Opens the Salesforce Tax Rate form prefilled from this mapping with the org's real Geo Country / Geo State Ids — nothing is created until you confirm there." : "The geography is missing in Salesforce: you'll be asked to create it automatically first, then the Tax Rate form opens with the real Ids." })}
                          {!r.record && g?.status === "available" && <span style={{ fontSize: 11, color: t.dim, alignSelf: "center" }}>Available in Salesforce</span>}
                          {!g && <span style={{ color: t.dim, fontSize: 11 }}>—</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 12px", borderTop: `1px solid ${t.border}`, fontSize: 12, color: t.dim, flexWrap: "wrap" }}>
            <span data-testid="mapping-page-summary">Showing {res.from}–{res.to} of {res.total.toLocaleString()} row{res.total === 1 ? "" : "s"} · {res.geoStates.toLocaleString()} Geo State{res.geoStates === 1 ? "" : "s"} · {res.mappings.toLocaleString()} tax mapping{res.mappings === 1 ? "" : "s"} · page {res.page} of {res.pageCount}</span>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <select value={q.pageSize ?? 50} onChange={e => setQ({ pageSize: Number(e.target.value) })} aria-label="Rows per page" style={{ ...inputStyle(t), width: 100, padding: "5px 8px" }}>{MAPPING_PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}</select>
              <GhostButton label="First" icon="chevron-left" isDark={isDark} disabled={res.page <= 1} onClick={() => setQuery(x => ({ ...x, page: 1 }))} />
              <GhostButton label="Previous" icon="chevron-left" isDark={isDark} disabled={res.page <= 1} onClick={() => setQuery(x => ({ ...x, page: res.page - 1 }))} />
              <GhostButton label="Next" icon="chevron-right" isDark={isDark} disabled={res.page >= res.pageCount} onClick={() => setQuery(x => ({ ...x, page: res.page + 1 }))} />
              <GhostButton label="Last" icon="chevron-right" isDark={isDark} disabled={res.page >= res.pageCount} onClick={() => setQuery(x => ({ ...x, page: res.pageCount }))} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
