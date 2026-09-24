import type { SignatureStage, SignatureTimelineEntry } from "@/lib/contracts/types";
import { getEnvelopeDiagnostics, type EnvelopeDiagnostics } from "@/lib/contracts/docusign/envelope";
import {
  getTrackedEnvelope,
  updateTrackedEnvelope,
  type TrackedSignatureEnvelope,
} from "@/lib/contracts/docusign/signatureStatusStore";

export class SignatureTrackingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SignatureTrackingError";
    this.code = code;
  }
}

/**
 * The full stage ladder, in the order lib/contracts/types.ts declares
 * SignatureStage — "forward only" (§5.4/§7/§Phase 6.6) means a stage's own
 * index here, never regressing once reached. Customer Signed/Company Signed
 * are peers in reality (whichever recipient role signs first), not a real
 * sub-order — this app models them as one linear ladder anyway (simplest
 * correct model for a single shared "current stage" field) rather than
 * tracking two independent per-role ladders; moving between them at the same
 * or higher index is allowed (a same-or-forward move), moving to a LOWER
 * index never is.
 */
const STAGE_ORDER: SignatureStage[] = ["Draft", "Ready to Send", "Sent", "Viewed", "Customer Signed", "Company Signed", "Completed"];

export function stageRank(stage: SignatureStage): number {
  return STAGE_ORDER.indexOf(stage);
}

function isCustomerRole(role: string): boolean {
  return role.trim().toLowerCase() === "customer";
}

/** Mirrors components/data/contracts/SignaturePanel.tsx's recipientDeliveryState() vocabulary for delivery-problem detection, kept in sync deliberately since both read the same DocuSign recipient `status` values. */
function isDeliveryProblemStatus(status: string | null): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "autoresponded" || s === "delivery_failure" || s === "delivered_failed";
}

export interface StageComputation {
  stage: SignatureStage;
  newEntries: SignatureTimelineEntry[];
}

/**
 * Pure function — no I/O. Given the envelope's currently tracked stage/
 * timeline/recipients and a FRESH pull of DocuSign's own diagnostics, computes
 * the next stage (never regressing — §6.6) and any NEW timeline entries not
 * already present (deduplicated by `dedupeKey` — §6.7/§7). This is the ONE
 * shared mapping function the webhook receiver and the manual "Refresh
 * DocuSign Status" fallback both call (via syncEnvelopeStatus below) so they
 * can never diverge (§8).
 *
 * Recipients are matched by DocuSign's `recipientId`, not email — DocuSign
 * diagnostics only ever expose a MASKED email (see getEnvelopeDiagnostics),
 * and recipientId is exactly what this app assigned at send time.
 */
export function computeStageProgress(
  tracked: Pick<TrackedSignatureEnvelope, "stage" | "timeline" | "recipients">,
  diagnostics: EnvelopeDiagnostics,
  source: "docusign-webhook" | "system",
): StageComputation {
  const seenKeys = new Set(tracked.timeline.map(e => e.dedupeKey));
  const entries: SignatureTimelineEntry[] = [];
  const roleByRecipientId = new Map(tracked.recipients.map(r => [r.recipientId, r.role]));
  const nameByRecipientId = new Map(tracked.recipients.map(r => [r.recipientId, r.name]));

  const envStatus = (diagnostics.envelopeStatus ?? "").toLowerCase();
  let anySignedCompany = false;
  let anySignedCustomer = false;
  let anyDelivered = false;

  for (const r of diagnostics.recipients) {
    const role = roleByRecipientId.get(r.recipientId);
    const displayName = nameByRecipientId.get(r.recipientId) ?? (r.name || r.maskedEmail);

    if (r.signedDateTime) {
      const key = `signed:${diagnostics.envelopeId}:${r.recipientId}`;
      const stageForThisSigner: SignatureStage = role && isCustomerRole(role) ? "Customer Signed" : "Company Signed";
      if (!seenKeys.has(key)) {
        entries.push({ stage: stageForThisSigner, at: r.signedDateTime, detail: `${displayName} signed.`, source, dedupeKey: key });
        seenKeys.add(key);
      }
      if (role && isCustomerRole(role)) anySignedCustomer = true;
      else anySignedCompany = true;
    }

    if (r.declinedDateTime) {
      const key = `declined:${diagnostics.envelopeId}:${r.recipientId}`;
      if (!seenKeys.has(key)) {
        // Informational only — DocuSign has no SignatureStage value for "declined"; the ladder does not move backward or sideways for this.
        entries.push({ stage: tracked.stage, at: r.declinedDateTime, detail: `${displayName} declined to sign.`, source, dedupeKey: key });
        seenKeys.add(key);
      }
    }

    if (isDeliveryProblemStatus(r.status)) {
      const key = `delivery-problem:${diagnostics.envelopeId}:${r.recipientId}`;
      if (!seenKeys.has(key)) {
        entries.push({ stage: tracked.stage, at: r.sentDateTime ?? new Date(0).toISOString(), detail: `Delivery problem reported for ${displayName} (DocuSign status: ${r.status}).`, source, dedupeKey: key });
        seenKeys.add(key);
      }
    }

    if (r.deliveredDateTime && !r.signedDateTime) anyDelivered = true;
  }

  if (envStatus === "voided") {
    const key = `voided:${diagnostics.envelopeId}`;
    if (!seenKeys.has(key)) {
      entries.push({ stage: tracked.stage, at: diagnostics.statusChangedDateTime ?? new Date().toISOString(), detail: "Envelope was voided in DocuSign.", source, dedupeKey: key });
      seenKeys.add(key);
    }
  }

  let candidate: SignatureStage = tracked.stage;
  if (envStatus === "completed") candidate = "Completed";
  else if (anySignedCompany) candidate = "Company Signed";
  else if (anySignedCustomer) candidate = "Customer Signed";
  else if (anyDelivered) candidate = "Viewed";

  if (stageRank(candidate) > stageRank(tracked.stage)) {
    const key = `stage:${candidate}:${diagnostics.envelopeId}`;
    if (!seenKeys.has(key)) {
      entries.push({ stage: candidate, at: diagnostics.statusChangedDateTime ?? new Date().toISOString(), detail: `Envelope reached ${candidate}.`, source, dedupeKey: key });
      seenKeys.add(key);
    }
  } else {
    candidate = tracked.stage; // Forward-only — never regress (e.g. a stale "sent" retry arriving after "Completed" was already recorded).
  }

  return { stage: candidate, newEntries: entries };
}

/**
 * I/O wrapper shared by BOTH the webhook receiver and the manual "Refresh
 * DocuSign Status" route — pulls DocuSign's own canonical state
 * (getEnvelopeDiagnostics, already used by "Check DocuSign Status") and
 * applies computeStageProgress's forward-only, deduplicated update to the
 * server-side tracking record.
 *
 * Deliberately does NOT touch Salesforce — this function has no
 * SalesforceClient and is called from the webhook route, which has no
 * Salesforce session (DocuSign calls it directly; there is no browser
 * cookie). Salesforce Contract field writeback only happens from the manual
 * refresh route, which DOES have an authenticated SalesforceClient — see
 * that route for why this split is a deliberate, disclosed limitation, not
 * an oversight.
 */
export async function syncEnvelopeStatus(
  orgId: string,
  envelopeId: string,
  source: "docusign-webhook" | "system",
): Promise<{ tracked: TrackedSignatureEnvelope; diagnostics: EnvelopeDiagnostics }> {
  const tracked = await getTrackedEnvelope(envelopeId);
  if (!tracked || tracked.orgId !== orgId) {
    throw new SignatureTrackingError("DOCUSIGN_ENVELOPE_NOT_TRACKED", "This DocuSign envelope is not tracked by this server (it may predate this server process, or belong to a different organization).");
  }

  const diagnostics = await getEnvelopeDiagnostics(orgId, envelopeId);
  const { stage, newEntries } = computeStageProgress(tracked, diagnostics, source);

  if (newEntries.length === 0 && stage === tracked.stage && diagnostics.envelopeStatus === tracked.envelopeStatus) {
    return { tracked, diagnostics };
  }

  const updated = await updateTrackedEnvelope(envelopeId, {
    stage,
    envelopeStatus: diagnostics.envelopeStatus,
    timeline: [...tracked.timeline, ...newEntries],
  });
  return { tracked: updated ?? tracked, diagnostics };
}

/** Latest DocuSign-reported signing timestamp for a given stage in this envelope's tracked timeline — used by the manual refresh route to know WHICH date to write into Salesforce's CompanySignedDate/CustomerSignedDate. */
export function latestTimestampForStage(timeline: SignatureTimelineEntry[], stage: SignatureStage): string | null {
  const matches = timeline.filter(e => e.stage === stage).map(e => e.at).sort();
  return matches.length > 0 ? matches[matches.length - 1] : null;
}
