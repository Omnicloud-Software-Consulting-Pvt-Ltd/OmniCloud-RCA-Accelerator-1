"use client";

import { useEffect, useState } from "react";
import { Ic, tokens, PageShell, Spinner, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { BundleDetail } from "@/lib/bundles/server/bundleDetail";

/**
 * Read-only Bundle Detail — Bundle Information, Bundle Structure (parent →
 * children tree), and a full Components table. Reads the same
 * /api/bundles/[id] GET the Edit workspace loads from; this view never
 * writes anything.
 */
export default function BundleDetailView({ isDark, bundleId, onBack, onEdit }: {
  isDark: boolean; bundleId: string; onBack: () => void; onEdit: () => void;
}) {
  const t = tokens(isDark);
  const [bundle, setBundle] = useState<BundleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);

  useEffect(() => {
    quoteApiGet<{ success: true; bundle: BundleDetail }>("Load bundle", `/api/bundles/${bundleId}`)
      .then(res => setBundle(res.bundle))
      .catch(err => setError(toErrorPanelData(err, "Could not load this bundle")))
      .finally(() => setLoading(false));
  }, [bundleId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: t.dim }}><Spinner isDark={isDark} /> Loading bundle…</div>
      </div>
    );
  }

  if (error || !bundle) {
    return (
      <div style={{ padding: 24 }}>
        <ErrorPanel isDark={isDark} error={error ?? { title: "Could not load this bundle", message: "Unknown error" }} />
        <div style={{ marginTop: 12 }}><GhostButton label="Back to Bundle History" icon="arrow-left" isDark={isDark} onClick={onBack} /></div>
      </div>
    );
  }

  const header = (
    <div style={{ padding: "20px 24px 0", flexShrink: 0 }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Ic n="package" s={16} />
            <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>{bundle.name}</h2>
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, color: bundle.isActive ? "#22C55E" : t.dim, border: `1px solid ${bundle.isActive ? "#22C55E" : t.border}` }}>
              {bundle.isActive ? "Active" : "Inactive"}
            </span>
          </div>
          <p style={{ fontSize: 12, color: t.dim, marginTop: 4 }}>{bundle.productCode ?? "No code"} · {bundle.components.length} component{bundle.components.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex items-center gap-2">
          <GhostButton label="Back to History" icon="arrow-left" isDark={isDark} onClick={onBack} />
          <button onClick={onEdit} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, border: "none", fontSize: 12.5, fontWeight: 700, color: "#04101F", cursor: "pointer", background: `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})` }}>
            <Ic n="edit" s={13} /> Edit Bundle
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24, maxWidth: 980 }}>

        {/* Bundle Information */}
        <section>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 12 }}>Bundle Information</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 16, padding: 16, borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface }}>
            <InfoField label="Bundle Name" value={bundle.name} t={t} />
            <InfoField label="Bundle Code" value={bundle.productCode ?? "—"} t={t} />
            <InfoField label="Family" value={bundle.family ?? "—"} t={t} />
            <InfoField label="Type" value={bundle.type ?? "—"} t={t} />
            <InfoField label="Active" value={bundle.isActive ? "Yes" : "No"} t={t} />
            <InfoField label="Catalog" value={bundle.catalog ?? "—"} t={t} />
            <InfoField label="Category" value={bundle.category ?? "—"} t={t} />
            <InfoField label="Selling Model" value={bundle.sellingModel ?? "—"} t={t} />
            <InfoField label="Price" value={bundle.basePrice ? `$${Number(bundle.basePrice).toLocaleString()}${bundle.currencyIsoCode ? ` ${bundle.currencyIsoCode}` : ""}` : "—"} t={t} />
          </div>
          {bundle.description && (
            <div style={{ marginTop: 10 }}>
              <InfoField label="Description" value={bundle.description} t={t} />
            </div>
          )}
        </section>

        {/* Bundle Structure */}
        <section>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 12 }}>Bundle Structure</p>
          <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, background: isDark ? "rgba(2,6,18,0.85)" : "rgba(228,238,255,0.95)", padding: 16, fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 2 }}>
            <div style={{ color: t.accentBlue, fontWeight: 700 }}>{bundle.name}</div>
            {bundle.components.length === 0 ? (
              <div style={{ color: t.dim, marginLeft: 16 }}>(no components yet)</div>
            ) : bundle.components.map((c, i) => {
              const isLast = i === bundle.components.length - 1;
              return (
                <div key={c.relationshipId} style={{ marginLeft: 16, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ color: t.dim }}>{isLast ? "└── " : "├── "}</span>
                  <span style={{ color: t.body, fontWeight: 600 }}>{c.childName}</span>
                  {c.childType === "Bundle" && (
                    <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 999, color: t.accentCyan, border: `1px solid ${t.accentCyan}55` }}>NESTED BUNDLE</span>
                  )}
                  <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 999, color: c.isComponentRequired ? t.accentBlue : t.dim, border: `1px solid ${c.isComponentRequired ? t.accentBlue + "55" : t.border}` }}>
                    {c.isComponentRequired ? "REQUIRED" : "OPTIONAL"}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Components table */}
        <section>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 12 }}>Bundle Components ({bundle.components.length})</p>
          {bundle.components.length === 0 ? (
            <p style={{ fontSize: 12, color: t.dim }}>This bundle has no components yet.</p>
          ) : (
            <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 0.8fr 1.1fr 0.8fr 0.9fr", padding: "9px 14px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
                <span>Product Name</span><span>Product Code</span><span>Type</span><span>Selling Model</span><span>Price</span><span>Status</span>
              </div>
              {bundle.components.map((c, i) => (
                <div key={c.relationshipId} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 0.8fr 1.1fr 0.8fr 0.9fr", padding: "9px 14px", borderTop: i > 0 ? `1px solid ${t.border}` : undefined, fontSize: 12, color: t.body, alignItems: "center" }}>
                  <span style={{ fontWeight: 600, color: t.heading }}>{c.childName}</span>
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: t.dim }}>{c.childProductCode ?? "—"}</span>
                  <span>{c.childType === "Bundle" ? "Bundle" : "Standard"}</span>
                  <span>{c.childSellingModel ?? "—"}</span>
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>{c.childPrice != null ? `$${c.childPrice.toLocaleString()}` : "—"}</span>
                  <span style={{ color: c.isComponentRequired ? t.accentBlue : t.dim, fontWeight: 600 }}>{c.isComponentRequired ? "Required" : "Optional"}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </PageShell>
  );
}

function InfoField({ label, value, t }: { label: string; value: string; t: ReturnType<typeof tokens> }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: t.heading, marginTop: 2 }}>{value || "—"}</div>
    </div>
  );
}
