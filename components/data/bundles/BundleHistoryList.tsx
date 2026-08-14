"use client";

import { useEffect, useMemo, useState } from "react";
import { Ic, tokens, inputStyle, PageShell, EmptyState, Spinner, ErrorPanel } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { BundleListItem } from "@/app/api/bundles/list/route";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import { loadSession } from "@/lib/auth/session";
import { toCreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";

interface BundleListResponse {
  bundles: BundleListItem[];
}

const RECENCY_OPTIONS = ["All time", "Last 7 days", "Last 30 days", "Last 90 days"] as const;
type Recency = typeof RECENCY_OPTIONS[number];

function withinRecency(dateStr: string, recency: Recency): boolean {
  if (recency === "All time") return true;
  const days = recency === "Last 7 days" ? 7 : recency === "Last 30 days" ? 30 : 90;
  return Date.now() - new Date(dateStr).getTime() <= days * 24 * 60 * 60 * 1000;
}

/**
 * Bundle History — Data Omnion's Bundle Workspace list of already-created
 * bundles. Reads the existing /api/bundles/list endpoint (the same
 * Product2 Type='Bundle' + ProductRelatedComponent data model Create
 * Bundle already writes) rather than a second bundle query. Also serves as
 * the "Bundle Catalog" browse view (catalogMode) — same data, same table,
 * different framing — per the requirement to reuse rather than duplicate.
 */
export default function BundleHistoryList({
  isDark, onView, onEdit, refreshToken, catalogMode,
}: {
  isDark: boolean;
  onView: (id: string) => void;
  onEdit: (id: string) => void;
  refreshToken?: number;
  /** Renders as "Bundle Catalog" framing over the identical data/table. */
  catalogMode?: boolean;
}) {
  const t = tokens(isDark);
  const notifySalesforceSuccess = useSalesforceSuccess();
  const [bundles, setBundles] = useState<BundleListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const [bundleType, setBundleType] = useState("All");
  const [family, setFamily] = useState("All");
  const [sellingModel, setSellingModel] = useState("All");
  const [catalog, setCatalog] = useState("All");
  const [category, setCategory] = useState("All");
  const [recency, setRecency] = useState<Recency>("All time");
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  useEffect(() => {
    quoteApiGet<{ success: true; bundles: BundleListItem[] }>("List bundles", "/api/bundles/list")
      .then(res => setBundles(res.bundles))
      .catch(err => setError(toErrorPanelData(err, "Could not load bundle history")))
      .finally(() => setLoading(false));
  }, [refreshToken]);

  const uniq = (values: (string | null | undefined)[]) => ["All", ...new Set(values.filter((v): v is string => !!v))];
  const bundleTypes = useMemo(() => uniq(bundles.map(b => b.bundleType)), [bundles]);
  const families = useMemo(() => uniq(bundles.map(b => b.family)), [bundles]);
  const sellingModels = useMemo(() => uniq(bundles.map(b => b.sellingModel ?? null)), [bundles]);
  const catalogs = useMemo(() => uniq(bundles.map(b => b.catalog)), [bundles]);
  const categories = useMemo(() => uniq(bundles.map(b => b.category)), [bundles]);

  const filtered = bundles.filter(b => {
    const searchLower = search.trim().toLowerCase();
    const matchesSearch = !searchLower ||
      b.name.toLowerCase().includes(searchLower) ||
      (b.productCode ?? "").toLowerCase().includes(searchLower) ||
      b.children.some(c => c.name.toLowerCase().includes(searchLower));
    return matchesSearch &&
      (status === "All" || (status === "Active" ? b.isActive : !b.isActive)) &&
      (bundleType === "All" || b.bundleType === bundleType) &&
      (family === "All" || b.family === family) &&
      (sellingModel === "All" || b.sellingModel === sellingModel) &&
      (catalog === "All" || b.catalog === catalog) &&
      (category === "All" || b.category === category) &&
      withinRecency(b.lastModifiedDate, recency);
  });

  const handleDuplicate = async (id: string, name: string) => {
    setDuplicatingId(id);
    try {
      const res = await fetch(`/api/bundles/${id}/duplicate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(toErrorPanelData(new Error(data.error ?? "Failed to duplicate bundle"), "Could not duplicate this bundle"));
        return;
      }
      const instanceUrl = loadSession()?.instanceUrl;
      if (instanceUrl && data.salesforceId) {
        const record = toCreatedSalesforceRecord(instanceUrl, "Product2", data.salesforceId, `${name} (Copy)`);
        notifySalesforceSuccess({
          title: "Bundle Duplicated Successfully",
          message: `${record.recordName} has been created in Salesforce as a draft copy of ${name}.`,
          records: [record],
        });
      }
      setLoading(true);
      const refreshed = await quoteApiGet<BundleListResponse>("List bundles", "/api/bundles/list");
      setBundles(refreshed.bundles);
    } catch {
      setError({ title: "Network error", message: "Could not reach the server to duplicate this bundle." });
    } finally {
      setDuplicatingId(null);
      setLoading(false);
    }
  };

  const header = (
    <div style={{ padding: "16px 20px 0", flexShrink: 0 }}>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>
        {catalogMode ? "Bundle Catalog" : "Bundle History"}
      </h2>
      <p style={{ fontSize: 12, color: t.dim, marginTop: 4, marginBottom: 12 }}>
        {catalogMode
          ? "Browse and search all available bundles and their product structures."
          : "Bundles already created in Salesforce — search, filter, view, or edit."}
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by bundle name, code, or product…" style={{ ...inputStyle(t), flex: 1, minWidth: 220 }} />
        <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...inputStyle(t), width: 120 }}>
          {["All", "Active", "Inactive"].map(s => <option key={s} value={s}>{s === "All" ? "All Status" : s}</option>)}
        </select>
        <select value={bundleType} onChange={e => setBundleType(e.target.value)} style={{ ...inputStyle(t), width: 140 }}>
          {bundleTypes.map(s => <option key={s} value={s}>{s === "All" ? "All Types" : s}</option>)}
        </select>
        <select value={family} onChange={e => setFamily(e.target.value)} style={{ ...inputStyle(t), width: 150 }}>
          {families.map(s => <option key={s} value={s}>{s === "All" ? "All Families" : s}</option>)}
        </select>
        <select value={sellingModel} onChange={e => setSellingModel(e.target.value)} style={{ ...inputStyle(t), width: 170 }}>
          {sellingModels.map(s => <option key={s} value={s}>{s === "All" ? "All Selling Models" : s}</option>)}
        </select>
        <select value={catalog} onChange={e => setCatalog(e.target.value)} style={{ ...inputStyle(t), width: 150 }}>
          {catalogs.map(s => <option key={s} value={s}>{s === "All" ? "All Catalogs" : s}</option>)}
        </select>
        <select value={category} onChange={e => setCategory(e.target.value)} style={{ ...inputStyle(t), width: 150 }}>
          {categories.map(s => <option key={s} value={s}>{s === "All" ? "All Categories" : s}</option>)}
        </select>
        <select value={recency} onChange={e => setRecency(e.target.value as Recency)} style={{ ...inputStyle(t), width: 140 }}>
          {RECENCY_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ padding: "0 20px 20px" }}>
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim, padding: "20px 0" }}>
            <Spinner isDark={isDark} /> Loading bundles…
          </div>
        )}
        {error && <div style={{ marginBottom: 12 }}><ErrorPanel isDark={isDark} error={error} /></div>}

        {!loading && !error && filtered.length === 0 && (
          <EmptyState
            isDark={isDark}
            icon="package"
            title="No bundles found"
            hint={bundles.length === 0 ? "Click Create Bundle to build your first one." : "Try a different search term or filter."}
          />
        )}

        {!loading && filtered.length > 0 && (
          <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.6fr 0.9fr 0.8fr 0.7fr 0.7fr 1fr 0.8fr 0.9fr 0.9fr 1fr", padding: "9px 14px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
              <span>Bundle Name</span><span>Bundle Code</span><span>Type</span><span>Status</span><span>Components</span><span>Selling Model</span><span>Price</span><span>Last Modified</span><span>Created</span><span>Actions</span>
            </div>
            {filtered.map((b, i) => (
              <div key={b.id} style={{ display: "grid", gridTemplateColumns: "1.6fr 0.9fr 0.8fr 0.7fr 0.7fr 1fr 0.8fr 0.9fr 0.9fr 1fr", padding: "10px 14px", borderTop: i > 0 ? `1px solid ${t.border}` : undefined, alignItems: "center", fontSize: 12, color: t.body }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <Ic n="package" s={13} />
                  <span style={{ fontWeight: 700, color: t.heading, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                </div>
                <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: t.dim }}>{b.productCode ?? "—"}</span>
                <span>{b.bundleType}</span>
                <span style={{ color: b.isActive ? "#22C55E" : t.dim, fontWeight: 600 }}>{b.isActive ? "Active" : "Inactive"}</span>
                <span>{b.productCount + b.nestedBundleCount}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.sellingModel ?? "—"}</span>
                <span style={{ fontFamily: "ui-monospace, monospace" }}>{b.totalPrice ? `$${b.totalPrice.toLocaleString()}` : "—"}</span>
                <span style={{ fontSize: 11, color: t.dim }}>{new Date(b.lastModifiedDate).toLocaleDateString()}</span>
                <span style={{ fontSize: 11, color: t.dim }}>{new Date(b.createdDate).toLocaleDateString()}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => onView(b.id)} title="View" style={{ color: t.accent, background: "transparent", border: "none", cursor: "pointer" }}><Ic n="eye" s={14} /></button>
                  <button onClick={() => onEdit(b.id)} title="Edit" style={{ color: t.accentBlue, background: "transparent", border: "none", cursor: "pointer" }}><Ic n="edit" s={14} /></button>
                  <button
                    onClick={() => handleDuplicate(b.id, b.name)}
                    disabled={duplicatingId === b.id}
                    title="Duplicate"
                    style={{ color: t.dim, background: "transparent", border: "none", cursor: duplicatingId === b.id ? "not-allowed" : "pointer" }}
                  >
                    {duplicatingId === b.id ? <Spinner isDark={isDark} /> : <Ic n="copy" s={14} />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
