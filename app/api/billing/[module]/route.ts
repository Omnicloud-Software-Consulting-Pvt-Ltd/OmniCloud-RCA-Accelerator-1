import { NextRequest, NextResponse } from "next/server";
import { getBillingModule } from "@/lib/billing/registry";
import { requireBillingClient, getModuleSchema } from "@/lib/billing/server/discovery";
import { listBillingRecords } from "@/lib/billing/server/records";
import { createBillingRecords } from "@/lib/billing/server/create";
import { clearBillingStatsCache } from "@/lib/billing/server/stats";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import type { BillingDraftLink, BillingDraftRecord } from "@/lib/billing/types";

type Params = { params: Promise<{ module: string }> };

function unknownModule(key: string) {
  return NextResponse.json({ error: `Unknown billing module "${key}".`, code: "BILLING_MODULE_UNKNOWN" }, { status: 404 });
}

// GET /api/billing/[module] — existing records for a module's dashboard/history, straight from
// Salesforce (the source of truth — no local history store). Columns are the registry's concepts
// resolved to fields that exist in THIS org. Supports ?search=, ?limit= and ?parentField=&parentId=.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { module } = await params;
  const def = getBillingModule(module);
  if (!def) return unknownModule(module);

  const sp = req.nextUrl.searchParams;
  try {
    const result = await listBillingRecords(auth.client, module, {
      search: sp.get("search") ?? undefined,
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
      parentField: sp.get("parentField") ?? undefined,
      parentId: sp.get("parentId") ?? undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return billingErrorResponse(err, `Failed to load ${def.label}`, { objectLabel: def.singular });
  }
}

// POST /api/billing/[module] — create the reviewed configuration { draft, links }. Re-validated
// server-side against live metadata (the client's own validation is never trusted), then created
// as ONE all-or-nothing Composite request: parent + children + opted-in links.
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { module } = await params;
  const def = getBillingModule(module);
  if (!def) return unknownModule(module);
  if (def.viewOnly) return NextResponse.json({ error: def.viewOnly, code: "VIEW_ONLY_MODULE" }, { status: 403 });

  let draft: BillingDraftRecord;
  let links: BillingDraftLink[];
  try {
    const body = await req.json();
    draft = body.draft;
    links = Array.isArray(body.links) ? body.links : [];
    if (!draft || typeof draft !== "object" || draft.moduleKey !== module) {
      return NextResponse.json({ error: "Request must include a draft for this module.", code: "INVALID_REQUEST" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const outcome = await createBillingRecords(auth.client, draft, links);
    if (!outcome.ok) {
      return NextResponse.json({
        success: false, error: outcome.error, code: outcome.code, possibleCause: outcome.possibleCause,
        validation: outcome.validation, technical: outcome.technical,
      }, { status: outcome.status });
    }
    clearBillingStatsCache();
    return NextResponse.json(outcome.response);
  } catch (err) {
    let fieldLabel: ((n: string) => string) | undefined;
    try {
      const schema = await getModuleSchema(auth.client, module);
      fieldLabel = n => schema.fields.find(f => f.name === n)?.label ?? n;
    } catch { /* labels are a nicety for the error message */ }
    return billingErrorResponse(err, `Failed to create ${def.singular}`, { objectLabel: def.singular, fieldLabel });
  }
}
