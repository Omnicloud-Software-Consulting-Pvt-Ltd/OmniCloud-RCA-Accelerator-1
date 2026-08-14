"use client";

import type { ReactNode } from "react";
import { Ic, tokens, ErrorPanel, GhostButton, type ErrorPanelData } from "@/components/data/quotes/shared";
import type { ImportFieldDef, ColumnMappingSuggestion } from "@/lib/import/columnMapping";

const NONE_VALUE = "__none__";

/**
 * Shared bulk-import Column Mapping step — originally built for Products
 * (components/data/products/import/ImportMappingStep.tsx, which now
 * delegates here), generalized to take an arbitrary `fields` list so
 * Quotes/Contracts/Orders reuse the same mapping table/status UI instead of
 * a per-module copy. Module-specific extras (e.g. a "skip existing"
 * checkbox) render via the `extraOptions` slot.
 */
export default function ImportMappingStep<K extends string>({
  isDark, headers, sampleRow, fields, mapping, suggestions, validating, error, extraOptions, continueLabel = "Validate & Preview",
  onChangeMapping, onContinue, onBack,
}: {
  isDark: boolean;
  headers: string[];
  sampleRow: Record<string, string> | null;
  fields: ImportFieldDef<K>[];
  mapping: Record<K, string | null>;
  suggestions: ColumnMappingSuggestion<K>[];
  validating: boolean;
  error: ErrorPanelData | null;
  extraOptions?: ReactNode;
  continueLabel?: string;
  onChangeMapping: (header: string, field: K | null) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const t = tokens(isDark);
  const suggestionByHeader = new Map(suggestions.map(s => [s.header, s]));
  const mappedFields = new Set(Object.values(mapping).filter(Boolean));

  const missingRequired = fields.filter(f => f.required && !mapping[f.key]);
  const ambiguousHeaders = suggestions.filter(s => s.ambiguous);

  return (
    <div style={{ padding: 24, maxWidth: 920 }}>
      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 10 }}>Column Mapping</p>

      {missingRequired.length > 0 && (
        <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.error}50`, background: isDark ? "rgba(255,64,102,0.08)" : "rgba(255,64,102,0.06)", color: t.error, fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <Ic n="alert" s={14} />
          Required field{missingRequired.length > 1 ? "s" : ""} not mapped: {missingRequired.map(f => f.label).join(", ")}. Choose a column for {missingRequired.length > 1 ? "each of these" : "this"} below before continuing.
        </div>
      )}
      {ambiguousHeaders.length > 0 && (
        <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.warn}50`, background: isDark ? "rgba(245,158,11,0.08)" : "rgba(245,158,11,0.06)", color: t.warn, fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <Ic n="alert" s={14} />
          Ambiguous column{ambiguousHeaders.length > 1 ? "s" : ""}: {ambiguousHeaders.map(a => `"${a.header}"`).join(", ")} matched more than one field — pick the correct mapping manually.
        </div>
      )}

      <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.2fr 1.6fr 0.6fr", gap: 0, padding: "9px 14px", background: t.surfaceAlt, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
          <span>Uploaded Column</span>
          <span>Sample Value</span>
          <span>Mapped To</span>
          <span style={{ textAlign: "center" }}>Status</span>
        </div>
        {headers.map((header, i) => {
          const suggestion = suggestionByHeader.get(header);
          const mappedField = mapping && (Object.entries(mapping).find(([, v]) => v === header)?.[0] as K | undefined);
          const sample = sampleRow?.[header] ?? "";
          const isAmbiguous = suggestion?.ambiguous ?? false;
          const statusIcon = mappedField
            ? { n: "check-circle", color: "#22C55E" }
            : isAmbiguous
              ? { n: "alert", color: t.warn }
              : { n: "x", color: t.dim };

          return (
            <div key={header} style={{ display: "grid", gridTemplateColumns: "1.4fr 1.2fr 1.6fr 0.6fr", gap: 0, padding: "9px 14px", borderTop: `1px solid ${t.border}`, alignItems: "center", background: i % 2 === 0 ? "transparent" : (isDark ? "rgba(255,255,255,0.015)" : "rgba(0,0,0,0.012)") }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: t.heading, overflow: "hidden", textOverflow: "ellipsis" }}>{header}</span>
              <span style={{ fontSize: 11.5, color: t.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sample || "—"}</span>
              <select
                value={mappedField ?? NONE_VALUE}
                onChange={e => onChangeMapping(header, e.target.value === NONE_VALUE ? null : (e.target.value as K))}
                style={{
                  fontSize: 12, padding: "6px 8px", borderRadius: 8, border: `1px solid ${t.inputBorder}`, background: t.inputBg, color: t.heading,
                }}
              >
                <option value={NONE_VALUE}>— Do not import —</option>
                {fields.map(f => (
                  <option key={f.key} value={f.key} disabled={mappedFields.has(f.key) && mappedField !== f.key}>
                    {f.label}{f.required ? " *" : ""}
                  </option>
                ))}
              </select>
              <span style={{ textAlign: "center", color: statusIcon.color }}>
                <Ic n={statusIcon.n} s={14} />
              </span>
            </div>
          );
        })}
      </div>

      {extraOptions && <div style={{ marginTop: 16 }}>{extraOptions}</div>}

      {error && <div style={{ marginTop: 14 }}><ErrorPanel isDark={isDark} error={error} /></div>}

      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        <GhostButton label="Back" icon="arrow-left" isDark={isDark} onClick={onBack} disabled={validating} />
        <button
          onClick={onContinue}
          disabled={missingRequired.length > 0 || validating}
          style={{
            display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 18px", borderRadius: 10, border: "none",
            fontSize: 13, fontWeight: 700, cursor: missingRequired.length > 0 || validating ? "not-allowed" : "pointer",
            color: "#04101F",
            background: missingRequired.length > 0 || validating ? t.dim : `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})`,
            opacity: missingRequired.length > 0 || validating ? 0.5 : 1,
          }}
        >
          {validating ? "Validating…" : continueLabel}
        </button>
      </div>
    </div>
  );
}
