import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { runtimeApiFor } from "@/lib/tax/server/runtime";
import { decisionTableRefresh } from "@/lib/tax/server/refreshApproval";

// POST /api/taxes/decision-table/refresh — {} lists the engines' decision tables and their freshness; { engineId } previews the
// refresh of that engine's table (read-only, returns the confirmation token); { engineId, confirm: "<token>" } asks Salesforce to
// refresh exactly that table (separately approved; a current table is never refreshed). Nothing else is changed.
export async function POST(req: NextRequest) {
  return taxRoute(req, async (client, body) => ({
    success: true,
    ...(await decisionTableRefresh(await runtimeApiFor(client), { engineId: typeof body.engineId === "string" ? body.engineId : null, confirm: typeof body.confirm === "string" ? body.confirm : null })),
  }), "Decision table refresh failed", { mutates: true });
}
