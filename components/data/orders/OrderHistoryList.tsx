"use client";

import { useEffect, useMemo, useState } from "react";
import { Ic, tokens, inputStyle, formatCurrency, PageShell, EmptyState, Spinner, ErrorPanel, CodeBlock, GhostButton } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { OrderListItem } from "@/lib/orders/types";

interface OrderHistoryResponse {
  orders: OrderListItem[];
  soql: string;
  relationshipNames: { account: string | null; pricebook: string | null; contract: string | null };
}

export default function OrderHistoryList({ isDark, onOpen }: { isDark: boolean; onOpen: (id: string) => void }) {
  const t = tokens(isDark);
  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const [soql, setSoql] = useState<string | null>(null);
  const [relationshipNames, setRelationshipNames] = useState<OrderHistoryResponse["relationshipNames"] | null>(null);
  const [showSoql, setShowSoql] = useState(false);

  useEffect(() => {
    quoteApiGet<OrderHistoryResponse>("List orders", "/api/orders")
      .then(res => {
        setOrders(res.orders);
        setSoql(res.soql);
        setRelationshipNames(res.relationshipNames);
      })
      .catch(err => setError(toErrorPanelData(err, "Could not load order history")))
      .finally(() => setLoading(false));
  }, []);

  const statuses = useMemo(() => ["All", ...new Set(orders.map(o => o.status).filter((s): s is string => !!s))], [orders]);
  const filtered = orders.filter(o =>
    (status === "All" || o.status === status) &&
    (search.trim() === "" || (o.orderNumber ?? "").toLowerCase().includes(search.toLowerCase()) || (o.accountName ?? "").toLowerCase().includes(search.toLowerCase())),
  );

  const header = (
    <div style={{ padding: "16px 20px 0", flexShrink: 0, display: "flex", gap: 8 }}>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search orders…" style={{ ...inputStyle(t), flex: 1 }} />
      <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...inputStyle(t), width: 160 }}>
        {statuses.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ padding: 20 }}>
        {loading && <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}><Spinner isDark={isDark} /> Loading orders…</div>}
        {error && <ErrorPanel isDark={isDark} error={error} />}

        {soql && (
          <div style={{ marginBottom: 12 }}>
            <GhostButton label={showSoql ? "Hide generated SOQL" : "View generated SOQL"} icon="terminal" isDark={isDark} onClick={() => setShowSoql(v => !v)} />
            {showSoql && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}`, fontSize: 11.5, color: t.body, overflowX: "auto" }}>{soql}</pre>
                {relationshipNames && (
                  <div style={{ fontSize: 11, color: t.dim }}>
                    Relationship names resolved from Describe — Account: <code>{relationshipNames.account ?? "none"}</code>, Price Book: <code>{relationshipNames.pricebook ?? "none"}</code>, Contract: <code>{relationshipNames.contract ?? "none"}</code>.
                    {" "}Never a guessed/stripped field name.
                  </div>
                )}
                <CodeBlock isDark={isDark} data={{ soql, relationshipNames }} />
              </div>
            )}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <EmptyState isDark={isDark} icon="shopping-cart" title="No orders found" hint={orders.length === 0 ? "Click Create Order to author your first one." : "Try a different search term or status filter."} />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(o => (
            <button
              key={o.id}
              onClick={() => onOpen(o.id)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", gap: 10,
                borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface, cursor: "pointer", textAlign: "left",
                transition: "border-color .15s ease, transform .15s ease",
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = t.borderBright)}
              onMouseLeave={e => (e.currentTarget.style.borderColor = t.border)}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 700, color: t.heading }}>
                  <Ic n="shopping-cart" s={14} /> {o.orderNumber ?? o.id}
                  {o.status && <span style={{ fontSize: 11, fontWeight: 600, color: t.accent, border: `1px solid ${t.accent}40`, borderRadius: 6, padding: "1px 7px" }}>{o.status}</span>}
                </div>
                <div style={{ fontSize: 11.5, color: t.dim, marginTop: 2 }}>
                  {o.accountName ?? "No account"} {o.lineItemCount != null ? `· ${o.lineItemCount} line item(s)` : ""}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: t.heading }}>{o.totalAmount != null ? formatCurrency(o.totalAmount) : "—"}</div>
                <div style={{ fontSize: 10.5, color: t.dim }}>{new Date(o.lastModifiedDate).toLocaleDateString()}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </PageShell>
  );
}
