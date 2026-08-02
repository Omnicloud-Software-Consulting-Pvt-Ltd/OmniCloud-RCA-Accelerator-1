import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { getConnection, saveOAuthTokens, markConnectionError } from "@/lib/contracts/docusign/connectionStore";
import { exchangeAuthorizationCode, getUserInfo, maskDocuSignClientId } from "@/lib/contracts/docusign/client";

interface OAuthStateCookie {
  state: string;
  /** The exact redirect_uri /connect resolved and sent to DocuSign — reused verbatim here so token exchange can never drift from what was actually authorized. */
  redirectUri: string;
}

function decodeStateCookie(value: string | undefined): OAuthStateCookie | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed?.state === "string" && typeof parsed?.redirectUri === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

// GET /api/contracts/docusign/callback — DocuSign OAuth redirect target.
// This arrives as a cross-site top-level redirect from account-d.docusign.com,
// so the sf_session cookie only survives the round-trip because it's
// SameSite=Lax (see sessionCookieOptions() in lib/salesforce/client.ts) — a
// Strict cookie is withheld on any cross-site navigation, including
// redirects. requireSFClient works here exactly like any other route — the
// org this connection gets attached to is always the one live in THIS
// session at callback time, never anything supplied by the redirect itself.
// Auth failure redirects back to the UI with a sanitized error instead of
// returning raw JSON, same as every other failure branch below.
export async function GET(req: NextRequest) {
  const redirectTarget = new URL("/data", req.nextUrl.origin);

  const clearStateCookie = (res: NextResponse) => {
    res.cookies.set("docusign_oauth_state", "", { maxAge: 0, path: "/" });
    return res;
  };

  const auth = requireSFClient(req);
  if ("unauthorized" in auth) {
    redirectTarget.searchParams.set("docusignError", "Your session expired during the DocuSign redirect — please sign in and try connecting again.");
    return clearStateCookie(NextResponse.redirect(redirectTarget));
  }
  const orgId = auth.client.instanceUrl;
  console.log(`[DOCUSIGN OAUTH CALLBACK]\norgId = ${orgId}`);

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const stateCookie = decodeStateCookie(req.cookies.get("docusign_oauth_state")?.value);

  if (!code || !state || !stateCookie || state !== stateCookie.state) {
    redirectTarget.searchParams.set("docusignError", "Invalid or expired OAuth state — please try connecting again.");
    return clearStateCookie(NextResponse.redirect(redirectTarget));
  }

  const record = await getConnection(orgId);
  if (!record) {
    redirectTarget.searchParams.set("docusignError", "DocuSign settings were not found for this organization.");
    return clearStateCookie(NextResponse.redirect(redirectTarget));
  }

  try {
    // Reuse the SAME redirect_uri /connect resolved and sent to DocuSign
    // (stashed in the state cookie) — never independently reconstructed
    // here, so this can't silently diverge from what was actually authorized.
    const authorizeRedirectUri = stateCookie.redirectUri;
    const tokenExchangeRedirectUri = authorizeRedirectUri;
    console.log(
      `[DOCUSIGN OAUTH DEBUG]\n` +
      `orgId = ${orgId}\n` +
      `environment = ${record.environment}\n` +
      `clientIdMasked = ${maskDocuSignClientId(record.clientId)}\n` +
      `authorizeRedirectUri = ${authorizeRedirectUri}\n` +
      `tokenExchangeRedirectUri = ${tokenExchangeRedirectUri}\n` +
      `authorizeRedirectUri === tokenExchangeRedirectUri = ${authorizeRedirectUri === tokenExchangeRedirectUri}`,
    );
    const tokens = await exchangeAuthorizationCode(record.environment, record.clientId, record.clientSecret, code, tokenExchangeRedirectUri);
    const userInfo = await getUserInfo(record.environment, tokens.accessToken);
    const account = userInfo.accounts.find(a => a.is_default) ?? userInfo.accounts[0];
    if (!account) throw new Error("DocuSign account info did not include any accounts.");

    await saveOAuthTokens(orgId, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresInSeconds: tokens.expiresIn,
      docusignAccountId: account.account_id,
      docusignAccountName: account.account_name,
      baseUri: account.base_uri,
      connectedUserName: userInfo.name,
      connectedUserEmail: userInfo.email,
    });
    redirectTarget.searchParams.set("docusignConnected", "1");
  } catch (err) {
    const message = err instanceof Error ? err.message : "DocuSign connection failed.";
    await markConnectionError(orgId, message);
    redirectTarget.searchParams.set("docusignError", message);
  }

  return clearStateCookie(NextResponse.redirect(redirectTarget));
}
