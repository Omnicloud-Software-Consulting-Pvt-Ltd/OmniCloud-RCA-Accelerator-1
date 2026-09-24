"use client";

import { useEffect, useMemo, useState } from "react";
import { Ic, tokens, inputStyle, PageShell, EmptyState, Spinner, ErrorPanel } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { AttributeListItem } from "@/lib/attributes/types";

const RECENCY_OPTIONS = ["All time", "Last 7 days", "Last 30 days", "Last 90 days"] as const;
type Recency = typeof RECENCY_OPTIONS[number];

function withinRecency(dateStr: string, recency: Recency): boolean {
  if (recency === "All time") return true;
  const days = recency === "Last 7 days" ? 7 : recency === "Last 30 days" ? 30 : 90;
  return Date.now() - new Date(dateStr).getTime() <= days * 24 * 60 * 60 * 1000;
}

/**
 * Attribute History — Data Omnion's Attribute Workspace list of already-
 * created attributes. Reads /api/sf/attributes/list (the same
 * AttributeDefinition data RCAAttributeStudio's Deploy step writes) rather
 * than a second query path. Also serves as the "Attribute Catalog" browse
 * view (catalogMode) — same data, same table, different framing, mirroring
 * Bundle Catalog's precedent.
 */
export default function AttributeHistoryList({
  isDark, onView, onEdit, refreshToken, catalogMode,
}: {
  isDark: boolean;
  onView: (id: string) => void;
  onEdit: (id: string) => void;
  refreshToken?: number;
  catalogMode?: boolean;
}) {
  const t = tokens(isDark);
  const [attributes, setAttributes] = useState<AttributeListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const [dataType, setDataType] = useState("All");
  const [product, setProduct] = useState("All");
  const [createdRecency, setCreatedRecency] = useState<Recency>("All time");
  const [modifiedRecency, setModifiedRecency] = useState<Recency>("All time");

  useEffect(() => {
    quoteApiGet<{ success: true; attributes: AttributeListItem[] }>("List attributes", "/api/sf/attributes/list")
      .then(res => setAttributes(res.attributes))
      .catch(err => setError(toErrorPanelData(err, "Could not load attribute history")))
      .finally(() => setLoading(false));
  }, [refreshToken]);

  const uniq = (values: (string | null | undefined)[]) => ["All", ...new Set(values.filter((v): v is string => !!v))];
  const dataTypes = useMemo(() => uniq(attributes.map(a => a.dataType)), [attributes]);
  const products = useMemo(() => uniq(attributes.flatMap(a => a.relatedProducts.map(p => p.name))), [attributes]);

  const filtered = attributes.filter(a => {
    const searchLower = search.trim().toLowerCase();
    const matchesSearch = !searchLower ||
      a.name.toLowerCase().includes(searchLower) ||
      (a.apiName ?? "").toLowerCase().includes(searchLower) ||
      a.relatedProducts.some(p => p.name.toLowerCase().includes(searchLower));
    return matchesSearch &&
      (status === "All" || (status === "Active" ? a.isActive : !a.isActive)) &&
      (dataType === "All" || a.dataType === dataType) &&
      (product === "All" || a.relatedProducts.some(p => p.name === product)) &&
      withinRecency(a.createdDate, createdRecency) &&
      withinRecency(a.lastModifiedDate, modifiedRecency);
  });

  const header = (
    <div style={{ padding: "16px 20px 0", flexShrink: 0 }}>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>
        {catalogMode ? "Attribute Catalog" : "Attribute History"}
      </h2>
      <p style={{ fontSize: 12, color: t.dim, marginTop: 4, marginBottom: 12 }}>
        {catalogMode
          ? "Browse and search all available attributes and their configurations."
          : "Attributes already created in Salesforce — search, filter, view, or edit."}
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by attribute name, API name, or product…" style={{ ...inputStyle(t), flex: 1, minWidth: 220 }} />
        <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...inputStyle(t), width: 120 }}>
          {["All", "Active", "Inactive"].map(s => <option key={s} value={s}>{s === "All" ? "All Status" : s}</option>)}
        </select>
        <select value={dataType} onChange={e => setDataType(e.target.value)} style={{ ...inputStyle(t), width: 150 }}>
          {dataTypes.map(s => <option key={s} value={s}>{s === "All" ? "All Types" : s}</option>)}
        </select>
        <select value={product} onChange={e => setProduct(e.target.value)} style={{ ...inputStyle(t), width: 170 }}>
          {products.map(s => <option key={s} value={s}>{s === "All" ? "All Products" : s}</option>)}
        </select>
        <select value={createdRecency} onChange={e => setCreatedRecency(e.target.value as Recency)} style={{ ...inputStyle(t), width: 160 }}>
          {RECENCY_OPTIONS.map(s => <option key={s} value={s}>{s === "All time" ? "Created: All time" : `Created: ${s}`}</option>)}
        </select>
        <select value={modifiedRecency} onChange={e => setModifiedRecency(e.target.value as Recency)} style={{ ...inputStyle(t), width: 175 }}>
          {RECENCY_OPTIONS.map(s => <option key={s} value={s}>{s === "All time" ? "Modified: All time" : `Modified: ${s}`}</option>)}
        </select>
      </div>
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ padding: "0 20px 20px" }}>
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim, padding: "20px 0" }}>
            <Spinner isDark={isDark} /> Loading attributes…
          </div>
        )}
        {error && <div style={{ marginBottom: 12 }}><ErrorPanel isDark={isDark} error={error} /></div>}

        {!loading && !error && filtered.length === 0 && (
          <EmptyState
            isDark={isDark}
            icon="sliders"
            title="No attributes found"
            hint={attributes.length === 0 ? "Click Create Attribute to build your first one." : "Try a different search term or filter."}
          />
        )}

        {!loading && filtered.length > 0 && (
          <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1.1fr 0.8fr 1.2fr 0.7fr 0.8fr 0.9fr 0.9fr 0.9fr", padding: "9px 14px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
              <span>Attribute Name</span><span>API Name</span><span>Type</span><span>Related Product</span><span>Status</span><span># Values</span><span>Created</span><span>Modified</span><span>Actions</span>
            </div>
            {filtered.map((a, i) => (
              <div key={a.id} style={{ display: "grid", gridTemplateColumns: "1.5fr 1.1fr 0.8fr 1.2fr 0.7fr 0.8fr 0.9fr 0.9fr 0.9fr", padding: "10px 14px", borderTop: i > 0 ? `1px solid ${t.border}` : undefined, alignItems: "center", fontSize: 12, color: t.body }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <Ic n="sliders" s={13} />
                  <span style={{ fontWeight: 700, color: t.heading, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                </div>
                <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: t.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.apiName ?? "—"}</span>
                <span>{a.dataType ?? "—"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.relatedProducts.map(p => p.name).join(", ") || "—"}</span>
                <span style={{ color: a.isActive ? "#22C55E" : t.dim, fontWeight: 600 }}>{a.isActive ? "Active" : "Inactive"}</span>
                <span>{a.isPicklist ? a.picklistValueCount : "—"}</span>
                <span style={{ fontSize: 11, color: t.dim }}>{new Date(a.createdDate).toLocaleDateString()}</span>
                <span style={{ fontSize: 11, color: t.dim }}>{new Date(a.lastModifiedDate).toLocaleDateString()}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => onView(a.id)} title="View" style={{ color: t.accent, background: "transparent", border: "none", cursor: "pointer" }}><Ic n="eye" s={14} /></button>
                  <button onClick={() => onEdit(a.id)} title="Edit" style={{ color: t.accentBlue, background: "transparent", border: "none", cursor: "pointer" }}><Ic n="edit" s={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
