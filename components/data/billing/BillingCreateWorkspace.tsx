"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, PrimaryButton, GhostButton, PageShell, FooterBar, Spinner, ErrorPanel, CodeBlock } from "@/components/data/quotes/shared";
import PromptGuide from "@/components/ai/PromptGuide";
import BillingRecordForm, { BillingLinksEditor, createLookupAsChild } from "@/components/data/billing/BillingRecordForm";
import { Panel, IssueList, ValidationChecklist, PipelineSteps, LoadingRow } from "@/components/data/billing/billingUi";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import { promptGuideConfig } from "@/lib/ai/promptGuideConfig";
import { taxConfigPromptGuides } from "@/lib/ai/promptGuides/taxConfig";
import { quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { draftFingerprint, emptyDraft, fetchBillingSchema, newDraftKey, seedDraftFields, toBillingErrorPanel } from "@/lib/billing/client";
import { getBillingModule } from "@/lib/billing/registry";
import TaxAssistant from "@/components/data/billing/tax/TaxAssistant";
import type { AssistantOperation, AssistantPreview } from "@/lib/tax/types";
import { draftFromTaxForm, formCreateBlockers, type TaxFormDraft, type TaxFormPrerequisite } from "@/lib/taxes/formDraft";

/** /api/taxes/assistant/interpret response (Taxes modules flagged aiViaTaxAssistant; `form` = this page's create form values). */
type TaxAssistantInterpretation = { success: false; requiresInput: boolean; message: string; code?: string }
  | { success: true; mode: "form"; object: string; draft: TaxFormDraft }
  | { success: true; mode: "operations"; operations: AssistantOperation[]; warnings: string[]; preview: AssistantPreview }
  | { success: true; mode: "configure" };
import type {
  BillingAnalysisResult, BillingCreateResponse, BillingDraftLink, BillingDraftRecord,
  BillingModuleSchema, BillingReferenceValue, BillingResolvedReference, BillingValidationResult,
} from "@/lib/billing/types";
import { Disclosure, DISCLOSURE_LABELS, WarningsDisclosure, ConfigNotesDisclosure } from "@/components/ui/Disclosure";

function linksFromSchema(schema: BillingModuleSchema): BillingDraftLink[] {
  return schema.inboundLinks.map(l => ({ key: newDraftKey(), sobject: l.sobject, field: l.field, label: l.label, valueSource: l.valueSource, targets: [], enabled: false }));
}

/** Merge AI-proposed links into the schema's full link list (so the user can still enable the ones the AI didn't use). */
function mergeLinks(schema: BillingModuleSchema, proposed: BillingDraftLink[]): BillingDraftLink[] {
  return linksFromSchema(schema).map(l => proposed.find(p => p.sobject === l.sobject && p.field === l.field) ?? l);
}

function nodeAt(root: BillingDraftRecord, path: string): BillingDraftRecord | null {
  if (!path) return root;
  let node: BillingDraftRecord | undefined = root;
  for (const idx of path.split(".")) node = node?.children[Number(idx)];
  return node ?? null;
}

const REF_ICON: Record<BillingResolvedReference["status"], string> = { found: "check-circle", new: "plus", inactive: "alert", missing: "x", unresolved: "x" };

/** ✓ / ✗ list of every Salesforce record the configuration depends on. */
export function ResolvedRecords({ isDark, refs, product }: { isDark: boolean; refs: BillingResolvedReference[]; product?: BillingAnalysisResult["context"] | null }) {
  const t = tokens(isDark);
  const color = (s: BillingResolvedReference["status"]) => (s === "found" ? "#00C875" : s === "new" ? t.accent : s === "inactive" ? t.warn : t.error);
  const rows: BillingResolvedReference[] = [...refs];
  if (product?.product && !refs.some(r => r.sobject === "Product2" && r.name === product.product!.name)) {
    rows.unshift({ path: "", field: null, label: "Product", name: product.product.name, sobject: "Product2", status: "found", detail: product.productBillingPolicy ? `uses ${product.productBillingPolicy.name}` : "no Billing Policy yet" });
  }
  if (rows.length === 0) return <div style={{ fontSize: 12, color: t.dim }}>No related Salesforce records selected yet.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {rows.map((r, i) => (
        <div key={`${r.path}-${r.field}-${r.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
          <span style={{ color: color(r.status), display: "inline-flex" }}><Ic n={REF_ICON[r.status]} s={13} /></span>
          <span style={{ color: t.dim, minWidth: 130 }}>{r.label}</span>
          <span style={{ color: t.heading, fontWeight: 700 }}>{r.name}</span>
          <span style={{ color: color(r.status), fontSize: 11, fontWeight: 600 }}>
            {r.status === "found" ? "found" : r.status === "new" ? "new — created in this request" : r.status === "inactive" ? `found (${r.detail ?? "inactive"})` : r.status === "missing" ? "no longer exists" : `not found${r.detail && r.detail !== "Not found" ? ` (${r.detail})` : ""}`}
          </span>
          {r.status === "found" && r.detail && <span style={{ color: t.dim, fontSize: 11 }}>· {r.detail}</span>}
        </div>
      ))}
    </div>
  );
}

/** Product → Billing Policy → Default Treatment → Treatment Items, with what this draft has for each step. */
function DependencyChain({ isDark, moduleKey, draft, links }: { isDark: boolean; moduleKey: string; draft: BillingDraftRecord; links: BillingDraftLink[] }) {
  const t = tokens(isDark);
  if (!["billing-policies", "billing-treatments", "billing-treatment-items"].includes(moduleKey)) return null;
  const productLink = links.find(l => l.sobject === "Product2" && l.enabled && l.targets.length);
  const products = productLink ? productLink.targets.map(p => p.name).join(", ") : null;
  const childName = (key?: string) => { const c = key ? draft.children.find(x => x.key === key) : undefined; return c ? `${String(c.fields.Name ?? "new")} (new)` : null; };
  const itemsOf = (d?: BillingDraftRecord) => (d ? d.children.filter(c => c.moduleKey === "billing-treatment-items").length : 0);

  let steps: { label: string; value: string | null; current?: boolean; hint?: string }[];
  if (moduleKey === "billing-policies") {
    const newTreatment = draft.childReferences?.DefaultBillingTreatmentId ? draft.children.find(c => c.key === draft.childReferences!.DefaultBillingTreatmentId) : undefined;
    steps = [
      { label: "Product", value: products, hint: "Product Association" },
      { label: "Billing Policy", value: String(draft.fields.Name ?? "") || "this policy", current: true },
      { label: "Default Billing Treatment", value: draft.references.DefaultBillingTreatmentId?.name ?? childName(draft.childReferences?.DefaultBillingTreatmentId), hint: "Relationships" },
      { label: "Treatment Items", value: newTreatment ? `${itemsOf(newTreatment)} new` : draft.references.DefaultBillingTreatmentId ? "existing" : null },
    ];
  } else if (moduleKey === "billing-treatments") {
    steps = [
      { label: "Product", value: products ?? (draft.references.BillingPolicyId ? "via policy" : null), hint: "Product Association" },
      { label: "Billing Policy", value: draft.references.BillingPolicyId?.name ?? null, hint: "Relationships" },
      { label: "Billing Treatment", value: String(draft.fields.Name ?? "") || "this treatment", current: true },
      { label: "Treatment Items", value: itemsOf(draft) ? `${itemsOf(draft)} new` : null, hint: "Add below" },
    ];
  } else {
    steps = [
      { label: "Billing Treatment", value: draft.references.BillingTreatmentId?.name ?? null, hint: "Required" },
      { label: "Treatment Item", value: String(draft.fields.Name ?? "") || "this item", current: true },
    ];
  }
  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 6, flexWrap: "wrap" }}>
      {steps.map((s, i) => (
        <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {i > 0 && <span style={{ color: t.dim, display: "inline-flex" }}><Ic n="arrow-right" s={12} /></span>}
          <span style={{
            display: "flex", flexDirection: "column", padding: "6px 10px", borderRadius: 10, minWidth: 120,
            border: `1px solid ${s.current ? t.accent : s.value ? "rgba(0,200,117,0.45)" : t.warn + "70"}`,
            background: s.current ? `${t.accent}14` : s.value ? "rgba(0,200,117,0.07)" : `${t.warn}0d`,
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: t.dim }}>{s.label}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: s.value || s.current ? t.heading : t.warn }}>{s.value ?? `not set${s.hint ? ` · ${s.hint}` : ""}`}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Create workspace for any billing module — ONE page, ONE draft:
 *
 *   AI prompt (optional) → Analyze & Verify → Salesforce resolution → the Salesforce-backed form
 *   below is auto-populated → user edits → Validate → Create in Salesforce → record + history.
 *
 * The AI never has its own schema: analysis returns the same `BillingDraftRecord` the form edits
 * and the create route accepts. Create is enabled only when the CURRENT draft (fingerprint) is the
 * one that last passed server-side validation.
 */
export default function BillingCreateWorkspace({
  isDark, moduleKey, initialPrompt, initialAnalysis, initialReferences, initialFields, initialNotice, onCancel, onOpenRecord, onOpenHistory, onSwitchModule, onCreated,
}: {
  /** Lookups pre-selected when the create is launched from a related record (e.g. an item created from its treatment). */
  initialReferences?: Record<string, BillingReferenceValue>;
  /**
   * Field values pre-filled when the create is launched with data (e.g. "Use This Rate" from the Global Tax Rate Library).
   * Only fields this org's Describe marks createable are applied; the user still reviews, validates and creates as usual.
   */
  initialFields?: Record<string, unknown>;
  /** Shown above the form when it was opened pre-filled (where the values came from, warnings). */
  initialNotice?: ReactNode;
  isDark: boolean;
  moduleKey: string;
  initialPrompt?: string;
  /** A result already produced by the dashboard-level AI router — the form opens pre-filled with it. */
  initialAnalysis?: BillingAnalysisResult | null;
  onCancel: () => void;
  onOpenRecord: (moduleKey: string, id: string) => void;
  onOpenHistory: () => void;
  onSwitchModule: (moduleKey: string, prompt: string) => void;
  /** Called after Salesforce created the record(s), with the create response (root Id etc.). */
  onCreated?: (res?: BillingCreateResponse) => void;
}) {
  const t = tokens(isDark);
  const def = getBillingModule(moduleKey)!;
  const notifySalesforceSuccess = useSalesforceSuccess();
  const formRef = useRef<HTMLDivElement>(null);

  const [schema, setSchema] = useState<BillingModuleSchema | null>(null);
  const [schemaError, setSchemaError] = useState<ErrorPanelDataLike | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [analysis, setAnalysis] = useState<BillingAnalysisResult | null>(initialAnalysis ?? null);
  const [draft, setDraft] = useState<BillingDraftRecord | null>(initialAnalysis?.draft ?? null);
  const [links, setLinks] = useState<BillingDraftLink[]>(initialAnalysis?.links ?? []);
  const [validation, setValidation] = useState<BillingValidationResult | null>(initialAnalysis?.validation ?? null);
  const [validatedFp, setValidatedFp] = useState<string | null>(null);
  const [attemptedFp, setAttemptedFp] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "analyze" | "validate" | "create">(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [result, setResult] = useState<BillingCreateResponse | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const [touched, setTouched] = useState(!!initialAnalysis);
  // Taxes modules flagged aiViaTaxAssistant: the AI goes through the Tax Configuration Assistant (preview → confirm → audit).
  const viaTaxAssistant = !!def.aiViaTaxAssistant;
  const [taxOps, setTaxOps] = useState<{ operations: AssistantOperation[]; warnings: string[]; preview: AssistantPreview; n: number } | null>(null);
  const [taxMessage, setTaxMessage] = useState<string | null>(null);
  // AI-filled form (Tax Assistant pages): what wasn't applied, and parent prerequisites of the lookups it resolved.
  const [taxForm, setTaxForm] = useState<{ notices: string[]; prerequisites: TaxFormPrerequisite[] } | null>(null);
  const taxRun = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetchBillingSchema(moduleKey)
      .then(s => {
        if (cancelled) return;
        setSchema(s);
        setDraft(d => {
          if (d) return d;
          return { ...seedDraftFields(emptyDraft(s), s, initialFields), references: { ...(initialReferences ?? {}) } };
        });
        const merged = initialAnalysis ? mergeLinks(s, initialAnalysis.links) : linksFromSchema(s);
        setLinks(merged);
        // A dashboard-routed analysis arrives already validated for exactly this draft.
        if (initialAnalysis) setValidatedFp(draftFingerprint(initialAnalysis.draft, merged));
      })
      .catch(err => { if (!cancelled) setSchemaError(toBillingErrorPanel(err, `Could not load ${def.singular} metadata from Salesforce`)); });
    return () => { cancelled = true; };
    // initialReferences is fixed for the lifetime of this create view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleKey, def.singular, initialAnalysis]);

  const fp = useMemo(() => draftFingerprint(draft, links), [draft, links]);
  const isCurrent = !!validation && validatedFp === fp;
  // Client-side gate on top of the server validation: a failed parent prerequisite, a required lookup without a record, or a
  // named lookup still unresolved keeps Create disabled whatever the last validation said.
  const formBlockers = useMemo(() => (viaTaxAssistant && schema && draft ? formCreateBlockers(schema, draft, taxForm?.prerequisites ?? []) : []), [viaTaxAssistant, schema, draft, taxForm]);
  const canCreate = isCurrent && !!validation?.valid && !busy && formBlockers.length === 0;

  const pathLabel = useMemo(() => (path: string) => {
    if (!draft) return path;
    const node = nodeAt(draft, path);
    const nodeDef = node ? getBillingModule(node.moduleKey) : null;
    const name = node && typeof node.fields.Name === "string" ? node.fields.Name : null;
    return `${nodeDef?.singular ?? "Record"}${name ? ` "${name}"` : path ? ` #${Number(path.split(".").pop()) + 1}` : ""}`;
  }, [draft]);

  async function runValidation(d: BillingDraftRecord, l: BillingDraftLink[]) {
    const snapshot = draftFingerprint(d, l);
    setAttemptedFp(snapshot);
    setBusy(b => b ?? "validate");
    setError(null);
    try {
      const res = await quoteApiPost<{ validation: BillingValidationResult }>(`Validate ${def.singular}`, `/api/billing/${moduleKey}/validate`, { draft: d, links: l });
      setValidation(res.validation);
      setValidatedFp(snapshot);
    } catch (err) {
      setError(toBillingErrorPanel(err, "Validation failed"));
    } finally {
      setBusy(b => (b === "validate" ? null : b));
    }
  }

  // Once the user has analyzed or validated, keep validation in step with their edits (debounced) —
  // Create stays disabled until the edited draft itself has been re-validated.
  // `attemptedFp` stops a failing validation request from being retried in a loop — the Validate
  // button (or the next edit) retries explicitly.
  useEffect(() => {
    if (!touched || !draft || busy || fp === validatedFp || fp === attemptedFp) return;
    const handle = setTimeout(() => { void runValidation(draft, links); }, 900);
    return () => clearTimeout(handle);
    // runValidation reads the latest draft/links passed in; fp captures both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp, touched, busy, validatedFp, attemptedFp]);

  async function analyze() {
    if (viaTaxAssistant) return analyzeWithTaxAssistant();
    if (!prompt.trim() || !schema) return;
    setBusy("analyze");
    setError(null);
    try {
      const res = await quoteApiPost<BillingAnalysisResult>(`AI analyze ${def.singular}`, "/api/billing/ai/analyze", { prompt, moduleKey });
      const merged = mergeLinks(schema, res.links);
      setAnalysis(res);
      setDraft(res.draft);
      setLinks(merged);
      setValidation(res.validation);
      setValidatedFp(draftFingerprint(res.draft, merged));
      setTouched(true);
      setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    } catch (err) {
      setError(toBillingErrorPanel(err, "AI analysis failed"));
    } finally {
      setBusy(null);
    }
  }

  async function analyzeWithTaxAssistant() {
    if (!prompt.trim() || !schema) return;
    setBusy("analyze");
    // A new analysis starts clean: no result, issue or notice from the previous configuration stays on screen.
    setError(null); setTaxOps(null); setTaxMessage(null); setTaxForm(null);
    setValidation(null); setValidatedFp(null); setAttemptedFp(null);
    try {
      // The page's Salesforce object (from the module definition — never derived from the UI label) scopes the request; `form`
      // returns that one record's values for the form below.
      const res = await quoteApiPost<TaxAssistantInterpretation>(`AI analyze ${def.singular}`, "/api/taxes/assistant/interpret", { prompt, object: def.candidates[0], form: true });
      if (!res.success) setTaxMessage(res.message);
      else if (res.mode === "configure") setTaxMessage("This reads like a whole new tax configuration — use Taxes → Configure for that.");
      else if (res.mode === "form") {
        const next = draftFromTaxForm(emptyDraft(schema), res.draft, initialReferences);
        setDraft(next);
        setTaxForm({ notices: res.draft.notices, prerequisites: res.draft.prerequisites });
        setTouched(true);
        void runValidation(next, links);
        setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
      }
      else setTaxOps({ operations: res.operations, warnings: res.warnings, preview: res.preview, n: ++taxRun.current });
    } catch (err) {
      setError(toBillingErrorPanel(err, "AI analysis failed"));
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (!draft || !canCreate) return;
    setBusy("create");
    setError(null);
    try {
      const res = await quoteApiPost<BillingCreateResponse>(`Create ${def.singular}`, `/api/billing/${moduleKey}`, { draft, links });
      setResult(res);
      setValidation(res.validation);
      onCreated?.(res);
      notifySalesforceSuccess({
        title: `${def.singular} Created Successfully`,
        message: res.created.length > 1
          ? `${res.root.name} and ${res.created.length - 1} related record${res.created.length > 2 ? "s were" : " was"} created in Salesforce.`
          : `${res.root.name} has been successfully created in Salesforce.`,
        records: res.created.map(c => ({ objectApiName: c.sobject, recordId: c.id, recordName: c.name, salesforceUrl: c.salesforceUrl })),
      });
    } catch (err) {
      const panel = toBillingErrorPanel(err, `Salesforce rejected the ${def.singular}`);
      setError(panel);
      const raw = panel.raw as { validation?: BillingValidationResult } | undefined;
      if (raw?.validation) { setValidation(raw.validation); setValidatedFp(fp); }
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    if (!schema) return;
    setDraft(emptyDraft(schema));
    setLinks(linksFromSchema(schema));
    setAnalysis(null);
    setValidation(null);
    setValidatedFp(null);
    setResult(null);
    setError(null);
    setPrompt("");
    setTouched(false);
    setTaxForm(null); setTaxOps(null); setTaxMessage(null);
  }

  if (schemaError) return <div style={{ padding: 20 }}><ErrorPanel isDark={isDark} error={schemaError} /></div>;
  if (!schema || !draft) return <div style={{ padding: 20 }}><LoadingRow isDark={isDark} label={`Discovering ${def.singular} fields in the connected org…`} /></div>;
  if (!schema.createable) {
    return (
      <div style={{ padding: 20 }}>
        <Panel isDark={isDark} title={`${def.singular} records can't be created here`} icon="lock">
          <div style={{ fontSize: 12.5, color: t.body }}>{def.readOnlyNote ?? `Your user can't create ${schema.labelPlural} through the API in this org.`}</div>
          <div style={{ marginTop: 12 }}><GhostButton label="Back" icon="arrow-left" isDark={isDark} onClick={onCancel} /></div>
        </Panel>
      </div>
    );
  }

  /* ── Success ── */
  if (result) {
    return (
      <PageShell>
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ borderRadius: 16, padding: 20, border: "1px solid rgba(0,200,117,0.35)", background: isDark ? "rgba(0,200,117,0.07)" : "rgba(0,200,117,0.06)", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 36, height: 36, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", color: "#00C875", background: "rgba(0,200,117,0.14)", border: "1px solid rgba(0,200,117,0.35)" }}><Ic n="check-circle" s={18} /></span>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>{def.singular} created in Salesforce</div>
              <div style={{ fontSize: 12, color: t.dim }}>{result.created.length} record{result.created.length > 1 ? "s" : ""} created{result.links.length ? ` · ${result.links.length} existing record${result.links.length > 1 ? "s" : ""} updated` : ""} in one all-or-nothing transaction.</div>
            </div>
          </div>
          <Panel isDark={isDark} title="Created records" icon="list" padding={0}>
            {result.created.map(c => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: `1px solid ${t.border}` }}>
                <span style={{ color: t.accent, display: "inline-flex" }}><Ic n={c.path ? "list" : def.icon} s={14} /></span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: t.heading }}>{c.name}</span>
                <span style={{ fontSize: 11, color: t.dim }}>{c.sobject} · <code>{c.id}</code></span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <GhostButton label="View details" icon="eye" isDark={isDark} onClick={() => onOpenRecord(nodeAt(draft, c.path)?.moduleKey ?? moduleKey, c.id)} />
                  <a href={c.salesforceUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: t.accent, textDecoration: "none", padding: "8px 10px" }}>
                    <Ic n="external-link" s={12} /> Salesforce
                  </a>
                </span>
              </div>
            ))}
            {result.links.map(l => (
              <div key={`${l.recordId}-${l.field}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderBottom: `1px solid ${t.border}`, fontSize: 12, color: t.body }}>
                <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="link" s={13} /></span>
                Updated <strong style={{ color: t.heading }}>{l.recordName}</strong> ({l.sobject}.{l.field})
              </div>
            ))}
          </Panel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <PrimaryButton label={`Open ${result.root.name}`} icon="eye" isDark={isDark} onClick={() => onOpenRecord(moduleKey, result.root.id)} />
            <GhostButton label={`${def.singular} History`} icon="list" isDark={isDark} onClick={onOpenHistory} />
            <GhostButton label={`Create another ${def.singular}`} icon="plus" isDark={isDark} onClick={reset} />
          </div>
        </motion.div>
      </PageShell>
    );
  }

  const errorCount = validation?.issues.filter(i => i.severity === "error").length ?? 0;
  const stateLabel = busy === "create" ? { text: "Creating in Salesforce…", color: t.accent }
    : busy === "validate" || (touched && !isCurrent && !!validation && fp !== attemptedFp) ? { text: "Validating against Salesforce…", color: t.accent }
    : !validation ? { text: "Not validated yet", color: t.dim }
    : !isCurrent ? { text: "Changed since last validation — press Validate", color: t.warn }
    : validation.valid ? { text: "✓ Valid — ready to create", color: "#00C875" }
    : { text: `✗ ${errorCount} issue${errorCount > 1 ? "s" : ""} to fix`, color: t.error };

  const footer = (
    <FooterBar isDark={isDark}>
      <GhostButton label="Cancel" icon="x" isDark={isDark} onClick={onCancel} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: stateLabel.color, display: "inline-flex", alignItems: "center", gap: 6 }}>
          {(busy === "validate" || busy === "create") && <Spinner isDark={isDark} size={12} />}{stateLabel.text}
        </span>
        {analysis && <GhostButton label="Edit Configuration" icon="edit" isDark={isDark} onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} />}
        <GhostButton label={busy === "validate" ? "Validating…" : "Validate"} icon="check-circle" isDark={isDark} disabled={!!busy} onClick={() => { setTouched(true); void runValidation(draft, links); }} />
        <PrimaryButton label={busy === "create" ? "Creating…" : "Create in Salesforce"} icon="check" isDark={isDark} disabled={!canCreate} onClick={create} />
      </div>
    </FooterBar>
  );

  return (
    <PageShell footer={footer}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Create New {def.singular}</div>
            <div style={{ fontSize: 11.5, color: t.dim }}>{schema.sobject} · API {schema.apiVersion} · {schema.fields.filter(f => f.required).length} required field(s) in this org</div>
          </div>
          <DependencyChain isDark={isDark} moduleKey={moduleKey} draft={draft} links={links} />
        </div>

        {initialNotice}

        {/* ── AI prompt (optional) ── */}
        <div style={{ borderRadius: 16, padding: 16, border: `1px solid ${t.accent}45`, background: isDark ? "linear-gradient(135deg, rgba(0,212,255,0.08), rgba(30,144,255,0.04))" : "linear-gradient(135deg, rgba(0,152,204,0.07), rgba(9,104,211,0.03))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 800, color: t.heading }}>
            <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="sparkles" s={15} /></span> Create {def.singular} with AI
            <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, border: `1px solid ${t.border}`, borderRadius: 999, padding: "1px 8px" }}>OPTIONAL</span>
          </div>
          <div style={{ fontSize: 12, color: t.dim, margin: "4px 0 10px" }}>
            {viaTaxAssistant
              ? <>Describe the {def.singular.toLowerCase()} you want to create. The AI fills in the Salesforce form below and resolves the records you name in Salesforce — nothing is created until you validate and click Create. Or skip this and fill the form yourself.</>
              : <>Describe the {def.singular.toLowerCase()} you want to create. The AI fills in the Salesforce form below — or skip this and fill the form yourself.</>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void analyze(); }}
              rows={3}
              placeholder={def.aiExamples[0] ? `e.g. "${def.aiExamples[0]}"` : `Describe the ${def.singular}…`}
              style={{ ...inputStyle(t), flex: "1 1 380px", resize: "vertical", fontSize: 13.5, lineHeight: 1.5 }}
            />
            <PrimaryButton label={busy === "analyze" ? "Analyzing…" : "Analyze & Verify"} icon="sparkles" isDark={isDark} disabled={!prompt.trim() || !!busy} onClick={analyze} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            {def.aiExamples.map((ex, i) => (
              <button key={ex} title={ex} onClick={() => setPrompt(ex)} style={{ fontSize: 11.5, padding: "5px 11px", borderRadius: 999, border: `1px solid ${t.border}`, background: t.surface, color: t.body, cursor: "pointer", textAlign: "left" }}>{def.aiExampleLabels?.[i] ?? ex}</button>
            ))}
          </div>
          {busy === "analyze" && (
            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: t.dim }}>
              <Spinner isDark={isDark} size={13} /> Detecting intent, extracting fields, resolving products/policies/treatments in Salesforce and validating…
            </div>
          )}
          {/* Tax objects get their own guide (tax chain, native engine, decision-table refresh); everything else keeps the Billing guide. */}
          <div style={{ marginTop: 10 }}><PromptGuide isDark={isDark} config={taxConfigPromptGuides[moduleKey] ?? (viaTaxAssistant ? taxConfigPromptGuides.taxObject : promptGuideConfig.billing)} onUseExample={setPrompt} /></div>
        </div>

        {error && <ErrorPanel isDark={isDark} error={error} />}
        {taxMessage && <div style={{ fontSize: 12.5, color: t.body, padding: "10px 14px", borderRadius: 12, border: `1px solid ${t.warn}55`, background: `${t.warn}10` }}>{taxMessage}</div>}
        {taxOps && <TaxAssistant key={taxOps.n} isDark={isDark} operations={taxOps.operations} preview={taxOps.preview} warnings={taxOps.warnings} onDone={() => onCreated?.()} />}
        {taxForm && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12.5, color: t.body, padding: "10px 14px", borderRadius: 12, border: `1px solid ${t.accent}45`, background: `${t.accent}0d` }}>
              The {def.singular} form below is filled in from your request — check it, pick any lookup that wasn&apos;t resolved, then Validate and Create.
            </div>
            {formBlockers.map(b => (
              <div key={b} style={{ fontSize: 12.5, color: t.body, padding: "9px 14px", borderRadius: 12, border: `1px solid ${t.error}55`, background: `${t.error}0d`, display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ color: t.error, display: "inline-flex" }}><Ic n="x" s={13} /></span>{b}
              </div>
            ))}
            <WarningsDisclosure isDark={isDark} warnings={taxForm.notices} />
          </div>
        )}

        {/* ── AI analysis result ── */}
        {analysis && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {analysis.suggestedModuleKey && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderRadius: 12, border: `1px solid ${t.warn}55`, background: `${t.warn}10`, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, color: t.body, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: t.warn, display: "inline-flex" }}><Ic n="alert" s={14} /></span>
                  This prompt reads like a <strong>{getBillingModule(analysis.suggestedModuleKey)?.singular}</strong>, not a {def.singular}.
                </span>
                <GhostButton label={`Create a ${getBillingModule(analysis.suggestedModuleKey)?.singular} instead`} icon="arrow-right" isDark={isDark} onClick={() => onSwitchModule(analysis.suggestedModuleKey!, prompt)} />
              </div>
            )}
            {/* Actionable — a lookup the AI couldn't resolve must be picked (or created) before Create: always visible. */}
            {analysis.unresolvedReferences.filter(u => !(u.field && (draft.references[u.field] || draft.childReferences?.[u.field]))).length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {analysis.unresolvedReferences.filter(u => !(u.field && (draft.references[u.field] || draft.childReferences?.[u.field]))).map((u, i) => {
                  const child = u.createAsChildModule ? getBillingModule(u.createAsChildModule) : null;
                  return (
                    <div key={`${u.path}-${u.field}-${i}`} style={{ padding: "8px 10px", borderRadius: 9, border: `1px solid ${t.error}45`, background: `${t.error}0c`, fontSize: 12, color: t.body }}>
                      <div><strong style={{ color: t.error }}>{u.label} &ldquo;{u.searchedName}&rdquo; was not found.</strong> {u.candidates.length > 1 ? `${u.candidates.length} similar records — pick one in the form.` : "Select an existing record in the form below"}{child && u.path === "" ? `, or create it:` : "."}</div>
                      {child && u.field && u.path === "" && (
                        <div style={{ marginTop: 6 }}>
                          <GhostButton label={`Create "${u.searchedName}" as a new ${child.singular} with this ${def.singular}`} icon="plus" isDark={isDark}
                            onClick={async () => { setDraft(await createLookupAsChild(draft, u.field!, u.createAsChildModule!, u.searchedName)); setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {/* Secondary detail — hidden until asked for (never auto-expanded by Analyze & Verify). */}
            <Disclosure isDark={isDark} variant="card" icon="cpu" label={DISCLOSURE_LABELS.ai}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 13, color: t.heading, fontWeight: 600 }}>{analysis.summary}</div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: analysis.confidence >= 0.75 ? "#00C875" : t.warn }}>{Math.round(analysis.confidence * 100)}% confidence</span>
                </div>
                <PipelineSteps isDark={isDark} steps={analysis.pipeline} />
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 6 }}>Resolved Salesforce records</div>
                  <ResolvedRecords isDark={isDark} refs={isCurrent ? validation!.references : analysis.validation.references} product={analysis.context} />
                </div>
              </div>
            </Disclosure>
            {(analysis.assumptions.length > 0 || analysis.warnings.length > 0) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <ConfigNotesDisclosure isDark={isDark} notes={analysis.assumptions} />
                <WarningsDisclosure isDark={isDark} warnings={analysis.warnings} />
              </div>
            )}
          </motion.div>
        )}

        {/* ── The Salesforce-backed form (AI fills it; the user can always edit it) ── */}
        <div ref={formRef} style={{ display: "flex", flexDirection: "column", gap: 12, scrollMarginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: t.heading }}>{def.singular}</span>
            <span style={{ fontSize: 11.5, color: t.dim }}>
              {analysis ? "Filled in by AI from Salesforce data — edit anything; validation re-runs automatically." : "Fields discovered from the connected org's Salesforce metadata. * = required by Salesforce."}
            </span>
          </div>
          <BillingRecordForm isDark={isDark} schema={schema} draft={draft} onChange={d => { setDraft(d); setTouched(true); }} issues={isCurrent ? validation!.issues : []} path="" />
          <BillingLinksEditor isDark={isDark} links={links} onChange={l => { setLinks(l); setTouched(true); }} rootDraft={draft} schema={schema} />
        </div>

        {/* ── Validation ── */}
        <Panel isDark={isDark} title="Validation" icon={validation?.valid && isCurrent ? "check-circle" : "shield"} right={<span style={{ fontSize: 11.5, fontWeight: 700, color: stateLabel.color }}>{stateLabel.text}</span>}>
          {!validation ? (
            <div style={{ fontSize: 12, color: t.dim }}>Run <strong>Analyze &amp; Verify</strong> or <strong>Validate</strong> to check required fields, picklists, lookups and billing rules against Salesforce. Create in Salesforce is enabled once the configuration is valid.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, opacity: isCurrent ? 1 : 0.55 }}>
              <ValidationChecklist isDark={isDark} validation={validation} />
              {/* Blocking errors stay visible; non-blocking warnings/info sit behind "View Warnings & Diagnostics". */}
              <IssueList isDark={isDark} issues={validation.issues.filter(i => i.severity === "error")} pathLabel={pathLabel} />
              {validation.issues.some(i => i.severity !== "error") && (
                <Disclosure isDark={isDark} label={DISCLOSURE_LABELS.warnings} tone="warn" count={validation.issues.filter(i => i.severity !== "error").length}>
                  <IssueList isDark={isDark} issues={validation.issues.filter(i => i.severity !== "error")} pathLabel={pathLabel} />
                </Disclosure>
              )}
              <Disclosure isDark={isDark} label={DISCLOSURE_LABELS.records} icon="database">
                <ResolvedRecords isDark={isDark} refs={validation.references} product={analysis?.context} />
              </Disclosure>
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <GhostButton label={showTechnical ? "Hide technical details" : "Show payload & technical details"} icon="terminal" isDark={isDark} onClick={() => setShowTechnical(v => !v)} />
            {showTechnical && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <CodeBlock open isDark={isDark} data={{ draft, links: links.filter(l => l.enabled) }} />
                {analysis && <CodeBlock open isDark={isDark} data={{ aiStructuredResponse: analysis.rawAi }} />}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </PageShell>
  );
}
