import type { SalesforceClient } from "@/lib/salesforce/client";
import { downloadContentVersion } from "@/lib/contracts/documents/contentVersion";
import { createAndSendEnvelope, fetchCombinedDocument, getEnvelope, getEnvelopeRecipients, getEnvelopeAuditEvents, getEnvelopeRawDump } from "@/lib/contracts/docusign/client";
import { getActiveDocuSignSession } from "@/lib/contracts/docusign/oauth";
import { buildEnvelopeEmail } from "@/lib/contracts/docusign/emailPreview";
import { renderControlTestDocument } from "@/lib/contracts/docusign/controlTestDocument";
import { diffEnvelopeJson, sortDiffs, type EnvelopeDiffEntry } from "@/lib/contracts/docusign/envelopeDiff";
import type { SignatureRecipient } from "@/lib/contracts/types";

export interface SendEnvelopeResult {
  envelopeId: string;
  envelopeStatus: string;
  /** DocuSign's own "sent at" timestamp from the create-and-send response — null if DocuSign didn't return one. */
  sentDateTime: string | null;
}

/**
 * Send-for-signature (§5.2). Preconditions (recipients configured, a
 * selected source document, no envelopeId already recorded) are enforced by
 * the caller (the API route) against the signature-store state before this
 * is invoked — this function itself performs steps 2-5: download the PDF,
 * build one Signer per recipient with the app's own `order` as DocuSign's
 * `routingOrder`, and create-and-send in one call.
 */
export async function sendContractForSignature(
  client: SalesforceClient,
  orgId: string,
  opts: {
    contentVersionId: string; recipients: SignatureRecipient[]; contractLabel: string;
    /** The Signatures panel's user-editable email template, already token-substituted — falls back to the fixed buildEnvelopeEmail() text if omitted. */
    emailSubject?: string; emailBody?: string;
  },
): Promise<SendEnvelopeResult> {
  if (opts.recipients.length === 0) throw new Error("At least one recipient is required before sending.");

  const session = await getActiveDocuSignSession(orgId);
  if (!session) throw new Error("DocuSign is not connected for this organization — connect it in DocuSign Settings first.");

  const { buffer } = await downloadContentVersion(client, opts.contentVersionId);
  const documentBase64 = buffer.toString("base64");
  // `order` is the recipient list's incidental array position (from the
  // Signatures UI's Add/Delete), NOT a deliberate "sign in this order"
  // choice — there's no UI yet to opt into sequential routing, so this app
  // defaults every signer to routingOrder 1 (parallel: DocuSign notifies
  // everyone immediately). Sorting by `order` here only keeps recipientId
  // assignment stable/predictable, it no longer affects delivery timing.
  const sorted = [...opts.recipients].sort((a, b) => a.order - b.order);
  const fallback = buildEnvelopeEmail(opts.contractLabel);
  const emailSubject = opts.emailSubject ?? fallback.subject;
  const emailBody = opts.emailBody ?? fallback.body;

  const result = await createAndSendEnvelope({
    baseUri: session.baseUri,
    accountId: session.accountId,
    accessToken: session.accessToken,
    emailSubject,
    emailBody,
    documentBase64,
    documentName: opts.contractLabel,
    signers: sorted.map((r, i) => ({ name: r.name, email: r.email, recipientId: String(i + 1), routingOrder: 1, tabStackIndex: i })),
  });

  return { envelopeId: result.envelopeId, envelopeStatus: result.status, sentDateTime: result.statusDateTime };
}

export interface EnvelopeDiagnostics {
  envelopeId: string;
  envelopeStatus: string;
  emailSubject: string | null;
  sentDateTime: string | null;
  createdDateTime: string | null;
  statusChangedDateTime: string | null;
  recipients: {
    name: string;
    maskedEmail: string;
    recipientId: string;
    routingOrder: string | null;
    status: string | null;
    deliveryMethod: string | null;
    clientUserIdPresent: boolean;
    sentDateTime: string | null;
    deliveredDateTime: string | null;
    signedDateTime: string | null;
    declinedDateTime: string | null;
    recipientSuppliesTabs: string | null;
    totalTabCount: number | null;
  }[];
  /** Null when this DocuSign account/plan doesn't expose audit events (not itself evidence of a problem) rather than an empty array meaning "nothing happened." */
  auditEvents: { eventName: string | null; eventDateTime: string | null }[] | null;
}

function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  const visible = user.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(user.length - 1, 3))}@${domain}`;
}

/**
 * Read-only diagnostics for an EXISTING envelope — never creates or
 * modifies anything. Used to answer "did DocuSign actually record sending
 * this?" directly from DocuSign, instead of trusting our own create-call
 * response as the last word.
 */
export async function getEnvelopeDiagnostics(orgId: string, envelopeId: string): Promise<EnvelopeDiagnostics> {
  const session = await getActiveDocuSignSession(orgId);
  if (!session) throw new Error("DocuSign is not connected for this organization.");

  const [envelope, recipients, auditEvents] = await Promise.all([
    getEnvelope({ baseUri: session.baseUri, accountId: session.accountId, accessToken: session.accessToken, envelopeId }),
    getEnvelopeRecipients({ baseUri: session.baseUri, accountId: session.accountId, accessToken: session.accessToken, envelopeId }),
    getEnvelopeAuditEvents({ baseUri: session.baseUri, accountId: session.accountId, accessToken: session.accessToken, envelopeId }).catch(() => null),
  ]);

  return {
    envelopeId: envelope.envelopeId,
    envelopeStatus: envelope.status,
    emailSubject: envelope.emailSubject,
    sentDateTime: envelope.sentDateTime,
    createdDateTime: envelope.createdDateTime,
    statusChangedDateTime: envelope.statusChangedDateTime,
    recipients: recipients.map(r => ({
      name: r.name,
      maskedEmail: maskEmail(r.email),
      recipientId: r.recipientId,
      routingOrder: r.routingOrder,
      status: r.status,
      deliveryMethod: r.deliveryMethod,
      clientUserIdPresent: r.clientUserIdPresent,
      sentDateTime: r.sentDateTime,
      deliveredDateTime: r.deliveredDateTime,
      signedDateTime: r.signedDateTime,
      declinedDateTime: r.declinedDateTime,
      recipientSuppliesTabs: r.recipientSuppliesTabs,
      totalTabCount: r.totalTabCount,
    })),
    auditEvents: auditEvents ? auditEvents.map(e => ({ eventName: e.eventName, eventDateTime: e.eventDateTime })) : null,
  };
}

/**
 * Full-fidelity raw dump for manually comparing two envelopes field-by-field
 * (e.g. an API-created envelope against one created via the DocuSign web UI)
 * when the curated EnvelopeDiagnostics fields above aren't enough to explain
 * a behavioral difference — e.g. notification/branding/reminder/expiration
 * settings, or extended recipient fields neither getEnvelope() nor
 * getEnvelopeRecipients() capture. Read-only; not used by any production
 * sending or status-check path.
 */
export async function getEnvelopeRawDiagnostics(orgId: string, envelopeId: string) {
  const session = await getActiveDocuSignSession(orgId);
  if (!session) throw new Error("DocuSign is not connected for this organization.");
  return getEnvelopeRawDump({ baseUri: session.baseUri, accountId: session.accountId, accessToken: session.accessToken, envelopeId });
}

/** §5.5: manual, user-triggered retrieval of the combined signed PDF + Certificate of Completion. */
export async function retrieveSignedDocument(orgId: string, envelopeId: string): Promise<Buffer> {
  const session = await getActiveDocuSignSession(orgId);
  if (!session) throw new Error("DocuSign is not connected for this organization.");
  return fetchCombinedDocument({ baseUri: session.baseUri, accountId: session.accountId, accessToken: session.accessToken, envelopeId });
}

/**
 * Email-delivery control test (DocuSign Settings' "Send Test Envelope"):
 * sends ONE new envelope — one PDF, one signer, routingOrder 1, no
 * clientUserId, status "sent" — through the EXACT SAME createAndSendEnvelope()
 * the real Send-for-Signature flow above uses (no parallel/duplicate
 * implementation), then immediately re-queries it via the same
 * getEnvelopeDiagnostics() used by "Check DocuSign Status." Not tied to any
 * Contract — the document is a trivial placeholder (controlTestDocument.ts).
 * Callers (the API route) are responsible for making this a single explicit
 * user action, not something invoked automatically or in a loop.
 */
export async function sendDocuSignControlTestEnvelope(
  orgId: string,
  opts: { recipientName: string; recipientEmail: string; explicitDeliveryMethod?: boolean; omitTabs?: boolean },
): Promise<EnvelopeDiagnostics> {
  const session = await getActiveDocuSignSession(orgId);
  if (!session) throw new Error("DocuSign is not connected for this organization — connect it in DocuSign Settings first.");

  const documentBase64 = (await renderControlTestDocument()).toString("base64");

  const result = await createAndSendEnvelope({
    baseUri: session.baseUri,
    accountId: session.accountId,
    accessToken: session.accessToken,
    emailSubject: "DocuSign Connectivity Test",
    emailBody: "This is a one-off connectivity test sent from DocuSign Settings — safe to ignore or decline. It is not tied to any Contract.",
    documentBase64,
    documentName: opts.omitTabs ? "DocuSign Connectivity Test (Freeform — no tabs)" : "DocuSign Connectivity Test",
    signers: [{
      name: opts.recipientName, email: opts.recipientEmail, recipientId: "1", routingOrder: 1, tabStackIndex: 0,
      // Only set when the caller explicitly opts into a control experiment —
      // production Send-for-Signature never passes either of these.
      ...(opts.explicitDeliveryMethod ? { deliveryMethodOverride: "email" as const } : {}),
      ...(opts.omitTabs ? { omitTabs: true } : {}),
    }],
  });

  return getEnvelopeDiagnostics(orgId, result.envelopeId);
}

export interface EnvelopeComparisonResult {
  apiEnvelopeId: string;
  manualEnvelopeId: string;
  envelopeDiffs: EnvelopeDiffEntry[];
  recipientDiffs: EnvelopeDiffEntry[];
  notificationDiffs: EnvelopeDiffEntry[];
  auditDiffs: EnvelopeDiffEntry[];
  strongestCandidate: EnvelopeDiffEntry | null;
}

/**
 * "Compare Envelopes" (DocuSign Settings): fetches BOTH envelopes' raw
 * DocuSign responses server-side and returns a structured diff — no manual
 * JSON copy/paste required. Read-only; never creates or modifies anything.
 */
export async function compareDocuSignEnvelopes(orgId: string, apiEnvelopeId: string, manualEnvelopeId: string): Promise<EnvelopeComparisonResult> {
  const [apiRaw, manualRaw] = await Promise.all([
    getEnvelopeRawDiagnostics(orgId, apiEnvelopeId),
    getEnvelopeRawDiagnostics(orgId, manualEnvelopeId),
  ]);

  const envelopeDiffs = sortDiffs(diffEnvelopeJson(apiRaw.envelope, manualRaw.envelope));
  const recipientDiffs = sortDiffs(diffEnvelopeJson(apiRaw.recipients, manualRaw.recipients));
  const notificationDiffs = sortDiffs(diffEnvelopeJson(apiRaw.notification, manualRaw.notification));
  const auditDiffs = sortDiffs(diffEnvelopeJson(apiRaw.auditEvents, manualRaw.auditEvents));

  const strongestCandidate =
    [...envelopeDiffs, ...recipientDiffs, ...notificationDiffs].find(d => d.classification === "potentially-delivery-relevant") ?? null;

  return { apiEnvelopeId, manualEnvelopeId, envelopeDiffs, recipientDiffs, notificationDiffs, auditDiffs, strongestCandidate };
}
