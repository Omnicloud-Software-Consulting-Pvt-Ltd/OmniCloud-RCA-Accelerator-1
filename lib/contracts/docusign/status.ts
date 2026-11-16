import type { EnvelopeAction, EnvelopeView } from "@/lib/contracts/docusign/types";

/**
 * DocuSign's own envelope / recipient status values → plain-language labels, and which actions each state allows. DocuSign stays
 * the source of truth: these only translate and gate what the UI offers (DocuSign still enforces every action itself).
 * Envelope statuses: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/envelopes/status-codes/
 */

const ENVELOPE: Record<string, { label: string; tone: EnvelopeView["statusTone"] }> = {
  created: { label: "Draft", tone: "neutral" },
  sent: { label: "Sent — waiting for signatures", tone: "progress" },
  delivered: { label: "Opened by a recipient", tone: "progress" },
  signed: { label: "Signed", tone: "progress" },
  correct: { label: "Being corrected", tone: "progress" },
  completed: { label: "Completed", tone: "success" },
  authoritativecopy: { label: "Completed (authoritative copy)", tone: "success" },
  transfercompleted: { label: "Completed (transferred)", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  voided: { label: "Voided", tone: "danger" },
  timedout: { label: "Expired", tone: "danger" },
  deleted: { label: "Deleted", tone: "danger" },
};

export function envelopeStatusView(status: string | null | undefined, voidedReason?: string | null): { label: string; tone: EnvelopeView["statusTone"] } {
  const s = (status ?? "").toLowerCase();
  // DocuSign voids an envelope when it expires; the reason says so.
  if (s === "voided" && voidedReason && /expire/i.test(voidedReason)) return { label: "Expired", tone: "danger" };
  return ENVELOPE[s] ?? { label: status ? status : "Unknown", tone: "neutral" };
}

const RECIPIENT: Record<string, string> = {
  created: "Not sent yet",
  sent: "Email sent — waiting",
  delivered: "Opened",
  signed: "Signed",
  completed: "Completed",
  declined: "Declined",
  autoresponded: "Email bounced",
  faxpending: "Fax pending",
};

export const recipientStatusLabel = (status: string | null | undefined) => RECIPIENT[(status ?? "").toLowerCase()] ?? (status || "Unknown");

/** A recipient who already finished (or refused) can't be corrected. */
export const recipientCanBeCorrected = (status: string | null | undefined) => !["signed", "completed", "declined"].includes((status ?? "").toLowerCase());

export const isCompletedStatus = (status: string | null | undefined) => ["completed", "authoritativecopy", "transfercompleted"].includes((status ?? "").toLowerCase());

/** In flight = recipients can still act; only then can it be resent, corrected or voided. */
export const isInFlightStatus = (status: string | null | undefined) => ["sent", "delivered", "signed", "correct"].includes((status ?? "").toLowerCase());

export function allowedEnvelopeActions(status: string | null | undefined): EnvelopeAction[] {
  if (isCompletedStatus(status)) return ["download-signed", "download-certificate", "store"];
  if (isInFlightStatus(status)) return ["resend", "correct", "void"];
  return [];
}

export function assertActionAllowed(status: string | null | undefined, action: EnvelopeAction): string | null {
  if (allowedEnvelopeActions(status).includes(action)) return null;
  const label = envelopeStatusView(status).label;
  if (action === "download-signed" || action === "download-certificate" || action === "store") return `The signed document is available only after everyone has signed (this envelope is "${label}").`;
  return `This can't be done while the envelope is "${label}".`;
}
