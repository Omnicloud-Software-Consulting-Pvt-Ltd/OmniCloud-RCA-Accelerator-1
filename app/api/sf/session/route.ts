import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  decodeSession,
  clientFromSession,
} from "@/lib/salesforce/client";

function getSession(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE);
  if (!cookie?.value) return null;
  return decodeSession(cookie.value);
}

// Verify the server-side session is still valid
export async function GET(req: NextRequest) {
  const session = getSession(req);
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  try {
    const client = clientFromSession(session);
    const userInfo = await client.getUserInfo();
    return NextResponse.json({
      authenticated: true,
      user: {
        username: userInfo.preferred_username,
        displayName: userInfo.display_name || userInfo.name,
        email: userInfo.email,
        instanceUrl: session.instanceUrl,
      },
    });
  } catch {
    // Token expired or invalid — clear the cookie
    const res = NextResponse.json({ authenticated: false, reason: "token_expired" }, { status: 401 });
    res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  }
}

// Sign out — clear the HTTP-only cookie
export async function DELETE() {
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
