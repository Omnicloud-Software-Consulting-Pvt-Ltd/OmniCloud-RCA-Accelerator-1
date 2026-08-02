"use client";

import { useEffect, useMemo, useState } from "react";
import { Ic, tokens, inputStyle, PageShell, EmptyState, Spinner, ErrorPanel, CodeBlock, GhostButton } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { ContractListItem } from "@/lib/contracts/types";

interface ContractHistoryResponse {
  contracts: ContractListItem[];
  soql: string;
  relationshipNames: { account: string | null };
}

export default function ContractHistoryList({ isDark, onOpen }: { isDark: boolean; onOpen: (id: string) => void }) {
  const t = tokens(isDark);
  const [contracts, setContracts] = useState<ContractListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const [soql, setSoql] = useState<string | null>(null);
  const [relationshipNames, setRelationshipNames] = useState<ContractHistoryResponse["relationshipNames"] | null>(null);
  const [showSoql, setShowSoql] = useState(false);

  useEffect(() => {
    quoteApiGet<ContractHistoryResponse>("List contracts", "/api/contracts")
      .then(res => {
        setContracts(res.contracts);
        setSoql(res.soql);
        setRelationshipNames(res.relationshipNames);
      })
      .catch(err => setError(toErrorPanelData(err, "Could not load contract history")))
      .finally(() => setLoading(false));
  }, []);

  const statuses = useMemo(() => ["All", ...new Set(contracts.map(c => c.status).filter((s): s is string => !!s))], [contracts]);
  const filtered = contracts.filter(c =>
    (status === "All" || c.status === status) &&
    (search.trim() === "" || (c.contractNumber ?? "").toLowerCase().includes(search.toLowerCase()) || (c.accountName ?? "").toLowerCase().includes(search.toLowerCase())),
  );

  const header = (
    <div style={{ padding: "16px 20px 0", flexShrink: 0, display: "flex", gap: 8 }}>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search contracts…" style={{ ...inputStyle(t), flex: 1 }} />
      <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...inputStyle(t), width: 160 }}>
        {statuses.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ padding: 20 }}>
        {loading && <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}><Spinner isDark={isDark} /> Loading contracts…</div>}
        {error && <ErrorPanel isDark={isDark} error={error} />}

        {soql && (
          <div style={{ marginBottom: 12 }}>
            <GhostButton label={showSoql ? "Hide generated SOQL" : "View generated SOQL"} icon="terminal" isDark={isDark} onClick={() => setShowSoql(v => !v)} />
            {showSoql && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}`, fontSize: 11.5, color: t.body, overflowX: "auto" }}>{soql}</pre>
                {relationshipNames && (
                  <div style={{ fontSize: 11, color: t.dim }}>
                    Relationship name resolved from Describe — Account: <code>{relationshipNames.account ?? "none"}</code>. Never a guessed/stripped field name.
                  </div>
                )}
                <CodeBlock isDark={isDark} data={{ soql, relationshipNames }} />
              </div>
            )}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <EmptyState isDark={isDark} icon="file-contract" title="No contracts found" hint={contracts.length === 0 ? "Click Create Contract to author your first one." : "Try a different search term or status filter."} />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(c => (
            <button
              key={c.id}
              onClick={() => onOpen(c.id)}
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
                  <Ic n="file-contract" s={14} /> {c.contractNumber ?? c.id}
                  {c.status && <span style={{ fontSize: 11, fontWeight: 600, color: t.accent, border: `1px solid ${t.accent}40`, borderRadius: 6, padding: "1px 7px" }}>{c.status}</span>}
                </div>
                <div style={{ fontSize: 11.5, color: t.dim, marginTop: 2 }}>
                  {c.accountName ?? "No account"} {c.startDate ? `· starts ${c.startDate}` : ""}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 12, color: t.heading }}>{c.endDate ? `ends ${c.endDate}` : "—"}</div>
                <div style={{ fontSize: 10.5, color: t.dim }}>{new Date(c.lastModifiedDate).toLocaleDateString()}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </PageShell>
  );
}
