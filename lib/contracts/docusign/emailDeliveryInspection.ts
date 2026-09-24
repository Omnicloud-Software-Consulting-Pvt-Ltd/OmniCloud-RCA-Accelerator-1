import { getEnvelopeDiagnostics, getEnvelopeRawDiagnostics } from "@/lib/contracts/docusign/envelope";

/**
 * "Inspect Email Delivery" (§Phase 5) — read-only. Answers ONE question: did
 * DocuSign actually attempt to deliver email for a given envelope, and if
 * delivery is unconfirmed, what evidence (if any) DocuSign's own API exposes
 * to explain that — never inventing a field DocuSign doesn't actually
 * return. Built entirely on top of the EXISTING getEnvelopeDiagnostics /
 * getEnvelopeRawDiagnostics (client.ts's getEnvelope/getEnvelopeRecipients/
 * getEnvelopeAuditEvents/getEnvelopeRawDump) — no changes to how envelopes
 * are created, no changes to deliveryMethod/clientUserId/tabs/OAuth/webhook/
 * signed-document-retrieval.
 *
 * IMPORTANT — what "sent" and "Sent Invitations" do NOT prove: DocuSign's
 * create-and-send response and its audit trail both being "sent"/"Sent
 * Invitations" only means DocuSign itself accepted the envelope and
 * generated an outbound message. It is NOT proof the recipient's mail
 * server received it. This module deliberately distinguishes:
 *   - DocuSign accepted the envelope (this app's own create-call response)
 *   - DocuSign generated an invitation (audit trail / recipient sentDateTime)
 *   - DocuSign reports the message was delivered/opened (deliveredDateTime,
 *     signedDateTime, or a later recipient status)
 *   - DocuSign reports a bounce/auto-response-like signal (status
 *     "autoresponded", or an autoRespondedReason/declinedReason field)
 *   - Nothing further is exposed via this API for this account/plan
 * and never collapses these into a single "delivered" claim.
 */

export type EmailDeliveryVerdict =
  | "APP_DID_NOT_REQUEST_EMAIL"
  | "DOCUSIGN_DID_NOT_GENERATE_INVITATION"
  | "DOCUSIGN_GENERATED_INVITATION_BUT_DELIVERY_FAILED"
  | "DOCUSIGN_REPORTS_DELIVERED_CHECK_MAILBOX_FILTERING"
  | "INSUFFICIENT_API_DATA_CHECK_ACCOUNT_LOGS";

export const EMAIL_DELIVERY_VERDICT_LABEL: Record<EmailDeliveryVerdict, string> = {
  APP_DID_NOT_REQUEST_EMAIL: "A — Our app did not request email delivery",
  DOCUSIGN_DID_NOT_GENERATE_INVITATION: "B — DocuSign did not generate an invitation",
  DOCUSIGN_GENERATED_INVITATION_BUT_DELIVERY_FAILED: "C — DocuSign generated the invitation but delivery failed/suppressed",
  DOCUSIGN_REPORTS_DELIVERED_CHECK_MAILBOX_FILTERING: "D — DocuSign reports successful delivery; check downstream mailbox filtering",
  INSUFFICIENT_API_DATA_CHECK_ACCOUNT_LOGS: "E — DocuSign's API does not expose enough information; account/admin logs must be checked",
};

export interface RecipientEmailDeliveryDetail {
  recipientId: string;
  maskedEmail: string;
  name: string;
  status: string | null;
  deliveryMethod: string | null;
  clientUserIdPresent: boolean;
  sentDateTime: string | null;
  deliveredDateTime: string | null;
  signedDateTime: string | null;
  declinedDateTime: string | null;
  /** Only populated if DocuSign's raw recipient response actually included this key for this account/plan — never fabricated. */
  declinedReason: string | null;
  autoRespondedReason: string | null;
  recipientAuthenticationStatus: unknown;
  offlineAttributes: unknown;
}

export interface EmailDeliveryInspection {
  envelopeId: string;
  envelopeStatus: string;
  sentDateTime: string | null;
  statusChangedDateTime: string | null;
  recipients: RecipientEmailDeliveryDetail[];
  auditEvents: { eventName: string | null; eventDateTime: string | null }[] | null;
  /** False when DocuSign's audit_events endpoint returned non-2xx for this account/plan (see getEnvelopeAuditEvents's own doc comment) — distinct from "no events happened." */
  auditEventsAvailable: boolean;
  notification: Record<string, unknown> | null;
  verdict: EmailDeliveryVerdict;
  verdictReason: string;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === "string" && v.length > 0) return v;
  return null;
}

export async function inspectEmailDelivery(orgId: string, envelopeId: string): Promise<EmailDeliveryInspection> {
  const [diagnostics, raw] = await Promise.all([
    getEnvelopeDiagnostics(orgId, envelopeId),
    getEnvelopeRawDiagnostics(orgId, envelopeId),
  ]);

  const rawSigners = (raw.recipients?.signers as Record<string, unknown>[] | undefined) ?? [];
  const rawByRecipientId = new Map(rawSigners.map(s => [String(s.recipientId), s]));

  const recipients: RecipientEmailDeliveryDetail[] = diagnostics.recipients.map(r => {
    const rawSigner = rawByRecipientId.get(r.recipientId) ?? {};
    return {
      recipientId: r.recipientId,
      maskedEmail: r.maskedEmail,
      name: r.name,
      status: r.status,
      deliveryMethod: r.deliveryMethod,
      clientUserIdPresent: r.clientUserIdPresent,
      sentDateTime: r.sentDateTime,
      deliveredDateTime: r.deliveredDateTime,
      signedDateTime: r.signedDateTime,
      declinedDateTime: r.declinedDateTime,
      declinedReason: firstString(rawSigner.declinedReason),
      autoRespondedReason: firstString(rawSigner.autoRespondedReason, rawSigner.autoResponseReason),
      recipientAuthenticationStatus: rawSigner.recipientAuthenticationStatus ?? null,
      offlineAttributes: rawSigner.offlineAttributes ?? null,
    };
  });

  const auditEventsAvailable = diagnostics.auditEvents !== null;

  let verdict: EmailDeliveryVerdict;
  let verdictReason: string;

  if (recipients.length === 0) {
    verdict = "INSUFFICIENT_API_DATA_CHECK_ACCOUNT_LOGS";
    verdictReason = "DocuSign returned no recipient records at all for this envelope.";
  } else if (recipients.some(r => r.deliveryMethod !== "email")) {
    const bad = recipients.find(r => r.deliveryMethod !== "email");
    verdict = "APP_DID_NOT_REQUEST_EMAIL";
    verdictReason = `DocuSign reports recipient ${bad?.maskedEmail}'s deliveryMethod as "${bad?.deliveryMethod}", not "email".`;
  } else if (recipients.every(r => !r.sentDateTime && (r.status ?? "").toLowerCase() !== "sent")) {
    verdict = "DOCUSIGN_DID_NOT_GENERATE_INVITATION";
    verdictReason = "No recipient has a sentDateTime or a 'sent' status — DocuSign has no record of generating an invitation for anyone on this envelope.";
  } else if (recipients.some(r => (r.status ?? "").toLowerCase() === "autoresponded" || !!r.autoRespondedReason)) {
    const failed = recipients.find(r => (r.status ?? "").toLowerCase() === "autoresponded" || !!r.autoRespondedReason);
    verdict = "DOCUSIGN_GENERATED_INVITATION_BUT_DELIVERY_FAILED";
    verdictReason = `DocuSign reported an auto-response/bounce-like signal for ${failed?.maskedEmail}${failed?.autoRespondedReason ? ` (reason: ${failed.autoRespondedReason})` : " (no further reason returned by DocuSign for this account/plan)."}`;
  } else if (recipients.some(r => !!r.deliveredDateTime || !!r.signedDateTime || ["delivered", "completed"].includes((r.status ?? "").toLowerCase()))) {
    verdict = "DOCUSIGN_REPORTS_DELIVERED_CHECK_MAILBOX_FILTERING";
    verdictReason = "DocuSign reports at least one recipient's message as delivered/opened (deliveredDateTime, signedDateTime, or a delivered/completed status is present). If the recipient still says nothing arrived, the issue is downstream of DocuSign (spam/quarantine/mail-gateway filtering) — this app and DocuSign's send path are not implicated.";
  } else {
    verdict = "INSUFFICIENT_API_DATA_CHECK_ACCOUNT_LOGS";
    verdictReason = "DocuSign confirms the invitation was generated (recipient status 'sent'), but this account/plan's API exposes no further delivery/bounce signal — deliveredDateTime is null and no autoresponded/declined signal is present. This must be checked in DocuSign's own account admin console (Sent Envelope details / email logs) or with DocuSign support, quoting this exact envelopeId.";
  }

  return {
    envelopeId: diagnostics.envelopeId,
    envelopeStatus: diagnostics.envelopeStatus,
    sentDateTime: diagnostics.sentDateTime,
    statusChangedDateTime: diagnostics.statusChangedDateTime,
    recipients,
    auditEvents: diagnostics.auditEvents,
    auditEventsAvailable,
    notification: raw.notification,
    verdict,
    verdictReason,
  };
}
