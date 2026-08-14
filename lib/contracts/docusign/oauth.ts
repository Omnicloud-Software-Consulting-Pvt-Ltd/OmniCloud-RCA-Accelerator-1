import { getConnection, updateAccessToken, markReauthorizationRequired, markConnectionError } from "@/lib/contracts/docusign/connectionStore";
import { refreshAccessToken, DocuSignError, type DocuSignEnvironment } from "@/lib/contracts/docusign/client";

const SKEW_MS = 60_000;

export interface ActiveDocuSignSession {
  accessToken: string;
  accountId: string;
  baseUri: string;
  environment: DocuSignEnvironment;
  /** The DocuSign user whose OAuth grant this session runs as — from connectionStore's saved /oauth/userinfo capture, never re-derived or guessed. This IS the sender DocuSign will attribute every envelope this session sends to. */
  senderName: string | null;
  senderEmail: string | null;
  senderUserId: string | null;
}

/**
 * Per-organization token manager — auto-refreshes proactively within a 60s
 * expiry skew window using THAT organization's own Client ID/Secret. If the
 * refresh token itself is dead (invalid_grant), flips the stored connection
 * to "reauthorization_required" (keeping the record so the UI can offer
 * Reconnect) and returns null so callers can surface a clear message.
 */
export async function getActiveDocuSignSession(orgId: string): Promise<ActiveDocuSignSession | null> {
  const record = await getConnection(orgId);
  if (!record || record.status === "disconnected" || !record.accessToken || !record.refreshToken || !record.docusignAccountId || !record.baseUri) {
    return null;
  }

  const senderIdentity = { senderName: record.connectedUserName, senderEmail: record.connectedUserEmail, senderUserId: record.connectedUserId };

  const expiresAt = record.tokenExpiresAt ? new Date(record.tokenExpiresAt).getTime() : 0;
  if (Date.now() < expiresAt - SKEW_MS) {
    return { accessToken: record.accessToken, accountId: record.docusignAccountId, baseUri: record.baseUri, environment: record.environment, ...senderIdentity };
  }

  try {
    const refreshed = await refreshAccessToken(record.environment, record.clientId, record.clientSecret, record.refreshToken);
    await updateAccessToken(orgId, { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken, expiresInSeconds: refreshed.expiresIn });
    return { accessToken: refreshed.accessToken, accountId: record.docusignAccountId, baseUri: record.baseUri, environment: record.environment, ...senderIdentity };
  } catch (err) {
    const invalidGrant = err instanceof DocuSignError && !!(err.body as { invalidGrant?: boolean } | null)?.invalidGrant;
    if (invalidGrant) {
      await markReauthorizationRequired(orgId, "DocuSign refresh token is no longer valid — reconnect DocuSign for this organization.");
    } else {
      await markConnectionError(orgId, err instanceof Error ? err.message : "DocuSign token refresh failed.");
    }
    return null;
  }
}
