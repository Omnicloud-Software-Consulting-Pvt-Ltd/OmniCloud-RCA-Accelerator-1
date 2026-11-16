import { NextRequest, NextResponse } from "next/server";
import { getBillingModule } from "@/lib/billing/registry";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { getBillingRecordDetail } from "@/lib/billing/server/records";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import { updateBillingRecord } from "@/lib/billing/server/edit";
import { clearBillingStatsCache } from "@/lib/billing/server/stats";
import type { BillingDraftLink, BillingDraftRecord } from "@/lib/billing/types";

type Params = { params: Promise<{ module: string; id: string }> };

// GET /api/billing/[module]/[id] — one record: every readable field grouped into Basic /
// Relationships / Configuration / Salesforce sections, lookup names resolved, and related
// child records (e.g. a Treatment's Items, a Policy's Treatments and the Products using it).
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { module, id } = await params;
  const def = getBillingModule(module);
  if (!def) return NextResponse.json({ error: `Unknown billing module "${module}".`, code: "BILLING_MODULE_UNKNOWN" }, { status: 404 });

  try {
    return NextResponse.json(await getBillingRecordDetail(auth.client, module, id));
  } catch (err) {
    return billingErrorResponse(err, `Failed to load ${def.singular}`, { objectLabel: def.singular });
  }
}

// PATCH /api/billing/[module]/[id] — Save Changes for an EXISTING record: { draft, links }.
// Re-validated server-side against the live record (never trusting the client), then one
// all-or-nothing Composite request that PATCHes only the changed updateable fields plus any
// link/unlink of related records (e.g. Product2.BillingPolicyId). Never creates a new record.
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { module, id } = await params;
  const def = getBillingModule(module);
  if (!def) return NextResponse.json({ error: `Unknown billing module "${module}".`, code: "BILLING_MODULE_UNKNOWN" }, { status: 404 });
  if (def.viewOnly) return NextResponse.json({ error: def.viewOnly, code: "VIEW_ONLY_MODULE" }, { status: 403 });

  let draft: BillingDraftRecord;
  let links: BillingDraftLink[];
  try {
    const body = await req.json();
    draft = body.draft;
    links = Array.isArray(body.links) ? body.links : [];
    if (!draft || draft.moduleKey !== module || draft.recordId !== id) {
      return NextResponse.json({ error: "The changes don't belong to this record — reload it and try again.", code: "INVALID_REQUEST" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const outcome = await updateBillingRecord(auth.client, module, id, draft, links);
    if (!outcome.ok) {
      return NextResponse.json({ success: false, error: outcome.error, code: outcome.code, possibleCause: outcome.possibleCause, validation: outcome.validation, technical: outcome.technical }, { status: outcome.status });
    }
    clearBillingStatsCache();
    return NextResponse.json(outcome.response);
  } catch (err) {
    return billingErrorResponse(err, `Failed to update ${def.singular}`, { objectLabel: def.singular });
  }
}
