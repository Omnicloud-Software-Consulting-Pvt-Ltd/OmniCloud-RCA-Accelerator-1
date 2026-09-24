"use client";

import { useEffect, useMemo, useState } from "react";
import { Ic, tokens, inputStyle, PageShell, Spinner, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { loadSession } from "@/lib/auth/session";
import { toCreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import type { AttributeDetail, AttributePicklistValueRow, AttributeProductConfig } from "@/lib/attributes/types";

interface EditFields {
  name: string;
  description: string;
  isActive: boolean;
  dataType: string;
  /** AttributeDefinition.DefaultValue — the attribute's own configured value. */
  defaultValue: string;
}

/** Editable copy of one ProductAttributeDefinition's configuration — all strings, "" = blank. */
interface EditableConfig {
  id: string;
  productName: string | null;
  defaultValue: string;
  minimumValue: string;
  maximumValue: string;
  stepValue: string;
}

const CONFIG_KEYS = ["defaultValue", "minimumValue", "maximumValue", "stepValue"] as const;
type ConfigKey = typeof CONFIG_KEYS[number];
const CONFIG_FIELD: Record<ConfigKey, string> = { defaultValue: "DefaultValue", minimumValue: "MinimumValue", maximumValue: "MaximumValue", stepValue: "StepValue" };
const CONFIG_LABEL: Record<ConfigKey, string> = { defaultValue: "Default", minimumValue: "Min", maximumValue: "Max", stepValue: "Step" };

function toEditableConfig(c: AttributeProductConfig): EditableConfig {
  return {
    id: c.id, productName: c.productName,
    defaultValue: c.defaultValue ?? "", minimumValue: c.minimumValue ?? "", maximumValue: c.maximumValue ?? "", stepValue: c.stepValue ?? "",
  };
}

/** Only the fields that differ from what Salesforce currently holds, per ProductAttributeDefinition. */
function configPatches(original: AttributeDetail, configs: EditableConfig[]) {
  const patches: ({ id: string } & Partial<Record<ConfigKey, string>>)[] = [];
  for (const c of configs) {
    const o = original.productConfigs.find(x => x.id === c.id);
    if (!o) continue;
    const patch: { id: string } & Partial<Record<ConfigKey, string>> = { id: c.id };
    for (const k of CONFIG_KEYS) if (c[k] !== (o[k] ?? "")) patch[k] = c[k];
    if (Object.keys(patch).length > 1) patches.push(patch);
  }
  return patches;
}

interface EditableValue extends AttributePicklistValueRow {
  status: "existing" | "pendingAdd" | "pendingRemove";
  /** Working display text — diffed against the original row's displayValue to detect a rename. */
  editedDisplayValue: string;
}

function toFields(a: AttributeDetail): EditFields {
  return { name: a.name, description: a.description ?? "", isActive: a.isActive, dataType: a.dataType ?? "", defaultValue: a.defaultValue ?? "" };
}

interface Changes {
  modified: string[];
  added: string[];
  removed: string[];
  renamed: { from: string; to: string }[];
}

function computeChanges(original: AttributeDetail, fields: EditFields, values: EditableValue[], configs: EditableConfig[]): Changes {
  const modified: string[] = [];
  if (fields.defaultValue !== (original.defaultValue ?? "")) modified.push("Default Value");
  for (const p of configPatches(original, configs)) {
    const name = configs.find(c => c.id === p.id)?.productName ?? p.id;
    modified.push(`${name} configuration`);
  }
  if (fields.name !== original.name) modified.push("Attribute Name");
  if (fields.description !== (original.description ?? "")) modified.push("Description");
  if (fields.isActive !== original.isActive) modified.push("Status");
  if (fields.dataType !== (original.dataType ?? "")) modified.push("Data Type");

  const added = values.filter(v => v.status === "pendingAdd").map(v => v.editedDisplayValue);
  const removed = values.filter(v => v.status === "pendingRemove").map(v => v.displayValue);
  const renamed = values
    .filter(v => v.status === "existing" && v.editedDisplayValue !== v.displayValue)
    .map(v => ({ from: v.displayValue, to: v.editedDisplayValue }));

  return { modified, added, removed, renamed };
}

function hasAnyChanges(c: Changes): boolean {
  return c.modified.length > 0 || c.added.length > 0 || c.removed.length > 0 || c.renamed.length > 0;
}

/**
 * Edit Attribute — the task's "critical requirement." Loads the attribute's
 * CURRENT Salesforce configuration (never a blank Create form), lets the
 * user edit Name/Description/Status/Data Type (only if this org's schema
 * allows changing it — see AttributeDetail.dataTypeEditable) and manage
 * picklist values (add / rename / remove-with-confirmation), shows a
 * Modified/Added/Removed change summary, and guards navigation away with
 * unsaved changes. Save sends only what changed to PATCH
 * /api/sf/attributes/[id], which always updates the existing
 * AttributeDefinition — never creates a duplicate.
 */
export default function AttributeEditWorkspace({ isDark, attributeId, onCancel, onSaved }: {
  isDark: boolean; attributeId: string; onCancel: () => void; onSaved: () => void;
}) {
  const t = tokens(isDark);
  const notifySalesforceSuccess = useSalesforceSuccess();

  const [original, setOriginal] = useState<AttributeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ErrorPanelDataLike | null>(null);

  const [fields, setFields] = useState<EditFields | null>(null);
  const [values, setValues] = useState<EditableValue[]>([]);
  const [configs, setConfigs] = useState<EditableConfig[]>([]);
  const [newValueText, setNewValueText] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [addValueError, setAddValueError] = useState<string | null>(null);
  const [showChangesPanel, setShowChangesPanel] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<EditableValue | null>(null);

  /** Applies a fresh, canonical Salesforce read into local state — the ONLY thing that decides what's shown, never an optimistic guess. Reused for the initial load and for re-syncing after a save. */
  const applyAttribute = (attribute: AttributeDetail) => {
    setOriginal(attribute);
    setFields(toFields(attribute));
    setConfigs(attribute.productConfigs.map(toEditableConfig));
    setValues(
      attribute.picklistValues
        .filter(v => v.isActive !== false)
        .map(v => ({ ...v, status: "existing" as const, editedDisplayValue: v.displayValue })),
    );
  };

  useEffect(() => {
    quoteApiGet<{ success: true; attribute: AttributeDetail }>("Load attribute", `/api/sf/attributes/${attributeId}`)
      .then(res => applyAttribute(res.attribute))
      .catch(err => setLoadError(toErrorPanelData(err, "Could not load this attribute")))
      .finally(() => setLoading(false));
  }, [attributeId]);

  const changes = useMemo(
    () => (original && fields ? computeChanges(original, fields, values, configs) : { modified: [], added: [], removed: [], renamed: [] }),
    [original, fields, values, configs],
  );
  const dirty = hasAnyChanges(changes);

  const setField = <K extends keyof EditFields>(key: K, value: EditFields[K]) => {
    setFields(prev => prev ? { ...prev, [key]: value } : prev);
  };

  const handleAddValue = () => {
    const text = newValueText.trim();
    if (!text) return;
    setAddValueError(null);
    const key = text.toLowerCase();
    const isDuplicate = values.some(v => v.status !== "pendingRemove" && (v.editedDisplayValue.trim().toLowerCase() === key || v.value.trim().toLowerCase() === key));
    if (isDuplicate) {
      setAddValueError(`"${text}" already exists on this attribute.`);
      return;
    }
    const maxSeq = values.reduce((m, v) => Math.max(m, v.sequence), 0);
    setValues(prev => [...prev, {
      id: `pending-${Date.now()}-${text}`, value: text, displayValue: text, sequence: maxSeq + 1, isActive: true,
      status: "pendingAdd", editedDisplayValue: text,
    }]);
    setNewValueText("");
  };

  const handleConfirmRemove = () => {
    if (!confirmRemove) return;
    setValues(prev => {
      if (confirmRemove.status === "pendingAdd") return prev.filter(v => v.id !== confirmRemove.id);
      return prev.map(v => v.id === confirmRemove.id ? { ...v, status: "pendingRemove" as const } : v);
    });
    setConfirmRemove(null);
  };

  const handleUndoRemove = (id: string) => {
    setValues(prev => prev.map(v => v.id === id ? { ...v, status: "existing" as const } : v));
  };

  const handleRenameValue = (id: string, text: string) => {
    setValues(prev => prev.map(v => v.id === id ? { ...v, editedDisplayValue: text } : v));
  };

  const handleSave = async () => {
    if (!original || !fields || !dirty) return;
    setSaving(true);
    setSaveError(null);
    setSaveWarning(null);

    const patch: Record<string, unknown> = {};
    if (fields.name !== original.name) patch.name = fields.name;
    if (fields.description !== (original.description ?? "")) patch.description = fields.description;
    if (fields.isActive !== original.isActive) patch.isActive = fields.isActive;
    if (fields.dataType !== (original.dataType ?? "") && original.dataTypeEditable) patch.dataType = fields.dataType;
    if (fields.defaultValue !== (original.defaultValue ?? "")) patch.defaultValue = fields.defaultValue.trim();
    const productConfigs = configPatches(original, configs);

    const addValues = values.filter(v => v.status === "pendingAdd").map(v => v.editedDisplayValue);
    const removeValueIds = values.filter(v => v.status === "pendingRemove" && !v.id.startsWith("pending-")).map(v => v.id);
    const updateValues = values
      .filter(v => v.status === "existing" && v.editedDisplayValue !== v.displayValue)
      .map(v => ({ id: v.id, displayValue: v.editedDisplayValue }));

    try {
      const res = await fetch(`/api/sf/attributes/${attributeId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: Object.keys(patch).length ? patch : undefined, addValues, removeValueIds, updateValues, productConfigs }),
      });
      const data: {
        success: boolean;
        errors?: { step: string; error: string }[];
        skipped?: { step: string; reason: string }[];
        attribute?: AttributeDetail | null;
      } = await res.json();

      // A partial/failed save still returns the CANONICAL post-attempt
      // Salesforce state (whatever actually landed) — always re-sync the
      // form to it so the user is never looking at stale optimistic state
      // that doesn't match what's really in Salesforce.
      if (data.attribute) applyAttribute(data.attribute);

      // Success is ONLY what the server confirmed by reading every written record back from
      // Salesforce — a non-2xx, success:false, or a missing canonical read is never shown as saved.
      if (!res.ok || !data.success) {
        const detail = data.errors?.length
          ? data.errors.map(e => e.error).join(" • ")
          : "Salesforce rejected one or more of these changes.";
        setSaveError(detail);
        return;
      }

      if (data.skipped?.length) {
        setSaveWarning(data.skipped.map(s => s.reason).join(" • "));
      }

      const instanceUrl = loadSession()?.instanceUrl;
      if (instanceUrl) {
        const record = toCreatedSalesforceRecord(instanceUrl, "AttributeDefinition", attributeId, fields.name);
        notifySalesforceSuccess({
          title: "Attribute Updated Successfully",
          message: `${record.recordName} was updated and verified in Salesforce.`,
          records: [record],
        });
      }
      onSaved();
    } catch {
      setSaveError("Network error — could not reach Salesforce. Your changes were not saved — please try again.");
    } finally {
      setSaving(false);
    }
  };

  const requestLeave = () => { if (dirty) setConfirmLeave(true); else onCancel(); };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: t.dim }}><Spinner isDark={isDark} /> Loading attribute…</div>
      </div>
    );
  }

  if (loadError || !original || !fields) {
    return (
      <div style={{ padding: 24 }}>
        <ErrorPanel isDark={isDark} error={loadError ?? { title: "Could not load this attribute", message: "Unknown error" }} />
        <div style={{ marginTop: 12 }}><GhostButton label="Back to Attribute History" icon="arrow-left" isDark={isDark} onClick={onCancel} /></div>
      </div>
    );
  }

  const header = (
    <div style={{ padding: "20px 24px 0", flexShrink: 0 }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Ic n="edit" s={16} />
            <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Edit Attribute</h2>
            {dirty && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 999, color: "#F59E0B", border: "1px solid #F59E0B55" }}>UNSAVED CHANGES</span>}
          </div>
          <p style={{ fontSize: 12, color: t.dim, marginTop: 4 }}>{original.name} — editing the existing Salesforce attribute, not creating a new one.</p>
        </div>
        <GhostButton label="Cancel" icon="x" isDark={isDark} onClick={requestLeave} />
      </div>
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24, maxWidth: 900 }}>

        {saveError && <ErrorPanel isDark={isDark} error={{ title: "Could not save attribute changes", message: saveError }} />}
        {saveWarning && !saveError && (
          <div className="flex items-start gap-2" style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #F59E0B55", background: "rgba(245,158,11,0.08)", fontSize: 12, color: "#F59E0B" }}>
            <Ic n="alert" s={14} /> <span>{saveWarning}</span>
          </div>
        )}

        {/* Basic Information */}
        <section>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 12 }}>Basic Information</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
            <EditField label="Attribute Name" value={fields.name} onChange={v => setField("name", v)} t={t} />
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>Data Type</span>
              {original.dataTypeEditable && original.validDataTypes.length > 0 ? (
                <select value={fields.dataType} onChange={e => setField("dataType", e.target.value)} style={inputStyle(t)}>
                  {original.validDataTypes.map(dt => <option key={dt} value={dt}>{dt}</option>)}
                </select>
              ) : (
                <>
                  <input value={fields.dataType} disabled style={{ ...inputStyle(t), opacity: 0.6, cursor: "not-allowed" }} />
                  <span style={{ fontSize: 10.5, color: t.dim }}>This org does not allow changing an existing attribute&apos;s data type.</span>
                </>
              )}
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>Status</span>
              <div className="flex gap-2">
                {["Active", "Inactive"].map(v => (
                  <button key={v} onClick={() => setField("isActive", v === "Active")}
                    style={{
                      flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
                      background: (fields.isActive ? "Active" : "Inactive") === v ? `${t.accent}1E` : "transparent",
                      border: `1px solid ${(fields.isActive ? "Active" : "Inactive") === v ? t.accent + "60" : t.border}`,
                      color: (fields.isActive ? "Active" : "Inactive") === v ? t.accent : t.dim,
                    }}>{v}</button>
                ))}
              </div>
            </label>
            <InfoStatic label="API Name" value={original.apiName ?? "—"} t={t} />
            {!original.isPicklist && original.defaultValueEditable && (
              (fields.dataType ?? "").toLowerCase() === "checkbox" ? (
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>Default Value</span>
                  <select value={fields.defaultValue} onChange={e => setField("defaultValue", e.target.value)} style={inputStyle(t)}>
                    <option value="">— none —</option><option value="true">true</option><option value="false">false</option>
                  </select>
                </label>
              ) : (
                <EditField label="Default Value" value={fields.defaultValue} onChange={v => setField("defaultValue", v)} t={t} />
              )
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={{ display: "block", fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, marginBottom: 6 }}>Description</label>
            <textarea value={fields.description} onChange={e => setField("description", e.target.value)} rows={2} style={{ ...inputStyle(t), resize: "vertical" }} />
          </div>
        </section>

        {/* Picklist values */}
        {original.isPicklist && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim }}>
                Picklist Values ({values.filter(v => v.status !== "pendingRemove").length})
              </p>
            </div>

            {original.picklistSharedCount > 1 && (
              <p style={{ fontSize: 11.5, color: "#F59E0B", marginBottom: 10 }}>
                This picklist is shared by {original.picklistSharedCount} attributes — changing its values changes them for all of them.
              </p>
            )}
            <div style={{ display: "flex", gap: 8, marginBottom: addValueError ? 6 : 12 }}>
              <input
                value={newValueText}
                onChange={e => { setNewValueText(e.target.value); if (addValueError) setAddValueError(null); }}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleAddValue(); } }}
                placeholder="New picklist value…"
                style={{ ...inputStyle(t), flex: 1 }}
              />
              <button onClick={handleAddValue} disabled={!newValueText.trim()}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: newValueText.trim() ? "pointer" : "not-allowed", color: t.accent, border: `1px solid ${t.accent}55`, background: "transparent", opacity: newValueText.trim() ? 1 : 0.5 }}>
                <Ic n="plus" s={13} /> Add Value
              </button>
            </div>
            {addValueError && (
              <p style={{ fontSize: 11.5, color: "#FF4066", marginBottom: 12 }}>{addValueError}</p>
            )}

            {confirmRemove && (
              <div style={{ marginBottom: 12, padding: 14, borderRadius: 10, border: "1px solid #FF406655", background: "rgba(255,64,102,0.06)" }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: t.heading, marginBottom: 10 }}>Remove &quot;{confirmRemove.displayValue}&quot; from this attribute?</p>
                <div className="flex gap-2">
                  <GhostButton label="Cancel" isDark={isDark} onClick={() => setConfirmRemove(null)} />
                  <button onClick={handleConfirmRemove} style={{ padding: "8px 16px", borderRadius: 9, border: "none", background: "#FF4066", color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    Remove Value
                  </button>
                </div>
              </div>
            )}

            <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "0.5fr 2fr 0.9fr", padding: "9px 14px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
                <span>Seq</span><span>Display Value</span><span>Actions</span>
              </div>
              {values.length === 0 && <div style={{ padding: 16, fontSize: 12, color: t.dim }}>No picklist values yet.</div>}
              {values.map((v, i) => {
                const removed = v.status === "pendingRemove";
                return (
                  <div key={v.id} style={{ display: "grid", gridTemplateColumns: "0.5fr 2fr 0.9fr", padding: "9px 14px", borderTop: i > 0 ? `1px solid ${t.border}` : undefined, fontSize: 12, color: t.body, alignItems: "center", opacity: removed ? 0.55 : 1 }}>
                    <span style={{ fontFamily: "ui-monospace, monospace", color: t.dim }}>{v.sequence}</span>
                    {removed ? (
                      <span style={{ fontWeight: 600, color: t.heading, textDecoration: "line-through" }}>{v.displayValue}</span>
                    ) : (
                      <input
                        value={v.editedDisplayValue}
                        onChange={e => handleRenameValue(v.id, e.target.value)}
                        style={{ ...inputStyle(t), padding: "6px 10px", fontWeight: v.status === "pendingAdd" ? 700 : 500 }}
                      />
                    )}
                    <span className="flex items-center gap-2">
                      {v.status === "pendingAdd" && <span style={{ fontSize: 9, color: "#22C55E" }}>NEW</span>}
                      {removed ? (
                        <button onClick={() => handleUndoRemove(v.id)} style={{ fontSize: 11, fontWeight: 600, color: t.accent, background: "transparent", border: "none", cursor: "pointer" }}>Undo</button>
                      ) : (
                        <button onClick={() => setConfirmRemove(v)} title="Remove Value" style={{ color: "#FF4066", background: "transparent", border: "none", cursor: "pointer" }}><Ic n="x" s={13} /></button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Per-product configuration (ProductAttributeDefinition) */}
        {configs.length > 0 && original.productConfigFields.length > 0 && (
          <section>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 6 }}>
              Product Configuration ({configs.length})
            </p>
            <p style={{ fontSize: 11.5, color: t.dim, marginBottom: 10 }}>
              The value/range this attribute has on each product it&apos;s assigned to (Product Attribute Definition).
            </p>
            {(() => {
              const keys = CONFIG_KEYS.filter(k => original.productConfigFields.includes(CONFIG_FIELD[k]) && (k === "defaultValue" || ["number", "currency", "percent"].includes((original.dataType ?? "").toLowerCase())));
              const cols = `1.6fr ${keys.map(() => "1fr").join(" ")}`;
              return (
                <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden" }}>
                  <div style={{ display: "grid", gridTemplateColumns: cols, gap: 8, padding: "9px 14px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
                    <span>Product</span>{keys.map(k => <span key={k}>{CONFIG_LABEL[k]}</span>)}
                  </div>
                  {configs.map((c, i) => (
                    <div key={c.id} style={{ display: "grid", gridTemplateColumns: cols, gap: 8, padding: "8px 14px", borderTop: i > 0 ? `1px solid ${t.border}` : undefined, alignItems: "center", fontSize: 12, color: t.body }}>
                      <span style={{ fontWeight: 600, color: t.heading }}>{c.productName ?? c.id}</span>
                      {keys.map(k => (
                        <input key={k} value={c[k]}
                          onChange={e => setConfigs(prev => prev.map(x => x.id === c.id ? { ...x, [k]: e.target.value } : x))}
                          style={{ ...inputStyle(t), padding: "6px 8px" }} />
                      ))}
                    </div>
                  ))}
                </div>
              );
            })()}
          </section>
        )}

        {/* Change detection */}
        {dirty && (
          <section>
            <button onClick={() => setShowChangesPanel(v => !v)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, color: t.accent, background: "transparent", border: "none", cursor: "pointer", marginBottom: 10 }}>
              <Ic n={showChangesPanel ? "chevron-down" : "chevron-right"} s={12} /> Attribute Changes
            </button>
            {showChangesPanel && (
              <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, padding: 14, fontSize: 12.5, display: "flex", flexDirection: "column", gap: 8 }}>
                {changes.modified.length > 0 && (
                  <div><span style={{ color: t.dim, fontWeight: 700 }}>Modified:</span> {changes.modified.map(m => <span key={m} style={{ marginLeft: 6, color: "#F59E0B" }}>• {m}</span>)}</div>
                )}
                {changes.renamed.length > 0 && (
                  <div><span style={{ color: t.dim, fontWeight: 700 }}>Renamed:</span> {changes.renamed.map(r => <span key={`${r.from}-${r.to}`} style={{ marginLeft: 6, color: t.accentBlue }}>{r.from} → {r.to}</span>)}</div>
                )}
                {changes.added.length > 0 && (
                  <div><span style={{ color: t.dim, fontWeight: 700 }}>Added:</span> {changes.added.map(a => <span key={a} style={{ marginLeft: 6, color: "#22C55E" }}>+ {a}</span>)}</div>
                )}
                {changes.removed.length > 0 && (
                  <div><span style={{ color: t.dim, fontWeight: 700 }}>Removed:</span> {changes.removed.map(r => <span key={r} style={{ marginLeft: 6, color: "#FF4066" }}>− {r}</span>)}</div>
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
            {saving ? <><Spinner isDark={isDark} /> Deploying Changes…</> : <><Ic n="zap" s={14} /> Deploy Changes</>}
          </button>
          {!dirty && <span style={{ fontSize: 11.5, color: t.dim }}>No changes to save yet.</span>}
        </div>
      </div>

      {/* Unsaved changes guard */}
      {confirmLeave && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ width: 380, borderRadius: 14, background: t.surface, border: `1px solid ${t.border}`, padding: 20 }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: t.heading, marginBottom: 8 }}>Unsaved Changes</p>
            <p style={{ fontSize: 12.5, color: t.dim, marginBottom: 16 }}>You have unsaved attribute changes. Are you sure you want to leave?</p>
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

function EditField({ label, value, onChange, t }: { label: string; value: string; onChange: (v: string) => void; t: ReturnType<typeof tokens> }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>{label}</span>
      <input value={value} onChange={e => onChange(e.target.value)} style={inputStyle(t)} />
    </label>
  );
}

function InfoStatic({ label, value, t }: { label: string; value: string; t: ReturnType<typeof tokens> }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: t.heading, marginTop: 6, fontFamily: "ui-monospace, monospace" }}>{value}</div>
    </div>
  );
}
