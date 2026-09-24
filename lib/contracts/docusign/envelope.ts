import { randomBytes } from "node:crypto";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { downloadContentVersion } from "@/lib/contracts/documents/contentVersion";
import { createAndSendEnvelope, fetchCombinedDocument, getEnvelope, getEnvelopeRecipients, getEnvelopeAuditEvents, getEnvelopeRawDump, correctAndResendRecipient, createRecipientView, type EnvelopeSignerInput, type EnvelopeRecipientSummary, type EnvelopeCarbonCopyInput } from "@/lib/contracts/docusign/client";
import { getActiveDocuSignSession } from "@/lib/contracts/docusign/oauth";
import { buildEnvelopeEmail, DEFAULT_EMAIL_SUBJECT, DEFAULT_EMAIL_BODY, substituteEmailTokens } from "@/lib/contracts/docusign/emailPreview";
import { renderControlTestDocument } from "@/lib/contracts/docusign/controlTestDocument";
import { diffEnvelopeJson, sortDiffs, type EnvelopeDiffEntry } from "@/lib/contracts/docusign/envelopeDiff";
import { trackSentEnvelope } from "@/lib/contracts/docusign/signatureStatusStore";
import { createEmbeddedSigningLink, getEmbeddedSigningLink } from "@/lib/contracts/docusign/embeddedSigningLinkStore";
import type { SignatureRecipient } from "@/lib/contracts/types";

export interface SendEnvelopeResult {
  envelopeId: string;
  envelopeStatus: string;
  /** DocuSign's own "sent at" timestamp from the create-and-send response — null if DocuSign didn't return one. */
  sentDateTime: string | null;
  pdfHeaderCheck: PdfHeaderCheck;
  /**
   * §Phase 7 — REAL recipient state fetched back from DocuSign's own
   * GET .../recipients endpoint immediately after create-and-send, never
   * manufactured locally. The create-and-send response only confirms
   * DocuSign accepted the envelope; this is a second, independent read of
   * DocuSign's own bookkeeping for each recipient.
   */
  recipients: EnvelopeRecipientSummary[];
  /** The connected DocuSign user this envelope was actually sent as — from the org's saved OAuth /oauth/userinfo capture, never guessed or set to a recipient's identity. */
  senderName: string | null;
  senderEmail: string | null;
  senderUserId: string | null;
  /** Whether the sender was also added as a non-signing `carbonCopies` recipient so they get their own copy/notification — false when the sender has no known email, or their email matches a real recipient's. */
  senderCopyRequested: boolean;
}

export class EnvelopeInvariantError extends Error {
  code = "DOCUSIGN_ENVELOPE_INVARIANT_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeInvariantError";
  }
}

/** Deliberately permissive (matches the browser's native `type="email"` behavior) — this is a sanity check against obviously-malformed input (blank, no "@", no domain dot), not full RFC 5322 validation. Shared by send-time validation and recipient correction so both apply the same rule. */
const EMAIL_SHAPE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Zero-width space/non-joiner/joiner and the BOM/zero-width-no-break-space —
 * none of these render visibly in a plain `<input type="email">`, none of
 * them are matched by `\s` in a JS regex (only the true whitespace
 * characters are), and all of them are exactly what a copy-paste out of
 * Outlook/Word/a Salesforce page/a PDF is known to silently carry along next
 * to the visible email text. An email containing one of these looks correct
 * on screen, PASSES `EMAIL_SHAPE_PATTERN`, survives `.trim()` untouched, and
 * reaches DocuSign as a syntactically-different address — DocuSign still
 * returns 201/"sent" for the envelope (the JSON is well-formed), but the
 * actual outbound email silently never reaches the visible address. Stripped
 * here, in the ONE canonical place a recipient email is normalized, so every
 * caller (Test A, the Production Parity Test, and real Send-for-Signature)
 * gets the same cleaned value with no possibility of one path normalizing
 * and another not.
 */
const INVISIBLE_CHARS_PATTERN = /[\u200B\u200C\u200D\uFEFF\u00A0]/g;

/** THE canonical place a recipient email is cleaned before it's validated or sent — see INVISIBLE_CHARS_PATTERN above for why this exists. */
export function normalizeRecipientEmail(email: string): string {
  return email.replace(INVISIBLE_CHARS_PATTERN, "").trim().toLowerCase();
}

function assertPlausibleEmail(email: string, context: string): void {
  if (!EMAIL_SHAPE_PATTERN.test(email)) {
    throw new EnvelopeInvariantError(`${context} is not a valid email address: "${email}".`);
  }
}

export type PdfHeaderCheck = "ok" | "mismatch" | "not-applicable";

function computePdfHeaderCheck(buffer: Buffer, fileExtension: string): PdfHeaderCheck {
  if (fileExtension.toLowerCase() !== "pdf") return "not-applicable";
  return buffer.subarray(0, 4).toString("latin1") === "%PDF" ? "ok" : "mismatch";
}

/**
 * THE canonical signer-builder (§Phase 6) — the ONLY place recipientId/
 * routingOrder/tabStackIndex/emailNotification assignment happens, shared by
 * production Send-for-Signature (sendContractForSignature) AND the
 * Production Parity Email Test (sendProductionParityTestEnvelope) so the two
 * can never independently drift from each other again.
 *
 * `order` (§Phase 6 fix): now used directly as DocuSign's routingOrder,
 * rather than every signer being hardcoded to 1 — for a single recipient
 * (`order` 1) this produces the identical routingOrder "1" as before, so
 * this is a no-op for the case actually under test; it only changes
 * behavior for a FUTURE multi-recipient send, which would newly become
 * sequential-by-add-order rather than all-parallel. That is an explicit,
 * requested behavior change, not an incidental one — recorded here so it's
 * never mistaken for a silent regression.
 *
 * `emailNotification` (§Phase 4): every signer now ALSO carries the same
 * subject/body as an explicit per-recipient override, in addition to the
 * envelope-level emailSubject/emailBlurb — new to this codebase (previously
 * never set anywhere, including Test A/B/C), added as a defensive
 * reinforcement against any account/plan-level per-recipient notification
 * default silently taking precedence over the envelope-level text.
 *
 * Trims name/email and normalizes email through normalizeRecipientEmail()
 * (§Phase 3) — data that passed through browser React state/localStorage is
 * held to a stricter guarantee here than the client-side EMAIL_PATTERN regex
 * alone provides.
 */
export function buildEnvelopeSigners(
  recipients: { name: string; email: string; order: number }[],
  emailContent: { subject: string; body: string },
): EnvelopeSignerInput[] {
  const sorted = [...recipients].sort((a, b) => a.order - b.order);
  return sorted.map((r, i) => {
    const rawTrimmed = r.email.trim();
    const normalizedEmail = normalizeRecipientEmail(r.email);
    // §Phase 1/3 — a length change here (independent of the case-folding
    // normalizeRecipientEmail also does) proves invisible Unicode characters
    // were actually present in what the browser sent for this recipient, and
    // that they've now been stripped BEFORE reaching DocuSign. Never logs the
    // email itself.
    if (rawTrimmed.length !== normalizedEmail.length) {
      console.log(
        `[DOCUSIGN RECIPIENT EMAIL NORMALIZED]\n` +
        `recipientId=${i + 1}\n` +
        `rawTrimmedLength=${rawTrimmed.length}\n` +
        `normalizedLength=${normalizedEmail.length}\n` +
        `note=Invisible Unicode characters (zero-width space/joiner, BOM, or NBSP) were present in this recipient's email and have been stripped before this envelope was sent.`,
      );
    }
    return {
      name: r.name.trim(),
      email: normalizedEmail,
      recipientId: String(i + 1),
      routingOrder: r.order,
      tabStackIndex: i,
      emailNotification: { emailSubject: emailContent.subject, emailBody: emailContent.body },
    };
  });
}

/**
 * §Phase 8 — production parity assertion. Validates the fully-built request
 * BEFORE it ever reaches createAndSendEnvelope()/DocuSign, for BOTH
 * sendContractForSignature and sendProductionParityTestEnvelope. A failure
 * here means this app was about to send DocuSign a malformed/incomplete
 * envelope — stop and report exactly which invariant broke, rather than let
 * DocuSign silently accept (or reject) something we already know is wrong.
 * Returns the PDF-header classification so callers don't need a second,
 * separate computation of the same check (§Phase 5).
 */
function assertEnvelopeInvariants(input: { signers: EnvelopeSignerInput[]; buffer: Buffer; fileExtension: string }): PdfHeaderCheck {
  if (input.signers.length === 0) throw new EnvelopeInvariantError("No signers to send — at least one recipient is required.");
  for (const s of input.signers) {
    if (!s.email) throw new EnvelopeInvariantError(`Recipient ${s.recipientId} has no email.`);
    assertPlausibleEmail(s.email, `Recipient ${s.recipientId}'s email`);
    if (!s.name) throw new EnvelopeInvariantError(`Recipient ${s.recipientId} has no name.`);
    if (s.deliveryMethodOverride !== undefined && s.deliveryMethodOverride !== "email") {
      throw new EnvelopeInvariantError(`Recipient ${s.recipientId} has a non-"email" deliveryMethod override — refusing to send.`);
    }
    if (s.omitTabs) throw new EnvelopeInvariantError(`Recipient ${s.recipientId} would omit its SignHere tab — refusing to send a production envelope without a signing tab.`);
  }
  if (!input.buffer || input.buffer.length === 0) throw new EnvelopeInvariantError("Document has zero bytes.");
  if (!input.fileExtension?.trim()) throw new EnvelopeInvariantError("Document file extension is missing.");
  const pdfHeaderCheck = computePdfHeaderCheck(input.buffer, input.fileExtension);
  if (pdfHeaderCheck === "mismatch") {
    throw new EnvelopeInvariantError(`Document is declared as "${input.fileExtension}" but its bytes do not start with the PDF header (%PDF) — refusing to send a mislabeled document to DocuSign.`);
  }
  return pdfHeaderCheck;
}

export interface CanonicalEnvelopeSendResult {
  envelopeId: string;
  envelopeStatus: string;
  sentDateTime: string | null;
  pdfHeaderCheck: PdfHeaderCheck;
  /** The exact signers actually sent to DocuSign — callers zip additional local metadata (e.g. recipient role) onto this by index rather than re-deriving recipientId themselves. */
  signers: EnvelopeSignerInput[];
  /** REAL recipient state fetched back from DocuSign's own GET .../recipients endpoint, never manufactured locally. */
  recipients: EnvelopeRecipientSummary[];
  senderName: string | null;
  senderEmail: string | null;
  senderUserId: string | null;
  senderCopyRequested: boolean;
}

/**
 * Builds the sender's own `carbonCopies` entry (DocuSign's documented
 * "Receives a Copy" recipient type) so the connected sender gets their own
 * copy/notification of an envelope they just sent — never a signer, never a
 * second signing requirement. Skipped (returns undefined) when the sender's
 * email isn't known, or when it matches a real signer's email (DocuSign
 * would otherwise send the same person both a signing invitation and a
 * redundant copy notification for the same address).
 */
function buildSenderCarbonCopy(
  session: { senderName: string | null; senderEmail: string | null },
  signers: EnvelopeSignerInput[],
): EnvelopeCarbonCopyInput | undefined {
  const senderEmail = session.senderEmail ? normalizeRecipientEmail(session.senderEmail) : null;
  if (!senderEmail) return undefined;
  if (signers.some(s => s.email === senderEmail)) return undefined;
  const lowestRoutingOrder = Math.min(...signers.map(s => s.routingOrder));
  return {
    name: session.senderName?.trim() || "DocuSign Sender",
    email: senderEmail,
    recipientId: String(signers.length + 1),
    // Same routing tier as the earliest signer(s) — the sender's copy fires
    // alongside the initial invitation, not after some later sequential
    // signer completes.
    routingOrder: lowestRoutingOrder,
  };
}

/**
 * THE canonical DocuSign send primitive (§Phase 6) — the ONLY place that
 * resolves a session, builds signers, validates invariants, calls
 * createAndSendEnvelope(), and reads recipients back. Every real send in
 * this codebase goes through here: production Send-for-Signature
 * (sendContractForSignature), the Production Parity Email Test
 * (sendProductionParityTestEnvelope), and the Email Delivery Control Test A
 * (sendDocuSignControlTestEnvelope). The only thing that varies between
 * callers is WHERE `document.buffer` comes from — a real Salesforce
 * ContentVersion download, or a synthetic control-test PDF. Everything from
 * this point on (signer shape, tab inclusion, deliveryMethod, status,
 * emailNotification, the actual POST) is identical for all of them.
 *
 * Control Test B is the one deliberate, disclosed exception — it exists
 * specifically to probe a configuration (zero SignHere tabs) that no real
 * send path ever uses, so it intentionally does not route through here (see
 * sendDocuSignControlTestEnvelope's own comment).
 */
export async function sendDocuSignEnvelope(
  orgId: string,
  input: {
    document: { buffer: Buffer; name: string; extension: string };
    recipients: { name: string; email: string; order: number }[];
    emailSubject: string;
    emailBody: string;
  },
): Promise<CanonicalEnvelopeSendResult> {
  const session = await getActiveDocuSignSession(orgId);
  if (!session) throw new Error("DocuSign is not connected for this organization — connect it in DocuSign Settings first.");

  const documentBase64 = input.document.buffer.toString("base64");
  const signers = buildEnvelopeSigners(input.recipients, { subject: input.emailSubject, body: input.emailBody });
  const pdfHeaderCheck = assertEnvelopeInvariants({ signers, buffer: input.document.buffer, fileExtension: input.document.extension });
  const carbonCopy = buildSenderCarbonCopy(session, signers);

  const result = await createAndSendEnvelope({
    baseUri: session.baseUri,
    accountId: session.accountId,
    accessToken: session.accessToken,
    emailSubject: input.emailSubject,
    emailBody: input.emailBody,
    documentBase64,
    documentName: input.document.name,
    documentExtension: input.document.extension,
    signers,
    carbonCopy,
  });

  // §Phase 7/13 — REAL recipient state fetched back from DocuSign, never
  // manufactured. The create-and-send response only proves DocuSign
  // accepted the envelope; this is a second, independent read.
  const recipientsAfterSend = await getEnvelopeRecipients({
    baseUri: session.baseUri, accountId: session.accountId, accessToken: session.accessToken, envelopeId: result.envelopeId,
  });

  return {
    envelopeId: result.envelopeId,
    envelopeStatus: result.status,
    sentDateTime: result.statusDateTime,
    pdfHeaderCheck,
    signers,
    recipients: recipientsAfterSend,
    senderName: session.senderName,
    senderEmail: session.senderEmail,
    senderUserId: session.senderUserId,
    senderCopyRequested: !!carbonCopy,
  };
}

/**
 * Send-for-signature (§5.2). Preconditions (recipients configured, a
 * selected source document, no envelopeId already recorded) are enforced by
 * the caller (the API route) against the signature-store state before this
 * is invoked — this function downloads the real Salesforce document, then
 * hands off to the canonical sendDocuSignEnvelope() for everything else.
 */
export async function sendContractForSignature(
  client: SalesforceClient,
  orgId: string,
  opts: {
    contractId: string; contentVersionId: string; recipients: SignatureRecipient[]; contractLabel: string;
    /** The Signatures panel's user-editable email template, already token-substituted — falls back to the fixed buildEnvelopeEmail() text if omitted. */
    emailSubject?: string; emailBody?: string;
    /** Purely for the pre-send diagnostic log below — already resolved by the caller's Phase 4 ownership check, so this never triggers a second Salesforce round-trip here. */
    contentDocumentId?: string;
  },
): Promise<SendEnvelopeResult> {
  if (opts.recipients.length === 0) throw new Error("At least one recipient is required before sending.");

  const { buffer, fileExtension } = await downloadContentVersion(client, opts.contentVersionId);

  const fallback = buildEnvelopeEmail(opts.contractLabel);
  const emailSubject = opts.emailSubject?.trim() || fallback.subject;
  const emailBody = opts.emailBody?.trim() || fallback.body;

  const sorted = [...opts.recipients].sort((a, b) => a.order - b.order);
  const maskedFirstEmail = sorted[0] ? sorted[0].email.replace(/(?<=.).(?=[^@]*@)/g, "*") : null;

  // §Phase 12 — sanitized snapshot of exactly what's about to be sent,
  // BEFORE the canonical send primitive is invoked.
  console.log(
    `[DOCUSIGN FINAL PRODUCTION SEND]\n` +
    `contractId=${opts.contractId}\n` +
    `contentVersionId=${opts.contentVersionId}\n` +
    `contentDocumentId=${opts.contentDocumentId ?? "(not supplied)"}\n` +
    `documentTitle=${opts.contractLabel}\n` +
    `documentExtension=${fileExtension}\n` +
    `documentByteLength=${buffer.length}\n` +
    `recipientCount=${sorted.length}\n` +
    (sorted[0]
      ? `recipient[0].name=${sorted[0].name}\n` +
        `recipient[0].emailMasked=${maskedFirstEmail}\n` +
        `recipient[0].recipientId=1\n` +
        `recipient[0].routingOrder=${sorted[0].order}\n` +
        `recipient[0].deliveryMethod=email\n` +
        `recipient[0].clientUserIdPresent=false\n` +
        `recipient[0].signHereTabCount=1`
      : "(no recipients)"),
  );

  const sendResult = await sendDocuSignEnvelope(orgId, {
    document: { buffer, name: opts.contractLabel, extension: fileExtension },
    recipients: sorted.map(r => ({ name: r.name, email: r.email, order: r.order })),
    emailSubject,
    emailBody,
  });

  // §Phase 13 — real DocuSign response, never manufactured. `pdfHeaderValid`
  // and `accountId`/`baseUri` are also logged here even though they were
  // resolved inside the canonical function, for a single complete record.
  const session = await getActiveDocuSignSession(orgId);
  console.log(
    `[DOCUSIGN FINAL PRODUCTION RESULT]\n` +
    `envelopeId=${sendResult.envelopeId}\n` +
    `envelopeStatus=${sendResult.envelopeStatus}\n` +
    `pdfHeaderValid=${sendResult.pdfHeaderCheck}\n` +
    `accountId=${session?.accountId ?? "(unknown)"}\n` +
    `baseUri=${session?.baseUri ?? "(unknown)"}\n` +
    `senderEmail=${session?.senderEmail ?? "(unknown)"}\n` +
    `senderCopyRequested=${sendResult.senderCopyRequested}\n` +
    sendResult.recipients.map(r =>
      `recipientId=${r.recipientId} recipientStatus=${r.status} deliveryMethod=${r.deliveryMethod} sentDateTime=${r.sentDateTime} deliveredDateTime=${r.deliveredDateTime}`,
    ).join("\n"),
  );

  // Server-side tracking (§Phase 14) — the ONLY server-side record of this
  // envelope's Contract/document/recipient-role association. Without this,
  // neither the DocuSign Connect webhook nor "Refresh DocuSign Status" would
  // have anything to resolve envelopeId back to. Zipped against
  // `sendResult.signers` (the exact array actually sent to DocuSign) by
  // index — index-aligned with `sorted` by construction (buildEnvelopeSigners
  // re-sorts by the SAME `order` values, a stable no-op re-sort) — so
  // recipientId can never independently drift from what DocuSign received.
  await trackSentEnvelope({
    envelopeId: sendResult.envelopeId,
    orgId,
    contractId: opts.contractId,
    sourceContentVersionId: opts.contentVersionId,
    documentTitle: opts.contractLabel,
    recipients: sendResult.signers.map((s, i) => ({ recipientId: s.recipientId, name: s.name, email: s.email, role: sorted[i].role })),
    envelopeStatus: sendResult.envelopeStatus,
    sentDateTime: sendResult.sentDateTime,
  });

  return {
    envelopeId: sendResult.envelopeId,
    envelopeStatus: sendResult.envelopeStatus,
    sentDateTime: sendResult.sentDateTime,
    pdfHeaderCheck: sendResult.pdfHeaderCheck,
    recipients: sendResult.recipients,
    senderName: sendResult.senderName,
    senderEmail: sendResult.senderEmail,
    senderUserId: sendResult.senderUserId,
    senderCopyRequested: sendResult.senderCopyRequested,
  };
}

export interface EmbeddedSigningTestResult {
  envelopeId: string;
  envelopeStatus: string;
  /** This app's own stable link — NOT a DocuSign URL. Safe to put in an email body: /api/contracts/docusign/sign/[token] mints a fresh, short-lived DocuSign view on every click (see resolveEmbeddedSigningRedirect below). */
  signingLink: string;
  senderName: string | null;
  senderEmail: string | null;
  recipientName: string;
  recipientEmail: string;
  contractId: string;
  contentVersionId: string;
  documentName: string;
}

/**
 * "Send Signing Email" — a separate, parallel test/delivery
 * option alongside sendContractForSignature (§5.2 above), NOT a replacement
 * for it. Creates its OWN new envelope (never touches or reuses whatever
 * envelope the normal Send-for-Signature flow may already have created for
 * this document) with exactly ONE captive/`clientUserId` signer, since that
 * is the only DocuSign recipient shape createRecipientView() will work
 * against. Because the recipient is captive, DocuSign itself will NEVER
 * email them for this envelope — by design, since the whole point of this
 * flow is that the SENDER delivers the link manually instead.
 *
 * Does not call trackSentEnvelope() or touch localSignatureStore's one-
 * envelope-per-document lock — this is deliberately invisible to the normal
 * Signatures-tab status machinery, so it can never block or interfere with
 * a real Send-for-Signature on the same document.
 */
export async function sendEmbeddedSigningTestEnvelope(
  client: SalesforceClient,
  orgId: string,
  opts: {
    contractId: string; contentVersionId: string; recipientName: string; recipientEmail: string;
    contractLabel: string;
    /** The resolved PUBLIC base URL to build the stable /sign/[token] link against — never a DocuSign host, and never blindly the request's own origin (see publicAppUrl.ts's resolvePublicAppUrl, which the caller must use to produce this). */
    appOrigin: string;
    emailSubject?: string; emailBody?: string;
  },
): Promise<EmbeddedSigningTestResult> {
  const trimmedName = opts.recipientName.trim();
  const trimmedEmail = normalizeRecipientEmail(opts.recipientEmail);
  if (!trimmedName) throw new EnvelopeInvariantError("A recipient name is required.");
  assertPlausibleEmail(trimmedEmail, "The recipient's email");

  const session = await getActiveDocuSignSession(orgId);
  if (!session) throw new Error("DocuSign is not connected for this organization — connect it in DocuSign Settings first.");

  const { buffer, fileExtension } = await downloadContentVersion(client, opts.contentVersionId);
  const fallback = buildEnvelopeEmail(opts.contractLabel);
  const emailSubject = opts.emailSubject?.trim() || fallback.subject;
  const emailBody = opts.emailBody?.trim() || fallback.body;

  const clientUserId = randomBytes(16).toString("hex");
  const recipientId = "1";
  const signer: EnvelopeSignerInput = {
    name: trimmedName, email: trimmedEmail, recipientId, routingOrder: 1, tabStackIndex: 0, clientUserId,
  };
  // Same invariant guard every real send goes through (throws on any
  // violation) — its pdfHeaderCheck return value isn't part of this
  // flow's result shape, so it's intentionally discarded.
  assertEnvelopeInvariants({ signers: [signer], buffer, fileExtension: fileExtension });

  const createResult = await createAndSendEnvelope({
    baseUri: session.baseUri,
    accountId: session.accountId,
    accessToken: session.accessToken,
    emailSubject,
    emailBody,
    documentBase64: buffer.toString("base64"),
    documentName: opts.contractLabel,
    documentExtension: fileExtension,
    signers: [signer],
  });

  const linkRecord = await createEmbeddedSigningLink({
    orgId,
    envelopeId: createResult.envelopeId,
    recipientId,
    clientUserId,
    recipientName: trimmedName,
    recipientEmail: trimmedEmail,
    contractId: opts.contractId,
  });

  return {
    envelopeId: createResult.envelopeId,
    envelopeStatus: createResult.status,
    signingLink: new URL(`/api/contracts/docusign/sign/${linkRecord.token}`, opts.appOrigin).toString(),
    senderName: session.senderName,
    senderEmail: session.senderEmail,
    recipientName: trimmedName,
    recipientEmail: trimmedEmail,
    contractId: opts.contractId,
    contentVersionId: opts.contentVersionId,
    documentName: opts.contractLabel,
  };
}

/**
 * The public /sign/[token] redirect route's ONLY logic — looks up the token
 * (never trusts anything else supplied by the caller, since this route has
 * no Salesforce session to check), then mints a BRAND NEW DocuSign
 * recipientView url and returns it for an immediate redirect. Never caches
 * or reuses a previously-returned url — DocuSign's own url is single-use and
 * expires in minutes, so a fresh one is generated on every single click,
 * however long after the email was sent that click happens.
 */
export async function resolveEmbeddedSigningRedirect(token: string, returnUrl: string): Promise<{ url: string } | null> {
  const link = await getEmbeddedSigningLink(token);
  if (!link) return null;

  const session = await getActiveDocuSignSession(link.orgId);
  if (!session) throw new Error("DocuSign is not connected for this organization — the sender needs to reconnect it in DocuSign Settings.");

  const view = await createRecipientView({
    baseUri: session.baseUri,
    accountId: session.accountId,
    accessToken: session.accessToken,
    envelopeId: link.envelopeId,
    recipientId: link.recipientId,
    clientUserId: link.clientUserId,
    name: link.recipientName,
    email: link.recipientEmail,
    returnUrl,
  });
  return view;
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
    autoRespondedReason: string | null;
    declinedReason: string | null;
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
      autoRespondedReason: r.autoRespondedReason,
      declinedReason: r.declinedReason,
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
 * "Correct Recipient & Resend" (§Phase 6) — recovery action for a recipient
 * DocuSign has already reported as undeliverable (autoresponded/bounce,
 * declined, or any other stuck non-terminal state). Uses DocuSign's
 * documented recipient-correction operation (client.ts's
 * correctAndResendRecipient — PUT .../recipients?resend_envelope=true): this
 * updates the recipient's email on the SAME envelope and forces a fresh
 * invitation, rather than creating a new envelope. One explicit call = one
 * corrected recipient = one resend; this function has no retry/loop of its
 * own, so the caller (an explicit button click) fully controls how often it
 * runs. Refuses to "correct" a recipient who has already signed or declined —
 * DocuSign does not support re-routing a terminal recipient this way, and
 * silently accepting the call would misleadingly imply it worked.
 */
export async function correctAndResendEnvelopeRecipient(
  orgId: string,
  envelopeId: string,
  input: { recipientId: string; name: string; email: string },
): Promise<EnvelopeDiagnostics> {
  const trimmedEmail = normalizeRecipientEmail(input.email);
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new EnvelopeInvariantError("A recipient name is required.");
  assertPlausibleEmail(trimmedEmail, "The corrected email");

  const session = await getActiveDocuSignSession(orgId);
  if (!session) throw new Error("DocuSign is not connected for this organization.");

  const before = await getEnvelopeRecipients({ baseUri: session.baseUri, accountId: session.accountId, accessToken: session.accessToken, envelopeId });
  const target = before.find(r => r.recipientId === input.recipientId);
  if (!target) throw new EnvelopeInvariantError(`Recipient ${input.recipientId} was not found on this envelope.`);
  if (target.signedDateTime) throw new EnvelopeInvariantError("This recipient has already signed — nothing to correct.");
  if (target.declinedDateTime) throw new EnvelopeInvariantError("This recipient has already declined — correct the envelope in DocuSign directly if you still need their signature.");

  await correctAndResendRecipient({
    baseUri: session.baseUri, accountId: session.accountId, accessToken: session.accessToken,
    envelopeId, recipientId: input.recipientId, name: trimmedName, email: trimmedEmail,
  });

  return getEnvelopeDiagnostics(orgId, envelopeId);
}

const CONTROL_TEST_SUBJECT = "DocuSign Connectivity Test";
const CONTROL_TEST_BODY = "This is a one-off connectivity test sent from DocuSign Settings — safe to ignore or decline. It is not tied to any Contract.";

/**
 * Email-delivery control test (DocuSign Settings' "Email Delivery Control
 * Test"). Not tied to any Contract — the document is a trivial placeholder
 * (controlTestDocument.ts). Callers (the API route) are responsible for
 * making this a single explicit user action, not something invoked
 * automatically or in a loop.
 *
 * Test A (`omitTabs` falsy) — this IS the canonical shape (explicit
 * deliveryMethod default, SignHere tab present, signer-level
 * emailNotification) — routes through the SAME sendDocuSignEnvelope() that
 * production Send-for-Signature and the Production Parity Email Test use.
 * `explicitDeliveryMethod` no longer changes anything here (it never
 * produced a different outgoing value — deliveryMethod is always "email"
 * either way); kept only so the route's existing request shape doesn't need
 * to change.
 *
 * Test B (`omitTabs: true`) is the ONE deliberate exception that does NOT
 * route through the canonical function — it exists specifically to probe a
 * configuration (zero SignHere tabs) that no real send path is ever allowed
 * to use (assertEnvelopeInvariants refuses it). Kept as a direct, isolated
 * createAndSendEnvelope() call so that experiment can never accidentally
 * leak into the canonical path production/Test A share.
 */
export async function sendDocuSignControlTestEnvelope(
  orgId: string,
  opts: { recipientName: string; recipientEmail: string; explicitDeliveryMethod?: boolean; omitTabs?: boolean },
): Promise<EnvelopeDiagnostics> {
  const documentBuffer = await renderControlTestDocument();

  if (!opts.omitTabs) {
    const sendResult = await sendDocuSignEnvelope(orgId, {
      document: { buffer: documentBuffer, name: CONTROL_TEST_SUBJECT, extension: "pdf" },
      recipients: [{ name: opts.recipientName, email: opts.recipientEmail, order: 1 }],
      emailSubject: CONTROL_TEST_SUBJECT,
      emailBody: CONTROL_TEST_BODY,
    });
    return getEnvelopeDiagnostics(orgId, sendResult.envelopeId);
  }

  const session = await getActiveDocuSignSession(orgId);
  if (!session) throw new Error("DocuSign is not connected for this organization — connect it in DocuSign Settings first.");
  const result = await createAndSendEnvelope({
    baseUri: session.baseUri,
    accountId: session.accountId,
    accessToken: session.accessToken,
    emailSubject: CONTROL_TEST_SUBJECT,
    emailBody: CONTROL_TEST_BODY,
    documentBase64: documentBuffer.toString("base64"),
    documentName: "DocuSign Connectivity Test (Freeform — no tabs)",
    documentExtension: "pdf",
    signers: [{
      name: opts.recipientName, email: opts.recipientEmail, recipientId: "1", routingOrder: 1, tabStackIndex: 0,
      deliveryMethodOverride: "email",
      omitTabs: true,
    }],
  });

  return getEnvelopeDiagnostics(orgId, result.envelopeId);
}

export interface IsolationTestResult {
  caseNumber: 1 | 2 | 3 | 4;
  envelopeId: string;
  envelopeStatus: string;
  sentDateTime: string | null;
  documentSource: "control-test-pdf" | "salesforce-content-version";
  emailContentSource: "test-a-fixed" | "production-template";
  contentVersionId: string | null;
  documentTitle: string;
  diagnostics: EnvelopeDiagnostics;
}

/**
 * Email-delivery isolation test (Cases 1-4) — explicitly requested as a
 * one-variable-at-a-time experiment, since comparing envelope STRUCTURE
 * (already proven identical between Test A and production — see
 * sendDocuSignEnvelope's doc comment) doesn't explain a real-world delivery
 * difference. Every case routes through the SAME sendDocuSignEnvelope() Test
 * A/production/Test C all share; only the document and/or email content
 * inputs vary, exactly one variable added per case relative to Case 1:
 *
 *   Case 1 (baseline)              — Test A's own fixed PDF + fixed subject/body.
 *   Case 2 (+ email content)       — Test A's PDF, but production's email template.
 *   Case 3 (+ document)            — production's real Salesforce PDF, but Test A's subject/body.
 *   Case 4 (+ recipient inputs)    — both production's document AND production's email content.
 *
 * Never called automatically — each case is one explicit user action (one
 * button click = one new envelope), same discipline as Test A/B/C. Each call
 * creates a genuinely NEW envelope and returns its own envelopeId plus a
 * fresh getEnvelopeDiagnostics() read — callers must NOT treat
 * envelopeStatus "sent" as proof of inbox delivery; that determination
 * requires the human checking the actual mailbox.
 */
export async function sendEmailIsolationTestEnvelope(
  client: SalesforceClient,
  orgId: string,
  input: { caseNumber: 1 | 2 | 3 | 4; recipientName: string; recipientEmail: string; contentVersionId?: string; contractLabel?: string },
): Promise<IsolationTestResult> {
  const useSalesforceDocument = input.caseNumber === 3 || input.caseNumber === 4;
  const useProductionEmailContent = input.caseNumber === 2 || input.caseNumber === 4;

  let document: { buffer: Buffer; name: string; extension: string };
  let documentTitle: string;
  let contentVersionId: string | null = null;

  if (useSalesforceDocument) {
    const trimmedId = input.contentVersionId?.trim();
    if (!trimmedId) throw new EnvelopeInvariantError("A Salesforce ContentVersion ID is required for Case 3/4.");
    contentVersionId = trimmedId;
    // Same pre-flight existence check Test C (production-parity-test route) uses — proves this ID resolves in THIS org/session before attempting a download.
    const verify = await client.query<{ Id: string; Title: string }>(
      `SELECT Id, Title FROM ContentVersion WHERE Id = '${soqlEscape(trimmedId)}'`,
    );
    if (verify.records.length === 0) {
      throw new EnvelopeInvariantError(`ContentVersion ${trimmedId} does not exist (or is not visible) in the currently authenticated Salesforce org.`);
    }
    // The REAL title, straight from Salesforce — never guessed — so "production document name" in Case 4 is the actual document name, not a placeholder.
    documentTitle = verify.records[0].Title || "Contract Document";
    const { buffer, fileExtension } = await downloadContentVersion(client, trimmedId);
    document = { buffer, name: documentTitle, extension: fileExtension };
  } else {
    documentTitle = CONTROL_TEST_SUBJECT;
    document = { buffer: await renderControlTestDocument(), name: documentTitle, extension: "pdf" };
  }

  const contractLabel = input.contractLabel?.trim() || "Isolation Test";
  const emailSubject = useProductionEmailContent
    ? substituteEmailTokens(DEFAULT_EMAIL_SUBJECT, { contractNumber: contractLabel, recipientName: input.recipientName })
    : CONTROL_TEST_SUBJECT;
  const emailBody = useProductionEmailContent
    ? substituteEmailTokens(DEFAULT_EMAIL_BODY, { contractNumber: contractLabel, recipientName: input.recipientName })
    : CONTROL_TEST_BODY;

  const sendResult = await sendDocuSignEnvelope(orgId, {
    document,
    recipients: [{ name: input.recipientName, email: input.recipientEmail, order: 1 }],
    emailSubject,
    emailBody,
  });

  const diagnostics = await getEnvelopeDiagnostics(orgId, sendResult.envelopeId);

  return {
    caseNumber: input.caseNumber,
    envelopeId: sendResult.envelopeId,
    envelopeStatus: sendResult.envelopeStatus,
    sentDateTime: sendResult.sentDateTime,
    documentSource: useSalesforceDocument ? "salesforce-content-version" : "control-test-pdf",
    emailContentSource: useProductionEmailContent ? "production-template" : "test-a-fixed",
    contentVersionId,
    documentTitle,
    diagnostics,
  };
}

export interface SenderIdentityComparison {
  apiSenderUserId: string | null;
  apiSenderAccountId: string | null;
  apiSenderEmailMasked: string | null;
  manualSenderUserId: string | null;
  manualSenderAccountId: string | null;
  manualSenderEmailMasked: string | null;
  sameSenderUserId: boolean;
  sameSenderAccountId: boolean;
  /** This org's currently active DocuSign session — the SAME session used to fetch both raw dumps above, surfaced here for cross-reference (not because it could differ between the two calls). */
  activeSession: { environment: string; accountId: string; baseUri: string } | null;
}

export interface EnvelopeComparisonResult {
  apiEnvelopeId: string;
  manualEnvelopeId: string;
  envelopeDiffs: EnvelopeDiffEntry[];
  recipientDiffs: EnvelopeDiffEntry[];
  notificationDiffs: EnvelopeDiffEntry[];
  auditDiffs: EnvelopeDiffEntry[];
  strongestCandidate: EnvelopeDiffEntry | null;
  senderIdentityComparison: SenderIdentityComparison;
  /** Curated side-by-side confirmation of every field explicitly requested for cross-checking — NOT a diff, so fields that are IDENTICAL on both sides are just as visible as ones that differ. */
  apiSummary: EnvelopeSideBySideSummary;
  manualSummary: EnvelopeSideBySideSummary;
}

function extractSender(raw: Record<string, unknown> | null): { userId: string | null; accountId: string | null; email: string | null } {
  const sender = (raw?.sender as Record<string, unknown> | undefined) ?? undefined;
  return {
    userId: (sender?.userId as string) ?? null,
    accountId: (sender?.accountId as string) ?? null,
    email: (sender?.email as string) ?? null,
  };
}

export interface EnvelopeSideBySideSummary {
  accountId: string | null;
  senderUserId: string | null;
  status: string | null;
  emailSubject: string | null;
  emailBlurbPresent: boolean;
  documentCount: number | null;
  documentExtension: string | null;
  recipientId: string | null;
  routingOrder: string | null;
  deliveryMethod: string | null;
  clientUserIdPresent: boolean;
  emailNotificationPresent: boolean;
  recipientSuppliesTabs: string | null;
  totalTabCount: number | null;
  signHereTabCount: number | null;
  recipientStatus: string | null;
  sentDateTime: string | null;
  deliveredDateTime: string | null;
  /** Every audit event NAME this envelope actually has, in order — e.g. ["Registered","Sent Invitations","Delivered"]. Read directly, never diffed (event timestamps/counts inherently differ per envelope). */
  auditEventNames: string[];
}

/** Pulls the exact fields §Confirm-for-both asks for out of one envelope's raw dump — first signer only (both Test A and Test C/production are single-recipient tests). Every field is read defensively (never assumed present) since DocuSign's raw response shape varies by account/plan. */
function buildSideBySideSummary(raw: { envelope: Record<string, unknown> | null; recipients: Record<string, unknown> | null; auditEvents: Record<string, unknown> | null }, senderAccountId: string | null): EnvelopeSideBySideSummary {
  const env = raw.envelope ?? {};
  const signers = (raw.recipients?.signers as Record<string, unknown>[] | undefined) ?? [];
  const first = signers[0] ?? {};
  const documents = (env.documents as Record<string, unknown>[] | undefined) ?? [];
  const tabs = (first.tabs as Record<string, unknown> | undefined) ?? {};
  const signHereTabs = (tabs.signHereTabs as unknown[] | undefined) ?? [];
  const auditEventsList = (raw.auditEvents?.auditEvents as { eventFields?: { name: string; value: string }[] }[] | undefined) ?? [];
  const auditEventNames = auditEventsList.map(e => (e.eventFields ?? []).find(f => f.name === "EventName")?.value ?? "(unnamed event)");

  return {
    accountId: senderAccountId,
    senderUserId: ((env.sender as Record<string, unknown> | undefined)?.userId as string) ?? null,
    status: (env.status as string) ?? null,
    emailSubject: (env.emailSubject as string) ?? null,
    emailBlurbPresent: !!env.emailBlurb,
    documentCount: documents.length || null,
    documentExtension: (documents[0]?.fileExtension as string) ?? null,
    recipientId: (first.recipientId as string) ?? null,
    routingOrder: (first.routingOrder as string) ?? null,
    deliveryMethod: (first.deliveryMethod as string) ?? null,
    clientUserIdPresent: !!first.clientUserId,
    emailNotificationPresent: !!first.emailNotification,
    recipientSuppliesTabs: (first.recipientSuppliesTabs as string) ?? null,
    totalTabCount: first.totalTabCount != null ? Number(first.totalTabCount) : null,
    signHereTabCount: signHereTabs.length,
    recipientStatus: (first.status as string) ?? null,
    sentDateTime: (first.sentDateTime as string) ?? null,
    deliveredDateTime: (first.deliveredDateTime as string) ?? null,
    auditEventNames,
  };
}

/**
 * "Compare Envelopes" (DocuSign Settings): fetches BOTH envelopes' raw
 * DocuSign responses server-side and returns a structured diff — no manual
 * JSON copy/paste required. Read-only; never creates or modifies anything.
 *
 * Also explicitly answers "was this sent by the same DocuSign account/user
 * as the manual envelope?" — the envelope resource's own `sender` object
 * (userId/accountId/email), independent of the generic field-by-field diff
 * (which deliberately ignores `accountId` wherever it appears generically,
 * since every record echoes it structurally — this is the one place it's
 * compared on purpose).
 */
export async function compareDocuSignEnvelopes(orgId: string, apiEnvelopeId: string, manualEnvelopeId: string): Promise<EnvelopeComparisonResult> {
  const [apiRaw, manualRaw, session] = await Promise.all([
    getEnvelopeRawDiagnostics(orgId, apiEnvelopeId),
    getEnvelopeRawDiagnostics(orgId, manualEnvelopeId),
    getActiveDocuSignSession(orgId),
  ]);

  const envelopeDiffs = sortDiffs(diffEnvelopeJson(apiRaw.envelope, manualRaw.envelope));
  const recipientDiffs = sortDiffs(diffEnvelopeJson(apiRaw.recipients, manualRaw.recipients));
  const notificationDiffs = sortDiffs(diffEnvelopeJson(apiRaw.notification, manualRaw.notification));
  const auditDiffs = sortDiffs(diffEnvelopeJson(apiRaw.auditEvents, manualRaw.auditEvents));

  const allDiffs = [...envelopeDiffs, ...recipientDiffs, ...notificationDiffs];
  const strongestCandidate =
    allDiffs.find(d => d.classification === "strong-delivery-candidate") ??
    allDiffs.find(d => d.classification === "possibly-delivery-relevant") ??
    null;

  const apiSender = extractSender(apiRaw.envelope);
  const manualSender = extractSender(manualRaw.envelope);
  const senderIdentityComparison: SenderIdentityComparison = {
    apiSenderUserId: apiSender.userId,
    apiSenderAccountId: apiSender.accountId,
    apiSenderEmailMasked: apiSender.email ? maskEmail(apiSender.email) : null,
    manualSenderUserId: manualSender.userId,
    manualSenderAccountId: manualSender.accountId,
    manualSenderEmailMasked: manualSender.email ? maskEmail(manualSender.email) : null,
    sameSenderUserId: !!apiSender.userId && apiSender.userId === manualSender.userId,
    sameSenderAccountId: !!apiSender.accountId && apiSender.accountId === manualSender.accountId,
    activeSession: session ? { environment: session.environment, accountId: session.accountId, baseUri: session.baseUri } : null,
  };

  const apiSummary = buildSideBySideSummary(apiRaw, apiSender.accountId);
  const manualSummary = buildSideBySideSummary(manualRaw, manualSender.accountId);

  return { apiEnvelopeId, manualEnvelopeId, envelopeDiffs, recipientDiffs, notificationDiffs, auditDiffs, strongestCandidate, senderIdentityComparison, apiSummary, manualSummary };
}

export interface ProductionParityTestResult {
  envelopeId: string;
  envelopeStatus: string;
  sentDateTime: string | null;
  contentVersionId: string;
  fileExtension: string;
  /** "not-applicable" when the real file isn't declared as pdf — this test never assumes pdf, exactly like production. */
  pdfHeaderCheck: PdfHeaderCheck;
}

/**
 * "Production Parity Email Test" (Test C) — diagnostic-only, but downloads a
 * REAL Salesforce ContentVersion and hands off to the SAME canonical
 * sendDocuSignEnvelope() production's sendContractForSignature() uses (§Phase
 * 6) — no separate envelope-building logic of its own anymore.
 *
 * The ONLY differences from a real Send-for-Signature: (1) it never calls
 * trackSentEnvelope — sending this does not create, lock, or advance any
 * real SignatureRequest, and touches no Contract/signature state at all;
 * (2) contentVersionId/recipient name+email/contractLabel come directly
 * from the diagnostic form rather than a saved request; (3) always uses the
 * buildEnvelopeEmail() fallback text rather than a user-edited template. The
 * actual DocuSign request body is otherwise indistinguishable from production.
 */
export async function sendProductionParityTestEnvelope(
  client: SalesforceClient,
  orgId: string,
  opts: { contentVersionId: string; recipientName: string; recipientEmail: string; contractLabel: string },
): Promise<ProductionParityTestResult> {
  // Sanitized trace (§Phase 1) — reconstructed for logging only, not a
  // separate request: downloadContentVersion()/client.getBinary() build the
  // exact same URL internally. Logged here (rather than inside client.ts,
  // which the real production download route also depends on) so this
  // diagnostic-only trace can never affect that shared, already-working path.
  console.log(
    `[PRODUCTION PARITY TEST]\n` +
    `ContentVersion ID passed to downloadContentVersion: ${opts.contentVersionId}\n` +
    `Salesforce REST path about to be called: ${client.instanceUrl}/services/data/${client.apiVersion}/sobjects/ContentVersion/${opts.contentVersionId}/VersionData`,
  );

  const { buffer, fileExtension } = await downloadContentVersion(client, opts.contentVersionId);
  console.log(
    `[PRODUCTION PARITY TEST]\n` +
    `Download succeeded — byte length: ${buffer.length}\n` +
    `FileExtension from Salesforce: ${fileExtension}`,
  );

  const fallback = buildEnvelopeEmail(opts.contractLabel);
  const sendResult = await sendDocuSignEnvelope(orgId, {
    document: { buffer, name: opts.contractLabel, extension: fileExtension },
    recipients: [{ name: opts.recipientName, email: opts.recipientEmail, order: 1 }],
    emailSubject: fallback.subject,
    emailBody: fallback.body,
  });

  return {
    envelopeId: sendResult.envelopeId,
    envelopeStatus: sendResult.envelopeStatus,
    sentDateTime: sendResult.sentDateTime,
    contentVersionId: opts.contentVersionId,
    fileExtension,
    pdfHeaderCheck: sendResult.pdfHeaderCheck,
  };
}
