import type { NextRequest } from "next/server";
import { previewOperations } from "@/lib/tax/server/operations";
import { taxRoute } from "@/lib/tax/server/route";
import { parseAssistantRequest } from "@/lib/tax/server/assistantRequest";

// POST /api/taxes/assistant/preview — { operations, selections }. Resolves every operation in Salesforce (exact matches,
// duplicates, relationship fields from metadata, lifecycle prerequisites, dependencies) and returns the preview + token. Never writes.
export async function POST(req: NextRequest) {
  return taxRoute(req, (client, body) => previewOperations(client, parseAssistantRequest(body)), "Tax operation preview failed");
}
