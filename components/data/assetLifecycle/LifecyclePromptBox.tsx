"use client";

import { useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, PrimaryButton, GhostButton, ErrorPanel } from "@/components/data/quotes/shared";
import { quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { AiIssue, AiLifecycleResult, ValueSource } from "@/lib/assetLifecycle/ai";
import type { AssetChange, AssetRow, LifecycleKind } from "@/lib/assetLifecycle/types";
import { Badge, SECTION_META } from "./lifecycleUi";
import PromptGuide from "@/components/ai/PromptGuide";
import { assetLifecyclePromptGuides, LIFECYCLE_QUICK_EXAMPLES } from "@/lib/ai/promptGuides/assetLifecycle";

export type LifecycleAiResult = AiLifecycleResult<AssetRow, AssetChange> & { aiConfigured?: boolean };

const EXAMPLES: Record<LifecycleKind | "any", string> = {
  amend: "Create an amendment for <account> named <name>. Increase <product> quantity from 2 to 5 and apply a 10% discount effective today.",
  renew: "Renew <product> for <account> for another 12 months starting December 1, 2026.",
  cancel: "Cancel the <product> asset for <account> effective today.",
  any: "e.g. “Cancel the <product> asset for <account> effective today” or “Renew <product> for <account> for 12 months”.",
};
export const SOURCE_META: Record<ValueSource, { label: string; color: string }> = {
  prompt: { label: "from your prompt", color: "#3AABFF" },
  salesforce: { label: "from Salesforce", color: "#00C896" },
  derived: { label: "calculated", color: "#B47CFF" },
};
const ISSUE_COLOR: Record<AiIssue["status"], string> = { missing: "#F59E0B", ambiguous: "#F59E0B", "not-found": "#FF4066", invalid: "#FF4066", unsupported: "#FF4066", warning: "#F59E0B" };

/**
 * Natural-language entry for a lifecycle transaction (POST /api/asset-lifecycle/ai — read-only: names are resolved against Salesforce,
 * nothing is saved or sent). The parsed result is handed to the wizard, which fills its fields for review and editing.
 */
export default function LifecyclePromptBox({ isDark, kind, onResult, compact }: {
  isDark: boolean; kind: LifecycleKind | null; onResult: (r: LifecycleAiResult) => void; compact?: boolean;
}) {
  const t = tokens(isDark);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  async function parse() {
    setBusy(true); setError(null);
    try { onResult(await quoteApiPost<LifecycleAiResult>("Interpret the request", "/api/asset-lifecycle/ai", { prompt, kind })); }
    catch (e) { setError(toErrorPanelData(e, "The request couldn't be interpreted")); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ border: `1px solid ${t.accent}40`, borderRadius: 12, padding: 12, background: isDark ? `${t.accent}08` : `${t.accent}07`, display: "flex", flexDirection: "column", gap: 8 }} data-testid="lifecycle-prompt">
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: t.heading }}>
        <span style={{ color: t.accent }}><Ic n="sparkles" s={15} /></span> Describe the {kind ? SECTION_META[kind].singular.toLowerCase() : "transaction"} <span style={{ fontWeight: 400, fontSize: 11.5, color: t.dim }}>— optional; the fields below stay editable</span>
      </div>
      <textarea aria-label="Lifecycle request prompt" value={prompt} onChange={e => setPrompt(e.target.value)} rows={compact ? 2 : 3} maxLength={4000} placeholder={EXAMPLES[kind ?? "any"]} style={{ ...inputStyle(t), resize: "vertical", fontFamily: "inherit" }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <PrimaryButton isDark={isDark} label={busy ? "Reading Salesforce…" : "Parse & preview"} icon="sparkles" disabled={busy || !prompt.trim()} onClick={() => void parse()} />
        {prompt && !busy && <GhostButton label="Clear" isDark={isDark} onClick={() => setPrompt("")} />}
        <span style={{ fontSize: 11.5, color: t.dim }}>Only reads Salesforce to match names — nothing is created until you confirm.</span>
      </div>
      {(
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }} data-testid="lifecycle-prompt-examples">
          <span style={{ fontSize: 11.5, fontWeight: 600, color: t.dim }}>Examples (click to use):</span>
          {(kind ? LIFECYCLE_QUICK_EXAMPLES[kind] : (["amend", "renew", "cancel"] as const).flatMap(k => LIFECYCLE_QUICK_EXAMPLES[k].slice(0, 1).map(ex => ({ ...ex, label: `${SECTION_META[k].singular}: ${(ex.label ?? "").toLowerCase()}` })))).map(ex => (
            <button key={ex.label} type="button" title={ex.prompt} disabled={busy} onClick={() => setPrompt(ex.prompt)}
              style={{ padding: "3px 10px", borderRadius: 999, border: `1px solid ${t.accent}50`, background: "transparent", color: t.accent, fontSize: 11.5, cursor: busy ? "not-allowed" : "pointer" }}>
              {ex.label}
            </button>
          ))}
        </div>
      )}
      {kind && <PromptGuide isDark={isDark} config={assetLifecyclePromptGuides[kind]} onUseExample={setPrompt} />}
      {error && <ErrorPanel isDark={isDark} error={error} />}
    </div>
  );
}

/** What the prompt produced: each value with its source, then everything that needs the user's attention. */
export function PromptResultPanel({ isDark, result, onCandidate, onSwitchKind, onDismiss }: {
  isDark: boolean; result: LifecycleAiResult;
  onCandidate?: (issue: AiIssue, c: { id: string; name: string }) => void;
  onSwitchKind?: () => void; onDismiss: () => void;
}) {
  const t = tokens(isDark);
  const blocking = result.issues.filter(i => i.status !== "warning");
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, background: t.surface, display: "flex", flexDirection: "column", gap: 10 }} data-testid="prompt-result">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 700, color: t.heading }}>
          Extracted from your request
          <Badge isDark={isDark} label={result.engine === "ai" ? "AI" : "Built-in rules (no AI key)"} color={result.engine === "ai" ? "#B47CFF" : "#8A9BB5"} />
          {blocking.length ? <Badge isDark={isDark} label={`${blocking.length} to resolve`} color="#F59E0B" /> : <Badge isDark={isDark} label="Ready to review" color="#00C896" />}
        </div>
        <GhostButton label="Dismiss" icon="x" isDark={isDark} onClick={onDismiss} />
      </div>
      {result.kindMismatch && result.kind && onSwitchKind && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5, color: t.body }}>
          This request is a {SECTION_META[result.kind].singular.toLowerCase()}. <PrimaryButton isDark={isDark} label={`Open as ${SECTION_META[result.kind].singular.toLowerCase()}`} icon={SECTION_META[result.kind].icon} onClick={onSwitchKind} />
        </div>
      )}
      {result.fields.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6 }}>
          {result.fields.map((f, i) => (
            <div key={`${f.label}-${i}`} style={{ fontSize: 12, color: t.body, display: "flex", flexDirection: "column", gap: 2, padding: "6px 8px", borderRadius: 8, border: `1px solid ${t.border}` }}>
              <span style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase" }}>{f.label} <Badge isDark={isDark} label={SOURCE_META[f.source].label} color={SOURCE_META[f.source].color} /></span>
              <span style={{ color: t.heading, fontWeight: 600, overflowWrap: "anywhere" }}>{f.value}</span>
            </div>
          ))}
        </div>
      )}
      {result.issues.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {result.issues.map((i, k) => (
            <div key={`${i.field}-${k}`} style={{ fontSize: 12, color: t.body, display: "flex", flexDirection: "column", gap: 4 }}>
              <span><Badge isDark={isDark} label={i.status} color={ISSUE_COLOR[i.status]} /> <b>{i.field}:</b> {i.message}</span>
              {i.candidates?.length && onCandidate ? (
                <span style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingLeft: 8 }}>
                  {i.candidates.map(c => <button key={c.id} onClick={() => onCandidate(i, c)} style={{ padding: "3px 9px", borderRadius: 8, border: `1px solid ${t.accent}60`, background: "transparent", color: t.accent, fontSize: 11.5, cursor: "pointer" }}>{c.name}{c.detail ? ` · ${c.detail}` : ""}</button>)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
