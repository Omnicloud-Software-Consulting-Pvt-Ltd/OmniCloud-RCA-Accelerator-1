"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Ic, tokens, inputStyle, Spinner } from "./shared";
import AnchoredOverlay from "@/components/ui/AnchoredOverlay";
import { overlayPanelStyle } from "@/lib/ui/overlay";

export interface ProductLookupMatch {
  id: string;
  name: string;
  productCode?: string;
}

/**
 * §1 — Salesforce Product2 lookup replacing the plain Product Name text
 * input: search-as-you-type, a dropdown of matches, and an immediate
 * `onSelect` (no extra button) so the caller can kick off product
 * discovery the instant a product is picked. Mirrors the styling/keyboard
 * behavior of components/data/shared/ReferenceLookup.tsx, but is its own
 * self-contained component (own search endpoint, own module's `shared.tsx`
 * primitives) rather than reaching into the Quotes module's lookup.
 */
export default function ProductLookup({
  isDark,
  value,
  onChange,
  onSelect,
  onBlur,
  disabled,
  placeholder,
}: {
  isDark: boolean;
  value: string;
  onChange: (value: string) => void;
  onSelect: (match: ProductLookupMatch) => void;
  onBlur?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const t = tokens(isDark);
  const listboxId = useId();
  const fieldRef = useRef<HTMLDivElement>(null);
  const [results, setResults] = useState<ProductLookupMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The name just picked — the parent writes it back into `value`, which must not start a new search that reopens the list.
  const pickedRef = useRef<string | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const term = value.trim();
    // An empty term is handled synchronously in the input's onChange instead
    // of here, so this effect never calls setState for the "cleared" case.
    if (!term || term === pickedRef.current) return;
    pickedRef.current = null;
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch("/api/pricing-rules/product-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ term }),
        });
        const json = await res.json().catch(() => ({}));
        setResults(res.ok ? (json.matches ?? []) : []);
        setOpen(true);
        setHighlighted(-1);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [value]);

  function selectMatch(match: ProductLookupMatch) {
    pickedRef.current = match.name.trim();
    setResults([]);
    setOpen(false);
    setHighlighted(-1);
    onSelect(match);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { setOpen(false); return; }
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted(h => Math.min(h + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const pick = highlighted >= 0 ? results[highlighted] : results.length === 1 ? results[0] : null;
      if (pick) selectMatch(pick);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <div ref={fieldRef} style={{ position: "relative" }}>
        <input
          value={value}
          disabled={disabled}
          onChange={e => {
            const next = e.target.value;
            onChange(next);
            if (!next.trim()) { setResults([]); setOpen(false); } else { setOpen(true); }
          }}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          onBlur={e => {
            onBlur?.(e.target.value);
            window.setTimeout(() => setOpen(false), 150); // lets an option's onMouseDown commit before the dropdown closes
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "Search for a product…"}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          style={{ ...inputStyle(t), paddingRight: 30 }}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={listboxId}
        />
        <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)" }}>
          {searching && <Spinner isDark={isDark} size={13} />}
        </span>
      </div>

      {/* Portaled (components/ui/AnchoredOverlay) — never clipped by the card/section it sits in. */}
      <AnchoredOverlay anchorRef={fieldRef} open={open && results.length > 0} onDismiss={() => setOpen(false)} maxHeight={240}
        id={listboxId} role="listbox" style={overlayPanelStyle(isDark, t.border)}>
          {results.map((m, i) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={highlighted === i}
              onMouseEnter={() => setHighlighted(i)}
              onMouseDown={e => { e.preventDefault(); selectMatch(m); }}
              style={{
                display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 8,
                textAlign: "left", padding: "8px 12px", border: "none", cursor: "pointer", fontSize: 12.5,
                background: highlighted === i ? `${t.accent}14` : "transparent",
                color: highlighted === i ? t.accent : t.body,
              }}
            >
              <span>{m.name}</span>
              {m.productCode && <span style={{ fontSize: 10.5, color: t.dim }}>{m.productCode}</span>}
            </button>
          ))}
      </AnchoredOverlay>
      <AnchoredOverlay anchorRef={fieldRef} open={open && results.length === 0 && !searching && !!value.trim()} onDismiss={() => setOpen(false)} maxHeight={160} role="status"
        style={{ ...overlayPanelStyle(isDark, `${t.warn}50`), padding: "8px 12px", fontSize: 12, color: t.body, display: "flex", alignItems: "flex-start", gap: 6 }}>
        <span style={{ flexShrink: 0, color: t.warn, marginTop: 1 }}><Ic n="alert" s={12} /></span>
        <span>No matching product found.</span>
      </AnchoredOverlay>
    </div>
  );
}
