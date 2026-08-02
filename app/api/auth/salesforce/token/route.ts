import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { resolveConnectedApp } from "@/lib/config";

function appBaseUrl(req: NextRequest): string {
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Verify the HMAC-signed state parameter to prevent CSRF. */
function verifyState(state: string): boolean {
  const secret = process.env.NEXTAUTH_SECRET ?? "omnicloud-dev-secret";
  const parts = state.split("|");
  if (parts.length !== 3) return false;
  const [environment, nonce, receivedHmac] = parts;
  if (!environment || !nonce || !receivedHmac) return false;
  const payload = `${environment}|${nonce}`;
  const expectedHmac = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
  // Constant-time comparison to prevent timing attacks
  return receivedHmac.length === expectedHmac.length &&
    Buffer.from(receivedHmac).equals(Buffer.from(expectedHmac));
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.code || !body?.state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  const { code, state } = body as { code: string; state: string };

  if (!verifyState(state)) {
    return NextResponse.json(
      { error: "Invalid state parameter. The request may have been tampered with." },
      { status: 400 }
    );
  }

  // Environment is encoded in state: "{environment}|{nonce}|{hmac}"
  const environment = state.startsWith("production|") ? "production" : "sandbox";

  const creds = resolveConnectedApp(req);
  if (!creds) {
    return NextResponse.json(
      { error: "Salesforce Connected App isn't configured. Add your Client ID & Secret in Setup." },
      { status: 503 }
    );
  }
  const { clientId, clientSecret } = creds;

  const loginBase =
    environment === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";

  const redirectUri = `${appBaseUrl(req)}/api/auth/callback/salesforce`;

  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });

  let tokenRes: Response;
  try {
    tokenRes = await fetch(`${loginBase}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to reach Salesforce. Check your network connection." },
      { status: 503 }
    );
  }

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || tokenData.error) {
    const msg = tokenData.error_description ?? tokenData.error ?? "Token exchange failed";
    return NextResponse.json({ error: msg }, { status: 401 });
  }

  // Fetch user identity from the Salesforce identity URL
  let username = "";
  let displayName = "";
  let email = "";
  let userId = "";
  let orgId = "";

  if (tokenData.id) {
    try {
      const idRes = await fetch(tokenData.id, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (idRes.ok) {
        const id = await idRes.json();
        username    = id.username          ?? "";
        displayName = id.display_name ?? id.name ?? "";
        email       = id.email             ?? "";
        userId      = id.user_id           ?? "";
        orgId       = id.organization_id   ?? "";
      }
    } catch {}
  }

  return NextResponse.json({
    accessToken:  tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    instanceUrl:  tokenData.instance_url,
    tokenType:    tokenData.token_type ?? "Bearer",
    userId,
    username,
    displayName,
    email,
    orgId,
    environment,
  });
}
