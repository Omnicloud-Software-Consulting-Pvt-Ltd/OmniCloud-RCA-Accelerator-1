import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * Salesforce OAuth 2.0 web-server flow helpers (server only).
 *
 * One sign-in attempt = one "transaction" kept in a short-lived httpOnly cookie: a random `state` (bound to THIS browser, so a
 * callback started elsewhere is refused) and a PKCE `verifier`. No server secret or environment variable is needed for either.
 * The authorization code is exchanged on the server and the tokens go straight into the httpOnly session cookie — they never
 * reach browser JavaScript.
 */

export type SalesforceEnvironment = "sandbox" | "production";

export const OAUTH_TX_COOKIE = "sf_oauth_tx";
/** Long enough to type a password and pass MFA; short enough that an abandoned attempt can't be replayed later. */
export const OAUTH_TX_MAX_AGE = 15 * 60;
export const OAUTH_CALLBACK_PATH = "/api/auth/callback/salesforce";
export const OAUTH_SCOPES = "api refresh_token openid profile email";

export interface OAuthTransaction {
  state: string;
  verifier: string;
  environment: SalesforceEnvironment;
  createdAt: number;
}

/** Production and Developer Edition orgs sign in at login.salesforce.com; sandboxes at test.salesforce.com. */
export function loginBaseFor(environment: SalesforceEnvironment): string {
  return environment === "production" ? "https://login.salesforce.com" : "https://test.salesforce.com";
}

export function parseEnvironment(value: string | null | undefined): SalesforceEnvironment {
  return value === "production" ? "production" : "sandbox";
}

/** The app's public origin, from the request (behind a proxy / load balancer: the forwarded host + protocol). */
export function appBaseUrl(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
    ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

export function callbackUrl(req: NextRequest): string {
  return `${appBaseUrl(req)}${OAUTH_CALLBACK_PATH}`;
}

/** PKCE (RFC 7636, S256): a random verifier and its SHA-256 challenge. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function newTransaction(environment: SalesforceEnvironment, now = Date.now()): OAuthTransaction & { challenge: string } {
  const { verifier, challenge } = createPkce();
  return { state: randomBytes(24).toString("base64url"), verifier, challenge, environment, createdAt: now };
}

export function encodeTransaction(tx: OAuthTransaction): string {
  const { state, verifier, environment, createdAt } = tx;
  return Buffer.from(JSON.stringify({ state, verifier, environment, createdAt })).toString("base64url");
}

export function decodeTransaction(raw: string | undefined, now = Date.now()): OAuthTransaction | null {
  if (!raw) return null;
  try {
    const tx = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<OAuthTransaction>;
    if (typeof tx.state !== "string" || typeof tx.verifier !== "string" || typeof tx.createdAt !== "number") return null;
    if (now - tx.createdAt > OAUTH_TX_MAX_AGE * 1000) return null;
    return { state: tx.state, verifier: tx.verifier, environment: parseEnvironment(tx.environment), createdAt: tx.createdAt };
  } catch {
    return null;
  }
}

/** Constant-time comparison of the returned state with the one this browser started. */
export function stateMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildAuthorizeUrl(params: { environment: SalesforceEnvironment; clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
    scope: OAUTH_SCOPES,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    // Always show the Salesforce login screen, so any user of that org can sign in (not just the one already logged in there).
    prompt: "login",
  });
  return `${loginBaseFor(params.environment)}/services/oauth2/authorize?${q}`;
}

export function transactionCookieOptions(maxAge = OAUTH_TX_MAX_AGE) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax: sent on the top-level redirect back from Salesforce and on same-origin fetches; never on cross-site POSTs.
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}
