import { DocuSignApiError, type DocuSignApi } from "@/lib/contracts/docusign/client";
import { allowedEnvelopeActions, envelopeStatusView, recipientCanBeCorrected, recipientStatusLabel } from "@/lib/contracts/docusign/status";
import type { EnvelopeAuditEvent, EnvelopeView, FixedPosition, RecipientInput, RecipientStatusView, RecipientType, SignerPlacement } from "@/lib/contracts/docusign/types";
import { resolvePlaceholders, usesPlaceholder, type PlaceholderValues } from "@/lib/contracts/docusign/validation";

/**
 * Envelopes for Salesforce Contracts. DocuSign is the system of record for envelopes: each one carries two hidden envelope custom
 * fields — the Salesforce Contract Id and the Salesforce org — and is always looked up live, so there is no local copy to drift.
 * Every read of a single envelope re-checks those fields: an envelope of another contract/org is treated as not found.
 */

export const CONTRACT_FIELD = "OmniCloudContractId";
export const ORG_FIELD = "OmniCloudOrg";

/** The org key stored on envelopes: the Salesforce instance host (no secrets). */
export const orgKeyOf = (instanceUrl: string) => new URL(instanceUrl).host.toLowerCase();

export interface EnvelopeDocumentInput { title: string; fileExtension: string; base64: string }

/* ── Signature fields ── */

/** Preset spots (DocuSign pixels at 72 dpi, origin top-left), sized to sit in the lower part of a Letter/A4 page. */
const FIXED_X: Record<FixedPosition, number> = { "bottom-left": 72, "bottom-center": 220, "bottom-right": 370 };
const FIXED_Y = 640;

type Tab = Record<string, string>;

function anchorTab(text: string, x: number, y: number, extra: Tab = {}): Tab {
  return { anchorString: text, anchorUnits: "pixels", anchorXOffset: String(x), anchorYOffset: String(y), anchorIgnoreIfNotPresent: "false", anchorCaseSensitive: "false", ...extra };
}

function fixedTab(page: number, x: number, y: number, extra: Tab = {}): Tab {
  return { documentId: "1", pageNumber: String(page), xPosition: String(x), yPosition: String(y), ...extra };
}

/**
 * Tabs for one signer. "free" sends no tabs: DocuSign then lets the signer drag their own signature onto the document (free-form
 * signing). "anchor" places fields relative to text found in ANY document of the envelope; DocuSign rejects the send if the text
 * isn't there (anchorIgnoreIfNotPresent=false), so a signer never receives a document without their signature field.
 */
export function signerTabs(p: SignerPlacement): Record<string, Tab[]> | undefined {
  if (p.mode === "free") return undefined;
  const tabs: Record<string, Tab[]> = {};
  if (p.mode === "anchor") {
    const a = p.anchorText!.trim();
    tabs.signHereTabs = [anchorTab(a, 0, -34)];
    if (p.includeDate) tabs.dateSignedTabs = [anchorTab(a, 150, -4)];
    if (p.includeName) tabs.fullNameTabs = [anchorTab(a, 0, 18)];
    if (p.includeInitials) tabs.initialHereTabs = [anchorTab(a, 230, -34)];
  } else {
    const x = FIXED_X[p.position!];
    tabs.signHereTabs = [fixedTab(p.page!, x, FIXED_Y)];
    if (p.includeDate) tabs.dateSignedTabs = [fixedTab(p.page!, x, FIXED_Y + 52)];
    if (p.includeName) tabs.fullNameTabs = [fixedTab(p.page!, x, FIXED_Y + 72)];
    if (p.includeInitials) tabs.initialHereTabs = [fixedTab(p.page!, x + 170, FIXED_Y)];
  }
  return tabs;
}

/* ── Envelope definition (pure) ── */

export interface EnvelopeDefinitionInput {
  contractId: string;
  orgKey: string;
  documents: EnvelopeDocumentInput[];
  recipients: RecipientInput[];
  emailSubject: string;
  emailMessage: string;
  placeholders: Omit<PlaceholderValues, "RecipientName">;
}

const COLLECTION: Record<RecipientType, "signers" | "carbonCopies" | "certifiedDeliveries"> = { signer: "signers", cc: "carbonCopies", viewer: "certifiedDeliveries" };

export function buildEnvelopeDefinition(i: EnvelopeDefinitionInput): Record<string, unknown> {
  const personal = usesPlaceholder(i.emailSubject, "RecipientName") || usesPlaceholder(i.emailMessage, "RecipientName");
  const recipients: Record<string, Record<string, unknown>[]> = { signers: [], carbonCopies: [], certifiedDeliveries: [] };
  i.recipients.forEach((r, idx) => {
    const entry: Record<string, unknown> = { recipientId: String(idx + 1), routingOrder: String(r.order), name: r.name.trim(), email: r.email.trim() };
    if (r.note?.trim()) entry.note = r.note.trim();
    if (personal) {
      const values = { ...i.placeholders, RecipientName: r.name.trim() };
      entry.emailNotification = { emailSubject: resolvePlaceholders(i.emailSubject, values), emailBody: resolvePlaceholders(i.emailMessage, values), supportedLanguage: "en" };
    }
    if (r.type === "signer" && r.placement) {
      const tabs = signerTabs(r.placement);
      if (tabs) entry.tabs = tabs;
    }
    recipients[COLLECTION[r.type]].push(entry);
  });
  const generic = { ...i.placeholders, RecipientName: "" };
  return {
    emailSubject: resolvePlaceholders(i.emailSubject, generic).replace(/\s{2,}/g, " ").trim(),
    emailBlurb: resolvePlaceholders(i.emailMessage, generic),
    documents: i.documents.map((d, idx) => ({
      documentId: String(idx + 1),
      name: d.title.toLowerCase().endsWith(`.${d.fileExtension.toLowerCase()}`) ? d.title : `${d.title}.${d.fileExtension.toLowerCase()}`,
      fileExtension: d.fileExtension.toLowerCase(),
      documentBase64: d.base64,
    })),
    recipients,
    customFields: {
      textCustomFields: [
        { name: CONTRACT_FIELD, value: i.contractId, show: "false", required: "false" },
        { name: ORG_FIELD, value: i.orgKey, show: "false", required: "false" },
      ],
    },
    status: "sent",
  };
}

export interface CreatedEnvelope { envelopeId: string; status: string; statusDateTime: string | null; uri: string | null }

/** Creates AND sends the envelope. Returns DocuSign's own response; throws unless DocuSign returned an envelope Id. */
export async function createEnvelope(api: DocuSignApi, definition: Record<string, unknown>): Promise<CreatedEnvelope> {
  const res = await api.json<Record<string, unknown>>("POST", "/envelopes", definition);
  if (typeof res.envelopeId !== "string" || !res.envelopeId) throw new DocuSignApiError("DocuSign didn't return an envelope Id, so the envelope was not confirmed as sent.", 502, "NO_ENVELOPE_ID", res);
  return { envelopeId: res.envelopeId, status: String(res.status ?? ""), statusDateTime: typeof res.statusDateTime === "string" ? res.statusDateTime : null, uri: typeof res.uri === "string" ? res.uri : null };
}

/* ── Reading envelopes ── */

type Raw = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" && v ? v : null);

function customFieldValue(raw: Raw, name: string): string | null {
  const cf = raw.customFields as { textCustomFields?: { name?: string; value?: string }[] } | undefined;
  return cf?.textCustomFields?.find(f => f.name === name)?.value ?? null;
}

export function belongsTo(raw: Raw, contractId: string, orgKey: string): boolean {
  return customFieldValue(raw, CONTRACT_FIELD) === contractId && customFieldValue(raw, ORG_FIELD) === orgKey;
}

async function withCustomFields(api: DocuSignApi, raw: Raw): Promise<Raw> {
  if (raw.customFields) return raw;
  const id = s(raw.envelopeId);
  if (!id) return raw;
  const customFields = await api.json<Raw>("GET", `/envelopes/${encodeURIComponent(id)}/custom_fields`).catch(() => null);
  return customFields ? { ...raw, customFields } : raw;
}

function recipientViews(raw: Raw): RecipientStatusView[] {
  const r = (raw.recipients ?? {}) as Record<string, Raw[] | undefined>;
  const pick = (list: Raw[] | undefined, type: RecipientType) => (list ?? []).map(x => ({
    recipientId: String(x.recipientId ?? ""),
    name: s(x.name) ?? "",
    email: s(x.email) ?? "",
    type,
    routingOrder: Number(x.routingOrder) || 1,
    status: s(x.status) ?? "created",
    statusLabel: recipientStatusLabel(s(x.status)),
    sentDateTime: s(x.sentDateTime),
    deliveredDateTime: s(x.deliveredDateTime),
    signedDateTime: s(x.signedDateTime),
    declinedReason: s(x.declinedReason),
    canCorrect: recipientCanBeCorrected(s(x.status)),
  }));
  return [...pick(r.signers, "signer"), ...pick(r.certifiedDeliveries, "viewer"), ...pick(r.carbonCopies, "cc")].sort((a, b) => a.routingOrder - b.routingOrder);
}

export function toEnvelopeView(raw: Raw): EnvelopeView {
  const status = s(raw.status) ?? "unknown";
  const voidedReason = s(raw.voidedReason);
  const { label, tone } = envelopeStatusView(status, voidedReason);
  const docs = ((raw.envelopeDocuments ?? raw.documents ?? []) as Raw[])
    .filter(d => (s(d.type) ?? "content") === "content" && s(d.documentId) !== "certificate")
    .map(d => ({ documentId: String(d.documentId), name: s(d.name) ?? `Document ${d.documentId}` }));
  const recipients = recipientViews(raw);
  const signers = recipients.filter(r => r.type === "signer");
  const inFlightOrDone = recipients.map(r => ({ ...r, canCorrect: r.canCorrect && allowedEnvelopeActions(status).includes("correct") }));
  return {
    envelopeId: String(raw.envelopeId),
    status,
    statusLabel: label,
    statusTone: tone,
    emailSubject: s(raw.emailSubject),
    sentDateTime: s(raw.sentDateTime),
    lastModifiedDateTime: s(raw.lastModifiedDateTime) ?? s(raw.statusChangedDateTime),
    completedDateTime: s(raw.completedDateTime),
    voidedReason,
    recipients: inFlightOrDone,
    documents: docs,
    signedCount: signers.filter(r => ["signed", "completed"].includes(r.status.toLowerCase())).length,
    signerCount: signers.length,
    allowedActions: allowedEnvelopeActions(status),
  };
}

/** Envelopes sent for this Contract from this Salesforce org (newest change first). */
export async function listContractEnvelopes(api: DocuSignApi, contractId: string, orgKey: string): Promise<EnvelopeView[]> {
  const q = new URLSearchParams({
    from_date: "2015-01-01T00:00:00Z",
    custom_field: `${CONTRACT_FIELD}=${contractId}`,
    include: "recipients,documents,custom_fields",
    order_by: "last_modified",
    order: "desc",
    count: "100",
  });
  const res = await api.json<{ envelopes?: Raw[] }>("GET", `/envelopes?${q.toString()}`);
  const rows = await Promise.all((res.envelopes ?? []).slice(0, 100).map(e => withCustomFields(api, e)));
  return rows.filter(e => belongsTo(e, contractId, orgKey)).map(toEnvelopeView);
}

export class EnvelopeNotFoundError extends Error {}

/** One envelope with recipients and documents — only if it belongs to this Contract and org. */
export async function getContractEnvelope(api: DocuSignApi, envelopeId: string, contractId: string, orgKey: string): Promise<{ view: EnvelopeView; raw: Raw }> {
  let raw: Raw;
  try {
    raw = await api.json<Raw>("GET", `/envelopes/${encodeURIComponent(envelopeId)}?include=recipients,documents,custom_fields`);
  } catch (e) {
    if (e instanceof DocuSignApiError && (e.status === 404 || e.errorCode === "ENVELOPE_DOES_NOT_EXIST")) throw new EnvelopeNotFoundError("Envelope not found.");
    throw e;
  }
  raw = await withCustomFields(api, raw);
  if (!belongsTo(raw, contractId, orgKey)) throw new EnvelopeNotFoundError("Envelope not found for this contract.");
  return { view: toEnvelopeView(raw), raw };
}

export async function getAuditEvents(api: DocuSignApi, envelopeId: string): Promise<EnvelopeAuditEvent[]> {
  const res = await api.json<{ auditEvents?: { eventFields?: { name?: string; value?: string }[] }[] }>("GET", `/envelopes/${encodeURIComponent(envelopeId)}/audit_events`);
  return (res.auditEvents ?? []).map(ev => {
    const f = (n: string) => ev.eventFields?.find(x => x.name === n)?.value ?? null;
    return { at: f("logTime"), action: f("Action") ?? "Event", user: f("UserName"), detail: f("Message") };
  });
}

export const resendEnvelope = (api: DocuSignApi, envelopeId: string) =>
  api.json("PUT", `/envelopes/${encodeURIComponent(envelopeId)}?resend_envelope=true`, {});

export const voidEnvelope = (api: DocuSignApi, envelopeId: string, reason: string) =>
  api.json("PUT", `/envelopes/${encodeURIComponent(envelopeId)}`, { status: "voided", voidedReason: reason });

/** Corrects one recipient's name/email and resends to them. */
export function correctRecipient(api: DocuSignApi, envelopeId: string, recipient: { recipientId: string; type: RecipientType; name: string; email: string }) {
  return api.json("PUT", `/envelopes/${encodeURIComponent(envelopeId)}/recipients?resend_envelope=true`, {
    [COLLECTION[recipient.type]]: [{ recipientId: recipient.recipientId, name: recipient.name.trim(), email: recipient.email.trim() }],
  });
}

/** The envelope's signable documents (excludes DocuSign's summary/certificate entries). */
export async function listEnvelopeDocuments(api: DocuSignApi, envelopeId: string): Promise<{ documentId: string; name: string }[]> {
  const res = await api.json<{ envelopeDocuments?: Raw[] }>("GET", `/envelopes/${encodeURIComponent(envelopeId)}/documents`);
  return (res.envelopeDocuments ?? []).filter(d => (s(d.type) ?? "content") === "content" && s(d.documentId) !== "certificate").map(d => ({ documentId: String(d.documentId), name: s(d.name) ?? `Document ${d.documentId}` }));
}

export const downloadSignedDocument = (api: DocuSignApi, envelopeId: string, documentId: string) =>
  api.binary(`/envelopes/${encodeURIComponent(envelopeId)}/documents/${encodeURIComponent(documentId)}`);

/** All signed documents merged into one PDF (without the certificate). */
export const downloadCombinedSigned = (api: DocuSignApi, envelopeId: string) =>
  api.binary(`/envelopes/${encodeURIComponent(envelopeId)}/documents/combined?certificate=false`);

export const downloadCertificate = (api: DocuSignApi, envelopeId: string) =>
  api.binary(`/envelopes/${encodeURIComponent(envelopeId)}/documents/certificate`);
