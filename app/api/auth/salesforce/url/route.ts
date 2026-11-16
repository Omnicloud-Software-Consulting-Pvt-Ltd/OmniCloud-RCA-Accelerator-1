import { NextRequest, NextResponse } from "next/server";
import { resolveClientId } from "@/lib/config";
import {
  OAUTH_TX_COOKIE,
  buildAuthorizeUrl,
  callbackUrl,
  encodeTransaction,
  newTransaction,
  parseEnvironment,
  transactionCookieOptions,
} from "@/lib/salesforce/oauth";

/**
 * GET /api/auth/salesforce/url?environment=production|sandbox
 * Starts a Salesforce sign-in: creates this browser's sign-in transaction (random state + PKCE verifier, httpOnly cookie) and
 * returns the Salesforce authorize URL for the chosen environment. The browser then navigates there; Salesforce shows its own
 * login page (and its own "wrong username or password" errors), then redirects back to /api/auth/callback/salesforce.
 */
export async function GET(req: NextRequest) {
  const clientId = resolveClientId(req);
  if (!clientId) {
    return NextResponse.json(
      { error: "Salesforce Connected App isn't configured. Add your Client ID & Secret in Setup, or use an access token." },
      { status: 503 },
    );
  }

  const environment = parseEnvironment(req.nextUrl.searchParams.get("environment"));
  const tx = newTransaction(environment);
  const redirectUri = callbackUrl(req);

  const res = NextResponse.json({
    url: buildAuthorizeUrl({ environment, clientId, redirectUri, state: tx.state, challenge: tx.challenge }),
    environment,
    redirectUri,
  });
  res.cookies.set(OAUTH_TX_COOKIE, encodeTransaction(tx), transactionCookieOptions());
  res.headers.set("Cache-Control", "no-store");
  return res;
}
