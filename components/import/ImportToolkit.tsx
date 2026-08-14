"use client";

import { useState } from "react";
import { Ic, tokens } from "@/components/data/quotes/shared";
import type { ImportFieldDef, ImportToolkitConfig } from "@/lib/import/columnMapping";
import { downloadExcelTemplate, downloadCsvTemplate } from "@/lib/import/templateGenerator";

type Group = "required" | "conditional" | "optional";

function groupOf<K extends string>(f: ImportFieldDef<K>): Group {
  if (f.toolkit?.conditional) return "conditional";
  return f.required ? "required" : "optional";
}

const GROUP_META: Record<Group, { label: string; symbol: string; color: string }> = {
  required: { label: "Required Fields", symbol: "✓", color: "#22C55E" },
  conditional: { label: "Conditional Fields", symbol: "⚠", color: "#F59E0B" },
  optional: { label: "Optional Fields", symbol: "○", color: "#3AABFF" },
};

/**
 * Import Toolkit — shared "what should my file contain?" reference shown on
 * every bulk-import page (Products/Bundles/Attributes/Quotes/Contracts/
 * Orders). Reads directly from each module's own canonical `ImportFieldDef`
 * array (the same array `suggestColumnMapping`/`toMappingRecord`/
 * `ImportMappingStep` already use) plus a small `ImportToolkitConfig` for
 * module copy/examples — never a separate hardcoded field list, so this can
 * never drift from what the importer actually accepts (§22). Purely
 * informational: it does not touch parsing, mapping, validation, or
 * creation — those flows are unchanged.
 */
export default function ImportToolkit<K extends string>({
  isDark, fields, config, compact = false, templateFilenameBase,
}: {
  isDark: boolean;
  fields: ImportFieldDef<K>[];
  config: ImportToolkitConfig<K>;
  /** Compact mode drops the intro copy and defaults to collapsed — used on the Mapping step so the toolkit stays reachable without repeating the full pitch. */
  compact?: boolean;
  /** Base filename (no extension) for the downloaded template — defaults to the module label. */
  templateFilenameBase?: string;
}) {
  const t = tokens(isDark);
  const [open, setOpen] = useState(!compact);
  const [tab, setTab] = useState<Group | "example">("required");

  const byGroup: Record<Group, ImportFieldDef<K>[]> = { required: [], conditional: [], optional: [] };
  for (const f of fields) byGroup[groupOf(f)].push(f);

  const tabs: { id: Group | "example"; label: string }[] = [
    { id: "required", label: `${GROUP_META.required.symbol} Required Fields (${byGroup.required.length})` },
    ...(byGroup.conditional.length > 0 ? [{ id: "conditional" as const, label: `${GROUP_META.conditional.symbol} Conditional Fields (${byGroup.conditional.length})` }] : []),
    { id: "optional", label: `${GROUP_META.optional.symbol} Optional Fields (${byGroup.optional.length})` },
    { id: "example", label: "Example File" },
  ];

  const filenameBase = (templateFilenameBase ?? config.moduleLabel).replace(/\s+/g, "_");

  const renderFieldTable = (list: ImportFieldDef<K>[], group: Group) => {
    if (list.length === 0) {
      return <p style={{ fontSize: 12, color: t.dim, padding: "12px 2px" }}>No {GROUP_META[group].label.toLowerCase()} for this import.</p>;
    }
    return (
      <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.8fr 1fr 1.8fr", padding: "8px 12px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
          <span>Field</span><span>Format</span><span>Example</span><span>Description</span>
        </div>
        {list.map((f, i) => (
          <div key={f.key} style={{ display: "grid", gridTemplateColumns: "1.1fr 0.8fr 1fr 1.8fr", padding: "9px 12px", borderTop: i > 0 ? `1px solid ${t.border}` : undefined, fontSize: 12, color: t.body, alignItems: "start", gap: 4 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontWeight: 700, color: t.heading }}>{f.label}</span>
              {f.toolkit?.relationship && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9.5, fontWeight: 700, padding: "1px 6px", borderRadius: 999, color: t.accentBlue, border: `1px solid ${t.accentBlue}40`, width: "fit-content" }}>
                  <Ic n="link" s={9} /> Salesforce Relationship
                </span>
              )}
              {f.toolkit?.groupingKey && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9.5, fontWeight: 700, padding: "1px 6px", borderRadius: 999, color: t.accent, border: `1px solid ${t.accent}40`, width: "fit-content" }}>
                  Grouping Key
                </span>
              )}
            </div>
            <span style={{ fontSize: 11 }}>{f.toolkit?.format ?? "Text"}</span>
            <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{f.toolkit?.example ?? "—"}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span>{f.toolkit?.description ?? ""}</span>
              {f.toolkit?.conditional && <span style={{ fontSize: 10.5, color: GROUP_META.conditional.color }}>⚠ {f.toolkit.conditional}</span>}
              {f.toolkit?.relationship && <span style={{ fontSize: 10.5, color: t.dim }}>{f.toolkit.relationship.note}</span>}
              {f.toolkit?.expectedValues && <span style={{ fontSize: 10.5, color: t.dim }}>Expected values: {f.toolkit.expectedValues.join(" | ")}</span>}
              {f.toolkit?.notSentToSalesforce && <span style={{ fontSize: 10.5, color: t.dim }}>ℹ {f.toolkit.notSentToSalesforce}</span>}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ borderRadius: 14, border: `1px solid ${t.border}`, background: t.surface, overflow: "hidden" }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
      >
        <div style={{ width: 30, height: 30, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", background: `${t.accent}18`, border: `1px solid ${t.accent}30`, color: t.accent, flexShrink: 0 }}>
          <Ic n="book-open" s={15} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: t.heading, letterSpacing: "-0.01em" }}>IMPORT TOOLKIT</span>
            <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 999, color: t.accent, border: `1px solid ${t.accent}40` }}>{config.moduleLabel}</span>
          </div>
          {!compact && (
            <p style={{ fontSize: 11, color: t.dim, marginTop: 2 }}>Prepare your Excel or CSV file using the fields below for a successful import.</p>
          )}
        </div>
        <span style={{ color: t.dim, flexShrink: 0 }}><Ic n={open ? "chevron-down" : "chevron-right"} s={14} /></span>
      </button>

      {open && (
        <div style={{ padding: "0 16px 16px" }}>
          {/* Legend */}
          <div className="flex items-center gap-4 flex-wrap" style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${t.border}` }}>
            {(["required", "conditional", "optional"] as Group[]).map(g => (
              <span key={g} style={{ fontSize: 11, fontWeight: 600, color: GROUP_META[g].color, display: "flex", alignItems: "center", gap: 4 }}>
                {GROUP_META[g].symbol} {g === "required" ? "Required" : g === "conditional" ? "Conditional" : "Optional"}
              </span>
            ))}
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button onClick={() => downloadExcelTemplate(fields, config, `${filenameBase}_Template.xlsx`)}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, padding: "6px 12px", borderRadius: 9, color: "#04101F", border: "none", cursor: "pointer", background: `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})` }}>
                <Ic n="download" s={12} /> Download Excel Template
              </button>
              <button onClick={() => downloadCsvTemplate(fields, config, `${filenameBase}_Template.csv`)}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, padding: "6px 12px", borderRadius: 9, color: t.accent, border: `1px solid ${t.accent}50`, background: "transparent", cursor: "pointer" }}>
                <Ic n="download" s={12} /> CSV
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 flex-wrap" style={{ marginBottom: 12 }}>
            {tabs.map(tb => (
              <button key={tb.id} onClick={() => setTab(tb.id)}
                style={{
                  fontSize: 11, fontWeight: 700, padding: "6px 12px", borderRadius: 999, cursor: "pointer", border: `1px solid ${tab === tb.id ? t.accent : t.border}`,
                  color: tab === tb.id ? t.accent : t.dim, background: tab === tb.id ? `${t.accent}14` : "transparent",
                }}>
                {tb.label}
              </button>
            ))}
          </div>

          {tab === "required" && renderFieldTable(byGroup.required, "required")}
          {tab === "conditional" && renderFieldTable(byGroup.conditional, "conditional")}
          {tab === "optional" && renderFieldTable(byGroup.optional, "optional")}
          {tab === "example" && (
            <div>
              {config.groupingNote && (
                <div style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 9, fontSize: 11.5, color: t.accentBlue, border: `1px solid ${t.accentBlue}35`, background: `${t.accentBlue}0C` }}>
                  ℹ {config.groupingNote}
                </div>
              )}
              <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "auto" }}>
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${config.exampleColumns.length}, minmax(110px, 1fr))`, padding: "8px 12px", background: t.surfaceAlt, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
                  {config.exampleColumns.map(col => <span key={col}>{fields.find(f => f.key === col)?.label ?? col}</span>)}
                </div>
                {config.exampleRows.map((row, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: `repeat(${config.exampleColumns.length}, minmax(110px, 1fr))`, padding: "8px 12px", borderTop: i > 0 ? `1px solid ${t.border}` : undefined, fontSize: 11.5, color: t.body }}>
                    {config.exampleColumns.map(col => <span key={col} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row[col] ?? "—"}</span>)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
