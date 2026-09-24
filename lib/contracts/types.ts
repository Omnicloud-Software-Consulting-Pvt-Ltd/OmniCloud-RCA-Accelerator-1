/**
 * Shared domain types for the Contract / document-generation / e-signature
 * module — the Contract-side counterpart of lib/orders/types.ts and
 * lib/quotes/types.ts. Reuses genuinely object-agnostic Quote/Order types
 * (FieldRef, PicklistFieldRef, ReferenceLookupResult, BundleHierarchyStep)
 * directly; only defines new shapes for what's genuinely Contract-specific:
 * the Contract field schema/activation lifecycle, and the document
 * generation / DocuSign e-signature subsystems that Quote/Order don't have.
 */

import type { FieldRef } from "@/lib/salesforce/describe";
import type { PicklistFieldRef, ReferenceLookupResult, BundleHierarchyStep } from "@/lib/quotes/types";

export type { FieldRef } from "@/lib/salesforce/describe";
export type { PicklistFieldRef, ReferenceLookupResult } from "@/lib/quotes/types";

/* ── Contract field schema (§2.1, §3.4) ── */

export interface ContractFieldSchema {
  accountField: FieldRef | null;
  pricebookField: FieldRef | null;
  /** Only populated if this org's schema happens to expose a Name-like field — standard Contract has none (§3.2). */
  nameField: FieldRef | null;
  statusField: PicklistFieldRef | null;
  /** Custom field, only present if this org added it (§2.3) — never a hardcoded picklist. */
  contractTypeField: PicklistFieldRef | null;
  startDateField: FieldRef | null;
  /** §2.1: resolved via accessible-only check; `calculated: true` on virtually every org (formula field) — payload builder must never write it when calculated. */
  endDateField: (FieldRef & { calculated: boolean }) | null;
  contractTermField: FieldRef | null;
  companySignedByField: FieldRef | null;
  companySignedDateField: FieldRef | null;
  customerSignedByField: FieldRef | null;
  customerSignedTitleField: FieldRef | null;
  customerSignedDateField: FieldRef | null;
  descriptionField: FieldRef | null;
  /** §2.1: resolved name-first (ContractNumber can't be renamed), falling back to label match only if that somehow fails. */
  contractNumberField: FieldRef | null;
  /** §2.2: display-only, never offered as an editable creation-time field. */
  recordTypeIdField: FieldRef | null;
  /** Every field this org's describe marks updateable, independent of createable — drives the workspace's edit-mode field gating (§3.4). */
  updateableApiNames: string[];
}

export interface ContractListFieldSchema {
  contractNumberField: FieldRef | null;
  startDateField: FieldRef | null;
  endDateField: FieldRef | null;
  accountRelationshipField: FieldRef | null;
}

/* ── Contract activation lifecycle (§3.6 Option B — decided with the user) ── */

export interface ContractStatusResolution {
  statusField: PicklistFieldRef | null;
  /** The org's own value semantically matching "not yet activated" — never the hardcoded literal "Draft". */
  draftValue: string | null;
  /** The org's own value semantically matching "activated" — never the hardcoded literal "Activated". */
  activatedValue: string | null;
  /** Present only if the org's active values suggest an "expired" transition exists. */
  expiredValue: string | null;
}

export type ContractMutabilityStatus = "mutable" | "blocked" | "inconclusive";

export interface ContractMutabilityCheck {
  status: ContractMutabilityStatus;
  currentStatus: string | null;
  reason: string;
}

export interface ContractActivationResult {
  success: boolean;
  attemptedTransition: { from: string | null; to: string } | null;
  message: string;
  /** The org's own rejection text when Salesforce refuses the transition — never a guessed alternate mechanism. */
  salesforceError: string | null;
}

export type ContractActivationAction = "activate" | "expire" | "draft";

/* ── Contract CRUD (§3.2, §3.5, §3.7) ── */

export interface ContractFormData {
  accountName: string;
  pricebookName: string;
  status: string;
  contractType: string;
  startDate: string;
  contractTerm: string;
  companySignedByName: string;
  companySignedDate: string;
  /** Set ONLY from a real Contact search-result click (§3.3) — never accepted from typed text alone. */
  customerSignedById: string;
  /** Display text only — never sent to the create payload directly. */
  customerSignedByName: string;
  customerSignedTitle: string;
  customerSignedDate: string;
  description: string;
}

export interface ContractCreateResult {
  id: string;
  contractNumber: string | null;
  resolvedLookups: {
    account: ReferenceLookupResult | null;
    pricebook: ReferenceLookupResult | null;
    companySignedBy: ReferenceLookupResult | null;
    customerSignedBy: ReferenceLookupResult | null;
  };
  payload: Record<string, unknown>;
  steps: BundleHierarchyStep[];
  warnings: string[];
}

export interface ContractListItem {
  id: string;
  contractNumber: string | null;
  status: string | null;
  accountName: string | null;
  startDate: string | null;
  endDate: string | null;
  lastModifiedDate: string;
}

export interface ContractDetail {
  id: string;
  contractNumber: string | null;
  record: Record<string, unknown>;
  accountId: string | null;
  pricebookId: string | null;
  status: string | null;
  mutability: ContractMutabilityCheck;
  updateableApiNames: string[];
}

/* ── Dedicated Account-scoped Contact lookup (§3.3) — deliberately not shared with any other module's Contact lookup. ── */

export interface ContractContact {
  id: string;
  name: string;
  accountId: string | null;
}

/* ── Document generation (§4) ── */

export interface MergeFieldValues {
  AccountName: string;
  ContractNumber: string;
  ContractStartDate: string;
  ContractEndDate: string;
  ContractTerm: string;
  Status: string;
  Owner: string;
  CompanySignedDate: string;
  CustomerSignedDate: string;
  Description: string;
  /* ── Template Studio merge vocabulary — additive, alongside the original tokens above so existing template bodies keep resolving. ── */
  CompanyName: string;
  CustomerName: string;
  StartDate: string;
  EndDate: string;
  AuthorizedSigner: string;
  /** Best-effort via an Order linked to this Contract and its Source Quote, if this org's schema resolves that chain — "—" when it doesn't, never fabricated. */
  QuoteNumber: string;
  Products: string;
  GrandTotal: string;
  BillingFrequency: string;
  /** No standard Contract/Order field carries this in any org observed so far — always "—" unless a future org-specific mapping is added; never invented. */
  PaymentTerms: string;
}

export type PdfFontChoice = "Helvetica" | "Times-Roman" | "Courier";

export type LogoPosition = "left" | "center" | "right";
export type PageSize = "A4" | "Letter" | "Legal";
export type PageOrientation = "portrait" | "landscape";
export type TextAlignment = "left" | "center" | "right";
export type FooterElementKey = "confidential" | "companyAddress" | "pageNumber" | "generatedDate" | "version" | "copyright";
export type SignatureFieldType = "customerSignature" | "companySignature" | "salesRepresentative" | "legalRepresentative" | "dateSigned" | "witness";

export interface PageMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** One draggable-orderable signature block in the Design Panel's Signature Section. */
export interface SignatureBlockConfig {
  id: string;
  type: SignatureFieldType;
  label: string;
  required: boolean;
  /** 1-based signing order — also the drag-reorder position. */
  order: number;
  width: number;
  height: number;
  alignment: TextAlignment;
  border: boolean;
}

/**
 * Every visual knob the Design Panel exposes (§Right Sidebar). Deliberately
 * ONE JSONB-backed config carried on `branding` rather than a parallel
 * column — Postgres JSONB is schemaless, so new fields degrade cleanly for
 * rows saved before this existed (merged onto DEFAULT_BRANDING at read time,
 * exactly like the original 7-field BrandingConfig already did).
 */
export interface BrandingConfig {
  companyName: string;
  logoUrl: string | null;
  primaryColor: string;
  /** PDF-engine font — @react-pdf/renderer only ships these 3 without embedding a custom font file. */
  font: PdfFontChoice;
  footerText: string;
  termsText: string;
  signatureBlockText: string;

  // Company Branding — logo sizing/position (editor/HTML preview; PDF renderer clamps to its own page geometry).
  logoWidth: number;
  logoHeight: number;
  logoMaintainAspectRatio: boolean;
  logoPosition: LogoPosition;
  headerMargin: number;
  footerMargin: number;

  // Typography — free-form for the on-screen/HTML editor and preview (the browser can render any font-family).
  fontFamily: string;
  fontSize: number;
  headingFont: string;
  paragraphFont: string;
  lineHeight: number;
  letterSpacing: number;
  textColor: string;
  pageBackground: string;

  // Page Layout
  pageSize: PageSize;
  orientation: PageOrientation;
  pageMargins: PageMargins;
  headerHeight: number;
  footerHeight: number;

  // Footer — which elements are enabled, in display order.
  footerElements: FooterElementKey[];

  // Signature Section
  signatureBlocks: SignatureBlockConfig[];
}

/**
 * A template in the Documents library — either one of the bundled built-in
 * defs (lib/contracts/documents/builtinTemplates.ts, read-only) or a
 * "My Templates" entry a user created, all stored client-side in the
 * browser's localStorage (lib/contracts/documents/localTemplateStore.ts).
 * No server/database concept of this record exists — `id`/`createdAt`/etc.
 * are purely local bookkeeping. Kept shaped so a future swap to a real
 * per-org backend only has to change localTemplateStore's internals, never
 * this type or any of its callers.
 */
export interface ContractTemplate {
  id: string;
  name: string;
  /** Built-ins are immutable — never editable/deletable, only duplicable into an editable custom copy. */
  isBuiltin: boolean;
  bodyHtml: string;
  uploadFilename: string | null;
  uploadMime: string | null;
  hasUpload: boolean;
  branding: BrandingConfig;
  /** HTML tags in bodyHtml beyond the PDF converter's recognized set (§4.3) — surfaced as a visible warning in the customization UI, never silently hidden. */
  unrecognizedTags: string[];
  createdAt: string;
  updatedAt: string;
  /** Bumped on every save — a simple counter, not a snapshot history (no version-restore feature in the localStorage-only design). */
  version: number;
  description: string;
  isDefault: boolean;
  createdBy: string | null;
}

/** Company profile — auto-populates {{CompanyName}} and the document header; stored client-side in localStorage alongside templates, never a server concept. */
export interface CompanySettings {
  companyName: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  taxNumber: string;
  registrationNumber: string;
  logoUrl: string | null;
}

export interface GeneratedDocument {
  contentVersionId: string;
  contentDocumentId: string;
  versionNumber: number | null;
  title: string;
  templateName: string | null;
  createdDate: string;
  createdByName: string | null;
  isLatest: boolean;
}

/* ── E-signature (§5) ── */

export interface SignatureRecipient {
  name: string;
  email: string;
  role: string;
  /** 1-based, used as DocuSign's routingOrder (§5.2). */
  order: number;
  /** This recipient's own DocuSign-reported status, once known — null until the envelope is sent. */
  status: string | null;
}

export type SignatureStage =
  | "Draft" | "Ready to Send" | "Sent" | "Viewed" | "Customer Signed" | "Company Signed" | "Completed";

export interface SignatureTimelineEntry {
  stage: SignatureStage;
  at: string;
  detail: string | null;
  source: "docusign-webhook" | "system";
  /** Used to deduplicate DocuSign Connect's at-least-once delivery (§5.4) — never write a second entry for the same key. */
  dedupeKey: string;
}

export interface SignatureRequest {
  id: string;
  contractId: string;
  sourceContentVersionId: string | null;
  sourceDocumentName: string | null;
  status: SignatureStage;
  recipients: SignatureRecipient[];
  timeline: SignatureTimelineEntry[];
  /** Null until the user overrides the default template — see lib/contracts/docusign/emailPreview.ts's DEFAULT_EMAIL_SUBJECT/BODY. */
  emailSubject: string | null;
  emailBody: string | null;
  envelopeId: string | null;
  envelopeStatus: string | null;
  /** DocuSign's own "sent at" timestamp from the create-and-send response — null until sent, never our own clock's guess. */
  sentDateTime: string | null;
  signedContentVersionId: string | null;
  /** The connected DocuSign account/user this envelope was actually sent as (from the send route's response, itself sourced from the org's saved OAuth /oauth/userinfo capture) — null until sent, never a recipient's identity. */
  senderName: string | null;
  senderEmail: string | null;
  senderUserId: string | null;
  /** Whether the sender was also added as a non-signing "receives a copy" recipient on this envelope, so they get their own copy/notification — null until sent. */
  senderCopyRequested: boolean | null;
  createdAt: string;
  updatedAt: string;
}

/** One DocuSign Connect event, already mapped to this app's vocabulary (§5.4) — shared between the webhook mapper and the signature store so neither needs to import the other. */
export interface WebhookMappedUpdate {
  recipientEmail: string | null;
  recipientStatus: string | null;
  newStage: SignatureStage | null;
  /** Used to deduplicate DocuSign Connect's at-least-once delivery — same key as the timeline entry it produces. */
  dedupeKey: string;
  detail: string;
}

export type DocuSignConnectionStatus = "disconnected" | "connected" | "reauthorization_required" | "error";

export interface DocuSignConnectionConfig {
  orgId: string;
  environment: "demo" | "production";
  clientId: string;
  hasClientSecret: boolean;
  hasWebhookSecret: boolean;
  /** Org's saved OAuth redirect_uri override, or null to use the DOCUSIGN_REDIRECT_URI env var / request origin fallback — see lib/contracts/docusign/redirectUri.ts. */
  callbackUrl: string | null;
  status: DocuSignConnectionStatus;
  lastError: string | null;
  docusignAccountId: string | null;
  docusignAccountName: string | null;
  baseUri: string | null;
  /** The DocuSign user whose OAuth grant this connection runs as — from the real /oauth/userinfo call, not guessed. */
  connectedUserName: string | null;
  connectedUserEmail: string | null;
  /** DocuSign's own `sub` (user ID) for the connected user — from the same /oauth/userinfo call. */
  connectedUserId: string | null;
  connectedAt: string | null;
}
