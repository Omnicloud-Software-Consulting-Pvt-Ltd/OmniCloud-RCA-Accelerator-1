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
import { logSfLimitExceeded } from "@/lib/salesforce/requestDebug";

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

/**
 * Convert a caught error into the app's standard `{ error, code? }`
 * NextResponse shape — the ONE place this conversion happens, reused by
 * every API route in the app, which is exactly why it's the right (and
 * only necessary) place to special-case REQUEST_LIMIT_EXCEEDED (§4/§8 of
 * the request-limit fix): every route that already calls this function
 * gets the fix automatically, with no per-route changes needed.
 *
 * §Never auto-retry REQUEST_LIMIT_EXCEEDED: this function only ever
 * CONVERTS the error into a response — it has no retry logic of its own,
 * and nothing here (or in SalesforceClient.request(), which only retries
 * on 401) re-issues the failed call. The distinct `SALESFORCE_API_LIMIT_
 * EXCEEDED` code lets the UI show a specific message and gate any retry
 * behind an explicit user action instead of the generic "Could not load
 * data" text that previously made a org-wide capacity exhaustion look like
 * a bug in one dashboard.
 */
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
    if (err.errorCode === "REQUEST_LIMIT_EXCEEDED") {
      logSfLimitExceeded(fallbackMessage, message);
      return NextResponse.json(
        {
          error: "Salesforce API request capacity has been temporarily exhausted. Please wait before retrying.",
          code: "SALESFORCE_API_LIMIT_EXCEEDED",
          salesforceErrorCode: err.errorCode,
          salesforceMessage: message,
          httpStatus: err.status,
        },
        { status: err.status },
      );
    }
    return NextResponse.json({ error: message, code: err.errorCode }, { status: err.status });
  }
  return NextResponse.json({ error: err instanceof Error ? err.message : fallbackMessage, code: "NETWORK_ERROR" }, { status: 500 });
}
