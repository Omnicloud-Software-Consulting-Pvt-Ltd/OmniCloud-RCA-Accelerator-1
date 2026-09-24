"use client";

import type { SignatureRecipient, SignatureRequest, SignatureStage, SignatureTimelineEntry } from "@/lib/contracts/types";

/**
 * Client-side (browser localStorage) signature-request state — the ENTIRE
 * persistence layer for the Signatures tab. One record per (Contract,
 * generated document) pair, not per Contract — a Contract can have several
 * generated documents, and each must be sendable/trackable independently:
 * sending document A for signature must never lock document B's request on
 * the same Contract. Recipients, the selected document, the editable email
 * template, and status/timeline all live here, keyed by (contractId,
 * sourceContentVersionId), exactly mirroring how
 * lib/contracts/documents/{localTemplateStore,draftDocumentStore}.ts already
 * moved templates/drafts off Postgres.
 *
 * DocuSign connection settings (connectionStore.ts/oauth.ts/DocuSignSettings.tsx)
 * are a separate concern, untouched here. Actually SENDING an envelope needs
 * a real server-side HTTP call to DocuSign (lib/contracts/docusign/envelope.ts,
 * via app/api/contracts/[id]/signature/send/route.ts) — this store never
 * calls DocuSign itself; `recordSent` below just persists whatever result
 * that route returned (a real envelopeId on success).
 *
 * Every export here is `async` even though the work is synchronous — the
 * same forward-compatible seam localTemplateStore.ts uses, so a future real
 * per-org backend can slot in without touching call sites in SignaturePanel.tsx.
 */

const STORAGE_KEY = "omnicloud_contract_signature_state_v1";

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

function readAll(): SignatureRequest[] {
  if (!hasLocalStorage()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // Corrupt/unavailable storage degrades to "no signature request yet", never a thrown error.
  }
}

function writeAll(rows: SignatureRequest[]): void {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Storage full/disabled (private browsing) — the in-memory result of this
    // operation still gets returned to the caller; it just won't survive a reload.
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `sig-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function findRow(rows: SignatureRequest[], contractId: string, contentVersionId: string): SignatureRequest | undefined {
  return rows.find(r => r.contractId === contractId && r.sourceContentVersionId === contentVersionId);
}

function freshState(contractId: string, contentVersionId: string, documentName: string): SignatureRequest {
  const now = new Date().toISOString();
  return {
    id: newId(), contractId, sourceContentVersionId: contentVersionId, sourceDocumentName: documentName,
    status: "Draft", recipients: [], timeline: [], emailSubject: null, emailBody: null,
    envelopeId: null, envelopeStatus: null, sentDateTime: null, signedContentVersionId: null,
    senderName: null, senderEmail: null, senderUserId: null, senderCopyRequested: null,
    createdAt: now, updatedAt: now,
  };
}

/** "Ready to Send" only once recipients are in place — the document is already fixed at row-creation time, so it's no longer a separate precondition. */
function readyStatus(hasRecipients: boolean): SignatureStage {
  return hasRecipients ? "Ready to Send" : "Draft";
}

async function persist(next: SignatureRequest): Promise<SignatureRequest> {
  const rows = readAll();
  const idx = rows.findIndex(r => r.contractId === next.contractId && r.sourceContentVersionId === next.sourceContentVersionId);
  const updated: SignatureRequest = { ...next, updatedAt: new Date().toISOString() };
  if (idx >= 0) rows[idx] = updated;
  else rows.push(updated);
  writeAll(rows);
  return updated;
}

/** One signature request per (Contract, generated document) — get the existing one for this exact document, or create a fresh Draft for it. */
export async function getOrCreateSignatureState(contractId: string, contentVersionId: string, documentName: string): Promise<SignatureRequest> {
  const existing = findRow(readAll(), contractId, contentVersionId);
  if (existing) return existing;
  const fresh = freshState(contractId, contentVersionId, documentName);
  writeAll([...readAll(), fresh]);
  return fresh;
}

/** Every signature request already created for this Contract's documents — lets the document list show each one's own stage without switching to it first. */
export async function listSignatureStatesForContract(contractId: string): Promise<SignatureRequest[]> {
  return readAll().filter(r => r.contractId === contractId);
}

function requireRow(rows: SignatureRequest[], contractId: string, contentVersionId: string): SignatureRequest {
  const row = findRow(rows, contractId, contentVersionId);
  if (!row) throw new Error("No signature request found for this document — select it again.");
  return row;
}

/** Always receives the COMPLETE current recipient list — simplest correct model, no incremental diffing. */
export async function setRecipients(contractId: string, contentVersionId: string, recipients: SignatureRecipient[]): Promise<SignatureRequest> {
  const current = requireRow(readAll(), contractId, contentVersionId);
  if (current.envelopeId) throw new Error("This document has already been sent for signature — recipients can no longer be edited on it.");
  return persist({ ...current, recipients, status: readyStatus(recipients.length > 0) });
}

export async function setEmailContent(contractId: string, contentVersionId: string, emailSubject: string | null, emailBody: string | null): Promise<SignatureRequest> {
  const current = requireRow(readAll(), contractId, contentVersionId);
  if (current.envelopeId) throw new Error("This document has already been sent for signature — email content can no longer be edited on it.");
  return persist({ ...current, emailSubject, emailBody });
}

/** Guards the same preconditions the send route also enforces server-side — defense in depth, not the only check. */
export async function assertReadyToSend(contractId: string, contentVersionId: string): Promise<SignatureRequest> {
  const current = requireRow(readAll(), contractId, contentVersionId);
  if (current.envelopeId) throw new Error("This document has already been sent for signature.");
  if (current.recipients.length === 0) throw new Error("Please add at least one recipient.");
  return current;
}

/**
 * Records a REAL send result from app/api/contracts/[id]/signature/send —
 * this function never talks to DocuSign and never invents an envelope Id,
 * sender identity, or recipient status itself; every field here is exactly
 * what that route returned (which itself only ever surfaces DocuSign's own
 * responses). Called only after that route has actually returned success.
 * Only locks THIS document's row — every other document on the same
 * Contract keeps its own independent Draft/Ready to Send/Sent state.
 *
 * `recipientStatuses` are matched to this document's existing recipients by
 * `recipientId === String(order)` — the SAME correlation
 * correctRecipientEmail() and the "Correct & Resend" UI already rely on,
 * since buildEnvelopeSigners() assigns recipientId as the 1-based sorted
 * position of `order`.
 */
export async function recordSent(
  contractId: string,
  contentVersionId: string,
  input: {
    envelopeId: string;
    envelopeStatus: string;
    sentDateTime: string | null;
    senderName: string | null;
    senderEmail: string | null;
    senderUserId: string | null;
    senderCopyRequested: boolean;
    recipientStatuses: { recipientId: string; status: string | null }[];
  },
): Promise<SignatureRequest> {
  const current = requireRow(readAll(), contractId, contentVersionId);
  if (current.envelopeId) throw new Error("This document has already been sent for signature.");

  const entry: SignatureTimelineEntry = {
    stage: "Sent",
    at: input.sentDateTime ?? new Date().toISOString(),
    detail: `Envelope ${input.envelopeId} sent via DocuSign.`,
    source: "system",
    dedupeKey: `sent:${input.envelopeId}`,
  };
  const statusByRecipientId = new Map(input.recipientStatuses.map(r => [r.recipientId, r.status]));
  const recipients = current.recipients.map(r => {
    const status = statusByRecipientId.get(String(r.order));
    return status !== undefined ? { ...r, status } : r;
  });
  return persist({
    ...current,
    envelopeId: input.envelopeId, envelopeStatus: input.envelopeStatus, sentDateTime: input.sentDateTime, status: "Sent",
    senderName: input.senderName, senderEmail: input.senderEmail, senderUserId: input.senderUserId, senderCopyRequested: input.senderCopyRequested,
    recipients,
    timeline: [...current.timeline, entry],
  });
}

/**
 * Reflects a recipient email correction that already succeeded against
 * DocuSign (POST .../correct-recipient) — this store never calls DocuSign
 * itself, it only records the result so the Signatures tab shows the
 * corrected address on reload instead of the original bounced one. Matched
 * by recipient order/role (the same fields DocuSign's recipientId was
 * derived from at send time), not by the old email, since that's exactly
 * what's being replaced.
 */
export async function correctRecipientEmail(contractId: string, contentVersionId: string, order: number, newEmail: string): Promise<SignatureRequest> {
  const current = requireRow(readAll(), contractId, contentVersionId);
  const recipients = current.recipients.map(r => (r.order === order ? { ...r, email: newEmail } : r));
  return persist({ ...current, recipients });
}

/**
 * Merges server-authoritative status (from POST
 * /api/contracts/docusign/envelopes/[envelopeId]/refresh, which the DocuSign
 * Connect webhook keeps in sync too) into this browser's local record — the
 * only way `status` ever advances past "Sent" here, since this store itself
 * never talks to DocuSign. Timeline entries are deduplicated by
 * `dedupeKey` so re-running Refresh never duplicates a line.
 */
export async function applyServerSync(
  contractId: string,
  contentVersionId: string,
  update: { stage: SignatureStage; envelopeStatus: string | null; timeline: SignatureTimelineEntry[]; signedContentVersionId: string | null },
): Promise<SignatureRequest> {
  const current = requireRow(readAll(), contractId, contentVersionId);
  const existingKeys = new Set(current.timeline.map(e => e.dedupeKey));
  const merged = [...current.timeline, ...update.timeline.filter(e => !existingKeys.has(e.dedupeKey))];
  return persist({
    ...current,
    status: update.stage,
    envelopeStatus: update.envelopeStatus,
    timeline: merged,
    signedContentVersionId: update.signedContentVersionId ?? current.signedContentVersionId,
  });
}
