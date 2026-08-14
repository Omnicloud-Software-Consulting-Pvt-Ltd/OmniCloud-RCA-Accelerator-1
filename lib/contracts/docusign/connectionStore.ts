import type { DocuSignConnectionConfig, DocuSignConnectionStatus } from "@/lib/contracts/types";
import type { DocuSignEnvironment } from "@/lib/contracts/docusign/client";

/**
 * ============================================================================
 * TEMPORARY DEVELOPMENT STORAGE — NOT PRODUCTION-PERSISTENT.
 * ============================================================================
 * This application currently has no provisioned, tenant-scoped, durable
 * secret store (confirmed by investigation: no Postgres, no KV/Redis, no
 * cloud secrets manager, no Salesforce custom object/metadata mechanism —
 * see project memory for the full audit). Rather than fake persistence with
 * a local file (breaks under serverless/multi-instance deployment) or
 * reintroduce Postgres, DocuSign connection state is held ONLY in this
 * Node process's memory for now. It is lost on server restart, redeploy, or
 * a serverless cold start, and is NOT shared across multiple instances.
 * That is a known, accepted limitation of this development phase — not
 * something to hide or work around.
 *
 * Every DocuSign route/service talks ONLY to the `DocuSignConnectionStore`
 * interface below, never to `inMemoryStore` directly. Swapping in a real
 * persistent implementation later (Postgres, a managed KV/secrets manager,
 * etc. — whichever is chosen when that infrastructure is provisioned) means
 * writing one new class that implements this interface and changing the
 * single line that constructs `store` at the bottom of this file. No
 * route, no OAuth logic, no UI, and no other DocuSign/Contract/Signature
 * code needs to change for that swap.
 *
 * Tenant scoping: every operation is keyed by `orgId` — the connected
 * Salesforce org's `instanceUrl`, exactly as it's used everywhere else in
 * this app (Quote/Order/Contract routes). `orgId` always comes from the
 * server-derived Salesforce session (`requireSFClient` → `auth.client.instanceUrl`
 * in every calling route), never from a client-supplied value — this file
 * has no knowledge of HTTP requests at all, so there's no way for it to be
 * tricked into serving the wrong org's data from an untrusted parameter.
 *
 * No application-level encryption here (no more CONTRACT_ENCRYPTION_KEY):
 * with nothing written to disk/a database, there's nothing to encrypt "at
 * rest" — process memory is the only boundary, the same trust model as any
 * other in-memory variable in this app (e.g. lib/salesforce/cache.ts's
 * describe-metadata cache). Re-introduce field-level encryption when a real
 * persistent backend is chosen, if that backend doesn't already encrypt at
 * rest itself.
 *
 * IMPORTANT — why the singleton lives on `globalThis`, not a plain module
 * `const`: verified empirically (not assumed) that in this app's Next.js 16
 * + Turbopack dev server, separate API route files can each get their OWN
 * independent evaluation of this module — a plain `const store = new
 * InMemoryDocuSignConnectionStore()` at module scope produced a DIFFERENT
 * store instance (confirmed via instance-id logging) depending on which
 * route handler imported it, even within the SAME running process. That
 * meant a connection saved by one route (e.g. the OAuth callback) was
 * invisible to a different route (e.g. Send for Signature) even though
 * both "used the same store" in source code — this was the actual root
 * cause of Settings showing Connected while Send for Signature said
 * "DocuSign is not connected." Anchoring the instance on `globalThis`
 * (the true process-wide global, unaffected by which bundle/module-graph
 * a route was compiled into) fixes this — confirmed by the same
 * instance-id logging showing every route now resolves to the identical
 * store object.
 */

export interface DocuSignConnectionRecord {
  orgId: string;
  environment: DocuSignEnvironment;
  clientId: string;
  clientSecret: string;
  /** Optional — only needed for DocuSign Connect webhook HMAC verification, not implemented yet. Null, never a placeholder. */
  webhookSecret: string | null;
  /** Optional OAuth redirect_uri override for this org — null means fall back to DOCUSIGN_REDIRECT_URI / request origin. See lib/contracts/docusign/redirectUri.ts. */
  callbackUrl: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  docusignAccountId: string | null;
  docusignAccountName: string | null;
  baseUri: string | null;
  connectedUserName: string | null;
  connectedUserEmail: string | null;
  /** DocuSign's own `sub` from /oauth/userinfo — the connected user's DocuSign user ID, distinct from docusignAccountId (the ACCOUNT). Used to surface a real sender user ID for the "Sent by" record, never guessed. */
  connectedUserId: string | null;
  connectedAt: string | null;
  status: DocuSignConnectionStatus;
  lastError: string | null;
}

/** The swappable storage boundary — implement this against a real backend later; nothing else needs to change. */
export interface DocuSignConnectionStore {
  get(orgId: string): Promise<DocuSignConnectionRecord | null>;
  save(orgId: string, record: DocuSignConnectionRecord): Promise<void>;
  update(orgId: string, patch: Partial<DocuSignConnectionRecord>): Promise<DocuSignConnectionRecord | null>;
  delete(orgId: string): Promise<void>;
}

/** TEMPORARY implementation — see the file-level doc comment above. A plain Map, anchored on `globalThis` so it's the same instance across every route (see the `globalThis` note above for why that matters). */
class InMemoryDocuSignConnectionStore implements DocuSignConnectionStore {
  private records = new Map<string, DocuSignConnectionRecord>();

  async get(orgId: string): Promise<DocuSignConnectionRecord | null> {
    return this.records.get(orgId) ?? null;
  }

  async save(orgId: string, record: DocuSignConnectionRecord): Promise<void> {
    this.records.set(orgId, record);
  }

  async update(orgId: string, patch: Partial<DocuSignConnectionRecord>): Promise<DocuSignConnectionRecord | null> {
    const current = this.records.get(orgId);
    if (!current) return null;
    const updated: DocuSignConnectionRecord = { ...current, ...patch };
    this.records.set(orgId, updated);
    return updated;
  }

  async delete(orgId: string): Promise<void> {
    this.records.delete(orgId);
  }
}

declare global {
  // `var` (not `let`/`const`) is required for a `declare global` ambient variable declaration.
  var __omnicloudDocuSignConnectionStore: DocuSignConnectionStore | undefined;
}
if (!globalThis.__omnicloudDocuSignConnectionStore) {
  globalThis.__omnicloudDocuSignConnectionStore = new InMemoryDocuSignConnectionStore();
}
const store: DocuSignConnectionStore = globalThis.__omnicloudDocuSignConnectionStore;

/* ── Domain-level helpers every route/service actually calls — these own the business rules (status transitions, what a fresh config clears); `store` above owns nothing but raw storage. ── */

export async function getConnection(orgId: string): Promise<DocuSignConnectionRecord | null> {
  return store.get(orgId);
}

export function toPublicConfig(record: DocuSignConnectionRecord | null, orgId: string): DocuSignConnectionConfig {
  if (!record) {
    return {
      orgId, environment: "demo", clientId: "", hasClientSecret: false, hasWebhookSecret: false, callbackUrl: null,
      status: "disconnected", lastError: null, docusignAccountId: null, docusignAccountName: null, baseUri: null,
      connectedUserName: null, connectedUserEmail: null, connectedUserId: null, connectedAt: null,
    };
  }
  // Never include clientSecret, webhookSecret, accessToken, or refreshToken — this is the ONLY shape the browser ever sees.
  return {
    orgId: record.orgId,
    environment: record.environment,
    clientId: record.clientId,
    hasClientSecret: !!record.clientSecret,
    hasWebhookSecret: !!record.webhookSecret,
    callbackUrl: record.callbackUrl,
    status: record.status,
    lastError: record.lastError,
    docusignAccountId: record.docusignAccountId,
    docusignAccountName: record.docusignAccountName,
    baseUri: record.baseUri,
    connectedUserName: record.connectedUserName,
    connectedUserEmail: record.connectedUserEmail,
    connectedUserId: record.connectedUserId,
    connectedAt: record.connectedAt,
  };
}

/**
 * Configure/replace an org's DocuSign OAuth app credentials — clears any
 * prior tokens/connection info, since the app identity changed.
 * `webhookSecret` is OPTIONAL — an empty/omitted value stores `null`, never
 * a generated or placeholder secret.
 */
export async function upsertConnectionSettings(orgId: string, input: { environment: DocuSignEnvironment; clientId: string; clientSecret: string; webhookSecret?: string; callbackUrl?: string }): Promise<void> {
  await store.save(orgId, {
    orgId,
    environment: input.environment,
    // Trimmed like webhookSecret/callbackUrl below — a copy-pasted Integration
    // Key or Secret with a stray leading/trailing space or newline (common
    // when copying from DocuSign's admin UI) would otherwise be sent verbatim
    // as OAuth `client_id`/Basic-auth secret, which DocuSign can't match to
    // any registered app — surfacing as "redirect URI is not registered
    // properly" even when the registered URI is byte-for-byte correct.
    clientId: input.clientId.trim(),
    clientSecret: input.clientSecret.trim(),
    webhookSecret: input.webhookSecret?.trim() || null,
    callbackUrl: input.callbackUrl?.trim() || null,
    accessToken: null, refreshToken: null, tokenExpiresAt: null,
    docusignAccountId: null, docusignAccountName: null, baseUri: null,
    connectedUserName: null, connectedUserEmail: null, connectedUserId: null, connectedAt: null,
    status: "disconnected", lastError: null,
  });
  // Read back from the SAME store immediately after saving — proves the
  // record that every subsequent route (including /docusign/connect) reads
  // actually reflects what was just written, rather than trusting the write
  // call succeeded.
  const readback = await store.get(orgId);
  const masked = readback?.clientId ? maskForLog(readback.clientId) : null;
  console.log(`[DOCUSIGN SETTINGS READBACK]\norgId = ${orgId}\nstoredClientIdMasked = ${masked}`);
}

/** First 4 + last 2 chars only — local to this file's diagnostic logging (avoids importing lib/contracts/docusign/client.ts's masking helper into places that don't otherwise need it). */
function maskForLog(clientId: string): string {
  if (clientId.length <= 8) return "*".repeat(clientId.length);
  return `${clientId.slice(0, 4)}${"*".repeat(clientId.length - 6)}${clientId.slice(-2)}`;
}

export async function saveOAuthTokens(orgId: string, input: {
  accessToken: string; refreshToken: string; expiresInSeconds: number;
  docusignAccountId: string; docusignAccountName: string; baseUri: string;
  connectedUserName: string; connectedUserEmail: string; connectedUserId: string;
}): Promise<void> {
  const updated = await store.update(orgId, {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    tokenExpiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    docusignAccountId: input.docusignAccountId,
    docusignAccountName: input.docusignAccountName,
    baseUri: input.baseUri,
    connectedUserName: input.connectedUserName,
    connectedUserEmail: input.connectedUserEmail,
    connectedUserId: input.connectedUserId,
    connectedAt: new Date().toISOString(),
    status: "connected",
    lastError: null,
  });
  if (!updated) throw new Error("DocuSign settings were not found for this organization.");
}

export async function updateAccessToken(orgId: string, input: { accessToken: string; refreshToken: string; expiresInSeconds: number }): Promise<void> {
  const updated = await store.update(orgId, {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    tokenExpiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    status: "connected",
    lastError: null,
  });
  if (!updated) throw new Error("DocuSign settings were not found for this organization.");
}

/** Keep the stored connection record (so the UI can offer "Reconnect") rather than deleting it. */
export async function markReauthorizationRequired(orgId: string, message: string): Promise<void> {
  await store.update(orgId, { status: "reauthorization_required", lastError: message });
}

export async function markConnectionError(orgId: string, message: string): Promise<void> {
  await store.update(orgId, { status: "error", lastError: message });
}

/** Disconnect clears the live connection (tokens, account, connected user) but keeps the Client ID/Secret/webhook secret configuration — reconnecting is then just a fresh OAuth grant, no re-entering credentials. */
export async function disconnectConnection(orgId: string): Promise<void> {
  await store.update(orgId, {
    accessToken: null, refreshToken: null, tokenExpiresAt: null,
    docusignAccountId: null, docusignAccountName: null, baseUri: null,
    connectedUserName: null, connectedUserEmail: null, connectedUserId: null, connectedAt: null,
    status: "disconnected", lastError: null,
  });
}
