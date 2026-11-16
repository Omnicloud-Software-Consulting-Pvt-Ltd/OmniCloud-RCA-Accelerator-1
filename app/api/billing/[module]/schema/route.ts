import { NextRequest, NextResponse } from "next/server";
import { getBillingModule } from "@/lib/billing/registry";
import { requireBillingClient, getModuleSchema } from "@/lib/billing/server/discovery";
import { billingErrorResponse } from "@/lib/billing/server/errors";

type Params = { params: Promise<{ module: string }> };

// GET /api/billing/[module]/schema — the module's live Describe-derived schema: every field
// (type, required, createable/updateable, picklist values, reference targets, relationship
// names, controlling fields), inline child modules and validated inbound links. Drives the
// dynamic manual-creation form and the "Inspect Salesforce Configuration" panel.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { module } = await params;
  const def = getBillingModule(module);
  if (!def) return NextResponse.json({ error: `Unknown billing module "${module}".`, code: "BILLING_MODULE_UNKNOWN" }, { status: 404 });

  try {
    return NextResponse.json({ success: true, schema: await getModuleSchema(auth.client, module) });
  } catch (err) {
    return billingErrorResponse(err, `Failed to load the ${def.singular} schema`, { objectLabel: def.singular });
  }
}
