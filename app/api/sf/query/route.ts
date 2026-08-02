import { NextRequest, NextResponse } from "next/server";
import { SalesforceError, SESSION_COOKIE, decodeSession, clientFromSession } from "@/lib/salesforce/client";

function getSession(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE);
  if (!cookie?.value) return null;
  return decodeSession(cookie.value);
}

export async function POST(req: NextRequest) {
  const session = getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Not authenticated", code: "UNAUTHENTICATED" }, { status: 401 });
  }

  let soql: string, tooling: boolean;
  try {
    ({ soql, tooling = false } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!soql?.trim()) {
    return NextResponse.json({ error: "SOQL query is required" }, { status: 400 });
  }

  const client = clientFromSession(session);

  try {
    const result = tooling
      ? await client.toolingQuery(soql)
      : await client.query(soql);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SalesforceError) {
      if (err.status === 401) {
        const res = NextResponse.json(
          { error: "Session expired. Please sign in again.", code: "TOKEN_EXPIRED" },
          { status: 401 },
        );
        res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
        return res;
      }
      return NextResponse.json({ error: err.message, code: err.errorCode }, { status: err.status });
    }
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
