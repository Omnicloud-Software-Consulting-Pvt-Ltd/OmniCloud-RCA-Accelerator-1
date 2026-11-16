import type { NextRequest } from "next/server";
import { eligibleProducts } from "@/lib/policyAssignment/server";
import { policyRoute, type KindParams } from "@/lib/policyAssignment/route";
import { SALESFORCE_ID_RE } from "@/lib/policyAssignment/engine";

// GET /api/policy-assignment/{billing|tax}/eligible-products?q=&cursor=&all=1&policyId= — products with NO policy of this kind
// (the filter runs in SOQL: Product2.<field> = null; the other kind is ignored). Keyset-paged (50); all=1 returns up to 500 for
// "Select All Eligible". With policyId, the response also validates that policy. Read-only.
export async function GET(req: NextRequest, ctx: KindParams) {
  const sp = req.nextUrl.searchParams;
  const policyId = sp.get("policyId");
  return policyRoute(req, ctx, (client, kind) => eligibleProducts(client, kind, {
    q: (sp.get("q") ?? "").slice(0, 80),
    cursor: sp.get("cursor"),
    all: sp.get("all") === "1",
    policyId: policyId && SALESFORCE_ID_RE.test(policyId) ? policyId : null,
  }));
}
