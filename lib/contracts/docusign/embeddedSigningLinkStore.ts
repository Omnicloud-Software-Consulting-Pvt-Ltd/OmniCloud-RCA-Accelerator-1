import { randomBytes } from "node:crypto";

/**
 * ============================================================================
 * TEMPORARY DEVELOPMENT STORAGE — NOT PRODUCTION-PERSISTENT.
 * ============================================================================
 * Same accepted limitation as connectionStore.ts/signatureStatusStore.ts (see
 * those files' doc comments): in-memory only, lost on server restart/redeploy/
 * cold start, not shared across instances. Anchored on `globalThis` for the
 * same empirically-confirmed reason as those files — separate route files can
 * otherwise get separate module evaluations under this app's Next.js 16 +
 * Turbopack dev server.
 *
 * WHAT THIS STORE IS FOR: the "Send Signing Email" manual-delivery
 * test flow (see envelope.ts's sendEmbeddedSigningTestEnvelope) needs a link
 * that survives an arbitrary, human-controlled delay between "sender opens
 * their email compose window" and "recipient actually clicks the link" — a
 * raw DocuSign recipientView URL cannot do that (single-use, ~5 minute
 * expiry). So the email instead links to THIS app's own public
 * /api/contracts/docusign/sign/[token] route, which looks up the token here
 * and mints a FRESH DocuSign view URL on every click. The token itself is the
 * only thing that needs to survive; it is never itself a DocuSign URL.
 *
 * This is deliberately the ONE place in the Contracts/DocuSign module that a
 * route is reachable WITHOUT a Salesforce session — the token is the sole
 * authorization, so it must be unguessable (32 random bytes) and scoped to
 * exactly one envelope/recipient, never enumerable or reusable across orgs.
 */

export interface EmbeddedSigningLinkRecord {
  token: string;
  orgId: string;
  envelopeId: string;
  recipientId: string;
  /** The clientUserId this recipient was created with on the envelope — must be replayed byte-for-byte on every createRecipientView call or DocuSign rejects it as a different recipient. */
  clientUserId: string;
  recipientName: string;
  recipientEmail: string;
  contractId: string;
  createdAt: string;
  /** Outer bound independent of DocuSign's own per-view ~5 minute expiry — this is how long the STABLE link itself stays usable, defaulting to 30 days (see createEmbeddedSigningLink). */
  expiresAt: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __omnicloudEmbeddedSigningLinkStore: Map<string, EmbeddedSigningLinkRecord> | undefined;
}
if (!globalThis.__omnicloudEmbeddedSigningLinkStore) {
  globalThis.__omnicloudEmbeddedSigningLinkStore = new Map();
}
const records = globalThis.__omnicloudEmbeddedSigningLinkStore;

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Mints a new unguessable token and stores its envelope/recipient mapping. Called once per "Send Signing Email" click — a fresh envelope (and so a fresh token) is created every time, never reused across sends. */
export async function createEmbeddedSigningLink(input: {
  orgId: string; envelopeId: string; recipientId: string; clientUserId: string;
  recipientName: string; recipientEmail: string; contractId: string;
}): Promise<EmbeddedSigningLinkRecord> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const record: EmbeddedSigningLinkRecord = {
    token,
    orgId: input.orgId,
    envelopeId: input.envelopeId,
    recipientId: input.recipientId,
    clientUserId: input.clientUserId,
    recipientName: input.recipientName,
    recipientEmail: input.recipientEmail,
    contractId: input.contractId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_MS).toISOString(),
  };
  records.set(token, record);
  return record;
}

/** Returns null for an unknown OR expired token — the /sign/[token] route treats both identically (a generic "this link is no longer valid" response), never distinguishing them to an unauthenticated caller. */
export async function getEmbeddedSigningLink(token: string): Promise<EmbeddedSigningLinkRecord | null> {
  const record = records.get(token);
  if (!record) return null;
  if (new Date(record.expiresAt).getTime() < Date.now()) return null;
  return record;
}
