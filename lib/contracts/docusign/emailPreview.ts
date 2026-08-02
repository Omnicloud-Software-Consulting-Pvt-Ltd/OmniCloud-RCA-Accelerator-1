/**
 * The exact subject/body DocuSign sends as part of creating the envelope
 * when no user-editable override is supplied. Extracted into its own pure,
 * dependency-free module so BOTH the server-side send call
 * (lib/contracts/docusign/envelope.ts) and the client-side email preview
 * could import the exact same function — the preview can never drift from
 * what is actually sent, because there is only one place this text is
 * written. `envelope.ts`'s `sendContractForSignature` is REAL and live —
 * called from app/api/contracts/[id]/signature/send/route.ts, which creates
 * an actual DocuSign envelope via the real DocuSign REST API. This function
 * is the fallback used only if the Signatures panel's editable subject/body
 * (DEFAULT_EMAIL_SUBJECT/BODY below) isn't supplied.
 */
export function buildEnvelopeEmail(contractLabel: string): { subject: string; body: string } {
  return {
    subject: `Please sign: ${contractLabel}`,
    body: `You have been asked to review and sign "${contractLabel}". This email was sent by DocuSign on behalf of the sender as part of creating this envelope.`,
  };
}

/**
 * The Signatures panel's editable email template — user-editable
 * subject/body with {{ContractNumber}}/{{RecipientName}} tokens, live
 * substituted client-side for the preview (SignaturePanel.tsx) and passed
 * through, already substituted, as the REAL envelope's emailSubject/emailBody
 * when Send for Signature actually creates the DocuSign envelope (see
 * app/api/contracts/[id]/signature/send/route.ts and
 * envelope.ts's `sendContractForSignature`).
 */
export const DEFAULT_EMAIL_SUBJECT = "Review and Sign Contract {{ContractNumber}}";
export const DEFAULT_EMAIL_BODY =
  "Hello {{RecipientName}},\n\n" +
  "Please review and sign the attached agreement for Contract {{ContractNumber}}.\n\n" +
  "The attached document contains the agreement for your review.\n\n" +
  "Thank you.";

export function substituteEmailTokens(template: string, values: { contractNumber: string; recipientName: string }): string {
  return template
    .replace(/\{\{\s*ContractNumber\s*\}\}/g, values.contractNumber)
    .replace(/\{\{\s*RecipientName\s*\}\}/g, values.recipientName);
}
