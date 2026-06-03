import { NextRequest, NextResponse } from "next/server";
import { SalesforceClient, SalesforceError, SESSION_COOKIE, decodeSession } from "@/lib/salesforce/client";

function getSession(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE);
  if (!cookie?.value) return null;
  return decodeSession(cookie.value);
}

type Params = { params: Promise<{ sobject: string }> };

// GET /api/sf/record/[sobject]?id=xxx&fields=Name,Email
export async function GET(req: NextRequest, { params }: Params) {
  const session = getSession(req);
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { sobject } = await params;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const fieldsParam = searchParams.get("fields");

  if (!id) return NextResponse.json({ error: "Record id is required" }, { status: 400 });

  const client = new SalesforceClient(session.instanceUrl, session.accessToken);
  try {
    const record = await client.getRecord(
      sobject,
      id,
      fieldsParam ? fieldsParam.split(",") : undefined,
    );
    return NextResponse.json(record);
  } catch (err) {
    if (err instanceof SalesforceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to fetch record" }, { status: 500 });
  }
}

// POST /api/sf/record/[sobject]  — create
export async function POST(req: NextRequest, { params }: Params) {
  const session = getSession(req);
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { sobject } = await params;
  let fields: Record<string, unknown>;
  try {
    ({ fields } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!fields || typeof fields !== "object") {
    return NextResponse.json({ error: "fields object is required" }, { status: 400 });
  }

  const client = new SalesforceClient(session.instanceUrl, session.accessToken);
  try {
    const result = await client.createRecord(sobject, fields);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof SalesforceError) {
      if (err.status === 401) {
        return NextResponse.json({ error: "Session expired" }, { status: 401 });
      }
      // Extract first Salesforce error message from array body
      const sfMsg = Array.isArray(err.body)
        ? err.body.map((e: { message: string }) => e.message).join("; ")
        : err.message;
      return NextResponse.json({ error: sfMsg }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to create record" }, { status: 500 });
  }
}

// PATCH /api/sf/record/[sobject]  — update (send id in body)
export async function PATCH(req: NextRequest, { params }: Params) {
  const session = getSession(req);
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { sobject } = await params;
  let id: string, fields: Record<string, unknown>;
  try {
    ({ id, fields } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const client = new SalesforceClient(session.instanceUrl, session.accessToken);
  try {
    await client.updateRecord(sobject, id, fields);
    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof SalesforceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to update record" }, { status: 500 });
  }
}

// DELETE /api/sf/record/[sobject]?id=xxx
export async function DELETE(req: NextRequest, { params }: Params) {
  const session = getSession(req);
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { sobject } = await params;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const client = new SalesforceClient(session.instanceUrl, session.accessToken);
  try {
    await client.deleteRecord(sobject, id);
    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof SalesforceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to delete record" }, { status: 500 });
  }
}
