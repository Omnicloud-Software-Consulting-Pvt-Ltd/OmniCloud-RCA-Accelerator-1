"use client";

import { useEffect, useMemo, useState } from "react";
import { Ic, tokens, inputStyle, PageShell, Spinner, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { loadSession } from "@/lib/auth/session";
import { toCreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import type { BundleDetail } from "@/lib/bundles/server/bundleDetail";
import type { BundleComponentRow } from "@/lib/bundles/server/relationships";
import type { CatalogProduct } from "@/lib/quotes/types";

interface EditFields {
  name: string; productCode: string; description: string; family: string;
  isActive: boolean; catalog: string; category: string; sellingModel: string;
  priceBook: string; basePrice: string; currencyIsoCode: string;
}

interface EditableComponent extends BundleComponentRow {
  status: "existing" | "pendingAdd" | "pendingRemove";
}

function toFields(b: BundleDetail): EditFields {
  return {
    name: b.name, productCode: b.productCode ?? "", description: b.description ?? "", family: b.family ?? "",
    isActive: b.isActive, catalog: b.catalog ?? "", category: b.category ?? "", sellingModel: b.sellingModel ?? "",
    priceBook: b.priceBook ?? "Standard Price Book", basePrice: b.basePrice ?? "", currencyIsoCode: b.currencyIsoCode ?? "",
  };
}

interface Changes {
  modified: string[];
  added: string[];
  removed: string[];
  requiredChanges: { name: string; isRequired: boolean }[];
}

function computeChanges(original: BundleDetail, fields: EditFields, components: EditableComponent[]): Changes {
  const modified: string[] = [];
  if (fields.name !== original.name) modified.push("Bundle Name");
  if (fields.productCode !== (original.productCode ?? "")) modified.push("Bundle Code");
  if (fields.description !== (original.description ?? "")) modified.push("Description");
  if (fields.family !== (original.family ?? "")) modified.push("Family");
  if (fields.isActive !== original.isActive) modified.push("Active Status");
  if (fields.catalog !== (original.catalog ?? "")) modified.push("Catalog");
  if (fields.category !== (original.category ?? "")) modified.push("Category");
  if (fields.sellingModel !== (original.sellingModel ?? "")) modified.push("Selling Model");
  if (fields.basePrice !== (original.basePrice ?? "")) modified.push("Price");

  const added = components.filter(c => c.status === "pendingAdd").map(c => c.childName);
  const removed = components.filter(c => c.status === "pendingRemove").map(c => c.childName);
  const requiredChanges = components
    .filter(c => c.status === "existing")
    .filter(c => {
      const orig = original.components.find(o => o.relationshipId === c.relationshipId);
      return !!orig && orig.isComponentRequired !== c.isComponentRequired;
    })
    .map(c => ({ name: c.childName, isRequired: c.isComponentRequired }));

  return { modified, added, removed, requiredChanges };
}

function hasAnyChanges(c: Changes): boolean {
  return c.modified.length > 0 || c.added.length > 0 || c.removed.length > 0 || c.requiredChanges.length > 0;
}

/**
 * Edit Bundle — Bundle History's most important new capability. Loads the
 * bundle's CURRENT Salesforce structure (never a blank form), lets the
 * user edit basic fields, add/remove/replace components via the existing
 * product search (/api/quotes/products/search, the same lookup Quotes'
 * "+ Add Line Item" uses), and toggle each component's Required/Optional
 * flag — the one dependency-style signal this org's ProductRelatedComponent
 * rows actually persist (this org's AI-planned REQUIRES/DEPENDS_ON rules
 * flatten into plain components at Create Bundle time; Salesforce keeps no
 * distinct "X requires Y" edge afterward, so Edit Bundle never pretends to
 * offer one). Save sends only the fields/components that actually changed
 * to PATCH /api/bundles/[id], which always updates the existing record —
 * never creates a new bundle.
 */
export default function BundleEditWorkspace({ isDark, bundleId, onCancel, onSaved }: {
  isDark: boolean; bundleId: string; onCancel: () => void; onSaved: () => void;
}) {
  const t = tokens(isDark);
  const notifySalesforceSuccess = useSalesforceSuccess();

  const [original, setOriginal] = useState<BundleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ErrorPanelDataLike | null>(null);

  const [fields, setFields] = useState<EditFields | null>(null);
  const [components, setComponents] = useState<EditableComponent[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showChangesPanel, setShowChangesPanel] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const [confirmRemove, setConfirmRemove] = useState<EditableComponent | null>(null);
  const [searchMode, setSearchMode] = useState<"add" | { replacing: EditableComponent } | null>(null);
  const [pricebookId, setPricebookId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<CatalogProduct[]>([]);

  useEffect(() => {
    quoteApiGet<{ success: true; bundle: BundleDetail }>("Load bundle", `/api/bundles/${bundleId}`)
      .then(res => {
        setOriginal(res.bundle);
        setFields(toFields(res.bundle));
        setComponents(res.bundle.components.map(c => ({ ...c, status: "existing" as const })));
      })
      .catch(err => setLoadError(toErrorPanelData(err, "Could not load this bundle")))
      .finally(() => setLoading(false));
  }, [bundleId]);

  useEffect(() => {
    quoteApiGet<{ success: true; pricebookId: string }>("Load pricebook", "/api/bundles/pricebook")
      .then(res => setPricebookId(res.pricebookId))
      .catch(() => setPricebookId(null));
  }, []);

  useEffect(() => {
    if (!searchMode || !pricebookId) return;
    const handle = setTimeout(() => {
      setSearching(true);
      fetch("/api/quotes/products/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pricebookId, searchTerm }),
      })
        .then(res => res.json())
        .then(data => setSearchResults(data.success ? data.products : []))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [searchMode, searchTerm, pricebookId]);

  const changes = useMemo(() => (original && fields ? computeChanges(original, fields, components) : { modified: [], added: [], removed: [], requiredChanges: [] }), [original, fields, components]);
  const dirty = hasAnyChanges(changes);
  const includedProductIds = new Set(components.filter(c => c.status !== "pendingRemove").map(c => c.childProductId));

  const setField = <K extends keyof EditFields>(key: K, value: EditFields[K]) => {
    setFields(prev => prev ? { ...prev, [key]: value } : prev);
  };

  const handleAddProduct = (product: CatalogProduct) => {
    const maxSeq = components.reduce((m, c) => Math.max(m, c.sequence), 0);
    const newComponent: EditableComponent = {
      relationshipId: `pending-${product.id}`,
      childProductId: product.id,
      childName: product.name,
      childProductCode: product.productCode,
      childType: null,
      childPrice: product.listPrice,
      childSellingModel: null,
      sequence: maxSeq + 1,
      isDefaultComponent: true,
      isComponentRequired: true,
      relationshipTypeId: null,
      status: "pendingAdd",
    };
    if (searchMode && typeof searchMode === "object" && searchMode.replacing) {
      const target = searchMode.replacing;
      setComponents(prev => [
        ...prev.map(c => c.relationshipId === target.relationshipId ? { ...c, status: "pendingRemove" as const } : c),
        newComponent,
      ]);
    } else {
      setComponents(prev => [...prev, newComponent]);
    }
    setSearchMode(null);
    setSearchTerm("");
    setSearchResults([]);
  };

  const handleConfirmRemove = () => {
    if (!confirmRemove) return;
    setComponents(prev => {
      if (confirmRemove.status === "pendingAdd") return prev.filter(c => c.relationshipId !== confirmRemove.relationshipId);
      return prev.map(c => c.relationshipId === confirmRemove.relationshipId ? { ...c, status: "pendingRemove" as const } : c);
    });
    setConfirmRemove(null);
  };

  const handleUndoRemove = (relationshipId: string) => {
    setComponents(prev => prev.map(c => c.relationshipId === relationshipId ? { ...c, status: "existing" as const } : c));
  };

  const toggleRequired = (relationshipId: string) => {
    setComponents(prev => prev.map(c => c.relationshipId === relationshipId ? { ...c, isComponentRequired: !c.isComponentRequired } : c));
  };

  const handleSave = async () => {
    if (!original || !fields || !dirty) return;
    setSaving(true);
    setSaveError(null);

    const patch: Record<string, unknown> = {};
    if (fields.name !== original.name) patch.name = fields.name;
    if (fields.productCode !== (original.productCode ?? "")) patch.productCode = fields.productCode;
    if (fields.description !== (original.description ?? "")) patch.description = fields.description;
    if (fields.family !== (original.family ?? "")) patch.family = fields.family;
    if (fields.isActive !== original.isActive) patch.isActive = fields.isActive;
    if (fields.catalog !== (original.catalog ?? "")) patch.catalog = fields.catalog;
    if (fields.category !== (original.category ?? "")) patch.category = fields.category;
    if (fields.sellingModel !== (original.sellingModel ?? "")) patch.sellingModel = fields.sellingModel;
    if (fields.basePrice !== (original.basePrice ?? "")) { patch.basePrice = fields.basePrice; patch.priceBook = fields.priceBook; }

    const addProductIds = components.filter(c => c.status === "pendingAdd").map(c => c.childProductId);
    const removeRelationshipIds = components.filter(c => c.status === "pendingRemove").map(c => c.relationshipId);
    const requiredUpdates = changes.requiredChanges.map(rc => {
      const comp = components.find(c => c.childName === rc.name && c.status === "existing")!;
      return { relationshipId: comp.relationshipId, isRequired: rc.isRequired };
    });

    try {
      const res = await fetch(`/api/bundles/${bundleId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch, addProductIds, removeRelationshipIds, requiredUpdates }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setSaveError(data.error ?? "Failed to save bundle changes.");
        return;
      }
      const instanceUrl = loadSession()?.instanceUrl;
      if (instanceUrl) {
        const record = toCreatedSalesforceRecord(instanceUrl, "Product2", bundleId, fields.name);
        notifySalesforceSuccess({
          title: "Bundle Updated Successfully",
          message: `${record.recordName} has been successfully updated in Salesforce.`,
          records: [record],
        });
      }
      onSaved();
    } catch {
      setSaveError("Network error — could not reach Salesforce.");
    } finally {
      setSaving(false);
    }
  };

  const requestLeave = () => { if (dirty) setConfirmLeave(true); else onCancel(); };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: t.dim }}><Spinner isDark={isDark} /> Loading bundle…</div>
      </div>
    );
  }

  if (loadError || !original || !fields) {
    return (
      <div style={{ padding: 24 }}>
        <ErrorPanel isDark={isDark} error={loadError ?? { title: "Could not load this bundle", message: "Unknown error" }} />
        <div style={{ marginTop: 12 }}><GhostButton label="Back to Bundle History" icon="arrow-left" isDark={isDark} onClick={onCancel} /></div>
      </div>
    );
  }

  const visibleComponents = components; // all statuses shown — pendingRemove rendered struck-through instead of hidden

  const header = (
    <div style={{ padding: "20px 24px 0", flexShrink: 0 }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Ic n="edit" s={16} />
            <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Edit Bundle</h2>
            {dirty && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 999, color: "#F59E0B", border: "1px solid #F59E0B55" }}>UNSAVED CHANGES</span>}
          </div>
          <p style={{ fontSize: 12, color: t.dim, marginTop: 4 }}>{original.name} — editing the existing Salesforce bundle, not creating a new one.</p>
        </div>
        <GhostButton label="Cancel" icon="x" isDark={isDark} onClick={requestLeave} />
      </div>
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24, maxWidth: 980 }}>

        {saveError && <ErrorPanel isDark={isDark} error={{ title: "Could not save bundle changes", message: saveError }} />}

        {/* Basic Information */}
        <section>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 12 }}>Basic Information</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
            <EditField label="Bundle Name" value={fields.name} onChange={v => setField("name", v)} t={t} />
            <EditField label="Bundle Code" value={fields.productCode} onChange={v => setField("productCode", v)} t={t} mono />
            <EditField label="Family" value={fields.family} onChange={v => setField("family", v)} t={t} />
            <EditField label="Catalog" value={fields.catalog} onChange={v => setField("catalog", v)} t={t} />
            <EditField label="Category" value={fields.category} onChange={v => setField("category", v)} t={t} />
            <EditField label="Selling Model" value={fields.sellingModel} onChange={v => setField("sellingModel", v)} t={t} />
            <EditField label="Price Book" value={fields.priceBook} onChange={v => setField("priceBook", v)} t={t} />
            <EditField label="Price" value={fields.basePrice} onChange={v => setField("basePrice", v)} t={t} type="number" />
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>Active</span>
              <div className="flex gap-2">
                {["Yes", "No"].map(v => (
                  <button key={v} onClick={() => setField("isActive", v === "Yes")}
                    style={{
                      flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
                      background: (fields.isActive ? "Yes" : "No") === v ? `${t.accent}1E` : "transparent",
                      border: `1px solid ${(fields.isActive ? "Yes" : "No") === v ? t.accent + "60" : t.border}`,
                      color: (fields.isActive ? "Yes" : "No") === v ? t.accent : t.dim,
                    }}>{v}</button>
                ))}
              </div>
            </label>
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={{ display: "block", fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, marginBottom: 6 }}>Description</label>
            <textarea value={fields.description} onChange={e => setField("description", e.target.value)} rows={2} style={{ ...inputStyle(t), resize: "vertical" }} />
          </div>
        </section>

        {/* Structure preview */}
        <section>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 12 }}>Bundle Structure</p>
          <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, background: isDark ? "rgba(2,6,18,0.85)" : "rgba(228,238,255,0.95)", padding: 16, fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 2 }}>
            <div style={{ color: t.accentBlue, fontWeight: 700 }}>{fields.name || original.name}</div>
            {visibleComponents.length === 0 ? (
              <div style={{ color: t.dim, marginLeft: 16 }}>(no components)</div>
            ) : visibleComponents.map((c, i) => {
              const isLast = i === visibleComponents.length - 1;
              const removed = c.status === "pendingRemove";
              return (
                <div key={c.relationshipId} style={{ marginLeft: 16, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", opacity: removed ? 0.5 : 1 }}>
                  <span style={{ color: t.dim }}>{isLast ? "└── " : "├── "}</span>
                  <span style={{ color: t.body, fontWeight: 600, textDecoration: removed ? "line-through" : "none" }}>{c.childName}</span>
                  {c.status === "pendingAdd" && <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 999, color: "#22C55E", border: "1px solid #22C55E55" }}>+ NEW</span>}
                  {removed && <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 999, color: "#FF4066", border: "1px solid #FF406655" }}>− REMOVING</span>}
                  {c.status === "existing" && (
                    <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 999, color: c.isComponentRequired ? t.accentBlue : t.dim, border: `1px solid ${c.isComponentRequired ? t.accentBlue + "55" : t.border}` }}>
                      {c.isComponentRequired ? "REQUIRED" : "OPTIONAL"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Components management */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim }}>Bundle Components ({components.filter(c => c.status !== "pendingRemove").length})</p>
            <button onClick={() => setSearchMode("add")}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer", color: t.accent, border: `1px solid ${t.accent}55`, background: "transparent" }}>
              <Ic n="plus" s={13} /> Add Product
            </button>
          </div>

          {searchMode && (
            <div style={{ marginBottom: 12, padding: 14, borderRadius: 10, border: `1px solid ${t.borderBright}`, background: t.surface }}>
              <div className="flex items-center justify-between mb-2">
                <span style={{ fontSize: 11.5, fontWeight: 700, color: t.heading }}>
                  {typeof searchMode === "object" ? `Replace "${searchMode.replacing.childName}" with…` : "Search products to add"}
                </span>
                <button onClick={() => { setSearchMode(null); setSearchTerm(""); }} style={{ color: t.dim, background: "transparent", border: "none", cursor: "pointer" }}><Ic n="x" s={14} /></button>
              </div>
              <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Search by product name or code…" autoFocus style={inputStyle(t)} />
              <div style={{ marginTop: 8, maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                {searching && <div className="flex items-center gap-2" style={{ fontSize: 11.5, color: t.dim, padding: 8 }}><Spinner isDark={isDark} /> Searching…</div>}
                {!searching && searchResults.filter(p => !includedProductIds.has(p.id)).map(p => (
                  <button key={p.id} onClick={() => handleAddProduct(p)}
                    className="flex items-center justify-between gap-2"
                    style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${t.border}`, background: "transparent", cursor: "pointer", textAlign: "left" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: t.heading }}>{p.name}</div>
                      <div style={{ fontSize: 10.5, color: t.dim }}>{p.productCode ?? "—"}{p.family ? ` · ${p.family}` : ""}</div>
                    </div>
                    <span style={{ fontSize: 11.5, fontFamily: "ui-monospace, monospace", color: t.accent, flexShrink: 0 }}>${p.listPrice.toLocaleString()}</span>
                  </button>
                ))}
                {!searching && searchResults.length > 0 && searchResults.every(p => includedProductIds.has(p.id)) && (
                  <p style={{ fontSize: 11, color: t.dim, padding: 8 }}>Every matching product is already in this bundle.</p>
                )}
              </div>
            </div>
          )}

          {confirmRemove && (
            <div style={{ marginBottom: 12, padding: 14, borderRadius: 10, border: "1px solid #FF406655", background: "rgba(255,64,102,0.06)" }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: t.heading, marginBottom: 10 }}>Remove {confirmRemove.childName} from this bundle?</p>
              <div className="flex gap-2">
                <GhostButton label="Cancel" isDark={isDark} onClick={() => setConfirmRemove(null)} />
                <button onClick={handleConfirmRemove} style={{ padding: "8px 16px", borderRadius: 9, border: "none", background: "#FF4066", color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  Remove Product
                </button>
              </div>
            </div>
          )}

          <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.5fr 0.9fr 0.9fr 0.8fr 1fr 1.2fr", padding: "9px 14px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
              <span>Product</span><span>Code</span><span>Selling Model</span><span>Price</span><span>Required</span><span>Actions</span>
            </div>
            {components.length === 0 && <div style={{ padding: 16, fontSize: 12, color: t.dim }}>No components in this bundle.</div>}
            {components.map((c, i) => {
              const removed = c.status === "pendingRemove";
              return (
                <div key={c.relationshipId} style={{ display: "grid", gridTemplateColumns: "1.5fr 0.9fr 0.9fr 0.8fr 1fr 1.2fr", padding: "9px 14px", borderTop: i > 0 ? `1px solid ${t.border}` : undefined, fontSize: 12, color: t.body, alignItems: "center", opacity: removed ? 0.55 : 1 }}>
                  <span style={{ fontWeight: 600, color: t.heading, textDecoration: removed ? "line-through" : "none" }}>
                    {c.childName} {c.status === "pendingAdd" && <span style={{ fontSize: 9, color: "#22C55E" }}>(new)</span>}
                  </span>
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: t.dim }}>{c.childProductCode ?? "—"}</span>
                  <span>{c.childSellingModel ?? "—"}</span>
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>{c.childPrice != null ? `$${c.childPrice.toLocaleString()}` : "—"}</span>
                  <span>
                    {!removed && c.status !== "pendingAdd" && (
                      <button onClick={() => toggleRequired(c.relationshipId)}
                        style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 999, cursor: "pointer", color: c.isComponentRequired ? t.accentBlue : t.dim, border: `1px solid ${c.isComponentRequired ? t.accentBlue + "55" : t.border}`, background: "transparent" }}>
                        {c.isComponentRequired ? "Required" : "Optional"}
                      </button>
                    )}
                    {(removed || c.status === "pendingAdd") && <span style={{ color: t.dim }}>—</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    {removed ? (
                      <button onClick={() => handleUndoRemove(c.relationshipId)} style={{ fontSize: 11, fontWeight: 600, color: t.accent, background: "transparent", border: "none", cursor: "pointer" }}>Undo</button>
                    ) : (
                      <>
                        <button onClick={() => setSearchMode({ replacing: c })} title="Replace Product" style={{ color: t.dim, background: "transparent", border: "none", cursor: "pointer" }}><Ic n="refresh" s={13} /></button>
                        <button onClick={() => setConfirmRemove(c)} title="Remove Product" style={{ color: "#FF4066", background: "transparent", border: "none", cursor: "pointer" }}><Ic n="trash" s={13} /></button>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Change detection */}
        {dirty && (
          <section>
            <button onClick={() => setShowChangesPanel(v => !v)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, color: t.accent, background: "transparent", border: "none", cursor: "pointer", marginBottom: 10 }}>
              <Ic n={showChangesPanel ? "chevron-down" : "chevron-right"} s={12} /> Bundle Changes
            </button>
            {showChangesPanel && (
              <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, padding: 14, fontSize: 12.5, display: "flex", flexDirection: "column", gap: 8 }}>
                {changes.modified.length > 0 && (
                  <div><span style={{ color: t.dim, fontWeight: 700 }}>Modified:</span> {changes.modified.map(m => <span key={m} style={{ marginLeft: 6, color: "#F59E0B" }}>• {m}</span>)}</div>
                )}
                {changes.added.length > 0 && (
                  <div><span style={{ color: t.dim, fontWeight: 700 }}>Added:</span> {changes.added.map(a => <span key={a} style={{ marginLeft: 6, color: "#22C55E" }}>+ {a}</span>)}</div>
                )}
                {changes.removed.length > 0 && (
                  <div><span style={{ color: t.dim, fontWeight: 700 }}>Removed:</span> {changes.removed.map(r => <span key={r} style={{ marginLeft: 6, color: "#FF4066" }}>− {r}</span>)}</div>
                )}
                {changes.requiredChanges.length > 0 && (
                  <div><span style={{ color: t.dim, fontWeight: 700 }}>Required/Optional:</span> {changes.requiredChanges.map(rc => <span key={rc.name} style={{ marginLeft: 6, color: t.accentBlue }}>{rc.name} → {rc.isRequired ? "Required" : "Optional"}</span>)}</div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            style={{
              display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 10, border: "none",
              fontSize: 13, fontWeight: 700, color: "#04101F", cursor: !dirty || saving ? "not-allowed" : "pointer",
              background: !dirty || saving ? t.dim : `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})`, opacity: !dirty || saving ? 0.5 : 1,
            }}>
            {saving ? <><Spinner isDark={isDark} /> Saving…</> : <><Ic n="save" s={14} /> Save Changes</>}
          </button>
          {!dirty && <span style={{ fontSize: 11.5, color: t.dim }}>No changes to save yet.</span>}
        </div>
      </div>

      {/* Unsaved changes guard */}
      {confirmLeave && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ width: 380, borderRadius: 14, background: t.surface, border: `1px solid ${t.border}`, padding: 20 }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: t.heading, marginBottom: 8 }}>Unsaved Changes</p>
            <p style={{ fontSize: 12.5, color: t.dim, marginBottom: 16 }}>You have unsaved bundle changes. Are you sure you want to leave?</p>
            <div className="flex justify-end gap-2">
              <GhostButton label="Stay" isDark={isDark} onClick={() => setConfirmLeave(false)} />
              <button onClick={() => { setConfirmLeave(false); onCancel(); }} style={{ padding: "8px 16px", borderRadius: 9, border: "none", background: "#FF4066", color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                Discard Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}

function EditField({ label, value, onChange, t, mono, type }: {
  label: string; value: string; onChange: (v: string) => void; t: ReturnType<typeof tokens>; mono?: boolean; type?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>{label}</span>
      <input value={value} onChange={e => onChange(e.target.value)} type={type ?? "text"} style={{ ...inputStyle(t), fontFamily: mono ? "ui-monospace, monospace" : "inherit" }} />
    </label>
  );
}
