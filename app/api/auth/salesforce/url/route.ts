import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomBytes } from "crypto";
import { resolveClientId } from "@/lib/config";

function appBaseUrl(req: NextRequest): string {
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const clientId = resolveClientId(req);
  if (!clientId) {
    return NextResponse.json(
      { error: "Salesforce Connected App isn't configured. Add your Client ID & Secret in Setup, or use an access token." },
      { status: 503 }
    );
  }

  const env = req.nextUrl.searchParams.get("environment") ?? "sandbox";
  const environment = env === "production" ? "production" : "sandbox";

  // Build signed state — prevents CSRF. Format: "{env}|{nonce}|{hmac16}"
  const nonce = randomBytes(16).toString("hex");
  const payload = `${environment}|${nonce}`;
  const secret = process.env.NEXTAUTH_SECRET ?? "omnicloud-dev-secret";
  const hmac = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
  const state = `${payload}|${hmac}`;

  const loginBase =
    environment === "sandbox"
      ? "https://test.salesforce.com"
      : "https://login.salesforce.com";

  const redirectUri = `${appBaseUrl(req)}/api/auth/callback/salesforce`;

  console.log("[Omnicloud OAuth] redirect_uri →", redirectUri);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: "api refresh_token openid profile email",
    prompt: "login",
  });

  return NextResponse.json({
    url: `${loginBase}/services/oauth2/authorize?${params}`,
    state,
    redirectUri,
  });
}
