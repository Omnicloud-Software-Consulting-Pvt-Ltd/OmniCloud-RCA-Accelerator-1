"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle } from "@/components/data/quotes/shared";
import AnchoredOverlay from "@/components/ui/AnchoredOverlay";
import { overlayPanelStyle } from "@/lib/ui/overlay";
import { foldText } from "@/lib/taxLibrary/library";

export interface SelectOption { value: string; label: string; hint?: string; group?: string }

/**
 * Filter + rank options for a search term: exact code / name first, then names starting with the term, then a word inside the name
 * starting with it, then anything containing it — so "india" picks India before "British Indian Ocean Territory", and "in" picks
 * the code IN. Ties keep the original (alphabetical) order. Accent- and case-insensitive.
 */
export function rankOptions(options: SelectOption[], q: string): SelectOption[] {
  const term = foldText(q.trim());
  if (!term) return options;
  const scored: { o: SelectOption; s: number; i: number; len: number }[] = [];
  options.forEach((o, i) => {
    if (!o.value) return; // the "All …" entry isn't a search result
    const name = foldText(o.label.replace(/\s*\([^)]*\)\s*$/, ""));
    const code = foldText(o.value);
    const full = foldText(`${o.label} ${o.value} ${o.hint ?? ""}`);
    const s = code === term || name === term ? 0 : name.startsWith(term) ? 1 : name.split(/[\s\-—(]+/).some(w => w.startsWith(term)) ? 2 : full.includes(term) ? 3 : -1;
    if (s >= 0) scored.push({ o, s, i, len: name.length });
  });
  // Same rank → the closer (shorter) name first, e.g. "united states" → United States of America before …Minor Outlying Islands.
  return scored.sort((a, b) => a.s - b.s || a.len - b.len || a.i - b.i).map(x => x.o);
}

/**
 * Searchable single-select (combobox) for long lists such as 249 countries or a country's subdivisions. Search is accent- and
 * case-insensitive over label, value and hint (e.g. "karnataka" → "Karnātaka", "IN-KA"). Keyboard: ↑ ↓ Enter Escape.
 * Uses the shared AnchoredOverlay so cards and scroll containers never clip the list.
 */
export default function SearchableSelect({ isDark, label, value, options, onChange, placeholder, disabled, emptyText, allLabel }: {
  isDark: boolean;
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  emptyText?: string;
  /** Adds a first option with value "" (e.g. "All countries"). */
  allLabel?: string;
}) {
  const t = tokens(isDark);
  const listId = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const all = useMemo(() => (allLabel ? [{ value: "", label: allLabel }, ...options] : options), [allLabel, options]);
  const shown = useMemo(() => rankOptions(all, q), [all, q]);
  const current = all.find(o => o.value === value);
  const pick = (v: string) => { onChange(v); setOpen(false); setQ(""); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 180, flex: "1 1 200px" }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</span>
      <div ref={anchor}>
        <button type="button" disabled={disabled} onClick={() => { setOpen(o => !o); setActive(0); }} aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${current?.label ?? placeholder}`}
          style={{ ...inputStyle(t), display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1, textAlign: "left" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: current ? t.heading : t.dim }}>{current?.label ?? placeholder}</span>
          <Ic n="chevron-down" s={13} />
        </button>
      </div>
      <AnchoredOverlay anchorRef={anchor} open={open && !disabled} onDismiss={() => { setOpen(false); setQ(""); }} matchWidth minWidth={260} maxHeight={340} scroll={false}
        style={{ ...overlayPanelStyle(isDark, t.border), padding: 6 }}>
        <input autoFocus value={q} onChange={e => { setQ(e.target.value); setActive(0); }} placeholder={`Search ${label.toLowerCase()}…`} aria-label={`Search ${label}`} aria-controls={listId}
          onKeyDown={e => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
            else if (e.key === "Enter" && shown[active]) { e.preventDefault(); pick(shown[active].value); }
            else if (e.key === "Escape") { setOpen(false); setQ(""); }
          }}
          style={{ ...inputStyle(t), marginBottom: 6 }} />
        <div id={listId} role="listbox" aria-label={label} style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
          {shown.length === 0 && <div style={{ fontSize: 12, color: t.dim, padding: 8 }}>{emptyText ?? "No matches."}</div>}
          {shown.map((o, i) => (
            <div key={o.value || "__all"} role="option" aria-selected={o.value === value} onMouseEnter={() => setActive(i)} onClick={() => pick(o.value)}
              style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontSize: 12.5,
                background: i === active ? `${t.accent}18` : "transparent", color: o.value === value ? t.accent : t.heading, fontWeight: o.value === value ? 700 : 500 }}>
              <span>{o.label}</span>{o.hint && <span style={{ fontSize: 11, color: t.dim, whiteSpace: "nowrap" }}>{o.hint}</span>}
            </div>
          ))}
        </div>
      </AnchoredOverlay>
    </div>
  );
}
