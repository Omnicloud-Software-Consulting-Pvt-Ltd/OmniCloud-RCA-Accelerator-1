import type { NextRequest, NextResponse } from "next/server";
import { seal, unseal } from "@/lib/contracts/docusign/crypto";
import type { PendingAuthorization, PublicConnection, StoredAccessToken, StoredConnection } from "@/lib/contracts/docusign/types";

/**
 * Where DocuSign credentials live: encrypted (AES-256-GCM), httpOnly cookies scoped to /api/contracts — the browser holds only
 * ciphertext it can't read or use, every server instance (and every restart, as long as DOCUSIGN_ENCRYPTION_KEY stays the same) can
 * read them, and each connection is bound to the Salesforce session that created it. This is the app's storage until it has a tenant
 * database.
 *
 * Size: browsers silently DROP any cookie over 4096 bytes, which would make a successful connection look disconnected. So each cookie
 * carries at most one DocuSign token (connection details / refresh token / access token are separate cookies), and every write is
 * size-checked: an essential credential that still wouldn't fit fails loudly (CredentialTooLargeError) instead of vanishing; the
 * access-token cookie is only a cache, so an oversized one is simply not cached.
 */

export const DS_COOKIE = { connection: "omni_ds_conn", refresh: "omni_ds_rt", token: "omni_ds_at", pending: "omni_ds_oauth" } as const;
const PURPOSE = { connection: "docusign-connection-v2", refresh: "docusign-refresh-token-v1", token: "docusign-access-token-v1", pending: "docusign-oauth-pending-v1" } as const;
export const DS_COOKIE_PATH = "/api/contracts";
/** DocuSign refresh tokens issued with the "extended" scope stay valid for 30 days of use. */
export const CONNECTION_MAX_AGE = 30 * 24 * 60 * 60;
export const PENDING_MAX_AGE = 10 * 60;
/** Per-cookie budget (name + value + attributes), safely below the 4096-byte browser limit. */
export const MAX_COOKIE_BYTES = 4000;

export class CredentialTooLargeError extends Error {}

export function dsCookieOptions(maxAge: number) {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: DS_COOKIE_PATH, maxAge };
}

/** Serialized Set-Cookie size, matching the attributes dsCookieOptions produces. */
export function cookieBytes(name: string, value: string, maxAge: number): number {
  return Buffer.byteLength(`${name}=${value}; Path=${DS_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=lax`, "utf8");
}

type ConnectionMeta = Omit<StoredConnection, "refreshToken">;
interface StoredRefreshToken { v: 1; token: string; binding: string }

/** The connection = details cookie + refresh-token cookie; both must decrypt and belong to the same session binding. */
export function readConnection(req: NextRequest, key: Buffer): StoredConnection | null {
  const meta = unseal<ConnectionMeta>(req.cookies.get(DS_COOKIE.connection)?.value, key, PURPOSE.connection);
  const rt = unseal<StoredRefreshToken>(req.cookies.get(DS_COOKIE.refresh)?.value, key, PURPOSE.refresh);
  if (!meta || !rt || rt.binding !== meta.binding || !rt.token) return null;
  return { ...meta, refreshToken: rt.token };
}

/** True when connection cookies exist but can't be used (e.g. sealed with a different encryption key). */
export function hasUnreadableConnection(req: NextRequest, key: Buffer): boolean {
  return !!req.cookies.get(DS_COOKIE.connection)?.value && !readConnection(req, key);
}

export const readAccessToken = (req: NextRequest, key: Buffer) => unseal<StoredAccessToken>(req.cookies.get(DS_COOKIE.token)?.value, key, PURPOSE.token);
export const readPending = (req: NextRequest, key: Buffer) => unseal<PendingAuthorization>(req.cookies.get(DS_COOKIE.pending)?.value, key, PURPOSE.pending);

/** Collects cookie changes during a request so they can be applied to whatever response the route ends up returning. */
export class CookieJar {
  private ops: { name: string; value: string; maxAge: number }[] = [];
  constructor(private readonly key: Buffer) {}

  private put(name: string, value: string, maxAge: number, essential: boolean): boolean {
    if (cookieBytes(name, value, maxAge) > MAX_COOKIE_BYTES) {
      if (essential) throw new CredentialTooLargeError(`DocuSign returned a credential too large to store securely in this browser (${name}).`);
      return false;
    }
    this.ops.push({ name, value, maxAge });
    return true;
  }

  setConnection(c: StoredConnection) {
    const { refreshToken, ...meta } = c;
    // Size-check both before queueing either, so a failure never leaves half a connection behind.
    const metaValue = seal(meta, this.key, PURPOSE.connection);
    const rtValue = seal({ v: 1, token: refreshToken, binding: c.binding } satisfies StoredRefreshToken, this.key, PURPOSE.refresh);
    for (const [name, value] of [[DS_COOKIE.connection, metaValue], [DS_COOKIE.refresh, rtValue]] as const) {
      if (cookieBytes(name, value, CONNECTION_MAX_AGE) > MAX_COOKIE_BYTES) throw new CredentialTooLargeError(`DocuSign returned a credential too large to store securely in this browser (${name}).`);
    }
    this.put(DS_COOKIE.connection, metaValue, CONNECTION_MAX_AGE, true);
    this.put(DS_COOKIE.refresh, rtValue, CONNECTION_MAX_AGE, true);
  }

  /** A cache: an oversized access token is just not stored (the next request refreshes instead). Returns whether it was stored. */
  setAccessToken(t: StoredAccessToken): boolean {
    return this.put(DS_COOKIE.token, seal(t, this.key, PURPOSE.token), Math.max(60, Math.floor((t.expiresAt - Date.now()) / 1000)), false);
  }

  setPending(p: PendingAuthorization) { this.put(DS_COOKIE.pending, seal(p, this.key, PURPOSE.pending), PENDING_MAX_AGE, true); }
  clear(name: (typeof DS_COOKIE)[keyof typeof DS_COOKIE]) { this.ops.push({ name, value: "", maxAge: 0 }); }
  clearAll() { for (const name of Object.values(DS_COOKIE)) this.clear(name); }
  apply<T extends NextResponse>(res: T): T {
    for (const op of this.ops) res.cookies.set(op.name, op.value, dsCookieOptions(op.maxAge));
    return res;
  }
}

/** The only shape of a connection that ever leaves the server: no key, secret or token. */
export function publicConnection(c: StoredConnection): PublicConnection {
  return {
    environment: c.environment,
    accountId: c.accountId,
    accountName: c.accountName,
    baseUri: c.baseUri,
    userName: c.userName,
    userEmail: c.userEmail,
    integrationKeyHint: `…${c.integrationKey.slice(-4)}`,
    connectedAt: c.connectedAt,
    lastVerifiedAt: c.lastVerifiedAt,
  };
}
