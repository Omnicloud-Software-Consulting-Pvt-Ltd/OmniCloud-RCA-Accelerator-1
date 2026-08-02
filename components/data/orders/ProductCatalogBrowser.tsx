"use client";

import { useEffect, useMemo, useState } from "react";
import { Ic, tokens, inputStyle, formatCurrency, Spinner } from "@/components/data/quotes/shared";
import { quoteApiPost } from "@/lib/quotes/client/apiClient";
import type { CatalogProduct } from "@/lib/quotes/types";

const ADDED_GREEN = "#22C55E";

/** Order-side product catalog browser — identical UI/behavior to the Quote module's
 * ProductCatalogBrowser (same shared design system, same "Added" state handling),
 * pointed at the Order product-search endpoint. The underlying search service
 * (lib/quotes/catalog/search.ts) is reused verbatim; only this thin routing wrapper
 * differs, per the module's per-area route convention. */
export interface CatalogAddedInfo {
  quantity: number;
  editable: boolean;
  onIncrement?: () => void;
  onDecrement?: () => void;
}

export default function ProductCatalogBrowser({ isDark, pricebookId, onAdd, disabled, addedProducts, pendingProductIds }: {
  isDark: boolean; pricebookId: string; onAdd: (product: CatalogProduct) => void; disabled?: boolean;
  addedProducts?: Map<string, CatalogAddedInfo>;
  /** Products whose /products/configure call is still in flight — rendered as a transient "Adding…" state so a second click can't fire a duplicate request while the first is still resolving. */
  pendingProductIds?: Set<string>;
}) {
  const t = tokens(isDark);
  const [term, setTerm] = useState("");
  const [family, setFamily] = useState("All");
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await quoteApiPost<{ products: CatalogProduct[] }>("Search catalog", "/api/orders/products/search", { pricebookId, searchTerm: term });
        setProducts(res.products);
      } catch {
        setProducts([]);
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [term, pricebookId]);

  const families = useMemo(() => ["All", ...new Set(products.map(p => p.family).filter((f): f is string => !!f))], [products]);
  const filtered = family === "All" ? products : products.filter(p => p.family === family);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ position: "relative", flex: 1 }}>
          <span style={{ position: "absolute", left: 10, top: 10, color: t.dim }}><Ic n="search" s={14} /></span>
          <input
            value={term}
            onChange={e => setTerm(e.target.value)}
            placeholder="Search products…"
            style={{ ...inputStyle(t), paddingLeft: 30 }}
          />
        </div>
        <select value={family} onChange={e => setFamily(e.target.value)} style={{ ...inputStyle(t), width: 160 }}>
          {families.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
        {loading && <div style={{ fontSize: 12.5, color: t.dim, padding: 8 }}>Searching…</div>}
        {!loading && filtered.length === 0 && <div style={{ fontSize: 12.5, color: t.dim, padding: 8 }}>No products found.</div>}
        {filtered.map(p => {
          const added = addedProducts?.get(p.id);
          const isPending = !!pendingProductIds?.has(p.id);
          return (
            <div key={p.id} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", gap: 10,
              borderRadius: 10,
              border: added ? `1px solid ${ADDED_GREEN}55` : `1px solid ${t.border}`,
              background: added ? (isDark ? `${ADDED_GREEN}0f` : `${ADDED_GREEN}0a`) : t.surfaceAlt,
              transition: "background 0.25s ease, border-color 0.25s ease",
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: t.heading }}>
                  <Ic n={p.isBundleCandidate ? "layers" : "cube"} s={13} />
                  {p.name}
                  {added && <span style={{ color: ADDED_GREEN, display: "inline-flex" }}><Ic n="check-circle" s={13} /></span>}
                </div>
                <div style={{ fontSize: 11.5, color: t.dim }}>
                  {p.productCode ? `${p.productCode} · ` : ""}{p.family ?? "Uncategorized"} · {formatCurrency(p.listPrice)}
                </div>
              </div>

              {isPending ? (
                // Transient "Adding…" state between the optimistic insert and
                // the /products/configure response resolving — disabled so a
                // repeated click can't fire a second, duplicate configure
                // request while the first is still in flight.
                <button
                  disabled
                  style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 8, border: `1px solid ${t.border}`,
                    cursor: "not-allowed", fontSize: 12, fontWeight: 700, color: t.dim, flexShrink: 0, background: "transparent",
                  }}
                >
                  <Spinner isDark={isDark} size={12} /> Adding…
                </button>
              ) : !added ? (
                <button
                  onClick={() => onAdd(p)}
                  disabled={disabled}
                  style={{
                    display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", borderRadius: 8, border: "none",
                    cursor: disabled ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700, color: "#04101F", flexShrink: 0,
                    background: `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})`, opacity: disabled ? 0.5 : 1,
                    transition: "opacity 0.25s ease",
                  }}
                >
                  <Ic n="plus" s={13} /> Add
                </button>
              ) : added.editable ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <span
                    title="This product has already been added."
                    style={{
                      display: "flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 8,
                      fontSize: 11.5, fontWeight: 700, color: ADDED_GREEN,
                      background: `${ADDED_GREEN}18`, border: `1px solid ${ADDED_GREEN}40`,
                    }}
                  >
                    <Ic n="check-circle" s={12} /> Added
                  </span>
                  <button
                    onClick={added.onDecrement}
                    title="Decrease quantity"
                    style={{ width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, border: `1px solid ${t.border}`, background: "transparent", color: t.body, cursor: "pointer", fontSize: 13, fontWeight: 700 }}
                  >
                    −
                  </button>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: t.heading, minWidth: 16, textAlign: "center" }}>{added.quantity}</span>
                  <button
                    onClick={added.onIncrement}
                    title="Increase quantity"
                    style={{ width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, border: `1px solid ${t.border}`, background: "transparent", color: t.body, cursor: "pointer", fontSize: 13, fontWeight: 700 }}
                  >
                    +
                  </button>
                </div>
              ) : (
                <button
                  disabled
                  title="This product has already been added."
                  style={{
                    display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", borderRadius: 8,
                    border: `1px solid ${ADDED_GREEN}40`, cursor: "not-allowed", fontSize: 12, fontWeight: 700,
                    color: ADDED_GREEN, background: `${ADDED_GREEN}18`, flexShrink: 0,
                  }}
                >
                  <Ic n="check-circle" s={13} /> Added
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: t.dim }}>
        Search results only include Active products with an Active PricebookEntry in this price book.
      </div>
    </div>
  );
}
