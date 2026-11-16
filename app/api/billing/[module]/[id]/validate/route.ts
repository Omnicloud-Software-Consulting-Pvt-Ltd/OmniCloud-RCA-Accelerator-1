import { NextRequest, NextResponse } from "next/server";
import { getBillingModule } from "@/lib/billing/registry";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { prepareUpdate } from "@/lib/billing/server/edit";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import type { BillingDraftLink, BillingDraftRecord } from "@/lib/billing/types";

type Params = { params: Promise<{ module: string; id: string }> };

// POST /api/billing/[module]/[id]/validate — "Validate Changes": dry-runs exactly what PATCH would
// check (changed updateable fields, lookups, platform rules incl. the Status transition, link
// changes) and returns the change summary + transition readiness. Writes nothing.
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { module, id } = await params;
  const def = getBillingModule(module);
  if (!def) return NextResponse.json({ error: `Unknown billing module "${module}".`, code: "BILLING_MODULE_UNKNOWN" }, { status: 404 });
  let draft: BillingDraftRecord;
  let links: BillingDraftLink[];
  try {
    const body = await req.json();
    draft = body.draft;
    links = Array.isArray(body.links) ? body.links : [];
    if (!draft || draft.moduleKey !== module) return NextResponse.json({ error: "Request must include a draft for this record.", code: "INVALID_REQUEST" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const { result } = await prepareUpdate(auth.client, module, id, draft, links);
    return NextResponse.json({ success: true, validation: result });
  } catch (err) {
    return billingErrorResponse(err, `Failed to validate ${def.singular} changes`, { objectLabel: def.singular });
  }
}
