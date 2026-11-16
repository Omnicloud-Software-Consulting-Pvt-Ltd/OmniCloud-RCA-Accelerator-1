"use client";

import { useState } from "react";
import { tokens, inputStyle, Field } from "@/components/data/quotes/shared";
import type { BillingOptions } from "@/lib/assetLifecycle/server/reads";
import type { BillingDetails, PostalAddress } from "@/lib/assetLifecycle/types";
import { addressText } from "@/lib/assetLifecycle/billing";
import FieldHelp from "@/components/help/FieldHelp";
import { LIFECYCLE_HELP as LH } from "@/lib/help/lifecycleHelp";

/** Edits on top of the defaults: a key that is present (even null) overrides the default; absent = keep the default. */
export type BillingEdits = Partial<BillingDetails> & { shippingSameAsBilling?: boolean };

/** The billing details the form uses: defaults (original order / account) overridden by what the user or the prompt set. */
export function effectiveBilling(defaults: BillingOptions["defaults"] | null, edits: BillingEdits): BillingDetails {
  const has = (k: keyof BillingEdits) => Object.prototype.hasOwnProperty.call(edits, k);
  const billingAddress = has("billingAddress") ? edits.billingAddress ?? null : defaults?.billingAddress ?? null;
  const touched = Object.keys(edits).length > 0;
  return {
    billToContactId: has("billToContactId") ? edits.billToContactId ?? null : defaults?.billToContactId ?? null,
    billToContactName: has("billToContactId") ? edits.billToContactName ?? null : defaults?.billToContactName ?? null,
    billingAddress,
    shippingAddress: edits.shippingSameAsBilling ? billingAddress : has("shippingAddress") ? edits.shippingAddress ?? null : defaults?.shippingAddress ?? null,
    source: touched ? edits.source ?? (defaults ? `${defaults.source}, edited` : "Entered") : defaults?.source ?? null,
  };
}

const EMPTY: PostalAddress = { street: null, city: null, state: null, postalCode: null, country: null };

function AddressFields({ isDark, label, value, onChange, suggestions, disabled }: {
  isDark: boolean; label: "Billing" | "Shipping"; value: PostalAddress | null; onChange: (a: PostalAddress | null) => void;
  suggestions: BillingOptions["addresses"]; disabled?: boolean;
}) {
  const t = tokens(isDark);
  const a = value ?? EMPTY;
  const set = (k: keyof PostalAddress, v: string) => onChange({ ...a, [k]: v || null });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Field label={`${label} address`} isDark={isDark} help={label === "Billing" ? LH.billingAddress : LH.shippingAddress} hint={suggestions.length ? "Pick an address from Salesforce or type it." : "No address on this account's records — type it."}>
        <select aria-label={`${label} address from Salesforce`} disabled={disabled || !suggestions.length} value="" onChange={e => { const s = suggestions[Number(e.target.value)]; if (s) onChange(s.address); }} style={inputStyle(t)}>
          <option value="">{suggestions.length ? `Use an address from Salesforce (${suggestions.length})…` : "No saved addresses"}</option>
          {suggestions.map((s, i) => <option key={`${s.source}-${i}`} value={i}>{s.source}: {addressText(s.address)}</option>)}
        </select>
      </Field>
      <textarea aria-label={`${label} street`} rows={2} disabled={disabled} value={a.street ?? ""} onChange={e => set("street", e.target.value)} placeholder="Street" style={{ ...inputStyle(t), resize: "vertical", fontFamily: "inherit" }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(130px, 100%), 1fr))", gap: 8 }}>
        <input aria-label={`${label} city`} disabled={disabled} value={a.city ?? ""} onChange={e => set("city", e.target.value)} placeholder="City" style={inputStyle(t)} />
        <input aria-label={`${label} state`} disabled={disabled} value={a.state ?? ""} onChange={e => set("state", e.target.value)} placeholder="State / province" style={inputStyle(t)} />
        <input aria-label={`${label} postal code`} disabled={disabled} value={a.postalCode ?? ""} onChange={e => set("postalCode", e.target.value)} placeholder="Postal code" style={inputStyle(t)} />
        <input aria-label={`${label} country`} disabled={disabled} value={a.country ?? ""} onChange={e => set("country", e.target.value)} placeholder="Country" style={inputStyle(t)} />
      </div>
    </div>
  );
}

/**
 * Bill-To Contact (a contact of the selected account, searchable) + Billing / Shipping address from real Salesforce records (the assets'
 * original order, the account's other orders, the account, its contacts) or typed in. Written to the quote and, before activation,
 * the order. Defaults are only a starting point — every value stays editable.
 */
export default function BillingDetailsFields({ isDark, options, value, edits, onEdits, loading, disabled }: {
  isDark: boolean; options: BillingOptions | null; value: BillingDetails; edits: BillingEdits; onEdits: (e: BillingEdits) => void; loading: boolean; disabled?: boolean;
}) {
  const t = tokens(isDark);
  const [q, setQ] = useState("");
  const contacts = options?.contacts ?? [];
  const shown = contacts.filter(c => !q.trim() || `${c.name} ${c.email ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  const selectedMissing = value.billToContactId && !contacts.some(c => c.id.slice(0, 15) === value.billToContactId!.slice(0, 15));
  const suggestions = options?.addresses ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="billing-details">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(260px, 100%), 1fr))", gap: 12 }}>
        <Field label="Bill-To Contact" isDark={isDark} help={LH.billTo} hint={loading ? "Loading the account's contacts…" : contacts.length ? `${contacts.length} contact(s) of this account.` : "This account has no contacts — add one in Salesforce."}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <input aria-label="Search contacts" disabled={disabled || !contacts.length} value={q} onChange={e => setQ(e.target.value)} placeholder="Search contacts…" style={inputStyle(t)} />
            <select aria-label="Bill-To Contact" disabled={disabled || !contacts.length} value={value.billToContactId ?? ""} onChange={e => { const c = contacts.find(x => x.id === e.target.value); onEdits({ ...edits, billToContactId: c?.id ?? null, billToContactName: c?.name ?? null }); }} style={inputStyle(t)}>
              <option value="">Choose the Bill-To Contact…</option>
              {selectedMissing && <option value={value.billToContactId!}>{value.billToContactName ?? value.billToContactId}</option>}
              {shown.map(c => <option key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ""}</option>)}
            </select>
          </div>
        </Field>
        <div style={{ fontSize: 12, color: t.dim, alignSelf: "end" }}>{value.source ? <>Starting point: <b style={{ color: t.body }}>{value.source}</b>. Change anything — the order gets exactly what is shown here.</> : "Choose who is billed and where — Salesforce needs a Bill-To Contact, a Billing and a Shipping address to bill the order."}</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))", gap: 16 }}>
        <AddressFields isDark={isDark} label="Billing" value={value.billingAddress} suggestions={suggestions} disabled={disabled} onChange={a => onEdits({ ...edits, billingAddress: a })} />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.body }}>
            <input type="checkbox" disabled={disabled} checked={!!edits.shippingSameAsBilling} onChange={e => onEdits({ ...edits, shippingSameAsBilling: e.target.checked })} /> Shipping address is the same as the billing address <FieldHelp isDark={isDark} label="Same as billing" entry={LH.shippingSame} />
          </label>
          {!edits.shippingSameAsBilling && <AddressFields isDark={isDark} label="Shipping" value={value.shippingAddress} suggestions={suggestions} disabled={disabled} onChange={a => onEdits({ ...edits, shippingAddress: a })} />}
        </div>
      </div>
    </div>
  );
}
