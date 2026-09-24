"use client";

import { useCallback, useEffect, useState } from "react";
import { Ic, tokens, inputStyle, Field, PrimaryButton, GhostButton, EmptyState, Spinner, ErrorPanel, Pill } from "@/components/data/quotes/shared";
import SignatureStatusStepper from "@/components/data/contracts/SignatureStatusStepper";
import { quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { updateResponseSummary } from "@/lib/quotes/client/responseSummary";
import { DEFAULT_EMAIL_SUBJECT, DEFAULT_EMAIL_BODY, substituteEmailTokens } from "@/lib/contracts/docusign/emailPreview";
import * as signatureStore from "@/lib/contracts/docusign/localSignatureStore";
import type { GeneratedDocument, SignatureRecipient, SignatureRequest, SignatureStage, SignatureTimelineEntry } from "@/lib/contracts/types";

const RECIPIENT_TYPES = ["Customer", "Internal Approver", "Legal Team", "Finance", "Sales Representative", "Other"];

/** The shape POST /api/contracts/docusign/envelopes/[envelopeId]/refresh returns — queried fresh from DocuSign on demand AND persisted (forward-only, deduplicated) into both the server-side tracking store and this browser's localSignatureStore. */
interface EnvelopeStatusCheck {
  envelopeId: string;
  envelopeStatus: string;
  sentDateTime: string | null;
  recipients: {
    recipientId: string;
    name: string;
    maskedEmail: string;
    status: string | null;
    deliveryMethod: string | null;
    sentDateTime: string | null;
    deliveredDateTime: string | null;
    signedDateTime: string | null;
    declinedDateTime: string | null;
    autoRespondedReason: string | null;
    declinedReason: string | null;
  }[];
  stage: SignatureStage;
  timeline: SignatureTimelineEntry[];
  signedContentVersionId: string | null;
  salesforceWriteback: { attempted: boolean; companyDateWritten: boolean; customerDateWritten: boolean; notes: string[] };
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

/** Distinct from "Declined" (a deliberate recipient action) and "Signed" — this is specifically a bounce/auto-response DocuSign detected on its own, the one case "Correct & Resend" (§Phase 6) can actually fix by changing the recipient's email. */
function isUndeliverable(r: EnvelopeStatusCheck["recipients"][number]): boolean {
  if (r.signedDateTime || r.declinedDateTime) return false;
  const status = (r.status ?? "").toLowerCase();
  return status === "autoresponded" || status === "delivery_failure" || status === "delivered_failed";
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
  /** "Send Signing Email" — a SEPARATE test/delivery option from Send for Signature above; never touches signatureStore/request.envelopeId. */
  const [sendingTestLink, setSendingTestLink] = useState(false);
  const [testLinkResult, setTestLinkResult] = useState<{
    envelopeId: string; signingLink: string; isLocalhost: boolean;
    senderName: string | null; senderEmail: string | null;
    recipientName: string; recipientEmail: string; documentName: string;
  } | null>(null);
  const [emailDraftOpened, setEmailDraftOpened] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [docuSignStatus, setDocuSignStatus] = useState<EnvelopeStatusCheck | null>(null);
  const [retrievingDocument, setRetrievingDocument] = useState(false);
  /** recipientId currently being corrected, if the "Correct & Resend" inline field is open for it — null means no correction UI is showing. */
  const [correctingRecipientId, setCorrectingRecipientId] = useState<string | null>(null);
  const [correctedEmailInput, setCorrectedEmailInput] = useState("");
  const [correcting, setCorrecting] = useState(false);

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
      const res = await quoteApiPost<{
        envelopeId: string; envelopeStatus: string; sentDateTime: string | null;
        senderName: string | null; senderEmail: string | null; senderUserId: string | null; senderCopyRequested: boolean;
        recipients: { recipientId: string; status: string | null }[];
      }>(
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
      const saved = await signatureStore.recordSent(contractId, selectedDocId, {
        envelopeId: res.envelopeId,
        envelopeStatus: res.envelopeStatus,
        sentDateTime: res.sentDateTime,
        senderName: res.senderName,
        senderEmail: res.senderEmail,
        senderUserId: res.senderUserId,
        senderCopyRequested: res.senderCopyRequested,
        recipientStatuses: res.recipients.map(r => ({ recipientId: r.recipientId, status: r.status })),
      });
      applyWorkingState(saved);
      setEditingIndex(null);
      updateResponseSummary({ contractSignature: saved });
    } catch (err) {
      setError(toErrorPanelData(err, "Could not send this document for signature"));
    } finally {
      setSending(false);
    }
  }

  /**
   * "Send Signing Email" — a separate delivery option, alongside (not
   * instead of) Send for Signature above. Phase 1 of 2: creates its OWN new
   * DocuSign envelope with a single captive recipient against the SAME
   * selected document (see sendEmbeddedSigningTestEnvelope — it downloads
   * the identical contentVersionId, never a regenerated document), and gets
   * back this app's own stable /sign/[token] link. Deliberately does NOT
   * call signatureStore.recordSent — this envelope is invisible to the
   * normal Draft/Ready to Send/Sent lock on this document, so it can never
   * block or collide with a real Send for Signature on the same document.
   * Stops here and shows a From/To/Document/Contract confirmation panel —
   * the actual mailto: compose window only opens on the sender's explicit
   * next click (handleOpenEmailDraft below).
   */
  async function handleCreateSigningEmail() {
    const recipient = recipients[0];
    if (!recipient?.name.trim() || !recipient?.email.trim() || !selectedDocId) return;
    setSendingTestLink(true);
    setError(null);
    setTestLinkResult(null);
    setEmailDraftOpened(false);
    try {
      const res = await quoteApiPost<{
        envelopeId: string; signingLink: string; senderName: string | null; senderEmail: string | null;
        recipientName: string; recipientEmail: string; documentName: string; isLocalhostSigningLink: boolean;
      }>(
        "Create signing email", `/api/contracts/${contractId}/signature/send-test-link`,
        {
          contentVersionId: selectedDocId,
          contractNumber: contractLabel,
          recipientName: recipient.name,
          recipientEmail: recipient.email,
        },
      );
      setTestLinkResult({
        envelopeId: res.envelopeId, signingLink: res.signingLink, isLocalhost: res.isLocalhostSigningLink,
        senderName: res.senderName, senderEmail: res.senderEmail,
        recipientName: res.recipientName, recipientEmail: res.recipientEmail, documentName: res.documentName,
      });
    } catch (err) {
      setError(toErrorPanelData(err, "Could not create a signing email"));
    } finally {
      setSendingTestLink(false);
    }
  }

  /**
   * Phase 2 of 2 — the sender's explicit click, after reviewing the From/To/
   * Document/Contract confirmation panel, to actually open their default
   * mail client's compose window. `mailto:` can only ever open a draft — it
   * has no mechanism to send automatically, attach the Contract PDF (RFC
   * 6068 defines no attachment mechanism at all), or render a real HTML
   * button (the body is plain text; any HTML would show as literal tags).
   * The "REVIEW & SIGN DOCUMENT" line is plain-text emphasis immediately
   * above the link, the closest a mailto: body can get to a button.
   */
  function handleOpenEmailDraft() {
    if (!testLinkResult) return;
    const subject = `Review and Sign Contract ${contractLabel}`;
    const body =
      `${testLinkResult.senderName ?? "The sender"} has sent you a document to review and sign.\n\n` +
      `Contract: ${contractLabel}\n` +
      `Document: ${testLinkResult.documentName}\n\n` +
      `REVIEW & SIGN DOCUMENT:\n` +
      `${testLinkResult.signingLink}`;
    const mailto = `mailto:${encodeURIComponent(testLinkResult.recipientEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
    setEmailDraftOpened(true);
  }

  function handleCancel() {
    if (request) applyWorkingState(request);
    setEditingIndex(null);
    setError(null);
  }

  /**
   * Manual "Refresh DocuSign Status" fallback (§Phase 8) — needed whenever a
   * DocuSign Connect webhook can't reach this server (e.g. localhost with no
   * public HTTPS tunnel). Queries the real envelope from DocuSign, then
   * persists the result (forward-only, deduplicated — same shared mapping
   * logic the webhook itself uses) into both the server-side tracking store
   * and this browser's localSignatureStore, so `request.status` can finally
   * advance past "Sent" once DocuSign actually reports Viewed/Signed/Completed.
   */
  async function handleCheckStatus() {
    if (!request?.envelopeId) return;
    setCheckingStatus(true);
    setError(null);
    try {
      const res = await quoteApiPost<EnvelopeStatusCheck>("Refresh DocuSign status", `/api/contracts/docusign/envelopes/${request.envelopeId}/refresh`, {});
      setDocuSignStatus(res);
      const saved = await signatureStore.applyServerSync(contractId, selectedDocId, {
        stage: res.stage, envelopeStatus: res.envelopeStatus, timeline: res.timeline, signedContentVersionId: res.signedContentVersionId,
      });
      applyWorkingState(saved);
    } catch (err) {
      setError(toErrorPanelData(err, "Could not refresh DocuSign status"));
    } finally {
      setCheckingStatus(false);
    }
  }

  /** Wires envelope.ts's retrieveSignedDocument() (§Phase 9) to the UI — only enabled once the stage has reached "Completed". Idempotent both client- and server-side: once signedContentVersionId is set, this becomes a no-op re-fetch of the same Id rather than a new upload. */
  async function handleRetrieveSignedDocument() {
    if (!request?.envelopeId) return;
    setRetrievingDocument(true);
    setError(null);
    try {
      const res = await quoteApiPost<{ success: boolean; contentVersionId: string; alreadyRetrieved: boolean }>(
        "Retrieve signed document", `/api/contracts/docusign/envelopes/${request.envelopeId}/retrieve-signed-document`, {},
      );
      const saved = await signatureStore.applyServerSync(contractId, selectedDocId, {
        stage: request.status, envelopeStatus: request.envelopeStatus, timeline: request.timeline, signedContentVersionId: res.contentVersionId,
      });
      applyWorkingState(saved);
      // The signed PDF is a brand-new, separate ContentDocument on this Contract — refresh the Generated Documents list so it shows up immediately.
      const docsRes = await quoteApiGet<{ documents: GeneratedDocument[] }>("List contract documents", `/api/contracts/${contractId}/documents`);
      setDocuments(docsRes.documents);
    } catch (err) {
      setError(toErrorPanelData(err, "Could not retrieve the signed document"));
    } finally {
      setRetrievingDocument(false);
    }
  }

  /**
   * "Correct & Resend" (§Phase 6) — recovers a recipient DocuSign reported as
   * undeliverable by updating their email on the SAME envelope and forcing a
   * fresh invitation (see envelope.ts's correctAndResendEnvelopeRecipient).
   * Never creates a new envelope/duplicate send. One explicit click = one
   * correction attempt — no retry loop, no auto-resend.
   */
  async function handleCorrectAndResend(recipientId: string) {
    if (!request?.envelopeId || !correctedEmailInput.trim()) return;
    const recipient = docuSignStatus?.recipients.find(r => r.recipientId === recipientId);
    if (!recipient) return;
    setCorrecting(true);
    setError(null);
    try {
      const res = await quoteApiPost<EnvelopeStatusCheck>(
        "Correct and resend recipient",
        `/api/contracts/docusign/envelopes/${request.envelopeId}/correct-recipient`,
        { recipientId, name: recipient.name, email: correctedEmailInput.trim() },
      );
      setDocuSignStatus(res);
      // recipientId is assigned 1-based in send order (buildEnvelopeSigners) —
      // matches this document's local recipient `order` directly.
      const savedRecipients = await signatureStore.correctRecipientEmail(contractId, selectedDocId, Number(recipientId), correctedEmailInput.trim());
      applyWorkingState(savedRecipients);
      setCorrectingRecipientId(null);
      setCorrectedEmailInput("");
    } catch (err) {
      setError(toErrorPanelData(err, "Could not correct and resend to this recipient"));
    } finally {
      setCorrecting(false);
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
  /** "Send Signing Email" only needs a document + a first recipient — independent of `locked`, since it's a separate test flow from Send for Signature. */
  const canSendTestLink = !!selectedDocId && !!recipients[0]?.name.trim() && !!recipients[0]?.email.trim();

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
              <GhostButton label={checkingStatus ? "Refreshing…" : "Refresh DocuSign Status"} icon="refresh" isDark={isDark} disabled={checkingStatus} onClick={handleCheckStatus} />
            </div>

            {request && (
              <div style={{ padding: 10, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 11.5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: t.heading, marginBottom: 8 }}>
                  <Ic n="user" s={12} /> Sent by / Sent to
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, color: t.body }}>
                  <div><span style={{ color: t.dim }}>Contract Number:</span> {contractLabel}</div>
                  <div><span style={{ color: t.dim }}>Envelope ID:</span> {request.envelopeId}</div>
                  <div><span style={{ color: t.dim }}>Sender Name:</span> {request.senderName ?? "—"}</div>
                  <div><span style={{ color: t.dim }}>Sender Email:</span> {request.senderEmail ?? "—"}</div>
                  <div><span style={{ color: t.dim }}>Sender User ID:</span> {request.senderUserId ?? "—"}</div>
                  <div><span style={{ color: t.dim }}>Sent Date/Time:</span> {request.sentDateTime ? new Date(request.sentDateTime).toLocaleString() : "—"}</div>
                  <div><span style={{ color: t.dim }}>Envelope Status:</span> {request.envelopeStatus ?? "—"}</div>
                </div>
                {request.senderCopyRequested != null && (
                  <div style={{ marginTop: 8, fontSize: 10.5, color: t.dim, display: "flex", alignItems: "flex-start", gap: 6 }}>
                    <Ic n="info" s={11} />
                    <span>
                      {request.senderCopyRequested
                        ? `A copy/notification of this envelope was also sent to the sender's own DocuSign-registered inbox (${request.senderEmail}) as a non-signing "receives a copy" recipient — DocuSign cannot place this in the sender's Sent Items, only deliver it as a new message to their Inbox.`
                        : "No sender copy was added to this envelope — either the connected sender has no known DocuSign email on file, or it matched a recipient's email already on this envelope."}
                    </span>
                  </div>
                )}
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${t.border}` }}>
                  <div style={{ fontWeight: 700, color: t.heading, marginBottom: 6 }}>Recipients</div>
                  {request.recipients.map((r, i) => (
                    <div key={i} style={{ paddingTop: i > 0 ? 6 : 0, marginTop: i > 0 ? 6 : 0, borderTop: i > 0 ? `1px solid ${t.border}` : "none", color: t.body }}>
                      <strong>{r.name}</strong> ({r.email}) <span style={{ color: t.dim }}>— {r.role}</span>
                      <div style={{ color: t.dim, fontSize: 10.5, marginTop: 2 }}>Recipient Status: {r.status ?? "—"}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {docuSignStatus && (
              <div style={{ padding: 10, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 11.5 }}>
                <div style={{ fontWeight: 700, color: t.heading, marginBottom: 6 }}>
                  Envelope: {docuSignStatus.envelopeStatus}
                  {docuSignStatus.sentDateTime && <span style={{ color: t.dim, fontWeight: 400 }}> · sent {new Date(docuSignStatus.sentDateTime).toLocaleString()}</span>}
                </div>
                {docuSignStatus.recipients.map((r, i) => {
                  const state = recipientDeliveryState(r);
                  const undeliverable = isUndeliverable(r);
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
                    {undeliverable && (
                      <div style={{ marginTop: 6, padding: 8, borderRadius: 8, border: `1px solid #FF406660`, background: "#FF406614" }}>
                        <div style={{ color: "#FF4066", fontWeight: 700, fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
                          <Ic n="alert" s={12} /> DocuSign could not deliver the signing invitation to this recipient.
                        </div>
                        <div style={{ color: t.dim, fontSize: 10.5, marginTop: 3 }}>
                          {r.autoRespondedReason ? `Reason reported by DocuSign: ${r.autoRespondedReason}` : "DocuSign did not report a further reason for this account/plan."}
                        </div>
                        {correctingRecipientId === r.recipientId ? (
                          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                            <input
                              placeholder="Corrected email address"
                              type="email"
                              value={correctedEmailInput}
                              onChange={e => setCorrectedEmailInput(e.target.value)}
                              style={{ ...inputStyle(t), flex: 1, minWidth: 180 }}
                            />
                            <PrimaryButton label={correcting ? "Sending…" : "Resend"} icon="send" isDark={isDark} disabled={correcting || !correctedEmailInput.trim()} onClick={() => handleCorrectAndResend(r.recipientId)} />
                            <GhostButton label="Cancel" isDark={isDark} disabled={correcting} onClick={() => { setCorrectingRecipientId(null); setCorrectedEmailInput(""); }} />
                          </div>
                        ) : (
                          <div style={{ marginTop: 6 }}>
                            <GhostButton label="Correct Email & Resend" icon="edit" isDark={isDark} onClick={() => { setCorrectingRecipientId(r.recipientId); setCorrectedEmailInput(""); }} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })}
                {docuSignStatus.salesforceWriteback?.notes.map((note, i) => (
                  <div key={i} style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${t.border}`, color: t.dim, fontSize: 10.5, display: "flex", gap: 6 }}>
                    <Ic n="info" s={11} /> {note}
                  </div>
                ))}
              </div>
            )}

            {request?.status === "Completed" && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, paddingTop: 8, borderTop: `1px solid ${t.border}` }}>
                <div style={{ fontSize: 11, color: t.dim, display: "flex", alignItems: "center", gap: 6 }}>
                  <Ic n="check-circle" s={12} /> Envelope Completed.
                  {request.signedContentVersionId
                    ? " The signed document has been stored in Salesforce as a new document (original unsigned document is unchanged)."
                    : " Retrieve the signed PDF and store it in Salesforce as a new document."}
                </div>
                {request.signedContentVersionId ? (
                  <button
                    onClick={() => window.open(`/api/contracts/${contractId}/documents/${request.signedContentVersionId}/download?disposition=inline`, "_blank")}
                    style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 6, border: `1px solid ${t.accent}60`, background: `${t.accent}14`, color: t.accent, cursor: "pointer", fontSize: 10.5, fontWeight: 700 }}
                  >
                    <Ic n="eye" s={11} /> View Signed Document
                  </button>
                ) : (
                  <GhostButton label={retrievingDocument ? "Retrieving…" : "Retrieve Signed Document"} icon="download" isDark={isDark} disabled={retrievingDocument} onClick={handleRetrieveSignedDocument} />
                )}
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
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4, flexWrap: "wrap" }}>
        <GhostButton label="Cancel" icon="x" isDark={isDark} onClick={handleCancel} />
        <GhostButton label={savingDraft ? "Saving…" : "Save Draft"} icon="save" isDark={isDark} disabled={locked || savingDraft} onClick={handleSaveDraft} />
        <GhostButton
          label={sendingTestLink ? "Preparing…" : "Send Signing Email"}
          icon="external-link"
          isDark={isDark}
          disabled={!canSendTestLink || sendingTestLink}
          onClick={handleCreateSigningEmail}
        />
        <PrimaryButton label={sending ? "Sending…" : "Send for Signature"} icon="send" isDark={isDark} disabled={!canSend || sending} onClick={handleSend} />
      </div>
      {!canSend && !locked && (
        <div style={{ fontSize: 11, color: t.dim, textAlign: "right", marginTop: -10 }}>
          {recipients.length === 0 ? "Add at least one recipient. " : recipients.some(r => !r.name.trim() || !r.email.trim()) ? "Every recipient needs a name and email. " : ""}{!selectedDocId ? "Select a document to send." : ""}
        </div>
      )}
      {testLinkResult && (
        <div style={{ padding: 12, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 11.5 }}>
          <div style={{ fontWeight: 700, color: t.heading, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <Ic n="send" s={12} /> Signing email ready — envelope {testLinkResult.envelopeId}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, color: t.body, marginBottom: 8 }}>
            <div><span style={{ color: t.dim }}>From:</span> {testLinkResult.senderName ?? "—"} {testLinkResult.senderEmail ? `(${testLinkResult.senderEmail})` : ""}</div>
            <div><span style={{ color: t.dim }}>To:</span> {testLinkResult.recipientName} ({testLinkResult.recipientEmail})</div>
            <div><span style={{ color: t.dim }}>Contract:</span> {contractLabel}</div>
            <div><span style={{ color: t.dim }}>Document:</span> {testLinkResult.documentName}</div>
          </div>

          {testLinkResult.isLocalhost && (
            <div style={{ marginBottom: 8, padding: 8, borderRadius: 8, border: `1px solid ${t.warn}60`, background: `${t.warn}14`, color: t.warn, fontSize: 10.5, display: "flex", alignItems: "flex-start", gap: 6 }}>
              <Ic n="alert" s={12} />
              <span>
                This signing link points at <strong>localhost</strong> — it will only open for someone on THIS computer. It will not work for a real external recipient.
                Set <code>NEXT_PUBLIC_APP_URL</code> to a publicly reachable URL (a deployed domain, or a tunnel for local testing) before sending this for real.
              </span>
            </div>
          )}

          {!emailDraftOpened ? (
            <PrimaryButton label="Open Email Draft" icon="external-link" isDark={isDark} onClick={handleOpenEmailDraft} />
          ) : (
            <div style={{ color: t.dim }}>
              An email compose window should have opened, addressed to {testLinkResult.recipientEmail} — nothing has been sent yet; review it and click Send yourself.
              If no compose window opened (no default mail app configured), copy this signing link manually:
              <div style={{ marginTop: 6, padding: 8, borderRadius: 6, background: t.surface, border: `1px solid ${t.border}`, wordBreak: "break-all", color: t.body, fontFamily: "monospace", fontSize: 10.5 }}>
                {testLinkResult.signingLink}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
