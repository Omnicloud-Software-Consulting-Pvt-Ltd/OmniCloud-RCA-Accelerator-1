/**
 * DocuSign eSignature integration — shared types (server + client safe; no secrets in any type the browser receives).
 *
 * DocuSign envelopes are NOT Salesforce Contracts, invoices or payments: an envelope is only the signing package for documents
 * generated on a Contract. Nothing here touches Revenue Cloud Billing.
 */

export type DocuSignEnvironment = "demo" | "production";

export const ENVIRONMENT_LABEL: Record<DocuSignEnvironment, string> = { demo: "Demo / Sandbox", production: "Production" };

/** What the Settings page shows. Derived on the server; never contains credentials. */
export type ConnectionStatus = "setup_required" | "not_connected" | "connected" | "expired" | "error" | "reauthorization_required";

/** Server-only: the encrypted connection cookie's payload. Never serialized to a response. */
export interface StoredConnection {
  v: 1;
  environment: DocuSignEnvironment;
  integrationKey: string;
  secretKey: string;
  refreshToken: string;
  accountId: string;
  accountName: string | null;
  baseUri: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  /** Digest of the Salesforce session this connection was created in — a connection is only usable from that session. */
  binding: string;
  connectedAt: string;
  lastVerifiedAt: string | null;
}

/** Server-only: the encrypted access-token cookie's payload. */
export interface StoredAccessToken { v: 1; token: string; expiresAt: number; binding: string }

/** Server-only: the short-lived encrypted cookie that carries OAuth state + PKCE verifier between "Connect" and the callback. */
export interface PendingAuthorization {
  v: 1;
  state: string;
  codeVerifier: string;
  environment: DocuSignEnvironment;
  integrationKey: string;
  secretKey: string;
  accountId: string | null;
  redirectUri: string;
  binding: string;
  createdAt: number;
}

/** The browser-safe view of a connection. */
export interface PublicConnection {
  environment: DocuSignEnvironment;
  accountId: string;
  accountName: string | null;
  baseUri: string;
  userName: string | null;
  userEmail: string | null;
  integrationKeyHint: string;
  connectedAt: string;
  lastVerifiedAt: string | null;
}

export interface ConnectionStatusResponse {
  status: ConnectionStatus;
  /** False when the server has no valid DOCUSIGN_ENCRYPTION_KEY — the feature is disabled rather than storing credentials unencrypted. */
  encryptionReady: boolean;
  /** Server security state (never the key itself). */
  serverSetup: ServerSetupView;
  /** The exact Redirect URI to register on the DocuSign Integration Key (server-derived, never client-supplied). */
  redirectUri: string;
  connection: PublicConnection | null;
  message: string | null;
}

/**
 * Whether the server can store DocuSign credentials securely. Users only ever learn configured / not configured — server security is
 * the OmniCloud deployment administrator's job (docs/DOCUSIGN_SERVER_SETUP.md), never the user's.
 */
export interface ServerSetupView {
  configured: boolean;
  /** Why secure storage is unavailable (null when configured). Never the key or how to create one. */
  reason: "missing" | "invalid" | null;
}

/** What users see when the server can't store credentials securely — the actual reason, and who to contact. No setup steps. */
export const SERVER_SECURITY_TEXT = {
  unavailable: "DocuSign connection is temporarily unavailable. Please contact your OmniCloud administrator.",
  missing: "DocuSign connection is temporarily unavailable: the OmniCloud server's credential encryption key is not configured. Please contact your OmniCloud administrator.",
  invalid: "DocuSign connection is temporarily unavailable: the OmniCloud server's credential encryption key is configured but not valid. Please contact your OmniCloud administrator.",
} as const;

export const serverSecurityMessage = (reason: ServerSetupView["reason"]) => (reason === "invalid" ? SERVER_SECURITY_TEXT.invalid : reason === "missing" ? SERVER_SECURITY_TEXT.missing : SERVER_SECURITY_TEXT.unavailable);

export interface VerificationCheck { id: "oauth" | "token" | "identity" | "account" | "baseUri" | "esignature"; label: string; ok: boolean; detail: string }

/* ── Sending ── */

export type RecipientType = "signer" | "cc" | "viewer";
export const RECIPIENT_TYPE_LABEL: Record<RecipientType, string> = { signer: "Signer", cc: "Receives a copy (CC)", viewer: "Needs to view" };

export type PlacementMode = "anchor" | "fixed" | "free";
export type FixedPosition = "bottom-left" | "bottom-center" | "bottom-right";

export interface SignerPlacement {
  mode: PlacementMode;
  /** mode "anchor": the text in the document the signature is placed next to (e.g. "Customer Signed Date:"). */
  anchorText?: string;
  /** mode "fixed": 1-based page and a preset spot on it. */
  page?: number;
  position?: FixedPosition;
  includeDate: boolean;
  includeName: boolean;
  includeInitials: boolean;
}

export interface RecipientInput {
  /** Client-side key only. */
  key: string;
  name: string;
  email: string;
  type: RecipientType;
  /** Free-text label shown to the sender, e.g. "Customer" or "Company representative". */
  role: string;
  /** 1-based routing order: recipients with the same number receive it at the same time. */
  order: number;
  /** Optional private message shown only to this recipient. */
  note?: string;
  /** Signers only. */
  placement?: SignerPlacement;
}

export interface SendEnvelopeRequest {
  /** Salesforce ContentVersion Ids, in the order they should appear in the envelope. */
  documentIds: string[];
  recipients: RecipientInput[];
  emailSubject: string;
  emailMessage: string;
  /** Display value for {{CompanyName}} (from the user's company settings). */
  companyName?: string;
}

export interface SignableDocument {
  contentVersionId: string;
  contentDocumentId: string;
  title: string;
  fileExtension: string;
  sizeBytes: number;
  createdDate: string;
  versionNumber: number | null;
  compatible: boolean;
  incompatibleReason: string | null;
}

/* ── Tracking ── */

export interface RecipientStatusView {
  recipientId: string;
  name: string;
  email: string;
  type: RecipientType;
  routingOrder: number;
  status: string;
  statusLabel: string;
  sentDateTime: string | null;
  deliveredDateTime: string | null;
  signedDateTime: string | null;
  declinedReason: string | null;
  /** Correcting is allowed only for recipients who haven't finished. */
  canCorrect: boolean;
}

export interface EnvelopeDocumentView { documentId: string; name: string }

export type EnvelopeAction = "resend" | "void" | "correct" | "download-signed" | "download-certificate" | "store";

export interface EnvelopeView {
  envelopeId: string;
  status: string;
  statusLabel: string;
  statusTone: "neutral" | "progress" | "success" | "danger";
  emailSubject: string | null;
  sentDateTime: string | null;
  lastModifiedDateTime: string | null;
  completedDateTime: string | null;
  voidedReason: string | null;
  recipients: RecipientStatusView[];
  documents: EnvelopeDocumentView[];
  signedCount: number;
  signerCount: number;
  allowedActions: EnvelopeAction[];
}

export interface EnvelopeAuditEvent { at: string | null; action: string; user: string | null; detail: string | null }

export interface StoredSignedFile { kind: "signed" | "certificate"; envelopeId: string; documentId: string | null; contentVersionId: string; title: string; alreadyStored: boolean }
