import type { DocuSignEnvironment } from "@/lib/contracts/docusign/types";

/**
 * DocuSign OAuth — Authorization Code Grant (confidential client: Integration Key + Secret Key) with PKCE, plus refresh tokens
 * (the "extended" scope keeps the refresh token usable while it's being used). Every network call takes an injectable fetch so the
 * flow is covered by tests without contacting DocuSign.
 *
 * Docs: https://developers.docusign.com/platform/auth/authcode/
 */

export const OAUTH_HOST: Record<DocuSignEnvironment, string> = {
  demo: "https://account-d.docusign.com",
  production: "https://account.docusign.com",
};

export const OAUTH_SCOPES = "signature extended";
export const CALLBACK_PATH = "/api/contracts/docusign/callback";
/** How long a "Connect" click stays valid while the user is on DocuSign's consent page. */
export const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (v: unknown): v is string => typeof v === "string" && GUID.test(v.trim());

export class DocuSignOAuthError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}

/**
 * The app's public origin, used for the Redirect URI. NEXTAUTH_URL (the app's configured public URL, already used by the Salesforce
 * OAuth routes) wins; otherwise the request's own origin. Never taken from a request body or query parameter.
 */
export function appOrigin(nextUrlOrigin: string, configured: string | undefined = process.env.NEXTAUTH_URL): string {
  return (configured?.trim() || nextUrlOrigin).replace(/\/+$/, "");
}

export const redirectUriFor = (origin: string) => `${origin}${CALLBACK_PATH}`;

export function buildAuthorizeUrl(o: { environment: DocuSignEnvironment; integrationKey: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const p = new URLSearchParams({
    response_type: "code",
    scope: OAUTH_SCOPES,
    client_id: o.integrationKey,
    redirect_uri: o.redirectUri,
    state: o.state,
    code_challenge: o.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${OAUTH_HOST[o.environment]}/oauth/auth?${p.toString()}`;
}

export interface TokenResponse { accessToken: string; refreshToken: string | null; expiresInSeconds: number }

async function tokenRequest(environment: DocuSignEnvironment, integrationKey: string, secretKey: string, form: Record<string, string>, fetchImpl: FetchLike): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetchImpl(`${OAUTH_HOST[environment]}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${integrationKey}:${secretKey}`, "utf8").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      cache: "no-store",
    });
  } catch {
    throw new DocuSignOAuthError("Couldn't reach DocuSign. Check your network connection and try again.", "NETWORK_ERROR", 503);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body || typeof body.access_token !== "string") {
    const code = typeof body?.error === "string" ? body.error : `HTTP_${res.status}`;
    throw new DocuSignOAuthError(oauthErrorMessage(code, typeof body?.error_description === "string" ? body.error_description : null), code, res.status || 502);
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in) || 3600,
  };
}

export function exchangeAuthorizationCode(o: { environment: DocuSignEnvironment; integrationKey: string; secretKey: string; code: string; codeVerifier: string; redirectUri: string }, fetchImpl: FetchLike = fetch) {
  return tokenRequest(o.environment, o.integrationKey, o.secretKey, { grant_type: "authorization_code", code: o.code, code_verifier: o.codeVerifier, redirect_uri: o.redirectUri }, fetchImpl);
}

export function refreshAccessToken(o: { environment: DocuSignEnvironment; integrationKey: string; secretKey: string; refreshToken: string }, fetchImpl: FetchLike = fetch) {
  return tokenRequest(o.environment, o.integrationKey, o.secretKey, { grant_type: "refresh_token", refresh_token: o.refreshToken }, fetchImpl);
}

export interface DocuSignAccount { accountId: string; accountName: string | null; baseUri: string; isDefault: boolean }
export interface DocuSignUserInfo { userId: string | null; name: string | null; email: string | null; accounts: DocuSignAccount[] }

export async function getUserInfo(environment: DocuSignEnvironment, accessToken: string, fetchImpl: FetchLike = fetch): Promise<DocuSignUserInfo> {
  let res: Response;
  try {
    res = await fetchImpl(`${OAUTH_HOST[environment]}/oauth/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  } catch {
    throw new DocuSignOAuthError("Couldn't reach DocuSign to confirm your identity.", "NETWORK_ERROR", 503);
  }
  if (res.status === 401) throw new DocuSignOAuthError("DocuSign didn't accept the access token.", "invalid_token", 401);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) throw new DocuSignOAuthError(`DocuSign's identity check failed (HTTP ${res.status}).`, `HTTP_${res.status}`, res.status);
  const accounts = Array.isArray(body.accounts) ? (body.accounts as Record<string, unknown>[]) : [];
  return {
    userId: typeof body.sub === "string" ? body.sub : null,
    name: typeof body.name === "string" ? body.name : null,
    email: typeof body.email === "string" ? body.email : null,
    accounts: accounts
      .filter(a => typeof a.account_id === "string" && typeof a.base_uri === "string")
      .map(a => ({ accountId: String(a.account_id), accountName: typeof a.account_name === "string" ? a.account_name : null, baseUri: String(a.base_uri), isDefault: a.is_default === true || a.is_default === "true" })),
  };
}

/** The account to use: the one the user named (it must belong to them), else their default, else their only one. */
export function selectAccount(info: DocuSignUserInfo, preferredAccountId: string | null): { account: DocuSignAccount } | { error: string; code: string } {
  if (!info.accounts.length) return { code: "NO_ACCOUNT", error: "This DocuSign user has no eSignature account." };
  if (preferredAccountId) {
    const match = info.accounts.find(a => a.accountId.toLowerCase() === preferredAccountId.trim().toLowerCase());
    return match ? { account: match } : { code: "ACCOUNT_NOT_FOUND", error: "The Account ID you entered doesn't belong to the DocuSign user who signed in. Leave it blank to use their default account, or sign in as a user of that account." };
  }
  return { account: info.accounts.find(a => a.isDefault) ?? info.accounts[0] };
}

/** API calls only ever go to DocuSign's own hosts (https, *.docusign.net / *.docusign.com) — a stored base URI can't redirect them elsewhere. */
export function isDocuSignBaseUri(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && /(^|\.)docusign\.(net|com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export function oauthErrorMessage(code: string, description: string | null): string {
  switch (code) {
    case "invalid_grant": return "DocuSign no longer accepts this sign-in (it expired or was revoked). Reconnect DocuSign.";
    case "invalid_client": return "DocuSign didn't accept the Integration Key and Secret Key. Check both values and that they belong to the selected environment (Demo or Production).";
    case "unauthorized_client": return "This Integration Key isn't allowed to use Authorization Code Grant. In DocuSign Apps and Keys, enable Authorization Code Grant for the key.";
    case "invalid_request": return `DocuSign rejected the sign-in request${description ? `: ${description}` : "."} Most often the Redirect URI on the Integration Key doesn't exactly match the one shown on this page.`;
    case "consent_required": return "DocuSign needs you to allow OmniCloud to access your account. Click Connect to DocuSign again and choose Allow.";
    case "access_denied": return "The DocuSign sign-in was cancelled or access was denied.";
    default: return description ? `DocuSign: ${description}` : `DocuSign sign-in failed (${code}).`;
  }
}
