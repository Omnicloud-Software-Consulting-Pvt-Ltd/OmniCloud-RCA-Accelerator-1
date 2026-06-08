import { NextRequest, NextResponse } from "next/server";
import {
  SalesforceClient,
  SalesforceError,
  SESSION_COOKIE,
  encodeSession,
  sessionCookieOptions,
} from "@/lib/salesforce/client";
import { resolveConnectedApp } from "@/lib/config";

export async function POST(req: NextRequest) {
  let instanceUrl: string, accessToken: string, refreshToken: string | undefined;

  try {
    ({ instanceUrl, accessToken, refreshToken } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!instanceUrl?.trim() || !accessToken?.trim()) {
    return NextResponse.json(
      { error: "Instance URL and Access Token are required" },
      { status: 400 },
    );
  }

  // Normalize instance URL
  let normalizedUrl = instanceUrl.trim().replace(/\/$/, "");
  if (!normalizedUrl.startsWith("http")) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  const client = new SalesforceClient(normalizedUrl, accessToken.trim());

  try {
    // Step 1: Validate token by calling /limits — lightweight and definitive
    await client.validate();

    // Step 2: Fetch real user identity
    const userInfo = await client.getUserInfo();

    const environment: "sandbox" | "production" =
      normalizedUrl.toLowerCase().includes("sandbox") ||
      normalizedUrl.toLowerCase().includes("test.")
        ? "sandbox"
        : "production";

    // Build response body (no token returned to client)
    const body = {
      success: true,
      user: {
        userId: userInfo.user_id,
        orgId: userInfo.organization_id,
        username: userInfo.preferred_username,
        displayName: userInfo.display_name || userInfo.name,
        email: userInfo.email,
        instanceUrl: normalizedUrl,
        environment,
      },
    };

    const res = NextResponse.json(body, { status: 200 });

    // Store token in HTTP-only cookie — never exposed to browser JS.
    // Includes the refresh token + environment so the session can refresh transparently.
    res.cookies.set(
      SESSION_COOKIE,
      encodeSession({
        instanceUrl: normalizedUrl,
        accessToken: accessToken.trim(),
        refreshToken: refreshToken?.trim() || undefined,
        environment,
        // Capture the Connected App creds so token refresh is self-contained.
        clientId: resolveConnectedApp(req)?.clientId,
        clientSecret: resolveConnectedApp(req)?.clientSecret,
      }),
      sessionCookieOptions(),
    );

    return res;
  } catch (err) {
    if (err instanceof SalesforceError) {
      if (err.status === 401 || err.status === 403) {
        return NextResponse.json(
          {
            error:
              "Invalid or expired access token. Generate a fresh token from Salesforce Setup → Personal Information → Reset My Security Token, or from your Connected App.",
          },
          { status: 401 },
        );
      }
      if (err.status === 0 || err.message.includes("fetch")) {
        return NextResponse.json(
          { error: `Cannot reach ${normalizedUrl}. Verify the Instance URL.` },
          { status: 502 },
        );
      }
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[sf/auth] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to connect to Salesforce. Check Instance URL and try again." },
      { status: 500 },
    );
  }
}

// Clear the server session on logout
export async function DELETE() {
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
