"use client";

import { useEffect, useState } from "react";
import { Ic, tokens, inputStyle, Spinner } from "@/components/data/quotes/shared";
import { quoteApiPost } from "@/lib/quotes/client/apiClient";
import type { ContractContact } from "@/lib/contracts/types";

/**
 * Dedicated Account-scoped Contact lookup for "Customer Signed By" (§3.3) —
 * deliberately NOT the shared generic reference-lookup component used for
 * Account/Pricebook/User, since Contact search here needs to be scoped by
 * whichever Account is currently selected. Never searches while no Account
 * is selected. Supports both search-as-you-type and a preload dropdown of
 * every Contact under the Account (auto-selecting a single match).
 */
export default function ContactLookup({ isDark, accountId, value, onChange }: {
  isDark: boolean;
  accountId: string | null;
  value: { id: string; name: string } | null;
  onChange: (contact: { id: string; name: string } | null) => void;
}) {
  const t = tokens(isDark);
  const [term, setTerm] = useState(value?.name ?? "");
  const [results, setResults] = useState<ContractContact[]>([]);
  const [preload, setPreload] = useState<ContractContact[]>([]);
  const [preloadLoaded, setPreloadLoaded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);

  // Preload mode (§3.3): fetch every Contact under the Account when it changes; auto-select if exactly one.
  useEffect(() => {
    setPreload([]);
    setPreloadLoaded(false);
    onChange(null);
    setTerm("");
    if (!accountId) return;
    quoteApiPost<{ contacts: ContractContact[] }>("Preload account contacts", "/api/contracts/contacts/preload", { accountId })
      .then(res => {
        setPreload(res.contacts);
        setPreloadLoaded(true);
        if (res.contacts.length === 1) {
          onChange({ id: res.contacts[0].id, name: res.contacts[0].name });
          setTerm(res.contacts[0].name);
        }
      })
      .catch(() => setPreloadLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  // Search-as-you-type (§3.3): exactly one match auto-selects; multiple require an explicit click.
  useEffect(() => {
    if (!accountId || !term.trim() || term === value?.name) {
      setResults([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await quoteApiPost<{ contacts: ContractContact[] }>("Search account contacts", "/api/contracts/contacts/search", { accountId, term });
        setResults(res.contacts);
        if (res.contacts.length === 1) onChange({ id: res.contacts[0].id, name: res.contacts[0].name });
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, accountId]);

  if (!accountId) {
    return <div style={{ fontSize: 11.5, color: t.dim, padding: "9px 0" }}>Select an Account first to search its Contacts.</div>;
  }

  const dropdownItems = term.trim() ? results : preload;
  const showEmptyPreload = !term.trim() && preloadLoaded && preload.length === 0;
  const showEmptySearch = !!term.trim() && !searching && results.length === 0;

  return (
    <div style={{ position: "relative" }}>
      <input
        value={term}
        onChange={e => { setTerm(e.target.value); onChange(null); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search contacts under this account…"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        style={inputStyle(t)}
      />
      {searching && <div style={{ marginTop: 4, fontSize: 11, color: t.dim, display: "flex", alignItems: "center", gap: 4 }}><Spinner isDark={isDark} size={11} /> Searching…</div>}
      {value && <div style={{ marginTop: 4, fontSize: 11, color: t.accent, display: "flex", alignItems: "center", gap: 4 }}><Ic n="check-circle" s={12} /> {value.name}</div>}

      {open && dropdownItems.length > 0 && (
        <div style={{ position: "absolute", zIndex: 10, top: "100%", left: 0, right: 0, marginTop: 4, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surface, maxHeight: 220, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.2)" }}>
          {dropdownItems.map(c => (
            <button
              key={c.id}
              onMouseDown={e => { e.preventDefault(); onChange({ id: c.id, name: c.name }); setTerm(c.name); setOpen(false); }}
              onClick={() => { onChange({ id: c.id, name: c.name }); setTerm(c.name); setOpen(false); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", fontSize: 12.5, color: t.body }}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      {open && showEmptySearch && (
        <div style={{ position: "absolute", zIndex: 10, top: "100%", left: 0, right: 0, marginTop: 4, padding: "8px 12px", borderRadius: 9, border: `1px solid ${t.border}`, background: t.surface, fontSize: 12, color: t.dim }}>
          No matching contacts found.
        </div>
      )}
      {open && showEmptyPreload && (
        <div style={{ marginTop: 4, fontSize: 11, color: t.dim }}>No contacts under this account.</div>
      )}
    </div>
  );
}
