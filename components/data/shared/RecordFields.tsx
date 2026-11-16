"use client";

import { useState, type ReactNode } from "react";
import { Section, Ic, Pill, tokens, type Tokens } from "@/components/data/quotes/shared";
import type { RecordDisplayMeta } from "@/lib/salesforce/recordReferences";

/**
 * Shared Overview for a single Salesforce record (Order / Contract / Quote): the record grouped into readable
 * sections. Lookups render the name resolved server-side (lib/salesforce/recordReferences.ts) with the raw Id one
 * click away; fields the org doesn't have are skipped rather than shown empty, and everything not placed in a
 * section stays reachable under "Additional Fields".
 */

/** A field slot: tried by API name first, then by Describe label, so orgs with differently-named fields still match. */
export interface RecordFieldSlot {
  label: string;
  names: string[];
  labelPattern?: RegExp;
  /** Span the full row (addresses, long text). */
  wide?: boolean;
  /** Render the value as a pill (statuses). */
  badge?: boolean;
  /** Appended to numeric values, e.g. "months". */
  unit?: string;
  /** Rendered after the label, e.g. a contextual info tip. */
  help?: ReactNode;
}

export interface RecordSectionConfig {
  title: string;
  icon: string;
  slots: RecordFieldSlot[];
  /** Also pull in any other not-yet-placed field whose API name or label matches (e.g. custom proposal fields). */
  collect?: RegExp;
}

/** The same sections with `help` attached to every slot that can show one of `names`. */
export function withSlotHelp(config: RecordSectionConfig[], names: string[], help: ReactNode): RecordSectionConfig[] {
  return config.map(s => ({ ...s, slots: s.slots.map(slot => (slot.names.some(n => names.includes(n)) ? { ...slot, help } : slot)) }));
}

export interface RecordFieldsData extends RecordDisplayMeta {
  record: Record<string, unknown>;
}

/** Audit block shared by every record overview. */
export const AUDIT_SECTION: RecordSectionConfig = {
  title: "Audit Information",
  icon: "clock",
  slots: [
    { label: "Created Date", names: ["CreatedDate"] },
    { label: "Created By", names: ["CreatedById"] },
    { label: "Last Modified Date", names: ["LastModifiedDate"] },
    { label: "Last Modified By", names: ["LastModifiedById"] },
    { label: "Last Viewed Date", names: ["LastViewedDate"] },
    { label: "Last Referenced Date", names: ["LastReferencedDate"] },
  ],
};

/** Never shown in "Additional Fields": system values with no meaning to users. Compound address/location fields are skipped by type. */
const HIDDEN_FIELDS = new Set(["Id", "attributes", "SystemModstamp", "IsDeleted"]);
const HIDDEN_TYPES = new Set(["address", "location"]);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function resolveSlot(data: RecordFieldsData, slot: RecordFieldSlot, placed: Set<string>): string | null {
  for (const n of slot.names) if (n in data.record && !placed.has(n)) return n;
  if (slot.labelPattern) {
    const hit = Object.entries(data.fields).find(([name, meta]) => slot.labelPattern!.test(meta.label) && name in data.record && !placed.has(name));
    if (hit) return hit[0];
  }
  return null;
}

export function formatDateValue(raw: string, type: string | undefined): string {
  // Date-only values are calendar dates — format in UTC so a negative offset doesn't shift them back a day.
  if (type === "date" || DATE_ONLY.test(raw)) {
    const d = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
    return isNaN(d.getTime()) ? raw : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? raw : d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatCurrencyValue(n: number, currencyIsoCode: string | null): string {
  if (currencyIsoCode) {
    try {
      return n.toLocaleString(undefined, { style: "currency", currency: currencyIsoCode, maximumFractionDigits: 2 });
    } catch {
      // Unknown ISO code — fall through to a plain number.
    }
  }
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Lay the configured sections out over the record; returns the filled sections plus every field left over. */
export function layoutRecordFields(data: RecordFieldsData, config: RecordSectionConfig[]) {
  const placed = new Set<string>();
  const sections = config.map(s => {
    const rows: { slot: RecordFieldSlot; field: string }[] = [];
    for (const slot of s.slots) {
      const field = resolveSlot(data, slot, placed);
      if (field) { placed.add(field); rows.push({ slot, field }); }
    }
    return { ...s, rows };
  });
  // `collect` runs after every explicit slot is placed, so it only ever picks up genuinely unplaced fields.
  for (const s of sections) {
    if (!s.collect) continue;
    for (const k of Object.keys(data.record)) {
      if (placed.has(k) || HIDDEN_FIELDS.has(k)) continue;
      const label = data.fields[k]?.label ?? k;
      if (s.collect.test(k) || s.collect.test(label)) { placed.add(k); s.rows.push({ slot: { label, names: [k] }, field: k }); }
    }
  }
  const extra = Object.keys(data.record)
    .filter(k => !placed.has(k) && !HIDDEN_FIELDS.has(k) && !HIDDEN_TYPES.has(data.fields[k]?.type ?? ""))
    .filter(k => { const v = data.record[k]; return v === null || typeof v !== "object"; })
    .sort((a, b) => (data.fields[a]?.label ?? a).localeCompare(data.fields[b]?.label ?? b));
  return { sections: sections.filter(s => s.rows.length > 0), extra };
}

export default function RecordFields({ isDark, data, sections: config }: { isDark: boolean; data: RecordFieldsData; sections: RecordSectionConfig[] }) {
  const t = tokens(isDark);
  const { sections, extra } = layoutRecordFields(data, config);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 440px), 1fr))", gap: 14, alignItems: "start" }}>
        {sections.map(s => (
          <Section key={s.title} title={s.title} icon={s.icon} isDark={isDark}>
            <FieldGrid>
              {s.rows.map(({ slot, field }) => (
                <FieldCell key={field} t={t} label={slot.label} wide={slot.wide} title={field} help={slot.help}>
                  <FieldValue isDark={isDark} data={data} field={field} slot={slot} />
                </FieldCell>
              ))}
            </FieldGrid>
          </Section>
        ))}
      </div>

      {extra.length > 0 && (
        <Section title={`Additional Fields (${extra.length})`} icon="list" isDark={isDark} defaultOpen={false}>
          <FieldGrid>
            {extra.map(k => (
              <FieldCell key={k} t={t} label={data.fields[k]?.label ?? k} title={k}>
                <FieldValue isDark={isDark} data={data} field={k} />
              </FieldCell>
            ))}
          </FieldGrid>
        </Section>
      )}
    </div>
  );
}

function FieldGrid({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 190px), 1fr))", gap: "16px 24px", paddingTop: 4 }}>
      {children}
    </div>
  );
}

function FieldCell({ t, label, wide, title, help, children }: { t: Tokens; label: string; wide?: boolean; title: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, gridColumn: wide ? "1 / -1" : undefined }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span title={title} style={{ fontSize: 10.5, fontWeight: 600, color: t.dim, letterSpacing: 0.5, textTransform: "uppercase" }}>{label}</span>
        {help}
      </span>
      <div style={{ fontSize: 13, color: t.heading, lineHeight: 1.45, overflowWrap: "anywhere", minWidth: 0 }}>{children}</div>
    </div>
  );
}

function FieldValue({ isDark, data, field, slot }: { isDark: boolean; data: RecordFieldsData; field: string; slot?: RecordFieldSlot }) {
  const t = tokens(isDark);
  const raw = data.record[field];
  const type = data.fields[field]?.type;
  const empty = <span style={{ color: t.dim }}>—</span>;

  const ref = data.references[field];
  if (ref) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap", maxWidth: "100%" }}>
        {ref.name
          ? <span title={`${ref.sobject ?? "Record"} Id: ${ref.id}`}>{ref.name}</span>
          : (
            <>
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}>{ref.id}</span>
              <span title="The referenced record's name couldn't be read — it may be inaccessible to your user." style={{ fontSize: 10.5, color: t.warn }}>Name unavailable</span>
            </>
          )}
        <CopyIdButton isDark={isDark} id={ref.id} />
      </span>
    );
  }

  if (raw === null || raw === undefined || raw === "") return empty;
  if (typeof raw === "boolean" || type === "boolean") {
    const yes = raw === true || raw === "true";
    return <Pill label={yes ? "Yes" : "No"} color={yes ? t.accent : t.dim} isDark={isDark} />;
  }
  if (slot?.badge) return <Pill label={String(raw)} color={t.accent} isDark={isDark} />;
  if (typeof raw === "number" && type === "currency") {
    return <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{data.formattedCurrency[field] ?? formatCurrencyValue(raw, data.currencyIsoCode)}</span>;
  }
  if (typeof raw === "number" && type === "percent") return <span style={{ fontVariantNumeric: "tabular-nums" }}>{raw.toLocaleString(undefined, { maximumFractionDigits: 2 })}%</span>;
  if (typeof raw === "number") return <span style={{ fontVariantNumeric: "tabular-nums" }}>{raw.toLocaleString()}{slot?.unit ? ` ${slot.unit}` : ""}</span>;
  if (typeof raw === "string" && (type === "date" || type === "datetime")) return <span title={raw}>{formatDateValue(raw, type)}</span>;
  if (typeof raw === "string" && type === "textarea") return <span style={{ whiteSpace: "pre-line" }}>{raw}</span>;
  return <>{String(raw)}</>;
}

function CopyIdButton({ isDark, id }: { isDark: boolean; id: string }) {
  const t = tokens(isDark);
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={copied ? "Copied" : `Copy Id ${id}`}
      aria-label={`Copy Salesforce Id ${id}`}
      onClick={() => {
        navigator.clipboard?.writeText(id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
      }}
      style={{ display: "inline-flex", alignItems: "center", padding: 3, borderRadius: 6, border: "none", background: "transparent", cursor: "pointer", color: copied ? t.accent : t.dim }}
    >
      <Ic n={copied ? "check" : "copy"} s={12} />
    </button>
  );
}
