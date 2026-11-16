"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Ic, tokens, inputStyle, Spinner } from "@/components/data/quotes/shared";
import AnchoredOverlay from "@/components/ui/AnchoredOverlay";
import { overlayPanelStyle } from "@/lib/ui/overlay";
import { quoteApiGet } from "@/lib/quotes/client/apiClient";
import type { LookupOption, LookupPage, TaxLookupObject } from "@/lib/tax/types";

const DEBOUNCE_MS = 250;
const LOAD_MORE_PX = 48;
const NOUN: Record<TaxLookupObject, string> = { Account: "accounts", Contact: "contacts", Product2: "products", Invoice: "invoices", GeoCountry: "countries", GeoState: "states" };
const BADGE = { ok: "#00C875", warn: "#F5A623", dim: "#8899AA" } as const;

/** Unique by Id, first occurrence wins (pages never overlap, but a late page must never duplicate a row). */
export function mergeOptions(prev: LookupOption[], next: LookupOption[]): LookupOption[] {
  const seen = new Set(prev.map(p => p.id));
  return [...prev, ...next.filter(p => !seen.has(p.id) && seen.add(p.id))];
}

export function lookupUrl(object: TaxLookupObject, q: string, cursor: string | null, params: Record<string, string | null | undefined> = {}): string {
  const qs = new URLSearchParams({ object, q });
  if (cursor) qs.set("cursor", cursor);
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  return `/api/taxes/lookup?${qs.toString()}`;
}

/** An exact match for prefilled text (an assistant answer, a plan): the record's Id, label or code — never a partial match. */
export function exactMatch(options: LookupOption[], text: string): LookupOption | null {
  const t = text.trim().toLowerCase();
  const hits = options.filter(o => o.id.toLowerCase() === t || o.label.toLowerCase() === t || o.code?.toLowerCase() === t);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Searchable Salesforce lookup for the tax pages. Typing searches Salesforce (debounced, server-side, name/code/Id per object);
 * the arrow browses; pages load as the list scrolls. The value is always a real record picked from Salesforce — only a pick or
 * the clear button changes it, and unpicked text reverts when the list closes. `params` scopes the search (Account → Contact,
 * Country → State); `blockedReason` disables the field until its parent is chosen. The list renders in the shared foreground layer
 * (components/ui/AnchoredOverlay), so panels never clip it.
 */
export default function SalesforceLookup({ isDark, object, value, onChange, params, disabled, blockedReason, placeholder, resolveText, label }: {
  isDark: boolean; object: TaxLookupObject; value: LookupOption | null; onChange: (v: LookupOption | null) => void;
  params?: Record<string, string | null | undefined>; disabled?: boolean; blockedReason?: string | null; placeholder?: string;
  /** Prefilled text (name, code or Id) resolved once to the one exactly matching record; otherwise left in the field to pick. */
  resolveText?: string | null; label: string;
}) {
  const t = tokens(isDark);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  // Mirrors `open` synchronously, so focus + click on the same gesture open (and search) once.
  const isOpen = useRef(false);
  const off =!!disabled || !!blockedReason;
  const [term, setTerm] = useState(value?.label ?? "");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LookupOption[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState<"search" | "more" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(-1);

  // Show a selection made outside (cleared by a parent change, resolved from prefilled text).
  const [shown, setShown] = useState(value);
  if (shown !== value) { setShown(value); setTerm(value?.label ?? ""); }
  // Another parent (Account, Country) makes the loaded results meaningless.
  const scope = JSON.stringify(params ?? {});
  const [prevScope, setPrevScope] = useState(scope);
  if (prevScope !== scope) { setPrevScope(scope); setItems([]); setQuery(null); setNextCursor(null); setError(null); }

  async function fetchPage(q: string, cursor: string | null) {
    return quoteApiGet<LookupPage>(`Search ${NOUN[object]}`, lookupUrl(object, q, cursor, params));
  }

  async function load(q: string, cursor: string | null) {
    const id = ++seq.current;
    setLoading(cursor ? "more" : "search");
    setError(null);
    try {
      const page = await fetchPage(q, cursor);
      if (id !== seq.current) return;
      setItems(prev => mergeOptions(cursor ? prev : [], page.options));
      setNextCursor(page.nextCursor);
      setQuery(q);
      if (!cursor) setHighlighted(page.options.length ? 0 : -1);
    } catch (err) {
      if (id === seq.current) setError(`Couldn't search Salesforce ${NOUN[object]}${err instanceof Error && err.message ? ` — ${err.message}` : ""}.`);
    } finally {
      if (id === seq.current) setLoading(null);
    }
  }

  // Prefilled text → the one exactly matching record (once).
  const resolved = useRef(false);
  useEffect(() => {
    if (resolved.current || value || !resolveText?.trim() || off) return;
    resolved.current = true;
    const text = resolveText.trim();
    void fetchPage(text, null).then(page => {
      const hit = exactMatch(page.options, text);
      if (hit) { onChange(hit); return; }
      setTerm(text);
      setNote(page.options.length ? `"${text}" matches ${page.options.length}${page.nextCursor ? "+" : ""} ${NOUN[object]} — pick one.` : `No ${NOUN[object]} match "${text}" — search and pick one.`);
    }).catch(() => setTerm(text));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typed = () => (value && term === value.label ? "" : term.trim());

  function openList() {
    if (off || isOpen.current) return;
    isOpen.current = true;
    setOpen(true);
    setNote(null);
    const q = typed();
    if (query !== q || error) void load(q, null);
  }

  function close() {
    if (timer.current) clearTimeout(timer.current);
    isOpen.current = false;
    setOpen(false);
    setTerm(value?.label ?? "");
  }

  function pick(o: LookupOption) {
    onChange(o);
    setShown(null); // re-sync the input from the new value on the next render
    isOpen.current = false;
    setOpen(false);
    setNote(null);
  }

  function clear() {
    if (timer.current) clearTimeout(timer.current);
    onChange(null);
    setTerm("");
    setNote(null);
    isOpen.current = true; // the focus below must not start a second search
    inputRef.current?.focus();
    setOpen(true);
    void load("", null);
  }

  function type(text: string) {
    setTerm(text);
    setNote(null);
    isOpen.current = true;
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(text.trim(), null), DEBOUNCE_MS);
  }

  function loadMore() {
    if (nextCursor && !loading && query !== null) void load(query, nextCursor);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { openList(); return; }
      if (!items.length) return;
      const h = e.key === "ArrowDown" ? Math.min(highlighted + 1, items.length - 1) : Math.max(highlighted - 1, 0);
      setHighlighted(h);
      if (e.key === "ArrowDown" && h >= items.length - 3) loadMore();
    } else if (e.key === "Enter") {
      if (open && highlighted >= 0 && items[highlighted]) { e.preventDefault(); pick(items[highlighted]); }
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); close(); }
    } else if (e.key === "Tab") {
      if (open) close();
    }
  }

  useEffect(() => {
    if (open && highlighted >= 0) listRef.current?.querySelector(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, highlighted]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const selected = !!value && term === value.label;
  const searching = loading === "search";
  const optionId = (i: number) => `${listId}-o${i}`;
  const iconBtn: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, border: "none", background: "transparent", cursor: off ? "default" : "pointer", color: t.dim, padding: 0 };
  const codeW = selected && value?.code ? Math.min(value.code.length, 14) * 6.5 + 18 : 0;

  // Shared foreground layer: portaled, follows the field on scroll/resize, flips up near the viewport bottom, closes on an
  // outside click / Escape.
  const list = (
    <AnchoredOverlay anchorRef={rootRef} open={open} onDismiss={close} scroll={false} maxHeight={320} minWidth={280}
      style={{ ...overlayPanelStyle(isDark, t.border), overflow: "hidden" }}>
      <div ref={listRef} id={listId} role="listbox" aria-label={label}
        onScroll={e => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_PX) loadMore(); }}
        style={{ flex: 1, minHeight: 0, maxHeight: 280, overflowY: "auto" }}>
        {items.map((o, i) => (
          <div key={o.id} id={optionId(i)} data-index={i} role="option" aria-selected={value?.id === o.id}
            onMouseEnter={() => setHighlighted(i)} onMouseDown={e => { e.preventDefault(); pick(o); }}
            style={{ padding: "7px 12px", cursor: "pointer", fontSize: 12.5, background: highlighted === i ? `${t.accent}14` : "transparent", color: highlighted === i ? t.accent : t.body, borderLeft: `2px solid ${value?.id === o.id ? t.accent : "transparent"}` }}>
            <div style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
              <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</span>
              {o.code && <span style={{ fontSize: 10.5, color: t.dim, flexShrink: 0 }}>{o.code}</span>}
              {o.badge && <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: BADGE[o.badge.tone], flexShrink: 0 }}>{o.badge.text}</span>}
            </div>
            {o.detail && <div style={{ fontSize: 11, color: t.dim, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.detail}</div>}
          </div>
        ))}
        {!items.length && !loading && !error && query !== null && (
          <div style={{ padding: "10px 12px", fontSize: 12, color: t.dim }}>No {NOUN[object]} found{query ? <> for &ldquo;{query}&rdquo;</> : null}.</div>
        )}
        {!items.length && searching && <div style={{ padding: "10px 12px", fontSize: 12, color: t.dim, display: "flex", gap: 8, alignItems: "center" }}><Spinner isDark={isDark} size={12} /> Searching Salesforce {NOUN[object]}…</div>}
        {error && (
          <div style={{ padding: "8px 12px", fontSize: 12, color: t.body, display: "flex", gap: 6, alignItems: "flex-start" }}>
            <span style={{ color: t.error, marginTop: 1, flexShrink: 0 }}><Ic n="alert" s={12} /></span>
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => void load(query ?? typed(), items.length ? nextCursor : null)} style={{ border: "none", background: "none", color: t.accent, cursor: "pointer", fontSize: 12, padding: 0 }}>Retry</button>
          </div>
        )}
        {loading === "more" && <div style={{ padding: "8px 12px", fontSize: 11.5, color: t.dim, display: "flex", gap: 8, alignItems: "center" }}><Spinner isDark={isDark} size={11} /> Loading more…</div>}
      </div>
      {!!items.length && (
        <div style={{ padding: "5px 12px", fontSize: 10.5, color: t.dim, borderTop: `1px solid ${t.border}` }}>
          {items.length} {NOUN[object]}{nextCursor ? " loaded · scroll for more" : ""}
        </div>
      )}
    </AnchoredOverlay>
  );

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: t.dim, display: "flex", pointerEvents: "none" }}><Ic n="search" s={13} /></span>
      <input
        ref={inputRef} value={term} disabled={off}
        onChange={e => type(e.target.value)}
        onFocus={openList}
        onClick={openList}
        onKeyDown={onKeyDown}
        placeholder={blockedReason ?? placeholder ?? `Search ${NOUN[object]}…`}
        title={blockedReason ?? undefined}
        autoComplete="off" spellCheck={false}
        role="combobox" aria-label={label} aria-expanded={open} aria-autocomplete="list" aria-controls={listId}
        aria-activedescendant={open && highlighted >= 0 ? optionId(highlighted) : undefined}
        style={{ ...inputStyle(t), paddingLeft: 28, paddingRight: 50 + codeW, opacity: off ? 0.6 : 1 }}
      />
      <span style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center", gap: 2 }}>
        {searching && <Spinner isDark={isDark} size={13} />}
        {selected && value?.code && !searching && (
          <span title="Code" style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 999, border: `1px solid ${t.border}`, color: t.dim, maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value.code}</span>
        )}
        {(term || value) && !off && (
          <button type="button" title="Clear selection" aria-label={`Clear ${label}`} onMouseDown={e => e.preventDefault()} onClick={clear} style={iconBtn}><Ic n="x" s={12} /></button>
        )}
        <button type="button" tabIndex={-1} aria-label={open ? "Close list" : `Browse ${NOUN[object]}`} title={open ? "Close list" : `Browse ${NOUN[object]}`} disabled={off}
          onMouseDown={e => e.preventDefault()} onClick={() => { if (open) close(); else { inputRef.current?.focus(); openList(); } }}
          style={{ ...iconBtn, transform: open ? "rotate(180deg)" : undefined, transition: "transform 0.15s" }}>
          <Ic n="chevron-down" s={14} />
        </button>
      </span>
      {note && !open && <div style={{ fontSize: 11, color: t.warn, marginTop: 3 }}>{note}</div>}
      {list}
    </div>
  );
}
