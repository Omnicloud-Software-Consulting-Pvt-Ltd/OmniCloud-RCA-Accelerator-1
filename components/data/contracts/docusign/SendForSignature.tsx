"use client";

import { useEffect, useState } from "react";
import { CodeBlock, EmptyState, ErrorPanel, Field, GhostButton, Ic, PrimaryButton, Section, Spinner, inputStyle, tokens } from "@/components/data/quotes/shared";
import { Modal } from "@/components/data/billing/billingUi";
import { quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { getCompanySettings } from "@/lib/contracts/documents/localTemplateStore";
import { DEFAULT_EMAIL_TEMPLATE_ID, type EmailTemplate } from "@/lib/contracts/docusign/emailTemplates";
import { createEmailTemplate, deleteEmailTemplate, duplicateEmailTemplate, listEmailTemplates, updateEmailTemplate } from "@/lib/contracts/docusign/emailTemplateStore";
import { RECIPIENT_TYPE_LABEL, type EnvelopeView, type FixedPosition, type PlacementMode, type RecipientInput, type RecipientType, type SignableDocument, type SignerPlacement } from "@/lib/contracts/docusign/types";
import { PLACEHOLDERS, resolvePlaceholders, validateSendRequest, type PlaceholderValues } from "@/lib/contracts/docusign/validation";
import { ConnectGate, EnvelopeStatusPill, Note, fmtBytes, fmtDateTime, useDocuSignStatus } from "@/components/data/contracts/docusign/shared";

/**
 * Send for Signature: pick documents → add recipients → write the email → choose where signatures go → review → send.
 * The browser validates for instant feedback; the server validates again and is the only one that talks to DocuSign.
 */

const ANCHOR_PRESETS = ["Customer Signed Date:", "Company Signed Date:"];
const POSITIONS: { id: FixedPosition; label: string }[] = [{ id: "bottom-left", label: "Bottom left" }, { id: "bottom-center", label: "Bottom center" }, { id: "bottom-right", label: "Bottom right" }];
const MODES: { id: PlacementMode; label: string; help: string }[] = [
  { id: "free", label: "Let the signer choose", help: "DocuSign lets this person drag their signature onto the document wherever it belongs. Works with every document." },
  { id: "anchor", label: "Next to text in the document", help: "The signature is placed next to text you type below. DocuSign refuses to send if the text isn't found, so nobody gets a document without a signature field." },
  { id: "fixed", label: "Fixed spot on a page", help: "The signature goes on a chosen page and position of the FIRST selected document." },
];

let keySeq = 0;
const newKey = () => `r${Date.now().toString(36)}${(keySeq++).toString(36)}`;
const defaultPlacement = (): SignerPlacement => ({ mode: "free", includeDate: true, includeName: false, includeInitials: false });
const newRecipient = (order: number, type: RecipientType = "signer"): RecipientInput => ({ key: newKey(), name: "", email: "", type, role: type === "signer" ? (order === 1 ? "Customer" : "Company representative") : "", order, placement: type === "signer" ? defaultPlacement() : undefined });

export default function SendForSignature({ isDark, contractId, contractName, contractNumber, accountName, onOpenSettings, onSent }: {
  isDark: boolean; contractId: string; contractName: string; contractNumber: string | null; accountName: string | null;
  onOpenSettings?: () => void; onSent?: (envelopeId: string) => void;
}) {
  const t = tokens(isDark);
  const { data: status } = useDocuSignStatus();
  const connected = status?.status === "connected";

  const [docs, setDocs] = useState<SignableDocument[] | null>(null);
  const [docsError, setDocsError] = useState<ErrorPanelDataLike | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [recipients, setRecipients] = useState<RecipientInput[]>(() => [newRecipient(1)]);
  const [templates, setTemplates] = useState<EmailTemplate[]>(() => listEmailTemplates());
  const [templateId, setTemplateId] = useState(DEFAULT_EMAIL_TEMPLATE_ID);
  const initial = templates.find(x => x.id === DEFAULT_EMAIL_TEMPLATE_ID)!;
  const [subject, setSubject] = useState(initial.subject);
  const [message, setMessage] = useState(initial.message);
  const [companyName, setCompanyName] = useState("");
  const [templateNote, setTemplateNote] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ErrorPanelDataLike | null>(null);
  const [result, setResult] = useState<{ envelope: { envelopeId: string; status: string; statusDateTime: string | null }; view: EnvelopeView | null; message: string } | null>(null);

  useEffect(() => {
    let live = true;
    getCompanySettings().then(s => { if (live && s.companyName) setCompanyName(s.companyName); }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    quoteApiGet<{ documents: SignableDocument[] }>("Load documents for signature", `/api/contracts/${contractId}/signature/documents`)
      .then(r => { if (live) { setDocs(r.documents); setDocsError(null); } })
      .catch(e => { if (live) setDocsError(toErrorPanelData(e, "Couldn't load this contract's documents")); });
    return () => { live = false; };
  }, [connected, contractId]);

  const values: PlaceholderValues = { ContractName: contractName, ContractNumber: contractNumber ?? "", AccountName: accountName ?? "", CompanyName: companyName, RecipientName: recipients[0]?.name || "Recipient" };
  const request = { documentIds: selected, recipients, emailSubject: subject, emailMessage: message, companyName: companyName || undefined };
  const issues = validateSendRequest(request, values);
  const template = templates.find(x => x.id === templateId) ?? null;

  if (!connected) return <ConnectGate isDark={isDark} status={status} onOpenSettings={onOpenSettings} />;

  const updateRecipient = (key: string, patch: Partial<RecipientInput>) => setRecipients(list => list.map(r => (r.key === key ? { ...r, ...patch, ...(patch.type ? { placement: patch.type === "signer" ? r.placement ?? defaultPlacement() : undefined } : {}) } : r)));
  const move = (index: number, dir: -1 | 1) => setRecipients(list => {
    const j = index + dir;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[index], next[j]] = [next[j], next[index]];
    return next.map((r, i) => ({ ...r, order: i + 1 }));
  });
  const toggleDoc = (id: string) => setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));
  const insertToken = (token: string) => setMessage(m => `${m}{{${token}}}`);

  const applyTemplate = (id: string) => {
    const tpl = templates.find(x => x.id === id);
    if (!tpl) return;
    setTemplateId(id); setSubject(tpl.subject); setMessage(tpl.message); setTemplateNote(null);
  };
  const saveAsNew = () => {
    const name = window.prompt("Name for the new template:", template && !template.builtIn ? `${template.name} (copy)` : "My signature request");
    if (!name) return;
    try { const created = createEmailTemplate({ name, subject, message }); setTemplates(listEmailTemplates()); setTemplateId(created.id); setTemplateNote(`Saved "${created.name}".`); }
    catch (e) { setTemplateNote(e instanceof Error ? e.message : "Couldn't save the template."); }
  };
  const saveChanges = () => {
    if (!template || template.builtIn) return;
    try { updateEmailTemplate(template.id, { name: template.name, subject, message }); setTemplates(listEmailTemplates()); setTemplateNote(`Updated "${template.name}".`); }
    catch (e) { setTemplateNote(e instanceof Error ? e.message : "Couldn't update the template."); }
  };
  const duplicate = () => {
    if (!template) return;
    try { const copy = duplicateEmailTemplate({ ...template, subject, message }); setTemplates(listEmailTemplates()); setTemplateId(copy.id); setTemplateNote(`Created "${copy.name}".`); }
    catch (e) { setTemplateNote(e instanceof Error ? e.message : "Couldn't duplicate the template."); }
  };
  const remove = () => {
    if (!template || template.builtIn || !window.confirm(`Delete the template "${template.name}"?`)) return;
    try { deleteEmailTemplate(template.id); const list = listEmailTemplates(); setTemplates(list); applyTemplate(DEFAULT_EMAIL_TEMPLATE_ID); setTemplateNote(`Deleted "${template.name}".`); }
    catch (e) { setTemplateNote(e instanceof Error ? e.message : "Couldn't delete the template."); }
  };

  async function send() {
    setReviewing(false); setSending(true); setSendError(null);
    try {
      const r = await quoteApiPost<{ envelope: { envelopeId: string; status: string; statusDateTime: string | null }; view: EnvelopeView | null; message: string }>("Send for signature", `/api/contracts/${contractId}/signature/envelopes`, { confirmed: true, ...request });
      setResult(r);
    } catch (e) { setSendError(toErrorPanelData(e, "DocuSign did not send the envelope")); }
    finally { setSending(false); }
  }

  const docById = new Map((docs ?? []).map(d => [d.contentVersionId, d]));
  const signerCount = recipients.filter(r => r.type === "signer").length;

  if (result) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Note isDark={isDark} tone="ok"><strong>Sent for signature.</strong> {result.message}</Note>
        <Section title="DocuSign's response" icon="check-circle" isDark={isDark}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: t.body }}>
            <span>Envelope ID: <code style={{ color: t.heading }}>{result.envelope.envelopeId}</code></span>
            <span>Status from DocuSign: <strong style={{ color: t.heading }}>{result.envelope.status}</strong> {result.view && <EnvelopeStatusPill isDark={isDark} envelope={result.view} />}</span>
            <span>Time: {fmtDateTime(result.envelope.statusDateTime)}</span>
            <CodeBlock isDark={isDark} data={result.envelope} />
          </div>
        </Section>
        <div style={{ display: "flex", gap: 8 }}>
          {onSent && <PrimaryButton isDark={isDark} label="Track signatures" icon="activity" onClick={() => onSent(result.envelope.envelopeId)} />}
          <GhostButton isDark={isDark} label="Send another" icon="plus" onClick={() => { setResult(null); setSelected([]); setRecipients([newRecipient(1)]); }} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Note isDark={isDark}>Sending from DocuSign account <strong>{status?.connection?.accountName ?? status?.connection?.accountId}</strong> as <strong>{status?.connection?.userName ?? "you"}</strong>{status?.connection?.environment === "demo" ? " (Demo — not legally binding)" : ""}.</Note>

      <Section title="1. Choose the documents to sign" icon="file-text" isDark={isDark}>
        {docsError && <ErrorPanel isDark={isDark} error={docsError} />}
        {!docs && !docsError && <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.dim }}><Spinner isDark={isDark} size={13} /> Loading documents…</div>}
        {docs && docs.length === 0 && <EmptyState isDark={isDark} icon="file-text" title="No documents on this contract yet" hint="Open the Documents tab, generate the contract document, then come back here." />}
        {docs && docs.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {docs.map(d => {
              const on = selected.includes(d.contentVersionId);
              return (
                <label key={d.contentVersionId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, border: `1px solid ${on ? t.accent : t.border}`, background: on ? `${t.accent}10` : "transparent", opacity: d.compatible ? 1 : 0.55, cursor: d.compatible ? "pointer" : "not-allowed" }}>
                  <input type="checkbox" checked={on} disabled={!d.compatible} onChange={() => toggleDoc(d.contentVersionId)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: t.heading }}>{d.title}</div>
                    <div style={{ fontSize: 11.5, color: t.dim }}>{d.fileExtension.toUpperCase()} · {fmtBytes(d.sizeBytes)} · created {fmtDateTime(d.createdDate)}{d.versionNumber ? ` · version ${d.versionNumber}` : ""}{d.incompatibleReason ? ` · ${d.incompatibleReason}` : ""}</div>
                  </div>
                  <a href={`/api/contracts/${contractId}/documents/${d.contentVersionId}/download?disposition=inline`} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: 12, color: t.accent, fontWeight: 600, display: "inline-flex", gap: 4, alignItems: "center", textDecoration: "none" }}><Ic n="eye" s={12} /> Preview</a>
                </label>
              );
            })}
            {selected.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                <span style={{ fontSize: 11.5, color: t.dim, alignSelf: "center" }}>Selected (in this order):</span>
                {selected.map((id, i) => (
                  <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px", borderRadius: 999, background: `${t.accent}18`, color: t.accent, fontSize: 11.5, fontWeight: 600 }}>
                    {i + 1}. {docById.get(id)?.title ?? id}
                    <button type="button" aria-label="Remove" onClick={() => toggleDoc(id)} style={{ background: "none", border: "none", color: t.accent, cursor: "pointer", padding: 0, display: "inline-flex" }}><Ic n="x" s={11} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="2. Who needs to sign or receive it?" icon="user" isDark={isDark}>
        <div style={{ fontSize: 12.5, color: t.body, marginBottom: 10 }}>Recipients will receive the document in the order configured. People with the same number receive it at the same time.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {recipients.map((r, i) => (
            <RecipientRow key={r.key} isDark={isDark} r={r} index={i} count={recipients.length} onChange={patch => updateRecipient(r.key, patch)} onMove={dir => move(i, dir)} onRemove={() => setRecipients(list => list.filter(x => x.key !== r.key))} />
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <GhostButton isDark={isDark} label="Add signer" icon="plus" onClick={() => setRecipients(list => [...list, newRecipient(list.length + 1)])} />
          <GhostButton isDark={isDark} label="Add copy (CC)" icon="plus" onClick={() => setRecipients(list => [...list, newRecipient(list.length + 1, "cc")])} />
          <GhostButton isDark={isDark} label="Number in list order" icon="list" onClick={() => setRecipients(list => list.map((r, i) => ({ ...r, order: i + 1 })))} />
        </div>
      </Section>

      <Section title="3. Write the email" icon="send" isDark={isDark}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="Template" isDark={isDark} help={null}>
              <select value={templateId} onChange={e => applyTemplate(e.target.value)} style={inputStyle(t)}>
                <optgroup label="Built-in">{templates.filter(x => x.builtIn).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>
                {templates.some(x => !x.builtIn) && <optgroup label="My templates">{templates.filter(x => !x.builtIn).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>}
              </select>
            </Field>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <GhostButton isDark={isDark} label="Save as new template" icon="save" onClick={saveAsNew} />
              {template && !template.builtIn && <GhostButton isDark={isDark} label="Save changes" icon="check" onClick={saveChanges} />}
              <GhostButton isDark={isDark} label="Duplicate" icon="copy" onClick={duplicate} />
              {template && !template.builtIn && <GhostButton isDark={isDark} label="Delete" icon="trash" danger onClick={remove} />}
            </div>
            {templateNote && <div style={{ fontSize: 11.5, color: t.dim }}>{templateNote} Custom templates are saved in this browser.</div>}
            <Field label="Email subject" isDark={isDark} hint="Up to 100 characters after placeholders are filled in." help={null}>
              <input value={subject} onChange={e => setSubject(e.target.value)} style={inputStyle(t)} />
            </Field>
            <Field label="Email message" isDark={isDark} help={null}>
              <textarea value={message} onChange={e => setMessage(e.target.value)} rows={8} style={{ ...inputStyle(t), resize: "vertical", fontFamily: "inherit" }} />
            </Field>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 11.5, color: t.dim }}>Insert:</span>
              {PLACEHOLDERS.map(p => <button key={p} type="button" onClick={() => insertToken(p)} style={{ fontSize: 11, padding: "2px 7px", borderRadius: 7, border: `1px solid ${t.border}`, background: "transparent", color: t.body, cursor: "pointer" }}>{`{{${p}}}`}</button>)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: t.dim, textTransform: "uppercase", marginBottom: 6 }}>Preview{recipients[0]?.name ? ` — as ${recipients[0].name} sees it` : ""}</div>
            <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 14, background: t.surfaceAlt }}>
              <div style={{ fontSize: 11.5, color: t.dim }}>From: {status?.connection?.userName ?? "you"} via DocuSign</div>
              <div style={{ fontSize: 11.5, color: t.dim }}>To: {recipients.map(r => r.email || "…").join(", ")}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: t.heading, margin: "8px 0" }}>{resolvePlaceholders(subject, values) || "(no subject)"}</div>
              <div style={{ fontSize: 12.5, color: t.body, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{resolvePlaceholders(message, values)}</div>
              <div style={{ marginTop: 12, display: "inline-block", padding: "7px 14px", borderRadius: 6, background: "#FFC820", color: "#1E1E1E", fontSize: 12, fontWeight: 700 }}>REVIEW DOCUMENT</div>
              <div style={{ fontSize: 11, color: t.dim, marginTop: 8 }}>Attached: {selected.map(id => docById.get(id)?.title ?? id).join(", ") || "no documents selected"}</div>
            </div>
          </div>
        </div>
      </Section>

      <Section title="4. Where should people sign?" icon="edit" isDark={isDark}>
        {signerCount === 0 ? <div style={{ fontSize: 12.5, color: t.dim }}>Add a signer in step 2.</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 12.5, color: t.body }}>By default each signer chooses where to sign. For documents made from OmniCloud&apos;s built-in templates you can place signatures next to <code>Customer Signed Date:</code> and <code>Company Signed Date:</code>.</div>
            {recipients.filter(r => r.type === "signer").map(r => (
              <PlacementEditor key={r.key} isDark={isDark} r={r} onChange={placement => updateRecipient(r.key, { placement })} />
            ))}
          </div>
        )}
      </Section>

      <Section title="5. Review and send" icon="check-circle" isDark={isDark}>
        {issues.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 12.5, color: t.body, marginBottom: 2 }}>Fix these before sending:</div>
            {issues.slice(0, 12).map((i, n) => <div key={n} style={{ fontSize: 12.5, color: t.warn, display: "flex", gap: 6 }}><Ic n="alert" s={13} /> {i.message}</div>)}
          </div>
        ) : <Note isDark={isDark} tone="ok">Everything looks ready. Click <strong>Review and send</strong> to see a final summary.</Note>}
        {sendError && <div style={{ marginTop: 10 }}><ErrorPanel isDark={isDark} error={sendError} /></div>}
        <div style={{ marginTop: 12 }}>
          <PrimaryButton isDark={isDark} label={sending ? "Sending to DocuSign…" : "Review and send"} icon="send" disabled={issues.length > 0 || sending} onClick={() => setReviewing(true)} />
        </div>
      </Section>

      {reviewing && (
        <Modal isDark={isDark} title="Send for signature?" tone="accent" actions={<>
          <GhostButton isDark={isDark} label="Go back" onClick={() => setReviewing(false)} />
          <PrimaryButton isDark={isDark} label="Send for Signature" icon="send" onClick={send} />
        </>}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5 }}>
            <div><strong>Contract:</strong> {contractName}</div>
            <div><strong>Documents:</strong> {selected.map(id => docById.get(id)?.title ?? id).join(", ")}</div>
            <div><strong>Recipients (in signing order):</strong>
              <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {[...recipients].sort((a, b) => a.order - b.order).map(r => <li key={r.key}>#{r.order} {r.name} &lt;{r.email}&gt; — {RECIPIENT_TYPE_LABEL[r.type]}{r.role ? ` (${r.role})` : ""}{r.type === "signer" ? ` · ${placementSummary(r.placement)}` : ""}</li>)}
              </ol>
            </div>
            <div><strong>Subject:</strong> {resolvePlaceholders(subject, values)}</div>
            <div style={{ whiteSpace: "pre-wrap", maxHeight: 140, overflowY: "auto" }}><strong>Message:</strong> {resolvePlaceholders(message, values)}</div>
            <div style={{ color: tokens(isDark).warn }}>DocuSign will email {recipients.length} {recipients.length === 1 ? "person" : "people"} as soon as you click Send.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function placementSummary(p: SignerPlacement | undefined): string {
  if (!p) return "no signature setting";
  const extras = [p.includeDate && "date", p.includeName && "name", p.includeInitials && "initials"].filter(Boolean).join(", ");
  const where = p.mode === "free" ? "signer chooses where to sign" : p.mode === "anchor" ? `signs next to "${p.anchorText ?? ""}"` : `signs on page ${p.page} (${p.position})`;
  return extras ? `${where} + ${extras}` : where;
}

function RecipientRow({ isDark, r, index, count, onChange, onMove, onRemove }: {
  isDark: boolean; r: RecipientInput; index: number; count: number; onChange: (p: Partial<RecipientInput>) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void;
}) {
  const t = tokens(isDark);
  const [showNote, setShowNote] = useState(!!r.note);
  const iconBtn = (icon: string, label: string, onClick: () => void, disabled = false) => (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} style={{ padding: 6, borderRadius: 8, border: `1px solid ${t.border}`, background: "transparent", color: disabled ? t.dim : t.body, cursor: disabled ? "not-allowed" : "pointer", display: "inline-flex", opacity: disabled ? 0.4 : 1 }}><Ic n={icon} s={13} /></button>
  );
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "64px minmax(0,1.2fr) minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) auto", gap: 8, alignItems: "end" }}>
        <Field label="Order" isDark={isDark} help={null}><input type="number" min={1} max={99} value={r.order} onChange={e => onChange({ order: Number(e.target.value) })} style={inputStyle(t)} /></Field>
        <Field label="Full name" isDark={isDark} help={null}><input value={r.name} onChange={e => onChange({ name: e.target.value })} placeholder="Jane Smith" style={inputStyle(t)} /></Field>
        <Field label="Email" isDark={isDark} help={null}><input type="email" value={r.email} onChange={e => onChange({ email: e.target.value })} placeholder="jane@company.com" style={inputStyle(t)} /></Field>
        <Field label="What they do" isDark={isDark} help={null}>
          <select value={r.type} onChange={e => onChange({ type: e.target.value as RecipientType })} style={inputStyle(t)}>
            {(Object.keys(RECIPIENT_TYPE_LABEL) as RecipientType[]).map(k => <option key={k} value={k}>{RECIPIENT_TYPE_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="Role (label)" isDark={isDark} help={null}><input value={r.role} onChange={e => onChange({ role: e.target.value })} placeholder="Customer" style={inputStyle(t)} /></Field>
        <div style={{ display: "flex", gap: 4, paddingBottom: 2 }}>
          {iconBtn("chevron-left", "Move up", () => onMove(-1), index === 0)}
          {iconBtn("chevron-right", "Move down", () => onMove(1), index === count - 1)}
          {iconBtn("trash", "Remove", onRemove, count === 1)}
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: t.dim }}>
        {r.type === "signer" ? "Signs the document." : r.type === "cc" ? "Gets a copy when everyone has signed; does not sign." : "Must open and view the document; does not sign."}{" "}
        <button type="button" onClick={() => setShowNote(v => !v)} style={{ background: "none", border: "none", color: t.accent, cursor: "pointer", fontSize: 11.5, padding: 0 }}>{showNote ? "Hide private message" : "Add a private message"}</button>
      </div>
      {showNote && <textarea value={r.note ?? ""} onChange={e => onChange({ note: e.target.value })} rows={2} placeholder="Only this person sees this message." style={{ ...inputStyle(t), resize: "vertical", fontFamily: "inherit" }} />}
    </div>
  );
}

function PlacementEditor({ isDark, r, onChange }: { isDark: boolean; r: RecipientInput; onChange: (p: SignerPlacement) => void }) {
  const t = tokens(isDark);
  const p = r.placement ?? defaultPlacement();
  const set = (patch: Partial<SignerPlacement>) => onChange({ ...p, ...patch });
  const check = (key: "includeDate" | "includeName" | "includeInitials", label: string) => (
    <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12.5, color: t.body, opacity: p.mode === "free" ? 0.5 : 1 }}>
      <input type="checkbox" checked={p[key]} disabled={p.mode === "free"} onChange={e => set({ [key]: e.target.checked })} /> {label}
    </label>
  );
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: t.heading }}>#{r.order} {r.name || "Unnamed signer"}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {MODES.map(m => (
          <button key={m.id} type="button" onClick={() => set({ mode: m.id, ...(m.id === "anchor" && !p.anchorText ? { anchorText: ANCHOR_PRESETS[r.order === 1 ? 0 : 1] } : {}), ...(m.id === "fixed" && !p.page ? { page: 1, position: "bottom-left" as FixedPosition } : {}) })}
            style={{ padding: "6px 12px", borderRadius: 9, fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${p.mode === m.id ? t.accent : t.border}`, background: p.mode === m.id ? `${t.accent}18` : "transparent", color: p.mode === m.id ? t.accent : t.body }}>{m.label}</button>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: t.dim }}>{MODES.find(m => m.id === p.mode)?.help}</div>
      {p.mode === "anchor" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
          <div style={{ flex: "1 1 260px" }}><Field label="Place next to this text" isDark={isDark} help={null}><input value={p.anchorText ?? ""} onChange={e => set({ anchorText: e.target.value })} style={inputStyle(t)} /></Field></div>
          {ANCHOR_PRESETS.map(a => <GhostButton key={a} isDark={isDark} label={a} onClick={() => set({ anchorText: a })} />)}
        </div>
      )}
      {p.mode === "fixed" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{ width: 110 }}><Field label="Page" isDark={isDark} help={null}><input type="number" min={1} value={p.page ?? 1} onChange={e => set({ page: Number(e.target.value) })} style={inputStyle(t)} /></Field></div>
          <div style={{ width: 200 }}><Field label="Position" isDark={isDark} help={null}>
            <select value={p.position ?? "bottom-left"} onChange={e => set({ position: e.target.value as FixedPosition })} style={inputStyle(t)}>{POSITIONS.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
          </Field></div>
        </div>
      )}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {check("includeDate", "Date signed")}
        {check("includeName", "Full name")}
        {check("includeInitials", "Initials")}
      </div>
    </div>
  );
}
