"use client";

import { useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, GhostButton, PrimaryButton, Spinner } from "@/components/data/quotes/shared";
import PromptGuide from "@/components/ai/PromptGuide";
import { quoteApiPost, toErrorPanelData } from "@/lib/quotes/client/apiClient";
import { RAMP_HELP, rampGuide, type RampHelpKey } from "@/lib/ramp/help";
import type { MergeConflict, RampAiForm } from "@/lib/ramp/aiSchema";
import type { RampAiContext, RampAiFormResult, RefStatus } from "@/lib/ramp/server/aiForms";
import { Notice } from "./rampUi";

/** A value the AI proposed that differs from what the user already has — applied only if the user clicks "Use AI value". */
export interface AiConflict { id: string; label: string; current: string; proposed: string; reference: boolean; apply: () => void }
/** What the form did with the AI result (it merges into its OWN state — this component never owns form values). */
export interface AiApplyOutcome { applied: string[]; conflicts: AiConflict[] }

const STATUS_COLOR: Record<RefStatus, string> = { resolved: "#00C875", selected: "#3B82F6", ambiguous: "#F59E0B", "not-found": "#FF4066", missing: "#FF4066", "not-mentioned": "#94A3B8" };
const SOURCE_LABEL = { explicit: "from your prompt", inferred: "inferred", salesforce: "from Salesforce" } as const;

/** Display a form value compactly. */
export function showValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.map(o => (o && typeof o === "object" ? Object.entries(o).filter(([, x]) => x !== null).map(([k, x]) => `${k} ${x}`).join(" ") : String(o))).join("; ") : "—";
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && x !== undefined && !(Array.isArray(x) && !x.length)).map(([k, x]) => `${k}: ${showValue(x)}`).join(", ");
  return String(v);
}

/**
 * AI prompt box for a RAMP form (Product Ramp Segment, Schedule, Ramp Deal, Group Ramp Deal). Calls POST /api/ramp/ai/form (READ-ONLY
 * on Salesforce, nothing saved) and hands the validated, Salesforce-resolved result to `onResult`, which merges it into the page's
 * existing form. Shows what came from the prompt vs. inferred vs. Salesforce, unresolved references, missing required fields,
 * optional fields not supplied, rejected values and conflicts with values the user already entered.
 */
export default function RampAiAssist({ isDark, form, helpKey, context, onResult, title }: {
  isDark: boolean; form: RampAiForm; helpKey: RampHelpKey; context: RampAiContext; title: string;
  onResult: (r: RampAiFormResult) => AiApplyOutcome;
}) {
  const t = tokens(isDark);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RampAiFormResult | null>(null);
  const [outcome, setOutcome] = useState<AiApplyOutcome | null>(null);
  const [done, setDone] = useState<Record<string, "used" | "kept">>({});
  const example = RAMP_HELP[helpKey].examples[0]?.prompt ?? "";

  const generate = async (text = prompt) => {
    if (!text.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await quoteApiPost<RampAiFormResult & { success?: boolean; error?: string; code?: string }>(`AI ${title}`, "/api/ramp/ai/form", { form, prompt: text, context });
      if (r.success === false) { setError(r.code === "NO_AI_KEY" ? "Add your Anthropic API key in Setup to use the AI assistant." : r.error ?? "The AI couldn't generate a configuration."); return; }
      setResult(r); setDone({}); setOutcome(onResult(r));
    } catch (e) { setError(toErrorPanelData(e, "The AI assistant failed").message); }
    finally { setBusy(false); }
  };
  const clear = () => { setPrompt(""); setResult(null); setOutcome(null); setError(null); setDone({}); };

  return (
    <div data-testid={`ramp-ai-${form}`} style={{ borderRadius: 16, padding: 14, border: `1px solid ${t.accent}45`, background: isDark ? "linear-gradient(135deg, rgba(0,212,255,0.08), rgba(30,144,255,0.04))" : "linear-gradient(135deg, rgba(0,152,204,0.07), rgba(9,104,211,0.03))", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 800, color: t.heading, flexWrap: "wrap" }}>
        <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="sparkles" s={15} /></span> {title} with AI
        <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, border: `1px solid ${t.border}`, borderRadius: 999, padding: "1px 8px" }}>OPTIONAL</span>
      </div>
      <div style={{ fontSize: 12, color: t.dim }}>Describe it in plain language — the AI fills the form below and looks up the records you name in Salesforce (read-only). You review and edit everything; nothing is saved, created or executed until you do it.</div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
        <textarea aria-label={`${title} AI prompt`} value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} maxLength={4000}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void generate(); }}
          placeholder={example ? `e.g. "${example}"` : "Describe what you want…"} style={{ ...inputStyle(t), flex: "1 1 360px", resize: "vertical", fontSize: 13, lineHeight: 1.5 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <PrimaryButton isDark={isDark} label={busy ? "Generating…" : result ? "Regenerate" : "Generate Configuration"} icon="sparkles" disabled={busy || !prompt.trim()} onClick={() => void generate()} />
          {(prompt || result) && <GhostButton isDark={isDark} label="Clear" icon="x" disabled={busy} onClick={clear} />}
        </div>
      </div>
      {example && !prompt && <button type="button" onClick={() => setPrompt(example)} style={{ alignSelf: "flex-start", fontSize: 11.5, padding: "5px 11px", borderRadius: 999, border: `1px solid ${t.border}`, background: t.surface, color: t.body, cursor: "pointer", textAlign: "left" }}>Example: {example}</button>}
      {busy && <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={13} /> Extracting the configuration, validating it and resolving records in Salesforce…</div>}
      {error && <Notice isDark={isDark} tone="error">{error}</Notice>}

      {result && outcome && (
        <div data-testid="ramp-ai-result" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Notice isDark={isDark} tone={result.missingRequired.length || result.errors.length ? "warn" : "ok"}>
            {outcome.applied.length ? <>The form below was filled in: <b>{outcome.applied.length}</b> field(s). Review and edit anything before saving.</> : "No form fields changed."}
          </Notice>
          {Object.keys(result.patch).length > 0 && (
            <div style={{ display: "grid", gap: 3 }}>
              {Object.entries(result.patch).filter(([k]) => !/Id$/.test(k)).map(([k, v]) => (
                <div key={k} style={{ fontSize: 12, color: t.body }}>
                  <b style={{ color: t.heading }}>{k}</b>: {showValue(v)} <span style={{ fontSize: 10.5, color: result.sources[k] === "explicit" ? "#00C875" : result.sources[k] === "salesforce" ? "#3B82F6" : t.warn }}>({SOURCE_LABEL[result.sources[k] ?? "inferred"]})</span>
                </div>
              ))}
            </div>
          )}
          {result.references.length > 0 && (
            <div style={{ display: "grid", gap: 3 }}>
              {result.references.map((r, i) => (
                <div key={i} style={{ fontSize: 12, color: t.body }}>
                  <b style={{ color: STATUS_COLOR[r.status] }}>{r.status}</b> · {r.message}
                  {r.candidates?.length ? <div style={{ marginLeft: 12, color: t.dim, fontSize: 11.5 }}>Candidates: {r.candidates.map(c => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join(" · ")} — pick one in the form.</div> : null}
                </div>
              ))}
            </div>
          )}
          {outcome.conflicts.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: t.dim, textTransform: "uppercase" }}>Your values were kept — confirm any change</div>
              {outcome.conflicts.map(c => (
                <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: t.body, padding: "6px 10px", borderRadius: 10, border: `1px solid ${t.warn}55`, background: `${t.warn}10` }}>
                  <span style={{ flex: "1 1 260px" }}><b>{c.label}</b>{c.reference && " (Salesforce record)"}: yours <code>{c.current}</code> → AI <code>{c.proposed}</code></span>
                  {done[c.id] ? <span style={{ color: t.dim }}>{done[c.id] === "used" ? "AI value applied" : "kept yours"}</span> : <>
                    <GhostButton isDark={isDark} label="Use AI value" onClick={() => { c.apply(); setDone(d => ({ ...d, [c.id]: "used" })); }} />
                    <GhostButton isDark={isDark} label="Keep mine" onClick={() => setDone(d => ({ ...d, [c.id]: "kept" }))} />
                  </>}
                </div>
              ))}
            </div>
          )}
          {result.missingRequired.length > 0 && <Notice isDark={isDark} tone="warn"><b>Still required:</b> {result.missingRequired.join(", ")} — fill them in the form.</Notice>}
          {result.errors.map((e, i) => <Notice key={`e${i}`} isDark={isDark} tone="error">{e}</Notice>)}
          {result.warnings.map((w, i) => <Notice key={`w${i}`} isDark={isDark} tone="warn">{w}</Notice>)}
          {result.rejected.length > 0 && <Notice isDark={isDark} tone="warn"><b>Ignored from the AI:</b> {result.rejected.map(r => `${r.key} — ${r.reason}`).join("; ")}</Notice>}
          {result.optionalNotSupplied.length > 0 && <div style={{ fontSize: 11.5, color: t.dim }}>Optional, not supplied: {result.optionalNotSupplied.join(", ")}.</div>}
          {result.notes.map((n, i) => <div key={`n${i}`} style={{ fontSize: 11.5, color: t.dim }}>• {n}</div>)}
        </div>
      )}
      <PromptGuide isDark={isDark} config={rampGuide(helpKey)} onUseExample={setPrompt} />
    </div>
  );
}

/** Turn mergeAiPatch conflicts into UI conflicts whose "Use AI value" applies the conflict's patch through the form's own setter. */
export function uiConflicts<T>(conflicts: MergeConflict<T>[], applyPatch: (p: Partial<T>) => void, prefix = ""): AiConflict[] {
  return conflicts.map(c => ({ id: `${prefix}${c.key}`, label: c.label, current: showValue(c.current), proposed: showValue(c.proposed), reference: c.reference, apply: () => applyPatch(c.patch) }));
}

/** The page-level help panel (same <PromptGuide> design) for RAMP pages without an AI prompt, or above a page. */
export function RampHelpPanel({ isDark, helpKey }: { isDark: boolean; helpKey: RampHelpKey }) {
  return <div data-testid={`ramp-help-${helpKey}`}><PromptGuide isDark={isDark} config={rampGuide(helpKey)} collapsedLabel={`Help — ${RAMP_HELP[helpKey].title}: overview, required & optional fields, prerequisites, examples`} /></div>;
}
