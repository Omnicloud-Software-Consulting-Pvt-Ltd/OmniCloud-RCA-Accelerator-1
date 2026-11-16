import type { NextRequest } from "next/server";
import { executeOperations } from "@/lib/tax/server/operations";
import { taxRoute } from "@/lib/tax/server/route";
import { parseAssistantRequest } from "@/lib/tax/server/assistantRequest";
import { BadInputError } from "@/lib/billing/server/payments";

// POST /api/taxes/assistant/execute — { operations, selections, token, confirm: true }. Re-previews (must match the confirmed
// token), applies the steps in order (stopping at Salesforce's first error), re-reads every changed record and returns the audit trail.
export async function POST(req: NextRequest) {
  return taxRoute(req, (client, body) => {
    if (body.confirm !== true) throw new BadInputError("Review the preview and confirm first.");
    return executeOperations(client, parseAssistantRequest(body), typeof body.token === "string" ? body.token : null);
  }, "Tax operation failed", { mutates: true });
}
