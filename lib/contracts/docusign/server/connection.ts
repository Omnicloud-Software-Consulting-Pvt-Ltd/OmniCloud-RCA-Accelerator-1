import { NextResponse, type NextRequest } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { docuSignApi } from "@/lib/contracts/docusign/client";
import { ENCRYPTION_KEY_ENV, encryptionKeyState, loadEncryptionKey, pkceChallenge, randomToken, safeEqual, sessionBinding } from "@/lib/contracts/docusign/crypto";
import {
  DocuSignOAuthError, PENDING_AUTH_TTL_MS, appOrigin, buildAuthorizeUrl, exchangeAuthorizationCode, getUserInfo, isDocuSignBaseUri,
  isGuid, oauthErrorMessage, redirectUriFor, refreshAccessToken, selectAccount, type FetchLike,
} from "@/lib/contracts/docusign/oauth";
import { CookieJar, CredentialTooLargeError, hasUnreadableConnection, publicConnection, readConnection, readPending } from "@/lib/contracts/docusign/server/session";
import { errorResponse, jsonError } from "@/lib/contracts/docusign/server/context";
import { SERVER_SECURITY_TEXT, serverSecurityMessage, type ConnectionStatusResponse, type DocuSignEnvironment, type ServerSetupView, type StoredConnection, type VerificationCheck } from "@/lib/contracts/docusign/types";

/**
 * Connecting a DocuSign account (Authorization Code Grant + PKCE):
 *  POST connect  → validates the Integration Key / Secret Key, stores them with a random `state` and PKCE verifier in a short-lived
 *                  encrypted cookie bound to the Salesforce session, and returns DocuSign's consent URL (the secret never goes to
 *                  the browser or into a URL);
 *  GET  callback → requires the same Salesforce session and a matching `state` (constant-time), exchanges the code with the stored
 *                  verifier, confirms the user's identity and account, checks eSignature API access, then stores the connection.
 */

export const SETTINGS_PATH = "/data?module=contracts&cv=docusign-settings";

export function redirectUriOf(req: NextRequest): string {
  return redirectUriFor(appOrigin(req.nextUrl.origin));
}

/** Where deployment administrators and developers find the server setup steps (referenced only in the server log, never in the UI). */
export const SERVER_SETUP_DOCS = "docs/DOCUSIGN_SERVER_SETUP.md";

/** All the browser learns about server security: whether credentials can be stored securely. Never the key, its name or setup steps. */
export function serverSetupView(keyState = encryptionKeyState()): ServerSetupView {
  return { configured: keyState === "ok", reason: keyState === "ok" ? null : keyState };
}

let warnedState: string | null = null;
/** Tells the deployment administrator (server log, once per state) what's wrong — names the variable, never prints a value. */
function warnAdministrator(state: ReturnType<typeof encryptionKeyState>) {
  if (state === "ok" || warnedState === state) return;
  warnedState = state;
  console.warn(`[DocuSign] Server security not configured: ${ENCRYPTION_KEY_ENV} is ${state === "invalid" ? "set but not a valid 32-byte key" : "not set"}. DocuSign connections are disabled until the deployment administrator configures it (see ${SERVER_SETUP_DOCS}).`);
}

/** Every user-facing "server not ready" response carries the same plain message; the code tells support/logs which case it is. */
export function keyMissingResponse(): NextResponse {
  const state = encryptionKeyState();
  warnAdministrator(state);
  return jsonError(503, state === "invalid" ? "DOCUSIGN_ENCRYPTION_KEY_INVALID" : "DOCUSIGN_ENCRYPTION_KEY_MISSING", serverSecurityMessage(state === "invalid" ? "invalid" : "missing"));
}

export function connectionStatus(req: NextRequest): NextResponse {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const redirectUri = redirectUriOf(req);
  const keyState = encryptionKeyState();
  const serverSetup = serverSetupView(keyState);
  const respond = (body: Omit<ConnectionStatusResponse, "serverSetup" | "redirectUri">) => NextResponse.json({ success: true, redirectUri, serverSetup, ...body });
  const key = keyState === "ok" ? loadEncryptionKey() : null;
  if (!key) {
    warnAdministrator(keyState);
    return respond({ status: "setup_required", encryptionReady: false, connection: null, message: serverSecurityMessage(serverSetup.reason) });
  }
  const conn = readConnection(req, key);
  if (!conn) {
    return respond({ status: "not_connected", encryptionReady: true, connection: null,
      message: hasUnreadableConnection(req, key) ? "A previously saved DocuSign connection can no longer be read (the server's encryption key changed or the saved data is incomplete). Connect again." : null });
  }
  if (conn.binding !== sessionBinding(auth.client.cacheScope)) return respond({ status: "reauthorization_required", encryptionReady: true, connection: publicConnection(conn), message: "Your Salesforce sign-in changed since DocuSign was connected, so the saved connection can't be used. Reconnect DocuSign." });
  return respond({ status: "connected", encryptionReady: true, connection: publicConnection(conn), message: null });
}

export async function startConnect(req: NextRequest, body: Record<string, unknown>): Promise<NextResponse> {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const key = loadEncryptionKey();
  if (!key) return keyMissingResponse();
  const binding = sessionBinding(auth.client.cacheScope);

  let environment: DocuSignEnvironment;
  let integrationKey: string;
  let secretKey: string;
  let accountId: string | null;
  if (body.reuseSaved === true) {
    // Reconnect with the saved key/secret — only from the same Salesforce session that saved them.
    const saved = readConnection(req, key);
    if (!saved || saved.binding !== binding) return jsonError(409, "NO_SAVED_CONNECTION", "There's no saved DocuSign setup for your current sign-in. Enter your Integration Key and Secret Key.");
    ({ environment, integrationKey, secretKey } = saved);
    accountId = saved.accountId;
  } else {
    if (body.environment !== "production" && body.environment !== "demo") return jsonError(400, "INVALID_ENVIRONMENT", "Choose Demo / Sandbox or Production.");
    environment = body.environment;
    integrationKey = typeof body.integrationKey === "string" ? body.integrationKey.trim() : "";
    secretKey = typeof body.secretKey === "string" ? body.secretKey.trim() : "";
    const acct = typeof body.accountId === "string" ? body.accountId.trim() : "";
    if (!isGuid(integrationKey)) return jsonError(400, "INVALID_INTEGRATION_KEY", "The Integration Key should look like 1a2b3c4d-1234-5678-9abc-1234567890ab (copy it from DocuSign Apps and Keys).");
    if (!isGuid(secretKey)) return jsonError(400, "INVALID_SECRET_KEY", "The Secret Key should look like 1a2b3c4d-1234-5678-9abc-1234567890ab. DocuSign shows it only once, when you add it.");
    if (acct && !isGuid(acct)) return jsonError(400, "INVALID_ACCOUNT_ID", "The API Account ID should look like 1a2b3c4d-1234-5678-9abc-1234567890ab — or leave it blank to use your default account.");
    accountId = acct || null;
  }

  const state = randomToken(32);
  const codeVerifier = randomToken(48);
  const redirectUri = redirectUriOf(req);
  const jar = new CookieJar(key);
  jar.setPending({ v: 1, state, codeVerifier, environment, integrationKey, secretKey, accountId, redirectUri, binding, createdAt: Date.now() });
  const authorizeUrl = buildAuthorizeUrl({ environment, integrationKey, redirectUri, state, codeChallenge: pkceChallenge(codeVerifier) });
  return jar.apply(NextResponse.json({ success: true, authorizeUrl, redirectUri }));
}

/** Verifies eSignature REST access for an account with an access token. */
async function checkEsignatureAccess(baseUri: string, accountId: string, accessToken: string, fetchImpl: FetchLike): Promise<{ ok: boolean; detail: string; accountName: string | null }> {
  try {
    const api = docuSignApi({ baseUri, accountId, fetchImpl, tokens: { get: async () => accessToken, refresh: async () => null } });
    const acct = await api.json<{ accountName?: string; planName?: string }>("GET", "");
    return { ok: true, detail: `eSignature API reachable${acct.planName ? ` (plan: ${acct.planName})` : ""}.`, accountName: acct.accountName ?? null };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "eSignature API check failed.", accountName: null };
  }
}

export async function completeCallback(req: NextRequest, fetchImpl: FetchLike = fetch): Promise<NextResponse> {
  const origin = req.nextUrl.origin;
  const back = (params: Record<string, string>) => new URL(`${SETTINGS_PATH}&${new URLSearchParams(params).toString()}`, origin);
  const key = loadEncryptionKey();
  if (!key) return NextResponse.redirect(back({ ds_error: "DOCUSIGN_ENCRYPTION_KEY_MISSING" }));
  const jar = new CookieJar(key);
  jar.clear("omni_ds_oauth");
  const fail = (code: string) => jar.apply(NextResponse.redirect(back({ ds_error: code })));

  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return fail("SALESFORCE_SESSION_MISSING");
  const pending = readPending(req, key);
  const q = req.nextUrl.searchParams;
  if (q.get("error")) return fail(q.get("error") === "access_denied" ? "access_denied" : q.get("error") === "consent_required" ? "consent_required" : "DOCUSIGN_AUTHORIZATION_FAILED");
  if (!pending || Date.now() - pending.createdAt > PENDING_AUTH_TTL_MS) return fail("CONNECT_EXPIRED");
  const state = q.get("state") ?? "";
  if (!state || !safeEqual(state, pending.state)) return fail("STATE_MISMATCH");
  if (pending.binding !== sessionBinding(auth.client.cacheScope)) return fail("SESSION_MISMATCH");
  const code = q.get("code");
  if (!code) return fail("NO_CODE");

  try {
    const tokens = await exchangeAuthorizationCode({ environment: pending.environment, integrationKey: pending.integrationKey, secretKey: pending.secretKey, code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri }, fetchImpl);
    if (!tokens.refreshToken) return fail("NO_REFRESH_TOKEN");
    const info = await getUserInfo(pending.environment, tokens.accessToken, fetchImpl);
    const chosen = selectAccount(info, pending.accountId);
    if ("error" in chosen) return fail(chosen.code);
    if (!isDocuSignBaseUri(chosen.account.baseUri)) return fail("INVALID_BASE_URI");
    const access = await checkEsignatureAccess(chosen.account.baseUri, chosen.account.accountId, tokens.accessToken, fetchImpl);
    if (!access.ok) return fail("ESIGNATURE_ACCESS_FAILED");
    const now = new Date().toISOString();
    const conn: StoredConnection = {
      v: 1,
      environment: pending.environment,
      integrationKey: pending.integrationKey,
      secretKey: pending.secretKey,
      refreshToken: tokens.refreshToken,
      accountId: chosen.account.accountId,
      accountName: access.accountName ?? chosen.account.accountName,
      baseUri: chosen.account.baseUri,
      userId: info.userId,
      userName: info.name,
      userEmail: info.email,
      binding: pending.binding,
      connectedAt: now,
      lastVerifiedAt: now,
    };
    jar.setConnection(conn);
    jar.setAccessToken({ v: 1, token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresInSeconds * 1000, binding: pending.binding });
    return jar.apply(NextResponse.redirect(back({ ds: "connected" })));
  } catch (e) {
    return fail(e instanceof CredentialTooLargeError ? "CREDENTIALS_TOO_LARGE" : e instanceof DocuSignOAuthError ? e.code : "DOCUSIGN_AUTHORIZATION_FAILED");
  }
}

/** "Test Connection": runs every check against DocuSign right now and reports each one. */
export async function verifyConnection(req: NextRequest, fetchImpl: FetchLike = fetch): Promise<NextResponse> {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const key = loadEncryptionKey();
  if (!key) return keyMissingResponse();
  const conn = readConnection(req, key);
  if (!conn) return jsonError(409, "DOCUSIGN_NOT_CONNECTED", "DocuSign isn't connected yet.");
  const binding = sessionBinding(auth.client.cacheScope);
  if (conn.binding !== binding) return jsonError(409, "DOCUSIGN_REAUTHORIZATION_REQUIRED", "Your Salesforce sign-in changed since DocuSign was connected. Reconnect DocuSign.");

  const jar = new CookieJar(key);
  const checks: VerificationCheck[] = [];
  try {
    let tokens;
    try {
      tokens = await refreshAccessToken({ environment: conn.environment, integrationKey: conn.integrationKey, secretKey: conn.secretKey, refreshToken: conn.refreshToken }, fetchImpl);
      checks.push({ id: "oauth", label: "DocuSign authorization", ok: true, detail: "OmniCloud is still authorized for your DocuSign account." });
    } catch (e) {
      const expired = e instanceof DocuSignOAuthError && (e.code === "invalid_grant" || e.status === 400 || e.status === 401);
      checks.push({ id: "oauth", label: "DocuSign authorization", ok: false, detail: e instanceof Error ? e.message : "Authorization failed." });
      return jar.apply(NextResponse.json({ success: false, status: expired ? "expired" : "error", checks, error: expired ? "The DocuSign connection has expired. Click Reconnect." : "DocuSign couldn't be reached to check the connection.", code: expired ? "DOCUSIGN_CONNECTION_EXPIRED" : "DOCUSIGN_CHECK_FAILED" }, { status: expired ? 401 : 502 }));
    }
    const current = tokens.refreshToken && tokens.refreshToken !== conn.refreshToken ? { ...conn, refreshToken: tokens.refreshToken } : conn;
    jar.setAccessToken({ v: 1, token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresInSeconds * 1000, binding });

    let info;
    try {
      info = await getUserInfo(conn.environment, tokens.accessToken, fetchImpl);
      checks.push({ id: "token", label: "Access token", ok: true, detail: "DocuSign accepted a fresh access token." });
      checks.push({ id: "identity", label: "DocuSign user", ok: true, detail: `${info.name ?? "Unknown name"}${info.email ? ` (${info.email})` : ""}` });
    } catch (e) {
      checks.push({ id: "token", label: "Access token", ok: false, detail: e instanceof Error ? e.message : "Token check failed." });
      return jar.apply(NextResponse.json({ success: false, status: "error", checks, error: "DocuSign didn't accept the access token.", code: "DOCUSIGN_TOKEN_INVALID" }, { status: 502 }));
    }
    const account = info.accounts.find(a => a.accountId.toLowerCase() === conn.accountId.toLowerCase());
    checks.push({ id: "account", label: "Account ID", ok: !!account, detail: account ? `${account.accountName ?? "Account"} (${conn.accountId})` : `Account ${conn.accountId} is no longer available to this DocuSign user.` });
    const baseOk = !!account && account.baseUri.replace(/\/+$/, "") === conn.baseUri.replace(/\/+$/, "");
    checks.push({ id: "baseUri", label: "API Base URI", ok: baseOk, detail: baseOk ? conn.baseUri : `DocuSign now reports ${account?.baseUri ?? "no base URI"} for this account — reconnect to update it.` });
    const access = account ? await checkEsignatureAccess(conn.baseUri, conn.accountId, tokens.accessToken, fetchImpl) : { ok: false, detail: "Skipped: the account isn't available.", accountName: null };
    checks.push({ id: "esignature", label: "eSignature API access", ok: access.ok, detail: access.detail });

    const ok = checks.every(c => c.ok);
    const updated: StoredConnection = { ...current, ...(ok ? { lastVerifiedAt: new Date().toISOString() } : {}) };
    if (ok || updated !== conn) jar.setConnection(updated);
    return jar.apply(NextResponse.json({ success: ok, status: ok ? "connected" : "error", checks, connection: publicConnection(updated), ...(ok ? {} : { error: "Some connection checks failed — see the details below.", code: "DOCUSIGN_CHECK_FAILED" }) }, { status: ok ? 200 : 502 }));
  } catch (e) {
    return jar.apply(errorResponse(e));
  }
}

/** Deletes every stored DocuSign credential for this browser session. */
export function disconnect(req: NextRequest): NextResponse {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const key = loadEncryptionKey();
  const res = NextResponse.json({ success: true, message: "DocuSign disconnected. OmniCloud deleted the saved credentials." });
  if (!key) return res;
  const jar = new CookieJar(key);
  jar.clearAll();
  return jar.apply(res);
}

/** Plain-language text for a callback error code (shown on the Settings page after DocuSign redirects back). */
export function callbackErrorMessage(code: string): string {
  const map: Record<string, string> = {
    DOCUSIGN_ENCRYPTION_KEY_MISSING: SERVER_SECURITY_TEXT.missing,
    SALESFORCE_SESSION_MISSING: "Your Salesforce session ended while you were on DocuSign. Sign in again, then reconnect.",
    CONNECT_EXPIRED: "The connection attempt took too long or was started in another browser. Click Connect to DocuSign again.",
    STATE_MISMATCH: "The sign-in response didn't match this connection attempt, so it was rejected for your security. Click Connect to DocuSign again.",
    SESSION_MISMATCH: "The DocuSign sign-in finished under a different Salesforce session than the one that started it. Click Connect to DocuSign again.",
    NO_CODE: "DocuSign didn't return an authorization code. Click Connect to DocuSign again.",
    NO_REFRESH_TOKEN: "DocuSign didn't issue a long-lived sign-in. Make sure Authorization Code Grant is enabled on the Integration Key.",
    NO_ACCOUNT: "The DocuSign user who signed in has no eSignature account.",
    ACCOUNT_NOT_FOUND: "The API Account ID you entered doesn't belong to the DocuSign user who signed in. Leave it blank to use their default account.",
    INVALID_BASE_URI: "DocuSign returned an unexpected API address for the account, so the connection was not saved.",
    ESIGNATURE_ACCESS_FAILED: "You signed in, but the account doesn't allow eSignature API access. Check the account's plan and your user permissions.",
    DOCUSIGN_AUTHORIZATION_FAILED: "DocuSign authorization failed. Try again.",
    CREDENTIALS_TOO_LARGE: "DocuSign returned a sign-in credential too large to store securely in this browser, so the connection was not saved. Try again; contact support if it repeats.",
  };
  return map[code] ?? oauthErrorMessage(code, null);
}
