"use client";

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { Ic, tokens, inputStyle, Spinner } from "@/components/data/quotes/shared";
import AnchoredOverlay from "@/components/ui/AnchoredOverlay";
import { overlayPanelStyle } from "@/lib/ui/overlay";
import { quoteApiPost } from "@/lib/quotes/client/apiClient";
import type { ReferenceObjectType } from "@/lib/quotes/types";

export interface ReferenceLookupValue {
  id: string;
  name: string;
  /** Optional secondary line shown under the name in the dropdown (e.g. a Contact's email · Account). */
  description?: string;
}

export interface ReferenceLookupHandle {
  /**
   * Search for `name` and apply it the way an AI-extracted value should
   * (§AI Integration): exactly one match auto-selects immediately, zero
   * matches clears the field and surfaces the "no matching X" message,
   * more than one match opens the dropdown for the user to pick — never
   * silently guesses among several candidates.
   */
  searchAndResolve: (name: string, params?: Record<string, string | null | undefined>) => Promise<void>;
}

interface ReferenceLookupProps {
  isDark: boolean;
  /** Which Salesforce object this lookup searches — Account, Opportunity, Pricebook2, Contact, Contract, User, Quote. Only the queried object changes; everything else about this component is object-agnostic (§Generic Reusable Lookup). Any other API name (e.g. BillingPolicy, UnitOfMeasure) is accepted too — the search endpoint validates it. */
  objectType: ReferenceObjectType | (string & Record<never, never>);
  /** POST endpoint returning `{ matches: {id,name}[] }` for `{ objectType, term }` — each module (Quote/Order/Contract) routes to its own thin wrapper around the same shared search. */
  searchEndpoint: string;
  value: ReferenceLookupValue | null;
  onChange: (value: ReferenceLookupValue | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Shown when a search (manual or AI-triggered) finds zero matches — defaults to a generic message naming `objectType`. */
  noMatchHint?: string;
  debounceMs?: number;
  /** Extra fields sent with every search (e.g. `accountId` to scope Contacts to an Account). Changing them clears stale results. */
  extraParams?: Record<string, string | null | undefined>;
  /** Focusing an empty lookup lists the first matches (the endpoint must accept an empty term). */
  browseOnFocus?: boolean;
}

/**
 * Generic, Salesforce-Lightning-style name lookup (§Product Catalog "Lookup
 * Component" / §Generic Reusable Lookup): type-ahead search-as-you-type,
 * a dropdown of matches, keyboard navigation, a clear button, and a loading
 * indicator. Stores only `{id, name}` — the raw Id is never rendered in the
 * UI, only carried internally for the create payload / validation gate.
 *
 * Manual typing never auto-selects (even a single match still requires a
 * click/Enter, matching real Lightning lookups) — only the imperative
 * `searchAndResolve` (wired to the AI-assisted flows) auto-selects on an
 * unambiguous match, per §AI Prompt Matching.
 */
const ReferenceLookup = forwardRef<ReferenceLookupHandle, ReferenceLookupProps>(function ReferenceLookup(
  { isDark, objectType, searchEndpoint, value, onChange, placeholder, disabled, noMatchHint, debounceMs = 350, extraParams, browseOnFocus },
  ref,
) {
  const t = tokens(isDark);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  // Mirrors `value` for the delayed blur-revert below — read at timeout-fire
  // time (not closure-captured at blur time) so a selection made in the
  // window between blur and the timeout is never clobbered by a stale value.
  const valueRef = useRef(value);
  const [term, setTerm] = useState(value?.name ?? "");
  const [results, setResults] = useState<ReferenceLookupValue[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [message, setMessage] = useState<string | null>(null);

  // Stay in sync when the selection changes from outside (cleared, restored from a draft, etc.).
  useEffect(() => {
    valueRef.current = value;
    setTerm(value?.name ?? "");
  }, [value]);

  async function search(rawTerm: string, params = extraParams): Promise<ReferenceLookupValue[]> {
    const res = await quoteApiPost<{ matches: ReferenceLookupValue[] }>(`Search ${objectType}`, searchEndpoint, { ...params, objectType, term: rawTerm });
    return res.matches;
  }

  const searchError = (err: unknown) => `Could not search ${objectType}${err instanceof Error && err.message ? ` — ${err.message}` : ""}. Try again or check your Salesforce connection.`;

  // A different scope (e.g. another Account) makes earlier results meaningless.
  const scopeKey = JSON.stringify(extraParams ?? {});
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey);
    setResults([]);
    setMessage(null);
  }

  async function browse() {
    if (!browseOnFocus || disabled || value || term.trim()) return;
    setSearching(true);
    try {
      const matches = await search("");
      setResults(matches);
      setMessage(matches.length === 0 ? (noMatchHint ?? `No ${objectType} records found.`) : null);
      setOpen(true);
      setHighlighted(-1);
    } catch (err) {
      setResults([]);
      setMessage(searchError(err));
      setOpen(true);
    } finally {
      setSearching(false);
    }
  }

  function selectMatch(match: ReferenceLookupValue) {
    onChange(match);
    setTerm(match.name);
    setResults([]);
    setMessage(null);
    setOpen(false);
    setHighlighted(-1);
  }

  function handleClear() {
    onChange(null);
    setTerm("");
    setResults([]);
    setMessage(null);
    setOpen(false);
    inputRef.current?.focus();
  }

  // Manual search-as-you-type — always requires an explicit pick, even for one result.
  useEffect(() => {
    if (!term.trim() || term === value?.name) {
      setResults([]);
      setMessage(null);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const matches = await search(term);
        setResults(matches);
        setMessage(matches.length === 0 ? (noMatchHint ?? `No matching ${objectType} found. Please select an existing ${objectType}.`) : null);
        setOpen(true);
        setHighlighted(-1);
      } catch (err) {
        setResults([]);
        setMessage(searchError(err));
        setOpen(true);
      } finally {
        setSearching(false);
      }
    }, debounceMs);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);

  useImperativeHandle(ref, () => ({
    // `params` overrides `extraParams` for this call — e.g. an Account resolved in the same AI pass, before props catch up.
    async searchAndResolve(name: string, params?: Record<string, string | null | undefined>) {
      const trimmed = name.trim();
      setTerm(trimmed);
      if (!trimmed) {
        onChange(null);
        setResults([]);
        setMessage(null);
        setOpen(false);
        return;
      }
      setSearching(true);
      try {
        const matches = await search(trimmed, params ?? extraParams);
        if (matches.length === 1) {
          selectMatch(matches[0]);
        } else if (matches.length === 0) {
          onChange(null);
          setResults([]);
          setMessage(noMatchHint ?? `No matching ${objectType} found. Please select an existing ${objectType}.`);
          setOpen(true);
        } else {
          onChange(null);
          setResults(matches);
          setMessage(null);
          setOpen(true);
          setHighlighted(-1);
        }
      } catch {
        onChange(null);
        setMessage(`Could not search for ${objectType} — please select one manually.`);
        setOpen(true);
      } finally {
        setSearching(false);
      }
    },
  }));

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

  const isConfirmed = !!value && term === value.name;

  return (
    <div style={{ position: "relative" }}>
      <div ref={fieldRef} style={{ position: "relative" }}>
        <input
          ref={inputRef}
          value={term}
          disabled={disabled}
          onChange={e => { setTerm(e.target.value); if (value) onChange(null); setOpen(true); }}
          onFocus={() => { if (results.length > 0 || message) setOpen(true); else void browse(); }}
          // Clicking the already-focused field (e.g. after Escape closed the list) reopens it — focus alone won't fire again.
          onClick={() => { if (!open && !searching) { if (results.length > 0 || message) setOpen(true); else void browse(); } }}
          onBlur={() => {
            // Selection itself now commits on the option's onMouseDown (see
            // below), which fires — and preventDefault()s the focus shift —
            // before this blur can happen at all, so there's no longer a
            // race to protect against here. This still matters for the
            // "typed something, didn't select, clicked elsewhere" case: the
            // 150ms delay lets a genuine option mousedown (if one somehow
            // still raced in) win before reverting unconfirmed text back to
            // the last confirmed selection.
            window.setTimeout(() => {
              setOpen(false);
              setTerm(t2 => {
                const confirmedName = valueRef.current?.name ?? "";
                return confirmedName !== t2 ? confirmedName : t2;
              });
            }, 150);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? `Search ${objectType}…`}
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
        <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center", gap: 4 }}>
          {searching ? (
            <Spinner isDark={isDark} size={13} />
          ) : isConfirmed ? (
            <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="check-circle" s={14} /></span>
          ) : null}
          {(term || value) && !disabled && (
            <button
              type="button"
              onClick={handleClear}
              title="Clear selection"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, border: "none", background: "transparent", cursor: "pointer", color: t.dim }}
            >
              <Ic n="x" s={12} />
            </button>
          )}
        </span>
      </div>

      {/* Portaled (components/ui/AnchoredOverlay) — never clipped by the card/section it sits in. */}
      <AnchoredOverlay anchorRef={fieldRef} open={open && results.length > 0} onDismiss={() => setOpen(false)} maxHeight={220}
        id={listboxId} role="listbox" style={overlayPanelStyle(isDark, t.border)}>
          {results.map((m, i) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={highlighted === i}
              onMouseEnter={() => setHighlighted(i)}
              // mousedown (not click) — preventDefault stops the browser from
              // shifting focus off the input at all, so selection commits
              // before any blur/revert logic can ever run, not just before it
              // finishes. onClick is kept as a fallback for non-pointer
              // activation (e.g. assistive tech dispatching a synthetic
              // click) — selectMatch is idempotent, so a double-fire is safe.
              onMouseDown={e => { e.preventDefault(); selectMatch(m); }}
              onClick={() => selectMatch(m)}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", cursor: "pointer", fontSize: 12.5,
                background: highlighted === i ? `${t.accent}14` : "transparent",
                color: highlighted === i ? t.accent : t.body,
              }}
            >
              {m.name}
              {m.description && <span style={{ display: "block", fontSize: 11, color: t.dim, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.description}</span>}
            </button>
          ))}
      </AnchoredOverlay>
      <AnchoredOverlay anchorRef={fieldRef} open={open && results.length === 0 && !!message} onDismiss={() => setOpen(false)} maxHeight={160} role="status"
        style={{ ...overlayPanelStyle(isDark, `${t.warn}50`), padding: "8px 12px", fontSize: 12, color: t.body, display: "flex", alignItems: "flex-start", gap: 6 }}>
        <span style={{ flexShrink: 0, color: t.warn, marginTop: 1 }}><Ic n="alert" s={12} /></span>
        <span>{message}</span>
      </AnchoredOverlay>
    </div>
  );
});

export default ReferenceLookup;
