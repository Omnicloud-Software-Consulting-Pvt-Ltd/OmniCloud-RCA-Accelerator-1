import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  decodeSession,
  clientFromSession,
  SalesforceError,
  SalesforceClient,
  SF_API_VERSION_RCA,
  type SFServerSession,
} from "@/lib/salesforce/client";

/** Read + decode the SF session cookie. Returns null if absent/invalid. */
export function getSFSession(req: NextRequest): SFServerSession | null {
  const cookie = req.cookies.get(SESSION_COOKIE);
  if (!cookie?.value) return null;
  return decodeSession(cookie.value);
}

/**
 * Shared auth guard for every Quote/QLI route: reads the session cookie and
 * builds a SalesforceClient pinned to the RCA API version (Quote,
 * QuoteLineItem, ProductRelatedComponent, etc. all need v62.0+). Returns
 * either `{ client, session }` or a ready-to-return 401 NextResponse.
 */
export function requireSFClient(
  req: NextRequest,
  apiVersion: string = SF_API_VERSION_RCA,
): { client: SalesforceClient; session: SFServerSession } | { unauthorized: NextResponse } {
  const session = getSFSession(req);
  if (!session) {
    return { unauthorized: NextResponse.json({ error: "Not authenticated", code: "UNAUTHENTICATED" }, { status: 401 }) };
  }
  return { client: clientFromSession(session, { apiVersion }), session };
}

/** Convert a caught error into the app's standard `{ error, code? }` NextResponse shape. */
export function sfErrorResponse(err: unknown, fallbackMessage: string): NextResponse {
  if (err instanceof SalesforceError) {
    if (err.status === 401) {
      const res = NextResponse.json(
        { error: "Session expired. Please sign in again.", code: "TOKEN_EXPIRED" },
        { status: 401 },
      );
      res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
      return res;
    }
    const message = Array.isArray(err.body)
      ? err.body.map((e: { message: string }) => e.message).join("; ")
      : err.message;
    return NextResponse.json({ error: message, code: err.errorCode }, { status: err.status });
  }
  return NextResponse.json({ error: err instanceof Error ? err.message : fallbackMessage }, { status: 500 });
}
