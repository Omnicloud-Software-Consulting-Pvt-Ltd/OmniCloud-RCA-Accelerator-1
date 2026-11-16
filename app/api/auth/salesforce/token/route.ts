import { NextRequest, NextResponse } from "next/server";
import { resolveConnectedApp } from "@/lib/config";
import {
  SESSION_COOKIE,
  SalesforceClient,
  SalesforceError,
  encodeSession,
  sessionCookieOptions,
} from "@/lib/salesforce/client";
import {
  OAUTH_TX_COOKIE,
  callbackUrl,
  decodeTransaction,
  loginBaseFor,
  stateMatches,
  transactionCookieOptions,
} from "@/lib/salesforce/oauth";
import { tokenErrorMessage } from "@/lib/salesforce/oauthMessages";

/**
 * POST /api/auth/salesforce/token — { code, state }, called once by the callback page.
 * Verifies the state against THIS browser's sign-in transaction, exchanges the code (with the PKCE verifier) on the server,
 * confirms the signed-in Salesforce user, and stores the session in the httpOnly `sf_session` cookie. The response carries only
 * who signed in — never an access or refresh token.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { code?: unknown; state?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  const state = typeof body?.state === "string" ? body.state : "";
  if (!code || !state) {
    return fail("Salesforce didn't return a sign-in code. Click the Salesforce button and try again.", 400, "MISSING_CODE");
  }

  const tx = decodeTransaction(req.cookies.get(OAUTH_TX_COOKIE)?.value);
  if (!tx) {
    return fail("This sign-in attempt expired or was started in a different browser. Click the Salesforce button and sign in again.", 400, "NO_TRANSACTION");
  }
  if (!stateMatches(tx.state, state)) {
    return fail("This sign-in response doesn't belong to the sign-in started in this browser. Click the Salesforce button and sign in again.", 400, "STATE_MISMATCH");
  }

  const creds = resolveConnectedApp(req);
  if (!creds) {
    return fail("Salesforce Connected App isn't configured. Add your Client ID & Secret in Setup.", 503, "NO_CONNECTED_APP");
  }

  const redirectUri = callbackUrl(req);
  let tokenData: Record<string, unknown>;
  try {
    const tokenRes = await fetch(`${loginBaseFor(tx.environment)}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri,
        code_verifier: tx.verifier,
      }).toString(),
      cache: "no-store",
    });
    tokenData = ((await tokenRes.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (!tokenRes.ok || tokenData.error || typeof tokenData.access_token !== "string") {
      return fail(
        tokenErrorMessage(str(tokenData.error), str(tokenData.error_description), redirectUri),
        401,
        str(tokenData.error) ?? "TOKEN_EXCHANGE_FAILED",
      );
    }
  } catch {
    return fail("Couldn't reach Salesforce to finish signing in. Check your connection and try again.", 502, "NETWORK_ERROR");
  }

  const accessToken = tokenData.access_token as string;
  const refreshToken = str(tokenData.refresh_token);
  const instanceUrl = str(tokenData.instance_url)?.replace(/\/+$/, "") ?? "";
  if (!/^https:\/\/[^/]+$/i.test(instanceUrl)) {
    return fail("Salesforce returned an unexpected org address. Please try again.", 502, "BAD_INSTANCE_URL");
  }

  // Confirm the token works and read the real signed-in user from Salesforce itself.
  let user: { userId: string; orgId: string; username: string; displayName: string; email: string };
  try {
    const info = await new SalesforceClient(instanceUrl, accessToken).getUserInfo();
    user = {
      userId: info.user_id ?? "",
      orgId: info.organization_id ?? "",
      username: info.preferred_username ?? "",
      displayName: info.display_name || info.name || "",
      email: info.email ?? "",
    };
  } catch (err) {
    const detail = err instanceof SalesforceError ? err.message : "no response";
    return fail(`Signed in to Salesforce, but the user's identity couldn't be confirmed (${detail}). Make sure the Connected App has the openid and profile scopes.`, 502, "IDENTITY_FAILED");
  }

  const res = NextResponse.json({
    success: true,
    user: { ...user, instanceUrl, environment: tx.environment },
  });
  res.headers.set("Cache-Control", "no-store");
  res.cookies.set(
    SESSION_COOKIE,
    encodeSession({
      instanceUrl,
      accessToken,
      refreshToken,
      environment: tx.environment,
      // Kept with the session (as before) so transparent token refresh is self-contained.
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    }),
    sessionCookieOptions(),
  );
  // One transaction, one use.
  res.cookies.set(OAUTH_TX_COOKIE, "", transactionCookieOptions(0));
  return res;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function fail(error: string, status: number, code: string) {
  const res = NextResponse.json({ success: false, error, code }, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
