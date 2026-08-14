"use client";

import { Ic } from "@/components/metadata/shared/productFields";
import type { FieldProvenance } from "@/lib/products/ai/productIntent";

/**
 * Shared "Field → Value" mapping table — the visible proof, for both
 * Single and Multiple Product review, that a prompt value actually made
 * it to the right field, and an honest "Not specified" for anything the
 * user never said, instead of a silently fabricated value. Used by
 * RCProductWorkspace and MultiProductWorkspace's per-product review card.
 */
export interface MappingRow {
  label: string;
  /** Already display-formatted (e.g. "$1,500", "Yes"). Ignored when provenance is "unspecified". */
  value?: string;
  provenance: FieldProvenance;
  /** Optional caveat shown under the value, e.g. why a field won't reach Salesforce as-is. */
  note?: string;
}

const PROVENANCE_META: Record<FieldProvenance, { label: string; color: string }> = {
  explicit: { label: "Provided", color: "#22C55E" },
  default: { label: "Default", color: "#F59E0B" },
  unspecified: { label: "Not specified", color: "#5A78A0" },
};

export default function FieldMappingTable({ rows }: { rows: MappingRow[] }) {
  return (
    <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--rc-field-border)" }}>
      <div className="grid grid-cols-[1fr_1.3fr_auto] gap-2 px-3.5 py-2" style={{ background: "var(--rc-field-bg)" }}>
        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--rc-text-muted)" }}>Field</span>
        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--rc-text-muted)" }}>Value</span>
        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--rc-text-muted)" }}>Source</span>
      </div>
      {rows.map((row, i) => {
        const meta = PROVENANCE_META[row.provenance];
        const isUnspecified = row.provenance === "unspecified" || !row.value;
        return (
          <div key={i} className="grid grid-cols-[1fr_1.3fr_auto] gap-2 px-3.5 py-2 items-start"
            style={{ borderTop: i === 0 ? "none" : "1px solid var(--rc-divider)" }}>
            <span className="text-[11.5px] font-semibold" style={{ color: "var(--rc-text-primary)" }}>{row.label}</span>
            <div>
              <span className="text-[11.5px]" style={{ color: isUnspecified ? "var(--rc-text-muted)" : "var(--rc-text-primary)", fontStyle: isUnspecified ? "italic" : "normal" }}>
                {isUnspecified ? "Not specified" : row.value}
              </span>
              {row.note && (
                <div className="flex items-start gap-1 mt-1 text-[10px]" style={{ color: "var(--rc-text-muted)" }}>
                  <span className="mt-0.5 shrink-0"><Ic n="info" s={10} /></span>
                  {row.note}
                </div>
              )}
            </div>
            <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap"
              style={{ background: `${meta.color}18`, border: `1px solid ${meta.color}40`, color: meta.color }}>
              {isUnspecified ? "Not specified" : meta.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
