"use client";

import { useEffect, useMemo, useState } from "react";
import { tokens, inputStyle, PageShell, EmptyState, Spinner, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { BundleListItem } from "@/app/api/bundles/list/route";

interface ComponentRow {
  productId: string;
  productName: string;
  bundleId: string;
  bundleName: string;
  isBundle: boolean;
  price: number;
  isRequired: boolean;
}

/**
 * Bundle Components — a flat, searchable view of every product that
 * participates in ANY bundle, and which bundle(s) it belongs to. Reads
 * the same /api/bundles/list data Bundle History uses; no separate query.
 */
export default function BundleComponentsView({ isDark, onOpenBundle, onBack }: { isDark: boolean; onOpenBundle: (id: string) => void; onBack: () => void }) {
  const t = tokens(isDark);
  const [bundles, setBundles] = useState<BundleListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    quoteApiGet<{ success: true; bundles: BundleListItem[] }>("List bundles", "/api/bundles/list")
      .then(res => setBundles(res.bundles))
      .catch(err => setError(toErrorPanelData(err, "Could not load bundle components")))
      .finally(() => setLoading(false));
  }, []);

  const rows: ComponentRow[] = useMemo(() => {
    const out: ComponentRow[] = [];
    for (const b of bundles) {
      for (const c of b.children) {
        out.push({ productId: c.id, productName: c.name, bundleId: b.id, bundleName: b.name, isBundle: c.isBundle, price: c.price, isRequired: c.isRequired });
      }
    }
    return out;
  }, [bundles]);

  const filtered = rows.filter(r => {
    const s = search.trim().toLowerCase();
    return !s || r.productName.toLowerCase().includes(s) || r.bundleName.toLowerCase().includes(s);
  });

  const header = (
    <div style={{ padding: "16px 20px 0", flexShrink: 0 }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Bundle Components</h2>
          <p style={{ fontSize: 12, color: t.dim, marginTop: 4 }}>Every product participating in a bundle, and which bundle(s) it belongs to.</p>
        </div>
        <GhostButton label="Back" icon="arrow-left" isDark={isDark} onClick={onBack} />
      </div>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by product or bundle name…" style={{ ...inputStyle(t), width: "100%", marginTop: 12, marginBottom: 10 }} />
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ padding: "0 20px 20px" }}>
        {loading && <div className="flex items-center gap-2" style={{ fontSize: 12.5, color: t.dim, padding: "20px 0" }}><Spinner isDark={isDark} /> Loading components…</div>}
        {error && <ErrorPanel isDark={isDark} error={error} />}
        {!loading && !error && filtered.length === 0 && <EmptyState isDark={isDark} icon="package" title="No components found" hint="Bundles with products will show their components here." />}
        {!loading && filtered.length > 0 && (
          <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1.6fr 0.8fr 0.8fr 0.8fr", padding: "9px 14px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
              <span>Product</span><span>Bundle</span><span>Type</span><span>Price</span><span>Status</span>
            </div>
            {filtered.map((r, i) => (
              <div key={`${r.bundleId}-${r.productId}`} style={{ display: "grid", gridTemplateColumns: "1.6fr 1.6fr 0.8fr 0.8fr 0.8fr", padding: "9px 14px", borderTop: i > 0 ? `1px solid ${t.border}` : undefined, fontSize: 12, color: t.body, alignItems: "center" }}>
                <span style={{ fontWeight: 600, color: t.heading }}>{r.productName}</span>
                <button onClick={() => onOpenBundle(r.bundleId)} style={{ color: t.accent, background: "transparent", border: "none", cursor: "pointer", textAlign: "left", padding: 0 }}>{r.bundleName}</button>
                <span>{r.isBundle ? "Nested Bundle" : "Standard"}</span>
                <span style={{ fontFamily: "ui-monospace, monospace" }}>{r.price ? `$${r.price.toLocaleString()}` : "—"}</span>
                <span style={{ color: r.isRequired ? t.accentBlue : t.dim, fontWeight: 600 }}>{r.isRequired ? "Required" : "Optional"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
