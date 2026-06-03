import { NextRequest, NextResponse } from "next/server";
import { SalesforceClient, SalesforceError, SESSION_COOKIE, decodeSession } from "@/lib/salesforce/client";

function getSession(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE);
  if (!cookie?.value) return null;
  return decodeSession(cookie.value);
}

// Supported metadata type keys
type MetadataType =
  | "ApexClass"
  | "ApexTrigger"
  | "LightningComponentBundle"
  | "FlowDefinition"
  | "ValidationRule"
  | "CustomObject"
  | "CustomField"
  | "PermissionSet"
  | "Report"
  | "Dashboard";

// GET /api/sf/metadata?type=ApexClass&limit=50&sobject=Account
export async function GET(req: NextRequest) {
  const session = getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Not authenticated", code: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") as MetadataType | null;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 200);
  const sobject = searchParams.get("sobject") ?? undefined;

  if (!type) {
    return NextResponse.json({ error: "type parameter is required" }, { status: 400 });
  }

  const client = new SalesforceClient(session.instanceUrl, session.accessToken);

  try {
    let result;

    switch (type) {
      case "ApexClass":
        result = await client.listApexClasses(limit);
        break;
      case "ApexTrigger":
        result = await client.listApexTriggers(limit);
        break;
      case "LightningComponentBundle":
        result = await client.listLwcComponents(limit);
        break;
      case "FlowDefinition":
        result = await client.listFlows(limit);
        break;
      case "ValidationRule":
        result = await client.listValidationRules(limit);
        break;
      case "CustomObject":
        result = await client.listCustomObjects(limit);
        break;
      case "CustomField":
        result = await client.listCustomFields(sobject, limit);
        break;
      case "PermissionSet":
        result = await client.listPermissionSets(limit);
        break;
      case "Report":
        result = await client.listReports(limit);
        break;
      case "Dashboard":
        result = await client.listDashboards(limit);
        break;
      default:
        return NextResponse.json({ error: `Unsupported metadata type: ${type}` }, { status: 400 });
    }

    return NextResponse.json({ type, total: result.totalSize, records: result.records });
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
    console.error("[sf/metadata] error:", err);
    return NextResponse.json({ error: "Failed to fetch metadata" }, { status: 500 });
  }
}
