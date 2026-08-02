"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Section, Ic, tokens, inputStyle, Field, PrimaryButton, GhostButton,
  EmptyState, Spinner, ErrorPanel, Pill, type Tokens,
} from "@/components/data/quotes/shared";
import RichTextEditor from "@/components/data/contracts/RichTextEditor";
import { quoteApiGet, quoteApiPost, quoteApiDelete, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import * as templateStore from "@/lib/contracts/documents/localTemplateStore";
import * as draftStore from "@/lib/contracts/documents/draftDocumentStore";
import { renderBrandedHtml } from "@/lib/contracts/documents/render";
import type { DraftDocument } from "@/lib/contracts/documents/draftDocumentStore";
import type {
  BrandingConfig, CompanySettings, ContractTemplate, FooterElementKey, GeneratedDocument,
  MergeFieldValues, PageOrientation, PageSize, SignatureBlockConfig, SignatureFieldType,
} from "@/lib/contracts/types";

type Mode = "browse" | "edit";
type CenterView = "editor" | "preview" | "print" | "pdf";

const PAGE_SIZES: PageSize[] = ["A4", "Letter", "Legal"];
const ORIENTATIONS: PageOrientation[] = ["portrait", "landscape"];
const FOOTER_OPTIONS: { key: FooterElementKey; label: string }[] = [
  { key: "confidential", label: "Confidential" },
  { key: "companyAddress", label: "Company Address" },
  { key: "pageNumber", label: "Page Number" },
  { key: "generatedDate", label: "Generated Date" },
  { key: "version", label: "Version" },
  { key: "copyright", label: "Copyright" },
];
const SIGNATURE_TYPES: { key: SignatureFieldType; label: string }[] = [
  { key: "customerSignature", label: "Customer Signature" },
  { key: "companySignature", label: "Company Signature" },
  { key: "salesRepresentative", label: "Sales Representative" },
  { key: "legalRepresentative", label: "Legal Representative" },
  { key: "dateSigned", label: "Date Signed" },
  { key: "witness", label: "Witness" },
];

const SAMPLE_VALUES: MergeFieldValues = {
  AccountName: "Sample Customer, Inc.", ContractNumber: "CN-000123",
  ContractStartDate: new Date().toISOString().slice(0, 10),
  ContractEndDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  ContractTerm: "12", Status: "Draft", Owner: "Jane Owner",
  CompanySignedDate: "—", CustomerSignedDate: "—",
  Description: "Sample description for template preview purposes.",
  CompanyName: "Your Company", CustomerName: "Sample Customer, Inc.",
  StartDate: new Date().toISOString().slice(0, 10),
  EndDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  AuthorizedSigner: "Jane Doe", QuoteNumber: "Q-000456",
  Products: "Sample Product A, Sample Product B", GrandTotal: "$24,000.00",
  BillingFrequency: "Monthly", PaymentTerms: "—",
};

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function NumberField({ label, value, onChange, isDark, min = 0, max }: { label: string; value: number; onChange: (v: number) => void; isDark: boolean; min?: number; max?: number }) {
  const t = tokens(isDark);
  return (
    <Field label={label} isDark={isDark}>
      <input type="number" min={min} max={max} value={value} onChange={e => onChange(Number(e.target.value))} style={inputStyle(t)} />
    </Field>
  );
}

function miniBtn(t: Tokens): React.CSSProperties {
  return { display: "flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "6px 9px", borderRadius: 7, border: `1px solid ${t.border}`, background: "transparent", color: t.body, cursor: "pointer", fontSize: 11.5 };
}

function Modal({ isDark, title, onClose, children }: { isDark: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  const t = tokens(isDark);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 420, maxWidth: "90vw", borderRadius: 14, border: `1px solid ${t.border}`, background: t.surface, boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: `1px solid ${t.border}` }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: t.heading }}>{title}</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: t.dim }}><Ic n="x" s={16} /></button>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  );
}

/** One template card in Section A — Standard or Company. */
function TemplateCard({ isDark, tpl, onUse, onPreview, onDuplicate, onRename, onDelete, onDownload }: {
  isDark: boolean; tpl: ContractTemplate;
  onUse: () => void; onPreview: () => void; onDuplicate: () => void;
  onRename?: () => void; onDelete?: () => void; onDownload: () => void;
}) {
  const t = tokens(isDark);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div style={{ padding: 16, borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 13, fontWeight: 700, color: t.heading, minWidth: 0 }}>
          <Ic n={tpl.isBuiltin ? "star" : "file-text"} s={14} />
          <span style={{ overflowWrap: "break-word", wordBreak: "break-word" }}>{tpl.name}</span>
        </div>
        <div style={{ flexShrink: 0 }}>
          {tpl.isBuiltin ? <Pill label="Standard" color={t.accentBlue} isDark={isDark} /> : <Pill label="Company" color={t.accent} isDark={isDark} />}
        </div>
      </div>
      {tpl.description && <div style={{ fontSize: 11, color: t.dim }}>{tpl.description}</div>}

      <button onClick={onUse} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#04101F", background: `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})` }}>
        <Ic n="check" s={12} /> Use Template
      </button>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <button onClick={onPreview} style={miniBtn(t)}><Ic n="eye" s={12} /> Preview</button>
        <button onClick={onDuplicate} style={miniBtn(t)}><Ic n="copy" s={12} /> Duplicate</button>
      </div>

      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {onRename && <button onClick={onRename} title="Rename" style={miniBtn(t)}><Ic n="edit" s={12} /></button>}
        <button onClick={onDownload} title="Download" style={miniBtn(t)}><Ic n="download" s={12} /></button>
        {onDelete && (
          confirmDelete ? (
            <>
              <button onClick={onDelete} style={{ ...miniBtn(t), color: t.error, borderColor: t.error + "60" }}>Confirm</button>
              <button onClick={() => setConfirmDelete(false)} style={miniBtn(t)}>Cancel</button>
            </>
          ) : <button onClick={() => setConfirmDelete(true)} title="Delete" style={{ ...miniBtn(t), color: t.error, borderColor: t.error + "60" }}><Ic n="trash" s={12} /></button>
        )}
      </div>
    </div>
  );
}

/**
 * Documents belong to the Contract — this is the ENTIRE document experience
 * for one Contract (§Expected Workflow), mounted as the "Documents" tab in
 * ContractWorkspace.tsx. There is no standalone Template Studio anymore:
 * Section A (Template Selection) picks a starting point, the editor view
 * customizes it against THIS Contract's real merge values with an instantly
 * live preview (no debounce/server round-trip — renderBrandedHtml runs
 * client-side), and Section B (Generated Documents) lists every draft and
 * every real Salesforce-generated document for this Contract in one table.
 */
export default function ContractDocuments({ isDark, contractId, onUseForSignature }: {
  isDark: boolean;
  contractId: string;
  onUseForSignature?: (doc: GeneratedDocument) => void;
}) {
  const t = tokens(isDark);
  const [mode, setMode] = useState<Mode>("browse");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [search, setSearch] = useState("");

  const [templates, setTemplates] = useState<ContractTemplate[]>([]);
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null);
  const [mergeValues, setMergeValues] = useState<MergeFieldValues | null>(null);
  const [drafts, setDrafts] = useState<DraftDocument[]>([]);
  const [sfDocs, setSfDocs] = useState<GeneratedDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);

  // Edit-mode working state — which template/draft is being customized for this Contract right now.
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [regenerateContentDocumentId, setRegenerateContentDocumentId] = useState<string | undefined>(undefined);
  const [draftTemplateId, setDraftTemplateId] = useState("");
  const [draftTemplateName, setDraftTemplateName] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftBranding, setDraftBranding] = useState<BrandingConfig | null>(null);

  const [centerView, setCenterView] = useState<CenterView>("editor");
  const [pdfDataUri, setPdfDataUri] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  const [duplicateDialog, setDuplicateDialog] = useState<{ templateId: string; name: string; description: string } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ templateId: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState<null | "pdf" | "docx">(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const docxInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const anyInputRef = useRef<HTMLInputElement>(null);

  function loadSfDocs() {
    setDocsLoading(true);
    quoteApiGet<{ documents: GeneratedDocument[] }>("List contract documents", `/api/contracts/${contractId}/documents`)
      .then(res => setSfDocs(res.documents))
      .catch(err => setError(toErrorPanelData(err, "Could not load generated documents")))
      .finally(() => setDocsLoading(false));
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [list, settings, draftList] = await Promise.all([
        templateStore.listTemplates(),
        templateStore.getCompanySettings(),
        draftStore.listDrafts(contractId),
      ]);
      if (cancelled) return;
      setTemplates(list);
      setCompanySettings(settings);
      setDrafts(draftList);
      setLoading(false);
      quoteApiPost<{ values: MergeFieldValues }>("Load merge field values", `/api/contracts/${contractId}/documents/merge-values`, { companySettings: settings })
        .then(res => { if (!cancelled) setMergeValues(res.values); })
        .catch(() => { /* SAMPLE_VALUES covers the preview until this resolves */ });
    })();
    quoteApiGet<{ documents: GeneratedDocument[] }>("List contract documents", `/api/contracts/${contractId}/documents`)
      .then(res => { if (!cancelled) setSfDocs(res.documents); })
      .catch(err => { if (!cancelled) setError(toErrorPanelData(err, "Could not load generated documents")); })
      .finally(() => { if (!cancelled) setDocsLoading(false); });
    return () => { cancelled = true; };
  }, [contractId]);

  // {{CompanyName}} reflects the Company Information panel instantly, without
  // waiting for a fresh Salesforce round-trip — every other merge token still
  // comes from the one resolved-per-contract `mergeValues` load.
  const effectiveValues = useMemo<MergeFieldValues>(() => {
    const base = mergeValues ?? SAMPLE_VALUES;
    return companySettings?.companyName ? { ...base, CompanyName: companySettings.companyName } : base;
  }, [mergeValues, companySettings]);

  const previewHtml = useMemo(() => (draftBranding ? renderBrandedHtml(draftBody, draftBranding, effectiveValues) : ""), [draftBody, draftBranding, effectiveValues]);

  function updateBranding(patch: Partial<BrandingConfig>) {
    setDraftBranding(b => (b ? { ...b, ...patch } : b));
  }

  function enterEditMode(tpl: ContractTemplate, opts?: { draftId?: string; view?: CenterView; regenerateContentDocumentId?: string; name?: string; bodyHtml?: string; branding?: BrandingConfig }) {
    setEditingDraftId(opts?.draftId ?? null);
    setRegenerateContentDocumentId(opts?.regenerateContentDocumentId);
    setDraftTemplateId(tpl.id);
    setDraftTemplateName(tpl.name);
    setDraftName(opts?.name ?? tpl.name);
    setDraftBody(opts?.bodyHtml ?? tpl.bodyHtml);
    setDraftBranding(opts?.branding ?? tpl.branding);
    setCenterView(opts?.view ?? "editor");
    setPdfDataUri(null);
    setMode("edit");
  }

  function resumeDraft(d: DraftDocument) {
    const tplStub: ContractTemplate = {
      id: d.templateId, name: d.templateName, isBuiltin: false, bodyHtml: d.bodyHtml, uploadFilename: null, uploadMime: null,
      hasUpload: false, branding: d.branding, unrecognizedTags: [], createdAt: d.savedAt, updatedAt: d.savedAt, version: 1,
      description: "", isDefault: false, createdBy: null,
    };
    enterEditMode(tplStub, { draftId: d.id, name: d.name, bodyHtml: d.bodyHtml, branding: d.branding, view: "editor" });
  }

  function backToBrowse() {
    setMode("browse");
    setEditingDraftId(null);
    setRegenerateContentDocumentId(undefined);
  }

  async function loadPdfPreview() {
    if (!draftBranding) return;
    setPdfLoading(true);
    setPdfDataUri(null);
    try {
      const res = await quoteApiPost<{ pdfBase64: string }>("Render PDF preview", "/api/contracts/templates/preview/pdf", { bodyHtml: draftBody, branding: draftBranding, values: effectiveValues });
      setPdfDataUri(`data:application/pdf;base64,${res.pdfBase64}`);
    } catch (err) {
      setError(toErrorPanelData(err, "Could not render the PDF preview"));
    } finally {
      setPdfLoading(false);
    }
  }

  async function handleSaveDraft() {
    if (!draftBranding) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await draftStore.saveDraft({
        id: editingDraftId ?? undefined, contractId, templateId: draftTemplateId, templateName: draftTemplateName,
        name: draftName, bodyHtml: draftBody, branding: draftBranding,
      });
      setEditingDraftId(saved.id);
      setDrafts(await draftStore.listDrafts(contractId));
    } catch (err) {
      setError(toErrorPanelData(err, "Could not save this draft"));
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerate(format: "pdf" | "docx") {
    if (!draftBranding) return;
    setGenerating(format);
    setError(null);
    try {
      await quoteApiPost<{ contentVersionId: string }>(
        `Generate ${format.toUpperCase()}`, `/api/contracts/${contractId}/documents/generate`,
        { templateName: draftName, bodyHtml: draftBody, branding: draftBranding, companySettings, format, contentDocumentId: regenerateContentDocumentId },
      );
      if (editingDraftId) await draftStore.deleteDraft(editingDraftId);
      setDrafts(await draftStore.listDrafts(contractId));
      loadSfDocs();
      backToBrowse();
    } catch (err) {
      setError(toErrorPanelData(err, `Could not generate the ${format.toUpperCase()}`));
    } finally {
      setGenerating(null);
    }
  }

  async function handleCreateBlank() {
    setBusyId("new");
    setError(null);
    try {
      const created = await templateStore.createTemplate({ name: "New Template", bodyHtml: "<h1>New Template</h1><p></p>" });
      setTemplates(list => [...list, created]);
      enterEditMode(created);
    } catch (err) {
      setError(toErrorPanelData(err, "Could not create a new template"));
    } finally {
      setBusyId(null);
    }
  }

  function openDuplicateDialog(tpl: ContractTemplate) {
    setDuplicateDialog({ templateId: tpl.id, name: `${tpl.name} (Copy)`, description: tpl.description });
  }

  async function confirmDuplicate() {
    if (!duplicateDialog) return;
    setBusyId(duplicateDialog.templateId);
    setError(null);
    try {
      const created = await templateStore.duplicateTemplate(duplicateDialog.templateId, { name: duplicateDialog.name, description: duplicateDialog.description });
      if (!created) throw new Error("Template not found");
      setTemplates(list => [...list, created]);
      setDuplicateDialog(null);
      enterEditMode(created);
    } catch (err) {
      setError(toErrorPanelData(err, "Could not duplicate this template"));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmRename() {
    if (!renameDialog) return;
    setBusyId(renameDialog.templateId);
    setError(null);
    try {
      const updated = await templateStore.updateTemplate(renameDialog.templateId, { name: renameDialog.name });
      if (updated) setTemplates(list => list.map(x => (x.id === renameDialog.templateId ? updated : x)));
      setRenameDialog(null);
    } catch (err) {
      setError(toErrorPanelData(err, "Could not rename this template"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeleteTemplate(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await templateStore.deleteTemplate(id);
      setTemplates(list => list.filter(x => x.id !== id));
    } catch (err) {
      setError(toErrorPanelData(err, "Could not delete this template"));
    } finally {
      setBusyId(null);
    }
  }

  function handleDownloadTemplate(tpl: ContractTemplate) {
    const blob = new Blob([tpl.bodyHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${tpl.name.replace(/[^\w.-]+/g, "_")}.html`; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleUploadFile(file: File) {
    setBusyId("upload");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("name", file.name.replace(/\.[^.]+$/, ""));
      const res = await fetch("/api/contracts/templates/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to upload template");
      const bodyHtml = data.html ?? `<h1>${data.name}</h1><p>This file (${data.filename}) couldn't be auto-converted — recreate its content here.</p>`;
      const created = await templateStore.createTemplate({ name: data.name, bodyHtml });
      setTemplates(list => [...list, created]);
      enterEditMode(created);
      if (data.warnings?.length) setError({ title: "Upload succeeded with warnings", message: data.warnings.join(" ") });
    } catch (err) {
      setError(toErrorPanelData(err, "Could not upload this template"));
    } finally {
      setBusyId(null);
    }
  }

  function handleViewDraft(d: DraftDocument) {
    const html = renderBrandedHtml(d.bodyHtml, d.branding, effectiveValues);
    const win = window.open("", "_blank");
    if (win) { win.document.write(html); win.document.close(); }
  }

  function handleDownloadDraft(d: DraftDocument) {
    const blob = new Blob([d.bodyHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${d.name.replace(/[^\w.-]+/g, "_")}.html`; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDeleteDraft(d: DraftDocument) {
    setBusyId(d.id);
    await draftStore.deleteDraft(d.id);
    setDrafts(list => list.filter(x => x.id !== d.id));
    setBusyId(null);
  }

  async function handleDeleteGenerated(doc: GeneratedDocument) {
    setBusyId(doc.contentVersionId);
    setError(null);
    try {
      await quoteApiDelete("Delete document", `/api/contracts/${contractId}/documents/${doc.contentVersionId}?contentDocumentId=${doc.contentDocumentId}`);
      setSfDocs(list => list.filter(x => x.contentDocumentId !== doc.contentDocumentId));
    } catch (err) {
      setError(toErrorPanelData(err, "Could not delete this document"));
    } finally {
      setBusyId(null);
    }
  }

  function handleView(doc: GeneratedDocument) {
    window.open(`/api/contracts/${contractId}/documents/${doc.contentVersionId}/download?disposition=inline`, "_blank");
  }

  function handleDownload(doc: GeneratedDocument) {
    window.open(`/api/contracts/${contractId}/documents/${doc.contentVersionId}/download`, "_blank");
  }

  function handleRegenerate(doc: GeneratedDocument) {
    const template = templates.find(tpl => tpl.name === doc.templateName);
    if (!template) {
      setError({ title: "Can't regenerate", message: `The template "${doc.templateName ?? "unknown"}" used to generate this document is no longer available in the library.` });
      return;
    }
    enterEditMode(template, { regenerateContentDocumentId: doc.contentDocumentId, view: "editor" });
  }

  const builtins = templates.filter(x => x.isBuiltin && (!search.trim() || x.name.toLowerCase().includes(search.toLowerCase())));
  const custom = templates.filter(x => !x.isBuiltin && (!search.trim() || x.name.toLowerCase().includes(search.toLowerCase())));

  type DocRow = { kind: "draft"; time: string; draft: DraftDocument } | { kind: "generated"; time: string; doc: GeneratedDocument };
  const rows: DocRow[] = useMemo(() => {
    const draftRows: DocRow[] = drafts.map(d => ({ kind: "draft", time: d.savedAt, draft: d }));
    const genRows: DocRow[] = sfDocs.map(d => ({ kind: "generated", time: d.createdDate, doc: d }));
    return [...draftRows, ...genRows].sort((a, b) => b.time.localeCompare(a.time));
  }, [drafts, sfDocs]);

  function reorderSignatureBlocks(blocks: SignatureBlockConfig[], fromIndex: number, toIndex: number): SignatureBlockConfig[] {
    const next = [...blocks];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next.map((b, i) => ({ ...b, order: i + 1 }));
  }

  if (loading) {
    return (
      <div style={{ padding: 24, display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}>
        <Spinner isDark={isDark} /> Loading Documents…
      </div>
    );
  }

  /* ── Edit mode: live editor + preview + branding panel for one template, in the context of this Contract ── */
  if (mode === "edit" && draftBranding) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: `1px solid ${t.border}`, flexShrink: 0, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <GhostButton label="Back to Documents" icon="arrow-left" isDark={isDark} onClick={backToBrowse} />
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: t.heading, minWidth: 0 }}>
              <Ic n="file-contract" s={14} />
              <input value={draftName} onChange={e => setDraftName(e.target.value)} style={{ ...inputStyle(t), fontWeight: 700, minWidth: 160 }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <GhostButton label={saving ? "Saving…" : "Save Draft"} icon="save" isDark={isDark} disabled={saving} onClick={handleSaveDraft} />
            <button
              onClick={() => handleGenerate("pdf")}
              disabled={!!generating}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 10, border: "none", cursor: generating ? "default" : "pointer",
                fontSize: 13.5, fontWeight: 800, color: "#04101F", background: `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})`, opacity: generating ? 0.7 : 1,
              }}
            >
              <Ic n="check-circle" s={16} /> {generating === "pdf" ? "Generating…" : "Generate Contract Document"}
            </button>
            <GhostButton label={generating === "docx" ? "Generating…" : "Generate DOCX"} icon="file-text" isDark={isDark} disabled={!!generating} onClick={() => handleGenerate("docx")} />
          </div>
        </div>

        {error && <div style={{ padding: "10px 16px" }}><ErrorPanel isDark={isDark} error={error} /></div>}

        <div className="flex-1 min-h-0 flex overflow-hidden">
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: `1px solid ${t.border}`, flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", gap: 6 }}>
                {(["editor", "preview", "print", "pdf"] as CenterView[]).map(v => (
                  <button
                    key={v}
                    onClick={() => { setCenterView(v); if (v === "pdf") loadPdfPreview(); }}
                    style={{
                      padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 11.5, fontWeight: 700,
                      background: centerView === v ? `${t.accent}20` : "transparent", color: centerView === v ? t.accent : t.dim,
                      textTransform: "capitalize",
                    }}
                  >
                    {v === "pdf" ? "PDF Preview" : v === "print" ? "Print Preview" : v}
                  </button>
                ))}
              </div>
              {!mergeValues && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: t.dim }}>
                  <Spinner isDark={isDark} /> Loading this Contract&apos;s data…
                </div>
              )}
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
              {centerView === "editor" && (
                <RichTextEditor isDark={isDark} value={draftBody} onChange={setDraftBody} />
              )}

              {centerView === "preview" && (
                <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: "#fff", minHeight: 400 }}>
                  <div style={{ padding: 24 }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
                </div>
              )}

              {centerView === "print" && (
                <div style={{ background: "#525659", padding: 24, borderRadius: 10, display: "flex", justifyContent: "center" }}>
                  <div style={{ width: draftBranding.pageSize === "Legal" ? 612 : draftBranding.pageSize === "Letter" ? 612 : 595, maxWidth: "100%", background: "#fff", boxShadow: "0 8px 30px rgba(0,0,0,0.4)", padding: 40, minHeight: 700 }}>
                    <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
                  </div>
                </div>
              )}

              {centerView === "pdf" && (
                <div style={{ minHeight: 500, borderRadius: 10, border: `1px solid ${t.border}`, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", background: "#525659" }}>
                  {pdfLoading && <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#fff", fontSize: 12.5 }}><Spinner isDark={false} /> Rendering PDF…</div>}
                  {!pdfLoading && pdfDataUri && <embed src={pdfDataUri} type="application/pdf" style={{ width: "100%", height: 620 }} />}
                  {!pdfLoading && !pdfDataUri && <GhostButton label="Render PDF Preview" icon="eye" isDark={isDark} onClick={loadPdfPreview} />}
                </div>
              )}
            </div>
          </div>

          {/* Right: Design Panel — every change here flows straight into `previewHtml` above with no save/refresh step.
              The scrollable div below is deliberately NOT also `display:flex` — Section
              has its own internal overflow:hidden, and a flex container's non-visible-
              overflow children get an automatic min-size of 0 (CSS flexbox spec), so the
              browser would shrink each Section to fit instead of letting this scroll.
              The flex/gap layout lives one level in, on a plain (non-scrolling) div. */}
          <div style={{ width: 320, flexShrink: 0, borderLeft: `1px solid ${t.border}`, overflowY: "auto", padding: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Section title="Company Branding" icon="sliders" isDark={isDark} defaultOpen>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <LogoUploader isDark={isDark} branding={draftBranding} onUploaded={url => updateBranding({ logoUrl: url })} />
                <NumberField label="Logo Width (px)" value={draftBranding.logoWidth} onChange={v => updateBranding({ logoWidth: v })} isDark={isDark} />
                <NumberField label="Logo Height (px)" value={draftBranding.logoHeight} onChange={v => updateBranding({ logoHeight: v })} isDark={isDark} />
                <Field label="Maintain Aspect Ratio" isDark={isDark}>
                  <input type="checkbox" checked={draftBranding.logoMaintainAspectRatio} onChange={e => updateBranding({ logoMaintainAspectRatio: e.target.checked })} />
                </Field>
                <Field label="Logo Position" isDark={isDark}>
                  <div style={{ display: "flex", gap: 10 }}>
                    {(["left", "center", "right"] as const).map(pos => (
                      <label key={pos} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: t.body, cursor: "pointer" }}>
                        <input type="radio" checked={draftBranding.logoPosition === pos} onChange={() => updateBranding({ logoPosition: pos })} /> {pos}
                      </label>
                    ))}
                  </div>
                </Field>
                <NumberField label="Header Margin (px)" value={draftBranding.headerMargin} onChange={v => updateBranding({ headerMargin: v })} isDark={isDark} />
                <NumberField label="Footer Margin (px)" value={draftBranding.footerMargin} onChange={v => updateBranding({ footerMargin: v })} isDark={isDark} />
                <Field label="Primary Color" isDark={isDark}>
                  <input type="color" value={draftBranding.primaryColor} onChange={e => updateBranding({ primaryColor: e.target.value })} style={{ ...inputStyle(t), padding: 4, height: 34 }} />
                </Field>
              </div>
            </Section>

            <Section title="Typography" icon="edit" isDark={isDark} defaultOpen={false}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Field label="Font Family (preview/HTML)" isDark={isDark}>
                  <input value={draftBranding.fontFamily} onChange={e => updateBranding({ fontFamily: e.target.value })} style={inputStyle(t)} />
                </Field>
                <NumberField label="Font Size (pt)" value={draftBranding.fontSize} onChange={v => updateBranding({ fontSize: v })} isDark={isDark} min={6} max={36} />
                <Field label="Heading Font" isDark={isDark}>
                  <input value={draftBranding.headingFont} onChange={e => updateBranding({ headingFont: e.target.value })} style={inputStyle(t)} />
                </Field>
                <Field label="Paragraph Font" isDark={isDark}>
                  <input value={draftBranding.paragraphFont} onChange={e => updateBranding({ paragraphFont: e.target.value })} style={inputStyle(t)} />
                </Field>
                <NumberField label="Line Height" value={draftBranding.lineHeight} onChange={v => updateBranding({ lineHeight: v })} isDark={isDark} min={1} max={3} />
                <NumberField label="Letter Spacing (px)" value={draftBranding.letterSpacing} onChange={v => updateBranding({ letterSpacing: v })} isDark={isDark} min={0} max={10} />
                <Field label="Text Color" isDark={isDark}>
                  <input type="color" value={draftBranding.textColor} onChange={e => updateBranding({ textColor: e.target.value })} style={{ ...inputStyle(t), padding: 4, height: 34 }} />
                </Field>
                <Field label="Page Background" isDark={isDark}>
                  <input type="color" value={draftBranding.pageBackground} onChange={e => updateBranding({ pageBackground: e.target.value })} style={{ ...inputStyle(t), padding: 4, height: 34 }} />
                </Field>
                <Field label="PDF Engine Font" isDark={isDark} hint="Only these 3 embed correctly in the generated PDF">
                  <select value={draftBranding.font} onChange={e => updateBranding({ font: e.target.value as BrandingConfig["font"] })} style={inputStyle(t)}>
                    <option value="Helvetica">Helvetica</option>
                    <option value="Times-Roman">Times-Roman</option>
                    <option value="Courier">Courier</option>
                  </select>
                </Field>
              </div>
            </Section>

            <Section title="Page Layout" icon="table" isDark={isDark} defaultOpen={false}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Field label="Page Size" isDark={isDark}>
                  <select value={draftBranding.pageSize} onChange={e => updateBranding({ pageSize: e.target.value as PageSize })} style={inputStyle(t)}>
                    {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
                <Field label="Orientation" isDark={isDark}>
                  <select value={draftBranding.orientation} onChange={e => updateBranding({ orientation: e.target.value as PageOrientation })} style={inputStyle(t)}>
                    {ORIENTATIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <NumberField label="Margin Top" value={draftBranding.pageMargins.top} onChange={v => updateBranding({ pageMargins: { ...draftBranding.pageMargins, top: v } })} isDark={isDark} />
                  <NumberField label="Margin Right" value={draftBranding.pageMargins.right} onChange={v => updateBranding({ pageMargins: { ...draftBranding.pageMargins, right: v } })} isDark={isDark} />
                  <NumberField label="Margin Bottom" value={draftBranding.pageMargins.bottom} onChange={v => updateBranding({ pageMargins: { ...draftBranding.pageMargins, bottom: v } })} isDark={isDark} />
                  <NumberField label="Margin Left" value={draftBranding.pageMargins.left} onChange={v => updateBranding({ pageMargins: { ...draftBranding.pageMargins, left: v } })} isDark={isDark} />
                </div>
                <NumberField label="Header Height (px)" value={draftBranding.headerHeight} onChange={v => updateBranding({ headerHeight: v })} isDark={isDark} />
                <NumberField label="Footer Height (px)" value={draftBranding.footerHeight} onChange={v => updateBranding({ footerHeight: v })} isDark={isDark} />
              </div>
            </Section>

            <Section title="Signature Section" icon="edit" isDark={isDark} defaultOpen={false}>
              <SignatureSectionEditor isDark={isDark} blocks={draftBranding.signatureBlocks} onChange={blocks => updateBranding({ signatureBlocks: blocks })} reorder={reorderSignatureBlocks} />
            </Section>

            <Section title="Company Information" icon="building" isDark={isDark} defaultOpen={false}>
              <CompanyInfoEditor key={companySettings ? "loaded" : "loading"} isDark={isDark} settings={companySettings} onSaved={setCompanySettings} />
            </Section>

            <Section title="Footer" icon="list" isDark={isDark} defaultOpen={false}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {FOOTER_OPTIONS.map(opt => (
                  <label key={opt.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.body, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={draftBranding.footerElements.includes(opt.key)}
                      onChange={e => updateBranding({
                        footerElements: e.target.checked
                          ? [...draftBranding.footerElements, opt.key]
                          : draftBranding.footerElements.filter(k => k !== opt.key),
                      })}
                    />
                    {opt.label}
                  </label>
                ))}
                <Field label="Footer Text" isDark={isDark}>
                  <input value={draftBranding.footerText} onChange={e => updateBranding({ footerText: e.target.value })} style={inputStyle(t)} />
                </Field>
              </div>
            </Section>
          </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── Browse mode: Section A (Template Selection) + Section B (Generated Documents) ── */
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 24 }}>
        {error && <ErrorPanel isDark={isDark} error={error} />}

        {/* flexShrink: 0 is required here — this scroll container is itself a flex
            column, and Section has its own internal overflow:hidden, which per the
            flexbox spec gives it an automatic min-size of 0. Without this, the browser
            shrinks Section to fit the viewport (clipping its content) instead of
            growing the container's scrollHeight and letting it actually scroll. */}
        <div style={{ flexShrink: 0 }}>
        <Section title="Template Selection" icon="file-contract" isDark={isDark} defaultOpen={false}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ position: "relative", flex: "1 1 220px", maxWidth: 320 }}>
                <span style={{ position: "absolute", left: 9, top: 9, color: t.dim }}><Ic n="search" s={13} /></span>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search templates…" style={{ ...inputStyle(t), paddingLeft: 28 }} />
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <PrimaryButton label={busyId === "new" ? "Creating…" : "New Template"} icon="plus" isDark={isDark} disabled={busyId === "new"} onClick={handleCreateBlank} />
                <GhostButton label="Upload Template" icon="upload" isDark={isDark} onClick={() => anyInputRef.current?.click()} />
                <GhostButton label="Import DOCX" icon="file-text" isDark={isDark} onClick={() => docxInputRef.current?.click()} />
                <GhostButton label="Import PDF" icon="file-text" isDark={isDark} onClick={() => pdfInputRef.current?.click()} />
              </div>
              <input ref={anyInputRef} type="file" accept=".docx,.pdf,.html,.htm" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) handleUploadFile(f); e.target.value = ""; }} />
              <input ref={docxInputRef} type="file" accept=".docx" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) handleUploadFile(f); e.target.value = ""; }} />
              <input ref={pdfInputRef} type="file" accept=".pdf" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) handleUploadFile(f); e.target.value = ""; }} />
            </div>

            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>Standard Templates</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
                {builtins.map(tpl => (
                  <TemplateCard
                    key={tpl.id} isDark={isDark} tpl={tpl}
                    onUse={() => enterEditMode(tpl)}
                    onPreview={() => enterEditMode(tpl, { view: "preview" })}
                    onDuplicate={() => openDuplicateDialog(tpl)}
                    onDownload={() => handleDownloadTemplate(tpl)}
                  />
                ))}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>My Company Templates</div>
              {custom.length === 0 && <div style={{ fontSize: 11.5, color: t.dim }}>No company templates yet — duplicate a standard template or create a new one.</div>}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
                {custom.map(tpl => (
                  <TemplateCard
                    key={tpl.id} isDark={isDark} tpl={tpl}
                    onUse={() => enterEditMode(tpl)}
                    onPreview={() => enterEditMode(tpl, { view: "preview" })}
                    onDuplicate={() => openDuplicateDialog(tpl)}
                    onRename={() => setRenameDialog({ templateId: tpl.id, name: tpl.name })}
                    onDelete={() => handleDeleteTemplate(tpl.id)}
                    onDownload={() => handleDownloadTemplate(tpl)}
                  />
                ))}
              </div>
            </div>
          </div>
        </Section>
        </div>

        <div style={{ flexShrink: 0 }}>
        <Section title="Generated Documents" icon="folder" isDark={isDark} defaultOpen>
          {docsLoading && <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: t.dim, marginBottom: 8 }}><Spinner isDark={isDark} /> Loading…</div>}
          {!docsLoading && rows.length === 0 && (
            <EmptyState isDark={isDark} icon="file-text" title="No documents yet" hint="Pick a template above to start drafting this Contract's document." />
          )}
          {rows.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>
                    <th style={{ padding: "6px 8px" }}>Document Name</th>
                    <th style={{ padding: "6px 8px" }}>Status</th>
                    <th style={{ padding: "6px 8px" }}>Version</th>
                    <th style={{ padding: "6px 8px" }}>Generated By</th>
                    <th style={{ padding: "6px 8px" }}>Generated Time</th>
                    <th style={{ padding: "6px 8px" }}>Salesforce File Id</th>
                    <th style={{ padding: "6px 8px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => row.kind === "draft" ? (
                    <tr key={`draft-${row.draft.id}`} style={{ borderTop: `1px solid ${t.border}` }}>
                      <td style={{ padding: "8px", fontWeight: 600, color: t.heading }}>{row.draft.name}</td>
                      <td style={{ padding: "8px" }}><Pill label="Draft" color={t.warn} isDark={isDark} /></td>
                      <td style={{ padding: "8px", color: t.dim }}>—</td>
                      <td style={{ padding: "8px", color: t.dim }}>You (local)</td>
                      <td style={{ padding: "8px", color: t.dim }}>{fmtDateTime(row.draft.savedAt)}</td>
                      <td style={{ padding: "8px", color: t.dim }}>—</td>
                      <td style={{ padding: "8px" }}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <button onClick={() => resumeDraft(row.draft)} style={miniBtn(t)}><Ic n="edit" s={11} /> Edit</button>
                          <button onClick={() => handleViewDraft(row.draft)} style={miniBtn(t)}><Ic n="eye" s={11} /></button>
                          <button onClick={() => handleDownloadDraft(row.draft)} style={miniBtn(t)}><Ic n="download" s={11} /></button>
                          <button onClick={() => handleDeleteDraft(row.draft)} disabled={busyId === row.draft.id} style={{ ...miniBtn(t), color: t.error, borderColor: t.error + "60" }}><Ic n="trash" s={11} /></button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={row.doc.contentVersionId} style={{ borderTop: `1px solid ${t.border}` }}>
                      <td style={{ padding: "8px", fontWeight: 600, color: t.heading }}>{row.doc.title}</td>
                      <td style={{ padding: "8px" }}>
                        <Pill label={row.doc.isLatest ? "Generated" : "Superseded"} color={row.doc.isLatest ? t.accent : t.dim} isDark={isDark} />
                      </td>
                      <td style={{ padding: "8px", color: t.dim }}>v{row.doc.versionNumber ?? "—"}</td>
                      <td style={{ padding: "8px", color: t.dim }}>{row.doc.createdByName ?? "—"}</td>
                      <td style={{ padding: "8px", color: t.dim }}>{fmtDateTime(row.doc.createdDate)}</td>
                      <td style={{ padding: "8px", color: t.dim, fontFamily: "ui-monospace, monospace", fontSize: 10.5 }}>{row.doc.contentDocumentId}</td>
                      <td style={{ padding: "8px" }}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          {row.doc.isLatest && <button onClick={() => handleRegenerate(row.doc)} style={miniBtn(t)}><Ic n="refresh" s={11} /> Regenerate</button>}
                          {row.doc.isLatest && onUseForSignature && <button onClick={() => onUseForSignature(row.doc)} style={miniBtn(t)}><Ic n="send" s={11} /> Signature</button>}
                          <button onClick={() => handleView(row.doc)} style={miniBtn(t)}><Ic n="eye" s={11} /></button>
                          <button onClick={() => handleDownload(row.doc)} style={miniBtn(t)}><Ic n="download" s={11} /></button>
                          <button onClick={() => handleDeleteGenerated(row.doc)} disabled={busyId === row.doc.contentVersionId} style={{ ...miniBtn(t), color: t.error, borderColor: t.error + "60" }}><Ic n="trash" s={11} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        </div>
      </div>

      {duplicateDialog && (
        <Modal isDark={isDark} title="Duplicate Template" onClose={() => setDuplicateDialog(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="Template Name" isDark={isDark}>
              <input value={duplicateDialog.name} onChange={e => setDuplicateDialog(d => (d ? { ...d, name: e.target.value } : d))} style={inputStyle(t)} />
            </Field>
            <Field label="Description" isDark={isDark}>
              <textarea rows={3} value={duplicateDialog.description} onChange={e => setDuplicateDialog(d => (d ? { ...d, description: e.target.value } : d))} style={{ ...inputStyle(t), resize: "vertical" }} />
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <GhostButton label="Cancel" isDark={isDark} onClick={() => setDuplicateDialog(null)} />
              <PrimaryButton label={busyId === duplicateDialog.templateId ? "Creating…" : "Duplicate"} icon="copy" isDark={isDark} disabled={busyId === duplicateDialog.templateId} onClick={confirmDuplicate} />
            </div>
          </div>
        </Modal>
      )}

      {renameDialog && (
        <Modal isDark={isDark} title="Rename Template" onClose={() => setRenameDialog(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="Template Name" isDark={isDark}>
              <input value={renameDialog.name} onChange={e => setRenameDialog(d => (d ? { ...d, name: e.target.value } : d))} style={inputStyle(t)} />
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <GhostButton label="Cancel" isDark={isDark} onClick={() => setRenameDialog(null)} />
              <PrimaryButton label={busyId === renameDialog.templateId ? "Saving…" : "Rename"} icon="check" isDark={isDark} disabled={busyId === renameDialog.templateId} onClick={confirmRename} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── Design Panel sub-sections ── */

function LogoUploader({ isDark, branding, onUploaded }: { isDark: boolean; branding: BrandingConfig; onUploaded: (url: string) => void }) {
  const t = tokens(isDark);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFile(file: File) {
    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = () => onUploaded(reader.result as string);
      reader.readAsDataURL(file);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 64, height: 64, borderRadius: 8, border: `1px dashed ${t.border}`, display: "flex", alignItems: "center", justifyContent: "center", background: "#fff", overflow: "hidden" }}>
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- live data-URL from the file picker, not a static/optimizable asset next/image can handle.
            <img src={branding.logoUrl} alt="Logo preview" style={{ maxWidth: "100%", maxHeight: "100%" }} />
          ) : <Ic n="image" s={20} />}
        </div>
        <GhostButton label={uploading ? "Uploading…" : "Upload Logo"} icon="upload" isDark={isDark} disabled={uploading} onClick={() => inputRef.current?.click()} />
      </div>
      <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
    </div>
  );
}

function SignatureSectionEditor({ isDark, blocks, onChange, reorder }: {
  isDark: boolean; blocks: SignatureBlockConfig[]; onChange: (blocks: SignatureBlockConfig[]) => void;
  reorder: (blocks: SignatureBlockConfig[], from: number, to: number) => SignatureBlockConfig[];
}) {
  const t = tokens(isDark);
  const dragIndex = useRef<number | null>(null);
  const sorted = [...blocks].sort((a, b) => a.order - b.order);

  function addBlock() {
    const type = SIGNATURE_TYPES.find(s => !blocks.some(b => b.type === s.key)) ?? SIGNATURE_TYPES[0];
    onChange([...blocks, {
      id: `${type.key}-${Date.now()}`, type: type.key, label: type.label, required: false,
      order: blocks.length + 1, width: 220, height: 70, alignment: "left", border: true,
    }]);
  }

  function updateBlock(id: string, patch: Partial<SignatureBlockConfig>) {
    onChange(blocks.map(b => (b.id === id ? { ...b, ...patch } : b)));
  }

  function removeBlock(id: string) {
    onChange(blocks.filter(b => b.id !== id).map((b, i) => ({ ...b, order: i + 1 })));
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= sorted.length) return;
    onChange(reorder(sorted, index, target));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 11, color: t.dim }}>Drag rows (or use the arrows) to set signing order.</div>
      {sorted.map((block, i) => (
        <div
          key={block.id}
          draggable
          onDragStart={() => { dragIndex.current = i; }}
          onDragOver={e => e.preventDefault()}
          onDrop={() => { if (dragIndex.current != null && dragIndex.current !== i) onChange(reorder(sorted, dragIndex.current, i)); dragIndex.current = null; }}
          style={{ padding: 10, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt, display: "flex", flexDirection: "column", gap: 8, cursor: "grab" }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: t.heading }}>#{block.order} · {block.label}</span>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={() => move(i, -1)} style={miniBtn(t)}><Ic n="chevron-right" s={10} /></button>
              <button onClick={() => move(i, 1)} style={miniBtn(t)}><Ic n="chevron-down" s={10} /></button>
              <button onClick={() => removeBlock(block.id)} style={{ ...miniBtn(t), color: t.error }}><Ic n="trash" s={10} /></button>
            </div>
          </div>
          <Field label="Label" isDark={isDark}>
            <input value={block.label} onChange={e => updateBlock(block.id, { label: e.target.value })} style={inputStyle(t)} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <NumberField label="Width" value={block.width} onChange={v => updateBlock(block.id, { width: v })} isDark={isDark} />
            <NumberField label="Height" value={block.height} onChange={v => updateBlock(block.id, { height: v })} isDark={isDark} />
          </div>
          <Field label="Alignment" isDark={isDark}>
            <select value={block.alignment} onChange={e => updateBlock(block.id, { alignment: e.target.value as SignatureBlockConfig["alignment"] })} style={inputStyle(t)}>
              <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
            </select>
          </Field>
          <div style={{ display: "flex", gap: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.body }}>
              <input type="checkbox" checked={block.border} onChange={e => updateBlock(block.id, { border: e.target.checked })} /> Border
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.body }}>
              <input type="checkbox" checked={block.required} onChange={e => updateBlock(block.id, { required: e.target.checked })} /> Required
            </label>
          </div>
          <div style={{ width: block.width, maxWidth: "100%", height: block.height, border: block.border ? `1px solid ${t.border}` : "none", borderRadius: 6, display: "flex", alignItems: "flex-end", justifyContent: block.alignment === "center" ? "center" : block.alignment === "right" ? "flex-end" : "flex-start", padding: 6, background: "#fff", color: "#999", fontSize: 10.5 }}>
            {block.label} {block.required && "*"}
          </div>
        </div>
      ))}
      <GhostButton label="Add Signature Block" icon="plus" isDark={isDark} onClick={addBlock} />
    </div>
  );
}

/** Caller mounts this with `key={settings ? "loaded" : "loading"}` — a fresh mount when `settings` actually arrives initializes `draft` correctly with no sync effect needed. */
function CompanyInfoEditor({ isDark, settings, onSaved }: { isDark: boolean; settings: CompanySettings | null; onSaved: (s: CompanySettings) => void }) {
  const t = tokens(isDark);
  const [draft, setDraft] = useState<CompanySettings | null>(settings);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const settingsResult = await templateStore.updateCompanySettings({
        companyName: draft.companyName, address: draft.address, phone: draft.phone, email: draft.email,
        website: draft.website, taxNumber: draft.taxNumber, registrationNumber: draft.registrationNumber,
      });
      onSaved(settingsResult);
    } finally {
      setSaving(false);
    }
  }

  if (!draft) return <div style={{ fontSize: 11.5, color: t.dim }}>Loading company settings…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 10.5, color: t.dim }}>Auto-populates {"{{CompanyName}}"} and the document header — Save applies it immediately to the preview.</div>
      <Field label="Company Name" isDark={isDark}><input value={draft.companyName} onChange={e => setDraft({ ...draft, companyName: e.target.value })} style={inputStyle(t)} /></Field>
      <Field label="Address" isDark={isDark}><input value={draft.address} onChange={e => setDraft({ ...draft, address: e.target.value })} style={inputStyle(t)} /></Field>
      <Field label="Phone" isDark={isDark}><input value={draft.phone} onChange={e => setDraft({ ...draft, phone: e.target.value })} style={inputStyle(t)} /></Field>
      <Field label="Email" isDark={isDark}><input value={draft.email} onChange={e => setDraft({ ...draft, email: e.target.value })} style={inputStyle(t)} /></Field>
      <Field label="Website" isDark={isDark}><input value={draft.website} onChange={e => setDraft({ ...draft, website: e.target.value })} style={inputStyle(t)} /></Field>
      <Field label="Tax Number" isDark={isDark}><input value={draft.taxNumber} onChange={e => setDraft({ ...draft, taxNumber: e.target.value })} style={inputStyle(t)} /></Field>
      <Field label="Registration Number" isDark={isDark}><input value={draft.registrationNumber} onChange={e => setDraft({ ...draft, registrationNumber: e.target.value })} style={inputStyle(t)} /></Field>
      <PrimaryButton label={saving ? "Saving…" : "Save Company Info"} icon="save" isDark={isDark} disabled={saving} onClick={save} />
    </div>
  );
}
