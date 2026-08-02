"use client";

import { useCallback, useEffect, useState } from "react";
import { Ic, tokens, inputStyle, Field, PrimaryButton, GhostButton, EmptyState, Spinner, ErrorPanel, Pill } from "@/components/data/quotes/shared";
import SignatureStatusStepper from "@/components/data/contracts/SignatureStatusStepper";
import { quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { updateResponseSummary } from "@/lib/quotes/client/responseSummary";
import { DEFAULT_EMAIL_SUBJECT, DEFAULT_EMAIL_BODY, substituteEmailTokens } from "@/lib/contracts/docusign/emailPreview";
import * as signatureStore from "@/lib/contracts/docusign/localSignatureStore";
import type { GeneratedDocument, SignatureRecipient, SignatureRequest } from "@/lib/contracts/types";

const RECIPIENT_TYPES = ["Customer", "Internal Approver", "Legal Team", "Finance", "Sales Representative", "Other"];

/** The shape GET /api/contracts/docusign/envelopes/[envelopeId]/diagnostics returns — queried fresh from DocuSign on demand, never persisted into localSignatureStore. */
interface EnvelopeStatusCheck {
  envelopeId: string;
  envelopeStatus: string;
  sentDateTime: string | null;
  recipients: {
    name: string;
    maskedEmail: string;
    status: string | null;
    deliveryMethod: string | null;
    sentDateTime: string | null;
    deliveredDateTime: string | null;
    signedDateTime: string | null;
    declinedDateTime: string | null;
  }[];
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

const RECIPIENT_STATE_COLOR = { accepted: "#5A7AA0", sent: "#00D4FF", delivered: "#00D4FF", signed: "#22C55E", problem: "#FF4066" } as const;

/**
 * Distinguishes "DocuSign accepted the envelope" from "the recipient actually
 * received/opened the email" — never claims delivery/viewing merely because
 * DocuSign's status is "sent." Derived only from the recipient's OWN
 * DocuSign-reported timestamps/status, never from our own HTTP 201/local
 * "Sent" bookkeeping.
 */
function recipientDeliveryState(r: EnvelopeStatusCheck["recipients"][number]): { label: string; color: keyof typeof RECIPIENT_STATE_COLOR } {
  if (r.signedDateTime) return { label: "Signed", color: "signed" };
  if (r.declinedDateTime) return { label: "Declined", color: "problem" };
  if (r.deliveredDateTime) return { label: "Delivered/Viewed", color: "delivered" };
  const status = (r.status ?? "").toLowerCase();
  if (status === "autoresponded" || status === "delivery_failure" || status === "delivered_failed") return { label: "Delivery Problem", color: "problem" };
  if (r.sentDateTime || status === "sent") return { label: "Email Invitation Sent", color: "sent" };
  return { label: "DocuSign Accepted", color: "accepted" };
}

/**
 * Signatures tab — a simple, enterprise-quality send-for-signature workflow
 * scoped to the current Contract's generated documents. Each generated
 * document gets its OWN independent signature request (recipients, email
 * template, status/timeline) — sending document A for signature must never
 * lock document B on the same Contract; every document has its own Draft /
 * Ready to Send / Sent stage. All of this lives client-side in
 * lib/contracts/docusign/localSignatureStore.ts (browser localStorage) —
 * there is no database and no DATABASE_URL dependency anywhere in this flow.
 * The Generated Documents list is NOT a separate store: it's the exact same
 * Salesforce-backed `/api/contracts/[id]/documents` list the Documents tab
 * already shows — one source of truth, fetched here too.
 * "Send for Signature" calls the REAL DocuSign envelope-create-and-send API
 * (lib/contracts/docusign/envelope.ts's sendContractForSignature) — status
 * only ever reaches Draft / Ready to Send / Sent here because that's as far
 * as envelope CREATION goes; "Sent" means DocuSign accepted the envelope,
 * NOT that the recipient received/viewed/signed it. "Check DocuSign Status"
 * queries the real envelope from DocuSign on demand (no webhook yet) to
 * show those later states only once DocuSign actually reports them.
 */
export default function SignaturePanel({ isDark, contractId, contractLabel, initialContentVersionId }: {
  isDark: boolean; contractId: string; contractLabel: string;
  /** Set when arriving via Documents tab's "Use for Signature" — opens with that specific document pre-selected. */
  initialContentVersionId?: string;
}) {
  const t = tokens(isDark);
  const [documents, setDocuments] = useState<GeneratedDocument[]>([]);
  // Every document's OWN signature request, keyed by contentVersionId — lets
  // the document list show each one's own stage without switching to it.
  const [statesByDoc, setStatesByDoc] = useState<Record<string, SignatureRequest>>({});
  const [selectedDocId, setSelectedDocId] = useState<string>("");
  const [recipients, setRecipients] = useState<SignatureRecipient[]>([]);
  const [emailSubject, setEmailSubject] = useState(DEFAULT_EMAIL_SUBJECT);
  const [emailBody, setEmailBody] = useState(DEFAULT_EMAIL_BODY);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [switchingDoc, setSwitchingDoc] = useState(false);
  const [savingRecipients, setSavingRecipients] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [docuSignStatus, setDocuSignStatus] = useState<EnvelopeStatusCheck | null>(null);

  const request = selectedDocId ? statesByDoc[selectedDocId] ?? null : null;

  function applyWorkingState(req: SignatureRequest) {
    setStatesByDoc(prev => ({ ...prev, [req.sourceContentVersionId as string]: req }));
    setRecipients(req.recipients);
    setEmailSubject(req.emailSubject ?? DEFAULT_EMAIL_SUBJECT);
    setEmailBody(req.emailBody ?? DEFAULT_EMAIL_BODY);
  }

  /** Switches which document's own signature request is being viewed/edited — always allowed regardless of any OTHER document's lock state on this Contract. */
  const selectDocument = useCallback(async (doc: GeneratedDocument) => {
    setSwitchingDoc(true);
    setError(null);
    setDocuSignStatus(null);
    setEditingIndex(null);
    try {
      const req = await signatureStore.getOrCreateSignatureState(contractId, doc.contentVersionId, doc.title);
      setSelectedDocId(doc.contentVersionId);
      applyWorkingState(req);
    } catch (err) {
      setError(toErrorPanelData(err, "Could not load this document's signature request"));
    } finally {
      setSwitchingDoc(false);
    }
  }, [contractId]);

  // Opening a different Contract must show ONLY that Contract's documents
  // and signature states — never a stale carry-over.
  useEffect(() => {
    let cancelled = false;
    setStatesByDoc({});
    setSelectedDocId("");
    signatureStore.listSignatureStatesForContract(contractId).then(rows => {
      if (cancelled) return;
      setStatesByDoc(Object.fromEntries(rows.filter(r => r.sourceContentVersionId).map(r => [r.sourceContentVersionId as string, r])));
    });
    quoteApiGet<{ documents: GeneratedDocument[] }>("List contract documents", `/api/contracts/${contractId}/documents`)
      .then(res => { if (!cancelled) setDocuments(res.documents); })
      .catch(err => { if (!cancelled) setError(toErrorPanelData(err, "Could not load generated documents")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contractId]);

  // Once documents are loaded, settle on which one is selected: the one
  // "Use for Signature" jumped here with, else the first available document.
  // Runs once per contractId/documents-load, not on every render.
  useEffect(() => {
    if (loading || selectedDocId || documents.length === 0) return;
    const target = documents.find(d => d.contentVersionId === initialContentVersionId) ?? documents[0];
    selectDocument(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, documents]);

  const locked = !!request?.envelopeId;

  function addRecipient() {
    setRecipients(r => {
      const next = [...r, { name: "", email: "", role: RECIPIENT_TYPES[0], order: r.length + 1, status: null }];
      setEditingIndex(next.length - 1);
      return next;
    });
  }
  function updateRecipient(i: number, patch: Partial<SignatureRecipient>) {
    setRecipients(r => r.map((rec, idx) => (idx === i ? { ...rec, ...patch } : rec)));
  }
  function removeRecipient(i: number) {
    setRecipients(r => r.filter((_, idx) => idx !== i).map((rec, idx) => ({ ...rec, order: idx + 1 })));
    setEditingIndex(null);
  }

  async function handleSaveRecipients() {
    setSavingRecipients(true);
    setError(null);
    try {
      const saved = await signatureStore.setRecipients(contractId, selectedDocId, recipients);
      applyWorkingState(saved);
      setEditingIndex(null);
    } catch (err) {
      setError(toErrorPanelData(err, "Could not save recipients"));
    } finally {
      setSavingRecipients(false);
    }
  }

  /** Persists recipients + email content together — everything "Save Draft" covers, reused by Send so what gets sent always matches what was last shown. */
  async function persistDraft(): Promise<SignatureRequest> {
    await signatureStore.setRecipients(contractId, selectedDocId, recipients);
    return signatureStore.setEmailContent(contractId, selectedDocId, emailSubject, emailBody);
  }

  async function handleSaveDraft() {
    setSavingDraft(true);
    setError(null);
    try {
      const saved = await persistDraft();
      applyWorkingState(saved);
      setEditingIndex(null);
    } catch (err) {
      setError(toErrorPanelData(err, "Could not save this draft"));
    } finally {
      setSavingDraft(false);
    }
  }

  /** The only place a real DocuSign envelope gets created — everything else here is local state. A failed send never marks this Sent, and never touches any other document's own request. */
  async function handleSend() {
    setSending(true);
    setError(null);
    try {
      await signatureStore.assertReadyToSend(contractId, selectedDocId);
      await persistDraft();
      const res = await quoteApiPost<{ envelopeId: string; envelopeStatus: string; sentDateTime: string | null }>(
        "Send for signature", `/api/contracts/${contractId}/signature/send`,
        {
          recipients,
          contentVersionId: selectedDocId,
          documentName: selectedDoc?.title ?? "Contract Document",
          contractNumber: contractLabel,
          // Already token-substituted (same text the Live Preview shows) — DocuSign gets exactly what the user saw, not raw {{tokens}}.
          emailSubject: previewSubject,
          emailBody: previewBody,
        },
      );
      const saved = await signatureStore.recordSent(contractId, selectedDocId, res.envelopeId, res.envelopeStatus, res.sentDateTime);
      applyWorkingState(saved);
      setEditingIndex(null);
      updateResponseSummary({ contractSignature: saved });
    } catch (err) {
      setError(toErrorPanelData(err, "Could not send this document for signature"));
    } finally {
      setSending(false);
    }
  }

  function handleCancel() {
    if (request) applyWorkingState(request);
    setEditingIndex(null);
    setError(null);
  }

  /** Queries the REAL envelope from DocuSign on demand — never reads/writes localSignatureStore, so this can never be confused with (or silently promoted into) our own "Sent" bookkeeping. No webhook — manual refresh only, for now. */
  async function handleCheckStatus() {
    if (!request?.envelopeId) return;
    setCheckingStatus(true);
    setError(null);
    try {
      const res = await quoteApiGet<EnvelopeStatusCheck>("Check DocuSign status", `/api/contracts/docusign/envelopes/${request.envelopeId}/diagnostics`);
      setDocuSignStatus(res);
    } catch (err) {
      setError(toErrorPanelData(err, "Could not check DocuSign status"));
    } finally {
      setCheckingStatus(false);
    }
  }

  function handlePreviewDocument(doc: GeneratedDocument) {
    window.open(`/api/contracts/${contractId}/documents/${doc.contentVersionId}/download?disposition=inline`, "_blank");
  }

  const previewRecipientName = recipients[0]?.name?.trim() || "Recipient";
  const previewSubject = substituteEmailTokens(emailSubject, { contractNumber: contractLabel, recipientName: previewRecipientName });
  const previewBody = substituteEmailTokens(emailBody, { contractNumber: contractLabel, recipientName: previewRecipientName });
  const selectedDoc = documents.find(d => d.contentVersionId === selectedDocId) ?? null;

  const canSend = !locked && recipients.length > 0 && recipients.every(r => r.name.trim() && r.email.trim()) && !!selectedDocId;

  /** Each document's own stage — "Draft" for a document that has no signature request row yet, i.e. never touched. */
  function docStage(doc: GeneratedDocument): string {
    return statesByDoc[doc.contentVersionId]?.status ?? "Draft";
  }
  function stageColor(stage: string): string {
    if (stage === "Sent" || stage === "Completed") return t.accent;
    if (stage === "Ready to Send") return t.accentBlue;
    if (stage === "Customer Signed" || stage === "Company Signed" || stage === "Viewed") return t.accentCyan;
    return t.dim;
  }

  if (loading) {
    return <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}><Spinner isDark={isDark} /> Loading signature request…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && <ErrorPanel isDark={isDark} error={error} />}

      {/* Top: Status Bar */}
      <div style={{ padding: 14, borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface }}>
        {selectedDoc && (
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
            <Ic n="file-text" s={12} /> Showing the signature request for <strong style={{ color: t.body }}>{selectedDoc.title}</strong> — every other document on this Contract keeps its own independent status.
          </div>
        )}
        <SignatureStatusStepper isDark={isDark} current={request?.status ?? "Draft"} />
        {locked && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 11, color: t.dim, display: "flex", alignItems: "center", gap: 6 }}>
                <Ic n="info" s={12} /> Sent via DocuSign — envelope {request?.envelopeId}. This confirms DocuSign ACCEPTED the envelope, not that the recipient received/viewed/signed it.
              </div>
              <GhostButton label={checkingStatus ? "Checking…" : "Check DocuSign Status"} icon="refresh" isDark={isDark} disabled={checkingStatus} onClick={handleCheckStatus} />
            </div>

            {docuSignStatus && (
              <div style={{ padding: 10, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 11.5 }}>
                <div style={{ fontWeight: 700, color: t.heading, marginBottom: 6 }}>
                  Envelope: {docuSignStatus.envelopeStatus}
                  {docuSignStatus.sentDateTime && <span style={{ color: t.dim, fontWeight: 400 }}> · sent {new Date(docuSignStatus.sentDateTime).toLocaleString()}</span>}
                </div>
                {docuSignStatus.recipients.map((r, i) => {
                  const state = recipientDeliveryState(r);
                  return (
                  <div key={i} style={{ paddingTop: i > 0 ? 6 : 0, marginTop: i > 0 ? 6 : 0, borderTop: i > 0 ? `1px solid ${t.border}` : "none" }}>
                    <div style={{ color: t.body, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <strong>{r.name || r.maskedEmail}</strong> ({r.maskedEmail})
                      <Pill label={state.label} color={RECIPIENT_STATE_COLOR[state.color]} isDark={isDark} />
                      <span style={{ color: t.dim, fontSize: 10.5 }}>(DocuSign status: {r.status ?? "unknown"}{r.deliveryMethod ? ` · ${r.deliveryMethod}` : ""})</span>
                    </div>
                    <div style={{ color: t.dim, fontSize: 10.5, marginTop: 2 }}>
                      Sent: {r.sentDateTime ? new Date(r.sentDateTime).toLocaleString() : "—"}
                      {" · "}Delivered: {r.deliveredDateTime ? new Date(r.deliveredDateTime).toLocaleString() : "—"}
                      {" · "}Signed: {r.signedDateTime ? new Date(r.signedDateTime).toLocaleString() : "—"}
                      {r.declinedDateTime && <> · Declined: {new Date(r.declinedDateTime).toLocaleString()}</>}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {request?.timeline && request.timeline.length > 0 && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
            {[...request.timeline].reverse().map((entry, i) => (
              <div key={i} style={{ fontSize: 11, color: t.body, display: "flex", gap: 8 }}>
                <span style={{ color: t.dim, flexShrink: 0 }}>{new Date(entry.at).toLocaleString()}</span>
                <span>{entry.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Middle: Documents (left) + Recipients (right) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
        <div style={{ padding: 14, borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: t.heading, marginBottom: 10 }}>
            <Ic n="file-text" s={14} /> Generated Documents
          </div>
          {documents.length === 0 ? (
            <div style={{ fontSize: 12, color: t.dim }}>No generated documents for this contract.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {documents.map(doc => {
                const active = doc.contentVersionId === selectedDocId;
                const stage = docStage(doc);
                return (
                  <div
                    key={doc.contentVersionId}
                    style={{
                      padding: "10px 12px", borderRadius: 10,
                      border: `1px solid ${active ? t.accent + "60" : t.border}`,
                      background: active ? `${t.accent}12` : t.surfaceAlt,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: t.heading, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.title}</div>
                        <div style={{ fontSize: 10.5, color: t.dim, marginTop: 3 }}>v{doc.versionNumber ?? "—"} · {fmtDate(doc.createdDate)}</div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end", flexShrink: 0 }}>
                        <Pill label={doc.isLatest ? "Latest" : "Superseded"} color={doc.isLatest ? t.accent : t.dim} isDark={isDark} />
                        <Pill label={stage} color={stageColor(stage)} isDark={isDark} />
                      </div>
                    </div>
                    <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                      <button onClick={() => handlePreviewDocument(doc)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 6, border: `1px solid ${t.border}`, background: "transparent", color: t.body, cursor: "pointer", fontSize: 10.5 }}>
                        <Ic n="eye" s={11} /> Preview
                      </button>
                      {active ? (
                        <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 700, color: t.accent }}>
                          <Ic n="check-circle" s={12} /> Currently viewing
                        </span>
                      ) : (
                        <button
                          onClick={() => selectDocument(doc)}
                          disabled={switchingDoc}
                          style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 6, border: `1px solid ${t.accent}60`, background: `${t.accent}14`, color: t.accent, cursor: switchingDoc ? "default" : "pointer", fontSize: 10.5, fontWeight: 700 }}
                        >
                          <Ic n="send" s={11} /> View / Manage Signature
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ padding: 14, borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: t.heading, marginBottom: 10 }}>
            <Ic n="user" s={14} /> Recipients
          </div>
          {recipients.length === 0 && <EmptyState isDark={isDark} icon="user" title="No recipients yet" />}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {recipients.map((r, i) => (
              <div key={i} style={{ padding: "8px 10px", borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt }}>
                {editingIndex === i && !locked ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <input placeholder="Name" value={r.name} onChange={e => updateRecipient(i, { name: e.target.value })} style={inputStyle(t)} />
                    <input placeholder="Email" type="email" value={r.email} onChange={e => updateRecipient(i, { email: e.target.value })} style={inputStyle(t)} />
                    <select value={r.role} onChange={e => updateRecipient(i, { role: e.target.value })} style={inputStyle(t)}>
                      {RECIPIENT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                    </select>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <GhostButton label="Done" icon="check" isDark={isDark} onClick={() => setEditingIndex(null)} />
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: t.heading }}>{r.name || "(unnamed)"}</div>
                      <div style={{ fontSize: 11, color: t.dim }}>{r.email || "(no email)"}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      <Pill label={r.role} color={t.accentBlue} isDark={isDark} />
                      {!locked && (
                        <>
                          <button onClick={() => setEditingIndex(i)} title="Edit" style={{ background: "transparent", border: `1px solid ${t.border}`, borderRadius: 6, padding: "4px 6px", cursor: "pointer", color: t.body }}><Ic n="edit" s={11} /></button>
                          <button onClick={() => removeRecipient(i)} title="Delete" style={{ background: "transparent", border: `1px solid ${t.error}50`, borderRadius: 6, padding: "4px 6px", cursor: "pointer", color: t.error }}><Ic n="trash" s={11} /></button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          {!locked && (
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <GhostButton label="Add Recipient" icon="plus" isDark={isDark} onClick={addRecipient} />
              <PrimaryButton label={savingRecipients ? "Saving…" : "Save Recipients"} icon="check" isDark={isDark} disabled={savingRecipients || recipients.length === 0} onClick={handleSaveRecipients} />
            </div>
          )}
          {locked && <div style={{ fontSize: 11, color: t.dim, marginTop: 8 }}>This request has already been sent — recipients can no longer be edited.</div>}
        </div>
      </div>

      {/* Bottom: Email Preview */}
      <div style={{ padding: 14, borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: t.heading, marginBottom: 10 }}>
          <Ic n="send" s={14} /> Email Preview
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="Subject" isDark={isDark}>
              <input value={emailSubject} disabled={locked} onChange={e => setEmailSubject(e.target.value)} style={inputStyle(t)} />
            </Field>
            <Field label="Email Body" isDark={isDark}>
              <textarea rows={7} value={emailBody} disabled={locked} onChange={e => setEmailBody(e.target.value)} style={{ ...inputStyle(t), resize: "vertical", fontFamily: "inherit" }} />
            </Field>
            <div style={{ fontSize: 10.5, color: t.dim }}>Tokens: <code>{"{{ContractNumber}}"}</code>, <code>{"{{RecipientName}}"}</code></div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Live Preview</div>
            <div style={{ padding: 12, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 12.5 }}>
              <div style={{ fontWeight: 700, color: t.heading, marginBottom: 8 }}>Subject: {previewSubject}</div>
              <div style={{ color: t.body, whiteSpace: "pre-wrap" }}>{previewBody}</div>
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${t.border}`, fontSize: 11, color: t.dim }}>
                Attachment: {selectedDoc ? selectedDoc.title : "(no document selected)"}
              </div>
              {recipients.length > 1 && (
                <div style={{ marginTop: 6, fontSize: 10.5, color: t.dim }}>Shown for the first recipient — each of the {recipients.length} recipients gets their own personalized copy.</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
        <GhostButton label="Cancel" icon="x" isDark={isDark} onClick={handleCancel} />
        <GhostButton label={savingDraft ? "Saving…" : "Save Draft"} icon="save" isDark={isDark} disabled={locked || savingDraft} onClick={handleSaveDraft} />
        <PrimaryButton label={sending ? "Sending…" : "Send for Signature"} icon="send" isDark={isDark} disabled={!canSend || sending} onClick={handleSend} />
      </div>
      {!canSend && !locked && (
        <div style={{ fontSize: 11, color: t.dim, textAlign: "right", marginTop: -10 }}>
          {recipients.length === 0 ? "Add at least one recipient. " : recipients.some(r => !r.name.trim() || !r.email.trim()) ? "Every recipient needs a name and email. " : ""}{!selectedDocId ? "Select a document to send." : ""}
        </div>
      )}
    </div>
  );
}
