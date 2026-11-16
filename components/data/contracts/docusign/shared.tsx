"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Ic, Pill, PrimaryButton, tokens } from "@/components/data/quotes/shared";
import { quoteApiGet } from "@/lib/quotes/client/apiClient";
import { serverSecurityMessage, type ConnectionStatus, type ConnectionStatusResponse, type EnvelopeView } from "@/lib/contracts/docusign/types";

/** Small building blocks shared by the DocuSign screens inside Contracts. */

export const STATUS_META: Record<ConnectionStatus, { label: string; tone: "ok" | "warn" | "bad" | "idle"; icon: string }> = {
  setup_required: { label: "Temporarily unavailable", tone: "warn", icon: "lock" },
  connected: { label: "Connected", tone: "ok", icon: "check-circle" },
  not_connected: { label: "Not connected", tone: "idle", icon: "link" },
  expired: { label: "Connection expired", tone: "warn", icon: "clock" },
  reauthorization_required: { label: "Reauthorization required", tone: "warn", icon: "lock" },
  error: { label: "Connection error", tone: "bad", icon: "alert" },
};

export function toneColor(isDark: boolean, tone: "ok" | "warn" | "bad" | "idle" | EnvelopeView["statusTone"]): string {
  const t = tokens(isDark);
  if (tone === "ok" || tone === "success") return "#22C55E";
  if (tone === "progress") return t.accent;
  if (tone === "warn") return t.warn;
  if (tone === "bad" || tone === "danger") return t.error;
  return t.dim;
}

export function ConnectionBadge({ isDark, status }: { isDark: boolean; status: ConnectionStatus }) {
  const m = STATUS_META[status];
  return <Pill isDark={isDark} label={m.label} color={toneColor(isDark, m.tone)} />;
}

export function EnvelopeStatusPill({ isDark, envelope }: { isDark: boolean; envelope: Pick<EnvelopeView, "statusLabel" | "statusTone"> }) {
  return <Pill isDark={isDark} label={envelope.statusLabel} color={toneColor(isDark, envelope.statusTone)} />;
}

/** Loads the connection status for this Salesforce session. */
export function useDocuSignStatus() {
  const [data, setData] = useState<ConnectionStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    quoteApiGet<ConnectionStatusResponse>("Load DocuSign connection status", "/api/contracts/docusign/status")
      .then(r => { if (live) { setData(r); setError(null); } })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : "Couldn't load the DocuSign status."); });
    return () => { live = false; };
  }, [nonce]);
  const reload = useCallback(() => setNonce(n => n + 1), []);
  return { data, error, reload, setData };
}

export function CopyField({ isDark, label, value, hint }: { isDark: boolean; label: string; value: string; hint?: string }) {
  const t = tokens(isDark);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }).catch(() => {});
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: t.dim, letterSpacing: 0.3, textTransform: "uppercase" }}>{label}</span>
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <code style={{ flex: 1, padding: "9px 12px", borderRadius: 9, fontSize: 12.5, background: t.inputBg, border: `1px solid ${t.inputBorder}`, color: t.heading, wordBreak: "break-all" }}>{value}</code>
        <button type="button" onClick={copy} title="Copy" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "0 12px", borderRadius: 9, border: `1px solid ${t.border}`, background: "transparent", color: copied ? "#22C55E" : t.body, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
          <Ic n={copied ? "check" : "copy"} s={13} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {hint && <span style={{ fontSize: 11, color: t.dim }}>{hint}</span>}
    </div>
  );
}

/** Shown instead of a signing screen when DocuSign isn't usable yet. */
export function ConnectGate({ isDark, status, onOpenSettings }: { isDark: boolean; status: ConnectionStatusResponse | null; onOpenSettings?: () => void }) {
  const hint = !status ? "Checking your DocuSign connection…"
    : !status.encryptionReady ? serverSecurityMessage(status.serverSetup?.reason ?? null)
    : status.status === "reauthorization_required" ? "Your Salesforce sign-in changed since DocuSign was connected. Reconnect DocuSign to continue."
    : "Connect your DocuSign account once in DocuSign Settings — it takes about five minutes and the page walks you through it.";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <EmptyState isDark={isDark} icon="link" title={status && !status.encryptionReady ? "DocuSign temporarily unavailable" : status?.status === "reauthorization_required" ? "Reconnect DocuSign" : "Connect DocuSign first"} hint={hint} />
      {status?.encryptionReady && onOpenSettings && <PrimaryButton isDark={isDark} label="Open DocuSign Settings" icon="sliders" onClick={onOpenSettings} />}
    </div>
  );
}

export const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
export const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function Note({ isDark, tone = "info", children }: { isDark: boolean; tone?: "info" | "warn" | "ok" | "bad"; children: React.ReactNode }) {
  const t = tokens(isDark);
  const color = tone === "warn" ? t.warn : tone === "ok" ? "#22C55E" : tone === "bad" ? t.error : t.accent;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, border: `1px solid ${color}40`, background: `${color}12`, color: t.body, fontSize: 12.5, lineHeight: 1.5 }}>
      <span style={{ color, marginTop: 1 }}><Ic n={tone === "ok" ? "check-circle" : tone === "info" ? "info" : "alert"} s={14} /></span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
