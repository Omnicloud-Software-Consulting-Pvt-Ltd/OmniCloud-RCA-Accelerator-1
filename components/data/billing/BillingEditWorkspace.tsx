"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, PrimaryButton, GhostButton, PageShell, FooterBar, Spinner, ErrorPanel, CodeBlock } from "@/components/data/quotes/shared";
import BillingRecordForm, { BillingLinksEditor } from "@/components/data/billing/BillingRecordForm";
import { ResolvedRecords } from "@/components/data/billing/BillingCreateWorkspace";
import { Panel, IssueList, ValidationChecklist, PipelineSteps, LoadingRow, StatusPill } from "@/components/data/billing/billingUi";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiGet, quoteApiPatch, quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { draftFingerprint, fetchBillingSchema, toBillingErrorPanel } from "@/lib/billing/client";
import { formatRelativeTime } from "@/lib/dashboard/relativeTime";
import { getBillingModule } from "@/lib/billing/registry";
import type {
  BillingAnalysisResult, BillingDraftLink, BillingDraftRecord, BillingEditContext, BillingModuleSchema,
  BillingReferenceValue, BillingUpdateResponse, BillingValidationResult,
} from "@/lib/billing/types";
import { Disclosure, DISCLOSURE_LABELS, WarningsDisclosure, ConfigNotesDisclosure } from "@/components/ui/Disclosure";
import PromptGuide from "@/components/ai/PromptGuide";
import { billingPromptGuides } from "@/lib/ai/promptGuides/billing";

/** Edit-prompt examples per module — phrased as changes to the open record. */
const EDIT_EXAMPLES: Record<string, string[]> = {
  "billing-policies": [
    "Set this billing policy to Active and use Keyboard Monthly Billing Treatment as the default treatment.",
    "Link this billing policy to the Keyboard product.",
  ],
  "billing-treatments": [
    "Change this billing treatment from Draft to Active.",
    "Associate this treatment with the Keyboard Monthly Billing Policy.",
    "Change the treatment to milestone billing.",
  ],
  "billing-treatment-items": [
    "Change this Treatment Item from Draft to Active.",
    "Change the Billing Type from Advance to Arrears.",
  ],
};

const HEALTH_ICON = { ok: "check-circle", warning: "alert", error: "x" } as const;

/**
 * Edit / Configure an EXISTING billing record. Same Salesforce-backed schema and form as Create,
 * loaded with the record's live values:
 *
 *   Existing record → (optional) AI edit prompt → structured changes applied to the form →
 *   user review → Validate Changes (incl. Status transition readiness) → Change summary →
 *   Save Changes (PATCH of the SAME Id + relationship updates, all-or-nothing) → Details + History.
 *
 * Save is enabled only when the CURRENT edits (fingerprint) passed server-side validation and
 * actually change something.
 */
export default function BillingEditWorkspace({ isDark, moduleKey, recordId, onCancel, onSaved, onOpenRecord, onEditRecord, onCreateChild }: {
  isDark: boolean;
  moduleKey: string;
  recordId: string;
  onCancel: () => void;
  onSaved: (id: string) => void;
  onOpenRecord: (moduleKey: string, id: string) => void;
  onEditRecord: (moduleKey: string, id: string) => void;
  onCreateChild: (moduleKey: string, references: Record<string, BillingReferenceValue>) => void;
}) {
  const t = tokens(isDark);
  const def = getBillingModule(moduleKey)!;
  const notifySalesforceSuccess = useSalesforceSuccess();

  const [ctx, setCtx] = useState<BillingEditContext | null>(null);
  const [schema, setSchema] = useState<BillingModuleSchema | null>(null);
  const [loadError, setLoadError] = useState<ErrorPanelDataLike | null>(null);
  const [draft, setDraft] = useState<BillingDraftRecord | null>(null);
  const [links, setLinks] = useState<BillingDraftLink[]>([]);
  const [prompt, setPrompt] = useState("");
  const [analysis, setAnalysis] = useState<BillingAnalysisResult | null>(null);
  const [validation, setValidation] = useState<BillingValidationResult | null>(null);
  const [validatedFp, setValidatedFp] = useState<string | null>(null);
  const [attemptedFp, setAttemptedFp] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "analyze" | "validate" | "save">(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [touched, setTouched] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      quoteApiGet<BillingEditContext>(`Load ${def.singular} for editing`, `/api/billing/${moduleKey}/${recordId}/edit`),
      fetchBillingSchema(moduleKey),
    ])
      .then(([c, s]) => { if (cancelled) return; setCtx(c); setSchema(s); setDraft(c.draft); setLinks(c.links); })
      .catch(err => { if (!cancelled) setLoadError(toBillingErrorPanel(err, `Could not load this ${def.singular} from Salesforce`)); });
    return () => { cancelled = true; };
  }, [moduleKey, recordId, def.singular]);

  const fp = useMemo(() => draftFingerprint(draft, links.map(l => ({ ...l, enabled: true }))), [draft, links]);
  const originalFp = useMemo(() => (ctx ? draftFingerprint(ctx.draft, ctx.links.map(l => ({ ...l, enabled: true }))) : null), [ctx]);
  const dirty = !!ctx && fp !== originalFp;
  const isCurrent = !!validation && validatedFp === fp;
  const changes = isCurrent ? validation!.changes ?? [] : [];
  const canSave = isCurrent && !!validation?.valid && changes.length > 0 && !busy && !ctx?.recordLock;

  async function runValidation(d: BillingDraftRecord, l: BillingDraftLink[]) {
    const snapshot = draftFingerprint(d, l.map(x => ({ ...x, enabled: true })));
    setAttemptedFp(snapshot);
    setBusy(b => b ?? "validate");
    setError(null);
    try {
      const res = await quoteApiPost<{ validation: BillingValidationResult }>(`Validate ${def.singular} changes`, `/api/billing/${moduleKey}/${recordId}/validate`, { draft: d, links: l });
      setValidation(res.validation);
      setValidatedFp(snapshot);
    } catch (err) {
      setError(toBillingErrorPanel(err, "Validation failed"));
    } finally {
      setBusy(b => (b === "validate" ? null : b));
    }
  }

  // After the first edit, keep validation in step with changes (debounced); Save waits for it.
  useEffect(() => {
    if (!touched || !draft || busy || !dirty || fp === validatedFp || fp === attemptedFp) return;
    const handle = setTimeout(() => { void runValidation(draft, links); }, 900);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp, touched, busy, validatedFp, attemptedFp, dirty]);

  async function analyze() {
    if (!prompt.trim() || !draft) return;
    setBusy("analyze");
    setError(null);
    try {
      const res = await quoteApiPost<BillingAnalysisResult>(`AI edit ${def.singular}`, "/api/billing/ai/analyze", { prompt, moduleKey, recordId });
      setAnalysis(res);
      setDraft(res.draft);
      setLinks(res.links);
      setValidation(res.validation);
      setValidatedFp(draftFingerprint(res.draft, res.links.map(l => ({ ...l, enabled: true }))));
      setTouched(true);
    } catch (err) {
      setError(toBillingErrorPanel(err, "AI analysis failed"));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!draft || !canSave) return;
    setBusy("save");
    setError(null);
    try {
      const res = await quoteApiPatch<BillingUpdateResponse>(`Save ${def.singular} changes`, `/api/billing/${moduleKey}/${recordId}`, { draft, links });
      notifySalesforceSuccess({
        title: `${def.singular} Updated`,
        message: `${res.name}: ${res.changes.map(c => `${c.label} ${c.from ?? "—"} → ${c.to ?? "—"}`).join(" · ")}`,
        records: [{ objectApiName: schema?.sobject ?? "", recordId: res.id, recordName: res.name, salesforceUrl: res.salesforceUrl }],
      });
      onSaved(res.id);
    } catch (err) {
      const panel = toBillingErrorPanel(err, `Salesforce didn't save the ${def.singular} changes`);
      setError(panel);
      const raw = panel.raw as { validation?: BillingValidationResult } | undefined;
      if (raw?.validation) { setValidation(raw.validation); setValidatedFp(fp); }
    } finally {
      setBusy(null);
    }
  }

  if (loadError) return <div style={{ padding: 20 }}><ErrorPanel isDark={isDark} error={loadError} /></div>;
  if (!ctx || !schema || !draft) return <div style={{ padding: 20 }}><LoadingRow isDark={isDark} label={`Loading ${def.singular} from Salesforce…`} /></div>;

  const transition = isCurrent ? validation!.transition : null;
  const errorCount = isCurrent ? validation!.issues.filter(i => i.severity === "error").length : 0;
  const stateLabel = busy === "save" ? { text: "Saving to Salesforce…", color: t.accent }
    : !dirty ? { text: "No changes yet", color: t.dim }
    : busy === "validate" || (touched && !isCurrent && fp !== attemptedFp) ? { text: "Validating changes against Salesforce…", color: t.accent }
    : !isCurrent ? { text: "Changes not validated — press Validate Changes", color: t.warn }
    : validation!.valid ? { text: `✓ Valid — ${changes.length} change${changes.length === 1 ? "" : "s"} ready to save`, color: "#00C875" }
    : { text: `✗ ${errorCount} issue${errorCount > 1 ? "s" : ""} to fix`, color: t.error };

  const footer = (
    <FooterBar isDark={isDark}>
      <GhostButton label="Cancel" icon="x" isDark={isDark} onClick={onCancel} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: stateLabel.color, display: "inline-flex", alignItems: "center", gap: 6 }}>
          {(busy === "validate" || busy === "save") && <Spinner isDark={isDark} size={12} />}{stateLabel.text}
        </span>
        <GhostButton label={busy === "validate" ? "Validating…" : "Validate Changes"} icon="check-circle" isDark={isDark} disabled={!!busy || !dirty} onClick={() => { setTouched(true); void runValidation(draft, links); }} />
        <PrimaryButton label={busy === "save" ? "Saving…" : "Save Changes"} icon="save" isDark={isDark} disabled={!canSave} onClick={save} />
      </div>
    </FooterBar>
  );

  return (
    <PageShell footer={footer}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {/* ── Header ── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4 }}>Edit {def.singular} · {schema.sobject}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>{ctx.name}</span>
              <StatusPill status={ctx.status} isDark={isDark} />
            </div>
            <div style={{ fontSize: 11.5, color: t.dim }}>Salesforce record <code>{recordId}</code>{ctx.lastModifiedDate ? ` · last modified ${formatRelativeTime(ctx.lastModifiedDate)}` : ""}</div>
          </div>
          <a href={ctx.salesforceUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 13px", borderRadius: 9, fontSize: 12.5, fontWeight: 600, color: t.accent, textDecoration: "none", border: `1px solid ${t.border}` }}>
            <Ic n="external-link" s={13} /> Open in Salesforce
          </a>
        </div>

        {/* ── Configuration health (from Salesforce) ── */}
        {ctx.health.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {ctx.health.map((h, i) => {
              const c = h.status === "ok" ? "#00C875" : h.status === "warning" ? t.warn : t.error;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.body, padding: "7px 12px", borderRadius: 10, border: `1px solid ${c}45`, background: `${c}0c` }}>
                  <span style={{ color: c, display: "inline-flex" }}><Ic n={HEALTH_ICON[h.status]} s={13} /></span>{h.message}
                </div>
              );
            })}
          </div>
        )}
        {ctx.recordLock && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 600, color: t.body, padding: "10px 14px", borderRadius: 12, border: `1px solid ${t.error}55`, background: `${t.error}0e` }}>
            <span style={{ color: t.error, display: "inline-flex" }}><Ic n="lock" s={14} /></span>{ctx.recordLock}
          </div>
        )}

        {/* ── AI Edit Prompt ── */}
        {!ctx.recordLock && (
          <div style={{ borderRadius: 16, padding: 16, border: `1px solid ${t.accent}45`, background: isDark ? "linear-gradient(135deg, rgba(0,212,255,0.08), rgba(30,144,255,0.04))" : "linear-gradient(135deg, rgba(0,152,204,0.07), rgba(9,104,211,0.03))" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 800, color: t.heading }}>
              <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="sparkles" s={15} /></span> AI Edit Prompt
              <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, border: `1px solid ${t.border}`, borderRadius: 999, padding: "1px 8px" }}>OPTIONAL</span>
            </div>
            <div style={{ fontSize: 12, color: t.dim, margin: "4px 0 10px" }}>Describe what you want to change. The AI updates the fields below from Salesforce data — nothing is saved until you review, validate and press Save Changes.</div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <textarea value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void analyze(); }} rows={2}
                placeholder="Describe what you want to change…" style={{ ...inputStyle(t), flex: "1 1 380px", resize: "vertical", fontSize: 13.5 }} />
              <PrimaryButton label={busy === "analyze" ? "Analyzing…" : "Analyze & Verify"} icon="sparkles" isDark={isDark} disabled={!prompt.trim() || !!busy} onClick={analyze} />
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
              {(EDIT_EXAMPLES[moduleKey] ?? []).map(ex => (
                <button key={ex} onClick={() => setPrompt(ex)} style={{ fontSize: 11.5, padding: "5px 11px", borderRadius: 999, border: `1px solid ${t.border}`, background: t.surface, color: t.body, cursor: "pointer", textAlign: "left" }}>{ex}</button>
              ))}
            </div>
            {busy === "analyze" && <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={13} /> Reading the requested changes, resolving records in Salesforce and validating…</div>}
            <div style={{ marginTop: 10 }}><PromptGuide isDark={isDark} config={billingPromptGuides.editRecord} onUseExample={setPrompt} /></div>
          </div>
        )}

        {error && <ErrorPanel isDark={isDark} error={error} />}

        {analysis && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Panel isDark={isDark} title="Requested changes" icon="edit">
              {(analysis.changes ?? []).length === 0
                ? <div style={{ fontSize: 12, color: t.dim }}>The AI didn&apos;t find any change it could apply.</div>
                : <ChangeList isDark={isDark} changes={analysis.changes!} />}
              {analysis.unresolvedReferences.map((u, i) => (
                <div key={i} style={{ marginTop: 8, fontSize: 12, color: t.error, fontWeight: 600 }}>✗ {u.label} &ldquo;{u.searchedName}&rdquo; was not found in Salesforce — pick it with the lookup below.</div>
              ))}
              {(analysis.assumptions.length > 0 || analysis.warnings.length > 0) && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  <ConfigNotesDisclosure isDark={isDark} notes={analysis.assumptions} />
                  <WarningsDisclosure isDark={isDark} warnings={analysis.warnings} />
                </div>
              )}
            </Panel>
            {/* Secondary detail — hidden until asked for (never auto-expanded by Analyze & Verify). */}
            <Disclosure isDark={isDark} variant="card" icon="cpu" label={DISCLOSURE_LABELS.ai}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                <div style={{ fontSize: 13, color: t.heading, fontWeight: 600 }}>{analysis.summary}</div>
                <span style={{ fontSize: 11, fontWeight: 700, color: analysis.confidence >= 0.75 ? "#00C875" : t.warn }}>{Math.round(analysis.confidence * 100)}% confidence</span>
              </div>
              <PipelineSteps isDark={isDark} steps={analysis.pipeline} />
            </Disclosure>
          </motion.div>
        )}

        {/* ── The same Salesforce-backed form, loaded with the record's live values ── */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: t.heading }}>{def.singular}</span>
          <span style={{ fontSize: 11.5, color: t.dim }}>Current Salesforce values. Changed fields are marked; locked fields show why Salesforce won&apos;t allow the change.</span>
        </div>
        <BillingRecordForm
          isDark={isDark} schema={schema} draft={draft} path=""
          onChange={d => { setDraft(d); setTouched(true); }}
          issues={isCurrent ? validation!.issues : []}
          edit={{ original: ctx.draft, locks: ctx.locks, readOnly: ctx.recordLock }}
        />
        {!ctx.recordLock && <BillingLinksEditor isDark={isDark} links={links} onChange={l => { setLinks(l); setTouched(true); }} rootDraft={draft} schema={schema} />}

        {/* ── Related Salesforce records ── */}
        {ctx.related.map(r => (
          <Panel key={r.relation} isDark={isDark} title={`${r.title} (${r.records.length})`} icon={r.moduleKey ? getBillingModule(r.moduleKey)?.icon ?? "list" : "list"}
            right={<span style={{ fontSize: 10.5, color: t.dim, fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}>{r.relation}</span>}>
            {r.note && <div style={{ fontSize: 11.5, color: t.dim, marginBottom: 10 }}>{r.note}</div>}
            {r.records.length === 0 && <div style={{ fontSize: 12, color: t.dim }}>None.</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {r.records.map(rec => (
                <div key={rec.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 12px", borderRadius: 11, border: `1px solid ${t.border}`, background: t.surfaceAlt }}>
                  <span style={{ color: t.accent, display: "inline-flex" }}><Ic n={rec.moduleKey ? getBillingModule(rec.moduleKey)?.icon ?? "list" : "list"} s={14} /></span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: t.heading }}>{rec.name}</span>
                  <StatusPill status={rec.status} isDark={isDark} />
                  {rec.summary.map(s => <span key={s.label} style={{ fontSize: 11.5, color: t.dim }}>{s.label}: <strong style={{ color: t.body }}>{s.value}</strong></span>)}
                  {rec.moduleKey && (
                    <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      <GhostButton label="View" icon="eye" isDark={isDark} onClick={() => onOpenRecord(rec.moduleKey!, rec.id)} />
                      <GhostButton label="Edit" icon="edit" isDark={isDark} onClick={() => onEditRecord(rec.moduleKey!, rec.id)} />
                    </span>
                  )}
                </div>
              ))}
            </div>
            {moduleKey === "billing-treatments" && r.relation === "BillingTreatmentItem.BillingTreatmentId" && r.records.length === 0 && (
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <GhostButton label="Create Treatment Item" icon="plus" isDark={isDark} disabled={ctx.status !== "Draft"}
                  onClick={() => onCreateChild("billing-treatment-items", { BillingTreatmentId: { id: recordId, name: ctx.name, sobject: schema.sobject, moduleKey } })} />
                <span title="An existing Treatment Item can't be re-parented: Salesforce doesn't allow updating a Treatment Item's Billing Treatment.">
                  <GhostButton label="Select Existing Treatment Item" icon="link" isDark={isDark} disabled />
                </span>
                <span style={{ fontSize: 11, color: t.dim, alignSelf: "center" }}>Selecting an existing item isn&apos;t possible — Salesforce doesn&apos;t allow moving a Treatment Item between treatments.</span>
              </div>
            )}
          </Panel>
        ))}

        {/* ── Changes to Save + Validation ── */}
        <Panel isDark={isDark} title="Changes to Save" icon="edit" right={<span style={{ fontSize: 11.5, fontWeight: 700, color: stateLabel.color }}>{stateLabel.text}</span>}>
          {!dirty ? <div style={{ fontSize: 12, color: t.dim }}>Edit a field, a relationship or a product link (or use the AI Edit Prompt) to see the changes here.</div>
            : !isCurrent ? <div style={{ fontSize: 12, color: t.dim }}>Validating the latest edits…</div>
            : changes.length === 0 ? <div style={{ fontSize: 12, color: t.dim }}>These edits don&apos;t change anything in Salesforce.</div>
            : <ChangeList isDark={isDark} changes={changes} />}
          {transition && (
            <div style={{ marginTop: 14, padding: 12, borderRadius: 12, border: `1px solid ${transition.ready ? "rgba(0,200,117,0.45)" : t.error + "55"}`, background: transition.ready ? "rgba(0,200,117,0.07)" : `${t.error}0c` }}>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12 }}>
                <span style={{ color: t.dim }}>Current Status: <strong style={{ color: t.heading }}>{transition.from ?? "—"}</strong></span>
                <span style={{ color: t.dim }}>Requested Status: <strong style={{ color: t.heading }}>{transition.to ?? "—"}</strong></span>
              </div>
              <div style={{ marginTop: 6, fontSize: 13, fontWeight: 800, color: transition.ready ? "#00C875" : t.error }}>
                {transition.ready ? (transition.to === "Active" ? "✓ Ready to activate" : `✓ Ready to change to ${transition.to}`) : `✗ Cannot ${transition.to === "Active" ? "activate" : `change to ${transition.to}`} ${def.singular}`}
              </div>
              {transition.blockers.map((b, i) => <div key={i} style={{ fontSize: 12, color: t.body, marginTop: 4 }}><strong>Reason:</strong> {b}</div>)}
            </div>
          )}
        </Panel>

        {isCurrent && dirty && (
          <Panel isDark={isDark} title="Validation" icon={validation!.valid ? "check-circle" : "shield"}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <ValidationChecklist isDark={isDark} validation={validation!} />
              {/* Blocking errors stay visible; non-blocking warnings sit behind "View Warnings & Diagnostics". */}
              <IssueList isDark={isDark} issues={validation!.issues.filter(i => i.severity === "error")} />
              <WarningsDisclosure isDark={isDark} warnings={validation!.issues.filter(i => i.severity === "warning").map(i => i.message)} />
              <Disclosure isDark={isDark} label={DISCLOSURE_LABELS.records} icon="database">
                <ResolvedRecords isDark={isDark} refs={validation!.references} />
              </Disclosure>
            </div>
            <div style={{ marginTop: 12 }}>
              <GhostButton label={showTechnical ? "Hide technical details" : "Show update payload & technical details"} icon="terminal" isDark={isDark} onClick={() => setShowTechnical(v => !v)} />
              {showTechnical && <div style={{ marginTop: 8 }}><CodeBlock open isDark={isDark} data={{ recordId, draft, links, aiStructuredResponse: analysis?.rawAi ?? null }} /></div>}
            </div>
          </Panel>
        )}
      </div>
    </PageShell>
  );
}

function ChangeList({ isDark, changes }: { isDark: boolean; changes: NonNullable<BillingValidationResult["changes"]> }) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {changes.map((c, i) => (
        <div key={`${c.field}-${i}`} style={{ display: "grid", gridTemplateColumns: "minmax(140px, 200px) 1fr", gap: 10, fontSize: 12.5, alignItems: "baseline" }}>
          <span style={{ color: t.dim, fontWeight: 600 }}>{c.kind === "link" || c.kind === "unlink" ? `${c.label} link` : c.label}</span>
          <span style={{ color: t.body }}>
            <span style={{ textDecoration: "line-through", opacity: 0.7 }}>{c.from ?? "—"}</span>
            <span style={{ color: t.dim, margin: "0 8px" }}>→</span>
            <strong style={{ color: c.kind === "unlink" ? t.error : t.heading }}>{c.to ?? "—"}</strong>
          </span>
        </div>
      ))}
    </div>
  );
}
