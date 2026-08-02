"use client";

import { useEffect, useMemo, useState } from "react";
import { Ic, tokens, inputStyle, formatCurrency, PageShell, EmptyState, Spinner, ErrorPanel, CodeBlock, GhostButton } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { QuoteListItem } from "@/lib/quotes/types";

interface QuoteHistoryResponse {
  quotes: QuoteListItem[];
  soql: string;
  relationshipNames: { account: string | null; opportunity: string | null; pricebook: string | null };
}

export default function QuoteHistoryList({ isDark, onOpen }: { isDark: boolean; onOpen: (id: string) => void }) {
  const t = tokens(isDark);
  const [quotes, setQuotes] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const [soql, setSoql] = useState<string | null>(null);
  const [relationshipNames, setRelationshipNames] = useState<QuoteHistoryResponse["relationshipNames"] | null>(null);
  const [showSoql, setShowSoql] = useState(false);

  useEffect(() => {
    quoteApiGet<QuoteHistoryResponse>("List quotes", "/api/quotes")
      .then(res => {
        setQuotes(res.quotes);
        setSoql(res.soql);
        setRelationshipNames(res.relationshipNames);
      })
      .catch(err => setError(toErrorPanelData(err, "Could not load quote history")))
      .finally(() => setLoading(false));
  }, []);

  const statuses = useMemo(() => ["All", ...new Set(quotes.map(q => q.status).filter((s): s is string => !!s))], [quotes]);
  const filtered = quotes.filter(q =>
    (status === "All" || q.status === status) &&
    (search.trim() === "" || q.name.toLowerCase().includes(search.toLowerCase()) || (q.accountName ?? "").toLowerCase().includes(search.toLowerCase())),
  );

  const header = (
    <div style={{ padding: "16px 20px 0", flexShrink: 0, display: "flex", gap: 8 }}>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search quotes…" style={{ ...inputStyle(t), flex: 1 }} />
      <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...inputStyle(t), width: 160 }}>
        {statuses.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ padding: 20 }}>
        {loading && <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}><Spinner isDark={isDark} /> Loading quotes…</div>}
        {error && <ErrorPanel isDark={isDark} error={error} />}

        {soql && (
          <div style={{ marginBottom: 12 }}>
            <GhostButton label={showSoql ? "Hide generated SOQL" : "View generated SOQL"} icon="terminal" isDark={isDark} onClick={() => setShowSoql(v => !v)} />
            {showSoql && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}`, fontSize: 11.5, color: t.body, overflowX: "auto" }}>{soql}</pre>
                {relationshipNames && (
                  <div style={{ fontSize: 11, color: t.dim }}>
                    Relationship names resolved from Describe — Account: <code>{relationshipNames.account ?? "none"}</code>, Opportunity: <code>{relationshipNames.opportunity ?? "none"}</code>, Price Book: <code>{relationshipNames.pricebook ?? "none"}</code>.
                    {" "}Never a guessed/stripped field name.
                  </div>
                )}
                <CodeBlock isDark={isDark} data={{ soql, relationshipNames }} />
              </div>
            )}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <EmptyState isDark={isDark} icon="file-text" title="No quotes found" hint={quotes.length === 0 ? "Click Create Quote to author your first one." : "Try a different search term or status filter."} />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(q => (
            <button
              key={q.id}
              onClick={() => onOpen(q.id)}
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
                  <Ic n="file-text" s={14} /> {q.name}
                  {q.status && <span style={{ fontSize: 11, fontWeight: 600, color: t.accent, border: `1px solid ${t.accent}40`, borderRadius: 6, padding: "1px 7px" }}>{q.status}</span>}
                </div>
                <div style={{ fontSize: 11.5, color: t.dim, marginTop: 2 }}>
                  {q.quoteNumber ? `${q.quoteNumber} · ` : ""}{q.accountName ?? "No account"} {q.lineItemCount != null ? `· ${q.lineItemCount} line item(s)` : ""}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: t.heading }}>{q.grandTotal != null ? formatCurrency(q.grandTotal) : "—"}</div>
                <div style={{ fontSize: 10.5, color: t.dim }}>{new Date(q.lastModifiedDate).toLocaleDateString()}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </PageShell>
  );
}
