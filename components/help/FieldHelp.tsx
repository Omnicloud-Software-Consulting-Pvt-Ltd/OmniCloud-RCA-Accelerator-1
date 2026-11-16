"use client";

import { tokens } from "@/components/data/quotes/shared";
import { TaxInfoTip } from "@/components/data/taxes/NativeTaxGuidance";
import { getFieldHelp, type FieldHelpEntry } from "@/lib/help/fieldHelp";

/**
 * The ⓘ next to a form label app-wide. Content comes from lib/help/fieldHelp.ts (by API name / label) unless `entry`
 * is given; Salesforce's own inline help (`salesforceHelp`) is shown first when present. Rendering reuses the existing
 * accessible tip (TaxInfoTip: hover, focus, tap, Escape, screen-reader text, portaled so cards never clip it) —
 * this component only supplies the content. Renders nothing when there's no help for the field.
 */
export default function FieldHelp({ isDark, label, apiName, sobject, entry, salesforceHelp }: {
  isDark: boolean;
  label?: string;
  apiName?: string;
  sobject?: string | null;
  entry?: FieldHelpEntry | null;
  /** Describe `inlineHelpText` from the connected org. */
  salesforceHelp?: string | null;
  /** Kept for call-site compatibility; the shared tip has a fixed icon size. */
  size?: number;
}) {
  const t = tokens(isDark);
  const help = entry === undefined ? getFieldHelp({ label, apiName, sobject }) : entry;
  if (!help && !salesforceHelp) return null;
  const name = (label ?? apiName ?? "").replace(/\s*\*\s*$/, "").trim();

  return (
    <TaxInfoTip isDark={isDark} label={`Help: ${name}`}>
      <span style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, lineHeight: 1.45 }}>
        {name && <b style={{ fontSize: 12, color: t.heading }}>{name}</b>}
        {salesforceHelp && <span><b style={{ color: t.accent }}>Salesforce help: </b>{salesforceHelp}</span>}
        {help && <span>{help.text}</span>}
        {help?.format && <span><b style={{ color: t.heading }}>Format: </b>{help.format}</span>}
        {help?.example && <span><b style={{ color: t.heading }}>Example: </b><code style={{ fontSize: 11, color: t.accent }}>{help.example}</code></span>}
        {help?.impact && <span style={{ color: t.dim }}><b style={{ color: t.heading }}>Impact: </b>{help.impact}</span>}
      </span>
    </TaxInfoTip>
  );
}
