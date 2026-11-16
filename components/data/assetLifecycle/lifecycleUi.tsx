"use client";

import type { CSSProperties, ReactNode } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, type Tokens } from "@/components/data/quotes/shared";
import type { AssetReason, AssetState, LifecycleKind } from "@/lib/assetLifecycle/types";

/**
 * Shared presentation helpers for the Assets / Amendments / Renewals / Cancellations pages — the same tokens, panels and pills as the
 * Products, Contracts and Orders modules (quotes/shared + billingUi), so the four sections look like one module.
 */

export type Section = "assets" | LifecycleKind;
export const SECTIONS: Section[] = ["assets", "amend", "renew", "cancel"];
export const SECTION_META: Record<Section, { label: string; singular: string; icon: string; color: string; verb: string; create: string }> = {
  assets: { label: "Assets", singular: "Asset", icon: "archive", color: "#00D4FF", verb: "View", create: "Browse Assets" },
  amend: { label: "Amendments", singular: "Amendment", icon: "edit", color: "#3AABFF", verb: "Amend", create: "Create Amendment" },
  renew: { label: "Renewals", singular: "Renewal", icon: "refresh", color: "#00C896", verb: "Renew", create: "Create Renewal" },
  cancel: { label: "Cancellations", singular: "Cancellation", icon: "x", color: "#FF6B8A", verb: "Cancel", create: "Create Cancellation" },
};
export const isSection = (v: unknown): v is Section => typeof v === "string" && (SECTIONS as string[]).includes(v);

export const STATE_META: Record<AssetState, { label: string; color: string }> = {
  active: { label: "Active", color: "#00C896" },
  expiring: { label: "Expiring", color: "#F59E0B" },
  expired: { label: "Expired", color: "#8A9BB5" },
  future: { label: "Future", color: "#3AABFF" },
  cancelled: { label: "Cancelled", color: "#FF4066" },
  unmanaged: { label: "Not lifecycle-managed", color: "#8A9BB5" },
};

export const fmtDate = (v: string | null | undefined) => (v ? v.slice(0, 10) : "—");
export const fmtNum = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 4 }));
export const fmtMoney = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const typeLabel = (t: string | null | undefined) => (t === "OneTime" ? "One-Time" : t === "TermDefined" ? "Term-Defined" : t === "Evergreen" ? "Evergreen" : t ?? "—");

export function Badge({ label, color, isDark, title }: { label: string; color: string; isDark: boolean; title?: string }) {
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, color, background: isDark ? `${color}1c` : `${color}1a`, border: `1px solid ${color}45`, whiteSpace: "nowrap" }}>
      <span style={{ width: 5, height: 5, borderRadius: 999, background: color }} /> {label}
    </span>
  );
}

export const StateBadge = ({ state, isDark }: { state: AssetState; isDark: boolean }) => <Badge label={STATE_META[state].label} color={STATE_META[state].color} isDark={isDark} />;

/** Eligibility for one lifecycle: "Eligible", or the first blocking reason (all reasons in the tooltip). */
export function EligibilityBadge({ reasons, isDark }: { reasons: AssetReason[]; isDark: boolean }) {
  const errors = reasons.filter(r => r.severity === "error");
  const warns = reasons.filter(r => r.severity === "warning");
  if (errors.length) return <Badge label={`Blocked · ${errors[0].code.replace(/_/g, " ").toLowerCase()}`} color="#FF4066" isDark={isDark} title={reasons.map(r => r.message).join("\n")} />;
  return <Badge label={warns.length ? `Eligible · ${warns.length} note${warns.length > 1 ? "s" : ""}` : "Eligible"} color={warns.length ? "#F59E0B" : "#00C896"} isDark={isDark} title={warns.map(r => r.message).join("\n") || undefined} />;
}

export function ReasonList({ reasons, isDark, empty }: { reasons: AssetReason[]; isDark: boolean; empty?: string }) {
  const t = tokens(isDark);
  if (!reasons.length) return empty ? <div style={{ fontSize: 12, color: "#00C896", display: "flex", gap: 6, alignItems: "center" }}><Ic n="check-circle" s={13} /> {empty}</div> : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {reasons.map((r, i) => (
        <div key={`${r.code}-${i}`} style={{ display: "flex", gap: 7, alignItems: "flex-start", fontSize: 12, color: t.body }}>
          <span style={{ color: r.severity === "error" ? t.error : t.warn, flexShrink: 0, marginTop: 1 }}><Ic n={r.severity === "error" ? "x" : "alert"} s={13} /></span>
          <span>{r.message}</span>
        </div>
      ))}
    </div>
  );
}

export function Notice({ isDark, tone, children }: { isDark: boolean; tone: "info" | "warn" | "error" | "success"; children: ReactNode }) {
  const t = tokens(isDark);
  const c = tone === "error" ? t.error : tone === "warn" ? t.warn : tone === "success" ? "#00C896" : t.accent;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, border: `1px solid ${c}45`, background: isDark ? `${c}12` : `${c}10`, fontSize: 12.5, color: t.body }}>
      <span style={{ color: c, flexShrink: 0, marginTop: 1 }}><Ic n={tone === "success" ? "check-circle" : tone === "info" ? "info" : "alert"} s={14} /></span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

export const th = (t: Tokens): CSSProperties => ({ textAlign: "left", padding: "8px 10px", fontSize: 11, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3, borderBottom: `1px solid ${t.border}`, whiteSpace: "nowrap" });
export const td = (t: Tokens): CSSProperties => ({ padding: "8px 10px", fontSize: 12.5, color: t.body, borderBottom: `1px solid ${t.border}`, verticalAlign: "top" });

export function SortTh({ t, label, col, sort, dir, onSort }: { t: Tokens; label: string; col: string; sort: string; dir: "asc" | "desc"; onSort: (col: string) => void }) {
  const active = sort === col;
  return (
    <th style={{ ...th(t), cursor: "pointer", color: active ? t.accent : t.dim }} onClick={() => onSort(col)} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{label}{active && <Ic n={dir === "asc" ? "chevron-up" : "chevron-down"} s={11} />}</span>
    </th>
  );
}

/** Table frame (horizontal scroll inside the card, never the page). */
export function TableFrame({ isDark, children }: { isDark: boolean; children: ReactNode }) {
  const t = tokens(isDark);
  return <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface }}><table style={{ width: "100%", borderCollapse: "collapse" }}>{children}</table></div>;
}

export function KeyValues({ isDark, rows }: { isDark: boolean; rows: [string, ReactNode][] }) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "10px 18px" }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>{k}</div>
          <div style={{ fontSize: 12.5, color: t.heading, fontWeight: 600, overflowWrap: "anywhere" }}>{v ?? "—"}</div>
        </div>
      ))}
    </div>
  );
}
