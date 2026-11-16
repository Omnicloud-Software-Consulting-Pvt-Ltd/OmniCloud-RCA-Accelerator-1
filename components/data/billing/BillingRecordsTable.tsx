"use client";

import { useMemo, useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, EmptyState } from "@/components/data/quotes/shared";
import { StatusPill, LoadingRow, ToolbarButton } from "@/components/data/billing/billingUi";
import { formatBillingValue } from "@/lib/billing/client";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import type { BillingListResponse, BillingRecordRow, BillingReferenceValue } from "@/lib/billing/types";

type SortKey = "name" | "status" | "created" | "modified" | string;

function sortValue(r: BillingRecordRow, key: SortKey): string | number {
  if (key === "name") return r.name.toLowerCase();
  if (key === "status") return (r.status ?? "").toLowerCase();
  if (key === "created") return r.createdDate ? new Date(r.createdDate).getTime() : 0;
  if (key === "modified") return r.lastModifiedDate ? new Date(r.lastModifiedDate).getTime() : 0;
  const ref = r.references[key];
  if (ref !== undefined) return (ref?.name ?? "").toLowerCase();
  const v = r.values[key];
  return typeof v === "number" ? v : String(v ?? "").toLowerCase();
}

/**
 * Salesforce-backed records table shared by every billing module dashboard and
 * History view — search, status filter, sortable columns, refresh and
 * click-through to details. Columns are whatever the module's registry
 * concepts resolved to in THIS org (never a fixed list of assumed fields).
 */
export default function BillingRecordsTable({
  isDark, data, loading, singular, icon, onOpen, onEdit, onAssign, onOpenLinked, onOpenReference, onRefresh, maxRows, compact, onServerSearch,
}: {
  isDark: boolean;
  data: BillingListResponse | null;
  loading: boolean;
  singular: string;
  icon: string;
  onOpen: (id: string) => void;
  /** When set, every row gets View | Edit actions (Edit opens the real Salesforce record for editing). */
  onEdit?: (id: string) => void;
  /** Adds an Assign action (e.g. assign this Billing Policy to a Product). */
  onAssign?: (id: string) => void;
  /** Opens a linked record from the Product column. */
  onOpenLinked?: (linked: { id: string; name: string }) => void;
  onOpenReference?: (ref: BillingReferenceValue) => void;
  onRefresh?: () => void;
  maxRows?: number;
  compact?: boolean;
  /** When set, pressing Enter in the search box searches Salesforce (not just the loaded rows). */
  onServerSearch?: (term: string) => void;
}) {
  const t = tokens(isDark);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "modified", dir: -1 });

  const records = useMemo(() => data?.records ?? [], [data]);
  const statuses = useMemo(() => ["All", ...new Set(records.map(r => r.status).filter((s): s is string => !!s))], [records]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = records.filter(r =>
      (status === "All" || r.status === status) &&
      (!q || r.name.toLowerCase().includes(q) || Object.values(r.references).some(ref => ref?.name.toLowerCase().includes(q)) ||
        Object.values(r.values).some(v => typeof v === "string" && v.toLowerCase().includes(q))),
    );
    const sorted = [...filtered].sort((a, b) => {
      const av = sortValue(a, sort.key), bv = sortValue(b, sort.key);
      return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
    });
    return maxRows ? sorted.slice(0, maxRows) : sorted;
  }, [records, search, status, sort, maxRows]);

  const columns = data?.columns.filter(c => c.field !== data.statusField) ?? [];
  const toggleSort = (key: SortKey) => setSort(s => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "modified" || key === "created" ? -1 : 1 }));

  const th = (key: SortKey, label: string, align: "left" | "right" = "left") => (
    <th key={key} style={{ textAlign: align, padding: "8px 10px", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: t.dim, whiteSpace: "nowrap", borderBottom: `1px solid ${t.border}`, cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort(key)}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {label}
        {sort.key === key && <Ic n={sort.dir === 1 ? "chevron-up" : "chevron-down"} s={10} />}
      </span>
    </th>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 240px" }}>
          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: t.dim, display: "inline-flex" }}><Ic n="search" s={13} /></span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && onServerSearch) onServerSearch(search); }}
            placeholder={onServerSearch ? `Search ${singular} records (Enter searches Salesforce)…` : `Filter ${singular} records…`}
            style={{ ...inputStyle(t), paddingLeft: 30 }}
          />
        </div>
        <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...inputStyle(t), width: 170 }} aria-label="Filter by status">
          {statuses.map(s => <option key={s} value={s}>{s === "All" ? "All statuses" : s}</option>)}
        </select>
        {onRefresh && <ToolbarButton isDark={isDark} label="Refresh" icon="refresh" onClick={onRefresh} disabled={loading} />}
      </div>

      {loading && !data && <LoadingRow isDark={isDark} label={`Loading ${singular} records from Salesforce…`} />}
      {data && rows.length === 0 && (
        <EmptyState isDark={isDark} icon={icon} title={records.length === 0 ? `No ${singular} records in this org yet` : "No records match your filters"} hint={records.length === 0 ? `Use Create ${singular} to add the first one.` : "Try a different search term or status."} />
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface, opacity: loading ? 0.6 : 1, transition: "opacity .2s" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: compact ? 12 : 12.5 }}>
            <thead>
              <tr>
                {th("name", "Name")}
                {columns.map(c => th(c.field, c.label))}
                {data?.linkedColumn && <th style={{ textAlign: "left", padding: "8px 10px", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: t.dim, whiteSpace: "nowrap", borderBottom: `1px solid ${t.border}` }} title={data.linkedColumn.relation}>{data.linkedColumn.label}</th>}
                {data?.statusField && th("status", "Status")}
                {!compact && th("created", "Created")}
                {th("modified", "Last Modified")}
                {onEdit && <th style={{ position: "sticky", right: 0, background: t.surface, boxShadow: `-8px 0 12px -10px rgba(0,0,0,0.35)`, textAlign: "right", padding: "8px 10px", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: t.dim, borderBottom: `1px solid ${t.border}` }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr
                  key={r.id}
                  onClick={() => onOpen(r.id)}
                  style={{ cursor: "pointer", borderBottom: `1px solid ${t.border}` }}
                  onMouseEnter={e => (e.currentTarget.style.background = isDark ? "rgba(0,212,255,0.05)" : "rgba(0,71,171,0.05)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <td style={{ padding: "9px 10px", fontWeight: 700, color: t.heading, whiteSpace: "nowrap" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                      <span style={{ color: t.accent, display: "inline-flex" }}><Ic n={icon} s={13} /></span>{r.name}
                    </span>
                  </td>
                  {columns.map(c => {
                    const ref = r.references[c.field];
                    return (
                      <td key={c.field} style={{ padding: "9px 10px", color: t.body, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.type === "reference" ? (
                          ref ? (
                            onOpenReference ? (
                              <button onClick={e => { e.stopPropagation(); onOpenReference(ref); }} style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: t.accent, fontSize: "inherit", fontWeight: 600 }} title={`Open ${ref.name}`}>{ref.name}</button>
                            ) : ref.name
                          ) : <span style={{ color: t.dim }}>—</span>
                        ) : formatBillingValue(r.values[c.field], c.type)}
                      </td>
                    );
                  })}
                  {data?.linkedColumn && (
                    <td style={{ padding: "9px 10px", color: t.body, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.linked && r.linked.length > 0
                        ? r.linked.slice(0, 3).map((l, i) => (
                          <span key={l.id}>{i > 0 && ", "}{onOpenLinked
                            ? <button onClick={e => { e.stopPropagation(); onOpenLinked(l); }} style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: t.accent, fontSize: "inherit", fontWeight: 600 }}>{l.name}</button>
                            : l.name}</span>
                        )).concat(r.linked.length > 3 ? [<span key="more" style={{ color: t.dim }}> +{r.linked.length - 3}</span>] : [])
                        : <span style={{ color: t.dim }}>Not assigned</span>}
                    </td>
                  )}
                  {data?.statusField && <td style={{ padding: "9px 10px" }}><StatusPill status={r.status} isDark={isDark} /></td>}
                  {!compact && <td style={{ padding: "9px 10px", color: t.dim, whiteSpace: "nowrap" }}>{r.createdDate ? new Date(r.createdDate).toLocaleDateString() : "—"}{r.createdByName ? ` · ${r.createdByName}` : ""}</td>}
                  <td style={{ padding: "9px 10px", color: t.dim, whiteSpace: "nowrap" }}>{r.lastModifiedDate ? formatRelativeTime(r.lastModifiedDate) : "—"}</td>
                  {onEdit && (
                    <td style={{ position: "sticky", right: 0, background: t.surface, boxShadow: `-8px 0 12px -10px rgba(0,0,0,0.35)`, padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <button onClick={e => { e.stopPropagation(); onOpen(r.id); }} style={{ background: "transparent", border: "none", cursor: "pointer", color: t.accent, fontWeight: 700, fontSize: 12 }}>View</button>
                      <span style={{ color: t.dim, margin: "0 6px" }}>|</span>
                      <button onClick={e => { e.stopPropagation(); onEdit(r.id); }} style={{ background: "transparent", border: "none", cursor: "pointer", color: t.accent, fontWeight: 700, fontSize: 12 }}>Edit</button>
                      {onAssign && (<>
                        <span style={{ color: t.dim, margin: "0 6px" }}>|</span>
                        <button onClick={e => { e.stopPropagation(); onAssign(r.id); }} style={{ background: "transparent", border: "none", cursor: "pointer", color: t.accent, fontWeight: 700, fontSize: 12 }}>Assign</button>
                      </>)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {maxRows && records.length > maxRows && (
        <div style={{ fontSize: 11, color: t.dim }}>Showing {maxRows} of {records.length} loaded records — open History for the full list.</div>
      )}
    </div>
  );
}
