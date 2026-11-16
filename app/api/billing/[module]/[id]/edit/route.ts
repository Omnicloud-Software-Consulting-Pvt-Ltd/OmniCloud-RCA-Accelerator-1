import { NextRequest, NextResponse } from "next/server";
import { getBillingModule } from "@/lib/billing/registry";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { loadEditContext } from "@/lib/billing/server/edit";
import { billingErrorResponse } from "@/lib/billing/server/errors";

type Params = { params: Promise<{ module: string; id: string }> };

// GET /api/billing/[module]/[id]/edit — the existing record loaded for editing: current values in
// the same draft shape the create form uses, field/record locks with Salesforce's reasons, related
// records (treatment items, parent treatment, policy treatments), "set"-mode links (products on a
// policy) and configuration health. Always read fresh from Salesforce.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { module, id } = await params;
  const def = getBillingModule(module);
  if (!def) return NextResponse.json({ error: `Unknown billing module "${module}".`, code: "BILLING_MODULE_UNKNOWN" }, { status: 404 });
  try {
    return NextResponse.json(await loadEditContext(auth.client, module, id));
  } catch (err) {
    return billingErrorResponse(err, `Failed to load ${def.singular} for editing`, { objectLabel: def.singular });
  }
}
