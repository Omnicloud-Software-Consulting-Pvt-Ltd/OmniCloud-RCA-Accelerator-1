"use client";

import { useMemo, useState } from "react";
import { tokens, inputStyle, GhostButton } from "@/components/data/quotes/shared";
import { Panel, StatTile } from "@/components/data/billing/billingUi";
import FieldHelp from "@/components/help/FieldHelp";
import { computeCoverage, EVALUATED_SOURCES, type CoverageLevel, type DatasetManifest } from "@/lib/taxLibrary/datasets";
import type { CountryProfile, LayerCoverage } from "@/lib/taxLibrary/reference";
import type { TaxRateReference } from "@/lib/taxLibrary/types";

const LEVEL_LABEL: Record<CoverageLevel, string> = { covered: "Covered (dataset scope)", partial: "Partial", missing: "No tax data" };
export const LAYER_LABEL: Record<LayerCoverage, string> = { none: "None (national tax only)", included: "Included", partial: "Partial", "not-included": "Missing", "not-assessed": "Not assessed" };

/**
 * Coverage of the library's TAX data per country — geography and tax data reported separately, and tax data broken into
 * dimensions (national standard / reduced / zero / exempt rates, components, classifications, subnational and local layers,
 * verification) so a country with national VAT but missing regional or local taxes is shown as exactly that. Read-only.
 */
export default function CoverageDashboard({ isDark, records, manifests, profiles, countries, subdivisions, subdivisionsTotal, countriesWithSubdivisions, onPickCountry, onClose }: {
  isDark: boolean;
  records: TaxRateReference[];
  manifests: DatasetManifest[];
  profiles: Map<string, CountryProfile>;
  countries: { code: string; name: string }[];
  /** ISO subdivision codes per country (geographic reference). */
  subdivisions: Map<string, string[]>;
  subdivisionsTotal: number;
  countriesWithSubdivisions: number;
  onPickCountry: (countryCode: string) => void;
  onClose: () => void;
}) {
  const t = tokens(isDark);
  const cov = useMemo(() => computeCoverage(records, countries.map(c => c.code), manifests, undefined, subdivisions), [records, countries, manifests, subdivisions]);
  const [level, setLevel] = useState<CoverageLevel | "">("");
  const [q, setQ] = useState("");
  const rows = useMemo(() => countries.map(c => ({ c, v: cov.byCountry.get(c.code)!, p: profiles.get(c.code) ?? null }))
    .filter(x => (!level || x.v.level === level) && (!q.trim() || `${x.c.name} ${x.c.code}`.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => b.v.records - a.v.records || a.c.name.localeCompare(b.c.name)), [countries, cov, profiles, level, q]);
  const levelColor: Record<CoverageLevel, string> = { covered: "#00C875", partial: t.warn, missing: t.dim };
  const yes = (b: boolean) => <span style={{ color: b ? "#00C875" : t.dim }}>{b ? "✓" : "—"}</span>;
  const section = (label: string) => <div style={{ fontSize: 10.5, fontWeight: 800, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>;
  const grid = { gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" };

  return (
    <Panel isDark={isDark} title="Tax Data Coverage" icon="pie-chart" right={<GhostButton label="Close" icon="x" isDark={isDark} onClick={onClose} />}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 12, color: t.body, display: "flex", gap: 6, alignItems: "flex-start" }}>
          <span>Geography and tax data are counted separately. Every ISO country and subdivision is listed; tax coverage comes only from source-backed rate records. A country with national VAT/GST can still be missing reduced rates, product classifications, or state and local taxes — each is shown as its own column.</span>
          <FieldHelp isDark={isDark} label="Coverage" entry={{ text: "\"Covered\" = a dataset declares the country complete for its stated scope (e.g. national VAT) — never every tax in the country, and never the same as verified. Verified = re-confirmed against the official source; Partially verified = official source + verbatim quote, automated re-check unavailable." }} />
        </div>
        {section("1 · Geographic reference (ISO 3166)")}
        <div className="grid gap-2" style={grid}>
          <StatTile isDark={isDark} label="Countries" value={String(countries.length)} />
          <StatTile isDark={isDark} label="States / provinces / territories" value={subdivisionsTotal.toLocaleString()} />
          <StatTile isDark={isDark} label="Countries with subdivisions" value={String(countriesWithSubdivisions)} />
          <StatTile isDark={isDark} label="Jurisdictions (countries + subdivisions)" value={(countries.length + subdivisionsTotal).toLocaleString()} />
        </div>
        {section("2 · Tax data")}
        <div className="grid gap-2" style={grid}>
          <StatTile isDark={isDark} label="Countries with tax data" value={String(cov.countriesWithRates)} color="#00C875" />
          <StatTile isDark={isDark} label="Countries with no tax data" value={String(cov.missing)} />
          <StatTile isDark={isDark} label="Countries with verified rates" value={String(cov.countriesWithVerified)} color="#00C875" />
          <StatTile isDark={isDark} label="Subdivisions with own rates" value={cov.subdivisionsWithOwnRates.toLocaleString()} />
          <StatTile isDark={isDark} label="Subdivisions with national rates only" value={cov.subdivisionsWithNationalOnly.toLocaleString()} />
          <StatTile isDark={isDark} label="Subdivisions with no applicable data" value={cov.subdivisionsWithoutData.toLocaleString()} color={t.warn} />
          <StatTile isDark={isDark} label="Rate records" value={cov.records.toLocaleString()} />
          <StatTile isDark={isDark} label="Verified" value={cov.verifiedRecords.toLocaleString()} color="#00C875" />
          <StatTile isDark={isDark} label="Partially verified" value={cov.partiallyVerifiedRecords.toLocaleString()} color={t.warn} />
          <StatTile isDark={isDark} label="Unverified" value={cov.unverifiedRecords.toLocaleString()} color={t.warn} />
          <StatTile isDark={isDark} label="Standard rates" value={String(cov.standardRates)} />
          <StatTile isDark={isDark} label="Reduced rates" value={String(cov.reducedRates)} />
          <StatTile isDark={isDark} label="Zero rates" value={String(cov.zeroRates)} />
          <StatTile isDark={isDark} label="Exempt classifications" value={String(cov.exemptRecords)} />
          <StatTile isDark={isDark} label="Tax components" value={String(cov.components)} />
          <StatTile isDark={isDark} label="Product / service classifications" value={cov.classifications.toLocaleString()} />
          <StatTile isDark={isDark} label="Historical records" value={String(cov.historical)} />
          <StatTile isDark={isDark} label="Last source verification" value={cov.lastVerified ?? "—"} />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a country…" aria-label="Find a country" style={{ ...inputStyle(t), maxWidth: 240 }} />
          <select value={level} onChange={e => setLevel(e.target.value as CoverageLevel | "")} aria-label="Coverage level" style={{ ...inputStyle(t), maxWidth: 220 }}>
            <option value="">All coverage levels</option><option value="covered">Covered (dataset scope)</option><option value="partial">Partial</option><option value="missing">No tax data</option>
          </select>
        </div>
        <div style={{ maxHeight: 360, overflowY: "auto", overflowX: "auto", border: `1px solid ${t.border}`, borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 1100 }}>
            <thead style={{ position: "sticky", top: 0, background: t.surfaceAlt }}><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>
              {["Country", "Coverage", "Rates", "Verified / partial / unverified", "Standard", "Reduced", "Zero", "Exempt", "Components", "State / provincial taxes", "Local taxes", "Missing scope"].map(h => <th key={h} style={{ padding: "6px 8px" }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map(({ c, v, p }) => (
                <tr key={c.code} style={{ borderTop: `1px solid ${t.border}`, cursor: "pointer" }} onClick={() => onPickCountry(c.code)} title="Show this country's tax information">
                  <td style={{ padding: "5px 8px", color: t.heading }}>{c.name} <span style={{ color: t.dim }}>{c.code}</span></td>
                  <td style={{ padding: "5px 8px", color: levelColor[v.level], fontWeight: 700 }}>{LEVEL_LABEL[v.level]}</td>
                  <td style={{ padding: "5px 8px" }}>{v.records}</td>
                  <td style={{ padding: "5px 8px" }}><span style={{ color: v.verified ? "#00C875" : t.dim }}>{v.verified}</span> / <span style={{ color: v.partiallyVerified ? t.warn : t.dim }}>{v.partiallyVerified}</span> / <span style={{ color: v.unverified ? t.warn : t.dim }}>{v.unverified}</span></td>
                  <td style={{ padding: "5px 8px" }}>{yes(v.hasStandard)}</td>
                  <td style={{ padding: "5px 8px" }}>{yes(v.hasReduced)}</td>
                  <td style={{ padding: "5px 8px" }}>{yes(v.hasZero)}</td>
                  <td style={{ padding: "5px 8px" }}>{yes(v.hasExempt)}</td>
                  <td style={{ padding: "5px 8px", color: t.dim }}>{v.components.join(", ") || "—"}</td>
                  <td style={{ padding: "5px 8px" }}>{p ? LAYER_LABEL[p.subnational] : "Not assessed"}</td>
                  <td style={{ padding: "5px 8px" }}>{p ? LAYER_LABEL[p.local] : "Not assessed"}</td>
                  <td style={{ padding: "5px 8px", color: t.dim, maxWidth: 280 }}>{p?.missingScope.join("; ") || (v.records ? "—" : "National consumption-tax rates")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {section("3 · Sources")}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {manifests.filter(m => m.recordCount > 0).map(m => (
            <div key={m.id} style={{ fontSize: 12, color: t.body }}><b style={{ color: t.heading }}>{m.name}</b> · version {m.version} · retrieved {m.retrievedAt} · {m.recordCount.toLocaleString()} records<div style={{ color: t.dim }}>{m.source} — {m.license}</div></div>
          ))}
          {EVALUATED_SOURCES.filter(s => s.status !== "bundled").map(s => (
            <div key={s.name} style={{ fontSize: 12, color: t.dim }}><a href={s.url} target="_blank" rel="noreferrer" style={{ color: t.accent }}>{s.name}</a> — not bundled: {s.access}. {s.license}.</div>
          ))}
        </div>
      </div>
    </Panel>
  );
}
