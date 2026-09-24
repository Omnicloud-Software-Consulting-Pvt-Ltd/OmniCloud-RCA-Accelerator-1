"use client";

import { useEffect, useMemo, useState } from "react";
import { Ic, tokens, inputStyle, PageShell, EmptyState, Spinner, ErrorPanel, GhostButton, type Tokens } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { ProductListItem } from "@/app/api/sf/products/route";

interface ProductHistoryResponse {
  products: ProductListItem[];
  soql: string;
}

/**
 * Product History (DataOmnion Products dashboard → Product History) —
 * browse products already created in Salesforce. Mirrors QuoteHistoryList's
 * search/filter/list pattern; rows expand in place to show every field
 * instead of routing into an editor, since RCProductWorkspace only supports
 * creating new products today.
 */
export default function ProductHistoryList({ isDark, onOpenImportHistory, onEditProduct, refreshToken }: {
  isDark: boolean;
  onOpenImportHistory?: () => void;
  /** Opens the product in the Edit workspace (reuses RCProductWorkspace — see app/data/page.tsx's "edit" mode). */
  onEditProduct?: (id: string) => void;
  /** Bump this after a successful edit save to force a re-fetch instead of showing stale cached values. */
  refreshToken?: number;
}) {
  const t = tokens(isDark);
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const [type, setType] = useState("All");
  const [family, setFamily] = useState("All");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [soql, setSoql] = useState<string | null>(null);
  const [showSoql, setShowSoql] = useState(false);

  useEffect(() => {
    // `loading` already defaults to true for the initial mount fetch; a refreshToken-triggered
    // re-fetch (after an edit save) intentionally does NOT flip it back to true — it just quietly
    // replaces the list once the new data arrives, instead of flashing the whole panel to a spinner.
    quoteApiGet<ProductHistoryResponse>("List products", "/api/sf/products")
      .then(res => {
        setProducts(res.products);
        setSoql(res.soql);
      })
      .catch(err => setError(toErrorPanelData(err, "Could not load product history")))
      .finally(() => setLoading(false));
  }, [refreshToken]);

  const types = useMemo(() => ["All", ...new Set(products.map(p => p.type).filter((v): v is string => !!v))], [products]);
  const families = useMemo(() => ["All", ...new Set(products.map(p => p.family).filter((v): v is string => !!v))], [products]);

  const filtered = products.filter(p =>
    (status === "All" || (status === "Active" ? p.isActive : !p.isActive)) &&
    (type === "All" || p.type === type) &&
    (family === "All" || p.family === family) &&
    (search.trim() === "" ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.productCode ?? "").toLowerCase().includes(search.toLowerCase())),
  );

  const header = (
    <div style={{ padding: "16px 20px 0", flexShrink: 0, display: "flex", gap: 8, flexWrap: "wrap" }}>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…" style={{ ...inputStyle(t), flex: 1, minWidth: 160 }} />
      <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...inputStyle(t), width: 130 }}>
        {["All", "Active", "Draft"].map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <select value={type} onChange={e => setType(e.target.value)} style={{ ...inputStyle(t), width: 140 }}>
        {types.map(s => <option key={s} value={s}>{s === "All" ? "All Types" : s}</option>)}
      </select>
      <select value={family} onChange={e => setFamily(e.target.value)} style={{ ...inputStyle(t), width: 160 }}>
        {families.map(s => <option key={s} value={s}>{s === "All" ? "All Families" : s}</option>)}
      </select>
      {onOpenImportHistory && <GhostButton label="Import History" icon="upload" isDark={isDark} onClick={onOpenImportHistory} />}
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ padding: 20 }}>
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}>
            <Spinner isDark={isDark} /> Loading products…
          </div>
        )}
        {error && <ErrorPanel isDark={isDark} error={error} />}

        {soql && (
          <div style={{ marginBottom: 12 }}>
            <GhostButton label={showSoql ? "Hide generated SOQL" : "View generated SOQL"} icon="terminal" isDark={isDark} onClick={() => setShowSoql(v => !v)} />
            {showSoql && (
              <pre style={{ marginTop: 8, padding: 10, borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}`, fontSize: 11.5, color: t.body, overflowX: "auto" }}>
                {soql}
              </pre>
            )}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <EmptyState
            isDark={isDark}
            icon="package"
            title="No products found"
            hint={products.length === 0 ? "Click Create Product to author your first one." : "Try a different search term or filter."}
          />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(p => {
            const expanded = expandedId === p.id;
            return (
              <div key={p.id} style={{ borderRadius: 12, border: `1px solid ${expanded ? t.borderBright : t.border}`, background: t.surface, overflow: "hidden" }}>
                <button
                  onClick={() => setExpandedId(expanded ? null : p.id)}
                  style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", gap: 10, background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 700, color: t.heading }}>
                      <Ic n="package" s={14} /> {p.name}
                      <span style={{ fontSize: 11, fontWeight: 600, color: p.isActive ? "#22C55E" : t.accent, border: `1px solid ${p.isActive ? "#22C55E" : t.accent}40`, borderRadius: 6, padding: "1px 7px" }}>
                        {p.isActive ? "Active" : "Draft"}
                      </span>
                    </div>
                    <div style={{ fontSize: 11.5, color: t.dim, marginTop: 2 }}>
                      {p.productCode ? `${p.productCode} · ` : ""}{p.type ?? "Standard"}{p.family ? ` · ${p.family}` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 11, color: t.dim }}>Modified</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: t.heading }}>{new Date(p.lastModifiedDate).toLocaleDateString()}</div>
                    </div>
                    <span style={{ color: t.dim }}><Ic n={expanded ? "chevron-down" : "chevron-right"} s={14} /></span>
                  </div>
                </button>
                {expanded && (
                  <div style={{ padding: "0 14px 14px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10, marginBottom: onEditProduct ? 12 : 0 }}>
                      <DetailField label="Product Code" value={p.productCode ?? "—"} t={t} />
                      <DetailField label="Type" value={p.type ?? "Standard"} t={t} />
                      <DetailField label="Family" value={p.family ?? "—"} t={t} />
                      <DetailField label="Created" value={new Date(p.createdDate).toLocaleDateString()} t={t} />
                      <DetailField label="Last Modified" value={new Date(p.lastModifiedDate).toLocaleDateString()} t={t} />
                    </div>
                    {onEditProduct && (
                      <GhostButton label="Edit Product" icon="edit" isDark={isDark} onClick={() => onEditProduct(p.id)} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </PageShell>
  );
}

function DetailField({ label, value, t }: { label: string; value: string; t: Tokens }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: t.heading, marginTop: 2 }}>{value}</div>
    </div>
  );
}
