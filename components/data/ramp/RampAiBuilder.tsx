"use client";

import { useState } from "react";
import { tokens, PrimaryButton, CodeBlock } from "@/components/data/quotes/shared";
import { quoteApiPost, toErrorPanelData } from "@/lib/quotes/client/apiClient";
import type { RampDealDraft } from "@/lib/ramp/types";
import { Notice, Panel } from "./rampUi";

type AiResult = { success: boolean; code?: string; error?: string; draft: Partial<RampDealDraft>; resolved: { field: string; status: string; message: string; candidates?: { id: string; name: string }[] }[]; missing: string[]; notes: string[]; extraction: Record<string, unknown> };

const EXAMPLES = [
  "Create a 3-year ramp for Acme on quote Q-1001, line Cloud Storage: 10% uplift each year, quantity 100 → 150 → 200.",
  "Group ramp for the 'Platform Bundle' group on quote 'Acme Renewal', quarterly segments for 1 year, 2% compound uplift per quarter.",
  "Ramp quote Globex 2027: 6-month free trial, then 2 yearly segments at +5%.",
];

/** AI Ramp Builder — prompt → editable draft. NOTHING is saved or executed until the user reviews it in the deal editor. */
export default function RampAiBuilder({ isDark, onOpenDraft }: { isDark: boolean; onOpenDraft: (d: Partial<RampDealDraft>) => void }) {
  const t = tokens(isDark);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AiResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await quoteApiPost<AiResult>("AI Ramp Builder", "/api/ramp/ai", { prompt });
      if (r.success === false) setErr(r.code === "NO_AI_KEY" ? "Add your Anthropic API key in Setup to use the AI Ramp Builder." : r.error ?? "The AI couldn't build a draft.");
      else setRes(r);
    } catch (e) { setErr(toErrorPanelData(e, "The AI Ramp Builder failed").message); }
    finally { setBusy(false); }
  };
  const color = (s: string) => (s === "resolved" ? "#00C875" : s === "ambiguous" ? t.warn : t.error);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Notice isDark={isDark} tone="info">Describe a ramp in plain language. The AI extracts it, the app <b>resolves names against your Salesforce org (read-only)</b>, and you get an editable draft. Nothing is saved or written to Salesforce until you review, save and confirm execution.</Notice>
      <Panel isDark={isDark} title="Describe the ramp" icon="sparkles">
        <textarea aria-label="Ramp description" value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} maxLength={4000} placeholder="e.g. 3-year ramp on quote Q-1001 line Cloud Storage, +10% per year"
          style={{ width: "100%", boxSizing: "border-box", padding: 10, borderRadius: 10, border: `1px solid ${t.border}`, background: t.inputBg, color: t.heading, fontSize: 13, fontFamily: "inherit", resize: "vertical" }} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{EXAMPLES.map(e => <button key={e} type="button" onClick={() => setPrompt(e)} style={{ fontSize: 11.5, padding: "4px 8px", borderRadius: 999, border: `1px solid ${t.border}`, background: t.surfaceAlt, color: t.body, cursor: "pointer", textAlign: "left" }}>{e}</button>)}</div>
        <div><PrimaryButton isDark={isDark} label={busy ? "Building draft…" : "Build draft"} icon="sparkles" disabled={busy || !prompt.trim()} onClick={() => void run()} /></div>
        {err && <Notice isDark={isDark} tone="error">{err}</Notice>}
      </Panel>
      {res && (
        <Panel isDark={isDark} title={`Draft: ${res.draft.name ?? "ramp deal"} (${res.draft.kind ?? "line"} ramp)`} icon="file-text" right={<PrimaryButton isDark={isDark} label="Review in deal editor" icon="edit" onClick={() => onOpenDraft(res.draft)} />}>
          <div style={{ display: "grid", gap: 4 }}>{res.resolved.map((r, i) => (
            <div key={i} style={{ fontSize: 12.5 }}><b style={{ color: color(r.status) }}>{r.status}</b> · {r.field}: {r.message}{r.candidates?.length ? <span style={{ color: t.dim }}> — candidates: {r.candidates.map(c => c.name).join(", ")}</span> : null}</div>))}</div>
          {res.missing.length > 0 && <Notice isDark={isDark} tone="warn"><b>Still needed:</b> {res.missing.join(", ")} — fill them in the editor.</Notice>}
          {res.notes.map((n, i) => <div key={i} style={{ fontSize: 12, color: t.dim }}>• {n}</div>)}
          <CodeBlock isDark={isDark} label="AI extraction" data={res.extraction} />
        </Panel>
      )}
    </div>
  );
}
