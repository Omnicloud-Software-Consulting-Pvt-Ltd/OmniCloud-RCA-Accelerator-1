import type { NextRequest } from "next/server";
import { listPolicies } from "@/lib/policyAssignment/server";
import { policyRoute, type KindParams } from "@/lib/policyAssignment/route";
import type { PoliciesResponse } from "@/lib/policyAssignment/types";

// GET /api/policy-assignment/{billing|tax}/policies — every existing Billing Policy / Tax Policy in the connected org, with
// status and how many products use it. Read-only.
export async function GET(req: NextRequest, ctx: KindParams) {
  return policyRoute(req, ctx, async (client, kind): Promise<PoliciesResponse> => ({ success: true, kind, ...(await listPolicies(client, kind)) }));
}
