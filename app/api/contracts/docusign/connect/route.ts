import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { getConnection } from "@/lib/contracts/docusign/connectionStore";
import { docuSignAuthorizeUrl, docuSignAuthBase, maskDocuSignClientId } from "@/lib/contracts/docusign/client";
import { resolveDocuSignRedirectUri, validateDocuSignRedirectUri } from "@/lib/contracts/docusign/redirectUri";

/** Never logs clientSecret, accessToken, refreshToken, Salesforce session, or the OAuth state/code. */
function logOAuthDebug(fields: Record<string, string>): void {
  const lines = Object.entries(fields).map(([k, v]) => `${k} = ${v}`);
  console.log(`[DOCUSIGN OAUTH DEBUG]\n${lines.join("\n")}`);
}

// GET /api/contracts/docusign/connect — start this org's DocuSign OAuth flow.
// Requires DocuSign settings (Client ID/environment) to already be saved. A
// random `state` is stashed in a short-lived cookie and checked on callback
// as basic CSRF protection. The cookie also carries the EXACT redirect_uri
// resolved here, so the callback's token exchange reuses this same value
// instead of re-resolving (and possibly drifting from what DocuSign was
// actually sent) — see lib/contracts/docusign/redirectUri.ts.
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const orgId = auth.client.instanceUrl;
  console.log(`[DOCUSIGN OAUTH CONNECT]\norgId = ${orgId}`);

  const record = await getConnection(orgId);
  if (!record) {
    return NextResponse.json({ error: "Configure DocuSign Client ID/Secret in Settings before connecting." }, { status: 400 });
  }

  const { redirectUri } = resolveDocuSignRedirectUri(record.callbackUrl, req.nextUrl.origin);
  const validationError = validateDocuSignRedirectUri(redirectUri);
  if (validationError) {
    return NextResponse.json({ error: `Configured DocuSign callback URL is invalid: ${validationError}` }, { status: 400 });
  }

  const state = randomBytes(16).toString("hex");
  const authorizeUrl = docuSignAuthorizeUrl(record.environment, record.clientId, redirectUri, state);

  // Decode the redirect_uri actually embedded in the URL we're about to send
  // DocuSign — not just trust that resolveDocuSignRedirectUri() and
  // docuSignAuthorizeUrl() agree — so a real encoding bug would be caught
  // here instead of assumed away.
  const decodedFromAuthorizeUrl = new URL(authorizeUrl).searchParams.get("redirect_uri") ?? "";
  const redirectUriMatches = decodedFromAuthorizeUrl === redirectUri;

  logOAuthDebug({
    environment: record.environment,
    authBaseUrl: docuSignAuthBase(record.environment),
    "integrationKey/clientId": maskDocuSignClientId(record.clientId),
    resolvedRedirectUri: redirectUri,
    encodedRedirectUri: encodeURIComponent(redirectUri),
    fullAuthorizeUrl: authorizeUrl,
    "authorizeRedirectUri === resolvedRedirectUri (decoded)": String(redirectUriMatches),
  });

  if (!redirectUriMatches) {
    // STOP before redirecting — never send DocuSign a URL whose redirect_uri
    // doesn't decode back to exactly what we resolved.
    return NextResponse.json(
      { error: "Internal error: the redirect_uri embedded in the DocuSign authorize URL does not match the resolved callback URL. Not redirecting." },
      { status: 500 },
    );
  }

  const res = NextResponse.redirect(authorizeUrl);
  const cookiePayload = Buffer.from(JSON.stringify({ state, redirectUri })).toString("base64url");
  res.cookies.set("docusign_oauth_state", cookiePayload, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 600,
  });
  return res;
}
