"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, Field, PrimaryButton, GhostButton } from "@/components/data/quotes/shared";
import { Z } from "@/lib/ui/overlay";
import type { Issue } from "@/lib/taxLibrary/library";
import { KNOWN_TAX_TYPES, type RateCalculation, type TaxRateInput, type TaxRateReference, type VerificationStatus } from "@/lib/taxLibrary/types";
import type * as Geo from "@/lib/taxLibrary/jurisdictions";

export type EditorMode = "create" | "edit" | "version";

export function blankInput(): TaxRateInput {
  return {
    jurisdiction: { countryCode: "", countryName: "", subdivisionCode: null, subdivisionName: null, level: "country", locality: null },
    tax: { taxCode: "", taxName: "", taxType: "", taxStructure: "", taxComponent: null, taxAuthority: null, taxCategory: null },
    rate: { ratePercent: null, fixedAmount: null, fixedAmountCurrency: null, minRatePercent: null, maxRatePercent: null, calculation: "percentage", compound: false, componentOrder: null },
    classification: { code: null, system: null, productCategory: null, serviceCategory: null, description: null, conditions: null, transactionType: null, placeOfSupply: null },
    effective: { effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: null },
    source: { sourceName: null, sourceUrl: null, sourceReference: null, notes: null, verification: "unverified", lastVerifiedAt: null },
    lifecycle: "draft",
  };
}
export const toInput = (r: TaxRateReference): TaxRateInput => ({ jurisdiction: r.jurisdiction, tax: r.tax, rate: r.rate, classification: r.classification, effective: r.effective, source: r.source, lifecycle: r.lifecycle === "archived" ? "published" : r.lifecycle });

/**
 * Create / edit / new-version form for one reference rate. Reference data only — saving never touches Salesforce.
 * In "version" mode only the rate and dates change; the current version is closed the day before the new Effective From.
 */
export default function RateEditor({ isDark, geo, mode, initial, current, onSave, onCancel, errors, warnings }: {
  isDark: boolean;
  geo: typeof Geo | null;
  mode: EditorMode;
  initial: TaxRateInput;
  current?: TaxRateReference | null;
  onSave: (v: TaxRateInput) => void;
  onCancel: () => void;
  errors: Issue[];
  warnings: Issue[];
}) {
  const t = tokens(isDark);
  const [v, setV] = useState<TaxRateInput>(initial);
  const locked = mode === "version";
  const subs = useMemo(() => (geo && v.jurisdiction.countryCode ? geo.subdivisionsOf(v.jurisdiction.countryCode) : []), [geo, v.jurisdiction.countryCode]);
  const err = (f: string) => errors.find(e => e.field === f)?.message;
  const up = <K extends keyof TaxRateInput>(k: K, patch: Partial<TaxRateInput[K]>) => setV(p => ({ ...p, [k]: { ...(p[k] as object), ...patch } }));
  const txt = (val: string | null | undefined) => val ?? "";
  const nOrNull = (s: string) => (s.trim() === "" ? null : Number(s));
  const i = (val: string | number | null, on: (s: string) => void, o: { type?: string; ph?: string; dis?: boolean; list?: string } = {}) => (
    <input value={val ?? ""} onChange={e => on(e.target.value)} type={o.type ?? "text"} placeholder={o.ph} disabled={o.dis} list={o.list} step={o.type === "number" ? "any" : undefined} style={{ ...inputStyle(t), opacity: o.dis ? 0.6 : 1 }} />
  );
  const help = (text: string, example?: string) => ({ text, ...(example ? { example } : {}) });
  const section = (title: string, children: ReactNode) => (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>{title}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
    </div>
  );
  const eMsg = (f: string) => (err(f) ? <span style={{ fontSize: 11, color: t.error }}>{err(f)}</span> : null);

  return (
    <div role="dialog" aria-modal="true" aria-label={mode === "version" ? "New version" : mode === "edit" ? "Edit reference rate" : "New reference rate"}
      style={{ position: "fixed", inset: 0, zIndex: Z.dialog, background: "rgba(0,5,15,0.5)", display: "flex", justifyContent: "flex-end" }}>
      <div style={{ width: "min(760px, 100vw)", height: "100%", background: t.surface, borderLeft: `1px solid ${t.border}`, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${t.border}`, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: t.accent, display: "inline-flex" }}><Ic n={mode === "version" ? "refresh" : mode === "edit" ? "edit" : "plus"} s={16} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: t.heading }}>{mode === "version" ? `New Version of ${current?.tax.taxName}` : mode === "edit" ? `Edit ${current?.tax.taxName}` : "New Reference Rate"}</div>
            <div style={{ fontSize: 11.5, color: t.dim }}>Reference data only — saving never creates or changes a Salesforce Tax Rate.</div>
          </div>
          <button onClick={onCancel} aria-label="Close" style={{ background: "transparent", border: "none", color: t.dim, cursor: "pointer" }}><Ic n="x" s={16} /></button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          {mode === "version" && current && (
            <div style={{ fontSize: 12, color: t.body, padding: "9px 12px", borderRadius: 10, border: `1px solid ${t.accent}40`, background: `${t.accent}0c` }}>
              Version {current.version} ({current.rate.ratePercent ?? "—"}%, from {current.effective.effectiveFrom}) stays in history and is closed the day before the new Effective From. Jurisdiction, tax code and classification stay the same.
            </div>
          )}
          {mode === "edit" && current?.lifecycle === "published" && (
            <div style={{ fontSize: 12, color: t.dim }}>The rate and start date of a published rate can&apos;t be overwritten — use <b>New Version</b> for a rate change. Other fields can be corrected here.</div>
          )}

          {section("Jurisdiction", <>
            <Field label="Country *" isDark={isDark} help={help("ISO 3166-1 country. Every country is available.", "India (IN)")}>
              <select value={v.jurisdiction.countryCode} disabled={locked || !geo} onChange={e => up("jurisdiction", { countryCode: e.target.value, subdivisionCode: null, subdivisionName: null })} style={inputStyle(t)}>
                <option value="">{geo ? "Select a country…" : "Loading countries…"}</option>
                {geo?.COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}
              </select>
              {eMsg("countryCode")}
            </Field>
            <Field label="Subdivision (state / province / territory)" isDark={isDark} help={help("ISO 3166-2 subdivision of the selected country. Leave as \"Country level\" for a national rate — no state is invented.", "Andhra Pradesh (IN-AP)")}>
              <select value={v.jurisdiction.subdivisionCode ?? ""} disabled={locked || !v.jurisdiction.countryCode} onChange={e => up("jurisdiction", { subdivisionCode: e.target.value || null })} style={inputStyle(t)}>
                <option value="">Country level (no subdivision)</option>
                {subs.map(s => <option key={s.code} value={s.code}>{s.level === 2 ? "— " : ""}{s.name} ({s.code})</option>)}
              </select>
              {v.jurisdiction.countryCode && subs.length === 0 && <span style={{ fontSize: 11, color: t.dim }}>This country has no ISO 3166-2 subdivisions — rates are country-level.</span>}
              {eMsg("subdivisionCode")}
            </Field>
            <Field label="Region / locality (optional)" isDark={isDark} help={help("City, county or municipality metadata for local taxes.")}>{i(txt(v.jurisdiction.locality), s => up("jurisdiction", { locality: s || null }), { dis: locked })}</Field>
          </>)}

          {section("Tax identity", <>
            <Field label="Tax Code *" isDark={isDark} help={help("The code Salesforce Tax Rates and Tax Treatments match on. It's copied as is into the Salesforce Tax Rate form.", "GST18")}>{i(v.tax.taxCode, s => up("tax", { taxCode: s }), { dis: locked })}{eMsg("taxCode")}</Field>
            <Field label="Tax Name *" isDark={isDark} help={help("Readable name.", "GST 18%")}>{i(v.tax.taxName, s => up("tax", { taxName: s }))}{eMsg("taxName")}</Field>
            <Field label="Tax Type *" isDark={isDark} help={help("Open list — pick a suggestion or type a new one.", "GST, VAT, HST, PST, QST, Sales Tax")}>{i(v.tax.taxType, s => up("tax", { taxType: s }), { dis: locked, list: "tax-type-options" })}{eMsg("taxType")}</Field>
            <Field label="Tax Structure *" isDark={isDark} help={help("How the tax is composed in this jurisdiction.", "CGST + SGST, GST + QST, HST")}>{i(v.tax.taxStructure, s => up("tax", { taxStructure: s }))}{eMsg("taxStructure")}</Field>
            <Field label="Tax Component" isDark={isDark} help={help("Set when this record is ONE component of a combined structure; leave empty for a single or combined rate.", "SGST")}>{i(txt(v.tax.taxComponent), s => up("tax", { taxComponent: s || null }), { dis: locked })}</Field>
            <Field label="Tax Authority" isDark={isDark}>{i(txt(v.tax.taxAuthority), s => up("tax", { taxAuthority: s || null }))}</Field>
            <Field label="Tax Category" isDark={isDark}>{i(txt(v.tax.taxCategory), s => up("tax", { taxCategory: s || null }))}</Field>
            <datalist id="tax-type-options">{KNOWN_TAX_TYPES.map(k => <option key={k} value={k} />)}</datalist>
          </>)}

          {section("Rate", <>
            <Field label="Calculation" isDark={isDark} help={help("Percentage, a fixed amount per unit/transaction, both, or tiered (min/max).")}>
              <select value={v.rate.calculation} onChange={e => up("rate", { calculation: e.target.value as RateCalculation })} style={inputStyle(t)}>
                <option value="percentage">Percentage</option><option value="fixed-amount">Fixed amount</option><option value="percentage-plus-fixed">Percentage + fixed amount</option><option value="tiered">Tiered (min/max)</option>
              </select>
            </Field>
            <Field label="Rate %" isDark={isDark} help={help("18 means 18%. Copied into the Salesforce Tax Rate's Rate field.", "18")}>{i(v.rate.ratePercent, s => up("rate", { ratePercent: nOrNull(s) }), { type: "number" })}{eMsg("ratePercent")}</Field>
            <Field label="Fixed amount" isDark={isDark} help={help("For fixed-amount taxes. Copied into the Salesforce Tax Rate's Flat Tax Amount where the org allows it.")}>{i(v.rate.fixedAmount, s => up("rate", { fixedAmount: nOrNull(s) }), { type: "number" })}{eMsg("fixedAmount")}</Field>
            <Field label="Fixed amount currency" isDark={isDark}>{i(txt(v.rate.fixedAmountCurrency), s => up("rate", { fixedAmountCurrency: s.toUpperCase() || null }), { ph: "e.g. INR" })}</Field>
            <Field label="Minimum rate %" isDark={isDark}>{i(v.rate.minRatePercent, s => up("rate", { minRatePercent: nOrNull(s) }), { type: "number" })}{eMsg("minRatePercent")}</Field>
            <Field label="Maximum rate %" isDark={isDark}>{i(v.rate.maxRatePercent, s => up("rate", { maxRatePercent: nOrNull(s) }), { type: "number" })}</Field>
            <Field label="Component order" isDark={isDark} help={help("Order among the components of one structure (1 = first).")}>{i(v.rate.componentOrder, s => up("rate", { componentOrder: nOrNull(s) }), { type: "number", dis: locked })}</Field>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.body, marginTop: 18 }}>
              <input type="checkbox" checked={v.rate.compound} onChange={e => up("rate", { compound: e.target.checked })} /> Compound (applied on top of other components)
            </label>
          </>)}

          {section("Product / service classification", <>
            <Field label="Classification system" isDark={isDark} help={help("The coding system the code belongs to.", "HSN, SAC, UNSPSC, Internal")}>{i(txt(v.classification.system), s => up("classification", { system: s || null }), { dis: locked })}</Field>
            <Field label="Classification code" isDark={isDark} help={help("Leave empty for a general rate. Products are matched on their actual classification metadata — never on Product Code.", "8471")}>{i(txt(v.classification.code), s => up("classification", { code: s || null }), { dis: locked })}</Field>
            <Field label="Product category" isDark={isDark}>{i(txt(v.classification.productCategory), s => up("classification", { productCategory: s || null }))}</Field>
            <Field label="Service category" isDark={isDark}>{i(txt(v.classification.serviceCategory), s => up("classification", { serviceCategory: s || null }))}</Field>
            <Field label="Transaction type" isDark={isDark} help={help("e.g. inter-state vs intra-state supply.")}>{i(txt(v.classification.transactionType), s => up("classification", { transactionType: s || null }), { dis: locked })}</Field>
            <Field label="Place-of-supply conditions" isDark={isDark}>{i(txt(v.classification.placeOfSupply), s => up("classification", { placeOfSupply: s || null }))}</Field>
            <Field label="Applicable conditions" isDark={isDark}>{i(txt(v.classification.conditions), s => up("classification", { conditions: s || null }))}</Field>
            <Field label="Classification description" isDark={isDark}>{i(txt(v.classification.description), s => up("classification", { description: s || null }))}</Field>
          </>)}

          {section("Effective dates & status", <>
            <Field label="Effective From *" isDark={isDark} help={help("First day the rate applies. Copied into the Salesforce Tax Rate's Start Date.")}>{i(v.effective.effectiveFrom, s => up("effective", { effectiveFrom: s }), { type: "date" })}{eMsg("effectiveFrom")}</Field>
            <Field label="Effective To" isDark={isDark} help={help("Last day (inclusive). Empty = open-ended. Copied into End Date.")}>{i(txt(v.effective.effectiveTo), s => up("effective", { effectiveTo: s || null }), { type: "date" })}{eMsg("effectiveTo")}</Field>
            {mode !== "version" && (
              <Field label="Lifecycle" isDark={isDark} help={help("Draft records are work in progress and never block other rates; Published rates are checked for overlapping periods. Active / Upcoming / Expired follows from the dates.")}>
                <select value={v.lifecycle} onChange={e => setV(p => ({ ...p, lifecycle: e.target.value as TaxRateInput["lifecycle"] }))} style={inputStyle(t)}>
                  <option value="draft">Draft</option><option value="published">Published</option>
                </select>
              </Field>
            )}
          </>)}

          {section("Source & verification", <>
            <Field label="Source name" isDark={isDark} help={help("Who publishes the rate.", "Canada Revenue Agency")}>{i(txt(v.source.sourceName), s => up("source", { sourceName: s || null }))}</Field>
            <Field label="Source URL" isDark={isDark}>{i(txt(v.source.sourceUrl), s => up("source", { sourceUrl: s || null }), { ph: "https://…" })}{eMsg("sourceUrl")}</Field>
            <Field label="Source reference" isDark={isDark} help={help("Notification / circular / bulletin number.")}>{i(txt(v.source.sourceReference), s => up("source", { sourceReference: s || null }))}</Field>
            <Field label="Verification" isDark={isDark} help={help("Only mark Verified after checking the rate against the source; record the date.")}>
              <select value={v.source.verification} onChange={e => up("source", { verification: e.target.value as VerificationStatus })} style={inputStyle(t)}>
                <option value="unverified">Unverified</option><option value="needs-review">Needs review</option><option value="partially-verified">Partially verified</option><option value="verified">Verified</option>
              </select>
              {eMsg("verification")}
            </Field>
            <Field label="Last verified at" isDark={isDark}>{i(txt(v.source.lastVerifiedAt), s => up("source", { lastVerifiedAt: s || null }), { type: "date" })}</Field>
            <Field label="Notes" isDark={isDark}>{i(txt(v.source.notes), s => up("source", { notes: s || null }))}</Field>
          </>)}

          {(errors.length > 0 || warnings.length > 0) && (
            <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {errors.filter(e => !["countryCode", "subdivisionCode", "taxCode", "taxName", "taxType", "taxStructure", "ratePercent", "fixedAmount", "minRatePercent", "effectiveFrom", "effectiveTo", "sourceUrl", "verification"].includes(e.field) || e.message.startsWith("Overlaps") || e.message.includes("New Version") || e.message.includes("versioned"))
                .map((e, k) => <div key={`e${k}`} style={{ fontSize: 12, color: t.error, display: "flex", gap: 6 }}><Ic n="alert" s={12} />{e.message}</div>)}
              {warnings.map((w, k) => <div key={`w${k}`} style={{ fontSize: 12, color: t.warn, display: "flex", gap: 6 }}><Ic n="alert" s={12} />{w.message}</div>)}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 18px", borderTop: `1px solid ${t.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <GhostButton label="Cancel" isDark={isDark} onClick={onCancel} />
          <PrimaryButton label={mode === "version" ? "Create New Version" : mode === "edit" ? "Save Changes" : "Add Reference Rate"} icon="check" isDark={isDark} onClick={() => onSave(v)} />
        </div>
      </div>
    </div>
  );
}
