import type { FixedPosition, PlacementMode, RecipientInput, RecipientType, SendEnvelopeRequest, SignerPlacement } from "@/lib/contracts/docusign/types";

/**
 * Pure validation shared by the browser (instant feedback) and the server (the real gate — the server never trusts the browser's
 * result). No I/O.
 */

export const LIMITS = {
  recipients: 20,
  documents: 10,
  name: 100,
  email: 100,
  role: 50,
  note: 1000,
  subject: 100, // DocuSign's emailSubject limit
  message: 10000, // DocuSign's emailBlurb limit
  anchorText: 100,
  maxPage: 500,
  maxDocumentBytes: 25 * 1024 * 1024,
  maxEnvelopeBytes: 25 * 1024 * 1024,
  voidReason: 200,
} as const;

/** File types DocuSign accepts that the Contracts module can produce or store. */
export const SIGNABLE_EXTENSIONS = ["pdf", "docx", "doc", "rtf", "txt", "xlsx", "xls", "pptx", "ppt", "png", "jpg", "jpeg", "tif", "tiff"] as const;

export const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const RECIPIENT_TYPES: RecipientType[] = ["signer", "cc", "viewer"];
const MODES: PlacementMode[] = ["anchor", "fixed", "free"];
const POSITIONS: FixedPosition[] = ["bottom-left", "bottom-center", "bottom-right"];

export const isValidEmail = (v: string) => v.length <= LIMITS.email && EMAIL.test(v);

/* ── Placeholders: a fixed allowlist, replaced as plain text. No expressions, no server-side template execution. ── */

export const PLACEHOLDERS = ["ContractName", "ContractNumber", "CompanyName", "RecipientName", "AccountName"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type PlaceholderValues = Partial<Record<Placeholder, string | null | undefined>>;

const TOKEN = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

export function unknownPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TOKEN)) if (!(PLACEHOLDERS as readonly string[]).includes(m[1])) out.add(m[1]);
  return [...out];
}

export const usesPlaceholder = (text: string, name: Placeholder) => [...text.matchAll(TOKEN)].some(m => m[1] === name);

/** Replaces known tokens with their (single-line, trimmed) values; unknown tokens are left as-is for validation to report. */
export function resolvePlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(TOKEN, (whole, name: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) return whole;
    const v = values[name as Placeholder];
    return (v ?? "").replace(/[\r\n]+/g, " ").trim();
  });
}

/* ── Issues ── */

export interface ValidationIssue { field: string; message: string }

function textIssues(field: string, label: string, value: unknown, max: number, required: boolean): ValidationIssue[] {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return required ? [{ field, message: `${label} is required.` }] : [];
  if (v.length > max) return [{ field, message: `${label} must be ${max} characters or fewer.` }];
  if (CONTROL.test(v)) return [{ field, message: `${label} contains characters that can't be used.` }];
  return [];
}

export function validatePlacement(p: SignerPlacement | undefined, field: string): ValidationIssue[] {
  if (!p || !MODES.includes(p.mode)) return [{ field, message: "Choose where this signer signs." }];
  if (p.mode === "anchor") return textIssues(`${field}.anchorText`, "The text to place the signature next to", p.anchorText, LIMITS.anchorText, true);
  if (p.mode === "fixed") {
    const issues: ValidationIssue[] = [];
    if (!Number.isInteger(p.page) || (p.page as number) < 1 || (p.page as number) > LIMITS.maxPage) issues.push({ field: `${field}.page`, message: `Page must be a whole number from 1 to ${LIMITS.maxPage}.` });
    if (!p.position || !POSITIONS.includes(p.position)) issues.push({ field: `${field}.position`, message: "Choose a position on the page." });
    return issues;
  }
  return [];
}

export function validateRecipients(recipients: RecipientInput[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(recipients) || recipients.length === 0) return [{ field: "recipients", message: "Add at least one recipient." }];
  if (recipients.length > LIMITS.recipients) issues.push({ field: "recipients", message: `You can add up to ${LIMITS.recipients} recipients.` });
  if (!recipients.some(r => r?.type === "signer")) issues.push({ field: "recipients", message: "Add at least one Signer — otherwise there is nothing to sign." });
  const seen = new Set<string>();
  recipients.forEach((r, i) => {
    const f = `recipients[${i}]`;
    const who = r?.name?.trim() || `Recipient ${i + 1}`;
    issues.push(...textIssues(`${f}.name`, `${who}: full name`, r?.name, LIMITS.name, true));
    if (typeof r?.name === "string" && /[<>]/.test(r.name)) issues.push({ field: `${f}.name`, message: `${who}: the name can't contain < or >.` });
    const email = typeof r?.email === "string" ? r.email.trim() : "";
    if (!email) issues.push({ field: `${f}.email`, message: `${who}: email address is required.` });
    else if (!isValidEmail(email)) issues.push({ field: `${f}.email`, message: `${who}: "${email}" isn't a valid email address.` });
    if (!RECIPIENT_TYPES.includes(r?.type)) issues.push({ field: `${f}.type`, message: `${who}: choose what this recipient does.` });
    issues.push(...textIssues(`${f}.role`, `${who}: role`, r?.role, LIMITS.role, false));
    if (!Number.isInteger(r?.order) || r.order < 1 || r.order > 99) issues.push({ field: `${f}.order`, message: `${who}: signing order must be a whole number from 1 to 99.` });
    issues.push(...textIssues(`${f}.note`, `${who}: private message`, r?.note, LIMITS.note, false));
    if (r?.type === "signer") issues.push(...validatePlacement(r.placement, `${f}.placement`));
    const key = `${r?.type}:${email.toLowerCase()}`;
    if (email && seen.has(key)) issues.push({ field: `${f}.email`, message: `${who}: ${email} is already added with the same role.` });
    seen.add(key);
  });
  return issues;
}

export function validateDocumentSelection(documentIds: string[]): ValidationIssue[] {
  if (!Array.isArray(documentIds) || documentIds.length === 0) return [{ field: "documentIds", message: "Select at least one document to send." }];
  const issues: ValidationIssue[] = [];
  if (documentIds.length > LIMITS.documents) issues.push({ field: "documentIds", message: `You can send up to ${LIMITS.documents} documents at once.` });
  if (documentIds.some(id => typeof id !== "string" || !SFID.test(id))) issues.push({ field: "documentIds", message: "One of the selected documents has an invalid Id." });
  if (new Set(documentIds).size !== documentIds.length) issues.push({ field: "documentIds", message: "The same document is selected twice." });
  return issues;
}

export function validateEmail(subject: string, message: string, values: PlaceholderValues): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const unknown = [...new Set([...unknownPlaceholders(subject ?? ""), ...unknownPlaceholders(message ?? "")])];
  if (unknown.length) issues.push({ field: "email", message: `Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${unknown.map(u => `{{${u}}}`).join(", ")}. Use only ${PLACEHOLDERS.map(p => `{{${p}}}`).join(", ")}.` });
  const resolvedSubject = resolvePlaceholders(subject ?? "", values).trim();
  if (!resolvedSubject) issues.push({ field: "emailSubject", message: "Email subject is required." });
  else if (resolvedSubject.length > LIMITS.subject) issues.push({ field: "emailSubject", message: `The email subject is ${resolvedSubject.length} characters after placeholders are filled in — DocuSign allows ${LIMITS.subject}.` });
  if ((resolvePlaceholders(message ?? "", values)).length > LIMITS.message) issues.push({ field: "emailMessage", message: `The email message must be ${LIMITS.message} characters or fewer.` });
  return issues;
}

export function validateSendRequest(req: SendEnvelopeRequest, values: PlaceholderValues): ValidationIssue[] {
  return [
    ...validateDocumentSelection(req.documentIds),
    ...validateRecipients(req.recipients),
    ...validateEmail(req.emailSubject, req.emailMessage, values),
    ...textIssues("companyName", "Company name", req.companyName, 120, false),
  ];
}

export function documentCompatibility(fileExtension: string | null | undefined, sizeBytes: number): { compatible: boolean; reason: string | null } {
  const ext = (fileExtension ?? "").toLowerCase();
  if (!(SIGNABLE_EXTENSIONS as readonly string[]).includes(ext)) return { compatible: false, reason: `DocuSign can't sign .${ext || "unknown"} files.` };
  if (sizeBytes > LIMITS.maxDocumentBytes) return { compatible: false, reason: "The file is larger than DocuSign's 25 MB limit." };
  return { compatible: true, reason: null };
}

/** Untrusted JSON → a SendEnvelopeRequest with only the expected fields (anything else is dropped). */
export function parseSendRequest(body: unknown): SendEnvelopeRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const recipients = Array.isArray(b.recipients) ? (b.recipients as Record<string, unknown>[]).slice(0, LIMITS.recipients + 1) : [];
  return {
    documentIds: Array.isArray(b.documentIds) ? b.documentIds.map(str) : [],
    emailSubject: str(b.emailSubject),
    emailMessage: str(b.emailMessage),
    companyName: str(b.companyName) || undefined,
    recipients: recipients.map((r, i) => {
      const p = (r?.placement && typeof r.placement === "object" ? r.placement : null) as Record<string, unknown> | null;
      return {
        key: str(r?.key) || String(i),
        name: str(r?.name).trim(),
        email: str(r?.email).trim(),
        type: str(r?.type) as RecipientType,
        role: str(r?.role).trim(),
        order: Number(r?.order),
        note: str(r?.note).trim() || undefined,
        placement: p ? {
          mode: str(p.mode) as PlacementMode,
          anchorText: str(p.anchorText).trim() || undefined,
          page: p.page === undefined ? undefined : Number(p.page),
          position: (str(p.position) || undefined) as FixedPosition | undefined,
          includeDate: p.includeDate === true,
          includeName: p.includeName === true,
          includeInitials: p.includeInitials === true,
        } : undefined,
      };
    }),
  };
}
