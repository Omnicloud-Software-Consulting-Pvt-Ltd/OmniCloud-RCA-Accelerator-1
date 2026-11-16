"use client";

import { useId, useState, type ReactNode } from "react";
import { Ic, Section, tokens, TECHNICAL_DETAILS_LABEL } from "@/components/data/quotes/shared";
import { splitWarnings } from "@/lib/ui/diagnostics";

/**
 * Secondary / diagnostic content is HIDDEN by default app-wide — AI analysis, Salesforce configuration notes (assumptions),
 * non-blocking warnings, record-resolution detail and technical payloads. The screen shows only what the user needs to configure
 * and create the record; the rest is one click away behind a consistently labelled control. Blocking/actionable errors are never
 * put in a Disclosure — they stay visible where they are.
 *
 * State is local to the mounted section, so it survives ordinary form edits and re-analysis (it never auto-expands after Analyze &
 * Verify), and resets only when the section itself goes away.
 */
export const DISCLOSURE_LABELS = {
  ai: "View AI Analysis Details",
  config: "View Salesforce Configuration Notes",
  warnings: "View Warnings & Diagnostics",
  records: "View Resolved Salesforce Records",
  technical: TECHNICAL_DETAILS_LABEL,
} as const;

export interface DisclosureProps {
  isDark: boolean;
  label: string;
  /** Number of items inside — shown next to the label so hidden warnings/notes are still discoverable. */
  count?: number;
  /** "warn" colours the count (there are warnings to look at); "neutral" for notes/analysis. */
  tone?: "neutral" | "warn";
  icon?: string;
  /** "card" = the app's accordion card (Section) for full-width panels; "inline" = a compact toggle inside an existing card. */
  variant?: "card" | "inline";
  children: ReactNode;
}

export function Disclosure({ isDark, label, count, tone = "neutral", icon, variant = "inline", children }: DisclosureProps) {
  const t = tokens(isDark);
  const badge = count !== undefined && count > 0 ? (
    <span style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 999, color: tone === "warn" ? t.warn : t.dim, border: `1px solid ${tone === "warn" ? `${t.warn}66` : t.border}` }}>
      {count}
    </span>
  ) : null;

  if (variant === "card") {
    return <Section title={label} icon={icon ?? (tone === "warn" ? "alert" : "info")} isDark={isDark} defaultOpen={false} right={badge}>{children}</Section>;
  }
  return <InlineDisclosure isDark={isDark} label={label} badge={badge} icon={icon}>{children}</InlineDisclosure>;
}

function InlineDisclosure({ isDark, label, badge, icon, children }: { isDark: boolean; label: string; badge: ReactNode; icon?: string; children: ReactNode }) {
  const t = tokens(isDark);
  const [open, setOpen] = useState(false);
  const regionId = useId();
  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen(v => !v)}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 0", border: "none", background: "transparent", cursor: "pointer", color: t.dim, fontSize: 11.5, fontWeight: 600 }}>
        <Ic n={open ? "chevron-down" : "chevron-right"} s={13} />
        {icon && <Ic n={icon} s={12} />}
        <span style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{label}</span>
        {badge}
      </button>
      <div id={regionId} role="region" aria-label={label} hidden={!open} style={{ marginTop: 6 }}>{children}</div>
    </div>
  );
}

/**
 * Non-blocking warnings behind "View Warnings & Diagnostics (n)". A warning that reports a failed/unconfirmed create, save,
 * activation or deployment (lib/ui/diagnostics.ts) is NOT hidden — it stays on screen above the toggle. Renders nothing when empty.
 */
export function WarningsDisclosure({ isDark, warnings, variant = "inline", label = DISCLOSURE_LABELS.warnings }: {
  isDark: boolean; warnings: ReadonlyArray<ReactNode>; variant?: "card" | "inline"; label?: string;
}) {
  const t = tokens(isDark);
  if (!warnings.length) return null;
  const { visible, hidden } = splitWarnings(warnings);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {visible.map((w, i) => (
        <div key={`v${i}`} role="alert" style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12, color: t.warn, fontWeight: 600 }}>
          <span style={{ flexShrink: 0, marginTop: 1, display: "inline-flex" }}><Ic n="alert" s={12} /></span><span>{w}</span>
        </div>
      ))}
      {hidden.length > 0 && (
        <Disclosure isDark={isDark} label={label} count={hidden.length} tone="warn" variant={variant}>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: t.body, display: "flex", flexDirection: "column", gap: 4 }}>
            {hidden.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

/** Salesforce configuration notes / assumptions behind "View Salesforce Configuration Notes (n)". Renders nothing when empty. */
export function ConfigNotesDisclosure({ isDark, notes, variant = "inline" }: { isDark: boolean; notes: ReadonlyArray<ReactNode>; variant?: "card" | "inline" }) {
  const t = tokens(isDark);
  if (!notes.length) return null;
  return (
    <Disclosure isDark={isDark} label={DISCLOSURE_LABELS.config} count={notes.length} icon="shield" variant={variant}>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: t.body, display: "flex", flexDirection: "column", gap: 4 }}>
        {notes.map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </Disclosure>
  );
}
