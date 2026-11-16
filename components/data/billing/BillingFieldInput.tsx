"use client";

import { useState, type CSSProperties } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle } from "@/components/data/quotes/shared";
import ReferenceLookup from "@/components/data/shared/ReferenceLookup";
import type { BillingFieldMeta, BillingReferenceValue } from "@/lib/billing/types";

export const BILLING_SEARCH_ENDPOINT = "/api/billing/reference/search";

/** Picklist options valid for the controlling field's current value (Describe `validFor` bitmask). */
function dependentOptions(field: BillingFieldMeta, controller: BillingFieldMeta | undefined, controllingValue: unknown): BillingFieldMeta["picklistValues"] {
  if (!field.controllerName || !controller || controllingValue === undefined || controllingValue === null || controllingValue === "") return field.picklistValues;
  const idx = controller.type === "boolean" ? (controllingValue ? 1 : 0) : controller.picklistValues.findIndex(p => p.value === controllingValue);
  if (idx < 0) return field.picklistValues;
  return field.picklistValues.filter(p => {
    if (!p.validFor) return true;
    const bytes = Uint8Array.from(atob(p.validFor), ch => ch.charCodeAt(0));
    const byte = Math.floor(idx / 8);
    return byte < bytes.length && (bytes[byte] & (1 << (7 - (idx % 8)))) !== 0;
  });
}

/** datetime-local ⇄ ISO, in the user's own timezone (the server never guesses a timezone). */
function isoToLocalInput(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BillingLookupInput({ isDark, field, value, onChange, unresolved }: {
  isDark: boolean;
  field: BillingFieldMeta;
  value: BillingReferenceValue | null;
  onChange: (v: BillingReferenceValue | null) => void;
  unresolved?: { searchedName: string; sobject: string; candidates: BillingReferenceValue[] };
}) {
  const t = tokens(isDark);
  const [target, setTarget] = useState(value?.sobject && field.referenceTo.includes(value.sobject) ? value.sobject : unresolved?.sobject ?? field.referenceTo[0] ?? "");
  const polymorphic = field.referenceTo.length > 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 6 }}>
        {polymorphic && (
          <select value={target} onChange={e => { setTarget(e.target.value); onChange(null); }} style={{ ...inputStyle(t), width: 150, flexShrink: 0 }} aria-label={`${field.label} object type`}>
            {field.referenceTo.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
        <div style={{ flex: 1 }}>
          <ReferenceLookup
            key={target}
            isDark={isDark}
            objectType={target}
            searchEndpoint={BILLING_SEARCH_ENDPOINT}
            value={value ? { id: value.id, name: value.name } : null}
            onChange={v => onChange(v ? { id: v.id, name: v.name, sobject: target, moduleKey: field.referenceModules[target] ?? null } : null)}
            placeholder={`Search ${field.label}…`}
            noMatchHint={`No matching ${field.label} found in Salesforce.`}
          />
        </div>
      </div>
      {!value && unresolved && (
        <div style={{ fontSize: 11.5, color: t.body, padding: "7px 10px", borderRadius: 8, border: `1px solid ${t.warn}50`, background: `${t.warn}10` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: t.warn, fontWeight: 700 }}>
            <Ic n="alert" s={12} />
            {unresolved.candidates.length > 1 ? `"${unresolved.searchedName}" matched ${unresolved.candidates.length} records — pick one:` : `"${unresolved.searchedName}" could not be found in Salesforce — search for the right record above.`}
          </div>
          {unresolved.candidates.length > 1 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {unresolved.candidates.map(c => (
                <button key={c.id} onClick={() => onChange(c)} style={{ fontSize: 11.5, padding: "3px 9px", borderRadius: 999, border: `1px solid ${t.accent}50`, background: `${t.accent}12`, color: t.accent, cursor: "pointer", fontWeight: 600 }}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function BillingFieldInput({ isDark, field, value, onChange, controller, controllingValue, error }: {
  isDark: boolean;
  field: BillingFieldMeta;
  value: unknown;
  onChange: (v: unknown) => void;
  controller?: BillingFieldMeta;
  controllingValue?: unknown;
  error?: string | null;
}) {
  const t = tokens(isDark);
  const base = inputStyle(t);
  const style: CSSProperties = error ? { ...base, border: `1px solid ${t.error}90` } : base;
  const str = value === null || value === undefined ? "" : String(value);

  switch (field.type) {
    case "boolean":
      return (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.body, cursor: "pointer", padding: "8px 0" }}>
          <input type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} style={{ width: 16, height: 16, accentColor: t.accent }} />
          {value === true ? "Yes" : "No"}
        </label>
      );
    case "picklist": {
      const options = dependentOptions(field, controller, controllingValue);
      return (
        <select value={str} onChange={e => onChange(e.target.value || null)} style={style}>
          <option value="">{field.required ? "Select…" : "— None —"}</option>
          {options.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      );
    }
    case "multipicklist": {
      const selected = new Set(str ? str.split(";") : []);
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {field.picklistValues.map(p => {
            const on = selected.has(p.value);
            return (
              <button key={p.value} type="button" onClick={() => { const next = new Set(selected); if (on) next.delete(p.value); else next.add(p.value); onChange([...next].join(";") || null); }}
                style={{ fontSize: 11.5, padding: "4px 10px", borderRadius: 999, cursor: "pointer", fontWeight: 600, border: `1px solid ${on ? t.accent : t.border}`, color: on ? t.accent : t.body, background: on ? `${t.accent}14` : "transparent" }}>
                {p.label}
              </button>
            );
          })}
        </div>
      );
    }
    case "textarea":
      return <textarea value={str} onChange={e => onChange(e.target.value)} rows={3} maxLength={field.length ?? undefined} style={{ ...style, resize: "vertical" }} />;
    case "int":
    case "long":
    case "double":
    case "currency":
    case "percent":
      return (
        <div style={{ position: "relative" }}>
          <input type="number" value={str} step={field.type === "int" || field.type === "long" ? 1 : "any"} onChange={e => onChange(e.target.value === "" ? null : Number(e.target.value))} style={{ ...style, paddingRight: field.type === "percent" ? 28 : undefined }} />
          {field.type === "percent" && <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: t.dim, fontSize: 12 }}>%</span>}
        </div>
      );
    case "date":
      return <input type="date" value={str.slice(0, 10)} onChange={e => onChange(e.target.value || null)} style={style} />;
    case "datetime":
      return <input type="datetime-local" value={isoToLocalInput(value)} onChange={e => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} style={style} />;
    case "email":
      return <input type="email" value={str} onChange={e => onChange(e.target.value)} style={style} />;
    case "url":
      return <input type="url" value={str} onChange={e => onChange(e.target.value)} style={style} />;
    case "phone":
      return <input type="tel" value={str} onChange={e => onChange(e.target.value)} style={style} />;
    default:
      return <input type="text" value={str} maxLength={field.length ?? undefined} onChange={e => onChange(e.target.value)} style={style} />;
  }
}
