"use client";

import { useEffect, useState } from "react";
import { Ic, tokens, PageShell, Spinner, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { AttributeDetail } from "@/lib/attributes/types";

/**
 * Read-only Attribute Detail — Attribute Information and Configuration
 * (picklist values, when applicable). Reads the same
 * /api/sf/attributes/[id] GET the Edit workspace loads from; this view
 * never writes anything.
 */
export default function AttributeDetailView({ isDark, attributeId, onBack, onEdit }: {
  isDark: boolean; attributeId: string; onBack: () => void; onEdit: () => void;
}) {
  const t = tokens(isDark);
  const [attribute, setAttribute] = useState<AttributeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);

  useEffect(() => {
    quoteApiGet<{ success: true; attribute: AttributeDetail }>("Load attribute", `/api/sf/attributes/${attributeId}`)
      .then(res => setAttribute(res.attribute))
      .catch(err => setError(toErrorPanelData(err, "Could not load this attribute")))
      .finally(() => setLoading(false));
  }, [attributeId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: t.dim }}><Spinner isDark={isDark} /> Loading attribute…</div>
      </div>
    );
  }

  if (error || !attribute) {
    return (
      <div style={{ padding: 24 }}>
        <ErrorPanel isDark={isDark} error={error ?? { title: "Could not load this attribute", message: "Unknown error" }} />
        <div style={{ marginTop: 12 }}><GhostButton label="Back to Attribute History" icon="arrow-left" isDark={isDark} onClick={onBack} /></div>
      </div>
    );
  }

  const header = (
    <div style={{ padding: "20px 24px 0", flexShrink: 0 }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Ic n="sliders" s={16} />
            <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>{attribute.name}</h2>
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, color: attribute.isActive ? "#22C55E" : t.dim, border: `1px solid ${attribute.isActive ? "#22C55E" : t.border}` }}>
              {attribute.isActive ? "Active" : "Inactive"}
            </span>
          </div>
          <p style={{ fontSize: 12, color: t.dim, marginTop: 4 }}>{attribute.apiName ?? "No API name"} · {attribute.dataType ?? "Unknown type"}</p>
        </div>
        <div className="flex items-center gap-2">
          <GhostButton label="Back to History" icon="arrow-left" isDark={isDark} onClick={onBack} />
          <button onClick={onEdit} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, border: "none", fontSize: 12.5, fontWeight: 700, color: "#04101F", cursor: "pointer", background: `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})` }}>
            <Ic n="edit" s={13} /> Edit Attribute
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24, maxWidth: 980 }}>

        {/* Attribute Information */}
        <section>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 12 }}>Attribute Information</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 16, padding: 16, borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface }}>
            <InfoField label="Attribute Name" value={attribute.name} t={t} />
            <InfoField label="API Name" value={attribute.apiName ?? "—"} t={t} mono />
            <InfoField label="Data Type" value={attribute.dataType ?? "—"} t={t} />
            <InfoField label="Status" value={attribute.isActive ? "Active" : "Inactive"} t={t} />
            <InfoField label="Related Product" value={attribute.relatedProducts.map(p => p.name).join(", ") || "—"} t={t} />
          </div>
          {attribute.description && (
            <div style={{ marginTop: 10 }}>
              <InfoField label="Description" value={attribute.description} t={t} />
            </div>
          )}
        </section>

        {/* Configuration */}
        <section>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 12 }}>
            Configuration{attribute.isPicklist ? ` (${attribute.picklistValues.length} value${attribute.picklistValues.length === 1 ? "" : "s"})` : ""}
          </p>
          {!attribute.isPicklist ? (
            <p style={{ fontSize: 12, color: t.dim }}>This attribute is not a picklist — it has no configured values.</p>
          ) : attribute.picklistValues.length === 0 ? (
            <p style={{ fontSize: 12, color: t.dim }}>This attribute&apos;s picklist has no values yet.</p>
          ) : (
            <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "0.6fr 1.4fr 1.4fr 0.8fr", padding: "9px 14px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
                <span>Seq</span><span>Value</span><span>Display Value</span><span>Status</span>
              </div>
              {attribute.picklistValues.map((v, i) => (
                <div key={v.id} style={{ display: "grid", gridTemplateColumns: "0.6fr 1.4fr 1.4fr 0.8fr", padding: "9px 14px", borderTop: i > 0 ? `1px solid ${t.border}` : undefined, fontSize: 12, color: t.body, alignItems: "center" }}>
                  <span style={{ fontFamily: "ui-monospace, monospace", color: t.dim }}>{v.sequence}</span>
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{v.value}</span>
                  <span style={{ fontWeight: 600, color: t.heading }}>{v.displayValue}</span>
                  <span style={{ color: v.isActive ? "#22C55E" : t.dim, fontWeight: 600 }}>{v.isActive ? "Active" : "Inactive"}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </PageShell>
  );
}

function InfoField({ label, value, t, mono }: { label: string; value: string; t: ReturnType<typeof tokens>; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: t.heading, marginTop: 2, fontFamily: mono ? "ui-monospace, monospace" : "inherit" }}>{value || "—"}</div>
    </div>
  );
}
